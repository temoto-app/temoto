/**
 * `AgentAdapter` - the only boundary between SessionManager and the backend
 * (ARCHITECTURE.md 4.6 / 4.6.1).
 *
 * **Do not write backend-specific words in this file.** Only `src/main/session/adapter/` knows concrete executable names,
 * flags, and event formats, and lint (`npm run lint:terms`) rejects forbidden words anywhere else.
 *
 * Do not abstract ahead of need (4.6.1): until a second implementation is needed, only keep
 * "do not leak specific concepts outside".
 */
import type {
  AgentFeature,
  AgentStatus,
  AiosEvent,
  JsonValue,
  ModelChoice,
  ShellRunPayload,
  ThinkingLevel
} from '@shared/agent.js'
import type { GrantSubject, OutboundDetail, PersistenceDetail, SwitchRestart } from '@shared/thread.js'
import type { UnattendedLoginGuide } from '@shared/login-recovery.js'
import type { ApprovalReply } from '../approval/reply.js'
import type { ResolvedGrantPath } from '../approval/grants.js'
import type { ContextCategoryKind, ContextTone } from '@shared/context-breakdown.js'
import type { ReasonCode } from '@shared/reason.js'
import type { OsSandboxPolicy } from '@shared/os-sandbox.js'
import type { GmailDraftFont } from '@shared/gmail-draft-font.js'
import type { LocalModelAction, LocalModelActionResult, LocalModelActivityRow, LocalModelAdvice } from '@shared/local-models.js'

/** The output limit and timeout of the prompt field's `!` (item 116 / 4.5.7). */
export interface ShellLimits {
  /** The limit (characters) for each of stdout / stderr. What exceeds it loses its middle. */
  readonly maxOutputChars: number
  readonly timeoutMs: number
}

/** The input for one turn to send (4.5). */
export interface AgentInput {
  readonly text: string
  /** Image attachments. The caller drops them if there is no `image-input` feature. */
  readonly images?: readonly { readonly mediaType: string; readonly base64: string }[]
}

/**
 * Connection information for the MCP gateway aios sets up (7.6).
 * The Adapter converts it into a settings format the backend can read and passes it on.
 */
export interface GatewayEndpoint {
  readonly socketPath: string
  readonly token: string
  /** The gateway script. */
  readonly scriptPath: string
  /** The runtime that runs the gateway (uses the Electron binary as Node). */
  readonly runtimePath: string
  /** Where the generated settings files are placed (written with 0600). */
  readonly configDir: string
}

export interface SpawnOptions {
  /** aios's internal session ID. A different thing from the backend's ID. */
  readonly sessionId: string
  readonly threadId: string
  readonly cwd: string
  /**
   * Directories always allowed to be referenced (4.4).
   * **= the range whose full text is read without approval** (spike 9d).
   */
  readonly allowedDirs: readonly string[]
  /** Resume an existing session. null means new. */
  readonly resumeBackendSessionId: string | null
  /**
   * When resuming, continue from the conversation up to this reply (`TextPayload.messageId` / `ToolUsePayload.messageId`)
   * (item 113, 4.5.6). null means from the end. Ignored if `resumeBackendSessionId` is null.
   */
  readonly resumeAtMessageId?: string | null
  /**
   * Start the resume **as a separate session** (item 113). The original session's transcript is untouched, and a new
   * backend session id is assigned (`backendSessionId` of `session_started`).
   */
  readonly forkSession?: boolean
  /** The model (T5). null is the default. The caller makes it null if there is no `model-select`. */
  readonly modelId: string | null
  /** The depth of thinking (T5). null is the default. null if there is no `thinking-level`. */
  readonly thinking: ThinkingLevel | null
  /**
   * Start in Plan mode (item 112 / 4.2.3). Omitted means false (aios's default permission mode).
   * Switching a running process is `AgentSession.setPlanMode`.
   */
  readonly planMode?: boolean
  /**
   * Start a new conversation inside a worktree with this name (TODO 633 stage 3, a bundle conversation). **Not passed on resume**
   * (a resume starts in the worktree's cwd). The name is only alphanumerics, `-` and `_` (the caller tidies it).
   */
  readonly worktreeName?: string
  /**
   * Start with the OS sandbox enabled (TODO 1106, 4.2.4). What is passed is the allow table (destinations and places writable outside the cwd). Omitted or null means
   * no sandbox. **The caller does not pass it to an Adapter without the `os-sandbox` feature** (if passed anyway, the Adapter does not ignore it but refuses to start).
   * The reference scope (`allowedDirs`) goes back to read-only inside the sandbox (the Adapter's job, spike 38).
   */
  readonly osSandbox?: OsSandboxPolicy | null
  /**
   * Start unattended and read-only (TODO 1216, 6.2.6. A trigger's first turn). The Adapter removes writes, the shell, web fetches, and tools that send things outside
   * with the backend's launch flags (to the extent confirmed to work; an implementation without them may ignore this - the approval choke point
   * `GatewayRequests` always refuses, so the flag is a double safeguard). Omitted means false.
   */
  readonly readOnly?: boolean
  /**
   * The font of a Gmail draft's body (TODO 1229). Passed only for `monospace` (the standard omits the field = gives no instruction).
   * The Adapter adds one sentence to the extra instructions (the backend's entry point). Connectors are read by the CLI, so whether it takes effect is up to the model.
   */
  readonly gmailDraftFont?: GmailDraftFont
  /**
   * The standing instructions of the conversation's role (shown as a "Teammate", TODO 972). The user's own text, passed on every launch
   * (new and resumed) so that it applies to every turn. The Adapter adds it to the extra instructions (the backend's entry point for them)
   * under a short frame; an Adapter without that entry point ignores it. Omitted means none.
   */
  readonly roleInstructions?: string
  readonly gateway: GatewayEndpoint
}

/** The circumstances of the exit. **The exit code cannot tell an abnormal exit** (spike 1: 0 even for SIGINT). */
export interface AgentExit {
  readonly code: number | null
  readonly signal: string | null
  /** Whether a completion event was received. This is the main basis for deciding an abnormal exit. */
  readonly sawResult: boolean
  /** Whether aios itself stopped it (interrupt / stop). */
  readonly requested: boolean
  /** Launch diagnostics (the tail of stderr, at most 16 KB). Used only to tell the cause of a launch that ended before init (TODO 1106). */
  readonly stderr?: string
}

/**
 * The form the Adapter passes to main's approval inbox when the backend asks for permission through its own entry point (the event API)
 * (TODO 529, 4.6.1). It flows to the same entry as the MCP gateway's `approve` (`approve` of `handleGatewayRequest`),
 * so the default auto-allow, rules, strict mode, the decision for operations that go outside, and the timeline record are the same as via the gateway.
 * A backend that uses the gateway's `approve` (permission-prompt-tool) does not call it.
 */
export interface PermissionAsk {
  readonly toolName: string
  readonly input: JsonValue
  readonly toolUseId: string | null
}

export interface PermissionAnswer {
  readonly allowed: boolean
  /** The sentence returned to the model on refusal (may be empty for an allow). */
  readonly message: string
}

export interface SpawnHandlers {
  readonly onEvent: (event: AiosEvent) => void
  readonly onExit: (exit: AgentExit) => void
  /**
   * Sends a permission request to the approval inbox (TODO 529). Only the Adapter of a backend that does not go through the gateway's `approve` calls it.
   * It does not resolve until the approval inbox answers (the timeout is a matter of the Broker side's `expiresAt`). After shutdown it resolves as a refusal.
   */
  readonly onPermission?: (ask: PermissionAsk) => Promise<PermissionAnswer>
}

/** The handle of one launched session. */
export interface AgentSession {
  readonly sessionId: string
  /**
   * Sends one line of input. **Does not throw**: a write failure (EPIPE on a pipe that just died, etc.) is reported by
   * the `error` of `onEvent` (`origin: 'stream'`), and the exit is reported by `onExit` (item 82).
   */
  send(input: AgentInput): void
  /**
   * Stops the turn being generated. **The process stays** (item 94, spike 15b). The backend
   * cuts off the turn and emits a completion event (`result`, `payload.interrupted = true`), and
   * accepts the next input as is - no `--resume` startup cost.
   *
   * Resolves when the interrupt request is accepted, and rejects on refusal, timeout, or an exit before that
   * (the caller can fall back to `abort()`). For a session that is not running, it does nothing and resolves.
   */
  interrupt(): Promise<void>
  /**
   * Stops the reply being generated **together with the process** (the stop button, spike 1: exit 0 even for SIGINT).
   * Context remains, and it resumes on the next send. Before item 94 this was named `interrupt()`.
   */
  abort(): void
  /** Ends the process. */
  stop(): Promise<void>
  readonly alive: boolean
  /**
   * Switches model / thinking while running (item 95, 4.5.1). **Not called during a reply (waiting for `result`)** -
   * only after the previous turn ends and just before the next input. **Does not throw**.
   * true if switched; false if this entry point cannot switch (the version does not support it, or it cannot be
   * changed back because of a launch-time setting), or on refusal, timeout, or failure midway, and the caller drops it and wakes it again by resume
   * (waking again passes everything again by launch flags, so a partly applied state is overwritten too).
   * An implementation without it may omit it (= always wake again).
   */
  switchSettings?(target: {
    readonly modelId: string | null
    readonly thinking: ThinkingLevel | null
  }): Promise<boolean>
  /**
   * Whether, with the same specification (model id), the value passed to the backend changed after launch (wave 82 review Y-2). Example: in a session
   * started before it was told, learning it later changed which version the same id points to. If true, the caller, just before the next input,
   * calls `switchSettings` with the same specification to align it (if that does not go through, wake it again). Omitted = does not drift.
   */
  modelDrifted?(): boolean
  /**
   * The range that `switchSettings` can switch (for the renderer's "restart required" note, item 95).
   * Defaults to `always` (= wake again at every change).
   */
  readonly switchRestart?: SwitchRestart
  /**
   * Turns Plan mode on / off while running (item 112, spike 21 / 22). Like `switchSettings`,
   * **not called during a reply** and **does not throw**. true if switched; false for a version without an entry point, refusal, or timeout,
   * and the caller drops it and wakes it again by resume (passed again by launch flags). Omitted = always wake again.
   */
  setPlanMode?(on: boolean): Promise<boolean>

  /**
   * Restores files to the checkpoint just before that message (item 113, 4.5.6). `userMessageId` is the
   * `messageId` copied into `user_text`. With `dryRun`, it does not restore and only returns "what would change if restored".
   * **Not called during a reply (waiting for `result`)** (the caller refuses).
   *
   * null for a version that does not support it or an implementation without an entry point. If the backend answers "cannot restore",
   * `canRewind: false` (does not throw). No answer, or a refusal, rejects.
   */
  rewindFiles?(userMessageId: string, dryRun: boolean): Promise<RewindFilesResult | null>

  /**
   * Token counts per section of the current context (item 155, spike 26). May be called during a reply (the model is not called).
   * **Does not throw**: null for a version that does not support it, refusal, timeout, or an exit. An implementation without it may omit it.
   */
  contextUsage?(): Promise<AgentContextUsage | null>
}

/**
 * The result of `AgentSession.contextUsage` (item 155). Section names are the backend's names as they are, and the color role
 * (`tone`) is decided by the Adapter from the compat table. The path of a memory file is the absolute path the backend returned
 * (main turns it into a URI and applies the choke point).
 */
export interface AgentContextUsage {
  readonly model: string | null
  readonly totalTokens: number
  readonly maxTokens: number
  readonly percentage: number
  readonly categories: readonly {
    readonly name: string
    readonly tokens: number
    readonly kind: ContextCategoryKind
    readonly tone: ContextTone | null
  }[]
  readonly memoryFiles: readonly { readonly path: string; readonly type: string; readonly tokens: number }[]
}

/** The result of `AgentSession.rewindFiles` (item 113). Paths stay as the absolute paths the backend returned. */
export interface RewindFilesResult {
  readonly canRewind: boolean
  /** For `dryRun`: the files that would change if restored. Empty in the real run. */
  readonly filesChanged: readonly string[]
  readonly insertions: number
  readonly deletions: number
}

/**
 * The contents of a write tool's change (the diff in the approval frame of item 97). The argument keys are backend-specific, so
 * the Adapter reads them and turns them into this neutral form. Applying it to the file's current contents to produce before and after is done by main
 * (`approval/write-diff.ts`).
 */
export type WriteChange =
  | {
      /** Replacement of a string. Applied in order. With `replaceAll`, all of them; if false, only the first. */
      readonly kind: 'replace'
      readonly edits: readonly {
        readonly oldText: string
        readonly newText: string
        readonly replaceAll: boolean
      }[]
    }
  /** Writes the whole file (creates it if missing). */
  | { readonly kind: 'overwrite'; readonly content: string }
  /** One cell of a notebook (Jupyter format). If `cellId` is null, the start (insert) / unknown. */
  | {
      readonly kind: 'notebookCell'
      readonly cellId: string | null
      readonly newSource: string
      readonly mode: 'replace' | 'insert' | 'delete'
    }

export interface WritePreview {
  /** The target path. If relative, resolved against the thread's cwd (by the caller). */
  readonly path: string
  readonly change: WriteChange
}

/** Information about one transcript file (a neutral form. Only the Adapter knows the location and format). */
export interface TranscriptFileInfo {
  readonly id: string
  readonly uri: string
  /** For change detection (mtime+size). */
  readonly version: string
  readonly mtimeMs: number
}

export interface TranscriptMessage {
  readonly id: string
  readonly role: string
  readonly text: string
  readonly ts: number
  readonly sessionId: string
  /**
   * Item 78: the byte offset and byte length of this message's line in the file (excluding the newline).
   * **Bytes, not characters** (UTF-8). The index keeps it in `documents.metadata`, and
   * re-reading a snippet partially reads just that one line.
   */
  readonly offset: number
  readonly length: number
}

/** The read result for one file. `version` is made from the `fstat` of the very fd that was read. */
export interface TranscriptFileContent {
  readonly id: string
  readonly uri: string
  readonly version: string
  /** The backend session id of this transcript (read from the lines). null if unreadable (item 111). */
  readonly sessionId: string | null
  readonly messages: readonly TranscriptMessage[]
}

/**
 * A summary of one transcript (item 111, 4.5.9). The material for the creation dialog's list of conversations made in the CLI, and
 * for continuing. **Knowledge of the format is only inside the Adapter**, and only neutral values come here.
 */
export interface TranscriptSessionInfo {
  /** The file's opaque id (the same as `readHistory` / the index's `fileId`). */
  readonly id: string
  /** `transcript://<id>`. The same as the head of an index hit's `uri`. */
  readonly uri: string
  readonly sessionId: string
  /** The `cwd` of each transcript line. null if absent (a broken transcript) - it cannot be continued. */
  readonly cwd: string | null
  /** The title the backend gave. null if none. */
  readonly title: string | null
  /** The start of the first user message (one line, already truncated). The empty string if none. */
  readonly firstPrompt: string
  /** The model name of the last reply (full name). null if none. */
  readonly model: string | null
  readonly mtimeMs: number
  /** The current size of the file (bytes). It becomes the read-stop position (`limit`) at the time of continuing. */
  readonly size: number
}

/** The wrapper passed to `readHistory`. Fills in the event's `threadId` and `sessionId`. */
export interface TranscriptHistoryContext {
  readonly threadId: string
  /** The value for the event's `sessionId` (the transcript's session id is fine, not aios's internal id). */
  readonly sessionId: string
}

/**
 * Where one message is (item 78). The `offset` / `length` at import time, and
 * the file's `version` then. **Contains no knowledge of the format** (only numbers and an opaque string).
 */
export interface TranscriptLocator {
  readonly offset: number
  readonly length: number
  readonly version: string
}

/**
 * The result of `readMessageText`. If `stale` is true, the location was unusable and it fell back to parsing all lines
 * (= the index's record is old), so the caller may re-import that file.
 * If `missing` is true, the file itself is gone (ENOENT. Deleted in the terminal, or cleaned up by the CLI - item 241).
 * The caller may drop that file from the index.
 */
export interface TranscriptTextResult {
  readonly text: string | null
  readonly stale: boolean
  readonly missing: boolean
}

export interface TranscriptToolResult {
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
}

/**
 * Read-only access to the conversation transcripts the backend leaves (12.2 / 12.7).
 *
 * There are two uses: (a) to make conversations held in the terminal searchable, and
 * (b) to read the `tool_result` that aios does not save from the canonical copy **only at display time**.
 * **`tool_result` is not put in the index or the DB** (constraint 10).
 */
export interface TranscriptStore {
  listFiles(): Promise<readonly TranscriptFileInfo[]>
  readMessages(fileId: string): Promise<TranscriptFileContent | null>
  /**
   * The list of conversations that can be continued (item 111). Subagent transcripts and broken transcripts are not included.
   * Excluding "what an aios thread already has" is the caller's (SessionManager's) job.
   */
  listSessions(): Promise<readonly TranscriptSessionInfo[]>
  /** One by session id. null if none. */
  findSession(sessionId: string): Promise<TranscriptSessionInfo | null>
  /** A summary of the file that an index hit's `uri` (`transcript://<fileId>/<messageId>`) points to. null if none. */
  describeUri(uri: string): Promise<TranscriptSessionInfo | null>
  /**
   * Returns the past part as timeline events (item 111). Only the lines **up to `limit` bytes**
   * (the read-stop position at the time of continuing - what comes after is in aios's own `thread_events`).
   * The body is only read from the transcript and not put in the DB (constraint 9). `tool_result` is length only (constraint 10).
   * Subagent lines (sidechain) and internal lines (meta) are not emitted. null if the file does not exist.
   */
  readHistory(
    fileId: string,
    ctx: TranscriptHistoryContext,
    limit: number
  ): Promise<readonly AiosEvent[] | null>
  readMessageText(
    fileId: string,
    messageId: string,
    locator?: TranscriptLocator | null
  ): Promise<TranscriptTextResult>
  findToolResult(
    backendSessionId: string,
    toolUseId: string
  ): Promise<TranscriptToolResult | null>
}

/**
 * The result of one run of the backend's own update (TODO 774). The decision is by exit code and the versions before and after; the Adapter only reads
 * the output text by partial match against a table (not displayed or saved).
 * - `updated`: the version changed (`before` -> `after`)
 * - `unchanged`: exit code 0 and the version did not change (it was already the latest)
 * - `failed`: it could not be installed (the reason is in `failure`. Includes being managed by a package manager, another update in progress, and an administrator's stop)
 */
export type AgentSelfUpdateRun =
  | { readonly outcome: 'updated'; readonly before: string | null; readonly after: string }
  | { readonly outcome: 'unchanged'; readonly before: string | null; readonly after: string | null }
  | {
      readonly outcome: 'failed'
      readonly before: string | null
      readonly after: string | null
      readonly failure: ReasonCode
      /** Values to insert into the failure reason (exit code, etc.). */
      readonly params?: Readonly<Record<string, string | number>>
    }

/** The entry point of the backend's own update (TODO 774). */
export interface AgentSelfUpdate {
  /** Whether the backend's own settings (environment variables) stop auto-update. If stopped, aios does not run it automatically either. */
  autoBlockedByBackend(): boolean
  /** The current version (read without going through the cache, separate from the detection of `getStatus`). */
  currentVersion(): Promise<string | null>
  /** Whether that version is in aios's table of known versions (if not, it is an "unverified version"). */
  isKnownVersion(version: string): boolean
  /** Updates to the latest (the backend's own update). Returned as a result, not as an exception. */
  update(): Promise<AgentSelfUpdateRun>
  /** Installs the specified version (rolls back to the previous version). `failed` if it is not in a version shape. Returned as a result, not as an exception. */
  install(version: string): Promise<AgentSelfUpdateRun>
}

/** The result of the real-run decision (probe) of the feature table (4.6 / item 81). */
export interface AgentProbeResult {
  /**
   * Whether launch succeeded with the whole set of flags passed. If false, `status.features` stays at the pre-probe
   * (provisional) values, and the reason is in `status.degradations`.
   */
  readonly ok: boolean
  /** The state after reflecting the probe. */
  readonly status: AgentStatus
}

/**
 * One file that declares something that runs without confirmation (item 123). `names` are the names inside it
 * (event names for hooks, server names for MCP. At most 8; empty if unknown).
 */
export interface ProjectAutorunFile {
  readonly path: string
  readonly names: readonly string[]
}

/** What runs without confirmation in a folder (item 123, 4.6.2 (10)). */
export interface ProjectAutorunReport {
  /** Files that have settings (hooks) that run commands without going through approval. */
  readonly hooks: readonly ProjectAutorunFile[]
  /** Files that declare MCP servers that start up just by starting the process. */
  readonly mcp: readonly ProjectAutorunFile[]
}

/**
 * The trigger of a bundle of expired-login diagnostics (TODO 1147). `interrupt-auth` = the conversation stopped on an expired login, `login-lost` = the login state turned from true to false,
 * `logged-out-at-start` = not logged in at the first detection after launch, `retry-failed` = still not logged in at the retry 30 seconds later,
 * `login-restored` = went back from false to true after the expiry (to line up the keychain item's update time with the time it came back).
 */
export type AuthDiagnosticsTrigger =
  | 'interrupt-auth'
  | 'login-lost'
  | 'logged-out-at-start'
  | 'retry-failed'
  | 'login-restored'

/**
 * TODO 1066 (ARCHITECTURE 4.6.1.2): the local model "recommendation for this PC", and operations that run only when the user presses a button.
 * The recommendation table and the entry point of the runtime are backend-specific (constraint 6), so the Adapter holds them. The runtime environment is examined by the OS layer (`src/main/os/hardware.ts`).
 */
export interface LocalModelAdvisor {
  /** The recommendation. null if it does not handle a local runtime, or has no table. `force` re-examines the runtime environment too. */
  advise(force: boolean): Promise<LocalModelAdvice | null>
  /** The operation that was pressed. `model` is accepted only if it is in the current recommendation (the renderer's value is re-validated). */
  act(action: LocalModelAction, model: string): Promise<LocalModelActionResult>
  /** Only the running operations and their progress (synchronous, examines nothing). A light entry point so the recommendation calculation (hardware, queries to Ollama) is not redone. */
  activity(): readonly LocalModelActivityRow[]
}

export interface AgentAdapter {
  /** The key of the registry (4.6.1). Saved in `threads.backend`. */
  readonly id: string
  /** The display name. Shown in the creation dialog (not shown if there is only one backend). */
  readonly label: string
  /** The version, login state, and feature table. `force` detects again. */
  getStatus(force?: boolean): Promise<AgentStatus>
  /**
   * Re-checks only the login state, reflects it into the local state, and returns it (TODO 893, the expired-login badge). The version and feature table are
   * not detected again. Credentials are not touched (constraint 2). An implementation without it may omit it (= `getStatus()`).
   */
  recheckLogin?(): Promise<AgentStatus>
  /**
   * Writes a bundle of expired-login diagnostics (TODO 1147) as one log line. It bundles the local records (the allowed fields of the last `auth status`, the last
   * expired-login row, the last API retry) with the attributes of the keychain item (macOS; the secret is not read). **No secret is written.**
   * The CLI is not called anew (the caller finishes `recheckLogin` first). An implementation without it may omit it.
   */
  recordAuthDiagnostics?(trigger: AuthDiagnosticsTrigger, context?: { readonly threadId?: string | null }): Promise<void>
  /**
   * The executable name for starting the interactive CLI in a terminal (TODO 908, "open in terminal" on the expired-login badge).
   * The name is held by the compat table (constraint 6). An implementation without it may omit it (treated as null).
   */
  terminalCommand?(): string | null
  /**
   * The one-line login to type in the terminal to recover from an expired login (TODO 960). The command and arguments are held by the compat table (constraint 6).
   * It is not run for API-key users (constraint 3), so `api-key`. An implementation without it may omit it (= not run).
   */
  loginCommand?():
    | { readonly kind: 'ok'; readonly command: string; readonly args: readonly string[] }
    | { readonly kind: 'api-key' }
  /**
   * TODO 1282: the words of the guidance for unattended / scheduled runs (the command that creates a long-lived token and the name
   * of the environment variable it is read from). Words for the screen only: nothing is run, read or stored. Optional (= no guidance).
   */
  unattendedLoginGuide?(): UnattendedLoginGuide | null
  /**
   * The selectable models (T5). Empty if there is no `model-select`. The id is opaque, and
   * only the Adapter and `compat/` know the real string (constraint 6).
   */
  listModels(): Promise<readonly ModelChoice[]>
  /**
   * Reads a saved model id (the thread row, the settings default) as an id in the current list
   * (item 91: an id from an earlier table becomes an alias. No migration). Even an id not in the list is
   * returned as is if there is no target to map to. An implementation without it may omit it (= no remapping).
   */
  canonicalModelId?(id: string): string
  /**
   * Maps the real model name the backend reported (the last reply of a transcript, etc.) to an id in the list
   * (item 140). null if it matches none in the list (the caller falls back to the settings default).
   * An implementation without it may omit it (= matches only by `canonicalModelId`).
   */
  modelIdForReported?(model: string): string | null
  /**
   * The model name the backend reported (full name or alias) -> the display name (TODO 403, the model column of the subagent list).
   * Written the same way as the option's `label`. null if it does not match. An implementation without it may omit it (= the reported name as is).
   */
  modelLabel?(model: string): string | null
  /**
   * Called when the contents of `listModels` (version display, effective levels) change (item 91).
   * The return value cancels the subscription. An implementation without it may omit it (= the list does not change).
   */
  onModelsChanged?(listener: () => void): () => void
  /**
   * Real model name -> the context window upper bound (item 60 / 4.5.2). The denominator of the pie chart.
   * Answered from a static table. An implementation without it may omit it (null = denominator unknown = hidden).
   * If the backend reports an upper bound in `result`, that takes priority.
   */
  contextWindow?(model: string): number | null
  /**
   * The list of usable commands (item 68 / 95, without the leading `/`). What was learned from the backend
   * right after the session started (including a record learned at the previous launch). null if unknown.
   * Notifies subscribers of `onModelsChanged` when it changes. An implementation without it may omit it.
   */
  knownCommands?(): readonly string[] | null
  /**
   * Finds what runs without confirmation in a cwd (the project's hooks / MCP servers) (item 123). The file rules are
   * backend-specific, so the Adapter holds them. `allowed` is the choke point (false for a path that hits an exclusion), and the Adapter
   * applies it to every file before `stat`. An implementation without it may omit it (= reports nothing).
   */
  locateProjectAutorun?(cwd: string, allowed: (path: string) => boolean): Promise<ProjectAutorunReport>
  /** **Branch by feature, not by version number** (4.6). */
  supports(feature: AgentFeature): boolean
  spawn(options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession>
  /**
   * At app quit, stops what the Adapter itself holds resident (such as the process of a server-type backend)
   * (TODO 529). Sessions were already stopped by `SessionManager.stop()` first with `AgentSession.stop()`.
   * An implementation without it may omit it (= holds nothing).
   */
  shutdown?(): Promise<void>
  /**
   * The real-run decision of the feature table (4.6 / item 81). Starts once in a form that uses all the dependent features,
   * and checks the feature table by whether it was accepted. **It does not make the model generate a reply, but it costs one
   * session startup**, so it is called only when `AgentStatus.needsProbe` is true
   * (SessionManager, once before the first send). Even on failure it does not throw, and returns `ok: false` and
   * the degradation reason. An implementation without it may omit it (= always trust the table values).
   */
  probe?(gateway: () => GatewayEndpoint, cwd: string): Promise<AgentProbeResult>
  /**
   * The backend's own update (TODO 774, ARCHITECTURE 4.6.6). Only the Adapter and
   * `compat/` know the subcommand names and how to read the output (constraint 6). An implementation without it may omit it (= no update).
   */
  readonly selfUpdate?: AgentSelfUpdate
  /** TODO 1066: the local model recommendation. An implementation without it may omit it (= not shown). */
  readonly localModels?: LocalModelAdvisor
  /** Read access to transcripts (null for a backend without one). */
  readonly transcripts: TranscriptStore | null
  /**
   * Extracts the target path of a write tool call (`Edit` / `Write`, etc.)
   * (item 97 second half, the draft-conflict notice). Tool names and the shape of arguments are backend-specific (constraint 6), so
   * the Adapter holds them. null for a read-only tool, a tool not in the table, or arguments from which no path can be taken.
   * **A relative path is returned as is** - making it absolute against the cwd is the caller's job.
   * An implementation without it may omit it (= no notification).
   */
  writeToolTargetPath?(toolName: string, input: unknown): string | null
  /**
   * Whether a permission request is a request to "run outside the sandbox" (TODO 1106, 4.2.4). If it comes from a process started with the sandbox enabled,
   * the approval inbox refuses without asking. Tool names and argument field names are backend-specific (constraint 6). An implementation without it may omit it (= false).
   */
  unsandboxedRequest?(toolName: string, input: unknown): boolean
  /**
   * Candidate directories of the working folder `cwd`'s notes (auto memory) (item 254). Only those that exist,
   * nearest first. They become the next candidates when a relative link in a reply (`memory/x.md`) could not be resolved against the cwd.
   * **It only lists places and does not read them** - whether they can be read is decided by the caller with `assertAllowed(…, 'read')`.
   * An implementation without it may omit it (= resolve by cwd only).
   */
  memoryDirs?(cwd: string): readonly string[]
  /**
   * Where the shell did `cd` in that conversation (TODO 816). Takes the saved tool calls (oldest first) and returns them newest first without duplicates
   * (excluding the cwd itself). They become the next candidates when a relative link in a reply could not be resolved against the cwd. **It only lists places and does not read them.**
   * Tool names and argument shapes are backend-specific (constraint 6). An implementation without it may omit it (= do not make cd destinations candidates).
   */
  shellDirs?(toolUses: readonly { readonly name: string; readonly input: JsonValue }[], cwd: string, home: string): readonly string[]
  /**
   * The contents of a write tool call's change (the diff in the approval frame of item 97). Only for tools
   * that have a `preview` in the table. null for arguments whose shape cannot be read or a tool not in the table (no diff is shown). Optional.
   */
  writePreview?(toolName: string, input: unknown): WritePreview | null
  /**
   * If this approval request is a "plan proposal", returns the plan's body (Markdown) (item 112 / 4.2.3). Even if the plan field
   * cannot be read, the empty string if it is a proposal tool (= the side that stops). null otherwise. Optional (= Plan cannot be used).
   */
  planProposal?(toolName: string, input: unknown): string | null
  /**
   * The sentence returned to the model on refusal (item 182 / 183). A copy of the refusal text the backend's interactive screen returns, so specific to it
   * (constraint 6). null if not in the table (the Broker's neutral sentence stays). Optional.
   */
  approvalReply?(reply: ApprovalReply): string | null
  /**
   * If this approval request is an **operation that goes outside**, returns its details (TODO 959, 4.2.1). The names of shell tools and the shape of MCP tool names are
   * backend-specific (constraint 6), so the Adapter holds the table (`outbound`). null otherwise. Optional (= no decision).
   */
  outboundAction?(toolName: string, input: unknown): OutboundDetail | null
  /**
   * If this approval request is a **write that would persist or take down a choke point**, returns the kind and the write target (TODO 1042, 4.2.1). The location of the CLI's settings and
   * the shape of a write tool's arguments are backend-specific (constraint 6), so the Adapter holds the table (`persistence`). The decision is in
   * `src/main/approval/persistence.ts`. `resolve` is the entry point that resolves a write tool's path to an absolute path and realpath (the caller resolves it against the working folder).
   * null otherwise. Optional (= no decision).
   */
  persistenceAction?(toolName: string, input: unknown, resolve?: (path: string) => readonly string[]): PersistenceDetail | null
  /**
   * If this tool call **reads a secret**, returns the kind of marker (`ssh-key` / `cloud-credentials` ...) (TODO 1043, 4.2.1). The names of reading tools, the
   * keys of path arguments, and the location of the CLI's credentials are backend-specific (constraint 6). The decision is in `src/main/approval/secrets.ts`. null otherwise. Optional.
   */
  secretReadAction?(toolName: string, input: unknown): string | null
  /** If this tool call is a **way out** (a web fetch, MCP, curl / ssh / git fetch ...), the name that matched (TODO 1043). null otherwise. Optional. */
  egressAction?(toolName: string, input: unknown): string | null
  /**
   * Builds the subject of the role grant table (TODO 983, 3. of 4.2.5): for the shell, the command; for read / write tools, the realpath; for a web fetch, the host;
   * otherwise, the tool's name. Tool names and argument keys are backend-specific (constraint 6), so the Adapter builds it from the table, and the decision is in
   * `src/main/approval/grants.ts`. `resolve` is the entry point that resolves a path against the conversation's working folder into a realpath (the caller makes it).
   * null if it cannot be built (the table is not consulted and no suggestion is made). Optional (= the role table is not used).
   */
  grantSubjectOf?(toolName: string, input: unknown, resolve?: (raw: string) => ResolvedGrantPath | null): GrantSubject | null
  /**
   * TODO 983 stage 2: whether the tool can be stated explicitly as read-only (the set is built only once when the table is read). Web fetch and search tools are not included.
   * It decides whether the `tool` row (per tool name) of the role grant table may take effect, and the manager asks **only that conversation's Adapter** (no OR).
   * Omitted means false (does not take effect).
   */
  isReadOnlyTool?(toolName: string): boolean
  /**
   * TODO 1216: whether it is a backend built-in tool that may be passed without asking in an unattended read-only turn (a trigger's first turn)
   * (reading and searching files, the work list, subagents). Tool names are backend-specific (constraint 6), so the table (`unattended`) holds them.
   * If omitted or false, the choke point refuses (the gateway's read tools and the extension tools with no side effects are passed on the choke point's side).
   */
  unattendedReadOnlyTool?(toolName: string, input: unknown): boolean
  /** Whether Plan mode can be used (the table has `planMode`). Omitted means false. */
  supportsPlanMode?(): boolean
  /**
   * Whether a new conversation can be started inside a worktree (`SpawnOptions.worktreeName` can be applied at launch). Bundle conversations
   * (`startBundles`, TODO 633 stage 3 / 1122) are made only for a backend where this is true. Omitted means false.
   */
  supportsWorktreeLaunch?(): boolean
  /**
   * Turns the results (oldest first) run with the prompt field's `!` into the text mixed in at the head of the next message
   * (item 116 / 4.5.7). The way of wrapping is a copy of the backend's bash mode and so specific (constraint 6), so
   * the Adapter holds it. An implementation without it may omit it (= SessionManager's neutral form).
   */
  formatShellContext?(runs: readonly ShellRunPayload[]): string
  /** The output limit and timeout of `!` (the same values as the Bash tool). May be omitted (= defaults). */
  shellLimits?(): ShellLimits
  /**
   * Whether this message starts a turn that is "split into bundles and run in worktree children" (TODO 700, the built-in `/batch`, etc.).
   * Command names are backend-specific (constraint 6), so the Adapter holds them. May be omitted (= there is no such turn).
   */
  startsParallelRun?(text: string): boolean
}
