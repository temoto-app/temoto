/**
 * The IPC of the extension detail's "Account" (TODO 952 stage 1). Connects `PluginAccounts` (independent of electron) to ipcMain, and
 * only passes in electron's entry points (the file-choosing dialog and the default browser). For the plugin id and credential name from the renderer,
 * only whether they are strings is checked; matching against the declaration is done by `PluginAccounts`.
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dialog, ipcMain, shell, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import type { PluginAccountResult, PluginAccountStatus } from '@shared/plugin-account.js'
import { GOOGLE_CLIENT_FILE_HINT } from '../capability/google-credentials.js'
import { MAX_CLIENT_FILE_BYTES, type PluginAccounts } from './accounts.js'

const NOT_A_STRING: PluginAccountResult = { ok: false, error: 'unavailable', accounts: [] }

/**
 * Lets the user choose the client JSON and returns its contents. The default location is `~/.config/aios/google-oauth-client.json`
 * (owner decision 2026-10-24). It is a file the user chose in a native dialog, so no path comes from the renderer.
 */
export async function chooseClientFile(owner: BrowserWindow | null, title: string): Promise<string | null> {
  const options: OpenDialogOptions = {
    title,
    defaultPath: join(homedir(), GOOGLE_CLIENT_FILE_HINT),
    properties: ['openFile', 'showHiddenFiles'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options)
  const path = result.canceled ? undefined : result.filePaths[0]
  if (path === undefined) return null
  if (statSync(path).size > MAX_CLIENT_FILE_BYTES) throw new Error('client file too large')
  return readFileSync(path, 'utf8')
}

export function registerPluginAccountHandlers(accounts: PluginAccounts): void {
  ipcMain.handle(IpcChannel.pluginAccountStatus, (_event, pluginId: unknown): readonly PluginAccountStatus[] =>
    typeof pluginId === 'string' ? accounts.status(pluginId) : []
  )
  ipcMain.handle(IpcChannel.pluginAccountImportClient, (_event, pluginId: unknown) =>
    typeof pluginId === 'string' ? accounts.importClient(pluginId) : NOT_A_STRING
  )
  ipcMain.handle(IpcChannel.pluginAccountSignIn, (_event, pluginId: unknown, credential: unknown) =>
    typeof pluginId === 'string' && typeof credential === 'string' ? accounts.signIn(pluginId, credential) : NOT_A_STRING
  )
  ipcMain.handle(IpcChannel.pluginAccountCancelSignIn, (_event, pluginId: unknown, credential: unknown) =>
    typeof pluginId === 'string' && typeof credential === 'string'
      ? accounts.cancelSignIn(pluginId, credential)
      : NOT_A_STRING
  )
  ipcMain.handle(IpcChannel.pluginAccountSignOut, (_event, pluginId: unknown, credential: unknown) =>
    typeof pluginId === 'string' && typeof credential === 'string' ? accounts.signOut(pluginId, credential) : NOT_A_STRING
  )
  ipcMain.handle(IpcChannel.pluginAccountSaveToken, (_event, pluginId: unknown, credential: unknown, email: unknown, token: unknown) =>
    typeof pluginId === 'string' && typeof credential === 'string'
      ? accounts.saveToken(pluginId, credential, email, token)
      : NOT_A_STRING
  )
}

/** Opens the consent screen in the default browser (Google refuses an embedded browser, 721). */
export function openInDefaultBrowser(url: string): Promise<void> {
  return shell.openExternal(url)
}
