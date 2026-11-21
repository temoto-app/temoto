/**
 * @vitest-environment jsdom
 *
 * `aios.markdown` Preview: search-word highlighting and the hit box (TODO 445, wave 23 bundle G, ARCHITECTURE.md 7.4.3).
 *
 *  - matching (`findTextRanges`): the same rules as `findHighlightRanges` in 431 (the cap in document order, one for the same range, case)
 *  - wraps the text nodes of the body (the real output of `renderMarkdown`) in `<mark class="cm-searchHit">`. Inline elements are spanned,
 *    while blocks and `<br>` are not spanned. Inside the copy button is not looked at
 *  - the box (n / N and four buttons) and the current match; moves to the center (`scrollIntoView({ block: 'center' })`)
 *  - when the size changes, it re-aligns (ResizeObserver); when removed, the original DOM comes back
 *
 * Neither the model nor Electron is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Text } from '@codemirror/state'
import { renderMarkdown } from '../src/shared/markdown/render.js'
import { attachCopyButtons } from '../plugins/_shared/copy.js'
import {
  clearDomHighlight,
  collectText,
  createDomHits,
  dropOverlaps,
  findTextRanges,
  foldCase
} from '../plugins/_shared/dom-highlight.js'
import { findHighlightRanges, splitHighlightTerms } from '../plugins/_shared/highlight.js'

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly targets: Element[] = []
  disconnected = false
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe(target: Element): void {
    this.targets.push(target)
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true
  }
  static fire(target: Element): void {
    for (const o of FakeResizeObserver.instances) if (!o.disconnected && o.targets.includes(target)) o.callback()
  }
}

describe('matching (findTextRanges) follows the same rules as 431', () => {
  it('returns the same ranges as findHighlightRanges in the source view (document order, limit, duplicates)', () => {
    const text = 'beta first\nAlpha later\nbeta again alpha'
    for (const query of ['alpha beta', 'BETA', 'a', 'alpha ALPHA']) {
      const terms = splitHighlightTerms(query)
      for (const limit of [1, 2, 5000]) {
        expect(findTextRanges(text, terms, limit), `${query} / ${limit}`).toEqual(
          findHighlightRanges(Text.of(text.split('\n')), terms, limit)
        )
      }
    }
  })

  it('does not fold capital letters whose length changes (positions do not shift)', () => {
    expect(foldCase('İx').length).toBe(2)
    expect(findTextRanges('aİb x', ['x'])).toEqual([{ from: 4, to: 5 }])
  })

  it('overlapping matches keep only the earlier one', () => {
    expect(dropOverlaps(findTextRanges('abc abc', ['ab', 'bc']))).toEqual([
      { from: 0, to: 2 },
      { from: 4, to: 6 }
    ])
  })
})

function preview(markdown: string): { body: HTMLElement; pane: HTMLElement } {
  const pane = document.createElement('div')
  pane.className = 'preview-pane'
  const body = document.createElement('div')
  body.className = 'markdown-body'
  body.innerHTML = renderMarkdown(markdown, { headingLines: true }).html
  attachCopyButtons(body)
  pane.append(body)
  document.body.append(pane)
  return { body, pane }
}

const marks = (body: HTMLElement): HTMLElement[] => Array.from(body.querySelectorAll<HTMLElement>('mark.cm-searchHit'))

describe('highlighting the Preview DOM', () => {
  let scrolled: Element[]
  beforeEach(() => {
    FakeResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    scrolled = []
    // jsdom's elements have no scrollIntoView. The element and the arguments it was called with are remembered.
    Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
      expect(arg).toEqual({ block: 'center', inline: 'nearest' })
      scrolled.push(this)
    }
  })
  afterEach(() => {
    document.body.textContent = ''
    vi.unstubAllGlobals()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('wraps body matches in mark, makes the first match the current one and centers it; the box is n / N', () => {
    const { body, pane } = preview('# Needle 見出し\n\n本文に needle がある。\n\n- 項目の NEEDLE\n')
    const hits = createDomHits(body, pane)
    hits.apply('needle')
    const found = marks(body)
    expect(found.map((m) => m.textContent)).toEqual(['Needle', 'needle', 'NEEDLE'])
    expect(found[0]!.classList.contains('cm-searchHit-current')).toBe(true)
    expect(found[1]!.classList.contains('cm-searchHit-current')).toBe(false)
    expect(scrolled).toEqual([found[0]])
    const box = pane.querySelector<HTMLElement>('.hit-nav')!
    expect(box.hidden).toBe(false)
    expect(box.querySelector('.hit-nav-pos')!.textContent).toBe('1 / 3')
    // The look of the body (the characters) does not change. The heading's data-line (the correspondence for the list in 318) also remains.
    expect(body.querySelector('h1')!.textContent).toBe('Needle 見出し')
    expect(body.querySelector('h1')!.getAttribute('data-line')).not.toBeNull()
  })

  it('pressing the box changes the current match and centers it; disabled at the ends', () => {
    const { body, pane } = preview('alpha one\n\nalpha two\n\nalpha three\n')
    const hits = createDomHits(body, pane)
    hits.apply('alpha')
    const box = pane.querySelector<HTMLElement>('.hit-nav')!
    const button = (step: string): HTMLButtonElement => box.querySelector<HTMLButtonElement>(`[data-step="${step}"]`)!
    expect(button('prev').disabled).toBe(true)
    button('next').click()
    expect(hits.position()).toEqual({ index: 2, count: 3 })
    const found = marks(body)
    expect(found[1]!.classList.contains('cm-searchHit-current')).toBe(true)
    expect(found[0]!.classList.contains('cm-searchHit-current')).toBe(false)
    expect(scrolled.at(-1)).toBe(found[1])
    button('last').click()
    expect(hits.position()).toEqual({ index: 3, count: 3 })
    expect(button('next').disabled).toBe(true)
    expect(box.querySelector('.hit-nav-pos')!.textContent).toBe('3 / 3')
  })

  it('inline elements are crossed (1 match); blocks and <br> are not', () => {
    const { body, pane } = preview('foo**bar** baz\n\nfoo\n\nbar\n\nline  \nend\n')
    const hits = createDomHits(body, pane)
    hits.apply('foobar lineend')
    // The foo + <strong>bar</strong> in the first paragraph is one match (two marks). foo / bar in the second and third paragraphs are not joined.
    // `line  \nend` is split by <br>, so it does not match lineend.
    expect(hits.position()).toEqual({ index: 1, count: 1 })
    const found = marks(body)
    expect(found.map((m) => m.textContent)).toEqual(['foo', 'bar'])
    expect(found.every((m) => m.classList.contains('cm-searchHit-current'))).toBe(true)
    expect(found[1]!.parentElement!.tagName).toBe('STRONG')
    // If there is one match, no box is shown (same as 431).
    expect(pane.querySelector<HTMLElement>('.hit-nav')!.hidden).toBe(true)
  })

  it('also highlights inside code blocks but does not look inside the copy button', () => {
    const { body, pane } = preview('```js\nconst copy = 1\n```\n')
    expect(body.querySelector('button')).not.toBeNull()
    const { text } = collectText(body)
    expect(text).toContain('const copy = 1')
    const hits = createDomHits(body, pane)
    hits.apply('copy')
    expect(hits.position().count).toBe(1)
    expect(marks(body)[0]!.closest('pre')).not.toBeNull()
  })

  it('reapplying or clearing removes the previous marks and restores the original text', () => {
    const { body, pane } = preview('alpha beta alpha\n')
    const before = body.innerHTML
    const hits = createDomHits(body, pane)
    hits.apply('alpha')
    expect(marks(body)).toHaveLength(2)
    hits.apply('beta')
    expect(marks(body).map((m) => m.textContent)).toEqual(['beta'])
    hits.apply(null)
    expect(marks(body)).toHaveLength(0)
    expect(body.innerHTML).toBe(before)
    // The text nodes have been joined back together.
    expect(body.querySelector('p')!.childNodes).toHaveLength(1)
    expect(pane.querySelector<HTMLElement>('.hit-nav')!.hidden).toBe(true)
  })

  it('does not remove a <mark> that was originally in the body', () => {
    const body = document.createElement('div')
    body.innerHTML = '<p><mark>keep</mark> alpha</p>'
    clearDomHighlight(body)
    expect(body.querySelector('mark')!.textContent).toBe('keep')
  })

  it('re-centers on the current match when the size changes, and stops when a person touches it or jumps via the outline', () => {
    const { body, pane } = preview('alpha\n\nalpha\n')
    const hits = createDomHits(body, pane)
    hits.apply('alpha')
    expect(scrolled).toHaveLength(1)
    // The heading list was added below, so the body shrank.
    FakeResizeObserver.fire(body)
    expect(scrolled).toHaveLength(2)
    hits.disarm()
    FakeResizeObserver.fire(body)
    expect(scrolled).toHaveLength(2)
    // Re-applied (the re-press of TODO 446), and watched again.
    hits.apply('alpha')
    body.dispatchEvent(new Event('wheel'))
    FakeResizeObserver.fire(body)
    expect(scrolled).toHaveLength(3)
  })

  it('destroy removes the box and stops the observer', () => {
    const { body, pane } = preview('alpha\n\nalpha\n')
    const hits = createDomHits(body, pane)
    hits.apply('alpha')
    hits.destroy()
    expect(pane.querySelector('.hit-nav')).toBeNull()
    expect(FakeResizeObserver.instances.every((o) => o.disconnected)).toBe(true)
  })
})
