/**
 * The operations that shortcuts and the menu's mode switching drive (items 48 / 189 / 195, wave 14 bundle D).
 *
 * There are 3 callers: the `keydown` in `App.tsx` (⌘P / ⌘⇧F / ⌘F / ⌘K), the forwarding from the viewer
 * (the port of `ViewerPane` / `TransientViewerPane`, item 189), and the menu accelerators
 * (`onMenuCommand`, ⌃⌘I / ⌘⇧E / search). Wherever they come from, they go through the same function.
 * The decision is a pure function in `shortcuts.ts`; this only drives the store and the DOM focus.
 */
import { useThreads, type SidebarMode } from './threadStore.js'
import { workingCwdUri } from '@shared/thread.js'
import { isConversationLocked, useSearch } from './searchStore.js'
import { useStore } from './store.js'
import {
  isSearchTarget,
  isViewerNavId,
  isWebTabShortcutId,
  type WebTabShortcutId,
  modeKeyAction,
  openModeStep,
  viewerEditorKeys as editorKeysFor,
  viewerForwardedShortcuts,
  type ForwardedShortcut,
  type SearchTarget,
  type SidebarStep
} from './shortcuts.js'
import { keyPlatformOf } from './composer-keys.js'
import { runViewerNav } from './viewerHistory.js'
import { isWebPaneUri } from '@shared/web-tabs.js'
import { closeThreadFind, useThreadFind } from './threadFindStore.js'
import { closeViewerUri, closeWebTab, openBlankTab, showWebTab, useWeb } from './webStore.js'

/** The convention (mac / other) is decided once at startup (the same as the Composer's ⌘Enter). */
const VIEWER_PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)

/**
 * The forwarding table passed to the viewer (item 189). Carried in `ViewerHostMessage.shortcuts`. Called on every send: it is built from
 * the current assignments (TODO 549) (TODO 589: before, `setKeybindings` rewrote an array taken at startup).
 */
export function viewerShortcuts(): readonly ForwardedShortcut[] {
  return viewerForwardedShortcuts(VIEWER_PLATFORM)
}

/** The keys of commands inside the viewer's editor (TODO 692). Carried in `ViewerHostMessage.editorKeys`. Called on every send. */
export function viewerEditorKeys(): ReturnType<typeof editorKeysFor> {
  return editorKeysFor(VIEWER_PLATFORM)
}

/**
 * "This key was pressed" arrived from the viewer (item 189). **Do not trust the viewer's value**:
 * discard anything that is not a table id (`SearchTarget`). Save (`save`, item 313) is received first by the
 * `ViewerPane`, which holds the save state, so nothing is done here (`TransientViewerPane` has nothing to save).
 * Back / forward (TODO 369) arrive with the same id whether from a key or a mouse button.
 */
export function runViewerShortcut(id: unknown): void {
  if (isSearchTarget(id)) openSearch(id)
  else if (isViewerNavId(id)) runViewerNav(id)
  // Web tab keys (TODO 531). When a web page has focus, main forwards them, and `WebViewerPane` passes them here.
  else if (isWebTabShortcutId(id)) runWebTabShortcut(id)
}

/** Whether the Web pane is in front (the ViewerPane is showing a web page or a blank tab, and it is not hidden by a temporary view). */
export function webPaneFront(): boolean {
  const { selectedUri, transient } = useStore.getState()
  return transient === null && isWebPaneUri(selectedUri)
}

/** The tab next to the current one (`step` = +1 / -1; at an end it wraps to the opposite end). null if there is 1 tab or fewer. */
export function neighborWebTab<T extends { readonly id: string }>(
  tabs: readonly T[],
  activeId: string | null,
  step: 1 | -1
): T | null {
  if (tabs.length < 2) return null
  const index = tabs.findIndex((tab) => tab.id === activeId)
  if (index < 0) return tabs[0] ?? null
  return tabs[(index + step + tabs.length) % tabs.length] ?? null
}

/**
 * Web tab keys (TODO 531, same as Chrome). ⌘T is a blank new tab (the same as the + in the heading), ⌘L focuses the URL field,
 * ⌃Tab / ⌃⇧Tab go to the adjacent tab (wrapping at the ends). **Only when the Web pane is in front**: the caller (App's keydown)
 * checks `webPaneFront`. Forwarding from a page is run as is, since a page being shown = it is in front.
 */
export function runWebTabShortcut(id: WebTabShortcutId): void {
  if (id === 'webNewTab') {
    openBlankTab()
    return
  }
  if (id === 'webFocusAddress') {
    useWeb.setState((state) => ({ focusAddress: state.focusAddress + 1 }))
    return
  }
  const { tabs } = useWeb.getState()
  const next = neighborWebTab(tabs.tabs, tabs.activeId, id === 'webNextTab' ? 1 : -1)
  if (next !== null) showWebTab(next)
}

/**
 * The ViewerPane registers the file viewer's close (`requestClose`) (TODO 843). ⌘W closes through it (the unsaved confirmation, auto save, and
 * the per-thread display memory 59 / 63 / 70), so the key side calls this without knowing the ViewerPane's internals. Since TODO 1326
 * removed the heading's ✕, ⌘W is the user's only way to close the file in front.
 */
let viewerCloser: (() => void) | null = null

export function registerViewerCloser(closer: () => void): () => void {
  viewerCloser = closer
  return () => {
    if (viewerCloser === closer) viewerCloser = null
  }
}

/**
 * The menu's "Close" (⌘W / Ctrl+W, TODO 531 / 843). The order is the same as VS Code: temporary view (diff) -> Web tab -> file viewer ->
 * the window (only when none of those exist). If the Web pane is in front and there is a current tab, close that tab (`closeWebTab`: the
 * conversation's history decides what comes next, TODO 1326); with no current tab, close the shown Web view by the same rule
 * (`closeViewerUri`). The file viewer closes through `requestClose`. The window is the same as electron's role `close`
 * (`window.close()` closes the BrowserWindow), reached only when nothing is shown.
 *
 * TODO 1327: **a hidden (or folded) viewer shows nothing**, so it is skipped and ⌘W closes the window, as with an empty viewer. Closing
 * what it holds unseen would drop a Web tab nobody sees, or put the unsaved-draft question in a pane that is not on screen.
 */
export function closeTabOrWindow(): void {
  const { selectedUri, transient, closeTransient, select, viewerFolded } = useStore.getState()
  if (viewerFolded) {
    window.close()
    return
  }
  if (transient !== null) {
    closeTransient()
    return
  }
  const { activeId } = useWeb.getState().tabs
  if (webPaneFront() && selectedUri !== null) {
    if (activeId !== null) void closeWebTab(activeId)
    // No current tab (closing the current tab leaves none, TODO 1326; e.g. a blank step reached by back / forward): close the
    // shown view the same way - the conversation's next view, else the empty state. Never the window (review Y2).
    else closeViewerUri(selectedUri)
    return
  }
  if (selectedUri !== null && !isWebPaneUri(selectedUri)) {
    if (viewerCloser !== null) viewerCloser()
    else select(null)
    return
  }
  window.close()
}

/**
 * Return focus to this document (the renderer's top level). When the viewer's iframe (OOPIF) has focus,
 * calling `focus()` on the parent's input field may not work (T25: an iframe's focus is separate from the OS window's
 * focus). Call `window.focus()` first. **Verify on a real machine whether it works** (TODO 189).
 */
function focusTopDocument(): void {
  try {
    window.focus()
  } catch {
    // Do nothing (a test environment, etc.)
  }
}

/** Put the sidebar in the state of being open in that mode. A key does not collapse it (item 195). */
function applyStep(mode: SidebarMode, step: SidebarStep): void {
  const threads = useThreads.getState()
  if (step === 'switch') threads.setMode(mode)
  else if (step === 'expand') threads.toggleSidebar()
  // For Files, as when the icon is pressed, open the displayed thread's cwd in the tree (item 49).
  // If it is already open, do not touch it (so the scroll does not jump on every press).
  if (mode === 'files' && step !== 'none') {
    const { activeThreadId, threadsById } = useThreads.getState()
    // TODO 633: for a conversation that moved to a worktree, open that worktree.
    const thread = activeThreadId === null ? undefined : threadsById[activeThreadId]?.thread
    const cwdUri = thread === undefined ? null : workingCwdUri(thread)
    if (cwdUri !== null) void useStore.getState().reveal(cwdUri)
  }
}

/**
 * TODO 1199: while the conversation search (⌘K) has a term, body search (⌘⇧F) and file-name search (⌘P) are gray and disabled.
 * Their shortcuts and routes do nothing (they neither change the mode nor steal focus, owner decision 2026-11-10).
 */
function searchTargetLocked(target: SearchTarget): boolean {
  return isConversationLocked(useSearch.getState()) && (target === 'files' || target === 'names')
}

/** Open the search window and focus it (⌘P / ⌘⇧F / ⌘F / ⌘K, items 48 / 189). */
export function openSearch(target: SearchTarget): void {
  if (searchTargetLocked(target)) return
  focusTopDocument()
  const { mode, sidebarCollapsed: collapsed } = useThreads.getState()
  applyStep('search', openModeStep({ mode, collapsed }, 'search'))
  useSearch.getState().requestFocus(target)
}

/**
 * "Search in this folder" from a folder in the Files tree (TODO 437). **Both** the 🔎 on row hover and the right-click menu's
 * "Search in this folder…" go through here. Set the scope (`searchStore.setRange`: redo the already-typed searches
 * with the scope and ask for the subtree build), switch the Activity Bar to Search and focus the body-search field.
 */
export function openSearchInFolder(uri: string): void {
  // While gray, do not change the scope either (to avoid the scope changing unseen and the `buildScope` IPC and a re-run firing).
  if (searchTargetLocked('files')) return
  useSearch.getState().setRange(uri)
  openSearch('files')
}

/**
 * Put the string selected in the viewer into body search (⌘⇧F) and run it (TODO 630, the `run` of `selectionSearchMenuItems`.
 * TODO 1030 added a `target` that chooses the field; the default is body search). It opens the panel and focuses it in the same way as `openSearchInFolder`, but it also wants to rewrite the input field (`SearchMode`'s
 * `fileDraft`, React state outside `useSearch`), so it rides on the `seed` of `requestFocus`.
 * `focusTopDocument` / `applyStep` take the same route as `openSearch` (duplicating it only here would split it into 2 routes
 * that could drift apart). The scope (`range`, TODO 437) is not changed: even if the selected file is outside the scope,
 * the whole is searched (narrowing by folder is only the route from the tree).
 */
export function searchSelection(query: string, target: SearchTarget = 'files'): void {
  // When body / file-name search is explicitly chosen from the right-click on a selection, clear the term left in the conversation search (⌘K)
  // and release the lock (TODO 1199) before running (owner decision 2026-11-16, dialog). Silently doing nothing
  // looks like "it does not work". The key-only ⌘⇧F / ⌘P do nothing, per the decision of 1199 (`openSearch`).
  // The local draft of a mounted SearchMode is emptied by the effect that received a files / names request with a seed.
  if (searchTargetLocked(target)) {
    const search = useSearch.getState()
    search.setConversationDraft('')
    search.setConversationQuery('')
  }
  focusTopDocument()
  const { mode, sidebarCollapsed: collapsed } = useThreads.getState()
  applyStep('search', openModeStep({ mode, collapsed }, 'search'))
  useSearch.getState().requestFocus(target, query)
}

/**
 * "Search by name" in the band for a link that could not be opened (TODO 816). Put the name in the ⌘P (file-name search) field and run it.
 * The route is the same as `searchSelection` (the field is rewritten via the `seed` of `requestFocus`).
 */
export function searchFileName(name: string): void {
  if (searchTargetLocked('names')) return
  focusTopDocument()
  const { mode, sidebarCollapsed: collapsed } = useThreads.getState()
  applyStep('search', openModeStep({ mode, collapsed }, 'search'))
  useSearch.getState().requestFocus('names', name)
}

/**
 * When a term starts being typed in the ⌘P (file-name search) field, clear the in-file search (the search-term highlight in the ViewerPane) and the in-conversation search
 * (the floating search window's term, highlight and count) (TODO 1065, owner decision 2026-10-31). Call it **at the moment typing starts**:
 * merely opening ⌘P, or opening and closing it, does not clear them. The behavior of ⌘F / ⌘⇧F / ⌘K is unchanged.
 */
export function clearContentSearches(): void {
  if (useStore.getState().highlightQuery !== null) useStore.setState({ highlightQuery: null })
  const find = useThreadFind.getState()
  if (find.open) closeThreadFind(false)
  find.setQuery('')
}

/**
 * When a candidate of ⌘P (file-name search, `'names'`) is opened **with the keyboard (Enter)**, return the sidebar to
 * Threads (item 371). **TODO 410 (wave 21 bundle D, owner request 2026-10-04) took mouse
 * clicks out of scope**: so that another candidate can be tried by clicking right after, the search screen and the focus of the search field
 * stay as they are (called only when `openRow` in `SearchMode.tsx` has `via: 'keyboard'`).
 * Body search (⌘⇧F) and conversation search (⌘K) are not called either way of opening (so another hit can be opened next).
 *
 * `showSidebarMode('threads')` is not used: that is for the menu accelerator, and it
 * goes as far as "open and focus inside (`.sidebar-panel`)" (item 195). Here, in contrast, we want to
 * move focus to the viewer of the file just opened (VS Code focuses the editor that was opened). Only `setMode` is called, and the focus is sent separately to `.viewer-frame`;
 * if it is not found, nothing happens (it does not go to the Composer: this is neither a continuation of search nor
 * a place for editing).
 *
 * **The previous search term is not cleared.** `nameDraft` (`SearchMode.tsx`) takes its seed at mount from
 * `searchStore.nameQuery` (the store-side value that is not cleared on unmount), so
 * pressing ⌘P next time shows the previous term, all selected (`select()` of `requestFocus`, the same as VS Code).
 */
export function returnToThreadsAfterNameOpen(): void {
  const threads = useThreads.getState()
  if (threads.mode !== 'threads') threads.setMode('threads')
  afterRender(() => {
    document.querySelector<HTMLIFrameElement>('.viewer-frame')?.focus()
  })
}

/**
 * A folder row of the file-name search was opened (TODO 436, by click or Enter). Switch the sidebar to Files,
 * open the ancestors in order down to that folder in the tree, and open the folder itself and put it in the selected state (`reveal`, the same route as item 49:
 * `revealedUri` is the row's highlight, `revealTarget.always` scrolls it into view, and it also clears Files' filter).
 * **The viewer is not changed** (`select` is not called: passing a directory makes the viewer refuse with `directory`).
 * It does not return to Threads (371 / 410 are for file rows only). Focus is sent to the tree's container so ↑↓ can follow.
 */
export function revealFolderInFiles(uri: string): void {
  if (useThreads.getState().mode !== 'files') useThreads.getState().setMode('files')
  // `setMode` opens the sidebar if it is collapsed (`pressMode`), so look at the collapse **after** the switch. Looking at the earlier copy
  // collapsed the just-opened sidebar again (wave-33 proxy verification 620-3: pressing a folder link from a collapsed Threads).
  if (useThreads.getState().sidebarCollapsed) useThreads.getState().toggleSidebar()
  void useStore.getState().reveal(uri)
  afterRender(() => {
    document.querySelector<HTMLElement>('.sidebar-panel .file-tree')?.focus()
  })
}

/** Run after waiting for rendering (right after switching modes the panel does not exist yet). */
function afterRender(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 0)
}

function sidebarPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.sidebar-panel')
}

/**
 * A mode key (menu accelerator, item 195) was pressed.
 *
 * - Search is "focus the body-search field" (the same as ⌘⇧F. VS Code's Search also focuses the input field).
 * - Threads / Files take the shape of a VS Code view (`modeKeyAction`): open and focus inside.
 *   If it is already open in that mode and the focus is also inside, return focus to the conversation's input field.
 */
export function showSidebarMode(mode: SidebarMode): void {
  if (mode === 'search') {
    openSearch('files')
    return
  }
  focusTopDocument()
  const { mode: current, sidebarCollapsed: collapsed } = useThreads.getState()
  const panel = sidebarPanel()
  const panelFocused = panel !== null && panel.contains(document.activeElement)
  const action = modeKeyAction({ mode: current, collapsed }, mode, panelFocused)
  applyStep(mode, action.sidebar)
  afterRender(() => {
    if (action.focus === 'main') {
      const input = document.querySelector<HTMLElement>('.composer:not([hidden]) .composer-input')
      if (input !== null) input.focus()
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      return
    }
    const target = sidebarPanel()
    if (target === null) return
    // For Files, the filter field; for Threads, the list's container (rows do not hold focus).
    const filter = mode === 'files' ? target.querySelector<HTMLElement>('.search-input') : null
    ;(filter ?? target).focus()
  })
}
