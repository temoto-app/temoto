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

describe('マニフェストの scheduledTasks (7.2)', () => {
  const base = { id: 'aios.mail', name: 'Mail', version: '1.0.0', host: { entry: 'host.js' } }

  it('宣言を読める (id・名前・既定の間隔)', () => {
    const manifest = parseManifest({
      ...base,
      scheduledTasks: [{ id: 'fetch', name: 'Fetch mail', defaultInterval: 30 }]
    })
    expect(manifest.scheduledTasks).toEqual([{ id: 'fetch', name: 'Fetch mail', defaultInterval: 30 }])
    expect(parseManifest(base).scheduledTasks).toBeUndefined()
  })

  // TODO 725 (wave 34 bundle A): raised the interval's upper limit from 1440 minutes to 10080 minutes (7 days).
  it('host.entry が要る・id の重なり・間隔の範囲 (5〜10080 分)・知らない鍵は読み込まない', () => {
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

describe('validateScheduledJobInput の plugin の形', () => {
  it('pluginId / taskId の文字列だけを通す (プロンプトの欄は持たない)', () => {
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

describe('JobScheduler と plugin の定期タスク', () => {
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

  it('宣言から行を作る: 導入時は無効、時刻は既定の間隔、一覧に plugin の印 (kind) で出る', () => {
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

  it('無効のままなら時刻が来ても何もしない', () => {
    const scheduler = make()
    scheduler.syncPluginTasks(declared([{ id: 'fetch', name: 'Fetch', defaultInterval: 30 }]))
    clock += DAY
    const [job] = scheduler.overview().jobs
    expect(scheduler.tick().get(job!.id)).toBe('disabled')
    expect(store.get(job!.id)?.lastOutcome).toBeNull()
  })

  it('有効にして時刻が来たら「未対応」として記録して飛ばす (CLI も plugin-host も起こさない。上限にも依らない)', async () => {
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

  it('利用者が変えられるのは時刻と有効だけ (名前・中身は宣言のまま)。renderer からは作れない', () => {
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

  it('版上げ: 名前の変更は反映し、利用者の時刻・有効は残す。宣言から外れた・plugin を消したタスクは消す', () => {
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

  it('知らない種類の行は一覧に出さず走らせない (古い版が新しい種類を見ても同じ)', () => {
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
