// @vitest-environment jsdom
/**
 * TODO 896 (ARCHITECTURE 7.5.1): the plugin's section appears in the search sidebar, and it is queried on Enter or after 500 ms of stillness, and the results are opened (jsdom).
 *
 * A fake `window.aios.plugins` returns "one bundled enabled plugin (with a searchProvider)". Neither plugin-host nor a model is used.
 * The virtual list is replaced with a fake that renders every row (as in `search-keys.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SearchHit } from '../src/shared/search.js'
import type { PluginSummary } from '../src/shared/plugin.js'
import type { PluginSearchResponse } from '../src/shared/plugin-search.js'
import { PLUGIN_SEARCH_DEBOUNCE_MS } from '../src/shared/plugin-search.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => ({
    getTotalSize: () => options.count * 40,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({ index, start: index * 40, size: options.estimateSize(index), key: index })),
    scrollToIndex: () => undefined,
    measureElement: () => undefined
  })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROVIDER: PluginSummary = {
  id: 'test.docs',
  name: 'Docs',
  displayName: 'Docs',
  description: null,
  publisher: null,
  iconUrl: null,
  version: '1',
  activityBar: null,
  searchProvider: { title: 'Docs', openWith: 'external' },
  bundled: true,
  required: false,
  enabled: true,
  capabilities: [],
  consented: [],
  hasViewer: false,
  host: 'stopped',
  crashes: 0,
  update: { state: 'up-to-date', latest: '1.0.0' }
} as PluginSummary

let reactRoot: Root
let host: HTMLDivElement
let search: ReturnType<typeof vi.fn>
let openExternal: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.useFakeTimers()
  search = vi.fn(
    async (pluginId: string, query: string): Promise<PluginSearchResponse> => ({
      pluginId,
      query,
      results: [{ id: 'd1', title: `${query} report`, snippet: 'numbers', description: 'Alice', open: 'https://docs.example.com/d1' }],
      error: null,
      dropped: 0
    })
  )
  openExternal = vi.fn(async () => true)
  ;(window as unknown as { aios: unknown }).aios = {
    editor: { reveal: vi.fn() },
    app: { openExternal },
    plugins: { list: async () => [PROVIDER], onChanged: () => () => undefined, search }
  }
  const { useSearch } = await import('../src/renderer/src/searchStore.js')
  const { usePluginSearch } = await import('../src/renderer/src/pluginSearch.js')
  usePluginSearch.setState({ byPlugin: {} })
  useSearch.setState({
    focusRequest: null,
    setFileQuery: () => undefined,
    setNameQuery: () => undefined,
    setConversationQuery: () => undefined,
    refreshForCwd: () => undefined
  })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
  const { SearchMode } = await import('../src/renderer/src/components/SearchMode.js')
  await act(async () => {
    reactRoot.render(createElement(SearchMode))
    await vi.advanceTimersByTimeAsync(0)
  })
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
  vi.useRealTimers()
})

function pluginInput(): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>('input[data-plugin-search="test.docs"]')
  if (el === null) throw new Error('no plugin input')
  return el
}

function type(el: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('plugin section of the search sidebar (TODO 896)', () => {
  it('the section field appears, typing alone does not query, it queries after 500 ms of no typing and shows results; clicking opens with openWith', async () => {
    const input = pluginInput()
    expect(input.placeholder).toContain('Docs')
    type(input, 'q3')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLUGIN_SEARCH_DEBOUNCE_MS - 1)
    })
    expect(search).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(search).toHaveBeenCalledWith('test.docs', 'q3')
    const row = [...host.querySelectorAll<HTMLElement>('.search-hit')].find((el) => el.textContent?.includes('q3 report'))
    expect(row).toBeDefined()
    expect(row?.textContent).toContain('Alice')
    expect(row?.textContent).toContain('numbers')
    expect(host.textContent).toContain('Docs (1)')
    act(() => row?.click())
    expect(openExternal).toHaveBeenCalledWith('https://docs.example.com/d1')
  })

  it('Enter queries without waiting for 500 ms, and when results are shown the next Enter opens the highlighted row', async () => {
    const input = pluginInput()
    act(() => input.focus())
    type(input, 'budget')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('test.docs', 'budget')
    // After it stops, the debounce does not query the same word again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLUGIN_SEARCH_DEBOUNCE_MS)
    })
    expect(search).toHaveBeenCalledTimes(1)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(openExternal).toHaveBeenCalledWith('https://docs.example.com/d1')
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('typing in the plugin field and responses arriving do not reset the up/down cursor of the local results (review fix)', async () => {
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    const mk = (id: string): SearchHit => ({
      id,
      uri: `file:///w/${id}`,
      title: id,
      source: 'fs',
      kind: 'file',
      updatedAt: 0,
      score: 0,
      snippet: '',
      threadId: null,
      eventId: null,
      context: '',
      contextCode: null
    })
    act(() => useSearch.setState({ fileQuery: 'needle', fileHits: [mk('f1'), mk('f2')] }))
    const fileInput = host.querySelectorAll<HTMLInputElement>('.search-input')[0]!
    act(() => fileInput.focus())
    const activeTitle = (): string | null => host.querySelector('.search-hit.active')?.textContent ?? null
    expect(activeTitle()).toContain('f1')
    act(() => {
      fileInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    expect(activeTitle()).toContain('f2')
    // Typing into the plugin's field (an update of the draft) also
    type(pluginInput(), 'q3')
    expect(activeTitle()).toContain('f2')
    // a response from the plugin (adding its results section) also does not move it back.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLUGIN_SEARCH_DEBOUNCE_MS)
    })
    expect(search).toHaveBeenCalled()
    expect(host.textContent).toContain('q3 report')
    expect(activeTitle()).toContain('f2')
  })
})
