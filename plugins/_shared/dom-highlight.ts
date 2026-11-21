/**
 * Highlighting of search terms and the hit box over the rendered DOM (Markdown Preview) (ARCHITECTURE.md 7.4.3, TODO 445).
 *
 * The source view highlights with CodeMirror decorations (`highlightField` in `editor.ts`), but the Preview is HTML
 * rendered by markdown-it, so matches in the body's text nodes are wrapped in `<mark class="cm-searchHit">`. The class has the same name as in
 * the source view so the color rules (`.cm-searchHit` / `.cm-searchHit-current` in viewer.css, a fixed color that does not change with the theme, an
 * exception) are reused as they are. The CSS Custom Highlight API (`CSS.highlights`) is not in jsdom, so tests could not
 * check "where it lit up", and it was not adopted.
 *
 * - Terms are split the same way as item 431 (`splitHighlightTerms`: split the host's search-field string on whitespace). Matching is read the same way
 *   (literal, case-insensitive). The limit applies to the head of the list gathered per term and sorted in document order (431 (a)); identical ranges are one.
 * - A match does not cross blocks (paragraphs, headings, list items, table cells, code blocks, ...) or `<br>`. It does cross inline
 *   elements (`**emphasis**`, `` `code` ``, links, syntax-color spans) - such a match becomes several `<mark>`s and counts as one in the box.
 * - Overlapping matches (terms `ab` and `bc` hitting `abc`) cannot be nested in the DOM, so only the earlier one in document order is kept.
 * - The inside of copy buttons (`button`) and svg is not searched.
 * - The box (`createHitNav` in `hit-nav.ts`) and the watcher that "re-centers once the size is settled" (`watchRecenter`) are shared with the source view.
 *   Centering is done with `scrollIntoView({ block: 'center' })`.
 */
import { splitHighlightTerms, type HighlightRange } from './highlight.js'
import { createHitNav, hitNavState, stepTarget, watchRecenter, type HitStep } from './hit-nav.js'

export const DOM_HIT_CLASS = 'cm-searchHit'
export const DOM_HIT_CURRENT_CLASS = 'cm-searchHit-current'
/** Marker for a `<mark>` we inserted ourselves (so it can be removed separately from `<mark>` in the body's HTML). */
const DOM_HIT_ATTR = 'data-search-hit'

/** Case folding. Characters whose length changes (such as `İ`) are not folded - because positions in the folded string are used as positions in the original string. */
export function foldCase(text: string): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    out += lower.length === ch.length ? lower : ch
  }
  return out
}

/**
 * Lists the matches of each term in a string in `from` order (the same rules as `findHighlightRanges` in `highlight.ts`, a
 * version independent of CodeMirror's `Text`). Matches within one term do not overlap (the next search starts after the end of the previous match).
 */
export function findTextRanges(text: string, terms: readonly string[], limit = 5000): readonly HighlightRange[] {
  const folded = foldCase(text)
  const out: HighlightRange[] = []
  for (const term of terms) {
    const needle = foldCase(term)
    if (needle === '') continue
    let count = 0
    for (let at = folded.indexOf(needle); at >= 0 && count < limit; at = folded.indexOf(needle, at + needle.length)) {
      out.push({ from: at, to: at + needle.length })
      count += 1
    }
  }
  out.sort((a, b) => a.from - b.from || a.to - b.to)
  const unique = out.filter((range, i) => i === 0 || range.from !== out[i - 1]!.from || range.to !== out[i - 1]!.to)
  return unique.length > limit ? unique.slice(0, limit) : unique
}

/** Drops overlapping ranges (for input in `from` order, keeps the earlier one). */
export function dropOverlaps(ranges: readonly HighlightRange[]): readonly HighlightRange[] {
  const out: HighlightRange[] = []
  let end = -1
  for (const range of ranges) {
    if (range.from < end) continue
    out.push(range)
    end = range.to
  }
  return out
}

/** The inside of these elements is not searched (copy buttons, figures). */
const SKIP_SELECTOR = 'button, script, style, svg, textarea'
/** Blocks that a match does not cross. A separator (`\n`) is placed at the boundary of these and `<br>` - terms contain no whitespace, so they never hit the separator. */
const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd, figcaption, summary, details, div, section, article, table, ul, ol, dl'

interface TextSlice {
  readonly node: Text
  /** Start position within the concatenated string. */
  readonly start: number
}

/** Concatenates the text nodes under `root` in document order. A `\n` is inserted at block boundaries and `<br>`. */
export function collectText(root: Element): { readonly text: string; readonly slices: readonly TextSlice[] } {
  const doc = root.ownerDocument
  // The NodeFilter constants have these values in both jsdom and Chromium (SHOW_ELEMENT = 1, SHOW_TEXT = 4).
  const walker = doc.createTreeWalker(root, 0x1 | 0x4, {
    acceptNode(node) {
      if (node.nodeType === 1 && (node as Element).matches(SKIP_SELECTOR)) return 2 // FILTER_REJECT (do not look inside either)
      return 1 // FILTER_ACCEPT
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
    const parentEl = node.parentElement
    const block = parentEl?.closest(BLOCK_SELECTOR) ?? root
    if (text !== '' && (pendingBreak || block !== lastBlock)) text += '\n'
    pendingBreak = false
    lastBlock = block
    slices.push({ node: node as Text, start: text.length })
    text += value
  }
  return { text, slices }
}

/** Wraps ranges in `<mark>`. Returns the list of `<mark>`s per match (in document order). */
function wrapRanges(doc: Document, slices: readonly TextSlice[], ranges: readonly HighlightRange[]): HTMLElement[][] {
  interface Segment {
    readonly slice: number
    readonly from: number
    readonly to: number
    readonly hit: number
  }
  const segments: Segment[] = []
  let s = 0
  ranges.forEach((range, hit) => {
    // ranges are in `from` order, so the slice scan position never goes backwards.
    while (s < slices.length && slices[s]!.start + slices[s]!.node.data.length <= range.from) s += 1
    for (let i = s; i < slices.length; i++) {
      const slice = slices[i]!
      if (slice.start >= range.to) break
      const from = Math.max(range.from, slice.start) - slice.start
      const to = Math.min(range.to, slice.start + slice.node.data.length) - slice.start
      if (to > from) segments.push({ slice: i, from, to, hit })
    }
  })
  const hits: HTMLElement[][] = ranges.map(() => [])
  // Wrap from the back: positions earlier in the same text node do not change when the later part is split off.
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!
    const node = slices[segment.slice]!.node
    if (segment.to < node.data.length) node.splitText(segment.to)
    const target = segment.from > 0 ? node.splitText(segment.from) : node
    const mark = doc.createElement('mark')
    mark.className = DOM_HIT_CLASS
    mark.setAttribute(DOM_HIT_ATTR, '')
    target.parentNode?.insertBefore(mark, target)
    mark.append(target)
    hits[segment.hit]!.unshift(mark)
  }
  return hits.filter((marks) => marks.length > 0)
}

/** Removes the inserted `<mark>`s and restores the original text. */
export function clearDomHighlight(root: Element): void {
  const parents = new Set<Node>()
  for (const mark of Array.from(root.querySelectorAll(`mark[${DOM_HIT_ATTR}]`))) {
    const parent = mark.parentNode
    if (parent === null) continue
    while (mark.firstChild !== null) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parents.add(parent)
  }
  // Rejoin the split text nodes (for the next match and for how the selection looks).
  for (const parent of parents) parent.normalize()
}

export interface DomHits {
  /** Applies the search terms. Removes the previous highlight. If there is a match, makes the first match in the document the current one and centers it. null / empty clears. */
  apply(
    query: string | null,
    options?: {
      readonly literal?: boolean
      /** Number of the match to make current (1-based, out of range clamps to the ends). Omitted means the first. */
      readonly keepIndex?: number
      /** If false, do not center and do not attach the re-center watcher (when keeping the position after a redraw). Default true. */
      readonly scroll?: boolean
    }
  ): void
  /** Moves between matches (for the search field's Enter / up-down; same direction as the box's buttons). Does nothing in a direction that cannot be taken. */
  step(step: HitStep): void
  /** Stops the re-center watcher (when a person jumped elsewhere - e.g. pressed a row of the heading list). */
  disarm(): void
  /** The number of matches and the current match (1-based, 0 if none). For tests. */
  position(): { readonly index: number; readonly count: number }
  destroy(): void
}

/**
 * Hits for the Preview DOM (TODO 445). `body` is the body to highlight (the scrolling element), `boxHost` is the element where the box goes
 * (position: relative, a place that does not scroll with the body).
 */
export function createDomHits(
  body: HTMLElement,
  boxHost: HTMLElement,
  options: { readonly limit?: number; /** If false, the up / down box is not shown (when there is a find box of its own, TODO 828). */ readonly nav?: boolean } = {}
): DomHits {
  const doc = body.ownerDocument
  let hits: HTMLElement[][] = []
  let current = -1
  const nav = createHitNav(doc, (step) => go(step))
  if (options.nav !== false) boxHost.append(nav.element)

  const center = (): void => {
    const first = hits[current]?.[0]
    // jsdom elements have no scrollIntoView.
    if (first !== undefined && typeof first.scrollIntoView === 'function') {
      first.scrollIntoView({ block: 'center', inline: 'nearest' })
    }
  }
  const recenter = watchRecenter(body, center)

  const setCurrent = (index: number): void => {
    for (const mark of hits[current] ?? []) mark.classList.remove(DOM_HIT_CURRENT_CLASS)
    current = index
    for (const mark of hits[current] ?? []) mark.classList.add(DOM_HIT_CURRENT_CLASS)
    nav.update(hitNavState(current + 1, hits.length))
  }

  function go(step: HitStep): void {
    const target = stepTarget(step, current + 1, hits.length)
    if (target === null) return
    recenter.disarm()
    setCurrent(target - 1)
    center()
  }

  return {
    apply(query, applyOptions) {
      clearDomHighlight(body)
      hits = []
      current = -1
      // literal: in-document search (TODO 819) looks for the typed string as a single term as it is (it does not split on whitespace).
      const terms = applyOptions?.literal === true ? (query === null || query.trim() === '' ? [] : [query.trim()]) : splitHighlightTerms(query)
      if (terms.length > 0) {
        const { text, slices } = collectText(body)
        hits = wrapRanges(doc, slices, dropOverlaps(findTextRanges(text, terms, options.limit)))
      }
      if (hits.length === 0) {
        nav.update(hitNavState(0, 0))
        recenter.disarm()
        return
      }
      const keep = applyOptions?.keepIndex
      setCurrent(keep === undefined ? 0 : Math.min(Math.max(keep, 1), hits.length) - 1)
      if (applyOptions?.scroll === false) {
        recenter.disarm()
        return
      }
      center()
      recenter.arm()
    },
    step(step) {
      go(step)
    },
    disarm() {
      recenter.disarm()
    },
    position() {
      return { index: current + 1, count: hits.length }
    },
    destroy() {
      recenter.destroy()
      nav.element.remove()
    }
  }
}
