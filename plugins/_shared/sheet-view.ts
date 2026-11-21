/**
 * The table DOM (TODO 1215, wave 83). Shared by the `.xlsx` sheet of `aios.office` and the `.csv` / `.tsv` table of `aios.text`.
 * How many rows / columns to draw and the cell strings are pure functions in `sheet.ts`. This file only builds the `<table>` and the "show more" band.
 *
 * The look is `.office-sheet*` in `viewer.css` (the column headings A, B, ... and row numbers are sticky; colors only from variables). The class names are
 * as they were when named in `aios.office` (`.office-sheet-scroll`, the target of in-document search, is also looked up by this name).
 */
import { vt } from './i18n.js'
import {
  columnLabel,
  formatCell,
  growColumns,
  growRows,
  isNumericCell,
  moreColumns,
  moreRows,
  type SheetCell,
  type SheetRows,
  type SheetWindow
} from './sheet.js'

/**
 * The table (column headings + row numbers + cells). Draws only the range of `view`. Cells with a true `numeric` are right-aligned (`td.num`).
 * `decorate` is called per cell (the `.xlsx` editing - TODO 1212 stage 1 - puts position, selection and old-value markers there).
 */
export function renderSheetTable(
  doc: Document,
  rows: SheetRows,
  view: SheetWindow,
  numeric: (cell: SheetCell) => boolean = isNumericCell,
  decorate?: (td: HTMLTableCellElement, row: number, col: number) => void
): HTMLTableElement {
  const table = doc.createElement('table')
  table.className = 'office-sheet'
  const head = doc.createElement('thead')
  const headRow = doc.createElement('tr')
  const corner = doc.createElement('th')
  corner.className = 'office-corner'
  headRow.append(corner)
  for (let c = 0; c < view.shownColumns; c++) {
    const th = doc.createElement('th')
    th.textContent = columnLabel(c)
    headRow.append(th)
  }
  head.append(headRow)
  table.append(head)

  const body = doc.createElement('tbody')
  for (let r = 0; r < view.shownRows; r++) {
    const row = rows[r] ?? []
    const tr = doc.createElement('tr')
    const th = doc.createElement('th')
    th.textContent = String(r + 1)
    tr.append(th)
    for (let c = 0; c < view.shownColumns; c++) {
      const cell = row[c]
      const td = doc.createElement('td')
      td.textContent = formatCell(cell)
      if (numeric(cell)) td.className = 'num'
      decorate?.(td, r, c)
      tr.append(td)
    }
    body.append(tr)
  }
  table.append(body)
  return table
}

/**
 * The band under the table: "showing n / N rows, m / M columns" and the "more rows" / "right columns" buttons. Pressing one calls `onGrow` with the expanded range
 * (the caller redraws).
 */
export function renderSheetFooter(
  doc: Document,
  view: SheetWindow,
  onGrow: (next: SheetWindow) => void
): HTMLDivElement {
  const footer = doc.createElement('div')
  footer.className = 'toolbar office-sheet-footer'
  const info = doc.createElement('span')
  info.className = 'office-sheet-info'
  info.textContent = vt('sheetShown', {
    rows: view.shownRows,
    totalRows: view.extent.rows,
    columns: view.shownColumns,
    totalColumns: view.extent.columns
  })
  footer.append(info)
  const addRows = moreRows(view)
  if (addRows > 0) {
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'office-sheet-more-rows'
    button.textContent = vt('sheetMoreRows', { count: addRows })
    button.addEventListener('click', () => onGrow(growRows(view)))
    footer.append(button)
  }
  const addColumns = moreColumns(view)
  if (addColumns > 0) {
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'office-sheet-more-columns'
    button.textContent = vt('sheetMoreColumns', { count: addColumns })
    button.addEventListener('click', () => onGrow(growColumns(view)))
    footer.append(button)
  }
  return footer
}
