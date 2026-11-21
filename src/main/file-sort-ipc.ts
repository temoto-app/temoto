/**
 * IPC for the file tree's sort order (TODO 872). Only connects `FileSortPreference` (independent of electron) to ipcMain.
 * Values from the renderer are validated with `isFileSortOrder`; an unknown value is not saved and the current value is returned.
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { AppSettingsStore } from '../common/settings.js'
import { FileSortPreference } from './file-sort.js'

export function registerFileSortHandlers(
  settings: AppSettingsStore,
  getTargets: () => readonly WebContents[]
): FileSortPreference {
  const preference = new FileSortPreference(settings, (next) => {
    for (const contents of getTargets()) {
      if (!contents.isDestroyed()) contents.send(IpcEvent.fileSortChanged, next)
    }
  })
  ipcMain.handle(IpcChannel.fileSortGet, () => preference.get())
  ipcMain.handle(IpcChannel.fileSortSet, (_event, value: unknown) => preference.set(value))
  return preference
}
