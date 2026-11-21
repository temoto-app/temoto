/**
 * Scheduled runs (TODO 323 stage 1, ARCHITECTURE.md 6.2.4).
 *
 * The first half is the pure functions for writing times (the simple form / cron expression) and for the next time. The second half applies migration 18 to the real (in-memory) DB
 * and calls `JobScheduler.tick()` with a fake clock: runs as planned; even if several runs are missed while stopped, it catches up only once; if the previous run is still going, it skips; at the limit it waits; run now; shutdown.
 * Does not call the model (the entry point that wakes a thread is a fake).
 *
 * Times are built as local time (`new Date(y, m, d, h, mi)`). So that the result is the same in every time zone, a day with no daylight-saving transition (2026-10-05, Monday) is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { log } from '../src/common/logger.js'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import {
  checkOnceNotPast,
  checkScheduleSpec,
  nextCronTime,
  nextScheduleTime,
  ONCE_CATCH_UP_LIMIT_MS,
  parseCron,
  parseTimeOfDay,
  runsPerDay,
  validateScheduledJobInput,
  type ScheduledJobInput
} from '../src/shared/schedule.js'
import { ScheduledJobStore, type StoredJob } from '../src/main/schedule/store.js'
import { decideJob, JobScheduler, LATER_AUTO_RETRIES, LATER_PAST_DELAY_MS, RESUME_PAST_DELAY_MS, type JobRunner } from '../src/main/schedule/scheduler.js'
import { asId, checkJobInput } from '../src/main/schedule/input.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Local time of 2026-10-05 (Mon). */
function mon(hour: number, minute = 0): number {
  return new Date(2026, 9, 5, hour, minute, 0, 0).getTime()
}

describe('時刻の書き方 (純関数)', () => {
  it('HH:MM を読む', () => {
    expect(parseTimeOfDay('08:00')).toEqual({ hour: 8, minute: 0 })
    expect(parseTimeOfDay('8:05')).toEqual({ hour: 8, minute: 5 })
    expect(parseTimeOfDay('23:59')).toEqual({ hour: 23, minute: 59 })
    expect(parseTimeOfDay('24:00')).toBeNull()
    expect(parseTimeOfDay('8:5')).toBeNull()
    expect(parseTimeOfDay('')).toBeNull()
  })

  it('cron 式を読む: 範囲・刻み・名前・7 = 日曜', () => {
    const cron = parseCron('*/15 9-17 * * mon-fri')
    expect(cron).not.toBeNull()
    expect([...(cron?.minutes ?? [])]).toEqual([0, 15, 30, 45])
    expect([...(cron?.hours ?? [])]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...(cron?.weekdays ?? [])]).toEqual([1, 2, 3, 4, 5])
    expect([...(parseCron('0 0 * * 7')?.weekdays ?? [])]).toEqual([0])
    expect([...(parseCron('5/20 * * * *')?.minutes ?? [])]).toEqual([5, 25, 45])
    expect([...(parseCron('0 0 1 jan,jul *')?.months ?? [])]).toEqual([1, 7])
  })

  it('壊れた cron 式は null', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '1,,2 * * * *']) {
      expect(parseCron(bad), bad).toBeNull()
    }
  })

  it('次の当たりは「後」の最初の分の頭', () => {
    const cron = parseCron('0 8 * * *')!
    expect(nextCronTime(cron, mon(7, 59))).toBe(mon(8, 0))
    // From exactly that time, the next is the following day.
    expect(nextCronTime(cron, mon(8, 0))).toBe(mon(8, 0) + DAY)
    expect(nextCronTime(cron, mon(8, 0) + 30_000)).toBe(mon(8, 0) + DAY)
  })

  it('日と曜日の両方を指定したらどちらかで当たる (Vixie cron)', () => {
    // The 10th of every month, or Monday at 0:00. After 10/5 (Mon) comes 10/10 (Sat), then 10/12 (Mon).
    const cron = parseCron('0 0 10 * 1')!
    expect(nextCronTime(cron, mon(1))).toBe(new Date(2026, 9, 10).getTime())
    expect(nextCronTime(cron, new Date(2026, 9, 10, 1).getTime())).toBe(new Date(2026, 9, 12).getTime())
  })

  it('当たらない式 (2 月 30 日) は null で止まる', () => {
    expect(nextCronTime(parseCron('0 0 30 2 *')!, mon(0))).toBeNull()
    expect(checkScheduleSpec({ kind: 'cron', expression: '0 0 30 2 *' }, mon(0))).toBe('schedule-cron-invalid')
  })

  it('簡易形: 毎日 / 平日 / n 分ごと', () => {
    expect(nextScheduleTime({ kind: 'daily', time: '08:00' }, mon(9))).toBe(mon(8) + DAY)
    // The next weekday 8:00 after Friday 9:00 is Monday.
    const fri = new Date(2026, 9, 9, 9).getTime()
    expect(nextScheduleTime({ kind: 'weekdays', time: '08:00' }, fri)).toBe(new Date(2026, 9, 12, 8).getTime())
    expect(nextScheduleTime({ kind: 'interval', minutes: 30 }, mon(9))).toBe(mon(9, 30))
    expect(nextScheduleTime({ kind: 'daily', time: 'x' }, mon(9))).toBeNull()
  })

  it('間隔の下限は 5 分 (n 分ごとも cron 式も、TODO 1220)', () => {
    expect(checkScheduleSpec({ kind: 'interval', minutes: 15 }, mon(0))).toBeNull()
    expect(checkScheduleSpec({ kind: 'interval', minutes: 5 }, mon(0))).toBeNull()
    expect(checkScheduleSpec({ kind: 'interval', minutes: 4 }, mon(0))).toBe('schedule-too-frequent')
    // TODO 725: raised the upper limit from 1440 minutes to 10080 minutes (7 days). 1441 minutes passes now.
    expect(checkScheduleSpec({ kind: 'interval', minutes: 1441 }, mon(0))).toBeNull()
    expect(checkScheduleSpec({ kind: 'interval', minutes: 10_080 }, mon(0))).toBeNull()
    expect(checkScheduleSpec({ kind: 'interval', minutes: 10_081 }, mon(0))).toBe('schedule-interval-invalid')
    expect(checkScheduleSpec({ kind: 'interval', minutes: 20.5 }, mon(0))).toBe('schedule-interval-invalid')
    expect(checkScheduleSpec({ kind: 'cron', expression: '*/15 * * * *' }, mon(0))).toBeNull()
    expect(checkScheduleSpec({ kind: 'cron', expression: '*/5 * * * *' }, mon(0))).toBeNull()
    expect(checkScheduleSpec({ kind: 'cron', expression: '*/4 * * * *' }, mon(0))).toBe('schedule-too-frequent')
    // Even two runs in one day are refused if the gap is 4 minutes.
    expect(checkScheduleSpec({ kind: 'cron', expression: '0,4 9 * * *' }, mon(0))).toBe('schedule-too-frequent')
    // A too-close pair that fires on one day of the week only (Saturday, 3 minutes apart) is also caught: the check looks ahead across the week.
    expect(checkScheduleSpec({ kind: 'cron', expression: '0,3 9 * * 6' }, mon(0))).toBe('schedule-too-frequent')
    expect(checkScheduleSpec({ kind: 'daily', time: '25:00' }, mon(0))).toBe('schedule-time-invalid')
    expect(checkScheduleSpec({ kind: 'cron', expression: 'nope' }, mon(0))).toBe('schedule-cron-invalid')
  })

  it('1 日あたりの回数 (7 日のうち最も多い日)', () => {
    expect(runsPerDay({ kind: 'daily', time: '08:00' }, mon(12))).toBe(1)
    expect(runsPerDay({ kind: 'weekdays', time: '08:00' }, mon(12))).toBe(1)
    expect(runsPerDay({ kind: 'interval', minutes: 15 }, mon(12))).toBe(96)
    expect(runsPerDay({ kind: 'interval', minutes: 1440 }, mon(12))).toBe(1)
    expect(runsPerDay({ kind: 'cron', expression: '0 9,18 * * *' }, mon(12))).toBe(2)
    expect(runsPerDay({ kind: 'cron', expression: '0 0 * * *' }, mon(12))).toBe(1)
    expect(runsPerDay({ kind: 'cron', expression: '*/30 9-10 * * 1-5' }, mon(12))).toBe(4)
    expect(runsPerDay({ kind: 'cron', expression: 'bad' }, mon(12))).toBe(0)
  })

  it('入力の検査: 名前・プロンプト・形', () => {
    const ok = {
      name: ' 朝の確認 ',
      enabled: true,
      spec: { kind: 'daily', time: ' 8:00 ' },
      action: { kind: 'prompt', prompt: 'メールを見て', cwdUri: null, modelId: null, thinking: null, approvalStrict: false }
    }
    const result = validateScheduledJobInput(ok, mon(0))
    expect(typeof result).toBe('object')
    expect((result as ScheduledJobInput).name).toBe('朝の確認')
    expect((result as ScheduledJobInput).spec).toEqual({ kind: 'daily', time: '8:00' })
    expect(validateScheduledJobInput({ ...ok, name: '  ' }, mon(0))).toBe('schedule-name-empty')
    expect(validateScheduledJobInput({ ...ok, action: { ...ok.action, prompt: ' ' } }, mon(0))).toBe('schedule-prompt-empty')
    expect(validateScheduledJobInput({ ...ok, action: { ...ok.action, thinking: 'ultra' } }, mon(0))).toBe('invalid-value')
    expect(validateScheduledJobInput({ ...ok, action: { ...ok.action, kind: 'plugin' } }, mon(0))).toBe('invalid-value')
    expect(validateScheduledJobInput({ ...ok, spec: { kind: 'interval', minutes: 4 } }, mon(0))).toBe('schedule-too-frequent')
    expect(validateScheduledJobInput(null, mon(0))).toBe('invalid-value')
  })

  it('TODO 629: 「1 回だけ」は基準より後の 1 回だけ返す。読めない日時は null', () => {
    const spec = { kind: 'once', at: '2026-10-05T09:30' } as const
    expect(nextScheduleTime(spec, mon(8))).toBe(new Date(2026, 9, 5, 9, 30).getTime())
    // If the base is already past that time, there is no next run (only once).
    expect(nextScheduleTime(spec, new Date(2026, 9, 5, 9, 30).getTime())).toBeNull()
    expect(nextScheduleTime({ kind: 'once', at: 'not-a-date' }, mon(0))).toBeNull()
    expect(checkScheduleSpec(spec, mon(0))).toBeNull()
    expect(checkScheduleSpec({ kind: 'once', at: 'nope' }, mon(0))).toBe('schedule-once-invalid')
    expect(runsPerDay(spec, mon(0))).toBe(1)
    // More than a week ahead, or already past, gives 0.
    expect(runsPerDay(spec, new Date(2026, 9, 20).getTime())).toBe(0)
    expect(runsPerDay(spec, new Date(2026, 9, 5, 10).getTime())).toBe(0)
  })

  it('code-review (629): 有効な「1 回だけ」の過去の日時は入力の検査で断る。無効の行は問わない', () => {
    const past = { kind: 'once', at: '2026-10-05T06:00' } as const
    const future = { kind: 'once', at: '2026-10-05T09:00' } as const
    expect(checkOnceNotPast(past, true, mon(7))).toBe('schedule-once-past')
    expect(checkOnceNotPast({ kind: 'once', at: '2026-10-05T07:00' }, true, mon(7))).toBe('schedule-once-past')
    expect(checkOnceNotPast(future, true, mon(7))).toBeNull()
    expect(checkOnceNotPast(past, false, mon(7))).toBeNull()
    expect(checkOnceNotPast({ kind: 'daily', time: '06:00' }, true, mon(7))).toBeNull()
    const input = {
      name: 'once',
      enabled: true,
      spec: past,
      action: { kind: 'prompt', prompt: 'p', cwdUri: null, modelId: null, thinking: null, approvalStrict: false }
    }
    expect(validateScheduledJobInput(input, mon(7))).toBe('schedule-once-past')
    expect(typeof validateScheduledJobInput({ ...input, enabled: false }, mon(7))).toBe('object')
    expect(typeof validateScheduledJobInput({ ...input, spec: future }, mon(7))).toBe('object')
    expect(() => checkJobInput(input, () => undefined, mon(7))).toThrow('aios-reason:schedule-once-past')
  })
})

describe('decideJob (純関数)', () => {
  const job = { enabled: true, spec: { kind: 'daily', time: '08:00' } as const, anchorAt: mon(7) }
  it('予定が来ていなければ not-due、来たら run', () => {
    expect(decideJob({ job, now: mon(7, 59), running: false, room: true })).toBe('not-due')
    expect(decideJob({ job, now: mon(8), running: false, room: true })).toBe('run')
  })
  it('無効 / 走っている / 上限', () => {
    expect(decideJob({ job: { ...job, enabled: false }, now: mon(9), running: false, room: true })).toBe('disabled')
    expect(decideJob({ job, now: mon(9), running: true, room: true })).toBe('skip-running')
    expect(decideJob({ job, now: mon(9), running: false, room: false })).toBe('wait-room')
  })
  it('走っていても予定前なら飛ばさない (基準を進めない)', () => {
    expect(decideJob({ job, now: mon(7, 30), running: true, room: true })).toBe('not-due')
  })

  it('TODO 629: 「1 回だけ」が 24 時間以上過ぎていたら skip-too-late (他の種類は追いつく)', () => {
    const onceJob = { enabled: true, spec: { kind: 'once', at: '2026-10-05T08:00' } as const, anchorAt: mon(0) }
    expect(decideJob({ job: onceJob, now: mon(8) + ONCE_CATCH_UP_LIMIT_MS, running: false, room: true })).toBe('run')
    expect(
      decideJob({ job: onceJob, now: mon(8) + ONCE_CATCH_UP_LIMIT_MS + MIN, running: false, room: true })
    ).toBe('skip-too-late')
    // Other kinds (daily) catch up however many days have passed (kept as anacron).
    expect(decideJob({ job, now: mon(8) + 10 * DAY, running: false, room: true })).toBe('run')
  })
})

describe('JobScheduler (偽の時計 + メモリの DB)', () => {
  let db: Db
  let store: ScheduledJobStore
  let clock: number
  let runs: StoredJob[]
  let resumes: { threadId: string; prompt: string }[]
  let laters: { threadId: string; text: string; attachments: number; settings: unknown }[]
  let busy: Set<string>
  /** A thread resumed by hand, or whose interruption has been lifted (`isThreadInterrupted` is false). */
  let resumed: Set<string>
  let room: boolean
  let fail: Error | null
  let pending: (() => void) | null
  let threadSeq: number

  const input = (patch: Partial<ScheduledJobInput> = {}): ScheduledJobInput => ({
    name: 'job',
    enabled: true,
    spec: { kind: 'daily', time: '08:00' },
    action: { kind: 'prompt', prompt: 'hello', cwdUri: 'file:///tmp/work', modelId: null, thinking: null, approvalStrict: false },
    ...patch
  })

  const runner = (): JobRunner => ({
    run: async (job) => {
      runs.push(job)
      if (pending !== null) await new Promise<void>((resolve) => { pending = resolve })
      if (fail !== null) throw fail
      threadSeq += 1
      return `thread-${threadSeq}`
    },
    resume: async (threadId, prompt) => {
      resumes.push({ threadId, prompt })
      if (pending !== null) await new Promise<void>((resolve) => { pending = resolve })
      if (fail !== null) throw fail
    },
    sendLater: async (threadId, text, attachments, settings) => {
      laters.push({ threadId, text, attachments: attachments.length, settings })
      if (fail !== null) throw fail
    },
    isThreadInterrupted: (threadId) => !resumed.has(threadId),
    isThreadBusy: (threadId) => busy.has(threadId),
    hasRoom: () => room
  })

  const make = (autoRun = true): JobScheduler =>
    new JobScheduler(store, runner(), { autoRun, now: () => clock, schedule: () => () => undefined })

  /** Flushes the clean-up of the woken run (the Promise chain). */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    store = new ScheduledJobStore(db)
    clock = mon(7)
    runs = []
    resumes = []
    laters = []
    busy = new Set()
    resumed = new Set()
    room = true
    fail = null
    pending = null
    threadSeq = 0
  })
  afterEach(() => db.close())

  it('migration 18: 表とスレッドの印の列がある', () => {
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(18)
    const columns = (db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[]).map((c) => c.name)
    expect(columns).toContain('schedule_job_id')
  })

  it('予定の時刻に 1 回走り、記録が残る', async () => {
    const scheduler = make()
    const job = store.create(input(), clock)
    clock = mon(7, 59)
    expect(scheduler.tick().get(job.id)).toBe('not-due')
    clock = mon(8, 0) + 10_000
    expect(scheduler.tick().get(job.id)).toBe('run')
    await settle()
    expect(runs).toHaveLength(1)
    const after = store.get(job.id)!
    expect(after.lastRunAt).toBe(clock)
    expect(after.lastOutcome).toBe('started')
    expect(after.lastThreadId).toBe('thread-1')
    // Ticking again in the same minute does not run it.
    clock += 20_000
    expect(scheduler.tick().get(job.id)).toBe('not-due')
    expect(runs).toHaveLength(1)
    // The next run in the list is 8:00 the following day.
    expect(scheduler.overview().jobs[0]?.nextRunAt).toBe(mon(8) + DAY)
  })

  it('止まっていた間に何回分逃しても、起動時に 1 回だけ追いつく (anacron)', async () => {
    store.create(input({ spec: { kind: 'interval', minutes: 15 } }), clock)
    // It had been stopped for 3 days.
    clock = mon(7) + 3 * DAY
    const scheduler = make()
    scheduler.start()
    await settle()
    expect(runs).toHaveLength(1)
    scheduler.tick()
    await settle()
    expect(runs).toHaveLength(1)
    // The next one is 15 minutes after the time it ran.
    clock += 15 * MIN
    scheduler.tick()
    await settle()
    expect(runs).toHaveLength(2)
  })

  it('スリープ明けも同じ判定 (刻みが飛んでも 1 回)', async () => {
    const scheduler = make()
    const job = store.create(input(), clock)
    // Asleep for 2 days; the first tick after waking.
    clock = mon(7) + 2 * DAY + 30 * MIN
    expect(scheduler.tick().get(job.id)).toBe('run')
    await settle()
    expect(scheduler.tick().get(job.id)).toBe('not-due')
    expect(runs).toHaveLength(1)
  })

  it('作った時刻より前の予定では走らない', () => {
    clock = mon(8, 30)
    const job = store.create(input(), clock)
    expect(make().tick().get(job.id)).toBe('not-due')
  })

  it('前回がまだ走っていれば今回は飛ばし、次の予定まで待つ', async () => {
    const scheduler = make()
    const job = store.create(input(), clock)
    clock = mon(8)
    scheduler.tick()
    await settle()
    busy.add('thread-1')
    clock = mon(8) + DAY
    expect(scheduler.tick().get(job.id)).toBe('skip-running')
    expect(store.get(job.id)?.lastOutcome).toBe('skipped')
    // TODO 351: "last run" (lastRunAt, mon(8)) and "skipped run" (lastSkipAt, mon(8) + DAY) are separate values.
    expect(store.get(job.id)?.lastRunAt).toBe(mon(8))
    expect(store.get(job.id)?.lastSkipAt).toBe(mon(8) + DAY)
    // Even when the previous run finishes, a skipped run is not run later.
    busy.clear()
    clock += 10 * MIN
    expect(scheduler.tick().get(job.id)).toBe('not-due')
    expect(runs).toHaveLength(1)
  })

  it('セッション数の上限に当たっていれば飛ばさず待つ', async () => {
    const scheduler = make()
    const job = store.create(input(), clock)
    room = false
    clock = mon(8)
    expect(scheduler.tick().get(job.id)).toBe('wait-room')
    expect(runs).toHaveLength(0)
    room = true
    clock += 30_000
    expect(scheduler.tick().get(job.id)).toBe('run')
    await settle()
    expect(runs).toHaveLength(1)
  })

  it('起こしている最中は「走っている」— 二重に起こさない', async () => {
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'interval', minutes: 15 } }), clock)
    pending = () => undefined
    clock += 15 * MIN
    scheduler.tick()
    expect(scheduler.overview().jobs[0]?.running).toBe(true)
    expect(() => scheduler.runNow(job.id)).toThrow(/schedule-job-running/)
    clock += 15 * MIN
    expect(scheduler.tick().get(job.id)).toBe('skip-running')
    const release = pending as unknown as () => void
    release()
    await settle()
    expect(runs).toHaveLength(1)
  })

  it('失敗は理由を残し、次の予定まで繰り返さない', async () => {
    const scheduler = make()
    const job = store.create(input(), clock)
    fail = new Error('aios-reason:agent-not-logged-in')
    clock = mon(8)
    scheduler.tick()
    await settle()
    expect(store.get(job.id)?.lastOutcome).toBe('failed')
    expect(store.get(job.id)?.lastError).toContain('agent-not-logged-in')
    clock += 30_000
    expect(scheduler.tick().get(job.id)).toBe('not-due')
  })

  it('今すぐ実行は予定の基準を動かさない', async () => {
    const scheduler = make()
    const job = store.create(input(), clock)
    clock = mon(7, 50)
    scheduler.runNow(job.id)
    await settle()
    expect(runs).toHaveLength(1)
    expect(store.get(job.id)?.lastRunAt).toBe(mon(7, 50))
    clock = mon(8)
    expect(scheduler.tick().get(job.id)).toBe('run')
    expect(() => scheduler.runNow('nope')).toThrow(/schedule-job-not-found/)
  })

  it('時刻を変えた・有効にしたら基準は今 (過去の予定で走らない)。名前だけなら据え置き', () => {
    const scheduler = make()
    const job = store.create(input({ enabled: false }), clock)
    clock = mon(9)
    expect(scheduler.tick().get(job.id)).toBe('disabled')
    scheduler.update(job.id, input({ enabled: true }))
    expect(scheduler.tick().get(job.id)).toBe('not-due')
    expect(store.get(job.id)?.anchorAt).toBe(mon(9))
    clock = mon(10)
    scheduler.update(job.id, input({ name: 'renamed' }))
    expect(store.get(job.id)?.anchorAt).toBe(mon(9))
    scheduler.update(job.id, input({ name: 'renamed', spec: { kind: 'daily', time: '09:30' } }))
    expect(store.get(job.id)?.anchorAt).toBe(mon(10))
    expect(scheduler.tick().get(job.id)).toBe('not-due')
    expect(() => scheduler.update('nope', input())).toThrow(/schedule-job-not-found/)
  })

  it('一覧: URI で返し、無効なら次回は null。削除', () => {
    const scheduler = make(false)
    const job = store.create(input(), clock)
    store.create(input({ name: 'off', enabled: false }), clock)
    const overview = scheduler.overview()
    expect(overview.autoRun).toBe(false)
    expect(overview.jobs.map((j) => j.name)).toEqual(['job', 'off'])
    const action = overview.jobs[0]?.action
    expect(action?.kind === 'prompt' ? action.cwdUri : null).toBe('file:///tmp/work')
    expect(overview.jobs[0]?.nextRunAt).toBe(mon(8))
    expect(overview.jobs[1]?.nextRunAt).toBeNull()
    expect(scheduler.remove(job.id).jobs.map((j) => j.name)).toEqual(['off'])
  })

  it('TODO 983 段 2: ジョブを消すと onJobRemoved が呼ばれる (許可の行を消す口)。無いジョブでは呼ばない', () => {
    const removed: string[] = []
    const scheduler = new JobScheduler(store, runner(), {
      autoRun: false,
      now: () => clock,
      schedule: () => () => undefined,
      onJobRemoved: (id) => removed.push(id)
    })
    const job = store.create(input(), clock)
    scheduler.remove('nope')
    expect(removed).toEqual([])
    scheduler.remove(job.id)
    expect(removed).toEqual([job.id])
  })

  it('autoRun が偽 (複製のインスタンス) なら start で刻まない', async () => {
    store.create(input(), clock)
    clock = mon(9)
    let armed = false
    const scheduler = new JobScheduler(store, runner(), {
      autoRun: false,
      now: () => clock,
      schedule: () => {
        armed = true
        return () => undefined
      }
    })
    scheduler.start()
    await settle()
    expect(armed).toBe(false)
    expect(runs).toHaveLength(0)
  })

  it('TODO 1120: スリープ明けの wake() は autoRun が偽なら判定しない (真なら追いつく)', async () => {
    const job = store.create(input(), clock)
    clock = mon(9)
    const copy = make(false)
    copy.wake()
    await settle()
    expect(runs).toHaveLength(0)
    // The "run once" exhaustion and the failure record are not written either.
    expect(store.get(job.id)?.lastRunAt ?? null).toBeNull()
    const real = make(true)
    real.wake()
    await settle()
    expect(runs).toHaveLength(1)
  })

  it('終了処理: stop() は起こしている最中の回を待ち、以後は刻まない (DB を閉じた後に書かない)', async () => {
    const scheduler = make()
    const job = store.create(input(), clock)
    pending = () => undefined
    clock = mon(8)
    scheduler.tick()
    let stopped = false
    const stopping = scheduler.stop().then(() => {
      stopped = true
    })
    await settle()
    expect(stopped).toBe(false)
    const release = pending as unknown as () => void
    release()
    await stopping
    expect(store.get(job.id)?.lastOutcome).toBe('started')
    db.close()
    // Ticks and run-now after close do not touch the DB (touching it would throw).
    clock = mon(8) + DAY
    expect(scheduler.tick().size).toBe(0)
    expect(() => scheduler.runNow(job.id)).not.toThrow()
    db = new Database(':memory:')
  })

  it('TODO 629: 「1 回だけ」は走ったら無効になる (消さない、一覧の前回は残る)', async () => {
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'once', at: '2026-10-05T08:00' } }), clock)
    clock = mon(7, 59)
    expect(scheduler.tick().get(job.id)).toBe('not-due')
    clock = mon(8, 0) + 10_000
    expect(scheduler.tick().get(job.id)).toBe('run')
    await settle()
    expect(runs).toHaveLength(1)
    const after = store.get(job.id)!
    expect(after.enabled).toBe(false)
    expect(after.lastOutcome).toBe('started')
    // Since it is disabled, ticks after that do nothing (it does not even reach not-due — disabled).
    clock += DAY
    expect(scheduler.tick().get(job.id)).toBe('disabled')
    expect(runs).toHaveLength(1)
  })

  it('第 34 回の代理確認 (655): 使い切った「1 回だけ」を今すぐ実行で二度目走らせようとしても断る', async () => {
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'once', at: '2026-10-05T08:00' } }), clock)
    clock = mon(8, 0) + 10_000
    scheduler.runNow(job.id)
    await settle()
    expect(runs).toHaveLength(1)
    expect(store.get(job.id)?.enabled).toBe(false)
    // Even if "run now" is pressed again, the second run does not happen (the UI button only looks at busy, so without refusing here the same thread would be sent to every time).
    expect(() => scheduler.runNow(job.id)).toThrow(/schedule-once-used/)
    expect(runs).toHaveLength(1)
  })

  it('TODO 629: 24 時間以上過ぎた「1 回だけ」は走らせず、飛ばして知らせ、無効にする', async () => {
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'once', at: '2026-10-05T08:00' } }), clock)
    // Stopped for 2 days.
    clock = mon(8) + 2 * DAY
    expect(scheduler.tick().get(job.id)).toBe('skip-too-late')
    await settle()
    expect(runs).toHaveLength(0)
    const after = store.get(job.id)!
    expect(after.enabled).toBe(false)
    expect(after.lastOutcome).toBe('skipped')
    expect(after.lastSkipAt).toBe(mon(8))
  })

  it('TODO 725: 回数の上限に達したら無効にする (一覧の前回・履歴は残る)。「飛ばした」回は数えない', async () => {
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 2 }), clock)
    expect(store.get(job.id)?.maxRuns).toBe(2)
    expect(store.get(job.id)?.runCount).toBe(0)
    clock += 15 * MIN
    expect(scheduler.tick().get(job.id)).toBe('run')
    await settle()
    expect(store.get(job.id)?.runCount).toBe(1)
    expect(store.get(job.id)?.enabled).toBe(true)
    // A run that comes due while the previous run is still going is skipped — not counted.
    busy.add(`thread-${threadSeq}`)
    clock += 15 * MIN
    expect(scheduler.tick().get(job.id)).toBe('skip-running')
    expect(store.get(job.id)?.runCount).toBe(1)
    busy.clear()
    clock += 15 * MIN
    expect(scheduler.tick().get(job.id)).toBe('run')
    await settle()
    const after = store.get(job.id)!
    expect(after.runCount).toBe(2)
    // The second use exhausts it, so it becomes disabled (not deleted — the previous run and history remain).
    expect(after.enabled).toBe(false)
    expect(after.lastOutcome).toBe('started')
    clock += 15 * MIN
    expect(scheduler.tick().get(job.id)).toBe('disabled')
    expect(runs).toHaveLength(2)
  })

  it('TODO 725: 今すぐ実行も回数に数え、使い切ったら無効にする', async () => {
    const scheduler = make()
    const job = store.create(input({ maxRuns: 1 }), clock)
    scheduler.runNow(job.id)
    await settle()
    const after = store.get(job.id)!
    expect(after.runCount).toBe(1)
    expect(after.enabled).toBe(false)
  })

  it('TODO 725: 無効 → 有効に戻すと回数を 0 から数え直す。有効なまま名前だけ変えても積んだ回数は残る', async () => {
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 1 }), clock)
    scheduler.runNow(job.id)
    await settle()
    expect(store.get(job.id)?.runCount).toBe(1)
    expect(store.get(job.id)?.enabled).toBe(false)
    // Enabled again — counted again.
    scheduler.update(job.id, input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 1, enabled: true }))
    expect(store.get(job.id)?.runCount).toBe(0)
    expect(store.get(job.id)?.enabled).toBe(true)
    // Raises the limit to 2 and runs once (not yet exhausted).
    scheduler.update(job.id, input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 2, enabled: true }))
    scheduler.runNow(job.id)
    await settle()
    expect(store.get(job.id)?.runCount).toBe(1)
    expect(store.get(job.id)?.enabled).toBe(true)
    // Only the name changes, while enabled — the count so far (1) remains.
    scheduler.update(job.id, input({ name: 'renamed', spec: { kind: 'interval', minutes: 15 }, maxRuns: 2, enabled: true }))
    expect(store.get(job.id)?.runCount).toBe(1)
  })

  it('code-review (725): 回数の上限を使い切った行は今すぐ実行を断る (「完了 (N/N)」が走ってしまわない)', async () => {
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 1 }), clock)
    scheduler.runNow(job.id)
    await settle()
    expect(store.get(job.id)?.runCount).toBe(1)
    expect(store.get(job.id)?.enabled).toBe(false)
    expect(() => scheduler.runNow(job.id)).toThrow(/schedule-max-runs-used/)
    expect(runs).toHaveLength(1)
  })

  it('code-review (725): 有効なジョブの maxRuns を runCount 以下に下げて保存すると無効になる', async () => {
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 5 }), clock)
    scheduler.runNow(job.id)
    await settle()
    expect(store.get(job.id)?.runCount).toBe(1)
    expect(store.get(job.id)?.enabled).toBe(true)
    // Lowering maxRuns to 1 (the same as runCount) while enabled makes it disabled, aligned with how "completed" is treated.
    scheduler.update(job.id, input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 1, enabled: true }))
    const after = store.get(job.id)!
    expect(after.enabled).toBe(false)
    expect(after.runCount).toBe(1)
    expect(after.maxRuns).toBe(1)
  })

  it('TODO 739: 走り終えて回数の上限を使い切ったら完了のログを 1 行出す (本文は出さず id と回数だけ)', async () => {
    const infoSpy = vi.spyOn(log, 'info')
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 1 }), clock)
    scheduler.runNow(job.id)
    await settle()
    expect(infoSpy).toHaveBeenCalledWith('schedule.completed', { jobId: job.id, runCount: 1, maxRuns: 1 })
  })

  it('TODO 739: 保存で (maxRuns を runCount 以下へ下げて) 完了になったときも同じログを出す', async () => {
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 5 }), clock)
    scheduler.runNow(job.id)
    await settle()
    const infoSpy = vi.spyOn(log, 'info')
    scheduler.update(job.id, input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 1, enabled: true }))
    expect(infoSpy).toHaveBeenCalledWith('schedule.completed', { jobId: job.id, runCount: 1, maxRuns: 1 })
  })

  it('TODO 739: 上限に達していなければ完了のログは出さない', async () => {
    const infoSpy = vi.spyOn(log, 'info')
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 2 }), clock)
    scheduler.runNow(job.id)
    await settle()
    expect(infoSpy).not.toHaveBeenCalledWith('schedule.completed', expect.anything())
  })

  it('TODO 761 (739 の直し): 既に完了しているジョブを (名前だけ変えて) 保存し直しても、ログを出し直さない', async () => {
    const scheduler = make()
    const job = store.create(input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 1 }), clock)
    scheduler.runNow(job.id)
    await settle()
    expect(store.get(job.id)?.enabled).toBe(false) // Already completed
    const infoSpy = vi.spyOn(log, 'info')
    // Saves a completed job again with only the name changed, keeping enabled (already disabled) and maxRuns as they are.
    store.updateJob(
      job.id,
      input({ spec: { kind: 'interval', minutes: 15 }, maxRuns: 1, enabled: false, name: 'renamed' }),
      clock
    )
    expect(infoSpy).not.toHaveBeenCalledWith('schedule.completed', expect.anything())
  })

  it('TODO 725: 「1 回だけ」には回数の上限を適用しない (常に null)', () => {
    const past = validateScheduledJobInput(
      {
        name: 'once',
        enabled: true,
        spec: { kind: 'once', at: '2026-10-05T09:00' },
        maxRuns: 5,
        action: { kind: 'prompt', prompt: 'p', cwdUri: null, modelId: null, thinking: null, approvalStrict: false }
      },
      mon(7)
    )
    expect(typeof past).toBe('object')
    expect((past as ScheduledJobInput).maxRuns).toBeNull()
  })

  it('TODO 725: 回数の上限の検査 (1 以上の整数、上限まで)', () => {
    const ok = {
      name: 'job',
      enabled: true,
      spec: { kind: 'daily', time: '08:00' },
      action: { kind: 'prompt', prompt: 'p', cwdUri: null, modelId: null, thinking: null, approvalStrict: false }
    }
    expect(validateScheduledJobInput({ ...ok, maxRuns: 3 }, mon(0))).toMatchObject({ maxRuns: 3 })
    expect(validateScheduledJobInput({ ...ok, maxRuns: null }, mon(0))).toMatchObject({ maxRuns: null })
    expect(validateScheduledJobInput(ok, mon(0))).toMatchObject({ maxRuns: null })
    expect(validateScheduledJobInput({ ...ok, maxRuns: 0 }, mon(0))).toBe('schedule-max-runs-invalid')
    expect(validateScheduledJobInput({ ...ok, maxRuns: -1 }, mon(0))).toBe('schedule-max-runs-invalid')
    expect(validateScheduledJobInput({ ...ok, maxRuns: 1.5 }, mon(0))).toBe('schedule-max-runs-invalid')
    expect(validateScheduledJobInput({ ...ok, maxRuns: 'x' }, mon(0))).toBe('schedule-max-runs-invalid')
  })

  it('TODO 628: 再開の予約は既存のスレッドへ送り、一覧には出ない。走ったら無効になる', async () => {
    const scheduler = make()
    const at = mon(9)
    const reservation = scheduler.reserveResume('thread-existing', '続けて', at)
    expect(reservation.threadId).toBe('thread-existing')
    expect(reservation.at).toBe(at)
    // It does not appear in the list (overview().jobs) — it appears in resumeReservations.
    expect(scheduler.overview().jobs).toHaveLength(0)
    expect(scheduler.overview().resumeReservations).toEqual([{ id: reservation.id, threadId: 'thread-existing', at }])
    clock = at + 10_000
    scheduler.tick()
    await settle()
    expect(resumes).toEqual([{ threadId: 'thread-existing', prompt: '続けて' }])
    // After it runs, it becomes disabled and is also removed from resumeReservations (no new thread was woken).
    expect(scheduler.overview().resumeReservations).toEqual([])
    expect(runs).toHaveLength(0)
  })

  it('code-review (628): 過ぎた時刻の再開の予約は今 + 5 分に寄せ、その時刻に走る', async () => {
    const scheduler = make()
    const reservation = scheduler.reserveResume('thread-late', '続けて', clock - HOUR)
    expect(reservation.at).toBe(clock + RESUME_PAST_DELAY_MS)
    expect(scheduler.overview().resumeReservations).toEqual([
      { id: reservation.id, threadId: 'thread-late', at: clock + RESUME_PAST_DELAY_MS }
    ])
    // Exactly now is treated the same as the past.
    expect(scheduler.reserveResume('thread-now', '続けて', clock).at).toBe(clock + RESUME_PAST_DELAY_MS)
    clock += RESUME_PAST_DELAY_MS + 10_000
    scheduler.tick()
    await settle()
    expect(resumes.map((r) => r.threadId).sort()).toEqual(['thread-late', 'thread-now'])
  })

  it('TODO 989: 「あとで送る」は本文と添付を持ち、一覧には出ず、時刻が来たら普通の送信になって行が消える', async () => {
    const scheduler = make()
    const at = mon(9)
    const attachments = [{ uri: 'file:///tmp/a.txt', name: 'a.txt', kind: 'reference' as const, mediaType: null, bytes: 3 }]
    const first = scheduler.reserveLater('t1', { text: '続きを\nお願い', attachments, at })
    // Any number of them can be placed in the same thread (unlike the replacement in 628).
    const second = scheduler.reserveLater('t1', { text: '2 通目', attachments: [], at: mon(8) })
    expect(scheduler.overview().jobs).toHaveLength(0)
    expect(scheduler.overview().resumeReservations).toEqual([])
    expect(scheduler.overview().laterSends).toEqual([
      { id: second.id, threadId: 't1', at: mon(8), preview: '2 通目', attachments: 0, failed: false, error: null },
      { id: first.id, threadId: 't1', at, preview: '続きを お願い', attachments: 1, failed: false, error: null }
    ])
    clock = mon(8) + 10_000
    scheduler.tick()
    await settle()
    expect(laters).toEqual([{ threadId: 't1', text: '2 通目', attachments: 0, settings: {} }])
    clock = at + 10_000
    scheduler.tick()
    await settle()
    expect(laters.map((l) => l.text)).toEqual(['2 通目', '続きを\nお願い'])
    expect(laters[1]?.attachments).toBe(1)
    expect(scheduler.overview().laterSends).toEqual([])
    expect(store.list()).toHaveLength(0)
    expect(runs).toHaveLength(0)
    expect(resumes).toHaveLength(0)
  })

  it('TODO 989: 過ぎた時刻は今 + 1 分に寄せる。長く止まっていても起動時に 1 度追いついて送る', async () => {
    const scheduler = make()
    expect(scheduler.reserveLater('t1', { text: 'x', attachments: [], at: clock - HOUR }).at).toBe(clock + LATER_PAST_DELAY_MS)
    // Launch 3 days after the reservation time (the 24-hour rule of 629 does not apply).
    scheduler.reserveLater('t2', { text: 'y', attachments: [], at: clock + HOUR })
    clock += 72 * HOUR
    scheduler.tick()
    await settle()
    expect(laters.map((l) => l.threadId).sort()).toEqual(['t1', 't2'])
    expect(store.list()).toHaveLength(0)
  })

  it('TODO 989: 取り消しは remove で。発言ごとの model / thinking は送る時に渡る', async () => {
    const scheduler = make()
    const cancelled = scheduler.reserveLater('t1', { text: 'やめる', attachments: [], at: mon(9) })
    scheduler.remove(cancelled.id)
    expect(scheduler.overview().laterSends).toEqual([])
    scheduler.reserveLater('t2', {
      text: '設定つき',
      attachments: [],
      at: mon(9),
      modelId: 'm1',
      thinking: 'high',
      settingsScope: 'thread'
    })
    clock = mon(9) + 1000
    scheduler.tick()
    await settle()
    expect(laters).toEqual([
      { threadId: 't2', text: '設定つき', attachments: 0, settings: { modelId: 'm1', thinking: 'high', settingsScope: 'thread' } }
    ])
    expect(store.list()).toHaveLength(0)
  })

  it('TODO 989 (review): 送信が失敗したら行を残す。次の刻みで自動でやり直し、尽きたら失敗として一覧に出す', async () => {
    const scheduler = make()
    scheduler.reserveLater('t2', { text: 'こける', attachments: [], at: mon(9) })
    fail = new Error('no thread')
    clock = mon(9) + 1000
    for (let i = 0; i <= LATER_AUTO_RETRIES; i += 1) {
      scheduler.tick()
      await settle()
      clock += 30_000
    }
    expect(laters).toHaveLength(LATER_AUTO_RETRIES + 1)
    expect(store.list()).toHaveLength(1)
    const [view] = scheduler.overview().laterSends
    expect(view).toMatchObject({ threadId: 't2', failed: true, error: 'no thread' })
    // After it runs out, it is not sent automatically.
    scheduler.tick()
    await settle()
    expect(laters).toHaveLength(LATER_AUTO_RETRIES + 1)
    // Send again: if it is fixed, it is sent and the row disappears.
    fail = null
    scheduler.retryLater(view!.id)
    await settle()
    expect(laters).toHaveLength(LATER_AUTO_RETRIES + 2)
    expect(store.list()).toHaveLength(0)
  })

  it('TODO 989 (review): 失敗した予約は takeLater で中身を取り出せて、行が消える', async () => {
    const scheduler = make()
    scheduler.reserveLater('t2', { text: '戻す', attachments: [], at: mon(9), thinking: null })
    fail = new Error('x')
    clock = mon(9) + 1000
    for (let i = 0; i <= LATER_AUTO_RETRIES; i += 1) {
      scheduler.tick()
      await settle()
      clock += 30_000
    }
    const id = scheduler.overview().laterSends[0]!.id
    expect(scheduler.takeLater(id)).toEqual({ text: '戻す', attachments: [], thinking: null })
    expect(store.list()).toHaveLength(0)
    expect(scheduler.takeLater(id)).toBeNull()
  })

  it('TODO 989 (review): 送り始めたまま落ちた行 (無効で結果が空) は、起動時に失敗として残る', () => {
    const job = store.createLater('t3', '落ちた', [], mon(9), clock)
    store.disable(job.id, clock)
    const scheduler = make()
    scheduler.start()
    expect(scheduler.overview().laterSends).toMatchObject([{ id: job.id, failed: true, error: 'interrupted' }])
  })

  it('code-review (628): 発火の直前に中断が解けていれば送らずに消す', async () => {
    const scheduler = make()
    const reservation = scheduler.reserveResume('thread-done', '続けて', mon(9))
    resumed.add('thread-done')
    clock = mon(9) + 10_000
    scheduler.tick()
    await settle()
    expect(resumes).toEqual([])
    expect(store.get(reservation.id)).toBeNull()
    expect(scheduler.overview().resumeReservations).toEqual([])
  })

  it('code-review (628): cancelResumeFor はそのスレッドの予約だけを消し、一覧の変化を知らせる', () => {
    let changes = 0
    const scheduler = new JobScheduler(store, runner(), {
      autoRun: true,
      now: () => clock,
      schedule: () => () => undefined,
      onChanged: () => {
        changes += 1
      }
    })
    const a = scheduler.reserveResume('thread-a', '続けて', mon(9))
    const b = scheduler.reserveResume('thread-b', '続けて', mon(9))
    changes = 0
    scheduler.cancelResumeFor('thread-a')
    expect(store.get(a.id)).toBeNull()
    expect(scheduler.overview().resumeReservations).toEqual([{ id: b.id, threadId: 'thread-b', at: mon(9) }])
    expect(changes).toBe(1)
    // If there is nothing, do not notify.
    scheduler.cancelResumeFor('thread-a')
    expect(changes).toBe(1)
  })

  it('code-review (628): 予約自身の送信が同期に threadResumed を呼んでも、発火中の予約は消さない', async () => {
    let scheduler: JobScheduler | null = null
    const base = runner()
    const reentrant: JobRunner = {
      ...base,
      resume: async (threadId, prompt) => {
        // The same as the synchronous first half of SessionManager.send calling `threadResumed`.
        scheduler?.cancelResumeFor(threadId)
        return base.resume(threadId, prompt)
      }
    }
    scheduler = new JobScheduler(store, reentrant, { autoRun: true, now: () => clock, schedule: () => () => undefined })
    const reservation = scheduler.reserveResume('thread-x', '続けて', mon(9))
    clock = mon(9) + 10_000
    scheduler.tick()
    await settle()
    expect(resumes).toEqual([{ threadId: 'thread-x', prompt: '続けて' }])
    // It remains as disabled without being deleted, and the result can also be written.
    const after = store.get(reservation.id)
    expect(after?.enabled).toBe(false)
    expect(after?.lastOutcome).toBe('started')
  })

  it('TODO 628: 同じスレッドへ 2 度予約したら、前の予約を置き換える', () => {
    const scheduler = make()
    const first = scheduler.reserveResume('thread-a', 'first', mon(9))
    const second = scheduler.reserveResume('thread-a', 'second', mon(10))
    expect(scheduler.overview().resumeReservations).toEqual([{ id: second.id, threadId: 'thread-a', at: mon(10) }])
    expect(first.id).not.toBe(second.id)
  })

  it('TODO 1251: hasJob は行の有無だけを見る (解析できない行のジョブも「ある」。無い id は無い)', () => {
    const scheduler = make()
    const job = store.create(input(), clock)
    expect(scheduler.hasJob(job.id)).toBe(true)
    expect(scheduler.hasJob('no-such')).toBe(false)
    // After a downgrade etc., a row of an unknown kind or with a broken spec makes `get` return null, but since the row exists, the permission is not deleted.
    db.prepare(`UPDATE scheduled_jobs SET kind = 'from-the-future', spec = 'not-json' WHERE id = ?`).run(job.id)
    expect(store.get(job.id)).toBeNull()
    expect(scheduler.hasJob(job.id)).toBe(true)
  })
})

describe('checkJobInput (IPC の値の検め直し)', () => {
  const ok = {
    name: 'job',
    enabled: true,
    spec: { kind: 'interval', minutes: 30 },
    action: { kind: 'prompt', prompt: 'p', cwdUri: 'file:///Users/me/work', modelId: null, thinking: null, approvalStrict: false }
  }
  it('作業フォルダは関門を通す。理由コードの例外に params を載せる', () => {
    const seen: string[] = []
    expect(checkJobInput(ok, (uri) => seen.push(uri), mon(0)).name).toBe('job')
    expect(seen).toEqual(['file:///Users/me/work'])
    expect(() =>
      checkJobInput(
        ok,
        () => {
          throw new Error('aios-reason:path-excluded')
        },
        mon(0)
      )
    ).toThrow(/path-excluded/)
    expect(() => checkJobInput({ ...ok, spec: { kind: 'interval', minutes: 1 } }, () => undefined, mon(0))).toThrow(
      'aios-reason:schedule-too-frequent {"minutes":5}'
    )
    expect(() => checkJobInput({ ...ok, name: '' }, () => undefined, mon(0))).toThrow('aios-reason:schedule-name-empty')
    expect(() => checkJobInput(42, () => undefined, mon(0))).toThrow(/invalid-value/)
    // Without an owner it does not pass through the choke point (there is no path).
    seen.length = 0
    checkJobInput({ ...ok, action: { ...ok.action, cwdUri: null } }, (uri) => seen.push(uri), mon(0))
    expect(seen).toEqual([])
  })

  it('id', () => {
    expect(asId('abc')).toBe('abc')
    expect(() => asId('')).toThrow(/invalid-value/)
    expect(() => asId(3)).toThrow(/invalid-value/)
  })
})
