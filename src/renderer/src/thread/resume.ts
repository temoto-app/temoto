/**
 * The interrupted-answer mark and resume (TODO 521, wave 26 bundle B). The mark itself is kept by main in `Thread.interrupted`
 * (main both sets and clears it). This file has only pure functions that decide how to show it and build the fixed resume text.
 *
 * - The mark at the right end of a list row (`rowBadgeOf`): awaiting approval > **the interrupted "!"** > the unread dot. Interrupted is stronger than unread
 *   (owner decision 2026-10-08).
 * - The resume button (`showsResume`): only when there is an interrupt mark and no turn is running now. Pressing it sends the fixed text
 *   (`resumePrompt`) as a normal send. No dialog is shown (167).
 */
import type { InterruptReason, SessionState, ThreadSummary } from '@shared/thread.js'
import type { UsageWindow } from '@shared/agent.js'
import type { UsageSnapshot } from '@shared/usage.js'
import type { Translate } from '../i18n/index.js'

/** States where a turn is running (or being stopped). The resume button is not shown. */
const TURN_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'starting',
  'running',
  'awaiting-approval',
  'stopping'
])

export type RowBadge = 'approval' | 'interrupted' | 'unread' | null

export function rowBadgeOf(summary: Pick<ThreadSummary, 'thread' | 'runtime'>): RowBadge {
  if (summary.runtime.pendingApprovals > 0 || summary.runtime.state === 'awaiting-approval') return 'approval'
  if (summary.thread.interrupted !== undefined) return 'interrupted'
  return summary.thread.unread ? 'unread' : null
}

export function showsResume(interrupted: InterruptReason | undefined, state: SessionState | undefined): boolean {
  return interrupted !== undefined && (state === undefined || !TURN_STATES.has(state))
}

/** The wording for the kind of interruption (the dictionary's `reason.interrupt-*`). */
export function interruptReasonLabel(reason: InterruptReason, t: Translate): string {
  return t(`reason.${reason}`)
}

/** The fixed text sent on resume. JA: "Interrupted midway due to {reason}. Check the interruption state and resume." (Japanese wording). */
export function resumePrompt(reason: InterruptReason, t: Translate): string {
  return t('thread.resume.prompt', { reason: interruptReasonLabel(reason, t) })
}

/**
 * The reset time (epoch seconds, TODO 628) used as the basis for "resume after reset". The `resetsAt` of the limit row itself has not been captured yet
 * (TODO 532), so it is chosen from the windows of the usage badge (317). Wave 29 code-review: always preferring the 5-hour window would
 * resume early at the 5-hour reset even though the 7-day limit has been hit. Use the `resetsAt` of the **windows that are used up** (usage 100% or more)
 * (the later one if both: nothing can be sent until both return), and if it is unknown which are used up, the later one of the known
 * windows. null if no window has a time (the button is not shown).
 */
export function limitResetsAtSec(
  snapshot: Pick<UsageSnapshot, 'fiveHour' | 'sevenDay'> | null | undefined
): number | null {
  if (snapshot === null || snapshot === undefined) return null
  const known = [snapshot.fiveHour, snapshot.sevenDay].filter(
    (window): window is UsageWindow & { readonly resetsAt: number } =>
      window !== undefined && window.resetsAt !== null
  )
  const exhausted = known.filter((window) => window.utilization >= 1)
  const pool = exhausted.length > 0 ? exhausted : known
  return pool.length === 0 ? null : Math.max(...pool.map((window) => window.resetsAt))
}
