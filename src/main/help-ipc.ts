/**
 * IPC for Help (TODO 1174, ARCHITECTURE.md 7.4.13). Just connects `help.ts` (electron-independent) to ipcMain.
 * A URI coming from the renderer is checked by `openHelp` (type, scheme, a page in the table, realpath inside the folder).
 */
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import type { HelpDocument } from '@shared/help.js'
import { openHelp, type HelpDeps } from './help.js'

export function registerHelpHandlers(deps: HelpDeps): void {
  ipcMain.handle(IpcChannel.helpOpen, (_event, uri: unknown): HelpDocument | null => openHelp(deps, uri))
}
