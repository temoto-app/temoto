/**
 * `aios.pdf` — a viewer that draws PDFs with pdf.js (bundled, Apache-2.0) (TODO 405, ARCHITECTURE.md 7.3 / 7.4).
 *
 * **The viewer does not read files.** The contents are served by main's `aios-res://` (`delivery: 'url'` from review C-2;
 * the manifest claims `pdf` and does not edit, so main passes a URL), and this code only fetches that URL and hands it
 * to pdf.js. The Broker's path check runs before serving.
 *
 * It is inside a sandboxed iframe (opaque origin), so Chromium's built-in PDF viewer cannot be used. pdf.js's worker cannot be created
 * directly from an aios-plugin: URL (a Worker accepts only a URL of the same origin as the document), so
 * a data: module worker is created and the bundled worker is `import`ed from inside it (`ensureWorker`. A blob: worker is
 * refused by Chromium under an opaque origin).
 *
 * Look: pages are stacked vertically (only the visible area is drawn, and the canvases of distant pages are discarded), zoom (fit width /
 * actual size / +-, Ctrl + wheel and pinch), page number (type to jump), and Cmd+F string search (marks are put on the text layer).
 * The text layer is transparent text, so selection and copy also work. The body is kept nowhere (constraint 9).
 */
import '@pluginshared/viewer.css'
import './pdf.css'
import { connect, type ViewerResourceEvent } from '@pluginshared/bridge.js'
import { vt } from '@pluginshared/i18n.js'
import { ASCII_INPUT_ATTRIBUTE } from '@shared/ascii-input.js'
import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask
} from 'pdfjs-dist'
import {
  MAX_PDF_BYTES,
  PDF_TO_CSS_UNITS,
  clampZoom,
  currentPageIndex,
  findMatches,
  fitWidthZoom,
  parsePageInput,
  segmentsForItem,
  stepZoom,
  zoomLabel
} from './pdf-model.js'

/** The margin around pages (px). Matches the padding of `.pdf-pages` in `pdf.css`. */
const PAGE_GUTTER = 16
/** The delay (ms) before redrawing after Ctrl + wheel zoom. Until then the previous canvas is stretched and shown. */
const RERENDER_DELAY_MS = 150
/** The delay (ms) from typing in the search until searching starts. */
const FIND_DELAY_MS = 200

const bridge = connect('aios.pdf')
const root = document.getElementById('root')

// ---- pdf.js worker and bundled files ----

const vendorBase = new URL('../vendor/', document.baseURI).href

/** Create just one worker and reuse it across documents (a PDFWorker given `workerPort` does not close the port). */
function ensureWorker(): void {
  if (GlobalWorkerOptions.workerPort !== null) return
  const src = `${vendorBase}pdf.worker.min.mjs`
  // With `workerPort`, pdf.js sends GetDocRequest without waiting for the worker's "ready". Messages that arrive
  // before the import finishes have no receiver and are discarded, so the document never opens (hit on a real machine). Buffer them during the import
  // and redistribute them afterward.
  const wrapper = [
    'const held = [];',
    'const hold = (event) => { held.push(event.data); event.stopImmediatePropagation(); };',
    "self.addEventListener('message', hold);",
    `await import(${JSON.stringify(src)});`,
    "self.removeEventListener('message', hold);",
    "for (const data of held) self.dispatchEvent(new MessageEvent('message', { data }));",
    ''
  ].join('\n')
  GlobalWorkerOptions.workerPort = new Worker(`data:text/javascript;charset=utf-8,${encodeURIComponent(wrapper)}`, {
    type: 'module'
  })
}

/**
 * Read CMaps / standard fonts / wasm with fetch (pdf.js's default reads anything other than http(s) with XHR). The worker-side fetch
 * (`useWorkerFetch`) is used only for http(s), so this side (the iframe's main thread) reads and passes them to the worker.
 */
class FetchBinaryDataFactory {
  private readonly bases: Readonly<Record<string, string | null>>
  constructor(options: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {
    this.bases = {
      cMapUrl: options.cMapUrl ?? null,
      standardFontDataUrl: options.standardFontDataUrl ?? null,
      wasmUrl: options.wasmUrl ?? null
    }
  }
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const base = this.bases[kind]
    if (base === null || base === undefined) throw new Error(`no base for ${kind}`)
    const response = await fetch(`${base}${filename}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

// ---- State ----

interface PageSlot {
  readonly index: number
  readonly el: HTMLDivElement
  /** The page size at zoom 1 (pt, including rotation). Until getPage, the value of the first page is borrowed. */
  widthPt: number
  heightPt: number
  page: PDFPageProxy | null
  canvas: HTMLCanvasElement | null
  renderTask: RenderTask | null
  textLayer: TextLayer | null
  textDiv: HTMLDivElement | null
  /** The zoom at which drawing finished. null if not drawn. */
  renderedZoom: number | null
  rendering: boolean
  visible: boolean
}

interface Session {
  readonly key: string
  readonly generation: number
  task: PDFDocumentLoadingTask | null
  doc: PDFDocumentProxy | null
  slots: PageSlot[]
  zoom: number
  fit: boolean
  scroller: HTMLDivElement | null
  observer: IntersectionObserver | null
  resizeObserver: ResizeObserver | null
  ui: Toolbar | null
  rerenderTimer: ReturnType<typeof setTimeout> | null
  /** The text items per page (for search). The body lives only in this iframe's memory. */
  readonly texts: Map<number, string[]>
  find: FindState
  /**
   * The host's "go to this page" (TODO 1009 stage 2, 0-based). When opened with a search term, the first match is chosen from **this page onward**
   * (the term also appears earlier in the document, but the hit was on this page). null if none.
   */
  wantPage: number | null
  /**
   * True while the position restored with the left / right arrows (TODO 1146, a 0-based page) is held until the document has been read and laid out.
   * During this time the provisional first page is not reported with `reportScrollPosition` (if the switch takes under 200 ms, the position to restore would be overwritten with page 1).
   */
  restorePending: boolean
  /** The destination while `restorePending` (0-based). */
  restorePage: number | null
  /** So that the first match of the search term does not overwrite the restored position (TODO 1146). Skips the first re-centering once. */
  holdReveal: boolean
}

interface FindState {
  query: string
  generation: number
  /** The number of matches per page. */
  counts: Map<number, number>
  /** All matches (in page order). */
  flat: { page: number; index: number }[]
  current: number
  /** After moving to a match, bring it to the mark once drawing finishes. */
  pendingReveal: boolean
  /**
   * Right after moving to a match, "the page with the match" and the scrollTop at that time (455-3). Until scrollTop moves,
   * the page number is not recounted by the scroll rule, and this page is shown.
   */
  pin: { page: number; scrollTop: number } | null
  timer: ReturnType<typeof setTimeout> | null
}

interface Toolbar {
  readonly zoom: HTMLSpanElement
  readonly page: HTMLInputElement
  readonly pageCount: HTMLSpanElement
  readonly find: HTMLInputElement
  readonly findCount: HTMLSpanElement
}

let generation = 0
let session: Session | null = null
/** The search term that arrived from the host (TODO 56). The term to search again on a re-press of the same hit (TODO 446). */
let highlightQuery: string | null = null
/** The URI of the file being shown (for page reports, TODO 1061 part 2). */
let currentUri = ''

function message(text: string): void {
  if (root === null) return
  root.textContent = ''
  const div = document.createElement('div')
  div.className = 'message'
  div.textContent = text
  root.append(div)
}

function teardown(): void {
  const current = session
  session = null
  if (current === null) return
  if (current.rerenderTimer !== null) clearTimeout(current.rerenderTimer)
  if (current.find.timer !== null) clearTimeout(current.find.timer)
  current.observer?.disconnect()
  current.resizeObserver?.disconnect()
  for (const slot of current.slots) {
    slot.renderTask?.cancel()
    slot.textLayer?.cancel()
  }
  void current.task?.destroy().catch(() => {})
}

function alive(s: Session): boolean {
  return session === s && s.generation === generation
}

// ---- Receiving ----

bridge.onResource((event) => {
  highlightQuery = event.highlightQuery
  currentUri = event.uri
  if (event.resource.kind === 'error') {
    teardown()
    message(vt('cannotOpen', { reason: event.resource.message }))
    return
  }
  if (event.resource.kind !== 'binary') {
    teardown()
    message(vt('notPdf'))
    return
  }
  const key = `${event.uri}\n${event.resource.resourceUrl}\n${event.resource.size}`
  // Do not reread on a resend of the same contents (a theme / language switch). The bridge writes the theme to <html>.
  if (session !== null && session.key === key) {
    refreshLabels(session)
    if (event.highlightQuery !== null && event.highlightQuery !== session.find.query) {
      setFindQuery(session, event.highlightQuery)
    }
    return
  }
  void load(event, key, event.resource.resourceUrl, event.resource.size)
})

async function load(event: ViewerResourceEvent, key: string, url: string, size: number): Promise<void> {
  teardown()
  generation += 1
  const s: Session = {
    key,
    generation,
    task: null,
    doc: null,
    slots: [],
    zoom: 1,
    fit: true,
    scroller: null,
    observer: null,
    resizeObserver: null,
    ui: null,
    rerenderTimer: null,
    texts: new Map(),
    wantPage: null,
    restorePending: false,
    restorePage: null,
    holdReveal: false,
    find: { query: '', generation: 0, counts: new Map(), flat: [], current: -1, pendingReveal: false, pin: null, timer: null }
  }
  session = s
  if (size > MAX_PDF_BYTES) {
    message(vt('pdfTooLarge', { size: `${(size / 1024 / 1024).toFixed(0)} MB` }))
    return
  }
  message(vt('pdfLoading'))
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = new Uint8Array(await response.arrayBuffer())
    if (!alive(s)) return
    ensureWorker()
    s.task = getDocument({
      data,
      cMapUrl: `${vendorBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${vendorBase}standard_fonts/`,
      wasmUrl: `${vendorBase}wasm/`,
      BinaryDataFactory: FetchBinaryDataFactory,
      enableXfa: false
    })
    const doc = await s.task.promise
    // Moved to another file while reading: teardown has already destroyed the document together with its loading task.
    if (!alive(s)) return
    s.doc = doc
    const first = await doc.getPage(1)
    if (!alive(s)) return
    const base = first.getViewport({ scale: 1 })
    mount(s, doc.numPages, base.width, base.height)
    const slot0 = s.slots[0]
    if (slot0 !== undefined) slot0.page = first
    if (s.wantPage !== null) scrollToPage(s, Math.min(s.wantPage, s.slots.length - 1))
    // The position to restore is applied after the step with a search term (wantPage) (the restored position wins).
    if (s.restorePage !== null) {
      scrollToPage(s, Math.min(s.restorePage, s.slots.length - 1))
      s.restorePage = null
    }
    s.restorePending = false
    updatePageIndicator(s, true)
    if (event.highlightQuery !== null && event.highlightQuery !== '') setFindQuery(s, event.highlightQuery)
  } catch (err) {
    if (!alive(s)) return
    const name = err instanceof Error ? err.name : ''
    if (name === 'PasswordException') message(vt('pdfPassword'))
    else message(vt('pdfFailed', { reason: err instanceof Error ? err.message : String(err) }))
  }
}

// The same search hit was pressed again (TODO 446). If reading has finished, search again with the term (going to the first match).
// If it is still reading, `load` searches last, so do nothing.
bridge.onRecenter(() => {
  if (session === null || session.doc === null || highlightQuery === null || highlightQuery === '') return
  setFindQuery(session, highlightQuery)
})

// Go to the page of the body-search hit (TODO 1009 stage 2). If reading has finished, move there; if it is still reading, `load` moves there after mount.
bridge.onRevealPage((event) => {
  const s = session
  if (s === null) return
  s.wantPage = Math.max(0, event.page - 1)
  if (s.doc !== null) scrollToPage(s, Math.min(s.wantPage, s.slots.length - 1))
})

// The page viewed before, in a document returned to with the left / right arrows (TODO 1146). The host sends it only once after `resource`. Out of range (the page count shrank) is clamped to the end.
// If it is still reading, `load` moves there after laying out; if finished, move right away. A position that is not a page (a unit of another viewer) is not used.
// Even in a step with a search term, the restored position takes priority over moving to the first match (1009 / 446).
bridge.onRestorePosition((event) => {
  const s = session
  if (s === null || event.position.kind !== 'page') return
  const index = event.position.value - 1
  // "Loaded" is judged by whether the slots are laid out (after mount). `s.doc` is set before mount (if it arrived during getPage(1), there were no slots and it was discarded).
  if (s.slots.length === 0) {
    // Set the flag only on the path that is still loading: `load` skips the final move to the search-term match once. On the immediate path runFind has already consumed the flag, and setting it would skip the next search.
    s.holdReveal = highlightQuery !== null && highlightQuery !== ''
    s.restorePending = true
    s.restorePage = index
    return
  }
  scrollToPage(s, Math.min(index, s.slots.length - 1))
})

// ---- Assembly ----

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.title = title
  b.setAttribute('aria-label', title)
  b.addEventListener('click', onClick)
  return b
}

function mount(s: Session, pageCount: number, widthPt: number, heightPt: number): void {
  if (root === null) return
  root.textContent = ''

  const toolbar = document.createElement('div')
  toolbar.className = 'toolbar pdf-toolbar'
  const zoomOut = button('−', vt('pdfZoomOut'), () => setZoom(s, stepZoom(s.zoom, -1), false))
  const zoom = document.createElement('span')
  zoom.className = 'pdf-zoom'
  const zoomIn = button('+', vt('pdfZoomIn'), () => setZoom(s, stepZoom(s.zoom, 1), false))
  const fit = button(vt('pdfFitWidth'), vt('pdfFitWidth'), () => setZoom(s, fitZoom(s), true))
  fit.dataset.role = 'fit'
  const actual = button(vt('pdfActualSize'), vt('pdfActualSize'), () => setZoom(s, 1, false))
  actual.dataset.role = 'actual'

  const pageBox = document.createElement('label')
  pageBox.className = 'pdf-page-box'
  const page = document.createElement('input')
  page.type = 'text'
  page.inputMode = 'numeric'
  page.className = 'pdf-page-input'
  page.value = '1'
  page.setAttribute('aria-label', vt('pdfPage'))
  const count = document.createElement('span')
  count.textContent = `/ ${pageCount}`
  pageBox.append(page, count)
  const goPage = (): void => {
    const index = parsePageInput(page.value, pageCount)
    if (index !== null) scrollToPage(s, index)
    else updatePageIndicator(s, true)
  }
  page.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      goPage()
      s.scroller?.focus()
    } else if (e.key === 'Escape') {
      updatePageIndicator(s, true)
      s.scroller?.focus()
    }
  })
  page.addEventListener('blur', () => updatePageIndicator(s, true))

  const spacer = document.createElement('span')
  spacer.className = 'pdf-spacer'
  const find = document.createElement('input')
  find.type = 'search'
  find.className = 'pdf-find'
  find.setAttribute(ASCII_INPUT_ATTRIBUTE, '') // Latin-letter input of the search field (TODO 463)
  find.placeholder = vt('pdfFind')
  find.setAttribute('aria-label', vt('pdfFind'))
  const findCount = document.createElement('span')
  findCount.className = 'pdf-find-count'
  const prev = button('↑', vt('pdfFindPrev'), () => stepMatch(s, -1))
  const next = button('↓', vt('pdfFindNext'), () => stepMatch(s, 1))
  find.addEventListener('input', () => {
    if (s.find.timer !== null) clearTimeout(s.find.timer)
    s.find.timer = setTimeout(() => {
      s.find.timer = null
      if (s.find.query !== '') s.wantPage = null // The term being searched changed: "go to this page" no longer applies.
      void runFind(s, find.value)
    }, FIND_DELAY_MS)
  })
  find.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (s.find.query !== find.value) {
        if (s.find.query !== '') s.wantPage = null
        void runFind(s, find.value)
      } else stepMatch(s, e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      find.value = ''
      s.wantPage = null
      void runFind(s, '')
      s.scroller?.focus()
    }
  })

  toolbar.append(zoomOut, zoom, zoomIn, fit, actual, pageBox, spacer, find, findCount, prev, next)

  const scroller = document.createElement('div')
  scroller.className = 'pdf-scroll'
  scroller.tabIndex = 0
  const pages = document.createElement('div')
  pages.className = 'pdf-pages'
  scroller.append(pages)
  root.append(toolbar, scroller)

  s.scroller = scroller
  s.ui = { zoom, page, pageCount: count, find, findCount }

  for (let index = 0; index < pageCount; index++) {
    const el = document.createElement('div')
    el.className = 'pdf-page'
    el.dataset.page = String(index + 1)
    pages.append(el)
    s.slots.push({
      index,
      el,
      widthPt,
      heightPt,
      page: null,
      canvas: null,
      renderTask: null,
      textLayer: null,
      textDiv: null,
      renderedZoom: null,
      rendering: false,
      visible: false
    })
  }

  s.zoom = fitZoom(s)
  layout(s)

  s.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.page) - 1
        const slot = s.slots[index]
        if (slot === undefined) continue
        slot.visible = entry.isIntersecting
        if (entry.isIntersecting) void renderSlot(s, slot)
        else release(slot)
      }
    },
    // Draw first up to one screen before and after the visible area. Canvases of pages farther away are discarded.
    { root: scroller, rootMargin: '100% 0px' }
  )
  for (const slot of s.slots) s.observer.observe(slot.el)

  let lastWidth = scroller.clientWidth
  s.resizeObserver = new ResizeObserver(() => {
    if (scroller.clientWidth === lastWidth) return
    lastWidth = scroller.clientWidth
    if (s.fit) setZoom(s, fitZoom(s), true)
  })
  s.resizeObserver.observe(scroller)

  let scrollQueued = false
  scroller.addEventListener('scroll', () => {
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      updatePageIndicator(s, false)
    })
  })

  // Ctrl + wheel (a trackpad pinch also arrives as a wheel with ctrlKey).
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom(s, clampZoom(s.zoom * Math.exp(-e.deltaY * 0.01)), false, true)
    },
    { passive: false }
  )

  refreshLabels(s)
  updatePageIndicator(s, true)
  scroller.focus()
}

/** Bring the toolbar wording, zoom and pressed state to the current values. Also called on a language switch. */
function refreshLabels(s: Session): void {
  const ui = s.ui
  if (ui === null) return
  ui.zoom.textContent = zoomLabel(s.zoom)
  const toolbar = ui.zoom.parentElement
  toolbar?.querySelector<HTMLButtonElement>('[data-role="fit"]')?.classList.toggle('active', s.fit)
  toolbar
    ?.querySelector<HTMLButtonElement>('[data-role="actual"]')
    ?.classList.toggle('active', !s.fit && Math.abs(s.zoom - 1) < 1e-3)
  updateFindCount(s)
}

function fitZoom(s: Session): number {
  const scroller = s.scroller
  if (scroller === null) return 1
  const widest = s.slots.reduce((max, slot) => Math.max(max, slot.widthPt), 0)
  return fitWidthZoom(scroller.clientWidth - PAGE_GUTTER * 2, widest)
}

/** Set each page's frame size to the current zoom. The canvas is stretched to fill the frame until it is redrawn. */
function layout(s: Session): void {
  for (const slot of s.slots) sizeSlot(s, slot)
}

function sizeSlot(s: Session, slot: PageSlot): void {
  const scale = s.zoom * PDF_TO_CSS_UNITS
  slot.el.style.width = `${Math.floor(slot.widthPt * scale)}px`
  slot.el.style.height = `${Math.floor(slot.heightPt * scale)}px`
  slot.el.style.setProperty('--total-scale-factor', String(scale))
}

function setZoom(s: Session, zoom: number, fit: boolean, deferRender = false): void {
  const scroller = s.scroller
  if (scroller === null) return
  const next = clampZoom(zoom)
  s.fit = fit
  if (Math.abs(next - s.zoom) < 1e-4) {
    refreshLabels(s)
    return
  }
  // Keep the reading position (as a fraction of the whole).
  const ratio = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0
  s.zoom = next
  layout(s)
  scroller.scrollTop = ratio * scroller.scrollHeight
  refreshLabels(s)
  if (s.rerenderTimer !== null) clearTimeout(s.rerenderTimer)
  const rerender = (): void => {
    s.rerenderTimer = null
    for (const slot of s.slots) if (slot.visible) void renderSlot(s, slot)
  }
  if (deferRender) s.rerenderTimer = setTimeout(rerender, RERENDER_DELAY_MS)
  else rerender()
}

function updatePageIndicator(s: Session, force: boolean): void {
  const scroller = s.scroller
  const ui = s.ui
  if (scroller === null || ui === null) return
  if (!force && document.activeElement === ui.page) return
  const pin = s.find.pin
  if (pin !== null) {
    // If it has not moved since moving to a match, stay on the page with the match (455-3). Once it moves, return to the rule.
    if (Math.abs(scroller.scrollTop - pin.scrollTop) < 2) {
      ui.page.value = String(pin.page + 1)
      reportPageOf(s, pin.page + 1)
      return
    }
    s.find.pin = null
  }
  const tops = s.slots.map((slot) => slot.el.offsetTop)
  const pageNumber = currentPageIndex(tops, scroller.scrollTop, scroller.clientHeight) + 1
  ui.page.value = String(pageNumber)
  // TODO 1061 part 2: report the page being viewed (1-based) to the host (the bridge does not resend the same value).
  reportPageOf(s, pageNumber)
}

/** Report the page being viewed (1-based) to the host. `reportPage` is for inView, and `reportScrollPosition` is for restoring with the left / right arrows (TODO 1146). */
function reportPageOf(s: Session, page: number): void {
  if (currentUri === '') return
  bridge.reportPage(currentUri, page)
  if (!s.restorePending) bridge.reportScrollPosition(currentUri, { kind: 'page', value: page })
}

function scrollToPage(s: Session, index: number): void {
  const slot = s.slots[index]
  if (s.scroller === null || slot === undefined) return
  s.scroller.scrollTop = slot.el.offsetTop - PAGE_GUTTER / 2
  updatePageIndicator(s, true)
}

// ---- Drawing ----

function release(slot: PageSlot): void {
  slot.renderTask?.cancel()
  slot.renderTask = null
  slot.textLayer?.cancel()
  slot.textLayer = null
  slot.textDiv?.remove()
  slot.textDiv = null
  if (slot.canvas !== null) {
    // A large canvas is not released right away unless width = 0.
    slot.canvas.width = 0
    slot.canvas.height = 0
    slot.canvas.remove()
    slot.canvas = null
  }
  slot.renderedZoom = null
}

async function pageOf(s: Session, slot: PageSlot): Promise<PDFPageProxy | null> {
  if (slot.page !== null) return slot.page
  if (s.doc === null) return null
  const page = await s.doc.getPage(slot.index + 1)
  slot.page = page
  const base = page.getViewport({ scale: 1 })
  if (base.width !== slot.widthPt || base.height !== slot.heightPt) {
    slot.widthPt = base.width
    slot.heightPt = base.height
    sizeSlot(s, slot)
  }
  return page
}

async function renderSlot(s: Session, slot: PageSlot): Promise<void> {
  if (!alive(s) || slot.rendering || slot.renderedZoom === s.zoom) return
  slot.rendering = true
  try {
    for (;;) {
      const zoom = s.zoom
      const page = await pageOf(s, slot)
      if (page === null || !alive(s) || !slot.visible) return
      const viewport = page.getViewport({ scale: zoom * PDF_TO_CSS_UNITS })
      const ratio = window.devicePixelRatio || 1
      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-canvas'
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
      const task = page.render({
        canvas,
        viewport,
        ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] })
      })
      slot.renderTask?.cancel()
      slot.renderTask = task
      try {
        await task.promise
      } catch (err) {
        if (err instanceof Error && err.name === 'RenderingCancelledException') return
        throw err
      } finally {
        if (slot.renderTask === task) slot.renderTask = null
      }
      if (!alive(s) || !slot.visible) return
      if (zoom !== s.zoom) continue // The zoom changed while drawing
      // Swap with the previous canvas (the previous one was stretched and shown until drawing finished).
      if (slot.canvas !== null) {
        slot.canvas.width = 0
        slot.canvas.remove()
      }
      slot.canvas = canvas
      slot.el.prepend(canvas)
      slot.renderedZoom = zoom

      // The text layer (selection, copy, and search marks).
      slot.textLayer?.cancel()
      slot.textDiv?.remove()
      const textDiv = document.createElement('div')
      textDiv.className = 'textLayer'
      slot.el.append(textDiv)
      const textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport })
      slot.textLayer = textLayer
      slot.textDiv = textDiv
      try {
        await textLayer.render()
      } catch {
        return // Cancelled
      }
      if (slot.textLayer !== textLayer || !alive(s)) return
      if (!s.texts.has(slot.index)) s.texts.set(slot.index, [...textLayer.textContentItemsStr])
      applyHighlights(s, slot)
      return
    }
  } catch (err) {
    if (alive(s)) console.warn('aios.pdf: render failed', slot.index + 1, err instanceof Error ? err.message : err)
  } finally {
    slot.rendering = false
  }
}

// ---- Search (Cmd+F) ----

async function textsOf(s: Session, index: number): Promise<string[]> {
  const cached = s.texts.get(index)
  if (cached !== undefined) return cached
  const slot = s.slots[index]
  if (slot === undefined) return []
  const page = await pageOf(s, slot)
  if (page === null) return []
  const content = await page.getTextContent()
  const items: string[] = []
  for (const item of content.items) if ('str' in item) items.push(item.str)
  s.texts.set(index, items)
  return items
}

function setFindQuery(s: Session, query: string): void {
  if (s.ui !== null) s.ui.find.value = query
  void runFind(s, query)
}

async function runFind(s: Session, query: string): Promise<void> {
  const find = s.find
  find.generation += 1
  const mine = find.generation
  find.query = query
  find.counts = new Map()
  find.flat = []
  find.current = -1
  for (const slot of s.slots) applyHighlights(s, slot)
  updateFindCount(s)
  if (query === '') return
  for (const slot of s.slots) {
    let items: string[]
    try {
      items = await textsOf(s, slot.index)
    } catch {
      continue
    }
    if (!alive(s) || find.generation !== mine) return
    const count = findMatches(items, query).length
    if (count === 0) continue
    find.counts.set(slot.index, count)
    for (let index = 0; index < count; index++) find.flat.push({ page: slot.index, index })
    if (find.current < 0 && (s.wantPage === null || slot.index >= s.wantPage)) {
      // The first match: if there is one on or after the current page, there; otherwise the first one found (wrapping to the start, same as VS Code).
      // If there is a "go to this page" (wantPage), matches before it are only counted and not moved to. Once moved, it is forgotten (one time only)
      // (so a later Cmd+F does not skip a match on an earlier page).
      find.current = find.flat.length - count
      s.wantPage = null
      revealFirst(s)
    }
    applyHighlights(s, slot)
    updateFindCount(s)
  }
  // There was no match on or after "this page": go back to the first match in the document (so nothing is left showing).
  const firstMatch = find.flat[0]
  if (find.current < 0 && firstMatch !== undefined) {
    find.current = 0
    revealFirst(s)
    const slot = s.slots[firstMatch.page]
    if (slot !== undefined) applyHighlights(s, slot)
  }
  s.wantPage = null
  s.holdReveal = false
  updateFindCount(s)
}

function stepMatch(s: Session, direction: 1 | -1): void {
  const total = s.find.flat.length
  if (total === 0) return
  const previous = s.find.flat[s.find.current]
  s.find.current = (s.find.current + direction + total) % total
  if (previous !== undefined) {
    const slot = s.slots[previous.page]
    if (slot !== undefined) applyHighlights(s, slot)
  }
  revealMatch(s)
  updateFindCount(s)
}

/** Move to the first match of the search term. If there is a position restored with the left / right arrows, skip it once (TODO 1146). The marks are still put on. */
function revealFirst(s: Session): void {
  if (s.holdReveal) s.holdReveal = false
  else revealMatch(s)
}

function revealMatch(s: Session): void {
  const target = s.find.flat[s.find.current]
  if (target === undefined) return
  const slot = s.slots[target.page]
  if (slot === undefined) return
  s.find.pendingReveal = true
  if (slot.textLayer !== null && slot.renderedZoom !== null) applyHighlights(s, slot)
  else scrollToPage(s, target.page) // Once drawn, applyHighlights moves to the mark
}

function updateFindCount(s: Session): void {
  const ui = s.ui
  if (ui === null) return
  const total = s.find.flat.length
  if (s.find.query === '') ui.findCount.textContent = ''
  else if (total === 0) ui.findCount.textContent = vt('pdfFindNone')
  else ui.findCount.textContent = vt('pdfFindCount', { current: s.find.current + 1, total })
}

/** Reapply the search marks to the spans of the text layer. A mark is a child span (`.pdf-hit`) inside a span. */
function applyHighlights(s: Session, slot: PageSlot): void {
  const layer = slot.textLayer
  if (layer === null) return
  const divs = layer.textDivs
  const strs = layer.textContentItemsStr
  for (const div of slot.textDiv?.querySelectorAll<HTMLElement>('[data-hit]') ?? []) {
    const index = divs.indexOf(div)
    div.textContent = index >= 0 ? (strs[index] ?? '') : div.textContent
    delete div.dataset.hit
  }
  if (s.find.query === '' || !s.find.counts.has(slot.index)) return
  const matches = findMatches(strs, s.find.query)
  const target = s.find.flat[s.find.current]
  const currentLocal = target !== undefined && target.page === slot.index ? target.index : -1
  let currentEl: HTMLElement | null = null
  strs.forEach((text, item) => {
    const segments = segmentsForItem(matches, item, text.length)
    const div = divs[item]
    if (segments.length === 0 || div === undefined) return
    div.dataset.hit = ''
    div.textContent = ''
    let at = 0
    for (const segment of segments) {
      if (segment.start > at) div.append(text.slice(at, segment.start))
      const hit = document.createElement('span')
      hit.className = segment.match === currentLocal ? 'pdf-hit current' : 'pdf-hit'
      hit.textContent = text.slice(segment.start, segment.end)
      div.append(hit)
      if (segment.match === currentLocal && currentEl === null) currentEl = hit
      at = segment.end
    }
    if (at < text.length) div.append(text.slice(at))
  })
  if (currentEl !== null && s.find.pendingReveal) {
    s.find.pendingReveal = false
    ;(currentEl as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' })
    // TODO 439: right after scrollIntoView the heading still shows the old page number (the scroll listener with `force: false`
    // should also work while the search field has focus, but the move that happens here can make scrollTop be reflected one frame
    // late). Use force: true to rewrite it reliably.
    // 455-3: what is written is "the page with the match". The match is centered vertically, so the page's top edge often ends up below 1/3 of the screen (the guide of `currentPageIndex`),
    // and recounting by the scroll rule left the previous page (the 27th proxy verification:
    // jumping to a match on page 3 showed "2", and to page 2 showed "1"). The scroll listener also recounts with rAF, so
    // until scrollTop moves, the page of `pin` is shown (updatePageIndicator looks at it).
    if (s.scroller !== null) s.find.pin = { page: slot.index, scrollTop: s.scroller.scrollTop }
    requestAnimationFrame(() => {
      if (alive(s)) updatePageIndicator(s, true)
    })
  }
}

// The host leaves Cmd+F / Ctrl+F to the viewer (treated the same as the editor's search, item 189).
window.addEventListener('keydown', (e) => {
  const s = session
  if (s === null || s.ui === null) return
  const mod = e.metaKey || e.ctrlKey
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    s.ui.find.focus()
    s.ui.find.select()
  } else if (mod && !e.altKey && e.key.toLowerCase() === 'g') {
    e.preventDefault()
    stepMatch(s, e.shiftKey ? -1 : 1)
  }
})
