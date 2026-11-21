// @vitest-environment jsdom
/**
 * TODO 520 (wave 26 bundle D): the shortcuts at the top of the Files tree (jsdom).
 *
 * - The shortcut roots use the same display names as Finder (JA / EN), and the same folder inside `~/` appears twice (the row keys differ)
 * - ↑↓ (356) moves from the row you are on even for duplicated rows (it does not jump to the first row shown)
 * - For folder shortcuts, "search inside this folder" (437) and "new file / folder" (370) work
 * - Inside the trash (view only), create, search inside this folder, and new chat are not shown (drag was changed to show under TODO 677)
 * - The store's `selectRows` gives row keys as `<root index>|<URI>`
 *
 * The virtual list is replaced by a fake that draws all rows. Uses neither the model nor Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileEntry, FolderShortcut } from '../src/shared/types.js'

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

const HOME = 'file:///Users/me'
function entry(uri: string, isDirectory: boolean, parentUri: string | null, shortcut?: FolderShortcut): FileEntry {
  const name = uri.slice(uri.lastIndexOf('/') + 1)
  return { uri, parentUri, name, isDirectory, size: 0, mtimeMs: 0, ext: '', ...(shortcut ? { shortcut } : {}) }
}
const downloadsUri = `${HOME}/Downloads`
const trashUri = `${HOME}/.Trash`
const shortcutDownloads = entry(downloadsUri, true, null, 'downloads')
const shortcutTrash = entry(trashUri, true, null, 'trash')
const home = entry(HOME, true, null)
const fsRoot = { ...entry('file:///', true, null), name: '/' }
const childDownloads = entry(downloadsUri, true, HOME)
const childNotes = entry(`${HOME}/notes.md`, false, HOME)
const pdf = entry(`${downloadsUri}/a.pdf`, false, downloadsUri)
const trashed = entry(`${trashUri}/old.md`, false, trashUri)
const trashedDir = entry(`${trashUri}/proj`, true, trashUri)

let reactRoot: Root
let host: HTMLDivElement
let selectCalls: string[]

async function setLocale(locale: 'ja' | 'en'): Promise<void> {
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  act(() => useLocale.setState({ resolved: locale }))
}

beforeEach(async () => {
  vi.useFakeTimers()
  selectCalls = []
  ;(window as unknown as { aios: unknown }).aios = {
    editor: { reveal: vi.fn() },
    app: { onMenuCommand: () => () => undefined },
    fs: { startDrag: vi.fn() }
  }
  await setLocale('ja')
  const { useStore } = await import('../src/renderer/src/store.js')
  useStore.setState({
    roots: [shortcutDownloads, shortcutTrash, home, fsRoot],
    children: {
      [HOME]: [childDownloads, childNotes],
      [downloadsUri]: [pdf],
      [trashUri]: [trashedDir, trashed]
    },
    expanded: new Set([HOME]),
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
    toggle: async (uri: string) => {
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

function rows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
}

function names(): string[] {
  return rows().map((row) => row.querySelector('.row-name')?.textContent ?? '')
}

function press(key: string): void {
  act(() => {
    tree().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function activeIndex(): number {
  const id = tree().getAttribute('aria-activedescendant')
  return rows().findIndex((row) => row.id === id)
}

function rowNamed(name: string, nth = 0): HTMLElement {
  const found = rows().filter((row) => row.querySelector('.row-name')?.textContent === name)[nth]
  if (found === undefined) throw new Error(`no row ${name}`)
  return found
}

function menuLabels(row: HTMLElement): string[] {
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
  })
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? '')
}

describe('Files ツリーの近道 (TODO 520)', () => {
  it('近道は先頭に Finder と同じ表示名で出て、~/ の中の同じフォルダと二重に出る', async () => {
    expect(names()).toEqual(['ダウンロード', 'ゴミ箱', 'me', 'Downloads', 'notes.md', '/'])
    await setLocale('en')
    expect(names()).toEqual(['Downloads', 'Trash', 'me', 'Downloads', 'notes.md', '/'])
    // Row ids are unique (React's keys are different too).
    expect(new Set(rows().map((row) => row.id)).size).toBe(rows().length)
    expect(rowNamed('Trash').getAttribute('title')).toContain('Read only')
  })

  it('selectRows は行の key を <ルートの添字>|<URI> で振る', async () => {
    const { selectRows, useStore } = await import('../src/renderer/src/store.js')
    const keys = selectRows(useStore.getState()).map((row) => row.key)
    expect(keys).toEqual([
      `0|${downloadsUri}`,
      `1|${trashUri}`,
      `2|${HOME}`,
      `2|${downloadsUri}`,
      `2|${HOME}/notes.md`,
      '3|file:///'
    ])
  })

  it('↑↓ は二重の行でもいま居る行から動き、開いたファイルで跳ねない', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    // Opening Downloads from the shortcut: the Downloads inside ~/ are in the same state (open and close are held by URI).
    act(() => useStore.setState({ expanded: new Set([HOME, downloadsUri]) }))
    expect(names()).toEqual(['ダウンロード', 'a.pdf', 'ゴミ箱', 'me', 'Downloads', 'a.pdf', 'notes.md', '/'])
    // Go down by keys to the Downloads row inside ~/ (row 4), then ↓ goes to a.pdf below it, not to the shortcut side.
    press('Home')
    for (let i = 0; i < 4; i += 1) press('ArrowDown')
    expect(activeIndex()).toBe(4)
    selectCalls.length = 0
    act(() => {
      vi.advanceTimersByTime(200)
    })
    press('ArrowDown')
    expect(activeIndex()).toBe(5)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(selectCalls).toEqual([pdf.uri])
    // Even after opening, it stays on the row you are on (a.pdf below).
    expect(activeIndex()).toBe(5)
    press('ArrowDown')
    expect(names()[activeIndex()]).toBe('notes.md')
  })

  it('フォルダの近道は作成と「このフォルダ内を検索」が効く', () => {
    const labels = menuLabels(rowNamed('ダウンロード'))
    expect(labels).toEqual(expect.arrayContaining(['新しいファイル…', '新しいフォルダ…', 'このフォルダ内を検索…']))
    expect(rowNamed('ダウンロード').classList.contains('has-search-in-folder')).toBe(true)
  })

  it('ゴミ箱 (見るだけ) の中は作成・検索・新規チャットを出さない。Finder で表示・drag (TODO 677、外へ出すのはコピーになるだけ) は残す', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    act(() => useStore.setState({ expanded: new Set([HOME, trashUri]) }))
    for (const row of [rowNamed('ゴミ箱'), rowNamed('proj'), rowNamed('old.md')]) {
      expect(row.classList.contains('has-search-in-folder')).toBe(false)
      expect(row.classList.contains('has-new-chat')).toBe(false)
      expect(row.querySelector('.row-new-chat')).toBeNull()
    }
    // TODO 677 (wave 31): read-only rows can also be dragged to other apps (a separate matter from moving things inside aios).
    expect(rowNamed('old.md').getAttribute('draggable')).toBe('true')
    expect(rowNamed('notes.md').getAttribute('draggable')).toBe('true')
    const labels = menuLabels(rowNamed('proj'))
    expect(labels).not.toContain('新しいファイル…')
    expect(labels).not.toContain('このフォルダ内を検索…')
    expect(labels.length).toBeGreaterThan(0)
    // Files inside the trash can still be opened in the viewer (read).
    act(() => rowNamed('old.md').click())
    expect(selectCalls).toEqual([trashed.uri])
  })

  // Code-review fix (TODO 677, serious 2, owner decision 2026-10-11): Electron's `webContents.startDrag` cannot restrict NSDragOperation to copy only (per investigation). So trash rows are not offered to the native drag, and the form is reverted to the one before 677 (`dataTransfer.setData('text/uri-list', …)`), where only a drop inside aios works.
  it('ゴミ箱の行は dragstart で OS のネイティブドラッグへ出さず、text/uri-list に載せるだけ (外へ出さない)', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    act(() => useStore.setState({ expanded: new Set([HOME, trashUri]) }))
    const setDataCalls: [string, string][] = []
    const dataTransfer = {
      setData: (format: string, data: string): void => {
        setDataCalls.push([format, data])
      },
      effectAllowed: undefined as string | undefined
    }
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    act(() => rowNamed('old.md').dispatchEvent(event))
    expect(setDataCalls).toEqual([['text/uri-list', trashed.uri]])
    expect(dataTransfer.effectAllowed).toBe('copy')
    expect(event.defaultPrevented).toBe(false)
    const startDrag = (window as unknown as { aios: { fs: { startDrag: ReturnType<typeof vi.fn> } } }).aios.fs
      .startDrag
    expect(startDrag).not.toHaveBeenCalled()
  })

  it('読み取り専用でない行は dragstart を preventDefault して OS のネイティブドラッグへ出す', async () => {
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    const dataTransfer = { setData: vi.fn(), effectAllowed: undefined as string | undefined }
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    act(() => rowNamed('notes.md').dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(dataTransfer.setData).not.toHaveBeenCalled()
    const startDrag = (window as unknown as { aios: { fs: { startDrag: ReturnType<typeof vi.fn> } } }).aios.fs
      .startDrag
    expect(startDrag).toHaveBeenCalledWith([childNotes.uri])
  })
})
