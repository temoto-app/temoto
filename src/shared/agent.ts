/**
 * Vocabulary of the agent execution layer (ARCHITECTURE.md 4.6 / 4.6.1).
 *
 * **Only backend-independent concepts go here.** Do not leak the tool names, flag names or event names
 * of a specific backend (constraint 6; checked by lint). Translating to a concrete backend is done by the
 * Adapter (`src/main/session/adapter/`).
 */

/** A value that can be passed as JSON. Represents structured payloads without `any` (constraint: no `any` in shared). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Unit of feature detection (4.6). Callers **never branch on a version number**.
 * The mapping to the table in ARCHITECTURE.md 4.6 is written in the known-version table in `compat/`.
 */
export type AgentFeature =
  /** Round trips with structured input and output. Without this the backend cannot be started. */
  | 'structured-io'
  /** Images can be attached to an input message (path (b) of the D&D in 4.5) */
  | 'image-input'
  /** The permission prompt can be answered by an aios tool (4.2) */
  | 'permission-prompt-tool'
  /** The permission mode can be set explicitly */
  | 'permission-mode'
  /** Resuming an existing session */
  | 'resume'
  /** Adding readable directories (4.4). This is the range readable without approval. */
  | 'extra-dirs'
  /**
   * The aios MCP gateway can be passed (7.6). The gateway is **always** passed, and the user's MCP servers are
   * read by the CLI itself, as in the stock CLI (item 110, 2026-09-27; the former `strict-mcp-config` was
   * removed from the feature table)
   */
  | 'mcp-config'
  /** Incremental deltas of the response can be received (5.1) */
  | 'partial-messages'
  /** Subagent messages are forwarded (4.6) */
  | 'subagent-text'
  /** The model can be chosen at launch (T5). The list is `AgentAdapter.listModels()` */
  | 'model-select'
  /** The thinking depth can be chosen at launch (T5). The levels are `ThinkingLevel` */
  | 'thinking-level'
  /**
   * model / thinking can be switched on the running process (item 95, 4.5.1). Without it, every switch
   * stops the process and starts it again with resume. It is not a flag, so the probe does not check it
   * (only the known-version table makes it true)
   */
  | 'live-settings'
  /**
   * Rewind (item 113, 4.5.6): it can receive the id of a user message (flag), go back to a file checkpoint
   * (control request), and start a new session branching from the point of a message (flag).
   * The flags can be checked by the probe. Without it, "rewind to here" is not shown
   */
  | 'rewind'
  /**
   * OS-level sandbox (TODO 1106, ARCHITECTURE 4.2.4): a single launch setting makes the backend itself enforce the write range of
   * shell tools and the network allow table. True only for verified versions; the default for unknown versions is false (even when degraded,
   * behavior stays as it is today: it never falls onto a path that skips approval). If it turns out to be unusable at launch, the Adapter turns it off and reports the reason
   */
  | 'os-sandbox'
  /**
   * A Teammate's standing instructions (TODO 972 / 1288, ARCHITECTURE 4.3.4) can be passed at launch (`SpawnOptions.roleInstructions`).
   * A backend without this ignores them: it is shown grayed out in "what this backend can do", with the reason beside the field in the Teammate editor
   */
  | 'standing-instructions'

export const AGENT_FEATURES: readonly AgentFeature[] = [
  'structured-io',
  'image-input',
  'permission-prompt-tool',
  'permission-mode',
  'resume',
  'extra-dirs',
  'mcp-config',
  'partial-messages',
  'subagent-text',
  'model-select',
  'thinking-level',
  'live-settings',
  'rewind',
  'os-sandbox',
  'standing-instructions'
]

/**
 * "What this backend can do" as shown to the user (TODO 987, ARCHITECTURE 4.6.1.1). The 14 features of the feature table
 * (`AgentFeature`) bundled roughly into 4. **A missing capability is shown grayed out, not removed**: neutrality must not be reduced to the lowest common denominator.
 */
export type BackendCapabilityKey = 'approval' | 'subagents' | 'rewind' | 'mcp' | 'instructions'

export const BACKEND_CAPABILITY_KEYS: readonly BackendCapabilityKey[] = ['approval', 'subagents', 'rewind', 'mcp', 'instructions']

export type BackendCapabilities = Readonly<Record<BackendCapabilityKey, boolean>>

/** approval = the approval entry point (`permission-prompt-tool`), subagents = forwarding of messages, rewind = `rewind`, MCP = the aios gateway can be passed, instructions = `standing-instructions` (TODO 1288). */
export function capabilitiesOf(features: Readonly<Record<AgentFeature, boolean>>): BackendCapabilities {
  return {
    approval: features['permission-prompt-tool'],
    subagents: features['subagent-text'],
    rewind: features['rewind'],
    mcp: features['mcp-config'],
    // TODO 1288: a Teammate's standing instructions reach the backend (grayed out for a backend that ignores them).
    instructions: features['standing-instructions']
  }
}

/**
 * A model choice (T5). **`id` is opaque**; the aios core does not interpret it.
 * The actual identifiers and the list live only in the table in `compat/` (constraint 6). An invalid id does not
 * fail at launch; the `result` of the first turn becomes an error (4.6.2).
 */
export interface ModelChoice {
  readonly id: string
  /**
   * Display name. "Opus 4.8" if the Adapter knows the version, only the name ("Opus") otherwise
   * (item 91). It is a proper noun, so it is shown as is, not through the dictionary (7.4.4).
   */
  readonly label: string
  /**
   * Short display name for a narrow Composer (container 400px wide or less) (item 309-1). The name without
   * the version ("Opus"). If it is the same as `label` or omitted, nothing is switched. The switch is done by a CSS container query
   * (`segmentLabels` / `.seg-short`), so a wide pane looks the same.
   */
  readonly shortLabel?: string
  /**
   * The thinking levels that **take effect** for this model (item 92). A subset of the order of `THINKING_LEVELS`,
   * never empty. The UI disables the levels not included, and snaps the selected level with
   * `nearestThinkingLevel`. Omitted means "all can be chosen" (an Adapter with no table).
   */
  readonly thinkingLevels?: readonly ThinkingLevel[]
  /**
   * A model where effort has no effect (Haiku, item 92). When true, the Thinking button is effectively a
   * two-way "off / on", and the label of the on side (`FALLBACK_THINKING`) is rephrased to `thinking.on`
   * (the "normal" of `thinking.medium` is not used: do not show a level name when there are no levels).
   * Omitted or false shows the usual level names.
   */
  readonly thinkingBinary?: boolean
  /**
   * A version-pinned model (TODO 769). Among the list reported by the backend, the ones that are not aliases (the "always latest" top row).
   * The Composer shows it in the "Other" menu, not in the top row of buttons. Omitted or false means the top row.
   */
  readonly pinned?: boolean
  /**
   * A model that cannot be used with the current backend version (TODO 769, the backend needs an update). It is only shown as a grayed-out
   * row that cannot be selected, and main also refuses the selection (`model-not-selectable`).
   */
  readonly unavailable?: boolean
  /**
   * A choice that pins the version of the same model that a top-row button (an alias of this id) currently points to (TODO 1204).
   * It overlaps the top-row button, so it is not shown in the Composer menu or the settings list; **only when selected** it is shown
   * with a "pinned" mark (a thread where a version pinned with the dropdown earlier later became the target of the top-row badge). `pinned` is also true.
   */
  readonly sameAs?: string
}

/** Named thinking depth (T5 / TODO 1205), shallowest first. `xhigh` / `max` are levels above "deep". */
export type KnownThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * A level without a name returned by the backend (TODO 1205). What follows `effort:` is the backend's value as is,
 * and aios does not interpret it (it is shown on the badge as is). A container so that it can be chosen rather than dropped.
 */
export type ExtraThinkingLevel = `effort:${string}`

/**
 * Thinking depth (T5). The mapping to the backend's two axes (mode and effort) is decided in the
 * table in `compat/`. `null` (unspecified) is the backend default.
 */
export type ThinkingLevel = KnownThinkingLevel | ExtraThinkingLevel

/** All named levels (shallowest first). The default setting and the queued choice list these. */
export const THINKING_LEVELS: readonly KnownThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The levels always listed in the Composer (TODO 1205). Shown disabled (struck through) when the model does not support them.
 * Levels above these (`xhigh` / `max` / unnamed levels) are added to the right of "deep" only when the model supports them.
 */
export const BASE_THINKING_LEVELS: readonly KnownThinkingLevel[] = ['off', 'low', 'medium', 'high']

const EXTRA_PREFIX = 'effort:'
/** The form allowed for the value of an unnamed level (the backend's vocabulary is passed without validation, but malformed or too long values are dropped). */
const EXTRA_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/

/**
 * The "default" choice was abolished (item 61), so the UI always has one concrete level selected.
 * The level the UI picks when neither the settings nor the thread has a value (old rows).
 */
export const FALLBACK_THINKING: KnownThinkingLevel = 'medium'

export function isExtraThinkingLevel(value: unknown): value is ExtraThinkingLevel {
  return typeof value === 'string' && value.startsWith(EXTRA_PREFIX) && EXTRA_VALUE.test(value.slice(EXTRA_PREFIX.length))
}

/** Makes an unnamed level from a backend value (TODO 1205). Null if the form is malformed. */
export function extraThinkingLevel(value: string): ExtraThinkingLevel | null {
  return EXTRA_VALUE.test(value) ? `${EXTRA_PREFIX}${value}` : null
}

/** The backend value of an unnamed level (shown on the badge as is). */
export function extraThinkingValue(level: ExtraThinkingLevel): string {
  return level.slice(EXTRA_PREFIX.length)
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    (typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)) ||
    isExtraThinkingLevel(value)
  )
}

/** Position in the order. An unnamed level counts as deeper than all named levels (TODO 1205). */
function thinkingRank(level: ThinkingLevel): number {
  const index = (THINKING_LEVELS as readonly string[]).indexOf(level)
  return index < 0 ? THINKING_LEVELS.length : index
}

/**
 * If `level` is not in `selectable`, snap it to the nearest selectable level (item 92).
 * Nearness is the distance in the order of `THINKING_LEVELS` (an unnamed level is on the deepest side); on a tie the **shallower side** wins
 * (TODO 1205: when changing the model removes a level, take the nearest lower one: for a model without xhigh (the 4.6 family: low / medium / high / max),
 * Deeper -> Deep, not Max). But if the shallower side is "off", the deeper side wins (do not lose the intent of asking for thinking):
 * on Opus "off" -> "low"; on a model where only "low" has no effect, "medium". If `selectable` is empty there is nothing to snap to, so the input is returned as is.
 * The Composer display and the validation of the value stored by SessionManager use this same function.
 */
export function nearestThinkingLevel(
  level: ThinkingLevel,
  selectable: readonly ThinkingLevel[]
): ThinkingLevel {
  if (selectable.length === 0 || selectable.includes(level)) return level
  const at = thinkingRank(level)
  let best: ThinkingLevel = level
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of selectable) {
    const index = thinkingRank(candidate)
    const distance = Math.abs(index - at)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
      continue
    }
    if (distance !== bestDistance) continue
    // Tie in distance: the shallower side. But "off" is never chosen (take the deeper side).
    const shallower = index < thinkingRank(best) ? candidate : best
    const deeper = shallower === candidate ? best : candidate
    best = shallower === 'off' ? deeper : shallower
  }
  return best
}

/**
 * Origin of the settings the backend reads (4.2 / 4.6.2 / 4.6.4).
 * - `user`: the user's global settings (allow rules, hooks, additional read ranges, skills, etc.).
 * - `project`: the project settings of the working directory and the **instruction files**.
 * - `local`: the project's local overrides (`*.local.md` / `settings.local.json`).
 *
 * **Since item 109 (2026-09-27) aios does not specify the origin**: as with the stock CLI, the CLI itself reads
 * all three (matching VS Code + CLI). This type only remains in the `threads.setting_sources` column
 * (a record) and in the ownership of instruction files (`compat/`), and is not used for launching.
 */
export type SettingSource = 'user' | 'project' | 'local'

export const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local']

/**
 * The value recorded in a new thread's row = all three, same as the stock CLI (item 109). **Not read at launch**
 * (the column is a place to keep in case we want to split them again later). It used to be `['project']`.
 */
export const DEFAULT_SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local']

export function isSettingSource(value: unknown): value is SettingSource {
  return typeof value === 'string' && (SETTING_SOURCES as readonly string[]).includes(value)
}

export type AgentFeatureMap = Readonly<Record<AgentFeature, boolean>>

/** What was degraded when a feature is unavailable. Shown on the settings screen with the reason (4.6). */
export interface AgentDegradation {
  readonly feature: AgentFeature
  /** The adapter's wording (Japanese). **Keep it**: the fallback when there is no `code` (TODO 66). */
  readonly reason: string
  /**
   * A token for when `reason` can be expressed with a reason code. The "carried as a value" form (`shared/reason.ts`):
   * the string of `formatReason(code, params)` (the code itself if the token has no interpolated values).
   * The renderer turns it into wording with `describeReason`.
   */
  readonly code: string | null
}

/**
 * TODO 1019: the state of one registry backend, listed on the settings screen. `primary` is the default backend
 * (the one the detailed section "agent CLI" in settings shows). The one-line status such as Ollama's is `status.messageCode`
 * (a note when available).
 */
export interface BackendStatusRow {
  readonly id: string
  readonly label: string
  readonly primary: boolean
  readonly status: AgentStatus
}

/** The backend state. Used by the settings screen and for deciding whether it can start. */
export interface AgentStatus {
  /** Whether the executable was found and the version could be read. */
  readonly available: boolean
  readonly version: string | null
  /** Login state (chapter 2. The credentials themselves are never touched). */
  readonly loggedIn: boolean
  /**
   * Authentication method and plan type. **Display only; never branch or steer on the method** (constraint 3).
   * Null if it cannot be obtained.
   */
  readonly authMethod: string | null
  readonly subscriptionType: string | null
  /**
   * Email address of the logged-in account (item 317, "Account and usage" on the settings screen).
   * Taken from the output of the same public subcommand as login detection (constraint 2). Omitted / null if unavailable.
   */
  readonly email?: string | null
  readonly features: AgentFeatureMap
  readonly degradations: readonly AgentDegradation[]
  /** Whether it was in the known-version table or decided by the probe. */
  readonly source: 'known-version' | 'probe' | 'unavailable'
  /**
   * The feature table has not yet been verified in the field (item 81). True for an unknown version when there is
   * neither a probe result nor a cache and no probe has been tried yet in this launch. Until then `features` holds
   * provisional values (`unknownVersionDefaults` of the table), and SessionManager runs
   * the probe once before the first send.
   */
  readonly needsProbe: boolean
  readonly checkedAt: number
  /**
   * The reason when available=false (executable missing, etc.). The adapter's wording (Japanese).
   * **Keep it**: the fallback when there is no `messageCode` (such as a probe-failure diagnostic) (TODO 66).
   */
  readonly message: string | null
  /**
   * A token for when `message` can be expressed with a reason code (the "carried as a value" form of `shared/reason.ts`).
   * The renderer turns it into wording with `describeReason`.
   */
  readonly messageCode: string | null
  /**
   * TODO 529 stage 2: supplementary guidance when usable (a list of reason codes, turned into wording by `describeReason`). Shown one per line under `messageCode` in the settings section.
   * Guidance about the provider (which ones are usable / what to do to use one) and so on, added by the backend as it likes. Omitted if none.
   */
  readonly notes?: readonly string[]
}

// ---- Events ----------------------------------------------------------------

/**
 * Normalized event kinds (4.6).
 *
 * Additions in Phase 2 to the skeleton of 4.6:
 * - `session_started`: the backend's session-start notice. Needed to link a resume.
 * - `assistant_delta` / `thinking_delta`: incremental rendering (5.1). **Not persisted.**
 * - `rate_limit`: the usage indicator (12.2).
 * - `turn_usage`: token usage per API call (item 60, 4.5.2). A line separate from the
 *   response body; **the last one to arrive is "the current context size"**.
 * - No `permission_decision` is made; the outcome is carried in the payload of `permission_request`.
 * - `subtask_started` / `subtask_progress` / `subtask_finished`: start, progress and end of the work
 *   the backend runs in the background (subagents and tool execution) (item 93, 4.6.3). They do not
 *   include the body of messages.
 * - `conversation_reset` / `context_compacted`: conversation boundaries (item 117, 4.5.3.1).
 *   The former means the conversation before this point no longer reaches the model (a new conversation); the latter means it was shrunk by summarizing.
 * - `user_replay`: a message the backend sent, **reflected back with an identifier** (item 113, 4.5.6).
 *   The body is the same as the `user_text` that aios recorded itself, and it is **not persisted**: SessionManager copies `messageId`
 *   onto the matching `user_text` and then discards it.
 * - `hook_run`: one hook from the user / project settings finished running (item 126-3, 4.6.2 (10)).
 *   Only the name, event and result; **it does not carry the hook's output (stdout / stderr / output)** (owner decision
 *   2026-09-27: "show it in one line, do not store the output"; same treatment as `tool_result` in constraint 10).
 * - `commands_changed`: the list of usable commands changed while running (the rest of item 117,
 *   `/reload-plugins` and the like). Only the list of names; it replaces the `commands` of `session_started`.
 * - `skill_loaded`: when a skill is used, **only the URI of the main file**, read from the line where the backend poured in the body
 *   (TODO 1105, 5.1.9). It carries no body. It makes the badge of the preceding skill call "open the main file when clicked".
 */
export type AiosEventKind =
  | 'session_started'
  | 'settings_changed'
  | 'user_text'
  | 'user_replay'
  | 'assistant_delta'
  | 'assistant_text'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'result'
  | 'turn_usage'
  | 'rate_limit'
  | 'error'
  | 'subtask_started'
  | 'subtask_progress'
  | 'subtask_finished'
  | 'subtask_backgrounded'
  | 'conversation_reset'
  | 'context_compacted'
  | 'shell_run'
  | 'hook_run'
  | 'commands_changed'
  | 'skill_loaded'
  | 'tool_progress'
  | 'api_retry'
  | 'vcs_state_changed'
  | 'worktree_changed'
  | 'mcp_connecting'
  | 'background_tasks'
  | 'outside_write'
  | 'unknown'

/** The author of a message. Subagent messages are folded under the parent's tool call (4.6). */
export type AiosActor = 'main' | 'subagent'

interface AiosEventBase {
  readonly id: string
  /** The aios-internal session ID. The backend's ID is in the payload of session_started. */
  readonly sessionId: string
  readonly threadId: string
  readonly ts: number
  /** The parent tool call that produced this message. The parent-child relation of the subagent hierarchy. */
  readonly parentToolUseId?: string
  readonly actor: AiosActor
}

export interface SessionStartedPayload {
  readonly backendSessionId: string
  readonly backendVersion: string | null
  readonly model: string | null
  readonly cwd: string | null
  /** The permission mode the backend reported. **It may come back under an alias, so do not use it for decisions** (4.6). */
  readonly reportedPermissionMode: string | null
  readonly tools: readonly string[]
  /** Names of the connected MCP servers (including the gateway). The probe uses it to check the gateway connection. */
  readonly toolServers: readonly string[]
  /**
   * Names and states of MCP servers (item 110 / 4.6.4). The gateway is included (`gateway: true`).
   * The user's servers (user / project registrations, bundled with a plugin, vendor connectors) are
   * read by the CLI, as in the stock CLI, since `--strict-mcp-config` was dropped. Absent from rows before item 110.
   */
  readonly mcpServers?: readonly McpServerReport[]
  /**
   * A server with the same name as the gateway also exists in the user's settings (item 110). There are 2 or more by name,
   * or the row with the gateway's name came from something other than the gateway's origin (`--mcp-config`). Which one wins has
   * not been measured, so this is only shown as a warning.
   */
  readonly gatewayConflict?: boolean
  /** Whether it started by resume or is a new session. */
  readonly resumed: boolean
  /**
   * Names of the commands usable in this session (item 68, without the leading `/`). The Composer uses it for
   * "do not send a `/xxx` that is not in the list" and for completion candidates. Null if the backend did not
   * report (= cannot decide, so do not block). Only the Adapter reads the actual names (constraint 6).
   * Absent from old rows (saved before item 68), so readers treat `undefined` as null too.
   */
  readonly commands?: readonly string[] | null
  /**
   * Of those, the names of skills (canned instructions of the user, project or plugin) (TODO 564, without the leading `/`).
   * The same names are also in `commands`; this is used only to put a "skill" badge in the Composer's `/` completion to tell them apart.
   * Absent in versions that do not report it and in old rows (`undefined` / null means "unknown" = no badge).
   */
  readonly skills?: readonly string[] | null
}

/**
 * State of one MCP server (item 110, from `system/init`). `state` is neutral vocabulary;
 * the Adapter maps the backend's state names onto it (unknown values become `other`). `source` is opaque
 * (the backend's origin name as is, null if none) and is used only for display.
 */
export type McpServerState = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'other'

/**
 * Origin category of an MCP server (item 164, 4.6.4 "how it is shown"). The Adapter maps it from the raw value of `source`.
 * - `global`: the same in every thread (vendor connectors, user registrations, bundled with a plugin, distributed by an administrator).
 *   Shown in the "MCP servers" section of settings, and in a thread's heading only on failure.
 * - `folder`: varies with the cwd (the project's `.mcp.json`, local registrations). Shown in the thread's heading.
 * - `unknown`: a value not in the table, or an old CLI with no `source`. **Lean toward the heading side** (showing is safer than hiding).
 */
export type McpServerScope = 'global' | 'folder' | 'unknown'

export interface McpServerReport {
  readonly name: string
  readonly state: McpServerState
  readonly source: string | null
  /** Whether it is aios's own gateway. Excluded from the badge list and from the settings screen. */
  readonly gateway: boolean
  /**
   * Origin category (item 164). Absent from a `session_started` saved before item 164,
   * so readers treat `undefined` as `unknown` (it leans toward the heading side).
   */
  readonly scope?: McpServerScope
}

/** One global-side server shown on the settings screen (item 164). It has no gateway and no category (all are `global`). */
export interface McpGlobalServer {
  readonly name: string
  readonly state: McpServerState
  readonly source: string | null
}

/**
 * The latest report of global-side MCP servers (item 164, `mcp.lastGlobalReport` in `app_settings`).
 * main rewrites it each time a session starts (`session_started`) in any thread.
 * `at` is the time of that report (ms). The state is "the state in the last session seen"; no new process is started.
 */
export interface McpGlobalReport {
  readonly at: number
  readonly servers: readonly McpGlobalServer[]
}

const MCP_SERVER_STATES: readonly McpServerState[] = [
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled',
  'other'
]

export function isMcpServerState(value: unknown): value is McpServerState {
  return typeof value === 'string' && (MCP_SERVER_STATES as readonly string[]).includes(value)
}

/**
 * Switching model / thinking (T7, 4.5.1).
 *
 * Values are neutral vocabulary, and `modelId` is opaque (the real strings are held only by `compat/` and the Adapter, constraint 6).
 * `scope` distinguishes "this message only" (`message`) from "from now on" (`thread`);
 * with `thread`, `threads.model_id` / `thinking` have been rewritten at the same time.
 */
export interface SettingsChangedPayload {
  readonly modelId: string | null
  readonly thinking: ThinkingLevel | null
  readonly scope: 'message' | 'thread'
  /**
   * How the running process was switched (item 95). `live` = switched without stopping,
   * `restart` = stopped and started again with resume, `none` = there was no running process
   * (the next launch will start with this setting). Absent from rows before item 95.
   */
  readonly via?: 'live' | 'restart' | 'none'
}

/**
 * An image attached to a sent message (TODO 550, `attachments` of `user_text`). Shown as a thumbnail on the user's own message in the timeline.
 *
 * - `uri`: an attachment that points to a file (a Finder drop, a path reference). Only the **path** is kept, and it is read each time it is
 *   displayed via `aios-res://` (`threads.attachmentImage`). No copy of the body is kept (constraint 9).
 * - `thumbnail`: only for an image with no file (a clipboard paste `aios-clipboard:`, an image in an excluded
 *   temporary folder; TODO 489). A reduced version with a long side of up to 1600 px as a data URL (`data:image/(webp|jpeg|png);base64,…`).
 *   The original size is not kept (owner decision 2026-10-09).
 *
 * If neither exists, only the name (a thumbnail could not be made). `ThreadStore.toPersistable` re-checks it on save.
 */
export interface SentAttachment {
  readonly name: string
  readonly uri?: string
  readonly thumbnail?: string
}

export interface TextPayload {
  readonly text: string
  /** Images sent (TODO 550). Only on `user_text`, and only when there was an attachment. */
  readonly attachments?: readonly SentAttachment[]
  /**
   * Identifier of the message on the backend side (item 113, 4.5.6). The key for rewind: for `user_text` it means "the file checkpoint
   * just before this message", and for `assistant_text` "branch from the conversation up to this message".
   * An opaque string. Absent from rows before item 113 and from rows of backend versions that do not support it.
   */
  readonly messageId?: string
}

/**
 * Reflection of a sent message (item 113). `messageId` is the identifier given to that message, and `text` is the reflected body
 * (should be the same as the body of the `user_text` aios sent; used for matching).
 */
export interface UserReplayPayload {
  readonly messageId: string
  readonly text: string
}

/**
 * Kind of progress report (5.1.3 / TODO 15). **Backend-neutral vocabulary**; the
 * table mapping tool name -> kind is held only by `compat/` and the adapter (constraint 6).
 */
export type ToolProgressKind = 'search' | 'fetch' | 'file' | 'other'

/**
 * One line of "what is being looked at now". main (the adapter) builds it from `tool_use` and passes it.
 * The renderer only lines them up and does not infer a kind from the tool name.
 */
export interface ToolProgressHint {
  readonly kind: ToolProgressKind
  /**
   * A short string for display. A search term / a shortened URL / "parent directory name/file name".
   * **Never the path itself** (the rule that paths are not shown in the renderer).
   * An empty string is folded into one line as "other operations".
   */
  readonly label: string
  /**
   * Where a click goes. `file:` goes to the ViewerPane, `http(s):` to the external browser (5.1.1).
   * Not set when the target is uncertain (only things actually read can be clicked).
   */
  readonly href?: string
}

/**
 * One row of the work list (item 118, 4.6.5). **Neutral vocabulary**; which tool and which argument it is built from
 * is known only to `compat/` and the adapter (constraint 6).
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  /** The sentence of what to do (imperative). Saved after redaction. */
  readonly content: string
  /** The sentence shown while in progress (progressive form). Null if none (`content` is shown). */
  readonly activeForm: string | null
  readonly status: TodoStatus
}

export interface ToolUsePayload {
  readonly toolUseId: string
  readonly name: string
  /**
   * One-line summary used for display and storage (path, command string, query).
   * Does not include the body of huge arguments (4.3.1).
   */
  readonly summary: string
  /** Only the main arguments are kept. Long values are already truncated. Already redacted. */
  readonly input: JsonValue
  /** Whether the arguments were truncated. Kept so the UI can show "omitted". */
  readonly truncated: boolean
  /**
   * One line of the progress report (5.1.3). It is also stored (it is on the `tool_use` side, so it does not touch constraint 10).
   * Absent from rows saved before this feature, so **optional**.
   */
  readonly progress?: ToolProgressHint
  /**
   * If this tool call rewrites the work list, the whole list after the rewrite (item 118).
   * The adapter attaches it only to calls of the parent (`actor: 'main'`); a subagent's work list
   * is not pinned in the display (owner decision 2026-09-27). Absent from rows before item 118, so optional.
   */
  readonly todos?: readonly TodoItem[]
  /**
   * If this tool call presents a plan, the full text of the plan body (Markdown) (item 167). `input` is
   * truncated when saved, so this is kept separately. A plan the AI produces on its own while Plan is still OFF passes without going
   * through the approval box, so this field is all that remains in the timeline. `toPersistable` applies redaction.
   * Absent from rows before item 167, so optional.
   */
  readonly plan?: string
  /**
   * If this is a tool call that enters or leaves plan mode, its direction (item 275). `enter` = entering, `exit` = presenting the plan /
   * leaving. The timeline shows a line like `Entered plan mode` instead of an ordinary tool row. Absent from rows before item 275.
   */
  readonly planTransition?: 'enter' | 'exit'
  /** The path of the plan file in the input of `exit` (item 275). Omitted if none ("Plan saved to" is not shown). */
  readonly planFile?: string
  /**
   * Identifier of the response that contains this call (item 113). The starting point of a branch is "the response just before the user's message",
   * and a turn can end with a tool call, so it is kept just like for `assistant_text`.
   */
  readonly messageId?: string
  /**
   * For a call that starts a subagent, the model the parent specified, if any (TODO 403). An opaque value
   * (a backend alias); main asks the Adapter to convert it to a display name. It is only a provisional
   * display until the subagent's first message arrives, so it is **not stored** (`toPersistable` does not pick up the field).
   */
  readonly subagentModel?: string
  /**
   * If this call used a skill, the name of that skill (TODO 1100). A plugin skill stays in the form
   * `<plugin>:<skill>`. Tool names and argument keys are backend-specific, so the adapter converts them into a neutral field
   * (constraint 6). **Attached only to calls of the parent (`actor: 'main'`)** (stage 1). It is a field on the `tool_use` side, so it is stored
   * (it does not touch constraint 10). Different from "the list of usable skills" (`SessionStartedPayload.skills`).
   * Absent from rows before TODO 1100, so optional.
   */
  readonly skill?: string
}

/** Location of a skill's main file (TODO 1105). It carries no body (constraints 9 / 10). */
export interface SkillLoadedPayload {
  /** The `file://` URI of SKILL.md. */
  readonly uri: string
}

/**
 * A tool result. **Not persisted** (constraint 10). `text` is for display in a live session only and is
 * dropped just before writing to the DB. After a restore, it is drawn from `bytes` as "omitted (N KB)" (4.3.1).
 */
export interface ToolResultPayload {
  readonly toolUseId: string
  readonly ok: boolean
  readonly bytes: number
  readonly text?: string
}

/**
 * A record of the event that the automatic pick of the recommendation went through (TODO 1230). Kept in the outcome `outcome` of the resolution so that the timeline's question badge
 * can read "question, options, recommendation, chosen answer, picked automatically". **No sentences go into the structured log** (`approval.auto-pick.applied` has only the count and position).
 */
export interface AutoPickRecord {
  readonly question: string
  /** Labels of the options shown (in the order shown). */
  readonly options: readonly string[]
  /** Position of the option marked as recommended (0-based). */
  readonly recommended: number
  /** Position of the option actually chosen (0-based). */
  readonly chosen: number
  /** Time from when the question appeared until one was chosen (milliseconds). */
  readonly waitedMs: number
}

/** The outcome of an approval. Distinguishes a refusal due to main stopping from a refusal by the user (4.2 / 7.6). */
export type ApprovalOutcome =
  | { readonly kind: 'pending' }
  /** `default` is an automatic allow by the default allow list (T12 / 4.2). Distinguished for auditing. */
  | {
      readonly kind: 'allowed'
      readonly by: 'user' | 'rule' | 'default'
      /**
       * When a multiple-choice question was answered, the wording of that answer (T31 / 4.2.2).
       * Only so the timeline can show "answered like this" rather than "allowed".
       */
      readonly answer?: string
      /** An answer chosen automatically from the recommendation (TODO 1194). Only changes the timeline wording. */
      readonly autoPicked?: true
      /**
       * Record of the event when it was picked automatically (TODO 1230): the question, the options shown, the position of the recommendation, the position chosen, the time waited.
       * Attached together with `autoPicked`. **When saving, `ThreadStore.toPersistable` copies it field by field and applies redaction to the strings**.
       */
      readonly autoPick?: AutoPickRecord
    }
  | {
      readonly kind: 'denied'
      readonly by: 'user' | 'system'
      /** A short sentence shown in the timeline (such as an instruction the user wrote). Not the exact text returned to the model. */
      readonly message: string
      /**
       * The form of the user's refusal (items 182 / 183). `stop` = refused without saying anything, `feedback` = wrote an instruction
       * (`message` is that sentence), `clarify` = "talk about this question". Omitted means an earlier record or a refusal by aios.
       */
      readonly reply?: 'stop' | 'feedback' | 'clarify'
    }

export interface PermissionRequestPayload {
  readonly requestId: string
  readonly toolUseId: string | null
  readonly toolName: string
  readonly summary: string
  readonly input: JsonValue
  readonly requestedAt: number
  readonly decidedAt: number | null
  readonly outcome: ApprovalOutcome
  /**
   * For a plan presentation, the number of lines of the plan (an observation of item 196, wave 14 bundle C). Then `summary` is empty and
   * the timeline shows only "Plan (N lines)" (the body is shown by `PlanBlock`). Omitted means an ordinary request.
   */
  readonly planLines?: number
}

export interface ResultUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
}

/**
 * Token usage per API call (item 60 / 4.5.2). One is emitted each time a backend response
 * message arrives. In a turn that calls tools many times, several arrive per turn, and **the
 * `inputTokens + cacheReadTokens + cacheCreationTokens` of the last one is the context size at that point**.
 * `usage` of `result` is the sum of the calls within the turn, so it cannot be used for this purpose
 * (measured: a turn with 2 calls shows double).
 * It is only numbers, so it may be saved (it does not touch constraints 9 / 10).
 */
export interface TurnUsagePayload extends ResultUsage {
  /** The name of the model that actually produced the response (full name). Opaque data; the key to look up the denominator table. */
  readonly model: string | null
}

/** TODO 1282: the kind of an auth failure (`ResultPayload.authFailureKind`). */
export type AuthFailureKind = 'login' | 'credential'

export interface ResultPayload {
  readonly ok: boolean
  readonly subtype: string
  /** The turn count of this turn. **Not cumulative** (spike 1). aios counts the cumulative total. */
  readonly turns: number
  readonly durationMs: number
  readonly costUsd: number
  readonly usage: ResultUsage
  readonly stopReason: string | null
  /** Denial history (4.2). Only the tool name and identifier are kept. */
  readonly denials: readonly { readonly toolName: string; readonly toolUseId: string | null }[]
  /** The final response text (if any). */
  readonly text: string | null
  /**
   * The backend's reported "model name -> context window limit" (item 60 / 74).
   * It is newer than the static table (`compat/`), so when it arrives it overrides the denominator.
   * Omitted for backends that do not report it.
   */
  readonly contextWindows?: readonly { readonly model: string; readonly contextWindow: number }[]
  /**
   * The end of a turn that aios stopped with an interrupt (item 94 / 4.5.4). `ok` stays false
   * (the backend reports it as an error), but **the display is "interrupted", not an error**.
   * The Adapter decides: true only when it had just sent an interrupt itself and the completion kind
   * was the one that means interruption (the completion kind alone cannot be told apart from other failures). Omitted otherwise.
   */
  readonly interrupted?: boolean
  /**
   * A turn that stopped because authentication expired (TODO 893). The Adapter decides (the only place that knows the backend's wording and fields, constraint 6).
   * SessionManager uses it to make the kind of interruption `interrupt-auth`. Omitted otherwise.
   */
  readonly authFailed?: boolean
  /**
   * TODO 1282: with `authFailed`, whether signing in again can fix it. `login` = the login expired or cannot be renewed (a fresh login
   * fixes it); `credential` = the credential handed to the backend itself was rejected (e.g. an invalid API key — signing in again
   * does not help, so no login is offered, constraint 3). The Adapter decides. Omitted when `authFailed` is absent.
   */
  readonly authFailureKind?: AuthFailureKind
  /**
   * Lifetime of the prompt cache written in this turn (ms, TODO 466). The Adapter reads it from the usage breakdown.
   * **Omitted for turns that wrote nothing (only read, or built-in commands that do not call the API) and for
   * backends that do not report a lifetime**: the display side carries over the previous value of the same thread (`thread/turn-end.ts`).
   * It is only a number, so it may be saved (it does not touch constraints 9 / 10). Not used for estimating cost or token counts (constraint 4).
   */
  readonly cacheTtlMs?: number
}

export interface RateLimitPayload {
  readonly status: string
  readonly windowType: string | null
  /** Epoch seconds. */
  readonly resetsAt: number | null
  readonly usingOverage: boolean
  /**
   * Usage rate against the plan's limits (item 317). The same information as the CLI's `/usage`, and **not cost**
   * (cost is not shown: item 165). Omitted for backends that do not report it and for old versions.
   */
  readonly windows?: UsageWindows
}

/** One usage-rate window (item 317). */
export interface UsageWindow {
  /** A ratio from 0 to 1 (0.13 = 13%). A report over the limit is possible, so it is not clamped at 1 here (the display side clamps). */
  readonly utilization: number
  /** Time when the window resets (epoch seconds). Null if unknown. */
  readonly resetsAt: number | null
}

/** The set of usage-rate windows (item 317): the 5-hour window and the 7-day window. A window with no report is omitted. */
export interface UsageWindows {
  readonly fiveHour?: UsageWindow
  readonly sevenDay?: UsageWindow
  /** The weekly window attached only to turn rows of Fable (TODO 1000). */
  readonly sevenDayFable?: UsageWindow
}

export interface ErrorPayload {
  readonly message: string
  readonly code: string | null
  /** Origin of an abnormal exit. The exit code cannot be relied on (spike 1), so aios classifies it. */
  readonly origin: 'spawn' | 'stream' | 'exit' | 'protocol' | 'internal'
}

/**
 * State of background work (a subagent / tool execution) (item 93, 4.6.3). Neutral vocabulary.
 * The backend's `killed` is mapped to `stopped`.
 */
export type SubtaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped'

/** How a task ended. `subtask_finished` only ever comes with one of these three. */
export type SubtaskEndStatus = 'completed' | 'failed' | 'stopped'

/** Usage of a subagent. **A subagent's tokens do not enter the parent's context** (separate from the pie chart of item 60). */
export interface SubtaskUsage {
  readonly totalTokens: number
  readonly toolUses: number
  readonly durationMs: number
}

/**
 * Start of a task (item 93). **The body of the instruction to the subagent (prompt) is not included** (the intent of constraint 10).
 *
 * The backend emits the same notice not only for subagents but also for tool execution (shells and so on)
 * (measured in item 94). Only those with `isSubagent` true are "subagents", and only these stop eviction.
 */
export interface SubtaskStartedPayload {
  /** The backend's task id. The key that ties start, progress and end together. An opaque string. */
  readonly taskId: string
  /** The parent tool call that started the task (ties to the `tool_use` in the timeline). */
  readonly toolUseId: string | null
  /** A short description of the task (the heading the parent model gave). Saved after redaction. */
  readonly description: string
  /** The kind of subagent (an opaque value that carries the backend's name as is). Null if it is not a subagent. */
  readonly subagentType: string | null
  readonly isSubagent: boolean
  /**
   * Whether it is a `run_in_background` shell (item 105). Exclusive with a subagent (`isSubagent`).
   * Used by eviction (`isEvictable`) to decide "do not evict while running, but do not count it
   * once the limit time has passed since the start" (prevents eviction from being stopped forever
   * by long-lived work such as monitoring). Always false if the compat table has no `tasks.backgroundShellType`.
   */
  readonly isBackgroundShell: boolean
  /**
   * Whether it is already in the background at the start (TODO 1196). False = work that a foreground tool call is waiting for (a long shell, etc.).
   * Foreground work can move to the background later (timeout, the user sending a message); then `subtask_backgrounded` arrives. Omitted if the backend does not report it (treated as being in the background, the way counting worked until now).
   */
  readonly backgrounded?: boolean
}

/** Progress of a task (item 93). **Not stored** (high frequency, and the end row has the same values). */
export interface SubtaskProgressPayload {
  readonly taskId: string
  readonly toolUseId: string | null
  /**
   * Only set when the task's heading changed (the difference of `task_updated`). **The description of a progress notice
   * does not go here**: in the real thing (spike 19) it is "what the subagent is doing right now" (the description of the last tool),
   * and overwriting the heading would make the description in the list change every moment. That goes in `activity`.
   */
  readonly description: string | null
  /** A short phrase for what the subagent is doing right now (the description of a progress notice, spike 19). Null if none. */
  readonly activity: string | null
  readonly subagentType: string | null
  /** Only set when the status changed. */
  readonly status: SubtaskStatus | null
  readonly usage: SubtaskUsage | null
  /** The name of the last tool the subagent used (an opaque value). */
  readonly lastToolName: string | null
  readonly summary: string | null
}

/**
 * Foreground work moved to the background (TODO 1196, timeout / a send that is waiting). **Not stored**. It only makes main's background-shell record
 * (`Live.backgroundShells`) start counting. Split from the `subtask_progress` fields in wave 81 review Y: sending a progress
 * with no content makes receivers that use progress as a trigger (such as re-checking a subagent's worktree) fire for nothing.
 */
export interface SubtaskBackgroundedPayload {
  readonly taskId: string
}

/** End of a task (item 93). `summary` is saved after redaction. */
export interface SubtaskFinishedPayload {
  readonly taskId: string
  readonly toolUseId: string | null
  readonly status: SubtaskEndStatus
  readonly summary: string | null
  readonly usage: SubtaskUsage | null
  /** Where the subagent's output is kept (**path only**; aios does not read the contents). */
  readonly outputFile: string | null
}

/**
 * Conversation reset (item 117, 4.5.3.1). The conversation before this point no longer reaches the model. The backend
 * then starts again as a new session (`session_started` follows with a new id). It has no contents.
 */
export type ConversationResetPayload = Readonly<Record<string, never>>

/**
 * Conversation compaction (item 117, 4.5.3.1). The conversation before this point was replaced by a summary.
 * `manual` = the user's command, `auto` = the judgment of the backend itself when the context was full.
 * The token counts are before and after for **the conversation part only**, not including the system prompt or tool definitions
 * (real case: before 32,679 -> after 1,888, while the input of the next call was 27.5k). Not used for the donut.
 */
export interface ContextCompactedPayload {
  readonly trigger: 'manual' | 'auto' | null
  readonly preTokens: number | null
  readonly postTokens: number | null
}

/**
 * The result of a shell run with `!` in the prompt field (item 116 / 4.5.7). It was **run by aios itself**, so
 * it is not a backend row (`actor: 'main'`). The command and output are mixed into the head of the next message
 * and passed to the backend. When saved, it goes through redaction just like the user's messages (owner decision 2026-09-27).
 *
 * - `ok`: exit code 0 / `exit`: ended with non-zero / `timeout`: stopped on timeout /
 *   `no-cwd`: the thread has no working folder (not run) / `failed`: could not start
 */
export type ShellRunStatus = 'ok' | 'exit' | 'timeout' | 'no-cwd' | 'failed'

export interface ShellRunPayload {
  readonly command: string
  readonly stdout: string
  readonly stderr: string
  /** The exit code. Null on timeout or when it could not start. */
  readonly exitCode: number | null
  readonly status: ShellRunStatus
  /** Either stdout or stderr was cut at the limit (the same value as the Bash tool's output). */
  readonly truncated: boolean
  readonly durationMs: number
  /** The errno token when it could not start (such as `ENOENT`). No sentence goes in (7.4.4). */
  readonly errorCode: string | null
}

/**
 * The result of a hook (item 126-3, 4.6.2 (10)). `success` = normal end, `error` = failure (non-zero exit code or
 * exception), `cancelled` = cancelled (timeout / interrupt). Values not in the table are `other`.
 */
export type HookOutcome = 'success' | 'error' | 'cancelled' | 'other'

/**
 * One hook from the settings finished running (item 126-3). **Only fields without body**: the hook's output
 * (stdout / stderr / output) is dropped by the adapter at the moment it reads it (owner decision 2026-09-27).
 * The name and event are opaque strings carried in the backend's vocabulary (display only).
 */
export interface HookRunPayload {
  /** The backend's hook run id. An opaque string. Null if none. */
  readonly hookId: string | null
  /** The name of the hook (for example the event name and the matcher joined with `:`). Display only. */
  readonly hookName: string
  /** The event of the hook (for example session start). Null if none. */
  readonly hookEvent: string | null
  readonly outcome: HookOutcome
  /** The exit code. Null if not reported. */
  readonly exitCode: number | null
}

/**
 * Replacement of the list of usable commands (the rest of item 117). Names only (no leading `/`, the same form as `commands`
 * of `session_started`). The receiver **replaces** the list (it is not a diff).
 */
export interface CommandsChangedPayload {
  readonly commands: readonly string[]
}

/**
 * Progress of a running tool call (item 259, 4.6 "tool progress"). **Not stored** (`EPHEMERAL_EVENT_KINDS`).
 *
 * - `toolUseId` is the **call whose progress was reported** (the `toolUseId` of the tool row in the timeline). In the backend's rows
 *   this is carried on the `parent_tool_use_id` side, and the row's own id is a throwaway value like `<id>-heartbeat-<n>`, so
 *   the Adapter swaps them. It means something different from the `parentToolUseId` of a subagent's message, so it is not copied into the envelope's
 *   `parentToolUseId` / `actor` (`actor` is always `main`).
 * - `heartbeat` true = a tick of the call itself saying "still running" (2.1.280 sends it every 30 seconds, for the parent's call only).
 *   False = intermediate progress the tool emits itself (a shell). The progress of a shell running inside a subagent arrives with the id of the parent call that started the subagent
 *   as `toolUseId`; `toolName` then differs from the name of that row (match it against `RunningSubtask.toolUseId`).
 */
export interface ToolProgressPayload {
  readonly toolUseId: string
  /** The name of the running tool (the name the backend decided, as is). */
  readonly toolName: string
  /** Seconds since the call started running (an integer, 0 or more). */
  readonly elapsedSeconds: number
  readonly heartbeat: boolean
}

/**
 * Notice of an API call retry (item 277, `system/api_retry`). Used only for one line of the in-progress display (5.1.3), and
 * **not stored** (the outcome is held by `result` / `error`). The body of `error` is not included (the rule that bodies appear neither in logs nor in the display).
 */
export interface ApiRetryPayload {
  /** Which retry this is (1-based). */
  readonly attempt: number
  readonly maxRetries: number
  /** The wait until the next attempt (milliseconds). */
  readonly retryDelayMs: number
  /** The HTTP status code. Null when there is none (such as a connection failure). */
  readonly errorStatus: number | null
}

/**
 * Notice of waiting for MCP servers (connectors) to connect (TODO 869 plan C). Only while waiting before the first message, it
 * delivers the number of `pending`. 0 means "the wait is over". Used only for the badge of the in-progress heading (`ThreadRuntime.mcpPending`), and **not stored**.
 * The actual state after the wait is held by `mcpServers` of `session_started`.
 */
export interface McpConnectingPayload {
  readonly pending: number
}

/**
 * Notice of the **whole set** of work running in the background (TODO 1196). A safety net for the start / end pair (`subtask_started` / `subtask_finished`):
 * the full current set arrives on every change, so the receiver replaces its own record with it (it does not keep spinning
 * even if an end notice is missed). For now it carries only the task ids of background shells (the same distinction as `isBackgroundShell`).
 * **Not stored**. If the backend has no such notice it never arrives (counting uses only the start / end pair).
 */
export interface BackgroundTasksPayload {
  readonly shellTaskIds: readonly string[]
}

/**
 * Notice that the version-control state changed (item 277, `system/vcs_state_changed`). **Not displayed, not stored**.
 * Used only as the trigger to re-read the git summary in the BottomBar.
 */
export interface VcsStateChangedPayload {
  /** `push` / `merge` / `commit` and so on. The backend's value as is (cut short). */
  readonly change: string
  readonly branch?: string
  /**
   * The working copy that changed is not the conversation's current working folder (such as a commit by a subagent running in a worktree, TODO 699).
   * If true, the git summary in the BottomBar is not re-read (the parent's working folder has not changed).
   */
  readonly elsewhere?: true
}

/**
 * Entering and leaving a worktree (TODO 633 stage 1, ARCHITECTURE 4.4). **Not displayed, not stored**: main
 * copies it into the thread's column (`threads.worktree_cwd`) and the cleanup table (`thread_worktrees`). Paths are absolute.
 *
 * - `enter`: the conversation's working folder moved into a worktree (`path`). `atLaunch` means it was in the
 *   worktree from the start by the launch specification (the shape where a git lock remains).
 * - `exit`: returned to the original working folder (`returnCwd`). The worktree (`path`) itself may remain.
 * - `child`: started a subagent that runs in a worktree (`toolUseId` = the parent call that started the subagent). The path is an
 *   estimate built from the convention, and is matched again against git's list at cleanup time.
 * - `child_start`: saw a call that starts a subagent running in a worktree (at the `tool_use` point, a fix from the code-review of TODO 700).
 *   The subagent's worktree path is not known yet (`path` is the conversation's current working folder, `branch` is null). For a foreground subagent
 *   `child` arrives after the subagent ends, so this is used to judge the subagent's writes until then. It is not put in the cleanup table.
 */
export interface WorktreeChangedPayload {
  readonly change: 'enter' | 'exit' | 'child' | 'child_start'
  readonly path: string
  readonly branch: string | null
  readonly returnCwd: string | null
  readonly toolUseId: string | null
  readonly atLaunch?: true
}

/**
 * In a run split with a worktree, a write outside the worktree (to the main working copy) was seen (TODO 700, ARCHITECTURE 4.4).
 * **A row main creates** (`actor: 'main'`), only when the result of a write tool arrived as successful. It does not stop or ask (TODO 167).
 * Stored (a mark in the timeline). The path is only the absolute path of the write target, with no contents.
 *
 * - `worktree`: the conversation had moved into a worktree but wrote to the original working copy.
 * - `subtask`: a subagent running in a worktree wrote to the original working copy.
 * - `parallel`: in a run that splits into bundles and runs them in worktree subagents (`/batch` and the like), the parent wrote to the original working copy.
 */
export type OutsideWriteScope = 'worktree' | 'subtask' | 'parallel'

export interface OutsideWritePayload {
  readonly toolUseId: string
  readonly path: string
  readonly scope: OutsideWriteScope
}

/** An unknown event is **kept as is, not dropped** (4.6). */
export interface UnknownPayload {
  readonly raw: string
  readonly hint: string | null
}

export type AiosEvent =
  | (AiosEventBase & { readonly kind: 'session_started'; readonly payload: SessionStartedPayload })
  | (AiosEventBase & {
      readonly kind: 'settings_changed'
      readonly payload: SettingsChangedPayload
    })
  | (AiosEventBase & { readonly kind: 'user_text'; readonly payload: TextPayload })
  | (AiosEventBase & { readonly kind: 'user_replay'; readonly payload: UserReplayPayload })
  | (AiosEventBase & { readonly kind: 'assistant_delta'; readonly payload: TextPayload })
  | (AiosEventBase & { readonly kind: 'assistant_text'; readonly payload: TextPayload })
  | (AiosEventBase & { readonly kind: 'thinking_delta'; readonly payload: TextPayload })
  | (AiosEventBase & { readonly kind: 'tool_use'; readonly payload: ToolUsePayload })
  | (AiosEventBase & { readonly kind: 'tool_result'; readonly payload: ToolResultPayload })
  | (AiosEventBase & {
      readonly kind: 'permission_request'
      readonly payload: PermissionRequestPayload
    })
  | (AiosEventBase & { readonly kind: 'result'; readonly payload: ResultPayload })
  | (AiosEventBase & { readonly kind: 'turn_usage'; readonly payload: TurnUsagePayload })
  | (AiosEventBase & { readonly kind: 'rate_limit'; readonly payload: RateLimitPayload })
  | (AiosEventBase & { readonly kind: 'error'; readonly payload: ErrorPayload })
  | (AiosEventBase & {
      readonly kind: 'subtask_started'
      readonly payload: SubtaskStartedPayload
    })
  | (AiosEventBase & {
      readonly kind: 'subtask_progress'
      readonly payload: SubtaskProgressPayload
    })
  | (AiosEventBase & {
      readonly kind: 'subtask_finished'
      readonly payload: SubtaskFinishedPayload
    })
  | (AiosEventBase & {
      readonly kind: 'subtask_backgrounded'
      readonly payload: SubtaskBackgroundedPayload
    })
  | (AiosEventBase & {
      readonly kind: 'conversation_reset'
      readonly payload: ConversationResetPayload
    })
  | (AiosEventBase & {
      readonly kind: 'context_compacted'
      readonly payload: ContextCompactedPayload
    })
  | (AiosEventBase & { readonly kind: 'shell_run'; readonly payload: ShellRunPayload })
  | (AiosEventBase & { readonly kind: 'hook_run'; readonly payload: HookRunPayload })
  | (AiosEventBase & {
      readonly kind: 'commands_changed'
      readonly payload: CommandsChangedPayload
    })
  | (AiosEventBase & { readonly kind: 'skill_loaded'; readonly payload: SkillLoadedPayload })
  | (AiosEventBase & { readonly kind: 'tool_progress'; readonly payload: ToolProgressPayload })
  | (AiosEventBase & { readonly kind: 'api_retry'; readonly payload: ApiRetryPayload })
  | (AiosEventBase & { readonly kind: 'vcs_state_changed'; readonly payload: VcsStateChangedPayload })
  | (AiosEventBase & { readonly kind: 'worktree_changed'; readonly payload: WorktreeChangedPayload })
  | (AiosEventBase & { readonly kind: 'mcp_connecting'; readonly payload: McpConnectingPayload })
  | (AiosEventBase & { readonly kind: 'background_tasks'; readonly payload: BackgroundTasksPayload })
  | (AiosEventBase & { readonly kind: 'outside_write'; readonly payload: OutsideWritePayload })
  | (AiosEventBase & { readonly kind: 'unknown'; readonly payload: UnknownPayload })

/**
 * Kinds that are not persisted (4.3.1 / constraint 10).
 * - delta kinds: the count is several times the body, and they are used for neither restore nor search.
 * - tool_result: the most sensitive. Only the length and success are kept separately.
 */
export const EPHEMERAL_EVENT_KINDS: ReadonlySet<AiosEventKind> = new Set<AiosEventKind>([
  'assistant_delta',
  'thinking_delta',
  // Reflection of a sent message (item 113). The identifier is copied to the matching `user_text`, and the row itself is not kept.
  'user_replay',
  // Tool progress (item 259). For a long tool it arrives every 30 seconds, and means nothing once it ends. The display comes from main's record
  // (`ThreadRuntime.toolProgress`).
  'tool_progress',
  // Notice of an API retry (item 277). The in-progress display comes from main's record (`ThreadRuntime.apiRetry`).
  'api_retry',
  // Notice of a git change (item 277). Only a trigger to re-read the BottomBar; it does not become a row.
  'vcs_state_changed',
  // Entering / leaving a worktree (TODO 633). main copies it to the thread's column and the cleanup table. It does not become a row.
  'worktree_changed',
  // Waiting for MCP connections (TODO 869). The in-progress badge comes from main's record (`ThreadRuntime.mcpPending`).
  'mcp_connecting',
  // The whole set of background work (TODO 1196). It only replaces main's record (`Live.backgroundShells`).
  'background_tasks',
  // Foreground work moved to the background (TODO 1196, wave 81 review Y). It only makes main's record start counting.
  'subtask_backgrounded'
])

/**
 * main -> renderer does not send one message per event (5.1, spike 8).
 * With 3 to 5 running in parallel it is hundreds per second, so they are batched every 16 ms.
 */
export interface AiosEventBatch {
  readonly events: readonly AiosEvent[]
  readonly at: number
}
