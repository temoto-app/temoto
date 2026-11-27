/**
 * `aios.diff` — a before/after diff (ARCHITECTURE.md 7.4.6, item 104).
 *
 * A viewer for temporary views that have no URI (since TODO 901 it also opens `.diff` / `.patch` files, read-only). The host passes the contents (the two sides of `kind: 'diff'`) directly;
 * this code touches neither files nor the network (the boundary check verifies that mechanically). It only reads:
 * it returns neither edits nor the selection to the host.
 *
 * Big diffs are computed in a Web Worker (TODO 1341 item 4, `diff-client.ts`): the view is drawn when the result arrives, a result for
 * contents that are no longer current is dropped, and a worker that cannot start or fails sends the job back to this thread.
 */
import '@pluginshared/viewer.css'
import { connect, type ViewerResourceEvent } from '@pluginshared/bridge.js'
import { vt } from '@pluginshared/i18n.js'
import { plainSelection } from '@pluginshared/selection.js'
import { mountPatchView, patchRenderKey } from './patch-view.js'
import { layoutFor, mountDiffView, type DiffLayout, type DiffLayoutSource, type DiffView } from './diff-view.js'
import { UI_THREAD_LIMITS } from './coarse-diff.js'
import { diffJobFor, runDiffJob, type DiffJobResult } from './diff-work.js'
import { createDiffScheduler, createDiffWorkerClient, type DiffWorkerClient } from './diff-client.js'
import diffWorkerUrl from './diff-worker.ts?worker&url'

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

/** The diff worker, or null when this frame has no `Worker` at all. Created on the first big diff. */
let worker: DiffWorkerClient | null | undefined
/** Shows "computing" if a job takes long (a short job just replaces the previous view, without a flash). */
let computingTimer: ReturnType<typeof setTimeout> | null = null
const COMPUTING_NOTICE_MS = 200

function diffWorker(): DiffWorkerClient | null {
  if (worker !== undefined) return worker
  try {
    worker = typeof Worker === 'undefined' ? null : createDiffWorkerClient(new URL(diffWorkerUrl, import.meta.url).href)
  } catch {
    worker = null
  }
  return worker
}

function clearComputing(): void {
  if (computingTimer !== null) clearTimeout(computingTimer)
  computingTimer = null
}

/**
 * The slow part of big diffs. A result for the contents on screen calls `render` again, which then finds it; a worker that fails sends
 * the job back to this thread (`UI_THREAD_LIMITS`, as before the worker existed).
 */
const jobs = createDiffScheduler({
  client: diffWorker,
  runHere: (job) => runDiffJob(job, UI_THREAD_LIMITS),
  onReady: () => render()
})

/** Leaves whatever is on screen while a short job runs; after `COMPUTING_NOTICE_MS` replaces it with a notice. */
function showComputing(): void {
  if (computingTimer !== null) return
  computingTimer = setTimeout(() => {
    computingTimer = null
    // Cleared whenever a view is drawn, so firing means a job (this one or a newer one) is still running.
    if (jobs.running) message(vt('diffComputing'))
  }, COMPUTING_NOTICE_MS)
}

function message(text: string): void {
  clearComputing()
  replaceShown(null)
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

/**
 * The `uri` of the diff view on screen, or null when something else is (a patch, a message). Not `last`: while a big diff waits for the
 * worker the previous view stays and can still be selected in, and what is selected there belongs to that diff (wave 109 fix X3).
 */
let shownUri: string | null = null

/**
 * The view on screen is about to be replaced (by the diff of `nextUri`, or by something that is not a diff). Replacing drops the selection,
 * so report "no selection" for the diff that was shown and for the one about to be shown (TODO 1091 part 2).
 */
function replaceShown(nextUri: string | null): void {
  for (const uri of new Set([shownUri, nextUri])) {
    if (uri !== null && uri !== '') bridge.reportSelection(uri, null)
  }
  shownUri = nextUri
}

/**
 * A selection inside the diff (TODO 1091 part 2). Both unified and split use a DOM selection that cannot be mapped back to original line numbers, so only the text is reported
 * (`plainSelection` cuts it at an upper limit below 4000 characters). Report only — nothing is read or written.
 */
document.addEventListener('selectionchange', () => {
  const uri = shownUri
  if (uri === null || uri === '') return
  const selection = document.getSelection()
  const inside = selection !== null && selection.anchorNode !== null && root?.contains(selection.anchorNode) === true
  bridge.reportSelection(uri, inside ? plainSelection(selection.toString()) : null)
})

function render(): void {
  const event = last
  if (root === null || event === null) return
  // Whatever was being computed belongs to contents that are gone.
  if (event.resource.kind !== 'diff') jobs.cancel()
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
    clearComputing()
    diffView = null
  resetChunk = true
    view?.destroy()
    view = null
    root.textContent = ''
    replaceShown(null)
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
  // The slow part of a big diff comes from the worker; until it arrives the previous view stays (then a notice), and the scheduler calls
  // `render` again with the result.
  const job = diffJobFor(event.resource.before.text, event.resource.after.text)
  let precomputed: DiffJobResult | undefined
  if (job !== null) {
    precomputed = jobs.resultFor(job)
    if (precomputed === undefined) {
      showComputing()
      return
    }
  } else {
    // Small contents: nothing to wait for, and anything still running is for older contents.
    jobs.cancel()
  }
  clearComputing()
  // Rebuild whenever the theme, language or layout changes. It is a temporary view, so there is no state to keep.
  lastPatchKey = null
  // A redraw for the layout / theme / language keeps the change the person was looking at; new contents start at the first one.
  chunkMemo = resetChunk ? 0 : Math.max(diffView?.chunk ?? chunkMemo, 0)
  resetChunk = false
  view?.destroy()
  replaceShown(event.uri)
  diffView = mountDiffView(root, {
    before: event.resource.before,
    after: event.resource.after,
    theme: event.theme,
    layout,
    startChunk: chunkMemo,
    ...(precomputed === undefined ? {} : { precomputed }),
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
