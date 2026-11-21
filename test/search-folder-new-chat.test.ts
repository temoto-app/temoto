// @vitest-environment jsdom
/**
 * TODO 820 (wave 39 bundle B): on a folder hit in file-name search (the two-level row of folder name + `~/…`), place "new thread in this folder", shown at the right end on row hover. Pressing it creates the thread at once, without a dialog.
 * Not placed on file hits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SearchHit } from '../src/shared/search.js'

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

function hit(id: string, kind: 'file' | 'directory'): SearchHit {
  return {
    id,
    uri: `file:///w/${id}`,
    title: id,
    source: 'fs',
    kind,
    updatedAt: 0,
    score: 0,
    snippet: '',
    threadId: null,
    eventId: null,
    context: '',
    contextCode: null
  }
}

let reactRoot: Root
let host: HTMLDivElement
const create = vi.fn(async () => true)

beforeEach(async () => {
  create.mockClear()
  ;(window as unknown as { aios: unknown }).aios = {
    // TODO 896: SearchMode takes the list so that it can show the plugin's search section (there is no section here).
    plugins: { list: async () => [], onChanged: () => () => undefined },
    editor: { reveal: vi.fn() },
    app: { onMenuCommand: () => () => undefined },
    search: { query: vi.fn(async () => ({ hits: [], total: 0, truncated: false, tookMs: 0 })), buildScope: vi.fn() },
    fs: {
      searchFiles: vi.fn(async () => ({
        entries: [],
        total: 0,
        truncated: false,
        scanTruncated: false,
        cwd: null,
        cancelled: false,
        tookMs: 0
      }))
    }
  }
  window.focus = () => undefined
  const { useSearch } = await import('../src/renderer/src/searchStore.js')
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  useSearch.setState({
    range: null,
    fileQuery: '',
    nameQuery: 'x',
    fileHits: [],
    nameHits: [hit('proj', 'directory'), hit('a.ts', 'file')],
    nameCwd: null,
    conversationHits: []
  })
  useThreads.setState({ mode: 'search', createThreadInFolder: create })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
})

describe('「新しいスレッド」 on a folder hit (TODO 820)', () => {
  it('shown only on a folder row, and pressing it creates one in that folder immediately', async () => {
    const { SearchMode } = await import('../src/renderer/src/components/SearchMode.js')
    act(() => reactRoot.render(createElement(SearchMode)))
    const rows = [...host.querySelectorAll<HTMLElement>('.search-hit')]
    const dir = rows.find((r) => r.querySelector('.search-hit-name')?.textContent === 'proj')
    const file = rows.find((r) => r.querySelector('.search-hit-name')?.textContent === 'a.ts')
    expect(file?.querySelector('.search-hit-new-chat')).toBeNull()
    const button = dir?.querySelector<HTMLButtonElement>('button.search-hit-new-chat')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('New thread in proj')
    await act(async () => {
      button?.click()
    })
    expect(create).toHaveBeenCalledWith('file:///w/proj')
  })
})

describe('keeps the search term across a remount (TODO 809)', () => {
  it("seeds the input from the store's search term (starts from empty and does not empty the store on debounce)", async () => {
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    useSearch.setState({ fileQuery: 'needle', conversationQuery: 'hello', nameHits: [] })
    const { SearchMode } = await import('../src/renderer/src/components/SearchMode.js')
    act(() => reactRoot.render(createElement(SearchMode)))
    const values = [...host.querySelectorAll<HTMLInputElement>('input')].map((el) => el.value)
    expect(values).toContain('needle')
    expect(values).toContain('hello')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(useSearch.getState().fileQuery).toBe('needle')
    expect(useSearch.getState().conversationQuery).toBe('hello')
  })
})
