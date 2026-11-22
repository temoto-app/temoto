/**
 * Folding ViewerPane into a thin strip (TODO 1297, ARCHITECTURE 5.5). ViewerPane is always on screen, so there is no
 * "closed" state; what it can do instead is fold.
 *
 * - **Dragging the divider far to the right folds it** (the snap of VS Code's panels: below half the minimum width the
 *   pane snaps shut). Dragging back past that point opens it again within the same drag.
 * - **A window too narrow for both panes folds it automatically.** ThreadPane's minimum width wins; the viewer yields
 *   first. With the window's minimum width (860px) both always fit, so this is the guard for exotic sizes.
 * - Folded, a thin strip stays (never "no pane"): pressing it opens the viewer again. When the window is too narrow,
 *   pressing it also collapses the sidebar to make room.
 * - Opening something in the viewer (a file, a Web tab, a temporary view) opens a folded viewer, also when it is what is
 *   already selected; the restore on a conversation switch does not (`viewerUnfold.ts`). A drag that folds keeps the
 *   ratio from before it (`dragEndRatio`).
 * - While folded, main is told nothing is shown (`viewer-shown.ts`), so the AI does not take the pane for visible.
 *
 * Whether the user folded it is kept in `localStorage` (per window, like the ratio). The DOM-free rules live here
 * (`test/viewer-collapse.test.ts`); the wiring is in `App.tsx`.
 */
import { MIN_PANE_PX, ratioFromPointer } from './paneRatio.js'
import { ACTIVITY_BAR_PX, DIVIDER_PX, SIDEBAR_MIN_PX } from './sidebarWidth.js'
import { readFlag, safeStorage, writeFlag, type PrefStorage } from './uiPrefs.js'

export const VIEWER_COLLAPSED_KEY = 'aios.viewerCollapsed'

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

/** Whether the viewer is drawn folded now. */
export function viewerFolded(userCollapsed: boolean, fits: boolean): boolean {
  return userCollapsed || !fits
}

/** Reads whether the user folded it. Unreadable or corrupt counts as open. */
export function loadViewerCollapsed(storage: PrefStorage | undefined = safeStorage()): boolean {
  return readFlag(storage, VIEWER_COLLAPSED_KEY) ?? false
}

export function saveViewerCollapsed(collapsed: boolean, storage: PrefStorage | undefined = safeStorage()): void {
  writeFlag(storage, VIEWER_COLLAPSED_KEY, collapsed)
}
