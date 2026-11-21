// @vitest-environment jsdom
/**
 * TODO 357 (wave 19 bundle C): choose the search-mode results with ↑↓ and open them with Enter (jsdom). Same as VS Code's Quick Open:
 * - Focus stays on the window, and the window's `aria-activedescendant` points at the result row. The first candidate is highlighted from the start.
 * - ↑↓ cycles only through that window's results, skipping the section headings ("this folder", "anywhere") and the results of other windows.
 * - Enter does the same as pressing the row (file name → select, body → select + search word, conversation → jumpToEvent).
 * - Does not touch IME composition or Esc. When the results change, the highlight returns to the first candidate.
 *
 * The virtual list is replaced with a fake that draws every row (`scrollToIndex` only records). Uses neither the model nor Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SearchHit } from '../src/shared/search.js'

const scrolled: number[] = []
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => ({
    getTotalSize: () => options.count * 40,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        start: index * 40,
        size: options.estimateSize(index),
        key: index
      })),
    scrollToIndex: (index: number) => void scrolled.push(index)
  })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function hit(id: string, source: string, extra: Partial<SearchHit> = {}): SearchHit {
  return {
    id,
    uri: source === 'fs' ? `file:///w/${id}` : `thread://t/${id}`,
    title: id,
    source,
    kind: source === 'fs' ? 'file' : 'message',
    updatedAt: 0,
    score: 0,
    snippet: '',
    threadId: source === 'fs' ? null : 't1',
    eventId: source === 'fs' ? null : `e-${id}`,
    context: '',
    contextCode: null,
    ...extra
  }
}

let reactRoot: Root
let host: HTMLDivElement
let selectCalls: { uri: string | null; highlight: string | undefined }[]
let jumpCalls: string[]

beforeEach(async () => {
  scrolled.length = 0
  selectCalls = []
  jumpCalls = []
  ;(window as unknown as { aios: unknown }).aios = {
    editor: { reveal: vi.fn() },
    // TODO 896: SearchMode takes the list so that it can show the plugin's search section (there is no section here).
    plugins: { list: async () => [], onChanged: () => () => undefined }
  }
  const { useSearch } = await import('../src/renderer/src/searchStore.js')
  const { useStore } = await import('../src/renderer/src/store.js')
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  useSearch.setState({
    fileQuery: 'needle',
    fileHits: [hit('f1', 'fs')],
    fileCwd: null,
    nameHits: [hit('n2', 'fs'), hit('n3', 'fs')],
    nameOutcome: { total: 2, truncated: false, scanTruncated: false },
    nameCwd: { uri: 'file:///w', hits: [hit('n1', 'fs')], total: 1, truncated: false, scanTruncated: false },
    conversationHits: [hit('c1', 'conversation'), hit('c2', 'conversation')],
    focusRequest: null,
    // The input debounce calls this with an empty word. The real one clears the results, so nothing is done here.
    setFileQuery: () => undefined,
    setNameQuery: () => undefined,
    setConversationQuery: () => undefined,
    refreshForCwd: () => undefined
  })
  useStore.setState({
    select: (uri: string | null, options?: { highlight?: string }) => {
      selectCalls.push({ uri, highlight: options?.highlight })
    }
  })
  useThreads.setState({
    jumpToEvent: async (_threadId: string, eventId: string) => {
      jumpCalls.push(eventId)
    }
  })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
  const { SearchMode } = await import('../src/renderer/src/components/SearchMode.js')
  act(() => reactRoot.render(createElement(SearchMode)))
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
})

/** The window from the top: body / file name / conversation. */
function input(n: 0 | 1 | 2): HTMLInputElement {
  const el = host.querySelectorAll<HTMLInputElement>('.search-input')[n]
  if (el === undefined) throw new Error('no input')
  return el
}

function focus(el: HTMLElement): void {
  act(() => el.focus())
}

function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    el.dispatchEvent(event)
  })
  return event
}

/** The title of the highlighted row. It must also match the window's `aria-activedescendant`. */
function active(el: HTMLInputElement): string | null {
  const rows = host.querySelectorAll('.search-hit.active')
  if (rows.length === 0) return null
  expect(rows.length).toBe(1)
  const row = rows[0] as HTMLElement
  expect(el.getAttribute('aria-activedescendant')).toBe(row.id)
  expect(row.getAttribute('aria-selected')).toBe('true')
  return row.querySelector('.search-hit-name')?.textContent ?? null
}

describe('検索の結果のキー (TODO 357)', () => {
  it('focus が無ければ強調は無い。窓に focus すると、その窓の最初の候補が強調される', () => {
    expect(host.querySelector('.search-hit.active')).toBeNull()
    focus(input(1))
    expect(active(input(1))).toBe('n1')
    const list = host.querySelector('[role="listbox"]')
    expect(input(1).getAttribute('aria-controls')).toBe(list?.id)
  })

  it('↑↓ はその窓の結果だけを巡回し、小見出し・他の窓の結果を飛ばす', () => {
    focus(input(1))
    press(input(1), 'ArrowDown')
    expect(active(input(1))).toBe('n2') // Skipped the "anywhere" subheading
    press(input(1), 'ArrowDown')
    expect(active(input(1))).toBe('n3')
    press(input(1), 'ArrowDown')
    expect(active(input(1))).toBe('n1') // Does not go to the conversation results; cycles to the top
    press(input(1), 'ArrowUp')
    expect(active(input(1))).toBe('n3')
    expect(scrolled.length).toBeGreaterThan(0)
  })

  it('Enter: ファイル名は押したのと同じ select (検索語は運ばない)', () => {
    focus(input(1))
    press(input(1), 'ArrowDown')
    const event = press(input(1), 'Enter')
    expect(event.defaultPrevented).toBe(true)
    expect(selectCalls).toEqual([{ uri: 'file:///w/n2', highlight: undefined }])
  })

  it('Enter: 本文の結果は検索語ごと select、会話の結果はそのスレッドの発言へ移る', () => {
    focus(input(0))
    expect(active(input(0))).toBe('f1')
    press(input(0), 'Enter')
    expect(selectCalls).toEqual([{ uri: 'file:///w/f1', highlight: 'needle' }])
    focus(input(2))
    press(input(2), 'ArrowDown')
    expect(active(input(2))).toBe('c2')
    press(input(2), 'Enter')
    expect(jumpCalls).toEqual(['e-c2'])
  })

  it('IME の変換中は ↑↓ / Enter を拾わない。Esc と Home / End は欄の既定のまま', () => {
    focus(input(1))
    press(input(1), 'ArrowDown', { isComposing: true })
    press(input(1), 'Enter', { keyCode: 229 })
    expect(active(input(1))).toBe('n1')
    expect(selectCalls).toEqual([])
    act(() => {
      input(1).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })
    press(input(1), 'Enter')
    expect(selectCalls).toEqual([])
    act(() => {
      input(1).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    expect(press(input(1), 'Escape').defaultPrevented).toBe(false)
    expect(press(input(1), 'Home').defaultPrevented).toBe(false)
    expect(press(input(1), 'End').defaultPrevented).toBe(false)
  })

  it('結果が替わったら強調は最初の候補へ戻る。窓を離れたら強調は消える', async () => {
    focus(input(1))
    press(input(1), 'ArrowDown')
    press(input(1), 'ArrowDown')
    expect(active(input(1))).toBe('n3')
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    act(() => useSearch.setState({ nameHits: [hit('n4', 'fs')] }))
    expect(active(input(1))).toBe('n1')
    act(() => input(1).blur())
    expect(host.querySelector('.search-hit.active')).toBeNull()
    expect(input(1).hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('見出しの行は option ではない (読み上げで候補に数えない)', () => {
    const options = host.querySelectorAll('[role="option"]')
    // f1 / n1 / n2 / n3 / c1 / c2
    expect(options.length).toBe(6)
    expect(host.querySelector('.search-section')?.getAttribute('role')).toBe('presentation')
  })
})

/**
 * TODO 371 (keyboard) / TODO 410 (wave 21 bundle D; the click was taken out of scope, 2026-10-04):
 * When a ⌘P (file-name search, `names`) candidate is opened **with Enter**, the sidebar goes back to Threads.
 * **When it is opened with a mouse click it does not go back** — the user stays on the search screen so that another candidate can be tried by clicking (focus also remains in the search field; the `via` argument of `openRow` in `SearchMode.tsx`).
 * Body search (⌘⇧F) and conversation search (⌘K) stay in both ways of opening — so that the next hit can be opened.
 * `useThreads` uses the real `setMode` / `pressMode` as they are (only `jumpToEvent` is replaced in `beforeEach`).
 */
describe('サイドバーを Threads に戻す (TODO 371 / 410)', () => {
  async function setMode(mode: 'threads' | 'files' | 'search'): Promise<void> {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    act(() => useThreads.setState({ mode }))
  }

  async function mode(): Promise<string> {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    return useThreads.getState().mode
  }

  it('ファイル名の候補を Enter で開くと Threads に戻る', async () => {
    await setMode('search')
    focus(input(1))
    press(input(1), 'Enter')
    expect(selectCalls).toEqual([{ uri: 'file:///w/n1', highlight: undefined }])
    expect(await mode()).toBe('threads')
  })

  it('ファイル名の候補をマウスで押しても Threads に戻らない (TODO 410)。select は呼ばれ、表示は検索のまま', async () => {
    await setMode('search')
    focus(input(1))
    // Looks for the file-name row (n1), to tell it apart from the body row f1.
    const nameRow = [...host.querySelectorAll<HTMLElement>('.search-hit')].find(
      (el) => el.querySelector('.search-hit-name')?.textContent === 'n1'
    )
    expect(nameRow).toBeDefined()
    // 428-2: on a real device the default of mousedown moved focus to `.sidebar-panel` (tabIndex=-1). The row stops the default of mousedown
    // to keep focus in the search field. jsdom does not move focus on mousedown, so it checks `defaultPrevented`.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => void nameRow?.dispatchEvent(down))
    expect(down.defaultPrevented).toBe(true)
    act(() => nameRow?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(selectCalls).toEqual([{ uri: 'file:///w/n1', highlight: undefined }])
    expect(document.activeElement).toBe(input(1))
    expect(await mode()).toBe('search')
  })

  it('本文検索の Enter はサイドバーを動かさない (続けて別のヒットを開くため)', async () => {
    await setMode('search')
    focus(input(0))
    press(input(0), 'Enter')
    expect(selectCalls).toEqual([{ uri: 'file:///w/f1', highlight: 'needle' }])
    expect(await mode()).toBe('search')
  })

  it('会話検索の Enter はサイドバーを動かさない', async () => {
    await setMode('search')
    focus(input(2))
    press(input(2), 'Enter')
    expect(jumpCalls).toEqual(['e-c1'])
    expect(await mode()).toBe('search')
  })

  it('nameDraft は mount 時に searchStore.nameQuery から種を取る (前の語を残す)', async () => {
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    act(() => useSearch.setState({ nameQuery: 'kept-word' }))
    // Returning to Threads at 371 unmounts SearchMode. The store's `nameQuery` is not cleared
    // by unmount, so the recreated component takes its seed from there.
    act(() => reactRoot.unmount())
    host.remove()
    host = document.createElement('div')
    document.body.append(host)
    reactRoot = createRoot(host)
    const { SearchMode } = await import('../src/renderer/src/components/SearchMode.js')
    act(() => reactRoot.render(createElement(SearchMode)))
    expect(input(1).value).toBe('kept-word')
  })

  it('すでに Threads のときは setMode を呼び直さない (トグルで畳まない)', async () => {
    await setMode('threads')
    focus(input(1))
    press(input(1), 'Enter')
    // pressMode collapses when the icon of the mode currently shown is pressed (it toggles),
    // but returnToThreadsAfterNameOpen does not call setMode if it is already 'threads'.
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    expect(useThreads.getState().sidebarCollapsed).toBe(false)
    expect(await mode()).toBe('threads')
  })
})

/**
 * TODO 436 (wave 22 bundle E): folders also appear in file-name search results. Opening a folder row (with Enter or a click) does not change
 * the viewer (`select` is not called); it switches the sidebar to Files and `reveal`s that folder in the tree.
 * It does not return to Threads (371 / 410 are for file rows only).
 */
describe('フォルダの行は Files のツリーで選ぶ (TODO 436)', () => {
  let revealCalls: string[]

  beforeEach(async () => {
    revealCalls = []
    const { useSearch } = await import('../src/renderer/src/searchStore.js')
    const { useStore } = await import('../src/renderer/src/store.js')
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    act(() => {
      useStore.setState({
        reveal: async (uri: string) => {
          revealCalls.push(uri)
        }
      })
      useThreads.setState({ mode: 'search', sidebarCollapsed: false })
      useSearch.setState({
        nameCwd: null,
        nameHits: [hit('docs', 'fs', { kind: 'directory' }), hit('n2', 'fs')],
        nameOutcome: { total: 2, truncated: false, scanTruncated: false }
      })
    })
  })

  function folderRow(): HTMLElement {
    const row = [...host.querySelectorAll<HTMLElement>('.search-hit')].find(
      (el) => el.querySelector('.search-hit-name')?.textContent === 'docs'
    )
    if (row === undefined) throw new Error('no folder row')
    return row
  }

  it('Enter: viewer は替えず、Files に替えてそのフォルダを reveal する (Threads に戻さない)', async () => {
    focus(input(1))
    expect(active(input(1))).toBe('docs')
    press(input(1), 'Enter')
    expect(selectCalls).toEqual([])
    expect(revealCalls).toEqual(['file:///w/docs'])
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    expect(useThreads.getState().mode).toBe('files')
  })

  it('クリックでも同じ', async () => {
    act(() => folderRow().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(selectCalls).toEqual([])
    expect(revealCalls).toEqual(['file:///w/docs'])
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    expect(useThreads.getState().mode).toBe('files')
  })

  it('フォルダの行は Drag させない (ツリーの行と同じ)', () => {
    expect(folderRow().getAttribute('draggable')).toBe('false')
  })
})
