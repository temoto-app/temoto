/**
 * The IPC for triggers (TODO 1216, ARCHITECTURE 6.2.6). Connects `TriggerService` (independent of electron) to ipcMain.
 *
 * Values from the renderer are **re-checked here** (12.7): the rule's shape and limits by `checkTriggerRuleInput`, the working folder by
 * `FsAccess.assertAllowed` (as a directory, not hitting an exclusion). When the list changes, the whole list goes to all windows.
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import { checkTriggerRuleInput, isTriggerAutoDisabled, TRIGGER_ID_RE, type TriggerOverview } from '@shared/trigger.js'
import { PLUGIN_ID_RE } from '@shared/plugin.js'
import { reasonError } from '@shared/reason.js'
import type { TriggerService } from './service.js'

export function registerTriggerHandlers(service: TriggerService, assertDirectory: (uri: string) => void): void {
  ipcMain.handle(IpcChannel.triggerList, (): TriggerOverview => service.overview())
  ipcMain.handle(IpcChannel.triggerUpdate, (_event, pluginId: unknown, triggerId: unknown, input: unknown, acknowledged: unknown) => {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId) || pluginId.length > 64) {
      throw reasonError('invalid-value', { field: 'pluginId' })
    }
    if (typeof triggerId !== 'string' || !TRIGGER_ID_RE.test(triggerId) || triggerId.length > 64) {
      throw reasonError('invalid-value', { field: 'triggerId' })
    }
    const rule = checkTriggerRuleInput(input)
    if (rule === null) throw reasonError('invalid-value', { field: 'rule' })
    if (rule.cwdUri !== null) assertDirectory(rule.cwdUri)
    // Fix X: the "reason aios disabled it" the user saw (the screen's `TriggerRow.autoDisabled`). A value of a different shape means "not seen".
    return service.updateRule(pluginId, triggerId, rule, isTriggerAutoDisabled(acknowledged) ? acknowledged : null)
  })
}

/** When the list changes, to all windows. */
export function pushTriggerOverview(overview: TriggerOverview, targets: readonly WebContents[]): void {
  for (const contents of targets) {
    if (!contents.isDestroyed()) contents.send(IpcEvent.triggerChanged, overview)
  }
}
