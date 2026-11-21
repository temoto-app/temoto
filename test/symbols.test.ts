/**
 * TODO 468 (wave 23 bundle F): extracting symbols from a file (`plugins/_shared/symbols.ts`). From the language pack's syntax tree (Lezer), symbols are taken by a table for each major language. Neither a model nor Electron is started (the DOM is not needed either).
 */
import { describe, expect, it } from 'vitest'
import { EditorState, type Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { collectSymbols, filterSymbols, supportsSymbols, type DocSymbol } from '../plugins/_shared/symbols.js'

function symbolsOf(doc: string, support: Extension): DocSymbol[] {
  const result = collectSymbols(EditorState.create({ doc, extensions: support }), 2000)
  expect(result).not.toBeNull()
  expect(result!.partial).toBe(false)
  return [...result!.symbols]
}

/** Compares in the short form `kind name @line (container)`. */
function brief(symbols: readonly DocSymbol[]): string[] {
  return symbols.map((s) => `${s.kind} ${s.name} @${s.line}${s.container === null ? '' : ` (${s.container})`}`)
}

describe('言語ごとの記号 (TODO 468)', () => {
  it('TypeScript: 関数・クラスとメソッド・interface・type・enum・namespace・頂上の変数 (関数の中の変数は出さない)', () => {
    const src = [
      "import x from 'y'",
      'export function foo(a: number): void { const local = 1 }',
      'export const bar = (x: number) => x, baz = 1',
      'let q = function () {}',
      'class A extends B { m() {} get g() { return 1 } private p = 2 }',
      'interface I { a: string }',
      'type T = { a: 1 }',
      'enum E { X }',
      'namespace N { function inner() {} }'
    ].join('\n')
    expect(brief(symbolsOf(src, javascript({ typescript: true })))).toEqual([
      'function foo @2',
      'function bar @3',
      'constant baz @3',
      'function q @4',
      'class A @5',
      'method m @5 (A)',
      'method g @5 (A)',
      'property p @5 (A)',
      'interface I @6',
      'type T @7',
      'enum E @8',
      'namespace N @9',
      'function inner @9 (N)'
    ])
  })

  it('飛び先は名前の字 (export の頭ではない)', () => {
    const src = 'export function foo() {}'
    const [foo] = symbolsOf(src, javascript())
    expect(foo!.from).toBe(src.indexOf('foo'))
  })

  it('Python: クラスの中の def はメソッド、頂上とクラスの本体の代入', () => {
    const src = ['def foo(a):', '    def inner(): pass', 'class A(B):', '    x = 1', '    def m(self): pass', 'X = 3', '@dec', 'def deco(): pass'].join('\n')
    expect(brief(symbolsOf(src, python()))).toEqual([
      'function foo @1',
      'function inner @2 (foo)',
      'class A @3',
      'property x @4 (A)',
      'method m @5 (A)',
      'variable X @6',
      'function deco @8'
    ])
  })

  it('Go: 関数・メソッド (受け手の型)・struct / interface・頂上の var / const (関数の中は出さない)', () => {
    const src = [
      'package main',
      'func foo() { var local = 1 }',
      'func (r *R) Meth() {}',
      'type T struct { A int }',
      'type I interface { M() }',
      'var V = 1',
      'const ( D = 3; E = 4 )'
    ].join('\n')
    expect(brief(symbolsOf(src, go()))).toEqual([
      'function foo @2',
      'method Meth @3 (R)',
      'struct T @4',
      'interface I @5',
      'variable V @6',
      'constant D @7',
      'constant E @7'
    ])
  })

  it('Rust: fn・struct・enum・trait・impl の中の fn はメソッド・mod・const・type・macro_rules', () => {
    const src = [
      'fn foo() {}',
      'struct S { a: i32 }',
      'enum E { A }',
      'trait T { fn t(&self); }',
      'impl T for S { fn t(&self) {} }',
      'mod m { fn inner() {} }',
      'const C: i32 = 1;',
      'type Al = i32;',
      'macro_rules! mac { () => {} }'
    ].join('\n')
    expect(brief(symbolsOf(src, rust()))).toEqual([
      'function foo @1',
      'struct S @2',
      'enum E @3',
      'interface T @4',
      'method t @4 (T)',
      'impl T for S @5',
      'method t @5 (T for S)',
      'namespace m @6',
      'function inner @6 (m)',
      'constant C @7',
      'type Al @8',
      'macro mac @9'
    ])
  })

  it('Java: クラス・フィールド・コンストラクタ・メソッド・入れ子のクラス・interface・enum', () => {
    const src = [
      'package p;',
      'public class A {',
      '  private int f = 1;',
      '  public A() {}',
      '  void m() {}',
      '  class Inner {}',
      '}',
      'interface I { void n(); }',
      'enum E2 { X }'
    ].join('\n')
    expect(brief(symbolsOf(src, java()))).toEqual([
      'class A @2',
      'property f @3 (A)',
      'method A @4 (A)',
      'method m @5 (A)',
      'class Inner @6 (A)',
      'interface I @8',
      'method n @8 (I)',
      'enum E2 @9'
    ])
  })

  it('C / C++: 関数 (ポインタを返す・テンプレート・A::m)・class / struct・namespace・enum・typedef・#define', () => {
    const src = [
      '#define MAC 1',
      'int foo(int a) { return a; }',
      'void A::meth() {}',
      'class C { public: void m(); int x; };',
      'struct S { int a; };',
      'namespace ns { int g() { return 0; } }',
      'enum E { X };',
      'typedef int T;',
      'template<typename U> U tf(U x) { return x; }',
      'int *pf(void) { return 0; }'
    ].join('\n')
    expect(brief(symbolsOf(src, cpp()))).toEqual([
      'macro MAC @1',
      'function foo @2',
      'method A::meth @3',
      'class C @4',
      'method m @4 (C)',
      'struct S @5',
      'namespace ns @6',
      'function g @6 (ns)',
      'enum E @7',
      'type T @8',
      'function tf @9',
      'function pf @10'
    ])
  })

  it('JSON: 鍵を入れ子で (引用符は外す)', () => {
    const src = '{"a": 1, "b": {"c": [1, {"d\\"q": 2}]}}'
    expect(brief(symbolsOf(src, json()))).toEqual(['key a @1', 'key b @1', 'key c @1 (b)', 'key d"q @1 (b.c)'])
  })

  it('YAML: 鍵を入れ子で (列の中の対も)', () => {
    const src = ['a: 1', 'b:', '  c: 2', '  d:', '    - e: 3', '"f g": [1]'].join('\n')
    expect(brief(symbolsOf(src, yaml()))).toEqual([
      'key a @1',
      'key b @2',
      'key c @3 (b)',
      'key d @4 (b)',
      'key e @5 (b.d)',
      'key f g @6'
    ])
  })

  it('CSS: selector と @media / @keyframes (中の規則は入れ子)', () => {
    const src = ['a, .b > c { color: red }', '@media (max-width: 1px) { .m { } }', '@keyframes k { from {} }'].join('\n')
    expect(brief(symbolsOf(src, css()))).toEqual([
      'selector a, .b > c @1',
      'namespace @media (max-width: 1px) @2',
      'selector .m @2 (@media (max-width: 1px))',
      'namespace @keyframes k @3'
    ])
  })

  it('表に無い言語 (Markdown・言語なし) は null (見出しのボタンを出さない)', () => {
    expect(collectSymbols(EditorState.create({ doc: '# a', extensions: markdown() }))).toBeNull()
    expect(collectSymbols(EditorState.create({ doc: 'plain' }))).toBeNull()
    expect(supportsSymbols('markdown')).toBe(false)
    expect(supportsSymbols('typescript')).toBe(true)
    expect(supportsSymbols(null)).toBe(false)
    expect(supportsSymbols('toString')).toBe(false)
  })

  it('大きなファイルで解析が間に合わなければ「途中まで」(partial)', () => {
    const big = Array.from({ length: 40_000 }, (_, i) => `function f${i}() { return ${i} }`).join('\n')
    const result = collectSymbols(EditorState.create({ doc: big, extensions: javascript() }), 0)
    expect(result).not.toBeNull()
    expect(result!.partial).toBe(true)
    expect(result!.symbols.length).toBeLessThan(40_000)
  })
})

describe('filterSymbols', () => {
  const symbols = symbolsOf('class Store { getSymbols() {} setValue() {} }\nfunction gather() {}', javascript())

  it('空なら全部、部分一致を先に、次に A.b、最後に飛び飛びの一致 (大文字小文字は区別しない)', () => {
    expect(filterSymbols(symbols, '').map((s) => s.name)).toEqual(['Store', 'getSymbols', 'setValue', 'gather'])
    expect(filterSymbols(symbols, 'VALUE').map((s) => s.name)).toEqual(['setValue'])
    expect(filterSymbols(symbols, 'store.set').map((s) => s.name)).toEqual(['setValue'])
    expect(filterSymbols(symbols, 'gs').map((s) => s.name)).toEqual(['getSymbols'])
    // A partial match ('ge' for getSymbols) comes first; scattered matches (g…e for gather) come later.
    expect(filterSymbols(symbols, 'ge').map((s) => s.name)).toEqual(['getSymbols', 'gather'])
    expect(filterSymbols(symbols, 'zzz')).toEqual([])
  })
})
