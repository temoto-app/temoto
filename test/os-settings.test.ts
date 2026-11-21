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
import { APP_OPEN_AT_LOGIN, POWER_PREVENT_SLEEP, agentSettingAccess, type SettingKey } from '../src/common/settings-keys.js'
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
  it('配る版 (packaged・殻でない・既定の userData) だけが null', () => {
    expect(loginItemUnavailable(installed)).toBeNull()
  })
  it('dev・未インストール・殻・複製・OS 違いは理由を返す', () => {
    expect(loginItemUnavailable({ ...installed, devServer: true })).toBe('dev')
    expect(loginItemUnavailable({ ...installed, isPackaged: false })).toBe('not-installed')
    expect(loginItemUnavailable({ ...installed, appIsSymlink: true })).toBe('dev-shell')
    expect(loginItemUnavailable({ ...installed, defaultUserData: false })).toBe('instance')
    expect(loginItemUnavailable({ ...installed, platform: 'linux' })).toBe('platform')
  })
})

describe('設定の鍵の既定と AI の口', () => {
  it('どちらも既定 OFF で、AI が変えるときは承認 (gated)', () => {
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
    const state = { open: initial, sets: [] as boolean[], refuse: false }
    return {
      state,
      backend: {
        isOpenAtLogin: () => state.open,
        setOpenAtLogin: (enabled: boolean) => {
          state.sets.push(enabled)
          if (!state.refuse) state.open = enabled
        }
      }
    }
  }

  it('既定は OFF。ON にすると OS に頼み、OS の答えを覚える', () => {
    const settings = new MemorySettings()
    const os = backend()
    const pref = new OpenAtLoginPreference(settings, os.backend, null)
    expect(pref.get()).toBe(false)
    expect(pref.set(true)).toEqual({ enabled: true, supported: true, reason: null })
    expect(os.state.sets).toEqual([true])
    expect(settings.readTyped(APP_OPEN_AT_LOGIN)).toBe(true)
  })

  it('OS が断ったら、頼んだ値でなく OS の状態を出す', () => {
    const settings = new MemorySettings()
    const os = backend()
    os.state.refuse = true
    const pref = new OpenAtLoginPreference(settings, os.backend, null)
    expect(pref.set(true).enabled).toBe(false)
    expect(settings.readTyped(APP_OPEN_AT_LOGIN)).toBe(false)
  })

  it('利用者がシステム設定で消したら、OS の側を正にして OFF と表示し、起動時に覚えも直す', () => {
    const settings = new MemorySettings()
    settings.writeTyped(APP_OPEN_AT_LOGIN, true)
    const os = backend(false)
    const pref = new OpenAtLoginPreference(settings, os.backend, null)
    expect(pref.get()).toBe(false)
    pref.reconcile()
    expect(settings.readTyped(APP_OPEN_AT_LOGIN)).toBe(false)
  })

  it('配る版でないときは灰色の理由を返し、set は何もしない (OS を呼ばない)', () => {
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
  it('設定 ON・有効な定時ジョブ・電源につながっている・終了中でない、の全部が揃ったときだけ', () => {
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

  it('SleepBlocker は二重に start せず、無いときの stop は何もしない', () => {
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

  it('条件が揃えば start、どれか 1 つが外れたら stop (ジョブ無し・バッテリー・設定 OFF)', () => {
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

  it('onActiveChanged: 抑止の状態が変わったときだけ知らせる (dispose では知らせない)', () => {
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

  it('設定 OFF のままなら一度も start しない', () => {
    const { os, sleep } = policy({ enabled: false, work: true, battery: false })
    sleep.evaluate()
    sleep.evaluate()
    expect(os.calls).toEqual([])
  })

  it('終了 (dispose) で必ず stop し、その後の evaluate は二度と start しない', () => {
    const { os, blocker, sleep } = policy({ enabled: true, work: true, battery: false })
    sleep.evaluate()
    expect(blocker.active).toBe(true)
    sleep.dispose()
    expect(blocker.active).toBe(false)
    expect(sleep.evaluate()).toBe(false)
    expect(os.calls).toEqual(['start', 'stop:101'])
  })

  it('終了が始まった (closing) ら止める', () => {
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

  it('有効な行があれば true、無効な行だけ・行が無いなら false', () => {
    const scheduler = make()
    expect(scheduler.hasUpcomingWork()).toBe(false)
    store.create(input({ enabled: false }), 1_000_000)
    expect(scheduler.hasUpcomingWork()).toBe(false)
    store.create(input(), 1_000_000)
    expect(scheduler.hasUpcomingWork()).toBe(true)
  })

  it('定時で走らない複製 (autoRun なし) では、行があっても false', () => {
    store.create(input(), 1_000_000)
    expect(make(false).hasUpcomingWork()).toBe(false)
  })

  it('idle の plugin のタスクだけなら false (利用者がいる間しか走らないので、起こしておく理由にならない)', () => {
    const scheduler = make()
    scheduler.syncPluginTasks([{ pluginId: 'aios.mail', tasks: [{ id: 'sync', name: 'Sync', defaultInterval: 15, idle: true }] }])
    expect(scheduler.hasUpcomingWork()).toBe(false)
  })

  it('止めた (stop) 後は false', async () => {
    const scheduler = make()
    store.create(input(), 1_000_000)
    await scheduler.stop()
    expect(scheduler.hasUpcomingWork()).toBe(false)
  })
})
