/**
 * The format of the row at the end of a turn (`timeline-note result`) (TODO 466, wave 23 bundle D, ARCHITECTURE.md 5.1).
 *
 * - **The total time** (`formatTurnDuration`): under 60 seconds it is seconds as before in 0.1 s steps (e.g. 12.3 s), at 60 seconds or more
 *   minutes and seconds (e.g. 12 min 34 s), at 1 hour or more hours and minutes (e.g. 1 h 2 min) (the Japanese wording is in the dictionary). The value is `durationMs` of the `result` (the turn's duration reported by the CLI).
 * - **When it ended** (`formatEndedAgo`): the `ts` of the `result` event (the time main received the row, `ctx.now()` in `parse.ts`).
 *   Under 1 minute "just now", then "n minutes ago", "n hours ago", "n days ago", and **3 days or more ago is a date**.
 *   The date format follows the display language, and EN is `Oct 4, 10:27 PM` (aligned with the BottomBar badge of TODO 457).
 * - **The estimate of when the prompt cache expired** (`lastTurnCache` / `cacheExpired`): last turn only. The lifetime is put by the Adapter in
 *   `result.cacheTtlMs` as a neutral number (constraint 6). A turn that did not write it (omitted) inherits the previous value of the same thread.
 *   If it is nowhere, no estimate is shown. **Cost and token counts are not shown** (constraint 4 / item 165).
 *
 * Language-dependent words are in the dictionary (`timeline.result.*` / `time.*`). Only the date is left to `Intl.DateTimeFormat`.
 */
import type { Locale } from '@shared/locale.js'
import type { Translate } from '../i18n/index.js'
import type { TimelineItem } from './timeline.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** A turn that ended more than this many days ago is shown as a date, not "n days ago" (owner decision 2026-10-04). */
export const ENDED_DATE_AFTER_DAYS = 3

/** The duration of a turn. The boundaries are decided by the displayed value (59.96 seconds is "1 min 0 s", not "60 s"). */
export function formatTurnDuration(ms: number, t: Translate): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const tenths = Math.round(safe / 100) / 10
  if (tenths < 60) return t('timeline.result.seconds', { n: tenths })
  const seconds = Math.round(safe / 1000)
  if (seconds < 3600) {
    return t('timeline.result.minutes', { m: Math.floor(seconds / 60), s: seconds % 60 })
  }
  const minutes = Math.floor(seconds / 60)
  return t('timeline.result.hours', { h: Math.floor(minutes / 60), m: minutes % 60 })
}

/** Normalizes the thin space (U+202F) and non-breaking spaces that `Intl` inserts before the time to ordinary spaces. */
function normalizeSpaces(text: string): string {
  return text.replace(/[\u00a0\u202f\u2009]/g, ' ')
}

function intlLocale(locale: Locale): string {
  return locale === 'ja' ? 'ja-JP' : 'en-US'
}

/**
 * The date of a turn that ended 3 or more days ago. EN is `Oct 4, 10:27 PM`, JA is `10/4 22:27`.
 * The year is added only when it differs from the current year.
 */
export function formatEndedDate(ts: number, locale: Locale, now = Date.now()): string {
  const at = new Date(ts)
  const sameYear = at.getFullYear() === new Date(now).getFullYear()
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    ...(sameYear ? {} : { year: 'numeric' as const }),
    month: locale === 'ja' ? 'numeric' : 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: locale !== 'ja'
  })
  return normalizeSpaces(format.format(at))
}

/** The exact date and time shown in the bubble (down to the second). */
export function formatExactDateTime(ts: number, locale: Locale): string {
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    year: 'numeric',
    month: locale === 'ja' ? 'numeric' : 'short',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: locale !== 'ja'
  })
  return normalizeSpaces(format.format(new Date(ts)))
}

/** "When it ended". A future time (clock skew) is rounded to "just now". */
export function formatEndedAgo(ts: number, now: number, locale: Locale, t: Translate): string {
  const elapsed = now - ts
  if (elapsed < MINUTE_MS) return t('time.justNow')
  if (elapsed < HOUR_MS) return t('time.minutesAgo', { n: Math.floor(elapsed / MINUTE_MS) })
  if (elapsed < DAY_MS) return t('time.hoursAgo', { n: Math.floor(elapsed / HOUR_MS) })
  const days = Math.floor(elapsed / DAY_MS)
  if (days < ENDED_DATE_AFTER_DAYS) {
    return t(days === 1 ? 'time.daysAgo.one' : 'time.daysAgo.other', { n: days })
  }
  return formatEndedDate(ts, locale, now)
}

/** The end row of the last turn and the cache lifetime at that time (including inheritance). null if the lifetime is unknown. */
export interface LastTurnCache {
  readonly resultId: string
  readonly ttlMs: number
}

/**
 * The last `result` row in the timeline and the cache lifetime at that point. If that turn did not write it (omitted), the previous `result` of
 * the same thread is traced back and the last known lifetime is inherited. null if there is no `result`, or the lifetime is
 * nowhere (old rows, backends that do not report it, only in an earlier page).
 */
export function lastTurnCache(items: readonly TimelineItem[]): LastTurnCache | null {
  let resultId: string | null = null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind !== 'result') continue
    if (resultId === null) resultId = item.id
    const ttl = item.result.cacheTtlMs
    if (typeof ttl === 'number' && ttl > 0) return { resultId, ttlMs: ttl }
  }
  return null
}

/** Whether the lifetime has passed since it ended. */
export function cacheExpired(endedAt: number, ttlMs: number, now: number): boolean {
  return now - endedAt >= ttlMs
}

/** The display of the lifetime ("1 hour", "5 minutes"; the Japanese wording). Inserted into the bubble text. */
export function formatCacheTtl(ttlMs: number, t: Translate): string {
  if (ttlMs >= HOUR_MS && ttlMs % HOUR_MS === 0) return t('timeline.result.ttlHours', { n: ttlMs / HOUR_MS })
  return t('timeline.result.ttlMinutes', { n: Math.max(1, Math.round(ttlMs / MINUTE_MS)) })
}
