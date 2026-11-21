// @vitest-environment jsdom
/**
 * Waves 27 and 32: the URL field of ViewerPane's Web display (`WebViewerPane`). In jsdom, `window.aios.web` is a fake.
 * Neither the model nor electron is used.
 *
 * - TODO 691: the URL field is both the URL and Google search. A word that is not a URL goes to Google search on Enter (other schemes such as `file:` and
 *   `javascript:` are still refused as before, and not searched). The mark for ASCII input in the URL field (556) is withdrawn (it got in the way of searching in Japanese).
 * - TODO 554: type and press Enter to open in the current tab (`http(s)://` is supplied); Esc returns to the original URL; the signal (`focusWebAddress`, the destination
 *   of the ⌘L wiring) gives focus. Even if the URL changes while something is being typed, the typed text is not cleared.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ASCII_INPUT_ATTRIBUTE } from '../src/shared/ascii-input.js'
import { EMPTY_WEB_TABS, googleSearchUrl, isLocalPathInput, normalizeAddress } from '../src/shared/web-tabs.js'
import type { WebViewEvent } from '../src/shared/web-view.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

const loads: string[] = []
let emit: ((event: WebViewEvent) => void) | null = null

const resolveLink = vi.fn(async (input: { href: string }) =>
  input.href.includes('missing')
    ? { ok: false as const, reason: 'link-not-found' }
    : { ok: true as const, uri: `file://${input.href.replace(/^~/, '/Users/me')}` }
)

function stubApi(): void {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
  window.focus = () => undefined
  const web = {
    load: vi.fn(async (url: string) => {
      loads.push(url)
      return true
    }),
    setBounds: vi.fn(async () => undefined),
    setVisible: vi.fn(async () => null),
    setShortcuts: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    focus: vi.fn(async () => undefined),
    find: vi.fn(async () => undefined),
    stopFind: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    onEvent: (listener: (event: WebViewEvent) => void) => {
      emit = listener
      return () => {
        emit = null
      }
    },
    certificateStatus: vi.fn(async () => ({ trustable: false, changed: false })),
    trustCertificate: vi.fn(async () => false)
  }
  ;(window as unknown as { aios: unknown }).aios = { web, app: { openExternal: vi.fn(async () => true) }, fs: { resolveLink } }
}

/** Flushes the focus queued in rAF. */
async function flushFrames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

describe('WebViewerPane の URL 欄 (TODO 554 / 556)', () => {
  let container: HTMLDivElement
  let root: Root
  let WebViewerPane: typeof import('../src/renderer/src/components/WebViewerPane.js').WebViewerPane
  let store: typeof import('../src/renderer/src/store.js')
  let web: typeof import('../src/renderer/src/webStore.js')

  beforeAll(async () => {
    stubApi()
    ;({ WebViewerPane } = await import('../src/renderer/src/components/WebViewerPane.js'))
    store = await import('../src/renderer/src/store.js')
    web = await import('../src/renderer/src/webStore.js')
  })

  const render = async (uri: string): Promise<void> => {
    await act(async () => {
      root.render(createElement(WebViewerPane, { uri, nav: null, close: null }))
    })
  }

  const field = (): HTMLInputElement => container.querySelector('.web-address-input') as HTMLInputElement

  const type = async (value: string): Promise<void> => {
    const input = field()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const press = async (key: string): Promise<void> => {
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  beforeEach(async () => {
    stubApi()
    loads.length = 0
    store.useStore.setState({ selectedUri: 'https://a.example/', viewerDeferred: false, transient: null })
    web.useWeb.setState({ tabs: EMPTY_WEB_TABS, favorites: [] })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await render('https://a.example/')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('691 (556 の取りやめ): URL 欄に英字入力の印は付かない', () => {
    expect(field().hasAttribute(ASCII_INPUT_ATTRIBUTE)).toBe(false)
    expect(field().readOnly).toBe(false)
    expect(field().value).toBe('https://a.example/')
  })

  it('554: 打って Enter → スキームを補って今のタブに開く', async () => {
    await type('example.org/docs')
    await press('Enter')
    expect(store.useStore.getState().selectedUri).toBe('https://example.org/docs')
  })

  it('554: 社内の 1 語のホスト + パスは https で開く', async () => {
    await type('vm-soft04/redmine/issues/1')
    await press('Enter')
    expect(store.useStore.getState().selectedUri).toBe('https://vm-soft04/redmine/issues/1')
  })

  it('691: URL でない語は Enter で Google 検索に回す', async () => {
    for (const [query, want] of [
      ['hello', 'hello'],
      ['two words', 'two words']
    ] as const) {
      await type(query)
      await press('Enter')
      expect(field().classList.contains('invalid'), query).toBe(false)
      expect(store.useStore.getState().selectedUri).toBe(googleSearchUrl(want))
    }
  })

  it('691: 他のスキーム (file: / javascript:) は今までどおり断る (検索にもしない)', async () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd']) {
      await type(bad)
      await press('Enter')
      expect(field().classList.contains('invalid'), bad).toBe(true)
      expect(store.useStore.getState().selectedUri).toBe('https://a.example/')
    }
  })

  it('771: ファイルのパス (/…・~/…) は検索ではなく viewer で開く (解き方は main の fs.resolveLink)', async () => {
    await type('/Users/me/My Docs/a.txt')
    await press('Enter')
    expect(resolveLink).toHaveBeenLastCalledWith({ href: '/Users/me/My Docs/a.txt', threadId: null, baseUri: null })
    await act(async () => undefined)
    expect(store.useStore.getState().selectedUri).toBe('file:///Users/me/My Docs/a.txt')
    await type('~/notes.md')
    await press('Enter')
    expect(resolveLink).toHaveBeenLastCalledWith({ href: '~/notes.md', threadId: null, baseUri: null })
  })

  it('771: isLocalPathInput は / と ~ で始まるパスだけ (//host・/ 空白・普通の語は違う)', () => {
    for (const yes of ['/Users/me', '~', '~/a b', '  /etc/hosts ']) expect(isLocalPathInput(yes), yes).toBe(true)
    for (const no of ['//example.com', '/ x', 'hello', 'example.com/a', '~foo', 'file:///etc', '']) {
      expect(isLocalPathInput(no), no).toBe(false)
    }
  })

  it('554: Esc で元の URL に戻す', async () => {
    await type('example.org')
    expect(field().value).toBe('example.org')
    await press('Escape')
    expect(field().value).toBe('https://a.example/')
  })

  it('554: 合図 (focusWebAddress、⌘L の配線先) で URL 欄に focus', async () => {
    field().blur()
    expect(document.activeElement).not.toBe(field())
    await act(async () => web.focusWebAddress())
    await flushFrames()
    expect(document.activeElement).toBe(field())
  })

  it('554: 打っている最中にページが移っても打ちかけを消さない。focus が無ければ新しい URL', async () => {
    await act(async () => field().focus())
    await type('example.org/typing')
    await act(async () => emit?.({ kind: 'navigated', url: 'https://a.example/next', replace: true }))
    await render('https://a.example/next')
    expect(field().value).toBe('example.org/typing')
    await act(async () => field().blur())
    await render('https://a.example/third')
    expect(field().value).toBe('https://a.example/third')
  })

  it('598-4: 今のタブを閉じた知らせが select より先に届いても、閉じたページを右隣のタブに読ませない', async () => {
    const tab = (id: string, url: string) => ({ id, url, title: '', favicon: null })
    await act(async () =>
      web.useWeb.setState({ tabs: { tabs: [tab('t1', 'https://a.example/'), tab('t2', 'https://b.example/')], activeId: 't1' } })
    )
    loads.length = 0
    // main's onTabsChanged: t1 is closed and t2 is the current tab (the renderer is still showing a)
    await act(async () => web.useWeb.setState({ tabs: { tabs: [tab('t2', 'https://b.example/')], activeId: 't2' } }))
    expect(loads).toEqual([])
    // The URL on the right, by the following select
    await render('https://b.example/')
    expect(loads).toEqual(['https://b.example/'])
    // The same page was opened in another tab (the URL of the new current tab is the same as the URL being shown): read as before
    await act(async () =>
      web.useWeb.setState({ tabs: { tabs: [tab('t2', 'https://b.example/'), tab('t3', 'https://b.example/')], activeId: 't3' } })
    )
    expect(loads).toEqual(['https://b.example/', 'https://b.example/'])
  })

  it('580: ペインが外れたら理由を渡す — ✕ (markWebPaneClosing) は close、それ以外 (ファイルに切り替えた) は hide', async () => {
    const { markWebPaneClosing } = await import('../src/renderer/src/components/WebViewerPane.js')
    const close = (window as unknown as { aios: { web: { close: ReturnType<typeof vi.fn> } } }).aios.web.close
    // Switched to a file: only the part comes off.
    await act(async () => root.render(createElement('div')))
    expect(close.mock.calls).toEqual([['hide']])
    // Back, then ✕.
    await render('https://a.example/')
    await act(async () => {
      markWebPaneClosing()
      root.render(createElement('div'))
    })
    expect(close.mock.calls).toEqual([['hide'], ['close']])
    // The mark disappears after one time (the next time it comes off, it is hidden).
    await render('https://a.example/')
    await act(async () => root.render(createElement('div')))
    expect(close.mock.calls.at(-1)).toEqual(['hide'])
  })

  it('589: 割り当てが変わったら、出ているペインが今の割り当ての表を main に送り直す (外れた後は送らない)', async () => {
    const { setKeybindings } = await import('../src/renderer/src/shortcuts.js')
    const setShortcuts = (window as unknown as { aios: { web: { setShortcuts: ReturnType<typeof vi.fn> } } }).aios.web
      .setShortcuts
    const reloadRows = (call: unknown[] | undefined) =>
      ((call?.[0] ?? []) as { id: string; key: string }[]).filter((row) => row.id === 'webReload').map((row) => row.key)
    expect(setShortcuts).toHaveBeenCalledTimes(1)
    try {
      await act(async () => setKeybindings({ 'web.reload': 'CmdOrCtrl+Shift+L' }))
      expect(setShortcuts).toHaveBeenCalledTimes(2)
      expect(reloadRows(setShortcuts.mock.calls[1])).toEqual(['l'])
      await act(async () => root.render(createElement('div')))
      await act(async () => setKeybindings({}))
      expect(setShortcuts).toHaveBeenCalledTimes(2)
    } finally {
      setKeybindings({})
    }
  })
})

describe('normalizeAddress の 1 語のホスト (TODO 554) と Google 検索 (TODO 691)', () => {
  it('パスかポートが続けば URL、1 語だけ・先頭の / は検索へ', () => {
    expect(normalizeAddress('vm-soft04/redmine')).toBe('https://vm-soft04/redmine')
    expect(normalizeAddress('vm-soft04/')).toBe('https://vm-soft04/')
    expect(normalizeAddress('vm-soft04:8080')).toBe('https://vm-soft04:8080')
    expect(normalizeAddress('intranet?q=1')).toBe('https://intranet?q=1')
    for (const query of ['hello', 'vm-soft04', '/etc/passwd', '//evil/x', 'a b/c', '日本語/パス']) {
      expect(normalizeAddress(query), query).toBe(googleSearchUrl(query))
    }
  })

  it('空文字は null (Enter で何もしない)、他のスキームは断る (検索にもしない)', () => {
    expect(normalizeAddress('')).toBeNull()
    expect(normalizeAddress('   ')).toBeNull()
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.example']) {
      expect(normalizeAddress(bad), bad).toBeNull()
    }
  })

  it('TODO 691 の code-review: 空白を含む「他のスキームに見える」文は検索 (断らない)', () => {
    for (const query of [
      'TypeError: Cannot read properties of undefined',
      're: meeting notes',
      'localhost:3000 docs',
      'javascript: alert(1)'
    ]) {
      expect(normalizeAddress(query), query).toBe(googleSearchUrl(query))
    }
  })

  it('TODO 691 の code-review: 空白なしでも `::` (std::vector) はスキームとみなさず検索', () => {
    expect(normalizeAddress('std::vector')).toBe(googleSearchUrl('std::vector'))
  })

  it('Google 検索の URL は q= にそのまま encode したクエリを載せる', () => {
    expect(googleSearchUrl('hello world')).toBe('https://www.google.com/search?q=hello%20world')
    expect(normalizeAddress('日本語 検索')).toBe(googleSearchUrl('日本語 検索'))
  })
})
