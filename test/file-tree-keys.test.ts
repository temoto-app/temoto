// @vitest-environment jsdom
/**
 * TODO 356 (wave 19 bundle C): move rows in the Files tree with ↑↓ (jsdom).
 *
 * Draws `FileMode` (`Sidebar.tsx`) and sends keydown to the tree container (`.file-tree`).
 * - One container holds focus and points at the row with `aria-activedescendant` (role tree / treeitem / aria-expanded)
 * - ↑↓ moves between rows, and for a file it also opens it in the viewer after a short wait (owner decision). If pressed repeatedly, only the last row is opened
 * - → / ← opens and closes folders and moves between parent and child rows; Enter opens
 * - Moving with the keys removes the reveal highlight. Keys during IME conversion, with modifier keys, or on a button inside a row are not taken
 *
 * A virtual list cannot measure heights in jsdom, so it is replaced by a fake that draws all rows (`scrollToIndex` only records).
 * Uses neither the model nor Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileEntry } from '../src/shared/types.js'

const scrolled: number[] = []
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
    scrollToIndex: (index: number) => void scrolled.push(index)
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
const fileInA = entry(`${ROOT}/a/x.ts`, false, `${ROOT}/a`)

let reactRoot: Root
let host: HTMLDivElement
let selectCalls: string[]
let toggleCalls: string[]

beforeEach(async () => {
  vi.useFakeTimers()
  // TODO 1257: the Files selection is a module-level store; start each case without one.
  const { useFiler } = await import('../src/renderer/src/filerHistory.js')
  useFiler.setState({ histories: {} })
  scrolled.length = 0
  selectCalls = []
  toggleCalls = []
  ;(window as unknown as { aios: unknown }).aios = {
    editor: { reveal: vi.fn() },
    app: { onMenuCommand: () => () => undefined }
  }
  const { useStore } = await import('../src/renderer/src/store.js')
  useStore.setState({
    roots: [root],
    children: { [ROOT]: [dirA, fileB, fileC], [`${ROOT}/a`]: [fileInA] },
    expanded: new Set([ROOT]),
    loading: new Set(),
    results: null,
    selectedUri: null,
    revealedUri: null,
    revealTick: 0,
    revealTarget: null,
    // The real one calls IPC. Here the called URI is recorded, and select only moves the selection.
    select: (uri: string | null) => {
      if (uri !== null) selectCalls.push(uri)
      useStore.setState({ selectedUri: uri, revealedUri: null })
    },
    toggle: async (uri: string) => {
      toggleCalls.push(uri)
      const expanded = new Set(useStore.getState().expanded)
      if (expanded.has(uri)) expanded.delete(uri)
      else expanded.add(uri)
      useStore.setState({ expanded })
    },
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

function tree(): HTMLElement {
  const el = host.querySelector<HTMLElement>('.file-tree')
  if (el === null) throw new Error('no tree')
  return el
}

function press(key: string, init: KeyboardEventInit = {}, target: Element = tree()): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

/** The name of the row that `aria-activedescendant` currently points at. */
function active(): string | null {
  const id = tree().getAttribute('aria-activedescendant')
  if (id === null) return null
  return document.getElementById(id)?.querySelector('.row-name')?.textContent ?? null
}

function flush(): void {
  act(() => {
    vi.advanceTimersByTime(200)
  })
}

describe('Files のツリーのキー (TODO 356)', () => {
  it('入れ物は role="tree" で focus を受け (tabIndex 0)、行は treeitem。フォルダは aria-expanded', () => {
    const el = tree()
    expect(el.getAttribute('role')).toBe('tree')
    expect(el.tabIndex).toBe(0)
    const items = host.querySelectorAll('[role="treeitem"]')
    expect(items.length).toBe(4)
    expect(items[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(items[1]?.getAttribute('aria-expanded')).toBe('false')
    expect(items[2]?.hasAttribute('aria-expanded')).toBe(false)
    expect(items[2]?.getAttribute('aria-level')).toBe('2')
  })

  it('何も指していなければ ↓ で先頭の行。↓↓ でファイルへ移ると、少し待って viewer に開く', () => {
    press('ArrowDown')
    expect(active()).toBe('w')
    press('ArrowDown')
    expect(active()).toBe('a')
    press('ArrowDown')
    expect(active()).toBe('b.ts')
    // Passing through folders (w / a) does not open them. Nothing is opened before the wait either.
    expect(selectCalls).toEqual([])
    flush()
    expect(selectCalls).toEqual([fileB.uri])
    expect(active()).toBe('b.ts')
    // If the row is off screen, follow it (scrollToIndex).
    expect(scrolled).toContain(2)
  })

  it('続けて押したら最後の行だけ開く (debounce)', () => {
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown') // b.ts
    press('ArrowDown') // c.ts
    flush()
    expect(selectCalls).toEqual([fileC.uri])
  })

  it('選択中のファイルから動き出す。端では止まる (巡回しない)', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    act(() => useStore.setState({ selectedUri: fileC.uri }))
    expect(active()).toBe('c.ts')
    press('ArrowDown')
    expect(active()).toBe('c.ts')
    press('ArrowUp')
    expect(active()).toBe('b.ts')
    press('Home')
    expect(active()).toBe('w')
    press('End')
    expect(active()).toBe('c.ts')
  })

  it('→ で閉じたフォルダを開き、もう一度 → で最初の子へ。← で親へ、開いたフォルダは閉じる', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    act(() => useStore.setState({ selectedUri: fileB.uri }))
    press('ArrowUp')
    expect(active()).toBe('a')
    press('ArrowRight')
    expect(toggleCalls).toEqual([dirA.uri])
    expect(active()).toBe('a')
    press('ArrowRight')
    expect(active()).toBe('x.ts')
    press('ArrowLeft')
    expect(active()).toBe('a')
    press('ArrowLeft')
    expect(toggleCalls).toEqual([dirA.uri, dirA.uri])
    expect(useStore.getState().expanded.has(dirA.uri)).toBe(false)
    press('ArrowLeft')
    expect(active()).toBe('w')
  })

  it('Enter はファイルをすぐ開き (待たない)、フォルダは開閉する', () => {
    press('ArrowDown')
    press('ArrowDown')
    press('Enter')
    expect(toggleCalls).toEqual([dirA.uri])
    press('ArrowDown')
    press('ArrowDown') // after a/x.ts comes b.ts
    expect(active()).toBe('b.ts')
    press('Enter')
    expect(selectCalls).toEqual([fileB.uri])
  })

  it('キーで動かしたら reveal の強調は消える', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    act(() => useStore.setState({ revealedUri: dirA.uri }))
    expect(active()).toBe('a')
    press('ArrowDown')
    expect(useStore.getState().revealedUri).toBeNull()
    expect(active()).toBe('b.ts')
  })

  it('IME の変換中・修飾キー付き・行の中のボタンへのキーは拾わない', () => {
    press('ArrowDown', { isComposing: true })
    press('ArrowDown', { keyCode: 229 })
    press('ArrowDown', { metaKey: true })
    press('ArrowDown', { ctrlKey: true })
    expect(active()).toBeNull()
    const button = host.querySelector('.row button')
    if (button === null) throw new Error('no row button')
    press('ArrowDown', {}, button)
    press('Enter', {}, button)
    expect(active()).toBeNull()
    flush()
    expect(selectCalls).toEqual([])
  })

  it('行を押したらその行がキーの位置になる', () => {
    const row = host.querySelectorAll('[role="treeitem"]')[3]
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(selectCalls).toEqual([fileC.uri])
    press('ArrowUp')
    expect(active()).toBe('b.ts')
  })
})
