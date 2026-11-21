/**
 * `aios.office` — shows `.docx` / `.xlsx` read-only (TODO 405 (4), ARCHITECTURE.md 7.3 / 7.4).
 *
 * As in `aios.image`, the contents arrive as a **URL served by main's `aios-res://`** (review C-2: a viewer that claims files with the manifest's
 * `extensions` and has `editable: false` is given a URL, not the body). The viewer only fetches that URL
 * and does not read the file. Before serving, the Broker checks allow rules, exclusions and realpath (A-4).
 *
 * - `.docx` -> draw `convertDocx` (mammoth -> DOMPurify) of `office.ts` into `.office-doc`.
 * - `.xlsx` / `.xlsm` -> read all sheets with `readWorkbook`, shown as sheet tabs + a table. A large table draws only the range from `sheet.ts`.
 *   If the host sets `editable` (TODO 1212 stage 1 / stage 2, `resource.cellEdits`), cell values and formulas can be edited (formulas are not calculated —
 *   the cell written and the cells that depend on it get a "stale value" mark): cell selection (arrows, Tab, Enter),
 *   input (start with F2 / double-click / typing, commit with Enter / Tab, cancel with Esc), the formula bar, and undo / redo. The edits are
 *   only the list of edits (`@shared/xlsx-cells.ts`) returned to the host with `reportDraft`; saving is the host's (main writes the difference).
 *
 * A resend of only the theme or language (a repeated `resource`) does not reread. For xlsx only the wording is redrawn.
 */
import '@pluginshared/viewer.css'
import { connect } from '@pluginshared/bridge.js'
import { createDomFind } from '@pluginshared/dom-find.js'
import { vt } from '@pluginshared/i18n.js'
import { plainSelection } from '@pluginshared/selection.js'
import { viewerLinkAction } from '@shared/link.js'
import { MAX_OFFICE_BYTES, convertDocx, officeKindOf, readWorkbook, type Workbook } from './office.js'
import { initialWindow, sheetExtent, type SheetWindow } from '@pluginshared/sheet.js'
import { renderSheetFooter, renderSheetTable } from '@pluginshared/sheet-view.js'
import {
  MAX_COLUMNS,
  MAX_ROWS,
  formatRef,
  parseCellEdits,
  parseCellInput,
  serializeCellEdits,
  type CellInputResult,
  type CellLockReason,
  type FormulaCell
} from '@shared/xlsx-cells.js'
import {
  EMPTY_EDIT_STATE,
  applyEdit,
  cellInputText,
  displayRows,
  formulaCellsOf,
  formulaTextAt,
  inputTextAt,
  isStale,
  isUncomputed,
  originalFormulaAt,
  redoEdit,
  staleKeys,
  undoEdit,
  usableEdits,
  type EditState
} from './cell-edit.js'
import { cellLockOf } from './workbook.js'

const bridge = connect('aios.office')
const root = document.getElementById('root')

/** The file being shown (the destination of the selection report). */
let uri = ''
/** The key that decides whether to reread (the same URL, size and version count as a resend). */
let loadedKey = ''
/** The load generation. Discards the results of old fetches / conversions. */
let generation = 0
/** The xlsx state (to redraw on a language resend). */
let workbook: Workbook | null = null
let activeSheet = 0
let sheetWindows: SheetWindow[] = []

// ---- Editing cell values (TODO 1212 stage 1) ----
/** Whether the host allowed editing (`resource.cellEdits` -> `editable`). */
let editable = false
let editState: EditState = EMPTY_EDIT_STATE
/** The formula cells of the workbook (material for the stale-value mark). Built only once when it is read. */
let formulaCells: FormulaCell[] = []
/** The selected cell (in the sheet being shown). */
let selection: { row: number; col: number } | null = null
/** The cell being typed into. */
let editing: { row: number; col: number; initial: string } | null = null
/** A one-line notice, such as the reason an input was refused. Cleared on the next operation. */
let notice: string | null = null

const LOCK_MESSAGES: Record<CellLockReason, Parameters<typeof vt>[0]> = {
  sharedFormula: 'cellLockSharedFormula',
  arrayFormula: 'cellLockArrayFormula',
  merged: 'cellLockMerged',
  tableHeader: 'cellLockTableHeader',
  pivot: 'cellLockPivot',
  richValue: 'cellLockRichValue',
  protected: 'cellLockProtected',
  signed: 'cellLockSigned',
  signedMacro: 'cellLockSignedMacro'
}

/** The wording for reasons an input was refused (including the formulas of TODO 1212 stage 2). */
const INPUT_MESSAGES: Record<Extract<CellInputResult, { ok: false }>['reason'], Parameters<typeof vt>[0]> = {
  tooLong: 'cellTooLong',
  formulaSyntax: 'formulaSyntax',
  formulaTooLong: 'formulaTooLong',
  formulaDynamic: 'formulaDynamic',
  formulaUnsupportedRef: 'formulaUnsupportedRef',
  formulaUnknownSheet: 'formulaUnknownSheet',
  formulaFunction: 'formulaFunction'
}

/**
 * Search within the document (TODO 819). For docx it searches `.office-doc`; for xlsx, the `.office-sheet-scroll` of the sheet being shown
 * (sheets not shown and rows before "show more" are not in the DOM, so they are not searched).
 */
root?.classList.add('office-root')
const find = createDomFind({
  host: root ?? document.body,
  target: () => root?.querySelector<HTMLElement>('.office-doc, .office-sheet-scroll') ?? null
})
// Cmd+F / Ctrl+F. The host does not send back Cmd+F pressed inside a viewer (only Ctrl+F on mac becomes the host's body search).
document.addEventListener('keydown', (event) => {
  if (find.handleKey(event)) event.preventDefault()
})

function message(text: string): void {
  if (root === null) return
  root.textContent = ''
  const div = document.createElement('div')
  div.className = 'message'
  div.textContent = text
  root.append(div)
  find.refresh()
}

function reasonOf(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : String(err)
}

/**
 * Links in the body (same rule as aios.markdown, 5.1). Inside the iframe it does not follow them itself: `http(s):` / `mailto:` ask
 * the host to open externally, and relative and `file:` ones ask the host to open. A `#id` inside the document (footnotes, table of contents)
 * scrolls within this document.
 */
function onLinkClick(event: MouseEvent): void {
  const anchor = (event.target as Element | null)?.closest('a')
  if (anchor === null || anchor === undefined) return
  event.preventDefault()
  const href = anchor.getAttribute('href')
  if (href === null) return
  if (href.startsWith('#') && href.length > 1) {
    document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' })
    return
  }
  const action = viewerLinkAction(href)
  if (action === 'none') return
  if (action === 'external') bridge.openExternal(href)
  else bridge.openLink(href)
}

/** Report the selection inside the drawn document / table (item 97). No lines are attached (they cannot be mapped back to original lines). */
document.addEventListener('selectionchange', () => {
  if (uri === '') return
  const selection = document.getSelection()
  const body = root?.querySelector('.office-doc, .office-sheet-scroll') ?? null
  const inside =
    selection !== null && body !== null && selection.anchorNode !== null && body.contains(selection.anchorNode)
  bridge.reportSelection(uri, inside ? plainSelection(selection.toString()) : null)
})

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.arrayBuffer()
}

async function showDocx(bytes: ArrayBuffer, gen: number): Promise<void> {
  const result = await convertDocx(bytes)
  if (gen !== generation || root === null) return
  if (result.html.trim() === '') {
    message(vt('docxEmpty'))
    return
  }
  root.textContent = ''
  const body = document.createElement('div')
  body.className = 'office-doc'
  // `result.html` is a string after DOMPurify (office.ts).
  body.innerHTML = result.html
  body.addEventListener('click', onLinkClick)
  root.append(body)
  find.refresh()
}

/** The size of the current sheet's display (when editable, one extra row and column is added at the right and bottom so empty cells can be written too). */
function extentWithMargin(rows: Parameters<typeof sheetExtent>[0]): { rows: number; columns: number } {
  const extent = sheetExtent(rows)
  if (!editable) return extent
  return { rows: Math.min(MAX_ROWS, extent.rows + 1), columns: Math.min(MAX_COLUMNS, extent.columns + 1) }
}

/** Fit the range to the new size (if everything was visible, show what was added too). The selected cell is always shown. */
function fitWindow(view: SheetWindow, extent: { rows: number; columns: number }): SheetWindow {
  const allRows = view.shownRows >= view.extent.rows
  const allColumns = view.shownColumns >= view.extent.columns
  let shownRows = allRows ? view.shownRows + Math.max(0, extent.rows - view.extent.rows) : view.shownRows
  let shownColumns = allColumns ? view.shownColumns + Math.max(0, extent.columns - view.extent.columns) : view.shownColumns
  if (selection !== null) {
    shownRows = Math.max(shownRows, selection.row + 1)
    shownColumns = Math.max(shownColumns, selection.col + 1)
  }
  return { extent, shownRows: Math.min(extent.rows, shownRows), shownColumns: Math.min(extent.columns, shownColumns) }
}

function currentSheet(): Workbook['sheets'][number] | null {
  return workbook?.sheets[activeSheet] ?? null
}

function lockAt(row: number, col: number): CellLockReason | null {
  const sheet = currentSheet()
  if (workbook === null || sheet === null) return null
  return cellLockOf(workbook, sheet.facts, row, col)
}

/** Return the draft to the host (an empty string if there are no edits). */
function reportEdits(): void {
  if (uri !== '') bridge.reportDraft(uri, serializeCellEdits(editState.edits))
}

/** Validate the input and add it to the edit list. If refused, show a notice and return false. */
function commitInput(row: number, col: number, text: string): boolean {
  const sheet = currentSheet()
  if (workbook === null || sheet === null || !editable) return false
  const lock = lockAt(row, col)
  if (lock !== null) {
    notice = vt(LOCK_MESSAGES[lock])
    return false
  }
  const shown = displayRows(sheet, editState.edits, workbook.date1904)[row]?.[col] ?? null
  // If it was committed untouched (the same string), do nothing — so the string `123` is not turned into a number. For a formula cell, compare with the formula.
  if (text === inputTextAt(sheet, editState.edits, row, col, workbook.date1904)) return true
  const original = sheet.rows[row]?.[col] ?? null
  const parsed = parseCellInput(text, {
    date: original instanceof Date || shown instanceof Date,
    date1904: workbook.date1904,
    sheetNames: workbook.sheetNames
  })
  if (!parsed.ok) {
    notice = vt(INPUT_MESSAGES[parsed.reason])
    return false
  }
  const next = applyEdit(
    editState,
    { sheet: sheet.path, ref: formatRef(row, col), value: parsed.value },
    original,
    workbook.date1904,
    originalFormulaAt(sheet, row, col)
  )
  if (next !== editState) {
    editState = next
    reportEdits()
  }
  return true
}

function changeEdits(next: EditState): void {
  if (next === editState) return
  editState = next
  editing = null
  notice = null
  reportEdits()
  renderWorkbook()
}

/** Move the selected cell (within the table's size). */
function moveSelection(dRow: number, dCol: number): void {
  const sheet = currentSheet()
  if (sheet === null || workbook === null) return
  const extent = extentWithMargin(displayRows(sheet, editState.edits, workbook.date1904))
  const from = selection ?? { row: 0, col: 0 }
  selection = {
    row: Math.max(0, Math.min(extent.rows - 1, from.row + dRow)),
    col: Math.max(0, Math.min(extent.columns - 1, from.col + dCol))
  }
  notice = null
  renderWorkbook()
  root
    ?.querySelector<HTMLElement>('td.office-selected')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  focusGrid()
}

function focusGrid(): void {
  root?.querySelector<HTMLElement>('.office-sheet-scroll')?.focus({ preventScroll: true })
}

/** Start input into a cell. If there is a reason to refuse, only show a notice. */
function startEditing(row: number, col: number, initial?: string): void {
  const sheet = currentSheet()
  if (workbook === null || sheet === null || !editable) return
  selection = { row, col }
  const lock = lockAt(row, col)
  if (lock !== null) {
    notice = vt(LOCK_MESSAGES[lock])
    editing = null
    renderWorkbook()
    focusGrid()
    return
  }
  editing = { row, col, initial: initial ?? inputTextAt(sheet, editState.edits, row, col, workbook.date1904) }
  notice = null
  renderWorkbook()
  const input = root?.querySelector<HTMLInputElement>('input.office-cell-input')
  if (input !== null && input !== undefined) {
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    input.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}

/** End input. If `value` is absent, it is a cancel. If it could be committed, only then does it move by `move`. */
function finishEditing(move: { dRow: number; dCol: number } | null, value?: string): void {
  if (editing === null) return
  const { row, col } = editing
  editing = null
  const ok = value === undefined ? true : commitInput(row, col, value)
  if (ok && move !== null) {
    moveSelection(move.dRow, move.dCol)
    return
  }
  renderWorkbook()
  focusGrid()
}

function cellInput(initial: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'office-cell-input'
  input.value = initial
  input.spellcheck = false
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      finishEditing({ dRow: event.shiftKey ? -1 : 1, dCol: 0 }, input.value)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      finishEditing({ dRow: 0, dCol: event.shiftKey ? -1 : 1 }, input.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finishEditing(null)
    }
  })
  // Pressed somewhere else: commit (same as Excel). If it came off because of a redraw, `editing` was already cleared first.
  input.addEventListener('blur', () => {
    if (editing !== null && input.isConnected) finishEditing(null, input.value)
  })
  return input
}

/** The top band: the cell's address and value (the formula bar). A formula cell is `=` + the formula. A cell with a reason to refuse is read-only. */
function renderFormulaBar(): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'toolbar office-formula-bar'
  const ref = document.createElement('span')
  ref.className = 'office-cell-ref'
  ref.textContent = selection === null ? '' : formatRef(selection.row, selection.col)
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'office-formula-input'
  input.setAttribute('aria-label', vt('cellValueLabel'))
  input.spellcheck = false
  const sheet = currentSheet()
  const at = selection
  if (at === null || sheet === null) {
    input.readOnly = true
  } else {
    const lock = lockAt(at.row, at.col)
    if (lock === 'sharedFormula' || lock === 'arrayFormula') {
      const formula = formulaTextAt(sheet, at.row, at.col)
      input.value = formula === null ? cellInputText(sheet.rows[at.row]?.[at.col] ?? null) : `=${formula}`
    } else if (workbook !== null) {
      input.value = inputTextAt(sheet, editState.edits, at.row, at.col, workbook.date1904)
    }
    input.readOnly = lock !== null
    if (lock !== null) input.title = vt(LOCK_MESSAGES[lock])
    const original = input.value
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.isComposing) return
      if (event.key === 'Enter' && !input.readOnly) {
        event.preventDefault()
        if (commitInput(at.row, at.col, input.value)) moveSelection(1, 0)
        else renderWorkbook()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        input.value = original
        focusGrid()
      }
    })
  }
  bar.append(ref, input)
  return bar
}

/** Draw the xlsx (tabs + formula bar + table + the "more" button). Called on a sheet switch, showing more, a language change and every edit. */
function renderWorkbook(): void {
  if (root === null || workbook === null) return
  const book = workbook
  const scrollTop = root.querySelector('.office-sheet-scroll')?.scrollTop ?? 0
  const scrollLeft = root.querySelector('.office-sheet-scroll')?.scrollLeft ?? 0
  root.textContent = ''

  if (book.sheets.length > 1) {
    const tabs = document.createElement('div')
    tabs.className = 'toolbar office-tabs'
    tabs.setAttribute('role', 'tablist')
    book.sheets.forEach((sheet, index) => {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(index === activeSheet))
      tab.textContent = sheet.name
      if (index === activeSheet) tab.className = 'active'
      tab.addEventListener('click', () => {
        if (activeSheet === index) return
        activeSheet = index
        selection = null
        editing = null
        notice = null
        renderWorkbook()
        root.querySelector('.office-sheet-scroll')?.scrollTo(0, 0)
      })
      tabs.append(tab)
    })
    root.append(tabs)
  }

  const sheet = book.sheets[activeSheet]
  const saved = sheetWindows[activeSheet]
  if (sheet === undefined || saved === undefined) return
  const rows = displayRows(sheet, editState.edits, book.date1904)
  const view = fitWindow(saved, extentWithMargin(rows))
  sheetWindows[activeSheet] = view

  if (editable) root.append(renderFormulaBar())
  if (notice !== null) {
    const line = document.createElement('div')
    line.className = 'office-notice'
    line.setAttribute('role', 'status')
    line.textContent = notice
    root.append(line)
  }
  const stale = editState.edits.length === 0 ? new Set<string>() : staleKeys(book, formulaCells, editState.edits)
  if (stale.size > 0) {
    const line = document.createElement('div')
    line.className = 'office-notice stale'
    line.textContent = vt('staleValues', { count: stale.size })
    root.append(line)
  }

  if (view.extent.rows === 0 || view.extent.columns === 0) {
    const empty = document.createElement('div')
    empty.className = 'message'
    empty.textContent = vt('sheetEmpty')
    root.append(empty)
    find.refresh()
    return
  }

  const edited = new Set(editState.edits.filter((e) => e.sheet === sheet.path).map((e) => e.ref))
  const staleTitle = vt('staleCell')
  const uncomputedTitle = vt('cellNotComputed')
  const anyUncomputed = [...sheet.facts.formulas.values()].some((fact) => !fact.computed)
  const scroll = document.createElement('div')
  scroll.className = 'office-sheet-scroll'
  // To receive key operations for the selected cell (arrows, typing).
  if (editable) scroll.tabIndex = 0
  const table = renderSheetTable(document, rows, view, undefined, (td, row, col) => {
    if (!editable && stale.size === 0 && !anyUncomputed) return
    td.dataset.row = String(row)
    td.dataset.col = String(col)
    if (edited.has(formatRef(row, col))) td.classList.add('office-edited')
    if (stale.size > 0 && isStale(stale, sheet, row, col)) {
      td.classList.add('office-stale')
      td.title = staleTitle
    } else if (anyUncomputed && isUncomputed(sheet, editState.edits, row, col)) {
      td.classList.add('office-stale')
      td.title = uncomputedTitle
    }
    if (editing !== null && editing.row === row && editing.col === col) {
      td.classList.add('office-editing')
      td.textContent = ''
      td.append(cellInput(editing.initial))
    } else if (selection !== null && selection.row === row && selection.col === col) {
      td.classList.add('office-selected')
    }
  })
  if (editable) {
    table.classList.add('editable')
    table.addEventListener('click', (event) => {
      const td = (event.target as Element | null)?.closest('td')
      if (td === null || td === undefined || td.dataset.row === undefined) return
      if (td.classList.contains('office-editing')) return
      selection = { row: Number(td.dataset.row), col: Number(td.dataset.col) }
      notice = null
      renderWorkbook()
      focusGrid()
    })
    table.addEventListener('dblclick', (event) => {
      const td = (event.target as Element | null)?.closest('td')
      if (td === null || td === undefined || td.dataset.row === undefined) return
      if (td.classList.contains('office-editing')) return
      startEditing(Number(td.dataset.row), Number(td.dataset.col))
    })
  }
  scroll.append(table)
  root.append(scroll)
  root.append(
    renderSheetFooter(document, view, (next) => {
      sheetWindows[activeSheet] = next
      renderWorkbook()
    })
  )
  scroll.scrollTop = scrollTop
  scroll.scrollLeft = scrollLeft
  find.refresh()
}

/** Keys above the table (only when editable). Keys inside input fields (search, formula bar, cell) are ignored. */
document.addEventListener('keydown', (event) => {
  if (!editable || workbook === null || event.defaultPrevented || event.isComposing) return
  const target = event.target as Element | null
  if (target?.closest?.('input, textarea, [contenteditable="true"]')) return
  const mod = event.metaKey || event.ctrlKey
  if (mod && !event.altKey && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    changeEdits(event.shiftKey ? redoEdit(editState) : undoEdit(editState))
    return
  }
  if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    changeEdits(redoEdit(editState))
    return
  }
  if (mod || event.altKey) return
  const moves: Record<string, readonly [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1]
  }
  const move = moves[event.key]
  if (move !== undefined) {
    event.preventDefault()
    moveSelection(move[0], move[1])
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    moveSelection(0, event.shiftKey ? -1 : 1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    moveSelection(event.shiftKey ? -1 : 1, 0)
    return
  }
  if (selection === null) return
  if (event.key === 'F2') {
    event.preventDefault()
    startEditing(selection.row, selection.col)
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    if (commitInput(selection.row, selection.col, '')) notice = null
    renderWorkbook()
    focusGrid()
    return
  }
  if (event.key.length === 1) {
    // Start input by typing (starting from that character).
    event.preventDefault()
    startEditing(selection.row, selection.col, event.key)
  }
})

/** The view kept when the same file is reread (after a save): the sheet, the selected cell and the range. */
interface KeepView {
  readonly sheetPath: string
  readonly selection: { row: number; col: number } | null
  readonly window: SheetWindow
}

async function showXlsx(bytes: ArrayBuffer, gen: number, draft: string | null, keep: KeepView | null): Promise<void> {
  const book = await readWorkbook(bytes)
  if (gen !== generation) return
  workbook = book
  formulaCells = formulaCellsOf(book)
  const kept = keep === null ? -1 : book.sheets.findIndex((sheet) => sheet.path === keep.sheetPath)
  activeSheet = kept >= 0 ? kept : 0
  selection = kept >= 0 ? (keep?.selection ?? null) : null
  editing = null
  notice = null
  sheetWindows = book.sheets.map((sheet, index) =>
    index === kept && keep !== null ? keep.window : initialWindow(sheetExtent(sheet.rows))
  )
  // Apply the restored draft (from the host's table). Edits this workbook cannot write are dropped, and if any were dropped, resend.
  const parsed = draft === null ? [] : (parseCellEdits(draft) ?? [])
  const usable = editable ? usableEdits(book, parsed) : []
  editState = { edits: usable, undo: [], redo: [] }
  if (draft !== null && draft !== '' && serializeCellEdits(usable) !== draft) reportEdits()
  if (book.sheets.length === 0) {
    message(vt('sheetEmpty'))
    return
  }
  renderWorkbook()
}

bridge.onResource((event) => {
  if (root === null) return
  const resource = event.resource
  const kind = officeKindOf(event.uri)
  const key =
    resource.kind === 'binary'
      ? `${event.uri}\n${resource.resourceUrl}\n${resource.size}\n${event.revision ?? ''}`
      : ''
  if (key !== '' && key === loadedKey) {
    // A resend of only the theme or language. Do not reread; swap only the xlsx wording.
    if (workbook !== null) renderWorkbook()
    return
  }

  generation++
  const gen = generation
  if (uri !== '' && uri !== event.uri) bridge.reportSelection(uri, null)
  // A reread of the same file (after a save) keeps the sheet, the selected cell and the range, and does not insert "loading".
  const sameFile = uri === event.uri && workbook !== null
  const activeSheetNow = workbook?.sheets[activeSheet]
  const windowNow = sheetWindows[activeSheet]
  const keep: KeepView | null =
    sameFile && activeSheetNow !== undefined && windowNow !== undefined
      ? { sheetPath: activeSheetNow.path, selection, window: windowNow }
      : null
  uri = event.uri
  loadedKey = ''
  editable = event.editable && kind === 'xlsx'
  if (!sameFile) {
    workbook = null
    sheetWindows = []
  }
  editState = EMPTY_EDIT_STATE
  editing = null

  if (resource.kind === 'error') {
    message(vt('cannotOpen', { reason: resource.message }))
    return
  }
  if (resource.kind !== 'binary' || kind === null) {
    message(vt('notOffice'))
    return
  }
  if (resource.size > MAX_OFFICE_BYTES) {
    message(
      vt('officeTooLarge', {
        size: (resource.size / 1024 / 1024).toFixed(1),
        limit: MAX_OFFICE_BYTES / 1024 / 1024
      })
    )
    return
  }

  loadedKey = key
  if (!sameFile) message(vt('officeLoading'))
  void (async () => {
    try {
      const bytes = await fetchBytes(resource.resourceUrl)
      if (gen !== generation) return
      if (kind === 'docx') await showDocx(bytes, gen)
      else await showXlsx(bytes, gen, event.draft, keep)
    } catch (err) {
      if (gen !== generation) return
      // A version that failed is not remembered (the next resend rereads it). The body is not logged.
      loadedKey = ''
      message(vt('cannotOpen', { reason: reasonOf(err) }))
    }
  })()
})
