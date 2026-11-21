// @vitest-environment jsdom
/**
 * TODO 437 (wave 22 bundle E): "search in this folder" from a folder in the Files tree (jsdom).
 *
 * - Two entry points: the 🔎 on hover of the tree's folder row, and "Find in Folder…" in the right-click menu.
 *   **Both go through the same path** (`openSearchInFolder` → `searchStore.setRange` + switch to Search).
 * - Once the range is set, it asks for `search.buildScope` (subtree build, item 249) and puts the range on the body / file-name search.
 * - If the choke point in main refuses, the range is removed (no badge is shown). If the index is merely busy, the range remains.
 * - The ✕ on the badge returns to the whole area (re-queries without the range). When a range is set, the results are one section (the subheading is "Scope" + path).
 *
 * The virtual list is replaced with a fake that draws every row. Uses neither the model nor Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileEntry } from '../src/shared/types.js'
import type { ScopeBuildResult, SearchHit } from '../src/shared/search.js'
import { formatReason } from '../src/shared/reason.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => ({
    getTotalSize: () => options.count * 24,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        start: index * 24,
        size: options.estimateSize(index),
        key: index
      })),
    scrollToIndex: () => undefined
  })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = 'file:///w'
function entry(uri: string, isDirectory: boolean, parentUri: string | null): FileEntry {
  const name = uri.slice(uri.lastIndexOf('/') + 1)
  return { uri, parentUri, name, isDirectory, size: 0, mtimeMs: 0, ext: '' }
}
const root = entry(ROOT, true, null)
const dirA = entry(`${ROOT}/a`, true, ROOT)
const fileB = entry(`${ROOT}/b.ts`, false, ROOT)

function hit(id: string, extra: Partial<SearchHit> = {}): SearchHit {
  return {
    id,
    uri: `${ROOT}/a/${id}`,
    title: id,
    source: 'fs',
    kind: 'file',
    updatedAt: 0,
    score: 0,
    snippet: '',
    threadId: null,
    eventId: null,
    context: '',
    contextCode: null,
    ...extra
  }
}

let reactRoot: Root
let host: HTMLDivElement
let buildScope: ReturnType<typeof vi.fn>
let query: ReturnType<typeof vi.fn>
let searchFiles: ReturnType<typeof vi.fn>
let buildAnswer: () => Promise<ScopeBuildResult>

async function stores(): Promise<{
  useSearch: typeof import('../src/renderer/src/searchStore.js').useSearch
  useStore: typeof import('../src/renderer/src/store.js').useStore
  useThreads: typeof import('../src/renderer/src/threadStore.js').useThreads
}> {
  const { useSearch } = await import('../src/renderer/src/searchStore.js')
  const { useStore } = await import('../src/renderer/src/store.js')
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  return { useSearch, useStore, useThreads }
}

beforeEach(async () => {
  buildAnswer = async () => ({ built: 3, pending: 0, pendingCapped: false })
  buildScope = vi.fn(() => buildAnswer())
  query = vi.fn(async () => ({ hits: [], total: 0, truncated: false, tookMs: 0 }))
  searchFiles = vi.fn(async () => ({
    entries: [],
    total: 0,
    truncated: false,
    scanTruncated: false,
    cwd: null,
    cancelled: false,
    tookMs: 0
  }))
  ;(window as unknown as { aios: unknown }).aios = {
    // TODO 896: SearchMode takes the list so that it can show the plugin's search section (there is no section here).
    plugins: { list: async () => [], onChanged: () => () => undefined },
    editor: { reveal: vi.fn() },
    app: { onMenuCommand: () => () => undefined },
    search: { buildScope, query },
    fs: { searchFiles }
  }
  // `window.focus()`, called by `openSearch`, does not exist in jsdom (it only needs to be callable).
  window.focus = () => undefined
  const { useSearch, useStore, useThreads } = await stores()
  useSearch.setState({
    range: null,
    fileQuery: '',
    nameQuery: '',
    // TODO 1199: if a conversation search word from a previous test remains, the body search field goes gray.
    conversationQuery: '',
    fileHits: [],
    nameHits: [],
    fileCwd: null,
    nameCwd: null,
    conversationHits: []
  })
  useStore.setState({
    roots: [root],
    children: { [ROOT]: [dirA, fileB] },
    expanded: new Set([ROOT]),
    loading: new Set(),
    results: null,
    selectedUri: null,
    revealedUri: null,
    revealTick: 0,
    revealTarget: null,
    setQuery: () => undefined
  })
  useThreads.setState({ mode: 'files', sidebarCollapsed: false })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
  for (const menu of document.querySelectorAll('.context-menu')) menu.remove()
})

async function renderFileMode(): Promise<void> {
  const { FileMode } = await import('../src/renderer/src/components/Sidebar.js')
  act(() => reactRoot.render(createElement(FileMode)))
}

function treeRow(name: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
    (el) => el.querySelector('.row-name')?.textContent === name
  )
  if (row === undefined) throw new Error(`no row ${name}`)
  return row
}

describe('tree entry point (TODO 437)', () => {
  it('the magnifier shows only on folder rows. Pressing sets the scope, switches to Search, and requests a subtree build', async () => {
    await renderFileMode()
    expect(treeRow('b.ts').querySelector('[aria-label="Find in Folder…"]')).toBeNull()
    const button = treeRow('a').querySelector<HTMLButtonElement>('[aria-label="Find in Folder…"]')
    expect(button).not.toBeNull()
    await act(async () => {
      button?.click()
    })
    const { useSearch, useThreads } = await stores()
    expect(useSearch.getState().range?.uri).toBe(`${ROOT}/a`)
    expect(useThreads.getState().mode).toBe('search')
    expect(buildScope).toHaveBeenCalledWith(`${ROOT}/a`)
    // Does not bubble on a row click (open/close).
    expect(useSearch.getState().focusRequest?.target).toBe('files')
  })

  it("the context menu's 「Find in Folder…」 takes the same path (not shown on file rows)", async () => {
    await renderFileMode()
    await act(async () => {
      treeRow('b.ts').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      )
    })
    let labels = [...document.querySelectorAll('.context-menu-item')].map((el) => el.textContent)
    expect(labels).not.toContain('Find in Folder…')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      treeRow('a').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      )
    })
    const items = [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')]
    labels = items.map((el) => el.textContent)
    expect(labels).toContain('Find in Folder…')
    await act(async () => {
      items.find((el) => el.textContent === 'Find in Folder…')?.click()
    })
    const { useSearch, useThreads } = await stores()
    expect(useSearch.getState().range?.uri).toBe(`${ROOT}/a`)
    expect(useThreads.getState().mode).toBe('search')
    expect(buildScope).toHaveBeenCalledWith(`${ROOT}/a`)
  })
})

describe('searchStore scope (TODO 437)', () => {
  it('re-runs the already-entered body / file name search with the scope. Does not apply it to conversation search', async () => {
    const { useSearch } = await stores()
    act(() => useSearch.setState({ fileQuery: 'needle', nameQuery: 'nee', conversationQuery: 'x' }))
    await act(async () => useSearch.getState().setRange(`${ROOT}/a`))
    const fileCall = query.mock.calls.find((call) => call[1] === 'files')
    expect(fileCall?.[5]).toBe(`${ROOT}/a`)
    expect(searchFiles.mock.calls.at(-1)?.[3]).toBe(`${ROOT}/a`)
    expect(query.mock.calls.some((call) => call[1] === 'conversation')).toBe(false)
    // Once the build is done it has the remaining count, and re-queries body search so that the built part appears.
    expect(useSearch.getState().range).toEqual({
      uri: `${ROOT}/a`,
      building: false,
      pending: { built: 3, pending: 0, pendingCapped: false }
    })
    expect(query.mock.calls.filter((call) => call[1] === 'files')).toHaveLength(2)
  })

  it('the x (clearRange) removes the scope and re-runs without it', async () => {
    const { useSearch } = await stores()
    act(() => useSearch.setState({ fileQuery: 'needle' }))
    await act(async () => useSearch.getState().setRange(`${ROOT}/a`))
    query.mockClear()
    await act(async () => useSearch.getState().clearRange())
    expect(useSearch.getState().range).toBeNull()
    expect(query.mock.calls[0]?.[5]).toBeNull()
  })

  it('removes the scope when the main choke point refuses it (shows no badge)', async () => {
    buildAnswer = async () => {
      throw new Error(formatReason('path-excluded'))
    }
    const { useSearch } = await stores()
    await act(async () => useSearch.getState().setRange(`${ROOT}/a`))
    expect(useSearch.getState().range).toBeNull()
  })

  it('keeps the scope when the index is merely busy', async () => {
    buildAnswer = async () => {
      throw new Error(formatReason('index-busy'))
    }
    const { useSearch } = await stores()
    await act(async () => useSearch.getState().setRange(`${ROOT}/a`))
    expect(useSearch.getState().range).toEqual({ uri: `${ROOT}/a`, building: false, pending: null })
  })
})

describe('Search screen badge and one section (TODO 437)', () => {
  async function renderSearch(): Promise<void> {
    const { useSearch, useStore } = await stores()
    act(() => {
      useStore.setState({ appInfo: { homeUri: 'file:///home' } as never })
      useSearch.setState({
        setFileQuery: () => undefined,
        setNameQuery: () => undefined,
        setConversationQuery: () => undefined,
        refreshForCwd: () => undefined
      })
    })
    const { SearchMode } = await import('../src/renderer/src/components/SearchMode.js')
    act(() => reactRoot.render(createElement(SearchMode)))
  }

  it('with a scope it shows the badge 「Scope: パス ✕」 and the unindexed count, and the results form one section (subheading is Scope + path)', async () => {
    const { useSearch } = await stores()
    act(() =>
      useSearch.setState({
        range: { uri: `${ROOT}/a`, building: false, pending: { built: 0, pending: 12, pendingCapped: false } },
        fileHits: [hit('f1')],
        nameHits: [hit('n1')],
        nameOutcome: { total: 1, truncated: false, scanTruncated: false }
      })
    )
    await renderSearch()
    const badge = host.querySelector('.search-range')
    expect(badge?.querySelector('.search-range-label')?.textContent).toBe('Scope:')
    expect(badge?.querySelector('.search-range-path')?.textContent).toBe('/w/a/')
    expect(badge?.querySelector('.search-range-note')?.textContent).toBe('12 files in this folder not indexed yet')
    const regions = [...host.querySelectorAll('.search-region')].map(
      (el) => `${el.querySelector('.search-region-label')?.textContent}|${el.querySelector('.search-region-path')?.textContent}`
    )
    expect(regions).toEqual(['Scope|/w/a/', 'Scope|/w/a/'])
    // The ✕ on the badge returns to the whole area.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.search-range-clear')?.click()
    })
    expect(useSearch.getState().range).toBeNull()
    expect(host.querySelector('.search-range')).toBeNull()
  })

  it('without a scope no badge is shown', async () => {
    await renderSearch()
    expect(host.querySelector('.search-range')).toBeNull()
  })

  it('code-review (630): the focusRequest seed is consumed once used and does not revert to an old term on reopen', async () => {
    const { useSearch } = await stores()
    act(() => useSearch.getState().requestFocus('files', 'hello'))
    await renderSearch()
    const input = (): HTMLInputElement | null => host.querySelector<HTMLInputElement>('input')
    expect(input()?.value).toBe('hello')
    expect(useSearch.getState().focusRequest?.seed).toBeUndefined()
    // After the user retypes, the panel is closed and reopened.
    act(() => reactRoot.unmount())
    reactRoot = createRoot(host)
    await renderSearch()
    expect(input()?.value).not.toBe('hello')
  })
})
