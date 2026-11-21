/**
 * The IPC for usage limits (item 317, wave 17 bundle B). Connects `UsageTracker` (independent of electron) to
 * ipcMain and sends to all windows when it changes. It receives no value from the renderer (a read-only entry point).
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { AppSettingsStore } from '../common/settings.js'
import { UsageTracker } from './usage.js'

export function registerUsageHandlers(
  settings: AppSettingsStore,
  getTargets: () => readonly WebContents[]
): UsageTracker {
  const tracker = new UsageTracker(settings, (snapshot) => {
    for (const contents of getTargets()) {
      if (!contents.isDestroyed()) contents.send(IpcEvent.usageChanged, snapshot)
    }
  })
  ipcMain.handle(IpcChannel.usageGet, () => tracker.get())
  return tracker
}
