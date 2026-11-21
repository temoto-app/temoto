/**
 * TODO 692 (wave 32 bundle B): declarations, assignments and uses of variables in a file (`plugins/_shared/references.ts`). It approximates by walking the per-language tables and scopes of the
 * syntax tree (Lezer) from the language pack. Does not start the model or Electron (the DOM is not needed either).
 *
 * Tests place the cursor at the `«` position in the body (the `«` is removed from the body). Results are compared as a sequence of
 * `role@line:column` (declaration D / assignment W / use R).
 */
import { describe, expect, it } from 'vitest'
import { EditorState, type Extension } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { cpp } from '@codemirror/lang-cpp'
import { markdown } from '@codemirror/lang-markdown'
import {
  collectReferences,
  findReferences,
  identifierAt,
  supportsReferences,
  type ReferenceResult
} from '../plugins/_shared/references.js'

const CURSOR = '«'

function analyze(source: string, support: Extension): { result: ReferenceResult | null; state: EditorState } {
  const pos = source.indexOf(CURSOR)
  expect(pos).toBeGreaterThanOrEqual(0)
  const doc = source.slice(0, pos) + source.slice(pos + 1)
  const state = EditorState.create({ doc, extensions: support })
  return { result: collectReferences(state, pos, 2000), state }
}

const MARK = { declaration: 'D', write: 'W', read: 'R' } as const

/** The form `D@1:7 W@2:1 R@3:5` (line:column, both 1-based). */
function brief(source: string, support: Extension): string {
  const { result, state } = analyze(source, support)
  expect(result).not.toBeNull()
  return result!.refs
    .map((ref) => {
      const line = state.doc.lineAt(ref.from)
      return `${MARK[ref.role]}@${line.number}:${ref.from - line.from + 1}`
    })
    .join(' ')
}

function declarationOf(source: string, support: Extension): string | null {
  const { result, state } = analyze(source, support)
  expect(result).not.toBeNull()
  const decl = result!.declaration
  if (decl === null) return null
  const line = state.doc.lineAt(decl.from)
  return `${decl.line}:${decl.from - line.from + 1}`
}

const ts = javascript({ typescript: true })
const js = javascript()

describe('JS / TS (TODO 692)', () => {
  it('separates declaration, assignment (= / += / ++ / --), and use; a declaration (with an initial value) is D', () => {
    const src = ['let «e = 1', 'e = e + 1', 'e += 2', 'e++', '--e', 'console.log(e)'].join('\n')
    expect(brief(src, ts)).toBe('D@1:5 W@2:1 R@2:5 W@3:1 W@4:1 W@5:3 R@6:13')
    expect(declarationOf(src, ts)).toBe('1:5')
  })

  it('a same-name variable hidden in an inner scope is a different thing (from both outside and inside)', () => {
    const src = ['const x = 1', 'function f() {', '  const x = 2', '  return x', '}', 'use(«x)'].join('\n')
    expect(brief(src, ts)).toBe('D@1:7 R@6:5')
    const inner = ['const x = 1', 'function f() {', '  const x = 2', '  return «x', '}', 'use(x)'].join('\n')
    expect(brief(inner, ts)).toBe('D@3:9 R@4:10')
    expect(declarationOf(inner, ts)).toBe('3:9')
  })

  it('arguments are in the function scope; destructuring, defaults, and rest are also declarations', () => {
    const src = ['function f(a, { b, c: [d] }, e = a, ...rest) {', '  return «a + b + d + e + rest.length', '}', 'a'].join('\n')
    expect(brief(src, ts)).toBe('D@1:12 R@1:34 R@2:10')
    expect(brief(['function f({ b }) {', '  return «b', '}'].join('\n'), ts)).toBe('D@1:14 R@2:10')
  })

  it('the function name is in the outer scope; F12 from a call goes to the definition', () => {
    const src = ['function «foo() {}', 'foo()', 'const g = () => foo()'].join('\n')
    expect(brief(src, ts)).toBe('D@1:10 R@2:1 R@3:17')
    expect(declarationOf(['function foo() {}', '«foo()'].join('\n'), ts)).toBe('1:10')
  })

  it('var is function scope and let is block; let in for and the catch argument', () => {
    const src = ['function f() {', '  if (1) { var «v = 1 }', '  return v', '}'].join('\n')
    expect(brief(src, js)).toBe('D@2:16 R@3:10')
    const loop = ['for (let «i = 0; i < 3; i++) {}', 'i'].join('\n')
    expect(brief(loop, js)).toBe('D@1:10 R@1:17 W@1:24')
    const caught = ['try {} catch («err) { log(err) }', 'err'].join('\n')
    expect(brief(caught, js)).toBe('D@1:15 R@1:26')
  })

  it('the left side of a destructuring is an assignment, and the shorthand object form is a use', () => {
    const src = ['let «e', '[e] = [1]', '({ e, n: e })'].join('\n')
    expect(brief(src, js)).toBe('D@1:5 W@2:2 R@3:4 R@3:10')
  })

  it('a member (`this.x`) is grouped as a member of the same name, and F12 goes to the declaration in the class', () => {
    const src = ['class K {', '  q = 0', '  m(p) { this.«q = p; return this.q }', '}', 'o.q'].join('\n')
    const { result } = analyze(src, ts)
    expect(result!.mode).toBe('name')
    expect(brief(src, ts)).toBe('D@2:3 W@3:15 R@3:34 R@5:3')
    expect(declarationOf(src, ts)).toBe('2:3')
  })

  it('a name whose declaration is not found matches only same-name occurrences that also have no declaration (words of the same name); F12 has no destination', () => {
    const src = ['«console.log(1)', 'function f(console) { console }', 'console.error(2)'].join('\n')
    const { result } = analyze(src, ts)
    expect(result!.mode).toBe('name')
    expect(result!.declaration).toBeNull()
    expect(brief(src, ts)).toBe('R@1:1 R@3:1')
  })

  it('type names and import', () => {
    const src = ["import def, { im as «al } from 'x'", 'type T = number', 'let t: T = al', 'def()'].join('\n')
    expect(brief(src, ts)).toBe('D@1:21 R@3:12')
    expect(brief(['type «T = number', 'let t: T = 1'].join('\n'), ts)).toBe('D@1:6 R@2:8')
  })

  it('the name of a JSX component is a use; tag names and attribute names are out of scope', () => {
    const src = ['const «Foo = () => null', 'const v = <div a={Foo}><Foo /></div>'].join('\n')
    expect(brief(src, javascript({ jsx: true }))).toBe('D@1:7 R@2:19 R@2:25')
    expect(identifierAt(ensureSyntaxTree(EditorState.create({ doc: '<div a={1} />', extensions: javascript({ jsx: true }) }), 20, 2000)!, EditorState.create({ doc: '<div a={1} />' }).doc, 'jsx', 2)).toBeNull()
  })
})

describe('Python (TODO 692)', () => {
  const py = python()

  it('the first assignment in a scope is the declaration, and the rest are assignments; += is an assignment', () => {
    const src = ['«x = 1', 'x += 2', 'x = x * 2', 'print(x)'].join('\n')
    expect(brief(src, py)).toBe('D@1:1 W@2:1 W@3:1 R@3:5 R@4:7')
  })

  it('arguments are declared in the function scope; an assignment of the same name inside the function is local (separate from outside)', () => {
    const src = ['x = 0', 'def f(«x, y=x):', '    x = 1', '    return x', 'print(x)'].join('\n')
    expect(brief(src, py)).toBe('D@2:7 W@3:5 R@4:12')
    const outer = ['«x = 0', 'def f():', '    x = 1', '    return x', 'print(x)'].join('\n')
    expect(brief(outer, py)).toBe('D@1:1 R@5:7')
  })

  it('an assignment inside a function that writes global is an assignment to the outer variable', () => {
    const src = ['«x = 0', 'def f():', '    global x', '    x = 1', 'print(x)'].join('\n')
    expect(brief(src, py)).toBe('D@1:1 R@3:12 W@4:5 R@5:7')
  })

  it('for, with ... as, except ... as, import, def, class, and tuple assignment also bind', () => {
    expect(brief(['for «i, j in z:', '    print(i)'].join('\n'), py)).toBe('D@1:5 R@2:11')
    expect(brief(['with open() as «fh:', '    fh.read()'].join('\n'), py)).toBe('D@1:16 R@2:5')
    expect(brief(['import os, sys as «s', 's.argv'].join('\n'), py)).toBe('D@1:19 R@2:1')
    expect(brief(['from m import a as b, «c', 'c()'].join('\n'), py)).toBe('D@1:23 R@2:1')
    expect(brief(['def «g(): pass', 'g()'].join('\n'), py)).toBe('D@1:5 R@2:1')
    expect(brief(['a, («b, c) = 1, (2, 3)', 'b'].join('\n'), py)).toBe('D@1:5 R@2:1')
  })

  it('a comprehension variable is only inside the comprehension; keyword argument names are out of scope', () => {
    const src = ['j = 1', 'r = [«j for j in q]', 'f(j=1, k=j)'].join('\n')
    expect(brief(src, py)).toBe('R@2:6 D@2:12')
    expect(brief(['«j = 1', 'r = [j for j in q]', 'f(j=1, k=j)'].join('\n'), py)).toBe('D@1:1 R@3:10')
  })

  it('names in a class body are not visible from functions inside; self.v and v in the class body are grouped', () => {
    const src = ['v = 0', 'class C:', '    «v = 1', '    def m(self):', '        return self.v + v'].join('\n')
    expect(brief(src, py)).toBe('D@3:5 R@5:21')
    const global = ['«v = 0', 'class C:', '    v = 1', '    def m(self):', '        return self.v + v'].join('\n')
    expect(brief(global, py)).toBe('D@1:1 R@5:25')
    expect(declarationOf(['class C:', '    def m(self): pass', '    def n(self): self.«m()'].join('\n'), py)).toBe('2:9')
  })

  it('self.x is a member; if there is no declaration it jumps to the first assignment', () => {
    const src = ['class C:', '    def __init__(self):', '        self.x = 1', '    def m(self):', '        return self.«x'].join('\n')
    expect(brief(src, py)).toBe('W@3:14 R@5:21')
    expect(declarationOf(src, py)).toBe('3:14')
  })
})

describe('C / C++ (TODO 692)', () => {
  const c = cpp()

  it('declarators (with an initial value, pointer, array), assignment, ++ / --, and use', () => {
    const src = ['int «g = 0, *pg, arr[3];', 'void f(void) { g = 1; g += 2; g++; --g; use(g); }'].join('\n')
    expect(brief(src, c)).toBe('D@1:5 W@2:16 W@2:23 W@2:31 W@2:38 R@2:45')
    // Lezer's C grammar reads `*pg = 1` as `*(pg = 1)` (a precedence quirk), so an assignment through a pointer looks like an assignment to pg.
    expect(brief(['int g, *«pg;', 'void f(void) { use(pg[0]); }'].join('\n'), c)).toBe('D@1:9 R@2:20')
  })

  it('arguments are in the function definition scope; separate from a global variable of the same name', () => {
    const src = ['int a = 0;', 'int f(int «a, char *b) { int x = a; return x + b[0]; }', 'int y = a;'].join('\n')
    expect(brief(src, c)).toBe('D@2:11 R@2:33')
    expect(brief(['int «a = 0;', 'int f(int a) { return a; }', 'int y = a;'].join('\n'), c)).toBe('D@1:5 R@3:9')
  })

  it('functions: both prototype and definition are declarations, and F12 goes to the definition; a call is a use', () => {
    const src = ['int h(int);', 'int h(int n) { return n; }', 'int k = «h(1);'].join('\n')
    expect(brief(src, c)).toBe('D@1:5 D@2:5 R@3:9')
    expect(declarationOf(src, c)).toBe('2:5')
  })

  it('declarations in an inner block or for are separate from outside; declarations in a condition', () => {
    const src = ['int main() {', '  int «i = 0;', '  for (int i = 0; i < 3; i++) {}', '  { int i = 2; }', '  return i;', '}'].join('\n')
    expect(brief(src, c)).toBe('D@2:7 R@5:10')
    expect(brief(['void f() { if (int «c = d) { use(c); } }'].join('\n'), c)).toBe('D@1:20 R@1:33')
  })

  it('the name of #define is declared at the top of the file (the body is not analyzed)', () => {
    const src = ['#define «M 1', 'int main() { return M; }'].join('\n')
    expect(brief(src, c)).toBe('D@1:9 R@2:21')
  })

  it('struct members: s.m and this->v are grouped as members and jump to the declaration (int m;)', () => {
    const src = ['struct S { int m; };', 'void f(S s) { s.«m = 1; use(s.m); }'].join('\n')
    expect(brief(src, c)).toBe('D@1:16 W@2:17 R@2:30')
    expect(declarationOf(src, c)).toBe('1:16')
    const cls = ['class K { int v; void h() { «v = 1; this->v = 2; } };'].join('\n')
    expect(brief(cls, c)).toBe('D@1:15 W@1:29 W@1:42')
  })

  it('range for and lambdas', () => {
    const src = ['void f() { for (auto &«e : v) { e = 1; } }'].join('\n')
    expect(brief(src, c)).toBe('D@1:23 W@1:32')
    const lambda = ['int f(int n) { auto l = [n](int «m) { return m + n; }; return m; }'].join('\n')
    expect(brief(lambda, c)).toBe('D@1:33 R@1:45')
  })

  it('type names (struct / typedef / enum values)', () => {
    expect(brief(['typedef int «T;', 'T t;'].join('\n'), c)).toBe('D@1:13 R@2:1')
    expect(brief(['enum Color { «RED, GREEN };', 'int c = RED;'].join('\n'), c)).toBe('D@1:14 R@2:9')
  })
})

describe('out of scope and partial (TODO 692)', () => {
  it('null for a language without a table or a position not on a name', () => {
    expect(supportsReferences('markdown')).toBe(false)
    expect(supportsReferences('typescript')).toBe(true)
    const md = EditorState.create({ doc: '# x', extensions: markdown() })
    expect(collectReferences(md, 2, 100)).toBeNull()
    expect(analyze('let x = « 1', ts).result).toBeNull()
    expect(analyze('// «comment', ts).result).toBeNull()
  })

  it('takes the word even when the cursor is right after it', () => {
    expect(brief(['let ab« = 1', 'ab'].join('\n'), ts)).toBe('D@1:5 R@2:1')
  })

  it('if analysis does not finish in time, it returns up to the analyzed part (partial)', () => {
    const lines = Array.from({ length: 40000 }, (_, i) => `var v${i} = v${i > 0 ? i - 1 : 0} + 1;`)
    const doc = ['let target = 1', ...lines, 'target'].join('\n')
    const state = EditorState.create({ doc, extensions: js })
    const result = collectReferences(state, 5, 0)
    // A budget of 0 does not wait (highlighting on each cursor move): up to what has been analyzed.
    expect(result === null || result.partial).toBe(true)
  })

  it('if cut off by the count limit, it is partial', () => {
    const doc = ['let x = 0', ...Array.from({ length: 20 }, () => 'x++')].join('\n')
    const state = EditorState.create({ doc, extensions: js })
    const tree = ensureSyntaxTree(state, doc.length, 2000)!
    const result = findReferences(tree, state.doc, 'javascript', 4, 5)
    expect(result!.partial).toBe(true)
    expect(result!.refs.length).toBeLessThanOrEqual(6)
  })

  it('scanRange (code-review of TODO 692): narrows the enumeration of occurrences to that range; the occurrence under the cursor is included even outside the range', () => {
    const doc = ['let x = 0', ...Array.from({ length: 20 }, () => 'x++'), 'x'].join('\n')
    const state = EditorState.create({ doc, extensions: js })
    const tree = ensureSyntaxTree(state, doc.length, 2000)!
    const pos = doc.indexOf('let x') + 4 // The cursor is on "x" of the declaration
    // If the range is narrowed to a few lines right after the cursor, x++ on a distant line is not counted (but the cursor's own occurrences are).
    const narrow = findReferences(tree, state.doc, 'javascript', pos, undefined, { from: pos, to: pos + 20 })
    const full = findReferences(tree, state.doc, 'javascript', pos)
    expect(narrow!.refs.length).toBeLessThan(full!.refs.length)
    expect(narrow!.refs.some((ref) => ref.from === pos)).toBe(true)
  })
})
