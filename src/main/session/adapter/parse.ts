/**
 * Normalizes one stream-json line into `AiosEvent`s (ARCHITECTURE.md 4.6).
 *
 * **Keep the impact of CLI format changes inside this file.** `thread_events` and ThreadPane see only
 * `AiosEvent`. Unknown events are not dropped; they are kept raw as `unknown` (4.6).
 *
 * This function must have unit tests (IMPLEMENTATION_BRIEF chapter 7). It is a pure function with no side
 * effects and no I/O, so it can run without calling the model.
 */
import type {
  AiosActor,
  AiosEvent,
  HookOutcome,
  McpServerReport,
  McpServerScope,
  McpServerState,
  ResultPayload,
  ResultUsage,
  SubtaskEndStatus,
  SubtaskStatus,
  SubtaskUsage,
  ToolUsePayload,
  UsageWindow,
  UsageWindows
} from '@shared/agent.js'
import { MAX_ARG_CHARS, MAX_ARG_ITEMS, isRecord, toJsonValue } from '../../../common/clip-json.js'
import { pathToUri } from '../../../common/uri.js'
import { redactJson } from '../../../common/redact.js'
import { toolProgressHint } from './progress.js'
import { adjustCommands, todoItemsFromInput } from './builtins.js'
import { loadCompatTable, type CommandsChangedNames, type HookEventNames } from './compat.js'
import { parseReportedCommands } from './models.js'
import { planProposalOf, planTransitionOf } from './write-preview.js'

/** Length of the one-line summary. */
export const MAX_SUMMARY_CHARS = 200

export interface ParseContext {
  /** The aios-internal session ID. */
  readonly sessionId: string
  readonly threadId: string
  readonly now: () => number
  readonly newId: () => string
  /**
   * How to recognize the gateway (item 110). The row of `system/init`'s `mcp_servers` whose name is `serverName` is the
   * gateway; if its `source` is anything other than `gatewaySource` (the value from `--mcp-config`), then "the user
   * has registered a server of the same name" (`gatewayConflict`). `statusValues` maps status names to the neutral vocabulary.
   * If absent (tests etc.), everything is read as `gateway: false` / `other`.
   */
  readonly mcp?: {
    readonly serverName: string
    readonly gatewaySource: string | null
    readonly statusValues: Readonly<Record<string, McpServerState>>
    /**
     * `source` → global side / folder side (item 164). If absent (tests etc.), everything is `unknown`.
     * Values in neither list, and rows without a `source`, are also `unknown` (they fall to the heading side).
     */
    readonly globalSources?: readonly string[]
    readonly folderSources?: readonly string[]
  }
}

/**
 * System subtypes that are known but not used by aios.
 * Making them `unknown` would add dozens of noise events every turn, so they are dropped explicitly
 * (spike 8: thinking_tokens accompanies every single thinking delta).
 */
const IGNORED_SYSTEM_SUBTYPES = new Set([
  'status',
  'thinking_tokens',
  // The compaction boundary (item 117) becomes `context_compacted` when compat/ has `streamEvents`.
  // It is dropped here only when the table is old and does not know the name (so it is not saved as unknown every time).
  'compact_boundary',
  // Item 93: a one-phrase progress note for the whole session, with no task id (for the backend's internal use).
  // It is not a child's progress, so it does not become subtask_*. It arrives every turn, so it does not become unknown either.
  'task_summary'
  // Item 93 (spike 19)'s `background_tasks_changed` (the full set of tasks running in the background) becomes, from TODO 1196,
  // `background_tasks` (not saved) and is used as the safety net for the shell bookkeeping (`parseBackgroundTasksChanged`).
])

/** Upper bound for one task description / summary (item 93). Long summaries are clipped here before saving. */
export const MAX_SUBTASK_TEXT_CHARS = MAX_ARG_CHARS

/** Delta types in the stream that aios does not use. */
const IGNORED_DELTA_TYPES = new Set(['signature_delta', 'input_json_delta'])

/** Events that carry only the framing of the stream. The finalized version arrives as `assistant`, so these are dropped. */
const IGNORED_STREAM_TYPES = new Set([
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_stop'
])

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/**
 * One-line summary of a tool call (4.3.1: "only the tool name and main arguments (path, command string,
 * query)"). The tool name arrives **exactly as the backend named it**, so we avoid listing
 * specific names here and instead pick by priority order of argument keys.
 */
//
// Item 321: `description` comes before `prompt`. Both are present on a subagent call: `description` is
// the short title (the CLI's `● Agent(description)`) and `prompt` is the long instruction. Previously `prompt` came first,
// so the headings of parallel children all became the same opening of the instruction and could not be told apart. Tools with
// `command` / `url` / `query` (Bash / WebFetch / search) are decided by an earlier key, so they do not change. `test/tool-input.test.ts`
// checks that the order is the same as the renderer's copy (`HOVER_KEYS` in `thread/tool-input.ts`).
export const SUMMARY_KEYS: readonly string[] = [
  'command',
  'file_path',
  'path',
  'url',
  'pattern',
  'query',
  'description',
  'prompt',
  'notebook_path',
  'subagent_type'
]

/**
 * Keys that carry prose (a title or instruction written by the model) (item 321). In a summary the Markdown emphasis marker `**` is dropped
 * (a one-line summary is not rendered as Markdown, so the marker would show raw). It is not dropped for path or command keys,
 * because it would break the `**` of a glob (such as `Glob`'s `pattern`).
 */
export const PROSE_SUMMARY_KEYS: ReadonlySet<string> = new Set(['description', 'prompt'])

/** Folds into one summary line. For a prose key the emphasis marker is also dropped (item 321). */
export function summaryLine(key: string, value: string): string {
  const text = PROSE_SUMMARY_KEYS.has(key) ? value.replace(/\*\*/g, '') : value
  return text.replace(/\s+/g, ' ').trim()
}

export function summarizeToolInput(input: unknown): string {
  if (!isRecord(input)) return ''
  for (const key of SUMMARY_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const line = summaryLine(key, value)
      if (line !== '') return clip(line, MAX_SUMMARY_CHARS)
    }
  }
  // For a tool whose keys are unknown (from a plugin, etc.), pick the first short string.
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim() !== '' && value.length <= MAX_SUMMARY_CHARS) {
      return clip(value.replace(/\s+/g, ' ').trim(), MAX_SUMMARY_CHARS)
    }
  }
  return ''
}

/** Pre-clip before redaction (one string). A width that comfortably holds one PEM key (~3.3 KB). */
const PRE_REDACT_CHARS = 64 * 1024
/** Pre-clip before redaction (array length). */
const PRE_REDACT_ITEMS = MAX_ARG_ITEMS * 4

/**
 * A pre-clip so that the redaction regexes do not run over a multi-MB `content` or an array of 10,000 elements (TODO 844).
 * It clips with room to spare, so the cut point has no effect beyond the final 1,000 characters / 50 items.
 */
function preClip(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > PRE_REDACT_CHARS ? value.slice(0, PRE_REDACT_CHARS) : value
  if (depth > 32) return null
  if (Array.isArray(value)) return value.slice(0, PRE_REDACT_ITEMS).map((v) => preClip(v, depth + 1))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) out[key] = preClip(child, depth + 1)
    return out
  }
  return value
}

export function toolUsePayload(
  name: string,
  id: string,
  rawInput: unknown,
  actor: AiosActor = 'main',
  /** Identifier of the response containing this call (item 113). Not attached if absent. */
  messageId: string | null = null
): ToolUsePayload {
  const truncated = { hit: false }
  // TODO 844: the order is pre-clip → redaction → clip (1,000 characters). The summary is also built from the redacted input
  // (clipping the raw input at 200 characters could cut a secret so that the rules no longer match it).
  const redactedInput = redactJson(preClip(rawInput)).value
  // One line of interim report (5.1.3). TODO 1073: built, like summary, from the post-redaction input. The tool name → kind table is in compat/ (constraint 6).
  const progress = toolProgressHint(name, redactedInput)
  // Rewriting of the task list (item 118). **Parent calls only**: a subagent's task list is
  // not pinned in the display (owner decision 2026-09-27). The tool names and how to read the arguments are in compat/.
  const todos = actor === 'main' ? todoItemsFromInput(loadCompatTable(), name, rawInput) : null
  // Presentation of a plan (item 167). The arguments (`input`) are clipped to 1,000 characters when saved, so the full plan
  // body is carried separately in a neutral field (the same shape as `todos` in item 118). An empty plan is not attached.
  const plan = planOfToolUse(name, rawInput)
  // Entering and leaving plan mode (item 275). The direction and the plan file path let the
  // renderer decide the kind of row (`Entered plan mode` / `User approved the plan` …). The tool names are in the table (`planMode`).
  const transition = planTransitionOf(loadCompatTable(), name, rawInput)
  // The model the parent specified in the call that spawns a child (TODO 403). A provisional display until the child's first message arrives.
  const subagentModel = actor === 'main' ? spawnModelOf(name, rawInput) : null
  // A call that used a skill (TODO 1100). Stage 1 covers parent calls only (nothing inside a child's block is shown).
  const skill = actor === 'main' ? skillOf(name, rawInput) : null
  return {
    toolUseId: id,
    name,
    summary: summarizeToolInput(redactedInput),
    input: toJsonValue(redactedInput, truncated),
    truncated: truncated.hit,
    ...(progress === null ? {} : { progress }),
    ...(todos === null ? {} : { todos }),
    ...(plan === null ? {} : { plan }),
    ...(transition === null ? {} : { planTransition: transition.transition }),
    ...(transition?.planFile == null ? {} : { planFile: transition.planFile }),
    ...(messageId === null ? {} : { messageId }),
    ...(subagentModel === null ? {} : { subagentModel }),
    ...(skill === null ? {} : { skill })
  }
}

/** Upper bound on a skill name's length (TODO 1100). Broken input must not bloat the badge or the DB. */
const MAX_SKILL_NAME_CHARS = 200

/** Upper bound on a skill directory's length (TODO 1105). */
const MAX_SKILL_DIR_CHARS = 1024

/**
 * Takes the body file's URI from the content of the row that injects a skill's body (TODO 1105). After the fixed leading phrase
 * (`skillTools.baseDirPrefix`), up to the first newline is the absolute directory path. Null if the shape differs. The body is not read.
 */
export function skillBodyUri(content: readonly unknown[]): string | null {
  const table = loadCompatTable().skillTools
  if (table?.baseDirPrefix === undefined || table.bodyFile === undefined) return null
  for (const block of content) {
    if (!isRecord(block) || str(block['type']) !== 'text' || typeof block['text'] !== 'string') continue
    if (!block['text'].startsWith(table.baseDirPrefix)) continue
    const rest = block['text'].slice(table.baseDirPrefix.length)
    const nl = rest.indexOf('\n')
    const dir = (nl < 0 ? rest : rest.slice(0, nl)).trim()
    if (dir === '' || dir.length > MAX_SKILL_DIR_CHARS || !dir.startsWith('/') || dir.includes('\0')) return null
    return pathToUri(dir.replace(/\/+$/, '') + '/' + table.bodyFile)
  }
  return null
}

/**
 * The skill name in the input of a skill-using call (`skillTools.names`) (TODO 1100). Null if there is no table, the tool
 * differs, the key is missing, or the value is not a string. A leading `/` is dropped (to match the completion's name).
 */
export function skillOf(name: string, rawInput: unknown): string | null {
  const table = loadCompatTable().skillTools
  if (table === undefined || !table.names.includes(name) || !isRecord(rawInput)) return null
  const value = rawInput[table.inputKey]
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^\/+/, '')
  return trimmed === '' ? null : clip(trimmed, MAX_SKILL_NAME_CHARS)
}

/**
 * The model specification in the input of a parent call that spawns a child (`tasks.spawnTools`) (TODO 403). Null if there is no specification,
 * the table has no key, or the value is not a string. The value stays an alias (conversion to a display name is `modelLabel`).
 */
function spawnModelOf(name: string, rawInput: unknown): string | null {
  const tasks = loadCompatTable().tasks
  if (tasks?.spawnTools?.includes(name) !== true || tasks.spawnModelKey === undefined) return null
  if (!isRecord(rawInput)) return null
  const value = rawInput[tasks.spawnModelKey]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Upper bound on the plan body (item 167). A plan file is normally a few KB. This is a safety net so
 * that broken input cannot bloat the DB; whatever exceeds it is dropped (a mark is added at the end).
 */
const MAX_PLAN_CHARS = 200_000

/** The plan body (full text) if this is a tool call that presents a plan. Null if unreadable or empty. */
function planOfToolUse(name: string, rawInput: unknown): string | null {
  const plan = planProposalOf(loadCompatTable(), name, rawInput)
  if (plan === null || plan.trim() === '') return null
  return plan.length > MAX_PLAN_CHARS ? `${plan.slice(0, MAX_PLAN_CHARS)}\n…` : plan
}

/** Length of a tool_result's contents. **The contents themselves are not persisted** (constraint 10). Also used for the past part of a transcript (item 111). */
export function measureToolResult(content: unknown): { text: string; bytes: number } {
  if (typeof content === 'string') {
    return { text: content, bytes: Buffer.byteLength(content, 'utf8') }
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (isRecord(block) && typeof block['text'] === 'string') parts.push(block['text'])
      else if (isRecord(block) && typeof block['type'] === 'string') parts.push(`[${block['type']}]`)
    }
    const text = parts.join('\n')
    return { text, bytes: Buffer.byteLength(text, 'utf8') }
  }
  const text = content === undefined || content === null ? '' : JSON.stringify(content)
  return { text, bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * Converts one line into zero or more `AiosEvent`s.
 * One line can contain several events (the content array of an assistant message).
 */
export function parseEvent(line: string, ctx: ParseContext): readonly AiosEvent[] {
  return parseEventWithRaw(line, ctx).events
}

/**
 * Same as `parseEvent`, but also returns the line's JSON (null if it is not an object). This is the entry point so that a reader that
 * keeps state across lines (`WorktreeWatch` in `worktree.ts`, TODO 633) does not `JSON.parse` the same line twice. The function itself
 * still has no side effects.
 */
export function parseEventWithRaw(
  line: string,
  ctx: ParseContext
): { readonly raw: Record<string, unknown> | null; readonly events: readonly AiosEvent[] } {
  const trimmed = line.trim()
  if (trimmed === '') return { raw: null, events: [] }

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return { raw: null, events: [unknownEvent(ctx, trimmed, 'invalid-json', 'main', undefined)] }
  }
  if (!isRecord(raw)) return { raw: null, events: [unknownEvent(ctx, trimmed, 'not-an-object', 'main', undefined)] }
  return { raw, events: parseRecord(raw, trimmed, ctx) }
}

function parseRecord(raw: Record<string, unknown>, trimmed: string, ctx: ParseContext): readonly AiosEvent[] {

  const parentToolUseId = str(raw['parent_tool_use_id']) ?? undefined
  const actor: AiosActor = parentToolUseId !== undefined ? 'subagent' : 'main'
  const base = { ctx, actor, parentToolUseId }
  const type = str(raw['type'])

  switch (type) {
    case 'system':
      return parseSystem(raw, base, trimmed)
    case 'stream_event':
      return parseStream(raw, base, trimmed)
    case 'assistant':
      return parseAssistant(raw, base)
    case 'user':
      return parseUser(raw, base)
    case 'result':
      return [parseResult(raw, base)]
    case 'rate_limit_event':
      return [parseRateLimit(raw, base)]
    default:
      // The `/clear` separator (item 117). It arrives with a top-level type (not system). The type's name is in compat/.
      if (type !== null && type === loadCompatTable().streamEvents?.conversationReset) {
        return [{ ...envelope(base), kind: 'conversation_reset', payload: {} }]
      }
      // Progress of a running tool (item 259). `parent_tool_use_id` is not a child marker (see parseToolProgress below).
      if (type !== null && type === loadCompatTable().streamEvents?.toolProgress) {
        return parseToolProgress(raw, ctx, trimmed)
      }
      return [unknownEvent(ctx, trimmed, type ?? 'no-type', actor, parentToolUseId)]
  }
}

interface Base {
  readonly ctx: ParseContext
  readonly actor: AiosActor
  readonly parentToolUseId: string | undefined
}

function envelope(
  base: Base
): { id: string; sessionId: string; threadId: string; ts: number; actor: AiosActor } & {
  parentToolUseId?: string
} {
  const common = {
    id: base.ctx.newId(),
    sessionId: base.ctx.sessionId,
    threadId: base.ctx.threadId,
    ts: base.ctx.now(),
    actor: base.actor
  }
  return base.parentToolUseId === undefined
    ? common
    : { ...common, parentToolUseId: base.parentToolUseId }
}

function unknownEvent(
  ctx: ParseContext,
  raw: string,
  hint: string,
  actor: AiosActor,
  parentToolUseId: string | undefined
): AiosEvent {
  const base: Base = { ctx, actor, parentToolUseId }
  return {
    ...envelope(base),
    kind: 'unknown',
    // Kept raw (4.6). Only an overlong line keeps just its head.
    payload: { raw: raw.length > 8192 ? `${raw.slice(0, 8192)}…` : raw, hint }
  }
}

// ---- Tool progress (item 259, 4.6 "Tool progress") -----------------------------------------
//
// Shape (from the zod in the CLI 2.1.280 binary and 37 real lines left in `unknown` in the duplicated DB):
// { type, tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds (integer), heartbeat?, task_id?,
//   subagent_type?, subagent_retry?, repl_call?, uuid, session_id }.
// - **`parent_tool_use_id` is the call the progress is reported for**, and `tool_use_id` is throwaway, like `<id>-heartbeat-<n>` /
//   `bash-progress-<n>` / `agent_<message id>`. It has the same field name as a child message's `parent_tool_use_id`
//   (= the parent call that spawned the child) but a different meaning, so it is not
//   copied into the envelope's `actor` / `parentToolUseId` (copying it would turn the parent Bash's progress into a "child message" and fold it under the Bash row in the timeline).
// - What arrives locally is `heartbeat: true` (parent calls only, every 30 seconds; it does not appear for tools inside a child).
//   Interim shell progress (without heartbeat) is emitted by the CLI only for remote execution. For a shell inside a child it arrives with the id of
//   the parent call that spawned that child.
// - `repl_call` (progress is always 0; it carries the arguments of the inner call) and `subagent_type` / `subagent_retry` (a child's API
//   retry, progress always 0) are not progress, so they are dropped (item 277).

function parseToolProgress(raw: Record<string, unknown>, ctx: ParseContext, line: string): readonly AiosEvent[] {
  if (raw['repl_call'] !== undefined || raw['subagent_retry'] !== undefined || raw['subagent_type'] !== undefined) {
    return []
  }
  const toolUseId = text(raw['parent_tool_use_id']) ?? text(raw['tool_use_id'])
  const toolName = text(raw['tool_name'])
  const elapsed = raw['elapsed_time_seconds']
  if (toolUseId === null || toolName === null || typeof elapsed !== 'number' || !Number.isFinite(elapsed)) {
    // A malformed line is not dropped; it is kept raw (4.6). The envelope stays the parent's.
    return [unknownEvent(ctx, line, 'tool_progress', 'main', undefined)]
  }
  return [
    {
      ...envelope({ ctx, actor: 'main', parentToolUseId: undefined }),
      kind: 'tool_progress',
      payload: {
        toolUseId,
        toolName: clip(toolName, MAX_SUMMARY_CHARS),
        elapsedSeconds: Math.max(0, Math.floor(elapsed)),
        heartbeat: raw['heartbeat'] === true
      }
    }
  ]
}

// ---- API retries and git changes (item 277, 4.6) ----------------------------------------------
//
// Shapes (CLI 2.1.280, real ones from the duplicated DB): api_retry { attempt, max_retries, retry_delay_ms, error_status, error },
// vcs_state_changed { kind: push | merge | commit, branch?, cwd }. Neither is saved (`EPHEMERAL_EVENT_KINDS`).
// TODO 699 (spike 30): `commit` also arrives (right after `git commit`; it may not appear for a commit inside a compound command). `cwd` is
// not necessarily the conversation's working folder, and **for the commit of a child running in a worktree it is the child's worktree path** (there is no `parent_tool_use_id`).
// **The body of `error` is dropped** (the rule that bodies are not logged). `cwd` is not carried here either: comparing it with the conversation's current
// working folder to make it "a change in someone else's working copy" (`elsewhere`) is done by `WorktreeWatch` in `worktree.ts`, which keeps state across lines.
// For changes elsewhere, the BottomBar's git summary is not refetched (the parent's working folder did not change). Using it as a clue to
// show the child's worktree is 633 stage 2 (owner decision 2026-10-11).

function parseApiRetry(raw: Record<string, unknown>, base: Base, line: string): readonly AiosEvent[] {
  const attempt = raw['attempt']
  const max = raw['max_retries']
  const delay = raw['retry_delay_ms']
  if (typeof attempt !== 'number' || !Number.isFinite(attempt) || typeof max !== 'number' || !Number.isFinite(max)) {
    return [unknownEvent(base.ctx, line, 'system/api_retry', base.actor, base.parentToolUseId)]
  }
  const status = raw['error_status']
  return [
    {
      ...envelope(base),
      kind: 'api_retry',
      payload: {
        attempt: Math.max(0, Math.floor(attempt)),
        maxRetries: Math.max(0, Math.floor(max)),
        retryDelayMs: typeof delay === 'number' && Number.isFinite(delay) ? Math.max(0, Math.floor(delay)) : 0,
        errorStatus: typeof status === 'number' && Number.isFinite(status) ? Math.floor(status) : null
      }
    }
  ]
}

function parseVcsStateChanged(raw: Record<string, unknown>, base: Base, line: string): readonly AiosEvent[] {
  const change = text(raw['kind'])
  if (change === null) return [unknownEvent(base.ctx, line, 'system/vcs_state_changed', base.actor, base.parentToolUseId)]
  const branch = text(raw['branch'])
  return [
    {
      ...envelope(base),
      kind: 'vcs_state_changed',
      payload: {
        change: clip(change, MAX_SUMMARY_CHARS),
        ...(branch === null ? {} : { branch: clip(branch, MAX_SUMMARY_CHARS) })
      }
    }
  ]
}

function parseSystem(raw: Record<string, unknown>, base: Base, line: string): readonly AiosEvent[] {
  const subtype = str(raw['subtype'])
  if (subtype === 'init') {
    const tools = Array.isArray(raw['tools'])
      ? raw['tools'].filter((t): t is string => typeof t === 'string')
      : []
    const servers = Array.isArray(raw['mcp_servers'])
      ? raw['mcp_servers'].map((s) =>
          typeof s === 'string' ? s : isRecord(s) ? (str(s['name']) ?? '?') : '?'
        )
      : []
    const mcp = parseMcpServers(raw['mcp_servers'], base.ctx.mcp)
    return [
      {
        ...envelope(base),
        kind: 'session_started',
        payload: {
          backendSessionId: str(raw['session_id']) ?? '',
          backendVersion: str(raw['claude_code_version']),
          model: str(raw['model']),
          cwd: str(raw['cwd']),
          // Returned as an alias (spike 9a: manual → default). Used only for display.
          reportedPermissionMode: str(raw['permissionMode']),
          tools,
          toolServers: servers,
          mcpServers: mcp.servers,
          gatewayConflict: mcp.gatewayConflict,
          resumed: false,
          // Item 68: the list of commands usable non-interactively (stream-json). Those meant only for the interactive UI
          // (such as `/btw`) do not appear here. Null for versions without the field (= the Composer does not block).
          // Item 117: the list and what actually works disagree (some work though not listed / some are listed but do not work).
          // That gap is corrected with the compat/ table before the list is passed on.
          commands: adjustCommands(
            loadCompatTable(),
            Array.isArray(raw['slash_commands'])
              ? raw['slash_commands'].filter((c): c is string => typeof c === 'string' && c !== '')
              : null
          ),
          // TODO 564: among them, skill names (also included in `slash_commands`). Used only for the completion's badge.
          skills: Array.isArray(raw['skills'])
            ? raw['skills'].filter((c): c is string => typeof c === 'string' && c !== '')
            : null
        }
      }
    ]
  }
  if (subtype === 'api_retry') return parseApiRetry(raw, base, line)
  if (subtype === 'vcs_state_changed') return parseVcsStateChanged(raw, base, line)
  if (subtype === 'task_started') return parseTaskStarted(raw, base)
  if (subtype === 'task_progress') return parseTaskProgress(raw, base)
  if (subtype === 'task_updated') return parseTaskUpdated(raw, base)
  if (subtype === 'task_notification') return parseTaskNotification(raw, base)
  if (subtype === 'background_tasks_changed') return parseBackgroundTasksChanged(raw, base)
  const table = loadCompatTable()
  const names = table.streamEvents
  if (names !== undefined && subtype === names.compactBoundary) {
    return [parseCompactBoundary(raw, base, names.compactMetadata)]
  }
  // Settings hooks (item 126-3). Only a hook that has finished running becomes a row; start and interim output are dropped.
  const hooks = table.hookEvents
  if (hooks !== undefined && subtype !== null) {
    if (subtype === hooks.response) return [parseHookResponse(raw, base, hooks)]
    if (subtype === hooks.started || subtype === hooks.progress) return []
  }
  // Replacement of the command list (the rest of item 117, `/reload-plugins` etc.).
  const changed = table.commandsChanged
  if (changed !== undefined && subtype === changed.subtype) {
    return parseCommandsChanged(raw, base, changed)
  }
  if (subtype !== null && IGNORED_SYSTEM_SUBTYPES.has(subtype)) return []
  return [unknownEvent(base.ctx, line, `system/${subtype ?? '?'}`, base.actor, base.parentToolUseId)]
}

// ---- Settings hooks (item 126-3, 4.6.2 (10)) ----------------------------------------
//
// Shape (from the zod in the CLI 2.1.280 binary and the real thing in spike 25): hook_started { hook_id, hook_name, hook_event } →
// (hook_progress { …, stdout, stderr, output } every second) → hook_response { hook_id, hook_name, hook_event,
// output, stdout, stderr, exit_code?, outcome: success|error|cancelled }. By default only the SessionStart / Setup hooks
// appear in the stream. **The output (stdout / stderr / output) is dropped here**: it is not put in `AiosEvent`, so it reaches
// neither persistence (`toPersistable`) nor the renderer (owner decision 2026-09-27, handled the same as constraint 10).
// `hook_started` is dropped because a finished `hook_response` always follows (a cancellation also arrives as `cancelled`) and
// one row per hook is enough. A hook that was mid-run when the process died does not become a row (the cost).

const HOOK_OUTCOMES: ReadonlySet<string> = new Set<HookOutcome>(['success', 'error', 'cancelled'])

function parseHookResponse(raw: Record<string, unknown>, base: Base, names: HookEventNames): AiosEvent {
  const f = names.fields
  const reported = str(raw[f.outcome])
  const mapped = reported === null ? undefined : names.outcomeValues[reported]
  const outcome: HookOutcome = mapped !== undefined && HOOK_OUTCOMES.has(mapped) ? (mapped as HookOutcome) : 'other'
  const exit = raw[f.exitCode]
  const hookId = text(raw[f.id])
  const hookEvent = text(raw[f.event])
  return {
    ...envelope(base),
    kind: 'hook_run',
    payload: {
      hookId: hookId === null ? null : clip(hookId, MAX_SUMMARY_CHARS),
      hookName: clip(text(raw[f.name]) ?? hookEvent ?? '?', MAX_SUMMARY_CHARS),
      hookEvent: hookEvent === null ? null : clip(hookEvent, MAX_SUMMARY_CHARS),
      outcome,
      exitCode: typeof exit === 'number' && Number.isInteger(exit) ? exit : null
    }
  }
}

/**
 * Replacement of the command list while running (the rest of item 117). Elements have the same shape as `commands` in the `initialize` response
 * (`{ name, description, argumentHint, aliases?, builtin? }`), so names are read with the same function.
 * Descriptions and argument examples are not read. If not a single name can be taken, nothing is emitted (trusting an empty list would make
 * the Composer block every `/xxx`: the same judgment as `initialize`). Corrected with item 117's works / does-not-work table before being passed on.
 */
function parseCommandsChanged(
  raw: Record<string, unknown>,
  base: Base,
  names: CommandsChangedNames
): readonly AiosEvent[] {
  const reported = parseReportedCommands({ commands: raw[names.listKey] })
  const commands = adjustCommands(loadCompatTable(), reported)
  if (commands === null) return []
  return [{ ...envelope(base), kind: 'commands_changed', payload: { commands } }]
}

/**
 * From a `commands_changed` row, reads the list of names **before** correction by the table (for the Adapter's cache). The cache keeps them
 * as reported; the correction by the table happens when handing them out (`knownCommands`), the same treatment as the `initialize` response. Null if the row is not one.
 * Call it only for a row that became a `commands_changed` event (only this rare row has its JSON re-read).
 */
export function reportedCommandsChanged(line: string): readonly string[] | null {
  const names = loadCompatTable().commandsChanged
  if (names === undefined) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw['subtype'] !== names.subtype) return null
  return parseReportedCommands({ commands: raw[names.listKey] })
}

// ---- Conversation separators (item 117, 4.5.3.1) ----------------------------------------------
//
// The real thing (CLI 2.1.280, `/compact`): system/status (compacting) → system/status (compact_result) →
// system/init (a second or later one, so LiveSession drops it) → system/compact_boundary → two user rows
// (the summary body and the "Compacted" echo; the content is a string, so parseUser emits nothing) → result.

function parseCompactBoundary(raw: Record<string, unknown>, base: Base, metadataKey: string): AiosEvent {
  const meta = isRecord(raw[metadataKey]) ? raw[metadataKey] : {}
  const trigger = meta['trigger']
  const tokens = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  return {
    ...envelope(base),
    kind: 'context_compacted',
    payload: {
      trigger: trigger === 'manual' || trigger === 'auto' ? trigger : null,
      preTokens: tokens(meta['pre_tokens']),
      postTokens: tokens(meta['post_tokens'])
    }
  }
}

/**
 * `system/init`'s `mcp_servers` (item 110 / 4.6.4). The shape is an array of `{name, status, source?}`
 * (spike 21, CLI 2.1.280: the gateway has `source: "dynamic"`, a project's `.mcp.json` has `"project"`,
 * a claude.ai connector has `"claudeai"` and unauthenticated ones have `status: "needs-auth"`). In older versions it is an array of strings.
 * `source` is carried opaquely (display only). If a row with the gateway's name came from somewhere other than the gateway's origin, or
 * there are two or more rows with that name, it is `gatewayConflict` (which one wins is unmeasured, so this stops at a warning).
 */
function parseMcpServers(
  raw: unknown,
  mcp: ParseContext['mcp']
): { servers: readonly McpServerReport[]; gatewayConflict: boolean } {
  if (!Array.isArray(raw)) return { servers: [], gatewayConflict: false }
  const servers: McpServerReport[] = []
  let gatewayRows = 0
  let foreignGateway = false
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) ? str(entry['name']) : null
    if (name === null || name === '') continue
    const status = isRecord(entry) ? str(entry['status']) : null
    const source = isRecord(entry) ? str(entry['source']) : null
    const gateway = mcp !== undefined && name === mcp.serverName
    if (gateway) {
      gatewayRows += 1
      if (mcp.gatewaySource !== null && source !== null && source !== mcp.gatewaySource) {
        foreignGateway = true
      }
    }
    const state: McpServerState =
      status === null ? 'other' : (mcp?.statusValues[status] ?? 'other')
    servers.push({ name, state, source, gateway, scope: mcpScopeOf(source, mcp) })
  }
  return { servers, gatewayConflict: gatewayRows > 1 || foreignGateway }
}

/**
 * The raw `source` value → the neutral category (item 164). Values not in the table (`mcp.globalSources` /
 * `folderSources` in `compat`) and rows without a `source` are `unknown`: they fall to the heading side.
 */
export function mcpScopeOf(source: string | null, mcp: ParseContext['mcp']): McpServerScope {
  if (source === null || mcp === undefined) return 'unknown'
  if (mcp.globalSources?.includes(source) === true) return 'global'
  if (mcp.folderSources?.includes(source) === true) return 'folder'
  return 'unknown'
}

// ---- Work running in the background (item 93, 4.6.3) ----------------------------------------------
//
// Output shapes (the real thing from CLI 2.1.280, spike 19 / test/fixtures/subagents.jsonl; the table is in 4.6.3):
//   task_started      task_id / tool_use_id / description / subagent_type? / task_type /
//                     is_backgrounded / spawn_depth / prompt / skip_transcript?
//   task_progress     task_id / tool_use_id / description (**the child's current activity**, not a heading) /
//                     subagent_type / usage { total_tokens, tool_uses, duration_ms } / last_tool_name
//   task_updated      task_id / patch { status?, end_time?, description?, … }
//   task_notification task_id / tool_use_id / status (completed|failed|stopped) / output_file /
//                     summary (the child's last message) / usage
//   background_tasks_changed tasks [{ task_id, task_type, description, … }] — the **full set** of work running in the background
//                     (the schema's description is "REPLACE semantics: swap your set for this payload")
// TODO 1196 (read from the zod schema and the construction sites in the 2.1.319 binary; no real line captured yet):
//   - `is_backgrounded` is attached to the task_started of local_agent and local_bash (true = registered in the background, false = a foreground
//     call is waiting). When it later moves to the background, task_updated's `patch.is_backgrounded` arrives.
//   - A foreground Bash **moves to the background** on a timeout (default 2 minutes) or a send it is waiting for (the tool_result says "moved to the
//     background"). The parent's turn simply ends with `result`, and the process keeps running in the background; when it finishes a
//     task_notification arrives and the parent adds a turn of its own (the same as a child finishing).
// `subagent_type` is attached only to subagent work (tool executions do not have it; confirmed in the binary).
// The child's own messages flow separately as `assistant` / `user` rows with `parent_tool_use_id`.
// **`prompt` (the instruction body to the child) is not read** (in the spirit of constraint 10).

/** Maps an empty string to "absent". */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function clipText(value: unknown): string | null {
  const t = text(value)
  return t === null ? null : clip(t, MAX_SUBTASK_TEXT_CHARS)
}

function parseSubtaskUsage(value: unknown): SubtaskUsage | null {
  if (!isRecord(value)) return null
  return {
    totalTokens: num(value['total_tokens']),
    toolUses: num(value['tool_uses']),
    durationMs: num(value['duration_ms'])
  }
}

/** The backend's status name → the neutral vocabulary. An unknown name gives null (the state is not changed). */
function subtaskStatus(value: unknown): SubtaskStatus | null {
  switch (value) {
    case 'pending':
    case 'running':
    case 'paused':
    case 'completed':
    case 'failed':
    case 'stopped':
      return value
    case 'killed':
      return 'stopped'
    default:
      return null
  }
}

function subtaskEndStatus(value: unknown): SubtaskEndStatus {
  const status = subtaskStatus(value)
  // A completion notice should never carry a not-finished status, but if one comes, it is not treated as a failure.
  return status === 'completed' || status === 'failed' ? status : 'stopped'
}

/**
 * The task id. It is required by the schema, and a row without it cannot link start to end, so it is dropped
 * (keeping it raw as `unknown` would save even the `prompt`).
 */
function taskIdOf(raw: Record<string, unknown>): string | null {
  return text(raw['task_id'])
}

function parseTaskStarted(raw: Record<string, unknown>, base: Base): readonly AiosEvent[] {
  // Internal housekeeping. Shown neither in the body nor in the list (as the backend describes).
  if (raw['skip_transcript'] === true) return []
  const taskId = taskIdOf(raw)
  if (taskId === null) return []
  const subagentType = text(raw['subagent_type'])
  // Item 105: shells do not get a subagent_type, so tell them apart by task_type
  // (without the compat table this is always false: eviction behaves as before and looks only at children).
  const backgroundShellType = loadCompatTable().tasks?.backgroundShellType ?? null
  const isBackgroundShell = backgroundShellType !== null && text(raw['task_type']) === backgroundShellType
  // TODO 1196: whether this is foreground work (`is_backgrounded: false`). Omitted for versions without the field (treated as background: the way it was counted before).
  const backgrounded = raw['is_backgrounded']
  return [
    {
      ...envelope(base),
      kind: 'subtask_started',
      payload: {
        taskId,
        toolUseId: text(raw['tool_use_id']),
        description: clipText(raw['description']) ?? '',
        subagentType,
        isSubagent: subagentType !== null,
        isBackgroundShell,
        ...(typeof backgrounded === 'boolean' ? { backgrounded } : {})
      }
    }
  ]
}

function parseTaskProgress(raw: Record<string, unknown>, base: Base): readonly AiosEvent[] {
  const taskId = taskIdOf(raw)
  if (taskId === null) return []
  return [
    {
      ...envelope(base),
      kind: 'subtask_progress',
      payload: {
        taskId,
        toolUseId: text(raw['tool_use_id']),
        // The progress description is "current activity" (the last tool's description etc.), not a heading (spike 19).
        description: null,
        activity: clipText(raw['description']),
        subagentType: text(raw['subagent_type']),
        status: null,
        usage: parseSubtaskUsage(raw['usage']),
        lastToolName: text(raw['last_tool_name']),
        summary: clipText(raw['summary'])
      }
    }
  ]
}

function parseTaskUpdated(raw: Record<string, unknown>, base: Base): readonly AiosEvent[] {
  const taskId = taskIdOf(raw)
  if (taskId === null) return []
  const patch = isRecord(raw['patch']) ? raw['patch'] : {}
  const status = subtaskStatus(patch['status'])
  const description = clipText(patch['description'])
  const events: AiosEvent[] = []
  // A diff with no displayable change (only the cumulative pause time, etc.) does not become progress.
  if (status !== null || description !== null) {
    events.push({
      ...envelope(base),
      kind: 'subtask_progress',
      payload: {
        taskId,
        toolUseId: null,
        description,
        activity: null,
        subagentType: null,
        status,
        usage: null,
        lastToolName: null,
        summary: null
      }
    })
  }
  // TODO 1196: foreground work moved to the background (a timeout or a send it is waiting for). Emitted as a kind separate from progress (wave 81 review Y:
  // emitting a progress event whose contents are all null makes a receiver that rechecks the child's worktree on every progress event do wasted work).
  if (patch['is_backgrounded'] === true) {
    events.push({ ...envelope(base), kind: 'subtask_backgrounded', payload: { taskId } })
  }
  return events
}

/**
 * The full set of work running in the background (TODO 1196). Carries only the task ids of shells (`tasks.backgroundShellType`);
 * subagents are counted only by start/end pairs, because a foreground child never enters the set (the same as before).
 * Without the distinguishing value in the compat table it is unusable, so it is dropped. A malformed notice is also dropped (so the bookkeeping is not emptied).
 */
function parseBackgroundTasksChanged(raw: Record<string, unknown>, base: Base): readonly AiosEvent[] {
  const backgroundShellType = loadCompatTable().tasks?.backgroundShellType ?? null
  const tasks = raw['tasks']
  if (backgroundShellType === null || !Array.isArray(tasks)) return []
  const shellTaskIds: string[] = []
  for (const task of tasks) {
    if (!isRecord(task) || text(task['task_type']) !== backgroundShellType) continue
    const taskId = taskIdOf(task)
    if (taskId !== null) shellTaskIds.push(taskId)
  }
  return [{ ...envelope(base), kind: 'background_tasks', payload: { shellTaskIds } }]
}

function parseTaskNotification(raw: Record<string, unknown>, base: Base): readonly AiosEvent[] {
  if (raw['skip_transcript'] === true) return []
  const taskId = taskIdOf(raw)
  if (taskId === null) return []
  return [
    {
      ...envelope(base),
      kind: 'subtask_finished',
      payload: {
        taskId,
        toolUseId: text(raw['tool_use_id']),
        status: subtaskEndStatus(raw['status']),
        summary: clipText(raw['summary']),
        usage: parseSubtaskUsage(raw['usage']),
        outputFile: text(raw['output_file'])
      }
    }
  ]
}

function parseStream(raw: Record<string, unknown>, base: Base, line: string): readonly AiosEvent[] {
  const event = raw['event']
  if (!isRecord(event)) {
    return [unknownEvent(base.ctx, line, 'stream-no-event', base.actor, base.parentToolUseId)]
  }
  const eventType = str(event['type'])
  if (eventType === 'content_block_delta') {
    const delta = event['delta']
    if (!isRecord(delta)) return []
    const deltaType = str(delta['type'])
    if (deltaType === 'text_delta') {
      const text = str(delta['text'])
      if (text === null || text === '') return []
      return [{ ...envelope(base), kind: 'assistant_delta', payload: { text } }]
    }
    if (deltaType === 'thinking_delta') {
      const text = str(delta['thinking'])
      if (text === null || text === '') return []
      return [{ ...envelope(base), kind: 'thinking_delta', payload: { text } }]
    }
    if (deltaType !== null && IGNORED_DELTA_TYPES.has(deltaType)) return []
    return [
      unknownEvent(base.ctx, line, `delta/${deltaType ?? '?'}`, base.actor, base.parentToolUseId)
    ]
  }
  if (eventType !== null && IGNORED_STREAM_TYPES.has(eventType)) return []
  return [
    unknownEvent(base.ctx, line, `stream/${eventType ?? '?'}`, base.actor, base.parentToolUseId)
  ]
}

function parseUsage(usage: Record<string, unknown>): ResultUsage {
  return {
    inputTokens: num(usage['input_tokens']),
    outputTokens: num(usage['output_tokens']),
    cacheCreationTokens: num(usage['cache_creation_input_tokens']),
    cacheReadTokens: num(usage['cache_read_input_tokens'])
  }
}

/**
 * Whether the row was answered without calling the API (item 117). The answer of a built-in command (such as `/context`) arrives as an `assistant`
 * row, but the model name is a synthetic marker and all usage is 0. If this became a `turn_usage`, the context usage
 * (item 60) would be replaced by "the last one" = 0 and the donut would vanish.
 */
function isSynthetic(model: string | null, usage: Record<string, unknown>): boolean {
  const synthetic = loadCompatTable().streamEvents?.syntheticModel
  if (synthetic !== undefined && model === synthetic) return true
  const u = parseUsage(usage)
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens === 0
}

function parseAssistant(raw: Record<string, unknown>, base: Base): readonly AiosEvent[] {
  const message = raw['message']
  if (!isRecord(message)) return []
  const content = message['content']
  if (!Array.isArray(content)) return []

  const out: AiosEvent[] = []
  // The response identifier (item 113). It is the branch origin (the key for `--resume-session-at`). Even if the same response is split across
  // several rows, the value differs per row, and whichever is used as the key, it branches from "the conversation up to that row".
  const messageId = text(raw['uuid'])
  // Usage per API call (item 60 / 4.5.2). Emitted before the body.
  // The same response (same message.id) may arrive split across several rows (thinking and tool_use in
  // separate rows, usage the same value), and one is emitted each time: harmless for the consumer that uses "the last one".
  const usage = message['usage']
  if (isRecord(usage) && !isSynthetic(str(message['model']), usage)) {
    out.push({
      ...envelope(base),
      kind: 'turn_usage',
      payload: { model: str(message['model']), ...parseUsage(usage) }
    })
  }
  for (const block of content) {
    if (!isRecord(block)) continue
    const blockType = str(block['type'])
    if (blockType === 'text') {
      const text = str(block['text'])
      if (text === null || text.trim() === '') continue
      out.push({
        ...envelope(base),
        kind: 'assistant_text',
        payload: { text, ...(messageId === null ? {} : { messageId }) }
      })
      continue
    }
    if (blockType === 'tool_use') {
      out.push({
        ...envelope(base),
        kind: 'tool_use',
        payload: toolUsePayload(
          str(block['name']) ?? '?',
          str(block['id']) ?? '',
          block['input'],
          base.actor,
          messageId
        )
      })
      continue
    }
    // thinking / signature are neither saved nor displayed (4.3.1). In incremental rendering they have already flowed as deltas.
  }
  return out
}

function parseUser(raw: Record<string, unknown>, base: Base): readonly AiosEvent[] {
  const message = raw['message']
  if (!isRecord(message)) return []
  const content = message['content']
  if (!Array.isArray(content)) return []

  const out: AiosEvent[] = []
  // The row that injects a skill's body (TODO 1105). It is not an echo of a message we sent, so it is not sent to the echo matching,
  // and only the location of the body becomes `skill_loaded`. The body is dropped.
  const skillTable = loadCompatTable().skillTools
  // Rows with a tool_result block are as before (the TODO 632 path). Only text-only synthetic rows are accepted here.
  if (
    skillTable?.syntheticKey !== undefined &&
    raw[skillTable.syntheticKey] === true &&
    !content.some((block) => isRecord(block) && str(block['type']) === 'tool_result')
  ) {
    const uri = base.actor === 'main' ? skillBodyUri(content) : null
    return uri === null ? [] : [{ ...envelope(base), kind: 'skill_loaded', payload: { uri } }]
  }
  // The echo of a message we sent (item 113, `--replay-user-messages`). A user row with only text blocks comes back
  // with an identifier (`uuid`) assigned by the backend. **The body is not stacked twice**
  // (aios records its own user_text at send time), but the identifier is the key to copy onto that user_text, so it is
  // emitted as `user_replay` (SessionManager copies it and then discards it; not persisted).
  // Instructions to a subagent (with parent_tool_use_id) are not echoes and are excluded.
  const replayId = text(raw['uuid'])
  if (
    replayId !== null &&
    base.actor === 'main' &&
    !content.some((block) => isRecord(block) && str(block['type']) === 'tool_result')
  ) {
    const texts = content.flatMap((block) =>
      isRecord(block) && str(block['type']) === 'text' && typeof block['text'] === 'string'
        ? [block['text']]
        : []
    )
    if (texts.length > 0) {
      out.push({
        ...envelope(base),
        kind: 'user_replay',
        payload: { messageId: replayId, text: texts.join('\n') }
      })
    }
    return out
  }
  for (const block of content) {
    if (!isRecord(block)) continue
    if (str(block['type']) !== 'tool_result') continue
    const measured = measureToolResult(block['content'])
    out.push({
      ...envelope(base),
      kind: 'tool_result',
      payload: {
        toolUseId: str(block['tool_use_id']) ?? '',
        ok: block['is_error'] !== true,
        bytes: measured.bytes,
        // For display only while alive. **Dropped just before writing to the DB** (constraint 10).
        text: clip(measured.text, 4000)
      }
    })
  }
  // A text block (the echo of a message we sent) is not stacked twice as user_text.
  // aios records its own user_text at send time.
  return out
}

function parseResult(raw: Record<string, unknown>, base: Base): AiosEvent {
  const usage = isRecord(raw['usage']) ? raw['usage'] : {}
  const denialsRaw = raw['permission_denials']
  const denials = Array.isArray(denialsRaw)
    ? denialsRaw.flatMap((d) =>
        isRecord(d)
          ? [{ toolName: str(d['tool_name']) ?? '?', toolUseId: str(d['tool_use_id']) }]
          : []
      )
    : []

  // The per-model breakdown carries the "context window limit" (item 60 / 74).
  // It is newer information than the static table, so it is picked up and passed on. Omitted if absent.
  const modelUsage = isRecord(raw['modelUsage']) ? raw['modelUsage'] : {}
  const contextWindows = Object.entries(modelUsage).flatMap(([model, info]) =>
    isRecord(info) && typeof info['contextWindow'] === 'number' && info['contextWindow'] > 0
      ? [{ model, contextWindow: info['contextWindow'] }]
      : []
  )

  const payload: ResultPayload = {
    ok: raw['is_error'] !== true,
    subtype: str(raw['subtype']) ?? 'unknown',
    // **Not cumulative** (spike 1). The cumulative total is counted by SessionManager.
    turns: num(raw['num_turns']),
    durationMs: num(raw['duration_ms']),
    // **Cumulative for the process** (spike 19). LiveSession converts it to a per-turn difference.
    costUsd: num(raw['total_cost_usd']),
    // **The sum of the API calls within the turn**, not the usage "right now" (item 60).
    // For context usage, look at `turn_usage` (the last one).
    usage: parseUsage(usage),
    stopReason: str(raw['stop_reason']),
    denials,
    text: str(raw['result']),
    ...(contextWindows.length > 0 ? { contextWindows } : {})
  }
  const cacheTtlMs = parseCacheTtl(usage)
  return {
    ...envelope(base),
    kind: 'result',
    payload: cacheTtlMs === undefined ? payload : { ...payload, cacheTtlMs }
  }
}

/**
 * The lifetime of the prompt cache written in this turn (TODO 466). The field names are the compat table's `cacheLifetimes`.
 * Go through the table in order; the lifetime of the first tier with a positive write. If all are 0, the field is absent, or there is no table, undefined
 * (the display side keeps the previous value).
 */
export function parseCacheTtl(usage: Record<string, unknown>): number | undefined {
  const names = loadCompatTable().cacheLifetimes
  if (names === undefined) return undefined
  const group = usage[names.field]
  if (!isRecord(group)) return undefined
  for (const tier of names.tiers) {
    const value = group[tier.key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return tier.ms
  }
  return undefined
}

function parseRateLimit(raw: Record<string, unknown>, base: Base): AiosEvent {
  const info = isRecord(raw['rate_limit_info']) ? raw['rate_limit_info'] : raw
  const windows = parseUsageWindows(info)
  return {
    ...envelope(base),
    kind: 'rate_limit',
    payload: {
      status: str(info['status']) ?? 'unknown',
      windowType: str(info['rateLimitType']),
      resetsAt: typeof info['resetsAt'] === 'number' ? info['resetsAt'] : null,
      usingOverage: info['isUsingOverage'] === true,
      ...(windows === undefined ? {} : { windows })
    }
  }
}

/**
 * Usage relative to the plan's limits (item 317). The field names are the compat table's `usageWindows`. Rows from 2.1.207 have
 * no such field, and then it is `undefined` (the usage display is not shown). Ratios are passed on as 0 to 1.
 */
function parseUsageWindows(info: Record<string, unknown>): UsageWindows | undefined {
  const names = loadCompatTable().usageWindows
  if (names === undefined) return undefined
  const group = info[names.field]
  if (!isRecord(group)) return undefined
  const one = (key: string): UsageWindow | undefined => {
    const entry = group[key]
    if (!isRecord(entry)) return undefined
    const utilization = entry[names.utilization]
    if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0) return undefined
    const resetsAt = entry[names.resetsAt]
    return {
      utilization,
      resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : null
    }
  }
  const fiveHour = one(names.fiveHour)
  const sevenDay = one(names.sevenDay)
  const sevenDayFable = names.sevenDayFable === undefined ? undefined : one(names.sevenDayFable)
  if (fiveHour === undefined && sevenDay === undefined) return undefined
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
    ...(sevenDayFable === undefined ? {} : { sevenDayFable })
  }
}
