/**
 * The renderer-side mirror of the viewer auto-save settings (TODO 555, wave 28 bundle D).
 *
 * **Main is the single source** (`viewer.autoSave` / `viewer.autoSaveDelay` in `app_settings`, one for the whole app). A change on the settings
 * screen is saved to main -> `autoSave.onChanged` reaches **all windows** -> it rewrites this: a single path (same shape as `hiddenFilesStore.ts`).
 * Readers are ViewerPane (the clock and the focus watch) and the settings screen.
 *
 * When it cannot be read or there is no entry point (an old preload / a test fake), it stays at the default (`off`), falling back to the old behavior.
 */
import { create } from 'zustand'
import { DEFAULT_AUTO_SAVE, sanitizeAutoSavePatch, type AutoSaveSettings } from '@shared/auto-save.js'

interface AutoSaveState extends AutoSaveSettings {
  /** Either part alone is fine. Replaced with the value main validated and saved. */
  update(patch: Partial<AutoSaveSettings>): Promise<void>
}

/** Validates the value from main and mirrors it (a broken field keeps its current value). */
function apply(value: unknown): void {
  const patch = sanitizeAutoSavePatch(value)
  if (Object.keys(patch).length > 0) useAutoSave.setState(patch)
}

type AutoSaveApi = Partial<{
  get(): Promise<unknown>
  set(patch: Partial<AutoSaveSettings>): Promise<unknown>
  onChanged(listener: (settings: AutoSaveSettings) => void): unknown
}>

function api(): AutoSaveApi | undefined {
  return (window as unknown as { aios?: { autoSave?: AutoSaveApi } }).aios?.autoSave
}

export const useAutoSave = create<AutoSaveState>(() => ({
  ...DEFAULT_AUTO_SAVE,

  async update(patch: Partial<AutoSaveSettings>): Promise<void> {
    // Mirror first (so typing in the input does not snap back). Then replace with the saved (validated) value.
    apply(patch)
    const set = api()?.set
    if (typeof set !== 'function') return
    try {
      apply(await set(patch))
    } catch {
      // If saving fails, it settles with the next notification / re-read.
    }
  }
}))

let initialized = false

/** Reads the saved value and subscribes to change notifications. Does nothing from the second call on (called from both ViewerPane and the settings screen). */
export function initAutoSave(): void {
  if (initialized) return
  initialized = true
  const current = api()
  if (current === undefined) return
  try {
    if (typeof current.onChanged === 'function') current.onChanged((settings) => apply(settings))
    if (typeof current.get === 'function') {
      void Promise.resolve(current.get()).then(apply, () => undefined)
    }
  } catch {
    // Runs with the default.
  }
}
