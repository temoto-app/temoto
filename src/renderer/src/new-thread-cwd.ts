/**
 * Pure functions for the working-folder rows of the create dialog (item 153 / TODO 462, ARCHITECTURE.md 4.3.2).
 * Independent of the DOM and React; `test/new-thread-cwd.test.ts` guards against regressions.
 *
 * - Rows show the **full path** (`~/git/mybox`, home as `~`). It used to be "name + parent name".
 *   That the renderer may see paths was decided in item 55. The conversion is `displayPath` (the same as ViewerPane / SearchMode).
 * - Order: a folder chosen with "Open Folder…" that is not in the history (first, per TODO 462: it would be invisible at the tail of 100) ->
 *   the history (**most-used first, newest first on ties**, TODO 462. The ordering is done by main's SQL; no re-sorting here.
 *   Home is a single entry in it, T19) -> home if it is not in the history. Counts are not shown (TODO 462).
 * - Filtering (TODO 462): part of the displayed path (still in `~` form), case-insensitive.
 *   The "no affiliation (disposable)" row is exempt and always shown (the row is `SCRATCH_CHOICE`).
 * - ↑↓ use `listKeyStep` of `list-keys.ts` (wraps like Quick Open; Home / End are left to the text in the field).
 */
import type { CwdHistoryEntry } from '@shared/thread.js'
import { displayPath, uriBasename } from '@shared/uri.js'
import { listKeyStep } from './list-keys.js'

/**
 * The key of the choice that stands for "no affiliation (disposable)" (T19 / TODO 24). Not a URI (the cwd is
 * `~/aios/scratch/<id>`, decided by main from the thread id, and the renderer does not know that location).
 */
export const SCRATCH_CHOICE = 'aios:scratch'

/** One row. `path` is the full path for display (with `~` shortening). */
export interface CwdRow {
  readonly entry: CwdHistoryEntry
  readonly path: string
}

/** A history entry built from the URI alone (the pseudo entry for home and a folder chosen with "Open Folder…"). */
export function bareCwdEntry(uri: string, lastUsedAt = 0): CwdHistoryEntry {
  return {
    uri,
    name: uriBasename(uri) || uri,
    parentName: '',
    lastUsedAt,
    useCount: 0,
    usable: true,
    reason: null,
    // TODO 742: no color is assigned to rows that are not in the history (no thread yet).
    rainbow: null
  }
}

/** The rows to list in the dialog. `picked` is the folder chosen with "Open Folder…" (null if none). */
export function cwdRows(
  history: readonly CwdHistoryEntry[],
  homeUri: string,
  picked: CwdHistoryEntry | null
): readonly CwdRow[] {
  const entries: CwdHistoryEntry[] = [...history]
  if (!history.some((e) => e.uri === homeUri)) entries.push(bareCwdEntry(homeUri))
  if (picked !== null && !entries.some((e) => e.uri === picked.uri)) entries.unshift(picked)
  return entries.map((entry) => ({ entry, path: displayPath(entry.uri, homeUri) }))
}

/** Filtering (TODO 462). A whitespace-only term does not filter. Matches part of the displayed path, case-insensitively. */
export function filterCwdRows(rows: readonly CwdRow[], query: string): readonly CwdRow[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return rows
  return rows.filter((row) => row.path.toLocaleLowerCase().includes(needle))
}

/** The first selectable row in the filtered list (when a term is typed, the highlight goes there, same as Quick Open). null if none. */
export function firstUsableUri(rows: readonly CwdRow[]): string | null {
  return rows.find((row) => row.entry.usable)?.entry.uri ?? null
}

/**
 * The key (`SCRATCH_CHOICE` or a URI) of the row to select next with ↑↓. The order is "no affiliation" -> the visible rows. Unusable rows are skipped.
 * null for keys not handled. If `current` is not visible (hidden by filtering), ↓ goes to the first and ↑ to the last.
 */
export function cwdKeyStep(key: string, current: string, visible: readonly CwdRow[]): string | null {
  const keys = [SCRATCH_CHOICE, ...visible.map((row) => row.entry.uri)]
  const selectable = [true, ...visible.map((row) => row.entry.usable)]
  const next = listKeyStep(key, keys.indexOf(current), keys.length, { wrap: true, homeEnd: false, selectable })
  return next === null ? null : (keys[next] ?? null)
}
