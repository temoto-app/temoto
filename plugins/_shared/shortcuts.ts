/**
 * Identifies app shortcuts pressed inside the viewer (item 189, wave 14 bundle D).
 *
 * The table (`ViewerShortcut[]`) is passed by the host in the `resource` message. **The owner of the table is the renderer**,
 * and this only matches that table against the key (plugins cannot import the renderer - constraint 8).
 * It is a pure function that does not touch the DOM, so it can be tried without jsdom.
 *
 * Keys the viewer itself uses (Cmd+F search, Cmd+D next same word (TODO 467), Cmd+Alt+[ / ] folding, Cmd+R symbol list (TODO 468))
 * are not put in the table by the host (they would be taken in the capture phase). The list is the table at the top of the renderer's `shortcuts.ts`.
 */
import type { ViewerShortcut } from '@shared/plugin.js'
import { rowKeyMatches } from '@shared/keybindings.js'

/** Only the part of `KeyboardEvent` used for the decision. */
export interface ViewerKey {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly isComposing: boolean
  /** The physical key (TODO 589: rows with Alt are matched by this). */
  readonly code?: string
}

/** Same as F1 to F24 in `src/shared/keybindings.ts`. */
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/

/**
 * The id of the matching shortcut. null if none.
 *
 * - Not picked up during IME composition.
 * - Keys with no modifier are not picked up (except F1 to F24, TODO 1132. A row with only Alt is TODO 369's Alt+Left / Alt+Right, non-mac).
 * - All four modifiers must match exactly (Cmd+Shift+P does not match the Cmd+P entry).
 * - Shift makes `key` uppercase, so single-character keys are case-folded to lowercase before comparing.
 * - Rows with Alt (with `code`) are compared by the physical key (on mac, Alt turns `key` into a different character, TODO 589).
 * - Mouse-button rows (with `button`, TODO 369) are never matched against keys.
 */
export function matchViewerShortcut(event: ViewerKey, table: readonly ViewerShortcut[]): string | null {
  if (event.isComposing) return null
  // Only F keys pass without a modifier (TODO 1132: the key table can assign F1 to F24 without modifiers). Character input is not taken.
  if (!(event.metaKey || event.ctrlKey || event.altKey) && !FUNCTION_KEY.test(event.key)) return null
  for (const entry of table) {
    if (entry.button !== undefined) continue
    if (
      rowKeyMatches(entry, event.key, event.code) &&
      entry.metaKey === event.metaKey &&
      entry.ctrlKey === event.ctrlKey &&
      entry.shiftKey === event.shiftKey &&
      entry.altKey === event.altKey
    ) {
      return entry.id
    }
  }
  return null
}

/**
 * The id of the row matching a mouse button (`MouseEvent.button`) released inside the viewer (TODO 369, Back 3 / Forward 4).
 * It matches only when the host put that row in the table (mac).
 */
export function matchViewerMouseButton(button: number, table: readonly ViewerShortcut[]): string | null {
  for (const entry of table) {
    if (entry.button === button) return entry.id
  }
  return null
}
