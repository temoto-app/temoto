/**
 * The IPC for the change history (TODO 1186). It only connects `release-notes.ts` (independent of electron) to ipcMain.
 * The only argument from the renderer is the boolean of `setAuto`; the file to read is decided by main (the one bundled `CHANGELOG.md`).
 */
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import type { ReleaseNotesService } from './release-notes.js'

export function registerReleaseNotesHandlers(service: ReleaseNotesService): void {
  ipcMain.handle(IpcChannel.releaseNotesOpen, () => service.open())
  ipcMain.handle(IpcChannel.releaseNotesTakeAuto, () => service.takeAuto())
  ipcMain.handle(IpcChannel.releaseNotesAutoGet, () => service.getAuto())
  ipcMain.handle(IpcChannel.releaseNotesAutoSet, (_event, enabled: unknown) => service.setAuto(enabled === true))
}
