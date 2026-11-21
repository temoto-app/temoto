/**
 * Declarations, assignments and uses of variables within a file (TODO 692, wave 32 bundle B, ARCHITECTURE.md 7.4.3.3). Approximates VS Code's
 * "Go to Definition" (F12), "Find All References" (Shift+F12) and document highlight **within the file only**.
 *
 * - The syntax tree is Lezer (`syntaxTree`). As in 468's `symbols.ts`, a per-language table of node names is kept only for the main languages
 *   (TS / JS / JSX / TSX, Python, C / C++). A language not in the table does nothing (null). No language server is used.
 * - From the name under the cursor, all occurrences of that name are collected, and **outer scopes** (function, block, class, module) are walked to
 *   decide which declaration each binds to. Only occurrences bound to the same declaration are returned (a same-named variable shadowed in an inner scope is a different thing).
 * - There are three roles: declaration (`declaration`), assignment (`write`: the left side of an assignment, `+=` and the like, `++` / `--`) and use (`read`). In
 *   the highlight a declaration counts as the assignment color (VS Code's TypeScript also returns a declaration as a write access).
 * - For Python, "the first binding in a scope (assignment, for, with ... as, import, def, class) is the declaration and the rest are assignments",
 *   and scopes that write `global` / `nonlocal` are skipped. Names in a class body are not visible from functions inside it.
 * - When that fails (a name whose declaration is not found, members such as `this.x` / `self.x` / `s.m`, the contents of C macros), it is shown
 *   **as words of the same name** (`mode: 'name'`). Members are grouped with same-named members (and a same-named
 *   variable declared in the class body).
 * - It does not touch the DOM (verified per language with vitest).
 */
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language'
import type { EditorState, Text } from '@codemirror/state'
import { languageNameOf } from './symbols.js'

// `@lezer/common` is not in the plugin boundary's allow table, so the type is derived from `@codemirror/language` (same as 468).
type Tree = ReturnType<typeof syntaxTree>
type SyntaxNode = Tree['topNode']

export type RefRole = 'declaration' | 'write' | 'read'

export interface CodeRef {
  readonly from: number
  readonly to: number
  /** 1-based line. */
  readonly line: number
  readonly role: RefRole
}

export interface ReferenceResult {
  /** The name (the word under the cursor). */
  readonly name: string
  /** Occurrences (in body order). Includes the occurrence under the cursor. */
  readonly refs: readonly CodeRef[]
  /** The declaration to jump to. null if not found. */
  readonly declaration: CodeRef | null
  /** `scope` = bound by walking the scopes / `name` = that failed, so shown as words of the same name. */
  readonly mode: 'scope' | 'name'
  /** The occurrence under the cursor (the first row of the list). */
  readonly target: CodeRef
  /** Parsing was not finished, or it was cut off at the count limit ("partial"). */
  readonly partial: boolean
}

/** Upper limit (ms) on waiting for the syntax tree to parse. The longest wait between pressing F12 / Shift+F12 and something happening (same as 468's Cmd+R). */
export const REFERENCE_PARSE_BUDGET_MS = 300

/** Upper limit on the number of occurrences collected. So the list and highlight do not get heavy for a common name (such as `i`) in a large file. */
export const MAX_REFERENCES = 5000

// ---------------------------------------------------------------------------
// Per-language tables
// ---------------------------------------------------------------------------

/**
 * Classification of a node for one name.
 * - `declare`: declares into `scope` (JS const / parameters, C declarators, etc.). `strong` means "a definition with a body" (a C function definition;
 *   jumped to before the prototype).
 * - `bind`: a Python binding. The first one in a scope is the declaration and the rest are assignments.
 * - `passthrough`: Python's `global` / `nonlocal`. A binding in that scope becomes an assignment to the outer variable.
 * - `ref`: walks the outer scopes and binds to a declaration (`role` is read / write). If `start` is present, walking starts from there
 *   (a Python parameter's default value is evaluated outside the function).
 * - `member`: a member (`this.x` / `self.x` / `s.m`, methods and attributes in a class body). Grouped with same-named members.
 */
type Classified =
  | { readonly kind: 'declare'; readonly scope: SyntaxNode; readonly strong?: boolean }
  | { readonly kind: 'bind'; readonly scope: SyntaxNode }
  | { readonly kind: 'passthrough'; readonly scope: SyntaxNode }
  | { readonly kind: 'ref'; readonly role: 'read' | 'write'; readonly start?: SyntaxNode | null }
  | { readonly kind: 'member'; readonly role: RefRole }

interface LangSpec {
  /** Names of nodes that can be a name. */
  readonly names: ReadonlySet<string>
  /** Names of nodes that create a scope (the top node is always a scope). */
  readonly scopes: ReadonlySet<string>
  /** Function scopes (where JS `var` goes; the marker for skipping Python class bodies). */
  readonly functionScopes: ReadonlySet<string>
  /** Class-body scopes. In Python they are not visible from functions inside. Also the place for declarations grouped with members. */
  readonly classScopes: ReadonlySet<string>
  /** Names in a class body are not visible from inside a function (Python). */
  readonly classScopeHidden: boolean
  classify(node: SyntaxNode, doc: Text, spec: LangSpec): Classified | null
}

function text(doc: Text, node: SyntaxNode): string {
  return doc.sliceString(node.from, node.to)
}

/** The innermost scope containing `node` (`node` itself is not counted). With `functionOnly`, function scopes only. */
function enclosingScope(node: SyntaxNode, spec: LangSpec, functionOnly = false): SyntaxNode {
  let last = node
  for (let p = node.parent; p !== null; p = p.parent) {
    last = p
    if (functionOnly ? spec.functionScopes.has(p.name) : spec.scopes.has(p.name)) return p
  }
  return last
}

function child(node: SyntaxNode, ...names: string[]): SyntaxNode | null {
  for (let c = node.firstChild; c !== null; c = c.nextSibling) if (names.includes(c.name)) return c
  return null
}

function lastChild(node: SyntaxNode, name: string): SyntaxNode | null {
  let found: SyntaxNode | null = null
  for (let c = node.firstChild; c !== null; c = c.nextSibling) if (c.name === name) found = c
  return found
}

// ---- JS / TS / JSX / TSX ----

/** Containers of destructuring (names inside are part of the outer declaration / assignment / parameter). */
const JS_PATTERNS = new Set(['ObjectPattern', 'ArrayPattern', 'PatternProperty', 'AssignmentPattern', 'Spread'])

/** Functions and methods (the scope of parameters). */
const JS_FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration'])

/** Whether it is the left side of an assignment (`x = …`, `x += …`). */
function isAssignTarget(node: SyntaxNode): boolean {
  const parent = node.parent
  return parent !== null && parent.name === 'AssignmentExpression' && parent.firstChild?.from === node.from
}

/** Whether it is the target of `++x` / `x--` (JS `PostfixExpression` / `UnaryExpression`). */
function isJsIncrement(node: SyntaxNode, doc: Text): boolean {
  const parent = node.parent
  if (parent === null || (parent.name !== 'PostfixExpression' && parent.name !== 'UnaryExpression')) return false
  const op = child(parent, 'ArithOp')
  if (op === null) return false
  const value = text(doc, op)
  return value === '++' || value === '--'
}

/** Where the declaration of a name (handled the same as JS `VariableDefinition`) goes. */
function jsDeclaration(node: SyntaxNode, spec: LangSpec): Classified {
  // Get out of the destructuring container.
  let top = node
  while (top.parent !== null && JS_PATTERNS.has(top.parent.name)) top = top.parent
  const owner = top.parent
  if (owner === null) return { kind: 'declare', scope: enclosingScope(node, spec) }
  switch (owner.name) {
    case 'ParamList':
      // Parameters belong to the function's scope (the function node is the parent of ParamList).
      return { kind: 'declare', scope: owner.parent ?? enclosingScope(owner, spec) }
    case 'TypeParamList':
      return { kind: 'declare', scope: owner.parent ?? enclosingScope(owner, spec) }
    case 'AssignmentExpression':
      // The left side of `[a, b] = …` is an assignment, not a declaration.
      return { kind: 'ref', role: 'write' }
    case 'VariableDeclaration': {
      const isVar = child(owner, 'var') !== null
      return { kind: 'declare', scope: enclosingScope(owner, spec, isVar) }
    }
    case 'ForOfSpec':
    case 'ForInSpec': {
      const isVar = child(owner, 'var') !== null
      return { kind: 'declare', scope: isVar ? enclosingScope(owner, spec, true) : enclosingScope(owner, spec) }
    }
    case 'CatchClause':
      return { kind: 'declare', scope: owner }
    default:
      // The names of functions, classes, interfaces and so on are declared in the scope outside that node
      // (even if the node itself is a scope, `enclosingScope` searches from the parent). Import names also go here (top).
      return { kind: 'declare', scope: enclosingScope(owner, spec) }
  }
}

/** Whether the name in a member expression is the left side of an assignment / the target of `++`. */
function jsMemberRole(member: SyntaxNode, doc: Text): RefRole {
  return isAssignTarget(member) || isJsIncrement(member, doc) ? 'write' : 'read'
}

const javascript: LangSpec = {
  names: new Set([
    'VariableName',
    'VariableDefinition',
    'TypeName',
    'TypeDefinition',
    'PropertyName',
    'PropertyDefinition',
    'PrivatePropertyDefinition',
    'PrivatePropertyName',
    'JSXIdentifier'
  ]),
  scopes: new Set([
    'Script',
    'Block',
    'ForStatement',
    'CatchClause',
    'ClassDeclaration',
    'ClassExpression',
    'InterfaceDeclaration',
    'TypeAliasDeclaration',
    ...JS_FUNCTIONS
  ]),
  functionScopes: new Set(['Script', ...JS_FUNCTIONS]),
  // No variables are declared in a JS class body (fields are members, `PropertyDefinition`).
  classScopes: new Set(),
  classScopeHidden: false,
  classify(node, doc, spec) {
    const parent = node.parent
    switch (node.name) {
      case 'VariableDefinition':
      case 'TypeDefinition':
        return jsDeclaration(node, spec)
      case 'VariableName': {
        if (parent?.name === 'ImportGroup') return null
        if (parent?.name === 'ExportGroup' && node.prevSibling?.name === 'as') return null
        return { kind: 'ref', role: isAssignTarget(node) || isJsIncrement(node, doc) ? 'write' : 'read' }
      }
      case 'TypeName':
        return { kind: 'ref', role: 'read' }
      case 'PropertyName': {
        // The short destructuring form `{ a }` / `{ a = 1 }` is a variable declaration (or assignment). The `a` in `{ a: b }` is a member.
        if (parent?.name === 'PatternProperty' && child(parent, ':') === null) return jsDeclaration(node, spec)
        if (parent?.name === 'MemberExpression') return { kind: 'member', role: jsMemberRole(parent, doc) }
        if (parent?.name === 'EnumBody') return { kind: 'member', role: 'declaration' }
        return { kind: 'member', role: 'read' }
      }
      case 'PropertyDefinition':
      case 'PrivatePropertyDefinition': {
        // The short object form `{ a }` is a use of variable a.
        if (parent?.name === 'Property' && parent.firstChild?.to === parent.lastChild?.to) return { kind: 'ref', role: 'read' }
        return { kind: 'member', role: 'declaration' }
      }
      case 'PrivatePropertyName':
        return { kind: 'member', role: parent?.name === 'MemberExpression' ? jsMemberRole(parent, doc) : 'read' }
      case 'JSXIdentifier': {
        // Only components starting with an uppercase letter (`<Foo>`) are variable uses. Lowercase is a tag name, and an attribute is an attribute name.
        if (parent?.name === 'JSXAttribute' || parent?.name === 'JSXBuiltin') return null
        return /^[A-Z]/.test(text(doc, node)) ? { kind: 'ref', role: 'read' } : null
      }
      default:
        return null
    }
  }
}

// ---- Python ----

/** Containers of the left side of an assignment (`a, (b, c) = …`). */
const PY_TARGET_WRAPPERS = new Set(['TupleExpression', 'ParenthesizedExpression', 'ArrayExpression', 'StarExpression'])

const PY_COMPREHENSIONS = new Set([
  'ArrayComprehensionExpression',
  'DictionaryComprehensionExpression',
  'SetComprehensionExpression',
  'ComprehensionExpression'
])

/** The node directly under `container` after leaving the containers (null if none). */
function pyTop(node: SyntaxNode): SyntaxNode {
  let top = node
  while (top.parent !== null && PY_TARGET_WRAPPERS.has(top.parent.name)) top = top.parent
  return top
}

/** Whether it is the left side of an assignment statement (`AssignStatement`). Children before the last `=` are the left side (a and b of `a = b = 1`). */
function isPyAssignTarget(top: SyntaxNode): boolean {
  const statement = top.parent
  if (statement === null || statement.name !== 'AssignStatement') return false
  const op = lastChild(statement, 'AssignOp')
  // For an annotation only, `x: int`, the first child is the left side.
  if (op === null) return statement.firstChild?.from === top.from
  return top.to <= op.from
}

/** Whether it is between `for` and `in` of `for … in` (for statements and comprehensions). */
function isPyForTarget(top: SyntaxNode): boolean {
  for (let s = top.prevSibling; s !== null; s = s.prevSibling) {
    if (s.name === 'in') return false
    if (s.name === 'for') return true
  }
  return false
}

const PY_PARAM_BEFORE = new Set(['(', ',', '*', '**', '/'])

const python: LangSpec = {
  names: new Set(['VariableName', 'PropertyName']),
  scopes: new Set(['Script', 'FunctionDefinition', 'ClassDefinition', 'LambdaExpression', ...PY_COMPREHENSIONS]),
  functionScopes: new Set(['Script', 'FunctionDefinition', 'LambdaExpression', ...PY_COMPREHENSIONS]),
  classScopes: new Set(['ClassDefinition']),
  classScopeHidden: true,
  classify(node, doc, spec) {
    const parent = node.parent
    if (parent === null) return null
    if (node.name === 'PropertyName') {
      if (parent.name !== 'MemberExpression') return { kind: 'member', role: 'read' }
      const top = pyTop(parent)
      const write =
        isPyAssignTarget(top) || (top.parent?.name === 'UpdateStatement' && top.parent.firstChild?.from === top.from)
      return { kind: 'member', role: write ? 'write' : 'read' }
    }
    // VariableName
    switch (parent.name) {
      case 'FunctionDefinition':
      case 'ClassDefinition':
        if (node.prevSibling?.name === 'def' || node.prevSibling?.name === 'class') {
          return { kind: 'bind', scope: enclosingScope(parent, spec) }
        }
        break
      case 'ParamList': {
        const before = node.prevSibling
        if (before === null || PY_PARAM_BEFORE.has(before.name)) {
          return { kind: 'declare', scope: parent.parent ?? enclosingScope(parent, spec) }
        }
        // A default value (`def f(y=x)`) is evaluated outside the function.
        return { kind: 'ref', role: 'read', start: parent.parent?.parent ?? null }
      }
      case 'ArgList':
        // The name of a keyword argument (`f(k=1)`) is not a variable.
        if (node.nextSibling?.name === 'AssignOp') return null
        break
      case 'ImportStatement': {
        // The b of `import a.b`, the x of `import x as y` and the m of `from m import …` are not bound (a, y, ... are bound).
        if (node.prevSibling?.name === '.' || node.nextSibling?.name === 'as') return null
        // The module name of `from m.n import …`: after `from`, before the first token that is neither a name nor `.`.
        let from: SyntaxNode | null = parent.firstChild
        while (from !== null && from.name !== 'from') from = from.nextSibling
        if (from !== null) {
          let keyword = from.nextSibling
          while (keyword !== null && (keyword.name === 'VariableName' || keyword.name === '.')) keyword = keyword.nextSibling
          if (keyword !== null && node.from < keyword.from) return null
        }
        return { kind: 'bind', scope: enclosingScope(parent, spec) }
      }
      case 'ScopeStatement':
        return { kind: 'passthrough', scope: enclosingScope(parent, spec, true) }
      case 'NamedExpression':
        if (parent.firstChild?.from === node.from) {
          // A `:=` inside a comprehension also binds in the enclosing function.
          let scope = enclosingScope(parent, spec)
          while (PY_COMPREHENSIONS.has(scope.name)) scope = enclosingScope(scope, spec)
          return { kind: 'bind', scope }
        }
        break
      case 'UpdateStatement':
        if (parent.firstChild?.from === node.from) return { kind: 'ref', role: 'write' }
        break
      default:
        break
    }
    if (node.prevSibling?.name === 'as' && (parent.name === 'WithStatement' || parent.name === 'TryStatement')) {
      return { kind: 'bind', scope: enclosingScope(parent, spec) }
    }
    const top = pyTop(node)
    if (isPyAssignTarget(top)) return { kind: 'bind', scope: enclosingScope(top.parent!, spec) }
    const container = top.parent
    if (container !== null && (container.name === 'ForStatement' || PY_COMPREHENSIONS.has(container.name))) {
      if (isPyForTarget(top)) {
        return { kind: 'bind', scope: PY_COMPREHENSIONS.has(container.name) ? container : enclosingScope(container, spec) }
      }
    }
    return { kind: 'ref', role: 'read' }
  }
}

// ---- C / C++ ----

/** Declarators to walk through (`*p`, `&r`, `a[3]`, `f(…)`, `x = 1`, `[a, b]`). */
const C_WRAPPING_DECLARATORS = new Set(['PointerDeclarator', 'ReferenceDeclarator', 'ParenthesizedDeclarator', 'StructuredBindingDeclarator'])
/** Only the first child continues the declarator (the N of `a[N]`, the x of `f(x)` and the y of `x = y` are different). */
const C_HEAD_DECLARATORS = new Set(['ArrayDeclarator', 'FunctionDeclarator', 'InitDeclarator'])
/** Statements that have declarators. */
const C_DECLARATION_OWNERS = new Set([
  'Declaration',
  'FieldDeclaration',
  'ParameterDeclaration',
  'OptionalParameterDeclaration',
  'VariadicParameterDeclaration',
  'ForRangeLoop',
  'FunctionDefinition'
])

/** If at a declarator position, the owning statement and the declarator directly under the statement. null otherwise. */
function cDeclaratorOwner(node: SyntaxNode): { readonly owner: SyntaxNode; readonly declarator: SyntaxNode } | null {
  let current = node
  for (let guard = 0; guard < 16; guard++) {
    const parent = current.parent
    if (parent === null) return null
    if (C_WRAPPING_DECLARATORS.has(parent.name)) {
      current = parent
      continue
    }
    if (C_HEAD_DECLARATORS.has(parent.name)) {
      if (parent.firstChild?.from !== current.from || parent.firstChild.name !== current.name) return null
      current = parent
      continue
    }
    if (C_DECLARATION_OWNERS.has(parent.name)) return { owner: parent, declarator: current }
    return null
  }
  return null
}

/** Scope of parameters: a function definition / lambda. For a prototype (`int f(int a);`), the declarator itself. */
function cParameterScope(owner: SyntaxNode, spec: LangSpec): SyntaxNode {
  let declarator: SyntaxNode | null = null
  for (let p = owner.parent; p !== null; p = p.parent) {
    if (p.name === 'FunctionDefinition' || p.name === 'LambdaExpression') return p
    if (p.name === 'FunctionDeclarator' || p.name === 'AbstractFunctionDeclarator') declarator ??= p
    if (p.name === 'Declaration' || p.name === 'FieldDeclaration' || spec.scopes.has(p.name)) break
  }
  return declarator ?? enclosingScope(owner, spec)
}

/** Classification of a name at a declarator position (a variable declaration). null otherwise. */
function cDeclaration(node: SyntaxNode, doc: Text, spec: LangSpec): Classified | null {
  const found = cDeclaratorOwner(node)
  if (found === null) return null
  const { owner, declarator } = found
  switch (owner.name) {
    case 'ParameterDeclaration':
    case 'OptionalParameterDeclaration':
    case 'VariadicParameterDeclaration':
      return { kind: 'declare', scope: cParameterScope(owner, spec) }
    case 'FunctionDefinition':
      if (declarator.name !== 'FunctionDeclarator' && !C_WRAPPING_DECLARATORS.has(declarator.name)) return null
      return { kind: 'declare', scope: enclosingScope(owner, spec), strong: true }
    case 'ForRangeLoop': {
      // Only the first declarator (the e of `for (auto &e : v)`; v is a use).
      for (let c = owner.firstChild; c !== null; c = c.nextSibling) {
        if (c.name === 'Identifier' || c.name.endsWith('Declarator')) {
          return c.from === declarator.from ? { kind: 'declare', scope: owner } : null
        }
      }
      return null
    }
    default: {
      if (declarator.from === node.from && declarator.name === node.name && node.name === 'Identifier') {
        // A name directly under a statement (`S s;`; in `int c = 1` in a condition, the declarator and the initializer sit at the same level). After the type,
        // if there is an `=` between it and the previous one, it is an initializer (a use).
        const before = node.prevSibling
        if (before === null) return null
        if (doc.sliceString(before.to, node.from).includes('=')) return null
      }
      return { kind: 'declare', scope: enclosingScope(owner, spec) }
    }
  }
}

/** Whether it is the left side of an assignment / the target of `++` (C `AssignmentExpression` / `UpdateExpression`). */
function cWriteTarget(node: SyntaxNode): boolean {
  const parent = node.parent
  if (parent === null) return false
  if (parent.name === 'AssignmentExpression') return parent.firstChild?.from === node.from
  return parent.name === 'UpdateExpression'
}

const C_SPECIFIERS = new Set(['ClassSpecifier', 'StructSpecifier', 'UnionSpecifier', 'EnumSpecifier'])

const cpp: LangSpec = {
  names: new Set(['Identifier', 'FieldIdentifier', 'TypeIdentifier']),
  scopes: new Set([
    'Program',
    'FunctionDefinition',
    'CompoundStatement',
    'ForStatement',
    'ForRangeLoop',
    'IfStatement',
    'WhileStatement',
    'SwitchStatement',
    'CatchClause',
    'LambdaExpression',
    'ClassSpecifier',
    'StructSpecifier',
    'UnionSpecifier',
    'NamespaceDefinition',
    'TemplateDeclaration'
  ]),
  functionScopes: new Set(['Program', 'FunctionDefinition', 'LambdaExpression']),
  classScopes: new Set(['ClassSpecifier', 'StructSpecifier', 'UnionSpecifier']),
  classScopeHidden: false,
  classify(node, doc, spec) {
    const parent = node.parent
    if (parent === null) return null
    switch (node.name) {
      case 'Identifier': {
        if (parent.name === 'PreprocDirective') {
          // The name in `#define M` / `#define F(x)` is declared at the top of the file. Parameters are only inside that directive.
          if (node.prevSibling?.name === '#define') return { kind: 'declare', scope: enclosingScope(parent, spec) }
          return parent.firstChild?.name === '#define' ? { kind: 'declare', scope: parent } : { kind: 'ref', role: 'read' }
        }
        if (parent.name === 'NamespaceDefinition') return null
        if (parent.name === 'Enumerator' && parent.firstChild?.from === node.from) {
          return { kind: 'declare', scope: enclosingScope(parent, spec) }
        }
        if (parent.name === 'ScopedIdentifier') {
          // The h of `K::h`. If it is the name of a function definition, it is a member declaration.
          const owner = parent.parent
          const define = owner?.name === 'FunctionDeclarator' && owner.firstChild?.from === parent.from
          return { kind: 'member', role: define ? 'declaration' : 'read' }
        }
        const declared = cDeclaration(node, doc, spec)
        if (declared !== null) return declared
        return { kind: 'ref', role: cWriteTarget(node) ? 'write' : 'read' }
      }
      case 'FieldIdentifier': {
        if (parent.name === 'FieldExpression') {
          return { kind: 'member', role: cWriteTarget(parent) ? 'write' : 'read' }
        }
        const declared = cDeclaration(node, doc, spec)
        if (declared !== null) return declared
        return { kind: 'member', role: 'read' }
      }
      case 'TypeIdentifier': {
        if (C_SPECIFIERS.has(parent.name) && parent.firstChild !== null) {
          const hasBody = child(parent, 'FieldDeclarationList', 'EnumeratorList') !== null
          const isName = child(parent, 'TypeIdentifier')?.from === node.from
          if (hasBody && isName) return { kind: 'declare', scope: enclosingScope(parent, spec) }
          return { kind: 'ref', role: 'read' }
        }
        if (parent.name === 'TypeDefinition' && lastChild(parent, 'TypeIdentifier')?.from === node.from) {
          return { kind: 'declare', scope: enclosingScope(parent, spec) }
        }
        if (parent.name === 'AliasDeclaration' && child(parent, 'TypeIdentifier')?.from === node.from) {
          return { kind: 'declare', scope: enclosingScope(parent, spec) }
        }
        if (parent.name === 'TypeParameterDeclaration' || parent.name === 'OptionalTypeParameterDeclaration') {
          return { kind: 'declare', scope: enclosingScope(parent, spec) }
        }
        return { kind: 'ref', role: 'read' }
      }
      default:
        return null
    }
  }
}

/** Language name (`Language.name`) -> table. A language not here has "none". */
const SPECS: Readonly<Record<string, LangSpec>> = {
  javascript,
  typescript: javascript,
  jsx: javascript,
  tsx: javascript,
  python,
  cpp
}

/** Whether the language has the tables for go to declaration / list assignments and uses. */
export function supportsReferences(languageName: string | null | undefined): boolean {
  return typeof languageName === 'string' && Object.hasOwn(SPECS, languageName)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface Occurrence {
  readonly from: number
  readonly to: number
  readonly node: SyntaxNode
  readonly classified: Classified
}

function scopeKey(node: SyntaxNode): string {
  return `${node.name}:${node.from}:${node.to}`
}

/** The name node at `pos` and its classification (the character right of the cursor first, otherwise the one on the left). */
function occurrenceAt(tree: Tree, doc: Text, spec: LangSpec, pos: number): Occurrence | null {
  for (const side of [1, -1] as const) {
    const node = tree.resolveInner(pos, side)
    if (!spec.names.has(node.name) || node.from > pos || node.to < pos) continue
    const classified = spec.classify(node, doc, spec)
    if (classified !== null) return { from: node.from, to: node.to, node, classified }
  }
  return null
}

/** The name under the cursor (the decision for whether it is the target of go to declaration / the list, or whether to show it in the right-click menu). null if none. */
export function identifierAt(
  tree: Tree,
  doc: Text,
  languageName: string,
  pos: number
): { readonly from: number; readonly to: number; readonly name: string } | null {
  const spec = SPECS[languageName]
  if (spec === undefined) return null
  const found = occurrenceAt(tree, doc, spec, pos)
  return found === null ? null : { from: found.from, to: found.to, name: doc.sliceString(found.from, found.to) }
}

/**
 * Declarations, assignments and uses of the name at `pos` (pure function). null if the language has no table or the position is not on a name. `tree` is as far as it has been parsed
 * (`partial` if `tree.length < doc.length`).
 *
 * When `scanRange` is passed, the tree walk that collects occurrences of the same name is limited to that range (code review of TODO 692: a fix for the weight of
 * automatic highlighting walking the whole syntax tree of up to 1,000,000 characters each time). The mechanism that walks scopes to bind to a declaration is unchanged
 * - if the declaration is outside that range, (with the same algorithm as before) it is simply not found and falls back to the `mode: 'name'` approximation.
 * The occurrence under the cursor is always included even if outside the range (`occurrenceAt` searches the whole tree). The Shift+F12 list (`scanRange` omitted) stays
 * whole-file, and the number of headings does not change either.
 */
export function findReferences(
  tree: Tree,
  doc: Text,
  languageName: string,
  pos: number,
  limit: number = MAX_REFERENCES,
  scanRange?: { readonly from: number; readonly to: number }
): ReferenceResult | null {
  const spec = SPECS[languageName]
  if (spec === undefined) return null
  const target = occurrenceAt(tree, doc, spec, pos)
  if (target === null) return null
  const name = doc.sliceString(target.from, target.to)

  // 1) Collect all occurrences of the same name (only within `scanRange` if given).
  const occurrences: Occurrence[] = []
  let truncated = false
  tree.iterate({
    from: scanRange?.from,
    to: scanRange?.to,
    enter(ref) {
      if (truncated) return false
      if (!spec.names.has(ref.name) || ref.to - ref.from !== name.length) return undefined
      if (doc.sliceString(ref.from, ref.to) !== name) return undefined
      const node = ref.node
      const classified = spec.classify(node, doc, spec)
      if (classified === null) return undefined
      if (occurrences.length >= limit) {
        truncated = true
        return false
      }
      occurrences.push({ from: ref.from, to: ref.to, node, classified })
      return undefined
    }
  })
  if (!occurrences.some((o) => o.from === target.from)) occurrences.push(target)
  occurrences.sort((a, b) => a.from - b.from)

  // 2) Declarations per scope. Scopes that write `global` / `nonlocal` are skipped.
  const passthrough = new Set<string>()
  for (const o of occurrences) if (o.classified.kind === 'passthrough') passthrough.add(scopeKey(o.classified.scope))
  /** Scope key -> the declarations in that scope (in body order). */
  const declared = new Map<string, Occurrence[]>()
  const declare = (scope: SyntaxNode, o: Occurrence): void => {
    const key = scopeKey(scope)
    const list = declared.get(key)
    if (list === undefined) declared.set(key, [o])
    else list.push(o)
  }
  for (const o of occurrences) if (o.classified.kind === 'declare') declare(o.classified.scope, o)
  /** Occurrence -> role, and the key of the scope it bound to (null = no declaration found). */
  const roles = new Map<Occurrence, RefRole>()
  const bound = new Map<Occurrence, string | null>()
  const resolve = (o: Occurrence): string | null => {
    let passedFunction = false
    const start = o.classified.kind === 'ref' && o.classified.start != null ? o.classified.start : o.node.parent
    for (let p: SyntaxNode | null = start; p !== null; p = p.parent) {
      const isScope = spec.scopes.has(p.name) || p.parent === null
      if (!isScope) continue
      const key = scopeKey(p)
      const hidden = spec.classScopeHidden && passedFunction && spec.classScopes.has(p.name)
      if (!hidden && !passthrough.has(key) && declared.has(key)) return key
      if (spec.functionScopes.has(p.name)) passedFunction = true
    }
    return null
  }
  // Python binding: if the scope has no declaration, the first binding is the declaration. In a `global` scope, it is an assignment to the outer variable.
  for (const o of occurrences) {
    const c = o.classified
    if (c.kind === 'declare') {
      roles.set(o, 'declaration')
      bound.set(o, scopeKey(c.scope))
    } else if (c.kind === 'bind') {
      const key = scopeKey(c.scope)
      if (passthrough.has(key)) continue
      if (declared.has(key)) roles.set(o, 'write')
      else {
        declare(c.scope, o)
        roles.set(o, 'declaration')
      }
      bound.set(o, key)
    }
  }
  for (const o of occurrences) {
    const c = o.classified
    if (bound.has(o)) continue
    if (c.kind === 'member') {
      roles.set(o, c.role)
      continue
    }
    if (c.kind === 'bind') {
      // A binding in a `global x` scope: an assignment to the outer x.
      roles.set(o, 'write')
      bound.set(o, resolve(o))
      continue
    }
    roles.set(o, c.kind === 'ref' ? c.role : 'read')
    bound.set(o, resolve(o))
  }

  // 3) Only occurrences bound to the same thing as the occurrence under the cursor.
  const isMember = (o: Occurrence): boolean => o.classified.kind === 'member'
  /** Names declared in a class body (grouped with members). */
  const classKeys = new Set(
    [...declared.keys()].filter((key) => spec.classScopes.has(key.slice(0, key.indexOf(':'))))
  )
  const targetOcc = occurrences.find((o) => o.from === target.from) ?? target
  const targetKey = bound.get(targetOcc) ?? null
  let group: Occurrence[]
  let mode: 'scope' | 'name'
  if (isMember(targetOcc) || (targetKey !== null && classKeys.has(targetKey))) {
    // Members: same-named members, and a same-named variable declared in the class body (and occurrences bound to it).
    group = occurrences.filter((o) => isMember(o) || (bound.get(o) != null && classKeys.has(bound.get(o)!)))
    mode = isMember(targetOcc) ? 'name' : 'scope'
  } else if (targetKey === null) {
    group = occurrences.filter((o) => !isMember(o) && bound.get(o) === null)
    mode = 'name'
  } else {
    group = occurrences.filter((o) => !isMember(o) && bound.get(o) === targetKey)
    mode = 'scope'
  }

  const toRef = (o: Occurrence): CodeRef => ({
    from: o.from,
    to: o.to,
    line: doc.lineAt(o.from).number,
    role: roles.get(o) ?? 'read'
  })
  const refs = group.map(toRef)
  const declarations = group.filter((o) => roles.get(o) === 'declaration')
  let declaration: Occurrence | undefined =
    declarations.find((o) => o.classified.kind === 'declare' && o.classified.strong === true) ?? declarations[0]
  // For a member with no declaration, the first assignment (`self.x = …`, same as Pylance). A variable whose declaration is not found has none.
  if (declaration === undefined && isMember(targetOcc)) declaration = group.find((o) => roles.get(o) === 'write')
  return {
    name,
    refs,
    declaration: declaration === undefined ? null : toRef(declaration),
    mode,
    target: toRef(targetOcc),
    partial: truncated || tree.length < doc.length
  }
}

/**
 * Declarations, assignments and uses of the name at `pos` in the current editor (F12 / Shift+F12 / right-click). It waits for the syntax tree up to `budgetMs`, and if that is not in time,
 * uses what has been parsed (`partial`). If `budgetMs` is 0 it does not wait (the highlight on every cursor move).
 *
 * `scanRange` is passed as is to `findReferences` (narrowing so that automatic highlighting walks only the visible range.
 * F12 / Shift+F12 do not pass it and stay whole-file).
 */
export function collectReferences(
  state: EditorState,
  pos: number,
  budgetMs: number = REFERENCE_PARSE_BUDGET_MS,
  scanRange?: { readonly from: number; readonly to: number }
): ReferenceResult | null {
  const name = languageNameOf(state)
  if (!supportsReferences(name)) return null
  const tree = budgetMs > 0 ? (ensureSyntaxTree(state, state.doc.length, budgetMs) ?? syntaxTree(state)) : syntaxTree(state)
  return findReferences(tree, state.doc, name!, pos, undefined, scanRange)
}
