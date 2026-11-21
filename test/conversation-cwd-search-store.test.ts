// @vitest-environment jsdom
/**
 * TODO 1096 (wave 66 bundle A): the renderer side (jsdom) of the "this working folder" section of conversation search (⌘K).
 *
 * - `setConversationQuery` is sent with the cwd of the active thread, and keeps the `cwd` of the response as `conversationCwd`
 * - When the cwd changes (`refreshForCwd`), the conversation search that was typed is run again. With the same cwd it is not run again. It is remembered separately from the File side
 * - A response for an old cwd (a response with an earlier number that arrives late) is discarded
 * - Screen: under the conversation heading, the subheadings "this working folder" -> "all". If the cwd section has 0 results, one line "no conversations found"
 *
 * The virtual list is replaced with a fake that draws every row. Neither the model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SearchHit, SearchResponse } from '../src/shared/search.js'
import type { ThreadSummary } from '../src/shared/thread.js'

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

const APP = 'file:///w/app'
const OTHER = 'file:///w/other'

function hit(id: string): SearchHit {
  return {
    id,
    uri: `thread://t-${id}/${id}`,
    title: id,
    source: 'conversation',
    kind: 'message',
    updatedAt: 0,
    score: 0,
    snippet: `snippet ${id}`,
    threadId: `t-${id}`,
    eventId: id,
    context: 'user',
    contextCode: 'user'
  }
}

type Pending = { resolve: (value: SearchResponse) => void; args: unknown[] }

let reactRoot: Root
let host: HTMLDivElement
let query: ReturnType<typeof vi.fn>
let pending: Pending[]

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

async function activate(cwdUri: string): Promise<void> {
  const { useThreads } = await stores()
  const id = `thread-${cwdUri}`
  act(() =>
    useThreads.setState({
      activeThreadId: id,
      threadsById: { [id]: { thread: { id, cwdUri }, preview: null } as unknown as ThreadSummary }
    })
  )
}

beforeEach(async () => {
  pending = []
  query = vi.fn(
    (...args: unknown[]) =>
      new Promise<SearchResponse>((resolve) => {
        pending.push({ resolve, args })
      })
  )
  ;(window as unknown as { aios: unknown }).aios = {
    plugins: { list: async () => [], onChanged: () => () => undefined },
    editor: { reveal: vi.fn() },
    app: { onMenuCommand: () => () => undefined },
    search: { query, buildScope: vi.fn() },
    fs: { searchFiles: vi.fn() }
  }
  const { useSearch } = await stores()
  useSearch.setState({
    range: null,
    fileQuery: '',
    nameQuery: '',
    conversationQuery: '',
    fileHits: [],
    nameHits: [],
    fileCwd: null,
    nameCwd: null,
    conversationHits: [],
    conversationCwd: null,
    searching: false
  })
  await activate(APP)
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
})

function answer(index: number, response: Partial<SearchResponse>): Promise<void> {
  const call = pending[index]
  if (call === undefined) throw new Error(`no call ${index}`)
  return act(async () => {
    call.resolve({ hits: [], total: 0, truncated: false, tookMs: 0, ...response })
  })
}

describe('searchStore の会話の区画 (TODO 1096)', () => {
  it('アクティブなスレッドの cwd を添えて引き、応答の区画を持つ', async () => {
    const { useSearch } = await stores()
    act(() => useSearch.getState().setConversationQuery('needle'))
    expect(query.mock.calls[0]?.[1]).toBe('conversation')
    expect(query.mock.calls[0]?.[4]).toBe(APP)
    await answer(0, { hits: [hit('g1')], cwd: { uri: APP, hits: [hit('c1')], total: 1, truncated: false } })
    expect(useSearch.getState().conversationHits.map((h) => h.id)).toEqual(['g1'])
    expect(useSearch.getState().conversationCwd?.hits.map((h) => h.id)).toEqual(['c1'])
    // Clearing the word also clears the section.
    act(() => useSearch.getState().setConversationQuery(''))
    expect(useSearch.getState().conversationCwd).toBeNull()
  })

  it('cwd が変わったら入力済みの会話検索を引き直し、古い cwd の応答は捨てる', async () => {
    const { useSearch } = await stores()
    act(() => useSearch.getState().setConversationQuery('needle'))
    // With the same cwd, it is not run again.
    act(() => useSearch.getState().refreshForCwd())
    expect(query).toHaveBeenCalledTimes(1)

    await activate(OTHER)
    act(() => useSearch.getState().refreshForCwd())
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]?.[4]).toBe(OTHER)

    // If the response for the new cwd arrives first and the response for the old cwd arrives later, it does not overwrite (checked by number even for the same query).
    await answer(1, { hits: [hit('g2')], cwd: { uri: OTHER, hits: [hit('c2')], total: 1, truncated: false } })
    await answer(0, { hits: [hit('g1')], cwd: { uri: APP, hits: [hit('c1')], total: 1, truncated: false } })
    expect(useSearch.getState().conversationCwd?.uri).toBe(OTHER)
    expect(useSearch.getState().conversationCwd?.hits.map((h) => h.id)).toEqual(['c2'])
    expect(useSearch.getState().conversationHits.map((h) => h.id)).toEqual(['g2'])
  })

  it('File の側だけ引いた後に cwd が変わっても会話は引かない (覚える cwd は別)', async () => {
    const { useSearch } = await stores()
    act(() => useSearch.getState().setFileQuery('needle'))
    await activate(OTHER)
    act(() => useSearch.getState().refreshForCwd())
    expect(query.mock.calls.map((call) => call[1])).toEqual(['files', 'files'])
  })

  it('スレッドが無い (cwd 無し) なら null を渡し、区画は持たない', async () => {
    const { useSearch, useThreads } = await stores()
    act(() => useThreads.setState({ activeThreadId: null }))
    act(() => useSearch.getState().setConversationQuery('needle'))
    expect(query.mock.calls[0]?.[4]).toBeNull()
    await answer(0, { hits: [hit('g1')] })
    expect(useSearch.getState().conversationCwd).toBeNull()
  })
})

describe('Search 画面の会話の 2 区画 (TODO 1096)', () => {
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

  function regions(): string[] {
    return [...host.querySelectorAll('.search-region')].map(
      (el) => `${el.querySelector('.search-region-label')?.textContent}|${el.querySelector('.search-region-path')?.textContent ?? ''}`
    )
  }

  it('「この作業フォルダ」→「全域」の順に出す', async () => {
    const { useSearch } = await stores()
    act(() =>
      useSearch.setState({
        conversationHits: [hit('g1'), hit('g2')],
        conversationCwd: { uri: APP, hits: [hit('c1')], total: 1, truncated: false }
      })
    )
    await renderSearch()
    expect(regions()).toEqual(['This folder|/w/app/', 'Everywhere|'])
    const text = host.textContent ?? ''
    expect(text.indexOf('snippet c1')).toBeGreaterThan(-1)
    expect(text.indexOf('snippet c1')).toBeLessThan(text.indexOf('snippet g1'))
  })

  it('cwd の区画が 0 件なら小見出しと「会話には見つかりませんでした」の 1 行 (項目 292)', async () => {
    const { useSearch } = await stores()
    act(() =>
      useSearch.setState({
        conversationHits: [hit('g1')],
        conversationCwd: { uri: APP, hits: [], total: 0, truncated: false }
      })
    )
    await renderSearch()
    expect(regions()).toEqual(['This folder|/w/app/', 'Everywhere|'])
    expect(host.querySelector('.search-region-note-text')?.textContent).toBe(
      'Nothing found in conversations in /w/app/ — showing other conversations'
    )
  })

  it('cwd の区画が無ければ全域の小見出しだけ', async () => {
    const { useSearch } = await stores()
    act(() => useSearch.setState({ conversationHits: [hit('g1')], conversationCwd: null }))
    await renderSearch()
    expect(regions()).toEqual(['Everywhere|'])
  })
})
