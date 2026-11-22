/**
 * Width of the sidebar (`.sidebar-panel`) (ARCHITECTURE.md 5.5.1, T24 / TODO 33).
 *
 * **Kept in px.** Unlike the T15 pane, which is a ratio (0 to 1), this is an absolute value. Few users want
 * the list to grow along with the window; once the width fits readable file names, staying fixed is more
 * natural. For the same reason it does not follow window resizes (overflow is absorbed by CSS `flex-shrink`
 * and `min-width` - see "where to cut first" below).
 *
 * **Why this is not merged with `paneRatio.ts`**: there is no shared body. Ratio clamping depends on
 * "the minimum width as a fraction of the split area's width", which changes every time, while px clamping
 * is decided by two constants (`SIDEBAR_MIN_PX` / `SIDEBAR_MAX_PX`) and "the width that must remain on the
 * right". Generalizing would only thread a discriminating argument through every function; the only real
 * duplication was the `localStorage` try/catch, which is extracted to `uiPrefs.ts` and used by both.
 *
 * `.activity-bar` (48px) is **never moved** (same as VSCode; if it moved, the icon hit areas would lose
 * their meaning). Only the width of `.sidebar-panel` moves.
 */
import { MIN_PANE_PX } from './paneRatio.js'
import { readNumber, safeStorage, writeNumber, type PrefStorage } from './uiPrefs.js'

export const SIDEBAR_WIDTH_KEY = 'aios.sidebarWidth'

/** Default width. Double-clicking returns to it (the 320px of 5.3). */
export const DEFAULT_SIDEBAR_WIDTH = 320

/**
 * Minimum width. **Never shrinks to 0** (collapsing is the job of the icon bar toggle, not dragging -
 * `sidebarCollapse.ts`, T27). 180px is the lower bound at which the thread row's "N pending approvals"
 * and about 20 characters of a file name stay readable.
 */
export const SIDEBAR_MIN_PX = 180

/** Maximum width. Nobody needs it wider; this is a lid that protects the ThreadPane. */
export const SIDEBAR_MAX_PX = 640

/** Grabbable width of the divider (`.pane-divider`). Same value as CSS `flex: 0 0 5px`. */
export const DIVIDER_PX = 5

/** Width of `.activity-bar`. Same value as CSS `width: 48px`. */
export const ACTIVITY_BAR_PX = 48

/**
 * Derives the maximum width the sidebar may take from the window width.
 *
 * It is also the **definition of what gives way first when space is tight**. What must always remain on the
 * right is "icon bar 48 + sidebar divider 5 + ThreadPane 280 (+ divider 5 + ViewerPane 280 if the viewer is
 * open)", and **the sidebar yields first**, (since TODO 1297 the viewer is always there; "open" = not folded
 * into its strip), because the place to read is the ThreadPane, not the list. When
 * the result is below `SIDEBAR_MIN_PX`, the minimum width is returned (beyond that it is a tug of war between
 * CSS `min-width`s, and overflowing horizontally behaves as it always has).
 */
export function maxSidebarWidth(hostWidth: number, viewerOpen: boolean): number {
  if (!Number.isFinite(hostWidth)) return SIDEBAR_MAX_PX
  const reserved =
    ACTIVITY_BAR_PX + DIVIDER_PX + MIN_PANE_PX + (viewerOpen ? DIVIDER_PX + MIN_PANE_PX : 0)
  return Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, hostWidth - reserved))
}

/** Clamps a width into the allowed range. `limit` is the result of `maxSidebarWidth`. */
export function clampSidebarWidth(width: number, limit: number = SIDEBAR_MAX_PX): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH
  const upper = Number.isFinite(limit) ? Math.max(SIDEBAR_MIN_PX, limit) : SIDEBAR_MAX_PX
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_PX), upper))
}

/** Derives the width from the pointer's x coordinate while dragging the divider. `left` is the left edge of `.sidebar-panel`. */
export function widthFromPointer(clientX: number, left: number, limit: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(left)) return DEFAULT_SIDEBAR_WIDTH
  return clampSidebarWidth(clientX - left, limit)
}

/** Reads the saved width. Out of range, corrupt, or unreadable environments all fall back to the default. */
export function loadSidebarWidth(storage: PrefStorage | undefined = safeStorage()): number {
  const value = readNumber(
    storage,
    SIDEBAR_WIDTH_KEY,
    (n) => n >= SIDEBAR_MIN_PX && n <= SIDEBAR_MAX_PX
  )
  return value === undefined ? DEFAULT_SIDEBAR_WIDTH : Math.round(value)
}

/** Saves the width. Out-of-range values are not written (the next launch would just fall back to the default, so they are dropped silently). */
export function saveSidebarWidth(
  width: number,
  storage: PrefStorage | undefined = safeStorage()
): void {
  if (!Number.isFinite(width) || width < SIDEBAR_MIN_PX || width > SIDEBAR_MAX_PX) return
  writeNumber(storage, SIDEBAR_WIDTH_KEY, String(Math.round(width)))
}
