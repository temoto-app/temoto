/**
 * IPC for the two OS settings (TODO 1266 / 1270). Connects `OpenAtLoginPreference` / `SleepPolicy` (electron-independent) to ipcMain.
 * Anything other than a boolean from the renderer is refused (the current state is returned). After a change, all windows' settings screens re-read.
 */
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import type { AppSettingsStore } from '../common/settings.js'
import { MenuBarPreference, OpenAtLoginPreference, PreventSleepPreference, SleepPolicy, osSettingsState } from './os-settings.js'
import { electronLoginItemBackend, type LoginItemEnvironment, loginItemUnavailable } from './os/login-item.js'
import { SleepBlocker, electronSleepBackend, onBatteryPower, watchPowerSource } from './os/sleep-blocker.js'

/** How often the keep-awake decision is re-checked even if nothing told us (a safety net for a changed job list). */
const SLEEP_RECHECK_MS = 60_000

export interface OsSettingsHandle {
  readonly openAtLogin: OpenAtLoginPreference
  readonly preventSleep: PreventSleepPreference
  readonly menuBar: MenuBarPreference
  readonly sleepPolicy: SleepPolicy
  /** Re-decide the keep-awake now (call when the scheduled job list changed). */
  readonly reevaluateSleep: () => void
  /** Release the blocker and stop the timers. Idempotent. */
  readonly dispose: () => void
}

export function registerOsSettingsHandlers(deps: {
  readonly settings: AppSettingsStore
  readonly environment: LoginItemEnvironment
  /** `JobScheduler.hasUpcomingWork`; null before the scheduler exists. */
  readonly hasScheduledWork: () => boolean
  readonly closing: () => boolean
  readonly onChanged: () => void
  /** TODO 1269: the menu bar setting changed (create / destroy the tray). */
  readonly onMenuBarChanged: () => void
}): OsSettingsHandle {
  const openAtLogin = new OpenAtLoginPreference(deps.settings, electronLoginItemBackend(), loginItemUnavailable(deps.environment))
  openAtLogin.reconcile()
  const preventSleep = new PreventSleepPreference(deps.settings)
  const menuBar = new MenuBarPreference(deps.settings, deps.onMenuBarChanged)
  const sleepPolicy = new SleepPolicy({
    preference: preventSleep,
    blocker: new SleepBlocker(electronSleepBackend()),
    hasScheduledWork: deps.hasScheduledWork,
    onBattery: onBatteryPower,
    closing: deps.closing,
    // The "holding now" display of the settings screen follows the real state (never push while shutting down).
    onActiveChanged: () => {
      if (!deps.closing()) deps.onChanged()
    }
  })
  const reevaluate = (): void => {
    sleepPolicy.evaluate()
  }
  const unwatch = watchPowerSource(reevaluate)
  const timer = setInterval(reevaluate, SLEEP_RECHECK_MS)
  timer.unref()
  const state = () => osSettingsState(openAtLogin, sleepPolicy, menuBar)

  ipcMain.handle(IpcChannel.osSettingsGet, () => state())
  ipcMain.handle(IpcChannel.osSettingsSetOpenAtLogin, (_event, enabled: unknown) => {
    if (typeof enabled === 'boolean') {
      openAtLogin.set(enabled)
      deps.onChanged()
    }
    return state()
  })
  ipcMain.handle(IpcChannel.osSettingsSetPreventSleep, (_event, enabled: unknown) => {
    if (typeof enabled === 'boolean') {
      preventSleep.set(enabled)
      reevaluate()
      deps.onChanged()
    }
    return state()
  })
  ipcMain.handle(IpcChannel.osSettingsSetMenuBar, (_event, enabled: unknown) => {
    if (typeof enabled === 'boolean') {
      menuBar.set(enabled)
      deps.onChanged()
    }
    return state()
  })

  let disposed = false
  return {
    openAtLogin,
    preventSleep,
    menuBar,
    sleepPolicy,
    reevaluateSleep: reevaluate,
    dispose: () => {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      unwatch()
      sleepPolicy.dispose()
    }
  }
}
