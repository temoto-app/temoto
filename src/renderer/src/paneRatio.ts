/**
 * The split ratio of ThreadPane / ViewerPane (ARCHITECTURE.md chapter 5, T15 / TODO 28).
 *
 * The ratio is held as **a single number from 0 to 1**. It is not held in px, so it follows window resizes on its own and just
 * feeds into `flex-grow`. The final guard of the minimum width (`MIN_PANE_PX`) is CSS `min-width`, but the ratio must also
 * be rounded at the same boundary; otherwise a mismatch remains ("it looks stopped at 280px but the state is 0.02") and it jumps
 * the moment the window is widened.
 *
 * It is stored in `localStorage` (a per-window look that is fine to lose. Decided in TODO_PLAN_2 0.2).
 * It looks at neither the DOM nor electron, so these functions can be unit-tested as they are.
 * **The sidebar width is a separate thing held in px**, so it is split into `sidebarWidth.ts` (5.5.1, T24).
 * Only the `localStorage` conventions are shared (`uiPrefs.ts`).
 */
import { readNumber, safeStorage, writeNumber, type PrefStorage } from './uiPrefs.js'

/** The `localStorage` key. */
export const PANE_RATIO_KEY = 'aios.paneRatio'

/** The default is an even split. Double-click returns to it. */
export const DEFAULT_PANE_RATIO = 0.5

/** Neither pane goes narrower than this. If it could be squashed to 0 it could not be recovered. */
export const MIN_PANE_PX = 280

/**
 * Round the ratio by looking at the width of the split region.
 *
 * When the window is too narrow to give 280px to both sides, **the minimum width takes priority over the ratio** (left to CSS),
 * so this returns an even split and does not pollute the state.
 */
export function clampRatio(ratio: number, width: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_PANE_RATIO
  if (!Number.isFinite(width) || width < MIN_PANE_PX * 2) return DEFAULT_PANE_RATIO
  const margin = MIN_PANE_PX / width
  return Math.min(Math.max(ratio, margin), 1 - margin)
}

/** Compute the ratio from the x coordinate of the pointer holding the divider. `left` is the left edge of the split region. */
export function ratioFromPointer(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_PANE_RATIO
  return clampRatio((clientX - left) / width, width)
}

/**
 * The minimal `Storage` equivalent. The real thing is `PrefStorage` in `uiPrefs.ts`; this name is an alias kept for
 * the name used since T15 (tests refer to it).
 */
export type RatioStorage = PrefStorage

/**
 * Read the saved ratio. **Rendering must not break even if it cannot be read**, so both an exception (private window /
 * site data denied) and a broken value fall back to the default.
 */
export function loadPaneRatio(storage: RatioStorage | undefined = safeStorage()): number {
  // 0 / 1 themselves mean "one side has vanished", so they are not accepted.
  const value = readNumber(storage, PANE_RATIO_KEY, (n) => n > 0 && n < 1)
  return value === undefined ? DEFAULT_PANE_RATIO : value
}

/** Save the ratio. Failures are ignored (it is a look setting, so there is no reason to crash). */
export function savePaneRatio(ratio: number, storage: RatioStorage | undefined = safeStorage()): void {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return
  writeNumber(storage, PANE_RATIO_KEY, ratio.toFixed(4))
}
