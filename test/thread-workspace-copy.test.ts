// @vitest-environment jsdom
/**
 * TODO 1334 (wave 105 bundle B): "continue in a lighter new conversation" copies the source conversation's workspace state
 * (viewer memory, viewer ← → history with positions, Files history, the dismissed viewer selection) to the new conversation.
 *
 * - the new conversation gets the same values; the source keeps its own (a copy, not a move);
 * - the copies are values: changing one side afterwards does not change the other;
 * - what reaches main goes through the usual checked writes (`setViewerState` / `setViewerHistory`), only for the new id;
 * - `threadStore.handoff` runs the copy after main created the conversation and before opening it.
 *
 * `window.aios` is a fake. Neither the model nor main is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WEB_BLANK_URL } from '../src/shared/web-tabs.js'
import { EMPTY_HISTORY, copyHistory, recordVisit, setPosition, type ViewerHistory } from '../src/renderer/src/viewer-history.js'
import { EMPTY_FILER, copyFilerHistory, recordPick, type FilerHistory } from '../src/renderer/src/filer-history.js'
import type { ViewerHistorySnapshot } from '../src/shared/viewer-history.js'

const A = 'file:///work/a.ts'
const B = 'file:///work/b.ts'
const C = 'file:///work/c.ts'
const DIR = 'file:///work'

const visit = (history: ViewerHistory, uri: string, highlight: string | null = null): ViewerHistory =>
  recordVisit(history, { uri, highlight, now: 0, byKeys: false })

describe('copyHistory / copyFilerHistory (pure)', () => {
  it('copies steps, index and positions without sharing any object', () => {
    const source = setPosition(visit(visit(EMPTY_HISTORY, A), B, 'q'), A, { kind: 'line', value: 40 })
    const copy = copyHistory(source)
    expect(copy).toEqual(source)
    expect(copy).not.toBe(source)
    expect(copy.entries).not.toBe(source.entries)
    expect(copy.entries[0]).not.toBe(source.entries[0])
    expect(copy.positions).not.toBe(source.positions)
    expect(copy.positions?.[A]).not.toBe(source.positions?.[A])
  })

  it('a history without positions stays without positions', () => {
    const copy = copyHistory(visit(EMPTY_HISTORY, A))
    expect('positions' in copy).toBe(false)
  })

  it('copies the Files history without sharing steps', () => {
    const source = recordPick(recordPick(EMPTY_FILER, { uri: DIR, now: 0, byKeys: false }), { uri: A, now: 5, byKeys: false })
    const copy = copyFilerHistory(source)
    expect(copy).toEqual(source)
    expect(copy.entries).not.toBe(source.entries)
    expect(copy.entries[1]).not.toBe(source.entries[1])
  })
})

describe('copyThreadWorkspace (wiring)', () => {
  const stored: ViewerHistorySnapshot = {
    entries: [
      { uri: C, highlight: null },
      { uri: A, highlight: null }
    ],
    index: 1
  }

  let viewerHistory: ReturnType<typeof vi.fn>
  let setViewerHistory: ReturnType<typeof vi.fn>
  let setViewerState: ReturnType<typeof vi.fn>
  let store: typeof import('../src/renderer/src/store.js')
  let threads: typeof import('../src/renderer/src/threadStore.js')
  let filer: typeof import('../src/renderer/src/filerHistory.js')
  let history: typeof import('../src/renderer/src/viewerHistory.js')
  let workspace: typeof import('../src/renderer/src/thread-workspace.js')

  beforeEach(async () => {
    vi.resetModules()
    viewerHistory = vi.fn(async (threadId: string) => (threadId === 'src' ? stored : null))
    setViewerHistory = vi.fn(async () => undefined)
    setViewerState = vi.fn(async () => undefined)
    ;(window as unknown as { aios: unknown }).aios = {
      threads: { viewerHistory, setViewerHistory, setViewerState },
      fs: { stat: vi.fn(async () => ({})) }
    }
    store = await import('../src/renderer/src/store.js')
    threads = await import('../src/renderer/src/threadStore.js')
    filer = await import('../src/renderer/src/filerHistory.js')
    history = await import('../src/renderer/src/viewerHistory.js')
    workspace = await import('../src/renderer/src/thread-workspace.js')
    // The source conversation is on screen with B open (searching for 'needle').
    store.useStore.setState({ viewerHistories: {}, selectedUri: B, highlightQuery: 'needle', select: vi.fn() } as never)
    filer.useFiler.setState({ histories: {} })
    threads.useThreads.setState({
      activeThreadId: 'src',
      threadsById: {
        src: { thread: { id: 'src', lastViewerUri: B, lastViewerHighlight: 'needle' } }
      } as never,
      dismissedSelections: { src: 'sel-key' }
    })
    // The source conversation: its stored history was read back, then B was opened (with a position on A).
    await history.hydrateViewerHistory('src')
    const shown = setPosition(visit(store.useStore.getState().viewerHistories['src'] as ViewerHistory, B, 'needle'), A, {
      kind: 'line',
      value: 120
    })
    store.useStore.getState().setViewerHistory('src', shown)
    filer.pickFilerRow(DIR)
    filer.pickFilerRow(A)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const viewerOf = (id: string): ViewerHistory | undefined => store.useStore.getState().viewerHistories[id]
  const filerOf = (id: string): FilerHistory | undefined => filer.useFiler.getState().histories[id]

  it('the new conversation gets the viewer target, the ← → list with positions, the Files history and the dismissed selection', async () => {
    const sourceViewer = viewerOf('src')
    const sourceFiler = filerOf('src')
    expect(await workspace.copyThreadWorkspace('src', 'dst')).toEqual([])

    expect(viewerOf('dst')).toEqual(sourceViewer)
    expect(viewerOf('dst')?.entries.map((entry) => entry.uri)).toEqual([C, A, B])
    expect(viewerOf('dst')?.positions?.[A]).toEqual({ kind: 'line', value: 120 })
    expect(filerOf('dst')).toEqual(sourceFiler)
    expect(threads.useThreads.getState().dismissedSelections['dst']).toBe('sel-key')

    // The source is untouched (same objects, nothing removed).
    expect(viewerOf('src')).toBe(sourceViewer)
    expect(filerOf('src')).toBe(sourceFiler)
    expect(threads.useThreads.getState().dismissedSelections['src']).toBe('sel-key')

    // Values, not shared references.
    expect(viewerOf('dst')).not.toBe(sourceViewer)
    expect(viewerOf('dst')?.entries[0]).not.toBe(sourceViewer?.entries[0])
    expect(filerOf('dst')).not.toBe(sourceFiler)
  })

  it('writes to main only for the new conversation, through the usual checked calls; the new one is not read back', async () => {
    await workspace.copyThreadWorkspace('src', 'dst')
    vi.advanceTimersByTime(400)
    expect(setViewerState).toHaveBeenCalledWith('dst', B, 'needle')
    expect(setViewerState).not.toHaveBeenCalledWith('src', expect.anything(), expect.anything())
    const written = setViewerHistory.mock.calls.filter(([id]) => id === 'dst')
    expect(written).toHaveLength(1)
    expect((written[0]?.[1] as ViewerHistorySnapshot).entries.map((entry) => entry.uri)).toEqual([C, A, B])
    expect(setViewerHistory.mock.calls.some(([id]) => id === 'src')).toBe(false)
    // The new conversation has nothing stored in main; the copy counts as read back (it is not overwritten by a read).
    await history.hydrateViewerHistory('dst')
    expect(viewerHistory).not.toHaveBeenCalledWith('dst')
  })

  it('changing one side afterwards does not change the other (viewer history and Files)', async () => {
    await workspace.copyThreadWorkspace('src', 'dst')
    const sourceViewer = viewerOf('src')
    const sourceFiler = filerOf('src')

    // The new conversation moves on.
    threads.useThreads.setState({ activeThreadId: 'dst' })
    store.useStore.getState().setViewerHistory('dst', visit(viewerOf('dst') as ViewerHistory, C))
    filer.pickFilerRow(B)
    expect(viewerOf('dst')?.entries.map((entry) => entry.uri)).toEqual([C, A, B, C])
    expect(viewerOf('src')).toBe(sourceViewer)
    expect(viewerOf('src')?.entries.map((entry) => entry.uri)).toEqual([C, A, B])
    expect(filerOf('src')).toBe(sourceFiler)
    expect(filer.useFiler.getState().histories['src']?.entries.map((entry) => entry.uri)).toEqual([DIR, A])

    // The source moves on.
    threads.useThreads.setState({ activeThreadId: 'src' })
    filer.pickFilerRow(C)
    expect(filerOf('dst')?.entries.map((entry) => entry.uri)).toEqual([DIR, A, B])
  })

  it('a position for the file on screen goes to the conversation on screen: A → B (handoff) → back to A (review Y)', async () => {
    // B was handed to the viewer while the source was shown; the viewer keeps showing it across the switches.
    history.noteViewerPushed(B)
    await workspace.copyThreadWorkspace('src', 'dst')
    threads.useThreads.setState({ activeThreadId: 'dst' })
    history.recordViewerPosition(B, { kind: 'line', value: 7 })
    expect(viewerOf('dst')?.positions?.[B]).toEqual({ kind: 'line', value: 7 })
    expect(viewerOf('src')?.positions?.[B]).toBeUndefined()

    // Back to the source with the same file still on screen (not handed over again): its scrolling stays its own.
    threads.useThreads.setState({ activeThreadId: 'src' })
    history.recordViewerPosition(B, { kind: 'line', value: 300 })
    expect(viewerOf('src')?.positions?.[B]).toEqual({ kind: 'line', value: 300 })
    expect(viewerOf('dst')?.positions?.[B]).toEqual({ kind: 'line', value: 7 })
  })

  it('two ordinary conversations showing the same file each keep their own position (the old quirk is gone)', async () => {
    store.useStore.getState().setViewerHistory('other', visit(EMPTY_HISTORY, B))
    history.noteViewerPushed(B) // handed over while 'src' was shown
    threads.useThreads.setState({ activeThreadId: 'other' })
    history.recordViewerPosition(B, { kind: 'line', value: 55 })
    expect(viewerOf('other')?.positions?.[B]).toEqual({ kind: 'line', value: 55 })
    expect(viewerOf('src')?.positions?.[B]).toBeUndefined()
  })

  it("the previous file's last report still goes to the conversation it was handed over in", async () => {
    history.noteViewerPushed(A) // A was on screen in 'src' before
    store.useStore.setState({ selectedUri: B })
    threads.useThreads.setState({ activeThreadId: 'dst' })
    store.useStore.getState().setViewerHistory('dst', visit(EMPTY_HISTORY, A))
    // The viewer sends A's last position when the next resource arrives, after the switch.
    history.recordViewerPosition(A, { kind: 'line', value: 9 })
    expect(viewerOf('src')?.positions?.[A]).toEqual({ kind: 'line', value: 9 })
    expect(viewerOf('dst')?.positions).toBeUndefined()
  })

  it('a source with nothing remembered leaves the new conversation empty and writes nothing', async () => {
    threads.useThreads.setState({
      threadsById: { other: { thread: { id: 'other', lastViewerUri: null, lastViewerHighlight: null } } } as never
    })
    expect(await workspace.copyThreadWorkspace('other', 'dst')).toEqual([])
    vi.advanceTimersByTime(400)
    expect(viewerOf('dst')).toBeUndefined()
    expect(filerOf('dst')).toBeUndefined()
    expect(threads.useThreads.getState().dismissedSelections['dst']).toBeUndefined()
    expect(setViewerState).not.toHaveBeenCalled()
    expect(setViewerHistory.mock.calls.some(([id]) => id === 'dst')).toBe(false)
  })
})

describe('threadStore.handoff runs the copy before opening the new conversation', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function setup(): Promise<{
    threads: typeof import('../src/renderer/src/threadStore.js')
    order: string[]
  }> {
    const order: string[] = []
    ;(window as unknown as { aios: unknown }).aios = {
      threads: { handoff: vi.fn(async () => ({ id: 'dst', forkOrigin: { handoff: true } })) }
    }
    const threads = await import('../src/renderer/src/threadStore.js')
    threads.useThreads.setState({
      drafts: {},
      selectThread: vi.fn(async (id: string) => {
        order.push(`open:${id}`)
      })
    } as never)
    return { threads, order }
  }

  it('beforeOpen gets the new id and finishes before the conversation is opened', async () => {
    const { threads, order } = await setup()
    const ok = await threads.useThreads.getState().handoff('src', async (id) => {
      await Promise.resolve()
      order.push(`copy:${id}`)
    })
    expect(ok).toBe(true)
    expect(order).toEqual(['copy:dst', 'open:dst'])
  })

  it('a failing copy does not stop the opening', async () => {
    const { threads, order } = await setup()
    const ok = await threads.useThreads.getState().handoff('src', async () => {
      throw new Error('boom')
    })
    expect(ok).toBe(true)
    expect(order).toEqual(['open:dst'])
  })
})

describe('the handoff keeps the screen as it was (review Y)', () => {
  const F = 'file:///work/f.md'
  let root: Root
  let container: HTMLDivElement
  let setViewerState: ReturnType<typeof vi.fn>
  let store: typeof import('../src/renderer/src/store.js')
  let threads: typeof import('../src/renderer/src/threadStore.js')
  let workspace: typeof import('../src/renderer/src/thread-workspace.js')

  beforeEach(async () => {
    vi.resetModules()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    setViewerState = vi.fn(async () => undefined)
    ;(window as unknown as { aios: unknown }).aios = {
      threads: { setViewerState, viewerHistory: vi.fn(async () => null), setViewerHistory: vi.fn(async () => undefined) },
      viewer: {
        onCommand: () => () => {},
        replyCommand: vi.fn(async () => undefined),
        reportShown: vi.fn(async () => undefined),
        reportDraft: vi.fn(async () => undefined)
      },
      fs: { stat: vi.fn(async () => ({})) }
    }
    store = await import('../src/renderer/src/store.js')
    threads = await import('../src/renderer/src/threadStore.js')
    workspace = await import('../src/renderer/src/thread-workspace.js')
    const { useViewerMemory } = await import('../src/renderer/src/viewerMemory.js')
    const row = (id: string, uri: string | null): unknown => ({ thread: { id, lastViewerUri: uri, lastViewerHighlight: null } })
    threads.useThreads.setState({
      activeThreadId: 'src',
      threadsById: { src: row('src', F), dst: row('dst', null), other: row('other', C) } as never,
      dismissedSelections: {}
    })
    store.useStore.setState({
      selectedUri: F,
      highlightQuery: null,
      transient: null,
      results: null,
      viewerHistories: {},
      reveal: vi.fn(async () => undefined)
    } as never)
    function Host(): null {
      useViewerMemory()
      return null
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(Host)))
    // Then the user opened a blank Web tab (never remembered: the source's memory stays F).
    store.useStore.setState({ selectedUri: WEB_BLANK_URL })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function switchTo(threadId: string): Promise<void> {
    await act(async () => {
      threads.useThreads.setState({ activeThreadId: threadId })
      await Promise.resolve()
    })
  }

  it('a blank Web tab on screen stays on screen; the remembered file is copied as the memory only', async () => {
    await workspace.copyThreadWorkspace('src', 'dst')
    await switchTo('dst')
    expect(store.useStore.getState().selectedUri).toBe(WEB_BLANK_URL)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(setViewerState).toHaveBeenCalledWith('dst', F, null)
    // Only the switch right after the handoff keeps the screen: an ordinary switch restores the memory as before.
    await switchTo('other')
    expect(store.useStore.getState().selectedUri).toBe(C)
  })

  it('what is on screen is copied, not an older memory', async () => {
    store.useStore.setState({ selectedUri: A, highlightQuery: 'q' })
    await workspace.copyThreadWorkspace('src', 'dst')
    await switchTo('dst')
    expect(store.useStore.getState().selectedUri).toBe(A)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(setViewerState).toHaveBeenCalledWith('dst', A, 'q')
  })
})
