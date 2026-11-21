/**
 * Receiving and recording events (item 79 / 93 / 113 / T7 / 5.1, TODO 578 (d)). Split out of `SessionManager`:
 * reflects events from the backend into the thread state (usage, task list, subagents, interrupt mark, unread,
 * notification) (`onAgentEvent`), batches sending to the renderer and saving to the DB on the same 16 ms cycle
 * (`record` / `flush`), and puts what was saved into the index (`indexEvents`). Also holds the tracking of
 * subagents / background shells / child tool calls (`trackSubtask` etc.) and the copy of the echo of sent
 * messages (`attachMessageId`).
 *
 * The pending writes (`pendingWrites`) and the 16 ms `Batcher` live here. Shutdown calls `flushNow` / `dispose`
 * (`SessionManager.stop`). The other state (`live` / each Map / the send queue) stays owned by the manager, and
 * the same objects are received through `EventRecorderHost`.
 *
 * `SessionManager` does not pass `this`; it builds a bundle of thin closures and passes that (same as (e) (f) (g) (b) (c)).
 */
import { randomUUID } from 'node:crypto'
import type { AiosEvent, AiosEventBatch, McpGlobalReport, TurnUsagePayload, WorktreeChangedPayload } from '@shared/agent.js'
import type {
  ApprovalSubtask,
  ContextUsage,
  InterruptReason,
  Thread,
  TodoList
} from '@shared/thread.js'
import { Batcher } from '../../common/batch.js'
import { errorFields, log } from '../../common/logger.js'
import { redactText } from '../../common/redact.js'
import { uriToPath } from '../../common/uri.js'
import type { ApprovalBroker } from '../approval/broker.js'
import type { IndexClient } from '../index/client.js'
import type { ThreadViews } from '../windows.js'
import { nextApiRetry } from './api-retry.js'
import { activeBackgroundShells, applyBackgroundShellEvent } from './background-shells.js'
import type { BundleService } from './bundles.js'
import type { ContextBreakdownCache } from './context-breakdown.js'
import { interruptChange, nextInterruptHint } from './interrupt.js'
import type { Live } from './live-lifecycle.js'
import type { McpReportRegistry } from './mcp-report.js'
import type { OutsideWriteHit, OutsideWriteTracker } from './outside-writes.js'
import type { SessionManagerNotifyDeps } from './manager.js'
import type { SendQueueService } from './send-queue.js'
import type { ThreadStore } from './store.js'
import type { SubtaskWorktrees } from './subtask-worktrees.js'
import { applySubtaskEvent } from './subtasks.js'
import { applyToolProgressEvent } from './tool-progress.js'

/**
 * An "echo without a record" (`user_replay`) that arrives within this time after `interrupt()` is called is
 * demoted from warn to debug (a small observation of TODO 196). On an interrupt the CLI may echo even a preceding
 * user line we did not send, and then the missing `pendingReplay` is a side effect of the interrupt, not a bug.
 * The window is a little wider than the time spent waiting for the interrupt response (15 s, item 91).
 */
const INTERRUPT_REPLAY_GRACE_MS = 20_000

/** Length of the start of the response attached to a scheduled-run notification (TODO 323). */
const SCHEDULED_EXCERPT_CHARS = 160

/**
 * A content line that shows the parent turn is progressing (item 93). If one comes from the parent while `idle`, the
 * parent started a turn by itself (on receiving the end of a background child).
 */
const TURN_CONTENT_KINDS: ReadonlySet<AiosEvent['kind']> = new Set<AiosEvent['kind']>([
  'assistant_delta',
  'assistant_text',
  'thinking_delta',
  'tool_use',
  'turn_usage'
])

/**
 * The start of the response attached to a scheduled-run notification (TODO 323). It stays in the notification
 * center (OS side), so it goes through the same redaction as saving, then whitespace is collapsed and it is cut.
 */
export function scheduledExcerpt(text: string): string {
  const { text: redacted } = redactText(text)
  const flat = redacted.replace(/\s+/g, ' ').trim()
  return flat.length <= SCHEDULED_EXCERPT_CHARS ? flat : `${flat.slice(0, SCHEDULED_EXCERPT_CHARS - 1)}…`
}

/** What `EventRecorder` borrows from `SessionManager`. Maps etc. are the same objects as the manager's. */
export interface EventRecorderHost {
  readonly store: ThreadStore
  readonly live: Map<string, Live>
  readonly sendQueue: SendQueueService
  readonly mcpReports: McpReportRegistry
  readonly backendCommands: Map<string, readonly string[]>
  readonly contextUsage: Map<string, ContextUsage | null>
  readonly contextBreakdowns: ContextBreakdownCache
  readonly todos: Map<string, TodoList | null>
  readonly reportedWindows: Map<string, number>
  readonly scheduledTurns: Map<string, string>
  /** TODO 1216: the first (unattended) turn of a conversation started by a trigger -> the trigger's name. The same object as the manager's. */
  readonly unattendedTurns?: Map<string, string>
  readonly interruptHints: Map<string, InterruptReason>
  readonly outsideWrites: OutsideWriteTracker
  readonly subtaskWorktrees: SubtaskWorktrees
  readonly subagentModels: Map<
    string,
    { readonly models: Map<string, string>; readonly confirmed: Set<string> }
  >
  readonly bundles: BundleService
  readonly views: ThreadViews
  readonly index: IndexClient
  readonly notify: SessionManagerNotifyDeps | undefined
  /** Whether it is after shutdown (`stopped`). */
  isStopped(): boolean
  onEvents(batch: AiosEventBatch): void
  onMcpReportChanged: ((report: McpGlobalReport) => void) | undefined
  /** Cancels an approval in the inbox because the result of its tool_use arrived (TODO 632). */
  cancelApprovalRequest(
    threadId: string,
    match: Parameters<ApprovalBroker['cancelRequest']>[1],
    reason: 'tool-timeout'
  ): void
  emitThread(threadId: string): void
  /** The time limit for counting background shells (item 105 / TODO 1196, the same value as `isEvictable`). */
  backgroundShellEvictTimeoutMs(): number
  /** The background shell record changed (wave 81 review Y). Re-arms the timer for the time-limit boundary. */
  backgroundShellsChanged(): void
  applyWorktreeChange(threadId: string, payload: WorktreeChangedPayload, at: number): void
  noteWriteTarget(threadId: string, name: string, payload: { readonly toolUseId: string; readonly input: unknown }, parentToolUseId: string | undefined): void
  /** TODO 1043: if a tool_use reads a secret, marks the thread. Optional. */
  noteSecretRead?(threadId: string, name: string, input: unknown): void
  markOutsideWrite(threadId: string, sessionId: string, hit: OutsideWriteHit, at: number): void
  toContextUsage(thread: Thread, usage: TurnUsagePayload, at: number): ContextUsage
  trackSubagentModel(threadId: string, live: Live | undefined, event: AiosEvent): boolean
  applyInterrupt(threadId: string, reason: InterruptReason | null, emit?: boolean): void
}

export class EventRecorder {
  private readonly outbound: Batcher<AiosEvent>
  /** Events waiting to be saved. Written in a batch on the same cycle as sending to the renderer. */
  private readonly pendingWrites = new Map<string, AiosEvent[]>()

  constructor(private readonly host: EventRecorderHost) {
    // 5.1 / spike 8: do not make one event one message. Batch every 16 ms.
    this.outbound = new Batcher<AiosEvent>((events) => this.flush(events))
  }

  /** Flushes what has accumulated right now (shutdown). */
  flushNow(): void {
    this.outbound.flushNow()
  }

  /** Disables later `push` calls (the Batcher does not re-arm its timer on a push after dispose, 12.9). */
  dispose(): void {
    this.outbound.dispose()
  }

  /** Discards the pending writes (shutdown). */
  clearPending(): void {
    this.pendingWrites.clear()
  }

  /**
   * Updates `live.subtasks` on a subagent's start / progress / end (item 93). Returns true if the contents changed
   * (also when usage moves with progress: needed by the list display, 4.6.3 "how it is shown").
   * It does not touch the `result` branch (the `state` transition): even if children remain it becomes `idle`, and
   * only eviction is held back (no new state name is added).
   */
  private trackSubtask(live: Live, event: AiosEvent): boolean {
    return applySubtaskEvent(live.subtasks, event, this.host.subagentModels.get(live.threadId)?.models)
  }

  /**
   * Updates `live.backgroundShells` on the start / went-to-background / end / full set of shells running in the
   * background (`run_in_background`, item 105). Read by the eviction decision and by the list spinner (TODO 1196,
   * `ThreadRuntime.backgroundShells`). **Returns true if the count changed** (redistribute to the renderer): the
   * shell itself is not shown in the list, so an update that leaves the count unchanged is not distributed.
   */
  private trackBackgroundShell(live: Live, event: AiosEvent): boolean {
    if (!applyBackgroundShellEvent(live.backgroundShells, event)) return false
    this.host.backgroundShellsChanged()
    const shells = activeBackgroundShells(live.backgroundShells, Date.now(), this.host.backgroundShellEvictTimeoutMs())
    if (shells === live.shownBackgroundShells) return false
    live.shownBackgroundShells = shells
    return true
  }

  /** Remembers a child's tool calls and removes them when the child ends (item 93, `Live.childToolUses`). */
  private trackChildToolUse(live: Live, event: AiosEvent): void {
    if (event.kind === 'tool_use' && event.parentToolUseId !== undefined) {
      live.childToolUses.set(event.payload.toolUseId, event.parentToolUseId)
      return
    }
    if (event.kind === 'subtask_finished' && event.payload.toolUseId !== null) {
      const parent = event.payload.toolUseId
      for (const [child, owner] of live.childToolUses) {
        if (owner === parent) live.childToolUses.delete(child)
      }
    }
  }

  /**
   * Looks up the child that issued an approval request from its `tool_use_id` (item 93). Null for the parent's own
   * request or a request whose child line has not arrived yet (in spike 19 the child's `tool_use` line arrived 3-4 ms
   * before the approval request, but they are different paths (stdout and the gateway socket), so the order is not guaranteed).
   */
  subtaskOfToolUse(live: Live, toolUseId: string | null): ApprovalSubtask | null {
    if (toolUseId === null) return null
    const parent = live.childToolUses.get(toolUseId)
    if (parent === undefined) return null
    for (const subtask of live.subtasks.values()) {
      if (subtask.toolUseId === parent) {
        return { taskId: subtask.taskId, description: subtask.description }
      }
    }
    return null
  }

  /**
   * Copies the identifier that arrived in the echo onto the `user_text` sent just before. If the body does not match
   * (nothing was waiting, or it is a different message) it is not copied: no rewind key is safer than a key pointing
   * at another message. For those still pending save (inside the Batcher) the event is replaced; for those already saved the row is fixed.
   */
  private attachMessageId(live: Live, threadId: string, messageId: string, text: string): void {
    const pending = live.pendingReplay
    if (pending === null || pending.text !== text) {
      // If we interrupted just before, this "no record" is a side effect of the CLI echoing the preceding user line on
      // an interrupt, not a bug (TODO 196). Silence the regular warn.
      const sinceInterrupt =
        live.lastInterruptAt === null ? null : Date.now() - live.lastInterruptAt
      const afterInterrupt = sinceInterrupt !== null && sinceInterrupt < INTERRUPT_REPLAY_GRACE_MS
      const fields = { threadId, waiting: pending !== null }
      if (afterInterrupt) log.debug('session.replay.unmatched', fields)
      else log.warn('session.replay.unmatched', fields)
      return
    }
    live.pendingReplay = null
    const bucket = this.pendingWrites.get(threadId)
    if (bucket !== undefined) {
      const at = bucket.findIndex((queued) => queued.id === pending.eventId)
      const queued = at === -1 ? undefined : bucket[at]
      if (queued !== undefined && queued.kind === 'user_text') {
        bucket[at] = { ...queued, payload: { ...queued.payload, messageId } }
      }
    }
    this.host.store.setEventMessageId(threadId, pending.eventId, messageId)
  }

  onAgentEvent(threadId: string, event: AiosEvent): void {
    // Anything that arrives after shutdown (such as the `error` when the CLI goes down in `stopThread`) is neither
    // saved nor counted (item 79). The DB is closed once `stop()` returns.
    if (this.host.isStopped()) return
    const live = this.host.live.get(threadId)
    if (live !== undefined) live.lastActivity = Date.now()

    // Item 68: keep the list of usable commands per backend (for deciding on a new thread). The renderer re-fetches
    // `backends()` when it receives `session_started` (already updated here, before the flush).
    // The rest of item 117: a replacement while running (such as `/reload-plugins`) also replaces the same record.
    // The thread's own list is pulled by the renderer from the saved `commands_changed`, treated as later than `session_started`.
    const reportedCommands =
      event.kind === 'session_started' && Array.isArray(event.payload.commands)
        ? event.payload.commands
        : event.kind === 'commands_changed' && event.actor === 'main'
          ? event.payload.commands
          : null
    if (reportedCommands !== null) {
      const backend = this.host.store.getThread(threadId)?.backend
      if (backend !== undefined) this.host.backendCommands.set(backend, reportedCommands)
    }

    // Item 164: keep the report of the global MCP servers (the source of the "MCP servers" section of the settings
    // screen). A report from any thread overwrites the same single key. An old report without `mcpServers` is left alone.
    if (event.kind === 'session_started' && Array.isArray(event.payload.mcpServers)) {
      const report = this.host.mcpReports.record(event.payload.mcpServers, event.ts)
      this.host.onMcpReportChanged?.(report)
    }

    if (event.kind === 'session_started' && live !== undefined) {
      // After a conversation reset (`/clear`, item 117) the same process starts over with a new backend id. Close the
      // previous row and create a separate row with the new id: `sessions.id` is a primary key, so aios's internal id
      // cannot be reused. A resume (`--resume`) looks up the latest row, so it continues the new conversation.
      const previous = live.backendSessionId
      const restarted = previous !== null && previous !== event.payload.backendSessionId
      if (restarted) this.host.store.finishSession(previous)
      live.backendSessionId = event.payload.backendSessionId
      live.state = 'running'
      this.host.store.recordSession({
        id: restarted ? randomUUID() : live.sessionId,
        threadId,
        backendSessionId: event.payload.backendSessionId,
        // If this is the first launch of a branch, the original session (item 113). Later resumes stay null (kept by the upsert).
        forkedFrom: live.forkOf,
        backendVersion: event.payload.backendVersion
      })
      live.forkOf = null
      this.host.emitThread(threadId)
    }

    // A conversation boundary (item 117 / 4.5.3.1). Usage from before this point is no longer "now", so the donut is
    // not shown until the next response (the token count reported by compaction covers only part of the conversation and cannot be used as the numerator).
    // A reset also starts the task list over (item 118). Compaction keeps the task list.
    if ((event.kind === 'conversation_reset' || event.kind === 'context_compacted') && event.actor === 'main') {
      this.host.contextUsage.set(threadId, null)
      this.host.contextBreakdowns.forget(threadId)
      if (event.kind === 'conversation_reset') this.host.todos.set(threadId, null)
      this.host.emitThread(threadId)
    }

    // A rewrite of the parent's task list (item 118 / 4.6.5). The adapter attaches `todos` only to the parent's calls,
    // but narrow by actor as well to be safe (a child's task list is not pinned in the display, owner decision 2026-09-27).
    if (event.kind === 'tool_use' && event.actor === 'main' && event.payload.todos !== undefined) {
      this.host.todos.set(threadId, {
        toolUseId: event.payload.toolUseId,
        items: event.payload.todos,
        at: event.ts
      })
      this.host.emitThread(threadId)
    }

    // A result arrived for a tool_use whose approval is in the inbox = the backend is no longer waiting for the answer (TODO 632, 7.6.5).
    // The CLI's MCP idle timeout (default 30 minutes) cut-off tells the gateway nothing (spike 29), so this is the
    // reliable clue. Do not leave a clickable dialog; turn it into "cancelled by timeout".
    if (event.kind === 'tool_result' && live !== undefined && live.pendingApprovals.size > 0) {
      this.host.cancelApprovalRequest(threadId, { toolUseId: event.payload.toolUseId }, 'tool-timeout')
    }

    // Entering and leaving a worktree (TODO 633 stage 1). The table for following the working folder and for cleanup. Neither saved nor shown.
    if (event.kind === 'worktree_changed') {
      if (event.payload.change === 'child_start') {
        // The child's worktree path is not known yet (TODO 700). Do not put it in the cleanup table.
        if (event.payload.toolUseId !== null) this.host.outsideWrites.noteChildStart(threadId, event.payload.toolUseId)
      } else {
        this.host.applyWorktreeChange(threadId, event.payload, event.ts)
        if (event.payload.change === 'child' && event.payload.toolUseId !== null) {
          this.host.outsideWrites.noteChild(threadId, event.payload.toolUseId, event.payload.path)
        }
      }
    }
    // TODO 700: remember the target of a write in a turn split off by worktree (the mark is set once the result arrives as a success).
    if (event.kind === 'tool_use') {
      this.host.noteWriteTarget(threadId, event.payload.name, event.payload, event.parentToolUseId)
      // TODO 1043: if the call reads a place that holds secrets, mark the thread (also watches reads that never reach approval).
      this.host.noteSecretRead?.(threadId, event.payload.name, event.payload.input)
    }

    // The echo of a sent message (item 113, 4.5.6). Copies the identifier onto the saved user_text and does not keep
    // the row itself (the body is the same as the user_text we recorded ourselves). It is not sent to the renderer either.
    if (event.kind === 'user_replay') {
      if (live !== undefined) this.attachMessageId(live, threadId, event.payload.messageId, event.payload.text)
      return
    }

    // The first turn of a scheduled run (TODO 323): keep the parent's last response and attach its start to the end notification.
    if (event.kind === 'assistant_text' && event.actor === 'main' && this.host.scheduledTurns.has(threadId)) {
      this.host.scheduledTurns.set(threadId, event.payload.text)
    }
    if (event.kind === 'assistant_text' && event.actor === 'main') this.host.bundles.noteText(threadId, event.payload.text)

    // Context usage (item 60 / 4.5.2): replaced on every API call (not accumulated).
    // A subagent's calls are a separate context, so they are not counted in the parent's usage.
    if (event.kind === 'turn_usage' && event.actor === 'main') {
      const thread = this.host.store.getThread(threadId)
      if (thread !== null) {
        this.host.contextUsage.set(threadId, this.host.toContextUsage(thread, event.payload, event.ts))
        this.host.emitThread(threadId)
      }
    }

    // Subagents running in the background (item 93 / 4.6.3). Read by the eviction decision (`isEvictable`).
    // The same notification also arrives for tool execution, but only children are counted. The end notification does
    // not say whether it is a child, so only ids remembered at start are removed (an end for an unknown id does nothing).
    if (live !== undefined && this.trackSubtask(live, event)) this.host.emitThread(threadId)
    // TODO 403: the child's model (the parent's specification -> the actual model of the child's first message).
    if (this.host.trackSubagentModel(threadId, live, event)) this.host.emitThread(threadId)
    // TODO 633 stage 2: whether the child's worktree exists and its commits (an estimate).
    this.host.subtaskWorktrees.note(threadId, event, () => {
      const thread = this.host.store.getThread(threadId)
      return thread === null ? null : uriToPath(thread.cwdUri)
    })
    if (live !== undefined) this.trackChildToolUse(live, event)
    if (live !== undefined && this.trackBackgroundShell(live, event)) this.host.emitThread(threadId)
    // Progress of a running tool (item 259). The progress of a shell inside a child goes into the activity of `live.subtasks`.
    if (live !== undefined && applyToolProgressEvent(live.toolProgress, live.subtasks, event)) {
      this.host.emitThread(threadId)
    }

    // API retry (item 277). Display of what is in progress only. Not saved (`EPHEMERAL_EVENT_KINDS`).
    if (live !== undefined) {
      const next = nextApiRetry(live.apiRetry, event)
      if (next !== live.apiRetry) {
        live.apiRetry = next
        this.host.emitThread(threadId)
      }
    }

    // Waiting for an MCP connector to connect (TODO 869 plan C). The waiting count comes in with the notice and is cleared at the first session_started. Not saved.
    if (live !== undefined && (event.kind === 'mcp_connecting' || event.kind === 'session_started')) {
      const pending = event.kind === 'mcp_connecting' ? event.payload.pending : 0
      if (pending !== live.mcpPending) {
        live.mcpPending = pending
        this.host.emitThread(threadId)
      }
    }

    // The interrupt mark (TODO 521). The clue is the one from before recording (used for the kind of a failed `result`).
    const hintBefore = this.host.interruptHints.get(threadId) ?? null
    const change = interruptChange(hintBefore, event)
    if (change !== null) this.host.applyInterrupt(threadId, change.kind === 'set' ? change.reason : null)
    const hintAfter = nextInterruptHint(hintBefore, event)
    if (hintAfter === null) this.host.interruptHints.delete(threadId)
    else if (hintAfter !== hintBefore) this.host.interruptHints.set(threadId, hintAfter)

    // A turn the parent started by itself (item 93, spike 19): when a background child finishes, the parent starts the
    // next turn without user input and emits a `result`. Treat that period as "responding" too: if it stayed `idle`
    // it would hit eviction (`isEvictable`), and a send would not become a queued message but be written to stdin and
    // mixed into that turn (the same shape as B-8 of item 94). The start of a turn is learned from a content line
    // (not assumed from the child's end notification: if no turn starts, it could never return from "responding").
    if (live !== undefined && event.actor === 'main' && TURN_CONTENT_KINDS.has(event.kind)) {
      const queue = this.host.sendQueue.of(threadId)
      if (!queue.awaitingResult && !queue.dispatching) {
        queue.awaitingResult = true
        if (live.state === 'idle') live.state = 'running'
        log.info('session.turn.autonomous', { threadId })
        this.host.emitThread(threadId)
      }
    }

    if (event.kind === 'result') {
      // The first turn of a bundle conversation ended (TODO 633 stage 3): send a short report to the parent as a queued message (after recording, at the end below).
      void this.host.bundles.onTurnEnded(threadId, {
        ok: event.payload.ok,
        interrupted: event.payload.interrupted === true,
        text: event.payload.text
      })
      // The limit the backend reported (item 60 / 74) is newer than the static table. Keep it, and
      // replace the denominator of the usage being displayed on the spot too.
      for (const { model, contextWindow } of event.payload.contextWindows ?? []) {
        this.host.reportedWindows.set(model, contextWindow)
      }
      const current = this.host.contextUsage.get(threadId)
      if (current !== undefined && current !== null && current.model !== null) {
        const reported = this.host.reportedWindows.get(current.model)
        if (reported !== undefined && (current.contextWindow !== reported || current.windowSource !== 'reported')) {
          this.host.contextUsage.set(threadId, { ...current, contextWindow: reported, windowSource: 'reported' })
        }
      }
      // One turn ended (item 94). The input written to stdin is always 0 or 1 item, so step down from
      // "responding" here. The head of the queued messages is sent after this `result` is recorded (`drain` below).
      const queue = this.host.sendQueue.get(threadId)
      if (queue !== undefined) {
        queue.awaitingResult = false
        queue.interrupting = false
      }
      if (live !== undefined) {
        live.state = live.pendingApprovals.size > 0 ? 'awaiting-approval' : 'idle'
        // The key is the backend session ID so the same row can be updated after a resume.
        if (live.backendSessionId !== null) {
          this.host.store.addTurn(live.backendSessionId, event.payload.costUsd)
        }
      }
      // The unread check mark is set only when "the response ended in a thread no foreground window is showing"
      // (4.3 / TODO 71). It is set whether there are 0 windows, the showing window was closed, or the app is in the background.
      // If there is no row (soft-deleted), nothing is written.
      const seen = this.host.views.isSeen(threadId)
      const rowExists = this.host.store.touchLastEvent(threadId, event.ts, { unread: !seen })
      // Desktop notification (item 72): notify when a response ends in a thread that is not visible.
      // An interrupt (the user stopped it themselves) is not notified: they know the result, so it is not needed.
      // The first turn of a scheduled run (TODO 323) attaches the start of the response to the end notification.
      const scheduledText = this.host.scheduledTurns.get(threadId)
      this.host.scheduledTurns.delete(threadId)
      // TODO 1216: the trigger's unattended turn ended. Drop read-only (the next send goes back to the usual default launch) and let the next one be started.
      const triggerName = this.host.unattendedTurns?.get(threadId)
      if (triggerName !== undefined) {
        this.host.unattendedTurns?.delete(threadId)
        this.host.notify?.triggerTurnSettled?.(threadId)
      }
      // TODO 351 (351-2): when a turn ends, if it is a scheduled-run thread, have the list's "running" refreshed.
      // Unrelated to unread (`seen`): even when the turn of a visible thread ends, the list should be corrected.
      if (rowExists) {
        const scheduledJobId = this.host.store.getThread(threadId)?.scheduledJobId
        if (scheduledJobId !== undefined) this.host.notify?.scheduledJobRunningChanged?.(scheduledJobId)
      }
      if (rowExists && !seen && event.payload.interrupted !== true) {
        const thread = this.host.store.getThread(threadId)
        if (thread !== null) {
          if (
            scheduledText !== undefined &&
            triggerName !== undefined &&
            this.host.notify?.triggeredTurnEnded !== undefined
          ) {
            this.host.notify.triggeredTurnEnded(threadId, triggerName, thread.title, scheduledExcerpt(scheduledText))
          } else if (scheduledText !== undefined && this.host.notify?.scheduledTurnEnded !== undefined) {
            this.host.notify.scheduledTurnEnded(threadId, thread.title, scheduledExcerpt(scheduledText))
          } else {
            this.host.notify?.turnEnded(threadId, thread.title)
          }
        }
      }
      this.host.emitThread(threadId)
    }

    if (event.kind === 'error' && live !== undefined) {
      live.state = 'error'
      this.host.emitThread(threadId)
    }

    // TODO 700: a write to the main working copy succeeded. Put the mark row after the write row.
    const outside =
      event.kind === 'tool_result'
        ? this.host.outsideWrites.noteResult(threadId, event.payload.toolUseId, event.payload.ok)
        : null
    this.record(threadId, event)
    if (outside !== null) this.host.markOutsideWrite(threadId, live?.sessionId ?? event.sessionId, outside, event.ts)
    // Send the head of the queued messages (item 94). It is after the `result` is recorded, so the timeline
    // is ordered "previous answer -> done -> next message".
    if (event.kind === 'result') void this.host.sendQueue.drain(threadId)
  }

  /** Batches the send to the renderer and the save to the DB on the same 16 ms cycle. */
  record(threadId: string, event: AiosEvent): void {
    // Do not accumulate after shutdown (item 79). Accumulating would re-arm the Batcher timer, and
    // `flush` -> `appendEvents` would run after the DB is closed.
    if (this.host.isStopped()) return
    const bucket = this.pendingWrites.get(threadId)
    if (bucket === undefined) this.pendingWrites.set(threadId, [event])
    else bucket.push(event)
    this.outbound.push(event)
  }

  private flush(events: readonly AiosEvent[]): void {
    const writes = new Map(this.pendingWrites)
    this.pendingWrites.clear()
    for (const [threadId, list] of writes) {
      const thread = this.host.store.getThread(threadId)
      if (thread === null) continue
      try {
        const { previewChanged } = this.host.store.appendEvents(thread, this.host.live.get(threadId)?.sessionId ?? null, list)
        // Put only what could be saved into the index. `retention = 'none'` leaves no row, so it does not
        // go into the index either (6.1). No copy is made; the canonical copy stays thread_events (6.5).
        if (thread.retention !== 'none') this.indexEvents(threadId, list)
        // TODO 686: the third line of the list (`threads.preview`) changes for the first time with this save. The one-item
        // distribution of `result` / `turn_usage` runs **before** the save of the same bundle, so it distributed a stale preview.
        // A thread that is not visible is fixed by a later distribution such as marking read, but the visible thread stays stale until the next trigger.
        // The rule for which events rewrite the preview lives in only one place, `ThreadStore.appendEvents`
        // (code-review: a copied predicate here could disagree with the kind after `toPersistable`).
        if (previewChanged) this.host.emitThread(threadId)
      } catch (err) {
        log.error('thread.persist.failed', { threadId, ...errorFields(err) })
      }
    }
    this.host.onEvents({ events, at: Date.now() })
  }

  /** Puts conversation events into the index (6.1). Passes only the kinds that are saved. */
  private indexEvents(threadId: string, events: readonly AiosEvent[]): void {
    const indexable = events
      .filter(
        (event) =>
          event.kind === 'user_text' || event.kind === 'assistant_text' || event.kind === 'tool_use'
      )
      .map((event) => ({
        id: event.id,
        threadId,
        title: this.host.store.labelOf(event.kind),
        ts: event.ts
      }))
    if (indexable.length > 0) this.host.index.indexConversationEvents(indexable)
  }
}
