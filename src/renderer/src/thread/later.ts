/**
 * TODO 989: computing and showing the time for "send later" (pure functions). The entry is the menu next to the Composer's send button
 * (`LaterMenu.tsx`). The time is passed to main (`schedule.reserveLater`) as epoch ms.
 */
import { formatTimeOfDay } from '@shared/schedule.js'
import type { UsageSnapshot } from '@shared/usage.js'
import { limitResetsAtSec } from './resume.js'

/** The fixed margin after the limit resets (5 minutes, same as 628; owner decision 2026-10-25). */
export const LATER_LIMIT_DELAY_MS = 5 * 60_000
/** The cap for "N hours later" (1 week). */
export const LATER_MAX_HOURS = 24 * 7

/** N hours later. null for 0 or less, a non-number, or over the cap. */
export function laterAfterHours(now: number, hours: number): number | null {
  if (!Number.isFinite(hours) || hours <= 0 || hours > LATER_MAX_HOURS) return null
  return now + Math.round(hours * 3_600_000)
}

/** The next moment it is that time for "HH:MM" (the value of `<input type="time">`). Today if not yet passed today, tomorrow if already passed. */
export function laterAtTimeOfDay(now: number, value: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  if (match === null) return null
  const date = new Date(now)
  date.setHours(Number(match[1]), Number(match[2]), 0, 0)
  if (date.getTime() <= now) date.setDate(date.getDate() + 1)
  return date.getTime()
}

/** "After the limit resets": the reset of the usage badge (same `limitResetsAtSec` as 628) + 5 minutes. null if unknown (cannot be chosen). */
export function laterAfterLimit(snapshot: Pick<UsageSnapshot, 'fiveHour' | 'sevenDay'> | null | undefined): number | null {
  const sec = limitResetsAtSec(snapshot)
  return sec === null ? null : sec * 1000 + LATER_LIMIT_DELAY_MS
}

/** How the reservation time is shown. HH:MM if today, M/D HH:MM for another day. */
export function laterTimeLabel(at: number, now: number): string {
  const date = new Date(at)
  const time = formatTimeOfDay(date.getHours(), date.getMinutes())
  const today = new Date(now)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}
