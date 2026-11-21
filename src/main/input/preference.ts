/**
 * The "switch to ASCII input in the search field" setting (TODO 463, ARCHITECTURE 4.5.11).
 *
 * Stored as one key in `app_settings` (`INPUT_ASCII_FOR_SEARCH`, owned by main - TODO 85). One for the whole
 * app. Same light shape as `HiddenFilesPreference`, independent of electron (`register.ts` connects it to ipcMain).
 */
import type { AppSettingsStore } from '../../common/settings.js'
import { INPUT_ASCII_FOR_SEARCH } from '../../common/settings-keys.js'

export class AsciiInputPreference {
  private current: boolean

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly onChanged: (enabled: boolean) => void = () => undefined
  ) {
    this.current = settings.readTyped(INPUT_ASCII_FOR_SEARCH)
  }

  get(): boolean {
    return this.current
  }

  /** Saves and notifies. Does nothing for the same value. Returns the value after saving. */
  set(enabled: boolean): boolean {
    if (enabled === this.current) return this.current
    this.current = enabled
    this.settings.writeTyped(INPUT_ASCII_FOR_SEARCH, enabled)
    this.onChanged(enabled)
    return this.current
  }
}
