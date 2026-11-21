/**
 * The entry point that calls a plugin's periodic tasks in plugin-host (TODO 952 stage 1, ARCHITECTURE.md 6.2.4 / 7.2).
 *
 * `JobScheduler` only counts time and idleness and never touches plugin code. This does:
 *   1. read the previous state (`plugin_task_state`),
 *   2. call plugin-host's `tasks.<id>` with `PluginHost.invoke(id, taskId, { state, reason }, 'task')` (constraint 8: not run in main),
 *   3. check the return value **without trusting it** (shape, size, upper limit of the wait) and write the new state.
 * A plugin keeps no state of its own (even the continuation position is received here). The state is JSON and holds no body text (the canonical copy is `plugin_documents`).
 *
 * Independent of electron (PluginHost is received only as the shape of `invoke`) - tests drive it with a fake invoke.
 */
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import {
  MAX_PLUGIN_TASK_STATE_BYTES,
  type PluginTaskArg,
  type PluginTaskState
} from '@shared/plugin.js'
import type { Locale } from '@shared/locale.js'
import { log } from '../../common/logger.js'

/** Upper limit of one call. A task advances a little at a time (`more`) and must not hold on for long. */
export const PLUGIN_TASK_TIMEOUT_MS = 5 * 60_000
/** Upper limit of `retryAfterMs` (even if a plugin returns a large value, it is not held longer than this). */
export const MAX_PLUGIN_TASK_RETRY_MS = 60 * 60_000

/** The result `JobScheduler` receives (already checked). */
export interface PluginTaskOutcome {
  readonly more: boolean
  /** null = do not wait. */
  readonly retryAfterMs: number | null
}

/** The table of task state (migration 33). main's this is the only writer. */
export class PluginTaskStateStore {
  private readonly selectOne: Statement
  private readonly upsert: Statement
  private readonly deleteOne: Statement
  private readonly deletePlugin: Statement

  constructor(db: Database) {
    this.selectOne = db.prepare(`SELECT state FROM plugin_task_state WHERE plugin_id = ? AND task_id = ?`)
    this.upsert = db.prepare(`
      INSERT INTO plugin_task_state (plugin_id, task_id, state, updated_at) VALUES (@plugin_id, @task_id, @state, @now)
      ON CONFLICT(plugin_id, task_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
    `)
    this.deleteOne = db.prepare(`DELETE FROM plugin_task_state WHERE plugin_id = ? AND task_id = ?`)
    this.deletePlugin = db.prepare(`DELETE FROM plugin_task_state WHERE plugin_id = ?`)
  }

  get(pluginId: string, taskId: string): PluginTaskState | null {
    const row = this.selectOne.get(pluginId, taskId) as { state: string } | undefined
    if (row === undefined) return null
    try {
      const parsed: unknown = JSON.parse(row.state)
      return isStateObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  set(pluginId: string, taskId: string, state: PluginTaskState | null, now: number = Date.now()): void {
    if (state === null) {
      this.deleteOne.run(pluginId, taskId)
      return
    }
    this.upsert.run({ plugin_id: pluginId, task_id: taskId, state: JSON.stringify(state), now })
  }

  /** Delete all state of that plugin (on logout, before signing in again with another account). */
  clear(pluginId: string): void {
    this.deletePlugin.run(pluginId)
  }
}

function isStateObject(value: unknown): value is PluginTaskState {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The plugin-host entry point (a part of `PluginHost`). */
export interface PluginTaskHost {
  hasTask(pluginId: string, taskId: string): boolean
  /** When `signal` is aborted, stop waiting and reject (review 56-6, shutdown). */
  invoke(pluginId: string, name: string, arg: unknown, kind: 'task', timeoutMs: number, signal?: AbortSignal): Promise<unknown>
}

/** The reason for a call cut off at shutdown (`JobScheduler` does not record it as a failure). */
export const PLUGIN_TASK_SHUTDOWN = 'plugin-task-shutdown'

/**
 * Check a task's return value. plugin-host is a separate trust zone (7.8) - a wrong shape means "keep the state and no continuation".
 * If the `state` JSON exceeds the limit, it is not written (kept as is) - a large state must not pile up in the DB.
 */
export function readTaskResult(raw: unknown): {
  readonly state: PluginTaskState | null | undefined
  readonly more: boolean
  readonly retryAfterMs: number | null
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { state: undefined, more: false, retryAfterMs: null }
  const record = raw as Record<string, unknown>
  let state: PluginTaskState | null | undefined
  if (record['state'] === null) state = null
  else if (isStateObject(record['state'])) {
    let text: string | null
    try {
      text = JSON.stringify(record['state'])
    } catch {
      text = null
    }
    state = text !== null && Buffer.byteLength(text, 'utf8') <= MAX_PLUGIN_TASK_STATE_BYTES ? (JSON.parse(text) as PluginTaskState) : undefined
  }
  const retry = record['retryAfterMs']
  const retryAfterMs =
    typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? Math.min(Math.round(retry), MAX_PLUGIN_TASK_RETRY_MS) : null
  return { state, more: record['more'] === true, retryAfterMs }
}

export class PluginTaskInvoker {
  /**
   * Shutdown (review 56-6, 12.9): abort with `shutdown()`. A running call stops waiting for plugin-host and rejects, and
   * nothing is called afterwards. **Even if a result arrives after the abort, the state is not written** (`before-quit` closes the DB after this).
   */
  private readonly aborter = new AbortController()

  constructor(
    private readonly host: PluginTaskHost,
    private readonly states: PluginTaskStateStore,
    private readonly now: () => number = Date.now,
    /** TODO 1264: the current display language, passed to the task as `locale` (omitted when not given). */
    private readonly locale?: () => Locale
  ) {}

  available(pluginId: string, taskId: string): boolean {
    return !this.aborter.signal.aborted && this.host.hasTask(pluginId, taskId)
  }

  /** Shutdown. Cut off running calls; later `run` calls throw. Calling it twice is fine. */
  shutdown(): void {
    this.aborter.abort()
  }

  /** Call once. A failure throws (JobScheduler records it as `failed`). The state advances only on success. */
  async run(pluginId: string, taskId: string, reason: PluginTaskArg['reason']): Promise<PluginTaskOutcome> {
    const signal = this.aborter.signal
    if (signal.aborted) throw new Error(PLUGIN_TASK_SHUTDOWN)
    const locale = this.locale?.()
    const arg: PluginTaskArg = { state: this.states.get(pluginId, taskId), reason, ...(locale === undefined ? {} : { locale }) }
    // Even if the host does not watch the signal, do not wait here once aborted.
    let onAbort: (() => void) | null = null
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error(PLUGIN_TASK_SHUTDOWN))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    let raw: unknown
    try {
      raw = await Promise.race([this.host.invoke(pluginId, taskId, arg, 'task', PLUGIN_TASK_TIMEOUT_MS, signal), aborted])
    } finally {
      if (onAbort !== null) signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) throw new Error(PLUGIN_TASK_SHUTDOWN)
    const result = readTaskResult(raw)
    if (result.state !== undefined) this.states.set(pluginId, taskId, result.state, this.now())
    else if (typeof raw === 'object' && raw !== null && 'state' in raw) {
      log.warn('plugin.task.state.rejected', { pluginId, taskId })
    }
    return { more: result.more, retryAfterMs: result.retryAfterMs }
  }

  /** On logout or an account swap, discard that plugin's continuation position. */
  reset(pluginId: string): void {
    if (this.aborter.signal.aborted) return
    this.states.clear(pluginId)
  }
}
