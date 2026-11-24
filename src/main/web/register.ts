/**
 * The IPC for the ViewerPane web view (TODO 400, ARCHITECTURE 5.2.1) and the real electron parts.
 * Kept apart from `handlers.ts` so as not to touch the same place as parallel bundles (the same practice as `paste/register.ts`).
 *
 * - **One `WebViewHost` per window** (up to the 3 most recent views per tab, TODO 530). The destination is only the view of the window that sent the IPC (`BrowserWindow.fromWebContents(event.sender)`),
 *   and notifications (`IpcEvent.webEvent`) go only to that window (T21 multiple windows). When the window closes or the renderer reloads,
 *   the views are detached and closed.
 * - **One session for pages** (`persist:aios-web`, owner decision 2026-10-04: kept on disk = logins
 *   persist across restarts). It is separate from the app's own session (which has the `aios-res:` / `aios-plugin:` entry points).
 *   All permission requests (camera, microphone, location, notifications, ...) are refused, and downloads are stopped and handed to the OS browser.
 * - View settings: `sandbox: true`, no preload, `nodeIntegration: false`, `contextIsolation: true`
 *   (the same shape as the third-party viewer in 7.8).
 */
import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  shell,
  type IpcMainInvokeEvent,
  type Session
} from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import { isFullscreenExitKey, plainUserAgent, webHostOf, type WebViewEvent } from '@shared/web-view.js'
import { isWebViewerUrl } from '@shared/open-external.js'
import {
  EMPTY_WEB_TABS,
  sanitizeWebSections,
  type WebDataChange,
  type WebTabsState
} from '@shared/web-tabs.js'
import { openExternalChecked } from '../open-external.js'
import { windowOfView } from '../viewer-capture.js'
import { log } from '../../common/logger.js'
import { reasonError } from '@shared/reason.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { UI_WEB_SECTIONS, WEB_TABS } from '../../common/settings-keys.js'
import { WebViewHost, type WebViewLike } from './host.js'
import type { ReadableWebTab, TabTextOutcome } from './page-text.js'
import { encodeScreenshot, type NativeImageLike, type ScreenshotOutcome } from '../session/viewer-screenshot.js'
import { installChromeShim } from './chrome-shim.js'
import type { WebDataStore } from './data.js'
import {
  fetchFavicon as fetchFaviconWith,
  fetchFaviconForHost as fetchFaviconForHostWith,
  guardedFaviconFetch,
  type FaviconFetch
} from './favicon.js'
import { faviconHop, faviconResolve } from './favicon-hop.js'
import { WebTabs, WebTabsMemory } from './tabs.js'
import { chromeBookmarksBaseDir, importChromeBookmarks, listChromeProfiles } from './chrome-import.js'
import { chromeAppBundlePath, loadChromeAppIcon } from './chrome-bookmarks.js'
import { existsSync } from 'node:fs'
import type { Locale } from '@shared/locale.js'
import { nativeText } from '../i18n-native.js'
import { fullscreenHintBounds, fullscreenHintUrl } from './fullscreen-hint.js'

/** The name of the page session. It is `persist:`, so it stays under userData (under the copy for a duplicated `--user-data-dir`). */
export const WEB_PARTITION = 'persist:aios-web'

let configured: Session | null = null

/** Sets up the page session exactly once. */
function webSession(productName: string): Session {
  if (configured !== null) return configured
  const ses = session.fromPartition(WEB_PARTITION)
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    // TODO 1221: let through only the fullscreen the page asks for (a video's fullscreen button, `requestFullscreen()`). The window is not
    // left to electron (`disableHtmlFullscreenWindowResize`); `WebViewHost` decides the rectangles of the window and view. A request
    // from a view that is not being shown is refused by the host (it leaves fullscreen immediately).
    if (permission === 'fullscreen') {
      callback(true)
      return
    }
    log.warn('web.permission.denied', { permission, host: webHostOf(contents.getURL()) })
    callback(false)
  })
  // TODO 1221: answer "allowed" for fullscreen only on the query (check) as well (so it does not disagree with the request).
  ses.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen')
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (event, item) => {
    event.preventDefault()
    const url = item.getURL()
    log.warn('web.download.redirected', { host: webHostOf(url) })
    void openExternalChecked(url, (target) => shell.openExternal(target), 'window-open')
  })
  const plainUa = plainUserAgent(ses.getUserAgent(), productName)
  ses.setUserAgent(plainUa)
  // Code-review of TODO 721 (owner decision 2026-10-11): the Google-brand rewrite of the
  // Sec-CH-UA headers was removed - it stayed inconsistent with the JS side (`navigator.userAgentData`), was unlikely to work, and
  // just hooked all traffic. Details in docs/notes/wave34.md.
  configured = ses
  return ses
}

/**
 * TODO 848: the page session used by `browser.fetchPage` (CapabilityBroker). Sets up exactly once and returns the same one as the web view (the same cookies,
 * the same user agent, all permission requests refused). Call it after the app is ready.
 */
export function webPageSession(productName: string): Session {
  return webSession(productName)
}

/**
 * TODO 687: an entry point that, only in a verification build (proxy verification), points the read location (`home`) of the Chrome import (676) at a fake place.
 * The name matches what it really does (replacing the HOME base) - the old name `AIOS_CHROME_BASE_DIR` is not used.
 *
 * **Always ignored in a distributed build (`app.isPackaged`)** - this is the only place that reads the env; `chrome-import.ts` /
 * `chrome-bookmarks.ts` (pure functions that take `home` as an argument) do not read the env. In the 36th proxy verification
 * (TODO 690), `os.homedir` (an ESM builtin) could not be replaced from main's inspector, and the owner's
 * real Chrome profile names and counts showed up on screen - the proxy verification procedure was added to
 * `docs/notes/parallel-work-and-verification.md`.
 */
export function chromeHomeOverride(): string | undefined {
  if (app.isPackaged) return undefined
  const raw = process.env['AIOS_CHROME_HOME_DIR']
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/**
 * Code-review of TODO 687: in a launch where `userData` is not the default (with `--user-data-dir`, proxy verification or
 * `npm run dev:instance`), the Chrome import is refused by default unless `chromeHomeOverride()` is set
 * (owner decision 2026-10-11) - to prevent a repeat of the accident (TODO 690) in which the real `~/Library/Application Support/Google/Chrome`
 * was read with no replacement in place. A dev run with the default userData (`npm run dev`) and a distributed build have
 * `defaultUserData` true, so they read the real thing as before.
 */
export function chromeImportBlocked(defaultUserData: boolean): boolean {
  return !defaultUserData && chromeHomeOverride() === undefined
}

/** TODO 522: history, Favorites, the tab memory, and the folding of the 3 windows. When the DB is unavailable (memory-only) it is null and only the tabs work. */
export interface WebViewStores {
  readonly data: WebDataStore | null
  readonly settings: AppSettingsStore | null
  /** Whether `userData` is the default (code-review of TODO 687, the same check as `isDefaultUserData` in `index.ts`). */
  readonly defaultUserData: boolean
  /** TODO 1221: the current display language (the wording of the fullscreen hint). English if absent. */
  readonly locale?: () => Locale
}

/** An entry point to call in `before-quit`, before the DB is closed (12.9). */
export interface WebViewHandle {
  /**
   * TODO 761 (12.9): returns after waiting for a running background favicon backfill - `shutdownWithin`
   * (`src/main/shutdown.ts`) awaits the return value of `run()`, so returning a Promise here
   * follows the same practice as the other services' `stop()` (so nothing writes to a closed DB).
   */
  shutdown(): Promise<void>
  /**
   * TODO 1052: the labels of a window's web tabs (renderer `webContents.id`), only http(s) ones. Empty if there is no window or no tab yet.
   * Used by the gateway's `listOpenFiles` / `getOpenUrlText`.
   */
  listTabs(viewId: number): readonly ReadableWebTab[]
  /** TODO 1052: reads the body of the window's tab `tabId` (if there is no view, it reloads without showing it, `WebViewHost.readTabText`). */
  readTab(viewId: number, tabId: string): Promise<TabTextOutcome>
  /**
   * TODO 1061 (1): captures the rendering of the window's tab `tabId`. **Only when the view currently shown is that tab** (`WebViewHost.shownContents`).
   * For a background tab or while hidden it is `hidden`. The image is only returned, never kept.
   */
  captureTab(viewId: number, tabId: string): Promise<ScreenshotOutcome>
  /**
   * TODO 1221: the full-screen command (Ctrl+Cmd+F / the View menu). If the window is showing a web page, makes only the web content
   * fullscreen (or leaves it if already fullscreen) and returns true. If false, the caller toggles the window's fullscreen as before.
   */
  toggleFullscreen(window: BrowserWindow): boolean
}

/**
 * TODO 929: the entry point that fetches a favicon. Sends one step at a time with `net.request` of the page session (`persist:aios-web`, cookies live there too),
 * resolving the name at each step and refusing inner addresses (private / loopback) (`guardedFaviconFetch`). Inner addresses are let through only for
 * `trustedHost` (the host of a page the user opened or a Favorite).
 */
function faviconFetchFor(productName: string, trustedHost: string | null): FaviconFetch {
  return guardedFaviconFetch(faviconHop(() => webSession(productName)), { resolve: faviconResolve, trustedHost })
}

/**
 * Turns the first favicon candidate into a data URL (`favicon.ts`). The size is counted while reading (TODO 579).
 * TODO 929: an inner address is allowed only for the page's own host (`pageUrl`).
 */
function fetchFavicon(productName: string, pageUrl: string, urls: readonly string[]): Promise<string | null> {
  return fetchFaviconWith(faviconFetchFor(productName, webHostOf(pageUrl)), urls)
}

/** TODO 722 / 743: cap on how many to fetch in the background on a Chrome import (676), at launch, and when a Favorite is added. */
export const MAX_FAVICON_BACKFILL = 40

/**
 * TODO 722 / 743: fetches in the background (without making anyone wait for the result) for the hosts of Favorites that have no favicon -
 * called from 3 triggers: at launch, and when a Favorite is added (by hand with the star, or by the Chrome import) (inside register.ts).
 * `/favicon.ico` first, and if that fails the HTML `<link rel=icon>` (`fetchFaviconForHost`). What was fetched is
 * written to web_favicons and broadcast to all windows. A failed host has its time remembered by `markFaviconFailed` and for 7 days
 * is excluded from `hostsWithoutFavicon` (so the same failing host is not hit on every launch). If nothing changed it does not
 * broadcast. Once the window has closed and `shutdown()` has been called it does nothing (12.9, the same judgment as `guarded`).
 * **Exported for tests** (it depends only on `WebDataStore` and the fetch entry point `fetchFor`).
 */
export async function backfillFavoriteFavicons(
  data: WebDataStore,
  /** TODO 929: the fetch entry point for that host (the real one is `faviconFetchFor`, which lets inner addresses through for that host only). */
  fetchFor: (host: string) => FaviconFetch,
  broadcast: (change: WebDataChange) => void,
  stopped: () => boolean,
  now: () => number = Date.now
): Promise<void> {
  const hosts = data.hostsWithoutFavicon(MAX_FAVICON_BACKFILL, now())
  let changed = false
  let ok = 0
  let failed = 0
  for (const host of hosts) {
    if (stopped()) return
    const outcome = await fetchFaviconForHostWith(fetchFor(host), host)
    // TODO 761 (12.9): look again after the await and before writing - if shutdown (`db.close()`) came during the await,
    // we would end up writing to a closed DB.
    if (stopped()) return
    if (outcome.image !== null) {
      ok += 1
      if (data.setFaviconForHost(host, outcome.image)) changed = true
    } else {
      failed += 1
      // TODO 761 (a fix to 743): if network failures (network, timeout) were also written to markFaviconFailed,
      // a host that was just temporarily offline during the background backfill right after launch would not be retried for 7 days.
      // Record only when an HTTP response was obtained and "none" was established.
      if (!outcome.networkError) data.markFaviconFailed(host, now())
    }
  }
  if (hosts.length > 0 && !stopped()) log.info('web.favicons.backfill', { hosts: hosts.length, ok, failed })
  // Code-review (TODO 722): a favicon-only change is announced as 'favicons' (the host -> data URL map) -
  // 'favorites' is only for when the shape of the list (url/title/host) changes. This reduces how often all windows re-read the list.
  if (changed && !stopped()) broadcast('favicons')
}

/** TODO 1221: the fullscreen hint bubble for one window. */
interface FullscreenHint {
  show(): void
  hide(): void
  relayout(): void
  dispose(): void
}

/**
 * TODO 1221: a small `WebContentsView` that overlays the fullscreen hint bubble (the "press Esc to exit" message) at the very top of the window. Its contents are
 * the fixed HTML of `fullscreen-hint.ts` (no JS, sandbox, no preload). Created when shown and closed when dismissed (it is shown for
 * only a few seconds, so it is not kept alive). Hidden until it has finished loading (so a white background is not seen for a moment).
 */
function fullscreenHintFor(window: BrowserWindow, locale: () => Locale): FullscreenHint {
  let view: WebContentsView | null = null
  const relayout = (): void => {
    if (view === null || window.isDestroyed()) return
    const [width] = window.getContentSize()
    view.setBounds(fullscreenHintBounds(width ?? 0))
  }
  const hide = (): void => {
    const current = view
    view = null
    if (current === null) return
    if (!window.isDestroyed()) window.contentView.removeChildView(current)
    if (!current.webContents.isDestroyed()) current.webContents.close()
  }
  return {
    show: () => {
      hide()
      if (window.isDestroyed()) return
      const created = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false }
      })
      created.setVisible(false)
      created.setBorderRadius(10)
      created.webContents.once('did-finish-load', () => {
        if (view === created) created.setVisible(true)
      })
      // There is no navigation inside the bubble (no links, no JS), but stop it just in case.
      created.webContents.on('will-navigate', (event) => event.preventDefault())
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view = created
      // The view added last is on top (above the page view).
      window.contentView.addChildView(created)
      relayout()
      void created.webContents.loadURL(fullscreenHintUrl(nativeText(locale(), 'web.fullscreenHint'))).catch(() => undefined)
    },
    hide,
    relayout,
    dispose: hide
  }
}

export function registerWebViewHandlers(
  productName: string,
  stores: WebViewStores = { data: null, settings: null, defaultUserData: true }
): WebViewHandle {
  const hosts = new Map<number, WebViewHost>()
  const tabsByWindow = new Map<number, WebTabs>()
  const { data, settings, defaultUserData } = stores
  const currentLocale = (): Locale => stores.locale?.() ?? 'en'
  const memory =
    settings === null
      ? null
      : new WebTabsMemory({
          read: () => settings.readTyped(WEB_TABS),
          write: (sets) => settings.writeTyped(WEB_TABS, sets)
        })
  let stopped = false
  if (data !== null) {
    try {
      data.prune()
    } catch (err) {
      log.warn('web.history.pruneFailed', { message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** History / Favorites changed: tell all windows (the contents are not carried). */
  const broadcast = (change: WebDataChange): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IpcEvent.webDataChanged, change)
    }
  }

  // TODO 761 (a fix to 743): called at launch, on the star, and on every Chrome import, but running them overlapped
  // fetches the same host in parallel (wasted traffic, and the log counts break). Run only one, and make a call
  // during a run just set a "one more round" mark, then replay once after it finishes.
  let backfillTask: Promise<void> | null = null
  let backfillAgain = false

  /**
   * TODO 722 / 743 / 761: calls the background favicon backfill (3 triggers: at launch, a Chrome import, and when a Favorite is
   * added by hand; none makes the entry wait). Never lets an exception out even on failure
   * (so it does not fail a test where `data` is a minimal fake - there should be no path that passes anything other than the real `WebDataStore`).
   * Do not run overlapped (`backfillTask` above).
   */
  const runFaviconBackfill = (): void => {
    if (data === null) return
    const store = data
    if (backfillTask !== null) {
      backfillAgain = true
      return
    }
    const once = (): Promise<void> =>
      backfillFavoriteFavicons(store, (host) => faviconFetchFor(productName, host), broadcast, () => stopped).catch((err: unknown) => {
        log.warn('web.favicons.backfillFailed', { message: err instanceof Error ? err.message : String(err) })
      })
    backfillTask = (async () => {
      await once()
      while (backfillAgain && !stopped) {
        backfillAgain = false
        await once()
      }
    })().finally(() => {
      backfillTask = null
    })
  }

  // TODO 743: backfill favicons in the background at launch (for hosts never fetched yet, such as Favorites imported
  // before 722). A failed host is recorded with `data.markFaviconFailed` and is not
  // retried for 7 days (the cutoff of `hostsWithoutFavicon`).
  runFaviconBackfill()

  /** Do not let the DB entry point fail with an exception (pages can still be viewed with a broken DB). After shutdown it does nothing (12.9). */
  const guarded = <T>(what: string, fn: () => T, fallback: T): T => {
    if (stopped) return fallback
    try {
      return fn()
    } catch (err) {
      log.warn('web.data.failed', { what, message: err instanceof Error ? err.message : String(err) })
      return fallback
    }
  }

  /** The window's tabs (the memory is taken over on the first query). */
  const tabsFor = (window: BrowserWindow): WebTabs => {
    const existing = tabsByWindow.get(window.id)
    if (existing !== undefined) return existing
    const windowId = window.id
    const owner = `w${windowId}-${Date.now().toString(36)}`
    // Do not write changes made after the window closed and returned to the memory (e.g. a favicon fetch that arrives late) - writing would put it back in `live`
    // and the next window could no longer take it over (code-review 2026-10-08).
    let released = false
    const tabs = new WebTabs({
      onChange: (state: WebTabsState) => {
        if (released) return
        if (!window.isDestroyed()) window.webContents.send(IpcEvent.webTabsChanged, state)
        memory?.save(owner, state)
      }
    })
    const stored = memory?.adopt(owner) ?? null
    if (stored !== null) {
      tabs.restore(stored.tabs, stored.active)
      log.info('web.tabs.restored', { count: stored.tabs.length })
    }
    tabsByWindow.set(windowId, tabs)
    window.once('closed', () => {
      released = true
      memory?.release(owner, tabs.current)
      tabsByWindow.delete(windowId)
    })
    return tabs
  }

  const windowOf = (event: IpcMainInvokeEvent): BrowserWindow | null => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window === null || window.isDestroyed() ? null : window
  }

  const hostFor = (event: IpcMainInvokeEvent, create: boolean): WebViewHost | null => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null || window.isDestroyed()) return null
    return hostForWindow(window, create)
  }

  /** The window's `WebViewHost` (in TODO 1052 the by-window lookup was split out so it can also be called from outside IPC - from the gateway's reads). */
  const hostForWindow = (window: BrowserWindow, create: boolean): WebViewHost | null => {
    const existing = hosts.get(window.id)
    if (existing !== undefined || !create) return existing ?? null
    const windowId = window.id
    const tabs = tabsFor(window)
    const hint = fullscreenHintFor(window, currentLocale)
    const host = new WebViewHost({
      createView: () => {
        const view = new WebContentsView({
          webPreferences: {
            session: webSession(productName),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            spellcheck: false,
            // TODO 1221: do not let electron make the window fullscreen on a page's fullscreen (`WebViewHost` decides the rectangles of the window and view).
            disableHtmlFullscreenWindowResize: true
          }
        })
        const ready = installChromeShim(view.webContents)
        view.setVisible(false)
        window.contentView.addChildView(view)
        return Object.assign(view, { ready }) as unknown as WebViewLike
      },
      removeView: (view) => {
        if (!window.isDestroyed()) window.contentView.removeChildView(view as unknown as WebContentsView)
      },
      openExternal: (url) => {
        void openExternalChecked(url, (target) => shell.openExternal(target), 'window-open')
      },
      send: (payload: WebViewEvent) => {
        if (!window.isDestroyed()) window.webContents.send(IpcEvent.webEvent, payload)
      },
      // TODO 588: after echoing back Cmd+L / Cmd+T / Cmd+F / Cmd+Shift+F etc., return native focus to the window's renderer.
      focusRenderer: () => {
        if (!window.isDestroyed()) window.webContents.focus()
      },
      zoom: () => (window.isDestroyed() ? 1 : window.webContents.getZoomFactor()),
      contentSize: () => {
        if (window.isDestroyed()) return { width: 0, height: 0 }
        const [width, height] = window.getContentSize()
        return { width: width ?? 0, height: height ?? 0 }
      },
      // TODO 522: the tab labels and history. The only writer is main (the renderer does not write history).
      // TODO 530: views are per tab. Notifications are attached to that view's tab (`tabId`), including those of hidden views.
      onNavigated: (url, full, tabId) => {
        tabs.navigated(url, full, tabId)
        if (!full) return
        const title = (tabId === null ? tabs.viewTab : tabs.tab(tabId))?.title ?? ''
        if (guarded('visit', () => data?.recordVisit(url, title) ?? false, false)) broadcast('history')
      },
      onTitle: (title, tabId) => {
        tabs.titled(title, tabId)
        const url = (tabId === null ? tabs.viewTab : tabs.tab(tabId))?.url
        if (url !== undefined && guarded('title', () => data?.updateTitle(url, title) ?? false, false)) {
          broadcast('history')
        }
      },
      onFavicon: (urls, tabId) => {
        const tab = tabId === null ? tabs.viewTab : tabs.tab(tabId)
        if (tab === null) return
        const forUrl = tab.url
        void fetchFavicon(productName, forUrl, urls).then((image) => {
          tabs.favicon(tab.id, forUrl, image)
          // TODO 722: write the favicon to the history / Favorite rows of the same host too (per host, web_favicons).
          if (image === null) return
          const host = webHostOf(forUrl)
          if (host === null) return
          // Code-review: every time a favicon arrived, both 'favorites' and 'history' were sent to all windows and made them
          // re-read the whole list (even though the URL/title/host had not changed). A favicon-only change is announced as
          // 'favicons' (the host -> data URL map, everything in one go).
          if (guarded('favicon', () => data?.setFaviconForHost(host, image) ?? false, false)) {
            broadcast('favicons')
          }
        })
      },
      // TODO 601: the title of a tab whose load failed is the host name (owner decision 2026-10-10). History is left untouched.
      onFailed: (url, tabId) => tabs.failed(url, tabId),
      // TODO 1221: fullscreen of the web content. The window's fullscreen in/out and the hint bubble.
      isWindowFullScreen: () => !window.isDestroyed() && window.isFullScreen(),
      setWindowFullScreen: (on) => {
        if (!window.isDestroyed()) window.setFullScreen(on)
      },
      fullscreenHint: (show) => (show ? hint.show() : hint.hide())
    })
    hosts.set(windowId, host)
    window.once('closed', () => {
      host.dispose()
      hint.dispose()
      hosts.delete(windowId)
    })
    // The renderer was reloaded: the previous ViewerPane is gone.
    window.webContents.on('did-navigate', () => host.close())
    // TODO 1221: the window's fullscreen was ended from outside (the green button, Mission Control) -> leave the web content's fullscreen too.
    // The window size changed (the transition into fullscreen is asynchronous) -> refit the fullscreen view to the whole window.
    window.on('leave-full-screen', () => host.windowLeftFullScreen())
    window.on('enter-full-screen', () => host.windowResized())
    window.on('resize', () => {
      host.windowResized()
      hint.relayout()
    })
    // TODO 1221: Esc while the renderer has focus also leaves fullscreen (the view covers the window and the renderer is not visible).
    window.webContents.on('before-input-event', (event, input) => {
      if (isFullscreenExitKey(input) && host.escapeFullscreen()) event.preventDefault()
    })
    return host
  }

  ipcMain.handle(IpcChannel.webLoad, (event, url: unknown) => {
    const host = hostFor(event, true)
    const window = windowOf(event)
    if (host === null || window === null || !isWebViewerUrl(url)) return host?.load(url) ?? false
    // Copy the URL to the current tab, then load (create a tab if there is none, TODO 522). If that tab's view is alive and
    // has the same URL, swap the view in without reloading (TODO 530).
    const tabId = tabsFor(window).willLoad(url)
    return host.load(url, tabId)
  })
  ipcMain.handle(IpcChannel.webSetBounds, (event, bounds: unknown) => hostFor(event, false)?.setBounds(bounds))
  ipcMain.handle(IpcChannel.webSetVisible, async (event, visible: unknown, snapshot: unknown) => {
    const host = hostFor(event, false)
    return host === null ? null : host.setVisible(visible === true, snapshot === true)
  })
  ipcMain.handle(IpcChannel.webSetShortcuts, (event, table: unknown) => hostFor(event, true)?.setShortcuts(table))
  ipcMain.handle(IpcChannel.webReload, (event) => hostFor(event, false)?.reload())
  ipcMain.handle(IpcChannel.webStop, (event) => hostFor(event, false)?.stop())
  ipcMain.handle(IpcChannel.webFocus, (event) => hostFor(event, false)?.focus())
  ipcMain.handle(IpcChannel.webFind, (event, request: unknown) => hostFor(event, false)?.find(request))
  ipcMain.handle(IpcChannel.webStopFind, (event) => hostFor(event, false)?.stopFind())
  // The ViewerPane's web page came off (switched to a file, another conversation, the shown tab was closed): hide the views and keep
  // them alive for `WEB_HIDDEN_VIEWS_TTL_MS` (TODO 580). TODO 1326 removed the ViewerPane's close button, the only caller that asked
  // to close every view, so there is no reason argument any more (arguments are ignored).
  ipcMain.handle(IpcChannel.webClose, (event) => hostFor(event, false)?.hide())

  // ---- wave 26 bundle A: tabs, history, Favorites, 3 windows (TODO 522) ----
  const tabsState = (event: IpcMainInvokeEvent): WebTabsState => {
    const window = windowOf(event)
    return window === null ? EMPTY_WEB_TABS : tabsFor(window).current
  }
  ipcMain.handle(IpcChannel.webTabs, (event) => tabsState(event))
  ipcMain.handle(IpcChannel.webNewTab, (event, url: unknown) => {
    const window = windowOf(event)
    if (window !== null) tabsFor(window).open(url)
    return tabsState(event)
  })
  ipcMain.handle(IpcChannel.webActivateTab, (event, id: unknown) => {
    const window = windowOf(event)
    if (window !== null) tabsFor(window).activate(id)
    return tabsState(event)
  })
  ipcMain.handle(IpcChannel.webCloseTab, (event, id: unknown) => {
    const window = windowOf(event)
    if (window !== null) {
      tabsFor(window).close(id)
      hosts.get(window.id)?.dropTab(id) // TODO 530: also close that tab's view
    }
    return tabsState(event)
  })
  ipcMain.handle(IpcChannel.webHistoryList, () => guarded('history', () => data?.listHistory() ?? [], []))
  ipcMain.handle(IpcChannel.webHistoryRemove, (_event, id: unknown) => {
    if (guarded('removeHistory', () => data?.removeHistory(id) ?? false, false)) broadcast('history')
  })
  ipcMain.handle(IpcChannel.webHistoryClear, () => {
    const removed = guarded('clearHistory', () => data?.clearHistory() ?? 0, 0)
    log.info('web.history.cleared', { removed })
    broadcast('history')
  })
  ipcMain.handle(IpcChannel.webFavoritesList, () => guarded('favorites', () => data?.listFavorites() ?? [], []))
  // Code-review (TODO 722): return the host -> favicon map in one go (the list rows no longer carry a favicon).
  ipcMain.handle(IpcChannel.webFaviconsList, () => guarded('favicons', () => data?.webFavicons() ?? {}, {}))
  ipcMain.handle(IpcChannel.webFavoriteAdd, (_event, url: unknown, title: unknown) => {
    const added = guarded('addFavorite', () => data?.addFavorite(url, title) ?? false, false)
    if (added) {
      broadcast('favorites')
      // TODO 743: a Favorite added by hand also backfills its favicon in the background with the same function (the entry does not wait).
      runFaviconBackfill()
    }
    return added
  })
  ipcMain.handle(IpcChannel.webFavoriteRemove, (_event, target: unknown) => {
    if (guarded('removeFavorite', () => data?.removeFavorite(target) ?? false, false)) broadcast('favorites')
  })
  ipcMain.handle(IpcChannel.webFavoriteMove, (_event, id: unknown, index: unknown) => {
    if (guarded('moveFavorite', () => data?.moveFavorite(id, index) ?? false, false)) broadcast('favorites')
  })
  ipcMain.handle(IpcChannel.webSectionsGet, () =>
    guarded(
      'sections',
      () => settings?.readTyped(UI_WEB_SECTIONS) ?? sanitizeWebSections(null),
      sanitizeWebSections(null)
    )
  )
  ipcMain.handle(IpcChannel.webSectionsSet, (_event, layout: unknown) => {
    guarded('setSections', () => settings?.writeTyped(UI_WEB_SECTIONS, sanitizeWebSections(layout)), undefined)
  })

  // TODO 676 (wave 31 bundle C): import Chrome bookmarks. Only main reads them; plugins are not involved.
  // Code-review of TODO 687: a verification build (userData is not the default) refuses by default unless the replacement (`AIOS_CHROME_HOME_DIR`) is
  // set (to prevent a repeat of the accident in which the real Chrome was read, TODO 690).
  ipcMain.handle(IpcChannel.webChromeProfiles, async () => {
    if (stopped) return null
    if (chromeImportBlocked(defaultUserData)) {
      log.warn('web.chrome.blocked', {})
      throw reasonError('chrome-import-blocked')
    }
    try {
      const home = chromeHomeOverride()
      // 687: so a proxy verification can see whether the replacement took effect, log only the path (not the body or counts).
      if (home !== undefined) log.info('web.chrome.baseDir', { path: chromeBookmarksBaseDir(home) })
      return await listChromeProfiles(home)
    } catch (err) {
      log.warn('web.favorites.chromeProfilesFailed', { message: err instanceof Error ? err.message : String(err) })
      return null
    }
  })
  ipcMain.handle(IpcChannel.webChromeImport, async (_event, profileDir: unknown) => {
    if (stopped || data === null || typeof profileDir !== 'string') return null
    if (chromeImportBlocked(defaultUserData)) {
      log.warn('web.chrome.blocked', {})
      throw reasonError('chrome-import-blocked')
    }
    try {
      const home = chromeHomeOverride()
      const result = await importChromeBookmarks(data, profileDir, home)
      if (result !== null && result.imported > 0) {
        broadcast('favorites')
        // TODO 722: fetch the favicons of what was imported in the background. Do not await (the entry does not wait).
        runFaviconBackfill()
      }
      return result
    } catch (err) {
      log.warn('web.favorites.chromeImportFailed', { message: err instanceof Error ? err.message : String(err) })
      return null
    }
  })

  // TODO 723: the Chrome icon on the "import from Chrome" button shown on an empty Favorite list (not bundled; the same
  // `app.getFileIcon` as 562). Fetch once and return the same Promise afterwards (the same compromise as 562's AppIconCache:
  // if Chrome is installed later during a run, it is not reflected until the next launch).
  let chromeIconPromise: Promise<string | null> | null = null
  ipcMain.handle(IpcChannel.webChromeIcon, () => {
    if (chromeIconPromise === null) {
      chromeIconPromise = loadChromeAppIcon(chromeAppBundlePath(), existsSync, (path) =>
        app.getFileIcon(path, { size: 'normal' })
      )
    }
    return chromeIconPromise
  })

  return {
    listTabs: (viewId) => {
      if (stopped) return []
      const window = windowOfView(viewId)
      const tabs = window === null ? undefined : tabsByWindow.get(window.id)
      if (tabs === undefined) return []
      const state = tabs.current
      return state.tabs
        .filter((tab) => isWebViewerUrl(tab.url))
        .map((tab) => ({ tabId: tab.id, url: tab.url, title: tab.title, active: tab.id === state.activeId }))
    },
    readTab: async (viewId, tabId) => {
      if (stopped) return { ok: false, reason: 'closed' }
      const window = windowOfView(viewId)
      const tab = window === null ? null : (tabsByWindow.get(window.id)?.tab(tabId) ?? null)
      if (window === null || tab === null) return { ok: false, reason: 'closed' }
      const host = hostForWindow(window, true)
      if (host === null) return { ok: false, reason: 'closed' }
      return host.readTabText(tab.id, tab.url)
    },
    captureTab: async (viewId, tabId) => {
      if (stopped) return { ok: false, reason: 'closed' }
      const window = windowOfView(viewId)
      const host = window === null ? null : hostForWindow(window, false)
      if (host === null) return { ok: false, reason: 'closed' }
      const shown = host.shownContents()
      if (shown === null || shown.tabId !== tabId) return { ok: false, reason: 'hidden' }
      try {
        const image = (await shown.contents.capturePage()) as unknown as NativeImageLike
        const encoded = encodeScreenshot(image)
        if (encoded === null) return { ok: false, reason: 'empty' }
        const url = shown.contents.getURL()
        return { ok: true, ...encoded, ...(isWebViewerUrl(url) ? { url } : {}) }
      } catch {
        return { ok: false, reason: 'failed' }
      }
    },
    toggleFullscreen: (window) => {
      if (window.isDestroyed()) return false
      return hostForWindow(window, false)?.toggleContentFullscreen() ?? false
    },
    shutdown: async () => {
      // Before closing the DB (12.9). From here on neither history nor the tab memory is written (including the `closed` of windows that `app.quit()` closes).
      memory?.shutdown()
      stopped = true
      // Wait for the running favicon backfill. If we returned without waiting, the caller's next write would
      // go to a closed DB (12.9) - since `stopped` is set, the while inside `backfillTask` does not go around again
      // and ends with just the one round now running.
      await backfillTask?.catch(() => {})
    }
  }
}
