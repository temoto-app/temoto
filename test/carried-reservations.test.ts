/**
 * TODO 1337: carrying stopped send reservations over the idle restart for an update (ARCHITECTURE 8.5).
 * `carriedReservationOf` (which fields are carried), `SendQueueService` (what holds the restart, the snapshot, putting them back stopped), and
 * `CarriedReservationsService` (the encrypted-DB copy: written, followed, discarded, restored once). No model, no electron.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../src/common/logger.js'
import { UPDATE_CARRIED_RESERVATIONS, type SettingKey } from '../src/common/settings-keys.js'
import {
  CARRIED_RESERVATIONS_MAX_BYTES,
  CARRIED_RESERVATIONS_MAX_ENTRIES,
  SendQueueService,
  carriedReservationOf,
  type QueuedSend,
  type SendQueueHost
} from '../src/main/session/send-queue.js'
import type { ThreadStore } from '../src/main/session/store.js'
import { CarriedReservationsService, parseCarriedReservations } from '../src/main/update/carried-reservations.js'
import type { SendInput } from '../src/shared/thread.js'

class MemorySettings {
  readonly values = new Map<string, string>()
  failWrites = false
  readTyped<T>(def: SettingKey<T>): T {
    return def.parse(this.values.get(def.key) ?? null)
  }
  writeTyped<T>(def: SettingKey<T>, value: T): void {
    if (this.failWrites) throw new Error('SQLITE_FULL')
    this.values.set(def.key, def.serialize(value))
  }
  stored(): unknown {
    return this.readTyped(UPDATE_CARRIED_RESERVATIONS)?.threads ?? null
  }
}

function item(id: string, input: SendInput, extra: Partial<QueuedSend> = {}): QueuedSend {
  return { id, input, interrupt: false, createdAt: 1_000, by: 'human', ...extra }
}

/** A queue service whose host records what it was asked to do; nothing is ever sent (`dispatchNow` throws if reached). */
function queues(options: { prepareInput?: (input: SendInput) => SendInput } = {}) {
  const emitted: string[] = []
  const dispatched: string[] = []
  const changed = vi.fn()
  const host: SendQueueHost = {
    store: {} as ThreadStore,
    isAgentDisabled: () => false,
    isStopped: () => false,
    prepareInput: options.prepareInput ?? ((input) => input),
    notifyThreadResumed: () => undefined,
    checkSettings: async () => undefined,
    dispatchNow: async (threadId) => {
      dispatched.push(threadId)
      throw new Error('must not send')
    },
    requestInterrupt: async () => undefined,
    interrupt: async () => undefined,
    isRecordedError: () => false,
    recordInternalError: () => undefined,
    emitThread: (threadId) => emitted.push(threadId),
    queueChanged: changed
  }
  const service = new SendQueueService(host)
  return {
    service,
    emitted,
    dispatched,
    changed,
    /** A stopped queue with these reservations (as left by the stop button). */
    stopped(threadId: string, items: readonly QueuedSend[]) {
      const queue = service.of(threadId)
      queue.items.push(...items)
      queue.paused = true
      return queue
    }
  }
}

describe('carriedReservationOf: every field is carried or makes the reservation not carriable', () => {
  it('carries the plain fields as they are', () => {
    const result = carriedReservationOf(
      item('r1', { text: 'hello', modelId: 'model-a', thinking: 'high', settingsScope: 'thread' }, { interrupt: true, by: 'auto', createdAt: 5 })
    )
    expect(result).toEqual({
      ok: true,
      carried: {
        id: 'r1',
        input: { text: 'hello', modelId: 'model-a', thinking: 'high', settingsScope: 'thread' },
        interrupt: true,
        createdAt: 5,
        by: 'auto'
      }
    })
    // A `!` reservation and an explicit "backend default" (null) are carried too.
    expect(carriedReservationOf(item('r2', { text: 'ls', shell: true }))).toMatchObject({ ok: true, carried: { input: { text: 'ls', shell: true } } })
    expect(carriedReservationOf(item('r3', { text: 'x', modelId: null, thinking: null }))).toMatchObject({
      ok: true,
      carried: { input: { text: 'x', modelId: null, thinking: null } }
    })
    // An empty attachment list is the same as none.
    expect(carriedReservationOf(item('r4', { text: 'x', attachments: [] })).ok).toBe(true)
  })

  it('an attachment, a viewer selection or a field this code does not know make it not carriable', () => {
    const image = { uri: 'file:///tmp/a.png', name: 'a.png', kind: 'image' as const, mediaType: 'image/png', base64: 'AAAA', bytes: 3 }
    expect(carriedReservationOf(item('a', { text: 'x', attachments: [image] }))).toEqual({ ok: false, why: 'attachments' })
    const selection = { uri: 'file:///Users/tester/a.md', text: 'line', fromLine: 1, toLine: 1, truncated: false }
    expect(carriedReservationOf(item('s', { text: 'x', selection }))).toEqual({ ok: false, why: 'selection' })
    const unknownInput = { text: 'x', future: 1 } as unknown as SendInput
    expect(carriedReservationOf(item('u', unknownInput))).toEqual({ ok: false, why: 'unknown-field' })
    const unknownItem = { ...item('v', { text: 'x' }), future: 1 } as unknown as QueuedSend
    expect(carriedReservationOf(unknownItem)).toEqual({ ok: false, why: 'unknown-field' })
  })
})

describe('SendQueueService: what holds the idle restart (TODO 1337)', () => {
  it('stopped reservations that can be carried do not hold it; a queue that moves, mid-send or waiting for result does', () => {
    const q = queues()
    expect(q.service.restartBlocker()).toBeNull()
    const queue = q.stopped('t1', [item('r1', { text: 'a' })])
    expect(q.service.restartBlocker()).toBeNull()
    expect(q.service.carriedSnapshot()).toEqual({ t1: [{ id: 'r1', input: { text: 'a' }, interrupt: false, createdAt: 1_000, by: 'human' }] })
    queue.paused = false
    expect(q.service.restartBlocker()).toBe('queue')
    expect(q.service.carriedSnapshot()).toBeNull()
    queue.paused = true
    q.service.of('t2').awaitingResult = true
    expect(q.service.restartBlocker()).toBe('queue')
    q.service.of('t2').awaitingResult = false
    q.service.of('t2').dispatching = true
    expect(q.service.restartBlocker()).toBe('queue')
    q.service.of('t2').dispatching = false
    // A stopped queue with no items says nothing.
    q.service.of('t3').paused = true
    expect(q.service.restartBlocker()).toBeNull()
  })

  it('a stopped reservation with an attachment or a selection holds it as not carriable, and nothing is carried partly', () => {
    const q = queues()
    q.stopped('t1', [item('ok', { text: 'a' })])
    const image = { uri: 'file:///tmp/a.png', name: 'a.png', kind: 'image' as const, mediaType: 'image/png', base64: 'AAAA', bytes: 3 }
    q.stopped('t2', [item('img', { text: 'b', attachments: [image] })])
    expect(q.service.restartBlocker()).toBe('queue-uncarriable')
    expect(q.service.carriedSnapshot()).toBeNull()
    // A queue that moves wins over the uncarriable one (it is the stronger reason: it is about to be sent).
    q.service.of('t3').dispatching = true
    expect(q.service.restartBlocker()).toBe('queue')
  })

  it('over the limits (bytes or count, over all threads) holds it as not carriable', () => {
    const big = queues()
    big.stopped('t1', [item('a', { text: 'x'.repeat(CARRIED_RESERVATIONS_MAX_BYTES) })])
    expect(big.service.restartBlocker()).toBeNull()
    big.stopped('t2', [item('b', { text: 'y' })])
    expect(big.service.restartBlocker()).toBe('queue-uncarriable')
    const many = queues()
    many.stopped(
      't1',
      Array.from({ length: CARRIED_RESERVATIONS_MAX_ENTRIES }, (_, i) => item(`r${i}`, { text: 'x' }))
    )
    expect(many.service.restartBlocker()).toBeNull()
    many.stopped('t2', [item('one-more', { text: 'x' })])
    expect(many.service.restartBlocker()).toBe('queue-uncarriable')
  })
})

describe('SendQueueService.restoreCarried (TODO 1337)', () => {
  const carried = [
    { id: 'r1', input: { text: 'first' }, interrupt: false, createdAt: 1, by: 'human' as const },
    { id: 'r2', input: { text: 'ls', shell: true as const }, interrupt: false, createdAt: 2, by: 'auto' as const }
  ]

  it('puts them back stopped, in order, without sending anything, and tells the windows', async () => {
    const q = queues()
    expect(q.service.restoreCarried('t1', carried)).toEqual({ restored: 2, invalid: 0 })
    const queue = q.service.get('t1')
    expect(queue?.paused).toBe(true)
    expect(queue?.items.map((entry) => [entry.id, entry.input.text, entry.by])).toEqual([
      ['r1', 'first', 'human'],
      ['r2', 'ls', 'auto']
    ])
    // The thread is idle (nothing mid-send, no result awaited): a drain at this point must still send nothing.
    await q.service.drain('t1')
    expect(q.dispatched).toEqual([])
    expect(queue?.items).toHaveLength(2)
    expect(q.emitted).toEqual(['t1'])
    expect(q.changed).toHaveBeenCalled()
    // Still carriable after being put back (a second idle restart carries them again).
    expect(q.service.restartBlocker()).toBeNull()
  })

  it('is idempotent: restoring the same set again adds nothing', () => {
    const q = queues()
    q.service.restoreCarried('t1', carried)
    expect(q.service.restoreCarried('t1', carried)).toEqual({ restored: 0, invalid: 0 })
    expect(q.service.get('t1')?.items.map((entry) => entry.id)).toEqual(['r1', 'r2'])
    expect(q.emitted).toEqual(['t1'])
  })

  it('an input that fails the same check as a received one is not put back (counted)', () => {
    const q = queues({
      prepareInput: (input) => {
        if (input.shell === true) throw new Error('shell-invalid')
        return input
      }
    })
    expect(q.service.restoreCarried('t1', carried)).toEqual({ restored: 1, invalid: 1 })
    expect(q.service.get('t1')?.items.map((entry) => entry.id)).toEqual(['r1'])
  })
})

/** Two runs of the app sharing one encrypted DB (the settings), each with its own memory (queue service). */
function roundTrip(options: { gone?: readonly string[] } = {}) {
  const settings = new MemorySettings()
  const run = () => {
    const q = queues()
    const restoreCalls: string[] = []
    const service = new CarriedReservationsService({
      settings,
      snapshot: () => q.service.carriedSnapshot(),
      carriableNow: () => q.service.carriableNow(),
      restore: (threadId, items) => {
        restoreCalls.push(threadId)
        if (options.gone?.includes(threadId)) return null
        return q.service.restoreCarried(threadId, items)
      },
      now: () => 42
    })
    // The same wiring as index.ts: a change follows into the copy.
    q.changed.mockImplementation(() => service.follow())
    return { q, service, restoreCalls }
  }
  return { settings, run }
}

describe('CarriedReservationsService: the copy in the encrypted DB (TODO 1337)', () => {
  it('a stopped reservation is written before the restart and comes back once, stopped, at the next launch; then the copy is gone', () => {
    const { settings, run } = roundTrip()
    const first = run()
    first.q.stopped('t1', [item('r1', { text: 'send me later' })])
    expect(first.service.carry()).toBe(true)
    expect(settings.stored()).toEqual({ t1: [{ id: 'r1', input: { text: 'send me later' }, interrupt: false, createdAt: 1_000, by: 'human' }] })
    first.service.stop()
    // The copy written for the restart survives the shutdown.
    expect(settings.stored()).not.toBeNull()

    const second = run()
    second.service.start()
    expect(second.q.service.get('t1')?.paused).toBe(true)
    expect(second.q.service.get('t1')?.items.map((entry) => entry.input.text)).toEqual(['send me later'])
    expect(second.q.dispatched).toEqual([])
    expect(settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)).toBe('')

    // A third launch restores nothing (once only).
    const third = run()
    third.service.start()
    expect(third.restoreCalls).toEqual([])
    expect(third.q.service.get('t1')).toBeUndefined()
  })

  it('nothing to carry writes nothing; a queue that cannot be carried is never written and says no', () => {
    const { settings, run } = roundTrip()
    const first = run()
    expect(first.service.carry()).toBe(true)
    expect(settings.values.has(UPDATE_CARRIED_RESERVATIONS.key)).toBe(false)
    const queue = first.q.stopped('t1', [item('r1', { text: 'a' })])
    queue.paused = false
    expect(first.service.carry()).toBe(false)
    expect(settings.values.has(UPDATE_CARRIED_RESERVATIONS.key)).toBe(false)
  })

  it('a write that fails says no (the restart must not happen) and leaves nothing behind', () => {
    const { settings, run } = roundTrip()
    const first = run()
    first.q.stopped('t1', [item('r1', { text: 'a' })])
    settings.failWrites = true
    expect(first.service.carry()).toBe(false)
    settings.failWrites = false
    expect(settings.values.has(UPDATE_CARRIED_RESERVATIONS.key)).toBe(false)
    // Memory is untouched.
    expect(first.q.service.get('t1')?.items).toHaveLength(1)
  })

  it('a restart called off removes the copy; a reservation sent or cancelled afterwards does not come back at a later launch', () => {
    const { settings, run } = roundTrip()
    const first = run()
    first.q.stopped('t1', [item('r1', { text: 'a' }), item('r2', { text: 'b' })])
    expect(first.service.carry()).toBe(true)
    first.service.discard()
    expect(settings.stored()).toBeNull()
    // Memory is still the reservations.
    expect(first.q.service.get('t1')?.items).toHaveLength(2)
    // The user cancels one later, and quits with Cmd+Q (no carrying).
    expect(first.q.service.cancelReservation('t1', 'r1')).toBe(true)
    expect(settings.stored()).toBeNull()
    first.service.stop()
    const second = run()
    second.service.start()
    expect(second.restoreCalls).toEqual([])
  })

  it('while the restart is under way the copy follows memory (a cancelled reservation is not restored)', () => {
    const { settings, run } = roundTrip()
    const first = run()
    first.q.stopped('t1', [item('r1', { text: 'a' }), item('r2', { text: 'b' })])
    expect(first.service.carry()).toBe(true)
    first.q.service.cancelReservation('t1', 'r1')
    expect((settings.stored() as Record<string, { id: string }[]>)['t1']?.map((entry) => entry.id)).toEqual(['r2'])
    first.q.service.takeReservation('t1', 'r2')
    expect(settings.stored()).toBeNull()
    first.service.stop()
    // After shutdown nothing follows (no write after the DB is closed, 12.9).
    first.q.stopped('t9', [item('late', { text: 'z' })])
    first.service.follow()
    expect(settings.stored()).toBeNull()
  })

  it('after stop nothing is written: carry says no, discard does nothing', () => {
    const { settings, run } = roundTrip()
    const first = run()
    first.q.stopped('t1', [item('r1', { text: 'a' })])
    first.service.stop()
    expect(first.service.carry()).toBe(false)
    first.service.discard()
    expect(settings.values.has(UPDATE_CARRIED_RESERVATIONS.key)).toBe(false)
  })

  it('a thread that is gone gets nothing back; only the count is logged, and the copy is removed', () => {
    const { settings, run } = roundTrip({ gone: ['deleted'] })
    const first = run()
    first.q.stopped('deleted', [item('r1', { text: 'a' })])
    first.q.stopped('alive', [item('r2', { text: 'b' })])
    expect(first.service.carry()).toBe(true)
    const second = run()
    second.service.start()
    expect(second.q.service.get('deleted')).toBeUndefined()
    expect(second.q.service.get('alive')?.items.map((entry) => entry.id)).toEqual(['r2'])
    expect(settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)).toBe('')
  })

  it('a restore that throws keeps that thread (only) in the copy; the next launch restores it once, without doubling the others', () => {
    const settings = new MemorySettings()
    const makeRun = (throwOn: readonly string[]) => {
      const q = queues()
      const service = new CarriedReservationsService({
        settings,
        snapshot: () => q.service.carriedSnapshot(),
        carriableNow: () => q.service.carriableNow(),
        restore: (threadId, items) => {
          if (throwOn.includes(threadId)) throw new Error('boom')
          return q.service.restoreCarried(threadId, items)
        }
      })
      return { q, service }
    }
    const first = makeRun([])
    first.q.stopped('t1', [item('r1', { text: 'a' })])
    first.q.stopped('t2', [item('r2', { text: 'b' })])
    expect(first.service.carry()).toBe(true)

    const second = makeRun(['t2'])
    second.service.start()
    expect(second.q.service.get('t1')?.items.map((entry) => entry.id)).toEqual(['r1'])
    expect(second.q.service.get('t2')?.items ?? []).toEqual([])
    // Only t2 is left in the copy.
    expect(Object.keys(settings.stored() as object)).toEqual(['t2'])

    const third = makeRun([])
    third.service.start()
    expect(third.q.service.get('t1')).toBeUndefined()
    expect(third.q.service.get('t2')?.items.map((entry) => entry.id)).toEqual(['r2'])
    expect(settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)).toBe('')
  })

  it('a crash between restoring and removing the copy restores the same set once at the next launch (idempotent within a run)', () => {
    const { settings, run } = roundTrip()
    const first = run()
    first.q.stopped('t1', [item('r1', { text: 'a' })])
    expect(first.service.carry()).toBe(true)
    // The next launch restores, then cannot remove the copy (the process dies before it would): the copy stays.
    const second = run()
    const realWrite = settings.writeTyped.bind(settings)
    settings.writeTyped = () => {
      throw new Error('crash')
    }
    second.service.start()
    settings.writeTyped = realWrite
    expect(second.q.service.get('t1')?.items.map((entry) => entry.id)).toEqual(['r1'])
    expect(settings.stored()).not.toBeNull()
    // A fresh launch (the crashed run's memory is gone) restores the one reservation once, and the copy goes.
    const third = run()
    third.service.start()
    expect(third.q.service.get('t1')?.items.map((entry) => entry.id)).toEqual(['r1'])
    expect(settings.stored()).toBeNull()
    third.service.start()
    expect(third.q.service.get('t1')?.items.map((entry) => entry.id)).toEqual(['r1'])
  })

  it('a copy that could not be removed at launch is removed before shutdown, and before a later idle restart with nothing to carry', () => {
    const { settings, run } = roundTrip()
    const first = run()
    first.q.stopped('t1', [item('r1', { text: 'a' })])
    expect(first.service.carry()).toBe(true)
    const second = run()
    settings.failWrites = true
    second.service.start()
    settings.failWrites = false
    expect(settings.stored()).not.toBeNull()
    // The user sends the restored reservation (gone from memory), then the next idle restart has nothing to carry: the stale copy must go first.
    second.q.service.cancelReservation('t1', 'r1')
    expect(second.service.carry()).toBe(true)
    expect(settings.stored()).toBeNull()

    settings.writeTyped(UPDATE_CARRIED_RESERVATIONS, {
      savedAt: 1,
      threads: { t1: [{ id: 'r1', input: { text: 'a' }, interrupt: false, createdAt: 1, by: 'human' }] }
    })
    const third = run()
    settings.failWrites = true
    third.service.start()
    settings.failWrites = false
    expect(settings.stored()).not.toBeNull()
    third.service.stop()
    expect(settings.stored()).toBeNull()
  })

  it('a stored value that does not read is kept as it is (not restored, not removed)', () => {
    const { settings, run } = roundTrip()
    settings.writeTyped(UPDATE_CARRIED_RESERVATIONS, { savedAt: 1, threads: { t1: [{ id: 'r1', input: { text: 'a', future: 1 } }] } })
    const raw = settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)
    const second = run()
    second.service.start()
    expect(second.restoreCalls).toEqual([])
    expect(settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)).toBe(raw)
    // Nothing to carry and nothing to fix: the restart may go, and the value is still untouched; shutdown does not touch it either.
    expect(second.service.carry()).toBe(true)
    second.service.stop()
    expect(settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)).toBe(raw)
  })

  it('an old copy is never dropped for its age', () => {
    const { settings, run } = roundTrip()
    settings.writeTyped(UPDATE_CARRIED_RESERVATIONS, {
      savedAt: 1,
      threads: { t1: [{ id: 'r1', input: { text: 'a' }, interrupt: false, createdAt: 1, by: 'human' }] }
    })
    const later = run()
    later.service.start()
    expect(later.q.service.get('t1')?.items.map((entry) => entry.id)).toEqual(['r1'])
  })
})

describe('parseCarriedReservations', () => {
  const ok = { id: 'r1', input: { text: 'a' }, interrupt: false, createdAt: 1, by: 'human' }
  it('reads what carry writes and rejects anything else', () => {
    expect(parseCarriedReservations({ t1: [ok] })).toEqual({ t1: [ok] })
    expect(parseCarriedReservations({ t1: [{ ...ok, by: 'robot' }] })).toBeNull()
    expect(parseCarriedReservations({ t1: [{ ...ok, input: { text: 'a', thinking: 'deepest' } }] })).toBeNull()
    expect(parseCarriedReservations({ t1: [{ ...ok, input: { text: 'a', attachments: [] } }] })).toBeNull()
    expect(parseCarriedReservations({ t1: [{ ...ok, input: { text: 'a', shell: false } }] })).toBeNull()
    expect(parseCarriedReservations({ '': [ok] })).toBeNull()
    expect(parseCarriedReservations([ok])).toBeNull()
    expect(parseCarriedReservations({ t1: [{ ...ok, input: { text: 'x'.repeat(CARRIED_RESERVATIONS_MAX_BYTES + 1) } }] })).toBeNull()
  })
})

/** Runs sharing one DB, each with its own memory; the restore throws for the threads in `throwing` (wired like index.ts: a change follows into the copy). */
function failingRuns() {
  const settings = new MemorySettings()
  const run = (throwOn: readonly string[] = []) => {
    const q = queues()
    const throwing = new Set(throwOn)
    const gone = new Set<string>()
    const service = new CarriedReservationsService({
      settings,
      snapshot: () => q.service.carriedSnapshot(),
      carriableNow: () => q.service.carriableNow(),
      restore: (threadId, items) => {
        if (throwing.has(threadId)) throw new Error('boom')
        if (gone.has(threadId)) return null
        return q.service.restoreCarried(threadId, items)
      },
      now: () => 42
    })
    q.changed.mockImplementation(() => service.follow())
    return { q, service, throwing, gone }
  }
  /** The reservation ids per thread in the stored copy ({} when there is none). */
  const ids = (): Record<string, string[]> => {
    const stored = (settings.stored() ?? {}) as Record<string, { id: string }[]>
    return Object.fromEntries(Object.entries(stored).map(([threadId, items]) => [threadId, items.map((entry) => entry.id)]))
  }
  return { settings, run, ids }
}

const memoryIds = (q: ReturnType<typeof queues>, threadId: string): string[] => q.service.get(threadId)?.items.map((entry) => entry.id) ?? []

describe('CarriedReservationsService: a restore that threw is never lost later in the same run (wave 106 review Z1)', () => {
  /** Run 1 carries X (2 reservations) and Y; run 2's restore throws on X only. */
  function heldX() {
    const runs = failingRuns()
    const first = runs.run()
    first.q.stopped('X', [item('x1', { text: 'a' }), item('x2', { text: 'b' })])
    first.q.stopped('Y', [item('y1', { text: 'c' })])
    expect(first.service.carry()).toBe(true)
    const second = runs.run(['X'])
    second.service.start()
    expect(memoryIds(second.q, 'X')).toEqual([])
    expect(memoryIds(second.q, 'Y')).toEqual(['y1'])
    expect(runs.ids()).toEqual({ X: ['x1', 'x2'] })
    return { ...runs, second }
  }

  it('the review example: X fails, Y is carried later, X is still in the copy and comes back at the next launch', () => {
    const { settings, run, ids, second } = heldX()
    // Y has a stopped reservation and the machine goes idle: the carry writes Y and keeps X (it used to write Y only).
    expect(second.service.carry()).toBe(true)
    expect(ids()).toEqual({ Y: ['y1'], X: ['x1', 'x2'] })
    // Memory is untouched by the carry (X is still not in it, Y still stopped).
    expect(memoryIds(second.q, 'X')).toEqual([])
    expect(second.q.service.get('Y')?.paused).toBe(true)
    second.service.stop()

    const third = run()
    third.service.start()
    expect(memoryIds(third.q, 'X')).toEqual(['x1', 'x2'])
    expect(third.q.service.get('X')?.paused).toBe(true)
    expect(memoryIds(third.q, 'Y')).toEqual(['y1'])
    expect(third.q.dispatched).toEqual([])
    expect(settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)).toBe('')
  })

  it('follow, discard and stop keep X too', () => {
    const { run, ids, second } = heldX()
    expect(second.service.carry()).toBe(true)
    // The user cancels Y's reservation while the restart is under way: the copy follows memory, X stays.
    expect(second.q.service.cancelReservation('Y', 'y1')).toBe(true)
    expect(ids()).toEqual({ X: ['x1', 'x2'] })
    // The restart is called off: what was written for it goes, X stays.
    second.service.discard()
    expect(ids()).toEqual({ X: ['x1', 'x2'] })
    second.service.stop()
    expect(ids()).toEqual({ X: ['x1', 'x2'] })
    const third = run()
    third.service.start()
    expect(memoryIds(third.q, 'X')).toEqual(['x1', 'x2'])
    expect(memoryIds(third.q, 'Y')).toEqual([])
  })

  it('a rewrite that failed at launch is done at shutdown, keeping X (the reservations already restored do not come back)', () => {
    const runs = failingRuns()
    const first = runs.run()
    first.q.stopped('X', [item('x1', { text: 'a' })])
    first.q.stopped('Y', [item('y1', { text: 'c' })])
    expect(first.service.carry()).toBe(true)
    const second = runs.run(['X'])
    runs.settings.failWrites = true
    second.service.start()
    runs.settings.failWrites = false
    // The whole copy stayed (Y included, already in memory).
    expect(runs.ids()).toEqual({ X: ['x1'], Y: ['y1'] })
    second.service.stop()
    expect(runs.ids()).toEqual({ X: ['x1'] })
  })

  it('the carry tries X again first: once it goes back it is carried from memory and is no longer held', () => {
    const { ids, second } = heldX()
    second.throwing.delete('X')
    expect(second.service.carry()).toBe(true)
    expect(memoryIds(second.q, 'X')).toEqual(['x1', 'x2'])
    expect(second.q.service.get('X')?.paused).toBe(true)
    expect(ids()).toEqual({ X: ['x1', 'x2'], Y: ['y1'] })
    // X now lives in memory only: cancelling everything leaves no copy (X was not held any more).
    for (const [threadId, id] of [
      ['X', 'x1'],
      ['X', 'x2'],
      ['Y', 'y1']
    ] as const) {
      expect(second.q.service.cancelReservation(threadId, id)).toBe(true)
    }
    expect(ids()).toEqual({})
    second.service.discard()
    expect(ids()).toEqual({})
  })

  it('a held thread found gone at the retry leaves the copy before the restart, even with nothing to carry', () => {
    const { settings, ids, second } = heldX()
    second.q.service.cancelReservation('Y', 'y1')
    expect(ids()).toEqual({ X: ['x1', 'x2'] })
    // X was deleted meanwhile: the retry drops it (only the count is logged), and the stale copy is removed although nothing is carried.
    second.throwing.delete('X')
    second.gone.add('X')
    expect(second.service.carry()).toBe(true)
    expect(ids()).toEqual({})
    expect(settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)).toBe('')
    expect(memoryIds(second.q, 'X')).toEqual([])
  })

  it('X together with memory over the limits keeps the restart waiting (nothing is dropped, the copy is unchanged)', () => {
    const runs = failingRuns()
    const first = runs.run()
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => item(`${prefix}${i}`, { text: 'x' }))
    first.q.stopped('X', many('x', 150))
    expect(first.service.carry()).toBe(true)
    const second = runs.run(['X'])
    second.service.start()
    const before = runs.settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)
    second.q.stopped('Y', many('y', CARRIED_RESERVATIONS_MAX_ENTRIES - 100))
    // Memory alone is carriable, so the restart blocker says nothing; the carry itself says no.
    expect(second.q.service.restartBlocker()).toBeNull()
    expect(second.service.carry()).toBe(false)
    expect(runs.settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)).toBe(before)
    expect(second.q.service.get('Y')?.items).toHaveLength(CARRIED_RESERVATIONS_MAX_ENTRIES - 100)
    // Back under the limits: carried, X included.
    for (let i = 0; i < 60; i += 1) second.q.service.cancelReservation('Y', `y${i}`)
    expect(second.service.carry()).toBe(true)
    expect(runs.ids()['X']).toHaveLength(150)
    expect(runs.ids()['Y']).toHaveLength(CARRIED_RESERVATIONS_MAX_ENTRIES - 160)
  })
})

describe('CarriedReservationsService: a stored value this build cannot read is kept (wave 106 review Z1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })
  const future = { Z: [{ id: 'z1', input: { text: 'a', future: 1 }, interrupt: false, createdAt: 1, by: 'human' }] }

  it('is written along with a later carry and survives a discard, so a build that reads it gets it back', () => {
    const { settings, run, ids } = failingRuns()
    settings.writeTyped(UPDATE_CARRIED_RESERVATIONS, { savedAt: 1, threads: future })
    const second = run()
    second.service.start()
    expect(memoryIds(second.q, 'Z')).toEqual([])
    second.q.stopped('T', [item('t1', { text: 'b' })])
    expect(second.service.carry()).toBe(true)
    expect(ids()).toEqual({ T: ['t1'] })
    expect(settings.readTyped(UPDATE_CARRIED_RESERVATIONS)?.unread).toEqual([future])
    second.service.discard()
    expect(ids()).toEqual({})
    expect(settings.readTyped(UPDATE_CARRIED_RESERVATIONS)?.unread).toEqual([future])
    second.service.stop()
    expect(settings.readTyped(UPDATE_CARRIED_RESERVATIONS)?.unread).toEqual([future])
  })

  it('an unread value that this build can read is put back (what a later build would do with the one above)', () => {
    const { settings, run } = failingRuns()
    const readable = { K: [{ id: 'k1', input: { text: 'c' }, interrupt: false, createdAt: 1, by: 'human' }] }
    settings.writeTyped(UPDATE_CARRIED_RESERVATIONS, { savedAt: 1, threads: {}, unread: [future, readable] })
    const later = run()
    later.service.start()
    expect(memoryIds(later.q, 'K')).toEqual(['k1'])
    expect(later.q.service.get('K')?.paused).toBe(true)
    // The one it cannot read stays.
    expect(settings.readTyped(UPDATE_CARRIED_RESERVATIONS)?.unread).toEqual([future])
    expect(settings.stored()).toEqual({})
  })

  it('a value of a shape this build does not know at all is kept whole', () => {
    const { settings, run } = failingRuns()
    settings.values.set(UPDATE_CARRIED_RESERVATIONS.key, '{"version":2,"queues":[1]}')
    const second = run()
    second.service.start()
    expect(settings.values.get(UPDATE_CARRIED_RESERVATIONS.key)).toBe('{"version":2,"queues":[1]}')
    second.q.stopped('T', [item('t1', { text: 'b' })])
    expect(second.service.carry()).toBe(true)
    expect(settings.readTyped(UPDATE_CARRIED_RESERVATIONS)?.unread).toEqual([{ version: 2, queues: [1] }])
  })

  it('only unread values over the size limit are dropped, and only their size is logged', () => {
    const info = vi.spyOn(log, 'info')
    const { settings, run } = failingRuns()
    const huge = 'x'.repeat(CARRIED_RESERVATIONS_MAX_BYTES + 10)
    settings.writeTyped(UPDATE_CARRIED_RESERVATIONS, { savedAt: 1, threads: huge, unread: [future] })
    const second = run()
    second.service.start()
    expect(settings.readTyped(UPDATE_CARRIED_RESERVATIONS)?.unread).toEqual([future])
    const dropped = info.mock.calls.find(([event]) => event === 'update.reservations.dropped')
    expect(dropped?.[1]).toEqual({ bytes: CARRIED_RESERVATIONS_MAX_BYTES + 12 })
    expect(JSON.stringify(info.mock.calls)).not.toContain('xxxx')
  })
})

describe('SendQueueService.setPaused and following the stopped mark (wave 106 review Z3)', () => {
  it('tells the listener once when the mark changes, never when it stays', () => {
    const q = queues()
    const queue = q.service.of('t1')
    expect(q.service.setPaused(queue, false)).toBe(false)
    expect(q.changed).not.toHaveBeenCalled()
    expect(q.service.setPaused(queue, true)).toBe(true)
    expect(q.changed).toHaveBeenCalledTimes(1)
    expect(q.service.setPaused(queue, true)).toBe(false)
    expect(q.changed).toHaveBeenCalledTimes(1)
    expect(queue.paused).toBe(true)
  })

  it('after the carry, a queue that moves again leaves the copy and one stopped since joins it', () => {
    const { run, ids } = failingRuns()
    const first = run()
    const t1 = first.q.stopped('t1', [item('r1', { text: 'a' })])
    expect(first.service.carry()).toBe(true)
    expect(ids()).toEqual({ t1: ['r1'] })
    first.q.service.setPaused(t1, false)
    expect(ids()).toEqual({})
    // A queue with items that was moving (so not in the copy) is stopped: it joins the copy at once.
    const t2 = first.q.service.of('t2')
    t2.items.push(item('r2', { text: 'b' }))
    expect(ids()).toEqual({})
    first.q.service.setPaused(t2, true)
    expect(ids()).toEqual({ t2: ['r2'] })
    // After shutdown the mark still changes in memory, but nothing is written.
    first.service.stop()
    first.q.service.setPaused(t2, false)
    expect(ids()).toEqual({ t2: ['r2'] })
  })
})
