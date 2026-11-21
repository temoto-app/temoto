/**
 * IPC for keyboard shortcut assignments (TODO 549). Only connects `KeybindingsPreference` (independent of electron) to ipcMain.
 * Values from the renderer are re-validated in main (`sanitizeKeybindingOverrides`).
 *
 * While recording (`keybindings.recording`), the menu accelerators of the sending window's webContents are stopped
 * (`setIgnoreMenuShortcuts`). Without that, menu keys such as Cmd+B are consumed by electron first and do not reach the
 * recording field of the settings screen. When a window is closed or the renderer reloads, the webContents goes away with it, so nothing needs to be restored.
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { AppSettingsStore } from '../common/settings.js'
import { KeybindingsPreference, keyPlatformOfProcess } from './keybindings.js'
import type { GlobalHotkeyStatuses } from '@shared/keybindings.js'
import { hostPlatform } from '../common/os/platform.js'

export function registerKeybindingsHandlers(
  settings: AppSettingsStore,
  getTargets: () => readonly WebContents[],
  /** Called after notifying all windows (rebuilds the menu accelerators). */
  onChanged: () => void = () => undefined,
  /** Result of registering the global hotkey (TODO 976 part 1). Shown by the settings screen. */
  globalStatus: () => GlobalHotkeyStatuses = () => ({
    'app.summon': { accelerator: null, state: 'off' },
    'app.summonDictate': { accelerator: null, state: 'off' }
  })
): KeybindingsPreference {
  const preference = new KeybindingsPreference(settings, keyPlatformOfProcess(hostPlatform()), (overrides) => {
    for (const contents of getTargets()) {
      if (!contents.isDestroyed()) contents.send(IpcEvent.keybindingsChanged, overrides)
    }
    onChanged()
  })
  ipcMain.handle(IpcChannel.keybindingsGet, () => preference.get())
  ipcMain.handle(IpcChannel.keybindingsGlobalStatus, () => globalStatus())
  ipcMain.handle(IpcChannel.keybindingsSet, (_event, overrides: unknown) => preference.set(overrides))
  // TODO 936: on a reload (the same webContents stays) or a renderer crash, the renderer effect's cleanup does not
  // run and `false` never arrives. Whether the `setIgnoreMenuShortcuts` flag survives navigation is unconfirmed, but if it does,
  // all of that window's menu keys stop working. Restore on a main-frame navigation or the renderer disappearing (harmless even if it does not survive).
  const watched = new WeakSet<WebContents>()
  ipcMain.on(IpcChannel.keybindingsRecording, (event, recording: unknown) => {
    const sender = event.sender
    if (sender.isDestroyed()) return
    sender.setIgnoreMenuShortcuts(recording === true)
    if (watched.has(sender)) return
    watched.add(sender)
    const reset = (): void => {
      if (!sender.isDestroyed()) sender.setIgnoreMenuShortcuts(false)
    }
    sender.on('did-navigate', reset)
    sender.on('render-process-gone', reset)
  })
  return preference
}
