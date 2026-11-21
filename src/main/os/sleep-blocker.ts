/**
 * Of the OS layer (TODO 986), keeping the computer from sleeping on idle (TODO 1270, wave 93 bundle C).
 *
 * `powerSaveBlocker.start('prevent-app-suspension')` keeps the system awake but lets the display turn off, and closing the lid still sleeps
 * (on macOS it holds a `PreventUserIdleSystemSleep` assertion). It is held **only while all of these hold**: the setting is on, an enabled scheduled job
 * exists, the machine is on AC power, and the app is not closing. `shouldBlockSleep` is the pure decision; `SleepBlocker` holds at most one blocker id and
 * always releases it (setting off, no job, battery, quit). Neither imports electron except `electronSleepBackend` / `watchPowerSource` at the bottom.
 */
import { powerMonitor, powerSaveBlocker } from 'electron'

export interface SleepBlockInput {
  /** The stored setting (default off). */
  readonly enabled: boolean
  /** An enabled scheduled job exists (`JobScheduler.hasUpcomingWork`). */
  readonly hasScheduledWork: boolean
  /** `powerMonitor.onBatteryPower`. On battery the screen never asks to stay awake: it would drain the battery. */
  readonly onBattery: boolean
  /** Shutdown has begun. */
  readonly closing: boolean
}

export function shouldBlockSleep(input: SleepBlockInput): boolean {
  return input.enabled && input.hasScheduledWork && !input.onBattery && !input.closing
}

/** The OS side. `start` returns an id to hand back to `stop`. */
export interface SleepBlockerBackend {
  start(): number
  stop(id: number): void
}

/** Holds at most one blocker. `apply(true)` twice starts once; `apply(false)` without a blocker does nothing. */
export class SleepBlocker {
  private id: number | null = null

  constructor(private readonly backend: SleepBlockerBackend) {}

  get active(): boolean {
    return this.id !== null
  }

  apply(want: boolean): void {
    if (want && this.id === null) {
      this.id = this.backend.start()
    } else if (!want && this.id !== null) {
      const id = this.id
      this.id = null
      this.backend.stop(id)
    }
  }
}

export function electronSleepBackend(): SleepBlockerBackend {
  return {
    start: () => powerSaveBlocker.start('prevent-app-suspension'),
    stop: (id) => {
      if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id)
    }
  }
}

export function onBatteryPower(): boolean {
  return powerMonitor.onBatteryPower
}

/** Calls `listener` when the machine switches between AC power and battery. Returns the unsubscribe. */
export function watchPowerSource(listener: () => void): () => void {
  powerMonitor.on('on-ac', listener)
  powerMonitor.on('on-battery', listener)
  return () => {
    powerMonitor.removeListener('on-ac', listener)
    powerMonitor.removeListener('on-battery', listener)
  }
}
