/**
 * The lifetime of a process (`Live`) (item 93 / 95 / T7 / 12.2, TODO 578 (c)). Split out of `SessionManager`:
 * starting (`ensureLive` / `startLive`), switching the settings (`switchLive`), keeping within the concurrency limit
 * (`makeRoom`), idle eviction (`sweepIdle`), stopping (`stopThread`), receiving an exit
 * (`onAgentExit`) and removing the registration (`forgetLive`).
 *
 * **What is not here**: receiving and recording events (`onAgentEvent` / `record` / `flush`, (d)) and
 * `dispatchNow` (validation, recording, writing to stdin; left in the manager in (b)) stay in `SessionManager`
 * and are called through the closures of `LiveLifecycleHost`. The `live` / `restarting` / `sessionToThread`
 * Maps stay owned by the manager (many places read them), and the same objects are passed here.
 *
 * `SessionManager` does not pass `this`; it builds a bundle of thin closures and passes that (same as (e) (f) (g) (b)).
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { AiosEvent, ThinkingLevel } from '@shared/agent.js'
import { reasonError } from '@shared/reason.js'
import type { OsSandboxPolicy } from '@shared/os-sandbox.js'
import type {
  ApiRetry,
  InterruptReason,
  RunningSubtask,
  SessionState,
  Thread,
  ToolProgress
} from '@shared/thread.js'
import { errorFields, log } from '../../common/logger.js'
import { uriToPath } from '../../common/uri.js'
import { reasonOfExit } from './interrupt.js'
import { activeBackgroundShells, nextBackgroundShellExpiry, type BackgroundShell } from './background-shells.js'
import type { ThreadStore } from './store.js'
import type { AgentAdapter, AgentSession, GatewayEndpoint, PermissionAnswer, PermissionAsk } from './types.js'
import { endTurn, type SendQueue } from './send-queue.js'

/**
 * The maximum wait for the `close` of a process that has been told to stop. A safeguard after `stop()` has sent up to SIGKILL:
 * once it passes, only the registration is removed and the next one is started (a late exit is recognized by `onAgentExit`).
 */
const RETIRE_WAIT_MS = 5_000

/** The interval (ms) for watching for the end of a backend update. */
const BACKEND_UPDATE_POLL_MS = 500
/** The upper limit of setTimeout (about 24.8 days). Even if the configured time limit is longer, it is simply re-armed when this fires. */
const MAX_TIMER_MS = 2_147_483_647

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export interface Live {
  readonly threadId: string
  /** aios's internal session ID. A fresh launch without `--resume` uses it as is. */
  readonly sessionId: string
  readonly token: string
  session: AgentSession | null
  /**
   * The wait during startup. Until spawn returns `session` is null, so a second
   * send that comes in the meantime waits on this. Without waiting, a second spawn would
   * orphan the first (review B-2).
   */
  starting: Promise<void> | null
  backendSessionId: string | null
  /**
   * The settings **in effect now** for this process (T7 / 4.5.1). Starts from the launch settings and is
   * replaced when switched without dropping the process (item 95). If the next send's settings differ from this, switch or restart.
   */
  modelId: string | null
  thinking: ThinkingLevel | null
  /**
   * Whether this process is in Plan mode now (item 112 / 4.2.3). Entered by the launch flag or `setPlanMode`, and
   * since the CLI itself leaves it when the plan is accepted (spike 22), this is set back to false then.
   */
  planMode: boolean
  /**
   * Whether this process was started with the OS sandbox enabled (TODO 1106, 4.2.4). It is a launch flag, so it cannot be changed while running:
   * if it differs from the thread's setting (`Thread.osSandbox`), restart on the next send. It also decides whether requests to run outside the sandbox are refused.
   */
  readonly osSandbox: boolean
  /**
   * TODO 1216: whether this process was started unattended read-only (`SpawnOptions.readOnly`). It is a launch flag, so when the first turn
   * ends and it differs from the conversation's state (`isUnattendedReadOnly`), restart on the next send (a person's continuation runs under the usual default).
   */
  readonly readOnly?: boolean
  /** TODO 982: whether this process was started as a drill (`SpawnOptions.drill`). A drill conversation never runs a process without it. */
  readonly drill?: boolean
  state: SessionState
  lastActivity: number
  /** Approvals pending in this session. */
  pendingApprovals: Set<string>
  /**
   * The task ids of subagent work running in the background and not finished (item 93 / 4.6.3). A child by default
   * also runs outside the parent's turn (after `result`), so while this is non-empty the process is not evicted even when `idle`.
   * If the process dies, it goes with the whole `Live` (the children die together), so no leftovers are carried over.
   * The value is the record shown in the renderer's list (description, usage, last tool, 4.6.3 "how it is shown").
   */
  subtasks: Map<string, RunningSubtask>
  /**
   * The task id of a shell not yet finished (`run_in_background`, item 105) -> its start time and whether it is in the background
   * (TODO 1196). Unlike subagents (`subtasks`), it is counted **with a time limit**:
   * holding off eviction for as long as it runs would block it forever for long-lived work such as a watcher.
   * A shell past this time since its start, and a foreground shell, are seen by neither `isEvictable` nor the list spinner
   * (`ThreadRuntime.backgroundShells`). Updates go only through the pure functions of `background-shells.ts`.
   * The end notification does not say whether it is a child, so only ids remembered at start are removed (the same shape as item 93).
   */
  backgroundShells: Map<string, BackgroundShell>
  /**
   * The count of `activeBackgroundShells` distributed last (TODO 1196). Compared to decide whether to redistribute when the count dropped after the time limit
   * (the boundary timer `armShellExpiry` and the safety net `sweepIdle`).
   */
  shownBackgroundShells: number
  /**
   * A subagent's tool call -> the parent's call that started the child that issued it (item 93, spike 19).
   * An approval request carries only a `tool_use_id`, so remember it from the child's message row (a
   * `tool_use` with `parentToolUseId`) and match it against the `toolUseId` of `subtasks` to find which child.
   * When the child ends, remove that child's entries.
   */
  childToolUses: Map<string, string>
  /**
   * Progress of the parent's running tool call (item 259, the last `tool_progress`).
   * The source of `ThreadRuntime.toolProgress`. Cleared by the result or the end of the turn, and goes with the whole `Live` if the process dies.
   */
  toolProgress: Map<string, ToolProgress>
  /** The last notice of the current API retry (item 277). The source of `ThreadRuntime.apiRetry`. null once it paid off. */
  apiRetry: ApiRetry | null
  /** The number of MCP connections still pending while waiting before the first message (TODO 869 plan C). 0 means not waiting. */
  mcpPending: number
  /**
   * Waiting for the echo of a sent message (item 113, 4.5.6). The id and body of the `user_text` written to stdin. When the echo
   * (`user_replay`) arrives, its identifier is copied onto the saved row (and the one pending save) and the entry is cleared.
   * The input written to stdin while responding is always 0 or 1 item (4.5.4), so one wait entry is enough.
   */
  pendingReplay: { readonly eventId: string; readonly text: string } | null
  /**
   * The backend session id the branch was based on at its first launch (item 113). Kept in `forked_from` when
   * the sessions row is created on `session_started`. null for a normal launch or a resume.
   */
  forkOf: string | null
  /**
   * The time `interrupt()` was last called (⌘Enter / Esc / the stop button, items 96 / 161). On an interrupt the CLI
   * may echo the preceding user line, including a message we did not send
   * (`user_replay` arrives without a `pendingReplay`), and then the "no record" of `attachMessageId` is not
   * a bug but a side effect of the interrupt (a small observation of the 14th proxy verification, TODO 196).
   * Within `INTERRUPT_REPLAY_GRACE_MS` of this time it is demoted to debug rather than warn.
   * It is only updated on each interrupt and has no explicit moment of clearing (the next echo that truly has no record
   * becomes a warn again once the time has passed: the purpose is only to "silence the regular warn").
   */
  lastInterruptAt: number | null
  /**
   * A stop of this process has begun (`stopThread` / `abort`). **`alive` stays true until `close` arrives**
   * (`LiveSession.stop()` may return after SIGKILL's 3 seconds without waiting for `close`), so a send arriving in
   * between would see this `Live` as "running" and write to a closed stdin, and the message was silently lost.
   * If set, `ensureLive` waits for `exited` and then restarts.
   */
  retiring: boolean
  /**
   * TODO 840: starting up, and the concurrency slot has been **taken** (passed `makeRoom`), but `session` is not set yet.
   * Spawn takes 1-2 seconds including the gateway startup, and during that `session === null`, so `alive` cannot
   * count it. Without counting it, several threads started almost at the same time would each see "there is still room"
   * and exceed the limit. Cleared at the end of `startLive` (success or failure) (afterwards `session.alive` counts it).
   */
  holdsRoom: boolean
  /** Resolves when `onAgentExit` receives this `Live`'s exit. */
  readonly exited: Promise<void>
  readonly markExited: () => void
}

/**
 * The settings used for one send (T7 / items 95 / 112). Compared with the same-named fields of the running process's `Live`; if they
 * differ, switch with a control request or drop and restart.
 */
export interface WantedSettings {
  readonly modelId: string | null
  readonly thinking: ThinkingLevel | null
  readonly planMode: boolean
}


/** What `LiveLifecycle` borrows from `SessionManager`. */
export interface LiveLifecycleHost {
  readonly store: ThreadStore
  /** Thread id -> `Live`. The same object as the manager's. */
  readonly live: Map<string, Live>
  /** Threads being restarted because of a settings change (T7). The same object as the manager's. */
  readonly restarting: Map<string, Promise<Live>>
  /** aios session ID -> thread ID. The same object as the manager's. */
  readonly sessionToThread: Map<string, string>
  readonly gateway: {
    issueToken(sessionId: string): string
    revokeToken(token: string): void
    endpoint(token: string): GatewayEndpoint
  }
  /** Item 186: the agent is not run in a duplicate made for verification. */
  isAgentDisabled(): boolean
  /** Whether it is after shutdown (`stopped`). */
  isStopped(): boolean
  /** TODO 1116: whether the shutdown procedure has begun (`beginStop` or `stopped`). Do not start anything new, and leave the wait for the update. */
  isStopping(): boolean
  /** Whether a backend update is running (not waited for if omitted). */
  readonly isBackendUpdating: (() => boolean) | undefined
  settings(): { readonly maxConcurrent: number; readonly maxConcurrentCap: number; readonly idleTimeoutMs: number }
  backgroundShellEvictTimeoutMs(): number
  adapterFor(thread: Thread): AgentAdapter
  scratchPathOf(thread: Thread): string | null
  workingCwdForSpawn(thread: Thread): Promise<string>
  /** Bundle conversations (TODO 633 stage 3): the name to enter a worktree with on the first launch. null if none. Cleared when it entered the worktree (manager). */
  launchWorktreeName(threadId: string): string | null
  /** TODO 972: the standing instructions of the conversation's role (Teammate), read on every launch. null / omitted means none. */
  roleInstructionsOf?(thread: Thread): string | null
  /** The OS sandbox's allow table (TODO 1106). Read every time a thread with the sandbox ON is started (a changed setting applies from the next launch). */
  osSandboxPolicy(): OsSandboxPolicy
  /** TODO 1216: whether that conversation is in the middle of an unattended read-only turn (a trigger's first turn). */
  isUnattendedReadOnly(threadId: string): boolean
  /** TODO 982: whether the conversation is a drill (the DB mark). Its processes start with the drill's launch narrowing. Omitted means false. */
  isDrill?(threadId: string): boolean
  emitThread(threadId: string): void
  /** Receiving events (d). Left in the manager. */
  onAgentEvent(threadId: string, event: AiosEvent): void
  record(threadId: string, event: AiosEvent): void
  /**
   * Routes a permission request the backend asked by its own entry point into the same entry point as the gateway's `approve` (TODO 529).
   * `sessionId` is the aios session id passed at spawn (= the same one the gateway's token points at).
   */
  requestPermission(sessionId: string, ask: PermissionAsk): Promise<PermissionAnswer>
  /** Marks an exception already recorded as a launch failure (so the queued message's `drain` does not record it twice). */
  markRecordedError(err: object): void
  // ---- Manager state that `onAgentExit` touches ----
  /** `requested` = an exit aios asked for (model switch, settings switch, eviction, stop). It will be resumed, so it is not an "end". */
  forgetScheduledTurn(threadId: string, requested: boolean): void
  /** Takes out and clears the record of the interrupt reason. */
  takeInterruptHint(threadId: string): InterruptReason | null
  applyInterrupt(threadId: string, reason: InterruptReason | null, emit: boolean): void
  cancelApprovals(threadId: string, reason: 'session-exited'): void
  scheduledJobRunningChanged(jobId: string): void
  queueOf(threadId: string): SendQueue | undefined
  /** `SendQueueService.setPaused`: the only way to change the stopped mark (it tells the listener; wave 106 review Z3). */
  setQueuePaused(queue: SendQueue, paused: boolean): void
  drainQueue(threadId: string): Promise<void>
}

export class LiveLifecycle {
  private readonly live: Map<string, Live>
  private readonly restarting: Map<string, Promise<Live>>
  private readonly sessionToThread: Map<string, string>
  /**
   * TODO 928: threads asked to stop (deleted, shut down, evicted) in the middle of a restart (`restarting`).
   * A restart waits for the old process to exit and then starts a new one, so stopping only the `Live` registered at that moment
   * would leave a new process started later stuck in `starting`. The restart's promise looks at this: if it has not started yet it does not start,
   * and if it already started it stops it. Cleared when the restart ends.
   */
  private readonly stopDuringRestart = new Set<string>()
  /**
   * The one-shot timer for the boundary where a background shell reaches the time limit (TODO 1196, wave 81 review Y). Only one is set across all threads,
   * matched to the earliest boundary. Not set if no shell is being counted. Always cleared by `dispose` (shutdown) (12.9).
   */
  private shellExpiryTimer: ReturnType<typeof setTimeout> | null = null
  private shellExpiryAt: number | null = null

  constructor(private readonly host: LiveLifecycleHost) {
    this.live = host.live
    this.restarting = host.restarting
    this.sessionToThread = host.sessionToThread
  }

  async stopThread(threadId: string): Promise<void> {
    // TODO 928: if a restart is in progress, wait until the new process has also stopped (do not leave it after `remove` / `stop` returns).
    const restart = this.restarting.get(threadId)
    if (restart !== undefined) this.stopDuringRestart.add(threadId)
    await this.stopRegistered(threadId)
    if (restart !== undefined) await restart.catch(() => undefined)
  }

  /** Stops only the `Live` registered now (also used to drop the old one from inside a restart). */
  private async stopRegistered(threadId: string): Promise<void> {
    const live = this.live.get(threadId)
    if (live === undefined) return
    live.retiring = true
    live.state = 'stopping'
    // The list spinner (TODO 45) treats `stopping` as "spinning" too, so notify here as well.
    this.host.emitThread(threadId)
    // TODO 568: if starting up (`session === null`), wait for the spawn to finish and then stop. Without waiting it
    // returns having done nothing, and a `session` that gets in later would run one turn of the deleted thread's message.
    // `retiring` is set first, so a send that was waiting is refused by `dispatchNow`.
    const starting = live.starting
    if (starting !== null) await starting.catch(() => undefined)
    await live.session?.stop()
  }

  // ---- Starting and resuming a session ----

  async ensureLive(thread: Thread, wanted: WantedSettings): Promise<Live> {
    // While restarting for a settings change, the `live` registration briefly disappears (it is removed by
    // `onAgentExit` when dropped). So that a send arriving in that window does not start a second one,
    // the restart is waited on with a per-thread promise (the same idea as B-2).
    const restarting = this.restarting.get(thread.id)
    if (restarting !== undefined) {
      await restarting
      return this.ensureLive(thread, wanted)
    }

    const existing = this.live.get(thread.id)
    if (existing !== undefined) {
      // If starting (or restarting), wait for that same one. If it fails, the same exception
      // propagates to this side too (B-2). The situation changes while waiting, so decide again after the wait.
      if (existing.starting !== null) {
        await existing.starting
        return this.ensureLive(thread, wanted)
      }
      // A process that has been told to stop (eviction, a stop SIGINT) keeps `alive` true until `close`.
      // To avoid writing to a closed stdin and losing a message, wait for it to end and then restart.
      // `stop()` handles it through SIGTERM -> SIGKILL after 3 seconds, so the wait is finite.
      if (existing.retiring && existing.session?.alive === true) {
        await existing.session.stop()
        await Promise.race([existing.exited, delay(RETIRE_WAIT_MS)])
        if (this.live.get(thread.id) === existing) this.forgetLive(existing)
        return this.ensureLive(thread, wanted)
      }
      if (existing.session?.alive === true) {
        // TODO 1106: the OS sandbox is a launch flag, so if it differs from the thread's setting it cannot be aligned while running (restart).
        const sandboxChanged =
          existing.osSandbox !== (thread.osSandbox === true) ||
          // TODO 1216: read-only is also a launch flag. A person's send after an unattended turn ends restarts with the flag removed.
          (existing.readOnly === true) !== this.host.isUnattendedReadOnly(thread.id) ||
          // TODO 982: a drill's process must have been started as one (closing side: restart rather than reuse).
          (existing.drill === true) !== (this.host.isDrill?.(thread.id) === true)
        // If the settings are the same, do not restart (startup cost about 410 MB / 21k tokens, 4.1).
        // Wave 82 review Y-2: even if the settings are the same, if a value passed to the backend changed after launch, align it with a switch.
        if (
          !sandboxChanged &&
          existing.modelId === wanted.modelId &&
          existing.thinking === wanted.thinking &&
          existing.planMode === wanted.planMode &&
          existing.session.modelDrifted?.() !== true
        ) {
          return existing
        }
        // Item 95: if it can be switched while running, do so (control request, spike 18). Here we come only
        // after the previous turn's `result` and just before the next input (the send queue keeps one item per turn).
        if (!sandboxChanged && (await this.switchLive(existing, wanted))) return existing
        // If it died during the switch (eviction, abnormal exit), review the situation and then start.
        if (existing.session?.alive !== true || this.live.get(thread.id) !== existing) {
          return this.ensureLive(thread, wanted)
        }
        // T7 / 4.6.2: when it cannot be reverted because of a version with no switching entry point, a refusal, a timeout, or the launch settings,
        // drop the running process and restart with `--resume` (the backend session id is kept).
        // A send arriving in the meantime waits on `starting`.
        log.info('session.restart.settings', {
          threadId: thread.id,
          model: wanted.modelId !== null,
          thinking: wanted.thinking,
          plan: wanted.planMode,
          sandbox: thread.osSandbox === true
        })
        // **Make everything from dropping to starting one promise.** If it were
        // split at the drop, the waiting side would start a new process first and the order of messages
        // would be swapped (in measurement the second message arrived first).
        const restart = (async (): Promise<Live> => {
          await this.stopRegistered(thread.id)
          // Normally onAgentExit has removed it, but if it has not, remove it here
          // (if left, the next decision would look at a dead session). A late-arriving exit is
          // distinguished from another `Live` by `onAgentExit`, which does not touch the new one.
          if (this.live.get(thread.id) === existing) this.forgetLive(existing)
          // TODO 928: if a delete or shutdown arrived while dropping the old one, do not start the new process.
          if (this.restartCancelled(thread.id)) throw new Error('thread is being stopped')
          const started = await this.startLive(thread, wanted)
          // If it arrived while starting, stop what came up (if `stopThread` is already stopping it, just wait).
          // `retiring` is set, so a send that was waiting is refused by `dispatchNow`.
          if (this.restartCancelled(thread.id) && !started.retiring) await this.stopRegistered(thread.id)
          return started
        })()
        // Avoid an unhandled rejection when there is no waiter at all.
        restart.catch(() => undefined)
        this.restarting.set(thread.id, restart)
        try {
          return await restart
        } finally {
          if (this.restarting.get(thread.id) === restart) {
            this.restarting.delete(thread.id)
            this.stopDuringRestart.delete(thread.id)
          }
        }
      }
    }

    return this.startLive(thread, wanted)
  }

  /**
   * Switches model / thinking on the running process (item 95 / 4.5.1). On success replaces the `Live`'s settings and returns true.
   * If there is no entry point, it is refused, or it times out, returns false (the caller restarts).
   */
  private async switchLive(live: Live, wanted: WantedSettings): Promise<boolean> {
    const session = live.session
    if (session === null) return false
    if (live.modelId !== wanted.modelId || live.thinking !== wanted.thinking || session.modelDrifted?.() === true) {
      if (session.switchSettings === undefined) return false
      let switched = false
      try {
        switched = await session.switchSettings({ modelId: wanted.modelId, thinking: wanted.thinking })
      } catch (err) {
        // By contract it does not throw, but if it does, just fall back to restarting.
        log.warn('session.switch.failed', { threadId: live.threadId, ...errorFields(err) })
      }
      if (!switched || !session.alive || this.live.get(live.threadId) !== live) return false
      live.modelId = wanted.modelId
      live.thinking = wanted.thinking
      log.info('session.switch.live', {
        threadId: live.threadId,
        model: wanted.modelId !== null,
        thinking: wanted.thinking
      })
    }
    // Plan mode (item 112, spike 21 / 22). If it cannot be aligned with a control request, restart (launch flag).
    if (live.planMode !== wanted.planMode) {
      if (session.setPlanMode === undefined) return false
      let switched = false
      try {
        switched = await session.setPlanMode(wanted.planMode)
      } catch (err) {
        log.warn('session.planMode.failed', { threadId: live.threadId, ...errorFields(err) })
      }
      if (!switched || !session.alive || this.live.get(live.threadId) !== live) return false
      live.planMode = wanted.planMode
      log.info('session.planMode.live', { threadId: live.threadId, on: wanted.planMode })
    }
    return true
  }

  /** Whether a stop was requested in the middle of a restart, or shutdown has begun (TODO 928). */
  private restartCancelled(threadId: string): boolean {
    return this.stopDuringRestart.has(threadId) || this.host.isStopped()
  }

  /** Starts one new process. Call it only after passing the `ensureLive` decision. */
  private async startLive(thread: Thread, wanted: WantedSettings): Promise<Live> {
    // Item 186: this is the only entry point that starts a process, so paths other than send (rewind) also stop here.
    if (this.host.isAgentDisabled()) throw reasonError('agent-disabled')
    const adapter = this.host.adapterFor(thread)
    const sessionId = randomUUID()
    const token = this.host.gateway.issueToken(sessionId)
    const resumeId = this.host.store.latestBackendSessionId(thread.id)
    // First launch of a branch (item 113, 4.5.6): a branch thread that has no session of its own yet resumes the original
    // session **as a separate session** from the conversation "up to that response". Once
    // `session_started` has arrived and a sessions row is in, it resumes normally with its own id.
    const origin = resumeId === null ? this.host.store.forkOriginOf(thread.id) : null
    // First launch of continuing from a transcript (item 111, 4.5.9): start the original conversation with `--resume` (as a separate
    // session if fork). Once a sessions row is in, later resumes are normal.
    const transcript =
      resumeId === null && origin === null ? this.host.store.transcriptOriginOf(thread.id) : null
    const forkFrom = origin?.backendSessionId ?? (transcript?.fork === true ? transcript.sessionId : null)
    // TODO 1106: a thread with the OS sandbox ON. Decided by the settings at launch time and recorded on `Live` (it does not change while running).
    const osSandbox = thread.osSandbox === true
    // TODO 1216: a trigger's first turn is started read-only (a flag that removes write tools, which the Adapter builds).
    const readOnly = this.host.isUnattendedReadOnly(thread.id)
    // TODO 982: a drill (the Adapter narrows the launch, or refuses to start).
    const drill = this.host.isDrill?.(thread.id) === true
    const gmailDraftFont = this.host.store.gmailDraftFont()
    // TODO 972: the role's standing instructions. Read on every launch (an edit of the role applies from the next launch, as with resume).
    const roleInstructions = this.host.roleInstructionsOf?.(thread) ?? null

    let markExited = (): void => undefined
    const exited = new Promise<void>((resolve) => {
      markExited = resolve
    })
    const live: Live = {
      threadId: thread.id,
      sessionId,
      token,
      session: null,
      starting: null,
      backendSessionId: resumeId,
      modelId: wanted.modelId,
      thinking: wanted.thinking,
      planMode: wanted.planMode,
      osSandbox,
      ...(readOnly ? { readOnly: true } : {}),
      ...(drill ? { drill: true } : {}),
      state: 'starting',
      lastActivity: Date.now(),
      pendingApprovals: new Set(),
      subtasks: new Map(),
      backgroundShells: new Map(),
      shownBackgroundShells: 0,
      childToolUses: new Map(),
      toolProgress: new Map(),
      apiRetry: null,
      mcpPending: 0,
      pendingReplay: null,
      forkOf: forkFrom,
      lastInterruptAt: null,
      retiring: false,
      holdsRoom: false,
      exited,
      markExited
    }
    this.live.set(thread.id, live)
    this.sessionToThread.set(sessionId, thread.id)
    this.host.emitThread(thread.id)

    const endpoint: GatewayEndpoint = this.host.gateway.endpoint(token)

    // Wait after registering `live`. **Both makeRoom and spawn are asynchronous**, so if we
    // await before registering, a second send would see "not started" and start a second one.
    const starting = (async (): Promise<void> => {
      // If the backend is updating, wait until it finishes (send, run now, continue from transcript, rewind and restart all
      // pass through this entry point). `live` is already registered, so a send during the wait joins `starting`, and no second one is started.
      await this.waitBackendUpdate()
      // TODO 1106: a thread with the sandbox ON is not started on a backend (version, environment) that cannot use the sandbox: it is not
      // run without the sandbox. The reason is shown in the timeline's error row, and it can be sent after turning it OFF from the thread's ellipsis menu. Refuse before freeing a concurrency slot.
      if (osSandbox && !adapter.supports('os-sandbox')) throw reasonError('os-sandbox-blocked')
      await this.makeRoom(thread.id)
      // TODO 928: if shutdown began while waiting for an update or eviction, do not start (leave no CLI after `stop()`).
      // TODO 1116: do not start after `beginStop` (the first step of the shutdown procedure) either: leaving the update wait does not necessarily mean the update finished.
      if (this.host.isStopping()) throw new Error('thread is being stopped')
      // The scratch area (T19) is **created here for the first time**. It also passes through on a `--resume` restart,
      // but it is `recursive`, so nothing happens if it already exists.
      const scratchPath = this.host.scratchPathOf(thread)
      if (scratchPath !== null) {
        await mkdir(scratchPath, { recursive: true })
        log.info('thread.scratch.created', { threadId: thread.id })
      }
      const resumeBackendSessionId = adapter.supports('resume')
        ? (resumeId ?? forkFrom ?? transcript?.sessionId ?? null)
        : null
      const launchWorktree = resumeBackendSessionId === null ? this.host.launchWorktreeName(thread.id) : null
      live.session = await adapter.spawn(
        {
          sessionId,
          threadId: thread.id,
          cwd: await this.host.workingCwdForSpawn(thread),
          allowedDirs: thread.allowedDirUris.map(uriToPath),
          // **Resume is the default** (spike 5: startup cost dominates). The first launch of a branch uses the original id.
          resumeBackendSessionId,
          ...(launchWorktree === null ? {} : { worktreeName: launchWorktree }),
          // Branch (item 113): from the conversation up to that response, as a separate session.
          resumeAtMessageId: forkFrom === null ? null : (origin?.atMessageId ?? null),
          forkSession: forkFrom !== null,
          // The origin of settings is not passed (item 109): the row's `settingSources` is a record, and launch is the same as the stock CLI.
          // The settings (T7) include the per-message overrides. Features that cannot be used have been set to null
          // by the caller (4.6: passing them makes the launch itself fail).
          modelId: wanted.modelId,
          thinking: wanted.thinking,
          // Item 112: when false, the field is not passed (the default permission mode).
          ...(wanted.planMode ? { planMode: true } : {}),
          // TODO 1106: the allow table is read from settings every time a process is started (a change applies from the next launch).
          ...(osSandbox ? { osSandbox: this.host.osSandboxPolicy() } : {}),
          ...(readOnly ? { readOnly: true } : {}),
          ...(drill ? { drill: true } : {}),
          // TODO 1229: the font of Gmail drafts. When it is the standard, nothing is passed (current behavior unchanged). Read on every start (it does not change while running).
          ...(gmailDraftFont === 'default' ? {} : { gmailDraftFont }),
          ...(roleInstructions === null ? {} : { roleInstructions }),
          gateway: endpoint
        },
        {
          // If the next process is already registered for the same thread, discard the old one's row
          // (so the `result` of a dying process does not take the new turn's "responding" down).
          onEvent: (event) => {
            const current = this.live.get(thread.id)
            if (current !== undefined && current !== live) return
            this.host.onAgentEvent(thread.id, event)
          },
          onExit: (exit) => this.onAgentExit(thread.id, live, exit.requested, exit.sawResult),
          // TODO 529: a permission request from a backend that does not go through the gateway's `approve`. Route it into the same entry point.
          onPermission: (ask) => this.host.requestPermission(sessionId, ask)
        }
      )
    })()
    live.starting = starting
    try {
      await starting
    } catch (err) {
      // `live` is removed only once. The same exception propagates to the waiting side too.
      if (this.live.get(thread.id) === live) {
        this.live.delete(thread.id)
        this.sessionToThread.delete(sessionId)
        this.host.gateway.revokeToken(token)
        // TODO 928: a start abandoned because of shutdown is not a failure (`record` does not write it either, because of `stopped`).
        if (this.host.isStopped()) log.info('session.spawn.cancelled', { threadId: thread.id })
        else log.error('session.spawn.failed', { threadId: thread.id, ...errorFields(err) })
        // Mark it as recorded so the queued message's send (`drain`) does not record the same failure twice.
        if (err instanceof Object) this.host.markRecordedError(err)
        this.host.record(thread.id, {
          id: randomUUID(),
          sessionId,
          threadId: thread.id,
          ts: Date.now(),
          actor: 'main',
          kind: 'error',
          payload: { message: (err as Error).message, code: null, origin: 'spawn' }
        })
      }
      throw err
    } finally {
      live.starting = null
      // TODO 1331 item 4: the session knows only now (after its own start) that the folder's provider is in effect; tell the windows once.
      if (live.session?.folderProvider === true) this.host.emitThread(thread.id)
      // TODO 840: the slot is taken over by `session.alive` (on failure it has gone with the whole `live`).
      live.holdsRoom = false
    }
    return live
  }

  /**
   * Brings a launch that no send follows (a process started to preview or confirm a rewind) down to `idle` (TODO 916).
   * The only ways out of `starting` are `session_started` and the `running` of `dispatchNow`, but the CLI does not emit `system/init` until the first user
   * line arrives, and not on a `rewind_files` control request either. If not brought down it stays `starting`, the rewind confirmation
   * becomes `rewind-busy`, it is not evicted (`isEvictable`) and holds a concurrency slot, and it also blocks auto-update
   * (`activityBlocker`). If a send joined the same `Live` and already made it `running`, it is left alone.
   */
  settleIdleStart(live: Live): void {
    if (live.state !== 'starting' || live.retiring || live.session?.alive !== true) return
    if (this.live.get(live.threadId) !== live) return
    live.state = 'idle'
    live.lastActivity = Date.now()
    this.host.emitThread(live.threadId)
  }

  /**
   * Waits until the backend update finishes (`isBackendUpdating`). Gives up when shutdown begins.
   * TODO 1116: what is watched is `isStopping` (`beginStop`, the first step of shutdown). With `stopped` alone, the scheduled run that `jobScheduler.stop` waits for
   * would stall here, and the procedure would not reach `sessions.stop`.
   */
  async waitBackendUpdate(): Promise<void> {
    const updating = this.host.isBackendUpdating
    if (updating === undefined) return
    let logged = false
    while (!this.host.isStopping() && updating()) {
      if (!logged) {
        log.info('session.start.waitUpdate', {})
        logged = true
      }
      await delay(BACKEND_UPDATE_POLL_MS)
    }
  }

  /**
   * Keeps within the concurrency limit (spike 5: default 5 / maximum 8. The constraint is memory, about 410 MB per process).
   * Drops sessions that are not responding first. If none can be dropped, refuses.
   */
  private async makeRoom(exceptThreadId: string): Promise<void> {
    const self = this.live.get(exceptThreadId)
    const others = [...this.live.values()].filter((l) => l.threadId !== exceptThreadId)
    // TODO 840: also count those that are starting and have taken a slot (`holdsRoom`). Without counting them, several
    // threads started almost at the same time would each see room and exceed the limit.
    const occupying = others.filter(occupiesSlot)
    const max = this.host.settings().maxConcurrent
    if (occupying.length < max) {
      // Take the slot in the same synchronous section as the decision (so a start arriving during a later await counts it).
      if (self !== undefined) self.holdsRoom = true
      return
    }

    const now = Date.now()
    const evictable = others
      .filter((l) => l.session?.alive === true && isEvictable(l, now, this.host.backgroundShellEvictTimeoutMs()))
      .sort((a, b) => a.lastActivity - b.lastActivity)

    const needed = occupying.length - max + 1
    if (evictable.length < needed) {
      throw reasonError('concurrency-limit', {
        max,
        cap: this.host.settings().maxConcurrentCap
      })
    }
    // TODO 840: take the slot before waiting for evictions, and make the evicted ones `retiring` / `stopping` all at once synchronously
    // (`stopThread` sets it before its first await). Then another start arriving during the wait counts
    // the ones being evicted as "still there, cannot be evicted", and does not count on the same victim twice.
    if (self !== undefined) self.holdsRoom = true
    const victims = evictable.slice(0, needed)
    for (const victim of victims) {
      log.info('session.evicted', { threadId: victim.threadId, reason: 'concurrency' })
    }
    // Wait until all evictions finish (wave 41 code-review). With `Promise.all`, one reject throws first while the other evictions
    // are still running, and they finish stopping only after the caller has cleaned up `live`. If there is a failure, throw
    // the first reason after waiting for all (as in the sequential days, an eviction failure is a start failure).
    const settled = await Promise.allSettled(victims.map((victim) => this.stopThread(victim.threadId)))
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
  }

  /** Drops idle sessions to reclaim memory (12.2). The context comes back on resume. */
  sweepIdle(): void {
    const now = Date.now()
    // TODO 1196: redistribute the background shell count. The boundary is distributed by the `armShellExpiry` timer, so this is a safety net.
    this.refreshShellCounts(now)
    for (const live of this.live.values()) {
      if (live.session?.alive !== true) continue
      if (!isEvictable(live, now, this.host.backgroundShellEvictTimeoutMs())) continue
      if (now - live.lastActivity < this.host.settings().idleTimeoutMs) continue
      log.info('session.evicted', { threadId: live.threadId, reason: 'idle' })
      void this.stopThread(live.threadId)
    }
  }

  /**
   * Called when the background shell record changed (TODO 1196, wave 81 review Y). Re-arms a one-shot timer at the time the earliest of the counted shells
   * reaches the time limit (one for all threads). The time-limit boundary has no notice, and waiting for the 1-minute sweep would delay the
   * spinner stopping and the eviction decision by up to 1 minute. Not set if no shell is counted. Not set after shutdown.
   */
  armShellExpiry(): void {
    if (this.host.isStopped()) {
      this.dispose()
      return
    }
    const now = Date.now()
    const timeoutMs = this.host.backgroundShellEvictTimeoutMs()
    let next: number | null = null
    for (const live of this.live.values()) {
      if (live.backgroundShells.size === 0) continue
      const at = nextBackgroundShellExpiry(live.backgroundShells, now, timeoutMs)
      if (at !== null && (next === null || at < next)) next = at
    }
    if (next !== null && next === this.shellExpiryAt && this.shellExpiryTimer !== null) return
    this.dispose()
    if (next === null) return
    this.shellExpiryAt = next
    const timer = setTimeout(() => this.onShellExpiry(), Math.min(MAX_TIMER_MS, Math.max(0, next - now)))
    timer.unref?.()
    this.shellExpiryTimer = timer
  }

  /** The boundary timer fired. Redistributes the count and re-arms for the next boundary. */
  private onShellExpiry(): void {
    this.shellExpiryTimer = null
    this.shellExpiryAt = null
    if (this.host.isStopped()) return
    this.refreshShellCounts(Date.now())
    this.armShellExpiry()
  }

  /** Clears the boundary timer (shutdown, 12.9). Later `armShellExpiry` calls look at `isStopped` and do not arm it. */
  dispose(): void {
    if (this.shellExpiryTimer !== null) clearTimeout(this.shellExpiryTimer)
    this.shellExpiryTimer = null
    this.shellExpiryAt = null
  }

  /**
   * Redistributes to threads whose background shell count changed by time alone (the time limit passed) (TODO 1196). Threads whose record is empty and whose
   * distributed count is also 0 are not looked at (so every sweep does not recount all threads).
   */
  private refreshShellCounts(now: number): void {
    const timeoutMs = this.host.backgroundShellEvictTimeoutMs()
    for (const live of this.live.values()) {
      if (live.backgroundShells.size === 0 && live.shownBackgroundShells === 0) continue
      const shells = activeBackgroundShells(live.backgroundShells, now, timeoutMs)
      if (shells === live.shownBackgroundShells) continue
      live.shownBackgroundShells = shells
      this.host.emitThread(live.threadId)
    }
  }

  /**
   * The `live` process ended. **The key is the `Live` itself, not the thread id**: a restart
   * (`ensureLive`) may have registered the next one without waiting for the old process's `close`, and if a late-arriving
   * exit looked up the thread id, it would delete the new process's registration, token and "responding".
   */
  private onAgentExit(threadId: string, live: Live, requested: boolean, sawResult: boolean): void {
    live.markExited()
    if (this.live.get(threadId) !== live) {
      // Already removed (a restart, a wait timeout), or replaced by the next process. Clean up only its own part.
      this.host.gateway.revokeToken(live.token)
      this.sessionToThread.delete(live.sessionId)
      log.info('session.exited', { threadId, requested, sawResult, superseded: true })
      return
    }
    this.forgetLive(live)
    this.host.forgetScheduledTurn(threadId, requested)
    log.info('session.exited', { threadId, requested, sawResult })
    // The turn that was waiting for `result` ended here (item 94). If it died in the middle of an interrupt
    // (the interrupt did not work and fell back to SIGINT, etc.), the interrupting input is sent on resume. Otherwise
    // (the stop button, abnormal exit) the queued messages are kept without being sent.
    const queue = this.host.queueOf(threadId)
    // TODO 521: not stopped by the user but ended in the middle of a turn (the CLI crashed or was killed).
    const brokeTurn = !requested && queue !== undefined && queue.awaitingResult
    const hint = this.host.takeInterruptHint(threadId)
    if (queue !== undefined && queue.awaitingResult) {
      queue.awaitingResult = false
      const stop = !queue.interrupting
      queue.interrupting = false
      if (stop) this.host.setQueuePaused(queue, true)
    }
    // TODO 1289 (code-review, wave 97 fix Y): the turn ended with the process. Not while a send is being written (its own mark).
    if (queue !== undefined && !queue.dispatching) endTurn(queue)
    // After shutdown only the memory cleanup is done (item 79). The end time was already written by `stop()`, and
    // pending approvals were cleaned up by `broker.shutdown`.
    if (this.host.isStopped()) return
    if (brokeTurn) this.host.applyInterrupt(threadId, reasonOfExit(hint), false)
    if (live.backendSessionId !== null) this.host.store.finishSession(live.backendSessionId)
    // Pending approvals would be left hanging, so clean them up. Distinguish this from a user refusal (4.2).
    this.host.cancelApprovals(threadId, 'session-exited')
    this.host.emitThread(threadId)
    // TODO 351 (351-2): also when the process dies (including while awaiting approval), if it is a scheduled-run thread, have the
    // list's "running" refreshed: it must be fixed even for a death with no turn `result` (kill etc.).
    const scheduledJobId = this.host.store.getThread(threadId)?.scheduledJobId
    if (scheduledJobId !== undefined) this.host.scheduledJobRunningChanged(scheduledJobId)
    void this.host.drainQueue(threadId)
  }

  /** Removes the `live` registration (the thread table, the gateway token and the session id mapping). */
  private forgetLive(live: Live): void {
    this.host.gateway.revokeToken(live.token)
    this.sessionToThread.delete(live.sessionId)
    if (this.live.get(live.threadId) === live) this.live.delete(live.threadId)
  }
}

/**
 * Whether it occupies a concurrency slot (TODO 840, the common counting of `makeRoom` and `SessionManager.hasSessionRoom`).
 * A running process (`alive`, including one told to stop and waiting for `close`) and one that is starting and
 * has taken a slot (`holdsRoom`).
 */
export function occupiesSlot(live: Live): boolean {
  return live.session?.alive === true || live.holdsRoom
}

/**
 * Whether it may be evicted (the common condition of `sweepIdle` / `makeRoom`, 12.2 / item 93). The response is
 * finished (`idle`) and no approval is pending. Stopping the CLI while a child is running kills the child with it (it does not
 * come back with `--resume`), so a single running subagent blocks the stop, but for a shell running in the background (item 105)
 * **only** one that has "not yet passed `shellTimeoutMs` since its start" blocks it: one past that is regarded as long-lived
 * work such as a watcher and is not counted (otherwise eviction would be blocked forever).
 */
export function isEvictable(live: Live, now: number, shellTimeoutMs: number): boolean {
  if (live.state !== 'idle' || live.pendingApprovals.size > 0 || live.subtasks.size > 0) return false
  // TODO 1196: the same counting as the list spinner (`ThreadRuntime.backgroundShells`).
  return activeBackgroundShells(live.backgroundShells, now, shellTimeoutMs) === 0
}
