/**
 * The "assignment in order of appearance" of the working directory's rainbow colors (item 108, ARCHITECTURE.md 4.3 "working
 * directory color"). **Pure functions. It does not hold the table itself (which cwd has which number)** -
 * the caller (main's `RainbowRegistry`, `src/main/session/rainbow.ts`) passes the table persisted in
 * `app_settings` and this just returns "the next number to give this key".
 *
 * Rules (owner decision of TODO 108):
 * - If given a key already in the table, return its value as is (idempotent).
 * - While there are unused numbers, pick the one farthest from the numbers already used on the hue circle
 *   (the distance treating 0-{@link RAINBOW_COLORS} as a ring) (orange after blue, etc.). The first one is 0
 *   (with no used numbers there is no distance to measure, so it is a fixed starting point).
 * - When all are used up, the number with the fewest uses (the count of cwds that have the same number in the table).
 *   Ties go to the lower number (deterministic).
 *
 * The number of colors is not increased (stays at 16, decided in a discussion on 2026-09-26) - on a thin vertical line adjacent hues
 * cannot be told apart, so more colors would only add colors that "do not collide but cannot be told apart".
 */
import { RAINBOW_COLORS } from '@shared/thread.js'

export { RAINBOW_COLORS }

function circularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b)
  return Math.min(diff, RAINBOW_COLORS - diff)
}

/** Counts only the integers within range among the table's values (broken values are ignored). */
function usedCounts(table: Readonly<Record<string, number>>): { counts: number[]; used: Set<number> } {
  const counts = new Array<number>(RAINBOW_COLORS).fill(0)
  const used = new Set<number>()
  for (const value of Object.values(table)) {
    if (!Number.isInteger(value) || value < 0 || value >= RAINBOW_COLORS) continue
    counts[value] = (counts[value] ?? 0) + 1
    used.add(value)
  }
  return { counts, used }
}

/**
 * The color number to give `key` (the case-folded cwd). If it is already in the table, just return it.
 * For a new key, pick one following the rules above and return it (**the table is not modified** - the caller
 * uses the return value to update and persist the table).
 */
export function assignRainbow(table: Readonly<Record<string, number>>, key: string): number {
  const existing = table[key]
  if (existing !== undefined) return existing

  const { counts, used } = usedCounts(table)
  if (used.size === 0) return 0

  const unused: number[] = []
  for (let i = 0; i < RAINBOW_COLORS; i += 1) {
    if (!used.has(i)) unused.push(i)
  }

  if (unused.length > 0) {
    let best = unused[0] as number
    let bestDistance = -1
    for (const candidate of unused) {
      let minDistance = RAINBOW_COLORS
      for (const u of used) {
        const distance = circularDistance(candidate, u)
        if (distance < minDistance) minDistance = distance
      }
      // `unused` is in ascending order, so a plain `>` makes "ties go to the lower number".
      if (minDistance > bestDistance) {
        bestDistance = minDistance
        best = candidate
      }
    }
    return best
  }

  // All used up: the number with the fewest uses. Ties go to the lower number.
  let best = 0
  let bestCount = counts[0] as number
  for (let i = 1; i < RAINBOW_COLORS; i += 1) {
    const count = counts[i] as number
    if (count < bestCount) {
      bestCount = count
      best = i
    }
  }
  return best
}
