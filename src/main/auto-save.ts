/**
 * The viewer's auto-save setting (TODO 555, wave 28 bundle D, ARCHITECTURE 5.2.2).
 *
 * Stored in two `app_settings` keys (`VIEWER_AUTO_SAVE` / `VIEWER_AUTO_SAVE_DELAY`, owner is main - TODO 85). It is one setting for the
 * whole app, so a change is notified to **all windows** (`onChanged`). The same light shape as `HiddenFilesPreference`, and independent of
 * electron (`auto-save-ipc.ts` connects it to ipcMain). **Main only holds the setting**: the clock and the decision to save are in the renderer's
 * ViewerPane (host), and writing still goes through `viewer.write` (the Broker's choke point + the mtime check) as before.
 */
import type { AppSettingsStore } from '../common/settings.js'
import { VIEWER_AUTO_SAVE, VIEWER_AUTO_SAVE_DELAY } from '../common/settings-keys.js'
import type { AutoSaveSettings } from '@shared/auto-save.js'

export class AutoSavePreference {
  private current: AutoSaveSettings

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly onChanged: (next: AutoSaveSettings) => void = () => undefined
  ) {
    this.current = {
      mode: settings.readTyped(VIEWER_AUTO_SAVE),
      delayMs: settings.readTyped(VIEWER_AUTO_SAVE_DELAY)
    }
  }

  get(): AutoSaveSettings {
    return this.current
  }

  /** Saves a validated change (one of the fields is enough) and notifies all windows. Does nothing if nothing changed. Returns the saved values. */
  set(patch: Partial<AutoSaveSettings>): AutoSaveSettings {
    const next: AutoSaveSettings = {
      mode: patch.mode ?? this.current.mode,
      delayMs: patch.delayMs ?? this.current.delayMs
    }
    if (next.mode === this.current.mode && next.delayMs === this.current.delayMs) return this.current
    if (next.mode !== this.current.mode) this.settings.writeTyped(VIEWER_AUTO_SAVE, next.mode)
    if (next.delayMs !== this.current.delayMs) this.settings.writeTyped(VIEWER_AUTO_SAVE_DELAY, next.delayMs)
    this.current = next
    this.onChanged(next)
    return next
  }
}
