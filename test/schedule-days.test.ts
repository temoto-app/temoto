/**
 * TODO 527 (wave 26 bundle F): per-weekday specification for scheduled runs (`{ kind: 'days', days, time }`).
 *
 * - Calculation of the next time (across weekdays, across weeks, and daylight-saving transitions)
 * - Conversion on load from the old `weekdays` → `days: [1..5]` (both the IPC value and the table row)
 * - Refusal of empty `days`, and the shape check
 *
 * Daylight saving is checked with `America/New_York` (`process.env.TZ` is switched and restored afterwards).
 * Does not call the model.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import {
  SCHEDULE_SPEC_KINDS,
  checkScheduleSpec,
  nextScheduleTime,
  normalizeScheduleSpec,
  readScheduleSpec,
  runsPerDay,
  specToCron,
  validateScheduledJobInput,
  type ScheduledJobInput
} from '../src/shared/schedule.js'
import { ScheduledJobStore } from '../src/main/schedule/store.js'

const at = (month: number, day: number, hour: number, minute = 0): number =>
  new Date(2026, month - 1, day, hour, minute, 0, 0).getTime()

describe('weekday specification: next time', () => {
  // 2026-10-05 is a Monday.
  const mwf = { kind: 'days', days: [1, 3, 5], time: '08:00' } as const

  it('if before the schedule on the same day, today; if past, the next chosen weekday (crossing weekdays)', () => {
    expect(nextScheduleTime(mwf, at(10, 5, 7))).toBe(at(10, 5, 8))
    expect(nextScheduleTime(mwf, at(10, 5, 9))).toBe(at(10, 7, 8))
    expect(nextScheduleTime(mwf, at(10, 7, 8))).toBe(at(10, 9, 8))
  })

  it('after Friday is the next Monday (crossing weeks); with Sunday only, the next Sunday', () => {
    expect(nextScheduleTime(mwf, at(10, 9, 8))).toBe(at(10, 12, 8))
    expect(nextScheduleTime({ kind: 'days', days: [0], time: '21:30' }, at(10, 5, 9))).toBe(at(10, 11, 21, 30))
    // After a Sunday run, the next is 7 days later.
    expect(nextScheduleTime({ kind: 'days', days: [0], time: '21:30' }, at(10, 11, 21, 30))).toBe(at(10, 18, 21, 30))
    // Crosses the end of the month and the end of the year.
    expect(nextScheduleTime({ kind: 'days', days: [4], time: '06:00' }, at(12, 31, 7))).toBe(
      new Date(2027, 0, 7, 6).getTime()
    )
  })

  it('conversion to a cron expression, the count per day, and a broken time', () => {
    expect(specToCron({ kind: 'days', days: [5, 1, 3, 1], time: '9:05' })).toBe('5 9 * * 1,3,5')
    expect(specToCron({ kind: 'days', days: [], time: '9:05' })).toBeNull()
    expect(runsPerDay(mwf, at(10, 5, 12))).toBe(1)
    expect(checkScheduleSpec(mwf, at(10, 5, 0))).toBeNull()
    expect(checkScheduleSpec({ kind: 'days', days: [1], time: '25:00' }, at(10, 5, 0))).toBe('schedule-time-invalid')
    expect(nextScheduleTime({ kind: 'days', days: [1], time: 'x' }, at(10, 5, 0))).toBeNull()
  })

  it('empty days is schedule-days-empty (no next time and no count)', () => {
    const empty = { kind: 'days', days: [], time: '08:00' } as const
    expect(checkScheduleSpec(empty, at(10, 5, 0))).toBe('schedule-days-empty')
    expect(nextScheduleTime(empty, at(10, 5, 0))).toBeNull()
    expect(runsPerDay(empty, at(10, 5, 0))).toBe(0)
  })

  it('the options on screen are daily / weekdays / interval / cron / once (the old weekdays is not shown, TODO 629)', () => {
    expect(SCHEDULE_SPEC_KINDS).toEqual(['daily', 'days', 'interval', 'cron', 'once'])
  })
})

describe('daylight saving transitions (America/New_York)', () => {
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env['TZ']
    process.env['TZ'] = 'America/New_York'
  })
  afterAll(() => {
    if (saved === undefined) delete process.env['TZ']
    else process.env['TZ'] = saved
  })

  it('even across the day the clock moves forward (Sunday 2026-03-08), it lands on 08:00 local time of the chosen weekday', () => {
    const spec = { kind: 'days', days: [6, 0], time: '08:00' } as const
    const sat = nextScheduleTime(spec, new Date(2026, 2, 6, 9).getTime())
    expect(sat).toBe(new Date(2026, 2, 7, 8).getTime())
    const sun = nextScheduleTime(spec, sat!)
    expect(sun).toBe(new Date(2026, 2, 8, 8).getTime())
    expect(new Date(sun!).getHours()).toBe(8)
    // Saturday 08:00 (EST) → Sunday 08:00 (EDT) is 23 hours (it does not shift to 09:00 after 24 hours).
    expect(sun! - sat!).toBe(23 * 3_600_000)
  })

  it('01:30 on the day the clock moves back (Sunday 2026-11-01) happens only once (does not run at the second 01:30)', () => {
    const spec = { kind: 'days', days: [0], time: '01:30' } as const
    const first = nextScheduleTime(spec, new Date(2026, 9, 31, 9).getTime())
    expect(first).toBe(new Date(2026, 10, 1, 1, 30).getTime())
    expect(nextScheduleTime(spec, first!)).toBe(new Date(2026, 10, 8, 1, 30).getTime())
  })

  it('a nonexistent 02:30 on the day the clock moves forward lands once at the first time after the jump (03:00) (same as Vixie cron, TODO 540)', () => {
    const spec = { kind: 'days', days: [0], time: '02:30' } as const
    const first = nextScheduleTime(spec, new Date(2026, 2, 7, 9).getTime())
    expect(first).toBe(new Date(2026, 2, 8, 3, 0).getTime())
    // The next week is a normal 02:30 (it does not stick to the 03:00 makeup).
    expect(nextScheduleTime(spec, first!)).toBe(new Date(2026, 2, 15, 2, 30).getTime())
  })

  it('hourly and every-minute cron expressions do not run duplicated in the gap hours (02:00 to 02:59) on the day the clock moves forward', () => {
    // Every day at minutes 0/15/30/45 of the 2 o'clock hour. The 02 hour does not exist that day, so it never runs that day
    // (the makeup to 03:00 is only when hours={2} is requested; this expression is hourly, so hours is unlimited).
    const spec = { kind: 'cron', expression: '*/15 2 * * *' } as const
    const hit = nextScheduleTime(spec, new Date(2026, 2, 7, 9).getTime())
    expect(hit).toBe(new Date(2026, 2, 8, 3, 0).getTime())
    expect(nextScheduleTime(spec, hit!)).toBe(new Date(2026, 2, 9, 2, 0).getTime())
  })
})

describe('daylight saving fall back and the day / weekday fields (TODO 842)', () => {
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env['TZ']
    process.env['TZ'] = 'America/New_York'
  })
  afterAll(() => {
    if (saved === undefined) delete process.env['TZ']
    else process.env['TZ'] = saved
  })

  it('even with the second 01:10 (EST) on the day the clock moves back as the base, it does not return before the base', () => {
    const spec = { kind: 'cron', expression: '20 1 * * *' } as const
    const after = Date.UTC(2026, 10, 1, 6, 10) // 01:10 EST (the second time)
    const next = nextScheduleTime(spec, after)
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(after)
    expect(next).toBe(new Date(2026, 10, 2, 1, 20).getTime())
  })

  it('from the first 01:10 (EDT) it lands on the first 01:20, and the next is the next day', () => {
    const spec = { kind: 'cron', expression: '20 1 * * *' } as const
    const first = nextScheduleTime(spec, Date.UTC(2026, 10, 1, 5, 10))
    expect(first).toBe(Date.UTC(2026, 10, 1, 5, 20))
    expect(nextScheduleTime(spec, first!)).toBe(new Date(2026, 10, 2, 1, 20).getTime())
  })

  it('when the day field is */2 it is a day that satisfies both day and weekday (an odd day and Monday); a bare * with a weekday is weekday only', () => {
    const star2 = { kind: 'cron', expression: '0 9 */2 * 1' } as const
    // Search from before 2026-10-05 (a Monday, an odd day). 10-05 matches.
    const hit = nextScheduleTime(star2, new Date(2026, 9, 4, 12).getTime())
    expect(hit).toBe(new Date(2026, 9, 5, 9).getTime())
    // The next Monday, 10-12, is an even day, so it is skipped; 10-19 (a Monday on an odd day).
    expect(nextScheduleTime(star2, hit!)).toBe(new Date(2026, 9, 19, 9).getTime())
    const plain = { kind: 'cron', expression: '0 9 * * 1' } as const
    expect(nextScheduleTime(plain, hit!)).toBe(new Date(2026, 9, 12, 9).getTime())
    // Both specified (neither starts with *) stays OR.
    const both = { kind: 'cron', expression: '0 9 1 * 1' } as const
    expect(nextScheduleTime(both, new Date(2026, 9, 1, 12).getTime())).toBe(new Date(2026, 9, 5, 9).getTime())
  })
})

describe('conversion of the old weekdays to days and shape validation', () => {
  it('readScheduleSpec: weekdays is converted to Monday through Friday of days', () => {
    expect(readScheduleSpec({ kind: 'weekdays', time: ' 8:00 ' })).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5], time: '8:00' })
    expect(normalizeScheduleSpec({ kind: 'weekdays', time: '08:00' })).toEqual({
      kind: 'days',
      days: [1, 2, 3, 4, 5],
      time: '08:00'
    })
  })

  it('readScheduleSpec: days removes duplicates and is aligned to start on Monday; it cannot be read unless integers 0 to 6', () => {
    expect(readScheduleSpec({ kind: 'days', days: [0, 5, 1, 5], time: '09:00' })).toEqual({
      kind: 'days',
      days: [1, 5, 0],
      time: '09:00'
    })
    expect(readScheduleSpec({ kind: 'days', days: [], time: '09:00' })).toEqual({ kind: 'days', days: [], time: '09:00' })
    expect(readScheduleSpec({ kind: 'days', days: [7], time: '09:00' })).toBeNull()
    expect(readScheduleSpec({ kind: 'days', days: [-1], time: '09:00' })).toBeNull()
    expect(readScheduleSpec({ kind: 'days', days: [1.5], time: '09:00' })).toBeNull()
    expect(readScheduleSpec({ kind: 'days', days: ['mon'], time: '09:00' })).toBeNull()
    expect(readScheduleSpec({ kind: 'days', days: 1, time: '09:00' })).toBeNull()
    expect(readScheduleSpec({ kind: 'days', days: [1] })).toBeNull()
  })

  it('validateScheduledJobInput: empty days is schedule-days-empty, and weekdays comes back as days', () => {
    const base = {
      name: 'job',
      enabled: true,
      action: { kind: 'prompt', prompt: 'p', cwdUri: null, modelId: null, thinking: null, approvalStrict: false }
    }
    expect(validateScheduledJobInput({ ...base, spec: { kind: 'days', days: [], time: '08:00' } }, at(10, 5, 0))).toBe(
      'schedule-days-empty'
    )
    const legacy = validateScheduledJobInput({ ...base, spec: { kind: 'weekdays', time: '08:00' } }, at(10, 5, 0))
    expect((legacy as ScheduledJobInput).spec).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5], time: '08:00' })
    const ok = validateScheduledJobInput({ ...base, spec: { kind: 'days', days: [6, 0], time: '10:00' } }, at(10, 5, 0))
    expect((ok as ScheduledJobInput).spec).toEqual({ kind: 'days', days: [6, 0], time: '10:00' })
  })
})

describe('table rows (no migration needed: spec is a JSON column)', () => {
  let db: Db
  let store: ScheduledJobStore
  const now = at(10, 5, 7)

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    store = new ScheduledJobStore(db)
  })
  afterEach(() => db.close())

  const rawSpec = (id: string): unknown =>
    JSON.parse((db.prepare('SELECT spec FROM scheduled_jobs WHERE id = ?').get(id) as { spec: string }).spec)

  it('an old weekdays row is read as days, saving with the same value writes days, and the baseline (anchor) does not move', () => {
    db.prepare(
      `INSERT INTO scheduled_jobs (id, name, enabled, kind, spec, action, anchor_at, created_at, updated_at)
       VALUES ('old', 'old', 1, 'prompt', ?, ?, ?, ?, ?)`
    ).run(
      JSON.stringify({ kind: 'weekdays', time: '08:00' }),
      JSON.stringify({ kind: 'prompt', prompt: 'p', cwd: null, modelId: null, thinking: null, approvalStrict: false }),
      now - 3_600_000,
      now - 3_600_000,
      now - 3_600_000
    )
    const job = store.get('old')!
    expect(job.spec).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5], time: '08:00' })
    expect(rawSpec('old')).toEqual({ kind: 'weekdays', time: '08:00' })
    const updated = store.updateJob('old', { name: 'renamed', enabled: true, spec: job.spec, action: { kind: 'prompt', prompt: 'p', cwdUri: null, modelId: null, thinking: null, approvalStrict: false } }, now)
    expect(rawSpec('old')).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5], time: '08:00' })
    expect(updated?.anchorAt).toBe(now - 3_600_000)
  })

  it('even if a weekdays input is passed directly it is written as days; changing the weekdays advances the baseline to now', () => {
    const input = {
      name: 'j',
      enabled: true,
      spec: { kind: 'weekdays', time: '08:00' },
      action: { kind: 'prompt', prompt: 'p', cwdUri: null, modelId: null, thinking: null, approvalStrict: false }
    } as const satisfies ScheduledJobInput
    const created = store.create(input, now)
    expect(rawSpec(created.id)).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5], time: '08:00' })
    const later = now + 60_000
    const changed = store.updateJob(created.id, { ...input, spec: { kind: 'days', days: [1, 3], time: '08:00' } }, later)
    expect(changed?.anchorAt).toBe(later)
    expect(rawSpec(created.id)).toEqual({ kind: 'days', days: [1, 3], time: '08:00' })
  })
})
