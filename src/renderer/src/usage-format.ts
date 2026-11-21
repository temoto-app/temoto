/**
 * Pure functions for displaying usage limits (item 317). Independent of React and window (easy to test).
 *
 * - Ratios arrive as 0 to 1. The display is an integer % rounded to the nearest; the bar width is clamped to 0 to 100%.
 * - "Resets in 1h / 6d" is the difference between `resetsAt` (epoch seconds) and now. Under 1 hour it is minutes, under 1 day hours,
 *   otherwise days (all rounded down; only minutes are rounded up so that "0 minutes" is never shown).
 * - "n minutes ago" is the difference between the time main received the value (`receivedAt`, epoch milliseconds) and now.
 * - **A window past its `resetsAt` (`isWindowReset`) is treated as "reset"** (small observation in TODO 333-1,
 *   wave 17 bundle J): a stale ratio is not kept on display. Both the badge and the floating panel show "—" + "Reset" (the VS Code extension
 *   re-fetches the API so this state never occurs there; this matches its look).
 */
import type { UsageWindow } from '@shared/agent.js'
import type { Translate } from './i18n/index.js'

/** The % to display. Negative or NaN becomes 0. A reported value above the limit is shown as is (101% etc.). */
export function usagePercent(window: UsageWindow): number {
  const value = window.utilization * 100
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** The bar width (0 to 100). 0 once the window has passed (a stale ratio is not kept on display). */
export function usageBarWidth(window: UsageWindow, nowMs: number): number {
  if (isWindowReset(window.resetsAt, nowMs)) return 0
  return Math.min(100, usagePercent(window))
}

/** The % text ("13% used" / "—"). No ratio is shown once the window has passed. */
export function usagePercentLabel(window: UsageWindow, nowMs: number, t: Translate): string {
  if (isWindowReset(window.resetsAt, nowMs)) return t('usage.percentUnknown')
  return t('usage.percentUsed', { percent: usagePercent(window) })
}

/** Whether the window is past `resetsAt` (epoch seconds). `null` (time unknown) counts as not past. */
export function isWindowReset(resetsAt: number | null, nowMs: number): boolean {
  return resetsAt !== null && resetsAt - Math.floor(nowMs / 1000) <= 0
}

/** Time remaining until the window returns. `null` means the time is unknown (the row is not shown at all). "Reset" once it has passed. */
export function formatResetsIn(resetsAt: number | null, nowMs: number, t: Translate): string | null {
  if (resetsAt === null) return null
  if (isWindowReset(resetsAt, nowMs)) return t('usage.reset')
  const seconds = resetsAt - Math.floor(nowMs / 1000)
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return t('usage.resetsIn', { time: t('usage.unit.minutes', { count: minutes }) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('usage.resetsIn', { time: t('usage.unit.hours', { count: hours }) })
  return t('usage.resetsIn', { time: t('usage.unit.days', { count: Math.floor(hours / 24) }) })
}

/** When the value was received ("n minutes ago"). */
export function formatReceivedAgo(receivedAt: number, nowMs: number, t: Translate): string {
  const minutes = Math.floor((nowMs - receivedAt) / 60_000)
  if (minutes < 1) return t('usage.received.justNow')
  if (minutes < 60) return t('usage.received.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('usage.received.hours', { count: hours })
  return t('usage.received.days', { count: Math.floor(hours / 24) })
}

/**
 * Per-window parts of the BottomBar badge (TODO 377: passed before being assembled into one string, so that a small
 * bar can be added to the right of the text). No bar is shown when `barWidth` is `null`: a window that is `isWindowReset` does not
 * keep showing a stale ratio (same reason as `usageBarWidth`, see the section at the top of usage-format.ts).
 */
export interface UsageBadgePart {
  readonly key: 'fiveHour' | 'sevenDay'
  readonly label: string
  readonly barWidth: number | null
}

/** The BottomBar badge split per window. `[]` if there is no window at all. */
export function usageBadgeParts(
  windows: { readonly fiveHour?: UsageWindow; readonly sevenDay?: UsageWindow },
  nowMs: number,
  t: Translate
): readonly UsageBadgePart[] {
  const parts: UsageBadgePart[] = []
  if (windows.fiveHour !== undefined) {
    const reset = isWindowReset(windows.fiveHour.resetsAt, nowMs)
    parts.push({
      key: 'fiveHour',
      label: reset
        ? t('usage.badge.fiveHourReset')
        : t('usage.badge.fiveHour', { percent: usagePercent(windows.fiveHour) }),
      barWidth: reset ? null : usageBarWidth(windows.fiveHour, nowMs)
    })
  }
  if (windows.sevenDay !== undefined) {
    const reset = isWindowReset(windows.sevenDay.resetsAt, nowMs)
    parts.push({
      key: 'sevenDay',
      label: reset
        ? t('usage.badge.sevenDayReset')
        : t('usage.badge.sevenDay', { percent: usagePercent(windows.sevenDay) }),
      barWidth: reset ? null : usageBarWidth(windows.sevenDay, nowMs)
    })
  }
  return parts
}

/** The short BottomBar badge (`5h 11% · 7d 1%`). null if there is no window at all. A passed window is `5h —`. */
export function usageBadgeText(
  windows: { readonly fiveHour?: UsageWindow; readonly sevenDay?: UsageWindow },
  nowMs: number,
  t: Translate
): string | null {
  const parts = usageBadgeParts(windows, nowMs, t)
  return parts.length === 0 ? null : parts.map((part) => part.label).join(' · ')
}
