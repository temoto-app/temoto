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

describe('assignRainbow (item 108, assignment in order of appearance)', () => {
  it('the first one in an empty table is 0', () => {
    expect(assignRainbow({}, 'a')).toBe(0)
  })

  it('a key already in the table returns the same value (idempotent)', () => {
    const table = { a: 3 }
    expect(assignRainbow(table, 'a')).toBe(3)
    // The table itself is not rewritten (pure function).
    expect(table).toEqual({ a: 3 })
  })

  it('up to 16 kinds there are no collisions, and it picks the number farthest apart on the hue wheel', () => {
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

  it('from the 17th it reuses the number with the fewest uses', () => {
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

  it('broken values (out of range, non-integer) are not counted as in use', () => {
    const table = { a: 999, b: -1, c: 1.5 } as unknown as Record<string, number>
    // The numbers in use are treated as absent (the table is broken), so a new one is 0.
    expect(assignRainbow(table, 'd')).toBe(0)
  })

  it('it is decided by the content only, not the table order (the same result for either representation)', () => {
    const tableA = { x: 0, y: 8 }
    const tableB = { y: 8, x: 0 }
    expect(assignRainbow(tableA, 'z')).toBe(assignRainbow(tableB, 'z'))
  })
})

describe('renderer side (rainbowVar / rainbowStyle) only converts the number', () => {
  it('turns the number into `var(--rainbow-N)`', () => {
    expect(rainbowVar(0)).toBe('var(--rainbow-0)')
    expect(rainbowVar(15)).toBe('var(--rainbow-15)')
  })

  it('null (no affiliation, no cwd) gets no color', () => {
    expect(rainbowVar(null)).toBeNull()
    expect(rainbowStyle(null)).toBeUndefined()
  })

  it('if there is a number, puts it on `--thread-accent`', () => {
    expect(rainbowStyle(6)).toEqual({ '--thread-accent': 'var(--rainbow-6)' })
  })
})
