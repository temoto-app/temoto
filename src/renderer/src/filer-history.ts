/**
 * Per-conversation history of the Files tree (TODO 1257, wave 92 bundle A, ARCHITECTURE 5.4 "Files back / forward").
 * Pure: touches neither the DOM nor a store, so `test/filer-history.test.ts` checks it directly. The wiring is
 * `filerHistory.ts`.
 *
 * Same shape as the viewer history (`viewer-history.ts`, TODO 369): a list of positions and the current index.
 *
 * - **1 step = a row picked in Files** (a file or a folder: click, Enter, ↑↓, "Show in Files", the working folder
 *   reveal). The current step is the row Files highlights (its own selection, separate from the viewer's file).
 * - **↑↓ moves within 1 s collapse into one step** (`byKeys`), like the viewer history. The step before the run stays.
 * - Picking a new row after going back drops the forward steps (browser rule). Up to 50 steps, oldest dropped first.
 * - **Rows that no longer exist are dropped** when ← → finds them (`dropEntries`), so the buttons do not stay enabled
 *   for steps that would do nothing (the problem TODO 803 noted for the window-wide history).
 * - Memory only, per window and per conversation. Moves made by back / forward are not recorded (`navigating.ts`).
 */

import { replaceUriPrefix } from '@shared/uri.js'

export interface FilerEntry {
  readonly uri: string
  /** When this step was recorded (or last replaced), in ms. Used for the 1 s collapse. */
  readonly at: number
  /** Recorded by an ↑↓ move. Only such steps collapse. */
  readonly byKeys: boolean
}

export interface FilerHistory {
  readonly entries: readonly FilerEntry[]
  /** The current step; -1 when empty. */
  readonly index: number
}

export const EMPTY_FILER: FilerHistory = { entries: [], index: -1 }

/** ↑↓ moves within this many ms collapse into one step (same as the viewer history). */
export const FILER_COALESCE_MS = 1000

/** Steps kept per conversation (same as the viewer history). */
export const FILER_LIMIT = 50

export interface FilerPick {
  readonly uri: string
  readonly now: number
  /** An ↑↓ move in the tree. */
  readonly byKeys: boolean
}

/** The row Files highlights for this history (the current step), or null. */
export function currentFilerUri(history: FilerHistory): string | null {
  return history.entries[history.index]?.uri ?? null
}

/** A row was picked (= 1 step). Returns the same value when nothing changes. */
export function recordPick(history: FilerHistory, pick: FilerPick): FilerHistory {
  const current = history.entries[history.index]
  if (current !== undefined && current.uri === pick.uri) return history
  const entry: FilerEntry = { uri: pick.uri, at: pick.now, byKeys: pick.byKeys }
  const atTip = history.index === history.entries.length - 1
  const coalesce =
    current !== undefined &&
    pick.byKeys &&
    current.byKeys &&
    atTip &&
    pick.now - current.at >= 0 &&
    pick.now - current.at < FILER_COALESCE_MS
  if (coalesce) {
    const previous = history.entries[history.index - 1]
    // ↓ then ↑ back onto the previous row: fold the current step instead of listing the same row twice.
    if (previous !== undefined && previous.uri === pick.uri) {
      return { entries: history.entries.slice(0, history.index), index: history.index - 1 }
    }
    const entries = history.entries.slice(0, history.index + 1)
    entries[history.index] = entry
    return { entries, index: history.index }
  }
  const entries = [...history.entries.slice(0, history.index + 1), entry]
  const overflow = Math.max(0, entries.length - FILER_LIMIT)
  const trimmed = overflow === 0 ? entries : entries.slice(overflow)
  return { entries: trimmed, index: trimmed.length - 1 }
}

/**
 * Holds just one row without keeping history: used while no conversation is shown (the viewer history does not
 * record then either). Returns the same value when nothing changes.
 */
export function holdOnly(history: FilerHistory, pick: FilerPick): FilerHistory {
  if (history.entries.length === 1 && currentFilerUri(history) === pick.uri) return history
  return { entries: [{ uri: pick.uri, at: pick.now, byKeys: pick.byKeys }], index: 0 }
}

export type FilerDirection = 'back' | 'forward'

export interface FilerStep {
  readonly history: FilerHistory
  readonly entry: FilerEntry
}

/** The destination of back / forward, or null at either end. */
export function stepFiler(history: FilerHistory, direction: FilerDirection): FilerStep | null {
  const target = history.index + (direction === 'back' ? -1 : 1)
  const entry = history.entries[target]
  if (entry === undefined) return null
  return { history: { entries: history.entries, index: target }, entry }
}

/** Whether the ← / → button is enabled. */
export function canStepFiler(history: FilerHistory, direction: FilerDirection): boolean {
  return stepFiler(history, direction) !== null
}

/**
 * Drops the steps whose row is gone (`isGone`). The current step is always kept (it is what Files shows now).
 * Neighbours that become the same row after the drop are merged. Returns the same value when nothing is dropped.
 */
export function dropEntries(history: FilerHistory, isGone: (uri: string) => boolean): FilerHistory {
  const entries: FilerEntry[] = []
  let index = -1
  let changed = false
  history.entries.forEach((entry, i) => {
    const isCurrent = i === history.index
    if (!isCurrent && isGone(entry.uri)) {
      changed = true
      return
    }
    const last = entries[entries.length - 1]
    if (last !== undefined && last.uri === entry.uri) {
      changed = true
      if (isCurrent) index = entries.length - 1
      return
    }
    entries.push(entry)
    if (isCurrent) index = entries.length - 1
  })
  if (!changed) return history
  return { entries, index: entries.length === 0 ? -1 : index }
}

/** Rewrites the URIs under `from` to `to` after a rename (TODO 1145). Returns the same value when nothing moves. */
export function renameEntries(history: FilerHistory, from: string, to: string): FilerHistory {
  const move = (uri: string): string => replaceUriPrefix(uri, from, to) ?? uri
  if (!history.entries.some((entry) => move(entry.uri) !== entry.uri)) return history
  return { entries: history.entries.map((entry) => ({ ...entry, uri: move(entry.uri) })), index: history.index }
}
