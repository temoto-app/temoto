/**
 * The IPC for the number of days after which the thread list folds (TODO 659). It only connects `ThreadCollapsePreference` (independent of electron) to
 * ipcMain. A value from the renderer is checked with `isCollapseOldAfterDays`, and an out-of-range or non-integer value is not saved and
 * the current value is returned (`set` holds this, a code-review fix).
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { AppSettingsStore } from '../common/settings.js'
import { ThreadCollapsePreference } from './thread-collapse.js'

export function registerThreadCollapseHandlers(
  settings: AppSettingsStore,
  getTargets: () => readonly WebContents[]
): ThreadCollapsePreference {
  const preference = new ThreadCollapsePreference(settings, (next) => {
    for (const contents of getTargets()) {
      if (!contents.isDestroyed()) contents.send(IpcEvent.threadCollapseChanged, next)
    }
  })
  ipcMain.handle(IpcChannel.threadCollapseGet, () => preference.get())
  ipcMain.handle(IpcChannel.threadCollapseSet, (_event, value: unknown) => preference.set(value))
  return preference
}
