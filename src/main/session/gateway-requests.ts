/**
 * The gateway -> main entry point (item 97 / 7.6, TODO 578 (e)). The body of `SessionManager.handleGatewayRequest`
 * was split out here: approval requests and choice questions (`approve` / `approveCancelled`), the search tools
 * (`search` / `getDocument` / `getDocumentText` / `getChunk`, 7.6.1), the ViewerPane tools
 * (`openFile` / `closeFile` / `listOpenFiles` / `openUrl` / `openDiff` / `getOpenUrlText`, 7.6.2), and the draft conflict notice (7.6.3).
 *
 * **It does not touch electron or the DB directly**: the `SessionManager` state (live connections, the send queue,
 * approvals, the index, the ViewerPane) is touched only through `GatewayRequestHost`. In the constructor of
 * `manager.ts`, `SessionManager` just builds a bundle of closures in this shape (a thin host that does not leak
 * the `this` private fields as they are) and passes it in; the public `handleGatewayRequest` entry point is
 * unchanged. Behavior is the same as before the move.
 */
import { randomUUID } from 'node:crypto'
import { constants, realpathSync, statSync } from 'node:fs'
import type { ResolvedGrantPath } from '../approval/grants.js'
import { stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { AiosEvent, ApprovalOutcome, JsonValue } from '@shared/agent.js'
import type { DiffPayload } from '@shared/plugin.js'
import type { FileEntry } from '@shared/types.js'
import { reasonError } from '@shared/reason.js'
import { isWebViewerUrl, MAX_EXTERNAL_URL_LENGTH } from '@shared/open-external.js'
import {
  GATEWAY_TOOL_PREFIX,
  workingCwdUri,
  type ApprovalSubtask,
  type GrantSubject,
  type SessionState,
  type Thread,
  type ViewerCommand,
  type ViewerCommandOutcome
} from '@shared/thread.js'
import { log } from '../../common/logger.js'
import { pathToUri, uriToPath, foldPath } from '../../common/uri.js'
import { fallbackApprovalReply, type ApprovalCancelReason } from '../approval/reply.js'
import type { ApprovalRequestInput, ApprovalRequestMatch, ApprovalResult, ApprovalRole } from '../approval/broker.js'
import type { GatewayRequest } from '../approval/server.js'
import type { IndexClient } from '../index/client.js'
import type { FsAccess } from '../fs/access.js'
import { ASK_TOOL, isAnswerRequest, questionsOf } from '../approval/questions.js'
import { isGitRev, readFileAtRevision, type GitShowFailure } from '../git/show.js'
import { MAX_VIEWER_HIGHLIGHT, resolveToolPath } from './viewer-tools.js'
import {
  BUNDLE_START_LABEL,
  bundleQuestionInput,
  parseBundles,
  type BundleSpec,
  type StartBundlesResult
} from './bundles.js'
import type { AgentAdapter } from './types.js'
import type { AiReminderGate } from '../schedule/ai-reminders.js'
import { checkSettingName, isGatedSettingName, type AgentSettings } from '../agent-settings.js'
import { consentSummary, type PluginToolRelay, type ResolvedPluginTool } from '../plugin/tools.js'
import { webHostOf } from '@shared/web-view.js'
import type { ViewerShownReport, ViewerShownSelection } from '@shared/viewer-shown.js'
import { redactText } from '../../common/redact.js'
import type { ScreenshotFailure, ScreenshotOutcome } from './viewer-screenshot.js'
import { openNoFollow } from '../../common/os/open-flags.js'
import {
  DEFAULT_PAGE_TEXT_SLICE_BYTES,
  MAX_PAGE_TEXT_SLICE_BYTES,
  MIN_PAGE_TEXT_SLICE_BYTES,
  pickWebTab,
  slicePageText,
  tidyPageText,
  type ReadableWebTab,
  type TabTextFailure,
  type TabTextOutcome
} from '../web/page-text.js'

/** The gateway's ViewerPane tools (7.6.2). Handled through a different entry point from the search tools. */
const GATEWAY_VIEWER_KINDS: ReadonlySet<string> = new Set([
  'openFile',
  'closeFile',
  'listOpenFiles',
  'openUrl',
  'openDiff',
  'getOpenUrlText',
  'getViewerScreenshot'
])

/**
 * The per-side limit (bytes) of `openDiff` (TODO 826). Anything over it is refused without being read. Even above
 * `MAX_DIFF_BYTES` (256 KB), up to this size is passed to the window, and the viewer does not compute the diff but shows the two side by side (item 104).
 */
export const MAX_OPEN_DIFF_BYTES = 2 * 1024 * 1024

/** A failure of `git show` -> a fixed English sentence returned to the model (TODO 826). */
const GIT_SHOW_ERRORS: Readonly<Record<GitShowFailure, string>> = {
  missing: 'git is not available',
  'not-a-repo': 'the file is not in a git repository',
  'not-found': 'the file or the revision was not found in git',
  timeout: 'git took too long',
  'too-large': 'the file is too large to compare',
  'invalid-rev': 'invalid git revision',
  error: 'git failed'
}

/** Reads it as a string. If there is a NUL in the first 8 KB it is binary and the result is null (the same view as git's). */
export function decodeText(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null
  return bytes.toString('utf8')
}

/** A short name with the parent folder name (`src/a.ts`). `DiffSide.name` carries no absolute path. */
function shortName(path: string): string {
  return `${basename(dirname(path))}/${basename(path)}`
}

/** One hit of the gateway's `searchFiles` (TODO 1158). `id` is a document id that can be passed to `getDocument`, `path` is an absolute path that can be passed to `openFile`. */
interface GatewayFileHit {
  readonly id?: string
  readonly uri: string
  readonly path: string
  readonly name: string
  readonly kind: 'file' | 'directory'
  readonly size: number
  readonly modified_at: number
}

/**
 * The built-in sources the gateway's search can narrow by (item 86). Main does not trust the gateway, so this is closed by an allowlist.
 * TODO 1225: in addition, it can narrow by the index source declared by a currently enabled extension (`GatewayRequestHost.pluginIndexSources`).
 */
const GATEWAY_SEARCH_SOURCES: ReadonlySet<string> = new Set(['fs', 'conversation', 'transcript'])

/**
 * The conversation's working folder (TODO 633). If it moved into a worktree, that path: derived the same way as
 * `SessionManager.workingCwdOf` / the spawn cwd (`workingCwdUri`). The CLI runs here, so a relative path the model passes is resolved here too.
 */
function workingCwdOf(thread: Thread): string {
  return uriToPath(workingCwdUri(thread))
}

/** Whether it is a safe integer with `min ≤ value ≤ max` (item 86). NaN / Infinity / fractions are false. `manager.ts` has the same definition. */
function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

/** A one-line summary of an approval request. Picks the main values of the tool arguments. */
export function summarize(input: JsonValue): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ''
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const value = (input as Record<string, JsonValue>)[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.replace(/\s+/g, ' ').trim().slice(0, 200)
    }
  }
  const first = Object.values(input as Record<string, JsonValue>).find(
    (v) => typeof v === 'string' && v.trim() !== ''
  )
  return typeof first === 'string' ? first.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
}

/**
 * Only the fields of one `SessionManager.live` entry that this entry point reads and writes. It is passed as a
 * **reference to the same object**, so a change here takes effect on the `SessionManager` side as it is (the same
 * as before: it touches the `Live` stored in the Map directly).
 */
export interface GatewayLiveHandle {
  state: SessionState
  planMode: boolean
  /** Whether this process was started with the OS sandbox enabled (TODO 1106). Omitted means false. */
  readonly osSandbox?: boolean
  readonly pendingApprovals: Set<string>
}

/**
 * What `GatewayRequests` borrows from `SessionManager`. **`SessionManager` does not pass `this` as it is; it builds a
 * small bundle of closures in this shape**, so as not to expose private fields. `store` / `views` / `draftConflicts` /
 * `index` / `fs` / `broker` are internal-only entry points where it is fine to pass the real objects `SessionManager`
 * keeps (by reference), so they are narrowed with `Pick`.
 */
export interface GatewayRequestHost {
  /** Whether shutdown has started (12.9). */
  isStopped(): boolean
  /** aios session ID -> thread ID. */
  threadIdForSession(sessionId: string): string | undefined
  getThread(threadId: string): Thread | null
  getAdapter(backend: string): AgentAdapter | undefined
  /** The record of the running process (undefined if none = no process is up). */
  getLive(threadId: string): GatewayLiveHandle | undefined
  /** Whether that thread's send queue is waiting for the `result` of the input written to stdin. */
  isQueueAwaitingResult(threadId: string): boolean
  hasPlanMode(threadId: string): boolean
  clearPlanMode(threadId: string): void
  /** Looks up the child that issued an approval request from its `tool_use_id` (item 93). */
  subtaskOfToolUse(threadId: string, toolUseId: string | null): ApprovalSubtask | null
  /** Batches the distribution to the renderer and the save to the DB on the same 16 ms cycle (`SessionManager.record`). */
  record(threadId: string, event: AiosEvent): void
  /** Distribution for one thread only (item 75). */
  emitThread(threadId: string): void
  requestApproval(input: ApprovalRequestInput): Promise<ApprovalResult>
  cancelApprovalRequest(threadId: string, match: ApprovalRequestMatch, reason: ApprovalCancelReason): boolean
  /** The list of windows showing that thread (`webContents.id`). */
  viewsOf(threadId: string): readonly number[]
  /** One of those windows (foreground -> the window that last got focus -> the first). null if none (for `openSettings`, TODO 1060). */
  primaryViewOf(threadId: string): number | null
  /** Window -> the thread it shows, for all of them (for the "other windows" of `listOpenFiles`). */
  allViewEntries(): readonly (readonly [number, string])[]
  /** Delivers a ViewerPane instruction to a window (`webContents.id`) (omitted in some configurations, in which nothing is delivered). */
  onViewerCommand(viewId: number, command: ViewerCommand): void
  /**
   * TODO 1061 (3): what window `viewId`'s ViewerPane currently has in front (the renderer's notice). Returned only when
   * that window is showing `threadId` and the notice is for that conversation (otherwise, or if no notice has arrived yet, null = unknown). Omitted means "unknown".
   */
  viewerShown?(viewId: number, threadId: string): ViewerShownReport | null
  /** TODO 832 (1): whether the file the window is viewing now has an unsaved draft (`DraftConflictTracker.hasCurrent`). */
  hasViewerDraft(viewId: number): boolean
  /** TODO 832 (1): registers the wait for the window's reply to an "open" (`ViewerCommandReplies.expect`). Call it before sending the instruction. */
  expectViewerReplies(viewIds: readonly number[]): {
    readonly id: string
    readonly done: Promise<ReadonlyMap<number, ViewerCommandOutcome>>
  }
  /** Conflict with a window's draft (7.6.3). Returns only the windows that matched. */
  conflictingViews(viewIds: readonly number[], targetUri: string): readonly number[]
  /** The thread's ViewerPane memory (item 63). `SessionManager.setViewerState` itself. */
  setViewerState(threadId: string, uri: string | null, highlight: string | null): void
  /** Bundle conversations (TODO 633 stage 3, 7.6.6): the "how many can be created at once" setting. */
  bundleMax(): number
  /** The check before asking the user (count, usage limit, shutdown). null if it passes, the reason if refused. */
  bundlePrecheck(count: number, parent: Thread): string | null
  /** After approval: creates a conversation for each bundle and sends the instructions. */
  startBundles(parentId: string, bundles: readonly BundleSpec[]): Promise<StartBundlesResult>
  readonly index: Pick<IndexClient, 'search' | 'searchFilesForAgent' | 'getDocument' | 'getDocumentText' | 'getChunk' | 'resolveDocument'>
  readonly fs: Pick<FsAccess, 'assertAllowed'>
  /** Relay of plugin tools (TODO 847, 7.6.7). If absent, no plugin tool is exposed at all. */
  readonly pluginTools?: Pick<PluginToolRelay, 'list' | 'lookup' | 'prepare' | 'recordDenied' | 'run' | 'grantConsent'>
  /**
   * Approval deadline (TODO 959): for an unattended turn, the deadline fixed when the turn was started (epoch ms) - in a scheduled job's
   * conversation a little before the job's next scheduled time, in a trigger's or an unattended bundle's a fixed wait. TODO 1289
   * (code-review, wave 97 fix Y): every unattended turn (`isUnattendedTurn`), not only the first one. An attended turn, or a job with no
   * next schedule, null (= no limit on the wait). Omitted means null.
   */
  approvalDeadline?(threadId: string): number | null
  /**
   * TODO 983 (4.2.5): this conversation's approval role, from `threads.role_id` (a Teammate, stage 4) and `threads.schedule_job_id` (a job, stages 1-3).
   * A gone Teammate or job contributes no key (an old conversation with only the mark left does not look up the table). null for a conversation with neither
   * (a normal conversation, a trigger). Omitted means null.
   */
  roleOf?(threadId: string): ApprovalRole | null
  /**
   * TODO 1043: whether the thread has read a secret (a mark in the Broker's memory). If true, `openUrl` and plugin tools are also asked in the approval inbox. Omitted means false.
   */
  hasReadSecret?(threadId: string): boolean
  /**
   * TODO 1052: a window's (`webContents.id`) Web tabs (`WebViewHandle` in `src/main/web/register.ts`). If omitted, Web tabs are
   * not listed in `listOpenFiles`, and `getOpenUrlText` refuses.
   */
  readonly webTabs?: GatewayWebTabs
  /**
   * TODO 1052: first-time consent to reading the body of a Web tab (one per app setting, `web.tabReadConsent`). If omitted it cannot be recorded,
   * so it is asked every time.
   */
  readonly webTabReadConsent?: { granted(): boolean; grant(): void }
  /** TODO 1061 (1): the entry point that captures the ViewerPane's rendering. If omitted, `getViewerScreenshot` refuses (tests). */
  readonly viewerCapture?: GatewayViewerCapture
  /** TODO 1052: the wait for a tab to appear right after `openUrl`. If omitted, `setTimeout`. Tests resolve it immediately. */
  sleep?(ms: number): Promise<void>
  /**
   * TODO 1060: the entry point that reads and changes aios's own settings (`getSettings` / `setSetting`, 7.6.8). The composition root wires it
   * later, so it is received as a function. If omitted or null, both tools refuse (tests, mid-startup).
   */
  appSettings?(): AgentSettings | null
  /**
   * TODO 1265 (7.6.9): the entry that registers notification-only reminders for the AI (`addReminder` / `listReminders` / `cancelReminder`). The composition root wires it
   * later (the scheduler is created after the session manager). If omitted or null, the three tools refuse.
   */
  aiReminders?(): AiReminderGate | null
  /**
   * TODO 1216 (6.2.6): whether that conversation is in the middle of a trigger's first (unattended) turn. While true it is **read-only**: anything outside the table of
   * read tools (`unattendedAllows`) is refused without asking (nobody would answer, so refuse and move on rather than stall on a pending approval). Omitted means false.
   */
  isUnattendedReadOnly?(threadId: string): boolean
  /**
   * Code-review (wave 96 fix Y): whether that conversation is in any unattended turn - a trigger's first turn (as above) **or a scheduled job's
   * first turn** (`SessionManager.isUnattended`). Wider than `isUnattendedReadOnly`: a scheduled turn may write files, but nobody is watching
   * it, so the reminder tools refuse it (ARCHITECTURE 7.6.9). Omitted means "same as `isUnattendedReadOnly`".
   * TODO 1289: also any later turn of a conversation started without a person (scheduled job, trigger, bundle of an unattended turn)
   * that a person did not start on the spot (`SessionManager.isUnattendedTurnNow`). `setSetting` refuses and `openUrl` asks while true.
   */
  isUnattendedTurn?(threadId: string): boolean
  /**
   * TODO 1227 (owner decision 2026-11-13): in an unattended read-only conversation, whether the rule of the trigger that started the conversation allows
   * tool `toolName` (the declared name) of the **non-bundled** extension `pluginId`. Limited to the tools of the extension that emitted the event itself
   * (`SessionManager.triggerRuleAllowsTool`). `fingerprint` is the fingerprint of the currently loaded tool declaration (fix X), and
   * the rule's permission is looked up by the pair of name and this fingerprint: a tool whose declaration changed, or that was swapped for
   * a different extension with the same id, does not pass.
   * Omitted means false (tools of non-bundled extensions do not pass in an unattended turn).
   */
  unattendedPluginToolAllowed?(threadId: string, pluginId: string, toolName: string, fingerprint: string): boolean
  /**
   * TODO 1225 (7.6.1): the extension sources `search` can narrow by with `source`. Only those that a currently enabled extension declared in the manifest's `index.write`
   * and that are in its own namespace (`indexSourceOwnedBy`). Narrowing only narrows the result (a search without narrowing already returns extension documents too).
   * Omitted means none (only the three built-in ones).
   */
  pluginIndexSources?(): readonly string[]
  /**
   * TODO 982: whether the conversation is a drill (main's mark in the DB, `threads.drill`, also for a removed row). While true, everything
   * outside the read-only allowlist (`unattendedAllows` / `UNATTENDED_GATEWAY_PASS_KINDS`, the same judgment as a trigger's read-only turn)
   * is stopped **before any permission is consulted** and recorded (`recordDrillOp`); questions still reach the person. Omitted means
   * "the thread's `drill` field".
   */
  isDrill?(threadId: string): boolean
  /**
   * TODO 982: keeps one operation a drill stopped (main builds the smallest description and what "allow from now on" would add, and
   * persists it through the store's gate). The input is the call as received; it is not kept as is. Omitted means not kept.
   */
  recordDrillOp?(threadId: string, op: DrillStop): void
}

/** TODO 982: an operation a drill stopped, as the gateway saw it. */
export interface DrillStop {
  readonly toolName: string
  readonly input: JsonValue
  readonly toolUseId: string | null
  /** Where it was stopped: the approval stage of a built-in or extension tool, or the tool stage of a gateway tool. */
  readonly stage: 'approve' | 'tool'
}

/**
 * TODO 1216: the gateway tools allowed in an unattended read-only turn (read only, do not move the screen, do not send anything out).
 * `getOpenUrlText` / `getViewerScreenshot` (logged-in pages), `openUrl` (an outbound GET), `openFile` / `openDiff` / `closeFile`
 * (they move a person's screen), `setSetting` / `openSettings` and `startBundles` are not included.
 */
export const UNATTENDED_GATEWAY_READ_TOOLS: ReadonlySet<string> = new Set([
  'search',
  'searchFiles',
  'getDocument',
  'getDocumentText',
  'getChunk',
  'listOpenFiles',
  'getSettings'
])

/**
 * TODO 1216 (fix X): what is allowed through at the tool stage (the kind of gateway request) in an unattended read-only turn. **An allowlist**:
 * a kind not listed here is refused at the entry point even if `approve` is skipped (even if the user's `permissions.allow` has `mcp__aios__*`).
 * `approve` / `approveCancelled` are the approval stage itself (the allowlist is consulted inside `approve`), `pluginTools` is the tool list (read only),
 * and `pluginTool` is the relay stage (`handlePluginTool`), which refuses on side effects, consent and the secret mark.
 */
const UNATTENDED_GATEWAY_PASS_KINDS: ReadonlySet<string> = new Set([
  ...UNATTENDED_GATEWAY_READ_TOOLS,
  'approve',
  'approveCancelled',
  'pluginTools',
  'pluginTool'
])

/** TODO 1216: the text returned to the model when refused in an unattended read-only turn (a fixed English sentence, handled like TODO 567). */
export const UNATTENDED_DENIED_MESSAGE =
  'This turn runs unattended and read-only (started by an aios trigger). Writing files, running shell commands, sending or posting, and tools with side effects are not allowed, and nobody can approve them now. Continue with the read-only tools and put drafts in your answer as text.'

/**
 * Code-review (wave 96 fix Y): the text returned when a scheduled job's unattended turn tries to register or cancel a reminder (7.6.9). Text the AI read
 * from outside (a web page, a mail) must not be able to plant a notification that fires later with nobody having asked for it.
 */
export const AI_REMINDER_UNATTENDED_MESSAGE =
  'Reminders cannot be set or cancelled in a turn that runs unattended (a scheduled job or a trigger). If a reminder seems useful, say so in your answer so the user can add it in Settings.'

/**
 * TODO 1289 (owner decision 2026-11-21): the text returned when an unattended turn (`isUnattendedTurn`) tries `setSetting`. Every key is
 * refused, display keys included: text read from outside must not be able to change aios (for example silence its notifications).
 */
export const SETTING_UNATTENDED_MESSAGE =
  'Settings cannot be changed in a turn that runs unattended (a scheduled job, a trigger, or a bundle started from one). If a setting should change, say so in your answer so the user can change it.'

/** TODO 1289: the approval-reason action of `openUrl` asked in an unattended turn (`ApprovalRequestInput.unattended`). */
export const UNATTENDED_OPEN_URL_ACTION = 'open-url'

/** TODO 1216: the reason code of the refusal (shown in the timeline row, `reason.<code>`). */
export const UNATTENDED_DENIED_REASON = 'approval-denied-unattended'

/** TODO 982: the reason code of a drill's stop (the timeline row). The model gets the Adapter's text for `cancelled: drill`. */
export const DRILL_DENIED_REASON = 'approval-cancelled-drill'

/** TODO 1060: the settings tools (7.6.8). */
export const SET_SETTING_TOOL = 'setSetting'
/** TODO 1265 (7.6.9): the reminder tools. Not in the unattended allowlist, so an unattended read-only turn is refused before it reaches the handler. */
export const AI_REMINDER_KINDS: ReadonlySet<string> = new Set(['addReminder', 'listReminders', 'cancelReminder'])

/** TODO 1060 stage 2: the tool that opens that item of the settings screen (7.6.8). Does not change the value. */
export const OPEN_SETTINGS_TOOL = 'openSettings'

/**
 * TODO 1061 (1): the entry point that captures the rendering of a window's ViewerPane. `web` is the tab the Web view is currently showing (`WebViewHandle.captureTab`),
 * `pane` is the rectangle of a file viewer / temporary view (`src/main/viewer-capture.ts`).
 */
export interface GatewayViewerCapture {
  web(viewId: number, tabId: string): Promise<ScreenshotOutcome>
  pane(viewId: number): Promise<ScreenshotOutcome>
}

/** TODO 1061 (1): the reason it could not be captured -> a fixed English sentence returned to the model. */
const SCREENSHOT_ERRORS: Readonly<Record<ScreenshotFailure, string>> = {
  closed: 'The window or the view was closed before it could be captured.',
  hidden:
    'The viewer pane is covered or changing right now (a menu or dialog may be open), so it could not be captured. Try again in a moment.',
  empty: 'The viewer pane has not been drawn yet, so the capture was empty. Try again in a moment.',
  failed: 'The viewer pane could not be captured.'
}

/** TODO 1052: the entry point to a window's Web tabs that gateway reads use. */
export interface GatewayWebTabs {
  list(viewId: number): readonly ReadableWebTab[]
  read(viewId: number, tabId: string): Promise<TabTextOutcome>
}

/**
 * TODO 1052: the maximum wait and the interval (milliseconds) when `getOpenUrlText` is given a `url` but no tab shows it. Right after `openUrl`
 * the renderer has not yet copied the URL into the tab (the `open` to the window -> `web.load` is asynchronous).
 */
export const WEB_TAB_MATCH_WAIT_MS = 3_000
const WEB_TAB_MATCH_INTERVAL_MS = 250

/** TODO 1052: the text of the first-time consent shown in the approval inbox (a fixed English sentence, like `consentSummary` of 848). */
export const WEB_TAB_READ_CONSENT_SUMMARY =
  'First use: allow the AI to read the text of web pages open in the viewer tabs and take screenshots of them (including pages you are signed in to)'

/** TODO 1052: the reason it could not be read -> a fixed English sentence returned to the model. */
const TAB_TEXT_ERRORS: Readonly<Record<TabTextFailure, string>> = {
  closed: 'The tab or its window was closed before the page could be read.',
  'not-web': 'That tab does not show a web page.',
  failed: 'The page failed to load in that tab. Ask the user to check the tab, or open the page again with openUrl.',
  'login-required':
    'The page needs a sign-in that cannot be done here (the viewer shows a login screen). Ask the user to sign in from the Web tab, then read it again.',
  unreadable: 'The text of the page could not be read.'
}

/**
 * TODO 1042: resolves the path of a write tool to an absolute path and a realpath, for the lingering check (`cwd` is the conversation's working folder).
 * For a file that does not exist yet: the parent directory's realpath + the name. Ones that cannot be resolved are dropped (the caller matches the original path separately).
 * **Only material for the decision**; unrelated to the read/write permission (`assertAllowed`).
 */
export function resolvedWritePaths(raw: string, cwd: string): readonly string[] {
  const absolute = resolveToolPath(raw, cwd)
  if (absolute === null) return []
  const out = [absolute]
  try {
    out.push(realpathSync.native(absolute))
  } catch {
    try {
      out.push(`${realpathSync.native(dirname(absolute))}/${basename(absolute)}`)
    } catch {
      // No parent either: match by the absolute path only.
    }
  }
  return out
}

/**
 * TODO 983: resolves the paths in the role's permission table (3. of 4.2.5). Makes them absolute and takes the realpath. For a file that does not exist yet: the parent's realpath + the name.
 * If neither can be resolved, null (it does not match by the literal path: a symlink in an ancestor could point elsewhere, so it errs on the closed side).
 */
export function resolvedGrantPath(raw: string, cwd: string): ResolvedGrantPath | null {
  const absolute = resolveToolPath(raw, cwd)
  if (absolute === null) return null
  try {
    const real = realpathSync.native(absolute)
    let directory = false
    try {
      directory = statSync(real).isDirectory()
    } catch {
      directory = false
    }
    return { path: real, directory }
  } catch {
    try {
      return { path: `${realpathSync.native(dirname(absolute))}/${basename(absolute)}`, directory: false }
    } catch {
      return null
    }
  }
}

/** Mixes the approval deadline (TODO 959) into the input of `requestApproval`. Empty if none. */
function expiryOf(host: GatewayRequestHost, threadId: string): { expiresAt?: number } {
  const expiresAt = host.approvalDeadline?.(threadId) ?? null
  return expiresAt === null ? {} : { expiresAt }
}

/**
 * Cleanup after one approval is settled (shared by three places: `approve` / the relay of plugin tools / `startBundles`, TODO 927).
 * Removes itself from the pending list and leaves `awaiting-approval` **only when none remain**. When two approvals of
 * parallel subagents are queued, going back to "running" after answering just one would make the list and the runtime stop
 * showing "awaiting approval" while the second is still in the inbox (the same condition as the `result` handling in `event-recorder.ts`).
 */
function settleApproval(host: GatewayRequestHost, threadId: string, live: GatewayLiveHandle, eventId: string): void {
  live.pendingApprovals.delete(eventId)
  if (live.state === 'awaiting-approval' && live.pendingApprovals.size === 0) {
    live.state = host.isQueueAwaitingResult(threadId) ? 'running' : 'idle'
  }
  host.emitThread(threadId)
}

/**
 * The settlement of an approval -> the `outcome` of `permission_request` (the same shape for `approve` and the relay of plugin tools, wave 45 code-review).
 * The saved form (redaction, truncation) is applied by `ThreadStore.toPersistable`.
 */
function decidedOutcome(result: ApprovalResult): ApprovalOutcome {
  return result.allowed
    ? {
        kind: 'allowed',
        by: result.by === 'rule' || result.by === 'default' ? result.by : 'user',
        // If a choice question was answered, its wording (T31 / 4.2.2). It includes the free text the user typed
        // ("Other"), so it is passed through as is here, and redaction is applied by
        // ThreadStore.toPersistable when it copies `outcome.answer` field by field (TODO 749).
        ...(result.answer === undefined ? {} : { answer: result.answer }),
        ...(result.autoPicked === true ? { autoPicked: true as const } : {}),
        // TODO 1230: the question, the options, the recommendation and the chosen position. Redaction and truncation are applied by ThreadStore.toPersistable.
        ...(result.autoPick === undefined ? {} : { autoPick: result.autoPick })
      }
    : {
        kind: 'denied',
        by: result.by === 'system' ? 'system' : 'user',
        // The user's instruction is that text; otherwise a reason code (TODO 567, the renderer draws it with `describeReason`).
        message: result.message,
        // The shape (items 182 / 183) is only for the user's refusal. aios's own withdrawal (`cancelled`) is identified by `by: 'system'`.
        ...(result.reply === undefined || result.reply.kind === 'cancelled' ? {} : { reply: result.reply.kind })
      }
}

/**
 * Holds the `tool_use_id` of a plugin tool with side effects that passed the `approve` stage until the relay stage (wave 45 code-review).
 * The backend sends `approve` -> the tool call in that order, but the tool call does not carry a `tool_use_id`. If the held mark is attached
 * to the relay stage's `permission_request`, the approval is attached to that tool's row in the timeline, and withdrawal by the `tool_use` result
 * (TODO 632) also works. When there is no mark (`approve` was skipped by the user's `permissions.allow`) it stays null: the approval appears
 * as an independent row. Old marks (the call never came) are dropped by time.
 */
const DEFERRED_TOOL_USE_TTL_MS = 60_000
const MAX_DEFERRED_TOOL_USES = 16

/**
 * TODO 1061 (3): what one window's ViewerPane has in front now (one element of `inView` in `listOpenFiles`). In addition to the path, URL and title, a file carries the PDF page and the body of the selection (cut at 4000 characters, passed through redaction, not saved).
 * `unknown` means the renderer's notice has not arrived yet (right after a reload, for example).
 */
export type InViewEntry =
  | { readonly kind: 'web'; readonly tabId: string | null; readonly url: string; readonly title: string }
  | {
      readonly kind: 'file'
      readonly path: string
      /** A temporary view of a file inside an archive (TODO 1094): `path` is the archive, and this is the path inside the archive. */
      readonly entry?: string
      /** The current page of a PDF (1-based, TODO 1061 item 2). Only when the viewer reported it. */
      readonly page?: number
      /** The current selection (text etc.). The body is passed through redaction and its length is limited. */
      readonly selection?: ViewerShownSelection
    }
  /** A temporary view of a diff (no URI). If there is a selection (item 2 of TODO 1091), the body is passed through redaction and limited in length, same as for a file. */
  | { readonly kind: 'diff'; readonly selection?: ViewerShownSelection }
  | { readonly kind: 'none' }
  /** A viewer with no path (a conversation transcript `thread://` etc.). */
  | { readonly kind: 'other' }
  | { readonly kind: 'unknown' }

export function describeInView(
  report: ViewerShownReport | null,
  tabs: readonly (ReadableWebTab & { readonly shown: boolean })[]
): InViewEntry {
  if (report === null) return { kind: 'unknown' }
  if (report.kind === 'none') return { kind: 'none' }
  if (report.kind === 'diff') {
    const selection = report.selection
    return selection === undefined
      ? { kind: 'diff' }
      : { kind: 'diff', selection: { ...selection, text: redactText(selection.text).text } }
  }
  if (report.kind === 'web') {
    const tab = tabs.find((item) => item.shown)
    if (tab !== undefined) return { kind: 'web', tabId: tab.tabId, url: tab.url, title: tab.title }
    // A blank tab / the URL is not yet copied into the badge: only the renderer's URL (a blank tab if it is not http(s)).
    const url = report.uri !== null && isWebViewerUrl(report.uri) ? report.uri : 'about:blank'
    return { kind: 'web', tabId: null, url, title: '' }
  }
  // A file viewer. Anything other than `file:` (a conversation transcript etc.) has no path, so it is described only as "not a file" (58-3).
  const uri = report.uri
  if (uri === null) return { kind: 'unknown' }
  if (!uri.startsWith('file:')) return { kind: 'other' }
  try {
    const selection = report.selection
    return {
      kind: 'file',
      path: uriToPath(uri),
      ...(report.entry === undefined ? {} : { entry: report.entry }),
      ...(report.page === undefined ? {} : { page: report.page }),
      ...(selection === undefined ? {} : { selection: { ...selection, text: redactText(selection.text).text } })
    }
  } catch {
    return { kind: 'other' }
  }
}

/** The body of the gateway -> main entry point (7.6). `SessionManager.handleGatewayRequest` uses it as a thin delegate. */
export class GatewayRequests {
  /** `${threadId}\0${toolName}` -> held `tool_use_id`s (oldest first). */
  private readonly deferredToolUses = new Map<string, { readonly toolUseId: string; readonly at: number }[]>()

  constructor(private readonly host: GatewayRequestHost) {}

  /**
   * This gateway tool does not ask in the backend's permission check (`approve`); the tool stage (relay) itself queues it in the approval inbox
   * (plugin tools with side effects or needing first-time consent 847 / 848, settings changes that touch the choke point or updates 1060). Asking here would ask twice in strict mode.
   */
  private asksInToolStage(threadId: string, toolName: string, input: unknown): boolean {
    if (!toolName.startsWith(GATEWAY_TOOL_PREFIX)) return false
    const bare = toolName.slice(GATEWAY_TOOL_PREFIX.length)
    // TODO 1289: in an unattended turn the tool stage refuses `setSetting` and asks about `openUrl` itself (`handleSetSetting` /
    // `handleViewerRequest`); asking here too would ask twice, or ask about a change that is refused anyway.
    if ((bare === SET_SETTING_TOOL || bare === 'openUrl') && this.unattendedTurn(threadId)) return true
    if (bare === SET_SETTING_TOOL) {
      return isGatedSettingName((input as Record<string, unknown> | null | undefined)?.['name'])
    }
    const pluginTool = this.host.pluginTools?.lookup(bare) ?? null
    return pluginTool !== null && (pluginTool.sideEffect || pluginTool.pendingConsent.length > 0)
  }

  /**
   * TODO 1216: whether this tool may pass in an unattended read-only turn. Only the gateway's read tools, the extension tools allowed through
   * (`unattendedPluginToolPasses`), and the backend's built-in tools that the Adapter says are reads (those that are not an outbound operation).
   */
  private unattendedAllows(
    threadId: string,
    toolName: string,
    input: unknown,
    adapter: AgentAdapter | undefined
  ): boolean {
    if (toolName.startsWith(GATEWAY_TOOL_PREFIX)) {
      const bare = toolName.slice(GATEWAY_TOOL_PREFIX.length)
      if (UNATTENDED_GATEWAY_READ_TOOLS.has(bare)) return true
      const pluginTool = this.host.pluginTools?.lookup(bare) ?? null
      return pluginTool !== null && this.unattendedPluginToolPasses(threadId, pluginTool)
    }
    if ((adapter?.outboundAction?.(toolName, input) ?? null) !== null) return false
    return adapter?.unattendedReadOnlyTool?.(toolName, input) === true
  }

  /**
   * TODO 1227 (owner decision 2026-11-13): whether this extension's tool may pass in an unattended read-only turn. **Both the approval stage and the tool stage
   * consult this one function** (the decision is not written in two places). What passes is a tool that needs neither a side effect (`sideEffect`) nor first-time consent (`pendingConsent`):
   *  - A bundled extension (`bundled` = a value decided by main from where it loaded it, not the manifest's self-declaration) passes.
   *  - A non-bundled one passes only when the rule of the trigger that started the conversation lets that tool of **the extension that emitted the event itself**
   *    (`unattendedPluginToolAllowed`) by the user's grant. A conversation with no rule, or a tool of another extension, does not pass.
   * This is a choke point so that a tool of an outside extension that does not set `sideEffect` (declares itself a read) cannot run in an unattended turn without the user's explicit say.
   * It is not a Broker capability stage (7.7, "do not create trust tiers"): the reach of an extension (declaration, consent, policy) is the same for bundled and outside ones,
   * and this only narrows "which tools may be called in a turn nobody is watching".
   */
  private unattendedPluginToolPasses(threadId: string, tool: ResolvedPluginTool): boolean {
    if (tool.sideEffect || tool.pendingConsent.length > 0) return false
    if (tool.bundled) return true
    // Fix X: the grant is matched at the time of use against the current declaration (the fingerprint of the loaded extension's tool). A tool with no fingerprint does not pass.
    if (tool.fingerprint === '') return false
    return this.host.unattendedPluginToolAllowed?.(threadId, tool.pluginId, tool.declaration.name, tool.fingerprint) === true
  }

  /**
   * TODO 1216: whether this is an unattended read-only turn (the conversation's mark). The process keeps the flag even after the first turn
   * ends (it is restarted on the person's next send), but tool calls that arrive in between are stopped by the flag, so the choke point looks only at the conversation's mark.
   */
  private unattended(threadId: string): boolean {
    return this.host.isUnattendedReadOnly?.(threadId) === true
  }

  /**
   * TODO 1289: whether nobody is watching the turn running now (any unattended turn, wider than `unattended`). The judgment itself lives
   * in the host (`SessionManager.isUnattendedTurnNow`); every tool that refuses or asks in such a turn reads it through here.
   * The read-only mark implies it (a host that only wires `isUnattendedReadOnly` still closes).
   */
  private unattendedTurn(threadId: string): boolean {
    return this.unattended(threadId) || this.host.isUnattendedTurn?.(threadId) === true
  }

  /**
   * TODO 1216 (fix X): in an unattended read-only turn, the response (a per-kind shape) if this kind of request is refused at the tool stage, or null if it passes.
   * Everything outside the allowlist (`UNATTENDED_GATEWAY_PASS_KINDS`) is refused: a newly added gateway tool does not pass until whoever added it puts it in the list.
   */
  private unattendedKindDenied(request: GatewayRequest): unknown {
    if (UNATTENDED_GATEWAY_PASS_KINDS.has(request.kind)) return null
    const threadId = this.host.threadIdForSession(request.sessionId)
    if (threadId === undefined) return null
    // TODO 982: a drill stops the same kinds (the same allowlist, not a separate table), records them, and tells the model to carry on.
    if (this.drill(threadId)) {
      const { toolUseId: sent, callId: _callId, ...rest } = request.payload as Record<string, JsonValue>
      const toolUseId = typeof sent === 'string' && sent !== '' ? sent : null
      this.stopForDrill(request, threadId, `${GATEWAY_TOOL_PREFIX}${request.kind}`, rest, toolUseId, 'tool')
      const error = this.drillMessage(threadId)
      if (request.kind === OPEN_SETTINGS_TOOL || request.kind === 'openUrl' || request.kind === 'openFile' || request.kind === 'openDiff') {
        return { opened: false, error }
      }
      if (request.kind === 'startBundles') return { status: 'error', error }
      return { error }
    }
    if (!this.unattended(threadId)) return null
    log.info('approval.unattended.kind-denied', { threadId, kind: request.kind })
    if (request.kind === OPEN_SETTINGS_TOOL) return { opened: false, error: UNATTENDED_DENIED_MESSAGE }
    if (request.kind === 'startBundles') return { status: 'error', error: UNATTENDED_DENIED_MESSAGE }
    return { error: UNATTENDED_DENIED_MESSAGE }
  }

  /**
   * TODO 1216: leaves an approval that was refused without asking in the timeline (two rows, the request and the settlement, the same shape as `approve`).
   */
  private recordUnattendedDenial(
    request: GatewayRequest,
    threadId: string,
    toolName: string,
    input: JsonValue,
    toolUseId: string | null,
    reason: string = UNATTENDED_DENIED_REASON
  ): void {
    const eventId = randomUUID()
    const at = Date.now()
    const pending: AiosEvent = {
      id: eventId,
      sessionId: request.sessionId,
      threadId,
      ts: at,
      actor: 'main',
      kind: 'permission_request',
      payload: {
        requestId: eventId,
        toolUseId,
        toolName,
        summary: summarize(input),
        input,
        requestedAt: at,
        decidedAt: null,
        outcome: { kind: 'pending' }
      }
    }
    this.host.record(threadId, pending)
    this.host.record(threadId, {
      ...pending,
      payload: {
        ...pending.payload,
        decidedAt: at,
        outcome: { kind: 'denied', by: 'system', message: reason }
      }
    })
    if (reason === UNATTENDED_DENIED_REASON) log.info('approval.unattended.denied', { threadId })
  }

  /** TODO 982: whether the conversation is a drill (the DB mark; read on every request, never from memory). */
  private drill(threadId: string): boolean {
    return this.host.isDrill?.(threadId) ?? this.host.getThread(threadId)?.drill !== undefined
  }

  /**
   * TODO 982: stops one operation of a drill: the two timeline rows (asked, stopped by the system with `approval-cancelled-drill`) and the
   * drill's record. Nothing is run and nothing is queued. The log has only the thread, tool and stage (no argument values).
   */
  private stopForDrill(
    request: GatewayRequest,
    threadId: string,
    toolName: string,
    input: JsonValue,
    toolUseId: string | null,
    stage: DrillStop['stage']
  ): void {
    this.recordUnattendedDenial(request, threadId, toolName, input, toolUseId, DRILL_DENIED_REASON)
    log.info('approval.drill.stopped', { threadId, tool: toolName, stage })
    try {
      this.host.recordDrillOp?.(threadId, { toolName, input, toolUseId, stage })
    } catch (error) {
      // The stop itself stands; only the list misses a row.
      log.warn('approval.drill.record.failed', { threadId, message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** TODO 982: the text returned to the model for a drill's stop (the Adapter's `cancelled: drill`, or the neutral English text). */
  private drillMessage(threadId: string): string {
    const reply = { kind: 'cancelled', reason: 'drill' } as const
    const thread = this.host.getThread(threadId)
    const adapter = thread === null ? undefined : this.host.getAdapter(thread.backend)
    const text = adapter?.approvalReply?.(reply) ?? null
    // An Adapter whose table returns the empty string (= "stop the turn") is not followed here: a drill carries on.
    return text !== null && text !== '' ? text : (fallbackApprovalReply(reply) ?? '')
  }

  /**
   * TODO 1055 (review fix): whether this is a tool that reads or captures a Web tab. The first-time consent is asked by the tool stage (`askWebTabReadConsent`), so the approve stage
   * **keeps judging the rules and the choke point as before** and only yields the asking (`toolStageAsks`). It does not return `allowed: true` early and skip the whole decision.
   * `getViewerScreenshot` only when it captures a Web tab (when it captures a file viewer the tool stage does not ask, so yielding would leave nobody asking).
   */
  private yieldsAskToToolStage(toolName: string, threadId: string): boolean {
    if (!toolName.startsWith(GATEWAY_TOOL_PREFIX)) return false
    const bare = toolName.slice(GATEWAY_TOOL_PREFIX.length)
    if (bare === 'getOpenUrlText') return true
    if (bare !== 'getViewerScreenshot') return false
    // The same way of deciding as the window the tool stage (`getViewerScreenshot`) captures: the notice of the first window that has something in front.
    for (const viewId of this.host.viewsOf(threadId)) {
      const report = this.host.viewerShown?.(viewId, threadId) ?? null
      if (report === null || report.kind === 'none') continue
      return report.kind === 'web'
    }
    return false
  }

  private deferToolUse(threadId: string, toolName: string, toolUseId: string): void {
    const key = `${threadId}\0${toolName}`
    const now = Date.now()
    const list = (this.deferredToolUses.get(key) ?? []).filter((entry) => now - entry.at < DEFERRED_TOOL_USE_TTL_MS)
    list.push({ toolUseId, at: now })
    this.deferredToolUses.set(key, list.slice(-MAX_DEFERRED_TOOL_USES))
  }

  /**
   * `exact` is the `tool_use` id in the `_meta` that the CLI attached to the tool call (read by the gateway) (TODO 883). If present, use it and remove the
   * same held mark (so the attachment does not shift even with parallel calls). Otherwise the oldest one.
   */
  private takeDeferredToolUse(threadId: string, toolName: string, exact: string | null = null): string | null {
    const key = `${threadId}\0${toolName}`
    const now = Date.now()
    const list = (this.deferredToolUses.get(key) ?? []).filter((entry) => now - entry.at < DEFERRED_TOOL_USE_TTL_MS)
    if (exact !== null) {
      const at = list.findIndex((entry) => entry.toolUseId === exact)
      if (at >= 0) list.splice(at, 1)
      if (list.length === 0) this.deferredToolUses.delete(key)
      else this.deferredToolUses.set(key, list)
      return exact
    }
    const first = list.shift()
    if (list.length === 0) this.deferredToolUses.delete(key)
    else this.deferredToolUses.set(key, list)
    return first?.toolUseId ?? null
  }

  /**
   * The only gateway -> main entry point (7.6).
   * `sessionId` is already identified from the token, so the caller cannot be spoofed.
   */
  async handle(request: GatewayRequest): Promise<unknown> {
    const { host } = this
    // TODO 1216 (fix X): in an unattended read-only turn the tool stage is also narrowed by the allowlist (not relying on a per-kind list of refusals).
    const unattendedDenied = this.unattendedKindDenied(request)
    if (unattendedDenied !== null) return unattendedDenied
    // The search tools (7.6.1). **The `exposure` decision is made by IndexService, not the gateway**,
    // so this only forwards and holds no state.
    if (GATEWAY_VIEWER_KINDS.has(request.kind)) return this.handleViewerRequest(request)
    if (request.kind === 'approveCancelled') return this.handleApproveCancelled(request)
    if (request.kind === 'startBundles') return this.handleStartBundles(request)
    if (request.kind === 'pluginTools') return this.handlePluginTools()
    if (request.kind === 'pluginTool') return this.handlePluginTool(request)
    if (request.kind === 'getSettings') return this.handleGetSettings(request)
    if (request.kind === SET_SETTING_TOOL) return this.handleSetSetting(request)
    if (request.kind === OPEN_SETTINGS_TOOL) return this.handleOpenSettings(request)
    if (AI_REMINDER_KINDS.has(request.kind)) return this.handleReminder(request)
    if (request.kind !== 'approve') return this.handleIndexRequest(request)
    // An approval request that arrives after shutdown is refused without touching the DB (item 79). The Broker also returns
    // a system refusal for the same reason, but the `getThread` before it would already touch the DB.
    // The text returned to the model is a fixed English sentence (TODO 567). We cannot look up which Adapter (= thread) it is, so the sentence is neutral.
    if (host.isStopped()) {
      return { allowed: false, message: fallbackApprovalReply({ kind: 'cancelled', reason: 'quit' }) }
    }

    const threadId = host.threadIdForSession(request.sessionId)
    if (threadId === undefined) throw new Error('unknown session')
    const thread = host.getThread(threadId)
    if (thread === null) throw new Error('unknown thread')
    const live = host.getLive(threadId)

    const toolName = typeof request.payload['toolName'] === 'string' ? request.payload['toolName'] : '?'
    const toolUseId =
      typeof request.payload['toolUseId'] === 'string' ? request.payload['toolUseId'] : null
    // TODO 982: a drill stops everything outside the read-only allowlist **before any permission is looked at** (rules, the role's table,
    // "don't ask in this conversation", the default allow-everything, full delegation - none of them is reached), records it, and tells the
    // model to carry on as if it had run. The allowlist is the trigger's read-only one (`unattendedAllows`), not a separate table. A question
    // still goes to the person (it changes nothing; the person is watching the drill).
    if (
      this.drill(threadId) &&
      !this.unattendedAllows(threadId, toolName, request.payload['input'], host.getAdapter(thread.backend)) &&
      !isAnswerRequest(questionsOf(toolName, (request.payload['input'] ?? {}) as JsonValue))
    ) {
      this.stopForDrill(request, threadId, toolName, (request.payload['input'] ?? {}) as JsonValue, toolUseId, 'approve')
      return { allowed: false, message: this.drillMessage(threadId) }
    }
    // TODO 1216: a trigger's first (unattended) turn is read-only. Anything outside the table is refused **without asking** (not queued in the approval inbox, no notification).
    // Tools that ask at the tool stage (such as extension tools with side effects) are also stopped here (before the early `allowed: true` below).
    if (
      this.unattended(threadId) &&
      !this.unattendedAllows(threadId, toolName, request.payload['input'], host.getAdapter(thread.backend))
    ) {
      this.recordUnattendedDenial(request, threadId, toolName, (request.payload['input'] ?? {}) as JsonValue, toolUseId)
      return { allowed: false, message: UNATTENDED_DENIED_MESSAGE }
    }
    // TODO 847: a plugin tool with side effects always asks in the approval inbox every time the relay (`handlePluginTool`) is called.
    // Queuing here too (the backend's permission check) would ask twice in strict mode, so pass here.
    // The relay side never passes through, whether default, rules or strict mode (`alwaysAsk`), so passing here does not miss asking.
    // The `permission_request` record is also owned by the relay stage (recording here would leave an "allowed" row before the user's answer).
    // Here only the `tool_use_id` is held (wave 45 code-review).
    // TODO 1060: a settings change that touches the choke point or updates (the gated `setSetting`) is likewise asked by the tool stage every time (`alwaysAsk`). A display-preference
    // change is handled here like an ordinary mcp__* (default is auto-allow).
    if (this.asksInToolStage(threadId, toolName, request.payload['input'])) {
      if (toolUseId !== null) this.deferToolUse(threadId, toolName, toolUseId)
      log.info('approval.tool-stage.deferred', { threadId })
      return { allowed: true, message: '' }
    }
    // The mark of one gateway call (TODO 632). Used to match the cancel notice (`approveCancelled`).
    const callId = typeof request.payload['callId'] === 'string' ? request.payload['callId'] : null
    const input = (request.payload['input'] ?? {}) as JsonValue
    // Whether this is a plan presentation (item 112) and a write that can show a diff (item 97). Both the tool name and the
    // shape of the arguments are backend-specific, so ask the Adapter (constraint 6).
    const adapter = host.getAdapter(thread.backend)
    const plan = adapter?.planProposal?.(toolName, input) ?? null
    // The summary of a plan presentation would show the body (Markdown) crushed into one long line, so make it empty and keep only the line count
    // (an observation of item 196; the timeline shows "plan (N lines)").
    const summary = plan === null ? summarize(input) : ''
    // The counting is the same "non-empty lines" as the timeline's `PlanBlock` (item 167).
    const planLines = plan === null ? undefined : plan.split('\n').filter((line) => line.trim() !== '').length
    const diffable = (adapter?.writePreview?.(toolName, input) ?? null) !== null
    // TODO 959: whether this is an outbound operation (send, post, write to a remote). The shape of the tool name is backend-specific, so ask the Adapter.
    // If it matches, the Broker never lets it pass under default, rules or strict mode, and asks in the approval inbox every time (4.2.1).
    // (The "push destination we do not ask about" of TODO 1013 stopped working in 1031 and was removed in 1048.)
    const outbound = adapter?.outboundAction?.(toolName, input) ?? null
    // TODO 1042: writes that would linger or defeat the choke point (shell startup files, the CLI's settings, .git/hooks, crontab ...). A relative
    // path of a write tool is resolved against the conversation's working folder, and the symlink target (realpath) is checked too.
    const persistence =
      adapter?.persistenceAction?.(toolName, input, (path) => resolvedWritePaths(path, workingCwdOf(thread))) ?? null
    // TODO 1043: mark it if the call reads a secret (the Broker sets the mark); if it is a way out, ask in a thread that has the mark.
    const secretRead = adapter?.secretReadAction?.(toolName, input) ?? null
    const egress = adapter?.egressAction?.(toolName, input) ?? null
    // TODO 1106: a request to "run outside the sandbox" (the AI retrying) from a process started with the OS sandbox enabled. The Broker refuses without asking.
    // What is checked is **the setting at the time this process was started** (`Live.osSandbox`): even if toggled with the ellipsis menu, the current process stays as it is until the next launch.
    const sandboxed = live?.osSandbox ?? thread.osSandbox === true
    const unsandboxed = sandboxed && adapter?.unsandboxedRequest?.(toolName, input) === true
    // Whether the user had turned Plan on (item 167). A plan that the AI presented by entering plan mode itself while it was OFF
    // is handled by the Broker like any other tool (with the default it passes automatically, and the body stays in the timeline's
    // `tool_use.payload.plan`). Decided by the toggle at the moment the request arrives.
    const planRequested = plan !== null && host.hasPlanMode(threadId)
    // TODO 983 (4.2.5): attach the permission table's role only for role conversations (a Teammate's conversation, or a scheduled job's). Built from main's
    // rows on every request (stage 4: so a conversation moved to another Teammate gets the new Teammate's table). A conversation with no role does not consult the table.
    const role = host.roleOf?.(threadId) ?? null
    // Wave 91 983 stage 3: "do not ask in this conversation" for a strict conversation with no role uses the same target (memory only). A non-strict conversation does not consult it.
    const buildGrantSubject = (): GrantSubject | null =>
      adapter?.grantSubjectOf?.(toolName, input, (path) => resolvedGrantPath(path, workingCwdOf(thread))) ?? null
    // The target is built only when the broker needs it (do not run realpath synchronously): stage 4 made every Teammate conversation a role
    // conversation, most of which pass by the default before the table is looked at.
    let lazySubject: { value: GrantSubject | null } | null = null
    const grantSubjectOf =
      role !== null || thread.approvalStrict
        ? (): GrantSubject | null => (lazySubject ??= { value: buildGrantSubject() }).value
        : null

    // Item 97 second half: the draft conflict notice. It has no say in whether to approve (the default is auto-allow, T40):
    // this notification does not wait for the result of the following `broker.request`.
    this.notifyDraftConflict(threadId, thread, toolName, input)

    const eventId = randomUUID()
    const requestedAt = Date.now()

    if (live !== undefined) {
      live.pendingApprovals.add(eventId)
      live.state = 'awaiting-approval'
      host.emitThread(threadId)
    }

    const pendingEvent: AiosEvent = {
      id: eventId,
      sessionId: request.sessionId,
      threadId,
      ts: requestedAt,
      actor: 'main',
      kind: 'permission_request',
      payload: {
        requestId: eventId,
        toolUseId,
        toolName,
        summary,
        input,
        requestedAt,
        decidedAt: null,
        outcome: { kind: 'pending' },
        ...(planLines === undefined ? {} : { planLines })
      }
    }
    host.record(threadId, pendingEvent)

    // TODO 1073: even if it throws, do not leave the id in `pendingApprovals`, and restore `awaiting-approval` (settle in finally).
    let result: ApprovalResult
    try {
    result = await host.requestApproval({
      threadId,
      threadTitle: thread.title,
      toolName,
      summary,
      input,
      strict: thread.approvalStrict,
      // Not used for the decision (the cwd rule of T26 was removed in T40, 4.2.1.1). For the log and a future entry point,
      // pass **the same derivation as the cwd passed when starting the session** (the `cwd` of `spawn`; if it moved into a worktree, that one,
      // the fix of the TODO 633 code-review).
      cwd: workingCwdOf(thread),
      // Which child the request is from (item 93). Display only.
      subtask: live === undefined ? null : host.subtaskOfToolUse(threadId, toolUseId),
      plan,
      planRequested,
      diffable,
      // A clue for withdrawing when the backend stops waiting (TODO 632). Not used for the decision.
      toolUseId,
      callId,
      ...(outbound === null ? {} : { outbound }),
      ...(persistence === null ? {} : { persistence }),
      ...(secretRead === null ? {} : { secretRead }),
      ...(egress === null ? {} : { egress }),
      ...(unsandboxed ? { unsandboxed: true } : {}),
      ...(role === null ? {} : { role }),
      ...(grantSubjectOf === null ? {} : { grantSubjectOf }),
      // TODO 1055: tools that read or capture a Web tab yield only the asking to the tool stage's consent (the decision lets it pass).
      ...(this.yieldsAskToToolStage(toolName, threadId) ? { toolStageAsks: true } : {}),
      // An unattended turn of a scheduled job waits until the next scheduled time and is refused after that (owner decision 2026-10-24).
      ...expiryOf(host, threadId)
    })

    // Once a plan is accepted (item 112), the CLI proceeds to implementation in the same turn and leaves plan itself,
    // returning to the default mode (spike 22: the next turn's init is default). Return both the toggle and the process record to OFF.
    // For a plan the user did not ask for (item 167) the toggle was OFF to begin with, so it is not touched.
    if (plan !== null && planRequested && result.allowed) {
      host.clearPlanMode(threadId)
      const current = host.getLive(threadId)
      if (current !== undefined) current.planMode = false
      log.info('thread.planMode', { threadId, on: false, reason: 'plan-approved' })
      // If there is a `live`, the cleanup right after distributes. Otherwise distribute here.
      if (live === undefined) host.emitThread(threadId)
    }
    } catch (error) {
      // Leave the settlement row (equivalent to a refusal, the reason is an internal error). Without it the UI would keep an "approval that is neither allowed nor refused".
      host.record(threadId, {
        ...pendingEvent,
        payload: {
          ...pendingEvent.payload,
          decidedAt: Date.now(),
          outcome: { kind: 'denied', by: 'system', message: 'internal-error' }
        }
      })
      throw error
    } finally {
      if (live !== undefined) settleApproval(host, threadId, live, eventId)
    }

    host.record(threadId, {
      ...pendingEvent,
      payload: { ...pendingEvent.payload, decidedAt: Date.now(), outcome: decidedOutcome(result) }
    })

    // When the user refused, return to the model the same sentence the backend's interactive screen returns (items 182 / 183).
    // The sentence is in the compat table and the Adapter builds it. If it cannot, a neutral English sentence (TODO 567: previously the Broker's
    // fixed Japanese sentence arrived as is); for the shape that has neither (an instruction), the Broker's `message` (= the user's sentence).
    const message =
      result.reply === undefined
        ? result.message
        : (adapter?.approvalReply?.(result.reply) ?? fallbackApprovalReply(result.reply) ?? result.message)

    // `updatedInput` is attached only when returning an answer (T31 / 4.2.2). If it is present the gateway
    // returns it to the backend as is; otherwise it echoes the original arguments.
    return {
      allowed: result.allowed,
      message,
      ...(result.updatedInput === undefined ? {} : { updatedInput: result.updatedInput })
    }
  }

  /** The list of plugin tools the gateway fetches once at startup (TODO 847, 7.6.7). */
  private handlePluginTools(): unknown {
    if (this.host.isStopped()) return { tools: [] }
    return { tools: this.host.pluginTools?.list() ?? [] }
  }

  /**
   * Calls a plugin tool once (TODO 847, 7.6.7). Lookup and re-validation of the arguments -> if `sideEffect: true`, ask the user in the approval inbox
   * (**every time, regardless of the default auto-allow or strict mode**, owner decision 2026-10-15) ->
   * to plugin-host. The return value is JSON returned to the model as is (a failure is `{ error }`).
   */
  private async handlePluginTool(request: GatewayRequest): Promise<unknown> {
    const { host } = this
    if (host.isStopped()) return { error: 'aios is shutting down' }
    const relay = host.pluginTools
    if (relay === undefined) return { error: 'plugin tools are not available' }
    const threadId = host.threadIdForSession(request.sessionId)
    if (threadId === undefined) throw new Error('unknown session')
    const thread = host.getThread(threadId)
    if (thread === null) throw new Error('unknown thread')
    const prepared = relay.prepare(request.payload['name'], request.payload['arguments'])
    if (!prepared.ok) return { error: prepared.error }
    const { tool, args } = prepared
    // TODO 848: if the declared "needs first-time consent" capability (`browser` = the cookies of the logged-in Web view) has no consent yet,
    // ask once in the approval inbox before calling (even for a read tool). If it passes, record the consent and do not ask afterwards (it can be revoked in the extension view).
    const needsConsent = tool.pendingConsent.length > 0
    // TODO 1043: in a conversation that read a secret, read plugin tools are asked too (arguments can send it out: search terms, URLs).
    const secretAsk = host.hasReadSecret?.(threadId) === true

    // TODO 982: a drill stops the same calls (even if the `approve` stage was skipped) and records them.
    if (this.drill(threadId) && (secretAsk || !this.unattendedPluginToolPasses(threadId, tool))) {
      const sent = request.payload['toolUseId']
      this.stopForDrill(
        request,
        threadId,
        `${GATEWAY_TOOL_PREFIX}${tool.exposedName}`,
        args as JsonValue,
        typeof sent === 'string' && sent !== '' ? sent : null,
        'tool'
      )
      return { error: this.drillMessage(threadId) }
    }
    // TODO 1216: an unattended read-only turn refuses, without asking, a call that would need asking (even if the `approve` stage was skipped).
    // TODO 1227: tools of extensions that are neither bundled nor allowed by a rule are also refused (the same decision as the approval stage, `unattendedPluginToolPasses`).
    if (this.unattended(threadId) && (secretAsk || !this.unattendedPluginToolPasses(threadId, tool))) {
      const sent = request.payload['toolUseId']
      this.recordUnattendedDenial(
        request,
        threadId,
        `${GATEWAY_TOOL_PREFIX}${tool.exposedName}`,
        args as JsonValue,
        typeof sent === 'string' && sent !== '' ? sent : null
      )
      return { error: UNATTENDED_DENIED_MESSAGE }
    }
    if (tool.sideEffect || needsConsent || secretAsk) {
      // The name shown in the approval inbox has the same shape as the name the backend shows (`mcp__aios__<name in the gateway>`).
      const toolName = `${GATEWAY_TOOL_PREFIX}${tool.exposedName}`
      const sent = request.payload['toolUseId']
      const toolUseId = this.takeDeferredToolUse(threadId, toolName, typeof sent === 'string' && sent !== '' ? sent : null)
      // When one ask serves as both consent and side-effect approval, add a summary of the arguments to the consent text (so the contents of the call are visible).
      const argsSummary = summarize(args as JsonValue)
      const summary = !needsConsent
        ? argsSummary
        : tool.sideEffect && argsSummary !== ''
          ? `${consentSummary(tool)} — ${argsSummary}`
          : consentSummary(tool)
      // Leave the same `permission_request` pending / decided as the `approve` path (wave 45 code-review).
      // The approval inbox is asked once (the `approve` stage has been passed).
      const result = await this.askInInbox(request, threadId, thread, {
        toolName,
        summary,
        input: args as JsonValue,
        toolUseId,
        subtask: true,
        // Side effects and consent are asked every time (847 / 848). If it is only the secret mark, ask as a way out (the reason becomes "read a secret").
        ask: tool.sideEffect || needsConsent ? { alwaysAsk: true } : { egress: 'plugin-tool' }
      })
      if (!result.allowed) {
        relay.recordDenied(tool, result)
        // The same sentence as `approve` (items 182 / 183, TODO 567): the Adapter builds it from the refusal shape. If it cannot, a neutral English sentence.
        return { error: this.deniedMessage(thread, result, 'The user denied this tool use. The tool was NOT run.') }
      }
      if (host.isStopped()) return { error: 'aios is shutting down' }
      if (needsConsent && !relay.grantConsent(tool)) return { error: 'this tool needs a consent aios cannot record' }
    }
    return relay.run(tool, args)
  }

  /**
   * TODO 1060 (7.6.8): the list of aios's own settings (name, current value, default, allowed values, whether changing needs approval). Read only.
   * Keys with no classification in the key table (secrets, consent records, internal state) are not listed.
   */
  private handleGetSettings(request: GatewayRequest): unknown {
    const { host } = this
    if (host.isStopped()) return { error: 'aios is shutting down' }
    if (host.threadIdForSession(request.sessionId) === undefined) throw new Error('unknown session')
    const settings = host.appSettings?.() ?? null
    if (settings === null) return { error: 'aios settings are not available right now' }
    const names = request.payload['names']
    return settings.list(Array.isArray(names) ? names : undefined)
  }

  /**
   * TODO 1060 (7.6.8): changes one of aios's own settings. The value is re-validated in main (the gateway is not trusted, item 86).
   * Keys that touch the choke point or updates (`gated`) are asked in the approval inbox **every time** (`alwaysAsk`: they never pass under the default
   * auto-allow, rules or strict mode, owner decision 2026-10-31). Display preferences (`display`) are changed without asking. The change goes through the existing setter,
   * so the notice to windows is sent the same as when changed from the settings screen.
   */
  private async handleSetSetting(request: GatewayRequest): Promise<unknown> {
    const { host } = this
    if (host.isStopped()) return { error: 'aios is shutting down' }
    const threadId = host.threadIdForSession(request.sessionId)
    if (threadId === undefined) throw new Error('unknown session')
    const thread = host.getThread(threadId)
    if (thread === null) throw new Error('unknown thread')
    // TODO 1216: an unattended read-only turn does not change settings.
    if (this.unattended(threadId)) return { error: UNATTENDED_DENIED_MESSAGE }
    // Take back the mark the `approve` stage held (same as plugin tools, wave 45).
    const sent = request.payload['toolUseId']
    const toolUseId = this.takeDeferredToolUse(
      threadId,
      `${GATEWAY_TOOL_PREFIX}${SET_SETTING_TOOL}`,
      typeof sent === 'string' && sent !== '' ? sent : null
    )
    // TODO 1289 (owner decision 2026-11-21): no unattended turn changes settings, whatever the key (display or gated). Reading stays.
    if (this.unattendedTurn(threadId)) {
      log.info('gateway.setting.unattended-denied', { threadId })
      return { error: SETTING_UNATTENDED_MESSAGE }
    }
    const settings = host.appSettings?.() ?? null
    if (settings === null) return { error: 'aios settings are not available right now' }
    const name = request.payload['name']
    const value = request.payload['value']
    const prepared = settings.prepare(name, value)
    if (!prepared.ok) return { error: prepared.error }
    const change = prepared.value
    if (change.unchanged) return { ok: true, changed: false, name: change.name, value: change.previous }
    if (change.access === 'gated') {
      const result = await this.askInInbox(request, threadId, thread, {
        toolName: `${GATEWAY_TOOL_PREFIX}${SET_SETTING_TOOL}`,
        summary: change.summary,
        input: { name: change.name, value: change.value as JsonValue },
        toolUseId,
        subtask: true,
        // TODO 1175: a change to a choke point setting is asked even in full-delegation mode (`settingsGate`).
        ask: { alwaysAsk: true, settingsGate: true }
      })
      if (host.isStopped()) return { error: 'aios is shutting down' }
      if (!result.allowed) {
        return { error: this.deniedMessage(thread, result, 'The user did not allow this change. The setting was NOT changed.') }
      }
    }
    try {
      const committed = settings.commit(change)
      // Do not log values (Conventions). Only the name and the classification.
      log.info('gateway.setting.changed', { threadId, name: change.name, access: change.access })
      return { ok: true, changed: true, ...committed }
    } catch (err) {
      log.warn('gateway.setting.failed', { threadId, name: change.name })
      return { error: `the setting could not be changed: ${err instanceof Error ? err.message : 'error'}` }
    }
  }

  /**
   * TODO 1265 (7.6.9): the reminder tools. The conversation is identified from the session token (the gateway cannot name another one), the arguments are
   * re-validated by `AiReminderGate` (caps, time range, the one fixed notification-only kind), and nothing here asks the user (a notification is harmless
   * and the caps bound the volume; the list in Settings lets the user see and delete them).
   */
  private handleReminder(request: GatewayRequest): unknown {
    const { host } = this
    if (host.isStopped()) return { error: 'aios is shutting down' }
    const threadId = host.threadIdForSession(request.sessionId)
    if (threadId === undefined) throw new Error('unknown session')
    // TODO 1216: an unattended turn does not register anything that would fire later on its own.
    if (this.unattended(threadId)) return { error: UNATTENDED_DENIED_MESSAGE }
    // Code-review (wave 96 fix Y): neither does a scheduled job's unattended turn (7.6.9), which the read-only flag above does not cover.
    // Listing stays (it only shows this conversation's own rows and changes nothing).
    if (request.kind !== 'listReminders' && this.unattendedTurn(threadId)) {
      log.info('gateway.reminder.unattended-denied', { threadId, kind: request.kind })
      return { error: AI_REMINDER_UNATTENDED_MESSAGE }
    }
    const gate = host.aiReminders?.() ?? null
    if (gate === null) return { error: 'reminders are not available right now' }
    if (request.kind === 'listReminders') return gate.list(threadId)
    if (request.kind === 'cancelReminder') {
      const result = gate.cancel(threadId, request.payload['id'])
      log.info('gateway.reminder.cancel', { threadId, ok: 'ok' in result })
      return result
    }
    const result = gate.register(threadId, request.payload)
    log.info('gateway.reminder.add', { threadId, ok: 'ok' in result })
    return result
  }

  /**
   * TODO 1060 stage 2 (7.6.8): in the window showing this conversation, opens the settings screen and scrolls to and highlights the item `name`.
   * The name is checked against the same table as `getSettings` / `setSetting`, and a name not in the table is refused (the gateway is not trusted, item 86).
   * It does not change the value and only opens, so it is not queued in the approval inbox (the `approve` stage handles it under the usual default, 167). No URL scheme
   * inside aios is added (no more URL checks, owner decision 2026-10-31). The instruction to the window uses the same `onViewerCommand` as `openUrl` / `openDiff`.
   */
  private handleOpenSettings(request: GatewayRequest): unknown {
    const { host } = this
    if (host.isStopped()) return { error: 'aios is shutting down' }
    const threadId = host.threadIdForSession(request.sessionId)
    if (threadId === undefined) throw new Error('unknown session')
    // TODO 1216: an unattended read-only turn does not move a person's screen.
    if (this.unattended(threadId)) return { opened: false, error: UNATTENDED_DENIED_MESSAGE }
    const checked = checkSettingName(request.payload['name'])
    if (!checked.ok) return { opened: false, error: checked.error }
    const name = checked.value
    // Even if the same conversation is shown in several windows, show the settings screen in only one window (so that not both are covered).
    const view = host.primaryViewOf(threadId)
    if (view !== null) host.onViewerCommand(view, { kind: 'settings', threadId, name })
    log.info('gateway.settings.open', { threadId, name, windows: view === null ? 0 : 1 })
    return view !== null
      ? { opened: true, name, windows: 1 }
      : {
          opened: false,
          name,
          windows: 0,
          error: 'No window is showing this conversation now, so the settings screen could not be opened.'
        }
  }

  /**
   * Starts bundle conversations (TODO 633 stage 3, 7.6.6). Check -> **show the list of bundles once as a choice question** -> once approved,
   * create a conversation with a worktree for each bundle. After that nothing is asked (the child conversations use the same approval default as a normal conversation, 167).
   * The return value is JSON returned to the model as is. While waiting on the question, the calling conversation is put in "awaiting approval" (same as `approve`).
   */
  private async handleStartBundles(request: GatewayRequest): Promise<unknown> {
    const { host } = this
    if (host.isStopped()) return { status: 'error', error: 'aios is shutting down' }
    const threadId = host.threadIdForSession(request.sessionId)
    if (threadId === undefined) throw new Error('unknown session')
    const thread = host.getThread(threadId)
    if (thread === null) throw new Error('unknown thread')
    // TODO 1216: an unattended read-only turn does not create bundle conversations.
    if (this.unattended(threadId)) return { status: 'error', error: UNATTENDED_DENIED_MESSAGE }
    const parsed = parseBundles(request.payload['bundles'], host.bundleMax())
    if (!parsed.ok) return { status: 'error', error: parsed.error }
    // TODO 1122: if the parent's backend cannot start in a worktree, refuse before asking the user (the reason is returned to the model).
    const refused = host.bundlePrecheck(parsed.bundles.length, thread)
    if (refused !== null) return { status: 'error', error: refused }

    const callId = typeof request.payload['callId'] === 'string' ? request.payload['callId'] : null
    const asked = bundleQuestionInput(parsed.bundles)
    const live = host.getLive(threadId)
    const eventId = randomUUID()
    if (live !== undefined) {
      live.pendingApprovals.add(eventId)
      live.state = 'awaiting-approval'
      host.emitThread(threadId)
    }
    let result: ApprovalResult
    try {
      result = await host.requestApproval({
        threadId,
        threadTitle: thread.title,
        toolName: ASK_TOOL,
        summary: asked.question.split('\n')[0] ?? '',
        input: asked.input,
        strict: thread.approvalStrict,
        cwd: workingCwdOf(thread),
        subtask: null,
        toolUseId: null,
        callId,
        ...expiryOf(host, threadId)
      })
    } finally {
      if (live !== undefined) settleApproval(host, threadId, live, eventId)
    }
    const answers = (result.updatedInput as { answers?: Record<string, unknown> } | undefined)?.answers
    const picked = answers?.[asked.question]
    if (!result.allowed || picked !== BUNDLE_START_LABEL) {
      return { status: 'declined', message: 'The user did not approve starting these bundles. Do the work yourself or ask what to do instead.' }
    }
    return host.startBundles(threadId, parsed.bundles)
  }

  /**
   * The gateway reported that "the approval call was cancelled by the backend" (TODO 632, 7.6.5).
   * It comes from the backend's hard timeout (`notifications/cancelled`). Removes it from the inbox and leaves
   * "cancelled by timeout" in the timeline (`approval-cancelled-tool-timeout`). If it is already settled, does nothing:
   * an interrupt or stop has already been handled by main with `cancelThread` first.
   */
  private handleApproveCancelled(request: GatewayRequest): { cancelled: boolean } {
    const { host } = this
    if (host.isStopped()) return { cancelled: false }
    const threadId = host.threadIdForSession(request.sessionId)
    if (threadId === undefined) return { cancelled: false }
    const asId = (key: string): string | null =>
      typeof request.payload[key] === 'string' ? (request.payload[key] as string) : null
    const cancelled = host.cancelApprovalRequest(
      threadId,
      { callId: asId('callId'), toolUseId: asId('toolUseId') },
      'tool-timeout'
    )
    return { cancelled }
  }

  /**
   * The draft conflict notice (item 97 second half, continuation of 7.6.2). If the target path of a write tool (`Edit` / `Write` etc.,
   * only tools that `AgentAdapter.writeToolTargetPath` knows) matches the current draft of **a window showing that thread**,
   * only that window is notified.
   *
   * **It has no say in whether to approve**: by default writes are also auto-allowed (T40), and this is called without waiting for
   * the result of `broker.request`. The path does not go through `assertAllowed` (it is not a permission decision; it is material for a notice that
   * only checks for a match with the draft memory). A relative path is resolved against the conversation's working folder (if it moved into a worktree, that one:
   * the CLI runs there, TODO 633) (`resolveToolPath`, the same resolution as gateway paths).
   */
  private notifyDraftConflict(threadId: string, thread: Thread, toolName: string, input: JsonValue): void {
    const { host } = this
    const adapter = host.getAdapter(thread.backend)
    const raw = adapter?.writeToolTargetPath?.(toolName, input) ?? null
    if (raw === null) return
    const absolute = resolveToolPath(raw, workingCwdOf(thread))
    if (absolute === null) return
    const targetUri = pathToUri(absolute)
    const viewIds = host.conflictingViews(host.viewsOf(threadId), targetUri)
    for (const viewId of viewIds) {
      host.onViewerCommand(viewId, { kind: 'draftConflict', threadId, uri: targetUri, toolName })
    }
    if (viewIds.length > 0) log.info('draft.conflict.notified', { threadId, windows: viewIds.length })
  }

  /**
   * TODO 1235: makes the target of `getDocument` / `getDocumentText` a rowid. If there is an `id`, that (as before); otherwise
   * `uri` or `source` + `source_id` is resolved to one row in the index process. **The lookup goes only as far as the id; the body checks (exclusion rules,
   * realpath, exposure, redaction) take the same path as when called by rowid.** For 0 or several rows, returns the reason without reading the fs.
   * No SQL runs on main's JS thread (an RPC of `IndexClient`).
   */
  private async documentIdOf(payload: Record<string, unknown>): Promise<{ id: string } | { error: string }> {
    const text = (key: string): string => (typeof payload[key] === 'string' ? (payload[key] as string) : '')
    if (text('id') !== '') return { id: text('id') }
    const uri = text('uri')
    const source = text('source')
    const sourceId = text('source_id')
    if (uri === '' && (source === '' || sourceId === '')) {
      return { error: 'pass id, or uri, or source together with source_id' }
    }
    const found = await this.host.index.resolveDocument(
      uri !== '' ? { uri, ...(source !== '' ? { source } : {}) } : { source, sourceId },
      true
    )
    if ('id' in found) return found
    if (found.reason === 'ambiguous') return { error: 'more than one document matches; narrow it with source' }
    if (found.reason === 'source-required') {
      return { error: 'a uri alone cannot be looked up here: pass source too (or source with source_id). Only thread:// and transcript:// uris need no source' }
    }
    if (found.reason === 'unsupported') {
      return { error: 'this lookup does not apply to files (use searchFiles / Read) or to an empty query' }
    }
    return { error: 'no document matches' }
  }

  /** Forwards the gateway's search tools (7.6.1) to IndexService. */
  private async handleIndexRequest(request: GatewayRequest): Promise<unknown> {
    const { host } = this
    const payload = request.payload
    const asString = (key: string): string =>
      typeof payload[key] === 'string' ? (payload[key] as string) : ''
    const asNumber = (key: string, fallback: number): number =>
      typeof payload[key] === 'number' && Number.isFinite(payload[key] as number)
        ? Math.trunc(payload[key] as number)
        : fallback

    switch (request.kind) {
      case 'search': {
        const scope = payload['source'] === 'conversation' ? 'conversation' : 'files'
        // The gateway's zod narrows the shape, but main does not trust the gateway (item 86).
        // Empty / absent means "do not narrow"; otherwise only the three allowlisted ones and the sources declared by currently enabled extensions (TODO 1225).
        const rawSource = payload['source']
        if (
          rawSource !== undefined &&
          rawSource !== '' &&
          (typeof rawSource !== 'string' ||
            (!GATEWAY_SEARCH_SOURCES.has(rawSource) && !(host.pluginIndexSources?.() ?? []).includes(rawSource)))
        ) {
          throw reasonError('invalid-value', { field: 'source' })
        }
        const sources = typeof rawSource === 'string' && rawSource !== '' ? [rawSource] : undefined
        const result = await host.index.search(asString('query'), scope, {
          limit: asNumber('limit', 20),
          forAgent: true,
          ...(sources === undefined ? {} : { sources })
        })
        return {
          hits: result.hits.map((hit) => ({
            id: hit.id,
            uri: hit.uri,
            title: hit.title,
            source: hit.source,
            kind: hit.kind,
            updated_at: hit.updatedAt,
            score: hit.score,
            snippet: hit.snippet,
            // TODO 1253: a conversation hit also names its thread, with a link the user can press to move there
            // (`thread://<threadId>`, no event). The title is the thread's name (redacted by the index process).
            // An untitled thread has an empty title, and a thread whose name could not be read falls back to the
            // message's role label (`context`): neither is a name, so `thread_title` is left out then.
            ...(hit.source === 'conversation' && hit.threadId !== null
              ? {
                  thread_uri: `thread://${hit.threadId}`,
                  ...(hit.title.trim() !== '' && hit.title !== hit.context ? { thread_title: hit.title } : {})
                }
              : {})
          })),
          total: result.total,
          truncated: result.truncated,
          // smart case (TODO 291): a term containing capitals made it case-sensitive. The same rule as the UI.
          ...(result.caseSensitive === true ? { case_sensitive: true } : {})
        }
      }
      case 'searchFiles':
        return this.searchFiles(request, asString('query'), Math.min(Math.max(asNumber('limit', 20), 1), 50))
      case 'getDocument': {
        const target = await this.documentIdOf(payload)
        if ('error' in target) return target
        return host.index.getDocument(target.id, asNumber('limit', 8192), true)
      }
      case 'getDocumentText': {
        const target = await this.documentIdOf(payload)
        if ('error' in target) return target
        return host.index.getDocumentText(
          target.id,
          asNumber('offset', 0),
          asNumber('length', 24 * 1024),
          true
        )
      }
      case 'getChunk':
        return host.index.getChunk(asString('id'), true)
      default:
        throw new Error(`unsupported request: ${request.kind}`)
    }
  }

  /**
   * The gateway's `searchFiles` (TODO 1158, 7.6.1): gives the conversation's CLI the file name search (the same matching as ⌘P). Matches inside the conversation's
   * working folder (if it moved into a worktree, that one) are returned first as a `cwd` section. If the working folder does not pass the choke point
   * (`assertAllowed`) there is no section (the search continues: same as ⌘P's cwd). The returned rows are re-checked against the current exclusion rules (rows whose
   * rules changed after indexing are not given to the AI; the same idea as `fsVerdict` for the snippet of `search`). The body is not read.
   */
  private async searchFiles(request: GatewayRequest, query: string, limit: number): Promise<unknown> {
    const { host } = this
    if (host.isStopped()) return { error: 'aios is shutting down' }
    const threadId = host.threadIdForSession(request.sessionId)
    const thread = threadId === undefined ? null : host.getThread(threadId)
    let cwdUri: string | undefined
    if (thread !== null) {
      try {
        host.fs.assertAllowed(workingCwdUri(thread), true, 'read')
        cwdUri = workingCwdUri(thread)
      } catch {
        cwdUri = undefined
      }
    }
    const result = await host.index.searchFilesForAgent(query, limit, cwdUri)
    // A result cut off because the index is stopped / in the middle of a restart is not "0 hits". Returning an empty list would make the AI
    // conclude "that file does not exist", so make it a tool error and have it query again later (wave 71 review X).
    if (result.cancelled) {
      return { error: 'aios file index is unavailable right now (stopped or restarting). Retry later.', reason: 'index-unavailable' }
    }
    /**
     * The rows re-checked against the current exclusion rules, and the total minus the dropped ones. `truncated` means "there are more than the rows returned"
     * or "the scan was cut off", and does not count dropped rows as "still there" (keeps the meaning of `total` and `hits.length` aligned).
     */
    const section = (
      entries: readonly FileEntry[],
      total: number,
      truncated: boolean
    ): { hits: GatewayFileHit[]; total: number; truncated: boolean } => {
      const hits = toHits(entries)
      const counted = Math.max(hits.length, total - (entries.length - hits.length))
      return { hits, total: counted, truncated: truncated || counted > hits.length }
    }
    const toHits = (entries: readonly FileEntry[]): GatewayFileHit[] => {
      const hits: GatewayFileHit[] = []
      for (const entry of entries) {
        let path: string
        try {
          path = host.fs.assertAllowed(entry.uri, entry.isDirectory, 'read')
        } catch {
          continue
        }
        hits.push({
          // A folder has no body, so no id is attached (passing it to `getDocument` would read nothing).
          ...(entry.documentId === undefined || entry.isDirectory ? {} : { id: String(entry.documentId) }),
          uri: entry.uri,
          path,
          name: entry.name,
          kind: entry.isDirectory ? 'directory' : 'file',
          size: entry.size,
          modified_at: entry.mtimeMs
        })
      }
      return hits
    }
    const cwd = result.cwd
    const rest = section(result.entries, result.total, result.scanTruncated)
    return {
      ...(cwd === null
        ? {}
        : { in_working_folder: { path: uriToPath(cwd.uri), ...section(cwd.entries, cwd.total, cwd.scanTruncated) } }),
      hits: rest.hits,
      total: rest.total,
      truncated: rest.truncated,
      ...(result.caseSensitive === true ? { case_sensitive: true } : {})
    }
  }

  /**
   * The gateway's ViewerPane tools (item 97 / 7.6.2). **Values from the model are not trusted**:
   * the path goes through `assertAllowed` (12.7), and directories are refused.
   *
   * Delivery to windows is by `onViewerCommand`, and the destination is only the windows showing that thread.
   * The memory (item 63, `setViewerState`) is written first whether or not there is a window: with no window,
   * that file is shown the next time it is opened (owner decision). If there is a window, the renderer does `select` and
   * writes back the same value, so main sees no difference. If the renderer has an unsaved edit it does not obey, and
   * writes the memory back to its own display (`viewerMemory.ts`).
   *
   * The response is for the model, so it is a fixed English sentence (main does not know the display language). A failure is returned in the `error` field and
   * not thrown (so the gateway can tell it from `aios unavailable`).
   */
  private async handleViewerRequest(request: GatewayRequest): Promise<unknown> {
    const { host } = this
    // Do not touch the DB after shutdown (item 79 / 12.9).
    if (host.isStopped()) return { error: 'aios is shutting down' }
    const threadId = host.threadIdForSession(request.sessionId)
    if (threadId === undefined) throw new Error('unknown session')
    const thread = host.getThread(threadId)
    if (thread === null) throw new Error('unknown thread')
    const payload = request.payload
    // A relative path is resolved against the conversation's working folder (the CLI runs in the worktree if it moved into one, the fix of the TODO 633 code-review).
    const cwd = workingCwdOf(thread)

    if (request.kind === 'listOpenFiles') return this.listOpenFiles(threadId)
    // TODO 1216: an unattended read-only turn refuses tools that move a person's screen, read a logged-in page, or GET outward
    // (even if the user's settings skip `approve`).
    if (this.unattended(threadId)) return { error: UNATTENDED_DENIED_MESSAGE }
    if (request.kind === 'openUrl') {
      // Take back the mark the `approve` stage held (it defers `openUrl` in an unattended turn) **before** any early return
      // (code-review, wave 97 fix Y): a mark left behind by a refused URL would be taken by the next `openUrl` and put its approval on
      // the wrong tool_use. Same as `handleSetSetting`. Taken on the attended path too, so a mark can never outlive its call.
      const sent = payload['toolUseId']
      const toolUseId = this.takeDeferredToolUse(threadId, `${GATEWAY_TOOL_PREFIX}openUrl`, typeof sent === 'string' && sent !== '' ? sent : null)
      // TODO 1289 (owner decision 2026-11-21): an unattended turn asks before opening, every time (text read from outside could point
      // it at `?d=<what it read>`, and the Web view carries logged-in cookies). Not refused: a person who is there can let it open.
      // Neither full delegation nor a rule passes it (`unattended` of the Broker). One ask covers the secret mark too.
      if (this.unattendedTurn(threadId)) {
        const url = typeof payload['url'] === 'string' ? payload['url'].trim() : ''
        if (!isWebViewerUrl(url)) return { opened: false, error: 'only http and https URLs can be opened' }
        const result = await this.askInInbox(request, threadId, thread, {
          toolName: `${GATEWAY_TOOL_PREFIX}openUrl`,
          summary: summarize({ url }),
          input: { url },
          toolUseId,
          subtask: true,
          ask: { unattended: UNATTENDED_OPEN_URL_ACTION }
        })
        if (host.isStopped()) return { opened: false, error: 'aios is shutting down' }
        if (!result.allowed) {
          return { opened: false, error: this.deniedMessage(thread, result, 'The user did not allow opening this URL. It was NOT opened.') }
        }
        return this.openUrl(threadId, url)
      }
      // TODO 1043: in a conversation that read a secret, ask in the approval inbox before opening (the target is a Web view with logged-in
      // cookies, so a GET of `?d=<secret>` would be a way to leak it). A conversation without the mark is not asked, as before (owner decision 2026-10-15).
      if (host.hasReadSecret?.(threadId) === true) {
        const denied = await this.askSecretEgress(request, threadId, thread, 'openUrl', { url: typeof payload['url'] === 'string' ? payload['url'] : null }, 'open-url')
        if (denied !== null) return { opened: false, error: denied }
      }
      return this.openUrl(threadId, payload['url'])
    }
    if (request.kind === 'openDiff') return this.openDiff(threadId, cwd, payload)
    if (request.kind === 'getOpenUrlText') return this.getOpenUrlText(request, threadId, thread)
    if (request.kind === 'getViewerScreenshot') return this.getViewerScreenshot(request, threadId, thread)

    if (request.kind === 'closeFile') {
      const open = thread.lastViewerUri
      if (open === null) return { closed: false, error: 'no file is open in this thread' }
      // A web page (TODO 400) is not a file: it cannot be closed by pointing at a path.
      const openIsFile = !isWebViewerUrl(open)
      const hasPath = payload['path'] !== undefined && payload['path'] !== null && payload['path'] !== ''
      if (hasPath) {
        const path = resolveToolPath(payload['path'], cwd)
        if (path === null) return { closed: false, error: 'invalid path' }
        if (!openIsFile) return { closed: false, error: 'a web page is open in this thread, not a file' }
        if (foldPath(pathToUri(path)) !== foldPath(open)) {
          return { closed: false, error: 'that file is not the one open in this thread', open: uriToPath(open) }
        }
      }
      host.setViewerState(threadId, null, null)
      const views = host.viewsOf(threadId)
      for (const viewId of views) host.onViewerCommand(viewId, { kind: 'close', threadId, uri: open })
      log.info('gateway.viewer.close', { threadId, windows: views.length })
      return openIsFile
        ? { closed: true, path: uriToPath(open), windows: views.length }
        : { closed: true, url: open, windows: views.length }
    }

    // openFile
    const path = resolveToolPath(payload['path'], cwd)
    if (path === null) return { opened: false, error: 'invalid path' }
    // Line (item 273). The gateway's zod narrows it, but main does not trust the gateway (item 86):
    // absent / null means "no line"; otherwise only a safe integer of 1 or more.
    const rawLine = payload['line']
    const hasLine = rawLine !== undefined && rawLine !== null
    if (hasLine && !isIntegerIn(rawLine, 1, Number.MAX_SAFE_INTEGER)) {
      return { opened: false, error: 'line must be a positive integer' }
    }
    const line = hasLine ? (rawLine as number) : null
    // Page (item 1 of TODO 1091): the same check as the line. If there is a line the line comes first and the page is not attached.
    const rawPage = payload['page']
    const hasPage = rawPage !== undefined && rawPage !== null
    if (hasPage && !isIntegerIn(rawPage, 1, Number.MAX_SAFE_INTEGER)) {
      return { opened: false, error: 'page must be a positive integer' }
    }
    const page = hasPage && line === null ? (rawPage as number) : null
    let allowed: string
    try {
      // TODO 841: the same `'read'` as the path a user opens in the ViewerPane (`ViewerBroker.open` -> `grantOpen`) and as `openDiff`.
      // The viewer opens for reading, and saving is checked separately by `ViewerBroker.write` with `'edit'`. The read-only exceptions
      // (auto memory `.md`, item 254; the trash, TODO 520) can also be shown by the AI to the same extent the user can open them.
      allowed = host.fs.assertAllowed(pathToUri(path), false, 'read')
    } catch {
      // The reason text (such as the name of an exclusion rule) is not passed to the model.
      return { opened: false, error: 'this path is not allowed' }
    }
    try {
      const stats = await stat(allowed)
      if (stats.isDirectory()) return { opened: false, error: 'this is a directory, not a file' }
      if (!stats.isFile()) return { opened: false, error: 'not a regular file' }
    } catch {
      return { opened: false, error: 'file not found' }
    }
    // If shutdown started during stat, do not write (12.9).
    if (host.isStopped()) return { error: 'aios is shutting down' }
    const raw = payload['highlight']
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    const highlight = trimmed === '' ? null : trimmed.slice(0, MAX_VIEWER_HIGHLIGHT)
    const uri = pathToUri(allowed)
    // Do not leave the line in the memory (item 273, owner decision 2026-10-01). The line goes only into the instruction to the window.
    host.setViewerState(threadId, uri, highlight)
    const views = host.viewsOf(threadId)
    // TODO 832 (1): a window with a draft may not obey an "open" for another file (the `keep` of `planViewerCommand`).
    // Ask only that window for a reply, and put whether it actually switched in the return value. A window with no draft always obeys, so it is not waited for.
    const asked = views.filter((viewId) => host.hasViewerDraft(viewId))
    const replies = asked.length > 0 ? host.expectViewerReplies(asked) : null
    for (const viewId of views) {
      host.onViewerCommand(viewId, {
        kind: 'open',
        threadId,
        uri,
        highlight,
        ...(line === null ? {} : { line }),
        ...(page === null ? {} : { page }),
        ...(replies !== null && asked.includes(viewId) ? { replyId: replies.id } : {})
      })
    }
    const outcomes = replies === null ? new Map<number, ViewerCommandOutcome>() : await replies.done
    // A window with no draft always obeys, so it counts as "shown". A window with a draft is counted by its reply. A window with no reply (reloading, frozen,
    // timed out) is not counted as "shown" but as "could not be confirmed" (wave 41 code-review: it used to be assumed shown, and after
    // waiting 2 seconds returned `opened: true`, the lie 832 meant to remove).
    const kept = views.filter((viewId) => outcomes.get(viewId) === 'kept').length
    const unconfirmed = asked.filter((viewId) => !outcomes.has(viewId)).length
    const shown = views.filter((viewId) => !asked.includes(viewId) || outcomes.get(viewId) === 'opened').length
    log.info('gateway.viewer.open', { threadId, windows: views.length, shown, kept, unconfirmed })
    const unconfirmedNote =
      unconfirmed > 0
        ? `${unconfirmed} window(s) with unsaved edits did not answer in time (it may be reloading or busy), ` +
          'so it could not be confirmed whether they switched to this file.'
        : null
    if (shown === 0 && unconfirmed > 0) {
      // It could not be confirmed as shown in any window. It may have been shown, so it is not an error, and opened is not set to true.
      return {
        opened: false,
        path: allowed,
        windows: 0,
        unconfirmed,
        note:
          `${unconfirmedNote}` +
          (kept > 0 ? ` ${kept} other window(s) kept a file with unsaved edits and did not switch.` : '') +
          ' Do not tell the user the file is open; ask them to check the viewer, or open the file again later.'
      }
    }
    if (shown === 0 && kept > 0) {
      // No window switched. The renderer writes the memory back to its current display (`viewerMemory.ts`).
      return {
        opened: false,
        path: allowed,
        windows: 0,
        error:
          'The viewer has unsaved edits to another file, so it was not switched to this file. ' +
          'Ask the user to save or discard those edits, then open the file again.'
      }
    }
    if (shown === 0) {
      return {
        opened: true,
        path: allowed,
        windows: 0,
        note: 'No window is showing this thread now. The file will be shown when the user opens the thread.'
      }
    }
    const notes = [
      ...(kept > 0 ? [`${kept} other window(s) kept a file with unsaved edits and did not switch.`] : []),
      ...(unconfirmedNote === null ? [] : [unconfirmedNote])
    ]
    return notes.length > 0
      ? {
          opened: true,
          path: allowed,
          windows: shown,
          ...(unconfirmed > 0 ? { unconfirmed } : {}),
          note: notes.join(' ')
        }
      : { opened: true, path: allowed, windows: shown }
  }

  /**
   * TODO 1043: in a conversation that read a secret, asks in the approval inbox about the gateway's own way out (`openUrl`). Leaves the same
   * `permission_request` pending / decided as the `approve` path (the same shape as the approval of a plugin tool). null if allowed, the sentence returned to the model if refused.
   */
  private async askSecretEgress(
    request: GatewayRequest,
    threadId: string,
    thread: Thread,
    exposedName: string,
    input: JsonValue,
    egress: string
  ): Promise<string | null> {
    const sent = request.payload['toolUseId']
    const result = await this.askInInbox(request, threadId, thread, {
      toolName: `${GATEWAY_TOOL_PREFIX}${exposedName}`,
      summary: summarize(input),
      input,
      toolUseId: typeof sent === 'string' && sent !== '' ? sent : null,
      subtask: true,
      ask: { egress }
    })
    if (this.host.isStopped()) return 'aios is shutting down'
    if (result.allowed) return null
    return this.deniedMessage(thread, result, 'The user denied this tool use. The tool was NOT run.')
  }

  /**
   * Asks in the approval inbox from the gateway's tool entry point (the relay of plugin tools, `openUrl` after the secret mark, the consent to read Web tabs; unified in review 57-8).
   * Leaves the same `permission_request` pending / decided as the `approve` path, and puts the conversation in "awaiting approval" while waiting. The saved shape is applied by
   * `toPersistable`. `callId` is the mark the gateway attached (matching the cancel notice, 7.6.5). What to do after the settlement (whether to look at `isStopped`,
   * the refusal sentence) is up to the caller.
   */
  private async askInInbox(
    request: GatewayRequest,
    threadId: string,
    thread: Thread,
    options: {
      readonly toolName: string
      readonly summary: string
      readonly input: JsonValue
      readonly toolUseId: string | null
      /** If true, looks up the subagent mark from the tool_use (only while the conversation is running). */
      readonly subtask: boolean
      /**
       * Ask every time (`alwaysAsk`), or ask as a way out (`egress`, the reason becomes "read a secret"). `settingsGate` is a change to a choke point setting
       * (the gated one of TODO 1060), and is asked even in full-delegation mode (TODO 1175).
       */
      readonly ask:
        | { readonly alwaysAsk: true; readonly settingsGate?: true }
        | { readonly egress: string }
        // TODO 1289: a gateway tool an unattended turn wants (the action name, `UNATTENDED_OPEN_URL_ACTION`). Asked every time, never delegated.
        | { readonly unattended: string }
    }
  ): Promise<ApprovalResult> {
    const { host } = this
    const { toolName, summary, input, toolUseId } = options
    const callId = typeof request.payload['callId'] === 'string' ? request.payload['callId'] : null
    const live = host.getLive(threadId)
    const eventId = randomUUID()
    const requestedAt = Date.now()
    if (live !== undefined) {
      live.pendingApprovals.add(eventId)
      live.state = 'awaiting-approval'
      host.emitThread(threadId)
    }
    const pendingEvent: AiosEvent = {
      id: eventId,
      sessionId: request.sessionId,
      threadId,
      ts: requestedAt,
      actor: 'main',
      kind: 'permission_request',
      payload: {
        requestId: eventId,
        toolUseId,
        toolName,
        summary,
        input,
        requestedAt,
        decidedAt: null,
        outcome: { kind: 'pending' }
      }
    }
    host.record(threadId, pendingEvent)
    let result: ApprovalResult
    try {
      result = await host.requestApproval({
        threadId,
        threadTitle: thread.title,
        toolName,
        summary,
        input,
        strict: thread.approvalStrict,
        cwd: workingCwdOf(thread),
        subtask: options.subtask && live !== undefined ? host.subtaskOfToolUse(threadId, toolUseId) : null,
        toolUseId,
        callId,
        ...options.ask,
        // TODO 959: the unattended turn of a scheduled job lasts until the next scheduled time.
        ...expiryOf(host, threadId)
      })
    } finally {
      if (live !== undefined) settleApproval(host, threadId, live, eventId)
    }
    host.record(threadId, {
      ...pendingEvent,
      payload: { ...pendingEvent.payload, decidedAt: Date.now(), outcome: decidedOutcome(result) }
    })
    return result
  }

  /** The sentence returned to the model from a refused approval (the same as `approve`: items 182 / 183, TODO 567). `fallback` if it cannot be built. */
  private deniedMessage(thread: Thread, result: ApprovalResult, fallback: string): string {
    const adapter = this.host.getAdapter(thread.backend)
    const message =
      result.reply === undefined
        ? result.message
        : (adapter?.approvalReply?.(result.reply) ?? fallbackApprovalReply(result.reply) ?? result.message)
    return message === '' ? fallback : message
  }

  /**
   * The gateway's `openUrl` (TODO 822, 7.6.2). Opens an http(s) URL in a tab of the ViewerPane's Web view (`src/main/web/`).
   * **No approval is needed** (owner decision 2026-10-15: it only opens; the default favors automation over confirmation). The URL is checked by `isWebViewerUrl`
   * (the one decision shared with renderer link clicks, `web.load` and memory writes), and anything other than http(s) or containing credentials is refused.
   * The memory (item 63) goes through `setViewerState` (a URL that reveals a secret is not remembered there). To the window it delivers the same `open`
   * instruction as `openFile`, and the renderer looks at the URL and routes it to a Web tab (`viewerMemory.ts`).
   */
  private openUrl(threadId: string, raw: unknown): unknown {
    const { host } = this
    const url = typeof raw === 'string' ? raw.trim() : ''
    if (!isWebViewerUrl(url)) return { opened: false, error: 'only http and https URLs can be opened' }
    host.setViewerState(threadId, url, null)
    const views = host.viewsOf(threadId)
    for (const viewId of views) host.onViewerCommand(viewId, { kind: 'open', threadId, uri: url, highlight: null })
    log.info('gateway.viewer.openUrl', { threadId, windows: views.length })
    return views.length > 0
      ? { opened: true, url, windows: views.length }
      : {
          opened: true,
          url,
          windows: 0,
          note: 'No window is showing this thread now. The page will be shown when the user opens the thread.'
        }
  }

  /**
   * The gateway's `openDiff` (TODO 826, 7.6.2). Shows a diff **side by side** in the ViewerPane's `aios.diff` (a temporary view, 7.4.6).
   * The right (after the change) is `path`; the left (before the change) is either `base` (another file) or `rev` (a git rev, default `HEAD`), exactly one.
   *
   * **Values from the model are not trusted**: both files go `resolveToolPath` -> `assertAllowed` (12.7) -> `stat`, and only regular
   * files pass. The rev is checked by `isGitRev`. Main reads the contents and passes them directly to the window (the `diff` of `ViewerCommand`): the plugin reads nothing
   * (constraint 8) and nothing is saved anywhere (constraints 9 / 10). A temporary view has no memory (item 63), so **it cannot be shown without a window**
   * (unlike `openFile`, it does not write only the memory and succeed).
   */
  private async openDiff(threadId: string, cwd: string, payload: Record<string, unknown>): Promise<unknown> {
    const { host } = this
    const hasBase = payload['base'] !== undefined && payload['base'] !== null && payload['base'] !== ''
    const hasRev = payload['rev'] !== undefined && payload['rev'] !== null && payload['rev'] !== ''
    if (hasBase && hasRev) return { opened: false, error: 'give either base or rev, not both' }
    const rev = hasRev ? payload['rev'] : 'HEAD'
    if (!isGitRev(rev)) return { opened: false, error: 'invalid git revision' }

    const after = await this.readDiffFile(payload['path'], cwd)
    if (!after.ok) return { opened: false, error: after.error }
    let before: { readonly name: string; readonly text: string }
    if (hasBase) {
      const base = await this.readDiffFile(payload['base'], cwd)
      if (!base.ok) return { opened: false, error: `base: ${base.error}` }
      // If the names are the same, add the parent folder name so they can be told apart (no absolute path is passed, `DiffSide.name`).
      const same = basename(base.path) === basename(after.path)
      before = { name: same ? shortName(base.path) : basename(base.path), text: base.text }
      if (same) after.name = shortName(after.path)
    } else {
      const shown = await readFileAtRevision(after.path, rev, { maxBytes: MAX_OPEN_DIFF_BYTES })
      if (!shown.ok) return { opened: false, error: GIT_SHOW_ERRORS[shown.reason] }
      const text = decodeText(shown.bytes)
      if (text === null) return { opened: false, error: 'binary files cannot be compared' }
      // The name has the shape `HEAD:a.ts` (the end stays the extension, so the viewer can look up the language from the name).
      before = { name: `${rev}:${after.name}`, text }
    }
    // If shutdown started while reading, do nothing (12.9).
    if (host.isStopped()) return { error: 'aios is shutting down' }

    const views = host.viewsOf(threadId)
    if (views.length === 0) {
      return {
        opened: false,
        windows: 0,
        error: 'No window is showing this conversation now, so the diff cannot be shown. Ask the user to open it and try again.'
      }
    }
    const diff: DiffPayload = {
      kind: 'diff',
      before: { name: before.name, text: before.text, language: null },
      after: { name: after.name, text: after.text, language: null },
      // A diff opened by the AI is side by side (owner decision 2026-10-15). It can be switched to one column inside the viewer.
      layout: 'split'
    }
    for (const viewId of views) host.onViewerCommand(viewId, { kind: 'diff', threadId, diff })
    log.info('gateway.viewer.diff', { threadId, windows: views.length, git: !hasBase })
    return {
      opened: true,
      windows: views.length,
      before: before.name,
      after: after.path,
      ...(before.text === after.text ? { identical: true } : {})
    }
  }

  /** One side's file of `openDiff`. Choke point -> regular file -> limit -> string (if it contains NUL it is refused as binary). */
  private async readDiffFile(
    raw: unknown,
    cwd: string
  ): Promise<{ ok: true; path: string; name: string; text: string } | { ok: false; error: string }> {
    const path = resolveToolPath(raw, cwd)
    if (path === null) return { ok: false, error: 'invalid path' }
    let allowed: string
    try {
      allowed = this.host.fs.assertAllowed(pathToUri(path), false, 'read')
    } catch {
      // The reason text (such as the name of an exclusion rule) is not passed to the model.
      return { ok: false, error: 'this path is not allowed' }
    }
    // The same manner as ViewerBroker / protocol.ts: normalize with realpath -> pass the normalized path through the choke point again ->
    // open with O_NOFOLLOW, fstat the opened fd -> read from that fd (leaving no check-then-use gap).
    let real: string
    try {
      real = realpathSync.native(allowed)
    } catch {
      return { ok: false, error: 'file not found' }
    }
    try {
      this.host.fs.assertAllowed(pathToUri(real), false, 'read')
    } catch {
      return { ok: false, error: 'this path is not allowed' }
    }
    let handle: FileHandle | null = null
    try {
      handle = await openNoFollow(real, constants.O_RDONLY, { nonBlock: false })
      const stats = await handle.stat()
      if (stats.isDirectory()) return { ok: false, error: 'this is a directory, not a file' }
      if (!stats.isFile()) return { ok: false, error: 'not a regular file' }
      if (stats.size > MAX_OPEN_DIFF_BYTES) return { ok: false, error: 'the file is too large to compare' }
      const text = decodeText(await handle.readFile())
      if (text === null) return { ok: false, error: 'binary files cannot be compared' }
      return { ok: true, path: allowed, name: basename(allowed), text }
    } catch {
      return { ok: false, error: 'file not found' }
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  /**
   * The list of open files (item 97). This thread's memory (even if there is no window) and the ViewerPane of threads that other windows
   * are showing. **Paths only**: titles and contents of other threads are not passed.
   */
  private listOpenFiles(threadId: string): unknown {
    const { host } = this
    // TODO 1061 (3): per window, "what is in front now". Conversation -> the windows showing it.
    const viewsByThread = new Map<string, number[]>()
    for (const [viewId, shown] of host.allViewEntries()) {
      const list = viewsByThread.get(shown) ?? []
      list.push(viewId)
      viewsByThread.set(shown, list)
    }
    const shownIn = (viewId: number, id: string): ViewerShownReport | null => host.viewerShown?.(viewId, id) ?? null
    const files: { path: string; thread: 'current' | 'other'; visible: boolean; shown: boolean }[] = []
    const seen = new Set<string>()
    const push = (id: string, views: readonly number[]): void => {
      if (seen.has(id)) return
      seen.add(id)
      const uri = host.getThread(id)?.lastViewerUri ?? null
      // A web page (TODO 400) is not a file, so it is not listed.
      if (uri === null || isWebViewerUrl(uri)) return
      const folded = foldPath(uri)
      // In view (TODO 1061): some window's ViewerPane has this file in front now (false when behind a temporary diff view or behind Web).
      const shown = views.some((viewId) => {
        const report = shownIn(viewId, id)
        return report !== null && report.kind === 'file' && report.uri !== null && foldPath(report.uri) === folded
      })
      files.push({ path: uriToPath(uri), thread: id === threadId ? 'current' : 'other', visible: views.length > 0, shown })
    }
    const ownViews = host.viewsOf(threadId)
    push(threadId, ownViews)
    for (const [, shown] of host.allViewEntries()) push(shown, viewsByThread.get(shown) ?? [])
    // TODO 1052: the Web tabs of the windows showing this conversation (the targets `getOpenUrlText` can read). Only the badge's URL and title.
    // TODO 1061 (3): `shown` means that window's ViewerPane is showing Web now and that tab is the front tab.
    const web = host.webTabs
    const tabsOf = (viewId: number): readonly (ReadableWebTab & { shown: boolean })[] => {
      if (web === undefined) return []
      const report = shownIn(viewId, threadId)
      return web.list(viewId).map((tab) => ({ ...tab, shown: tab.active && report?.kind === 'web' }))
    }
    // Fetch once per window and use it for both `inView` and `webTabs` (58-6).
    const tabsByView = ownViews.map((viewId) => ({ viewId, tabs: tabsOf(viewId) }))
    const inView = tabsByView.map(({ viewId, tabs }) => describeInView(shownIn(viewId, threadId), tabs))
    const result: Record<string, unknown> = { files }
    if (web !== undefined) result['webTabs'] = tabsByView.flatMap(({ tabs }) => tabs)
    // With no window there is nothing "in front" either (the same shape as before).
    if (ownViews.length > 0) result['inView'] = inView
    return result
  }

  /** TODO 1052: only one read at a time (a view may be created without being shown). */
  private webTabReads: Promise<unknown> = Promise.resolve()

  /**
   * The gateway's `getOpenUrlText` (TODO 1052, 7.6.2). Returns the body (text only) of **a Web tab the user opened, in a window showing this conversation**.
   * A URL that is not open is not read (arbitrary URLs are not rendered in the background, owner decision 2026-10-29).
   * Consent is obtained in the approval inbox only the first time (one per app setting), and not asked afterwards. The body is neither saved nor logged (the log goes only as far as the host name).
   * A long body is cut and returned the same way as `getDocumentText` (UTF-8 byte position, `next_offset`).
   */
  private getOpenUrlText(request: GatewayRequest, threadId: string, thread: Thread): Promise<unknown> {
    const run = this.webTabReads.then(() => this.readOpenUrlText(request, threadId, thread))
    this.webTabReads = run.catch(() => undefined)
    return run
  }

  private async readOpenUrlText(request: GatewayRequest, threadId: string, thread: Thread): Promise<unknown> {
    const { host } = this
    if (host.isStopped()) return { error: 'aios is shutting down' }
    const web = host.webTabs
    if (web === undefined) return { error: 'web tabs are not available' }
    const payload = request.payload
    // The gateway's zod narrows it, but main does not trust the gateway (item 86).
    const rawTabId = payload['tabId']
    const rawUrl = payload['url']
    if (rawTabId !== undefined && rawTabId !== null && (typeof rawTabId !== 'string' || rawTabId.length > 64)) {
      return { error: 'invalid tabId' }
    }
    if (rawUrl !== undefined && rawUrl !== null && (typeof rawUrl !== 'string' || rawUrl.length > MAX_EXTERNAL_URL_LENGTH)) {
      return { error: 'invalid url' }
    }
    const rawOffset = payload['offset'] ?? 0
    if (!isIntegerIn(rawOffset, 0, Number.MAX_SAFE_INTEGER)) return { error: 'offset must be a non-negative integer' }
    const rawLength = payload['length'] ?? DEFAULT_PAGE_TEXT_SLICE_BYTES
    if (!isIntegerIn(rawLength, MIN_PAGE_TEXT_SLICE_BYTES, MAX_PAGE_TEXT_SLICE_BYTES)) {
      return { error: `length must be an integer from ${MIN_PAGE_TEXT_SLICE_BYTES} to ${MAX_PAGE_TEXT_SLICE_BYTES}` }
    }
    const want = {
      tabId: typeof rawTabId === 'string' && rawTabId !== '' ? rawTabId : null,
      url: typeof rawUrl === 'string' && rawUrl.trim() !== '' ? rawUrl.trim() : null
    }

    if (host.viewsOf(threadId).length === 0) {
      return {
        error: 'No window is showing this conversation now, so its web tabs cannot be read. Ask the user to open it and try again.'
      }
    }
    // TODO 1061 (3): also attach the in-view (`shown`) mark (when there is no argument, the tab visible to the user is read).
    const collect = (): { viewId: number; tab: ReadableWebTab }[] =>
      host.viewsOf(threadId).flatMap((viewId) => {
        const report = host.viewerShown?.(viewId, threadId) ?? null
        return web.list(viewId).map((tab) => ({ viewId, tab: { ...tab, shown: tab.active && report?.kind === 'web' } }))
      })
    // If no URL was given and there is no tab at all, refuse before asking for consent (there would be nothing to read even if asked).
    if (want.url === null && collect().length === 0) {
      return { error: 'No web page is open in the viewer of this conversation. Open it with openUrl first.' }
    }

    // First-time consent (owner decision 2026-10-29: only once, like the `browser` of 848. Not asked afterwards).
    const consent = host.webTabReadConsent
    if (consent?.granted() !== true) {
      const denied = await this.askWebTabReadConsent(request, threadId, thread)
      if (denied !== null) return { error: denied }
      if (host.isStopped()) return { error: 'aios is shutting down' }
      consent?.grant()
    }

    // Right after `openUrl` the renderer has not yet copied the URL into the tab, so wait a little until the tab for the URL appears.
    let entries = collect()
    let picked = pickWebTab(
      entries.map((entry) => entry.tab),
      want
    )
    const sleep = host.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (
      let waited = 0;
      !picked.ok && picked.reason !== 'no-such-tab' && want.url !== null && waited < WEB_TAB_MATCH_WAIT_MS;
      waited += WEB_TAB_MATCH_INTERVAL_MS
    ) {
      await sleep(WEB_TAB_MATCH_INTERVAL_MS)
      if (host.isStopped()) return { error: 'aios is shutting down' }
      entries = collect()
      picked = pickWebTab(
        entries.map((entry) => entry.tab),
        want
      )
    }
    if (!picked.ok) {
      const tabs = entries.map(({ tab }) => ({ tabId: tab.tabId, url: tab.url, title: tab.title }))
      if (picked.reason === 'no-such-tab') {
        return { error: 'No open web tab has that tabId. Call listOpenFiles to see the open web tabs.', tabs }
      }
      if (picked.reason === 'no-matching-url') {
        return {
          error: 'No open web tab shows that URL. Open it with openUrl first, or pass the tabId of an open tab.',
          tabs
        }
      }
      return { error: 'No web page is open in the viewer of this conversation. Open it with openUrl first.' }
    }
    const { tab } = picked
    const viewId = entries.find((entry) => entry.tab === tab)?.viewId
    if (viewId === undefined) return { error: TAB_TEXT_ERRORS.closed }

    let outcome: TabTextOutcome
    try {
      outcome = await web.read(viewId, tab.tabId)
    } catch {
      outcome = { ok: false, reason: 'unreadable' }
    }
    if (host.isStopped()) return { error: 'aios is shutting down' }
    if (!outcome.ok) {
      log.info('gateway.web.readText.failed', { threadId, host: webHostOf(tab.url), reason: outcome.reason })
      return { error: TAB_TEXT_ERRORS[outcome.reason], tabId: tab.tabId }
    }
    const slice = slicePageText(tidyPageText(outcome.text), rawOffset, rawLength)
    // Do not log the body. Only the host name and the size.
    log.info('gateway.web.readText', {
      threadId,
      host: webHostOf(outcome.url),
      bytes: slice.total,
      truncated: slice.truncated
    })
    const notes = [
      ...(outcome.loading ? ['The page was still loading, so the text may be incomplete.'] : []),
      // TODO 1055 (4): the maximum wait was reached before the body length settled (a page that keeps rendering). No wait-time argument is added; make it re-read.
      ...(outcome.settled ? [] : ['The page was still changing when it was read, so the text may be out of date. Call getOpenUrlText again to read the latest.']),
      ...(outcome.clipped ? ['The page is very long; only its beginning was taken.'] : [])
    ]
    return {
      url: outcome.url,
      title: outcome.title,
      tabId: tab.tabId,
      offset: slice.offset,
      bytes: slice.bytes,
      total_bytes: slice.total,
      next_offset: slice.next_offset,
      truncated: slice.truncated,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      text: slice.text
    }
  }

  /**
   * The gateway's `getViewerScreenshot` (TODO 1061 (1), 7.6.2). Returns, as an image (up to 1568px on the long side, PNG or JPEG), the rendering of **what the ViewerPane
   * of a window showing this conversation has in front now**. What to capture is decided by the window's notice (`viewerShown`):
   *   - Web view: the tab being shown at that moment. The same choke point as the consent of 1052 (`web.tabReadConsent`) (it may include logged-in pages).
   *   - A file viewer: that file is re-checked with `assertAllowed(…, 'read')` (what the AI can open = what the user can open, 841).
   *     If it passes, consent is not asked (the body is already readable).
   *   - A temporary view (diff): not checked, since aios read it and showed it.
   * The image is neither saved nor logged (the log goes only as far as kind, size, format and host name). It is queued in the read queue (`webTabReads`).
   */
  private getViewerScreenshot(request: GatewayRequest, threadId: string, thread: Thread): Promise<unknown> {
    const run = this.webTabReads.then(() => this.captureViewer(request, threadId, thread))
    this.webTabReads = run.catch(() => undefined)
    return run
  }

  private async captureViewer(request: GatewayRequest, threadId: string, thread: Thread): Promise<unknown> {
    const { host } = this
    if (host.isStopped()) return { error: 'aios is shutting down' }
    const capture = host.viewerCapture
    if (capture === undefined) return { error: 'screenshots are not available' }
    const views = host.viewsOf(threadId)
    if (views.length === 0) {
      return { error: 'No window is showing this conversation now, so its viewer pane cannot be captured. Ask the user to open it and try again.' }
    }
    // The first window that has something in front. A window with no notice (right after a reload) is skipped.
    let target: { viewId: number; report: ViewerShownReport } | null = null
    let sawClosed = false
    for (const viewId of views) {
      const report = host.viewerShown?.(viewId, threadId) ?? null
      if (report === null) continue
      if (report.kind === 'none') {
        sawClosed = true
        continue
      }
      target = { viewId, report }
      break
    }
    if (target === null) {
      return {
        error: sawClosed
          ? 'The viewer pane of this conversation shows nothing (it is empty or folded). Open a file with openFile or a page with openUrl first; that also unfolds it.'
          : 'What the viewer pane shows is not known yet. Try again in a moment.'
      }
    }
    const { viewId, report } = target
    let outcome: ScreenshotOutcome
    let described: Record<string, unknown>
    if (report.kind === 'web') {
      const activeTab = (): ReadableWebTab | undefined => (host.webTabs?.list(viewId) ?? []).find((item) => item.active)
      const emptyTab = { error: 'The viewer pane shows an empty browser tab. Open a page with openUrl first.' }
      if (activeTab() === undefined) return emptyTab
      // It may include logged-in pages, so it goes through the same first-time consent as reading the body (1052).
      if (host.webTabReadConsent?.granted() !== true) {
        const denied = await this.askWebTabReadConsent(request, threadId, thread, 'getViewerScreenshot')
        if (denied !== null) return { error: denied }
        if (host.isStopped()) return { error: 'aios is shutting down' }
        host.webTabReadConsent?.grant()
      }
      // Waiting for consent can take minutes, so even if the tab changed in the meantime, capture the tab that is in front now (58-2).
      const tab = activeTab()
      if (tab === undefined) return emptyTab
      described = { kind: 'web', tabId: tab.tabId, url: tab.url, title: tab.title }
      try {
        outcome = await capture.web(viewId, tab.tabId)
      } catch {
        outcome = { ok: false, reason: 'failed' }
      }
    } else {
      if (report.kind === 'file') {
        // Do not trust the window's notice (a renderer value) as is: re-check that it is within what the AI can open (= what the user can open).
        // Anything other than `file:` (a conversation transcript etc.) has no path, and capturing a pane needs no path, so capture without checking (58-3).
        const uri = report.uri
        if (uri !== null && !uri.startsWith('file:')) {
          described = { kind: 'other' }
        } else {
          let path: string
          try {
            path = host.fs.assertAllowed(uri ?? '', false, 'read')
          } catch {
            return { error: 'What the viewer pane shows now cannot be captured.' }
          }
          described = { kind: 'file', path, ...(report.entry === undefined ? {} : { entry: report.entry }) }
        }
      } else {
        described = { kind: 'diff' }
      }
      try {
        outcome = await capture.pane(viewId)
      } catch {
        outcome = { ok: false, reason: 'failed' }
      }
    }
    if (host.isStopped()) return { error: 'aios is shutting down' }
    if (!outcome.ok) {
      log.info('gateway.viewer.screenshot.failed', { threadId, kind: report.kind, reason: outcome.reason })
      return { error: SCREENSHOT_ERRORS[outcome.reason], ...described }
    }
    // The image is not logged. Only kind, size and format (the host name for Web).
    log.info('gateway.viewer.screenshot', {
      threadId,
      kind: report.kind,
      ...(report.kind === 'web' ? { host: webHostOf(outcome.url ?? String(described['url'])) } : {}),
      width: outcome.width,
      height: outcome.height,
      mimeType: outcome.mimeType,
      bytes: Math.floor((outcome.data.length * 3) / 4)
    })
    const scaled = outcome.width !== outcome.originalWidth || outcome.height !== outcome.originalHeight
    return {
      ...described,
      ...(report.kind === 'web' && outcome.url !== undefined ? { url: outcome.url } : {}),
      width: outcome.width,
      height: outcome.height,
      ...(scaled ? { note: `Scaled down from ${outcome.originalWidth}x${outcome.originalHeight}.` } : {}),
      image: { data: outcome.data, mimeType: outcome.mimeType }
    }
  }

  /**
   * TODO 1052: asks in the approval inbox for the first-time consent to read the body of a Web tab (queued without looking at default, rules or strict mode, `alwaysAsk`).
   * null if it passes, the sentence returned to the model if refused. The `permission_request` pending / decided is left in the same shape as the relay of plugin tools.
   */
  private async askWebTabReadConsent(
    request: GatewayRequest,
    threadId: string,
    thread: Thread,
    tool: 'getOpenUrlText' | 'getViewerScreenshot' = 'getOpenUrlText'
  ): Promise<string | null> {
    const url = request.payload['url']
    const result = await this.askInInbox(request, threadId, thread, {
      toolName: `${GATEWAY_TOOL_PREFIX}${tool}`,
      summary: WEB_TAB_READ_CONSENT_SUMMARY,
      input: typeof url === 'string' ? { url } : {},
      toolUseId: null,
      subtask: false,
      ask: { alwaysAsk: true }
    })
    if (result.allowed) {
      log.info('gateway.web.readConsent.granted', { threadId })
      return null
    }
    return this.deniedMessage(thread, result, 'The user did not allow reading web pages. The page was NOT read.')
  }
}
