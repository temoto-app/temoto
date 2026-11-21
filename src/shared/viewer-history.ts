/**
 * The shape in which main keeps the viewer's back / forward history (TODO 772, ARCHITECTURE.md 5.3). The renderer's history
 * (`ViewerHistory` in `viewer-history.ts`) with `at` / `byKeys` (for the 1-second coalescing) dropped.
 * It holds no body text (only URIs and search terms, and since TODO 1146 the per-document view position (a line, page or scroll amount number),
 * which does not fall under constraints 9 / 10).
 */
import { replaceUriPrefix } from './uri.js'
import type { ViewerPositionTable } from './viewer-position.js'

export interface ViewerHistoryStep {
  readonly uri: string
  /** The in-File search term (item 56). null if none. */
  readonly highlight: string | null
}

export interface ViewerHistorySnapshot {
  readonly entries: readonly ViewerHistoryStep[]
  /** The current step. -1 if entries is empty. */
  readonly index: number
  /**
   * Per-document view position (TODO 1146, owner decision 2026-11-06: per URI). The keys are only the URIs in `entries`, and the same URI
   * in several steps gives one. Omitted if none (histories saved before TODO 1146 do not have it either).
   */
  readonly positions?: ViewerPositionTable
}

/** Upper bound on steps kept per conversation (owner decision 2026-10-12). Old steps are dropped first. Same value as the renderer's `HISTORY_LIMIT`. */
export const VIEWER_HISTORY_STORE_LIMIT = 50

/**
 * Replace the old URI of a renamed file / folder (TODO 1149) with the new URI inside the history's steps
 * (for a folder, also the prefix of URIs under it). If no step changes, return the input itself (same reference = no write-back needed).
 */
export function renameHistoryUris<T extends { readonly uri: string }>(
  entries: readonly T[],
  from: string,
  to: string
): readonly T[] {
  let changed = false
  const next = entries.map((entry) => {
    const uri = replaceUriPrefix(entry.uri, from, to) ?? entry.uri
    if (uri === entry.uri) return entry
    changed = true
    return { ...entry, uri }
  })
  return changed ? next : entries
}

/**
 * Re-key the keys of `positions` (TODO 1146) by the same rule. If no key changes, return the input itself.
 * If the target key already exists, the one being moved (the position of the old URI) wins.
 */
export function renameHistoryPositions(
  positions: ViewerPositionTable | undefined,
  from: string,
  to: string
): ViewerPositionTable | undefined {
  if (positions === undefined) return positions
  let changed = false
  const next = Object.create(null) as Record<string, ViewerPositionTable[string]>
  for (const [uri, position] of Object.entries(positions)) {
    const renamed = replaceUriPrefix(uri, from, to) ?? uri
    if (renamed !== uri) changed = true
    next[renamed] = position
  }
  return changed ? next : positions
}

/**
 * Re-point the old URIs of a whole history (`entries` and `positions`). Shared by the renderer's `store.noteRenamed` and
 * main's `ViewerHistoryService.renameUris`. If nothing changes, return the input itself.
 */
export function renameHistoryUrisIn<T extends { readonly entries: readonly { readonly uri: string }[]; readonly positions?: ViewerPositionTable }>(
  history: T,
  from: string,
  to: string
): T {
  const entries = renameHistoryUris(history.entries, from, to)
  const positions = renameHistoryPositions(history.positions, from, to)
  if (entries === history.entries && positions === history.positions) return history
  return positions === undefined ? { ...history, entries } : { ...history, entries, positions }
}
