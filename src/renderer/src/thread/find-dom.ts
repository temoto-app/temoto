/**
 * The DOM side of in-thread search (TODO 496, ARCHITECTURE 5.1.7). Gathers the text of the drawn timeline (`.thread-body`),
 * turns matches into `Range`s, and highlights them with the CSS Custom Highlight API (`CSS.highlights`).
 *
 * **Do not rewrite the DOM (do not insert `<mark>`).** The Markdown Preview (`dom-highlight.ts`, 445) wraps matches in `<mark>`, but
 * most of the timeline is text nodes drawn by React (the user's messages, tool rows, notes), and React holds those nodes.
 * If they were split or moved into a `<mark>`, on the next re-render React would try to remove an old node and crash
 * (`removeChild` NotFoundError) or overwrite text elsewhere. A `Range` does not touch the DOM; if the contents
 * change on a re-render it just shrinks (it is a live range), so rescan when that happens (the MutationObserver in `ThreadFind.tsx`).
 *
 * jsdom (vitest) has no `CSS.highlights`. Registration is done only when it exists, and tests check the contents of the `Range` (`toString()`)
 * and their order.
 */
import { findRanges, foldText, type FindRange, type FindTerm } from './find-text.js'

/** The highlight name (`::highlight(...)` in styles.css). */
export const FIND_HIGHLIGHT = 'thread-find'
export const FIND_HIGHLIGHT_CURRENT = 'thread-find-current'

/**
 * The mark for a block that has a match in its collapsed contents (decision 5 of TODO 496). The value is the block's key (`tool:<id>` etc.). The block's component sets it
 * itself (`useFindPending`). The scan counts this element as "one place that has a match if opened".
 */
export const FIND_PENDING_ATTR = 'data-find-pending'

/**
 * The mark put on the block root (the scope to search for a match after opening) when the pending mark is on a part inside the block rather than on
 * the block root (the "+N" button of a subagent block: the hidden rows are at the button's position).
 */
export const FIND_ROOT_ATTR = 'data-find-root'

/**
 * Nothing inside these is searched (copy buttons, diagrams, "read more", rewind buttons, input fields).
 * Math (TODO 1342): KaTeX draws the visible side in `.katex-html` (`aria-hidden`) and a clipped copy in `.katex-mathml`. The visible glyphs are
 * searched (the highlight is a `Range` and `CSS.highlights`, which do not touch the DOM, so KaTeX's absolute layout is safe) and the MathML copy is
 * skipped, so a hit is visible and counted once.
 */
const SKIP_SELECTOR =
  'script, style, svg, textarea, input, .code-copy, .rewind-button, .rewind-menu, .timeline-older, .katex-mathml, [aria-hidden="true"]:not(.katex-html)'
/** Blocks that a match does not span (same as `dom-highlight.ts`). */
const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd, figcaption, summary, details, div, section, article, table, ul, ol, dl, button, ' +
  // Tool rows (name, summary, status inside the button) are delimited per field (so `Bash` + `npm test` does not become `Bashnpm`).
  '.tool-name, .tool-summary, .tool-status'

interface TextSlice {
  readonly node: Text
  readonly start: number
}

/** Concatenates the text nodes under `root` in document order. Inserts `\n` at block boundaries and `<br>` (a term contains no whitespace). */
export function collectText(root: Element): { readonly text: string; readonly slices: readonly TextSlice[] } {
  const doc = root.ownerDocument
  // SHOW_ELEMENT | SHOW_TEXT. FILTER_REJECT = 2 (do not look inside either), FILTER_ACCEPT = 1.
  const walker = doc.createTreeWalker(root, 0x1 | 0x4, {
    acceptNode(node) {
      if (node.nodeType === 1 && (node as Element).matches(SKIP_SELECTOR)) return 2
      return 1
    }
  })
  let text = ''
  const slices: TextSlice[] = []
  let lastBlock: Element | null = null
  let pendingBreak = false
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if ((node as Element).tagName === 'BR') pendingBreak = true
      continue
    }
    const value = (node as Text).data
    if (value === '') continue
    const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? root
    if (text !== '' && (pendingBreak || block !== lastBlock)) text += '\n'
    pendingBreak = false
    lastBlock = block
    slices.push({ node: node as Text, start: text.length })
    text += value
  }
  return { text, slices }
}

/** Turns ranges in the concatenated string into DOM `Range`s (a match spanning inline elements is still one Range). */
export function toDomRanges(doc: Document, slices: readonly TextSlice[], ranges: readonly FindRange[]): Range[] {
  const out: Range[] = []
  let s = 0
  for (const range of ranges) {
    while (s < slices.length && slices[s]!.start + slices[s]!.node.data.length <= range.from) s += 1
    if (s >= slices.length) break
    let e = s
    while (e < slices.length - 1 && slices[e]!.start + slices[e]!.node.data.length < range.to) e += 1
    const startSlice = slices[s]!
    const endSlice = slices[e]!
    const dom = doc.createRange()
    dom.setStart(startSlice.node, Math.max(0, range.from - startSlice.start))
    dom.setEnd(endSlice.node, Math.min(endSlice.node.data.length, range.to - endSlice.start))
    out.push(dom)
  }
  return out
}

/** One spot found by the scan. */
export type FindSpot =
  | { readonly kind: 'hit'; readonly range: Range; readonly itemId: string | null }
  | { readonly kind: 'pending'; readonly element: HTMLElement; readonly key: string; readonly itemId: string | null }

/** The id of the innermost timeline row (`ev-<eventId>`). Rows inside a subagent block have their own ids too. */
export function itemIdOf(node: Node): string | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  const row = element?.closest('[id^="ev-"]') ?? null
  return row === null ? null : row.id.slice(3)
}

function spotNode(spot: FindSpot): Node {
  return spot.kind === 'hit' ? spot.range.startContainer : spot.element
}

/**
 * Document order. A collapsed block (pending) goes **after the visible matches inside it** (the hidden contents are under the heading). If blocks are nested,
 * the inner one comes first.
 */
export function compareSpots(a: FindSpot, b: FindSpot): number {
  const na = spotNode(a)
  const nb = spotNode(b)
  if (na === nb) {
    if (a.kind === 'hit' && b.kind === 'hit') return a.range.compareBoundaryPoints(Range.START_TO_START, b.range)
    return a.kind === b.kind ? 0 : a.kind === 'hit' ? -1 : 1
  }
  const position = na.compareDocumentPosition(nb)
  // b is inside a (a is a block) -> b first. a is inside b -> a first.
  if (position & 16 /* CONTAINED_BY */) return 1
  if (position & 8 /* CONTAINS */) return -1
  return position & 4 /* FOLLOWING */ ? -1 : 1
}

/**
 * Scans `.thread-body` and returns matches (hit) and "blocks that have a match if opened" (pending) in document order. `limit` is the match cap
 * (a safety for rendering, 5000 like the viewer).
 */
export function scanFindSpots(body: HTMLElement, terms: readonly FindTerm[], limit = 5000): readonly FindSpot[] {
  if (terms.length === 0) return []
  const { text, slices } = collectText(body)
  const ranges = findRanges(foldText(text), terms, limit)
  const spots: FindSpot[] = toDomRanges(body.ownerDocument, slices, ranges).map((range) => ({
    kind: 'hit' as const,
    range,
    itemId: itemIdOf(range.startContainer)
  }))
  for (const element of Array.from(body.querySelectorAll<HTMLElement>(`[${FIND_PENDING_ATTR}]`))) {
    const key = element.getAttribute(FIND_PENDING_ATTR) ?? ''
    if (key === '') continue
    spots.push({ kind: 'pending', element, key, itemId: itemIdOf(element) })
  }
  return spots.sort(compareSpots)
}

/** A key to put the current match at the same place after rescanning (the row id and which one it is within that row). */
export interface SpotKey {
  readonly itemId: string | null
  readonly ordinal: number
  readonly kind: FindSpot['kind']
}

export function spotKeyAt(spots: readonly FindSpot[], index: number): SpotKey | null {
  const spot = spots[index]
  if (spot === undefined) return null
  let ordinal = 0
  for (let i = index - 1; i >= 0 && spots[i]!.itemId === spot.itemId; i -= 1) ordinal += 1
  return { itemId: spot.itemId, ordinal, kind: spot.kind }
}

/** The spot of the key. -1 if the same row is gone; if the row exists but the count shrank, the last one in that row. */
export function indexOfSpotKey(spots: readonly FindSpot[], key: SpotKey): number {
  let first = -1
  let count = 0
  for (let i = 0; i < spots.length; i += 1) {
    if (spots[i]!.itemId !== key.itemId) {
      if (first >= 0) break
      continue
    }
    if (first < 0) first = i
    count += 1
  }
  if (first < 0) return -1
  return first + Math.min(key.ordinal, count - 1)
}

/**
 * Re-attaches a key that was on the in-flight body (`.streaming`, no row id = `itemId` is null) to the finalized row. When receiving ends, the
 * in-flight body disappears and the same text is drawn last as the finalized answer row (`ev-<id>`). Without re-attaching, the current position is lost,
 * it shows "? / N", and the next Enter jumped to the start (proxy verification run 29, TODO 501-2). If found, or if there is nowhere to re-attach to,
 * returns it as is.
 */
export function rekeyFinishedStream(spots: readonly FindSpot[], key: SpotKey): SpotKey {
  if (key.itemId !== null || indexOfSpotKey(spots, key) >= 0) return key
  for (let i = spots.length - 1; i >= 0; i -= 1) {
    const spot = spots[i]!
    if (spot.kind === 'hit' && spot.itemId !== null) return { ...key, itemId: spot.itemId }
  }
  return key
}

const NO_RECT = { top: 0, bottom: 0, height: 0 } as const

/** A rectangle. jsdom's `Range` has no `getBoundingClientRect`, so a zero rectangle if absent. */
function rectOf(target: Range | Element): { readonly top: number; readonly bottom: number; readonly height: number } {
  return typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : NO_RECT
}

/** Whether `range` is fully visible inside `box` (the scrolling container). */
export function rangeVisible(range: Range | HTMLElement, box: HTMLElement): boolean {
  const rect = rectOf(range)
  const view = rectOf(box)
  return rect.top >= view.top && rect.bottom <= view.bottom
}

/** Puts `range` at the vertical center of `box` ("a hit goes to the center", same as 431 / 446). */
export function centerInBox(target: Range | HTMLElement, box: HTMLElement): void {
  const rect = rectOf(target)
  const view = rectOf(box)
  box.scrollTop += rect.top - view.top - (box.clientHeight - rect.height) / 2
}

/** The first spot below the top edge of the currently visible range (the match chosen when typing starts). The last one if none. */
export function firstSpotFromTop(spots: readonly FindSpot[], box: HTMLElement): number {
  if (spots.length === 0) return -1
  const top = rectOf(box).top
  for (let i = 0; i < spots.length; i += 1) {
    const spot = spots[i]!
    if (rectOf(spot.kind === 'hit' ? spot.range : spot.element).top >= top) return i
  }
  return spots.length - 1
}

interface HighlightRegistry {
  set(name: string, value: unknown): void
  delete(name: string): boolean
}

interface HighlightCtor {
  new (...ranges: Range[]): unknown
}

function registry(): { readonly highlights: HighlightRegistry; readonly Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight
  if (css?.highlights === undefined || Highlight === undefined) return null
  return { highlights: css.highlights, Highlight }
}

/** Highlights the matches and the current one (clears them if none). Does nothing in an environment without `CSS.highlights`. */
export function paintFindHighlights(spots: readonly FindSpot[], current: Range | null): void {
  const api = registry()
  if (api === null) return
  const ranges = spots.flatMap((spot) => (spot.kind === 'hit' ? [spot.range] : []))
  if (ranges.length === 0) api.highlights.delete(FIND_HIGHLIGHT)
  else api.highlights.set(FIND_HIGHLIGHT, new api.Highlight(...ranges))
  if (current === null) api.highlights.delete(FIND_HIGHLIGHT_CURRENT)
  else api.highlights.set(FIND_HIGHLIGHT_CURRENT, new api.Highlight(current))
}

export function clearFindHighlights(): void {
  const api = registry()
  if (api === null) return
  api.highlights.delete(FIND_HIGHLIGHT)
  api.highlights.delete(FIND_HIGHLIGHT_CURRENT)
}
