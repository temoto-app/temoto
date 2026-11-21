// Shared core of the comment tools (TODO 1256): scripts/comments-i18n.mjs (extract / apply / stats)
// and scripts/lint-comments.mjs both import this file, so "what counts as a comment" and "what is
// excluded" can never drift between the translator and the lint.
//
// Supported languages (comment ranges are found by a real lexer, never by regex over raw text):
//   ts   .ts .tsx .mts .cts .js .jsx .mjs .cjs   TypeScript AST (strings, regexes, templates, JSX text are never comments)
//   css  .css                                      hand lexer (strings and url() are skipped)
//   sh   .sh .bash                                 hand lexer (quotes, $(), ${}, heredocs, `#` only at a word start)
//   py   .py                                       Python's own tokenize module (python3 subprocess)
//   swift .swift                                   hand lexer (strings, multi-line / raw strings and `\(...)` are skipped, block comments nest)
//   xml  .html .htm .svg .plist .xml               `<!-- -->` only (script / style bodies are not lexed)
// Everything else (yml, toml, rb ...) is NOT supported: it is only counted in stats.
//
// Verification: every language has a "fingerprint" = the file with all comments removed, normalised so
// that only comment-related whitespace differences vanish. After an edit the fingerprint must be
// identical (ts: token stream + line-break flags; py: ast.dump; css / sh / swift / xml: text without comments).
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// Hiragana, katakana, CJK ideographs, full-width forms and CJK punctuation (so an `en` with a full-width
// colon or a Japanese comma is rejected as "Japanese remains").
export const JA = /[\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef\u3000-\u303f]/

export const ROOT_DIRS = ['src', 'test', 'plugins', 'scripts', 'tools', 'compat', 'build', 'resources']
const SKIP_DIR_NAMES = new Set(['node_modules', 'out', 'dist', 'coverage'])
// Relative path prefixes that are never touched (throwaway scripts, recorded fixtures).
const SKIP_PREFIXES = ['spikes/', 'test/fixtures/']

const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const UNSUPPORTED_EXT = /\.(ya?ml|toml|rb|go|rs|c|h|cpp|m|java|kt)$/

export function langOf(file) {
  if (TS_EXT.test(file)) return 'ts'
  if (/\.css$/.test(file)) return 'css'
  if (/\.(sh|bash)$/.test(file)) return 'sh'
  if (/\.py$/.test(file)) return 'py'
  if (/\.swift$/.test(file)) return 'swift'
  if (/\.(html?|svg|plist|xml)$/.test(file)) return 'xml'
  return null
}
export const isUnsupported = (file) => UNSUPPORTED_EXT.test(file)

const LINE_PREFIX = { ts: '//', sh: '#', py: '#', css: null, swift: '//', xml: null }

const toPosix = (p) => p.split(path.sep).join('/')

const GENERATED = /@generated|auto-?generated|DO NOT EDIT|do not edit/i

/** Walk files/dirs. `kind` is 'supported' | 'unsupported'. Skips dot-dirs, build outputs, spikes, fixtures. */
export function listFiles(inputs, kind = 'supported') {
  const out = []
  const walk = (p) => {
    const rel = toPosix(path.relative(process.cwd(), p))
    if (SKIP_PREFIXES.some((s) => (rel + '/').startsWith(s))) return
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) {
        if (e.startsWith('.') || SKIP_DIR_NAMES.has(e)) continue
        walk(path.join(p, e))
      }
    } else {
      const ok = kind === 'supported' ? langOf(p) : isUnsupported(p)
      if (!ok) return
      if (/\.min\.(js|css)$/.test(p)) return
      out.push(p)
    }
  }
  inputs.forEach((i) => {
    if (fs.existsSync(i)) walk(i)
  })
  const sorted = out.sort()
  if (kind !== 'supported') return sorted
  return sorted.filter((f) => !GENERATED.test(fs.readFileSync(f, 'utf8').slice(0, 400)))
}

/** The default scan set: the root directories plus top-level config files. */
export function defaultInputs() {
  const files = fs.readdirSync('.').filter((f) => fs.statSync(f).isFile() && (langOf(f) || isUnsupported(f)))
  return [...ROOT_DIRS.filter((d) => fs.existsSync(d)), ...files]
}

// ---------------------------------------------------------------------------------------------
// Comment ranges per language. Each returns [{pos, end, block}] sorted by pos (block = `/* */`).
// ---------------------------------------------------------------------------------------------

function tsParse(file, text) {
  const kind = /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
}

function tsLeaves(sf) {
  const out = []
  const visit = (n) => {
    // getChildren() also returns JSDoc nodes, which are comments: skip them.
    const kids = n.getChildren(sf).filter((k) => k.kind < ts.SyntaxKind.FirstJSDocNode || k.kind > ts.SyntaxKind.LastJSDocNode)
    if (kids.length === 0) out.push(n)
    else kids.forEach(visit)
  }
  visit(sf)
  return out
}

function tsRanges(file, text) {
  const sf = tsParse(file, text)
  const seen = new Map()
  const add = (rs) => rs && rs.forEach((r) => seen.set(r.pos, r))
  for (const n of tsLeaves(sf)) {
    add(ts.getLeadingCommentRanges(text, n.getFullStart()))
    add(ts.getTrailingCommentRanges(text, n.getEnd()))
  }
  // A comment-only file has the comments in the trivia of the end-of-file token.
  return [...seen.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((r) => ({ pos: r.pos, end: r.end, block: r.kind === ts.SyntaxKind.MultiLineCommentTrivia }))
}

/** Token stream without comments. Each token also records whether a line break precedes it (ASI safety). */
function tsFingerprint(file, text) {
  const sf = tsParse(file, text)
  const leaves = tsLeaves(sf)
  const parts = []
  let prevEnd = 0
  for (const n of leaves) {
    const start = n.getStart(sf)
    const nl = prevEnd > 0 && text.slice(prevEnd, start).includes('\n') ? 'N' : ''
    parts.push(nl + n.kind + ':' + n.getText(sf))
    prevEnd = n.getEnd()
  }
  return parts.join('\u0001')
}

function cssRanges(text) {
  const out = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '*') {
      let e = text.indexOf('*/', i + 2)
      e = e < 0 ? n : e + 2
      out.push({ pos: i, end: e, block: true })
      i = e
    } else if (c === '"' || c === "'") {
      i++
      while (i < n && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1
      i++
    } else if ((c === 'u' || c === 'U') && /^url\(\s*[^\s"')]/i.test(text.slice(i, i + 40))) {
      const e = text.indexOf(')', i)
      i = e < 0 ? n : e + 1
    } else i++
  }
  return out
}

/** Shell lexer: `#` starts a comment only where a word starts, outside quotes / substitutions / heredocs. */
function shRanges(text) {
  const out = []
  const n = text.length
  let i = 0
  // Context stack: 'top' | 'dq' | 'cmd' ($( ), with depth) | 'param' (${ }) | 'bt' (backticks)
  const stack = [{ t: 'top' }]
  const heredocs = [] // pending {word, dash}
  const wordStartPrev = /[\s;&|(]/
  const top = () => stack[stack.length - 1]
  while (i < n) {
    const c = text[i]
    const ctx = top()
    if (c === '\\') {
      i += 2
      continue
    }
    if (ctx.t === 'dq') {
      if (c === '"') stack.pop()
      else if (c === '$' && text[i + 1] === '(') {
        stack.push({ t: 'cmd', d: 0 })
        i++
      } else if (c === '$' && text[i + 1] === '{') {
        stack.push({ t: 'param' })
        i++
      } else if (c === '`') stack.push({ t: 'bt' })
      i++
      continue
    }
    if (ctx.t === 'bt') {
      if (c === '`') stack.pop()
      i++
      continue
    }
    if (ctx.t === 'param') {
      if (c === '}') stack.pop()
      else if (c === '"') stack.push({ t: 'dq' })
      else if (c === "'") {
        const e = text.indexOf("'", i + 1)
        i = e < 0 ? n : e
      } else if (c === '$' && text[i + 1] === '(') {
        stack.push({ t: 'cmd', d: 0 })
        i++
      }
      i++
      continue
    }
    // top or cmd
    if (c === '\n' && heredocs.length) {
      // Skip heredoc bodies that start on the next line.
      let p = i + 1
      for (const h of heredocs.splice(0)) {
        for (;;) {
          if (p >= n) break
          let e = text.indexOf('\n', p)
          if (e < 0) e = n
          let line = text.slice(p, e)
          if (h.dash) line = line.replace(/^\t+/, '')
          p = e + 1
          if (line === h.word) break
        }
      }
      i = Math.min(p, n)
      continue
    }
    if (c === '#' && (i === 0 || wordStartPrev.test(text[i - 1]))) {
      let e = text.indexOf('\n', i)
      if (e < 0) e = n
      out.push({ pos: i, end: e, block: false })
      i = e
      continue
    }
    if (c === "'") {
      const e = text.indexOf("'", i + 1)
      i = e < 0 ? n : e + 1
      continue
    }
    if (c === '"') {
      stack.push({ t: 'dq' })
      i++
      continue
    }
    if (c === '`') {
      stack.push({ t: 'bt' })
      i++
      continue
    }
    if (c === '$' && text[i + 1] === "'") {
      i += 2
      while (i < n && text[i] !== "'") i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (c === '$' && text[i + 1] === '(') {
      stack.push({ t: 'cmd', d: 0 })
      i += 2
      continue
    }
    if (c === '$' && text[i + 1] === '{') {
      stack.push({ t: 'param' })
      i += 2
      continue
    }
    if (c === '$') {
      i += 2 // `$#`, `$$`, `$1` ...: the next char is never a comment start
      continue
    }
    if (ctx.t === 'cmd') {
      if (c === '(') ctx.d++
      else if (c === ')') {
        if (ctx.d === 0) stack.pop()
        else ctx.d--
      }
    }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i + 2] !== '(') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][\w]*))/.exec(text.slice(i, i + 200))
      if (m) {
        heredocs.push({ dash: m[1] === '-', word: m[2] ?? m[3] ?? m[4] })
        i += m[0].length
        continue
      }
    }
    i++
  }
  return out
}

// Swift lexer: line comments and nestable block comments outside string literals (plain, multi-line triple-quoted, raw with `#`, and interpolation).
function swiftRanges(text) {
  const out = []
  const n = text.length
  // Skip a string literal starting at `i` (on its opening quote, `hashes` = number of leading `#`); returns the index after it.
  const skipString = (i, hashes) => {
    const multi = text.startsWith('"""', i)
    const close = (multi ? '"""' : '"') + '#'.repeat(hashes)
    const esc = '\\' + '#'.repeat(hashes)
    i += multi ? 3 : 1
    while (i < n) {
      if (text.startsWith(esc + '(', i)) {
        i = skipParens(i + esc.length)
        continue
      }
      if (text.startsWith(esc, i)) {
        i += esc.length + 1
        continue
      }
      if (text.startsWith(close, i)) return i + close.length
      if (!multi && text[i] === '\n') return i
      i++
    }
    return n
  }
  // Skip a balanced `( ... )` interpolation starting on its `(`.
  const skipParens = (i) => {
    let depth = 0
    while (i < n) {
      const c = text[i]
      if (c === '"') {
        i = skipString(i, 0)
        continue
      }
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return i + 1
      i++
    }
    return n
  }
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      let e = text.indexOf('\n', i)
      if (e < 0) e = n
      out.push({ pos: i, end: e, block: false })
      i = e
    } else if (c === '/' && text[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      out.push({ pos: i, end: j, block: true })
      i = j
    } else if (c === '"') i = skipString(i, 0)
    else if (c === '#') {
      let h = 0
      while (text[i + h] === '#') h++
      i = text[i + h] === '"' ? skipString(i + h, h) : i + h
    } else i++
  }
  return out
}

/** `<!-- -->` comments of html / svg / plist / xml. */
function xmlRanges(text) {
  const out = []
  let i = 0
  for (;;) {
    const s = text.indexOf('<!--', i)
    if (s < 0) break
    let e = text.indexOf('-->', s + 4)
    e = e < 0 ? text.length : e + 3
    out.push({ pos: s, end: e, block: true })
    i = e
  }
  return out
}

function pyRun(script, text) {
  return execFileSync('python3', ['-I', '-c', script], { input: text, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const PY_COMMENTS = `
import sys, io, tokenize, json
src = sys.stdin.read()
lines = src.split('\\n')
out = []
for t in tokenize.generate_tokens(io.StringIO(src).readline):
    if t.type == tokenize.COMMENT:
        out.append([t.start[0], t.start[1], len(t.string)])
print(json.dumps(out))
`
const PY_AST = `
import sys, ast
print(ast.dump(ast.parse(sys.stdin.read())))
`

function pyRanges(text) {
  const lines = text.split('\n')
  const starts = []
  let o = 0
  for (const l of lines) {
    starts.push(o)
    o += l.length + 1
  }
  const list = JSON.parse(pyRun(PY_COMMENTS, text))
  return list.map(([line, col, len]) => {
    // Python columns count code points, JS offsets count UTF-16 units.
    const prefix = Array.from(lines[line - 1]).slice(0, col).join('')
    const pos = starts[line - 1] + prefix.length
    const str = Array.from(lines[line - 1].slice(prefix.length)).slice(0, len).join('')
    return { pos, end: pos + str.length, block: false }
  })
}

/** Raw comment ranges of a file. */
export function commentRanges(file, text) {
  switch (langOf(file)) {
    case 'ts':
      return tsRanges(file, text)
    case 'css':
      return cssRanges(text)
    case 'sh':
      return shRanges(text)
    case 'py':
      return pyRanges(text)
    case 'swift':
      return swiftRanges(text)
    case 'xml':
      return xmlRanges(text)
    default:
      return []
  }
}

function stripRanges(text, ranges, repl) {
  let out = ''
  let p = 0
  for (const r of ranges) {
    out += text.slice(p, r.pos) + repl
    p = r.end
  }
  return out + text.slice(p)
}

/** Comment-free fingerprint: equal before and after an edit iff only comments changed. */
export function fingerprint(file, text) {
  const lang = langOf(file)
  if (lang === 'ts') return tsFingerprint(file, text)
  if (lang === 'py') return pyRun(PY_AST, text)
  const ranges = commentRanges(file, text)
  if (lang === 'css' || lang === 'xml') return stripRanges(text, ranges, ' ').replace(/\s+/g, ' ').trim()
  // sh: line structure matters, trailing whitespace and blank lines do not.
  return stripRanges(text, ranges, '')
    .split('\n')
    .map((l) => l.replace(/[ \t\r]+$/, ''))
    .filter((l) => l !== '')
    .join('\n')
}

/** Extra syntax check run before and after an edit (null = fine). */
export function syntaxProblem(file, text) {
  if (langOf(file) !== 'sh') return null
  try {
    execFileSync('bash', ['-n'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] })
    return null
  } catch (e) {
    return String(e.stderr || e.message).trim().split('\n')[0]
  }
}

// ---------------------------------------------------------------------------------------------
// Directive comments: tool instructions that must never be rewritten (only a trailing explanation may be).
// ---------------------------------------------------------------------------------------------

const DIRECTIVE_TEXT = [
  /^\s*(eslint(-disable(-next-line|-line)?|-enable|-env)?|globals?|exported)(\s|$)/,
  /@ts-(expect-error|ignore|nocheck|check)\b/,
  /^\s*(v8|c8|istanbul)\s+ignore\b/,
  /^\s*prettier-ignore\b/,
  /^\s*#\s*(sourceMappingURL|sourceURL)=/,
  /^\s*\/\s*<(reference|amd-)/,
  /@vitest-environment\b/,
  /@jsx(ImportSource|Runtime|Frag)?\b/,
  /@vite-ignore\b/,
  /webpack(Chunk|Ignore|Mode|Prefetch|Preload)/,
  /[#@]__(PURE|NO_SIDE_EFFECTS)__/,
  /@(license|preserve|flow|refresh)\b/,
]
const DIRECTIVE_PY = [/^\s*-\*-.*coding/, /^\s*(noqa|type:|pragma|pylint|fmt:|isort:|mypy:)/]

/** Is this comment (full source text, including delimiters) a tool directive? */
export function isDirective(src, lang) {
  if (lang !== 'css' && /^#!/.test(src)) return true
  let body = src
  if (src.startsWith('/*')) body = src.replace(/^\/\*+/, '').replace(/\*+\/$/, '')
  else if (src.startsWith('//')) {
    if (lang === 'ts') {
      if (/^\/\/#\s*(sourceMappingURL|sourceURL)=/.test(src)) return true
      if (/^\/\/\/\s*<(reference|amd-)/.test(src)) return true
      body = src.replace(/^\/\//, '')
    } else {
      body = src.replace(/^\/\/+/, (m) => (m.length >= 3 ? '/' : ''))
    }
  } else if (src.startsWith('#')) body = src.replace(/^#/, '')
  if (lang === 'sh') return /^#\s*shellcheck\b/.test(src)
  if (lang === 'py') return DIRECTIVE_PY.some((re) => re.test(body))
  if (src.startsWith('/*!')) return true // legal comments
  return DIRECTIVE_TEXT.some((re) => re.test(body))
}

/** Every line terminator JavaScript knows (a line comment ends at any of them). */
export const LINE_BREAK = /\r\n|[\n\r\u2028\u2029\u0085]/

/**
 * The directive lines inside one comment (full source text): per line, the comment marker is stripped and the rest is
 * tested with `isDirective` as if it were a comment of its own. `head` is the part a translation must keep verbatim:
 * the text before the first Japanese character, without a trailing ` --` (the separator before the free-text reason).
 * `sep` says the original had that separator, `ja` says the line had Japanese at all (no Japanese: keep the line as is).
 */
export function directiveLines(text, lang) {
  const out = []
  const marker = lang === 'py' || lang === 'sh' ? '# ' : '// '
  for (const line of text.split(LINE_BREAK)) {
    const body = line.replace(/^\s*(\/\/+|\/\*+!?|\*(?!\/)|#)?\s*/, '').replace(/\s*\*+\/\s*$/, '')
    if (!isDirective(marker + body, lang)) continue
    const m = JA.exec(body)
    let cut = m ? m.index : body.length
    while (m && cut > 0 && !/\s/.test(body[cut - 1])) cut-- // never cut a word in half
    let head = body.slice(0, cut).trim()
    // The separator is the first ` -- ` of the line (eslint's own rule), wherever the Japanese starts after it:
    // `-- XML 1.0 <Japanese>...` has ASCII words between the separator and the first Japanese character.
    const dash = /(^|\s)--(\s|$)/.exec(body)
    const sep = m !== null && dash !== null && dash.index < m.index
    if (sep) head = body.slice(0, dash.index).trim()
    out.push({ body, head, sep, ja: m !== null })
  }
  return out
}

/** For a directive comment containing Japanese: the exact prefix the translation must keep, up to the first Japanese word. */
export function directivePrefix(src) {
  const m = JA.exec(src)
  if (!m) return src
  // When the line has a ` -- ` separator before the Japanese, the fixed part ends right after it.
  const lineStart = src.lastIndexOf('\n', m.index - 1) + 1
  const dash = /\s--\s/.exec(src.slice(lineStart, m.index))
  if (dash) return src.slice(0, lineStart + dash.index + dash[0].length)
  let i = m.index
  while (i > 0 && !/\s/.test(src[i - 1])) i--
  return src.slice(0, i)
}

// ---------------------------------------------------------------------------------------------
// Grouping: adjacent standalone line comments (same indent) are one unit. Everything else stands alone.
// ---------------------------------------------------------------------------------------------

export function groupsOf(file, text) {
  const lang = langOf(file)
  const ranges = commentRanges(file, text)
  const lineStart = (pos) => text.lastIndexOf('\n', pos - 1) + 1
  const out = []
  for (const r of ranges) {
    const ls = lineStart(r.pos)
    const standalone = /^[ \t]*$/.test(text.slice(ls, r.pos))
    const src = text.slice(r.pos, r.end)
    const directive = isDirective(src, lang)
    const g = {
      pos: r.pos,
      end: r.end,
      block: r.block,
      standalone,
      indent: standalone ? text.slice(ls, r.pos) : /^[ \t]*/.exec(text.slice(ls))[0],
      directive,
    }
    const prev = out[out.length - 1]
    if (!g.block && !g.directive && prev && !prev.block && !prev.directive && prev.standalone && standalone && prev.indent === g.indent) {
      if (/^\r?\n[ \t]*$/.test(text.slice(prev.end, r.pos))) {
        prev.end = r.end
        continue
      }
    }
    out.push(g)
  }
  return out
}

/** Info about a group useful for the translator: kind and the code after it. */
export function describeGroup(text, g) {
  const lineStart = text.lastIndexOf('\n', g.pos - 1) + 1
  const lead = text.slice(lineStart, g.pos)
  const after = text.slice(g.end).split('\n')
  const rest = after[0].trim()
  const next = []
  for (let k = rest ? 0 : 1; k < after.length && next.length < 3; k++) {
    const l = after[k].trim()
    if (l) next.push(l.slice(0, 160))
  }
  return {
    kind: g.block ? (text.slice(g.pos, g.pos + 3) === '/**' ? 'jsdoc' : 'block') : g.standalone ? 'line' : 'trailing',
    codeBefore: g.standalone ? undefined : lead.trim().slice(0, 160),
    next,
  }
}

export function hash8(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 8)
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

export function linePrefixOf(file) {
  return LINE_PREFIX[langOf(file)]
}
