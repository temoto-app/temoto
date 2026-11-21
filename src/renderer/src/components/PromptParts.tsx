/**
 * Shared parts of the approval screens shown in the Composer's place (question `QuestionPrompt`, permission and plan `ApprovalPrompt`)
 * (items 166 / 182). Both import it, so it is split out here to keep them from importing each other.
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import type { ApprovalItem } from '@shared/thread.js'
import { useT } from '../i18n/index.js'

/** Interval for refreshing the dwell-time display. An approval may wait for minutes to hours. */
export const PROMPT_TICK_MS = 1000
/** Past this, the prompt is made prominent. An unanswered approval stops the session (4.2). */
export const PROMPT_STALE_MS = 60_000

/**
 * Handles two chores at the moment the screen appears (shared by question, permission and plan).
 *
 * - If the user was looking at the end, put the view back at the end (the timeline shrinks when it appears but no scroll event comes,
 *   so ThreadPane's `pinned` does not move. This keeps the preceding message, which says why we are asking, from being hidden).
 * - Move focus to the frame so it can receive key input. Focus held by the hidden Composer has dropped to body,
 *   so take it only when it is there (or inside this pane). Do not take it while the user is typing in a viewer or a search field.
 */
export function usePromptFrame(frameRef: React.RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const frame = frameRef.current
    const body = frame?.closest('.thread-pane')?.querySelector<HTMLElement>('.thread-body') ?? null
    if (frame === null || frame === undefined || body === null) return
    const slack = body.scrollHeight - body.scrollTop - body.clientHeight
    if (slack < 80 + frame.offsetHeight) body.scrollTop = body.scrollHeight
  }, [frameRef])
  useEffect(() => {
    const active = document.activeElement
    const frame = frameRef.current
    if (frame === null) return
    if (active === null || active === document.body || frame.closest('.thread-pane')?.contains(active) === true) {
      frame.focus({ preventScroll: true })
    }
  }, [frameRef])
}

/** Dwell time (advanced every second). Kept from going negative by clock skew. */
export function useHeld(requestedAt: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), PROMPT_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, now - requestedAt)
}

/**
 * For a subagent's tool call, shows "subagent: <heading>" (item 93, spike 19). While running in parallel,
 * several approvals can pile up from one thread at once, so this states which subagent the request is from. The question screen uses it too.
 */
export function SubtaskLabel({ item }: { item: ApprovalItem }): React.JSX.Element | null {
  const t = useT()
  if (item.subtask === null) return null
  return (
    <div className="approval-subtask" title={item.subtask.description}>
      {t('approval.subtask', { description: item.subtask.description })}
    </div>
  )
}
