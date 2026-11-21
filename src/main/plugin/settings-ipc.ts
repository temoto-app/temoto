/**
 * IPC for the "Settings" in an extension's detail (TODO 1225, ARCHITECTURE 7.2.1). It only connects `PluginSettingsStore` (independent of electron) to ipcMain.
 * A plugin id from the renderer is checked only for its shape; re-checking the values is done by `PluginSettingsStore.save` (against the declaration).
 */
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import { PLUGIN_ID_RE } from '@shared/plugin.js'
import type { PluginSettingsView } from '@shared/plugin-settings.js'
import { reasonError } from '@shared/reason.js'
import type { PluginSettingsStore } from './settings.js'

function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && PLUGIN_ID_RE.test(value)
}

export function registerPluginSettingsHandlers(store: PluginSettingsStore): void {
  ipcMain.handle(IpcChannel.pluginSettings, (_event, pluginId: unknown): PluginSettingsView | null =>
    isPluginId(pluginId) ? store.view(pluginId) : null
  )
  // Fix X: update of one field (name and value). Re-checking is done by `PluginSettingsStore.update` (against the declaration).
  ipcMain.handle(IpcChannel.pluginSettingsSave, async (_event, pluginId: unknown, name: unknown, value: unknown): Promise<PluginSettingsView> => {
    if (!isPluginId(pluginId)) throw reasonError('invalid-value', { field: 'pluginId' })
    return store.updateWhenReady(pluginId, name, value)
  })
}
