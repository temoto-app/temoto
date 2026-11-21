/**
 * Pure functions for drawing tables (`.xlsx` sheets and `.csv` / `.tsv`) (TODO 405 (4), wave 21 bundle H). Independent of the DOM and of libraries
 * (called directly from tests). Reading is the job of `aios.office`'s `workbook.ts` (zip + XML) and `csv.ts` (delimiters); this only turns their result
 * (`(string | number | boolean | Date | null)[][]`) into "how many rows / columns to draw" and "the cell strings".
 * The DOM parts are in `sheet-view.ts`. In TODO 1215 (wave 83) it moved from `aios.office` to `_shared/` and is shared with the `aios.text` table
 * (each plugin is one bundle, so each bundle gets its own copy).
 *
 * **Do not draw a large sheet all at once.** Making tens of thousands of rows x dozens of columns into `<td>`s freezes the iframe for seconds, so
 * at first only `INITIAL_ROWS` rows x `INITIAL_COLUMNS` columns are drawn, and "show more" grows it by `ROW_STEP` rows /
 * `COLUMN_STEP` columns at a time.
 */

export type SheetCell = string | number | boolean | Date | null | undefined
export type SheetRows = readonly (readonly SheetCell[])[]

export const INITIAL_ROWS = 200
export const ROW_STEP = 500
export const INITIAL_COLUMNS = 50
export const COLUMN_STEP = 50

/** Size of the sheet (trailing empty rows and columns are not counted). */
export interface SheetExtent {
  readonly rows: number
  readonly columns: number
}

function isEmpty(cell: SheetCell): boolean {
  return cell === null || cell === undefined || cell === ''
}

/** The size excluding trailing empty rows and the right-hand columns that are empty in every row. */
export function sheetExtent(rows: SheetRows): SheetExtent {
  let lastRow = -1
  let columns = 0
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? []
    let lastCol = -1
    for (let c = row.length - 1; c >= 0; c--) {
      if (!isEmpty(row[c])) {
        lastCol = c
        break
      }
    }
    if (lastCol >= 0) {
      lastRow = r
      if (lastCol + 1 > columns) columns = lastCol + 1
    }
  }
  return { rows: lastRow + 1, columns }
}

/** The range drawn now. `shownRows` / `shownColumns` do not exceed the whole. */
export interface SheetWindow {
  readonly shownRows: number
  readonly shownColumns: number
  readonly extent: SheetExtent
}

export function initialWindow(extent: SheetExtent): SheetWindow {
  return {
    extent,
    shownRows: Math.min(extent.rows, INITIAL_ROWS),
    shownColumns: Math.min(extent.columns, INITIAL_COLUMNS)
  }
}

/** "Show more rows". The number of rows added next is shown via `moreRows`. */
export function growRows(window: SheetWindow): SheetWindow {
  return { ...window, shownRows: Math.min(window.extent.rows, window.shownRows + ROW_STEP) }
}

export function growColumns(window: SheetWindow): SheetWindow {
  return { ...window, shownColumns: Math.min(window.extent.columns, window.shownColumns + COLUMN_STEP) }
}

/** The number of rows added by the next "show more" (0 means everything is drawn). */
export function moreRows(window: SheetWindow): number {
  return Math.min(ROW_STEP, window.extent.rows - window.shownRows)
}

export function moreColumns(window: SheetWindow): number {
  return Math.min(COLUMN_STEP, window.extent.columns - window.shownColumns)
}

/** Column headings (A ... Z, AA ... as in Excel). `index` is 0-based. */
export function columnLabel(index: number): string {
  let n = index + 1
  let label = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    label = String.fromCharCode(65 + rem) + label
    n = Math.floor((n - 1) / 26)
  }
  return label
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Display of a cell. `workbook.ts` turns date-formatted cells into `Date` (UTC wall clock), so this uses the UTC components to produce
 * `YYYY-MM-DD` (` HH:MM[:SS]` if there is a time). Numbers are shown as they are without applying a format (% or currency)
 * (formats are not interpreted; see bundle H in the notes). Booleans are TRUE / FALSE as in Excel.
 */
export function formatCell(cell: SheetCell): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'string') return cell
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return String(cell)
    // Bring floating-point error (0.1 + 0.2) close to Excel's display: round to 15 significant digits.
    return Number.isInteger(cell) ? String(cell) : String(Number(cell.toPrecision(15)))
  }
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return ''
    const date = `${cell.getUTCFullYear()}-${pad(cell.getUTCMonth() + 1)}-${pad(cell.getUTCDate())}`
    const h = cell.getUTCHours()
    const m = cell.getUTCMinutes()
    const s = cell.getUTCSeconds()
    const time = `${pad(h)}:${pad(m)}${s === 0 ? '' : `:${pad(s)}`}`
    // A serial number below 1 (a time-only cell) becomes 1899-12-30. Show only the time, without a date.
    if (date === '1899-12-30') return time
    if (h === 0 && m === 0 && s === 0) return date
    return `${date} ${time}`
  }
  return String(cell)
}

/** Numbers and dates are right-aligned (as in Excel). */
export function isNumericCell(cell: SheetCell): boolean {
  return typeof cell === 'number' || cell instanceof Date
}

/**
 * Whether a string cell (`.csv` / `.tsv`, TODO 1215) looks like a number. If so it is right-aligned (matching the forms Excel reads as numbers).
 * The value is not changed (the table shows the original string as is). Allows thousands-separator commas, a sign, decimals, exponents and a trailing `%`.
 */
const NUMERIC_TEXT = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?%?$/

export function looksNumericText(text: string): boolean {
  return NUMERIC_TEXT.test(text.trim())
}

/** The right-alignment decision used by the string-cell table (`looksNumericText`). Number and date cells are the same as `isNumericCell`. */
export function isNumericTextCell(cell: SheetCell): boolean {
  return typeof cell === 'string' ? looksNumericText(cell) : isNumericCell(cell)
}
