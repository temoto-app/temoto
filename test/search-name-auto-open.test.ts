// @vitest-environment jsdom
/**
 * TODO 1244: ⌘P file-name search shows the first result in the viewer once the results settle (300 ms).
 * It does not replace when there is a draft or when there are 0 results. The same first result is not reopened.
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

function hit(id: string, kind: 'file' | 'directory' = 'file'): SearchHit {
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
const select = vi.fn()

beforeEach(async () => {
  vi.useFakeTimers()
  select.mockClear()
  ;(window as unknown as { aios: unknown }).aios = {
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
  const { useStore } = await import('../src/renderer/src/store.js')
  useSearch.setState({
    range: null,
    fileQuery: '',
    nameQuery: 'x',
    fileHits: [],
    nameHits: [hit('a.ts'), hit('b.ts')],
    nameCwd: null,
    conversationHits: []
  })
  useThreads.setState({ mode: 'search' })
  useStore.setState({ select, selectedUri: null, viewerDirty: false })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
  vi.useRealTimers()
})

async function mount(touch = true): Promise<void> {
  const { SearchMode } = await import('../src/renderer/src/components/SearchMode.js')
  act(() => reactRoot.render(createElement(SearchMode)))
  // The user moved the name field (the ⌘P seed is treated the same). Merely mounting does not open it.
  if (touch) {
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    act(() => useSearch.getState().requestFocus('names', 'x'))
  }
}

describe('ファイル名検索の先頭を自動で開く (TODO 1244)', () => {
  it('300 ms 待ってから先頭を開く (それまでは開かない)', async () => {
    await mount()
    act(() => void vi.advanceTimersByTime(200))
    expect(select).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(150))
    expect(select).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledWith('file:///w/a.ts')
  })

  it('先頭が替わったら新しい先頭を開く', async () => {
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    await mount()
    act(() => void vi.advanceTimersByTime(400))
    act(() => useSearch.setState({ nameHits: [hit('c.ts')] }))
    act(() => void vi.advanceTimersByTime(400))
    expect(select).toHaveBeenLastCalledWith('file:///w/c.ts')
  })

  it('未保存の下書きがあるときは替えない', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    useStore.setState({ viewerDirty: true })
    await mount()
    act(() => void vi.advanceTimersByTime(400))
    expect(select).not.toHaveBeenCalled()
  })

  it('同じ先頭が既に開いていれば開き直さない', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    useStore.setState({ selectedUri: 'file:///w/a.ts' })
    await mount()
    act(() => void vi.advanceTimersByTime(400))
    expect(select).not.toHaveBeenCalled()
  })

  it('0 件のときと、先頭がフォルダのときは開かない', async () => {
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    useSearch.setState({ nameHits: [] })
    await mount()
    act(() => void vi.advanceTimersByTime(400))
    expect(select).not.toHaveBeenCalled()
    act(() => useSearch.setState({ nameHits: [hit('dir', 'directory'), hit('a.ts')] }))
    act(() => void vi.advanceTimersByTime(400))
    expect(select).not.toHaveBeenCalled()
  })

  it('mount しただけ (前回の結果が store に残っている) では開かない', async () => {
    await mount(false)
    act(() => void vi.advanceTimersByTime(400))
    expect(select).not.toHaveBeenCalled()
  })

  it('一時表示 (diff など) が出ているときは替えない', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    useStore.setState({ transient: { kind: 'help', uri: 'x', nonce: 1 } as never })
    await mount()
    act(() => void vi.advanceTimersByTime(400))
    expect(select).not.toHaveBeenCalled()
  })

  it('web タブが出ているときは替えない', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    useStore.setState({ selectedUri: 'https://example.com/' })
    await mount()
    act(() => void vi.advanceTimersByTime(400))
    expect(select).not.toHaveBeenCalled()
  })

  it('会話検索の語で名前欄が灰色の間は開かない', async () => {
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    useSearch.setState({ conversationQuery: 'abc' })
    await mount()
    act(() => void vi.advanceTimersByTime(400))
    expect(select).not.toHaveBeenCalled()
    useSearch.setState({ conversationQuery: '' })
  })
})
