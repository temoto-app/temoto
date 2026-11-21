/**
 * TODO 952 stage 1 (wave 56 bundle A): actually calls a plugin's periodic task (`pluginTasks` of `JobScheduler`), the declaration "repeat while idle",
 * and carrying the task's state across runs (`PluginTaskInvoker` / migration 33). Migrations are applied to an in-memory DB, and it is driven by a fake clock and a fake plugin-host.
 * Neither the model, plugin-host, nor Google is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { ScheduledJobStore } from '../src/main/schedule/store.js'
import {
  IDLE_TASK_START_DELAY_MS,
  WATCHED_TASK_MIN_INTERVAL_MS,
  JobScheduler,
  type JobRunner,
  type PluginTaskRunner
} from '../src/main/schedule/scheduler.js'
import {
  MAX_PLUGIN_TASK_RETRY_MS,
  PluginTaskInvoker,
  PluginTaskStateStore,
  readTaskResult
} from '../src/main/plugin/tasks.js'
import { isDeclaredExport, missingExports, needsHost, parseManifest } from '../src/main/plugin/manifest.js'
import { MAX_PLUGIN_TASK_STATE_BYTES, type PluginTaskArg } from '../src/shared/plugin.js'
import { describeExports, findHandler, readInvoke } from '../src/plugin-host/dispatch.js'

const MIN = 60_000

const promptRunner: JobRunner = {
  run: async () => 'thread',
  resume: async () => undefined,
  sendLater: async () => undefined,
  isThreadInterrupted: () => false,
  isThreadBusy: () => false,
  hasRoom: () => true
}

/** Drains all pending Promises (the chain of then / finally). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('manifest: idle declaration and task export', () => {
  const base = { id: 'aios.mail', name: 'Mail', version: '1.0.0', host: { entry: 'host/index.js' } }

  it('reads idle, scheduledTasks alone also starts plugin-host, and task names are only the declared ones', () => {
    const manifest = parseManifest({
      ...base,
      scheduledTasks: [{ id: 'sync', name: 'Sync', defaultInterval: 15, idle: true }]
    })
    expect(manifest.scheduledTasks?.[0]?.idle).toBe(true)
    expect(needsHost(manifest)).toBe(true)
    expect(isDeclaredExport(manifest, 'task', 'sync')).toBe(true)
    expect(isDeclaredExport(manifest, 'task', 'other')).toBe(false)
    expect(isDeclaredExport(manifest, 'command', 'sync')).toBe(false)
    expect(missingExports(manifest, { commands: [], mcp: [], indexer: [] })).toEqual(['task:sync'])
    expect(missingExports(manifest, { commands: [], mcp: [], indexer: [], tasks: ['sync'] })).toEqual([])
    expect(needsHost(parseManifest(base))).toBe(false)
  })

  it('plugin-host: finds the tasks export and accepts task as an invoke kind', () => {
    const sync = async (): Promise<unknown> => ({ more: false })
    const plugin = { tasks: { sync } }
    expect(findHandler(plugin, 'task', 'sync')).toBe(sync)
    expect(findHandler(plugin, 'task', 'constructor')).toBeNull()
    expect(findHandler(plugin, 'command', 'sync')).toBeNull()
    expect(describeExports(plugin)).toEqual({ commands: [], mcp: [], indexer: [], tasks: ['sync'], search: [] })
    expect(readInvoke({ kind: 'task', command: 'sync', arg: 1 })).toEqual({ kind: 'task', name: 'sync', arg: 1 })
  })
})

describe('PluginTaskInvoker and state (migration 33)', () => {
  let db: Db
  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })
  afterEach(() => db.close())

  it('passes the previous state and keeps the returned state; null removes it; a return value of a different shape leaves it unchanged', async () => {
    const states = new PluginTaskStateStore(db)
    const seen: PluginTaskArg[] = []
    let reply: unknown = { state: { cursor: 'a' }, more: true }
    const invoker = new PluginTaskInvoker(
      {
        hasTask: (pluginId, taskId) => pluginId === 'aios.mail' && taskId === 'sync',
        invoke: async (_id, _name, arg) => {
          seen.push(arg as PluginTaskArg)
          return reply
        }
      },
      states
    )
    expect(invoker.available('aios.mail', 'sync')).toBe(true)
    expect(invoker.available('aios.mail', 'x')).toBe(false)
    expect(await invoker.run('aios.mail', 'sync', 'idle')).toEqual({ more: true, retryAfterMs: null })
    expect(seen[0]).toEqual({ state: null, reason: 'idle' })
    reply = 'garbage'
    expect(await invoker.run('aios.mail', 'sync', 'scheduled')).toEqual({ more: false, retryAfterMs: null })
    expect(seen[1]).toEqual({ state: { cursor: 'a' }, reason: 'scheduled' })
    // Even if the shape differs, the state stays as it is.
    expect(states.get('aios.mail', 'sync')).toEqual({ cursor: 'a' })
    reply = { state: null }
    await invoker.run('aios.mail', 'sync', 'manual')
    expect(states.get('aios.mail', 'sync')).toBeNull()
    states.set('aios.mail', 'sync', { cursor: 'b' })
    invoker.reset('aios.mail')
    expect(states.get('aios.mail', 'sync')).toBeNull()
  })

  it('readTaskResult: does not write an oversized state, cuts the wait time at the limit, and does not make an array a state', () => {
    const big = { blob: 'x'.repeat(MAX_PLUGIN_TASK_STATE_BYTES) }
    expect(readTaskResult({ state: big, more: true }).state).toBeUndefined()
    expect(readTaskResult({ state: [1, 2] }).state).toBeUndefined()
    expect(readTaskResult({ retryAfterMs: 10 * 60 * MIN }).retryAfterMs).toBe(MAX_PLUGIN_TASK_RETRY_MS)
    expect(readTaskResult({ retryAfterMs: -1 }).retryAfterMs).toBeNull()
    expect(readTaskResult({ more: 'yes' }).more).toBe(false)
  })
})

describe('JobScheduler: calls plugin tasks (TODO 952 stage 1)', () => {
  let db: Db
  let store: ScheduledJobStore
  let clock: number
  let idle: boolean
  let available: boolean
  let calls: { pluginId: string; taskId: string; reason: string }[]
  let replies: ({ more: boolean; retryAfterMs: number | null } | Error)[]
  let deferred: { fn: () => void; ms: number }[]

  const tasks: PluginTaskRunner = {
    available: () => available,
    run: async (pluginId, taskId, reason) => {
      calls.push({ pluginId, taskId, reason })
      const next = replies.shift() ?? { more: false, retryAfterMs: null }
      if (next instanceof Error) throw next
      return next
    }
  }

  const make = (): JobScheduler =>
    new JobScheduler(store, promptRunner, {
      autoRun: true,
      now: () => clock,
      schedule: () => () => undefined,
      defer: (fn, ms) => {
        const entry = { fn, ms }
        deferred.push(entry)
        return () => {
          deferred = deferred.filter((item) => item !== entry)
        }
      },
      pluginTasks: tasks,
      isIdle: () => idle
    })

  const declare = (scheduler: JobScheduler, idleTask: boolean): string => {
    scheduler.syncPluginTasks([
      { pluginId: 'aios.mail', tasks: [{ id: 'sync', name: 'Sync', defaultInterval: 15, ...(idleTask ? { idle: true } : {}) }] }
    ])
    return scheduler.overview().jobs[0]!.id
  }

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    store = new ScheduledJobStore(db)
    clock = new Date(2026, 9, 28, 9, 0).getTime()
    idle = true
    available = true
    calls = []
    replies = []
    deferred = []
  })
  afterEach(() => db.close())

  it('a row with an idle declaration is enabled from install; a task that runs on a schedule is still disabled as before', () => {
    const scheduler = make()
    expect(store.get(declare(scheduler, true))?.enabled).toBe(true)
    scheduler.syncPluginTasks([{ pluginId: 'aios.other', tasks: [{ id: 'fetch', name: 'Fetch', defaultInterval: 30 }] }])
    expect(scheduler.overview().jobs.find((job) => job.name === 'Fetch')?.enabled).toBe(false)
  })

  it('idle: waits until 2 minutes after startup and while a conversation is running, and calls once idle; with more it continues without waiting for the interval', async () => {
    const scheduler = make()
    const id = declare(scheduler, true)
    scheduler.start()
    clock += MIN
    // The interval (15 minutes) has not come yet.
    expect(scheduler.tick().get(id)).toBe('not-due')
    clock += 14 * MIN
    expect(calls).toHaveLength(0)
    // The schedule comes due here. If a conversation is running, it waits (the baseline is not advanced).
    idle = false
    expect(scheduler.tick().get(id)).toBe('wait-idle')
    idle = true
    replies.push({ more: true, retryAfterMs: null })
    expect(scheduler.tick().get(id)).toBe('run')
    expect(calls).toEqual([{ pluginId: 'aios.mail', taskId: 'sync', reason: 'scheduled' }])
    await flush()
    expect(store.get(id)?.lastOutcome).toBe('started')
    // Continuation: judged again after a short wait, without waiting for the tick.
    expect(deferred.map((entry) => entry.ms)).toEqual([2000])
    clock += 2000
    deferred.shift()!.fn()
    expect(calls.map((call) => call.reason)).toEqual(['scheduled', 'idle'])
    await flush()
    // If more does not return, the next run waits the interval (15 minutes).
    clock += MIN
    expect(scheduler.tick().get(id)).toBe('not-due')
  })

  it('TODO 1280: only while the list is open, calls idle tasks even during a conversation; when closed it waits; the list of another plugin has no effect', () => {
    const scheduler = make()
    const id = declare(scheduler, true)
    scheduler.start()
    clock += 15 * MIN
    idle = false
    expect(scheduler.tick().get(id)).toBe('wait-idle')
    scheduler.setPluginListWatch(1, 'aios.other')
    expect(scheduler.tick().get(id)).toBe('wait-idle')
    scheduler.setPluginListWatch(1, 'aios.mail')
    expect(scheduler.isPluginListWatched('aios.mail')).toBe(true)
    expect(scheduler.tick().get(id)).toBe('run')
    expect(calls).toEqual([{ pluginId: 'aios.mail', taskId: 'sync', reason: 'scheduled' }])
  })

  it('TODO 1280: a call during a conversation keeps the minimum interval (5 minutes) from the previous call; stops when closed', async () => {
    const scheduler = make()
    const id = declare(scheduler, true)
    scheduler.start()
    clock += 15 * MIN
    idle = false
    scheduler.setPluginListWatch(1, 'aios.mail')
    expect(scheduler.tick().get(id)).toBe('run')
    await flush()
    // A wake (as after login) asks for a call now, but the floor still holds while a conversation runs.
    clock += MIN
    scheduler.wakePluginTasks('aios.mail')
    expect(scheduler.tick().get(id)).toBe('wait-idle')
    clock += WATCHED_TASK_MIN_INTERVAL_MS
    scheduler.setPluginListWatch(1, null)
    expect(scheduler.isPluginListWatched('aios.mail')).toBe(false)
    expect(scheduler.tick().get(id)).toBe('wait-idle')
    scheduler.setPluginListWatch(1, 'aios.mail')
    expect(scheduler.tick().get(id)).toBe('run')
    expect(calls).toHaveLength(2)
  })

  it('TODO 1280: even if several windows open the same list it runs only once, and it counts as open until all windows are closed', () => {
    const scheduler = make()
    const id = declare(scheduler, true)
    scheduler.start()
    clock += 15 * MIN
    idle = false
    scheduler.setPluginListWatch(1, 'aios.mail')
    scheduler.setPluginListWatch(2, 'aios.mail')
    expect(scheduler.tick().get(id)).toBe('run')
    expect(scheduler.tick().get(id)).toBe('skip-running')
    expect(calls).toHaveLength(1)
    scheduler.setPluginListWatch(1, null)
    expect(scheduler.isPluginListWatched('aios.mail')).toBe(true)
    scheduler.setPluginListWatch(2, null)
    expect(scheduler.isPluginListWatched('aios.mail')).toBe(false)
    // An id that is not a plugin id is not stored.
    scheduler.setPluginListWatch(3, 'not a plugin id')
    expect(scheduler.isPluginListWatched('not a plugin id')).toBe(false)
  })

  it('right after startup (within 2 minutes) it waits even if a schedule is due', () => {
    const scheduler = make()
    const id = declare(scheduler, true)
    clock += 20 * MIN
    scheduler.start()
    expect(scheduler.tick().get(id)).toBe('wait-idle')
    clock += IDLE_TASK_START_DELAY_MS
    expect(scheduler.tick().get(id)).toBe('run')
  })

  it('does not call during retryAfterMs (429); a failure is kept as failed and does not continue', async () => {
    const scheduler = make()
    const id = declare(scheduler, true)
    scheduler.start()
    clock += 20 * MIN
    replies.push({ more: true, retryAfterMs: 5 * MIN })
    expect(scheduler.tick().get(id)).toBe('run')
    await flush()
    // A wait longer than the tick is not deferred (the tick picks it up).
    expect(deferred).toHaveLength(0)
    clock += MIN
    expect(scheduler.tick().get(id)).toBe('not-due')
    clock += 5 * MIN
    replies.push(new Error('boom'))
    expect(scheduler.tick().get(id)).toBe('run')
    await flush()
    expect(store.get(id)).toMatchObject({ lastOutcome: 'failed', lastError: 'boom' })
    clock += MIN
    expect(scheduler.tick().get(id)).toBe('not-due')
  })

  it('plugin disabled or declaration gone: waits without advancing the baseline; does not call twice while running', async () => {
    const scheduler = make()
    const id = declare(scheduler, false)
    const job = scheduler.overview().jobs[0]!
    scheduler.update(id, { name: job.name, enabled: true, spec: job.spec, action: job.action })
    clock += 20 * MIN
    available = false
    expect(scheduler.tick().get(id)).toBe('plugin-unavailable')
    available = true
    let release: (() => void) | null = null
    const slow: PluginTaskRunner = {
      available: () => true,
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ more: false, retryAfterMs: null })
        })
    }
    const slowScheduler = new JobScheduler(store, promptRunner, {
      autoRun: true,
      now: () => clock,
      schedule: () => () => undefined,
      pluginTasks: slow
    })
    slowScheduler.syncPluginTasks([{ pluginId: 'aios.mail', tasks: [{ id: 'sync', name: 'Sync', defaultInterval: 15 }] }])
    expect(slowScheduler.tick().get(id)).toBe('run')
    clock += 20 * MIN
    expect(slowScheduler.tick().get(id)).toBe('skip-running')
    expect(slowScheduler.overview().jobs[0]?.running).toBe(true)
    release!()
    await flush()
    expect(slowScheduler.overview().jobs[0]?.running).toBe(false)
  })

  it('run now calls with manual without waiting for idle; refuses when the plugin is missing', async () => {
    const scheduler = make()
    const id = declare(scheduler, true)
    idle = false
    scheduler.runNow(id)
    expect(calls).toEqual([{ pluginId: 'aios.mail', taskId: 'sync', reason: 'manual' }])
    expect(() => scheduler.runNow(id)).toThrow(/schedule-job-running/)
    await flush()
    available = false
    expect(() => scheduler.runNow(id)).toThrow(/schedule-plugin-unavailable/)
  })

  it('wakePluginTasks: right after login it calls as a continuation without waiting for the interval (the idle condition stays)', async () => {
    const scheduler = make()
    const id = declare(scheduler, true)
    scheduler.start()
    clock += 20 * MIN
    expect(scheduler.tick().get(id)).toBe('run')
    await flush()
    clock += MIN
    expect(scheduler.tick().get(id)).toBe('not-due')
    scheduler.wakePluginTasks('aios.mail')
    expect(deferred.map((entry) => entry.ms)).toEqual([0])
    idle = false
    expect(scheduler.tick().get(id)).toBe('wait-idle')
    idle = true
    expect(scheduler.tick().get(id)).toBe('run')
    expect(calls.at(-1)?.reason).toBe('idle')
  })

  it('after stop it does not call a continuation and waits for the run in progress', async () => {
    const scheduler = make()
    const id = declare(scheduler, true)
    scheduler.start()
    clock += 20 * MIN
    replies.push({ more: true, retryAfterMs: null })
    scheduler.tick()
    await scheduler.stop()
    expect(store.get(id)?.lastOutcome).toBe('started')
    expect(deferred).toHaveLength(0)
    expect(scheduler.tick().size).toBe(0)
  })

  it('review 56-6: stop tells the plugin task to abort and does not keep it as a failure', async () => {
    let shutdowns = 0
    let abortRun: ((err: Error) => void) | null = null
    const cut: PluginTaskRunner = {
      available: () => true,
      run: () =>
        new Promise((_resolve, reject) => {
          abortRun = reject
        }),
      shutdown: () => {
        shutdowns += 1
        abortRun?.(new Error('plugin-task-shutdown'))
      }
    }
    const scheduler = new JobScheduler(store, promptRunner, {
      autoRun: true,
      now: () => clock,
      schedule: () => () => undefined,
      pluginTasks: cut,
      pluginStopWaitMs: 60_000
    })
    const id = declare(scheduler, false)
    scheduler.runNow(id)
    const started = Date.now()
    await scheduler.stop()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(shutdowns).toBe(1)
    expect(store.get(id)?.lastOutcome).toBeNull()
    expect(scheduler.overview().jobs[0]?.running).toBe(false)
  })

  it('review 56-6: a task that does not honor the abort is waited on only up to the limit, and a result arriving later is not written to the DB', async () => {
    let release: (() => void) | null = null
    const stubborn: PluginTaskRunner = {
      available: () => true,
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ more: true, retryAfterMs: null })
        })
    }
    const scheduler = new JobScheduler(store, promptRunner, {
      autoRun: true,
      now: () => clock,
      schedule: () => () => undefined,
      pluginTasks: stubborn,
      pluginStopWaitMs: 20
    })
    const id = declare(scheduler, false)
    scheduler.runNow(id)
    const writes: string[] = []
    const original = store.recordResult.bind(store)
    store.recordResult = (...args) => {
      writes.push(args[1])
      original(...args)
    }
    await scheduler.stop()
    // `before-quit` closes the DB here. A result that arrives after it is closed is not written.
    release!()
    await flush()
    expect(writes).toEqual([])
    expect(store.get(id)?.lastOutcome).toBeNull()
  })
})

describe('PluginTaskInvoker shutdown (review 56-6)', () => {
  let db: Db
  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })
  afterEach(() => db.close())

  it('shutdown aborts running calls (passing a signal), does not write a state that arrives later, and afterwards run and reset do nothing', async () => {
    const states = new PluginTaskStateStore(db)
    states.set('aios.mail', 'sync', { cursor: 'a' })
    let seenSignal: AbortSignal | undefined
    let reply: ((value: unknown) => void) | null = null
    const invoker = new PluginTaskInvoker(
      {
        hasTask: () => true,
        invoke: (_id, _name, _arg, _kind, _timeout, signal) => {
          seenSignal = signal
          // Even if the host does not look at the signal, the invoker does not wait.
          return new Promise((resolve) => {
            reply = resolve
          })
        }
      },
      states
    )
    const running = invoker.run('aios.mail', 'sync', 'idle')
    invoker.shutdown()
    await expect(running).rejects.toThrow('plugin-task-shutdown')
    expect(seenSignal?.aborted).toBe(true)
    reply!({ state: { cursor: 'late' } })
    await flush()
    expect(states.get('aios.mail', 'sync')).toEqual({ cursor: 'a' })
    await expect(invoker.run('aios.mail', 'sync', 'idle')).rejects.toThrow('plugin-task-shutdown')
    expect(invoker.available('aios.mail', 'sync')).toBe(false)
    invoker.reset('aios.mail')
    expect(states.get('aios.mail', 'sync')).toEqual({ cursor: 'a' })
  })
})
