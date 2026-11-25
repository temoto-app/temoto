/**
 * The list of keys of `app_settings` (migration 2) (TODO 85, whole-codebase review 2026-09-23).
 *
 * Previously the key strings and value shapes were scattered over more than ten places: `src/index-kernel/indexer.ts` / `volumes.ts` /
 * `src/main/session/store.ts` / `windows.ts` / `locale.ts` / `theme.ts` /
 * `index/conversation-backfill.ts`. JSON validation also differed from module to module, and mix-ups such as
 * "the index process writes a key that main reads" were caught neither by lint nor by types (the background is that with P1
 * two processes and two connections share `app_settings`, and it relies on `busy_timeout`).
 *
 * Here **the key string literals are gathered in this one file**. `owner` is
 * which process **writes** the key (`'main'` | `'index'`). Either side may read it
 * (e.g. the index process writes `scan.*`, but main's status bar reads it).
 * `owner` is enforced by `npm run lint:settings-owner` (a grep check in the same spirit as this file,
 * `scripts/lint-settings-owner.mjs`): code on the index process side cannot call `writeTyped` / `removeTyped` on a key with
 * `owner: 'main'`, and vice versa.
 *
 * **Key names and value shapes are unchanged** (no migration needed). Values in existing DBs can be read as they are.
 *
 * There are two keys that could not be moved entirely into "the table's parse"
 * (`WindowBounds` of `window.bounds` / `AllowedVolume` of `fs.allowedVolumes`):
 * their types originally lived in `src/main/windows.ts` / `src/index-kernel/volumes.ts`, and
 * `src/common/` is a base that neither side imports from (P1, enforced by `lint:index`), so they were moved
 * **in the opposite direction** (main and index-kernel now import common).
 * Where a type can be moved safely it is gathered here, and only where moving it would create a circular import
 * is domain validation left with the caller (see each key's comment).
 */
import type { ApprovalRule, SessionSettings } from '@shared/thread.js'
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_AUTO_ALLOW_TOOLS,
  DEFAULT_BASH_DENY_PATTERNS,
  LEGACY_BASH_DENY_PATTERNS,
  RAINBOW_COLORS
} from '@shared/thread.js'
import { isMcpServerState, isThinkingLevel } from '@shared/agent.js'
import type { McpGlobalReport, McpGlobalServer } from '@shared/agent.js'
import {
  DEFAULT_LOCALE_PREFERENCE,
  isLocalePreference,
  type LocalePreference
} from '@shared/locale.js'
import { DEFAULT_THEME_PREFERENCE, isThemePreference, type ThemePreference } from '@shared/theme.js'
import { DEFAULT_EDITOR_ID, isEditorId, type EditorId } from '@shared/editor.js'
import { parseUsageSnapshot, type UsageSnapshot } from '@shared/usage.js'
import { normalizeRedmineBase } from '@shared/redmine-link.js'
import { sanitizeSshHosts } from '@shared/ssh-hosts.js'
import {
  DEFAULT_SANDBOX_ALLOWED_DOMAINS,
  DEFAULT_SANDBOX_ALLOW_WRITE,
  sanitizeSandboxDomains,
  sanitizeSandboxWritePaths
} from '@shared/os-sandbox.js'
import { sanitizeSlackTeams, type SlackTeamMap } from '@shared/slack-link.js'
import { sanitizeTrustedCertificates, type TrustedCertificate } from '@shared/web-certs.js'
import {
  DEFAULT_AUTO_SAVE_DELAY_MS,
  DEFAULT_AUTO_SAVE_MODE,
  clampAutoSaveDelay,
  isAutoSaveMode,
  type AutoSaveMode
} from '@shared/auto-save.js'
import {
  parseStoredWebTabSets,
  sanitizeWebSections,
  type StoredWebTabSet,
  type WebSectionsLayout
} from '@shared/web-tabs.js'
import {
  DEFAULT_VOICE_LOCALE_PREFERENCE,
  isVoiceLocalePreference,
  type VoiceLocalePreference
} from '@shared/voice-locale.js'
import { DEFAULT_COLLAPSE_OLD_AFTER_DAYS, clampCollapseOldAfterDays } from '@shared/thread-collapse.js'
import { sanitizeHistory, type SearchHistoryEntry } from '@shared/search-history.js'
import { DEFAULT_GMAIL_DRAFT_FONT, isGmailDraftFont, type GmailDraftFont } from '@shared/gmail-draft-font.js'
import { DEFAULT_FILE_SORT_ORDER, isFileSortOrder, type FileSortOrder } from '@shared/file-sort.js'
import type { AgentUpdateRecord } from '@shared/agent-update.js'
import { isAssociationExt, PLUGIN_ID_RE } from '@shared/plugin.js'
import { PLAIN_VERSION_RE } from '@shared/update.js'
import { BACKUP_FAILURES, type BackupFailure } from '@shared/backup.js'

export type SettingOwner = 'main' | 'index'

/** The round trip of one key with its string (`app_settings.value`). */
export interface SettingKey<T> {
  readonly key: string
  readonly owner: SettingOwner
  /** From the stored string (null if absent) to a value. A broken one falls back to the default. */
  readonly parse: (raw: string | null) => T
  /** From a value to the string to store. */
  readonly serialize: (value: T) => string
}

function defineKey<T>(
  key: string,
  owner: SettingOwner,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string
): SettingKey<T> {
  return { key, owner, parse, serialize }
}

/** Reads as JSON. If broken, `undefined` (the caller falls back to the default). */
function parseJsonRaw(raw: string | null): unknown {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function parseIntegerRaw(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

/** A key that stores one integer as a plain string (the same shape as `readInteger` / `write(String(n))`). */
function integerKey(key: string, owner: SettingOwner): SettingKey<number | null> {
  return defineKey(key, owner, parseIntegerRaw, (v) => String(v))
}

function stringArrayOr(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback
  return value.filter((v): v is string => typeof v === 'string')
}

// ---------------------------------------------------------------------------
// Keys written by the index process (owner: 'index')
// ---------------------------------------------------------------------------

/**
 * The record of the last full scan that completed (T3/T9 6.2.1/6.2.2). `rulesVersion` is a separate key
 * (`SCAN_RULES_VERSION`) - this keeps as is the history that it was added after T4.
 */
export interface StoredLastFullScan {
  readonly finishedAt: number
  readonly home: string
  readonly roots: readonly string[]
}

export const SCAN_LAST_FULL = defineKey<StoredLastFullScan | null>(
  'scan.lastFull',
  'index',
  (raw) => {
    const parsed = parseJsonRaw(raw) as Partial<StoredLastFullScan> | null | undefined
    if (
      parsed === undefined ||
      parsed === null ||
      typeof parsed.finishedAt !== 'number' ||
      typeof parsed.home !== 'string' ||
      !Array.isArray(parsed.roots) ||
      !parsed.roots.every((root) => typeof root === 'string')
    ) {
      return null
    }
    return { finishedAt: parsed.finishedAt, home: parsed.home, roots: parsed.roots }
  },
  (v) => JSON.stringify(v)
)

export const SCAN_RULES_VERSION = integerKey('scan.rulesVersion', 'index')
export const SCAN_INTERVAL_MS = integerKey('scan.intervalMs', 'index')
export const SCAN_OUTSIDE_HOME_INTERVAL_MS = integerKey('scan.outsideHomeIntervalMs', 'index')
export const SCAN_LAST_DEEP = integerKey('scan.lastDeep', 'index')
export const SCAN_DEEP_INTERVAL_MS = integerKey('scan.deepIntervalMs', 'index')
/** 0 stops pruning. null (unset) means "prune". */
export const SCAN_PRUNE = integerKey('scan.prune', 'index')

/**
 * TODO 805: the deadline (ms) until which scan and watch of the protected folders (`TCC_DEFERRED_DIRS` = Desktop / Documents / Downloads) are delayed.
 * - absent: not decided yet. The index process's first `start()` decides and writes it - if the DB has a record of scans (a record of a completed one or
 *   a row in `scan_runs`) this is someone already using the app, so `0`; otherwise a new user, so "now + 3 days".
 * - `0`: do not delay (an existing user, or the delay is over and the protected folders have been walked).
 * - a future time: deferral in progress.
 * - a past time: the delay is over but the scan including the protected folders has not finished yet (set back to `0` once it is done).
 *   For "include now", and when the user opens a protected folder or adds it to the reference scope, "now" is written (moved earlier).
 */
export const FS_TCC_DEFER_UNTIL = integerKey('fs.tccDeferUntil', 'index')

/**
 * TODO 833: the watch mark (the contents of a `@parcel/watcher` snapshot = the FSEvents event id and time, `"<id>\n<ns>"`).
 * The next launch replays changes after this mark from the FSEvents history (to pick up what was created while aios was stopped and between launch and
 * the start of watching). null if broken (no replay).
 */
export const FS_WATCH_MARK = defineKey<string | null>(
  'fs.watchMark',
  'index',
  (raw) => (raw !== null && /^\d+\n\d+$/.test(raw) ? raw : null),
  (v) => v ?? ''
)

/**
 * TODO 945: progress of the cleanup of accumulated orphan FTS rows (the index process's idle housekeeping, `src/index-kernel/upkeep.ts`).
 * absent: not started (from 0). A positive number: the rowid of the last `chunk_fts` row examined (a restart continues from there).
 * `-1` (`UPKEEP_DONE`): done. It never runs again.
 */
export const INDEX_FTS_ORPHAN_CURSOR = integerKey('index.ftsOrphanCursor', 'index')

/**
 * TODO 946: progress of back-filling the `lossy` mark (TODO 925) onto already indexed files that are not UTF-8 (`upkeep.ts`).
 * absent: not yet (from 0). A positive number: the last `documents.id` examined. `-1` (`UPKEEP_DONE`): done.
 */
export const INDEX_LOSSY_BACKFILL_CURSOR = integerKey('index.lossyBackfillCursor', 'index')

/**
 * TODO 965: progress of rebuilding the FTS that may have been polluted by rowid reuse (`upkeep.ts`). Documents that have chunks with an id at or below migration 30's
 * `chunk_id_seq.rebuild_below` are put back to `pending` bit by bit and reindexed.
 * absent: not yet (from 0). A positive number: the last `documents.id` examined. `-1` (`UPKEEP_DONE`): done.
 */
export const INDEX_FTS_REBUILD_CURSOR = integerKey('index.ftsRebuildCursor', 'index')

/**
 * TODO 997: progress of the housekeeping that re-attaches the extraction version (`:oxN`) to the version of files whose extracted text is indexed (Office) and puts them back to `pending`
 * (`upkeep.ts`). Rows that became `skipped` by extension before 997 get indexed without waiting for the next full scan.
 * absent: not yet (from 0). A positive number: the last `documents.id` examined. `-1` (`UPKEEP_DONE`): done.
 * The progress belongs to the version in `INDEX_DERIVED_REQUEUE_VERSION` - when the extraction version goes up, it starts over from 0.
 */
export const INDEX_DERIVED_REQUEUE_CURSOR = integerKey('index.derivedRequeueCursor', 'index')

/**
 * TODO 1152: of the versions of how the shadow text put in the index is built (`SHADOW_EPOCH` in `tokenize.ts`), the version for which reindexing has been arranged.
 * If it differs from the current one, when the index process opens it raises `chunk_id_seq.rebuild_below` to the current high-water mark and
 * resets `INDEX_FTS_REBUILD_CURSOR` to 0 (965's rebuild path then reindexes documents that have chunks older than that).
 */
export const INDEX_SHADOW_EPOCH = integerKey('index.shadowEpoch', 'index')

/** TODO 997: which extraction version (`OOXML_EXTRACTOR_VERSION`) the progress in `INDEX_DERIVED_REQUEUE_CURSOR` belongs to. */
export const INDEX_DERIVED_REQUEUE_VERSION = integerKey('index.derivedRequeueVersion', 'index')

/** T4 "external storage". `src/index-kernel/volumes.ts` is the only place this shape is defined. */
export interface AllowedVolume {
  readonly path: string
  readonly label: string
  readonly volumeUuid: string | null
  readonly addedAt: number
}

function isAllowedVolume(value: unknown): value is AllowedVolume {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['path'] === 'string' &&
    typeof record['label'] === 'string' &&
    (record['volumeUuid'] === null || typeof record['volumeUuid'] === 'string') &&
    typeof record['addedAt'] === 'number'
  )
}

/**
 * Allowed external volumes. **Further narrowing by `volumesDir` is done by `VolumeRegistry.configured()`**
 * (`isVolumeMountPath` is knowledge of a run-time directory that exists only in `src/index-kernel/`, and
 * moving it here would make `common/` know index-kernel, breaking the P1 boundary). The `parse` here
 * keeps only the elements whose JSON shape is not broken as an `AllowedVolume`.
 */
export const FS_ALLOWED_VOLUMES = defineKey<readonly AllowedVolume[]>(
  'fs.allowedVolumes',
  'index',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isAllowedVolume)
  },
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Keys written by main (owner: 'main')
// ---------------------------------------------------------------------------

export const UI_LOCALE = defineKey<LocalePreference>(
  'ui.locale',
  'main',
  (raw) => (isLocalePreference(raw) ? raw : DEFAULT_LOCALE_PREFERENCE),
  (v) => v
)

export const UI_THEME = defineKey<ThemePreference>(
  'ui.theme',
  'main',
  (raw) => (isThemePreference(raw) ? raw : DEFAULT_THEME_PREFERENCE),
  (v) => v
)

/**
 * The same shape as `Display.workArea`. `WindowBounds` in `windows.ts` is an alias of this type
 * (`export type WindowBounds = StoredWindowBounds`) - the validation logic can live only in `common/`
 * (P1 boundary, the comment above), so this is where the type is defined too.
 */
export interface StoredWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function isFinitePixel(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Whether the shape passes as `StoredWindowBounds` (validation before rounding to integers). */
export function isStoredWindowBounds(value: unknown): value is StoredWindowBounds {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    isFinitePixel(record['x']) &&
    isFinitePixel(record['y']) &&
    isFinitePixel(record['width']) &&
    isFinitePixel(record['height']) &&
    (record['width'] as number) > 0 &&
    (record['height'] as number) > 0
  )
}

/** Upper bound on the number of remembered (closed) window positions. Beyond this, the oldest are dropped. */
export const MAX_REMEMBERED_BOUNDS = 8

/**
 * Upper bound on the number of windows restored at the next launch (item 36). Windows beyond this that were open at quit are not restored
 * (it is also a limit so that a broken value does not open hundreds of windows at launch).
 */
export const MAX_RESTORED_WINDOWS = 16

/** Upper bound on the length of a restored window's thread id. An id is a UUID, so this is amply large. */
const MAX_STORED_THREAD_ID_LENGTH = 200

/**
 * One element of `window.bounds` (widened to "per-window state" in item 36; the key stays one).
 *
 * - An element without `restore` = **the position of a closed window** (as in T21; the first is the most recently closed window).
 *   It becomes a candidate for where to place a new window (`chooseBounds`).
 * - An element with `restore: true` = **a window that was open at the previous quit** (in opening order, the frontmost window last).
 *   They are restored one by one at the next launch, and if there is a `threadId`, that window is made to open that thread.
 *   It is used up at launch (not restored twice by the next launch). If `maximized: true`, on restore the window is
 *   opened with its normal frame (`bounds` = the frame before maximizing) and then maximized (item 197). **Full screen is
 *   out of scope** - `maximized` means only "maximized by zoom (the green button)", and a full-screen window is restored as an ordinary
 *   window (the caller's decision, `isMaximizedNotFullScreen` in `src/main/index.ts`).
 *
 * The old format (an array of only bounds) can be read as is as "positions of closed windows". Fields with default values are
 * **not written** (omitted), so an element for a closed window is saved in the same shape as the old format.
 */
export interface StoredWindowState extends StoredWindowBounds {
  readonly restore?: true
  readonly threadId?: string
  readonly maximized?: true
}

function isStoredThreadId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_STORED_THREAD_ID_LENGTH
  )
}

/**
 * Converts a stored value (an already JSON-parsed array) into `StoredWindowState[]`. Broken elements are silently dropped.
 * `restore` is kept only when it is `true`, and `threadId` only on a `restore` element with the right shape
 * (a broken `threadId` falls to "restore the window without a thread"). The limits are counted separately for closed windows
 * (`MAX_REMEMBERED_BOUNDS`) and windows to restore (`MAX_RESTORED_WINDOWS`).
 *
 * `parseBoundsList` in `windows.ts` takes a plain value (already through JSON.parse), so this also takes
 * `unknown` rather than a string - `WINDOW_BOUNDS.parse` (a `SettingKey`, which takes a string) is a thin wrapper that just
 * adds `JSON.parse` to this.
 */
export function parseStoredBoundsList(value: unknown): readonly StoredWindowState[] {
  if (!Array.isArray(value)) return []
  const list: StoredWindowState[] = []
  let closed = 0
  let restored = 0
  for (const item of value) {
    if (!isStoredWindowBounds(item)) continue
    const record = item as unknown as Record<string, unknown>
    const restore = record['restore'] === true
    if (restore ? restored >= MAX_RESTORED_WINDOWS : closed >= MAX_REMEMBERED_BOUNDS) continue
    const bounds = {
      x: Math.round(item.x),
      y: Math.round(item.y),
      width: Math.round(item.width),
      height: Math.round(item.height)
    }
    if (restore) {
      const threadId = record['threadId']
      const maximized = record['maximized'] === true
      const withThread = isStoredThreadId(threadId)
        ? { ...bounds, restore: true as const, threadId }
        : { ...bounds, restore: true as const }
      list.push(maximized ? { ...withThread, maximized: true } : withThread)
      restored += 1
    } else {
      list.push(bounds)
      closed += 1
    }
  }
  return list
}

/** Positions of closed windows (T21) and windows that were open at the previous quit (item 36). */
export const WINDOW_BOUNDS = defineKey<readonly StoredWindowState[]>(
  'window.bounds',
  'main',
  (raw) => parseStoredBoundsList(parseJsonRaw(raw)),
  (v) => JSON.stringify(v)
)

/** Defaults for the concurrency and the session lifetime (12.2 / spike 5). The old `DEFAULT_SETTINGS` of `store.ts`. */
export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  // spike 5: the constraint is memory (about 410 MB per session), not rate limits.
  maxConcurrent: 5,
  maxConcurrentCap: 8,
  // An idle session drops its process and is resumed on return (12.2).
  idleTimeoutMs: 20 * 60 * 1000,
  defaultRetention: 'forever',
  // T5: null is the backend's default. It becomes the initial value of the dialog.
  defaultModelId: null,
  defaultThinking: null
}

/**
 * The settings for concurrency and session lifetime (12.2). The validation of the old `ThreadStore.readSettings` as it was
 * (broken values and out-of-range numbers return to the default. A NaN from before item 86 remains in the JSON as null).
 */
export const SESSION_SETTINGS = defineKey<SessionSettings>(
  'session',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw) as Partial<SessionSettings> | undefined
    if (parsed === undefined) return DEFAULT_SESSION_SETTINGS
    const merged = {
      ...DEFAULT_SESSION_SETTINGS,
      ...parsed,
      maxConcurrentCap: DEFAULT_SESSION_SETTINGS.maxConcurrentCap
    }
    const intIn = (value: unknown, min: number, max: number, fallback: number): number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
        ? value
        : fallback
    return {
      ...merged,
      maxConcurrent: intIn(
        merged.maxConcurrent,
        1,
        DEFAULT_SESSION_SETTINGS.maxConcurrentCap,
        DEFAULT_SESSION_SETTINGS.maxConcurrent
      ),
      idleTimeoutMs: intIn(
        merged.idleTimeoutMs,
        60_000,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_SESSION_SETTINGS.idleTimeoutMs
      ),
      defaultModelId: typeof merged.defaultModelId === 'string' ? merged.defaultModelId : null,
      defaultThinking: isThinkingLevel(merged.defaultThinking) ? merged.defaultThinking : null
    }
  },
  (v) => JSON.stringify(v)
)

/**
 * The number of bundle conversations (TODO 633 stage 3, 7.6.6) that may run at once (unfinished bundles + this one). **There is no UI** -
 * it differs from the default (5) only when `app_settings` is written directly. Range 1-8 (the same as the upper bound on processes that can be started at once).
 */
export const DEFAULT_BUNDLE_MAX = 5
export const BUNDLE_MAX_CAP = 8
export const BUNDLE_MAX = defineKey<number>(
  'session.bundleMax',
  'main',
  (raw) => {
    const n = parseIntegerRaw(raw)
    return n !== null && n >= 1 && n <= BUNDLE_MAX_CAP ? n : DEFAULT_BUNDLE_MAX
  },
  (v) => String(v)
)

/** The approval defaults (T12 / T40). That they are split into 3 keys is the original shape. */
export const APPROVAL_AUTO_ALLOW_ALL = defineKey<boolean>(
  'approval.autoAllowAll',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    return typeof parsed === 'boolean' ? parsed : DEFAULT_APPROVAL_POLICY.autoAllowAll
  },
  (v) => JSON.stringify(v)
)

export const APPROVAL_AUTO_ALLOW_TOOLS = defineKey<readonly string[]>(
  'approval.autoAllowTools',
  'main',
  (raw) => stringArrayOr(parseJsonRaw(raw), DEFAULT_AUTO_ALLOW_TOOLS),
  (v) => JSON.stringify(v)
)

export const APPROVAL_BASH_DENY_PATTERNS = defineKey<readonly string[]>(
  'approval.bashDenyPatterns',
  'main',
  (raw) => {
    const patterns = stringArrayOr(parseJsonRaw(raw), DEFAULT_BASH_DENY_PATTERNS)
    // Item 167: a stored value exactly the same as the old default is not "chosen by the user" but "the old default written as
    // all 3 keys together when one approval setting was touched", so read it as the new default (empty). Anything added or removed stays.
    return sameList(patterns, LEGACY_BASH_DENY_PATTERNS) ? DEFAULT_BASH_DENY_PATTERNS : patterns
  },
  (v) => JSON.stringify(v)
)

/**
 * Full delegation mode (TODO 1175, 4.2.1 "full delegation mode"). Default false. When true, approvals are passed without asking for outbound operations, persistent writes, paths that take a conversation's secrets outside, and
 * tools with side effects (questions, requested plans, stop patterns and strict mode still stop). From the AI's `setSetting` it is `gated`
 * (asked in the approval inbox every time) - changes in this category are asked about even when full delegation is ON.
 */
export const APPROVAL_FULL_DELEGATION = defineKey<boolean>(
  'approval.fullDelegation',
  'main',
  (raw) => parseJsonRaw(raw) === true,
  (v) => JSON.stringify(v)
)

// TODO 1222: the global key `approval.autoPickRecommended` for auto-picking a question's recommendation (1194) was removed. It became a per-conversation switch
// (`threads.auto_pick_recommended`, migration 37), and existing rows are simply no longer read (the value is not carried over).

// TODO 1048: the key `approval.pushAllowedRemotes` for 1013's "push targets not asked about" was removed (existing rows are simply no longer read).

/**
 * Connection targets not asked about (TODO 1029). An array of `host` / `user@host` (`src/shared/ssh-hosts.ts`). Default is empty. Normalized again on every read.
 */
export const APPROVAL_SSH_ALLOWED_HOSTS = defineKey<readonly string[]>(
  'approval.sshAllowedHosts',
  'main',
  (raw) => sanitizeSshHosts(parseJsonRaw(raw)),
  (v) => JSON.stringify(v)
)

/**
 * The OS sandbox's connection targets (TODO 1106, 4.2.4, `src/shared/os-sandbox.ts`). An array of `example.com` / `*.example.com`.
 * **The default applies only when the value is absent or broken** (the npm registry and GitHub, owner decision 2026-11-03). An empty array is a valid value meaning "add nothing" and does not return to the default.
 * Normalized again on every read. It takes effect from the next launch of a thread that turned the sandbox ON.
 */
export const SANDBOX_ALLOWED_DOMAINS = defineKey<readonly string[]>(
  'sandbox.allowedDomains',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    return Array.isArray(parsed) ? sanitizeSandboxDomains(parsed) : [...DEFAULT_SANDBOX_ALLOWED_DOMAINS]
  },
  (v) => JSON.stringify(v)
)

/** Places outside cwd that the OS sandbox may write to (TODO 1106). `/…` or `~/…`. The default (`~/.npm`) applies only when the value is absent. */
export const SANDBOX_ALLOW_WRITE = defineKey<readonly string[]>(
  'sandbox.allowWrite',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    return Array.isArray(parsed) ? sanitizeSandboxWritePaths(parsed) : [...DEFAULT_SANDBOX_ALLOW_WRITE]
  },
  (v) => JSON.stringify(v)
)

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Rules made with "Always allow" (T40, app-wide, no expiry). Broken elements are dropped. */
export const APPROVAL_RULES = defineKey<readonly ApprovalRule[]>(
  'approval.rules',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    if (!Array.isArray(parsed)) return []
    const rules: ApprovalRule[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as Record<string, unknown>
      const id = row['id']
      const toolName = row['toolName']
      const command = row['command']
      const createdAt = row['createdAt']
      if (typeof id !== 'string' || id === '') continue
      if (typeof toolName !== 'string' || toolName === '') continue
      if (command !== null && typeof command !== 'string') continue
      const commandHash = row['commandHash']
      if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue
      rules.push(
        typeof commandHash === 'string' && commandHash !== ''
          ? { id, toolName, command, commandHash, createdAt }
          : { id, toolName, command, createdAt }
      )
    }
    return rules
  },
  (v) => JSON.stringify(v)
)

/** The high-water mark of `thread_events` ingestion (item 76). Nullable because `rowid` can be reused. */
export const CONVERSATION_HIGH_WATER = integerKey('index.conversationHighWater', 'main')
/** The time (ms) when the last complete pass finished. */
export const CONVERSATION_LAST_FULL = integerKey('index.conversationLastFull', 'main')

/**
 * The feature-table cache (the adapter's probe, item 81). The key differs per version, so
 * it is made by a function - it cannot be written statically as one row of the table, but the **way the key is built** is in this one place.
 */
export function featureCacheKey(version: string): SettingKey<string | null> {
  return defineKey(
    `features:${version}`,
    'main',
    (raw) => raw,
    (v) => v ?? ''
  )
}

/**
 * Model information the backend reported (items 91 / 92): alias -> full name, and the effort levels that work.
 * A note so that from the very start of the next launch a version can be shown like "Opus 4.8"; the shape of the JSON inside is
 * known only to the Adapter (it contains full names, so only the Adapter reads it too - constraint 6). The key
 * differs per backend, so it is made by a function (the same form as `featureCacheKey`). If broken, the Adapter treats it as empty.
 */
export function backendModelsKey(backendId: string): SettingKey<string | null> {
  return defineKey(
    `backend.${backendId}.models`,
    'main',
    (raw) => raw,
    (v) => v ?? ''
  )
}

// ---------------------------------------------------------------------------
// Bundle E (items 108/115, 2026-09-27)
// ---------------------------------------------------------------------------

/**
 * Assignment of rainbow colors per working directory (item 108). **The key is the case-folded absolute path**
 * (`foldPath(resolve(cwd))` - same reason as `cwd_history` / item 83: an NFD Japanese path or
 * a path differing in case must not become a different cwd), **the value is the color number (0 to {@link RAINBOW_COLORS} - 1)**.
 * The owner is main (colors are decided when the list is built, `src/main/session/rainbow.ts`).
 * The table never shrinks (same policy as approval rules T40; there is no cleanup UI). Elements with a broken value or an
 * out-of-range number are discarded on read (`assignRainbow` treats that key as "unassigned").
 */
export const RAINBOW_TABLE = defineKey<Readonly<Record<string, number>>>(
  'thread.rainbowTable',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const table: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < RAINBOW_COLORS) {
        table[key] = value
      }
    }
    return table
  },
  (v) => JSON.stringify(v)
)

/**
 * Open in an external editor (item 115). The default is VS Code. The owner is main
 * (`src/main/editor/preference.ts` is the only writer).
 */
export const EDITOR_ID = defineKey<EditorId>(
  'editor.id',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    return isEditorId(parsed) ? parsed : DEFAULT_EDITOR_ID
  },
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 11 bundle F (review 2026-09-21 D-2, 2026-09-27)
// ---------------------------------------------------------------------------

/** Retention period of `audit_log` (days). Default 90 days. The owner is main (`src/main/index.ts` reads it at launch; there is no UI). */
export const AUDIT_RETENTION_DAYS = integerKey('audit.retentionDays', 'main')

/** The default of {@link AUDIT_RETENTION_DAYS}. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90

/**
 * The time limit after which a background shell (`run_in_background`) is no longer counted for eviction (item 105,
 * owner decision 2026-09-27). Unlike a subagent, if the `run_in_background`
 * shell stopped eviction (`isEvictable`) the whole time it is running, long-lived work such as
 * a watch would block forever. A shell past this time since its start is
 * made "not counted" (may be evicted), which avoids both killing the watch and a permanent stop.
 * The owner is main (only `SessionManager` reads it). **There is no UI**. Default 30 minutes.
 */
export const DEFAULT_BACKGROUND_SHELL_EVICT_TIMEOUT_MS = 30 * 60 * 1000
export const BACKGROUND_SHELL_EVICT_TIMEOUT_MS = integerKey(
  'session.backgroundShellEvictTimeoutMs',
  'main'
)

/**
 * Desktop notifications ON/OFF (item 72). Default true (a separate axis from "ask as little as possible" T40 -
 * notifications have nothing to do with the approval decision itself). The owner is main
 * (`NotificationPreference` in `src/main/notify.ts` is the only writer).
 */
export const NOTIFY_ENABLED = defineKey<boolean>(
  'notify.enabled',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    return typeof parsed === 'boolean' ? parsed : true
  },
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 13 bundle J (item 164, 2026-09-27)
// ---------------------------------------------------------------------------

/** One global-side server. null if broken (only that element is discarded). */
function parseMcpGlobalServer(value: unknown): McpGlobalServer | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const name = record['name']
  const state = record['state']
  const source = record['source']
  if (typeof name !== 'string' || name === '') return null
  if (!isMcpServerState(state)) return null
  if (source !== null && typeof source !== 'string') return null
  return { name, state, source }
}

/**
 * The latest report of global-side MCP servers (item 164, ARCHITECTURE 4.6.4 "how it is shown").
 * Each time `SessionManager` receives `session_started`, it writes only the rows whose `scope` is global
 * (folder-side rows are not written - it would no longer be known which folder the report was for). The gateway does not write either.
 * null if there is no value (no session has been started yet) or it is broken.
 * Broken elements are discarded. The owner is main (`SessionManager` is the only writer).
 */
export const MCP_LAST_GLOBAL_REPORT = defineKey<McpGlobalReport | null>(
  'mcp.lastGlobalReport',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const at = record['at']
    const servers = record['servers']
    if (typeof at !== 'number' || !Number.isFinite(at) || !Array.isArray(servers)) return null
    const list: McpGlobalServer[] = []
    for (const entry of servers) {
      const server = parseMcpGlobalServer(entry)
      if (server !== null) list.push(server)
    }
    return { at, servers: list }
  },
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 15 bundle D (TODO 261, 2026-09-30)
// ---------------------------------------------------------------------------

/**
 * Whether the file tree shows names starting with "." (TODO 261). Default false (hidden, like Finder / `ls`).
 * One for the whole app (not per window). **Display only** - it does not change what is indexed, searched or scanned.
 * The owner is main (`HiddenFilesPreference` in `src/main/hidden-files.ts` is the only writer).
 */
export const UI_SHOW_HIDDEN_FILES = defineKey<boolean>(
  'ui.showHiddenFiles',
  'main',
  (raw) => parseJsonRaw(raw) === true,
  (v) => JSON.stringify(v)
)

/**
 * The last received values of the usage limits (5 hours / 7 days) (item 317, wave 17 bundle B). Right after launch no value arrives until a session
 * has run one turn, so it is shown from here as "the value n minutes ago". One for the whole app
 * (per account). **Numbers and times only** (no body, constraints 9 / 10). The owner is main
 * (`UsageTracker` in `src/main/usage.ts` is the only writer).
 */
export const USAGE_LAST_SNAPSHOT = defineKey<UsageSnapshot | null>(
  'usage.lastSnapshot',
  'main',
  (raw) => parseUsageSnapshot(parseJsonRaw(raw)),
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 23 bundle C (TODO 463, 2026-10-04)
// ---------------------------------------------------------------------------

/**
 * "Switch to ASCII input in the search box" (TODO 463, ARCHITECTURE 4.5.11). Default true (owner decision).
 * One for the whole app. It does nothing, whatever the value, on non-macOS or when the helper is absent.
 * The owner is main (`AsciiInputPreference` in `src/main/input/preference.ts` is the only writer).
 */
export const INPUT_ASCII_FOR_SEARCH = defineKey<boolean>(
  'input.asciiForSearch',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    return typeof parsed === 'boolean' ? parsed : true
  },
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 26 bundle C (TODO 526, 2026-10-08)
// ---------------------------------------------------------------------------

/**
 * The time before a "thread left alone with neither input nor an answer" is physically deleted (TODO 526). Default 3 minutes.
 * Not deleted if 0 or less. The owner is main (only `SessionManager` reads it). **There is no UI**.
 * It is read only once, at construction (the same handling as item 105's `BACKGROUND_SHELL_EVICT_TIMEOUT_MS`).
 */
export const DEFAULT_ABANDONED_THREAD_TTL_MS = 3 * 60 * 1000
export const ABANDONED_THREAD_TTL_MS = integerKey('threads.abandonedTtlMs', 'main')

/**
 * Ids of conversations whose working-folder history (`touchCwd`) is deferred until the first send (a review fix of TODO 1118). It is put only on a conversation
 * created by opening a first-time folder with `aios://new`, and removed at the first send. The "first-time folder" band above a conversation's Composer also looks at this mark
 * (`Thread.cwdHistoryDeferred`). It used to be judged by "a folder not in the history", so even for a conversation made in the creation dialog the band appeared after the user
 * had removed the folder from recent folders, and the first send put it back into the history. The owner is main (only `ThreadStore` writes it).
 * It is placed here instead of a column-adding migration. Ids of deleted conversations are swept when a mark is added.
 */
export const THREADS_CWD_HISTORY_DEFERRED = defineKey<readonly string[]>(
  'threads.cwdHistoryDeferred',
  'main',
  (raw) => stringArrayOr(parseJsonRaw(raw), []),
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 26 bundle A (TODO 522, 2026-10-08)
// ---------------------------------------------------------------------------

/**
 * Memory of web tabs (TODO 522, ARCHITECTURE 5.2.1). A list of per-window sets (`StoredWebTabSet`, at most 8). It stays after a window is closed or
 * the app quits, and the next window opened (a window restored at launch, a window reopened from the Dock) takes one set each. URLs are
 * only in the form that passed `persistableWebUrl`. The owner is main (`WebTabsMemory` in `src/main/web/tabs.ts` is the only writer).
 */
export const WEB_TABS = defineKey<readonly StoredWebTabSet[]>(
  'web.tabs',
  'main',
  (raw) => parseStoredWebTabSets(parseJsonRaw(raw)),
  (v) => JSON.stringify(v)
)

/**
 * Collapse state and height of the three windows (history / favorites / open tabs) in the Sidebar's web mode (TODO 522). One for the whole app.
 * The owner is main (`web.setSections` in `src/main/web/register.ts` is the only writer).
 */
export const UI_WEB_SECTIONS = defineKey<WebSectionsLayout>(
  'ui.webSections',
  'main',
  (raw) => sanitizeWebSections(parseJsonRaw(raw)),
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 27 bundle E (TODO 549, 2026-10-09)
// ---------------------------------------------------------------------------

/**
 * The user's assignments of keyboard shortcuts (TODO 549, ARCHITECTURE 5.5.2). Only the diff of commands changed from the default
 * (`{ "search.names": "Cmd+T", "find": null }`, null means the assignment was removed). One for the whole app. Only the shape (an object whose values are strings or
 * null) is checked here; validating command IDs and keys, which needs to know the platform, is done by `KeybindingsPreference` in
 * `src/main/keybindings.ts` with `sanitizeKeybindingOverrides`.
 * The owner is main (`KeybindingsPreference` is the only writer).
 */
export const UI_KEYBINDINGS = defineKey<Readonly<Record<string, string | null>>>(
  'ui.keybindings',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string | null> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value === 'string') out[id] = value
    }
    return out
  },
  (v) => JSON.stringify(v)
)

// Wave 27 bundle B (TODO 553 / 547, 2026-10-09)
// ---------------------------------------------------------------------------

/**
 * Slack workspace "name -> ID" (TODO 553, ARCHITECTURE 5.2.1). Remembered when the web view goes from `<name>.slack.com` to
 * `app.slack.com/client/<T>/…`, and used to rewrite `/archives/<C>/p<ts>` links in answers.
 * At most 50 (the oldest dropped). The owner is main (`SlackTeams` in `src/main/web/slack.ts` is the only writer).
 */
export const WEB_SLACK_TEAMS = defineKey<SlackTeamMap>(
  'web.slackTeams',
  'main',
  (raw) => sanitizeSlackTeams(parseJsonRaw(raw)),
  (v) => JSON.stringify(v)
)

/**
 * Certificate exceptions for the web view (TODO 547, ARCHITECTURE 5.2.1). A list of host + SHA-256 certificate fingerprint (at most 100).
 * It applies only to the web view's session (`persist:aios-web`). The owner is main (`WebCertificateTrust` in `src/main/web/certificates.ts`
 * is the only writer, passed in by `web/extras.ts`).
 */
export const WEB_TRUSTED_CERTIFICATES = defineKey<readonly TrustedCertificate[]>(
  'web.trustedCertificates',
  'main',
  (raw) => sanitizeTrustedCertificates(parseJsonRaw(raw)),
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 28 bundle D (TODO 555, 2026-10-10)
// ---------------------------------------------------------------------------

/**
 * Auto-save of the viewer (TODO 555, ARCHITECTURE 5.2.2). The same three as VS Code's `files.autoSave`: `off` (default) /
 * `afterDelay` / `onFocusChange`. One for the whole app. The owner is main (`AutoSavePreference` in
 * `src/main/auto-save.ts` is the only writer).
 */
export const VIEWER_AUTO_SAVE = defineKey<AutoSaveMode>(
  'viewer.autoSave',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    return isAutoSaveMode(parsed) ? parsed : DEFAULT_AUTO_SAVE_MODE
  },
  (v) => JSON.stringify(v)
)

/**
 * The wait time of `afterDelay` (ms, TODO 555). Default 1000, the same as VS Code's `files.autoSaveDelay`. Values out of range are clamped to the edge
 * (`clampAutoSaveDelay`). The owner is main (`AutoSavePreference`).
 */
export const VIEWER_AUTO_SAVE_DELAY = defineKey<number>(
  'viewer.autoSaveDelay',
  'main',
  (raw) => clampAutoSaveDelay(parseIntegerRaw(raw)) ?? DEFAULT_AUTO_SAVE_DELAY_MS,
  (v) => String(v)
)

/**
 * The default viewer per extension (TODO 907, wave 48 bundle D, ARCHITECTURE 7.1). The same idea as VS Code's `workbench.editorAssociations`:
 * extension (lowercase, no dot) -> plugin id, as in `{ "patch": "aios.text" }`. `{}` if absent (the normal selection).
 * Broken values and entries with the wrong shape are dropped. If the plugin no longer exists or is disabled, `PluginHost.resolveViewer` silently
 * falls back to the normal selection (it is not removed here). The owner is main (`ViewerAssociations` in `src/main/plugin/associations.ts` is the only writer).
 */
export const VIEWER_ASSOCIATIONS = defineKey<Readonly<Record<string, string>>>(
  'viewer.associations',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    const out: Record<string, string> = {}
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out
    for (const [ext, pluginId] of Object.entries(parsed as Record<string, unknown>)) {
      if (isAssociationExt(ext) && typeof pluginId === 'string' && pluginId !== '' && pluginId.length <= 200) {
        out[ext] = pluginId
      }
    }
    return out
  },
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 28 bundle G (TODO 103 stage 1, 2026-10-10)
// ---------------------------------------------------------------------------

/**
 * Auto-update (TODO 103, ARCHITECTURE 8.5). **Default ON** (owner decision 2026-09-28, the same idea as VS Code's `update.mode`).
 * When OFF it does not ask for the latest version (no network access), does not fetch, and does not restart when idle. The "Check for updates" button works even when OFF.
 * The owner is main (`UpdateService` in `src/main/update/service.ts` is the only writer).
 */
export const UPDATE_AUTO = defineKey<boolean>(
  'update.auto',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    return typeof parsed === 'boolean' ? parsed : true
  },
  (v) => JSON.stringify(v)
)

/**
 * The version that last ran (TODO 103). At each launch the current version is written, and if it is newer than the previous value, "Updated to version X" is shown
 * (not on the first launch = when there is no value). A plain string (`0.28.0`). The owner is main (`UpdateService`).
 */
export const UPDATE_LAST_RUN_VERSION = defineKey<string | null>(
  'update.lastRunVersion',
  'main',
  (raw) => (raw !== null && PLAIN_VERSION_RE.test(raw) ? raw : null),
  (v) => v ?? ''
)

/**
 * TODO 1333: when the installed (staged) version was installed, so the 1-hour grace for reservations / background shells is not counted again after a restart of the app.
 * `{ version, at }` (JSON); only valid for the same version. The owner is main (`UpdateService`).
 */
export interface UpdateStagedAt {
  readonly version: string
  readonly at: number
}
export const UPDATE_STAGED_AT = defineKey<UpdateStagedAt | null>(
  'update.stagedAt',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { version, at } = parsed as Record<string, unknown>
    return typeof version === 'string' && PLAIN_VERSION_RE.test(version) && typeof at === 'number' && Number.isFinite(at)
      ? { version, at }
      : null
  },
  (v) => (v === null ? '' : JSON.stringify(v))
)

/**
 * TODO 1333: unsaved text carried over an idle restart for an update (`CarriedDrafts` in `@shared/update.js`, wrapped with the time it was saved).
 * **Held only between the moment right before the restart and the first window that asks for it on the next launch**, then removed (it is also removed
 * when the restart is called off). It stays inside the encrypted DB and is never logged. The raw value is `''` when absent. The owner is main (`CarriedDraftsService`).
 */
export interface StoredCarriedDrafts {
  readonly savedAt: number
  readonly drafts: unknown
}
export const UPDATE_CARRIED_DRAFTS = defineKey<StoredCarriedDrafts | null>(
  'update.carriedDrafts',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { savedAt, drafts } = parsed as Record<string, unknown>
    return typeof savedAt === 'number' && Number.isFinite(savedAt) ? { savedAt, drafts } : null
  },
  (v) => (v === null ? '' : JSON.stringify(v))
)

/**
 * Whether, on the first launch after an update, the new version's change history (Release Notes, TODO 1186) is shown once in the ViewerPane. **Default ON**
 * (the same as VS Code's `update.showReleaseNotes`). An item under "Update" in settings. The owner is main (`ReleaseNotesService` is the only writer).
 * It is in the settings editor's value table (`releaseNotesAuto`), and for the AI's tools it is `display` (the choke point is not loosened).
 */
export const RELEASE_NOTES_AUTO = defineKey<boolean>(
  'releaseNotes.auto',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    return typeof parsed === 'boolean' ? parsed : true
  },
  (v) => JSON.stringify(v)
)

/**
 * The last version for which the change history was shown automatically (TODO 1186). A record so the same version is not shown twice; a plain string (`0.78.0`).
 * The owner is main (`ReleaseNotesService`).
 */
export const RELEASE_NOTES_LAST_SHOWN = defineKey<string | null>(
  'releaseNotes.lastShown',
  'main',
  (raw) => (raw !== null && PLAIN_VERSION_RE.test(raw) ? raw : null),
  (v) => v ?? ''
)

// ---------------------------------------------------------------------------
// Wave 29 bundle D (TODO 626, 2026-10-10)
// ---------------------------------------------------------------------------

/**
 * The recognition language of voice input (TODO 626, ARCHITECTURE.md 4.5.10). A key separate from the display language (`UI_LOCALE`).
 * The default is `auto` (the first of macOS's preferred languages, resolved by `src/main/voice/locale-preference.ts`).
 * One for the whole app. The owner is main (`VoiceLocalePreferenceStore` is the only writer).
 */
export const VOICE_LOCALE = defineKey<VoiceLocalePreference>(
  'voice.locale',
  'main',
  (raw) => (isVoiceLocalePreference(raw) ? raw : DEFAULT_VOICE_LOCALE_PREFERENCE),
  (v) => v
)

/**
 * The font for the body of Gmail drafts (TODO 1229, wave 86). `default` (the default, no instruction) / `monospace` (told to the AI in an additional instruction).
 * One for the whole app. The owner is main (`GmailDraftFontPreference` is the only writer). It goes into the conversation's launch flags, so it takes effect from conversations started after the change.
 */
export const GMAIL_DRAFT_FONT = defineKey<GmailDraftFont>(
  'gmail.draftFont',
  'main',
  (raw) => (isGmailDraftFont(raw) ? raw : DEFAULT_GMAIL_DRAFT_FONT),
  (v) => v
)

// ---------------------------------------------------------------------------
// Wave 30 bundle C (TODO 659, 2026-10-10)
// ---------------------------------------------------------------------------

/**
 * After how many days of inactivity rows in the thread list are collapsed (TODO 659, ARCHITECTURE.md 4.3 "display sort order").
 * **Default 5 days, 0 = do not collapse.** One for the whole app. The owner is main (`ThreadCollapsePreference` is the only writer).
 */
export const THREADS_COLLAPSE_OLD_AFTER_DAYS = defineKey<number>(
  'threads.collapseOldAfterDays',
  'main',
  (raw) => clampCollapseOldAfterDays(parseIntegerRaw(raw)) ?? DEFAULT_COLLAPSE_OLD_AFTER_DAYS,
  (v) => String(v)
)

// ---------------------------------------------------------------------------
// Wave 43 bundle C (TODO 872, 2026-10-18)
// ---------------------------------------------------------------------------

/**
 * The order of the file tree (TODO 872). `modified` (default; directories first, files newest first) / `name`.
 * One for the whole app. The owner is main (`FileSortPreference` is the only writer). Modeled on VS Code's `explorer.sortOrder`.
 */
export const UI_FILE_SORT_ORDER = defineKey<FileSortOrder>(
  'ui.fileSortOrder',
  'main',
  (raw) => (isFileSortOrder(raw) ? raw : DEFAULT_FILE_SORT_ORDER),
  (v) => v
)

// ---------------------------------------------------------------------------
// Wave 44 bundle A (TODO 811, 2026-10-18)
// ---------------------------------------------------------------------------

/**
 * The Redmine base URL (TODO 811, ARCHITECTURE 5.1). Turns `#22955` in answers and the `#` / ticket column numbers in tables into
 * `<base>/issues/<n>` links. **https only** (checked by `normalizeRedmineBase`; an unusable stored value is treated as unset).
 * Empty = unset. One for the whole app (only one Redmine). The owner is main (`RedmineBasePreference` is the only writer).
 */
export const WEB_REDMINE_BASE_URL = defineKey<string>(
  'web.redmineBaseUrl',
  'main',
  (raw) => (raw === null ? '' : (normalizeRedmineBase(raw) ?? '')),
  (v) => v
)

// ---------------------------------------------------------------------------
// Wave 36 bundle D (TODO 774, 2026-10-12)
// ---------------------------------------------------------------------------

/**
 * Whether aios runs the backend's (agent CLI) own update at launch and once a day (TODO 774, ARCHITECTURE 4.6.6).
 * **Default ON** (owner decision 2026-10-12). "Update now" works even when OFF. The owner is main
 * (`AgentUpdateService` in `src/main/agent-update/service.ts` is the only writer).
 */
export const AGENT_UPDATE_AUTO = defineKey<boolean>(
  'agentUpdate.auto',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    return typeof parsed === 'boolean' ? parsed : true
  },
  (v) => JSON.stringify(v)
)

/**
 * The record of the last upgrade `{ from, to, at }` (TODO 774). Where "revert to the previous version" goes back to when the check after upgrading fails.
 * Discarded on read if it is not in version form. The owner is main (`AgentUpdateService`).
 */
export const AGENT_UPDATE_LAST = defineKey<AgentUpdateRecord | null>(
  'agentUpdate.last',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const from = record['from']
    const to = record['to']
    const at = record['at']
    if (typeof from !== 'string' || !PLAIN_VERSION_RE.test(from)) return null
    if (typeof to !== 'string' || !PLAIN_VERSION_RE.test(to)) return null
    const base = { from, to, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 }
    // Confirmed (the check passed once on the new version, TODO 774 code-review 7).
    return record['confirmed'] === true ? { ...base, confirmed: true } : base
  },
  (v) => (v === null ? '' : JSON.stringify(v))
)

/**
 * The version for which automatic runs are stopped because it was reverted (the version before the revert, TODO 774). Cleared by "Update now". A plain string.
 * The owner is main (`AgentUpdateService`).
 */
export const AGENT_UPDATE_HELD_FROM = defineKey<string | null>(
  'agentUpdate.heldFrom',
  'main',
  (raw) => (raw !== null && PLAIN_VERSION_RE.test(raw) ? raw : null),
  (v) => v ?? ''
)

/**
 * The time (ms) when `agentUpdate.heldFrom` was set (TODO 774 code-review 6). After a revert, the hold is released automatically after 7 days
 * (owner decision 2026-10-12). An old hold with no time is counted from the time it was first read. The owner is main (`AgentUpdateService`).
 */
export const AGENT_UPDATE_HELD_AT = defineKey<number | null>(
  'agentUpdate.heldAt',
  'main',
  (raw) => parseIntegerRaw(raw === '' ? null : raw),
  (v) => (v === null ? '' : String(v))
)

/** The version of an extension placed by an update and a digest of its contents (one row of `plugins.updated`, TODO 1144 stage 2). */
export interface UpdatedPluginRecord {
  /** `x.y.z` (the same as the name of the placement directory). */
  readonly version: string
  /** A digest of the placed contents (a SHA-256 made from the relative paths and each file's SHA-256, `treeDigest`). */
  readonly digest: string
}

/**
 * TODO 1144 stage 2 (ARCHITECTURE 8.5.1): the version placed in `<userData>/plugin-updates/<id>/<version>/` by a per-extension update, and a digest of its contents.
 * **Only a version listed here whose digest matches** is read by `PluginHost` in place of the bundled one (the placement is outside the encrypted DB, so the DB's record
 * is the trust anchor - a directory placed or rewritten from outside is not read with the bundled one's privileges). The owner is main
 * (`UpdatedPluginStore` in `src/main/plugin/updated-store.ts` is the only writer).
 */
export const PLUGIN_UPDATED_VERSIONS = defineKey<Readonly<Record<string, UpdatedPluginRecord>>>(
  'plugins.updated',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, UpdatedPluginRecord> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!PLUGIN_ID_RE.test(id) || typeof value !== 'object' || value === null) continue
      const version = (value as Record<string, unknown>)['version']
      const digest = (value as Record<string, unknown>)['digest']
      if (typeof version !== 'string' || !PLAIN_VERSION_RE.test(version)) continue
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) continue
      out[id] = { version, digest }
    }
    return out
  },
  (v) => JSON.stringify(v)
)

/** TODO 1237: a reserved key inside `plugins.settings` (it can never take the form of a plugin id). The table of extension identity at the time a value was saved. */
export const PLUGIN_SETTINGS_OWNERS_KEY = '$owners'

/**
 * TODO 1225 (7.2.1): the values of an extension's settings (the manifest's `configuration` fields). plugin id -> field name -> value. Only the shape (the id's form and
 * a plain object) is checked here; the values themselves are checked again against the current declaration on every read (`resolvePluginSettings`). Secrets are not stored here (use the credentials entry point).
 * The owner is main (`PluginSettingsStore` in `src/main/plugin/settings.ts` is the only writer).
 */
export const PLUGIN_SETTINGS = defineKey<Readonly<Record<string, Readonly<Record<string, unknown>>>>>(
  'plugins.settings',
  'main',
  (raw) => {
    const parsed = parseJsonRaw(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, Readonly<Record<string, unknown>>> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      // TODO 1237: `$owners` is a reserved key that can never take the form of a plugin id (which contains `.`) - the identity of the extension when the value was saved (id -> string).
      // It lives in the same JSON as the values, so the value and its owner change together in one write (no half-done state is left).
      if (id === PLUGIN_SETTINGS_OWNERS_KEY) {
        const owners: Record<string, unknown> = {}
        for (const [owner, identity] of Object.entries(value as Record<string, unknown>)) {
          if (PLUGIN_ID_RE.test(owner) && typeof identity === 'string' && identity !== '') owners[owner] = identity
        }
        out[id] = owners
        continue
      }
      if (!PLUGIN_ID_RE.test(id)) continue
      out[id] = value as Record<string, unknown>
    }
    return out
  },
  (v) => JSON.stringify(v)
)

/**
 * For "save a conversation as PDF" (TODO 818), the folder last saved to (a plain string, an absolute path). It becomes the save dialog's
 * initial folder (owner decision 2026-10-17; ~/Downloads if absent). The owner is main (`ConversationExporter`).
 */
export const EXPORT_LAST_DIR = defineKey<string | null>(
  'export.lastDir',
  'main',
  (raw) => (raw !== null && raw.startsWith('/') ? raw : null),
  (v) => v ?? ''
)

// ---------------------------------------------------------------------------
// Wave 47 bundle C (TODO 900, 2026-10-20)
// ---------------------------------------------------------------------------

/**
 * The history of the sidebar search box (TODO 900). An array (JSON) of `{ query, mode }`, newest first, at most 20. One list shared by the 3 windows (TODO 1157. An old-format string is read as `files`).
 * **Search terms may contain sensitive content** - keep them only in the encrypted DB and never log them. The owner is main (`SearchHistory` is the only writer).
 */
export const SEARCH_HISTORY = defineKey<readonly SearchHistoryEntry[]>(
  'search.history',
  'main',
  (raw) => sanitizeHistory(parseJsonRaw(raw)),
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 50 bundle D (TODO 960, 2026-10-24)
// ---------------------------------------------------------------------------

/**
 * Whether, when an expired login is detected, Terminal is opened without a button to run the login (TODO 960). **Default true** (TODO 1178:
 * unsaved = true, a saved `false` = false. TODO 960's default was false, reversed by owner decision 2026-11-07). The owner is main (`AutoLoginPreference` in
 * `src/main/session/login-recovery.ts` is the only writer).
 */
export const AUTH_AUTO_LOGIN = defineKey<boolean>(
  'auth.autoLogin',
  'main',
  (raw) => parseJsonRaw(raw) !== false,
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 93 bundle C (TODO 1266 / 1270, 2026-11-20)
// ---------------------------------------------------------------------------

/**
 * Start the app when the user logs in to the computer (TODO 1266). **Default OFF** (owner decision 2026-11-20). The stored value is only a memory:
 * where the OS can tell (a distributed build) the OS's own login item list is the truth and the screen shows that (the user may remove it in System Settings).
 * The owner is main (`OpenAtLoginPreference` in `src/main/os-settings.ts` is the only writer).
 */
export const APP_OPEN_AT_LOGIN = defineKey<boolean>(
  'app.openAtLogin',
  'main',
  (raw) => parseJsonRaw(raw) === true,
  (v) => JSON.stringify(v)
)

/**
 * Review fix for TODO 1277: set only when the post-update re-registration of the login item ended with the OS entry missing although the user had it ON.
 * The next launch's `reconcile` retries once and clears it. Never set for a user who has it OFF. Owner is main (`OpenAtLoginPreference`). Not shown to the tools.
 */
export const APP_OPEN_AT_LOGIN_RESTORE = defineKey<boolean>(
  'app.openAtLoginRestore',
  'main',
  (raw) => parseJsonRaw(raw) === true,
  (v) => JSON.stringify(v)
)

/**
 * Keep the computer from sleeping on idle while scheduled jobs are waiting and the power cable is connected (TODO 1270). **Default OFF** (owner decision
 * 2026-11-20). The display may still turn off and closing the lid still sleeps. The owner is main (`PreventSleepPreference` in `src/main/os-settings.ts`).
 */
export const POWER_PREVENT_SLEEP = defineKey<boolean>(
  'power.preventSleep',
  'main',
  (raw) => parseJsonRaw(raw) === true,
  (v) => JSON.stringify(v)
)

/**
 * Show aios in the macOS menu bar (TODO 1269). **Default ON** (TODO 1301, owner decision 2026-11-22; it was OFF at first): no stored value means ON, and a stored
 * OFF stays OFF. macOS only (elsewhere the setting does nothing).
 * The owner is main (`MenuBarPreference` in `src/main/os-settings.ts` is the only writer).
 */
export const APP_MENU_BAR = defineKey<boolean>(
  'app.menuBar',
  'main',
  (raw) => raw === null || parseJsonRaw(raw) !== false,
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 53 bundle B (TODO 999, 2026-10-25)
// ---------------------------------------------------------------------------

/**
 * Whether to show a "new screenshot" badge above the Composer (TODO 999). **Default true** (owner decision: show it, can be turned off in settings).
 * The owner is main (`ScreenshotOfferPreference` in `src/main/recent/preference.ts` is the only writer).
 */
export const COMPOSER_SCREENSHOT_OFFER = defineKey<boolean>(
  'composer.screenshotOffer',
  'main',
  (raw) => parseJsonRaw(raw) !== false,
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 57 bundle B (TODO 1052, 2026-10-29)
// ---------------------------------------------------------------------------

/**
 * First-time consent for the AI to read the body of an open web tab (the gateway's `getOpenUrlText`) (TODO 1052). One for the whole app
 * (owner decision 2026-10-29: not per thread; as with 848's first-time consent for `browser`, once asked it is not asked again).
 * **Default false** (not consented). The owner is main (the read stage of `src/main/session/gateway-requests.ts` writes it through `index.ts`).
 */
export const WEB_TAB_READ_CONSENT = defineKey<boolean>(
  'web.tabReadConsent',
  'main',
  (raw) => parseJsonRaw(raw) === true,
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 59 bundle A (TODO 1064, 2026-10-31)
// ---------------------------------------------------------------------------

/**
 * Whether, before the first screen capture, the user was told "macOS will show one more confirmation" (TODO 1064). **Default false** (not told).
 * The screen-recording permission and the confirmation for bypassing the picker are separate permissions, and the latter appears at the first capture. The owner is main
 * (`register.ts`, which calls `captureHeadsUp` in `src/main/paste/screen-capture.ts`, is the only writer).
 */
export const CAPTURE_HEADSUP_SHOWN = defineKey<boolean>(
  'capture.headsUpShown',
  'main',
  (raw) => parseJsonRaw(raw) === true,
  (v) => JSON.stringify(v)
)

// ---------------------------------------------------------------------------
// Wave 99 bundle C (TODO 1306, 2026-11-22): automatic backup
// ---------------------------------------------------------------------------

/**
 * The one-time band "decide a backup passphrase" was closed (TODO 1306). **Default false** (shown once after launch until closed or decided).
 * The owner is main (`BackupService` via `src/main/backup/ipc.ts` is the only writer). Not shown to the AI's tools.
 */
export const BACKUP_NOTICE_DISMISSED = defineKey<boolean>(
  'backup.noticeDismissed',
  'main',
  (raw) => parseJsonRaw(raw) === true,
  (v) => JSON.stringify(v)
)

/**
 * The last backup attempt that failed (TODO 1306): `{ at, reason }` (a `BackupFailure` code), null after a success. Only a time and a
 * reason code - no path, no passphrase. The owner is main (`src/main/backup/ipc.ts`). The folder and the passphrase are **not** here:
 * they are needed when the DB cannot be opened, so they live in userData (`backup.json`, and `backup.pass` sealed by the keychain).
 */
export const BACKUP_LAST_FAILURE = defineKey<{ readonly at: number; readonly reason: BackupFailure } | null>(
  'backup.lastFailure',
  'main',
  (raw) => {
    const value = parseJsonRaw(raw) as { at?: unknown; reason?: unknown } | undefined
    if (typeof value !== 'object' || value === null) return null
    if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return null
    if (typeof value.reason !== 'string' || !(BACKUP_FAILURES as readonly string[]).includes(value.reason)) return null
    return { at: value.at, reason: value.reason as BackupFailure }
  },
  (v) => (v === null ? 'null' : JSON.stringify({ at: v.at, reason: v.reason }))
)

/**
 * What the newest backup generation could not hold (TODO 1331 item 3): `{ file, events, threads }`, where `file` is that generation's file
 * name (so the counts are shown only while that file is the newest) and the counts are what the export skipped. null = nothing dropped.
 * Counts and a file name only - no title, no body. The owner is main (`src/main/backup/ipc.ts`).
 */
export const BACKUP_LAST_SKIPPED = defineKey<{ readonly file: string; readonly events: number; readonly threads: number } | null>(
  'backup.lastSkipped',
  'main',
  (raw) => {
    const value = parseJsonRaw(raw) as { file?: unknown; events?: unknown; threads?: unknown } | undefined
    if (typeof value !== 'object' || value === null) return null
    if (typeof value.file !== 'string' || value.file.length === 0 || value.file.length > 300) return null
    const events = value.events
    const threads = value.threads
    if (typeof events !== 'number' || !Number.isFinite(events) || events < 0) return null
    if (typeof threads !== 'number' || !Number.isFinite(threads) || threads < 0) return null
    return { file: value.file, events, threads }
  },
  (v) => (v === null ? 'null' : JSON.stringify({ file: v.file, events: v.events, threads: v.threads }))
)

// ---------------------------------------------------------------------------
// Wave 59 bundle C (TODO 1060 stage 1, 2026-10-31): classification of the keys the conversation's AI may read and change
// ---------------------------------------------------------------------------

/**
 * The classification of keys shown to the gateway's `getSettings` / `setSetting` (ARCHITECTURE 7.6.8).
 *
 * - `display`: display preferences. Changes by the AI do not loosen the choke point, so they are applied at once without going to the approval inbox.
 * - `gated`: keys that concern approvals, choke points, updates, login and outbound links. Each change asks the user in the approval inbox (`alwaysAsk`.
 *   It is not silenced even by "Always allow". The same handling as 1042's "removing the choke point").
 *
 * **A key not in this table is invisible to the tools** (secrets, consent records, internal state, cursors). A key that is in the tool list
 * (`src/main/agent-settings.ts`) but not here falls to `gated` (so the AI cannot use it as a foothold to loosen the choke point;
 * owner decision 2026-10-31). The writer (owner, TODO 85) is unrelated to this table, and changes go through each key's existing setter.
 */
export type AgentSettingAccess = 'display' | 'gated'

export const AGENT_SETTING_ACCESS: Readonly<Record<string, AgentSettingAccess>> = {
  [UI_THEME.key]: 'display',
  [UI_LOCALE.key]: 'display',
  [EDITOR_ID.key]: 'display',
  [NOTIFY_ENABLED.key]: 'display',
  [INPUT_ASCII_FOR_SEARCH.key]: 'display',
  [VIEWER_AUTO_SAVE.key]: 'display',
  [VIEWER_AUTO_SAVE_DELAY.key]: 'display',
  [VOICE_LOCALE.key]: 'display',
  // TODO 1229: the font of Gmail drafts. A visual preference; the choke point is not loosened.
  [GMAIL_DRAFT_FONT.key]: 'display',
  [THREADS_COLLAPSE_OLD_AFTER_DAYS.key]: 'display',
  [UI_FILE_SORT_ORDER.key]: 'display',
  [COMPOSER_SCREENSHOT_OFFER.key]: 'display',
  // TODO 1186: open the change history after an update. A visual preference; the choke point is not loosened.
  [RELEASE_NOTES_AUTO.key]: 'display',
  // TODO 1060 stage 3: showing hidden files and key assignments are visual (display). Connection targets not asked about are the approval choke point, and the bundle count is a session sibling of the concurrency count (gated).
  [UI_SHOW_HIDDEN_FILES.key]: 'display',
  // TODO 976 review Y-1: key assignments include `app.summon` of scope `global` (an OS-wide hotkey), so gated.
  // With display, the AI could silently take, e.g., ⌘V as an OS-wide hotkey. Changing assignments is asked in the approval inbox.
  [UI_KEYBINDINGS.key]: 'gated',
  [BUNDLE_MAX.key]: 'gated',
  [APPROVAL_SSH_ALLOWED_HOSTS.key]: 'gated',
  [SESSION_SETTINGS.key]: 'gated',
  [APPROVAL_AUTO_ALLOW_ALL.key]: 'gated',
  [APPROVAL_AUTO_ALLOW_TOOLS.key]: 'gated',
  [APPROVAL_BASH_DENY_PATTERNS.key]: 'gated',
  // TODO 1175: full delegation mode. Asked every time so the AI cannot turn it ON by itself.
  [APPROVAL_FULL_DELEGATION.key]: 'gated',
  [UPDATE_AUTO.key]: 'gated',
  [AGENT_UPDATE_AUTO.key]: 'gated',
  [AUTH_AUTO_LOGIN.key]: 'gated',
  // TODO 1266 / 1270: launching at login and keeping the machine awake change how the computer behaves outside the app, so they are asked about (gated).
  [APP_OPEN_AT_LOGIN.key]: 'gated',
  [POWER_PREVENT_SLEEP.key]: 'gated',
  // TODO 1269: a menu bar icon is a visual preference; the choke point is not loosened.
  [APP_MENU_BAR.key]: 'display',
  [WEB_REDMINE_BASE_URL.key]: 'gated'
}

/** The classification of a key. null if not in the table (= not shown to the tools). */
export function agentSettingAccess(key: { readonly key: string }): AgentSettingAccess | null {
  return Object.prototype.hasOwnProperty.call(AGENT_SETTING_ACCESS, key.key) ? (AGENT_SETTING_ACCESS[key.key] ?? null) : null
}
