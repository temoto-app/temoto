/**
 * Deciding and starting scheduled runs (TODO 323 stage 1, ARCHITECTURE.md 6.2.4).
 *
 * Built like `ScanScheduler` (6.2.2, `src/index-kernel/scheduler.ts`): **independent of electron**.
 * The clock, the timer and the entry point that runs a job are injected, and tests call `tick()` directly with a fake clock
 * (`test/schedule.test.ts`). There are two differences:
 *
 * - **It does not depend on idle detection** - a scheduled prompt runs at its time even while the user is working (it is a separate thread, so
 *   the thread being worked on is not disturbed. Owner decision 2026-10-03).
 * - **It runs only while the app is running, and runs missed while it was stopped are caught up only once** (anacron style). The judgment is
 *   the single question "is the first scheduled time after the anchor (`anchorAt`) at or before now?", and the same expression covers right after startup, after sleep
 *   and the normal tick. When a job runs (or is skipped), the anchor moves to now, so however many runs were missed it is once.
 *
 * If the previous run of the same job is still going (responding, awaiting approval), this one is skipped. If the session count limit is hit,
 * it **waits instead of skipping** (the anchor does not move, so it is judged again at the next tick).
 *
 * Shutdown (12.9): `stop()` stops later ticks and returns only after runs that were about to start (creating a thread and sending) have
 * finished - `before-quit` closes the DB after that. `stopped` is never reset.
 * A plugin task (up to 5 minutes per call) is told to abort and waited for at most 5 seconds, and a result that arrives after return (`closed`) is not written (review 56-6).
 *
 * **A plugin's periodic task (`kind: 'plugin'`, TODO 372)** also rides on the same anchor (`anchorAt`) - not making a timer per plugin
 * is the benefit of "declare and aios calls". Rows are made from the declaration (`syncPluginTasks`) - the renderer cannot make them.
 * Since TODO 952 stage 1 (wave 56 bundle A) it **really calls**: `pluginTasks` (`PluginTaskInvoker`) starts plugin-host and calls
 * `tasks.<id>`. When `pluginTasks` is not passed (tests, an old setup), it is recorded as "unsupported" and skipped as before.
 * A task whose declaration has `idle: true` is "repeat while idle": it is called only while no conversation is running (`isIdle`), starting 2 minutes after startup, and
 * if `{ more: true }` is returned it is called again without waiting for the interval (the first full import). It is not called during `retryAfterMs` (429).
 *
 * **A reminder (`kind: 'reminder'`, TODO 1265)** rides on the same anchor and the same `decideJob`, but when it is due it only asks
 * `reminders` to show a desktop notification: no thread, no model, no CLI, and the session limit is not looked at. Its snooze is one more
 * time per row (`snooze_at`, independent of the repeat). Missed runs follow the existing rule: caught up once at startup / wake (marked late
 * when more than `REMINDER_LATE_MS` behind), and a "once" more than 24 hours overdue is skipped (629). A one-shot timer (`defer`) fires a
 * reminder or a snooze on time instead of waiting up to a tick; `stop()` cancels it.
 */
import { log } from '../../common/logger.js'
import {
  LATER_PREVIEW_CHARS,
  nextScheduleTime,
  ONCE_CATCH_UP_LIMIT_MS,
  isScheduleCompleted,
  REMINDER_LATE_MS,
  REMINDER_SNOOZE_MINUTES
} from '@shared/schedule.js'
import type {
  LaterAttachment,
  LaterInput,
  LaterSend,
  LaterSettings,
  LaterTaken,
  ScheduledJob,
  ScheduledJobInput,
  ScheduleOverview,
  ResumeReservation
} from '@shared/schedule.js'
import type { ScheduledTaskDeclaration } from '@shared/plugin.js'
import { reasonError } from '@shared/reason.js'
import {
  isPromptJob,
  isLaterJob,
  isReminderJob,
  isResumeJob,
  toJobInput,
  type ScheduledJobStore,
  type StoredJob,
  type StoredPromptJob,
  type StoredReminderJob,
  type StoredLaterAction,
  type StoredResumeAction
} from './store.js'

/** The judgment interval. The delay from the scheduled time is within this. */
export const SCHEDULE_TICK_MS = 30_000
/** TODO 628 (code-review): if a resume reservation's time has already passed, move it this far after now. */
export const RESUME_PAST_DELAY_MS = 5 * 60_000
/** TODO 989: if the time of a "send later" has already passed, move it this far after now. */
export const LATER_PAST_DELAY_MS = 60_000
/** TODO 989 (review): how many times a "send later" that could not be sent is automatically retried at the next ticks (when used up, it is left as a failure). */
export const LATER_AUTO_RETRIES = 3
/** TODO 952 stage 1: a "repeat while idle" task is not called until this long after startup (the same 2 minutes as 774's CLI auto-update). */
export const IDLE_TASK_START_DELAY_MS = 2 * 60_000
/** TODO 952 stage 1: the gap before calling again a task that returned `more` (without waiting for a tick). */
export const IDLE_TASK_CONTINUE_MS = 2_000

export type JobVerdict =
  | 'run'
  | 'not-due'
  | 'disabled'
  /** The previous run is still going. This run's schedule is skipped (the anchor moves). */
  | 'skip-running'
  /** The session count limit. Wait for the next tick instead of skipping. */
  | 'wait-room'
  /**
   * TODO 629: a "once" is 24 hours or more overdue (aios was stopped). It is skipped without running and the user is told
   * (`lastOutcome: 'skipped'`, shown the same way as 351) - and it is also disabled (a schedule that will never come is not left in the list).
   */
  | 'skip-too-late'
  /** TODO 952 stage 1: the schedule of a "repeat while idle" task came, but a conversation is running (or it is right after startup). Wait without moving the anchor. */
  | 'wait-idle'
  /** TODO 952 stage 1: the plugin is disabled or missing, or the task's declaration is gone. Wait without moving the anchor (it runs if it is enabled again). */
  | 'plugin-unavailable'

export interface JobVerdictInput {
  readonly job: Pick<StoredJob, 'enabled' | 'spec' | 'anchorAt'>
  readonly now: number
  /** The previous thread is responding or awaiting approval, or is being started. */
  readonly running: boolean
  /** Whether one more session can be started now. */
  readonly room: boolean
}

/** The judgment for one job (a pure function). */
export function decideJob(input: JobVerdictInput): JobVerdict {
  if (!input.job.enabled) return 'disabled'
  const due = nextScheduleTime(input.job.spec, input.job.anchorAt)
  if (due === null || due > input.now) return 'not-due'
  // TODO 629: a "once" that is 24 hours or more overdue is not run (other kinds catch up, anacron style as before).
  if (input.job.spec.kind === 'once' && input.now - due > ONCE_CATCH_UP_LIMIT_MS) return 'skip-too-late'
  if (input.running) return 'skip-running'
  if (!input.room) return 'wait-room'
  return 'run'
}

/** The entry point that runs a job (SessionManager starts a thread and sends). */
export interface JobRunner {
  /** Start a thread and send the prompt. Returns the id of the thread started. A failure throws. */
  run(job: StoredPromptJob): Promise<string>
  /**
   * TODO 628: send "continue" to an existing thread (no new thread is started). If it is responding,
   * `SessionManager.send` queues it as a reservation (item 94) - it does not wait here. A failure throws.
   */
  resume(threadId: string, prompt: string): Promise<void>
  /**
   * TODO 989: send one "send later" message through the same entry point as a normal send (`SessionManager.send`). Attachments are passed as
   * `LaterAttachment` - re-reading and re-checking at send time is up to the implementation (a changed file gives the new contents,
   * an unreadable one drops only that attachment). If it is responding, it is queued as a reservation (item 94). A failure throws.
   */
  sendLater(
    threadId: string,
    text: string,
    attachments: readonly LaterAttachment[],
    settings: LaterSettings
  ): Promise<void>
  /**
   * TODO 628 (code-review of wave 29): whether the thread still has the interrupted mark. A resume reservation checks this just before firing, and if
   * false (resumed by hand, the interruption cleared, or no such thread) it is deleted without sending.
   */
  isThreadInterrupted(threadId: string): boolean
  /** Whether the thread is still running (responding, awaiting approval, or in the middle of sending). */
  isThreadBusy(threadId: string): boolean
  /** Whether one more session can be started now (the limit is not hit, or one can be evicted). */
  hasRoom(): boolean
}

/** TODO 952 stage 1: the entry point that calls a plugin's periodic task (`PluginTaskInvoker`). */
export interface PluginTaskRunner {
  /** Whether it can be called now (the plugin is installed and enabled, and declares the task). */
  available(pluginId: string, taskId: string): boolean
  /** Call once. A failure throws. */
  run(
    pluginId: string,
    taskId: string,
    reason: 'scheduled' | 'idle' | 'manual'
  ): Promise<{ readonly more: boolean; readonly retryAfterMs: number | null }>
  /**
   * review 56-6: shutdown. Abort running calls (stop waiting for plugin-host and make them reject). Nothing is called afterwards.
   * If absent (a test fake), `JobScheduler.stop` just waits up to the limit.
   */
  shutdown?(): void
}

/** TODO 1265: one reminder notification to show. The title and body are the user's text - never logged. */
export interface ReminderShow {
  readonly jobId: string
  /** The job's name. */
  readonly title: string
  /** The optional body (may be empty). */
  readonly body: string
  /** The scheduled time when it is shown late (aios was stopped or the machine slept), otherwise null. */
  readonly lateSince: number | null
}

/** TODO 1265: the entry point that shows a reminder (`ReminderNotifier` in `notify.ts`, wired with electron's `Notification` in `index.ts`). */
export interface ReminderPresenter {
  show(reminder: ReminderShow): void
}

/**
 * review 56-6: the limit `stop()` waits for running plugin tasks. Waiting for the limit of one call (5 minutes) hit `before-quit`'s overall limit
 * (30 seconds) and ended with `app.exit(1)` without closing the DB.
 */
export const PLUGIN_TASK_STOP_WAIT_MS = 5_000

export interface JobSchedulerOptions {
  /** Whether to run on schedule. If false, no ticking (run-now and list editing still work). */
  readonly autoRun: boolean
  readonly now?: () => number
  readonly tickMs?: number
  /** For tests: its own timer. Calling the return value stops it. */
  readonly schedule?: (fn: () => void, ms: number) => () => void
  /** For tests: a one-shot timer (calls the continuation of `more` earlier than a tick). Calling the return value stops it. */
  readonly defer?: (fn: () => void, ms: number) => () => void
  /** The list changed (add, update, delete, run, result). Redraw if the settings screen is open. */
  readonly onChanged?: () => void
  /** TODO 983 stage 2: the user deleted a job. The entry point that deletes that job's row in the permission table. */
  readonly onJobRemoved?: (jobId: string) => void
  /** TODO 952 stage 1: the entry point that calls a plugin's periodic task. If absent, it is recorded as "unsupported" as before. */
  readonly pluginTasks?: PluginTaskRunner
  /** TODO 952 stage 1: whether no conversation is running (`SessionManager.activityBlocker() === null`). If absent, always idle. */
  readonly isIdle?: () => boolean
  /** review 56-6: the limit `stop()` waits for plugin tasks (default `PLUGIN_TASK_STOP_WAIT_MS`). Tests make it short. */
  readonly pluginStopWaitMs?: number
  /** TODO 1265: shows a reminder's notification. If absent (old tests), a due reminder is still recorded but nothing is shown. */
  readonly reminders?: ReminderPresenter
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

function defaultDefer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

/** The key of the declaration table (plugin id and task id). */
function taskKey(pluginId: string, taskId: string): string {
  return `${pluginId}\u0000${taskId}`
}

/** Turn an exception into the string kept in the list (a reason code as is, otherwise the message). */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** How it is shown in the list (only the start of the body, newlines turned into spaces). */
function laterView(
  id: string,
  action: StoredLaterAction,
  at: number,
  failure: { readonly failed: boolean; readonly error: string | null } = { failed: false, error: null }
): LaterSend {
  const flat = action.text.replace(/\s+/g, ' ').trim()
  const preview = flat.length > LATER_PREVIEW_CHARS ? `${flat.slice(0, LATER_PREVIEW_CHARS)}…` : flat
  return { id, threadId: action.threadId, at, preview, attachments: action.attachments.length, ...failure }
}

export class JobScheduler {
  private readonly now: () => number
  private readonly tickMs: number
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly onChanged: (() => void) | null
  private cancel: (() => void) | null = null
  /** Shutdown has begun. Never reset (12.9). */
  private stopped = false
  /**
   * review 56-6: `stop()` has returned (`before-quit` closes the DB after this). Results of plugin tasks that arrive after this are not written.
   * A flag separate from `stopped` (no more ticking and no new starts) - a result that arrives while `stop()` is waiting may be written.
   */
  private closed = false
  /** Runs in the middle of starting (job id -> a Promise of completion). `stop()` waits for them. */
  private readonly inFlight = new Map<string, Promise<void>>()
  /** review 56-6: of `inFlight`, the runs of plugin tasks (job id). `stop()` waits for these only up to a limit. */
  private readonly pluginInFlight = new Set<string>()
  /**
   * TODO 628 (code-review): the resume reservations being sent now (job id). Sending the reservation itself synchronously calls `SessionManager`'s
   * `threadResumed`, so they are excluded so that `cancelResumeFor` does not delete that reservation.
   */
  private readonly firingResume = new Set<string>()
  /** TODO 989 (review): how many times sending a "send later" failed (job id -> count, in memory only). */
  private readonly laterFailures = new Map<string, number>()
  /** TODO 952 stage 1: tasks declared as "repeat while idle" (`taskKey`). Built by `syncPluginTasks`. */
  private idleTasks = new Set<string>()
  /** TODO 952 stage 1: plugin jobs whose previous call returned `more` (continue without waiting for the interval). In memory only. */
  private readonly continuing = new Set<string>()
  /** TODO 952 stage 1: not called until this time (`retryAfterMs`). Job id -> epoch ms. In memory only. */
  private readonly retryAt = new Map<string, number>()
  /** TODO 952 stage 1: the time ticking started (for the judgment of 2 minutes after startup). */
  private startedAt: number | null = null
  private cancelDefer: (() => void) | null = null
  /** TODO 1265: the one-shot timer that fires the nearest reminder / snooze on time (cancelled by `stop()`). */
  private cancelReminderTimer: (() => void) | null = null
  private readonly defer: (fn: () => void, ms: number) => () => void

  constructor(
    private readonly store: ScheduledJobStore,
    private readonly runner: JobRunner,
    private readonly options: JobSchedulerOptions
  ) {
    this.now = options.now ?? Date.now
    this.tickMs = options.tickMs ?? SCHEDULE_TICK_MS
    this.schedule = options.schedule ?? defaultSchedule
    this.defer = options.defer ?? defaultDefer
    this.onChanged = options.onChanged ?? null
  }

  get autoRun(): boolean {
    return this.options.autoRun
  }

  /** Start ticking and judge the startup catch-up once. Does nothing if `autoRun` is false. */
  start(): void {
    if (!this.options.autoRun || this.stopped || this.cancel !== null) return
    // TODO 989 (review): a "send later" that started sending and then died is shown in the list as a failure (once, before ticking).
    const interrupted = this.store.failInterruptedLater()
    if (interrupted > 0) log.warn('schedule.later.interrupted', { count: interrupted })
    this.startedAt = this.now()
    this.cancel =this.schedule(() => this.tick(), this.tickMs)
    this.tick()
  }

  /**
   * The judgment after waking from sleep (`resume` of `powerMonitor`). Judge once without waiting for a tick (once however many runs were missed).
   * TODO 1120: if `autoRun` is false (a `--user-data-dir` copy, `AIOS_DISABLE_AGENT`) do nothing - the same reason `start()` does not tick
   * (a copied job must not run twice with the real CLI, item 186). It does not look at `tick()` (tests and the continuation of run-now call it directly).
   */
  wake(): void {
    if (!this.options.autoRun) return
    this.tick()
  }

  /**
   * Shutdown. Stop ticking and wait for runs that are being started.
   * review 56-6: plugin tasks are told to abort (`pluginTasks.shutdown`) and waited for at most `pluginStopWaitMs` (default 5 seconds).
   * A result that arrives after return is not written (`closed`). Scheduled-prompt runs (creating a thread and sending) are still waited for until they finish, as before.
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.cancel?.()
    this.cancel = null
    this.cancelDefer?.()
    this.cancelDefer = null
    this.cancelReminderTimer?.()
    this.cancelReminderTimer = null
    try {
      this.options.pluginTasks?.shutdown?.()
    } catch (err) {
      log.warn('schedule.pluginTask.shutdownFailed', { error: errorText(err) })
    }
    const prompts: Promise<void>[] = []
    const plugins: Promise<void>[] = []
    for (const [id, done] of this.inFlight) (this.pluginInFlight.has(id) ? plugins : prompts).push(done)
    let timer: ReturnType<typeof setTimeout> | undefined
    const pluginsDone = Promise.allSettled(plugins).then(() => true)
    const capped =
      plugins.length === 0
        ? Promise.resolve(true)
        : Promise.race([
            pluginsDone,
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), this.options.pluginStopWaitMs ?? PLUGIN_TASK_STOP_WAIT_MS)
            })
          ])
    const [, settled] = await Promise.all([Promise.allSettled(prompts), capped])
    if (timer !== undefined) clearTimeout(timer)
    if (!settled) log.warn('schedule.pluginTask.stopTimeout', { running: plugins.length })
    this.closed = true
  }

  /**
   * TODO 351 (351-2): make the list get pushed even when it was not caused by `JobScheduler`'s own operations (`launch` / edit).
   * Call it when a job thread's turn ended or the process died (events on the `SessionManager` side) -
   * `running` is a value computed only by looking at `SessionManager.isThreadBusy`, and since its home is on
   * the `SessionManager` side, our own operations alone cannot catch the change.
   */
  refresh(): void {
    if (this.stopped) return
    this.onChanged?.()
  }

  /** Whether that job is still running (including being started). */
  private isRunning(job: StoredJob): boolean {
    if (this.inFlight.has(job.id)) return true
    return job.lastThreadId !== null && this.runner.isThreadBusy(job.lastThreadId)
  }

  /**
   * The judgment for one round. Called from the timer, right after startup and after sleep (`wake`, TODO 1120); tests call it directly.
   * The return value is job id -> verdict (for logs and tests).
   */
  tick(): ReadonlyMap<string, JobVerdict> {
    const verdicts = new Map<string, JobVerdict>()
    if (this.stopped) return verdicts
    const now = this.now()
    let changed = false
    for (const job of this.store.list()) {
      if (this.options.pluginTasks !== undefined && job.action.kind === 'plugin') {
        // TODO 952 stage 1: a plugin task has a separate judgment (idle, continuation, wait time, whether the plugin exists).
        const verdict = this.tickPluginJob(job, job.action, now)
        verdicts.set(job.id, verdict)
        if (verdict === 'run') changed = true
        continue
      }
      if (isReminderJob(job)) {
        // TODO 1265: a notification only. Never reaches the runner (no thread, no model) and ignores the session limit.
        const result = this.tickReminder(job, now)
        verdicts.set(job.id, result.verdict)
        if (result.changed) changed = true
        continue
      }
      let verdict = decideJob({
        job,
        now,
        running: this.isRunning(job),
        // The limit is judged only just before running (not counted every time).
        room: true
      })
      // TODO 989: a "send later" is a message the user wrote, so however overdue it is, it is caught up and sent at startup
      // (the rule of 629 that discards after 24 hours is only for the fixed resume and a scheduled "once").
      if (verdict === 'skip-too-late' && isLaterJob(job)) verdict = 'run'
      if (verdict === 'run' && isLaterJob(job)) {
        verdicts.set(job.id, verdict)
        this.fireLater(job.id, job.action, now)
        changed = true
        continue
      }
      if (verdict === 'skip-too-late') {
        // TODO 629: a "once" that is 24 hours or more overdue. Skip it and tell the user (`lastOutcome: 'skipped'`, the same as 351), and
        // disable it since it is a schedule that will never come.
        const due = nextScheduleTime(job.spec, job.anchorAt)
        this.store.recordSkip(job.id, now, due ?? now)
        this.store.disable(job.id, now)
        verdicts.set(job.id, verdict)
        log.info('schedule.skipped', { jobId: job.id, reason: 'too-late' })
        changed = true
        continue
      }
      if (verdict === 'run' && isResumeJob(job)) {
        // TODO 628: a resume of an existing thread. Unrelated to the session limit (`SessionManager.send` handles it on its own -
        // item 94's reservation). It is a "once", so it is disabled right after it is started.
        verdicts.set(job.id, verdict)
        this.fireResume(job.id, job.action, now)
        changed = true
        continue
      }
      if (verdict === 'run' && !isPromptJob(job)) {
        // TODO 372: plugin tasks are not run in this version. Unrelated to the session limit (the CLI is not started).
        verdicts.set(job.id, verdict)
        this.recordUnsupported(job, now, nextScheduleTime(job.spec, job.anchorAt) ?? now)
        changed = true
        continue
      }
      const final = verdict === 'run' && !this.runner.hasRoom() ? 'wait-room' : verdict
      verdicts.set(job.id, final)
      if (final === 'skip-running') {
        // TODO 351: keep separately the scheduled time (due) of the skipped run itself, so that "previous" (the run that ran) and "skipped"
        // do not point to different runs. The same computation as decideJob (a pure function, no side effects).
        const due = nextScheduleTime(job.spec, job.anchorAt)
        this.store.recordSkip(job.id, now, due ?? now)
        log.info('schedule.skipped', { jobId: job.id, reason: 'running' })
        changed = true
      } else if (final === 'wait-room') {
        log.info('schedule.waiting', { jobId: job.id, reason: 'concurrency' })
      } else if (final === 'run' && isPromptJob(job)) {
        this.launch(job, now, true)
        // TODO 629: a "once" is disabled right after it runs (not deleted - the previous run and history stay in the list).
        // TODO 725: when the run count limit is used up, it is disabled the same way (the list shows "Done (N/N)").
        if (job.spec.kind === 'once') this.store.disable(job.id, now)
        else this.store.disableIfMaxRunsReached(job.id, now)
        changed = true
      }
    }
    if (changed) this.onChanged?.()
    this.armReminderTimer()
    return verdicts
  }

  /**
   * TODO 1265: the judgment for one reminder row. A due snooze is shown first (even if the row is disabled - a used-up "once" that was snoozed),
   * then the repeat itself is judged with the same `decideJob` as a scheduled prompt (the anchor, catch-up once, 629's 24 hours).
   */
  private tickReminder(job: StoredReminderJob, now: number): { verdict: JobVerdict; changed: boolean } {
    let changed = false
    if (job.snoozeAt !== null && job.snoozeAt <= now) {
      this.store.setSnooze(job.id, null)
      changed = true
      // A snooze that came due while aios was stopped for more than a day is dropped (the same limit as 629's "once").
      if (now - job.snoozeAt > ONCE_CATCH_UP_LIMIT_MS) log.info('schedule.reminder.snoozeDropped', { jobId: job.id })
      else this.showReminder(job, job.snoozeAt, now, 'snooze')
    }
    const verdict = decideJob({ job, now, running: false, room: true })
    if (verdict === 'skip-too-late') {
      // TODO 629: a "once" more than 24 hours overdue is not shown; it is recorded as skipped (the list and the activity bar's dot say so).
      const due = nextScheduleTime(job.spec, job.anchorAt)
      this.store.recordSkip(job.id, now, due ?? now)
      this.store.disable(job.id, now)
      log.info('schedule.skipped', { jobId: job.id, reason: 'too-late' })
      return { verdict, changed: true }
    }
    if (verdict !== 'run') return { verdict, changed }
    const due = nextScheduleTime(job.spec, job.anchorAt) ?? now
    // Counted toward the run-count limit (725), like a scheduled prompt's run.
    this.store.recordRun(job.id, now, true, true)
    this.showReminder(job, due, now, 'scheduled')
    if (job.spec.kind === 'once') this.store.disable(job.id, now)
    else this.store.disableIfMaxRunsReached(job.id, now)
    return { verdict, changed: true }
  }

  /** TODO 1265: ask the presenter to show the notification. The title and body are not logged (only the id and whether it is late). */
  private showReminder(
    job: StoredReminderJob,
    due: number,
    now: number,
    source: 'scheduled' | 'snooze' | 'manual'
  ): void {
    const lateSince = now - due > REMINDER_LATE_MS ? due : null
    log.info('schedule.reminder.shown', { jobId: job.id, source, late: lateSince !== null })
    try {
      this.options.reminders?.show({ jobId: job.id, title: job.name, body: job.action.body, lateSince })
    } catch (err) {
      log.warn('schedule.reminder.showFailed', { jobId: job.id, error: errorText(err) })
    }
  }

  /**
   * TODO 1265: fire the nearest reminder or snooze on time instead of up to a tick (30 s) late. Only one timer; re-armed after every tick and
   * every change. Only while ticking automatically (`start()` ran and `stop()` did not).
   */
  private armReminderTimer(): void {
    this.cancelReminderTimer?.()
    this.cancelReminderTimer = null
    if (this.stopped || !this.options.autoRun || this.cancel === null) return
    const now = this.now()
    let next: number | null = null
    for (const job of this.store.list()) {
      if (!isReminderJob(job)) continue
      if (job.snoozeAt !== null) next = next === null ? job.snoozeAt : Math.min(next, job.snoozeAt)
      if (!job.enabled) continue
      const due = nextScheduleTime(job.spec, job.anchorAt)
      if (due !== null) next = next === null ? due : Math.min(next, due)
    }
    // A time further away than a tick is picked up by a later tick, which re-arms this.
    if (next === null || next - now >= this.tickMs) return
    this.cancelReminderTimer = this.defer(() => {
      this.cancelReminderTimer = null
      this.tick()
    }, Math.max(0, next - now))
  }

  /**
   * TODO 1265: snooze a reminder - notify again `minutes` from now (one of `REMINDER_SNOOZE_MINUTES`). Replaces an earlier snooze of the same row.
   * Independent of the repeat (the anchor and the next scheduled time do not move). Called from the notification's buttons and the editor.
   */
  snooze(id: string, minutes: number): void {
    if (this.stopped) return
    if (!REMINDER_SNOOZE_MINUTES.includes(minutes)) throw reasonError('invalid-value', { field: 'minutes' })
    const job = this.store.get(id)
    if (job === null || !isReminderJob(job)) throw reasonError('schedule-job-not-found')
    this.store.setSnooze(id, this.now() + minutes * 60_000)
    log.info('schedule.reminder.snoozed', { jobId: id, minutes })
    this.onChanged?.()
    this.armReminderTimer()
  }

  /** TODO 1265: cancel a reminder's pending snooze (no-op when there is none). */
  cancelSnooze(id: string): void {
    if (this.stopped) return
    const job = this.store.get(id)
    if (job === null || !isReminderJob(job)) throw reasonError('schedule-job-not-found')
    if (job.snoozeAt === null) return
    this.store.setSnooze(id, null)
    log.info('schedule.reminder.snoozeCancelled', { jobId: id })
    this.onChanged?.()
    this.armReminderTimer()
  }

  /** Run now (the settings screen button). The schedule anchor does not move. Refused if the previous run is going. */
  runNow(id: string): void {
    if (this.stopped) return
    const job = this.store.get(id)
    if (job === null || isLaterJob(job)) throw reasonError('schedule-job-not-found')
    if (isReminderJob(job)) {
      // TODO 1265: "Test" - show the notification now. Not recorded and not counted: a one-time reminder is not used up by trying it.
      this.showReminder(job, this.now(), this.now(), 'manual')
      return
    }
    if (this.isRunning(job)) throw reasonError('schedule-job-running')
    // TODO 655-1: a used-up "once" was still run by runNow even after it was disabled
    // (unlike tick() it did not look at enabled). Do not let it run again.
    if (job.spec.kind === 'once' && !job.enabled) throw reasonError('schedule-once-used')
    // Code-review of TODO 725: runNow also ran a row whose run count limit was used up ("Done (N/N)").
    if (isScheduleCompleted(job)) throw reasonError('schedule-max-runs-used')
    const now = this.now()
    if (isPromptJob(job)) {
      this.launch(job, now, false)
      // TODO 629: even with run-now, a "once" counts as used up (it cannot be run-now again).
      // TODO 725: run-now also counts toward the run count. When used up, it is disabled the same way.
      if (job.spec.kind === 'once') this.store.disable(job.id, now)
      else this.store.disableIfMaxRunsReached(job.id, now)
    } else if (isResumeJob(job)) {
      this.fireResume(job.id, job.action, now)
    } else if (this.options.pluginTasks !== undefined && job.action.kind === 'plugin') {
      // TODO 952 stage 1: run-now does not wait for idle (the user pressed it).
      if (!this.options.pluginTasks.available(job.action.pluginId, job.action.taskId)) {
        throw reasonError('schedule-plugin-unavailable')
      }
      this.launchPluginTask(job, job.action, now, 'manual', false)
    } else this.recordUnsupported(job, now, now)
    this.onChanged?.()
  }

  /**
   * TODO 952 stage 1: the judgment for one plugin task row.
   * - It is due when "the first scheduled time after the anchor is at or before now" (the same expression as a scheduled prompt), or the previous call returned `more` (a continuation).
   * - Not called during `retryAfterMs`. If the previous call is still going, nothing is done this time (and nothing recorded - these are short jobs, and recording on every tick would be noisy).
   * - If it declares `idle`, wait without moving the anchor until 2 minutes after startup and while a conversation is running.
   * - If the plugin is disabled or missing (the declaration is gone), wait without moving the anchor.
   */
  private tickPluginJob(
    job: StoredJob,
    action: { readonly pluginId: string; readonly taskId: string },
    now: number
  ): JobVerdict {
    const runner = this.options.pluginTasks
    if (runner === undefined || !job.enabled) return 'disabled'
    if (this.inFlight.has(job.id)) return 'skip-running'
    const retryAt = this.retryAt.get(job.id)
    if (retryAt !== undefined && retryAt > now) return 'not-due'
    const continuing = this.continuing.has(job.id)
    if (!continuing) {
      const due = nextScheduleTime(job.spec, job.anchorAt)
      if (due === null || due > now) return 'not-due'
    }
    if (this.idleTasks.has(taskKey(action.pluginId, action.taskId))) {
      if (this.startedAt === null || now - this.startedAt < IDLE_TASK_START_DELAY_MS) return 'wait-idle'
      if (!(this.options.isIdle?.() ?? true)) return 'wait-idle'
    }
    if (!runner.available(action.pluginId, action.taskId)) return 'plugin-unavailable'
    this.launchPluginTask(job, action, now, continuing ? 'idle' : 'scheduled', true)
    // If it was changed to "once", it is disabled after it runs (the same as a scheduled prompt). A continuation round is not counted.
    if (!continuing && job.spec.kind === 'once') this.store.disable(job.id, now)
    return 'run'
  }

  /** TODO 952 stage 1: call a plugin task (not awaited). The result is kept in the table, and `more` / `retryAfterMs` are remembered. */
  private launchPluginTask(
    job: StoredJob,
    action: { readonly pluginId: string; readonly taskId: string },
    now: number,
    reason: 'scheduled' | 'idle' | 'manual',
    advanceAnchor: boolean
  ): void {
    const runner = this.options.pluginTasks
    if (runner === undefined) return
    this.continuing.delete(job.id)
    this.retryAt.delete(job.id)
    this.store.recordRun(job.id, now, advanceAnchor)
    log.info('schedule.pluginTask.run', { jobId: job.id, pluginId: action.pluginId, taskId: action.taskId, reason })
    let started: Promise<{ readonly more: boolean; readonly retryAfterMs: number | null }>
    try {
      started = runner.run(action.pluginId, action.taskId, reason)
    } catch (err) {
      started = Promise.reject(err)
    }
    const done = started
      .then(
        (outcome) => {
          // review 56-6: do not write after `stop()` has returned (the DB is closing or closed).
          if (this.closed) return
          this.store.recordResult(job.id, 'started', null, null)
          if (outcome.retryAfterMs !== null) this.retryAt.set(job.id, this.now() + outcome.retryAfterMs)
          if (outcome.more) {
            this.continuing.add(job.id)
            const wait = outcome.retryAfterMs ?? IDLE_TASK_CONTINUE_MS
            // For a wait shorter than a tick, call without waiting for the tick. A long wait is picked up by the tick.
            if (wait <= this.tickMs) this.continueSoon(wait)
          }
        },
        (err: unknown) => {
          // review 56-6: a run cut off at shutdown is not a plugin failure, so it is not recorded (the next startup calls it at the normal interval).
          // After `closed`, nothing is written to the DB anyway.
          if (this.stopped) {
            log.info('schedule.pluginTask.interrupted', { jobId: job.id, pluginId: action.pluginId, taskId: action.taskId })
            return
          }
          log.warn('schedule.pluginTask.failed', {
            jobId: job.id,
            pluginId: action.pluginId,
            taskId: action.taskId,
            error: errorText(err)
          })
          this.store.recordResult(job.id, 'failed', null, errorText(err))
        }
      )
      .finally(() => {
        this.inFlight.delete(job.id)
        this.pluginInFlight.delete(job.id)
        if (!this.stopped) this.onChanged?.()
      })
    this.inFlight.set(job.id, done)
    this.pluginInFlight.add(job.id)
  }

  /** Judge the continuation of `more` earlier than a tick (only while ticking automatically). */
  private continueSoon(ms: number): void {
    if (this.stopped || !this.options.autoRun || this.cancel === null) return
    this.cancelDefer?.()
    this.cancelDefer = this.defer(() => {
      this.cancelDefer = null
      this.tick()
    }, ms)
  }

  /**
   * TODO 952 stage 1: wake that plugin's tasks as a "continuation" (for example right after login). Remove the interval and wait time, and
   * call at the next judgment (the idle condition stays as it is).
   */
  wakePluginTasks(pluginId: string): void {
    if (this.stopped) return
    let woke = 0
    for (const job of this.store.list()) {
      if (job.action.kind !== 'plugin' || job.action.pluginId !== pluginId || !job.enabled) continue
      this.continuing.add(job.id)
      this.retryAt.delete(job.id)
      woke += 1
    }
    if (woke > 0) this.continueSoon(0)
  }

  /** Record a plugin task's run as "unsupported" (TODO 372, until Phase 5). The anchor moves. */
  private recordUnsupported(job: StoredJob, now: number, due: number): void {
    this.store.recordUnsupported(job.id, now, due)
    const action = job.action.kind === 'plugin' ? job.action : null
    log.info('schedule.unsupported', { jobId: job.id, pluginId: action?.pluginId, taskId: action?.taskId })
  }

  /** Start a thread and send (not awaited). The result is kept in the table. TODO 725: counted as a run that actually ran. */
  private launch(job: StoredPromptJob, now: number, scheduled: boolean): void {
    this.store.recordRun(job.id, now, scheduled, true)
    log.info('schedule.run', { jobId: job.id, scheduled })
    const done = this.runner
      .run(job)
      .then(
        (threadId) => {
          this.store.recordResult(job.id, 'started', threadId, null)
        },
        (err: unknown) => {
          log.warn('schedule.run.failed', { jobId: job.id, error: errorText(err) })
          this.store.recordResult(job.id, 'failed', null, errorText(err))
        }
      )
      .finally(() => {
        this.inFlight.delete(job.id)
        if (!this.stopped) this.onChanged?.()
      })
    this.inFlight.set(job.id, done)
  }

  /**
   * TODO 628: send "continue" to an existing thread (not awaited). Only `recordRun` is kept - unlike `run`,
   * the `threadId` of `recordResult` is already known (`action.threadId`; no new thread is started).
   */
  /**
   * TODO 628 (code-review): just before firing, check "is it still interrupted?". If not (resumed by hand, or the interruption
   * cleared), delete it without sending. If still interrupted, send it, and disable it since it is a "once".
   */
  private fireResume(jobId: string, action: StoredResumeAction, now: number): void {
    if (!this.runner.isThreadInterrupted(action.threadId)) {
      this.store.delete(jobId)
      log.info('schedule.resume.dropped', { jobId, threadId: action.threadId, reason: 'not-interrupted' })
      return
    }
    this.launchResume(jobId, action, now)
    this.store.disable(jobId, now)
  }

  /**
   * TODO 989: firing a "send later". It is a "once", so first disable it so it is not sent twice. **The row is deleted only when it was sent.**
   * A failure (the thread is gone, it is not yet in a state to be sent, etc.) is not silently dropped: it is automatically retried up to `LATER_AUTO_RETRIES` times at the next
   * ticks, and when used up it is left with a "failed" mark - it shows in the list and the user chooses "send again" or "put back in the input box"
   * (`retryLater` / `takeLater`).
   */
  private fireLater(jobId: string, action: StoredLaterAction, now: number): void {
    // The anchor is not moved: for a "once", once the anchor passes the schedule there is no schedule left, and the failed row would vanish from the list.
    this.store.recordRun(jobId, now, false)
    this.store.disable(jobId, now)
    log.info('schedule.later.run', { jobId, threadId: action.threadId, attachments: action.attachments.length })
    let started: Promise<void>
    try {
      started = this.runner.sendLater(action.threadId, action.text, action.attachments, action.settings ?? {})
    } catch (err) {
      started = Promise.reject(err)
    }
    const done = started
      .then(
        () => {
          this.laterFailures.delete(jobId)
          this.store.delete(jobId)
        },
        (err: unknown) => {
          const failures = (this.laterFailures.get(jobId) ?? 0) + 1
          this.laterFailures.set(jobId, failures)
          const retry = failures <= LATER_AUTO_RETRIES && !this.stopped
          log.warn('schedule.later.failed', { jobId, threadId: action.threadId, failures, retry, error: errorText(err) })
          if (retry) this.store.reenableLater(jobId, this.now())
          else this.store.recordResult(jobId, 'failed', null, errorText(err))
        }
      )
      .finally(() => {
        this.inFlight.delete(jobId)
        if (!this.stopped) this.onChanged?.()
      })
    this.inFlight.set(jobId, done)
  }

  /**
   * TODO 989: the Composer's "send later". Put the body and attachments into a reservation that sends once at `at`. Any number can be
   * placed on the same thread. A time in the past (or now) is moved to now + 1 minute.
   */
  reserveLater(threadId: string, input: LaterInput): LaterSend {
    const now = this.now()
    const effective = input.at > now ? input.at : now + LATER_PAST_DELAY_MS
    const settings: LaterSettings = {
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
      ...(input.settingsScope === undefined ? {} : { settingsScope: input.settingsScope })
    }
    const job = this.store.createLater(threadId, input.text, input.attachments, effective, now, settings)
    log.info('schedule.later.reserved', { jobId: job.id, threadId, attachments: input.attachments.length })
    this.onChanged?.()
    return laterView(job.id, job.action as StoredLaterAction, effective)
  }

  /** TODO 989: the "send later" reservations that are active now (earliest time first). */
  laterSends(): readonly LaterSend[] {
    const result: LaterSend[] = []
    for (const job of this.store.list()) {
      if (!isLaterJob(job)) continue
      const failed = !job.enabled && job.lastOutcome === 'failed'
      // Those that started sending (disabled with an empty result) are not shown. Those that could not be sent (failed) are kept and shown.
      if (!job.enabled && !failed) continue
      const at = nextScheduleTime(job.spec, job.anchorAt)
      if (at === null) continue
      result.push(laterView(job.id, job.action, at, { failed, error: failed ? job.lastError : null }))
    }
    return result.sort((a, b) => a.at - b.at)
  }

  /** TODO 989 (review): send a reservation that could not be sent again (at the next tick. The count of automatic retries is also reset). */
  retryLater(id: string): void {
    const job = this.store.get(id)
    if (this.stopped || job === null || !isLaterJob(job) || job.enabled || job.lastOutcome !== 'failed') return
    this.laterFailures.delete(id)
    this.store.reenableLater(id, this.now())
    log.info('schedule.later.retry', { jobId: id })
    this.onChanged?.()
    if (this.options.autoRun) this.tick()
  }

  /**
   * TODO 989 (review): return the contents of a reservation and delete the row (to put back in the input box). One that is being sent is not returned.
   */
  takeLater(id: string): LaterTaken | null {
    const job = this.store.get(id)
    if (job === null || !isLaterJob(job) || this.inFlight.has(id)) return null
    this.laterFailures.delete(id)
    this.store.delete(id)
    this.onChanged?.()
    const { text, attachments, settings } = job.action
    return { text, attachments, ...(settings ?? {}) }
  }

  private launchResume(jobId: string, action: StoredResumeAction, now: number): void {
    this.store.recordRun(jobId, now, true)
    log.info('schedule.resume.run', { jobId, threadId: action.threadId })
    this.firingResume.add(jobId)
    let started: Promise<void>
    try {
      started = this.runner.resume(action.threadId, action.prompt)
    } finally {
      // It only needs to be excluded during the `threadResumed` that the reservation's own send calls synchronously (afterwards it is disabled).
      this.firingResume.delete(jobId)
    }
    const done = started
      .then(
        () => {
          this.store.recordResult(jobId, 'started', action.threadId, null)
        },
        (err: unknown) => {
          log.warn('schedule.resume.failed', { jobId, error: errorText(err) })
          this.store.recordResult(jobId, 'failed', null, errorText(err))
        }
      )
      .finally(() => {
        this.inFlight.delete(jobId)
        if (!this.stopped) this.onChanged?.()
      })
    this.inFlight.set(jobId, done)
  }

  /**
   * TODO 628: after the usage limit is lifted, reserve a one-time resume send to this thread. `at` is the time to send
   * (the caller computes "lift + 5 minutes" - the fixed margin is not decided here). A previous reservation for the same thread is
   * replaced. The return value is this thread's new reservation (one entry of `resumeReservations`).
   */
  reserveResume(threadId: string, prompt: string, at: number): ResumeReservation {
    const now = this.now()
    // Code-review of wave 29: if the lift time has already passed (a stale usage badge, clock skew), `nextScheduleTime` returns
    // null and it never runs but stays enabled. A past (or now) time is moved to now + 5 minutes (the same margin as lift + 5 minutes).
    const effective = at > now ? at : now + RESUME_PAST_DELAY_MS
    const job = this.store.createResume(threadId, prompt, effective, now)
    log.info('schedule.resume.reserved', { jobId: job.id, threadId, clamped: effective !== at })
    this.onChanged?.()
    return { id: job.id, threadId, at: effective }
  }

  /**
   * TODO 628 (code-review of wave 29): delete this thread's resume reservation. main calls it when the user sent by hand, resumed, or the interruption
   * cleared (`SessionManager`'s `threadResumed`) - the renderer's ResumeBar row disappears when the interruption clears and the cancel button goes with it,
   * so leaving it would later send a duplicate "continue". The reservation being sent now is excluded.
   */
  cancelResumeFor(threadId: string): void {
    if (this.stopped) return
    let removed = 0
    for (const job of this.store.list()) {
      if (!isResumeJob(job) || !job.enabled || job.action.threadId !== threadId) continue
      if (this.firingResume.has(job.id)) continue
      if (this.store.delete(job.id)) removed += 1
    }
    if (removed === 0) return
    log.info('schedule.resume.cancelled', { threadId, removed })
    this.onChanged?.()
  }

  // ---- List editing (settings screen) ----

  /** TODO 628: not shown in the list (`ResumeBar`'s own row is where it is shown). */
  resumeReservations(): readonly ResumeReservation[] {
    const result: ResumeReservation[] = []
    for (const job of this.store.list()) {
      if (!isResumeJob(job) || !job.enabled) continue
      const at = nextScheduleTime(job.spec, job.anchorAt)
      if (at === null) continue
      result.push({ id: job.id, threadId: job.action.threadId, at })
    }
    return result
  }

  /**
   * The job's next schedule (epoch ms). null if disabled, gone, or it will never come. TODO 959: used for the approval deadline of an unattended turn
   * (rejected if there is no answer by the next schedule) - the same expression as the list's `nextRunAt`.
   */
  nextRunAt(id: string): number | null {
    const job = this.store.get(id)
    if (job === null || !job.enabled) return null
    return nextScheduleTime(job.spec, job.anchorAt)
  }

  /**
   * TODO 1270: whether something is scheduled that a sleeping machine would miss: an enabled row, except an "idle repeat" plugin task (those run only while
   * the user is around, so they are no reason to keep the machine awake). False when this instance does not run on schedule (a copy) or has stopped.
   */
  hasUpcomingWork(): boolean {
    if (!this.options.autoRun || this.stopped) return false
    // TODO 1265: a reminder counts like any job, and a pending snooze counts even on a disabled row (a used-up "once" that was snoozed).
    return this.store
      .list()
      .some(
        (job) =>
          (isReminderJob(job) && job.snoozeAt !== null) ||
          (job.enabled &&
            !(job.action.kind === 'plugin' && this.idleTasks.has(taskKey(job.action.pluginId, job.action.taskId))))
      )
  }

  /** TODO 1251: whether the job exists now (scheduled, resume and send later, all). Used at startup to sweep permission rows of jobs that were deleted. */
  hasJob(id: string): boolean {
    // Only the presence of a row is looked at. A row whose spec / action cannot be parsed (for example after a downgrade) also "exists" (the permission is not deleted).
    return this.store.has(id)
  }

  /** TODO 983: the job's name (null if gone). Used as the display name of the role (`job:<jobId>`) of the conversation the job started. */
  jobName(id: string): string | null {
    return this.store.get(id)?.name ?? null
  }

  overview(): ScheduleOverview {
    return {
      jobs: this.store.list().filter((job) => !isResumeJob(job) && !isLaterJob(job)).map((job) => this.view(job)),
      autoRun: this.options.autoRun,
      resumeReservations: this.resumeReservations(),
      laterSends: this.laterSends()
    }
  }

  private view(job: StoredJob): ScheduledJob {
    return {
      ...toJobInput(job),
      id: job.id,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      lastRunAt: job.lastRunAt,
      lastThreadId: job.lastThreadId,
      lastOutcome: job.lastOutcome,
      lastError: job.lastError,
      lastSkipAt: job.lastSkipAt,
      nextRunAt: job.enabled ? nextScheduleTime(job.spec, job.anchorAt) : null,
      running: this.isRunning(job),
      // TODO 725: `maxRuns` of `toJobInput` carries `| undefined` in its type (because it is optional in
      // `ScheduledJobInput`). Make it explicit again with `StoredJob.maxRuns` (which always has a value).
      maxRuns: job.maxRuns,
      runCount: job.runCount,
      snoozedUntil: isReminderJob(job) ? job.snoozeAt : null
    }
  }

  create(input: ScheduledJobInput): ScheduleOverview {
    // A plugin task's row is made only from the declaration (`syncPluginTasks`). It cannot be made from the renderer (TODO 372).
    // TODO 1265: a reminder can be made by the user, like a scheduled prompt.
    if (input.action.kind !== 'prompt' && input.action.kind !== 'reminder') {
      throw reasonError('invalid-value', { field: 'action' })
    }
    const job = this.store.create(input, this.now())
    log.info('schedule.created', { jobId: job.id, kind: job.spec.kind, action: job.action.kind, enabled: job.enabled })
    this.onChanged?.()
    this.armReminderTimer()
    return this.overview()
  }

  update(id: string, input: ScheduledJobInput): ScheduleOverview {
    const current = this.store.get(id)
    if (current === null) throw reasonError('schedule-job-not-found')
    if (current.action.kind !== input.action.kind) throw reasonError('invalid-value', { field: 'action' })
    // For a plugin task, the user can change only the time and enabled. The name and contents stay as declared (table) (TODO 372).
    const accepted: ScheduledJobInput =
      current.action.kind === 'plugin' ? { ...toJobInput(current), spec: input.spec, enabled: input.enabled } : input
    const job = this.store.updateJob(id, accepted, this.now())
    if (job === null) throw reasonError('schedule-job-not-found')
    log.info('schedule.updated', { jobId: id, kind: job.spec.kind, enabled: job.enabled })
    this.onChanged?.()
    this.armReminderTimer()
    return this.overview()
  }

  /**
   * Align the list with plugins' declarations (`scheduledTasks`) (TODO 372). Called at startup after PluginHost has loaded. `declared` is all installed
   * plugins (rows of plugins that were merely disabled are kept). Added rows are disabled.
   */
  syncPluginTasks(
    declared: readonly { readonly pluginId: string; readonly tasks: readonly ScheduledTaskDeclaration[] }[]
  ): void {
    if (this.stopped) return
    // TODO 952 stage 1: remember the "repeat while idle" declarations (a row's contents are only the id pair, so look it up from the declaration).
    this.idleTasks = new Set(
      declared.flatMap((plugin) =>
        plugin.tasks.filter((task) => task.idle === true).map((task) => taskKey(plugin.pluginId, task.id))
      )
    )
    const result = this.store.syncPluginTasks(declared, this.now())
    if (result.added + result.renamed + result.removed === 0) return
    log.info('schedule.pluginTasks.synced', result)
    this.onChanged?.()
  }

  remove(id: string): ScheduleOverview {
    if (this.store.delete(id)) {
      log.info('schedule.removed', { jobId: id })
      this.options.onJobRemoved?.(id)
      this.onChanged?.()
      this.armReminderTimer()
    }
    return this.overview()
  }
}
