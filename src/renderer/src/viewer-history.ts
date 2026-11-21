/**
 * The pure part of ViewerPane's "Back / Forward" (TODO 369, wave 20 bundle D, ARCHITECTURE 5.4 "viewer back / forward").
 * It touches neither the DOM nor the store, so `test/viewer-history.test.ts` tests it directly. The wiring is in `viewerHistory.ts`.
 *
 * Same shape as the browser / VS Code Go Back / Go Forward: a list of opened files and the current position (`index`).
 *
 * - **One step = the viewer's file changed** (tree, search, up/down keys, the gateway's `openFile`, a link in the body,
 *   restoring the memory when switching threads). Opening the same URI again adds no step (only the search term is replaced).
 * - **Consecutive opens by the up/down keys (item 356) within 1 second are merged into one step.** If the previous step was also by the keys and within 1 second,
 *   it is replaced (holding the key does not fill the history with intermediate files). The first step (the file before pressing) stays.
 * - Opening something new from a position reached by going back drops the later steps (same as a browser).
 * - Closing (the close button / `select(null)`) is not a step. The temporary diff view (item 104, has no URI) is not recorded either -
 *   the caller looks only at `selectedUri`, so it structurally cannot get in.
 * - **Kept in main per conversation (TODO 772, the latest 50 steps).** See `toSnapshot` / `fromSnapshot` / `adoptStored` / `ViewerHistoryWriter` below.
 *   It survives closing the app and is read back from main when the thread is opened.
 * - **The display position per document (TODO 1146).** The position the viewer reported is held per URI in `positions` (`setPosition`),
 *   and returned when going back to that document with back / forward (`position` of `stepHistory`). The same URI in several steps gets the same position.
 *   It is kept in main along with the history (the keys are only the steps' URIs - narrowed in `toSnapshot`).
 * - **Web pages (TODO 400) use the same list.** Opening a URL or moving via a link inside the page is one step; the resulting URL of what we loaded
 *   (redirects, a trailing `/`) and in-page moves (`#`, pushState) rewrite the current step with `replace`.
 *   The page's own `navigationHistory` is not used (the default of TODO 411).
 */

import type { ViewerHistorySnapshot } from '@shared/viewer-history.js'
import type { ViewerScrollPosition } from '@shared/plugin.js'
import {
  positionOf,
  prunePositions,
  samePosition,
  type ViewerPositionTable
} from '@shared/viewer-position.js'

export interface HistoryEntry {
  readonly uri: string
  /** The in-file search term (TODO 56). Restored over the same range as the viewer's memory (item 63). */
  readonly highlight: string | null
  /** The time (ms) this step was pushed (last replaced). Used for the 1-second merge. */
  readonly at: number
  /** Whether this step was pushed by consecutive opens with the up/down keys. Only such a step can be merged. */
  readonly byKeys: boolean
}

export interface ViewerHistory {
  readonly entries: readonly HistoryEntry[]
  /** The current step. -1 if empty. */
  readonly index: number
  /**
   * The display position per document (TODO 1146). The key is the URI. Omitted if none. Even when steps are dropped it stays in memory
   * (opening the same document again gives the same position), and is narrowed to the steps' URIs when sent to main (`toSnapshot`).
   */
  readonly positions?: ViewerPositionTable
}

export const EMPTY_HISTORY: ViewerHistory = { entries: [], index: -1 }

/** The window in which consecutive up/down-key opens are merged into one step (the default of TODO 378). */
export const HISTORY_COALESCE_MS = 1000

/** The maximum number of steps kept per thread (50, same as the VS Code default). The oldest are dropped first. */
export const HISTORY_LIMIT = 50

export interface VisitInput {
  readonly uri: string
  readonly highlight: string | null
  readonly now: number
  /** A consecutive open by the up/down keys (item 356). */
  readonly byKeys: boolean
  /**
   * The web page's "replace the current step" (TODO 400: the resulting URL of what we loaded, redirects, in-page moves).
   * Rewrites the current step to the new URL and keeps the later steps (so "forward" is not lost when re-reading at a position reached by going back).
   */
  readonly replace?: boolean
}

/** Carries the original history's display positions (TODO 1146) over to the result of changing steps. */
function carryPositions(from: ViewerHistory, next: ViewerHistory): ViewerHistory {
  if (next === from || from.positions === undefined) return next
  return { ...next, positions: from.positions }
}

/** A file was opened (= one step). Returns the same value if nothing changed (so a store write can be skipped). */
export function recordVisit(history: ViewerHistory, visit: VisitInput): ViewerHistory {
  return carryPositions(history, recordStep(history, visit))
}

function recordStep(history: ViewerHistory, visit: VisitInput): ViewerHistory {
  const current = history.entries[history.index]
  const entry: HistoryEntry = {
    uri: visit.uri,
    highlight: visit.highlight,
    at: visit.now,
    byKeys: visit.byKeys
  }
  if (current !== undefined && current.uri === visit.uri) {
    // Same file: no new step. Only the search term takes the newer one (holding the same value as the memory, item 63).
    if (current.highlight === visit.highlight) return history
    return replaceAt(history, history.index, { ...current, highlight: visit.highlight })
  }
  if (visit.replace === true && current !== undefined) {
    const entries = history.entries.slice()
    entries[history.index] = entry
    return { entries, index: history.index }
  }
  const atTip = history.index === history.entries.length - 1
  const coalesce =
    current !== undefined &&
    visit.byKeys &&
    current.byKeys &&
    atTip &&
    visit.now - current.at >= 0 &&
    visit.now - current.at < HISTORY_COALESCE_MS
  if (coalesce) {
    const previous = history.entries[history.index - 1]
    // Went down then up and came back to the previous file: replacing would put the same file in two adjacent steps, so collapse the current step.
    if (previous !== undefined && previous.uri === visit.uri) {
      return { entries: history.entries.slice(0, history.index), index: history.index - 1 }
    }
    return replaceAt(history, history.index, entry)
  }
  // Opening from a position reached by going back drops the later steps.
  const kept = history.entries.slice(0, history.index + 1)
  const entries = [...kept, entry]
  const overflow = Math.max(0, entries.length - HISTORY_LIMIT)
  const trimmed = overflow === 0 ? entries : entries.slice(overflow)
  return { entries: trimmed, index: trimmed.length - 1 }
}

function replaceAt(history: ViewerHistory, index: number, entry: HistoryEntry): ViewerHistory {
  const entries = history.entries.slice(0, index + 1)
  entries[index] = entry
  return { entries, index }
}

export type HistoryDirection = 'back' | 'forward'

export interface HistoryStep {
  readonly history: ViewerHistory
  readonly entry: HistoryEntry
  /** The position previously viewed in the destination document (TODO 1146). null if unknown (from the top). */
  readonly position: ViewerScrollPosition | null
}

/**
 * The destination of back / forward. null if it cannot go.
 *
 * `currentUri` is the file being shown. **When the viewer is closed (null) it does not move** (there is no heading button either).
 * If the file being shown differs from the history's current step (a recording mismatch), it first pushes that as a step and then moves -
 * so "back" does not skip the file being shown.
 */
export function stepHistory(
  history: ViewerHistory,
  currentUri: string | null,
  direction: HistoryDirection
): HistoryStep | null {
  if (currentUri === null) return null
  const synced =
    history.entries[history.index]?.uri === currentUri
      ? history
      : recordVisit(history, { uri: currentUri, highlight: null, now: 0, byKeys: false })
  const target = synced.index + (direction === 'back' ? -1 : 1)
  const entry = synced.entries[target]
  if (entry === undefined) return null
  return {
    history: carryPositions(synced, { entries: synced.entries, index: target }),
    entry,
    position: positionOf(synced.positions, entry.uri) ?? null
  }
}

/**
 * Remembers the display position the viewer reported (TODO 1146). A URI that is not among the history's steps is not remembered (it could never be a back / forward
 * destination, and a value from an untrusted viewer must not bloat the table). Returns the same value if nothing changed.
 */
export function setPosition(history: ViewerHistory, uri: string, position: ViewerScrollPosition): ViewerHistory {
  if (!history.entries.some((entry) => entry.uri === uri)) return history
  if (samePosition(positionOf(history.positions, uri), position)) return history
  return { ...history, positions: { ...history.positions, [uri]: position } }
}

/** Whether the heading buttons are enabled or disabled. */
export function canStep(
  history: ViewerHistory,
  currentUri: string | null,
  direction: HistoryDirection
): boolean {
  return stepHistory(history, currentUri, direction) !== null
}

// Per-conversation persistence (TODO 772, ARCHITECTURE.md 5.3)

/** The form kept in main (it holds no `at` / `byKeys`). Validating steps and truncating to 50 steps is main's job (`viewer-history.ts`). */
export function toSnapshot(history: ViewerHistory): ViewerHistorySnapshot {
  const snapshot: ViewerHistorySnapshot = {
    entries: history.entries.map((entry) => ({ uri: entry.uri, highlight: entry.highlight })),
    index: history.index
  }
  // The display positions (TODO 1146) are limited to the steps' URIs. Omitted if none (same shape as before TODO 1146).
  const positions = prunePositions(history.positions, history.entries.map((entry) => entry.uri))
  return positions === undefined ? snapshot : { ...snapshot, positions }
}

/** Steps read back are not subject to the 1-second merge (`byKeys: false`, `at: 0`). */
export function fromSnapshot(snapshot: ViewerHistorySnapshot): ViewerHistory {
  const entries = snapshot.entries.map((entry) => ({
    uri: entry.uri,
    highlight: entry.highlight,
    at: 0,
    byKeys: false
  }))
  const index = Math.min(Math.max(snapshot.index, entries.length === 0 ? -1 : 0), entries.length - 1)
  const positions = prunePositions(snapshot.positions, entries.map((entry) => entry.uri))
  return positions === undefined ? { entries, index } : { entries, index, positions }
}

/**
 * How to reconcile the history read back with the renderer's current history. It returns the new history; **null means "keep the current one"**.
 *
 * - null if there is nothing stored.
 * - If the current history has 2 or more steps (the user moved while waiting for the read-back), the current one wins (null).
 * - Otherwise the stored one is the base, and if there is one current step (pushed by restoring the memory when the thread was opened),
 *   it is pushed as "that URI was opened". If it is the same URI as the stored "current step", no step is added (`recordVisit`).
 */
export function adoptStored(current: ViewerHistory, stored: ViewerHistorySnapshot | null): ViewerHistory | null {
  if (stored === null || stored.entries.length === 0) return null
  if (current.entries.length > 1) return null
  const restored = fromSnapshot(stored)
  // The position the viewer reported while waiting for the read-back (TODO 1146) is newer than the stored one.
  const base: ViewerHistory =
    current.positions === undefined
      ? restored
      : { ...restored, positions: { ...restored.positions, ...current.positions } }
  const here = current.entries[current.index]
  if (here === undefined) return base
  return recordVisit(base, { uri: here.uri, highlight: here.highlight, now: 0, byKeys: false })
}

/** Whether the content is the same (a marker to avoid wasted write-backs). `at` / `byKeys` are not looked at. */
export function historySignature(history: ViewerHistory): string {
  return JSON.stringify(toSnapshot(history))
}

/** The write throttle (ms). Same as `setViewerState` (viewer-memory). */
export const VIEWER_HISTORY_WRITE_DEBOUNCE_MS = 300

export interface ViewerHistoryWriterDeps {
  /** Sends to main (`threads.setViewerHistory`). */
  readonly send: (threadId: string, snapshot: ViewerHistorySnapshot) => Promise<void>
  readonly setTimer: (fn: () => void, ms: number) => unknown
  readonly clearTimer: (handle: unknown) => void
}

/**
 * Throttles history writes. Sending on every added step would be too many with consecutive up/down-key opens (356), so only the last
 * one per 300 ms is sent per conversation. Nothing is sent if it equals what was last sent (read back). Right before a window closes, `flushAll`.
 * **Nothing is written for a conversation whose read-back has not finished** (the caller does not call `schedule`) - so a nearly empty history
 * does not overwrite the saved one.
 */
export class ViewerHistoryWriter {
  private readonly timers = new Map<string, unknown>()
  private readonly latest = new Map<string, () => ViewerHistory>()
  private readonly signatures = new Map<string, string>()

  constructor(private readonly deps: ViewerHistoryWriterDeps) {}

  /** Remembers it as the content that was sent (read back). If the next `schedule` is the same, nothing is sent. */
  markSynced(threadId: string, history: ViewerHistory): void {
    this.signatures.set(threadId, historySignature(history))
  }

  schedule(threadId: string, read: () => ViewerHistory): void {
    this.latest.set(threadId, read)
    const previous = this.timers.get(threadId)
    if (previous !== undefined) this.deps.clearTimer(previous)
    this.timers.set(
      threadId,
      this.deps.setTimer(() => this.flush(threadId), VIEWER_HISTORY_WRITE_DEBOUNCE_MS)
    )
  }

  flush(threadId: string): void {
    const timer = this.timers.get(threadId)
    if (timer !== undefined) this.deps.clearTimer(timer)
    this.timers.delete(threadId)
    const read = this.latest.get(threadId)
    this.latest.delete(threadId)
    if (read === undefined) return
    const history = read()
    const signature = historySignature(history)
    if (this.signatures.get(threadId) === signature) return
    this.signatures.set(threadId, signature)
    this.deps.send(threadId, toSnapshot(history)).catch(() => {
      // Could not send: clear the marker so it is sent again on the next change.
      if (this.signatures.get(threadId) === signature) this.signatures.delete(threadId)
    })
  }

  flushAll(): void {
    for (const threadId of [...this.latest.keys()]) this.flush(threadId)
  }
}
