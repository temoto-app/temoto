/**
 * IPC for the state of the connection to the model (TODO 525, wave 26 bundle B). Connects `ConnectionTracker` (electron-independent) to
 * ipcMain and sends to all windows when it changes. It accepts no value from the renderer (a read-only entry point).
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import { ConnectionTracker } from './connection.js'

export function registerConnectionHandlers(getTargets: () => readonly WebContents[]): ConnectionTracker {
  const tracker = new ConnectionTracker((status) => {
    for (const contents of getTargets()) {
      if (!contents.isDestroyed()) contents.send(IpcEvent.connectionChanged, status)
    }
  })
  ipcMain.handle(IpcChannel.connectionGet, () => tracker.get())
  return tracker
}
