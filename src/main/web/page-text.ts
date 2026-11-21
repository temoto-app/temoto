/**
 * Hands the body of an open web tab to the AI (TODO 1052, ARCHITECTURE 5.2.1 / 7.6.2). **It does not import electron**
 * (tests run with a fake `webContents`). What this file holds:
 *
 *   - The **fixed JS of the app itself** injected into the page (`PAGE_TEXT_PROBE` / `PAGE_TEXT_SCRIPT`). There is no entry point that lets a plugin or the AI write JS.
 *     It is injected into an isolated world (`PAGE_TEXT_WORLD_ID`), so the page's JS cannot replace the injected functions.
 *   - Validation of the returned value (`parsePageText`), tidying of the body (`tidyPageText`) and slicing (`slicePageText`, by UTF-8 byte position,
 *     the same convention as `getDocumentText`).
 *   - How to choose which tab to read (`pickWebTab`). **Only tabs the user opened are targets** - there is no entry point that renders
 *     and reads an arbitrary URL in the background (owner decision 2026-10-29).
 *
 * The body is neither stored nor logged (in the spirit of constraints 9 / 10). Logs go no further than the host name.
 */

/** The number of the isolated world to inject into (0 is the page's world, 999 is used by Electron's contextIsolation). */
export const PAGE_TEXT_WORLD_ID = 1052

/** Limit on the body taken from a page (characters). Keeps a huge page from eating IPC and main's memory. */
export const MAX_PAGE_TEXT_CHARS = 1_000_000

/** Limit on the title (characters). */
export const MAX_PAGE_TITLE_CHARS = 500

/** Upper bound on waiting for loading to finish (milliseconds). Once exceeded, the body at that moment is returned. */
export const PAGE_LOAD_WAIT_MS = 20_000

/** The interval and count for watching the body settle (an SPA draws via XHR after load). */
export const PAGE_SETTLE_INTERVAL_MS = 400
export const PAGE_SETTLE_PROBES = 8

/**
 * Length of the body returned per call (UTF-8 bytes). The same value as the gateway's `getDocumentText` (`DEFAULT_TEXT_BYTES` /
 * `MAX_TEXT_BYTES` in `src/gateway/respond.ts`; `test/web-page-text.test.ts` checks they match).
 */
export const DEFAULT_PAGE_TEXT_SLICE_BYTES = 24 * 1024
export const MAX_PAGE_TEXT_SLICE_BYTES = 32 * 1024
export const MIN_PAGE_TEXT_SLICE_BYTES = 256

/** Returns only the length of the body (to see whether it has settled). */
export const PAGE_TEXT_PROBE = `(() => {
  const body = document.body
  return body ? body.innerText.length : 0
})()`

/** The title and body (`innerText`, cut at the limit). */
export const PAGE_TEXT_SCRIPT = `(() => {
  const body = document.body
  const text = body ? body.innerText : ''
  const max = ${MAX_PAGE_TEXT_CHARS}
  const loginInput = Array.from(document.querySelectorAll('input[type="password"]')).find((el) => el.getClientRects().length > 0)
  return {
    title: String(document.title || '').slice(0, ${MAX_PAGE_TITLE_CHARS}),
    text: text.length > max ? text.slice(0, max) : text,
    clipped: text.length > max,
    loginForm: loginInput !== undefined,
    loginFormChars: loginInput === undefined ? 0 : String((loginInput.closest('form') || loginInput).innerText || '').length
  }
})()`

export interface PageText {
  readonly title: string
  readonly text: string
  /** The page body exceeded `MAX_PAGE_TEXT_CHARS` and was cut at the extraction step. */
  readonly clipped: boolean
  /** There is a visible password input (TODO 1087: a login screen. Catches screens that are not in the URL table). Absent when false. */
  readonly loginForm?: true
  /** Number of visible characters in the form containing the password field (or the field itself if none). `looksLikeLoginPage` looks at its ratio to the body. */
  readonly loginFormChars?: number
}

/** If the body is shorter than this many characters, a single password field is enough to call it a login screen (review of TODO 1087). */
export const LOGIN_SHORT_BODY_CHARS = 800

/**
 * A login screen only when there is a visible password field and either the body is short or that form is at least half of the body.
 * A long page with a quick login under a forum, a login field in a sidebar or a change-password field can still be read.
 */
export function looksLikeLoginPage(page: Pick<PageText, 'text' | 'loginForm' | 'loginFormChars'>): boolean {
  if (page.loginForm !== true) return false
  const bodyChars = tidyPageText(page.text).length
  if (bodyChars < LOGIN_SHORT_BODY_CHARS) return true
  return (page.loginFormChars ?? 0) * 2 >= bodyChars
}

/** Validates the value returned from the page (not the page's world, but the DOM is the page's). Null if the shape is wrong. */
export function parsePageText(raw: unknown): PageText | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const text = record['text']
  if (typeof text !== 'string') return null
  const title = typeof record['title'] === 'string' ? record['title'].slice(0, MAX_PAGE_TITLE_CHARS) : ''
  return {
    title,
    text: text.length > MAX_PAGE_TEXT_CHARS ? text.slice(0, MAX_PAGE_TEXT_CHARS) : text,
    clipped: record['clipped'] === true || text.length > MAX_PAGE_TEXT_CHARS,
    ...(record['loginForm'] === true ? { loginForm: true as const } : {}),
    ...(typeof record['loginFormChars'] === 'number' ? { loginFormChars: record['loginFormChars'] } : {})
  }
}

/** Tidying of `innerText`: drops trailing spaces on lines, collapses 3 or more blank lines into 1, and trims leading and trailing whitespace. */
export function tidyPageText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Whether this is a UTF-8 continuation byte (10xxxxxx). */
function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80
}

export interface PageTextSlice {
  readonly text: string
  /** Start position of the returned body (UTF-8 bytes, moved to a character boundary). */
  readonly offset: number
  /** Number of bytes of the returned body. */
  readonly bytes: number
  /** Number of bytes of the whole body. */
  readonly total: number
  /** Position to continue from. Null once everything up to the end has been returned. */
  readonly next_offset: number | null
  readonly truncated: boolean
}

/**
 * Slices `length` bytes of the body from `offset` without cutting in the middle of a character (the same convention as `getDocumentText`).
 * If `offset` is in the middle of a character it moves to the start of the next one; if the end is in the middle of a character it moves back to the end of the previous one.
 */
export function slicePageText(text: string, offset: number, length: number): PageTextSlice {
  const bytes = Buffer.from(text, 'utf8')
  const total = bytes.length
  let start = Math.max(0, Math.min(Math.trunc(offset), total))
  while (start < total && isContinuation(bytes[start])) start += 1
  let end = Math.max(start, Math.min(start + Math.max(0, Math.trunc(length)), total))
  while (end > start && end < total && isContinuation(bytes[end])) end -= 1
  const slice = bytes.subarray(start, end).toString('utf8')
  const more = end < total
  return { text: slice, offset: start, bytes: end - start, total, next_offset: more ? end : null, truncated: more }
}

/** A label for a readable tab (the same material as the shape put into `listOpenFiles`). */
export interface ReadableWebTab {
  readonly tabId: string
  readonly url: string
  readonly title: string
  /** Whether it is the tab currently in front in that window. */
  readonly active: boolean
  /**
   * TODO 1061 (3): whether that window's ViewerPane is currently showing the web view and this tab is the front tab (= visible to the user).
   * The gateway adds it from the window's notification. Treated as false if absent.
   */
  readonly shown?: boolean
}

/** For comparing URLs: drops everything from `#` and a trailing `/`. If it is not a URL, returned as is. */
function looseUrl(url: string): string {
  try {
    const parsed = new URL(url.trim())
    parsed.hash = ''
    return parsed.href.replace(/\/+$/, '')
  } catch {
    return url.trim()
  }
}

export type PickWebTabResult =
  | { readonly ok: true; readonly tab: ReadableWebTab }
  | { readonly ok: false; readonly reason: 'no-tabs' | 'no-such-tab' | 'no-matching-url' }

/**
 * Picks the tab to read. If `tabId` is given, that one; if `url` is given, the tab with the same URL (first an exact match, then ignoring `#` and a trailing `/`);
 * with neither, the displayed tab (TODO 1061; if none, the window's front tab, and if none, the first). **A URL not in the list is not read** (a page that is not open is not rendered in the background).
 */
export function pickWebTab(
  tabs: readonly ReadableWebTab[],
  want: { readonly tabId?: string | null; readonly url?: string | null }
): PickWebTabResult {
  if (tabs.length === 0) return { ok: false, reason: 'no-tabs' }
  if (typeof want.tabId === 'string' && want.tabId !== '') {
    const tab = tabs.find((item) => item.tabId === want.tabId)
    return tab === undefined ? { ok: false, reason: 'no-such-tab' } : { ok: true, tab }
  }
  if (typeof want.url === 'string' && want.url.trim() !== '') {
    const exact = want.url.trim()
    const loose = looseUrl(exact)
    const tab =
      tabs.find((item) => item.url === exact && item.active) ??
      tabs.find((item) => item.url === exact) ??
      tabs.find((item) => looseUrl(item.url) === loose && item.active) ??
      tabs.find((item) => looseUrl(item.url) === loose)
    return tab === undefined ? { ok: false, reason: 'no-matching-url' } : { ok: true, tab }
  }
  // TODO 1061 (3): "the page open on the right" = the tab currently visible to the user comes first. Next, the window's front tab.
  const active = tabs.find((item) => item.shown === true) ?? tabs.find((item) => item.active) ?? tabs[0]
  return active === undefined ? { ok: false, reason: 'no-tabs' } : { ok: true, tab: active }
}

/** The result of `WebViewHost.readTabText`. The caller slices the body. */
export type TabTextOutcome =
  | { readonly ok: true; readonly url: string; readonly title: string; readonly text: string; readonly clipped: boolean; readonly loading: boolean; readonly settled: boolean }
  | { readonly ok: false; readonly reason: TabTextFailure }

export type TabTextFailure =
  /** The window closed, or the view cannot be created. */
  | 'closed'
  /** The tab's URL is not http(s) (a blank tab). */
  | 'not-web'
  /** Loading failed (an error page). */
  | 'failed'
  /** TODO 1055 (3): hit a login screen (a screen where you cannot log in from the web view). */
  | 'login-required'
  /** The JS cannot be injected, or the returned shape is wrong. */
  | 'unreadable'
