/**
 * `aios.text` — text and code in general (ARCHITECTURE.md 7.3 / 7.4).
 *
 * **In Phase 4 this was moved from a React component of the renderer to a plugin in an isolated iframe.**
 * The host reads the contents through the Broker and passes them in.
 * This code touches neither fs nor net (the boundary check verifies that mechanically).
 *
 * `.csv` / `.tsv` (TODO 1215, wave 83): the host heading's switch toggles between Table (a read-only table) and Text (the editor as before).
 * The default when opened is the table, and the last choice is remembered while the iframe lives (`sheet-mode.ts`). The table is drawn from
 * the editor's current contents (including the draft), and the editor is only hidden, not rebuilt — switching does not touch
 * the body, draft, undo or cursor (just showing the table does not make it dirty). The table parts are shared with `aios.office`'s `.xlsx` (`_shared/sheet-view.ts`).
 */
import '@pluginshared/viewer.css'
import { connect } from '@pluginshared/bridge.js'
import { createEditor, type Editor } from '@pluginshared/editor.js'
import { vt } from '@pluginshared/i18n.js'
import { planResource, receivedOf, refreshEditor, type ReceivedResource } from '@pluginshared/resource-update.js'
import { createDomFind, isFindKey } from '@pluginshared/dom-find.js'
import { createDomHits, type DomHits } from '@pluginshared/dom-highlight.js'
import { plainSelection } from '@pluginshared/selection.js'
import { tableRowsOf, type CsvDelimiter } from '@pluginshared/csv.js'
import { initialWindow, isNumericTextCell, sheetExtent, type SheetWindow } from '@pluginshared/sheet.js'
import { renderSheetFooter, renderSheetTable } from '@pluginshared/sheet-view.js'
import { isViewerSheetMode } from '@shared/viewer-view-mode.js'
import { INITIAL_SHEET_MODE, SHEET_VIEW_MODES, delimiterOf, sheetAcceptsInsert, type SheetMode } from './sheet-mode.js'

const bridge = connect('aios.text')
const root = document.getElementById('root')
let editor: Editor | null = null
/** The element holding the editor. Hidden while the table is shown (not rebuilt). */
let editorHost: HTMLDivElement | null = null
/** The note for large files. Kept so the wording can be swapped when only the language changes. */
let banner: HTMLDivElement | null = null
/** The file being shown. Attached to selection reports (item 97). */
let uri = ''
/** The `resource` received last (items 303 / 309-2). So that a resend of the same file does not replace the body. */
let received: ReceivedResource | null = null

// ---- The .csv / .tsv table (TODO 1215) ----
/**
 * The view the user last chose with the heading's switch (remembered). The next `.csv` / `.tsv` opens with it: the table when first opened,
 * and the last choice is remembered (owner decision 2026-11-12). Jumping to a line showing Text does not change the memory (code-review Y5).
 */
let preferredSheetMode: SheetMode = INITIAL_SHEET_MODE
/** The view currently shown for the file being shown. Moving to another file returns it to `preferredSheetMode`. */
let sheetMode: SheetMode = INITIAL_SHEET_MODE
/** The delimiter of the file being shown. null for files that are not shown as a table. */
let delimiter: CsvDelimiter | null = null
/** The host passed only the head (the table drops the last row, which may be cut off). */
let truncated = false
/** The host's search term (used for the table's highlight). */
let highlightQuery: string | null = null
/** The table's frame (a vertical flex; the place for the search window and the hit box). It is in root only while the table is shown. */
const sheetPane = document.createElement('div')
sheetPane.className = 'sheet-pane'
/** The body and rows that were made into a table (the same body is not reread). */
let sheetText: string | null = null
let sheetRows: string[][] = []
/** The range currently drawn (widened with "show more"). Returned to the start for another file. */
let sheetWindow: SheetWindow | null = null
/** The table's search-term highlight (the same part as Markdown's Preview, TODO 445). */
let tableHits: DomHits | null = null
/** Whether the switch was reported to the host for this file (when moving to a file that is not a table, clear it with an empty list). */
let viewModesShown = false

function tableShown(): boolean {
  return delimiter !== null && sheetMode === 'table'
}

/** In-document search for the table (the same part as TODO 819 / 1110). Text has CodeMirror's search, so only while the table is shown. */
const find = createDomFind({
  host: sheetPane,
  target: () => (tableShown() ? sheetPane.querySelector<HTMLElement>('.office-sheet-scroll') : null),
  onClose: () => {
    if (tableShown() && !find.isOpen()) tableHits?.apply(highlightQuery, { scroll: false })
  }
})
document.addEventListener('keydown', (event) => {
  if (!tableShown() || !isFindKey(event)) return
  // While the window is open, remove the host's highlight (because the same `<mark>` is used; restored by `onClose` when it closes).
  if (!find.isOpen()) tableHits?.apply(null)
  if (find.handleKey(event)) event.preventDefault()
})

/** Report the selection inside the table (item 97). No lines are attached (table cells cannot be mapped back to original lines). The editor reports the Text selection. */
document.addEventListener('selectionchange', () => {
  if (uri === '' || !tableShown()) return
  const selection = document.getSelection()
  const body = sheetPane.querySelector('.office-sheet-scroll')
  const inside =
    selection !== null && body !== null && selection.anchorNode !== null && body.contains(selection.anchorNode)
  bridge.reportSelection(uri, inside ? plainSelection(selection.toString()) : null)
})

function clearTable(): void {
  tableHits?.destroy()
  tableHits = null
  find.close()
  sheetPane.textContent = ''
  sheetPane.remove()
}

function reset(): void {
  editor?.destroy()
  editor = null
  editorHost = null
  banner = null
  clearTable()
  sheetText = null
  sheetRows = []
  sheetWindow = null
  if (root !== null) root.textContent = ''
}

/** Show / remove the "only the head is shown" band to match the contents, or reapply the wording (TODO 1130). Placed before the editor's host element. */
function syncBanner(truncated: boolean): void {
  if (!truncated) {
    banner?.remove()
    banner = null
    return
  }
  if (banner === null) {
    banner = document.createElement('div')
    banner.className = 'banner'
    root?.prepend(banner)
  }
  banner.textContent = vt('truncated')
}

function message(text: string): void {
  reset()
  hideViewModes()
  delimiter = null
  const div = document.createElement('div')
  div.className = 'message'
  div.textContent = text
  root?.append(div)
}

/** Clear the switch if it was shown (files that are not tables, or files that cannot be opened). */
function hideViewModes(): void {
  if (!viewModesShown) return
  viewModesShown = false
  bridge.reportViewModes(uri, [], 'text')
}

/** If the body changed, reread it and fit the range to the body (the widened part is kept). */
function prepareRows(text: string): SheetWindow {
  if (text !== sheetText || sheetWindow === null || delimiter === null) {
    sheetRows = delimiter === null ? [] : tableRowsOf(text, delimiter, truncated)
    sheetText = text
    const extent = sheetExtent(sheetRows)
    const initial = initialWindow(extent)
    sheetWindow =
      sheetWindow === null
        ? initial
        : {
            extent,
            shownRows: Math.min(extent.rows, Math.max(initial.shownRows, sheetWindow.shownRows)),
            shownColumns: Math.min(extent.columns, Math.max(initial.shownColumns, sheetWindow.shownColumns))
          }
  }
  return sheetWindow
}

/**
 * Draw the table. If `fresh` (another file, switched to the table, or the search term changed), move to the first match of the host's search term.
 * A redraw (show more, or a theme / language resend) keeps the scroll position.
 */
function renderTable(fresh: boolean): void {
  if (root === null) return
  const view = prepareRows(editor?.getValue() ?? '')
  const old = sheetPane.querySelector('.office-sheet-scroll')
  const scrollTop = fresh ? 0 : (old?.scrollTop ?? 0)
  const scrollLeft = fresh ? 0 : (old?.scrollLeft ?? 0)
  tableHits?.destroy()
  tableHits = null
  sheetPane.textContent = ''
  if (sheetPane.parentElement !== root) root.append(sheetPane)

  if (view.extent.rows === 0 || view.extent.columns === 0) {
    const empty = document.createElement('div')
    empty.className = 'message'
    empty.textContent = vt('tableEmpty')
    sheetPane.append(empty)
    find.refresh()
    return
  }

  const scroll = document.createElement('div')
  scroll.className = 'office-sheet-scroll'
  scroll.append(renderSheetTable(document, sheetRows, view, isNumericTextCell))
  sheetPane.append(scroll)
  sheetPane.append(
    renderSheetFooter(document, view, (next) => {
      sheetWindow = next
      renderTable(false)
    })
  )
  scroll.scrollTop = scrollTop
  scroll.scrollLeft = scrollLeft
  // The position used to go back with the left / right arrows (TODO 1146, the scroll amount, same as Markdown's Preview).
  scroll.addEventListener('scroll', () => bridge.reportScrollPosition(uri, { kind: 'offset', value: scroll.scrollTop }), {
    passive: true
  })
  tableHits = createDomHits(scroll, sheetPane)
  if (!find.isOpen()) tableHits.apply(highlightQuery, fresh ? {} : { scroll: false })
  find.refresh()
}

/** Apply the current view (Table / Text). The switch report and whether drop is possible are also resent. */
function applySheetMode(fresh: boolean): void {
  if (delimiter === null) return
  const table = sheetMode === 'table'
  if (editorHost !== null) editorHost.style.display = table ? 'none' : ''
  bridge.reportViewModes(uri, SHEET_VIEW_MODES, sheetMode)
  viewModesShown = true
  // While the table is shown, drop insertion is not accepted (the host makes drop fall back to "open", TODO 587).
  bridge.reportAcceptsEdits(uri, sheetAcceptsInsert(sheetMode))
  if (table) renderTable(fresh)
  else clearTable()
}

/**
 * Call after applying `resource` to the editor. For `.csv` / `.tsv`, apply the view (Table / Text); otherwise remove the table and show the editor.
 * `newFile` is when moving to another file (the widened range returns to the start). `fresh` is for another file or a changed search term
 * (draw the table from the top and move to the first match of the search term. A reread after an outside rewrite keeps the scroll).
 */
function syncSheet(name: string, isTruncated: boolean, newFile: boolean, fresh: boolean): void {
  const next = delimiterOf(name)
  truncated = isTruncated
  if (newFile) {
    sheetWindow = null
    sheetText = null
    // Another file opens with the view the user last chose (do not carry over the Text that a jump to a line in the previous file produced).
    sheetMode = preferredSheetMode
  }
  if (next === null) {
    delimiter = null
    if (editorHost !== null) editorHost.style.display = ''
    clearTable()
    hideViewModes()
    return
  }
  delimiter = next
  applySheetMode(fresh)
}

/**
 * If the table is shown, switch to Text (jumping to a line and restoring a line position are possible only in the editor).
 * **Only for this file's view** — the memory of the user's choice (`preferredSheetMode`) is not changed, so the next `.csv` stays a table.
 */
function showTextForLine(): void {
  if (!tableShown()) return
  sheetMode = 'text'
  applySheetMode(false)
  if (uri !== '') bridge.reportSelection(uri, null)
}

bridge.onResource((event) => {
  // Switched to another file. Do not leave the previous file's selection (item 97).
  if (event.uri !== uri) bridge.reportSelection(event.uri, null)
  uri = event.uri
  const prev = received
  const next = receivedOf(event)
  received = next
  if (event.resource.kind === 'error') {
    message(
      event.resource.message === 'binary'
        ? vt('binary')
        : vt('cannotOpen', { reason: event.resource.message })
    )
    return
  }
  if (event.resource.kind !== 'text') {
    message(vt('notText'))
    return
  }

  const resource = event.resource
  const readOnly = resource.truncated || !event.editable
  const newFile = prev === null || prev.uri !== next.uri
  const queryChanged = prev === null || prev.highlightQuery !== next.highlightQuery
  highlightQuery = event.highlightQuery
  // The table's name is the host's `label` (the URI is empty for a temporary view inside an archive).
  const name = event.label !== '' ? event.label : event.uri

  if (editor !== null && prev !== null && planResource(prev, next, editor.getValue()) === 'keep') {
    // A resend for the same file (theme, language, search term, `ready`, items 303 / 309-2). The body is not touched, so
    // the draft, cursor, line marks (item 273) and scroll stay. Only the look is reapplied.
    refreshEditor(editor, prev, next, { readOnly, theme: event.theme })
    // Keys for go to declaration and for assignments / usages (TODO 692). When changed in settings, they arrive on a resend.
    editor.setEditorKeys(event.editorKeys)
    syncBanner(resource.truncated)
    syncSheet(name, resource.truncated, false, queryChanged)
    return
  }

  if (editor !== null) {
    // Switched to another file with the same viewer (or the contents were reread). Do not rebuild.
    // If the host remembered a draft (TODO 312), show it.
    // For another file, empty the undo history (TODO 1112: with Cmd+Z the previous file's body became the draft).
    editor.setValue(event.draft ?? resource.text, { resetHistory: newFile })
    editor.setReadOnly(readOnly)
    editor.setFilename(event.label)
    editor.setTheme(event.theme)
    editor.setHighlight(event.highlightQuery)
    editor.setEditorKeys(event.editorKeys)
    syncBanner(resource.truncated)
    syncSheet(name, resource.truncated, newFile, newFile || queryChanged)
    return
  }

  reset()
  const host = document.createElement('div')
  host.className = 'editor'
  editorHost = host
  root?.append(host)
  syncBanner(resource.truncated)
  editor = createEditor(host, {
    value: event.draft ?? resource.text,
    filename: event.label,
    readOnly,
    theme: event.theme,
    onChange: (next) => bridge.reportDraft(uri, next),
    onSelection: (selection) => bridge.reportSelection(uri, selection),
    // The list of symbols (TODO 468). Every time the language is applied again, tell the host whether to show the heading's button.
    onSymbolsAvailable: (available) => bridge.reportSymbols(uri, available),
    // Go to declaration (F12), list assignments and usages (Shift+F12), highlight the same variable (TODO 692).
    codeNav: true,
    // The top line of the screen (TODO 1146). The host remembers it together with the left / right arrow history and returns it with `onRestorePosition` on going back.
    onTopLine: (line) => bridge.reportScrollPosition(uri, { kind: 'line', value: line })
  })
  editor.setHighlight(event.highlightQuery)
  editor.setEditorKeys(event.editorKeys)
  syncSheet(name, resource.truncated, true, true)
})

// Jump to a line (item 273). The host sends it only once after `resource`. When no body is shown
// (binary or an error), there is no editor, so do nothing. If the table is shown, switch to Text first and then jump
// (same as `aios.markdown`'s Preview). The switch is only for this file's view, and the next `.csv` returns to the remembered view.
// A reveal addressed to the previous file (a race in switching) is discarded (the same check as `aios.markdown`).
bridge.onReveal((event) => {
  if (editor === null || event.uri !== uri) return
  showTextForLine()
  editor.revealLine(event.line, event.column)
})

// The position previously viewed in a document returned to with the left / right arrows (TODO 1146). The host sends it only once after `resource`. The editor clamps the line to the range of the body
// (the last line if the line count shrank after an outside rewrite). For the table it is the scroll amount. A position that is not in the current view's unit is not used.
bridge.onRestorePosition((event) => {
  if (event.position.kind === 'line' && !tableShown()) editor?.restoreTopLine(event.position.value)
  else if (event.position.kind === 'offset' && tableShown()) {
    const scroll = sheetPane.querySelector<HTMLElement>('.office-sheet-scroll')
    if (scroll === null) return
    tableHits?.disarm()
    scroll.scrollTop = event.position.value
  }
})

// The same search hit was pressed again (TODO 446). Applying the current search term again makes the first match in the document the current match and centers it.
bridge.onRecenter(() => {
  if (tableShown()) {
    if (!find.isOpen()) tableHits?.apply(highlightQuery)
    return
  }
  editor?.setHighlight(received?.highlightQuery ?? null)
})

// The raw full path of a dropped file (TODO 366 / 407. The format is decided by the host). Inserted at the caret.
// If read-only (a large file, or one that cannot be saved), the editor refuses. It is not inserted while the table is shown.
bridge.onInsertText((event) => {
  if (event.uri !== uri || tableShown()) return
  editor?.insertText(event.text)
})

// The heading's "go to symbol" (TODO 468). Cmd+R / Ctrl+R is taken directly by the editor's keymap.
bridge.onOpenSymbols(() => {
  if (tableShown()) return
  editor?.openSymbols()
})

// "Go to declaration" / "list assignments and usages" in the right-click menu (TODO 692). F12 / Shift+F12 are taken directly by the editor's keymap.
bridge.onCodeNav((action) => {
  if (tableShown()) return
  editor?.runCodeNav(action)
})
bridge.setContextMenuProbe((event) =>
  tableShown() ? { codeNav: false, keepSelection: true } : (editor?.probeContextMenu(event) ?? { codeNav: false, keepSelection: true })
)

// The heading's "view switch" (TODO 1215, the same entry point as 969). Redraw with the chosen view (the redraw resends `view-modes`).
// The choice is also used for the next `.csv` / `.tsv` (while the iframe lives).
bridge.onSetViewMode((next) => {
  if (delimiter === null || !isViewerSheetMode(next)) return
  // Remember what the user chose (even if it is the same as the current view — e.g. it became Text by a jump to a line and Text was pressed again).
  preferredSheetMode = next
  if (next === sheetMode) {
    // Report again even for the same value (the host's mark runs only on the viewer's report, 7.4.12).
    bridge.reportViewModes(uri, SHEET_VIEW_MODES, sheetMode)
    return
  }
  sheetMode = next
  if (uri !== '') bridge.reportSelection(uri, null)
  applySheetMode(true)
})
