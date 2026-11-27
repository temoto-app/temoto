/**
 * The preload. The only passage between main <-> renderer (IMPLEMENTATION_BRIEF chapter 7).
 *
 * It runs under `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`, and
 * what it hands the renderer is only the functions defined in `AiosApi` of `shared/ipc.ts`.
 * It does not hand over `ipcRenderer` itself (that would let anyone hit an arbitrary channel).
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  IpcChannel,
  IpcEvent,
  type AiosApi,
  type MenuCommand,
  type Unsubscribe
} from '@shared/ipc.js'
import type { AgentStatus, AiosEventBatch, McpGlobalReport } from '@shared/agent.js'
import type { ApprovalItem, DeletedThreadSummary, ThreadSummary, ViewerCommand } from '@shared/thread.js'
import type { FileChangeBatch, ScanStatus } from '@shared/types.js'
import type { IndexStatus } from '@shared/search.js'
import type { PluginSummary } from '@shared/plugin.js'
import type { PluginSurfacesSnapshot } from '@shared/plugin-surfaces.js'
import type { ThemeState } from '@shared/theme.js'
import type { LocaleState } from '@shared/locale.js'
import type { UsageSnapshot } from '@shared/usage.js'
import type { LoginRecoveryState } from '@shared/login-recovery.js'
import type { ConnectionStatus } from '@shared/connection.js'
import type { ScheduleOverview } from '@shared/schedule.js'
import type { Role } from '@shared/role.js'
import type { TriggerOverview } from '@shared/trigger.js'
import type { WebViewEvent } from '@shared/web-view.js'
import type { WebDataChange, WebTabsState } from '@shared/web-tabs.js'
import type { KeybindingOverrides } from '@shared/keybindings.js'
import type { AutoSaveSettings } from '@shared/auto-save.js'
import type { FileSortOrder } from '@shared/file-sort.js'
import type { ViewerDraftsRequest } from '@shared/viewer-drafts-close.js'
import type { CarriedDraftsRequest, UpdateStatus } from '@shared/update.js'
import type { AgentUpdateStatus } from '@shared/agent-update.js'
import type { BackupStatus } from '@shared/backup.js'

/**
 * Absolute path -> `file://` URI. In a sandbox: true preload `node:url` is unavailable, so it is built
 * with string operations only.
 */
function toFileUri(path: string): string {
  if (path === '') return ''
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: AiosApi = {
  boot: {
    wait: () => ipcRenderer.invoke(IpcChannel.bootWait),
    painted: () => ipcRenderer.send(IpcChannel.bootPainted)
  },
  app: {
    getInfo: () => ipcRenderer.invoke(IpcChannel.appInfo),
    getLogInfo: () => ipcRenderer.invoke(IpcChannel.appLogInfo),
    measureDatabase: () => ipcRenderer.invoke(IpcChannel.appDbBreakdown),
    openExternal: (url) => ipcRenderer.invoke(IpcChannel.appOpenExternal, url),
    openSystemSettings: (kind) => ipcRenderer.invoke(IpcChannel.appOpenSystemSettings, kind),
    relaunch: () => ipcRenderer.invoke(IpcChannel.appRelaunch),
    windowLayout: () => ipcRenderer.invoke(IpcChannel.appWindowLayout),
    setWindowLayout: (layout, viewerShown) => ipcRenderer.send(IpcChannel.appSetWindowLayout, layout, viewerShown),
    onMenuCommand: (listener) => subscribe<MenuCommand>(IpcEvent.menuCommand, listener)
  },
  fs: {
    roots: () => ipcRenderer.invoke(IpcChannel.fsRoots),
    listDirectory: (uri, options) => ipcRenderer.invoke(IpcChannel.fsList, uri, options),
    getShowHidden: () => ipcRenderer.invoke(IpcChannel.fsHiddenGet),
    setShowHidden: (show) => ipcRenderer.invoke(IpcChannel.fsHiddenSet, show),
    onShowHiddenChanged: (listener) => subscribe<boolean>(IpcEvent.hiddenFilesChanged, listener),
    searchFiles: (query, limit, cwdUri, scopeUri) =>
      ipcRenderer.invoke(IpcChannel.fsSearch, query, limit, cwdUri, scopeUri),
    stat: (uri) => ipcRenderer.invoke(IpcChannel.fsStat, uri),
    getScanStatus: () => ipcRenderer.invoke(IpcChannel.fsScanStatus),
    rescan: () => ipcRenderer.invoke(IpcChannel.fsRescan),
    includeProtectedFolders: () => ipcRenderer.invoke(IpcChannel.fsIncludeProtectedFolders),
    volumes: () => ipcRenderer.invoke(IpcChannel.fsVolumes),
    setVolumeAllowed: (uri, allowed) =>
      ipcRenderer.invoke(IpcChannel.fsSetVolumeAllowed, uri, allowed),
    pickDirectory: () => ipcRenderer.invoke(IpcChannel.fsPickDirectory),
    resolveLink: (input) => ipcRenderer.invoke(IpcChannel.fsResolveLink, input),
    createFile: (parentUri, name) => ipcRenderer.invoke(IpcChannel.fsCreateFile, parentUri, name),
    createFolder: (parentUri, name) => ipcRenderer.invoke(IpcChannel.fsCreateFolder, parentUri, name),
    rename: (uri, name) => ipcRenderer.invoke(IpcChannel.fsRename, uri, name),
    appIcon: (uri) => ipcRenderer.invoke(IpcChannel.fsAppIcon, uri),
    startDrag: (uris) => ipcRenderer.send(IpcChannel.fsStartDrag, uris),
    onScanStatus: (listener) => subscribe<ScanStatus>(IpcEvent.scanStatus, listener),
    onFileChanges: (listener) => subscribe<FileChangeBatch>(IpcEvent.fileChanges, listener)
  },
  drop: {
    uriFor: (file) => {
      try {
        return toFileUri(webUtils.getPathForFile(file as File))
      } catch {
        // Where webUtils is unavailable, ignore the Drop (a feature is just missing; nothing breaks).
        return ''
      }
    },
    checkLinks: (uris) => ipcRenderer.invoke(IpcChannel.dropCheckLinks, uris),
    trace: (trace) => ipcRenderer.send(IpcChannel.dropTrace, trace)
  },
  attachments: {
    pick: () => ipcRenderer.invoke(IpcChannel.attachmentsPick)
  },
  recent: {
    list: (options) => ipcRenderer.invoke(IpcChannel.recentList, options),
    thumbnail: (uri) => ipcRenderer.invoke(IpcChannel.recentThumbnail, uri),
    offers: () => ipcRenderer.invoke(IpcChannel.recentOffers),
    getScreenshotOfferEnabled: () => ipcRenderer.invoke(IpcChannel.recentScreenshotOfferEnabledGet),
    setScreenshotOfferEnabled: (enabled) => ipcRenderer.invoke(IpcChannel.recentScreenshotOfferEnabledSet, enabled)
  },
  threads: {
    list: () => ipcRenderer.invoke(IpcChannel.threadList),
    create: (input) => ipcRenderer.invoke(IpcChannel.threadCreate, input),
    open: (threadId) => ipcRenderer.invoke(IpcChannel.threadOpen, threadId),
    reportComposerDrafts: (threadIds) => ipcRenderer.invoke(IpcChannel.threadReportComposerDrafts, threadIds),
    timeline: (threadId) => ipcRenderer.invoke(IpcChannel.threadTimeline, threadId),
    timelineBefore: (threadId, before, limit) =>
      ipcRenderer.invoke(IpcChannel.threadTimelineBefore, threadId, before, limit),
    send: (threadId, input) => ipcRenderer.invoke(IpcChannel.threadSend, threadId, input),
    sendInterrupt: (threadId, input) =>
      ipcRenderer.invoke(IpcChannel.threadSendInterrupt, threadId, input),
    resendLast: (threadId) => ipcRenderer.invoke(IpcChannel.threadResendLast, threadId),
    openInTerminal: (threadId) => ipcRenderer.invoke(IpcChannel.threadOpenInTerminal, threadId),
    cancelReservation: (threadId, reservationId) =>
      ipcRenderer.invoke(IpcChannel.threadCancelReservation, threadId, reservationId),
    takeReservation: (threadId, reservationId) =>
      ipcRenderer.invoke(IpcChannel.threadTakeReservation, threadId, reservationId),
    interrupt: (threadId) => ipcRenderer.invoke(IpcChannel.threadInterrupt, threadId),
    stop: (threadId) => ipcRenderer.invoke(IpcChannel.threadStop, threadId),
    rename: (threadId, title) => ipcRenderer.invoke(IpcChannel.threadRename, threadId, title),
    setUnread: (threadId, unread) => ipcRenderer.invoke(IpcChannel.threadSetUnread, threadId, unread),
    remove: (threadId, options) => ipcRenderer.invoke(IpcChannel.threadDelete, threadId, options),
    setRetention: (threadId, retention, days) =>
      ipcRenderer.invoke(IpcChannel.threadSetRetention, threadId, retention, days),
    setApprovalStrict: (threadId, strict) =>
      ipcRenderer.invoke(IpcChannel.threadSetApprovalStrict, threadId, strict),
    setOsSandbox: (threadId, on) => ipcRenderer.invoke(IpcChannel.threadSetOsSandbox, threadId, on),
    setAutoPickRecommended: (threadId, on) => ipcRenderer.invoke(IpcChannel.threadSetAutoPick, threadId, on),
    setPlanMode: (threadId, on) => ipcRenderer.invoke(IpcChannel.threadSetPlanMode, threadId, on),
    setViewerState: (threadId, uri, highlight) =>
      ipcRenderer.invoke(IpcChannel.threadSetViewerState, threadId, uri, highlight),
    viewerHistory: (threadId) => ipcRenderer.invoke(IpcChannel.threadViewerHistory, threadId),
    workspaceCopyFailed: (threadId, kinds) => ipcRenderer.send(IpcChannel.threadWorkspaceCopyFailed, threadId, kinds),
    setViewerHistory: (threadId, snapshot) =>
      ipcRenderer.invoke(IpcChannel.threadSetViewerHistory, threadId, snapshot),
    rewindPreview: (threadId, eventId) =>
      ipcRenderer.invoke(IpcChannel.threadRewindPreview, threadId, eventId),
    rewind: (threadId, eventId, options) =>
      ipcRenderer.invoke(IpcChannel.threadRewind, threadId, eventId, options),
    handoffEstimate: (threadId) => ipcRenderer.invoke(IpcChannel.threadHandoffEstimate, threadId),
    handoff: (threadId) => ipcRenderer.invoke(IpcChannel.threadHandoff, threadId),
    switchBackend: (threadId, backend, modelId) =>
      ipcRenderer.invoke(IpcChannel.threadSwitchBackend, threadId, backend, modelId),
    contextBreakdown: (threadId) => ipcRenderer.invoke(IpcChannel.threadContextBreakdown, threadId),
    transcriptSessions: () => ipcRenderer.invoke(IpcChannel.threadTranscriptSessions),
    transcriptSession: (uri) => ipcRenderer.invoke(IpcChannel.threadTranscriptSession, uri),
    clearLog: (threadId) => ipcRenderer.invoke(IpcChannel.threadClearLog, threadId),
    clearAllLogs: () => ipcRenderer.invoke(IpcChannel.threadClearAllLogs),
    resolveAttachment: (threadId, uri) =>
      ipcRenderer.invoke(IpcChannel.threadResolveAttachment, threadId, uri),
    attachmentImage: (uri) => ipcRenderer.invoke(IpcChannel.threadAttachmentImage, uri),
    timelineImage: (threadId, src) => ipcRenderer.invoke(IpcChannel.threadTimelineImage, threadId, src),
    exportTurns: (threadId) => ipcRenderer.invoke(IpcChannel.threadExportTurns, threadId),
    savePdf: (threadId, scope, html) => ipcRenderer.invoke(IpcChannel.threadSavePdf, threadId, scope, html),
    saveHtml: (threadId, scope, html) => ipcRenderer.invoke(IpcChannel.threadSaveHtml, threadId, scope, html),
    saveMarkdown: (threadId, scope, markdown) =>
      ipcRenderer.invoke(IpcChannel.threadSaveMarkdown, threadId, scope, markdown),
    allowDir: (threadId, dirUri) =>
      ipcRenderer.invoke(IpcChannel.threadAllowDir, threadId, dirUri),
    toolResult: (threadId, toolUseId) =>
      ipcRenderer.invoke(IpcChannel.threadToolResult, threadId, toolUseId),
    createOptions: () => ipcRenderer.invoke(IpcChannel.threadCreateOptions),
    backends: () => ipcRenderer.invoke(IpcChannel.threadBackends),
    folderNotice: (cwdUri) => ipcRenderer.invoke(IpcChannel.threadFolderNotice, cwdUri),
    folderMatchKey: (cwdUri) => ipcRenderer.invoke(IpcChannel.threadFolderMatchKey, cwdUri),
    createFromDrop: (uris, input) =>
      ipcRenderer.invoke(IpcChannel.threadCreateFromDrop, uris, input ?? {}),
    takeOpenRequest: () => ipcRenderer.invoke(IpcChannel.threadTakeOpenRequest),
    onOpenRequest: (listener) => subscribe<undefined>(IpcEvent.openRequest, () => listener()),
    removeCwdHistory: (uri) => ipcRenderer.invoke(IpcChannel.cwdHistoryRemove, uri),
    clearCwdHistory: () => ipcRenderer.invoke(IpcChannel.cwdHistoryClear),
    onEvents: (listener) => subscribe<AiosEventBatch>(IpcEvent.threadEvents, listener),
    onChanged: (listener) => subscribe<readonly ThreadSummary[]>(IpcEvent.threadsChanged, listener),
    onItemChanged: (listener) => subscribe<ThreadSummary>(IpcEvent.threadChanged, listener),
    listDeleted: () => ipcRenderer.invoke(IpcChannel.threadListDeleted),
    onDeletedChanged: (listener) =>
      subscribe<readonly DeletedThreadSummary[]>(IpcEvent.deletedThreadsChanged, listener),
    restore: (threadId) => ipcRenderer.invoke(IpcChannel.threadRestore, threadId),
    locateLink: (threadId, eventId) => ipcRenderer.invoke(IpcChannel.threadLocateLink, threadId, eventId)
  },
  search: {
    query: (query, scope, limit, seq, cwdUri, scopeUri) =>
      ipcRenderer.invoke(IpcChannel.searchQuery, query, scope, limit, seq, cwdUri, scopeUri),
    thread: (query, threadId, seq) => ipcRenderer.invoke(IpcChannel.searchThread, query, threadId, seq),
    buildScope: (uri) => ipcRenderer.invoke(IpcChannel.searchBuildScope, uri),
    getStatus: () => ipcRenderer.invoke(IpcChannel.searchStatus),
    pause: () => ipcRenderer.invoke(IpcChannel.searchPause),
    resume: () => ipcRenderer.invoke(IpcChannel.searchResume),
    onStatus: (listener) => subscribe<IndexStatus>(IpcEvent.indexStatus, listener)
  },
  approvals: {
    list: () => ipcRenderer.invoke(IpcChannel.approvalList),
    decide: (id, decision) => ipcRenderer.invoke(IpcChannel.approvalDecide, id, decision),
    diff: (id) => ipcRenderer.invoke(IpcChannel.approvalDiff, id),
    onChanged: (listener) =>
      subscribe<readonly ApprovalItem[]>(IpcEvent.approvalsChanged, listener),
    rules: () => ipcRenderer.invoke(IpcChannel.approvalRules),
    removeRule: (id) => ipcRenderer.invoke(IpcChannel.approvalRuleRemove, id),
    roleGrants: (roleKey) => ipcRenderer.invoke(IpcChannel.approvalRoleGrants, roleKey),
    removeRoleGrant: (roleKey, id) => ipcRenderer.invoke(IpcChannel.approvalRoleGrantRemove, roleKey, id),
    getPolicy: () => ipcRenderer.invoke(IpcChannel.approvalPolicyGet),
    setPolicy: (patch) => ipcRenderer.invoke(IpcChannel.approvalPolicySet, patch)
  },
  /**
   * The viewer (5.2 / 7.4). **Moved over from direct fs calls in Phase 4.**
   * Reads and writes go through the CapabilityBroker in main and are left in the audit log.
   */
  viewer: {
    open: (uri) => ipcRenderer.invoke(IpcChannel.viewerOpen, uri),
    openPayload: (kind) => ipcRenderer.invoke(IpcChannel.viewerOpenPayload, kind),
    openTransientFile: (name) => ipcRenderer.invoke(IpcChannel.viewerOpenTransientFile, name),
    convertImageForDisplay: (name, data) => ipcRenderer.invoke(IpcChannel.viewerConvertImage, name, data),
    read: (pluginId, uri) => ipcRenderer.invoke(IpcChannel.viewerRead, pluginId, uri),
    write: (pluginId, uri, content, expectedMtimeMs) =>
      ipcRenderer.invoke(IpcChannel.viewerWrite, pluginId, uri, content, expectedMtimeMs),
    command: (pluginId, command, arg) =>
      ipcRenderer.invoke(IpcChannel.viewerCommand, pluginId, command, arg),
    // The gateway's openFile / closeFile and the notice of a draft conflict (item 97). Delivered only when this window is the destination.
    onCommand: (listener) => subscribe<ViewerCommand>(IpcEvent.viewerRemote, listener),
    reportDraft: (uri) => ipcRenderer.invoke(IpcChannel.viewerReportDraft, uri),
    reportStoredDrafts: (count) => ipcRenderer.invoke(IpcChannel.viewerReportStoredDrafts, count),
    // TODO 832 (1): how this window actually handled the gateway's openFile "open" command.
    replyCommand: (replyId, outcome) => ipcRenderer.invoke(IpcChannel.viewerCommandReply, replyId, outcome),
    // TODO 1061 (3): what this window's ViewerPane is currently showing in front (the "shown" state in the gateway's listOpenFiles).
    reportShown: (report) => ipcRenderer.invoke(IpcChannel.viewerReportShown, report),
    // TODO 1338 (review Y): the openDiff that waited for a conversation, pulled once the viewer restore has settled, and its confirmation.
    pendingDiff: (threadId) => ipcRenderer.invoke(IpcChannel.viewerPendingDiff, threadId),
    pendingDiffShown: (threadId, generation) => ipcRenderer.invoke(IpcChannel.viewerPendingDiffShown, threadId, generation),
    // "Line up the drafts / finish writing" before closing the window or quitting (TODO 606). Delivered only when this window is the destination.
    onDraftsRequest: (listener) => subscribe<ViewerDraftsRequest>(IpcEvent.viewerDraftsRequest, listener),
    replyDrafts: (id, reply) => ipcRenderer.invoke(IpcChannel.viewerDraftsReply, id, reply),
    ackDrafts: (id, pending) => ipcRenderer.invoke(IpcChannel.viewerDraftsAck, id, pending),
    close: (pluginId, uri) => ipcRenderer.invoke(IpcChannel.viewerClose, pluginId, uri),
    // TODO 673 (a code-review fix): the ViewerPane closed completely. Stop watching for outside changes.
    untrackWatch: () => ipcRenderer.send(IpcChannel.viewerUntrackWatch),
    // TODO 907: "open with another viewer" and the per-extension viewer defaults.
    choices: (uri) => ipcRenderer.invoke(IpcChannel.viewerChoices, uri),
    choose: (uri, pluginId) => ipcRenderer.invoke(IpcChannel.viewerChoose, uri, pluginId),
    associations: () => ipcRenderer.invoke(IpcChannel.viewerAssociations),
    resetAssociation: (ext) => ipcRenderer.invoke(IpcChannel.viewerAssociationReset, ext)
  },
  plugins: {
    list: () => ipcRenderer.invoke(IpcChannel.pluginList),
    setEnabled: (pluginId, enabled) =>
      ipcRenderer.invoke(IpcChannel.pluginSetEnabled, pluginId, enabled),
    update: (pluginId) => ipcRenderer.invoke(IpcChannel.pluginUpdate, pluginId),
    updateAll: () => ipcRenderer.invoke(IpcChannel.pluginUpdateAll),
    setConsent: (pluginId, capability, granted) =>
      ipcRenderer.invoke(IpcChannel.pluginSetConsent, pluginId, capability, granted),
    uninstall: (pluginId) => ipcRenderer.invoke(IpcChannel.pluginUninstall, pluginId),
    audit: (limit, pluginId) => ipcRenderer.invoke(IpcChannel.pluginAudit, limit, pluginId),
    detail: (pluginId) => ipcRenderer.invoke(IpcChannel.pluginDetail, pluginId),
    surfaces: () => ipcRenderer.invoke(IpcChannel.pluginSurfaces),
    onSurfacesChanged: (listener) => subscribe<PluginSurfacesSnapshot>(IpcEvent.pluginSurfacesChanged, listener),
    search: (pluginId, query) => ipcRenderer.invoke(IpcChannel.pluginSearch, pluginId, query),
    onChanged: (listener) => subscribe<readonly PluginSummary[]>(IpcEvent.pluginsChanged, listener),
    onNotification: (listener) =>
      subscribe<{ pluginId: string; title: string; body: string | null }>(
        IpcEvent.pluginNotification,
        listener
      )
  },
  theme: {
    get: () => ipcRenderer.invoke(IpcChannel.themeGet),
    set: (preference) => ipcRenderer.invoke(IpcChannel.themeSet, preference),
    onChanged: (listener) => subscribe<ThemeState>(IpcEvent.themeChanged, listener)
  },
  locale: {
    get: () => ipcRenderer.invoke(IpcChannel.localeGet),
    set: (preference) => ipcRenderer.invoke(IpcChannel.localeSet, preference),
    onChanged: (listener) => subscribe<LocaleState>(IpcEvent.localeChanged, listener)
  },
  git: {
    status: (cwdUri) => ipcRenderer.invoke(IpcChannel.gitStatus, cwdUri)
  },
  // Help (TODO 1174). Pass only the URI; main reads the bundled HTML and returns it.
  help: {
    open: (uri) => ipcRenderer.invoke(IpcChannel.helpOpen, uri)
  },
  // The change log (TODO 1186). Takes no arguments (main reads the one bundled file).
  osSettings: {
    get: () => ipcRenderer.invoke(IpcChannel.osSettingsGet),
    setOpenAtLogin: (enabled) => ipcRenderer.invoke(IpcChannel.osSettingsSetOpenAtLogin, enabled === true),
    setPreventSleep: (enabled) => ipcRenderer.invoke(IpcChannel.osSettingsSetPreventSleep, enabled === true),
    setMenuBar: (enabled) => ipcRenderer.invoke(IpcChannel.osSettingsSetMenuBar, enabled === true)
  },
  releaseNotes: {
    open: () => ipcRenderer.invoke(IpcChannel.releaseNotesOpen),
    takeAuto: () => ipcRenderer.invoke(IpcChannel.releaseNotesTakeAuto),
    getAuto: () => ipcRenderer.invoke(IpcChannel.releaseNotesAutoGet),
    setAuto: (enabled) => ipcRenderer.invoke(IpcChannel.releaseNotesAutoSet, enabled === true)
  },
  editor: {
    get: () => ipcRenderer.invoke(IpcChannel.editorGet),
    set: (id) => ipcRenderer.invoke(IpcChannel.editorSet, id),
    open: (uri, options) => ipcRenderer.invoke(IpcChannel.editorOpen, uri, options),
    openHandoff: (uri) => ipcRenderer.invoke(IpcChannel.editorOpenHandoff, uri),
    reveal: (uri, asDirectory) =>
      ipcRenderer.invoke(IpcChannel.revealInFolder, uri, asDirectory === true),
    revealLogs: () => ipcRenderer.invoke(IpcChannel.revealLogs),
    reportProblem: () => ipcRenderer.invoke(IpcChannel.reportProblem),
    openDefaultApp: (uri, pluginId) => ipcRenderer.invoke(IpcChannel.editorOpenDefault, uri, pluginId),
    openInDefaultApp: (uri) => ipcRenderer.invoke(IpcChannel.editorOpenInDefaultApp, uri)
  },
  notifications: {
    getEnabled: () => ipcRenderer.invoke(IpcChannel.notifyGet),
    setEnabled: (enabled) => ipcRenderer.invoke(IpcChannel.notifySet, enabled)
  },
  mcp: {
    report: () => ipcRenderer.invoke(IpcChannel.mcpReport),
    onReport: (listener) => subscribe<McpGlobalReport>(IpcEvent.mcpReportChanged, listener)
  },
  skills: {
    list: (cwdUri) => ipcRenderer.invoke(IpcChannel.skillsList, cwdUri),
    trash: (request) => ipcRenderer.invoke(IpcChannel.skillsTrash, request),
    pluginCatalog: (query) => ipcRenderer.invoke(IpcChannel.skillsPluginCatalog, query),
    pluginInstall: (name) => ipcRenderer.invoke(IpcChannel.skillsPluginInstall, name),
    pluginUninstall: (id) => ipcRenderer.invoke(IpcChannel.skillsPluginUninstall, id)
  },
  agent: {
    status: () => ipcRenderer.invoke(IpcChannel.agentStatus),
    recheck: () => ipcRenderer.invoke(IpcChannel.agentRecheck),
    backends: (force) => ipcRenderer.invoke(IpcChannel.agentBackends, force),
    localAdvice: (backendId, force) => ipcRenderer.invoke(IpcChannel.agentLocalAdvice, backendId, force),
    localAction: (backendId, action, model) => ipcRenderer.invoke(IpcChannel.agentLocalAction, backendId, action, model),
    localActivity: (backendId) => ipcRenderer.invoke(IpcChannel.agentLocalActivity, backendId),
    recheckLogin: () => ipcRenderer.invoke(IpcChannel.agentRecheckLogin),
    startLogin: (threadId) => ipcRenderer.invoke(IpcChannel.agentStartLogin, threadId),
    loginRecovery: () => ipcRenderer.invoke(IpcChannel.agentLoginRecovery),
    cancelLogin: () => ipcRenderer.invoke(IpcChannel.agentCancelLogin),
    unattendedLoginGuide: () => ipcRenderer.invoke(IpcChannel.agentUnattendedLoginGuide),
    onLoginRecovery: (listener) => subscribe<LoginRecoveryState>(IpcEvent.agentLoginRecoveryChanged, listener),
    getAutoLogin: () => ipcRenderer.invoke(IpcChannel.authAutoLoginGet),
    setAutoLogin: (enabled) => ipcRenderer.invoke(IpcChannel.authAutoLoginSet, enabled),
    getSettings: () => ipcRenderer.invoke(IpcChannel.settingsGet),
    setSettings: (patch) => ipcRenderer.invoke(IpcChannel.settingsSet, patch),
    onStatus: (listener) => subscribe<AgentStatus>(IpcEvent.agentStatusChanged, listener)
  },
  settings: {
    snapshot: () => ipcRenderer.invoke(IpcChannel.settingsSnapshot),
    onChanged: (listener) => subscribe<null>(IpcEvent.settingsChanged, () => listener())
  },
  // Wave 64 bundle A: export and import of threads and settings (TODO 1088).
  data: {
    export: (passphrase) => ipcRenderer.invoke(IpcChannel.dataExport, passphrase),
    import: (passphrase) => ipcRenderer.invoke(IpcChannel.dataImport, passphrase)
  },
  // Wave 99 bundle C: automatic backup and restore (TODO 1306).
  backup: {
    status: () => ipcRenderer.invoke(IpcChannel.backupStatus),
    setPassphrase: (passphrase) => ipcRenderer.invoke(IpcChannel.backupSetPassphrase, passphrase),
    runNow: () => ipcRenderer.invoke(IpcChannel.backupRunNow),
    chooseDir: () => ipcRenderer.invoke(IpcChannel.backupChooseDir),
    resetDir: () => ipcRenderer.invoke(IpcChannel.backupResetDir),
    dismissNotice: () => ipcRenderer.invoke(IpcChannel.backupDismissNotice),
    restore: (passphrase) => ipcRenderer.invoke(IpcChannel.backupRestore, passphrase),
    keepCurrent: () => ipcRenderer.invoke(IpcChannel.backupKeepCurrent),
    onChanged: (listener) => subscribe<BackupStatus>(IpcEvent.backupChanged, listener)
  },
  // Wave 14 bundle M: voice input (item 226). Wave 29 bundle D: the recognition language setting (TODO 626).
  gmailDraftFont: {
    get: () => ipcRenderer.invoke(IpcChannel.gmailDraftFontGet),
    set: (font) => ipcRenderer.invoke(IpcChannel.gmailDraftFontSet, font)
  },
  voice: {
    transcribe: (wav) => ipcRenderer.invoke(IpcChannel.voiceTranscribe, wav),
    getLocale: () => ipcRenderer.invoke(IpcChannel.voiceLocaleGet),
    setLocale: (preference) => ipcRenderer.invoke(IpcChannel.voiceLocaleSet, preference)
  },
  // Wave 17 bundle B: usage limits (item 317)
  usage: {
    get: () => ipcRenderer.invoke(IpcChannel.usageGet),
    onChanged: (listener) => subscribe<UsageSnapshot>(IpcEvent.usageChanged, listener)
  },
  // Wave 26 bundle B: the connection state to the model (TODO 525)
  connection: {
    get: () => ipcRenderer.invoke(IpcChannel.connectionGet),
    onChanged: (listener) => subscribe<ConnectionStatus>(IpcEvent.connectionChanged, listener)
  },
  // Wave 17 bundle F: attach a clipboard image (item 319)
  paste: {
    image: () => ipcRenderer.invoke(IpcChannel.pasteImage),
    capture: (keepWindows) => ipcRenderer.invoke(IpcChannel.pasteCapture, keepWindows === true),
    captureHeadsUp: () => ipcRenderer.invoke(IpcChannel.pasteCaptureHeadsUp),
    captureHeadsUpShown: () => ipcRenderer.invoke(IpcChannel.pasteCaptureHeadsUpShown)
  },
  // Wave 18 bundle A: scheduled runs (TODO 323)
  schedule: {
    list: () => ipcRenderer.invoke(IpcChannel.scheduleList),
    create: (input) => ipcRenderer.invoke(IpcChannel.scheduleCreate, input),
    update: (id, input) => ipcRenderer.invoke(IpcChannel.scheduleUpdate, id, input),
    remove: (id) => ipcRenderer.invoke(IpcChannel.scheduleRemove, id),
    runNow: (id) => ipcRenderer.invoke(IpcChannel.scheduleRunNow, id),
    // TODO 628: a reservation to resume after a usage limit clears.
    reserveResume: (threadId, prompt, at) => ipcRenderer.invoke(IpcChannel.scheduleReserveResume, threadId, prompt, at),
    reserveLater: (threadId, input) => ipcRenderer.invoke(IpcChannel.scheduleReserveLater, threadId, input),
    retryLater: (id) => ipcRenderer.invoke(IpcChannel.scheduleRetryLater, id),
    takeLater: (id) => ipcRenderer.invoke(IpcChannel.scheduleTakeLater, id),
    setPluginListOpen: (pluginId) => ipcRenderer.invoke(IpcChannel.schedulePluginListOpen, pluginId),
    snooze: (id, minutes) => ipcRenderer.invoke(IpcChannel.scheduleSnooze, id, minutes),
    cancelSnooze: (id) => ipcRenderer.invoke(IpcChannel.scheduleCancelSnooze, id),
    onChanged: (listener) => subscribe<ScheduleOverview>(IpcEvent.scheduleChanged, listener)
  },
  // TODO 972: roles (Teammates)
  roles: {
    list: () => ipcRenderer.invoke(IpcChannel.roleList),
    create: (input) => ipcRenderer.invoke(IpcChannel.roleCreate, input),
    update: (id, input) => ipcRenderer.invoke(IpcChannel.roleUpdate, id, input),
    remove: (id) => ipcRenderer.invoke(IpcChannel.roleRemove, id),
    moveThread: (threadId, roleId) => ipcRenderer.invoke(IpcChannel.roleMoveThread, threadId, roleId),
    onChanged: (listener) => subscribe<readonly Role[]>(IpcEvent.roleChanged, listener)
  },
  // TODO 982 / 1292 item 2: drills
  drills: {
    start: (roleId, jobId) => ipcRenderer.invoke(IpcChannel.drillStart, roleId, jobId),
    report: (threadId) => ipcRenderer.invoke(IpcChannel.drillReport, threadId),
    grant: (threadId, opIds) => ipcRenderer.invoke(IpcChannel.drillGrant, threadId, opIds),
    onChanged: (listener) => subscribe<string>(IpcEvent.drillChanged, listener)
  },
  // TODO 1216: triggers
  trigger: {
    list: () => ipcRenderer.invoke(IpcChannel.triggerList),
    update: (pluginId, triggerId, rule, acknowledged) =>
      ipcRenderer.invoke(IpcChannel.triggerUpdate, pluginId, triggerId, rule, acknowledged ?? null),
    onChanged: (listener) => subscribe<TriggerOverview>(IpcEvent.triggerChanged, listener)
  },
  // Wave 21 bundle A: the ViewerPane web view (TODO 400)
  web: {
    load: (url) => ipcRenderer.invoke(IpcChannel.webLoad, url),
    setBounds: (bounds) => ipcRenderer.invoke(IpcChannel.webSetBounds, bounds),
    setVisible: (visible, snapshot) => ipcRenderer.invoke(IpcChannel.webSetVisible, visible, snapshot),
    setShortcuts: (table) => ipcRenderer.invoke(IpcChannel.webSetShortcuts, table),
    reload: () => ipcRenderer.invoke(IpcChannel.webReload),
    stop: () => ipcRenderer.invoke(IpcChannel.webStop),
    focus: () => ipcRenderer.invoke(IpcChannel.webFocus),
    find: (request) => ipcRenderer.invoke(IpcChannel.webFind, request),
    stopFind: () => ipcRenderer.invoke(IpcChannel.webStopFind),
    close: () => ipcRenderer.invoke(IpcChannel.webClose),
    onEvent: (listener) => subscribe<WebViewEvent>(IpcEvent.webEvent, listener),
    // Wave 26 bundle A: tabs, history, Favorites (TODO 522)
    tabs: () => ipcRenderer.invoke(IpcChannel.webTabs),
    newTab: (url) => ipcRenderer.invoke(IpcChannel.webNewTab, url),
    activateTab: (id) => ipcRenderer.invoke(IpcChannel.webActivateTab, id),
    closeTab: (id) => ipcRenderer.invoke(IpcChannel.webCloseTab, id),
    onTabsChanged: (listener) => subscribe<WebTabsState>(IpcEvent.webTabsChanged, listener),
    history: () => ipcRenderer.invoke(IpcChannel.webHistoryList),
    removeHistory: (id) => ipcRenderer.invoke(IpcChannel.webHistoryRemove, id),
    clearHistory: () => ipcRenderer.invoke(IpcChannel.webHistoryClear),
    favorites: () => ipcRenderer.invoke(IpcChannel.webFavoritesList),
    favicons: () => ipcRenderer.invoke(IpcChannel.webFaviconsList),
    addFavorite: (url, title) => ipcRenderer.invoke(IpcChannel.webFavoriteAdd, url, title),
    removeFavorite: (target) => ipcRenderer.invoke(IpcChannel.webFavoriteRemove, target),
    moveFavorite: (id, index) => ipcRenderer.invoke(IpcChannel.webFavoriteMove, id, index),
    onDataChanged: (listener) => subscribe<WebDataChange>(IpcEvent.webDataChanged, listener),
    sections: () => ipcRenderer.invoke(IpcChannel.webSectionsGet),
    setSections: (layout) => ipcRenderer.invoke(IpcChannel.webSectionsSet, layout),
    // TODO 676 (wave 31 bundle C): import Chrome bookmarks
    chromeProfiles: () => ipcRenderer.invoke(IpcChannel.webChromeProfiles),
    importChrome: (profileDir) => ipcRenderer.invoke(IpcChannel.webChromeImport, profileDir),
    // TODO 723 (wave 34 bundle B)
    chromeIcon: () => ipcRenderer.invoke(IpcChannel.webChromeIcon),
    // Wave 27 bundle B (TODO 553)
    resolveLink: (url) => ipcRenderer.invoke(IpcChannel.webResolveLink, url),
    // Wave 27 bundle B (TODO 547)
    certificateStatus: (url) => ipcRenderer.invoke(IpcChannel.webCertificateStatus, url),
    trustCertificate: (url) => ipcRenderer.invoke(IpcChannel.webTrustCertificate, url),
    trustedCertificates: () => ipcRenderer.invoke(IpcChannel.webTrustedCertificates),
    revokeCertificate: (host) => ipcRenderer.invoke(IpcChannel.webRevokeCertificate, host),
    // TODO 1055 (2)
    tabReadConsent: () => ipcRenderer.invoke(IpcChannel.webTabReadConsentGet),
    revokeTabReadConsent: () => ipcRenderer.invoke(IpcChannel.webTabReadConsentRevoke),
    // Wave 33 bundle B (TODO 697)
    loginSites: () => ipcRenderer.invoke(IpcChannel.webLoginSitesList),
    clearLoginSite: (domain) => ipcRenderer.invoke(IpcChannel.webLoginSitesClear, domain),
    clearAllLoginSites: () => ipcRenderer.invoke(IpcChannel.webLoginSitesClearAll)
  },
  // Wave 23 bundle C: Latin-letter input in the search box (TODO 463)
  input: {
    asciiForSearch: (focused) => ipcRenderer.send(IpcChannel.inputAsciiForSearch, focused === true),
    getAsciiForSearch: () => ipcRenderer.invoke(IpcChannel.inputAsciiGet),
    setAsciiForSearch: (enabled) => ipcRenderer.invoke(IpcChannel.inputAsciiSet, enabled)
  },
  // Wave 28 bundle D: viewer autosave (TODO 555)
  autoSave: {
    get: () => ipcRenderer.invoke(IpcChannel.autoSaveGet),
    set: (patch) => ipcRenderer.invoke(IpcChannel.autoSaveSet, patch),
    onChanged: (listener) => subscribe<AutoSaveSettings>(IpcEvent.autoSaveChanged, listener)
  },
  // Wave 43 bundle C: the order of the file tree (TODO 872)
  searchHistory: {
    get: () => ipcRenderer.invoke(IpcChannel.searchHistoryGet),
    add: (query, mode) => ipcRenderer.invoke(IpcChannel.searchHistoryAdd, query, mode),
    remove: (query, mode) => ipcRenderer.invoke(IpcChannel.searchHistoryRemove, query, mode),
    clear: () => ipcRenderer.invoke(IpcChannel.searchHistoryClear)
  },
  fileSort: {
    get: () => ipcRenderer.invoke(IpcChannel.fileSortGet),
    set: (order) => ipcRenderer.invoke(IpcChannel.fileSortSet, order),
    onChanged: (listener) => subscribe<FileSortOrder>(IpcEvent.fileSortChanged, listener)
  },
  // Wave 44 bundle A: the Redmine base URL (TODO 811)
  redmine: {
    get: () => ipcRenderer.invoke(IpcChannel.redmineGet),
    set: (baseUrl) => ipcRenderer.invoke(IpcChannel.redmineSet, baseUrl),
    onChanged: (listener) => subscribe<string>(IpcEvent.redmineChanged, listener)
  },
  // Wave 30 bundle C: the number of days after which the thread list folds (TODO 659)
  threadCollapse: {
    get: () => ipcRenderer.invoke(IpcChannel.threadCollapseGet),
    set: (days) => ipcRenderer.invoke(IpcChannel.threadCollapseSet, days),
    onChanged: (listener) => subscribe<number>(IpcEvent.threadCollapseChanged, listener)
  },
  // Wave 27 bundle E: keyboard shortcut assignments (TODO 549)
  keybindings: {
    get: () => ipcRenderer.invoke(IpcChannel.keybindingsGet),
    set: (overrides) => ipcRenderer.invoke(IpcChannel.keybindingsSet, overrides),
    globalStatus: () => ipcRenderer.invoke(IpcChannel.keybindingsGlobalStatus),
    setRecording: (recording) => ipcRenderer.send(IpcChannel.keybindingsRecording, recording === true),
    onChanged: (listener) => subscribe<KeybindingOverrides>(IpcEvent.keybindingsChanged, listener)
  },
  // Wave 28 bundle G: auto-update (TODO 103)
  update: {
    status: () => ipcRenderer.invoke(IpcChannel.updateStatus),
    check: () => ipcRenderer.invoke(IpcChannel.updateCheck),
    install: () => ipcRenderer.invoke(IpcChannel.updateInstall),
    restart: () => ipcRenderer.invoke(IpcChannel.updateRestart),
    setAuto: (on) => ipcRenderer.invoke(IpcChannel.updateSetAuto, on === true),
    dismissNotice: () => ipcRenderer.invoke(IpcChannel.updateDismissNotice),
    onChanged: (listener) => subscribe<UpdateStatus>(IpcEvent.updateChanged, listener),
    onCollectDrafts: (listener) => subscribe<CarriedDraftsRequest>(IpcEvent.updateCollectDrafts, listener),
    submitDrafts: (requestId, reply) => ipcRenderer.invoke(IpcChannel.updateSubmitDrafts, requestId, reply),
    takeCarriedDrafts: () => ipcRenderer.invoke(IpcChannel.updateTakeCarriedDrafts)
  },
  // Wave 36 bundle D: the CLI's own update (TODO 774)
  agentUpdate: {
    status: () => ipcRenderer.invoke(IpcChannel.agentUpdateStatus),
    run: () => ipcRenderer.invoke(IpcChannel.agentUpdateRun),
    revert: () => ipcRenderer.invoke(IpcChannel.agentUpdateRevert),
    setAuto: (on) => ipcRenderer.invoke(IpcChannel.agentUpdateSetAuto, on === true),
    dismissNotice: () => ipcRenderer.invoke(IpcChannel.agentUpdateDismissNotice),
    onChanged: (listener) => subscribe<AgentUpdateStatus>(IpcEvent.agentUpdateChanged, listener)
  },
  // Wave 56 bundle A: the "Account" section of the extension details (TODO 952 stage 1)
  pluginAccounts: {
    status: (pluginId) => ipcRenderer.invoke(IpcChannel.pluginAccountStatus, pluginId),
    importClient: (pluginId) => ipcRenderer.invoke(IpcChannel.pluginAccountImportClient, pluginId),
    signIn: (pluginId, credential) => ipcRenderer.invoke(IpcChannel.pluginAccountSignIn, pluginId, credential),
    cancelSignIn: (pluginId, credential) =>
      ipcRenderer.invoke(IpcChannel.pluginAccountCancelSignIn, pluginId, credential),
    signOut: (pluginId, credential) => ipcRenderer.invoke(IpcChannel.pluginAccountSignOut, pluginId, credential),
    saveToken: (pluginId, credential, email, token) =>
      ipcRenderer.invoke(IpcChannel.pluginAccountSaveToken, pluginId, credential, email, token)
  },
  // TODO 1225: the "Settings" section of the extension details
  pluginSettings: {
    get: (pluginId) => ipcRenderer.invoke(IpcChannel.pluginSettings, pluginId),
    save: (pluginId, name, value) => ipcRenderer.invoke(IpcChannel.pluginSettingsSave, pluginId, name, value)
  }
}

contextBridge.exposeInMainWorld('aios', api)
