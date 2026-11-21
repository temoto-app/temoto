/**
 * The owner, one per window, of the ViewerPane's web view (TODO 400, ARCHITECTURE 5.2.1).
 *
 * The page is drawn in a `WebContentsView` that main owns, layered over the renderer's (ViewerPane's) rectangle. **Does not
 * import electron** — the real view is made by `register.ts` and passed in via `createView`, and tests pass a fake
 * (`test/web-view.test.ts`). What this file decides:
 *
 *   - What may be loaded: both `load` and navigation inside the page (`will-navigate` / `will-redirect`) allow
 *     only `isWebViewerUrl` (`http:` / `https:`). `mailto:` goes to the OS mail client; everything else is stopped.
 *   - New windows: `setWindowOpenHandler` **always denies**. A plain `target=_blank` opens in the same view, and
 *     Cmd / shift (and `window.open` windows) open in the OS browser.
 *   - History: page navigation is reported to the renderer as `navigated`, and the renderer makes it one step of the viewer's history (TODO 369).
 *     The page side's `navigationHistory` is not used (the default of TODO 411).
 *   - Keys: when the page has focus nothing reaches the renderer's keydown, so `before-input-event` matches the key against the table
 *     the renderer passed and sends it back.
 *   - TODO 530: views are **per tab**, and the most recent `WEB_LIVE_VIEWS` are kept alive and hidden in an LRU. If `load` is
 *     given a tab id and that tab's view is alive and showing the same URL, it is just swapped in without reloading
 *     (scroll, input, and SPA state remain). "The same URL" is compared not with the settled `getURL()` but with the URL last
 *     pointed at that view (`target`, TODO 599) — so that when the previous URL is requested of a view that is loading, the load in progress
 *     is not committed as it is. Views of older tabs are closed and reloaded the next time they are shown.
 *     Notifications to the renderer (`send`) are only for the view being shown, and the tab-badge notifications (`onNavigated` /
 *     `onTitle` / `onFavicon` / `onFailed`) are passed with that tab's id even for hidden views.
 *   - TODO 580: when the pane goes away, the renderer passes the reason. If closed with the X (`close`), all views are closed; if it was only
 *     switched to a file (`hide`), the views are hidden and kept alive, and closed if not returned to within `WEB_HIDDEN_VIEWS_TTL_MS` (10 minutes).
 *   - TODO 1221: fullscreen of the Web content (a fullscreen the page asked for / Ctrl+Cmd+F). Make the window fullscreen and spread the view over the whole window,
 *     and on exit restore the window and the view's rectangle. **The worst case is failing to exit and leaving the view over the whole window**, so
 *     it exits on any of: the shown view changes, the pane is hidden / closed, a cover appears, the view crashes, or the window's fullscreen is undone from outside.
 *
 * It holds and keeps no body text (constraints 9 / 10). Logs go only as far as the host name (5.1.1).
 */
import { isEmbedRefusedLogin, isLoginPageUrl, isOpenableExternally, isWebViewerUrl } from '@shared/open-external.js'
import {
  isFullscreenExitKey,
  matchWebShortcut,
  sanitizeWebShortcuts,
  toViewBounds,
  webHostOf,
  webShortcutFocusesRendererInput,
  windowOpenDecision,
  type WebFullscreenMode,
  type WebNavigationDecision,
  type WebViewEvent,
  type WebViewInput,
  type WebViewShortcut
} from '@shared/web-view.js'
import { log } from '../../common/logger.js'
import {
  PAGE_LOAD_WAIT_MS,
  PAGE_SETTLE_INTERVAL_MS,
  PAGE_SETTLE_PROBES,
  PAGE_TEXT_PROBE,
  PAGE_TEXT_SCRIPT,
  looksLikeLoginPage,
  PAGE_TEXT_WORLD_ID,
  parsePageText,
  type TabTextOutcome
} from './page-text.js'

/** The part of electron's `WebContents` that is used here. */
export interface WebContentsLike {
  loadURL(url: string): Promise<void>
  getURL(): string
  reload(): void
  stop(): void
  focus(): void
  isDestroyed(): boolean
  close(): void
  /** TODO 530: "loading" when a view is swapped in. If absent, treated as false (a test fake). */
  isLoading?(): boolean
  findInPage(text: string, options: { forward: boolean; findNext: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  capturePage(): Promise<{ isEmpty(): boolean; toJPEG(quality: number): Uint8Array }>
  setWindowOpenHandler(
    handler: (details: { url: string; disposition: string }) => { action: 'deny' }
  ): void
  on(event: string, listener: (...args: never[]) => void): unknown
  /**
   * TODO 1052: run the app's fixed JS (`page-text.ts`) in an isolated world. If absent the body cannot be read (a test fake from TODO 400).
   */
  executeJavaScriptInIsolatedWorld?(worldId: number, scripts: { code: string }[], userGesture?: boolean): Promise<unknown>
}

/** The part of electron's `WebContentsView` that is used here. */
export interface WebViewLike {
  readonly webContents: WebContentsLike
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  setVisible(visible: boolean): void
  /** Preparation to finish before the first navigation (chrome-shim). If absent, do not wait (a test fake). */
  readonly ready?: Promise<void>
}

export interface WebViewHostDeps {
  /** Create a view and layer it over the window (in the hidden state). */
  createView(): WebViewLike
  /** Remove it from the window. Closing the webContents is the job of this side (the host). */
  removeView(view: WebViewLike): void
  /** Open in the OS browser / mail client. `openExternalChecked` re-validates inside. */
  openExternal(url: string): void
  /** Notify this window's renderer. */
  send(event: WebViewEvent): void
  /** The window renderer's zoom factor (CSS px -> DIP). */
  zoom(): number
  /** The size of the window's content area (DIP). */
  contentSize(): { width: number; height: number }
  /**
   * Page transitions (TODO 522: tab badges and history). `full` is a per-document navigation (`did-navigate`); false means in-page
   * (the main frame of `did-navigate-in-page`). If absent, nothing is reported (staying as the TODO 400 tests had it).
   * `tabId` is the tab that made that view load (TODO 530, the id passed to `load`; null if none was passed).
   */
  onNavigated?(url: string, full: boolean, tabId: string | null): void
  /** The page's title changed (`page-title-updated`). */
  onTitle?(title: string, tabId: string | null): void
  /** Candidate URLs for the page's favicon (`page-favicon-updated`). */
  onFavicon?(urls: readonly string[], tabId: string | null): void
  /**
   * TODO 601: loading the main frame failed (`did-fail-load`, excluding ERR_ABORTED). A failed navigation delivers neither
   * `did-navigate` nor `page-title-updated`, so the tab badge's title stays as the previous page's. The receiver
   * makes the title the host name (the history title is not rewritten — a failure should not overwrite the title from when it opened before).
   */
  onFailed?(url: string, tabId: string | null): void
  /** TODO 580: the clock until hidden views are closed (replaced by tests). `setTimeout` if absent. */
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
  /**
   * TODO 588: return native focus to the window's renderer (`BrowserWindow.webContents.focus()`).
   * Called only after a send-back for which `webShortcutFocusesRendererInput` is true — if not called, even when the renderer's
   * `activeElement` becomes the field, characters typed on the physical keyboard go to the page (webContents keeps the focus).
   */
  focusRenderer?(): void
  /** TODO 1052: the wait before reading the body (loading, SPA rendering). `setTimeout` if absent. Tests resolve it immediately. */
  sleep?(ms: number): Promise<void>
  /** TODO 1221: whether the window is (OS) fullscreen. If absent, treated as false. */
  isWindowFullScreen?(): boolean
  /** TODO 1221: make the window fullscreen / restore it. If absent, the window is not touched (a test fake). */
  setWindowFullScreen?(on: boolean): void
  /** TODO 1221: show / hide the "Press Esc to exit fullscreen" bubble (layered over the page, as Chrome does). */
  fullscreenHint?(show: boolean): void
}

/** TODO 1221: the state of the Web content's fullscreen (which view is fullscreen, and through which entry). */
interface FullscreenState {
  readonly view: WebViewLike
  /** Whether a fullscreen the page asked for (Fullscreen API) is in progress. */
  page: boolean
  /** Whether a fullscreen from Ctrl+Cmd+F / the View menu is in progress. If this remains after the page's fullscreen exits, it stays fullscreen (as Chrome does). */
  content: boolean
  /** The window was not fullscreen before entering (on exit the window is restored too). A window that was already fullscreen is not restored. */
  restoreWindow: boolean
}

/** TODO 1221: how long the bubble stays up on entering fullscreen (it disappears after a few seconds, like Chrome's "Press Esc to exit full screen"). */
export const FULLSCREEN_HINT_MS = 3500

/** TODO 1221: fixed JS that makes the page exit its fullscreen from outside (run in the isolated world. The DOM is shared, so it works). */
const EXIT_PAGE_FULLSCREEN_SCRIPT =
  'void (document.fullscreenElement ? document.exitFullscreen().catch(() => undefined) : undefined)'

/** TODO 530: the number of views kept alive (owner decision 2026-10-09: 3, LRU). 1 view = 1 renderer process. */
export const WEB_LIVE_VIEWS = 3

/**
 * TODO 580: the time, after the pane is hidden (switched to a file, moved to a thread with no file, ...), until the views kept alive are closed
 * (owner decision 2026-10-10: 10 minutes). If the user returns to the Web pane in that time, it is shown without reloading.
 */
export const WEB_HIDDEN_VIEWS_TTL_MS = 10 * 60 * 1000

/** The view key when no tab id was passed to `load` (the "one per window" shape of TODO 400). */
const NO_TAB = ''

/** The `did-fail-load` that is not reported: ERR_ABORTED (overtaken by the next navigation, or stopped). */
const ABORTED = -3

/** The snapshot used when hiding (TODO 411's default "only when flicker is noticeable" -> added because it was noticeable with the bubble). */
const SNAPSHOT_QUALITY = 70

/** How navigation inside a page is handled (`will-navigate` / `will-redirect` / new windows). */
export function navigationDecision(url: unknown): WebNavigationDecision {
  if (isWebViewerUrl(url)) return 'allow'
  if (isOpenableExternally(url)) return 'external'
  return 'deny'
}

function protocolOf(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}

/** The first argument of electron's `will-navigate` (Event + `url`). The old shape (url as the second argument) is also accepted. */
interface NavigateEventLike {
  readonly url?: string
  readonly isMainFrame?: boolean
  preventDefault(): void
}

export class WebViewHost {
  /** The view being shown now (layered over the renderer's rectangle). */
  private view: WebViewLike | null = null
  /** TODO 530: the live views (tab id -> view). The Map's order is the LRU (oldest first). `view` is also in here. */
  private readonly views = new Map<string, WebViewLike>()
  private shortcuts: readonly WebViewShortcut[] = []
  /** A view in the middle of a navigation started from inside the page (a link, `target=_blank`). Makes the next `did-navigate` a "new step". */
  private readonly pageInitiated = new WeakSet<WebViewLike>()
  /**
   * A view whose last main frame load failed (code-review 2026-10-10, TODO 547 x 530). `getURL()` returns the failed
   * URL, so as is, `load` would see "the same URL" and merely swap it in, and the error page would remain even after trusting a certificate.
   * A failed view is reloaded even for the same URL.
   */
  private readonly failedLoad = new WeakSet<WebViewLike>()
  /**
   * TODO 599: the URL the view is heading to (the URL last passed to `loadURL` or settled on. A URL that only started
   * from inside the page is `pending`).
   * `getURL()` is the URL of the settled page, so if the previous URL is requested of a view in the middle of loading a different URL, it looks "the same" and
   * the correct load is discarded (the second half of 598-4). `load`'s "just swap in" compares against this.
   */
  private readonly target = new WeakMap<WebViewLike, string>()
  /**
   * A URL that started from inside the page (`will-navigate` / the main frame's `will-redirect`) but is not settled yet
   * (code-review, TODO 599). Some navigations never settle (downloads, 204, ERR_ABORTED), so it is not put into `target`; it is
   * moved to `target` on `did-navigate`, and dropped if it ends unsettled (`did-stop-loading` / that URL's `did-fail-load`).
   */
  private readonly pending = new WeakMap<WebViewLike, string>()
  /**
   * TODO 857: the URL the current navigation started from (`load`, a link in the page, a new window in the same view). Not rewritten by redirects —
   * so that when sent to a login screen, the original URL including the part after `#` (such as `compose=…` for Gmail) is opened in the default browser.
   */
  private readonly started = new WeakMap<WebViewLike, string>()
  /**
   * TODO 1055 (3): a view created without being shown, for the AI to read. Even if it hits a login screen it does not open the default browser
   * (that would open a browser without the user knowing; the model is returned `login-required`). Removed once shown (it becomes the user's action).
   */
  private readonly background = new WeakSet<WebViewLike>()

  /** If there is preparation (`ready`), wait for it to finish and then load. If not, load synchronously. */
  private startLoad(view: WebViewLike, url: string): Promise<void> {
    return view.ready === undefined ? view.webContents.loadURL(url) : view.ready.then(() => view.webContents.loadURL(url))
  }
  /** Whether the renderer wants it shown. If a "show" arrives while a snapshot is being taken, do not hide it even after the snapshot is done. */
  private wantVisible = false
  private closed = false
  private lastBounds: unknown = null
  /** TODO 580: the clock from hiding the pane to closing all views (null if not hidden). */
  private hiddenTimer: unknown = null
  /** TODO 1221: the Web content's fullscreen (null if none). */
  private fullscreen: FullscreenState | null = null
  /** TODO 1221: the clock that hides the bubble. */
  private hintTimer: unknown = null

  constructor(private readonly deps: WebViewHostDeps) {}

  /** Whether there is a view (for tests). */
  get hasView(): boolean {
    return this.view !== null
  }

  /** Whether the pane is hidden and the clock that closes the views is running (for tests). */
  get hidden(): boolean {
    return this.hiddenTimer !== null
  }

  /** The tab ids of the live views (oldest first. For tests). */
  get liveTabs(): readonly string[] {
    return [...this.views.keys()]
  }

  /** TODO 1221: the current kind of fullscreen (the page's fullscreen takes priority). Null if not fullscreen. */
  get fullscreenMode(): WebFullscreenMode | null {
    const state = this.fullscreen
    if (state === null) return null
    return state.page ? 'page' : 'content'
  }

  /**
   * TODO 1221: Ctrl+Cmd+F / "Fullscreen" in the View menu. While the Web content is fullscreen it exits, and if a Web page is being shown
   * it makes only the Web content fullscreen. When neither applies (a non-Web viewer is in front, a blank tab, or hidden by a cover) it
   * returns false and the caller toggles the window's fullscreen as before.
   */
  toggleContentFullscreen(): boolean {
    if (this.fullscreen !== null) {
      this.exitFullscreen('toggle')
      return true
    }
    const view = this.view
    if (this.closed || view === null || !this.wantVisible || view.webContents.isDestroyed()) return false
    this.enterFullscreen(view, 'content')
    return true
  }

  /** TODO 1221: Esc (when the renderer has focus). If fullscreen, exit and return true (the key is not passed on). */
  escapeFullscreen(): boolean {
    if (this.fullscreen === null) return false
    this.exitFullscreen('escape')
    return true
  }

  /**
   * TODO 1221: the window's fullscreen was undone from outside (the green button, Mission Control). The Web content's fullscreen exits too —
   * otherwise the view would remain over the whole window even after the window returns. The window is no longer fullscreen, so it is not restored.
   */
  windowLeftFullScreen(): void {
    const state = this.fullscreen
    if (state === null) return
    state.restoreWindow = false
    this.exitFullscreen('window')
  }

  /** TODO 1221: the window's size changed (the transition into fullscreen is asynchronous). If fullscreen, re-fit the view to the whole window. */
  windowResized(): void {
    if (this.fullscreen !== null) this.applyFullscreenBounds()
  }

  /**
   * Load `url`. Returns false if refused (the renderer's value is not trusted). Show the view of `tabId` (TODO 530), creating it if absent
   * (if over the number kept alive, close the oldest view). If that view is alive and already showing `url`, it is not reloaded.
   */
  load(url: unknown, tabId: string | null = null): boolean {
    if (this.closed) return false
    if (!isWebViewerUrl(url)) {
      log.warn('web.load.rejected', { protocol: protocolOf(url) })
      return false
    }
    this.cancelHiddenTimer()
    const key = tabId ?? NO_TAB
    const kept = this.views.get(key)
    if (
      kept !== undefined &&
      !kept.webContents.isDestroyed() &&
      !this.failedLoad.has(kept) &&
      (this.pending.get(kept) ?? this.target.get(kept)) === url
    ) {
      this.showView(key, kept)
      log.info('web.load.kept', { host: webHostOf(url) })
      return true
    }
    const view = this.ensureView(key)
    this.pageInitiated.delete(view)
    this.failedLoad.delete(view)
    this.pending.delete(view)
    this.target.set(view, url)
    this.started.set(view, url)
    this.startLoad(view, url).catch(() => {
      // A failure is reported by `did-fail-load` (this is only Promise cleanup).
    })
    log.info('web.load', { host: webHostOf(url) })
    return true
  }

  /** TODO 530: a tab was closed. If that tab has a view, close it (if it was the shown view, show nothing). */
  dropTab(tabId: unknown): void {
    if (typeof tabId !== 'string' || tabId === NO_TAB) return
    const view = this.views.get(tabId)
    if (view !== undefined) this.discard(tabId, view)
  }

  /**
   * TODO 1061 (1): the view being shown now (the tab id and webContents). Null while the pane is not showing the Web, while it is hidden by a cover (right-click menu,
   * dialog), and for a closed view. Screenshots capture **only the view visible to the user**
   * (a background view may not be drawn, and this must not become an entry point for capturing something not visible).
   */
  shownContents(): { readonly tabId: string | null; readonly contents: WebContentsLike } | null {
    const view = this.view
    if (this.closed || view === null || !this.wantVisible || view.webContents.isDestroyed()) return null
    let key: string = NO_TAB
    for (const [candidate, live] of this.views) if (live === view) key = candidate
    return { tabId: key === NO_TAB ? null : key, contents: view.webContents }
  }

  /**
   * TODO 1052: read the body of tab `tabId` (its URL is `url` = the URL of the tab badge). If that tab's view is alive, use it; for a tab dropped by the
   * LRU or one with no view yet, create a view **without showing it** and load it again (it is a tab the user opened, so this is not hidden
   * browsing, owner decision 2026-10-29). The shown view (`view`) is not replaced, and only views not being shown are evicted.
   * A view created while the Web pane is not showing (closed with the X, or not yet opened) is closed after reading.
   *
   * It waits for the load to finish (upper bound `PAGE_LOAD_WAIT_MS`) and the body to settle (an SPA draws after load), and then runs the app's fixed
   * JS (`PAGE_TEXT_SCRIPT`) in the isolated world. The body is only returned; it is neither kept here nor logged.
   */
  async readTabText(tabId: string, url: string): Promise<TabTextOutcome> {
    if (this.closed || tabId === NO_TAB) return { ok: false, reason: 'closed' }
    if (!isWebViewerUrl(url)) return { ok: false, reason: 'not-web' }
    let view = this.views.get(tabId)
    if (view !== undefined && view.webContents.isDestroyed()) {
      this.discard(tabId, view)
      view = undefined
    }
    const createdHere = view === undefined
    let loadDone: Promise<void> | null = null
    if (view === undefined) {
      const created = this.backgroundView(tabId, url)
      if (created === null) return { ok: false, reason: 'closed' }
      view = created.view
      loadDone = created.loaded
      log.info('web.read.reload', { host: webHostOf(url) })
    }
    try {
      return await this.extractText(tabId, view, url, loadDone)
    } finally {
      // Whether to discard is decided when reading is done (while reading, the user may bring up the pane or open another tab).
      // Close only when the pane is not showing the Web (when it is hidden and the clock is running, the clock closes it later).
      const paneIdle = this.view === null && this.hiddenTimer === null
      if (createdHere && paneIdle && this.views.get(tabId) === view) this.discard(tabId, view)
    }
  }

  private async extractText(
    tabId: string,
    view: WebViewLike,
    url: string,
    loadDone: Promise<void> | null
  ): Promise<TabTextOutcome> {
    const contents = view.webContents
    const run = contents.executeJavaScriptInIsolatedWorld
    if (run === undefined) return { ok: false, reason: 'unreadable' }
    const evaluate = (code: string): Promise<unknown> => run.call(contents, PAGE_TEXT_WORLD_ID, [{ code }])
    const gone = (): boolean => this.closed || contents.isDestroyed() || this.views.get(tabId) !== view
    if (loadDone !== null) await Promise.race([loadDone, this.sleep(PAGE_LOAD_WAIT_MS)])
    for (let waited = 0; contents.isLoading?.() === true && waited < PAGE_LOAD_WAIT_MS; waited += PAGE_SETTLE_INTERVAL_MS) {
      if (gone()) return { ok: false, reason: 'closed' }
      await this.sleep(PAGE_SETTLE_INTERVAL_MS)
    }
    if (gone()) return { ok: false, reason: 'closed' }
    if (this.failedLoad.has(view)) return { ok: false, reason: 'failed' }
    // Wait until the body length is the same twice in a row (an empty page's 0 also counts as settled. A fix from the review of TODO 1055). Past the limit,
    // take the body at that point. If the length did not come back as a number (the evaluation threw, or a non-number), it cannot be said to be "changing", so treat it as settled and leave.
    let previous = -1
    let settled = false
    for (let probe = 0; probe < PAGE_SETTLE_PROBES; probe += 1) {
      let length: unknown
      try {
        length = await evaluate(PAGE_TEXT_PROBE)
      } catch {
        settled = true
        break
      }
      if (typeof length !== 'number') {
        settled = true
        break
      }
      if (length === previous) {
        settled = true
        break
      }
      previous = length
      await this.sleep(PAGE_SETTLE_INTERVAL_MS)
      if (gone()) return { ok: false, reason: 'closed' }
    }
    let raw: unknown
    try {
      raw = await evaluate(PAGE_TEXT_SCRIPT)
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
    if (gone()) return { ok: false, reason: 'closed' }
    const parsed = parsePageText(raw)
    if (parsed === null) return { ok: false, reason: 'unreadable' }
    const current = contents.getURL()
    // TODO 1055 (3) / 1087: hit a login screen (by the URL table, or a visible password field).
    // The body (the login prompt) is not returned; the model is told "login required".
    if (isLoginPageUrl(current) || looksLikeLoginPage(parsed)) {
      log.info('web.read.loginRequired', { host: webHostOf(current) })
      return { ok: false, reason: 'login-required' }
    }
    return {
      ok: true,
      url: isWebViewerUrl(current) ? current : url,
      title: parsed.title,
      text: parsed.text,
      clipped: parsed.clipped,
      loading: contents.isLoading?.() === true,
      settled
    }
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * TODO 1052: create a view without showing it and make it load the tab's URL. The shown view is neither replaced nor evicted.
   * The "open the default browser if it is a login screen" of TODO 857 is not attached (`started` is not written) — because it is not the user's action.
   */
  private backgroundView(key: string, url: string): { view: WebViewLike; loaded: Promise<void> } | null {
    for (const [oldKey, oldView] of [...this.views]) {
      if (this.views.size < WEB_LIVE_VIEWS) break
      if (oldView === this.view) continue
      this.discard(oldKey, oldView)
      log.info('web.view.evicted', {})
    }
    let view: WebViewLike
    try {
      view = this.deps.createView()
    } catch {
      return null
    }
    this.views.set(key, view)
    this.background.add(view)
    this.wire(view, key)
    view.setVisible(false)
    // Make the drawn size the same as when shown (the width changes how wrapping and virtual lists are drawn).
    const size = this.deps.contentSize()
    const bounds =
      (this.lastBounds === null ? null : toViewBounds(this.lastBounds, this.deps.zoom(), size)) ??
      { x: 0, y: 0, width: Math.max(1, size.width), height: Math.max(1, size.height) }
    view.setBounds(bounds)
    this.target.set(view, url)
    const loaded = this.startLoad(view, url).catch(() => undefined)
    return { view, loaded }
  }

  setShortcuts(raw: unknown): void {
    this.shortcuts = sanitizeWebShortcuts(raw)
  }

  setBounds(raw: unknown): void {
    // Remember a rectangle that arrives before the view is created (before the first `load`) too, and apply it when the view is created.
    this.lastBounds = raw
    if (this.view === null) return
    // TODO 1221: during fullscreen only remember the pane's rectangle (where to restore it on exit).
    if (this.fullscreen !== null && this.fullscreen.view === this.view) {
      this.applyFullscreenBounds()
      return
    }
    const bounds = toViewBounds(raw, this.deps.zoom(), this.deps.contentSize())
    if (bounds !== null) this.view.setBounds(bounds)
  }

  /**
   * Show / hide (hidden during a renderer cover — right-click menu, dialog, bubble, divider drag).
   * If `snapshot`, before hiding, capture the page as a JPEG and return it as a data URL (the renderer places it in its stead).
   */
  async setVisible(visible: boolean, snapshot: boolean): Promise<string | null> {
    this.wantVisible = visible
    if (visible) this.cancelHiddenTimer()
    // TODO 1221: a cover (dialog, menu) appeared or the pane was hidden. If only the view were hidden while staying fullscreen, the renderer would appear with the window still
    // fullscreen, so exit fullscreen and then hide (Chrome also exits fullscreen when a dialog appears).
    if (!visible) this.exitFullscreen('covered')
    const view = this.view
    if (view === null) return null
    if (visible) {
      view.setVisible(true)
      return null
    }
    let image: string | null = null
    if (snapshot && !view.webContents.isDestroyed()) {
      try {
        const captured = await view.webContents.capturePage()
        if (!captured.isEmpty()) {
          image = `data:image/jpeg;base64,${Buffer.from(captured.toJPEG(SNAPSHOT_QUALITY)).toString('base64')}`
        }
      } catch {
        image = null
      }
    }
    // "Show" arrived during the capture, or it was closed: do not hide it.
    if (this.wantVisible || this.view !== view) return null
    view.setVisible(false)
    return image
  }

  reload(): void {
    this.alive()?.reload()
  }

  stop(): void {
    this.alive()?.stop()
  }

  focus(): void {
    this.alive()?.focus()
  }

  find(raw: unknown): void {
    const contents = this.alive()
    if (contents === null || typeof raw !== 'object' || raw === null) return
    const r = raw as Record<string, unknown>
    const text = r['text']
    if (typeof text !== 'string' || text.length === 0 || text.length > 1000) return
    contents.findInPage(text, { forward: r['forward'] !== false, findNext: r['findNext'] === true })
  }

  stopFind(): void {
    this.alive()?.stopFindInPage('clearSelection')
  }

  /**
   * TODO 580: the pane went away but was not closed (switched to a file, etc.). Hide the view being shown, keep the live views
   * alive, and close all after `WEB_HIDDEN_VIEWS_TTL_MS`. If `load` (returning to the Web pane) arrives before that, stop the clock and
   * show live tabs without reloading.
   */
  hide(): void {
    if (this.closed) return
    this.exitFullscreen('hide')
    this.wantVisible = false
    const view = this.view
    this.view = null
    if (view !== null && !view.webContents.isDestroyed()) {
      view.setVisible(false)
      // The search field disappears with the pane, so the page's highlighting is not left either.
      view.webContents.stopFindInPage('clearSelection')
    }
    this.cancelHiddenTimer()
    if (this.views.size === 0) return
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this.hiddenTimer = setTimer(() => {
      this.hiddenTimer = null
      log.info('web.hidden.expired', { count: this.views.size })
      this.close()
    }, WEB_HIDDEN_VIEWS_TTL_MS)
    log.info('web.hidden', { count: this.views.size })
  }

  /** The pane was closed (X) / the window was closed / the renderer was reloaded. Close all views, including those kept alive. */
  close(): void {
    this.exitFullscreen('close')
    this.cancelHiddenTimer()
    this.wantVisible = false
    const count = this.views.size
    for (const [key, view] of [...this.views]) this.discard(key, view)
    this.view = null
    if (count > 0) log.info('web.closed', { count })
  }

  /** The window was closed. Nothing is created afterwards. */
  dispose(): void {
    this.close()
    this.closed = true
  }

  private cancelHiddenTimer(): void {
    if (this.hiddenTimer === null) return
    const clear = this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    clear(this.hiddenTimer)
    this.hiddenTimer = null
  }

  /** TODO 1221: enter fullscreen (a page request / Ctrl+Cmd+F). Requests from views that are not shown (background reading, hidden tabs) are refused. */
  private enterFullscreen(view: WebViewLike, mode: WebFullscreenMode): void {
    if (this.closed || view !== this.view || !this.wantVisible || view.webContents.isDestroyed()) {
      if (mode === 'page') this.exitPageFullscreen(view)
      log.info('web.fullscreen.refused', { mode })
      return
    }
    const current = this.fullscreen
    if (current !== null && current.view === view) {
      if (mode === 'page') current.page = true
      else current.content = true
      this.deps.send({ kind: 'fullscreen', mode: this.fullscreenMode })
      return
    }
    if (current !== null) this.exitFullscreen('switch')
    const restoreWindow = this.deps.isWindowFullScreen?.() !== true
    this.fullscreen = { view, page: mode === 'page', content: mode === 'content', restoreWindow }
    if (restoreWindow) this.deps.setWindowFullScreen?.(true)
    this.applyFullscreenBounds()
    view.webContents.focus()
    this.showHint()
    log.info('web.fullscreen.enter', { mode, restoreWindow })
    this.deps.send({ kind: 'fullscreen', mode })
  }

  /** TODO 1221: the page left its own fullscreen. If the Ctrl+Cmd+F fullscreen remains, go back to that; if not, leave everything. */
  private pageLeftFullscreen(view: WebViewLike): void {
    const state = this.fullscreen
    if (state === null || state.view !== view || !state.page) return
    state.page = false
    if (!state.content) {
      this.exitFullscreen('page')
      return
    }
    this.deps.send({ kind: 'fullscreen', mode: 'content' })
  }

  /**
   * TODO 1221: exit fullscreen (from any path). Undo the page's fullscreen, restore a window that was not fullscreen before entering, and
   * return the view to the pane's rectangle. If not fullscreen, do nothing (it may be called any number of times).
   */
  private exitFullscreen(reason: string): void {
    const state = this.fullscreen
    if (state === null) return
    this.fullscreen = null
    this.hideHint()
    if (state.page) this.exitPageFullscreen(state.view)
    if (state.restoreWindow) {
      try {
        this.deps.setWindowFullScreen?.(false)
      } catch {
        // If the window was destroyed first, there is nothing to restore.
      }
    }
    if (this.view === state.view && !state.view.webContents.isDestroyed()) {
      const bounds =
        this.lastBounds === null ? null : toViewBounds(this.lastBounds, this.deps.zoom(), this.deps.contentSize())
      // If the pane's rectangle is not known (it has not arrived yet), hide the view so it is not left over the whole window.
      if (bounds !== null) state.view.setBounds(bounds)
      else state.view.setVisible(false)
    }
    log.info('web.fullscreen.exit', { reason })
    this.deps.send({ kind: 'fullscreen', mode: null })
  }

  /** TODO 1221: make the page exit its fullscreen (call the page's `document.exitFullscreen` from the isolated world). */
  private exitPageFullscreen(view: WebViewLike): void {
    const contents = view.webContents
    const run = contents.executeJavaScriptInIsolatedWorld
    if (run === undefined || contents.isDestroyed()) return
    try {
      void run.call(contents, PAGE_TEXT_WORLD_ID, [{ code: EXIT_PAGE_FULLSCREEN_SCRIPT }]).catch(() => undefined)
    } catch {
      // A view about to break: do nothing (the view will be closed).
    }
  }

  /** TODO 1221: during fullscreen, fit the view to the whole content area of the window. */
  private applyFullscreenBounds(): void {
    const state = this.fullscreen
    if (state === null || state.view.webContents.isDestroyed()) return
    const size = this.deps.contentSize()
    state.view.setBounds({ x: 0, y: 0, width: Math.max(1, size.width), height: Math.max(1, size.height) })
  }

  /** TODO 1221: show the bubble and hide it after `FULLSCREEN_HINT_MS`. */
  private showHint(): void {
    this.clearHintTimer()
    this.deps.fullscreenHint?.(true)
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this.hintTimer = setTimer(() => {
      this.hintTimer = null
      this.deps.fullscreenHint?.(false)
    }, FULLSCREEN_HINT_MS)
  }

  /** TODO 1221: when fullscreen exits, the bubble goes too (it is shown only while the clock is running). */
  private hideHint(): void {
    if (this.hintTimer === null) return
    this.clearHintTimer()
    this.deps.fullscreenHint?.(false)
  }

  private clearHintTimer(): void {
    if (this.hintTimer === null) return
    const clear = this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    clear(this.hintTimer)
    this.hintTimer = null
  }

  private alive(): WebContentsLike | null {
    const contents = this.view?.webContents ?? null
    return contents === null || contents.isDestroyed() ? null : contents
  }

  /** Make a live view the shown view (the previously shown view is hidden and kept alive). */
  private showView(key: string, view: WebViewLike): void {
    // LRU: move the used one to the end.
    this.views.delete(key)
    this.views.set(key, view)
    this.background.delete(view) // Once shown it is the user's action (back to being a target of 857)
    if (this.view === view) return
    this.exitFullscreen('switch') // TODO 1221: moved to another tab (Chrome also exits fullscreen when you switch tabs)
    const previous = this.view
    this.view = view
    previous?.setVisible(false)
    if (this.lastBounds !== null) this.setBounds(this.lastBounds)
    view.setVisible(this.wantVisible)
    // Align the renderer's "loading" with the swapped-in view (so the previous view's value does not remain).
    this.deps.send({ kind: 'loading', loading: view.webContents.isLoading?.() === true })
  }

  /** Remove the view and close it. */
  private discard(key: string, view: WebViewLike): void {
    if (this.fullscreen?.view === view) this.exitFullscreen('discard')
    this.views.delete(key)
    if (this.view === view) this.view = null
    try {
      this.deps.removeView(view)
    } catch {
      // If the window was destroyed first, there is nothing to remove.
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private ensureView(key: string): WebViewLike {
    const kept = this.views.get(key)
    if (kept !== undefined && !kept.webContents.isDestroyed()) {
      this.showView(key, kept)
      return kept
    }
    if (kept !== undefined) this.discard(key, kept)
    // Close those over the number kept alive, oldest first (make room for the one about to be created).
    for (const [oldKey, oldView] of [...this.views]) {
      if (this.views.size < WEB_LIVE_VIEWS) break
      this.discard(oldKey, oldView)
      log.info('web.view.evicted', {})
    }
    this.exitFullscreen('switch') // TODO 1221: the shown view changes
    const view = this.deps.createView()
    this.views.set(key, view)
    this.wire(view, key)
    const previous = this.view
    this.view = view
    previous?.setVisible(false)
    if (this.lastBounds !== null) this.setBounds(this.lastBounds)
    view.setVisible(this.wantVisible)
    return view
  }

  private wire(view: WebViewLike, key: string): void {
    const contents = view.webContents
    const tabId = key === NO_TAB ? null : key
    const send = (event: WebViewEvent): void => {
      if (this.view === view) this.deps.send(event)
    }
    /** Whether the view is still alive (notifications from closed or evicted views are not attached to a tab). */
    const live = (): boolean => this.views.get(key) === view

    // A navigation started from inside the page. Only http(s) passes (the same single decision as 5.1.1).
    const guard = (kind: 'navigate' | 'redirect') => (event: NavigateEventLike, legacyUrl?: string) => {
      const url = event.url ?? legacyUrl
      const decision = navigationDecision(url)
      if (decision === 'allow') {
        if (kind === 'navigate') {
          this.pageInitiated.add(view)
          if (typeof url === 'string' && !isEmbedRefusedLogin(url)) this.started.set(view, url)
        }
        // A redirect of a child frame (`isMainFrame` is false) is not the view's destination. Until it settles it is `pending`.
        if (typeof url === 'string' && event.isMainFrame !== false) this.pending.set(view, url)
        return
      }
      event.preventDefault()
      log.warn('web.navigate.blocked', { kind, protocol: protocolOf(url) })
      if (decision === 'external' && typeof url === 'string') this.deps.openExternal(url)
    }
    contents.on('will-navigate', guard('navigate') as never)
    contents.on('will-redirect', guard('redirect') as never)

    // No new windows are created. A plain target=_blank goes to the same view, and Cmd / shift / window.open windows go to the OS browser.
    contents.setWindowOpenHandler(({ url, disposition }) => {
      const decision = windowOpenDecision(navigationDecision(url), disposition)
      if (decision === 'same-view') {
        this.pageInitiated.add(view)
        this.pending.delete(view)
        this.target.set(view, url)
        if (!isEmbedRefusedLogin(url)) this.started.set(view, url)
        this.startLoad(view, url).catch(() => undefined)
      } else if (decision === 'external') {
        this.deps.openExternal(url)
      } else {
        log.warn('web.windowOpen.blocked', { protocol: protocolOf(url) })
      }
      return { action: 'deny' }
    })

    contents.on('did-navigate', ((_event: unknown, url: string) => {
      if (url === 'about:blank') return // The chrome-shim preparation
      const replace = !this.pageInitiated.has(view)
      this.pageInitiated.delete(view)
      this.pending.delete(view)
      this.target.set(view, url)
      log.info('web.navigated', { host: webHostOf(url), replace })
      send({ kind: 'navigated', url, replace })
      // TODO 857: a Google login screen appeared = login is not possible in this Web view (721). Open the URL the navigation started from
      // (including `#compose=…`) in the default browser just once. If already logged in the screen does not appear (822 stays as it is).
      const origin = this.started.get(view)
      if (origin !== undefined && isEmbedRefusedLogin(url) && this.background.has(view)) {
        this.started.delete(view) // Background view (the AI's reading): do not open. The reading side returns `login-required`
      } else if (origin !== undefined && isEmbedRefusedLogin(url)) {
        this.started.delete(view)
        log.info('web.login.external', { host: webHostOf(origin) })
        this.deps.openExternal(origin)
      }
      if (live()) this.deps.onNavigated?.(url, true, tabId)
    }) as never)
    // In-page navigation (#heading, pushState) is not made a step (it replaces). Even if an SPA hammers replaceState, the history does not fill up.
    contents.on('did-navigate-in-page', ((_event: unknown, url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return
      this.target.set(view, url)
      send({ kind: 'navigated', url, replace: true })
      if (live()) this.deps.onNavigated?.(url, false, tabId)
    }) as never)
    // TODO 522: the tab badge (title, favicon) and the history title. The title text is not logged.
    // TODO 530: also attach hidden views' events to that tab.
    contents.on('page-title-updated', ((_event: unknown, title: string) => {
      if (live() && typeof title === 'string') this.deps.onTitle?.(title, tabId)
    }) as never)
    contents.on('page-favicon-updated', ((_event: unknown, favicons: unknown) => {
      if (!live() || !Array.isArray(favicons)) return
      this.deps.onFavicon?.(
        favicons.filter((url): url is string => typeof url === 'string'),
        tabId
      )
    }) as never)
    contents.on('did-start-loading', (() => send({ kind: 'loading', loading: true })) as never)
    contents.on('did-stop-loading', (() => {
      // Drop the destination of a navigation that ended unsettled (a download, 204) (`target` stays as the settled page).
      this.pending.delete(view)
      send({ kind: 'loading', loading: false })
    }) as never)
    contents.on('did-fail-load', ((
      _event: unknown,
      code: number,
      _description: string,
      url: string,
      isMainFrame: boolean
    ) => {
      if (!isMainFrame) return
      // Drop the destination of a failed navigation (ERR_ABORTED too). Only when the URL matches, so that the ABORTED of a previous navigation
      // overtaken by the next one does not erase the next destination.
      if (this.pending.get(view) === url) this.pending.delete(view)
      if (code === ABORTED) return
      this.failedLoad.add(view)
      log.warn('web.failed', { host: webHostOf(url), code })
      send({ kind: 'failed', code, url })
      if (live() && typeof url === 'string') this.deps.onFailed?.(url, tabId)
    }) as never)
    contents.on('found-in-page', ((
      _event: unknown,
      result: { matches: number; activeMatchOrdinal: number; finalUpdate: boolean }
    ) => {
      if (!result.finalUpdate) return
      send({ kind: 'found', matches: result.matches, active: result.activeMatchOrdinal })
    }) as never)
    // TODO 1221: a fullscreen the page asked for (Fullscreen API). The window is not left to electron (`disableHtmlFullscreenWindowResize`);
    // we decide the window and view rectangles ourselves (to gather the exit paths in one place).
    contents.on('enter-html-full-screen', (() => this.enterFullscreen(view, 'page')) as never)
    contents.on('leave-html-full-screen', (() => this.pageLeftFullscreen(view)) as never)
    contents.on('before-input-event', ((event: { preventDefault(): void }, input: WebViewInput) => {
      // TODO 1221: during fullscreen, Esc is used to exit fullscreen and is not passed to the page (as Chrome does).
      if (this.fullscreen?.view === view && isFullscreenExitKey(input)) {
        event.preventDefault()
        this.exitFullscreen('escape')
        return
      }
      const id = matchWebShortcut(input, this.shortcuts)
      if (id === null) return
      event.preventDefault()
      // TODO 1221: for keys that focus a renderer field (URL field, search), exit fullscreen first so the field is visible.
      if (webShortcutFocusesRendererInput(id)) this.exitFullscreen('shortcut')
      send({ kind: 'shortcut', id })
      // TODO 588: for a send-back that focuses a field (Cmd+L / Cmd+T / Cmd+F / Cmd+Shift+F, etc.), return the native focus left in the page
      // to the window's renderer. Otherwise only the renderer's `activeElement` becomes the field, and physical keystrokes go to the page.
      if (webShortcutFocusesRendererInput(id)) this.deps.focusRenderer?.()
    }) as never)
    contents.on('render-process-gone', (() => {
      log.warn('web.gone', {})
      if (this.fullscreen?.view === view) this.exitFullscreen('gone') // TODO 1221
      // A hidden view crashed: discard it (reload it the next time that tab is shown).
      if (this.view !== view) {
        if (live()) this.discard(key, view)
        return
      }
      send({ kind: 'gone' })
    }) as never)
  }
}
