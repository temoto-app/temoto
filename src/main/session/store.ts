/**
 * Persistence of threads / sessions / the timeline (ARCHITECTURE.md 4.3.1 / 6.5 / chapter 8).
 *
 * Storage rules:
 * - **The contents of `tool_result` are not stored** (constraint 10). Only the length and success are kept,
 *   and after restore it is drawn as "omitted (N KB)".
 * - `thinking` and deltas are not stored (their count is about 7 times the body - spike 8).
 * - **Secret redaction** is applied before saving. It applies to user messages too (4.3.1).
 * - The canonical copy of body text is this one table (6.5). No per-row encryption is added (the whole DB is encrypted).
 * - Not a single row is written for a thread with `retention = 'none'`.
 */
import type { TriggerOrigin } from '@shared/trigger.js'
import type { GmailDraftFont } from '@shared/gmail-draft-font.js'
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import type {
  AiosEvent,
  ApprovalOutcome,
  AutoPickRecord,
  JsonValue,
  SettingSource,
  ThinkingLevel,
  TodoItem,
  ToolUsePayload,
  TurnUsagePayload
} from '@shared/agent.js'
import {
  DEFAULT_SETTING_SOURCES,
  EPHEMERAL_EVENT_KINDS,
  isSettingSource,
  isThinkingLevel
} from '@shared/agent.js'
import type {
  ApprovalPolicy,
  ApprovalRule,
  DeletedThreadSummary,
  ForkOrigin,
  InterruptReason,
  SessionSettings,
  Thread,
  ThreadRetention,
  TodoList,
  TranscriptOrigin
} from '@shared/thread.js'
import { UNTITLED_THREAD_TITLE, isInterruptReason } from '@shared/thread.js'
import { MAX_DRILL_OPS, type DrillState } from '@shared/drill.js'
import type { ThreadLinkLocation } from '@shared/thread-link.js'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { foldPath, isSameOrUnderPath, pathToUri } from '../../common/uri.js'
import { isScratchChild } from './scratch.js'
import { persistableSentAttachments } from './sent-attachments.js'
import { MAX_ARG_CHARS, MAX_ARG_ITEMS, clipPermissionInput } from '../../common/clip-json.js'
import { redactJson, redactText } from '../../common/redact.js'
import { log } from '../../common/logger.js'
import { AppSettingsStore } from '../../common/settings.js'
import { RainbowRegistry } from './rainbow.js'
import {
  APPROVAL_AUTO_ALLOW_ALL,
  APPROVAL_AUTO_ALLOW_TOOLS,
  APPROVAL_BASH_DENY_PATTERNS,
  APPROVAL_SSH_ALLOWED_HOSTS,
  APPROVAL_FULL_DELEGATION,
  SANDBOX_ALLOWED_DOMAINS,
  SANDBOX_ALLOW_WRITE,
  APPROVAL_RULES,
  BACKGROUND_SHELL_EVICT_TIMEOUT_MS,
  BUNDLE_MAX,
  GMAIL_DRAFT_FONT,
  DEFAULT_BACKGROUND_SHELL_EVICT_TIMEOUT_MS,
  DEFAULT_SESSION_SETTINGS,
  SESSION_SETTINGS,
  featureCacheKey,
  backendModelsKey
} from '../../common/settings-keys.js'
// TODO 526 (wave 26 bundle C): physical deletion of abandoned threads.
import { ABANDONED_THREAD_TTL_MS, DEFAULT_ABANDONED_THREAD_TTL_MS } from '../../common/settings-keys.js'
// Fix from the review of TODO 1118: the marker for a conversation whose working-folder history is deferred until the first send.
import { THREADS_CWD_HISTORY_DEFERRED } from '../../common/settings-keys.js'

/**
 * Order of the list (item 83, migration 15). Newest last event (send, end of a reply) first;
 * a thread with nothing yet uses its creation time. For equal values, the row inserted later (rowid) comes first.
 * It walks the partial-expression index `threads_recent` of migration 15 backwards, so no temporary B-tree is needed
 * (`test/thread-store.test.ts` checks this with EXPLAIN QUERY PLAN).
 */
const THREAD_ORDER = 'ORDER BY COALESCE(last_event_at, created_at) DESC, threads.rowid DESC'

/** Upper bound on the number of events restored per thread. Older ones stay in the DB but are not drawn. */
export const TIMELINE_LIMIT = 2000

/**
 * Upper bound on the number of working-folder history entries (TODO 462, formerly 50). The creation dialog, the settings screen, and the scheduled-run editor use
 * the same list (`SessionManager.cwdHistory`). The creation dialog searches with its filter field.
 */
export const CWD_HISTORY_LIMIT = 100

/**
 * Defaults for the number of parallel runs and the session lifetime (12.2 / spike 5). **The definition is in
 * `src/common/settings-keys.ts`** (TODO 85, the `parse` of the `session` key uses it) -
 * this is a re-export for compatibility with existing callers.
 */
export const DEFAULT_SETTINGS: SessionSettings = DEFAULT_SESSION_SETTINGS

interface ThreadRow {
  id: string
  title: string
  cwd: string
  allowed_dirs: string
  retention: string
  retention_days: number | null
  unread: number
  setting_sources: string
  backend: string
  model_id: string | null
  thinking: string | null
  approval_strict: number
  /** TODO 1106 (migration 34). */
  os_sandbox: number
  /** TODO 1222 (migration 37). */
  auto_pick_recommended: number
  last_viewer_uri: string | null
  last_viewer_highlight: string | null
  created_at: number
  /** Time the row was touched (written by per-column UPDATEs). **Not used for the list order** (migration 15). */
  updated_at: number
  last_event_at: number | null
  /** 1 = the title is still the provisional one from creation (it may be named from the first line of the next send, migration 15). */
  title_auto: number
  /** Time of the logical deletion (migration 13, item 64). NULL = alive. `toThread` does not read it. */
  deleted_at: number | null
  /** Cumulative turn count and cost (migration 14, item 75). `addTurn` advances them together with sessions. */
  turns: number
  cost_usd: number
  /** One-line preview of the latest message (migration 14). May be before normalization - the reader applies `normalizePreview`. */
  preview: string | null
  /** Origin of a branch (migration 16, item 113). JSON (`StoredForkOrigin`) or NULL. */
  fork_origin: string | null
  /** Origin of a thread continued from a transcript (migration 17, item 111). JSON (`StoredTranscriptOrigin`) or NULL. */
  transcript_origin: string | null
  /** If the thread was started by a scheduled-run job, that job's id (migration 18, TODO 323). The alarm clock icon in the list. */
  schedule_job_id: string | null
  /** Origin of a thread started by a trigger (migration 35, TODO 1216). JSON (`TriggerOrigin`) or NULL. */
  trigger_origin?: string | null
  /** The role (Teammate) the conversation belongs to (migration 46, TODO 972). NULL = no role. */
  role_id?: string | null
  /** TODO 982 (migration 49): 0 = not a drill, 1 = a drill not sent yet, 2 = a drill whose one run was sent. */
  drill?: number
  /** Interruption marker (migration 21, TODO 521). A reason code (`interrupt-*`) or NULL. */
  interrupted?: string | null
  /** The worktree moved into mid-conversation (migration 23, TODO 633). NULL = still the original cwd. */
  worktree_cwd?: string | null
  /** A worktree that could not be recreated at restore time (migration 24, TODO 633). */
  worktree_lost?: string | null
  /** Time a write outside the worktree was last seen (migration 23, TODO 700). */
  outside_write_at?: number | null
  /** The backend id of the latest session, which the list SELECT attaches via a correlated subquery. */
  latest_backend_session_id?: string | null
}

/**
 * Contents of the branch-origin row (item 113, `threads.fork_origin`). The `ForkOrigin` shown to the renderer plus
 * values used only at the first launch (the original backend session id and the identifier of the reply at the branch point).
 * If `backendSessionId` is null it means "does not inherit the original conversation" (rewound to before the first message = from empty).
 */
export interface StoredForkOrigin extends ForkOrigin {
  readonly backendSessionId: string | null
  readonly atMessageId: string | null
  /**
   * Marker that the hand-over (TODO 961) text was attached to the first ordinary message and sent (main only, not shown to the renderer).
   * It is not attached to a slash-command message, so "the first send" and "the send it was attached to" can differ.
   */
  readonly handoffSent?: true
  /**
   * The id of the original thread's last user message that the attached hand-over text covers (TODO 992 part 1, main only). When handing over further,
   * it continues the original thread up to here. For an old row without the marker, and until sent, `eventId` (the last message at creation) is used instead.
   */
  readonly handoffThrough?: string
}

/**
 * Origin of a thread continued from a transcript (item 111, `threads.transcript_origin`). The
 * `TranscriptOrigin` shown to the renderer (`fork` only) plus values only main uses: the backend
 * session id of the original conversation (material for the first launch's `--resume`), the opaque id of the transcript file, and the
 * read-stop position at the time of continuing (bytes).
 */
export interface StoredTranscriptOrigin extends TranscriptOrigin {
  readonly sessionId: string
  readonly fileId: string
  readonly limit: number
}

function parseTranscriptOrigin(raw: string | null): StoredTranscriptOrigin | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record['sessionId'] !== 'string' || typeof record['fileId'] !== 'string') return null
    const limit = record['limit']
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) return null
    return {
      sessionId: record['sessionId'],
      fileId: record['fileId'],
      limit,
      fork: record['fork'] === true,
      ...(record['modelFallback'] === true ? { modelFallback: true as const } : {})
    }
  } catch {
    return null
  }
}

function parseForkOrigin(raw: string | null): StoredForkOrigin | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record['threadId'] !== 'string' || typeof record['eventId'] !== 'string') return null
    return {
      threadId: record['threadId'],
      eventId: record['eventId'],
      files: record['files'] === true,
      ...(record['handoff'] === true ? { handoff: true as const } : {}),
      backendSessionId: typeof record['backendSessionId'] === 'string' ? record['backendSessionId'] : null,
      atMessageId: typeof record['atMessageId'] === 'string' ? record['atMessageId'] : null,
      ...(record['handoffSent'] === true ? { handoffSent: true as const } : {}),
      ...(typeof record['handoffThrough'] === 'string' ? { handoffThrough: record['handoffThrough'] } : {})
    }
  } catch {
    return null
  }
}

/** Material for the branch point (item 113, `rewindPoint`). */
/** One thread row to export (TODO 1088). Keeps the DB column names, plus the JSON columns after reading. */
export interface ExportThreadRow {
  readonly id: string
  readonly title: string
  readonly title_auto: number
  readonly cwd: string
  readonly allowedDirs: readonly string[]
  readonly retention: string
  readonly retention_days: number | null
  readonly settingSources: readonly SettingSource[]
  readonly backend: string
  readonly model_id: string | null
  readonly thinking: ThinkingLevel | null
  readonly approval_strict: number
  /** TODO 1109: the OS sandbox (1 = ON). */
  readonly os_sandbox: number
  readonly created_at: number
  readonly last_event_at: number | null
  readonly turns: number
}

/** One event to export (TODO 1088). As it is in the DB, plus the payload column as a string (the export uses the string as is). */
export interface ExportEventRow {
  readonly kind: string
  readonly actor: 'main' | 'subagent'
  readonly ts: number
  readonly parentToolUseId?: string
  readonly payload: JsonValue
  /** The value of the `thread_events.payload` column (the JSON of `payload`). The export writes this without re-stringifying. */
  readonly payloadJson: string
}

/** The fields of one imported thread (TODO 1088). Its shape was already validated by `src/main/data-transfer/format.ts`. */
export interface ImportThreadMeta {
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
  /** TODO 1109: the OS sandbox. If the destination backend does not have it, the caller (`DataTransfer`) passes false. */
  readonly osSandbox: boolean
  readonly createdAt: number
  readonly lastEventAt: number | null
  readonly turns: number
}

/** One chunk of events to import (TODO 1088, `ThreadStore.importThreadChunk`). */
export interface ImportThreadChunk {
  /** The id of the thread to add to (assigned by the caller). */
  readonly threadId: string
  /** First chunk only: creates the thread row. From the second on, null (adds to the existing row). */
  readonly thread: ImportThreadMeta | null
  readonly events: readonly {
    readonly kind: string
    readonly actor: 'main' | 'subagent'
    readonly ts: number
    readonly parentToolUseId?: string
    readonly payload: JsonValue
  }[]
  /** The seq of the first event in this chunk (from 1. The previous chunk's `nextSeq`). */
  readonly seqStart: number
  /** Upper bound of the payload after the save choke point (number of JSON characters). Rows over it are dropped and counted. */
  readonly maxPayloadChars: number
  /** Assigns an event id. */
  readonly newId: () => string
}

export interface RewindPoint {
  /** Identifier of the user message to go back to (`user_text.messageId`). null for a row that has not received the echo. */
  readonly userMessageId: string | null
  /** Identifier of the reply (`assistant_text` / `tool_use`) just before that message. null if none. */
  readonly priorMessageId: string | null
  /**
   * Whether a row for the previous reply exists (separate from whether an identifier exists. If none, it is "before the first message" = from empty).
   * TODO 1121: also false when there is a conversation reset (`/clear`) between the previous reply and that message (right after a reset = from empty).
   */
  readonly hasPrior: boolean
  /**
   * TODO 1121: there is a conversation reset after that message. The message and the previous reply belong to the **previous session** and
   * are not in the latest session's (`latestBackendSessionId`) transcript - the branch source is the session at the time of `priorTs`, and
   * the file checkpoint cannot be looked up from the current session.
   */
  readonly resetAfter: boolean
  /** Time of the previous reply (null if `hasPrior` is false). Material for looking up the branch-source session by time (only when it cannot be looked up in record order). */
  readonly priorTs: number | null
  /**
   * Position of the previous reply's row (`thread_events.seq`, null if `hasPrior` is false). Material for looking up the branch-source session in record order
   * (`backendSessionOfResponse`. Fix from the review of TODO 1121).
   */
  readonly priorSeq: number | null
}

/**
 * The values needed for one sidebar row (item 75). All of them come from a single statement of `listThreadRecords` -
 * before, `sessionTotals` / `previewOf` / `latestBackendSessionId` were queried for each row.
 */
export interface ThreadRecord {
  readonly thread: Thread
  readonly turns: number
  readonly costUsd: number
  readonly preview: string | null
  readonly latestBackendSessionId: string | null
}

/** TODO 982: the `threads.drill` column -> the state (null = not a drill; an unknown value counts as `ran`, the closing side). */
function drillStateOfColumn(value: number | undefined): DrillState | null {
  if (typeof value !== 'number' || value === 0) return null
  return value === 1 ? 'ready' : 'ran'
}

/** TODO 982: one stopped operation of a drill, as handed to `ThreadStore.addDrillOp`. */
export interface StoredDrillOpInput {
  readonly id: string
  readonly threadId: string
  readonly at: number
  readonly toolUseId: string | null
  readonly toolName: string
  readonly target: { readonly kind: string; readonly value: string } | null
  readonly subject: string | null
  readonly size: number | null
  readonly grantCandidates: readonly unknown[] | null
  readonly grantRefusal: string | null
}

/** TODO 982: a stored drill op as read back (JSON and kinds are re-validated by the reader). */
export interface StoredDrillOp {
  readonly id: string
  readonly threadId: string
  readonly at: number
  readonly toolUseId: string | null
  readonly toolName: string
  readonly targetKind: string | null
  readonly target: string | null
  readonly subject: string | null
  readonly size: number | null
  readonly grantCandidates: string | null
  readonly grantRefusal: string | null
  readonly grantedAt: number | null
}

interface DrillOpRow {
  id: string
  thread_id: string
  created_at: number
  tool_use_id: string | null
  tool_name: string
  target_kind: string | null
  target: string | null
  subject: string | null
  size: number | null
  grant_candidates: string | null
  grant_refusal: string | null
  granted_at: number | null
}

/** Normalizes a preview: collapses whitespace to one space and cuts at 120 characters. null if empty. */
export function normalizePreview(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  return text.replace(/\s+/g, ' ').trim().slice(0, 120) || null
}

/** Where a row's cwd is judged against: the home folder and this profile's own scratch root (TODO 1314). */
interface CwdPlace {
  readonly home: string
  readonly scratchRoot?: string
}

function toRecord(
  row: ThreadRow,
  home: CwdPlace,
  rainbow: RainbowRegistry,
  cwdDeferred: ReadonlySet<string>
): ThreadRecord {
  return {
    thread: toThread(row, home, rainbow, cwdDeferred),
    turns: row.turns,
    costUsd: row.cost_usd,
    preview: normalizePreview(row.preview),
    latestBackendSessionId: row.latest_backend_session_id ?? null
  }
}

/** Reads a JSON-array column. Empty if broken. */
function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((d): d is string => typeof d === 'string')
  } catch {
    // A broken row is treated as empty.
  }
  return []
}

/** Where a worktree made by that conversation came from (TODO 633). */
/**
 * How the row got into the table. `fork` means a branch (item 113) took over the original conversation's worktree - it was made by the original conversation, and
 * the branch only **references** it (code-review fix). Cleanup treats every origin the same: "keep it if another
 * conversation that is not deleted references it".
 */
export type ThreadWorktreeOrigin = 'enter' | 'child' | 'launch' | 'fork'

function isThreadWorktreeOrigin(value: unknown): value is ThreadWorktreeOrigin {
  return value === 'enter' || value === 'child' || value === 'launch' || value === 'fork'
}

/** One row of `thread_worktrees` (TODO 633). */
export interface ThreadWorktreeRecord {
  readonly threadId: string
  readonly path: string
  readonly branch: string | null
  readonly origin: ThreadWorktreeOrigin
  /** The original repository the worktree was made from (that conversation's cwd). Cleanup's git runs here. */
  readonly repoCwd: string
  readonly createdAt: number
  /** The reason cleanup kept it. null if not examined yet. */
  readonly kept: string | null
  /**
   * The HEAD commit at the time cleanup removed it (the base for recreating on restore, migration 24). null if not removed.
   * `REMOVED_HEAD_UNKNOWN` (the empty string) means "removed but the HEAD is unknown" (TODO 748) - on restore it is not recreated and
   * is given the same marker as `worktree_lost`.
   */
  readonly removedHead: string | null
}

/**
 * "Removed but the HEAD is unknown" for `thread_worktrees.removed_head` (TODO 748 (b) / (c)). For example, a row whose cleanup result could not be written because it overlapped shutdown,
 * and which was already gone when re-run at the next launch. It is expressed by a value without adding a migration -
 * existing queries that read `removed_head IS NULL` as "a live row" (references from other conversations, `allKeptWorktrees`)
 * treat it as a "removed row" as is.
 */
export const REMOVED_HEAD_UNKNOWN = ''

interface EventRow {
  id: string
  thread_id: string
  session_id: string | null
  ts: number
  kind: string
  actor: string
  parent_tool_use_id: string | null
  payload: string
}

/**
 * Decides the **display name** of a thread's working directory (T18 / TODO 22, ARCHITECTURE 4.3).
 * A pure function. Only this return value is passed to the renderer, never the path.
 *
 * - Empty / only whitespace: the empty string (an old row with no cwd. The caller draws nothing).
 * - The home itself: `~` (so that, shown next to `hoge`, it conveys "nowhere in particular").
 * - Directly under the scratch area `~/aios/scratch/<id>`: the empty string (T19, TODO 62). Not the UUID, and
 *   not a label such as "unaffiliated" either - the caller draws nothing, as for an old row with no
 *   cwd. A thread that picked another thread's scratch area is treated the same (`isScratchChild`).
 * - Otherwise: the last directory name. A trailing `/` is ignored (`resolve`).
 *   Only the root `/` has an empty `basename`, so it is shown as `/`.
 *
 * Directories with the same name are not distinguished (the decision of TODO 22).
 */
export function threadCwdName(cwd: string, home: string, scratchRoot?: string): string {
  if (cwd.trim() === '') return ''
  const path = resolve(cwd)
  if (foldPath(path) === foldPath(resolve(home))) return '~'
  if (isScratchChild(home, path, scratchRoot)) return ''
  const name = basename(path)
  return name === '' ? path : name
}

/**
 * Reading the title (TODO 66). **A provisional title (`title_auto = 1`) becomes
 * `UNTITLED_THREAD_TITLE` (the empty string) regardless of the stored string** - rows from before TODO 66 still have the Japanese default title meaning
 * "new thread" in the DB, so we go by the column and unify to a language-independent marker (no migration is cut). Comparing by string would
 * also treat a row where someone hand-typed the same title (`title_auto = 0`, item 83) as provisional.
 */
function titleOf(row: Pick<ThreadRow, 'title' | 'title_auto'>): string {
  return row.title_auto === 1 ? UNTITLED_THREAD_TITLE : row.title
}

/** The part of the origin shown to the renderer (item 113). The session id and the identifier are dropped. */
function forkOriginOf(row: Pick<ThreadRow, 'fork_origin'>): ForkOrigin | null {
  const stored = parseForkOrigin(row.fork_origin)
  return stored === null
    ? null
    : {
        threadId: stored.threadId,
        eventId: stored.eventId,
        files: stored.files,
        ...(stored.handoff === true ? { handoff: true as const } : {})
      }
}

/** TODO 1216: reads the JSON of `threads.trigger_origin`. null if the shape is wrong (the field is not shown). */
export function parseTriggerOrigin(raw: string | null | undefined): TriggerOrigin | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (typeof value !== 'object' || value === null) return null
    const pluginId = value['pluginId']
    const triggerId = value['triggerId']
    const url = value['url']
    if (typeof pluginId !== 'string' || typeof triggerId !== 'string') return null
    return {
      pluginId,
      triggerId,
      ...(typeof url === 'string' && url.startsWith('https:') ? { url } : {}),
      ...(value['attended'] === true ? { attended: true as const } : {})
    }
  } catch {
    return null
  }
}

function toThread(
  row: ThreadRow,
  home: CwdPlace,
  rainbow: RainbowRegistry,
  cwdDeferred: ReadonlySet<string>
): Thread {
  const dirs = parseStringArray(row.allowed_dirs)
  const sources = parseStringArray(row.setting_sources).filter(isSettingSource)
  const cwdName = threadCwdName(row.cwd, home.home, home.scratchRoot)
  return {
    id: row.id,
    title: titleOf(row),
    cwdUri: pathToUri(row.cwd),
    cwdName,
    // Item 108: a cwd not in the table is handed out here for the first time, and `RainbowRegistry` persists it.
    rainbow: rainbow.indexFor(row.cwd, cwdName),
    allowedDirUris: dirs.map(pathToUri),
    retention: row.retention as ThreadRetention,
    retentionDays: row.retention_days,
    unread: row.unread === 1,
    settingSources: sources,
    backend: row.backend,
    modelId: row.model_id,
    thinking: isThinkingLevel(row.thinking) ? row.thinking : null,
    approvalStrict: row.approval_strict === 1,
    // TODO 1106: false omits the field (omitted = false). Rows from before migration 34 have no column (undefined).
    ...(row.os_sandbox === 1 ? { osSandbox: true } : {}),
    // TODO 1222: likewise, false omits the field.
    ...(row.auto_pick_recommended === 1 ? { autoPickRecommended: true } : {}),
    forkedFrom: forkOriginOf(row),
    // Item 111: what the renderer sees is only whether it branched and whether the model was dropped to the default (item 140).
    transcriptOrigin: ((): TranscriptOrigin | null => {
      const stored = parseTranscriptOrigin(row.transcript_origin)
      if (stored === null) return null
      return stored.modelFallback === true ? { fork: stored.fork, modelFallback: true } : { fork: stored.fork }
    })(),
    lastViewerUri: row.last_viewer_uri,
    lastViewerHighlight: row.last_viewer_uri === null ? null : row.last_viewer_highlight,
    // TODO 323: only scheduled-run threads have the field (the delivery shape of ordinary threads does not change).
    ...(typeof row.schedule_job_id === 'string' ? { scheduledJobId: row.schedule_job_id } : {}),
    // TODO 972: only conversations that belong to a role have the field (the delivery shape of other threads does not change).
    ...(typeof row.role_id === 'string' && row.role_id !== '' ? { roleId: row.role_id } : {}),
    // TODO 982: only drill conversations have the field.
    ...((): { drill?: DrillState } => {
      const drill = drillStateOfColumn(row.drill)
      return drill === null ? {} : { drill }
    })(),
    // TODO 1216: only threads started by a trigger have the field. Broken JSON omits the field.
    ...((): { triggerOrigin?: TriggerOrigin } => {
      const origin = parseTriggerOrigin(row.trigger_origin)
      return origin === null ? {} : { triggerOrigin: origin }
    })(),
    // TODO 521: only stopped threads have the field. An unknown value (a kind written by a newer version) omits the field.
    ...(isInterruptReason(row.interrupted) ? { interrupted: row.interrupted } : {}),
    // TODO 633: only threads that moved into a worktree have the field.
    ...(typeof row.worktree_cwd === 'string' && row.worktree_cwd !== ''
      ? { worktreeUri: pathToUri(row.worktree_cwd), worktreeName: basename(row.worktree_cwd) }
      : {}),
    // TODO 633: only threads whose worktree could not be recreated on restore have the field.
    ...(typeof row.worktree_lost === 'string' && row.worktree_lost !== ''
      ? { worktreeLostName: basename(row.worktree_lost) }
      : {}),
    // TODO 700: only threads where a write outside the worktree was seen have the field.
    ...(typeof row.outside_write_at === 'number' ? { outsideWriteAt: row.outside_write_at } : {}),
    // TODO 1118: only conversations whose working-folder history was deferred until the first send have the field (`THREADS_CWD_HISTORY_DEFERRED`).
    ...(cwdDeferred.has(row.id) ? { cwdHistoryDeferred: true as const } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEventAt: row.last_event_at
  }
}

export class ThreadStore {
  private readonly insertThread: Statement
  private readonly selectThreads: Statement
  private readonly selectThread: Statement
  private readonly updateUnread: Statement
  private readonly updateTitle: Statement
  private readonly updateAutoTitle: Statement
  private readonly updateRetention: Statement
  private readonly updateStrict: Statement
  private readonly updateOsSandbox: Statement
  private readonly updateAutoPick: Statement
  private readonly updateAllowedDirs: Statement
  private readonly selectAllowedDirs: Statement
  private readonly updateModelAndThinking: Statement
  private readonly updateLastEvent: Statement
  private readonly updateViewerState: Statement
  private readonly softDeleteThread: Statement
  private readonly selectRetentionThreads: Statement
  private readonly insertSession: Statement
  private readonly endSession: Statement
  private readonly bumpSession: Statement
  private readonly selectLatestSession: Statement
  private readonly insertEvent: Statement
  private readonly selectEvents: Statement
  private readonly deleteEvents: Statement
  private readonly deleteAllEvents: Statement
  private readonly nextSeq: Statement
  private readonly purgeOld: Statement
  private readonly touchCwdStatement: Statement
  private readonly selectCwdHistory: Statement
  private readonly deleteCwd: Statement
  private readonly deleteAllCwd: Statement
  // Item 75 / 89: statements that used to be `db.prepare`d on every call.
  private readonly selectThreadRecords: Statement
  private readonly selectThreadRecord: Statement
  private readonly bumpThreadTotals: Statement
  private readonly updatePreview: Statement
  private readonly clearAllPreviews: Statement
  private readonly selectSessionTotals: Statement
  private readonly selectPreview: Statement
  private readonly selectEventText: Statement
  private readonly selectThreadTitle: Statement
  private readonly selectLatestTurnUsage: Statement
  /** TODO 961: the first `turn_usage` (estimate of the fixed cost of a new conversation). */
  private readonly selectFirstTurnUsage: Statement
  // Item 113 (bundle G): the branch origin and the material for rewinding.
  private readonly selectForkOrigin: Statement
  private readonly patchMessageId: Statement
  private readonly selectEventRow: Statement
  private readonly selectPriorResponse: Statement
  private readonly selectResetAfter: Statement
  private readonly selectSessionAt: Statement
  // TODO 521 (wave 26 bundle B): the interruption marker.
  private readonly updateInterrupted: Statement
  /** The entry point to `app_settings`. Uses the same implementation as FsService (thinning out scans). */
  private readonly settings: AppSettingsStore
  /** Rainbow colors of working directories (item 108). Injected into `toThread` / `toRecord`. */
  private readonly rainbow: RainbowRegistry
  private readonly place: CwdPlace

  /**
   * @param home The home directory, used only for deriving the display name (`threadCwdName`).
   *   A caller that has FsService passes `fs.homePath` (so tests can replace it).
   * @param scratchRoot This profile's own scratch root when it is not the one under the home folder (TODO 1314), so a
   *   conversation made by a non-default profile is also recognised as a scratch one.
   */
  constructor(
    private readonly db: Database,
    private readonly home: string = homedir(),
    private readonly scratchRoot?: string
  ) {
    this.place = { home, ...(scratchRoot === undefined ? {} : { scratchRoot }) }
    this.insertThread = db.prepare(`
      INSERT INTO threads (id, title, title_auto, cwd, allowed_dirs, retention, retention_days,
                           unread, setting_sources, backend, model_id, thinking,
                           approval_strict, os_sandbox, fork_origin, transcript_origin, schedule_job_id,
                           trigger_origin, role_id, created_at, updated_at, last_event_at)
      VALUES (@id, @title, @title_auto, @cwd, @allowed_dirs, @retention, @retention_days,
              0, @setting_sources, @backend, @model_id, @thinking,
              @approval_strict, @os_sandbox, @fork_origin, @transcript_origin, @schedule_job_id,
              @trigger_origin, @role_id, @now, @now, NULL)
    `)
    // **A row that is logically deleted (item 64) is treated as "absent" from every read path.** The row remains, so
    // forgetting the filter in even one place would bring a deleted thread back. This and the UPDATEs below,
    // `threadTitle` / `eventText` / `indexableEvents` all check `deleted_at IS NULL`.
    //
    // **The order is newest last event first (creation if none)** (item 83, migration 15). It used to be
    // `updated_at` order, and a thread jumped to the top just by marking it read or toggling strict mode.
    // The expression and conditions have the same form as the partial-expression index `threads_recent` of migration 15 (`THREAD_ORDER`).
    this.selectThreads = db.prepare(
      `SELECT * FROM threads WHERE deleted_at IS NULL ${THREAD_ORDER}`
    )
    this.selectThread = db.prepare(`SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL`)
    // One list row (item 75). **All rows in one statement**: the totals and preview are columns (migration 14), and
    // the latest session is a correlated subquery that uses `sessions_thread (thread_id, started_at)`.
    const latestSession = `(SELECT s.backend_session_id FROM sessions s
         WHERE s.thread_id = threads.id ORDER BY s.started_at DESC LIMIT 1)`
    this.selectThreadRecords = db.prepare(
      `SELECT threads.*, ${latestSession} AS latest_backend_session_id FROM threads
       WHERE deleted_at IS NULL ${THREAD_ORDER}`
    )
    this.selectThreadRecord = db.prepare(
      `SELECT threads.*, ${latestSession} AS latest_backend_session_id FROM threads
       WHERE id = ? AND deleted_at IS NULL`
    )
    // **Per-column UPDATEs** (item 83). Before, `saveThread` wrote back all 14 columns, which could
    // overwrite another path's write with a stale `Thread` held across an `await`.
    // Each writes **only the column it changes and `updated_at` (the time the row was touched)**. The order is
    // by `last_event_at`, so even if `updated_at` moves here the list does not jump.
    // `unread` is written only when the value changes (changes can tell the caller "whether it changed").
    this.updateUnread = db.prepare(
      `UPDATE threads SET unread = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND unread <> ?`
    )
    this.updateTitle = db.prepare(
      `UPDATE threads SET title = ?, title_auto = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    )
    // Automatic naming (item 83). Written **only while the title is still provisional** - the condition is put in
    // the UPDATE rather than reading and then writing (a rename by hand in between is not overwritten).
    this.updateAutoTitle = db.prepare(
      `UPDATE threads SET title = ?, title_auto = 0, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND title_auto = 1`
    )
    this.updateRetention = db.prepare(
      `UPDATE threads SET retention = ?, retention_days = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    )
    this.updateStrict = db.prepare(
      `UPDATE threads SET approval_strict = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    )
    this.updateOsSandbox = db.prepare(
      `UPDATE threads SET os_sandbox = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    )
    this.updateAutoPick = db.prepare(
      `UPDATE threads SET auto_pick_recommended = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    )
    this.selectAllowedDirs = db.prepare(
      `SELECT allowed_dirs FROM threads WHERE id = ? AND deleted_at IS NULL`
    )
    this.updateAllowedDirs = db.prepare(
      `UPDATE threads SET allowed_dirs = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
    )
    this.updateModelAndThinking = db.prepare(
      `UPDATE threads SET model_id = ?, thinking = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    )
    // The key of the list order (item 83). Unread may also be raised here (arrival of `result`).
    // The time only moves forward (so a late-arriving event does not push the order backward).
    this.updateLastEvent = db.prepare(
      `UPDATE threads SET last_event_at = MAX(COALESCE(last_event_at, 0), @ts),
         unread = CASE WHEN @unread = 1 THEN 1 ELSE unread END, updated_at = @now
       WHERE id = @id AND deleted_at IS NULL`
    )
    // TODO 521: the interruption marker. Written only when the value changes (`IS NOT` reads NULL and NULL as equal).
    // It moves neither the list order (`last_event_at`) nor `updated_at` - it is a display marker, not a change to the row's attributes.
    this.updateInterrupted = db.prepare(
      `UPDATE threads SET interrupted = ?
       WHERE id = ? AND deleted_at IS NULL AND interrupted IS NOT ?`
    )
    // Item 63. ViewerPane's memory is a memory of the display, not an attribute of the row, so it does not move `updated_at` either.
    this.updateViewerState = db.prepare(`
      UPDATE threads SET last_viewer_uri = ?, last_viewer_highlight = ?
      WHERE id = ? AND deleted_at IS NULL
    `)
    // Item 64: deletion is a **logical deletion**. The row (and sessions / thread_events) stay; only the time is written.
    // The time of an already-deleted row is not rewritten (the time of the first deletion is kept).
    this.softDeleteThread = db.prepare(
      `UPDATE threads SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`
    )
    // Retention (4.3.1) keeps applying to deleted threads too. As long as the row remains,
    // "delete after N days" and "do not save" stay the limits the user promised for that thread.
    this.selectRetentionThreads = db.prepare(
      `SELECT id, retention, retention_days FROM threads WHERE retention IN ('none', 'days')`
    )

    this.insertSession = db.prepare(`
      INSERT INTO sessions (id, thread_id, backend_session_id, forked_from, started_at, backend_version)
      VALUES (@id, @thread_id, @backend_session_id, @forked_from, @started_at, @backend_version)
      ON CONFLICT(backend_session_id) DO UPDATE SET ended_at = NULL
    `)
    // **The key is the backend session ID.** On resume, aios's internal ID is
    // assigned anew, but the row stays a single one by the UNIQUE constraint on backend_session_id,
    // so updating by the internal ID would count not even one turn after the resume (found on a real machine in Phase 2).
    this.endSession = db.prepare(`UPDATE sessions SET ended_at = ? WHERE backend_session_id = ?`)
    this.bumpSession = db.prepare(
      `UPDATE sessions SET turns = turns + 1, cost_usd = cost_usd + ? WHERE backend_session_id = ?`
    )
    this.selectLatestSession = db.prepare(
      `SELECT * FROM sessions WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1`
    )
    // The totals are added to both the session row and the thread row (migration 14). The thread row is
    // added to even if it is logically deleted - it just does not show in the list; this keeps it from disagreeing with the breakdown in sessions.
    this.bumpThreadTotals = db.prepare(`
      UPDATE threads SET turns = turns + 1, cost_usd = cost_usd + ?
      WHERE id = (SELECT thread_id FROM sessions WHERE backend_session_id = ?)
    `)
    this.selectSessionTotals = db.prepare(
      `SELECT COALESCE(SUM(turns),0) AS turns, COALESCE(SUM(cost_usd),0) AS cost
       FROM sessions WHERE thread_id = ?`
    )

    this.insertEvent = db.prepare(`
      INSERT INTO thread_events (id, thread_id, session_id, seq, ts, kind, actor,
                                 parent_tool_use_id, payload, payload_bytes)
      VALUES (@id, @thread_id, @session_id, @seq, @ts, @kind, @actor,
              @parent_tool_use_id, @payload, @payload_bytes)
      -- 同じ id で再度書くのは承認要求の決着を反映するとき (pending → allowed/denied)。
      -- seq は最初に決めたものを保つ。
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload, payload_bytes = excluded.payload_bytes, ts = excluded.ts
    `)
    this.selectEvents = db.prepare(`
      SELECT * FROM (
        SELECT * FROM thread_events WHERE thread_id = ? ORDER BY seq DESC LIMIT ?
      ) ORDER BY seq ASC
    `)
    this.deleteEvents = db.prepare(`DELETE FROM thread_events WHERE thread_id = ?`)
    this.deleteAllEvents = db.prepare(`DELETE FROM thread_events`)
    this.nextSeq = db.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM thread_events WHERE thread_id = ?`
    )
    this.purgeOld = db.prepare(`DELETE FROM thread_events WHERE thread_id = ? AND ts < ?`)
    this.updatePreview = db.prepare(`UPDATE threads SET preview = ? WHERE id = ?`)
    this.clearAllPreviews = db.prepare(`UPDATE threads SET preview = NULL`)
    this.selectPreview = db.prepare(
      `SELECT payload FROM thread_events
       WHERE thread_id = ? AND kind IN ('assistant_text','user_text') AND actor = 'main'
       ORDER BY seq DESC LIMIT 1`
    )
    // If a conversation break (item 117) is after the usage, that usage is no longer "current".
    this.selectLatestTurnUsage = db.prepare(
      `SELECT kind, payload FROM thread_events
       WHERE thread_id = ? AND actor = 'main'
         AND kind IN ('turn_usage', 'conversation_reset', 'context_compacted')
       ORDER BY seq DESC LIMIT 1`
    )
    this.selectFirstTurnUsage = db.prepare(
      `SELECT payload FROM thread_events
       WHERE thread_id = ? AND actor = 'main' AND kind = 'turn_usage'
       ORDER BY seq ASC LIMIT 1`
    )
    // The body of a logically deleted thread is not served as the canonical copy (item 64). Even if a row left in the index
    // from before the tombstone matches a search, it becomes null here and drops out.
    this.selectEventText = db.prepare(
      `SELECT e.id, e.thread_id, e.ts, e.kind, e.payload FROM thread_events e
       JOIN threads t ON t.id = e.thread_id
       WHERE e.id = ? AND t.deleted_at IS NULL`
    )
    this.selectThreadTitle = db.prepare(
      `SELECT title, title_auto FROM threads WHERE id = ? AND deleted_at IS NULL`
    )
    // Item 113: the branch origin and the material for rewinding.
    this.selectForkOrigin = db.prepare(
      `SELECT fork_origin FROM threads WHERE id = ? AND deleted_at IS NULL`
    )
    // Copies the identifier that arrived by the echo into the payload of the saved user_text (no column is added).
    this.patchMessageId = db.prepare(
      `UPDATE thread_events SET payload = json_set(payload, '$.messageId', ?)
       WHERE id = ? AND thread_id = ? AND kind = 'user_text' AND json_valid(payload)`
    )
    this.selectEventRow = db.prepare(
      `SELECT seq, kind, payload FROM thread_events WHERE id = ? AND thread_id = ?`
    )
    // Branch point: the parent's own last reply (body or tool call) before that message. TODO 1121: a conversation reset is also
    // fetched together, and if the reset is later, there is "no previous reply" (right after a reset = from empty).
    this.selectPriorResponse = db.prepare(
      `SELECT kind, seq, ts, payload FROM thread_events
       WHERE thread_id = ? AND seq < ? AND actor = 'main'
         AND kind IN ('assistant_text', 'tool_use', 'conversation_reset')
       ORDER BY seq DESC LIMIT 1`
    )
    // TODO 1121: whether there is a conversation reset after that message.
    this.selectResetAfter = db.prepare(
      `SELECT 1 FROM thread_events
       WHERE thread_id = ? AND seq > ? AND actor = 'main' AND kind = 'conversation_reset' LIMIT 1`
    )
    // TODO 1121: the session in use at a given time (the last row started by that time). `started_at` is written at the first
    // `session_started` and is not changed by the resume upsert.
    this.selectSessionAt = db.prepare(
      `SELECT backend_session_id FROM sessions WHERE thread_id = ? AND started_at <= ?
       ORDER BY started_at DESC LIMIT 1`
    )

    // Working-directory history (migration 7, T5).
    // The primary key is the case-folded path (migration 15, item 84). The same directory differing in case is one row, and
    // the display `path` is replaced with the spelling used last.
    this.touchCwdStatement = db.prepare(`
      INSERT INTO cwd_history (path_folded, path, last_used_at, use_count) VALUES (?, ?, ?, 1)
      ON CONFLICT(path_folded) DO UPDATE SET
        path = excluded.path, last_used_at = excluded.last_used_at, use_count = use_count + 1
    `)
    // TODO 462: most-used first, ties by most recently used. Ordered before cutting at the limit (so a frequently used old folder is not dropped).
    this.selectCwdHistory = db.prepare(
      `SELECT path, last_used_at, use_count FROM cwd_history
       ORDER BY use_count DESC, last_used_at DESC LIMIT ?`
    )
    this.deleteCwd = db.prepare(`DELETE FROM cwd_history WHERE path_folded = ?`)
    this.deleteAllCwd = db.prepare(`DELETE FROM cwd_history`)

    // Approval rules (migration 10, T22). Carried in the thread row as JSON.
    this.settings = new AppSettingsStore(db)
    // Item 108: created after `settings` (it reuses the same AppSettingsStore).
    this.rainbow = new RainbowRegistry(this.settings)
  }

  // ---- Threads ----

  createThread(input: {
    id: string
    title: string
    /** Whether the title is provisional (to be named from the first line of the next send). Defaults to false when omitted (item 83). */
    titleAuto?: boolean
    cwd: string
    allowedDirs: readonly string[]
    retention: ThreadRetention
    /** Defaults when omitted (`project` only). */
    settingSources?: readonly SettingSource[]
    backend: string
    modelId: string | null
    thinking: ThinkingLevel | null
    /** Strict mode (T12). Defaults to false when omitted. */
    approvalStrict?: boolean
    /** OS sandbox (TODO 1106). Defaults to false when omitted. */
    osSandbox?: boolean
    /** Branch origin (item 113). Omitted means an ordinary thread. */
    forkOrigin?: StoredForkOrigin | null
    /** Origin of a thread continued from a transcript (item 111). Omitted means an ordinary thread. */
    transcriptOrigin?: StoredTranscriptOrigin | null
    /** Scheduled-run job (TODO 323). Omitted means an ordinary thread. */
    scheduleJobId?: string | null
    /** Trigger origin (TODO 1216). Omitted means an ordinary thread. */
    triggerOrigin?: TriggerOrigin | null
    /** The role (Teammate) it belongs to (TODO 972). Omitted means no role. */
    roleId?: string | null
  }): Thread {
    const now = Date.now()
    this.insertThread.run({
      id: input.id,
      title: input.title,
      title_auto: input.titleAuto === true ? 1 : 0,
      cwd: input.cwd,
      allowed_dirs: JSON.stringify([...input.allowedDirs]),
      retention: input.retention,
      retention_days: null,
      setting_sources: JSON.stringify([...(input.settingSources ?? DEFAULT_SETTING_SOURCES)]),
      backend: input.backend,
      model_id: input.modelId,
      thinking: input.thinking,
      approval_strict: input.approvalStrict === true ? 1 : 0,
      os_sandbox: input.osSandbox === true ? 1 : 0,
      fork_origin:
        input.forkOrigin === undefined || input.forkOrigin === null
          ? null
          : JSON.stringify(input.forkOrigin),
      transcript_origin:
        input.transcriptOrigin === undefined || input.transcriptOrigin === null
          ? null
          : JSON.stringify(input.transcriptOrigin),
      schedule_job_id: input.scheduleJobId ?? null,
      trigger_origin:
        input.triggerOrigin === undefined || input.triggerOrigin === null ? null : JSON.stringify(input.triggerOrigin),
      role_id: input.roleId ?? null,
      now
    })
    this.invalidateThreadCwds()
    return this.getThread(input.id)!
  }

  /**
   * The whole branch origin (item 113, used only by main). The first launch (`startLive`) uses it as the material for `--resume` while there is
   * no sessions row yet. null for an ordinary thread or a deleted thread.
   */
  forkOriginOf(id: string): StoredForkOrigin | null {
    const row = this.selectForkOrigin.get(id) as { fork_origin: string | null } | undefined
    return row === undefined ? null : parseForkOrigin(row.fork_origin)
  }

  private clearRoleStmt: Statement | null = null

  /**
   * TODO 972: a role was deleted - its conversations stay, without a role (they go back to the ordinary list). Logically deleted rows are
   * included too (a restored conversation must not point at a role that is gone). Returns the number of rows changed. `updated_at` is
   * touched like any attribute change; the list order (`last_event_at`) does not move.
   */
  clearRole(roleId: string): number {
    this.clearRoleStmt ??= this.db.prepare(`UPDATE threads SET role_id = NULL, updated_at = ? WHERE role_id = ?`)
    return this.clearRoleStmt.run(Date.now(), roleId).changes
  }

  private setRoleStmt: Statement | null = null

  /**
   * TODO 1288: puts one live conversation under a role, or takes it out (`roleId` null). Only `role_id` (and `updated_at`) changes. The
   * caller has checked the ids and that the conversation is not running. Returns false when no such live conversation exists.
   */
  setRole(threadId: string, roleId: string | null): boolean {
    this.setRoleStmt ??= this.db.prepare(`UPDATE threads SET role_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    return this.setRoleStmt.run(roleId, Date.now(), threadId).changes > 0
  }

  private patchHandoffSent: Statement | null = null

  /**
   * Puts the marker that the hand-over text was sent into the origin's JSON (TODO 961). No column is added. `through` is the original thread's
   * last message that the attached text covers (TODO 992 part 1; resending overwrites it with the newer one).
   */
  markHandoffSent(id: string, through: string): void {
    this.patchHandoffSent ??= this.db.prepare(
      `UPDATE threads SET fork_origin = json_set(fork_origin, '$.handoffSent', json('true'), '$.handoffThrough', ?)
       WHERE id = ? AND fork_origin IS NOT NULL AND json_valid(fork_origin)`
    )
    this.patchHandoffSent.run(through, id)
  }

  private markStartedUnattendedStmt: Statement | null = null
  private selectStartedUnattendedStmt: Statement | null = null

  /**
   * TODO 1289 (code-review, wave 97 fix Y, migration 48): marks a bundle conversation started from an unattended turn. The mark stays for
   * the conversation's lifetime (a restart, a removal and a restore), like `schedule_job_id` / `trigger_origin`. Not exported (an
   * imported conversation is an ordinary one, as for those two).
   */
  markStartedUnattended(id: string): void {
    this.markStartedUnattendedStmt ??= this.db.prepare(`UPDATE threads SET started_unattended = 1 WHERE id = ?`)
    this.markStartedUnattendedStmt.run(id)
  }

  /** TODO 1289: whether the conversation is a bundle started from an unattended turn (`markStartedUnattended`). */
  isStartedUnattended(id: string): boolean {
    this.selectStartedUnattendedStmt ??= this.db.prepare(`SELECT started_unattended FROM threads WHERE id = ?`)
    const row = this.selectStartedUnattendedStmt.get(id) as { started_unattended: number } | undefined
    return row?.started_unattended === 1
  }

  // ---- Drills (TODO 982, migration 49) ----

  private drillStmts: {
    mark: Statement
    ran: Statement
    unsent: Statement
    state: Statement
    count: Statement
    insertOp: Statement
    ops: Statement
    granted: Statement
    sessions: Statement
  } | null = null

  private drill(): NonNullable<ThreadStore['drillStmts']> {
    this.drillStmts ??= {
      mark: this.db.prepare(`UPDATE threads SET drill = 1 WHERE id = ? AND drill = 0`),
      ran: this.db.prepare(`UPDATE threads SET drill = 2 WHERE id = ? AND drill <> 0`),
      // Only `ran` -> `ready`: an ordinary conversation never becomes a drill here, and an unknown value (counted as `ran`) stays.
      unsent: this.db.prepare(`UPDATE threads SET drill = 1 WHERE id = ? AND drill = 2`),
      // Deleted rows too: the mark is a property of the conversation, read by the gateway whatever the list shows.
      state: this.db.prepare(`SELECT drill FROM threads WHERE id = ?`),
      count: this.db.prepare(`SELECT COUNT(*) AS n FROM drill_ops WHERE thread_id = ?`),
      insertOp: this.db.prepare(
        `INSERT INTO drill_ops (id, thread_id, created_at, tool_use_id, tool_name, target_kind, target, subject, size, grant_candidates, grant_refusal)
         VALUES (@id, @thread_id, @created_at, @tool_use_id, @tool_name, @target_kind, @target, @subject, @size, @grant_candidates, @grant_refusal)`
      ),
      ops: this.db.prepare(`SELECT * FROM drill_ops WHERE thread_id = ? ORDER BY created_at, rowid`),
      granted: this.db.prepare(`UPDATE drill_ops SET granted_at = ? WHERE thread_id = ? AND id = ? AND granted_at IS NULL`),
      sessions: this.db.prepare(
        `SELECT s.backend_session_id AS sid FROM sessions s JOIN threads t ON t.id = s.thread_id WHERE t.drill <> 0`
      )
    }
    return this.drillStmts
  }

  /** TODO 982: marks a just-created conversation as a drill (state `ready`). Only main's `createThread` calls it. */
  markDrill(id: string): void {
    this.drill().mark.run(id)
  }

  /** TODO 982: the drill's one run was sent (`ran`). The mark itself is never cleared. */
  markDrillRan(id: string): void {
    this.drill().ran.run(id)
  }

  /**
   * TODO 982 (wave 101 review fix Y): the one send failed **before anything reached the backend**, so the drill is `ready` again. Only
   * `SendQueueService.submit` calls it, and only on that branch. The mark itself stays (still a drill, the gateway still stops).
   */
  markDrillUnsent(id: string): void {
    this.drill().unsent.run(id)
  }

  /**
   * TODO 982: the conversation's drill state, or null for an ordinary conversation. A read error is thrown, not taken as "not a drill"
   * (the gateway's stop must not open on a failure).
   */
  drillStateOf(id: string): DrillState | null {
    const row = this.drill().state.get(id) as { drill?: number } | undefined
    return drillStateOfColumn(row?.drill)
  }

  /**
   * TODO 982: keeps one stopped operation (the list shown after the drill). **This is the persistence gate for it, like `toPersistable`**:
   * only the smallest description is kept, masked (`redactText`) and cut; never the body (constraints 9 / 10). `grantCandidates` are the
   * values main decided (no secret - `proposeGrants` refuses one). Returns false when the cap (`MAX_DRILL_OPS`) is reached.
   */
  addDrillOp(op: StoredDrillOpInput): boolean {
    const stmts = this.drill()
    const count = (stmts.count.get(op.threadId) as { n: number }).n
    if (count >= MAX_DRILL_OPS) return false
    const masked = (text: string | null, max: number): string | null =>
      text === null ? null : redactText(text.replace(/\s+/g, ' ').trim()).text.slice(0, max)
    stmts.insertOp.run({
      id: op.id,
      thread_id: op.threadId,
      created_at: op.at,
      tool_use_id: op.toolUseId,
      tool_name: op.toolName.slice(0, 200),
      target_kind: op.target?.kind ?? null,
      target: op.target === null ? null : masked(op.target.value, 400),
      subject: masked(op.subject, 200),
      size: op.size,
      grant_candidates: op.grantCandidates === null ? null : JSON.stringify(op.grantCandidates),
      grant_refusal: op.grantRefusal
    })
    return true
  }

  /** TODO 982: the drill's stopped operations, oldest first (rows are re-validated by the caller). */
  drillOps(threadId: string): readonly StoredDrillOp[] {
    return (this.drill().ops.all(threadId) as DrillOpRow[]).map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      at: row.created_at,
      toolUseId: row.tool_use_id,
      toolName: row.tool_name,
      targetKind: row.target_kind,
      target: row.target,
      subject: row.subject,
      size: row.size,
      grantCandidates: row.grant_candidates,
      grantRefusal: row.grant_refusal,
      grantedAt: row.granted_at
    }))
  }

  /** TODO 1292 item 2: marks ops of this drill as allowed from the list. Only ops of `threadId` not marked yet. */
  markDrillOpsGranted(threadId: string, ids: readonly string[], at: number): void {
    const stmts = this.drill()
    this.db.transaction(() => {
      for (const id of ids) stmts.granted.run(at, threadId, id)
    })()
  }

  /**
   * TODO 982: the drill's tool calls as saved (after `toPersistable`: masked, cut) and the tool-use ids that reached the approval stage
   * (`permission_request`), to find the calls the backend ran without asking aios. Requests with no tool-use id are counted by tool name.
   */
  drillToolEvents(threadId: string): {
    readonly uses: readonly { readonly toolUseId: string; readonly name: string; readonly input: JsonValue; readonly at: number }[]
    readonly asked: ReadonlySet<string>
    readonly askedWithoutId: ReadonlyMap<string, number>
  } {
    const rows = this.db
      .prepare(
        `SELECT kind, ts, payload FROM thread_events WHERE thread_id = ? AND kind IN ('tool_use', 'permission_request') ORDER BY seq LIMIT 5000`
      )
      .all(threadId) as { kind: string; ts: number; payload: string }[]
    const uses: { toolUseId: string; name: string; input: JsonValue; at: number }[] = []
    const asked = new Set<string>()
    const askedWithoutId = new Map<string, number>()
    const seenRequests = new Set<string>()
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as Record<string, unknown>
        if (row.kind === 'tool_use') {
          if (typeof payload['toolUseId'] === 'string' && typeof payload['name'] === 'string') {
            uses.push({ toolUseId: payload['toolUseId'], name: payload['name'], input: (payload['input'] ?? null) as JsonValue, at: row.ts })
          }
          continue
        }
        const requestId = typeof payload['requestId'] === 'string' ? payload['requestId'] : null
        if (requestId !== null && seenRequests.has(requestId)) continue
        if (requestId !== null) seenRequests.add(requestId)
        if (typeof payload['toolUseId'] === 'string' && payload['toolUseId'] !== '') asked.add(payload['toolUseId'])
        else if (typeof payload['toolName'] === 'string') askedWithoutId.set(payload['toolName'], (askedWithoutId.get(payload['toolName']) ?? 0) + 1)
      } catch {
        // Broken rows are skipped.
      }
    }
    return { uses, asked, askedWithoutId }
  }

  /** TODO 982: the backend sessions of drill conversations (continuing one from its transcript is refused). */
  drillBackendSessions(): ReadonlySet<string> {
    return new Set((this.drill().sessions.all() as { sid: string }[]).map((row) => row.sid))
  }

  private patchTriggerAttended: Statement | null = null

  /**
   * Marks a trigger conversation as "a person spoke in it themselves" (fix V, code-review). Added to the origin's JSON, no column is added.
   * Until the marker is set, the conversation stays read-only (6.2.6). true only when newly set.
   */
  markTriggerAttended(id: string): boolean {
    this.patchTriggerAttended ??= this.db.prepare(
      `UPDATE threads SET trigger_origin = json_set(trigger_origin, '$.attended', json('true'))
       WHERE id = ? AND trigger_origin IS NOT NULL AND json_valid(trigger_origin)
         AND json_extract(trigger_origin, '$.attended') IS NOT 1`
    )
    return this.patchTriggerAttended.run(id).changes > 0
  }

  private updateBackendIfFresh: Statement | null = null

  /**
   * Changes the backend of a thread that has not sent even one message yet (TODO 1018, ARCHITECTURE 4.6.1). It is fixed at the time of the first send, so
   * if there is any of: a trace of sending (`last_event_at`, `turns`), a session row, an event row, the marker of continuing from a transcript, or a branch
   * that inherits the original session (a `fork_origin` with `backendSessionId`), it does not change and returns false (the caller falls back to a branch).
   * The decision is kept in SQL because a send could get in between reading and changing (the same form as TODO 526).
   */
  setBackendIfFresh(
    id: string,
    backend: string,
    modelId: string | null,
    thinking: ThinkingLevel | null,
    now = Date.now()
  ): boolean {
    this.updateBackendIfFresh ??= this.db.prepare(
      `UPDATE threads SET backend = @backend, model_id = @modelId, thinking = @thinking, updated_at = @now
       WHERE id = @id AND deleted_at IS NULL
         AND last_event_at IS NULL AND turns = 0 AND transcript_origin IS NULL
         AND (fork_origin IS NULL
              OR (json_valid(fork_origin) AND json_extract(fork_origin, '$.backendSessionId') IS NULL))
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.thread_id = threads.id)
         AND NOT EXISTS (SELECT 1 FROM thread_events e WHERE e.thread_id = threads.id)`
    )
    return this.updateBackendIfFresh.run({ id, backend, modelId, thinking, now }).changes > 0
  }

  // ---- Threads continued from a transcript (item 111, 4.5.9) ----

  private selectTranscriptOrigin: Statement | null = null
  private selectTranscriptOrigins: Statement | null = null
  private selectOwnedSessions: Statement | null = null

  /** The whole origin of a thread continued from a transcript (used only by main). null for an ordinary thread or a deleted thread. */
  transcriptOriginOf(id: string): StoredTranscriptOrigin | null {
    this.selectTranscriptOrigin ??= this.db.prepare(
      `SELECT transcript_origin FROM threads WHERE id = ? AND deleted_at IS NULL`
    )
    const row = this.selectTranscriptOrigin.get(id) as { transcript_origin: string | null } | undefined
    return row === undefined ? null : parseTranscriptOrigin(row.transcript_origin)
  }

  /**
   * Table of backend session ids owned by aios threads (item 111). The key is the session id; the value is
   * which thread (`alive` false means logically deleted) and the read-stop position (bytes) up to which the transcript index may be populated:
   * - A `sessions` row (a conversation aios started / continued / branched itself): `limit` null =
   *   that transcript is **not put into the index** (the body is in the index of aios conversations. Putting it in would make it appear twice in search)
   * - A transcript continued with the same id (`transcript_origin`, not a fork): `limit` = the read-stop position at the time of continuing.
   *   Rows up to it stay in the index as a transcript, and what comes after is held by the aios conversation index
   * Rows of deleted threads are included too: the same id cannot be continued again (`sessions.backend_session_id` is
   * unique), and a deleted conversation is not brought back into search from the transcript side (item 64).
   */
  ownedBackendSessions(): ReadonlyMap<string, { threadId: string; alive: boolean; limit: number | null }> {
    this.selectOwnedSessions ??= this.db.prepare(
      `SELECT s.backend_session_id AS sid, s.thread_id AS thread_id, t.deleted_at AS deleted_at
       FROM sessions s JOIN threads t ON t.id = s.thread_id`
    )
    this.selectTranscriptOrigins ??= this.db.prepare(
      `SELECT id, transcript_origin, deleted_at FROM threads WHERE transcript_origin IS NOT NULL`
    )
    const out = new Map<string, { threadId: string; alive: boolean; limit: number | null }>()
    for (const row of this.selectOwnedSessions.all() as { sid: string; thread_id: string; deleted_at: number | null }[]) {
      out.set(row.sid, { threadId: row.thread_id, alive: row.deleted_at === null, limit: null })
    }
    for (const row of this.selectTranscriptOrigins.all() as { id: string; transcript_origin: string | null; deleted_at: number | null }[]) {
      const origin = parseTranscriptOrigin(row.transcript_origin)
      if (origin === null || origin.fork) continue
      out.set(origin.sessionId, { threadId: row.id, alive: row.deleted_at === null, limit: origin.limit })
    }
    return out
  }

  listThreads(): readonly Thread[] {
    const deferred = this.cwdDeferredIds()
    return (this.selectThreads.all() as ThreadRow[]).map((row) => toThread(row, this.place, this.rainbow, deferred))
  }

  getThread(id: string): Thread | null {
    const row = this.selectThread.get(id) as ThreadRow | undefined
    return row === undefined ? null : toThread(row, this.place, this.rainbow, this.cwdDeferredIds())
  }

  /** All rows of the list (item 75). With the same filtering and order as `listThreads`, in **one statement**. */
  listThreadRecords(): readonly ThreadRecord[] {
    const deferred = this.cwdDeferredIds()
    return (this.selectThreadRecords.all() as ThreadRow[]).map((row) =>
      toRecord(row, this.place, this.rainbow, deferred)
    )
  }

  /** One row of the list (item 75). Used for differential delivery (`threadChanged`). */
  getThreadRecord(id: string): ThreadRecord | null {
    const row = this.selectThreadRecord.get(id) as ThreadRow | undefined
    return row === undefined ? null : toRecord(row, this.place, this.rainbow, this.cwdDeferredIds())
  }

  // ---- Per-column UPDATEs (item 83) ----
  //
  // Each does "nothing if the row does not exist (including a logically deleted one)" and returns true if it wrote.
  // Validating values is up to the caller (SessionManager). **There is no entry point that writes back all columns (`saveThread`).**

  /** The unread marker. Written only when the value changes, and then true. */
  setUnread(id: string, unread: boolean, now = Date.now()): boolean {
    const value = unread ? 1 : 0
    return this.updateUnread.run(value, now, id, value).changes > 0
  }

  /** A rename by hand. `auto` is true only when going back to a provisional title (when renamed with an empty title). */
  setTitle(id: string, title: string, auto = false, now = Date.now()): boolean {
    return this.updateTitle.run(title, auto ? 1 : 0, now, id).changes > 0
  }

  /** Automatic naming. Written **only while the title is still provisional**, and true if written. */
  setAutoTitle(id: string, title: string, now = Date.now()): boolean {
    return this.updateAutoTitle.run(title, now, id).changes > 0
  }

  setRetention(
    id: string,
    retention: ThreadRetention,
    days: number | null,
    now = Date.now()
  ): boolean {
    return this.updateRetention.run(retention, days, now, id).changes > 0
  }

  setStrict(id: string, strict: boolean, now = Date.now()): boolean {
    return this.updateStrict.run(strict ? 1 : 0, now, id).changes > 0
  }

  /** OS sandbox (TODO 1106, migration 34). */
  setOsSandbox(id: string, on: boolean, now = Date.now()): boolean {
    return this.updateOsSandbox.run(on ? 1 : 0, now, id).changes > 0
  }

  /** Automatic selection of a question's recommendation (TODO 1222, migration 37). Per conversation, default OFF. */
  setAutoPickRecommended(id: string, on: boolean, now = Date.now()): boolean {
    return this.updateAutoPick.run(on ? 1 : 0, now, id).changes > 0
  }

  /**
   * Adds one directory to the reference scope (the range readable without approval, 4.4). Does nothing if already there.
   * Reading, adding, and writing is one transaction (better-sqlite3 is synchronous, so no other path gets in between).
   */
  addAllowedDir(id: string, path: string, now = Date.now()): boolean {
    let added = false
    this.db.transaction(() => {
      const row = this.selectAllowedDirs.get(id) as { allowed_dirs: string } | undefined
      if (row === undefined) return
      const dirs = parseStringArray(row.allowed_dirs)
      if (dirs.includes(path)) return
      added = this.updateAllowedDirs.run(JSON.stringify([...dirs, path]), now, id).changes > 0
    })()
    return added
  }

  /** The thread's default model / thinking ("from now on", T7). */
  setModelAndThinking(
    id: string,
    modelId: string | null,
    thinking: ThinkingLevel | null,
    now = Date.now()
  ): boolean {
    return this.updateModelAndThinking.run(modelId, thinking, now, id).changes > 0
  }

  /**
   * Time of the last event (the key of the list order, item 83). If `unread: true`, unread is also raised
   * (arrival of `result`). The time only moves forward.
   */
  touchLastEvent(
    id: string,
    ts: number,
    options: { unread?: boolean } = {},
    now = Date.now()
  ): boolean {
    const unread = options.unread === true ? 1 : 0
    return this.updateLastEvent.run({ id, ts, unread, now }).changes > 0
  }

  /** The interruption marker (TODO 521). null clears it. Written only when the value changes, and then true. */
  setInterrupted(id: string, reason: InterruptReason | null): boolean {
    return this.updateInterrupted.run(reason, id, reason).changes > 0
  }

  // ---- worktree (TODO 633 stage 1, migration 23) ----
  private updateWorktreeCwdStatement: Statement | null = null
  private insertThreadWorktreeStatement: Statement | null = null
  private selectThreadWorktreesStatement: Statement | null = null
  private deleteThreadWorktreeStatement: Statement | null = null
  private updateThreadWorktreeKeptStatement: Statement | null = null

  /**
   * Aligns the conversation's working folder with the worktree (null goes back to the original cwd). Written only when the value changes, and returns true.
   * It moves neither the list order nor `updated_at` (like the interruption marker, it is the display following along, not a change to the row's attributes).
   */
  setWorktreeCwd(id: string, path: string | null): boolean {
    this.updateWorktreeCwdStatement ??= this.db.prepare(
      `UPDATE threads SET worktree_cwd = ? WHERE id = ? AND deleted_at IS NULL AND worktree_cwd IS NOT ?`
    )
    return this.updateWorktreeCwdStatement.run(path, id, path).changes > 0
  }

  private updateOutsideWriteStatement: Statement | null = null
  private clearOutsideWriteStatement: Statement | null = null

  /**
   * Writes the time a write outside the worktree was seen (TODO 700). A marker in the list. Moves neither the order nor `updated_at`.
   * false if the row does not exist.
   */
  setOutsideWriteAt(id: string, at: number): boolean {
    this.updateOutsideWriteStatement ??= this.db.prepare(
      `UPDATE threads SET outside_write_at = ? WHERE id = ? AND deleted_at IS NULL`
    )
    return this.updateOutsideWriteStatement.run(at, id).changes > 0
  }

  /**
   * Clears the warning sign in the list (`outside_write_at`) (TODO 709, owner decision 2026-10-11: cleared when the conversation is opened,
   * treated the same as unread). The `outside_write` row in the timeline stays (not touched here). Written only
   * when a value is set (decided by the UPDATE's condition, so it is not read first and then written).
   */
  clearOutsideWriteAt(id: string): boolean {
    this.clearOutsideWriteStatement ??= this.db.prepare(
      `UPDATE threads SET outside_write_at = NULL WHERE id = ? AND deleted_at IS NULL AND outside_write_at IS NOT NULL`
    )
    return this.clearOutsideWriteStatement.run(id).changes > 0
  }

  /** Remembers a worktree made by that conversation (a cleanup target). The same path is not added twice. */
  addThreadWorktree(entry: {
    readonly threadId: string
    readonly path: string
    readonly branch: string | null
    readonly origin: ThreadWorktreeOrigin
    readonly repoCwd: string
    readonly at: number
  }): boolean {
    this.insertThreadWorktreeStatement ??= this.db.prepare(
      `INSERT OR IGNORE INTO thread_worktrees (thread_id, path, branch, origin, repo_cwd, created_at, kept)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    )
    return (
      this.insertThreadWorktreeStatement.run(
        entry.threadId,
        entry.path,
        entry.branch,
        entry.origin,
        entry.repoCwd,
        entry.at
      ).changes > 0
    )
  }

  /** Worktrees made by that conversation (deleted threads can be looked up too - cleanup runs after the logical deletion). */
  threadWorktrees(threadId: string): readonly ThreadWorktreeRecord[] {
    this.selectThreadWorktreesStatement ??= this.db.prepare(
      `SELECT path, branch, origin, repo_cwd, created_at, kept, removed_head FROM thread_worktrees
       WHERE thread_id = ? ORDER BY created_at, rowid`
    )
    const rows = this.selectThreadWorktreesStatement.all(threadId) as {
      path: string
      branch: string | null
      origin: string
      repo_cwd: string
      created_at: number
      kept: string | null
      removed_head: string | null
    }[]
    return rows.map((row) => ({
      threadId,
      path: row.path,
      branch: row.branch,
      origin: isThreadWorktreeOrigin(row.origin) ? row.origin : 'enter',
      repoCwd: row.repo_cwd,
      createdAt: row.created_at,
      kept: row.kept,
      removedHead: row.removed_head
    }))
  }

  private selectKeptWorktreesStatement: Statement | null = null

  /**
   * All worktrees that cleanup "kept" (`kept` is set and not yet removed), regardless of conversation (TODO 714).
   * The source for re-checking existence at launch and dropping the marker for ones removed outside aios.
   */
  allKeptWorktrees(): readonly ThreadWorktreeRecord[] {
    this.selectKeptWorktreesStatement ??= this.db.prepare(
      `SELECT thread_id, path, branch, origin, repo_cwd, created_at, kept, removed_head FROM thread_worktrees
       WHERE kept IS NOT NULL AND removed_head IS NULL ORDER BY thread_id, created_at, rowid`
    )
    const rows = this.selectKeptWorktreesStatement.all() as {
      thread_id: string
      path: string
      branch: string | null
      origin: string
      repo_cwd: string
      created_at: number
      kept: string | null
      removed_head: string | null
    }[]
    return rows.map((row) => ({
      threadId: row.thread_id,
      path: row.path,
      branch: row.branch,
      origin: isThreadWorktreeOrigin(row.origin) ? row.origin : 'enter',
      repoCwd: row.repo_cwd,
      createdAt: row.created_at,
      kept: row.kept,
      removedHead: row.removed_head
    }))
  }

  private selectWorktreeReferenceStatement: Statement | null = null
  private updateThreadWorktreeRemovedStatement: Statement | null = null
  private updateWorktreeLostStatement: Statement | null = null

  /**
   * Whether **another** conversation that is not deleted references that worktree (code-review fix, TODO 633). Either the current working folder
   * (`worktree_cwd`) or a live row of the cleanup table (`removed_head IS NULL`). So that, for a worktree a branch took over or one two conversations entered
   * as the same existing worktree, deleting one does not remove a worktree the other still uses.
   */
  isWorktreeReferencedByOthers(threadId: string, path: string): boolean {
    this.selectWorktreeReferenceStatement ??= this.db.prepare(
      `SELECT 1 FROM threads WHERE deleted_at IS NULL AND id <> ? AND worktree_cwd = ?
       UNION ALL
       SELECT 1 FROM thread_worktrees w JOIN threads t ON t.id = w.thread_id
        WHERE t.deleted_at IS NULL AND w.thread_id <> ? AND w.path = ? AND w.removed_head IS NULL
       LIMIT 1`
    )
    return this.selectWorktreeReferenceStatement.get(threadId, path, threadId, path) !== undefined
  }

  /**
   * Writes that cleanup removed it (`head` = the HEAD at removal, the base for recreating on restore) or recreated it (`head` = null).
   * The branch is aligned to the value in git's list. `kept` is cleared.
   */
  setThreadWorktreeRemoved(threadId: string, path: string, head: string | null, branch?: string | null): void {
    this.updateThreadWorktreeRemovedStatement ??= this.db.prepare(
      `UPDATE thread_worktrees SET removed_head = ?, kept = NULL, branch = COALESCE(?, branch)
       WHERE thread_id = ? AND path = ?`
    )
    this.updateThreadWorktreeRemovedStatement.run(head, branch ?? null, threadId, path)
  }

  private updateSharedWorktreeRemovedStatement: Statement | null = null
  private selectPendingWorktreeThreadsStatement: Statement | null = null

  /**
   * When cleanup removed a worktree, also copies the fact that it was removed and the material for recreating into the rows of **other deleted** conversations that kept the same path as `shared` (TODO 748 (c)).
   * Without copying, restoring such a conversation would not make it a recreation target, and its working folder
   * would silently go back to the original cwd (the transcript is in the worktree side's location, so `--resume` cannot find the conversation - spike 31).
   * If `head` is `REMOVED_HEAD_UNKNOWN`, it is the marker "removed but cannot be recreated". Returns the number of rows copied.
   */
  copyWorktreeRemovedToShared(threadId: string, path: string, head: string, branch: string | null): number {
    this.updateSharedWorktreeRemovedStatement ??= this.db.prepare(
      `UPDATE thread_worktrees SET removed_head = ?, kept = NULL, branch = COALESCE(?, branch)
       WHERE path = ? AND thread_id <> ? AND kept = 'shared' AND removed_head IS NULL
         AND thread_id IN (SELECT id FROM threads WHERE deleted_at IS NOT NULL)`
    )
    return this.updateSharedWorktreeRemovedStatement.run(head, branch, path, threadId).changes
  }

  /**
   * Deleted conversations that have a row for which cleanup has not yet written a result (both `kept` and `removed_head` are NULL) (TODO 748 (b)).
   * Cleanup runs inside `remove` without waiting, and shutdown does not wait for it, so those that overlapped shutdown remain in this form.
   * Re-run at launch. Oldest deletion first.
   */
  deletedThreadsWithPendingWorktrees(): readonly string[] {
    this.selectPendingWorktreeThreadsStatement ??= this.db.prepare(
      `SELECT t.id AS id FROM threads t
        WHERE t.deleted_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM thread_worktrees w
                       WHERE w.thread_id = t.id AND w.kept IS NULL AND w.removed_head IS NULL)
        ORDER BY t.deleted_at, t.rowid`
    )
    return (this.selectPendingWorktreeThreadsStatement.all() as { id: string }[]).map((row) => row.id)
  }

  /** Writes a worktree that could not be recreated on restore (a marker in the list; null clears it). True if the value changed. */
  setWorktreeLost(id: string, path: string | null): boolean {
    this.updateWorktreeLostStatement ??= this.db.prepare(
      `UPDATE threads SET worktree_lost = ? WHERE id = ? AND deleted_at IS NULL AND worktree_lost IS NOT ?`
    )
    return this.updateWorktreeLostStatement.run(path, id, path).changes > 0
  }

  /** Drops from the table a worktree that cleanup removed (or that was already gone). */
  forgetThreadWorktree(threadId: string, path: string): void {
    this.deleteThreadWorktreeStatement ??= this.db.prepare(
      `DELETE FROM thread_worktrees WHERE thread_id = ? AND path = ?`
    )
    this.deleteThreadWorktreeStatement.run(threadId, path)
  }

  /** Writes the reason cleanup kept it (a marker in the list). */
  markThreadWorktreeKept(threadId: string, path: string, reason: string): void {
    this.updateThreadWorktreeKeptStatement ??= this.db.prepare(
      `UPDATE thread_worktrees SET kept = ? WHERE thread_id = ? AND path = ?`
    )
    this.updateThreadWorktreeKeptStatement.run(reason, threadId, path)
  }

  /**
   * Writes the thread's ViewerPane memory (item 63). Validating values is up to the caller (SessionManager).
   * If `uri` is null, highlight is also set to null. false if the row does not exist.
   */
  setViewerState(id: string, uri: string | null, highlight: string | null): boolean {
    return this.updateViewerState.run(uri, uri === null ? null : highlight, id).changes > 0
  }

  // ---- The viewer's back / forward history (TODO 772, migration 28) ----
  // Lazy prepare (the same form as items 88 / 123). Validating values is up to the caller (`viewer-history.ts`).
  // `thread_viewer_history.thread_id` is a foreign key to `threads` (ON DELETE CASCADE), so
  // it is deleted together with the 3-minute physical deletion (526). It stays on logical deletion (64) and comes back on restore.
  private selectViewerHistoryStatement: Statement | null = null
  private upsertViewerHistoryStatement: Statement | null = null
  private deleteViewerHistoryStatement: Statement | null = null

  /** The saved history JSON. null if none. */
  viewerHistoryJson(threadId: string): string | null {
    this.selectViewerHistoryStatement ??= this.db.prepare(
      `SELECT history FROM thread_viewer_history WHERE thread_id = ?`
    )
    const row = this.selectViewerHistoryStatement.get(threadId) as { history: string } | undefined
    return row?.history ?? null
  }

  /** The saved history of all conversations (for re-pointing after a rename, TODO 1149). */
  allViewerHistoryJson(): { readonly threadId: string; readonly history: string }[] {
    return this.db.prepare(`SELECT thread_id AS threadId, history FROM thread_viewer_history`).all() as {
      threadId: string
      history: string
    }[]
  }

  /** Writes. If `json` is null, the row is deleted. If the conversation's row does not exist, the foreign key refuses it (the caller checks first). */
  setViewerHistoryJson(threadId: string, json: string | null, now = Date.now()): void {
    if (json === null) {
      this.deleteViewerHistoryStatement ??= this.db.prepare(
        `DELETE FROM thread_viewer_history WHERE thread_id = ?`
      )
      this.deleteViewerHistoryStatement.run(threadId)
      return
    }
    this.upsertViewerHistoryStatement ??= this.db.prepare(
      `INSERT INTO thread_viewer_history (thread_id, history, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at`
    )
    this.upsertViewerHistoryStatement.run(threadId, json, now)
  }

  /**
   * **Logically deletes** a thread (item 64). The rows of `threads` / `sessions` / `thread_events`
   * remain, and from then on are invisible to `getThread` / `listThreads`. There is no physical purge, so
   * the `threads` table does not shrink (ARCHITECTURE.md 4.3.3). true if a row was deleted.
   */
  removeThread(id: string, now = Date.now()): boolean {
    const removed = this.softDeleteThread.run(now, id).changes > 0
    if (removed) this.invalidateThreadCwds()
    return removed
  }

  // ---- Deleted list and restore (item 191) ----
  //
  // The retention period is unlimited (owner decision 2026-09-28). No new cleanup mechanism is made - the row
  // is not removed by `removeThread` in the first place, so what is brought back here is only the one column `deleted_at`.
  // **Prepared lazily** (the same form as items 88 / 123. Not touching the order of statements in the constructor
  // avoids collisions with other bundles running in parallel).

  private selectDeletedThreadsStatement: Statement | null = null
  private restoreThreadStatement: Statement | null = null

  /** The deleted list (newest deletion first). The minimum values shown in the fold at the bottom of the sidebar. */
  listDeletedThreads(): readonly DeletedThreadSummary[] {
    this.selectDeletedThreadsStatement ??= this.db.prepare(
      `SELECT threads.*,
         (SELECT COUNT(*) FROM thread_worktrees w WHERE w.thread_id = threads.id AND w.kept IS NOT NULL)
           AS kept_worktrees
       FROM threads WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, rowid DESC`
    )
    return (this.selectDeletedThreadsStatement.all() as (ThreadRow & { kept_worktrees: number })[]).map(
      (row) => {
        const cwdName = threadCwdName(row.cwd, this.home, this.scratchRoot)
        return {
          id: row.id,
          title: titleOf(row),
          cwdName,
          rainbow: this.rainbow.indexFor(row.cwd, cwdName),
          // The filter passes only `IS NOT NULL`, so it is always a number.
          deletedAt: row.deleted_at ?? 0,
          // TODO 633: the number of worktrees that cleanup kept. The field is omitted if 0.
          ...(row.kept_worktrees > 0 ? { keptWorktrees: row.kept_worktrees } : {})
        }
      }
    )
  }

  /**
   * Cancels a logical deletion (item 191). It only sets `deleted_at` back to NULL, and from then on it is visible normally
   * to `getThread` / `listThreads` / `indexableEvents` (all of which filter on `deleted_at IS NULL`).
   * false for an id that is not deleted or does not exist.
   * Scratch-area files (T19, which `remove` really deletes) do not come back - only the row does.
   */
  restoreThread(id: string): boolean {
    this.restoreThreadStatement ??= this.db.prepare(
      `UPDATE threads SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`
    )
    const restored = this.restoreThreadStatement.run(id).changes > 0
    if (restored) this.invalidateThreadCwds()
    return restored
  }

  // ---- Physical deletion of abandoned threads (TODO 526) ----
  //
  // Threads that were "created but never sent" are deleted row and all, without going through the logical deletion (item 64).
  // The conditions are kept in SQL (the same expression for both reading the candidates and deleting - even if
  // a send gets in between reading and deleting, the deletion side's condition excludes it). `sessions` / `thread_events` are
  // deleted together via `ON DELETE CASCADE` (migration 1; `foreign_keys = ON` is in `db-open.ts`).
  // Lazy prepare is the same form as items 88 / 123 / 191 (not touching the order in the constructor).
  //
  // - `title_auto = 1`: a row that was named by hand is kept as one where "there was input".
  // - `last_event_at IS NULL`: there has been neither a send (`touchLastEvent`) nor a reply. A thread with `retention = 'none'`
  //   has no event rows, so the event count alone cannot decide.
  // - `turns = 0` and no sessions / thread_events rows: a double check just in case.
  // - Rows of branches (113), continued transcripts (111), and scheduled runs (323) have contents or waiting time, so they are excluded.
  private static readonly ABANDONED_WHERE = `deleted_at IS NULL AND title_auto = 1
       AND last_event_at IS NULL AND turns = 0
       AND schedule_job_id IS NULL AND fork_origin IS NULL AND transcript_origin IS NULL
       AND trigger_origin IS NULL
       AND created_at <= @cutoff
       AND NOT EXISTS (SELECT 1 FROM thread_events e WHERE e.thread_id = threads.id)
       AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.thread_id = threads.id)`
  private selectAbandonedStatement: Statement | null = null
  private purgeAbandonedStatement: Statement | null = null

  /** Candidates that may be physically deleted (oldest creation first). Only rows created at or before `cutoff`. */
  abandonedThreads(cutoff: number): readonly { id: string; cwd: string; createdAt: number }[] {
    this.selectAbandonedStatement ??= this.db.prepare(
      `SELECT id, cwd, created_at FROM threads WHERE ${ThreadStore.ABANDONED_WHERE} ORDER BY created_at ASC`
    )
    const rows = this.selectAbandonedStatement.all({ cutoff }) as { id: string; cwd: string; created_at: number }[]
    return rows.map((row) => ({ id: row.id, cwd: row.cwd, createdAt: row.created_at }))
  }

  /**
   * Physically deletes one row. Deletes **only when the same conditions are still met at the time of deletion**, and returns true if deleted.
   * A separate entry point from `removeThread` (item 64), which writes `deleted_at` - it does not appear in the deleted list either.
   */
  purgeAbandonedThread(id: string, cutoff: number): boolean {
    this.purgeAbandonedStatement ??= this.db.prepare(
      `DELETE FROM threads WHERE id = @id AND ${ThreadStore.ABANDONED_WHERE}`
    )
    const purged = this.purgeAbandonedStatement.run({ id, cutoff }).changes > 0
    if (purged) this.invalidateThreadCwds()
    return purged
  }

  /** Time until physical deletion (TODO 526). Defaults to 3 minutes if there is no stored value or it is broken. 0 or less means "do not delete". */
  abandonedThreadTtlMs(): number {
    return this.settings.readTyped(ABANDONED_THREAD_TTL_MS) ?? DEFAULT_ABANDONED_THREAD_TTL_MS
  }

  // ---- Working-directory history (T5 / TODO 6) ----

  /** Records a working directory that was used. For the same path, the count is increased. */
  touchCwd(path: string, now = Date.now()): void {
    this.touchCwdStatement.run(foldPath(path), path, now)
  }

  /**
   * Most-used first (ties newest first, TODO 462). The limit is `CWD_HISTORY_LIMIT` (100).
   * **Returned as paths**, so convert them to URIs and names before handing them to the renderer.
   */
  cwdHistory(limit = CWD_HISTORY_LIMIT): readonly { path: string; lastUsedAt: number; useCount: number }[] {
    const rows = this.selectCwdHistory.all(limit) as {
      path: string
      last_used_at: number
      use_count: number
    }[]
    return rows.map((row) => ({
      path: row.path,
      lastUsedAt: row.last_used_at,
      useCount: row.use_count
    }))
  }

  /**
   * The rainbow color of a history folder (TODO 742). **Call it only for rows in the history (rows `cwdHistory()` returns, `useCount > 0`)** -
   * that cwd has already been given a color at least once by `toThread` (it is in the history precisely because a thread
   * existed), so the call here only reads the existing value in the table and does not hand out a new number. Do not call this for a folder not yet
   * in the history (one just picked with "Open Folder...", or the home's pseudo row, `useCount
   * === 0`) - merely closing the dialog would consume one unused color.
   */
  rainbowIndexFor(cwd: string, cwdName: string): number | null {
    return this.rainbow.indexFor(cwd, cwdName)
  }

  // Item 123: the statement is not added to the order in the constructor but lazily prepared here (to avoid collisions with bundles running in parallel).
  private selectCwdKnown?: Statement

  /** Whether it is in the working-folder history (item 123, deciding a first-time folder). Compared by the case-folded path. */
  hasCwd(path: string): boolean {
    this.selectCwdKnown ??= this.db.prepare(`SELECT 1 FROM cwd_history WHERE path_folded = ?`)
    return this.selectCwdKnown.get(foldPath(path)) !== undefined
  }

  // ---- Marker for conversations whose working-folder history was deferred (fix from the review of TODO 1118) ----

  /** A copy of `THREADS_CWD_HISTORY_DEFERRED`. Built when first read, and replaced on every write. */
  private cwdDeferred?: ReadonlySet<string>

  private cwdDeferredIds(): ReadonlySet<string> {
    this.cwdDeferred ??= new Set(this.settings.readTyped(THREADS_CWD_HISTORY_DEFERRED))
    return this.cwdDeferred
  }

  private writeCwdDeferred(ids: ReadonlySet<string>): void {
    this.cwdDeferred = ids
    if (ids.size === 0) this.settings.removeTyped(THREADS_CWD_HISTORY_DEFERRED)
    else this.settings.writeTyped(THREADS_CWD_HISTORY_DEFERRED, [...ids])
  }

  /**
   * Marks a conversation that was not put into the working-folder history at creation (a first-time folder via `aios://new`). Markers of conversations whose row is gone
   * (physically deleted without sending, or discarded) are swept here - this is the only entry point that adds, so the number of markers is capped by the number of remaining conversations.
   */
  markCwdHistoryDeferred(threadId: string): void {
    this.selectThreadExists ??= this.db.prepare(`SELECT 1 FROM threads WHERE id = ?`)
    const next = new Set<string>()
    for (const id of this.cwdDeferredIds()) {
      if (this.selectThreadExists.get(id) !== undefined) next.add(id)
    }
    next.add(threadId)
    this.writeCwdDeferred(next)
  }

  /** If there is a marker, removes it and returns true (the signal to put it in the history at the first send). If not, does nothing and returns false. */
  takeCwdHistoryDeferred(threadId: string): boolean {
    const current = this.cwdDeferredIds()
    if (!current.has(threadId)) return false
    const next = new Set(current)
    next.delete(threadId)
    this.writeCwdDeferred(next)
    return true
  }

  private selectThreadExists?: Statement

  /** Deletes the same row even for a spelling that differs in case (the primary key is the case-folded path). */
  removeCwd(path: string): void {
    this.deleteCwd.run(foldPath(path))
  }

  clearCwdHistory(): void {
    this.deleteAllCwd.run()
  }

  // ---- Sessions ----

  /**
   * Records a backend session.
   * **A normal resume does not add a row** (spike 1: the ID does not change with `--resume`).
   * The UNIQUE constraint on `backend_session_id` and ON CONFLICT guarantee that.
   */
  recordSession(input: {
    id: string
    threadId: string
    backendSessionId: string
    forkedFrom: string | null
    backendVersion: string | null
  }): void {
    this.insertSession.run({
      id: input.id,
      thread_id: input.threadId,
      backend_session_id: input.backendSessionId,
      forked_from: input.forkedFrom,
      started_at: Date.now(),
      backend_version: input.backendVersion
    })
  }

  finishSession(backendSessionId: string): void {
    this.endSession.run(Date.now(), backendSessionId)
  }

  /**
   * Cumulative turn count and cost. `result.num_turns` is not cumulative (spike 1).
   * Advances the session row (breakdown) and the thread row (for the list, migration 14) in one transaction.
   */
  addTurn(backendSessionId: string, costUsd: number): void {
    this.db.transaction(() => {
      this.bumpSession.run(costUsd, backendSessionId)
      this.bumpThreadTotals.run(costUsd, backendSessionId)
    })()
  }

  /** The backend session ID used for resuming. */
  latestBackendSessionId(threadId: string): string | null {
    const row = this.selectLatestSession.get(threadId) as
      | { backend_session_id: string }
      | undefined
    return row?.backend_session_id ?? null
  }

  /**
   * The cumulative recounted from the session breakdown. The list reads `threads.turns` / `cost_usd` (migration 14),
   * so this is for checking and confirming discrepancies.
   */
  sessionTotals(threadId: string): { turns: number; costUsd: number } {
    const row = this.selectSessionTotals.get(threadId) as { turns: number; cost: number }
    return { turns: row.turns, costUsd: row.cost }
  }

  // ---- Timeline ----

  /**
   * Reduces an event to a form that may be saved. **This, not the caller, is the single choke point**, so that
   * kinds forbidden from saving do not leak (constraint 10).
   * Returns null when it is not saved.
   */
  private toPersistable(event: AiosEvent): { kind: string; payload: JsonValue } | null {
    if (EPHEMERAL_EVENT_KINDS.has(event.kind)) return null

    switch (event.kind) {
      case 'user_text':
      case 'assistant_text': {
        // Redaction is applied to user messages too (4.3.1).
        const { text } = redactText(event.payload.text)
        // The message identifier (item 113) is an opaque id, not body text. It is the key for rewinding, so it is kept.
        const messageId = event.payload.messageId
        // Sent images (TODO 550). For a file, only the path; for an image with no file, only the reduced version (up to 1600 px).
        // The reduced version is not body text (redaction would break it), so its shape is re-validated and it is passed through as is. Redaction is applied to the name.
        const attachments =
          event.kind === 'user_text'
            ? persistableSentAttachments(event.payload.attachments, (name) => redactText(name).text)
            : []
        return {
          kind: event.kind,
          payload: {
            text,
            ...(messageId === undefined ? {} : { messageId }),
            ...(attachments.length === 0 ? {} : { attachments: attachments as unknown as JsonValue })
          }
        }
      }
      case 'tool_use': {
        // A subagent's tool calls (item 257, owner decision 2026-09-30): only the name and a summary
        // (a one-line path or command) are kept. The body of the arguments (contents being written, etc.) is not kept - after reopening,
        // the block needs only a one-liner of "what was read and what was run" (the same granularity as the CLI / VS Code child rows).
        if (event.actor === 'subagent') return this.childToolUse(event.payload)
        const redacted = redactJson(event.payload.input)
        const progress = event.payload.progress
        const todos = event.payload.todos
        const plan = event.payload.plan
        return {
          kind: event.kind,
          payload: {
            toolUseId: event.payload.toolUseId,
            name: event.payload.name,
            summary: redactText(event.payload.summary).text,
            input: redacted.value,
            truncated: event.payload.truncated,
            // The reply identifier (item 113). It can be a branch point candidate, so it is kept.
            ...(event.payload.messageId === undefined ? {} : { messageId: event.payload.messageId }),
            // A one-line interim report (5.1.3). Saved so that **the same list appears when a past turn is reopened**.
            // It is built from the `tool_use` side, so constraint 10 is not touched. Redaction is applied.
            ...(progress === undefined
              ? {}
              : {
                  progress: {
                    kind: progress.kind,
                    label: redactText(progress.label).text,
                    ...(progress.href === undefined
                      ? {}
                      : { href: redactText(progress.href).text })
                  }
                }),
            // The work list (item 118). Kept so the latest is shown after a restart and before "read more".
            // It is text the model wrote, so redaction is applied.
            ...(todos === undefined
              ? {}
              : {
                  todos: todos.map((item) => ({
                    content: redactText(item.content).text,
                    activeForm: item.activeForm === null ? null : redactText(item.activeForm).text,
                    status: item.status
                  }))
                }),
            // The body of the plan (item 167). `input` is truncated, so the full text is kept here. A plan that passed automatically
            // with Plan OFF remains only in the timeline. It is text the model wrote, so redaction is applied.
            ...(plan === undefined ? {} : { plan: redactText(plan).text }),
            // Entering and leaving plan mode (item 275). Only the direction and the plan file path. The DB shape is not changed (a payload field).
            ...(event.payload.planTransition === undefined ? {} : { planTransition: event.payload.planTransition }),
            ...(event.payload.planFile === undefined ? {} : { planFile: redactText(event.payload.planFile).text }),
            // The name of the skill used (TODO 1100). The source of the timeline badge. Kept so the same badge appears after reopening
            // (it is a field on the `tool_use` side, so constraint 10 is not touched). It is a string the model wrote, so redaction is applied.
            ...(event.payload.skill === undefined ? {} : { skill: redactText(event.payload.skill).text })
          }
        }
      }
      case 'tool_result':
        // **The contents are not saved** (constraint 10). Only the length and success.
        return {
          kind: event.kind,
          payload: {
            toolUseId: event.payload.toolUseId,
            ok: event.payload.ok,
            bytes: event.payload.bytes
          }
        }
      case 'permission_request': {
        // TODO 838: after redaction, cut by the same rule as tool_use (do not keep the full text of a Write, etc., constraint 9).
        // The order is redaction first - cutting first would lose the PEM END and the minimum length, and a secret fragment would remain as is.
        const redacted = redactJson(event.payload.input)
        return {
          kind: event.kind,
          payload: {
            requestId: event.payload.requestId,
            toolUseId: event.payload.toolUseId,
            toolName: event.payload.toolName,
            summary: redactText(event.payload.summary).text,
            input: clipPermissionInput(redacted.value),
            requestedAt: event.payload.requestedAt,
            decidedAt: event.payload.decidedAt,
            outcome: persistableApprovalOutcome(event.payload.outcome) as unknown as JsonValue,
            // The number of lines of the plan shown (observation of item 196). Only the number.
            ...(event.payload.planLines === undefined ? {} : { planLines: event.payload.planLines })
          }
        }
      }
      // `result.text` is the body of the last reply itself (the same text as `assistant_text`). **Not kept** -
      // the canonical copy of body text is one (constraint 9), and this one had not been through redaction either. Only the count and kind are shown.
      case 'result':
        return { kind: event.kind, payload: asJson({ ...event.payload, text: null }) }
      // The text of an abnormal exit is the tail of the CLI's stderr and may contain secrets, so redaction is applied (4.3.1).
      case 'error':
        return {
          kind: event.kind,
          payload: asJson({ ...event.payload, message: redactText(event.payload.message).text })
        }
      // Switching model / thinking (T7 / 4.5.1). It is not body text, so redaction
      // passes it through, but it goes through the gate because of the rule that **there is only one save choke point** (constraints 9 / 10).
      // `turn_usage` (item 60) is only numbers and a model name. It contains no body text, so constraints 9 / 10
      // are not touched, but it is kept to show "the current context usage" again after a restart.
      case 'settings_changed':
      case 'session_started':
      case 'turn_usage':
        return { kind: event.kind, payload: asJson(event.payload) }
      // Usage limits (item 317). What the timeline shows is only the row where the limit was hit (`rejected`) and the row of switching
      // to metered billing (`usingOverage`), so **nothing else is accumulated** (a few rows come every turn).
      // The usage rates (`windows`) are held by the latest values of the BottomBar / settings screen (main's `UsageTracker`, `app_settings`),
      // so they are not kept in the row.
      case 'rate_limit': {
        if (event.payload.status !== 'rejected' && !event.payload.usingOverage) return null
        const { windows: _windows, ...rest } = event.payload
        return { kind: event.kind, payload: asJson(rest) }
      }
      // A conversation break (item 117). Contains no body text (only a number and the kind of trigger). Needed for the timeline's divider and for
      // restoring "the current context usage" and the work list after a restart (nothing before the break is used).
      case 'conversation_reset':
      case 'context_compacted':
        return { kind: event.kind, payload: asJson(event.payload) }
      // Work running in the background (item 93 / 4.6.3). Only the start and end are kept. **The body of the instruction to the child (prompt) is
      // already dropped at the parser** (in the spirit of constraint 10). The description and summary are text the child's model wrote, so
      // redaction is applied. The output location is only a path, and its contents are not read.
      case 'subtask_started':
        return {
          kind: event.kind,
          payload: {
            taskId: event.payload.taskId,
            toolUseId: event.payload.toolUseId,
            description: redactText(event.payload.description).text,
            subagentType: event.payload.subagentType,
            isSubagent: event.payload.isSubagent
          }
        }
      case 'subtask_finished':
        return {
          kind: event.kind,
          payload: {
            taskId: event.payload.taskId,
            toolUseId: event.payload.toolUseId,
            status: event.payload.status,
            summary:
              event.payload.summary === null ? null : redactText(event.payload.summary).text,
            usage: event.payload.usage === null ? null : asJson(event.payload.usage),
            outputFile: event.payload.outputFile
          }
        }
      // Progress is not saved. It is frequent (every tool call of the child), and the final usage value is held by the end row.
      case 'subtask_progress':
        return null
      // The prompt field's `!` (item 116 / 4.5.7). **Treated the same as a user message**: the command and output
      // are kept after redaction (owner decision 2026-09-27). The output was already cut to the limit by the side that ran it
      // (the same value as the Bash tool). It is a different thing from a backend tool's output (`tool_result`, constraint 10) -
      // text the user ran themselves and put into the conversation themselves. It is not put in the index (outside the kinds of `indexableEvents`).
      case 'shell_run':
        return {
          kind: event.kind,
          payload: {
            command: redactText(event.payload.command).text,
            stdout: redactText(event.payload.stdout).text,
            stderr: redactText(event.payload.stderr).text,
            exitCode: event.payload.exitCode,
            status: event.payload.status,
            truncated: event.payload.truncated,
            durationMs: event.payload.durationMs,
            errorCode: event.payload.errorCode
          }
        }
      // A configured hook finished running (item 126-3). **The output is already dropped at the parser** (owner decision
      // 2026-09-27, treated the same as constraint 10), so we only enumerate the fields and copy them - even if fields are added to the payload later,
      // they pass through without being saved. The name is a string written in the settings, so redaction is applied. Not put in the index.
      case 'hook_run':
        return {
          kind: event.kind,
          payload: {
            hookId: event.payload.hookId,
            hookName: redactText(event.payload.hookName).text,
            hookEvent: event.payload.hookEvent,
            outcome: event.payload.outcome,
            exitCode: event.payload.exitCode
          }
        }
      // The marker for a write outside the worktree (TODO 700). A row main makes, with only the target path and kind (no contents).
      // Redaction is applied to the path too (a secret-looking shape rarely appears in a user's path, but the choke point is one place).
      case 'outside_write':
        return {
          kind: event.kind,
          payload: {
            toolUseId: event.payload.toolUseId,
            path: redactText(event.payload.path).text,
            scope: event.payload.scope
          }
        }
      // Replacement of the command list (the rest of item 117). Names only. The `/` completion of a reopened thread (item 68)
      // uses this when it comes after the list in `session_started`. Not put in the index.
      case 'commands_changed':
        return { kind: event.kind, payload: { commands: [...event.payload.commands] } }
      // Location of a skill's body (TODO 1105). Only the URI (the body was already thrown away at the parser). Kept so the badge can still be clicked after reopening.
      // redactText is not applied (it could break the URI). As with other persisted paths (planFile / outside_write.path),
      // only check that it is the `file:` scheme, and otherwise do not keep it.
      case 'skill_loaded':
        return event.payload.uri.startsWith('file://') && event.payload.uri.length <= 2048
          ? { kind: event.kind, payload: { uri: event.payload.uri } }
          : null
      case 'unknown':
        // D-8 (review 2026-09-21): do not save it raw. Keep the form in which fields that could carry body text
        // (`content` / `result` / `text` / `stdout` / `stderr` / `output` / `prompt`)
        // are recursively dropped, plus only `hint` and the original length. Raw display
        // is kept to the lifetime of the live process (`AiosEvent.payload.raw`, `parse.ts`).
        return {
          kind: event.kind,
          payload: {
            hint: event.payload.hint,
            length: event.payload.raw.length,
            raw: scrubUnknownRaw(event.payload.raw) ?? ''
          }
        }
      default:
        return null
    }
  }

  /**
   * The saved form of a subagent's tool call (item 257). `input` is null (arguments are not kept),
   * and `truncated` is a marker for "there were arguments but they were not kept". The one-line interim report (`progress`) is a short display of a path or
   * search term, so it is kept. The work list and plan do not attach to a child (and would not be kept even if they did).
   */
  private childToolUse(payload: ToolUsePayload): { kind: string; payload: JsonValue } {
    const progress = payload.progress
    const hadInput =
      payload.input !== null &&
      (typeof payload.input !== 'object' || Object.keys(payload.input).length > 0)
    return {
      kind: 'tool_use',
      payload: {
        toolUseId: payload.toolUseId,
        name: payload.name,
        summary: redactText(payload.summary).text,
        input: null,
        truncated: hadInput || payload.truncated,
        ...(payload.messageId === undefined ? {} : { messageId: payload.messageId }),
        ...(progress === undefined
          ? {}
          : {
              progress: {
                kind: progress.kind,
                label: redactText(progress.label).text,
                ...(progress.href === undefined ? {} : { href: redactText(progress.href).text })
              }
            })
      }
    }
  }

  /**
   * Writes one batch in one transaction (the encrypted DB takes +77% write time compared with plaintext).
   *
   * `sessionId` is **the aios internal session id that produced the event** (one per process).
   * After `--resume` it does not match `sessions.id` (the first internal id remains), so it is not used as the column
   * that joins with `sessions` (decision of item 83). The session key is `backend_session_id`.
   *
   * `previewChanged` (code-review of TODO 686): whether this batch rewrote `threads.preview`.
   * The caller (`SessionManager.flush`) looks only at this to decide whether to raise `emitThread` - this is
   * the single decision, so the caller is not given a copy of the same rule (a double bookkeeping that would
   * look at the raw `event.kind` rather than the one after `toPersistable`).
   */
  appendEvents(
    thread: Thread,
    sessionId: string | null,
    events: readonly AiosEvent[]
  ): { readonly written: number; readonly previewChanged: boolean } {
    if (thread.retention === 'none') return { written: 0, previewChanged: false }
    const rows: {
      id: string
      thread_id: string
      session_id: string | null
      seq: number
      ts: number
      kind: string
      actor: string
      parent_tool_use_id: string | null
      payload: string
      payload_bytes: number
    }[] = []

    let seq = (this.nextSeq.get(thread.id) as { next: number }).next
    // The last message of this batch (item 75). As with `previewOf`, it is decided by "the last one", and
    // if empty it goes back to null. The text after redaction (the same as what is saved) is used.
    let preview: { text: string | null } | null = null
    for (const event of events) {
      const persistable = this.toPersistable(event)
      if (persistable === null) continue
      // A child's message (item 257) is not made the list preview (it is not the parent conversation's last message).
      if (
        event.actor === 'main' &&
        (persistable.kind === 'user_text' || persistable.kind === 'assistant_text')
      ) {
        const text = (persistable.payload as { text?: unknown }).text
        preview = { text: normalizePreview(typeof text === 'string' ? text : null) }
      }
      const payload = JSON.stringify(persistable.payload)
      rows.push({
        id: event.id,
        thread_id: thread.id,
        session_id: sessionId,
        seq,
        ts: event.ts,
        kind: persistable.kind,
        actor: event.actor,
        parent_tool_use_id: event.parentToolUseId ?? null,
        payload,
        payload_bytes: Buffer.byteLength(payload, 'utf8')
      })
      seq += 1
    }
    if (rows.length === 0) return { written: 0, previewChanged: false }

    const write = this.db.transaction(() => {
      for (const row of rows) this.insertEvent.run(row)
      if (preview !== null) this.updatePreview.run(preview.text, thread.id)
    })
    write()
    return { written: rows.length, previewChanged: preview !== null }
  }

  /**
   * The statement for "read more" (item 88). Pulls the previous page with the keyset `seq < ?`.
   * **Kept closed in here and prepared lazily** (so the order of statements in the constructor is not touched).
   * Once prepared, it is reused (the same as item 89's "do not prepare on every call").
   */
  private selectEventsPage: Statement | null = null
  private countEventsBefore: Statement | null = null

  private selectTimelineVersion: Statement | null = null

  /**
   * The version of a thread's saved rows (review of TODO 961: the key of the hand-over text's cache). With the minimum and maximum `seq` and the count,
   * it changes whether rows are added, the older side is removed by retention, or everything is deleted and reinserted.
   * It reads only the range of `thread_events_thread (thread_id, seq)`.
   */
  timelineVersion(threadId: string): string {
    this.selectTimelineVersion ??= this.db.prepare(
      `SELECT COALESCE(MIN(seq), 0) AS lo, COALESCE(MAX(seq), 0) AS hi, COUNT(*) AS n
       FROM thread_events WHERE thread_id = ?`
    )
    const row = this.selectTimelineVersion.get(threadId) as { lo: number; hi: number; n: number }
    return `${row.lo}:${row.hi}:${row.n}`
  }

  private selectNextOwnQuestion: Statement | null = null
  private selectOldestSeq: Statement | null = null

  /**
   * The upper bound, in the original thread's saved rows, of what was passed on to a branch or hand-over (review fix of TODO 992 part 1).
   * `before` is the exclusive upper bound to pass as `before` of `readTimelinePage`, and always includes the row of `eventId`:
   * the `before` form is the row after `eventId`'s, and the `through` form is the first parent user message after it (if none, `undefined` = to the end,
   * since the turn may still be continuing). `oldestSeq` is the oldest row (it changes if the older side is removed by retention).
   * null if `eventId` is not among the saved rows (a past part of a transcript, or removed) - the caller reads everything.
   */
  inheritedBound(
    threadId: string,
    eventId: string,
    mode: 'before' | 'through'
  ): { readonly before: number | undefined; readonly oldestSeq: number } | null {
    const row = this.selectEventRow.get(eventId, threadId) as { seq: number } | undefined
    if (row === undefined) return null
    this.selectOldestSeq ??= this.db.prepare(`SELECT MIN(seq) AS lo FROM thread_events WHERE thread_id = ?`)
    const oldestSeq = (this.selectOldestSeq.get(threadId) as { lo: number | null }).lo ?? row.seq
    if (mode === 'before') return { before: row.seq + 1, oldestSeq }
    this.selectNextOwnQuestion ??= this.db.prepare(
      `SELECT seq FROM thread_events
       WHERE thread_id = ? AND seq > ? AND actor <> 'subagent' AND kind = 'user_text' AND parent_tool_use_id IS NULL
       ORDER BY seq ASC LIMIT 1`
    )
    const next = this.selectNextOwnQuestion.get(threadId, row.seq) as { seq: number } | undefined
    return { before: next?.seq, oldestSeq }
  }

  /** For restore. Kinds that are not saved are not in it from the start. */
  readTimeline(threadId: string, limit = TIMELINE_LIMIT, before?: number): readonly AiosEvent[] {
    return this.readTimelinePage(threadId, limit, before).events
  }

  /**
   * One page of the timeline (item 88). Returns rows before `before` (`seq < before`, from the end if omitted) as at most `limit`
   * rows from the newer side, in oldest-first order. `oldestSeq` is the `seq` of the oldest row returned
   * (the next page's `before`), and `remaining` is the number of rows left before it.
   * It is a range read of `thread_events_thread (thread_id, seq)`, so the count can be obtained from the index alone.
   */
  readTimelinePage(
    threadId: string,
    limit = TIMELINE_LIMIT,
    before?: number
  ): { readonly events: readonly AiosEvent[]; readonly oldestSeq: number | null; readonly remaining: number } {
    let rows: (EventRow & { seq: number })[]
    if (before === undefined) {
      rows = this.selectEvents.all(threadId, limit) as (EventRow & { seq: number })[]
    } else {
      this.selectEventsPage ??= this.db.prepare(`
        SELECT * FROM (
          SELECT * FROM thread_events WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?
        ) ORDER BY seq ASC
      `)
      rows = this.selectEventsPage.all(threadId, before, limit) as (EventRow & { seq: number })[]
    }
    const out: AiosEvent[] = []
    for (const row of rows) {
      let payload: unknown
      try {
        payload = JSON.parse(row.payload)
      } catch {
        continue
      }
      const base = {
        id: row.id,
        sessionId: row.session_id ?? '',
        threadId: row.thread_id,
        ts: row.ts,
        actor: row.actor === 'subagent' ? ('subagent' as const) : ('main' as const),
        ...(row.parent_tool_use_id === null
          ? {}
          : { parentToolUseId: row.parent_tool_use_id })
      }
      out.push({ ...base, kind: row.kind, payload } as AiosEvent)
    }
    // Broken rows (unreadable payload) are also counted in computing the position, so that paging does not stop at a skipped row.
    const oldestSeq = rows.length === 0 ? null : rows[0]!.seq
    let remaining = 0
    if (oldestSeq !== null) {
      this.countEventsBefore ??= this.db.prepare(
        `SELECT COUNT(*) AS n FROM thread_events WHERE thread_id = ? AND seq < ?`
      )
      remaining = (this.countEventsBefore.get(threadId, oldestSeq) as { n: number }).n
    }
    return { events: out, oldestSeq, remaining }
  }

  /**
   * Copies the identifier of a message that arrived by echo into the saved `user_text` row (item 113). If not yet saved
   * (still in the Batcher) there is no row and it returns false - the caller also fixes the event waiting to be saved.
   */
  setEventMessageId(threadId: string, eventId: string, messageId: string): boolean {
    return this.patchMessageId.run(messageId, eventId, threadId).changes > 0
  }

  /**
   * Material for "rewind to here" (item 113, 4.5.6). null if `eventId` is not a user message (`user_text`).
   * The previous reply's identifier comes from the last row of the parent's own `assistant_text` / `tool_use` before that message
   * (a turn can end with a tool call). If a row exists but has no identifier (a row from before item 113),
   * `priorMessageId` is null and `hasPrior` is true - the caller refuses to branch there (it does not silently
   * shift to an older point).
   */
  rewindPoint(threadId: string, eventId: string): RewindPoint | null {
    const row = this.selectEventRow.get(eventId, threadId) as
      | { seq: number; kind: string; payload: string }
      | undefined
    if (row === undefined || row.kind !== 'user_text') return null
    const messageIdOf = (payload: string): string | null => {
      try {
        const parsed: unknown = JSON.parse(payload)
        const value = (parsed as { messageId?: unknown } | null)?.messageId
        return typeof value === 'string' && value !== '' ? value : null
      } catch {
        return null
      }
    }
    const found = this.selectPriorResponse.get(threadId, row.seq) as
      | { kind: string; seq: number; ts: number; payload: string }
      | undefined
    // If the reset is later, the previous reply already belongs to the previous conversation (TODO 1121).
    const prior = found === undefined || found.kind === 'conversation_reset' ? undefined : found
    return {
      userMessageId: messageIdOf(row.payload),
      priorMessageId: prior === undefined ? null : messageIdOf(prior.payload),
      hasPrior: prior !== undefined,
      resetAfter: this.selectResetAfter.get(threadId, row.seq) !== undefined,
      priorTs: prior === undefined ? null : prior.ts,
      priorSeq: prior === undefined ? null : prior.seq
    }
  }

  // Fix from the review of TODO 1121: the statement is not added to the order in the constructor but prepared lazily here.
  private selectSessionStartBefore?: Statement
  private selectSessionStartAfter?: Statement
  private selectResetBetween?: Statement
  private selectOwnedSession?: Statement

  /**
   * TODO 1121: the backend session that produced the previous reply (the row of `priorSeq`). null if it cannot be looked up (the caller refuses).
   *
   * **Looked up by record order (`seq`), not by time** (review fix). Comparing `sessions.started_at` with a row's `ts` found nothing
   * when the row's `ts` is older than the session row, as for a conversation continued or loaded from a transcript, and it was refused with `rewind-no-branch-point`.
   * 1. The id of the last `session_started` (parent) before that reply.
   * 2. If there is none before (the reply was recorded before any session started), the id of the first `session_started` after -
   *    but only when there is no conversation reset (`/clear`) in between (a session after a reset does not have that reply).
   * 3. Only when the `session_started` rows give no clue (removed by the retention period), the time (`backendSessionAt`).
   *
   * If the id found by 1 / 2 is not in this thread's `sessions` rows (removed, or loaded from another PC), null - it does not shift to
   * another session (an old identifier is not handed to the latest session).
   */
  backendSessionOfResponse(threadId: string, priorSeq: number, priorTs: number): string | null {
    this.selectSessionStartBefore ??= this.db.prepare(
      `SELECT seq, payload FROM thread_events
       WHERE thread_id = ? AND seq < ? AND actor = 'main' AND kind = 'session_started'
       ORDER BY seq DESC LIMIT 1`
    )
    this.selectSessionStartAfter ??= this.db.prepare(
      `SELECT seq, payload FROM thread_events
       WHERE thread_id = ? AND seq > ? AND actor = 'main' AND kind = 'session_started'
       ORDER BY seq ASC LIMIT 1`
    )
    this.selectResetBetween ??= this.db.prepare(
      `SELECT 1 FROM thread_events
       WHERE thread_id = ? AND seq > ? AND seq < ? AND actor = 'main' AND kind = 'conversation_reset' LIMIT 1`
    )
    this.selectOwnedSession ??= this.db.prepare(
      `SELECT 1 FROM sessions WHERE thread_id = ? AND backend_session_id = ?`
    )
    const backendIdOf = (payload: string): string | null => {
      try {
        const value = (JSON.parse(payload) as { backendSessionId?: unknown } | null)?.backendSessionId
        return typeof value === 'string' && value !== '' ? value : null
      } catch {
        return null
      }
    }
    const owned = (id: string | null): string | null =>
      id !== null && this.selectOwnedSession!.get(threadId, id) !== undefined ? id : null
    const before = this.selectSessionStartBefore.get(threadId, priorSeq) as { seq: number; payload: string } | undefined
    if (before !== undefined) return owned(backendIdOf(before.payload))
    const after = this.selectSessionStartAfter.get(threadId, priorSeq) as { seq: number; payload: string } | undefined
    if (after !== undefined) {
      if (this.selectResetBetween.get(threadId, priorSeq, after.seq) !== undefined) return null
      return owned(backendIdOf(after.payload))
    }
    return this.backendSessionAt(threadId, priorTs)
  }

  /** TODO 1121: the backend session in use at time `ts` (the last row started by that time). null if none. */
  backendSessionAt(threadId: string, ts: number): string | null {
    const row = this.selectSessionAt.get(threadId, ts) as { backend_session_id: string } | undefined
    return row?.backend_session_id ?? null
  }

  clearTimeline(threadId: string): void {
    this.db.transaction(() => {
      this.deleteEvents.run(threadId)
      this.updatePreview.run(null, threadId)
    })()
  }

  clearAllTimelines(): void {
    this.db.transaction(() => {
      this.deleteAllEvents.run()
      this.clearAllPreviews.run()
    })()
  }

  /**
   * Drops old rows of threads with retention='days'. Run once at launch.
   *
   * `onPruned` (TODO 860) is called for **every** thread that has retention, to say "this thread's canonical copy
   * has no rows older than `before` any more" (none at all if `before` is null). The caller
   * passes that to the index so that it drops the conversation's document. Threads from which no row was removed this time are reported too, so that
   * even if the notice for what was removed at the previous launch never reached the index, it is picked up again at the next launch.
   */
  applyRetention(
    now = Date.now(),
    onPruned?: (threadId: string, before: number | null) => void
  ): number {
    let removed = 0
    // Includes logically deleted threads (item 64). If `listThreads` were used, retention would stop applying
    // the moment a thread was deleted, and a row that should "disappear after N days" would stay forever.
    const threads = this.selectRetentionThreads.all() as {
      id: string
      retention: string
      retention_days: number | null
    }[]
    for (const thread of threads) {
      if (thread.retention === 'none') {
        const info = this.deleteEvents.run(thread.id)
        removed += info.changes
        if (info.changes > 0) this.updatePreview.run(null, thread.id)
        onPruned?.(thread.id, null)
        continue
      }
      if (thread.retention !== 'days' || thread.retention_days === null) continue
      const cutoff = now - thread.retention_days * 24 * 60 * 60 * 1000
      const info = this.purgeOld.run(thread.id, cutoff)
      removed += info.changes
      // If the last message was removed as well, make the preview follow (the migration 14 column is a copy of the canonical copy).
      if (info.changes > 0) this.updatePreview.run(this.previewOf(thread.id), thread.id)
      onPruned?.(thread.id, cutoff)
    }
    if (removed > 0) log.info('thread.retention.purged', { rows: removed })
    return removed
  }

  /**
   * The one-line preview recounted from the timeline. The sidebar reads `threads.preview`
   * (migration 14), so this is for re-fetching when rows disappear through retention, and for checking.
   */
  previewOf(threadId: string): string | null {
    const row = this.selectPreview.get(threadId) as { payload: string } | undefined
    if (row === undefined) return null
    try {
      const parsed = JSON.parse(row.payload) as { text?: unknown }
      return normalizePreview(typeof parsed.text === 'string' ? parsed.text : '')
    } catch {
      return null
    }
  }

  // ---- Index (6.1 / 6.5) ----

  /**
   * Returns the event body to put in the index. **The canonical copy is this table, and no duplicate is made on the index side**
   * (6.5). `tool_result` is out of scope since even in Phase 2 its contents are not saved (constraint 10).
   */
  eventText(eventId: string): { text: string; threadId: string; ts: number } | null {
    const row = this.selectEventText.get(eventId) as
      | { id: string; thread_id: string; ts: number; kind: string; payload: string }
      | undefined
    if (row === undefined) return null
    const text = indexableText(row.kind, row.payload)
    if (text === null) return null
    return { text, threadId: row.thread_id, ts: row.ts }
  }

  // ---- Checking for leftovers in the conversation index (TODO 863) ----
  // Prepared lazily (the same form as item 191).

  private liveEventIdsStatement: Statement | null = null
  private liveThreadIdsStatement: Statement | null = null
  private threadCwdsStatement: Statement | null = null

  /**
   * Of `eventIds`, the ids of messages still present in the canonical copy (the row exists and the thread is not logically deleted). The order is kept as input.
   * In-thread search (the index process) checks hits without reading the body (the same "present" criterion as `eventText`).
   * Primary-key lookups, `LIVE_EVENT_IDS_PAGE` at a time (the statement length is fixed so the prepare is reused).
   */
  liveEventIds(eventIds: readonly string[]): readonly string[] {
    if (eventIds.length === 0) return []
    const page = LIVE_EVENT_IDS_PAGE
    this.liveEventIdsStatement ??= this.db.prepare(
      `SELECT e.id FROM thread_events e JOIN threads t ON t.id = e.thread_id
       WHERE t.deleted_at IS NULL AND e.id IN (${Array.from({ length: page }, () => '?').join(',')})`
    )
    const statement = this.liveEventIdsStatement
    const found = new Set<string>()
    for (let i = 0; i < eventIds.length; i += page) {
      const slice = eventIds.slice(i, i + page)
      // The shortfall is padded with empty strings (an id is never empty).
      const params = [...slice, ...Array.from({ length: page - slice.length }, () => '')]
      for (const id of statement.pluck().all(...params) as string[]) found.add(id)
    }
    return eventIds.filter((id) => found.has(id))
  }

  private threadLinkThreadStatement: Statement | null = null
  private threadLinkEventStatement: Statement | null = null

  /**
   * Where a `thread://<threadId>/<eventId>` link points (TODO 1155). Distinguishes: the thread does not exist, is logically deleted, or the message is
   * not in that thread. Unlike `getThread`, it also looks at deleted rows (for the path of restoring from the deleted list).
   */
  locateThreadLink(threadId: string, eventId: string | null): ThreadLinkLocation {
    this.threadLinkThreadStatement ??= this.db.prepare(`SELECT deleted_at FROM threads WHERE id = ?`)
    const thread = this.threadLinkThreadStatement.get(threadId) as { deleted_at: number | null } | undefined
    if (thread === undefined) return 'missing'
    if (thread.deleted_at !== null) return 'deleted'
    if (eventId === null) return 'live'
    this.threadLinkEventStatement ??= this.db.prepare(
      `SELECT 1 FROM thread_events WHERE id = ? AND thread_id = ?`
    )
    return this.threadLinkEventStatement.get(eventId, threadId) === undefined ? 'live-no-event' : 'live'
  }

  /** The set of ids of threads that are not logically deleted (TODO 863, compared by the cleanup of the conversation index at launch). */
  liveThreadIds(): ReadonlySet<string> {
    this.liveThreadIdsStatement ??= this.db.prepare(`SELECT id FROM threads WHERE deleted_at IS NULL`)
    return new Set(this.liveThreadIdsStatement.pluck().all() as string[])
  }

  /**
   * The ids of threads whose cwd is `cwdPath` itself or under it (TODO 1096, the "this working folder" section of conversation search).
   * Logically deleted threads are not included (they are also removed from the index).
   * The boundary is `isSameOrUnderPath` (`/a/bc` is not in `/a/b`; case and NFC are folded). It reads all rows and sorts them in JS
   * (the cwd column has no index. Cheaper than calling `aios_fold_path` per row).
   *
   * **The result is remembered per cwd** (review of TODO 1096): conversation search calls this on every keystroke, so this avoids a full scan
   * each time. The answer changes only when thread rows are added, removed, logically deleted, or restored (there is no
   * statement that rewrites `threads.cwd`), and all those entry points call `invalidateThreadCwds`.
   */
  threadIdsUnderCwd(cwdPath: string): readonly string[] {
    if (cwdPath === '') return []
    // The key is folded the same way as `isSameOrUnderPath` (case, NFC, trailing `/`).
    const key = foldPath(cwdPath).replace(/\/+$/, '') || '/'
    const cached = this.threadCwdMemo.get(key)
    if (cached !== undefined) return cached
    this.threadCwdsStatement ??= this.db.prepare(`SELECT id, cwd FROM threads WHERE deleted_at IS NULL`)
    const out: string[] = []
    for (const row of this.threadCwdsStatement.all() as { id: string; cwd: string }[]) {
      if (isSameOrUnderPath(row.cwd, cwdPath)) out.push(row.id)
    }
    // There can be as many cwds as windows and threads, so a limit is set (when exceeded, discard once and learn again).
    if (this.threadCwdMemo.size >= ThreadStore.THREAD_CWD_MEMO_MAX) this.threadCwdMemo.clear()
    this.threadCwdMemo.set(key, out)
    return out
  }

  private static readonly THREAD_CWD_MEMO_MAX = 32
  /** The memo of `threadIdsUnderCwd` (the key is the cwd after `foldPath` with the trailing `/` dropped). */
  private readonly threadCwdMemo = new Map<string, readonly string[]>()

  /** The set of threads (existence of rows, logical deletion) changed. Discards the memo of `threadIdsUnderCwd`. */
  private invalidateThreadCwds(): void {
    this.threadCwdMemo.clear()
  }

  /** The thread name used for the context display of a search result. */
  threadTitle(threadId: string): string | null {
    const row = this.selectThreadTitle.get(threadId) as
      | Pick<ThreadRow, 'title' | 'title_auto'>
      | undefined
    return row === undefined ? null : titleOf(row)
  }

  /**
   * The statements for `indexableEvents` / `eventRowidCeiling` (item 76). The launch-time import calls them many times
   * while paging, so they are built once at first and reused.
   */
  private indexableStatement: Statement | null = null
  private rowidCeilingStatement: Statement | null = null

  /**
   * The list of events to index (for the launch-time import, item 76). A thread with `retention = 'none'`
   * has not a single row saved in the first place, so it does not appear here either.
   *
   * **A keyset walk in `rowid` order of `thread_events`**. It returns only `limit` rows after `sinceRowid`, so the caller
   * reads on with the last row's `rowid` as the next `sinceRowid`, and keeps the same value as the high-water mark (`src/main/index/conversation-backfill.ts`).
   * It is `rowid` and not `ts` because timestamps can collide.
   */
  indexableEvents(options: { sinceRowid?: number; limit?: number } = {}): readonly {
    rowid: number
    id: string
    threadId: string
    ts: number
    label: string
  }[] {
    this.indexableStatement ??= this.db.prepare(
      // This is a list re-fed to the index on every launch, so **unless logically deleted threads are excluded,
      // a conversation that was supposed to be deleted comes back into search at the next launch** (item 64).
      `SELECT e.rowid AS rowid, e.id, e.thread_id, e.ts, e.kind FROM thread_events e
       JOIN threads t ON t.id = e.thread_id
       WHERE e.rowid > ? AND e.kind IN ('user_text','assistant_text','tool_use')
         AND t.deleted_at IS NULL
       ORDER BY e.rowid LIMIT ?`
    )
    const rows = this.indexableStatement.all(options.sinceRowid ?? 0, options.limit ?? 100000) as {
      rowid: number
      id: string
      thread_id: string
      ts: number
      kind: string
    }[]
    return rows.map((row) => ({
      rowid: row.rowid,
      id: row.id,
      threadId: row.thread_id,
      ts: row.ts,
      label: eventLabel(row.kind)
    }))
  }

  private indexableOfThreadStatement: Statement | null = null

  /**
   * The events to index for one thread (when a deleted thread is restored, review of 2026-10-01).
   * **A keyset walk on `seq`** - it walks `thread_events_thread (thread_id, seq)` as is, so no sorting is needed.
   * The caller uses the last row's `seq` as the next `sinceSeq`. Logically deleted threads are not returned.
   */
  indexableEventsOfThread(
    threadId: string,
    options: { sinceSeq?: number; limit?: number } = {}
  ): readonly { seq: number; id: string; threadId: string; ts: number; label: string }[] {
    this.indexableOfThreadStatement ??= this.db.prepare(
      `SELECT e.seq AS seq, e.id, e.thread_id, e.ts, e.kind FROM thread_events e
       JOIN threads t ON t.id = e.thread_id
       WHERE e.thread_id = ? AND e.seq > ? AND e.kind IN ('user_text','assistant_text','tool_use')
         AND t.deleted_at IS NULL
       ORDER BY e.seq LIMIT ?`
    )
    const rows = this.indexableOfThreadStatement.all(
      threadId,
      options.sinceSeq ?? 0,
      options.limit ?? 2000
    ) as { seq: number; id: string; thread_id: string; ts: number; kind: string }[]
    return rows.map((row) => ({
      seq: row.seq,
      id: row.id,
      threadId: row.thread_id,
      ts: row.ts,
      label: eventLabel(row.kind)
    }))
  }

  /**
   * The current maximum `rowid` of `thread_events` (0 if none). If the high-water mark is above this,
   * rows were removed and `rowid`s were reassigned (e.g. after deleting all conversation logs), so
   * the import starts over from the beginning (item 76).
   */
  eventRowidCeiling(): number {
    this.rowidCeilingStatement ??= this.db.prepare(
      `SELECT coalesce(max(rowid), 0) AS n FROM thread_events`
    )
    return (this.rowidCeilingStatement.get() as { n: number }).n
  }

  /** The display name of an event kind (shown on the first line of a search result). */
  labelOf(kind: string): string {
    return eventLabel(kind)
  }

  // ---- Settings ----

  /** The validation that returns broken values and out-of-range numbers to the default is gathered in `SESSION_SETTINGS.parse` (TODO 85). */
  readSettings(): SessionSettings {
    return this.settings.readTyped(SESSION_SETTINGS)
  }

  writeSettings(settings: SessionSettings): void {
    this.settings.writeTyped(SESSION_SETTINGS, settings)
  }

  /**
   * The time limit after which a background shell is counted as evicted (item 105). **There is no UI** -
   * it changes from the default (30 minutes) only when `app_settings` is rewritten directly.
   */
  backgroundShellEvictTimeoutMs(): number {
    return (
      this.settings.readTyped(BACKGROUND_SHELL_EVICT_TIMEOUT_MS) ??
      DEFAULT_BACKGROUND_SHELL_EVICT_TIMEOUT_MS
    )
  }

  /** The font of a Gmail draft's body (TODO 1229). Read every time a conversation is started. The writer is `GmailDraftFontPreference` (main's settings entry point). */
  gmailDraftFont(): GmailDraftFont {
    return this.settings.readTyped(GMAIL_DRAFT_FONT)
  }

  /** The number of bundle conversations that may run at once (TODO 633 stage 3). There is no UI. */
  bundleMax(): number {
    return this.settings.readTyped(BUNDLE_MAX)
  }

  /** TODO 1060 stage 3: changed by the AI settings tool. The range (1 to `BUNDLE_MAX_CAP`) is enforced by the caller (`SessionManager.setBundleMax`). */
  writeBundleMax(value: number): void {
    this.settings.writeTyped(BUNDLE_MAX, value)
  }

  /** The statement for TODO 816. Prepared lazily, like item 118. */
  private selectRecentToolUses: Statement | null = null

  /**
   * The names and arguments of the latest `limit` tool calls (TODO 816, the material for the Adapter to pick up the next candidate for a relative link in a reply = where the shell
   * did `cd`). Returned in **oldest-first** order. Includes subagent calls. Arguments were already redacted and
   * truncated at save time (`toPersistable`). Rows with broken JSON are skipped. It only walks `thread_events_thread` from the end, so it is
   * as light as one read when a link is clicked.
   */
  recentToolUses(threadId: string, limit = 2000): readonly { name: string; input: JsonValue }[] {
    this.selectRecentToolUses ??= this.db.prepare(
      `SELECT payload FROM thread_events
       WHERE thread_id = ? AND kind = 'tool_use'
       ORDER BY seq DESC LIMIT ?`
    )
    const rows = this.selectRecentToolUses.all(threadId, Math.max(1, Math.trunc(limit))) as { payload: string }[]
    const out: { name: string; input: JsonValue }[] = []
    for (let i = rows.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(rows[i]!.payload) as { name?: unknown; input?: unknown }
        if (typeof parsed.name !== 'string') continue
        out.push({ name: parsed.name, input: (parsed.input ?? null) as JsonValue })
      } catch {
        // Broken rows are skipped.
      }
    }
    return out
  }

  /** The statement for TODO 999 (review). Prepared lazily outside the constructor to avoid bundle collisions (the same form as item 88). */
  private selectRecentToolEvents: Statement | null = null

  /**
   * TODO 999 (review): of the `tool_use`s since `sinceMs`, only those whose paired `tool_result` succeeded (`ok`) (oldest first).
   * A refused or failed tool wrote nothing, so this keeps it out of the material for "files the AI wrote". Reads the latest `limit`
   * `tool_use`s and the `tool_result`s after them in one go, and matches them by id (no per-row subquery).
   */
  recentSucceededToolUses(threadId: string, sinceMs: number, limit = 500): readonly { name: string; input: JsonValue }[] {
    this.selectRecentToolEvents ??= this.db.prepare(
      `SELECT kind, payload FROM thread_events
       WHERE thread_id = ? AND ts >= ? AND kind IN ('tool_use', 'tool_result')
       ORDER BY seq DESC LIMIT ?`
    )
    // Result rows go into the same window, so read up to twice the tool_use count.
    const rows = this.selectRecentToolEvents.all(threadId, sinceMs, Math.max(1, Math.trunc(limit)) * 2) as {
      kind: string
      payload: string
    }[]
    const succeeded = new Set<string>()
    const uses: { id: string; name: string; input: JsonValue }[] = []
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as { toolUseId?: unknown; ok?: unknown; name?: unknown; input?: unknown }
        if (typeof parsed.toolUseId !== 'string') continue
        if (row.kind === 'tool_result') {
          if (parsed.ok === true) succeeded.add(parsed.toolUseId)
        } else if (typeof parsed.name === 'string' && uses.length < limit) {
          uses.push({ id: parsed.toolUseId, name: parsed.name, input: (parsed.input ?? null) as JsonValue })
        }
      } catch {
        // Broken rows are skipped.
      }
    }
    // Read newest first, so a result is seen before its paired tool_use.
    return uses
      .filter((use) => succeeded.has(use.id))
      .reverse()
      .map(({ name, input }) => ({ name, input }))
  }

  /** The statement for the restore in item 118. Prepared lazily outside the constructor to avoid bundle collisions (the same form as item 88). */
  private selectLatestTodos: Statement | null = null

  /**
   * The parent's latest work list (item 118 / 4.6.4). SessionManager reads it once per thread and keeps it
   * in memory. **null if there is none after a conversation reset (item 117)** (a reset starts the work list over too).
   * Compaction does not erase the work list (real behavior: the work list tool remains at the compaction boundary).
   * It walks from the end, so for a long thread that never used a work list it reads all rows (once, the first time).
   * Guarded by `json_valid` so that `json_type` does not throw on a row with broken JSON (the same as item 75).
   */
  latestTodos(threadId: string): TodoList | null {
    this.selectLatestTodos ??= this.db.prepare(
      `SELECT kind, payload, ts FROM thread_events
       WHERE thread_id = ? AND actor = 'main'
         AND (kind = 'conversation_reset'
              OR (kind = 'tool_use'
                  AND CASE WHEN json_valid(payload) THEN json_type(payload, '$.todos') END = 'array'))
       ORDER BY seq DESC LIMIT 1`
    )
    const row = this.selectLatestTodos.get(threadId) as
      | { kind: string; payload: string; ts: number }
      | undefined
    if (row === undefined || row.kind !== 'tool_use') return null
    try {
      const parsed = JSON.parse(row.payload) as { toolUseId?: unknown; todos?: unknown }
      if (!Array.isArray(parsed.todos)) return null
      const items: TodoItem[] = []
      for (const raw of parsed.todos) {
        if (typeof raw !== 'object' || raw === null) continue
        const item = raw as Record<string, unknown>
        const status = item['status']
        if (typeof item['content'] !== 'string') continue
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
        items.push({
          content: item['content'],
          activeForm: typeof item['activeForm'] === 'string' ? item['activeForm'] : null,
          status
        })
      }
      return {
        toolUseId: typeof parsed.toolUseId === 'string' ? parsed.toolUseId : '',
        items,
        at: row.ts
      }
    } catch {
      return null
    }
  }

  /**
   * The last saved `turn_usage` (item 60). For restoring "the current context usage" after a restart;
   * SessionManager reads it once per thread and keeps it in memory.
   * The same shape as `previewOf` (walking `thread_events_thread` from the end), so it does not grow with the number of rows.
   * null for a thread with `retention = 'none'` since nothing is saved.
   */
  latestTurnUsage(threadId: string): TurnUsagePayload | null {
    const row = this.selectLatestTurnUsage.get(threadId) as
      | { kind: string; payload: string }
      | undefined
    // If there is no reply yet after a break (`/clear` / compaction, item 117), the usage is unknown.
    if (row === undefined || row.kind !== 'turn_usage') return null
    try {
      const parsed = JSON.parse(row.payload) as Partial<TurnUsagePayload>
      const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      return {
        model: typeof parsed.model === 'string' ? parsed.model : null,
        inputTokens: n(parsed.inputTokens),
        outputTokens: n(parsed.outputTokens),
        cacheCreationTokens: n(parsed.cacheCreationTokens),
        cacheReadTokens: n(parsed.cacheReadTokens)
      }
    } catch {
      return null
    }
  }

  /**
   * The total input of the first saved parent `turn_usage` (input + cache_read + cache_creation, TODO 961). The first
   * API call of a conversation has only the system prompt, tool definitions, and the first message, so this is used to estimate
   * the new conversation's fixed cost (B) for "lighten and continue in a new conversation". null if nothing is saved (`retention = 'none'`, or no reply yet).
   */
  firstPromptTokens(threadId: string): number | null {
    const row = this.selectFirstTurnUsage.get(threadId) as { payload: string } | undefined
    if (row === undefined) return null
    try {
      const parsed = JSON.parse(row.payload) as Partial<TurnUsagePayload>
      const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
      const total = n(parsed.inputTokens) + n(parsed.cacheReadTokens) + n(parsed.cacheCreationTokens)
      return total > 0 ? total : null
    } catch {
      return null
    }
  }

  /**
   * Approval defaults (T12 / 4.2). The 3 keys of `app_settings`. Default if absent, default if broken
   * (an empty array is a valid setting meaning "stop on everything", so it is not turned back into the default) - validation is gathered in each key's
   * `parse` (TODO 85).
   */
  readApprovalPolicy(): ApprovalPolicy {
    return {
      // The default is "ask as little as possible" (T40). If the setting is missing or broken, fall back to the default.
      autoAllowAll: this.settings.readTyped(APPROVAL_AUTO_ALLOW_ALL),
      autoAllowTools: this.settings.readTyped(APPROVAL_AUTO_ALLOW_TOOLS),
      bashDenyPatterns: this.settings.readTyped(APPROVAL_BASH_DENY_PATTERNS),
      // TODO 1029: connection destinations that are not asked about. Empty if missing or broken.
      sshAllowedHosts: this.settings.readTyped(APPROVAL_SSH_ALLOWED_HOSTS),
      // TODO 1106: the OS sandbox's allow table. Default if missing or broken.
      sandboxAllowedDomains: this.settings.readTyped(SANDBOX_ALLOWED_DOMAINS),
      sandboxAllowWrite: this.settings.readTyped(SANDBOX_ALLOW_WRITE),
      // TODO 1175: full delegation mode. False if missing or broken.
      fullDelegation: this.settings.readTyped(APPROVAL_FULL_DELEGATION)
    }
  }

  writeApprovalPolicy(policy: ApprovalPolicy): void {
    this.settings.writeTyped(APPROVAL_AUTO_ALLOW_ALL, policy.autoAllowAll)
    this.settings.writeTyped(APPROVAL_AUTO_ALLOW_TOOLS, [...policy.autoAllowTools])
    this.settings.writeTyped(APPROVAL_BASH_DENY_PATTERNS, [...policy.bashDenyPatterns])
    // If omitted (a call in the old shape), the stored value is not touched.
    if (policy.sshAllowedHosts !== undefined) {
      this.settings.writeTyped(APPROVAL_SSH_ALLOWED_HOSTS, [...policy.sshAllowedHosts])
    }
    if (policy.sandboxAllowedDomains !== undefined) {
      this.settings.writeTyped(SANDBOX_ALLOWED_DOMAINS, [...policy.sandboxAllowedDomains])
    }
    if (policy.sandboxAllowWrite !== undefined) {
      this.settings.writeTyped(SANDBOX_ALLOW_WRITE, [...policy.sandboxAllowWrite])
    }
    if (policy.fullDelegation !== undefined) {
      this.settings.writeTyped(APPROVAL_FULL_DELEGATION, policy.fullDelegation)
    }
  }

  // ---- Approval rules (T22 / 4.2.1, migration 10) ----

  /**
   * Reads the rules made with "always allow" (the implementation of `ApprovalRuleStore`).
   *
   * **They live in `approval.rules` of `app_settings`** (T40). T22 to T26 used
   * `threads.approval_rules` (the thread row), but the rules became app-wide, so
   * they do not belong to a thread. **The contents of the old column are not read** - it would spread a permission given per thread
   * to all threads, so it is discarded without migrating (pressing again takes just once).
   * Validating the shape (dropping broken elements) is gathered in `APPROVAL_RULES.parse` (TODO 85).
   */
  loadApprovalRules(): readonly ApprovalRule[] {
    return this.settings.readTyped(APPROVAL_RULES)
  }

  /** Replaces the rules wholesale (an empty array clears everything). */
  saveApprovalRules(rules: readonly ApprovalRule[]): void {
    this.settings.writeTyped(
      APPROVAL_RULES,
      rules.map((rule) => ({
        id: rule.id,
        toolName: rule.toolName,
        command: rule.command,
        ...(rule.commandHash === undefined || rule.commandHash === null ? {} : { commandHash: rule.commandHash }),
        createdAt: rule.createdAt
      }))
    )
  }

  /** The cache of the feature table (so the probe is not run every time). Keyed by version. */
  readFeatureCache(version: string): string | null {
    return this.settings.readTyped(featureCacheKey(version))
  }

  writeFeatureCache(version: string, json: string): void {
    this.settings.writeTyped(featureCacheKey(version), json)
  }

  /**
   * The model information the backend reported (item 91). The contents are JSON only the Adapter knows,
   * and this just lends the storage place (no reinterpretation or validation).
   */
  readBackendModels(backendId: string): string | null {
    return this.settings.readTyped(backendModelsKey(backendId))
  }

  // ---- Export / import (TODO 1088, ARCHITECTURE 8.6) ----

  private selectExportThreadsStatement: Statement | null = null
  private selectExportEventsStatement: Statement | null = null
  private insertImportedThreadStatement: Statement | null = null

  /**
   * The thread rows to export (TODO 1088). Only live rows, and `retention = 'none'` (promised not to be saved) is not included.
   * Oldest first (the import side also creates in oldest-first order, to keep the order of equal times).
   */
  exportThreadRows(): readonly ExportThreadRow[] {
    this.selectExportThreadsStatement ??= this.db.prepare(
      `SELECT id, title, title_auto, cwd, allowed_dirs, retention, retention_days, setting_sources, backend,
              model_id, thinking, approval_strict, os_sandbox, created_at, last_event_at, turns
       FROM threads WHERE deleted_at IS NULL AND retention <> 'none'
       ORDER BY created_at ASC, rowid ASC`
    )
    const rows = this.selectExportThreadsStatement.all() as (Omit<ExportThreadRow, 'allowedDirs' | 'settingSources' | 'thinking'> & {
      allowed_dirs: string
      setting_sources: string
      thinking: string | null
    })[]
    // TODO 982: a drill conversation is not exported (an imported copy would be an ordinary conversation, without the drill's stop).
    return rows.filter((row) => this.drillStateOf(row.id) === null).map((row) => ({
      ...row,
      allowedDirs: parseStringArray(row.allowed_dirs),
      settingSources: parseStringArray(row.setting_sources).filter(isSettingSource),
      thinking: isThinkingLevel(row.thinking) ? row.thinking : null
    }))
  }

  /**
   * One page of the timeline to export (TODO 1088). **As it is in the DB** (= after `toPersistable`), returned
   * oldest first with the keyset `seq > afterSeq`. A range read of `thread_events_thread (thread_id, seq)`.
   * Rows with an unreadable payload are skipped (the same as `readTimelinePage`). `scanned` is the number of rows read (including skipped ones), and
   * if fewer than `limit`, it is the last page (the caller stops there and does not read one more empty page).
   */
  exportEventsPage(
    threadId: string,
    afterSeq: number,
    limit: number
  ): { readonly events: readonly ExportEventRow[]; readonly lastSeq: number | null; readonly scanned: number } {
    this.selectExportEventsStatement ??= this.db.prepare(
      `SELECT seq, ts, kind, actor, parent_tool_use_id, payload FROM thread_events
       WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
    )
    const rows = this.selectExportEventsStatement.all(threadId, afterSeq, limit) as {
      seq: number
      ts: number
      kind: string
      actor: string
      parent_tool_use_id: string | null
      payload: string
    }[]
    const events: ExportEventRow[] = []
    for (const row of rows) {
      let payload: JsonValue
      try {
        payload = JSON.parse(row.payload) as JsonValue
      } catch {
        continue
      }
      events.push({
        kind: row.kind,
        actor: row.actor === 'subagent' ? 'subagent' : 'main',
        ts: row.ts,
        ...(row.parent_tool_use_id === null ? {} : { parentToolUseId: row.parent_tool_use_id }),
        payload,
        payloadJson: row.payload
      })
    }
    return { events, lastSeq: rows.length === 0 ? null : rows[rows.length - 1]!.seq, scanned: rows.length }
  }

  /**
   * Adds one chunk of an imported thread's events (TODO 1088, owner decision 2026-11-02: as a new thread, without breaking existing ones).
   * The first chunk (with `thread`) creates the thread row, and later chunks add to the same id. One chunk = one transaction, and
   * the caller (`DataTransfer`) yields to the event loop between chunks (so main is not held for long even if one thread is large).
   * If it fails midway, the caller removes the partial thread with `removeImportedThread`.
   *
   * Event ids are also assigned anew (`thread_events.id` is unique across the table, so even if the same file is imported twice it does not overwrite the earlier
   * import). Events are **passed through `toPersistable` again here** - a payload that comes from outside is not trusted as the DB shape
   * (redaction, enumerating fields, dropping the body of `tool_result`). Rows that cannot be passed (throw), kinds that are not saved, and rows whose
   * payload after passing exceeds `maxPayloadChars` are dropped and counted (the length is measured on the string to be saved itself).
   * No `sessions` row is created (the conversation id of another PC's backend is not carried over). The first send starts as a new conversation.
   */
  importThreadChunk(chunk: ImportThreadChunk): { readonly written: number; readonly skipped: number; readonly nextSeq: number } {
    this.insertImportedThreadStatement ??= this.db.prepare(`
      INSERT INTO threads (id, title, title_auto, cwd, allowed_dirs, retention, retention_days,
                           unread, setting_sources, backend, model_id, thinking, approval_strict, os_sandbox,
                           created_at, updated_at, last_event_at, turns)
      VALUES (@id, @title, @title_auto, @cwd, @allowed_dirs, @retention, @retention_days,
              0, @setting_sources, @backend, @model_id, @thinking, @approval_strict, @os_sandbox,
              @created_at, @now, @last_event_at, @turns)
    `)
    const id = chunk.threadId
    const rows: {
      id: string
      thread_id: string
      session_id: null
      seq: number
      ts: number
      kind: string
      actor: string
      parent_tool_use_id: string | null
      payload: string
      payload_bytes: number
    }[] = []
    let skipped = 0
    let preview: string | null = null
    let seq = chunk.seqStart
    for (const source of chunk.events) {
      const event = {
        id: chunk.newId(),
        sessionId: '',
        threadId: id,
        ts: source.ts,
        actor: source.actor,
        ...(source.parentToolUseId === undefined ? {} : { parentToolUseId: source.parentToolUseId }),
        kind: source.kind,
        payload: source.payload
      } as unknown as AiosEvent
      let persistable: { kind: string; payload: JsonValue } | null
      try {
        persistable = this.toPersistable(event)
      } catch {
        persistable = null
      }
      if (persistable === null) {
        skipped += 1
        continue
      }
      // The stringify that measures the length and the string to be saved are the same single one.
      const payload = JSON.stringify(persistable.payload)
      if (payload.length > chunk.maxPayloadChars) {
        skipped += 1
        continue
      }
      if (event.actor === 'main' && (persistable.kind === 'user_text' || persistable.kind === 'assistant_text')) {
        const text = (persistable.payload as { text?: unknown }).text
        preview = normalizePreview(typeof text === 'string' ? text : null)
      }
      rows.push({
        id: event.id,
        thread_id: id,
        session_id: null,
        seq,
        ts: event.ts,
        kind: persistable.kind,
        actor: event.actor,
        parent_tool_use_id: event.parentToolUseId ?? null,
        payload,
        payload_bytes: Buffer.byteLength(payload, 'utf8')
      })
      seq += 1
    }
    const thread = chunk.thread
    this.db.transaction(() => {
      if (thread !== null) {
        this.insertImportedThreadStatement!.run({
          id,
          title: thread.title,
          title_auto: thread.titleAuto ? 1 : 0,
          cwd: thread.cwd,
          allowed_dirs: JSON.stringify([...thread.allowedDirs]),
          retention: thread.retention,
          retention_days: thread.retention === 'days' ? thread.retentionDays : null,
          setting_sources: JSON.stringify([...thread.settingSources]),
          backend: thread.backend,
          model_id: thread.modelId,
          thinking: thread.thinking,
          approval_strict: thread.approvalStrict ? 1 : 0,
          os_sandbox: thread.osSandbox ? 1 : 0,
          created_at: thread.createdAt,
          now: Date.now(),
          last_event_at: thread.lastEventAt,
          turns: thread.turns
        })
      }
      for (const row of rows) this.insertEvent.run(row)
      if (preview !== null) this.updatePreview.run(preview, id)
    })()
    if (thread !== null) this.invalidateThreadCwds()
    return { written: rows.length, skipped, nextSeq: seq }
  }

  /** Deletes a thread that failed midway through an import (TODO 1088), row and all (not logical deletion; so that a partial import is not left). */
  removeImportedThread(threadId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM thread_events WHERE thread_id = ?`).run(threadId)
      this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(threadId)
    })()
    this.invalidateThreadCwds()
  }

  writeBackendModels(backendId: string, json: string): void {
    this.settings.writeTyped(backendModelsKey(backendId), json)
  }
}

/**
 * Extracts from a saved payload the body to put in the index.
 * Kinds not listed here do not go into the index (what does not exist cannot leak - 8.1).
 */
export function indexableText(kind: string, payload: string): string | null {
  let parsed: { text?: unknown; summary?: unknown; name?: unknown }
  try {
    parsed = JSON.parse(payload) as typeof parsed
  } catch {
    return null
  }
  if (kind === 'user_text' || kind === 'assistant_text') {
    return typeof parsed.text === 'string' && parsed.text.trim() !== '' ? parsed.text : null
  }
  if (kind === 'tool_use') {
    const name = typeof parsed.name === 'string' ? parsed.name : ''
    const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
    const text = `${name} ${summary}`.trim()
    return text === '' ? null : text
  }
  return null
}

/**
 * The role label of a conversation-search hit. **main does not know the language** (TODO 66), so it returns a code
 * (`SearchRoleCode` in `@shared/search.js`) rather than Japanese text. The renderer's dictionary
 * (`search.role.*`) turns it into text. This value is also used as is as the index document name (`documents.name`)
 * (`SessionManager.indexEvents`), and reaches the renderer as the search hit's `title` / `context`
 * (`src/index-kernel/service.ts`).
 */
function eventLabel(kind: string): string {
  if (kind === 'user_text') return 'user'
  if (kind === 'assistant_text') return 'assistant'
  if (kind === 'tool_use') return 'tool'
  return kind
}

/** Treats a typed payload as a JsonValue. The structure is unchanged. */
function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Turns the record of an automatically chosen event (TODO 1230) into the saved form. */
function persistableAutoPick(record: AutoPickRecord): AutoPickRecord {
  const options = record.options.slice(0, MAX_ARG_ITEMS).map((label) => redactText(label.slice(0, MAX_ARG_CHARS)).text)
  const clamp = (n: number): number => Math.min(Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0)), Math.max(0, options.length - 1))
  return {
    question: redactText(record.question.slice(0, MAX_ARG_CHARS)).text,
    options,
    recommended: clamp(record.recommended),
    chosen: clamp(record.chosen),
    waitedMs: Math.max(0, Math.trunc(Number.isFinite(record.waitedMs) ? record.waitedMs : 0))
  }
}

/**
 * The outcome of an approval (TODO 749). Fields are enumerated per kind and copied, and `redactText` is applied to the free text
 * the user typed (`denied.message` = a rejection instruction, `allowed.answer` = the answer to a multiple-choice question).
 * Before, when it passed through as is, the comment in `gateway-requests.ts` was
 * wrong ("ThreadStore.toPersistable applies it to the whole payload") - this is
 * the only place that actually does. The `message` of a reason code (`approval-*`) is text that does not hit
 * redaction, so it is kept as is.
 */
function persistableApprovalOutcome(outcome: ApprovalOutcome): ApprovalOutcome {
  switch (outcome.kind) {
    case 'pending':
      return outcome
    case 'allowed':
      return {
        kind: 'allowed',
        by: outcome.by,
        ...(outcome.answer === undefined ? {} : { answer: redactText(outcome.answer).text }),
        ...(outcome.autoPicked === true ? { autoPicked: true as const } : {}),
        // TODO 1230: the record of an automatically chosen event. Strings (the question and option labels) pass through redaction, and the length and count are cut. Positions are clamped to range.
        ...(outcome.autoPick === undefined ? {} : { autoPick: persistableAutoPick(outcome.autoPick) })
      }
    case 'denied':
      return {
        kind: 'denied',
        by: outcome.by,
        message: redactText(outcome.message).text,
        ...(outcome.reply === undefined ? {} : { reply: outcome.reply })
      }
    default:
      return outcome
  }
}

/**
 * D-8 (review 2026-09-21): recursively drops, from the raw JSON of an `unknown` event, the fields that could
 * carry body text. Closes the loophole in constraint 10 for the case where a future CLI streams tool output as a new kind of this type
 * (not used outside `toPersistable` - the 4.6 "do not discard" still applies to
 * the display during the live process (`AiosEvent.payload.raw` made by `parse.ts`)).
 */
const UNKNOWN_BODY_KEYS = new Set([
  'content',
  'result',
  'text',
  'stdout',
  'stderr',
  'output',
  'prompt'
])

/** The limit after recursive dropping is done. Insurance, since large arrays and the like can still remain after dropping. */
const UNKNOWN_SCRUBBED_LIMIT = 8192

/** The number of ids per statement of `liveEventIds` (TODO 863). Well below SQLite's variable limit. */
const LIVE_EVENT_IDS_PAGE = 200

function scrubUnknownJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(scrubUnknownJson)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const [key, v] of Object.entries(value)) {
      if (UNKNOWN_BODY_KEYS.has(key)) continue
      out[key] = scrubUnknownJson(v)
    }
    return out
  }
  if (typeof value === 'string') return redactText(value).text
  return value
}

/**
 * Builds a JSON string from `raw` (a raw one-line JSON; a long line is already truncated with `…` at the end) with the fields that could carry
 * body text dropped. If it cannot be read as JSON (broken by truncation, etc.), fall to the safe side and return `null` -
 * the caller discards it without keeping any body.
 */
function scrubUnknownRaw(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const json = JSON.stringify(scrubUnknownJson(parsed as JsonValue))
  return json.length > UNKNOWN_SCRUBBED_LIMIT
    ? `${json.slice(0, UNKNOWN_SCRUBBED_LIMIT)}…`
    : json
}
