/**
 * Rainbow colors per working directory (TODO 50 / 108).
 *
 * Item 108 changed it from a "hash of the full path" to "assignment in order of appearance + persistence".
 * What is checked here:
 * - `assignRainbow` (a pure function, `src/common/rainbow.ts`): until all 16 colors are used there are no collisions, and it picks the number farthest apart on the color wheel. Once all are used, it picks the least-used one, and on a tie the smallest number.
 *   A key already in the table returns the same value (idempotent).
 * - The renderer (`src/renderer/src/rainbow.ts`) no longer computes numbers. It only turns `Thread.rainbow` (the value main has fixed) into a CSS variable.
 */
import { describe, expect, it } from 'vitest'
import { RAINBOW_COLORS, assignRainbow } from '../src/common/rainbow.js'
import { rainbowStyle, rainbowVar } from '../src/renderer/src/rainbow.js'

describe('assignRainbow (項目 108、出現順の割り当て)', () => {
  it('空の表では最初の 1 個は 0', () => {
    expect(assignRainbow({}, 'a')).toBe(0)
  })

  it('既に表にある鍵は同じ値を返す (idempotent)', () => {
    const table = { a: 3 }
    expect(assignRainbow(table, 'a')).toBe(3)
    // The table itself is not rewritten (pure function).
    expect(table).toEqual({ a: 3 })
  })

  it('16 種類までは衝突ゼロで、色相環で最も離れた番号を選ぶ', () => {
    let table: Record<string, number> = {}
    const order: number[] = []
    for (let i = 0; i < RAINBOW_COLORS; i += 1) {
      const key = `cwd-${i}`
      const assigned = assignRainbow(table, key)
      order.push(assigned)
      table = { ...table, [key]: assigned }
    }
    // No collisions: all 16 are different.
    expect(new Set(order).size).toBe(RAINBOW_COLORS)
    // The first is 0, the second is the opposite side (8): "after blue, orange".
    expect(order[0]).toBe(0)
    expect(order[1]).toBe(8)
  })

  it('17 個目からは使用回数最小の番号を再利用する', () => {
    let table: Record<string, number> = {}
    for (let i = 0; i < RAINBOW_COLORS; i += 1) {
      const key = `cwd-${i}`
      table = { ...table, [key]: assignRainbow(table, key) }
    }
    // Up to here every number has been used once. The 17th picks, among the least-used (everyone once), the smallest number → 0.
    const seventeenth = assignRainbow(table, 'cwd-16')
    expect(seventeenth).toBe(0)
    table = { ...table, 'cwd-16': seventeenth }
    // The 18th: 0 has been used twice, the most, so it picks the next smallest, 1 (still used once).
    const eighteenth = assignRainbow(table, 'cwd-17')
    expect(eighteenth).toBe(1)
  })

  it('壊れた値 (範囲外・非整数) は使用中として数えない', () => {
    const table = { a: 999, b: -1, c: 1.5 } as unknown as Record<string, number>
    // The numbers in use are treated as absent (the table is broken), so a new one is 0.
    expect(assignRainbow(table, 'd')).toBe(0)
  })

  it('表の並び順ではなく中身だけで決まる (どちらの表現でも同じ結果)', () => {
    const tableA = { x: 0, y: 8 }
    const tableB = { y: 8, x: 0 }
    expect(assignRainbow(tableA, 'z')).toBe(assignRainbow(tableB, 'z'))
  })
})

describe('renderer 側 (rainbowVar / rainbowStyle) は番号を変換するだけ', () => {
  it('番号を `var(--rainbow-N)` に変える', () => {
    expect(rainbowVar(0)).toBe('var(--rainbow-0)')
    expect(rainbowVar(15)).toBe('var(--rainbow-15)')
  })

  it('null (無所属・cwd 無し) は色を付けない', () => {
    expect(rainbowVar(null)).toBeNull()
    expect(rainbowStyle(null)).toBeUndefined()
  })

  it('番号があれば `--thread-accent` に載せる', () => {
    expect(rainbowStyle(6)).toEqual({ '--thread-accent': 'var(--rainbow-6)' })
  })
})
