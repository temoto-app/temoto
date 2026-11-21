/**
 * @vitest-environment jsdom
 *
 * `aios.markdown` outline list: jumping from it to a heading (item 318, ARCHITECTURE.md 7.4).
 *
 *  - Extraction (`extractHeadings`): setext, fences, indented code, closing `#`, inside lists and quotes, line numbers
 *  - Matching against rendering: the `data-line` from `renderMarkdown(…, { headingLines: true })` matches the `line` from extraction
 *    (markdown-it is the authority; it does not rely on the i-th item, so nothing shifts even when setext is mixed in)
 *  - The list (`OutlineView`): rows are buttons, pressing one calls `onPick`, cap of 50 entries, moving the highlight and the list following it
 *  - Preview: pressing a row calls `scrollIntoView` on the target heading's element; `followPreview` watches with IntersectionObserver
 *  - Source: pressing a row moves the editor to that line, and the highlight follows the cursor line
 *
 * main.ts is an entry script that imports `@pluginshared`, so the same parts are assembled here in the same order to check them.
 * Neither the model nor Electron is started.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { extractHeadings, headingText, type Heading } from '../src/shared/markdown/headings.js'
import { renderMarkdown } from '../src/shared/markdown/render.js'
import {
  OUTLINE_LIMIT,
  OutlineView,
  activeHeadingIndex,
  currentHeadingLine,
  findHeadingElement,
  followPreview,
  headingElements
} from '../plugins/aios.markdown/viewer/outline.js'
import { createEditor } from '../plugins/_shared/editor.js'

const MIXED = [
  'Title', // 1 (setext h1)
  '=====', // 2
  '',
  'Intro text.',
  '',
  '## ATX two ##', // 6
  '',
  '```md',
  '# not a heading',
  'Not',
  '---',
  '```',
  '',
  'Setext two', // 14 (setext h2, a two-line paragraph)
  'continues',
  '---',
  '',
  '    # indented code',
  '',
  '- item',
  '---', // A --- after a list is a horizontal rule
  '',
  '> # Quoted', // 23
  '',
  '1. # In list', // 25
  '',
  '~~~~',
  '## fenced',
  '~~~',
  '~~~~',
  '',
  '### **Bold** and `code` [link](http://x) #', // 32
  '#NoSpace',
  '#', // 34 (empty heading)
  '',
  'Last', // 36
  '===='
].join('\n')

describe('extractHeadings (項目 318)', () => {
  it('ATX と setext を拾い、フェンス・字下げのコード・リストの後の --- は見ない。行は 1 始まり (setext は段落の先頭)', () => {
    expect(extractHeadings(MIXED)).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'ATX two', line: 6 },
      { level: 2, text: 'Setext two continues', line: 14 },
      { level: 1, text: 'Quoted', line: 23 },
      { level: 1, text: 'In list', line: 25 },
      { level: 3, text: 'Bold and code link', line: 32 },
      { level: 1, text: '', line: 34 },
      { level: 1, text: 'Last', line: 36 }
    ])
  })

  it('描画 (markdown-it) の見出しの data-line と、取り出しの行・段が一致する', () => {
    const body = document.createElement('div')
    body.innerHTML = renderMarkdown(MIXED, { headingLines: true }).html
    const rendered = headingElements(body).map((el) => ({
      level: Number(el.tagName.slice(1)),
      line: Number(el.getAttribute('data-line'))
    }))
    expect(rendered).toEqual(extractHeadings(MIXED).map(({ level, line }) => ({ level, line })))
  })

  it('前付け (---) の下の行は markdown-it と同じく setext の h2 になる', () => {
    const src = '---\ntitle: x\n---\n\n# Body\n'
    const body = document.createElement('div')
    body.innerHTML = renderMarkdown(src, { headingLines: true }).html
    expect(headingElements(body).map((el) => el.getAttribute('data-line'))).toEqual(['2', '5'])
    expect(extractHeadings(src).map((h) => h.line)).toEqual([2, 5])
  })

  it('既定の描画 (ThreadPane) には data-line を載せない', () => {
    expect(renderMarkdown('# 見出し').html).toContain('<h1>見出し</h1>')
    expect(renderMarkdown('# 見出し', { headingLines: true }).html).toContain('<h1 data-line="1">見出し</h1>')
  })

  it('取り出しは 200 件まで。CRLF でも行がずれない', () => {
    const many = Array.from({ length: 250 }, (_, i) => `# h${i}`).join('\n')
    expect(extractHeadings(many)).toHaveLength(200)
    expect(extractHeadings('a\r\n\r\n# b\r\n').map((h) => h.line)).toEqual([3])
  })

  it('一覧の文字はインラインの記法を落とす', () => {
    expect(headingText('**a** _b_ `c` [d](e) ![f](g) \\# h')).toBe('a _b_ c d f # h')
  })
})

describe('OutlineView (項目 318)', () => {
  const headings: Heading[] = [
    { level: 1, text: 'A', line: 1 },
    { level: 2, text: 'B', line: 10 },
    { level: 2, text: 'C', line: 20 }
  ]

  afterEach(() => {
    document.body.textContent = ''
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  function view(list: readonly Heading[] = headings, onPick: (h: Heading) => void = () => {}): OutlineView {
    const v = new OutlineView(list, { doc: document, title: (count) => `Headings (${count})`, onPick })
    document.body.append(v.element)
    return v
  }

  it('行は button (クリックでも focus + Enter でも押せる)。押すと onPick にその見出し', () => {
    const picked: Heading[] = []
    const v = view(headings, (h) => picked.push(h))
    const rows = [...v.element.querySelectorAll<HTMLButtonElement>('button.outline-item')]
    expect(rows.map((r) => [r.tagName, r.type, r.textContent])).toEqual([
      ['BUTTON', 'button', 'A'],
      ['BUTTON', 'button', 'B'],
      ['BUTTON', 'button', 'C']
    ])
    rows[1]?.click()
    expect(picked).toEqual([headings[1]])
    expect(v.element.querySelector('h4')?.textContent).toBe('Headings (3)')
  })

  it('表示は 50 件まで、題の件数は全部の数', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ level: 2, text: `h${i}`, line: i + 1 }))
    const v = view(many)
    expect(v.element.querySelectorAll('.outline-item')).toHaveLength(OUTLINE_LIMIT)
    expect(OUTLINE_LIMIT).toBe(50)
    expect(v.element.querySelector('h4')?.textContent).toBe('Headings (120)')
    // At positions from the 51st entry on, no row is highlighted.
    v.setActiveLine(100)
    expect(v.activeRow()).toBeNull()
  })

  it('強調の付け替え: 行以前の最後の見出し、最初の見出しより前は無し。一覧の行も見える所へ', () => {
    const scrolled: Element[] = []
    // jsdom has no scrollIntoView (the implementation does not call it when it is absent).
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    const v = view([{ level: 1, text: 'A', line: 3 }, ...headings.slice(1)])
    v.setActiveLine(1)
    expect(v.activeRow()).toBeNull()
    v.setActiveLine(15)
    expect(v.activeRow()?.textContent).toBe('B')
    expect(v.activeRow()?.getAttribute('aria-current')).toBe('location')
    v.setActiveLine(25)
    const active = [...v.element.querySelectorAll('.outline-item.active')].map((el) => el.textContent)
    expect(active).toEqual(['C'])
    expect(v.element.querySelectorAll('[aria-current]')).toHaveLength(1)
    expect(scrolled.map((el) => el.textContent)).toEqual(['B', 'C'])
    // Moving within the same heading does not reattach (the list is not scrolled again).
    v.setActiveLine(26)
    expect(scrolled).toHaveLength(2)
  })

  it('見出しの差し替え (Source の下書き) でも、いまの位置の強調を保つ', () => {
    const v = view()
    v.setActiveLine(12)
    expect(v.activeRow()?.textContent).toBe('B')
    v.setHeadings([{ level: 1, text: 'New', line: 2 }, ...headings.slice(1)])
    expect(v.element.querySelector('h4')?.textContent).toBe('Headings (3)')
    expect(v.activeRow()?.textContent).toBe('B')
  })

  it('activeHeadingIndex', () => {
    expect(activeHeadingIndex(headings, null)).toBe(-1)
    expect(activeHeadingIndex(headings, 1)).toBe(0)
    expect(activeHeadingIndex(headings, 19)).toBe(1)
    expect(activeHeadingIndex(headings, 999)).toBe(2)
    expect(activeHeadingIndex([], 5)).toBe(-1)
  })
})

describe('Preview: 一覧から本文の見出しへ (項目 318)', () => {
  afterEach(() => {
    document.body.textContent = ''
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('setext が混じっても、押した見出しの要素に scrollIntoView が呼ばれる (行番号で引く)', () => {
    const body = document.createElement('div')
    body.className = 'markdown-body'
    body.innerHTML = renderMarkdown(MIXED, { headingLines: true }).html
    document.body.append(body)
    const scrolled: { el: Element; arg: unknown }[] = []
    Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
      scrolled.push({ el: this, arg })
    }
    // The same assembly as pickHeading in main.ts.
    const v = new OutlineView(extractHeadings(MIXED), {
      doc: document,
      title: (n) => String(n),
      onPick: (h) => findHeadingElement(body, h.line)?.scrollIntoView({ block: 'start' })
    })
    document.body.append(v.element)
    const rows = [...v.element.querySelectorAll<HTMLButtonElement>('.outline-item')]
    // The 3rd (setext "Setext two continues") and the 6th (ATX h3). Matching by i-th position would depend on whether the "Not / ---" inside the fence is counted; since they are line numbers, both hit the correct elements.
    rows[2]?.click()
    rows[5]?.click()
    const pageScrolls = scrolled.filter((s) => body.contains(s.el))
    expect(pageScrolls.map((s) => [s.el.tagName, s.el.textContent, s.arg])).toEqual([
      ['H2', 'Setext two\ncontinues', { block: 'start' }],
      ['H3', 'Bold and code link', { block: 'start' }]
    ])
  })

  it('findHeadingElement: 同じ行が無ければいちばん近い見出し、見出しが無ければ null', () => {
    const body = document.createElement('div')
    body.innerHTML = renderMarkdown('# a\n\ntext\n\n## b\n', { headingLines: true }).html
    expect(findHeadingElement(body, 5)?.textContent).toBe('b')
    expect(findHeadingElement(body, 4)?.textContent).toBe('b')
    expect(findHeadingElement(body, 2)?.textContent).toBe('a')
    expect(findHeadingElement(document.createElement('div'), 1)).toBeNull()
  })

  it('followPreview: 見出しを IntersectionObserver で見張り、上から 1/3 より上の最後の見出しを知らせる', () => {
    const body = document.createElement('div')
    body.innerHTML = renderMarkdown('# a\n\n## b\n\n## c\n', { headingLines: true }).html
    document.body.append(body)
    Object.defineProperty(body, 'clientHeight', { value: 300 })
    body.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    const tops: Record<string, number> = { '1': 10, '3': 150, '5': 400 }
    for (const el of headingElements(body)) {
      el.getBoundingClientRect = () => ({ top: tops[el.getAttribute('data-line') ?? ''] ?? 0 }) as DOMRect
    }
    const observed: Element[] = []
    let fire: () => void = () => {}
    let options: IntersectionObserverInit | null = null
    let disconnected = false
    class FakeObserver {
      constructor(callback: () => void, init: IntersectionObserverInit) {
        fire = callback
        options = init
      }
      observe(target: Element): void {
        observed.push(target)
      }
      disconnect(): void {
        disconnected = true
      }
    }
    const lines: (number | null)[] = []
    const stop = followPreview(body, (line) => lines.push(line), FakeObserver)
    expect(observed.map((el) => el.textContent)).toEqual(['a', 'b', 'c'])
    expect(options).toMatchObject({ root: body, threshold: 0 })
    // The band is 0-100px. b (150) is still below.
    expect(lines).toEqual([1])
    tops['3'] = 60
    fire()
    expect(lines.at(-1)).toBe(3)
    // If everything is below (it reads before the first heading), null.
    tops['1'] = 200
    tops['3'] = 250
    fire()
    expect(lines.at(-1)).toBeNull()
    stop()
    expect(disconnected).toBe(true)
  })

  it('currentHeadingLine: IntersectionObserver が無ければ scroll で代える', () => {
    const body = document.createElement('div')
    body.innerHTML = renderMarkdown('# a\n', { headingLines: true }).html
    expect(currentHeadingLine(headingElements(body), 0)).toBe(1)
    const lines: (number | null)[] = []
    const stop = followPreview(body, (line) => lines.push(line), undefined)
    body.dispatchEvent(new Event('scroll'))
    expect(lines).toHaveLength(2)
    stop()
    body.dispatchEvent(new Event('scroll'))
    expect(lines).toHaveLength(2)
  })
})

describe('Source: 一覧から editor の行へ (項目 318)', () => {
  it('行を押すと editor のその行へ移り、カーソル行から強調が付け替わる', () => {
    const text = ['# One', 'a', '', 'Two', '---', 'c', 'd', 'e', '## Three', 'f'].join('\n')
    const host = document.createElement('div')
    document.body.append(host)
    let v: OutlineView | null = null
    const cursor: number[] = []
    const editor = createEditor(host, {
      value: text,
      filename: 'doc.md',
      readOnly: false,
      theme: 'light',
      onChange: () => {},
      onCursorLine: (line) => {
        cursor.push(line)
        v?.setActiveLine(line)
      }
    })
    // Once right after creation (the cursor is at the top).
    expect(cursor).toEqual([1])
    v = new OutlineView(extractHeadings(text), {
      doc: document,
      title: (n) => String(n),
      onPick: (h) => editor.revealLine(h.line)
    })
    document.body.append(v.element)
    v.setActiveLine(cursor.at(-1) ?? null)
    expect(v.activeRow()?.textContent).toBe('One')
    const rows = [...v.element.querySelectorAll<HTMLButtonElement>('.outline-item')]
    rows[1]?.click() // Two (line 4) of the setext
    expect(host.querySelector('.cm-activeLine')?.textContent).toBe('Two')
    expect(v.activeRow()?.textContent).toBe('Two')
    rows[2]?.click()
    expect(host.querySelector('.cm-activeLine')?.textContent).toBe('## Three')
    expect(v.activeRow()?.textContent).toBe('Three')
    expect(cursor.slice(-2)).toEqual([4, 9])
    editor.destroy()
  })
})
