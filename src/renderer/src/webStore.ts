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
import type { ViewerHistory } from './viewer-history.js'

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
  const state = useStore.getState()
  if (state.selectedUri === url) {
    if (isWebViewerUrl(url) && !state.viewerDeferred) void window.aios.web.load(url)
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

/** What to show after closing the Web tab that was shown (TODO 832 (2)). null as before (the next tab main chose / close). */
export type WebCloseTarget =
  | { readonly kind: 'file'; readonly uri: string; readonly highlight: string | null }
  | { readonly kind: 'tab'; readonly tab: WebTab }
  | null

/**
 * TODO 832 (2): when the Web tab that was shown is closed, go back to **what was shown before it** (VS Code's tab convention - after closing,
 * go to what was used just before). Walks back through the conversation's viewer history (TODO 369 / 772) from the current step and picks the first
 * "file (file viewer)" or "Web tab that is still open" it finds. Steps of the closed page (and of tabs already closed) are skipped.
 * null if none is found (as before). A pure function.
 *
 * The history itself is not rewritten (the `select` that goes back is pushed as an ordinary step). Left/right (772) and the global back / forward (801)
 * just walk the history as before.
 */
export function planWebTabClose(
  history: ViewerHistory | undefined,
  closedUrl: string,
  remaining: WebTabsState
): WebCloseTarget {
  if (history === undefined) return null
  const start = history.entries[history.index]?.uri === closedUrl ? history.index - 1 : history.index
  for (let i = start; i >= 0; i -= 1) {
    const entry = history.entries[i]
    if (entry === undefined) continue
    if (!isWebPaneUri(entry.uri)) return { kind: 'file', uri: entry.uri, highlight: entry.highlight }
    if (entry.uri === WEB_BLANK_URL) continue
    const tab = findOpenWebTab(remaining, entry.uri)
    if (tab !== null) return { kind: 'tab', tab }
  }
  return null
}

/**
 * Closes a tab. If it is the tab that was shown (the current tab, with ViewerPane showing web), go back to what was shown before it
 * (a file, or another tab that is still open - TODO 832 (2), `planWebTabClose`). If there is none, show the next tab main chose,
 * and if no tabs remain, close the pane.
 */
export async function closeWebTab(id: string): Promise<void> {
  const wasActive = useWeb.getState().tabs.activeId === id
  // What was shown before closing (it can change during the await, so note it first).
  const shownBefore = useStore.getState().selectedUri
  const next = await window.aios.web.closeTab(id)
  useWeb.setState({ tabs: next })
  const store = useStore.getState()
  if (!wasActive || !isWebPaneUri(store.selectedUri)) return
  const threadId = useThreads.getState().activeThreadId
  const target =
    threadId === null || shownBefore === null
      ? null
      : planWebTabClose(store.viewerHistories[threadId], shownBefore, next)
  if (target?.kind === 'file') {
    store.select(target.uri, target.highlight === null ? {} : { highlight: target.highlight })
    return
  }
  if (target?.kind === 'tab') {
    showWebTab(target.tab)
    return
  }
  const active = next.tabs.find((tab) => tab.id === next.activeId)
  if (active === undefined) store.select(null)
  else show(active.url)
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

/** The URL with everything after `#` dropped (TODO 560's "same page" check). null if it cannot be parsed. */
function withoutFragment(url: string): string | null {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    return null
  }
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
  // If it is already the current tab being shown, do nothing (a `show` of the same URL would be a reload).
  if (existing.id === useWeb.getState().tabs.activeId && state.selectedUri === existing.url) return
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
