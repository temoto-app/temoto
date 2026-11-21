/**
 * The renderer-side copy of the search field history (TODO 900, wave 47 bundle C). The source is main alone (`app_settings`).
 * After a window opens, only this window changes it (additions from other windows are picked up by `load` the next time the field gets focus).
 * If the entry point is absent (an old preload / a test fake), it stays empty. Search terms are not even written to the console.
 */
import { create } from 'zustand'
import type { SearchHistoryEntry, SearchHistoryMode } from '@shared/search-history.js'

type HistoryApi = Partial<{
  get(): Promise<readonly SearchHistoryEntry[]>
  add(query: string, mode: SearchHistoryMode): Promise<readonly SearchHistoryEntry[]>
  remove(query: string, mode: SearchHistoryMode): Promise<readonly SearchHistoryEntry[]>
  clear(): Promise<readonly SearchHistoryEntry[]>
}>

function api(): HistoryApi | undefined {
  return (window as unknown as { aios?: { searchHistory?: HistoryApi } }).aios?.searchHistory
}

interface SearchHistoryState {
  readonly items: readonly SearchHistoryEntry[]
  load(): Promise<void>
  add(query: string, mode: SearchHistoryMode): Promise<void>
  remove(query: string, mode: SearchHistoryMode): Promise<void>
  clear(): Promise<void>
}

async function call(
  pick: (a: HistoryApi) => Promise<readonly SearchHistoryEntry[]> | undefined
): Promise<void> {
  const a = api()
  if (a === undefined) return
  try {
    const next = await pick(a)
    if (Array.isArray(next)) useSearchHistory.setState({ items: next })
  } catch {
    // If it cannot be saved, stay as it is.
  }
}

export const useSearchHistory = create<SearchHistoryState>(() => ({
  items: [],
  load: () => call((a) => a.get?.()),
  add: (query, mode) => call((a) => a.add?.(query, mode)),
  remove: (query, mode) => call((a) => a.remove?.(query, mode)),
  clear: () => call((a) => a.clear?.())
}))
