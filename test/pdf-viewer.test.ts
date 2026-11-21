/**
 * @vitest-environment jsdom
 *
 * `aios.pdf` (TODO 405, wave 21 bundle F).
 *
 * It does not check pdf.js itself (the real worker and canvas drawing); how to check on a real device is in bundle F of `docs/notes/wave21.md`.
 * What is checked here:
 *  - the zoom, the page being shown, the page-number input, and the position of a search hit (pure functions in `pdf-model.ts`)
 *  - the manifest, the CSP, the table of bundled files (`vendor.json`), and that there are no hard-coded colors
 *  - that the fixture PDF is a 3-page PDF
 *  - TODO 439: right after a search jumps to a match (`scrollIntoView`), the page-number display is also updated.
 *    `viewer/main.ts` is imported directly, and pdf.js and the bridge are replaced by fakes entirely to check it
 *    (`IntersectionObserver` / `ResizeObserver` / `Worker` are not in jsdom either, so they are faked too).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  PDF_TO_CSS_UNITS,
  clampZoom,
  currentPageIndex,
  findMatches,
  fitWidthZoom,
  foldForSearch,
  parsePageInput,
  segmentsForItem,
  stepZoom,
  zoomLabel
} from '../plugins/aios.pdf/viewer/pdf-model.js'

const repoRoot = process.cwd()
const pluginDir = join(repoRoot, 'plugins', 'aios.pdf')

// ---- fakes for TODO 439 (imports viewer/main.ts directly to check it) ----

interface FakePageData {
  readonly width: number
  readonly height: number
  readonly text: string[]
}

/** `vi.mock` is hoisted, so instead of `let`, the contents are swapped later in a `vi.hoisted` box. */
const pdfFixture = vi.hoisted(() => ({ pages: [] as FakePageData[], gate: null as Promise<void> | null }))
const bridgeFixture = vi.hoisted(() => ({
  handler: null as ((event: Record<string, unknown>) => void) | null,
  revealPage: null as ((event: { page: number }) => void) | null,
  restore: null as ((event: { uri: string; position: { kind: string; value: number } }) => void) | null,
  positions: [] as Array<{ uri: string; position: { kind: string; value: number } }>
}))

vi.mock('@pluginshared/viewer.css', () => ({}))
vi.mock('@pluginshared/i18n.js', () => ({ vt: (key: string, p?: { current?: number; total?: number }) => (key === 'pdfFindCount' && p ? `${p.current}/${p.total}` : key) }))
vi.mock('@pluginshared/bridge.js', () => ({
  connect: () => ({
    onResource: (fn: (event: Record<string, unknown>) => void) => {
      bridgeFixture.handler = fn
    },
    onReveal: () => {},
    onInsertText: () => {},
    onRecenter: () => {},
    onRevealPage: (fn: (event: { page: number }) => void) => {
      bridgeFixture.revealPage = fn
    },
    onRestorePosition: (fn: (event: { uri: string; position: { kind: string; value: number } }) => void) => {
      bridgeFixture.restore = fn
    },
    reportScrollPosition: (uri: string, position: { kind: string; value: number }) => {
      bridgeFixture.positions.push({ uri, position })
    },
    reportPage: () => {},
    reportDraft: () => {},
    runCommand: async () => undefined,
    openExternal: () => {}
  })
}))
vi.mock('pdfjs-dist', () => {
  class FakeTextLayer {
    textDivs: HTMLElement[] = []
    textContentItemsStr: string[] = []
    constructor(private readonly opts: { textContentSource: string[]; container: HTMLElement }) {}
    async render(): Promise<void> {
      this.textContentItemsStr = [...this.opts.textContentSource]
      this.textDivs = this.textContentItemsStr.map(() => {
        const div = document.createElement('span')
        this.opts.container.append(div)
        return div
      })
    }
    cancel(): void {}
  }
  class FakePage {
    constructor(private readonly data: FakePageData) {}
    getViewport({ scale }: { scale: number }): { width: number; height: number } {
      return { width: this.data.width * scale, height: this.data.height * scale }
    }
    streamTextContent(): string[] {
      return this.data.text
    }
    async getTextContent(): Promise<{ items: { str: string }[] }> {
      return { items: this.data.text.map((str) => ({ str })) }
    }
    render(): { promise: Promise<void>; cancel: () => void } {
      return { promise: Promise.resolve(), cancel: () => {} }
    }
  }
  class FakeDoc {
    numPages: number
    constructor(private readonly pages: FakePageData[]) {
      this.numPages = pages.length
    }
    async getPage(n: number): Promise<FakePage> {
      if (n === 1 && pdfFixture.gate !== null) await pdfFixture.gate
      const data = this.pages[n - 1]
      if (data === undefined) throw new Error(`no page ${n}`)
      return new FakePage(data)
    }
  }
  return {
    GlobalWorkerOptions: { workerPort: null as unknown },
    TextLayer: FakeTextLayer,
    getDocument: () => ({
      promise: Promise.resolve(new FakeDoc(pdfFixture.pages)),
      destroy: async () => {}
    })
  }
})

describe('倍率', () => {
  it('範囲に収める', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM)
    expect(clampZoom(100)).toBe(MAX_ZOOM)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(1.3)).toBe(1.3)
  })

  it('± は段を辿る。段の間にいればその向きの最も近い段', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(1.19, 1)).toBe(1.25)
    expect(stepZoom(1.19, -1)).toBe(1.1)
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
  })

  it('幅に合わせる: 枠の幅 / (ページの幅 pt × 96/72)', () => {
    // US Letter (612 pt) fitted into 816 px gives its actual size (612 × 4/3 = 816).
    expect(fitWidthZoom(816, 612)).toBeCloseTo(1)
    expect(fitWidthZoom(408, 612)).toBeCloseTo(0.5)
    expect(fitWidthZoom(0, 612)).toBe(1)
    expect(fitWidthZoom(800, 0)).toBe(1)
    expect(PDF_TO_CSS_UNITS).toBeCloseTo(4 / 3)
  })

  it('表示は百分率の整数', () => {
    expect(zoomLabel(1)).toBe('100%')
    expect(zoomLabel(1.194)).toBe('119%')
  })
})

describe('ページ', () => {
  const tops = [0, 1000, 2000, 3000]

  it('枠の上から 1/3 の線を含むページ', () => {
    expect(currentPageIndex(tops, 0, 900)).toBe(0)
    expect(currentPageIndex(tops, 800, 900)).toBe(1) // 800 + 300 = 1100
    expect(currentPageIndex(tops, 650, 900)).toBe(0) // 650 + 300 = 950
    expect(currentPageIndex(tops, 99999, 900)).toBe(3)
    expect(currentPageIndex([], 100, 900)).toBe(0)
  })

  it('ページ番号の入力は 1 始まりの整数だけ', () => {
    expect(parsePageInput('1', 3)).toBe(0)
    expect(parsePageInput(' 3 ', 3)).toBe(2)
    expect(parsePageInput('4', 3)).toBeNull()
    expect(parsePageInput('0', 3)).toBeNull()
    expect(parsePageInput('1.5', 3)).toBeNull()
    expect(parsePageInput('abc', 3)).toBeNull()
    expect(parsePageInput('', 3)).toBeNull()
  })
})

describe('検索の当たり', () => {
  it('大文字小文字を区別しない。長さは変えない', () => {
    expect(foldForSearch('NeEdLe')).toBe('needle')
    // Characters whose length changes when lowercased are left as they are (to restore positions).
    expect(foldForSearch('İx').length).toBe(2)
  })

  it('項目をまたぐ当たり (日本語は 1 行が何個もの項目に割れる)', () => {
    const items = ['日本語の検', '索テスト', '']
    const matches = findMatches(items, '検索')
    expect(matches).toEqual([{ start: { item: 0, offset: 4 }, end: { item: 1, offset: 1 } }])
    expect(segmentsForItem(matches, 0, 5)).toEqual([{ start: 4, end: 5, match: 0 }])
    expect(segmentsForItem(matches, 1, 4)).toEqual([{ start: 0, end: 1, match: 0 }])
    expect(segmentsForItem(matches, 2, 0)).toEqual([])
  })

  it('当たりは重ならない。末尾の位置は項目の終わりに寄せる', () => {
    const matches = findMatches(['aaaa'], 'aa')
    expect(matches).toHaveLength(2)
    const end = findMatches(['ab', 'cd'], 'ab')
    expect(end).toEqual([{ start: { item: 0, offset: 0 }, end: { item: 0, offset: 2 } }])
  })

  it('1 つの項目に複数の当たり / 空の語は当たり無し', () => {
    const matches = findMatches(['needle and NEEDLE'], 'needle')
    expect(segmentsForItem(matches, 0, 17)).toEqual([
      { start: 0, end: 6, match: 0 },
      { start: 11, end: 17, match: 1 }
    ])
    expect(findMatches(['x'], '')).toEqual([])
  })
})

describe('マニフェスト・CSP・同梱物', () => {
  it('pdf だけを名乗り、編集しない (URL で受ける)', () => {
    const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'))
    expect(manifest.viewer.extensions).toEqual(['pdf'])
    expect(manifest.viewer.editable).toBe(false)
  })

  it('CSP: aios-res: は fetch だけ、worker は data:、JS の eval は開けない', () => {
    const html = readFileSync(join(pluginDir, 'viewer', 'index.html'), 'utf8')
    const csp = /content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toMatch(/connect-src aios-res: aios-plugin:/)
    expect(csp).toMatch(/worker-src data:;/)
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).not.toMatch(/https?:/)
  })

  it('vendor.json は node_modules / 出力先の外を指さない', () => {
    const spec = JSON.parse(readFileSync(join(pluginDir, 'vendor.json'), 'utf8')) as {
      copy: { from: string; to: string }[]
    }
    expect(spec.copy.length).toBeGreaterThan(0)
    for (const { from, to } of spec.copy) {
      expect(from.startsWith('pdfjs-dist/')).toBe(true)
      expect(to.startsWith('vendor/')).toBe(true)
      expect(`${from}/${to}`.split('/')).not.toContain('..')
    }
    // the worker, the Japanese CMap, and the license
    expect(spec.copy.map((c) => c.to)).toEqual(
      expect.arrayContaining(['vendor/pdf.worker.min.mjs', 'vendor/cmaps', 'vendor/LICENSE'])
    )
  })

  it('pdf.css に色の直書きが無い (7.4.1、色は viewer.css の変数だけ)', () => {
    const css = readFileSync(join(pluginDir, 'viewer', 'pdf.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/\brgba?\(/)
    expect(css).not.toMatch(/\bhsla?\(/)
  })

  it('fixture の PDF は 3 ページ', () => {
    const pdf = readFileSync(join(repoRoot, 'test', 'fixtures', 'sample.pdf')).toString('latin1')
    expect(pdf.startsWith('%PDF-')).toBe(true)
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(3)
  })
})

describe('検索で一致へ飛ぶとページ番号も更新する (TODO 439)', () => {
  /** Fakes what jsdom does not have (the real class is never constructed). */
  class FakeIntersectionObserver {
    static instances: FakeIntersectionObserver[] = []
    constructor(readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
      FakeIntersectionObserver.instances.push(this)
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  class FakeResizeObserver {
    observe(): void {}
    disconnect(): void {}
  }
  class FakeWorker {
    constructor() {}
  }

  const flush = async (times = 5): Promise<void> => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(() => {
    vi.resetModules()
    FakeIntersectionObserver.instances = []
    bridgeFixture.handler = null
    bridgeFixture.revealPage = null
    bridgeFixture.restore = null
    pdfFixture.pages = [
      { width: 600, height: 800, text: ['hello world'] },
      { width: 600, height: 800, text: ['needle here'] }
    ]
    document.body.innerHTML = '<div id="root"></div>'
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    )
    // jsdom does not implement scrollIntoView. The real one writes scrollTop, so this writes it too.
    Element.prototype.scrollIntoView = vi.fn()
    // Replaces requestAnimationFrame with a macrotask that runs at a fixed delay (fake timers are not used).
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('検索の当たりが既に描いてあるページにあるとき、scrollIntoView の後でページ番号が更新される', async () => {
    await import('../plugins/aios.pdf/viewer/main.js')
    const handler = bridgeFixture.handler
    expect(handler).not.toBeNull()
    handler?.({
      uri: 'file:///a.pdf',
      label: 'a.pdf',
      resource: { kind: 'binary', resourceUrl: 'aios-res://x', size: 8, mime: 'application/pdf' },
      editable: false,
      theme: 'light',
      locale: 'ja',
      highlightQuery: null,
      revision: null,
      draft: null
    })
    await flush()

    const root = document.getElementById('root') as HTMLElement
    const pageEls = Array.from(root.querySelectorAll<HTMLElement>('.pdf-page'))
    expect(pageEls).toHaveLength(2)
    const [page1El, page2El] = pageEls
    if (page1El === undefined || page2El === undefined) throw new Error('expected 2 .pdf-page elements')
    // Makes it look as if page 2 is one screen further down (jsdom does no real layout).
    Object.defineProperty(page1El, 'offsetTop', { value: 0, configurable: true })
    Object.defineProperty(page2El, 'offsetTop', { value: 1000, configurable: true })
    const scroller = root.querySelector<HTMLElement>('.pdf-scroll')
    expect(scroller).not.toBeNull()
    if (scroller === null) return
    Object.defineProperty(scroller, 'clientHeight', { value: 900, configurable: true })
    // jsdom does no real layout, so the automatic calculation right after mount does not know this offsetTop.
    // Make the premise clear: "page 1 is being viewed now" (only the later updates are checked).
    const pageInput = root.querySelector<HTMLInputElement>('.pdf-page-input')
    expect(pageInput).not.toBeNull()
    if (pageInput === null) return
    pageInput.value = '1'

    // Make page 2 "visible" and let it draw first (the route when the search hit is on a page already drawn).
    const observer = FakeIntersectionObserver.instances.at(-1)
    expect(observer).toBeDefined()
    observer?.callback([{ target: page2El, isIntersecting: true }])
    await flush()
    expect(pageInput.value).toBe('1') // Drawing alone does not move the page number

    // scrollIntoView is called, but it only writes scrollTop as the real one does (jsdom does not fire scroll events).
    ;(Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockImplementation(function (this: HTMLElement) {
      scroller.scrollTop = 1000
    })

    const findInput = root.querySelector<HTMLInputElement>('.pdf-find')
    expect(findInput).not.toBeNull()
    if (findInput === null) return
    findInput.value = 'needle'
    findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()

    // The scroll listener with force: false does not run, since there is no scroll event. What was fixed is that
    // applyHighlights calls it with force: true after scrollIntoView.
    expect(pageInput?.value).toBe('2')
  })

  it('455-3: 一致が中央に寄ってページの上端が画面の 1/3 より下でも、一致のあるページの番号になる', async () => {
    await import('../plugins/aios.pdf/viewer/main.js')
    bridgeFixture.handler?.({
      uri: 'file:///a.pdf',
      label: 'a.pdf',
      resource: { kind: 'binary', resourceUrl: 'aios-res://x', size: 8, mime: 'application/pdf' },
      editable: false,
      theme: 'light',
      locale: 'ja',
      highlightQuery: null,
      revision: null,
      draft: null
    })
    await flush()
    const root = document.getElementById('root') as HTMLElement
    const [page1El, page2El] = Array.from(root.querySelectorAll<HTMLElement>('.pdf-page'))
    if (page1El === undefined || page2El === undefined) throw new Error('expected 2 .pdf-page elements')
    Object.defineProperty(page1El, 'offsetTop', { value: 0, configurable: true })
    Object.defineProperty(page2El, 'offsetTop', { value: 1000, configurable: true })
    const scroller = root.querySelector<HTMLElement>('.pdf-scroll')
    const pageInput = root.querySelector<HTMLInputElement>('.pdf-page-input')
    const findInput = root.querySelector<HTMLInputElement>('.pdf-find')
    if (scroller === null || pageInput === null || findInput === null) throw new Error('missing ui')
    Object.defineProperty(scroller, 'clientHeight', { value: 900, configurable: true })
    pageInput.value = '1'
    FakeIntersectionObserver.instances.at(-1)?.callback([{ target: page2El, isIntersecting: true }])
    await flush()
    // The position that centers the match: the top of page 2 (1000) is below scrollTop + 900/3 = 800, so by the rule it is page 1.
    ;(Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockImplementation(() => {
      scroller.scrollTop = 500
    })
    findInput.value = 'needle'
    findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()
    expect(pageInput.value).toBe('2')
    // The real one gets a scroll event from the moved scroll, and the listener recounts with rAF. If nothing moves, it stays on the matched page.
    scroller.dispatchEvent(new Event('scroll'))
    await flush()
    expect(pageInput.value).toBe('2')
    // When the person scrolls, the rule applies again (scrollTop 600 + 900/3 = 900 < 1000 → page 1).
    scroller.scrollTop = 600
    scroller.dispatchEvent(new Event('scroll'))
    await flush()
    expect(pageInput.value).toBe('1')
  })

  describe('reveal-page の後の検索 (TODO 1009 の review)', () => {
    async function open(pages: string[]): Promise<{ find: HTMLInputElement; count: HTMLElement }> {
      pdfFixture.pages = pages.map((text) => ({ width: 600, height: 800, text: [text] }))
      await import('../plugins/aios.pdf/viewer/main.js')
      bridgeFixture.handler?.({
        uri: 'file:///a.pdf',
        label: 'a.pdf',
        resource: { kind: 'binary', resourceUrl: 'aios-res://x', size: 8, mime: 'application/pdf' },
        editable: false,
        theme: 'light',
        locale: 'ja',
        highlightQuery: null,
        revision: null,
        draft: null
      })
      await flush()
      const root = document.getElementById('root') as HTMLElement
      const find = root.querySelector<HTMLInputElement>('.pdf-find')
      const count = root.querySelector<HTMLElement>('.pdf-find-count')
      if (find === null || count === null) throw new Error('missing ui')
      return { find, count }
    }
    const search = async (find: HTMLInputElement, value: string): Promise<void> => {
      find.value = value
      find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
    }

    it('最初の検索はページ以降の一致を選び、その後の検索では前のページの一致も選べる', async () => {
      const { find, count } = await open(['alpha', 'x', 'alpha'])
      bridgeFixture.revealPage?.({ page: 3 })
      await search(find, 'alpha')
      expect(count.textContent).toBe('2/2') // The match on page 3
      await search(find, 'alph') // The search term was changed: no longer tied to page 3
      expect(count.textContent).toBe('1/2')
    })

    it('ページ以降に一致が無ければ文書の最初の一致に戻る', async () => {
      const { find, count } = await open(['alpha', 'x', 'y'])
      bridgeFixture.revealPage?.({ page: 3 })
      await search(find, 'alpha')
      expect(count.textContent).toBe('1/1')
    })
  })
  describe('← → の位置の復元 (TODO 1146 段 2)', () => {
    const resourceEvent = {
      uri: 'file:///a.pdf',
      label: 'a.pdf',
      resource: { kind: 'binary', resourceUrl: 'aios-res://x', size: 8, mime: 'application/pdf' },
      editable: false,
      theme: 'light',
      locale: 'ja',
      highlightQuery: null,
      revision: null,
      draft: null
    }
    const restore = (position: { kind: string; value: number }): void =>
      bridgeFixture.restore?.({ uri: 'file:///a.pdf', position })
    const pages = (): string[] => bridgeFixture.positions.map((p) => `${p.position.kind}:${p.position.value}`)

    beforeEach(() => {
      // jsdom does no layout: the top of each page at 1000 each, and the screen height at 900.
      Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('pdf-page') ? Array.from(this.parentElement?.children ?? []).indexOf(this) * 1000 : 0
        }
      })
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 })
      bridgeFixture.positions.length = 0
      pdfFixture.gate = null
      pdfFixture.pages = [1, 2, 3].map(() => ({ width: 600, height: 800, text: ['x'] }))
    })
    afterEach(() => {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetTop
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
    })

    it('読み込み中に届いた位置は並べた後に戻し、仮の 1 ページ目は知らせない', async () => {
      await import('../plugins/aios.pdf/viewer/main.js')
      bridgeFixture.handler?.(resourceEvent)
      restore({ kind: 'page', value: 3 }) // Right after the resource (still loading)
      await flush()
      expect(pages()).not.toContain('page:1')
      expect(pages().at(-1)).toBe('page:3')
      const input = document.querySelector<HTMLInputElement>('.pdf-page-input')
      expect(input?.value).toBe('3')
    })

    it('読み終えた後の位置は読み込みを待たず戻し、ページ数を超えれば末尾、page 以外の単位は捨てる', async () => {
      await import('../plugins/aios.pdf/viewer/main.js')
      bridgeFixture.handler?.(resourceEvent)
      await flush()
      restore({ kind: 'page', value: 2 })
      expect(pages().at(-1)).toBe('page:2')
      restore({ kind: 'page', value: 99 })
      expect(pages().at(-1)).toBe('page:3')
      const before = pages().length
      restore({ kind: 'line', value: 1 })
      restore({ kind: 'offset', value: 10 })
      expect(pages().length).toBe(before)
    })

    it('doc が入って mount の前 (getPage(1) の間) に届いた位置も捨てず、並べた後に戻す', async () => {
      let release: () => void = () => {}
      pdfFixture.gate = new Promise<void>((resolve) => {
        release = resolve
      })
      await import('../plugins/aios.pdf/viewer/main.js')
      bridgeFixture.handler?.(resourceEvent)
      await flush() // doc is assigned, stopped at getPage(1) (the slot does not exist yet)
      restore({ kind: 'page', value: 3 })
      release()
      await flush()
      expect(pages().at(-1)).toBe('page:3')
    })

    it('読み込み済みで遅れて届いた位置は、次の検索の最初の一致への寄せを省かない', async () => {
      pdfFixture.pages = [
        { width: 600, height: 800, text: ['x'] },
        { width: 600, height: 800, text: ['x'] },
        { width: 600, height: 800, text: ['alpha'] }
      ]
      await import('../plugins/aios.pdf/viewer/main.js')
      bridgeFixture.handler?.({ ...resourceEvent, highlightQuery: 'alpha' })
      await flush(10)
      restore({ kind: 'page', value: 1 }) // A late restore after the load and the first search are done
      expect(pages().at(-1)).toBe('page:1')
      const find = document.querySelector<HTMLInputElement>('.pdf-find')
      if (find === null) throw new Error('missing ui')
      find.value = 'alph'
      find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush(10)
      expect(pages().at(-1)).toBe('page:3') // If the flag remains, it stays at 1
    })
  })
})
