/**
 * TODO 522 (wave 26 bundle A): web tabs, history, Favorite, and the three windows of the Sidebar. Neither the model nor electron is used.
 *
 * - pure functions of `shared/web-tabs.ts` (interpreting the URL field, URLs that may be saved, the order of tabs, checking and taking over memory)
 * - main's `WebTabs` (the current tab, and the destination of the view's notices) and `WebTabsMemory` (kept even when the window is closed or the app quits)
 * - main's `WebDataStore` (the table of migration 22, in-memory DB): history with one row per URL, redaction, the cap, and the order of Favorite
 * - `WebViewHost`'s new notices (`onNavigated` / `onTitle` / `onFavicon`)
 * - renderer's `web-sections.ts` (height allocation of the three windows, and drag)
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { UI_WEB_SECTIONS, WEB_TABS } from '../src/common/settings-keys.js'
import {
  DEFAULT_WEB_SECTIONS,
  EMPTY_WEB_TABS,
  MAX_STORED_WEB_TAB_SETS,
  MAX_WEB_TABS,
  WEB_BLANK_URL,
  WEB_HISTORY_MAX_AGE_MS,
  WEB_HISTORY_MAX_ROWS,
  cleanWebTitle,
  googleSearchUrl,
  insertTab,
  isWebPaneUri,
  normalizeAddress,
  parseStoredWebTabSets,
  patchTab,
  persistableWebUrl,
  pickStoredTabSet,
  removeTab,
  sanitizeWebSections,
  toStoredTabs,
  upsertStoredTabSet,
  webTabLabel,
  type StoredWebTabSet,
  type WebTab,
  type WebTabsState
} from '../src/shared/web-tabs.js'
import { WebTabs, WebTabsMemory, WEB_TABS_SAVE_DELAY_MS } from '../src/main/web/tabs.js'
import { WebDataStore } from '../src/main/web/data.js'
import { WEB_HIDDEN_VIEWS_TTL_MS, WebViewHost, type WebViewLike } from '../src/main/web/host.js'
import {
  SECTION_HEADER_PX,
  SECTION_MIN_PX,
  dragWebSections,
  favoriteDropIndex,
  layoutWebSections,
  splitterActive,
  toggleWebSection
} from '../src/renderer/src/web-sections.js'

const tab = (id: string, url = `https://${id}.example/`): WebTab => ({ id, url, title: '', favicon: null })

describe('shared/web-tabs: URL', () => {
  it('URL field: fills in the scheme, localhost is http; refuses other schemes and URLs with credentials (TODO 691)', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com')
    expect(normalizeAddress('  example.com/a?b=1 ')).toBe('https://example.com/a?b=1')
    expect(normalizeAddress('https://example.com/x')).toBe('https://example.com/x')
    expect(normalizeAddress('http://example.com')).toBe('http://example.com')
    expect(normalizeAddress('localhost:8000/x')).toBe('http://localhost:8000/x')
    expect(normalizeAddress('127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(normalizeAddress('example.com:8080/a')).toBe('https://example.com:8080/a')
    expect(normalizeAddress('')).toBeNull()
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'https://u:p@x.com/']) {
      expect(normalizeAddress(bad), bad).toBeNull()
    }
  })

  it('691: a word that is not a URL (looks like search terms) becomes a Google search URL', () => {
    expect(normalizeAddress('hello')).toBe(googleSearchUrl('hello'))
    expect(normalizeAddress('two words.com')).toBe(googleSearchUrl('two words.com'))
  })

  it('URLs that may be saved: drops queries that show a secret, does not keep one if it looks like a path, http(s) only', () => {
    expect(persistableWebUrl('https://example.com/a?q=1#x')).toBe('https://example.com/a?q=1#x')
    expect(persistableWebUrl('https://example.com/cb?access_token=abcdefgh12345678&x=1')).toBe('https://example.com/cb')
    expect(persistableWebUrl('https://example.com/ghp_abcdefghijklmnopqrstuvwxyz1234')).toBeNull()
    expect(persistableWebUrl('file:///etc/passwd')).toBeNull()
    expect(persistableWebUrl(WEB_BLANK_URL)).toBeNull()
    expect(isWebPaneUri(WEB_BLANK_URL)).toBe(true)
    expect(isWebPaneUri('https://example.com/')).toBe(true)
    expect(isWebPaneUri('file:///x')).toBe(false)
  })

  it('characters of the title and heading', () => {
    expect(cleanWebTitle('  a\n\tb  ')).toBe('a b')
    expect(cleanWebTitle(42)).toBe('')
    expect(cleanWebTitle('x'.repeat(400))).toHaveLength(300)
    expect(webTabLabel({ url: 'https://example.com/a', title: '' })).toBe('example.com')
    expect(webTabLabel({ url: 'https://example.com/a', title: 'Home' })).toBe('Home')
    expect(webTabLabel({ url: WEB_BLANK_URL, title: '' })).toBe('')
  })

  it('the folding and heights of the three panes reset a broken field to the default', () => {
    expect(sanitizeWebSections(null)).toEqual(DEFAULT_WEB_SECTIONS)
    expect(
      sanitizeWebSections({ collapsed: { history: true, tabs: 'yes' }, historyRatio: 5, tabsHeight: -3 })
    ).toEqual({ collapsed: { history: true, favorites: false, tabs: false }, historyRatio: 0.9, tabsHeight: 0 })
  })
})

describe('shared/web-tabs: tab order', () => {
  it('a new tab goes to the right of the current tab and becomes the current tab', () => {
    let state: WebTabsState = EMPTY_WEB_TABS
    state = insertTab(state, tab('a'))
    state = insertTab(state, tab('b'))
    state = { ...state, activeId: 'a' }
    state = insertTab(state, tab('c'))
    expect(state.tabs.map((t) => t.id)).toEqual(['a', 'c', 'b'])
    expect(state.activeId).toBe('c')
  })

  it('does not create a tab at the limit', () => {
    let state: WebTabsState = EMPTY_WEB_TABS
    for (let i = 0; i < MAX_WEB_TABS; i++) state = insertTab(state, tab(`t${i}`))
    expect(insertTab(state, tab('over'))).toBe(state)
  })

  it('TODO 1326: closing the current tab leaves no current tab (no fall to a neighbor); closing others does not move the current tab', () => {
    const state: WebTabsState = { tabs: [tab('a'), tab('b'), tab('c')], activeId: 'b' }
    expect(removeTab(state, 'b')).toEqual({ tabs: [tab('a'), tab('c')], activeId: null })
    expect(removeTab({ ...state, activeId: 'c' }, 'c').activeId).toBeNull()
    expect(removeTab(state, 'a').activeId).toBe('b')
    expect(removeTab({ tabs: [tab('a')], activeId: 'a' }, 'a')).toEqual({ tabs: [], activeId: null })
    expect(removeTab(state, 'nope')).toBe(state)
  })

  it('patchTab returns the same object when nothing changes', () => {
    const state: WebTabsState = { tabs: [tab('a')], activeId: 'a' }
    expect(patchTab(state, 'a', { title: '' })).toBe(state)
    expect(patchTab(state, 'a', { title: 'T' }).tabs[0]?.title).toBe('T')
  })
})

describe('shared/web-tabs: tab memory', () => {
  const set = (owner: string, patch: Partial<StoredWebTabSet> = {}): StoredWebTabSet => ({
    owner,
    tabs: [{ url: `https://${owner}.example/`, title: owner }],
    active: 0,
    updatedAt: 0,
    closedAt: null,
    ...patch
  })

  it("shape to write: drops tabs with URLs that cannot be kept, keeps blank tabs, and recounts the current tab's number", () => {
    const state: WebTabsState = {
      tabs: [
        tab('a', 'https://x.example/?token=abcdefghijklmnop'),
        { ...tab('s', 'https://x.example/ghp_abcdefghijklmnopqrstuvwxyz1234') },
        tab('b', WEB_BLANK_URL),
        tab('c')
      ],
      activeId: 'c'
    }
    expect(toStoredTabs(state)).toEqual({
      tabs: [
        { url: 'https://x.example/', title: '' },
        { url: WEB_BLANK_URL, title: '' },
        { url: 'https://c.example/', title: '' }
      ],
      active: 2
    })
  })

  it('validating saved values: discards broken elements and empty sets, and an out-of-range number is 0', () => {
    const parsed = parseStoredWebTabSets([
      { owner: 'x', tabs: [{ url: 'https://a.example/', title: 'A' }, { url: 'javascript:1' }], active: 5, updatedAt: 3 },
      { owner: 'y', tabs: [] },
      'nope',
      { tabs: 'x' }
    ])
    expect(parsed).toEqual([
      { owner: 'x', tabs: [{ url: 'https://a.example/', title: 'A' }], active: 0, updatedAt: 3, closedAt: null }
    ])
    expect(parseStoredWebTabSets('x')).toEqual([])
  })

  it('adoption: from sets with no owner, windows open at quit first, newest first', () => {
    const sets = [
      set('closed-new', { closedAt: 50 }),
      set('open-old', { updatedAt: 10 }),
      set('open-new', { updatedAt: 20 }),
      set('live', { updatedAt: 99 })
    ]
    expect(pickStoredTabSet(sets, new Set(['live']))?.owner).toBe('open-new')
    expect(pickStoredTabSet([set('a', { closedAt: 1 }), set('b', { closedAt: 2 })], new Set())?.owner).toBe('b')
    expect(pickStoredTabSet([set('live')], new Set(['live']))).toBeNull()
  })

  it("rewrite: puts the window's set first, removes it if empty, and drops the oldest ownerless ones at the limit", () => {
    const many = Array.from({ length: MAX_STORED_WEB_TAB_SETS }, (_, i) => set(`old${i}`, { closedAt: i }))
    const next = upsertStoredTabSet(many, 'me', set('me'), new Set(['me']))
    expect(next).toHaveLength(MAX_STORED_WEB_TAB_SETS)
    expect(next[0]?.owner).toBe('me')
    expect(next.some((item) => item.owner === 'old0')).toBe(false)
    expect(upsertStoredTabSet(next, 'me', null, new Set()).some((item) => item.owner === 'me')).toBe(false)
  })
})

describe('main/web/tabs: WebTabs', () => {
  let changes: WebTabsState[]
  let tabs: WebTabs
  beforeEach(() => {
    changes = []
    tabs = new WebTabs({ onChange: (state) => changes.push(state) })
  })

  it("reading with no tab creates one, and the view's notices (navigation, title) attach to that tab", () => {
    tabs.willLoad('https://a.example/')
    expect(tabs.current.tabs).toHaveLength(1)
    expect(tabs.activeTab?.url).toBe('https://a.example/')
    tabs.navigated('https://a.example/home', true)
    tabs.titled('  Home\n')
    expect(tabs.activeTab).toMatchObject({ url: 'https://a.example/home', title: 'Home' })
    expect(changes.length).toBeGreaterThan(0)
  })

  it('TODO 1326: closing the current tab leaves none; the next load makes a tab already showing that URL current, else opens one', () => {
    tabs.open('https://a.example/')
    const a = tabs.activeTab?.id ?? ''
    tabs.open('https://b.example/')
    const b = tabs.activeTab?.id ?? ''
    tabs.open('https://c.example/')
    tabs.close(tabs.activeTab?.id)
    expect(tabs.activeTab).toBeNull()
    expect(tabs.willLoad('https://a.example/')).toBe(a)
    expect(tabs.current.tabs.map((t) => t.url)).toEqual(['https://a.example/', 'https://b.example/'])
    // No tab shows d: a new tab, and b (another page) is not overwritten.
    tabs.close(a)
    expect(tabs.activeTab).toBeNull()
    const fresh = tabs.willLoad('https://d.example/')
    expect(fresh).not.toBe(b)
    expect(tabs.current.tabs.map((t) => t.url)).toEqual(['https://b.example/', 'https://d.example/'])
  })

  it('a view notice that arrives right after switching tabs (before loading) attaches to the previous tab', () => {
    tabs.willLoad('https://a.example/')
    const first = tabs.activeTab?.id ?? ''
    tabs.open('https://b.example/')
    tabs.titled('A title')
    expect(tabs.current.tabs.find((t) => t.id === first)?.title).toBe('A title')
    expect(tabs.activeTab?.title).toBe('')
    tabs.willLoad('https://b.example/')
    tabs.titled('B title')
    expect(tabs.activeTab?.title).toBe('B title')
  })

  it('a document navigation empties the title, and a host change also empties the favicon; in-page navigation keeps the title', () => {
    tabs.willLoad('https://a.example/')
    const id = tabs.activeTab?.id ?? ''
    tabs.titled('A')
    tabs.favicon(id, 'https://a.example/', 'data:image/png;base64,AA==')
    tabs.navigated('https://a.example/#x', false)
    expect(tabs.activeTab).toMatchObject({ title: 'A', favicon: 'data:image/png;base64,AA==' })
    tabs.navigated('https://a.example/next', true)
    expect(tabs.activeTab).toMatchObject({ title: '', favicon: 'data:image/png;base64,AA==' })
    tabs.navigated('https://b.example/', true)
    expect(tabs.activeTab?.favicon).toBeNull()
    // A favicon whose host changed while it was being fetched is discarded.
    tabs.favicon(id, 'https://a.example/', 'data:image/png;base64,BB==')
    expect(tabs.activeTab?.favicon).toBeNull()
  })

  it('598-3: reload (a document navigation to the same URL) keeps the title; navigation after loading a changed URL empties it', () => {
    tabs.willLoad('https://a.example/')
    tabs.navigated('https://a.example/', true)
    tabs.titled('A')
    // ⌘R / button: did-navigate with the same URL without going through willLoad. If the title is the same, page-title-updated does not come.
    tabs.navigated('https://a.example/', true)
    expect(tabs.activeTab?.title).toBe('A')
    // Another URL in the URL field -> the previous title disappears on moving
    tabs.willLoad('https://a.example/next')
    tabs.navigated('https://a.example/next', true)
    expect(tabs.activeTab?.title).toBe('')
    tabs.titled('Next')
    tabs.navigated('https://a.example/next', true)
    expect(tabs.activeTab?.title).toBe('Next')
  })

  it('a blank tab, an unknown id, a closed tab', () => {
    tabs.open(null)
    expect(tabs.activeTab?.url).toBe(WEB_BLANK_URL)
    expect(tabs.open('javascript:1')).not.toBeNull()
    expect(tabs.activeTab?.url).toBe(WEB_BLANK_URL)
    expect(tabs.activate('nope')).toBe(false)
    expect(tabs.close(42)).toBe(false)
    const id = tabs.activeTab?.id ?? ''
    tabs.willLoad('https://a.example/')
    expect(tabs.close(id)).toBe(true)
    // Once the tab the view was showing is closed, later notices from the view attach to no tab.
    tabs.titled('ghost')
    expect(tabs.current.tabs.every((t) => t.title !== 'ghost')).toBe(true)
  })

  it('restoring from memory', () => {
    tabs.restore([{ url: 'https://a.example/', title: 'A' }, { url: WEB_BLANK_URL, title: '' }], 1)
    expect(tabs.current.tabs.map((t) => t.url)).toEqual(['https://a.example/', WEB_BLANK_URL])
    expect(tabs.activeTab?.url).toBe(WEB_BLANK_URL)
  })
})

describe('main/web/tabs: WebTabsMemory', () => {
  let stored: readonly StoredWebTabSet[]
  let timers: (() => void)[]
  let now: number
  const memory = (): WebTabsMemory =>
    new WebTabsMemory({
      read: () => stored,
      write: (sets) => {
        stored = sets
      },
      now: () => now,
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => {
        timers = []
      }
    })
  const state = (...urls: string[]): WebTabsState => ({
    tabs: urls.map((url, i) => tab(`x${i}`, url)),
    activeId: 'x0'
  })

  beforeEach(() => {
    stored = []
    timers = []
    now = 1000
  })

  it('writes changes together, stamps the closing time when a window closes, and the next window adopts it', () => {
    const m = memory()
    expect(m.adopt('w1')).toBeNull()
    m.save('w1', state('https://a.example/'))
    m.save('w1', state('https://a.example/', 'https://b.example/'))
    expect(stored).toEqual([])
    expect(timers).toHaveLength(1)
    timers[0]?.()
    expect(stored[0]?.tabs).toHaveLength(2)
    now = 2000
    m.release('w1', state('https://a.example/', 'https://b.example/'))
    expect(stored[0]?.closedAt).toBe(2000)
    const adopted = m.adopt('w2')
    expect(adopted?.tabs.map((t) => t.url)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(stored[0]).toMatchObject({ owner: 'w2', closedAt: null })
    // A window set that is still alive is not taken by another window.
    expect(m.adopt('w3')).toBeNull()
  })

  it('removes the set of a window with 0 tabs / writes nothing after quit', () => {
    const m = memory()
    m.save('w1', state('https://a.example/'))
    m.flush()
    expect(stored).toHaveLength(1)
    m.save('w1', EMPTY_WEB_TABS)
    m.shutdown()
    expect(stored).toHaveLength(0)
    m.save('w1', state('https://a.example/'))
    m.release('w1', state('https://a.example/'))
    m.flush()
    expect(stored).toHaveLength(0)
    expect(WEB_TABS_SAVE_DELAY_MS).toBeGreaterThan(0)
  })

  it('the next launch (a new WebTabsMemory) can adopt the set from the previous launch', () => {
    const first = memory()
    first.save('w1', state('https://a.example/'))
    first.shutdown()
    const second = memory()
    expect(second.adopt('w9')?.tabs[0]?.url).toBe('https://a.example/')
  })
})

describe('main/web/data: WebDataStore (migration 22)', () => {
  let db: Db
  let now: number
  let store: WebDataStore
  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    now = 1_000_000_000_000
    store = new WebDataStore(db, () => now)
  })
  afterEach(() => db.close())

  it('history is one row per URL, newest first; the title is not overwritten with an empty one', () => {
    expect(store.recordVisit('https://a.example/', 'A')).toBe(true)
    now += 10
    store.recordVisit('https://b.example/', '')
    now += 10
    store.recordVisit('https://a.example/', '')
    const rows = store.listHistory()
    expect(rows.map((row) => row.url)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(rows[0]).toMatchObject({ title: 'A', visitedAt: now })
    expect(store.updateTitle('https://b.example/', 'B')).toBe(true)
    expect(store.listHistory()[1]?.title).toBe('B')
    // With the same title it does not say 'changed' (to avoid every window re-reading the list).
    expect(store.updateTitle('https://b.example/', 'B')).toBe(false)
  })

  it('writes a URL that shows a secret with the query dropped / does not write a URL that cannot be written', () => {
    store.recordVisit('https://a.example/cb?access_token=abcdefgh12345678', 'x')
    expect(store.recordVisit('https://a.example/ghp_abcdefghijklmnopqrstuvwxyz1234', 'x')).toBe(false)
    expect(store.recordVisit('file:///etc/passwd', 'x')).toBe(false)
    expect(store.listHistory().map((row) => row.url)).toEqual(['https://a.example/cb'])
  })

  it('limit: removes rows older than 90 days and those beyond 1,000 rows', () => {
    db.prepare('INSERT INTO web_history (url, title, visited_at) VALUES (?, ?, ?)').run(
      'https://old.example/',
      '',
      now - WEB_HISTORY_MAX_AGE_MS - 1
    )
    const insert = db.prepare('INSERT INTO web_history (url, title, visited_at) VALUES (?, ?, ?)')
    for (let i = 0; i < WEB_HISTORY_MAX_ROWS + 5; i++) insert.run(`https://h${i}.example/`, '', now - i)
    store.prune()
    const rows = store.listHistory()
    expect(rows).toHaveLength(WEB_HISTORY_MAX_ROWS)
    expect(rows.some((row) => row.url === 'https://old.example/')).toBe(false)
    expect(rows[0]?.url).toBe('https://h0.example/')
  })

  it('removes a single history row / all of it', () => {
    store.recordVisit('https://a.example/', '')
    store.recordVisit('https://b.example/', '')
    const id = store.listHistory()[0]?.id ?? -1
    expect(store.removeHistory(id)).toBe(true)
    expect(store.removeHistory('x')).toBe(false)
    expect(store.clearHistory()).toBe(1)
    expect(store.listHistory()).toEqual([])
  })

  it('Favorite: add (the same URL is one), remove, reorder, and fill only an empty title later', () => {
    expect(store.addFavorite('https://a.example/', 'A')).toBe(true)
    expect(store.addFavorite('https://a.example/', 'again')).toBe(false)
    store.addFavorite('https://b.example/', '')
    store.addFavorite('https://c.example/', 'C')
    expect(store.addFavorite('javascript:1', 'x')).toBe(false)
    expect(store.listFavorites().map((row) => row.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://c.example/'
    ])
    const c = store.listFavorites()[2]?.id ?? -1
    expect(store.moveFavorite(c, 0)).toBe(true)
    expect(store.listFavorites().map((row) => row.title)).toEqual(['C', 'A', ''])
    store.updateTitle('https://b.example/', 'B')
    store.updateTitle('https://a.example/', 'renamed')
    expect(store.listFavorites().map((row) => row.title)).toEqual(['C', 'A', 'B'])
    expect(store.removeFavorite('https://a.example/')).toBe(true)
    expect(store.removeFavorite(c)).toBe(true)
    expect(store.listFavorites().map((row) => row.url)).toEqual(['https://b.example/'])
  })

  // code-review fix (TODO 676): a way to put several additions, like a Chrome import, into one transaction.
  // It returns a bool for each item by the same rules as one-at-a-time `addFavorite` (duplicates, URLs that cannot be kept, the cap).
  it("addFavoritesBatch: adds together in one transaction and returns each item's result by the same rules as addFavorite", () => {
    store.addFavorite('https://existing.example/', 'Existing')
    const results = store.addFavoritesBatch([
      { url: 'https://existing.example/', title: 'dup' }, // Already there -> false
      { url: 'https://new-1.example/', title: 'New 1' },
      { url: 'javascript:1', title: 'bad' }, // A URL that cannot be kept -> false
      { url: 'https://new-2.example/', title: 'New 2' }
    ])
    expect(results).toEqual([false, true, false, true])
    expect(store.listFavorites().map((row) => row.url)).toEqual([
      'https://existing.example/',
      'https://new-1.example/',
      'https://new-2.example/'
    ])
  })

  it('addFavoritesBatch: an empty list does nothing', () => {
    expect(store.addFavoritesBatch([])).toEqual([])
    expect(store.listFavorites()).toEqual([])
  })

  // TODO 722: favicon is per host (web_favicons). Both the history and Favorite rows pick up the row of the same host.
  // code-review (722): the list's rows do not carry the favicon's data URL (only the host). The map is looked up separately with webFavicons().
  it('722: favicons are per host and can be looked up by host of both history and Favorite via the webFavicons() map', () => {
    store.recordVisit('https://a.example/x', 'A page')
    store.addFavorite('https://a.example/y', 'A fav')
    store.addFavorite('https://b.example/', 'B fav')
    expect(store.listHistory()[0]).toMatchObject({ host: 'a.example' })
    expect(store.listFavorites().map((f) => f.host)).toEqual(['a.example', 'b.example'])
    expect(store.webFavicons()).toEqual({})

    expect(store.setFaviconForHost('a.example', 'data:image/png;base64,AAA')).toBe(true)
    expect(store.webFavicons()).toEqual({ 'a.example': 'data:image/png;base64,AAA' })
    // The history and Favorite rows stay the same, only the host (the data URL is not carried over and over).
    expect(store.listHistory()[0]).toMatchObject({ host: 'a.example' })
    expect(store.listFavorites().map((f) => f.host)).toEqual(['a.example', 'b.example'])

    // With the same value it does not say 'changed' (so as not to decorate the broadcast).
    expect(store.setFaviconForHost('a.example', 'data:image/png;base64,AAA')).toBe(false)
    expect(store.setFaviconForHost('a.example', 'data:image/png;base64,BBB')).toBe(true)
    expect(store.webFavicons()).toEqual({ 'a.example': 'data:image/png;base64,BBB' })
  })

  it('722: hostsWithoutFavicon is only hosts without a favicon, in the order newly added', () => {
    store.addFavorite('https://a.example/', 'A')
    store.addFavorite('https://b.example/', 'B')
    store.setFaviconForHost('a.example', 'data:image/png;base64,AAA')
    expect(store.hostsWithoutFavicon(10)).toEqual(['b.example'])
    expect(store.hostsWithoutFavicon(0)).toEqual([])
  })

  // TODO 743: a host that failed is left out of the targets of hostsWithoutFavicon for 7 days. A real icon is not overwritten.
  it('743: markFaviconFailed remembers the failure time and excludes the host from hostsWithoutFavicon for 7 days', () => {
    store.addFavorite('https://failed.example/', 'F')
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
    store.markFaviconFailed('failed.example', now)
    expect(store.hostsWithoutFavicon(10, now)).toEqual([])
    expect(store.hostsWithoutFavicon(10, now + 1000)).toEqual([])
    // Exactly 7 days later (cutoff === failed_at) it returns to the targets; before that it is still left out.
    expect(store.hostsWithoutFavicon(10, now + SEVEN_DAYS - 1)).toEqual([])
    expect(store.hostsWithoutFavicon(10, now + SEVEN_DAYS)).toEqual(['failed.example'])
  })

  it('743: a failed row does not appear in the webFavicons() map (it has no icon)', () => {
    store.addFavorite('https://failed.example/', 'F')
    store.markFaviconFailed('failed.example', now)
    expect(store.webFavicons()).toEqual({})
  })

  it('743: even if a host with a real icon fails later, the icon is not removed (only failed_at advances)', () => {
    store.addFavorite('https://a.example/', 'A')
    store.setFaviconForHost('a.example', 'data:image/png;base64,AAA')
    store.markFaviconFailed('a.example', now)
    expect(store.webFavicons()).toEqual({ 'a.example': 'data:image/png;base64,AAA' })
    // A real icon exists = it is no longer a 'host without one', so it is left out of the targets regardless of cutoff.
    expect(store.hostsWithoutFavicon(10, now + 1000)).toEqual([])
  })

  it('743: a success after a failure clears failed_at, and the host is excluded from then on', () => {
    store.addFavorite('https://b.example/', 'B')
    store.markFaviconFailed('b.example', now)
    expect(store.setFaviconForHost('b.example', 'data:image/png;base64,BBB')).toBe(true)
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
    // Even at a time when it would return to the targets after 7 days, it stays left out because it has an icon.
    expect(store.hostsWithoutFavicon(10, now + SEVEN_DAYS + 1)).toEqual([])
  })

  // code-review (TODO 722): clearHistory / prune did not delete web_favicons, so even after clearing history, the visited hosts and their favicons remained without limit.
  // It deletes only the favicons of hosts that remain in neither Favorite nor history.
  it('code-review (722): clearHistory removes favicons of hosts that remain in neither history nor Favorite', () => {
    store.recordVisit('https://only-history.example/', 'H')
    store.addFavorite('https://both.example/fav', 'Both fav')
    store.recordVisit('https://both.example/hist', 'Both hist')
    store.setFaviconForHost('only-history.example', 'data:image/png;base64,AAA')
    store.setFaviconForHost('both.example', 'data:image/png;base64,BBB')
    const countFavicons = () => (db.prepare('SELECT COUNT(*) AS n FROM web_favicons').get() as { n: number }).n
    expect(countFavicons()).toBe(2)
    store.clearHistory()
    // only-history.example is gone from both history and Favorite -> it is deleted. both.example remains in Favorite -> it remains.
    expect(countFavicons()).toBe(1)
    expect(store.hostsWithoutFavicon(10)).toEqual([])
  })

  it('code-review (722): prune does the same cleanup (favicons of hosts removed by limit or age are also removed)', () => {
    db.prepare('INSERT INTO web_history (url, title, host, visited_at) VALUES (?, ?, ?, ?)').run(
      'https://old.example/',
      '',
      'old.example',
      now - WEB_HISTORY_MAX_AGE_MS - 1
    )
    store.setFaviconForHost('old.example', 'data:image/png;base64,AAA')
    const countFavicons = () => (db.prepare('SELECT COUNT(*) AS n FROM web_favicons').get() as { n: number }).n
    expect(countFavicons()).toBe(1)
    store.prune()
    expect(countFavicons()).toBe(0)
  })

  // TODO 740 (the 39th proxy verification): removeFavorite / removeHistory did not do the same cleanup either.
  // If history is removed first and then the last Favorite (or only one history row when there is no Favorite from the start), the favicon remained without limit,
  // referenced by neither table.
  it('TODO 740: removeFavorite also removes the favicon of a host whose last reference is gone', () => {
    store.recordVisit('https://only-fav.example/', 'F')
    store.addFavorite('https://only-fav.example/', 'F')
    store.setFaviconForHost('only-fav.example', 'data:image/png;base64,AAA')
    const countFavicons = () => (db.prepare('SELECT COUNT(*) AS n FROM web_favicons').get() as { n: number }).n
    expect(countFavicons()).toBe(1)
    store.clearHistory()
    expect(countFavicons()).toBe(1) // Favorite still refers to it
    const fav = store.listFavorites()[0]
    if (fav === undefined) throw new Error('fav missing')
    expect(store.removeFavorite(fav.id)).toBe(true)
    expect(countFavicons()).toBe(0)
  })

  it('TODO 740: removeHistory also removes the favicon of a host whose last reference is gone', () => {
    store.recordVisit('https://only-hist.example/', 'H')
    store.setFaviconForHost('only-hist.example', 'data:image/png;base64,AAA')
    const countFavicons = () => (db.prepare('SELECT COUNT(*) AS n FROM web_favicons').get() as { n: number }).n
    expect(countFavicons()).toBe(1)
    const hist = store.listHistory()[0]
    if (hist === undefined) throw new Error('hist missing')
    expect(store.removeHistory(hist.id)).toBe(true)
    expect(countFavicons()).toBe(0)
  })

  it('the app_settings keys (web.tabs / ui.webSections) round-trip', () => {
    const settings = new AppSettingsStore(db)
    expect(settings.readTyped(UI_WEB_SECTIONS)).toEqual(DEFAULT_WEB_SECTIONS)
    settings.writeTyped(UI_WEB_SECTIONS, { ...DEFAULT_WEB_SECTIONS, tabsHeight: 300 })
    expect(settings.readTyped(UI_WEB_SECTIONS).tabsHeight).toBe(300)
    expect(settings.readTyped(WEB_TABS)).toEqual([])
    const sets: StoredWebTabSet[] = [
      { owner: 'w', tabs: [{ url: 'https://a.example/', title: 'A' }], active: 0, updatedAt: 1, closedAt: null }
    ]
    settings.writeTyped(WEB_TABS, sets)
    expect(settings.readTyped(WEB_TABS)).toEqual(sets)
  })
})

describe('main/web/host: page notices (TODO 522)', () => {
  class Contents extends EventEmitter {
    url = ''
    loadURL(url: string): Promise<void> {
      this.url = url
      return Promise.resolve()
    }
    getURL(): string {
      return this.url
    }
    reload(): void {}
    stop(): void {}
    focus(): void {}
    isDestroyed(): boolean {
      return false
    }
    close(): void {}
    findInPage(): number {
      return 0
    }
    stopFindInPage(): void {}
    capturePage(): Promise<{ isEmpty(): boolean; toJPEG(q: number): Uint8Array }> {
      return Promise.resolve({ isEmpty: () => true, toJPEG: () => new Uint8Array() })
    }
    setWindowOpenHandler(): void {}
  }

  it('passes navigation (document / in-page), title, and favicon to deps', () => {
    const contents = new Contents()
    const seen: string[] = []
    const host = new WebViewHost({
      createView: () =>
        ({ webContents: contents, setBounds: () => {}, setVisible: () => {} }) as unknown as WebViewLike,
      removeView: () => {},
      openExternal: () => {},
      send: () => {},
      zoom: () => 1,
      contentSize: () => ({ width: 100, height: 100 }),
      onNavigated: (url, full) => seen.push(`nav:${url}:${full}`),
      onTitle: (title) => seen.push(`title:${title}`),
      onFavicon: (urls) => seen.push(`icon:${urls.join(',')}`)
    })
    host.load('https://a.example/')
    contents.emit('did-navigate', {}, 'https://a.example/')
    contents.emit('did-navigate-in-page', {}, 'https://a.example/#x', true)
    contents.emit('did-navigate-in-page', {}, 'https://frame.example/', false)
    contents.emit('page-title-updated', {}, 'Hello')
    contents.emit('page-favicon-updated', {}, ['https://a.example/favicon.ico', 42])
    expect(seen).toEqual([
      'nav:https://a.example/:true',
      'nav:https://a.example/#x:false',
      'title:Hello',
      'icon:https://a.example/favicon.ico'
    ])
  })

  // ---- TODO 530: keep the per-tab views alive, up to the most recent three ----
  interface FakeTabView {
    readonly webContents: Contents & { loads: string[]; closed: boolean; loading: boolean }
    visible: boolean
    bounds: unknown
    setBounds(bounds: unknown): void
    setVisible(visible: boolean): void
  }

  function multiSetup(extra: Partial<ConstructorParameters<typeof WebViewHost>[0]> = {}): {
    host: WebViewHost
    tabs: WebTabs
    views: FakeTabView[]
    removed: FakeTabView[]
    sent: string[]
    load: (url: string) => boolean
  } {
    const views: FakeTabView[] = []
    const removed: FakeTabView[] = []
    const sent: string[] = []
    const tabs = new WebTabs({ onChange: () => {} })
    const host = new WebViewHost({
      createView: () => {
        const contents = Object.assign(new Contents(), { loads: [] as string[], closed: false, loading: false })
        const loadURL = contents.loadURL.bind(contents)
        contents.loadURL = (url: string) => {
          contents.loads.push(url)
          return loadURL(url)
        }
        contents.close = () => {
          contents.closed = true
        }
        contents.isDestroyed = () => contents.closed
        ;(contents as unknown as { isLoading(): boolean }).isLoading = () => contents.loading
        const view: FakeTabView = {
          webContents: contents,
          visible: false,
          bounds: null,
          setBounds(bounds) {
            this.bounds = bounds
          },
          setVisible(visible) {
            this.visible = visible
          }
        }
        views.push(view)
        return view as unknown as WebViewLike
      },
      removeView: (view) => removed.push(view as unknown as FakeTabView),
      openExternal: () => {},
      send: (event) => sent.push(event.kind === 'loading' ? `loading:${event.loading}` : event.kind),
      zoom: () => 1,
      contentSize: () => ({ width: 1000, height: 800 }),
      onNavigated: (url, full, tabId) => tabs.navigated(url, full, tabId),
      onTitle: (title, tabId) => tabs.titled(title, tabId),
      onFailed: (url, tabId) => tabs.failed(url, tabId),
      ...extra
    })
    // The same as `web.load` in register.ts: first mirrors to the current tab, then reads in that tab's view.
    const load = (url: string): boolean => host.load(url, tabs.willLoad(url))
    return { host, tabs, views, removed, sent, load }
  }

  it('TODO 530: returning to a live tab shows it again without reloading (the previous view is hidden and kept alive)', async () => {
    const { host, tabs, views, sent } = multiSetup()
    host.setBounds({ x: 10, y: 20, width: 300, height: 400 })
    await host.setVisible(true, false)
    load('https://a.example/')
    const a = tabs.activeTab!.id
    tabs.open('https://b.example/')
    load('https://b.example/')
    expect(views).toHaveLength(2)
    expect(views[0]!.visible).toBe(false)
    expect(views[1]!.visible).toBe(true)

    // Back to A: no new view is made, and it is not re-read.
    tabs.activate(a)
    sent.length = 0
    views[0]!.webContents.loading = true
    expect(load('https://a.example/')).toBe(true)
    expect(views).toHaveLength(2)
    expect(views[0]!.webContents.loads).toEqual(['https://a.example/'])
    expect(views[0]!.visible).toBe(true)
    expect(views[0]!.bounds).toEqual({ x: 10, y: 20, width: 300, height: 400 })
    expect(views[1]!.visible).toBe(false)
    expect(sent).toEqual(['loading:true'])
    expect(host.liveTabs).toEqual([tabs.current.tabs[1]!.id, a])

    function load(url: string): boolean {
      return host.load(url, tabs.willLoad(url))
    }
  })

  it('code-review 2026-10-10 (547 × 530): a view that failed to load is reloaded even for the same URL (after trusting a certificate)', () => {
    const { tabs, views, load } = multiSetup()
    tabs.open('https://vm.example/')
    load('https://vm.example/')
    expect(views[0]!.webContents.loads).toEqual(['https://vm.example/'])
    // Failure of the main frame (-202) -> the error page remains, and getURL() returns the same URL.
    views[0]!.webContents.emit('did-fail-load', {}, -202, 'CERT', 'https://vm.example/', true)
    expect(load('https://vm.example/')).toBe(true)
    expect(views).toHaveLength(1)
    expect(views[0]!.webContents.loads).toEqual(['https://vm.example/', 'https://vm.example/'])
    // After it could be re-read, it returns to 'same URL means just swap the view'.
    expect(load('https://vm.example/')).toBe(true)
    expect(views[0]!.webContents.loads).toHaveLength(2)
  })

  it('TODO 599: "the same URL" is compared with the last URL sent (not the settled getURL())', () => {
    const { views, load } = multiSetup()
    load('https://a.example/')
    const contents = views[0]!.webContents
    // While reading B (A is what has been confirmed so far).
    contents.loadURL = (url: string) => {
      contents.loads.push(url)
      return Promise.resolve()
    }
    contents.url = 'https://a.example/'
    load('https://b.example/')
    expect(contents.loads).toEqual(['https://a.example/', 'https://b.example/'])
    // The same URL (B) while loading -> not re-read.
    load('https://b.example/')
    expect(contents.loads).toHaveLength(2)
    // A different URL (= the already confirmed A) while loading -> getURL() is A, but it is heading to B, so it is re-read.
    load('https://a.example/')
    expect(contents.loads).toEqual(['https://a.example/', 'https://b.example/', 'https://a.example/'])
  })

  it('TODO 599: navigation inside a page (link, redirect, in-page) also becomes the destination; a child frame redirect does not', () => {
    const { views, load } = multiSetup()
    load('https://a.example/')
    const contents = views[0]!.webContents
    // A link was pressed (will-navigate) before confirmation -> if the previous URL is asked for, re-read.
    contents.emit('will-navigate', { url: 'https://a.example/next', preventDefault: () => {} })
    load('https://a.example/')
    expect(contents.loads).toEqual(['https://a.example/', 'https://a.example/'])
    // The URL of a confirmed move and of an in-page move are 'the same'.
    contents.emit('did-navigate', {}, 'https://a.example/next')
    load('https://a.example/next')
    contents.emit('did-navigate-in-page', {}, 'https://a.example/next#h', true)
    load('https://a.example/next#h')
    expect(contents.loads).toHaveLength(2)
    // A redirect of a child frame does not change the destination.
    contents.emit('will-redirect', { url: 'https://ads.example/', isMainFrame: false, preventDefault: () => {} })
    load('https://a.example/next#h')
    expect(contents.loads).toHaveLength(2)
  })

  it('TODO 599 (code-review): after a navigation that does not settle (download, 204, ERR_ABORTED), does not reload on return', () => {
    const { views, load } = multiSetup()
    load('https://a.example/')
    const contents = views[0]!.webContents
    // A download link: will-navigate comes, but did-navigate does not, and loading stops.
    contents.emit('will-navigate', { url: 'https://a.example/file.zip', preventDefault: () => {} })
    contents.emit('did-stop-loading')
    load('https://a.example/')
    expect(contents.loads).toEqual(['https://a.example/'])
    // The destination of a redirect ended with ERR_ABORTED (main frame).
    contents.emit('will-navigate', { url: 'https://a.example/dl', preventDefault: () => {} })
    contents.emit('will-redirect', { url: 'https://cdn.example/x.bin', preventDefault: () => {} })
    contents.emit('did-fail-load', {}, -3, 'ABORTED', 'https://cdn.example/x.bin', true)
    load('https://a.example/')
    expect(contents.loads).toEqual(['https://a.example/'])
    // An ABORTED from a previous move does not erase the destination of the next move that overtook it (A is re-read, as it is heading to B before confirmation).
    contents.emit('will-navigate', { url: 'https://a.example/b', preventDefault: () => {} })
    contents.emit('did-fail-load', {}, -3, 'ABORTED', 'https://a.example/old', true)
    load('https://a.example/b')
    expect(contents.loads).toEqual(['https://a.example/'])
    load('https://a.example/')
    expect(contents.loads).toEqual(['https://a.example/', 'https://a.example/'])
  })

  it("TODO 601: the title of a tab that failed to load is the host name (does not keep the previous page's title); excludes ERR_ABORTED and child frames", () => {
    const { tabs, views, load } = multiSetup()
    tabs.open('https://a.example/')
    load('https://a.example/')
    const a = tabs.activeTab!.id
    views[0]!.webContents.emit('page-title-updated', {}, 'Page A')
    expect(tabs.tab(a)!.title).toBe('Page A')
    // Reads another URL in the same tab, and it failed (willLoad only replaces the URL; the title stays as before).
    load('https://down.example:8443/x')
    expect(tabs.tab(a)).toMatchObject({ url: 'https://down.example:8443/x', title: 'Page A' })
    views[0]!.webContents.emit('did-fail-load', {}, -3, 'ABORTED', 'https://down.example:8443/x', true)
    views[0]!.webContents.emit('did-fail-load', {}, -105, 'NAME', 'https://frame.example/', false)
    expect(tabs.tab(a)!.title).toBe('Page A')
    views[0]!.webContents.emit('did-fail-load', {}, -105, 'NAME', 'https://down.example:8443/x', true)
    expect(tabs.tab(a)!.title).toBe('down.example:8443')
    // A failure of a hidden view is also attached to that tab.
    tabs.open('https://b.example/')
    load('https://b.example/')
    views[0]!.webContents.emit('page-title-updated', {}, 'again')
    views[0]!.webContents.emit('did-fail-load', {}, -102, 'REFUSED', 'https://down.example:8443/x', true)
    expect(tabs.tab(a)!.title).toBe('down.example:8443')
    expect(tabs.activeTab!.title).toBe('')
  })

  it('TODO 530: at the 4th view, closes the least recently used view, and that tab is reloaded the next time it is shown', () => {
    const { host, tabs, views, removed, load } = multiSetup()
    const ids: string[] = []
    for (const name of ['a', 'b', 'c']) {
      tabs.open(`https://${name}.example/`)
      load(`https://${name}.example/`)
      ids.push(tabs.activeTab!.id)
    }
    // Reuses a -> the oldest is b.
    tabs.activate(ids[0])
    load('https://a.example/')
    tabs.open('https://d.example/')
    load('https://d.example/')
    expect(views).toHaveLength(4)
    expect(removed).toEqual([views[1]])
    expect(views[1]!.webContents.closed).toBe(true)
    expect(host.liveTabs).toHaveLength(3)
    expect(host.liveTabs).not.toContain(ids[1])
    // Going back to b re-reads it in a new view.
    tabs.activate(ids[1])
    load('https://b.example/')
    expect(views).toHaveLength(5)
    expect(views[4]!.webContents.loads).toEqual(['https://b.example/'])
  })

  it("TODO 530: a hidden view's navigation and title attach to its tab and not to the shown tab; not sent to the renderer", () => {
    const { tabs, views, sent, load } = multiSetup()
    tabs.open('https://a.example/')
    load('https://a.example/')
    const a = tabs.activeTab!.id
    tabs.open('https://b.example/')
    load('https://b.example/')
    const b = tabs.activeTab!.id
    sent.length = 0
    views[0]!.webContents.url = 'https://a.example/next'
    views[0]!.webContents.emit('did-navigate', {}, 'https://a.example/next')
    views[0]!.webContents.emit('page-title-updated', {}, 'A next')
    expect(tabs.tab(a)).toMatchObject({ url: 'https://a.example/next', title: 'A next' })
    expect(tabs.tab(b)).toMatchObject({ url: 'https://b.example/', title: '' })
    expect(sent).toEqual([])
    // Returning with the URL after the navigation of a hidden view (the renderer shows the label's URL) -> not re-read.
    tabs.activate(a)
    load('https://a.example/next')
    expect(views).toHaveLength(2)
    expect(views[0]!.webContents.loads).toEqual(['https://a.example/'])
  })

  it('TODO 530: a different URL in the same tab loads in the same view; closing the tab closes the view; close closes them all', () => {
    const { host, tabs, views, load } = multiSetup()
    tabs.open('https://a.example/')
    load('https://a.example/')
    const a = tabs.activeTab!.id
    load('https://a.example/other')
    expect(views).toHaveLength(1)
    expect(views[0]!.webContents.loads).toEqual(['https://a.example/', 'https://a.example/other'])
    tabs.open('https://b.example/')
    load('https://b.example/')
    tabs.close(a)
    host.dropTab(a)
    expect(views[0]!.webContents.closed).toBe(true)
    expect(host.liveTabs).toHaveLength(1)
    // A late notice from a closed view attaches to no tab.
    views[0]!.webContents.emit('page-title-updated', {}, 'ghost')
    expect(tabs.current.tabs.every((item) => item.title !== 'ghost')).toBe(true)
    host.close()
    expect(views[1]!.webContents.closed).toBe(true)
    expect(host.liveTabs).toEqual([])
    expect(host.hasView).toBe(false)
  })

  it("TODO 1326 review Y3: once the shown tab is closed, its view's late navigation reaches neither the renderer nor a tab", () => {
    const { host, tabs, views, sent, load } = multiSetup()
    tabs.open('https://a.example/')
    load('https://a.example/')
    const a = tabs.activeTab!.id
    tabs.open('https://b.example/')
    tabs.activate(a)
    load('https://a.example/')
    // While open, the shown view's navigation is sent (the control).
    sent.length = 0
    views[0]!.webContents.emit('did-navigate-in-page', {}, 'https://a.example/#top', true)
    expect(sent).toContain('navigated')
    sent.length = 0
    tabs.close(a)
    host.dropTab(a)
    expect(tabs.current.activeId).toBeNull()
    views[0]!.webContents.url = 'https://a.example/redirected'
    views[0]!.webContents.emit('did-navigate', {}, 'https://a.example/redirected')
    views[0]!.webContents.emit('did-navigate-in-page', {}, 'https://a.example/redirected#x', true)
    expect(sent).not.toContain('navigated')
    expect(tabs.current.tabs.map((item) => item.url)).toEqual(['https://b.example/'])
  })

  it('TODO 580: hide hides the view and keeps it alive, and returning does not reload; closes all after 10 minutes away; close is as before', () => {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    const { host, views, load, tabs } = multiSetup({
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: (handle) => {
        ;(handle as { cleared: boolean }).cleared = true
      }
    })
    void host.setVisible(true, false)
    tabs.open('https://a.example/')
    load('https://a.example/')
    tabs.open('https://b.example/')
    load('https://b.example/')
    const b = tabs.activeTab!.id
    expect(views[1]!.visible).toBe(true)

    // Switched to a file -> only the shown view is hidden; none is closed.
    host.hide()
    expect(views[1]!.visible).toBe(false)
    expect(views.every((view) => !view.webContents.closed)).toBe(true)
    expect(host.hidden).toBe(true)
    expect(host.hasView).toBe(false)
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(WEB_HIDDEN_VIEWS_TTL_MS)
    expect(WEB_HIDDEN_VIEWS_TTL_MS).toBe(10 * 60 * 1000)

    // Back to the Web pane (the new pane's setVisible(true) -> load) -> stops the clock and shows without re-reading.
    void host.setVisible(true, false)
    expect(timers[0]!.cleared).toBe(true)
    tabs.activate(b)
    load('https://b.example/')
    expect(views).toHaveLength(2)
    expect(views[1]!.webContents.loads).toEqual(['https://b.example/'])
    expect(views[1]!.visible).toBe(true)
    expect(host.hidden).toBe(false)

    // Hidden once more for 10 minutes -> everything is closed.
    host.hide()
    timers[1]!.fn()
    expect(views.every((view) => view.webContents.closed)).toBe(true)
    expect(host.liveTabs).toEqual([])
    expect(host.hidden).toBe(false)

    // ✕ (close) also stops the clock and closes everything.
    tabs.activate(b)
    load('https://b.example/')
    host.hide()
    host.close()
    expect(timers[2]!.cleared).toBe(true)
    expect(views[2]!.webContents.closed).toBe(true)

    // If there is no live view, the clock is not run.
    host.hide()
    expect(timers).toHaveLength(3)
  })

  it("TODO 530: when a hidden view's renderer crashes, discards it (reloads next time)", () => {
    const { host, tabs, views, sent, load } = multiSetup()
    tabs.open('https://a.example/')
    load('https://a.example/')
    const a = tabs.activeTab!.id
    tabs.open('https://b.example/')
    load('https://b.example/')
    sent.length = 0
    views[0]!.webContents.emit('render-process-gone')
    expect(sent).toEqual([])
    expect(host.liveTabs).not.toContain(a)
    tabs.activate(a)
    load('https://a.example/')
    expect(views).toHaveLength(3)
  })
})

describe('renderer/web-sections: heights of the three panes', () => {
  const total = 600
  const available = total - 3 * SECTION_HEADER_PX

  it('default: tabs have a fixed height at the bottom, and history and Favorite split the rest in half', () => {
    const heights = layoutWebSections(total, DEFAULT_WEB_SECTIONS)
    expect(heights.tabs).toBe(DEFAULT_WEB_SECTIONS.tabsHeight)
    expect(heights.history + heights.favorites + heights.tabs).toBe(available)
    expect(Math.abs(heights.history - heights.favorites)).toBeLessThanOrEqual(1)
  })

  it('a folded pane is 0 and the rest close up; folding the top two lets the tabs take everything', () => {
    const one = layoutWebSections(total, toggleWebSection(DEFAULT_WEB_SECTIONS, 'favorites'))
    expect(one.favorites).toBe(0)
    expect(one.history).toBe(available - one.tabs)
    const both = toggleWebSection(toggleWebSection(DEFAULT_WEB_SECTIONS, 'favorites'), 'history')
    expect(layoutWebSections(total, both)).toEqual({ history: 0, favorites: 0, tabs: available })
    expect(splitterActive('upper', both)).toBe(false)
    expect(splitterActive('lower', both)).toBe(false)
  })

  it('drag: the upper border is the history share, the lower border is the tab height; the minimum height is kept', () => {
    const start = layoutWebSections(total, DEFAULT_WEB_SECTIONS)
    const up = dragWebSections(DEFAULT_WEB_SECTIONS, start, 'upper', 40)
    expect(layoutWebSections(total, up).history).toBe(start.history + 40)
    const low = dragWebSections(DEFAULT_WEB_SECTIONS, start, 'lower', -50)
    expect(low.tabsHeight).toBe(start.tabs + 50)
    const huge = dragWebSections(DEFAULT_WEB_SECTIONS, start, 'lower', -10_000)
    expect(layoutWebSections(total, huge).history).toBeGreaterThanOrEqual(SECTION_MIN_PX)
    expect(dragWebSections(DEFAULT_WEB_SECTIONS, start, 'upper', Number.NaN)).toBe(DEFAULT_WEB_SECTIONS)
  })

  it('destination of a Favorite drop', () => {
    expect(favoriteDropIndex(0, 2, 3)).toBe(2)
    expect(favoriteDropIndex(2, 2, 3)).toBeNull()
    expect(favoriteDropIndex(1, 9, 3)).toBe(2)
    expect(favoriteDropIndex(-1, 0, 3)).toBeNull()
  })
})
