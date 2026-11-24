/**
 * Types and pure functions passed between main and the renderer for ViewerPane's web view (TODO 400, ARCHITECTURE 5.2.1).
 *
 * The page is drawn in a `WebContentsView` that main owns (not in the renderer's DOM). The renderer holds only the
 * heading, the search field, and the rectangle the page overlays; it tells main the rectangle and show / hide over IPC.
 * It depends on neither the DOM nor electron (tests can build plain objects).
 */
import { rowKeyMatches } from './keybindings.js'

/** The rectangle the page overlays (the renderer's CSS px, with the origin at the top-left of the window's content area). */
export interface WebViewBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** An instruction for in-page search (⌘F). `findNext: true` starts a new search, false moves to next / previous. */
export interface WebFindRequest {
  readonly text: string
  readonly forward: boolean
  readonly findNext: boolean
}

/**
 * One row of the key table to send back to the renderer when pressed inside the web view (`webViewShortcuts` in `shortcuts.ts`).
 * When the page has focus nothing arrives at the renderer's keydown, so main matches against
 * this table in `before-input-event`, and for a matching key sends only the id without passing the key to the page.
 */
export interface WebViewShortcut {
  readonly id: string
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  /** The physical key of a row with ⌥ (TODO 589, `KeyRow.code`). If present, it is matched with this instead of `key` (`rowKeyMatches`). */
  readonly code?: string
}

/** Notifications from main -> renderer (to that window only). Body text is not carried (constraints 9 / 10). */
export type WebViewEvent =
  /**
   * The page's main frame moved. `replace: true` is "replace the current step" (the result of a `load` we issued,
   * a redirect, an in-page navigation), and false is "a new step" (a link inside the page, `target=_blank`).
   */
  | { readonly kind: 'navigated'; readonly url: string; readonly replace: boolean }
  | { readonly kind: 'loading'; readonly loading: boolean }
  /** It could not be loaded (DNS, connection, certificate, etc.). `code` is Chromium's net error number. */
  | { readonly kind: 'failed'; readonly code: number; readonly url: string }
  /** The result of in-page search (the final value of `found-in-page`). */
  | { readonly kind: 'found'; readonly matches: number; readonly active: number }
  /** An app key pressed inside the web view (`WebViewShortcut.id`). */
  | { readonly kind: 'shortcut'; readonly id: string }
  /** The page's process crashed. */
  | { readonly kind: 'gone' }
  /**
   * TODO 1221: entering and leaving fullscreen of the Web contents. If `mode` is null, it was left. While fullscreen the view covers the whole window, so
   * the renderer makes the cover decision over the whole window (wherever a cover appears the view is hidden = main leaves fullscreen).
   */
  | { readonly kind: 'fullscreen'; readonly mode: WebFullscreenMode | null }

/**
 * TODO 1221: the kinds of fullscreen of the Web contents. `page` is a fullscreen the page requested (the Fullscreen API, a video's fullscreen button), and
 * `content` is the ⌃⌘F / View menu when a Web tab is in front (equivalent to Chrome's fullscreen with the toolbar hidden).
 */
export type WebFullscreenMode = 'page' | 'content'

/** TODO 1221: the key that leaves fullscreen (a keyDown of Esc with no modifier). As in Chrome, Esc is used to leave fullscreen and is not passed to the page. */
export function isFullscreenExitKey(input: WebViewInput): boolean {
  return (
    input.type === 'keyDown' && input.key === 'Escape' && !input.meta && !input.control && !input.shift && !input.alt
  )
}

/** The part of the `before-input-event` input used for matching (same names as electron's `Input`). */
export interface WebViewInput {
  readonly type: string
  readonly key: string
  readonly code?: string
  readonly meta: boolean
  readonly control: boolean
  readonly shift: boolean
  readonly alt: boolean
}

/**
 * The id if the pressed key matches any row of the table. Only keyDown is looked at. `key` is compared folded to lowercase if it is one character
 * (Shift gives `F`). A row with ⌥ is compared by the physical key (`code`) (TODO 589, `rowKeyMatches`). All four modifiers must match exactly.
 */
export function matchWebShortcut(input: WebViewInput, table: readonly WebViewShortcut[]): string | null {
  if (input.type !== 'keyDown') return null
  for (const row of table) {
    if (!rowKeyMatches(row, input.key, input.code)) continue
    if (row.metaKey !== input.meta || row.ctrlKey !== input.control) continue
    if (row.shiftKey !== input.shift || row.altKey !== input.alt) continue
    return row.id
  }
  return null
}

/**
 * TODO 588: whether sending back this id moves focus to a renderer input field (the URL field, the search field, the in-page search field).
 *
 * For a key caught by `before-input-event` while the page has focus, merely changing the renderer's `activeElement` to the
 * field does not fix it: **the webContents' native focus stays on the page** (`isFocused()`:
 * page true, window renderer false), and characters typed on the physical keys go to the page (proxy verification run 32,
 * existence confirmed in TODO 598). Only for ids where this decision is true, main calls the window's `webContents.focus()` again immediately after
 * sending back (`deps.focusRenderer` of `WebViewHost`).
 *
 * Targets (the two searches built on the same base as ⌘L / ⌘T / ⌘F / ⌘⇧F): `webFocusAddress` (⌘L), `webNewTab` (⌘T; a blank
 * tab focuses the URL field), `webFind` (⌘F, the in-page search field), and `files` / `names` / `conversation`
 * (body, file name and in-conversation search such as ⌘⇧F, where `openSearch` focuses the search field).
 * Not targets: `webReload` (⌘R), `webNextTab` / `webPrevTab` (the ⌃Tab family), and back / forward (the ids of viewer nav);
 * none of them focus a field.
 */
export function webShortcutFocusesRendererInput(id: string): boolean {
  switch (id) {
    case 'webFocusAddress':
    case 'webNewTab':
    case 'webFind':
    case 'files':
    case 'names':
    case 'conversation':
      return true
    default:
      return false
  }
}

/** Upper bound on the table (a value from the renderer; too many are dropped). */
export const MAX_WEB_SHORTCUTS = 64

/** Validate a table from the renderer. Rows of the wrong shape are dropped. */
export function sanitizeWebShortcuts(raw: unknown): readonly WebViewShortcut[] {
  if (!Array.isArray(raw)) return []
  const out: WebViewShortcut[] = []
  for (const row of raw.slice(0, MAX_WEB_SHORTCUTS) as unknown[]) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (typeof r['id'] !== 'string' || r['id'].length === 0 || r['id'].length > 64) continue
    if (typeof r['key'] !== 'string' || r['key'].length === 0 || r['key'].length > 32) continue
    const flags = ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const
    if (!flags.every((flag) => typeof r[flag] === 'boolean')) continue
    const code = r['code']
    if (code !== undefined && (typeof code !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(code))) continue
    out.push({
      id: r['id'],
      key: r['key'],
      metaKey: r['metaKey'] as boolean,
      ctrlKey: r['ctrlKey'] as boolean,
      shiftKey: r['shiftKey'] as boolean,
      altKey: r['altKey'] as boolean,
      ...(code === undefined ? {} : { code })
    })
  }
  return out
}

/**
 * Validate a rectangle from the renderer and convert it to the window content area's coordinates (DIP). Non-numbers and negative sizes give null.
 *
 * `zoom` is the window renderer's zoom factor (`webContents.getZoomFactor()`). Multiplying the renderer's CSS px by it
 * gives DIP (with View menu zoom in / out, 1 px of the renderer is no longer 1 DIP).
 * Whatever sticks out of the content area (`content`) is clipped.
 */
export function toViewBounds(
  raw: unknown,
  zoom: number,
  content: { readonly width: number; readonly height: number }
): WebViewBounds | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const nums = [r['x'], r['y'], r['width'], r['height']]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const [x, y, width, height] = nums as number[]
  if ((width as number) < 0 || (height as number) < 0) return null
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const left = Math.max(0, Math.round((x as number) * factor))
  const top = Math.max(0, Math.round((y as number) * factor))
  const right = Math.min(content.width, Math.round(((x as number) + (width as number)) * factor))
  const bottom = Math.min(content.height, Math.round(((y as number) + (height as number)) * factor))
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/**
 * Handling of main frame navigation started from inside the page (`will-navigate`) and redirects (`will-redirect`).
 * Only `http(s)` passes. `mailto:` is stopped and sent to the OS mail client, and everything else (`file:` / `javascript:` / `data:` /
 * `aios-*:` ...) is only stopped. The decision is `isWebViewerUrl` / `isOpenableExternally` (the same single one as 5.1.1).
 */
export type WebNavigationDecision = 'allow' | 'external' | 'deny'

/**
 * Handling of `window.open` / `target="_blank"` (`setWindowOpenHandler` always denies).
 * - `http(s)` opened without a modifier key (`foreground-tab` = `target=_blank`, `default` / `other`) -> open in the same view.
 * - ⌘ + click (`background-tab`), shift + click / a `window.open` window (`new-window`) -> the OS browser
 *   (the same rule as "shift / ⌘ go to the browser" of TODO 400).
 * - `mailto:` -> the OS mail client. Anything else -> nothing.
 */
export type WebWindowOpenDecision = 'same-view' | 'external' | 'deny'

export function windowOpenDecision(
  navigation: WebNavigationDecision,
  disposition: string
): WebWindowOpenDecision {
  if (navigation === 'deny') return 'deny'
  if (navigation === 'external') return 'external'
  return disposition === 'background-tab' || disposition === 'new-window' ? 'external' : 'same-view'
}

/**
 * Remove `Electron/…` and the product name (`aios/…`) from Chromium's default User-Agent. Some sites
 * (login screens and the like) refuse an Electron UA, so only the web view's session gets a plain Chrome form.
 */
export function plainUserAgent(userAgent: string, productName: string): string {
  const escaped = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return userAgent
    .replace(new RegExp(`\\s(?:Electron|${escaped})\\/\\S+`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** The URL's host name (for logs and headings). null if unreadable. The whole URL is not logged (5.1.1). */
export function webHostOf(url: string): string | null {
  try {
    const host = new URL(url).host
    return host === '' ? null : host
  } catch {
    return null
  }
}
