/**
 * Diff for the approval frame (item 97, ARCHITECTURE.md 7.6.4). Applies a write tool's change (`WriteChange`, a neutral shape
 * the Adapter read from the arguments) to the **file's current contents** and produces two texts, before and after.
 *
 * This file holds pure functions only. The caller (`SessionManager.approvalDiff`) reads the file, after passing the choke point
 * (`assertAllowed`). It has no backend knowledge (the notebook format is Jupyter's).
 *
 * When the change cannot be applied (the text to replace is not in the current contents, or the file is unreadable / too large), it gives up on the
 * whole-file diff and lists **only the changed strings** (`basis: 'fragment'`). Seeing what the model is about to write
 * helps the approval decision more than showing nothing.
 */
import type { WriteChange } from '../session/types.js'

/** The file's current contents. `missing` = does not exist (will be created), `unavailable` = unreadable or too large. */
export type CurrentContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }

export interface WriteDiff {
  readonly before: string
  readonly after: string
  /** `file` = before and after applied to the current contents, `fragment` = only the changed strings. */
  readonly basis: 'file' | 'fragment'
}

/** Separator when listing fragments (multiple replacements). */
const FRAGMENT_SEPARATOR = '\n…\n'

export function applyWriteChange(current: CurrentContent, change: WriteChange): WriteDiff {
  switch (change.kind) {
    case 'overwrite':
      if (current.kind === 'unavailable') return { before: '', after: change.content, basis: 'fragment' }
      return { before: current.kind === 'text' ? current.text : '', after: change.content, basis: 'file' }
    case 'replace':
      return applyReplace(current, change.edits)
    case 'notebookCell':
      return applyNotebookCell(current, change)
  }
}

function fragmentOf(edits: readonly { oldText: string; newText: string }[]): WriteDiff {
  return {
    before: edits.map((edit) => edit.oldText).join(FRAGMENT_SEPARATOR),
    after: edits.map((edit) => edit.newText).join(FRAGMENT_SEPARATOR),
    basis: 'fragment'
  }
}

function applyReplace(
  current: CurrentContent,
  edits: readonly { oldText: string; newText: string; replaceAll: boolean }[]
): WriteDiff {
  if (current.kind === 'unavailable') return fragmentOf(edits)
  // For a missing or empty file, an "empty -> body" replacement is written as creating a new file (only when there is exactly one).
  const text = current.kind === 'text' ? current.text : null
  if ((text === null || text === '') && edits.length === 1 && edits[0]?.oldText === '') {
    return { before: '', after: edits[0].newText, basis: 'file' }
  }
  if (text === null) return fragmentOf(edits)
  let after = text
  for (const edit of edits) {
    // Where an empty text-to-replace matches is undefined. One that is not found is also not applied and falls back to fragments
    // (for example, the file changed after the model read it).
    if (edit.oldText === '' || !after.includes(edit.oldText)) return fragmentOf(edits)
    after = edit.replaceAll
      ? after.split(edit.oldText).join(edit.newText)
      : // Return a function so that `$&` and the like in `replace`'s replacement string do not take effect.
        after.replace(edit.oldText, () => edit.newText)
  }
  return { before: text, after, basis: 'file' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Turns a cell's `source` (a string or an array of lines) into a single string. */
function cellSource(cell: Record<string, unknown>): string {
  const source = cell['source']
  if (typeof source === 'string') return source
  if (Array.isArray(source)) return source.filter((line): line is string => typeof line === 'string').join('')
  return ''
}

/**
 * One notebook cell. The diff shows only that cell's before and after (a whole-notebook JSON would be
 * unreadable). The cell is found by `id`; if absent, the form `cell-<number>` is read as an index.
 */
function applyNotebookCell(
  current: CurrentContent,
  change: Extract<WriteChange, { kind: 'notebookCell' }>
): WriteDiff {
  if (change.mode === 'insert') return { before: '', after: change.newSource, basis: 'file' }
  const cells = current.kind === 'text' ? notebookCells(current.text) : null
  const cell = cells === null ? null : findCell(cells, change.cellId)
  if (cell === null) {
    return { before: '', after: change.mode === 'delete' ? '' : change.newSource, basis: 'fragment' }
  }
  const before = cellSource(cell)
  return { before, after: change.mode === 'delete' ? '' : change.newSource, basis: 'file' }
}

function notebookCells(text: string): readonly Record<string, unknown>[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['cells'])) return null
  return parsed['cells'].filter(isRecord)
}

function findCell(
  cells: readonly Record<string, unknown>[],
  cellId: string | null
): Record<string, unknown> | null {
  if (cellId === null) return null
  const byId = cells.find((cell) => cell['id'] === cellId)
  if (byId !== undefined) return byId
  const index = /^cell-(\d+)$/.exec(cellId)
  if (index === null) return null
  return cells[Number(index[1])] ?? null
}
