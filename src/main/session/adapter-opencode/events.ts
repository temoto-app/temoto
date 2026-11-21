/**
 * OpenCode SSE events -> `AiosEvent` (TODO 529 / 874, ARCHITECTURE 4.6.1).
 *
 * Mirrors the shapes observed in spike 34 (`spikes/34-opencode-serve.mjs`, the mapping table in `docs/notes/wave54.md`).
 * **Stateful**: the tool name arrives in `tool.input.started`, the body in `text.ended`, and the usage in `step.ended`,
 * so one mapper per session remembers them and assembles the `result`.
 * All names are looked up from `events` in `compat/opencode.json` (constraint 6).
 *
 * It has no side effects (the reply to a permission request is on the session side). `permission.asked` is returned as `ask`.
 *
 * TODO 1023 (spike 34 (r), observed with OpenCode 2.1.4 + Ollama gpt-oss:20b, 2026-10-31): a `reject` without a message arrives as
 * a tool failure (`error.type: "aborted"`, `"The user declined this tool call"`) -> `step.failed` (aborted) ->
 * `execution.interrupted` (`reason: "shutdown"`; an aios interrupt is `reason: "user"`). It is not `failed`, so
 * no error line is shown and the `result` becomes "interrupted". A `reject` with a message continues the turn after the tool failure
 * (`permission.rejected`) and ends with `execution.succeeded`. In both cases a `reject` in `permission.replied` is counted as a denial and
 * put into `result.denials` (the same "N denials" as Claude's `permission_denials`). Requests withdrawn by aios's own interrupt are not counted.
 *
 * TODO 1196: events for background work (`isBackgroundShell` / `backgrounded` of `subtask_started`, `subtask_backgrounded`, `background_tasks`)
 * were not observed in spike 34, so they are not emitted. The list spinner spins only during the parent turn, as before
 * (`ThreadRuntime.backgroundShells` is omitted).
 */
import type { AiosEvent, JsonValue, ResultUsage } from '@shared/agent.js'
import type { OpenCodeTable } from './compat.js'
import { baseModelOf, brokenModelNoteOf, usageLimitNoteOf } from './local.js'
import { mcpToolNameOf } from './mcp.js'

/** One SSE message (the JSON of `data:`). */
export interface ServerEvent {
  readonly id?: string
  readonly type: string
  readonly data?: unknown
}

export interface MapContext {
  readonly sessionId: string
  readonly threadId: string
  /** The OpenCode session id. Events of any other session are dropped. */
  readonly backendSessionId: string
  readonly now: () => number
  readonly newId: () => string
  /** TODO 1066: the model the conversation chose (`<provider>/<id>`). Used instead of `lastModel` when the failure happens before a step. */
  readonly modelId?: string | null
  /** TODO 1066: called when a failure saying the model cannot be loaded is seen (the name of the model to re-fetch). Material for the broken-download guidance. */
  readonly onModelBroken?: (model: string) => void
  /** TODO 1066: called when a turn succeeded with that model (it could be loaded = material for clearing the broken mark). The name has the same form as `onModelBroken` (a derived model uses the original name). */
  readonly onModelLoaded?: (model: string) => void
}

/** The contents of `permission.asked` (the material the session passes to the approval inbox). */
export interface PermissionAsked {
  readonly requestId: string
  readonly action: string
  readonly resources: readonly string[]
  /** The id of the tool call the request originated from (`source.id`). null if absent. */
  readonly toolUseId: string | null
  /** The arguments of that tool call (if delivered by `tool.called`). Otherwise built from resources. */
  readonly input: JsonValue
  /**
   * TODO 1024: a request for an MCP tool (`metadata` has the table's `permission.mcp.inputKey`). `action` is `<server>_<tool>`,
   * `input` is that tool's arguments (`source.id` is the carrier's `execute`, so its arguments = code are not used).
   */
  readonly mcp: boolean
}

export interface Mapped {
  readonly events: readonly AiosEvent[]
  readonly ask: PermissionAsked | null
  /** One turn ended (a `result` was emitted). */
  readonly ended: boolean
}

const NONE: Mapped = { events: [], ask: null, ended: false }

type Rec = Record<string, unknown>

function rec(value: unknown): Rec {
  return typeof value === 'object' && value !== null ? (value as Rec) : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asJson(value: unknown): JsonValue {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return null
  }
}

/** One-line summary of a tool call: the command / path / first line of the code. */
export function summarizeToolInput(name: string, input: Rec): string {
  for (const key of ['command', 'filePath', 'path', 'pattern', 'url', 'query', 'description']) {
    const v = input[key]
    if (typeof v === 'string' && v !== '') return v.length > 200 ? `${v.slice(0, 200)}…` : v
  }
  const code = input['code']
  if (typeof code === 'string') {
    const first = code.split('\n').find((line) => line.trim() !== '') ?? ''
    return first.length > 200 ? `${first.slice(0, 200)}…` : first
  }
  return name
}

/** Joins the text of `tool.success.content[]`. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const p = rec(part)
      return p['type'] === 'text' && typeof p['text'] === 'string' ? p['text'] : ''
    })
    .join('')
}

function usageOf(tokens: Rec): ResultUsage {
  const cache = rec(tokens['cache'])
  return {
    inputTokens: num(tokens['input']),
    outputTokens: num(tokens['output']),
    cacheCreationTokens: num(cache['write']),
    cacheReadTokens: num(cache['read'])
  }
}

function addUsage(a: ResultUsage, b: ResultUsage): ResultUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens
  }
}

const ZERO: ResultUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }

export class OpenCodeEventMapper {
  /** Tool call id -> name (delivered by `tool.input.started`). */
  private readonly toolNames = new Map<string, string>()
  /** Tool call id -> arguments (`tool.called`). Material for permission requests. */
  private readonly toolInputs = new Map<string, JsonValue>()
  private turnStartedAt: number | null = null
  private turnUsage: ResultUsage = ZERO
  private lastText: string | null = null
  private lastModel: string | null = null
  private lastError: string | null = null
  private interruptPending = false
  /**
   * Permission request id -> the originating tool call (TODO 1023: material for counting a `reject` in `permission.replied` as a denial).
   * Cleared at the end of a turn and on interrupt (so requests that never get a reply - interrupts, serve recreation - do not accumulate).
   */
  private readonly asked = new Map<string, { toolName: string; readonly toolUseId: string | null }>()
  /** Tools the user declined in this turn (`result.denials`). */
  private denials: { readonly toolName: string; readonly toolUseId: string | null }[] = []

  constructor(
    private readonly table: OpenCodeTable,
    private readonly ctx: MapContext
  ) {}

  /** Makes the next `result` an interruption (set right after the session sends `interrupt()`). */
  markInterrupt(): void {
    this.interruptPending = true
    // Requests withdrawn by an interrupt are not counted as denials (even if `permission.replied` arrives they are excluded by `interruptPending`), so forget them here.
    this.asked.clear()
  }

  /**
   * The name passed to the approval inbox is also used for counting denials (wave 62 review, TODO 1023 / 1024). The session decides an MCP tool's name
   * by longest match against the server list (`mcpToolNameOf`), so the provisional name split at the first separator is replaced here.
   * Does nothing if the request is already gone (replied, or the turn ended).
   */
  resolveAskedToolName(requestId: string, toolName: string): void {
    const entry = this.asked.get(requestId)
    if (entry !== undefined) entry.toolName = toolName
  }

  /**
   * TODO 1115: serve did not accept the prompt (the POST was 300 or more, or the connection failed). The turn has not started, so
   * serve sends neither a `result` nor an end notice - synthesize an `error` and a `result` with `ok: false` (the same shape as a turn failure)
   * here and knock over the session's "waiting for a response".
   */
  rejectedPrompt(message: string): Mapped {
    this.turnStartedAt = null
    this.interruptPending = false
    this.asked.clear()
    this.denials = []
    return {
      events: [
        this.base({ kind: 'error', payload: { message, code: null, origin: 'stream' } }),
        this.base({
          kind: 'result',
          payload: {
            ok: false,
            subtype: 'error',
            turns: 0,
            durationMs: 0,
            costUsd: 0,
            usage: ZERO,
            stopReason: null,
            denials: [],
            text: null
          }
        })
      ],
      ask: null,
      ended: true
    }
  }

  /** The model reported by the last `step.started` (`provider/model`). */
  get model(): string | null {
    return this.lastModel
  }

  map(ev: ServerEvent): Mapped {
    const E = this.table.events
    const data = rec(ev.data)
    const sid = str(data['sessionID'])
    // Drop events of other sessions and notices that do not belong to a session (mcp.* / provider.* ...).
    if (sid !== null && sid !== this.ctx.backendSessionId) return NONE
    const type = ev.type
    const messageId = str(data['assistantMessageID']) ?? undefined

    if (type === E.executionStarted) {
      this.turnStartedAt = this.ctx.now()
      this.turnUsage = ZERO
      this.lastText = null
      this.lastError = null
      this.denials = []
      return NONE
    }
    if (type === E.stepStarted) {
      const model = rec(data['model'])
      const provider = str(model['providerID'])
      const id = str(model['id'])
      if (provider !== null && id !== null) this.lastModel = `${provider}/${id}`
      return NONE
    }
    if (type === E.reasoningDelta) {
      const delta = str(data['delta'])
      if (delta === null || delta === '') return NONE
      return this.one({ kind: 'thinking_delta', payload: { text: delta } })
    }
    if (type === E.textDelta) {
      const delta = str(data['delta'])
      if (delta === null || delta === '') return NONE
      return this.one({ kind: 'assistant_delta', payload: { text: delta } })
    }
    if (type === E.textEnded) {
      const text = str(data['text']) ?? ''
      this.lastText = text
      return this.one({ kind: 'assistant_text', payload: { text, ...(messageId === undefined ? {} : { messageId }) } })
    }
    if (type === E.toolInputStarted) {
      const id = str(data['id'])
      const name = str(data['name'])
      if (id !== null && name !== null) this.toolNames.set(id, name)
      return NONE
    }
    if (type === E.toolCalled) {
      const id = str(data['id'])
      if (id === null) return NONE
      const raw = this.toolNames.get(id) ?? str(data['name']) ?? '?'
      // TODO 1020: align to the neutral name with the same table as the approval inbox (`permission.actions`) (`shell` -> `Bash`).
      const name = this.table.permission.actions[raw] ?? raw
      const inputRec = rec(data['input'])
      const input = asJson(data['input'])
      this.toolInputs.set(id, input)
      return this.one({
        kind: 'tool_use',
        payload: {
          toolUseId: id,
          name,
          summary: summarizeToolInput(name, inputRec),
          input,
          truncated: false,
          ...(messageId === undefined ? {} : { messageId })
        }
      })
    }
    if (type === E.toolSuccess || type === E.toolError) {
      const id = str(data['id'])
      if (id === null) return NONE
      const ok = type === E.toolSuccess
      const text = ok ? contentText(data['content']) : (str(rec(data['error'])['message']) ?? str(data['error']) ?? '')
      this.toolNames.delete(id)
      this.toolInputs.delete(id)
      return this.one({
        kind: 'tool_result',
        payload: { toolUseId: id, ok, bytes: Buffer.byteLength(text, 'utf8'), text }
      })
    }
    if (type === E.stepEnded) {
      const usage = usageOf(rec(data['tokens']))
      this.turnUsage = addUsage(this.turnUsage, usage)
      return this.one({ kind: 'turn_usage', payload: { ...usage, model: this.lastModel } })
    }
    if (type === E.stepFailed) {
      const error = rec(data['error'])
      const kind = str(error['type'])
      // A step cut off by an interruption is not an error (`execution.interrupted` emits the `result`).
      if (kind === 'aborted') return NONE
      this.lastError = str(error['message']) ?? kind ?? 'step failed'
      return NONE
    }
    if (type === E.permissionAsked) {
      const requestId = str(data['id'])
      if (requestId === null) return NONE
      const source = rec(data['source'])
      const toolUseId = str(source['id'])
      const resources = Array.isArray(data['resources']) ? data['resources'].filter((r): r is string => typeof r === 'string') : []
      const action = str(data['action']) ?? '?'
      const known = toolUseId === null ? undefined : this.toolInputs.get(toolUseId)
      const metadata = rec(data['metadata'])
      const mcp = Object.prototype.hasOwnProperty.call(metadata, this.table.permission.mcp.inputKey)
      const input: JsonValue = mcp
        ? asJson(metadata[this.table.permission.mcp.inputKey] ?? {})
        : action === this.table.permission.externalDirectory.action
          ? this.externalDirectoryInput(resources)
          : (known ?? { action, resources })
      this.asked.set(requestId, {
        // An MCP tool gets a provisional name (split at the first separator). Once the session decides the name passed to the approval inbox, it is replaced with `resolveAskedToolName`.
        toolName: mcp ? mcpToolNameOf(this.table, action, null) : (this.table.permission.actions[action] ?? action),
        toolUseId
      })
      return { events: [], ask: { requestId, action, resources, toolUseId, input, mcp }, ended: false }
    }
    if (type === E.permissionReplied) {
      const requestId = str(data['requestID'])
      const origin = requestId === null ? undefined : this.asked.get(requestId)
      if (requestId !== null) this.asked.delete(requestId)
      // A request withdrawn by aios's interrupt (the cancelled one of `interrupt`) is not a user denial.
      if (origin !== undefined && data['reply'] === this.table.permission.reply.deny && !this.interruptPending) {
        this.denials.push(origin)
      }
      return NONE
    }
    if (E.executionEnded.includes(type)) {
      const interrupted = type === E.executionInterrupted
      const failed = type === E.executionFailed
      const error = rec(data['error'])
      const message = str(error['message']) ?? this.lastError
      const durationMs = this.turnStartedAt === null ? 0 : this.ctx.now() - this.turnStartedAt
      this.turnStartedAt = null
      // When the turn ends, forget requests that have not received a reply (TODO 1023 review).
      this.asked.clear()
      const wasInterrupt = interrupted || (this.interruptPending && !failed && this.lastText === null)
      this.interruptPending = false
      const events: AiosEvent[] = []
      // TODO 1023: a turn stopped by a denial without a message also arrives as `interrupted` (not `failed`), so no error line is shown.
      if (failed && message !== null && !interrupted) {
        // TODO 1102: for text that looks like a limit, add guidance to the usage page (if the table is empty or nothing matches, leave it as is).
        const model = this.lastModel ?? this.ctx.modelId ?? null
        const broken = brokenModelNoteOf(this.table, model, message)
        if (broken !== null) this.ctx.onModelBroken?.(broken.model)
        const note = usageLimitNoteOf(this.table, this.lastModel, message) ?? broken?.note ?? null
        events.push(this.base({ kind: 'error', payload: { message: note ?? message, code: str(error['type']), origin: 'protocol' } }))
      }
      if (!failed && !interrupted) {
        const loaded = this.lastModel ?? this.ctx.modelId ?? null
        const base = loaded === null ? null : baseModelOf(this.table, loaded)
        if (base !== null) this.ctx.onModelLoaded?.(base)
      }
      events.push(
        this.base({
          kind: 'result',
          payload: {
            ok: !failed && !interrupted,
            subtype: interrupted ? 'interrupted' : failed ? 'error' : 'success',
            turns: 1,
            durationMs,
            costUsd: 0,
            usage: this.turnUsage,
            stopReason: null,
            denials: this.denials,
            text: this.lastText,
            ...(wasInterrupt ? { interrupted: true } : {})
          }
        })
      )
      return { events, ask: null, ended: true }
    }
    return NONE
  }

  /**
   * Confirmation of a path outside the working folder (TODO 1020). Passes the directory being asked about, not the original tool's arguments (the file to read or write) -
   * the approval frame shows "path outside the working folder: ...", and neither a diff nor the outbound-operation decision is made.
   */
  private externalDirectoryInput(resources: readonly string[]): JsonValue {
    const suffix = this.table.permission.externalDirectory.resourceSuffix
    const dirs = resources.map((r) => (suffix !== '' && r.endsWith(suffix) ? r.slice(0, -suffix.length) || '/' : r))
    return { path: dirs.join(', '), resources: [...resources] }
  }

  private one(partial: { kind: AiosEvent['kind']; payload: AiosEvent['payload'] }): Mapped {
    return { events: [this.base(partial)], ask: null, ended: false }
  }

  private base(partial: { kind: AiosEvent['kind']; payload: AiosEvent['payload'] }): AiosEvent {
    return {
      id: this.ctx.newId(),
      sessionId: this.ctx.sessionId,
      threadId: this.ctx.threadId,
      ts: this.ctx.now(),
      actor: 'main',
      ...partial
    } as AiosEvent
  }
}
