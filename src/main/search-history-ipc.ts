/**
 * The IPC for the search box history (TODO 900). It only connects `SearchHistory` (independent of electron) to ipcMain.
 * Checking values is on the `SearchHistory` side (empty, too long and non-string values are ignored).
 */
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import type { AppSettingsStore } from '../common/settings.js'
import { SearchHistory } from './search-history.js'

export function registerSearchHistoryHandlers(settings: AppSettingsStore): SearchHistory {
  const history = new SearchHistory(settings)
  ipcMain.handle(IpcChannel.searchHistoryGet, () => history.get())
  ipcMain.handle(IpcChannel.searchHistoryAdd, (_event, query: unknown, mode: unknown) => history.add(query, mode))
  ipcMain.handle(IpcChannel.searchHistoryRemove, (_event, query: unknown, mode: unknown) => history.remove(query, mode))
  ipcMain.handle(IpcChannel.searchHistoryClear, () => history.clear())
  return history
}
