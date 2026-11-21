/**
 * The editing state for cell values and formulas of `.xlsx` / `.xlsm` (TODO 1212 stage 1 / stage 2, ARCHITECTURE 7.4.9.1). **It depends on neither the DOM nor the bridge**
 * (tests call it directly). `main.ts` draws it.
 *
 * - An edit is represented as "the original workbook + a list of edits". The list is the host's draft (the string from `serializeCellEdits`), and saving goes host ->
 *   main (`ViewerBroker.write` -> `xlsx-cells-write.ts`). The viewer does not write the file.
 * - An edit that returns to the original value is removed from the list (if all are returned, the draft is empty = not unsaved).
 * - undo / redo is a stack of copies of the edit list.
 * - The stale-value mark is `staleFormulaCells` (aios does not calculate). A cell rewritten into a formula also has no value, so it gets the mark.
 * - The "original value" of a formula cell is the formula (shown with `=` prepended). Returning it to the same formula removes it from the edit list.
 */
import {
  collapseCellEdits,
  displayFormula,
  formatRef,
  formulaCellKey,
  normalizeFormulaInput,
  parseRef,
  staleFormulaCells,
  unknownSheetIn,
  type CellEdit,
  type CellValue,
  type ChangedCell,
  type FormulaCell
} from '@shared/xlsx-cells.js'
import { formatCell, type SheetCell } from '../../_shared/sheet.js'
import { cellLockOf, cellPosKey, excelSerialToDate, type Workbook, type WorkbookSheet } from './workbook.js'

export interface EditState {
  readonly edits: readonly CellEdit[]
  readonly undo: readonly (readonly CellEdit[])[]
  readonly redo: readonly (readonly CellEdit[])[]
}

export const EMPTY_EDIT_STATE: EditState = { edits: [], undo: [], redo: [] }

/** The upper limit of the undo depth. */
const MAX_UNDO = 200

/**
 * Whether the file's value and the value to write are the same (if so, it is not kept in the edit list). `originalFormula` is the formula of the cell if the original is a formula
 * (as in the file) — a formula cell counts as the same only when returned to the same formula (typing the same value as the cached value is an edit that turns a formula into a value).
 */
export function sameAsOriginal(original: SheetCell, value: CellValue, date1904: boolean, originalFormula: string | null = null): boolean {
  if (originalFormula !== null) return value.t === 'f' && value.v === originalFormula
  switch (value.t) {
    case 'f':
      return false
    case 'empty':
      return original === null || original === undefined || original === ''
    case 's':
      return typeof original === 'string' && original === value.v
    case 'b':
      return typeof original === 'boolean' && original === value.v
    case 'n':
      if (typeof original === 'number') return original === value.v
      if (original instanceof Date) return original.getTime() === excelSerialToDate(value.v, date1904).getTime()
      return false
  }
}

/** The value to write -> the value shown in the table. A number in a cell whose original is a date (a date format) is shown as a date. */
export function displayValue(value: CellValue, original: SheetCell, date1904: boolean): SheetCell {
  switch (value.t) {
    case 'f':
      // Not calculated, so there is no value. Show the formula (paired with the "not calculated" mark).
      return `=${displayFormula(value.v)}`
    case 'empty':
      return null
    case 's':
      return value.v
    case 'b':
      return value.v
    case 'n':
      return original instanceof Date ? excelSerialToDate(value.v, date1904) : value.v
  }
}

/** The string shown in the input field (the initial value of the formula bar and the cell input). */
export function cellInputText(cell: SheetCell): string {
  if (typeof cell === 'string') return cell
  return formatCell(cell)
}

function originalOf(sheet: WorkbookSheet, row: number, col: number): SheetCell {
  return sheet.rows[row]?.[col] ?? null
}

/** The formula in the original file (not shared, and holding a formula). null if none. */
export function originalFormulaAt(sheet: WorkbookSheet, row: number, col: number): string | null {
  const fact = sheet.facts.formulas.get(cellPosKey(row, col))
  return fact?.kind === 'normal' ? fact.text : null
}

/**
 * The string shown in the input field (formula bar, cell input). For a formula cell (the original formula or a rewritten one) it is `=` + the formula; otherwise the value as a string.
 * It is also compared against this to tell whether the cell was committed untouched.
 */
export function inputTextAt(sheet: WorkbookSheet, edits: readonly CellEdit[], row: number, col: number, date1904: boolean): string {
  const edit = editAt(edits, sheet.path, formatRef(row, col))
  if (edit !== undefined) {
    if (edit.value.t === 'f') return `=${displayFormula(edit.value.v)}`
    return cellInputText(displayValue(edit.value, originalOf(sheet, row, col), date1904))
  }
  const formula = sheet.facts.formulas.get(cellPosKey(row, col))?.text ?? null
  if (formula !== null) return `=${displayFormula(formula)}`
  return cellInputText(originalOf(sheet, row, col))
}

/** Apply one edit (removed from the list if it returned to the original). `originalFormula` is the formula if the original cell is a formula. */
export function applyEdit(
  state: EditState,
  edit: CellEdit,
  original: SheetCell,
  date1904: boolean,
  originalFormula: string | null = null
): EditState {
  const known = state.edits.find((e) => e.sheet === edit.sheet && e.ref === edit.ref)
  const reverts = sameAsOriginal(original, edit.value, date1904, originalFormula)
  if (known === undefined && reverts) return state
  if (known !== undefined && JSON.stringify(known.value) === JSON.stringify(edit.value)) return state
  const next = reverts
    ? state.edits.filter((e) => e !== known)
    : collapseCellEdits([...state.edits, edit])
  return { edits: next, undo: [...state.undo, state.edits].slice(-MAX_UNDO), redo: [] }
}

export function undoEdit(state: EditState): EditState {
  const previous = state.undo[state.undo.length - 1]
  if (previous === undefined) return state
  return { edits: previous, undo: state.undo.slice(0, -1), redo: [...state.redo, state.edits] }
}

export function redoEdit(state: EditState): EditState {
  const next = state.redo[state.redo.length - 1]
  if (next === undefined) return state
  return { edits: next, undo: [...state.undo, state.edits], redo: state.redo.slice(0, -1) }
}

/** The current edit of that cell (undefined if none). */
export function editAt(edits: readonly CellEdit[], sheetPath: string, ref: string): CellEdit | undefined {
  return edits.find((e) => e.sheet === sheetPath && e.ref === ref)
}

/** The table with the edits overlaid on the sheet's values (the original table is not changed). */
export function displayRows(sheet: WorkbookSheet, edits: readonly CellEdit[], date1904: boolean): SheetCell[][] {
  const mine = edits.filter((e) => e.sheet === sheet.path)
  if (mine.length === 0) return sheet.rows
  const rows: SheetCell[][] = sheet.rows.slice()
  for (const edit of mine) {
    const at = parseRef(edit.ref)
    if (at === null) continue
    while (rows.length <= at.row) rows.push([])
    const row = (rows[at.row] ?? []).slice()
    while (row.length <= at.col) row.push(null)
    row[at.col] = displayValue(edit.value, originalOf(sheet, at.row, at.col), date1904)
    rows[at.row] = row
  }
  return rows
}

/**
 * Narrow a restored draft (from the host's table) to only the edits this workbook can write. Edits for unknown sheets or for cells with a reason to refuse are dropped
 * (e.g. a restore after the file was changed outside). If anything was dropped, the caller resends the draft.
 */
export function usableEdits(book: Workbook, edits: readonly CellEdit[]): CellEdit[] {
  return edits.filter((edit) => {
    const sheet = book.sheets.find((s) => s.path === edit.sheet)
    const at = parseRef(edit.ref)
    if (sheet === undefined || at === null || cellLockOf(book, sheet.facts, at.row, at.col) !== null) return false
    if (edit.value.t !== 'f') return true
    // A formula must reference only sheets of this workbook (e.g. a restore after a sheet was renamed outside).
    const checked = normalizeFormulaInput(edit.value.v)
    return checked.ok && !unknownSheetIn(checked.sheets, book.sheetNames)
  })
}

/** The formula cells of the whole workbook (material for the stale-value mark). Built only once when the workbook is read. */
export function formulaCellsOf(book: Workbook): FormulaCell[] {
  const out: FormulaCell[] = []
  for (const sheet of book.sheets) {
    for (const [key, formula] of sheet.facts.formulas) {
      const [row, col] = key.split(',').map(Number)
      if (row === undefined || col === undefined) continue
      out.push({ sheet: sheet.name, row, col, refs: formula.refs, opaque: formula.opaque })
    }
  }
  return out
}

/**
 * The keys (`formulaCellKey`) of formula cells with stale values: formula cells that depend (directly or indirectly) on an edit, and the cells rewritten
 * into formulas themselves (they hold no value). A cell rewritten from a formula into a value is excluded (it is no longer a formula).
 */
export function staleKeys(book: Workbook, formulas: readonly FormulaCell[], edits: readonly CellEdit[]): Set<string> {
  const changed: ChangedCell[] = []
  const edited: { key: string; formula: boolean }[] = []
  for (const edit of edits) {
    const sheet = book.sheets.find((s) => s.path === edit.sheet)
    const at = parseRef(edit.ref)
    if (sheet === undefined || at === null) continue
    changed.push({ sheet: sheet.name, row: at.row, col: at.col })
    edited.push({ key: formulaCellKey(sheet.name, at.row, at.col), formula: edit.value.t === 'f' })
  }
  const stale = staleFormulaCells(formulas, changed)
  for (const item of edited) {
    if (item.formula) stale.add(item.key)
    else stale.delete(item.key)
  }
  return stale
}

/** Whether it is a formula cell in the file with no cached value (not calculated). A cell with an edit is not considered (the edit mark wins). */
export function isUncomputed(sheet: WorkbookSheet, edits: readonly CellEdit[], row: number, col: number): boolean {
  if (editAt(edits, sheet.path, formatRef(row, col)) !== undefined) return false
  return sheet.facts.formulas.get(cellPosKey(row, col))?.computed === false
}

export function isStale(stale: ReadonlySet<string>, sheet: WorkbookSheet, row: number, col: number): boolean {
  return stale.has(formulaCellKey(sheet.name, row, col))
}

/** The formula shown in the formula bar (formula cells only, in the on-screen form). A child of a shared formula has no formula (null). */
export function formulaTextAt(sheet: WorkbookSheet, row: number, col: number): string | null {
  const text = sheet.facts.formulas.get(cellPosKey(row, col))?.text ?? null
  return text === null ? null : displayFormula(text)
}
