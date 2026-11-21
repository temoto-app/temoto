/**
 * Rainbow colors per working directory (ARCHITECTURE.md 4.3 "working directory color", TODO 50 / 58 / 108).
 *
 * **Since item 108 (2026-09-27), main decides the color.** From the cwd, main fixes
 * `Thread.rainbow` (0 to {@link RAINBOW_COLORS} - 1, or null for no affiliation / no cwd) with an
 * assignment in order of appearance (`src/main/session/rainbow.ts`) and hands it over. What remains here is
 * a thin function that turns that number into `var(--rainbow-N)`; it holds no hash and no "is it the scratch area" check
 * (main's `threadCwdName` / `RainbowRegistry` already decided those).
 *
 * The FNV-1a hash that used to be here (`fnv1a32` / `rainbowIndex` / `rainbowSeed`) was removed:
 * the guarantee that the same cwd gets the same color is in the persistence of the table (`app_settings`) itself,
 * so keeping a "fallback for when it breaks" on the renderer side has no real benefit (`Thread.rainbow` is a field main
 * always fixes and hands over, and by type it is only `number | null`).
 */
import { RAINBOW_COLORS } from '@shared/thread.js'

export { RAINBOW_COLORS }

/** `var(--rainbow-N)` to pass to an inline style. null when no color is applied (null). */
export function rainbowVar(index: number | null): string | null {
  return index === null ? null : `var(--rainbow-${index})`
}

/**
 * The style passed to `.thread-row` / `.thread-header`. CSS has the default for the unspecified case (no cwd, no affiliation) via
 * `var(--thread-accent, …)`, so for null nothing is passed.
 */
export function rainbowStyle(index: number | null): React.CSSProperties | undefined {
  const value = rainbowVar(index)
  if (value === null) return undefined
  return { '--thread-accent': value } as React.CSSProperties
}
