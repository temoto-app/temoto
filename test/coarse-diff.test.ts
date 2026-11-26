/**
 * Coarse line diff for the diff viewer's big inputs (TODO 1339, ARCHITECTURE 7.4.6).
 *
 * The invariant for `@codemirror/merge`'s `override`: the text between two changes must be character-for-character equal on both sides.
 * Most cases are checked by rebuilding `b` from `a` and the char changes.
 */
import { describe, expect, it } from 'vitest'
import { presentableDiff } from '@codemirror/merge'
import {
  MAX_COARSE_CHUNKS,
  MAX_COARSE_LINES,
  coarseCharChanges,
  coarseLineDiff,
  lineOffsets,
  refinedCharChanges
} from '../plugins/aios.diff/viewer/coarse-diff.js'

/** Applying the char changes to `a` must give `b`. */
function applies(a: string, b: string): boolean {
  const changes = coarseCharChanges(a, b)
  if (changes === null) return false
  let out = ''
  let atA = 0
  for (const c of changes) {
    if (a.slice(atA, c.fromA) !== b.slice(out.length, out.length + (c.fromA - atA))) return false
    out += a.slice(atA, c.fromA) + b.slice(c.fromB, c.toB)
    atA = c.toA
  }
  out += a.slice(atA)
  return out === b
}

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`): string =>
  Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n'

describe('coarseLineDiff', () => {
  it('reports no chunks for equal texts, including two empty texts', () => {
    expect(coarseLineDiff('a\nb\n', 'a\nb\n')).toEqual([])
    expect(coarseLineDiff('', '')).toEqual([])
  })

  it('finds a change at the start, the middle and the end as separate chunks', () => {
    const a = lines(30)
    const b = a.replace('line 0\n', 'first\n').replace('line 15\n', 'mid\n').replace('line 29\n', 'last\n')
    expect(coarseLineDiff(a, b)).toEqual([
      { fromA: 0, toA: 1, fromB: 0, toB: 1 },
      { fromA: 15, toA: 16, fromB: 15, toB: 16 },
      { fromA: 29, toA: 30, fromB: 29, toB: 30 }
    ])
  })

  it('handles pure additions and pure deletions', () => {
    expect(coarseLineDiff('a\nc\n', 'a\nb\nc\n')).toEqual([{ fromA: 1, toA: 1, fromB: 1, toB: 2 }])
    expect(coarseLineDiff('a\nb\nc\n', 'a\nc\n')).toEqual([{ fromA: 1, toA: 2, fromB: 1, toB: 1 }])
  })

  it('handles an empty side', () => {
    expect(coarseLineDiff('', 'a\nb\n')).toEqual([{ fromA: 0, toA: 0, fromB: 0, toB: 2 }])
    expect(coarseLineDiff('a\nb\n', '')).toEqual([{ fromA: 0, toA: 2, fromB: 0, toB: 0 }])
  })

  it('treats a missing final newline as a change of the last line', () => {
    expect(coarseLineDiff('x\ny', 'x\ny\n')).toEqual([{ fromA: 1, toA: 2, fromB: 1, toB: 2 }])
    expect(coarseLineDiff('x\ny\n', 'x\ny')).toEqual([{ fromA: 1, toA: 2, fromB: 1, toB: 2 }])
  })

  it('treats CRLF against LF as changed, and equal CRLF as equal', () => {
    expect(coarseLineDiff('a\r\nb\r\n', 'a\r\nb\r\n')).toEqual([])
    expect(coarseLineDiff('a\r\nb\r\n', 'a\nb\n')).toEqual([{ fromA: 0, toA: 2, fromB: 0, toB: 2 }])
  })

  it('splits on lines that are unique on both sides and tolerates repeated lines', () => {
    const a = 'x\nx\nx\nkeep-1\nx\nx\nkeep-2\nx\n'
    const b = 'x\nx\nx\nkeep-1\nx\nCHANGED\nx\nkeep-2\nx\n'
    const chunks = coarseLineDiff(a, b)!
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks.every((c) => c.fromB >= 3)).toBe(true)
  })

  it('keeps chunks ordered and non-overlapping on a shuffled middle', () => {
    const a = lines(200)
    const b = lines(200, (i) => `line ${(i * 7) % 200}`)
    const chunks = coarseLineDiff(a, b)!
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.fromA).toBeGreaterThanOrEqual(chunks[i - 1]!.toA)
      expect(chunks[i]!.fromB).toBeGreaterThanOrEqual(chunks[i - 1]!.toB)
    }
  })

  it('gives up (null) with more than MAX_COARSE_CHUNKS chunks', () => {
    const n = MAX_COARSE_CHUNKS + 5
    // Every other line differs, separated by unique unchanged lines.
    const a = Array.from({ length: n * 2 }, (_, i) => (i % 2 === 0 ? `same ${i}` : `a ${i}`)).join('\n')
    const b = Array.from({ length: n * 2 }, (_, i) => (i % 2 === 0 ? `same ${i}` : `b ${i}`)).join('\n')
    expect(coarseLineDiff(a, b)).toBeNull()
  })

  it('exports the line cap used for giving up', () => {
    expect(MAX_COARSE_LINES).toBeGreaterThan(1_000_000)
  })

  it('stays fast on a 300k-line input (about 18 MB per side) that changes every line (worst case)', () => {
    const a = lines(300_000, (i) => `const value_${i} = compute(${i}, 'item') // padding padding`)
    const b = lines(300_000, (i) => `const value_${i} = calc(${i}, 'it2') // padding padding x`)
    const t = Date.now()
    const chunks = coarseLineDiff(a, b)
    expect(Date.now() - t).toBeLessThan(5000)
    expect(chunks).toEqual([{ fromA: 0, toA: 300_000, fromB: 0, toB: 300_000 }])
  })

  it('finds a handful of scattered changes in a 150k-line input (about 7 MB) quickly', () => {
    const base = Array.from({ length: 150_000 }, (_, i) => `const value_${i} = compute(${i}) // padding padding`)
    const changed = [...base]
    for (const i of [10, 50_000, 149_999]) changed[i] = `${changed[i]} // edited`
    const t = Date.now()
    const chunks = coarseLineDiff(base.join('\n') + '\n', changed.join('\n') + '\n')
    expect(Date.now() - t).toBeLessThan(5000)
    expect(chunks?.map((c) => c.fromB)).toEqual([10, 50_000, 149_999])
  })
})

describe('coarseCharChanges', () => {
  it('maps to character ranges such that applying them to a gives b', () => {
    const cases: [string, string][] = [
      ['a\nb\nc\n', 'a\nB\nc\n'],
      ['a\nb\nc', 'a\nb\nc\nd'],
      ['a\r\nb\r\n', 'a\nb\n'],
      ['', 'new\n'],
      ['gone\n', ''],
      ['x', 'x\n'],
      ['one\ntwo\nthree\nfour\n', 'one\nthree\nfour\nfive\n']
    ]
    for (const [a, b] of cases) expect(applies(a, b), JSON.stringify([a, b])).toBe(true)
  })

  it('lineOffsets matches the lines as cut (no phantom empty last line)', () => {
    expect(lineOffsets('')).toEqual([0])
    expect(lineOffsets('a\n')).toEqual([0, 2])
    expect(lineOffsets('a\nb')).toEqual([0, 2, 3])
  })
})

describe('refinedCharChanges', () => {
  const source = (n: number): string =>
    Array.from({ length: n }, (_, i) => `const value_${i} = compute(${i}, 'item ${i}') // padding ${i}`).join('\n') + '\n'
  const same = (a: string, b: string): void => {
    const refined = refinedCharChanges(a, b)!
    const lib = presentableDiff(a, b).map((c) => ({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB }))
    expect(refined).toEqual(lib)
  }

  it('matches the library character diff for small edits in a 32 KB to 256 KB file', () => {
    const a = source(1500)
    expect(a.length).toBeGreaterThan(32 * 1024)
    expect(a.length).toBeLessThan(256 * 1024)
    same(a, a.replace('value_100 =', 'renamed_100 ='))
    same(a, a.replace("'item 700'", "'item seven hundred'").replace('compute(1200', 'compute(1201'))
    same(a, a.replace(/const value_400 .*\n/, ''))
    same(a, a.replace('const value_900 ', 'let extra = 1\nconst value_900 '))
    same(a, a.replace('value_5 =', 'x_5 =').replace('padding 1499', 'padding end'))
  })

  it('keeps a changed identifier as a character range instead of a whole line', () => {
    const a = source(1500)
    const changes = refinedCharChanges(a, a.replace('value_100 =', 'renamed_100 ='))!
    expect(changes).toHaveLength(1)
    expect(changes[0]!.toA - changes[0]!.fromA).toBeLessThan(10)
  })

  it('applies to the text exactly (the text between changes is equal on both sides)', () => {
    const a = source(800)
    const b = a.replace('compute(10,', 'compute(11,').replace(/const value_300 .*\n/, '') + 'tail\n'
    const changes = refinedCharChanges(a, b)!
    let out = ''
    let at = 0
    for (const c of changes) {
      out += a.slice(at, c.fromA) + b.slice(c.fromB, c.toB)
      at = c.toA
    }
    expect(out + a.slice(at)).toBe(b)
  })

  it('stays fast on a 1 MB input where every line differs, and where every other line differs', () => {
    const n = 30_000
    const pad = '.'.repeat(30)
    const all = (tag: string): string => Array.from({ length: n }, (_, i) => `${tag} ${i} ${pad}`).join('\n') + '\n'
    const alt = (tag: string): string =>
      Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `same ${i} ${pad}` : `${tag} ${i} ${pad}`)).join('\n') + '\n'
    for (const [a, b] of [
      [all('a'), all('b')],
      [alt('a'), alt('b')]
    ] as const) {
      expect(a.length).toBeGreaterThan(900_000)
      const started = performance.now()
      const changes = refinedCharChanges(a, b)
      const ms = performance.now() - started
      console.info(`refine ${(a.length / 1024).toFixed(0)} KB: ${ms.toFixed(0)} ms, ${changes?.length ?? 'null'} changes`)
      expect(changes).not.toBeNull()
      expect(ms).toBeLessThan(1000)
    }
  })
})
