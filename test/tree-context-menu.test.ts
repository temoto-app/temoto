// @vitest-environment jsdom
/**
 * 365-1 (wave 20 bundle C): with the context menu open in the Files tree, pressing ↓ moved the background tree, not the menu, and 120 ms later another file was opened in the viewer (proxy verification run 24).
 *
 * - Once its position is set, the menu takes focus, and ↑↓ / Enter are handled by the menu. Neither the tree position nor the viewer moves.
 * - While the menu is open, keys that reach the tree's container are ignored.
 * - Closing with Esc returns focus to the tree, and ↑↓ work again right after.
 *
 * It renders `FileMode`, and the virtual list is a fake that draws every row (the same as `file-tree-keys.test.ts`). Neither a model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileEntry } from '../src/shared/types.js'
import { useStore } from '../src/renderer/src/store.js'

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
const fileC = entry(`${ROOT}/c.ts`, false, ROOT)
const fileD = entry(`${ROOT}/d.ts`, false, ROOT)

let reactRoot: Root
let host: HTMLDivElement
let selectCalls: string[]

beforeEach(async () => {
  vi.useFakeTimers()
  // TODO 1257: the Files selection is a module-level store; start each case without one.
  const { useFiler } = await import('../src/renderer/src/filerHistory.js')
  useFiler.setState({ histories: {} })
  selectCalls = []
  ;(window as unknown as { aios: unknown }).aios = {
    editor: { reveal: vi.fn() },
    app: { onMenuCommand: () => () => undefined }
  }
  useStore.setState({
    roots: [root],
    children: { [ROOT]: [dirA, fileB, fileC, fileD] },
    expanded: new Set([ROOT]),
    loading: new Set(),
    results: null,
    selectedUri: null,
    revealedUri: null,
    revealTick: 0,
    revealTarget: null,
    select: (uri: string | null) => {
      if (uri !== null) selectCalls.push(uri)
      useStore.setState({ selectedUri: uri, revealedUri: null })
    },
    toggle: async () => undefined,
    setQuery: () => undefined
  })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
  const { FileMode } = await import('../src/renderer/src/components/Sidebar.js')
  act(() => reactRoot.render(createElement(FileMode)))
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
  vi.useRealTimers()
})

const tree = (): HTMLElement => host.querySelector<HTMLElement>('.file-tree') as HTMLElement

function rowOf(name: string): HTMLElement {
  const row = [...tree().querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
    (el) => el.querySelector('.row-name')?.textContent === name
  )
  if (row === undefined) throw new Error(`no row ${name}`)
  return row
}

function active(): string | null {
  const id = tree().getAttribute('aria-activedescendant')
  if (id === null) return null
  return document.getElementById(id)?.querySelector('.row-name')?.textContent ?? null
}

function press(key: string, target: Element): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** A right-click (as in the real one, the nearest focusable ancestor of the row pressed: after focus moves to the container). */
async function rightClick(name: string): Promise<void> {
  act(() => tree().focus())
  await act(async () => {
    rowOf(name).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
    )
  })
}

const menu = (): HTMLElement | null => document.querySelector<HTMLElement>('.context-menu')
const activeItem = (): string | null =>
  document.querySelector('.context-menu-item.active')?.textContent ?? null

describe('右クリックのメニューと Files のツリーのキー (365-1)', () => {
  it('メニューが focus を取り、↓ はメニューの強調を動かす。ツリーの位置も viewer も動かない', async () => {
    // Right-click c.ts while b.ts is open.
    act(() => useStore.getState().select(fileB.uri))
    selectCalls.length = 0
    await rightClick('c.ts')
    expect(document.activeElement).toBe(menu())
    const before = active()
    const first = activeItem()
    press('ArrowDown', document.activeElement as Element)
    expect(activeItem()).not.toBe(first)
    expect(active()).toBe(before)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(selectCalls).toEqual([])
    expect(menu()).not.toBeNull()
  })

  it('メニューが開いている間は、ツリーの入れ物に来たキーも無視する', async () => {
    await rightClick('c.ts')
    const before = active()
    press('ArrowDown', tree())
    press('End', tree())
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(active()).toBe(before)
    expect(selectCalls).toEqual([])
  })

  it('Esc で閉じると focus はツリーへ戻り、続けて ↑↓ が効く', async () => {
    await rightClick('c.ts')
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(tree())
    // The key position is on the right-clicked row (c.ts) (observation 356 below), and ↓ moves to the next one.
    expect(active()).toBe('c.ts')
    press('ArrowDown', tree())
    expect(active()).toBe('d.ts')
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(selectCalls).toEqual([fileD.uri])
  })
})

describe('356 の小さな観察 (365、第 20 波 束 C)', () => {
  it('右クリックした行へキーの位置が移る。viewer には開かず、reveal の強調は消える', async () => {
    act(() => useStore.getState().select(fileB.uri))
    selectCalls.length = 0
    act(() => useStore.setState({ revealedUri: ROOT }))
    await rightClick('d.ts')
    expect(active()).toBe('d.ts')
    expect(useStore.getState().revealedUri).toBeNull()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(selectCalls).toEqual([])
    expect(useStore.getState().selectedUri).toBe(fileB.uri)
  })

  it('↑↓ の開く待ちの間に右クリックしたら、待っていたファイルは開かない', async () => {
    act(() => tree().focus())
    press('End', tree()) // d.ts (waiting for the 120 ms open)
    await rightClick('b.ts')
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(selectCalls).toEqual([])
  })

  it('Files に戻った (パネルの再表示) とき、キーの位置は作業フォルダの行ではなく開いているファイルの行', async () => {
    // Redraw in the state where an open file (c.ts) exists and the working folder (ROOT) has been revealed by pressing 'File'.
    act(() => reactRoot.unmount())
    act(() => useStore.setState({ selectedUri: fileC.uri }))
    act(() => useStore.setState({ revealedUri: ROOT, revealTick: useStore.getState().revealTick + 1 }))
    reactRoot = createRoot(host)
    const { FileMode } = await import('../src/renderer/src/components/Sidebar.js')
    act(() => reactRoot.render(createElement(FileMode)))
    expect(active()).toBe('c.ts')
    act(() => tree().focus())
    press('ArrowDown', tree())
    expect(active()).toBe('d.ts')
  })

  it('開いているファイルが無ければ、今までどおり作業フォルダの行 (項目 49)', async () => {
    act(() => useStore.setState({ revealedUri: dirA.uri, revealTick: useStore.getState().revealTick + 1 }))
    expect(active()).toBe('a')
  })
})
