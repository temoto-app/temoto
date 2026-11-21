/**
 * The moment an answer finishes, moves ThreadPane to the head of the last answer (TODO 464, wave 23 bundle D, ARCHITECTURE.md 5.1.5).
 *
 * Pure functions without a DOM. ThreadPane reads dimensions from the DOM and passes them. What was decided (owner decision 2026-10-04):
 *
 * - **The moment of finishing = the time a `result` arrives by push for the displayed thread** (`turnEnded` in `threadStore`).
 *   It is not judged by `runtime.state` going `running → idle` (that cannot be told apart from stop, awaiting approval, restart).
 * - **Move only when it ended normally or with an error.** For a turn the user stopped (Esc stop, Cmd+Enter interrupt), the
 *   Adapter attaches `interrupted` (item 94, the same mark as the "interrupted" of 280-5 / 333), so we do not move.
 *   If the interrupt was not accepted and the whole process was stopped, no `result` arrives, so the mark does not advance in the first place.
 * - **The destination is the head of the last answer**: the start of the last parent body block in that turn (after the preceding `user` row).
 *   Consecutive parent bodies (with only rows that draw nothing between them) count as one block. A turn without a body (only tools /
 *   only an error) goes to the end.
 * - The position is the top edge plus room for the sticky question (TODO 355). If the answer fits on screen, the bottom edge is used
 *   (= pulling it to the top as far as the scrollable range allows, so no blank space is created).
 */
import type { AiosEvent } from '@shared/agent.js'
import type { TimelineItem } from './timeline.js'
import { JUMP_TOP_GAP_PX } from './jump.js'

/**
 * The estimated height (px) of the sticky question (TODO 355). A frame clipped at 2 lines (12px x 1.5 x 2 + 10px top and bottom).
 * The frame may not be shown yet at the moment of landing, so if shown its real size is used, otherwise this value is reserved.
 */
export const STICKY_RESERVE_PX = 46

/** The end of a turn in the displayed thread (`turnEnded` in `threadStore`). `seq` increases monotonically within a window. */
export interface TurnEnded {
  readonly threadId: string
  /** The event id of the `result` that arrived. */
  readonly eventId: string
  readonly seq: number
}

/** The id of the parent's last `result` in one push batch. Null if none. */
export function lastResultId(events: readonly AiosEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.kind === 'result' && event.actor === 'main' && event.parentToolUseId === undefined) return event.id
  }
  return null
}

/**
 * `turnEnded` after receiving one push batch (for one thread). Advances **only when a parent `result` arrives for the displayed thread**;
 * otherwise returns `prev` as is (the same reference too: the store judges the difference).
 */
export function nextTurnEnded(
  prev: TurnEnded | null,
  activeThreadId: string | null,
  threadId: string,
  events: readonly AiosEvent[]
): TurnEnded | null {
  if (threadId !== activeThreadId) return prev
  const ended = lastResultId(events)
  if (ended === null) return prev
  return { threadId, eventId: ended, seq: (prev?.seq ?? 0) + 1 }
}

export type FinishScrollPlan =
  /** Put the first row (`ev-<id>`) of the last answer block at the top edge. */
  | { readonly kind: 'answer'; readonly headId: string }
  /** A turn without a body: go to the end. */
  | { readonly kind: 'bottom' }

/** A row that shows nothing even when drawn (does not split a block). */
function invisible(item: TimelineItem): boolean {
  return item.kind === 'rate_limit' && item.notice === null
}

function isAnswer(item: TimelineItem): boolean {
  return item.kind === 'assistant' && item.actor === 'main'
}

/**
 * Where to move at the end of `resultId`. null if we do not move (interrupted, or that row is missing).
 */
export function finishScrollPlan(items: readonly TimelineItem[], resultId: string): FinishScrollPlan | null {
  const at = items.findIndex((item) => item.id === resultId)
  if (at < 0) return null
  const end = items[at]!
  if (end.kind !== 'result') return null
  if (end.result.interrupted === true) return null
  // The last parent body in that turn's range (after the preceding user message).
  let last = -1
  for (let i = at - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'user') break
    if (isAnswer(item)) {
      last = i
      break
    }
  }
  if (last < 0) return { kind: 'bottom' }
  let head = last
  for (let i = last - 1; i >= 0; i--) {
    const item = items[i]!
    if (isAnswer(item)) head = i
    else if (!invisible(item)) break
  }
  return { kind: 'answer', headId: items[head]!.id }
}

/**
 * The scrollTop that puts the block head (`headTop`, a coordinate inside the container) `reserve` px below the top edge.
 * Clamped to the scrollable range (0 to scrollHeight - clientHeight): if the answer fits, it becomes the bottom edge.
 */
export function finishScrollTop(
  headTop: number,
  box: { readonly scrollHeight: number; readonly clientHeight: number },
  reserve: number = STICKY_RESERVE_PX
): number {
  const max = Math.max(0, box.scrollHeight - box.clientHeight)
  const want = headTop - reserve - JUMP_TOP_GAP_PX
  return Math.min(max, Math.max(0, want))
}
