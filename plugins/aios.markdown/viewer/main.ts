/**
 * `aios.markdown` — `.md` (ARCHITECTURE.md 7.4).
 *
 * The renderer is **shared** with ThreadPane (`@shared/markdown/render.ts`, 5.1).
 * No second code path is made. Output goes through markdown-it (`html: false`) -> DOMPurify.
 *
 * The list of headings is sent to a **plugin-host command** (`command` in 7.1).
 * This way, in ordinary use every time, it is exercised that the viewer itself does not read files and that the plugin-host
 * can read only through the Broker.
 *
 * Heading list (item 318): shown below the body in both Preview and Source; pressing a row jumps to that heading (in Preview, scroll to the
 * heading element of the body; in Source, to that line of the editor). The heading currently being read is highlighted (Preview uses
 * `IntersectionObserver`, Source uses the cursor line). The list's headings carry line numbers and are matched to the body's headings by line number.
 * When there is a draft (a body rewritten in Source), the Broker's reread (= the body on disk) would put the lines out of place, so
 * the same extraction (`@shared/markdown/headings.ts`) applied to the current body is used. Details in `outline.ts`.
 */
import { renderMarkdown } from '@shared/markdown/render.js'
import { extractHeadings, type Heading } from '@shared/markdown/headings.js'
import { viewerLinkAction } from '@shared/link.js'
import '@pluginshared/viewer.css'
import { connect } from '@pluginshared/bridge.js'
import { isViewerDisplayMode } from '@shared/viewer-view-mode.js'
import { createEditor, type Editor } from '@pluginshared/editor.js'
import { createDomHits, type DomHits } from '@pluginshared/dom-highlight.js'
import { createDomFind, isFindKey } from '@pluginshared/dom-find.js'
import { attachCopyButtons } from '@pluginshared/copy.js'
import { vt } from '@pluginshared/i18n.js'
import { plainSelection } from '@pluginshared/selection.js'
import { planResource, receivedOf, refreshEditor, type ReceivedResource } from '@pluginshared/resource-update.js'
import type { Theme } from '@shared/theme.js'
import { OutlineGuard } from './outline-guard.js'
import { OutlineView, findHeadingElement, followPreview } from './outline.js'
import { revealNeedsRender, type MarkdownMode } from './reveal-mode.js'

/** The views shown in the heading's switch (TODO 969). The order is the same as the earlier second-row buttons. */
const VIEW_MODES: readonly MarkdownMode[] = ['preview', 'source']

const bridge = connect('aios.markdown')
const root = document.getElementById('root')
let mode: MarkdownMode = 'preview'
let source = ''
let editable = false
let uri = ''
let theme: Theme = 'light'
let highlightQuery: string | null = null
let editor: Editor | null = null
/** The Preview search-term highlight and the hit box (TODO 445). Only while Preview is drawn. */
let previewHits: DomHits | null = null
/**
 * In-document search for Preview (TODO 1110, dom-find.ts). Only while in Preview, since Source has CodeMirror's search.
 * It uses the same body and the same `<mark>` as the host's search-term highlight (`previewHits`), so while the window is open
 * the host's highlight is removed (before opening) and restored when it closes.
 */
const find = createDomFind({
  host: root ?? document.body,
  target: () => (mode === 'preview' ? (root?.querySelector<HTMLElement>('.markdown-body') ?? null) : null),
  onClose: () => {
    // It only closes and restores, so do not jump to the center (Esc must not move to the host's first match); keep the number from before opening.
    if (mode === 'preview') {
      previewHits?.apply(highlightQuery, { scroll: false, ...(hitIndexBeforeFind > 0 ? { keepIndex: hitIndexBeforeFind } : {}) })
    }
  }
})
/** The number of the host's match just before the window opened (1-based, 0 if none). Restored on close. */
let hitIndexBeforeFind = 0
document.addEventListener('keydown', (event) => {
  if (mode !== 'preview' || !isFindKey(event)) return
  if (!find.isOpen()) {
    hitIndexBeforeFind = previewHits?.position().index ?? 0
    previewHits?.apply(null)
  }
  if (find.handleKey(event)) event.preventDefault()
})

/** Generation management for `render()` (item 142, see `outline-guard.ts`). */
const outlineGuard = new OutlineGuard()
/**
 * The `resource` received last (items 309-2 / 303, wave 16 bundle I). On a resend of the same file (theme, language, search term,
 * `ready`) `render()` is not called, which keeps the editor, draft, cursor and line marks.
 */
let received: ReceivedResource | null = null
/** The current heading list (item 318). Rebuilt on every `render()`. */
let outline: OutlineView | null = null
/**
 * The state of this generation's `outline` command. If `failed` (the plugin-host is down), even the headings of a draft are not shown
 * (7.8 "does not spill over into the main app" = only the list does not appear, as before).
 */
let outlineState: 'pending' | 'ready' | 'failed' = 'pending'
/** The entry point that stops Preview's watcher. */
let stopFollow: (() => void) | null = null
/** Throttling for refetching the list from the Source draft. */
let outlineTimer: ReturnType<typeof setTimeout> | null = null
/** The cursor line of Source (used to highlight the list). */
let cursorLine: number | null = null

/** On a resend of the display language, swap only the wording without redrawing. */
function relabel(): void {
  outline?.relabel()
}

/**
 * Links in the body (5.1 "external links"). We are inside an iframe, so **no link is followed by itself**:
 * `http:` / `https:` / `mailto:` ask the host to "open externally" (main revalidates),
 * and `file:`, relative and scheme-less ones ask the host to "open" (item 254. The base is the folder of this .md, and
 * main resolves it). `thread://` (TODO 1161) also asks the host to "open" (the host's `openLinkHref` checks the target exists and jumps). Anything else (an in-page `#heading`) does nothing. The sandbox has
 * neither `allow-popups` nor `allow-top-navigation`, so letting it pass through would do nothing anyway, but it is stopped explicitly.
 */
function onLinkClick(event: MouseEvent): void {
  const anchor = (event.target as Element | null)?.closest('a')
  if (anchor === null || anchor === undefined) return
  event.preventDefault()
  const href = anchor.getAttribute('href')
  const action = viewerLinkAction(href)
  if (href === null || action === 'none') return
  // http(s) goes to ViewerPane via the host; shift / cmd + click goes to the OS browser (TODO 400).
  if (action === 'external')
    bridge.openExternal(href, { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey })
  else bridge.openLink(href)
}

/**
 * The selection in the preview (item 97). A selection inside the drawn HTML cannot be mapped back to original lines, so no lines are attached
 * and only the text is reported. The editor reports a selection in source view with lines.
 */
document.addEventListener('selectionchange', () => {
  if (mode !== 'preview' || uri === '') return
  const selection = document.getSelection()
  const body = root?.querySelector('.markdown-body') ?? null
  const inside =
    selection !== null &&
    body !== null &&
    selection.anchorNode !== null &&
    body.contains(selection.anchorNode)
  bridge.reportSelection(uri, inside ? plainSelection(selection.toString()) : null)
})

function render(): void {
  if (root === null) return
  const gen = outlineGuard.next()
  editor?.destroy()
  editor = null
  previewHits?.destroy()
  previewHits = null
  root.textContent = ''
  // When switching to Source, close the window (do not duplicate CodeMirror's search). A Preview redraw calls `refresh()` below.
  if (mode !== 'preview') find.close()
  stopFollow?.()
  stopFollow = null
  if (outlineTimer !== null) clearTimeout(outlineTimer)
  outlineTimer = null
  outline = null
  outlineState = 'pending'
  cursorLine = null
  // Redrawing drops the selection (switching the view, or another file).
  if (uri !== '') bridge.reportSelection(uri, null)
  // Preview does not accept drop insertion (`onInsertText` below), so tell the host to make drop fall back to "open" (TODO 587).
  // The host decides read-only itself from its own `editable`, so this only reports the view (Source / Preview).
  if (uri !== '') bridge.reportAcceptsEdits(uri, mode === 'source')

  // The host's heading draws the Preview / Source switch (TODO 969, 7.4.12). Here we only report the current view.
  bridge.reportViewModes(uri, VIEW_MODES, mode)

  if (mode === 'preview') {
    const body = document.createElement('div')
    body.className = 'markdown-body'
    // The output of renderMarkdown is a string after DOMPurify (5.1).
    // Put the original line number (`data-line`) on headings — to jump by line number from the list (item 318).
    body.innerHTML = renderMarkdown(source, { headingLines: true }).html
    // Overlay a copy button at the top right of code blocks (5.1.2.1, T25). It is not
    // in the body HTML (DOMPurify drops the button), so attach it after drawing.
    attachCopyButtons(body)
    body.addEventListener('click', onLinkClick)
    // A frame wrapping the body and the box (TODO 445). The box is fixed to the frame's bottom right and does not scroll along with the body (which scrolls).
    const pane = document.createElement('div')
    pane.className = 'preview-pane'
    pane.append(body)
    root.append(pane)
    // Search-term highlight (TODO 56 / 445). Light up the matches in the drawn body and center the first match. Even if the heading list is
    // added below later and the body shrinks, the re-centering watcher (431 (b)) re-centers onto the match we are on.
    previewHits = createDomHits(body, pane)
    // The position used to go back with the left / right arrows (TODO 1146). Report the scroll amount as is (the bridge skips values equal to the throttled one).
    body.addEventListener('scroll', () => bridge.reportScrollPosition(uri, { kind: 'offset', value: body.scrollTop }), {
      passive: true
    })
    if (!find.isOpen()) previewHits.apply(highlightQuery)
    find.refresh()
    void showOutline(gen)
  } else {
    const host = document.createElement('div')
    host.className = 'editor'
    root.append(host)
    editor = createEditor(host, {
      value: source,
      filename: 'doc.md',
      readOnly: !editable,
      theme,
      onChange: (next) => {
        source = next
        bridge.reportDraft(uri, next)
        scheduleDraftOutline()
      },
      onSelection: (selection) => bridge.reportSelection(uri, selection),
      onCursorLine: (line) => {
        cursorLine = line
        outline?.setActiveLine(line)
      },
      // The top line of the screen (TODO 1146, same as `aios.text`).
      onTopLine: (line) => bridge.reportScrollPosition(uri, { kind: 'line', value: line })
    })
    // Search-term highlight (TODO 56). For Preview, `createDomHits` above (TODO 445).
    editor.setHighlight(highlightQuery)
    void showOutline(gen)
  }
}

/**
 * The headings used for the list. If the current body is the same as the body that arrived from the host (= the on-disk body the Broker reread), use
 * the command's result; if there is a draft, use headings extracted again from the current body (so line numbers do not shift, item 318).
 */
function headingsFor(fromCommand: readonly Heading[]): readonly Heading[] {
  return received !== null && source === received.text ? fromCommand : extractHeadings(source)
}

/** A row was pressed (item 318). In Preview, scroll to the heading in the body; in Source, to that line of the editor. */
function pickHeading(heading: Heading): void {
  if (mode === 'preview') {
    const body = root?.querySelector<HTMLElement>('.markdown-body') ?? null
    const target = body === null ? null : findHeadingElement(body, heading.line)
    if (target === null) return
    // The person jumped somewhere else, so stop re-centering onto the search hit (TODO 445). The list is outside the body, so it is not covered by the body's
    // wheel / pointerdown watcher.
    previewHits?.disarm()
    target.scrollIntoView({ block: 'start' })
    outline?.setActiveLine(heading.line)
  } else {
    // The cursor moves, so `onCursorLine` updates the highlight.
    editor?.revealLine(heading.line)
  }
}

/** If there is at least one heading, put the list below the body and start the highlight watcher. */
function mountOutline(headings: readonly Heading[]): void {
  if (headings.length === 0 || root === null) return
  outline = new OutlineView(headings, {
    doc: document,
    title: (count) => vt('outline', { count }),
    onPick: pickHeading
  })
  root.append(outline.element)
  if (mode === 'preview') {
    const body = root.querySelector<HTMLElement>('.markdown-body')
    if (body !== null) stopFollow = followPreview(body, (line) => outline?.setActiveLine(line))
  } else {
    outline.setActiveLine(cursorLine)
  }
}

/** When the Source draft changes, wait a little and refetch the list (not on every keystroke). */
function scheduleDraftOutline(): void {
  if (outlineTimer !== null) clearTimeout(outlineTimer)
  outlineTimer = setTimeout(() => {
    outlineTimer = null
    // While waiting for the command's result, `headingsFor` takes it from the draft when it arrives.
    if (outlineState !== 'ready' || mode !== 'source') return
    const headings = extractHeadings(source)
    if (outline === null) {
      mountOutline(headings)
    } else if (headings.length === 0) {
      outline.element.remove()
      outline = null
    } else {
      outline.setHeadings(headings)
    }
  }, 300)
}

async function showOutline(gen: number): Promise<void> {
  if (uri === '') return
  let fromCommand: readonly Heading[]
  try {
    fromCommand = (await bridge.runCommand('outline', { uri })) as readonly Heading[]
  } catch {
    // Even if the plugin-host is down, keep showing the body (7.8 "does not spill over into the main app").
    if (outlineGuard.isCurrent(gen)) outlineState = 'failed'
    return
  }
  // If another `render()` ran while waiting, this result is already stale (item 142).
  if (!outlineGuard.isCurrent(gen)) return
  outlineState = 'ready'
  mountOutline(headingsFor(fromCommand))
}

bridge.onResource((event) => {
  const prev = received
  const next = receivedOf(event)
  received = next
  if (event.resource.kind === 'error') {
    // For a file that cannot be opened, the heading shows no switch (TODO 969).
    bridge.reportViewModes(event.uri, [], mode)
    if (root !== null) {
      root.textContent = ''
      const div = document.createElement('div')
      div.className = 'message'
      div.textContent = vt('cannotOpen', { reason: event.resource.message })
      root.append(div)
    }
    return
  }
  editable = event.editable
  uri = event.uri
  theme = event.theme
  highlightQuery = event.highlightQuery
  // `source` is the current contents (including the draft in Source). On a resend of the same version of the same file, do not replace it
  // (item 309-2: in a new iframe two messages arrive, load and `ready`, and the second one rebuilt the editor after it had jumped to a line. Item 303: a theme / language resend
  // reverted the draft to the original body).
  if (prev !== null && planResource(prev, next, source) === 'keep') {
    if (editor !== null) refreshEditor(editor, prev, next, { readOnly: !editable, theme })
    // Preview also reapplies only when the search term changed (reapplying with the same term pulls the reader back from the position they were at).
    if (previewHits !== null && !find.isOpen() && prev.highlightQuery !== next.highlightQuery) {
      previewHits.apply(highlightQuery)
    }
    relabel()
    return
  }
  // If the host remembered a draft (TODO 312), show it. `received.text` stays the on-disk body,
  // so the heading list is refetched from the draft (`headingsFor`).
  source = event.draft ?? next.text ?? ''
  render()
})

/**
 * Jump to a line (item 273). The drawn HTML cannot be mapped back to original lines (same reason as the selection in item 97), so
 * **in Preview, switch to Source first and then jump** (owner decision 2026-10-01, same as VS Code).
 * The switch stays afterward (a person returns to Preview with the button).
 */
bridge.onReveal((event) => {
  if (root === null || event.uri !== uri) return
  if (revealNeedsRender(mode, editor !== null)) {
    mode = 'source'
    render()
  }
  editor?.revealLine(event.line, event.column)
})

/**
 * The position previously viewed in a document returned to with the left / right arrows (TODO 1146). The host sends it only once after `resource`. Only the unit of the current view is used
 * (Preview uses `offset` = scroll amount, Source uses `line`. A position remembered for the other view is discarded). If the height has shrunk, the browser clamps the scroll amount to the end, and
 * the editor clamps a line to the last line. A step with a search term also lets the restored position win, so the watcher for re-centering onto the first match (TODO 431 / 445) is removed.
 */
bridge.onRestorePosition((event) => {
  if (event.uri !== uri) return
  if (mode === 'source' && event.position.kind === 'line') editor?.restoreTopLine(event.position.value)
  else if (mode === 'preview' && event.position.kind === 'offset') {
    const body = root?.querySelector<HTMLElement>('.markdown-body') ?? null
    if (body === null) return
    previewHits?.disarm()
    body.scrollTop = event.position.value
  }
})

/** The same search hit was pressed again (TODO 446). Reapply the current search term and center the first match of the document. */
bridge.onRecenter(() => {
  editor?.setHighlight(highlightQuery)
  if (!find.isOpen()) previewHits?.apply(highlightQuery)
})

/** The heading's "view switch" (TODO 969). Redraw with the chosen view (the redraw resends `view-modes`). */
bridge.onSetViewMode((next) => {
  if (root === null || !isViewerDisplayMode(next) || next === mode) return
  mode = next
  render()
})

/**
 * The link of a dropped file (TODO 366). It is inserted **only when Source is editable** — in Preview (the drawn HTML cannot be
 * mapped back to the original position) and in read-only mode nothing is done (owner decision 2026-10-03). The position is the **caret**
 * (changed from "where it was dropped" in TODO 407).
 */
bridge.onInsertText((event) => {
  if (event.uri !== uri || mode !== 'source' || !editable) return
  editor?.insertText(event.text)
})
