/**
 * The IPC for Redmine's base URL (TODO 811). It only connects `RedmineBasePreference` (independent of electron) to ipcMain.
 * A value from the renderer is checked with `normalizeRedmineBase`; an unusable value is not saved and the current value is returned.
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { AppSettingsStore } from '../common/settings.js'
import { RedmineBasePreference } from './redmine.js'

export function registerRedmineHandlers(
  settings: AppSettingsStore,
  getTargets: () => readonly WebContents[]
): RedmineBasePreference {
  const preference = new RedmineBasePreference(settings, (next) => {
    for (const contents of getTargets()) {
      if (!contents.isDestroyed()) contents.send(IpcEvent.redmineChanged, next)
    }
  })
  ipcMain.handle(IpcChannel.redmineGet, () => preference.get())
  ipcMain.handle(IpcChannel.redmineSet, (_event, value: unknown) => preference.set(value))
  return preference
}
