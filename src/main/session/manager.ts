/**
 * SessionManager: manages threads and sessions (ARCHITECTURE.md 4.2 / 4.3 / 4.6).
 *
 * This file **does not know the backend**. It never touches the executable, flags or event
 * formats on the other side of `AgentAdapter` (constraint 6; lint checks it).
 *
 * Policies that come from the Phase 0 measurements:
 * - **The process starts on the first send.** Starting the gateway and the handshake take about
 *   1.35 s, and it cannot be pre-warmed (spike 10).
 * - **Resume by default.** Every session start costs about 21k cache-creation tokens
 *   (about $0.0168 per session) (spike 5). A design that starts a new session every time a thread
 *   is opened is expensive.
 * - **Idle sessions drop their process.** That reclaims about 410 MB each, and the session is
 *   resumed on return (12.2).
 * - **The limit on concurrency is memory.** Rate limits are not hit (spike 5).
 */
import type { AiReminderGate } from '../schedule/ai-reminders.js'
import { randomUUID } from 'node:crypto'
import { mkdir, opendir, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type {
  AgentStatus,
  AiosEvent,
  AiosEventBatch,
  AuthFailureKind,
  BackendStatusRow,
  McpGlobalReport,
  ModelChoice,
  ShellRunPayload,
  ThinkingLevel,
  TurnUsagePayload,
  WorktreeChangedPayload
} from '@shared/agent.js'
import { DEFAULT_SETTING_SOURCES, capabilitiesOf, isThinkingLevel, nearestThinkingLevel } from '@shared/agent.js'
import type { TriggerOrigin } from '@shared/trigger.js'
import { roleGrantKey, type StoredRole } from '../role/store.js'
import { cleanRoleInstructions } from '@shared/role.js'
import { MIN_IDLE_TIMEOUT_MS } from '@shared/settings.js'
import { formatReason, reasonError } from '@shared/reason.js'
import type { LocalModelAction, LocalModelActionResult, LocalModelActivityRow, LocalModelAdvice } from '@shared/local-models.js'
import {
  attachmentNamesInLine,
  stripLeadingAttachmentMarks
} from '@shared/attachment-mark.js'
import { shellCommandOf } from '@shared/shell-input.js'
import { isWebViewerUrl } from '@shared/open-external.js'
import { isThreadLinkId, type ThreadLinkLocation } from '@shared/thread-link.js'
import type {
  ApprovalDecision,
  ApprovalDiff,
  ApprovalItem,
  ApprovalPolicy,
  ApprovalPolicyPatch,
  ApprovalPolicySetResult,
  SandboxWriteDrop,
  ApprovalRule,
  AttachmentResolution,
  BackendChoice,
  ContextUsage,
  CreateThreadInput,
  CwdHistoryEntry,
  DeletedThreadSummary,
  FolderNotice,
  Reservation,
  RewindOptions,
  RewindPreview,
  RoleGrantView,
  RunningSubtask,
  SendInput,
  SendOutcome,
  SessionSettings,
  Thread,
  ThreadCreateOptions,
  ThreadRemoveOptions,
  ThreadRemoveResult,
  ThreadRetention,
  ThreadRuntime,
  ThreadSummary,
  Timeline,
  TodoList,
  InterruptReason,
  SubtaskWorktree,
  TranscriptSession,
  ViewerCommand
} from '@shared/thread.js'
import {
  canAllowHost,
  GATEWAY_TOOL_PREFIX,
  RESERVATION_PREVIEW_CHARS,
  UNTITLED_THREAD_TITLE,
  workingCwdUri
} from '@shared/thread.js'
import { applySshHostsPatch } from '@shared/ssh-hosts.js'
import {
  DEFAULT_SANDBOX_ALLOWED_DOMAINS,
  DEFAULT_SANDBOX_ALLOW_WRITE,
  applySandboxDomainsPatch,
  applySandboxWritePatch,
  sandboxDomainsForLaunch,
  type OsSandboxPolicy
} from '@shared/os-sandbox.js'
import type { ViewerShownReport } from '@shared/viewer-shown.js'
import { pathDenialReason } from '../../common/fs-policy.js'
import { BUNDLE_MAX_CAP } from '../../common/settings-keys.js'
import type { FsAccess } from '../fs/access.js'
import { MAX_TEXT_BYTES } from '../capability/viewer.js'
import type { IndexClient } from '../index/client.js'
import { log, errorFields } from '../../common/logger.js'
import { pathToUri, uriToPath, foldPath } from '../../common/uri.js'
import { ApprovalBroker, type ApprovalResult, type ApprovalRole } from '../approval/broker.js'
import { RoleGrantStore } from '../approval/grant-store.js'
import { applyWriteChange, type CurrentContent } from '../approval/write-diff.js'
import type { GatewayRequest, GatewayServer } from '../approval/server.js'
import { REMOVED_HEAD_UNKNOWN, TIMELINE_LIMIT, ThreadStore, threadCwdName, type ThreadRecord } from './store.js'
import { applySubagentModel } from './subtasks.js'
import { activeBackgroundShells } from './background-shells.js'
import { SUBTASK_STOP_GRACE_MS, stoppedSubtaskEvents } from './stop-subtasks.js'
import { ThreadViews } from '../windows.js'
import { DraftConflictTracker } from './draft-conflicts.js'
import { ViewerCommandReplies } from './viewer-command-replies.js'
import { newApprovalItems } from '../notify.js'
import {
  isOwnScratchCwd,
  isScratchCwd,
  scratchCwd,
  scratchRoot,
  sweepableScratchDirs,
  type ScratchRootEntry
} from './scratch.js'
import type { AgentAdapter, TranscriptSessionInfo } from './types.js'
import { MAX_VIEWER_HIGHLIGHT, checkSelection, resolveToolPath } from './viewer-tools.js'
import { runShellCommand, type ShellRunner } from './shell-run.js'
import { folderNotice } from './folder-notice.js'
import { cwdMatchKey } from './cwd-match.js'
import { ContextBreakdownCache } from './context-breakdown.js'
import type { ContextBreakdownResult } from '@shared/context-breakdown.js'
import { AppSettingsStore } from '../../common/settings.js'
import { McpReportRegistry } from './mcp-report.js'
import { redactText } from '../../common/redact.js'
import { buildExportTurns, type ConversationExport } from '@shared/conversation-export.js'
import { buildHandoffText, type HandoffEstimate, type HandoffPurpose, type HandoffText } from '@shared/handoff.js'
import { canSwitchBackendInPlace } from '@shared/backend-switch.js'
import { handoffTurns, inheritedEvents, lastOwnQuestionId } from './handoff.js'
import { slashName } from '@shared/slash-command.js'
// TODO 526 (wave 26 bundle C): physical deletion of abandoned threads.
import { existsSync, realpathSync, statSync } from 'node:fs'
// TODO 1109 item 8: drop the home directory and its parent from the sandbox's writable paths (shared code can only see their shape).
import { dropHomeWritePaths } from './sandbox-home.js'
import { ComposerDraftRegistry, pickAbandoned } from './abandoned.js'
// TODO 578 (e): the gateway entry point (the body of `handleGatewayRequest`) was split out into this module.
import {
  GatewayRequests,
  resolvedGrantPath,
  resolvedWritePaths,
  type DrillStop,
  type GatewayViewerCapture,
  type GatewayWebTabs
} from './gateway-requests.js'
import { describeDrillStop, drillOpView, parseDrillCandidates, unaskedDrillOps } from './drill.js'
import { MAX_DRILL_OPS, type DrillReport } from '@shared/drill.js'
import type { GrantCandidate } from '../approval/grants.js'
import type { PluginToolRelay } from '../plugin/tools.js'
// TODO 633 stage 3: the bundle conversation (the gateway's `startBundles`, bundles.ts).
import { BundleService } from './bundles.js'
// TODO 578 (f): rewind (the bodies of `rewindPreview` / `rewind`) was split out into this module.
import { RewindService, shareWorktree } from './rewind.js'
// TODO 578 (b): the send queue (the body of `send`, reservations, `drain`) was split out into this module.
import {
  SendQueueService,
  endTurn,
  queueBusy,
  type CarriedReservation,
  type CarriedReservationTable,
  type SendQueue,
  type TurnStarter
} from './send-queue.js'
import { LiveLifecycle, isEvictable, occupiesSlot, type Live, type WantedSettings } from './live-lifecycle.js'
import { AuthExpiryWatch } from './auth-expiry.js'
import type { ExpiryInfo } from './login-recovery.js'
import type { UnattendedLoginGuide } from '@shared/login-recovery.js'
// TODO 578 (g): attachments (`resolveAttachment` / `composeText` / the actual sent images) were split out into this module.
import { AttachmentService } from './attachments.js'
import { ViewerHistoryService } from './viewer-history.js'
import type { ViewerHistorySnapshot } from '@shared/viewer-history.js'

export { MAX_ATTACHMENT_BYTES } from './attachments.js'
import { OutsideWriteTracker, type OutsideWriteHit } from './outside-writes.js'
// TODO 578 (d): receiving and recording events was split out into this module.
import { EventRecorder } from './event-recorder.js'
import type { AgentSettings } from '../agent-settings.js'

export { scheduledExcerpt } from './event-recorder.js'
import { SubtaskWorktrees, type SubtaskWorktreeDeps } from './subtask-worktrees.js'
import {
  cleanupWorktreeOutcome,
  exists as pathExists,
  branchHasCommits,
  parseWorktreeList,
  runGitFile,
  recreateWorktree,
  type WorktreeCleanupOutcome,
  type WorktreeCleanupTarget,
  type WorktreeCleanupVerdict,
  type WorktreeRestoreTarget,
  type WorktreeRestoreVerdict
} from '../git/worktree-cleanup.js'

/** Rows per page of "read more" (item 88). The first load uses `TIMELINE_LIMIT` (2,000). */
export const TIMELINE_PAGE = 500


/** TODO 1301: how many history rows the menu bar folder list checks, and how long one `stat` may take (a dead network volume must not hold the list). */
const TRAY_STAT_CANDIDATES = 16
const TRAY_STAT_TIMEOUT_MS = 1500

/** Whether `path` is a directory, by an asynchronous `stat` that gives up (false) after `timeoutMs`. */
async function isDirectoryWithin(path: string, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref()
  })
  try {
    return await Promise.race([stat(path).then((s) => s.isDirectory(), () => false), timeout])
  } finally {
    clearTimeout(timer)
  }
}

const IDLE_SWEEP_MS = 60_000
/** `ThreadRuntime.reservations` when there are none. Avoids allocating a new array each time. */
const NO_RESERVATIONS: readonly Reservation[] = []
/** `ThreadRuntime.subtasks` when no subagent is running (item 93). Avoids allocating a new array each time. */
const NO_SUBTASKS: readonly RunningSubtask[] = []
/**
 * Limits for `!` when the adapter has no `shellLimits` (item 116). The values match the Bash tool's
 * defaults (the CLI-specific values themselves live in the compat table and the adapter returns them).
 */
const DEFAULT_SHELL_LIMITS = { maxOutputChars: 30_000, timeoutMs: 120_000 } as const
/**
 * Provisional title at creation. **Whether a title is provisional is kept in `threads.title_auto`, not
 * by comparing against this string** (item 83). It used to be decided by string equality, so when a user
 * typed this title by hand it was overwritten on the next send.
 *
 * **The value is an empty string, independent of language** (TODO 66). It used to write the Japanese
 * "new thread" label to the DB, but main does not know the language, so the renderer replaces it with
 * `thread.untitled` for display. That label in older rows is normalized to the same empty string by
 * `ThreadStore` based on `title_auto` (only the migration 15 backfill knows the string).
 */
const DEFAULT_TITLE = UNTITLED_THREAD_TITLE
/** Maximum title length (same for rename and create). */
const MAX_TITLE = 120
/** Maximum length of the auto title (the first line of the first send). */
const MAX_AUTO_TITLE = 60
/** Page size when re-feeding a restored thread to the index (same as the startup import `CONVERSATION_BACKFILL_PAGE`). */
const RESTORE_INDEX_PAGE = 2000

/**
 * Where a send came from (fix V, code-review). `human` is only a message the person wrote themselves
 * (composer, interrupt, "send later"). Everything else (resend after auth expiry, resume after an
 * interruption, bundle reports, the first message of a trigger / scheduled run) is `auto` and does not
 * lift the read-only restriction of a trigger conversation. The default is `auto` (forgetting to set it
 * errs on the safe side).
 *
 * TODO 1289: `later` is a message the person wrote but aios sends at a set time ("send later", TODO 989). It lifts
 * the trigger read-only restriction like `human`, but the turn it starts counts as unattended (nobody may be
 * watching when it goes out). Only a `human` send starts an attended turn - on the spot, or after the running turn
 * when it was queued as a reservation or an interrupt (owner decision 2026-11-21, wave 97 fix Y).
 */
export type SendOrigin = 'human' | 'later' | 'auto'

export interface SessionManagerEvents {
  onEvents(batch: AiosEventBatch): void
  /**
   * The full list (item 75). Only on start, create, delete, rename and clearing all logs.
   * The order is the same as main's list (newest last event first: `threadRecency`, item 83).
   */
  onThreadsChanged(summaries: readonly ThreadSummary[]): void
  /**
   * Only one thread changed (item 75). High-frequency triggers such as `turn_usage` / `result` /
   * adding or removing approvals / `markRead` / `setViewerState` go here. The receiver replaces the
   * entry by `id` and re-sorts by `threadRecency(thread)` (the last event).
   */
  onThreadChanged(summary: ThreadSummary): void
  onApprovalsChanged(items: readonly ApprovalItem[]): void
  onAgentStatus(status: AgentStatus): void
  /**
   * Delivers "open / close" to the ViewerPane of window `viewId` (`webContents.id`) (item 97).
   * Comes from the gateway's `openFile` / `closeFile`. **The destination is only the window showing that
   * thread**, unlike pushes to all windows (`onThreadChanged` etc.). If omitted, nothing is delivered
   * (tests and window-less setups).
   */
  onViewerCommand?(viewId: number, command: ViewerCommand): void
  /**
   * The report of the global MCP servers was rewritten (item 164). Once per `session_started`.
   * Redraws the "MCP servers" section of the settings screen if it is open. If omitted, nothing is
   * delivered (tests).
   */
  onMcpReportChanged?(report: McpGlobalReport): void
  /**
   * TODO 1301: a working folder was removed from the history (one entry or all). The history also changes when a conversation is created, but that already
   * arrives as a thread list change. The menu bar menu lists recent folders, so it follows. If omitted, nothing is delivered (tests).
   */
  onCwdHistoryChanged?(): void
  /** The cached folder list for the menu bar menu was rebuilt (`recentCwdPaths` now returns something different). */
  onTrayFoldersChanged?(): void
  /**
   * The full list of deleted threads (item 222). Called at the end of `remove` / `restore`, at the same
   * timing as `emitThreads`. It reaches **all windows**, so deleting or restoring in another window
   * updates the "Deleted (N)" fold in this one immediately. Low frequency, so sending the full list is
   * fine. If omitted, nothing is delivered (tests and window-less setups).
   */
  onDeletedThreadsChanged?(items: readonly DeletedThreadSummary[]): void
  /**
   * TODO 982: a drill stopped (and recorded) one more operation. The receiver tells the windows to fetch the drill's list again
   * (`drills.report`). Only the id; nothing of the operation. If omitted, nothing is delivered (tests).
   */
  onDrillChanged?(threadId: string): void
}

/**
 * Desktop notifications (item 72). Called only **when the thread is not on screen** (SessionManager
 * filters with `ThreadViews.isSeen`); this side only receives "queued / finished". `threadTitle` is
 * passed as an empty string when the title is provisional (main knows neither the language nor the
 * fallback text, per decision 2 of TODO 66; building the native notification is the job of `notify.ts`
 * + `index.ts`).
 */
export interface SessionManagerNotifyDeps {
  /** An approval (including a multiple-choice question) was newly queued. Not called for auto-allowed ones (T12). */
  approvalPending(threadId: string, threadTitle: string): void
  /** A turn ended. Not called for an interrupt (`ResultPayload.interrupted`). */
  turnEnded(threadId: string, threadTitle: string): void
  /**
   * The first turn of a scheduled-run (TODO 323) thread ended. `excerpt` is the start of the response
   * (redacted, whitespace collapsed, or an empty string if none). If omitted, falls back to `turnEnded`.
   * An exception to item 72's "do not show the body": owner decision 2026-10-03, "not only completion but also the start of the body".
   */
  scheduledTurnEnded?(threadId: string, threadTitle: string, excerpt: string): void
  /** A scheduled-run thread stopped awaiting approval (during its first turn). If omitted, falls back to `approvalPending`. */
  scheduledApprovalPending?(threadId: string, threadTitle: string): void
  /**
   * TODO 1216: the first (unattended) turn of a trigger-started conversation ended. The heading is the
   * trigger's name and the title, the body is the start of the response (redacted, like `scheduledTurnEnded`).
   * If omitted, falls back to `scheduledTurnEnded`.
   */
  triggeredTurnEnded?(threadId: string, triggerName: string, threadTitle: string, excerpt: string): void
  /**
   * TODO 1216: the first turn of a trigger-started conversation ended, or its process ended (whether or
   * not it is visible). A signal for `TriggerService` to start the next one in the queue.
   */
  triggerTurnSettled?(threadId: string): void
  /**
   * TODO 959: an approval for an **outbound operation** (send, post) was queued. `scheduled` tells whether
   * it is the first (unattended) turn of a scheduled run. If omitted, falls back to the two above.
   */
  outboundPending?(threadId: string, threadTitle: string, scheduled: boolean): void
  /**
   * TODO 351 (351-2): whether a scheduled-run thread "is running" changed (a `result` ended the turn, or
   * the process died with `session.exited`). `JobScheduler.isRunning` only looks at
   * `SessionManager.isThreadBusy`, so the list is pushed only around `JobScheduler`'s own `launch` /
   * edits. Without this, the `disabled` state of "Running" / "Run now" in the settings screen stays
   * after the turn ends (until it is reopened).
   */
  scheduledJobRunningChanged?(jobId: string): void
  /**
   * TODO 628 (code-review of wave 29): this thread received a conversation send (except `!`), or its
   * interruption mark was cleared. The post-release resume reservation (`JobScheduler`) is no longer
   * needed, so main removes it; do not rely on the renderer's display (the ResumeBar row disappearing).
   * Also called for the reservation's own send (the receiver excludes the reservation that is firing).
   */
  threadResumed?(threadId: string): void
}

/** Request for waking a thread and sending in a scheduled run (TODO 323). The working folder is a path (null means no owner). */
export interface ScheduledRunRequest {
  readonly jobId: string
  readonly name: string
  readonly prompt: string
  readonly cwd: string | null
  readonly modelId: string | null
  readonly thinking: ThinkingLevel | null
  readonly approvalStrict: boolean
  /**
   * TODO 972: the role (Teammate) the job starts its conversation under. When the role exists, its working folder, Model / Thinking and
   * standing instructions are used instead of the job's own `cwd` / `modelId` / `thinking`; when it is gone (deleted), the job's own values
   * are used as before. Omitted means no role.
   */
  readonly roleId?: string
}

/**
 * Request for waking a conversation and sending from a trigger (TODO 1216, 6.2.6). The working folder is a
 * path (null means no owner). `prompt` is the first message built by `composeTriggerPrompt` (the frame
 * with the unattended promise, the instructions and the text that came from outside).
 */
export interface TriggeredRunRequest {
  readonly pluginId: string
  readonly triggerId: string
  readonly triggerName: string
  readonly title: string
  readonly url: string | null
  readonly cwd: string | null
  readonly prompt: string
  readonly modelId: string | null
  readonly thinking: ThinkingLevel | null
}

/**
 * TODO 1216: deadline for approvals in an unattended turn. The read-only choke point (`GatewayRequests`)
 * refuses write operations without asking, so about the only thing that arrives here is a read tool that
 * hit the user's stop pattern. It is refused after this time so that the conversation is not held when
 * nobody answers.
 */
export const TRIGGER_APPROVAL_WAIT_MS = 30 * 60_000

/** The entry point of the automatic recovery from an auth expiry (TODO 960 / 1282, `setAuthRecovery`). */
export interface AuthRecoveryHooks {
  /** The auth-expired mark was set (or a new auth failure arrived on a marked thread), with what main knew of the stopped turn. */
  expired(threadId: string, info: ExpiryInfo): void
  cleared(threadId: string): void
  stop(): void
}

export interface SessionManagerDeps {
  readonly db: Database
  /**
   * The entry point to the thread's canonical copy. **Pass the same one as the composition root
   * (`index.ts`)**: if two are created, each `RainbowRegistry` keeps its own table of working-folder
   * colors, and a write by one overwrites the colors handed out by the other. If omitted it is created
   * here (tests).
   */
  readonly store?: ThreadStore
  /**
   * The registry (4.6.1). **The first is the default backend**, and a thread keeps which one to use in
   * `threads.backend`. At T5 there is only one implementation (just the container).
   */
  readonly adapters: readonly AgentAdapter[]
  readonly fs: FsAccess
  /** Where conversations are put into the index (6.1). The canonical copy of the body stays `thread_events` (6.5). */
  readonly index: IndexClient
  readonly gateway: GatewayServer
  /** Relay for plugin tools (TODO 847, 7.6.7). If omitted, no plugin tools are exposed (tests). */
  readonly pluginTools?: PluginToolRelay
  /**
   * TODO 1227: whether the trigger's rule (`pluginId`, `triggerId`) allows the extension tool `toolName` in
   * an unattended turn (`TriggerStore.allowsTool`). If omitted it means "allow none" (tools of
   * non-bundled extensions do not pass in an unattended turn).
   */
  readonly triggerToolAllowance?: (pluginId: string, triggerId: string, toolName: string, fingerprint: string) => boolean
  /** TODO 1225: the extension sources that the gateway's `search` can narrow by `source` (the declarations of currently enabled extensions). None if omitted. */
  readonly pluginIndexSources?: () => readonly string[]
  /** TODO 1052: the window's Web tabs (the gateway's `getOpenUrlText` / `listOpenFiles`). If omitted, Web tabs cannot be read (tests). */
  readonly webTabs?: GatewayWebTabs
  /** TODO 1052: the first-time consent to read a Web tab's body (`web.tabReadConsent`). If omitted, it asks every time. */
  readonly webTabReadConsent?: { granted(): boolean; grant(): void }
  /** TODO 1061 (1): the entry point that captures the ViewerPane rendering (the gateway's `getViewerScreenshot`). If omitted, it cannot capture (tests). */
  readonly viewerCapture?: GatewayViewerCapture
  /** The runtime and script that start the gateway (7.6). */
  readonly gatewayRuntimePath: string
  readonly gatewayScriptPath: string
  readonly gatewayConfigDir: string
  readonly events: SessionManagerEvents
  /**
   * Whether the window (`webContents.id`) is in front (TODO 71). `index.ts` passes
   * `BrowserWindow.isFocused()`. If omitted, "always in front" (tests and window-less setups).
   */
  readonly isViewFocused?: (viewId: number) => boolean
  /**
   * The entry point that runs `!` from the composer (item 116). If omitted, the real one (`/bin/zsh -lc`).
   * Tests pass a fake that returns a result without starting a shell.
   */
  readonly runShell?: ShellRunner
  /**
   * Whether the usage limit (317) has been reached (TODO 633 stage 3). If so, no bundle conversation is
   * created and a reason is returned. If omitted, false (cannot tell). `index.ts` passes it from the latest
   * `UsageTracker` value.
   */
  readonly isUsageLimited?: () => boolean
  /**
   * Whether the working folder is inside a git working copy (bundle conversation, TODO 633 stage 3). If omitted, the real git. Tests pass a fake.
   */
  readonly isGitWorkTree?: (cwdPath: string) => Promise<boolean>
  /**
   * Cleanup of worktrees that a conversation created (TODO 633 stage 1). If omitted, the real one
   * (`git/worktree-cleanup.ts`, the real git). Tests pass a throwaway repo or a fake.
   */
  readonly cleanupWorktree?: (
    target: WorktreeCleanupTarget
  ) => Promise<WorktreeCleanupVerdict | WorktreeCleanupOutcome>
  /**
   * Recreates a cleaned-up worktree on restore (a fix from the code-review of TODO 633). If omitted, the real one
   * (`recreateWorktree` in `git/worktree-cleanup.ts`, the real git).
   */
  readonly recreateWorktree?: (target: WorktreeRestoreTarget) => Promise<WorktreeRestoreVerdict>
  /**
   * The `stat` that `reconcileWorktreePresence` (TODO 714) uses to check that a worktree exists. If omitted, the real one
   * (`exists` in `git/worktree-cleanup.ts`). An entry point that lets tests create an async race.
   */
  readonly pathExists?: (path: string) => Promise<boolean>
  /**
   * Checks that a subagent's worktree exists and its commit (TODO 633 stage 2). If omitted, the real one. Tests pass a fake.
   */
  readonly subtaskWorktrees?: Partial<Pick<SubtaskWorktreeDeps, 'listWorktrees' | 'exists' | 'hasCommits'>>
  /** Desktop notifications (item 72). If omitted, none are shown (tests and setups without notifications). */
  readonly notify?: SessionManagerNotifyDeps
  /**
   * TODO 959: the next scheduled time of a scheduled-run job (epoch ms, null if none). Used for the approval
   * deadline of an unattended turn (refuse if there is no answer by the next scheduled time; owner decision
   * 2026-10-24). If omitted, no deadline.
   */
  readonly scheduledJobNextRunAt?: (jobId: string) => number | null
  /**
   * TODO 983: the name of a scheduled-run job (null if none). A conversation started by a job is treated as
   * a role (`job:<jobId>`) and shown in the approval frame's "allow this role (<job name>) from now on". If
   * the job is gone, it is not a role. If omitted, no role is created (the table is not consulted).
   */
  readonly scheduledJobName?: (jobId: string) => string | null
  /**
   * TODO 982: a scheduled prompt job's name, prompt and Teammate, for a drill of that job (`startDrill`). null for an unknown id or a job
   * that is not a prompt. If omitted, a drill cannot start from a job (only an empty drill conversation).
   */
  readonly scheduledJobPrompt?: (jobId: string) => { readonly name: string; readonly prompt: string; readonly roleId: string | null } | null
  /**
   * TODO 972: the roles (Teammates). A conversation created with `roleId` takes its defaults from the row, and every launch of a role's
   * conversation passes the row's standing instructions (read on each launch, so an edit applies from the next launch). If omitted,
   * creating with `roleId` is refused (`role-not-found`).
   */
  readonly roles?: { get(id: string): StoredRole | null }
  /**
   * If true, no backend is started and `!` is not run either (item 186). `index.ts` passes it from the
   * environment variable `AIOS_DISABLE_AGENT=1`. A safety net for proxy verification (a copy of the real
   * userData + CDP): the copy's window opens at the same position with the same threads as the real one,
   * so if a person mistakes it for the real one and types, a turn runs in the real repository (a force push
   * ran on 2026-09-27). Send, reservation and rewind are refused with the reason code `agent-disabled`,
   * and nothing is recorded.
   */
  readonly agentDisabled?: boolean
  /**
   * This profile's own scratch root (TODO 1314). Unset = the shared `~/<data name>/scratch/` (the real instance). `index.ts` passes
   * `<userData>/scratch` off the default userData (a dev instance, `npm run smoke`, a proxy-verification copy), so new scratch areas
   * never land in the real instance's root, and the launch sweep, which only looks at this root, can neither remove the real
   * instance's empty areas nor have its own removed by the real instance. Rows copied from the real profile keep pointing at the
   * shared root: they are still recognised as scratch (display, protection) but never deleted from here.
   */
  readonly scratchRoot?: string
  /**
   * Whether a backend update is running (code-review 4 of TODO 787, ARCHITECTURE 4.6.6). While true, the
   * entry point that starts the backend (`startLive`) waits until it finishes, so it never starts an
   * executable that is in the middle of being swapped. The upper bound is on the caller's side
   * (`AgentUpdateService.isUpdating()` goes back to false after 6 minutes). If omitted, it does not wait.
   */
  readonly isBackendUpdating?: () => boolean
  /**
   * TODO 1153: how long (ms) to wait for background subagents to finish after the stop button. If any remain
   * after that, the whole process is stopped. If omitted, `SUBTASK_STOP_GRACE_MS` (3 seconds). Tests shorten it.
   */
  readonly subtaskStopGraceMs?: number
}

/** TODO 983 stage 2: the key of a scheduled job's role (`job:<jobId>`). The entry points that look up or delete in the table accept only this shape (or a Teammate's, below). */
function isJobRoleKey(value: unknown): value is string {
  return typeof value === 'string' && /^job:[^\s]+$/.test(value)
}

/** TODO 983 stage 4: the key of a Teammate's rows (`role:<roleId>`, built by `roleGrantKey`). */
function isTeammateRoleKey(value: unknown): value is string {
  return typeof value === 'string' && /^role:[^\s]+$/.test(value)
}

/**
 * TODO 983: where the role permission table lives. On a DB without the table (a test fake that did not
 * apply the migration) it falls back to memory only (permissions disappear on restart, but the approval
 * entry point does not stop).
 */
function roleGrantStoreOf(db: Database): RoleGrantStore | null {
  try {
    return new RoleGrantStore(db)
  } catch (error) {
    log.warn('approval.grants.unavailable', errorFields(error))
    return null
  }
}

/**
 * TODO 959 (review): sets the deadline of an unattended turn's approval this much before the next scheduled time.
 * The scheduler checks "past the next scheduled time and still running" on a 30-second tick (`SCHEDULE_TICK_MS`)
 * and skips (`recordSkip` moves the baseline to now). A deadline exactly at the next scheduled time would race
 * with that check, so it is cut earlier than two ticks.
 */
export const SCHEDULED_APPROVAL_MARGIN_MS = 60_000

/**
 * Deadline of an unattended turn's approval (epoch ms). `startedAt` is when the turn was started, `nextRunAt`
 * is the next scheduled time at that moment (none = null -> no deadline). It is `SCHEDULED_APPROVAL_MARGIN_MS`
 * before the next scheduled time; but when the period is too short to leave that margin, it is the midpoint
 * between the start time and the next scheduled time (so the deadline never comes before the start).
 */
export function scheduledApprovalDeadline(startedAt: number, nextRunAt: number | null): number | null {
  if (nextRunAt === null || !Number.isFinite(nextRunAt)) return null
  if (nextRunAt <= startedAt) return startedAt
  return Math.max(nextRunAt - SCHEDULED_APPROVAL_MARGIN_MS, startedAt + Math.floor((nextRunAt - startedAt) / 2))
}

/**
 * Whether the model can be selected (TODO 769). Even if it is in the list, a greyed-out row that the current
 * backend version cannot use (`ModelChoice.unavailable`) is not selectable.
 */
function isSelectableModel(models: readonly ModelChoice[], id: string): boolean {
  return models.some((m) => m.id === id && m.unavailable !== true)
}

export class SessionManager {
  private readonly store: ThreadStore
  /** The latest report of the global MCP servers (item 164). The source of the "MCP servers" section of the settings screen. */
  private readonly mcpReports: McpReportRegistry
  private readonly broker: ApprovalBroker
  /** Backend id -> adapter (the registry of 4.6.1). */
  private readonly adapters = new Map<string, AgentAdapter>()
  /** The default backend (the first in the registry). Status display and probe look at this one. */
  private readonly primary: AgentAdapter
  private readonly live = new Map<string, Live>()
  /** The per-thread send queue (item 94, TODO 578 (b): send-queue.ts). */
  private readonly sendQueue: SendQueueService
  /** Process lifetime (start, evict, receive the exit; TODO 578 (c): live-lifecycle.ts). */
  private readonly lifecycle: LiveLifecycle
  /**
   * Results of `!` runs that have not yet been mixed into the next message (item 116 / 4.5.7), oldest first.
   * **Memory only** (like reservations, they do not survive a restart).
   */
  private readonly pendingShell = new Map<string, ShellRunPayload[]>()
  /** Cache of the handoff text (review of TODO 961). The key is the source thread's id, the value is the result paired with the version key. */
  private readonly handoffCache = new Map<string, { readonly key: string; readonly value: PreparedHandoff | null }>()
  /** Running `!` processes. Stopped on shutdown and on thread deletion (12.9). */
  private readonly shellRuns = new Map<string, Set<AbortController>>()
  /**
   * Exceptions (start failures) already recorded in the timeline as `error`. So that a reservation send that
   * fails does not record it twice (item 94).
   */
  private readonly recordedErrors = new WeakSet<object>()
  /**
   * Per-thread "current context usage" (item 60 / 4.5.2) = the last `turn_usage` that arrived. It does not
   * accumulate across turns. Restored from the DB (the last saved row) only the first time, then kept here.
   * `null` means "read but none found", distinguished from not yet read (`undefined`).
   */
  private readonly contextUsage = new Map<string, ContextUsage | null>()
  /**
   * Display names of subagent models (TODO 403): thread -> parent call -> display name, plus the set of calls
   * confirmed by a subagent's message. Kept outside `Live` so that, even after the process dies, finished
   * subagent blocks and rows still show it during this launch. **Not persisted** (owner default 2026-10-04:
   * no migration is added).
   */
  private readonly subagentModels = new Map<
    string,
    { readonly models: Map<string, string>; readonly confirmed: Set<string> }
  >()
  /**
   * Per-thread "breakdown of the last context usage taken" (item 155). Memory only. The choke point is looked
   * up at call time (`deps` is a constructor argument, so field initializers do not touch it directly).
   */
  private readonly contextBreakdowns = new ContextBreakdownCache((uri) => {
    try {
      this.deps.fs.assertAllowed(uri, false)
      return true
    } catch {
      return false
    }
  })
  /**
   * Per-thread latest to-do list of the parent (item 118 / 4.6.5). Like `contextUsage`, restored from the DB
   * only the first time, then replaced by the `todos` of `tool_use`. `null` means "read but none found".
   */
  private readonly todos = new Map<string, TodoList | null>()
  /**
   * "Model name -> context window limit" reported by the backend in `result` (item 60 / 74). Newer than the
   * static table (`AgentAdapter.contextWindow`), so when it arrives it overrides the denominator.
   */
  private readonly reportedWindows = new Map<string, number>()
  /**
   * Backend id -> the last reported list of commands (item 68). Replaced at `session_started`. **Memory only**,
   * and empty right after launch (no session has started yet) = no check. The thread's own list stays in
   * thread_events as the payload of `session_started`, so the renderer reads an opened thread's list from
   * there (this one is the cache for new threads).
   */
  private readonly backendCommands = new Map<string, readonly string[]>()
  /**
   * Threads being restarted because of a specified change (T7 / 4.5.1). The `live` registration disappears
   * the moment it is dropped, so a send arriving in that gap waits on this.
   */
  private readonly restarting = new Map<string, Promise<Live>>()
  /**
   * Threads whose Plan mode toggle is ON (item 112 / 4.2.3). **Memory only** (like reservations, it does not
   * survive a restart). Just before the next send, the running process's mode is aligned to this.
   */
  private readonly planModes = new Set<string>()
  /** aios session ID -> thread ID. Used to tie requests from the gateway to a thread. */
  private readonly sessionToThread = new Map<string, string>()
  /** TODO 578 (d): receiving and recording events (`onAgentEvent` / `record` / `flush`). It owns the pending saves and the 16 ms Batcher. */
  private readonly recorder: EventRecorder
  private settings: SessionSettings
  /**
   * The thread each window is showing (TODO 71). The condition for not marking unread is "shown in some
   * foreground window"; this replaced the old `activeThreadId` (one for all windows, not cleared when a
   * window closed).
   */
  private readonly views: ThreadViews
  /** Each window's "current draft URI" (item 97, second half). The policy decision is made by the caller, not here. */
  private readonly draftConflicts = new DraftConflictTracker()
  /** TODO 1061 (3): what the ViewerPane of a window (`webContents.id`) is currently showing in front (the last notice from the renderer). */
  private readonly viewerShown = new Map<number, ViewerShownReport>()
  /** TODO 832 (1): waiting for the window's reply to the gateway's openFile "open" command. */
  private readonly viewerReplies = new ViewerCommandReplies()
  /** The previous full list of approvals (item 72). The base for diffing so that only newly queued ones are notified. */
  private previousApprovals: readonly ApprovalItem[] = []
  /**
   * Threads started by a scheduled run (TODO 323) whose first turn has not finished -> the parent's last
   * response so far (used to add the start of it to the notification). **Memory only**: sessions do not
   * survive a restart. Removed at the first `result` (or the process ending); later turns go back to the
   * usual notification.
   */
  private readonly scheduledTurns = new Map<string, string>()
  /**
   * TODO 959 (review): the approval deadline of a scheduled job's unattended turn (epoch ms). **Decided once,
   * when the turn is started**, and fixed: if "the next scheduled time" were looked up again on every approval,
   * an approval after the scheduler's "skip if still running" (`recordSkip`) moved the baseline to now would
   * get a whole extra period. Effective only while the thread is in `scheduledTurns`.
   */
  private readonly scheduledDeadlines = new Map<string, number>()
  /**
   * TODO 1216: conversations started by a trigger whose first (unattended) turn has not finished -> the
   * trigger's name. **Memory only**. During this time the conversation is **read-only**: the approval choke
   * point (`GatewayRequests`) refuses writes, outbound operations and tools with side effects without asking,
   * and the adapter removes the write-type tools with launch flags (`SpawnOptions.readOnly`). Removed at the
   * first `result` or the process ending; when a person sends a follow-up, the next launch goes back to the
   * usual default (`LiveLifecycle.ensureLive` restarts because the flags differ).
   */
  private readonly unattendedTurns = new Map<string, string>()
  /**
   * TODO 521 (wave 26 bundle B): hints about interrupting the running turn (`nextInterruptHint` in
   * `interrupt.ts`). **Memory only**. Removed at `result` or the process ending.
   */
  private readonly interruptHints = new Map<string, InterruptReason>()
  /** Record of writes to the main working copy by a turn split off with a worktree (TODO 700). */
  private readonly outsideWrites = new OutsideWriteTracker()
  /** Record of worktrees confirmed to exist for subagents that run in a worktree (TODO 633 stage 2, memory only). */
  private readonly subtaskWorktrees = new SubtaskWorktrees({
    // `deps` is a constructor argument, so it is looked up at call time rather than in field initializers.
    listWorktrees: async (repoCwd) => {
      const custom = this.deps.subtaskWorktrees?.listWorktrees
      if (custom !== undefined) return custom(repoCwd)
      const result = await runGitFile(['worktree', 'list', '--porcelain'], repoCwd)
      return result.ok ? parseWorktreeList(result.stdout) : null
    },
    exists: (path) => (this.deps.subtaskWorktrees?.exists ?? pathExists)(path),
    hasCommits: (repoCwd, branch) =>
      (this.deps.subtaskWorktrees?.hasCommits ?? branchHasCommits)(repoCwd, branch),
    now: () => Date.now(),
    onChange: (threadId) => {
      if (!this.stopped) this.emitThread(threadId)
    }
  })
  /** Worktree cleanups in progress (TODO 633). Restore waits for them before recreating. */
  private readonly worktreeCleanups = new Map<string, Promise<void>>()
  /**
   * Threads manually marked unread (TODO 741). While it stays on screen (only window focus in and out),
   * `markRead` must not clear it; it is dropped only when the selection changes (`openThread`).
   */
  private readonly manuallyUnread = new Set<string>()
  /**
   * TODO 521: a copy of `threads.interrupted` (thread -> kind or null). On each body diff it checks "is there
   * anything to clear", so the DB is not queried every time. Only a thread seen for the first time is read
   * from the row. The only writer is `applyInterrupt`.
   */
  private readonly interruptedCache = new Map<string, InterruptReason | null>()
  private sweeper: ReturnType<typeof setInterval> | null = null
  /** Startup sweep of the scratch area (T23). `stop()` waits for it so that nothing touches the DB after it is closed (12.9). */
  private scratchSweep: Promise<void> | null = null
  /** Startup re-check of whether worktrees still exist (TODO 714). `stop()` waits for it (12.9). */
  private worktreeReconcile: Promise<void> | null = null
  /** Whether shutdown has begun. Once set, it is never reset (12.9). */
  private stopped = false
  /**
   * TODO 1116: a flag the shutdown procedure sets before `stop()` (`beginStop`). From then on the CLI is no
   * longer started, and the wait for an update (`waitBackendUpdate`) is skipped. Recording (`record` etc.)
   * is not stopped; that is the role of `stopped`. Once set, it is never reset.
   */
  private stopping = false
  /** TODO 1337: told when reservations change (`onReservationsChanged`), until shutdown begins. */
  private reservationsListener: (() => void) | null = null
  /** A login-status re-check in progress (TODO 893). Overlapping calls wait on it. */
  private loginRecheck: Promise<AgentStatus> | null = null
  /** TODO 960: the entry point for automatic recovery from auth expiry (`setAuthRecovery`). */
  private authRecovery: AuthRecoveryHooks | null = null
  /**
   * TODO 1282: the kind of the auth failure just recorded (thread -> kind), handed over by the event recorder right before the
   * mark is set, and taken by `applyInterrupt`. Then `authExpiries` keeps what was known when the mark was set. Memory only.
   */
  private readonly pendingAuthKinds = new Map<string, AuthFailureKind>()
  private readonly authExpiries = new Map<string, ExpiryInfo>()
  /**
   * TODO 1147: the login state last handed out for the default backend (a state where the CLI is not found
   * is not counted). Changes true -> false and false -> true are reported to `authExpiry`. null = nothing
   * handed out yet.
   */
  private lastLoggedIn: boolean | null = null
  /**
   * TODO 1147: the watcher for auth expiry. When an expiry is recognized it writes a diagnostics bundle and
   * re-checks once after 30 seconds (owner decision 2026-11-06). The adapter writes the bundle
   * (`recordAuthDiagnostics`, the only place that knows the CLI).
   */
  private readonly authExpiry = new AuthExpiryWatch({
    recheck: async () => (await this.recheckLogin()).loggedIn,
    diagnose: async (trigger, threadId) => {
      const thread = threadId === null ? null : this.store.getThread(threadId)
      const adapter = thread === null ? this.primary : this.adapterFor(thread)
      // For a conversation's auth expiry, put the result of the re-check now running (started by `applyInterrupt`) into the cache before bundling.
      if (trigger === 'interrupt-auth') await this.recheckLogin().catch(() => undefined)
      if (this.stopped) return
      await adapter.recordAuthDiagnostics?.(trigger, { threadId })
    }
  })
  /** TODO 1060: the entry point for aios's own settings tools (`setAppSettings`). Until connected, the gateway's settings tools are refused. */
  private appSettings: AgentSettings | null = null
  /** TODO 1265: the entry for the gateway's reminder tools (`setAiReminders`). Until connected, the three tools refuse. */
  private aiReminders: AiReminderGate | null = null
  /** Subscriptions to the adapter's model-list changes (item 91). Removed in `stop()`. */
  private readonly modelSubscriptions: (() => void)[] = []
  /**
   * The time limit after which a background shell is counted for eviction (item 105). **There is no UI**, so
   * it is read from `app_settings` only once at construction (assumed not to be rewritten afterwards).
   */
  private readonly backgroundShellEvictTimeoutMs: number
  /** TODO 1153: the timers that wait for background subagents to finish after the stop button (one per thread). Removed in `stop()`. */
  private readonly subtaskStopTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per window, "threads that have a draft in the Composer" (TODO 526). Protects them from deletion of abandoned threads. */
  private readonly composerDrafts = new ComposerDraftRegistry()
  /** How long until an abandoned thread is deleted (TODO 526). Read from `app_settings` only once, in the first sweep. */
  private abandonedTtlMs: number | null = null
  /** The body of the gateway entry point (TODO 578 (e), gateway-requests.ts). `handleGatewayRequest` delegates to it. */
  private readonly gatewayRequests: GatewayRequests
  /** The bundle conversation (TODO 633 stage 3, bundles.ts). */
  private readonly bundles: BundleService
  /** The body of rewind (TODO 578 (f), rewind.ts). `rewindPreview` / `rewind` delegate to it. */
  private readonly rewindService: RewindService
  /** The body of attachments (TODO 578 (g), attachments.ts). `resolveAttachment` / `composeText` delegate to it. */
  private readonly attachmentService: AttachmentService
  private readonly viewerHistoryService: ViewerHistoryService

  constructor(private readonly deps: SessionManagerDeps) {
    const first = deps.adapters[0]
    if (first === undefined) throw new Error('at least one agent adapter is required')
    for (const adapter of deps.adapters) {
      if (this.adapters.has(adapter.id)) throw new Error(`duplicate backend id: ${adapter.id}`)
      this.adapters.set(adapter.id, adapter)
    }
    this.primary = first
    this.views = new ThreadViews(deps.isViewFocused)
    // home is used to derive the cwd display name (T18). Keep it aligned with FsService's resolution.
    this.store = deps.store ?? new ThreadStore(deps.db, deps.fs.homePath, deps.scratchRoot)
    this.mcpReports = new McpReportRegistry(new AppSettingsStore(deps.db))
    // If the default model still has an id from the previous table, read it under today's alias (item 91, no migration).
    // Without the re-reading, `createThread` fails with `model-not-selectable`.
    this.settings = this.canonicalSettings(this.store.readSettings())
    this.backgroundShellEvictTimeoutMs = this.store.backgroundShellEvictTimeoutMs()
    // The version became known or changed (item 91) -> emit one status notification. The renderer takes it
    // as the cue to re-fetch the choices (`backends`) (the existing route of item 88).
    for (const adapter of deps.adapters) {
      const unsubscribe = adapter.onModelsChanged?.(() => this.onModelsChanged())
      if (unsubscribe !== undefined) this.modelSubscriptions.push(unsubscribe)
    }
    this.broker = new ApprovalBroker(
      {
        onChanged: (items) => {
          // Notify only the newly queued ones (item 72). Ignore the ones that decreased (resolved).
          // Auto-allowed requests are never queued (T12), so anything that reaches here is
          // guaranteed to need an answer.
          const added = newApprovalItems(this.previousApprovals, items)
          this.previousApprovals = items
          deps.events.onApprovalsChanged(items)
          for (const item of added) {
            if (!this.views.isSeen(item.threadId)) {
              // The first turn of a scheduled run (TODO 323) gets wording that says it "stopped awaiting approval".
              // TODO 1216: an unattended trigger turn does not use the scheduled-run wording (the usual approval notification).
              const scheduled = this.scheduledTurns.has(item.threadId) && !this.unattendedTurns.has(item.threadId)
              // TODO 959: an outbound operation gets wording that asks "may it be sent?".
              if (item.outbound != null && deps.notify?.outboundPending !== undefined) {
                deps.notify.outboundPending(item.threadId, item.threadTitle, scheduled)
              } else if (scheduled && deps.notify?.scheduledApprovalPending !== undefined) {
                deps.notify.scheduledApprovalPending(item.threadId, item.threadTitle)
              } else {
                deps.notify?.approvalPending(item.threadId, item.threadTitle)
              }
            }
          }
        },
        onDecided: (item, result) => this.onApprovalDecided(item, result)
      },
      // The approval default (T12 / 4.2). The settings screen rewrites it and the Broker uses it on the spot.
      this.store.readApprovalPolicy(),
      // Where the rules created by "always allow" are kept (T22 / 4.2.1). The Broker does not touch the DB;
      // through this entry point it reads and writes `approval.rules` in `app_settings` (T40). All are read at construction.
      this.store,
      // TODO 983: the per-role permission table (migration 43 `role_grants`). All are read at construction.
      roleGrantStoreOf(deps.db)
    )
    // TODO 1222: auto-selecting the recommended option is per conversation (default OFF). The Broker re-reads the `threads` row on every request.
    // TODO 983 stage 2: whether the tool is known to be read-only. Ask **only that conversation's adapter** (no OR). When the conversation is unknown
    // (the table listing, or a row that is not the sweep's "this conversation only"), the default adapter. If the conversation's adapter is missing or does not answer, false (no effect).
    this.broker.setReadOnlyToolLookup((toolName, threadId) => {
      const thread = threadId === null ? null : this.store.getThread(threadId)
      const adapter = thread === null ? this.primary : this.adapters.get(thread.backend)
      return adapter?.isReadOnlyTool?.(toolName) === true
    })
    // TODO 983 stage 2: at startup, sweep the "this conversation only" rows of conversations that do not exist (deleted ones, or ones whose DB deletion failed).
    this.broker.sweepOrphanThreadGrants((threadId) => this.store.getThread(threadId) !== null)
    this.broker.setStrictLookup((threadId) => this.store.getThread(threadId)?.approvalStrict === true)
    // TODO 983 stage 4: the role of a queued request is read again from `threads.role_id` when a press adds a row or a new row releases it.
    this.broker.setRoleLookup((threadId) => this.roleOf(threadId))
    // TODO 983 stage 4: at startup, sweep the rows of Teammates that do not exist (a delete whose grant rows were left behind). Keys other than role: are not touched.
    const roles = deps.roles
    if (roles !== undefined) {
      this.broker.sweepOrphanRoleGrants((roleKey) =>
        isTeammateRoleKey(roleKey) ? roles.get(roleKey.slice('role:'.length)) !== null : !String(roleKey).startsWith('role:')
      )
    }
    this.broker.setAutoPickLookup((threadId) => this.store.getThread(threadId)?.autoPickRecommended === true)
    // TODO 578 (e): the gateway entry point (`handleGatewayRequest` and its body) was split out into gateway-requests.ts.
    // To avoid exposing private fields, a set of thin closures of this shape is passed in
    // (`store` / `views` / `draftConflicts` / `deps.index` / `deps.fs` are internal-only entry points that can be passed as the real objects).
    this.bundles = new BundleService({
      isStopped: () => this.stopped,
      isAgentDisabled: () => this.deps.agentDisabled === true,
      getThread: (threadId) => this.store.getThread(threadId),
      isUsageLimited: () => this.deps.isUsageLimited?.() === true,
      isGitWorkTree:
        this.deps.isGitWorkTree ??
        (async (cwdPath) => {
          const result = await runGitFile(['rev-parse', '--is-inside-work-tree'], cwdPath)
          return result.ok && result.stdout.trim() === 'true'
        }),
      // TODO 1122: a child is created with the same backend as its parent. A backend that has no worktree launch refuses the bundle.
      supportsWorktreeLaunch: (thread) => this.adapters.get(thread.backend)?.supportsWorktreeLaunch?.() === true,
      // TODO 1106: a bundle conversation inherits the parent's OS sandbox (same as strict mode).
      // TODO 1122: if the parent's model is not in the current list (an id from an old version, etc.), create it with the default model from settings (do not fail the whole bundle).
      createThread: async ({ osSandbox, roleId, ...base }) => {
        // `inheritStrict`: the child takes the parent's strict value as-is (no OR with the Teammate's toggle; the parent may have switched it off).
        const internal = { osSandbox: osSandbox === true, inheritStrict: true }
        // TODO 972 (code-review, wave 96 fix Y): a bundle stays under the parent's Teammate; a role deleted meanwhile is dropped
        // rather than failing the bundle with `role-not-found`.
        const input = roleId !== undefined && (this.deps.roles?.get(roleId) ?? null) !== null ? { ...base, roleId } : base
        try {
          return await this.createThread(input, null, internal)
        } catch (err) {
          if (!(err instanceof Error) || !err.message.includes('model-not-selectable')) throw err
          const { modelId: _modelId, thinking: _thinking, ...rest } = input
          return this.createThread(rest, null, internal)
        }
      },
      send: (threadId, text) => this.send(threadId, { text }),
      remove: async (threadId) => {
        await this.remove(threadId)
      },
      // Code-review (wave 96 fix Y): a bundle started from an unattended turn is unattended too (also through a nested bundle).
      isUnattended: (threadId) => this.isUnattendedTurnNow(threadId),
      branchOf: (threadId) =>
        this.store.threadWorktrees(threadId).find((entry) => entry.branch !== null)?.branch ?? null,
      maxBundles: () => this.store.bundleMax(),
      hasSessionRoom: () => this.hasSessionRoom(),
      // TODO 1289 (code-review, wave 97 fix Y): the mark is a column of the child's row, so it survives a restart and a restore.
      markStartedUnattended: (threadId) => this.store.markStartedUnattended(threadId)
    })
    this.gatewayRequests = new GatewayRequests({
      bundleMax: () => this.store.bundleMax(),
      bundlePrecheck: (count, parent) => this.bundles.precheck(count, parent),
      startBundles: (parentId, bundles) => this.bundles.start(parentId, bundles),
      isStopped: () => this.stopped,
      threadIdForSession: (sessionId) => this.sessionToThread.get(sessionId),
      getThread: (threadId) => this.store.getThread(threadId),
      getAdapter: (backend) => this.adapters.get(backend),
      getLive: (threadId) => this.live.get(threadId),
      isQueueAwaitingResult: (threadId) => this.sendQueue.get(threadId)?.awaitingResult === true,
      hasPlanMode: (threadId) => this.planModes.has(threadId),
      clearPlanMode: (threadId) => this.planModes.delete(threadId),
      subtaskOfToolUse: (threadId, toolUseId) => {
        const live = this.live.get(threadId)
        return live === undefined ? null : this.recorder.subtaskOfToolUse(live, toolUseId)
      },
      record: (threadId, event) => this.record(threadId, event),
      emitThread: (threadId) => this.emitThread(threadId),
      requestApproval: (input) => this.broker.request(input),
      hasReadSecret: (threadId) => this.broker.hasReadSecret(threadId),
      cancelApprovalRequest: (threadId, match, reason) => this.broker.cancelRequest(threadId, match, reason),
      viewsOf: (threadId) => this.views.viewsOf(threadId),
      primaryViewOf: (threadId) => this.views.primaryViewOf(threadId),
      allViewEntries: () => this.views.entries(),
      onViewerCommand: (viewId, command) => this.deps.events.onViewerCommand?.(viewId, command),
      conflictingViews: (viewIds, targetUri) => this.draftConflicts.conflictsAmong(viewIds, targetUri),
      hasViewerDraft: (viewId) => this.draftConflicts.hasCurrent(viewId),
      // TODO 1061 (3): only when the window's notice is for the conversation that window is showing now (do not use a stale notice in the middle of a switch).
      viewerShown: (viewId, threadId) => {
        const report = this.viewerShown.get(viewId)
        return report !== undefined && report.threadId === threadId && this.views.threadOf(viewId) === threadId
          ? report
          : null
      },
      expectViewerReplies: (viewIds) => this.viewerReplies.expect(viewIds),
      setViewerState: (threadId, uri, highlight) => this.setViewerState(threadId, uri, highlight),
      index: this.deps.index,
      fs: this.deps.fs,
      ...(this.deps.pluginTools === undefined ? {} : { pluginTools: this.deps.pluginTools }),
      ...(this.deps.webTabs === undefined ? {} : { webTabs: this.deps.webTabs }),
      ...(this.deps.webTabReadConsent === undefined ? {} : { webTabReadConsent: this.deps.webTabReadConsent }),
      ...(this.deps.viewerCapture === undefined ? {} : { viewerCapture: this.deps.viewerCapture }),
      // TODO 1060: aios's own settings tools (7.6.8). The composition root connects it later with `setAppSettings`.
      appSettings: () => this.appSettings,
      aiReminders: () => this.aiReminders,
      // TODO 959 / 1289: an unattended turn's approval lasts until a little before the job's next scheduled time (a trigger or a bundle: a
      // fixed wait), fixed at the start of the turn; the first turn and every later unattended one (`approvalDeadlineOf`).
      approvalDeadline: (threadId) => {
        return this.approvalDeadlineOf(threadId)
      },
      // TODO 983 stage 4: a conversation's approval role is its Teammate (`role:<id>`), plus its scheduled job (`job:<jobId>`) if any. A trigger's conversation is not a role (open question 4, owner decision 2026-11-15).
      roleOf: (threadId) => this.roleOf(threadId),
      // TODO 1216: the first turn of a trigger is read-only.
      isUnattendedReadOnly: (threadId) => this.isTriggerReadOnly(threadId),
      // Code-review (wave 96 fix Y), TODO 1289: any unattended turn - the one judgment (`isUnattendedTurnNow`, 7.6.9).
      isUnattendedTurn: (threadId) => this.isUnattendedTurnNow(threadId),
      // TODO 1227: a non-bundled extension's tool only when the rule that started the conversation allowed it (limited to the tool of the extension that raised the event itself).
      unattendedPluginToolAllowed: (threadId, pluginId, toolName, fingerprint) =>
        this.triggerRuleAllowsTool(threadId, pluginId, toolName, fingerprint),
      pluginIndexSources: () => this.deps.pluginIndexSources?.() ?? [],
      // TODO 982: the drill mark is read from the DB on every request (also for a removed row), and a stop is kept with its smallest description.
      isDrill: (threadId) => this.store.drillStateOf(threadId) !== null,
      recordDrillOp: (threadId, op) => this.recordDrillOp(threadId, op)
    })
    // TODO 772: persisting the viewer's back / forward history. Only the entry point sits in manager; validation and reads/writes are in viewer-history.ts.
    this.viewerHistoryService = new ViewerHistoryService({ store: this.store, fs: this.deps.fs })
    // TODO 578 (g): attachments (`resolveAttachment` and its body) were split out into attachments.ts.
    this.attachmentService = new AttachmentService({
      store: this.store,
      fs: this.deps.fs,
      workingCwdOf: (thread) => this.workingCwdOf(thread)
    })
    // TODO 578 (f): rewind (`rewindPreview` / `rewind` and their body) was split out into rewind.ts.
    // Same shape: pass a set of thin closures that do not expose private fields.
    this.rewindService = new RewindService({
      store: this.store,
      isRewindable: (threadId) => {
        const queue = this.sendQueue.get(threadId)
        const live = this.live.get(threadId)
        const busy =
          this.restarting.has(threadId) ||
          (queue !== undefined && (queue.dispatching || queue.awaitingResult || queue.interrupting)) ||
          (live !== undefined &&
            (live.state === 'starting' || live.state === 'stopping' || live.pendingApprovals.size > 0))
        return !busy
      },
      adapterSupportsRewind: (thread) => this.adapterFor(thread).supports('rewind'),
      rewindFiles: async (thread, userMessageId, dryRun) => {
        const live = await this.liveForRewind(thread)
        return (await live.session?.rewindFiles?.(userMessageId, dryRun)) ?? null
      },
      emitThreads: () => this.emitThreads()
    })
    // TODO 578 (c): process lifetime (`ensureLive` / `startLive` / `makeRoom` / `sweepIdle` / `onAgentExit`) was split out into
    // live-lifecycle.ts. The Maps such as `live` stay in manager, and the same objects are passed in.
    this.lifecycle = new LiveLifecycle({
      store: this.store,
      live: this.live,
      restarting: this.restarting,
      sessionToThread: this.sessionToThread,
      gateway: {
        issueToken: (sessionId) => this.deps.gateway.issueToken(sessionId),
        revokeToken: (token) => this.deps.gateway.revokeToken(token),
        endpoint: (token) => ({
          socketPath: this.deps.gateway.socketPath,
          token,
          scriptPath: this.deps.gatewayScriptPath,
          runtimePath: this.deps.gatewayRuntimePath,
          configDir: this.deps.gatewayConfigDir
        })
      },
      isAgentDisabled: () => this.deps.agentDisabled === true,
      isStopped: () => this.stopped,
      isStopping: () => this.stopped || this.stopping,
      isBackendUpdating: this.deps.isBackendUpdating,
      settings: () => this.settings,
      backgroundShellEvictTimeoutMs: () => this.backgroundShellEvictTimeoutMs,
      adapterFor: (thread) => this.adapterFor(thread),
      scratchPathOf: (thread) => this.scratchPathOf(thread),
      workingCwdForSpawn: (thread) => this.workingCwdForSpawn(thread),
      launchWorktreeName: (threadId) => this.bundles.launchWorktreeName(threadId),
      roleInstructionsOf: (thread) => this.roleInstructionsOf(thread),
      osSandboxPolicy: () => this.osSandboxPolicy(),
      emitThread: (threadId) => this.emitThread(threadId),
      onAgentEvent: (threadId, event) => this.onAgentEvent(threadId, event),
      record: (threadId, event) => this.record(threadId, event),
      // TODO 529: a permission request that arrives through the backend's own entry point goes through the same entry, the same decision and the same recording as the gateway's `approve`.
      requestPermission: async (sessionId, ask) => {
        const answer = (await this.gatewayRequests.handle({
          sessionId,
          kind: 'approve',
          payload: { toolName: ask.toolName, input: ask.input, toolUseId: ask.toolUseId }
        })) as { allowed?: unknown; message?: unknown }
        return {
          allowed: answer.allowed === true,
          message: typeof answer.message === 'string' ? answer.message : ''
        }
      },
      markRecordedError: (err) => {
        this.recordedErrors.add(err)
      },
      isUnattendedReadOnly: (threadId) => this.isTriggerReadOnly(threadId),
      isDrill: (threadId) => this.store.drillStateOf(threadId) !== null,
      forgetScheduledTurn: (threadId, requested) => {
        this.scheduledTurns.delete(threadId)
        this.scheduledDeadlines.delete(threadId)
        // TODO 1216: it ended in the middle of an unattended turn. Lift the read-only restriction and let the next in the queue start.
        if (this.unattendedTurns.delete(threadId)) this.deps.notify?.triggerTurnSettled?.(threadId)
        // A bundle conversation ended in the middle of its first turn (TODO 633 stage 3): tell the parent. An exit that aios requested
        // (model switch, eviction, etc.) is resumed, so it is not the end: neither report nor stop tracking.
        if (!requested) void this.bundles.onExit(threadId)
      },
      takeInterruptHint: (threadId) => {
        const hint = this.interruptHints.get(threadId) ?? null
        this.interruptHints.delete(threadId)
        return hint
      },
      applyInterrupt: (threadId, reason, emit) => this.applyInterrupt(threadId, reason, emit),
      cancelApprovals: (threadId, reason) => this.broker.cancelThread(threadId, reason),
      scheduledJobRunningChanged: (jobId) => this.deps.notify?.scheduledJobRunningChanged?.(jobId),
      queueOf: (threadId) => this.sendQueue.get(threadId),
      setQueuePaused: (queue, paused) => {
        this.sendQueue.setPaused(queue, paused)
      },
      drainQueue: (threadId) => this.sendQueue.drain(threadId)
    })
    // TODO 578 (b): the send queue (the body of `send`, reservations, `drain`) was split out into send-queue.ts.
    // `dispatchNow` (validation, start, recording, stdin) is entangled with lifetime (c) and recording (d), so it stays in manager and is passed as a closure.
    this.sendQueue = new SendQueueService({
      store: this.store,
      isAgentDisabled: () => this.deps.agentDisabled === true,
      isStopped: () => this.stopped,
      prepareInput: (received) => (received.shell === true ? shellInputOf(received) : this.withCheckedSelection(received)),
      notifyThreadResumed: (threadId) => this.deps.notify?.threadResumed?.(threadId),
      checkSettings: async (thread, input) => {
        await this.resolveSettings(thread, input)
      },
      dispatchNow: (threadId, input, queue) => this.dispatchNow(threadId, input, queue),
      requestInterrupt: (threadId) => this.requestInterrupt(threadId),
      unattendedTurnDeadline: (threadId) => this.unattendedTurnDeadline(threadId),
      interrupt: (threadId) => this.interrupt(threadId),
      isRecordedError: (err) => err instanceof Object && this.recordedErrors.has(err),
      recordInternalError: (threadId, err) =>
        this.record(threadId, {
          id: randomUUID(),
          sessionId: this.live.get(threadId)?.sessionId ?? '',
          threadId,
          ts: Date.now(),
          actor: 'main',
          kind: 'error',
          payload: { message: err.message, code: null, origin: 'internal' }
        }),
      emitThread: (threadId) => this.emitThread(threadId),
      // TODO 1337: a copy carried over an idle restart follows memory, but never once shutdown has begun (`stop()` clears every queue).
      queueChanged: () => {
        if (!this.stopping && !this.stopped) this.reservationsListener?.()
      }
    })
    // TODO 578 (d): receiving and recording events was split out into event-recorder.ts.
    // 5.1 / spike 8: do not make one message per event (the Batcher that groups them every 16 ms lives there).
    this.recorder = new EventRecorder({
      store: this.store,
      live: this.live,
      sendQueue: this.sendQueue,
      mcpReports: this.mcpReports,
      backendCommands: this.backendCommands,
      contextUsage: this.contextUsage,
      contextBreakdowns: this.contextBreakdowns,
      todos: this.todos,
      reportedWindows: this.reportedWindows,
      scheduledTurns: this.scheduledTurns,
      unattendedTurns: this.unattendedTurns,
      interruptHints: this.interruptHints,
      outsideWrites: this.outsideWrites,
      subtaskWorktrees: this.subtaskWorktrees,
      subagentModels: this.subagentModels,
      bundles: this.bundles,
      views: this.views,
      index: this.deps.index,
      notify: this.deps.notify,
      isStopped: () => this.stopped,
      onEvents: (batch) => this.deps.events.onEvents(batch),
      onMcpReportChanged: (report) => this.deps.events.onMcpReportChanged?.(report),
      cancelApprovalRequest: (threadId, match, reason) => this.broker.cancelRequest(threadId, match, reason),
      emitThread: (threadId) => this.emitThread(threadId),
      backgroundShellEvictTimeoutMs: () => this.backgroundShellEvictTimeoutMs,
      backgroundShellsChanged: () => this.lifecycle.armShellExpiry(),
      applyWorktreeChange: (threadId, payload, at) => this.applyWorktreeChange(threadId, payload, at),
      noteWriteTarget: (threadId, name, payload, parentToolUseId) =>
        this.noteWriteTarget(threadId, name, payload, parentToolUseId),
      noteSecretRead: (threadId, name, input) => this.noteSecretRead(threadId, name, input),
      markOutsideWrite: (threadId, sessionId, hit, at) => this.markOutsideWrite(threadId, sessionId, hit, at),
      toContextUsage: (thread, usage, at) => this.toContextUsage(thread, usage, at),
      trackSubagentModel: (threadId, live, event) => this.trackSubagentModel(threadId, live, event),
      applyInterrupt: (threadId, reason, emit) => this.applyInterrupt(threadId, reason, emit),
      noteAuthFailure: (threadId, kind) => this.noteAuthFailure(threadId, kind)
    })
  }

  async start(): Promise<void> {
    // Rows deleted by the retention days are also dropped from the conversation index (TODO 860). The index process is not up yet,
    // so IndexClient queues the notice and sends it after ready.
    const pruned: { threadId: string; before: number | null }[] = []
    this.store.applyRetention(Date.now(), (threadId, before) => pruned.push({ threadId, before }))
    if (pruned.length > 0) this.deps.index.pruneConversations(pruned)
    // Sweep the scratch areas left empty (T23, 4.3.2). **Only reading the thread ids is synchronous**;
    // the directory operations go to the background without waiting, because making `start()` wait would delay the scan (`FsService.start`)
    // and the start of the index by that much. `stop()` waits for this Promise, so `this.store`
    // is never touched after the DB is closed (12.9).
    const knownThreadIds = this.store.listThreads().map((thread) => thread.id)
    this.scratchSweep = this.sweepScratch(knownThreadIds)
    // TODO 714: notice worktrees deleted outside aios. For the same reason (do not make `start()` wait) it goes to the background.
    this.worktreeReconcile = this.reconcileWorktreePresence()
    this.sweeper = setInterval(() => {
      this.sweepIdle()
      // TODO 526: on the same 1-minute period, delete abandoned threads. It runs to completion synchronously, so there is
      // nothing for `stop()` to wait for (it is not called after `clearInterval`, and if it is called anyway `stopped` makes it do nothing; 12.9).
      this.purgeAbandonedThreads()
    }, IDLE_SWEEP_MS)
    void this.refreshStatus()
    this.emitThreads()
  }

  /**
   * Waits for the startup scratch-area sweep (T23) to finish. `stop()` **makes it give up instead of waiting**
   * (it sets `stopped` first), so use this when you want to see the sweep's result itself.
   */
  async waitForScratchSweep(): Promise<void> {
    await this.scratchSweep
  }

  /** Waits for the startup worktree existence re-check (TODO 714) to finish. Same reason as `waitForScratchSweep`. */
  async waitForWorktreeReconcile(): Promise<void> {
    await this.worktreeReconcile
    // TODO 748 (b): the cleanups that the re-check re-fed (the re-check itself does not wait for them, so `stop()` is not made to wait on git).
    await Promise.all([...this.worktreeCleanups.values()])
  }

  /**
   * TODO 1116: call at the very start of the shutdown procedure (before the scheduled run's `stop`). From then
   * on the CLI is not newly started and the wait for a backend update is cut off. A scheduled run that was about
   * to start used to wait for the update to finish and block `jobScheduler.stop`, which fell into `app.exit(1)`
   * at the 30-second limit. It only sets the flag and does not touch the DB (a run that was about to start
   * writes `failed` while the DB is open).
   */
  beginStop(): void {
    this.stopping = true
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.stopped = true
    // TODO 1338: a diff waiting for a window is dropped, not delivered (12.9).
    this.gatewayRequests.dispose()
    this.authRecovery?.stop()
    this.authExpiry.stop()
    this.subtaskWorktrees.stop()
    for (const unsubscribe of this.modelSubscriptions.splice(0)) unsubscribe()
    if (this.sweeper !== null) clearInterval(this.sweeper)
    this.sweeper = null
    // TODO 1196 (wave 81 review Y): the timer at the boundary of the background shell's time limit.
    this.lifecycle.dispose()
    for (const timer of this.subtaskStopTimers.values()) clearTimeout(timer)
    this.subtaskStopTimers.clear()
    // If a sweep is running, wait for it to finish. It is built to give up early when it sees `stopped`,
    // so the wait is at most one `rmdir` (12.9).
    await this.scratchSweep
    this.scratchSweep = null
    // TODO 714: the re-check likewise (at most one `stat`).
    await this.worktreeReconcile
    this.worktreeReconcile = null
    // From here on, `record` / `emitThreads` / `onAgentEvent` / `onAgentExit` look at `stopped` and do not
    // touch the DB (item 79). So neither the continuation (a microtask) of an approval that `shutdown` resolved,
    // nor the `error` / exit raised by the CLI's termination, races with `before-quit` closing the DB after `stop()` returns.
    this.broker.shutdown()
    // TODO 832 (1): resolve the waits for openFile replies with only what has arrived.
    this.viewerReplies.dispose()
    // Stop the running `!` (item 116). The results are not recorded, because of `stopped`.
    for (const runs of this.shellRuns.values()) for (const run of runs) run.abort()
    this.shellRuns.clear()
    this.pendingShell.clear()
    this.handoffCache.clear()
    this.recorder.flushNow()
    // Write the session end time here without waiting for exit (exit does not write it, because of `stopped`).
    for (const live of this.live.values()) {
      if (live.backendSessionId !== null) this.store.finishSession(live.backendSessionId)
    }
    // TODO 928: also stop threads in the middle of a restart (momentarily absent from `live` after receiving the old one's exit).
    const threadIds = new Set([...this.live.keys(), ...this.restarting.keys()])
    await Promise.all([...threadIds].map((threadId) => this.stopThread(threadId)))
    // Flush the rest and disable further `push` (the Batcher does not re-arm its timer on a push after dispose;
    // 12.9). `record` is already stopped, so what flows here is a precautionary no-op.
    this.recorder.flushNow()
    this.recorder.dispose()
    this.recorder.clearPending()
    // Reservations are memory only (item 94). Discarded at shutdown.
    this.sendQueue.clear()
    // TODO 529: whatever the adapter holds resident (server-type backends) goes after the sessions are stopped.
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.shutdown?.()))
  }

  /**
   * `waitUpdate` (TODO 800): a read before send / rewind waits until the CLI update finishes (so that it does
   * not call an executable that is mid-swap and wrongly report "not found / not logged in"; the same idea as
   * `startLive`, in one place). The screen's status display (`agentStatus` / at startup) does not wait.
   */
  private async refreshStatus(force = false, waitUpdate = false): Promise<AgentStatus> {
    if (waitUpdate) {
      await this.lifecycle.waitBackendUpdate()
      // If shutdown began during the wait, do not start that send (live is not registered yet, so stop() cannot stop it).
      if (this.stopped || this.stopping) throw new Error('aios is shutting down')
    }
    const status = await this.primary.getStatus(force)
    this.publishStatus(status)
    return status
  }

  /**
   * Hands the default backend's status to all windows. TODO 1147: reports login-state changes (true -> false /
   * false -> true) to the watcher, whichever route (startup detection, before a send, a re-check, probe) found out; all are treated the same.
   */
  private publishStatus(status: AgentStatus): void {
    this.observeLogin(status)
    this.deps.events.onAgentStatus(status)
  }

  private observeLogin(status: AgentStatus): void {
    if (!status.available || this.stopped) return
    const before = this.lastLoggedIn
    this.lastLoggedIn = status.loggedIn
    if (before === status.loggedIn) return
    if (before === null) {
      if (!status.loggedIn) this.authExpiry.noteLoggedOutAtStart()
      return
    }
    if (status.loggedIn) this.authExpiry.noteRestored()
    else this.authExpiry.noteExpired('login-lost')
  }

  /**
   * TODO 1114: the choke point before send / rewind decides by the state of the **thread's backend** (it used
   * to always look at the default backend, so if the default CLI was missing or not logged in, conversations of
   * another backend could not be sent, and conversely they passed even when another backend was unusable).
   * `onAgentStatus` to the renderer is only for the default backend (go through `refreshStatus`). The update
   * wait is independent of the backend, like `ensureProbed`.
   */
  private async assertUsable(thread: Thread): Promise<AgentAdapter> {
    const adapter = this.adapterFor(thread)
    let status: AgentStatus
    if (adapter === this.primary) {
      status = await this.refreshStatus(false, true)
    } else {
      await this.lifecycle.waitBackendUpdate()
      // Like `refreshStatus`, also refuse once shutdown has begun (`beginStop`, TODO 1116), before getStatus / probe.
      if (this.stopped || this.stopping) throw new Error('aios is shutting down')
      status = await adapter.getStatus()
    }
    // The default wording is a reason code (7.4.4). The adapter's `message` is a remaining item (TODO 66 phase 2).
    if (!status.available) throw new Error(status.message ?? formatReason('agent-unavailable'))
    if (!status.loggedIn) throw new Error(status.message ?? formatReason('agent-not-logged-in'))
    return adapter
  }

  /** Probes in progress (item 81). Even if sends arrive from 2 threads at once, only one runs. */
  private readonly probing = new Map<AgentAdapter, Promise<void>>()

  /**
   * If the feature table has not been confirmed yet, run one probe before the send (item 81 / 4.6).
   *
   * The trigger is the **first send, not startup**, because a probe costs one session start (cache-creation
   * tokens). Merely opening the app or looking at the list does not pay it. A send that arrives while it is
   * running waits on the same Promise. **A failure does not stop the send**: the feature table stays at its
   * provisional values, and the adapter leaves the reason in `degradations`.
   */
  private async ensureProbed(adapter: AgentAdapter): Promise<void> {
    if (adapter.probe === undefined || this.stopped) return
    await this.lifecycle.waitBackendUpdate()
    if (this.stopped || this.stopping) return
    let running = this.probing.get(adapter)
    if (running === undefined) {
      const status = await adapter.getStatus()
      if (!status.needsProbe) return
      // If another send started during the await, piggyback on that one.
      running = this.probing.get(adapter)
      if (running === undefined) {
        running = this.runProbe(adapter).finally(() => this.probing.delete(adapter))
        this.probing.set(adapter, running)
      }
    }
    await running
  }

  /**
   * TODO 943: start the primary backend's probe in the background (do not wait). Called only right after the
   * CLI auto-update raised the version, so that the first send does not wait for the probe and delay showing
   * the message. If not needed (known version, already done), it does nothing. A send during the run piggybacks
   * on the same Promise through `ensureProbed`.
   */
  probeInBackground(): void {
    void this.ensureProbed(this.primary).catch(() => undefined)
  }

  private async runProbe(adapter: AgentAdapter): Promise<void> {
    if (adapter.probe === undefined) return
    // The probe session belongs to no thread. Even if an approval comes it does not pass, since it is not in
    // `sessionToThread` (it is stopped immediately at init, so it never comes in the first place).
    const label = `probe:${randomUUID()}`
    const tokens: string[] = []
    const started = Date.now()
    try {
      // cwd is home. The probe starts with the setting sources emptied, so instruction files are not read.
      const result = await adapter.probe(() => {
        const token = this.deps.gateway.issueToken(label)
        tokens.push(token)
        return {
          socketPath: this.deps.gateway.socketPath,
          token,
          scriptPath: this.deps.gatewayScriptPath,
          runtimePath: this.deps.gatewayRuntimePath,
          configDir: this.deps.gatewayConfigDir
        }
      }, this.deps.fs.homePath)
      log.info('session.probe', { backend: adapter.id, ok: result.ok, ms: Date.now() - started })
      if (adapter === this.primary && !this.stopped) this.publishStatus(result.status)
    } catch (err) {
      // A probe is promised not to turn failure into an exception, but even if it throws, the send is not stopped.
      log.warn('session.probe.failed', { backend: adapter.id, ...errorFields(err) })
    } finally {
      for (const token of tokens) this.deps.gateway.revokeToken(token)
    }
  }

  /** The adapter's model list changed (item 91). Emit one status notification and make the renderer re-fetch the choices. */
  private onModelsChanged(): void {
    if (this.stopped) return
    void this.primary.getStatus().then((status) => {
      if (!this.stopped) this.publishStatus(status)
    })
  }

  /**
   * Reads a saved model id as the id in the current list (item 91). It just turns the previous table's full
   * names into aliases; only the adapter knows which ids are old (constraint 6). Unchanged for a backend not
   * in the registry or an adapter with no such mapping.
   */
  private canonicalModel(backend: string, id: string | null): string | null {
    if (id === null) return null
    return this.adapters.get(backend)?.canonicalModelId?.(id) ?? id
  }

  /**
   * Reads the real model name the backend reported (the last response of the transcript) as an id in the list
   * (item 140). Only the adapter knows the full name -> alias mapping (constraint 6). An adapter without that
   * entry point only maps old ids (the earlier shape). null if nothing matches.
   */
  private reportedModel(adapter: AgentAdapter, model: string): string | null {
    if (adapter.modelIdForReported !== undefined) return adapter.modelIdForReported(model)
    return this.canonicalModel(adapter.id, model)
  }

  private canonicalSettings(settings: SessionSettings): SessionSettings {
    const defaultModelId = this.canonicalModel(this.primary.id, settings.defaultModelId)
    return defaultModelId === settings.defaultModelId ? settings : { ...settings, defaultModelId }
  }

  /**
   * Moves a thinking level that does not take effect on that model to the nearest level that does (item 92).
   * Same `nearestThinkingLevel` as the Composer's display. Unchanged if the model is not decided (the
   * backend's default) or the list has no information on effective levels.
   */
  private thinkingFor(
    models: readonly ModelChoice[],
    modelId: string | null,
    thinking: ThinkingLevel | null
  ): ThinkingLevel | null {
    if (thinking === null || modelId === null) return thinking
    const levels = models.find((m) => m.id === modelId)?.thinkingLevels
    return levels === undefined ? thinking : nearestThinkingLevel(thinking, levels)
  }

  /** The thread's backend. If it is not in the registry it cannot be started (the thread remains). */
  private adapterFor(thread: Thread): AgentAdapter {
    const adapter = this.adapters.get(thread.backend)
    if (adapter === undefined) {
      // The wording is in the renderer's dictionary (7.4.4, TODO 66). main returns only the reason code.
      throw reasonError('thread-backend-not-registered', { backend: thread.backend })
    }
    return adapter
  }

  /**
   * Information for the create dialog (T5). Returns, together, each backend's features (whether model /
   * thinking are available and the reason for any degradation) and the working directory history.
   */
  async createOptions(): Promise<ThreadCreateOptions> {
    return {
      backends: await this.backends(),
      defaultBackend: this.primary.id,
      homeUri: this.deps.fs.homeUri,
      cwdHistory: await this.cwdHistory()
    }
  }

  /**
   * Each backend's feature table, model list and command list (item 88 / 68). A light entry point the Composer
   * uses: `createOptions` minus the cwd history (50 `stat`s). `getStatus` returns the cache, so this costs
   * only one IPC round trip.
   */
  async backends(): Promise<readonly BackendChoice[]> {
    const backends: BackendChoice[] = []
    for (const adapter of this.adapters.values()) {
      const status = await adapter.getStatus()
      const modelSelect = status.features['model-select']
      backends.push({
        id: adapter.id,
        label: adapter.label,
        available: status.available,
        // If there is a code, use it (the renderer turns it into the display language with `describeReason`, TODO 519).
        // If not (a diagnostic line from stderr), keep the adapter's text as it is.
        message: status.messageCode ?? status.message,
        models: modelSelect ? await adapter.listModels() : [],
        modelSelect,
        thinkingLevel: status.features['thinking-level'],
        rewind: status.features['rewind'],
        capabilities: capabilitiesOf(status.features),
        degradations: status.degradations,
        // The list of the last session that started. If there is none yet, what the adapter was told right after launch
        // (including the copy from the previous launch: the hole in item 68, item 95).
        commands: this.backendCommands.get(adapter.id) ?? adapter.knownCommands?.() ?? null,
        // Item 112: whether to show the Plan toggle. Not shown for versions that cannot take a permission mode.
        ...(status.features['permission-mode'] && adapter.supportsPlanMode?.() === true
          ? { planMode: true }
          : {}),
        // TODO 1106: whether the OS sandbox toggle can be shown (if false, greyed out with a reason).
        ...(status.features['os-sandbox'] ? { osSandbox: true } : {}),
        // TODO 1288: a backend that cannot take a Teammate's standing instructions ignores them (the editor says so).
        standingInstructions: status.features['standing-instructions']
      })
    }
    return backends
  }

  /**
   * The latest report of the global MCP servers (item 164). null if no session has been started yet.
   * It does not start a process (it only reads the report cache).
   */
  mcpReport(): McpGlobalReport | null {
    return this.mcpReports.get()
  }

  /**
   * TODO 1019: the status of every backend in the registry (settings screen). The default backend goes through
   * `refreshStatus` (sharing the notification and the feature table re-fetch). The others use the adapter's
   * `getStatus` (the version plus, if any, one auxiliary line).
   * review: wait in parallel (do not stack Ollama's HTTP probe etc. serially). `force` applies only to non-defaults:
   * re-fetching the default backend is handled by the settings "re-detect" (`agentStatus(true)`), so it is not run twice from here.
   */
  async backendStatuses(force = false): Promise<readonly BackendStatusRow[]> {
    return Promise.all(
      [...this.adapters.values()].map(async (adapter): Promise<BackendStatusRow> => {
        const primary = adapter.id === this.primary.id
        return {
          id: adapter.id,
          label: adapter.label,
          primary,
          status: primary ? await this.refreshStatus(false) : await adapter.getStatus(force)
        }
      })
    )
  }

  /** TODO 1066: recommendations for local models. null for a backend not in the registry or that has none. */
  async localModelAdvice(backendId: string, force: boolean): Promise<LocalModelAdvice | null> {
    const advisor = this.adapters.get(backendId)?.localModels
    return advisor === undefined ? null : advisor.advise(force)
  }

  /** TODO 1066: only the running operations and their progress (a light entry point). */
  localModelActivity(backendId: string): readonly LocalModelActivityRow[] {
    return this.adapters.get(backendId)?.localModels?.activity() ?? []
  }

  /** TODO 1066: the recommended action (only when pressed). Does not throw. */
  async localModelAction(backendId: string, action: LocalModelAction, model: string): Promise<LocalModelActionResult> {
    const advisor = this.adapters.get(backendId)?.localModels
    if (advisor === undefined) return { ok: false, code: formatReason('local-model-unknown') }
    try {
      return await advisor.act(action, model)
    } catch (err) {
      return { ok: false, code: formatReason('local-model-failed', { message: (err as Error).message.slice(0, 300) }) }
    }
  }

  agentStatus(force = false): Promise<AgentStatus> {
    return this.refreshStatus(force)
  }

  /**
   * Re-checks only the login state and hands it to all windows (TODO 893). When the auth-expiry mark is set, and
   * when a window showing the badge returns to the front. It does not touch the version, feature table or probe
   * (separate from the "re-detect" of `agentStatus(true)`). An adapter without it just returns the state it has.
   */
  recheckLogin(): Promise<AgentStatus> {
    // Do not overlap (code-review): even if many threads stopped at once, the re-check and the delivery to all windows happen once.
    // Throttling of consecutive calls (2 seconds) is done by the adapter.
    if (this.loginRecheck !== null) return this.loginRecheck
    this.loginRecheck = (async () => {
      const status = await (this.primary.recheckLogin?.() ?? this.primary.getStatus(false))
      if (!this.stopped) this.publishStatus(status)
      return status
    })().finally(() => {
      this.loginRecheck = null
    })
    return this.loginRecheck
  }

  /**
   * The target of "open in terminal" (TODO 908). The cwd belongs to the conversation, and the CLI's name is
   * returned by the adapter (neither comes from the renderer). null if there is no conversation, no cwd, or
   * the adapter has none.
   */
  terminalTarget(
    threadId: string
  ):
    | { readonly cwd: string; readonly command: string }
    | { readonly reason: 'terminal-no-cwd' | 'terminal-no-command' } {
    const thread = this.store.getThread(threadId)
    const uri = thread === null ? '' : workingCwdUri(thread)
    if (thread === null || uri === '') return { reason: 'terminal-no-cwd' }
    const command = this.adapters.get(thread.backend)?.terminalCommand?.() ?? null
    return command === null ? { reason: 'terminal-no-command' } : { cwd: uriToPath(uri), command }
  }

  /**
   * Entry point for automatic recovery from auth expiry (TODO 960). `ipc/handlers.ts` creates `LoginRecovery` and
   * connects it. It is only called when the mark is set, cleared, or at shutdown (the recovery itself is in
   * `login-recovery.ts`).
   */
  setAuthRecovery(hooks: AuthRecoveryHooks | null): void {
    this.authRecovery = hooks
  }

  /**
   * TODO 1282: what main knew about a thread's auth expiry when the mark was set (whether signing in again can fix it, whether
   * the last input may be resent automatically, whether the conversation is unattended). null if no mark was set in this launch
   * (e.g. a mark kept from before a restart - no input is kept then).
   */
  authExpiryInfo(threadId: string): ExpiryInfo | null {
    return this.isAuthInterrupted(threadId) ? (this.authExpiries.get(threadId) ?? null) : null
  }

  /**
   * Review of TODO 1282: the threads main recorded as stopped on the login in this launch and that still hold the mark. Another
   * "Log in" puts them back into the wait after a cancel or a timeout dropped it (`LoginRecovery.start`).
   */
  authExpiredThreads(): string[] {
    return [...this.authExpiries.keys()].filter((threadId) => this.isAuthInterrupted(threadId))
  }

  /** TODO 1282: whether the id is a thread main has (the renderer's id is checked against this before it is used). */
  hasThread(threadId: string): boolean {
    return this.store.getThread(threadId) !== null
  }

  /** TODO 1282: the guidance for unattended runs, from the default backend's Adapter (words for the screen only). */
  unattendedLoginGuide(): UnattendedLoginGuide | null {
    return this.primary.unattendedLoginGuide?.() ?? null
  }

  /**
   * TODO 1282: tells the login recovery that this thread stopped on the login. What it may do is judged from main's own record
   * of the stopped turn (the send queue's flags, set from the events), never from the renderer.
   */
  private reportAuthExpiry(threadId: string, kind: AuthFailureKind): void {
    const info: ExpiryInfo = {
      relogin: kind !== 'credential',
      // TODO 982 (wave 101 review fix Y): a drill is never resent automatically (its one run reached the backend; `submit` would refuse).
      hold: this.store.drillStateOf(threadId) !== null ? 'drill' : this.sendQueue.autoResendHold(threadId),
      unattended: this.isUnattended(threadId)
    }
    this.authExpiries.set(threadId, info)
    log.info('thread.auth.expiry', { threadId, kind, hold: info.hold ?? 'none', unattended: info.unattended })
    this.authRecovery?.expired(threadId, info)
  }

  /** TODO 1282: called by the event recorder just before an auth-failed `result` sets the mark. */
  private noteAuthFailure(threadId: string, kind: AuthFailureKind): void {
    this.pendingAuthKinds.set(threadId, kind)
  }

  /** TODO 1282: an unattended conversation (a trigger before a person spoke, or the first turn of a scheduled run). */
  private isUnattended(threadId: string): boolean {
    return this.isTriggerReadOnly(threadId) || this.scheduledTurns.has(threadId)
  }

  /**
   * TODO 1289 (ARCHITECTURE 7.6.9): **the one judgment** of "nobody is watching the turn running now", for the gateway tools that refuse
   * or ask in unattended turns (reminders, `setSetting`, `openUrl`) and for marking bundles started from such a turn. True when:
   *  - `isUnattended` (a trigger before a person spoke, or the first turn of a scheduled / triggered run), or
   *  - the conversation was started without a person - by a scheduled job (`schedule_job_id`), a trigger (`trigger_origin`), or it is
   *    a bundle started from an unattended turn (`started_unattended`, code-review wave 97 fix Y), all in the DB - **and the current
   *    turn was not started by a person** (`SendQueue.turnBy`). A person's own send, reservation, Cmd+Enter interrupt and "Send again"
   *    are attended for that one turn (owner decision 2026-11-21); a bundle report, an automatic resend after re-login, "send later",
   *    a resume and a turn the backend starts by itself are unattended. None of this depends on `scheduledTurns`, which is gone once
   *    the process exits, nor on memory lost at a restart.
   * Closed side by default: a conversation with no record of the current turn's starter counts as unattended.
   */
  private isUnattendedTurnNow(threadId: string): boolean {
    if (this.isUnattended(threadId)) return true
    const thread = this.store.getThread(threadId)
    const startedUnwatched =
      (thread?.scheduledJobId !== undefined && thread.scheduledJobId !== '') ||
      thread?.triggerOrigin !== undefined ||
      this.store.isStartedUnattended(threadId)
    if (!startedUnwatched) return false
    return this.sendQueue.get(threadId)?.turnBy !== 'human'
  }

  /**
   * TODO 959 / 1289: the deadline of an approval asked now (epoch ms), or null for none. The first turn of a scheduled run or a trigger
   * keeps the deadline fixed when it was started (`scheduledDeadlines`). **Every other unattended turn has one too** (code-review,
   * wave 97 fix Y): a later automatic turn of a nightly job's conversation whose approval nobody answers would otherwise keep the
   * conversation busy and the scheduler would skip the job from then on. It is fixed once per turn (`SendQueue.turnDeadline`); an
   * approval that comes before the turn's start was seen fixes it here. An attended turn has none (as before).
   */
  private approvalDeadlineOf(threadId: string): number | null {
    if (this.scheduledTurns.has(threadId)) return this.scheduledDeadlines.get(threadId) ?? null
    if (!this.isUnattendedTurnNow(threadId)) return null
    const queue = this.sendQueue.of(threadId)
    if (queue.turnDeadline === undefined) queue.turnDeadline = this.unattendedTurnDeadline(threadId)
    return queue.turnDeadline
  }

  /**
   * TODO 1289 (code-review, wave 97 fix Y): the approval deadline for an unattended turn starting now, computed the same way as the
   * first turn's: a scheduled job's conversation until a little before the job's next scheduled time (`scheduledApprovalDeadline`;
   * no next time = no deadline, like the first turn), any other (a trigger's conversation, a bundle of an unattended turn)
   * `TRIGGER_APPROVAL_WAIT_MS`. null for an attended turn. A deadline that passes refuses the approval, as before.
   */
  private unattendedTurnDeadline(threadId: string): number | null {
    if (!this.isUnattendedTurnNow(threadId)) return null
    const now = Date.now()
    const jobId = this.store.getThread(threadId)?.scheduledJobId
    if (jobId !== undefined && jobId !== '') return scheduledApprovalDeadline(now, this.deps.scheduledJobNextRunAt?.(jobId) ?? null)
    return now + TRIGGER_APPROVAL_WAIT_MS
  }

  /**
   * TODO 1060 (7.6.8): the body of the gateway's `getSettings` / `setSetting`. The setters live in each controller,
   * so the composition root (`index.ts`), where they all exist, creates it and connects it.
   */
  setAppSettings(settings: AgentSettings | null): void {
    this.appSettings = settings
  }

  /** TODO 1265 (7.6.9): connect the gateway's reminder tools to the scheduler (created after this manager, so connected later). */
  setAiReminders(gate: AiReminderGate | null): void {
    this.aiReminders = gate
  }

  /** Whether that thread is stopped by auth expiry (TODO 960, the check before a resend). */
  isAuthInterrupted(threadId: string): boolean {
    return (this.interruptedCache.get(threadId) ?? this.store.getThread(threadId)?.interrupted ?? null) === 'interrupt-auth'
  }

  /**
   * The target of the one-line command to redo authentication in a terminal (TODO 960). The cwd belongs to the
   * conversation (home if `threadId` is null), and the command comes from the adapter's compat table (it does
   * not come from the renderer). No target is made for API key users or for an adapter that has none.
   * review: redoing authentication does not care about cwd, so when the conversation's cwd is missing, refused
   * or gone (not a directory) it also falls back to home (it does not refuse; with a vanished cwd, the `cd` in
   * the `.command` failed and only left the window open).
   */
  loginTarget(
    threadId: string | null
  ):
    | { readonly cwd: string; readonly command: string; readonly args: readonly string[] }
    | { readonly reason: 'terminal-no-command' | 'login-api-key' } {
    const thread = threadId === null ? null : this.store.getThread(threadId)
    const adapter = this.adapters.get(thread?.backend ?? this.primary.id)
    const login = adapter?.loginCommand?.() ?? null
    if (login === null) return { reason: 'terminal-no-command' }
    if (login.kind === 'api-key') return { reason: 'login-api-key' }
    const cwd = (thread === null ? null : this.usableLoginCwd(workingCwdUri(thread))) ?? homedir()
    return { cwd, command: login.command, args: login.args }
  }

  /** The cwd for `loginTarget`: the path only if it is allowed, exists and is a directory. null otherwise (= home). */
  private usableLoginCwd(uri: string): string | null {
    if (uri === '') return null
    try {
      const path = this.deps.fs.assertAllowed(uri, true, 'read')
      return statSync(path).isDirectory() ? path : null
    } catch {
      return null
    }
  }

  getSettings(): SessionSettings {
    return this.settings
  }

  setSettings(patch: Partial<SessionSettings>): SessionSettings {
    // **Close the renderer's value down to its range here** (item 86). It used to check only `typeof === 'number'`
    // and let NaN through, so `Math.min(NaN, cap)` became NaN and the concurrency limit stopped working
    // (`alive.length < NaN` is always false, and `slice(0, NaN)` is empty and does not throw).
    if (
      patch.maxConcurrent !== undefined &&
      !isIntegerIn(patch.maxConcurrent, 1, this.settings.maxConcurrentCap)
    ) {
      throw reasonError('invalid-value', { field: 'maxConcurrent' })
    }
    if (
      patch.idleTimeoutMs !== undefined &&
      !isIntegerIn(patch.idleTimeoutMs, MIN_IDLE_TIMEOUT_MS, Number.MAX_SAFE_INTEGER)
    ) {
      throw reasonError('invalid-value', { field: 'idleTimeoutMs' })
    }
    const next: SessionSettings = {
      ...this.settings,
      ...patch,
      maxConcurrentCap: this.settings.maxConcurrentCap
    }
    // The limit is a safety valve derived from memory, so settings cannot exceed it (spike 5).
    const bounded: SessionSettings = {
      ...next,
      maxConcurrent: Math.max(1, Math.min(next.maxConcurrent, next.maxConcurrentCap)),
      idleTimeoutMs: Math.max(MIN_IDLE_TIMEOUT_MS, next.idleTimeoutMs)
    }
    this.settings = this.canonicalSettings(bounded)
    this.store.writeSettings(this.settings)
    return this.settings
  }

  /** How many bundle conversations can run at once (TODO 633 stage 3 / 1060 stage 3). */
  getBundleMax(): number {
    return this.store.bundleMax()
  }

  /** From the AI's settings tool (TODO 1060 stage 3). Outside the range (1 to `BUNDLE_MAX_CAP`) it refuses without writing. */
  setBundleMax(value: number): number {
    if (!isIntegerIn(value, 1, BUNDLE_MAX_CAP)) throw reasonError('invalid-value', { field: 'bundleMax' })
    this.store.writeBundleMax(value)
    return this.store.bundleMax()
  }

  /**
   * The full list. **One SQL statement** (item 75): the accumulated values and preview come from `threads`
   * columns (migration 14), and the latest session from a subquery in the same statement. It used to add 2-3
   * statements per row (2N+1).
   */
  listSummaries(): readonly ThreadSummary[] {
    return this.store.listThreadRecords().map((record) => this.summarize(record))
  }

  private summarize(record: ThreadRecord): ThreadSummary {
    // An id from the previous table (item 91) is shown to the renderer under today's alias. The row is left as is (it is
    // rewritten at the next "from now on" send). If unchanged, pass the same object.
    const modelId = this.canonicalModel(record.thread.backend, record.thread.modelId)
    return {
      thread: modelId === record.thread.modelId ? record.thread : { ...record.thread, modelId },
      runtime: this.runtimeOf(record),
      preview: record.preview
    }
  }

  /**
   * The denominator (item 60): in the order of the value the backend reported -> the static table -> unknown (null).
   * Unknown for an implementation not in the table (an adapter without `contextWindow`) or a backend not in the registry.
   */
  private contextWindowFor(thread: Thread, model: string | null): Pick<ContextUsage, 'contextWindow' | 'windowSource'> {
    if (model === null) return { contextWindow: null, windowSource: null }
    const reported = this.reportedWindows.get(model)
    if (reported !== undefined) return { contextWindow: reported, windowSource: 'reported' }
    const adapter = this.adapters.get(thread.backend)
    const fromTable = adapter?.contextWindow?.(model) ?? null
    return fromTable === null
      ? { contextWindow: null, windowSource: null }
      : { contextWindow: fromTable, windowSource: 'table' }
  }

  private toContextUsage(thread: Thread, usage: TurnUsagePayload, at: number): ContextUsage {
    return {
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
      ...this.contextWindowFor(thread, usage.model),
      at
    }
  }

  /** Current context usage (item 60). Reads the DB (the last saved `turn_usage`) only the first time. */
  private contextUsageOf(thread: Thread): ContextUsage | null {
    const cached = this.contextUsage.get(thread.id)
    if (cached !== undefined) return cached
    const stored = this.store.latestTurnUsage(thread.id)
    const restored = stored === null ? null : this.toContextUsage(thread, stored, thread.lastEventAt ?? 0)
    this.contextUsage.set(thread.id, restored)
    return restored
  }

  /** The parent's latest to-do list (item 118). Reads the DB (the last saved rewrite) only the first time. */
  private todosOf(threadId: string): TodoList | null {
    const cached = this.todos.get(threadId)
    if (cached !== undefined) return cached
    const restored = this.store.latestTodos(threadId)
    this.todos.set(threadId, restored)
    return restored
  }

  private runtimeOf(record: ThreadRecord): ThreadRuntime {
    const thread = record.thread
    const threadId = thread.id
    const live = this.live.get(threadId)
    return {
      threadId,
      state: live?.state ?? 'idle',
      backendSessionId: live?.backendSessionId ?? record.latestBackendSessionId,
      live: live?.session?.alive === true,
      pendingApprovals: live?.pendingApprovals.size ?? 0,
      turns: record.turns,
      costUsd: record.costUsd,
      reservations: this.reservationsOf(threadId),
      contextUsage: this.contextUsageOf(thread),
      subtasks:
        live === undefined || live.subtasks.size === 0 ? NO_SUBTASKS : [...live.subtasks.values()],
      // TODO 1196: the number of background shells (the list's spinner). Omit the field entirely when 0.
      ...this.backgroundShellsOf(live),
      todos: this.todosOf(threadId),
      // Item 95: how a running process is switched. If there is none, the next launch simply starts with the new specification.
      switchRestart: live?.session?.switchRestart ?? 'always',
      // Item 112: omit the field entirely when false (do not change the shape of the existing delivery).
      ...(this.planModes.has(threadId) ? { planMode: true } : {}),
      // Item 116: the number of `!` results to mix into the next message.
      pendingShell: this.pendingShell.get(threadId)?.length ?? 0,
      // Item 259: progress of the running parent's tools. Omit the field entirely when empty.
      ...(live === undefined || live.toolProgress.size === 0
        ? {}
        : { toolProgress: [...live.toolProgress.values()] }),
      // Item 277: only during an API retry.
      ...(live?.apiRetry == null ? {} : { apiRetry: live.apiRetry }),
      // TODO 869 option C: only while waiting for an MCP connector to connect.
      ...(live === undefined || live.mcpPending <= 0 ? {} : { mcpPending: live.mcpPending }),
      // TODO 1331 item 4: only while the running session reported that the folder's provider settings are in effect.
      ...(live?.session?.folderProvider === true ? { folderProvider: true as const } : {}),
      // TODO 403: the subagents' model display names. Omit the field entirely when empty.
      ...this.subagentModelsOf(threadId),
      // TODO 633 stage 2: subagent worktrees (only those confirmed to exist).
      ...this.subagentWorktreesOf(threadId)
    }
  }

  private backgroundShellsOf(live: Live | undefined): { backgroundShells?: number } {
    if (live === undefined || live.backgroundShells.size === 0) return {}
    const count = activeBackgroundShells(live.backgroundShells, Date.now(), this.backgroundShellEvictTimeoutMs)
    return count === 0 ? {} : { backgroundShells: count }
  }

  private subagentWorktreesOf(threadId: string): { subagentWorktrees?: Readonly<Record<string, SubtaskWorktree>> } {
    const table = this.subtaskWorktrees.runtimeOf(threadId)
    return table === null ? {} : { subagentWorktrees: table }
  }

  private subagentModelsOf(threadId: string): { subagentModels?: Readonly<Record<string, string>> } {
    const entry = this.subagentModels.get(threadId)
    if (entry === undefined || entry.models.size === 0) return {}
    return { subagentModels: Object.fromEntries(entry.models) }
  }

  /**
   * Updates the subagent's model display name (TODO 403). The conversion to a display name is the adapter's job
   * (constraint 6). For an adapter without that entry point, the reported name is kept (the parent's
   * specification is not shown, because an alias cannot be a display name).
   */
  private trackSubagentModel(threadId: string, live: Live | undefined, event: AiosEvent): boolean {
    // Only the relevant rows (do not query the DB on every `turn_usage` of a parent row).
    const relevant =
      (event.kind === 'tool_use' && event.payload.subagentModel !== undefined) ||
      (event.kind === 'turn_usage' && event.actor === 'subagent')
    if (!relevant) return false
    let entry = this.subagentModels.get(threadId)
    if (entry === undefined) {
      entry = { models: new Map(), confirmed: new Set() }
      this.subagentModels.set(threadId, entry)
    }
    const thread = this.store.getThread(threadId)
    const adapter = thread === null ? undefined : this.adapters.get(thread.backend)
    const label = (model: string): string | null =>
      adapter?.modelLabel === undefined ? null : adapter.modelLabel(model)
    return applySubagentModel(live?.subtasks ?? new Map(), entry.models, entry.confirmed, event, label)
  }

  /** Turns reservations into a light shape for the renderer (item 94). The attachment contents are not included. */
  private reservationsOf(threadId: string): readonly Reservation[] {
    const queue = this.sendQueue.get(threadId)
    if (queue === undefined || queue.items.length === 0) return NO_RESERVATIONS
    return queue.items.map((item) => ({
      id: item.id,
      preview: item.input.text.replace(/\s+/g, ' ').trim().slice(0, RESERVATION_PREVIEW_CHARS),
      // A selection (item 97) also counts as one attachment.
      attachments: (item.input.attachments?.length ?? 0) + (item.input.selection === undefined ? 0 : 1),
      interrupt: item.interrupt,
      createdAt: item.createdAt
    }))
  }

  /** Hands out the full list (item 75). Used only on start, create, delete, rename and clearing all logs. */
  private emitThreads(): void {
    // After shutdown, do not read the DB (item 79 / 12.9).
    if (this.stopped) return
    this.deps.events.onThreadsChanged(this.listSummaries())
  }

  /**
   * Hands out the full list of deleted threads (item 222). Called at the end of `remove` / `restore`, at the
   * same timing as `emitThreads()`. After shutdown it does not read the DB (item 79 / 12.9, same as `emitThreads`).
   */
  private emitDeletedThreads(): void {
    if (this.stopped) return
    this.deps.events.onDeletedThreadsChanged?.(this.store.listDeletedThreads())
  }

  /**
   * Hands out only one thread (item 75). The SQL is one primary-key statement. Use this for high-frequency
   * triggers (`turn_usage` comes on every assistant row), and put no work proportional to the thread count N here.
   * If there is no row (logically deleted), do nothing; deletion is reported by `emitThreads` with the full list.
   */
  private emitThread(threadId: string): void {
    if (this.stopped) return
    const record = this.store.getThreadRecord(threadId)
    if (record === null) return
    this.deps.events.onThreadChanged(this.summarize(record))
  }

  /**
   * Creates a thread (from the T5 dialog). The backend / modelId / thinking that came from the renderer are
   * **re-validated here**: a backend not in the registry or a model not in the list is rejected.
   */
  async createThread(
    input: CreateThreadInput,
    scheduleJobId: string | null = null,
    /**
     * Specifications only inside main (they do not come from the renderer's create request). Omitting `osSandbox`
     * means "ON for a scheduled job" (TODO 1106).
     * `deferCwdHistory` (TODO 1118): delays adding to the working-folder history (`touchCwd`) until the first
     * send (`dispatchNow`). When a first-time folder (with the notice of item 123) is opened via `aios://new`,
     * adding it at creation time would suppress both the band above the conversation's Composer and the band
     * shown when the same folder is later chosen from the create dialog.
     */
    internal: {
      readonly osSandbox?: boolean
      readonly deferCwdHistory?: boolean
      /**
       * Code-review (wave 97 fix X): the caller passes a parent's strict value to inherit (a bundle child). The Teammate's strict
       * setting is then NOT OR-ed in, so a conversation where the user switched strict OFF keeps its children OFF. Internal only:
       * it is not part of `CreateThreadInput`, so a renderer cannot send it.
       */
      readonly inheritStrict?: boolean
      /** TODO 1216: the origin of a conversation started by a trigger (the mark in the list, the link in the heading). */
      readonly triggerOrigin?: TriggerOrigin
      /** TODO 982: a drill conversation (`startDrill` only; not part of `CreateThreadInput`, so a renderer cannot ask for or omit it). */
      readonly drill?: boolean
    } = {}
  ): Promise<Thread> {
    if (input.transcript !== undefined) return this.createThreadFromTranscript(input)
    // TODO 972: a conversation under a role. The role is looked up again here (the renderer's id is only a key), and what the request leaves
    // out comes from the role: the working folder (none -> a scratch area) and Model / Thinking. The role's folder was checked when the role
    // was saved; it is checked again (`assertAllowed`) since an exclusion may have been added since.
    const role = input.roleId === undefined ? null : (this.deps.roles?.get(input.roleId) ?? null)
    if (input.roleId !== undefined && role === null) throw reasonError('role-not-found')
    if (role !== null && input.cwdUri === undefined && input.scratch !== true) {
      if (role.cwd === null) input = { ...input, scratch: true }
      else {
        const cwdUri = pathToUri(role.cwd)
        this.deps.fs.assertAllowed(cwdUri, true)
        input = { ...input, cwdUri }
      }
    }
    if (role !== null) {
      input = {
        ...input,
        ...(input.modelId === undefined && role.modelId !== null ? { modelId: role.modelId } : {}),
        ...(input.thinking === undefined && role.thinking !== null ? { thinking: role.thinking } : {})
      }
    }
    const id = randomUUID()
    // No owner (throwaway) (T19 / TODO 24): cwd is a scratch area dedicated to the thread. **It is not created here**
    // (merely asking a question must not multiply empty directories). It is created right before the first spawn (`startLive`).
    // The meaning of omitting `cwdUri` = home is unchanged (home is chosen explicitly as one history entry).
    const scratch = input.scratch === true
    if (scratch && input.cwdUri !== undefined) {
      throw reasonError('scratch-with-cwd')
    }
    const cwd = scratch
      ? scratchCwd(this.deps.fs.homePath, id, this.deps.scratchRoot)
      : input.cwdUri === undefined
        ? this.deps.fs.homePath
        : uriToPath(input.cwdUri)
    const adapter =
      input.backend === undefined ? this.primary : this.adapters.get(input.backend)
    if (adapter === undefined) throw reasonError('backend-not-registered')

    // If omitted, inherit the default from settings. An explicit null means "the backend's default".
    let modelId = this.canonicalModel(
      adapter.id,
      input.modelId === undefined ? this.settings.defaultModelId : input.modelId
    )
    let thinking = input.thinking === undefined ? this.settings.defaultThinking : input.thinking
    if (thinking !== null && !isThinkingLevel(thinking)) throw new Error('unknown thinking level')
    if (modelId !== null) {
      const models = await adapter.listModels()
      // Code-review (wave 96 fix Y): the role's saved Model (filled in above, or sent back as-is by the renderer) may have left the list
      // (a version update). Fall back to the settings' default instead of failing every conversation and job of that Teammate.
      if (!isSelectableModel(models, modelId) && role !== null && role.modelId !== null && input.modelId === role.modelId) {
        const fallback = this.canonicalModel(adapter.id, this.settings.defaultModelId)
        log.info('thread.role.modelFallback', { roleModel: true, fallback: fallback !== null })
        modelId = fallback
      }
      if (modelId !== null && !isSelectableModel(models, modelId)) throw reasonError('model-not-selectable')
      // A level that does not take effect on that model is saved moved to a level that does (item 92).
      thinking = this.thinkingFor(models, modelId, thinking)
    }

    // The default reference range (the table in 4.4). **= the range readable without approval**, so cwd is always included.
    const allowed = new Set<string>(this.deps.fs.defaultReferenceDirs())
    allowed.add(cwd)
    // TODO 1106 (owner decision 2026-11-03): an unattended thread (scheduled job) has the OS sandbox ON by default, an interactive thread OFF.
    // TODO 1109 item 1 / 983 stage 4 (owner decision 2026-11-21): a conversation under a Teammate is ON by default too (by hand or from a job;
    // it can still be switched off with the conversation's ellipsis menu). A bundle child / branch passes its parent's value explicitly.
    // If the backend lacks it (version, environment), create it with OFF; creating it ON would make that conversation refuse to start and be unable to send.
    const wantSandbox = internal.osSandbox ?? (scheduleJobId !== null || role !== null)
    const osSandbox = wantSandbox && (await adapter.getStatus()).features['os-sandbox']
    // The title is cut at the same limit as rename (item 86). If empty it becomes the provisional title and is named at the first send.
    const title = input.title?.trim().slice(0, MAX_TITLE) ?? ''
    const thread = this.store.createThread({
      id,
      title: title === '' ? DEFAULT_TITLE : title,
      titleAuto: title === '',
      cwd,
      allowedDirs: [...allowed],
      retention: this.settings.defaultRetention,
      // Record only (item 109): not read at launch; the CLI reads the same 3 as the stock CLI (4.6.4).
      settingSources: DEFAULT_SETTING_SOURCES,
      backend: adapter.id,
      modelId,
      thinking,
      // Strict mode (T12). For the renderer's value, anything other than a boolean falls to false.
      // TODO 983 stage 4 (owner decision 2026-11-21): a Teammate with strict mode ON starts all its conversations strict; combined with
      // the request's (or the job's) value by OR - the closing side. Read from main's row, not from the renderer.
      // Not for a bundle child (`internal.inheritStrict`): it takes the parent's value, which the user may have switched off.
      approvalStrict: input.approvalStrict === true || (internal.inheritStrict !== true && role?.approvalStrict === true),
      osSandbox,
      // The scheduled-run job (TODO 323). It does not come from the renderer's create request (the argument is only inside main).
      scheduleJobId,
      ...(internal.triggerOrigin === undefined ? {} : { triggerOrigin: internal.triggerOrigin }),
      ...(role === null ? {} : { roleId: role.id })
    })
    // TODO 982: the drill mark goes on before anything can send to the conversation (this is synchronous after the insert).
    if (internal.drill === true) this.store.markDrill(id)
    const created = internal.drill === true ? (this.store.getThread(id) ?? thread) : thread
    // History (TODO 6). So that it can be chosen in the next dialog. A scratch area is not added to the history
    // (the path differs per thread, so choosing it again is meaningless).
    // The subtree scan (item 246) has the same condition. A scratch area is empty right after `startLive`'s `mkdir`,
    // and as its contents grow the watcher picks them up (the scratch area is `~/aios/scratch` = under home).
    if (!scratch) {
      // TODO 1118: mark a deferred conversation (the first send and the conversation's band look only at this mark).
      if (internal.deferCwdHistory === true) this.store.markCwdHistoryDeferred(thread.id)
      else this.store.touchCwd(cwd)
      this.requestCwdScan(cwd)
      if (internal.deferCwdHistory !== true) void this.refreshTrayFolders()
    }
    log.info('thread.created', {
      threadId: thread.id,
      backend: adapter.id,
      model: modelId !== null,
      thinking,
      strict: thread.approvalStrict,
      sandbox: osSandbox,
      ...(wantSandbox && !osSandbox ? { sandboxUnavailable: true } : {}),
      scratch,
      ...(internal.deferCwdHistory === true && !scratch ? { cwdHistoryDeferred: true } : {}),
      allowedDirs: allowed.size,
      scheduled: scheduleJobId !== null,
      ...(internal.triggerOrigin === undefined ? {} : { triggered: true }),
      ...(role === null ? {} : { role: true }),
      ...(internal.drill === true ? { drill: true } : {})
    })
    this.emitThreads()
    return created
  }

  // ---- Drills (TODO 982 / 1292 item 2, ARCHITECTURE 4.2.5 "drill") ----

  /**
   * Starts a drill of a Teammate: a new conversation under it, marked as a drill in the DB before anything is sent, with the OS sandbox ON
   * when the backend has it (a second line under the gateway's stop). With `jobId` (a prompt job that belongs to this Teammate) the job's
   * prompt is sent at once as the one run - **a person pressed the button, so the turn is attended** (`human`); without it the conversation
   * waits for the one message the person types. Both ids are looked up again here (the renderer's values are only keys).
   * The run uses the real model, so it uses quota (the button says so; no cost is shown, constraint 4).
   */
  async startDrill(roleId: unknown, jobId: unknown): Promise<string> {
    if (this.stopped || this.stopping) throw new Error('aios is shutting down')
    if (this.deps.agentDisabled === true) throw reasonError('agent-disabled')
    if (typeof roleId !== 'string' || roleId === '' || roleId.length > 200) throw reasonError('invalid-value', { field: 'roleId' })
    if (jobId !== null && (typeof jobId !== 'string' || jobId === '' || jobId.length > 200)) throw reasonError('invalid-value', { field: 'jobId' })
    const role = this.deps.roles?.get(roleId) ?? null
    if (role === null) throw reasonError('role-not-found')
    // A backend that cannot launch a drill (its narrowing flags, a fixed permission mode, the approval tool) gets none (closing side).
    // The launch checks again (`SpawnOptions.drill`), so a conversation whose backend changed later does not start either.
    await this.primary.getStatus()
    if (this.primary.supportsDrill?.() !== true) throw reasonError('drill-unsupported')
    let prompt: string | null = null
    let title: string | undefined
    if (jobId !== null) {
      const job = this.deps.scheduledJobPrompt?.(jobId) ?? null
      if (job === null || job.roleId !== role.id) throw reasonError('drill-not-teammate')
      prompt = job.prompt
      title = job.name
    }
    const thread = await this.createThread(
      { roleId: role.id, backend: this.primary.id, ...(title === undefined ? {} : { title }) },
      null,
      { osSandbox: true, drill: true }
    )
    log.info('drill.started', { threadId: thread.id, job: jobId !== null })
    if (prompt !== null) {
      try {
        await this.send(thread.id, { text: prompt }, 'human')
      } catch (err) {
        // The conversation stays; the caller shows the reason. If nothing reached the backend (settings, login, launch) the drill is
        // `ready` again and the person can send from its prompt box; otherwise it is `ran` (wave 101 review fix Y).
        log.warn('drill.send.failed', { threadId: thread.id, ...errorFields(err) })
        throw err
      }
    }
    return thread.id
  }

  /**
   * TODO 982: keeps one operation the gateway stopped in a drill. Builds the smallest description (`describeDrillStop`) and what "allow
   * from now on" would add for the drill's Teammate (`role:<id>` only, owner decision 2026-11-23), judged by the Broker with the approval
   * frame's own lines (`drillGrantProposal`). The store masks and keeps it. Nothing of the body is kept.
   */
  private recordDrillOp(threadId: string, stop: DrillStop): void {
    if (this.stopped) return
    const thread = this.store.getThread(threadId)
    if (thread === null) return
    const adapter = this.adapters.get(thread.backend)
    const cwd = this.workingCwdOf(thread)
    const described = describeDrillStop(adapter, stop.toolName, stop.input, cwd)
    const proposal = this.drillProposal(thread, adapter, stop, cwd)
    const stored = this.store.addDrillOp({
      id: randomUUID(),
      threadId,
      at: Date.now(),
      toolUseId: stop.toolUseId,
      toolName: stop.toolName,
      target: described.target,
      subject: described.subject,
      size: described.size,
      grantCandidates: proposal !== null && 'candidates' in proposal ? proposal.candidates : null,
      grantRefusal: proposal !== null && 'refused' in proposal ? proposal.refused : null
    })
    if (!stored) log.info('drill.op.capped', { threadId })
    this.deps.events.onDrillChanged?.(threadId)
  }

  /** What "allow from now on" would add for a stopped op, or why nothing. null when the conversation has no live Teammate. */
  private drillProposal(
    thread: Thread,
    adapter: AgentAdapter | undefined,
    stop: DrillStop,
    cwd: string
  ): ReturnType<ApprovalBroker['drillGrantProposal']> | null {
    const role = thread.roleId === undefined ? null : (this.deps.roles?.get(thread.roleId) ?? null)
    if (role === null) return null
    const key = roleGrantKey(role.id)
    const input = stop.input
    const { toolName } = stop
    const bare = toolName.startsWith(GATEWAY_TOOL_PREFIX) ? toolName.slice(GATEWAY_TOOL_PREFIX.length) : null
    const plugin = bare === null ? null : (this.deps.pluginTools?.lookup(bare) ?? null)
    const outbound = adapter?.outboundAction?.(toolName, input) ?? null
    const persistence = adapter?.persistenceAction?.(toolName, input, (path) => resolvedWritePaths(path, cwd)) ?? null
    const secretRead = adapter?.secretReadAction?.(toolName, input) ?? null
    const egress = adapter?.egressAction?.(toolName, input) ?? null
    const plan = adapter?.planProposal?.(toolName, input) ?? null
    return this.broker.drillGrantProposal({
      threadId: thread.id,
      threadTitle: thread.title,
      toolName,
      summary: '',
      input,
      strict: true,
      plan,
      planRequested: plan !== null,
      ...(plugin !== null && plugin.sideEffect ? { alwaysAsk: true } : {}),
      ...(outbound === null ? {} : { outbound }),
      ...(persistence === null ? {} : { persistence }),
      ...(secretRead === null ? {} : { secretRead }),
      ...(egress === null ? {} : { egress }),
      role: { key, name: role.name, kind: 'teammate', keys: [key] },
      grantSubject: adapter?.grantSubjectOf?.(toolName, input, (path) => resolvedGrantPath(path, cwd)) ?? null
    })
  }

  /**
   * TODO 982: the list shown after a drill: the operations it stopped, then the calls the backend ran without asking aios (found from the
   * saved tool calls; aios cannot stop those, so they are shown rather than hidden). null for a conversation that is not a drill.
   */
  drillReport(threadId: unknown): DrillReport | null {
    if (typeof threadId !== 'string' || threadId === '' || threadId.length > 200) throw reasonError('invalid-value', { field: 'threadId' })
    const thread = this.store.getThread(threadId)
    if (thread === null || thread.drill === undefined) return null
    const role = thread.roleId === undefined ? null : (this.deps.roles?.get(thread.roleId) ?? null)
    const rows = this.store.drillOps(threadId)
    const stopped = rows.map((row) => drillOpView(row, role !== null))
    const adapter = this.adapters.get(thread.backend)
    // The stopped ops are written at once, their timeline rows in the next 16 ms batch: count the stopped ones as asked too, so a stop is
    // never shown as "ran without asking" in between.
    const events = this.store.drillToolEvents(threadId)
    const asked = new Set(events.asked)
    for (const row of rows) if (row.toolUseId !== null) asked.add(row.toolUseId)
    const unasked = unaskedDrillOps(adapter, { ...events, asked }, this.workingCwdOf(thread))
    const ops = [...stopped, ...unasked].sort((a, b) => a.at - b.at)
    return { threadId, state: thread.drill, roleId: role?.id ?? null, roleName: role?.name ?? null, ops }
  }

  /**
   * TODO 1292 item 2: "allow the ticked ones from now on". **Only the ids come from the renderer**; everything else is main's: the ops must be
   * this drill's own stopped ops with candidates main decided when it stopped them, not allowed yet; the key is `role:<id>` of the drill's
   * Teammate now (gone -> `role-not-found`); every row is validated again (`sanitizeGrantRow`) and added `forever` with `source: 'drill'`.
   * A stage 0 kind never has candidates, so it cannot be added. Returns the report after the change.
   */
  grantDrillOps(threadId: unknown, opIds: unknown): DrillReport | null {
    if (typeof threadId !== 'string' || threadId === '' || threadId.length > 200) throw reasonError('invalid-value', { field: 'threadId' })
    if (!Array.isArray(opIds) || opIds.length === 0 || opIds.length > MAX_DRILL_OPS) throw reasonError('invalid-value', { field: 'opIds' })
    const wanted = new Set<string>()
    for (const id of opIds) {
      if (typeof id !== 'string' || id === '' || id.length > 200) throw reasonError('invalid-value', { field: 'opIds' })
      wanted.add(id)
    }
    const thread = this.store.getThread(threadId)
    if (thread === null || thread.drill === undefined) throw reasonError('invalid-value', { field: 'threadId' })
    const role = thread.roleId === undefined ? null : (this.deps.roles?.get(thread.roleId) ?? null)
    if (role === null) throw reasonError('role-not-found')
    const entries: { toolName: string; candidates: readonly GrantCandidate[] }[] = []
    const granted: string[] = []
    for (const row of this.store.drillOps(threadId)) {
      if (!wanted.has(row.id) || row.grantedAt !== null || row.threadId !== threadId) continue
      const candidates = parseDrillCandidates(row.grantCandidates)
      if (candidates === null) continue
      entries.push({ toolName: row.toolName, candidates })
      granted.push(row.id)
    }
    if (entries.length > 0) {
      const added = this.broker.addDrillGrants(roleGrantKey(role.id), threadId, entries)
      // Nothing could be written: the ops stay unticked-able (the person can press again), nothing is marked.
      if (added === null) throw reasonError('internal-error')
      this.store.markDrillOpsGranted(threadId, granted, Date.now())
      log.info('drill.granted', { threadId, ops: granted.length, rows: added.length })
    }
    return this.drillReport(threadId)
  }

  // ---- Scheduled runs (TODO 323, ARCHITECTURE.md 6.2.4) ----

  /**
   * Starts a **new thread** from a scheduled-run job and sends the prompt (it does not continue with `--resume`;
   * owner decision 2026-10-03). The title is the job name, and the list shows a clock mark (`threads.schedule_job_id`).
   * Approval uses the same default as an ordinary thread (167); only the job's "strict mode" is passed.
   *
   * If it could not be sent (not logged in, concurrency limit, a model not in the list...), the just-created
   * empty thread is logically deleted and the error is thrown; the caller (`JobScheduler`) leaves the reason in the list.
   */
  async runScheduledJob(request: ScheduledRunRequest): Promise<string> {
    if (this.stopped) throw new Error('aios is shutting down')
    // Item 186: a verification copy does not even create threads (it could not send them anyway).
    if (this.deps.agentDisabled === true) throw reasonError('agent-disabled')
    // TODO 972: a job under a role that still exists starts the conversation from the role (folder, Model / Thinking come from the role in
    // `createThread`). A role that is gone falls back to the job's own values - the job keeps running as it did before roles existed.
    const role = request.roleId === undefined ? null : (this.deps.roles?.get(request.roleId) ?? null)
    const thread = await this.createThread(
      role !== null
        ? { roleId: role.id, title: request.name, approvalStrict: request.approvalStrict }
        : {
            ...(request.cwd === null ? { scratch: true } : { cwdUri: pathToUri(request.cwd) }),
            title: request.name,
            modelId: request.modelId,
            thinking: request.thinking,
            approvalStrict: request.approvalStrict
          },
      request.jobId
    )
    this.scheduledTurns.set(thread.id, '')
    // TODO 959 (review): decide the unattended turn's approval deadline once, here (the scheduler has already advanced
    // its baseline before starting, so what can be looked up is the next run).
    const deadline = scheduledApprovalDeadline(Date.now(), this.deps.scheduledJobNextRunAt?.(request.jobId) ?? null)
    if (deadline === null) this.scheduledDeadlines.delete(thread.id)
    else this.scheduledDeadlines.set(thread.id, deadline)
    try {
      await this.send(thread.id, { text: request.prompt })
    } catch (err) {
      this.scheduledTurns.delete(thread.id)
      this.scheduledDeadlines.delete(thread.id)
      if (!this.stopped) {
        await this.remove(thread.id).catch((removeErr: unknown) =>
          log.warn('schedule.thread.remove.failed', { threadId: thread.id, ...errorFields(removeErr) })
        )
      }
      throw err
    }
    log.info('schedule.thread.started', { jobId: request.jobId, threadId: thread.id })
    return thread.id
  }

  // ---- Triggers (TODO 1216, ARCHITECTURE 6.2.6) ----

  /**
   * Starts a **new conversation** from one event that an extension reported and sends the first message (called by
   * `TriggerService`). Same shape as a scheduled run (`runScheduledJob`); the differences are:
   *  - The mark in the list is `threads.trigger_origin` (extension, trigger, source URL).
   *  - **The first turn is unattended and read-only** (`unattendedTurns`). The OS sandbox is ON by default (for a backend without it, create with OFF and log).
   *  - The approval deadline is `TRIGGER_APPROVAL_WAIT_MS` (there is no next scheduled time).
   * If it could not be sent, the just-created empty conversation is logically deleted and the error is thrown
   * (the caller writes `failed` and retries within the allowed count).
   */
  async runTriggered(request: TriggeredRunRequest): Promise<string> {
    if (this.stopped || this.stopping) throw new Error('aios is shutting down')
    if (this.deps.agentDisabled === true) throw reasonError('agent-disabled')
    const thread = await this.createThread(
      {
        ...(request.cwd === null ? { scratch: true } : { cwdUri: pathToUri(request.cwd) }),
        title: request.title,
        modelId: request.modelId,
        thinking: request.thinking,
        approvalStrict: false
      },
      null,
      {
        osSandbox: true,
        triggerOrigin: {
          pluginId: request.pluginId,
          triggerId: request.triggerId,
          ...(request.url === null ? {} : { url: request.url })
        }
      }
    )
    this.scheduledTurns.set(thread.id, '')
    this.unattendedTurns.set(thread.id, request.triggerName)
    this.scheduledDeadlines.set(thread.id, Date.now() + TRIGGER_APPROVAL_WAIT_MS)
    try {
      await this.send(thread.id, { text: request.prompt })
    } catch (err) {
      this.scheduledTurns.delete(thread.id)
      this.scheduledDeadlines.delete(thread.id)
      this.unattendedTurns.delete(thread.id)
      if (!this.stopped) {
        await this.remove(thread.id).catch((removeErr: unknown) =>
          log.warn('trigger.thread.remove.failed', { threadId: thread.id, ...errorFields(removeErr) })
        )
      }
      throw err
    }
    log.info('trigger.thread.started', { pluginId: request.pluginId, triggerId: request.triggerId, threadId: thread.id })
    return thread.id
  }

  /** TODO 1216: whether that conversation's first (unattended) turn has not yet finished. */
  isUnattendedTurn(threadId: string): boolean {
    return this.unattendedTurns.has(threadId)
  }

  /**
   * TODO 628 (code-review of wave 29): whether the thread still has an interruption mark (TODO 521). The
   * post-release resume reservation checks it just before firing (if none or cleared, do not send). False if the thread does not exist.
   */
  isThreadInterrupted(threadId: string): boolean {
    // The copy (`interruptedCache`) comes first: if the DB write does not change, it is skipped (`applyInterrupt`).
    const cached = this.interruptedCache.get(threadId)
    if (cached !== undefined) return cached !== null
    const thread = this.store.getThread(threadId)
    return thread !== null && thread.interrupted !== undefined
  }

  /**
   * Whether the thread is still running (for a scheduled run's "skip if the previous one is still running"). Any
   * of: in the middle of a send, responding, a reservation remains, awaiting approval, in the middle of a restart.
   */
  isThreadBusy(threadId: string): boolean {
    const queue = this.sendQueue.get(threadId)
    if (queue !== undefined && (queue.dispatching || queue.awaitingResult || queue.items.length > 0)) {
      return true
    }
    if (this.restarting.has(threadId)) return true
    const live = this.live.get(threadId)
    return live !== undefined && (live.state === 'starting' || live.pendingApprovals.size > 0)
  }

  /**
   * If something blocks the auto-update idle restart (TODO 103, ARCHITECTURE 8.5), returns its kind (a short
   * word for the log); null if nothing does. The conditions are the same as for eviction (`isEvictable`):
   * no responding, awaiting approval, subagents, or just-started background shells, plus what a restart would
   * lose: reservations, being mid-send (item 94), mid-restart, and a running `!` plus results not yet mixed into the
   * next message (memory only, item 116).
   *
   * TODO 1333: the **Composer draft is no longer here**: `CarriedDraftsService` carries it over the restart (it comes back on the next launch); the update
   * service asks `hasDrafts()` and carries it right before restarting, and a draft that cannot be carried keeps the restart waiting (`update-wait-draft`).
   * **The viewer's unsaved drafts still block** ('viewer-draft': item 97 and the table of files switched away from, TODO 312 - they are not carried, owner decision
   * 2026-11-26). `ignoreBackgroundShells` (set once the installed version is an hour old, owner decision 2026-11-26) stops background shells from blocking;
   * mid-send, a running `!` and responses always block.
   * TODO 1337: **stopped reservations that can be carried no longer block** (`CarriedReservationsService` carries them over the restart, owner decision
   * 2026-11-26) - at once, not after an hour. A queue that moves by itself (`queue`) and a stopped one that cannot be carried (`queue-uncarriable`:
   * an attachment, a selection, over the limits) still block, however long it has been.
   * Blocks if the state is not `idle` / `error` even when no process exists.
   */
  restartBlocker(
    now = Date.now(),
    options: { readonly ignoreBackgroundShells?: boolean } = {}
  ): 'session' | 'queue' | 'queue-uncarriable' | 'shell' | 'viewer-draft' | null {
    const activity = this.activityBlockerWith(now, options.ignoreBackgroundShells === true, true)
    if (activity !== null) return activity
    return this.draftConflicts.hasAny() ? 'viewer-draft' : null
  }

  /**
   * The "activity only" check (code-review 9 of TODO 774): responding, the send queue, awaiting approval,
   * reservations, background subagents, a running `!`. **It does not look at drafts.** Used by the backend
   * (CLI) own update's idle check, the quit confirmation (1004) and scheduled runs. **Its decision does not change** (TODO 1333
   * loosens only the app's own update, through `restartBlocker`).
   */
  activityBlocker(now = Date.now()): 'session' | 'queue' | 'shell' | null {
    const blocker = this.activityBlockerWith(now, false, false)
    // Without carrying, every reservation is `queue` (`queue-uncarriable` comes only from the carrying check).
    return blocker === 'queue-uncarriable' ? 'queue' : blocker
  }

  private activityBlockerWith(
    now: number,
    ignoreBackgroundShells: boolean,
    carryStoppedReservations: boolean
  ): 'session' | 'queue' | 'queue-uncarriable' | 'shell' | null {
    // With `ignoreBackgroundShells` the shell timeout is 0: no background shell counts any more (a response, approval or subagent still does).
    const shellTimeout = ignoreBackgroundShells ? 0 : this.backgroundShellEvictTimeoutMs
    for (const live of this.live.values()) {
      if (live.state !== 'idle' && live.state !== 'error') return 'session'
      if (live.session?.alive === true && !isEvictable(live, now, shellTimeout)) return 'session'
      if (live.pendingApprovals.size > 0 || live.subtasks.size > 0) return 'session'
    }
    if (this.restarting.size > 0) return 'session'
    if (carryStoppedReservations) {
      const reservations = this.sendQueue.restartBlocker()
      if (reservations !== null) return reservations
    } else if (this.sendQueue.anyBusy()) {
      return 'queue'
    }
    if (this.shellRuns.size > 0 || this.pendingShell.size > 0) return 'shell'
    return null
  }

  /**
   * TODO 1337: the stopped reservations in their carried form, right before an idle restart. null when they cannot all be carried (then `restartBlocker`
   * is not null either). Read synchronously, in the same step as the last `restartBlocker` check.
   */
  carriedReservations(): CarriedReservationTable | null {
    if (this.stopped) return null
    return this.sendQueue.carriedSnapshot()
  }

  /** TODO 1337: the carriable stopped reservations now, ignoring the rest (only to follow memory after the restart was decided). */
  carriableReservationsNow(): CarriedReservationTable {
    return this.stopped ? {} : this.sendQueue.carriableNow()
  }

  /**
   * TODO 1337: put carried reservations back into a thread's queue at launch, **stopped** (nothing is sent until the user sends again). null if the thread is
   * gone (deleted, including into "Deleted": deleting a thread discards its reservations, and restoring it from "Deleted" does not bring them back).
   */
  restoreCarriedReservations(
    threadId: string,
    items: readonly CarriedReservation[]
  ): { readonly restored: number; readonly invalid: number } | null {
    if (this.stopped || this.store.getThread(threadId) === null) return null
    return this.sendQueue.restoreCarried(threadId, items)
  }

  /** TODO 1337: called whenever reservations change, until shutdown begins (one listener). */
  onReservationsChanged(listener: (() => void) | null): void {
    this.reservationsListener = listener
  }

  /** TODO 1333: whether any window holds a Composer draft (what an idle restart has to carry over). */
  hasDrafts(): boolean {
    return this.composerDrafts.hasAny()
  }

  /**
   * TODO 1333: cross-check for carrying the drafts of window `viewId`: the threads main was told have a draft or attachment (`reportComposerDrafts`).
   * A window's reply is checked against them, so a draft it does not contain is never dropped silently.
   */
  draftsOfView(viewId: number): { readonly composerThreads: ReadonlySet<string> } {
    return { composerThreads: this.composerDrafts.threadsOf(viewId) }
  }

  /**
   * TODO 1333: protect the threads of carried drafts from the abandoned-thread purge until the windows of the next launch report their own.
   * Returns the release function.
   */
  holdCarriedComposerDrafts(threadIds: readonly string[]): () => void {
    const seedView = -1
    this.composerDrafts.report(seedView, threadIds)
    return () => this.composerDrafts.close(seedView)
  }

  /**
   * Whether one more session can be started now (whether `makeRoom` will not refuse). Even at the limit, it can
   * start if there is a session that can be evicted (not responding). A scheduled run waits instead of skipping when it cannot.
   */
  hasSessionRoom(): boolean {
    // TODO 840: count the same way as `makeRoom` (also count those that are starting and have taken a slot).
    const occupying = [...this.live.values()].filter(occupiesSlot)
    if (occupying.length < this.settings.maxConcurrent) return true
    const now = Date.now()
    const evictable = occupying.filter(
      (l) => l.session?.alive === true && isEvictable(l, now, this.backgroundShellEvictTimeoutMs)
    )
    return evictable.length >= occupying.length - this.settings.maxConcurrent + 1
  }

  // ---- Continuing a terminal / VS Code conversation (item 111, 4.5.9) ----

  /**
   * Creates a thread that continues from the backend's transcript. The cwd is the transcript's (start in the
   * original place, since the work's meaning is there), the initial model is the model of the transcript's last
   * response, and the title is the backend's title (or the first message if none). **The past part is not
   * imported into the DB** (constraints 9 / 10): the row keeps its origin (`transcript_origin`), and the
   * timeline reads the transcript each time. The first launch is done by `startLive` with
   * `--resume <sessionId>` (plus `--fork-session` for `fork`).
   */
  private async createThreadFromTranscript(input: CreateThreadInput): Promise<Thread> {
    const request = input.transcript
    if (request === undefined) throw new Error('transcript required')
    if (input.cwdUri !== undefined || input.scratch === true) throw reasonError('transcript-with-cwd')
    const adapter =
      input.backend === undefined ? this.primary : this.adapters.get(input.backend)
    if (adapter === undefined) throw reasonError('backend-not-registered')
    const transcripts = adapter.transcripts
    if (transcripts === null) throw reasonError('transcript-not-found')
    const info = await transcripts.findSession(request.sessionId)
    if (info === null) throw reasonError('transcript-not-found')
    // When continuing with the same id, refuse an id that an aios thread (including deleted ones) owns: in sessions,
    // backend_session_id is unique and cannot be tied to a second thread. A fork gets a new id, so it passes.
    if (!request.fork && this.store.ownedBackendSessions().has(info.sessionId)) {
      throw reasonError('transcript-owned')
    }
    // TODO 982: a drill's session is not continued from its transcript either (a fork would be an ordinary conversation).
    if (this.store.drillBackendSessions().has(info.sessionId)) throw reasonError('drill-locked')
    if (info.cwd === null) throw reasonError('transcript-cwd-unusable', { reason: 'cwd-not-found' })
    const usable = await this.cwdUsability(info.cwd)
    if (usable !== null) throw reasonError('transcript-cwd-unusable', { reason: usable })
    const cwd = info.cwd

    // Model: read the full name of the transcript's last response as an alias in the list (item 140); if no match, the settings default.
    const models = await adapter.listModels()
    const reported = info.model === null ? null : this.reportedModel(adapter, info.model)
    const fromTranscript = reported !== null && isSelectableModel(models, reported) ? reported : null
    // Show in the band that the transcript's model matched nothing in the list and fell back to the default (item 140).
    const modelFallback = info.model !== null && models.length > 0 && fromTranscript === null
    const modelId = fromTranscript ?? this.canonicalModel(adapter.id, this.settings.defaultModelId)
    let thinking = input.thinking === undefined ? this.settings.defaultThinking : input.thinking
    if (thinking !== null && !isThinkingLevel(thinking)) throw new Error('unknown thinking level')
    if (modelId !== null) {
      if (!isSelectableModel(models, modelId)) throw reasonError('model-not-selectable')
      thinking = this.thinkingFor(models, modelId, thinking)
    }

    const allowed = new Set<string>(this.deps.fs.defaultReferenceDirs())
    allowed.add(cwd)
    const title = redactText(info.title ?? info.firstPrompt).text.trim().slice(0, MAX_TITLE) // TODO 859
    const id = randomUUID()
    const thread = this.store.createThread({
      id,
      title: title === '' ? DEFAULT_TITLE : title,
      titleAuto: title === '',
      cwd,
      allowedDirs: [...allowed],
      retention: this.settings.defaultRetention,
      settingSources: DEFAULT_SETTING_SOURCES,
      backend: adapter.id,
      modelId,
      thinking,
      approvalStrict: input.approvalStrict === true,
      transcriptOrigin: {
        sessionId: info.sessionId,
        fileId: info.id,
        // Read limit = the current file size. Lines after this are in aios's own thread_events.
        limit: info.size,
        fork: request.fork,
        ...(modelFallback ? { modelFallback: true } : {})
      }
    })
    this.store.touchCwd(cwd)
    this.requestCwdScan(cwd)
    void this.refreshTrayFolders()
    log.info('thread.created.fromTranscript', {
      threadId: thread.id,
      backend: adapter.id,
      fork: request.fork,
      model: modelId !== null,
      modelFromTranscript: fromTranscript !== null,
      modelFallback,
      limit: info.size
    })
    this.emitThreads()
    return thread
  }

  /**
   * Makes the index process incrementally scan the thread's cwd subtree right now (item 246, 6.2.2).
   * A folder created / cloned while aios was stopped is not in the index until the next periodic scan, so the
   * candidates for `@` (114) and "this working folder" (100) are empty. **It does not wait**, so creation is
   * not delayed; the choke points (exclusions, outside home, scan roots), merging of the same cwd and limits
   * are on the index process side. A failure is only a debug log (also absorbed here when a test's fake
   * IndexClient has no such entry point).
   */
  private requestCwdScan(cwd: string): void {
    try {
      this.deps.index.scanSubtree(cwd)
    } catch (err) {
      log.debug('thread.cwdScan.failed', errorFields(err))
    }
  }

  /** Whether the cwd can be used as the place to continue. null if usable, otherwise a reason code (item 141). */
  private async cwdUsability(cwd: string): Promise<string | null> {
    try {
      this.deps.fs.assertAllowed(pathToUri(cwd), true)
    } catch (err) {
      return pathDenialReason(err)
    }
    try {
      return (await stat(cwd)).isDirectory() ? null : 'cwd-not-directory'
    } catch {
      return 'cwd-not-found'
    }
  }

  /** Turns a transcript summary into the renderer's shape. Adds whether the cwd is unusable and "aios already has it". */
  private async toTranscriptSession(
    info: TranscriptSessionInfo,
    owned: ReadonlyMap<string, { threadId: string; alive: boolean }>
  ): Promise<TranscriptSession> {
    const owner = owned.get(info.sessionId)
    let usable = info.cwd !== null
    let reason: string | null = info.cwd === null ? 'cwd-not-found' : null
    if (info.cwd !== null) {
      reason = await this.cwdUsability(info.cwd)
      usable = reason === null
    }
    if (owner !== undefined && !owner.alive) {
      usable = false
      reason = 'transcript-owned'
    }
    return {
      sessionId: info.sessionId,
      uri: info.uri,
      cwdUri: info.cwd === null ? '' : pathToUri(info.cwd),
      cwdMatchKey: info.cwd === null ? '' : await cwdMatchKey(info.cwd),
      cwdName: info.cwd === null ? '' : threadCwdName(info.cwd, this.deps.fs.homePath, this.deps.scratchRoot),
      title: info.title,
      firstPrompt: info.firstPrompt,
      mtimeMs: info.mtimeMs,
      usable,
      reason,
      threadId: owner !== undefined && owner.alive ? owner.threadId : null
    }
  }

  /**
   * The "from CLI conversations" list (item 111). Most recent first. Session ids that an aios thread owns
   * (including deleted ones) are not shown: if alive, just open that thread, and a deleted one cannot be continued.
   */
  async listTranscriptSessions(): Promise<readonly TranscriptSession[]> {
    const transcripts = this.primary.transcripts
    if (transcripts === null) return []
    const owned = this.store.ownedBackendSessions()
    const out: TranscriptSession[] = []
    for (const info of await transcripts.listSessions()) {
      if (owned.has(info.sessionId)) continue
      out.push(await this.toTranscriptSession(info, owned))
    }
    return out
  }

  /** The conversation that a transcript hit in conversation search points to (item 111). `threadId` is set if aios already has it. */
  async transcriptSessionOfUri(uri: string): Promise<TranscriptSession | null> {
    const transcripts = this.primary.transcripts
    if (transcripts === null) return null
    const info = await transcripts.describeUri(uri)
    if (info === null) return null
    return this.toTranscriptSession(info, this.store.ownedBackendSessions())
  }

  /**
   * One page of the transcript's past part (item 111). Positions are expressed with a **negative `seq`**: if the
   * past part has N rows, the last row is -1 and the first is -N. Takes `size` rows from the newer side among rows before
   * `before` (0 or less) = rows with `-N + i < before`. It continues only after the DB rows (positive `seq`) have been read through.
   */
  private async transcriptPage(
    thread: Thread,
    size: number,
    before: number
  ): Promise<{ readonly events: readonly AiosEvent[]; readonly oldestSeq: number | null; readonly remaining: number }> {
    const empty = { events: [], oldestSeq: null, remaining: 0 }
    const origin = this.store.transcriptOriginOf(thread.id)
    const transcripts = this.adapters.get(thread.backend)?.transcripts ?? null
    if (origin === null || transcripts === null) return empty
    const history = await transcripts.readHistory(
      origin.fileId,
      { threadId: thread.id, sessionId: origin.sessionId },
      origin.limit
    )
    if (history === null || history.length === 0) return empty
    const total = history.length
    const end = Math.max(0, Math.min(total, total + before))
    const start = Math.max(0, end - size)
    if (end <= start) return empty
    return { events: history.slice(start, end), oldestSeq: start - total, remaining: start }
  }

  // ---- Working directory history (T5 / TODO 6) ----

  /**
   * Turns the history into the renderer's shape: **no paths are passed**, only URI and name.
   * Directories that disappeared and excluded ones are shown greyed out with `usable=false` (not selectable).
   */
  async cwdHistory(): Promise<readonly CwdHistoryEntry[]> {
    // The order (most used first, newest first on ties) and the limit (100) are decided by the store's SQL (TODO 462).
    // Run the 100 `stat`s in parallel rather than waiting on them one by one; `Promise.all` keeps the order.
    return Promise.all(this.store.cwdHistory().map((row) => this.cwdHistoryEntry(row)))
  }

  private async cwdHistoryEntry(row: {
    path: string
    lastUsedAt: number
    useCount: number
  }): Promise<CwdHistoryEntry> {
    const uri = pathToUri(row.path)
    let usable = true
    let reason: string | null = null
    try {
      this.deps.fs.assertAllowed(uri, true)
    } catch (err) {
      usable = false
      reason = pathDenialReason(err)
    }
    if (usable) {
      try {
        if (!(await stat(row.path)).isDirectory()) {
          usable = false
          reason = 'cwd-not-directory'
        }
      } catch {
        usable = false
        reason = 'cwd-not-found'
      }
    }
    // TODO 742: hand out rainbow colors only to rows in the history (useCount > 0). Their cwd should already have
    // had a thread, so `rainbowIndexFor` only reads the existing value in the table and consumes no new number
    // (see the comment on `rainbowIndexFor` in `store.ts`).
    const rainbow =
      row.useCount > 0 ? this.store.rainbowIndexFor(row.path, threadCwdName(row.path, this.deps.fs.homePath, this.deps.scratchRoot)) : null
    return {
      uri,
      name: basename(row.path) || row.path,
      parentName: basename(dirname(row.path)),
      lastUsedAt: row.lastUsedAt,
      useCount: row.useCount,
      usable,
      reason,
      rainbow
    }
  }

  removeCwdHistory(uri: string): void {
    this.store.removeCwd(uriToPath(uri))
    if (!this.stopped) this.deps.events.onCwdHistoryChanged?.()
    void this.refreshTrayFolders()
  }

  clearCwdHistory(): void {
    this.store.clearCwdHistory()
    log.info('thread.cwdHistory.cleared', {})
    if (!this.stopped) this.deps.events.onCwdHistoryChanged?.()
    void this.refreshTrayFolders()
  }

  /** The folders the menu bar menu shows (TODO 1301), rebuilt off the main thread by `refreshTrayFolders`. */
  private trayFolders: readonly string[] = []
  private trayFoldersEnabled = false
  private trayFoldersRunning: Promise<void> | null = null
  private trayFoldersDirty = false

  /**
   * TODO 1301: the most recently used working folders for the menu bar menu (absolute paths, newest first). **Reads only the cache**: the menu
   * is synced on every turn / unread / approval change, so nothing here may touch the disk (an unresponsive network volume would block every window).
   */
  recentCwdPaths(limit: number): readonly string[] {
    return this.trayFolders.slice(0, limit)
  }

  /** Turn the cache on or off (the menu bar icon is shown or not). Turning it on rebuilds it; turning it off drops it. */
  setTrayFolders(enabled: boolean): void {
    if (this.trayFoldersEnabled === enabled) return
    this.trayFoldersEnabled = enabled
    if (enabled) void this.refreshTrayFolders()
    else this.trayFolders = []
  }

  /**
   * Rebuild the folder cache from the history, with **asynchronous** `stat`s: each has a time limit and only the newest `TRAY_STAT_CANDIDATES`
   * rows are checked. Called only when the history changes (a conversation is created, a folder is removed, the history is cleared) and when the icon
   * is turned on. The DB is read synchronously before the first `await` and never after, so a `stop()` in between cannot hit a closed DB. Folders
   * that are excluded (the choke point) or no longer a directory are left out. Calls that arrive while a rebuild runs cause one more rebuild.
   */
  refreshTrayFolders(): Promise<void> {
    if (!this.trayFoldersEnabled || this.stopped) return Promise.resolve()
    if (this.trayFoldersRunning !== null) {
      this.trayFoldersDirty = true
      return this.trayFoldersRunning
    }
    const run = this.rebuildTrayFolders().finally(() => {
      this.trayFoldersRunning = null
    })
    this.trayFoldersRunning = run
    return run
  }

  private async rebuildTrayFolders(): Promise<void> {
    do {
      this.trayFoldersDirty = false
      const rows = [...this.store.cwdHistory()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      const candidates: string[] = []
      for (const row of rows) {
        if (candidates.length >= TRAY_STAT_CANDIDATES) break
        try {
          this.deps.fs.assertAllowed(pathToUri(row.path), true)
          candidates.push(row.path)
        } catch {
          // Excluded: not shown.
        }
      }
      const checked = await Promise.all(candidates.map((path) => isDirectoryWithin(path, TRAY_STAT_TIMEOUT_MS)))
      if (this.stopped || !this.trayFoldersEnabled) return
      const next = candidates.filter((_, i) => checked[i])
      const changed = next.length !== this.trayFolders.length || next.some((p, i) => p !== this.trayFolders[i])
      this.trayFolders = next
      if (changed) this.deps.events.onTrayFoldersChanged?.()
    } while (this.trayFoldersDirty)
  }

  /**
   * The first-time-folder notice (item 123, 4.3.2). Called when the create dialog picks a folder.
   * The decision and order are in `folder-notice.ts`. It only notifies and does not stop creation.
   */
  async folderNotice(cwdUri: string): Promise<FolderNotice | null> {
    const adapter = this.primary
    return folderNotice(cwdUri, {
      assertAllowed: (uri, asDirectory) => this.deps.fs.assertAllowed(uri, asDirectory),
      knownCwd: (path) => this.store.hasCwd(path),
      hasTranscript: async (paths) => {
        const transcripts = adapter.transcripts
        if (transcripts === null) return false
        const keys = new Set(paths.map((path) => foldPath(path)))
        for (const info of await transcripts.listSessions()) {
          if (info.cwd !== null && keys.has(foldPath(info.cwd))) return true
        }
        return false
      },
      locate: adapter.locateProjectAutorun?.bind(adapter)
    })
  }

  /**
   * The `cwdMatchKey` of the chosen folder (item 239). The chosen side's key, so that the create dialog can match
   * "conversations of this folder" against `TranscriptSession.cwdMatchKey`. null if it does not pass the choke
   * point (excluded or nonexistent).
   */
  async folderMatchKey(cwdUri: string): Promise<string | null> {
    let path: string
    try {
      path = this.deps.fs.assertAllowed(cwdUri, true)
    } catch {
      return null
    }
    return cwdMatchKey(path)
  }

  /** Window `viewId` (`webContents.id`) opened a thread. Clears unread (a selection change, TODO 741). */
  openThread(threadId: string, viewId: number): void {
    this.views.show(viewId, threadId)
    this.markRead(threadId, { selection: true })
    // TODO 1338 (review Y): a diff waiting for this conversation is not pushed here; the window pulls it once its viewer restore has
    // settled (`pendingViewerDiff`), so the restore cannot erase it.
  }

  /** TODO 1338 (review Y): the diff waiting for `threadId`, only for a window that shows that conversation now. null if none. */
  pendingViewerDiff(viewId: number, threadId: string): ReturnType<GatewayRequests['pendingDiffFor']> {
    return this.gatewayRequests.pendingDiffFor(viewId, threadId)
  }

  /** TODO 1338 (review Y): the window showed the waiting diff of `generation`; it stops waiting unless a newer one replaced it. */
  pendingViewerDiffShown(threadId: string, generation: number): void {
    this.gatewayRequests.pendingDiffShown(threadId, generation)
  }

  /** TODO 1316: the window (`webContents.id`) to bring forward for this thread: the focused one showing it, else the last focused, else the first. null if none shows it. */
  windowShowing(threadId: string): number | null {
    return this.views.primaryViewOf(threadId)
  }

  /**
   * A window closed / reloaded (TODO 71). From then on, the thread that window was showing is "not visible",
   * so unread is set when a response finishes.
   */
  closeView(viewId: number): void {
    this.views.close(viewId)
    this.draftConflicts.close(viewId)
    this.viewerReplies.forgetView(viewId)
    this.viewerShown.delete(viewId)
    this.composerDrafts.close(viewId)
  }

  /**
   * The thread window `viewId` is showing now (item 36). Used to record each window's state at shutdown.
   * null for a window with nothing open or one that closed.
   */
  threadOfView(viewId: number): string | null {
    return this.views.threadOf(viewId)
  }

  /** TODO 832 (1): how the window handled an "open" command with a `replyId` (from the renderer; the receiver validates the value). */
  replyViewerCommand(viewId: number, replyId: unknown, outcome: unknown): void {
    this.viewerReplies.reply(viewId, replyId, outcome)
  }

  /** TODO 1061 (3): what that window's ViewerPane is showing in front changed (`null` = unknown / no conversation shown). */
  reportViewerShown(viewId: number, report: ViewerShownReport | null): void {
    if (report === null) this.viewerShown.delete(viewId)
    else this.viewerShown.set(viewId, report)
  }

  /** That window's draft URI changed (item 97, second half). `null` = no draft. */
  reportDraft(viewId: number, uri: string | null): void {
    this.draftConflicts.reportDraft(viewId, uri)
  }

  /**
   * The count of that window's viewer draft table (TODO 312, including files switched away from) changed (code-review of TODO 103).
   * Used only as input for blocking the idle restart (`restartBlocker`).
   */
  reportStoredViewerDrafts(viewId: number, count: number): void {
    this.draftConflicts.reportStored(viewId, count)
  }

  /** Whether window `viewId` has an unsaved viewer draft (TODO 606, the decision before closing the window / quitting). */
  hasViewerDrafts(viewId: number): boolean {
    return this.draftConflicts.hasIn(viewId)
  }

  /**
   * The set of threads that have a draft (or attachment) in the Composer of window `viewId` changed (TODO 526).
   * Replaced wholesale. Used only as input for protecting against physical deletion of abandoned threads.
   */
  reportComposerDrafts(viewId: number, threadIds: readonly string[]): void {
    this.composerDrafts.report(viewId, threadIds)
  }

  /**
   * **Physically deletes** abandoned threads (TODO 526). Those where, since creation, `abandonedTtlMs` (default 3 minutes) or
   * more has passed with no send or response (the DB condition is `ThreadStore.abandonedThreads`), that are not open in any window
   * (the selected one = only that window can put focus on the Composer), that have no draft in any window's Composer, and
   * where no process, reservation or `!` is running. It does not go through logical deletion (item 64), so it does not appear in "Deleted" either.
   *
   * It does not touch the scratch (T19) directory: a thread that was never sent does not pass `startLive`'s `mkdir`,
   * so normally there is no scratch area. If there is one (the user put something there), it is left, not deleted. A
   * scratch area left empty after the row is gone is picked up by the next launch's `sweepScratch` (T23) (cleanup is not held in two places).
   * It runs to completion synchronously. Returns the number deleted (for tests).
   */
  purgeAbandonedThreads(now = Date.now()): number {
    if (this.stopped) return 0
    this.abandonedTtlMs ??= this.store.abandonedThreadTtlMs()
    const ttl = this.abandonedTtlMs
    if (!(ttl > 0)) return 0
    const cutoff = now - ttl
    const candidates = this.store.abandonedThreads(cutoff)
    if (candidates.length === 0) return 0
    const busy = (threadId: string): boolean =>
      this.views.viewsOf(threadId).length > 0 ||
      this.composerDrafts.has(threadId) ||
      this.live.has(threadId) ||
      this.restarting.has(threadId) ||
      queueBusy(this.sendQueue.get(threadId)) ||
      this.shellRuns.has(threadId) ||
      this.pendingShell.has(threadId)
    const cwdOf = new Map(candidates.map((c) => [c.id, c.cwd]))
    const isProtected = (threadId: string): boolean => {
      if (busy(threadId)) return true
      const cwd = cwdOf.get(threadId)
      return cwd !== undefined && isScratchCwd(this.deps.fs.homePath, cwd, threadId, this.deps.scratchRoot) && existsSync(cwd)
    }
    let purged = 0
    for (const threadId of pickAbandoned(candidates, now, ttl, isProtected)) {
      if (!this.store.purgeAbandonedThread(threadId, cutoff)) continue
      purged += 1
      this.sendQueue.delete(threadId)
      this.contextUsage.delete(threadId)
      this.subagentModels.delete(threadId)
      this.subtaskWorktrees.forget(threadId)
      this.contextBreakdowns.forget(threadId)
      this.todos.delete(threadId)
      this.planModes.delete(threadId)
      this.manuallyUnread.delete(threadId)
      // It was never sent, so there should be no row in the conversation index (6.1), but align with the promise that the index goes when the canonical copy goes (6.2).
      // The index SQL is run by the index process (RPC, constraint 8.1).
      this.deps.index.removeThread(threadId)
      this.views.forgetThread(threadId)
      this.gatewayRequests.forgetThread(threadId)
      log.info('thread.abandoned.purged', { threadId })
    }
    // Removal from the list is reported by sending the full list (same as deletion, item 75).
    if (purged > 0) this.emitThreads()
    return purged
  }

  /**
   * A window regained focus (TODO 71). Unread set on the thread it shows while it was in the background is
   * treated as read once it returns to the front (same as Slack).
   */
  focusView(viewId: number): void {
    this.views.noteFocus(viewId)
    const threadId = this.views.threadOf(viewId)
    if (threadId !== null) this.markRead(threadId, { selection: false })
  }

  /**
   * Clears unread. The mark for writes to the main working copy (TODO 709, the warning mark in the list =
   * `outside_write_at`) is cleared together on the same occasion (when that conversation is opened); the
   * timeline's `outside_write` row stays (the mark is only a warning in the list). If either changed, the list is notified.
   *
   * `selection`: true for a **selection change** (`openThread`, the existing occasion of item 80). false is
   * `focusView`: a window gaining or losing focus while the thread stays displayed, not a "selection" (TODO 741).
   * A thread manually marked unread (`manuallyUnread`) is not cleared with `selection: false`: as in Slack, it
   * stays unread until you move elsewhere and come back (= the next `openThread`).
   */
  private markRead(threadId: string, { selection }: { selection: boolean }): void {
    // Do not touch the DB on a focus during shutdown (12.9).
    if (this.stopped) return
    if (!selection && this.manuallyUnread.has(threadId)) return
    this.manuallyUnread.delete(threadId)
    // Write only when the value changed (decided by the UPDATE's condition, so no read-then-write).
    const unreadChanged = this.store.setUnread(threadId, false)
    const outsideWriteChanged = this.store.clearOutsideWriteAt(threadId)
    if (unreadChanged || outsideWriteChanged) this.emitThread(threadId)
  }

  /**
   * The Sidebar's right-click "Mark as unread" / "Mark as read" (TODO 741). The mark-unread side marks
   * `manuallyUnread` so that it is not cleared while the thread stays displayed (only focus in and out); when the
   * selection changes (`openThread` -> `markRead({ selection: true })`) it is dropped there.
   */
  setThreadUnread(threadId: string, unread: boolean): void {
    if (this.stopped) return
    if (unread) this.manuallyUnread.add(threadId)
    else this.manuallyUnread.delete(threadId)
    if (this.store.setUnread(threadId, unread)) this.emitThread(threadId)
  }

  async timeline(threadId: string): Promise<Timeline> {
    const thread = this.store.getThread(threadId)
    if (thread === null) {
      return { threadId, events: [], oldestSeq: null, remaining: 0, notPersisted: false }
    }
    const page = await this.pageWithHistory(thread, TIMELINE_LIMIT, undefined)
    return { threadId, ...page, notPersisted: thread.retention === 'none' }
  }

  /**
   * "Read more" (item 88). At most one page of `seq < before` from the newer side. The count is clamped to
   * [1, TIMELINE_PAGE] (the renderer's value is not used as the LIMIT as is).
   * If `before` is 0 or less, it is a page of the transcript's past part (item 111, `transcriptPage`).
   */
  async timelineBefore(threadId: string, before: number, limit = TIMELINE_PAGE): Promise<Timeline> {
    const thread = this.store.getThread(threadId)
    const size = Math.max(1, Math.min(TIMELINE_PAGE, Math.trunc(limit)))
    if (thread === null) {
      return { threadId, events: [], oldestSeq: null, remaining: 0, notPersisted: false }
    }
    const page = await this.pageWithHistory(thread, size, before)
    return { threadId, ...page, notPersisted: thread.retention === 'none' }
  }

  /**
   * The ids of threads whose working folder is `cwdPath` itself or below it (TODO 1096). Input for the
   * conversation search's "this working folder" section; only this set of ids is passed to the index process (the
   * index does not hold threads' cwd). `cwdPath` is something the caller validated with `conversationCwdPathOf`
   * (an absolute `file:` path without NUL). No files are read, so exclusion rules are not applied. The result is
   * remembered per cwd by `ThreadStore`.
   */
  threadIdsUnderCwd(cwdPath: string): readonly string[] {
    return this.store.threadIdsUnderCwd(cwdPath)
  }

  /** The thread's title (an empty string for a provisional title). null for a nonexistent thread (TODO 818's default file name). */
  threadTitle(threadId: string): string | null {
    return this.store.getThread(threadId)?.title ?? null
  }

  /** Whether it is a live thread that has not sent even one message (no last event). Used so that the hotkey does not accumulate empty conversations (TODO 976 review Y-3). */
  isUnsentThread(threadId: string): boolean {
    const thread = this.store.getThread(threadId)
    return thread !== null && thread !== undefined && thread.lastEventAt === null
  }

  /**
   * The path of the conversation's working folder (the worktree if it moved there, TODO 633). null for an old row
   * without cwd or an unknown thread. The base from which the HTML export (TODO 866) resolves images with relative paths in the body.
   */
  threadWorkingCwd(threadId: string): string | null {
    const thread = this.store.getThread(threadId)
    if (thread === undefined || thread === null || workingCwdUri(thread) === '') return null
    return this.workingCwdOf(thread)
  }

  /**
   * The material for saving a conversation as PDF (TODO 818). The ThreadPane reads by pages, so not what is on
   * screen but **all of it** is read back to the oldest side (including the transcript's past part, by the same
   * route as `timelineBefore`) and built into turns of just the user's messages and the parent's reply bodies.
   * The transcript's past part has not passed through the persistence entry point, so all bodies go through `redactText`.
   */
  async exportTurns(threadId: string): Promise<ConversationExport> {
    const thread = this.store.getThread(threadId)
    if (thread === null) return { threadId, turns: [] }
    const events = await this.allEvents(thread)
    return { threadId, turns: buildExportTurns(events, (text) => redactText(text).text) }
  }

  /**
   * All of the thread (including the transcript's past part), oldest first. Used by the conversation export and
   * the handoff (TODO 961). Passing `before` reads only the older side from `seq < before` of the saved rows (a fix from the
   * review of item 1 of TODO 992: ancestors only up to the branch point).
   */
  private async allEvents(thread: Thread, before?: number): Promise<readonly AiosEvent[]> {
    const pages: (readonly AiosEvent[])[] = []
    let page = await this.pageWithHistory(thread, TIMELINE_LIMIT, before)
    pages.push(page.events)
    while (page.remaining > 0 && page.oldestSeq !== null) {
      const before = page.oldestSeq
      page = await this.pageWithHistory(thread, TIMELINE_PAGE, before)
      // Do not loop forever on a page that does not advance (e.g. only broken rows).
      if (page.events.length === 0 && page.oldestSeq === before) break
      pages.push(page.events)
    }
    return pages.reverse().flat()
  }

  /**
   * The handoff text of the source thread (TODO 961). null if there is no thread or no message to hand over.
   * Building it reads everything (including the transcript's past part), so it is heavy. The band's estimate ->
   * "make it lighter" -> the first send of the new thread would build the same source thread 3 times, so it is
   * cached keyed on the thread's saved-row version (`timelineVersion`) and title (review). The transcript's past
   * part is fixed up to the read limit at the time of continuing and does not change, so it is not in the key.
   * `purpose` (TODO 1018: a branch to another backend differs only by one introductory sentence) is also in the
   * cache key; the material for rebuilding (`turns`) is not kept in the cache (review).
   */
  private async handoffTextOf(threadId: string, purpose: HandoffPurpose = 'lighten'): Promise<PreparedHandoff | null> {
    const thread = this.store.getThread(threadId)
    if (thread === null) return null
    const cacheKey = `${threadId}\u0000${purpose}`
    const links = this.handoffLineage(threadId)
    const key = `${this.lineageVersion(threadId, links)}\u0000${thread.title}`
    const cached = this.handoffCache.get(cacheKey)
    if (cached !== undefined && cached.key === key) return cached.value
    const own = await this.allEvents(thread)
    // Item 1 of TODO 992: a thread created by a branch / handoff prepends what it inherited from its ancestors (its own rows do not have it).
    const turns = handoffTurns(await this.withInherited(own, links))
    // The destination the band jumps to (`forkOrigin.eventId`) points only at its own rows. If it has no message of its own, do not hand over, as before.
    const lastQuestion = lastOwnQuestionId(turns, new Set(own.map((event) => event.id)))
    const value = lastQuestion === null ? null : { handoff: buildHandoffText(turns, thread.title, purpose), lastQuestion }
    this.handoffCache.delete(cacheKey)
    this.handoffCache.set(cacheKey, { key, value })
    // Drop the oldest first (a Map is in insertion order).
    while (this.handoffCache.size > HANDOFF_CACHE_MAX) {
      const oldest = this.handoffCache.keys().next().value
      if (oldest === undefined) break
      this.handoffCache.delete(oldest)
    }
    return value
  }

  /**
   * For a thread created by a branch / handoff: what it inherited from its ancestors + all of its own (item 1 of TODO 992).
   * Its own rows have neither the part before the branch point (a rewind branch, item 113: the conversation is
   * inherited from the source session) nor the handoff text attached to the first send (TODO 961: not recorded),
   * so these are re-fetched from the source thread's saved rows. If the ancestor is also a branch, trace back by
   * the same rule (up to `HANDOFF_LINEAGE_MAX` levels). Nothing is added for a branch that did not inherit the
   * source conversation (rewound before the first message, or there was no session), a vanished source, or a
   * branch point that is not found. Ancestors are read only up to the branch point (`inheritedBound`); the whole
   * is read only when the branch point is not in the saved rows (the transcript's past part). The canonical copy
   * stays the source thread (nothing is copied or persisted; constraints 9 / 10).
   */
  private async withInherited(own: readonly AiosEvent[], links: readonly HandoffLink[]): Promise<readonly AiosEvent[]> {
    // From the oldest ancestor: that level's result = the parent's result up to the branch point + that level's own rows (only its own rows if the branch point is not found).
    let carried: readonly AiosEvent[] | null = null
    for (let i = links.length - 1; i >= 0; i--) {
      const link = links[i]!
      const parentOwn = await this.allEvents(link.parent, link.bound === null ? undefined : link.bound.before)
      const lineage: readonly AiosEvent[] = carried === null ? parentOwn : [...carried, ...parentOwn]
      carried = inheritedEvents(lineage, link.cutId, link.mode)
    }
    return carried === null ? own : [...carried, ...own]
  }

  /**
   * The levels of ancestors traced for a handoff (`withInherited` and the cache key follow the same rule). A
   * handoff goes up to the last message that the text actually sent contains (`handoffThrough`, the mark set when
   * sent; before sending or for old rows, the `eventId` at creation time), and a rewind branch goes up to just before the branch point's message.
   */
  private handoffLineage(threadId: string): HandoffLink[] {
    const links: HandoffLink[] = []
    const seen = new Set<string>([threadId])
    let child = threadId
    while (seen.size < HANDOFF_LINEAGE_MAX) {
      const origin = this.store.forkOriginOf(child)
      if (origin === null || seen.has(origin.threadId)) break
      if (origin.handoff !== true && origin.backendSessionId === null) break
      const parent = this.store.getThread(origin.threadId)
      if (parent === null) break
      seen.add(parent.id)
      const mode = origin.handoff === true ? ('through' as const) : ('before' as const)
      const cutId = origin.handoff === true ? (origin.handoffThrough ?? origin.eventId) : origin.eventId
      links.push({ parent, mode, cutId, bound: this.store.inheritedBound(parent.id, cutId, mode) })
      child = parent.id
    }
    return links
  }

  /**
   * The version part of the handoff-text cache key (item 1 of TODO 992, a fix from the review): the version of
   * its own saved rows + "branch point + bound" for each ancestor. Rows before an ancestor's branch point are
   * not added (seq only grows), so the cache does not go stale even if an ancestor moves. Only for an open-bounded
   * `through` (the branch-point turn may still be going) and a level whose branch point is not in the saved rows is
   * the ancestor's own version put in.
   */
  private lineageVersion(threadId: string, links: readonly HandoffLink[]): string {
    const parts = [`${threadId}:${this.store.timelineVersion(threadId)}`]
    for (const link of links) {
      const bound =
        link.bound === null || link.bound.before === undefined
          ? `v${this.store.timelineVersion(link.parent.id)}`
          : `${link.bound.oldestSeq}-${link.bound.before}`
      parts.push(`${link.parent.id}:${link.mode}:${link.cutId}:${bound}`)
    }
    return parts.join('/')
  }

  /**
   * The estimate for "make it lighter and continue in a new conversation" (TODO 961). B = the total input of
   * this thread's first API call (system prompt + tool definitions + first message, null if none), S = the
   * estimated token count of the handoff text.
   */
  async handoffEstimate(threadId: string): Promise<HandoffEstimate> {
    const prepared = await this.handoffTextOf(threadId)
    return { baseTokens: this.store.firstPromptTokens(threadId), handoffTokens: prepared?.handoff.tokens ?? 0 }
  }

  /**
   * "Make it lighter and continue in a new conversation" (TODO 961): creates and returns a new thread that does not
   * inherit the source conversation. The source thread's messages and reply text are attached by main at the **head
   * of the new thread's first send** (`dispatchNow`, built from the source thread at that time). The settings (cwd,
   * reference range, setting sources, model / thinking, strict mode, retention) and the title copy the source thread. The source thread is untouched.
   */
  async handoff(threadId: string): Promise<Thread> {
    const thread = this.store.getThread(threadId)
    if (thread === null) throw new Error('thread not found')
    // TODO 982: a drill is not handed over (the new conversation would not be a drill).
    if (thread.drill !== undefined) throw reasonError('drill-locked')
    return this.handoffTo(thread, {
      backend: thread.backend,
      modelId: thread.modelId,
      thinking: thread.thinking
    })
  }

  /**
   * Creates a handoff thread (shared by TODO 961 / 1018). Created with `target`'s backend, model and thinking; the rest copies the source.
   */
  private async handoffTo(
    thread: Thread,
    target: { readonly backend: string; readonly modelId: string | null; readonly thinking: ThinkingLevel | null }
  ): Promise<Thread> {
    const threadId = thread.id
    const prepared = await this.handoffTextOf(threadId, target.backend === thread.backend ? 'lighten' : 'switch-backend')
    if (prepared === null) throw reasonError('handoff-empty')
    const created = this.store.createThread({
      id: randomUUID(),
      title: thread.title,
      titleAuto: thread.title === DEFAULT_TITLE,
      cwd: uriToPath(thread.cwdUri),
      allowedDirs: thread.allowedDirUris.map(uriToPath),
      retention: thread.retention,
      settingSources: thread.settingSources,
      backend: target.backend,
      modelId: target.modelId,
      thinking: target.thinking,
      approvalStrict: thread.approvalStrict,
      // TODO 1106: the handoff target is the same. But if the destination does not have it, fall to OFF (same as createThread).
      osSandbox: thread.osSandbox === true && this.supportsOsSandbox(target.backend),
      // TODO 972 (code-review, wave 96 fix Y): a handoff (and a switch to another backend) stays under the same Teammate.
      ...(thread.roleId === undefined ? {} : { roleId: thread.roleId }),
      forkOrigin: {
        threadId,
        eventId: prepared.lastQuestion,
        files: false,
        handoff: true,
        backendSessionId: null,
        atMessageId: null
      }
    })
    if (thread.retention === 'days' && thread.retentionDays !== null) {
      this.store.setRetention(created.id, thread.retention, thread.retentionDays)
    }
    // Item 1 of TODO 992: a handoff of a conversation that moved to a worktree starts in the same worktree (it used to start in the source repository's cwd).
    // Unlike a rewind branch, it does not inherit the source session (it starts from empty), so this continues the place of work, not for the transcript's storage location.
    shareWorktree(this.store, thread, created.id)
    log.info('thread.handoff', {
      threadId,
      newThreadId: created.id,
      tokens: prepared.handoff.tokens,
      omittedTurns: prepared.handoff.omittedTurns,
      ...(target.backend === thread.backend ? {} : { backend: target.backend })
    })
    this.emitThreads()
    return this.store.getThread(created.id) ?? created
  }

  /**
   * The user picked a model of another backend in the Composer's Model picker (TODO 1018, the decision of 874, ARCHITECTURE 4.6.1).
   * No confirmation is shown (owner decision 2026-10-26; the picker row's wording makes it clear).
   *
   * - A thread that has not sent even one message (`canSwitchBackendInPlace`, no process and no session row) has the row's
   *   `backend` / model / thinking changed on the spot and the same thread is returned (decided at send time = same as choosing in the create dialog).
   * - A thread with a conversation goes the same route as the handoff of 961, creating and returning a new thread with `backend` changed. The source
   *   conversation's messages and reply text (not summarized) are attached to the new thread's first send. The source thread is untouched.
   * - If it is the same backend, nothing happens (switching models is as before, the send's `switchSettings`).
   */
  async switchBackend(threadId: string, backend: string, modelId: string | null): Promise<Thread> {
    const thread = this.store.getThread(threadId)
    if (thread === null) throw new Error('thread not found')
    // TODO 982: a drill keeps its backend (switching after a send is a hand-over to an ordinary conversation).
    if (thread.drill !== undefined) throw reasonError('drill-locked')
    if (backend === thread.backend) return thread
    const adapter = this.adapters.get(backend)
    if (adapter === undefined) throw reasonError('backend-not-registered')
    const status = await adapter.getStatus()
    // review: the renderer does not show rows of unusable backends, but main re-checks too (when unusable the feature table is
    // all false and thinking silently becomes null).
    if (!status.available) throw reasonError('agent-unavailable')
    if (!status.loggedIn) throw reasonError('agent-not-logged-in')
    const model = this.canonicalModel(adapter.id, modelId)
    let thinking: ThinkingLevel | null = null
    if (status.features['thinking-level']) {
      thinking = thread.thinking ?? this.settings.defaultThinking
    }
    if (model !== null) {
      if (!status.features['model-select']) throw reasonError('model-not-selectable')
      const models = await adapter.listModels()
      if (!isSelectableModel(models, model)) throw reasonError('model-not-selectable')
      thinking = this.thinkingFor(models, model, thinking)
    }
    if (canSwitchBackendInPlace(thread)) {
      // review: if the renderer showed a row as "changes on the spot" and we fall to branching here, there is no message, so the result is `handoff-empty`
      // ("no message to hand over"), which does not make sense. If a process exists, refuse with "cannot be changed while running".
      if (this.live.has(threadId)) throw reasonError('backend-switch-busy')
      if (this.store.setBackendIfFresh(threadId, adapter.id, model, thinking)) {
        log.info('thread.backend.switched', { threadId, backend: adapter.id, model: model !== null })
        this.emitThreads()
        return this.store.getThread(threadId) ?? thread
      }
      // It fell outside the SQL condition (session row, trace of a send): branch if there is a message to hand over, otherwise refuse for the same reason.
      if ((await this.handoffTextOf(threadId, 'switch-backend')) === null) throw reasonError('backend-switch-busy')
    }
    return this.handoffTo(thread, { backend: adapter.id, modelId: model, thinking })
  }

  /**
   * The handoff text to prepend to the first ordinary message of a thread created by a handoff (TODO 961). Only
   * while the mark that it was attached and sent (`handoffSent`) is absent, or while there is still no session of
   * its own backend (= the send that attached it failed before launch). The caller does not attach it to a
   * slash-command message (anything prepended would stop it being accepted as a command), so it is carried over
   * to the next ordinary message. null if the source thread is gone or has no messages (send only the message).
   * `through` is the source thread's last message that the attached text contains (item 1 of TODO 992: when
   * handing over further, inherit up to here).
   */
  private async pendingHandoffPrefix(thread: Thread): Promise<{ readonly text: string; readonly through: string } | null> {
    if (thread.forkedFrom?.handoff !== true) return null
    if (this.store.forkOriginOf(thread.id)?.handoffSent === true && this.store.latestBackendSessionId(thread.id) !== null) {
      return null
    }
    // TODO 1018: a thread branched from another backend swaps only the one introductory sentence (the contents are the same transcript).
    const origin = this.store.getThread(thread.forkedFrom.threadId)
    const purpose: HandoffPurpose = origin !== null && origin.backend !== thread.backend ? 'switch-backend' : 'lighten'
    const prepared = await this.handoffTextOf(thread.forkedFrom.threadId, purpose)
    if (prepared === null) {
      log.warn('thread.handoff.originGone', { threadId: thread.id })
      return null
    }
    return { text: prepared.handoff.text, through: prepared.lastQuestion }
  }

  /**
   * Continues one DB page with the transcript's past part (item 111). A page where the DB rows are read through
   * (`remaining` is 0) is filled up with the end of the past part, and `oldestSeq` becomes a negative value (a
   * position in the past part). If DB rows still remain, it only adds the past part's count to `remaining`. An
   * ordinary thread is the DB page itself.
   */
  private async pageWithHistory(
    thread: Thread,
    size: number,
    before: number | undefined
  ): Promise<{ readonly events: readonly AiosEvent[]; readonly oldestSeq: number | null; readonly remaining: number }> {
    if (before !== undefined && before <= 0) return this.transcriptPage(thread, size, before)
    const page = this.store.readTimelinePage(thread.id, size, before)
    if (this.store.transcriptOriginOf(thread.id) === null) return page
    if (page.remaining > 0) {
      const history = await this.transcriptPage(thread, 1, 0)
      const total = history.oldestSeq === null ? 0 : -history.oldestSeq
      return { ...page, remaining: page.remaining + total }
    }
    const room = size - page.events.length
    if (room <= 0) {
      const history = await this.transcriptPage(thread, 1, 0)
      const total = history.oldestSeq === null ? 0 : -history.oldestSeq
      return { ...page, remaining: total }
    }
    const history = await this.transcriptPage(thread, room, 0)
    if (history.events.length === 0) return page
    return {
      events: [...history.events, ...page.events],
      oldestSeq: history.oldestSeq,
      remaining: history.remaining
    }
  }

  /** Manual rename. An empty title goes back to the provisional title (it is named again at the next send). */
  rename(threadId: string, title: string): void {
    const trimmed = title.trim().slice(0, MAX_TITLE)
    const auto = trimmed === ''
    if (!this.store.setTitle(threadId, auto ? DEFAULT_TITLE : trimmed, auto)) return
    this.emitThreads()
  }

  /**
   * Deletes a thread. **The DB row is logically deleted** (item 64): it only writes a time to `threads.deleted_at`,
   * the rows of `threads` / `sessions` / `thread_events` remain, and from then on no read entry point sees them.
   * The conversation search index is tombstoned, and if the cwd is this thread's scratch area
   * (`~/aios/scratch/<id>`), **the files are actually deleted** (T19). **If it has contents and there is no
   * `force`, nothing is deleted and it returns**: the renderer shows a confirmation on that return and calls again with `force: true`.
   */
  async remove(threadId: string, options: ThreadRemoveOptions = {}): Promise<ThreadRemoveResult> {
    const thread = this.store.getThread(threadId)
    const scratchPath = thread === null ? null : this.ownScratchPathOf(thread)
    // TODO 577: an unreadable scratch area (EACCES etc.) has an unknown count (null). Fall to asking for confirmation rather than making it undeletable.
    const scratchEntries = scratchPath === null ? 0 : await countEntries(scratchPath, threadId)
    if ((scratchEntries === null || scratchEntries > 0) && options.force !== true) {
      return { removed: false, scratchEntries }
    }
    // Discard reservations (item 94). Remove before stopping, so that the next reservation is not sent by the exit notification.
    this.sendQueue.delete(threadId)
    this.bundles.forget(threadId)
    // Also discard a running `!` and results not yet mixed in (item 116).
    this.abortShell(threadId)
    this.pendingShell.delete(threadId)
    await this.stopThread(threadId)
    this.broker.cancelThread(threadId, 'thread-removed')
    // "Do not ask about Bash in this conversation from now on" (TODO 994) and the secret mark (TODO 1043) disappear with the thread.
    this.broker.dropThread(threadId)
    // Rules are app-wide, so they remain even if a thread is deleted (T40). Revoke them from the inbox list.
    // Logical deletion (item 64). From then on `getThread` returns null, so events that arrive late after
    // the stop are not written by `flush` either.
    this.store.removeThread(threadId)
    this.contextUsage.delete(threadId)
    this.subagentModels.delete(threadId)
    this.subtaskWorktrees.forget(threadId)
    this.contextBreakdowns.forget(threadId)
    this.todos.delete(threadId)
    this.planModes.delete(threadId)
    this.outsideWrites.forget(threadId)
    this.manuallyUnread.delete(threadId)
    // When the canonical copy is gone, the index goes too (tombstone of 6.2 / 6.5).
    this.deps.index.removeThread(threadId)
    this.views.forgetThread(threadId)
    this.gatewayRequests.forgetThread(threadId)
    this.emitThreads()
    this.emitDeletedThreads()
    // TODO 633 stage 1: clean up the worktrees that conversation created (do not wait: deleting in git takes time on a big tree).
    // What was kept becomes a mark on the row of the deleted list. Restore (`restore`) waits for this cleanup before recreating.
    this.startWorktreeCleanup(threadId, false)
    if (scratchPath !== null) {
      // `scratchPathOf` passed = one level under the root and the name is the thread id. Never delete anything else.
      try {
        await rm(scratchPath, { recursive: true, force: true })
        log.info('thread.scratch.removed', { threadId, entries: scratchEntries })
      } catch (err) {
        // The thread is already (logically) deleted. A directory left behind is picked up by the next launch's sweep (`sweepScratch`, T23)
        // if empty. If contents remain it is not touched (a case where the user meant to discard but wanted to keep it after all).
        log.warn('thread.scratch.removeFailed', { threadId, ...errorFields(err) })
      }
    }
    return { removed: true, scratchEntries }
  }

  /**
   * The list of deleted ones (item 191). Shown in the fold at the bottom of the Sidebar. It is not placed in the
   * settings screen (owner decision 2026-09-28). The retention period is unlimited: there is no new cleanup mechanism.
   */
  listDeletedThreads(): readonly DeletedThreadSummary[] {
    return this.store.listDeletedThreads()
  }

  /**
   * Where a `thread://<threadId>/<eventId>` link points (TODO 1155). Ids that came from the renderer are re-validated
   * for shape (`isThreadLinkId`, item 86). For a link that does not point at a message, `eventId` is null.
   */
  locateThreadLink(threadId: unknown, eventId: unknown): ThreadLinkLocation {
    if (!isThreadLinkId(threadId)) throw reasonError('invalid-value', { field: 'threadId' })
    if (eventId !== null && !isThreadLinkId(eventId)) throw reasonError('invalid-value', { field: 'eventId' })
    return this.store.locateThreadLink(threadId, eventId)
  }

  /**
   * Undoes logical deletion (item 64) (item 191). It only puts back `deleted_at`, and from then on it is visible
   * normally to `getThread` / `listThreads`. **Files of the scratch area do not come back** (`remove` already
   * deleted them for real; only the row returns). null for an id that is not deleted or does not exist.
   *
   * The startup import of the conversation index (6.1) covers only rows after the high-water mark (item 76), so
   * rows tombstoned while it was deleted would not return until the full re-feed every 7 days. So **all of this
   * thread's index-target rows** are re-fed on the spot (owner decision 2026-10-01; it used to be only the most
   * recent `TIMELINE_LIMIT` rows, and older messages did not appear in search until the next full re-feed).
   * `indexConversationEvents` is an upsert (item 76), so it does not double-write, and the index process reads
   * the body by reverse RPC. Only id, kind and time are read, with keyset paging on `seq` of `RESTORE_INDEX_PAGE`
   * rows per page. With `retention='none'` there are no saved rows, so nothing is sent.
   */
  async restore(threadId: string): Promise<Thread | null> {
    // If a cleanup is in progress, wait for it to finish (so that the cleanup does not delete right after recreating).
    await this.worktreeCleanups.get(threadId)
    if (this.stopped) return null
    if (!this.store.restoreThread(threadId)) return null
    // A fix from the code-review of TODO 633: recreate the worktrees deleted by cleanup at the same path and with the same branch name.
    await this.restoreThreadWorktrees(threadId)
    const thread = this.store.getThread(threadId)
    if (thread !== null && thread.retention !== 'none') this.reindexThread(threadId)
    this.emitThreads()
    this.emitDeletedThreads()
    return thread
  }

  /**
   * Notifies the list and index of threads added from an export file (TODO 1088, 8.6). The rows have already been
   * written by `ThreadStore.importThreadChunk`. The index uses the same entry point as `restore` (all of this
   * thread's index-target rows go to the index process); main does not touch the index tables.
   */
  threadsImported(threadIds: readonly string[]): void {
    if (this.stopped) return
    for (const threadId of threadIds) this.reindexThread(threadId)
    this.emitThreads()
  }

  /** Sends all of one thread's index-target rows to the index process (the re-index of `restore`). */
  private reindexThread(threadId: string): void {
    let sinceSeq = 0
    let sent = 0
    for (;;) {
      const page = this.store.indexableEventsOfThread(threadId, { sinceSeq, limit: RESTORE_INDEX_PAGE })
      if (page.length === 0) break
      this.deps.index.indexConversationEvents(
        page.map((event) => ({ id: event.id, threadId: event.threadId, title: event.label, ts: event.ts }))
      )
      sent += page.length
      const last = page[page.length - 1]
      if (last === undefined || page.length < RESTORE_INDEX_PAGE) break
      sinceSeq = last.seq
    }
    log.info('thread.restore.reindexed', { threadId, events: sent })
  }

  /**
   * The conversation's working folder (TODO 633 stage 1). The worktree's path if it moved there, otherwise the
   * original cwd. Existence is not checked (launch checks it with `workingCwdForSpawn`).
   */
  private workingCwdOf(thread: Thread): string {
    return uriToPath(workingCwdUri(thread))
  }

  /**
   * The working folder passed to launch and `!` (TODO 633 stage 1). If it moved to a worktree, start there:
   * resume (`--resume`) looks up the transcript's storage location (per cwd), so it must start in the cwd it moved to (spike 24 / 30).
   * If the worktree is gone (the user deleted it by hand, etc.), go back to the original cwd and clear the column too.
   */
  private async workingCwdForSpawn(given: Thread): Promise<string> {
    // The caller's `Thread` can be stale across an await (the notice of the move arrives afterwards). Re-read the row.
    const thread = this.store.getThread(given.id) ?? given
    const cwd = uriToPath(thread.cwdUri)
    if (thread.worktreeUri === undefined) {
      this.outsideWrites.setWorktreeActive(thread.id, false)
      return cwd
    }
    const worktree = uriToPath(thread.worktreeUri)
    try {
      if ((await stat(worktree)).isDirectory()) {
        this.outsideWrites.setWorktreeActive(thread.id, true)
        return worktree
      }
    } catch {
      // Missing or unreadable: go back to the original cwd.
    }
    this.outsideWrites.setWorktreeActive(thread.id, false)
    if (!this.stopped && this.store.setWorktreeCwd(thread.id, null)) {
      log.info('thread.worktree.gone', { threadId: thread.id, path: worktree })
      this.emitThread(thread.id)
    }
    return cwd
  }

  /**
   * Worktree entry and exit (TODO 633 stage 1). Makes the conversation's working folder follow, and remembers the
   * worktrees that conversation created in the cleanup table. The list's key (`cwd`) is not changed. The path
   * is an absolute path built by the adapter.
   */
  private applyWorktreeChange(threadId: string, payload: WorktreeChangedPayload, at: number): void {
    if (this.stopped) return
    const thread = this.store.getThread(threadId)
    if (thread === null) return
    const repoCwd = uriToPath(thread.cwdUri)
    const path = resolve(payload.path)
    const origin = payload.change === 'child' ? 'child' : payload.atLaunch === true ? 'launch' : 'enter'
    // Bundle conversation (TODO 633 stage 3): entering at launch is done. Later launches are resumes, and the `--worktree` name is not needed.
    if (payload.atLaunch === true) this.bundles.enteredWorktree(threadId)
    // The original cwd itself is not remembered as a worktree (the first layer of defense so that cleanup does not delete the main copy.
    // The second layer is the storage-location check in `git/worktree-cleanup.ts`).
    if (path !== resolve(repoCwd)) {
      this.store.addThreadWorktree({ threadId, path, branch: payload.branch, origin, repoCwd, at })
    }
    let moved = false
    if (payload.change === 'enter' || payload.change === 'exit') {
      const next =
        payload.change === 'enter'
          ? path
          : payload.returnCwd === null
            ? null
            : resolve(payload.returnCwd)
      const worktree = next === null || next === resolve(repoCwd) ? null : next
      moved = this.store.setWorktreeCwd(threadId, worktree)
      this.outsideWrites.setWorktreeActive(threadId, worktree !== null)
      // The mark that recreating failed (TODO 633) is cleared the next time it enters a worktree.
      if (worktree !== null && this.store.setWorktreeLost(threadId, null)) moved = true
    }
    log.info('thread.worktree.changed', { threadId, change: payload.change, origin, path })
    if (moved) this.emitThread(threadId)
  }

  /**
   * Marks the thread if it is a tool_use that reads a secret (TODO 1043, 4.2.1). The decision is the adapter's
   * (`secretReadAction`, constraint 6). To avoid fetching the row (`getThread` is main's synchronous SQL), it asks the
   * adapters it has in turn; the decision is a pure function of only the argument strings.
   */
  private noteSecretRead(threadId: string, name: string, input: unknown): void {
    if (this.broker.hasReadSecret(threadId)) return
    for (const adapter of this.adapters.values()) {
      const source = adapter.secretReadAction?.(name, input) ?? null
      if (source === null) continue
      this.broker.markSecretRead(threadId, source)
      return
    }
  }

  /**
   * Remembers the target of a write tool (TODO 700). How to read the target path is the adapter's (`writeToolTargetPath`, constraint 6).
   * Only mark candidates (a worktree-split turn's writes to the main working copy) wait for the result.
   */
  private noteWriteTarget(
    threadId: string,
    name: string,
    payload: { readonly toolUseId: string; readonly input: unknown },
    parentToolUseId: string | undefined
  ): void {
    // An ordinary conversation (not a turn split into a bundle, not moved to a worktree, and with no worktree child) returns at once:
    // do not fetch the row and resolve the path on every tool_use (a fix from code-review; `getThread` is main's synchronous SQL).
    if (!this.outsideWrites.mayMark(threadId)) return
    const thread = this.store.getThread(threadId)
    if (thread === null) return
    const target = this.adapters.get(thread.backend)?.writeToolTargetPath?.(name, payload.input) ?? null
    if (target === null || target.trim() === '') return
    this.outsideWrites.noteWrite(threadId, {
      toolUseId: payload.toolUseId,
      target,
      parentToolUseId: parentToolUseId ?? null,
      repoCwd: uriToPath(thread.cwdUri),
      worktreeCwd: thread.worktreeUri === undefined ? null : uriToPath(thread.worktreeUri)
    })
  }

  /**
   * Raises the mark for a write outside the worktree (to the main working copy) (TODO 700): the list row
   * (`outside_write_at`) and the timeline row (`outside_write`, saved). It does not stop and does not ask (TODO 167).
   */
  private markOutsideWrite(threadId: string, sessionId: string, hit: OutsideWriteHit, at: number): void {
    if (this.stopped) return
    log.warn('thread.worktree.outsideWrite', { threadId, scope: hit.scope, path: hit.path })
    // code-review (TODO 709): the same decision as unread (`seen` at line 3646). While the conversation is being viewed in a front window,
    // do not set the warning mark: clearing it only on open (`markRead`) would make a new write that arrives while
    // it is still being viewed set it again and it would never go away. The timeline's `outside_write` row stays either way (a record of what happened).
    if (!this.views.isSeen(threadId) && this.store.setOutsideWriteAt(threadId, at)) this.emitThread(threadId)
    this.record(threadId, {
      id: randomUUID(),
      sessionId,
      threadId,
      ts: at,
      actor: 'main',
      kind: 'outside_write',
      payload: { toolUseId: hit.toolUseId, path: hit.path, scope: hit.scope }
    })
  }

  /**
   * Cleans up the worktrees that the conversation created (TODO 633 stage 1). Those that vanished or were removed
   * are dropped from the table, and those kept (changes, unpushed commits, a live lock, outside the storage
   * location) get a reason written and a mark on the deleted list. **No dialog is shown** (TODO 167). It checks
   * `stopped` every time right before writing to the DB (12.9: even if git returns after shutdown, nothing is
   * written; if `stopped` is false the DB is not closed yet).
   *
   * `retry` (TODO 748 (b)): rows whose result could not be written because it overlapped shutdown are re-fed by
   * the next launch's `reconcileWorktreePresence`. Then only rows with no result (both `kept` and `removed_head`
   * NULL) are looked at, and rows that were already absent (`gone`, a `removed` whose HEAD is unknown) are not
   * dropped from the table but get `REMOVED_HEAD_UNKNOWN`: they were things git had finished deleting in the
   * previous launch, to tell with the same mark as `worktree_lost` that restore cannot recreate them.
   */
  private startWorktreeCleanup(threadId: string, retry: boolean): void {
    const cleanup = this.cleanupThreadWorktrees(threadId, retry).finally(() => {
      if (this.worktreeCleanups.get(threadId) === cleanup) this.worktreeCleanups.delete(threadId)
    })
    this.worktreeCleanups.set(threadId, cleanup)
  }

  private async cleanupThreadWorktrees(threadId: string, retry = false): Promise<void> {
    const targets = this.store
      .threadWorktrees(threadId)
      .filter((target) => target.removedHead === null && (!retry || target.kept === null))
    if (targets.length === 0) return
    const cleanup =
      this.deps.cleanupWorktree ?? ((target: WorktreeCleanupTarget) => cleanupWorktreeOutcome(target))
    let kept = false
    for (const target of targets) {
      if (this.stopped) return
      // Keep it if another non-deleted conversation (a branch, a conversation that entered the same worktree) uses it (a fix from code-review).
      // When that conversation is deleted, check again with that conversation's row.
      if (this.store.isWorktreeReferencedByOthers(threadId, target.path)) {
        this.store.markThreadWorktreeKept(threadId, target.path, 'shared')
        kept = true
        log.info('thread.worktree.cleanup', { threadId, path: target.path, origin: target.origin, verdict: 'shared' })
        continue
      }
      const answer = await cleanup({ path: target.path, branch: target.branch, repoCwd: target.repoCwd })
      if (this.stopped) return
      const outcome: WorktreeCleanupOutcome =
        typeof answer === 'string' ? { verdict: answer, head: null, branch: null } : answer
      const verdict = outcome.verdict
      let copied = 0
      if (verdict === 'removed' && outcome.head !== null) {
        // Keep the row and write the material for recreating (restore recreates it at the same path with the same branch name).
        this.store.setThreadWorktreeRemoved(threadId, target.path, outcome.head, outcome.branch)
        // TODO 748 (c): so that other deleted conversations that kept the same worktree as `shared` can also be recreated by restore.
        copied = this.store.copyWorktreeRemovedToShared(
          threadId,
          target.path,
          outcome.head,
          outcome.branch ?? target.branch
        )
      } else if (verdict === 'removed' || verdict === 'gone') {
        if (retry) this.store.setThreadWorktreeRemoved(threadId, target.path, REMOVED_HEAD_UNKNOWN)
        else this.store.forgetThreadWorktree(threadId, target.path)
        // TODO 748 (c): the worktree is already gone. Rows kept as `shared` get the mark that it cannot be recreated.
        copied = this.store.copyWorktreeRemovedToShared(threadId, target.path, REMOVED_HEAD_UNKNOWN, null)
      } else {
        this.store.markThreadWorktreeKept(threadId, target.path, verdict)
        kept = true
      }
      // If the number of `shared` rows decreases, the "worktree N" on the deleted list changes too.
      if (copied > 0) kept = true
      log.info('thread.worktree.cleanup', {
        threadId,
        path: target.path,
        origin: target.origin,
        verdict,
        ...(retry ? { retry: true } : {}),
        ...(copied > 0 ? { sharedRows: copied } : {})
      })
    }
    if (kept) this.emitDeletedThreads()
  }

  /**
   * Recreates a restored conversation's worktrees that cleanup deleted (a fix from the code-review of TODO 633,
   * owner decision 2026-10-11). If it cannot be recreated, it is dropped from the table, and if that was the
   * conversation's working folder, go back to the original cwd and mark the list row (`worktree_lost`).
   * **No dialog is shown** (TODO 167). It checks `stopped` every time right before writing to the DB (12.9).
   */
  private async restoreThreadWorktrees(threadId: string): Promise<void> {
    const targets = this.store.threadWorktrees(threadId).filter((target) => target.removedHead !== null)
    if (targets.length === 0) return
    const recreate = this.deps.recreateWorktree ?? ((target: WorktreeRestoreTarget) => recreateWorktree(target))
    let changed = false
    for (const target of targets) {
      if (this.stopped) return
      const head = target.removedHead
      if (head === null) continue
      // TODO 748 (b) / (c): a row that vanished but whose HEAD is unknown is not recreated and gets the same mark as one that could not be recreated.
      const verdict: WorktreeRestoreVerdict | 'lost' =
        head === REMOVED_HEAD_UNKNOWN
          ? 'lost'
          : await recreate({ path: target.path, branch: target.branch, head, repoCwd: target.repoCwd })
      if (this.stopped) return
      log.info('thread.worktree.restore', { threadId, path: target.path, origin: target.origin, verdict })
      if (verdict === 'restored') {
        this.store.setThreadWorktreeRemoved(threadId, target.path, null)
        continue
      }
      this.store.forgetThreadWorktree(threadId, target.path)
      const thread = this.store.getThread(threadId)
      if (thread?.worktreeUri !== undefined && resolve(uriToPath(thread.worktreeUri)) === resolve(target.path)) {
        this.store.setWorktreeCwd(threadId, null)
        this.store.setWorktreeLost(threadId, target.path)
        changed = true
      }
    }
    if (changed) this.emitThread(threadId)
  }

  /**
   * Notices at startup, by re-checking existence, worktrees that were deleted by hand outside aios (TODO 714).
   *
   * Two marks can drift: (1) a live conversation's `worktree_cwd` (the list's worktree name), (2) the
   * `thread_worktrees` rows kept as `kept` by cleanup (the deleted list's worktree N). Both disappear only when
   * aios itself ran `git worktree remove` (`removed_head` is written only when aios removed it; an observation of
   * the 38th proxy verification 720). If the user runs `git worktree remove` outside (a terminal etc.), it is
   * gone from disk but remains in aios's table.
   *
   * At every launch it re-checks existence with `stat`; if missing, (1) goes back to the original cwd (the same
   * "go back if missing" as `workingCwdForSpawn`, done here too without waiting for the thread to be opened /
   * sent), and (2) is dropped from the table (it can no longer be cleaned up, so there is no reason to keep it as
   * `kept`; it is not a target of recreation (`removedHead`), so `restoreThreadWorktrees` does not look at it).
   * **No dialog is shown** (TODO 167).
   *
   * TODO 748: among (2), `shared` rows of deleted conversations are not dropped but become
   * `REMOVED_HEAD_UNKNOWN` (marked `worktree_lost` on restore). Finally (3) it re-feeds cleanup rows with no
   * result (those that overlapped shutdown).
   */
  private async reconcileWorktreePresence(): Promise<void> {
    const exists = this.deps.pathExists ?? pathExists
    let anyThreadChanged = false
    for (const thread of this.store.listThreads()) {
      if (this.stopped) return
      if (thread.worktreeUri === undefined) continue
      const path = uriToPath(thread.worktreeUri)
      const present = await exists(path)
      if (this.stopped) return
      if (present) continue
      // code-review (TODO 714): the copy from `listThreads()` is stale (during the async stat, a conversation may have moved to another
      // worktree). Just before deleting, re-read the row and delete only when `worktree_cwd` is still the same as the
      // stat'ed value (same idea as `workingCwdForSpawn`: do not delete the next worktree's record on stale state).
      const current = this.store.getThread(thread.id)
      if (current === null || current.worktreeUri === undefined || uriToPath(current.worktreeUri) !== path) continue
      if (this.store.setWorktreeCwd(thread.id, null)) {
        log.info('thread.worktree.gone', { threadId: thread.id, path })
        anyThreadChanged = true
      }
    }
    if (anyThreadChanged) this.emitThreads()

    let anyKeptChanged = false
    for (const target of this.store.allKeptWorktrees()) {
      if (this.stopped) return
      const present = await exists(target.path)
      if (this.stopped) return
      if (present) continue
      anyKeptChanged = true
      // TODO 748 (c): a `shared` row that another conversation's cleanup removed (left from before this fix): dropping it from the table
      // would make restore silently return the working folder to the original cwd. For a deleted conversation, mark it as "vanished but cannot be recreated".
      if (target.kept === 'shared' && this.store.getThread(target.threadId) === null) {
        this.store.setThreadWorktreeRemoved(target.threadId, target.path, REMOVED_HEAD_UNKNOWN)
        log.info('thread.worktree.reconcileLost', { threadId: target.threadId, path: target.path })
        continue
      }
      this.store.forgetThreadWorktree(target.threadId, target.path)
      log.info('thread.worktree.reconcileForgot', { threadId: target.threadId, path: target.path })
    }
    if (anyKeptChanged) this.emitDeletedThreads()

    // TODO 748 (b): re-feed cleanups whose result could not be written because it overlapped the previous launch's shutdown. **Do not wait**:
    // git deletion can take time, so `stop()` (which waits for this) is not made to wait on git. Restore waits on `worktreeCleanups`.
    for (const threadId of this.store.deletedThreadsWithPendingWorktrees()) {
      if (this.stopped) return
      if (this.worktreeCleanups.has(threadId)) continue
      log.info('thread.worktree.cleanupRetry', { threadId })
      this.startWorktreeCleanup(threadId, true)
    }
  }

  /**
   * TODO 1118: at the first send, adds the working-folder history (`touchCwd`) that was deferred at creation. The
   * decision is only the per-conversation mark (`markCwdHistoryDeferred`, kept in `app_settings`, so it survives
   * a restart) and it is cleared here. The earlier decision "a folder not yet in the history" also hit conversations
   * made in the create dialog after the user had removed the folder from recent folders, and put back history the
   * user had removed (a fix from review). No mark is put on a scratch conversation.
   */
  private touchCwdOnFirstSend(thread: Thread): void {
    if (thread.cwdHistoryDeferred !== true) return
    if (!this.store.takeCwdHistoryDeferred(thread.id)) return
    this.store.touchCwd(uriToPath(thread.cwdUri))
    log.info('thread.cwdHistory.touchedOnSend', { threadId: thread.id })
    void this.refreshTrayFolders()
    // Lower the band (`Thread.cwdHistoryDeferred`). It is cleared even if the send is refused at the choke point and no message remains.
    this.emitThread(thread.id)
  }

  /** The path of this thread's scratch area (under either known root, so it can be created). null for a thread that has none. */
  private scratchPathOf(thread: Thread): string | null {
    const cwd = uriToPath(thread.cwdUri)
    return isScratchCwd(this.deps.fs.homePath, cwd, thread.id, this.deps.scratchRoot) ? cwd : null
  }

  /** Like `scratchPathOf`, but only for this profile's own root: the only one whose files this profile may delete (TODO 1314). */
  private ownScratchPathOf(thread: Thread): string | null {
    const cwd = uriToPath(thread.cwdUri)
    return isOwnScratchCwd(this.deps.fs.homePath, cwd, thread.id, this.deps.scratchRoot) ? cwd : null
  }

  /**
   * **Sweeps scratch areas that ended up empty** (T23 / TODO 32, ARCHITECTURE.md 4.3.2).
   *
   * `remove` deletes the scratch area only "when deleting a thread", so two gaps remained:
   * a scratch area that was created but nothing was written (only `startLive`'s `mkdir` ran), and the case
   * where `rm` failed and only the thread's row was removed (`thread.scratch.removeFailed`).
   * Both are "no row but the directory exists", so the same check picks them up.
   *
   * It sweeps only what `sweepableScratchDirs` accepts (a directory one level below the root, named as a UUID,
   * not the id of a live thread, empty). It uses **`rmdir`, not `rm -rf`**: if someone wrote into it between
   * the check and the deletion, it fails with `ENOTEMPTY` and stays.
   */
  private async sweepScratch(knownThreadIds: readonly string[]): Promise<void> {
    const root = this.deps.scratchRoot ?? scratchRoot(this.deps.fs.homePath)
    let names: string[]
    try {
      const dirents = await readdir(root, { withFileTypes: true })
      names = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch (err) {
      // No root = the scratch area was never used. For anything else, only record it and give up.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('thread.scratch.sweepFailed', errorFields(err))
      }
      return
    }
    const entries: ScratchRootEntry[] = []
    for (const name of names) {
      if (this.stopped) return
      entries.push({ name, isDirectory: true, isEmpty: await isEmptyDir(join(root, name)) })
    }
    const sweepable = sweepableScratchDirs(entries, knownThreadIds)
    let removed = 0
    for (const name of sweepable) {
      if (this.stopped) break
      // Do not catch a thread created during the sweep. The id list is from the time of `start()`,
      // so look it up again here (`stop()` waits, so the DB is still open).
      if (this.store.getThread(name) !== null) continue
      try {
        await rmdir(join(root, name))
        removed += 1
      } catch (err) {
        log.warn('thread.scratch.sweepSkipped', errorFields(err))
      }
    }
    if (removed > 0) log.info('thread.scratch.swept', { removed, candidates: sweepable.length })
  }

  setRetention(threadId: string, retention: ThreadRetention, days: number | null): void {
    // Days must be an integer of 1 or more (item 86). With 0 or a negative number the cutoff lands in the future and
    // `applyRetention` deleted every row on the spot. Anything other than 'days' has no day count.
    if (retention === 'days' && (days === null || !isIntegerIn(days, 1, MAX_RETENTION_DAYS))) {
      throw reasonError('invalid-value', { field: 'retentionDays' })
    }
    if (!this.store.setRetention(threadId, retention, retention === 'days' ? days : null)) return
    // When changed to "do not save", also delete the rows so far (to match the intent of 4.3.1).
    if (retention === 'none') {
      this.store.clearTimeline(threadId)
      this.deps.index.removeThread(threadId)
    }
    this.emitThread(threadId)
  }

  /**
   * The Plan mode toggle (item 112 / 4.2.3). **It sends nothing to the process here**: just before the next send
   * (`ensureLive`) the running process's mode is aligned (so that it does not switch mid-response). If the backend
   * does not know Plan, it is not turned ON.
   */
  setPlanMode(threadId: string, on: boolean): void {
    const thread = this.store.getThread(threadId)
    if (thread === null) return
    const adapter = this.adapters.get(thread.backend)
    // On a version that cannot take a permission mode, plan cannot be set via the launch flag (`backends()` does not show the toggle either).
    if (on && (adapter?.supportsPlanMode?.() !== true || !adapter.supports('permission-mode'))) return
    // TODO 982: a drill runs in aios's default permission mode (Plan would change what reaches the approval choke point).
    if (on && thread.drill !== undefined) return
    if (this.planModes.has(threadId) === on) return
    if (on) this.planModes.add(threadId)
    else this.planModes.delete(threadId)
    log.info('thread.planMode', { threadId, on })
    this.emitThread(threadId)
  }

  /**
   * Auto-selecting the recommended option of a question (TODO 1222, 4.2.2). **Per conversation, default OFF**. Only
   * in an ON conversation, for a single-choice question whose first option is the recommended one, the
   * recommended option is chosen after a countdown. The Broker re-reads the `threads` row every time to decide. A
   * branch, transcript, copy or handoff does not carry the value over.
   */
  setAutoPickRecommended(threadId: string, on: boolean): void {
    const thread = this.store.getThread(threadId)
    if (thread === null || (thread.autoPickRecommended === true) === on) return
    this.store.setAutoPickRecommended(threadId, on)
    // When turned off, remove `autoPick` from that conversation's questions that are counting down (the Broker also re-reads and refuses an answer at the end of the count).
    if (!on) this.broker.autoPickDisabled(threadId)
    log.info('thread.autoPickRecommended', { threadId, on })
    this.emitThread(threadId)
  }

  /** Switch strict mode (T12). Takes effect from the next permission request that arrives. */
  setApprovalStrict(threadId: string, strict: boolean): void {
    const thread = this.store.getThread(threadId)
    if (thread === null || thread.approvalStrict === strict) return
    this.store.setStrict(threadId, strict)
    // "Do not ask about Bash in this conversation" (TODO 994) is a permission that exists only within strict mode. Forgotten when turned off, asked again when turned back on.
    if (!strict) this.broker.forgetThread(threadId)
    log.info('thread.approvalStrict', { threadId, strict })
    this.emitThread(threadId)
  }

  /**
   * Switch the OS sandbox (TODO 1106, 4.2.4). It is a launch flag, so the running process is restarted at the
   * next send (`LiveLifecycle.ensureLive` compares it with `Live.osSandbox`). **It can be turned ON only when the
   * backend has it** (the renderer greys it out, but it is checked here too). It can always be turned OFF (so that
   * a thread that became unusable can be sent) - **except in a drill** (TODO 982, wave 101 review fix Y): the sandbox is the drill's second
   * line under the gateway's stop, so a drill's sandbox cannot be turned OFF, before its one send or during it (the mark is read from the
   * DB, as the gateway does; the renderer's greyed-out toggle is only the display). A drill whose sandbox stopped working is started again.
   */
  setOsSandbox(threadId: string, on: boolean): void {
    const thread = this.store.getThread(threadId)
    if (thread === null || (thread.osSandbox === true) === on) return
    if (!on && this.store.drillStateOf(threadId) !== null) {
      log.warn('thread.osSandbox.refused', { threadId, reason: 'drill-locked' })
      throw reasonError('drill-locked')
    }
    // Returning silently would only make the renderer's checkbox revert with no visible reason. Refuse with a reason code (same for not yet probed).
    if (on && !this.supportsOsSandbox(thread.backend)) throw reasonError('os-sandbox-unsupported')
    this.store.setOsSandbox(threadId, on)
    log.info('thread.osSandbox', { threadId, on })
    this.emitThread(threadId)
  }

  /**
   * Whether that backend has the OS sandbox (TODO 1106 / 1109). False if not yet probed or an unknown backend.
   * The handoff, the toggle in the menu, and the import of an export (`DataTransfer`) use the same decision.
   */
  supportsOsSandbox(backend: string): boolean {
    return this.adapters.get(backend)?.supports('os-sandbox') === true
  }

  /** The OS sandbox's allow table (TODO 1106). Also adds the hosts of the destinations that are not asked about (TODO 1029). */
  private osSandboxPolicy(): OsSandboxPolicy {
    const policy = this.broker.getPolicy()
    return {
      allowedDomains: sandboxDomainsForLaunch(
        policy.sandboxAllowedDomains ?? DEFAULT_SANDBOX_ALLOWED_DOMAINS,
        policy.sshAllowedHosts ?? []
      ),
      // The saved value is already dropped in setApprovalPolicy, but drop it at launch too, for values stored before TODO 1109 or a home move.
      allowWrite: dropHomeWritePaths(policy.sandboxAllowWrite ?? DEFAULT_SANDBOX_ALLOW_WRITE, this.sandboxHomes())
    }
  }

  /**
   * The home directories compared with the sandbox's writable places (item 8 of TODO 1109). `os.homedir()`, and both if
   * its realpath differs (an environment where home is behind a symlink). The adapter also expands `~` with `os.homedir()`.
   */
  private sandboxHomes(): string[] {
    const home = homedir()
    // realpath is synchronous I/O, so only once per `home` (home does not move during a process's life; when a test
    // changes `$HOME`, `home` changes, so look it up again).
    if (this.sandboxHomesCache?.home !== home) {
      let real = home
      try {
        real = realpathSync(home)
      } catch {
        // If home cannot be read, compare it as it is.
      }
      this.sandboxHomesCache = { home, homes: real === home ? [home] : [home, real] }
    }
    return this.sandboxHomesCache.homes
  }
  private sandboxHomesCache: { readonly home: string; readonly homes: string[] } | null = null

  /**
   * The ViewerPane memory of a thread (item 63). Values from the renderer are **re-validated here**:
   * paths that are not `file:` or that hit the exclusion rules are not written (the memory stays as before).
   * The search term is cut by length. Whether it can be opened and read (the file vanished, etc.) is not checked;
   * that is covered by the error display of the viewer's read (`ViewerBroker.read`, item 160) when it is reopened.
   */
  setViewerState(threadId: string, uri: string | null, highlight: string | null): void {
    const thread = this.store.getThread(threadId)
    if (thread === null) return
    let normalized: string | null = null
    if (uri !== null && isWebViewerUrl(uri)) {
      // A web page (TODO 400). Remember the URL (it is not fetched at startup; the renderer shows only the heading).
      // If a secret (token etc.) is visible in the URL, do not remember it (same table as the redaction of constraint 10).
      if (redactText(uri).hits.length > 0) {
        log.warn('thread.viewerState.rejected', { threadId, reason: 'secret' })
        return
      }
      if (thread.lastViewerUri === uri && thread.lastViewerHighlight === null) return
      this.store.setViewerState(threadId, uri, null)
      this.emitThread(threadId)
      return
    }
    if (uri !== null) {
      let path: string
      try {
        path = uriToPath(uri)
      } catch {
        log.warn('thread.viewerState.rejected', { threadId, reason: 'scheme' })
        return
      }
      // Also remember what was shown in the viewer by the read exception (auto memory `.md`, item 254).
      if (
        !isAbsolute(path) ||
        !(this.deps.fs.isReferenceable(path) || this.deps.fs.isViewable(path))
      ) {
        log.warn('thread.viewerState.rejected', { threadId, reason: 'excluded' })
        return
      }
      normalized = pathToUri(path)
    }
    const trimmed = highlight?.trim() ?? ''
    const query =
      normalized === null || trimmed === '' ? null : trimmed.slice(0, MAX_VIEWER_HIGHLIGHT)
    if (thread.lastViewerUri === normalized && thread.lastViewerHighlight === query) return
    this.store.setViewerState(threadId, normalized, query)
    // Also deliver to the lists of other windows (T21). The renderer throttles at 300 ms before calling.
    this.emitThread(threadId)
  }

  /** The viewer's back / forward history (TODO 772). The body is in `viewer-history.ts`. It only reads and does not fetch URLs. */
  viewerHistory(threadId: string): ViewerHistorySnapshot | null {
    return this.viewerHistoryService.get(threadId)
  }

  /** After a file / folder rename, rewrites the old URIs in the saved histories of all conversations (TODO 1149). */
  noteFileRenamed(fromUri: string, toUri: string): void {
    this.viewerHistoryService.renameUris(fromUri, toUri)
  }

  /** Saves the history (TODO 772). The renderer's value is re-validated in main. */
  setViewerHistory(threadId: string, snapshot: unknown): void {
    this.viewerHistoryService.set(threadId, snapshot)
  }

  clearLog(threadId: string): void {
    this.store.clearTimeline(threadId)
    // The to-do list (item 118) is restored from `thread_events`, so it disappears together with the log.
    this.todos.delete(threadId)
    // Do not mix the `!` results of deleted rows into the context later (item 116).
    this.pendingShell.delete(threadId)
    this.deps.index.removeThread(threadId)
    this.emitThread(threadId)
  }

  clearAllLogs(): void {
    this.store.clearAllTimelines()
    this.todos.clear()
    this.deps.index.removeAllConversations()
    log.info('thread.logs.cleared', {})
    this.emitThreads()
  }

  /**
   * Adds a directory to the reference range (4.4 / 4.5). Effective from the next launch.
   * A folder that cannot be added (an excluded one) is thrown with the reason code `allow-dir-excluded` (TODO 600;
   * it used to only log and return silently, and just the renderer's band disappeared). `/tmp` can be added (TODO 584).
   */
  allowDir(threadId: string, dirUri: string): Thread | null {
    const thread = this.store.getThread(threadId)
    if (thread === null) return null
    const path = uriToPath(dirUri)
    if (!this.deps.fs.isReferenceable(path)) {
      log.warn('thread.allowDir.rejected', { threadId, reason: 'excluded' })
      throw reasonError('allow-dir-excluded')
    }
    if (!this.store.addAllowedDir(threadId, path)) return thread
    const next = this.store.getThread(threadId) ?? thread
    log.info('thread.allowDir', { threadId, dirs: next.allowedDirUris.length })
    this.emitThread(threadId)
    return next
  }

  // ---- Send (reservations and interrupts: item 94 / 4.5.4) ----

  /**
   * A send from the composer. **If a response is in progress it is queued as a reservation** (it waits for the
   * current turn's `result` and sends one at a time from the head). If not responding, it is sent on the spot
   * (not via a reservation).
   *
   * A failure when sending on the spot (concurrency limit, launch failure, a model not in the list) is thrown to
   * the caller as is (B-3: the message is not recorded, and the renderer keeps the input field). For a
   * reservation, only the specification (model / thinking) is validated before queuing, and a failure at send
   * time is reported in a form that remains as a timeline `error` and on the chip.
   */
  async send(threadId: string, input: SendInput, origin: SendOrigin = 'auto'): Promise<SendOutcome> {
    if (origin !== 'auto') this.noteHumanSend(threadId)
    return this.sendQueue.submit(threadId, input, false, origin === 'human' ? 'human' : 'auto')
  }

  /**
   * Interrupt (Cmd+Enter). If a response is in progress, interrupts the current turn (the process stays) and sends
   * this input **before the reservations**. Reserved ones remain behind it. If not responding, same as `send`.
   */
  async sendInterrupt(threadId: string, input: SendInput, origin: SendOrigin = 'auto'): Promise<SendOutcome> {
    if (origin !== 'auto') this.noteHumanSend(threadId)
    return this.sendQueue.submit(threadId, input, true, origin === 'human' ? 'human' : 'auto')
  }

  /**
   * Fix V (code-review): a message the person wrote themselves. For a trigger conversation, mark "a person
   * continued" and lift the read-only restriction (from the next launch the usual default; a running unattended
   * turn ends read-only because of `unattendedTurns`). Set synchronously, before the decision in `submit` (the
   * `ensureLive` on an immediate send restarts because the flags differ).
   */
  private noteHumanSend(threadId: string): void {
    if (this.store.markTriggerAttended(threadId)) log.info('trigger.thread.attended', { threadId })
  }

  /**
   * Fix V (code-review): whether to start this conversation unattended and read-only, and refuse at the choke
   * point without asking. True during a trigger's first turn (`unattendedTurns`) and **until a person speaks
   * themselves** (while `TriggerOrigin.attended` is absent). Sends that are not a person's action, such as an
   * automatic resend after auth expiry (`LoginRecovery`), a reservation send, a resume from an interruption
   * (TODO 628) and a bundle report, are started read-only here. The mark is in the DB's origin JSON, so it does
   * not come off across a restart.
   */
  private isTriggerReadOnly(threadId: string): boolean {
    if (this.unattendedTurns.has(threadId)) return true
    const origin = this.store.getThread(threadId)?.triggerOrigin
    return origin !== undefined && origin.attended !== true
  }

  /**
   * TODO 972: the standing instructions of the conversation's role (Teammate), read on every launch. null when the conversation has no
   * role, the role is gone, or the instructions are empty. **Not the approval role** (`roleOf`): permissions are a separate
   * thing, keyed by the Teammate's grant table (983 stage 4).
   */
  private roleInstructionsOf(thread: Thread): string | null {
    if (thread.roleId === undefined) return null
    // Code-review (wave 96 fix Y): cleaned again here - a row saved before the input check dropped control characters must not make `spawn` throw.
    const text = cleanRoleInstructions(this.deps.roles?.get(thread.roleId)?.instructions ?? '')
    return text.trim() === '' ? null : text
  }

  /**
   * TODO 972: a role was deleted. Its conversations stay and go back to the ordinary list (no role); the list is sent again to all windows.
   */
  forgetRole(roleId: string): void {
    // TODO 983 stage 4: the grant rows were deleted from the DB with the role (`RoleStore.delete`, one transaction); drop them from the Broker's
    // memory too, with the audit log (`approval.grant.removed`, reason `role-deleted`).
    this.broker.removeRoleGrantsOf(roleGrantKey(roleId), 'role-deleted')
    const changed = this.store.clearRole(roleId)
    if (changed > 0) this.emitThreads()
    log.info('role.forgotten', { conversations: changed })
  }

  /**
   * TODO 1288: moves an existing conversation under a role (Teammate), or takes it out (`roleId` null). Both ids are re-checked here
   * (the renderer's values are not trusted). Only `threads.role_id` changes: the folder, Model and the running session stay as they
   * are, and the role's standing instructions apply from the next launch (read on every launch, `roleInstructionsOf`).
   * Refused (closing side): a conversation that is running (`role-move-busy`), and one started by a scheduled run or a trigger or
   * in the middle of an unattended turn (`role-move-unattended` - the permission table is per role in 983 stage 4, so moving would
   * change what is allowed). Nothing is logged but ids and flags.
   */
  moveThreadToRole(threadId: unknown, roleId: unknown): void {
    if (typeof threadId !== 'string' || threadId === '' || threadId.length > 200) throw reasonError('invalid-value', { field: 'threadId' })
    if (roleId !== null && (typeof roleId !== 'string' || roleId === '' || roleId.length > 200)) throw reasonError('invalid-value', { field: 'roleId' })
    const thread = this.store.getThread(threadId)
    if (thread === null) throw reasonError('invalid-value', { field: 'threadId' })
    if (roleId !== null && (this.deps.roles?.get(roleId) ?? null) === null) throw reasonError('role-not-found')
    // TODO 982: a drill stays under the Teammate it drills (its list's "allow from now on" goes to that Teammate's table).
    if (thread.drill !== undefined) throw reasonError('drill-locked')
    if (
      thread.scheduledJobId !== undefined ||
      thread.triggerOrigin !== undefined ||
      this.unattendedTurns.has(threadId) ||
      this.scheduledTurns.has(threadId)
    ) {
      throw reasonError('role-move-unattended')
    }
    const live = this.live.get(threadId)
    if (this.isThreadBusy(threadId) || (live !== undefined && live.state !== 'idle' && live.state !== 'error')) {
      throw reasonError('role-move-busy')
    }
    if ((thread.roleId ?? null) === roleId) return
    if (!this.store.setRole(threadId, roleId)) throw reasonError('invalid-value', { field: 'threadId' })
    this.emitThreads()
    log.info('thread.role.moved', { threadId, toRole: roleId !== null })
  }

  /**
   * TODO 983 (1. of 4.2.5): a conversation's approval role, built from main's own rows on every call (never cached on the conversation, and never
   * from a value the renderer sent). Stage 4 (owner decision 2026-11-21) has two kinds of keys:
   *  - a conversation under a Teammate (`threads.role_id`, the role still exists) consults `role:<roleId>`, and a press adds to it;
   *  - a scheduled job's conversation (`threads.schedule_job_id`, the job still exists) also consults `job:<jobId>` (those rows are not moved).
   *    A job with no Teammate adds to the job's key as before.
   * Null for a trigger conversation (not a role in this stage), an ordinary conversation, or one whose Teammate and job are both gone.
   * Moving a conversation to another Teammate therefore switches the table at the next request, and a "this conversation only" row of the
   * old Teammate stops applying (its key is no longer consulted).
   */
  private roleOf(threadId: string): ApprovalRole | null {
    const thread = this.store.getThread(threadId)
    if (thread === null || thread.triggerOrigin !== undefined) return null
    const jobId = thread.scheduledJobId
    const jobName = jobId === undefined || jobId === '' ? null : (this.deps.scheduledJobName?.(jobId) ?? null)
    const jobKey = jobName === null ? null : `job:${jobId}`
    const role = thread.roleId === undefined ? null : (this.deps.roles?.get(thread.roleId) ?? null)
    if (role !== null) {
      const key = roleGrantKey(role.id)
      return { key, name: role.name, kind: 'teammate', keys: jobKey === null ? [key] : [key, jobKey] }
    }
    return jobKey === null || jobName === null ? null : { key: jobKey, name: jobName }
  }

  /**
   * TODO 1227: in an unattended read-only conversation, whether the tool `toolName` of a non-bundled extension
   * `pluginId` may pass. Only when it is a tool of the same extension as the conversation's origin
   * (`threads.trigger_origin`, a value main wrote when starting the conversation) and that rule allows it. False
   * for a conversation with no origin (scheduled runs etc., which have no rule). The rule is looked up again on
   * every call (a permission the user removed takes effect immediately).
   */
  private triggerRuleAllowsTool(threadId: string, pluginId: string, toolName: string, fingerprint: string): boolean {
    const origin = this.store.getThread(threadId)?.triggerOrigin
    if (origin === undefined || origin.pluginId !== pluginId) return false
    return this.deps.triggerToolAllowance?.(origin.pluginId, origin.triggerId, toolName, fingerprint) === true
  }

  /**
   * Sends the last input once more (TODO 893, the auth-expiry badge). If a response is in progress, it is queued as a reservation.
   * `by` (TODO 1289): `human` only from the IPC handler of the button a person pressed; the automatic resend after a re-login
   * (`LoginRecovery`) keeps the default `auto`. It does not lift a trigger's read-only restriction (`noteHumanSend`): the text is
   * the last input, which may be what the trigger itself sent.
   */
  async resendLast(threadId: string, by: TurnStarter = 'auto'): Promise<SendOutcome> {
    return this.sendQueue.resendLast(threadId, by)
  }

  /** Cancels a reservation (the chip's cross). False if not found (already sent, etc.). */
  cancelReservation(threadId: string, reservationId: string): boolean {
    return this.sendQueue.cancelReservation(threadId, reservationId)
  }

  /**
   * Takes a reservation out of the queue and returns its contents (the chip's pencil: put it back in the input
   * field to edit). Includes the attachment contents. null if not found.
   */
  takeReservation(threadId: string, reservationId: string): SendInput | null {
    return this.sendQueue.takeReservation(threadId, reservationId)
  }

  /**
   * Sends an interrupt to the current turn (item 94). The process is not stopped. When the interrupt's `result`
   * arrives, `onAgentEvent` advances the queue and the interrupting input is sent from the head.
   *
   * Pending approval requests are cancelled here: the interrupt ends the backend-side tool calls, so there is
   * nowhere to send an answer. Cancel **right after writing the interrupt and before waiting for the response**:
   * if done after waiting, the interrupt's `result` may arrive first and the next turn may start, and its approvals could be cleared too.
   *
   * If the interrupt is not accepted (the version does not support it, or a timeout), fall back to the same SIGINT
   * as the stop button. The exit notification looks at `interrupting` and sends the interrupting input via resume.
   */
  private async requestInterrupt(threadId: string): Promise<void> {
    const queue = this.sendQueue.get(threadId)
    const live = this.live.get(threadId)
    const session = live?.session
    if (queue === undefined || !queue.awaitingResult || queue.interrupting) return
    if (live === undefined || session === null || session === undefined || !session.alive) return
    queue.interrupting = true
    log.info('session.interrupt', { threadId, pendingApprovals: live.pendingApprovals.size })
    const done = session.interrupt()
    if (live.pendingApprovals.size > 0) this.broker.cancelThread(threadId, 'interrupt')
    try {
      await done
    } catch (err) {
      log.warn('session.interrupt.failed', { threadId, ...errorFields(err) })
      // Fall back only if it is still waiting for the same turn (if a `result` arrived in the meantime, it is not needed).
      if (queue.interrupting && queue.awaitingResult && session.alive) abortLive(live)
    }
  }

  /**
   * The core that hands one item to the backend (validation, launch, recording the message, writing to stdin).
   * Only `SendQueueService.dispatch` calls it (TODO 578 (b): raising and lowering the queue's marks is in send-queue.ts).
   */
  private async dispatchNow(threadId: string, input: SendInput, queue: SendQueue): Promise<void> {
    const thread = this.store.getThread(threadId)
    if (thread === null) throw new Error('thread not found')
    this.touchCwdOnFirstSend(thread)
    // `!` (item 116): aios runs it without starting the backend. No login or launch is needed.
    if (input.shell === true) {
      await this.runShellInput(thread, input)
      return
    }

    // TODO 1114: decide by the thread's backend state (not the default backend).
    const backend = await this.assertUsable(thread)
    // If the version is unknown, check the feature table before the first send (item 81). The `resolveSettings`
    // below and spawn look at the feature table after it has been checked.
    await this.ensureProbed(backend)

    // Per-message model / thinking (T7 / 4.5.1). **The renderer's value is re-validated here.**
    // Plan mode (item 112) is the toggle's current value. Reserved ones also run with the value at the moment of sending.
    const wanted: WantedSettings = {
      ...(await this.resolveSettings(thread, input)),
      planMode: this.planModes.has(threadId)
    }
    const text = this.attachmentService.composeText(thread, input)
    // Nothing is mixed into the head of a slash-command message (neither the handoff text nor `!` results). If something is
    // prepended, the backend does not accept it as a command. What would be mixed in is carried over to the next ordinary message (review of TODO 961).
    const isCommand = slashName(text) !== null
    // TODO 961: only for the first ordinary message of a handoff thread, prepend the source conversation's text (it is not put in the recorded `user_text`).
    const handoff = isCommand ? null : await this.pendingHandoffPrefix(thread)
    const handoffPrefix = handoff?.text ?? ''
    // **Record after the launch succeeds.** If we recorded first, then when the concurrency limit or a spawn failure throws,
    // a message that could not be sent would be saved and indexed, and become a duplicate on resend
    // (review B-3).
    // If the specification differs from the running process, it is dropped inside this and restarted via resume.
    const before = this.effectiveSettings(thread)
    const previous = this.live.get(threadId)
    const wasAlive = previous?.session?.alive === true
    const live = await this.lifecycle.ensureLive(thread, wanted)
    // TODO 568: if a delete / stop (`stopThread`) came while waiting for the launch (`starting`), that
    // `Live` is on the side being stopped. From here to `send` is synchronous, so checking here avoids running even one turn
    // (and nothing is recorded: no message row is left on a deleted thread).
    if (live.retiring || this.stopped || this.store.getThread(threadId) === null) {
      log.info('session.send.retired', { threadId })
      // TODO 928: if it is not being stopped (it was deleted / shut down during the launch), stop the process that came up here.
      // Leaving it unsent would hold a concurrency slot in `starting`, never be evicted, and block auto-update.
      if (!live.retiring) void this.stopThread(threadId)
      throw new Error('thread is being stopped')
    }
    // The route of the switch (item 95): the same `Live` as before = switched without dropping it.
    const via: 'live' | 'restart' | 'none' = !wasAlive ? 'none' : live === previous ? 'live' : 'restart'

    // "From now on" also rewrites the thread's default. It is written after the launch succeeds,
    // so a message that could not be sent never changes only the default.
    if (input.settingsScope === 'thread') {
      const current = this.store.getThread(threadId)
      if (
        current !== null &&
        (current.modelId !== wanted.modelId || current.thinking !== wanted.thinking)
      ) {
        this.store.setModelAndThinking(threadId, wanted.modelId, wanted.thinking)
        this.emitThreads()
      }
    }

    // The switch is kept in the timeline (T7). Saving goes through `toPersistable` (constraints 9 / 10).
    if (
      before.modelId !== wanted.modelId ||
      before.thinking !== wanted.thinking ||
      (input.settingsScope === 'thread' &&
        (thread.modelId !== wanted.modelId || thread.thinking !== wanted.thinking))
    ) {
      this.record(threadId, {
        id: randomUUID(),
        sessionId: live.sessionId,
        threadId,
        ts: Date.now(),
        actor: 'main',
        kind: 'settings_changed',
        payload: {
          modelId: wanted.modelId,
          thinking: wanted.thinking,
          scope: input.settingsScope === 'thread' ? 'thread' : 'message',
          via
        }
      })
    }

    const images = (input.attachments ?? [])
      .filter((a) => a.kind === 'image' && typeof a.base64 === 'string')
      .map((a) => ({ mediaType: a.mediaType ?? 'image/png', base64: a.base64 as string }))

    // TODO 700: whether this is a turn split into a bundle and run by worktree children (`/batch` etc.). Remembered until the next message
    // (the parent's autonomous turn after the children finish is the same turn). The adapter knows the command name (constraint 6).
    this.outsideWrites.startTurn(threadId, this.adapterFor(thread).startsParallelRun?.(input.text) === true)

    // Record our own message ourselves (do not rely on the backend echoing it).
    const sentAt = Date.now()
    const userEventId = randomUUID()
    this.record(threadId, {
      id: userEventId,
      sessionId: live.sessionId,
      threadId,
      ts: sentAt,
      actor: 'main',
      kind: 'user_text',
      // Sent images (TODO 550): files only by path; images with no file get only a reduced version (up to 1600 px).
      payload: { text, ...this.attachmentService.sentAttachmentsPayload(input) }
    })
    // Move the thread that sent to the head of the list (the sort key is the last event, item 83).
    this.store.touchLastEvent(threadId, sentAt)
    // If the title is provisional, name it with the first line. Whether it is provisional is kept in a column and decided by a conditional UPDATE
    // (it does not overwrite even if the user manually gave the same title as the default; item 83).
    // Do not name it from the heading or body of a selection (item 97). Take it from what the user typed.
    const titleSource =
      input.selection === undefined ? text : this.attachmentService.composeText(thread, { ...input, selection: undefined })
    // Build the title from the first body line that skips the attachment-mark lines (TODO 608). If the body is only attachments, use the attachment's name.
    const firstLine = titleLineOf(titleSource)
    const named =
      firstLine !== undefined &&
      this.store.setAutoTitle(threadId, redactText(firstLine).text.trim().slice(0, MAX_AUTO_TITLE)) // TODO 859: the title gets the same redaction as the persistence choke point
    if (named) this.emitThreads()
    else this.emitThread(threadId)

    live.lastActivity = Date.now()
    live.state = 'running'
    const adapter = this.adapterFor(thread)
    // The `!` results (item 116) are mixed into the head of this message. They are not put in the recorded `user_text`:
    // the timeline already shows them as `shell_run` rows (do not show them twice).
    // They are not mixed into a command message, and the held copy stays until the next message.
    const shellRuns = isCommand ? undefined : this.pendingShell.get(threadId)
    const shellContext =
      shellRuns === undefined || shellRuns.length === 0 ? '' : shellContextOf(adapter, shellRuns)
    const withHandoff = `${handoffPrefix}${text}`
    const sentText = shellContext === '' ? withHandoff : `${shellContext}\n\n${withHandoff}`
    // When the echo (item 113) arrives, copy the identifier onto this row. If a previous wait remains, discard it. Neither the handoff text nor the `!` results are
    // recorded (`user_text` is only the user's own text), but what the backend echoes is the sent text itself, so matching is
    // always done against the sent text (it used to compare with the plain text when only `!` results were mixed in, so no identifier was attached and rewind was impossible).
    live.pendingReplay = { eventId: userEventId, text: sentText }
    // TODO 982 (wave 101 review fix Y): from here the input may reach the backend (a failed drill send no longer goes back to `ready`).
    queue.reachedBackend = true
    // From here until `result` (or exit) is one turn. The next send becomes a reservation (item 94).
    queue.awaitingResult = true
    try {
      live.session?.send({ text: sentText, images: adapter.supports('image-input') ? images : [] })
      // Delete only what was handed over (if it could not be written, mix it into the next message again).
      if (shellRuns !== undefined) this.pendingShell.delete(threadId)
      // The mark that the handoff text was handed over. If it dies before its own session exists, it is attached again at the next send.
      if (handoff !== null && handoffPrefix !== '') this.store.markHandoffSent(threadId, handoff.through)
    } catch (err) {
      // Not written = no `result` will come. Stop the queue and make the remaining reservations wait until the next send.
      queue.awaitingResult = false
      this.sendQueue.setPaused(queue, true)
      // TODO 1289 (code-review, wave 97 fix Y): no turn runs, so no `result` would put the starter back.
      endTurn(queue)
      // `send` is promised to report write failures with an `error` event (item 82), but even if the implementation
      // throws synchronously, the message is already recorded, so it is not made a send failure; it appears in the
      // timeline as a stream anomaly (looks the same as a pipe EPIPE).
      log.warn('session.send.failed', { threadId, ...errorFields(err) })
      this.onAgentEvent(threadId, {
        id: randomUUID(),
        sessionId: live.sessionId,
        threadId,
        ts: Date.now(),
        actor: 'main',
        kind: 'error',
        payload: { message: (err as Error).message, code: null, origin: 'stream' }
      })
    }
    // A change of state (`running`) needs only one delivery (item 75: the full list is only for create, delete, rename).
    // The sort key (`lastEventAt`) was advanced by `touchLastEvent` above, and the receiver fixes the order with `threadRecency`.
    this.emitThread(threadId)
  }

  /**
   * Decides the model / thinking used for this message (T7 / 4.5.1).
   *
   * - Omitted (`undefined`) is the thread's default, `null` is an explicit "the backend's default".
   * - **Values from the renderer are re-validated here**: a model not in the list and an unknown thinking are
   *   rejected (same treatment as the create dialog).
   * - Not passed for a backend without the feature (4.6: passing it makes the launch itself fail).
   */
  private async resolveSettings(
    thread: Thread,
    input: SendInput
  ): Promise<{ modelId: string | null; thinking: ThinkingLevel | null }> {
    const adapter = this.adapterFor(thread)
    // An id from the previous table (item 91) is read as its alias before comparing / passing.
    const threadModelId = this.canonicalModel(thread.backend, thread.modelId)
    const modelId = this.canonicalModel(
      thread.backend,
      input.modelId === undefined ? thread.modelId : input.modelId
    )
    let thinking = input.thinking === undefined ? thread.thinking : input.thinking
    if (thinking !== null && !isThinkingLevel(thinking)) throw new Error('unknown thinking level')
    if (modelId !== null && (modelId !== threadModelId || thinking !== null)) {
      const models = await adapter.listModels()
      if (modelId !== threadModelId && !isSelectableModel(models, modelId)) {
        throw reasonError('model-not-selectable')
      }
      // If the saved value is a level that does not take effect on that model, pass it moved to an effective level (item 92). For example, a thread at
      // "none" on Sonnet switched to Opus, or "deep" left on Haiku.
      thinking = this.thinkingFor(models, modelId, thinking)
    }
    return {
      modelId: adapter.supports('model-select') ? modelId : null,
      thinking: adapter.supports('thinking-level') ? thinking : null
    }
  }

  /**
   * The model / thinking in effect now. If a process is running, the specification at its launch; otherwise
   * the thread's default (null if the feature is absent). Used to detect switches.
   */
  private effectiveSettings(thread: Thread): {
    modelId: string | null
    thinking: ThinkingLevel | null
  } {
    const live = this.live.get(thread.id)
    if (live !== undefined && live.session?.alive === true) {
      return { modelId: live.modelId, thinking: live.thinking }
    }
    const adapter = this.adapterFor(thread)
    return {
      modelId: adapter.supports('model-select')
        ? this.canonicalModel(thread.backend, thread.modelId)
        : null,
      thinking: adapter.supports('thinking-level') ? thread.thinking : null
    }
  }

  /**
   * Runs `!` from the composer (item 116 / 4.5.7). `/bin/zsh -lc` in the thread's cwd, with no approval
   * (it is the user's own input). The result is kept in the timeline as `shell_run` (saving goes through
   * redaction: `toPersistable`) and held in `pendingShell` until it is mixed into the head of the next message.
   * A failure (no cwd, timeout, non-zero exit) is shown in the same row and likewise goes into the context.
   */
  private async runShellInput(thread: Thread, input: SendInput): Promise<void> {
    const threadId = thread.id
    const command = shellCommandOf(input.text)
    if (command === null) throw reasonError('shell-invalid')
    const adapter = this.adapterFor(thread)
    const limits = adapter.shellLimits?.() ?? DEFAULT_SHELL_LIMITS
    // The scratch area (T19) may not have been created yet (it is created right before the first spawn). If `!` comes first,
    // create it here: from the user's point of view it is "this thread's working folder".
    const scratchPath = this.scratchPathOf(thread)
    if (scratchPath !== null) await mkdir(scratchPath, { recursive: true })
    const controller = new AbortController()
    let runs = this.shellRuns.get(threadId)
    if (runs === undefined) {
      runs = new Set()
      this.shellRuns.set(threadId, runs)
    }
    runs.add(controller)
    log.info('session.shell.start', { threadId })
    let result
    try {
      result = await (this.deps.runShell ?? runShellCommand)({
        command,
        cwd: await this.workingCwdForSpawn(thread),
        maxOutputChars: limits.maxOutputChars,
        timeoutMs: limits.timeoutMs,
        signal: controller.signal
      })
    } finally {
      runs.delete(controller)
      if (runs.size === 0 && this.shellRuns.get(threadId) === runs) this.shellRuns.delete(threadId)
    }
    log.info('session.shell.done', {
      threadId,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: result.truncated
    })
    // Do not record after shutdown or after the thread was deleted (12.9 / item 64).
    if (this.stopped || controller.signal.aborted || this.store.getThread(threadId) === null) return
    const payload: ShellRunPayload = { command, ...result }
    const ts = Date.now()
    this.record(threadId, {
      id: randomUUID(),
      sessionId: this.live.get(threadId)?.sessionId ?? '',
      threadId,
      ts,
      actor: 'main',
      kind: 'shell_run',
      payload
    })
    const pending = this.pendingShell.get(threadId)
    if (pending === undefined) this.pendingShell.set(threadId, [payload])
    else pending.push(payload)
    this.store.touchLastEvent(threadId, ts)
    this.emitThread(threadId)
  }

  /** Stops a running `!` (item 116). The stopped result is not recorded. */
  private abortShell(threadId: string): void {
    const runs = this.shellRuns.get(threadId)
    if (runs === undefined) return
    for (const run of runs) run.abort()
    this.shellRuns.delete(threadId)
  }

  /** Input with the selection attached to the send validated (item 97). An empty selection is removed. */
  private withCheckedSelection(input: SendInput): SendInput {
    if (input.selection === undefined) return input
    const selection = checkSelection(input.selection, this.deps.fs)
    if (selection !== null) return { ...input, selection }
    const { selection: _dropped, ...rest } = input
    return rest
  }

  /**
   * Stop (the composer's stop button and Esc; moved from the heading button in item 161). **It stops only the
   * current turn and leaves the process** (item 96, owner decision 2026-09-25): it sends the same interrupt
   * control request as an interrupt (Cmd+Enter), and the turn ends with the interrupt's `result` ("interrupted").
   * The next send writes to the same process, so the launch cost of `--resume` (about 21k tokens) is not incurred.
   *
   * If the interrupt is not accepted (the version does not support it, a timeout, a refusal), fall back to the
   * same SIGINT as before (`abort()`, which stops the whole process). Also SIGINT as before when not responding
   * (not waiting for a `result`): there is no turn to interrupt.
   *
   * Reservations are kept unsent (the queue is stopped), so that the next reservation does not start right after
   * stopping. It moves again when the user next sends. For a turn awaiting approval, pending approvals are also
   * cancelled (as with an interrupt, right after writing the interrupt and before waiting for the response).
   */
  async interrupt(threadId: string): Promise<void> {
    const queue = this.sendQueue.get(threadId)
    if (queue !== undefined) {
      // If it was in the middle of an interrupt, that input is not sent either (stop wins). Stop the exit notification
      // from looking at `interrupting` and sending it via resume. Cleared before the notice of the stopped mark (wave 106 review Z3).
      queue.interrupting = false
      this.sendQueue.setPaused(queue, true)
    }
    const live = this.live.get(threadId)
    // In the middle of a send (launching or validating, item 161): the turn to interrupt does not exist yet. Redo the stop right after
    // the write finishes (`dispatch`). Falling to SIGINT here would drop the message that is about to be written too.
    if (queue !== undefined && queue.dispatching) {
      queue.stopWhenWritten = true
      if (live !== undefined) {
        live.state = 'stopping'
        this.emitThread(threadId)
      }
      log.info('session.stop.deferred', { threadId })
      return
    }
    const session = live?.session
    if (live === undefined || session === null || session === undefined) return
    live.state = 'stopping'
    live.lastInterruptAt = Date.now()
    this.emitThread(threadId)
    if (queue === undefined || !queue.awaitingResult || !session.alive) {
      // TODO 1153: the parent's turn has ended and only background subagents are running. There is no turn to interrupt, and
      // subagents run outside the parent's turn, so close the subagents with "stop" and stop the whole process (the next send starts it via resume).
      if (live.subtasks.size > 0 && session.alive) {
        // If it is already being stopped (retiring), do not overlap: the same check as the grace timer's route (wave 71 review X).
        // Overlapping would run stop twice, and the subagents' "stop" rows would be synthesized separately from the cleanup on the stopping side.
        if (!live.retiring) await this.stopWithSubtasks(threadId, live, 'idle')
        return
      }
      abortLive(live)
      return
    }
    log.info('session.stop.interrupt', {
      threadId,
      pendingApprovals: live.pendingApprovals.size,
      subtasks: live.subtasks.size
    })
    const done = session.interrupt()
    if (live.pendingApprovals.size > 0) this.broker.cancelThread(threadId, 'stop')
    // TODO 1153: the interrupt stops only the parent's turn. If background subagents remain, stop the whole process after the grace period.
    if (live.subtasks.size > 0) this.armSubtaskStop(threadId, live)
    try {
      await done
    } catch (err) {
      log.warn('session.stop.interruptFailed', { threadId, ...errorFields(err) })
      // Fall back only if it is still waiting for the same turn (if a `result` arrived in the meantime, it is not needed).
      if (queue.awaitingResult && session.alive) {
        if (live.subtasks.size > 0) await this.stopWithSubtasks(threadId, live, 'interrupt-failed')
        else abortLive(live)
      }
    }
  }

  /**
   * After the stop button, waits `subtaskStopGraceMs` for the background subagents to finish (TODO 1153). If subagents
   * remain after that, stop the whole process. If the user sent something new during the wait (the queue started
   * moving), do not stop: it would drop that response too. Subagents can always be stopped with the list's stop button.
   */
  private armSubtaskStop(threadId: string, live: Live): void {
    this.clearSubtaskStop(threadId)
    const timer = setTimeout(() => {
      this.subtaskStopTimers.delete(threadId)
      if (this.stopped || this.live.get(threadId) !== live || live.subtasks.size === 0) return
      if (live.session?.alive !== true || live.retiring) return
      if (this.sendQueue.get(threadId)?.paused === false) {
        log.info('session.stop.subtasksSkipped', { threadId, subtasks: live.subtasks.size })
        return
      }
      void this.stopWithSubtasks(threadId, live, 'grace')
    }, this.deps.subtaskStopGraceMs ?? SUBTASK_STOP_GRACE_MS)
    this.subtaskStopTimers.set(threadId, timer)
  }

  private clearSubtaskStop(threadId: string): void {
    const timer = this.subtaskStopTimers.get(threadId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.subtaskStopTimers.delete(threadId)
  }

  /**
   * Stops the process together with the background subagents (TODO 1153 stage 1). Subagents that have not yet
   * finished are closed with "stop" (removed from the list, with a "stop" row left in the timeline), then the
   * process is stopped (`stopThread` = close stdin and SIGTERM, then SIGKILL after the grace period). A send after
   * stopping is started by `ensureLive` via resume.
   */
  private async stopWithSubtasks(threadId: string, live: Live, reason: 'idle' | 'grace' | 'interrupt-failed'): Promise<void> {
    this.clearSubtaskStop(threadId)
    if (this.stopped || this.live.get(threadId) !== live || live.retiring) return
    const events = stoppedSubtaskEvents(live.subtasks, { threadId, sessionId: live.sessionId, ts: Date.now() })
    log.info('session.stop.subtasks', { threadId, subtasks: events.length, reason })
    for (const event of events) this.onAgentEvent(threadId, event)
    await this.stopThread(threadId)
  }

  async stopThread(threadId: string): Promise<void> {
    return this.lifecycle.stopThread(threadId)
  }

  /** Drops idle sessions and reclaims memory (12.2). */
  private sweepIdle(): void {
    this.lifecycle.sweepIdle()
  }

  // ---- Events (the body is `EventRecorder` in event-recorder.ts, TODO 578 (d)) ----

  private onAgentEvent(threadId: string, event: AiosEvent): void {
    this.recorder.onAgentEvent(threadId, event)
  }

  /** Batches sending to the renderer and saving to the DB on the same 16 ms period. */
  private record(threadId: string, event: AiosEvent): void {
    this.recorder.record(threadId, event)
  }

  // ---- Rewind (item 113, 4.5.6) ----

  /**
   * The session used to restore files. If one is running, that; otherwise **the source thread is started via
   * resume** (a checkpoint is tied to the transcript and also works in a restarted process: spike 23). The launch
   * cost is the same as an ordinary resume.
   */
  private async liveForRewind(thread: Thread): Promise<Live> {
    await this.assertUsable(thread) // TODO 1114: decide by the thread's backend
    // Plan mode (item 112) stays at the toggle's current value (aligned at merge time).
    const live = await this.lifecycle.ensureLive(thread, {
      ...this.effectiveSettings(thread),
      planMode: this.planModes.has(thread.id)
    })
    // TODO 916: a process started for a rewind will not be followed by a send, so lower it to `idle` instead of leaving it in `starting`.
    this.lifecycle.settleIdleStart(live)
    return live
  }

  /**
   * The breakdown of context usage (item 155, 4.5.1). Called each time the dialog opened by pressing the donut
   * opens (and on the refresh button). If a process is running, it queries on the spot (the model is not called,
   * spike 26), replaces the cache and returns it. If there is no process or the query fails, it returns the last
   * cache with `fresh: false` (null if never taken). **It does not start a process just for the breakdown**
   * (owner decision 2026-09-27).
   */
  async contextBreakdown(threadId: string): Promise<ContextBreakdownResult> {
    if (this.store.getThread(threadId) === null) throw new Error('thread not found')
    const session = this.live.get(threadId)?.session
    if (session?.alive === true && session.contextUsage !== undefined) {
      const usage = await session.contextUsage()
      // If the thread disappears during the wait, do not create a cache entry (do not write back after `forget` on deletion).
      if (usage !== null && this.store.getThread(threadId) !== null) {
        return { breakdown: this.contextBreakdowns.record(threadId, usage, Date.now()), fresh: true }
      }
    }
    return { breakdown: this.contextBreakdowns.get(threadId), fresh: false }
  }

  /**
   * Preview of "rewind to here" (item 113). The body is `RewindService` in `rewind.ts` (TODO 578 (f)).
   */
  async rewindPreview(threadId: string, eventId: string): Promise<RewindPreview> {
    return this.rewindService.rewindPreview(threadId, eventId)
  }

  /**
   * "Rewind to here" (item 113, 4.5.6). The body is `RewindService` in `rewind.ts` (TODO 578 (f)).
   */
  async rewind(threadId: string, eventId: string, options: RewindOptions): Promise<Thread> {
    // TODO 982: a drill is not rewound or branched (a branch would be an ordinary conversation continuing what the drill only pretended to do).
    if (this.store.drillStateOf(threadId) !== null) throw reasonError('drill-locked')
    return this.rewindService.rewind(threadId, eventId, options)
  }

  /**
   * Writes the interruption mark (TODO 521). null clears it. If it equals the copy (`interruptedCache`), the DB is
   * not touched: it is called on every body diff. If it changed, the list row is redistributed (if `emit` is false
   * the caller distributes).
   */
  private applyInterrupt(threadId: string, reason: InterruptReason | null, emit = true): void {
    // TODO 1282: the kind handed over for this `result` is used now or never (it must not leak into a later mark).
    const authKind = this.pendingAuthKinds.get(threadId) ?? null
    this.pendingAuthKinds.delete(threadId)
    if (this.stopped) return
    let current = this.interruptedCache.get(threadId)
    if (current === undefined) {
      const thread = this.store.getThread(threadId)
      if (thread === null) return
      current = thread.interrupted ?? null
      this.interruptedCache.set(threadId, current)
    }
    if (current === reason) {
      // TODO 1282: a new auth-failed `result` on a thread that still had the mark (a resend that stopped again with no content line in between).
      if (reason === 'interrupt-auth' && authKind !== null) this.reportAuthExpiry(threadId, authKind)
      return
    }
    this.interruptedCache.set(threadId, reason)
    if (!this.store.setInterrupted(threadId, reason)) return
    log.info(reason === null ? 'thread.interrupt.cleared' : 'thread.interrupt.set', {
      threadId,
      ...(reason === null ? {} : { reason })
    })
    if (emit) this.emitThread(threadId)
    // TODO 893: showing the auth-expiry badge = re-check the login state once (if it has recovered, the renderer clears the badge).
    if (reason === 'interrupt-auth') {
      void this.recheckLogin().catch((err: unknown) => log.warn('agent.login.recheckFailed', errorFields(err)))
      // TODO 1147: the diagnostics bundle (after waiting for the re-check's result) and a single retry after 30 seconds.
      this.authExpiry.noteExpired('interrupt-auth', threadId)
      this.reportAuthExpiry(threadId, authKind ?? 'login') // TODO 960 / 1282
    } else if (current === 'interrupt-auth') {
      this.authExpiries.delete(threadId)
      this.authRecovery?.cleared(threadId)
    }
    // TODO 628 (code-review): the interruption was lifted = the post-release resume reservation is not needed.
    if (reason === null) this.deps.notify?.threadResumed?.(threadId)
  }

  /**
   * Reads an unsaved `tool_result` from the canonical copy **only at display time** (4.3.1 / 12.7).
   * What it reads is the backend's transcript; it is not put in aios's DB or the index (constraint 10).
   */
  async readToolResult(
    threadId: string,
    toolUseId: string
  ): Promise<{ text: string; bytes: number; truncated: boolean } | null> {
    const thread = this.store.getThread(threadId)
    if (thread === null) return null
    const transcripts = this.adapters.get(thread.backend)?.transcripts ?? null
    if (transcripts === null) return null
    const backendSessionId =
      this.live.get(threadId)?.backendSessionId ?? this.store.latestBackendSessionId(threadId)
    const own = backendSessionId === null ? null : await transcripts.findToolResult(backendSessionId, toolUseId)
    if (own !== null) return own
    // The past part of a thread continued from a transcript (item 111) is in the original transcript (for a branch, the id differs).
    const origin = this.store.transcriptOriginOf(threadId)
    if (origin === null || origin.sessionId === backendSessionId) return null
    return transcripts.findToolResult(origin.sessionId, toolUseId)
  }

  // ---- Approval (the entry from the gateway) ----

  /**
   * The only entry from gateway to main (7.6). **The body is `GatewayRequests` in `gateway-requests.ts`**
   * (TODO 578 (e)). `sessionId` has already been identified from the token, so the caller cannot be spoofed.
   */
  async handleGatewayRequest(request: GatewayRequest): Promise<unknown> {
    return this.gatewayRequests.handle(request)
  }

  /**
   * The audit hook for a decision. Reflecting it in the timeline is done on the waiting side of
   * `handleGatewayRequest`, so this remains as the insertion point for Phase 4's `audit.log` (7.7).
   */
  private onApprovalDecided(item: ApprovalItem, result: ApprovalResult): void {
    log.info('approval.audit', {
      threadId: item.threadId,
      tool: item.toolName,
      allowed: result.allowed,
      by: result.by,
      heldMs: Date.now() - item.requestedAt
    })
  }

  listApprovals(): readonly ApprovalItem[] {
    return this.broker.list()
  }

  /**
   * The diff in the approval frame (item 97 / 7.6.4). For a pending write request, returns the before and after of
   * applying the change to the file's current contents. **The target path is read only after passing the choke
   * point (`assertAllowed`)**: a path from the model is not trusted, same as a value from the renderer (12.7). The
   * body is only returned and not saved (constraints 9 / 10).
   */
  async approvalDiff(id: string): Promise<ApprovalDiff> {
    const item = this.broker.list().find((entry) => entry.id === id)
    if (item === undefined) return { ok: false, reason: 'gone' }
    const thread = this.store.getThread(item.threadId)
    if (thread === null) return { ok: false, reason: 'gone' }
    const preview = this.adapters.get(thread.backend)?.writePreview?.(item.toolName, item.input) ?? null
    if (preview === null) return { ok: false, reason: 'not-diffable' }
    const absolute = resolveToolPath(preview.path, this.workingCwdOf(thread))
    if (absolute === null) return { ok: false, reason: 'not-allowed' }
    let path: string
    try {
      path = this.deps.fs.assertAllowed(pathToUri(absolute), false)
    } catch {
      return { ok: false, reason: 'not-allowed' }
    }
    const diff = applyWriteChange(await readCurrentContent(path), preview.change)
    return { ok: true, name: basename(path), ...diff }
  }

  decideApproval(id: string, decision: ApprovalDecision): boolean {
    if (decision.kind === 'allow-manual') {
      // "Yes, manually approve edits" of a plan approval (item 256): **before returning the permission**, put that thread in strict mode
      // (even if the CLI proceeds right after the permission and the next request comes, it is already judged under strict mode). If it comes on a request
      // that is not a plan (the renderer sent it falsely), change nothing and pass it as a one-time permission.
      const item = this.broker.list().find((entry) => entry.id === id)
      if (item !== undefined && item.plan !== undefined && item.plan !== null) {
        this.setApprovalStrict(item.threadId, true)
      } else if (item !== undefined) {
        log.warn('approval.manual.refused', { id, tool: item.toolName })
      }
    }
    if (decision.kind === 'allow-host') {
      // TODO 1029: "do not ask about this host from now on". Only the host that the Broker decided when it queued the request (`quietHosts`) is added, and
      // from the renderer only the kind comes. A request that does not match the condition (the renderer sent it falsely) falls to a one-time permission.
      const item = this.broker.list().find((entry) => entry.id === id)
      if (item !== undefined && canAllowHost(item)) {
        const added = item.quietHosts ?? []
        this.setApprovalPolicy({ sshAllowedHostsAdd: added })
        log.info('approval.sshHost.allowed', { id, threadId: item.threadId, count: added.length })
        const decided = this.broker.decide(id, decision)
        // Also resolve other pending requests for the same host (they pass if it is a staple that is not asked about even in strict mode).
        this.broker.releaseAllowedHosts((threadId) => this.store.getThread(threadId)?.approvalStrict === true)
        return decided
      } else if (item !== undefined) {
        log.warn('approval.sshHost.refused', { id, tool: item.toolName })
      }
    }
    return this.broker.decide(id, decision)
  }

  // ---- Approval rules and defaults (T12 / 4.2) ----

  listApprovalRules(): readonly ApprovalRule[] {
    return this.broker.listRules()
  }

  removeApprovalRule(id: string): boolean {
    return this.broker.removeRule(id)
  }

  /**
   * TODO 983 stage 2: "what has been allowed for this job" in editing a scheduled job; stage 4: "what this Teammate is allowed" in the Teammate
   * editor. Only the key shapes `job:<jobId>` / `role:<roleId>` are accepted: the value from the renderer is re-validated here. Rows past their expiry are not included. A "this conversation only" row gets the conversation's title.
   */
  listRoleGrants(roleKey: string): readonly RoleGrantView[] {
    if (!isJobRoleKey(roleKey) && !isTeammateRoleKey(roleKey)) return []
    return this.broker.listRoleGrants(roleKey).map((row) => ({
      id: row.id,
      toolName: row.toolName,
      kind: row.subjectKind,
      value: row.subjectKind === 'tool' ? null : row.subject,
      ...(row.access === null ? {} : { access: row.access }),
      scope: row.scope,
      expiresAt: row.expiresAt,
      threadTitle: row.scope === 'thread' && row.threadId !== null ? (this.store.getThread(row.threadId)?.title ?? null) : null,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      useCount: row.useCount
    }))
  }

  /** The table's cross. Deletes only if the id is a row of that key (no confirmation, since it narrows). */
  removeRoleGrant(roleKey: string, id: string): boolean {
    return (isJobRoleKey(roleKey) || isTeammateRoleKey(roleKey)) && this.broker.removeRoleGrant(roleKey, id)
  }

  /** TODO 1251: at startup, delete from the DB the permission rows (`job:<id>`) of jobs that do not exist. The job table is held by the scheduler, so the caller passes it. */
  sweepOrphanJobGrants(exists: (jobId: string) => boolean): void {
    // Parsing the key's shape is done only here (`isJobRoleKey`). A key that starts with `job:` but has the wrong shape is dropped from the table and swept. Keys other than job: are not touched.
    this.broker.sweepOrphanJobGrants((roleKey) => {
      if (isJobRoleKey(roleKey)) return exists(roleKey.slice('job:'.length))
      return !String(roleKey).startsWith('job:')
    })
  }

  /** When a job is deleted, delete all of that job's permission rows. */
  forgetJobGrants(jobId: string): void {
    this.broker.removeRoleGrantsOf(`job:${jobId}`)
  }

  getApprovalPolicy(): ApprovalPolicy {
    return this.broker.getPolicy()
  }

  /**
   * From the settings screen. **The renderer's value is re-validated here**: non-strings and empty strings are
   * dropped, and duplicates become one. An empty `autoAllowTools` is valid (stop everything = the behavior up to Phase 2).
   */
  setApprovalPolicy(patch: ApprovalPolicyPatch): ApprovalPolicySetResult {
    const current = this.broker.getPolicy()
    const clean = (list: readonly string[] | undefined, fallback: readonly string[]): string[] =>
      list === undefined
        ? [...fallback]
        : [...new Set(list.filter((v) => typeof v === 'string').map((v) => v.trim()).filter((v) => v !== ''))]
    const wantedWrite = applySandboxWritePatch(current.sandboxAllowWrite ?? DEFAULT_SANDBOX_ALLOW_WRITE, patch)
    const keptWrite = dropHomeWritePaths(wantedWrite, this.sandboxHomes())
    const next: ApprovalPolicy = {
      autoAllowAll: patch.autoAllowAll ?? current.autoAllowAll,
      autoAllowTools: clean(patch.autoAllowTools, current.autoAllowTools),
      bashDenyPatterns: clean(patch.bashDenyPatterns, current.bashDenyPatterns),
      // TODO 1029: destinations that are not asked about. Normalize again (the renderer's value is not trusted), and apply the diff (add / remove) to the current value:
      // so that a stale list from when the settings screen was opened does not erase hosts added in an approval frame or another window.
      sshAllowedHosts: applySshHostsPatch(current.sshAllowedHosts ?? [], patch),
      // TODO 1106: the OS sandbox's allow table. Likewise normalized again, with the diff applied to the current value. Effective from the next launch.
      sandboxAllowedDomains: applySandboxDomainsPatch(current.sandboxAllowedDomains ?? DEFAULT_SANDBOX_ALLOWED_DOMAINS, patch),
      // Item 8 of TODO 1109: drop other homes that the shared shape check cannot refuse (`/Volumes/x/me` etc.) and their parents, by comparing with the real home.
      sandboxAllowWrite: keptWrite,
      // TODO 1175: full delegation mode. Non-booleans do not come (`asPolicyPatch` drops them).
      fullDelegation: patch.fullDelegation ?? current.fullDelegation ?? false
    }
    // What was dropped is not silent but returned in the result (the settings screen shows it under the field). It is not put in the saved value (`next`).
    const sandboxWriteDropped = wantedWrite
      .filter((path) => !keptWrite.includes(path))
      .map((path): SandboxWriteDrop => ({ path, reason: 'home-or-parent' }))
    this.broker.setPolicy(next)
    this.store.writeApprovalPolicy(next)
    log.info('approval.policy', {
      autoAllowAll: next.autoAllowAll,
      autoAllowTools: next.autoAllowTools.length,
      bashDenyPatterns: next.bashDenyPatterns.length,
      sshAllowedHosts: next.sshAllowedHosts?.length ?? 0,
      sandboxAllowedDomains: next.sandboxAllowedDomains?.length ?? 0,
      sandboxAllowWrite: next.sandboxAllowWrite?.length ?? 0,
      sandboxWriteDropped: sandboxWriteDropped.length,
      fullDelegation: next.fullDelegation === true
    })
    return sandboxWriteDropped.length === 0 ? next : { ...next, sandboxWriteDropped }
  }

  // ---- Links in the body (item 254) ----

  /**
   * The base for resolving relative links in the body (used by `resolveLinkRequest` in `fs/link.ts`). The thread's
   * cwd and that cwd's auto memory directory (a place the adapter knows, only if it exists). null for an unknown
   * or deleted thread. **It does not read**: whether it can be opened is decided by the caller's choke point.
   */
  linkContext(
    threadId: string
  ): { cwd: string; memoryDirs: readonly string[]; shellDirs: () => readonly string[] } | null {
    const thread = this.store.getThread(threadId)
    if (thread === null) return null
    let cwd: string
    let home: string
    try {
      // TODO 633: relative links in an answer are resolved against the conversation's current working folder (the worktree if it moved there).
      // Auto memory stays at the original cwd's location (on the assumption that notes are not split per worktree).
      cwd = this.workingCwdOf(thread)
      home = uriToPath(thread.cwdUri)
    } catch {
      return null
    }
    const adapter = this.adapters.get(thread.backend)
    const memoryDirs = adapter?.memoryDirs?.(home) ?? []
    // TODO 816: the directories that the shell `cd`-ed to in that conversation. Read lazily, only when a relative link could not be resolved against the cwd.
    const shellDirs = (): readonly string[] =>
      adapter?.shellDirs?.(this.store.recentToolUses(threadId), cwd, this.deps.fs.homePath) ?? []
    return { cwd, memoryDirs, shellDirs }
  }

  // ---- Attachments (4.5) ----

  /** The body is `AttachmentService` in `attachments.ts` (TODO 578 (g)). */
  async resolveAttachment(threadId: string, uri: string): Promise<AttachmentResolution> {
    return this.attachmentService.resolveAttachment(threadId, uri)
  }

  /** The parent directory of a file dropped by drag and drop. The unit used when adding to the reference range. */
  parentDirUri(uri: string): string {
    return pathToUri(dirname(uriToPath(uri)))
  }

  /**
   * TODO 999: the absolute paths (deduplicated) of files the AI wrote with a write tool (the adapter's `writeToolTargetPath`,
   * constraint 6) in conversations that moved after `sinceMs`. The material for "recent files" to keep as updates by the user and the AI
   * (item 1 of the owner decision). Per conversation, it reads `perThread` `tool_use` rows from the newest side (main's synchronous SQL; the
   * caller caches for 30 seconds). Relative paths are resolved against the conversation's working folder. Only those whose `tool_use` itself is at or
   * after `sinceMs` and whose paired `tool_result` succeeded (a refused or failed write wrote nothing: wave 53 review).
   */
  recentAiWrittenPaths(sinceMs: number, maxThreads = 50, perThread = 500): readonly string[] {
    const threads = this.store
      .listThreads()
      .filter((thread) => (thread.lastEventAt ?? thread.createdAt) >= sinceMs)
      .sort((a, b) => (b.lastEventAt ?? b.createdAt) - (a.lastEventAt ?? a.createdAt))
      .slice(0, maxThreads)
    const out = new Set<string>()
    for (const thread of threads) {
      const adapter = this.adapters.get(thread.backend)
      if (adapter?.writeToolTargetPath === undefined) continue
      const cwd = this.workingCwdOf(thread)
      for (const use of this.store.recentSucceededToolUses(thread.id, sinceMs, perThread)) {
        const target = adapter.writeToolTargetPath(use.name, use.input)
        if (target === null || target.trim() === '') continue
        out.add(isAbsolute(target) ? target : resolve(cwd, target))
      }
    }
    return [...out]
  }
}

/**
 * The line the automatic title is based on (TODO 608). It skips the line where attachment marks are lined up (the
 * head line that composeText adds) and builds from the first body line. If the body is only attachments (nothing
 * remains after the mark line), the attachment's name becomes the title.
 */
function titleLineOf(titleSource: string): string | undefined {
  const lines = titleSource.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw === undefined || raw.trim() === '') continue
    const stripped = (i === 0 ? stripLeadingAttachmentMarks(raw) : raw).trim()
    if (stripped !== '') return stripped
  }
  const names = lines.length > 0 && lines[0] !== undefined ? attachmentNamesInLine(lines[0]) : []
  return names.length > 0 ? names.join(', ') : undefined
}

/**
 * Whether its direct contents are empty (T23). It checks with **`opendir` + reading one entry, not `readdir`**:
 * even if a person placed a huge directory under the root, the startup cost is not proportional to the count.
 */
async function isEmptyDir(path: string): Promise<boolean> {
  let dir
  try {
    dir = await opendir(path)
  } catch {
    // Anything unreadable is not judged empty (not swept).
    return false
  }
  try {
    return (await dir.read()) === null
  } finally {
    await dir.close()
  }
}

/**
 * Reads the current contents of the write destination for the approval frame's diff (item 97). Pass only a path that has passed the choke point.
 * `missing` if absent; `unavailable` for a directory, unreadable, or over the viewer's limit (`MAX_TEXT_BYTES`)
 * (fall back to a fragment diff).
 */
async function readCurrentContent(path: string): Promise<CurrentContent> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_TEXT_BYTES) return { kind: 'unavailable' }
    return { kind: 'text', text: await readFile(path, 'utf8') }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unavailable' }
  }
}

/**
 * The number of entries directly under a directory. 0 if absent (the scratch area may not have been created yet).
 * null = unknown if it cannot be read (EACCES / ENOTDIR / EIO etc.) (TODO 577). Throwing would make the thread undeletable.
 */
async function countEntries(path: string, threadId: string): Promise<number | null> {
  try {
    return (await readdir(path)).length
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    log.warn('thread.scratch.unreadable', { threadId, ...errorFields(err) })
    return null
  }
}

/** Stops the whole process (SIGINT). For later sends, `ensureLive` waits for the exit and then restarts it. */
function abortLive(live: Live): void {
  live.retiring = true
  live.session?.abort()
}

/** The upper limit of the retention days (about 100 years). Closed to the range where `days * 24h` fits in a safe integer. */
const MAX_RETENTION_DAYS = 36_500

/** Whether it is a safe integer with `min ≤ value ≤ max` (item 86). NaN / Infinity / fractions are false. */
function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

/**
 * Re-validates the `!` input (item 116). Keeps only the body and drops attachments, selections and model /
 * thinking specifications (it is input that is not sent to the backend, so do not carry over specifications that have no effect).
 */
function shellInputOf(input: SendInput): SendInput {
  if (shellCommandOf(input.text) === null) throw reasonError('shell-invalid')
  return { text: input.text, shell: true }
}

/**
 * Turns the accumulated `!` results into text to mix into the next message (item 116). How to wrap it is
 * backend-specific, so it is left to the adapter; for an adapter that has none, it is given in a plain,
 * language-independent form (how a terminal looks).
 */
/** The handoff text, and the source thread's last message that the branch band jumps to (TODO 961). */
interface PreparedHandoff {
  readonly handoff: HandoffText
  readonly lastQuestion: string
}

/** The number of handoff-text cache entries (the key is the thread and the kind of introduction). The band is only for the open thread, so few is enough. */
const HANDOFF_CACHE_MAX = 4
/** The upper limit of branch / handoff levels the handoff text traces back (including itself, item 1 of TODO 992). So that it does not loop forever on a cyclic row or an overly deep chain. */
const HANDOFF_LINEAGE_MAX = 8

/** One level of ancestor that a handoff traces back (item 1 of TODO 992). `bound` is the read limit up to the branch point (`ThreadStore.inheritedBound`). */
interface HandoffLink {
  readonly parent: Thread
  readonly mode: 'before' | 'through'
  readonly cutId: string
  readonly bound: { readonly before: number | undefined; readonly oldestSeq: number } | null
}

function shellContextOf(adapter: AgentAdapter, runs: readonly ShellRunPayload[]): string {
  if (adapter.formatShellContext !== undefined) return adapter.formatShellContext(runs)
  return runs
    .map((run) =>
      [`$ ${run.command}`, run.stdout, run.stderr, `(${run.status}${run.exitCode === null ? '' : ` ${run.exitCode}`})`]
        .filter((part) => part !== '')
        .join('\n')
    )
    .join('\n\n')
}


