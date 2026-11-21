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
import { APP_MENU_BAR, APP_OPEN_AT_LOGIN, POWER_PREVENT_SLEEP } from '../common/settings-keys.js'
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

  /** At launch: the OS wins over the stored value (the user may have changed the item in System Settings). */
  reconcile(): void {
    if (this.unavailable !== null) return
    this.remember(this.get())
  }

  /** Ask the OS, then remember what the OS says (it may refuse). Does nothing where unavailable. */
  set(enabled: boolean): OpenAtLoginState {
    if (this.unavailable === null) {
      try {
        this.backend.setOpenAtLogin(enabled)
      } catch (err) {
        log.warn('os.loginItem.setFailed', { error: err instanceof Error ? err.message : String(err) })
      }
      this.remember(this.get())
    }
    return this.state()
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
