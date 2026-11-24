/**
 * Types and pure functions passed between main and the renderer for web tabs, history and Favorites (TODO 522, wave 26 bundle A, ARCHITECTURE 5.2.1).
 *
 * - **Tabs are per window**, and the owner is main (`src/main/web/tabs.ts`). The page is still drawn in the single
 *   `WebContentsView` per window, and switching tabs reloads in that one view (the reason is in bundle A of `docs/notes/wave26.md`).
 * - **History and Favorites are in the DB** (migration 22, `web_history` / `web_favorites`). Only title, URL and time; no body text.
 *   Only main writes. A URL goes through `persistableWebUrl` before saving (values that hit the redaction table are not kept).
 *
 * It depends on neither the DOM nor electron (tests can build plain objects).
 */
import { isWebViewerUrl } from './open-external.js'
import { redactText } from './redact.js'

/**
 * The initial page of a new tab (the open question of TODO 522 -> blank, as recommended). When `selectedUri` is this, ViewerPane shows only the
 * web heading (the URL field) and does not load a page (the view is hidden). It is not written to the memory (item 63).
 */
export const WEB_BLANK_URL = 'about:blank'

/** Whether ViewerPane draws this URI with the web heading (an http(s) page or a blank tab). */
export function isWebPaneUri(uri: unknown): uri is string {
  return uri === WEB_BLANK_URL || isWebViewerUrl(uri)
}

/** Upper bound on tabs per window. Past it no new tab is made (closing the oldest is the user's job). */
export const MAX_WEB_TABS = 50
/** Upper bound on title length (both display and storage). */
export const MAX_WEB_TITLE = 300
/** Upper bound on history (the open question of TODO 522 -> 1,000 rows / 90 days, as recommended). */
export const WEB_HISTORY_MAX_ROWS = 1000
export const WEB_HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
/** Upper bound on Favorites. */
export const MAX_WEB_FAVORITES = 500
/** Upper bound (bytes) on a favicon data URL. Over it, it is not shown. */
export const MAX_FAVICON_BYTES = 64 * 1024
/** TODO 743: how long to wait before retrying a host whose favicon fetch failed (so the same failing host is not hit at every launch). */
export const FAVICON_RETRY_MS = 7 * 24 * 60 * 60 * 1000

/** One tab. `url` is `WEB_BLANK_URL` for a blank tab. `favicon` is a data URL (fetched and shrunk by main) or null. */
export interface WebTab {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly favicon: string | null
}

/** The tabs of one window (main -> renderer, to that window only). */
export interface WebTabsState {
  readonly tabs: readonly WebTab[]
  readonly activeId: string | null
}

export const EMPTY_WEB_TABS: WebTabsState = { tabs: [], activeId: null }

/**
 * One history row (one row per URL, with the last-opened time). `host` is the key for looking up the favicon (TODO 722,
 * `web_favicons`, merged with the tab favicon of 579). **A data URL is not carried per row** (code-review:
 * the same image was being carried over IPC once per row). The renderer fetches the host -> data URL map of `web.favicons()`
 * only once, and looks up each row with `webHostOf(url)`.
 */
export interface WebHistoryEntry {
  readonly id: number
  readonly url: string
  readonly title: string
  readonly visitedAt: number
  readonly host: string | null
}

/**
 * One Favorite row (order is `position`; the list is passed in sorted order). `host` has the same meaning as in history (code-review
 * of TODO 722).
 */
export interface WebFavorite {
  readonly id: number
  readonly url: string
  readonly title: string
  readonly createdAt: number
  readonly host: string | null
}

/** Map of host -> favicon data URL (code-review of TODO 722; `web.favicons()` returns it only once). */
export type WebFavicons = Readonly<Record<string, string>>

/** The history / Favorites / favicon map changed (to all windows). The contents are not carried; the receiver looks them up again. */
export type WebDataChange = 'history' | 'favorites' | 'favicons'

/**
 * TODO 676: one row (display name and count) when the user picks a profile for "Import from Chrome".
 * Main reads it (`src/main/web/chrome-import.ts`). `dir` is the profile's directory name
 * (`Default` / `Profile 1` etc.) and is returned as is when requesting the import.
 */
export interface ChromeImportProfile {
  readonly dir: string
  readonly name: string
  readonly count: number
}

/** TODO 676: result of an import (only counts; the bookmark contents are not carried). */
export interface ChromeImportResult {
  readonly imported: number
  readonly alreadyPresent: number
  readonly skippedOverLimit: number
}

/** Names of the three sections of the Sidebar's web mode (from the top). */
export type WebSectionId = 'history' | 'favorites' | 'tabs'
export const WEB_SECTION_IDS: readonly WebSectionId[] = ['history', 'favorites', 'tabs']

/**
 * Collapse state and height of the three sections (`ui.webSections` in `app_settings`, the owner is main). One for the whole app.
 * - `historyRatio`: history's share (0 to 1) when both history and Favorites are open.
 * - `tabsHeight`: height (px) of the body of the open tabs. The default is a small fixed value (at the bottom, as recommended).
 */
export interface WebSectionsLayout {
  readonly collapsed: Readonly<Record<WebSectionId, boolean>>
  readonly historyRatio: number
  readonly tabsHeight: number
}

export const DEFAULT_WEB_SECTIONS: WebSectionsLayout = {
  collapsed: { history: false, favorites: false, tabs: false },
  historyRatio: 0.5,
  tabsHeight: 168
}

/** Upper bound on the height (a lid so a broken value cannot squash the list). */
export const MAX_WEB_TABS_HEIGHT = 2000

/** Validate a stored value / a value from the renderer. Broken fields fall back to the default. */
export function sanitizeWebSections(raw: unknown): WebSectionsLayout {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_WEB_SECTIONS
  const record = raw as Record<string, unknown>
  const collapsedRaw =
    typeof record['collapsed'] === 'object' && record['collapsed'] !== null
      ? (record['collapsed'] as Record<string, unknown>)
      : {}
  const collapsed = {
    history: collapsedRaw['history'] === true,
    favorites: collapsedRaw['favorites'] === true,
    tabs: collapsedRaw['tabs'] === true
  }
  const ratio = record['historyRatio']
  const height = record['tabsHeight']
  return {
    collapsed,
    historyRatio:
      typeof ratio === 'number' && Number.isFinite(ratio)
        ? Math.min(0.9, Math.max(0.1, ratio))
        : DEFAULT_WEB_SECTIONS.historyRatio,
    tabsHeight:
      typeof height === 'number' && Number.isFinite(height)
        ? Math.round(Math.min(MAX_WEB_TABS_HEIGHT, Math.max(0, height)))
        : DEFAULT_WEB_SECTIONS.tabsHeight
  }
}

/** Put a title into display / storage form (newlines and runs of whitespace become a single space, cut by length). */
export function cleanWebTitle(title: unknown): string {
  if (typeof title !== 'string') return ''
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_WEB_TITLE)
}

/**
 * URL of a Google search result (TODO 691). The search engine is fixed to Google; no setting is added.
 */
export function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

/**
 * Whether what was typed in the URL field is a file / folder path (TODO 771). `/…` (the character after the leading `/` is not whitespace) or `~` / `~/…`.
 * If so, the URL field opens it in the viewer instead of searching (main's `fs.resolveLink` checks expansion, the choke point and existence).
 * Whitespace inside the path is allowed (`/Users/me/My Docs/a.txt`). `//host` (a URL with the scheme omitted) and `/ x` are not included.
 */
export function isLocalPathInput(input: string): boolean {
  const text = input.trim()
  if (text === '~' || text.startsWith('~/')) return true
  return /^\/(?![\s/])/.test(text)
}

/**
 * Turn the string typed in the URL field into a URL to load (TODO 691: if it is not a URL, a Google search). Only an empty string gives null
 * (Enter does nothing). Other schemes (`file:` / `javascript:` ..., without whitespace) are refused (and not turned into a search either).
 *
 * - If it starts with `http://` / `https://`, it is used as is (only those that pass `isWebViewerUrl`).
 * - **Input containing whitespace is always a search, even if it looks like another scheme (code-review of TODO 692, a fix to 691).**
 *   "Sentences containing a colon that are not URLs", such as `TypeError: Cannot read properties of undefined` / `re: meeting notes` / `localhost:3000 docs`,
 *   fall to search before the scheme check. `javascript: alert(1)` (with whitespace)
 *   also goes to search, but what results is a Google URL, so it is safe (the dangerous form has no whitespace, `javascript:alert(1)`, and
 *   that one is refused by the scheme check below).
 * - If there is no scheme, `https://` is supplied. `localhost` / `127.0.0.1` / `[::1]` (with a port too) get `http://`.
 * - With a dot or a port (`example.com`, `localhost:3000`, an IP) -> URL.
 * - A single-label host followed by a path (`vm-soft04/redmine`) -> URL (as in TODO 554).
 * - Anything else (a single-label host alone such as `hello` / `vm-soft04`, a double colon such as `std::vector`) -> Google search
 *   (691, overturning the "do not send to search" of 554 and 522 and their "no default search engine").
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim()
  if (text === '') return null
  if (/^https?:\/\//i.test(text)) return isWebViewerUrl(text) ? text : null
  if (/\s/.test(text)) return googleSearchUrl(text)
  // Other schemes (`file:` / `javascript:` / `mailto:` ...) are refused. `host:port` is told apart by the digits, and `::` (`std::vector`)
  // is two colons in a row, so it is not taken as a scheme (`(?!:)`).
  if (/^[a-z][a-z0-9+.-]*:(?!:)/i.test(text) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(text)) return null
  const hostPart = text.split(/[/?#]/, 1)[0] ?? ''
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(hostPart)
  // A single-label host + path (TODO 554). A leading `/` such as `/etc/passwd` (empty host) is not taken as a URL and goes to search.
  const hasRest = /^[a-z0-9-]+$/i.test(hostPart) && text.length > hostPart.length
  if (!local && !hostPart.includes('.') && !/:\d+$/.test(hostPart) && !hasRest) return googleSearchUrl(text)
  const url = `${local ? 'http' : 'https'}://${text}`
  return isWebViewerUrl(url) ? url : googleSearchUrl(text)
}

/**
 * A URL in a form that may be kept in history, Favorites and the tab memory. null if it cannot be kept.
 *
 * Only http(s). If it hits the redaction table (`redactText`), the query and fragment are dropped and it is checked again
 * (the open question of TODO 522 -> recommended "save after passing redact". A URL containing the redaction mask `[redacted]` is no use
 * when opened, so what can be dropped is dropped and the URL is kept in an openable form). One whose path shows a secret is not kept.
 */
export function persistableWebUrl(url: unknown): string | null {
  if (!isWebViewerUrl(url)) return null
  if (redactText(url).hits.length === 0) return url
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    const stripped = parsed.toString()
    return redactText(stripped).hits.length === 0 ? stripped : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Operations on the tab order (pure functions used by main's `WebTabs`)
// ---------------------------------------------------------------------------

/** Add `tab` to the right of the current tab and make it the current one. If the limit is hit, the state is returned unchanged. */
export function insertTab(state: WebTabsState, tab: WebTab): WebTabsState {
  if (state.tabs.length >= MAX_WEB_TABS) return state
  const at = state.activeId === null ? -1 : state.tabs.findIndex((t) => t.id === state.activeId)
  const index = at < 0 ? state.tabs.length : at + 1
  return { tabs: [...state.tabs.slice(0, index), tab, ...state.tabs.slice(index)], activeId: tab.id }
}

/**
 * Close a tab. An unknown id returns the state unchanged.
 *
 * **Closing the current tab leaves no current tab** (TODO 1326). It used to fall to the right neighbor (or the left), as Chrome
 * does, but the tab row is per window while what the viewer shows next is decided per conversation (the renderer's
 * `planViewerClose`: the conversation's viewer history, still-open steps only), so the neighbor could be a page another
 * conversation opened. The renderer makes its pick current with `activateTab`; with no pick, no tab is current, and the next
 * load into "the current tab" makes a new one (`WebTabs.willLoad`) instead of overwriting a tab nobody is looking at.
 */
export function removeTab(state: WebTabsState, id: string): WebTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  return { tabs, activeId: state.activeId === id ? null : state.activeId }
}

/** Replace the contents of a tab (an unknown id returns the state unchanged). If nothing changes, the same object is returned. */
export function patchTab(state: WebTabsState, id: string, patch: Partial<Omit<WebTab, 'id'>>): WebTabsState {
  let changed = false
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab
    const next = { ...tab, ...patch }
    if (next.url === tab.url && next.title === tab.title && next.favicon === tab.favicon) return tab
    changed = true
    return next
  })
  return changed ? { tabs, activeId: state.activeId } : state
}

/** Label text of a tab (title -> host name -> empty). A blank tab is empty (the caller shows "New tab"). */
export function webTabLabel(tab: Pick<WebTab, 'url' | 'title'>): string {
  if (tab.title !== '') return tab.title
  if (tab.url === WEB_BLANK_URL) return ''
  try {
    return new URL(tab.url).host
  } catch {
    return tab.url
  }
}

// ---------------------------------------------------------------------------
// Tab memory (`web.tabs` in `app_settings`)
// ---------------------------------------------------------------------------

/** One remembered tab (no favicon; it is fetched again when opened). */
export interface StoredWebTab {
  readonly url: string
  readonly title: string
}

/**
 * The tab memory of one window. `owner` is the marker of the window using that memory in the current launch (it is reassigned at every launch, so
 * any value from a previous launch means "no owner"). `closedAt` is the time the window was closed (null for a window that was open at quit).
 */
export interface StoredWebTabSet {
  readonly owner: string
  readonly tabs: readonly StoredWebTab[]
  readonly active: number
  readonly updatedAt: number
  readonly closedAt: number | null
}

/** Upper bound on the number of windows remembered (closed windows count too). */
export const MAX_STORED_WEB_TAB_SETS = 8

/** Into the form written to memory (tabs with a URL that cannot be kept are dropped). A blank tab stays as is. */
export function toStoredTabs(state: WebTabsState): { tabs: StoredWebTab[]; active: number } {
  const tabs: StoredWebTab[] = []
  let active = 0
  for (const tab of state.tabs) {
    const url = tab.url === WEB_BLANK_URL ? WEB_BLANK_URL : persistableWebUrl(tab.url)
    if (url === null) continue
    if (tab.id === state.activeId) active = tabs.length
    tabs.push({ url, title: cleanWebTitle(tab.title) })
  }
  return { tabs, active }
}

/** Validate a stored value. Broken elements and URLs that cannot be kept are silently dropped. */
export function parseStoredWebTabSets(value: unknown): readonly StoredWebTabSet[] {
  if (!Array.isArray(value)) return []
  const out: StoredWebTabSet[] = []
  for (const item of value.slice(0, MAX_STORED_WEB_TAB_SETS)) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (!Array.isArray(record['tabs'])) continue
    const tabs: StoredWebTab[] = []
    for (const raw of (record['tabs'] as unknown[]).slice(0, MAX_WEB_TABS)) {
      if (typeof raw !== 'object' || raw === null) continue
      const tab = raw as Record<string, unknown>
      const url = tab['url'] === WEB_BLANK_URL ? WEB_BLANK_URL : persistableWebUrl(tab['url'])
      if (url === null) continue
      tabs.push({ url, title: cleanWebTitle(tab['title']) })
    }
    if (tabs.length === 0) continue
    const active = record['active']
    const updatedAt = record['updatedAt']
    const closedAt = record['closedAt']
    out.push({
      owner: typeof record['owner'] === 'string' ? record['owner'].slice(0, 64) : '',
      tabs,
      active: typeof active === 'number' && Number.isInteger(active) && active >= 0 && active < tabs.length ? active : 0,
      updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0,
      closedAt: typeof closedAt === 'number' && Number.isFinite(closedAt) ? closedAt : null
    })
  }
  return out
}

/**
 * Pick the one memory a window uses. From those with no owner (not in `live`), the window that was open at quit (`closedAt` is null)
 * comes first, and within that the newer. null if none.
 */
export function pickStoredTabSet(
  sets: readonly StoredWebTabSet[],
  live: ReadonlySet<string>
): StoredWebTabSet | null {
  const free = sets.filter((set) => !live.has(set.owner))
  free.sort((a, b) => {
    if ((a.closedAt === null) !== (b.closedAt === null)) return a.closedAt === null ? -1 : 1
    const at = a.closedAt ?? a.updatedAt
    const bt = b.closedAt ?? b.updatedAt
    return bt - at
  })
  return free[0] ?? null
}

/**
 * The list with one window's memory replaced. If `set` is null (0 tabs), that window's entry is removed. The new one is put first, and
 * when over the limit, ownerless old ones are dropped first.
 */
export function upsertStoredTabSet(
  sets: readonly StoredWebTabSet[],
  owner: string,
  set: StoredWebTabSet | null,
  live: ReadonlySet<string>
): readonly StoredWebTabSet[] {
  const rest = sets.filter((item) => item.owner !== owner)
  const next = set === null ? rest : [set, ...rest]
  if (next.length <= MAX_STORED_WEB_TAB_SETS) return next
  const keep = next.filter((item) => live.has(item.owner) || item.owner === owner)
  const spare = next.filter((item) => !(live.has(item.owner) || item.owner === owner))
  spare.sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt))
  return [...keep, ...spare].slice(0, MAX_STORED_WEB_TAB_SETS)
}
