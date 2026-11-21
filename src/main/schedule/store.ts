/**
 * The table of scheduled jobs (migration 18 `scheduled_jobs`, TODO 323, ARCHITECTURE.md 6.2.4).
 *
 * **Independent of electron.** The only writer is this entry point in main (the index process does not touch it).
 * When converting to the shape passed to the renderer (`ScheduledJob`), the working folder is turned from a path into a URI.
 * "Next schedule" and "is it running" are not kept in the table; `JobScheduler` adds them from the current time and SessionManager.
 *
 * The kinds (the `kind` column) are `'prompt'` (a scheduled prompt) and `'plugin'` (a periodic task a plugin declared, TODO 372).
 * A plugin's row fits the same columns (`{ pluginId, taskId }` in the `action` JSON), so no migration is needed.
 * TODO 1265 added `'reminder'` (a notification only, `{ body }` in the `action` JSON) and the `snooze_at` column (migration 44).
 * An unknown kind or a broken row is, as before, not shown in the list and not run (the same when an old version sees a row of a new kind).
 */
import { randomUUID } from 'node:crypto'
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import { isThinkingLevel, type ThinkingLevel } from '@shared/agent.js'
import {
  normalizeScheduleSpec,
  readScheduleSpec,
  type LaterAttachment,
  type LaterSettings,
  type ScheduleSpec,
  type ScheduledJobInput,
  type ScheduledJobOutcome
} from '@shared/schedule.js'
import type { ScheduledTaskDeclaration } from '@shared/plugin.js'
import { pathToUri, uriToPath } from '../../common/uri.js'
import { log } from '../../common/logger.js'

/** A table row as read (used only by main). The working folder is a path. */
export interface StoredJob {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly spec: ScheduleSpec
  readonly action: StoredAction
  /** It runs when the first schedule after this time comes. */
  readonly anchorAt: number
  readonly lastRunAt: number | null
  readonly lastThreadId: string | null
  readonly lastOutcome: ScheduledJobOutcome | null
  readonly lastError: string | null
  /** The scheduled time of the skipped run itself (TODO 351: `lastRunAt` stays the run that ran, so this is kept separately). */
  readonly lastSkipAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
  /** TODO 725: the run count limit. null = unlimited. */
  readonly maxRuns: number | null
  /** TODO 725: the number of runs that actually ran (skipped and unsupported runs are not counted). Re-enabling starts counting again from 0. */
  readonly runCount: number
  /** TODO 1265: a reminder's snooze (the time it notifies again), or null. Independent of `anchorAt`. */
  readonly snoozeAt: number | null
}

/** A scheduled-prompt job (the shape `JobRunner.run` receives). */
export type StoredPromptJob = StoredJob & { readonly action: StoredPromptAction }

/** A plugin's periodic task (TODO 372). A row made from a declaration; its contents are only the id pair. */
export interface StoredPluginAction {
  readonly kind: 'plugin'
  readonly pluginId: string
  readonly taskId: string
}

/**
 * TODO 628: a one-time row that sends "continue" to an existing thread after the usage limit is lifted. It is made only inside main
 * (it does not appear in the renderer's `ScheduledJobInput` - it cannot be edited in `ScheduleEditor`).
 */
export interface StoredResumeAction {
  readonly kind: 'resume'
  readonly threadId: string
  readonly prompt: string
}

/**
 * TODO 989: one message of the Composer's "send later". A one-time row (`spec.kind === 'once'`). Unlike 628's resume,
 * it has an arbitrary body and attachments and does not depend on the interrupted mark. Attachments are kept as references and re-read by main at send time
 * (`LaterAttachment`; only a pasted image holds base64).
 */
export interface StoredLaterAction {
  readonly kind: 'later'
  readonly threadId: string
  readonly text: string
  readonly attachments: readonly LaterAttachment[]
  /** model / thinking per message (the same as a normal send. Omitted means the thread's default). */
  readonly settings?: LaterSettings
}

/**
 * TODO 1265: a reminder. Only a desktop notification (title = the job name, `body` optional). It starts no thread and calls no model.
 * The body is the user's own text and, like a scheduled prompt (323), is not redacted - it must be shown as written (the DB is encrypted as a whole).
 */
export interface StoredReminderAction {
  readonly kind: 'reminder'
  readonly body: string
}

export type StoredAction =
  | StoredPromptAction
  | StoredPluginAction
  | StoredResumeAction
  | StoredLaterAction
  | StoredReminderAction

/** A reminder row (TODO 1265). */
export type StoredReminderJob = StoredJob & { readonly action: StoredReminderAction }

/** Whether it is a reminder row (TODO 1265). */
export function isReminderJob(job: StoredJob): job is StoredReminderJob {
  return job.action.kind === 'reminder'
}

/** Whether it is a row of TODO 989's "send later". */
export function isLaterJob(job: StoredJob): job is StoredJob & { readonly action: StoredLaterAction } {
  return job.action.kind === 'later'
}

/** Whether it is a periodic-prompt row. */
export function isPromptJob(job: StoredJob): job is StoredPromptJob {
  return job.action.kind === 'prompt'
}

/** Whether it is a row of TODO 628's resume reservation. */
export function isResumeJob(job: StoredJob): job is StoredJob & { readonly action: StoredResumeAction } {
  return job.action.kind === 'resume'
}

/** The contents of a scheduled prompt (the working folder is a path. null means no affiliation). */
export interface StoredPromptAction {
  readonly kind: 'prompt'
  readonly prompt: string
  readonly cwd: string | null
  readonly modelId: string | null
  readonly thinking: ThinkingLevel | null
  readonly approvalStrict: boolean
}

interface JobRow {
  id: string
  name: string
  enabled: number
  kind: string
  spec: string
  action: string
  anchor_at: number
  last_run_at: number | null
  last_thread_id: string | null
  last_outcome: string | null
  last_error: string | null
  last_skip_at: number | null
  created_at: number
  updated_at: number
  max_runs: number | null
  run_count: number
  /** TODO 1265 (migration 44). */
  snooze_at: number | null
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseAction(kind: string, raw: string): StoredAction | null {
  const value = parseJson(raw)
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (kind === 'plugin') {
    const pluginId = record['pluginId']
    const taskId = record['taskId']
    if (typeof pluginId !== 'string' || typeof taskId !== 'string') return null
    return { kind: 'plugin', pluginId, taskId }
  }
  if (kind === 'resume') {
    const threadId = record['threadId']
    const prompt = record['prompt']
    if (typeof threadId !== 'string' || typeof prompt !== 'string') return null
    return { kind: 'resume', threadId, prompt }
  }
  if (kind === 'later') {
    const threadId = record['threadId']
    const text = record['text']
    const attachments = record['attachments']
    if (typeof threadId !== 'string' || typeof text !== 'string' || !Array.isArray(attachments)) return null
    const settings = record['settings']
    return {
      kind: 'later',
      threadId,
      text,
      attachments: attachments as LaterAttachment[],
      ...(typeof settings === 'object' && settings !== null ? { settings: settings as LaterSettings } : {})
    }
  }
  if (kind === 'reminder') {
    const body = record['body']
    return { kind: 'reminder', body: typeof body === 'string' ? body : '' }
  }
  if (kind !== 'prompt') return null
  if (typeof record['prompt'] !== 'string') return null
  const cwd = record['cwd']
  const modelId = record['modelId']
  const thinking = record['thinking']
  return {
    kind: 'prompt',
    prompt: record['prompt'],
    cwd: typeof cwd === 'string' ? cwd : null,
    modelId: typeof modelId === 'string' ? modelId : null,
    thinking: isThinkingLevel(thinking) ? thinking : null,
    approvalStrict: record['approvalStrict'] === true
  }
}

function isOutcome(value: unknown): value is ScheduledJobOutcome {
  return value === 'started' || value === 'skipped' || value === 'failed' || value === 'unsupported'
}

/** Read a row. A row with an unknown kind (`kind`) or a broken row gives null (not shown in the list, not run). */
function toJob(row: JobRow): StoredJob | null {
  const spec = readScheduleSpec(parseJson(row.spec))
  const action = parseAction(row.kind, row.action)
  if (spec === null || action === null) return null
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    spec,
    action,
    anchorAt: row.anchor_at,
    lastRunAt: row.last_run_at,
    lastThreadId: row.last_thread_id,
    lastOutcome: isOutcome(row.last_outcome) ? row.last_outcome : null,
    lastError: row.last_error,
    lastSkipAt: row.last_skip_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    maxRuns: row.max_runs,
    runCount: row.run_count,
    snoozeAt: row.snooze_at ?? null
  }
}

/** Turn the renderer's input (URI) into table contents (path). */
function storedAction(input: ScheduledJobInput): StoredAction {
  const action = input.action
  if (action.kind === 'plugin') return { kind: 'plugin', pluginId: action.pluginId, taskId: action.taskId }
  if (action.kind === 'reminder') return { kind: 'reminder', body: action.body }
  return {
    kind: 'prompt',
    prompt: action.prompt,
    cwd: action.cwdUri === null ? null : uriToPath(action.cwdUri),
    modelId: action.modelId,
    thinking: action.thinking,
    approvalStrict: action.approvalStrict
  }
}

/**
 * Turn the table contents into the shape of the renderer's input (URI). TODO 628's resume rows are not passed (the caller excludes them).
 * TODO 725: `maxRuns` is also passed (always has a value - null means unlimited).
 */
export function toJobInput(job: StoredJob): ScheduledJobInput {
  if (job.action.kind === 'plugin') {
    return {
      name: job.name,
      enabled: job.enabled,
      spec: job.spec,
      action: { kind: 'plugin', pluginId: job.action.pluginId, taskId: job.action.taskId },
      maxRuns: job.maxRuns
    }
  }
  if (job.action.kind === 'reminder') {
    return {
      name: job.name,
      enabled: job.enabled,
      spec: job.spec,
      action: { kind: 'reminder', body: job.action.body },
      maxRuns: job.maxRuns
    }
  }
  if (job.action.kind === 'resume' || job.action.kind === 'later') {
    throw new Error('toJobInput: resume / later jobs are internal (TODO 628 / 989) and never reach the renderer')
  }
  return {
    name: job.name,
    enabled: job.enabled,
    spec: job.spec,
    maxRuns: job.maxRuns,
    action: {
      kind: 'prompt',
      prompt: job.action.prompt,
      cwdUri: job.action.cwd === null ? null : pathToUri(job.action.cwd),
      modelId: job.action.modelId,
      thinking: job.action.thinking,
      approvalStrict: job.action.approvalStrict
    }
  }
}

/**
 * The spec JSON to write to the table. The old `weekdays` is converted to `days` before writing (TODO 527: only `days` is written).
 * Reading (`readScheduleSpec`) is aligned to the same shape, so reading an old row and saving it with the same value does not count as "changed".
 */
function specJson(spec: ScheduleSpec): string {
  return JSON.stringify(normalizeScheduleSpec(spec))
}

function sameSpec(a: ScheduleSpec, b: ScheduleSpec): boolean {
  return specJson(a) === specJson(b)
}

export class ScheduledJobStore {
  private readonly selectAll: Statement
  private readonly selectOne: Statement
  private readonly selectExists: Statement
  private readonly insert: Statement
  private readonly update: Statement
  private readonly remove: Statement
  private readonly markRun: Statement
  private readonly markResult: Statement
  private readonly markSkip: Statement
  private readonly rename: Statement
  private readonly disableStmt: Statement
  private readonly enableStmt: Statement
  private readonly snoozeStmt: Statement

  constructor(db: Database) {
    this.selectAll = db.prepare(`SELECT * FROM scheduled_jobs ORDER BY created_at, rowid`)
    this.selectOne = db.prepare(`SELECT * FROM scheduled_jobs WHERE id = ?`)
    this.selectExists = db.prepare(`SELECT 1 FROM scheduled_jobs WHERE id = ?`)
    this.insert = db.prepare(`
      INSERT INTO scheduled_jobs (id, name, enabled, kind, spec, action, anchor_at, max_runs, created_at, updated_at)
      VALUES (@id, @name, @enabled, @kind, @spec, @action, @now, @max_runs, @now, @now)
    `)
    // TODO 725: rewrite `max_runs`, and reset `run_count` to 0 **only when going from disabled to enabled**
    // (`reset_runs`. When only the name or prompt changes, or the time changes while it stays enabled, the accumulated count is kept).
    // TODO 1265: `clear_snooze` drops a pending snooze when the user turns the row off (an automatic disable - a used-up
    // "once" - keeps it: snoozing a one-time reminder that just fired is the usual case).
    this.update = db.prepare(`
      UPDATE scheduled_jobs SET name = @name, enabled = @enabled, spec = @spec, action = @action,
        anchor_at = @anchor_at, max_runs = @max_runs,
        run_count = CASE WHEN @reset_runs = 1 THEN 0 ELSE run_count END,
        snooze_at = CASE WHEN @clear_snooze = 1 THEN NULL ELSE snooze_at END, updated_at = @now
      WHERE id = @id
    `)
    this.remove = db.prepare(`DELETE FROM scheduled_jobs WHERE id = ?`)
    // It ran. For a scheduled run, the anchor also moves to now (if `anchor` is null it stays = run now).
    // `last_skip_at` is also cleared - since a new run ran, the earlier "skipped" record is stale.
    // TODO 725: `increment` (0 or 1) advances `run_count` - only runs of scheduled prompts are counted
    // (the firing of a resume (628) is not counted).
    this.markRun = db.prepare(`
      UPDATE scheduled_jobs SET last_run_at = @now, anchor_at = COALESCE(@anchor, anchor_at),
        last_thread_id = NULL, last_outcome = NULL, last_error = NULL, last_skip_at = NULL,
        run_count = run_count + @increment
      WHERE id = @id
    `)
    this.markResult = db.prepare(`
      UPDATE scheduled_jobs SET last_thread_id = COALESCE(@thread_id, last_thread_id),
        last_outcome = @outcome, last_error = @error
      WHERE id = @id
    `)
    // TODO 351: keep the scheduled time (`due`) of the skipped run itself in `last_skip_at`. `last_run_at` is not
    // moved (it stays the time of the run that last ran) - so that "previous" and "the skipped run" are shown as separate values.
    // TODO 372: "unsupported" (a plugin task) has the same shape - the anchor moves and that run's scheduled time is kept.
    this.markSkip = db.prepare(`
      UPDATE scheduled_jobs SET anchor_at = @now, last_skip_at = @due, last_outcome = @outcome, last_error = NULL
      WHERE id = @id
    `)
    // The declared name changed in a plugin version bump (the time and enabled the user changed are not touched).
    this.rename = db.prepare(`UPDATE scheduled_jobs SET name = @name, updated_at = @now WHERE id = @id`)
    // TODO 629: disable a "once" after it runs (or after it is skipped for being 24 hours or more overdue). Not deleted -
    // the previous run and history in the list are kept as they are.
    this.disableStmt = db.prepare(`UPDATE scheduled_jobs SET enabled = 0, updated_at = @now WHERE id = @id`)
    this.enableStmt = db.prepare(`UPDATE scheduled_jobs SET enabled = 1, updated_at = @now WHERE id = @id`)
    // TODO 1265: set or clear a reminder's snooze. `updated_at` is not touched (it is a state, not an edit).
    this.snoozeStmt = db.prepare(`UPDATE scheduled_jobs SET snooze_at = @at WHERE id = @id`)
  }

  list(): readonly StoredJob[] {
    return (this.selectAll.all() as JobRow[]).flatMap((row) => {
      const job = toJob(row)
      return job === null ? [] : [job]
    })
  }

  /** Whether a row exists (including rows that cannot be parsed. `get` returns null for a row that cannot be parsed). */
  has(id: string): boolean {
    return this.selectExists.get(id) !== undefined
  }

  get(id: string): StoredJob | null {
    const row = this.selectOne.get(id) as JobRow | undefined
    return row === undefined ? null : toJob(row)
  }

  /** Add. The anchor is now (it does not run for a schedule earlier than the creation time). An omitted `maxRuns` is unlimited (null). */
  create(input: ScheduledJobInput, now: number): StoredJob {
    const id = randomUUID()
    this.insert.run({
      id,
      name: input.name,
      enabled: input.enabled ? 1 : 0,
      kind: input.action.kind,
      spec: specJson(input.spec),
      action: JSON.stringify(storedAction(input)),
      max_runs: input.maxRuns ?? null,
      now
    })
    return this.get(id) as StoredJob
  }

  /**
   * Update. When **the way the time is written changed, or it went from disabled to enabled**, the anchor moves to now - so it does not run
   * for a past schedule the moment it is changed. A change of only the name or prompt does not move the anchor. null if absent.
   *
   * TODO 725: `run_count` is reset to 0 **only on a switch from disabled to enabled**
   * ("re-enabling counts again", the same treatment as 629's "once").
   */
  updateJob(id: string, input: ScheduledJobInput, now: number): StoredJob | null {
    const current = this.get(id)
    if (current === null) return null
    const reenabled = !current.enabled && input.enabled
    const rearm = !sameSpec(current.spec, input.spec) || reenabled
    const maxRuns = input.maxRuns ?? null
    // code-review (TODO 725): lowering an enabled job's maxRuns to runCount or below left it enabled
    // (since `disableIfMaxRunsReached` is called only right after launch). Check at save time too, and if it becomes used up,
    // disable it - aligned with the "Done (N/N)" handling. If reenabled, run_count is counted again from 0,
    // so judge here with the effective run_count (0 if reenabled).
    const effectiveRunCount = reenabled ? 0 : current.runCount
    const completed = maxRuns !== null && effectiveRunCount >= maxRuns
    // TODO 761 (a fix to 739): also look at "was it already completed before saving" - a job that is already completed
    // passes through here on every save, even a rename, so judging by `completed` alone logged every time.
    // Log only when this save makes it complete (a transition).
    const wasCompleted = current.maxRuns !== null && current.runCount >= current.maxRuns
    const enabled = input.enabled && !completed
    this.update.run({
      id,
      name: input.name,
      enabled: enabled ? 1 : 0,
      spec: specJson(input.spec),
      action: JSON.stringify(storedAction(input)),
      anchor_at: rearm ? now : current.anchorAt,
      max_runs: maxRuns,
      reset_runs: reenabled ? 1 : 0,
      clear_snooze: current.enabled && !input.enabled ? 1 : 0,
      now
    })
    // TODO 739/761: when a save makes it complete (lowering the run count limit to runCount or below), emit the same log as
    // when it completes after running (`disableIfMaxRunsReached`). Not emitted when merely re-saving a row that was already
    // complete before saving (for example a rename).
    if (completed && !wasCompleted) this.logCompleted(id, effectiveRunCount, maxRuns as number)
    return this.get(id)
  }

  /**
   * TODO 725 / 739: main (`JobScheduler`) calls it right after `launch` - if `run_count` has
   * reached `max_runs`, disable the row (a used-up row stays disabled, and the list shows "Done (N/N)". Not deleted).
   * If `maxRuns` is unlimited (null), do nothing. The log of the transition to complete is only here and in `updateJob` (one place,
   * `logCompleted`) - it does not log the body, only the job id and the counts.
   */
  disableIfMaxRunsReached(id: string, now: number): boolean {
    const job = this.get(id)
    if (job === null || job.maxRuns === null || job.runCount < job.maxRuns) return false
    this.disable(id, now)
    this.logCompleted(id, job.runCount, job.maxRuns)
    return true
  }

  private logCompleted(id: string, runCount: number, maxRuns: number): void {
    log.info('schedule.completed', { jobId: id, runCount, maxRuns })
  }

  /**
   * TODO 628: a one-time row that sends "continue" to an existing thread after the usage limit is lifted. It cannot be made from the
   * renderer (`JobScheduler.create` refuses `action.kind !== 'prompt'`) - this is the only entry point.
   * If an earlier reservation remains for the same thread, delete it first (0 or 1 per thread; pressing again replaces it).
   */
  createResume(threadId: string, prompt: string, at: number, now: number): StoredJob {
    for (const job of this.list()) {
      if (isResumeJob(job) && job.action.threadId === threadId) this.delete(job.id)
    }
    const id = randomUUID()
    this.insert.run({
      id,
      name: `resume:${threadId}`,
      enabled: 1,
      kind: 'resume',
      spec: specJson({ kind: 'once', at: new Date(at).toISOString() }),
      action: JSON.stringify({ kind: 'resume', threadId, prompt } satisfies StoredResumeAction),
      // TODO 725: a resume reservation is outside the run count limit (it rides on the same one-shot mechanism as 629's "once").
      max_runs: null,
      now
    })
    return this.get(id) as StoredJob
  }

  /**
   * TODO 989: one message of "send later". Unlike 628, any number can be placed on the same thread (they do not replace each other).
   * Outside the run count limit (one-shot).
   */
  createLater(
    threadId: string,
    text: string,
    attachments: readonly LaterAttachment[],
    at: number,
    now: number,
    settings: LaterSettings = {}
  ): StoredJob {
    const id = randomUUID()
    this.insert.run({
      id,
      name: `later:${threadId}`,
      enabled: 1,
      kind: 'later',
      spec: specJson({ kind: 'once', at: new Date(at).toISOString() }),
      action: JSON.stringify({
        kind: 'later',
        threadId,
        text,
        attachments,
        ...(Object.keys(settings).length === 0 ? {} : { settings })
      } satisfies StoredLaterAction),
      max_runs: null,
      now
    })
    return this.get(id) as StoredJob
  }

  /**
   * TODO 989 (review): re-enable a "send later" that was disabled when it started sending, since it could not be sent (once more at the next tick).
   * The previous result is cleared.
   */
  reenableLater(id: string, now: number): void {
    this.enableStmt.run({ id, now })
    this.markRun.run({ id, now, anchor: null, increment: 0 })
  }

  /**
   * TODO 989 (review): cleanup at startup. A row that was disabled when sending started and then the process died before the result was written (disabled with
   * an empty result) - it is unknown whether it was sent. Do not silently delete the body: turn it into "failed" and show it in the list (the user
   * chooses to put it back in the input box or discard it). Returns the number fixed.
   */
  failInterruptedLater(): number {
    let count = 0
    for (const job of this.list()) {
      if (!isLaterJob(job) || job.enabled || job.lastOutcome !== null) continue
      this.recordResult(job.id, 'failed', null, 'interrupted')
      count += 1
    }
    return count
  }

  delete(id: string): boolean {
    return this.remove.run(id).changes > 0
  }

  /** TODO 1265: set (epoch ms) or clear (null) a reminder's snooze. False if the row is gone. */
  setSnooze(id: string, at: number | null): boolean {
    return this.snoozeStmt.run({ id, at }).changes > 0
  }

  /** TODO 629 / 628: disable a "once" row after it runs (or after it is skipped for being 24 hours or more overdue). Not deleted. */
  disable(id: string, now: number): void {
    this.disableStmt.run({ id, now })
  }

  /**
   * It started running. `advanceAnchor` is for a scheduled run (move the anchor to now). False for run-now.
   * TODO 725: if `countsTowardMax` is true, advance `run_count` by 1 (only runs of scheduled prompts.
   * The firing of a resume (628) is not counted - `JobScheduler.launchResume` calls it with false).
   */
  recordRun(id: string, now: number, advanceAnchor: boolean, countsTowardMax: boolean = false): void {
    this.markRun.run({ id, now, anchor: advanceAnchor ? now : null, increment: countsTowardMax ? 1 : 0 })
  }

  /** The result of a run. */
  recordResult(id: string, outcome: ScheduledJobOutcome, threadId: string | null, error: string | null): void {
    this.markResult.run({ id, outcome, thread_id: threadId, error })
  }

  /**
   * The previous run was still going, so this one was skipped. Only the anchor moves to now. `due` is the scheduled time of the skipped run **itself**
   * (TODO 351: kept in a column separate from `last_run_at`, so the list shows both).
   */
  recordSkip(id: string, now: number, due: number): void {
    this.markSkip.run({ id, now, due, outcome: 'skipped' })
  }

  /**
   * The time came, but it was a kind that this version cannot run (a plugin task, TODO 372). Like `recordSkip`, it moves
   * the anchor (one record however many runs came) and keeps that run's scheduled time in `last_skip_at`.
   */
  recordUnsupported(id: string, now: number, due: number): void {
    this.markSkip.run({ id, now, due, outcome: 'unsupported' })
  }

  /**
   * Align the table with plugins' declarations (`scheduledTasks`) (TODO 372). `declared` is **all installed plugins**
   * (enabled or not - merely disabling must not erase the user's time and enabled).
   *
   * - A task in the declaration but not in the table -> add it. **Disabled** (disabled when first installed, owner decision), with the declaration's default interval as its time.
   * - In both -> only the name is aligned to the declaration (the time, enabled and previous result belong to the user / the run).
   * - In the table but not in the declaration (the plugin was removed, or dropped from the declaration in a version bump) -> delete.
   */
  syncPluginTasks(
    declared: readonly { readonly pluginId: string; readonly tasks: readonly ScheduledTaskDeclaration[] }[],
    now: number
  ): { readonly added: number; readonly renamed: number; readonly removed: number } {
    const wanted = new Map<string, { pluginId: string; task: ScheduledTaskDeclaration }>()
    for (const plugin of declared) {
      for (const task of plugin.tasks) wanted.set(`${plugin.pluginId}\u0000${task.id}`, { pluginId: plugin.pluginId, task })
    }
    let added = 0
    let renamed = 0
    let removed = 0
    const seen = new Set<string>()
    for (const job of this.list()) {
      if (job.action.kind !== 'plugin') continue
      const key = `${job.action.pluginId}\u0000${job.action.taskId}`
      const entry = wanted.get(key)
      if (entry === undefined || seen.has(key)) {
        this.delete(job.id)
        removed += 1
        continue
      }
      seen.add(key)
      if (job.name !== entry.task.name) {
        this.rename.run({ id: job.id, name: entry.task.name, now })
        renamed += 1
      }
    }
    for (const [key, { pluginId, task }] of wanted) {
      if (seen.has(key)) continue
      this.create(
        {
          name: task.name,
          // TODO 952 stage 1: a "repeat while idle" task is enabled from installation (the plugin itself is disabled by default, and with no
          // credentials it does nothing). A task that runs by time is created disabled as before (372).
          enabled: task.idle === true,
          spec: { kind: 'interval', minutes: task.defaultInterval },
          action: { kind: 'plugin', pluginId, taskId: task.id }
        },
        now
      )
      added += 1
    }
    return { added, renamed, removed }
  }
}
