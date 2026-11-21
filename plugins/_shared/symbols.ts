/**
 * Extracts the symbols in a file (functions, classes, methods, variables, JSON / YAML keys, CSS selectors) from the language pack's syntax tree
 * (TODO 468, wave 23 bundle F, ARCHITECTURE.md 7.4.3.2). VS Code's "Go to Symbol in Editor" / Sublime's Cmd+R.
 *
 * - The syntax tree is Lezer (`syntaxTree`). Node names differ per language, so a **table for the main languages only** is kept
 *   (TS / JS / JSX / TSX, Python, Go, Rust, Java, C / C++, JSON, YAML, CSS). A language not in the table has "no symbols" (null).
 * - CodeMirror parses off-screen parts later, so it waits on `ensureSyntaxTree` with a time limit. If it is not in time, the result is
 *   `partial` up to what has been parsed (shown as "partial"). Cutting off at the count limit (`MAX_SYMBOLS`) is also `partial`.
 * - The name position (`from`) is **the characters of the name**, not the head of the declaration (it jumps to the name, not to the `export` or decorator line).
 * - It does not touch the DOM (verified per language with vitest).
 */
import { syntaxTree, ensureSyntaxTree, language as languageFacet } from '@codemirror/language'
import type { EditorState, Text } from '@codemirror/state'

// `@lezer/common` is not in the plugin boundary's allow table, so the type is derived from `@codemirror/language`.
type Tree = ReturnType<typeof syntaxTree>
type SyntaxNode = Tree['topNode']

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'struct'
  | 'interface'
  | 'enum'
  | 'type'
  | 'namespace'
  | 'impl'
  | 'variable'
  | 'constant'
  | 'property'
  | 'key'
  | 'selector'
  | 'macro'

export interface DocSymbol {
  readonly name: string
  readonly kind: SymbolKind
  /** Position of the name's characters (the jump target). */
  readonly from: number
  /** 1-based line. */
  readonly line: number
  /** Number of enclosing symbols (the list's indentation). */
  readonly depth: number
  /** Name of the enclosing symbol (`A.b`). For a Go method, the receiver type. null if none. */
  readonly container: string | null
}

export interface SymbolResult {
  readonly symbols: readonly DocSymbol[]
  /** Parsing was not finished, or it was cut off at the count limit ("partial"). */
  readonly partial: boolean
}

/** Upper limit on the number shown in the list. So the list does not get heavy for the keys of a large JSON. */
export const MAX_SYMBOLS = 5000

/** Upper limit (ms) on waiting for the syntax tree to parse. Also the longest wait between pressing Cmd+R and the list appearing. */
export const PARSE_BUDGET_MS = 300

/** Upper limit on the length of a name shown in the list (a long CSS selector, a Rust impl heading). */
const MAX_NAME_LENGTH = 120

/** A symbol obtained from one node (with the name's position). */
interface Found {
  readonly name: string
  readonly kind: SymbolKind
  readonly from: number
  /** A name shown instead of an enclosing symbol, such as the receiver type of a Go method. */
  readonly container?: string
}

/** Information about the enclosure passed to a rule. */
interface Scope {
  /** The kind of the innermost symbol (null if none). */
  readonly kind: SymbolKind | null
}

/**
 * A language's rule. Takes one node and returns symbols (empty if none). If `container` is true, symbols of that node's descendants are counted
 * as inside this symbol (indentation, `A.b`).
 */
interface Rule {
  (node: SyntaxNode, doc: Text, scope: Scope): { readonly found: readonly Found[]; readonly container: boolean } | null
}

const NONE = null

function text(doc: Text, node: SyntaxNode): string {
  return doc.sliceString(node.from, node.to)
}

/** Collapses whitespace to a single space and cuts if too long. */
function tidy(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_NAME_LENGTH ? `${flat.slice(0, MAX_NAME_LENGTH - 1)}…` : flat
}

/** The first of the direct children whose name is any of `names`. */
function child(node: SyntaxNode, ...names: string[]): SyntaxNode | null {
  for (let c = node.firstChild; c !== null; c = c.nextSibling) {
    if (names.includes(c.name)) return c
  }
  return null
}

function children(node: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = []
  for (let c = node.firstChild; c !== null; c = c.nextSibling) if (c.name === name) out.push(c)
  return out
}

/** One symbol from a name node. If there is no name node, at the head of the node under the name `fallback` (anonymous). */
function named(
  node: SyntaxNode,
  doc: Text,
  kind: SymbolKind,
  nameNode: SyntaxNode | null,
  container: boolean,
  fallback: string | null = null
): { readonly found: readonly Found[]; readonly container: boolean } | null {
  if (nameNode === null) {
    if (fallback === null) return NONE
    return { found: [{ name: fallback, kind, from: node.from }], container }
  }
  return { found: [{ name: tidy(text(doc, nameNode)), kind, from: nameNode.from }], container }
}

/** Removes quotes (JSON keys, YAML keys, TS `declare module 'x'`). */
function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    if (v[0] === '"') {
      try {
        const parsed: unknown = JSON.parse(v)
        if (typeof parsed === 'string') return parsed
      } catch {
        // For a broken escape, output the contents as they are.
      }
    }
    return v.slice(1, -1)
  }
  return v
}

// ---- Per-language rules ----

const CLASS_LIKE: ReadonlySet<SymbolKind> = new Set(['class', 'struct', 'interface', 'impl', 'enum'])

/** JS / TS / JSX / TSX. */
const javascript: Rule = (node, doc) => {
  switch (node.name) {
    case 'FunctionDeclaration':
      return named(node, doc, 'function', child(node, 'VariableDefinition'), true, 'default')
    case 'ClassDeclaration':
      return named(node, doc, 'class', child(node, 'VariableDefinition'), true, 'default')
    case 'MethodDeclaration':
      return named(node, doc, 'method', child(node, 'PropertyDefinition', 'PrivatePropertyDefinition'), true)
    case 'PropertyDeclaration':
      return named(node, doc, 'property', child(node, 'PropertyDefinition', 'PrivatePropertyDefinition'), false)
    case 'InterfaceDeclaration':
      return named(node, doc, 'interface', child(node, 'TypeDefinition'), true)
    case 'TypeAliasDeclaration':
      return named(node, doc, 'type', child(node, 'TypeDefinition'), false)
    case 'EnumDeclaration':
      return named(node, doc, 'enum', child(node, 'TypeDefinition'), false)
    case 'NamespaceDeclaration': {
      const name = child(node, 'VariableDefinition', 'String')
      if (name === null) return NONE
      return { found: [{ name: tidy(unquote(text(doc, name))), kind: 'namespace', from: name.from }], container: true }
    }
    case 'VariableDeclaration': {
      // Local variables inside functions are not shown. Only the top of the file (including export) and directly under a namespace.
      const parent = node.parent
      const top =
        parent !== null &&
        (parent.name === 'Script' ||
          parent.name === 'ExportDeclaration' ||
          (parent.name === 'Block' && parent.parent?.name === 'NamespaceDeclaration'))
      if (!top) return NONE
      const isConst = child(node, 'const') !== null
      const found: Found[] = []
      for (const def of children(node, 'VariableDefinition')) {
        // `= (…) => …` / `= function …` are shown as functions.
        let value = def.nextSibling
        if (value?.name === 'Equals') value = value.nextSibling
        const fn = value !== null && (value.name === 'ArrowFunction' || value.name === 'FunctionExpression')
        found.push({ name: text(doc, def), kind: fn ? 'function' : isConst ? 'constant' : 'variable', from: def.from })
      }
      return found.length === 0 ? NONE : { found, container: false }
    }
    default:
      return NONE
  }
}

const python: Rule = (node, doc, scope) => {
  switch (node.name) {
    case 'FunctionDefinition':
      return named(node, doc, scope.kind === 'class' ? 'method' : 'function', child(node, 'VariableName'), true)
    case 'ClassDefinition':
      return named(node, doc, 'class', child(node, 'VariableName'), true)
    case 'AssignStatement': {
      // A top-level assignment is a variable, and an assignment in a class body is an attribute. Those inside functions are not shown.
      const parent = node.parent
      const top = parent?.name === 'Script'
      const inClass = parent?.name === 'Body' && parent.parent?.name === 'ClassDefinition'
      if (!top && !inClass) return NONE
      const found: Found[] = []
      for (let c = node.firstChild; c !== null && c.name !== 'AssignOp'; c = c.nextSibling) {
        if (c.name === 'VariableName') found.push({ name: text(doc, c), kind: inClass ? 'property' : 'variable', from: c.from })
      }
      return found.length === 0 ? NONE : { found, container: false }
    }
    default:
      return NONE
  }
}

/** Whether a Go `VarSpec` / `ConstSpec` is inside a function. */
function insideGoFunction(node: SyntaxNode): boolean {
  for (let p = node.parent; p !== null; p = p.parent) {
    if (p.name === 'FunctionDecl' || p.name === 'MethodDecl' || p.name === 'FuncLiteral') return true
  }
  return false
}

const go: Rule = (node, doc) => {
  switch (node.name) {
    case 'FunctionDecl':
      return named(node, doc, 'function', child(node, 'DefName'), false)
    case 'MethodDecl': {
      const name = child(node, 'FieldName')
      if (name === null) return NONE
      // Show the receiver type (the R of `func (r *R) M()`) instead of an enclosing symbol.
      const receiver = child(node, 'Parameters')
      let type: string | undefined
      if (receiver !== null) {
        const cursor = receiver.cursor()
        do {
          if (cursor.name === 'TypeName') {
            type = doc.sliceString(cursor.from, cursor.to)
            break
          }
        } while (cursor.next() && cursor.from < receiver.to)
      }
      return {
        found: [{ name: text(doc, name), kind: 'method', from: name.from, ...(type === undefined ? {} : { container: type }) }],
        container: false
      }
    }
    case 'TypeSpec': {
      const kind: SymbolKind =
        child(node, 'StructType') !== null ? 'struct' : child(node, 'InterfaceType') !== null ? 'interface' : 'type'
      return named(node, doc, kind, child(node, 'DefName'), false)
    }
    case 'VarSpec':
    case 'ConstSpec': {
      if (insideGoFunction(node)) return NONE
      const kind: SymbolKind = node.name === 'ConstSpec' ? 'constant' : 'variable'
      const found = children(node, 'DefName').map((def) => ({ name: text(doc, def), kind, from: def.from }))
      return found.length === 0 ? NONE : { found, container: false }
    }
    default:
      return NONE
  }
}

const rust: Rule = (node, doc, scope) => {
  switch (node.name) {
    case 'FunctionItem': {
      const kind: SymbolKind = scope.kind === 'impl' || scope.kind === 'interface' ? 'method' : 'function'
      return named(node, doc, kind, child(node, 'BoundIdentifier', 'Identifier'), true)
    }
    case 'StructItem':
    case 'UnionItem':
      return named(node, doc, 'struct', child(node, 'TypeIdentifier'), true)
    case 'EnumItem':
      return named(node, doc, 'enum', child(node, 'TypeIdentifier'), false)
    case 'TraitItem':
      return named(node, doc, 'interface', child(node, 'TypeIdentifier'), true)
    case 'ImplItem': {
      // The heading runs from after `impl` to before the body (type arguments such as `T for S` and `<T> Foo<T>` are removed).
      const body = child(node, 'DeclarationList')
      const keyword = child(node, 'impl')
      if (keyword === null) return NONE
      const params = child(node, 'TypeParamList')
      const start = params !== null && params.from < (body?.from ?? node.to) ? params.to : keyword.to
      const end = body?.from ?? node.to
      const raw = doc.sliceString(start, end)
      const name = tidy(raw.replace(/\bwhere\b[\s\S]*$/, ''))
      if (name === '') return NONE
      const at = start + (raw.length - raw.trimStart().length)
      return { found: [{ name, kind: 'impl', from: at }], container: true }
    }
    case 'ModItem':
      return named(node, doc, 'namespace', child(node, 'BoundIdentifier', 'Identifier'), true)
    case 'ConstItem':
    case 'StaticItem':
      return named(node, doc, 'constant', child(node, 'BoundIdentifier', 'Identifier'), false)
    case 'TypeItem':
      return named(node, doc, 'type', child(node, 'TypeIdentifier'), false)
    case 'MacroDefinition':
      return named(node, doc, 'macro', child(node, 'Identifier'), false)
    default:
      return NONE
  }
}

const java: Rule = (node, doc) => {
  switch (node.name) {
    case 'ClassDeclaration':
    case 'RecordDeclaration':
      return named(node, doc, 'class', child(node, 'Definition'), true)
    case 'InterfaceDeclaration':
      return named(node, doc, 'interface', child(node, 'Definition'), true)
    case 'AnnotationTypeDeclaration':
      return named(node, doc, 'interface', child(node, 'Definition', 'Identifier'), true)
    case 'EnumDeclaration':
      return named(node, doc, 'enum', child(node, 'Definition'), true)
    case 'MethodDeclaration':
    case 'ConstructorDeclaration':
      return named(node, doc, 'method', child(node, 'Definition'), false)
    case 'FieldDeclaration': {
      const found: Found[] = []
      for (const declarator of children(node, 'VariableDeclarator')) {
        const def = child(declarator, 'Definition')
        if (def !== null) found.push({ name: text(doc, def), kind: 'property', from: def.from })
      }
      return found.length === 0 ? NONE : { found, container: false }
    }
    default:
      return NONE
  }
}

/** Walks C / C++ declarators (`*f(…)`, `&g(…)`) to the name node of the function's declarator. */
function cppDeclaratorName(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = child(node, 'FunctionDeclarator', 'PointerDeclarator', 'ReferenceDeclarator')
  for (let guard = 0; current !== null && guard < 8; guard++) {
    if (current.name === 'FunctionDeclarator') {
      const first = current.firstChild
      return first !== null && first.name !== 'ParameterList' ? first : null
    }
    current = child(current, 'FunctionDeclarator', 'PointerDeclarator', 'ReferenceDeclarator')
  }
  return null
}

const cpp: Rule = (node, doc, scope) => {
  switch (node.name) {
    case 'FunctionDefinition': {
      const name = cppDeclaratorName(node)
      if (name === null) return NONE
      const method = name.name === 'ScopedIdentifier' || name.name === 'FieldIdentifier' || CLASS_LIKE.has(scope.kind as SymbolKind)
      return named(node, doc, method ? 'method' : 'function', name, false)
    }
    case 'FieldDeclaration': {
      // Function declarations inside a class body (`void m();`). Member variables are not shown (too many).
      const name = cppDeclaratorName(node)
      return name === null ? NONE : named(node, doc, 'method', name, false)
    }
    case 'ClassSpecifier':
    case 'StructSpecifier':
    case 'UnionSpecifier': {
      if (child(node, 'FieldDeclarationList') === null) return NONE
      const kind: SymbolKind = node.name === 'ClassSpecifier' ? 'class' : 'struct'
      return named(node, doc, kind, child(node, 'TypeIdentifier', 'ScopedTypeIdentifier'), true)
    }
    case 'EnumSpecifier':
      if (child(node, 'EnumeratorList') === null) return NONE
      return named(node, doc, 'enum', child(node, 'TypeIdentifier', 'ScopedTypeIdentifier'), false)
    case 'NamespaceDefinition':
      return named(node, doc, 'namespace', child(node, 'Identifier', 'NamespaceIdentifier'), true, '(anonymous)')
    case 'TypeDefinition': {
      const names = children(node, 'TypeIdentifier')
      return named(node, doc, 'type', names[names.length - 1] ?? null, false)
    }
    case 'AliasDeclaration':
      return named(node, doc, 'type', child(node, 'TypeIdentifier'), false)
    case 'PreprocDirective':
      if (node.firstChild?.name !== '#define') return NONE
      return named(node, doc, 'macro', child(node, 'Identifier'), false)
    default:
      return NONE
  }
}

const json: Rule = (node, doc) => {
  if (node.name !== 'Property') return NONE
  const name = child(node, 'PropertyName')
  if (name === null) return NONE
  return { found: [{ name: tidy(unquote(text(doc, name))), kind: 'key', from: name.from }], container: true }
}

const yaml: Rule = (node, doc) => {
  if (node.name !== 'Pair') return NONE
  const key = child(node, 'Key')
  if (key === null) return NONE
  const name = tidy(unquote(text(doc, key)))
  if (name === '') return NONE
  return { found: [{ name, kind: 'key', from: key.from }], container: true }
}

const CSS_AT_RULES = new Set(['MediaStatement', 'SupportsStatement', 'KeyframesStatement', 'AtRule', 'ScopeStatement'])

const css: Rule = (node, doc) => {
  if (node.name !== 'RuleSet' && !CSS_AT_RULES.has(node.name)) return NONE
  const body = child(node, 'Block', 'KeyframeList')
  const name = tidy(doc.sliceString(node.from, body?.from ?? node.to))
  if (name === '') return NONE
  return { found: [{ name, kind: node.name === 'RuleSet' ? 'selector' : 'namespace', from: node.from }], container: true }
}

/** Language name (`Language.name`) -> rule. A language not here has "no symbols". */
const RULES: Readonly<Record<string, Rule>> = {
  javascript,
  typescript: javascript,
  jsx: javascript,
  tsx: javascript,
  python,
  go,
  rust,
  java,
  cpp,
  json,
  yaml,
  css
}

/** Whether the language has a symbol table (whether to show the heading button). */
export function supportsSymbols(languageName: string | null | undefined): boolean {
  return typeof languageName === 'string' && Object.hasOwn(RULES, languageName)
}

/** Name of the current language (null if the language pack is not there yet / absent). */
export function languageNameOf(state: EditorState): string | null {
  return state.facet(languageFacet)?.name ?? null
}

/**
 * Extracts symbols from the syntax tree (pure function). Nothing past `upto` is looked at (only as far as it has been parsed).
 * `truncated` if the count limit was reached.
 */
export function extractSymbols(
  tree: Tree,
  doc: Text,
  languageName: string,
  limit: number = MAX_SYMBOLS
): { readonly symbols: DocSymbol[]; readonly truncated: boolean } | null {
  const rule = RULES[languageName]
  if (rule === undefined) return null
  const symbols: DocSymbol[] = []
  /** Enclosing symbols (the node's range, name and kind). */
  const stack: { readonly from: number; readonly to: number; readonly name: string; readonly kind: SymbolKind }[] = []
  let truncated = false
  tree.iterate({
    enter(ref) {
      if (truncated) return false
      while (stack.length > 0 && stack[stack.length - 1]!.to <= ref.from) stack.pop()
      const node = ref.node
      const top = stack[stack.length - 1]
      const result = rule(node, doc, { kind: top?.kind ?? null })
      if (result === null) return undefined
      const containerName = stack.length === 0 ? null : stack.map((s) => s.name).join('.')
      for (const found of result.found) {
        if (symbols.length >= limit) {
          truncated = true
          return false
        }
        symbols.push({
          name: found.name,
          kind: found.kind,
          from: found.from,
          line: doc.lineAt(found.from).number,
          depth: stack.length,
          container: found.container ?? containerName
        })
      }
      const last = result.found[result.found.length - 1]
      if (result.container && last !== undefined) stack.push({ from: node.from, to: node.to, name: last.name, kind: last.kind })
      return undefined
    }
  })
  return { symbols, truncated }
}

/**
 * The symbols of the current editor (when opening the list with Cmd+R). null if the language has no table. It waits for the syntax tree up to `budgetMs`, and if that is not in time,
 * uses what has been parsed (`partial`).
 */
export function collectSymbols(state: EditorState, budgetMs: number = PARSE_BUDGET_MS): SymbolResult | null {
  const name = languageNameOf(state)
  if (!supportsSymbols(name)) return null
  const tree = ensureSyntaxTree(state, state.doc.length, budgetMs) ?? syntaxTree(state)
  const extracted = extractSymbols(tree, state.doc, name!)
  if (extracted === null) return null
  return { symbols: extracted.symbols, partial: extracted.truncated || tree.length < state.doc.length }
}

/**
 * Filtering (case-insensitive, like the Cmd+P candidates). Substring matches on the name come first, then substring matches on
 * `A.b` including the enclosure, and last scattered matches of the name (`gsym` -> `getSymbols`). Within the same tier, body order.
 */
export function filterSymbols(symbols: readonly DocSymbol[], query: string): DocSymbol[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...symbols]
  const exact: DocSymbol[] = []
  const qualified: DocSymbol[] = []
  const fuzzy: DocSymbol[] = []
  for (const symbol of symbols) {
    const name = symbol.name.toLowerCase()
    if (name.includes(q)) exact.push(symbol)
    else if (symbol.container !== null && `${symbol.container}.${symbol.name}`.toLowerCase().includes(q)) qualified.push(symbol)
    else if (subsequence(name, q)) fuzzy.push(symbol)
  }
  return [...exact, ...qualified, ...fuzzy]
}

function subsequence(haystack: string, needle: string): boolean {
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i++
    if (i === needle.length) return true
  }
  return false
}
