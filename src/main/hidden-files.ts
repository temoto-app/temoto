/**
 * "Show hidden files" in the file tree (TODO 261, wave 15 bundle D).
 *
 * Stored as one `app_settings` key (`UI_SHOW_HIDDEN_FILES`, owner is main, TODO 85). It is one value for the whole app
 * (not per window), so when it changes **all windows** are notified (`onChanged`). Same light shape as `EditorPreference`.
 * Does not depend on electron (`hidden-files-ipc.ts` connects it to ipcMain).
 *
 * A **display-only** setting: it does not change what is indexed, searched or scanned. The hiding itself is done by the index process's
 * `FsIndexer.listDirectory` (`showHidden: false`).
 */
import type { AppSettingsStore } from '../common/settings.js'
import { UI_SHOW_HIDDEN_FILES } from '../common/settings-keys.js'

export class HiddenFilesPreference {
  private current: boolean

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly onChanged: (show: boolean) => void = () => undefined
  ) {
    this.current = settings.readTyped(UI_SHOW_HIDDEN_FILES)
  }

  get(): boolean {
    return this.current
  }

  /** Save and notify all windows. Does nothing for the same value. Returns the value after saving. */
  set(show: boolean): boolean {
    if (show === this.current) return this.current
    this.current = show
    this.settings.writeTyped(UI_SHOW_HIDDEN_FILES, show)
    this.onChanged(show)
    return this.current
  }
}
