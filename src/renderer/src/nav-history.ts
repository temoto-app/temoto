/**
 * The pure part of aios-wide "back / forward" (TODO 801, wave 38 bundle B, ARCHITECTURE 5.4 "global back / forward").
 * Touches neither the DOM nor stores, so `test/nav-history.test.ts` checks it directly. The wiring is in `navHistory.ts`.
 *
 * Same shape as the viewer's back / forward (`viewer-history.ts`, TODO 369): a list of "places visited" one level up, and the current position (`index`).
 *
 * - **1 step = switching the conversation only** (TODO 1257, owner decision 2026-11-17). Switching the sidebar mode
 *   (ActivityBar) and picking items in Files / Search are not steps, and the mode is not stored in a step (going back
 *   keeps the current mode). Files has its own per-conversation history (`filer-history.ts`).
 * - **Only the position is pushed**: the conversation / the viewer file. Pane width, scroll and drafts are not pushed (the per-conversation
 *   memory restores them at the destination). Switching the viewer file within the same conversation is not a step; it only rewrites
 *   `viewerUri` of the current step (`followViewer`, the job of the viewer-side history). So on conversation A -> B, A's step keeps the
 *   viewer file that was open in A, and going back brings the viewer back too.
 * - **Coalescing rapid presses**: a conversation step sets `rapid`. If the previous step is `rapid` and within 1 second, it is replaced
 *   (so holding ↑↓ in the list does not fill the history. The position before the presses is kept).
 * - Moving anew from a position reached by going back discards the later steps (same as a browser). The limit is 50 steps.
 * - A position without a conversation (startup before any conversation is picked, item 80) is not kept as a step:
 *   the next conversation step replaces it, and `stepNav` never lands on it.
 * - **A destination that no longer exists is skipped silently** (`isDead` of `stepNav`): steps for deleted / trashed conversations.
 * - Moves opened by back / forward are not recorded (the marker in `navigating.ts`, shared with the viewer / Files histories). Not kept across restarts (memory only).
 */

export interface NavPosition {
  readonly threadId: string | null
  readonly viewerUri: string | null
}

export interface NavEntry extends NavPosition {
  /** Time (ms) when this step was pushed (last replaced). */
  readonly at: number
  /** Whether this step may be coalesced by rapid presses (one pushed by a conversation switch). */
  readonly rapid: boolean
}

export interface NavHistory {
  readonly entries: readonly NavEntry[]
  /** The current step. -1 if empty. */
  readonly index: number
}

export const EMPTY_NAV: NavHistory = { entries: [], index: -1 }

/** Window (ms) in which rapid presses are coalesced into 1 step (1 second, the same as the viewer's history). */
export const NAV_COALESCE_MS = 1000

/** Maximum number of steps kept. The oldest are dropped first. */
export const NAV_LIMIT = 50

function samePosition(a: NavPosition, b: NavPosition): boolean {
  return a.threadId === b.threadId && a.viewerUri === b.viewerUri
}

function toEntry(position: NavPosition, now: number, rapid: boolean): NavEntry {
  return {
    threadId: position.threadId,
    viewerUri: position.viewerUri,
    at: now,
    rapid
  }
}

/**
 * If there is no step at the current position, place one as the first step. If there is, rewrite the current step's position as a move
 * within the same conversation (switching the viewer file). If nothing changes, return the same value (so the store write can be skipped).
 */
export function followViewer(history: NavHistory, position: NavPosition, now: number): NavHistory {
  const current = history.entries[history.index]
  if (current === undefined) return { entries: [toEntry(position, now, false)], index: 0 }
  if (samePosition(current, position)) return history
  const entries = history.entries.slice()
  entries[history.index] = { ...current, ...position }
  return { entries, index: history.index }
}

/**
 * Push 1 step (a conversation switch). It is subject to coalescing (`rapid`). If the conversation does not change, it is not a step;
 * it only rewrites the current step's viewer (`followViewer`. The same value if nothing changes).
 */
export function recordStep(history: NavHistory, position: NavPosition, now: number): NavHistory {
  const current = history.entries[history.index]
  if (current === undefined || current.threadId === position.threadId) return followViewer(history, position, now)
  const entry = toEntry(position, now, true)
  const atTip = history.index === history.entries.length - 1
  // A position without a conversation is not worth going back to: replace it instead of stacking on it.
  if (current.threadId === null && atTip) {
    const entries = history.entries.slice()
    entries[history.index] = entry
    return { entries, index: history.index }
  }
  const coalesce = current.rapid && atTip && now - current.at >= 0 && now - current.at < NAV_COALESCE_MS
  if (coalesce) {
    const previous = history.entries[history.index - 1]
    // Came back quickly as A -> B -> A: replacing would put the same conversation in 2 steps, so collapse the current step
    // (the previous step keeps its viewer file; the restore that follows re-syncs it via `followViewer`).
    if (previous !== undefined && previous.threadId === position.threadId) {
      return { entries: history.entries.slice(0, history.index), index: history.index - 1 }
    }
    const entries = history.entries.slice(0, history.index + 1)
    entries[history.index] = entry
    return { entries, index: history.index }
  }
  // Moving from a position reached by going back discards the later steps.
  const entries = [...history.entries.slice(0, history.index + 1), entry]
  const overflow = Math.max(0, entries.length - NAV_LIMIT)
  const trimmed = overflow === 0 ? entries : entries.slice(overflow)
  return { entries: trimmed, index: trimmed.length - 1 }
}

export type NavDirection = 'back' | 'forward'

export interface NavStep {
  readonly history: NavHistory
  readonly entry: NavEntry
}

/**
 * The destination of back / forward. null if it cannot go. Steps where `isDead` is true (deleted conversations) and steps without
 * a conversation are skipped silently, and it moves on to the next valid step. Skipped steps stay in the list.
 */
export function stepNav(
  history: NavHistory,
  direction: NavDirection,
  isDead: (entry: NavEntry) => boolean
): NavStep | null {
  const delta = direction === 'back' ? -1 : 1
  for (let target = history.index + delta; target >= 0 && target < history.entries.length; target += delta) {
    const entry = history.entries[target]
    if (entry === undefined || entry.threadId === null || isDead(entry)) continue
    return { history: { entries: history.entries, index: target }, entry }
  }
  return null
}

export function canStepNav(history: NavHistory, direction: NavDirection, isDead: (entry: NavEntry) => boolean): boolean {
  return stepNav(history, direction, isDead) !== null
}
