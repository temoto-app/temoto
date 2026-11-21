// @vitest-environment jsdom
/**
 * TODO 1199: while the conversation search (⌘K) has a word, the fields for full-text search (⌘⇧F) and file-name search (⌘P) are gray (disabled) and cannot take input.
 * The contents are kept, and when emptied they become enabled again as before. Shortcuts while gray do nothing (they change neither focus nor mode).
 * The reverse (a word in files does not gray out conversation) is not done.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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

let reactRoot: Root
let host: HTMLDivElement

beforeEach(async () => {
  ;(window as unknown as { aios: unknown }).aios = {
    editor: { reveal: vi.fn() },
    plugins: { list: async () => [], onChanged: () => () => undefined }
  }
  window.focus = () => undefined
  const { useSearch } = await import('../src/renderer/src/searchStore.js')
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  useSearch.setState({
    focusRequest: null,
    conversationDraft: '',
    fileQuery: '',
    nameQuery: '',
    conversationQuery: '',
    setFileQuery: () => undefined,
    setNameQuery: () => undefined,
    setConversationQuery: () => undefined,
    refreshForCwd: () => undefined
  })
  useThreads.setState({ mode: 'files', sidebarCollapsed: false })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
  const { SearchMode } = await import('../src/renderer/src/components/SearchMode.js')
  await act(async () => {
    reactRoot.render(createElement(SearchMode))
  })
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
})

type Three = [HTMLInputElement, HTMLInputElement, HTMLInputElement]

function inputs(): Three {
  return [...host.querySelectorAll<HTMLInputElement>('input.search-input:not([data-plugin-search])')] as Three
}
function type(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('会話の検索の語で本文検索・ファイル名検索が灰色になる (TODO 1199)', () => {
  it('語あり → 2 欄が disabled で内容は保持、tooltip に理由。空 → 元の内容のまま有効に戻る', () => {
    const [files, names, conv] = inputs()
    type(files, 'alpha')
    type(names, 'beta')
    expect(files.disabled).toBe(false)
    type(conv, 'x')
    expect(files.disabled).toBe(true)
    expect(names.disabled).toBe(true)
    expect(conv.disabled).toBe(false)
    expect(files.value).toBe('alpha')
    expect(names.value).toBe('beta')
    expect(files.title).toBe('Clear the conversation search to search files')
    type(conv, '')
    expect(files.disabled).toBe(false)
    expect(names.disabled).toBe(false)
    expect(files.value).toBe('alpha')
    expect(names.value).toBe('beta')
  })

  it('逆向きは灰色にしない (files に語があっても conversation は有効)', () => {
    const [files, , conv] = inputs()
    type(files, 'alpha')
    expect(conv.disabled).toBe(false)
  })

  it('灰色の間の ⌘⇧F / ⌘P / seed つきの要求は何もしない。⌘K は通る。空に戻れば通る', async () => {
    const { useSearch, isConversationLocked } = await import('../src/renderer/src/searchStore.js')
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { openSearch, searchFileName } = await import('../src/renderer/src/shortcut-actions.js')
    const [, , conv] = inputs()
    type(conv, 'x')
    expect(isConversationLocked(useSearch.getState())).toBe(true)
    act(() => {
      openSearch('files')
      openSearch('names')
      searchFileName('n')
    })
    expect(useSearch.getState().focusRequest).toBeNull()
    expect(useThreads.getState().mode).toBe('files')
    act(() => openSearch('conversation'))
    expect(useSearch.getState().focusRequest?.target).toBe('conversation')
    type(conv, '')
    expect(isConversationLocked(useSearch.getState())).toBe(false)
    act(() => openSearch('names'))
    expect(useSearch.getState().focusRequest?.target).toBe('names')
  })

  it('選択の右クリックの本文 / ファイル名検索は会話の検索の語を消して走る (2026-11-16 オーナー決定)', async () => {
    const { useSearch, isConversationLocked } = await import('../src/renderer/src/searchStore.js')
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { searchSelection } = await import('../src/renderer/src/shortcut-actions.js')
    act(() => useSearch.setState({ setConversationQuery: (query: string) => useSearch.setState({ conversationQuery: query }) }))
    const [files, names, conv] = inputs()
    type(conv, 'x')
    act(() => useSearch.setState({ conversationQuery: 'x' }))
    useThreads.setState({ mode: 'threads' })
    expect(isConversationLocked(useSearch.getState())).toBe(true)
    act(() => searchSelection('J-PlatPat', 'files'))
    expect(useSearch.getState().conversationQuery).toBe('')
    expect(isConversationLocked(useSearch.getState())).toBe(false)
    expect(conv.value).toBe('')
    expect(files.disabled).toBe(false)
    expect(files.value).toBe('J-PlatPat')
    expect(useThreads.getState().mode).toBe('search')
    type(conv, 'y')
    act(() => useSearch.setState({ conversationQuery: 'y' }))
    act(() => searchSelection('aios', 'names'))
    expect(conv.value).toBe('')
    expect(names.disabled).toBe(false)
    expect(names.value).toBe('aios')
  })

  it('debounce 内に unmount しても lock は残らない (conversationQuery は空のまま)', async () => {
    const { useSearch, isConversationLocked } = await import('../src/renderer/src/searchStore.js')
    const [, , conv] = inputs()
    type(conv, 'x')
    expect(useSearch.getState().conversationQuery).toBe('')
    expect(isConversationLocked(useSearch.getState())).toBe(true)
    act(() => reactRoot.unmount())
    expect(isConversationLocked(useSearch.getState())).toBe(false)
    // Recreated for the unmount in afterEach
    reactRoot = createRoot(host)
  })

  it('conversationQuery を直接 set しても lock が効く。空に戻せば外れる', async () => {
    const { useSearch, isConversationLocked } = await import('../src/renderer/src/searchStore.js')
    const { openSearch } = await import('../src/renderer/src/shortcut-actions.js')
    act(() => useSearch.setState({ conversationQuery: 'hello' }))
    expect(isConversationLocked(useSearch.getState())).toBe(true)
    act(() => openSearch('files'))
    expect(useSearch.getState().focusRequest).toBeNull()
    act(() => useSearch.setState({ conversationQuery: '' }))
    expect(isConversationLocked(useSearch.getState())).toBe(false)
  })

  it('灰色の間の「このフォルダ内を検索」は範囲も変えない', async () => {
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    const { openSearchInFolder } = await import('../src/renderer/src/shortcut-actions.js')
    const setRange = vi.fn()
    useSearch.setState({ conversationQuery: 'hello', setRange })
    act(() => openSearchInFolder('file:///tmp/x'))
    expect(setRange).not.toHaveBeenCalled()
    expect(useSearch.getState().focusRequest).toBeNull()
  })
})
