/**
 * Reminders (TODO 1265, ARCHITECTURE.md 6.2.4 "Reminders"): a scheduled-job kind that only shows a desktop notification.
 *
 * Applies the migrations to an in-memory DB and calls `JobScheduler.tick()` with a fake clock (no real time is waited for):
 * a reminder never reaches the runner (no thread, no model, no CLI) and a prompt job never becomes a notification; the repeat's next time;
 * snoozing (independent of the repeat, kept across a disabled "once"); missed runs (late label, 629's 24 hours); migration 44;
 * and that `stop()` cancels the snooze timer and nothing is written afterwards. `ReminderNotifier` is checked with a fake `Notification`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { MIGRATIONS, runMigrations } from '../src/common/migrations.js'
import {
  MAX_REMINDER_BODY,
  REMINDER_SNOOZE_MINUTES,
  validateScheduledJobInput,
  type ScheduledJobInput
} from '../src/shared/schedule.js'
import { ScheduledJobStore, type StoredJob } from '../src/main/schedule/store.js'
import { JobScheduler, type JobRunner, type ReminderShow } from '../src/main/schedule/scheduler.js'
import {
  ReminderNotifier,
  reminderNotifyText,
  snoozeActionLabels,
  type DesktopNotification
} from '../src/main/notify.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Local time of 2026-10-05 (Mon), a day with no daylight-saving change. */
function mon(hour: number, minute = 0): number {
  return new Date(2026, 9, 5, hour, minute, 0, 0).getTime()
}

describe('validateScheduledJobInput (reminder)', () => {
  const base = { name: '  Medicine  ', enabled: true, spec: { kind: 'daily', time: '08:00' } }

  it('accepts only title and body (the body is optional, and surrounding whitespace is dropped)', () => {
    expect(validateScheduledJobInput({ ...base, action: { kind: 'reminder', body: ' after lunch ' } }, mon(0))).toEqual({
      name: 'Medicine',
      enabled: true,
      spec: { kind: 'daily', time: '08:00' },
      maxRuns: null,
      action: { kind: 'reminder', body: 'after lunch' }
    })
    const omitted = validateScheduledJobInput({ ...base, action: { kind: 'reminder' } }, mon(0))
    expect(typeof omitted === 'string' ? omitted : omitted.action).toEqual({ kind: 'reminder', body: '' })
  })

  it('cannot bring in AI fields, and refuses a too-long body or an empty name', () => {
    const withPrompt = validateScheduledJobInput(
      { ...base, action: { kind: 'reminder', body: '', prompt: 'x', cwdUri: 'file:///tmp', modelId: 'm' } },
      mon(0)
    )
    expect(typeof withPrompt === 'string' ? withPrompt : withPrompt.action).toEqual({ kind: 'reminder', body: '' })
    expect(validateScheduledJobInput({ ...base, action: { kind: 'reminder', body: 'x'.repeat(MAX_REMINDER_BODY + 1) } }, mon(0))).toBe(
      'invalid-value'
    )
    expect(validateScheduledJobInput({ ...base, action: { kind: 'reminder', body: 3 } }, mon(0))).toBe('invalid-value')
    expect(validateScheduledJobInput({ ...base, name: ' ', action: { kind: 'reminder', body: '' } }, mon(0))).toBe(
      'schedule-name-empty'
    )
  })
})

describe('migration 44 (scheduled_jobs.snooze_at)', () => {
  it('existing rows keep the kind (prompt) as is and gain snooze_at as NULL; applying it again does not break it', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      // Go back to the shape before 44 and put an old prompt row in, then apply 44's SQL (only 44 - later migrations are not replayed).
      db.exec('ALTER TABLE scheduled_jobs DROP COLUMN snooze_at')
      db.prepare(
        `INSERT INTO scheduled_jobs (id, name, enabled, kind, spec, action, anchor_at, created_at, updated_at)
         VALUES ('old', 'Old job', 1, 'prompt', ?, ?, 0, 0, 0)`
      ).run(JSON.stringify({ kind: 'daily', time: '08:00' }), JSON.stringify({ kind: 'prompt', prompt: 'p', cwd: null }))
      const migration = MIGRATIONS.find((m) => m.version === 44)
      expect(migration?.name).toBe('scheduled-jobs-snooze')
      expect(migration?.skipIfColumn).toEqual({ table: 'scheduled_jobs', column: 'snooze_at' })
      db.exec(migration!.up)
      const columns = (db.prepare(`PRAGMA table_info(scheduled_jobs)`).all() as { name: string }[]).map((c) => c.name)
      expect(columns).toContain('snooze_at')
      const job = new ScheduledJobStore(db).get('old')
      expect(job?.action.kind).toBe('prompt')
      expect(job?.snoozeAt).toBeNull()
    } finally {
      db.close()
    }
  })
})

describe('JobScheduler: reminders (fake clock + in-memory DB)', () => {
  let db: Db
  let store: ScheduledJobStore
  let clock: number
  let runs: StoredJob[]
  let shown: ReminderShow[]
  let room: boolean

  const reminder = (patch: Partial<ScheduledJobInput> = {}): ScheduledJobInput => ({
    name: 'Medicine',
    enabled: true,
    spec: { kind: 'daily', time: '08:00' },
    action: { kind: 'reminder', body: 'after breakfast' },
    ...patch
  })
  const prompt = (patch: Partial<ScheduledJobInput> = {}): ScheduledJobInput => ({
    name: 'job',
    enabled: true,
    spec: { kind: 'daily', time: '08:00' },
    action: { kind: 'prompt', prompt: 'hello', cwdUri: null, modelId: null, thinking: null, approvalStrict: false },
    ...patch
  })

  const runner = (): JobRunner => ({
    run: async (job) => {
      runs.push(job)
      return `thread-${runs.length}`
    },
    resume: async () => undefined,
    sendLater: async () => undefined,
    isThreadInterrupted: () => false,
    isThreadBusy: () => false,
    hasRoom: () => room
  })

  const make = (extra: Partial<ConstructorParameters<typeof JobScheduler>[2]> = {}): JobScheduler =>
    new JobScheduler(store, runner(), {
      autoRun: true,
      now: () => clock,
      schedule: () => () => undefined,
      reminders: { show: (r) => shown.push(r) },
      ...extra
    })

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    store = new ScheduledJobStore(db)
    clock = mon(7)
    runs = []
    shown = []
    room = true
  })
  afterEach(() => db.close())

  it('when the time comes it only shows a notification: it does not call the runner (thread, model, CLI) or look at the session limit; the next is the next day', () => {
    room = false
    const scheduler = make()
    const job = scheduler.create(reminder()).jobs[0]!
    clock = mon(8) + 5_000
    expect(scheduler.tick().get(job.id)).toBe('run')
    expect(runs).toHaveLength(0)
    expect(shown).toEqual([{ jobId: job.id, title: 'Medicine', body: 'after breakfast', lateSince: null }])
    const row = scheduler.overview().jobs[0]!
    expect(row.lastRunAt).toBe(clock)
    expect(row.lastThreadId).toBeNull()
    expect(row.runCount).toBe(1)
    expect(row.nextRunAt).toBe(mon(8) + DAY)
    // The same minute does not show it twice.
    clock += 20_000
    expect(scheduler.tick().get(job.id)).toBe('not-due')
    expect(shown).toHaveLength(1)
  })

  it('does not mix up kinds: a prompt job goes to the runner and does not become notification-only; an update that changes the kind is refused', async () => {
    const scheduler = make()
    const p = scheduler.create(prompt()).jobs[0]!
    const r = scheduler.create(reminder({ name: 'R' })).jobs.find((j) => j.name === 'R')!
    clock = mon(8) + 5_000
    scheduler.tick()
    await Promise.resolve()
    expect(runs.map((j) => j.id)).toEqual([p.id])
    expect(shown.map((s) => s.jobId)).toEqual([r.id])
    expect(() => scheduler.update(p.id, reminder())).toThrow(/invalid-value/)
    expect(() => scheduler.update(r.id, prompt())).toThrow(/invalid-value/)
  })

  it('what was missed while stopped is shown only once at startup, with 「過ぎていた」 (the scheduled time) attached', () => {
    const scheduler = make()
    const job = scheduler.create(reminder()).jobs[0]!
    // aios was stopped from 07:00 to 12:00: 08:00 is caught up once, marked late.
    clock = mon(12)
    scheduler.tick()
    expect(shown).toEqual([{ jobId: job.id, title: 'Medicine', body: 'after breakfast', lateSince: mon(8) }])
    scheduler.tick()
    expect(shown).toHaveLength(1)
  })

  it('a 「1 回だけ」 job is disabled after it rings, and one more than 24 hours past is not shown and is recorded as 「飛ばした」 (629)', () => {
    const scheduler = make()
    const once = scheduler.create(reminder({ spec: { kind: 'once', at: '2026-10-05T09:00' } })).jobs[0]!
    clock = mon(9) + 1_000
    scheduler.tick()
    expect(shown).toHaveLength(1)
    expect(store.get(once.id)?.enabled).toBe(false)

    clock = mon(10)
    const stale = scheduler.create(reminder({ name: 'stale', spec: { kind: 'once', at: '2026-10-05T11:00' } })).jobs.find(
      (j) => j.name === 'stale'
    )!
    clock = mon(11) + DAY + HOUR
    expect(scheduler.tick().get(stale.id)).toBe('skip-too-late')
    expect(shown).toHaveLength(1)
    const row = store.get(stale.id)!
    expect(row.enabled).toBe(false)
    expect(row.lastOutcome).toBe('skipped')
  })

  it('snooze: shows again after N minutes; does not move the next occurrence of a repeat; disappears when it rings', () => {
    const scheduler = make()
    const job = scheduler.create(reminder()).jobs[0]!
    clock = mon(8) + 1_000
    scheduler.tick()
    scheduler.snooze(job.id, 10)
    const row = scheduler.overview().jobs[0]!
    expect(row.snoozedUntil).toBe(mon(8, 10) + 1_000)
    expect(row.nextRunAt).toBe(mon(8) + DAY)
    clock = mon(8, 9)
    scheduler.tick()
    expect(shown).toHaveLength(1)
    clock = mon(8, 10) + 2_000
    scheduler.tick()
    expect(shown).toHaveLength(2)
    expect(shown[1]).toMatchObject({ jobId: job.id, lateSince: null })
    expect(scheduler.overview().jobs[0]?.snoozedUntil).toBeNull()
    expect(scheduler.overview().jobs[0]?.nextRunAt).toBe(mon(8) + DAY)
    // A snooze does not count toward the run count.
    expect(store.get(job.id)?.runCount).toBe(1)
  })

  it('snooze also rings for a used-up 「1 回だけ」 (automatically disabled); canceled when the user disables it; there is also an entry point to cancel', () => {
    const scheduler = make()
    const once = scheduler.create(reminder({ spec: { kind: 'once', at: '2026-10-05T09:00' } })).jobs[0]!
    clock = mon(9) + 1_000
    scheduler.tick()
    scheduler.snooze(once.id, 5)
    expect(scheduler.hasUpcomingWork()).toBe(true)
    clock = mon(9, 6)
    scheduler.tick()
    expect(shown).toHaveLength(2)

    const daily = scheduler.create(reminder({ name: 'daily' })).jobs.find((j) => j.name === 'daily')!
    scheduler.snooze(daily.id, 60)
    scheduler.update(daily.id, { ...reminder({ name: 'daily' }), enabled: false })
    expect(store.get(daily.id)?.snoozeAt).toBeNull()
    scheduler.update(daily.id, reminder({ name: 'daily' }))
    scheduler.snooze(daily.id, 5)
    scheduler.cancelSnooze(daily.id)
    expect(store.get(daily.id)?.snoozeAt).toBeNull()
  })

  it('snooze is reminder only and only the fixed minutes; a snooze more than a day past is dropped', () => {
    const scheduler = make()
    const p = scheduler.create(prompt()).jobs[0]!
    expect(() => scheduler.snooze(p.id, 5)).toThrow(/schedule-job-not-found/)
    const r = scheduler.create(reminder({ name: 'R' })).jobs.find((j) => j.name === 'R')!
    expect(() => scheduler.snooze(r.id, 7)).toThrow(/invalid-value/)
    expect(REMINDER_SNOOZE_MINUTES).toEqual([5, 10, 60])
    scheduler.snooze(r.id, 5)
    clock = mon(7) + 2 * DAY
    scheduler.tick()
    // Only the daily 08:00 catch-up is shown (late); the stale snooze is dropped.
    expect(shown).toHaveLength(1)
    expect(shown[0]?.lateSince).not.toBeNull()
    expect(store.get(r.id)?.snoozeAt).toBeNull()
  })

  it('run now (try the notification) only shows it, and does not move the record, the count, or the used-up state of a 「1 回だけ」', () => {
    const scheduler = make()
    const once = scheduler.create(reminder({ spec: { kind: 'once', at: '2026-10-05T09:00' } })).jobs[0]!
    scheduler.runNow(once.id)
    expect(shown).toHaveLength(1)
    const row = store.get(once.id)!
    expect(row.enabled).toBe(true)
    expect(row.lastRunAt).toBeNull()
    expect(row.runCount).toBe(0)
  })

  it('sets up a one-shot timer that rings on time (when closer than the tick) and removes it on stop(); does not write afterwards', async () => {
    const deferred: { fn: () => void; ms: number; cancelled: boolean }[] = []
    const scheduler = make({
      tickMs: 10 * MIN,
      defer: (fn, ms) => {
        const entry = { fn, ms, cancelled: false }
        deferred.push(entry)
        return () => {
          entry.cancelled = true
        }
      }
    })
    const job = scheduler.create(reminder()).jobs[0]!
    scheduler.start()
    // 08:00 is an hour away (more than a tick): no timer yet.
    expect(deferred.filter((d) => !d.cancelled)).toHaveLength(0)
    scheduler.snooze(job.id, 5)
    const live = deferred.filter((d) => !d.cancelled)
    expect(live).toHaveLength(1)
    expect(live[0]?.ms).toBe(5 * MIN)
    clock += 5 * MIN
    live[0]!.fn()
    expect(shown).toHaveLength(1)
    scheduler.snooze(job.id, 5)
    await scheduler.stop()
    // Every timer that has not fired is cancelled (the one that fired above is spent).
    expect(deferred.filter((d) => d !== live[0] && !d.cancelled)).toHaveLength(0)
    expect(deferred.at(-1)?.cancelled).toBe(true)
    // After stop(): no snooze is written and the DB can be closed.
    const before = store.get(job.id)?.snoozeAt
    scheduler.snooze(job.id, 10)
    expect(store.get(job.id)?.snoozeAt).toBe(before)
  })

  it('it counts for the sleep suppression judgement (1270); the display (snoozedUntil) is reminder only', () => {
    const scheduler = make()
    expect(scheduler.hasUpcomingWork()).toBe(false)
    scheduler.create(reminder())
    expect(scheduler.hasUpcomingWork()).toBe(true)
    scheduler.create(prompt({ name: 'p' }))
    expect(scheduler.overview().jobs.find((j) => j.name === 'p')?.snoozedUntil).toBeNull()
  })
})

describe('ReminderNotifier (notify.ts)', () => {
  interface Fake extends DesktopNotification {
    title: string
    body: string
    actions: readonly string[] | undefined
    shown: boolean
    closed: boolean
    click?: () => void
    action?: (index: number) => void
  }

  const setup = () => {
    const made: Fake[] = []
    const clicks: string[] = []
    const snoozes: [string, number][] = []
    const notifier = new ReminderNotifier({
      create: (title, body, actions) => {
        const fake: Fake = {
          title,
          body,
          actions,
          shown: false,
          closed: false,
          show: () => {
            fake.shown = true
          },
          close: () => {
            fake.closed = true
          },
          onClick: (cb) => {
            fake.click = cb
          },
          onAction: (cb) => {
            fake.action = cb
          }
        }
        made.push(fake)
        return fake
      },
      locale: () => 'en',
      now: () => mon(12),
      onClick: (jobId) => clicks.push(jobId),
      onSnooze: (jobId, minutes) => snoozes.push([jobId, minutes])
    })
    return { made, clicks, snoozes, notifier }
  }

  it("the title is ⏰ + the name and the body is the user's text; the buttons are the 3 snoozes; pressing one snoozes by that many minutes, and pressing the notification itself opens it", () => {
    const { made, clicks, snoozes, notifier } = setup()
    notifier.show({ jobId: 'j1', title: 'Medicine', body: 'after lunch', lateSince: null })
    expect(made[0]).toMatchObject({ title: '⏰ Medicine', body: 'after lunch', shown: true })
    expect(made[0]?.actions).toEqual(snoozeActionLabels('en'))
    expect(made[0]?.actions).toEqual(['Remind me in 5 min', 'Remind me in 10 min', 'Remind me in 1 hr'])
    made[0]?.action?.(2)
    expect(snoozes).toEqual([['j1', 60]])
    made[0]?.click?.()
    expect(clicks).toEqual(['j1'])
  })

  it('the same reminder closes the previous notification and is merged into one', () => {
    const { made, notifier } = setup()
    notifier.show({ jobId: 'j1', title: 'A', body: '', lateSince: null })
    notifier.show({ jobId: 'j1', title: 'A', body: '', lateSince: null })
    notifier.show({ jobId: 'j2', title: 'B', body: '', lateSince: null })
    expect(made.map((n) => n.closed)).toEqual([true, false, false])
  })

  it('an empty body uses a fixed word; if late, the scheduled time goes on the first line (with the date if it crosses a day)', () => {
    expect(reminderNotifyText({ title: 'A', body: '', lateSince: null }, 'ja', mon(12)).body).toBe('リマインダー')
    expect(reminderNotifyText({ title: 'A', body: 'x', lateSince: mon(8) }, 'en', mon(12)).body).toBe('Was due at 08:00\nx')
    expect(reminderNotifyText({ title: 'A', body: '', lateSince: mon(8) - DAY }, 'ja', mon(12)).body).toBe(
      '10/4 08:00 の予定を過ぎていました'
    )
    expect(snoozeActionLabels('ja')).toEqual(['5 分後にもう一度', '10 分後にもう一度', '1 時間後にもう一度'])
  })
})
