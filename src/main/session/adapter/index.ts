/**
 * `ClaudeCodeAdapter` - the only module that touches the CLI (ARCHITECTURE.md 4.6, constraints 1 / 6).
 *
 * What is upheld:
 * - Starts the CLI the user installed **as is** as a child process.
 *   It is neither bundled nor modified (constraint 1). The Agent SDK is not used.
 * - Does not touch the credentials directory. The login state is checked only with public subcommands (constraint 2).
 * - Does not branch on the authentication method (constraint 3). Values obtained are used only for display.
 * - Knowledge of flags, mode names and event formats does not leave this directory and `compat/` (constraint 6).
 *
 * Premises already measured in Phase 0 (not re-verified):
 * - `system/init` does not appear until the first input line is received (spike 1).
 * - The exit code is 0 even on SIGINT (spike 1). Abnormal termination is judged by "whether the completion event was received".
 * - With `--resume`, session_id does not change (spike 1).
 * - `--permission-mode manual` comes back as `default` in init (spike 9a).
 * - `--help` is cut at 8192 B when read through a pipe (spike 6). **Do not read `--help`.**
 * - `--version` and auth status are under 8 KB, so a pipe is safe.
 *   Even when logged out (exit 1), stdout is correct JSON (spike 12).
 */
import { spawn as spawnProcess } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type {
  AgentDegradation,
  AgentFeature,
  AgentFeatureMap,
  AgentStatus,
  AiosEvent,
  McpServerReport,
  McpServerState,
  ModelChoice,
  ShellRunPayload,
  ThinkingLevel
} from '@shared/agent.js'
import type { GrantSubject, OutboundDetail, PersistenceDetail, SwitchRestart } from '@shared/thread.js'
import { AGENT_FEATURES } from '@shared/agent.js'
import { formatReason, parseReason, reasonError } from '@shared/reason.js'
import { log } from '../../../common/logger.js'
import type {
  AgentAdapter,
  AuthDiagnosticsTrigger,
  AgentContextUsage,
  AgentInput,
  AgentProbeResult,
  AgentSelfUpdate,
  AgentSession,
  GatewayEndpoint,
  ProjectAutorunReport,
  RewindFilesResult,
  ShellLimits,
  SpawnHandlers,
  SpawnOptions,
  TranscriptStore,
  WritePreview
} from '../types.js'
import { TranscriptReader } from './transcript.js'
import { locateProjectAutorun as locateProjectAutorunIn } from './project-autorun.js'
import {
  approveToolName,
  gatewayInstructions,
  gmailDraftFontInstruction,
  featuresForVersion,
  flag,
  flagList,
  loadBackendPaths,
  loadCompatTable,
  parseVersion,
  thinkingArgs,
  thinkingEntry,
  versionAtLeast,
  type CompatTable,
  type McpStatusVocabulary
} from './compat.js'
import { parseEventWithRaw, reportedCommandsChanged, type ParseContext } from './parse.js'
import { isAuthFailureLine, isAuthFailureText } from './auth-failure.js'
import {
  buildAuthDiagnostics,
  readKeychainMeta,
  snapshotOfApiRetry,
  snapshotOfAuthLine,
  snapshotOfAuthResult,
  snapshotOfAuthStatus,
  type ApiRetrySnapshot,
  type AuthErrorSnapshot,
  type AuthProbeSnapshot,
  type KeychainMeta
} from './auth-diagnostics.js'
import { WorktreeWatch, startsParallelCommand } from './worktree.js'
import { adjustCommands } from './builtins.js'
import { writeToolTargetPath as writeToolTargetPathFor } from './progress.js'
import { memoryDirsFor } from './memory.js'
import { shellDirsOf, type StoredToolUse } from './shell-dirs.js'
import { planProposalOf, writePreviewOf } from './write-preview.js'
import { formatApprovalReply } from '../../approval/replies.js'
import type { ApprovalReply } from '../../approval/reply.js'
import { classifyOutbound } from '../../approval/outbound.js'
import { classifyPersistence } from '../../approval/persistence.js'
import { classifyEgress, classifySecretRead, type SecretTable } from '../../approval/secrets.js'
import { grantSubjectFor, type ResolvedGrantPath } from '../../approval/grants.js'
import { formatShellContext, shellLimitsOf } from './shell-context.js'
import { controlRequestLine, readControlResponse, type ControlResponse } from './control.js'
import { readContextUsage } from './context-usage.js'
import { CliSelfUpdate } from './self-update.js'
import { runCapture } from './run-capture.js'
import { isSandboxUnavailableText, isUnsandboxedRequest, sandboxLaunch, type SandboxLaunch } from './os-sandbox.js'
import {
  buildModelView,
  canonicalModelId,
  contextWindowOverride,
  learnFromInitialize,
  modelIdForReported,
  parseCachedCatalog,
  parseCachedCommands,
  parseLearned,
  parseReportedCommands,
  parseReportedModels,
  parseUnavailableModels,
  pinnedFromInitialize,
  pinnedResolved,
  reportedModelLabel,
  sameCatalog,
  sameLearned,
  serializeLearned,
  type LearnedModel,
  type ModelCatalog,
  type ModelView
} from './models.js'

/** Wait time for the version / auth fetch at startup. Both return in 200-700 ms (spike 12). */
/** Upper bound (in characters) of stderr kept for diagnostics. */
const STDERR_TAIL_MAX = 16 * 1024
const PROBE_TIMEOUT_MS = 15_000
/** How long the probe waits for init. Allows for the gateway's 1.35 s startup + the CLI's 0.7 s startup (spike 10). */
const INIT_TIMEOUT_MS = 30_000
/** The permission mode to use. Made explicit so behavior is consistent and does not depend on user settings (4.2). */
const PERMISSION_MODE_KEY = 'manual'
/**
 * Upper bound on waiting for a control request's response (items 91 / 94). In spike 16 initialize took about 0.6 s, and in spike 15b
 * interrupt took 1 ms. If it does not come, give up with null (the caller falls back to a passive means).
 */
const CONTROL_TIMEOUT_MS = 15_000
/**
 * The gap, after the login state re-check (TODO 893) finishes, before a public subcommand is started again. Calls within a shorter
 * gap return the local state (so that it is not started N times when many threads are stopped and the badge and window raise overlap).
 */
const LOGIN_RECHECK_THROTTLE_MS = 2_000

/**
 * Where the feature table and what was learned about models are kept (so that probe / initialize need not run every time).
 * `readModels` / `writeModels` were added in item 91. The contents are JSON whose shape only the adapter knows, and
 * it is kept under a single key (`backend.<id>.models`, `src/common/settings-keys.ts`).
 */
export interface AdapterCache {
  read(version: string): AgentFeatureMap | null
  write(version: string, features: AgentFeatureMap): void
  readModels?(backendId: string): string | null
  writeModels?(backendId: string, json: string): void
}

/**
 * Whether the auth method is of the API key kind (TODO 960). **True only when it is certain to be an API key (or a cloud provider where login does not apply).**
 * An unknown value, a value containing `token` (a subscription OAuth token such as `oauth_token` is also possible) and `none` are false = treated as a subscription and
 * leaning toward running login (TODO 960 review). Refusing by mistake would leave subscription users unable to recover (harm close to constraint 3's "do not restrict the
 * authentication method"), but running it by mistake only opens one Terminal that API key users can close.
 */
export function isApiKeyAuthMethod(method: string | null): boolean {
  return method !== null && /api[\s_-]?key|bedrock|vertex|foundry/i.test(method)
}

interface AuthStatus {
  readonly loggedIn: boolean
  readonly authMethod: string | null
  readonly subscriptionType: string | null
  /** Item 317: shown in "Account and usage" of the settings screen. null if it cannot be obtained. */
  readonly email: string | null
}

/** Upper bound for capturing public subcommands (`--version` / `auth status --json`) (`run-capture.ts`). */
const PROBE_CAPTURE = { timeoutMs: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 } as const

export class ClaudeCodeAdapter implements AgentAdapter {
  /**
   * Reading transcripts (12.7). **Read-only**, and does not touch credentials (constraint 2).
   */
  readonly transcripts: TranscriptStore = new TranscriptReader()

  private readonly table: CompatTable
  /** The set for `isReadOnlyTool`. Built once when the table is read and remembered (not built on every approval request). */
  private readOnlySet: ReadonlySet<string> | null = null
  private status: AgentStatus | null = null
  private inFlight: Promise<AgentStatus> | null = null
  /** A login-state-only re-check in progress (TODO 893). Overlapping calls wait on this. */
  private loginRecheck: Promise<AgentStatus> | null = null
  /** The time (ms) the last login state re-check finished. Not called again within `LOGIN_RECHECK_THROTTLE_MS`. */
  private loginCheckedAt = 0
  /**
   * The last known auth method (TODO 960). `auth status` while logged out returns the method as `none`, so to identify API key users
   * **only the method of a logged-in response** is kept.
   */
  private lastAuthMethod: string | null = null
  /**
   * Versions for which a probe was tried during this run (item 81). **Not tried twice even if it failed** -
   * each attempt costs a session start, and the cause of the failure (an unknown flag) is not
   * fixed by retrying. Only the settings screen's "re-detect" (`getStatus(true)`) makes it forget.
   */
  private readonly probeAttempted = new Set<string>()
  /**
   * Alias -> the full name taught by the CLI and how effort works (items 91 / 92). Overwritten by the
   * response to `initialize` at session start and the `model` of `system/init`, and left in the cache so that the
   * next launch shows the version from the start. **Full names do not leave here** (`listModels` drops them).
   */
  private learned: Map<string, LearnedModel>
  /**
   * The list of usable commands (items 68 / 95). Learned from `commands` in the `initialize` response, and kept
   * in the same record as `learned` - on the next launch, it can be used for the decision on new threads
   * even before any session has started. null if unknown.
   */
  private commands: readonly string[] | null
  /**
   * The lower part of the choices (TODO 769): version-pinned models and models that cannot be used in the current version. Replaced wholesale from the
   * `initialize` response, and left in the same record as `learned`.
   */
  private catalog: ModelCatalog
  /**
   * Values derived from `learned` + `catalog` (level replacements, choices, pinned-version ids, wave 82 review Y-6). Rebuilt only where these two
   * are replaced (the constructor and `learn`) - `contextWindow` is called on every usage update.
   */
  private view: ModelView
  private readonly modelListeners = new Set<() => void>()
  /** The registry (4.6.1) key. Taken from the compat table together with the display name (constraint 6). */
  readonly id: string
  readonly label: string
  /** The CLI's own update (TODO 774, 4.6.6). Not held if the table has no `selfUpdate`. */
  readonly selfUpdate?: AgentSelfUpdate
  /**
   * Snapshots for the auth-expiry diagnostics bundle (TODO 1147). The last `auth status --json` (permitted fields only), the last auth-expired line (only the body's length), and the
   * last API retry. All are in memory only, and `recordAuthDiagnostics` bundles them into one log line.
   */
  private lastAuthProbe: AuthProbeSnapshot | null = null
  private lastAuthError: AuthErrorSnapshot | null = null
  private lastApiRetry: ApiRetrySnapshot | null = null
  /** The entry point that reads a keychain item's attributes (TODO 1147). Replaced by tests. */
  keychainReader: () => Promise<KeychainMeta> = () => readKeychainMeta(this.table)

  constructor(
    /** The cache for the feature table and what was learned about models. */
    private readonly cache: AdapterCache = { read: () => null, write: () => {} }
  ) {
    this.table = loadCompatTable()
    this.id = this.table.backend.id
    this.label = this.table.backend.label
    if (this.table.selfUpdate !== undefined) this.selfUpdate = new CliSelfUpdate(this.table, this.table.selfUpdate)
    let raw: string | null = null
    try {
      raw = cache.readModels?.(this.id) ?? null
    } catch (err) {
      log.warn('agent.models.cacheReadFailed', { message: (err as Error).message })
    }
    this.learned = parseLearned(this.table, raw)
    this.commands = parseCachedCommands(raw)
    this.catalog = parseCachedCatalog(raw)
    this.view = buildModelView(this.table, this.learned, this.catalog)
  }

  /** The learned list of commands (items 68 / 95). null if unknown. */
  knownCommands(): readonly string[] | null {
    // The list as reported is kept in the record, and corrected with the works / does-not-work table when handed out (item 117).
    return adjustCommands(this.table, this.commands)
  }

  supports(feature: AgentFeature): boolean {
    return this.status?.features[feature] ?? false
  }

  /**
   * The model list (T5 / items 91 / 92). The choices (four aliases and their order) come from the `compat/` table, and
   * the version and the effective thinking levels from what the CLI taught (`learned`). Before learning, only names.
   * An invalid id does not fail at launch; the first turn's `result` becomes an error.
   */
  async listModels(): Promise<readonly ModelChoice[]> {
    const status = await this.getStatus()
    if (!status.features['model-select']) return []
    // Full names, limits and the CLI's vocabulary are not exposed to the renderer (constraint 6).
    return this.view.choices
  }

  /** Maps an id from an earlier table to the current alias (item 91, no migration). */
  canonicalModelId(id: string): string {
    // TODO 769: the value of a version-pinned model is not remapped. The old id in `legacyIds` (`claude-haiku-4-5-20251001`) is
    // now also "Haiku 4.5" in the lower part, and remapping would turn it into the alias haiku (= Haiku 5.5).
    if (this.isPinnedValue(id)) return id
    return canonicalModelId(this.table, id)
  }

  /**
   * Whether this is the value of a version-pinned choice (TODO 769). Wave 82 review Y-1: not only the rows in the lower part, but also the CLI's default version that fell out of the levels
   * (displaced) and the `sameAs` choices - all are version-pinned values selectable with the dropdown arrow, and remapping them to an alias would run on a newer version.
   */
  private isPinnedValue(id: string): boolean {
    return this.view.fixed.has(id)
  }

  /**
   * The value to pass to `--model` / `set_model` (TODO 1204). In addition to remapping an earlier table's id (`canonicalModelId`), if the lower part has
   * **a newer version of the same family** as an upper-part alias, pass that version's value (the full name) - so the level badge and the actual model match.
   * The value of a version-pinned model is passed as is (not swapped even if a newer version appears). **The thread's row stays the alias** (`canonicalModelId`
   * keeps returning the alias), so when a newer version comes out, it follows that again.
   */
  cliModelValue(id: string): string {
    const canonical = this.canonicalModelId(id)
    return this.view.upgrades.get(canonical)?.value ?? canonical
  }

  /** Maps a reported full name to an alias (item 140). Looked up with the table and what the CLI taught. */
  modelIdForReported(model: string): string | null {
    return modelIdForReported(this.table, this.learned, model)
  }

  /** Reported model name -> display name (`Sonnet 5`, TODO 403). null if the table has no match. */
  modelLabel(model: string): string | null {
    return reportedModelLabel(this.table, this.learned, model)
  }

  /** When what was learned changes (a version became known or changed). A signal to re-fetch the choices. */
  onModelsChanged(listener: () => void): () => void {
    this.modelListeners.add(listener)
    return () => this.modelListeners.delete(listener)
  }

  /**
   * Actual model name -> context window upper bound (item 60). The key is the id passed to `--model`, or
   * the full name reported by init / responses (`reportedAs`, or a full name taught by the CLI).
   * null if not in the table (denominator unknown = hidden).
   */
  contextWindow(model: string): number | null {
    const bare = model.replace(/\[[^\]]*\]$/, '')
    // TODO 769: a per-full-name override takes priority (what an alias points to changes with the version - haiku is 4.5 = 200K, 5.5 = 1M).
    // For an alias id, look up with the learned full name; for the value of a version-pinned model, with that full name.
    const canonical = canonicalModelId(this.table, model)
    const resolved =
      // Wave 82 review Y-1: a version that fell out of the levels, and `sameAs` values, are also version-pinned (not remapped to an alias and looked up with a newer version's window).
      this.view.fixed.get(model) ??
      pinnedResolved(this.catalog, model) ??
      // TODO 1204: an alias whose level badge was swapped for a newer version is looked up with that version's full name.
      this.view.upgrades.get(canonical)?.resolved ??
      this.learned.get(canonical)?.resolved ??
      bare
    const override = contextWindowOverride(this.table, resolved)
    if (override !== null) return override
    for (const entry of this.table.models.list) {
      const learned = this.learned.get(entry.id)?.resolved
      if (
        entry.id === model ||
        entry.reportedAs?.includes(model) === true ||
        entry.reportedAs?.includes(bare) === true ||
        (learned !== undefined && (learned === model || learned === bare))
      ) {
        return entry.contextWindow ?? null
      }
    }
    return null
  }

  /**
   * Replaces what was learned. Does nothing if it is the same (no save, no notification).
   * The `initialize` response layers in all aliases, and init layers in one alias.
   */
  private learn(
    update: ReadonlyMap<string, LearnedModel>,
    /** Item 95: the command list from the `initialize` response. null means "not learned this time" (left as is). */
    commands: readonly string[] | null = null,
    /** TODO 769: the lower part of the choices from the `initialize` response. null means "not learned this time" (left as is). */
    catalog: ModelCatalog | null = null
  ): void {
    const next = new Map(this.learned)
    for (const [id, value] of update) next.set(id, value)
    const modelsChanged = !sameLearned(this.learned, next)
    const before = this.commands
    const commandsChanged =
      commands !== null &&
      (before === null || before.length !== commands.length || before.some((c, i) => c !== commands[i]))
    const catalogChanged = catalog !== null && !sameCatalog(this.catalog, catalog)
    if (!modelsChanged && !commandsChanged && !catalogChanged) return
    this.learned = next
    if (commandsChanged) this.commands = commands
    if (catalogChanged) this.catalog = catalog
    if (modelsChanged || catalogChanged) this.view = buildModelView(this.table, this.learned, this.catalog)
    log.info('agent.models.learned', {
      models: next.size,
      pinned: this.catalog.pinned.length,
      unavailable: this.catalog.unavailable.length,
      commands: this.commands?.length ?? null
    })
    // Write what was learned (models and commands) to the record only once, and notify subscribers.
    try {
      this.cache.writeModels?.(this.id, serializeLearned(this.learned, this.commands, this.catalog))
    } catch (err) {
      // Even if it cannot be written, it can be used in this run (the next launch just starts from names only).
      log.warn('agent.models.cacheWriteFailed', { message: (err as Error).message })
    }
    for (const listener of this.modelListeners) {
      try {
        listener()
      } catch (err) {
        log.warn('agent.models.listenerFailed', { message: (err as Error).message })
      }
    }
  }

  /**
   * Sends `initialize` at session start and learns the full names of selectable models and how effort works
   * (item 91 / spike 16). **It does not call the API.** It may be written before the user's input, and the ordering of lines is
   * kept by the write chain, so `send` may be called without waiting for this response. If no response comes
   * (an unsupported version, or a timeout), nothing is done - the passive route of learning from the `model` of `system/init` remains.
   */
  private async requestModelCatalog(session: LiveSession): Promise<void> {
    const reply = await session.writeControlRequest(this.table.control.initialize)
    if (reply === null || !reply.ok) {
      log.info('agent.models.initializeUnavailable', {
        sessionId: session.sessionId,
        reason: reply === null ? 'no-response' : 'error'
      })
      return
    }
    const reported = parseReportedModels(reply.response)
    const learned = learnFromInitialize(this.table, reported)
    // TODO 769: rows that are not aliases (version-pinned models) and models that cannot be used go to the lower part. What an alias points to is compared using the response this time
    // (`learned`) layered with the record (`this.learned`) (so that an old full name of an alias absent from the response is not shown in the lower part).
    const aliases = new Map(this.learned)
    for (const [id, value] of learned) aliases.set(id, value)
    const catalog: ModelCatalog = {
      pinned: pinnedFromInitialize(this.table, reported, aliases),
      unavailable: parseUnavailableModels(reply.response)
    }
    // The gap of item 68 (item 95): the same thing as the `system/init` list (spike 18) arrives before the first input.
    this.learn(learned, parseReportedCommands(reply.response), catalog)
  }

  /**
   * Remembers the full name reported by `system/init` in the row of the alias passed at launch (the passive route of item 91).
   * Even on a version where `initialize` cannot be used, at least the version of the alias used is known. If the full name is the same as before,
   * the effort information (from initialize) is kept, and if it changed (what the alias points to changed) it is discarded.
   */
  private learnFromInit(modelId: string | null, sent: string | null, resolved: string | null): void {
    if (modelId === null || resolved === null || resolved === '') return
    // TODO 769: a session started with a version-pinned model does not teach what the alias points to (so that a thread
    // started with Haiku 4.5 does not make the alias haiku be learned as Haiku 4.5).
    if (this.isPinnedValue(modelId)) return
    const id = canonicalModelId(this.table, modelId)
    if (!this.table.models.list.some((entry) => entry.id === id)) return
    // TODO 1204 / wave 82 review Y-3: only when **the alias itself** was passed to the CLI is init's full name what the alias points to. If the level badge was swapped
    // for a newer version and a full name was passed (`cliModelValue`), then regardless of the reported notation (with a date, with or without `[1m]`) it is not
    // what the alias points to - decide by the value actually passed, not by comparing names.
    if (sent !== id) return
    const before = this.learned.get(id)
    if (before?.resolved === resolved) return
    this.learn(new Map([[id, { resolved, supportsEffort: null, effortLevels: null }]]))
  }

  /** Item 123: things that run without confirmation in a first-time folder. Only searched for, following the table (`projectAutorun`). */
  locateProjectAutorun(cwd: string, allowed: (path: string) => boolean): Promise<ProjectAutorunReport> {
    return locateProjectAutorunIn(this.table.projectAutorun, cwd, allowed)
  }

  /** Item 254: the second candidate for relative links in answers (where auto memory is kept). Only lists locations. */
  memoryDirs(cwd: string): readonly string[] {
    return memoryDirsFor(cwd)
  }

  /** TODO 816: the next candidate for relative links in answers (where the shell did `cd` to). Only lists locations. */
  shellDirs(toolUses: readonly StoredToolUse[], cwd: string, home: string): readonly string[] {
    return shellDirsOf(toolUses, cwd, home)
  }

  /** Second half of item 97 (the draft conflict notice). Only looks up the table (`toolKinds.map[*].write`). */
  writeToolTargetPath(toolName: string, input: unknown): string | null {
    return writeToolTargetPathFor(this.table, toolName, input)
  }

  /** Item 97 (the approval frame diff). Only reads the table (`toolKinds.map[*].preview`) and the argument keys. */
  writePreview(toolName: string, input: unknown): WritePreview | null {
    return writePreviewOf(this.table, toolName, input)
  }

  /** Item 112. If it is a plan-presenting tool, the plan body (the table's `planMode`). */
  planProposal(toolName: string, input: unknown): string | null {
    return planProposalOf(this.table, toolName, input)
  }

  /** Items 182 / 183: the text returned to the model on rejection. The template is `approvalReplies` of the compat table. */
  approvalReply(reply: ApprovalReply): string | null {
    const table = this.table.approvalReplies
    return table === undefined ? null : formatApprovalReply(table, reply)
  }

  /**
   * TODO 1106: whether this is a request to run outside the sandbox (the table's `osSandbox.unsandboxedField`). The shell tool names are `outbound.shellTools`.
   * If it comes from a process started with the sandbox enabled, the approval inbox refuses without asking (it reaches approve even with `allowUnsandboxedCommands: false`, spike 37).
   */
  unsandboxedRequest(toolName: string, input: unknown): boolean {
    const table = this.table.osSandbox
    if (table === undefined) return false
    return isUnsandboxedRequest(table, this.table.outbound?.shellTools ?? [], toolName, input)
  }

  /** TODO 959: whether this is an outbound operation (the table's `outbound`). The decision is `src/main/approval/outbound.ts`. */
  outboundAction(toolName: string, input: unknown): OutboundDetail | null {
    const table = this.table.outbound
    return table === undefined ? null : classifyOutbound(table, toolName, input)
  }

  /** TODO 1043: whether the call reads secrets (the table's `secrets`, decided in `approval/secrets.ts`). */
  secretReadAction(toolName: string, input: unknown): string | null {
    const table = this.secretTable()
    return table === null ? null : (classifySecretRead(table, toolName, input)?.match ?? null)
  }

  /** TODO 1216: whether this is a built-in tool that may be let through without asking in an unattended read-only turn (the table's `unattended.readOnlyTools`). */
  unattendedReadOnlyTool(toolName: string): boolean {
    return this.table.unattended?.readOnlyTools.includes(toolName) === true
  }

  /**
   * TODO 983 stage 2: whether this is a tool that can be declared read-only (only the table's `unattended.readOnlyTools`). Web fetch and search tools are not included
   * (they send queries outside). It decides whether the `tool` rows of the role permission table may take effect, and **only that conversation's Adapter** is asked.
   */
  isReadOnlyTool(toolName: string): boolean {
    this.readOnlySet ??= new Set(this.table.unattended?.readOnlyTools ?? [])
    return this.readOnlySet.has(toolName)
  }

  /** TODO 1043: whether this is a route out (asked in a conversation that read secrets). */
  egressAction(toolName: string, input: unknown): string | null {
    const table = this.secretTable()
    return table === null ? null : classifyEgress(table, toolName, input)
  }

  /**
   * TODO 983: the subject of the role permission table (4.2.5 item 3). Shell tools are the table's `outbound.shellTools`; read tools, path keys and web fetch tools are
   * the table's `secrets` (the same keys as 1043); write tools are `toolKinds.map[*].write`. The decision is `approval/grants.ts`.
   */
  grantSubjectOf(toolName: string, input: unknown, resolve?: (raw: string) => ResolvedGrantPath | null): GrantSubject | null {
    const shell = this.table.outbound
    const secrets = this.table.secrets
    return grantSubjectFor(
      {
        shellTools: shell?.shellTools ?? [],
        commandField: shell?.commandField ?? 'command',
        readTools: secrets?.readTools ?? [],
        pathKeys: secrets?.pathKeys ?? [],
        fetchTools: secrets?.egressTools ?? [],
        urlField: 'url',
        // Tools known to be read-only (stage 2): the same set as `isReadOnlyTool` (the table's `unattended.readOnlyTools`).
        readOnlyTools: this.table.unattended?.readOnlyTools ?? [],
        writeTools: Object.entries(this.table.toolKinds.map)
          .filter(([, entry]) => entry?.write === true)
          .map(([name]) => name)
      },
      toolName,
      input,
      this.writeToolTargetPath(toolName, input),
      resolve
    )
  }

  private secretTable(): SecretTable | null {
    const secrets = this.table.secrets
    const shell = this.table.outbound
    if (secrets === undefined || shell === undefined) return null
    return {
      shellTools: shell.shellTools,
      commandField: shell.commandField,
      readTools: secrets.readTools,
      pathKeys: secrets.pathKeys,
      egressTools: secrets.egressTools,
      mcpPrefix: shell.mcpPrefix,
      ...(secrets.paths === undefined ? {} : { paths: secrets.paths })
    }
  }

  /** TODO 1042: whether the write would persist or bypass a choke point. The CLI's settings locations are the table's `persistence`; the decision is `approval/persistence.ts`. */
  persistenceAction(toolName: string, input: unknown, resolve?: (path: string) => readonly string[]): PersistenceDetail | null {
    const shell = this.table.outbound
    return classifyPersistence(
      {
        shellTools: shell?.shellTools ?? [],
        commandField: shell?.commandField ?? 'command',
        ...(this.table.persistence === undefined ? {} : { paths: this.table.persistence.paths })
      },
      toolName,
      input,
      this.writeToolTargetPath(toolName, input),
      resolve
    )
  }

  supportsPlanMode(): boolean {
    const plan = this.table.planMode
    return plan !== undefined && this.table.permissionModes[plan.permissionMode] !== undefined
  }

  /** TODO 1122: whether the table has the worktree flag for a bundle's conversation (the same condition as `worktreeName` of `spawn`). */
  supportsWorktreeLaunch(): boolean {
    return this.table.flags['worktree'] !== undefined
  }

  /** Item 116: wraps the result of `!` in the same shape as bash mode. The template is `shellInput` of the compat table. */
  formatShellContext(runs: readonly ShellRunPayload[]): string {
    return formatShellContext(this.table.shellInput, runs)
  }

  shellLimits(): ShellLimits {
    return shellLimitsOf(this.table.shellInput)
  }

  /** Whether the message starts a round that splits work into bundles and runs it in worktree children, such as `/batch` (TODO 700, `worktree.parallelCommands` of compat). */
  startsParallelRun(text: string): boolean {
    return startsParallelCommand(this.table.worktree?.parallelCommands ?? [], text)
  }

  async getVersion(): Promise<string | null> {
    const result = await runCapture(this.table.command, [flag(this.table, 'version')], PROBE_CAPTURE)
    return parseVersion(result.stdout)
  }

  async getStatus(force = false): Promise<AgentStatus> {
    if (!force && this.status !== null) return this.status
    if (this.inFlight !== null) return this.inFlight
    // "Re-detect" also forgets probe failures (the next send tries just once more).
    if (force) this.probeAttempted.clear()
    this.inFlight = this.detect().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async detect(): Promise<AgentStatus> {
    const checkedAt = Date.now()
    const versionResult = await runCapture(this.table.command, [flag(this.table, 'version')], PROBE_CAPTURE)
    const version = parseVersion(versionResult.stdout)

    if (version === null) {
      this.status = {
        available: false,
        version: null,
        loggedIn: false,
        authMethod: null,
        subscriptionType: null,
        features: emptyFeatures(),
        degradations: [],
        source: 'unavailable',
        needsProbe: false,
        checkedAt,
        message:
          versionResult.stderr.trim() ||
          'エージェント CLI が見つかりません。インストールして PATH を通してください',
        // **When `versionResult.stderr` is present, no code is attached**
        // (the diagnostic text itself should be shown, so `message` is used - TODO 66).
        messageCode: versionResult.stderr.trim() === '' ? 'agent-unavailable' : null
      }
      log.warn('agent.unavailable', { code: versionResult.code })
      return this.status
    }

    const auth = await this.readAuthStatus()
    const lookup = featuresForVersion(this.table, version)
    let features = lookup.features
    const source = lookup.source
    // With an unknown version, no cached result and not yet tried, a probe is needed (item 81).
    let needsProbe = false

    if (source === 'probe') {
      const cached = this.cache.read(version)
      if (cached !== null) features = cached
      else needsProbe = !this.probeAttempted.has(version)
    }

    const degradations: AgentDegradation[] = []
    if (!versionAtLeast(version, this.table.minVersion)) {
      for (const feature of AGENT_FEATURES) {
        degradations.push({
          feature,
          reason: `バージョンが古すぎます (必要: ${this.table.minVersion} 以上、検出: ${version})`,
          code: formatReason('agent-version-too-old', { minVersion: this.table.minVersion, version })
        })
      }
      features = emptyFeatures()
      // A version that is too old will not start, so there is no point in checking.
      needsProbe = false
    }
    this.status = {
      available: true,
      version,
      loggedIn: auth.loggedIn,
      authMethod: auth.authMethod,
      subscriptionType: auth.subscriptionType,
      email: auth.email,
      features,
      degradations,
      source,
      needsProbe,
      checkedAt,
      message: auth.loggedIn ? null : 'ログインしていません。ターミナルで CLI のログインを実行してください',
      messageCode: auth.loggedIn ? null : 'agent-not-logged-in'
    }
    log.info('agent.detected', {
      version,
      loggedIn: auth.loggedIn,
      source,
      needsProbe,
      degraded: degradations.length
    })
    return this.status
  }

  /**
   * Re-checks only the login state (TODO 893, the auth-expiry badge). Calls the public subcommand (`auth status --json`) once, and
   * replaces only `loggedIn` and the accompanying fields of the local state. Does not touch the version, feature table or probe. If detection has never
   * run, falls back to a normal detection. If the CLI is still not found, does nothing.
   */
  async recheckLogin(): Promise<AgentStatus> {
    if (this.inFlight !== null) return this.inFlight
    // Do not overlap (code-review): if a re-check is running, wait for it. If one finished a moment ago, return the local state
    // (so that the public subcommand is not started N times even when per-thread badges and window raising overlap).
    if (this.loginRecheck !== null) return this.loginRecheck
    if (this.status !== null && Date.now() - this.loginCheckedAt < LOGIN_RECHECK_THROTTLE_MS) return this.status
    this.loginRecheck = this.recheckLoginNow().finally(() => {
      this.loginRecheck = null
      this.loginCheckedAt = Date.now()
    })
    return this.loginRecheck
  }

  /**
   * Writes the auth-expiry diagnostics bundle (TODO 1147) as one log line (`agent.auth.diagnostics`). It does not call the CLI anew - it only bundles the snapshots (the permitted fields of the last
   * `auth status`, the last auth-expired line, the last API retry) and the attributes of the keychain item (macOS, without `-g`).
   * **No secrets are written** (the fields to bundle are chosen first, and `redactJson` is applied as well).
   */
  async recordAuthDiagnostics(
    trigger: AuthDiagnosticsTrigger,
    context: { readonly threadId?: string | null } = {}
  ): Promise<void> {
    let keychain: KeychainMeta
    try {
      keychain = await this.keychainReader()
    } catch {
      keychain = { state: 'error', service: null, modifiedAt: null, createdAt: null, exitCode: null }
    }
    const status = this.status
    log.warn(
      'agent.auth.diagnostics',
      buildAuthDiagnostics({
        trigger,
        threadId: context.threadId ?? null,
        now: Date.now(),
        version: status?.version ?? null,
        loggedIn: status?.available === true ? status.loggedIn : null,
        authProbe: this.lastAuthProbe,
        lastError: this.lastAuthError,
        lastRetry: this.lastApiRetry,
        keychain
      })
    )
  }

  /** The executable name used to start the interactive CLI in a terminal (TODO 908). */
  terminalCommand(): string | null {
    return this.table.command
  }

  /**
   * The one login line typed in the terminal to recover from an auth expiry (TODO 960). Only a public subcommand (`auth login`), and it does not
   * touch credentials (constraint 2). **It is not run for API key users** (constraint 3) - in that case `api-key`.
   */
  loginCommand():
    | { readonly kind: 'ok'; readonly command: string; readonly args: readonly string[] }
    | { readonly kind: 'api-key' } {
    // `authMethod` of the logged-out state is `none`, so it is not used - distinguish by the method recorded while logged in (TODO 960 review).
    const method = this.status?.loggedIn === true ? (this.status.authMethod ?? this.lastAuthMethod) : this.lastAuthMethod
    if (isApiKeyAuthMethod(method)) return { kind: 'api-key' }
    return { kind: 'ok', command: this.table.command, args: flagList(this.table, 'authLogin') }
  }

  private async recheckLoginNow(): Promise<AgentStatus> {
    const before = this.status
    if (before === null) return this.getStatus()
    if (!before.available) return before
    const auth = await this.readAuthStatus()
    // If detection was redone while waiting (after a re-detect or an update), that one is newer.
    const current = this.status ?? before
    if (current !== before) return current
    this.status = {
      ...current,
      loggedIn: auth.loggedIn,
      authMethod: auth.authMethod,
      subscriptionType: auth.subscriptionType,
      email: auth.email,
      checkedAt: Date.now(),
      message: auth.loggedIn ? null : 'ログインしていません。ターミナルで CLI のログインを実行してください',
      messageCode: auth.loggedIn ? null : 'agent-not-logged-in'
    }
    log.info('agent.login.rechecked', { loggedIn: auth.loggedIn, changed: auth.loggedIn !== before.loggedIn })
    return this.status
  }

  /**
   * Detection of the login state (chapter 2 / constraint 2).
   * **The credentials directory is not read.** Only the stdout of public subcommands is looked at.
   */
  private async readAuthStatus(): Promise<AuthStatus> {
    const result = await runCapture(this.table.command, flagList(this.table, 'authStatus'), PROBE_CAPTURE)
    // TODO 1147: a snapshot for the diagnostics bundle. Only permitted fields are kept (email, org and directory are dropped).
    this.lastAuthProbe = snapshotOfAuthStatus(this.table, result.stdout, result.code, Date.now())
    const parsedAuth = this.parseAuthStatus(result.stdout)
    // The record is updated only with the method from a logged-in response (a `none` while logged out must not erase the memory of an API key, TODO 960 review).
    if (parsedAuth.loggedIn && parsedAuth.authMethod !== null) this.lastAuthMethod = parsedAuth.authMethod
    return parsedAuth
  }

  private parseAuthStatus(stdout: string): AuthStatus {
    const result = { stdout }
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim())
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        return {
          loggedIn: record['loggedIn'] === true,
          authMethod: typeof record['authMethod'] === 'string' ? record['authMethod'] : null,
          subscriptionType:
            typeof record['subscriptionType'] === 'string' ? record['subscriptionType'] : null,
          // Item 317: a field of the public subcommand's output (the credentials file is not read, constraint 2).
          email: typeof record['email'] === 'string' && record['email'] !== '' ? record['email'] : null
        }
      }
    } catch {
      // If the format changed. Treat it as login unknown, and do not block startup itself.
    }
    return { loggedIn: false, authMethod: null, subscriptionType: null, email: null }
  }

  /**
   * Safe probe for unknown versions (4.6).
   *
   * Starts with all the flags it depends on, **sends one input line**, and checks
   * whether `system/init` arrives (init does not appear until input is received - spike 1).
   * If any flag is unsupported the CLI exits at startup, so init arriving means
   * "the whole set of flags passed was accepted".
   *
   * It stops immediately once init arrives, so the model's response is not generated
   * (keeping subscription usage to a minimum. The cache creation for the session start cannot be avoided).
   *
   * In the app, SessionManager calls it before the first send, only when `needsProbe` (item 81).
   * The result is reflected in `this.status`, and written to the cache on success. **Even on failure the feature table stays
   * the provisional values** (setting everything to false would make structured-io false too, and
   * startup itself would become impossible), and the reason is added to `degradations`.
   */
  async probe(gatewayFactory: () => GatewayEndpoint, cwd: string): Promise<AgentProbeResult> {
    const status = await this.getStatus()
    if (!status.available || status.version === null) return { ok: false, status }
    // A version that is too old does not start (detect has turned off every feature). There is no point in checking.
    if (!versionAtLeast(status.version, this.table.minVersion)) return { ok: false, status }
    this.probeAttempted.add(status.version)

    const options: SpawnOptions = {
      // **Pass the UUID itself.** One with a prefix such as `probe-<uuid>` is rejected immediately with
      // "Invalid session ID. Must be a valid UUID.",
      // which produced the wrong result "no init" = every feature false (measured on 2026-09-21).
      sessionId: randomUUID(),
      threadId: 'probe',
      cwd,
      allowedDirs: [],
      resumeBackendSessionId: null,
      // Also checks whether the model / thinking flags are accepted (T5). init arrives before the API call,
      // so the probe's cost does not change whichever model is specified.
      modelId: this.table.models.probe,
      thinking: this.table.thinkingLevels.probe,
      gateway: gatewayFactory()
    }

    const started = Date.now()
    // The probe starts with **all the dependent flags** and decides by whether init arrived (with an unknown flag
    // the CLI exits immediately - a fact from Phase 2). Items 109 / 110 stopped passing `--setting-sources` and
    // `--strict-mcp-config`, so the set of flags to check is exactly what buildArgs builds.
    const probeFeatures: AgentFeatureMap = status.features

    let result = await this.probeOnce(options, probeFeatures)
    let used = probeFeatures
    // If it failed with an optional feature (model / thinking) attached, remove it and try **just one more time**.
    // Making everything false on a single failure would make startup itself impossible (even structured-io would
    // become false). It costs one extra session start.
    if (
      result.init === null &&
      (probeFeatures['model-select'] || probeFeatures['thinking-level'])
    ) {
      log.warn('agent.probe.retry', { ms: Date.now() - started, without: 'model/thinking' })
      used = { ...probeFeatures, 'model-select': false, 'thinking-level': false }
      // Use a different session ID from the first attempt (do not start twice with the same ID).
      result = await this.probeOnce({ ...options, sessionId: randomUUID() }, used)
    }

    // If the state was replaced by "re-detect" during the probe, layer on top of it.
    const base = this.status ?? status
    if (result.init !== null && result.init.kind === 'session_started') {
      // Startup succeeded = **the set of flags passed** was accepted. Do not make features that were not passed true:
      // it used to set every feature true and then override some, so even subagent-text, which is
      // assumed false (a flag that does not exist), became true, and the next spawn failed with
      // `unknown option` (noticed when wiring up item 81).
      const servers = result.init.payload.toolServers
      const mcp = used['mcp-config'] && servers.includes(this.table.mcp.serverName)
      const features: AgentFeatureMap = {
        ...used,
        // Whether the gateway connected can be confirmed by the server names init lists. The user's servers
        // may be mixed in (item 110: strict was dropped).
        'mcp-config': mcp
      }
      try {
        this.cache.write(status.version, features)
      } catch (err) {
        // Even if it cannot be written, the result is used in this run (the next launch just probes once more).
        log.warn('agent.probe.cacheWriteFailed', { message: (err as Error).message })
      }
      this.status = {
        ...base,
        features,
        degradations: [],
        needsProbe: false
      }
      log.info('agent.probe.ok', { ms: Date.now() - started, servers: servers.length })
      return { ok: true, status: this.status }
    }

    const reason = result.error ?? '?'
    log.warn('agent.probe.failed', { ms: Date.now() - started, reason })
    this.status = {
      ...base,
      needsProbe: false,
      degradations: [
        ...base.degradations,
        {
          feature: 'structured-io',
          reason: `probe で起動を確かめられませんでした (${reason})。仮の機能表のまま起動します`,
          // The diagnostic text (`reason`) is the CLI's raw failure reason (the tail of stderr etc., English technical terms), and is carried as an
          // inserted value without translation. TODO 66 left only a Japanese sentence with `code: null`, but
          // the Japanese sentence also appeared in EN (TODO 519). `reason` is the same value that is also put in the log above (not the body).
          code: formatReason('agent-probe-failed', { detail: reason })
        }
      ]
    }
    return { ok: false, status: this.status }
  }

  /**
   * One probe: start, send one line, and wait for init to arrive or the process to exit.
   *
   * **Whatever path it ends by, stop the CLI and clear the timer** (item 81). It used to stop only when
   * init arrived and did not clear the 30-second timer either, so a CLI that stayed alive without emitting init
   * became an orphan, and the timer held the event loop for 30 seconds.
   */
  private probeOnce(
    options: SpawnOptions,
    probeFeatures: AgentFeatureMap
  ): Promise<{ init: AiosEvent | null; error: string | null }> {
    return new Promise<{ init: AiosEvent | null; error: string | null }>((resolve) => {
      let settled = false
      let session: AgentSession | undefined
      let lastError: string | null = null
      const timer = setTimeout(() => finish(null, 'timeout'), INIT_TIMEOUT_MS)
      const finish = (init: AiosEvent | null, error: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Do nothing if it has already exited (`stop` looks at `exited`).
        void session?.stop()
        resolve({ init, error })
      }
      this.launch(options, (feature) => probeFeatures[feature], {
        onEvent: (event) => {
          if (event.kind === 'session_started') finish(event, null)
          // Pick up the reason the launch failed (the tail of stderr) so it can be left in the log.
          // For a reason code (an ending with no stderr, TODO 519), take off the wrapper and keep only the code name (so `aios-reason:` is not mixed into the diagnostic text).
          if (event.kind === 'error') lastError = parseReason(event.payload.message)?.code ?? event.payload.message
        },
        onExit: (exit) => {
          finish(null, exit.sawResult ? null : `exited before init: ${lastError ?? '?'}`)
        }
      })
        .then((s) => {
          session = s
          // If it ended before the launch resolved (timeout / instant death), stop it here.
          if (settled) {
            void s.stop()
            return
          }
          // The probe is a throwaway launch that only waits for init. It does not wait for connectors to connect (TODO 869).
          s.skipConnectorWait()
          s.send({ text: 'probe' })
        })
        .catch((err: unknown) => finish(null, (err as Error).message))
    })
  }

  async spawn(options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> {
    const session = await this.launch(options, (feature) => this.supports(feature), handlers, {
      // Wave 82 review Y-3: by the id the session has in effect at the first init, and the value actually passed to the CLI.
      onInit: (model, modelId, sent) => this.learnFromInit(modelId, sent, model),
      // The rest of item 117: the list changed while running (`/reload-plugins`, etc.). Replaces the record
      // taught by `initialize` (`commands` of `backend.<id>.models`), and the next launch uses the new list from the start.
      // The record keeps it as reported (before correction with the table) - the same as the `initialize` response (correction is done in `knownCommands`).
      onCommandsChanged: (commands) => this.learn(new Map(), commands),
      // TODO 1147: a snapshot for the diagnostics bundle (does not hold the body).
      onAuthError: (snapshot) => {
        this.lastAuthError = snapshot
      },
      onApiRetry: (snapshot) => {
        this.lastApiRetry = snapshot
      }
    })
    // Learn the version and effective levels (items 91 / 92). Do not wait - sending may proceed regardless of the response.
    void this.requestModelCatalog(session)
    return session
  }

  /**
   * The actual launch. `supports` can be replaced for the probe (it tries with every flag attached).
   * The probe does not pass `hooks` (it only stops at init and does not remember model information).
   */
  private async launch(
    options: SpawnOptions,
    supports: (feature: AgentFeature) => boolean,
    handlers: SpawnHandlers,
    hooks: SessionHooks = {}
  ): Promise<LiveSession> {
    const table = this.table
    // TODO 1106: if a sandbox was requested but cannot be passed (no feature, or no shape in the table), do not start - never run without the sandbox.
    // The caller (`LiveLifecycle.startLive`) also refuses first, but this is the last entry point.
    const sandbox = this.sandboxFor(options, supports)
    if (options.osSandbox !== undefined && options.osSandbox !== null && sandbox === null) {
      throw reasonError('os-sandbox-blocked')
    }
    // TODO 1216 (fix X): if an unattended read-only run was requested but the allow-list flags cannot be built (no table or flag), do not start
    // - never run an unattended turn with the usual default and no flags. The same for a version with no gateway (`mcp-config`) (MCP cannot be narrowed to the gateway only).
    if (options.readOnly === true && (unattendedLaunchArgs(table) === null || !supports('mcp-config'))) {
      throw new Error('unattended read-only launch is not available for this backend version')
    }
    const configPath = this.writeGatewayConfig(options)
    const args = this.buildArgs(options, configPath, supports, sandbox)
    const sessionHandlers = sandbox === null ? handlers : this.watchSandboxStart(handlers)

    log.info('agent.spawn', {
      sessionId: options.sessionId,
      threadId: options.threadId,
      cwd: options.cwd,
      allowedDirs: options.allowedDirs.length,
      resume: options.resumeBackendSessionId !== null,
      model: options.modelId !== null,
      thinking: options.thinking,
      plan: options.planMode === true,
      // TODO 1106: only the count of allow-table entries passed (the contents are not put in the log).
      ...(sandbox === null
        ? {}
        : {
            sandbox: true,
            sandboxDomains: options.osSandbox?.allowedDomains.length ?? 0,
            sandboxReadOnlyDirs: sandbox.denyWrite.length,
            sandboxAddDirs: sandbox.addDirs.length
          })
    })

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess(table.command, args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // The environment is passed as is. It does not interfere with the user's CLI settings (constraints 1 / 2).
        // A leaked ELECTRON_RUN_AS_NODE changes the child process's behavior, so it is removed.
        env: withoutRunAsNode(process.env)
      })
    } catch (err) {
      rmSync(configPath, { force: true })
      throw err
    }

    return new LiveSession(
      child,
      options,
      sessionHandlers,
      configPath,
      table,
      hooks,
      supports('live-settings'),
      supports('rewind'),
      // TODO 769: even for switching while running (`set_model`), the value of a version-pinned model is not remapped.
      // TODO 1204: an alias whose level badge was swapped for a newer version is passed with that version's value.
      (id) => this.cliModelValue(id),
      // Wave 82 review Y-2: the value passed to `--model` (the same computation as `buildArgs`. It is synchronous, so the same value).
      supports('model-select') && options.modelId !== null ? this.cliModelValue(options.modelId) : null,
      // Wave 82 review Y-4: the effort values that may be passed with `effortLevel` while running (the version floor is in compat's table).
      (value) => this.liveEffortAccepted(value)
    )
  }

  /**
   * Whether this effort value may be passed to switching while running (`effortLevel` of `apply_flag_settings`) (wave 82 review Y-4).
   * The table (`control.switchSettings.liveEffortSince`) holds, per value, the minimum version confirmed to accept it. If the value is not in the table, the version is unknown, or
   * the version is older than the floor, false - the caller restarts with the launch flag (`--effort`). If the table has no floor, true as before.
   */
  private liveEffortAccepted(value: string): boolean {
    const since = this.table.control.switchSettings?.liveEffortSince
    if (since === undefined) return true
    const min = (since as Readonly<Record<string, unknown>>)[value]
    const version = this.status?.version ?? null
    return typeof min === 'string' && version !== null && versionAtLeast(version, min)
  }

  /**
   * Writes the settings that pass exactly one gateway (7.6).
   *
   * - The token is **put in the file's env, not in arguments**. argv can be
   *   read by other processes with `ps`, while on macOS env is not visible to anyone but the owner. The file is 0600.
   * - `ELECTRON_RUN_AS_NODE=1` starts the Electron binary as Node (spike 10).
   * - Makes the per-server `timeout` (TODO 632, 7.6.5) long, so that the CLI's MCP idle timeout (default 30 minutes) does not
   *   cut off an `approve` that is waiting for approval (spike 29: the idle period is also extended to this value).
   */
  private writeGatewayConfig(options: SpawnOptions): string {
    const dir = options.gateway.configDir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${options.sessionId}.json`)
    const config = {
      mcpServers: {
        [this.table.mcp.serverName]: {
          type: 'stdio',
          command: options.gateway.runtimePath,
          args: [options.gateway.scriptPath],
          ...gatewayTimeout(this.table),
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            AIOS_SOCKET: options.gateway.socketPath,
            AIOS_TOKEN: options.gateway.token,
            AIOS_SESSION: options.sessionId
          }
        }
      }
    }
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
    return file
  }

  /**
   * Builds the launch that enables the sandbox (TODO 1106). null if not requested, there is no feature, or the table has no shape or flag.
   */
  private sandboxFor(options: SpawnOptions, supports: (feature: AgentFeature) => boolean): SandboxLaunch | null {
    const policy = options.osSandbox
    const table = this.table.osSandbox
    if (policy === undefined || policy === null || table === undefined) return null
    if (!supports('os-sandbox') || typeof this.table.flags['settings'] !== 'string') return null
    return sandboxLaunch(table, policy, options.cwd, supports('extra-dirs') ? options.allowedDirs : [], homedir())
  }

  /**
   * If a launch with the sandbox enabled ended before init and the diagnostic says "the sandbox cannot start in this environment" (`failIfUnavailable: true`),
   * removes the feature and shows the reason (TODO 1106). For the rest of that run, threads with the sandbox ON are not started (`os-sandbox-blocked`).
   * "Re-detect" (`getStatus(true)`) returns it to the version table's value (it tries just once more).
   */
  private watchSandboxStart(handlers: SpawnHandlers): SpawnHandlers {
    let started = false
    let lastError: string | null = null
    return {
      ...handlers,
      onEvent: (event) => {
        if (event.kind === 'session_started') started = true
        if (event.kind === 'error') lastError = event.payload.message
        handlers.onEvent(event)
      },
      onExit: (exit) => {
        const table = this.table.osSandbox
        // If the diagnostic is long, the "cannot start" sentence falls outside the last 500 characters - also look at the whole of stderr (16 KB).
        const text = `${lastError ?? ''}\n${exit.stderr ?? ''}`
        if (!started && !exit.requested && table !== undefined && isSandboxUnavailableText(table, text)) {
          this.markSandboxUnavailable(lastError ?? exit.stderr ?? '')
        }
        handlers.onExit(exit)
      }
    }
  }

  private markSandboxUnavailable(detail: string): void {
    const status = this.status
    if (status === null || !status.features['os-sandbox']) return
    // The diagnostic text is the CLI's raw text (English technical terms). It is carried as an inserted value without translation (the same as agent-probe-failed). The length is truncated.
    const short = detail.replace(/\s+/g, ' ').trim().slice(0, 200)
    this.status = {
      ...status,
      features: { ...status.features, 'os-sandbox': false },
      degradations: [
        ...status.degradations.filter((entry) => entry.feature !== 'os-sandbox'),
        {
          feature: 'os-sandbox',
          reason: `この環境では OS の sandbox を起動できませんでした (${short})`,
          code: formatReason('os-sandbox-failed', { detail: short })
        }
      ]
    }
    log.warn('agent.sandbox.unavailable', { version: status.version })
    for (const listener of this.modelListeners) listener()
  }

  /** Builds the flags. **Only this knows the flags** (4.6). */
  private buildArgs(
    options: SpawnOptions,
    configPath: string,
    supports: (feature: AgentFeature) => boolean,
    sandbox: SandboxLaunch | null = null
  ): string[] {
    const t = this.table
    const args: string[] = [
      flag(t, 'print'),
      flag(t, 'inputFormat'),
      flag(t, 'streamFormat'),
      flag(t, 'outputFormat'),
      flag(t, 'streamFormat'),
      flag(t, 'verbose')
    ]

    // Required for the incremental rendering of 5.1. Without it not a single partial event arrives (spike 8).
    if (supports('partial-messages')) args.push(flag(t, 'partialMessages'))

    if (options.resumeBackendSessionId !== null && supports('resume')) {
      // With --resume, session_id does not change (spike 1). No row is added.
      args.push(flag(t, 'resume'), options.resumeBackendSessionId)
      // Rewind (item 113, spike 21 / 23): branches into a separate session from the conversation up to that response.
      // Both are guarded by the `rewind` feature table (passing them to a version without the flag would make startup itself fail).
      if (supports('rewind')) {
        if (options.resumeAtMessageId !== undefined && options.resumeAtMessageId !== null) {
          args.push(flag(t, 'resumeSessionAt'), options.resumeAtMessageId)
        }
        if (options.forkSession === true) args.push(flag(t, 'forkSession'))
      }
    } else {
      args.push(flag(t, 'sessionId'), options.sessionId)
      // A bundle's conversation (TODO 633 stage 3): only the first launch starts inside a worktree. The name is checked here too (the caller's re-validation).
      if (
        options.worktreeName !== undefined &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(options.worktreeName) &&
        t.flags['worktree'] !== undefined
      ) {
        args.push(flag(t, 'worktree'), options.worktreeName)
      }
    }

    // Echo back the sent messages with identifiers (item 113). Without it the key of `rewind_files`
    // (the user message's uuid) cannot be obtained (spike 21).
    if (supports('rewind')) args.push(flag(t, 'replayUserMessages'))

    // The reference scope (4.4). On macOS, listing each one is fine (spike 4: +0.5 s for 2000). When the sandbox is enabled, it is the reference scope minus the cwd and writable places
    // (TODO 1106, spike 38: folders in `--add-dir` become writable in the sandbox. The rest is made read-only with denyWrite).
    if (supports('extra-dirs')) {
      for (const dir of sandbox?.addDirs ?? options.allowedDirs) args.push(flag(t, 'addDir'), dir)
    }

    // Add the gateway (7.6, constraint 7). **Do not attach strict** (item 110, 2026-09-27): the user's
    // MCP servers (registered at user / project level, bundled with plugins, claude.ai connectors) are read by the CLI itself, the same as
    // the stock CLI. Their tool calls also reach `--permission-prompt-tool` (spike 21).
    if (supports('mcp-config')) args.push(flag(t, 'mcpConfig'), configPath)

    // Extra instructions on how to use the gateway's tools (TODO 822, 7.6.2). Only when the gateway is passed. The text is in compat's table, and
    // if the table has no flag it is not passed (it would be only descriptive text). The probe starts with the same flag, so a version that does not accept it is found by the probe.
    // TODO 1229: only when Gmail's draft font is fixed-width, one sentence is added to the same entry point (the standard adds nothing).
    const gatewayText = gatewayInstructions(t)
    const draftFontText = gmailDraftFontInstruction(options.gmailDraftFont)
    const instructions =
      gatewayText === null && draftFontText === null
        ? null
        : [gatewayText, draftFontText].filter((text): text is string => text !== null).join('\n')
    if (supports('mcp-config') && instructions !== null && typeof t.flags['appendSystemPrompt'] === 'string') {
      args.push(flag(t, 'appendSystemPrompt'), instructions)
    }

    if (supports('permission-mode')) {
      // plan only when starting in Plan mode (item 112). Otherwise aios's default (manual).
      const planKey = options.planMode === true ? t.planMode?.permissionMode : undefined
      const mode = t.permissionModes[planKey ?? PERMISSION_MODE_KEY] ?? t.permissionModes[PERMISSION_MODE_KEY]
      if (mode !== undefined) args.push(flag(t, 'permissionMode'), mode.sent)
    }
    if (supports('permission-prompt-tool') && supports('mcp-config')) {
      args.push(flag(t, 'permissionPromptTool'), approveToolName(t))
    }

    // TODO 1216 (6.2.6, fix X): unattended read-only (the first turn of a trigger). **An allow list (deny by default)**: built-in tools are
    // only the ones that read (`--tools`), MCP is only the gateway (`--strict-mcp-config`), and in addition writes, the shell, the Web and sending are doubly removed with deny.
    // If the table cannot build it, `launch` refuses before starting (never run without flags).
    if (options.readOnly === true) {
      const readOnlyArgs = unattendedLaunchArgs(t)
      if (readOnlyArgs !== null) args.push(...readOnlyArgs)
    }

    // **The origin of settings is not specified** (item 109, 2026-09-27, 4.6.4): as with the stock CLI, the CLI reads user / project /
    // local (matching VS Code + CLI). It used to drop the user's global settings with `--setting-sources project`
    // (for consistent approvals), but with T40 the default became "do not ask" and
    // that reason is gone. `--permission-mode manual` wins over `defaultMode` in settings (spike 21).

    if (supports('subagent-text')) args.push(flag(t, 'subagentText'))

    // The OS sandbox (TODO 1106, 4.2.4, spike 37 / 38). A single `--settings '<JSON>'`. The user's settings file is not written (constraints 1 / 2),
    // and the flag for the origin of settings is still not passed (constraint 7). The JSON shape (the fixed values and where lists go) is `osSandbox` of the compat table.
    if (sandbox !== null) args.push(flag(t, 'settings'), sandbox.settingsJson)

    // model / thinking (T5). null is not passed = the backend's default.
    // An invalid model name does not fail at launch; the first turn errors (4.6.2).
    if (supports('model-select') && options.modelId !== null) {
      // An earlier table's id is remapped to an alias and passed (item 91). The caller also remaps, but this is the last entry point.
      // TODO 1204: an alias whose level badge was swapped for a newer version is passed with that version's value (the full name).
      args.push(flag(t, 'model'), this.cliModelValue(options.modelId))
    }
    if (supports('thinking-level') && options.thinking !== null) {
      args.push(...thinkingArgs(t, options.thinking))
    }

    return args
  }
}

/**
 * TODO 1216 (fix X): the flags added when starting an unattended read-only run. Built as an **allow list**:
 *  - `tools` = limits the built-in tools to only `unattended.readOnlyTools` (tools not in the table or newly added do not appear in the conversation).
 *  - `strictMcpConfig` = MCP is only the gateway of `--mcp-config` (the user's MCP, `.mcp.json` and connectors are not read. The tools that the user's
 *    `permissions.allow` can pass automatically are limited to read-only built-ins and the gateway - which aios refuses at the tool level).
 *  - `disallowedTools` = a double safeguard (`unattendedDisallowed`).
 * null if the `tools` / `strictMcpConfig` flags or the table are absent - the caller (`launch`) **does not start** (fail-closed).
 */
export function unattendedLaunchArgs(table: CompatTable): string[] | null {
  const tools = table.flags['tools']
  const strict = table.flags['strictMcpConfig']
  if (typeof tools !== 'string' || typeof strict !== 'string' || table.unattended === undefined) return null
  const allowed = table.unattended.readOnlyTools.filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
  // An empty `--tools ""` means "no tools", but passing an empty list is not done (a table mistake is reported without starting).
  if (allowed.length === 0) return null
  const args = [tools, [...new Set(allowed)].join(','), strict]
  const deny = unattendedDisallowed(table)
  if (deny !== null) args.push(table.flags['disallowedTools'] as string, deny)
  return args
}

/**
 * TODO 1216: the value passed to `--disallowedTools` when starting read-only (one comma-separated argument). null if the flag or table is absent
 * (the flag is not attached, and protection is only by the approval choke point). Connector sending tools (`outbound.tools`) are added too.
 */
export function unattendedDisallowed(table: CompatTable): string | null {
  if (typeof table.flags['disallowedTools'] !== 'string' || table.unattended === undefined) return null
  const names = [...table.unattended.disallowedTools, ...(table.outbound?.tools ?? [])].filter((name) =>
    /^[A-Za-z0-9_-]+$/.test(name)
  )
  return names.length === 0 ? null : [...new Set(names)].join(',')
}

/**
 * The per-server timeout attached to the gateway row (TODO 632, 7.6.5). The CLI ignores anything under 1000 ms, so
 * if the table's value is not a number or is under 1000, it is not attached (left to the CLI's default).
 */
export function gatewayTimeout(table: CompatTable): { timeout?: number } {
  const value = table.mcp.toolTimeoutMs
  return typeof value === 'number' && Number.isFinite(value) && value >= 1000 ? { timeout: Math.floor(value) } : {}
}

function emptyFeatures(): AgentFeatureMap {
  const out = {} as Record<AgentFeature, boolean>
  for (const feature of AGENT_FEATURES) out[feature] = false
  return out
}

/**
 * The environment with `ELECTRON_RUN_AS_NODE` removed.
 * The parent (main) never has it, but when the app is started from an integrated terminal
 * during development it is inherited. Leaking to the child CLI changes its behavior.
 */
function withoutRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env }
  delete copy['ELECTRON_RUN_AS_NODE']
  return copy
}

/** The tail of the worktree location path (`backend-paths.json`). null if the table cannot be read (worktrees are not read). */
function worktreesSuffix(): string | null {
  try {
    return loadBackendPaths().worktreesPathSuffix ?? null
  } catch {
    return null
  }
}

/** Whether this level turns thinking itself off (passes `--thinking disabled`) (item 95). */
function turnsThinkingOff(table: CompatTable, level: ThinkingLevel | null): boolean {
  return level !== null && thinkingEntry(table, level).thinking !== undefined
}

/** What the adapter wants to receive from LiveSession (an internal hook, separate from the app's `SpawnHandlers`). */
interface SessionHooks {
  /**
   * `system/init` arrived (the reported full model name). init itself arrives on every turn (spike 15), but
   * the model does not change during the process's life, so it is called **only the first time** (the same place as item 94's de-duplication).
   */
  readonly onInit?: (
    model: string | null,
    /** The id of the model the session currently has in effect (the one specified at launch, or the value after switching while running). */
    modelId: string | null,
    /** The value actually passed to the CLI for that id (`--model` / `set_model`. For a level swap, the full name). null if none was passed. */
    sent: string | null
  ) => void
  /** The command list changed while running (the rest of item 117). The list of names as reported (before correction with the table). */
  readonly onCommandsChanged?: (commands: readonly string[]) => void
  /** TODO 1147: an auth-expired line was recognized (the assistant line's `error` field, or the failed `result` message). The snapshot does not hold the body. */
  readonly onAuthError?: (snapshot: AuthErrorSnapshot) => void
  /** TODO 1147: the parent's `api_retry` arrived (a snapshot of the status code and request id). */
  readonly onApiRetry?: (snapshot: ApiRetrySnapshot) => void
}

/** One started session. Has line-by-line parsing and exit detection. */
class LiveSession implements AgentSession {
  readonly sessionId: string
  /** Control requests awaiting a response (request_id -> resolution). On exit, all are resolved with null. */
  private readonly pendingControl = new Map<
    string,
    {
      readonly resolve: (reply: ControlResponse | null) => void
      readonly timer: ReturnType<typeof setTimeout>
    }
  >()
  private stdoutBuffer = ''
  private stderrTail = ''
  private sawResult = false
  private requested = false
  private exited = false
  private seq = 0
  /**
   * Whether the first `session_started` was emitted (item 94). **`system/init` appears on every turn**
   * (spike 15, every turn with the same session_id), so it is not emitted the second time onward. If it were, the
   * timeline would line up "session started" every turn, and a row carrying tools / commands would be
   * saved every turn.
   */
  private sawInit = false
  /** TODO 869: whether connectors were waited for before the first message (whether the wait began). */
  private connectorsChecked = false
  private connectorWait: Promise<void> | null = null
  /** Cut the wait short (probe, interrupt). Once set, leave before the next query. */
  private connectorWaitReleased = false
  /** The parsing context made at launch (id, clock). Used by the wait notice (TODO 869 plan C). */
  private parseCtx: ParseContext | null = null
  private readonly startedAt = Date.now()
  /**
   * Whether this is after a conversation reset (`/clear`, item 117). The backend starts over with a new session_id, and
   * the following `system/init` carries that id. **Only that init is emitted** (unless the new id is remembered, a
   * `--resume` after eviction returns to the conversation before the reset) - it is not a resume, so `resumed` is not attached.
   */
  private afterReset = false
  /**
   * An interrupt was sent and that turn's `result` has not arrived yet (item 94). If the next `result` has a completion subtype that
   * means interruption, `interrupted` is attached. **It is cleared on any `result`** - so that if the interrupt crossed with
   * the end of the turn, the next turn's failure is not mistaken for an interruption.
   */
  private interruptPending = false
  /** This turn's parent assistant line reported an auth expiry (TODO 893). `authFailed` is attached to the next `result` and returned. */
  private authFailurePending = false
  /**
   * The cost last reported by this process (item 93, spike 19). **`result.total_cost_usd` is cumulative for the
   * process, not per turn**, and includes API calls by background children (three `result`s were
   * $0.093 -> $0.110 -> $0.114. The third turn alone was under $0.005). SessionManager adds up
   * on every `result`, so here it is converted to a per-turn difference before being passed. If it decreased (recounted after a
   * restart, etc.), that value is taken as the difference as is.
   */
  private reportedCostUsd = 0
  /**
   * The Promise while waiting for the previous write to drain into the OS pipe (item 82).
   * If `write` returns false (backpressure), the next line is not emitted until `drain`. The ordering of lines is
   * kept by this chain.
   */
  private writeChain: Promise<void> = Promise.resolve()
  /**
   * The model / thinking currently in effect (item 95). Starts from what was specified at launch, and is replaced each time
   * `switchSettings` goes through.
   */
  private current: { modelId: string | null; thinking: ThinkingLevel | null }
  /**
   * The value actually passed to the CLI for the current `current.modelId` (`--model` / `set_model`, wave 82 review Y-2). For an alias whose level badge was swapped
   * for a newer version, the full name. If what was learned after launch (catalog) changes and the value passed for the same id changes, it is aligned before the next send
   * with `set_model` (`modelDrifted`).
   */
  private cliModel: string | null
  /**
   * Whether it was started with thinking turned off (`--thinking disabled` passed). In a process started that way, the only way
   * to turn thinking back on is a value with a budget, and it cannot return to adaptive, so it restarts (spike 18 C).
   */
  private readonly thinkingOffAtSpawn: boolean
  /** Reads entering and leaving a worktree and children running in a worktree (TODO 633). Holds state across lines. */
  private readonly worktrees: WorktreeWatch

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: SpawnOptions,
    private readonly handlers: SpawnHandlers,
    private readonly configPath: string,
    private readonly table: CompatTable,
    private readonly hooks: SessionHooks = {},
    /** `live-settings` of the feature table (item 95). If false, `switchSettings` is always false. */
    private readonly liveSettings = false,
    /** `rewind` of the feature table (item 113). If false, `rewindFiles` is null (no entry point). */
    private readonly rewind = false,
    /**
     * The id remapping before passing to `set_model` (`legacyIds` of item 91). TODO 769 made it go through the adapter's
     * entry point - the value of a version-pinned model is not remapped. The default is the table-only remapping.
     */
    private readonly canonicalModel: (id: string) => string = (id) => canonicalModelId(table, id),
    /**
     * The value passed with `--model` at launch (wave 82 review Y-2). null if none was passed. Afterwards it is replaced each time `set_model`
     * goes through (`cliModel`).
     */
    sentModel: string | null = null,
    /**
     * Whether this effort value may be passed with `effortLevel` while running (wave 82 review Y-4). When switching to a false value,
     * nothing is sent and false is returned, leaving it to a restart (`--effort`). The default is all true.
     */
    private readonly liveEffort: (value: string) => boolean = () => true
  ) {
    this.sessionId = options.sessionId
    this.current = { modelId: options.modelId, thinking: options.thinking }
    this.cliModel = sentModel
    this.thinkingOffAtSpawn = turnsThinkingOff(table, options.thinking)
    this.worktrees = new WorktreeWatch(options.cwd, table, worktreesSuffix())
    const ctx: ParseContext = {
      sessionId: options.sessionId,
      threadId: options.threadId,
      now: () => Date.now(),
      newId: () => `${options.sessionId}:${(this.seq += 1)}`,
      // Item 110: identify the gateway from init's `mcp_servers`, and map status names to the neutral vocabulary.
      mcp: {
        serverName: table.mcp.serverName,
        gatewaySource: table.mcp.gatewaySource ?? null,
        statusValues: table.mcp.statusValues ?? {},
        // Item 164: origin -> global side / folder side.
        globalSources: table.mcp.globalSources ?? [],
        folderSources: table.mcp.folderSources ?? []
      }
    }

    this.parseCtx = ctx
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk, ctx))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // stderr keeps its tail only for diagnostics. **The body is not output** (the convention of chapter 7).
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_MAX)
    })

    // **Always catch stdin's `error`** (item 82). If a write happens in the window where the process died but `close` has not
    // arrived yet, `EPIPE` is raised asynchronously as the stream's `error`, and with no listener it becomes
    // main's uncaughtException (= the whole app goes down). The exit decision is left to
    // `close`; here the reason is only shown in the timeline.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      log.warn('agent.stdin.error', { sessionId: options.sessionId, code: err.code ?? null })
      // An EPIPE after we stopped it ourselves is expected, so it is not shown in the timeline.
      if (this.exited || this.requested) return
      this.emit(ctx, {
        kind: 'error',
        payload: { message: err.message, code: err.code ?? null, origin: 'stream' }
      })
    })

    child.on('error', (err) => {
      this.emit(ctx, {
        kind: 'error',
        payload: { message: err.message, code: null, origin: 'spawn' }
      })
      this.finish(null, null)
    })
    child.on('close', (code, signal) => this.finish(code, signal))
  }

  get alive(): boolean {
    return !this.exited
  }

  private onStdout(chunk: string, ctx: ParseContext): void {
    this.stdoutBuffer += chunk
    let index: number
    while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, index)
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      // A control request's response (items 91 / 94) is not made into an event. If it were saved as `unknown`,
      // an initialize response would leave even account information in the DB.
      const control = readControlResponse(this.table.control, line)
      if (control !== null) {
        if (!this.pendingControl.has(control.requestId)) {
          // A response that arrived late after a timeout, etc. Nobody is waiting for it any more.
          log.warn('agent.control.unmatched', { sessionId: this.sessionId, ok: control.ok })
        }
        this.settleControl(control.requestId, control)
        continue
      }
      const parsed = parseEventWithRaw(line, ctx)
      if (parsed.raw !== null && isAuthFailureLine(this.table, parsed.raw)) {
        this.authFailurePending = true
        this.hooks.onAuthError?.(
          snapshotOfAuthLine(this.table, parsed.raw, line, this.stderrTail, this.options.threadId, Date.now())
        )
      }
      const events = parsed.raw === null ? parsed.events : this.worktrees.observe(parsed.raw, parsed.events, ctx)
      for (const event of events) {
        if (event.kind === 'conversation_reset') {
          // `/clear` (item 117, 4.5.3.1). The next init is the start of a new conversation, so it is emitted.
          // The cumulative cost (`total_cost_usd`) also returns to 0 here (real behavior: the reset's `result` is 0).
          this.sawInit = false
          this.afterReset = true
          this.reportedCostUsd = 0
        }
        if (event.kind === 'session_started') {
          // The start of a turn (TODO 893 code-review): the previous turn's mark is not carried over even if it ended without a `result`.
          this.authFailurePending = false
          // An init from the second time on is merely the start of a turn (item 94). It is enough to remember the model at the first init.
          if (this.sawInit) continue
          this.sawInit = true
          if (this.afterReset) {
            this.afterReset = false
            this.handlers.onEvent(event)
            continue
          }
          this.hooks.onInit?.(event.payload.model, this.current.modelId, this.cliModel)
          this.logMcpServers(event.payload.mcpServers ?? [], event.payload.gatewayConflict === true)
        }
        if (event.kind === 'commands_changed') {
          this.hooks.onCommandsChanged?.(reportedCommandsChanged(line) ?? event.payload.commands)
        }
        if (event.kind === 'api_retry' && event.actor === 'main' && parsed.raw !== null) {
          this.hooks.onApiRetry?.(snapshotOfApiRetry(this.table, parsed.raw, line, this.options.threadId, Date.now()))
        }
        if (event.kind === 'result') {
          this.sawResult = true
          const interrupted =
            this.interruptPending &&
            event.payload.subtype === this.table.control.interruptedResultSubtype
          this.interruptPending = false
          // Auth expiry (TODO 893): recognized by the parent assistant line's `error` field, or by the failed `result` message.
          const byText = !this.authFailurePending && !event.payload.ok && isAuthFailureText(this.table, event.payload.text)
          const authFailed = !interrupted && (this.authFailurePending || byText)
          this.authFailurePending = false
          if (authFailed && byText) {
            // TODO 1147: a version that had no assistant line. Only the kind and length of the message are kept.
            this.hooks.onAuthError?.(
              snapshotOfAuthResult(this.table, event.payload.text, this.stderrTail, this.options.threadId, Date.now())
            )
          }
          const cumulative = event.payload.costUsd
          const costUsd =
            cumulative >= this.reportedCostUsd ? cumulative - this.reportedCostUsd : cumulative
          this.reportedCostUsd = cumulative
          this.handlers.onEvent({
            ...event,
            payload: {
              ...event.payload,
              costUsd,
              ...(interrupted ? { interrupted: true } : {}),
              ...(authFailed ? { authFailed: true } : {})
            }
          })
          continue
        }
        if (event.kind === 'session_started' && this.options.resumeBackendSessionId !== null) {
          this.handlers.onEvent({
            ...event,
            payload: { ...event.payload, resumed: true }
          })
          continue
        }
        this.handlers.onEvent(event)
      }
    }
  }

  /**
   * Leaves a breakdown of the connected MCP servers in the log (item 110). Names are not output (they are the user's registered names).
   * If there is no gateway (no approval entry point), a same-name collision is a warning.
   */
  private logMcpServers(servers: readonly McpServerReport[], gatewayConflict: boolean): void {
    const gateways = servers.filter((s) => s.gateway).length
    const others = servers.filter((s) => !s.gateway)
    const count = (state: McpServerState): number => others.filter((s) => s.state === state).length
    const fields = {
      sessionId: this.sessionId,
      gateway: gateways,
      servers: others.length,
      // Item 164: the number of rows on the folder side (varies with cwd) and rows whose category is unknown. The global side is the remainder.
      folder: others.filter((s) => s.scope === 'folder').length,
      unknownScope: others.filter((s) => s.scope !== 'folder' && s.scope !== 'global').length,
      connected: count('connected'),
      failed: count('failed'),
      needsAuth: count('needs-auth'),
      pending: count('pending'),
      disabled: count('disabled')
    }
    if (gatewayConflict) log.warn('agent.mcp.gatewayConflict', fields)
    else if (gateways === 0) log.warn('agent.mcp.gatewayMissing', fields)
    else log.info('agent.mcp.servers', fields)
  }

  /** Notice of waiting for MCP connections (TODO 869 plan C). 0 is the end of the wait. */
  private announceConnecting(pending: number): void {
    const ctx = this.parseCtx
    if (ctx === null || this.exited) return
    this.handlers.onEvent({
      id: ctx.newId(),
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      ts: ctx.now(),
      actor: 'main',
      kind: 'mcp_connecting',
      payload: { pending }
    })
  }

  private emit(ctx: ParseContext, partial: { kind: 'error'; payload: AiosEvent['payload'] }): void {
    this.handlers.onEvent({
      id: ctx.newId(),
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      ts: ctx.now(),
      actor: 'main',
      ...partial
    } as AiosEvent)
  }

  private finish(code: number | null, signal: NodeJS.Signals | number | null): void {
    if (this.exited) return
    this.exited = true
    this.authFailurePending = false
    rmSync(this.configPath, { force: true })
    // Control requests awaiting a response will no longer return (the timers are also removed here. The interrupt's waiter gets a reject).
    for (const requestId of [...this.pendingControl.keys()]) this.settleControl(requestId, null)

    // **Abnormal termination cannot be decided by the exit code** (spike 1: 0 even for SIGINT).
    // Distinguish by "whether the completion event was received" and "whether we stopped it ourselves" (4.3.1).
    if (!this.sawResult && !this.requested) {
      this.handlers.onEvent({
        id: `${this.sessionId}:exit`,
        sessionId: this.sessionId,
        threadId: this.options.threadId,
        ts: Date.now(),
        actor: 'main',
        kind: 'error',
        payload: {
          // The tail of stderr is the diagnostic text, so it is used as is. If there is none, a reason code (the renderer draws it in the display language, TODO 519).
          message: this.stderrTail.trim().slice(-500) || formatReason('agent-exited-without-result'),
          code: code === null ? null : String(code),
          origin: 'exit'
        }
      })
    }
    this.handlers.onExit({
      code,
      signal: typeof signal === 'string' ? signal : null,
      sawResult: this.sawResult,
      requested: this.requested,
      stderr: this.stderrTail
    })
  }

  send(input: AgentInput): void {
    if (this.exited) return
    // A new turn (TODO 893 code-review): the previous turn's auth-expiry mark is discarded. Sending is only between turns (queued during a response, item 94).
    this.authFailurePending = false
    const content: unknown[] = []
    for (const image of input.images ?? []) {
      // spike 3: a base64 image block is accepted (no error even at 23 MB).
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.base64 }
      })
    }
    if (input.text !== '') content.push({ type: 'text', text: input.text })
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content }
    })
    // TODO 869: only for the first message, do not write while MCP connectors are pending (so that it does not answer with tools missing from the list).
    if (!this.connectorsChecked && this.table.control.mcpStatus !== undefined) {
      this.connectorsChecked = true
      this.connectorWait = this.waitForConnectors(this.table.control.mcpStatus).finally(() => {
        this.connectorWait = null
      })
    }
    if (this.connectorWait !== null) {
      void this.connectorWait.then(() => this.writeUser(line))
      return
    }
    this.writeUser(line)
  }

  /** Stops waiting for connectors before the first message (for the probe; also used on interrupt. TODO 869). */
  skipConnectorWait(): void {
    this.connectorsChecked = true
    this.connectorWaitReleased = true
  }

  private writeUser(line: string): void {
    if (this.exited) return
    this.sawResult = false
    this.write(`${line}\n`)
  }

  /**
   * Before the first message, waits for the MCP connectors to connect (TODO 869). Queries `mcp_status` every `pollMs`, and
   * finishes when nothing is pending and the list is not empty. If the list stays empty it gives up at `minWaitMs` from startup; if pending remains, at
   * `maxWaitMs` from when waiting began. **Does not throw** - if no response comes, it is refused or the process ended, it goes on without waiting.
   */
  private async waitForConnectors(vocab: McpStatusVocabulary): Promise<void> {
    const began = Date.now()
    const pendingNames = new Set(
      Object.entries(this.table.mcp.statusValues ?? {})
        .filter(([, neutral]) => neutral === 'pending')
        .map(([cli]) => cli)
    )
    let waited = false
    let announced = 0
    try {
      for (;;) {
        if (this.exited || this.connectorWaitReleased) return
        const reply = await this.writeControlRequest(vocab.subtype, {}, vocab.timeoutMs)
        if (reply === null || !reply.ok) break
        const body = reply.response
        const raw =
          typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[vocab.serversField] : undefined
        const servers = Array.isArray(raw) ? raw : []
        const pending = servers.filter(
          (v) =>
            typeof v === 'object' &&
            v !== null &&
            pendingNames.has(String((v as Record<string, unknown>)[vocab.statusField]))
        ).length
        const now = Date.now()
        if (pending === 0 && (servers.length > 0 || now - this.startedAt >= vocab.minWaitMs)) break
        if (now - began >= vocab.maxWaitMs) break
        if (this.connectorWaitReleased) break
        waited = true
        // TODO 869 plan C: while waiting, show the number connecting on the heading badge (a notice that is not saved).
        if (pending > 0 && pending !== announced) {
          announced = pending
          this.announceConnecting(pending)
        }
        await new Promise<void>((resolve) => setTimeout(resolve, vocab.pollMs))
      }
    } finally {
      // Whatever way it exits (including release during the wait, and exit), restore the heading's "connecting".
      if (announced > 0) this.announceConnecting(0)
    }
    if (waited) log.info('agent.mcp.waited', { sessionId: this.sessionId, ms: Date.now() - began })
  }

  /**
   * Writes one control request line and waits for the response with the same request_id (items 91 / 94). **A shared entry point** -
   * both `initialize` (the model list) and `interrupt` (an interrupt during a response, item 94) go through here.
   * `subtype` is passed the value of `control` in `compat/` (kind names are not written in the source).
   *
   * - The order of writing is kept by the same chain as `send` (a request written first arrives first).
   * - **Does not throw.** If no response comes (it ended, timed out, or cannot be written), resolves with null.
   *   `ok: false` is a response where the CLI refused (an unsupported kind, etc.).
   * - If the process ends while waiting, null immediately. The timer is always removed.
   */
  writeControlRequest(
    subtype: string,
    extra: Readonly<Record<string, unknown>> = {},
    timeoutMs: number = CONTROL_TIMEOUT_MS
  ): Promise<ControlResponse | null> {
    if (this.exited) return Promise.resolve(null)
    const requestId = randomUUID()
    return new Promise<ControlResponse | null>((resolve) => {
      const timer = setTimeout(() => this.settleControl(requestId, null), timeoutMs)
      this.pendingControl.set(requestId, { resolve, timer })
      this.write(`${controlRequestLine(this.table.control, requestId, subtype, extra)}\n`)
    })
  }

  private settleControl(requestId: string, reply: ControlResponse | null): void {
    const pending = this.pendingControl.get(requestId)
    if (pending === undefined) return
    this.pendingControl.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(reply)
  }

  /**
   * Writes one line to stdin. With backpressure (`write` is false), makes the next line wait until `drain`
   * (item 82). Even when 8 MB images are sent in a row, they do not pile up in the buffer. If it cannot be written
   * (already exited, or the stream is broken), it is silently dropped - the reason is conveyed by `error` / `close`.
   */
  private write(chunk: string): void {
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          const stdin = this.child.stdin
          if (this.exited || stdin.destroyed || !stdin.writable) {
            resolve()
            return
          }
          if (stdin.write(chunk)) {
            resolve()
            return
          }
          // Proceed on whichever comes first: `drain`, or becoming unable to write (`close` / `error`).
          const done = (): void => {
            stdin.off('drain', done)
            stdin.off('close', done)
            stdin.off('error', done)
            resolve()
          }
          stdin.once('drain', done)
          stdin.once('close', done)
          stdin.once('error', done)
        })
    )
  }

  /**
   * Interrupt of a turn (item 94, spike 15b). Writes an `interrupt` control request line with `writeControlRequest`
   * (the same entry point as initialize) and waits for the acceptance response.
   * **The process is not stopped** (`requested` is not set either - it does not affect the exit decision).
   * The ordering of lines is kept by the `write` chain, so it does not overtake a `user` line written earlier.
   *
   * Rejects if the response is `null` (timeout, or the process ended while waiting) or `ok: false` (refusal).
   * Falling back to SIGINT (`abort()`) is up to the caller (SessionManager) - doing it here would kill the process even when the process had already ended or
   * the turn had already finished because the two crossed.
   */
  async interrupt(): Promise<void> {
    if (this.exited) return
    const control = this.table.control
    // TODO 869: if the first message is in the middle of waiting for connectors, cut the wait short and let the user line be written first (so the interrupt does not overtake it).
    if (this.connectorWait !== null) {
      this.connectorWaitReleased = true
      await this.connectorWait
    }
    this.interruptPending = true
    // The mark of an interrupted turn is not made an auth expiry (TODO 893 code-review. Not carried over even if the interrupt's `result` does not come).
    this.authFailurePending = false
    const reply = await this.writeControlRequest(control.interrupt, {}, control.timeoutMs)
    if (reply?.ok === true) return
    // It was not accepted. The turn has not stopped, so it also does not wait for the interrupt's completion subtype.
    this.interruptPending = false
    if (reply === null) {
      const reason = this.exited ? 'exited' : 'control request timed out'
      if (!this.exited) log.warn('agent.control.timeout', { sessionId: this.sessionId })
      throw new Error(reason)
    }
    log.warn('agent.control.rejected', { sessionId: this.sessionId })
    throw new Error(reply.error ?? 'control request rejected')
  }

  /**
   * Whether, with the current setting (`current.modelId`) unchanged, the value passed to the CLI changed after launch (or after the last `set_model`)
   * (wave 82 review Y-2). Example: it was started before learning with the alias as is (= the CLI's default old version), and the `initialize` response replaced the
   * level badge with a newer version. If true, the caller calls `switchSettings` immediately before the next input to align it (it is not aligned in the middle of a turn).
   */
  modelDrifted(): boolean {
    const id = this.current.modelId
    if (id === null || this.cliModel === null) return false
    return this.canonicalModel(id) !== this.cliModel
  }

  /** The range reached by the switching entry point (item 95). Used for the renderer's note "a restart is required". */
  get switchRestart(): SwitchRestart {
    if (!this.liveSettings || this.table.control.switchSettings === undefined) return 'always'
    return this.thinkingOffAtSpawn ? 'thinking-on' : 'never'
  }

  /**
   * Switches model / thinking while running (item 95, spike 18). It is called only after the previous turn's `result`
   * and immediately before the next `user` line (SessionManager calls it that way).
   *
   * - Model: `set_model` (the alias as is). Takes effect from the next turn.
   * - Turn thinking off: budget 0. Turn it back on: `null` (= the startup value) - if it was off at startup it does not come back,
   *   so in that case **nothing is sent** and false is returned (restart).
   * - effort: `effortLevel` of the flag layer. It wins over `--effort` at startup. It is also resent when the model changes
   *   (passing through a model where effort does not apply can return it to the CLI's default).
   *
   * Requests are sent in order, and if any is rejected or times out, false. A state where it took effect partway is overwritten by the caller's
   * restart (which passes everything again with launch flags).
   */
  async switchSettings(target: {
    readonly modelId: string | null
    readonly thinking: ThinkingLevel | null
  }): Promise<boolean> {
    const vocab = this.table.control.switchSettings
    if (!this.liveSettings || vocab === undefined || this.exited) return false
    const current = this.current
    // Wave 82 review Y-2: even if the id is the same, if the value passed for that id changed after launch (the level badge was replaced with a newer version), align it.
    const sendModel = target.modelId === null ? null : this.canonicalModel(target.modelId)
    const drifted =
      target.modelId !== null && target.modelId === current.modelId && this.cliModel !== null && sendModel !== this.cliModel
    if (current.modelId === target.modelId && current.thinking === target.thinking && !drifted) return true
    // "The backend's default" (null) is itself not passing the launch flag, so it cannot be expressed with a control request.
    if (target.modelId === null && current.modelId !== null) return false
    if (target.thinking === null && current.thinking !== null) return false
    const wantOff = turnsThinkingOff(this.table, target.thinking)
    const isOff = turnsThinkingOff(this.table, current.thinking)
    if (!wantOff && isOff && this.thinkingOffAtSpawn) return false

    const steps: { subtype: string; extra: Record<string, unknown> }[] = []
    const modelChanged = target.modelId !== null && (target.modelId !== current.modelId || drifted)
    if (modelChanged && sendModel !== null) {
      steps.push({
        subtype: vocab.setModel,
        extra: { [vocab.modelField]: sendModel }
      })
    }
    if (wantOff && !isOff) {
      steps.push({
        subtype: vocab.setThinkingBudget,
        extra: { [vocab.thinkingBudgetField]: vocab.thinkingOffBudget }
      })
    } else if (!wantOff && isOff) {
      steps.push({ subtype: vocab.setThinkingBudget, extra: { [vocab.thinkingBudgetField]: null } })
    }
    // TODO 1205: xhigh / max and levels with no name use the same entry point (confirmed on 2.1.322 that xhigh / max work with effortLevel).
    const effort = target.thinking === null ? undefined : thinkingEntry(this.table, target.thinking).effort
    const currentEffort = current.thinking === null ? undefined : thinkingEntry(this.table, current.thinking).effort
    if (effort !== undefined && (effort !== currentEffort || modelChanged || isOff)) {
      // Wave 82 review Y-4: do not send a value not confirmed to be accepted by this version's `effortLevel` (max on 2.1.280, a stage with no name) -
      // even for a value it does not accept, it stays `success` and the previous value remains, so sending would make the badge and the actual level diverge. Restart with the launch flag (`--effort`) instead.
      if (!this.liveEffort(effort)) return false
      steps.push({
        subtype: vocab.applySettings,
        extra: { [vocab.settingsField]: { [vocab.effortKey]: effort } }
      })
    }

    for (const [index, step] of steps.entries()) {
      const reply = await this.writeControlRequest(step.subtype, step.extra, vocab.timeoutMs)
      if (reply === null || !reply.ok) {
        log.warn('agent.control.switchFailed', {
          sessionId: this.sessionId,
          step: index,
          of: steps.length,
          reason: reply === null ? (this.exited ? 'exited' : 'timeout') : 'rejected'
        })
        return false
      }
    }
    this.current = { modelId: target.modelId, thinking: target.thinking }
    if (modelChanged) this.cliModel = sendModel
    log.info('agent.control.switched', {
      sessionId: this.sessionId,
      model: modelChanged,
      thinking: target.thinking,
      requests: steps.length
    })
    return true
  }

  /**
   * Turns Plan mode on / off while running (item 112, spike 21 / 22). As with `switchSettings`,
   * it may be called only after the previous turn's `result` and immediately before the next `user` line. The value is the `sent` of
   * `permissionModes` (when turning off, aios's default manual. The CLI normalizes it to default and accepts).
   * The gate is `live-settings` (an unknown version restarts). **Does not throw**.
   */
  async setPlanMode(on: boolean): Promise<boolean> {
    const vocab = this.table.control.setPermissionMode
    const plan = this.table.planMode
    if (!this.liveSettings || vocab === undefined || plan === undefined || this.exited) return false
    const mode = this.table.permissionModes[on ? plan.permissionMode : PERMISSION_MODE_KEY]
    if (mode === undefined) return false
    const reply = await this.writeControlRequest(
      vocab.subtype,
      { [vocab.modeField]: mode.sent },
      vocab.timeoutMs
    )
    if (reply === null || !reply.ok) {
      log.warn('agent.control.planModeFailed', {
        sessionId: this.sessionId,
        on,
        reason: reply === null ? (this.exited ? 'exited' : 'timeout') : 'rejected'
      })
      return false
    }
    log.info('agent.control.planMode', { sessionId: this.sessionId, on })
    return true
  }

  /**
   * Rewinds files to the checkpoint just before that message (item 113, 4.5.6, spike 21 / 23).
   * Writes one line of the `rewind_files` control request through `writeControlRequest` (the same entry point as initialize).
   *
   * - The response of `dry_run` is `{canRewind, filesChanged, insertions, deletions}`, and the real one is
   *   `{canRewind, skippedLinks}`. With no checkpoint it is `{canRewind: false, error}`, and
   *   this comes back as a `success` response (not a rejection), so it is collapsed to `canRewind: false`.
   * - Checkpoints are tied to the transcript, so it also works on a process restarted with `--resume` (spike 23.
   *   The first call right after startup takes about 1 s to load the transcript).
   * - No response (timeout / exit) or a rejection (an unsupported kind) rejects. null on a version with no entry point.
   */
  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindFilesResult | null> {
    const vocab = this.table.control.rewindFiles
    if (!this.rewind || vocab === undefined) return null
    if (this.exited) throw new Error('exited')
    const reply = await this.writeControlRequest(
      vocab.subtype,
      {
        [vocab.userMessageIdField]: userMessageId,
        ...(dryRun ? { [vocab.dryRunField]: true } : {})
      },
      vocab.timeoutMs
    )
    if (reply === null) {
      const reason = this.exited ? 'exited' : 'control request timed out'
      if (!this.exited) log.warn('agent.control.timeout', { sessionId: this.sessionId, subtype: 'rewind' })
      throw new Error(reason)
    }
    if (!reply.ok) {
      log.warn('agent.control.rejected', { sessionId: this.sessionId, subtype: 'rewind' })
      throw new Error(reply.error ?? 'control request rejected')
    }
    const body = reply.response
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    const files = Array.isArray(record['filesChanged'])
      ? record['filesChanged'].filter((f): f is string => typeof f === 'string')
      : []
    const count = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0
    const result: RewindFilesResult = {
      canRewind: record['canRewind'] === true,
      filesChanged: files,
      insertions: count(record['insertions']),
      deletions: count(record['deletions'])
    }
    log.info('agent.control.rewind', {
      sessionId: this.sessionId,
      dryRun,
      canRewind: result.canRewind,
      files: files.length
    })
    return result
  }

  /**
   * The context usage breakdown (item 155, spike 26). Writes one line of `get_context_usage` (`detail: full`) through
   * `writeControlRequest`. It does not call the model and answers even mid-response (about 0.5 s the first time,
   * a few ms if the conversation has not changed). The `full` count does not show up in usage or cost (spike 26).
   * **Does not throw**: a table with no entry point, exit, timeout or rejection (an unsupported version) gives null.
   */
  async contextUsage(): Promise<AgentContextUsage | null> {
    const vocab = this.table.control.contextUsage
    if (vocab === undefined || this.exited) return null
    const reply = await this.writeControlRequest(
      vocab.subtype,
      { [vocab.detailField]: vocab.detail },
      vocab.timeoutMs
    )
    if (reply === null) {
      if (!this.exited) log.warn('agent.control.timeout', { sessionId: this.sessionId, subtype: 'context-usage' })
      return null
    }
    if (!reply.ok) {
      log.warn('agent.control.rejected', { sessionId: this.sessionId, subtype: 'context-usage' })
      return null
    }
    const usage = readContextUsage(reply.response, vocab)
    if (usage === null) log.warn('agent.control.unreadable', { sessionId: this.sessionId, subtype: 'context-usage' })
    return usage
  }

  /** The stop button (`interrupt` from before item 94). Stops the whole process. */
  abort(): void {
    if (this.exited) return
    this.requested = true
    // SIGINT stops generation. The exit code becomes 0, but it is distinguished by `requested` (spike 1).
    // Resuming is done with `--resume` (the context is kept).
    this.child.kill('SIGINT')
  }

  async stop(): Promise<void> {
    if (this.exited) return
    this.requested = true
    // `end` is also a write, so it can hit EPIPE. The constructor's `error` listener catches it
    // (item 82). Only the form that throws synchronously (already destroyed) is caught here.
    try {
      if (!this.child.stdin.destroyed) this.child.stdin.end()
    } catch {
      // An already broken stream. End it with SIGTERM.
    }
    this.child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL')
        resolve()
      }, 3000)
      this.child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

/**
 * The entry point used by the composition root (`src/main/index.ts`).
 *
 * **So that the implementation class name is not exposed**, a factory with a neutral name is provided here.
 * Callers see only the `AgentAdapter` interface (4.6.1).
 * When more backends are added, the choice is made inside this function.
 */
export function createAgentAdapter(cache?: AdapterCache): AgentAdapter {
  return cache === undefined ? new ClaudeCodeAdapter() : new ClaudeCodeAdapter(cache)
}
