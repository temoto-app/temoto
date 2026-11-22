// @vitest-environment jsdom
/**
 * TODO 1297 review: when a folded ViewerPane opens again by itself (`viewerUnfold.ts`), and what main is told while it is
 * folded (`viewerMemory.ts` + `viewer-shown.ts`).
 *
 * The real `useViewerMemory` runs next to `useUnfoldOnOpen` (in App's order), so the restore on a conversation switch
 * happens inside its own effect, after React commits the new `activeThreadId`, and the "open" requests arrive through the
 * same command listener main uses. Only `window.aios` is faked.
 *
 * - The restore (switching conversations) does not unfold.
 * - Opening the URI already selected (the AI's `openFile`, a link, the same Files row) unfolds; so does a temporary view.
 * - A Web page's own `replace` step does not.
 * - While folded the report to main is `none`; unfolded it is the file again.
 *
 * The memory's writer is module state, so each test uses its own conversation. Neither the model nor main is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useViewerMemory } from '../src/renderer/src/viewerMemory.js'
import { useUnfoldOnOpen, viewerOpenRequested } from '../src/renderer/src/viewerUnfold.js'
import { openWebUrl } from '../src/renderer/src/webStore.js'
import type { Thread, ThreadSummary, ViewerCommand } from '../src/shared/thread.js'
import type { ViewerShownReport } from '../src/shared/viewer-shown.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = 'file:///Users/me/a.md'
const B = 'file:///Users/me/b.md'
const WEB = 'https://example.com/'

function summary(id: string, uri: string | null): ThreadSummary {
  const thread = { id, lastViewerUri: uri, lastViewerHighlight: null } as unknown as Thread
  return { thread, runtime: {} as ThreadSummary['runtime'], preview: null }
}

describe('viewerOpenRequested', () => {
  const transient = { kind: 'help', uri: 'x', nonce: 1 } as never
  it('is a request on every advance of viewerOpens and on a new temporary view, not on closing one', () => {
    expect(viewerOpenRequested({ viewerOpens: 2, transient: null }, { viewerOpens: 1, transient: null })).toBe(true)
    expect(viewerOpenRequested({ viewerOpens: 1, transient }, { viewerOpens: 1, transient: null })).toBe(true)
    expect(viewerOpenRequested({ viewerOpens: 1, transient: null }, { viewerOpens: 1, transient })).toBe(false)
    expect(viewerOpenRequested({ viewerOpens: 1, transient }, { viewerOpens: 1, transient })).toBe(false)
  })
})

describe('useUnfoldOnOpen with the viewer memory', () => {
  let container: HTMLDivElement
  let root: Root
  let command: ((command: ViewerCommand) => void) | null = null
  const reports: (ViewerShownReport | null)[] = []
  const unfold = vi.fn()

  function Host(): null {
    // Same order as App: the memory first, then the unfold listener.
    useViewerMemory()
    useUnfoldOnOpen(unfold)
    return null
  }

  beforeEach(async () => {
    unfold.mockClear()
    reports.length = 0
    command = null
    vi.stubGlobal('aios', {
      threads: { setViewerState: vi.fn(async () => undefined) },
      viewer: {
        onCommand: (listener: (command: ViewerCommand) => void) => {
          command = listener
          return () => {
            command = null
          }
        },
        replyCommand: vi.fn(async () => undefined),
        reportShown: (report: ViewerShownReport | null) => {
          reports.push(report)
          return Promise.resolve()
        },
        reportDraft: vi.fn(async () => undefined)
      },
      web: { load: vi.fn(async () => undefined) }
    })
    useThreads.setState({
      activeThreadId: null,
      threadsById: { u1: summary('u1', A), u2: summary('u2', B), u3: summary('u3', A), u4: summary('u4', A), u5: summary('u5', A), u6: summary('u6', A) }
    } as never)
    useStore.setState({
      selectedUri: null,
      transient: null,
      results: null,
      viewerDirty: false,
      viewerFolded: false,
      reveal: vi.fn(async () => undefined)
    } as never)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(Host)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function switchTo(threadId: string): Promise<void> {
    await act(async () => {
      useThreads.setState({ activeThreadId: threadId })
      await Promise.resolve()
    })
  }

  it('does not unfold for the restore on a conversation switch (startup included)', async () => {
    await switchTo('u1')
    expect(useStore.getState().selectedUri).toBe(A)
    await switchTo('u2')
    expect(useStore.getState().selectedUri).toBe(B)
    expect(unfold).not.toHaveBeenCalled()
  })

  it("unfolds when the AI's openFile asks for the file already shown, after the restore put it there", async () => {
    await switchTo('u1')
    expect(unfold).not.toHaveBeenCalled()
    await act(async () => command?.({ kind: 'open', threadId: 'u1', uri: A, highlight: null }))
    expect(useStore.getState().selectedUri).toBe(A)
    expect(unfold).toHaveBeenCalledTimes(1)
  })

  it('unfolds when the user opens the selected file again (a link, the same Files row), and for a temporary view', async () => {
    await switchTo('u3')
    act(() => useStore.getState().select(A))
    expect(unfold).toHaveBeenCalledTimes(1)
    act(() => useStore.getState().openHelp('en'))
    expect(unfold).toHaveBeenCalledTimes(2)
  })

  it('unfolds when the Web page already shown is opened again (no select happens then)', async () => {
    await switchTo('u6')
    act(() => useStore.getState().select(WEB))
    unfold.mockClear()
    act(() => openWebUrl(WEB, false))
    expect(useStore.getState().selectedUri).toBe(WEB)
    expect(unfold).toHaveBeenCalledTimes(1)
  })

  it("does not unfold for a Web page's own replace step", async () => {
    await switchTo('u4')
    act(() => useStore.getState().select(WEB))
    unfold.mockClear()
    act(() => useStore.getState().select(`${WEB}#part`, { replace: true }))
    expect(unfold).not.toHaveBeenCalled()
  })

  it('tells main nothing is shown while folded, and the file again once unfolded', async () => {
    await switchTo('u5')
    expect(reports.at(-1)).toEqual({ threadId: 'u5', kind: 'file', uri: A })
    act(() => useStore.getState().setViewerFolded(true))
    expect(reports.at(-1)).toEqual({ threadId: 'u5', kind: 'none', uri: null })
    act(() => useStore.getState().setViewerFolded(false))
    expect(reports.at(-1)).toEqual({ threadId: 'u5', kind: 'file', uri: A })
  })
})
