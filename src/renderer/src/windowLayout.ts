/**
 * The window layout (TODO 1327, ARCHITECTURE 5.5.1): whether this window hides its sidebar and its ViewerPane. The same two
 * toggles as VS Code's "Toggle Primary Side Bar" (Cmd+B) and "Toggle Secondary Side Bar" (Alt+Cmd+B), reached from the title bar
 * buttons (`LayoutToggles.tsx`), the View menu and the keys.
 *
 * - **No new state for the sidebar**: hiding it is the existing collapse (`useThreads.sidebarCollapsed`, T27). **The viewer's is
 *   the existing fold** (TODO 1297) moved out of `App.tsx` into this store, so the menu, the buttons and the divider share it.
 * - **Per window** (owner decision 2026-11-27). The values used to sit in `localStorage`, which every window of the profile shares
 *   (a new window inherited whatever another one saved last). Main now keeps them per window (`WindowLayouts`): `app-main.tsx` reads
 *   them before the first render (`applyWindowLayout`), and every change is reported back (`installWindowLayoutReport`).
 * - Hiding moves the keyboard focus out of the pane that goes away, to the prompt box (`moveFocusOutOf`).
 * - **Whether the viewer is on screen now** (`isViewerShown`) is a separate, unremembered value: hidden by the user, or folded to the
 *   strip because the window is too narrow (`viewerFits`, measured by `App.tsx`). The report carries it next to the layout; main mutes
 *   the window's Web pages while it is false and checks View > Viewer with it, and the title bar button shows the same.
 *
 * The viewer coming back by itself when something is opened in it is `viewerUnfold.ts`.
 */
import { create } from 'zustand'
import { DEFAULT_WINDOW_LAYOUT, sameWindowLayout, type WindowLayout } from '@shared/window-layout.js'
import { useThreads } from './threadStore.js'
import { viewerFolded } from './viewer-collapse.js'

interface ViewerLayoutState {
  /** The user hid ViewerPane (the title bar button, Alt+Cmd+B, or dragging the divider to the right edge). */
  readonly viewerHidden: boolean
  /**
   * The window has room for both panes (`viewerFits`); false folds a viewer the user did not hide to its strip. Not part of the
   * layout (never remembered): it follows the window's width. True until `App.tsx` measures.
   */
  readonly viewerFits: boolean
}

export const useViewerLayout = create<ViewerLayoutState>(() => ({
  viewerHidden: DEFAULT_WINDOW_LAYOUT.viewerHidden,
  viewerFits: true
}))

export function isViewerHidden(): boolean {
  return useViewerLayout.getState().viewerHidden
}

export function setViewerHidden(hidden: boolean): void {
  if (useViewerLayout.getState().viewerHidden !== hidden) useViewerLayout.setState({ viewerHidden: hidden })
}

/** `App.tsx` reports whether the window has room for both panes. */
export function setViewerFits(fits: boolean): void {
  if (useViewerLayout.getState().viewerFits !== fits) useViewerLayout.setState({ viewerFits: fits })
}

/** Whether ViewerPane is on screen now: neither hidden by the user nor folded to the strip (`viewerFolded`). */
export function viewerShownOf(state: ViewerLayoutState): boolean {
  return !viewerFolded(state.viewerHidden, state.viewerFits)
}

export function isViewerShown(): boolean {
  return viewerShownOf(useViewerLayout.getState())
}

/** This window's layout now. */
export function currentWindowLayout(): WindowLayout {
  return { sidebarHidden: useThreads.getState().sidebarCollapsed, viewerHidden: isViewerHidden() }
}

/** Puts main's value for this window in place (before the first render, so nothing flickers). */
export function applyWindowLayout(layout: WindowLayout): void {
  if (useThreads.getState().sidebarCollapsed !== layout.sidebarHidden) useThreads.setState({ sidebarCollapsed: layout.sidebarHidden })
  setViewerHidden(layout.viewerHidden)
}

/**
 * Reports the layout, with whether the viewer is on screen now (`isViewerShown`), at once and then on each real change of either.
 * `initial` is what main already has. The first report is not skipped: main may still hold whether the viewer was on screen before a
 * reload of this renderer (and mute the window's pages by it). Returns the unsubscribe.
 */
export function installWindowLayoutReport(
  send: (layout: WindowLayout, viewerShown: boolean) => void,
  initial: WindowLayout
): () => void {
  let last = initial
  let lastShown = isViewerShown()
  send(last, lastShown)
  const report = (): void => {
    const next = currentWindowLayout()
    const shown = isViewerShown()
    if (sameWindowLayout(next, last) && shown === lastShown) return
    last = next
    lastShown = shown
    send(next, shown)
  }
  const stopThreads = useThreads.subscribe(report)
  const stopViewer = useViewerLayout.subscribe(report)
  return () => {
    stopThreads()
    stopViewer()
  }
}

/** The part of the pane each toggle hides (the icon bar stays when the sidebar is hidden). */
export const LAYOUT_PANE_SELECTOR = { sidebar: '.sidebar-panel', viewer: '.viewer-pane' } as const

/**
 * Whether hiding the pane matched by `selector` should move the keyboard focus to the prompt box: the focus is inside it (an iframe
 * viewer counts, its element is the active one), or nowhere in this document (`body`: the focus was in a Web page, a native view main
 * hands back when it hides it, or simply nothing). A focus elsewhere (the title bar button just pressed, another pane) stays.
 */
export function focusLeavesWith(selector: string, doc: Document): boolean {
  const active = doc.activeElement
  if (active === null || active === doc.body || active === doc.documentElement) return true
  return active.closest(selector) !== null
}

/** Moves the focus to the prompt box of the conversation shown, when hiding `selector` would strand it (`focusLeavesWith`). */
export function moveFocusOutOf(selector: string, doc: Document = document): void {
  if (!focusLeavesWith(selector, doc)) return
  const threads = useThreads.getState()
  const threadId = threads.activeThreadId
  if (threadId !== null) {
    // The Composer takes it (`takeComposerFocus`); clear first so the same id still counts as a new request.
    if (threads.composerFocus === threadId) useThreads.setState({ composerFocus: null })
    useThreads.setState({ composerFocus: threadId })
    return
  }
  const active = doc.activeElement
  if (active instanceof HTMLElement && active.closest(selector) !== null) active.blur()
}

/**
 * Alt+Cmd+B, View > Viewer and the title bar's viewer button, by **whether the viewer is on screen** (`fits`: the window has room
 * for both panes, as `App.tsx` measures it now). Off it — hidden by the user, or folded to the strip of a narrow window — it opens
 * as pressing the strip does (`expand`, which also collapses the sidebar to make room). On it, it hides, moving a focus inside the
 * viewer (or in a Web page) to the prompt box.
 */
export function toggleViewerLayout(fits: boolean, expand: () => void): void {
  if (viewerFolded(isViewerHidden(), fits)) {
    expand()
    return
  }
  moveFocusOutOf(LAYOUT_PANE_SELECTOR.viewer)
  setViewerHidden(true)
}

/** Cmd+B and the title bar's sidebar button. The collapse itself is `toggleSidebar` (T27); this adds the focus rule. */
export function toggleSidebarLayout(): void {
  const threads = useThreads.getState()
  if (!threads.sidebarCollapsed) moveFocusOutOf(LAYOUT_PANE_SELECTOR.sidebar)
  useThreads.getState().toggleSidebar()
}
