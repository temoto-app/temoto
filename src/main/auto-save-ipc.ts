/**
 * IPC for the viewer's auto-save setting (TODO 555). Only connects `AutoSavePreference` (electron-independent) to ipcMain.
 * Values from the renderer are validated with `sanitizeAutoSavePatch`, and broken fields are dropped (if all are broken, the current value is returned).
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import { sanitizeAutoSavePatch } from '@shared/auto-save.js'
import type { AppSettingsStore } from '../common/settings.js'
import { AutoSavePreference } from './auto-save.js'

export function registerAutoSaveHandlers(
  settings: AppSettingsStore,
  getTargets: () => readonly WebContents[]
): AutoSavePreference {
  const preference = new AutoSavePreference(settings, (next) => {
    for (const contents of getTargets()) {
      if (!contents.isDestroyed()) contents.send(IpcEvent.autoSaveChanged, next)
    }
  })
  ipcMain.handle(IpcChannel.autoSaveGet, () => preference.get())
  ipcMain.handle(IpcChannel.autoSaveSet, (_event, patch: unknown) => preference.set(sanitizeAutoSavePatch(patch)))
  return preference
}
