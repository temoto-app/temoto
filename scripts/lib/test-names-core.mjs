// Core of the test-name tool (TODO 1262): finds the first argument (the name) of describe / it / test calls with a
// real TypeScript AST, encodes a translated name back into a literal, and fingerprints a file so that "nothing
// but the name literals changed" can be proven after a rewrite. scripts/test-names-i18n.mjs is the CLI on top.
//
// What counts as a test-name call (the root identifier is describe / it / test / suite):
//   it('x', fn)   it.only('x', fn)   it.skip(...)   it.todo('x')   it.concurrent(...)   it.fails(...)
//   it.each(table)('x %s', fn)   it.skipIf(cond)('x', fn)   it.runIf(cond)('x', fn)   it.for(table)('x', fn)
//   it.each`table`('x', fn)
// The "modifier" calls (each / skipIf / runIf / for / extend ...) take a table or a condition, not a name, so their
// own first argument is never a name; the call that is applied to them is.
import ts from 'typescript'

// Hiragana, katakana, CJK ideographs, full-width forms and CJK punctuation (the same set as comments-core.mjs).
export const JA = /[\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef\u3000-\u303f]/

const ROOTS = new Set(['describe', 'it', 'test', 'suite'])
// Properties that return a function which is then called with the name.
const MODIFIERS = new Set(['each', 'skipIf', 'runIf', 'for', 'extend', 'scoped'])

export function parse(file, text) {
  const kind = /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
}

/**
 * Classifies a call's callee. Returns null when the root is not describe / it / test, else
 * { root, last, modifierCall, tableCall }:
 *   last: the final property name of the callee chain ('only', 'each', ...) or null
 *   isNameCall: true when this call takes the name as its first argument
 *   isTableCall: true for `.each(table)`-style modifiers whose argument is a table of cases
 */
export function classifyCallee(expr) {
  let e = expr
  let last = null
  let viaCall = false // the callee is itself a call (`it.each(t)(name, fn)`) or a tagged template
  let tableArg = null // the table of `it.each(table)(name, fn)`
  const chain = []
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression
    else if (ts.isPropertyAccessExpression(e)) {
      chain.push(e.name.text)
      e = e.expression
    } else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
      chain.push(e.argumentExpression.text)
      e = e.expression
    } else if (ts.isCallExpression(e)) {
      viaCall = true
      tableArg ??= e.arguments[0] ?? null
      e = e.expression
    } else if (ts.isTaggedTemplateExpression(e)) {
      viaCall = true
      e = e.tag
    } else if (ts.isNonNullExpression(e)) e = e.expression
    else break
  }
  if (!ts.isIdentifier(e) || !ROOTS.has(e.text)) return null
  chain.reverse() // root-first: it.skipIf(c) -> ['skipIf']
  // For `it.each(t)(name, fn)` the outer callee is a CallExpression: the chain seen from it still ends with 'each'
  // but this call applies the result, so it is the name call. Only a direct `it.each(...)` is a table call.
  last = chain.length ? chain[chain.length - 1] : null
  const modifierLast = last !== null && MODIFIERS.has(last)
  return { root: e.text, last, isNameCall: viaCall ? true : !modifierLast, isTableCall: !viaCall && modifierLast, tableArg }
}

// ---------------------------------------------------------------------------------------------
// Targets: the name literal of each name call
// ---------------------------------------------------------------------------------------------

/** The cooked text of a template's literal part, or undefined when it has an invalid escape. */
const cookedOf = (n) => (typeof n.text === 'string' ? n.text : undefined)

function unwrap(n) {
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isNonNullExpression(n)) n = n.expression
  return n
}

/**
 * A "name" for a literal node: { kind, src, parts?, tokens } or null.
 *   string / template: src = cooked text
 *   template-sub:      src = cooked text with `${expr}` written back (expr = the exact source slice)
 * `tokens` are the leaf nodes that carry text (they are masked in the fingerprint).
 */
function literalName(n, text) {
  if (ts.isStringLiteral(n)) return { kind: 'string', quote: text[n.getStart()], src: n.text, tokens: [n], exprs: [] }
  if (ts.isNoSubstitutionTemplateLiteral(n)) {
    const c = cookedOf(n)
    return c === undefined ? null : { kind: 'template', quote: '`', src: c, tokens: [n], exprs: [] }
  }
  if (ts.isTemplateExpression(n)) {
    const tokens = [n.head]
    let src = cookedOf(n.head)
    if (src === undefined) return null
    const exprs = []
    for (let i = 0; i < n.templateSpans.length; i++) {
      const span = n.templateSpans[i]
      const raw = text.slice(i === 0 ? n.head.getEnd() : n.templateSpans[i - 1].literal.getEnd(), span.literal.getStart())
      const c = cookedOf(span.literal)
      if (c === undefined) return null
      exprs.push(raw)
      tokens.push(span.literal)
      src += '${' + raw + '}' + c
    }
    return { kind: 'template-sub', quote: '`', src, tokens, exprs }
  }
  return null
}

const hasJa = (s) => JA.test(s)

/** Collects the JA string literals anywhere under a node (used for the "not picked" report). */
function jaLiteralsUnder(node) {
  let n = 0
  const visit = (x) => {
    if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || ts.isTemplateHead(x) || ts.isTemplateMiddle(x) || ts.isTemplateTail(x)) && hasJa(x.text ?? '')) n++
    ts.forEachChild(x, visit)
  }
  visit(node)
  return n
}

function findDeclaration(sf, name) {
  let found = null
  const visit = (n) => {
    if (found) return
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n
    else ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

/**
 * Finds every name call in a file.
 * Returns { sf, targets, calls, unpicked }:
 *   targets: name literals that can be extracted / rewritten, in source order
 *   calls: every name call with its scope (for the duplicate-name report): { name|null, kind, scope, line, root }
 *   unpicked: JA-carrying names that cannot be extracted: { line, category, example }
 */
export function findTargets(file, text) {
  const sf = parse(file, text)
  const targets = []
  const calls = []
  const unpicked = []
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const nameCallScope = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && p.arguments.some((a) => a === node || (a.pos <= node.pos && node.end <= a.end))) {
        const c = classifyCallee(p.expression)
        if (c && c.isNameCall) return p
      }
    }
    return null
  }
  const parentNames = (call) => {
    const out = []
    for (let p = nameCallScope(call); p; p = nameCallScope(p)) {
      const a = p.arguments[0] && unwrap(p.arguments[0])
      out.unshift(a && (ts.isStringLiteralLike(a) || ts.isTemplateExpression(a)) ? (literalName(a, text)?.src ?? '?') : '?')
    }
    return out
  }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const c = classifyCallee(node.expression)
      if (c && c.isTableCall) {
        const jas = node.arguments.reduce((a, x) => a + jaLiteralsUnder(x), 0)
        if (jas) unpicked.push({ line: lineOf(node.getStart(sf)), category: 'each-table', example: node.getText(sf).slice(0, 100), count: jas })
      } else if (c && c.isNameCall) {
        const arg0 = node.arguments[0]
        // `it.each(CASES)('%s ...', fn)`: the labels live in a table that is a variable. Count the Japanese in its initializer.
        if ((c.last === 'each' || c.last === 'for') && c.tableArg && !ts.isArrayLiteralExpression(c.tableArg) && ts.isIdentifier(c.tableArg)) {
          const decl = findDeclaration(sf, c.tableArg.text)
          const jas = decl?.initializer ? jaLiteralsUnder(decl.initializer) : 0
          if (jas) unpicked.push({ line: lineOf(node.getStart(sf)), category: 'each-table-variable', example: node.getText(sf).split('\n')[0].slice(0, 100), count: jas })
        }
        const scope = nameCallScope(node)
        const scopeKey = scope ? scope.getStart(sf) : -1
        const line = lineOf(node.getStart(sf))
        if (arg0) {
          const a = unwrap(arg0)
          const ln = literalName(a, text)
          if (ln) {
            const t = { ...ln, file, start: a.getStart(sf), end: a.getEnd(), line, callee: c.root + (c.last ? '.' + c.last : ''), parents: parentNames(node), scopeKey, node: a }
            targets.push(t)
            calls.push({ name: ln.src, scopeKey, line, plain: c.last !== 'each' && c.last !== 'for', isDescribe: c.root === 'describe' || c.root === 'suite' })
          } else {
            calls.push({ name: null, scopeKey, line, plain: false, isDescribe: false })
            const jas = jaLiteralsUnder(a)
            if (jas) unpicked.push({ line, category: ts.SyntaxKind[a.kind], example: a.getText(sf).slice(0, 100), count: jas })
            else if (!ts.isFunctionLike(a) && !ts.isArrowFunction(a)) unpicked.push({ line, category: 'dynamic:' + ts.SyntaxKind[a.kind], example: a.getText(sf).slice(0, 100), count: 0 })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  targets.sort((a, b) => a.start - b.start)
  return { sf, targets, calls, unpicked }
}

// ---------------------------------------------------------------------------------------------
// Placeholders that must survive a translation
// ---------------------------------------------------------------------------------------------

/** printf-style (%s %d %i %f %j %o %O %p %# %%), `$name` / `$a.b` (each-table interpolation) and `${...}`. */
export function embeds(s) {
  return [...s.matchAll(/\$\{[^}]*\}|%[sdifjoOpc#%]|\$[A-Za-z_#][\w.#]*/g)].map((m) => m[0])
}

// ---------------------------------------------------------------------------------------------
// Encoding a translation back into a literal
// ---------------------------------------------------------------------------------------------

const escChar = (ch) => {
  const c = ch.codePointAt(0)
  if (ch === '\\') return '\\\\'
  if (ch === '\n') return '\\n'
  if (ch === '\r') return '\\r'
  if (ch === '\t') return '\\t'
  if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return c < 0x100 ? '\\x' + c.toString(16).padStart(2, '0') : '\\u' + c.toString(16).padStart(4, '0')
  return ch
}

/** Encodes plain text for a quoted string. A quote is switched to avoid escapes when that is clean. */
export function encodeString(en, quote) {
  let q = quote
  if (q === "'" && en.includes("'") && !en.includes('"')) q = '"'
  else if (q === '"' && en.includes('"') && !en.includes("'")) q = "'"
  let out = ''
  for (const ch of en) out += ch === q ? '\\' + ch : escChar(ch)
  return q + out + q
}

/** Text between backticks: escapes backslash, backtick and `${` (a template's own text; substitutions are re-inserted by the caller). */
function encodeTemplateText(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '`') out += '\\`'
    else if (ch === '$' && s[i + 1] === '{') out += '\\$'
    else if (ch === '\n') out += '\n' // a literal line break is fine in a template
    else out += escChar(ch)
  }
  return out
}

/**
 * Builds the replacement literal text for a target. For template-sub the translation must contain the original
 * `${expr}` slices in the same order (checked by the caller with embeds()); they are put back byte for byte.
 * Returns { text } or { error }.
 */
export function encodeFor(target, en) {
  if (target.kind === 'string') return { text: encodeString(en, target.quote) }
  if (target.kind === 'template') return { text: '`' + encodeTemplateText(en) + '`' }
  let rest = en
  let out = '`'
  for (const raw of target.exprs) {
    const tok = '${' + raw + '}'
    const i = rest.indexOf(tok)
    if (i < 0) return { error: `the substitution ${tok} is missing or out of order` }
    out += encodeTemplateText(rest.slice(0, i)) + tok
    rest = rest.slice(i + tok.length)
  }
  if (rest.includes('${')) return { error: 'the translation contains a substitution that the original does not have' }
  return { text: out + encodeTemplateText(rest) + '`' }
}

// ---------------------------------------------------------------------------------------------
// Fingerprint: the token stream with every name literal masked
// ---------------------------------------------------------------------------------------------

function leaves(sf) {
  const out = []
  const visit = (n) => {
    const kids = n.getChildren(sf).filter((k) => k.kind < ts.SyntaxKind.FirstJSDocNode || k.kind > ts.SyntaxKind.LastJSDocNode)
    if (kids.length === 0) out.push(n)
    else kids.forEach(visit)
  }
  visit(sf)
  return out
}

/** Same token stream as comments-core's (kind + text, line-break flags), but the text of name literals is replaced by '#'. */
export function maskedFingerprint(file, text) {
  const { sf, targets } = findTargets(file, text)
  const masked = new Set()
  for (const t of targets) for (const tok of t.tokens) masked.add(tok.getStart(sf))
  const parts = []
  let prevEnd = 0
  for (const n of leaves(sf)) {
    const start = n.getStart(sf)
    const nl = prevEnd > 0 && text.slice(prevEnd, start).includes('\n') ? 'N' : ''
    parts.push(nl + n.kind + ':' + (masked.has(start) ? '#' : n.getText(sf)))
    prevEnd = n.getEnd()
  }
  return { fp: parts.join('\u0001'), count: targets.length, srcs: targets.map((t) => t.src) }
}

/** Duplicate plain names in the same scope: Map("scope|kind|name" -> count) for names used more than once. */
export function duplicates(calls) {
  const seen = new Map()
  for (const c of calls) {
    if (c.name === null || !c.plain) continue
    const k = `${c.scopeKey}|${c.isDescribe ? 'd' : 't'}|${c.name}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return new Map([...seen].filter(([, n]) => n > 1))
}

/** True when the only Japanese in the name is inside corner brackets or quotes (a quoted UI string kept on purpose). */
export function japaneseOnlyQuoted(name) {
  if (!hasJa(name)) return false
  const stripped = name
    .replace(/「[^」]*」|『[^』]*』/g, '')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, (m) => (hasJa(m) ? '' : m))
  return !hasJa(stripped)
}
