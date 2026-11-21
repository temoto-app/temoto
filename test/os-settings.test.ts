/**
 * TODO 1266 / 1270 (wave 93 bundle C): start at login and keep the computer awake while scheduled jobs wait.
 *
 * - `loginItemUnavailable`: only a distributed build (packaged, not a symlinked shell, its own default userData) may register.
 * - `OpenAtLoginPreference`: default off; the OS is the truth (a stored `true` that the user removed in System Settings reads as off, and `reconcile` rewrites the memory);
 *   unavailable -> `set` does nothing.
 * - `shouldBlockSleep` / `SleepBlocker` / `SleepPolicy`: held only while setting on + an enabled job + AC power + not closing; always released otherwise and on dispose.
 * - `JobScheduler.hasUpcomingWork`: enabled rows count, idle-repeat plugin tasks and a copy that does not run on schedule do not.
 *
 * Neither electron, the OS, nor a model is touched (electron is mocked; the backends are fakes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { APP_OPEN_AT_LOGIN, APP_OPEN_AT_LOGIN_RESTORE, POWER_PREVENT_SLEEP, agentSettingAccess, type SettingKey } from '../src/common/settings-keys.js'
import { settingDefaults } from '../src/main/settings-snapshot.js'
import { JobScheduler, type JobRunner } from '../src/main/schedule/scheduler.js'
import { ScheduledJobStore } from '../src/main/schedule/store.js'
import type { ScheduledJobInput } from '../src/shared/schedule.js'

vi.mock('electron', () => ({ app: {}, powerMonitor: {}, powerSaveBlocker: {} }))

const { loginItemUnavailable } = await import('../src/main/os/login-item.js')
const { SleepBlocker, shouldBlockSleep } = await import('../src/main/os/sleep-blocker.js')
const { OpenAtLoginPreference, PreventSleepPreference, SleepPolicy } = await import('../src/main/os-settings.js')

class MemorySettings {
  readonly values = new Map<string, string>()
  readTyped<T>(def: SettingKey<T>): T {
    return def.parse(this.values.get(def.key) ?? null)
  }
  writeTyped<T>(def: SettingKey<T>, value: T): void {
    this.values.set(def.key, def.serialize(value))
  }
}

const installed = { platform: 'darwin', isPackaged: true, devServer: false, defaultUserData: true, appIsSymlink: false } as const

describe('loginItemUnavailable (TODO 1266)', () => {
  it('only a distributed build (packaged, not the shell, default userData) gives null', () => {
    expect(loginItemUnavailable(installed)).toBeNull()
  })
  it('dev, not installed, the shell, a copy and a different OS return a reason', () => {
    expect(loginItemUnavailable({ ...installed, devServer: true })).toBe('dev')
    expect(loginItemUnavailable({ ...installed, isPackaged: false })).toBe('not-installed')
    expect(loginItemUnavailable({ ...installed, appIsSymlink: true })).toBe('dev-shell')
    expect(loginItemUnavailable({ ...installed, defaultUserData: false })).toBe('instance')
    expect(loginItemUnavailable({ ...installed, platform: 'linux' })).toBe('platform')
  })
})

describe('defaults of the settings keys and the AI entry', () => {
  it('both default to OFF, and an AI change goes through approval (gated)', () => {
    expect(APP_OPEN_AT_LOGIN.parse(null)).toBe(false)
    expect(POWER_PREVENT_SLEEP.parse(null)).toBe(false)
    expect(settingDefaults().openAtLogin).toBe(false)
    expect(settingDefaults().preventSleep).toBe(false)
    expect(agentSettingAccess(APP_OPEN_AT_LOGIN)).toBe('gated')
    expect(agentSettingAccess(POWER_PREVENT_SLEEP)).toBe('gated')
  })
})

describe('OpenAtLoginPreference (TODO 1266)', () => {
  const backend = (initial = false) => {
    const state = { open: initial, sets: [] as boolean[], refuse: false, reregisters: 0, failReregister: false }
    return {
      state,
      backend: {
        isOpenAtLogin: () => state.open,
        setOpenAtLogin: (enabled: boolean) => {
          state.sets.push(enabled)
          if (!state.refuse) state.open = enabled
        },
        reregister: () => {
          if (state.failReregister) {
            state.open = false
            throw new Error('boom')
          }
          state.reregisters += 1
        }
      }
    }
  }

  it("defaults to OFF; turning it ON asks the OS and remembers the OS's answer", () => {
    const settings = new MemorySettings()
    const os = backend()
    const pref = new OpenAtLoginPreference(settings, os.backend, null)
    expect(pref.get()).toBe(false)
    expect(pref.set(true)).toEqual({ enabled: true, supported: true, reason: null })
    expect(os.state.sets).toEqual([true])
    expect(settings.readTyped(APP_OPEN_AT_LOGIN)).toBe(true)
  })

  it('TODO 1277: refresh re-registers only when ON (calls nothing when OFF and never turns it ON on its own)', () => {
    const on = backend(true)
    new OpenAtLoginPreference(new MemorySettings(), on.backend, null).refresh('update-applied')
    expect(on.state.reregisters).toBe(1)
    const off = backend(false)
    new OpenAtLoginPreference(new MemorySettings(), off.backend, null).refresh('update-applied')
    expect(off.state.reregisters).toBe(0)
    expect(off.state.sets).toEqual([])
  })

  it('TODO 1277: in unusable forms (dev, the shell, a copy) refresh calls nothing', () => {
    const os = backend(true)
    new OpenAtLoginPreference(new MemorySettings(), os.backend, 'dev-shell').refresh('first-launch-after-update')
    expect(os.state.reregisters).toBe(0)
  })

  it('TODO 1277: does not throw when re-registering fails and tries to return to ON', () => {
    const os = backend(true)
    os.state.failReregister = true
    const pref = new OpenAtLoginPreference(new MemorySettings(), os.backend, null)
    expect(() => pref.refresh('update-applied')).not.toThrow()
    expect(os.state.sets).toEqual([true])
  })

  it("TODO 1277 review: if the registration stays silently dropped, leaves a mark and the next launch's reconcile restores it only once (does not turn it ON for someone who has it OFF)", () => {
    const settings = new MemorySettings()
    settings.writeTyped(APP_OPEN_AT_LOGIN, true)
    const os = backend(true)
    // The register step does not throw but leaves the entry off, and the retry is refused too.
    os.backend.reregister = () => {
      os.state.open = false
    }
    os.state.refuse = true
    new OpenAtLoginPreference(settings, os.backend, null).refresh('update-applied')
    expect(settings.readTyped(APP_OPEN_AT_LOGIN_RESTORE)).toBe(true)
    // Next launch: the OS now accepts. The entry comes back, the marker is cleared.
    os.state.refuse = false
    new OpenAtLoginPreference(settings, os.backend, null).reconcile()
    expect(os.state.open).toBe(true)
    expect(settings.readTyped(APP_OPEN_AT_LOGIN)).toBe(true)
    expect(settings.readTyped(APP_OPEN_AT_LOGIN_RESTORE)).toBe(false)
  })

  it('TODO 1277 review: if the read-back after re-registering shows it dropped, an immediate retry restores it (leaves no mark)', () => {
    const settings = new MemorySettings()
    const os = backend(true)
    os.backend.reregister = () => {
      os.state.open = false
    }
    new OpenAtLoginPreference(settings, os.backend, null).refresh('update-applied')
    expect(os.state.open).toBe(true)
    expect(settings.readTyped(APP_OPEN_AT_LOGIN_RESTORE)).toBe(false)
  })

  it('TODO 1277 review: does not restore an item removed in System Settings when there is no mark', () => {
    const settings = new MemorySettings()
    settings.writeTyped(APP_OPEN_AT_LOGIN, true)
    const os = backend(false)
    new OpenAtLoginPreference(settings, os.backend, null).reconcile()
    expect(os.state.sets).toEqual([])
    expect(settings.readTyped(APP_OPEN_AT_LOGIN)).toBe(false)
  })

  it('when the OS refuses, shows the OS state instead of the requested value', () => {
    const settings = new MemorySettings()
    const os = backend()
    os.state.refuse = true
    const pref = new OpenAtLoginPreference(settings, os.backend, null)
    expect(pref.set(true).enabled).toBe(false)
    expect(settings.readTyped(APP_OPEN_AT_LOGIN)).toBe(false)
  })

  it('when the user removed it in System Settings, takes the OS side as the truth, shows OFF and also fixes the remembered value at launch', () => {
    const settings = new MemorySettings()
    settings.writeTyped(APP_OPEN_AT_LOGIN, true)
    const os = backend(false)
    const pref = new OpenAtLoginPreference(settings, os.backend, null)
    expect(pref.get()).toBe(false)
    pref.reconcile()
    expect(settings.readTyped(APP_OPEN_AT_LOGIN)).toBe(false)
  })

  it('when not a distributed build, returns a gray reason and set does nothing (does not call the OS)', () => {
    const settings = new MemorySettings()
    const os = backend()
    const pref = new OpenAtLoginPreference(settings, os.backend, 'dev-shell')
    expect(pref.set(true)).toEqual({ enabled: false, supported: false, reason: 'dev-shell' })
    expect(os.state.sets).toEqual([])
    pref.reconcile()
    expect(settings.values.size).toBe(0)
  })
})

describe('shouldBlockSleep (TODO 1270)', () => {
  const on = { enabled: true, hasScheduledWork: true, onBattery: false, closing: false }
  it('only when all of these hold: setting ON, an enabled scheduled job, connected to power and not quitting', () => {
    expect(shouldBlockSleep(on)).toBe(true)
    expect(shouldBlockSleep({ ...on, enabled: false })).toBe(false)
    expect(shouldBlockSleep({ ...on, hasScheduledWork: false })).toBe(false)
    expect(shouldBlockSleep({ ...on, onBattery: true })).toBe(false)
    expect(shouldBlockSleep({ ...on, closing: true })).toBe(false)
  })
})

describe('SleepBlocker / SleepPolicy (TODO 1270)', () => {
  const fake = () => {
    const calls: string[] = []
    let next = 100
    return {
      calls,
      backend: {
        start: () => {
          calls.push('start')
          next += 1
          return next
        },
        stop: (id: number) => calls.push(`stop:${id}`)
      }
    }
  }

  it('SleepBlocker does not start twice and stop does nothing when there is none', () => {
    const os = fake()
    const blocker = new SleepBlocker(os.backend)
    blocker.apply(false)
    blocker.apply(true)
    blocker.apply(true)
    expect(blocker.active).toBe(true)
    blocker.apply(false)
    blocker.apply(false)
    expect(blocker.active).toBe(false)
    expect(os.calls).toEqual(['start', 'stop:101'])
  })

  const policy = (initial: { enabled: boolean; work: boolean; battery: boolean }) => {
    const os = fake()
    const settings = new MemorySettings()
    const preference = new PreventSleepPreference(settings)
    preference.set(initial.enabled)
    const facts = { work: initial.work, battery: initial.battery, closing: false }
    const blocker = new SleepBlocker(os.backend)
    const sleep = new SleepPolicy({
      preference,
      blocker,
      hasScheduledWork: () => facts.work,
      onBattery: () => facts.battery,
      closing: () => facts.closing
    })
    return { os, facts, preference, blocker, sleep }
  }

  it('starts when the conditions hold and stops when any one is dropped (no jobs, battery, setting OFF)', () => {
    const { os, facts, preference, sleep } = policy({ enabled: true, work: true, battery: false })
    expect(sleep.evaluate()).toBe(true)
    expect(sleep.state()).toEqual({ enabled: true, active: true })
    facts.battery = true
    expect(sleep.evaluate()).toBe(false)
    facts.battery = false
    expect(sleep.evaluate()).toBe(true)
    facts.work = false
    expect(sleep.evaluate()).toBe(false)
    facts.work = true
    expect(sleep.evaluate()).toBe(true)
    preference.set(false)
    expect(sleep.evaluate()).toBe(false)
    expect(os.calls).toEqual(['start', 'stop:101', 'start', 'stop:102', 'start', 'stop:103'])
  })

  it('onActiveChanged: notifies only when the inhibit state changes (does not notify on dispose)', () => {
    const os = fake()
    const preference = new PreventSleepPreference(new MemorySettings())
    preference.set(true)
    const seen: boolean[] = []
    const sleep = new SleepPolicy({
      preference,
      blocker: new SleepBlocker(os.backend),
      hasScheduledWork: () => true,
      onBattery: () => false,
      closing: () => false,
      onActiveChanged: (active) => seen.push(active)
    })
    sleep.evaluate()
    sleep.evaluate()
    preference.set(false)
    sleep.evaluate()
    expect(seen).toEqual([true, false])
    preference.set(true)
    sleep.evaluate()
    sleep.dispose()
    expect(seen).toEqual([true, false, true])
  })

  it('never starts while the setting stays OFF', () => {
    const { os, sleep } = policy({ enabled: false, work: true, battery: false })
    sleep.evaluate()
    sleep.evaluate()
    expect(os.calls).toEqual([])
  })

  it('always stops on dispose (shutdown) and later evaluate never starts again', () => {
    const { os, blocker, sleep } = policy({ enabled: true, work: true, battery: false })
    sleep.evaluate()
    expect(blocker.active).toBe(true)
    sleep.dispose()
    expect(blocker.active).toBe(false)
    expect(sleep.evaluate()).toBe(false)
    expect(os.calls).toEqual(['start', 'stop:101'])
  })

  it('stops when quitting begins (closing)', () => {
    const { facts, blocker, sleep } = policy({ enabled: true, work: true, battery: false })
    sleep.evaluate()
    facts.closing = true
    sleep.evaluate()
    expect(blocker.active).toBe(false)
  })
})

describe('JobScheduler.hasUpcomingWork (TODO 1270)', () => {
  const runner: JobRunner = {
    run: async () => 'thread',
    resume: async () => undefined,
    sendLater: async () => undefined,
    isThreadBusy: () => false,
    isThreadInterrupted: () => false,
    hasRoom: () => true
  }
  const input = (patch: Partial<ScheduledJobInput> = {}): ScheduledJobInput => ({
    name: 'job',
    enabled: true,
    spec: { kind: 'daily', time: '08:00' },
    action: { kind: 'prompt', prompt: 'hello', cwdUri: 'file:///tmp/work', modelId: null, thinking: null, approvalStrict: false },
    ...patch
  })
  let db: Db
  let store: ScheduledJobStore
  const make = (autoRun = true): JobScheduler =>
    new JobScheduler(store, runner, { autoRun, now: () => 1_000_000, schedule: () => () => undefined, defer: () => () => undefined })

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    store = new ScheduledJobStore(db)
  })
  afterEach(() => db.close())

  it('true when there is an enabled row, false when there are only disabled rows or no rows', () => {
    const scheduler = make()
    expect(scheduler.hasUpcomingWork()).toBe(false)
    store.create(input({ enabled: false }), 1_000_000)
    expect(scheduler.hasUpcomingWork()).toBe(false)
    store.create(input(), 1_000_000)
    expect(scheduler.hasUpcomingWork()).toBe(true)
  })

  it('false for a copy that does not run on schedule (no autoRun) even with rows', () => {
    store.create(input(), 1_000_000)
    expect(make(false).hasUpcomingWork()).toBe(false)
  })

  it('false when there are only idle plugin tasks (they run only while the user is present, so they are no reason to stay awake)', () => {
    const scheduler = make()
    scheduler.syncPluginTasks([{ pluginId: 'aios.mail', tasks: [{ id: 'sync', name: 'Sync', defaultInterval: 15, idle: true }] }])
    expect(scheduler.hasUpcomingWork()).toBe(false)
  })

  it('false after stop', async () => {
    const scheduler = make()
    store.create(input(), 1_000_000)
    await scheduler.stop()
    expect(scheduler.hasUpcomingWork()).toBe(false)
  })
})
