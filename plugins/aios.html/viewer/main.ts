/**
 * `aios.html` — local `.html` / `.htm` files (TODO 401, ARCHITECTURE.md 7.4.10).
 *
 * The same Source / Preview switch as `aios.markdown` (it opens in Preview). The switch buttons are drawn by the host's heading (TODO 969, 7.4.12).
 *
 * - **Preview**: a further `<iframe sandbox="">` is placed inside this iframe and drawn with `srcdoc`. The contents have passed through `buildPreviewDocument`
 *   in `preview.ts` (DOMPurify + a CSP at the top); scripts do not run, and not a single external or other file
 *   (including images and CSS in the same folder) is loaded. The nested document is a separate origin, so the selection report
 *   (item 97), search-term highlighting (TODO 56) and link interception do not work in Preview.
 * - **Source**: the same CodeMirror as `aios.text` (`@pluginshared/editor.js`). Editing, saving, drafts (TODO 312),
 *   `highlightQuery`, jumping to a line (item 273) and drop `insert-text` (TODO 366 / 407) behave the same as `aios.text`.
 *
 * The body changed in Source is redrawn when switching to Preview (so you see it as a draft).
 */
import '@pluginshared/viewer.css'
import './html.css'
import { connect } from '@pluginshared/bridge.js'
import { isViewerDisplayMode } from '@shared/viewer-view-mode.js'
import { createEditor, type Editor } from '@pluginshared/editor.js'
import { vt } from '@pluginshared/i18n.js'
import { planResource, receivedOf, refreshEditor, type ReceivedResource } from '@pluginshared/resource-update.js'
import type { Theme } from '@shared/theme.js'
import { INITIAL_MODE, VIEW_MODES, acceptsInsert, revealNeedsRender, type HtmlMode } from './mode.js'
import { hasExternalReferences } from './external.js'
import { PREVIEW_SANDBOX, buildPreviewDocument } from './preview.js'

const bridge = connect('aios.html')
const root = document.getElementById('root')
let mode: HtmlMode = INITIAL_MODE
/** The current body (including the draft from Source). */
let source = ''
/** Whether it can be saved (the host's `editable`). Read-only when only the head of a large file was loaded. */
let editable = false
let truncated = false
let uri = ''
let label = 'index.html'
let theme: Theme = 'light'
let highlightQuery: string | null = null
let editor: Editor | null = null
/** The `resource` received last (items 309-2 / 303). So that a resend of the same file does not redraw. */
let received: ReceivedResource | null = null
let banner: HTMLDivElement | null = null
/** The URI of the file whose external-reference banner was closed (TODO 1074). Only for that file, and not persisted. */
let dismissedUri: string | null = null

function relabel(): void {
  if (banner !== null) banner.textContent = vt('truncated')
}

function readOnly(): boolean {
  return truncated || !editable
}

function message(text: string): void {
  editor?.destroy()
  editor = null
  banner = null
  // When it cannot be opened or is not text, the heading shows no switch (TODO 969).
  bridge.reportViewModes(uri, [], mode)
  if (root === null) return
  root.textContent = ''
  const div = document.createElement('div')
  div.className = 'message'
  div.textContent = text
  root.append(div)
}

/** The banner shown when there are external scripts / stylesheets (TODO 1074). "Open in browser" goes through the host (`open-default-app`). */
function externalBanner(): HTMLDivElement {
  const bar = document.createElement('div')
  bar.className = 'ext-banner'
  const text = document.createElement('span')
  text.className = 'ext-banner-text'
  text.textContent = vt('htmlExternalScripts')
  const open = document.createElement('button')
  open.type = 'button'
  open.textContent = vt('htmlOpenInBrowser')
  open.addEventListener('click', () => bridge.openDefaultApp(uri))
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = vt('htmlDismiss')
  close.addEventListener('click', () => {
    dismissedUri = uri
    bar.remove()
  })
  bar.append(text, open, close)
  return bar
}

function render(): void {
  if (root === null) return
  editor?.destroy()
  editor = null
  root.textContent = ''
  banner = null
  // Redrawing drops the selection (switching the view, or another file).
  if (uri !== '') bridge.reportSelection(uri, null)
  // Preview does not accept drop insertion, so tell the host to make drop fall back to "open" (TODO 587, same as aios.markdown).
  if (uri !== '') bridge.reportAcceptsEdits(uri, mode === 'source')

  // The host's heading draws the Preview / Source switch (TODO 969, 7.4.12). Here we only report the current view.
  bridge.reportViewModes(uri, VIEW_MODES, mode)

  if (truncated) {
    banner = document.createElement('div')
    banner.className = 'banner'
    banner.textContent = vt('truncated')
    root.append(banner)
  }

  if (mode === 'preview') {
    if (uri !== '' && dismissedUri !== uri && hasExternalReferences(source)) root.append(externalBanner())
    const frame = document.createElement('iframe')
    frame.className = 'html-preview'
    // Set sandbox before srcdoc (so loading does not start before it is set).
    frame.setAttribute('sandbox', PREVIEW_SANDBOX)
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.title = label
    frame.srcdoc = buildPreviewDocument(source)
    root.append(frame)
    return
  }

  const host = document.createElement('div')
  host.className = 'editor'
  root.append(host)
  editor = createEditor(host, {
    value: source,
    filename: label,
    readOnly: readOnly(),
    theme,
    onChange: (next) => {
      source = next
      bridge.reportDraft(uri, next)
    },
    onSelection: (selection) => bridge.reportSelection(uri, selection)
  })
  editor.setHighlight(highlightQuery)
}

bridge.onResource((event) => {
  // Switched to another file. Do not leave the previous file's selection (item 97).
  if (event.uri !== uri && uri !== '') bridge.reportSelection(uri, null)
  const prev = received
  const next = receivedOf(event)
  received = next
  uri = event.uri
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
  editable = event.editable
  truncated = event.resource.truncated
  label = event.label
  theme = event.theme
  highlightQuery = event.highlightQuery
  // If it is a resend of the same version of the same file (theme, language, search term, `ready`), do not redraw. The draft, cursor,
  // line marks and the Preview scroll stay (items 303 / 309-2).
  if (prev !== null && planResource(prev, next, source) === 'keep') {
    if (editor !== null) refreshEditor(editor, prev, next, { readOnly: readOnly(), theme })
    relabel()
    return
  }
  // If the host remembered a draft (TODO 312), show it.
  source = event.draft ?? event.resource.text
  render()
})

/** Jump to a line (item 273). In Preview, switch to Source first, then jump (same as `aios.markdown`). */
bridge.onReveal((event) => {
  if (root === null || event.uri !== uri) return
  if (revealNeedsRender(mode, editor !== null)) {
    mode = 'source'
    render()
  }
  editor?.revealLine(event.line, event.column)
})

/** The same search hit was pressed again (TODO 446). In Source, reapply the current search term and center the first match. Preview does not flash. */
bridge.onRecenter(() => {
  editor?.setHighlight(highlightQuery)
})

/** The heading's "view switch" (TODO 969). Redraw with the chosen view (the redraw resends `view-modes`). */
bridge.onSetViewMode((next) => {
  if (root === null || !isViewerDisplayMode(next) || next === mode) return
  mode = next
  render()
})

/** The raw full path of a dropped file (TODO 366 / 407). Insert at the caret only when Source is editable. */
bridge.onInsertText((event) => {
  if (event.uri !== uri || !acceptsInsert(mode, !readOnly())) return
  editor?.insertText(event.text)
})
