/**
 * Pure functions of `aios.pdf` (TODO 405). They depend on neither pdf.js nor the DOM — they only compute the zoom, the page being shown, and
 * the positions of text search matches. `test/pdf-viewer.test.ts` calls them directly.
 */

/** PDF 1 pt in CSS px (72 dpi -> 96 dpi). The same value as pdf.js's `PixelsPerInch.PDF_TO_CSS_UNITS`. */
export const PDF_TO_CSS_UNITS = 96 / 72

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 5

/** The zoom levels stepped through with +- (almost the same as the steps of Chromium's PDF viewer). */
export const ZOOM_STEPS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5
]

/**
 * The upper limit of what is fetched at once and passed to pdf.js (bytes). The viewer reads the whole file instead of using Range
 * (because it has not been checked whether a request with Range from an opaque origin works, or whether the response's `content-range` is visible under CORS).
 */
export const MAX_PDF_BYTES = 512 * 1024 * 1024

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** The zoom one step up (+1) / down (-1) from the current zoom. If it is between steps, the nearest step in that direction. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const current = clampZoom(zoom)
  const epsilon = 1e-3
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > current + epsilon) ?? MAX_ZOOM
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const step = ZOOM_STEPS[i]
    if (step !== undefined && step < current - epsilon) return step
  }
  return MIN_ZOOM
}

/**
 * The "fit width" zoom. `available` is the inner width of the frame (px, after subtracting the page's left and right margins),
 * and `pageWidthPt` is the page width at zoom 1 (pt).
 */
export function fitWidthZoom(available: number, pageWidthPt: number): number {
  if (!(available > 0) || !(pageWidthPt > 0)) return 1
  return clampZoom(available / (pageWidthPt * PDF_TO_CSS_UNITS))
}

/** The zoom display (`125%`). */
export function zoomLabel(zoom: number): string {
  return `${Math.round(clampZoom(zoom) * 100)}%`
}

/**
 * The page being read (0-based). `tops` are the top edges of the pages (coordinates inside the scroll area, ascending).
 * The page that contains the line 1/3 down from the top of the frame (= the last page whose top edge is above that line).
 */
export function currentPageIndex(tops: readonly number[], scrollTop: number, viewportHeight: number): number {
  if (tops.length === 0) return 0
  const probe = scrollTop + Math.max(0, viewportHeight) / 3
  let lo = 0
  let hi = tops.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((tops[mid] ?? 0) <= probe) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** Turn a page-number input (1-based) into a 0-based index. null if it is not a number or is out of range. */
export function parsePageInput(text: string, pageCount: number): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const page = Number(trimmed)
  if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) return null
  return page - 1
}

/** One search match. `start` / `end` are positions inside the text items (`items`) of one page (end is exclusive). */
export interface TextMatch {
  readonly start: { readonly item: number; readonly offset: number }
  readonly end: { readonly item: number; readonly offset: number }
}

/**
 * The string to compare. Case-insensitive. **Does not change the length** (so positions can be mapped back to the original string):
 * characters whose length changes under `toLowerCase` (such as `İ`) are left as they are.
 */
export function foldForSearch(text: string): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    out += lower.length === ch.length ? lower : ch
  }
  return out
}

/**
 * Find matches of `query` in the text items of one page (the sequence of `str` of pdf.js's `TextContent.items` = the sequence of text layer spans).
 * The items are joined **without separators** (because in Japanese one line is split into many items).
 * Matches do not overlap (the next search starts from the end of the one found). An empty term has no matches.
 */
export function findMatches(items: readonly string[], query: string): TextMatch[] {
  const needle = foldForSearch(query)
  if (needle === '') return []
  const starts: number[] = []
  let joined = ''
  for (const item of items) {
    starts.push(joined.length)
    joined += item
  }
  const haystack = foldForSearch(joined)
  const locate = (pos: number, isEnd: boolean): { item: number; offset: number } => {
    // Pull the end position to "the end of that item" (not to 0 of the next item). Empty items are skipped.
    let lo = 0
    let hi = starts.length - 1
    let found = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const start = starts[mid] ?? 0
      if (isEnd ? start < pos : start <= pos) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return { item: found, offset: pos - (starts[found] ?? 0) }
  }
  const matches: TextMatch[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    const endPos = at + needle.length
    matches.push({ start: locate(at, false), end: locate(endPos, true) })
    from = endPos
  }
  return matches
}

/** The span to color within one item. `match` is the index of the match (within the page). */
export interface ItemSegment {
  readonly start: number
  readonly end: number
  readonly match: number
}

/** The spans of matches that fall on item `item` (length `length`), in order from the front. */
export function segmentsForItem(matches: readonly TextMatch[], item: number, length: number): ItemSegment[] {
  const out: ItemSegment[] = []
  matches.forEach((match, index) => {
    if (match.start.item > item || match.end.item < item) return
    const start = match.start.item === item ? match.start.offset : 0
    const end = match.end.item === item ? match.end.offset : length
    if (end > start) out.push({ start, end, match: index })
  })
  return out
}
