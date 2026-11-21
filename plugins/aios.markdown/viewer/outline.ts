/**
 * The heading list of `aios.markdown` (item 318, ARCHITECTURE.md 7.4).
 *
 * The list stays **below** the body (Preview's `.markdown-body` / Source's editor) (owner decision 1). A row is a `button`,
 * so it can be pressed by click or by focus + Enter / Space. What happens after pressing (scroll to the heading in the body / to the line in the editor)
 * is decided by `main.ts` through `onPick`. This file only builds the DOM and marks "the heading being read now".
 *
 * The matching is by **line number**: a heading in the list uses the `line` of `extractHeadings` (`@shared/markdown/headings.ts`), and a heading in the Preview body
 * uses the `data-line` put by `renderMarkdown(…, { headingLines: true })`. They are not matched by i-th position
 * (if even one rule differs between extraction and rendering, everything after it shifts).
 *
 * It does not use `@pluginshared` (relative imports and `import type` only) — vitest has no `@pluginshared` alias, so
 * this part is split out so tests can load it (same practice as items 104 / 142 / 273 / 309).
 */
import type { Heading } from '@shared/markdown/headings.js'

/** The upper limit of rows shown in the list (the count in the title is the total, owner decision 3). */
export const OUTLINE_LIMIT = 50

/**
 * From the cursor line (Source) / the reading position (Preview), find the index of the heading to highlight: the last heading at or before `line`.
 * Before the first heading, or `null`, gives -1 (like Follow cursor in VS Code's Outline, nothing is highlighted).
 */
export function activeHeadingIndex(headings: readonly Heading[], line: number | null): number {
  if (line === null) return -1
  let found = -1
  for (let index = 0; index < headings.length; index += 1) {
    if ((headings[index]?.line ?? Number.POSITIVE_INFINITY) <= line) found = index
    else break
  }
  return found
}

/** The heading elements of the Preview body (`h1` to `h6` with `data-line`), in document order. */
export function headingElements(body: ParentNode): HTMLElement[] {
  return [...body.querySelectorAll<HTMLElement>('h1[data-line], h2[data-line], h3[data-line], h4[data-line], h5[data-line], h6[data-line]')]
}

function lineOf(element: Element): number {
  return Number(element.getAttribute('data-line'))
}

/**
 * Find the body's heading element from a line number. If there is no heading at that line (e.g. a mismatch between the draft and the list), the heading at the nearest line.
 * null if there are no headings at all.
 */
export function findHeadingElement(body: ParentNode, line: number): HTMLElement | null {
  let best: HTMLElement | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const element of headingElements(body)) {
    const d = Math.abs(lineOf(element) - line)
    if (d === 0) return element
    if (d < distance) {
      best = element
      distance = d
    }
  }
  return best
}

/**
 * The line of the "heading being read now" in Preview: the last of the headings whose top edge is above `bandBottom` (1/3 down from the top of the scroll frame).
 * null if there is none (reading before the first heading).
 */
export function currentHeadingLine(elements: readonly Element[], bandBottom: number): number | null {
  let line: number | null = null
  for (const element of elements) {
    if (element.getBoundingClientRect().top <= bandBottom) line = lineOf(element)
    else break
  }
  return line
}

type ObserverCtor = new (callback: () => void, options: IntersectionObserverInit) => {
  observe(target: Element): void
  disconnect(): void
}

/**
 * Watch Preview's headings with `IntersectionObserver` and call `onLine` whenever the line of the heading being read may have changed.
 * It is stopped with the return value.
 *
 * The band is "from the top of the scroll frame to 1/3 down", and **it is stretched far upward** (100000px at the top of `rootMargin`). That way,
 * every time "is the heading's top above the band's bottom?" changes, the intersection state necessarily changes — if the band were only inside the frame, when fast scrolling
 * made a heading jump over the band (outside below -> outside above), no intersection would ever occur and the mark would stay stale. The mark itself is decided again from the
 * position at the time of the call (`getBoundingClientRect`).
 *
 * In an environment without `IntersectionObserver` (jsdom), the frame's `scroll` is used instead.
 */
export function followPreview(
  body: HTMLElement,
  onLine: (line: number | null) => void,
  Observer: ObserverCtor | undefined = (globalThis as { IntersectionObserver?: ObserverCtor }).IntersectionObserver
): () => void {
  const elements = headingElements(body)
  const update = (): void => {
    const top = body.getBoundingClientRect().top
    onLine(currentHeadingLine(elements, top + body.clientHeight / 3))
  }
  update()
  if (elements.length === 0) return () => {}
  if (Observer === undefined) {
    body.addEventListener('scroll', update, { passive: true })
    return () => body.removeEventListener('scroll', update)
  }
  const observer = new Observer(update, { root: body, rootMargin: '100000px 0px -66% 0px', threshold: 0 })
  for (const element of elements) observer.observe(element)
  return () => observer.disconnect()
}

export interface OutlineViewOptions {
  readonly doc: Document
  readonly title: (count: number) => string
  readonly onPick: (heading: Heading) => void
}

/**
 * The DOM of the list (`div.outline` > `h4` + `button.outline-item` × at most 50). The headings can be swapped (the Source draft) and
 * the highlight can be moved. The highlight is `.active` and `aria-current="location"`.
 */
export class OutlineView {
  readonly element: HTMLDivElement
  private readonly titleEl: HTMLHeadingElement
  private readonly list: HTMLDivElement
  private rows: HTMLButtonElement[] = []
  private headings: readonly Heading[] = []
  private activeLine: number | null = null
  private activeIndex = -1

  constructor(
    headings: readonly Heading[],
    private readonly options: OutlineViewOptions
  ) {
    const { doc } = options
    this.element = doc.createElement('div')
    this.element.className = 'outline'
    this.titleEl = doc.createElement('h4')
    this.list = doc.createElement('div')
    this.list.className = 'outline-list'
    this.element.append(this.titleEl, this.list)
    this.setHeadings(headings)
  }

  get count(): number {
    return this.headings.length
  }

  /** A resend of the display language (`relabel` of item 309-2). */
  relabel(): void {
    this.titleEl.textContent = this.options.title(this.headings.length)
  }

  setHeadings(headings: readonly Heading[]): void {
    this.headings = headings
    this.relabel()
    this.list.textContent = ''
    this.rows = headings.slice(0, OUTLINE_LIMIT).map((heading) => {
      const row = this.options.doc.createElement('button')
      row.type = 'button'
      row.className = 'outline-item'
      row.style.paddingLeft = `${(heading.level - 1) * 10 + 4}px`
      row.textContent = heading.text
      row.title = heading.text
      row.addEventListener('click', () => this.options.onPick(heading))
      this.list.append(row)
      return row
    })
    this.activeIndex = -1
    this.setActiveLine(this.activeLine)
  }

  /** Move the highlight according to the line of the reading position. If the highlighted row is outside the list's view, scroll the list. */
  setActiveLine(line: number | null): void {
    this.activeLine = line
    const index = activeHeadingIndex(this.headings, line)
    if (index === this.activeIndex) return
    this.rows[this.activeIndex]?.classList.remove('active')
    this.rows[this.activeIndex]?.removeAttribute('aria-current')
    this.activeIndex = index
    const row = this.rows[index]
    if (row === undefined) return
    row.classList.add('active')
    row.setAttribute('aria-current', 'location')
    // `nearest` does not move if it is already visible. The only scrolling ancestor is the list (`.outline`) (the body is a sibling, so it does not move).
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }

  /** The list row currently highlighted (for tests). */
  activeRow(): HTMLButtonElement | null {
    return this.rows[this.activeIndex] ?? null
  }
}
