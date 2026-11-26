/**
 * The two IPC channels of the launch order (TODO 807, 3.1 "launch order"). **Registered at load, before `ready`**: the first
 * window's renderer calls `boot.wait` while the DB is still closed, and every other handler is registered only after it is open.
 * An `invoke` on a channel with no handler rejects ("No handler registered"), so the boot entry touches nothing else until the
 * gate answers.
 */
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import type { BootAnswer, BootLook } from '@shared/boot.js'
import type { BootGate } from './boot-gate.js'

export function registerBootHandlers(gate: BootGate<BootLook>): void {
  ipcMain.handle(IpcChannel.bootWait, (): Promise<BootAnswer> => gate.wait())
  ipcMain.on(IpcChannel.bootPainted, () => gate.notePainted())
}
