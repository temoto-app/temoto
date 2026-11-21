/**
 * The renderer-side copy of how many days of inactivity fold a row in the thread list (TODO 659, wave 30 bundle C).
 *
 * **The source is main alone** (`threads.collapseOldAfterDays` in `app_settings`, one for the whole app). A change in the settings screen
 * is saved in main -> `threadCollapse.onChanged` reaches **all windows** -> this is rewritten: a single path
 * (the same shape as `autoSaveStore.ts`). The readers are `ThreadList` (the collapse decision) and the settings screen.
 *
 * If it cannot be read or there is no entry point (an old preload / a fake in tests), the default (5 days) stays - falling back to the behavior as before.
 */
import { create } from 'zustand'
import {
  DEFAULT_COLLAPSE_OLD_AFTER_DAYS,
  THREAD_COLLAPSE_QUERY_KEY,
  isCollapseOldAfterDays
} from '@shared/thread-collapse.js'

interface ThreadCollapseState {
  readonly days: number
  update(days: number): Promise<void>
}

/** Copies a value that came from main (the return of `onChanged` / `get` / `set`). Out-of-range and non-integer values are ignored (the current value stays). */
function apply(value: unknown): void {
  if (isCollapseOldAfterDays(value)) useThreadCollapse.setState({ days: value })
}

/**
 * The value used in the first frame (a code-review fix, TODO 659). Same shape as `initialTheme()` (`themeStore.ts`):
 * reads the query (`aios-thread-collapse`) that main attached when opening the window. If we waited for the IPC `get()` round trip,
 * even when the user had changed it to 0 (do not collapse), the first draw of the list right after launch would be built with the default (5 days)
 * and old rows would look collapsed for an instant. If it cannot be obtained, it falls back to the default (5 days), as before.
 */
export function initialCollapseDays(): number {
  const raw = new URLSearchParams(window.location.search).get(THREAD_COLLAPSE_QUERY_KEY)
  if (raw === null) return DEFAULT_COLLAPSE_OLD_AFTER_DAYS
  const parsed = Number(raw)
  return isCollapseOldAfterDays(parsed) ? parsed : DEFAULT_COLLAPSE_OLD_AFTER_DAYS
}

type ThreadCollapseApi = Partial<{
  get(): Promise<unknown>
  set(days: number): Promise<unknown>
  onChanged(listener: (days: number) => void): unknown
}>

function api(): ThreadCollapseApi | undefined {
  return (window as unknown as { aios?: { threadCollapse?: ThreadCollapseApi } }).aios?.threadCollapse
}

export const useThreadCollapse = create<ThreadCollapseState>(() => ({
  days: initialCollapseDays(),

  async update(days: number): Promise<void> {
    // Copy it first (so typing in the input does not revert it). Replaced by the saved value (after validation).
    apply(days)
    const set = api()?.set
    if (typeof set !== 'function') return
    try {
      apply(await set(days))
    } catch {
      // If it could not be saved, it will agree on the next notification / re-read.
    }
  }
}))

let initialized = false

/** Reads the saved value and subscribes to change notifications. Does nothing from the second call on (it is called from both App and the settings screen). */
export function initThreadCollapse(): void {
  if (initialized) return
  initialized = true
  const current = api()
  if (current === undefined) return
  try {
    if (typeof current.onChanged === 'function') current.onChanged((days) => apply(days))
    if (typeof current.get === 'function') {
      void Promise.resolve(current.get()).then(apply, () => undefined)
    }
  } catch {
    // It works with the default.
  }
}
