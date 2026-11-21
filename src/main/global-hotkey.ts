/**
 * Global hotkey (TODO 976 part 1, ARCHITECTURE 3.3). From any app, one key brings aios to the front and focuses the Composer of a new
 * conversation. The key is looked up from `app.summon` (the keyboard shortcut table, scope `global`, default ⌃⌥Space).
 *
 * Does not depend on electron (`globalShortcut` is passed in as a `ShortcutRegistry`). Registration **can fail** by colliding with another app
 * (`register` returns false, or throws), so the result is kept in `status()` and one structured log line is written (the settings screen reads `status()`).
 * Every time the assignment changes, `apply` unregisters the previous key and registers again. Clearing it (null) registers nothing.
 */
import { log } from '../common/logger.js'
import type { GlobalHotkeyStatus } from '@shared/keybindings.js'

/** The part of electron's `globalShortcut` that is needed. */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

/** Upper bound on retries while 'failed' (window focus and periodic calls combined). */
export const MAX_RETRIES = 12

export type { GlobalHotkeyStatus }

export class GlobalHotkey {
  private current: string | null = null
  private state: GlobalHotkeyStatus['state'] = 'off'
  private disposed = false
  private retries = 0

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly onPress: () => void,
    /**
     * If false, do not register (TODO 976 review Y-2). Prevents a dev / verification build / duplicated userData from starting first, grabbing the OS-wide key,
     * and making the aios in use (stable) `failed`. Only the instance with the default userData is true.
     */
    private readonly enabled: boolean = true
  ) {}

  status(): GlobalHotkeyStatus {
    return { accelerator: this.current, state: this.state }
  }

  /** Apply an assignment. null clears it. Does nothing if that key is already registered (retries if it had failed). */
  apply(accelerator: string | null): GlobalHotkeyStatus {
    if (this.disposed) return this.status()
    if (!this.enabled) {
      this.current = accelerator
      this.state = 'disabled'
      return this.status()
    }
    if (accelerator === this.current && this.state === 'registered') return this.status()
    this.release()
    if (accelerator !== this.current) this.retries = 0
    this.current = accelerator
    if (accelerator === null) {
      this.state = 'off'
      return this.status()
    }
    let ok = false
    try {
      ok = this.registry.register(accelerator, () => {
        if (!this.disposed) this.onPress()
      })
    } catch (err) {
      log.warn('hotkey.register.error', { accelerator, message: err instanceof Error ? err.message : String(err) })
    }
    this.state = ok ? 'registered' : 'failed'
    if (ok) log.info('hotkey.registered', { accelerator })
    else log.warn('hotkey.register.failed', { accelerator })
    return this.status()
  }

  /**
   * Retry while 'failed' (TODO 976 review Y-4). Avoids a key that another app held only at the moment of launch staying dead for the whole run.
   * Called on window focus and at a fixed interval. Gives up silently past the limit (`MAX_RETRIES`); changing the assignment resets the count.
   * Returns true only when registration succeeded and the state changed (the caller notifies the settings screen).
   */
  retryIfFailed(): boolean {
    if (this.disposed || !this.enabled || this.state !== 'failed' || this.current === null) return false
    if (this.retries >= MAX_RETRIES) return false
    this.retries += 1
    const accelerator = this.current
    // `apply` re-registers even for the same key if it is failed. `apply` resets the count, so restore it here.
    const used = this.retries
    this.apply(accelerator)
    this.retries = used
    return this.status().state === 'registered'
  }

  /** On shutdown. Afterwards nothing is registered and a key press does nothing. */
  dispose(): void {
    this.disposed = true
    this.release()
    this.state = 'off'
  }

  /**
   * Unregisters the key now if the next assignment differs, without forgetting it (used by `applyHotkeys`, so a key moving between two
   * hotkeys is free before anyone registers it). Does nothing when the key stays the same.
   */
  releaseIfChanging(next: string | null): void {
    if (this.disposed || !this.enabled || next === this.current || this.state !== 'registered') return
    this.release()
    this.state = 'off'
  }

  private release(): void {
    if (this.current === null || this.state !== 'registered') return
    try {
      this.registry.unregister(this.current)
    } catch {
      // Even if unregistering fails, the next registration can still be tried.
    }
  }
}

/**
 * Applies several assignments at once. Every key that changes is unregistered first, then registrations run in array order, so a key moved
 * from one hotkey to another is not still held by this app when the second one registers (electron's `register` returns false for a key
 * this app already holds). When two hotkeys are given the same key, the earlier one in the array wins and the later one reports `failed`.
 */
export function applyHotkeys(entries: ReadonlyArray<{ hotkey: GlobalHotkey | null; accelerator: string | null }>): void {
  for (const { hotkey, accelerator } of entries) hotkey?.releaseIfChanging(accelerator)
  for (const { hotkey, accelerator } of entries) hotkey?.apply(accelerator)
}

/** Retries every failed hotkey (no short-circuit). True when at least one became registered. */
export function retryHotkeys(hotkeys: ReadonlyArray<GlobalHotkey | null>): boolean {
  let changed = false
  for (const hotkey of hotkeys) if (hotkey?.retryIfFailed() === true) changed = true
  return changed
}
