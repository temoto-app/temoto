/**
 * Auto-save of the viewer (TODO 555, wave 28 bundle D, ARCHITECTURE 5.2.2).
 *
 * **The shape is the same as VS Code's `files.autoSave` / `files.autoSaveDelay`** (owner decision 2026-10-09):
 *
 *   - `off` (default): as before. Saving is from Cmd+S / the "Save" in the heading / the unsaved-changes confirmation.
 *   - `afterDelay`: save when `delayMs` (default 1000 ms) has passed since the last edit.
 *   - `onFocusChange`: save when the viewer loses focus (moved elsewhere in the window, the whole window lost focus,
 *     moved to another file, closed the pane).
 *
 * The clock and the decision belong to the host (the renderer's ViewerPane); the plugin does not change them. If the disk side has changed (the conflict of 97 / 92),
 * the auto-save is refused by main's mtime check and the conflict band is shown (no silent overwrite). It is stored in main's two keys
 * (`viewer.autoSave` / `viewer.autoSaveDelay`, owner is main). One for the whole app.
 */

export const AUTO_SAVE_MODES = ['off', 'afterDelay', 'onFocusChange'] as const
export type AutoSaveMode = (typeof AUTO_SAVE_MODES)[number]

export const DEFAULT_AUTO_SAVE_MODE: AutoSaveMode = 'off'
/** Same as the default of VS Code's `files.autoSaveDelay`. */
export const DEFAULT_AUTO_SAVE_DELAY_MS = 1000
/** Lower limit of the delay (ms). So that saving on every keystroke does not disturb the watchers (index, model reads). */
export const MIN_AUTO_SAVE_DELAY_MS = 100
/** Upper limit of the delay (ms). One hour. */
export const MAX_AUTO_SAVE_DELAY_MS = 60 * 60 * 1000

/**
 * Lower limit (ms) of the `afterDelay` wait for cell-value drafts (`.xlsx`, TODO 1212 stage 1). Saving text only writes the body, but
 * one save of an `.xlsx` reads the whole file and rebuilds the zip, and the viewer also re-reads the workbook. With the default 1 second this would run every time
 * while cells are being edited one after another (Enter after each cell), so we wait until it has been quiet for 3 seconds. If the setting's value is longer than this, the setting wins.
 */
export const CELL_EDITS_MIN_AUTO_SAVE_DELAY_MS = 3000

/** The wait time actually used. For cell-value drafts the lower limit is applied. */
export function autoSaveDelayFor(delayMs: number, cellEdits: boolean): number {
  return cellEdits ? Math.max(delayMs, CELL_EDITS_MIN_AUTO_SAVE_DELAY_MS) : delayMs
}

export interface AutoSaveSettings {
  readonly mode: AutoSaveMode
  readonly delayMs: number
}

export const DEFAULT_AUTO_SAVE: AutoSaveSettings = {
  mode: DEFAULT_AUTO_SAVE_MODE,
  delayMs: DEFAULT_AUTO_SAVE_DELAY_MS
}

export function isAutoSaveMode(value: unknown): value is AutoSaveMode {
  return typeof value === 'string' && (AUTO_SAVE_MODES as readonly string[]).includes(value)
}

/** Validates the wait time. Null if not a number; out-of-range values are pulled to the edge, and the result is rounded to an integer. */
export function clampAutoSaveDelay(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(MAX_AUTO_SAVE_DELAY_MS, Math.max(MIN_AUTO_SAVE_DELAY_MS, Math.round(value)))
}

/** Validates a change coming from the renderer (either field alone is fine). Broken fields are dropped. */
export function sanitizeAutoSavePatch(value: unknown): Partial<AutoSaveSettings> {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const out: { mode?: AutoSaveMode; delayMs?: number } = {}
  if (isAutoSaveMode(record['mode'])) out.mode = record['mode']
  const delay = clampAutoSaveDelay(record['delayMs'])
  if (delay !== null) out.delayMs = delay
  return out
}
