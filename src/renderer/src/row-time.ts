/**
 * The "last updated time" shown at the right end of a thread list row (TODO 490, wave 25 bundle C, ARCHITECTURE.md 4.3).
 * Independent of the DOM, React and stores (`test/row-time.test.ts`). `formatAgo` in `Sidebar.tsx` is for the status bar and
 * MCP settings and has no stage that switches to a date, and importing `Sidebar` would pull in the theme store, so this is kept separate.
 *
 * - Under 1 minute "just now" / under 1 hour "n minutes ago" / under 1 day "n hours ago" / under 3 days "n days ago" / **3 days or more: a date**.
 *   The words are the dictionary's `time.*` (the same keys as `formatEndedAgo` in the turn-end line `thread/turn-end.ts`).
 * - The date is **month/day for this year, year/month/day for last year or earlier** (owner decision 2026-10-06). No time of day. The format follows the display
 *   language via `Intl.DateTimeFormat` (JA `10/2` / `2025/10/2`, EN `10/2` / `10/2/2025`).
 * - The input is `threadRecency` (= `lastEventAt ?? createdAt`, the key of the list order). `Thread.updatedAt` also advances on mark-read, rename, and
 *   strict-mode switches (the per-column UPDATE in `store.ts`), so just opening a thread would make it "just now".
 *
 * **Re-rendering uses one clock for the whole list** (`subscribeRowClock` / `rowClockNow`, every `ROW_CLOCK_TICK_MS`).
 * A row's time string is built inside the row (`useSyncExternalStore`) and is not put into the ordering selector. This keeps the
 * promise of not reordering on high-frequency pushes (items 75 / 88, the comment at the head of `thread-sort.ts`).
 */
import type { Locale } from '@shared/locale.js'
import type { Translate } from './i18n/index.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
/** Exported because TODO 659 also uses it (day counts at the collapse boundary). */
export const DAY_MS = 24 * HOUR_MS

/** Older than this many days is shown as a date rather than "n days ago". */
export const ROW_DATE_AFTER_DAYS = 3

/** Tick of the list clock. "n minutes ago" is that coarse, so 30 seconds suffices (TODO 490: 30-60 seconds). */
export const ROW_CLOCK_TICK_MS = 30_000

function intlLocale(locale: Locale): string {
  return locale === 'ja' ? 'ja-JP' : 'en-US'
}

/** The date for 3 days or more ago. Month/day for this year, year/month/day for last year or earlier (both numeric). */
export function formatRowDate(at: number, locale: Locale, now: number): string {
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...(sameYear ? {} : { year: 'numeric' as const }),
    month: 'numeric',
    day: 'numeric'
  }).format(date)
}

/** The text at the right end of a row. An empty string for a row with no time or a broken one (the element itself is not drawn). The future (clock skew) is "just now". */
export function formatRowTime(at: number, now: number, locale: Locale, t: Translate): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const elapsed = now - at
  if (elapsed < MINUTE_MS) return t('time.justNow')
  if (elapsed < HOUR_MS) return t('time.minutesAgo', { n: Math.floor(elapsed / MINUTE_MS) })
  if (elapsed < DAY_MS) return t('time.hoursAgo', { n: Math.floor(elapsed / HOUR_MS) })
  const days = Math.floor(elapsed / DAY_MS)
  if (days < ROW_DATE_AFTER_DAYS) {
    return t(days === 1 ? 'time.daysAgo.one' : 'time.daysAgo.other', { n: days })
  }
  return formatRowDate(at, locale, now)
}

// ---- One clock for the list (the entry point of `useSyncExternalStore`) ----

let clockNow = Date.now()
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

/**
 * Subscribe to the clock. The first subscriber starts the tick, and it stops when the last subscriber leaves (one regardless of how many rows).
 * It re-reads the current time on start: even if a render before the subscription read a stale value, `useSyncExternalStore`
 * re-reads the value right after subscribing and re-renders.
 */
export function subscribeRowClock(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === undefined) {
    clockNow = Date.now()
    timer = setInterval(() => {
      clockNow = Date.now()
      for (const l of [...listeners]) l()
    }, ROW_CLOCK_TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** The clock's current value. Returns the same number between ticks (`useSyncExternalStore`'s getSnapshot must be stable). */
export function rowClockNow(): number {
  return clockNow
}

/** For tests: whether the clock is ticking. */
export function rowClockRunning(): boolean {
  return timer !== undefined
}
