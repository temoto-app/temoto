/**
 * Hiding and folding ViewerPane (TODO 1297 / 1327, ARCHITECTURE 5.5). There are two ways it leaves the screen:
 *
 * - **The user hides it** (TODO 1327, VS Code's Toggle Secondary Side Bar): the title bar button, View > Viewer (Alt+Cmd+B),
 *   or **dragging the divider far to the right** (the snap of VS Code's panels: below half the minimum width the pane snaps
 *   shut; dragging back past that point opens it again within the same drag). Hidden, **nothing is left in its place**:
 *   ThreadPane takes the whole width and the divider goes too (as the sidebar's does, T27). The state is the window layout's
 *   (`windowLayout.ts`, per window).
 * - **A window too narrow for both panes folds it automatically.** ThreadPane's minimum width wins; the viewer yields
 *   first, to a thin strip (owner decision 2026-11-22: never "no pane" here) that opens it again when pressed, collapsing the
 *   sidebar to make room. With the window's minimum width (860px) both always fit, so this is the guard for exotic sizes.
 * - Opening something in the viewer (a file, a Web tab, a temporary view) shows a hidden viewer, also when it is what is
 *   already selected; the restore on a conversation switch does not (`viewerUnfold.ts`). A drag that hides keeps the
 *   ratio from before it (`dragEndRatio`).
 * - Hidden or folded, main is told nothing is shown (`viewer-shown.ts`), so the AI does not take the pane for visible.
 *
 * The DOM-free rules live here (`test/viewer-collapse.test.ts`); the wiring is in `App.tsx`.
 */
import { MIN_PANE_PX, ratioFromPointer } from './paneRatio.js'
import { ACTIVITY_BAR_PX, DIVIDER_PX, SIDEBAR_MIN_PX } from './sidebarWidth.js'

/** Width of the folded strip (px). Same value as CSS `.viewer-strip`. */
export const VIEWER_STRIP_PX = 24

/** Dragging the viewer narrower than this folds it. */
export const VIEWER_SNAP_PX = MIN_PANE_PX / 2

/**
 * One pointer position while dragging the divider. `left` / `width` are the split area (from ThreadPane's left edge,
 * divider excluded), measured when the drag started.
 */
export function dragSplit(
  clientX: number,
  left: number,
  width: number
): { readonly collapsed: boolean; readonly ratio: number } {
  const ratio = ratioFromPointer(clientX, left, width)
  if (!Number.isFinite(clientX) || !Number.isFinite(width) || width <= 0) return { collapsed: false, ratio }
  return { collapsed: left + width - clientX < VIEWER_SNAP_PX, ratio }
}

/**
 * The ratio to keep when a divider drag ends. On the way to the fold the pointer passes the minimum width, so the ratio
 * has run up to its limit; a drag that ends folded keeps the ratio from before it, so opening again restores the old
 * width instead of the minimum one (TODO 1297 review). A drag that ends open keeps where it was let go.
 */
export function dragEndRatio(startRatio: number, currentRatio: number, endedFolded: boolean): number {
  return endedFolded ? startRatio : currentRatio
}

/**
 * Whether the window has room for ThreadPane and ViewerPane at their minimum widths, the sidebar (when open) shrunk to its
 * minimum. `hostWidth` is the width of `.workspace`; unknown (NaN, not measured yet) counts as room.
 */
export function viewerFits(hostWidth: number, sidebarOpen: boolean): boolean {
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) return true
  const left = ACTIVITY_BAR_PX + (sidebarOpen ? SIDEBAR_MIN_PX + DIVIDER_PX : 0)
  return hostWidth - left - DIVIDER_PX >= MIN_PANE_PX * 2
}

/** Whether the viewer is off the screen now (hidden by the user, or folded to the strip by a narrow window). */
export function viewerFolded(userCollapsed: boolean, fits: boolean): boolean {
  return userCollapsed || !fits
}

/**
 * What stands where ViewerPane would (TODO 1327): the pane, the strip of a narrow window, or nothing (hidden by the user).
 * `divider`: whether the divider is drawn. Hidden, it goes too, except during the drag that is hiding it (the pointer capture lives
 * on it, and dragging back within the same drag opens the viewer again).
 */
export function viewerSlot(
  userHidden: boolean,
  fits: boolean,
  dragging: boolean
): { readonly pane: 'viewer' | 'strip' | 'none'; readonly divider: boolean } {
  if (userHidden) return { pane: 'none', divider: dragging }
  return { pane: fits ? 'viewer' : 'strip', divider: true }
}
