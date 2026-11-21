// @vitest-environment jsdom
/**
 * TODO 1257 (wave 92 bundle A): the Files back / forward and the per-conversation Files selection.
 *
 * - Pure (`filer-history.ts`): record a pick, the 1 s collapse of ↑↓, fold, limit, drop forward steps, step,
 *   drop gone rows, rename, the no-conversation slot.
 * - jsdom (`FileMode` + `useFilerHistory` + `FilerNavButtons`): a picked row is the main highlight and the viewer's
 *   file only gets the quiet mark; ← → reveal the row without touching the viewer; per conversation; gone rows are
 *   dropped; an explicit reveal is a pick; no history without a conversation; EN / JA names.
 *
 * The virtual list cannot measure in jsdom, so it is replaced by one that draws every row. No model, no Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileEntry } from '../src/shared/types.js'
import {
  EMPTY_FILER,
  FILER_COALESCE_MS,
  FILER_LIMIT,
  canStepFiler,
  currentFilerUri,
  dropEntries,
  holdOnly,
  recordPick,
  renameEntries,
  stepFiler,
  type FilerHistory
} from '../src/renderer/src/filer-history.js'

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

const T0 = 1_000_000
const pick = (uri: string, now: number, byKeys = false): { uri: string; now: number; byKeys: boolean } => ({
  uri,
  now,
  byKeys
})
const uris = (history: FilerHistory): string[] => history.entries.map((entry) => entry.uri)

describe('filer-history: pure', () => {
  it('a pick is one step; picking the current row again changes nothing', () => {
    let h = recordPick(EMPTY_FILER, pick('a', T0))
    h = recordPick(h, pick('b', T0 + 10))
    expect(uris(h)).toEqual(['a', 'b'])
    expect(currentFilerUri(h)).toBe('b')
    expect(recordPick(h, pick('b', T0 + 20))).toBe(h)
    expect(currentFilerUri(EMPTY_FILER)).toBeNull()
  })

  it('↑↓ moves within 1 s collapse into one step; the step before the run stays', () => {
    let h = recordPick(EMPTY_FILER, pick('a', T0))
    h = recordPick(h, pick('b', T0 + 100, true))
    h = recordPick(h, pick('c', T0 + 300, true))
    h = recordPick(h, pick('d', T0 + 600, true))
    expect(uris(h)).toEqual(['a', 'd'])
    h = recordPick(h, pick('e', T0 + 600 + FILER_COALESCE_MS, true))
    expect(uris(h)).toEqual(['a', 'd', 'e'])
  })

  it('clicks never collapse', () => {
    let h = recordPick(EMPTY_FILER, pick('a', T0))
    h = recordPick(h, pick('b', T0 + 10))
    h = recordPick(h, pick('c', T0 + 20))
    expect(uris(h)).toEqual(['a', 'b', 'c'])
  })

  it('↓ then ↑ back onto the previous row folds the current step', () => {
    let h = recordPick(EMPTY_FILER, pick('a', T0, true))
    h = recordPick(h, pick('b', T0 + 5000, true))
    h = recordPick(h, pick('a', T0 + 5100, true))
    expect(uris(h)).toEqual(['a'])
    expect(h.index).toBe(0)
  })

  it('back / forward; null at either end; a new pick after going back drops the forward steps', () => {
    let h = recordPick(EMPTY_FILER, pick('a', T0))
    h = recordPick(h, pick('b', T0 + 10))
    h = recordPick(h, pick('c', T0 + 20))
    expect(stepFiler(h, 'forward')).toBeNull()
    expect(canStepFiler(h, 'back')).toBe(true)
    const back = stepFiler(h, 'back')
    expect(back?.entry.uri).toBe('b')
    h = recordPick(back!.history, pick('z', T0 + 30))
    expect(uris(h)).toEqual(['a', 'b', 'z'])
    expect(canStepFiler(EMPTY_FILER, 'back')).toBe(false)
  })

  it('keeps up to 50 steps, dropping the oldest', () => {
    let h = EMPTY_FILER
    for (let i = 0; i < FILER_LIMIT + 10; i++) h = recordPick(h, pick(`r${i}`, T0 + i * 10))
    expect(h.entries).toHaveLength(FILER_LIMIT)
    expect(h.entries[0]?.uri).toBe('r10')
    expect(h.index).toBe(FILER_LIMIT - 1)
  })

  it('dropEntries removes gone rows but keeps the current one, and merges neighbours that became equal', () => {
    let h = EMPTY_FILER
    for (const uri of ['a', 'b', 'a', 'c', 'd']) h = recordPick(h, pick(uri, T0))
    h = stepFiler(stepFiler(h, 'back')!.history, 'back')!.history // current = 'a' (index 2)
    const dropped = dropEntries(h, (uri) => uri === 'b' || uri === 'd' || uri === 'a')
    expect(uris(dropped)).toEqual(['a', 'c'])
    expect(currentFilerUri(dropped)).toBe('a')
    expect(dropEntries(h, () => false)).toBe(h)
  })

  it('renameEntries moves the renamed row and what is inside it', () => {
    let h = recordPick(EMPTY_FILER, pick('file:///w/old', T0))
    h = recordPick(h, pick('file:///w/old/x.ts', T0 + 10))
    h = recordPick(h, pick('file:///w/older', T0 + 20))
    const renamed = renameEntries(h, 'file:///w/old', 'file:///w/new')
    expect(uris(renamed)).toEqual(['file:///w/new', 'file:///w/new/x.ts', 'file:///w/older'])
    expect(renameEntries(h, 'file:///w/none', 'file:///w/x')).toBe(h)
  })

  it('holdOnly keeps a single row (no history while no conversation is shown)', () => {
    let h = holdOnly(EMPTY_FILER, pick('a', T0))
    h = holdOnly(h, pick('b', T0 + 10))
    expect(uris(h)).toEqual(['b'])
    expect(canStepFiler(h, 'back')).toBe(false)
    expect(holdOnly(h, pick('b', T0 + 20))).toBe(h)
  })
})

// ---- FileMode + useFilerHistory + FilerNavButtons (jsdom) ----

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

describe('FileMode + Files back / forward', () => {
  let reactRoot: Root
  let host: HTMLDivElement
  let missing: Set<string>
  let statCalls: string[]
  let selectCalls: string[]
  let useStore: typeof import('../src/renderer/src/store.js').useStore
  let useThreads: typeof import('../src/renderer/src/threadStore.js').useThreads
  let useFiler: typeof import('../src/renderer/src/filerHistory.js').useFiler

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    missing = new Set()
    statCalls = []
    selectCalls = []
    ;(window as unknown as { aios: unknown }).aios = {
      editor: { reveal: vi.fn() },
      app: { onMenuCommand: () => () => undefined },
      fs: {
        stat: async (uri: string) => {
          statCalls.push(uri)
          return missing.has(uri) ? null : { uri }
        },
        listDirectory: async () => ({ entries: [], reason: null })
      }
    }
    ;({ useStore } = await import('../src/renderer/src/store.js'))
    ;({ useThreads } = await import('../src/renderer/src/threadStore.js'))
    const filer = await import('../src/renderer/src/filerHistory.js')
    useFiler = filer.useFiler
    useFiler.setState({ histories: {} })
    useThreads.setState({
      activeThreadId: 'a',
      threadsById: { a: { id: 'a' } as never, b: { id: 'b' } as never }
    })
    useStore.setState({
      roots: [root],
      children: { [ROOT]: [dirA, fileB, fileC], [`${ROOT}/a`]: [fileInA] },
      expanded: new Set([ROOT, `${ROOT}/a`]),
      loading: new Set(),
      results: null,
      selectedUri: null,
      revealedUri: null,
      revealTick: 0,
      revealTarget: null,
      // The real one talks to main. Here it only moves the viewer's file.
      select: (uri: string | null) => {
        if (uri !== null) selectCalls.push(uri)
        useStore.setState({ selectedUri: uri, revealedUri: null })
      },
      toggle: async () => undefined,
      setQuery: () => undefined
    })
    const { FileMode } = await import('../src/renderer/src/components/Sidebar.js')
    const Harness = (): React.JSX.Element => {
      filer.useFilerHistory()
      return createElement(FileMode)
    }
    host = document.createElement('div')
    document.body.append(host)
    reactRoot = createRoot(host)
    act(() => reactRoot.render(createElement(Harness)))
  })

  afterEach(() => {
    act(() => reactRoot.unmount())
    host.remove()
    vi.useRealTimers()
  })

  function rowEl(name: string): HTMLElement {
    const el = [...host.querySelectorAll<HTMLElement>('.file-tree .row')].find(
      (row) => row.querySelector('.row-name')?.textContent === name
    )
    if (el === undefined) throw new Error(`no row ${name}`)
    return el
  }
  const selectedRows = (): string[] =>
    [...host.querySelectorAll('.file-tree .row.selected .row-name')].map((el) => el.textContent ?? '')
  const viewerRows = (): string[] =>
    [...host.querySelectorAll('.file-tree .row.viewer-open .row-name')].map((el) => el.textContent ?? '')
  const backButton = (): HTMLButtonElement | null => host.querySelector('button.files-back')
  const forwardButton = (): HTMLButtonElement | null => host.querySelector('button.files-forward')

  async function clickRow(name: string): Promise<void> {
    vi.advanceTimersByTime(5000)
    act(() => rowEl(name).click())
  }
  async function press(button: HTMLButtonElement | null): Promise<void> {
    await act(async () => {
      button?.click()
      await vi.runAllTimersAsync()
    })
  }

  it('a clicked row is the main highlight; the viewer file only gets the quiet mark', async () => {
    await clickRow('b.ts')
    expect(selectedRows()).toEqual(['b.ts'])
    expect(viewerRows()).toEqual(['b.ts'])
    await clickRow('a')
    // A folder row is picked too; the viewer keeps b.ts.
    expect(selectedRows()).toEqual(['a'])
    expect(viewerRows()).toEqual(['b.ts'])
    expect(selectCalls).toEqual([fileB.uri])
  })

  it('← → walk the picked rows without switching the viewer and without recording', async () => {
    expect(backButton()?.disabled).toBe(true)
    await clickRow('b.ts')
    await clickRow('c.ts')
    await clickRow('a')
    expect(backButton()?.disabled).toBe(false)
    expect(forwardButton()?.disabled).toBe(true)
    await press(backButton())
    expect(selectedRows()).toEqual(['c.ts'])
    await press(backButton())
    expect(selectedRows()).toEqual(['b.ts'])
    expect(useStore.getState().selectedUri).toBe(fileC.uri)
    expect(selectCalls).toEqual([fileB.uri, fileC.uri])
    expect(forwardButton()?.disabled).toBe(false)
    await press(forwardButton())
    expect(selectedRows()).toEqual(['c.ts'])
    expect(uris(useFiler.getState().histories.a ?? EMPTY_FILER)).toEqual([fileB.uri, fileC.uri, dirA.uri])
  })

  it('back reveals the row: closed ancestors are opened', async () => {
    await clickRow('x.ts')
    await clickRow('b.ts')
    act(() => useStore.setState({ expanded: new Set([ROOT]) }))
    expect(() => rowEl('x.ts')).toThrow()
    await press(backButton())
    expect(useStore.getState().expanded.has(dirA.uri)).toBe(true)
    expect(selectedRows()).toEqual(['x.ts'])
  })

  it('each conversation has its own Files selection and history', async () => {
    await clickRow('b.ts')
    await clickRow('c.ts')
    act(() => useThreads.setState({ activeThreadId: 'b' }))
    expect(selectedRows()).toEqual([])
    expect(backButton()?.disabled).toBe(true)
    await clickRow('a')
    expect(selectedRows()).toEqual(['a'])
    act(() => useThreads.setState({ activeThreadId: 'a' }))
    expect(selectedRows()).toEqual(['c.ts'])
    expect(backButton()?.disabled).toBe(false)
  })

  it('rows that are gone are skipped and dropped from the list', async () => {
    await clickRow('b.ts')
    await clickRow('c.ts')
    await clickRow('a')
    missing.add(fileC.uri)
    await press(backButton())
    expect(selectedRows()).toEqual(['b.ts'])
    expect(uris(useFiler.getState().histories.a ?? EMPTY_FILER)).toEqual([fileB.uri, dirA.uri])
    await press(forwardButton())
    expect(selectedRows()).toEqual(['a'])
  })

  it('when only gone rows are left, a press disables the button', async () => {
    await clickRow('b.ts')
    await clickRow('c.ts')
    missing.add(fileB.uri)
    expect(backButton()?.disabled).toBe(false)
    await press(backButton())
    expect(selectedRows()).toEqual(['c.ts'])
    expect(backButton()?.disabled).toBe(true)
  })

  it('a press stats only the nearest step, and walks on only past gone rows', async () => {
    await clickRow('b.ts')
    await clickRow('c.ts')
    await clickRow('a')
    statCalls = []
    await press(backButton())
    expect(statCalls).toEqual([fileC.uri])
    statCalls = []
    missing.add(fileB.uri)
    await press(backButton())
    expect(statCalls).toEqual([fileB.uri])
    expect(selectedRows()).toEqual(['c.ts'])
  })

  it('switching conversation: the viewer file ancestors are opened and the Files row is shown last', async () => {
    await clickRow('b.ts')
    act(() => useStore.setState({ expanded: new Set([ROOT]) }))
    await act(async () => {
      useStore.setState({ selectedUri: fileInA.uri })
      useThreads.setState({ activeThreadId: 'b' })
    })
    await act(async () => useThreads.setState({ activeThreadId: 'a' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(useStore.getState().expanded.has(dirA.uri)).toBe(true)
    expect(useStore.getState().revealTarget?.uri).toBe(fileB.uri)
    expect(selectedRows()).toEqual(['b.ts'])
  })

  it('a conversation that leaves the list takes its Files history with it', async () => {
    await clickRow('b.ts')
    expect(Object.keys(useFiler.getState().histories)).toEqual(['a'])
    act(() => useThreads.setState({ activeThreadId: 'b', threadsById: { b: { id: 'b' } as never } }))
    expect(Object.keys(useFiler.getState().histories)).toEqual([])
  })

  it('an explicit reveal (working folder, Show in Files) is a pick', async () => {
    await clickRow('b.ts')
    vi.advanceTimersByTime(5000)
    await act(async () => useStore.getState().reveal(dirA.uri))
    expect(selectedRows()).toEqual(['a'])
    expect(backButton()?.disabled).toBe(false)
  })

  it('↑↓ picks rows; moves within 1 s are one step', async () => {
    await clickRow('w')
    const tree = host.querySelector<HTMLElement>('.file-tree')!
    const key = (name: string): void =>
      act(() => {
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
      })
    vi.advanceTimersByTime(5000)
    key('ArrowDown') // a
    vi.advanceTimersByTime(100)
    key('ArrowDown') // x.ts
    vi.advanceTimersByTime(100)
    key('ArrowDown') // b.ts
    expect(selectedRows()).toEqual(['b.ts'])
    expect(uris(useFiler.getState().histories.a ?? EMPTY_FILER)).toEqual([ROOT, fileB.uri])
  })

  it('without a conversation, the selection is held but no history is kept', async () => {
    act(() => useThreads.setState({ activeThreadId: null }))
    await clickRow('b.ts')
    await clickRow('c.ts')
    expect(selectedRows()).toEqual(['c.ts'])
    expect(backButton()?.disabled).toBe(true)
  })

  it('button names come from the dictionary (EN / JA)', async () => {
    const { useLocale } = await import('../src/renderer/src/localeStore.js')
    const { en } = await import('../src/renderer/src/i18n/en.js')
    const { ja } = await import('../src/renderer/src/i18n/ja.js')
    act(() => useLocale.setState({ resolved: 'en' }))
    expect(backButton()?.getAttribute('aria-label')).toBe(en['files.back'])
    expect(forwardButton()?.getAttribute('aria-label')).toBe(en['files.forward'])
    act(() => useLocale.setState({ resolved: 'ja' }))
    expect(backButton()?.getAttribute('aria-label')).toBe(ja['files.back'])
    expect(ja['files.back']).not.toContain('Filer')
    expect(en['files.back']).not.toContain('Filer')
  })
})
