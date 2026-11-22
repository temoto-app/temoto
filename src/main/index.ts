/**
 * Entry point of the main process.
 *
 * Structure: DB -> index process (IndexClient) -> FsAccess -> Broker / PluginHost ->
 * gateway -> Adapter -> SessionManager -> windows.
 *
 * **In P1 the index and scan moved to a separate process** (chapter 3). All code touching `documents` / `chunks` /
 * `chunk_fts` / `scan_runs` / `index_failures` lives in the
 * utility process (`aios-index`); only a thin `IndexClient` remains in main. Because the index's SQLite does not run on
 * main's JS thread (= the AppKit event loop), the UI does not freeze even while the index is being built.
 *
 * **A trust boundary came in with Phase 4** (chapter 7). Plugin code is not run in main
 * (constraint 8), and privileged operations are decided in one place by the CapabilityBroker and written to the audit log.
 *
 * **T21 made windows plural** (chapter 3 / 12.6). One profile is still one process;
 * only windows increase. The services (FsService / IndexService / PluginHost / GatewayServer /
 * SessionManager) are one per app, and the windows are held by the `windows` set.
 */
import { join } from 'node:path'
import { SCRATCH_FOLDER } from './session/scratch.js'
import { readFileSync, readlinkSync, rmSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Notification,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  shell
} from 'electron'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { AgentFeatureMap } from '@shared/agent.js'
import type { AppInfo, Platform } from '@shared/types.js'
import { IpcEvent } from '@shared/ipc.js'
import { THEME_BACKGROUND, THEME_QUERY_KEY, type Theme } from '@shared/theme.js'
import { LOCALE_QUERY_KEY, localeFromTag, type Locale } from '@shared/locale.js'
import { DB_FILE, openDatabase } from './db/index.js'
import { KEY_FILE } from './db/key.js'
import { DatabaseTooNewError } from '../common/migrations.js'
import { nativeText } from './i18n-native.js'
import { QuitConfirm } from './quit-confirm.js'
import { ConversationExporter, electronPdfRenderer } from './export/conversation-pdf.js'
import { embedImages } from './export/embed-images.js'
import { AppSettingsStore } from '../common/settings.js'
import { runConversationBackfill } from './index/conversation-backfill.js'
import { ThemeController } from './theme.js'
import { LocaleController } from './locale.js'
import { FsAccess } from './fs/access.js'
import { GitStatusReader } from './git/status.js'
import { createEditorLaunchers } from './editor/launcher.js'
import { EditorPreference } from './editor/preference.js'
import {
  DesktopNotifier,
  NotificationPreference,
  ReminderNotifier,
  type CreateDesktopNotification,
  notifyBody,
  outboundNotifyText,
  resolveNotifyTitle,
  scheduledNotifyText,
  triggerNotifyText
} from './notify.js'
import { AutoLoginPreference } from './session/login-recovery.js'
import { AgentSettings } from './agent-settings.js'
import { settingsSnapshot } from './settings-snapshot.js'
import { IndexClient } from './index/client.js'
import { registerIpcHandlers, createPusher } from './ipc/handlers.js'
import { registerResourceScheme, handleResourceScheme, handlePluginScheme } from './protocol.js'
import { AuditLog } from './capability/audit.js'
import { CredentialStore } from './capability/credentials.js'
import { CapabilityBroker } from './capability/broker.js'
import { PluginDocumentStore } from './capability/plugin-store.js'
import { ViewerBroker } from './capability/viewer.js'
import { ViewerFileWatcher } from './capability/viewer-watch.js'
import { PluginHost } from './plugin/host.js'
import { PluginSurfaces } from './plugin/surfaces.js'
import { PluginToolRelay } from './plugin/tools.js'
import { pluginToolFingerprint } from './plugin/tool-fingerprint.js'
import { PluginSettingsStore } from './plugin/settings.js'
import { indexSourceOwnedBy, type PluginManifest } from '@shared/plugin.js'
import { registerPluginSettingsHandlers } from './plugin/settings-ipc.js'
import { PluginSearchRelay } from './plugin/search.js'
import { GatewayServer } from './approval/server.js'
import { createAgentAdapter } from './session/adapter/index.js'
import { createSecondaryAdapters } from './session/adapter/registry.js'
import { SessionManager } from './session/manager.js'
import { ThreadStore } from './session/store.js'
import { badgeThreadOf, countBadge, recentThreadRows, trayThreadLists, type BadgeThread } from './session/badge.js'
import type { ApprovalItem, ViewerCommand } from '@shared/thread.js'
import { widenPathForGuiLaunch } from './path-env.js'
import { openExternalChecked } from './open-external.js'
import { navFromAppCommand, navFromSwipe, type ViewerNavCommand } from './navigation-gesture.js'
import { installMenus, type InstalledMenus } from './menu.js'
import { dispatchMenuCommand } from './menu-model.js'
import { OpenFileBatcher, OpenRequests, createThreadFromDrop, kindOfPath } from './drop.js'
import { APP_URL_SCHEME, APP_URL_SCHEMES_ACCEPTED, findAppUrlInArgv, parseAppUrl } from '../common/app-url.js'
import { AppUrlInbox, openFromAppUrl } from './app-url.js'
import { GlobalHotkey, applyHotkeys, retryHotkeys } from './global-hotkey.js'
import { keyPlatformOfProcess } from './keybindings.js'
import { effectiveKeybinding, type KeybindingOverrides } from '@shared/keybindings.js'
import type { OpenRequest } from '@shared/ipc.js'
import { pathToUri } from '../common/uri.js'
import {
  chooseBounds,
  closedBounds,
  planRestore,
  reclaimStaleSingletonLock,
  rememberBounds,
  showsInactive,
  snapshotSession,
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  SINGLETON_FILES,
  WindowSet,
  type WindowBounds
} from './windows.js'
import { WINDOW_BOUNDS, AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_DAYS, WEB_TAB_READ_CONSENT, PLUGIN_UPDATED_VERSIONS, PLUGIN_SETTINGS } from '../common/settings-keys.js'
import { log, errorFields } from '../common/logger.js'
import { startFileLogging, closeLogFile } from './log-file.js'
import { shutdownWithin } from './shutdown.js'
import { VoiceTranscriber } from './voice/transcriber.js'
import { registerVoiceHandler } from './voice/register.js'
import { registerDataTransferHandlers } from './data-transfer/ipc.js'
import type { DataTransfer } from './data-transfer/service.js'
import { backupUnsupportedReason, registerBackupHandlers } from './backup/ipc.js'
import type { BackupService } from './backup/service.js'
import { takePendingRestore } from './backup/restore.js'
import { randomUUID } from 'node:crypto'
import { VoiceLocalePreferenceStore } from './voice/locale-preference.js'
import { resolveVoiceSpeechLocale } from '@shared/voice-locale.js'
import { registerAsciiInput } from './input/register.js'
import { registerPasteImageHandler } from './paste/register.js'
import { registerRecentFilesHandlers, type RecentFilesRegistration } from './recent/register.js'
import { registerWebViewHandlers, webPageSession, type WebViewHandle } from './web/register.js'
import { captureViewerPane } from './viewer-capture.js'
import { webPageTransport } from './web/page-fetch.js'
import { registerWebExtras, type WebExtrasHandle } from './web/extras.js'
import { WebDataStore } from './web/data.js'
import { registerHiddenFilesHandlers } from './hidden-files-ipc.js'
import { registerOsSettingsHandlers, type OsSettingsHandle } from './os-settings-ipc.js'
import { currentLoginItemEnvironment } from './os/login-item.js'
import { allowViewerFrameNavigation } from './capability/viewer-csp.js'
import { registerAutoSaveHandlers } from './auto-save-ipc.js'
import type { AutoSavePreference } from './auto-save.js'
import { ViewerAssociations } from './plugin/associations.js'
import { registerViewerAssociationHandlers } from './plugin/associations-ipc.js'
import { registerHelpHandlers } from './help-ipc.js'
import { HELP_BACKEND_NAMES, helpRoot } from './help.js'
import { syncHelpDocs } from './help-sync.js'
import { registerReleaseNotesHandlers } from './release-notes-ipc.js'
import { GmailDraftFontPreference } from './gmail-draft-font.js'
import { registerGmailDraftFontHandlers } from './gmail-draft-font-ipc.js'
import { ReleaseNotesService } from './release-notes.js'
import { PluginAccounts } from './plugin/accounts.js'
import { chooseClientFile, openInDefaultBrowser, registerPluginAccountHandlers } from './plugin/accounts-ipc.js'
import { PluginTaskInvoker, PluginTaskStateStore } from './plugin/tasks.js'
import { registerFileSortHandlers } from './file-sort-ipc.js'
import { registerSearchHistoryHandlers } from './search-history-ipc.js'
import { registerRedmineHandlers } from './redmine-ipc.js'
import { registerThreadCollapseHandlers } from './thread-collapse-ipc.js'
import type { ThreadCollapsePreference } from './thread-collapse.js'
import { THREAD_COLLAPSE_QUERY_KEY, DEFAULT_COLLAPSE_OLD_AFTER_DAYS } from '@shared/thread-collapse.js'
import { registerViewerDraftsClose, type ViewerDraftsCloser } from './viewer-drafts-close-ipc.js'
import {
  ReloadPendingRequests,
  reloadOrDefer,
  reloadWithDrafts,
  shouldDropCloseDuringQuitSettle,
  type ReloadKind
} from './viewer-drafts-close.js'
import { registerKeybindingsHandlers } from './keybindings-ipc.js'
import { registerUpdateHandlers, UPDATE_RELAUNCH_ARG } from './update/ipc.js'
import { PluginReleaseCatalog } from './update/plugin-versions.js'
import { UpdatedPluginStore } from './plugin/updated-store.js'
import { registerAgentUpdateHandlers } from './agent-update/ipc.js'
import { registerCliPluginHandlers } from './ipc/cli-plugins.js'
import { detectAgentUpdateUnsupported, type AgentUpdateService } from './agent-update/service.js'
import type { UpdateService } from './update/service.js'
import { currentBuildInfo, currentRuntimeInfo } from './build-info.js'
import { reportProblem } from './problem-report.js'
import { attachRendererRecovery, logChildProcessGone, type RecoveryHandle } from './renderer-recovery.js'
import { isRecoveryReload, recoveryPageHtml, recoveryPageUrl, recoveryTemplatePath } from './recovery-page.js'
import { aboutPanelValues } from '@shared/build-info.js'
import { registerUsageHandlers } from './usage-ipc.js'
import { usageLimitReached } from '@shared/usage.js'
import { registerConnectionHandlers } from './connection-ipc.js'
import { ScheduledJobStore } from './schedule/store.js'
import { JobScheduler } from './schedule/scheduler.js'
import { AiReminderGate } from './schedule/ai-reminders.js'
import { resolveLaterAttachments } from './schedule/later-attachments.js'
import { pushScheduleOverview, registerScheduleHandlers } from './schedule/ipc.js'
import { RoleStore } from './role/store.js'
import { pushDrillChanged, registerRoleHandlers } from './role/ipc.js'
import { TriggerStore } from './trigger/store.js'
import { TriggerService } from './trigger/service.js'
import { pushTriggerOverview, registerTriggerHandlers } from './trigger/ipc.js'
import { LowPowerModeReader, collectPower } from './os/power.js'
import { currentThermalState, setDockBadge, windowChromeOptions } from './os/electron.js'
import { MenuBarTray } from './os/tray.js'
import { TRAY_FOLDER_LIMIT, TRAY_RECENT_LIMIT, emptyTrayMenu, selectUpcomingJobs, type TrayAction } from './os/tray-model.js'
import { swiftHelperPath } from './os/helpers.js'
import { hostPlatform, isMac } from '../common/os/platform.js'
import { PRODUCT_NAME } from '@shared/product.js'
import { chooseAppIdentity, initAppIdentity, probeUserData } from '../common/app-identity.js'

/**
 * Electron's app name (separated from the public name in TODO 1254). userData (`~/Library/Application Support/<name>`),
 * the keychain's `<name> Safe Storage`, the log location and the Web view's User-Agent `<name>/<version>` are all determined by this name.
 * TODO 1263: decided once, here, before `ready`: a machine that already has the legacy userData (`<appData>/aios`) keeps `aios`
 * (the DB key and data stay where they are; nothing is moved or re-sealed), and a new machine starts as `Temoto`. A machine whose
 * `<appData>/Temoto` already holds the DB stays `Temoto` even if a legacy userData appears later (code-review).
 * `~/<name>/` and `~/.local/share/<name>` follow the same decision (`appIdentity()`).
 */
const APP_IDENTITY = initAppIdentity(chooseAppIdentity(probeUserData(app.getPath('appData'))))
const APP_INTERNAL_NAME = APP_IDENTITY.dataName
/** Right after launch, scanning and the UI come first; the index starts one beat later. */
const INDEX_START_DELAY_MS = 3000
/**
 * Interval for sending `powerMonitor` values to the index process (6.2.2 / P1 / TODO 434). **This is the only place that touches
 * electron**; the pace thresholds and decisions stay in the index process (`pace.ts` / `ScanScheduler`).
 */
const POWER_REPORT_MS = 5000

app.setName(APP_INTERNAL_NAME)
log.info('app.identity', { kind: APP_IDENTITY.kind })

/**
 * Whether `userData` is the default (item 192, plan A). The default is `<appData>/<app.name>`, and
 * `--user-data-dir` replaces only `userData` and **does not change `appData` (the OS's profile location)**. This mismatch is the only
 * clue that tells a proxy-verification copy (`--user-data-dir=/tmp/aios-…`) apart from the real instance. If they do not match, the renderer is made to show a band (`InstanceBanner`).
 */
function isDefaultUserData(userDataDir: string): boolean {
  return userDataDir === join(app.getPath('appData'), app.getName())
}

/**
 * Two processes are never run for the same profile (12.6). The second one cannot open the DB and gets
 * `database is locked`, and "one writer to the index" (6.2) would also break.
 * What the user sees as "another aios" is satisfied by **opening one more window** (T21).
 *
 * The single retry is for reclaiming a leftover `SingletonLock` (the guide notes that "a restart right after killing
 * may fail"). It is removed only when it points to a dead pid.
 */
function acquireSingleInstanceLock(): boolean {
  if (app.requestSingleInstanceLock()) return true
  const verdict = reclaimStaleSingletonLock(
    SINGLETON_FILES.map((name) => join(app.getPath('userData'), name)),
    {
      readlink: (path) => {
        try {
          return readlinkSync(path)
        } catch {
          return null
        }
      },
      unlink: (path) => rmSync(path, { force: true }),
      isAlive: (pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch (err) {
          // EPERM = another user's process, but alive. ESRCH = not there.
          return (err as NodeJS.ErrnoException).code === 'EPERM'
        }
      },
      hostname: () => hostname()
    }
  )
  log.info('app.singleton.retry', { verdict })
  if (verdict !== 'reclaimed') return false
  return app.requestSingleInstanceLock()
}

// D-7 (review 2026-09-21): a second instance does not register the schemes or call `bootstrap`
// after `app.quit()` (as Electron recommends). Previously both were still registered after calling `app.quit()` here,
// so `bootstrap` could start running and `openDatabase` could hit `SQLITE_BUSY`.
const isPrimaryInstance = acquireSingleInstanceLock()
if (!isPrimaryInstance) {
  // A real second instance. The existing process's `second-instance` opens one window.
  log.warn('app.second-instance', {})
  app.quit()
}

// Also keep the log in a file (TODO 376, 12.9.1). Primary instance only. Lines before this one (`app.singleton.retry`)
// were buffered by the logger and are flushed here. It is closed at the very end of `before-quit`.
if (isPrimaryInstance) {
  const userData = app.getPath('userData')
  const defaultUserData = isDefaultUserData(userData)
  // Just calling `app.getPath('logs')` creates the real `~/Library/Logs/aios/` (399-1). It is not called for a copy.
  startFileLogging({ logs: defaultUserData ? app.getPath('logs') : null, userData, defaultUserData })
}

/**
 * `aios://` URLs (TODO 976 stage 3, ARCHITECTURE 3.3). On macOS they arrive via `open-url`; on Windows / Linux via the second launch's
 * argv (`second-instance`) and this process's own launch argv. **`open-url` can arrive even before `ready`
 * (around `will-finish-launching`)**, so registration is done at top level and buffered until the end of bootstrap (`markReady`)
 * (same as `open-file` for a Drop on the Dock). `handleAppUrl` resolves and checks them (they are external values, so main checks everything).
 */
const appUrlInbox = new AppUrlInbox((url) => {
  return handleAppUrl(url)
})
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (closingDown || !isPrimaryInstance) return
  appUrlInbox.push(url)
})
if (isPrimaryInstance) {
  const launchUrl = findAppUrlInArgv(process.argv.slice(1))
  if (launchUrl !== null) appUrlInbox.push(launchUrl)
}

app.on('second-instance', (_event, argv) => {
  if (closingDown) return
  // If a second launch carries an `aios://` (Windows / Linux), open that URL without adding a window.
  // Even before `ready` the inbox buffers it, so it is not lost.
  const url = findAppUrlInArgv(argv.slice(1))
  if (url !== null) {
    appUrlInbox.push(url)
    return
  }
  // `open -n` and a second launch are treated as "a new window" (same as Chrome).
  // No window is added during shutdown (same as `activate`). Before `ready`, `screen` is unusable and
  // bootstrap opens a window anyway, so do nothing.
  if (!app.isReady()) return
  openWindow()
})

/**
 * Items dropped on the Dock icon (and `open -a aios.app <folder>`) (item 98 (c)).
 * **They can arrive before `ready` too**, so this registration is done at top level. Items arriving one after another are
 * batched for 100 ms by `OpenFileBatcher`, and those before launch finishes are buffered until the end of bootstrap (`markReady`).
 */
const openRequests = new OpenRequests()
const openFileBatcher = new OpenFileBatcher((paths) => {
  void createFromDockDrop(paths)
})
app.on('open-file', (event, path) => {
  // Do not let the default handling (such as adding to recent documents) happen.
  event.preventDefault()
  if (closingDown) return
  openFileBatcher.push(path)
})

if (isPrimaryInstance) registerResourceScheme()

/**
 * Announce to the OS as the default handler of `aios://` (TODO 976 stage 3). On macOS it has no effect without `CFBundleURLTypes` in Info.plist
 * (`infoPlistOps` in `scripts/app-shell.mjs`, shared by the shell and the distributed build).
 * **It is not announced for a development launch (`electron .` = `process.defaultApp`) or a duplicated userData (`--user-data-dir`, verification build)**:
 * announcing would make a bare Electron.app or a verification build the default handler, and URLs would no longer reach the aios in use.
 */
function registerAppUrlScheme(): void {
  if (process.defaultApp === true) return
  if (!isDefaultUserData(app.getPath('userData'))) return
  // TODO 1263: `temoto://` is an alias of `aios://` (both are in Info.plist's `CFBundleURLSchemes`).
  for (const scheme of APP_URL_SCHEMES_ACCEPTED) {
    if (app.isDefaultProtocolClient(scheme)) continue
    const ok = app.setAsDefaultProtocolClient(scheme)
    log.info('app-url.scheme.registered', { scheme, ok })
  }
}
if (isPrimaryInstance) registerAppUrlScheme()

/**
 * Open windows. **Only the renderer's state is independent per window**; the services on the main side
 * are one each. A push to `webContents` goes to all windows (no filtering:
 * missing an approval would stall the CLI, and there are only a few windows).
 */
const windows = new WindowSet<BrowserWindow>((window) => !window.isDestroyed())

/**
 * Send a `ViewerCommand` only to the window `viewId` (= `webContents.id`). Both the gateway's openFile / closeFile
 * (item 97) and the check for external rewrites (TODO 673) use this: the destination is only the window showing that thread,
 * or (673) only the window currently being viewed; it is not put on the all-window `pusher`.
 */
function sendViewerCommand(viewId: number, command: ViewerCommand): void {
  const target = windows.list().find((window) => window.webContents.id === viewId)
  if (target === undefined || target.isDestroyed()) return
  target.webContents.send(IpcEvent.viewerRemote, command)
}

/** Entry point for remembering window positions. Set in bootstrap. */
let windowSettings: AppSettingsStore | null = null
/** Owner of the theme (7.4.1). Needed for a new window's `backgroundColor`. */
let themeController: ThemeController | null = null
/** Owner of the display language (7.4.4). Needed for a new window's initial query. */
let localeController: LocaleController | null = null
/** Whether shutdown has started. Nothing is written to `app_settings` after it starts (12.9). */
let closingDown = false

/**
 * Source of the Dock badge (TODO 73). Updated on every `threadsChanged` / `threadChanged` / `approvalsChanged`.
 * The list can also arrive as a diff (item 75), so it is kept per thread id.
 */
const badgeThreads = new Map<string, BadgeThread>()
let badgeApprovals: readonly ApprovalItem[] = []

/**
 * Update the Dock badge (TODO 73, ARCHITECTURE.md 3.1). macOS only (`app.dock` is
 * undefined on other OSes). Not called after shutdown (same reason as 12.9: once all windows are
 * cleaned up there is no point touching only the icon; aligned with the `closingDown` safety net).
 */
function updateDockBadge(): void {
  if (closingDown) return
  if (!isMac()) return
  const n = countBadge([...badgeThreads.values()], badgeApprovals)
  setDockBadge(n > 0 ? String(n) : '')
}

/**
 * Bring the menu bar icon in line with the setting, the display language and what the menu shows (TODO 1269 / 1302). Idempotent and cheap (the menu is
 * rebuilt only when its contents change). The numbers come from the same maps as the Dock badge (`badgeThreads`, `badgeApprovals`), not a second tally.
 */
function syncMenuBarTray(): void {
  if (closingDown) return
  if (menuBarTray === null) return
  const enabled = menuBarTray.allowed && osSettingsHandle?.menuBar.get() === true
  sessions?.setTrayFolders(enabled)
  menuBarTray.sync({
    enabled,
    // Nothing is read while the icon is off (the folder history is a DB read plus a few `stat`s).
    menu: !enabled
      ? emptyTrayMenu(localeController?.locale ?? localeFromTag(app.getLocale()))
      : {
          locale: localeController?.locale ?? localeFromTag(app.getLocale()),
          pending: badgeApprovals.length,
          badge: countBadge([...badgeThreads.values()], badgeApprovals),
          ...trayThreadLists(badgeThreads, badgeApprovals),
          dictate: voiceTranscriber?.available() ?? false,
          // TODO 1316: shown next to the dictation row only while the key is actually registered.
          dictateKey: dictateHotkey?.status().state === 'registered' ? (dictateHotkey.status().accelerator ?? null) : null,
          // TODO 1305: only jobs with a clock time (the scheduler's overview); triggers fire on events, not at a time, so they have no row.
          schedule: selectUpcomingJobs(
            (jobScheduler?.overview().jobs ?? []).map((job) => ({ ...job, kind: job.action.kind })),
            Date.now()
          ),
          folders: sessions?.recentCwdPaths(TRAY_FOLDER_LIMIT) ?? [],
          home: homedir(),
          recent: recentThreadRows(badgeThreads, TRAY_RECENT_LIMIT)
        }
  })
}

/** TODO 1316: the open window that is showing this thread (restored and focused), or null. The map is main's own (`ThreadViews`), no renderer round trip. */
function windowShowingThread(threadId: string): BrowserWindow | null {
  const viewId = sessions?.windowShowing(threadId) ?? null
  if (viewId === null) return null
  const window = windows.list().find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === viewId)
  if (window === undefined) return null
  if (window.isMinimized()) window.restore()
  window.focus()
  return window
}

/** An item of the menu bar icon was chosen (TODO 1269). "New Thread" is the same entry as the global hotkey: a new empty conversation, the window brought forward. */
function runTrayAction(action: TrayAction): void {
  if (closingDown) return
  if (action === 'quit') {
    app.quit()
    return
  }
  if (typeof action === 'object') {
    if (isMac()) app.focus({ steal: true })
    if (action.kind === 'newInFolder') {
      // TODO 1301: the same entry as `aios://new?cwd=` (the choke point and the first-folder band apply). A folder is never reused from an earlier empty conversation.
      void handleAppUrl(`${APP_URL_SCHEME}://new?cwd=${encodeURIComponent(action.path)}`)
    } else if (action.kind === 'openSchedule') {
      // TODO 1305: the schedule screen on that job (the same request a reminder's notification click sends).
      deliverOpenRequest(frontWindow(), { scheduleJobId: action.jobId })
    } else {
      // TODO 1303: open that conversation (the same entry as the hotkey and `aios://`). TODO 1316: a window that already shows it is the one brought forward.
      deliverOpenRequest(windowShowingThread(action.threadId) ?? frontWindow(), { threadId: action.threadId })
    }
    return
  }
  if (action === 'newThread') {
    summonFromHotkey(false)
    return
  }
  if (action === 'dictate') {
    // TODO 1304: the dictation hotkey's entry (a new empty conversation with no folder, recording started once the Composer is shown).
    summonFromHotkey(true)
    return
  }
  if (action === 'pickFolder') {
    void pickFolderForNewThread()
    return
  }
  if (isMac()) app.focus({ steal: true })
  frontWindow()
}

/** TODO 1301: "Choose Folder…" in the menu bar menu. The OS dialog (no owner window: the app may have none), then a new conversation in the chosen folder. */
async function pickFolderForNewThread(): Promise<void> {
  if (isMac()) app.focus({ steal: true })
  const uiLocale = localeController?.locale ?? localeFromTag(app.getLocale())
  const result = await dialog.showOpenDialog({
    title: nativeText(uiLocale, 'dialog.pickDirectory.title'),
    message: nativeText(uiLocale, 'dialog.pickDirectory.message'),
    properties: ['openDirectory', 'createDirectory']
  })
  const picked = result.filePaths[0]
  if (closingDown || result.canceled || picked === undefined) return
  await handleAppUrl(`${APP_URL_SCHEME}://new?cwd=${encodeURIComponent(picked)}`)
}

/** Timer that sends `powerMonitor` values to the index process. Stopped on shutdown. */
let powerTimer: ReturnType<typeof setInterval> | null = null
/** Timer waiting to start the index right after launch. Cancelled if shutdown comes first (12.9). */
let indexStartTimer: ReturnType<typeof setTimeout> | null = null
let sessions: SessionManager | null = null
/** The choke point used to judge a Drop on the Dock (item 98). Set in bootstrap. */
let fsAccess: FsAccess | null = null
let indexClient: IndexClient | null = null
let gateway: GatewayServer | null = null
let plugins: PluginHost | null = null
/** TODO 1039 / 1038: the plugin surfaces. `dispose()` on `before-quit` (nothing is pushed afterwards). */
let pluginSurfacesRef: PluginSurfaces | null = null
let audit: AuditLog | null = null
/** Git summary for the BottomBar (5.6, TODO 51). `dispose()` on shutdown to stop the child process. */
let gitStatus: GitStatusReader | null = null
/** "Recent files" (TODO 999). `dispose()` on shutdown so git is not called afterwards (same as `gitStatus`). */
let recentFilesRegistration: RecentFilesRegistration | null = null
/** Scheduled runs (TODO 323). Stopped on `before-quit` before SessionManager (waits for a run that is about to start). */
let jobScheduler: JobScheduler | null = null
/** Triggers (TODO 1216). Stopped on `before-quit` before SessionManager (waits for the one that is about to start). */
let triggerService: TriggerService | null = null
/**
 * Export and import (TODO 1088). TODO 1117: `stop()` on `before-quit` (lets the running body exit at a boundary and deletes the half-written
 * thread), before `sessions.stop` and `db.close()`. It is not counted in the quit confirmation (`activityBlocker`)
 * (owner decision 2026-11-05).
 */
let dataTransfer: DataTransfer | null = null
/** Automatic backup (TODO 1306). `stop()` on `before-quit` before `dataTransfer.stop` (a running backup / restore leaves at a boundary). */
let backups: BackupService | null = null
/** Web tabs and history (TODO 522). `shutdown()` on `before-quit` before the DB is closed (nothing is written afterwards). */
let webViews: WebViewHandle | null = null
let webExtras: WebExtrasHandle | null = null
/** Transcription of voice input (TODO 934). On `before-quit` the child and temporary files are cleaned up. */
let voiceTranscriber: VoiceTranscriber | null = null
/** Start at login and keep-awake (TODO 1266 / 1270). `dispose()` on shutdown releases the sleep blocker. */
let osSettingsHandle: OsSettingsHandle | null = null
/** The macOS menu bar icon (TODO 1269). On unless the user turned it off (TODO 1301); `dispose()` on shutdown so the icon is gone before the DB closes. */
let menuBarTray: MenuBarTray | null = null
/** Global hotkey (TODO 976 part 1, 3.3). Registers the `app.summon` assignment with `globalShortcut`. `dispose()` on shutdown. */
let globalHotkey: GlobalHotkey | null = null
/** TODO 1267: the dictation hotkey (`app.summonDictate`, no default). Same registry and the same "not in verification builds" rule as `globalHotkey`. */
let dictateHotkey: GlobalHotkey | null = null
/** Retry interval for 'failed' (TODO 976 review Y-4). */
const HOTKEY_RETRY_INTERVAL_MS = 3 * 60 * 1000
let hotkeyRetryTimer: ReturnType<typeof setInterval> | null = null
/** The conversation the hotkey created last (reused next time too as long as it has not sent a single message) (TODO 976 review Y-3). */
let summonedThreadId: string | null = null
/** Auto-update (TODO 103). At the end of `before-quit`, the symlink is switched to the installed version (`applyAtQuit`). */
let updates: UpdateService | null = null
/** Update of the backend itself (TODO 774). Stopped on `before-quit` (nothing runs afterwards, and settings are not written). */
let agentUpdates: AgentUpdateService | null = null
let db: Database | null = null
/** Viewer autosave setting (TODO 555). The handling of drafts before closing a window or quitting (TODO 606) looks at the mode. */
let autoSavePreference: AutoSavePreference | null = null
/**
 * Number of days for folding the thread list (TODO 659). `openWindow` puts it in the query as material for the
 * first frame right after launch (code-review fix, same shape as `themeController` / `localeController`).
 */
let threadCollapsePreference: ThreadCollapsePreference | null = null
/** Unsaved viewer drafts before closing a window or quitting (TODO 606). Set in bootstrap. */
let draftsCloser: ViewerDraftsCloser | null = null
/** Watch for rewrites by external tools (TODO 673). Set in bootstrap. `untrack` when a window is closed / reloaded. */
let viewerFileWatcher: ViewerFileWatcher | null = null
/** Windows whose drafts have been settled and that may close without asking again (TODO 606). */
const closeApproved = new WeakSet<BrowserWindow>()
/** Windows currently settling drafts (so a Cmd+W pressed repeatedly does not stack). */
const closeSettling = new WeakSet<BrowserWindow>()
/**
 * Windows currently settling drafts for a reload (TODO 636, code-review fix). **A separate set from `closeSettling`**:
 * this used to reuse `closeSettling`, so a Cmd+W / Cmd+Q arriving during the settling was picked up by `isBusy()` and
 * silently dropped. `close` / `before-quit` look at this set and remember the request; after the settling they close / quit
 * instead of reloading via `reloadOrDefer`.
 */
const reloadSettling = new WeakSet<BrowserWindow>()
/**
 * A Cmd+W / Cmd+Q that arrived during a reload's settling (close / quit after the settling). **Per window** (TODO 1125 review fix):
 * a Cmd+Q is tied only to the window that was settling at that moment and is dropped only by that window's cancel (not by another window's cancel).
 */
const reloadPending = new ReloadPendingRequests<BrowserWindow>()
/** Settling of drafts before quit is done (later `before-quit` and the `close` of windows that quit closes do not ask). */
let quitApproved = false
/** Settling of drafts before quit is in progress (so a Cmd+Q pressed repeatedly does not stack). */
let quitSettling: Promise<boolean> | null = null

/**
 * Choke point before a restart ("restart to update" and TODO 967's "restart"). Not started while a window's close settling (a sheet) is in progress
 * (TODO 933, same as Cmd+Q; no second sheet on the same window). Otherwise `settleDraftsForQuit`.
 */
function settleDraftsForRestart(): Promise<boolean> {
  if (windows.list().some((window) => closeSettling.has(window))) return Promise.resolve(false)
  // TODO 1004 (review): if a conversation is running, ask once here (the same choke point for Cmd+Q, relaunch and the update restart).
  // Consent is carried over as "already confirmed" to the following `app.quit()` and is not asked twice. It does not depend on a prior confirmation by the caller.
  return quitConfirm.confirmForRestart().then(async (confirmed) => {
    if (!confirmed) return false
    const ok = await settleDraftsForQuit()
    if (ok) quitConfirm.markConfirmed()
    else quitConfirm.reset()
    return ok
  })
}

/** The OS is shutting down (logout / restart / shutdown). A marker so the confirmation does not block the OS from quitting (TODO 1004). */
let systemShuttingDown = false

/** Cmd+Q confirmation (TODO 1004): once, and only while a conversation is running. `before-quit` looks at it. */
const quitConfirm = new QuitConfirm({
  blocker: () => (sessions === null ? null : sessions.activityBlocker()),
  // Do not ask while the OS is logging out / restarting / shutting down (`powerMonitor`'s 'shutdown').
  systemShutdown: () => systemShuttingDown,
  ask: async (kind) => {
    const uiLocale = localeController?.locale ?? localeFromTag(app.getLocale())
    const options = {
      type: 'warning' as const,
      message: nativeText(uiLocale, kind === 'quit' ? 'dialog.quit.message' : 'dialog.relaunch.message'),
      detail: nativeText(uiLocale, kind === 'quit' ? 'dialog.quit.detail' : 'dialog.relaunch.detail'),
      buttons: [
        nativeText(uiLocale, kind === 'quit' ? 'dialog.quit.confirm' : 'dialog.relaunch.confirm'),
        nativeText(uiLocale, 'dialog.cancel')
      ],
      defaultId: 1,
      cancelId: 1
    }
    const owner = BrowserWindow.getFocusedWindow() ?? windows.list().at(-1) ?? null
    const result =
      owner === null || owner.isDestroyed()
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(owner, options)
    return result.response === 0
  },
  proceed: () => app.quit()
})

/**
 * Before quitting, settle the unsaved viewer drafts of all windows (TODO 606). Cmd+Q, "restart to update", and the OS quitting when the last window closes
 * all go through here. If autosave is ON, write everything out; if OFF, ask "save?". If some remain unwritten, ask. false if the user backs out.
 */
function settleDraftsForQuit(): Promise<boolean> {
  if (quitApproved) return Promise.resolve(true)
  const closer = draftsCloser
  if (closer === null || !closer.needsSettle(windows.list())) return Promise.resolve(true)
  if (quitSettling !== null) return quitSettling.then(() => false)
  const job = closer
    .settleAll(windows.list())
    .then((verdict) => {
      if (verdict === 'proceed') quitApproved = true
      log.info('app.quit.drafts', { verdict })
      return verdict === 'proceed'
    })
    .catch((err: unknown) => {
      // If the settling itself breaks, do not stop the quit (being unable to quit is worse).
      log.error('app.quit.drafts.failed', errorFields(err))
      quitApproved = true
      return true
    })
    .finally(() => {
      quitSettling = null
    })
  quitSettling = job
  return job
}

/**
 * Reload a window (the menu's "Reload" / "Force Reload", TODO 636). A reload goes through neither `close` nor `before-quit`,
 * so it first goes through the same settling as 606 (write out if autosave is ON, ask if OFF). If cancelled, no reload. During the settling the window is put in
 * `reloadSettling`, and another reload is not stacked (no second dialog on the same window).
 *
 * **code-review fix:** a Cmd+W / Cmd+Q arriving during the settling is remembered (by the `close` / `before-quit` handlers) in
 * `reloadPending` (per window). When the settling is over and it is time to actually reload,
 * `reloadOrDefer` looks at it and decides whether to close / quit instead of reloading; no second dialog is shown
 * (the result of the same settling as 606 is used as is).
 */
function reloadWindow(window: BrowserWindow, kind: ReloadKind): void {
  // If it is not an aios window (DevTools, etc.), reload it directly as before.
  if (!windows.list().includes(window)) {
    if (kind === 'ignoreCache') window.webContents.reloadIgnoringCache()
    else window.webContents.reload()
    return
  }
  void reloadWithDrafts(kind, {
    isGone: () => window.isDestroyed(),
    isCrashed: () => window.webContents.isCrashed(),
    isBusy: () => closeSettling.has(window) || reloadSettling.has(window) || quitSettling !== null,
    needsSettle: () => draftsCloser?.needsSettle([window]) === true,
    setBusy: (busy) => {
      if (busy) reloadSettling.add(window)
      else reloadSettling.delete(window)
    },
    settle: () => draftsCloser?.settleReload(window) ?? Promise.resolve('proceed' as const),
    quitting: () => closingDown || quitting,
    // TODO 1125: on cancel or when the window is gone, drop the Cmd+Q / Cmd+W remembered for this window during the settling (quit / close are
    // regarded as called off too). A Cmd+Q remembered for another window stays (review fix).
    dropPending: () => {
      if (reloadPending.drop(window)) log.info('window.reload.pendingDropped', {})
    },
    reload: (how) => {
      const action = reloadOrDefer(reloadPending.pendingFor(window))
      reloadPending.forget(window)
      if (action === 'quit') {
        reloadPending.forgetQuit()
        log.info('window.reload.deferred', { to: 'quit' })
        app.quit()
        return
      }
      if (action === 'close') {
        log.info('window.reload.deferred', { to: 'close' })
        // The drafts were already settled by `settle()` (decided one way or the other: saved or discarded). Close as is
        // without showing a second dialog.
        closeApproved.add(window)
        window.close()
        return
      }
      if (how === 'ignoreCache') window.webContents.reloadIgnoringCache()
      else window.webContents.reload()
    }
  })
}

/**
 * Saved positions of closed windows (in the order closed). Empty if there is no DB. The record of windows to restore at the next launch
 * (item 36) is not included; only `restoreWindows` at launch reads that.
 */
function savedBounds(): readonly WindowBounds[] {
  return closedBounds(windowSettings?.readTyped(WINDOW_BOUNDS) ?? [])
}

/** Positions of the currently open windows. Used so the next window does not overlap. */
function openBounds(): readonly WindowBounds[] {
  return windows.list().map((window) => window.getBounds())
}

/**
 * Open one window and add it to the set (T21). The entry points are this one place: Cmd+N / Dock menu / `second-instance` /
 * `activate` / bootstrap. `placement` is used only when the launch-time restore (item 36) passes the
 * previous position; if omitted, `chooseBounds` decides. `maximized` is also passed only from
 * the restore (item 197): **create with a normal frame and then maximize** (`maximize()` can be called even while
 * still `show: false`; when `show()` is called on `ready-to-show` it appears already maximized).
 */
function openWindow(placement?: WindowBounds, maximized = false): BrowserWindow {
  const theme = themeController?.theme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  // `screen` can only be used after ready, but a window is always created after ready.
  const displays = screen.getAllDisplays().map((display) => display.workArea)
  const bounds =
    placement ?? chooseBounds({ saved: savedBounds(), open: openBounds(), displays })
  const locale = localeController?.locale ?? localeFromTag(app.getLocale())
  const threadCollapseDays = threadCollapsePreference?.get() ?? DEFAULT_COLLAPSE_OLD_AFTER_DAYS
  const window = createWindow(theme, locale, bounds, threadCollapseDays)
  if (maximized) window.maximize()
  windows.add(window)

  // Read the position **just before closing** (at `closed` it is destroyed and `getBounds` throws).
  // Nothing is written after shutdown has started (12.9: the DB may already be closed).
  window.on('close', (event) => {
    if (closingDown) return
    // TODO 636 (code-review fix): during the settling of drafts for a reload, do not ask anew here; just
    // remember the request and defer it until after the settling (`reloadOrDefer` of `reloadWindow` looks at it). No second dialog is
    // shown: whether to close instead of reloading is decided when the reload's settling finishes.
    if (reloadSettling.has(window)) {
      event.preventDefault()
      reloadPending.requestClose(window)
      return
    }
    // TODO 933: drop a Cmd+W during the quit's draft settling (starting a separate close settling would make the quit side's `settleAll`
    // ask the same window again and show a second sheet). If quit is already decided (`quitApproved`), let it through.
    if (shouldDropCloseDuringQuitSettle({ quitApproved, quitSettling: quitSettling !== null })) {
      event.preventDefault()
      return
    }
    // TODO 606: if the viewer has unsaved drafts, settle them before closing (write out if autosave is ON, ask if OFF).
    // Windows that quit closes (`quitApproved`) were already handled in `before-quit`.
    const closer = draftsCloser
    if (!quitApproved && !closeApproved.has(window) && closer !== null && closer.needsSettle([window])) {
      event.preventDefault()
      if (closeSettling.has(window)) return
      closeSettling.add(window)
      void closer
        .settleWindow(window)
        .catch((err: unknown) => {
          log.error('window.close.drafts.failed', errorFields(err))
          return 'proceed' as const
        })
        .then((verdict) => {
          closeSettling.delete(window)
          log.info('window.close.drafts', { verdict })
          if (verdict !== 'proceed' || window.isDestroyed()) return
          closeApproved.add(window)
          window.close()
        })
      return
    }
    persistBounds(window)
  })
  // The thread shown in each window (TODO 71). The key is `webContents.id`, the same value as the IPC's
  // `event.sender.id`. At `closed`, `.webContents` throws, so take it first.
  const viewId = window.webContents.id
  window.on('closed', () => {
    windows.delete(window)
    sessions?.closeView(viewId)
    openRequests.forget(viewId)
    draftsCloser?.forget(viewId)
    viewerFileWatcher?.untrack(viewId)
  })
  // After a reload the renderer starts with no thread open.
  window.webContents.on('did-navigate', () => {
    sessions?.closeView(viewId)
    draftsCloser?.forget(viewId)
    viewerFileWatcher?.untrack(viewId)
  })
  // An unread that arose on the displayed thread while in the background is cleared when the window comes back to the front.
  window.on('focus', () => sessions?.focusView(viewId))
  // TODO 1308: reload a crashed renderer (bounded), and log hangs.
  let queuedReopen: OpenRequest | null = null
  recoveryHandles.set(window, attachRendererRecovery(window, {
    isShuttingDown: () => closingDown || quitting,
    // TODO 1319: after a reload the thread the window showed is opened again (it is read before `did-navigate` closes the view). A thread that was
    // removed or sent to the trash in the meantime is not (`hasThread` is false for it), and nothing is opened for a window that showed none.
    threadOf: () => sessions?.threadOfView(viewId) ?? null,
    // The request is queued for the renderer's own init to take (no event is sent to the dying one) and only when the window has no request waiting, so a
    // newer "open this" (notification, menu bar, hotkey) that arrives during the reload is never overwritten by this older one.
    reopenThread: (threadId) => {
      if (closingDown || window.isDestroyed() || sessions?.hasThread(threadId) !== true) {
        log.info('window.renderer.reopenSkipped')
        return
      }
      const request: OpenRequest = { threadId }
      if (!openRequests.putIfAbsent(viewId, request)) {
        log.info('window.renderer.reopenSkipped')
        return
      }
      queuedReopen = request
      log.info('window.renderer.reopened')
    },
    dropReopen: () => {
      if (queuedReopen !== null) openRequests.forgetIf(viewId, queuedReopen)
      queuedReopen = null
    },
    showFailure: (reason) => {
      const template = readFileSync(recoveryTemplatePath(app.getAppPath()), 'utf8')
      const html = recoveryPageHtml(template, {
        locale: localeController?.locale ?? localeFromTag(app.getLocale()),
        theme: themeController?.theme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
        reason
      })
      void window.loadURL(recoveryPageUrl(html)).catch((err: unknown) => log.error('window.renderer.failurePageLoadFailed', errorFields(err)))
    }
  }))
  if (windows.size === 1) window.focus()
  log.info('window.opened', { count: windows.size, restored: bounds !== null })
  return window
}

/** The position to remember. While maximized or full screen, the "original size". */
function boundsToRemember(window: BrowserWindow): WindowBounds {
  const maximized = window.isMaximized() || window.isFullScreen()
  return maximized ? window.getNormalBounds() : window.getBounds()
}

/**
 * Whether the window is maximized by zoom (the green button) (item 197). **Full screen is not included**: coming back from full screen
 * can put the window in an odd position or add another virtual desktop (unverified, but
 * following the owner decision "open full screen as a normal window"). `isMaximized()` can return true even in full screen in some
 * implementations, so `!isFullScreen()` is checked first to exclude it.
 */
function isMaximizedNotFullScreen(window: BrowserWindow): boolean {
  return window.isMaximized() && !window.isFullScreen()
}

/**
 * Add the position of one individually closed window to `app_settings` (T21). A closed window is not
 * restored at the next launch (item 36), so it stays only as a position candidate.
 */
function persistBounds(window: BrowserWindow): void {
  const settings = windowSettings
  if (settings === null || window.isDestroyed()) return
  try {
    settings.writeTyped(WINDOW_BOUNDS, rememberBounds(savedBounds(), boundsToRemember(window)))
  } catch (err) {
    log.warn('window.bounds.saveFailed', errorFields(err))
  }
}

/**
 * On quit, record the state of the open windows (position and displayed thread) (item 36).
 * **Call it at the start of `before-quit`, before the DB is closed**: the `close` of windows that `app.quit()` closes comes
 * after the shutdown processing, so it cannot be taken there (T21). With 0 windows, the restore record is empty and
 * the next launch opens one window as before.
 */
function persistSession(): void {
  const settings = windowSettings
  if (settings === null) return
  try {
    const open = windows.list().map((window) => ({
      bounds: boundsToRemember(window),
      threadId: sessions?.threadOfView(window.webContents.id) ?? null,
      focused: window.isFocused(),
      maximized: isMaximizedNotFullScreen(window)
    }))
    settings.writeTyped(WINDOW_BOUNDS, snapshotSession(settings.readTyped(WINDOW_BOUNDS), open))
    log.info('window.session.saved', { count: open.length })
  } catch (err) {
    log.warn('window.bounds.saveFailed', errorFields(err))
  }
}

/**
 * At launch, restore all the previous windows (item 36, same model as Chrome). If there is no record (0 windows at the previous
 * quit, an old-format saved value, first run), open one window as before. The record is **used up**: after restoring,
 * only the positions of closed windows are written back, so the same windows are not restored twice at the next launch.
 *
 * The thread for a window to open is handed over with `deliverOpenRequest` (a `send` right after opening comes before the renderer's
 * subscription and would be lost). A thread that no longer exists is not opened, and a window with no record selects nothing (item 80).
 */
function restoreWindows(threadExists: (threadId: string) => boolean): void {
  const settings = windowSettings
  const saved = settings?.readTyped(WINDOW_BOUNDS) ?? []
  const displays = screen.getAllDisplays().map((display) => display.workArea)
  const plan = planRestore({ saved, displays, threadExists })
  if (settings !== null && saved.some((state) => state.restore === true)) {
    try {
      settings.writeTyped(WINDOW_BOUNDS, closedBounds(saved))
    } catch (err) {
      log.warn('window.bounds.saveFailed', errorFields(err))
    }
  }
  if (plan.length === 0) {
    // For a run started by the auto-update idle restart (TODO 103), do not show a window if the previous run had 0 windows (left in the Dock).
    if (process.argv.includes(UPDATE_RELAUNCH_ARG)) {
      log.info('window.session.restored', { count: 0, threads: 0, updateRelaunch: true })
      return
    }
    openWindow()
    return
  }
  for (const entry of plan) {
    const window = openWindow(entry.bounds ?? undefined, entry.maximized)
    if (entry.threadId !== null) deliverOpenRequest(window, { threadId: entry.threadId })
  }
  log.info('window.session.restored', {
    count: plan.length,
    threads: plan.filter((entry) => entry.threadId !== null).length
  })
}

/**
 * Hand a window "the thread I want you to open" (or the reason it could not be opened) and signal it (item 98 (c) / 36).
 * **Anything where main makes a window open a thread goes through here**: even a newly opened window does not miss it, since the renderer
 * subscribes in `init()` and then comes to fetch. One per window (a later one wins).
 */
function deliverOpenRequest(target: BrowserWindow, request: OpenRequest): void {
  if (target.isDestroyed()) return
  openRequests.put(target.webContents.id, request)
  target.webContents.send(IpcEvent.openRequest)
}

/** TODO 1319: each window's recovery handle (its failure page's "Load Again" is answered in `createWindow`'s `will-navigate`). */
const recoveryHandles = new WeakMap<BrowserWindow, RecoveryHandle>()

/**
 * Create a window. **Flash prevention right after launch (7.4.1)** is a combination of these two:
 *
 *   1. `show: false` + `ready-to-show`: do not show until the first frame can be drawn.
 *   2. Set `backgroundColor` to the **resolved theme's `--bg`**. CSS variables
 *      do not affect the window's base color, so the saved value is read before the window is created.
 *
 * Also, so the renderer can draw in the right colors from the very first frame, the theme name is passed
 * in the query (the renderer can write `<html data-theme>` without waiting for an IPC round trip).
 * **The folding days are passed for the same reason** (code-review fix, TODO 659): waiting for IPC `get()` would make the list flicker
 * with the default (5 days) folding for a moment right after launch even if the user changed it to 0 (no folding).
 */
function createWindow(
  theme: Theme,
  locale: Locale,
  bounds: WindowBounds | null,
  threadCollapseDays: number
): BrowserWindow {
  const window = new BrowserWindow({
    ...(bounds ?? DEFAULT_WINDOW_SIZE),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    title: PRODUCT_NAME,
    ...windowChromeOptions(),
    backgroundColor: THEME_BACKGROUND[theme],
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // IMPLEMENTATION_BRIEF chapter 7: do not give the renderer Node.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })

  // TODO 1307: a verification launch (`npm run smoke`) shows its windows without activating the app.
  const inactive = showsInactive(process.env, isDefaultUserData(app.getPath('userData')))
  window.on('ready-to-show', () => (inactive ? window.showInactive() : window.show()))

  // TODO 1119: the CSP does not stop WebRTC (ICE STUN / TURN). So that a viewer frame cannot send the contents of the opened file out through
  // RTCPeerConnection, the main window does not use UDP that bypasses the proxy. The main window's renderer itself does not use WebRTC.
  // The Web view (`persist:aios-web`) is a separate webContents and is used by meeting sites, so it is left alone.
  window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

  // Viewer back / forward (TODO 369): a 3-finger swipe (macOS) and the mouse back / forward buttons
  // (`app-command` on Windows / Linux) are sent to the renderer of the window that received them. The decision is in `navigation-gesture.ts`.
  const sendNav = (command: ViewerNavCommand | null): void => {
    if (command === null || window.isDestroyed()) return
    window.webContents.send(IpcEvent.menuCommand, command)
  }
  window.on('swipe', (_event, direction) => sendNav(navFromSwipe(direction)))
  window.on('app-command', (_event, command) => sendNav(navFromAppCommand(command)))

  // New-window requests (`target="_blank"` etc.) are always refused, and only `http:` / `https:` / `mailto:` are
  // handed to the external browser (5.1 "external links"). The decision is the same pure function as the IPC path,
  // so `file:` / `javascript:` / `data:` are also dropped here. Arbitrary
  // URLs are never opened inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    // The failure page's "Load Again" opened with a modifier key or the middle button is a new-window request, not a navigation: answer it the same way.
    if (isRecoveryReload(url)) {
      recoveryHandles.get(window)?.loadAgain()
      return { action: 'deny' }
    }
    void openExternalChecked(url, (target) => shell.openExternal(target), 'window-open')
    return { action: 'deny' }
  })
  // TODO 1319: the one navigation that is not refused: the failure page's "Load Again" link (a fixed address, `recovery-page.ts`).
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
    if (isRecoveryReload(event.url)) recoveryHandles.get(window)?.loadAgain()
  })
  // TODO 919: a viewer frame (child frame) may only stay inside its own plugin's `aios-plugin://<id>/`. It must not be navigated to an outside page, `data:` or another plugin:
  // the host sends the port and the current file's contents with `targetOrigin '*'` on every iframe `load`, so the contents would reach the
  // document navigated to. The decision is in `capability/viewer-csp.ts` (electron-independent).
  window.webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    let frameUrl = ''
    let initiatorUrl: string | null = null
    let initiatorIsTop = false
    try {
      frameUrl = details.frame?.url ?? ''
      initiatorUrl = details.initiator?.url ?? null
      initiatorIsTop = details.initiator !== null && details.initiator !== undefined && details.initiator.parent === null
    } catch {
      // Touching it after the frame is gone throws. Decide on the side of "unknown" (nobody initiated it).
    }
    if (allowViewerFrameNavigation({ url: details.url, frameUrl, initiatorUrl, initiatorIsTop })) return
    details.preventDefault()
    let scheme = 'invalid'
    try {
      scheme = new URL(details.url).protocol
    } catch {
      // A malformed URL.
    }
    log.warn('viewer.frame.navigationBlocked', { scheme, from: frameUrl.startsWith('aios-plugin:') ? new URL(frameUrl).hostname : null })
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer !== undefined) {
    const url = new URL(devServer)
    url.searchParams.set(THEME_QUERY_KEY, theme)
    url.searchParams.set(LOCALE_QUERY_KEY, locale)
    url.searchParams.set(THREAD_COLLAPSE_QUERY_KEY, String(threadCollapseDays))
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'), {
      query: {
        [THEME_QUERY_KEY]: theme,
        [LOCALE_QUERY_KEY]: locale,
        [THREAD_COLLAPSE_QUERY_KEY]: String(threadCollapseDays)
      }
    })
  }

  return window
}

async function bootstrap(): Promise<void> {
  // When launched from Finder / Dock / BetterTouchTool, PATH is only launchd's default,
  // and none of the commands the user installed can be found. Fix it before looking for the CLI.
  await widenPathForGuiLaunch()

  // TODO 316: identity of version and build. macOS's About shows the running values, not the Info.plist (the version at the time the `.app` was made).
  const build = currentBuildInfo(app.getVersion())
  const runtime = currentRuntimeInfo()
  // TODO 1254: the default applicationName is the internal name (`app.name` = aios), so pass the public name.
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, ...aboutPanelValues(build, runtime) })

  const userDataDir = app.getPath('userData')
  const userDataLabel = isDefaultUserData(userDataDir) ? null : userDataDir
  // TODO 1314: new scratch areas of a non-default profile go under its userData; the real instance keeps `~/<data name>/scratch/`.
  const scratchRootOverride = userDataLabel === null ? undefined : join(userDataDir, SCRATCH_FOLDER)
  // TODO 1306: a restore confirmed before the restart moves the broken DB aside here, before anything opens it (8.7).
  const pendingRestore = takePendingRestore(userDataDir, { dbFile: DB_FILE, keyFile: KEY_FILE })
  let opened: ReturnType<typeof openDatabase>
  try {
    opened = openDatabase(userDataDir)
  } catch (err) {
    // Downgrade safety net (TODO 103): quit without opening or writing anything. There is no window yet either, so
    // tell the user with a native dialog (main's language decision is the same as the initial value without settings, 7.4.4).
    if (err instanceof DatabaseTooNewError) {
      const locale = localeFromTag(app.getLocale())
      log.error('db.tooNew', { dbVersion: err.dbVersion, knownVersion: err.knownVersion })
      dialog.showErrorBox(
        nativeText(locale, 'dialog.dbTooNew.title'),
        nativeText(locale, 'dialog.dbTooNew.message')
      )
      app.quit()
      return
    }
    throw err
  }
  db = opened.db

  // A push from main to the renderer **goes to all windows** (T21, chapter 3). No destination filtering:
  // missing an approval would leave the CLI stopped, and there are only a few windows.
  // Scanning continues even after all windows are closed, so `WindowSet.list()` drops dead windows every time
  // (even referencing `.webContents` of a destroyed BrowserWindow throws).
  const pusher = createPusher(() => windows.list().map((window) => window.webContents))
  // The file entry point that remains in main (P1, 3.1). **It does not touch the index tables.**
  // It is also main's only holder of the exclusion rules, and the Broker reads them from here via a getter.
  const access = new FsAccess()
  // The canonical-copy entry point for threads is **one per app** (the same one is passed to SessionManager). If the table of
  // working-folder colors (item 108) were held in two copies, each one's writes would overwrite the colors handed out by the other.
  const threadStore = new ThreadStore(opened.db, access.homePath, scratchRootOverride)

  // Color theme (7.4.1). Resolved **before creating windows**: `backgroundColor` needs it.
  // Resolving `system` is nativeTheme's job; if the OS changes, it is pushed to the renderer.
  const settings = new AppSettingsStore(opened.db)
  windowSettings = settings
  const theme = new ThemeController({
    settings,
    native: nativeTheme,
    onChanged: (state) => pusher.theme(state)
  })
  themeController = theme

  // Display language (7.4.4). Like the theme, resolved before creating windows (the initial query needs it).
  // The only wording main produces is a few words of native UI (menus and dialogs) (`i18n-native.ts`).
  // The menus are built after this, so language changes are connected to them later.
  let menus: InstalledMenus | null = null
  const locale = new LocaleController({
    settings,
    systemLocale: () => app.getLocale(),
    onChanged: (state) => {
      pusher.locale(state)
      menus?.setLocale(state.resolved)
      syncMenuBarTray()
    }
  })
  localeController = locale

  // Cache of the feature table. Do not run a probe for an unknown version every time (4.6).
  const adapter = createAgentAdapter({
    read: (version) => {
      const raw = threadStore.readFeatureCache(version)
      if (raw === null) return null
      try {
        return JSON.parse(raw) as AgentFeatureMap
      } catch {
        return null
      }
    },
    // The probe (item 81) runs on the first send, so it can overlap with shutdown. Do not write
    // after the DB is closed (12.9). Whatever could not be written is simply probed once more at the next launch.
    write: (version, features) => {
      if (closingDown) return
      threadStore.writeFeatureCache(version, JSON.stringify(features))
    },
    // Model versions and effective levels learned from the CLI (items 91 / 92). Shows the versions from the very start of the next launch.
    // The write happens on the response at session start, so it can overlap with shutdown (12.9).
    readModels: (backendId) => threadStore.readBackendModels(backendId),
    writeModels: (backendId, json) => {
      if (closingDown) return
      threadStore.writeBackendModels(backendId, json)
    }
  })

  // The canonical copy of plugin-originated body text (6.5 / 12.9). Only one copy, inside the encrypted DB.
  const pluginDocuments = new PluginDocumentStore(opened.db)

  // Git summary for the BottomBar (5.6, TODO 51). The URI gate is FsAccess's, used as is.
  gitStatus = new GitStatusReader({ assertAllowed: (uri) => access.assertAllowed(uri, true) })

  // Open in an external editor (item 115). The setting is one key of `settings` (the same table as theme / language),
  // and the URI gate is FsAccess's. `editor.open` stays `'write'` with no exception; only the "open in external editor" of the band on a link that could not be opened
  // (`editor.openHandoff`, TODO 808) is "`'write'` -> `'handoff'` if refused" (wave 44 code-review fix).
  const editorPreference = new EditorPreference(settings)
  const { editor: editorLauncher, handoff: editorHandoffLauncher } = createEditorLaunchers({
    assertAllowed: (uri, asDirectory, kind) => access.assertAllowed(uri, asDirectory, kind),
    getEditorId: () => editorPreference.get()
  })

  // Desktop notifications (item 72, end of ARCHITECTURE.md 3.1). The decision (show or batch) and
  // building the wording are in `notify.ts`. Here is only electron's `Notification` itself and thin wiring
  // that, on click, brings up the window and selects the thread.
  const notifications = new NotificationPreference(settings)
  const createNotification: CreateDesktopNotification = (title, body, actions) => {
    // TODO 1265: only reminders pass `actions` (the snooze buttons). macOS shows them only for a signed app in the "Alerts" style.
    const notification = new Notification({
      title,
      body,
      silent: false,
      ...(actions === undefined ? {} : { actions: actions.map((text) => ({ type: 'button' as const, text })) })
    })
    // Item 240: keep OS-side failures (no permission, etc.). electron passes a reason string with `failed`.
    notification.on('failed', (_event, error) => log.warn('notify.failed', { error }))
    return {
      show: () => notification.show(),
      close: () => notification.close(),
      onClick: (callback) => notification.on('click', callback),
      onAction: (callback) => notification.on('action', (details) => callback(details.actionIndex))
    }
  }
  const desktopNotifier = new DesktopNotifier({
    enabled: () => notifications.get(),
    create: createNotification,
    onClick: (threadId) => {
      if (closingDown) return
      // If there are 0 windows, `frontWindow()` opens one. Even a freshly opened window does not miss it:
      // the renderer subscribes and then comes to fetch, so `deliverOpenRequest` (item 98 (c) / 36) is safe.
      deliverOpenRequest(frontWindow(), { threadId })
    }
  })
  // TODO 1265: reminders (notification only). Clicking opens that job's editor (the snooze buttons are there too, for when the OS hides the
  // notification's buttons); a snooze button goes straight to the scheduler. `jobScheduler` is created later, but a reminder is shown only by it.
  const reminderNotifier = new ReminderNotifier({
    create: createNotification,
    locale: () => locale.locale,
    onClick: (jobId) => {
      if (closingDown) return
      deliverOpenRequest(frontWindow(), { scheduleJobId: jobId })
    },
    onSnooze: (jobId, minutes) => {
      if (closingDown) return
      try {
        jobScheduler?.snooze(jobId, minutes)
      } catch (err) {
        log.warn('schedule.reminder.snoozeFailed', { jobId, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })

  // Index process (P1, chapter 3). Scanning, watching, building the index, full-text search and file-name search
  // all run on the other side of this. **The key is passed after the fork in an `open` message** (3.3).
  indexClient = new IndexClient({
    entry: join(import.meta.dirname, 'index-host.js'),
    open: {
      file: opened.file,
      key: opened.key,
      userVersion: opened.version,
      home: homedir(),
      roots: null,
      // Extracting the body of PDFs (TODO 1009). Without it, the index process handles PDFs without body text.
      pdfHelperPath: swiftHelperPath(app.getAppPath(), 'pdf-helper'),
      // Finding images by content (TODO 998). Without it, the index process handles images by file name only.
      visionHelperPath: swiftHelperPath(app.getAppPath(), 'vision-helper')
    },
    // The canonical copy stays in main. The index process asks with a reverse RPC (3.4).
    canonical: {
      conversation: {
        readEventText: (eventId) => threadStore.eventText(eventId),
        threadTitle: (threadId) => threadStore.threadTitle(threadId),
        liveEventIds: (eventIds) => threadStore.liveEventIds(eventIds)
      },
      // Only the Adapter knows the location and format of transcript reading (constraint 6 / 12.7).
      transcripts: adapter.transcripts,
      // Conversation transcripts owned by aios threads are not included / reading stops there (item 111, 4.5.9).
      ownedTranscripts: () =>
        new Map([...threadStore.ownedBackendSessions()].map(([sid, owner]) => [sid, owner.limit])),
      plugins: pluginDocuments
    },
    events: {
      onScanStatus: (status) => pusher.scanStatus(status),
      onFileChanges: (batch) => pusher.fileChanges(batch),
      onIndexStatus: (status) => pusher.indexStatus(status),
      // The allowed volumes changed. Rebuild main's rules from the same material (3.5).
      onRules: (payload) => access.rebuildRules(payload.allowedVolumes, payload.volumesDir)
    }
  })
  const index = indexClient

  // ---- Phase 4: trust boundary (chapter 7) ----
  //
  // Plugin code is not run in main (constraint 8). Privileged operations are decided in one place by the
  // CapabilityBroker and written to the audit log (7.7 / chapter 8).
  audit = new AuditLog(opened.db)
  const auditLog = audit
  // D-2 (review 2026-09-21): once at launch, drop audit log entries past the retention period
  // (same treatment as `ThreadStore.applyRetention`). Default 90 days, no UI (chapter 8).
  {
    const retentionDays = settings.readTyped(AUDIT_RETENTION_DAYS) ?? DEFAULT_AUDIT_RETENTION_DAYS
    if (retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
      const pruned = auditLog.prune(cutoff)
      if (pruned > 0) log.info('audit.pruned', { pruned, retentionDays })
    }
  }
  // The exclusion rules are read from the **same instance** of FsAccess via a getter (4.4.2 "external storage").
  // When it is rebuilt by a change of allowed volumes (the index process's `ntf rules`),
  // the Broker / ViewerBroker side changes at the same time.
  const pathScope = {
    get rules() {
      return access.exclusionRules
    }
  }
  const credentials = new CredentialStore(userDataDir, {
    available: () => safeStorage.isEncryptionAvailable(),
    seal: (value) => safeStorage.encryptString(value),
    open: (sealed) => safeStorage.decryptString(sealed)
  })

  // TODO 907: the default viewer per extension (VS Code's `workbench.editorAssociations`). This is main's only writer.
  const viewerAssociations = new ViewerAssociations(settings)
  // TODO 1039 / 1038: the plugin surfaces (sidebar lists, sync progress). Holds validated values and pushes the whole to the renderer.
  const pluginSurfaces: PluginSurfaces = new PluginSurfaces({
    sidebarTitleOf: (id) => {
      const manifest = pluginHost.manifestOf(id)
      const summary = pluginHost.summaries().find((entry) => entry.id === id)
      return manifest?.sidebarView !== undefined && summary?.enabled === true && pluginHost.isBundled(id)
        ? manifest.sidebarView.title
        : null
    },
    viewerSchemesOf: (id) => (pluginHost.manifestOf(id)?.viewer?.schemes ?? []).map((scheme) => scheme.toLowerCase()),
    isEnabled: (id) => pluginHost.summaries().some((entry) => entry.id === id && entry.enabled),
    onChange: (snapshot) => pusher.pluginSurfaces(snapshot)
  })
  pluginSurfacesRef = pluginSurfaces
  // TODO 1144 stage 1: the version table of extensions (`plugins.json` of the latest Release). The app's update check (registerUpdateHandlers below)
  // fetches it and re-sends the list when it changes (8.5.1).
  const pluginRelease = new PluginReleaseCatalog(() => {
    if (!closingDown) pusher.pluginsChanged(pluginHost.summaries())
  })
  // TODO 1144 stage 2: the location of versions fetched by per-extension updates (`<userData>/plugin-updates/<id>/<version>/`). The trust anchor is `plugins.updated` in the
  // encrypted DB (8.5.1). PluginHost reads only versions larger than the bundled one.
  const updatedPlugins = new UpdatedPluginStore(join(userDataDir, 'plugin-updates'), {
    read: () => settings.readTyped(PLUGIN_UPDATED_VERSIONS),
    write: (records) => settings.writeTyped(PLUGIN_UPDATED_VERSIONS, records)
  })
  const pluginHost: PluginHost = new PluginHost({
    db: opened.db,
    // Bundled plugins go in out/plugins/, and user-installed ones under userData.
    bundledDir: join(import.meta.dirname, '../plugins'),
    userDir: join(userDataDir, 'plugins'),
    hostEntry: join(import.meta.dirname, 'plugin-host.js'),
    broker: () => broker,
    // TODO 1227 fix X: the contents of an external extension changed (reload, or recomputed just before waking) -> if it differs from when the trigger's rule was written, set it back to disabled.
    onIdentityChanged: () => triggerService?.reconcileOwners(),
    // TODO 1233 (7.2): uninstalling an external extension. The folder goes to the trash (recoverable, so no confirmation dialog is shown).
    removeDirectory: (path) => shell.trashItem(path),
    // Inside the same DB transaction, delete the rules, pending events and setting values (DB rows only. `triggerStore` is created before `load()`; it is called
    // after IPC is opened). The in-memory queue and notifications come after the commit (`onPluginForgotten`, wave 86 fix Y).
    forgetPluginData: (pluginId) => {
      const removed = triggerStore.forgetPlugin(pluginId)
      log.info('trigger.rules.forgotten', { pluginId, removed })
      pluginSettings.forget(pluginId)
    },
    onPluginForgotten: (pluginId) => triggerService?.dropPlugin(pluginId),
    // TODO 1237: delete the documents an extension wrote to the index. The index (index process RPC) first, the canonical copy after (the reverse of 6.5). If the index fails, the canonical copy is kept
    // and it throws (`PluginHost` leaves a marker and retries at the next launch).
    forgetPluginIndex: async (pluginId) => {
      const removed = await index.removePluginDocumentsOf(pluginId)
      // If shutdown starts while waiting for the RPC, do not write to main's DB (no writes after `db.close()`). Throw to leave the marker and retry at the next launch.
      if (closingDown) throw new Error('closing down')
      const canonical = pluginDocuments.removeOwnedBy(pluginId)
      log.info('plugin.documents.forgotten', { pluginId, indexed: removed, canonical })
    },
    onChanged: (list) => {
      pusher.pluginsChanged(list)
      // Discard the rows and reports of a disabled plugin (when re-enabled, the plugin pushes them again).
      for (const entry of list) if (!entry.enabled) pluginSurfaces.clear(entry.id)
      pluginSurfaces.refresh()
    },
    associations: () => viewerAssociations.all(),
    pluginUpdate: (plugin) => pluginRelease.updateOf(plugin),
    updated: updatedPlugins
  })
  plugins = pluginHost

  // TODO 1225 (7.2.1): extension settings (`configuration` in the manifest). Values are `plugins.settings` in `app_settings`, and this is the only writer.
  const pluginSettings = new PluginSettingsStore({
    read: () => settings.readTyped(PLUGIN_SETTINGS),
    write: (value) => settings.writeTyped(PLUGIN_SETTINGS, value),
    configurationOf: (id) => pluginHost.manifestOf(id)?.configuration,
    known: (id) => pluginHost.manifestOf(id) !== null,
    identityOf: (id) => pluginHost.identityOf(id),
    identitiesReady: () => pluginHost.identitiesReady()
  })
  registerPluginSettingsHandlers(pluginSettings)

  const broker = new CapabilityBroker({
    scope: pathScope,
    audit: auditLog,
    credentials,
    policyOf: (id) => pluginHost.policyOf(id),
    indexClearing: (id) => pluginHost.indexClearing(id),
    // TODO 1280: an extension's own documents by uri, for the viewer of its sidebar list rows.
    documents: pluginDocuments,
    index: {
      // **Canonical copy first, index after** (6.5). With P1, writing the canonical copy is main and putting it in the index
      // is the index process, which split them, so the order is kept explicitly here (3.4).
      put: async (document) => {
        const updatedAt = document.updatedAt ?? Date.now()
        pluginDocuments.put({ ...document, updatedAt })
        await index.putPluginDocument({ ...document, updatedAt })
      },
      remove: async (source, sourceId) => {
        await index.removePluginDocument(source, sourceId)
        pluginDocuments.remove(source, sourceId)
      }
    },
    notify: (pluginId, title, body) => pusher.pluginNotification({ pluginId, title, body }),
    surfaces: pluginSurfaces,
    // TODO 848: `browser.fetchPage` fetches with the Web view's session (`persist:aios-web`). The session is prepared at the first fetch.
    browser: webPageTransport(() => webPageSession(APP_INTERNAL_NAME)),
    // TODO 1216: the trigger entry point. `triggerService` is created after SessionManager, so it is looked up at call time (refused if not yet).
    triggers: () => triggerService,
    // TODO 1225: an extension reads only its own settings (looked up by the extension id the Broker was asked for).
    settings: (pluginId) => pluginSettings.values(pluginId)
  })

  // TODO 673: check for rewrites by external tools (at most 1 file per window, 7.4). The notification goes as `fileChanged`
  // only to the window that is showing it (`sendViewerCommand`, the same path as the gateway's openFile / closeFile).
  viewerFileWatcher = new ViewerFileWatcher({
    notify: (viewId, uri) => sendViewerCommand(viewId, { kind: 'fileChanged', uri })
  })

  const viewerBroker = new ViewerBroker({
    broker,
    audit: auditLog,
    scope: pathScope,
    resolveViewer: (uri) => pluginHost.resolveViewer(uri),
    resolveViewerWith: (uri, pluginId) => pluginHost.resolveViewerWith(uri, pluginId),
    watch: viewerFileWatcher,
    imageConvert: { tempDir: app.getPath('temp') }
  })

  // TODO 1216 / 1227: the trigger table. Shared by SessionManager's choke point (tools of external extensions that a rule allowed in an unattended turn) and TriggerService.
  // TODO 1237 (wave 87 code-review): create it before the row-stage cleanup at the head of `load()` (used by `forgetPluginData`).
  const triggerStore = new TriggerStore(opened.db)
  pluginHost.load()
  // TODO 1237 (wave 87 code-review) migration: at the first identity computation, add the current identity to setting values of external extensions that have no owner record (once only).
  void pluginHost
    .identitiesReady()
    .then(() => {
      if (closingDown) return
      // TODO 1240: do not delete setting values of an external identity (they do not apply to the bundled one via `matches`; deleting them would reset that external one to default values on the next launch where the bundled one cannot be read).
      pluginSettings.adoptUnowned()
    })
    .catch((err: unknown) => log.warn('plugin.settings.adopt.failed', errorFields(err)))
  // TODO 952 stage 1: the entry point that calls a plugin's scheduled tasks in plugin-host (state is `plugin_task_state` in the encrypted DB). Used by JobScheduler.
  // TODO 1264: tasks also receive the display language (the words of sidebar rows such as the calendar's "Today").
  const pluginTaskInvoker = new PluginTaskInvoker(pluginHost, new PluginTaskStateStore(opened.db), Date.now, () => locale.locale)
  // TODO 952 stage 1 / the rest of 817 (1)(2)(3): the "Account" section in an extension's details (loading a Google client, login, logout).
  // How to refresh is registered at launch (credentials need not exist yet). Values are given neither to the renderer nor to plugins (7.7).
  const pluginAccounts = new PluginAccounts({
    credentials,
    manifestOf: (id) => pluginHost.manifestOf(id),
    isBundled: (id) => pluginHost.isBundled(id),
    fetchFn: (url, init) => fetch(url, init),
    openUrl: openInDefaultBrowser,
    chooseClientFile: () =>
      chooseClientFile(BrowserWindow.getFocusedWindow(), nativeText(locale.locale, 'dialog.oauthClient.title')),
    // Right after login, wake that plugin's tasks (the aios.gmail ingestion) without waiting for the interval (the idle condition is unchanged).
    onSignedIn: (id) => jobScheduler?.wakePluginTasks(id),
    // On logout, discard the resume position (historyId, etc.). Already ingested local documents are not deleted (decided in stage 3).
    // TODO 1264: also drop the sidebar rows that came from that account right away, and wake the tasks so the plugin can put back its "sign in" guidance.
    onSignedOut: (id) => {
      pluginTaskInvoker.reset(id)
      pluginSurfaces.clear(id)
      jobScheduler?.wakePluginTasks(id)
    },
    onChanged: () => {
      if (!closingDown) pusher.pluginsChanged(pluginHost.summaries())
    }
  })
  pluginAccounts.registerRefreshers()
  registerPluginAccountHandlers(pluginAccounts)
  // TODO 847 (7.6.7): relay of plugin tools. The gateway's `pluginTools` / `pluginTool` are received through SessionManager.
  const pluginTools = new PluginToolRelay({ source: pluginHost, audit: auditLog })
  // TODO 1237: the index and canonical-copy document stage of an uninstall from the previous launch (the row stage was done at the head of `load()`).
  void pluginHost.sweepPendingUninstalls().catch((err: unknown) => log.warn('plugin.uninstall.sweep.failed', errorFields(err)))

  // Unix socket between gateway and main (7.6). Set up before SessionManager.
  gateway = new GatewayServer(join(userDataDir, 'run'), async (request) => {
    if (sessions === null) throw new Error('aios not ready')
    return sessions.handleGatewayRequest(request)
  })
  await gateway.start()

  // Item 186: when launching with a proxy-verification copy (a duplicate of the real userData), pass `AIOS_DISABLE_AGENT=1`.
  // The copy's window opens at the same position and the same thread as the real one and is indistinguishable. If a person types there, even though the DB is
  // a copy, the CLI and files are the real ones, so a turn would run in the real repository.
  const agentDisabled = process.env['AIOS_DISABLE_AGENT'] === '1'
  if (agentDisabled) log.warn('session.agent.disabled', { env: 'AIOS_DISABLE_AGENT' })

  // Wave 17 bundle B: the latest value of the usage limit (item 317, 12.2). One for the whole app, picked up from `rate_limit` and sent to all windows.
  const usage = registerUsageHandlers(settings, () => windows.list().map((window) => window.webContents))
  // Wave 26 bundle B: the state of the connection to the model (TODO 525). Picked up from `api_retry` / a successful `result` and sent to all windows.
  const connection = registerConnectionHandlers(() => windows.list().map((window) => window.webContents))
  // TODO 972: roles (Teammates). The manager reads a role's defaults and standing instructions from here.
  const roleStore = new RoleStore(opened.db)
  sessions = new SessionManager({
    agentDisabled,
    // TODO 1314: a non-default profile keeps its scratch areas under its own userData, so it never shares the real root.
    ...(scratchRootOverride === undefined ? {} : { scratchRoot: scratchRootOverride }),
    roles: roleStore,
    // The entry point that starts the backend (startLive) waits while an update is in progress (TODO 787 code-review 4). agentUpdates is created later.
    isBackendUpdating: () => agentUpdates?.isUpdating() ?? false,
    // Bundle conversations (TODO 633 stage 3): do not start new ones when the usage limit has been reached.
    isUsageLimited: () => usageLimitReached(usage.get(), Date.now()),
    // TODO 959: approval for an unattended turn of a scheduled run lasts until the next scheduled time. jobScheduler is created later, but this is called only after a job has run.
    scheduledJobNextRunAt: (jobId) => jobScheduler?.nextRunAt(jobId) ?? null,
    // TODO 983: name of the role (`job:<jobId>`) of a conversation a job started. If the job is gone, do not make it a role.
    scheduledJobName: (jobId) => jobScheduler?.jobName(jobId) ?? null,
    // TODO 982: a drill of a prompt job runs the job's own prompt (read by main, never sent by the renderer).
    scheduledJobPrompt: (jobId) => jobScheduler?.promptOf(jobId) ?? null,
    db: opened.db,
    store: threadStore,
    // Registry (4.6.1). The first is the default. In TODO 529 the second (a server-type backend) is lined up after it.
    adapters: [adapter, ...createSecondaryAdapters({ appPath: app.getAppPath() })],
    fs: access,
    index,
    gateway,
    pluginTools,
    // TODO 1227: whether it is a tool of an external extension that a rule allowed in an unattended read-only turn.
    triggerToolAllowance: (pluginId, triggerId, toolName, fingerprint) =>
      triggerStore.allowsTool(pluginId, triggerId, toolName, fingerprint),
    // TODO 1225: the sources of extensions that can be narrowed with the gateway's `search` `source` (sources of their own namespace declared by enabled extensions).
    pluginIndexSources: () =>
      pluginHost
        .summaries()
        .filter((summary) => summary.enabled)
        .flatMap((summary) =>
          (pluginHost.policyOf(summary.id)?.declared.indexSources ?? []).filter((source) => indexSourceOwnedBy(summary.id, source))
        ),
    // TODO 1052: the AI reads the body of open Web tabs (`getOpenUrlText`). webViews is created later, but this is called only after
    // a conversation is running. The first-time consent is one in the app settings.
    webTabs: {
      list: (viewId) => webViews?.listTabs(viewId) ?? [],
      read: (viewId, tabId) => webViews?.readTab(viewId, tabId) ?? Promise.resolve({ ok: false, reason: 'closed' })
    },
    // TODO 1061 (1): hand the ViewerPane rendering to the AI (`getViewerScreenshot`). For Web, the tab being shown; for file viewers and
    // temporary views, the host captures the window's renderer rectangle (no capability is added to plugins).
    viewerCapture: {
      web: (viewId, tabId) => webViews?.captureTab(viewId, tabId) ?? Promise.resolve({ ok: false, reason: 'closed' }),
      pane: (viewId) => captureViewerPane(viewId)
    },
    webTabReadConsent: {
      granted: () => {
        try {
          return settings.readTyped(WEB_TAB_READ_CONSENT)
        } catch {
          return false
        }
      },
      grant: () => {
        try {
          settings.writeTyped(WEB_TAB_READ_CONSENT, true)
        } catch (err) {
          log.warn('web.readConsent.saveFailed', errorFields(err))
        }
      }
    },
    // The gateway starts the Electron binary as Node (spike 10).
    gatewayRuntimePath: process.execPath,
    gatewayScriptPath: join(import.meta.dirname, 'gateway.js'),
    gatewayConfigDir: join(userDataDir, 'run', 'mcp'),
    // Unread decision (TODO 71): even if displayed, when the app is in the background it is "not visible".
    isViewFocused: (viewId) =>
      windows.list().some((window) => window.webContents.id === viewId && window.isFocused()),
    // Desktop notifications (item 72). SessionManager calls this only when the thread is not being displayed (already narrowed by isSeen).
    // The wording is built here (main may know the language only here, TODO 66's native UI exception).
    notify: {
      approvalPending: (threadId, threadTitle) =>
        desktopNotifier.notify(
          threadId,
          resolveNotifyTitle(threadTitle, locale.locale),
          notifyBody('approval', locale.locale)
        ),
      turnEnded: (threadId, threadTitle) =>
        desktopNotifier.notify(
          threadId,
          resolveNotifyTitle(threadTitle, locale.locale),
          notifyBody('turnEnded', locale.locale)
        ),
      // Scheduled runs (TODO 323): on finish, the start of the response; for approval waits, the wording says it "stopped".
      scheduledTurnEnded: (threadId, threadTitle, excerpt) => {
        const text = scheduledNotifyText('done', threadTitle, excerpt, locale.locale)
        desktopNotifier.notify(threadId, text.title, text.body)
      },
      // TODO 1216: the end of a trigger's first turn. The heading is the trigger's name and title, the body is the start of the response.
      triggeredTurnEnded: (threadId, triggerName, threadTitle, excerpt) => {
        const text = triggerNotifyText(triggerName, threadTitle, excerpt, locale.locale)
        desktopNotifier.notify(threadId, text.title, text.body)
      },
      // TODO 1216: an unattended turn ended; wake the next one in the queue.
      triggerTurnSettled: () => {
        triggerService?.pump()
      },
      scheduledApprovalPending: (threadId, threadTitle) => {
        const text = scheduledNotifyText('approval', threadTitle, '', locale.locale)
        desktopNotifier.notify(threadId, text.title, text.body)
      },
      // TODO 959: awaiting approval of an operation that sends something out. When no window is in front, or for an unattended job, only a notification (no OS modal).
      outboundPending: (threadId, threadTitle, scheduled) => {
        const text = outboundNotifyText(threadTitle, scheduled, locale.locale)
        desktopNotifier.notify(threadId, text.title, text.body)
      },
      // TODO 351 (351-2): when a turn ends or the process dies, fix the "running" / "run now" in the settings screen's list.
      // `jobScheduler` is created after this, but this is called only after
      // launch is finished (session events arrive later than that).
      scheduledJobRunningChanged: (_jobId) => {
        jobScheduler?.refresh()
      },
      // TODO 628 (code-review): if the user sends by hand or the interruption is lifted, delete that thread's post-lift resume reservation.
      threadResumed: (threadId) => {
        jobScheduler?.cancelResumeFor(threadId)
      }
    },
    events: {
      onEvents: (batch) => {
        pusher.threadEvents(batch)
        usage.observe(batch)
        connection.observe(batch)
      },
      onThreadsChanged: (threads) => {
        pusher.threadsChanged(threads)
        badgeThreads.clear()
        for (const summary of threads) {
          badgeThreads.set(summary.thread.id, badgeThreadOf(summary))
        }
        updateDockBadge()
        syncMenuBarTray()
      },
      onThreadChanged: (summary) => {
        pusher.threadChanged(summary)
        const before = badgeThreads.get(summary.thread.id)
        const after = badgeThreadOf(summary)
        badgeThreads.set(summary.thread.id, after)
        // Touch the Dock only when unread changed (since this arrives on every `turn_usage`).
        if (before?.unread !== after.unread) updateDockBadge()
        // TODO 1302 / 1303: the menu bar also shows "running" and the titles, so it follows a change of any of them (not the other fields of every `turn_usage`).
        if (before?.unread !== after.unread || before?.running !== after.running || before?.title !== after.title) syncMenuBarTray()
      },
      // TODO 1301: the menu bar's recent folders follow a removal from the history.
      onCwdHistoryChanged: () => syncMenuBarTray(),
      onTrayFoldersChanged: () => syncMenuBarTray(),
      onApprovalsChanged: (items) => {
        pusher.approvalsChanged(items)
        badgeApprovals = items
        updateDockBadge()
        syncMenuBarTray()
      },
      onAgentStatus: (status) => {
        pusher.agentStatus(status)
        // TODO 774: reflect failures of the version, "unverified version" and the post-upgrade check (probe).
        agentUpdates?.observe(status)
      },
      // Report of the global-side MCP servers (item 164). The "MCP servers" section of the settings screen redraws.
      onMcpReportChanged: (report) => pusher.mcpReport(report),
      // The full list of deleted threads (item 222). Even if deleted / restored in another window, this window's folding is aligned on the spot.
      onDeletedThreadsChanged: (items) => pusher.deletedThreads(items),
      // The gateway's openFile / closeFile (item 97). **The destination is only the window showing that thread**
      // (not put on the all-window `pusher`). `webContents.id` is the same value as the key of `ThreadViews`.
      onViewerCommand: (viewId, command) => sendViewerCommand(viewId, command),
      // TODO 982: a drill recorded a stopped operation - the windows fetch that drill's list again (only the id is sent).
      onDrillChanged: (threadId) => pushDrillChanged(threadId, windows.list().map((window) => window.webContents))
    }
  })

  const appInfo: AppInfo = {
    productName: PRODUCT_NAME,
    dataName: APP_INTERNAL_NAME,
    version: app.getVersion(),
    homeUri: access.homeUri,
    storage: opened.mode,
    storageReason: opened.storageReason,
    platform: hostPlatform() as Platform,
    userDataLabel,
    agentDisabled,
    build,
    runtime
  }

  handleResourceScheme(broker)
  handlePluginScheme(pluginHost)
  // Wave 23 bundle C: ASCII input in the search box (TODO 463, 4.5.11). The helper is an artifact of `npm run build:input-source`, and
  // does nothing on non-macOS or if it is missing (launch is not stopped). Created before IPC because it goes into the settings editor's table of default values.
  const asciiInput = registerAsciiInput(
    settings,
    swiftHelperPath(app.getAppPath(), 'input-source-helper'),
    () => pusher.settingsChanged()
  )
  // Wave 28 bundle D: viewer autosave (TODO 555). One for the whole app, to all windows on change. Created before IPC because it goes into the settings editor's table of default values
  // (same as `asciiInput`).
  const autoSave = registerAutoSaveHandlers(settings, () => windows.list().map((window) => window.webContents))
  autoSavePreference = autoSave
  // TODO 907: candidates for "open with another viewer" and the default viewer per extension (settings list, reset to default).
  registerViewerAssociationHandlers(pluginHost, viewerAssociations)
  // TODO 1174: Help. Resolve `help://` to the bundled `resources/help/` and return the body (does not go through FsAccess, 7.4.13).
  registerHelpHandlers({
    root: helpRoot(app.getAppPath()),
    locale: () => locale.locale,
    resolveViewerWith: (uri, pluginId) => pluginHost.resolveViewerWith(uri, pluginId)
  })
  // TODO 1060: copy the same material to `~/<data name>/help/` (TODO 1263) (at every launch compare contents with the bundled ones and restore only differing files. The AI consults it for settings questions, 7.6.8 stage 4). A failure does not stop launch.
  // TODO 1307: only the real profile writes there; a disposable or copied one (a worktree build under `npm run smoke`) would
  // otherwise rewrite the copy the real instance's AI reads with its own version.
  if (userDataLabel !== null) {
    log.info('help.sync', { result: 'skipped-copy' })
  } else {
    try {
      const result = syncHelpDocs({
        root: helpRoot(app.getAppPath()),
        home: homedir(),
        version: `${build.version}+${build.commit}${build.dirty ? `.dirty-${build.date}` : ''}`,
        names: HELP_BACKEND_NAMES
      })
      log.info('help.sync', { result })
    } catch (error) {
      log.warn('help.sync.failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
  // Wave 30 bundle C: how many days of inactivity fold a row in the thread list (TODO 659). One for the whole app, to all windows on change.
  const threadCollapse = registerThreadCollapseHandlers(settings, () =>
    windows.list().map((window) => window.webContents)
  )
  threadCollapsePreference = threadCollapse
  // Wave 43 bundle C: the order of the file tree (TODO 872). One for the whole app, to all windows on change.
  const fileSort = registerFileSortHandlers(settings, () => windows.list().map((window) => window.webContents))
  // Wave 47 bundle C: search box history (TODO 900). A window fetches it each time it opens, so no notification is needed.
  registerSearchHistoryHandlers(settings)
  // Wave 44 bundle A: Redmine base URL (TODO 811). One for the whole app, to all windows on change.
  const redmine = registerRedmineHandlers(settings, () => windows.list().map((window) => window.webContents))
  // Wave 29 bundle B: unsaved viewer drafts before closing a window or quitting (TODO 606). Whether drafts exist comes from the renderer's count notification.
  draftsCloser = registerViewerDraftsClose({
    mode: () => autoSavePreference?.get().mode ?? 'off',
    hasDrafts: (viewId) => sessions?.hasViewerDrafts(viewId) ?? false,
    locale: () => localeController?.locale ?? localeFromTag(app.getLocale()),
    windowOf: (viewId) => windows.list().find((window) => window.webContents.id === viewId) ?? null
  })
  // Wave 28 bundle G: auto-update (stage 1 of TODO 103, ARCHITECTURE 8.5). Only the distributed build that runs on install-temoto.sh's per-version directory
  // (`supported: false` for the development shell, npm run dev and copies). The symlink is switched at quit or at an idle restart.
  const updateService = registerUpdateHandlers({
    settings,
    defaultUserData: userDataLabel === null,
    getTargets: () => windows.list().map((window) => window.webContents),
    restartBlocker: () => sessions?.restartBlocker() ?? 'session',
    systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    closing: () => closingDown,
    // TODO 606: settle unsaved viewer drafts before "restart to update" (if the user backs out, neither the switch nor the restart happens).
    // TODO 933: do not start while a window's close settling (a sheet) is in progress (same as Cmd+Q; no second sheet on the same window).
    confirmRestart: settleDraftsForRestart,
    restartAborted: () => {
      if (!quitting) {
        quitApproved = false
        quitConfirm.reset()
      }
    },
    // TODO 1277: after the swap at quit / restart, register the login item again (does nothing while it is off).
    afterSwap: () => osSettingsHandle?.openAtLogin.refresh('update-applied'),
    pluginRelease,
    pluginInstall: { store: updatedPlugins, host: pluginHost }
  })
  updates = updateService
  updateService.start()
  // TODO 1186: changelog (the bundled `CHANGELOG.md`). main holds the decision to show the current version's section once on the first launch after an update
  // (it looks at the `justUpdated` that `start()` decided, so it is placed after `updateService.start()`).
  const releaseNotes = new ReleaseNotesService({
    settings,
    appPath: app.getAppPath(),
    currentVersion: app.getVersion(),
    justUpdated: () => updateService.status().justUpdated !== null
  })
  registerReleaseNotesHandlers(releaseNotes)
  // Wave 36 bundle D: update of the backend (agent CLI) itself (TODO 774, ARCHITECTURE 4.6.6). Only the everyday aios
  // (default userData). Runs at launch and once a day when no conversation is running.
  const agentUpdateService = registerAgentUpdateHandlers({
    settings,
    unsupportedReason: detectAgentUpdateUnsupported({ defaultUserData: userDataLabel === null, env: process.env }),
    backend: adapter.selfUpdate,
    getTargets: () => windows.list().map((window) => window.webContents),
    // Judge by activity only (responding, send queue, awaiting approval, reservations, background children, running `!`). Drafts are what a restart loses, so they are
    // not looked at. Narrowing the first reason of `restartBlocker` would depend on ordering, so `activityBlocker` is used directly.
    blocker: () => (sessions === null ? 'session' : sessions.activityBlocker()),
    redetect: () => (sessions === null ? adapter.getStatus(true) : sessions.agentStatus(true)),
    // TODO 943: finish the probe of the upgraded version in the background so the first send after it does not wait.
    prewarm: () => sessions?.probeInBackground(),
    closing: () => closingDown
  })
  agentUpdates = agentUpdateService
  agentUpdateService.start()
  // Wave 65 bundle A: install / remove CLI plugins from Settings Skills (TODO 1099, 4.5.3.3). In forms where it does not run (copy, dev, fake
  // backend) the decision is the same as 774: only the list is shown and install / remove return a reason. While a conversation is running, "after it finishes".
  registerCliPluginHandlers({
    opsDisabled: detectAgentUpdateUnsupported({ defaultUserData: userDataLabel === null, env: process.env }),
    blocker: () => (sessions === null ? 'session' : sessions.activityBlocker())
  })
  void (sessions?.agentStatus() ?? adapter.getStatus()).then(
    (status) => agentUpdateService.observe(status),
    () => undefined
  )
  // TODO 626 (wave 29 bundle D): the voice input recognition language. Read by both `registerIpcHandlers` (the settings editor's snapshot) and
  // `registerVoiceHandler` (below), so it is created first.
  const voiceLocale = new VoiceLocalePreferenceStore(settings)
  // TODO 1229: body font of Gmail drafts. Read by both the settings editor's snapshot and IPC, so it is created first.
  const gmailDraftFont = new GmailDraftFontPreference(settings)
  // Wave 53 bundle B: "recent files" (TODO 999, 4.5.12). Candidates come from the index process, git from runGit, and files the AI wrote from the conversation table.
  const sessionsForRecent = sessions
  const recentFiles = registerRecentFilesHandlers({
    settings,
    fs: access,
    index,
    aiWrittenPaths: (sinceMs) => sessionsForRecent.recentAiWrittenPaths(sinceMs),
    onScreenshotOfferChanged: () => pusher.settingsChanged()
  })
  recentFilesRegistration = recentFiles
  // Wave 15 bundle D: "show hidden files" in the file tree (TODO 261). One for the whole app, to all windows on change.
  // The menu's "Show Hidden Files" (Cmd+Shift+.) checkmark is also rebuilt (`menus` is created later. Moved before IPC in TODO 1060 stage 3 so it goes into the settings editor's table).
  const hiddenFiles = registerHiddenFilesHandlers(
    settings,
    () => windows.list().map((window) => window.webContents),
    () => menus?.refresh()
  )
  // Wave 93 bundle C: start at login (TODO 1266) and keep the computer awake while scheduled jobs wait (TODO 1270). Released in the `osSettings.dispose` shutdown step.
  const osSettings = registerOsSettingsHandlers({
    settings,
    environment: currentLoginItemEnvironment(userDataLabel === null),
    hasScheduledWork: () => jobScheduler?.hasUpcomingWork() ?? false,
    closing: () => closingDown,
    onChanged: () => pusher.settingsChanged(),
    onMenuBarChanged: () => syncMenuBarTray(),
    menuBarInstanceAllowed: userDataLabel === null
  })
  osSettingsHandle = osSettings
  // TODO 1277: the first launch after an update runs from the new version, so register the login item from here (the entry may still name the old version's path).
  if (updateService.status().justUpdated !== null) osSettings.openAtLogin.refresh('first-launch-after-update')
  // TODO 1269: the menu bar icon (macOS, default off). Created after the setting exists; the first sync shows it if it was left on.
  // Only the default userData shows the icon (like the global hotkey): an empty or copied DB has no `app.menuBar` value and would show the default (on),
  // and a copy would list the real conversations' titles.
  menuBarTray = new MenuBarTray(app.getAppPath(), runTrayAction, userDataLabel === null)
  syncMenuBarTray()
  // Wave 27 bundle E: keyboard shortcut assignments (TODO 549). On change, notify all windows and rebuild the menu accelerators.
  const keybindings = registerKeybindingsHandlers(
    settings,
    () => windows.list().map((window) => window.webContents),
    () => {
      menus?.refresh()
      // TODO 976 part 1: when the assignment changes, register the hotkey again (a failure stays in `status()`).
      applySummonHotkey(keybindings.get())
      // TODO 1316: the dictation row shows its key, so the menu is rebuilt when the assignment changes.
      syncMenuBarTray()
    },
    () => ({
      'app.summon': globalHotkey?.status() ?? { accelerator: null, state: 'off' },
      'app.summonDictate': dictateHotkey?.status() ?? { accelerator: null, state: 'off' }
    })
  )
  // TODO 976 review Y-2: only the instance with the default userData registers (dev, verification builds and copies start first and would take stable's key).
  globalHotkey = new GlobalHotkey(globalShortcut, () => summonFromHotkey(false), userDataLabel === null)
  dictateHotkey = new GlobalHotkey(globalShortcut, () => summonFromHotkey(true), userDataLabel === null)
  applySummonHotkey(keybindings.get())
  // TODO 976 review Y-4: take back a key that another app held only at the moment of launch. On window focus and every few minutes (with a limit, `MAX_RETRIES`).
  const retryHotkey = (): void => {
    // Both are retried (no short-circuit).
    if (!retryHotkeys([globalHotkey, dictateHotkey])) return
    syncMenuBarTray()
    for (const window of windows.list()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(IpcEvent.keybindingsChanged, keybindings.get())
    }
  }
  app.on('browser-window-focus', retryHotkey)
  hotkeyRetryTimer = setInterval(retryHotkey, HOTKEY_RETRY_INTERVAL_MS)
  hotkeyRetryTimer.unref()
  // Only one preference that remembers the value is created (the settings screen and the AI's settings tool, TODO 1060, use the same one).
  const autoLogin = new AutoLoginPreference(settings)
  registerIpcHandlers({
    fs: access,
    sessions,
    index,
    appInfo,
    plugins: pluginHost,
    surfaces: pluginSurfaces,
    // TODO 896: the plugin section of the search sidebar (7.5.1).
    pluginSearch: new PluginSearchRelay({ source: pluginHost }),
    viewer: viewerBroker,
    audit: auditLog,
    theme,
    locale,
    git: gitStatus,
    editor: editorLauncher,
    editorHandoff: editorHandoffLauncher,
    // TODO 967: relaunch after the screen recording permission. It goes through the same choke point as "restart to update" (drafts, a close settling in progress),
    // and if a version was staged, launches again with that version (`relaunchIntoStaged`; otherwise with the current one).
    relaunch: async () => {
      if (!(await settleDraftsForRestart())) return false
      if (updates?.relaunchIntoStaged() !== true) {
        app.relaunch()
        app.quit()
      }
      return true
    },
    editorPreference,
    openRequests,
    notifications,
    autoLogin,
    asciiInput,
    autoSave,
    hiddenFiles: () => hiddenFiles.get(),
    keybindings: () => keybindings.get(),
    onSettingsChanged: () => pusher.settingsChanged(),
    // TODO 1282: the login recovery's phase goes to every window; the wait is dropped once no window is open.
    onLoginRecovery: (state) => pusher.loginRecovery(state),
    hasWindows: () => windows.list().length > 0,
    autoUpdate: () => updateService.status().auto,
    agentAutoUpdate: () => agentUpdateService.status().auto,
    voiceLocale: () => voiceLocale.get(),
    gmailDraftFont: () => gmailDraftFont.get(),
    threadCollapseDays: () => threadCollapse.get(),
    fileSortOrder: () => fileSort.get(),
    redmineBaseUrl: () => redmine.get(),
    screenshotOffer: () => recentFiles.preference.get(),
    releaseNotesAuto: () => releaseNotes.getAuto(),
    openAtLogin: () => osSettings.openAtLogin.get(),
    preventSleep: () => osSettings.preventSleep.get(),
    menuBar: () => osSettings.menuBar.get(),
    // TODO 818: save a conversation as PDF. The destination is a dialog each time (a sheet on the calling window), starting at the previous folder.
    // TODO 866: single-file HTML goes through the same entry point (main reads the images and embeds them as `data:`).
    conversationExport: new ConversationExporter<BrowserWindow | null>({
      settings,
      askSavePath: async ({ defaultPath, owner, format }) => {
        const options = {
          title: nativeText(
            locale.locale,
            format === 'pdf' ? 'dialog.exportPdf.title' : format === 'html' ? 'dialog.exportHtml.title' : 'dialog.exportMd.title'
          ),
          defaultPath,
          filters:
            format === 'pdf'
              ? [{ name: 'PDF', extensions: ['pdf'] }]
              : format === 'html'
                ? [{ name: 'HTML', extensions: ['html'] }]
                : [{ name: 'Markdown', extensions: ['md'] }],
          properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const]
        }
        const result = owner === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(owner, options)
        return result.canceled || result.filePath === undefined || result.filePath === '' ? null : result.filePath
      },
      renderPdf: electronPdfRenderer(() => app.getPath('temp')),
      embedImages: async (html, threadId) =>
        (
          await embedImages(html, {
            assertAllowed: (uri) => void access.assertAllowed(uri, false, 'read'),
            baseDir: sessions?.threadWorkingCwd(threadId) ?? null,
            omittedLabel: nativeText(locale.locale, 'export.imageOmitted')
          })
        ).html,
      threadTitle: (threadId) => sessions?.threadTitle(threadId) ?? null,
      defaultDir: () => app.getPath('downloads'),
      fallbackName: () => nativeText(locale.locale, 'dialog.exportPdf.fallbackName')
    })
  })
  // Wave 59 bundle C: the AI of a conversation reads and changes aios's own settings (TODO 1060, 7.6.8). Values are the same snapshot as the settings editor,
  // and changes use the same setters as the settings screen (the owner and the notification to windows are unchanged). The approval of the choke point's key is asked by gateway-requests through the approval inbox.
  // The alias is intentional: `sessions` is a module-level `let ... | null` and null narrowing is lost inside the closures below, so it is taken into a const.
  const sessionsForSettings = sessions
  const agentSettings = new AgentSettings({
    snapshot: () =>
      settingsSnapshot({
        theme: () => theme.state().preference,
        locale: () => locale.state().preference,
        editor: () => editorPreference.get(),
        notifyEnabled: () => notifications.get(),
        autoLogin: () => autoLogin.get(),
        asciiForSearch: () => asciiInput.get(),
        autoSave: () => autoSave.get(),
        autoUpdate: () => updateService.status().auto,
        agentAutoUpdate: () => agentUpdateService.status().auto,
        voiceLocale: () => voiceLocale.get(),
        gmailDraftFont: () => gmailDraftFont.get(),
        threadCollapseDays: () => threadCollapse.get(),
        fileSortOrder: () => fileSort.get(),
        redmineBaseUrl: () => redmine.get(),
        screenshotOffer: () => recentFiles.preference.get(),
        releaseNotesAuto: () => releaseNotes.getAuto(),
        openAtLogin: () => osSettings.openAtLogin.get(),
        preventSleep: () => osSettings.preventSleep.get(),
        menuBar: () => osSettings.menuBar.get(),
        session: () => sessionsForSettings.getSettings(),
        approval: () => sessionsForSettings.getApprovalPolicy(),
        hiddenFiles: () => hiddenFiles.get(),
        keybindings: () => keybindings.get(),
        bundleMax: () => sessionsForSettings.getBundleMax()
      }),
    apply: {
      theme: (value) => theme.setPreference(value),
      locale: (value) => locale.setPreference(value),
      editor: (value) => editorPreference.set(value),
      notifyEnabled: (value) => notifications.set(value),
      autoLogin: (value) => autoLogin.set(value),
      asciiForSearch: (value) => asciiInput.set(value),
      autoSave: (value) => autoSave.set({ mode: value }),
      autoSaveDelayMs: (value) => autoSave.set({ delayMs: value }),
      autoUpdate: (value) => updateService.setAuto(value),
      agentAutoUpdate: (value) => agentUpdateService.setAuto(value),
      voiceLocale: (value) => voiceLocale.set(value),
      gmailDraftFont: (value) => gmailDraftFont.set(value),
      threadCollapseDays: (value) => threadCollapse.set(value),
      fileSortOrder: (value) => fileSort.set(value),
      redmineBaseUrl: (value) => redmine.set(value),
      screenshotOffer: (value) => recentFiles.preference.set(value),
      releaseNotesAuto: (value) => releaseNotes.setAuto(value),
      openAtLogin: (value) => osSettings.openAtLogin.set(value),
      preventSleep: (value) => {
        osSettings.preventSleep.set(value)
        osSettings.reevaluateSleep()
      },
      menuBar: (value) => {
        osSettings.menuBar.set(value)
      },
      maxConcurrent: (value) => sessionsForSettings.setSettings({ maxConcurrent: value }),
      idleTimeoutMs: (value) => sessionsForSettings.setSettings({ idleTimeoutMs: value }),
      defaultModelId: (value) => sessionsForSettings.setSettings({ defaultModelId: value }),
      defaultThinking: (value) => sessionsForSettings.setSettings({ defaultThinking: value }),
      autoAllowAll: (value) => sessionsForSettings.setApprovalPolicy({ autoAllowAll: value }),
      autoAllowTools: (value) => sessionsForSettings.setApprovalPolicy({ autoAllowTools: [...value] }),
      bashDenyPatterns: (value) => sessionsForSettings.setApprovalPolicy({ bashDenyPatterns: [...value] }),
      fullDelegation: (value) => sessionsForSettings.setApprovalPolicy({ fullDelegation: value }),
      sshAllowedHosts: (value) => sessionsForSettings.setApprovalPolicy({ sshAllowedHosts: [...value] }),
      hiddenFiles: (value) => hiddenFiles.set(value),
      keybindings: (value) => keybindings.set(value),
      bundleMax: (value) => sessionsForSettings.setBundleMax(value)
    },
    // TODO 1060 stage 3: open settings screens (all windows) re-fetch.
    onChanged: () => pusher.settingsChanged()
  })
  sessionsForSettings.setAppSettings(agentSettings)
  // Wave 64 bundle A: export and import of threads and settings (TODO 1088, 8.6). Settings go through the same entry point as the AI's tool
  // (`AgentSettings` checks and the existing setters), so the key owner and the notification to windows are unchanged.
  dataTransfer = registerDataTransferHandlers({
    store: threadStore,
    settings: {
      values: () => Object.fromEntries(agentSettings.list().settings.map((entry) => [entry.name, entry.value])),
      apply: (name, value) => {
        const prepared = agentSettings.prepare(name, value)
        if (!prepared.ok) return 'invalid'
        if (prepared.value.unchanged) return 'unchanged'
        try {
          agentSettings.commit(prepared.value)
          return 'applied'
        } catch {
          return 'invalid'
        }
      }
    },
    dbUserVersion: opened.version,
    appVersion: app.getVersion(),
    home: access.homePath,
    newId: () => randomUUID(),
    afterImport: (threadIds) => sessionsForSettings.threadsImported(threadIds),
    supportsOsSandbox: (backend) => sessionsForSettings.supportsOsSandbox(backend),
    locale: () => locale.locale,
    defaultDir: () => app.getPath('downloads')
  })
  // Wave 99 bundle C: automatic backup and the restore from it (TODO 1306, 8.7). Not in a verification launch (non-default userData).
  const transferForBackup = dataTransfer
  backups = registerBackupHandlers({
    userDataDir,
    unsupportedReason: backupUnsupportedReason({ defaultUserData: userDataLabel === null, env: process.env, storageReason: opened.storageReason }),
    storageReason: opened.storageReason,
    transfer: transferForBackup,
    settings,
    isIdle: () => sessionsForSettings.activityBlocker() === null,
    systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    quickCheck: () => index.quickCheck(),
    getTargets: () => windows.list().map((window) => window.webContents),
    locale: () => locale.locale,
    assertDirAllowed: (path) => {
      access.assertAllowed(pathToUri(path), true)
    },
    settleForRestart: settleDraftsForRestart,
    relaunch: () => {
      app.relaunch()
      app.quit()
    }
  })
  // Wave 14 bundle M: voice input (item 226, 4.5.10). The helper is an artifact of `npm run build:speech`, and
  // if it is missing, pressing only returns `voice-helper-missing` (launch is not stopped).
  // Wave 29 bundle D (TODO 626): the recognition language is a setting separate from the display language. The default `auto` is resolved from the first of macOS's preferred languages
  // (`app.getPreferredSystemLanguages()`, the first is the highest priority).
  // TODO 934: on quit, kill the running child and delete the recording WAV (`voice.dispose`), and at launch clean up what was left from last time.
  voiceTranscriber = new VoiceTranscriber({
    helperPath: swiftHelperPath(app.getAppPath(), 'speech-helper'),
    speechLocale: () => resolveVoiceSpeechLocale(voiceLocale.get(), app.getPreferredSystemLanguages())
  })
  void voiceTranscriber.sweepStale()
  registerVoiceHandler(voiceTranscriber, voiceLocale, () => pusher.settingsChanged())
  registerGmailDraftFontHandlers(gmailDraftFont, () => pusher.settingsChanged())
  // Wave 17 bundle F: attach an image from the clipboard (item 319, 4.5).
  registerPasteImageHandler(settings)
  // Wave 21 bundle A: the web view of ViewerPane (TODO 400, 5.2.1). A WebContentsView per window and a dedicated session.
  // Wave 26 bundle A: tabs, history and Favorites (TODO 522). The writer is only main, and it is stopped in `before-quit` before the DB is closed.
  // Launch is not stopped even when the table is missing (a DB where a migration was skipped): only history and Favorites are absent, and tabs and pages work.
  let webData: WebDataStore | null = null
  try {
    webData = new WebDataStore(opened.db)
  } catch (err) {
    log.warn('web.data.unavailable', errorFields(err))
  }
  webViews = registerWebViewHandlers(APP_INTERNAL_NAME, {
    data: webData,
    settings,
    defaultUserData: userDataLabel === null,
    // TODO 1221: the wording of the full-screen bubble.
    locale: () => localeController?.locale ?? localeFromTag(app.getLocale())
  })
  // Wave 27 bundle B: rewriting Slack links (TODO 553) and the certificate exception for internal https (TODO 547).
  // TODO 697: when deleting only one site, the history's URLs are also used as the target for clearing storage (read-only, main's DB).
  const webDataForExtras = webData
  webExtras = registerWebExtras(settings, {
    historyUrls: () => (webDataForExtras === null ? [] : webDataForExtras.listHistory().map((entry) => entry.url))
  })

  // Wave 18 bundle A: scheduled runs (TODO 323, 6.2.4). **Only the real instance runs on schedule**:
  // the second instance has already quit above (SingletonLock), and a proxy-verification copy (`--user-data-dir` = a copy of the real
  // DB, `AIOS_DISABLE_AGENT`) does not tick, so that the copied jobs are not run twice (item 186).
  // Only when you want to check the scheduled behavior on a copy, make it tick with `AIOS_SCHEDULE=1`. "Run now" also works on a copy.
  const scheduleAutoRun =
    !agentDisabled && (userDataLabel === null || process.env['AIOS_SCHEDULE'] === '1')
  if (!scheduleAutoRun) log.warn('schedule.autoRun.off', { copy: userDataLabel !== null, agentDisabled })
  const manager = sessions
  const scheduler = new JobScheduler(
    new ScheduledJobStore(opened.db),
    {
      run: (job) =>
        manager.runScheduledJob({
          jobId: job.id,
          name: job.name,
          prompt: job.action.prompt,
          cwd: job.action.cwd,
          modelId: job.action.modelId,
          thinking: job.action.thinking,
          approvalStrict: job.action.approvalStrict,
          // TODO 972: the role (Teammate) the job starts its conversation under (the manager falls back to the job's values if it is gone).
          ...(job.action.roleId === undefined ? {} : { roleId: job.action.roleId })
        }),
      // TODO 628: do not start a new thread; send to the existing thread through the same entry point as a normal send (item 94's reservation).
      resume: async (threadId, prompt) => {
        // Fix V: a resume that is not a human action (`auto`). A trigger's conversation stays read-only until a human speaks.
        await manager.send(threadId, { text: prompt }, 'auto')
      },
      // TODO 989: "send later". Attachments are re-read when sent (`file:` is re-checked, a pasted image is the base64 already held).
      sendLater: async (threadId, text, laterAttachments, settings) => {
        const attachments = await resolveLaterAttachments(manager, threadId, laterAttachments)
        // Same as a normal send (the renderer's `threadStore.send`): also attach the per-message model / thinking and the reduced version.
        // Fix V: it is a message a human wrote, so lift the read-only state of a trigger's conversation. TODO 1289: but it goes out
        // at a set time, so the turn counts as unattended (`later`).
        await manager.send(threadId, { text, attachments, ...settings }, 'later')
      },
      isThreadInterrupted: (threadId) => manager.isThreadInterrupted(threadId),
      isThreadBusy: (threadId) => manager.isThreadBusy(threadId),
      hasRoom: () => manager.hasSessionRoom()
    },
    {
      autoRun: scheduleAutoRun,
      // TODO 952 stage 1: call a plugin's scheduled tasks in plugin-host. Tasks that "repeat while idle" run only while no conversation is running
      // (the same `activityBlocker()` as 774's CLI auto-update).
      pluginTasks: pluginTaskInvoker,
      isIdle: () => manager.activityBlocker() === null,
      // TODO 1265: reminders only show a notification (no session, so `activityBlocker` and the CLI auto-update never see them).
      reminders: reminderNotifier,
      // TODO 983 stage 2: when a job is deleted, also delete what was allowed for it (the role's permission rows).
      onJobRemoved: (jobId) => manager.forgetJobGrants(jobId),
      onChanged: () => {
        if (closingDown) return
        // TODO 1270: the job list may have changed; re-decide whether to keep the computer awake.
        osSettingsHandle?.reevaluateSleep()
        // TODO 1305: the menu bar lists the next runs.
        syncMenuBarTray()
        pushScheduleOverview(
          scheduler.overview(),
          windows.list().map((window) => window.webContents)
        )
      }
    }
  )
  jobScheduler = scheduler
  syncMenuBarTray()
  // TODO 1265 (7.6.9): the gateway's reminder tools register notification-only one-shots through this gate (the kind is fixed in the store).
  manager.setAiReminders(
    new AiReminderGate({
      create: (name, atLocal, threadId) => scheduler.createAiReminder(name, atLocal, threadId),
      pending: () =>
        scheduler.aiReminders().map((job) => ({
          id: job.id,
          name: job.name,
          threadId: job.action.origin?.threadId ?? '',
          atLocal: job.spec.kind === 'once' ? job.spec.at : ''
        })),
      remove: (id) => void scheduler.remove(id)
    })
  )
  // TODO 1251: at launch, sweep the permission rows of deleted jobs that remained because the DB deletion failed (it needs the job table, so here).
  manager.sweepOrphanJobGrants((jobId) => scheduler.hasJob(jobId))
  // Wave 20 bundle B (TODO 372): align the list with the scheduled tasks plugins declared (`scheduledTasks`). All
  // installed plugins (rows of merely disabled plugins are kept). Added rows are disabled (only declarations with `idle: true` are enabled, TODO 952 stage 1).
  // When the time comes, `pluginTaskInvoker` wakes plugin-host and calls `tasks.<id>` (TODO 952 stage 1).
  scheduler.syncPluginTasks(
    pluginHost.summaries().map((summary) => ({
      pluginId: summary.id,
      tasks: pluginHost.manifestOf(summary.id)?.scheduledTasks ?? []
    }))
  )
  // TODO 972: roles (Teammates). Deleting one detaches its conversations (they stay, without a role).
  const sessionsForRoles = sessions
  registerRoleHandlers({
    store: roleStore,
    assertDirectory: (uri) => {
      access.assertAllowed(uri, true)
    },
    onRemoved: (roleId) => sessionsForRoles.forgetRole(roleId),
    moveThread: (threadId, roleId) => sessionsForRoles.moveThreadToRole(threadId, roleId),
    targets: () => windows.list().map((window) => window.webContents),
    // TODO 982 / 1292 item 2: drills (the manager re-checks every id).
    drills: {
      start: (roleId, jobId) => sessionsForRoles.startDrill(roleId, jobId),
      report: (threadId) => sessionsForRoles.drillReport(threadId),
      grant: (threadId, opIds) => sessionsForRoles.grantDrillOps(threadId, opIds)
    }
  })
  registerScheduleHandlers(
    scheduler,
    (uri) => {
      access.assertAllowed(uri, true)
    },
    // TODO 1280: the same condition as the sidebar list itself (`sidebarTitleOf`): an enabled bundled plugin that declares a `sidebarView`.
    (id) => pluginHost.manifestOf(id)?.sidebarView !== undefined && pluginHost.isBundled(id) && pluginHost.summaries().some((entry) => entry.id === id && entry.enabled)
  )

  // TODO 1227 (fix X): the candidate tools for a trigger's rule and the fingerprint of their declaration (if the identity cannot be read, no fingerprint = cannot be allowed).
  const toolsWithFingerprints = (manifest: PluginManifest | null, identity: string | null) =>
    manifest === null
      ? []
      : (manifest.mcp?.tools ?? []).map((tool) => ({
          ...tool,
          ...(identity === null ? {} : { fingerprint: pluginToolFingerprint(manifest, tool, identity) })
        }))
  // TODO 1216 (wave 84 bundle A, 6.2.6): triggers. One unattended conversation per event an extension signals with `api.triggers.emit`.
  // The instances allowed to run them are the same as for scheduled runs (`scheduleAutoRun`; not accepted on a proxy-verification copy or with AIOS_DISABLE_AGENT).
  let triggerOwnersReady = false
  const triggers = new TriggerService(
    triggerStore,
    {
      entries: () =>
        pluginHost.summaries().flatMap((summary) => {
          const manifest = pluginHost.manifestOf(summary.id)
          const declared = manifest?.triggers ?? []
          return declared.length === 0
            ? []
            : [
                {
                  pluginId: summary.id,
                  pluginName: summary.displayName,
                  enabled: summary.enabled,
                  triggers: declared,
                  // TODO 1227: whether it is bundled comes from where it was loaded (`isBundled`); tools come from the manifest's declaration and the fingerprint (fix X).
                  bundled: pluginHost.isBundled(summary.id),
                  // Fix X (security review): an identity an extension cannot forge (for bundled, the location; for external, a hash of the contents). Rules are tied to it.
                  identity: pluginHost.identityOf(summary.id),
                  tools: toolsWithFingerprints(manifest, pluginHost.identityOf(summary.id))
                }
              ]
        })
    },
    {
      run: (launch) => manager.runTriggered(launch),
      isUnattended: (threadId) => manager.isUnattendedTurn(threadId),
      hasRoom: () => manager.hasSessionRoom()
    },
    {
      autoRun: scheduleAutoRun,
      cwdAllowed: (path) => {
        try {
          access.assertAllowed(pathToUri(path), true)
          return true
        } catch {
          return false
        }
      },
      ownersReady: () => triggerOwnersReady,
      onChanged: () => {
        if (closingDown) return
        pushTriggerOverview(
          triggers.overview(),
          windows.list().map((window) => window.webContents)
        )
      }
    }
  )
  triggerService = triggers
  // TODO 1227 fix X: after finishing computing the identity of external extensions (a hash of the whole directory, asynchronous), do the launch-time reconciliation (is it the same extension as when
  // the rule was written). Until then no events are accepted (`unavailable`; the extension carries them over). Launch itself does not wait.
  void pluginHost.identitiesReady().then(() => {
    triggerOwnersReady = true
    if (!closingDown) triggers.start()
  })
  registerTriggerHandlers(triggers, (uri) => {
    access.assertAllowed(uri, true)
  })

  // Menus come before windows. The Cmd+N entry is only here (`open` does not add windows).
  // The wording is looked up by display language and rebuilt when the language changes (onChanged of `LocaleController` above).
  menus = installMenus({
    openWindow: () => {
      openWindow()
    },
    // Cmd+B (T27, 5.5.1), mode switching and settings (item 195). **The destination is only the one focused window**:
    // the sidebar of the window being viewed should move, so it is not put on the all-window `pusher`. When nothing has focus
    // (via the Dock menu, etc.) it is sent to the most recently opened window.
    sendCommand: (command) => {
      const target = BrowserWindow.getFocusedWindow() ?? windows.list().at(-1)
      if (target === undefined) return
      // TODO 588 (code-review fix): right after sending, return the window's native focus to the renderer
      // (`dispatchMenuCommand`; prevents typed characters going astray while focus stays on a Web page).
      dispatchMenuCommand(target, command)
    },
    // "Show Hidden Files" (Cmd+Shift+., TODO 261). It is one for the whole app, so main switches it directly.
    hiddenFiles: {
      shown: () => hiddenFiles.get(),
      toggle: () => {
        hiddenFiles.set(!hiddenFiles.get())
      }
    },
    // Shortcut assignments (TODO 549). Looked up every time the menu is built.
    keybindings: () => keybindings.get(),
    // "Reload" / "Force Reload" (TODO 636). Settle the viewer's unsaved drafts, then reload.
    reloadWindow: (window, kind) => reloadWindow(window, kind),
    // "Full Screen" (Ctrl+Cmd+F, TODO 1221). If a Web page is in front, only the Web contents; otherwise the window goes full screen as before.
    toggleFullScreen: (window) => {
      if (webViews?.toggleFullscreen(window) === true) return
      window.setFullScreen(!window.isFullScreen())
    },
    // "Help > Report a Problem" (TODO 1308).
    reportProblem: () => void reportProblem()
  }, locale.locale)

  // Create windows **after resolving the theme** (backgroundColor is needed).
  // **Do not wait for the index process to be ready** (3.3). The window comes first, and the status bar shows
  // `IndexStatus.state = 'starting'`. Calls such as `fsList` that arrive before it is ready are
  // made to wait by IndexClient. Restore all windows that were open at the previous quit (item 36).
  restoreWindows((threadId) => threadStore.getThread(threadId) !== null)
  await sessions.start()
  // TODO 1306: the backup schedule, the import of a confirmed restore, and the light check of the DB once the index process is up.
  const backupService = backups
  backupService.start()
  if (pendingRestore !== null) void backupService.importPending(pendingRestore)
  // At most once a day and not right after startup (at once only after an unfinished / damaged check or an unopenable DB). 8.7.
  if (opened.mode === 'encrypted') {
    void index
      .whenReady()
      .then(() => (closingDown ? undefined : backupService.startHealthCheck()))
      .catch(() => undefined)
  }
  // Runs that passed while stopped are caught up once here (anacron style). From then on, check every 30 seconds.
  scheduler.start()
  // TODO 1270: the scheduler is wired now; decide the keep-awake right away instead of waiting for the 60-second timer (never while closing down).
  if (!closingDown) osSettingsHandle?.reevaluateSleep()
  // After waking from sleep, check without waiting for the tick (same expression; however many were missed, once).
  powerMonitor.on('shutdown', () => {
    systemShuttingDown = true
  })
  // TODO 1120: `wake()` does not decide when `autoRun` is false (a copied instance) (same as `start()`).
  powerMonitor.on('resume', () => {
    if (!closingDown) scheduler.wake()
  })
  // Flush here what was dropped on the Dock before launch (item 98 (c)). One window was opened above,
  // and it is the destination (no windows are added).
  fsAccess = access
  openFileBatcher.markReady()
  // An `aios://` that arrived before launch is flushed here too (TODO 976 stage 3).
  appUrlInbox.markReady()

  // Start the index process and begin scanning. Only here does the index's SQL first run,
  // and it runs inside the other process; main's JS thread does not touch it.
  // **Do not wait, and do not stop on failure** (TODO 854): the index is an additional feature, and conversations, approvals and viewers
  // work even if it does not start. A timeout or a crash right after launch is put on the restart path by IndexClient, and the state is shown in `indexStatus`
  // (`starting` / `error`). The scan's `start` is sent once by IndexClient to the child that became ready
  // (so it does not duplicate the restart sequence). Previously a throw here failed the whole `bootstrap` and called `app.quit()`.
  void index.start().then((ready) => {
    if (!ready && !closingDown) log.warn('index.start.deferred', {})
  })
  void index.startScanning()

  // Material for the pace stages of periodic scanning and index building (6.2.2 / TODO 434). The index process has no
  // `powerMonitor`, so main sends it. Heat (`getCurrentThermalState`, macOS only) and Low Power Mode (`pmset -g`,
  // which Electron has no API for) are also included: when either is set, the index process stops building and scanning and waits.
  const lowPowerMode = new LowPowerModeReader()
  powerTimer = setInterval(() => {
    indexClient?.reportPower(
      collectPower(
        {
          idleSeconds: () => powerMonitor.getSystemIdleTime(),
          onBattery: () => powerMonitor.onBatteryPower,
          thermalState: currentThermalState
        },
        lowPowerMode
      )
    )
  }, POWER_REPORT_MS)

  // The index **starts automatically in the background at launch** (user decision, 12.7). It can be stopped at any time,
  // and resumed from where it stopped (`documents.index_state`).
  indexStartTimer = setTimeout(() => {
    indexStartTimer = null
    // Do not start anything after shutdown has begun (12.9). The ingestion of transcripts is thousands of items, so it
    // easily overlaps with shutdown, and if left alone it would continue sending after `app.quit` and
    // log the warning "the index process is not open" every time.
    if (closingDown) return
    // Ingestion waits for the index process to be ready (TODO 854). Even if the first child does not start, it is sent when the restarted child
    // becomes ready. If the restart limit is exceeded or shutdown has begun, it rejects and nothing is done.
    void index
      .whenReady()
      .then(() => {
        if (!closingDown) startIngestion()
      })
      .catch((err: unknown) => {
        if (closingDown) return
        log.warn('index.start.failed', errorFields(err))
      })
  }, INDEX_START_DELAY_MS)

  function startIngestion(): void {
    // Conversations and transcripts are few in number, so they go in first. File bodies follow the scan's progress.
    // For conversations, send **only what is after the high-water mark** (item 76). Re-sending everything is a safeguard every 7 days.
    const backfillStarted = Date.now()
    void runConversationBackfill({
      events: (sinceRowid, limit) => threadStore.indexableEvents({ sinceRowid, limit }),
      maxRowid: () => threadStore.eventRowidCeiling(),
      send: (events) => index.backfillConversationEvents(events),
      settings,
      isClosing: () => closingDown
    })
      .then((result) => {
        log.info('index.conversation.backfill', {
          reason: result.plan.reason,
          sinceRowid: result.plan.sinceRowid,
          sent: result.sent,
          complete: result.complete,
          ms: Date.now() - backfillStarted
        })
      })
      .catch((err: unknown) => {
        if (closingDown) return
        log.warn('index.conversation.backfill.failed', errorFields(err))
      })
    // TODO 863: re-pick the "delete thread" notifications lost at quit. Drop the conversation documents of threads that are not alive.
    void index
      .sweepGoneConversationThreads(() => (closingDown ? null : threadStore.liveThreadIds()))
      .catch((err: unknown) => {
        if (closingDown) return
        log.warn('index.conversation.sweep.failed', errorFields(err))
      })
    void index
      .indexTranscripts()
      // If shutdown began during ingestion, stop there (12.9).
      .then(() => (closingDown ? undefined : index.resume()))
      .catch((err: unknown) => {
        if (closingDown) return
        log.warn('index.start.failed', errorFields(err))
      })
  }
}

if (isPrimaryInstance) {
  app.whenReady().then(bootstrap).catch((err) => {
    log.error('app.bootstrap.failed', errorFields(err))
    app.quit()
  })
}

/**
 * The window to bring to the front (shared by `activate` and a Drop on the Dock). Brings the most recently opened window to the front,
 * and opens one if there is none (only Cmd+N and `second-instance` add windows).
 */
function frontWindow(): BrowserWindow {
  const front = windows.list().at(-1)
  if (front === undefined) return openWindow()
  if (front.isMinimized()) front.restore()
  front.focus()
  return front
}

/**
 * Create a thread from items dropped on the Dock and have the front window open it (item 98 (c)). The decision is the same `createThreadFromDrop`
 * as the IPC Drop. The reason it could not be created is also handed to the window to show (a reason code).
 */
async function createFromDockDrop(paths: readonly string[]): Promise<void> {
  const manager = sessions
  const access = fsAccess
  if (closingDown || manager === null || access === null) return
  let request: OpenRequest
  try {
    const thread = await createThreadFromDrop(paths.map(pathToUri), {}, {
      assertAllowed: (uri, asDirectory) => access.assertAllowed(uri, asDirectory),
      kindOf: kindOfPath,
      create: (input) => manager.createThread(input)
    })
    request = { threadId: thread.id, created: true }
  } catch (err) {
    log.warn('drop.dock.rejected', { count: paths.length, ...errorFields(err) })
    request = { reason: (err as Error).message }
  }
  if (closingDown) return
  // Hand it over, then signal. A freshly opened window comes to fetch it by itself after subscribing.
  deliverOpenRequest(frontWindow(), request)
}

/**
 * Open `aios://new?…` (TODO 976 stage 3, ARCHITECTURE 3.3). Bring aios to the front (open one window if there is none), create a new conversation, and have it put
 * the body and attachments in the Composer (**it does not send**). An unknown host or a malformed URL does nothing (log only).
 */
async function handleAppUrl(raw: string, onCreated?: (threadId: string) => void, dictate = false): Promise<void> {
  const manager = sessions
  const access = fsAccess
  if (closingDown || manager === null || access === null) return
  const parsed = parseAppUrl(raw)
  if (!parsed.ok) {
    log.info('app-url.ignored', { reason: parsed.reason, length: raw.length })
    return
  }
  const request = await openFromAppUrl(parsed.request, {
    assertAllowed: (uri, asDirectory) => access.assertAllowed(uri, asDirectory),
    kindOf: kindOfPath,
    // TODO 1118: for a first-time folder (there is a notice), defer the working-folder history until the first send.
    create: (input, options) => manager.createThread(input, null, { deferCwdHistory: options.deferCwdHistory }),
    folderNotice: (cwdUri) => manager.folderNotice(cwdUri)
  })
  if (closingDown) return
  if ('threadId' in request) onCreated?.(request.threadId)
  // `open-url` arrives after the OS has brought the app to the front, but `second-instance` (Windows / Linux) does not, so bring the window to the front.
  deliverOpenRequest(frontWindow(), dictate && 'threadId' in request ? { ...request, dictate: true } : request)
}

/** Apply the current assignment of `app.summon` (default Ctrl+Opt+Space, null if cleared) to the hotkey. */
function applySummonHotkey(overrides: KeybindingOverrides): void {
  const platform = keyPlatformOfProcess(hostPlatform())
  // TODO 1267: the dictation hotkey has no default, so it registers nothing until the user assigns a key.
  // Both are released before either registers, so a key can move between them (review Y); on a duplicate, `app.summon` wins.
  applyHotkeys([
    { hotkey: globalHotkey, accelerator: effectiveKeybinding('app.summon', platform, overrides) },
    { hotkey: dictateHotkey, accelerator: effectiveKeybinding('app.summonDictate', platform, overrides) }
  ])
}

/**
 * The hotkey was pressed (TODO 976 part 1). Another app is in front, so bring aios forward with `app.focus({ steal: true })`,
 * and, as with `aios://new`, create a new conversation with no affiliation and focus the Composer (the body is empty, nothing is sent).
 */
function summonFromHotkey(dictate: boolean): void {
  if (closingDown) return
  if (isMac()) app.focus({ steal: true })
  // TODO 976 review Y-3: if the conversation created last time by this is still empty (nothing sent and not deleted), just open it and
  // focus the Composer (so empty conversations do not pile up with every press). Create one only when there is none.
  if (summonedThreadId !== null && sessions?.isUnsentThread(summonedThreadId) === true) {
    deliverOpenRequest(frontWindow(), dictate ? { threadId: summonedThreadId, dictate: true } : { threadId: summonedThreadId })
    return
  }
  summonedThreadId = null
  void handleAppUrl('aios://new', (threadId) => {
    summonedThreadId = threadId
  }, dictate)
}

app.on('activate', () => {
  // When called back from the Dock / `open -a`. If there is no window, create one;
  // if there is, only bring it to the front (only Cmd+N and `second-instance` add windows).
  if (closingDown) return
  frontWindow()
})

app.on('window-all-closed', () => {
  // On macOS the app stays even if all windows are closed (the default behavior). **Closing just the last window
  // does not close the DB**: scanning and the index continue, and `activate` brings back only a window (T21).
  if (!isMac()) app.quit()
})

let quitting = false
// TODO 1308: a GPU / utility / other child went away. Only the reason is logged.
app.on('child-process-gone', (_event, details) => logChildProcessGone(details))
app.on('before-quit', (event) => {
  if (quitting) return
  // TODO 636 (code-review fix): if any window is in the middle of settling drafts for a reload, do not ask anew here;
  // remember only the request and defer it until after the settling (`reloadOrDefer` of `reloadWindow` looks at it).
  const reloadingWindows = windows.list().filter((window) => reloadSettling.has(window))
  if (reloadingWindows.length > 0) {
    event.preventDefault()
    // TODO 1125 review fix: remember it only for the windows that are settling right now (not dropped by another window's cancel).
    reloadPending.requestQuit(reloadingWindows)
    return
  }
  // TODO 1004 (review): do nothing for a Cmd+Q while a window's close-settling "save?" is showing (neither the confirmation nor a second sheet is
  // stacked). Checked before the confirmation.
  if (windows.list().some((window) => closeSettling.has(window))) {
    event.preventDefault()
    return
  }
  // TODO 1004: if a conversation is running, ask once here (once done, `app.quit()` re-enters and passes through).
  // Before the draft settling: if the user backs out, dialogs are not stacked. A relaunch or an update restart has already been confirmed, so it does not ask.
  if (quitConfirm.check() === 'hold') {
    event.preventDefault()
    return
  }
  // TODO 606: if any window has unsaved viewer drafts, settle them first (write out if autosave is ON, ask if OFF).
  // A dialog waits for the user, so it is outside the 30-second limit (`shutdownWithin`); steps that can be abandoned go before shutdown starts.
  // Once done, `app.quit()` re-enters and passes through because of `quitApproved`.
  if (!quitApproved && draftsCloser?.needsSettle(windows.list()) === true) {
    event.preventDefault()
    // Do not stack a Cmd+Q while one window's "save?" is showing (no second dialog on the same window).
    if (quitSettling !== null || windows.list().some((window) => closeSettling.has(window))) return
    void settleDraftsForQuit().then((ok) => {
      if (ok) app.quit()
      else quitConfirm.reset()
    })
    return
  }
  quitApproved = true
  // Clean up the session processes and the gateway socket, then finish.
  // Without stopping them here, the CLI's child processes become orphans.
  quitting = true
  event.preventDefault()
  // Each step is caught individually, so whichever throws, the rest are not skipped, and `app.quit()` is always
  // reached at the end. The overall limit is 30 seconds, after which `app.exit(1)` (TODO 566, `shutdown.ts`).
  void shutdownWithin(
    [
      // Write the positions of the open windows and the displayed threads (item 36) **before the DB is closed**.
      // If not written here, it is missed: the `close` of the windows that app.quit() closes comes after the shutdown processing.
      // After this `closingDown` is set, so the `close` handler does not write (12.9).
      { name: 'persistSession', run: () => persistSession() },
      // Finish writing the web tab memory (TODO 522); after that nothing is written (including for the windows `app.quit()` closes).
      { name: 'pluginSurfaces.dispose', run: () => pluginSurfacesRef?.dispose() },
      { name: 'webViews.shutdown', run: () => webViews?.shutdown() },
      { name: 'webExtras.shutdown', run: () => webExtras?.shutdown() },
      {
        name: 'closingDown',
        run: () => {
          closingDown = true
          openFileBatcher.dispose()
          appUrlInbox.dispose()
          if (hotkeyRetryTimer !== null) clearInterval(hotkeyRetryTimer)
          globalHotkey?.dispose()
          dictateHotkey?.dispose()
          // TODO 1269: remove the menu bar icon (nothing may be pushed to it afterwards).
          menuBarTray?.dispose()
          // TODO 1270: always release the sleep blocker on quit.
          osSettingsHandle?.dispose()
        }
      },
      {
        name: 'timers',
        run: () => {
          if (powerTimer !== null) clearInterval(powerTimer)
          powerTimer = null
          if (indexStartTimer !== null) clearTimeout(indexStartTimer)
          indexStartTimer = null
        }
      },
      // After this `git` is not called (12.9). Running child processes are also stopped.
      { name: 'gitStatus.dispose', run: () => gitStatus?.dispose() },
      // The git of "recent files" (TODO 999) is likewise not called afterwards.
      { name: 'recentFiles.dispose', run: () => recentFilesRegistration?.dispose() },
      // Kill the voice transcription child and delete the temporary directory of the recording WAVs (TODO 934).
      { name: 'voice.dispose', run: () => voiceTranscriber?.dispose() },
      // Stop scheduled runs before SessionManager: from then on do not tick, and wait until a run that is about to start
      // (thread creation and send) has finished writing its result (12.9).
      // TODO 1116: before that, set only SessionManager's "about to stop" flag. A run that fired during a CLI update
      // is waiting for the update to end in `waitBackendUpdate`, and without the flag `jobScheduler.stop` would not return and, at the 30-second limit,
      // would fall to `app.exit(1)`. With the flag set it leaves the wait and throws, and the run writes `failed` while the DB is still open.
      { name: 'sessions.beginStop', run: () => sessions?.beginStop() },
      // TODO 1117: stop export / import (import deletes the half-written thread and exits). So that the notification of threads that were finished being added
      // (`afterImport` -> SessionManager) arrives, before `sessions.stop`, while the DB is open.
      // TODO 1306: the automatic backup first (it waits for its running export / the import of a restore, which leave at a boundary).
      { name: 'backups.stop', run: () => backups?.stop() },
      { name: 'dataTransfer.stop', run: () => dataTransfer?.stop() },
      { name: 'jobScheduler.stop', run: () => jobScheduler?.stop() },
      // TODO 1216: triggers also before SessionManager (from then on they are not accepted, and the one that is about to start is waited for).
      { name: 'triggers.stop', run: () => triggerService?.stop() },
      { name: 'agentUpdates.stop', run: () => agentUpdates?.stop() },
      { name: 'sessions.stop', run: () => sessions?.stop() },
      { name: 'plugins.stop', run: () => plugins?.stop() },
      // Wait until the index process stops scanning / building, drains the queue, and **closes its own DB**
      // (3.6 / 12.9). Main closes the DB after this.
      { name: 'indexClient.stop', run: () => indexClient?.stop() },
      { name: 'gateway.stop', run: () => gateway?.stop() },
      // Finish writing the accumulated audit log and stop the batching before closing (chapter 8).
      // With flush() alone, the next single entry would re-arm the 16 ms timer, and it would fire after the close.
      { name: 'audit.dispose', run: () => audit?.dispose() },
      { name: 'db.close', run: () => db?.close() },
      // If a version was installed, switch the symlink of ~/Applications/aios.app (TODO 103). The new version from the next launch.
      // It does not touch the DB. Placed after all child processes were stopped (after nothing is started from the running .app).
      { name: 'update.applyAtQuit', run: () => updates?.applyAtQuit() },
      { name: 'log', run: () => log.info('app.quit', {}) },
      // Finish writing the log file (TODO 376). Later lines (index process lines that arrive late from the pipe) are written synchronously.
      { name: 'closeLogFile', run: () => closeLogFile() }
    ],
    {
      quit: () => app.quit(),
      // Past the limit: finish writing the log (without waiting too long) and then exit. The DB is not closed, but the WAL is recovered at the next launch.
      onTimeout: () => {
        void Promise.race([closeLogFile(), new Promise((resolve) => setTimeout(resolve, 1_000))]).finally(() =>
          app.exit(1)
        )
      }
    }
  )
})

// Handler for main's uncaught exceptions and rejections (TODO 566). Electron's default is to show a dialog (exception) or
// leave nothing (reject). Leave one line in the log file (TODO 376) and keep running: a single miss
// should not bring down an app in use (the index process ends itself, but main holds the windows and the CLI).
process.on('uncaughtException', (err: unknown) => {
  log.error('main.uncaught', errorFields(err))
})
process.on('unhandledRejection', (reason: unknown) => {
  log.error('main.unhandled-rejection', errorFields(reason))
})
