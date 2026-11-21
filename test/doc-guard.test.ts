// TODO 184: a check that documents are not cut off in the middle (scripts/check-doc-shrink.mjs), and a script that resolves merge conflicts with "keep both" (scripts/merge/keepboth.py).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { shrinkProblem, tailProblem } from '../scripts/check-doc-shrink.mjs'

const enc = new TextEncoder()

describe('check-doc-shrink (TODO 184)', () => {
  it('UTF-8 ending in a newline passes', () => {
    expect(tailProblem(enc.encode('# 見出し\n本文\n'))).toBeNull()
  })

  it('catches a tail cut in the middle of a character (the 262,144-byte shape of 2026-09-27)', () => {
    const bytes = enc.encode('# 見出し\n日本語')
    expect(tailProblem(bytes.slice(0, bytes.length - 1))).toMatch(/UTF-8/)
  })

  it('catches a file that does not end in a newline and an empty file', () => {
    expect(tailProblem(enc.encode('abc'))).toMatch(/改行/)
    expect(tailProblem(new Uint8Array())).toMatch(/空/)
  })

  it('shrinkage is stopped from the ratio of the limit', () => {
    expect(shrinkProblem(1000, 950, 0.1)).toBeNull()
    expect(shrinkProblem(1000, 900, 0.1)).toMatch(/10\.0%/)
    expect(shrinkProblem(336553, 262144, 0.1)).not.toBeNull()
    expect(shrinkProblem(0, 10, 0.1)).toBeNull()
  })
})

function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.runIf(hasPython())('keepboth.py (TODO 184)', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const conflict = [
    'top',
    '<<<<<<< HEAD',
    'ours',
    '=======',
    'theirs',
    '>>>>>>> branch',
    'bottom',
    ''
  ].join('\n')

  function resolve(name: string, text: string, ...flags: string[]): string {
    dir = mkdtempSync(join(tmpdir(), 'aios-keepboth-'))
    const file = join(dir, name)
    writeFileSync(file, text)
    execFileSync('python3', ['scripts/merge/keepboth.py', ...flags, file], { stdio: 'ignore' })
    // No temporary file is left behind (replaced with os.replace)
    expect(readdirSync(dir)).toEqual([name])
    return readFileSync(file, 'utf8')
  }

  it('the default is HEAD → theirs, and for md a blank line between chunks', () => {
    expect(resolve('a.md', conflict)).toBe('top\nours\n\ntheirs\nbottom\n')
  })

  it('--theirs-first puts theirs first', () => {
    expect(resolve('a.md', conflict, '--theirs-first')).toBe('top\ntheirs\n\nours\nbottom\n')
  })

  it('for .ts, adds , to the end of the first chunk', () => {
    expect(resolve('a.ts', conflict)).toBe('top\nours,\ntheirs\nbottom\n')
  })

  it('even for .ts, does not add , to chunks of import, statement or comment (TODO 935)', () => {
    const cases = [
      ["import { a } from './a.js'", "import { b } from './b.js'"],
      ['const a = 1', 'const b = 2'],
      ['  doA();', '  doB();'],
      ['export function a() {\n  return 1\n}', 'export function b() {\n  return 2\n}'],
      ['// a', '// b']
    ]
    for (const [ours, theirs] of cases) {
      const text = `top\n<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> branch\nbottom\n`
      expect(resolve('a.ts', text)).toBe(`top\n${ours}\n${theirs}\nbottom\n`)
    }
  })

  it('for .ts elements (key: value, type:, etc.) adds ,, and --comma adds also to statements as before', () => {
    const entry = (a: string, b: string): string =>
      `top\n<<<<<<< HEAD\n${a}\n=======\n${b}\n>>>>>>> branch\nbottom\n`
    expect(resolve('a.ts', entry("  type: 'a'", "  type: 'b'"))).toBe("top\n  type: 'a',\n  type: 'b'\nbottom\n")
    expect(resolve('a.ts', entry("  a: { x: 1 }", "  b: { x: 2 }"))).toBe('top\n  a: { x: 1 },\n  b: { x: 2 }\nbottom\n')
    expect(resolve('a.ts', entry("import { a } from './a.js'", "import { b } from './b.js'"), '--comma')).toBe(
      "top\nimport { a } from './a.js',\nimport { b } from './b.js'\nbottom\n"
    )
  })

  it('adds , to a dictionary element that starts with a comment; does not add for comment-only or comment + statement (wave 49 review)', () => {
    const entry = (a: string, b: string): string =>
      `top\n<<<<<<< HEAD\n${a}\n=======\n${b}\n>>>>>>> branch\nbottom\n`
    expect(resolve('a.ts', entry('  // TODO 1: head\n  y: 2', '  z: 3'))).toBe('top\n  // TODO 1: head\n  y: 2,\n  z: 3\nbottom\n')
    expect(resolve('a.ts', entry('// c\nconst a = 1', 'const b = 2'))).toBe('top\n// c\nconst a = 1\nconst b = 2\nbottom\n')
  })

  it('does not add , to a call line without ; inside a .ts function body, and adds inside dictionaries, arrays and arguments (TODO 944)', () => {
    const wrap = (open: string, a: string, b: string): string =>
      `${open}\n<<<<<<< HEAD\n${a}\n=======\n${b}\n>>>>>>> branch\n}\n`
    for (const open of [
      'function f() {',
      'const f = () => {',
      'if (x) {',
      '} else {',
      'async run(): Promise<void> {',
      'class A {'
    ]) {
      expect(resolve('a.ts', wrap(open, '  doA()', '  doB()'))).toBe(`${open}\n  doA()\n  doB()\n}\n`)
    }
    // The body still follows after closing a nested { … }
    const nested = 'function f() {\n  if (y) {\n    z()\n  }'
    expect(resolve('a.ts', wrap(nested, '  doA()', '  doB()'))).toBe(`${nested}\n  doA()\n  doB()\n}\n`)
    // Inside an object, an array, or an argument list
    for (const open of ['const o = {', 'foo({', 'const a = [', 'call(', 'export default {', 'const g = () => ({']) {
      expect(resolve('a.ts', wrap(open, '  a()', '  b()'))).toBe(`${open}\n  a(),\n  b()\n}\n`)
    }
    // Brackets inside strings and comments are not counted
    const tricky = "function f() {\n  const s = '{'  // [\n  /* ( */"
    expect(resolve('a.ts', wrap(tricky, '  doA()', '  doB()'))).toBe(`${tricky}\n  doA()\n  doB()\n}\n`)
  })

  it('object keys (module: { / class: { / const module = {) are not treated as a body and get ,, and parentheses in a multi-line template literal are not counted (TODO 944 review)', () => {
    const wrap = (open: string, a: string, b: string): string =>
      `${open}\n<<<<<<< HEAD\n${a}\n=======\n${b}\n>>>>>>> branch\n}\n`
    for (const open of ['const o = {\n  module: {', 'const o = {\n  class: {', 'const module = {', 'const o = { interface: {']) {
      expect(resolve('a.ts', wrap(open, '  a()', '  b()'))).toBe(`${open}\n  a(),\n  b()\n}\n`)
    }
    for (const open of ['export class A {', 'namespace N {', 'declare module M {']) {
      expect(resolve('a.ts', wrap(open, '  a()', '  b()'))).toBe(`${open}\n  a()\n  b()\n}\n`)
    }
    const template = 'function f() {\n  const t = `\n    foo(\n    {\n  `'
    expect(resolve('a.ts', wrap(template, '  doA()', '  doB()'))).toBe(`${template}\n  doA()\n  doB()\n}\n`)
  })

  it('drops the diff3 ancestor chunk', () => {
    const diff3 = conflict.replace('ours\n', 'ours\n||||||| base\nancestor\n')
    expect(resolve('a.txt', diff3, '--comma')).toBe('top\nours,\ntheirs\nbottom\n')
  })
})
