/**
 * "Collapse rows that have been inactive for 5 or more days" in the thread list (TODO 659, ARCHITECTURE 4.3 "sorting for display").
 *
 * The number of days is a setting (`threads.collapseOldAfterDays`, owned by main). **0 means "do not collapse"** (owner decision 2026-10-10).
 * One for the whole app, and when it changes it goes to all windows (the same light form as `AutoSaveSettings`). The staleness judgment and the collapsing sort themselves are in
 * `src/renderer/src/thread-sort.ts` (pure functions, `test/thread-sort.test.ts`) - here is only the value's shape and validation.
 */

/** Default 5 days. VS Code has no equivalent setting (the same idea as Slack's "view"). */
export const DEFAULT_COLLAPSE_OLD_AFTER_DAYS = 5

/**
 * The query key main attaches when opening a window (the same form as `THEME_QUERY_KEY` / `LOCALE_QUERY_KEY`, a code-review fix).
 * If it waited for the IPC round trip (`get()`), the first render right after launch would build the list with the default (5 days) before knowing this setting,
 * so even when the user had changed it to 0 (do not collapse), it would look collapsed for a moment every time. main can read this value synchronously at launch
 * (the constructor of `ThreadCollapsePreference` reads it with `settings.readTyped`), so it is passed on the window's URL.
 */
export const THREAD_COLLAPSE_QUERY_KEY = 'aios-thread-collapse'

/** 0 = do not collapse. */
export const MIN_COLLAPSE_OLD_AFTER_DAYS = 0

/** 1 year. More than this is meaningless (values so large that they cannot be told apart from disabling are rejected). */
export const MAX_COLLAPSE_OLD_AFTER_DAYS = 365

/** An integer within range. Broken values, fractions and negatives are rejected. */
export function isCollapseOldAfterDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_COLLAPSE_OLD_AFTER_DAYS &&
    value <= MAX_COLLAPSE_OLD_AFTER_DAYS
  )
}

/** Out-of-range values are pulled to the edge and rounded to an integer. null if not a number (the caller falls back to the default). */
export function clampCollapseOldAfterDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(
    MAX_COLLAPSE_OLD_AFTER_DAYS,
    Math.max(MIN_COLLAPSE_OLD_AFTER_DAYS, Math.round(value))
  )
}
