// @vitest-environment jsdom
/**
 * TODO 1327: the window layout (which panes a window hides). VS Code's Toggle Primary / Secondary Side Bar; in aios the secondary
 * one is ViewerPane.
 *
 * - The value crossing IPC is re-validated (`parseWindowLayout`).
 * - Main keeps one layout per window (`WindowLayouts`): independent windows, a new window starts from the default.
 * - The quit record carries it and the launch brings it back (`snapshotSession` -> `window.bounds` -> `planRestore`).
 * - The renderer: main's value goes in before the first render, every change is reported once, hiding moves the focus to the prompt box.
 * - Whether the viewer is on screen (hidden, or folded to the strip of a narrow window) is reported next to the layout, never stored
 *   with it; the viewer toggle opens a folded viewer instead of hiding it (review of TODO 1327).
 * - A hidden viewer comes back when something is opened in it, not on a conversation switch (the restore).
 * - The title bar buttons show the state (filled column, `aria-pressed`).
 *
 * Neither the model nor main is used; only `window.aios` is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_WINDOW_LAYOUT, parseWindowLayout, sameWindowLayout } from '../src/shared/window-layout.js'
import { WindowLayouts, planRestore, snapshotSession } from '../src/main/windows.js'
import { WINDOW_BOUNDS } from '../src/common/settings-keys.js'
import {
  LAYOUT_PANE_SELECTOR,
  applyWindowLayout,
  currentWindowLayout,
  focusLeavesWith,
  installWindowLayoutReport,
  isViewerHidden,
  isViewerShown,
  moveFocusOutOf,
  setViewerFits,
  setViewerHidden,
  toggleSidebarLayout,
  toggleViewerLayout
} from '../src/renderer/src/windowLayout.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useStore } from '../src/renderer/src/store.js'
import { useViewerMemory } from '../src/renderer/src/viewerMemory.js'
import { useUnfoldOnOpen } from '../src/renderer/src/viewerUnfold.js'
import { LayoutToggles } from '../src/renderer/src/components/LayoutToggles.js'
import type { Thread, ThreadSummary, ViewerCommand } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OK = { x: 100, y: 80, width: 1200, height: 800 }
const B = { x: 140, y: 120, width: 1000, height: 700 }
const ONE_DISPLAY = [{ x: 0, y: 0, width: 1600, height: 1000 }]

describe('parseWindowLayout (the value from the renderer)', () => {
  it('takes exactly two booleans; anything else is null', () => {
    expect(parseWindowLayout({ sidebarHidden: true, viewerHidden: false })).toEqual({ sidebarHidden: true, viewerHidden: false })
    expect(parseWindowLayout({ sidebarHidden: true, viewerHidden: false, extra: 1 })).toEqual({ sidebarHidden: true, viewerHidden: false })
    for (const bad of [null, undefined, 1, 'x', {}, { sidebarHidden: 1, viewerHidden: false }, { sidebarHidden: true }]) {
      expect(parseWindowLayout(bad)).toBeNull()
    }
    expect(sameWindowLayout(DEFAULT_WINDOW_LAYOUT, { sidebarHidden: false, viewerHidden: false })).toBe(true)
  })
})

describe('WindowLayouts (per window in main)', () => {
  it('each window has its own; an unknown (new) window is the default; closing forgets it', () => {
    const layouts = new WindowLayouts()
    layouts.set(1, { sidebarHidden: true, viewerHidden: false })
    layouts.set(2, { sidebarHidden: false, viewerHidden: true })
    expect(layouts.get(1)).toEqual({ sidebarHidden: true, viewerHidden: false })
    expect(layouts.get(2)).toEqual({ sidebarHidden: false, viewerHidden: true })
    expect(layouts.get(3)).toEqual(DEFAULT_WINDOW_LAYOUT)
    layouts.forget(1)
    expect(layouts.get(1)).toEqual(DEFAULT_WINDOW_LAYOUT)
    layouts.set(2, DEFAULT_WINDOW_LAYOUT)
    expect(layouts.get(2)).toEqual(DEFAULT_WINDOW_LAYOUT)
  })

  it('whether the viewer is on screen is kept apart from the layout, and forgotten with the window', () => {
    const layouts = new WindowLayouts()
    // Before a report: what the user chose says it (a restored window with the viewer hidden starts silent).
    layouts.set(1, { sidebarHidden: false, viewerHidden: true })
    expect(layouts.viewerShown(1)).toBe(false)
    expect(layouts.viewerShown(2)).toBe(true)
    // A narrow window folds a viewer the user did not hide: not on screen, and the remembered layout is untouched.
    layouts.set(2, DEFAULT_WINDOW_LAYOUT)
    layouts.setViewerShown(2, false)
    expect(layouts.get(2)).toEqual(DEFAULT_WINDOW_LAYOUT)
    expect(layouts.checks(2)).toEqual({ sidebar: true, viewer: false })
    layouts.setViewerShown(2, true)
    expect(layouts.checks(2)).toEqual({ sidebar: true, viewer: true })
    layouts.setViewerShown(2, false)
    layouts.forget(2)
    expect(layouts.viewerShown(2)).toBe(true)
    expect(layouts.checks(2)).toEqual({ sidebar: true, viewer: true })
  })
})

describe('quit record and restore (item 36 + TODO 1327)', () => {
  it('records only the hidden panes, on restore elements; a round trip brings each window back with its own layout', () => {
    const snapshot = snapshotSession(
      [],
      [
        { bounds: OK, threadId: 't1', focused: false, maximized: false, layout: { sidebarHidden: true, viewerHidden: true } },
        { bounds: B, threadId: 't2', focused: true, maximized: false, layout: DEFAULT_WINDOW_LAYOUT }
      ]
    )
    const restore = snapshot.filter((state) => state.restore === true)
    expect(restore).toEqual([
      { ...OK, restore: true, threadId: 't1', sidebarHidden: true, viewerHidden: true },
      { ...B, restore: true, threadId: 't2' }
    ])
    // The closed-window positions never carry a layout (a new window starts with both shown).
    for (const closed of snapshot.filter((state) => state.restore !== true)) {
      expect(Object.keys(closed).sort()).toEqual(['height', 'width', 'x', 'y'])
    }
    const saved = WINDOW_BOUNDS.parse(WINDOW_BOUNDS.serialize(snapshot))
    expect(planRestore({ saved, displays: ONE_DISPLAY, threadExists: () => true })).toEqual([
      { bounds: OK, threadId: 't1', maximized: false, layout: { sidebarHidden: true, viewerHidden: true } },
      { bounds: B, threadId: 't2', maximized: false }
    ])
  })

  it('a broken stored flag is the default, and a flag on a closed window is dropped', () => {
    const raw = JSON.stringify([
      { ...OK, restore: true, viewerHidden: 'yes', sidebarHidden: true },
      { ...B, viewerHidden: true }
    ])
    const saved = WINDOW_BOUNDS.parse(raw)
    expect(saved).toEqual([{ ...OK, restore: true, sidebarHidden: true }, B])
  })
})

describe('the renderer side (windowLayout.ts)', () => {
  beforeEach(() => {
    useThreads.setState({ sidebarCollapsed: false, activeThreadId: null, composerFocus: null } as never)
    setViewerHidden(false)
    setViewerFits(true)
    document.body.innerHTML = ''
  })

  it("puts main's value in place, reports it once at once (main may hold a reloaded renderer's old state), then each real change", () => {
    applyWindowLayout({ sidebarHidden: true, viewerHidden: true })
    expect(useThreads.getState().sidebarCollapsed).toBe(true)
    expect(isViewerHidden()).toBe(true)
    const sent: unknown[] = []
    const stop = installWindowLayoutReport((layout, shown) => sent.push([layout, shown]), currentWindowLayout())
    expect(sent).toEqual([[{ sidebarHidden: true, viewerHidden: true }, false]])
    useThreads.setState({ activeThreadId: 'x' } as never)
    setViewerHidden(true)
    expect(sent).toHaveLength(1)
    setViewerHidden(false)
    useThreads.getState().toggleSidebar()
    expect(sent.slice(1)).toEqual([
      [{ sidebarHidden: true, viewerHidden: false }, true],
      [{ sidebarHidden: false, viewerHidden: false }, true]
    ])
    stop()
    setViewerHidden(true)
    expect(sent).toHaveLength(3)
  })

  it('a narrow window folding the viewer to its strip is reported as not on screen, with the layout unchanged', () => {
    const sent: unknown[] = []
    const stop = installWindowLayoutReport((layout, shown) => sent.push([layout, shown]), currentWindowLayout())
    sent.length = 0
    setViewerFits(false)
    expect(isViewerShown()).toBe(false)
    expect(sent).toEqual([[DEFAULT_WINDOW_LAYOUT, false]])
    // Hiding it while folded changes the layout only; it was already off the screen.
    setViewerHidden(true)
    expect(sent.at(-1)).toEqual([{ sidebarHidden: false, viewerHidden: true }, false])
    setViewerHidden(false)
    setViewerFits(true)
    expect(sent.at(-1)).toEqual([DEFAULT_WINDOW_LAYOUT, true])
    expect(sent).toHaveLength(4)
    stop()
  })

  it('the viewer toggle opens a viewer folded to the strip (as the strip does) instead of only clearing it', () => {
    const expand = vi.fn(() => setViewerHidden(false))
    // Folded by a narrow window: the first press opens it.
    toggleViewerLayout(false, expand)
    expect(expand).toHaveBeenCalledTimes(1)
    expect(isViewerHidden()).toBe(false)
    // Hidden by the user (room or not): opens.
    setViewerHidden(true)
    toggleViewerLayout(true, expand)
    expect(expand).toHaveBeenCalledTimes(2)
    expect(isViewerHidden()).toBe(false)
    // On screen: hides.
    toggleViewerLayout(true, expand)
    expect(expand).toHaveBeenCalledTimes(2)
    expect(isViewerHidden()).toBe(true)
  })

  it('the focus leaves with the hidden pane (inside it or nowhere), not from elsewhere', () => {
    document.body.innerHTML =
      '<header><button id="toggle">t</button></header><div class="sidebar-panel"><input id="in-sidebar"></div>' +
      '<div class="viewer-pane"><iframe id="frame"></iframe></div>'
    expect(focusLeavesWith(LAYOUT_PANE_SELECTOR.viewer, document)).toBe(true)
    ;(document.getElementById('toggle') as HTMLButtonElement).focus()
    expect(focusLeavesWith(LAYOUT_PANE_SELECTOR.viewer, document)).toBe(false)
    ;(document.getElementById('frame') as HTMLIFrameElement).focus()
    expect(document.activeElement?.id).toBe('frame')
    expect(focusLeavesWith(LAYOUT_PANE_SELECTOR.viewer, document)).toBe(true)
    expect(focusLeavesWith(LAYOUT_PANE_SELECTOR.sidebar, document)).toBe(false)
  })

  it('hiding a pane with the focus in it asks the prompt box of the shown conversation for the focus', () => {
    document.body.innerHTML = '<div class="sidebar-panel"><input id="in-sidebar"></div>'
    useThreads.setState({ activeThreadId: 'c1' } as never)
    ;(document.getElementById('in-sidebar') as HTMLInputElement).focus()
    toggleSidebarLayout()
    expect(useThreads.getState().sidebarCollapsed).toBe(true)
    expect(useThreads.getState().composerFocus).toBe('c1')
    // Showing it again does not move the focus.
    useThreads.setState({ composerFocus: null } as never)
    toggleSidebarLayout()
    expect(useThreads.getState().sidebarCollapsed).toBe(false)
    expect(useThreads.getState().composerFocus).toBeNull()
  })

  it('with no conversation shown, the focus is only taken out of the hidden pane', () => {
    document.body.innerHTML = '<div class="viewer-pane"><input id="in-viewer"></div>'
    const input = document.getElementById('in-viewer') as HTMLInputElement
    input.focus()
    moveFocusOutOf(LAYOUT_PANE_SELECTOR.viewer)
    expect(document.activeElement).not.toBe(input)
    expect(useThreads.getState().composerFocus).toBeNull()
  })
})

describe('a hidden viewer comes back when something is opened, not on a conversation switch', () => {
  const A = 'file:///Users/me/a.md'
  const C = 'file:///Users/me/c.md'
  let container: HTMLDivElement
  let root: Root
  let command: ((command: ViewerCommand) => void) | null = null

  function summary(id: string, uri: string | null): ThreadSummary {
    const thread = { id, lastViewerUri: uri, lastViewerHighlight: null } as unknown as Thread
    return { thread, runtime: {} as ThreadSummary['runtime'], preview: null }
  }

  function Host(): null {
    // Same order and callback as App: the memory first, then the listener that shows the viewer.
    useViewerMemory()
    useUnfoldOnOpen(() => setViewerHidden(false))
    return null
  }

  beforeEach(async () => {
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
        reportShown: vi.fn(async () => undefined),
        reportDraft: vi.fn(async () => undefined)
      },
      web: { load: vi.fn(async () => undefined) }
    })
    useThreads.setState({
      activeThreadId: null,
      threadsById: { w1: summary('w1', A), w2: summary('w2', C) }
    } as never)
    useStore.setState({
      selectedUri: null,
      transient: null,
      results: null,
      viewerDirty: false,
      viewerFolded: false,
      reveal: vi.fn(async () => undefined)
    } as never)
    setViewerHidden(true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(Host)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    setViewerHidden(false)
    vi.unstubAllGlobals()
  })

  async function switchTo(threadId: string): Promise<void> {
    await act(async () => {
      useThreads.setState({ activeThreadId: threadId })
      await Promise.resolve()
    })
  }

  it('switching conversations changes what it holds behind, and keeps it hidden', async () => {
    await switchTo('w1')
    expect(useStore.getState().selectedUri).toBe(A)
    await switchTo('w2')
    expect(useStore.getState().selectedUri).toBe(C)
    expect(isViewerHidden()).toBe(true)
  })

  it("the AI's openFile of the file already behind it shows it again", async () => {
    await switchTo('w1')
    await act(async () => command?.({ kind: 'open', threadId: 'w1', uri: A, highlight: null }))
    expect(isViewerHidden()).toBe(false)
  })

  it('a temporary view (a diff, Help) shows it again', async () => {
    await switchTo('w2')
    act(() => useStore.getState().openHelp('en'))
    expect(isViewerHidden()).toBe(false)
  })
})

describe('LayoutToggles (the title bar buttons)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('says the state with aria-pressed and a filled column, and calls its toggle', () => {
    const onToggleSidebar = vi.fn()
    const onToggleViewer = vi.fn()
    act(() =>
      root.render(
        createElement(LayoutToggles, { sidebarShown: true, viewerShown: false, onToggleSidebar, onToggleViewer })
      )
    )
    const sidebar = container.querySelector('.layout-toggle-sidebar') as HTMLButtonElement
    const viewer = container.querySelector('.layout-toggle-viewer') as HTMLButtonElement
    expect(sidebar.getAttribute('aria-pressed')).toBe('true')
    expect(viewer.getAttribute('aria-pressed')).toBe('false')
    expect(sidebar.querySelectorAll('path[fill="currentColor"]')).toHaveLength(1)
    expect(viewer.querySelectorAll('path[fill="currentColor"]')).toHaveLength(0)
    act(() => viewer.click())
    expect(onToggleViewer).toHaveBeenCalledTimes(1)
    act(() => sidebar.click())
    expect(onToggleSidebar).toHaveBeenCalledTimes(1)
  })
})
