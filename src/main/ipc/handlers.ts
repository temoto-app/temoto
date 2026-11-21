/**
 * IPC handlers. Nothing coming from the renderer is trusted; everything is validated
 * (URI validation is done by FsService.assertAllowed).
 */
import { BrowserWindow, dialog, nativeImage, ipcMain as electronIpcMain, shell, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { AgentStatus, AiosEventBatch, McpGlobalReport } from '@shared/agent.js'
import type { LoginRecoveryState } from '@shared/login-recovery.js'
import { isThinkingLevel } from '@shared/agent.js'
import { isLocalModelAction } from '@shared/local-models.js'
import { isDefaultModelIdValue, type SettingValues } from '@shared/settings.js'
import { parseViewerShownReport } from '@shared/viewer-shown.js'
import type {
  ApprovalDecision,
  ApprovalItem,
  ApprovalPolicyPatch,
  CreateThreadInput,
  DeletedThreadSummary,
  DirectoryPick,
  SendInput,
  SessionSettings,
  ThreadRetention,
  ThreadSummary,
  ViewerSelection
} from '@shared/thread.js'
import { isRoleGrantScope } from '@shared/thread.js'
import { conversationCwdPathOf, pathToUri, uriToPath } from '../../common/uri.js'
import type { SkillDeleteRequest } from '@shared/skills.js'
import { cwdPathOf, deleteSkill, listSkills } from '../session/adapter/skills.js'
import type {
  AppInfo,
  LogInfo,
  DirectoryListing,
  FileChangeBatch,
  FileSearchResult,
  ListDirectoryOptions,
  ScanStatus
} from '@shared/types.js'
import { asListDirectoryOptions } from '@shared/types.js'
import type { FileSortOrder } from '@shared/file-sort.js'
import type { IndexStatus, SearchScope } from '@shared/search.js'
import type {
  AuditEntry,
  CapabilityName,
  PluginDetail,
  PluginSummary,
  ViewerCommandResponse
} from '@shared/plugin.js'
import { isCapabilityName, isTransientPayloadKind } from '@shared/plugin.js'
import { isThemePreference, type ThemeState } from '@shared/theme.js'
import { isLocalePreference, type LocaleState } from '@shared/locale.js'
import type { FsAccess } from '../fs/access.js'
import type { IndexClient } from '../index/client.js'
import type { SessionManager } from '../session/manager.js'
import type { PluginHost } from '../plugin/host.js'
import type { PluginSurfaces } from '../plugin/surfaces.js'
import type { PluginSearchRelay } from '../plugin/search.js'
import type { PluginSearchResponse } from '@shared/plugin-search.js'
import { EMPTY_SURFACES, type PluginSurfacesSnapshot } from '@shared/plugin-surfaces.js'
import type { ViewerBroker } from '../capability/viewer.js'
import { resolveTransientFileViewer } from '../capability/transient-file.js'
import type { AuditLog } from '../capability/audit.js'
import type { ThemeController } from '../theme.js'
import type { LocaleController } from '../locale.js'
import { nativeText } from '../i18n-native.js'
import type { GitStatusReader } from '../git/status.js'
import { isEditorId } from '@shared/editor.js'
import type { EditorLauncher } from '../editor/launcher.js'
import { revealInFolder, revealLogFile, withHandoffFallback } from '../editor/reveal.js'
import { openTerminalWithCli } from '../editor/terminal.js'
import { openInDefaultAppForHost, openWithDefaultApp } from '../editor/open-default.js'
import { currentLogDirectory, currentLogFilePath } from '../log-file.js'
import type { EditorPreference } from '../editor/preference.js'
import type { NotificationPreference } from '../notify.js'
import { LoginRecovery, type AutoLoginPreference } from '../session/login-recovery.js'
import type { AsciiInputPreference } from '../input/preference.js'
import type { AutoSavePreference } from '../auto-save.js'
import { settingsSnapshot } from '../settings-snapshot.js'
import { log, errorFields } from '../../common/logger.js'
import { openExternalChecked } from '../open-external.js'
import { openSystemSettings } from '../os/system-settings.js'
import { createThreadFromDrop, kindOfPath, type OpenRequests } from '../drop.js'
import { resolveLinkRequest, resolveLinkWithSearch } from '../fs/link.js'
import { checkDropLinks } from '../fs/drop-links.js'
import { dropTraceEventName, sanitizeDropTrace } from '@shared/drop-link.js'
import { createEntry } from '../fs/create.js'
import { renameEntry } from '../fs/rename.js'
import { AppIconCache } from '../fs/app-icon.js'
import { startFilesDragGuarded } from '../fs/drag.js'
import type { CreateEntryResult, NewEntryKind, RenameEntryResult } from '@shared/new-entry.js'
import { SearchOrigins } from './search-origin.js'
import { parseReason, reasonError } from '@shared/reason.js'
import { PathDenied, pathDenialCode, pathDenialReason } from '../../common/fs-policy.js'
import { asThreadIdList } from '../session/abandoned.js'
import type { VoiceLocalePreference } from '@shared/voice-locale.js'
import type { GmailDraftFont } from '@shared/gmail-draft-font.js'
import { asExportScope } from '@shared/conversation-export.js'
import type { ConversationExporter } from '../export/conversation-pdf.js'

export interface HandlerDeps {
  /** The file entry point that stayed in main (P1, the "FsAccess" row of the table in 3.1). */
  readonly fs: FsAccess
  readonly sessions: SessionManager
  /** Thin client to the index process (P1). Listing / search / scan are all RPC. */
  readonly index: IndexClient
  readonly appInfo: AppInfo
  /** Phase 4: plugin infrastructure (chapter 7). */
  readonly plugins: PluginHost
  /** The plugin surfaces (TODO 1039 / 1038). Returns empty when absent (tests). */
  readonly surfaces?: PluginSurfaces
  /** TODO 896: the plugin section of the search sidebar. Omitted = no section (existing tests). */
  readonly pluginSearch?: PluginSearchRelay
  readonly viewer: ViewerBroker
  readonly audit: AuditLog
  /** Color theme (7.4.1, T10). The owner of persistence and following the OS is here. */
  readonly theme: ThemeController
  readonly locale: LocaleController
  /** TODO 967: if a conversation is running, ask for confirmation, settle drafts, then `app.relaunch()` + quit. Returns `false` if cancelled (main's choke point asks once, TODO 1004). */
  readonly relaunch: () => Promise<boolean>
  /** The BottomBar git summary (5.6, TODO 51). The reader itself holds the URI gate and swallows failures. */
  readonly git: GitStatusReader
  /** Open in an external editor (item 115). The launcher owns the URI gate and launching; the preference owns the setting. */
  readonly editor: EditorLauncher
  /**
   * A launcher only for "Open in external editor" on the band for a link that could not be opened (TODO 808).
   * Its choke point is "the normal choke point -> if refused, `'handoff'`". Kept separate from `editor` so that
   * no other entry point can hand an excluded location to the external editor (a code-review fix).
   */
  readonly editorHandoff: EditorLauncher
  readonly editorPreference: EditorPreference
  /** The "thread to open" left with a window (item 98 (c)). A Drop onto the Dock puts it from `index.ts`. */
  readonly openRequests: OpenRequests
  /** Desktop notifications ON/OFF (item 72). main is the only writer for persistence. */
  readonly notifications: NotificationPreference
  /** Setting to open the login automatically when an expired authentication is detected (TODO 960). */
  readonly autoLogin: AutoLoginPreference
  /** Setting for ASCII input in the search field (TODO 463). IPC is in `input/register.ts`; here it is only the settings editor's defaults table. */
  readonly asciiInput: AsciiInputPreference
  /** Viewer auto-save setting (TODO 555). IPC is in `auto-save-ipc.ts`; here it is only the settings editor's defaults table. */
  readonly autoSave: AutoSavePreference
  /** Auto-update ON / OFF (TODO 103). IPC is in `update/ipc.ts`; here it is only the settings editor's defaults table. */
  readonly autoUpdate: () => boolean
  /** The backend's own auto-update ON / OFF (TODO 774). IPC is in `agent-update/ipc.ts`; here it is only the settings editor's defaults table. */
  readonly agentAutoUpdate: () => boolean
  /** Voice input recognition language (TODO 626). IPC is in `voice/register.ts`; here it is only the settings editor's defaults table. */
  readonly voiceLocale: () => VoiceLocalePreference
  /** Font of the Gmail draft body (TODO 1229). IPC is in `gmail-draft-font-ipc.ts`; here it is only the settings editor's defaults table. */
  readonly gmailDraftFont: () => GmailDraftFont
  /** Days after which the thread list collapses (TODO 659). IPC is in `thread-collapse-ipc.ts`; here it is only the settings editor's defaults table. */
  readonly threadCollapseDays: () => number
  /** File tree sort order (TODO 872). IPC is in `file-sort-ipc.ts`. Attached to every listing request to the index process. */
  readonly fileSortOrder: () => FileSortOrder
  /** Redmine base URL (TODO 811). IPC is in `redmine-ipc.ts`; here it is only the settings editor's defaults table. */
  readonly redmineBaseUrl: () => string
  /** Setting "offer new screenshots" (TODO 999). IPC is in `recent/register.ts`; here it is only the settings editor's table. */
  readonly screenshotOffer: () => boolean
  /** Open the changelog after an update (TODO 1186). IPC is in `release-notes-ipc.ts`; here it is only the settings editor's table. */
  readonly releaseNotesAuto: () => boolean
  readonly openAtLogin: () => boolean
  readonly preventSleep: () => boolean
  readonly menuBar: () => boolean
  /** "Show hidden files" (TODO 261). Only the settings editor's table (TODO 1060 stage 3). */
  readonly hiddenFiles: () => boolean
  /** Key bindings (TODO 549). Only the settings editor's table (TODO 1060 stage 3). */
  readonly keybindings: () => SettingValues['keybindings']
  /** Called after a setting value changes (TODO 1060 stage 3: keeps an open settings screen in sync). Omitted = does nothing (tests). */
  readonly onSettingsChanged?: () => void
  /** TODO 1282: the login recovery's phase changed; pushed to every window. Omitted = not pushed (tests). */
  readonly onLoginRecovery?: (state: LoginRecoveryState) => void
  /** TODO 1282: whether any window is open (the wait for a login is cancelled when none is). Omitted = always true. */
  readonly hasWindows?: () => boolean
  /** Saves a conversation as PDF / HTML (TODO 818 / 866). */
  readonly conversationExport: ConversationExporter<BrowserWindow | null>
}

/** The answer (0 hits) of file-name search when the choke point refuses the scope (TODO 437). */
function emptyFileSearch(): FileSearchResult {
  return { entries: [], total: 0, truncated: false, scanTruncated: false, cwd: null, cancelled: false, tookMs: 0 }
}

/** A value of the wrong type is a renderer bug. Returned as a reason code (TODO 572; it used to be a raw English sentence). */
function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw reasonError('invalid-value', { field: label })
  return value
}

/**
 * Normalizes a handler's exception into a form the renderer may see (TODO 572, a miss of item 141).
 * - An exception that is already a reason code (`reasonError`, a bare code) passes through.
 * - `PathDenied` becomes a `path-*` reason code. Previously, words that are not reason codes such as
 *   `excluded` from `threadAllowDir` / `searchBuildScope` showed up verbatim in the band.
 * - Anything else becomes `internal-error` and is logged (the raw sentence is not shown to the renderer).
 */
export function toIpcError(channel: string, err: unknown): Error {
  if (err instanceof PathDenied) return reasonError(pathDenialCode(err.reason))
  const message = err instanceof Error ? err.message : String(err)
  if (parseReason(message) !== null) return err instanceof Error ? err : new Error(message)
  log.error('ipc.handler.failed', { channel, ...errorFields(err) })
  return reasonError('internal-error', internalErrorParams(channel, err))
}

/** Keep only short, identifier-like text (no message, no values): the notice must not carry anything that could hold a secret. */
function tidy(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.:/-]/g, '').slice(0, 48) : ''
}

/**
 * TODO 1281: what the error notice may show about an unexpected failure - which handler (`channel`), the kind of error
 * (`kind` = `Error.name`, `code` = errno-style code) and the time (`at`, ISO, the same clock as the log line's `ts`, so the
 * line is found by time). The message and stack stay in the log.
 */
export function internalErrorParams(channel: string, err: unknown): Record<string, string> {
  const params: Record<string, string> = {
    channel: tidy(channel),
    kind: err instanceof Error ? tidy(err.name) || 'Error' : 'unknown',
    at: new Date().toISOString()
  }
  const code = err instanceof Error ? tidy((err as NodeJS.ErrnoException).code) : ''
  if (code !== '') params.code = code
  return params
}

/** A single wrapper (TODO 572). Individual handlers do not write try / catch. */
export function guarded<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => R
): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => {
    try {
      return await fn(...args)
    } catch (err) {
      throw toIpcError(channel, err)
    }
  }
}

/**
 * Every `ipcMain.handle` in this file goes through `guarded` (TODO 572). Wrapped under the same name so that
 * call sites need not be rewritten one by one - handlers added later are covered too.
 */
const ipcMain = {
  handle(channel: string, listener: Parameters<typeof electronIpcMain.handle>[1]): void {
    electronIpcMain.handle(channel, guarded(channel, listener))
  },
  // Do not call `bind` at load time (tests import this file without replacing electron).
  on(channel: string, listener: Parameters<typeof electronIpcMain.on>[1]): void {
    electronIpcMain.on(channel, listener)
  }
}

/**
 * The body of `aios:fs/list` (an observation of item 333, wave 18). **Never throws** - if it did, the default
 * mechanism of `ipcMain.handle` would print the stack to stderr via `console.error` as uncaught
 * (`Error occurred in handler for 'aios:fs/list': PathDenied: excluded`). That happened every time a thread
 * with a viewer open under an excluded folder (such as the auto memory folder) was displayed. Same judgment
 * as `DirectoryPick.reason` of `fsPickDirectory`: when the choke point (`assertAllowed`) refuses, return the
 * reason as a value (`DirectoryListing.reason`) instead of throwing. The renderer (`expand` / `refresh` in
 * `store.ts`) treats `reason !== null` the same as the former "exception -> catch" (does not use the
 * contents; undoes the expansion / keeps the previous listing). It is split out from the handler so that
 * it can be unit-tested without setting up `ipcMain`.
 */
export function listDirectoryGuarded(
  fs: Pick<FsAccess, 'assertAllowed'>,
  index: Pick<IndexClient, 'listDirectory'>,
  uri: string,
  options: ListDirectoryOptions
): Promise<DirectoryListing> {
  try {
    // Listing is a read (TODO 520): it can also walk into view-only exceptions (the trash). The scope for create / search stays `'write'`.
    fs.assertAllowed(uri, true, 'read')
  } catch (err) {
    log.warn('ipc.fsList.denied', errorFields(err))
    return Promise.resolve({ uri, entries: [], live: true, reason: pathDenialReason(err) })
  }
  // Re-validate the display options (TODO 261) from their types too. `keep` is only used to match names (nothing is read).
  return index.listDirectory(uri, options)
}

/**
 * The body of `aios:fs/createFile` / `aios:fs/createFolder` (TODO 370, wave 20 bundle C). What creates is
 * `createEntry` (choke point, name validation, `O_EXCL | O_NOFOLLOW`). When creation succeeds, **the index
 * process is asked to add it without waiting for the watcher** (`noteCreated`), and the answer is returned
 * after that is reflected - so when the renderer re-fetches the parent's listing on the answer, the new row
 * is always there. Even if the index is busy / down, the creation is not undone (the watcher or the next scan
 * picks it up; the renderer's listing also shows it through the read-on-the-spot path). **Never throws.**
 * Split out from the handler so that it can be unit-tested without setting up `ipcMain`.
 */
export async function createEntryGuarded(
  fs: Pick<FsAccess, 'assertAllowed'>,
  index: Pick<IndexClient, 'noteCreated'>,
  kind: NewEntryKind,
  parentUri: unknown,
  name: unknown
): Promise<CreateEntryResult> {
  const { created, ...result } = createEntry(fs, kind, parentUri, name)
  if (result.uri !== null && created.length > 0) {
    try {
      await index.noteCreated(created.map((path) => pathToUri(path)))
    } catch (err) {
      log.warn('ipc.fsCreate.noteFailed', errorFields(err))
    }
  }
  return result
}

/** Narrows the options of `editor.open` coming from the renderer to the minimal typed shape (item 115). */
function asEditorOpenOptions(value: unknown): { line: number | null; asDirectory: boolean } {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const line = record['line']
  const asDirectory = record['asDirectory']
  return {
    line: typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null,
    asDirectory: asDirectory === true
  }
}

/**
 * Narrows the creation values coming from the renderer to the minimal typed shape (T5 / T12 / T19 / item 99).
 * Boolean fields are copied only when `=== true` (anything non-boolean falls to "unspecified").
 */
function asCreateInput(input: unknown): CreateThreadInput {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >
  const thinking = record['thinking']
  return {
    ...(typeof record['cwdUri'] === 'string' ? { cwdUri: record['cwdUri'] } : {}),
    ...(typeof record['title'] === 'string' ? { title: record['title'] } : {}),
    ...(typeof record['backend'] === 'string' ? { backend: record['backend'] } : {}),
    // null is an explicit "backend default"; omitted means the setting's default (T5).
    ...(typeof record['modelId'] === 'string' || record['modelId'] === null
      ? { modelId: record['modelId'] }
      : {}),
    ...(isThinkingLevel(thinking) || thinking === null ? { thinking } : {}),
    // Strict mode (T12) and no affiliation (T19).
    ...(record['approvalStrict'] === true ? { approvalStrict: true } : {}),
    ...(record['scratch'] === true ? { scratch: true } : {}),
    // Continue from a transcript (item 111). The session id is a string; fork is only a boolean true.
    ...(isTranscriptRequest(record['transcript']) ? { transcript: record['transcript'] } : {}),
    // TODO 972: the role (Teammate) to start under. Only the shape here; SessionManager checks that the role exists.
    ...(typeof record['roleId'] === 'string' && record['roleId'] !== '' && record['roleId'].length <= 200
      ? { roleId: record['roleId'] }
      : {})
  }
}

function isTranscriptRequest(value: unknown): value is { readonly sessionId: string; readonly fork: boolean } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['sessionId'] === 'string' && record['sessionId'] !== '' && typeof record['fork'] === 'boolean'
}

/** Creation values of a Drop (item 98). The Drop decides cwd and the scratch area, so they are discarded even if mixed into the renderer's values. */
function dropCreateInput(input: unknown): Omit<CreateThreadInput, 'cwdUri' | 'scratch'> {
  const { cwdUri: _cwdUri, scratch: _scratch, roleId: _roleId, ...rest } = asCreateInput(input)
  return rest
}

/** Narrows the send content coming from the renderer to the minimal typed shape. */
function asSendInput(value: unknown): SendInput {
  if (typeof value !== 'object' || value === null) throw new Error('input must be an object')
  const record = value as Record<string, unknown>
  const text = typeof record['text'] === 'string' ? record['text'] : ''
  const rawAttachments = Array.isArray(record['attachments']) ? record['attachments'] : []
  const attachments = rawAttachments.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const a = item as Record<string, unknown>
    const kind = a['kind'] === 'image' ? ('image' as const) : ('reference' as const)
    if (typeof a['uri'] !== 'string' || typeof a['name'] !== 'string') return []
    return [
      {
        uri: a['uri'],
        name: a['name'],
        kind,
        mediaType: typeof a['mediaType'] === 'string' ? a['mediaType'] : null,
        bytes: typeof a['bytes'] === 'number' ? a['bytes'] : 0,
        ...(typeof a['base64'] === 'string' ? { base64: a['base64'] } : {}),
        // TODO 550: a reduced version of the timeline after sending. SessionManager (`sentAttachmentsOf`) re-validates its shape.
        ...(typeof a['thumbnail'] === 'string' ? { thumbnail: a['thumbnail'] } : {})
      }
    ]
  })
  // Per-message model / thinking (T7). null is an explicit "backend default";
  // omitted means the thread's default. SessionManager re-validates the values themselves against the list.
  const modelId = record['modelId']
  const thinking = record['thinking']
  const scope = record['settingsScope']
  const selection = asSelection(record['selection'])
  return {
    text,
    attachments,
    ...(typeof modelId === 'string' || modelId === null ? { modelId } : {}),
    ...(isThinkingLevel(thinking) || thinking === null ? { thinking } : {}),
    ...(scope === 'thread' || scope === 'message' ? { settingsScope: scope } : {}),
    ...(selection === null ? {} : { selection }),
    // The `!` of the prompt field (item 116). Copied only when `true`. SessionManager re-checks whether the body is a command.
    ...(record['shell'] === true ? { shell: true } : {})
  }
}

/**
 * Narrows the selection attached to a send (item 97) to its type. If the shape is wrong, **do not attach it**
 * (the send goes through). SessionManager checks again the URI gate, body length and line range (`checkSelection`).
 */
function asSelection(value: unknown): ViewerSelection | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const line = (key: string): number | null | undefined => {
    const raw = record[key]
    if (raw === null || raw === undefined) return null
    return typeof raw === 'number' ? raw : undefined
  }
  const fromLine = line('fromLine')
  const toLine = line('toLine')
  if (typeof record['uri'] !== 'string' || typeof record['text'] !== 'string') return null
  if (fromLine === undefined || toLine === undefined) return null
  return {
    uri: record['uri'],
    text: record['text'],
    fromLine,
    toLine,
    truncated: record['truncated'] === true
  }
}

/**
 * Turns a decision from the renderer into the type. **An unknown shape falls to rejection.**
 *
 * Without the `answer` branch (T31 / 4.2.2) here, answering a multiple-choice question would **arrive as a
 * rejection** - to the person who pressed it, it looks like "I answered but nothing moves". In T31 only the
 * Broker and tests were looked at, and this one place was missed (noticed in T40, and a regression test added).
 */
export function asDecision(value: unknown): ApprovalDecision {
  if (typeof value !== 'object' || value === null) throw new Error('decision must be an object')
  const record = value as Record<string, unknown>
  if (record['kind'] === 'allow') return { kind: 'allow' }
  // There is one rule for the whole app (T40). The breadth (`scope`) no longer exists, so it is ignored if it comes.
  if (record['kind'] === 'allow-always') return { kind: 'allow-always' }
  // "Do not ask about Bash in this conversation from now on" (TODO 994). Whether to accept it is re-decided by the Broker from the reason of the request.
  if (record['kind'] === 'allow-thread') return { kind: 'allow-thread' }
  // "Never ask about this host again" (TODO 1029). The host to add is taken by main from the request (the renderer's value is not accepted).
  if (record['kind'] === 'allow-host') return { kind: 'allow-host' }
  // "Allow this role from now on" (TODO 983). From the renderer only the expiry is accepted (the value was decided by main when it queued).
  // An unknown expiry falls to a one-time allow (never read toward the wider side). Whether to accept it is re-decided by the Broker from the request.
  if (record['kind'] === 'allow-role') {
    return isRoleGrantScope(record['scope']) ? { kind: 'allow-role', scope: record['scope'] } : { kind: 'allow' }
  }
  // "Yes, manually approve edits" of plan approval (item 256). main (the manager) decides whether to put the thread in strict mode.
  if (record['kind'] === 'allow-manual') return { kind: 'allow-manual' }
  if (record['kind'] === 'answer') {
    // The answer to a multiple-choice question (T31 / 4.2.2).
    // **The contents are re-checked by main's Broker against the question**, so here only the shape is tidied (non-strings are dropped).
    const answers: Record<string, string[]> = {}
    const rawAnswers = record['answers']
    if (typeof rawAnswers === 'object' && rawAnswers !== null) {
      for (const [key, value] of Object.entries(rawAnswers as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue
        answers[key] = value.filter((v): v is string => typeof v === 'string')
      }
    }
    const texts: Record<string, string> = {}
    const rawTexts = record['texts']
    if (typeof rawTexts === 'object' && rawTexts !== null) {
      for (const [key, value] of Object.entries(rawTexts as Record<string, unknown>)) {
        if (typeof value === 'string') texts[key] = value
      }
    }
    // TODO 1194: the automatic marker passes only when boolean (the Broker verifies the match). If dropped, "pick the recommendation automatically" does not appear.
    return { kind: 'answer', answers, texts, ...(record['auto'] === true ? { auto: true } : {}) }
  }
  return {
    kind: 'deny',
    ...(typeof record['message'] === 'string' ? { message: record['message'] } : {})
  }
}

/** The approval defaults coming from the settings screen. Accepts only arrays of strings and ignores other keys. */
export function asPolicyPatch(value: unknown): ApprovalPolicyPatch {
  if (typeof value !== 'object' || value === null) throw new Error('policy must be an object')
  const record = value as Record<string, unknown>
  const strings = (raw: unknown): string[] | undefined =>
    Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : undefined
  const tools = strings(record['autoAllowTools'])
  const all = typeof record['autoAllowAll'] === 'boolean' ? record['autoAllowAll'] : undefined
  // TODO 1175: full-delegation mode (boolean only).
  const fullDelegation = typeof record['fullDelegation'] === 'boolean' ? record['fullDelegation'] : undefined
  const patterns = strings(record['bashDenyPatterns'])
  // TODO 1029: hosts that are never asked (whole / add / remove). The manager normalizes. The settings screen sends a diff of adds and removes
  // (so that a stale list from when it was opened does not erase other additions).
  const hosts = strings(record['sshAllowedHosts'])
  const hostsAdd = strings(record['sshAllowedHostsAdd'])
  const hostsRemove = strings(record['sshAllowedHostsRemove'])
  // TODO 1106: the OS sandbox allow tables (whole / add / remove). The manager normalizes (same as the never-asked hosts).
  const sandboxLists = {
    sandboxAllowedDomains: strings(record['sandboxAllowedDomains']),
    sandboxAllowedDomainsAdd: strings(record['sandboxAllowedDomainsAdd']),
    sandboxAllowedDomainsRemove: strings(record['sandboxAllowedDomainsRemove']),
    sandboxAllowWrite: strings(record['sandboxAllowWrite']),
    sandboxAllowWriteAdd: strings(record['sandboxAllowWriteAdd']),
    sandboxAllowWriteRemove: strings(record['sandboxAllowWriteRemove'])
  }
  return {
    ...Object.fromEntries(Object.entries(sandboxLists).filter(([, value]) => value !== undefined)),
    ...(all === undefined ? {} : { autoAllowAll: all }),
    ...(fullDelegation === undefined ? {} : { fullDelegation }),
    ...(tools === undefined ? {} : { autoAllowTools: tools }),
    ...(patterns === undefined ? {} : { bashDenyPatterns: patterns }),
    ...(hosts === undefined ? {} : { sshAllowedHosts: hosts }),
    ...(hostsAdd === undefined ? {} : { sshAllowedHostsAdd: hostsAdd }),
    ...(hostsRemove === undefined ? {} : { sshAllowedHostsRemove: hostsRemove })
  }
}

/** Number of hits when searching a body link by the index's file-name search (TODO 816). */
const LINK_SEARCH_LIMIT = 200

export function registerIpcHandlers(deps: HandlerDeps): void {
  const {
    fs,
    sessions,
    index,
    appInfo,
    plugins,
    viewer,
    audit,
    theme,
    locale,
    git,
    editor,
    editorHandoff,
    editorPreference,
    openRequests,
    notifications,
    autoLogin,
    conversationExport
  } = deps

  ipcMain.handle(IpcChannel.appInfo, () => appInfo)
  // TODO 1281: the renderer asks "where is the log"; main decides the path (nothing comes from the renderer).
  ipcMain.handle(IpcChannel.appLogInfo, (): LogInfo => ({ path: currentLogFilePath(), dir: currentLogDirectory() }))
  // DB breakdown (TODO 846 / 914 / 988): relay only. The index process does the measuring (constraint 8.1).
  ipcMain.handle(IpcChannel.appDbBreakdown, async () => {
    try {
      return await index.measureDatabase()
    } catch (err) {
      log.warn('app.dbBreakdown.failed', errorFields(err))
      return null
    }
  })

  // BottomBar git information (5.6). The reader validates both type and URI, and every failure becomes null (never throws).
  ipcMain.handle(IpcChannel.gitStatus, (_event, cwdUri: unknown) => git.read(cwdUri))

  // Open in an external editor (item 115). The setting is one key only; the open path re-validates the URI first.
  ipcMain.handle(IpcChannel.editorGet, () => editorPreference.get())
  ipcMain.handle(IpcChannel.editorSet, (_event, id: unknown) => {
    if (!isEditorId(id)) return editorPreference.get()
    const saved = editorPreference.set(id)
    deps.onSettingsChanged?.()
    return saved
  })
  ipcMain.handle(IpcChannel.editorOpen, (_event, uri: unknown, options: unknown) =>
    editor.open(uri, asEditorOpenOptions(options))
  )
  // "Open in external editor" on the band for a link that could not be opened (TODO 808). Files only, no line. The choke point is `'handoff'`
  // (it only hands an excluded location outside), so it just opens with the chosen editor - even if the extension is in the table it is not sent
  // to the OS default app (code-review of TODO 1214).
  ipcMain.handle(IpcChannel.editorOpenHandoff, (_event, uri: unknown) => editorHandoff.open(uri))
  // TODO 1214: the host's "Open in default app" (one-button dispatch, right-click). The choke point is the same `'write'` as `editor.open`
  // (fixed inside `openInDefaultAppForHost`); main re-validates the table (`HOST_OPEN_DEFAULT_EXTENSIONS`) against the URI and the real file.
  // If it cannot open, fall back to the chosen editor.
  ipcMain.handle(IpcChannel.editorOpenInDefaultApp, (_event, uri: unknown) =>
    openInDefaultAppForHost(
      {
        assertAllowed: (target, isDirectory, access) => fs.assertAllowed(target, isDirectory, access),
        open: (path) => shell.openPath(path),
        openEditor: (value) => editor.open(value)
      },
      uri
    )
  )

  // Reveal in Finder (TODO 289). The URI goes through the choke point (`assertAllowed`) and then `shell.showItemInFolder`.
  // It neither reads nor writes the contents, so it uses the read choke point (TODO 520: also reveals from a view-only trash row).
  // TODO 808: even if the read is refused, the hand-off-only choke point (`'handoff'`, which lets exclusions other than credentials through) lets it reveal
  // ("Reveal in Finder" on the band for a link that could not be opened).
  ipcMain.handle(IpcChannel.revealInFolder, (_event, uri: unknown, asDirectory: unknown) =>
    revealInFolder(
      {
        assertAllowed: withHandoffFallback((value, isDirectory, kind) => fs.assertAllowed(value, isDirectory, kind), 'read'),
        show: (path) => shell.showItemInFolder(path)
      },
      uri,
      asDirectory === true
    )
  )
  // The log folder (TODO 376). The path is main's own, so no choke point is needed. Selects and reveals the current file.
  ipcMain.handle(IpcChannel.revealLogs, () =>
    revealLogFile({ path: currentLogFilePath(), show: (path) => shell.showItemInFolder(path) })
  )
  // Open with the OS default app (TODO 405, `.avi` of `aios.video`). The URI goes through the choke point and then `shell.openPath`.
  ipcMain.handle(IpcChannel.editorOpenDefault, (_event, uri: unknown, pluginId: unknown) =>
    openWithDefaultApp(
      {
        assertAllowed: (value, isDirectory) => fs.assertAllowed(value, isDirectory),
        open: (path) => shell.openPath(path),
        isBundledPlugin: (id) => plugins.isBundled(id),
        audit: (entry) => audit.record(entry)
      },
      uri,
      pluginId
    )
  )

  // Desktop notifications ON/OFF (item 72). The preference itself validates the value (non-booleans go to the default).
  ipcMain.handle(IpcChannel.notifyGet, () => notifications.get())
  ipcMain.handle(IpcChannel.notifySet, (_event, enabled: unknown) => {
    const saved = notifications.set(enabled === true)
    deps.onSettingsChanged?.()
    return saved
  })

  // The latest report of the MCP servers on the global side (item 164). Only reads the saved copy; no process is started.
  ipcMain.handle(IpcChannel.mcpReport, () => sessions.mcpReport())

  // List and delete skills (TODO 773). Only the adapter knows where they live. The body files are only those that passed the read choke point;
  // the name for deletion comes from the renderer, so main validates it again (`checkSkillDelete`).
  const skillDeps = {
    canRead: (path: string): boolean => {
      try {
        fs.assertAllowed(pathToUri(path), false, 'read')
        return true
      } catch {
        return false
      }
    }
  }
  ipcMain.handle(IpcChannel.skillsList, (_event, cwdUri: unknown) =>
    listSkills(cwdPathOf(typeof cwdUri === 'string' ? cwdUri : null), skillDeps)
  )
  ipcMain.handle(IpcChannel.skillsTrash, (_event, request: unknown) => {
    const record = (request ?? {}) as Record<string, unknown>
    return deleteSkill(
      {
        // Do not trust the type: anything other than 'user' / 'project' (a plugin, etc.) is refused by `checkSkillDelete` with 'invalid'.
        scope: record['scope'] as SkillDeleteRequest['scope'],
        dirName: typeof record['dirName'] === 'string' ? record['dirName'] : '',
        cwdUri: typeof record['cwdUri'] === 'string' ? record['cwdUri'] : null
      },
      skillDeps,
      (path) => shell.trashItem(path)
    )
  })

  // Open in an external browser (5.1). Even if the renderer has already dispatched it, **it is re-validated here**.
  // Even the type is not trusted, so it is passed as unknown without going through asString (refusals are logged).
  ipcMain.handle(IpcChannel.appOpenExternal, (_event, url: unknown) => {
    return openExternalChecked(url, (target) => shell.openExternal(target), 'ipc')
  })

  // TODO 967: fixed entries of the system settings. The URL is not taken from the renderer; it is looked up from `kind` in main's table.
  ipcMain.handle(IpcChannel.appOpenSystemSettings, (_event, kind: unknown) =>
    openSystemSettings(kind, (target) => shell.openExternal(target))
  )
  // TODO 967: restart (the screen recording permission takes effect only after a restart). If a conversation is running, ask first.
  // The confirmation while a conversation runs is shown exactly once by the choke point of `deps.relaunch` (main's `settleDraftsForRestart`) (TODO 1004).
  ipcMain.handle(IpcChannel.appRelaunch, (): Promise<boolean> => {
    return deps.relaunch()
  })

  ipcMain.handle(IpcChannel.fsRoots, () => fs.roots())

  /**
   * The working folder used as the basis of search (item 100). It is a URI from the renderer, so it goes through
   * main's choke point (`assertAllowed`) first. **If it does not pass, undefined** (= the cwd section is not shown) -
   * a cwd that hits an exclusion or a broken value must not make the search itself fail. The index process re-checks too.
   */
  const allowedCwd = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value === '') return undefined
    try {
      fs.assertAllowed(value, true)
      return value
    } catch {
      return undefined
    }
  }

  /**
   * The scope of the Search screen (TODO 437). Like cwd it is a URI from the renderer, so it goes through main's choke point first.
   * **Unlike cwd, if it does not pass, `'denied'`** - the scope is a narrowing the user asked for explicitly, so dropping it and
   * returning everything would make the badge and the results disagree. The caller returns 0 hits. undefined if there is no value (no scope).
   */
  const allowedScope = (value: unknown): string | 'denied' | undefined => {
    if (typeof value !== 'string' || value === '') return undefined
    try {
      fs.assertAllowed(value, true)
      return value
    } catch {
      return 'denied'
    }
  }

  // Listing and file-name search are inside the index process (P1). **One round trip slower, but a few ms**,
  // and in exchange main's JS thread no longer stops on synchronous SQLite calls.
  ipcMain.handle(IpcChannel.fsList, (_event, uri: unknown, options: unknown) => {
    // URI validation goes through main's choke point first (12.3). The index process re-checks too.
    const uriValue = asString(uri, 'uri')
    // The sort order (TODO 872) is owned by main's setting. A value the renderer attached is not used.
    return listDirectoryGuarded(fs, index, uriValue, {
      ...asListDirectoryOptions(options),
      sortOrder: deps.fileSortOrder()
    })
  })

  ipcMain.handle(
    IpcChannel.fsSearch,
    (_event, query: unknown, limit: unknown, cwdUri: unknown, scopeUri: unknown) => {
      const max = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : undefined
      const scope = allowedScope(scopeUri)
      if (scope === 'denied') return emptyFileSearch()
      return index.searchFiles(asString(query, 'query'), max, allowedCwd(cwdUri), scope)
    }
  )

  // "New file / folder" in the Files tree (TODO 370). Every value is re-validated in main.
  ipcMain.handle(IpcChannel.fsCreateFile, (_event, parentUri: unknown, name: unknown) =>
    createEntryGuarded(fs, index, 'file', parentUri, name)
  )
  ipcMain.handle(IpcChannel.fsCreateFolder, (_event, parentUri: unknown, name: unknown) =>
    createEntryGuarded(fs, index, 'folder', parentUri, name)
  )

  // Icon of a `.app` in the Files tree (TODO 562 / 871). Take 32 px and draw at 16 px (no blur on Retina).
  // `AppIconCache` re-validates the name, choke point and existence. Never throws (null if it cannot be obtained).
  // **Do not use `app.getFileIcon`** (TODO 871): on the real thing it returned only the generic app icon for the extension, even for bundles
  // with their own icns. QuickLook's `createThumbnailFromPath` returns the bundle's own icon, same as Finder.
  const appIcons = new AppIconCache(fs, async (path) => {
    const image = await nativeImage.createThumbnailFromPath(path, { width: 32, height: 32 })
    return image.isEmpty() ? null : image.toDataURL()
  })
  // Renaming a row in the Files tree (TODO 1145). Only within the same parent. Every value is re-validated in main. The index follows through the watcher.
  ipcMain.handle(
    IpcChannel.fsRename,
    (_event, uri: unknown, name: unknown): RenameEntryResult => {
      const result = renameEntry(fs, uri, name)
      // Re-point the old URIs in the saved viewer history (772) (TODO 1149). Only on success, with the normalized URI.
      if (result.uri !== null && typeof uri === 'string') {
        try {
          const from = pathToUri(uriToPath(uri))
          // If the name is the same (no-op), do not read the history of all conversations.
          if (from !== result.uri) sessions.noteFileRenamed(from, result.uri)
        } catch (err) {
          log.warn('fs.rename.history_failed', errorFields(err))
        }
      }
      return result
    }
  )
  ipcMain.handle(IpcChannel.fsAppIcon, (_event, uri: unknown) => appIcons.iconFor(uri))

  // Native drag from the Files tree to an outside app (TODO 677). Never throws; does not wait for a reply.
  // `ipcMain.on` does not go through this file's `guarded` (TODO 572), so `startFilesDragGuarded`
  // (`fs/drag.ts`) does its own try / catch (a code-review fix).
  ipcMain.on(IpcChannel.fsStartDrag, (event, uris: unknown) => {
    startFilesDragGuarded(event.sender, uris, { gate: fs })
  })

  ipcMain.handle(IpcChannel.fsStat, (_event, uri: unknown) => {
    try {
      return fs.stat(asString(uri, 'uri'))
    } catch (err) {
      log.warn('ipc.stat.rejected', errorFields(err))
      return null
    }
  })

  // Open a body link (item 254). Candidates are built in the order: base (folder of the open .md / the thread's cwd) -> auto memory,
  // and checked against the choke point (`assertAllowed`, read) and existence. Value validation is also inside, in a non-throwing form.
  ipcMain.handle(IpcChannel.fsResolveLink, (_event, input: unknown) =>
    resolveLinkWithSearch(input, {
      gate: fs,
      home: fs.homePath,
      threadContext: (threadId) => sessions.linkContext(threadId),
      // TODO 816: a relative link that could not be resolved at cwd or the shell's `cd` target is searched with the index's file-name search (index process, P1).
      // A separate path (`fs.searchFilesForLink`) from the user's search (Cmd+P / Sidebar): it does not cancel a search in the middle of typing and is not cancelled by it
      // (a code-review fix). `cancelled` happens only during shutdown and is treated as 0 hits.
      searchByName: async (query) => {
        const result = await index.searchFilesForLink(query, LINK_SEARCH_LIMIT)
        if (result.cancelled) return []
        return result.entries.filter((entry) => !entry.isDirectory).map((entry) => uriToPath(entry.uri))
      }
    })
  )

  // Files dropped onto the viewer (TODO 366). Pass each one through the choke point (`assertAllowed`, read) and return refusals
  // as reason codes. The files are not opened. Value validation is inside, in a non-throwing form.
  ipcMain.handle(IpcChannel.dropCheckLinks, (_event, uris: unknown) => {
    const result = checkDropLinks(uris, { gate: fs })
    // Path log (TODO 407). Counts only (no paths are written).
    log.info('viewer.drop.check', {
      requested: Array.isArray(uris) ? uris.length : 0,
      allowed: result.allowed.length,
      denied: result.denied.length
    })
    return result
  })
  // Log of the viewer's Drop path (TODO 407). The renderer's values are re-validated, and only the counts and the yes/no go into one line.
  ipcMain.on(IpcChannel.dropTrace, (_event, input: unknown) => {
    const trace = sanitizeDropTrace(input)
    if (trace === null) return
    const { stage, ...fields } = trace
    // The attachment stage in the conversation pane (TODO 489) is `drop.pane-*`; the viewer stage is `viewer.drop.*`.
    log.info(dropTraceEventName(stage), fields)
  })

  // The scan state returns **the last notification received** as is (no RPC round trip).
  ipcMain.handle(IpcChannel.fsScanStatus, () => index.getScanStatus())
  ipcMain.handle(IpcChannel.fsRescan, async () => {
    await index.rescan()
  })
  // TODO 805: "Include now" in settings. The index process starts the scan; it is not waited for.
  ipcMain.handle(IpcChannel.fsIncludeProtectedFolders, async () => {
    await index.releaseTccDeferral()
  })

  // External storage (4.4.2 "External storage"). The index process re-validates the URI shape and the mount state.
  ipcMain.handle(IpcChannel.fsVolumes, () => index.listVolumes())
  ipcMain.handle(IpcChannel.fsSetVolumeAllowed, async (_event, uri: unknown, allowed: unknown) => {
    return index.setVolumeAllowed(asString(uri, 'uri'), allowed === true)
  })

  // "Choose another folder..." (T5). main opens the dialog (the renderer is not shown the path).
  // The chosen one also goes through FsService's choke point; if it is excluded, a reason is returned and it cannot be chosen.
  // title / message are the OS's native UI, so the renderer's dictionary does not reach them. They are looked up in main's small table
  // (`i18n-native.ts`) by the display language at the moment of opening (TODO 66).
  // The attach button (paperclip, item 161). A sheet attached to the window lets the user choose several, and only returns URIs.
  // Validation is left to the same path as Drop (`threads.resolveAttachment` -> `assertAllowed`) - if excluded items were silently dropped here,
  // the reason band that Drop shows would not appear. The wording is the OS default (title / buttonLabel are not passed),
  // so there is nothing to add to the native UI table (`i18n-native.ts`).
  ipcMain.handle(IpcChannel.attachmentsPick, async (event): Promise<readonly string[]> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openFile' as const, 'multiSelections' as const] }
    const result =
      owner === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(owner, options)
    if (result.canceled) return []
    return result.filePaths.map((path) => pathToUri(path))
  })

  ipcMain.handle(IpcChannel.fsPickDirectory, async (event): Promise<DirectoryPick> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: nativeText(locale.locale, 'dialog.pickDirectory.title'),
      message: nativeText(locale.locale, 'dialog.pickDirectory.message'),
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const result =
      owner === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(owner, options)
    const picked = result.filePaths[0]
    if (result.canceled || picked === undefined) return { uri: null, reason: null }
    const uri = pathToUri(picked)
    try {
      fs.assertAllowed(uri, true)
    } catch (err) {
      log.warn('ipc.pickDirectory.rejected', errorFields(err))
      return { uri: null, reason: pathDenialReason(err) }
    }
    return { uri, reason: null }
  })

  // ---- Threads (4.3) ----

  ipcMain.handle(IpcChannel.threadList, () => sessions.listSummaries())

  ipcMain.handle(IpcChannel.threadCreate, (_event, input: unknown) => {
    const create = asCreateInput(input)
    // cwd goes through FsService's choke point (rejects outside the scan roots and excluded paths). main decides the scratch area
    // itself, so only a cwd the user chose arrives here. The title length (120 characters, same as rename) is
    // truncated by SessionManager.createThread (item 86).
    // An exception from `assertAllowed` is converted by `guarded` into a reason code (item 141) (TODO 572).
    if (create.cwdUri !== undefined) fs.assertAllowed(create.cwdUri, true)
    // The values of backend / modelId themselves are re-validated by SessionManager against the registry and the list.
    return sessions.createThread(create)
  })

  // Folder Drop (item 98 (a) (b)). Folder detection, re-parenting, count checks and the choke point are all in
  // one place, `createThreadFromDrop`; the Dock (`open-file`) goes through the same function.
  ipcMain.handle(IpcChannel.threadCreateFromDrop, (_event, uris: unknown, input: unknown) => {
    if (!Array.isArray(uris) || !uris.every((uri) => typeof uri === 'string')) {
      throw reasonError('invalid-value', { field: 'uris' })
    }
    return createThreadFromDrop(uris as string[], dropCreateInput(input), {
      assertAllowed: (uri, asDirectory) => fs.assertAllowed(uri, asDirectory),
      kindOf: kindOfPath,
      create: (create) => sessions.createThread(create)
    })
  })

  ipcMain.handle(IpcChannel.threadTakeOpenRequest, (event) => openRequests.take(event.sender.id))

  // ---- Create dialog (T5) ----

  ipcMain.handle(IpcChannel.threadCreateOptions, () => sessions.createOptions())

  // A light entry point for the Composer (item 88). Does no `stat` of the cwd history.
  ipcMain.handle(IpcChannel.threadBackends, () => sessions.backends())

  // Item 123: the choke point (`assertAllowed`) is applied inside main.
  ipcMain.handle(IpcChannel.threadFolderNotice, (_event, cwdUri: unknown) => {
    return sessions.folderNotice(asString(cwdUri, 'cwdUri'))
  })

  // Item 239: the choke point is applied inside main's `folderMatchKey`.
  ipcMain.handle(IpcChannel.threadFolderMatchKey, (_event, cwdUri: unknown) => {
    return sessions.folderMatchKey(asString(cwdUri, 'cwdUri'))
  })

  ipcMain.handle(IpcChannel.cwdHistoryRemove, (_event, uri: unknown) => {
    sessions.removeCwdHistory(asString(uri, 'uri'))
  })

  ipcMain.handle(IpcChannel.cwdHistoryClear, () => {
    sessions.clearCwdHistory()
  })

  ipcMain.handle(IpcChannel.threadOpen, (event, threadId: unknown) => {
    // Remember what is displayed per sender window (`webContents.id`) (TODO 71, used to decide unread).
    sessions.openThread(asString(threadId, 'threadId'), event.sender.id)
  })

  // TODO 526: per window, "threads whose Composer has a draft". Values are narrowed by looking only at the types (the shape of item 86).
  // It is material that **stops** deletion, so even a fake id deletes nothing.
  ipcMain.handle(IpcChannel.threadReportComposerDrafts, (event, threadIds: unknown) => {
    sessions.reportComposerDrafts(event.sender.id, asThreadIdList(threadIds))
  })

  ipcMain.handle(IpcChannel.threadTimeline, (_event, threadId: unknown) => {
    return sessions.timeline(asString(threadId, 'threadId'))
  })

  // "Read more" (item 88). `before` is the `oldestSeq` received in the previous page (an integer; 0 or below is a
  // position in the transcript's past - item 111). The manager rounds the count limit to one page (the renderer's value is not
  // passed straight to SQL).
  ipcMain.handle(
    IpcChannel.threadTimelineBefore,
    (_event, threadId: unknown, before: unknown, limit: unknown) => {
      if (typeof before !== 'number' || !Number.isSafeInteger(before)) {
        throw new Error('before must be an integer')
      }
      const max = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : undefined
      return sessions.timelineBefore(asString(threadId, 'threadId'), before, max)
    }
  )

  ipcMain.handle(IpcChannel.threadSend, (_event, threadId: unknown, input: unknown) =>
    sessions.send(asString(threadId, 'threadId'), asSendInput(input), 'human')
  )

  // Interrupt and queued messages (item 94). Value validation is only `typeof`, like the other entry points (the shape of item 86).
  // The id of a queued message is a UUID assigned by main, so main silently ignores an unknown id.
  ipcMain.handle(IpcChannel.threadSendInterrupt, (_event, threadId: unknown, input: unknown) =>
    sessions.sendInterrupt(asString(threadId, 'threadId'), asSendInput(input), 'human')
  )
  // TODO 893: "Send again" on the authentication-expired badge. The content is main's in-memory last input (not received from the renderer).
  // TODO 1289: a person pressed it, so the turn counts as attended (decided here by the entry point, not by a value the renderer sends).
  ipcMain.handle(IpcChannel.threadResendLast, (_event, threadId: unknown) =>
    sessions.resendLast(asString(threadId, 'threadId'), 'human')
  )

  // TODO 908: "Open in terminal" on the authentication-expired badge. main decides the cwd and the CLI name from the conversation (the renderer sends only the id).
  ipcMain.handle(IpcChannel.threadOpenInTerminal, (_event, threadId: unknown) =>
    openTerminalWithCli(
      { assertAllowed: withHandoffFallback((value, isDirectory, kind) => fs.assertAllowed(value, isDirectory, kind), 'read') },
      sessions.terminalTarget(asString(threadId, 'threadId'))
    )
  )

  ipcMain.handle(
    IpcChannel.threadCancelReservation,
    (_event, threadId: unknown, reservationId: unknown) =>
      sessions.cancelReservation(asString(threadId, 'threadId'), asString(reservationId, 'reservationId'))
  )

  ipcMain.handle(
    IpcChannel.threadTakeReservation,
    (_event, threadId: unknown, reservationId: unknown) =>
      sessions.takeReservation(asString(threadId, 'threadId'), asString(reservationId, 'reservationId'))
  )

  ipcMain.handle(IpcChannel.threadInterrupt, async (_event, threadId: unknown) => {
    await sessions.interrupt(asString(threadId, 'threadId'))
  })

  ipcMain.handle(IpcChannel.threadStop, async (_event, threadId: unknown) => {
    await sessions.stopThread(asString(threadId, 'threadId'))
  })

  ipcMain.handle(IpcChannel.threadRename, (_event, threadId: unknown, title: unknown) => {
    sessions.rename(asString(threadId, 'threadId'), asString(title, 'title'))
  })

  ipcMain.handle(IpcChannel.threadSetUnread, (_event, threadId: unknown, unread: unknown) => {
    sessions.setThreadUnread(asString(threadId, 'threadId'), unread === true)
  })

  ipcMain.handle(IpcChannel.threadDelete, (_event, threadId: unknown, options: unknown) => {
    // `force` accepts only a boolean true (T19: the second call when the scratch area has contents).
    const force =
      typeof options === 'object' && options !== null && (options as Record<string, unknown>)['force'] === true
    return sessions.remove(asString(threadId, 'threadId'), { force })
  })

  // ---- Restoring deleted threads (item 191) ----
  ipcMain.handle(IpcChannel.threadListDeleted, () => sessions.listDeletedThreads())
  ipcMain.handle(IpcChannel.threadRestore, (_event, threadId: unknown) => {
    return sessions.restore(asString(threadId, 'threadId'))
  })
  // TODO 1155: where a `thread://` link points. SessionManager re-validates the shape of the id (item 86).
  ipcMain.handle(IpcChannel.threadLocateLink, (_event, threadId: unknown, eventId: unknown) =>
    sessions.locateThreadLink(threadId, eventId ?? null)
  )

  ipcMain.handle(
    IpcChannel.threadSetRetention,
    (_event, threadId: unknown, retention: unknown, days: unknown) => {
      const value = asString(retention, 'retention')
      if (value !== 'none' && value !== 'days' && value !== 'forever') {
        throw new Error('unknown retention')
      }
      // The range (an integer of 1 or more) is closed by SessionManager (item 86). Truncating here could turn
      // 0.5 into 0 and let it through, so if it is a number it is passed as is.
      const n = typeof days === 'number' ? days : null
      sessions.setRetention(asString(threadId, 'threadId'), value as ThreadRetention, n)
    }
  )

  ipcMain.handle(IpcChannel.threadClearLog, (_event, threadId: unknown) => {
    sessions.clearLog(asString(threadId, 'threadId'))
  })

  ipcMain.handle(IpcChannel.threadClearAllLogs, () => {
    sessions.clearAllLogs()
  })

  ipcMain.handle(
    IpcChannel.threadResolveAttachment,
    async (_event, threadId: unknown, uri: unknown) => {
      return sessions.resolveAttachment(asString(threadId, 'threadId'), asString(uri, 'uri'))
    }
  )

  // TODO 550: thumbnail of a sent image. The check (image extension, exclusion, realpath) is done twice: when the Broker builds the URL and
  // on every delivery. If refused, null (the renderer shows only the name).
  ipcMain.handle(IpcChannel.threadAttachmentImage, (_event, uri: unknown): string | null =>
    viewer.hostImageUrl(asString(uri, 'uri'))
  )

  // TODO 876: a local image in an answer's Markdown. `src` is resolved by the same path as body links (`resolveLinkRequest`: the conversation's
  // working folder -> choke point `assertAllowed` (read) -> existence), and folders are refused. The URL is produced by the Broker after checking the extension, exclusion and
  // realpath, and `timelineImageUrl` checks the leading magic bytes. null if refused.
  ipcMain.handle(
    IpcChannel.threadTimelineImage,
    (_event, threadId: unknown, src: unknown): string | null => {
      if (typeof src !== 'string') return null
      const resolved = resolveLinkRequest(
        { href: src, threadId: asString(threadId, 'threadId'), baseUri: null },
        {
          gate: fs,
          home: fs.homePath,
          threadContext: (id) => sessions.linkContext(id)
        }
      )
      if (!resolved.ok || resolved.directory === true) return null
      return viewer.timelineImageUrl(resolved.uri)
    }
  )

  // TODO 818: save a conversation as PDF. main reads the whole body, applies redaction and hands it over, and main turns the printing HTML
  // built by the renderer into a PDF in a window it has locked down (`export/conversation-pdf.ts`). The range and the HTML are checked for shape only.
  ipcMain.handle(IpcChannel.threadExportTurns, (_event, threadId: unknown) =>
    sessions.exportTurns(asString(threadId, 'threadId'))
  )
  // TODO 866: a single-file HTML has the same entry shape (main embeds images, `export/embed-images.ts`).
  for (const [channel, format] of [
    [IpcChannel.threadSavePdf, 'pdf'],
    [IpcChannel.threadSaveHtml, 'html'],
    // TODO 1014: Markdown has the same entry point (it does not go through HTML; redaction is re-applied inside `save`).
    [IpcChannel.threadSaveMarkdown, 'md']
  ] as const) {
    ipcMain.handle(channel, (event, threadId: unknown, scope: unknown, html: unknown) => {
      const parsed = asExportScope(scope)
      if (parsed === null) throw reasonError('invalid-value', { field: 'scope' })
      return conversationExport.save(
        asString(threadId, 'threadId'),
        parsed,
        asString(html, 'html'),
        BrowserWindow.fromWebContents(event.sender),
        format
      )
    })
  }

  ipcMain.handle(IpcChannel.threadAllowDir, (_event, threadId: unknown, dirUri: unknown) => {
    const uri = asString(dirUri, 'dirUri')
    // Adding to the reference scope = widening what can be read without approval. It must go through FsService's choke point.
    fs.assertAllowed(uri, true)
    const thread = sessions.allowDir(asString(threadId, 'threadId'), uri)
    // Adding (the inside of) a protected folder to the reference scope = the user explicitly included it. End the deferral (TODO 805;
    // outside a protected folder the index process does nothing). Not waited for.
    void index.releaseTccDeferral(uri).catch(() => {})
    return thread
  })

  ipcMain.handle(
    IpcChannel.threadToolResult,
    async (_event, threadId: unknown, toolUseId: unknown) => {
      return sessions.readToolResult(asString(threadId, 'threadId'), asString(toolUseId, 'toolUseId'))
    }
  )

  // ---- Cross search (6.1) ----

  // Query numbers (P6) are compared per window (TODO 497). The window is the webContents id; the books are dropped when it is closed / reloaded.
  const searchOrigins = new SearchOrigins((origin) => index.forgetSearchOrigin(origin))

  ipcMain.handle(
    IpcChannel.searchQuery,
    async (
      event,
      query: unknown,
      scope: unknown,
      limit: unknown,
      seq: unknown,
      cwdUri: unknown,
      scopeUri: unknown
    ) => {
      const max = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : undefined
      const value: SearchScope = scope === 'conversation' ? 'conversation' : 'files'
      // Query number (P6). It is a value from the renderer, so main re-checks it.
      const order = typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : undefined
      // The scope (TODO 437) also applies only to in-file search. If refused, 0 hits (the scope is not dropped to return everything).
      const range = value === 'files' ? allowedScope(scopeUri) : undefined
      if (range === 'denied') return { hits: [], total: 0, truncated: false, tookMs: 0 }
      // The cwd section of conversation search (TODO 1096): the index does not hold a thread's cwd, so main looks up, in the thread table,
      // the ids of "threads whose cwd is (under) this working folder" and passes them (remembered per cwd). The index's SQL
      // runs only in the index process (constraint 8.1). cwd reads no files, so exclusion rules are not applied and only the URI shape is checked (review).
      const conversationCwd = value === 'conversation' ? conversationCwdPathOf(cwdUri) : null
      let cwd: string | undefined
      let threadIds: readonly string[] | undefined
      if (value === 'conversation') {
        if (conversationCwd !== null && typeof cwdUri === 'string') {
          cwd = cwdUri
          threadIds = sessions.threadIdsUnderCwd(conversationCwd)
        }
      } else if (range === undefined) {
        // The cwd section (item 100). Not used if there is a scope. If the choke point refuses, the section is not shown (the search continues).
        cwd = allowedCwd(cwdUri)
      }
      return index.search(asString(query, 'query'), value, {
        ...(max === undefined ? {} : { limit: max }),
        ...(order === undefined ? {} : { seq: order, origin: searchOrigins.of(event.sender) }),
        ...(cwd === undefined ? {} : { cwdUri: cwd }),
        ...(threadIds === undefined ? {} : { threadIds }),
        ...(range === undefined ? {} : { scopeUri: range })
      })
    }
  )
  // In-thread search (TODO 496). The renderer's values are checked for type only (a thread id is a prefix-match string for the index, not a path).
  ipcMain.handle(IpcChannel.searchThread, (event, query: unknown, threadId: unknown, seq: unknown) => {
    const order = typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : undefined
    return index.searchThread(asString(query, 'query'), asString(threadId, 'threadId'), {
      ...(order === undefined ? {} : { seq: order, origin: searchOrigins.of(event.sender) })
    })
  })
  // Builds at the moment the scope (TODO 437) is decided. **If the choke point refuses, it throws** (the renderer shows no badge).
  ipcMain.handle(IpcChannel.searchBuildScope, (_event, uri: unknown) => {
    const value = asString(uri, 'uri')
    fs.assertAllowed(value, true)
    return index.buildScope(value)
  })
  ipcMain.handle(IpcChannel.searchStatus, () => index.getStatus())
  ipcMain.handle(IpcChannel.searchPause, async () => {
    await index.pause()
  })
  ipcMain.handle(IpcChannel.searchResume, async () => {
    // The "Resume" the user pressed is treated the same as a manual rescan - it skips the idle check (P4).
    await index.resume({ manual: true })
  })

  // ---- Approval inbox (4.2) ----

  ipcMain.handle(IpcChannel.approvalList, () => sessions.listApprovals())
  ipcMain.handle(IpcChannel.approvalDecide, (_event, id: unknown, decision: unknown) => {
    sessions.decideApproval(asString(id, 'id'), asDecision(decision))
  })
  // The diff on the approval frame (item 97 / 7.6.4). Only the request id is accepted (main looks up the path from the request).
  ipcMain.handle(IpcChannel.approvalDiff, (_event, id: unknown) =>
    sessions.approvalDiff(asString(id, 'id'))
  )
  // Rules and defaults (T12 / 4.2).
  ipcMain.handle(IpcChannel.approvalRules, () => sessions.listApprovalRules())
  ipcMain.handle(IpcChannel.approvalRuleRemove, (_event, id: unknown) => {
    sessions.removeApprovalRule(asString(id, 'id'))
  })
  // TODO 983 stage 2: the table of what was allowed to scheduled jobs. The manager in main re-validates the key shape and the id.
  ipcMain.handle(IpcChannel.approvalRoleGrants, (_event, roleKey: unknown) => sessions.listRoleGrants(asString(roleKey, 'roleKey')))
  ipcMain.handle(IpcChannel.approvalRoleGrantRemove, (_event, roleKey: unknown, id: unknown) =>
    sessions.removeRoleGrant(asString(roleKey, 'roleKey'), asString(id, 'id'))
  )
  ipcMain.handle(IpcChannel.approvalPolicyGet, () => sessions.getApprovalPolicy())
  ipcMain.handle(IpcChannel.approvalPolicySet, (_event, patch: unknown) => {
    const next = sessions.setApprovalPolicy(asPolicyPatch(patch))
    deps.onSettingsChanged?.()
    return next
  })
  ipcMain.handle(
    IpcChannel.threadSetApprovalStrict,
    (_event, threadId: unknown, strict: unknown) => {
      sessions.setApprovalStrict(asString(threadId, 'threadId'), strict === true)
    }
  )
  // OS sandbox (TODO 1106 / 4.2.4). Anything non-boolean falls to OFF (whether it can be turned ON is checked by the manager in the feature table).
  ipcMain.handle(IpcChannel.threadSetOsSandbox, (_event, threadId: unknown, on: unknown) => {
    sessions.setOsSandbox(asString(threadId, 'threadId'), on === true)
  })
  // Automatic selection of a question's recommendation (TODO 1222 / 4.2.2). Anything non-boolean falls to OFF.
  ipcMain.handle(IpcChannel.threadSetAutoPick, (_event, threadId: unknown, on: unknown) => {
    sessions.setAutoPickRecommended(asString(threadId, 'threadId'), on === true)
  })
  // Plan mode (item 112 / 4.2.3). Anything non-boolean falls to OFF.
  ipcMain.handle(IpcChannel.threadSetPlanMode, (_event, threadId: unknown, on: unknown) => {
    sessions.setPlanMode(asString(threadId, 'threadId'), on === true)
  })
  ipcMain.handle(
    IpcChannel.threadSetViewerState,
    (_event, threadId: unknown, uri: unknown, highlight: unknown) => {
      sessions.setViewerState(
        asString(threadId, 'threadId'),
        uri === null ? null : asString(uri, 'uri'),
        typeof highlight === 'string' ? highlight : null
      )
    }
  )
  // The viewer's back / forward history (TODO 772). Validation of each step is left to `ViewerHistoryService` (main); here only the type of the id.
  ipcMain.handle(IpcChannel.threadViewerHistory, (_event, threadId: unknown) =>
    sessions.viewerHistory(asString(threadId, 'threadId'))
  )
  ipcMain.handle(IpcChannel.threadSetViewerHistory, (_event, threadId: unknown, snapshot: unknown) => {
    sessions.setViewerHistory(asString(threadId, 'threadId'), snapshot)
  })

  // "Rewind to here" (item 113, 4.5.6). The id is a UUID assigned by main, so only `typeof` (the shape of item 86).
  // `files` accepts only a boolean true (the call after the preview was acknowledged).
  ipcMain.handle(IpcChannel.threadRewindPreview, (_event, threadId: unknown, eventId: unknown) =>
    sessions.rewindPreview(asString(threadId, 'threadId'), asString(eventId, 'eventId'))
  )
  // Breakdown of context usage (item 155). The id is only `typeof` (the shape of item 86); main refuses a thread that does not exist.
  ipcMain.handle(IpcChannel.threadContextBreakdown, (_event, threadId: unknown) =>
    sessions.contextBreakdown(asString(threadId, 'threadId'))
  )
  // TODO 961: lighten and continue in a new conversation.
  ipcMain.handle(IpcChannel.threadHandoffEstimate, (_event, threadId: unknown) =>
    sessions.handoffEstimate(asString(threadId, 'threadId'))
  )
  ipcMain.handle(IpcChannel.threadHandoff, (_event, threadId: unknown) =>
    sessions.handoff(asString(threadId, 'threadId'))
  )
  // TODO 1018: a selection across backends in the Model picker. main re-validates the backend and the model (registry, list).
  ipcMain.handle(
    IpcChannel.threadSwitchBackend,
    (_event, threadId: unknown, backend: unknown, modelId: unknown) =>
      sessions.switchBackend(
        asString(threadId, 'threadId'),
        asString(backend, 'backend'),
        modelId === null ? null : asString(modelId, 'modelId')
      )
  )
  ipcMain.handle(
    IpcChannel.threadRewind,
    (_event, threadId: unknown, eventId: unknown, options: unknown) => {
      const files =
        typeof options === 'object' && options !== null && (options as Record<string, unknown>)['files'] === true
      return sessions.rewind(asString(threadId, 'threadId'), asString(eventId, 'eventId'), { files })
    }
  )

  // ---- Continue from a CLI conversation / continue in the terminal (item 111, 4.5.9) ----
  ipcMain.handle(IpcChannel.threadTranscriptSessions, () => sessions.listTranscriptSessions())
  ipcMain.handle(IpcChannel.threadTranscriptSession, (_event, uri: unknown) =>
    sessions.transcriptSessionOfUri(asString(uri, 'uri'))
  )
  // ---- Backend status and settings (4.6 / 12.2) ----

  ipcMain.handle(IpcChannel.agentStatus, () => sessions.agentStatus(false))
  ipcMain.handle(IpcChannel.agentRecheck, () => sessions.agentStatus(true))
  ipcMain.handle(IpcChannel.agentBackends, (_event, force: unknown) => sessions.backendStatuses(force === true))
  // TODO 1066: the renderer's values are type-checked; the adapter re-validates the model name against the recommendations.
  ipcMain.handle(IpcChannel.agentLocalAdvice, (_event, backendId: unknown, force: unknown) =>
    sessions.localModelAdvice(asString(backendId, 'backendId'), force === true)
  )
  ipcMain.handle(IpcChannel.agentLocalActivity, (_event, backendId: unknown) => sessions.localModelActivity(asString(backendId, 'backendId')))
  ipcMain.handle(IpcChannel.agentLocalAction, (_event, backendId: unknown, action: unknown, model: unknown) => {
    if (!isLocalModelAction(action)) throw reasonError('invalid-value', { field: 'action' })
    return sessions.localModelAction(asString(backendId, 'backendId'), action, asString(model, 'model'))
  })
  ipcMain.handle(IpcChannel.agentRecheckLogin, () => sessions.recheckLogin())
  // TODO 960: automatic recovery from an expired authentication. One Terminal, and one resend per stopped thread (`LoginRecovery`).
  const loginRecovery = new LoginRecovery({
    openLogin: (threadId) =>
      openTerminalWithCli(
        { assertAllowed: withHandoffFallback((value, isDirectory, kind) => fs.assertAllowed(value, isDirectory, kind), 'read') },
        sessions.loginTarget(threadId)
      ),
    isLoggedIn: async () => (await sessions.recheckLogin()).loggedIn,
    stillExpired: (threadId) => sessions.isAuthInterrupted(threadId),
    resend: (threadId) => sessions.resendLast(threadId),
    autoOpen: () => autoLogin.get(),
    // TODO 1282: what main recorded when the mark was set (never the renderer's word).
    describe: (threadId) => sessions.authExpiryInfo(threadId),
    expiredThreads: () => sessions.authExpiredThreads(),
    hasViewer: () => deps.hasWindows?.() ?? true,
    onState: (state) => deps.onLoginRecovery?.(state)
  })
  sessions.setAuthRecovery({
    expired: (threadId, info) => loginRecovery.noteExpired(threadId, info),
    cleared: (threadId) => loginRecovery.noteCleared(threadId),
    stop: () => loginRecovery.stop()
  })
  // TODO 1282: the renderer's id is used only if it is a thread main has (otherwise the login is not tied to a conversation).
  ipcMain.handle(IpcChannel.agentStartLogin, (_event, threadId: unknown) =>
    loginRecovery.start(typeof threadId === 'string' && sessions.hasThread(threadId) ? threadId : null)
  )
  ipcMain.handle(IpcChannel.agentLoginRecovery, () => loginRecovery.state())
  ipcMain.handle(IpcChannel.agentCancelLogin, () => loginRecovery.cancel())
  ipcMain.handle(IpcChannel.agentUnattendedLoginGuide, () => sessions.unattendedLoginGuide())
  ipcMain.handle(IpcChannel.authAutoLoginGet, () => autoLogin.get())
  ipcMain.handle(IpcChannel.authAutoLoginSet, (_event, enabled: unknown) => {
    const saved = autoLogin.set(enabled === true)
    deps.onSettingsChanged?.()
    return saved
  })
  ipcMain.handle(IpcChannel.settingsGet, () => sessions.getSettings())
  // Defaults and current values for the settings editor (item 187). Read-only; restoring uses the existing setters.
  ipcMain.handle(IpcChannel.settingsSnapshot, () =>
    settingsSnapshot({
      theme: () => theme.state().preference,
      locale: () => locale.state().preference,
      editor: () => editorPreference.get(),
      notifyEnabled: () => notifications.get(),
      autoLogin: () => autoLogin.get(),
      asciiForSearch: () => deps.asciiInput.get(),
      autoSave: () => deps.autoSave.get(),
      autoUpdate: deps.autoUpdate,
      agentAutoUpdate: deps.agentAutoUpdate,
      voiceLocale: deps.voiceLocale,
      gmailDraftFont: deps.gmailDraftFont,
      threadCollapseDays: deps.threadCollapseDays,
      fileSortOrder: deps.fileSortOrder,
      redmineBaseUrl: deps.redmineBaseUrl,
      screenshotOffer: deps.screenshotOffer,
      releaseNotesAuto: deps.releaseNotesAuto,
      openAtLogin: deps.openAtLogin,
      preventSleep: deps.preventSleep,
      menuBar: deps.menuBar,
      session: () => sessions.getSettings(),
      approval: () => sessions.getApprovalPolicy(),
      hiddenFiles: deps.hiddenFiles,
      keybindings: deps.keybindings,
      bundleMax: () => sessions.getBundleMax()
    })
  )

  // ---- Color theme (7.4.1, T10) ----

  ipcMain.handle(IpcChannel.themeGet, () => theme.state())
  ipcMain.handle(IpcChannel.themeSet, (_event, preference: unknown) => {
    // Values from the renderer are not trusted. Anything other than the three values just returns the current state.
    if (!isThemePreference(preference)) return theme.state()
    return theme.setPreference(preference)
  })

  // ---- Display language (7.4.4, TODO 66) ----

  ipcMain.handle(IpcChannel.localeGet, () => locale.state())
  ipcMain.handle(IpcChannel.localeSet, (_event, preference: unknown) => {
    // Values from the renderer are not trusted. Anything outside the enumeration just returns the current state.
    if (!isLocalePreference(preference)) return locale.state()
    return locale.setPreference(preference)
  })
  // ---- Viewer and plugin infrastructure (chapter 7) ----

  ipcMain.handle(IpcChannel.viewerOpen, (_event, uri: unknown) => {
    return viewer.open(asString(uri, 'uri'))
  })

  ipcMain.handle(IpcChannel.viewerOpenPayload, (_event, kind: unknown) => {
    // Values from the renderer are not trusted. An unknown kind is not resolved (item 104).
    if (!isTransientPayloadKind(kind)) return null
    return plugins.resolvePayloadViewer(kind)
  })

  ipcMain.handle(IpcChannel.viewerOpenTransientFile, (_event, name: unknown) => {
    // TODO 905: values from the renderer are not trusted (type, length, last element). It only resolves; no read permission is granted.
    return resolveTransientFileViewer((uri) => plugins.resolveViewer(uri), name)
  })

  // TODO 1162: converting a temporarily displayed image. The values come from the renderer, so the Broker side checks type, length and size.
  ipcMain.handle(IpcChannel.viewerConvertImage, (_event, name: unknown, data: unknown) => {
    return viewer.convertImageForDisplay(name, data)
  })

  // TODO 673: pass `event.sender.id` (= `viewId`, the same value as the other per-window keys) to set up / advance the baseline of
  // the external-rewrite watch for this window (on the ViewerBroker side; existing callers may keep omitting it).
  ipcMain.handle(IpcChannel.viewerRead, async (event, pluginId: unknown, uri: unknown) => {
    return viewer.read(asString(pluginId, 'pluginId'), asString(uri, 'uri'), event.sender.id)
  })

  ipcMain.handle(
    IpcChannel.viewerWrite,
    async (event, pluginId: unknown, uri: unknown, content: unknown, expectedMtimeMs: unknown) => {
      const mtime =
        typeof expectedMtimeMs === 'number' && Number.isFinite(expectedMtimeMs)
          ? expectedMtimeMs
          : null
      return viewer.write(
        asString(pluginId, 'pluginId'),
        asString(uri, 'uri'),
        asString(content, 'content'),
        mtime,
        event.sender.id
      )
    }
  )

  // Failures are returned as values, not rejects (item 149). When viewers are switched in a mismatched order, a stale iframe's
  // request being refused by the Broker (`no-grant`) is an ordinary failure, and with a reject Electron would write
  // `Error occurred in handler` to the log. The refusal is left in the audit (`broker.denied`).
  ipcMain.handle(
    IpcChannel.viewerCommand,
    async (
      _event,
      pluginId: unknown,
      command: unknown,
      arg: unknown
    ): Promise<ViewerCommandResponse> => {
      const id = asString(pluginId, 'pluginId')
      const name = asString(command, 'command')
      try {
        return { ok: true, result: await plugins.invoke(id, name, arg) }
      } catch (err) {
        // Bodies of arguments and results are not written (Conventions). Only the plugin and command names.
        log.debug('viewer.command.failed', { pluginId: id, command: name })
        return { ok: false, message: err instanceof Error ? err.message : 'error' }
      }
    }
  )

  // Notification of a draft conflict (second half of item 97). It only remembers "the current draft's URI" per window
  // (`webContents.id`), and validation is only `typeof` (the shape of item 86). main does not pass the URI through the choke point -
  // this is material for a notification, not a permission decision (it only checks a match with the target path of write tools).
  ipcMain.handle(IpcChannel.viewerReportDraft, (event, uri: unknown) => {
    sessions.reportDraft(event.sender.id, typeof uri === 'string' && uri !== '' ? uri : null)
  })
  // The count in a window's viewer draft table (code-review of TODO 103). If it is not a number, treated as 0 (= none) (the shape of item 86).
  ipcMain.handle(IpcChannel.viewerReportStoredDrafts, (event, count: unknown) => {
    sessions.reportStoredViewerDrafts(
      event.sender.id,
      typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
    )
  })
  // TODO 832 (1): how the window handled the gateway's openFile "open" command. The receiver (`ViewerCommandReplies.reply`) validates the values
  // (an unknown id, a window that is not the destination, or an unknown result is discarded; the shape of item 86).
  ipcMain.handle(IpcChannel.viewerCommandReply, (event, replyId: unknown, outcome: unknown) => {
    sessions.replyViewerCommand(event.sender.id, replyId, outcome)
  })
  // TODO 1061 (3): what this window's ViewerPane currently has in front. Its shape is re-validated by `parseViewerShownReport` (item 86).
  // Material for the "shown" marker; not used for choke point decisions.
  ipcMain.handle(IpcChannel.viewerReportShown, (event, report: unknown) => {
    sessions.reportViewerShown(event.sender.id, parseViewerShownReport(report))
  })

  // Give back the permission for the opened URI (review D-3). Only whether the value is a string is checked - since it **reduces**
  // permissions, a false value cannot widen the scope (an unknown URI does nothing).
  ipcMain.handle(IpcChannel.viewerClose, (_event, pluginId: unknown, uri: unknown) => {
    viewer.close(asString(pluginId, 'pluginId'), asString(uri, 'uri'))
  })

  // The ViewerPane closed completely (TODO 673, a code-review fix). Remove the external-rewrite watch.
  // `ipcMain.on` is a one-way call that is fine as long as it does not throw, so wrap it in try / catch just in case.
  ipcMain.on(IpcChannel.viewerUntrackWatch, (event) => {
    try {
      viewer.closeView(event.sender.id)
    } catch (err) {
      log.warn('ipc.viewerUntrackWatch.failed', errorFields(err))
    }
  })

  ipcMain.handle(IpcChannel.pluginList, (): readonly PluginSummary[] => plugins.summaries())

  ipcMain.handle(IpcChannel.pluginSurfaces, (): PluginSurfacesSnapshot => deps.surfaces?.snapshot() ?? EMPTY_SURFACES)

  /** TODO 896: windows being watched for `destroyed`, so that a running search is dropped when its window closes. */
  const searchCallers = new Set<number>()
  // TODO 896: the plugin section of the search sidebar. The relay owns re-validation of the values (string, length, whether the section is still valid and bundled).
  ipcMain.handle(IpcChannel.pluginSearch, async (event, pluginId: unknown, query: unknown): Promise<PluginSearchResponse> => {
    const relay = deps.pluginSearch
    if (relay === undefined) {
      return { pluginId: typeof pluginId === 'string' ? pluginId.slice(0, 64) : '', query: '', results: [], error: 'unavailable', dropped: 0 }
    }
    const caller = event.sender.id
    // When a window closes, drop that window's running search (nobody is left to wait for the answer).
    if (!searchCallers.has(caller)) {
      searchCallers.add(caller)
      event.sender.once('destroyed', () => {
        searchCallers.delete(caller)
        relay.cancelCaller(caller)
      })
    }
    return relay.search(caller, pluginId, query)
  })

  // Detail of an extension view (TODO 367). Only hands over the manifest and the state; plugin code is not run.
  ipcMain.handle(IpcChannel.pluginDetail, (_event, pluginId: unknown): PluginDetail | null =>
    plugins.detail(asString(pluginId, 'pluginId'))
  )

  ipcMain.handle(IpcChannel.pluginSetEnabled, (_event, pluginId: unknown, enabled: unknown) => {
    plugins.setEnabled(asString(pluginId, 'pluginId'), enabled === true)
  })

  ipcMain.handle(
    IpcChannel.pluginSetConsent,
    (_event, pluginId: unknown, capability: unknown, granted: unknown) => {
      // TODO 1237: capability names are looked up from one place, `CAPABILITY_NAMES` (before, a hand-written table lacked `triggers`, and the toggle on the permissions tab was refused).
      if (!isCapabilityName(capability)) throw reasonError('invalid-value', { field: 'capability' })
      const name: CapabilityName = capability
      // Wave 86 fix Y: wait until the identity is settled before writing, and refuse with a reason code if it cannot be written (`setConsentByUser`).
      return plugins.setConsentByUser(asString(pluginId, 'pluginId'), name, granted === true)
    }
  )

  // TODO 1233 (7.2): uninstall an external extension. main (`PluginHost.uninstall`) checks whether it is bundled and whether it is directly under the install location.
  ipcMain.handle(IpcChannel.pluginUninstall, (_event, pluginId: unknown) => plugins.uninstall(asString(pluginId, 'pluginId')))

  ipcMain.handle(
    IpcChannel.pluginAudit,
    (_event, limit: unknown, pluginId: unknown): readonly AuditEntry[] => {
      const max = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : 100
      // Finish writing what has piled up before reading (the batch is delayed by 16 ms).
      audit.flush()
      return typeof pluginId === 'string' ? audit.recent(max, pluginId) : audit.recent(max)
    }
  )

  ipcMain.handle(IpcChannel.settingsSet, (_event, patch: unknown) => {
    const record = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<
      string,
      unknown
    >
    const retention = record['defaultRetention']
    const modelId = record['defaultModelId']
    const thinking = record['defaultThinking']
    // The range of numbers (safe integers, upper and lower bounds) is closed by SessionManager.setSettings (item 86).
    const next: Partial<SessionSettings> = {
      ...(typeof record['maxConcurrent'] === 'number'
        ? { maxConcurrent: record['maxConcurrent'] }
        : {}),
      ...(typeof record['idleTimeoutMs'] === 'number'
        ? { idleTimeoutMs: record['idleTimeoutMs'] }
        : {}),
      ...(retention === 'none' || retention === 'days' || retention === 'forever'
        ? { defaultRetention: retention }
        : {}),
      // T5: default model / thinking. null means "not chosen yet" (item 61 removed the "default" choice, but it is still accepted
      // for old setting values and the type. The UI puts null at the top of the list).
      ...(isDefaultModelIdValue(modelId) ? { defaultModelId: modelId } : {}),
      ...(isThinkingLevel(thinking) || thinking === null ? { defaultThinking: thinking } : {})
    }
    const saved = sessions.setSettings(next)
    deps.onSettingsChanged?.()
    return saved
  })
}

/** main -> renderer push. Sends only while the target is alive. */
export function createPusher(getTargets: () => readonly WebContents[]): {
  scanStatus(status: ScanStatus): void
  fileChanges(batch: FileChangeBatch): void
  threadEvents(batch: AiosEventBatch): void
  threadsChanged(threads: readonly ThreadSummary[]): void
  threadChanged(summary: ThreadSummary): void
  approvalsChanged(items: readonly ApprovalItem[]): void
  agentStatus(status: AgentStatus): void
  indexStatus(status: IndexStatus): void
  pluginsChanged(plugins: readonly PluginSummary[]): void
  pluginSurfaces(snapshot: PluginSurfacesSnapshot): void
  pluginNotification(notification: {
    pluginId: string
    title: string
    body: string | null
  }): void
  theme(state: ThemeState): void
  locale(state: LocaleState): void
  mcpReport(report: McpGlobalReport): void
  deletedThreads(items: readonly DeletedThreadSummary[]): void
  /** Some setting value changed (TODO 1060 stage 3). It has no contents; the settings screen re-fetches. */
  settingsChanged(): void
  /** TODO 1282: the login recovery's phase changed. */
  loginRecovery(state: LoginRecoveryState): void
} {
  const send = (channel: string, payload: unknown): void => {
    for (const contents of getTargets()) {
      if (!contents.isDestroyed()) contents.send(channel, payload)
    }
  }
  return {
    scanStatus: (status) => send(IpcEvent.scanStatus, status),
    fileChanges: (batch) => send(IpcEvent.fileChanges, batch),
    threadEvents: (batch) => send(IpcEvent.threadEvents, batch),
    threadsChanged: (threads) => send(IpcEvent.threadsChanged, threads),
    threadChanged: (summary) => send(IpcEvent.threadChanged, summary),
    approvalsChanged: (items) => send(IpcEvent.approvalsChanged, items),
    agentStatus: (status) => send(IpcEvent.agentStatusChanged, status),
    indexStatus: (status) => send(IpcEvent.indexStatus, status),
    pluginsChanged: (list) => send(IpcEvent.pluginsChanged, list),
    pluginSurfaces: (snapshot) => send(IpcEvent.pluginSurfacesChanged, snapshot),
    pluginNotification: (notification) => send(IpcEvent.pluginNotification, notification),
    theme: (state) => send(IpcEvent.themeChanged, state),
    locale: (state) => send(IpcEvent.localeChanged, state),
    mcpReport: (report) => send(IpcEvent.mcpReportChanged, report),
    deletedThreads: (items) => send(IpcEvent.deletedThreadsChanged, items),
    settingsChanged: () => send(IpcEvent.settingsChanged, null),
    loginRecovery: (state) => send(IpcEvent.agentLoginRecoveryChanged, state)
  }
}
