/**
 * Loads the known-version table (`compat/claude-code.json`) (ARCHITECTURE.md 4.6).
 *
 * CLI-specific strings (command names, flag names, mode names) are placed only in this file and the table.
 * This keeps new versions trackable by updating the table alone.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ShellInputTable } from './shell-context.js'
import type { ApprovalReplyTable } from '../../approval/replies.js'
import type { OutboundTable } from '../../approval/outbound.js'

/** TODO 1043: `secrets` of the compat table (the same shape for Claude and OpenCode). */
export interface SecretCompat {
  readonly readTools: readonly string[]
  readonly pathKeys: readonly string[]
  readonly egressTools: readonly string[]
  readonly paths?: Readonly<Record<string, readonly string[]>>
}
import type { ProjectAutorunTable } from './project-autorun.js'
import type { GmailDraftFont } from '@shared/gmail-draft-font.js'
import { homeDataDirDisplay } from '../../../common/app-identity.js'
import { PRODUCT_NAME } from '@shared/product.js'
import type {
  AgentFeature,
  AgentFeatureMap,
  McpServerState,
  KnownThinkingLevel,
  ModelChoice,
  ThinkingLevel,
  ToolProgressKind
} from '@shared/agent.js'
import { AGENT_FEATURES, extraThinkingValue, isExtraThinkingLevel } from '@shared/agent.js'

export interface PermissionModeEntry {
  readonly sent: string
  /** Names that init may return. **Do not decide `supports` from a round-tripped value** (spike 9a). */
  readonly reportedAs: readonly string[]
}

/** One kind of progress report (5.1.3). Entries with a `label` show the fixed phrase as is. */
export interface ToolKindEntry {
  readonly kind: ToolProgressKind
  readonly label?: string
  /**
   * Whether the tool writes to disk (second half of item 97). Only true ones are subject to the draft conflict notice
   * - read-only tools (such as `Read`) do not have `write` even with `kind: 'file'`.
   */
  readonly write?: boolean
  /**
   * The shape of write for which the approval frame can show before and after (the approval frame diff of item 97). Only
   * `write-preview.ts` knows the argument keys. A tool without it shows no diff.
   */
  readonly preview?: 'edit' | 'write' | 'notebook'
}

/**
 * One row of the model table (item 60). Adds to `ModelChoice` (id / label) the pie chart's denominator
 * (`contextWindow`) and the full names (`reportedAs`) that appear in init / responses / `result.modelUsage`.
 * **Full names do not leave the adapter** - `listModels()` returns them reduced to `ModelChoice`.
 */
export interface ModelEntry extends Omit<ModelChoice, 'thinkingLevels'> {
  readonly contextWindow?: number
  readonly reportedAs?: readonly string[]
  /**
   * Whether thinking can be turned off (item 92). For some models the CLI silently drops a "turn off" setting.
   * It does not appear in the response (initialize), so only this table and `resolvedOverrides` are the basis. Omitted means true.
   */
  readonly canDisableThinking?: boolean
  /** Whether effort has an effect (item 92). If there is an initialize response, that wins. Omitted means true. */
  readonly supportsEffort?: boolean
}

/** Per-full-name override (item 92). Wins over the alias's default values. */
export interface ModelOverride {
  readonly canDisableThinking?: boolean
  readonly supportsEffort?: boolean
  /**
   * The pie chart's denominator (TODO 769). What an alias points to changes with the CLI version (haiku: 4.5 = 200K -> 5.5 = 1M), so
   * per full name it wins over the alias row's value.
   */
  readonly contextWindow?: number
}

/** The vocabulary of stream-json control requests (items 91 / 94). An internal protocol not listed in `--help`. */
export interface ControlVocabulary {
  readonly requestType: string
  readonly responseType: string
  readonly success: string
  readonly initialize: string
  readonly interrupt: string
  /**
   * The completion subtype of the `result` of an interrupted turn (item 94, spike 15b). **It is also used for other failures**, so
   * do not decide from it alone (pair it with whether we sent an interrupt just before).
   */
  readonly interruptedResultSubtype: string
  /** Upper bound (ms) on waiting for the interrupt's response. If it does not come, fall back to SIGINT. */
  readonly timeoutMs: number
  /**
   * Switching the permission mode while running (item 112, spike 21 / 22). If the table lacks it, restart
   * each time Plan is turned ON / OFF (`--permission-mode`).
   */
  readonly setPermissionMode?: {
    readonly subtype: string
    readonly modeField: string
    readonly timeoutMs: number
  }
  /**
   * Switching model / thinking while running (item 95, spike 18). If the table lacks it (an old compat), restart
   * on every switch. The meaning of the fields is in `compat/`'s `$comment`.
   */
  readonly switchSettings?: SwitchVocabulary
  /**
   * The control request to rewind to a file checkpoint (item 113, spike 21 / 23). If the table lacks it (an old compat), files
   * cannot be rewound (only the conversation branch).
   */
  readonly rewindFiles?: RewindVocabulary
  /**
   * The control request for the context usage breakdown (item 155, spike 26). If the table lacks it (an old compat), the breakdown
   * cannot be fetched (the renderer shows only the same total as the donut).
   */
  readonly contextUsage?: ContextUsageVocabulary
  /**
   * The control request for the MCP servers' connection status (TODO 869). If the table lacks it (an old compat), the first message is not made to wait.
   */
  readonly mcpStatus?: McpStatusVocabulary
}

/** `ControlVocabulary.mcpStatus` (TODO 869). The meaning of the fields is in `compat/`'s `$comment`. */
export interface McpStatusVocabulary {
  readonly subtype: string
  readonly serversField: string
  readonly statusField: string
  readonly pollMs: number
  /** When the list stays empty, stop waiting once this much time (ms) has passed since startup. */
  readonly minWaitMs: number
  /** The upper bound (ms, from when waiting began) after which waiting stops even if pending remains. */
  readonly maxWaitMs: number
  readonly timeoutMs: number
}

/** `ControlVocabulary.contextUsage` (item 155). The meaning of the fields is in `compat/`'s `$comment`. */
export interface ContextUsageVocabulary {
  readonly subtype: string
  readonly detailField: string
  /** The `detail` value to send (`full`. `summary` is not used because its category estimates do not match the total). */
  readonly detail: string
  /** The category name that identifies the "remaining" in an old response without `kind`. */
  readonly freeCategory: string
  /** Likewise the category names that identify the "compaction reserve". */
  readonly bufferCategories: readonly string[]
  /** Category name -> color role (`ContextTone`). A `used` category not in the table is `other`. */
  readonly tones: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

/** `ControlVocabulary.rewindFiles` (item 113). The name of the kind and the names of the fields put in the request. */
export interface RewindVocabulary {
  readonly subtype: string
  readonly userMessageIdField: string
  readonly dryRunField: string
  readonly timeoutMs: number
}

/** `ControlVocabulary.switchSettings` (item 95). The name of the kind and the names of the fields put in the request. */
export interface SwitchVocabulary {
  readonly setModel: string
  readonly modelField: string
  readonly setThinkingBudget: string
  readonly thinkingBudgetField: string
  /** The budget (0) that turns thinking off. Sending `null` returns it to the startup value. */
  readonly thinkingOffBudget: number
  readonly applySettings: string
  readonly settingsField: string
  readonly effortKey: string
  /**
   * effort value -> the minimum CLI version confirmed to work when passed while running with `effortKey` (wave 82 review Y-4).
   * A value not in the table, or a version older than the floor, is not sent and the session restarts (`--effort`). If the whole field is absent, every value is sent.
   */
  readonly liveEffortSince?: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

/** Conversation boundaries (item 117, `streamEvents` of `compat/`). */
export interface StreamEventNames {
  /** The top-level `type` that `/clear` emits. */
  readonly conversationReset: string
  /** The `subtype` of the `system` line for the compaction boundary. */
  readonly compactBoundary: string
  /** The field inside the compaction boundary that holds the token counts before and after. */
  readonly compactMetadata: string
  /** The `message.model` of a line answered without calling the API. */
  readonly syntheticModel: string
  /** The top-level `type` for the progress of a running tool (item 259). If the table lacks it, it stays `unknown`. */
  readonly toolProgress?: string
}

/**
 * The hooks events in settings (item 126-3, `hookEvents` of `compat/`). Only `response` becomes `hook_run`,
 * and `started` / `progress` are dropped. Field names go through `fields` and result names through `outcomeValues` into the neutral vocabulary.
 * If the table lacks it, the hooks events become `unknown` (saving goes through the D-8 scrub).
 */
export interface HookEventNames {
  readonly started: string
  readonly progress: string
  readonly response: string
  readonly fields: {
    readonly id: string
    readonly name: string
    readonly event: string
    readonly outcome: string
    readonly exitCode: string
  }
  /** The backend's result name -> the neutral vocabulary (`success` / `error` / `cancelled`). */
  readonly outcomeValues: Readonly<Record<string, string>>
}

/** Replacement of the command list while running (the rest of item 117, `commandsChanged` of `compat/`). */
export interface CommandsChangedNames {
  /** The `subtype` of `system`. */
  readonly subtype: string
  /** The list field (the elements are `{ name, … }`). */
  readonly listKey: string
}

/**
 * The field for usage against the plan's limits (item 317, `usageWindows` of `compat/`). If the table lacks it,
 * `windows` of `rate_limit` is always omitted (the usage field is not shown).
 */
export interface UsageWindowNames {
  /** The field for the bundle of windows inside `rate_limit_info`. */
  readonly field: string
  readonly fiveHour: string
  readonly sevenDay: string
  /** The key of the weekly window attached only to Fable turn lines (TODO 1000). Not read if the table lacks it or the version has none. */
  readonly sevenDayFable?: string
  /** The field for the 0-1 ratio inside one window. */
  readonly utilization: string
  /** The field for the time (epoch seconds) at which it resets, inside one window. */
  readonly resetsAt: string
}

/**
 * The field for prompt cache lifetime (TODO 466, `cacheLifetimes` of `compat/`). If `tiers[].key` (the number of tokens written) inside `field` of `result.usage` is
 * positive, it is regarded as written with that tier's lifetime (`ms`). **The first tier that is positive, looking in the table's order**
 * is taken (put longer lifetimes first). If the table lacks it, the lifetime is not read (no estimate is shown).
 */
export interface CacheLifetimeNames {
  readonly field: string
  readonly tiers: readonly { readonly key: string; readonly ms: number }[]
}

/**
 * Recognition of auth expiry (TODO 893, `authFailure` of `compat/`). The value of the assistant line's `error` field, and the regexes matched against the failed
 * `result` message (case-insensitive). If the table lacks it, nothing is recognized (an interruption stays `interrupt-error`).
 */
export interface AuthFailureNames {
  readonly errorValues: readonly string[]
  readonly textPatterns: readonly string[]
  /**
   * TODO 1282: of the matched messages, the starts that signing in again cannot fix (the credential handed to the CLI itself was
   * rejected, e.g. an invalid API key). A match makes the kind `credential`; otherwise it is `login`. Absent = always `login`.
   */
  readonly credentialPatterns?: readonly string[]
  /**
   * TODO 1282: the words of the guidance for unattended / scheduled runs (owner decision 2026-11-21: guidance only; aios never stores,
   * accepts or asks for the token). The arguments the user types in their own terminal, and the name of the environment variable
   * the CLI reads the token from. aios runs neither and reads no value.
   */
  readonly unattended?: { readonly setupTokenArgs: readonly string[]; readonly tokenEnv: string }
  /** TODO 1147: the auth-expiry diagnostics bundle. If the table lacks it, the bundle is still written, but the auth status fields, request id and keychain are omitted. */
  readonly diagnostics?: AuthDiagnosticsNames
}

/** The vocabulary of the auth-expiry diagnostics bundle (TODO 1147, `authFailure.diagnostics` of `compat/`). */
export interface AuthDiagnosticsNames {
  /** The `auth status --json` fields that may be left in the log (an allow table). */
  readonly authStatusFields?: readonly string[]
  /** The regex for an API request id (extracts only the id from a line or stderr). */
  readonly requestIdPattern?: string
  /** The macOS keychain item name (only attributes are read - owner decision 2026-11-05). */
  readonly keychainService?: string
}

/**
 * The kinds of background work (items 93 / 105, `tasks` of `compat/`). If the table lacks it, background shells
 * cannot be recognized and `isBackgroundShell` is always false (the eviction behavior does not change;
 * everything other than subagents is not counted, as before).
 */
export interface TaskVocabulary {
  /** The value of `task_type` of `task_started` that denotes a `run_in_background` shell. */
  readonly backgroundShellType: string
  /** The parent tool names that start a subagent (TODO 403). If absent, the model specified by the parent is not read. */
  readonly spawnTools?: readonly string[]
  /** The key in that tool's input that specifies the model (TODO 403; an alias that is present only when specified). */
  readonly spawnModelKey?: string
}

/**
 * Entering and leaving a worktree mid-conversation, and children that run in a worktree (TODO 633 stage 1, `worktree` of `compat/`).
 * If the table lacks it, worktrees are not read (cwd does not follow, and the cleanup targets are not remembered either).
 */
export interface WorktreeVocabulary {
  /** The key in `tool_use_result` that holds the worktree path (for both entering and leaving). */
  readonly pathKey: string
  readonly branchKey: string
  /** The key in `tool_use_result` that holds the cwd returned to. If present, it means "left". */
  readonly originalCwdKey: string
  /**
   * Tools that move the conversation's working folder (fix from the wave 77 review). **Only this call's result** is read as entering or leaving (entering / leaving is the shape of the result -
   * whether `originalCwdKey` is present). Even if `pathKey` appears in another tool's result, it is not treated as entering or leaving (a child's result, etc., TODO 1182).
   */
  readonly moveTools: readonly string[]
  /** The key in the input of the tools that start a child (`tasks.spawnTools`) that holds how to isolate it, and the worktree value. */
  readonly isolationKey: string
  readonly isolationValue: string
  /** The key in the `tool_use_result` of the call that started a child that holds the child's id. */
  readonly agentIdKey: string
  /** The start of a child's worktree name (`agent-<id>`). */
  readonly childNamePrefix: string
  /** The start of a worktree's branch name (`worktree-<name>`). */
  readonly branchPrefix: string
  /** Commands that split work into bundles and run them in worktree children (TODO 700, without the leading `/`). */
  readonly parallelCommands?: readonly string[]
}

/** How to read the arguments of one work-list tool (item 118, `todoTools` of `compat/`). */
export interface TodoToolEntry {
  readonly listKey: string
  readonly contentKey: string
  readonly activeFormKey: string
  readonly statusKey: string
  /** The backend's status names -> the neutral vocabulary. */
  readonly statuses: Readonly<Record<string, string>>
}

/** The CLI-side value corresponding to one `ThinkingLevel` step (one of the two axes, or both). */
export interface ThinkingEntry {
  readonly effort?: string
  readonly thinking?: string
}

export interface CompatTable {
  readonly command: string
  readonly minVersion: string
  readonly flags: Readonly<Record<string, string | readonly string[]>>
  /** The registry key and display name (4.6.1). */
  readonly backend: { readonly id: string; readonly label: string }
  /** Where things that run without confirmation in a first-time folder (hooks / MCP servers) are (item 123). If the table lacks it, they are not searched for. */
  readonly projectAutorun?: ProjectAutorunTable
  /** Tool name -> kind of progress report (5.1.3). **This table does not leave the adapter** (constraint 6). */
  readonly toolKinds: {
    readonly map: Readonly<Record<string, ToolKindEntry>>
  }
  /**
   * Which built-in slash commands work / do not work (item 117). `alwaysAvailable` are ones that work even if absent from the list,
   * and `unavailable` are ones that are listed but do not work. If the table lacks it (an old compat), the list is used as is.
   */
  readonly builtinCommands?: {
    readonly alwaysAvailable: readonly string[]
    readonly unavailable: readonly string[]
  }
  /** The stream-json line names that denote conversation boundaries (item 117). If the table lacks it, boundaries are not read. */
  readonly streamEvents?: StreamEventNames
  /** The hooks events in settings (item 126-3). If the table lacks it, it stays `unknown`. */
  readonly hookEvents?: HookEventNames
  /** Replacement of the command list (the rest of item 117). If the table lacks it, it stays `unknown`. */
  readonly commandsChanged?: CommandsChangedNames
  /** The field for usage against the plan's limits (item 317). If the table lacks it, usage is not read. */
  readonly usageWindows?: UsageWindowNames
  /** The prompt cache lifetime (TODO 466). If the table lacks it, `result.cacheTtlMs` is not attached. */
  readonly cacheLifetimes?: CacheLifetimeNames
  /** Recognition of auth expiry (TODO 893). If the table lacks it, nothing is recognized. */
  readonly authFailure?: AuthFailureNames
  /** The kinds of background work (items 93 / 105). If the table lacks it, background shells cannot be recognized. */
  readonly tasks?: TaskVocabulary
  /** Entering and leaving a worktree, and children that run in a worktree (TODO 633). If the table lacks it, they are not read. */
  readonly worktree?: WorktreeVocabulary
  /** Tools that rewrite the work list (item 118). **Tool names do not leave the adapter** (constraint 6). */
  readonly todoTools?: {
    readonly map: Readonly<Record<string, TodoToolEntry>>
  }
  /**
   * Tools that indicate a skill was used (TODO 1100). `names` are the tool names, and `inputKey` is the argument key holding the skill's name.
   * If the table lacks it, `ToolUsePayload.skill` is not attached. **Tool names do not leave the adapter** (constraint 6).
   */
  readonly skillTools?: {
    readonly names: readonly string[]
    readonly inputKey: string
    /** The key of the marker on the user line that injects a skill's body (TODO 1105). If true, that line is not an echo. */
    readonly syntheticKey?: string
    /** The fixed leading phrase of that line's text. Up to the first newline after it is the skill's directory (TODO 1105). */
    readonly baseDirPrefix?: string
    /** The skill's body file name (TODO 1105). */
    readonly bodyFile?: string
  }
  /**
   * The table of choices (4.6.2 / item 91). The version is read from the full name with `versionPattern`.
   * Keys starting with `$` in `legacyIds` / `resolvedOverrides` are annotations (not read).
   */
  readonly models: {
    readonly list: readonly ModelEntry[]
    readonly probe: string
    readonly legacyIds?: Readonly<Record<string, string>>
    readonly resolvedOverrides?: Readonly<Record<string, ModelOverride | string>>
    readonly versionPattern?: string
    /**
     * `value`s in the `initialize` response rows that are not shown as choices (TODO 769). "Default (recommended)" only points to
     * the same model as one of the aliases, so it is not shown (owner decision 2026-10-12).
     */
    readonly hiddenValues?: readonly string[]
  }
  /** Control requests (items 91 / 94). */
  readonly control: ControlVocabulary
  /** How the prompt box's `!` is wrapped, and its upper bound (item 116). */
  readonly shellInput: ShellInputTable
  /**
   * Named `ThinkingLevel` -> the CLI's two axes. `probe` is the level used for the probe. Levels with no name (`effort:<value>`, TODO 1205)
   * are not in the table, and the value is passed to effort as is (`thinkingEntry`).
   */
  readonly thinkingLevels: Readonly<Record<KnownThinkingLevel, ThinkingEntry>> & {
    readonly probe: KnownThinkingLevel
  }
  readonly permissionModes: Readonly<Record<string, PermissionModeEntry>>
  /**
   * Plan mode (item 112). `permissionMode` is a key of `permissionModes`. `exitTool` is the tool that
   * presents the plan, and `planField` of its input is the plan body (Markdown). If the table lacks it, Plan cannot be used.
   */
  readonly planMode?: {
    readonly permissionMode: string
    readonly exitTool: string
    readonly planField: string
    /** The tool that enters plan mode (item 275). It becomes the `Entered plan mode` row in the timeline. Not shown if absent. */
    readonly enterTool?: string
    /** The field in the input of `exitTool` that holds the plan file's path (item 275). If absent, "Plan saved to" is not shown. */
    readonly planFileField?: string
  }
  /**
   * The text returned to the model when an approval is rejected (items 182 / 183). A copy of the rejection text in the backend's interactive UI.
   * If the table lacks it (an old compat), aios's neutral text (the Broker's default) is returned as is.
   */
  readonly approvalReplies?: ApprovalReplyTable
  /**
   * The table for the outbound-operation decision (TODO 959, 4.2.1). Shell tools, the shape of MCP tool names, and sending tools listed by name.
   * If the table lacks it (an old compat), no decision is made (= handled by the default as before).
   */
  readonly outbound?: OutboundTable
  /**
   * Write destinations that would persist or bypass a choke point and that are specific to this backend (TODO 1042, the location of the CLI's settings). The shared table is
   * `persistence` in `compat/outbound.json`. If the table lacks it, the decision uses only the shared table.
   */
  readonly persistence?: { readonly paths: Readonly<Record<string, readonly string[]>> }
  /**
   * Words specific to this backend for the marks on conversations that read secrets and for routes out (TODO 1043: tools that read, path keys, web tools, credential locations).
   * If the table lacks it, no mark is attached (= as before).
   */
  readonly secrets?: SecretCompat
  /**
   * TODO 1216 (6.2.6): unattended read-only turns (the first turn of a trigger). `readOnlyTools` is an **allow list** - the built-in tools passed to `flags.tools` when
   * starting read-only (anything else does not appear in the conversation), and the built-in tools that the approval choke point lets through without asking.
   * `disallowedTools` are tools removed with `flags.disallowedTools` as a double safeguard. If the table lacks it, a read-only start is refused (fix X) and
   * the choke point refuses all built-in tools.
   */
  readonly unattended?: { readonly readOnlyTools: readonly string[]; readonly disallowedTools: readonly string[] }
  readonly mcp: {
    readonly serverName: string
    readonly approveTool: string
    readonly toolNamePattern: string
    /** The value attached to the gateway (`--mcp-config`) row in `mcp_servers[].source` of `system/init` (item 110). */
    readonly gatewaySource?: string
    /**
     * The per-server tool call timeout (ms, TODO 632) attached to the gateway row of `--mcp-config`.
     * Approvals wait for the user, so it is made long. Not attached if absent (the CLI default: 30 minutes idle).
     */
    readonly toolTimeoutMs?: number
    /** The value of `mcp_servers[].status` -> aios's `McpServerState`. A value not in the table is `other` (item 110). */
    readonly statusValues?: Readonly<Record<string, McpServerState>>
    /** The `source` values counted on the global side (the same for every thread) (item 164). */
    readonly globalSources?: readonly string[]
    /** The `source` values counted on the folder side (varies with cwd) (item 164). In neither: `unknown`. */
    readonly folderSources?: readonly string[]
    /**
     * Extra instructions passed to `flags.appendSystemPrompt` on a launch that passes the gateway (TODO 822, one line per element).
     * `{tool:<name>}` is replaced with the name of the gateway's tool using `toolNamePattern`. Not passed if absent.
     */
    readonly instructions?: readonly string[]
    /**
     * TODO 1296: a short self-introduction of the app for the model (one line per element), passed on **every** launch that can take
     * `flags.appendSystemPrompt`, with or without the gateway. `{app}` and `{helpDir}` are filled in. Not passed if absent.
     */
    readonly introduction?: readonly string[]
  }
  /** The CLI's own update (TODO 774, ARCHITECTURE 4.6.6). If the table lacks it, the update entry point is not shown. */
  readonly selfUpdate?: SelfUpdateTable
  /** The CLI plugin catalog and install / remove (TODO 1099, ARCHITECTURE 4.5.3.3). If the table lacks it, the entry point is not shown. */
  readonly plugins?: PluginsTable
  /** The shape of the setting that enables the CLI's own sandbox (TODO 1106, ARCHITECTURE 4.2.4). If the table lacks it, the sandbox cannot be passed. */
  readonly osSandbox?: OsSandboxTable
  readonly versions: Readonly<
    Record<string, { readonly verifiedAt?: string; readonly features: Partial<AgentFeatureMap> }>
  >
  readonly unknownVersionDefaults: Partial<AgentFeatureMap>
}

/**
 * The shape that enables the CLI's own sandbox with a single JSON in `flags.settings` (TODO 1106, wave 67 spike 37 / wave 68 spike 38).
 * `template` is the fixed value (placed under `settingsKey`). `paths` is where lists go inside the template (a sequence of keys).
 */
export interface OsSandboxTable {
  readonly settingsKey: string
  readonly template: Readonly<Record<string, unknown>>
  readonly paths: {
    readonly domains: readonly string[]
    readonly allowWrite: readonly string[]
    readonly denyWrite: readonly string[]
  }
  /** The field in a shell tool's arguments that marks a request to "run outside the sandbox" (if true, aios refuses). */
  readonly unsandboxedField: string
  /** If this is contained in the stderr of a launch that ended before init, the sandbox is regarded as unable to start in this environment (substring match, case-insensitive). */
  readonly unavailableSignals: readonly string[]
}

/** The CLI's own update (TODO 774). The output text is read only by substring match of `signals` (neither shown nor saved). */
export interface SelfUpdateTable {
  readonly updateArgs: readonly string[]
  readonly installArgs: readonly string[]
  readonly timeoutMs: number
  /** Environment variables that stop the CLI's own auto-update. If any is non-empty, aios's automatic run is not done either. */
  readonly autoDisableEnv?: readonly string[]
  readonly signals?: {
    /** Managed by a package manager (Homebrew, etc.): only guidance is shown and nothing is installed. */
    readonly managed?: readonly string[]
    /** Another process is updating / the lock cannot be taken (nothing was installed). */
    readonly busy?: readonly string[]
    /** Updates are stopped by an administrator's setting. */
    readonly disabled?: readonly string[]
    /** The install destination is not writable (npm global, etc.). */
    readonly permission?: readonly string[]
  }
}

/**
 * The CLI plugin catalog and install / remove (TODO 1099). Output text is not read; only the exit code and the `outcome` /
 * `failureCode` / `nonce` of the one `--json` line are read.
 */
export interface PluginsTable {
  /** The marketplace handled (stage 1 has only the official one). */
  readonly marketplace: string
  readonly installArgs: readonly string[]
  readonly uninstallArgs: readonly string[]
  readonly jsonFlag: string
  /** The environment variable that passes the random value echoed in the result line. If absent, the nonce is not checked. */
  readonly nonceEnv?: string
  readonly timeoutMs: number
  /** The subcommand the user is asked to type in a terminal when there is no catalog or it is stale (shown with `command` prepended). */
  readonly refreshHint: readonly string[]
  /** The value required in the catalog's `surfaces` (the CLI does not install a listing without it). */
  readonly surface: string
  /** The `source.type` values that may be installed. */
  readonly sourceTypes: readonly string[]
  /** The `source.type` values that run commands (not installed, with a reason). */
  readonly commandSourceTypes: readonly string[]
  /** `checks.review.by.type` -> the neutral badge. */
  readonly reviewers: Readonly<Record<string, 'first-party' | 'partner'>>
  readonly catalogSchemaVersion: number
  readonly catalogMaxBytes: number
  readonly staleAfterDays: number
  readonly failureCodes: {
    readonly alreadyDone?: readonly string[]
    readonly commandSource?: readonly string[]
    readonly policy?: readonly string[]
    readonly network?: readonly string[]
    readonly notInstallable?: readonly string[]
    readonly notInstalled?: readonly string[]
  }
}

/**
 * The location of the table. In dev it is `<repo>/compat/`; after the build it is `../../compat/` as seen from
 * `out/main/`. electron-vite emits main to `out/main/`.
 */
function candidateDirs(): readonly string[] {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return [
    join(here, '../../../../compat'), // src/main/session/adapter → repo/compat (dev, vitest)
    join(here, '../../compat'), // out/main → repo/compat (build)
    join(process.cwd(), 'compat')
  ]
}

let cached: CompatTable | null = null

export function loadCompatTable(): CompatTable {
  if (cached !== null) return cached
  const errors: string[] = []
  for (const dir of candidateDirs()) {
    const file = join(dir, 'claude-code.json')
    try {
      cached = JSON.parse(readFileSync(file, 'utf8')) as CompatTable
      return cached
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`)
    }
  }
  throw new Error(`compat table not found\n${errors.join('\n')}`)
}

export interface BackendPaths {
  readonly credentialDirs: readonly string[]
  /** Where transcripts (conversation logs) are kept. Taken into the index read-only (12.7). */
  readonly transcriptDir: string
  /**
   * The forms allowed to be read within `credentialDirs` (item 254). `common/exclusions.ts` reads the JSON
   * directly and turns it into rules. It is held here only for the type.
   */
  readonly readOnlyIncludes?: readonly string[]
  /** Of `readOnlyIncludes`, the forms for which the viewer's save is also allowed (the user's skill SKILL.md). */
  readonly writableIncludes?: readonly string[]
  /** Where auto memory is kept (`<transcriptDir>/<encoded cwd>/<memorySubdir>`, item 254). */
  readonly memorySubdir?: string
  /** Where the worktree for each parallel bundle is kept (`<repo>/<this path>/<name>`, TODO 633). It starts with `/`. */
  readonly worktreesPathSuffix?: string
  /** Where skills are kept (TODO 773). */
  readonly skills?: {
    /** The user's skill directory (may start with `~/`). */
    readonly userRoot: string
    /** Relative to the working folder. The project's skill directory. */
    readonly projectRootSuffix: string
    /** The skill's body file name. */
    readonly file: string
    /** The list of installed plugins (only `installPath` is read). */
    readonly pluginsManifest: string
    /** Relative to the plugin's `installPath`. */
    readonly pluginSkillsSubdir: string
  }
  /** The CLI plugin catalog (TODO 1099). The list of installed plugins is `skills.pluginsManifest`. */
  readonly pluginCatalog?: {
    /** The catalog cache the CLI keeps (may start with `~/`). */
    readonly directoryCache: string
    /** The list of registered marketplaces. */
    readonly knownMarketplaces: string
    /**
     * The official marketplace's `marketplace.json` (re-resolves the name to install from the source, TODO 1177). `<marketplace>` is filled in
     * with `plugins.marketplace` (`marketplaceManifestPath`. The name has one source of truth in the table).
     */
    readonly marketplaceManifest: string
  }
}

let cachedPaths: BackendPaths | null = null

/** The backend-specific path table. An entry point to keep knowledge of locations inside compat/ (constraint 6). */
export function loadBackendPaths(): BackendPaths {
  if (cachedPaths !== null) return cachedPaths
  for (const dir of candidateDirs()) {
    try {
      cachedPaths = JSON.parse(readFileSync(join(dir, 'backend-paths.json'), 'utf8')) as BackendPaths
      return cachedPaths
    } catch {
      // Go on to the next candidate.
    }
  }
  throw new Error('backend paths table not found')
}

/** For tests. */
export function setCompatTableForTest(table: CompatTable | null): void {
  cached = table
}

function completeMap(partial: Partial<AgentFeatureMap>, fallback: boolean): AgentFeatureMap {
  const out = {} as Record<AgentFeature, boolean>
  for (const feature of AGENT_FEATURES) out[feature] = partial[feature] ?? fallback
  return out
}

export interface FeatureLookup {
  readonly features: AgentFeatureMap
  readonly source: 'known-version' | 'probe'
}

/**
 * Looks up the feature table from a version string.
 * If it is not in the table, returns `unknownVersionDefaults`, and the caller overrides it by probing.
 */
export function featuresForVersion(table: CompatTable, version: string | null): FeatureLookup {
  const entry = version === null ? undefined : table.versions[version]
  if (entry !== undefined) {
    return { features: completeMap(entry.features, false), source: 'known-version' }
  }
  return { features: completeMap(table.unknownVersionDefaults, false), source: 'probe' }
}

/** Extracts the version number from the output of `--version`. The form is `"2.1.207 (Claude Code)\n"` (spike 6). */
export function parseVersion(stdout: string): string | null {
  const match = /^(\d+\.\d+\.\d+)/.exec(stdout.trim())
  return match?.[1] ?? null
}

/** Comparison of the `2.1.207` form. true if a >= b. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/** Builds the name that points to the gateway's tool. The `mcp__aios__approve` form. */
export function approveToolName(table: CompatTable): string {
  return table.mcp.toolNamePattern
    .replace('{server}', table.mcp.serverName)
    .replace('{tool}', table.mcp.approveTool)
}

/**
 * Extra instructions added to the CLI on a launch that passes the gateway (TODO 822, ARCHITECTURE 7.6.2). null if absent from the table or empty.
 * Replaces `{tool:<name>}` with the name of the gateway's tool (in the `mcp__aios__openUrl` form), and `{helpDir}` with the folder the copy of
 * Help is written to (TODO 1263: `~/<data name>/help`; the default is the identity fixed at launch).
 */
export function gatewayInstructions(
  table: CompatTable,
  helpDir: string = `${homeDataDirDisplay()}/help`,
  appName: string = PRODUCT_NAME
): string | null {
  return fillInstructionLines(table, table.mcp.instructions, helpDir, appName)
}

/**
 * TODO 1296: the short self-introduction of the app (what the conversation runs in, where to read about it). Unlike `gatewayInstructions` it does not
 * depend on the gateway. Fixed text: the product name and the Help folder only, no user text, time or session value. null if absent from the table or empty.
 */
export function appIntroductionText(
  table: CompatTable,
  helpDir: string = `${homeDataDirDisplay()}/help`,
  appName: string = PRODUCT_NAME
): string | null {
  return fillInstructionLines(table, table.mcp.introduction, helpDir, appName)
}

function fillInstructionLines(
  table: CompatTable,
  source: readonly string[] | undefined,
  helpDir: string,
  appName: string
): string | null {
  const lines = (source ?? []).map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return null
  return lines
    .map((line) =>
      line
        .replace(/\{tool:([A-Za-z0-9_]+)\}/g, (_, tool: string) =>
          table.mcp.toolNamePattern.replace('{server}', table.mcp.serverName).replace('{tool}', tool)
        )
        .replaceAll('{helpDir}', helpDir)
        .replaceAll('{app}', appName)
    )
    .join('\n')
}

/**
 * Extra instruction to make the body of a Gmail draft fixed-width (TODO 1229). Added after the gateway's instructions only when the setting is `monospace`
 * (`default` is null = add nothing). Fixed text, with no time, path or conversation values. The connector (Gmail's `create_draft`) is read by the CLI
 * as is (constraint 7), so aios does not build the body; it conveys this as a request to the model. A different instruction inside the conversation wins.
 */
export function gmailDraftFontInstruction(font: GmailDraftFont | undefined): string | null {
  if (font !== 'monospace') return null
  return [
    'When you create a Gmail draft with the Gmail connector, use its htmlBody parameter and wrap the whole body',
    'in an element styled with `font-family: monospace` (for example `<div style="font-family: monospace; white-space: pre-wrap">…</div>`).',
    'Also pass the same text in the plain body parameter as the plain-text alternative.',
    'If the user asks for a different font or format for a draft in the conversation, follow the user instead.'
  ].join(' ')
}

/**
 * TODO 972: the frame around a role's (Teammate's) standing instructions, added to the same extra-instructions entry point as the
 * gateway text. The user's text follows as written. null when there is nothing to add.
 */
export function roleInstructionsText(text: string | undefined): string | null {
  if (text === undefined || text.trim() === '') return null
  return [
    `This conversation belongs to a teammate the user set up in ${PRODUCT_NAME}. The user gave these standing instructions for all of its conversations;`,
    'follow them unless the user says otherwise in the conversation:',
    text
  ].join('\n')
}

export function flag(table: CompatTable, key: string): string {
  const value = table.flags[key]
  if (typeof value !== 'string') throw new Error(`compat: flag ${key} is not a string`)
  return value
}

/**
 * The CLI value corresponding to one level (TODO 1205). A named level goes through the table (`thinkingLevels`); a level with no name (`effort:<value>`) passes
 * the value to effort as is. A level not in the table is empty (= pass nothing).
 */
export function thinkingEntry(table: CompatTable, level: ThinkingLevel): ThinkingEntry {
  if (isExtraThinkingLevel(level)) return { effort: extraThinkingValue(level) }
  const entry = (table.thinkingLevels as Readonly<Record<string, ThinkingEntry | undefined>>)[level]
  return isRecordEntry(entry) ? entry : {}
}

function isRecordEntry(value: unknown): value is ThinkingEntry {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Expands a `ThinkingLevel` into the CLI's argument list. A level not in the table passes nothing. */
export function thinkingArgs(table: CompatTable, level: ThinkingLevel): readonly string[] {
  const entry = thinkingEntry(table, level)
  const args: string[] = []
  if (entry.effort !== undefined) args.push(flag(table, 'effort'), entry.effort)
  if (entry.thinking !== undefined) args.push(flag(table, 'thinking'), entry.thinking)
  return args
}

export function flagList(table: CompatTable, key: string): readonly string[] {
  const value = table.flags[key]
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return [value]
  throw new Error(`compat: flag ${key} missing`)
}
