/**
 * The renderer-side copy of the file tree's order (TODO 872, wave 43 bundle C).
 *
 * **The source is in one place, main** (`ui.fileSortOrder` in `app_settings`, one for the whole app). A settings-screen change is saved to main
 * -> `fileSort.onChanged` reaches **all windows** -> this is rewritten and the open listings are refetched (`relist`): a single path.
 * The sorting itself is SQL in the index process, and main attaches the setting's value every time a listing is requested; the renderer does not send the value.
 * Even on a refetch, `expanded` / selection are kept by `relist` in `store.ts`, so open/closed state is not lost when the order changes.
 *
 * If it cannot be read or there is no entry point (an old preload / a test fake), it stays at the default (newest first).
 */
import { create } from 'zustand'
import { DEFAULT_FILE_SORT_ORDER, isFileSortOrder, type FileSortOrder } from '@shared/file-sort.js'

interface FileSortState {
  readonly order: FileSortOrder
  update(order: FileSortOrder): Promise<void>
}

type FileSortApi = Partial<{
  get(): Promise<unknown>
  set(order: FileSortOrder): Promise<unknown>
  onChanged(listener: (order: FileSortOrder) => void): unknown
}>

function api(): FileSortApi | undefined {
  return (window as unknown as { aios?: { fileSort?: FileSortApi } }).aios?.fileSort
}

/** Copy a value from main (the return of `onChanged` / `get` / `set`). Unknown values are ignored. */
function apply(value: unknown): void {
  if (isFileSortOrder(value) && value !== useFileSort.getState().order) {
    useFileSort.setState({ order: value })
  }
}

export const useFileSort = create<FileSortState>(() => ({
  order: DEFAULT_FILE_SORT_ORDER,

  async update(order: FileSortOrder): Promise<void> {
    const set = api()?.set
    if (typeof set !== 'function') return
    try {
      // The refetch is triggered by main's notice (all windows). This only aligns the copy.
      apply(await set(order))
    } catch {
      // If it cannot be saved, it stays as it is.
    }
  }
}))

let initialized: Promise<void> | null = null
const relisters = new Set<() => void>()

/**
 * Read the saved value and subscribe to change notices. `relist` is the entry point that refetches open listings when the order changes
 * (`store.ts`). Call it before the tree's first listing. **Loading and subscribing happen once; `relist` is added on every call**
 * (even if the settings screen mounts first and passes `() => undefined`, the tree's entry point that comes later is not discarded).
 * Passing the same function repeatedly calls it only once.
 */
export function initFileSort(relist: () => void): Promise<void> {
  relisters.add(relist)
  if (initialized !== null) return initialized
  initialized = (async () => {
    const current = api()
    if (current === undefined) return
    try {
      // main orders the first listing with the setting's value. This is a copy for the settings screen's display.
      if (typeof current.get === 'function') apply(await current.get())
      if (typeof current.onChanged === 'function') {
        current.onChanged((order) => {
          apply(order)
          for (const fn of [...relisters]) fn()
        })
      }
    } catch {
      // It works with the default as it is.
    }
  })()
  return initialized
}

/** For tests: forget the initialization and the entry points. */
export function resetFileSortForTest(): void {
  initialized = null
  relisters.clear()
}
