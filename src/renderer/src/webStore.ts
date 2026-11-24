/**
 * The renderer-side record of web tabs, history, Favorites, and the collapse state of the Sidebar's three windows (TODO 522, ARCHITECTURE 5.2.1).
 *
 * **Main is the source of truth** (tabs are the per-window `WebTabs`, history and Favorites are in the DB, collapse is in `app_settings`). This only receives
 * notifications and mirrors them, and does not write history (the writer is main, from `did-navigate`).
 *
 * Showing a page is still `select(url)` (TODO 400: the URL is `selectedUri`). A tab operation goes in the order "move main's tab ->
 * `select`", and when `WebViewerPane` calls `web.load` after `select`, main copies the URL to the current tab.
 * IPC arrives in the order called, so it is fine to `select` without awaiting the tab operation.
 */
import { create } from 'zustand'
import {
  DEFAULT_WEB_SECTIONS,
  EMPTY_WEB_TABS,
  MAX_WEB_FAVORITES,
  WEB_BLANK_URL,
  isWebPaneUri,
  persistableWebUrl,
  type ChromeImportProfile,
  type ChromeImportResult,
  type WebFavicons,
  type WebFavorite,
  type WebHistoryEntry,
  type WebSectionsLayout,
  type WebTab,
  type WebTabsState
} from '@shared/web-tabs.js'
import { isWebViewerUrl } from '@shared/open-external.js'
import { parseReason } from '@shared/reason.js'
import type { Translate } from './i18n/index.js'
import { useStore } from './store.js'
import { useThreads } from './threadStore.js'
import { EMPTY_HISTORY } from './viewer-history.js'
import { planViewerClose } from './viewer-close.js'
import { withNavigating } from './navigating.js'
import { ClosedWebPages, withoutFragment } from './closed-web-pages.js'

export interface WebState {
  readonly tabs: WebTabsState
  readonly history: readonly WebHistoryEntry[]
  readonly favorites: readonly WebFavorite[]
  /** Code review (TODO 722): a map of host -> favicon data URL (everything at once, not carried per row). */
  readonly favicons: WebFavicons
  readonly sections: WebSectionsLayout
  /** The signal to put focus in the URL field (new tab). Applied only once each time it increases. */
  readonly focusAddress: number
  /** TODO 676: the result of "Import from Chrome" (disappears after a few seconds, per the no-dialog policy). */
  readonly chromeImportMessage: string | null
}

export const useWeb = create<WebState>(() => ({
  tabs: EMPTY_WEB_TABS,
  history: [],
  favorites: [],
  favicons: {},
  sections: DEFAULT_WEB_SECTIONS,
  chromeImportMessage: null,
  focusAddress: 0
}))

let initialized = false

/** Once per window (the Sidebar calls it at startup). Takes over this window's tabs and subscribes to notifications. */
export function initWeb(): void {
  if (initialized || typeof window === 'undefined' || window.aios?.web?.tabs === undefined) return
  initialized = true
  const web = window.aios.web
  web.onTabsChanged((tabs) => useWeb.setState({ tabs }))
  web.onDataChanged((change) => {
    if (change === 'history') void web.history().then((history) => useWeb.setState({ history }))
    else if (change === 'favorites') void web.favorites().then((favorites) => useWeb.setState({ favorites }))
    // Code review (TODO 722): for a favicon-only change, re-fetch just the map (the list is not re-read).
    else void web.favicons().then((favicons) => useWeb.setState({ favicons }))
  })
  void web.tabs().then((tabs) => useWeb.setState({ tabs }))
  void web.history().then((history) => useWeb.setState({ history }))
  void web.favorites().then((favorites) => useWeb.setState({ favorites }))
  void web.favicons().then((favicons) => useWeb.setState({ favicons }))
  void web.sections().then((sections) => useWeb.setState({ sections }))
}

/**
 * Shows `url` in ViewerPane. If the same URL is already `selectedUri`, `select` does not reload it, so make it load directly
 * (so that main's current tab gets the URL when switching tabs / opening the same page in a new tab).
 */
function show(url: string): void {
  // Shown again: no longer a closed page (TODO 1326 review Y1; the tab that gets it clears it too, `forgetShown`).
  closedWebPages.forget(url)
  const state = useStore.getState()
  if (state.selectedUri === url) {
    if (isWebViewerUrl(url) && !state.viewerDeferred) void window.aios.web.load(url)
    // Still a request to show: a folded viewer opens (TODO 1297 review).
    state.noteViewerOpen()
    return
  }
  state.select(url)
}

/** A row of the tab list was pressed: make that tab the current tab and show it. */
export function showWebTab(tab: WebTab): void {
  void window.aios.web.activateTab(tab.id)
  useWeb.setState((state) => ({ tabs: { tabs: state.tabs.tabs, activeId: tab.id } }))
  show(tab.url)
}

/**
 * Takes `closedUri` (the view that was in front) out of a conversation's viewer history and shows what comes next there
 * (TODO 1297 / 1326, ARCHITECTURE 5.5): the nearest earlier step that can still be shown, else the nearest later one, else the empty
 * state (`planViewerClose`). A Web step counts only while a tab of this window still shows it. One rule for files and Web tabs
 * (⌘W, the Sidebar's tab close, and a closed tab met on a conversation switch). The move is not a new history step, so it runs
 * under the `navigating` marker. `threadId` defaults to the conversation being shown.
 */
export function closeViewerUri(closedUri: string, threadId?: string): void {
  const store = useStore.getState()
  const owner = threadId ?? useThreads.getState().activeThreadId
  if (owner === null) {
    store.select(null)
    return
  }
  const plan = planViewerClose(store.viewerHistories[owner] ?? EMPTY_HISTORY, closedUri, useWeb.getState().tabs)
  store.setViewerHistory(owner, plan.history)
  const target = plan.target
  withNavigating(() => {
    if (target.kind === 'tab') showWebTab(target.tab)
    else if (target.kind === 'file')
      store.select(target.uri, {
        ...(target.highlight === null ? {} : { highlight: target.highlight }),
        ...(target.position === null ? {} : { restore: target.position })
      })
    else store.select(null)
  })
}

/**
 * Pages whose tab was closed in this window (TODO 1326, `closed-web-pages.ts`). A page leaves the set as soon as a tab shows it again
 * (any path: a link, History, back / forward, a restore - they all end in a tab with that URL) or it is shown (`show`).
 */
const closedWebPages = new ClosedWebPages()
useWeb.subscribe((state, previous) => {
  if (state.tabs !== previous.tabs) closedWebPages.forgetShown(state.tabs)
})

/** Whether `url` is a page whose tab this window closed and that no open tab shows now (TODO 1326). */
export function isClosedWebPage(url: string | null): boolean {
  return closedWebPages.has(url, useWeb.getState().tabs)
}

/** For tests: forget the closed pages. */
export function resetClosedWebPagesForTest(): void {
  closedWebPages.clear()
}

/**
 * Closes a tab (the Sidebar's open tabs, ⌘W). If it is the tab in front (the current tab, with ViewerPane showing it), the
 * conversation's viewer history decides what comes next, the same way as closing a file (`closeViewerUri`, TODO 1326 owner decision
 * 2026-11-23): an earlier step that is still open, else a later one, else the empty state. **Never the window's neighbor tab** - main
 * leaves no current tab after the close (`removeTab`), so its pick cannot reach the screen. Closing a tab that is not in front
 * changes nothing on screen.
 */
export async function closeWebTab(id: string): Promise<void> {
  const before = useWeb.getState().tabs
  const wasActive = before.activeId === id
  const closedUrl = before.tabs.find((tab) => tab.id === id)?.url
  // What was shown before closing (it can change during the await, so note it first).
  const shownBefore = useStore.getState().selectedUri
  const closingShown = wasActive && shownBefore !== null && isWebPaneUri(shownBefore)
  if (closingShown) closingShownWebTabs += 1
  let next: WebTabsState
  try {
    next = await window.aios.web.closeTab(id)
  } finally {
    if (closingShown) closingShownWebTabs -= 1
  }
  useWeb.setState({ tabs: next })
  if (closedUrl !== undefined) closedWebPages.note(closedUrl, next)
  if (!closingShown) return
  // Something else was opened while main closed the tab (a file, a History row): that wins. The closing tab's own late
  // navigation cannot get here (`isClosingShownWebTab`).
  if (useStore.getState().selectedUri !== shownBefore) return
  closeViewerUri(shownBefore)
}

/**
 * Closes of the shown tab waiting for main (TODO 1326 review Y3). While one is in flight, a `navigated` from the view can only be the
 * closing tab's own (a redirect or pushState that main sent just before it dropped the view - main forwards events from the shown
 * view only, and that view is the closing tab's). Taking it would `select` the closing page's new URL, so `closeWebTab` would
 * think something else had been opened and stop, leaving a Web pane with no current tab and nothing to load. `WebViewerPane`
 * drops such events. After main's reply the view is gone and sends nothing more.
 */
let closingShownWebTabs = 0

export function isClosingShownWebTab(): boolean {
  return closingShownWebTabs > 0
}

/**
 * Opens a URL. With `newTab`, in a new tab (a link in an answer, Cmd+click); if false, in the current tab (a plain click on a row of History / Favorite,
 * same as Chrome).
 */
export function openWebUrl(url: string, newTab: boolean): void {
  if (!isWebViewerUrl(url)) return
  if (newTab) void window.aios.web.newTab(url)
  show(url)
}

/**
 * TODO 560: the tab that is showing `url` right now (exact match excluding `#`). A tab that navigated after being opened has a different URL, so it is a different one.
 * Only this window's tabs are looked at (it never jumps to another window). The current tab is checked first.
 */
export function findOpenWebTab(tabs: WebTabsState, url: string): WebTab | null {
  const key = withoutFragment(url)
  if (key === null) return null
  const same = (tab: WebTab): boolean => withoutFragment(tab.url) === key
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeId)
  if (active !== undefined && same(active)) return active
  return tabs.tabs.find(same) ?? null
}

/**
 * TODO 560: open from a row of History / Favorite. If a tab for the same page is already open, just move to it (no reload).
 * If not, as before (with `newTab` a new tab, otherwise the current tab). Cmd+click and "Open in new tab" are
 * an explicit new tab, so they open a new tab even if one is already open.
 */
export function openSavedWebUrl(url: string, newTab: boolean): void {
  if (!isWebViewerUrl(url)) return
  const existing = newTab ? null : findOpenWebTab(useWeb.getState().tabs, url)
  if (existing === null) {
    openWebUrl(url, newTab)
    return
  }
  const state = useStore.getState()
  // If it is already the current tab being shown, do nothing (a `show` of the same URL would be a reload) beyond
  // opening a folded viewer (TODO 1297 review).
  if (existing.id === useWeb.getState().tabs.activeId && state.selectedUri === existing.url) {
    state.noteViewerOpen()
    return
  }
  showWebTab(existing)
}

/**
 * TODO 822: the AI (the gateway's `openUrl`) opens it. If a tab for the same page exists, just move to it; otherwise a new tab
 * (does not overwrite the tab the user is looking at, and does not add a tab on every request).
 */
export function openAgentWebUrl(url: string): void {
  if (!isWebViewerUrl(url)) return
  const existing = findOpenWebTab(useWeb.getState().tabs, url)
  if (existing === null) openWebUrl(url, true)
  else openSavedWebUrl(url, false)
}

/** A blank new tab (the + in the heading). Puts focus in the URL field. */
export function openBlankTab(): void {
  void window.aios.web.newTab(null)
  useStore.getState().select(WEB_BLANK_URL)
  focusWebAddress()
}

/**
 * Puts focus in the URL field (TODO 554. The Cmd+L wiring - TODO 531 - only needs to call this). If ViewerPane is not showing
 * web, nothing happens (the signal is only counted).
 */
export function focusWebAddress(): void {
  useWeb.setState((state) => ({ focusAddress: state.focusAddress + 1 }))
}

/** Whether `url` is already registered as a Favorite. Favorite rows are held in the form passed through `persistableWebUrl`, so convert to the same form before comparing. */
export function isFavoriteUrl(favorites: readonly WebFavorite[], url: string): boolean {
  const stored = persistableWebUrl(url)
  return stored !== null && favorites.some((favorite) => favorite.url === stored)
}

/** The star was pressed: remove it if registered, add it if not. */
export function toggleFavorite(url: string, title: string): void {
  if (!isWebViewerUrl(url)) return
  const stored = persistableWebUrl(url)
  const existing = useWeb.getState().favorites.find((favorite) => favorite.url === stored)
  if (existing !== undefined) void window.aios.web.removeFavorite(existing.id)
  else void window.aios.web.addFavorite(url, title)
}

/** From the message of main's exception (`aios-reason:<code>`), tells whether it is `chrome-import-blocked`. */
function isChromeImportBlocked(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return parseReason(message)?.code === 'chrome-import-blocked'
}

/**
 * TODO 676: the list of profiles selectable in "Import from Chrome" (with display name and count). null if Chrome is not found, and an
 * empty array if found but no profile has Bookmarks. Main just re-reads it, and it is not kept in the record.
 *
 * Code review of TODO 687: when launched with a non-default userData, main refuses by throwing `chrome-import-blocked`
 * (`reasonError`). It is rethrown as is - `runChromeImport` tells it apart and picks the message.
 */
export function chromeImportProfiles(): Promise<readonly ChromeImportProfile[] | null> {
  return window.aios.web.chromeProfiles()
}

/** TODO 676: imports the chosen profile. If something was added, the Favorite list is re-fetched via `onDataChanged`. */
export function importChromeFavorites(profileDir: string): Promise<ChromeImportResult | null> {
  return window.aios.web.importChrome(profileDir)
}

/**
 * TODO 723: the icon (data URL) of the user's Chrome.app. Asks main only once and returns the same Promise afterwards
 * (the same simplification as main's cache). null if it cannot be read or is not installed (the caller falls back to a generic icon).
 */
let chromeIconCache: Promise<string | null> | null = null
export function chromeAppIconUrl(): Promise<string | null> {
  if (chromeIconCache === null) {
    chromeIconCache = window.aios.web.chromeIcon().catch(() => null)
  }
  return chromeIconCache
}

/**
 * TODO 676: the sentence for the import result ("Imported N (M already existed) (K could not be imported because of the limit of 500)").
 * A pure function, kept outside so it is easy to test.
 * **Code review fix**: the number skipped because of the limit (`skippedOverLimit`) is also shown - before the fix it was counted
 * (`ChromeImportResult.skippedOverLimit`) but appeared nowhere in the message, and the entries that could not be imported silently vanished.
 */
export function chromeImportResultMessage(t: Translate, result: ChromeImportResult): string {
  const parts = [
    t(result.imported === 1 ? 'web.favorites.chromeImport.done.one' : 'web.favorites.chromeImport.done.other', {
      imported: result.imported
    })
  ]
  if (result.alreadyPresent > 0) {
    parts.push(
      t(
        result.alreadyPresent === 1
          ? 'web.favorites.chromeImport.existing.one'
          : 'web.favorites.chromeImport.existing.other',
        { existing: result.alreadyPresent }
      )
    )
  }
  if (result.skippedOverLimit > 0) {
    parts.push(
      t(
        result.skippedOverLimit === 1
          ? 'web.favorites.chromeImport.skipped.one'
          : 'web.favorites.chromeImport.skipped.other',
        { skipped: result.skippedOverLimit, limit: MAX_WEB_FAVORITES }
      )
    )
  }
  return parts.join(' ')
}

/** How long the result sentence is shown (no dialog; it just disappears). */
export const CHROME_IMPORT_MESSAGE_MS = 6000

let chromeImportMessageTimer: ReturnType<typeof setTimeout> | null = null

/** Puts the import result (or a reason such as "not found") in the record, and clears it after a while. */
export function setChromeImportMessage(message: string | null): void {
  useWeb.setState({ chromeImportMessage: message })
  if (chromeImportMessageTimer !== null) clearTimeout(chromeImportMessageTimer)
  chromeImportMessageTimer = message === null ? null : setTimeout(() => setChromeImportMessage(null), CHROME_IMPORT_MESSAGE_MS)
}

/**
 * The whole flow after pressing "Import from Chrome". If there is one profile it goes ahead without asking, and if several it uses
 * `openMenu` (ContextMenu) to let the user choose (per the no-dialog policy).
 */
export async function runChromeImport(
  t: Translate,
  openMenu: (
    event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number },
    items: readonly { readonly key: string; readonly label: string; readonly onSelect: () => void }[]
  ) => void,
  point: { readonly clientX: number; readonly clientY: number }
): Promise<void> {
  let profiles: readonly ChromeImportProfile[] | null
  try {
    profiles = await chromeImportProfiles()
  } catch (err) {
    // Code review of TODO 687: main refuses when launched with a non-default userData. Tell it apart with a different message.
    setChromeImportMessage(t(isChromeImportBlocked(err) ? 'reason.chrome-import-blocked' : 'web.favorites.chromeImport.unavailable'))
    return
  }
  if (profiles === null) {
    setChromeImportMessage(t('web.favorites.chromeImport.unavailable'))
    return
  }
  if (profiles.length === 0) {
    setChromeImportMessage(t('web.favorites.chromeImport.noProfiles'))
    return
  }
  const importOne = async (dir: string): Promise<void> => {
    let result: ChromeImportResult | null
    try {
      result = await importChromeFavorites(dir)
    } catch (err) {
      setChromeImportMessage(t(isChromeImportBlocked(err) ? 'reason.chrome-import-blocked' : 'web.favorites.chromeImport.unavailable'))
      return
    }
    setChromeImportMessage(
      result === null ? t('web.favorites.chromeImport.unavailable') : chromeImportResultMessage(t, result)
    )
  }
  const only = profiles.length === 1 ? profiles[0] : undefined
  if (only !== undefined) {
    await importOne(only.dir)
    return
  }
  openMenu(
    { preventDefault: () => {}, stopPropagation: () => {}, clientX: point.clientX, clientY: point.clientY },
    profiles.map((profile) => ({
      key: profile.dir,
      label: t('web.favorites.chromeImport.profileLabel', { name: profile.name, count: profile.count }),
      onSelect: () => void importOne(profile.dir)
    }))
  )
}

/** The collapse / height of the Sidebar's three windows was changed (the record is replaced immediately and main is made to write it). */
export function setWebSections(sections: WebSectionsLayout): void {
  useWeb.setState({ sections })
  void window.aios.web.setSections(sections)
}

/** The current tab's title (the name used when registering with the star). Empty if the URL differs. */
export function activeTabTitle(state: WebState, url: string): string {
  const tab = state.tabs.tabs.find((item) => item.id === state.tabs.activeId)
  return tab !== undefined && tab.url === url ? tab.title : ''
}
