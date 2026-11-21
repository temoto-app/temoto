// @vitest-environment jsdom
/**
 * TODO 522 (wave 26 bundle A): Sidebar's web mode (`WebMode`) and the wiring of tab operations (`webStore.ts`). In jsdom, `window.aios.web` is a fake.
 * Neither the model nor electron is used.
 *
 * - three windows (history / Favorite / open tabs) are lined up from the top, and can be folded at their headings (the folding state is stored by main)
 * - tab rows: pressing one first changes main's current tab, then `select(url)`; ✕ closes it and shows the next tab
 * - history rows: a plain click is the current tab (`select` only); ⌘-click is a new tab (`newTab`, then `select`)
 * - a link in an answer (`openExternalLink`) opens a new tab; the + in the heading is a blank tab
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  DEFAULT_WEB_SECTIONS,
  WEB_BLANK_URL,
  type WebHistoryEntry,
  type WebTabsState
} from '../src/shared/web-tabs.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TABS: WebTabsState = {
  tabs: [
    { id: 't1', url: 'https://a.example/', title: 'A page', favicon: null },
    { id: 't2', url: 'https://b.example/', title: '', favicon: 'data:image/png;base64,AA==' }
  ],
  activeId: 't1'
}
const HISTORY: WebHistoryEntry[] = [
  { id: 1, url: 'https://h.example/x', title: 'History row', visitedAt: Date.now(), host: 'h.example' }
]

const calls: string[] = []
let closeResult: WebTabsState = TABS
// TODO 723: `chromeAppIconUrl` (webStore.ts) caches only once inside the module, so the return value of this mock is fixed to what it returns the first time it is called
// (whenever it is called, null = the generic icon).
const chromeIconMock = vi.fn(async () => null as string | null)

function stubApi(): void {
  const web = {
    tabs: vi.fn(async () => TABS),
    history: vi.fn(async () => HISTORY),
    favorites: vi.fn(async () => []),
    favicons: vi.fn(async () => ({})),
    sections: vi.fn(async () => DEFAULT_WEB_SECTIONS),
    onTabsChanged: () => () => {},
    onDataChanged: () => () => {},
    activateTab: vi.fn(async (id: string) => {
      calls.push(`activate:${id}`)
      return TABS
    }),
    newTab: vi.fn(async (url: string | null) => {
      calls.push(`newTab:${url ?? 'blank'}`)
      return TABS
    }),
    closeTab: vi.fn(async (id: string) => {
      calls.push(`close:${id}`)
      return closeResult
    }),
    load: vi.fn(async (url: string) => {
      calls.push(`load:${url}`)
      return true
    }),
    clearHistory: vi.fn(async () => undefined),
    removeHistory: vi.fn(async () => undefined),
    setSections: vi.fn(async () => {
      calls.push('setSections')
    }),
    chromeIcon: chromeIconMock,
    chromeProfiles: vi.fn(async () => null)
  }
  ;(window as unknown as { aios: unknown }).aios = {
    web,
    app: { openExternal: vi.fn(async () => true) },
    fs: {}
  }
}

describe('WebMode と webStore (TODO 522)', () => {
  let container: HTMLDivElement
  let root: Root
  let WebMode: () => React.JSX.Element
  let store: typeof import('../src/renderer/src/store.js')
  let web: typeof import('../src/renderer/src/webStore.js')
  let link: typeof import('../src/renderer/src/markdown-link.js')

  beforeAll(async () => {
    stubApi()
    ;({ WebMode } = await import('../src/renderer/src/components/WebMode.js'))
    store = await import('../src/renderer/src/store.js')
    web = await import('../src/renderer/src/webStore.js')
    link = await import('../src/renderer/src/markdown-link.js')
  })

  beforeEach(async () => {
    stubApi()
    calls.length = 0
    closeResult = TABS
    store.useStore.setState({ selectedUri: null, viewerDeferred: false })
    web.useWeb.setState({ tabs: TABS, history: HISTORY, favorites: [], favicons: {}, sections: DEFAULT_WEB_SECTIONS })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(WebMode))
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('3 つの窓が上から 履歴 / Favorite / 開いているタブ', () => {
    const sections = [...container.querySelectorAll('section.web-section')].map((el) => el.className)
    expect(sections).toEqual([
      'web-section web-section-history',
      'web-section web-section-favorites',
      'web-section web-section-tabs'
    ])
    // Two dividers (one above Favorite and one above the tab heading).
    expect(container.querySelectorAll('.web-section-splitter')).toHaveLength(2)
    const tabRows = container.querySelectorAll('.web-tab-row')
    expect(tabRows).toHaveLength(2)
    expect(tabRows[0]?.classList.contains('selected')).toBe(true)
    expect(tabRows[0]?.textContent).toContain('A page')
    // With no title, the host name is shown; the favicon is an img.
    expect(tabRows[1]?.textContent).toContain('b.example')
    expect(tabRows[1]?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==')
  })

  it('見出しを押すと畳み、main に書かせる', async () => {
    const toggle = container.querySelector('.web-section-history .web-section-toggle') as HTMLButtonElement
    await act(async () => toggle.click())
    expect(web.useWeb.getState().sections.collapsed.history).toBe(true)
    expect(calls).toContain('setSections')
    expect(container.querySelector('.web-section-history .web-section-body')).toBeNull()
  })

  it('タブの行を押す: main の今のタブを替えてから select', async () => {
    const row = container.querySelectorAll('.web-tab-row')[1] as HTMLElement
    await act(async () => row.click())
    expect(calls).toEqual(['activate:t2'])
    expect(store.useStore.getState().selectedUri).toBe('https://b.example/')
    expect(web.useWeb.getState().tabs.activeId).toBe('t2')
  })

  it('同じ URL がもう出ていれば select では読み直されないので直に読ませる', async () => {
    await act(async () => store.useStore.setState({ selectedUri: 'https://b.example/' }))
    const row = container.querySelectorAll('.web-tab-row')[1] as HTMLElement
    await act(async () => row.click())
    expect(calls).toEqual(['activate:t2', 'load:https://b.example/'])
  })

  it('出している今のタブを ✕: 次のタブを出す / 最後の 1 枚ならペインを閉じる', async () => {
    await act(async () => store.useStore.setState({ selectedUri: 'https://a.example/' }))
    closeResult = { tabs: [TABS.tabs[1]!], activeId: 't2' }
    const close = container.querySelector('.web-tab-row .web-tab-close') as HTMLButtonElement
    await act(async () => close.click())
    expect(calls).toEqual(['close:t1'])
    expect(store.useStore.getState().selectedUri).toBe('https://b.example/')

    await act(async () => web.useWeb.setState({ tabs: closeResult }))
    closeResult = { tabs: [], activeId: null }
    await act(async () => web.closeWebTab('t2'))
    expect(store.useStore.getState().selectedUri).toBeNull()
  })

  it('TODO 832 (2): 出している今のタブを閉じたら、その前に出していたファイルに戻す (残りのタブがあっても)', async () => {
    const threads = await import('../src/renderer/src/threadStore.js')
    const at = Date.now()
    await act(async () => {
      threads.useThreads.setState({ activeThreadId: 'th1' })
      store.useStore.setState({
        selectedUri: 'https://a.example/',
        viewerHistories: {
          th1: {
            entries: [
              { uri: 'file:///tmp/a.md', highlight: 'needle', at, byKeys: false },
              { uri: 'https://a.example/', highlight: null, at, byKeys: false }
            ],
            index: 1
          }
        }
      })
    })
    closeResult = { tabs: [TABS.tabs[1]!], activeId: 't2' }
    try {
      await act(async () => web.closeWebTab('t1'))
      expect(calls).toEqual(['close:t1'])
      expect(store.useStore.getState().selectedUri).toBe('file:///tmp/a.md')
      expect(store.useStore.getState().highlightQuery).toBe('needle')
    } finally {
      threads.useThreads.setState({ activeThreadId: null })
      store.useStore.setState({ viewerHistories: {} })
    }
  })

  it('TODO 832 (2): 前に出していたのが別の開いているタブなら、そのタブへ (MRU)', async () => {
    const threads = await import('../src/renderer/src/threadStore.js')
    const at = Date.now()
    const tabs: WebTabsState = {
      tabs: [...TABS.tabs, { id: 't3', url: 'https://c.example/', title: 'C', favicon: null }],
      activeId: 't3'
    }
    await act(async () => {
      web.useWeb.setState({ tabs })
      threads.useThreads.setState({ activeThreadId: 'th1' })
      store.useStore.setState({
        selectedUri: 'https://c.example/',
        viewerHistories: {
          th1: {
            entries: [
              { uri: 'file:///tmp/a.md', highlight: null, at, byKeys: false },
              { uri: 'https://b.example/', highlight: null, at, byKeys: false },
              { uri: 'https://gone.example/', highlight: null, at, byKeys: false },
              { uri: 'https://c.example/', highlight: null, at, byKeys: false }
            ],
            index: 3
          }
        }
      })
    })
    // main chose t1 as the current tab after the close, but the one shown just before was t2 (b.example). The closed page (gone) is skipped.
    closeResult = { tabs: TABS.tabs, activeId: 't1' }
    try {
      await act(async () => web.closeWebTab('t3'))
      expect(calls).toEqual(['close:t3', 'activate:t2'])
      expect(store.useStore.getState().selectedUri).toBe('https://b.example/')
    } finally {
      threads.useThreads.setState({ activeThreadId: null })
      store.useStore.setState({ viewerHistories: {} })
    }
  })

  it('TODO 832 (2): planWebTabClose — 履歴が無い・ファイルも開いているタブも無ければ null', () => {
    const at = 0
    expect(web.planWebTabClose(undefined, 'https://a.example/', TABS)).toBeNull()
    const onlyWeb = {
      entries: [
        { uri: WEB_BLANK_URL, highlight: null, at, byKeys: false },
        { uri: 'https://gone.example/', highlight: null, at, byKeys: false }
      ],
      index: 1
    }
    expect(web.planWebTabClose(onlyWeb, 'https://gone.example/', TABS)).toBeNull()
    // If the current step is not a closed page (a crossed replacement, etc.), look from the current step.
    const fileNow = { entries: [{ uri: 'file:///tmp/b.md', highlight: null, at, byKeys: false }], index: 0 }
    expect(web.planWebTabClose(fileNow, 'https://a.example/', TABS)).toEqual({
      kind: 'file',
      uri: 'file:///tmp/b.md',
      highlight: null
    })
  })

  it('ファイルを出している間に今のタブを閉じても、ファイルはそのまま', async () => {
    await act(async () => store.useStore.setState({ selectedUri: 'file:///tmp/a.md' }))
    closeResult = { tabs: [TABS.tabs[1]!], activeId: 't2' }
    await act(async () => web.closeWebTab('t1'))
    expect(store.useStore.getState().selectedUri).toBe('file:///tmp/a.md')
  })

  it('履歴の行: 素のクリックは今のタブ、⌘ クリックは新しいタブ', async () => {
    const row = container.querySelector('.web-section-history .web-row') as HTMLElement
    await act(async () => row.click())
    expect(calls).toEqual([])
    expect(store.useStore.getState().selectedUri).toBe('https://h.example/x')
    await act(async () => store.useStore.setState({ selectedUri: null }))
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    })
    expect(calls).toEqual(['newTab:https://h.example/x'])
    expect(store.useStore.getState().selectedUri).toBe('https://h.example/x')
  })

  // code-review (TODO 722): the list's rows carry only the host, not the favicon's data URL. The renderer looks it up per row from `favicons`
  // (the map of host → data URL, looked up once).
  it('code-review (722): 履歴 / Favorite の行の favicon は favicons の地図 (host) から引く', async () => {
    await act(async () =>
      web.useWeb.setState({
        history: [{ id: 9, url: 'https://h.example/x', title: 'History row', visitedAt: Date.now(), host: 'h.example' }],
        favorites: [{ id: 1, url: 'https://fav.example/', title: 'Fav', createdAt: 0, host: 'fav.example' }],
        favicons: { 'h.example': 'data:image/png;base64,HH==' }
      })
    )
    const historyRow = container.querySelector('.web-section-history .web-row') as HTMLElement
    expect(historyRow.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,HH==')
    // Hosts of favorites are not in the map, so the generic icon is used (no img).
    const favoriteRow = container.querySelector('.web-section-favorites .web-row') as HTMLElement
    expect(favoriteRow.querySelector('img')).toBeNull()
  })

  it('TODO 560: Favorite の行は、同じページ (# を除く) のタブが開いていればそこへ移るだけ', async () => {
    await act(async () =>
      web.useWeb.setState({
        favorites: [
          { id: 1, url: 'https://b.example/#top', title: 'B', createdAt: 0, host: 'b.example' },
          { id: 2, url: 'https://c.example/', title: 'C', createdAt: 0, host: 'c.example' }
        ]
      })
    )
    await act(async () => store.useStore.setState({ selectedUri: 'https://a.example/' }))
    const rows = container.querySelectorAll('.web-section-favorites .web-row')
    await act(async () => (rows[0] as HTMLElement).click())
    expect(calls).toEqual(['activate:t2'])
    expect(store.useStore.getState().selectedUri).toBe('https://b.example/')
    expect(web.useWeb.getState().tabs.activeId).toBe('t2')

    // A page that is not open still goes to the current tab, as before.
    calls.length = 0
    await act(async () => (rows[1] as HTMLElement).click())
    expect(calls).toEqual([])
    expect(store.useStore.getState().selectedUri).toBe('https://c.example/')

    // ⌘-click is an explicit new tab.
    calls.length = 0
    await act(async () => {
      rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    })
    expect(calls).toEqual(['newTab:https://b.example/#top'])
  })

  it('TODO 560: 履歴の行も同じ。もう出している今のタブなら何もしない (読み直さない)', async () => {
    await act(async () =>
      web.useWeb.setState({
        history: [{ id: 9, url: 'https://a.example/', title: '', visitedAt: Date.now(), host: 'a.example' }]
      })
    )
    await act(async () => store.useStore.setState({ selectedUri: 'https://a.example/' }))
    const row = container.querySelector('.web-section-history .web-row') as HTMLElement
    await act(async () => row.click())
    expect(calls).toEqual([])
    expect(store.useStore.getState().selectedUri).toBe('https://a.example/')
  })

  it('TODO 560: findOpenWebTab は # だけを無視し、遷移したタブ (パス・クエリが違う) は別物', () => {
    const tabs: WebTabsState = {
      tabs: [
        { id: 'x', url: 'https://s.example/p?q=1#h', title: '', favicon: null },
        { id: 'y', url: 'https://s.example/p', title: '', favicon: null }
      ],
      activeId: 'x'
    }
    expect(web.findOpenWebTab(tabs, 'https://s.example/p?q=1')?.id).toBe('x')
    expect(web.findOpenWebTab(tabs, 'https://s.example/p#other')?.id).toBe('y')
    expect(web.findOpenWebTab(tabs, 'https://s.example/p?q=2')).toBeNull()
    expect(web.findOpenWebTab(tabs, 'https://s.example/p/')).toBeNull()
    expect(web.findOpenWebTab(tabs, 'not a url')).toBeNull()
  })

  it('回答のリンクは新しいタブ、見出しの + は空白のタブ', async () => {
    await act(async () => link.openExternalLink('https://answer.example/'))
    expect(calls).toEqual(['newTab:https://answer.example/'])
    expect(store.useStore.getState().selectedUri).toBe('https://answer.example/')
    calls.length = 0
    const plus = container.querySelector('.web-section-tabs .web-section-action') as HTMLButtonElement
    const before = web.useWeb.getState().focusAddress
    await act(async () => plus.click())
    expect(calls).toEqual(['newTab:blank'])
    expect(store.useStore.getState().selectedUri).toBe(WEB_BLANK_URL)
    expect(web.useWeb.getState().focusAddress).toBe(before + 1)
  })

  // TODO 723: when Favorite is empty, the body also shows a 'Import from Chrome' button (the icon in the heading remains).
  it('723: Favorite が空のときは本文にも Chrome から取り込むボタンが出る', async () => {
    expect(container.querySelector('.web-section-favorites .icon-button.web-section-action')).not.toBeNull()
    const action = container.querySelector('.web-favorites-empty-action') as HTMLButtonElement
    expect(action).not.toBeNull()
    expect(action.textContent).toContain('Chrome')
    // Even after the icon load (chromeAppIconUrl) resolves, if there is none it stays the generic icon (svg).
    await act(async () => Promise.resolve())
    expect(action.querySelector('svg')).not.toBeNull()
    expect(action.querySelector('img')).toBeNull()
    // Pressing it follows the same flow as the heading button (if no profile is found, the 'not found' message).
    await act(async () => action.click())
    await act(async () => Promise.resolve())
    expect(web.useWeb.getState().chromeImportMessage).not.toBeNull()
  })
})
