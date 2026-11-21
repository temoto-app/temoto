/**
 * Scheduled tasks of a plugin (`kind: 'plugin'`, TODO 372 / wave 20 bundle B, ARCHITECTURE.md 6.2.4 / 7.2).
 *
 * This wave is **shape only**: validation of the manifest's `scheduledTasks`; building the list rows from the declaration (`syncPluginTasks`, disabled on install).
 * The user can change only the time and enabled. When the time comes, the run is recorded as "not supported" and skipped
 * (plugin-host is not started; Phase 5). Applies migrations to an in-memory DB and calls `tick()` with a fake clock.
 * Calls neither the model nor plugin-host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { validateScheduledJobInput, type ScheduledJobInput } from '../src/shared/schedule.js'
import { ScheduledJobStore, type StoredJob } from '../src/main/schedule/store.js'
import { JobScheduler, type JobRunner } from '../src/main/schedule/scheduler.js'
import { ManifestError, parseManifest } from '../src/main/plugin/manifest.js'

const MIN = 60_000
const DAY = 24 * 60 * MIN
function mon(hour: number, minute = 0): number {
  return new Date(2026, 9, 5, hour, minute, 0, 0).getTime()
}

describe('scheduledTasks in the manifest (7.2)', () => {
  const base = { id: 'aios.mail', name: 'Mail', version: '1.0.0', host: { entry: 'host.js' } }

  it('reads the declaration (id, name, default interval)', () => {
    const manifest = parseManifest({
      ...base,
      scheduledTasks: [{ id: 'fetch', name: 'Fetch mail', defaultInterval: 30 }]
    })
    expect(manifest.scheduledTasks).toEqual([{ id: 'fetch', name: 'Fetch mail', defaultInterval: 30 }])
    expect(parseManifest(base).scheduledTasks).toBeUndefined()
  })

  // TODO 725 (wave 34 bundle A): raised the interval's upper limit from 1440 minutes to 10080 minutes (7 days).
  it('does not load without host.entry, with overlapping ids, an interval out of range (5 to 10080 minutes), or unknown keys', () => {
    const { host: _host, ...noHost } = base
    void _host
    expect(() => parseManifest({ ...noHost, scheduledTasks: [{ id: 'a', name: 'A', defaultInterval: 30 }] })).toThrow(
      ManifestError
    )
    expect(() =>
      parseManifest({
        ...base,
        scheduledTasks: [
          { id: 'a', name: 'A', defaultInterval: 30 },
          { id: 'a', name: 'B', defaultInterval: 30 }
        ]
      })
    ).toThrow(ManifestError)
    expect(() => parseManifest({ ...base, scheduledTasks: [{ id: 'a', name: 'A', defaultInterval: 4 }] })).toThrow(
      ManifestError
    )
    expect(() => parseManifest({ ...base, scheduledTasks: [{ id: 'a', name: 'A', defaultInterval: 10_081 }] })).toThrow(
      ManifestError
    )
    // Runtime registration and its own times (cron etc.) cannot be written in the declaration.
    expect(() =>
      parseManifest({ ...base, scheduledTasks: [{ id: 'a', name: 'A', defaultInterval: 30, cron: '* * * * *' }] })
    ).toThrow(ManifestError)
  })
})

describe('plugin shape of validateScheduledJobInput', () => {
  it('passes only the strings pluginId / taskId (no prompt field)', () => {
    const input = {
      name: 'Fetch',
      enabled: true,
      spec: { kind: 'interval', minutes: 30 },
      action: { kind: 'plugin', pluginId: 'aios.mail', taskId: 'fetch', prompt: 'ignored' }
    }
    expect(validateScheduledJobInput(input, mon(0))).toEqual({
      name: 'Fetch',
      enabled: true,
      spec: { kind: 'interval', minutes: 30 },
      // TODO 725: an omitted limit on runs comes back as unlimited (null).
      maxRuns: null,
      action: { kind: 'plugin', pluginId: 'aios.mail', taskId: 'fetch' }
    })
    expect(validateScheduledJobInput({ ...input, action: { kind: 'plugin', pluginId: '', taskId: 'x' } }, mon(0))).toBe(
      'invalid-value'
    )
    expect(validateScheduledJobInput({ ...input, action: { kind: 'plugin', pluginId: 'a.b' } }, mon(0))).toBe(
      'invalid-value'
    )
  })
})

describe('JobScheduler and plugin periodic tasks', () => {
  let db: Db
  let store: ScheduledJobStore
  let clock: number
  let runs: StoredJob[]
  let room: boolean
  let changed: number

  const runner = (): JobRunner => ({
    run: async (job) => {
      runs.push(job)
      return 'thread-1'
    },
    resume: async () => undefined,
    sendLater: async () => undefined,
    isThreadInterrupted: () => true,
    isThreadBusy: () => false,
    hasRoom: () => room
  })

  const make = (): JobScheduler =>
    new JobScheduler(store, runner(), {
      autoRun: true,
      now: () => clock,
      schedule: () => () => undefined,
      onChanged: () => {
        changed += 1
      }
    })

  const declared = (tasks: { id: string; name: string; defaultInterval: number }[], pluginId = 'aios.mail') => [
    { pluginId, tasks }
  ]

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    store = new ScheduledJobStore(db)
    clock = mon(7)
    runs = []
    room = true
    changed = 0
  })
  afterEach(() => db.close())

  it('creates rows from the declaration: disabled at install, time is the default interval, and it appears in the list with a plugin mark (kind)', () => {
    const scheduler = make()
    scheduler.syncPluginTasks(declared([{ id: 'fetch', name: 'Fetch mail', defaultInterval: 30 }]))
    expect(changed).toBe(1)
    const [job] = scheduler.overview().jobs
    expect(job).toMatchObject({
      name: 'Fetch mail',
      enabled: false,
      spec: { kind: 'interval', minutes: 30 },
      action: { kind: 'plugin', pluginId: 'aios.mail', taskId: 'fetch' },
      nextRunAt: null
    })
    // Re-syncing with the same declaration changes nothing (and does not push either).
    scheduler.syncPluginTasks(declared([{ id: 'fetch', name: 'Fetch mail', defaultInterval: 30 }]))
    expect(changed).toBe(1)
    expect(scheduler.overview().jobs).toHaveLength(1)
  })

  it('does nothing when the time comes while still disabled', () => {
    const scheduler = make()
    scheduler.syncPluginTasks(declared([{ id: 'fetch', name: 'Fetch', defaultInterval: 30 }]))
    clock += DAY
    const [job] = scheduler.overview().jobs
    expect(scheduler.tick().get(job!.id)).toBe('disabled')
    expect(store.get(job!.id)?.lastOutcome).toBeNull()
  })

  it('when enabled and the time comes, it records it as "未対応" and skips (starts neither the CLI nor plugin-host; does not depend on the limit either)', async () => {
    const scheduler = make()
    scheduler.syncPluginTasks(declared([{ id: 'fetch', name: 'Fetch', defaultInterval: 30 }]))
    const id = scheduler.overview().jobs[0]!.id
    const current = scheduler.overview().jobs[0]!
    scheduler.update(id, { name: current.name, enabled: true, spec: current.spec, action: current.action })
    room = false
    // Even if several runs were missed, it is recorded once (the base advances).
    clock = mon(7) + 3 * DAY
    expect(scheduler.tick().get(id)).toBe('run')
    await Promise.resolve()
    expect(runs).toHaveLength(0)
    const after = store.get(id)!
    expect(after.lastOutcome).toBe('unsupported')
    expect(after.lastSkipAt).toBe(mon(7) + 30 * MIN)
    expect(after.lastRunAt).toBeNull()
    expect(scheduler.tick().get(id)).toBe('not-due')
    // Running now is also only recorded.
    clock += MIN
    scheduler.runNow(id)
    expect(runs).toHaveLength(0)
    expect(store.get(id)?.lastSkipAt).toBe(clock)
  })

  it('the user can change only the time and enabled (name and content stay as declared); cannot be created from the renderer', () => {
    const scheduler = make()
    scheduler.syncPluginTasks(declared([{ id: 'fetch', name: 'Fetch', defaultInterval: 30 }]))
    const id = scheduler.overview().jobs[0]!.id
    scheduler.update(id, {
      name: 'Renamed',
      enabled: true,
      spec: { kind: 'daily', time: '09:00' },
      action: { kind: 'plugin', pluginId: 'other.plugin', taskId: 'evil' }
    })
    expect(scheduler.overview().jobs[0]).toMatchObject({
      name: 'Fetch',
      enabled: true,
      spec: { kind: 'daily', time: '09:00' },
      action: { kind: 'plugin', pluginId: 'aios.mail', taskId: 'fetch' }
    })
    // An update that changes the kind is refused.
    const prompt: ScheduledJobInput = {
      name: 'x',
      enabled: true,
      spec: { kind: 'interval', minutes: 30 },
      action: { kind: 'prompt', prompt: 'p', cwdUri: null, modelId: null, thinking: null, approvalStrict: false }
    }
    expect(() => scheduler.update(id, prompt)).toThrow(/invalid-value/)
    // A plugin's job cannot be created through the renderer's entry point (create).
    expect(() =>
      scheduler.create({ ...prompt, action: { kind: 'plugin', pluginId: 'aios.mail', taskId: 'other' } })
    ).toThrow(/invalid-value/)
  })

  it("version upgrade: reflects name changes and keeps the user's time and enabled; removes tasks dropped from the declaration or whose plugin was removed", () => {
    const scheduler = make()
    scheduler.syncPluginTasks(
      declared([
        { id: 'fetch', name: 'Fetch', defaultInterval: 30 },
        { id: 'index', name: 'Index', defaultInterval: 60 }
      ])
    )
    const fetch = scheduler.overview().jobs.find((j) => j.name === 'Fetch')!
    scheduler.update(fetch.id, { ...fetch, enabled: true, spec: { kind: 'daily', time: '07:00' } })
    scheduler.syncPluginTasks(declared([{ id: 'fetch', name: 'Fetch mail', defaultInterval: 45 }]))
    expect(scheduler.overview().jobs).toEqual([
      expect.objectContaining({
        id: fetch.id,
        name: 'Fetch mail',
        enabled: true,
        spec: { kind: 'daily', time: '07:00' }
      })
    ])
    // When the whole plugin is gone, delete it. The rows of the scheduled prompt are not touched.
    store.create(
      {
        name: 'mine',
        enabled: true,
        spec: { kind: 'daily', time: '08:00' },
        action: { kind: 'prompt', prompt: 'p', cwdUri: null, modelId: null, thinking: null, approvalStrict: false }
      },
      clock
    )
    scheduler.syncPluginTasks([])
    expect(scheduler.overview().jobs.map((j) => j.name)).toEqual(['mine'])
  })

  it('rows of an unknown kind are not listed or run (even when an old version sees a new kind)', () => {
    db.prepare(
      `INSERT INTO scheduled_jobs (id, name, enabled, kind, spec, action, anchor_at, created_at, updated_at)
       VALUES ('x', 'future', 1, 'future-kind', '{"kind":"interval","minutes":15}', '{}', 0, 0, 0)`
    ).run()
    const scheduler = make()
    expect(scheduler.overview().jobs).toEqual([])
    clock += DAY
    expect(scheduler.tick().size).toBe(0)
  })
})
