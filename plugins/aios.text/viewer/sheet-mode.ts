/**
 * The view switch for `.csv` / `.tsv` in `aios.text` (TODO 1215, wave 83, ARCHITECTURE 7.4.12).
 *
 * For delimiter-separated tables, the host heading's switch (`view-modes`) toggles between Text (CodeMirror as before: editing, draft, save, Cmd+F) and Table (the table of `_shared/sheet-view.ts`,
 * read-only). The shape and the memory are the same as the Source / Preview of `aios.markdown` / `aios.html`
 * (a variable inside the viewer's iframe: while the iframe lives, the last choice even after opening another file and coming back):
 * **the default when opened is the table, and the last choice is remembered** (owner decision 2026-11-12). Only what the user chose with the switch is remembered, and
 * a jump to a line showing Text affects only that file's view (code-review).
 *
 * `main.ts` is the entry connected to the DOM and the bridge, so only the decisions are split out here (the same shape as `aios.html`'s `mode.ts`).
 */
import type { ViewerSheetMode } from '@shared/viewer-view-mode.js'
import type { CsvDelimiter } from '../../_shared/csv.js'

export type SheetMode = ViewerSheetMode

/** The view when opened (owner decision 2026-11-12: the table). */
export const INITIAL_SHEET_MODE: SheetMode = 'table'

/** The views shown in the host heading's switch (the order is the same as Markdown's Preview / Source: the drawn one first). */
export const SHEET_VIEW_MODES: readonly SheetMode[] = ['table', 'text']

/**
 * Decide the delimiter from the file name (the host's `label`, or the URI if none). null for files that are not shown as a table.
 * The extension is case-insensitive.
 */
export function delimiterOf(name: string): CsvDelimiter | null {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = base.slice(dot + 1).toLowerCase()
  if (ext === 'csv') return ','
  if (ext === 'tsv') return '\t'
  return null
}

/** Whether to insert a dropped path (TODO 366 / 407). Not inserted while the table is shown (the host makes drop fall back to "open"). */
export function sheetAcceptsInsert(mode: SheetMode | null): boolean {
  return mode !== 'table'
}
