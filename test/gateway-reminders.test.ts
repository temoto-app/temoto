/**
 * TODO 1265 (wave 96 bundle D, ARCHITECTURE 7.6.9): the gateway's `addReminder` / `listReminders` / `cancelReminder`.
 *
 *  - Only a one-shot, notification-only reminder can be made: the kind is fixed in main and no argument selects it
 *  - Caps: pending total, per conversation, lifetime per conversation, message length, past / too-far times (a reason is returned)
 *  - Cancel / list see only the reminders this conversation registered
 *  - The row is marked as AI-registered (shown in the list), and firing it only shows a notification (never reaches the runner)
 *  - An unattended read-only turn is refused
 *
 * Uses neither the model nor Electron (real in-memory DB + `JobScheduler` with a fake clock).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { ScheduledJobStore } from '../src/main/schedule/store.js'
import { JobScheduler, type JobRunner, type ReminderShow } from '../src/main/schedule/scheduler.js'
import { AI_REMINDER_LIMITS, AiReminderGate, toLocalMinute } from '../src/main/schedule/ai-reminders.js'
import { GatewayRequests, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import type { Thread } from '../src/shared/thread.js'

const MIN = 60_000
const DAY = 24 * 60 * MIN
/** Local time of 2026-10-05 (Mon) 10:00:30, so rounding up to the minute is visible. */
const T0 = new Date(2026, 9, 5, 10, 0, 30, 0).getTime()

let db: Db
let store: ScheduledJobStore
let clock: number
let runs: unknown[]
let shown: ReminderShow[]
let scheduler: JobScheduler
let gate: AiReminderGate

function makeGate(): AiReminderGate {
  return new AiReminderGate(
    {
      create: (name, atLocal, threadId) => scheduler.createAiReminder(name, atLocal, threadId),
      pending: () =>
        scheduler.aiReminders().map((job) => ({
          id: job.id,
          name: job.name,
          threadId: job.action.origin?.threadId ?? '',
          atLocal: job.spec.kind === 'once' ? job.spec.at : ''
        })),
      remove: (id) => void scheduler.remove(id)
    },
    () => clock
  )
}

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
  store = new ScheduledJobStore(db)
  clock = T0
  runs = []
  shown = []
  const runner: JobRunner = {
    run: async (job) => {
      runs.push(job)
      return 'thread'
    },
    resume: async () => undefined,
    sendLater: async () => undefined,
    isThreadInterrupted: () => false,
    isThreadBusy: () => false,
    hasRoom: () => true
  }
  scheduler = new JobScheduler(store, runner, {
    autoRun: true,
    now: () => clock,
    schedule: () => () => undefined,
    reminders: { show: (r) => shown.push(r) }
  })
  gate = makeGate()
})
afterEach(() => db.close())

function idOf(result: unknown): string {
  return (result as { id: string }).id
}

describe('AiReminderGate.register', () => {
  it('registers a one-shot reminder for "in N minutes" (rounded up to the minute) and marks it as AI-registered', () => {
    const result = gate.register('t1', { message: 'Stand up', inMinutes: 10 })
    expect(result).toMatchObject({ ok: true, message: 'Stand up', atLocal: '2026-10-05T10:11' })
    const row = scheduler.overview().jobs[0]!
    expect(row.name).toBe('Stand up')
    expect(row.spec).toEqual({ kind: 'once', at: '2026-10-05T10:11' })
    expect(row.action).toEqual({ kind: 'reminder', body: '' })
    expect(row.byAi).toBe(true)
    expect(row.enabled).toBe(true)
  })

  it('accepts an absolute local time and a time with an offset', () => {
    expect(gate.register('t1', { message: 'a', at: '2026-10-05T15:30' })).toMatchObject({ ok: true, atLocal: '2026-10-05T15:30' })
    const abs = new Date(clock + 3 * 60 * MIN)
    const iso = gate.register('t1', { message: 'b', at: abs.toISOString() })
    expect(iso).toMatchObject({ ok: true })
  })

  it('refuses past times, a missing / doubled time, unreadable times and times too far ahead, with a reason', () => {
    const errorOf = (args: unknown): string => {
      const r = gate.register('t1', args)
      return 'error' in r ? r.error : 'registered'
    }
    expect(errorOf({ message: 'x', at: '2026-10-05T09:00' })).toContain('past')
    expect(errorOf({ message: 'x', inMinutes: -5 })).toContain('positive')
    expect(errorOf({ message: 'x', inMinutes: 0 })).toContain('positive')
    expect(errorOf({ message: 'x' })).toContain('exactly one')
    expect(errorOf({ message: 'x', inMinutes: 5, at: '2026-10-05T15:30' })).toContain('exactly one')
    expect(errorOf({ message: 'x', at: 'tomorrow' })).toContain('at must be')
    expect(errorOf({ message: 'x', at: '2026-10-05' })).toContain('at must be')
    expect(errorOf({ message: 'x', at: '2026-13-45T25:61' })).toContain('could not be read')
    expect(errorOf({ message: 'x', inMinutes: AI_REMINDER_LIMITS.maxInMinutes + 1 })).toContain('too far')
    expect(errorOf({ message: 'x', at: toLocalMinute(clock + AI_REMINDER_LIMITS.maxAheadMs + 2 * DAY) })).toContain('too far')
    expect(errorOf({ message: 'x', inMinutes: Number.NaN })).toContain('positive')
    expect(errorOf({ message: 'x', inMinutes: '10' })).toContain('positive')
    expect(scheduler.overview().jobs).toHaveLength(0)
  })

  it('refuses an empty or too long message and flattens control characters / newlines to one line', () => {
    expect('error' in gate.register('t1', { message: '   ', inMinutes: 5 })).toBe(true)
    expect('error' in gate.register('t1', { message: 7, inMinutes: 5 })).toBe(true)
    expect('error' in gate.register('t1', { message: 'x'.repeat(AI_REMINDER_LIMITS.maxMessageLength + 1), inMinutes: 5 })).toBe(true)
    expect(gate.register('t1', { message: 'line one\nline two\u0007', inMinutes: 5 })).toMatchObject({ ok: true, message: 'line one line two' })
  })

  it('caps the waiting reminders per conversation and in total, and a cancel does not refill the lifetime allowance', () => {
    for (let i = 0; i < AI_REMINDER_LIMITS.pendingPerThread; i++) {
      expect(gate.register('t1', { message: `r${i}`, inMinutes: 5 + i })).toMatchObject({ ok: true })
    }
    const over = gate.register('t1', { message: 'one more', inMinutes: 5 })
    expect('error' in over && over.error).toContain('already has')
    // Another conversation still has room, up to the total cap.
    for (let i = 0; i < AI_REMINDER_LIMITS.pendingTotal - AI_REMINDER_LIMITS.pendingPerThread; i++) {
      expect(gate.register(`other${i % 2}`, { message: `o${i}`, inMinutes: 5 })).toMatchObject({ ok: true })
    }
    const total = gate.register('t3', { message: 'full', inMinutes: 5 })
    expect('error' in total && total.error).toContain('too many')
    expect(scheduler.aiReminders()).toHaveLength(AI_REMINDER_LIMITS.pendingTotal)
  })

  it('caps the registrations over a conversation lifetime even when it cancels each one', () => {
    for (let i = 0; i < AI_REMINDER_LIMITS.registrationsPerThread; i++) {
      const r = gate.register('t1', { message: 'x', inMinutes: 5 })
      expect(r).toMatchObject({ ok: true })
      expect(gate.cancel('t1', idOf(r))).toMatchObject({ ok: true })
    }
    const r = gate.register('t1', { message: 'x', inMinutes: 5 })
    expect('error' in r && r.error).toContain('too many reminders')
  })

  it('a fired reminder is not counted as waiting any more', () => {
    for (let i = 0; i < AI_REMINDER_LIMITS.pendingPerThread; i++) gate.register('t1', { message: `r${i}`, inMinutes: 1 })
    clock = T0 + 2 * MIN
    scheduler.tick()
    expect(scheduler.aiReminders()).toHaveLength(0)
    expect(gate.register('t1', { message: 'again', inMinutes: 5 })).toMatchObject({ ok: true })
  })
})

describe('AiReminderGate.register bounds (wave 96 fix Y)', () => {
  it('accepts inMinutes exactly at its upper bound (30 days) even though the time is rounded up to the minute', () => {
    // T0 has 30 seconds past the minute, so rounding adds 30 seconds beyond 30 days.
    expect(gate.register('t1', { message: 'x', inMinutes: AI_REMINDER_LIMITS.maxInMinutes })).toMatchObject({ ok: true })
    const r = gate.register('t1', { message: 'y', at: toLocalMinute(clock + AI_REMINDER_LIMITS.maxAheadMs + 2 * MIN) })
    expect('error' in r && r.error).toContain('too far')
  })
})

describe('fired AI reminders are cleaned up (wave 96 fix Y)', () => {
  const KEEP = AI_REMINDER_LIMITS.keepAfterFiredMs

  it('removes a fired AI reminder a day after it fired, not before', () => {
    const r = idOf(gate.register('t1', { message: 'Tea', inMinutes: 2 }))
    clock = T0 + 3 * MIN
    scheduler.tick()
    expect(store.get(r)?.enabled).toBe(false)
    clock = T0 + 3 * MIN + KEEP - MIN
    scheduler.tick()
    expect(store.get(r)).not.toBeNull()
    clock = T0 + 3 * MIN + KEEP
    expect(scheduler.tick().get(r)).toBe('disabled')
    expect(store.get(r)).toBeNull()
    expect(scheduler.overview().jobs).toHaveLength(0)
  })

  it('keeps a row with a pending snooze, and counts the day from the last notification (the snooze buttons keep working)', () => {
    const r = idOf(gate.register('t1', { message: 'Tea', inMinutes: 2 }))
    clock = T0 + 3 * MIN
    scheduler.tick()
    // Snoozed for an hour, just before the day is up.
    clock = T0 + 3 * MIN + KEEP - 2 * MIN
    scheduler.snooze(r, 60)
    clock = T0 + 3 * MIN + KEEP + 30 * MIN
    scheduler.tick()
    expect(store.get(r)?.snoozeAt).not.toBeNull()
    // The snooze fires; the row stays for another day so the new notification can be snoozed again.
    clock = T0 + 3 * MIN + KEEP + 60 * MIN
    scheduler.tick()
    expect(shown.filter((s) => s.jobId === r)).toHaveLength(2)
    expect(store.get(r)).not.toBeNull()
    scheduler.snooze(r, 5)
    expect(store.get(r)?.snoozeAt).not.toBeNull()
    clock += 5 * MIN
    scheduler.tick()
    clock += KEEP
    scheduler.tick()
    expect(store.get(r)).toBeNull()
  })

  it("never removes the user's own reminders, nor an AI reminder the user saved in the editor (it is theirs now)", () => {
    const user = scheduler.create({
      name: 'mine',
      enabled: true,
      spec: { kind: 'once', at: '2026-10-05T10:02' },
      action: { kind: 'reminder', body: '' },
      maxRuns: null
    }).jobs[0]!.id
    const ai = idOf(gate.register('t1', { message: 'taken over', inMinutes: 2 }))
    const row = scheduler.overview().jobs.find((j) => j.id === ai)!
    scheduler.update(ai, { name: row.name, enabled: row.enabled, spec: row.spec, action: row.action, maxRuns: null })
    clock = T0 + 3 * MIN
    scheduler.tick()
    clock += 3 * KEEP
    scheduler.tick()
    expect(store.get(user)).not.toBeNull()
    expect(store.get(ai)).not.toBeNull()
  })

  it('removes an AI reminder that was skipped for being too late as well, and does nothing after stop()', async () => {
    const skipped = idOf(gate.register('t1', { message: 'late', inMinutes: 2 }))
    const later = idOf(gate.register('t1', { message: 'later', inMinutes: 4 }))
    // aios was stopped for two days: both are skipped (not shown) and disabled.
    clock = T0 + 2 * DAY
    scheduler.tick()
    expect(shown).toHaveLength(0)
    expect(store.get(skipped)?.enabled).toBe(false)
    await scheduler.stop()
    clock += KEEP
    scheduler.tick()
    expect(store.get(skipped)).not.toBeNull()
    // A fresh scheduler (the next start) sweeps them.
    const next = new JobScheduler(store, { run: async () => 'x', resume: async () => undefined, sendLater: async () => undefined, isThreadInterrupted: () => false, isThreadBusy: () => false, hasRoom: () => true }, {
      autoRun: true,
      now: () => clock,
      schedule: () => () => undefined
    })
    next.tick()
    expect(store.get(skipped)).toBeNull()
    expect(store.get(later)).toBeNull()
  })
})

describe('AiReminderGate.list / cancel', () => {
  it('lists and cancels only this conversation\'s reminders (not another conversation\'s, not the user\'s own)', () => {
    const mine = idOf(gate.register('t1', { message: 'mine', inMinutes: 5 }))
    const theirs = idOf(gate.register('t2', { message: 'theirs', inMinutes: 5 }))
    const user = scheduler.create({
      name: 'user made',
      enabled: true,
      spec: { kind: 'once', at: '2026-10-05T12:00' },
      action: { kind: 'reminder', body: '' },
      maxRuns: null
    }).jobs.find((j) => j.name === 'user made')!
    expect(gate.list('t1')).toEqual({ ok: true, reminders: [{ id: mine, message: 'mine', atLocal: '2026-10-05T10:06' }] })
    expect('error' in gate.cancel('t1', theirs)).toBe(true)
    expect('error' in gate.cancel('t1', user)).toBe(true)
    expect('error' in gate.cancel('t1', 42)).toBe(true)
    expect(scheduler.overview().jobs).toHaveLength(3)
    expect(gate.cancel('t1', mine)).toEqual({ ok: true, cancelled: mine })
    expect(scheduler.overview().jobs.map((j) => j.name).sort()).toEqual(['theirs', 'user made'])
  })

  it('the user editing an AI reminder in the settings screen takes it over (the AI mark goes, it is no longer cancellable by the AI)', () => {
    const r = idOf(gate.register('t1', { message: 'mine', inMinutes: 30 }))
    const row = scheduler.overview().jobs[0]!
    scheduler.update(r, { name: 'renamed', enabled: row.enabled, spec: row.spec, action: row.action, maxRuns: null })
    const after = scheduler.overview().jobs[0]!
    expect(after.byAi).toBeUndefined()
    expect('error' in gate.cancel('t1', r)).toBe(true)
  })
})

describe('what an AI reminder can do when it fires', () => {
  it('only shows a notification: it never reaches the runner (no thread, no model, no tool)', () => {
    const r = idOf(gate.register('t1', { message: 'Call back', inMinutes: 2 }))
    clock = T0 + 3 * MIN
    expect(scheduler.tick().get(r)).toBe('run')
    expect(runs).toHaveLength(0)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ jobId: r, title: 'Call back', body: '' })
    // A once row is disabled after it fires, so it stops counting against the caps.
    expect(scheduler.overview().jobs[0]!.enabled).toBe(false)
  })

  it('the stored action is always the reminder kind, whatever the arguments say', () => {
    gate.register('t1', { message: 'x', inMinutes: 5, kind: 'prompt', prompt: 'rm -rf /', action: { kind: 'prompt' }, cwdUri: 'file:///', modelId: 'm' })
    const row = store.list()[0]!
    expect(row.action).toEqual({ kind: 'reminder', body: '', origin: { kind: 'ai', threadId: 't1' } })
    expect(db.prepare('SELECT kind FROM scheduled_jobs').pluck().get()).toBe('reminder')
  })
})

describe('gateway requests (GatewayRequests)', () => {
  function requestsFor(unattended: boolean, withGate: boolean): GatewayRequests {
    const host: Partial<GatewayRequestHost> = {
      isStopped: () => false,
      threadIdForSession: (sessionId) => (sessionId === 's1' ? 't1' : undefined),
      getThread: () => ({ id: 't1', title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false }) as unknown as Thread,
      getLive: () => undefined,
      isUnattendedReadOnly: () => unattended,
      aiReminders: () => (withGate ? gate : null)
    }
    return new GatewayRequests(host as GatewayRequestHost)
  }

  it('registers, lists and cancels through the tool entry, identifying the conversation from the session', async () => {
    const requests = requestsFor(false, true)
    const added = (await requests.handle({ sessionId: 's1', kind: 'addReminder', payload: { message: 'Tea', inMinutes: 4 } })) as { ok?: boolean; id: string }
    expect(added.ok).toBe(true)
    const listed = (await requests.handle({ sessionId: 's1', kind: 'listReminders', payload: {} })) as { reminders: { id: string }[] }
    expect(listed.reminders.map((r) => r.id)).toEqual([added.id])
    // A thread id in the payload is ignored: the conversation comes from the session token.
    await requests.handle({ sessionId: 's1', kind: 'addReminder', payload: { message: 'Tea2', inMinutes: 4, threadId: 'other' } })
    expect(scheduler.aiReminders().map((j) => j.action.origin?.threadId)).toEqual(['t1', 't1'])
    await requests.handle({ sessionId: 's1', kind: 'cancelReminder', payload: { id: added.id } })
    expect(scheduler.aiReminders()).toHaveLength(1)
    await expect(requests.handle({ sessionId: 'nope', kind: 'addReminder', payload: { message: 'x', inMinutes: 4 } })).rejects.toThrow('unknown session')
  })

  it("wave 96 fix Y: a scheduled job's unattended turn (not read-only) cannot add or cancel, only list", async () => {
    const mine = idOf(gate.register('t1', { message: 'mine', inMinutes: 30 }))
    const host: Partial<GatewayRequestHost> = {
      isStopped: () => false,
      threadIdForSession: () => 't1',
      getThread: () => ({ id: 't1', title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false }) as unknown as Thread,
      getLive: () => undefined,
      isUnattendedReadOnly: () => false,
      isUnattendedTurn: () => true,
      aiReminders: () => gate
    }
    const requests = new GatewayRequests(host as GatewayRequestHost)
    const added = (await requests.handle({ sessionId: 's1', kind: 'addReminder', payload: { message: 'planted', inMinutes: 4 } })) as { error?: string }
    expect(added.error).toContain('unattended')
    const cancelled = (await requests.handle({ sessionId: 's1', kind: 'cancelReminder', payload: { id: mine } })) as { error?: string }
    expect(cancelled.error).toContain('unattended')
    const listed = (await requests.handle({ sessionId: 's1', kind: 'listReminders', payload: {} })) as { reminders: { id: string }[] }
    expect(listed.reminders.map((r) => r.id)).toEqual([mine])
    expect(scheduler.aiReminders().map((j) => j.name)).toEqual(['mine'])
  })

  it('is refused in an unattended read-only turn and when the gate is not wired yet', async () => {
    const denied = (await requestsFor(true, true).handle({ sessionId: 's1', kind: 'addReminder', payload: { message: 'x', inMinutes: 4 } })) as { error?: string }
    expect(denied.error).toContain('unattended')
    expect(scheduler.aiReminders()).toHaveLength(0)
    const off = (await requestsFor(false, false).handle({ sessionId: 's1', kind: 'addReminder', payload: { message: 'x', inMinutes: 4 } })) as { error?: string }
    expect(off.error).toContain('not available')
  })
})
