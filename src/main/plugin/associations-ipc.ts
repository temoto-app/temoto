/**
 * The IPC for "Open with another viewer" and the per-extension viewer default (TODO 907). Only connects `ViewerAssociations` (independent of electron) and
 * `PluginHost`'s candidates to ipcMain. Validation of values from the renderer is `applyViewerChoice` / `resetViewerAssociation`.
 */
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import type { ViewerAssociationEntry, ViewerChoices } from '@shared/plugin.js'
import type { PluginHost } from './host.js'
import { applyViewerChoice, resetViewerAssociation, type ViewerAssociations } from './associations.js'

const NO_CHOICES: ViewerChoices = { ext: '', choices: [], current: null, associated: false }

export function registerViewerAssociationHandlers(host: PluginHost, associations: ViewerAssociations): void {
  ipcMain.handle(IpcChannel.viewerChoices, (_event, uri: unknown): ViewerChoices =>
    typeof uri === 'string' ? host.viewerChoices(uri) : NO_CHOICES
  )
  ipcMain.handle(IpcChannel.viewerChoose, (_event, uri: unknown, pluginId: unknown): boolean =>
    applyViewerChoice(host, associations, uri, pluginId)
  )
  ipcMain.handle(IpcChannel.viewerAssociations, (): readonly ViewerAssociationEntry[] =>
    host.viewerAssociationEntries()
  )
  ipcMain.handle(IpcChannel.viewerAssociationReset, (_event, ext: unknown): readonly ViewerAssociationEntry[] => {
    resetViewerAssociation(associations, ext)
    return host.viewerAssociationEntries()
  })
}
