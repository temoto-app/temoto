/**
 * The shape of an export file's contents, and its validation (TODO 1088, ARCHITECTURE 8.6). Pure functions, independent of electron.
 *
 * - **The contents are JSON lines (formatVersion 2).** Line 1 is the head (`formatVersion`, `dbUserVersion` (the writer's DB
 *   `user_version`), `home`, `settings`, etc.); from line 2 on it is one thread per line (`ExportedThread`). Export streams each thread
 *   into a gzip stream, and import runs `JSON.parse` per thread (the whole is never one string or one value).
 *   Version 1 (the whole is one JSON with `threads[]`) is read as the head line, and `threads[]` is iterated in the same order (`legacyThreads`).
 *   A `formatVersion` newer than this version is not read (`too-new`).
 * - The thread's events stay in the **form stored in the DB** (after `ThreadStore.toPersistable`). `tool_result` is only
 *   a length and a success flag; there is no body from the start. The reader does not trust this form either: it validates types here, and
 *   `ThreadStore.importThreadChunk` runs `toPersistable` again (redaction, field enumeration, dropping `tool_result` bodies).
 * - The file comes from outside, so counts and lengths are capped. **A single type violation rejects the whole file and writes nothing**
 *   (it passed authenticated encryption = it is the writer's own file, so a violation means it is either broken or crafted). A refusal returns
 *   which thread and which event. **Event kinds** this version does not know are dropped and counted (a newer aios
 *   added the kind and an older version reads it). The length of one event's payload (`payloadChars`) is measured after the persistence choke point, and one over the limit is
 *   dropped and counted (the `JSON.stringify` after `toPersistable` is used only once).
 * - **Export goes through the same validation** (`normalizeThreadMeta` / `checkEvent`). If a value in the DB exceeds the import limits,
 *   what can be fixed is fixed (an over-long title, an empty model id, too many reference ranges) and what cannot is dropped and counted. A file
 *   we wrote is never refused on import.
 */
import { isAbsolute } from 'node:path'
import type { AiosActor, JsonValue, SettingSource, ThinkingLevel } from '@shared/agent.js'
import { isSettingSource, isThinkingLevel } from '@shared/agent.js'

/** Version of the contents format. Raise it when a field changes, and add a mapping from the old version to `upgradeHead`. 2 = JSON lines (1 = the whole is one JSON). */
export const EXPORT_FORMAT_VERSION = 2
/** Magic of the contents (separate from the seal's magic `AIOSDATA`. Checks that the decrypted JSON really has this shape). */
export const EXPORT_FORMAT_NAME = 'aios-data-export'

export const LIMITS = {
  threads: 100_000,
  eventsPerThread: 500_000,
  eventsTotal: 5_000_000,
  /** One event's payload (JSON character count). Big enough for a full response or shell output (already cut at a limit). */
  payloadChars: 2 * 1024 * 1024,
  title: 2000,
  path: 4096,
  allowedDirs: 500,
  id: 200,
  backend: 64,
  modelId: 200,
  settings: 200
} as const

export interface ExportedEvent {
  readonly kind: string
  readonly actor: AiosActor
  readonly ts: number
  readonly parentToolUseId?: string
  readonly payload: JsonValue
}

/** The thread's fields (excluding events). */
export interface ExportedThreadMeta {
  readonly title: string
  readonly titleAuto: boolean
  readonly cwd: string
  readonly allowedDirs: readonly string[]
  readonly retention: 'forever' | 'days'
  readonly retentionDays: number | null
  readonly settingSources: readonly SettingSource[]
  readonly backend: string
  readonly modelId: string | null
  readonly thinking: ThinkingLevel | null
  readonly approvalStrict: boolean
  /**
   * The OS sandbox (TODO 1106 / 1109, ARCHITECTURE 4.2.4). A per-thread setting like strict mode. **An old export without the field is read as OFF**
   * (the field is optional, so the format version is not raised - an older aios skips it as an unknown field). If the importing backend has no
   * `os-sandbox`, `DataTransfer.runImport` drops it to OFF (the same decision as handover).
   */
  readonly osSandbox: boolean
  readonly createdAt: number
  readonly lastEventAt: number | null
  readonly turns: number
}

/** The shape of one line (one thread). */
export interface ExportedThread extends ExportedThreadMeta {
  readonly events: readonly ExportedEvent[]
}

/** Line 1 (the head). */
export interface ExportHead {
  readonly format: typeof EXPORT_FORMAT_NAME
  readonly formatVersion: number
  readonly dbUserVersion: number
  readonly appVersion: string
  readonly exportedAt: number
  /** The writer's home. If the importer's home differs, the heads of cwd and reference ranges are replaced. */
  readonly home: string
  /** Settings editor name (a key of `SettingValues`) -> value. */
  readonly settings: Readonly<Record<string, JsonValue>>
}

export type CheckFailureReason = 'invalid-file' | 'too-new' | 'too-large'

export type HeadCheck =
  | {
      readonly ok: true
      readonly head: ExportHead
      /** `threads[]` of a version 1 file (before validation). null in version 2 (threads start at line 2). */
      readonly legacyThreads: readonly unknown[] | null
    }
  | { readonly ok: false; readonly reason: CheckFailureReason }

/**
 * Kinds that are persisted (become DB rows), and the types of the fields their payload must have. If the fields `toPersistable` reads are checked,
 * re-running it does not throw, and the renderer's drawing does not break. A kind not listed here is dropped as an "unknown kind".
 */
type FieldType = 'string' | 'number' | 'boolean' | 'string|null' | 'number|null' | 'array' | 'object' | 'any'
const EVENT_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldType>>>> = {
  user_text: { text: 'string' },
  assistant_text: { text: 'string' },
  tool_use: { toolUseId: 'string', name: 'string', summary: 'string', truncated: 'boolean', input: 'any' },
  tool_result: { toolUseId: 'string', ok: 'boolean', bytes: 'number' },
  skill_loaded: { uri: 'string' },
  permission_request: {
    requestId: 'string',
    toolName: 'string',
    summary: 'string',
    input: 'any',
    requestedAt: 'number',
    outcome: 'object'
  },
  result: {},
  error: { message: 'string' },
  settings_changed: {},
  session_started: {},
  turn_usage: {},
  rate_limit: { status: 'string' },
  conversation_reset: {},
  context_compacted: {},
  subtask_started: { taskId: 'string', toolUseId: 'string', description: 'string' },
  subtask_finished: { taskId: 'string', toolUseId: 'string', status: 'string', summary: 'string|null' },
  shell_run: { command: 'string', stdout: 'string', stderr: 'string' },
  hook_run: { hookName: 'string' },
  outside_write: { toolUseId: 'string', path: 'string' },
  commands_changed: { commands: 'array' },
  unknown: { hint: 'string', raw: 'string' }
}

/** Whether it is a persisted kind (an unknown kind is dropped). */
export function isPersistedKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(EVENT_FIELDS, kind)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fieldOk(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'string|null':
      return value === null || typeof value === 'string'
    case 'number|null':
      return value === null || (typeof value === 'number' && Number.isFinite(value))
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value) && typeof value.kind === 'string'
    case 'any':
      return value !== undefined
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function isAbsolutePath(value: unknown): value is string {
  return isBoundedString(value, LIMITS.path) && value !== '' && isAbsolute(value) && !value.includes('\0')
}

export type EventCheck = { readonly ok: true; readonly event: ExportedEvent } | { readonly ok: false; readonly skip: boolean }

/**
 * Validates one event (shared by export and import). `skip` is an unknown kind (not a shape violation).
 * The payload length is not measured here (import measures it after the persistence choke point, export from the DB row's string).
 */
export function checkEvent(raw: unknown): EventCheck {
  if (!isPlainObject(raw)) return { ok: false, skip: false }
  const { kind, actor, ts, parentToolUseId, payload } = raw
  if (typeof kind !== 'string' || kind.length > 64) return { ok: false, skip: false }
  if (actor !== 'main' && actor !== 'subagent') return { ok: false, skip: false }
  if (!isTimestamp(ts)) return { ok: false, skip: false }
  if (parentToolUseId !== undefined && !(isBoundedString(parentToolUseId, LIMITS.id) && parentToolUseId !== '')) {
    return { ok: false, skip: false }
  }
  if (!isPlainObject(payload)) return { ok: false, skip: false }
  // An unknown kind (added by a newer version) is dropped. It is not a shape violation.
  if (!Object.prototype.hasOwnProperty.call(EVENT_FIELDS, kind)) return { ok: false, skip: true }
  const fields = EVENT_FIELDS[kind]!
  for (const [name, type] of Object.entries(fields)) {
    if (!fieldOk(payload[name], type)) return { ok: false, skip: false }
  }
  return {
    ok: true,
    event: {
      kind,
      actor,
      ts,
      ...(parentToolUseId === undefined ? {} : { parentToolUseId: parentToolUseId as string }),
      payload: payload as JsonValue
    }
  }
}

const MAX_RETENTION_DAYS = 36_500
const BACKEND_PATTERN = /^[a-z][a-z0-9-]*$/

/** Validates the thread's fields (excluding events). Shared by export (`normalizeThreadMeta`) and import (`checkThread`). */
export function checkThreadMeta(raw: unknown): ExportedThreadMeta | null {
  if (!isPlainObject(raw)) return null
  const t = raw
  if (!isBoundedString(t.title, LIMITS.title)) return null
  if (typeof t.titleAuto !== 'boolean') return null
  if (!isAbsolutePath(t.cwd)) return null
  if (!Array.isArray(t.allowedDirs) || t.allowedDirs.length > LIMITS.allowedDirs || !t.allowedDirs.every(isAbsolutePath)) {
    return null
  }
  if (t.retention !== 'forever' && t.retention !== 'days') return null
  const days = t.retentionDays
  if (!(days === null || (typeof days === 'number' && Number.isSafeInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS))) {
    return null
  }
  if (t.retention === 'days' && days === null) return null
  if (!Array.isArray(t.settingSources) || t.settingSources.length > 3 || !t.settingSources.every(isSettingSource)) {
    return null
  }
  if (typeof t.backend !== 'string' || !BACKEND_PATTERN.test(t.backend) || t.backend.length > LIMITS.backend) return null
  if (!(t.modelId === null || (isBoundedString(t.modelId, LIMITS.modelId) && t.modelId.trim() !== ''))) return null
  if (!(t.thinking === null || isThinkingLevel(t.thinking))) return null
  if (typeof t.approvalStrict !== 'boolean') return null
  // No field (an export from before TODO 1109) means OFF. If present, only a boolean is accepted.
  if (!(t.osSandbox === undefined || typeof t.osSandbox === 'boolean')) return null
  if (!isTimestamp(t.createdAt)) return null
  if (!(t.lastEventAt === null || isTimestamp(t.lastEventAt))) return null
  if (!(typeof t.turns === 'number' && Number.isSafeInteger(t.turns) && t.turns >= 0)) return null
  return {
    title: t.title,
    titleAuto: t.titleAuto,
    cwd: t.cwd,
    allowedDirs: [...(t.allowedDirs as string[])],
    retention: t.retention,
    retentionDays: days,
    settingSources: [...(t.settingSources as SettingSource[])],
    backend: t.backend,
    modelId: t.modelId,
    thinking: t.thinking,
    approvalStrict: t.approvalStrict,
    osSandbox: t.osSandbox === true,
    createdAt: t.createdAt,
    lastEventAt: t.lastEventAt,
    turns: t.turns
  }
}

export type ThreadCheck =
  | { readonly ok: true; readonly thread: ExportedThread; readonly skippedEvents: number }
  /** `event` is the order (from 1) of the event with the violation. Absent for a violation in the thread's fields. */
  | { readonly ok: false; readonly reason: 'invalid-file' | 'too-large'; readonly event?: number }

/** Validates one line (one thread). Adds to `budget.events` the number of events (the overall cap). */
export function checkThread(raw: unknown, budget: { events: number }): ThreadCheck {
  const meta = checkThreadMeta(raw)
  if (meta === null) return { ok: false, reason: 'invalid-file' }
  const rawEvents = (raw as Record<string, unknown>).events
  if (!Array.isArray(rawEvents)) return { ok: false, reason: 'invalid-file' }
  if (rawEvents.length > LIMITS.eventsPerThread) return { ok: false, reason: 'too-large' }
  budget.events += rawEvents.length
  if (budget.events > LIMITS.eventsTotal) return { ok: false, reason: 'too-large' }
  const events: ExportedEvent[] = []
  let skipped = 0
  for (let index = 0; index < rawEvents.length; index += 1) {
    const checked = checkEvent(rawEvents[index])
    if (checked.ok) events.push(checked.event)
    else if (checked.skip) skipped += 1
    else return { ok: false, reason: 'invalid-file', event: index + 1 }
  }
  return { ok: true, skippedEvents: skipped, thread: { ...meta, events } }
}

/** Cuts a too-long string at the limit (without leaving a lone surrogate at the cut end). */
function clampString(value: string, max: number): string {
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

function clampCount(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(n))) : 0
}

/**
 * Before export, fixes a DB row's values into a shape that passes the import validation (`checkThreadMeta`). If it cannot be fixed (cwd is not an absolute path,
 * the backend name does not fit the pattern), returns null - that thread is not exported and is counted.
 */
export function normalizeThreadMeta(meta: ExportedThreadMeta): ExportedThreadMeta | null {
  const days =
    meta.retention === 'days' && typeof meta.retentionDays === 'number' && Number.isFinite(meta.retentionDays)
      ? Math.max(1, Math.min(MAX_RETENTION_DAYS, Math.trunc(meta.retentionDays)))
      : null
  const modelId = meta.modelId !== null && meta.modelId.trim() !== '' && meta.modelId.length <= LIMITS.modelId ? meta.modelId : null
  return checkThreadMeta({
    ...meta,
    title: clampString(meta.title, LIMITS.title),
    allowedDirs: [...new Set(meta.allowedDirs.filter(isAbsolutePath))].slice(0, LIMITS.allowedDirs),
    retention: days === null ? 'forever' : 'days',
    retentionDays: days,
    settingSources: [...new Set(meta.settingSources.filter(isSettingSource))].slice(0, 3),
    modelId,
    thinking: meta.thinking !== null && isThinkingLevel(meta.thinking) ? meta.thinking : null,
    osSandbox: meta.osSandbox === true,
    createdAt: clampCount(meta.createdAt),
    lastEventAt: meta.lastEventAt === null ? null : clampCount(meta.lastEventAt),
    turns: clampCount(meta.turns)
  })
}

/** Cap on a setting name (value validation is done per name by the settings entry point `AgentSettings.prepare`). */
const SETTING_NAME_MAX = 100

/**
 * Normalizes settings into the shape put in the head (shared by export and import). Names that are too long are dropped, and null if the count limit is exceeded.
 * Export drops the excess over the limit (`truncate`).
 */
export function settingsForHead(raw: Readonly<Record<string, unknown>>, truncate = false): Record<string, JsonValue> | null {
  let entries = Object.entries(raw).filter(([name]) => name.length <= SETTING_NAME_MAX)
  if (entries.length > LIMITS.settings) {
    if (!truncate) return null
    entries = entries.slice(0, LIMITS.settings)
  }
  return Object.fromEntries(entries) as Record<string, JsonValue>
}

/**
 * Upgrades an old `formatVersion` head to the current shape. Version 1 -> 2 changes only the container (JSON lines) and the fields are the same, so it passes through
 * (version 1's `threads[]` is returned by `checkHead` as `legacyThreads`). When a field changes, add a mapping here such as
 * one that spreads `raw` and adds the new field with its default when `version <= 2` (the validation is written only for the current shape).
 */
function upgradeHead(raw: Record<string, unknown>, version: number): Record<string, unknown> {
  void version
  return raw
}

/** Validates line 1 (the head). A version 1 file is a single line, so `threads[]` is returned as `legacyThreads`. */
export function checkHead(raw: unknown): HeadCheck {
  if (!isPlainObject(raw) || raw.format !== EXPORT_FORMAT_NAME) return { ok: false, reason: 'invalid-file' }
  const version = raw.formatVersion
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return { ok: false, reason: 'invalid-file' }
  }
  if (version > EXPORT_FORMAT_VERSION) return { ok: false, reason: 'too-new' }
  const p = upgradeHead(raw, version)
  if (typeof p.dbUserVersion !== 'number' || !Number.isSafeInteger(p.dbUserVersion)) {
    return { ok: false, reason: 'invalid-file' }
  }
  if (!isBoundedString(p.appVersion, 100) || !isTimestamp(p.exportedAt) || !isAbsolutePath(p.home)) {
    return { ok: false, reason: 'invalid-file' }
  }
  let legacyThreads: readonly unknown[] | null = null
  if (version === 1) {
    if (!Array.isArray(p.threads)) return { ok: false, reason: 'invalid-file' }
    legacyThreads = p.threads
  }
  if (!isPlainObject(p.settings)) return { ok: false, reason: 'invalid-file' }
  const settings = settingsForHead(p.settings)
  if (settings === null) return { ok: false, reason: 'too-large' }
  return {
    ok: true,
    legacyThreads,
    head: {
      format: EXPORT_FORMAT_NAME,
      formatVersion: EXPORT_FORMAT_VERSION,
      dbUserVersion: p.dbUserVersion,
      appVersion: p.appVersion,
      exportedAt: p.exportedAt,
      home: p.home,
      settings
    }
  }
}

/**
 * Re-roots a path under the writer's home to under the importer's home (`/Users/a/git/x` -> `/Users/b/git/x`).
 * Paths when the homes are the same, or outside the home, stay as they are.
 */
export function rebaseHome(path: string, fromHome: string, toHome: string): string {
  if (fromHome === toHome || fromHome === '' || fromHome === '/') return path
  const from = fromHome.endsWith('/') ? fromHome.slice(0, -1) : fromHome
  const to = toHome.endsWith('/') ? toHome.slice(0, -1) : toHome
  if (path === from) return to
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`
  return path
}
