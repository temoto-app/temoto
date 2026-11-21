/**
 * IPC for "show hidden files" (TODO 261). Just connects `HiddenFilesPreference` (electron-independent) to
 * ipcMain. Anything other than a boolean from the renderer is refused (the current value is returned).
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { AppSettingsStore } from '../common/settings.js'
import { HiddenFilesPreference } from './hidden-files.js'

export function registerHiddenFilesHandlers(
  settings: AppSettingsStore,
  getTargets: () => readonly WebContents[],
  /** Called after all windows were notified (rebuilds the menu's checkmark). */
  onChanged: () => void = () => undefined
): HiddenFilesPreference {
  const preference = new HiddenFilesPreference(settings, (show) => {
    for (const contents of getTargets()) {
      if (!contents.isDestroyed()) contents.send(IpcEvent.hiddenFilesChanged, show)
    }
    onChanged()
  })
  ipcMain.handle(IpcChannel.fsHiddenGet, () => preference.get())
  ipcMain.handle(IpcChannel.fsHiddenSet, (_event, show: unknown) =>
    typeof show === 'boolean' ? preference.set(show) : preference.get()
  )
  return preference
}
