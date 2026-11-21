/**
 * The renderer-side copy of the Redmine base URL (TODO 811, wave 44 bundle A).
 *
 * **The source is main alone** (`web.redmineBaseUrl` in `app_settings`, one for the whole app). A single path: a change in the settings screen is saved to main
 * (only an https URL passes) -> `redmine.onChanged` reaches **all windows** -> this is rewritten. The answer rendering
 * (`ThreadPane`) passes this value to `renderMarkdown` to turn ticket numbers into links. Empty = not set (do nothing).
 *
 * If it cannot be read or the entry point is absent (an old preload / a test fake), it stays empty.
 */
import { create } from 'zustand'

interface RedmineState {
  /** A validated https URL. Empty if not set. */
  readonly baseUrl: string
  /** main validates and saves. main discards unusable values, so replace with the returned value (return = the value after saving). */
  update(value: string): Promise<string>
}

type RedmineApi = Partial<{
  get(): Promise<unknown>
  set(value: string): Promise<unknown>
  onChanged(listener: (baseUrl: string) => void): unknown
}>

function api(): RedmineApi | undefined {
  return (window as unknown as { aios?: { redmine?: RedmineApi } }).aios?.redmine
}

function apply(value: unknown): void {
  if (typeof value === 'string' && value !== useRedmine.getState().baseUrl) useRedmine.setState({ baseUrl: value })
}

export const useRedmine = create<RedmineState>(() => ({
  baseUrl: '',

  async update(value: string): Promise<string> {
    const set = api()?.set
    if (typeof set !== 'function') return useRedmine.getState().baseUrl
    try {
      apply(await set(value))
    } catch {
      // If it cannot be saved, stay as it is.
    }
    return useRedmine.getState().baseUrl
  }
}))

let initialized = false

/** Read the saved value and subscribe to change notifications. Does nothing from the second call on (called from both ThreadPane and the settings screen). */
export function initRedmine(): void {
  if (initialized) return
  initialized = true
  const current = api()
  if (current === undefined) return
  try {
    if (typeof current.onChanged === 'function') current.onChanged((baseUrl) => apply(baseUrl))
    if (typeof current.get === 'function') void Promise.resolve(current.get()).then(apply, () => undefined)
  } catch {
    // It runs while staying empty.
  }
}

export function resetRedmineForTest(): void {
  initialized = false
  useRedmine.setState({ baseUrl: '' })
}
