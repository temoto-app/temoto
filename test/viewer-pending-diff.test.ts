// @vitest-environment jsdom
/**
 * TODO 1338 (review Y): an `openDiff` that waited in main while no window showed the conversation is pulled by the window **after
 * its viewer restore has settled** - the synchronous `select` of the remembered view, and the asynchronous settling of a Web page
 * whose tab was closed (`settleClosedWebView`, which awaits the history read-back and then `select`s, closing any temporary view).
 *
 * The real `useViewerMemory` runs; `window.aios` is faked. The fakes answer in two steps (the screen is redrawn first, the reply
 * comes a little later), never synchronously. Neither the model nor main is used. Module state (the history read-back) is per
 * conversation, so each test uses its own conversation ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useViewerMemory } from '../src/renderer/src/viewerMemory.js'
import { closeWebTab, resetClosedWebPagesForTest, useWeb } from '../src/renderer/src/webStore.js'
import type { ViewerHistory } from '../src/renderer/src/viewer-history.js'
import type { DiffPayload } from '../src/shared/plugin.js'
import type { PendingViewerDiff, Thread, ThreadSummary, ViewerCommand } from '../src/shared/thread.js'
import type { WebTab, WebTabsState } from '../src/shared/web-tabs.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FILE = 'file:///Users/me/notes.md'
const OTHER_FILE = 'file:///Users/me/other.md'
const P = 'https://p.example/'
const Q = 'https://q.example/'

const DIFF: DiffPayload = {
  kind: 'diff',
  before: { name: 'HEAD:a.ts', text: 'const a = 1\n', language: null },
  after: { name: 'a.ts', text: 'const a = 2\n', language: null },
  layout: 'split'
}
const PUSHED: DiffPayload = { ...DIFF, after: { name: 'b.ts', text: 'const b = 2\n', language: null } }

function summary(id: string, uri: string | null): ThreadSummary {
  const thread = { id, lastViewerUri: uri, lastViewerHighlight: null } as unknown as Thread
  return { thread, runtime: {} as ThreadSummary['runtime'], preview: null }
}

function tab(id: string, url: string): WebTab {
  return { id, url, title: '', favicon: null }
}

function history(uris: readonly string[]): ViewerHistory {
  return { entries: uris.map((uri) => ({ uri, highlight: null, at: 0, byKeys: false })), index: uris.length - 1 }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A promise the test settles by hand (the "arrives a little later" step). */
function later<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('pulling the waiting openDiff after the viewer restore (TODO 1338 review Y)', () => {
  let container: HTMLDivElement
  let root: Root
  let closeResult: WebTabsState
  /** What the screen showed when the window asked main for the waiting diff. */
  let asked: { threadId: string; selectedUri: string | null }[]
  let shown: [string, number][]
  let waiting: Record<string, PendingViewerDiff>
  /** Hold the history read-back of these conversations until the test releases it. */
  let readBack: Map<string, ReturnType<typeof later<null>>>
  let command: ((command: ViewerCommand) => void) | null

  function Host(): null {
    useViewerMemory()
    return null
  }

  beforeEach(async () => {
    resetClosedWebPagesForTest()
    asked = []
    shown = []
    waiting = {}
    readBack = new Map()
    command = null
    closeResult = { tabs: [tab('tq', Q)], activeId: null }
    vi.stubGlobal('aios', {
      threads: {
        setViewerState: vi.fn(async () => undefined),
        viewerHistory: vi.fn(async (threadId: string) => {
          const held = readBack.get(threadId)
          return held === undefined ? null : held.promise
        }),
        setViewerHistory: vi.fn(async () => undefined)
      },
      viewer: {
        onCommand: (listener: (command: ViewerCommand) => void) => {
          command = listener
          return () => {
            command = null
          }
        },
        replyCommand: vi.fn(async () => undefined),
        reportShown: vi.fn(async () => undefined),
        reportDraft: vi.fn(async () => undefined),
        // Main's answer comes on a later turn, not synchronously.
        pendingDiff: vi.fn(async (threadId: string) => {
          asked.push({ threadId, selectedUri: useStore.getState().selectedUri })
          await sleep(5)
          return waiting[threadId] ?? null
        }),
        pendingDiffShown: vi.fn(async (threadId: string, generation: number) => {
          shown.push([threadId, generation])
        })
      },
      web: {
        load: vi.fn(async () => true),
        activateTab: vi.fn(async () => closeResult),
        newTab: vi.fn(async () => closeResult),
        closeTab: vi.fn(async () => closeResult)
      }
    })
    useWeb.setState({ tabs: { tabs: [tab('tp', P), tab('tq', Q)], activeId: 'tp' } })
    useStore.setState({
      selectedUri: null,
      transient: null,
      results: null,
      viewerDirty: false,
      viewerFolded: false,
      viewerHistories: {},
      reveal: vi.fn(async () => undefined)
    } as never)
    useThreads.setState({ activeThreadId: null, threadsById: {} } as never)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(Host)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    resetClosedWebPagesForTest()
  })

  /** The redraw: the conversation changes and its effects run. Replies from main are not awaited here. */
  async function switchTo(threadId: string): Promise<void> {
    await act(async () => {
      useThreads.setState({ activeThreadId: threadId })
      await Promise.resolve()
    })
  }

  /** Lets the fakes' later replies arrive. */
  async function settle(ms = 20): Promise<void> {
    await act(async () => {
      await sleep(ms)
    })
  }

  it('asks only after the synchronous restore, shows the diff over the restored file, then confirms it', async () => {
    useThreads.setState({ threadsById: { s1: summary('s1', FILE) } } as never)
    waiting = { s1: { generation: 5, diff: DIFF } }
    await switchTo('s1')
    expect(asked).toEqual([{ threadId: 's1', selectedUri: FILE }])
    // Not yet shown: the answer is still on its way.
    expect(useStore.getState().transient).toBeNull()
    expect(shown).toEqual([])
    await settle()
    expect(useStore.getState().transient).toMatchObject({ kind: 'diff', after: { name: 'a.ts' } })
    expect(useStore.getState().selectedUri).toBe(FILE)
    expect(shown).toEqual([['s1', 5]])
  })

  it('with nothing waiting it shows nothing and confirms nothing', async () => {
    useThreads.setState({ threadsById: { s2: summary('s2', FILE) } } as never)
    await switchTo('s2')
    await settle()
    expect(asked).toHaveLength(1)
    expect(useStore.getState().transient).toBeNull()
    expect(shown).toEqual([])
  })

  it('a closed Web page: asks only after its asynchronous settling, so the settling cannot erase the diff', async () => {
    useThreads.setState({ threadsById: { a1: summary('a1', OTHER_FILE), b1: summary('b1', P) } } as never)
    useStore.setState({ viewerHistories: { a1: history([OTHER_FILE]), b1: history([FILE, P]) } })
    await switchTo('a1')
    await settle()
    // While a1 is in front, P (b1's page) is closed; then b1 is opened and its history read-back is slow.
    await act(async () => closeWebTab('tp'))
    const slow = later<null>()
    readBack.set('b1', slow)
    waiting = { b1: { generation: 9, diff: DIFF } }
    asked = []
    await switchTo('b1')
    await settle(30)
    // Still settling (the read-back has not come back): main was not asked yet.
    expect(useStore.getState().selectedUri).toBeNull()
    expect(asked).toEqual([])
    await act(async () => slow.resolve(null))
    await settle()
    // Settled on the earlier step of b1's history, and only then asked: the diff stays in front.
    expect(asked).toEqual([{ threadId: 'b1', selectedUri: FILE }])
    expect(useStore.getState().selectedUri).toBe(FILE)
    expect(useStore.getState().transient).toMatchObject({ kind: 'diff' })
    expect(shown).toEqual([['b1', 9]])
  })

  it('if the conversation changes while asking, the diff is not shown and not confirmed (it keeps waiting in main)', async () => {
    useThreads.setState({ threadsById: { c1: summary('c1', FILE), c2: summary('c2', OTHER_FILE) } } as never)
    waiting = { c1: { generation: 3, diff: DIFF } }
    await switchTo('c1')
    expect(asked.map((a) => a.threadId)).toEqual(['c1'])
    await switchTo('c2')
    await settle()
    expect(useThreads.getState().activeThreadId).toBe('c2')
    expect(useStore.getState().transient).toBeNull()
    expect(shown).toEqual([])
  })

  it('leaving and coming back while asking: the first answer is not shown, the second opening shows and confirms it once', async () => {
    useThreads.setState({ threadsById: { d1: summary('d1', FILE), d2: summary('d2', OTHER_FILE) } } as never)
    waiting = { d1: { generation: 4, diff: DIFF } }
    await switchTo('d1')
    await switchTo('d2')
    await switchTo('d1')
    await settle()
    expect(asked.map((a) => a.threadId)).toEqual(['d1', 'd2', 'd1'])
    expect(useStore.getState().transient).toMatchObject({ kind: 'diff' })
    expect(shown).toEqual([['d1', 4]])
  })

  it("main's diff command goes through the same display: shown at once when settled, held during a restore until it settles", async () => {
    useThreads.setState({ threadsById: { e1: summary('e1', OTHER_FILE), e2: summary('e2', P) } } as never)
    useStore.setState({ viewerHistories: { e1: history([OTHER_FILE]), e2: history([FILE, P]) } })
    await switchTo('e1')
    await settle()
    // Settled: shown at once, the same as a pulled one.
    act(() => command?.({ kind: 'diff', threadId: 'e1', diff: PUSHED }))
    expect(useStore.getState().transient).toMatchObject({ kind: 'diff', after: { name: 'b.ts' } })
    // Another conversation's diff is ignored.
    act(() => command?.({ kind: 'diff', threadId: 'e2', diff: DIFF }))
    expect(useStore.getState().transient).toMatchObject({ after: { name: 'b.ts' } })

    // e2's remembered page was closed: its restore settles asynchronously. A diff command for e2 that arrives meanwhile is held.
    await act(async () => closeWebTab('tp'))
    const slow = later<null>()
    readBack.set('e2', slow)
    await switchTo('e2')
    act(() => command?.({ kind: 'diff', threadId: 'e2', diff: PUSHED }))
    expect(useStore.getState().transient).toBeNull()
    await act(async () => slow.resolve(null))
    await settle()
    expect(useStore.getState().selectedUri).toBe(FILE)
    expect(useStore.getState().transient).toMatchObject({ kind: 'diff', after: { name: 'b.ts' } })
    // A pushed diff is not a waiting one: nothing to confirm.
    expect(shown).toEqual([])
  })

  it('a diff held during a restore is dropped by a later open of the same conversation (no older diff on top of a newer file)', async () => {
    useThreads.setState({ threadsById: { f1: summary('f1', OTHER_FILE), f2: summary('f2', P) } } as never)
    useStore.setState({ viewerHistories: { f1: history([OTHER_FILE]), f2: history([FILE, P]) } })
    await switchTo('f1')
    await settle()
    await act(async () => closeWebTab('tp'))
    const slow = later<null>()
    readBack.set('f2', slow)
    await switchTo('f2')
    act(() => command?.({ kind: 'diff', threadId: 'f2', diff: PUSHED }))
    act(() => command?.({ kind: 'open', threadId: 'f2', uri: OTHER_FILE, highlight: null }))
    await act(async () => slow.resolve(null))
    await settle()
    expect(useStore.getState().selectedUri).toBe(OTHER_FILE)
    expect(useStore.getState().transient).toBeNull()
  })
})
