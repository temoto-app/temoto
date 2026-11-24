/**
 * Types of threads and the approval inbox (ARCHITECTURE.md 4.2 / 4.3 / 4.3.1 / 5).
 *
 * Only the shapes defined here are handed to the renderer. Paths are not passed; they are expressed as URIs
 * (IMPLEMENTATION_BRIEF chapter 7).
 */
import type { TriggerOrigin } from './trigger.js'
import type { DrillState } from './drill.js'
import type {
  AgentDegradation,
  AiosEvent,
  JsonValue,
  ModelChoice,
  SettingSource,
  SubtaskStatus,
  SubtaskUsage,
  ThinkingLevel,
  TodoItem
} from './agent.js'
import type { DiffPayload, ViewerSelectionRange } from './plugin.js'
import type { BackendCapabilities } from './agent.js'
import type { ReasonCode } from './reason.js'
import type { SshHostsPatch } from './ssh-hosts.js'
import { DEFAULT_SANDBOX_ALLOWED_DOMAINS, DEFAULT_SANDBOX_ALLOW_WRITE, type SandboxListsPatch } from './os-sandbox.js'
import type { SettingValueKey } from './settings.js'

/** Per-thread policy for saving the conversation log (4.3.1). */
export type ThreadRetention =
  /** Not saved (memory only). For confidential work. The timeline disappears on restart. */
  | 'none'
  /** Deleted after N days. Used together with `retentionDays`. */
  | 'days'
  /** Indefinite. The default. */
  | 'forever'

export interface Thread {
  readonly id: string
  /**
   * The title. **An empty string (`UNTITLED_THREAD_TITLE`) is a provisional title meaning "no name yet"**, and the renderer replaces it at display time with
   * the dictionary's `thread.untitled` (TODO 66). main does not know the language, so the default title is not
   * written to the DB as a string.
   */
  readonly title: string
  /** The working directory. One per thread (4.1). */
  readonly cwdUri: string
  /**
   * **Only the display name** of the working directory (T18 / 4.3). `hoge` for `~/git/hoge`, `~` for the home folder
   * itself, and an empty string for the scratch area (T19) or an old row with an empty cwd (TODO 62: the scratch-area label was retired).
   * It is derived in exactly one place, main's `threadCwdName`. **The full path is not passed (not even in a tooltip).**
   */
  readonly cwdName: string
  /**
   * Directories whose reference is always allowed (4.4).
   * **Putting a directory here is equivalent to "letting the AI read the full text without approval"** (spike 9d).
   */
  readonly allowedDirUris: readonly string[]
  readonly retention: ThreadRetention
  readonly retentionDays: number | null
  /** Set when a `result` arrives, and cleared when the thread is opened (4.3). */
  readonly unread: boolean
  /**
   * The origin of settings recorded on the row (`threads.setting_sources`). **Not used for launching** (item 109 /
   * 4.6.4): aios does not specify an origin, and the CLI reads `user` / `project` / `local` just like the stock CLI.
   * Old rows keep `['project']`, but those threads launch the same way.
   */
  readonly settingSources: readonly SettingSource[]
  /** Which backend runs it (4.6.1). Fixed per thread and not changed midway. */
  readonly backend: string
  /** The model passed at launch. null means the backend default (T5). The id is opaque. */
  readonly modelId: string | null
  /** The depth of thinking. null means the backend default (T5). */
  readonly thinking: ThinkingLevel | null
  /**
   * Strict mode (T12 / 4.2). If true, it looks at neither the default allow list nor the stop patterns, and
   * puts **all** permission requests that arrive into the inbox. The default is false.
   */
  readonly approvalStrict: boolean
  /**
   * The OS sandbox (TODO 1106, 4.2.4). If true, the backend is started with the sandbox enabled (shell tool writes go only to the cwd and
   * the places in the allow table, and network access only to the destinations in the allow table). An unattended thread (a scheduled job) is true by default when created, and an interactive thread is false.
   * Toggled with the thread's ⋯, and restarted at the next send. Omitted means false (rows before migration 34, test values).
   */
  readonly osSandbox?: boolean
  /**
   * Auto-pick of the recommended answer for questions (TODO 1222, 4.2.2). If true, for a single-choice question in this conversation whose first option is marked "(Recommended)", the recommendation is picked after a few seconds of countdown
   * (touching it aborts). **Per conversation, default OFF** (there is no global setting). Not carried over by branching, continuing from a transcript, or duplication.
   * Omitted means false. Toggled with the switch next to the Composer's approval toggle.
   */
  readonly autoPickRecommended?: boolean
  /**
   * The file last viewed in the ViewerPane (item 63). It is reopened when the thread is selected again.
   * null means "nothing is open" (including the state closed with the close button, item 70). Only `file:` URIs.
   */
  readonly lastViewerUri: string | null
  /** The in-file search term at that time (item 56). Always null if `lastViewerUri` is null. */
  readonly lastViewerHighlight: string | null
  /**
   * For a thread created by branching with a rewind, its origin (item 113, 4.5.6). The original thread is untouched, and
   * this thread's timeline does **not copy** messages before the branch (the heading band jumps to the original messages).
   * null for an ordinarily created thread.
   */
  readonly forkedFrom: ForkOrigin | null
  /**
   * For a thread continued from a conversation started in the terminal / VS Code (the backend's transcript), its marker
   * (item 111, 4.5.9). The past part reads the transcript each time and shows it at the head of the timeline; it is not
   * imported into aios's DB. If `fork` is true, it branched as a separate session (nothing is appended to the original transcript).
   * null for an ordinarily created thread. The transcript's location and session_id are not passed to the renderer.
   */
  readonly transcriptOrigin: TranscriptOrigin | null
  /**
   * For a thread started by a scheduled run (TODO 323) job, that job's id. Shows ⏰ on the list row.
   * Ordinary threads have no field. It stays even if the job is deleted (look up which job it was in the settings screen's list).
   */
  readonly scheduledJobId?: string
  /**
   * The role (shown as a "Teammate") this conversation belongs to (TODO 972, ARCHITECTURE 4.3.4). The thread list folds the role's
   * conversations under its heading. Conversations without a role have no field (listed as before). Cleared when the role is deleted.
   */
  readonly roleId?: string
  /**
   * TODO 982: a drill conversation (a dry run of a Teammate; outward and irreversible operations are stopped and recorded). Only drill
   * conversations have the field. main keeps the mark in the DB (`threads.drill`) and never clears it.
   */
  readonly drill?: DrillState
  /**
   * For a thread started by a trigger (TODO 1216, 6.2.6), its origin (extension, trigger, URL of the original event). A mark on the list row, and the
   * original event can be opened from the heading. Ordinary threads have no field.
   */
  readonly triggerOrigin?: TriggerOrigin
  /**
   * The mark that an answer stopped midway, and its kind (TODO 521, wave 26 bundle B, migration 21). Read by the "!" on the list row and
   * the resume button at the end of the timeline. **It stays until the next turn starts normally (the parent's body, tools or usage arrive,
   * or a successful `result`)** - merely opening the thread does not clear it (owner decision 2026-10-08).
   * Only main's SessionManager sets and clears it. Threads that have not stopped have no field.
   */
  readonly interrupted?: InterruptReason
  /**
   * If the conversation moved to a worktree midway, that worktree (TODO 633 stage 1, migration 23). Files, the BottomBar's
   * git summary and the resume location look at this (`workingCwdUri`). **The list grouping (`cwdUri`) stays the original repository**, and
   * the row shows a `worktreeName` badge. Threads that have not moved have no field.
   */
  readonly worktreeUri?: string
  /** The trailing name of `worktreeUri` (shown on the badge). Only when `worktreeUri` exists. */
  readonly worktreeName?: string
  /**
   * When restored from deletion, the cleaned-up worktree could not be recreated (a fix from TODO 633's code-review, migration 24).
   * The trailing name of that worktree. The conversation is back at the original cwd. A mark is shown on the list row. No field if none.
   */
  readonly worktreeLostName?: string
  /**
   * For a turn split off into a worktree, the time a write outside the worktree (to the main working copy) was last seen (TODO 700, migration 23).
   * A mark is shown on the list row. Threads where none was seen have no field.
   */
  readonly outsideWriteAt?: number
  /**
   * A conversation whose entry in the working-folder history is deferred until the first send (TODO 1118, a first-time folder was opened with `aios://new`).
   * The "first-time folder" band above the conversation's Composer is shown only for conversations with this mark. Cleared on the first send. No field if none.
   */
  readonly cwdHistoryDeferred?: true
  readonly createdAt: number
  /** The time the row's attributes (title, unread, strict mode, ...) were last changed. **Not used for list ordering** (item 83). */
  readonly updatedAt: number
  /** The time of the last event (send, end of a response). The key for list ordering (`threadRecency`). */
  readonly lastEventAt: number | null
  /**
   * The rainbow color of the working directory (item 108, ARCHITECTURE.md 4.3 "color of the working directory").
   * **A value main fixed by looking up the table in `app_settings` (numbers handed out in order of appearance, persisted per cwd)**.
   * Unaffiliated (scratch area) and old rows without a cwd (`cwdName === ''`) are always null.
   * The renderer only turns the number into `var(--rainbow-N)`, and has neither a hash nor a judgment.
   */
  readonly rainbow: number | null
}

/**
 * The conversation's working folder (TODO 633 stage 1). The worktree if it moved to one, otherwise `cwdUri`.
 * Used by open-in-Files, the BottomBar's git summary and open-in-external-editor. The list grouping and the search's "this working folder"
 * (a worktree is outside the index) stay `cwdUri`.
 */
export function workingCwdUri(thread: Pick<Thread, 'cwdUri' | 'worktreeUri'>): string {
  return thread.worktreeUri ?? thread.cwdUri
}

/**
 * Kinds of interruption (TODO 521). The values are the reason codes themselves (`interrupt-*` in `shared/reason.ts`), and the renderer turns them into wording with
 * the dictionary's `reason.<code>` (main does not know the language, 7.4.4).
 */
export const INTERRUPT_REASONS = [
  'interrupt-network',
  'interrupt-server',
  'interrupt-limit',
  'interrupt-exit',
  'interrupt-error',
  'interrupt-auth'
] as const satisfies readonly ReasonCode[]

export type InterruptReason = (typeof INTERRUPT_REASONS)[number]

export function isInterruptReason(value: unknown): value is InterruptReason {
  return typeof value === 'string' && (INTERRUPT_REASONS as readonly string[]).includes(value)
}

/** Number of rainbow colors (item 50 / 108). `--rainbow-0` to `--rainbow-{RAINBOW_COLORS - 1}` of `styles.css`. */
export const RAINBOW_COLORS = 16

/**
 * The origin of a branch (item 113). Only the part shown to the renderer - the backend's session id and message identifiers are
 * only in main's row (`threads.fork_origin`), and are used for the first launch (`--resume` + branching from that point).
 */
export interface ForkOrigin {
  /** The original thread. It may have been deleted (if it is not in the list, the renderer shows it without a title). */
  readonly threadId: string
  /** The user's message in the original thread that was rewound to (the id of `user_text`). Everything before it is carried over to the branch. */
  readonly eventId: string
  /** Whether the files were also rewound to the checkpoint just before that message. */
  readonly files: boolean
  /**
   * A thread made with "lighten and continue in a new conversation" (TODO 961). It does not carry over the original conversation (it starts from empty); the original thread's
   * messages and the answer text are attached to the first send. `eventId` is the original thread's last user message. A rewind branch has no field.
   */
  readonly handoff?: true
}

/** The mark of a thread continued from a transcript (item 111). Only the part shown to the renderer. */
export interface TranscriptOrigin {
  /** Branched as a separate session (equivalent to `--fork-session`). If false, it continues with the same session_id. */
  readonly fork: boolean
  /**
   * The model of the transcript's last response matched none of the choices, so it was created with the settings default (item 140).
   * The band shows "continue with the default model". No field when it matched or when the transcript has no model.
   */
  readonly modelFallback?: true
}

/**
 * The head of the ids of past events read from a transcript (item 111). They are not `thread_events` rows, so
 * the renderer recognizes them by this head and does not offer operations that presuppose a row, such as "rewind to here".
 */
export const TRANSCRIPT_EVENT_ID_PREFIX = 'transcript:'

/**
 * One backend transcript = one conversation started in the terminal / VS Code (item 111, 4.5.9).
 * Used by the "from a CLI conversation" list in the create dialog, and the "continue this conversation" on a transcript hit in conversation search.
 * The transcript's location is not passed (`uri` is the same `transcript://<opaque id>` as the index).
 */
export interface TranscriptSession {
  /** The backend's session id. Passed to `CreateThreadInput.transcript.sessionId`. */
  readonly sessionId: string
  /** URI of the transcript file (`transcript://…`). It matches the head of a search hit's `uri`. */
  readonly uri: string
  /** The working folder (the `cwd` of each transcript line). */
  readonly cwdUri: string
  /**
   * A comparison key made by folding the real path of `cwdUri` (symlinks resolved) by case and normalization (item 239).
   * An exact match on `cwdUri` misses when a folder was chosen through a symlinked spelling, so the create
   * dialog's "conversations of this folder" is matched with this one. An empty string when `cwdUri === ''`.
   */
  readonly cwdMatchKey: string
  /** The display name derived the same way as `Thread.cwdName`. */
  readonly cwdName: string
  /** The title the backend gave (null if none). */
  readonly title: string | null
  /** The first user message (only its beginning). Empty string if none. */
  readonly firstPrompt: string
  /** Last update of the transcript (ms). If within a few minutes, it says "may be open elsewhere". */
  readonly mtimeMs: number
  /** Whether it can be continued (the working folder exists and does not hit the exclusion rules). */
  readonly usable: boolean
  /** The reason code for usable=false, or the raw text of an exception from the choke point (`describeReason`). */
  readonly reason: string | null
  /** If an aios thread already owns this session_id, that thread (it does not appear in the list). */
  readonly threadId: string | null
}

/**
 * A preview for "rewind to here" (item 113, 4.5.6). The backend's `dry_run` result reshaped for the renderer.
 * `files` are the `file://` URIs of files that change when rewound (values main only folded without passing the choke point - display only).
 */
export interface RewindPreview {
  /** Whether the files can be rewound. If false, `reason` holds a reason code (such as `rewind-no-checkpoint`). */
  readonly canRewind: boolean
  readonly files: readonly string[]
  readonly insertions: number
  readonly deletions: number
  readonly reason: string | null
}

/** The specification for "rewind to here" (item 113). If `files` is true, the files are rewound too (called after the user accepts the preview). */
export interface RewindOptions {
  readonly files: boolean
}

/**
 * The key for list ordering (item 83). main's list (`ORDER BY COALESCE(last_event_at, created_at) DESC`)
 * and the renderer's replacement (`applyThreadChange`) sort by the same value.
 */
export function threadRecency(thread: Pick<Thread, 'lastEventAt' | 'createdAt'>): number {
  return thread.lastEventAt ?? thread.createdAt
}

/** The state of a session (the backend's process). */
export type SessionState =
  /** No process. It starts on the next send (spike 10: it starts at the first send) */
  | 'idle'
  /** Starting (about 1.3 seconds including the gateway handshake) */
  | 'starting'
  /** Generating a response */
  | 'running'
  /** Stopped awaiting approval. It can wait indefinitely, so the dwell time is shown (4.2) */
  | 'awaiting-approval'
  | 'stopping'
  | 'error'

/** The runtime state of a thread. It is not kept in the DB but in main's memory. */
export interface ThreadRuntime {
  readonly threadId: string
  readonly state: SessionState
  /** The backend's session ID. Used to link `--resume`. */
  readonly backendSessionId: string | null
  /** Whether a process is alive. Used to judge the number running in parallel. */
  readonly live: boolean
  readonly pendingApprovals: number
  /** The cumulative number of turns aios counted (`num_turns` is not cumulative - spike 1). */
  readonly turns: number
  /**
   * The cumulative estimated token cost (constraint 4: not an actual charge). **Decided not to show it in the UI
   * in item 165** (anyone who wants to see it runs the CLI's own `/cost`). It is still delivered to the renderer side
   * for record-keeping only - do not remove it. To bring the display back, it is enough to
   * add a reader to `ThreadPane.tsx`.
   */
  readonly costUsd: number
  /**
   * Reservations (item 94 / 4.5.4): input sent during a response. **It has not been passed to the backend yet**, so
   * it is not in the timeline. Each time the current turn ends with a `result`, one is sent from the front.
   * The order is the sending order (ones inserted by an interrupt come first). The body is only the beginning (for the chip).
   */
  readonly reservations: readonly Reservation[]
  /**
   * The current context usage (item 60 / 4.5.2). It is **the last `turn_usage` that arrived**, and
   * is not accumulated across turns. null if there has been no response yet.
   */
  readonly contextUsage: ContextUsage | null
  /**
   * Subagents running in the background and not finished yet (item 93 / 4.6.3). If not empty, the process is not evicted
   * even when `state` is `idle`. Tool executions (shells, etc.) are not included.
   * In start order. The list above ThreadPane's Composer draws this (4.6.3 "how to show").
   */
  readonly subtasks: readonly RunningSubtask[]
  /**
   * The number of external processes running in the background (shells the AI sent to the background; long commands that went to the background through `run_in_background` or a timeout)
   * (TODO 1196). Even when the parent turn has ended and `state` is `idle`, if this is 1 or more,
   * the list spinner keeps spinning (`busyOf`). Only those that have not passed the eviction time limit since start
   * (`session.backgroundShellEvictTimeoutMs`) are counted - the same set as the eviction judgment (`isEvictable`), so
   * endless work such as a watcher or a dev server does not make it spin forever. **main's memory only**. The field is omitted when 0.
   * Always omitted for a backend that does not report background work (it spins only during the turn, as before).
   */
  readonly backgroundShells?: number
  /**
   * The latest to-do list of the parent's model (item 118 / 4.6.5). Pinned above the Composer.
   * The thread's last to-do list rewrite (`todos` of `tool_use`); null if there is none after the conversation reset
   * (`conversation_reset`). main restores it from the DB only the first time, so
   * it shows even if it exists only in a page before "read more".
   */
  readonly todos: TodoList | null
  /**
   * When Model / Thinking is changed, whether to kill the running process and start it again (item 95 / 4.5.1).
   * Meaningless if `live` is false (the next launch just starts with the new specification).
   */
  readonly switchRestart: SwitchRestart
  /**
   * The Plan mode toggle (item 112 / 4.2.3). **Held by main** (memory only, not kept across restarts).
   * If true, the next turn runs in plan mode. When the plan is accepted with "proceed with this plan", main resets it to false.
   * Omitted means false.
   */
  readonly planMode?: boolean
  /**
   * The number of shell results run with `!` that have not yet been mixed into the next message (item 116 / 4.5.7).
   * **main's memory only** (the same as reservations - they disappear when the app quits).
   */
  readonly pendingShell: number
  /**
   * Progress of the running parent tool calls (item 259). One per call: the last report of `tool_progress`.
   * **main's memory only** (reports are not saved). Cleared by the result (`tool_result`), the end of the turn, or the end of the process.
   * The field is omitted when empty.
   */
  readonly toolProgress?: readonly ToolProgress[]
  /**
   * While an API call is being retried, its latest notice (item 277). **main's memory only**.
   * Cleared when the next body, tool, result or error arrives. The field is omitted when none.
   */
  readonly apiRetry?: ApiRetry
  /**
   * The number of connecting (pending) MCP connectors while waiting for their connection before the first message (TODO 869 plan C).
   * **main's memory only**. When the wait ends (the first `session_started` arrives), the field is omitted.
   */
  readonly mcpPending?: number
  /**
   * A table that looks up a subagent's model display name by the id of the parent call that started it (TODO 403). Both running subagents
   * (the same value as `subtasks[].model`) and ones that finished during this app run. Used by the timeline chunk and the finished-subagent
   * row. **main's memory only** (not saved - after a restart only the duration is shown). The field is omitted when empty.
   */
  readonly subagentModels?: Readonly<Record<string, string>>
  /**
   * A table that looks up the worktree of a worktree-running subagent, with **its existence confirmed**, by the id of the parent call that started it (TODO 633 stage 2).
   * The material for the "⎇ branch" of the subagent row, chunk and finished-subagent row. **main's memory only** (not saved). The field is omitted when empty.
   */
  readonly subagentWorktrees?: Readonly<Record<string, SubtaskWorktree>>
}

/**
 * A subagent's worktree (TODO 633 stage 2, a guess: no PR is made). Created only when git knows that worktree and the directory
 * exists. `committed` means the subagent's branch has a commit that the main HEAD lacks (a mark only).
 */
export interface SubtaskWorktree {
  readonly branch: string
  /** Where to open it in Files. */
  readonly uri: string
  readonly committed: boolean
}

export interface ApiRetry {
  readonly attempt: number
  readonly maxRetries: number
  readonly retryDelayMs: number
  readonly errorStatus: number | null
  /** The time the notice was received (main's clock). */
  readonly at: number
}

/** One running tool call's progress (item 259). The renderer adds the time since `at` to advance the seconds. */
export interface ToolProgress {
  /** The `toolUseId` of the timeline's tool row. */
  readonly toolUseId: string
  readonly toolName: string
  /** The elapsed seconds reported. */
  readonly elapsedSeconds: number
  /** The time the report was received (main's clock, the event's `ts`). */
  readonly at: number
}

/** The to-do list (item 118). The whole list arrives with every rewrite, so only the last one is kept. */
export interface TodoList {
  /** The id of the tool call that rewrote it. The key for showing it again when a new list arrives after it was closed. */
  readonly toolUseId: string
  readonly items: readonly TodoItem[]
  /** The time of the rewrite (the event's `ts`). */
  readonly at: number
}

/**
 * One running subagent (how item 93 is shown, 4.6.3). It exists in **main's memory only**, and is
 * created by `subtask_started`, updated by `subtask_progress` and removed by `subtask_finished`.
 * The progress (`subtask_progress`) is not saved, so after a restart or in another window the same value can be fetched from here.
 */
export interface RunningSubtask {
  readonly taskId: string
  /** The parent tool call that started the work. */
  readonly toolUseId: string | null
  /** A short description the parent's model attached. */
  readonly description: string
  /** The kind of subagent (an opaque value). */
  readonly subagentType: string | null
  /** The last reported status. Even when a terminal status arrives, it stays until `subtask_finished`. */
  readonly status: SubtaskStatus
  /** The time `subtask_started` was received (main's clock). */
  readonly startedAt: number
  /** The last reported usage. null if no progress has arrived yet. */
  readonly usage: SubtaskUsage | null
  /** The time `usage` was received (main's clock). Used to advance the elapsed time from `durationMs`. */
  readonly usageAt: number | null
  /** The name of the tool the subagent used last (an opaque value). */
  readonly lastToolName: string | null
  /** A short phrase on what the subagent is doing now (the description of the progress notice, spike 19). null if it has not arrived yet. */
  readonly activity: string | null
  /**
   * The display name of the subagent's model (`Sonnet 5`, TODO 403). The actual model of the subagent's first message -> until then the model the parent's call
   * specified -> null if neither. The conversion is done by the Adapter (constraint 6). **Not saved** (main's memory only).
   */
  readonly model: string | null
}

/**
 * How to switch Model / Thinking of a running process (item 95).
 * - `always`: kill it on every change and start it again by resuming (the backend version does not support it)
 * - `thinking-on`: restart only when thinking is restored from "none" (a process started with "none")
 * - `never`: do not restart
 */
export type SwitchRestart = 'always' | 'thinking-on' | 'never'

/**
 * One reservation (item 94 / 4.5.4). It exists in **main's memory only** and disappears when the app quits
 * (not kept in the DB - owner decision). The attachment contents (base64) are not included: the one-item delivery of the list is sent on
 * every `turn_usage`, so this stays light. To put it back into the input box (✎),
 * the whole is taken out with `threads.takeReservation`.
 */
export interface Reservation {
  readonly id: string
  /** The beginning of the body (whitespace collapsed, up to `RESERVATION_PREVIEW_CHARS` characters). */
  readonly preview: string
  /** Number of attachments. */
  readonly attachments: number
  /** One put in by an interrupt (⌘Enter). It waits for the previous turn to be aborted and is sent before the reservations. */
  readonly interrupt: boolean
  readonly createdAt: number
}

/** Length of `Reservation.preview`. */
export const RESERVATION_PREVIEW_CHARS = 120

/**
 * The result of a send (item 94). `sent` was handed to the backend on the spot, and `queued` was put into the reservations
 * (while a response is in progress or reservations remain). In either case the renderer may empty the input box.
 */
export type SendOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'queued'; readonly reservationId: string }

/**
 * One point of context usage (item 60). The 4 categories of `ResultUsage` with a denominator (the model's
 * context window limit) attached. main fills the denominator by looking up a table by the real model name, and
 * overwrites it if the backend reports a limit (`windowSource`).
 * For a model not in the table, `contextWindow` is null and the renderer shows no %.
 */
export interface ContextUsage {
  readonly model: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
  readonly contextWindow: number | null
  readonly windowSource: 'table' | 'reported' | null
  readonly at: number
}

export interface ThreadSummary {
  readonly thread: Thread
  readonly runtime: ThreadRuntime
  /** A one-line preview of the latest message (already redacted). */
  readonly preview: string | null
}

/**
 * One choice of a multiple-choice question (T31 / 4.2.2). `description` is a supplement and may be an empty string.
 */
export interface ApprovalQuestionOption {
  readonly label: string
  readonly description: string
  /**
   * Whether the choice has the "(Recommended)" badge (TODO 1194). main normalizes it from the badge's text and sets it
   * (the renderer does not judge strings). The renderer shows a small "recommended" badge next to the choice. Whether it is a target of auto-pick is
   * held separately by `ApprovalItem.autoPick`. Omitted means false.
   */
  readonly recommended?: boolean
}

/**
 * One question when an approval request asks for an "answer" (T31 / 4.2.2).
 *
 * **Backend-specific tool names are not shown to the renderer.** main reads the arguments and
 * reshapes them into this form, and if `ApprovalItem.questions` is not null it is drawn as a question.
 * `question` is also the **key** when returning the answer, so it is not duplicated within the same request.
 */
export interface ApprovalQuestion {
  readonly question: string
  /** A short badge for the heading. May be an empty string. */
  readonly header: string
  /** Whether multiple choices are allowed. */
  readonly multiSelect: boolean
  readonly options: readonly ApprovalQuestionOption[]
}

/** One item of the approval inbox (4.2). Shown at the very top, across all sessions. */
export interface ApprovalItem {
  readonly id: string
  readonly threadId: string
  readonly threadTitle: string
  readonly toolName: string
  /** The tool's main arguments on one line. */
  readonly summary: string
  /** For the expanded view. Huge values are already truncated. */
  readonly input: JsonValue
  readonly requestedAt: number
  /**
   * **Whether the request asks for an answer** (T31 / 4.2.2). If null, it is the usual
   * "allow / deny". If not null, the choices are shown and the answer is returned (`answer` of
   * `ApprovalDecision`). A request that could not be read as a question falls to null and stays in the generic display.
   */
  readonly questions: readonly ApprovalQuestion[] | null
  /**
   * **The wait for auto-picking the recommendation** (TODO 1194). main sets it (`recommendedPick`) only when the setting `approval.autoPickRecommended` is ON and the question is
   * "one single-choice question whose first option is recommended". The renderer shows a countdown of a few seconds; touching it aborts, and if untouched it returns with `auto: true`
   * added to `answer`. main re-checks the same condition in `decide`. Omitted means no auto-pick.
   */
  readonly autoPick?: { readonly label: string; readonly seconds: number } | null
  /**
   * For a tool call by a subagent, that subagent (item 93, spike 19). null if the request is the parent's own.
   * The approval request itself has no field pointing at the subagent; it is looked up from the work record by linking the request's `tool_use_id` to the parent's `Agent` call
   * through the subagent's message row (a `tool_use` with `parentToolUseId`).
   */
  readonly subtask: ApprovalSubtask | null
  /**
   * **Whether this presents a plan** (item 112 / 4.2.3). If not null, it is the plan's body (Markdown), and the renderer shows
   * "proceed with this plan" / "revise". It does not pass through even with the default of auto-allowing everything, or with rules.
   * Omitted / null is an ordinary request.
   */
  readonly plan?: string | null
  /**
   * Whether it is a write for which a before / after diff can be shown (item 97 approval-frame diff, 7.6.4). If true, a "view diff" is placed
   * on the row, and `approvals.diff(id)` has main build the before and after. Omitted means false.
   */
  readonly diffable?: boolean
  /**
   * **Whether this is an outbound operation** (TODO 959, 4.2.1 "outbound operations"). If not null, it is a request that does not pass through even with the default of auto-allowing everything
   * or with rules, such as email, a post or `git push`; the renderer shows the destination, subject and body (or the whole command)
   * and does not show "Always allow". Omitted / null is an ordinary request.
   */
  readonly outbound?: OutboundDetail | null
  /**
   * **Why it was queued** (TODO 994). The reason decided by the Broker when queueing; the renderer shows it in one line in the approval frame
   * (such as "this thread is in strict mode (release with ⋯)"). Omitted / null shows no reason (old shapes, test setups).
   */
  readonly reason?: ApprovalQueueReason | null
  /**
   * **Hosts that would pass if added to the connection targets that are not asked about** (TODO 1029). The Broker sets it when queueing if the command consists only of standard commands that are not asked about
   * (including `ssh` / `scp` / `sftp` / `rsync`) and the only thing missing is the host among "connection targets not asked about" (`host` / `user@host`,
   * normalized). The renderer shows "do not ask about this host from now on" at the end of the frame, and when chosen, main adds this value to the list
   * (the renderer's value is not used). Omitted / empty is not shown.
   */
  readonly quietHosts?: readonly string[] | null
  /**
   * **Allow this role from now on too** (TODO 983 stage 1, ARCHITECTURE 4.2.5). Set by main for a request in a conversation that has a role (in stages 1-3, a conversation started by a scheduled job)
   * when the queueing reason is strict, outside the default, or other. **The values were decided by main when it queued the request**, and the renderer returns only the expiry
   * (`scope` of `allow-role`). A display-only shape (the matching hash stays inside main). Omitted / null is not shown.
   */
  readonly roleGrant?: RoleGrantOffer | null
  /**
   * **Do not ask in this conversation** (TODO 983 stage 3, 2 of 1005, ARCHITECTURE 4.2.5). For a request in a strict-mode conversation with no role, set by main when it
   * queues the request (the values were decided by main. The renderer only returns `allow-thread`). Memory only, this conversation only. Omitted / null is not shown.
   */
  readonly threadGrant?: ThreadGrantOffer | null
}

/** Kinds of row in a role's allowances (TODO 983, 3. of 4.2.5). */
export type RoleGrantSubjectKind = 'command-prefix' | 'command-exact' | 'path-prefix' | 'host' | 'tool'

/** Expiry of a role's allowance (TODO 983, 6. of 4.2.5). Forever / today only (until 0:00 of the next day in local time) / this conversation only. */
export type RoleGrantScope = 'forever' | 'today' | 'thread'

export const ROLE_GRANT_SCOPES: readonly RoleGrantScope[] = ['forever', 'today', 'thread']

export function isRoleGrantScope(value: unknown): value is RoleGrantScope {
  return typeof value === 'string' && (ROLE_GRANT_SCOPES as readonly string[]).includes(value)
}

/**
 * One row of the settings table (TODO 983 stage 2, `approvals.roleGrants`). The "what was allowed for this job" in a scheduled job's editor. A display-only shape that
 * holds no matching hash. Rows past their expiry are swept by main before returning, so they are not included.
 */
export interface RoleGrantView {
  readonly id: string
  readonly toolName: string
  readonly kind: RoleGrantSubjectKind
  /** The displayed value (the head of a command, the whole command (after masking), a directory, a host). null for `tool` (the tool name only). */
  readonly value: string | null
  /** Only for `path-prefix`. */
  readonly access?: 'read' | 'write'
  readonly scope: RoleGrantScope
  /** The expiry for `today` (epoch ms). */
  readonly expiresAt: number | null
  /** The conversation's title for `thread` (null if the conversation is not found). */
  readonly threadTitle: string | null
  readonly createdAt: number
  readonly lastUsedAt: number | null
  readonly useCount: number
}

/** The contents of "allow this role from now on" shown in the approval frame (TODO 983). Values are the display after redaction only. */
export interface RoleGrantOffer {
  /** The role's display name: the Teammate's name, or the job name for a job that has no Teammate. */
  readonly roleName: string
  /**
   * TODO 983 stage 4: whose row a press adds - a Teammate's (`role:<id>`, "Always allow for this Teammate") or a job's (`job:<id>`).
   * Display only; main decided the key when queueing. Omitted means a job (stages 1-3).
   */
  readonly roleKind?: 'job' | 'teammate'
  /** Rows added by a single press (several if the Bash command has several separators). */
  readonly subjects: readonly {
    readonly kind: RoleGrantSubjectKind
    /** The displayed value (the head of a command, the whole command (after masking), a directory, a host, a tool name). */
    readonly value: string
    /** Only for `path-prefix`. */
    readonly access?: 'read' | 'write'
  }[]
}

/** The display of the "do not ask in this conversation" proposal (TODO 983 stage 3). The same shape as `RoleGrantOffer` without the role name. */
export interface ThreadGrantOffer {
  readonly subjects: RoleGrantOffer['subjects']
}

/**
 * The subject of an allowance (TODO 983, 3. of 4.2.5). A **neutral shape** that the Adapter's `grantSubjectOf` builds from a tool call - the meaning of tool names
 * is backend-specific (constraint 6), so the Broker, the table and the renderer see only this shape. Used inside main only.
 *
 * - `command`: a shell tool. The whole command (the Broker matches each separator part).
 * - `path`: a read / write tool. `path` is an absolute path by realpath (for a nonexistent file, the parent's realpath + the name), and `directory` is whether it is a directory.
 * - `host`: a web fetch. A lowercase host.
 * - `tool`: anything else. Matched by the tool name alone.
 */
export type GrantSubject =
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'path'; readonly access: 'read' | 'write'; readonly path: string; readonly directory: boolean }
  | { readonly kind: 'host'; readonly host: string }
  | { readonly kind: 'tool' }

/**
 * Whether this is a request for which "allow this role from now on" (TODO 983, `allow-role`) may be offered. main set `roleGrant`, and the queueing reason is
 * strict, outside the default, or other. It is not offered on the frames for a question, plan, side effect, outbound operation, persistence, secret, stop pattern or unreadable command
 * (the stage-0 line cannot be lifted by the table). main (the Broker) accepts it with the same judgment.
 */
export function canAllowForRole(item: ApprovalItem): boolean {
  return (item.roleGrant ?? null) !== null && (item.roleGrant?.subjects.length ?? 0) > 0 && roleGrantEligible(item)
}

/**
 * The part of `canAllowForRole` that looks only at the kind of queueing reason, outbound operation, plan and question (wave 89 code-review). The same judgment is used before main builds the candidate
 * (before setting `roleGrant`) and when re-examining queued requests (`releaseRoleGrants`).
 */
export function roleGrantEligible(item: Pick<ApprovalItem, 'reason' | 'outbound' | 'plan' | 'questions'>): boolean {
  const kind = item.reason?.kind
  return (
    (kind === 'strict' || kind === 'not-default' || kind === 'unknown') &&
    (item.outbound ?? null) === null &&
    (item.plan ?? null) === null &&
    item.questions === null
  )
}

/**
 * Whether this is a request for which "do not ask about this host from now on" (TODO 1029, `allow-host`) may be offered. Only a `Bash` for which the Broker set `quietHosts`.
 * main (manager) accepts it with the same judgment.
 */
export function canAllowHost(item: ApprovalItem): boolean {
  return (
    item.toolName === 'Bash' &&
    (item.quietHosts ?? []).length > 0 &&
    item.questions === null &&
    (item.plan ?? null) === null
  )
}

/**
 * The reason an approval was queued (TODO 994). The same kinds as the Broker's judgment order (4.2.1). The log's reason code
 * (`reason` of `approval.queued`) is made by `approvalQueueReasonCode` (`strict` / `outbound:<match>` /
 * `deny-pattern:<pattern>` ..., the same strings as before wave 52).
 *
 * - `question` a question asking for an answer / `plan` a plan the user asked for / `side-effect` a plugin tool with side effects
 * - `outbound` an outbound operation (TODO 959) / `strict` the thread is in strict mode / `not-default` a tool not in the default allowance
 * - `no-command` a Bash whose command cannot be read / `deny-pattern` a Bash that hit a stop pattern / `unknown` none of these
 * - `persistence` a write that plants a persistent foothold or bypasses a choke point (TODO 1042. `match` is the kind of write destination, `target` is a path or a key)
 * - `secret-read` a route out of a conversation that read a secret (TODO 1043. `source` is the kind of secret read, `egress` is the name of the route out)
 * - `unattended` a gateway tool that an unattended turn (scheduled job, trigger, bundle started from one) wants to use (TODO 1289. `action` is its name, `open-url`)
 */
export type ApprovalQueueReason =
  | { readonly kind: 'question' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'side-effect' }
  | { readonly kind: 'outbound'; readonly match: string }
  | { readonly kind: 'persistence'; readonly match: string; readonly target: string | null }
  | { readonly kind: 'secret-read'; readonly source: string; readonly egress: string }
  | { readonly kind: 'unattended'; readonly action: string }
  | { readonly kind: 'strict' }
  | { readonly kind: 'not-default' }
  | { readonly kind: 'no-command' }
  | { readonly kind: 'deny-pattern'; readonly pattern: string }
  | { readonly kind: 'unknown' }

/** A code for the log of the queueing reason (TODO 994). Makes the same strings as `queueReason` before wave 52. */
export function approvalQueueReasonCode(reason: ApprovalQueueReason): string {
  switch (reason.kind) {
    case 'outbound':
      return `outbound:${reason.match}`
    // The write destination's path / key are not written to the log (the kind only).
    case 'persistence':
      return `persistence:${reason.match}`
    case 'secret-read':
      return `secret-read:${reason.egress}`
    case 'unattended':
      return `unattended:${reason.action}`
    case 'deny-pattern':
      return `deny-pattern:${reason.pattern}`
    default:
      return reason.kind
  }
}

/**
 * Whether this is a request for which "do not ask in this conversation" (TODO 994, `allow-thread`, widened from Bash only in wave 91 983 stage 3) may be offered.
 * **Only requests queued in strict mode with no role, for which main set a proposal (`threadGrant`)** - outbound operations, questions, plans and tools with side effects
 * do not get the reason `strict` (it is decided earlier by the Broker's judgment order), so they fall out here. main (the Broker) accepts it with the same judgment.
 */
export function canAllowForThread(item: ApprovalItem): boolean {
  return (
    // TODO 983: in the strict frame of a role's conversation, "allow this role from now on" is shown instead of this row (do not put two similar rows side by side).
    !canAllowForRole(item) &&
    item.reason?.kind === 'strict' &&
    (item.threadGrant?.subjects.length ?? 0) > 0 &&
    (item.outbound ?? null) === null &&
    (item.plan ?? null) === null &&
    item.questions === null
  )
}

/**
 * Whether this is a request that is asked every time (outbound operation 959, a persistent-foothold write 1042, a route out of a conversation that read a secret 1043,
 * a gateway tool asked for by an unattended turn 1289). "Always allow" is not shown (main does not make a rule either).
 */
export function asksEveryTime(item: ApprovalItem): boolean {
  return (
    (item.outbound ?? null) !== null ||
    item.reason?.kind === 'persistence' ||
    item.reason?.kind === 'secret-read' ||
    item.reason?.kind === 'unattended'
  )
}

/** A write that plants a persistent foothold or bypasses a choke point (TODO 1042). main (the Adapter's `persistenceAction`) judges it from the arguments. */
export interface PersistenceDetail {
  /** The kind of write destination (`shell-startup` / `cli-settings` / `launch-agent` / `crontab` / `git-config` ...). */
  readonly match: string
  /** A path or a key (null if it cannot be obtained). Only shown in the frame, and not written to the log. */
  readonly target: string | null
}

/**
 * The contents of an outbound operation (TODO 959). main (the Adapter's `outboundAction`) extracts it from the arguments.
 * Passed **for display only** and not saved (saving is done with the arguments of `permission_request`, which go through `toPersistable`).
 * A field that could not be extracted is null - the renderer shows everything with "content" (the raw arguments).
 */
export interface OutboundDetail {
  /** `shell` = a shell command, `tool` = a tool such as MCP. */
  readonly channel: 'shell' | 'tool'
  /** What it matched on (the name of the verb / pattern). No value is included. Used for the audit log and display. */
  readonly match: string
  /** The destination (an email recipient, a channel, an issue number, etc.). Several are joined with `, `. */
  readonly to: string | null
  readonly subject: string | null
  readonly body: string | null
  /** The whole command for a shell. */
  readonly command: string | null
}

/**
 * The contents of the approval-frame diff (item 97, 7.6.4). main builds it by applying the change to the file's current contents (read
 * through the choke point `assertAllowed`). **The body is passed for display only and not saved** (constraints 9 / 10).
 *
 * `basis` is the origin of before / after: `file` = applied to the whole file, `fragment` = it could not be applied
 * (the text to replace was not found, the file is too large, or unreadable), so only the changed strings.
 */
export type ApprovalDiff =
  | {
      readonly ok: true
      /** The display name (the file name. No absolute path is included). */
      readonly name: string
      readonly before: string
      readonly after: string
      readonly basis: 'file' | 'fragment'
    }
  | { readonly ok: false; readonly reason: ApprovalDiffFailure }

/**
 * The reason a diff could not be shown (the renderer turns it into wording). `gone` = no longer pending,
 * `not-diffable` = the shape of the write cannot be read, `not-allowed` = the target path hits the choke point.
 */
export type ApprovalDiffFailure = 'gone' | 'not-diffable' | 'not-allowed'

/** The subagent that issued the approval request (item 93). */
export interface ApprovalSubtask {
  readonly taskId: string
  /** The work's heading (a short description the parent's model attached). */
  readonly description: string
}

export type ApprovalDecision =
  | { readonly kind: 'allow' }
  /**
   * **"Yes, manually approve edits" of plan approval** (item 256, wave 15 bundle F). Lets the plan through and **puts the thread
   * into strict mode** (the CLI's "approve edits manually" = from then on each one is confirmed). main accepts this only for a plan
   * presentation (`SessionManager.decideApproval`), and if it arrives for an ordinary request it falls to a one-time allow.
   * Strict mode is a thread setting (`approvalStrict`), so it is turned back with the thread's settings menu.
   */
  | { readonly kind: 'allow-manual' }
  /**
   * Automatically approves the same tool (for `Bash`, the same command) from now on (making a rule from 4.2. The CLI settings are
   * not touched). **A rule applies to the whole app** (T40): it is tied to neither a thread nor a working folder.
   */
  | { readonly kind: 'allow-always' }
  /**
   * **Do not ask from now on in this conversation** (TODO 994, widened in 983 stage 3 to the head word of Bash, prefix matches of write paths and names of read-only tools).
   * Offered only for requests of strict-mode threads with no role (`canAllowForThread`). The allowance is for that thread only, memory only
   * (not saved, and it disappears on restart or when the thread is deleted). The subject is what main decided when it queued the request (the renderer's value is not used).
   * Outbound operations and stop patterns are queued even with this allowance. If it arrives for a request that does not meet the conditions, it falls to a one-time allow.
   */
  | { readonly kind: 'allow-thread' }
  /**
   * **Do not ask about this host from now on** (TODO 1029). Offered only for `ssh` / `scp` / `sftp` / `rsync` requests where the only thing missing is the host among
   * "connection targets not asked about" (`canAllowHost`). It allows this time and adds the request's `quietHosts` (the value main holds) to the list.
   * If it arrives for a request that does not meet the conditions, it falls to a one-time allow.
   */
  | { readonly kind: 'allow-host' }
  /**
   * **Allow this role from now on** (TODO 983, 5. of 4.2.5). Offered only for requests of `canAllowForRole`. It allows this time and adds a row to the role's allowance table with
   * the value (`roleGrant`) main decided when it queued the request. Only the expiry comes from the renderer. If it arrives for a request that does not meet the conditions, it falls to a one-time allow.
   */
  | { readonly kind: 'allow-role'; readonly scope: RoleGrantScope }
  /**
   * Answers a multiple-choice question (T31 / 4.2.2). In both, the key is the **question text**.
   *
   * - `answers`: the labels of the chosen options (one unless multi-select).
   * - `texts`: the free text written for that question. If there is no selection, it becomes the answer;
   *   if there is a selection, it accompanies it as a note (main decides where it goes).
   *
   * **main re-matches it against the question** before returning it to the backend.
   */
  | {
      readonly kind: 'answer'
      readonly answers: Readonly<Record<string, readonly string[]>>
      readonly texts?: Readonly<Record<string, string>>
      /**
       * An answer that automatically picked the recommendation at the end of the countdown (TODO 1194). main marks it as automatic only when it matches the request's `autoPick`,
       * and otherwise treats it as the user's answer without the mark.
       */
      readonly auto?: boolean
    }
  /**
   * Declines. If `message` is empty or omitted, it means "declined without saying anything" (to the backend, "stop and wait", item 183);
   * if written, it means "do this instead" (the permission "deny" field, the plan's "revise", item 182).
   */
  | { readonly kind: 'deny'; readonly message?: string }

/**
 * The name of aios's own MCP gateway (7.6). It must be the same value as `mcp.serverName` in `compat/` and the
 * server name of `src/gateway/` (`test/approval.test.ts` cross-checks them).
 */
export const GATEWAY_SERVER_NAME = 'aios'

/**
 * The head of the gateway's tool names (`mcp__<gateway>__`). The shape of MCP tool names is the backend's convention, but
 * `canAlwaysAllow` has looked at `mcp__` since Phase 2, so the namespace is built here too.
 */
export const GATEWAY_TOOL_PREFIX = `mcp__${GATEWAY_SERVER_NAME}__`

/**
 * Whether this is a tool for which "Always allow" may be offered (4.2 / T12 / item 110).
 *
 * **Only the gateway's own tools (`mcp__<gateway>__*`) are not allowed** (review B-5: do not let the approval and
 * search entry points pass through by rule). Tools of the user's MCP servers (which, since item 110 dropped `--strict-mcp-config`,
 * are read just like the stock CLI) can make rules, as in VS Code.
 * The shell (`Bash`) was opened up in T12: the rule's key is now **the command itself**, not the tool name
 * (`ApprovalRule.command`), so after pressing "Always allow" only
 * the same command passes. The renderer hides the button, and main drops it to `allow` if it arrives anyway.
 */
export function canAlwaysAllow(toolName: string): boolean {
  if (toolName.startsWith(GATEWAY_TOOL_PREFIX)) return false
  return true
}

/**
 * A rule for automatic approval (4.2 / 4.2.1.1).
 *
 * **One table for the whole app** (T40, owner judgment 2026-09-22). Up to T22-T26 it was per thread, and
 * since threads are short-lived, **the same approval was redone every time a new thread was started**.
 * Now a rule that was pressed applies to all of that user's threads, and **it is unrelated to the working folder either**
 * (a rule has no notion of place). It lives in `approval.rules` of `app_settings` (a JSON array).
 *
 * **It has no expiry** - instead `createdAt` is shown in the inbox so that
 * rules whose pressing was forgotten can be recognized (4.2.1).
 */
export interface ApprovalRule {
  /** Used for removal. */
  readonly id: string
  readonly toolName: string
  /**
   * Non-null only for a `Bash` rule: the command itself with whitespace normalized. It applies on an **exact match**
   * (allowing `make all` still stops `make clean`). Other tools apply by tool name alone.
   */
  readonly command: string | null
  /**
   * TODO 859: matching of a `Bash` rule is done with the SHA-256 (hex) of the normalized command. `command` is a **string that went through
   * redaction for display**, so secrets remain neither in the DB nor on the screen. It is not passed to the renderer (inside main only).
   * Old rows (without this column) are converted on loading.
   */
  readonly commandHash?: string | null
  /**
   * The first 8 digits of `commandHash` that `listRules()` attaches for the renderer (wave 42 code-review). A marker so that
   * two rules that differ only in the masked secret do not look identical on the settings screen. Not used for matching.
   */
  readonly hashHead?: string
  readonly createdAt: number
}

/**
 * The approval defaults (T12 / 4.2 "default allowance / stop patterns / strict mode", the default flipped in T40).
 * Stored as JSON in `approval.autoAllowAll` / `approval.autoAllowTools` /
 * `approval.bashDenyPatterns` of `app_settings`.
 *
 * - `autoAllowAll`: **the default (true) is "ask as little as possible"** (T40, owner judgment).
 *   Permission requests that arrive are let through regardless of the tool name. It stops in only 3 cases:
 *   the thread's strict mode, a `Bash` stop pattern, and **a question asking for an answer** (4.2.2).
 *   If false, it becomes the previous behavior of letting through only what is listed in `autoAllowTools`.
 * - `autoAllowTools`: the list of tool names that applies when `autoAllowAll` is false.
 *   **If emptied, it returns to the behavior up to Phase 2 (stop everything).**
 * - `bashDenyPatterns`: for `Bash` only, if the command hits any of these it is stopped rather than let through.
 *   **It applies even with `autoAllowAll`** - the only net of "ask as little as possible".
 *   Matching is in `src/main/approval/policy.ts` (whitespace normalization -> prefix match on
 *   each part separated by pipe / `&&` / `;`).
 */
export interface ApprovalPolicy {
  /** Whether to let everything through regardless of the tool name (T40). Default true. */
  readonly autoAllowAll: boolean
  readonly autoAllowTools: readonly string[]
  readonly bashDenyPatterns: readonly string[]
  /**
   * **Connection targets not asked about** (TODO 1029). `host` / `user@host` (normalized by `src/shared/ssh-hosts.ts`). If the destinations of `ssh` / `scp` / `sftp` / `rsync`
   * are all here and the rest of the command is also a standard command that is not asked about (TODO 1031), it is not asked about even in strict mode or in the outbound-operation judgment.
   * `approval.sshAllowedHosts` of `app_settings`. Omitted means empty.
   */
  readonly sshAllowedHosts?: readonly string[]
  /**
   * Connection targets of the OS sandbox (TODO 1106, 4.2.4, `src/shared/os-sandbox.ts`). Passed to the launch of a thread with the sandbox ON
   * (the hosts of the connection targets not asked about are added too). Not used for the approval judgment. `sandbox.allowedDomains` of `app_settings`. Omitted means the default list.
   */
  readonly sandboxAllowedDomains?: readonly string[]
  /** Places outside the cwd that the OS sandbox can write to (TODO 1106). `sandbox.allowWrite` of `app_settings`. Omitted means the default (`~/.npm`). */
  readonly sandboxAllowWrite?: readonly string[]
  /**
   * **Full delegation mode** (TODO 1175, 4.2.1 "full delegation mode"). If true, it removes the 4 lines that do not pass even with the default or rules - outbound operations (959, including publishing and sending),
   * persistent-foothold writes (1042), routes out of a conversation that read a secret (1043), and tools with side effects (847) - and if the remaining judgments (rules, strict mode, default,
   * stop patterns) let it pass, it passes without asking (`reason: 'full-delegation'` of `approval.auto`). It still stops for questions, requested plans, stop patterns,
   * strict mode, and requests that change aios's own choke-point settings (`gated` of 1060). The CLI-side permission mode is not changed.
   * `approval.fullDelegation` of `app_settings`. Omitted means false.
   */
  readonly fullDelegation?: boolean
}

/**
 * The diff of approval defaults sent from the settings screen to main. The connection targets not asked about (TODO 1029) are sent as add / remove operations (`SshHostsPatch`), and
 * main applies them to the current value (sending the whole would erase, with the stale list from when settings were opened, the frame's "do not ask from now on" and what was added in another window).
 * The sandbox allow table (TODO 1106) has the same form (`SandboxListsPatch`).
 */
/**
 * The writable places (`sandbox.allowWrite`) that main dropped (review of 8 of TODO 1109). Another place's home (`/Volumes/data/me`) and its parent,
 * which the shape check in shared cannot reject, are compared with the real home and dropped. The settings screen shows a note under the field.
 * `home-or-parent`: the home itself or its parent (being able to write there is the same as turning the sandbox OFF).
 */
export interface SandboxWriteDrop {
  readonly path: string
  readonly reason: 'home-or-parent'
}

/** The return of `setPolicy`. The saved value plus the writable places dropped by this call (no field if nothing was dropped). */
export type ApprovalPolicySetResult = ApprovalPolicy & { readonly sandboxWriteDropped?: readonly SandboxWriteDrop[] }

export type ApprovalPolicyPatch = Partial<ApprovalPolicy> & SshHostsPatch & SandboxListsPatch

export const DEFAULT_AUTO_ALLOW_TOOLS: readonly string[] = ['Bash', 'WebFetch', 'WebSearch']

/**
 * The default stop patterns. **Emptied in item 167 (2026-09-27)** - by default nothing is stopped, and
 * only what is added on the settings screen is stopped (equivalent to VS Code + CLI "Bypass permissions").
 * The feature (`matchDenyPattern`) remains as it was.
 */
export const DEFAULT_BASH_DENY_PATTERNS: readonly string[] = []

/**
 * The default stop patterns before item 167. **For comparison** - if a saved value is exactly the same as this, it is not something
 * the user chose but just the old default written out, so it is read as the new default (empty)
 * (`APPROVAL_BASH_DENY_PATTERNS.parse`). **Not used for judgment** (it is not the default stop patterns).
 * **Coarse is fine** - the purpose is to stop "accidents", not to cover malicious commands.
 * One that starts with `|` such as `| sh` matches when the right side of a pipe starts with it.
 */
export const LEGACY_BASH_DENY_PATTERNS: readonly string[] = [
  'rm -rf',
  'rm -fr',
  'rm -r',
  'sudo',
  'git push --force',
  'git push -f',
  'git reset --hard',
  'git clean -f',
  'git checkout -- .',
  'chmod -R',
  'chown -R',
  'mkfs',
  'dd if=',
  'diskutil erase',
  '| sh',
  '| bash',
  '| zsh'
]

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  autoAllowAll: true,
  autoAllowTools: DEFAULT_AUTO_ALLOW_TOOLS,
  bashDenyPatterns: DEFAULT_BASH_DENY_PATTERNS,
  sshAllowedHosts: [],
  sandboxAllowedDomains: DEFAULT_SANDBOX_ALLOWED_DOMAINS,
  sandboxAllowWrite: DEFAULT_SANDBOX_ALLOW_WRITE,
  fullDelegation: false
}

/** A request to create a new thread (sent by the T5 dialog). */
export interface CreateThreadInput {
  readonly cwdUri?: string
  readonly title?: string
  /** If omitted, the default backend. */
  readonly backend?: string
  /**
   * If omitted, `SessionSettings.defaultModelId`. null means "let the backend decide", and
   * since item 61 it is not sent from the UI (the dialog always sends a concrete id).
   * It remains in the type because a route that launches that way exists as a CLI feature (4.5.1).
   */
  readonly modelId?: string | null
  /** If omitted, `SessionSettings.defaultThinking`. */
  readonly thinking?: ThinkingLevel | null
  /** Strict mode (T12). If omitted, false. */
  readonly approvalStrict?: boolean
  /**
   * No affiliation (disposable) (T19 / TODO 24). If true, the cwd is the thread-only scratch area
   * `~/aios/scratch/<threadId>/`, and `cwdUri` cannot be passed. The meaning when omitted / false
   * is unchanged (`cwdUri` omitted = home).
   */
  readonly scratch?: boolean
  /**
   * Continue from the backend's transcript (a conversation in the terminal / VS Code) (item 111, 4.5.9). When specified,
   * the cwd is the transcript's, the initial model is the model of the transcript's last response, and the title is the backend's title
   * (or the first message if none), and `cwdUri` / `scratch` / `modelId` cannot be passed.
   * If `fork` is true, it branches as a separate session (nothing is appended to the original transcript).
   */
  readonly transcript?: { readonly sessionId: string; readonly fork: boolean }
  /**
   * Start the conversation under this role (Teammate, TODO 972). main re-checks that the role exists. What is omitted here comes from the
   * role: the working folder (`cwdUri` / `scratch` omitted -> the role's folder, or a scratch area if the role has none) and Model / Thinking
   * (omitted -> the role's, then the settings' default). The role's standing instructions are applied on every launch. Cannot be combined
   * with `transcript`.
   */
  readonly roleId?: string
}

/** Options for deleting a thread (T19). */
export interface ThreadRemoveOptions {
  /**
   * Delete even if the scratch area has contents. With false / omitted, if there are contents it **deletes nothing** and returns
   * `removed: false`, so the renderer shows a confirmation there and calls again with true.
   */
  readonly force?: boolean
}

/** The result of deleting a thread (T19). */
export interface ThreadRemoveResult {
  /** Whether the thread was deleted. false means "waiting for confirmation because the scratch area has contents". */
  readonly removed: boolean
  /**
   * The number of items directly under the scratch area. 0 for a thread with no scratch area, and when the scratch area does not exist yet.
   * null when the scratch area cannot be read and the count is unknown (broken permissions, etc., TODO 577). Without `force` it returns waiting for confirmation.
   */
  readonly scratchEntries: number | null
}

/**
 * One entry of the working-directory history (T5 / TODO 6). **No path is passed**: only the `file://` URI and
 * the name (treated like search results). Ones that disappeared and excluded ones are shown grayed out with `usable=false`.
 */
export interface CwdHistoryEntry {
  readonly uri: string
  /** The directory name. */
  readonly name: string
  /** The name of the parent directory. To tell apart directories with the same name. */
  readonly parentName: string
  readonly lastUsedAt: number
  readonly useCount: number
  /** Whether it exists and may be put in the reference scope (`FsService.assertAllowed`). */
  readonly usable: boolean
  /**
   * The reason for usable=false. A reason code of `shared/reason.ts` (such as `cwd-not-found`) or
   * the raw text of an exception from the choke point (`assertAllowed`). The renderer's `describeReason` turns it into wording (7.4.4).
   */
  readonly reason: string | null
  /**
   * The cwd's rainbow color, the same as the Sidebar's Threads (item 108, TODO 742). **A row not in the history (`useCount === 0`
   * - merely chosen with "Open Folder...", or the pseudo row for home) is always null** - handing a color to
   * a folder that has no thread yet would consume one unused color just by closing the dialog.
   */
  readonly rainbow: number | null
}

/** One backend shown in the create dialog (4.6 / 4.6.1). */
export interface BackendChoice {
  readonly id: string
  readonly label: string
  readonly available: boolean
  /** The reason for available=false, or a notice such as not logged in. */
  readonly message: string | null
  /** Non-empty only when `model-select` is available. */
  readonly models: readonly ModelChoice[]
  readonly modelSelect: boolean
  readonly thinkingLevel: boolean
  /** Whether "rewind to here" (item 113) can be offered (`rewind` in the feature table). */
  readonly rewind: boolean
  /** The 4 items of "what this backend can do" (TODO 987). False ones are shown grayed out rather than removed. */
  readonly capabilities: BackendCapabilities
  readonly degradations: readonly AgentDegradation[]
  /**
   * The list of commands this backend reported last (item 68, without the leading `/`).
   * **null if no session has started since launch** (= unknown, so it is not blocked).
   * If the thread's own list (that thread's `session_started`) exists, it takes priority.
   */
  readonly commands: readonly string[] | null
  /** Whether the Plan mode toggle can be offered (item 112 / 4.2.3). Omitted means false. */
  readonly planMode?: boolean
  /**
   * Whether the OS sandbox (TODO 1106, 4.2.4) can be used (`os-sandbox` in the feature table). If false, the thread's ⋯ toggle is grayed out, and
   * the reason is the `os-sandbox` row of `degradations` (it turned out to be unusable at launch), or if none, "this version does not have it". Omitted means false.
   */
  readonly osSandbox?: boolean
  /**
   * TODO 1288: whether a Teammate's standing instructions reach this backend (`standing-instructions` in the feature table). Only an explicit
   * false means "ignored" (shown as a gray note under the instructions field of the Teammate editor); omitted means unknown and shows nothing.
   */
  readonly standingInstructions?: boolean
}

/** The information the create dialog fetches at once (T5). */
export interface ThreadCreateOptions {
  readonly backends: readonly BackendChoice[]
  readonly defaultBackend: string
  readonly homeUri: string
  readonly cwdHistory: readonly CwdHistoryEntry[]
}

/** The result of "choose another folder...". If rejected, the reason is included. */
export interface DirectoryPick {
  readonly uri: string | null
  readonly reason: string | null
}

/**
 * A notice for a first-time folder (item 123, 4.3.2). When a folder is chosen in the create dialog, main returns this if that folder is
 * new (in neither aios's working-folder history nor the backend's conversation transcripts) and has anything
 * that runs without confirmation. **It only informs and does not block creation.**
 */
export interface FolderNotice {
  /** Files holding settings (hooks) that run commands without going through approval. */
  readonly hooks: readonly FolderNoticeFile[]
  /** Files that declare MCP servers that come up just by starting a session (connected without confirmation). */
  readonly mcp: readonly FolderNoticeFile[]
}

export interface FolderNoticeFile {
  readonly uri: string
  /** Names inside the file (event names for hooks, server names for MCP. At most 8, empty if unknown). */
  readonly names: readonly string[]
}

/** A send from the prompt box (4.5). */
export interface SendInput {
  readonly text: string
  /** Attachments. Images are sent as base64, and for others a path reference is embedded in the text. */
  readonly attachments?: readonly Attachment[]
  /**
   * The model to use for this message (T7 / 4.5.1). Omitted means the thread's default, and `null` is an explicit
   * "backend default". **It can only be passed with a launch flag**, so if it differs from the running
   * process's setting, the process is killed and started again by resuming (4.6.2).
   */
  readonly modelId?: string | null
  /** The depth of thinking to use for this message (T7). Omitted means the thread's default. */
  readonly thinking?: ThinkingLevel | null
  /**
   * How far the above 2 apply. `message` (the default) is for this message only, and
   * `thread` also rewrites the thread's default ("from now on").
   */
  readonly settingsScope?: 'message' | 'thread'
  /**
   * Attaches the ViewerPane's selection (item 97 / 4.5). main re-validates the URI and embeds the body in
   * the send text. **It is saved only as the user's message** (it passes through `toPersistable`'s
   * masking - constraints 9 / 10).
   */
  readonly selection?: ViewerSelection
  /**
   * `!` in the prompt box (item 116 / 4.5.7). Passes `text` to the shell in the thread's cwd and mixes the command and
   * output into the **next message** (this input itself is not sent to the backend). main re-validates `text` with
   * `shellCommandOf`, and does not look at attachments, the selection or the model / thinking settings.
   */
  readonly shell?: boolean
}

/** The selection attached to a send (item 97). Which lines of which file. */
export interface ViewerSelection extends ViewerSelectionRange {
  readonly uri: string
}

/**
 * main -> renderer "open / close this in the ViewerPane" (item 97). When the model calls the gateway's
 * `openFile` / `closeFile`, it reaches **only the window showing that thread**.
 * The renderer obeys only when the thread currently shown is the same as `threadId`, and does not
 * obey if there are unsaved edits (it does not throw away a draft). `uri` is a value main passed through the choke point (`assertAllowed`).
 */
export type ViewerCommand =
  | {
      readonly kind: 'open'
      readonly threadId: string
      /** `file://` (the gateway's `openFile`) or an http(s) URL (`openUrl`, TODO 822 - the renderer opens it in a Web tab). */
      readonly uri: string
      readonly highlight: string | null
      /**
       * The line to jump to (1-based, item 273). Set only when `openFile` had a `line`. A one-shot instruction that
       * stays in neither main's memory (`setViewerState`) nor the renderer's memory (item 63).
       */
      readonly line?: number
      /**
       * The page to jump to (1-based, 1 of TODO 1091, PDF). Set only when `openFile` had a `page` (not set if there is a `line`).
       * A one-shot instruction like `line`, and not kept in memory.
       */
      readonly page?: number
      /**
       * TODO 832 (1): the reply id. Attached only for a window that main knows "has a draft". The renderer returns whether it obeyed
       * (`opened`), kept the draft and did not switch (`kept`), or was not showing that thread (`ignored`) with
       * `viewer.replyCommand`, and main puts that in the return value of the gateway's `openFile` (so it does not lie with `opened: true`).
       */
      readonly replyId?: string
    }
  /** If `uri` is null, close whatever is open. Otherwise, close only if that one is open. */
  | { readonly kind: 'close'; readonly threadId: string; readonly uri: string | null }
  /**
   * The model tried to write to a file for which this window currently has a draft (second half of item 97).
   * **Unrelated to whether it is approved** (the default is auto-allow, T40) - it only informs. `uri` is a file that
   * matched the draft's URI (not the raw tool argument that main merely folded without going through `assertAllowed`, but
   * the value confirmed after comparing with the draft's memory). `toolName` is material for a fixed English sentence (the renderer does not
   * know the backend's tool names, so it is not used to switch dictionary keys and is used only for plain display).
   */
  | { readonly kind: 'draftConflict'; readonly threadId: string; readonly uri: string; readonly toolName: string }
  /**
   * An outside tool (an editor, `git checkout`, a build, etc.) rewrote the file this window is currently looking at
   * (TODO 673, ARCHITECTURE.md 5.2 / 7.4). **Unrelated to threads** - it has no `threadId`.
   * main (`ViewerFileWatcher`) remembers only one "file currently being viewed" per window, watches its parent
   * directory, and sends only when `uri` matches. If there is no draft, the renderer silently
   * reloads, and if there is, it shows the same band as `draftConflict` (`viewerMemory.ts`).
   */
  | { readonly kind: 'fileChanged'; readonly uri: string }
  /**
   * The gateway's `openDiff` (TODO 826, ARCHITECTURE.md 7.6.2). Shows a diff in the ViewerPane of the window showing that thread as
   * a temporary view of `aios.diff` (7.4.6). The contents are the 2 texts main read, **passed for display only and not saved** (constraints 9 / 10).
   * It is not kept in memory (item 63) (a temporary view has no URI). `diff.layout` is `split` (a diff opened by the AI is side by side).
   */
  | { readonly kind: 'diff'; readonly threadId: string; readonly diff: DiffPayload }
  /**
   * The gateway's `openSettings` (TODO 1060 stage 2, ARCHITECTURE.md 7.6.8). Opens the settings screen in the window showing that thread,
   * scrolls to the field of `name` and highlights it. `name` is a setting name main validated against the settings table (`AgentSettings`) (a key of `SettingValues`).
   * It does not change values. It is not a ViewerPane instruction, but the destination "only the windows showing that conversation" is the same, so it rides on this route.
   */
  | { readonly kind: 'settings'; readonly threadId: string; readonly name: SettingValueKey }

/** TODO 832 (1): how the window handled an `open` instruction (with `replyId`). The same as the 3 results of `planViewerCommand`. */
export type ViewerCommandOutcome = 'opened' | 'kept' | 'ignored'

export interface Attachment {
  readonly uri: string
  readonly name: string
  /** `image` attaches it to the body, and `reference` puts only a path reference into the text. */
  readonly kind: 'image' | 'reference'
  readonly mediaType: string | null
  /** Present only for kind=image. */
  readonly base64?: string
  readonly bytes: number
  /**
   * A reduced version shown in the timeline after sending (TODO 550). The renderer makes it from `base64` just before sending
   * (a data URL with a long side of up to 1600 px). main re-validates and keeps it only for an image with no file, and discards it otherwise.
   */
  readonly thumbnail?: string
  /**
   * TODO 591: the value of `AttachmentResolution.keepsThumbnail` copied into the renderer's attachment memory (removed
   * just before sending to main - main does not look at this field). Omitted (undefined) means "may make one" (aligned with routes that
   * do not set this field, such as clipboard paste). Only false means no reduced version is made.
   */
  readonly keepsThumbnail?: boolean
}

/** The result of resolving a file dropped by D&D / paste into a sendable form (4.5). */
export type AttachmentResolution =
  | {
      readonly ok: true
      readonly attachment: Attachment
      readonly outsideAllowed: boolean
      /**
       * TODO 591: whether main keeps, when saving, the reduced version (`Attachment.thumbnail`) the renderer makes just before sending.
       * For `kind: 'image'` pointing at a file and a place that can be viewed now (not hitting an exclusion) =
       * the side where `sentAttachmentsOf` of `sent-attachments.ts` keeps only the path and discards the rest, it is false
       * (the renderer need not make a reduced version). For an image with no file (an excluded temporary folder), it is
       * true. For `kind: 'reference'` (an image that is too large, or a non-image file) there is no reduced version, so
       * it is always false.
       */
      readonly keepsThumbnail: boolean
    }
  /** `reason` is a reason code (such as `attach-directory`) or the raw text of the choke point (7.4.4). */
  | { readonly ok: false; readonly reason: string }

/**
 * The head of the `uri` of an attachment of an image pasted from the clipboard (item 319). A mark that it does not point at a file, and
 * `Attachment.kind` is always `image`. main does not pass it through `uriToPath` (it does not make it a path reference).
 */
export const CLIPBOARD_ATTACHMENT_PREFIX = 'aios-clipboard:'

/** Settings for the number of parallel runs and the session lifetime (12.2 / spike 5). */
export interface SessionSettings {
  /** The number of processes started at once. The constraint is memory, not the rate limit (about 410 MB each). */
  readonly maxConcurrent: number
  readonly maxConcurrentCap: number
  /** If there is no operation for this long, the process is killed. It is recovered by resuming (12.2). */
  readonly idleTimeoutMs: number
  /** The default retention for new threads. */
  readonly defaultRetention: ThreadRetention
  /**
   * The default model for new threads (T5). The dialog and the settings screen use it as the initial value.
   * null means "not chosen yet", and the UI picks the first of the list (item 61: there is no "default" choice).
   */
  readonly defaultModelId: string | null
  /** The default thinking for new threads (T5). If null, the UI uses `FALLBACK_THINKING`. */
  readonly defaultThinking: ThinkingLevel | null
}

/** The result of fetching the timeline. */
export interface Timeline {
  readonly threadId: string
  readonly events: readonly AiosEvent[]
  /** True when it is empty because nothing was saved with retention='none'. */
  readonly notPersisted: boolean
  /**
   * The `seq` of the oldest row among those returned (item 88). "Read more" uses it as `before`
   * to fetch the previous page (keyset). null if no rows were returned.
   */
  readonly oldestSeq: number | null
  /** The number of rows remaining before `oldestSeq` (item 88). 0 means everything has been read to the start. */
  readonly remaining: number
}

/**
 * The title of a provisional-title thread (one with no name yet). An empty string is used as a **language-independent mark** (TODO 66).
 *
 * - This is also the value saved in the DB (`threads.title`). The truth of whether it is provisional is `threads.title_auto`, and
 *   `ThreadStore` aligns the title of rows with `title_auto = 1` to this value when reading - rows made before TODO 66
 *   have the Japanese default title (the Japanese "new thread") left in the DB, and to avoid mistaking them for rows given that same title by hand (`title_auto = 0`),
 *   it is judged by the column, not by the string.
 * - It is displayed by the renderer's `threadTitleLabel` (`thread.untitled`). The conversation title of a search hit and
 *   the approval's `threadTitle` also arrive with the same value.
 */
export const UNTITLED_THREAD_TITLE = ''

/**
 * One row of the deleted-thread list (item 191). The minimum value shown in the collapsed "Deleted (N)" at the bottom of the SideBar's list.
 * Paths are not passed, only names (the same convention as `Thread.cwdName`).
 * The retention is indefinite (owner decision 2026-09-28) - there is no cleanup, so this list stays
 * as long as there are logically deleted rows.
 */
export interface DeletedThreadSummary {
  readonly id: string
  readonly title: string
  readonly cwdName: string
  readonly rainbow: number | null
  /** The time of deletion (`threads.deleted_at`). The list is in newest-first order of this. */
  readonly deletedAt: number
  /**
   * The number of worktrees left behind by cleanup (TODO 633 stage 1). The worktree that conversation made had changes or unpushed commits
   * (or git-ignored files that cannot be recreated - TODO 748, a running CLI's lock, outside the storage location). A mark is shown on the row.
   * No field if 0.
   */
  readonly keptWorktrees?: number
}
