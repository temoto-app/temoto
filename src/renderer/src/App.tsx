import { useCallback, useEffect, useRef, useState } from 'react'
import { BottomBar } from './components/BottomBar.js'
import { BackupBanner } from './components/BackupBanner.js'
import { InstanceBanner } from './components/InstanceBanner.js'
import { ErrorNotice } from './components/ErrorNotice.js'
import { ensureLoginRecovery } from './loginRecoveryStore.js'
import { LinkNotice } from './components/LinkNotice.js'
import { LinkPopover } from './components/LinkPopover.js'
import { productNameFor, windowTitleFor } from './instance-label.js'
import { PRODUCT_NAME } from '@shared/product.js'
import { Sidebar } from './components/Sidebar.js'
import { ThreadPane } from './components/ThreadPane.js'
import { Settings } from './components/Settings.js'
import { useMainPanel } from './mainPanel.js'
import { ScheduleEditor } from './components/ScheduleEditor.js'
import { ExtensionPanel } from './components/ExtensionDetailPane.js'
import { ViewerPane } from './components/ViewerPane.js'
import { ViewerStrip } from './components/ViewerStrip.js'
import { DEFAULT_PANE_RATIO, clampRatio, loadPaneRatio, savePaneRatio } from './paneRatio.js'
import {
  dragEndRatio,
  dragSplit,
  loadViewerCollapsed,
  saveViewerCollapsed,
  viewerFits,
  viewerFolded
} from './viewer-collapse.js'
import {
  DEFAULT_SIDEBAR_WIDTH,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  clampSidebarWidth,
  loadSidebarWidth,
  maxSidebarWidth,
  saveSidebarWidth,
  widthFromPointer
} from './sidebarWidth.js'
import { appShortcut, webTabShortcut } from './shortcuts.js'
import { installThreadPointerTracker, openThreadFind, threadPaneHasFocus } from './threadFindStore.js'
import {
  closeTabOrWindow,
  openSearch,
  runWebTabShortcut,
  showSidebarMode,
  webPaneFront
} from './shortcut-actions.js'
import { initKeybindings } from './keybindingStore.js'
import { useStore } from './store.js'
import { useThreads } from './threadStore.js'
import { useTheme } from './themeStore.js'
import { useLocale } from './localeStore.js'
import { useEditor } from './editorStore.js'
import { initThreadCollapse } from './threadCollapseStore.js'
import { initRedmine } from './redmineStore.js'
import { useT } from './i18n/index.js'
import { useViewerMemory } from './viewerMemory.js'
import { useViewerHistory } from './viewerHistory.js'
import { useNavHistory } from './navHistory.js'
import { useFilerHistory } from './filerHistory.js'
import { useFilesFollowViewer } from './files-follow-viewer.js'
import { useUnfoldOnOpen } from './viewerUnfold.js'
import { NavButtons } from './components/NavButtons.js'
import { openHelp, openReleaseNotes, showReleaseNotesIfUpdated } from './help.js'

/** One keyboard step of the divider (a fraction of the split area's width). */
const KEY_STEP = 0.02

/** One keyboard step of the sidebar divider (px). */
const SIDEBAR_KEY_STEP = 16

export function App(): React.JSX.Element {
  const init = useStore((state) => state.init)
  const appInfo = useStore((state) => state.appInfo)
  const initThreads = useThreads((state) => state.init)
  const initTheme = useTheme((state) => state.init)
  const initLocale = useLocale((state) => state.init)
  const initEditor = useEditor((state) => state.init)
  const t = useT()
  const error = useThreads((state) => state.error)
  const clearError = useThreads((state) => state.clearError)
  // The settings editor (item 187), the scheduled-run editor (TODO 372) and the extension detail (TODO 458) open where ThreadPane is.
  // ThreadPane is hidden with CSS rather than removed (so draft state survives). Which one shows (the one opened later wins) is decided in `mainPanel.ts`.
  const mainPanel = useMainPanel()
  // Remember each thread's ViewerPane state and reopen it (item 63).
  useViewerMemory()
  // Viewer back / forward (TODO 369). It records after the memory is restored, so it comes after `useViewerMemory`.
  useViewerHistory()
  // App-wide back / forward (TODO 801). It reopens the viewer after the memory is restored, so it comes after `useViewerMemory`.
  useNavHistory()
  // Files back / forward and the per-conversation Files selection (TODO 1257). After `useViewerMemory` so the
  // reveal of the Files selection on a conversation switch comes after the viewer restore's auto reveal.
  useFilerHistory()
  // Files follows the local file the viewer shows (TODO 1300). After `useFilerHistory` (same subscription order as its picks).
  useFilesFollowViewer()

  useEffect(() => {
    void init()
    void initThreads()
    // The color scheme mirrors the value main resolved (7.4.1). OS changes arrive on the same path.
    void initTheme()
    // The display language (7.4.4) has the same shape as the theme: it mirrors the value main resolved.
    void initLocale()
    // The external editor choice (item 115). Main owns it, including the default (VS Code).
    void initEditor()
    // TODO 1282: the login recovery's state (main holds it). A failed recovery raises the error notice in every window.
    ensureLoginRecovery()
    // TODO 659: the number of days before the thread list collapses. Subscribes to the notification sent to all windows (same shape as autoSaveStore).
    initThreadCollapse()
    // TODO 811: the Redmine base URL (turns ticket numbers in answers into links).
    initRedmine()
    // The user's keyboard shortcut assignments (TODO 549). Main is the source of truth.
    initKeybindings()
    // TODO 571: StrictMode (dev build) runs effects as mount -> unmount -> mount. The subscription is released in cleanup,
    // and when the first init returns from its await, it leaves the work to the second one (`subscription-slot.ts`). editorStore does not subscribe.
    return () => {
      useStore.getState().dispose()
      useThreads.getState().dispose()
      useTheme.getState().dispose()
      useLocale.getState().dispose()
    }
  }, [init, initThreads, initTheme, initLocale, initEditor])

  // TODO 1186: on the first launch after a version bump, show the new version's changelog exactly once (main decides and records).
  // Ask after startup `init` has filled `appInfo` and after thread restore (`takeOpenRequest` -> `selectThread`) is done.
  // Restore changes `activeThreadId`, and the effect in `useViewerMemory` then closes the temporary view; if we opened it earlier it
  // would vanish at once, and main has already written the record so it would never show again. The `activeThreadId` effect of the earlier render always finishes before the next render (the change of this flag).
  const appInfoReady = appInfo !== null
  const initialOpenSettled = useThreads((state) => state.initialOpenSettled)
  const releaseNotesReady = appInfoReady && initialOpenSettled
  useEffect(() => {
    if (releaseNotesReady) showReleaseNotesIfUpdated()
  }, [releaseNotesReady])

  // Item 225: a window with a non-default userData (item 192) gets the "(copy)" mark in `document.title`
  // as well, not just in the band. The real instance (userDataLabel === null) keeps the default in index.html untouched.
  const userDataLabel = appInfo?.userDataLabel ?? null
  const baseProductName = appInfo?.productName ?? PRODUCT_NAME
  useEffect(() => {
    const title = windowTitleFor(t, baseProductName, userDataLabel)
    if (title !== null) document.title = title
  }, [t, baseProductName, userDataLabel])

  // ---- Sidebar collapse (5.5.1, T27) ----
  const sidebarCollapsed = useThreads((state) => state.sidebarCollapsed)
  const toggleSidebar = useThreads((state) => state.toggleSidebar)

  /**
   * ⌘B is an accelerator of a menu item (`src/main/menu.ts`), so **the renderer never
   * receives `keydown`** (electron consumes it first). That is why main has to push it.
   * Adding a `keydown` listener here too would fire twice (and it is not for some future
   * where the menu is gone, so we do not add it).
   */
  // The mode switch (⌃⌘I / ⌘⇧E, item 195) is also a menu accelerator, so it arrives the same way.
  // Settings (⌘,) is handled by the Sidebar itself, which owns the entry point.
  useEffect(
    () =>
      window.aios.app.onMenuCommand((command) => {
        if (command === 'toggleSidebar') toggleSidebar()
        else if (command === 'showThreads') showSidebarMode('threads')
        else if (command === 'showFiles') showSidebarMode('files')
        else if (command === 'showSearch') showSidebarMode('search')
        else if (command === 'showExtensions') showSidebarMode('extensions')
        // ⌘W (TODO 531): closes the tab if a Web tab is in front, otherwise the window.
        else if (command === 'closeTabOrWindow') closeTabOrWindow()
        // "Help > aios Help" (TODO 1174). Shows Help in ViewerPane as a temporary view.
        else if (command === 'openHelp') openHelp()
        // "Help > Release Notes" (TODO 1186). Shows the bundled changelog as a temporary view.
        else if (command === 'openReleaseNotes') openReleaseNotes()
      }),
    [toggleSidebar]
  )

  // ---- Search shortcuts (5.5.2, items 46 / 48 / 189) ----
  /**
   * ⌘P / ⌘⇧F / ⌘F / ⌘K are caught by **a single** `keydown` listener here. The decision
   * is the pure function in `shortcuts.ts`; the action is `openSearch` in `shortcut-actions.ts`.
   * They are not menu accelerators (⌘F would collide with search inside the viewer's editor).
   * **When focus is in the ViewerPane iframe (OOPIF), the parent gets no `keydown`**, so from
   * inside a viewer the bridge sends the same table back and ViewerPane calls `openSearch` (item 189).
   */
  // TODO 496: ⌘F while in ThreadPane (which includes the Composer) is the in-thread search (`appShortcut`). Clicking
  // body text does not move focus, so the last place pressed is also checked (`installThreadPointerTracker`).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = appShortcut(event, { inThreadPane: threadPaneHasFocus() })
      if (target === null) {
        // Web tab keys (TODO 531, ⌘T / ⌘L / ⌃Tab / ⌃⇧Tab). Only while the Web pane is in front.
        // Only ⌘T (new tab) works everywhere (TODO 771: the entry point that shows an empty ViewerPane).
        const candidate = webTabShortcut(event)
        const web = candidate === 'webNewTab' || webPaneFront() ? candidate : null
        if (web === null) return
        event.preventDefault()
        runWebTabShortcut(web)
        return
      }
      event.preventDefault()
      if (target === 'threadFind') {
        // With no thread shown (empty ThreadPane) there is nothing to search in, so fall back to the body search as before.
        if (useThreads.getState().activeThreadId === null) openSearch('files')
        else openThreadFind()
        return
      }
      openSearch(target)
    }
    window.addEventListener('keydown', onKey)
    const untrack = installThreadPointerTracker()
    return () => {
      window.removeEventListener('keydown', onKey)
      untrack()
    }
  }, [])

  // ---- ThreadPane / ViewerPane split (chapter 5, T15) ----
  const [ratio, setRatio] = useState<number>(() => loadPaneRatio())
  const [dragging, setDragging] = useState(false)
  const workspace = useRef<HTMLDivElement | null>(null)
  /** Alive only during a drag. Read as a **ref, not state** (so it does not wait for a re-render on every pointermove). */
  const drag = useRef<{ left: number; width: number } | null>(null)
  /** The ratio when the drag started. A drag that ends folded puts it back (`dragEndRatio`, TODO 1297 review). */
  const dragStartRatio = useRef(DEFAULT_PANE_RATIO)
  /** The value saved on pointerup / dblclick, so we do not hit localStorage on every render. */
  const latest = useRef(ratio)
  latest.current = ratio

  /**
   * Measures the split area (from ThreadPane's left edge to the window's right edge).
   * The Sidebar and its divider are outside the ratio, so the origin is **the left edge of `.thread-pane`**
   * (since T24 added a divider on the sidebar side too, the right edge of `.sidebar` is now off by 5px).
   */
  const splitBox = useCallback((dividerWidth: number): { left: number; width: number } | null => {
    const host = workspace.current
    if (host === null) return null
    const box = host.getBoundingClientRect()
    const pane = host.querySelector('.thread-pane')
    const left = pane === null ? box.left : pane.getBoundingClientRect().left
    const width = box.right - left - dividerWidth
    return width > 0 ? { left, width } : null
  }, [])

  /**
   * **Puts `setPointerCapture` on the divider.**
   *
   * ViewerPane is a sandboxed iframe of another origin (OOPIF), so the moment the pointer
   * enters it, `pointermove` to the parent document stops and the drag looks stuck.
   * With capture, every event goes to this element until release. As a precaution we also apply
   * `.workspace.dragging iframe { pointer-events: none }` during the drag
   * (capture depends on Chromium's implementation, so we do both).
   */
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const box = splitBox(event.currentTarget.getBoundingClientRect().width)
      if (box === null) return
      drag.current = box
      dragStartRatio.current = latest.current
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
    },
    [splitBox]
  )

  // ---- Folding the viewer (TODO 1297). ViewerPane is always there; it can only fold into a strip. ----
  const [viewerCollapsed, setViewerCollapsed] = useState<boolean>(() => loadViewerCollapsed())
  const latestCollapsed = useRef(viewerCollapsed)
  latestCollapsed.current = viewerCollapsed
  /** Width of `.workspace`, for the "too narrow for both panes" fold. NaN until measured (= room). */
  const [hostWidth, setHostWidth] = useState(Number.NaN)
  useEffect(() => {
    const host = workspace.current
    if (host === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setHostWidth(host.getBoundingClientRect().width))
    observer.observe(host)
    return () => observer.disconnect()
  }, [])
  const viewerFitsNow = viewerFits(hostWidth, !sidebarCollapsed)
  const folded = viewerFolded(viewerCollapsed, viewerFitsNow)
  const unfoldViewer = useCallback(() => {
    if (!latestCollapsed.current) return
    latestCollapsed.current = false
    setViewerCollapsed(false)
    saveViewerCollapsed(false)
  }, [])
  /** The strip was pressed. Too narrow even so: collapse the sidebar to make room. */
  const onStripExpand = useCallback(() => {
    unfoldViewer()
    if (!viewerFitsNow && !sidebarCollapsed) toggleSidebar()
  }, [unfoldViewer, viewerFitsNow, sidebarCollapsed, toggleSidebar])
  // Opening something in the viewer (a file, a Web page, a temporary view) opens a folded viewer, so what was opened is
  // seen — also when it is what was already selected. The restore on a conversation switch does not (`viewerUnfold.ts`).
  useUnfoldOnOpen(unfoldViewer)
  // While folded nothing is reported to main as shown (the AI's `listOpenFiles` / `getViewerScreenshot`, `viewer-shown.ts`).
  useEffect(() => {
    useStore.getState().setViewerFolded(folded)
  }, [folded])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const box = drag.current
    if (box === null) return
    // Dragging far to the right folds the viewer (TODO 1297); back past that point opens it again. The ratio is kept while folded.
    const next = dragSplit(event.clientX, box.left, box.width)
    if (next.collapsed !== latestCollapsed.current) {
      latestCollapsed.current = next.collapsed
      setViewerCollapsed(next.collapsed)
    }
    if (!next.collapsed) setRatio(next.ratio)
  }, [])

  /** The end point of every path where capture is lost (pointerup / pointercancel / lostpointercapture). */
  const endDrag = useCallback(() => {
    if (drag.current === null) return
    drag.current = null
    setDragging(false)
    // On the way to the fold the ratio ran up to its limit; a drag that folds keeps the ratio from before it.
    const next = dragEndRatio(dragStartRatio.current, latest.current, latestCollapsed.current)
    latest.current = next
    setRatio(next)
    savePaneRatio(next)
    saveViewerCollapsed(latestCollapsed.current)
  }, [])

  /** Double-click resets to an even split (and opens a folded viewer). */
  const onDoubleClick = useCallback(() => {
    setRatio(DEFAULT_PANE_RATIO)
    savePaneRatio(DEFAULT_PANE_RATIO)
    unfoldViewer()
  }, [unfoldViewer])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step =
        event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : null
      if (step === null) return
      event.preventDefault()
      // A folded viewer opens again at the remembered ratio first (TODO 1297).
      if (latestCollapsed.current) {
        unfoldViewer()
        return
      }
      const box = splitBox(event.currentTarget.getBoundingClientRect().width)
      const next = clampRatio(latest.current + step, box?.width ?? Number.NaN)
      // Advance the ref without waiting for a re-render. If key repeat delivers 3 events in one frame,
      // `latest.current`, which is assigned after rendering, still holds the first value, and three steps collapse into one.
      latest.current = next
      setRatio(next)
      savePaneRatio(next)
    },
    [splitBox, unfoldViewer]
  )

  // ---- Sidebar width (5.5.1, T24) ----
  /**
   * The panes use a ratio; the sidebar uses **px**. The mechanism (capture / `.workspace.dragging` /
   * double-click for the default) rides on the same one as T15; only how the value is stored differs.
   */
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadSidebarWidth())
  const sidebarDrag = useRef<{ left: number; limit: number } | null>(null)
  const latestSidebar = useRef(sidebarWidth)
  latestSidebar.current = sidebarWidth

  /** The left edge of `.sidebar-panel` (= the right edge of the icon bar) and the maximum width currently allowed. */
  const sidebarBox = useCallback((): { left: number; limit: number } | null => {
    const host = workspace.current
    if (host === null) return null
    const panel = host.querySelector('.sidebar-panel')
    if (panel === null) return null
    const box = host.getBoundingClientRect()
    return { left: panel.getBoundingClientRect().left, limit: maxSidebarWidth(box.width, !folded) }
  }, [folded])

  const onSidebarPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const box = sidebarBox()
      if (box === null) return
      sidebarDrag.current = box
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
    },
    [sidebarBox]
  )

  const onSidebarPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const box = sidebarDrag.current
    if (box === null) return
    setSidebarWidth(widthFromPointer(event.clientX, box.left, box.limit))
  }, [])

  const endSidebarDrag = useCallback(() => {
    if (sidebarDrag.current === null) return
    sidebarDrag.current = null
    setDragging(false)
    saveSidebarWidth(latestSidebar.current)
  }, [])

  const onSidebarDoubleClick = useCallback(() => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
    saveSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
  }, [])

  const onSidebarKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step =
        event.key === 'ArrowLeft'
          ? -SIDEBAR_KEY_STEP
          : event.key === 'ArrowRight'
            ? SIDEBAR_KEY_STEP
            : null
      if (step === null) return
      event.preventDefault()
      const box = sidebarBox()
      const next = clampSidebarWidth(latestSidebar.current + step, box?.limit ?? SIDEBAR_MAX_PX)
      latestSidebar.current = next
      setSidebarWidth(next)
      saveSidebarWidth(next)
    },
    [sidebarBox]
  )

  return (
    <div className="app">
      {/* A band shown only in a window launched with a non-default userData (item 192). Draws nothing for the default. */}
      <InstanceBanner />
      {/* TODO 1306: the one-time passphrase notice, a damaged DB with "restore from the most recent backup", and the result of a restore. */}
      <BackupBanner />
      {/* The title bar holds only the drag region and warnings. Settings moved to the bottom of the Sidebar's vertical icon bar (5.3, T14). */}
      <header className="titlebar">
        <NavButtons />
        <span className="product">{productNameFor(t, baseProductName, userDataLabel)}</span>
        {appInfo?.storage === 'memory-only' ? (
          // TODO 1129: an explanation per reason. When the key is missing or cannot be decrypted, say "cannot open the DB" rather than "encryption unavailable".
          <span
            className="warning"
            title={t(`reason.${appInfo.storageReason ?? 'db-keychain-unavailable'}`)}
          >
            {t(
              appInfo.storageReason === null || appInfo.storageReason === 'db-keychain-unavailable'
                ? 'app.memoryOnly'
                : 'app.memoryOnlyKey'
            )}
          </span>
        ) : null}
      </header>
      {/* TODO 1281: the common error notice (summary, what to try, details, log path). Text from main arrives as a reason code (7.4.4). */}
      {error !== null ? <ErrorNotice message={error} onDismiss={clearError} /> : null}
      {/* The band for a link that could not be opened (TODO 808 / 816): the list of candidates, the paths tried, and the next step. */}
      <LinkNotice />
      {/* The popover next to a link that could not be resolved (TODO 995). */}
      <LinkPopover />
      {/*
        The ratio is passed as a CSS variable. The `flex-grow` of `.thread-pane` / `.viewer-pane` reads it
        (chapter 5). This avoids adding a style-passing prop to the child components, so the code of
        ThreadPane / ViewerPane does not change by a single line in T15.

        ViewerPane is always there (TODO 1297), so the ratio always applies. **Only while the viewer is folded into
        its strip is no variable set** (back to the default of 1). If the sum of `flex-grow` is below 1, flexbox
        distributes **only that fraction** of the free space. With 0.3 remembered and only ThreadPane growing,
        just 343px of 1072px of free space was used and the right side stayed empty (measured).
      */}
      <div
        ref={workspace}
        className={dragging ? 'workspace dragging' : 'workspace'}
        style={
          {
            // The sidebar is in px. It stays set while collapsed (5.5.1, T24 / T27) —
            // the `.sidebar-panel` that reads it just disappears from the DOM, so when opened
            // it returns at the width from before collapsing. **Do not put 0 to collapse** (the width would be lost).
            '--sidebar-width': `${sidebarWidth}px`,
            ...(folded ? {} : { '--thread-grow': ratio, '--viewer-grow': 1 - ratio })
          } as React.CSSProperties
        }
      >
        <Sidebar />
        {/*
          The divider between the sidebar and ThreadPane. This element draws the 1px border
          (the `border-right` of `.sidebar-panel` was removed in T24).
          **Not drawn while collapsed** (5.5.1, T27): a divider of width 0 cannot be grabbed, and
          there is no point leaving an immovable divider reachable with Tab. The border of the
          icon bar (`border-right` of `.activity-bar`) serves as the boundary.
        */}
        {sidebarCollapsed ? null : (
          <div
            className="pane-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('app.sidebarDivider')}
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_MIN_PX}
            aria-valuemax={SIDEBAR_MAX_PX}
            tabIndex={0}
            onPointerDown={onSidebarPointerDown}
            onPointerMove={onSidebarPointerMove}
            onPointerUp={endSidebarDrag}
            onPointerCancel={endSidebarDrag}
            onLostPointerCapture={endSidebarDrag}
            onDoubleClick={onSidebarDoubleClick}
            onKeyDown={onSidebarKeyDown}
          />
        )}
        {mainPanel === 'settings' ? (
          <Settings />
        ) : mainPanel === 'schedule' ? (
          <ScheduleEditor />
        ) : mainPanel === 'extension' ? (
          <ExtensionPanel />
        ) : null}
        <ThreadPane />
        {/*
          ViewerPane is always there, empty or not, and so is the divider (TODO 1297, chapter 5). Folded (dragged shut
          or too narrow a window), a thin strip takes its place; pressing it brings the viewer back.
        */}
        <div
          className="pane-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('app.paneDivider')}
          aria-valuenow={folded ? 100 : Math.round(ratio * 100)}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
        />
        {folded ? <ViewerStrip onExpand={onStripExpand} /> : <ViewerPane />}
      </div>
      {/* A single band across the bottom of the screen (5.6, TODO 51 / 52). `.workspace` shrinks with `flex: 1`. */}
      <BottomBar />
    </div>
  )
}
