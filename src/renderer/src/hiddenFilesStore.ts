/**
 * The file tree's "Show hidden files" (TODO 261, wave 15 bundle D).
 *
 * **The source is in one place, main** (`ui.showHiddenFiles` in `app_settings`, one for the whole app). Whether toggled from
 * the tree heading's toggle, the menu's ⌘⇧. (main toggles it directly), or the renderer's keydown (insurance),
 * it is a single path: save to main -> `onShowHiddenChanged` reaches **all windows** -> each window
 * refetches its open listings.
 *
 * This is a separate store from `store.ts` (the tree): `store.ts` is also touched by other bundles, so the hidden state and
 * the path pins are kept closed inside here. `store.ts` only calls `listOptionsFor` / `pinForExpand`.
 */
import { create } from 'zustand'
import type { ListDirectoryOptions } from '@shared/types.js'
import { isToggleHiddenKey, listOptions, shouldPin } from './hidden-files.js'
import { keyPlatformOf } from './composer-keys.js'
import { matchesCommandKey } from './shortcuts.js'

interface HiddenFilesState {
  /** Whether to show names starting with ".". The default is false (hide). */
  readonly show: boolean
  /**
   * Directories starting with "." that were `expand`ed while hiding (paths such as the working folder's reveal).
   * Even in a hidden listing these and their ancestors are not removed. Remembered until the window closes (not saved).
   */
  readonly pins: ReadonlySet<string>
  toggle(): Promise<void>
}

export const useHiddenFiles = create<HiddenFilesState>((set, get) => ({
  show: false,
  pins: new Set<string>(),

  async toggle(): Promise<void> {
    const saved = await window.aios.fs.setShowHidden(!get().show)
    // The same value also arrives via the notice to all windows (`onShowHiddenChanged`). Here it is only applied earlier.
    if (saved !== get().show) set({ show: saved })
  }
}))

let initialized: Promise<void> | null = null

/**
 * Read the saved value and subscribe to change notices. `relist` is the entry point that refetches open listings when the way of showing changes
 * (`store.ts`). Call it before the tree's first listing (`store.init`). Does nothing from the second call on.
 */
export function initHiddenFiles(relist: () => void): Promise<void> {
  if (initialized !== null) return initialized
  initialized = (async () => {
    try {
      useHiddenFiles.setState({ show: await window.aios.fs.getShowHidden() })
    } catch {
      // If it cannot be read, it stays at the default (hide).
    }
    // With no subscription entry point (an old preload / a test fake), it works with the default as it is.
    window.aios.fs.onShowHiddenChanged?.((show) => {
      // Even if this window's own toggle has already applied it, the listing is refetched (it has not been refetched yet).
      if (show !== useHiddenFiles.getState().show) useHiddenFiles.setState({ show })
      relist()
    })
    // Insurance for when the menu's accelerator did not eat it (`isToggleHiddenKey`).
    const platform = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', (event) => {
        // If the user changed the assignment, that key (TODO 549).
        if (!matchesCommandKey('view.hiddenFiles', event, () => isToggleHiddenKey(event, platform))) return
        event.preventDefault()
        void useHiddenFiles.getState().toggle()
      })
    }
  })()
  return initialized
}

/** How to show things when asking for the listing of `uri`. `extras` are the selected file and reveal rows (kept as paths). */
export function listOptionsFor(uri: string, extras: readonly (string | null)[]): ListDirectoryOptions {
  const { show, pins } = useHiddenFiles.getState()
  return listOptions(uri, show, [...pins, ...extras])
}

/**
 * Call before `expand(uri)`. If a directory starting with "." is being opened while hiding (= it came as a path),
 * pin it and return true; the caller refetches the parent's listing (it does not appear in the parent's listing yet).
 */
export function pinForExpand(uri: string): boolean {
  const { show, pins } = useHiddenFiles.getState()
  if (!shouldPin(uri, show) || pins.has(uri)) return false
  useHiddenFiles.setState({ pins: new Set(pins).add(uri) })
  return true
}
