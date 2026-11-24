// @vitest-environment jsdom
/**
 * TODO 1326: a Web tab shown by one conversation is closed while another conversation is in front (the tab row is per window,
 * the viewer's memory and history are per conversation). Coming back to the first conversation must not load the closed page
 * into some other tab: it shows its own history's pick (an earlier step still open, else a later one, else nothing), the same
 * rule as closing the tab in front.
 *
 * The memory's writer is module state, so each test uses its own conversations. The real `useViewerMemory` runs (the restore on a conversation switch happens in its effect); `window.aios` is faked. Neither
 * the model nor main is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useViewerMemory } from '../src/renderer/src/viewerMemory.js'
import { closeWebTab, isClosedWebPage, openWebUrl, resetClosedWebPagesForTest, useWeb } from '../src/renderer/src/webStore.js'
import { CLOSED_WEB_PAGES_LIMIT, ClosedWebPages } from '../src/renderer/src/closed-web-pages.js'
import type { ViewerHistory } from '../src/renderer/src/viewer-history.js'
import type { Thread, ThreadSummary } from '../src/shared/thread.js'
import { EMPTY_WEB_TABS, WEB_BLANK_URL, type WebTab, type WebTabsState } from '../src/shared/web-tabs.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FILE = 'file:///Users/me/notes.md'
const OTHER_FILE = 'file:///Users/me/other.md'
const P = 'https://p.example/'
const Q = 'https://q.example/'

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

describe('closing a tab another conversation shows (TODO 1326)', () => {
  let container: HTMLDivElement
  let root: Root
  let closeResult: WebTabsState
  const loads: string[] = []
  const remembered: [string, string | null][] = []

  function Host(): null {
    useViewerMemory()
    return null
  }

  beforeEach(async () => {
    resetClosedWebPagesForTest()
    loads.length = 0
    remembered.length = 0
    closeResult = { tabs: [tab('tq', Q)], activeId: null }
    vi.stubGlobal('aios', {
      threads: {
        setViewerState: vi.fn(async (threadId: string, uri: string | null) => {
          remembered.push([threadId, uri])
        }),
        // Nothing stored: the history in memory stays (adoptStored keeps the current one).
        viewerHistory: vi.fn(async () => null),
        setViewerHistory: vi.fn(async () => undefined)
      },
      viewer: {
        onCommand: () => () => {},
        replyCommand: vi.fn(async () => undefined),
        reportShown: vi.fn(async () => undefined),
        reportDraft: vi.fn(async () => undefined)
      },
      web: {
        load: vi.fn(async (url: string) => {
          loads.push(url)
          return true
        }),
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

  async function switchTo(threadId: string): Promise<void> {
    await act(async () => {
      useThreads.setState({ activeThreadId: threadId })
      await Promise.resolve()
    })
    // The read-back of the history and the settle after it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it("coming back shows that conversation's earlier view, not the closed page", async () => {
    useThreads.setState({
      threadsById: { a: summary('a', OTHER_FILE), b: summary('b', P) }
    } as never)
    useStore.setState({ viewerHistories: { a: history([OTHER_FILE]), b: history([FILE, P]) } })
    await switchTo('a')
    expect(useStore.getState().selectedUri).toBe(OTHER_FILE)
    // While a is in front, P (shown by b) is closed from the Sidebar: a's screen stays.
    await act(async () => closeWebTab('tp'))
    expect(useStore.getState().selectedUri).toBe(OTHER_FILE)
    await switchTo('b')
    expect(useStore.getState().selectedUri).toBe(FILE)
    expect(useStore.getState().viewerHistories.b?.entries.map((e) => e.uri)).toEqual([FILE])
    expect(loads).not.toContain(P)
  })

  it('shows nothing (and remembers that) when its history has nothing else open - not the window\'s other tab', async () => {
    useThreads.setState({
      threadsById: { a2: summary('a2', OTHER_FILE), b2: summary('b2', P) }
    } as never)
    useStore.setState({ viewerHistories: { a2: history([OTHER_FILE]), b2: history([P]) } })
    await switchTo('a2')
    await act(async () => closeWebTab('tp'))
    await switchTo('b2')
    expect(useStore.getState().selectedUri).toBeNull()
    expect(loads).toEqual([])
    // b's memory is written as "nothing" after the 300 ms throttle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(remembered).toContainEqual(['b2', null])
  })

  it('a remembered page that merely has no tab in this window (never closed here) is restored as before (TODO 812)', async () => {
    useThreads.setState({ threadsById: { c: summary('c', 'https://r.example/') } } as never)
    await switchTo('c')
    expect(useStore.getState().selectedUri).toBe('https://r.example/')
  })

  it('review Y1: a closed page reopened in another conversation is no longer "closed" after its tab moves on (TODO 812)', async () => {
    useThreads.setState({
      threadsById: { a3: summary('a3', P), b3: summary('b3', OTHER_FILE), c3: summary('c3', 'https://y.example/') }
    } as never)
    useStore.setState({ viewerHistories: { a3: history([P]), b3: history([OTHER_FILE]), c3: history(['https://y.example/']) } })
    await switchTo('a3')
    expect(useStore.getState().selectedUri).toBe(P)
    // a3 closes P with ⌘W (the tab in front): nothing else in its history, so the empty state.
    await act(async () => closeWebTab('tp'))
    expect(useStore.getState().selectedUri).toBeNull()
    expect(isClosedWebPage(P)).toBe(true)
    // b3 opens P from a link in its answer (a new tab); main makes the new tab current.
    await switchTo('b3')
    await act(async () => openWebUrl(P, true))
    await act(async () => useWeb.setState({ tabs: { tabs: [tab('tq', Q), tab('tn', P)], activeId: 'tn' } }))
    expect(isClosedWebPage(P)).toBe(false)
    // c3's restore loads its page into the current tab (main's willLoad rewrites tn's URL).
    await switchTo('c3')
    await act(async () => useWeb.setState({ tabs: { tabs: [tab('tq', Q), tab('tn', 'https://y.example/')], activeId: 'tn' } }))
    // Back to b3: P is its page and was opened since the close, so it is restored (loaded again), not settled away.
    await switchTo('b3')
    expect(useStore.getState().selectedUri).toBe(P)
  })
})

describe('ClosedWebPages (TODO 1326 review Y1)', () => {
  const X = 'https://x.example/page'
  const tabs = (...urls: string[]): WebTabsState => ({
    tabs: urls.map((url, i) => tab(`t${i}`, url)),
    activeId: null
  })

  it('marks a page only while no tab shows it, and forgets it once a tab shows it again (ignoring #)', () => {
    const closed = new ClosedWebPages()
    closed.note(X, tabs(Q))
    expect(closed.has(X, tabs(Q))).toBe(true)
    expect(closed.has(`${X}#part`, tabs(Q))).toBe(true)
    // A tab shows it again: no longer closed, even after that tab moves on to another page.
    closed.forgetShown(tabs(Q, `${X}#top`))
    expect(closed.has(X, tabs(Q))).toBe(false)
    // Showing it (`show`) forgets it too.
    closed.note(X, tabs(Q))
    closed.forget(X)
    expect(closed.size).toBe(0)
  })

  it('is not marked when another tab of the window still shows the page; files and blank tabs never are', () => {
    const closed = new ClosedWebPages()
    closed.note(X, tabs(X))
    closed.note(WEB_BLANK_URL, EMPTY_WEB_TABS)
    closed.note('file:///tmp/a.md', EMPTY_WEB_TABS)
    expect(closed.size).toBe(0)
  })

  it('stays bounded: the oldest mark goes first, and noting a page again moves it to the newest', () => {
    const closed = new ClosedWebPages(3)
    for (const n of [1, 2, 3]) closed.note(`https://n${n}.example/`, EMPTY_WEB_TABS)
    closed.note('https://n1.example/', EMPTY_WEB_TABS)
    closed.note('https://n4.example/', EMPTY_WEB_TABS)
    expect(closed.size).toBe(3)
    expect(closed.has('https://n2.example/', EMPTY_WEB_TABS)).toBe(false)
    expect(closed.has('https://n1.example/', EMPTY_WEB_TABS)).toBe(true)
    expect(new ClosedWebPages().size).toBe(0)
    expect(CLOSED_WEB_PAGES_LIMIT).toBe(64)
  })
})
