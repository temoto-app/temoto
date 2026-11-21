/**
 * IPC for export and import (TODO 1088, ARCHITECTURE 8.6). Kept apart from `handlers.ts` (the same as voice input).
 *
 * - Main asks for the save destination and the source with `dialog.showSaveDialog` / `showOpenDialog` (a sheet on the calling window).
 *   **No path is accepted from the renderer** - the renderer passes only the passphrase, and `DataTransfer` re-validates its length.
 * - **The busy reservation is made before opening the dialog** (`DataTransfer.exclusive`). Even if pressed from two windows at once, the second is immediately `busy`,
 *   so two dialogs never open. Cancelling releases the reservation.
 * - Handlers are wrapped in `guarded` (TODO 572) (a thrown exception is normalized into a reason code).
 * - The written file is 0600 (the contents are encrypted, but there is no reason to let other users read it either).
 */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { stat, readFile, writeFile } from 'node:fs/promises'
import { IpcChannel } from '@shared/ipc.js'
import { DATA_TRANSFER_EXTENSION, type DataExportResult, type DataImportResult } from '@shared/data-transfer.js'
import type { Locale } from '@shared/locale.js'
import { guarded } from '../ipc/handlers.js'
import { nativeText } from '../i18n-native.js'
import { DataTransfer, checkPassphrase, type DataTransferDeps } from './service.js'

export interface DataTransferIpcDeps extends Omit<DataTransferDeps, 'readFile' | 'writeFile' | 'fileSize'> {
  readonly locale: () => Locale
  /** The initial folder of the save dialog. */
  readonly defaultDir: () => string
}

function exportFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `aios-data-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${DATA_TRANSFER_EXTENSION}`
}

export function registerDataTransferHandlers(deps: DataTransferIpcDeps): DataTransfer {
  const transfer = new DataTransfer({
    ...deps,
    readFile: async (path) => new Uint8Array(await readFile(path)),
    fileSize: async (path) => (await stat(path)).size,
    writeFile: (path, data) => writeFile(path, data, { mode: 0o600 })
  })
  const filters = (): Electron.FileFilter[] => [
    { name: nativeText(deps.locale(), 'dialog.dataTransfer.filter'), extensions: [DATA_TRANSFER_EXTENSION] }
  ]

  ipcMain.handle(
    IpcChannel.dataExport,
    guarded(IpcChannel.dataExport, async (event: IpcMainInvokeEvent, passphrase: unknown): Promise<DataExportResult> => {
      // Validate before opening the dialog (do not refuse after the user has chosen).
      const checked = checkPassphrase(passphrase, true)
      if (!checked.ok) return { kind: 'failed', reason: checked.reason }
      return transfer.exclusive<DataExportResult>({ kind: 'failed', reason: 'busy' }, async () => {
        const owner = BrowserWindow.fromWebContents(event.sender)
        const options = {
          title: nativeText(deps.locale(), 'dialog.dataExport.title'),
          defaultPath: join(deps.defaultDir(), exportFileName(new Date())),
          filters: filters(),
          properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const]
        }
        const result = owner === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(owner, options)
        if (result.canceled || result.filePath === undefined || result.filePath === '') return { kind: 'canceled' }
        return transfer.runExport(result.filePath, checked.value)
      })
    })
  )

  ipcMain.handle(
    IpcChannel.dataImport,
    guarded(IpcChannel.dataImport, async (event: IpcMainInvokeEvent, passphrase: unknown): Promise<DataImportResult> => {
      const checked = checkPassphrase(passphrase, false)
      if (!checked.ok) return { kind: 'failed', reason: checked.reason }
      return transfer.exclusive<DataImportResult>({ kind: 'failed', reason: 'busy' }, async () => {
        const owner = BrowserWindow.fromWebContents(event.sender)
        const options = {
          title: nativeText(deps.locale(), 'dialog.dataImport.title'),
          defaultPath: deps.defaultDir(),
          filters: filters(),
          properties: ['openFile' as const]
        }
        const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options)
        const path = result.filePaths[0]
        if (result.canceled || path === undefined) return { kind: 'canceled' }
        return transfer.runImport(path, checked.value)
      })
    })
  )

  return transfer
}
