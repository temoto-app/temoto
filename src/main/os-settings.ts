/**
 * Start at login (TODO 1266) and keep-awake while scheduled jobs wait (TODO 1270), wave 93 bundle C.
 *
 * - `OpenAtLoginPreference`: the stored setting `app.openAtLogin` (default off) + the OS login item. **The OS is the truth** where this process may register
 *   (a distributed build): `get()` reads the OS, and `reconcile()` at launch rewrites the stored value when the user removed (or added) the item in
 *   System Settings. Elsewhere (a development copy, a shell, a `--user-data-dir` copy) it is unavailable with a reason and `set` does nothing.
 * - `PreventSleepPreference` + `SleepPolicy`: the stored setting `power.preventSleep` (default off). The blocker is held only while
 *   `shouldBlockSleep` (setting on, an enabled scheduled job, AC power, not closing) and released the moment any of those stops holding.
 *
 * Both preferences are the only writers of their keys (owner main, TODO 85). Does not import electron: the OS parts arrive as backends
 * (`src/main/os/login-item.ts` / `sleep-blocker.ts`), so tests pass fakes.
 */
import type { MenuBarState, OpenAtLoginState, OsSettingsState, OsSettingUnavailableReason, PreventSleepState } from '@shared/os-settings.js'
import type { AppSettingsStore } from '../common/settings.js'
import { APP_MENU_BAR, APP_OPEN_AT_LOGIN, APP_OPEN_AT_LOGIN_RESTORE, POWER_PREVENT_SLEEP } from '../common/settings-keys.js'
import { log } from '../common/logger.js'
import { isMac } from '../common/os/platform.js'
import { shouldBlockSleep, type SleepBlocker } from './os/sleep-blocker.js'
import type { LoginItemBackend } from './os/login-item.js'

type SettingsAccess = Pick<AppSettingsStore, 'readTyped' | 'writeTyped'>

export class OpenAtLoginPreference {
  private stored: boolean

  constructor(
    private readonly settings: SettingsAccess,
    private readonly backend: LoginItemBackend,
    /** Null if this process may register the login item. */
    private readonly unavailable: OsSettingUnavailableReason | null
  ) {
    this.stored = settings.readTyped(APP_OPEN_AT_LOGIN)
  }

  /** The OS's state where it can be read; the stored memory otherwise. */
  get(): boolean {
    if (this.unavailable !== null) return this.stored
    try {
      return this.backend.isOpenAtLogin()
    } catch (err) {
      log.warn('os.loginItem.readFailed', { error: err instanceof Error ? err.message : String(err) })
      return this.stored
    }
  }

  state(): OpenAtLoginState {
    return { enabled: this.get(), supported: this.unavailable === null, reason: this.unavailable }
  }

  /**
   * At launch: the OS wins over the stored value (the user may have changed the item in System Settings). One exception (review fix for TODO 1277): if the last
   * update's re-registration left the item missing although it was ON, try to put it back once and clear the marker. A user who removed it in System Settings
   * in the gap between that failure and this launch cannot be told apart and gets it back once; a user who had it OFF never has a marker.
   */
  reconcile(): void {
    if (this.unavailable !== null) return
    if (this.settings.readTyped(APP_OPEN_AT_LOGIN_RESTORE)) {
      this.settings.writeTyped(APP_OPEN_AT_LOGIN_RESTORE, false)
      if (!this.get()) {
        try {
          this.backend.setOpenAtLogin(true)
        } catch (err) {
          log.warn('os.loginItem.restoreFailed', { error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    this.remember(this.get())
  }

  /** Ask the OS, then remember what the OS says (it may refuse). Does nothing where unavailable. */
  set(enabled: boolean): OpenAtLoginState {
    if (this.unavailable === null) {
      this.settings.writeTyped(APP_OPEN_AT_LOGIN_RESTORE, false)
      try {
        this.backend.setOpenAtLogin(enabled)
      } catch (err) {
        log.warn('os.loginItem.setFailed', { error: err instanceof Error ? err.message : String(err) })
      }
      this.remember(this.get())
    }
    return this.state()
  }

  /**
   * TODO 1277: register the login item again after an update swap (and once at the first launch after an update), so that the entry follows the installed
   * version and a stale one is dropped. **Does nothing while the item is OFF** (never turns it on) or where unavailable. A failure is logged and swallowed
   * (the update goes on). The result is read back; if the item is not ON, one more attempt, and if that also fails the restore marker is set (see `reconcile`).
   */
  refresh(reason: 'update-applied' | 'first-launch-after-update'): void {
    if (this.unavailable !== null) return
    let wasOn: boolean
    try {
      wasOn = this.backend.isOpenAtLogin()
    } catch (err) {
      log.warn('os.loginItem.refreshFailed', { reason, step: 'read', error: err instanceof Error ? err.message : String(err) })
      return
    }
    if (!wasOn) return
    try {
      this.backend.reregister()
    } catch (err) {
      log.warn('os.loginItem.refreshFailed', { reason, step: 'register', error: err instanceof Error ? err.message : String(err) })
    }
    // `setLoginItemSettings` does not throw when it fails, so read the result back; if the entry is gone, try once more and, failing that, leave a marker
    // so that the next launch's `reconcile` does not take the OS's "off" for the user's intent.
    if (this.readOn()) {
      log.info('os.loginItem.refreshed', { reason })
      return
    }
    try {
      this.backend.setOpenAtLogin(true)
    } catch {
      // Reported below by the read-back.
    }
    if (this.readOn()) {
      log.info('os.loginItem.refreshed', { reason, retried: true })
      return
    }
    log.warn('os.loginItem.refreshFailed', { reason, step: 'verify' })
    this.settings.writeTyped(APP_OPEN_AT_LOGIN_RESTORE, true)
  }

  private readOn(): boolean {
    try {
      return this.backend.isOpenAtLogin()
    } catch {
      return false
    }
  }

  private remember(value: boolean): void {
    if (value === this.stored) return
    this.stored = value
    this.settings.writeTyped(APP_OPEN_AT_LOGIN, value)
  }
}

export class PreventSleepPreference {
  private current: boolean

  constructor(private readonly settings: SettingsAccess) {
    this.current = settings.readTyped(POWER_PREVENT_SLEEP)
  }

  get(): boolean {
    return this.current
  }

  set(enabled: boolean): boolean {
    this.current = enabled
    this.settings.writeTyped(POWER_PREVENT_SLEEP, enabled)
    return this.current
  }
}

/**
 * The macOS menu bar icon (TODO 1269): the stored setting `app.menuBar` (default off). `set` remembers the value and then calls `onChange`
 * so that the tray is created / destroyed (that part touches electron and lives in `src/main/os/tray.ts`). Where there is no menu bar icon
 * (not macOS) `set` does nothing and the state says `supported: false`.
 */
export class MenuBarPreference {
  private current: boolean

  constructor(
    private readonly settings: SettingsAccess,
    private readonly onChange: () => void,
    private readonly supported: boolean = isMac()
  ) {
    this.current = settings.readTyped(APP_MENU_BAR)
  }

  /** The stored value, but false where it cannot be shown (so a value carried over from another machine shows nothing). */
  get(): boolean {
    return this.supported && this.current
  }

  state(): MenuBarState {
    return { enabled: this.get(), supported: this.supported }
  }

  set(enabled: boolean): boolean {
    if (!this.supported) return false
    this.current = enabled
    this.settings.writeTyped(APP_MENU_BAR, enabled)
    this.onChange()
    return this.current
  }
}

export interface SleepPolicyDeps {
  readonly preference: PreventSleepPreference
  readonly blocker: SleepBlocker
  /** `JobScheduler.hasUpcomingWork` (looked up when called; the scheduler is created after this). */
  readonly hasScheduledWork: () => boolean
  readonly onBattery: () => boolean
  readonly closing: () => boolean
  /** Called when `evaluate()` flipped the blocker (not on `dispose()`), so a settings screen showing "holding now" can re-read. */
  readonly onActiveChanged?: (active: boolean) => void
}

/**
 * Decides, from the four facts, whether the blocker is held, and applies it. `evaluate()` is cheap and idempotent: call it on every change
 * (the setting, the job list, AC / battery) and on a slow timer as a safety net. `dispose()` always releases.
 */
export class SleepPolicy {
  private disposed = false

  constructor(private readonly deps: SleepPolicyDeps) {}

  evaluate(): boolean {
    const want =
      !this.disposed &&
      shouldBlockSleep({
        enabled: this.deps.preference.get(),
        hasScheduledWork: this.deps.hasScheduledWork(),
        onBattery: this.deps.onBattery(),
        closing: this.deps.closing()
      })
    const was = this.deps.blocker.active
    this.deps.blocker.apply(want)
    if (want !== was) {
      log.info('os.sleepBlocker.changed', { active: want })
      this.deps.onActiveChanged?.(want)
    }
    return want
  }

  state(): PreventSleepState {
    return { enabled: this.deps.preference.get(), active: this.deps.blocker.active }
  }

  /** On shutdown: release for good (a later `evaluate()` never starts it again). */
  dispose(): void {
    this.disposed = true
    this.deps.blocker.apply(false)
  }
}

export function osSettingsState(openAtLogin: OpenAtLoginPreference, sleep: SleepPolicy, menuBar: MenuBarPreference): OsSettingsState {
  return { openAtLogin: openAtLogin.state(), preventSleep: sleep.state(), menuBar: menuBar.state() }
}
