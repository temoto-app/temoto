/**
 * Whether a viewer draft may be saved by key / menu (item 313).
 *
 * There are three callers (all just call the same `doSave` as the heading's "Save" button): the
 * Cmd+S / Ctrl+S sent back from the viewer (`shortcut` id `save`), the menu "File" > "Save" (accelerator), and the parent window's keydown.
 * It **does nothing** when the content cannot be edited (read-only, truncated, item 254), when there is no draft,
 * when a save is in progress, or **while the draft-conflict band is shown** (small observation in TODO 313, wave 17 bundle J).
 * During a conflict, saving is possible only from the band's "Overwrite and save" - this prevents the mismatch where Cmd+S / the heading's "Save" button
 * tries to overwrite silently, is refused as a conflict, and a second band piles up.
 * The condition is aligned with the button's `disabled`.
 */
export function shouldSaveByKey(state: {
  readonly editable: boolean
  readonly dirty: boolean
  readonly saving: boolean
  readonly conflict: boolean
}): boolean {
  return state.editable && state.dirty && !state.saving && !state.conflict
}

/** How long (ms, TODO 969) "✅ Saved" is shown in the heading right after a successful save. The same for auto-save (TODO 555). */
export const SAVED_FLASH_MS = 1500

/**
 * The save indicator at the right of the heading (TODO 969).
 *
 * - `none`: show nothing (a viewer that cannot edit, or no changes).
 * - `save`: the save button (`viewer.save`). **Only when there are changes (dirty).** Whether it can be pressed is, as before, `shouldSaveByKey`.
 * - `saving`: the text for saving in progress (`viewer.saving`, not a button).
 * - `saved`: "✅ Saved" for `SAVED_FLASH_MS` right after a successful save (not a button, display only).
 *
 * Previously a "Saved" button that could not be pressed was shown even when there were no changes.
 */
export type SaveIndicator = 'none' | 'save' | 'saving' | 'saved'

export function saveIndicator(state: {
  readonly editable: boolean
  readonly dirty: boolean
  readonly saving: boolean
  /** `SAVED_FLASH_MS` has not yet passed since the save succeeded. */
  readonly justSaved: boolean
}): SaveIndicator {
  if (!state.editable) return 'none'
  if (state.saving) return 'saving'
  if (state.dirty) return 'save'
  return state.justSaved ? 'saved' : 'none'
}
