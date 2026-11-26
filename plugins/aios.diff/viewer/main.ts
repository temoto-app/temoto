/**
 * `aios.diff` — a before/after diff (ARCHITECTURE.md 7.4.6, item 104).
 *
 * A viewer for temporary views that have no URI (since TODO 901 it also opens `.diff` / `.patch` files, read-only). The host passes the contents (the two sides of `kind: 'diff'`) directly;
 * this code touches neither files nor the network (the boundary check verifies that mechanically). It only reads:
 * it returns neither edits nor the selection to the host.
 */
import '@pluginshared/viewer.css'
import { connect, type ViewerResourceEvent } from '@pluginshared/bridge.js'
import { vt } from '@pluginshared/i18n.js'
import { plainSelection } from '@pluginshared/selection.js'
import { mountPatchView, patchRenderKey } from './patch-view.js'
import { layoutFor, mountDiffView, type DiffLayout, type DiffLayoutSource, type DiffView } from './diff-view.js'

const bridge = connect('aios.diff')
const root = document.getElementById('root')
/**
 * Unified (one column) or side by side. The default is unified (owner decision 2). Remembered only while the iframe lives. When a new diff arrives
 * with a `layout` set by the host (one opened by the AI, TODO 826 — side by side), switch to it (`layoutFor`).
 */
let layout: DiffLayout = 'unified'
let view: { readonly destroy: () => void } | null = null
/** The diff view drawn last (null for a patch / message), to read the current change before a redraw. */
let diffView: DiffView | null = null
/** Set when different contents arrive: the next draw starts at the first change instead of the one that was current (TODO 1339). */
let resetChunk = true
let chunkMemo = 0
let last: ViewerResourceEvent | null = null
/** The diff drawn last (to recognize a resend of the same contents). */
let lastDiff: DiffLayoutSource | null = null
/** The patch body drawn last (to recognize a resend of the same body). */
let lastPatchKey: string | null = null

function message(text: string): void {
  lastPatchKey = null
  diffView = null
  resetChunk = true
  view?.destroy()
  view = null
  if (root === null) return
  root.textContent = ''
  const div = document.createElement('div')
  div.className = 'message'
  div.textContent = text
  root.append(div)
}

/** Redrawing drops the selection. If there is an identifier (the `uri` the host passes per diff), report "no selection" (TODO 1091 part 2). */
function clearSelection(): void {
  if (last !== null && last.uri !== '') bridge.reportSelection(last.uri, null)
}

/**
 * A selection inside the diff (TODO 1091 part 2). Both unified and split use a DOM selection that cannot be mapped back to original line numbers, so only the text is reported
 * (`plainSelection` cuts it at an upper limit below 4000 characters). Report only — nothing is read or written.
 */
document.addEventListener('selectionchange', () => {
  if (last === null || last.uri === '' || last.resource.kind !== 'diff') return
  const selection = document.getSelection()
  const inside = selection !== null && selection.anchorNode !== null && root?.contains(selection.anchorNode) === true
  bridge.reportSelection(last.uri, inside ? plainSelection(selection.toString()) : null)
})

function render(): void {
  const event = last
  if (root === null || event === null) return
  clearSelection()
  if (event.resource.kind === 'error') {
    message(vt('cannotOpen', { reason: event.resource.message }))
    return
  }
  if (event.resource.kind === 'text') {
    // A `.diff` / `.patch` file (TODO 901). Show the body the host read through the Broker, read-only.
    // When the same body arrives again because the theme or language was resent, do not rebuild (keeps the scroll position). Colors are CSS variables (the bridge switches data-theme), so no redraw is needed. Only a language that changes the wording goes into the key.
    const key = patchRenderKey(event.resource.text, event.resource.truncated, event.locale)
    if (view !== null && lastPatchKey === key) return
    lastPatchKey = key
    diffView = null
  resetChunk = true
    view?.destroy()
    view = null
    root.textContent = ''
    view = mountPatchView(root, {
      text: event.resource.text,
      truncated: event.resource.truncated,
      emptyLabel: vt('noPatch'),
      truncatedLabel: vt('truncated')
    })
    return
  }
  if (event.resource.kind !== 'diff') {
    message(vt('notDiff'))
    return
  }
  // Rebuild whenever the theme, language or layout changes. It is a temporary view, so there is no state to keep.
  lastPatchKey = null
  // A redraw for the layout / theme / language keeps the change the person was looking at; new contents start at the first one.
  chunkMemo = resetChunk ? 0 : Math.max(diffView?.chunk ?? chunkMemo, 0)
  resetChunk = false
  view?.destroy()
  diffView = mountDiffView(root, {
    before: event.resource.before,
    after: event.resource.after,
    theme: event.theme,
    layout,
    startChunk: chunkMemo,
    onLayoutChange: (next) => {
      layout = next
      render()
    }
  })
  view = diffView
}

function sameDiffContents(a: DiffLayoutSource | null, b: DiffLayoutSource): boolean {
  return (
    a !== null &&
    a.before.name === b.before.name &&
    a.after.name === b.after.name &&
    a.before.text === b.before.text &&
    a.after.text === b.after.text
  )
}

bridge.onResource((event) => {
  last = event
  if (event.resource.kind === 'diff') {
    layout = layoutFor(layout, lastDiff, event.resource)
    if (!sameDiffContents(lastDiff, event.resource)) resetChunk = true
    lastDiff = event.resource
  }
  render()
})
