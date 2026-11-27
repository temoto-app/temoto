/**
 * The IPC contract between main <-> renderer.
 *
 * The renderer calls it only through `window.aios` (exposed by the preload's contextBridge).
 * `nodeIntegration` is disabled and `contextIsolation` is enabled (IMPLEMENTATION_BRIEF chapter 7).
 */
import type { AgentStatus, AiosEventBatch, BackendStatusRow, McpGlobalReport } from './agent.js'
import type { LocalModelAction, LocalModelActionResult, LocalModelActivityRow, LocalModelAdvice } from './local-models.js'
import type { ReasonCode } from './reason.js'
import type { BootAnswer } from './boot.js'
import type { HelpDocument } from './help.js'
import type { ReleaseNotesDocument } from './release-notes.js'
import type { OsSettingsState } from './os-settings.js'
import type {
  PluginCatalogResult,
  PluginOpResult,
  SkillDeleteRequest,
  SkillDeleteResult,
  SkillListing
} from './skills.js'
import type { ContextBreakdownResult } from './context-breakdown.js'
import type { GlobalHotkeyStatuses, KeybindingOverrides } from './keybindings.js'
import type { AutoSaveSettings } from './auto-save.js'
import type { FileSortOrder } from './file-sort.js'
import type { ViewerDraftsReply, ViewerDraftsRequest } from './viewer-drafts-close.js'
import type { CarriedDrafts, CarriedDraftsReply, CarriedDraftsRequest, UpdateStatus } from './update.js'
import type { SearchHistoryEntry, SearchHistoryMode } from './search-history.js'
import type { ViewerHistorySnapshot } from './viewer-history.js'
import type { ViewerShownReport } from './viewer-shown.js'
import type { AgentUpdateStatus } from './agent-update.js'
import type { ConversationExport, ExportScope, SavePdfResult } from './conversation-export.js'
import type { HandoffEstimate } from './handoff.js'
import type { PluginAccountResult, PluginAccountStatus } from './plugin-account.js'
import type { PluginSettingValue, PluginSettingsView } from './plugin-settings.js'
import type {
  ApprovalDecision,
  ApprovalDiff,
  ApprovalItem,
  ApprovalPolicy,
  ApprovalPolicyPatch,
  ApprovalPolicySetResult,
  ApprovalRule,
  AttachmentResolution,
  BackendChoice,
  CreateThreadInput,
  DeletedThreadSummary,
  DirectoryPick,
  FolderNotice,
  PendingViewerDiff,
  RewindOptions,
  RoleGrantView,
  RewindPreview,
  SendInput,
  SendOutcome,
  SessionSettings,
  Thread,
  ThreadCreateOptions,
  ThreadRemoveOptions,
  ThreadRemoveResult,
  ThreadRetention,
  ThreadSummary,
  Timeline,
  TranscriptSession,
  ViewerCommand,
  ViewerCommandOutcome
} from './thread.js'
import type {
  IndexStatus,
  ScopeBuildResult,
  SearchResponse,
  SearchScope,
  ThreadSearchResponse
} from './search.js'
import type { GitStatus } from './git.js'
import type { EditorId, EditorOpenOptions } from './editor.js'
import type { VoiceTranscribeResult } from './voice.js'
import type { DataExportResult, DataImportResult } from './data-transfer.js'
import type { VoiceLocalePreference } from './voice-locale.js'
import type { GmailDraftFont } from './gmail-draft-font.js'
import type { UsageSnapshot } from './usage.js'
import type { BackupActionResult, BackupStatus } from './backup.js'
import type { ConnectionStatus } from './connection.js'
import type { LoginRecoveryState, UnattendedLoginGuide } from './login-recovery.js'
import type { LaterInput, LaterSend, LaterTaken, ResumeReservation, ScheduledJobInput, ScheduleOverview } from './schedule.js'
import type { Role, RoleInput } from './role.js'
import type { DrillReport } from './drill.js'
import type { TriggerAutoDisabled, TriggerOverview, TriggerRule } from './trigger.js'
import type { LinkResolution, LinkResolveInput } from './link.js'
import type { DropLinkCheck, DropTrace } from './drop-link.js'
import type { CreateEntryResult, RenameEntryResult } from './new-entry.js'
import type {
  WebFindRequest,
  WebViewBounds,
  WebViewEvent,
  WebViewShortcut
} from './web-view.js'
import type { TrustedCertificate, WebCertificateStatus } from './web-certs.js'
import type { LoginSite } from './web-login-sites.js'
import type {
  ChromeImportProfile,
  ChromeImportResult,
  WebDataChange,
  WebFavicons,
  WebFavorite,
  WebHistoryEntry,
  WebSectionsLayout,
  WebTabsState
} from './web-tabs.js'
import type { ThemePreference, ThemeState } from './theme.js'
import type { LocalePreference, LocaleState } from './locale.js'
import type { SettingsSnapshot } from './settings.js'
import type {
  AuditEntry,
  CapabilityName,
  PluginDetail,
  PluginSummary,
  ResolvedViewer,
  ViewerImageConversion,
  TransientPayloadKind,
  ViewerAssociationEntry,
  ViewerChoices,
  ViewerCommandResponse
} from './plugin.js'
import type { PluginSurfacesSnapshot } from './plugin-surfaces.js'
import type { PluginSearchResponse } from './plugin-search.js'
import type { PluginUpdateAllResult } from './plugin-update.js'
import type { DbBreakdown } from './db-breakdown.js'
import type { ThreadLinkLocation } from './thread-link.js'
import type {
  AppInfo,
  LogInfo,
  DirectoryListing,
  ListDirectoryOptions,
  FileChangeBatch,
  FileEntry,
  FileSearchResult,
  ScanStatus,
  TextWriteResult,
  ViewerResource,
  VolumeEntry
} from './types.js'
import type { RecentFile, RecentListOptions } from './recent-files.js'
import type { WindowLayout } from './window-layout.js'

/** Channel names for invoke-style calls. */
/** TODO 967: the kinds of `app.openSystemSettings`. For now only screen recording. */
export type SystemSettingsKind = 'screen-recording'

/** The result of `threads.openInTerminal` (TODO 908). A reason code when it could not open. */
export type OpenInTerminalResult =
  | { readonly opened: true }
  | { readonly opened: false; readonly reason: ReasonCode }

export const IpcChannel = {
  // ---- Launch order (TODO 807, 3.1). Registered before the DB is open; every other handler is registered after it. ----
  /** The boot entry waits here until main has registered every handler (`BootAnswer`). */
  bootWait: 'aios:boot/wait',
  /** The boot entry painted its first frame (send). main shows the first window and only then asks for the DB key. */
  bootPainted: 'aios:boot/painted',
  appInfo: 'aios:app/info',
  /** TODO 1281: where the log file is (main decides; the renderer passes nothing). */
  appLogInfo: 'aios:app/log-info',
  /** Breakdown of the DB (TODO 846 / 914 / 988). Measured by the index process. Only when pressed. */
  appDbBreakdown: 'aios:app/db-breakdown',
  /** Open in the external browser. main narrows it to `http:` / `https:` / `mailto:` and re-validates (5.1). */
  appOpenExternal: 'aios:app/openExternal',
  /** TODO 967: open a fixed pane of the system settings / restart aios. */
  appOpenSystemSettings: 'aios:app/openSystemSettings',
  appRelaunch: 'aios:app/relaunch',
  /** TODO 1327: the calling window's layout (`WindowLayout`, which panes it hides) / the renderer reports a change (send). */
  appWindowLayout: 'aios:app/windowLayout',
  appSetWindowLayout: 'aios:app/setWindowLayout',
  fsRoots: 'aios:fs/roots',
  fsList: 'aios:fs/list',
  /** Whether the file tree shows names starting with "." (TODO 261). One for the whole app. */
  fsHiddenGet: 'aios:fs/hidden/get',
  fsHiddenSet: 'aios:fs/hidden/set',
  fsSearch: 'aios:fs/search',
  fsStat: 'aios:fs/stat',
  fsScanStatus: 'aios:fs/scanStatus',
  fsRescan: 'aios:fs/rescan',
  /** TODO 805: end the delay for protected folders (Desktop / Documents / Downloads) and include them in the index right now. */
  fsIncludeProtectedFolders: 'aios:fs/includeProtectedFolders',
  /** The list of external storage and allow / revoke (4.4.2 "external storage"). */
  fsVolumes: 'aios:fs/volumes',
  fsSetVolumeAllowed: 'aios:fs/setVolumeAllowed',
  /** The OS folder-picker dialog (T5). main returns the result after passing it through `assertAllowed`. */
  fsPickDirectory: 'aios:fs/pickDirectory',
  /** Resolves a link in the body to the URI of a file that actually exists (item 254). In the order cwd -> auto memory. */
  fsResolveLink: 'aios:fs/resolveLink',
  /** Passes files dropped onto the viewer through the choke point (`assertAllowed`, read) (TODO 366). */
  dropCheckLinks: 'aios:drop/checkLinks',
  /** Log of the viewer's drop path (TODO 407). Only counts and success/failure. main re-validates and writes one line. */
  dropTrace: 'aios:drop/trace',
  /**
   * Creates a new file / folder from the Files tree (TODO 370). Only the parent URI and the string of the input field are passed, and
   * main re-validates the name, the choke point and realpath before creating. **It does not throw**: when refused, `CreateEntryResult.reason`.
   */
  fsCreateFile: 'aios:fs/createFile',
  fsCreateFolder: 'aios:fs/createFolder',
  fsRename: 'aios:fs/rename',
  /**
   * The icon of a `.app` row in the Files tree (TODO 562). main gets it with `app.getFileIcon` and returns a PNG data URL
   * (cached by path + mtime). **It does not throw**: null if it cannot be obtained, is not an `.app`, or is refused by the choke point.
   */
  fsAppIcon: 'aios:fs/appIcon',
  /** Native drag from the Files tree to an external app (TODO 677). `send` only (does not throw, no reply). */
  fsStartDrag: 'aios:fs/startDrag',
  /**
   * The clip in the prompt field (item 161). Returns the files chosen in the OS file picker (multiple allowed) as URIs.
   * Validation is the same `threads.resolveAttachment` (`assertAllowed`) as for a drop; this only lets the user choose.
   */
  attachmentsPick: 'aios:attachments/pick',
  /** TODO 999: the list of "recent files" (`RecentListOptions`). main re-validates the kind and count. */
  recentList: 'aios:recent/list',
  /** TODO 999: thumbnails (data URL) of images, videos and PDFs. main re-validates the choke point and the extension. Does not throw. */
  recentThumbnail: 'aios:recent/thumbnail',
  /** TODO 1172: the badge of recent files (of the first 3 of the small window, those within 5 minutes, newest first). Empty if turned off in settings. */
  recentOffers: 'aios:recent/offers',
  recentScreenshotOfferEnabledGet: 'aios:recent/screenshotOfferEnabled/get',
  recentScreenshotOfferEnabledSet: 'aios:recent/screenshotOfferEnabled/set',

  threadList: 'aios:thread/list',
  threadCreate: 'aios:thread/create',
  threadOpen: 'aios:thread/open',
  /** TODO 526: the set of threads whose Composer in this window has a draft (or attachment) (to protect them from deletion of neglected threads). */
  threadReportComposerDrafts: 'aios:thread/reportComposerDrafts',
  threadTimeline: 'aios:thread/timeline',
  /** The previous page of the timeline (item 88, up to N rows with `seq < before`). */
  threadTimelineBefore: 'aios:thread/timelineBefore',
  threadSend: 'aios:thread/send',
  /** Interrupt (item 94): stop the current turn and send this input ahead of queued ones. */
  threadSendInterrupt: 'aios:thread/sendInterrupt',
  /** TODO 893: send the last input again (after authentication expired). Queued if a response is in progress. */
  threadResendLast: 'aios:thread/resendLast',
  /** TODO 908: open the default terminal in the conversation's working folder and start the CLI (the authentication-expired badge). */
  threadOpenInTerminal: 'aios:thread/openInTerminal',
  /** Cancel a queued message (the chip's x) and take it out (the pencil, back into the input field). */
  threadCancelReservation: 'aios:thread/cancelReservation',
  threadTakeReservation: 'aios:thread/takeReservation',
  threadInterrupt: 'aios:thread/interrupt',
  threadStop: 'aios:thread/stop',
  threadRename: 'aios:thread/rename',
  /** Mark as unread / read by hand (TODO 741, the Sidebar's right-click). */
  threadSetUnread: 'aios:thread/setUnread',
  threadDelete: 'aios:thread/delete',
  threadSetRetention: 'aios:thread/setRetention',
  threadClearLog: 'aios:thread/clearLog',
  threadClearAllLogs: 'aios:thread/clearAllLogs',
  threadResolveAttachment: 'aios:thread/resolveAttachment',
  // Wave 27 bundle F: the `aios-res://` URL that shows a sent image (an attachment pointing to a file) in the timeline (TODO 550)
  threadAttachmentImage: 'aios:thread/attachmentImage',
  // Wave 44 bundle D: the `aios-res://` URL that shows a local image inside an answer's Markdown in the ThreadPane (TODO 876)
  threadTimelineImage: 'aios:thread/timelineImage',
  threadAllowDir: 'aios:thread/allowDir',
  // TODO 818: save a conversation as a PDF (reading the body / the save dialog + writing out)
  threadExportTurns: 'aios:thread/exportTurns',
  threadSavePdf: 'aios:thread/savePdf',
  // TODO 866: save a conversation as a single-file HTML (main embeds images as data:)
  threadSaveHtml: 'aios:thread/saveHtml',
  // TODO 1014: save a conversation as Markdown (main re-applies redaction to the Markdown the renderer built and writes it)
  threadSaveMarkdown: 'aios:thread/saveMarkdown',
  // ---- Create dialog (T5) ----
  threadCreateOptions: 'aios:thread/createOptions',
  /** A light entry point for the Composer (item 88): only the feature table and the model list. No `stat` of the cwd history. */
  threadBackends: 'aios:thread/backends',
  /** The first-time-folder notice (item 123). When a folder is chosen in the create dialog. */
  threadFolderNotice: 'aios:thread/folderNotice',
  /** The `cwdMatchKey` of the chosen folder (item 239). The side that matches "conversations of this folder" by real path. */
  threadFolderMatchKey: 'aios:thread/folderMatchKey',
  /** Create a thread by dropping a folder (item 98). The decision is main's `createThreadFromDrop`. */
  threadCreateFromDrop: 'aios:thread/createFromDrop',
  /** Take the "thread to open" deposited for this window (item 98 (c), a drop on the Dock). */
  threadTakeOpenRequest: 'aios:thread/takeOpenRequest',
  cwdHistoryRemove: 'aios:thread/cwdHistory/remove',
  cwdHistoryClear: 'aios:thread/cwdHistory/clear',

  searchQuery: 'aios:search/query',
  searchThread: 'aios:search/thread',
  searchStatus: 'aios:search/status',
  searchPause: 'aios:search/pause',
  searchResume: 'aios:search/resume',
  // Building the subtree at the moment the scope (TODO 437) was decided.
  searchBuildScope: 'aios:search/buildScope',
  threadToolResult: 'aios:thread/toolResult',

  approvalList: 'aios:approval/list',
  approvalDecide: 'aios:approval/decide',
  // ---- Approval rules and defaults (T12 / 4.2) ----
  approvalRules: 'aios:approval/rules',
  approvalRuleRemove: 'aios:approval/rules/remove',
  // TODO 983 stage 2: "what this job was allowed" in editing a scheduled job.
  approvalRoleGrants: 'aios:approval/role-grants',
  approvalRoleGrantRemove: 'aios:approval/role-grants/remove',
  approvalPolicyGet: 'aios:approval/policy/get',
  approvalPolicySet: 'aios:approval/policy/set',
  threadSetApprovalStrict: 'aios:thread/setApprovalStrict',
  /** Switching the OS sandbox (TODO 1106 / 4.2.4). The process is restarted on the next send. */
  threadSetOsSandbox: 'aios:thread/setOsSandbox',
  threadSetAutoPick: 'aios:thread/setAutoPick',
  /** Toggle of Plan mode (item 112 / 4.2.3). main holds it and aligns the process just before the next send. */
  threadSetPlanMode: 'aios:thread/setPlanMode',
  /** The diff of the approval box (item 97 / 7.6.4). main applies the change to the file's current contents and returns before and after. */
  approvalDiff: 'aios:approval/diff',
  /** The thread's ViewerPane memory (item 63). main re-validates the URI before writing. */
  threadSetViewerState: 'aios:thread/setViewerState',
  /** Reading and writing the viewer's back / forward history (TODO 772). */
  threadViewerHistory: 'aios:thread/viewerHistory',
  threadSetViewerHistory: 'aios:thread/setViewerHistory',
  /** TODO 1337 (11): a part of the workspace copy failed (kind names only, fire and forget). main re-validates and writes one log line. */
  threadWorkspaceCopyFailed: 'aios:thread/workspaceCopyFailed',
  /** "Rewind to here" (item 113, 4.5.6): preview and execution. */
  threadRewindPreview: 'aios:thread/rewindPreview',
  threadRewind: 'aios:thread/rewind',
  /** "Lighten and continue in a new conversation" (TODO 961): estimate and execution. */
  threadHandoffEstimate: 'aios:thread/handoffEstimate',
  threadHandoff: 'aios:thread/handoff',
  /** A model of another backend was chosen in the Model picker (TODO 1018): switch in place, or branch and continue. */
  threadSwitchBackend: 'aios:thread/switchBackend',
  /** Breakdown of context usage (item 155, 4.5.1). The last record if there is no process. */
  threadContextBreakdown: 'aios:thread/contextBreakdown',
  // ---- Continue from the CLI's conversation / continue in a terminal (item 111, 4.5.9) ----
  /** The list of the backend's transcripts (excluding those an aios thread already has and those of subagents). */
  threadTranscriptSessions: 'aios:thread/transcriptSessions',
  /** The one conversation that a transcript hit of the conversation search (`transcript://…`) points to. */
  threadTranscriptSession: 'aios:thread/transcriptSession',

  agentStatus: 'aios:agent/status',
  agentRecheck: 'aios:agent/recheck',
  /** TODO 1019: the state of all backends in the registry (settings screen). If the argument force is true, detect again. */
  agentBackends: 'aios:agent/backends',
  /** TODO 1066: "recommendations for this PC" for local models (backendId, force). */
  agentLocalAdvice: 'aios:agent/localAdvice',
  /** TODO 1066: the recommended actions (fetch, a derived model with a context length). Only when pressed (backendId, action, model). */
  agentLocalAction: 'aios:agent/localAction',
  /** TODO 1066: only the running action and its progress (a light entry point; no recommendation computation). */
  agentLocalActivity: 'aios:agent/localActivity',
  /** TODO 893: re-check only the login state (the authentication-expired badge; version and feature table are not detected again). */
  agentRecheckLogin: 'aios:agent/recheckLogin',
  /** TODO 960: recovery from expired authentication (run `auth login` in Terminal, detect completion and resend). */
  agentStartLogin: 'aios:agent/startLogin',
  /** TODO 1282: the state of that recovery (waiting / recovered / cancelled / failed). No arguments. */
  agentLoginRecovery: 'aios:agent/loginRecovery',
  /** TODO 1282: cancel the wait for the login started in Terminal. No arguments. */
  agentCancelLogin: 'aios:agent/cancelLogin',
  /** TODO 1282: the guidance for unattended runs (words for the screen only; no token passes here). No arguments. */
  agentUnattendedLoginGuide: 'aios:agent/unattendedLoginGuide',
  authAutoLoginGet: 'aios:auth/autoLogin/get',
  authAutoLoginSet: 'aios:auth/autoLogin/set',
  /** The BottomBar's git summary (5.6, TODO 51). main re-validates the URI, and null if it cannot be produced. */
  gitStatus: 'aios:git/status',
  settingsGet: 'aios:settings/get',
  settingsSet: 'aios:settings/set',

  // ---- Open in an external editor (item 115) ----
  editorGet: 'aios:editor/get',
  editorSet: 'aios:editor/set',
  /** Open a file / cwd in the external editor. main re-validates the URI before launching. */
  editorOpen: 'aios:editor/open',
  /**
   * An entry point only for "open in external editor" in the band for links that could not be opened (TODO 808). If main refuses at the ordinary choke point, it re-checks at a
   * choke point that only hands off outside (`'handoff'`). The choke point of `editorOpen` is not widened.
   */
  editorOpenHandoff: 'aios:editor/open-handoff',
  /** Reveal in Finder / Explorer (TODO 289). main re-validates the URI and then calls `shell.showItemInFolder`. */
  revealInFolder: 'aios:editor/reveal',
  /** Open the log folder in Finder (TODO 376). Only main knows the path. The renderer passes nothing. */
  revealLogs: 'aios:editor/reveal-logs',
  /** Build the masked problem report file and show it in Finder (TODO 1308). Nothing is sent. The renderer passes nothing. */
  reportProblem: 'aios:editor/report-problem',
  /**
   * Open with the OS default app (TODO 405, the `.avi` of `aios.video`). Unrelated to the editor chosen in settings
   * (a different path from `editorOpen`). main re-validates the URI and then calls `shell.openPath`.
   */
  editorOpenDefault: 'aios:editor/open-default',
  /**
   * "Open in the default app" of the host (aios's own UI) (TODO 1214). A different entry point from `editorOpenDefault` (for plugins, with a per-plugin table and audit),
   * and its table is `HOST_OPEN_DEFAULT_EXTENSIONS`. main re-validates the URI and the real extension against the table, and falls back to the chosen editor if it cannot open.
   */
  editorOpenInDefaultApp: 'aios:editor/open-in-default-app',

  // ---- Desktop notifications (item 72) ----
  notifyGet: 'aios:notify/get',
  notifySet: 'aios:notify/set',

  // ---- MCP servers (item 164) ----
  /** The latest report of global-side MCP servers (`McpGlobalReport | null`). Read only; no process is started. */
  mcpReport: 'aios:mcp/report',

  // ---- Skill management (TODO 773) ----
  /** The list of skills (the argument is the working folder's URI or null, `SkillListing`). */
  skillsList: 'aios:skills/list',
  /** Move a skill to the trash (`SkillDeleteRequest` -> `SkillDeleteResult`). */
  skillsTrash: 'aios:skills/trash',
  /** TODO 1099: filter the catalog of CLI plugins by a word (the argument is the word, `PluginCatalogResult`). */
  skillsPluginCatalog: 'aios:skills/plugin-catalog',
  /** TODO 1099: have the CLI install a name from the catalog (`PluginOpResult`). */
  skillsPluginInstall: 'aios:skills/plugin-install',
  /** TODO 1099: have the CLI remove an installed CLI plugin (`<name>@<marketplace>`) (`PluginOpResult`). */
  skillsPluginUninstall: 'aios:skills/plugin-uninstall',

  // ---- Color theme (7.4.1, T10) ----
  /** The current setting and the effective theme. */
  themeGet: 'aios:theme/get',
  /** Saves `light` / `dark` / `system`. Returns the resolved state. */
  themeSet: 'aios:theme/set',

  // ---- Display language (7.4.4, TODO 66) ----
  /** The current setting and the effective language. */
  localeGet: 'aios:locale/get',
  /** Saves `en` / `ja` / `system`. Returns the resolved state. */
  localeSet: 'aios:locale/set',

  // ---- Plugin foundation (Phase 4, chapter 7) ----
  pluginList: 'aios:plugin/list',
  pluginSetEnabled: 'aios:plugin/setEnabled',
  /** TODO 1144 stage 2: update one extension to the version of the latest Release. The state is delivered in the list's `update` (8.5.1). */
  pluginUpdate: 'aios:plugin/update',
  /** TODO 1144 stage 3: update all updatable extensions, one at a time in order. Returns the result per extension (8.5.1). */
  pluginUpdateAll: 'aios:plugin/updateAll',
  pluginSetConsent: 'aios:plugin/setConsent',
  /** TODO 1233: uninstall an external extension (move it to the trash and remove the rule, setting and consent rows. Bundled ones are refused. ARCHITECTURE 7.2). */
  pluginUninstall: 'aios:plugin/uninstall',
  pluginAudit: 'aios:plugin/audit',
  /** Details of an extension view (TODO 367). The manifest's contributions, permissions and consent, and the process state. */
  pluginDetail: 'aios:plugin/detail',
  /** The current whole of the plugin surfaces (the sidebar list and sync progress) (TODO 1039 / 1038). */
  pluginSurfaces: 'aios:plugin/surfaces',
  /** TODO 896: one query on a plugin section of the search sidebar. main re-queries the section and re-validates the result before returning it. */
  pluginSearch: 'aios:plugin/search',
  /** TODO 952 stage 1: the extension detail's "Account" (Google login). The state is only presence; values are not passed. */
  pluginAccountStatus: 'aios:plugin/account/status',
  /** Have the client's JSON chosen in main's dialog and seal it. */
  pluginAccountImportClient: 'aios:plugin/account/importClient',
  /** Sign in / re-enter (consent in the default browser). It does not return while waiting for consent. */
  pluginAccountSignIn: 'aios:plugin/account/signIn',
  pluginAccountCancelSignIn: 'aios:plugin/account/cancelSignIn',
  pluginAccountSignOut: 'aios:plugin/account/signOut',
  pluginAccountSaveToken: 'aios:plugin/account/saveToken',
  /** TODO 1225: the fields and current values of the extension detail's "Settings" (the manifest's `configuration`). */
  pluginSettings: 'aios:plugin/settings',
  /** TODO 1225: save the setting values. main re-validates them against the declaration. */
  pluginSettingsSave: 'aios:plugin/settings/save',
  /** Resolve the viewer for a URI and **at the same time grant that plugin read access**. */
  viewerOpen: 'aios:viewer/open',
  /** Resolve the viewer for a temporary view with no URI (item 104, `diff`). No read access is granted. */
  viewerOpenPayload: 'aios:viewer/open-payload',
  /** Resolve the viewer, by the name's extension, for a temporary-view file with no URI (TODO 905, inside a zip). No read access is granted. */
  viewerOpenTransientFile: 'aios:viewer/open-transient-file',
  /** Turn a temporary-view image (a HEIC inside a zip) into a JPEG for display (TODO 1162, the Broker operation `image.convertForDisplay`). */
  viewerConvertImage: 'aios:viewer/convert-image',
  /** Read the contents for a viewer through the Broker. */
  viewerRead: 'aios:viewer/read',
  /** Save. Only the ViewerPane (host) calls it, and it is not part of the viewer contract (5.2). */
  viewerWrite: 'aios:viewer/write',
  /** Call a plugin-host command from a viewer (7.1). */
  viewerCommand: 'aios:viewer/command',
  /**
   * Whether the ViewerPane has a draft changed (the latter half of item 97). renderer -> main, not high-frequency
   * (only when a draft is born / disappears). If `uri` is null, "no draft".
   */
  viewerReportDraft: 'aios:viewer/reportDraft',
  /**
   * The count of the window's table of viewer drafts (TODO 312, including those for files navigated away from) changed (code-review of TODO 103).
   * renderer -> main, only when the count changes. Neither body nor URI is sent. Material for stopping the auto-update's idle restart.
   */
  viewerReportStoredDrafts: 'aios:viewer/reportStoredDrafts',
  /**
   * TODO 832 (1): how this window handled an `open` instruction with `replyId` (the gateway's `openFile`). renderer -> main.
   */
  viewerCommandReply: 'aios:viewer/commandReply',
  /**
   * TODO 1061 (3): what this window's ViewerPane currently has in front (`ViewerShownReport`) changed. renderer -> main,
   * only when it changes. main uses it only for the "showing" mark of the gateway's `listOpenFiles` (the values are re-validated).
   */
  viewerReportShown: 'aios:viewer/reportShown',
  /**
   * TODO 1338 (review Y): after this window's viewer restore of a conversation has settled, ask main for the `openDiff` that waited
   * for that conversation (`PendingViewerDiff | null`). main hands it only to a window that shows that conversation now.
   */
  viewerPendingDiff: 'aios:viewer/pendingDiff',
  /** TODO 1338 (review Y): this window showed the waiting diff of that generation. main stops keeping it (unless a newer one replaced it). */
  viewerPendingDiffShown: 'aios:viewer/pendingDiffShown',
  /**
   * The reply to main's `viewerDraftsRequest` ("line up the drafts / finish writing them" before closing a window or quitting, TODO 606).
   * renderer -> main. `id` is the request number, the value is `ViewerDraftsReply` (main re-validates it).
   */
  viewerDraftsReply: 'aios:viewer/draftsReply',
  /**
   * Received the `save` of `viewerDraftsRequest` (code-review of TODO 606). renderer -> main, once before starting to write. The value is
   * the list of drafts about to be written (the shape of `ViewerDraftsReply`, only URIs and conflict marks). After receiving it, main waits longer for the writing to finish.
   */
  viewerDraftsAck: 'aios:viewer/draftsAck',
  /**
   * The ViewerPane closed / switched a URI (review D-3). Returns the read access granted by `viewerOpen` and the
   * `aios-res://` token. renderer -> main, once per URI switch.
   */
  viewerClose: 'aios:viewer/close',
  /**
   * The ViewerPane closed completely (TODO 673, a fix from code-review, the first half of serious item 7). Detaches the watcher for external rewrites
   * (`ViewerFileWatcher`) for this window. A new one-way notice, separate from the probe of 471 (`viewer.open` -> immediately `viewer.close`,
   * the same channel as `viewerClose`). Does not throw and does not wait for a reply.
   */
  viewerUntrackWatch: 'aios:viewer/untrackWatch',
  /**
   * Help (TODO 1174, 7.4.13). Resolves a `help://` URI to a bundled file and returns the body. It does not go through `FsAccess` and
   * grants no read access to anything (the host passes the body to the viewer as a temporary view).
   */
  helpOpen: 'aios:help/open',
  /**
   * Change history (Release Notes, TODO 1186). main reads and returns the bundled `CHANGELOG.md` (the path is known only to main; no network).
   * `open` = the full text, `takeAuto` = on the first launch after an update the section of the current version (null if already shown), `autoGet` / `autoSet` = the setting.
   */
  releaseNotesOpen: 'aios:releaseNotes/open',
  releaseNotesTakeAuto: 'aios:releaseNotes/takeAuto',
  releaseNotesAutoGet: 'aios:releaseNotes/autoGet',
  releaseNotesAutoSet: 'aios:releaseNotes/autoSet',
  // TODO 1266 / 1270: start at login and keep the computer awake while scheduled jobs wait.
  osSettingsGet: 'aios:osSettings/get',
  osSettingsSetOpenAtLogin: 'aios:osSettings/setOpenAtLogin',
  osSettingsSetPreventSleep: 'aios:osSettings/setPreventSleep',
  osSettingsSetMenuBar: 'aios:osSettings/setMenuBar',
  /** Candidates for "open with another viewer" (TODO 907). No access is granted (it only returns names). */
  viewerChoices: 'aios:viewer/choices',
  /** Make the chosen viewer the default for that extension (TODO 907). main re-checks that it is among the candidates. */
  viewerChoose: 'aios:viewer/choose',
  /** The list of per-extension viewer defaults (TODO 907, the settings screen). */
  viewerAssociations: 'aios:viewer/associations',
  /** Remove a per-extension viewer default (TODO 907, `null` = all). */
  viewerAssociationReset: 'aios:viewer/associations/reset',
  // Wave 14 bundle B: the settings editor's "default value and current value" (item 187). Read only.
  settingsSnapshot: 'aios:settings/snapshot',
  // ---- Restoring deleted threads (item 191) ----
  /** The list of deleted ones (the fold at the bottom of the SideBar). Most recently deleted first. */
  threadListDeleted: 'aios:thread/listDeleted',
  /** Undo a logical deletion. */
  threadRestore: 'aios:thread/restore',
  /** TODO 1155: where a `thread://` link is (`ThreadLinkLocation`). */
  threadLocateLink: 'aios:thread/locateLink',
  // Wave 14 bundle M: transcription of voice input (item 226, 4.5.10). The renderer's WAV -> main -> the helper.
  voiceTranscribe: 'aios:voice/transcribe',
  // Wave 29 bundle D: the recognition language of voice input (TODO 626). A setting separate from the display language; the only writer is main.
  voiceLocaleGet: 'aios:voice/locale/get',
  voiceLocaleSet: 'aios:voice/locale/set',
  gmailDraftFontGet: 'aios:gmailDraftFont/get',
  gmailDraftFontSet: 'aios:gmailDraftFont/set',
  // Wave 64 bundle A: export and import of threads and settings (TODO 1088, 8.6). The renderer passes only the passphrase.
  dataExport: 'aios:data/export',
  dataImport: 'aios:data/import',
  // Wave 17 bundle B: the latest usage-limit values (item 317, 12.2). One for the whole app.
  usageGet: 'aios:usage/get',
  // Wave 26 bundle B: the state of the connection to the model (TODO 525). One for the whole app.
  connectionGet: 'aios:connection/get',
  // Wave 17 bundle F: attach an image from the clipboard (item 319, 4.5). The renderer passes no value; main reads it.
  pasteImage: 'aios:paste/image',
  // Wave 50 (TODO 957): capture part of the screen and attach it. The only argument is a boolean for Option (do not hide aios's windows).
  pasteCapture: 'aios:paste/capture',
  pasteCaptureHeadsUp: 'aios:paste/captureHeadsUp',
  pasteCaptureHeadsUpShown: 'aios:paste/captureHeadsUpShown',
  // Wave 18 bundle A: scheduled runs (TODO 323). List, add, update, delete, run now. All of them return the full list.
  scheduleList: 'aios:schedule/list',
  scheduleCreate: 'aios:schedule/create',
  scheduleUpdate: 'aios:schedule/update',
  scheduleRemove: 'aios:schedule/remove',
  scheduleRunNow: 'aios:schedule/runNow',
  // TODO 628: a reserved resume after the usage limit lifts (use scheduleRemove to cancel).
  scheduleReserveResume: 'aios:schedule/reserveResume',
  // TODO 989: the Composer's "send later" (use scheduleRemove to cancel).
  scheduleReserveLater: 'aios:schedule/reserveLater',
  scheduleRetryLater: 'aios:schedule/retryLater',
  scheduleTakeLater: 'aios:schedule/takeLater',
  // TODO 1265: a reminder's snooze (set / cancel). Both return the whole list.
  scheduleSnooze: 'aios:schedule/snooze',
  schedulePluginListOpen: 'aios:schedule/pluginListOpen',
  scheduleCancelSnooze: 'aios:schedule/cancelSnooze',
  // TODO 972: roles (shown as "Teammates"). List, add, update, delete. All of them return the full list.
  roleList: 'aios:role/list',
  roleCreate: 'aios:role/create',
  roleUpdate: 'aios:role/update',
  roleRemove: 'aios:role/remove',
  // TODO 1288: move an existing conversation under a Teammate / take it out (null).
  roleMoveThread: 'aios:role/moveThread',
  // TODO 982 / 1292 item 2: a Teammate's drill - start one, read its list of stopped operations, allow the ticked ones from now on.
  drillStart: 'aios:drill/start',
  drillReport: 'aios:drill/report',
  drillGrant: 'aios:drill/grant',
  // TODO 1216: the list of triggers and editing rules.
  triggerList: 'aios:trigger/list',
  triggerUpdate: 'aios:trigger/update',
  // Wave 21 bundle A: the ViewerPane's web view (TODO 400, 5.2.1). The destination is only the view of the calling window.
  webLoad: 'aios:web/load',
  webSetBounds: 'aios:web/setBounds',
  webSetVisible: 'aios:web/setVisible',
  webSetShortcuts: 'aios:web/setShortcuts',
  webReload: 'aios:web/reload',
  webStop: 'aios:web/stop',
  webFocus: 'aios:web/focus',
  webFind: 'aios:web/find',
  webStopFind: 'aios:web/stopFind',
  webClose: 'aios:web/close',
  // Wave 26 bundle A: the web tabs, history, Favorites and the three windows of the Sidebar (TODO 522, 5.2.1). Tabs belong to the calling window.
  webTabs: 'aios:web/tabs',
  webNewTab: 'aios:web/tabs/new',
  webActivateTab: 'aios:web/tabs/activate',
  webCloseTab: 'aios:web/tabs/close',
  webHistoryList: 'aios:web/history/list',
  webHistoryRemove: 'aios:web/history/remove',
  webHistoryClear: 'aios:web/history/clear',
  webFavoritesList: 'aios:web/favorites/list',
  // code-review (TODO 722): host -> return the map of favicon data URLs in one go (do not carry them per row).
  webFaviconsList: 'aios:web/favicons/list',
  webFavoriteAdd: 'aios:web/favorites/add',
  webFavoriteRemove: 'aios:web/favorites/remove',
  webFavoriteMove: 'aios:web/favorites/move',
  webSectionsGet: 'aios:web/sections/get',
  webSectionsSet: 'aios:web/sections/set',
  // TODO 676 (wave 31 bundle C): import Chrome bookmarks.
  webChromeProfiles: 'aios:web/chrome/profiles',
  webChromeImport: 'aios:web/chrome/import',
  // TODO 723 (wave 34 bundle B): the icon of the user's Chrome.app (not bundled).
  webChromeIcon: 'aios:web/chrome/icon',
  // Wave 27 bundle B: rewriting links in answers (TODO 553, Slack).
  webResolveLink: 'aios:web/resolveLink',
  // Wave 27 bundle B: certificate exceptions for internal https (TODO 547).
  webCertificateStatus: 'aios:web/certificates/status',
  webTrustCertificate: 'aios:web/certificates/trust',
  webTrustedCertificates: 'aios:web/certificates/list',
  webRevokeCertificate: 'aios:web/certificates/revoke',
  // TODO 1055 (2): confirming and revoking consent for the AI reading the body of a Web tab (the approval section of settings).
  webTabReadConsentGet: 'aios:web/tabReadConsent/get',
  webTabReadConsentRevoke: 'aios:web/tabReadConsent/revoke',
  // Wave 33 bundle B: delete login information of the Web view (cookies and site storage) (TODO 697).
  webLoginSitesList: 'aios:web/login/list',
  webLoginSitesClear: 'aios:web/login/clear',
  webLoginSitesClearAll: 'aios:web/login/clearAll',
  // Wave 23 bundle C: ASCII input in search fields (TODO 463, 4.5.11). The focus notice is a send (no answer), the setting is get / set.
  inputAsciiForSearch: 'aios:input/asciiForSearch',
  inputAsciiGet: 'aios:input/ascii/get',
  inputAsciiSet: 'aios:input/ascii/set',
  // Wave 28 bundle D: auto-save of the viewer (TODO 555, 5.2.2). One for the whole app; the writer is main.
  autoSaveGet: 'aios:viewer/autoSave/get',
  autoSaveSet: 'aios:viewer/autoSave/set',
  // Wave 30 bundle C: the number of days for folding the thread list (TODO 659, 4.3). One for the whole app; the writer is main.
  threadCollapseGet: 'aios:thread/collapseOldAfterDays/get',
  threadCollapseSet: 'aios:thread/collapseOldAfterDays/set',
  // Wave 43 bundle C: the order of the file tree (TODO 872, 5.6). One for the whole app; the writer is main.
  fileSortGet: 'aios:fs/sortOrder/get',
  fileSortSet: 'aios:fs/sortOrder/set',
  // Wave 44 bundle A: the Redmine base URL (TODO 811, 5.1). One for the whole app; the writer is main.
  // Wave 47 bundle C: the search field's history (TODO 900). The writer is main.
  searchHistoryGet: 'aios:search/history/get',
  searchHistoryAdd: 'aios:search/history/add',
  searchHistoryRemove: 'aios:search/history/remove',
  searchHistoryClear: 'aios:search/history/clear',
  redmineGet: 'aios:web/redmine/get',
  redmineSet: 'aios:web/redmine/set',
  // Wave 27 bundle E: keyboard shortcut assignments (TODO 549, 5.5.2). One for the whole app; the writer is main.
  keybindingsGet: 'aios:keybindings/get',
  keybindingsSet: 'aios:keybindings/set',
  /** The registration result of the global hotkey (item 1 of TODO 976). The settings screen queries it. */
  keybindingsGlobalStatus: 'aios:keybindings/globalStatus',
  /** Only while a key is being recorded in the settings screen, stop this window's menu accelerators (`setIgnoreMenuShortcuts`). */
  keybindingsRecording: 'aios:keybindings/recording',
  // Wave 28 bundle G: auto-update (TODO 103, ARCHITECTURE 8.5). The writer is main (`UpdateService`).
  updateStatus: 'aios:update/status',
  updateCheck: 'aios:update/check',
  updateInstall: 'aios:update/install',
  updateRestart: 'aios:update/restart',
  updateSetAuto: 'aios:update/setAuto',
  updateDismissNotice: 'aios:update/dismissNotice',
  // TODO 1333: unsaved drafts carried over an idle restart (the window's answer to a collect request, and the hand-back at the next launch)
  updateSubmitDrafts: 'aios:update/submitDrafts',
  updateTakeCarriedDrafts: 'aios:update/takeCarriedDrafts',
  // Wave 36 bundle D: the update of the backend (agent CLI) itself (TODO 774, ARCHITECTURE 4.6.6). The writer is main (`AgentUpdateService`).
  agentUpdateStatus: 'aios:agentUpdate/status',
  agentUpdateRun: 'aios:agentUpdate/run',
  agentUpdateRevert: 'aios:agentUpdate/revert',
  agentUpdateSetAuto: 'aios:agentUpdate/setAuto',
  agentUpdateDismissNotice: 'aios:agentUpdate/dismissNotice',
  // Wave 99 bundle C: automatic backup and restore (TODO 1306, ARCHITECTURE 8.7). The writer is main (`BackupService`).
  backupStatus: 'aios:backup/status',
  backupSetPassphrase: 'aios:backup/setPassphrase',
  backupRunNow: 'aios:backup/runNow',
  backupChooseDir: 'aios:backup/chooseDir',
  backupResetDir: 'aios:backup/resetDir',
  backupDismissNotice: 'aios:backup/dismissNotice',
  backupRestore: 'aios:backup/restore',
  backupKeepCurrent: 'aios:backup/keepCurrent'
} as const

/**
 * Operations conveyed from a menu item to the renderer (T27).
 *
 * **For a menu item with an accelerator, electron eats the key first**, so the `keydown` of Cmd+B
 * does not reach the renderer. So "it was pressed" is sent from main to the window.
 * The destination is **only the one focused window** (the sidebar of the window being looked at is folded).
 */
export type MenuCommand =
  | 'toggleSidebar'
  /** Hide / show ViewerPane (Alt+Cmd+B / Ctrl+Alt+B, TODO 1327; VS Code's Toggle Secondary Side Bar). */
  | 'toggleViewer'
  /**
   * Open a mode of the leftmost icon bar and focus inside it (item 195, wave 14 bundle D). Ctrl+Cmd+I / Cmd+Shift+E are
   * accelerators, so they work even if the viewer (OOPIF) has focus. "Search" is only a menu item, and
   * the Cmd+Shift+F key is caught by the renderer's keydown (`shortcuts.ts`).
   */
  | 'showThreads'
  | 'showFiles'
  | 'showSearch'
  /** Open the extension view (Cmd+Shift+X / Ctrl+Shift+X, TODO 367). It is an accelerator, so it works even if the viewer has focus. */
  | 'showExtensions'
  /** Open settings (Cmd+, / Ctrl+,, item 195). */
  | 'openSettings'
  /**
   * New thread (TODO 408, Cmd+Shift+O / Ctrl+Shift+O). Opens the create dialog. It is an accelerator, so it works even if
   * the viewer (OOPIF) has focus. The same action as the button at the top of the Activity Bar.
   */
  | 'newThread'
  /**
   * "File" > "Save" (Cmd+S / Ctrl+S, item 313). If the viewer has a draft, `ViewerPane` saves it
   * (the same as the "Save" button in the heading). It is an accelerator, so it works even if the viewer (OOPIF) has focus.
   */
  | 'save'
  /**
   * The viewer's back / forward (TODO 369, wave 20 bundle D). Not a menu item: a gesture the window received
   * (macOS `swipe`, Windows / Linux `app-command` `browser-backward` / `browser-forward`) is sent by
   * main to **that window**. Keys and the mouse (on a Mac) are caught by the renderer itself.
   */
  | 'viewerBack'
  | 'viewerForward'
  /**
   * "Close" (Cmd+W, TODO 531). If a Web tab is in front, the renderer closes that tab; otherwise it closes the window
   * (`window.close()`). It is an accelerator, so it works even if a web page or the viewer (OOPIF) has focus.
   */
  | 'closeTabOrWindow'
  /** "Help > aios Help" (TODO 1174). Shows Help in the ViewerPane as a temporary view (the same as settings "About" and the ? of the Activity Bar). */
  | 'openHelp'
  /** "Help > Release Notes" (TODO 1186). Shows the bundled change history in the ViewerPane as a temporary view. */
  | 'openReleaseNotes'

/**
 * "A thread to open" that main deposits with a window (item 98 (c) / 36). If main `send`s right after opening a window,
 * it would be missed before the renderer's subscription, so main deposits it and only sends a signal, and the renderer subscribes in `init()` and
 * then comes to fetch it. **Every errand on the main side that wants a window to open a thread uses this entry point** (a drop on the Dock,
 * restoring windows at launch, a notification click, and so on).
 *
 * - `threadId`: have that thread selected. `created: true` means "just created now" (it may arrive before the
 *   list delivery, so the renderer accepts it as an empty timeline and then selects it). Omitted = an existing
 *   thread (read the timeline and select it).
 * - `draft` / `attach`: the body and attachments (`file:` URIs) of `aios://new` (TODO 976 stage 3, ARCHITECTURE 3.3). They are only placed in the
 *   Composer after opening, and **never sent**. Attachments are added with the same `attachUris` as a drop (main validates them again).
 * - `notice`: the reason part of it could not be placed although it was opened (the `cwd` of `aios://new` was dropped and the conversation has no owner; TODO 976 review).
 * - `reason`: the reason it could not be opened (a string containing a reason code, shown with `describeReason`).
 */
export type OpenRequest =
  | {
      readonly threadId: string
      readonly created?: boolean
      readonly draft?: string
      readonly attach?: readonly string[]
      /** TODO 1267: start dictation in the Composer once it is shown (the dictation hotkey). Does nothing if already recording. */
      readonly dictate?: boolean
      /** The reason the conversation was opened but part of it could not be placed (such as `cwd` dropped at the choke point and opened with no owner. Shown in the band). */
      readonly notice?: string
    }
  | { readonly reason: string }
  /** TODO 1265: a reminder's notification was clicked - open the scheduled-run view and that job's editor (where the snooze buttons are). */
  | { readonly scheduleJobId: string }

/** Channel names for push-style messages from main -> renderer. */
export const IpcEvent = {
  /** A menu item was pressed (`MenuCommand`). The destination is only the focused window. */
  menuCommand: 'aios:app/menu',
  scanStatus: 'aios:fs/scanStatus:changed',
  fileChanges: 'aios:fs/changes',
  /** Events batched every 16 ms (5.1 / spike 8). */
  threadEvents: 'aios:thread/events',
  /** The whole thread list (item 75). Only at launch, creation, deletion and rename. */
  threadsChanged: 'aios:thread/list:changed',
  /** Only one thread changed (item 75). High-frequency triggers use this. */
  threadChanged: 'aios:thread/item:changed',
  approvalsChanged: 'aios:approval/list:changed',
  /** Index build progress ("show progress in the UI" of 6.2). */
  indexStatus: 'aios:search/status:changed',
  agentStatusChanged: 'aios:agent/status:changed',
  /** TODO 1282: the login recovery's phase changed (not every poll). */
  agentLoginRecoveryChanged: 'aios:agent/loginRecovery:changed',
  /** A plugin was enabled / disabled or its process state changed (7.1). */
  pluginsChanged: 'aios:plugin/list:changed',
  /** A notification from a plugin (the `ui` capability of 7.7). */
  pluginNotification: 'aios:plugin/notification',
  /** The plugin surfaces changed (TODO 1039 / 1038). Always sends the whole. */
  pluginSurfacesChanged: 'aios:plugin/surfaces:changed',
  /** The theme changed (a settings change, or the OS changed under `system`). */
  themeChanged: 'aios:theme/changed',
  /** The display language setting changed (7.4.4). */
  localeChanged: 'aios:locale/changed',
  /** The signal that an `OpenRequest` was deposited with this window (item 98 (c)). The contents are fetched with `threads.takeOpenRequest`. */
  openRequest: 'aios:thread/openRequest',
  /**
   * Open / close in the ViewerPane, or tell of a draft conflict (item 97, `ViewerCommand`).
   * From requests of the gateway's `openFile` / `closeFile` / write-type tools.
   * **The destination is only the window showing that thread**.
   */
  viewerRemote: 'aios:viewer/remote',
  /**
   * Before closing a window or quitting, ask it to line up / finish writing the unsaved drafts of that window's viewer (TODO 606,
   * `ViewerDraftsRequest`). **The destination is only the window being closed** (one at a time on quit). The reply is `viewerDraftsReply`.
   */
  viewerDraftsRequest: 'aios:viewer/drafts:request',
  /** The report of global-side MCP servers was rewritten (item 164). Each time a session starts in any thread. */
  mcpReportChanged: 'aios:mcp/report:changed',
  /**
   * The whole deleted list (item 222). On every delete / restore, to **all windows**. So that a
   * delete / restore in another window is reflected on the spot in this window, which has the fold open now.
   */
  deletedThreadsChanged: 'aios:thread/deleted:changed',
  /** "Show hidden files" changed (TODO 261). To **all windows** (one setting for the whole app). */
  hiddenFilesChanged: 'aios:fs/hidden:changed',
  /** Any setting value changed (the follow-up of TODO 1060 stage 3). To **all windows**. It has no contents; an open settings screen queries the snapshot again. */
  settingsChanged: 'aios:settings/changed',
  /** The viewer's auto-save setting changed (TODO 555). To **all windows** (one setting for the whole app). */
  autoSaveChanged: 'aios:viewer/autoSave:changed',
  /** The number of days for folding the thread list changed (TODO 659). To **all windows** (one setting for the whole app). */
  threadCollapseChanged: 'aios:thread/collapseOldAfterDays:changed',
  /** The order of the file tree changed (TODO 872). To **all windows** (one setting for the whole app). */
  fileSortChanged: 'aios:fs/sortOrder:changed',
  /** The Redmine base URL changed (TODO 811). To **all windows** (one setting for the whole app). */
  redmineChanged: 'aios:web/redmine:changed',
  /** The latest usage-limit values arrived (item 317). To **all windows** (one per account). */
  usageChanged: 'aios:usage/changed',
  /** The state of the connection to the model changed (TODO 525). To **all windows** (one for the whole app). */
  connectionChanged: 'aios:connection/changed',
  /** The list of scheduled runs changed (TODO 323). The whole list to **all windows**. */
  scheduleChanged: 'aios:schedule/changed',
  /** The list of roles (Teammates) changed (TODO 972). The whole list to **all windows**. */
  roleChanged: 'aios:role/changed',
  /** TODO 982: a drill recorded one more stopped operation (the thread id only). To **all windows**; the shown drill fetches its list again. */
  drillChanged: 'aios:drill/changed',
  /** The list of triggers changed (TODO 1216). The whole list to **all windows**. */
  triggerChanged: 'aios:trigger/changed',
  /** A notice from a web view (TODO 400, `WebViewEvent`). **The destination is only the window that has that view**. */
  webEvent: 'aios:web/event',
  /** A web tab changed (TODO 522, `WebTabsState`). **The destination is only the window that has that tab**. */
  webTabsChanged: 'aios:web/tabs:changed',
  /** History / Favorites changed (TODO 522, `WebDataChange`). To **all windows** (the contents are not carried; the receiver queries again). */
  webDataChanged: 'aios:web/data:changed',
  /** The keyboard shortcut assignments changed (TODO 549, `KeybindingOverrides`). To **all windows**. */
  keybindingsChanged: 'aios:keybindings/changed',
  /** The auto-update state changed (TODO 103, `UpdateStatus`). To **all windows** (one for the whole app). */
  updateChanged: 'aios:update/changed',
  /** TODO 1333: main asks this window for its unsaved drafts right before an idle restart (`CarriedDraftsRequest`); the answer goes back with `updateSubmitDrafts`. */
  updateCollectDrafts: 'aios:update/collectDrafts',
  /** The state of the backend's own update changed (TODO 774, `AgentUpdateStatus`). To **all windows**. */
  agentUpdateChanged: 'aios:agentUpdate/changed',
  /** The backup state changed (TODO 1306, `BackupStatus`). To **all windows**. */
  backupChanged: 'aios:backup/changed'
} as const

export type Unsubscribe = () => void

/** The whole API that the contextBridge exposes to the renderer. Anything not here is not handed over. */
export interface AiosApi {
  /**
   * Launch order (TODO 807, 3.1). The only part of the API the boot entry touches before the DB is open: `wait` resolves once every
   * other handler is registered, `painted` tells main the first frame is on screen.
   */
  readonly boot: {
    wait(): Promise<BootAnswer>
    painted(): void
  }
  readonly app: {
    getInfo(): Promise<AppInfo>
    /** TODO 1281: the log file being written and its folder, for the error notice. Both null when the file could not be opened. **Never throws.** */
    getLogInfo(): Promise<LogInfo>
    /** Counts the breakdown of the DB (heavy). Null on failure. */
    measureDatabase(): Promise<DbBreakdown | null>
    /**
     * Opens a URL in the OS default browser (mail client) (5.1 "external links").
     * Even if the renderer has already sorted it, **main always re-validates**.
     * `true` only when it was allowed and handed over. Both refusal and failure are `false` (the reason is in main's log).
     */
    openExternal(url: string): Promise<boolean>
    /**
     * TODO 967: opens a fixed pane of the system settings. The renderer cannot pass a URL, only `kind` (looked up in main's table).
     * `true` only when it opened. An unknown `kind` is refused (`false`).
     */
    openSystemSettings(kind: SystemSettingsKind): Promise<boolean>
    /**
     * TODO 967: restarts aios (to apply a permission change). If conversations are running, main shows a confirmation,
     * and if declined it does not restart and returns `false`.
     */
    relaunch(): Promise<boolean>
    /**
     * TODO 1327: the layout main keeps for this window (restored with the window, kept over a reload). The default for a new window.
     * **Never throws** (an unknown window gets the default).
     */
    windowLayout(): Promise<WindowLayout>
    /**
     * TODO 1327: report this window's layout after a change (fire and forget; main re-validates and checks the View menu items).
     * `viewerShown`: whether ViewerPane is on screen now — false when hidden by the user **or** folded to the strip of a narrow window.
     * It is not remembered with the layout; main mutes the window's Web pages while it is false and checks View > Viewer with it.
     */
    setWindowLayout(layout: WindowLayout, viewerShown: boolean): void
    /**
     * A menu item (such as Cmd+B) was pressed (T27). Delivered **only when this window is the destination**.
     * A substitute for accelerators whose `keydown` does not reach the renderer.
     */
    onMenuCommand(listener: (command: MenuCommand) => void): Unsubscribe
  }
  readonly fs: {
    /** The roots shown at the top of the sidebar (home and the main directories directly under it). */
    roots(): Promise<readonly FileEntry[]>
    /**
     * The listing directly under a directory. `options` can hide names starting with "." (TODO 261, display only). main and the index process
     * re-validate the values.
     */
    listDirectory(uri: string, options?: ListDirectoryOptions): Promise<DirectoryListing>
    /** Whether the file tree shows names starting with "." (TODO 261). */
    getShowHidden(): Promise<boolean>
    /** Toggles and saves it. `onShowHiddenChanged` reaches all windows. Returns the value after saving. */
    setShowHidden(show: boolean): Promise<boolean>
    onShowHiddenChanged(listener: (show: boolean) => void): Unsubscribe
    /**
     * File name search (6.6). A contiguous match of all words split by whitespace (AND), and it returns
     * the top `limit` hits + the total hit count + a report of truncation. The body is not searched.
     * If `cwdUri` (the active thread's working folder) is passed, the matches inside it are returned separated into the section
     * `FileSearchResult.cwd` (item 100). main validates it and ignores it if it does not pass.
     * If `scopeUri` (the Search screen's scope, TODO 437) is passed, **only inside that subtree** is returned in one section (`entries`), and
     * `cwd` is null. main and the index process validate it, and if it does not pass the result is 0 hits (it does not fall back to everything).
     */
    searchFiles(
      query: string,
      limit?: number,
      cwdUri?: string | null,
      scopeUri?: string | null
    ): Promise<FileSearchResult>
    stat(uri: string): Promise<FileEntry | null>
    getScanStatus(): Promise<ScanStatus>
    rescan(): Promise<void>
    /**
     * TODO 805: ends the delay of scanning and watching the protected folders (Desktop / Documents / Downloads) and includes them right now
     * ("Include now" in settings). It does not wait for the scan.
     */
    includeProtectedFolders(): Promise<void>
    /** The list of external storage (mounted + allowed). By default everything is excluded. */
    volumes(): Promise<readonly VolumeEntry[]>
    /**
     * Allows / revokes a volume. main re-validates the `/Volumes/<name>` form and
     * the mount state. It takes effect on the next full scan (while resident, a rescan starts immediately).
     * Returns the updated list.
     */
    setVolumeAllowed(uri: string, allowed: boolean): Promise<readonly VolumeEntry[]>
    /**
     * "Choose another folder..." (T5). main opens the OS dialog, and the chosen path is returned as a URI after
     * passing `assertAllowed`. Cancel is `uri: null, reason: null`.
     */
    pickDirectory(): Promise<DirectoryPick>
    /**
     * Resolves a link in the body (relative, no scheme, `file:`) to the URI of a file that can be opened (item 254).
     * main builds candidates in the order of the base (the folder of `baseUri`, or the thread's cwd if none) -> auto memory,
     * and checks the choke point (`assertAllowed`, read) and existence. **It does not throw**: a failure is the reason code in `reason`.
     */
    resolveLink(input: LinkResolveInput): Promise<LinkResolution>
    /**
     * Creates a new file / folder inside `parentUri` (TODO 370). If `name` contains `/`, the intermediate
     * folders are also created. main re-validates the name (`checkNewEntryName`), the choke point and realpath, and files are created with
     * `O_CREAT | O_EXCL | O_NOFOLLOW`. After creating, it also puts it in the index before answering (the tree diff arrives).
     * **It does not throw**: when refused, a reason code in `reason`.
     */
    createFile(parentUri: string, name: string): Promise<CreateEntryResult>
    createFolder(parentUri: string, name: string): Promise<CreateEntryResult>
    /**
     * Renames a row of the Files tree (TODO 1145). **Only within the same parent folder** (moving is separate). main re-validates the name
     * (`checkRenameName`), the choke points of both source and destination (`assertAllowed`), and that the destination does not exist. The index follows via the watcher.
     * **It does not throw**: when refused, a reason code in `reason`.
     */
    rename(uri: string, name: string): Promise<RenameEntryResult>
    /**
     * The icon of a `.app` (a macOS app bundle) as a PNG data URL (TODO 562). Called only for rows that are
     * visible. main re-validates the name, the choke point (read) and existence, and caches by path + mtime. **It does not throw**:
     * null if it cannot be obtained (the renderer keeps the folder icon).
     */
    appIcon(uri: string): Promise<string | null>
    /**
     * Drags rows of the Files tree to another app (a terminal, Finder, etc.) (TODO 677).
     * Call it right after `preventDefault` in `dragstart`: `event.sender.startDrag` must be called inside the renderer's
     * drag gesture. main passes each through `assertAllowed` (read) one by one and silently drops
     * those that fail. **It does not throw and does not wait for a reply** (fire-and-forget, `ipcRenderer.send`).
     */
    startDrag(uris: readonly string[]): void
    onScanStatus(listener: (status: ScanStatus) => void): Unsubscribe
    onFileChanges(listener: (batch: FileChangeBatch) => void): Unsubscribe
  }
  /** Threads (ARCHITECTURE.md 4.3 / 5.1). */
  readonly threads: {
    list(): Promise<readonly ThreadSummary[]>
    create(input: CreateThreadInput): Promise<Thread>
    /**
     * Creates a thread from dropped items (`file://` URIs) (item 98). A file is turned into its parent folder, and
     * if there are two or more folders it rejects with the reason code `drop-multiple-folders`.
     * `input` holds the creation-time values other than cwd (omitted means the defaults from settings).
     */
    createFromDrop(
      uris: readonly string[],
      input?: Omit<CreateThreadInput, 'cwdUri' | 'scratch'>
    ): Promise<Thread>
    /** Takes out the `OpenRequest` deposited with this window (null if none). */
    takeOpenRequest(): Promise<OpenRequest | null>
    /** The signal that an `OpenRequest` was deposited. When received, call `takeOpenRequest`. */
    onOpenRequest(listener: () => void): Unsubscribe
    /** Notifies that it was opened and clears unread. The process is not started yet (spike 10). */
    open(threadId: string): Promise<void>
    /**
     * Reports the whole set of threads whose Composer in this window has a draft (or attachment) (TODO 526). Call it only when the set
     * changes. main uses it only as material to exclude those threads from the automatic deletion of threads with neither input nor answer.
     */
    reportComposerDrafts(threadIds: readonly string[]): Promise<void>
    timeline(threadId: string): Promise<Timeline>
    /**
     * The process starts at the first send. An existing session is resumed.
     * **If a response is in progress it is queued** (item 94 / 4.5.4): it is sent from the front after the current turn ends.
     */
    send(threadId: string, input: SendInput): Promise<SendOutcome>
    /**
     * Interrupt (item 94, Cmd+Enter). If a response is in progress it stops the current turn (the process stays) and
     * sends this input ahead of queued ones. If no response is in progress, the same as `send`.
     */
    sendInterrupt(threadId: string, input: SendInput): Promise<SendOutcome>
    /**
     * Sends the last input again as it was (TODO 893, "send again" of the authentication-expired badge). The contents are only in main's
     * memory (not stored). If a response is in progress or an approval is pending, it is queued just like `send`. If nothing has been
     * sent yet in this launch, it is refused with `resend-unavailable`.
     */
    resendLast(threadId: string): Promise<SendOutcome>
    /**
     * TODO 908: opens macOS Terminal.app in the conversation's working folder and starts the CLI's interactive session ("open in terminal" of the
     * authentication-expired badge). main decides the cwd and the name to launch (only the conversation id is passed). It does not
     * type up to `/login`. If it cannot open, a reason code in `reason` (wording `reason.<code>`, 7.4.4). **It does not throw.**
     */
    openInTerminal(threadId: string): Promise<OpenInTerminalResult>
    /** Cancels a queued message (the chip's x). False if it has already been sent. */
    cancelReservation(threadId: string, reservationId: string): Promise<boolean>
    /** Takes a queued message off the queue and returns its contents (the chip's pencil, back into the input field). Null if it has already been sent. */
    takeReservation(threadId: string, reservationId: string): Promise<SendInput | null>
    /**
     * The stop button. Stops the response being generated **together with the process** (SIGINT, exit 0). The context stays, and the next send
     * resumes. Queued messages are not sent and remain (they start moving on the next send). Different from an interrupt (`sendInterrupt`).
     */
    interrupt(threadId: string): Promise<void>
    /** Stops the process. The thread remains, and the next send resumes. */
    stop(threadId: string): Promise<void>
    rename(threadId: string, title: string): Promise<void>
    /**
     * Marks as unread / read by hand (TODO 741). When the thread being displayed is marked unread, it stays
     * unread until you move elsewhere and come back (main's `manuallyUnread`).
     */
    setUnread(threadId: string, unread: boolean): Promise<void>
    /**
     * Deletes a thread (T19). If the scratch area (`~/aios/scratch/<id>`) has contents and there is no `force`, it
     * **deletes nothing** and returns `removed: false`. The renderer shows a confirmation there.
     */
    remove(threadId: string, options?: ThreadRemoveOptions): Promise<ThreadRemoveResult>
    setRetention(threadId: string, retention: ThreadRetention, days: number | null): Promise<void>
    /** Strict mode (T12 / 4.2). When true, every permission request that arrives is put in the inbox. */
    setApprovalStrict(threadId: string, strict: boolean): Promise<void>
    /**
     * OS sandbox (TODO 1106 / 4.2.4). When true, the backend is started with the sandbox enabled (if running, restarted on the next send).
     * If the backend does not have it, it cannot be turned ON (it can always be turned OFF).
     */
    setOsSandbox(threadId: string, on: boolean): Promise<void>
    /** Switches the automatic pick of a question's recommendation per conversation (TODO 1222). Default OFF. */
    setAutoPickRecommended(threadId: string, on: boolean): Promise<void>
    /**
     * Toggle of Plan mode (item 112 / 4.2.3). The value comes back in `ThreadRuntime.planMode`.
     * If the backend does not know Plan, it cannot be turned ON.
     */
    setPlanMode(threadId: string, on: boolean): Promise<void>
    /**
     * Writes the thread's ViewerPane memory (item 63). If `uri` is null it means "closed".
     * main silently drops a URI that hits the exclusion rules or one that is not `file:` (the memory does not change).
     */
    setViewerState(threadId: string, uri: string | null, highlight: string | null): Promise<void>
    /**
     * The viewer's back / forward history (TODO 772, the latest 50 steps per conversation). Null if none. It only reads and opens nothing
     * (reading the URL happens when back / forward is pressed).
     */
    viewerHistory(threadId: string): Promise<ViewerHistorySnapshot | null>
    /** Saves the history. main re-validates each step (exclusion rules, secrets, `about:blank`) and cuts at 50 steps. */
    setViewerHistory(threadId: string, snapshot: ViewerHistorySnapshot): Promise<void>
    /** TODO 1337 (11): reports the kinds whose workspace copy failed (names only, no values). It does not wait for a reply. */
    workspaceCopyFailed(threadId: string, kinds: readonly string[]): void
    /**
     * Preview of "rewind to here" (item 113, 4.5.6): what would change if the files were returned to the checkpoint just before the user's message
     * `eventId`. The reason it cannot be rewound is returned in `reason` (a reason code). While a response is in progress it rejects with
     * `rewind-busy`. **If no process is running, it is started by resume** (it costs a launch).
     */
    rewindPreview(threadId: string, eventId: string): Promise<RewindPreview>
    /**
     * "Rewind to here" (item 113): creates and returns a new thread branched from the state just before that message.
     * If `files` is true, the files are also restored (after the user accepts the preview). The original thread is untouched.
     */
    rewind(threadId: string, eventId: string, options: RewindOptions): Promise<Thread>
    /**
     * The estimate for "lighten and continue in a new conversation" (TODO 961). Estimated token counts of B (the fixed cost of a new conversation; null if unknown) and
     * S (the handoff text). No monetary amount is shown.
     */
    handoffEstimate(threadId: string): Promise<HandoffEstimate>
    /**
     * "Lighten and continue in a new conversation" (TODO 961): creates and returns a new thread that does not take over the original conversation. main attaches the text of the original thread's messages and
     * answers to the new thread's first send. If there are no messages to carry over, it rejects with `handoff-empty`.
     */
    handoff(threadId: string): Promise<Thread>
    /**
     * A model of another backend was chosen in the Composer's Model picker (TODO 1018, 4.6.1). If the thread has not sent a single message yet,
     * it switches `backend` in place and returns the same thread; if there is a conversation, it returns a new thread with `backend` switched, using the same handoff as 961
     * (tell them apart by id). No confirmation is shown.
     */
    switchBackend(threadId: string, backend: string, modelId: string | null): Promise<Thread>
    /**
     * Breakdown of context usage (item 155, 4.5.1). If a process is running it is queried on the spot,
     * otherwise it is the last breakdown main remembers (`fresh: false`; null if never obtained).
     * **No process is started for the breakdown.**
     */
    contextBreakdown(threadId: string): Promise<ContextBreakdownResult>
    /**
     * The list of conversations started in a terminal / VS Code (item 111, 4.5.9). Most recent first. The session_ids
     * that aios threads already have and subagent transcripts are not included. Ones that cannot be continued (the working folder hits the exclusion
     * rules / does not exist) are included with `usable: false`.
     */
    transcriptSessions(): Promise<readonly TranscriptSession[]>
    /**
     * The conversation a transcript hit of the conversation search (`uri` is `transcript://…`) points to. If an aios thread already has that
     * session_id, that thread goes in `threadId` (open it rather than continue). Null if none.
     */
    transcriptSession(uri: string): Promise<TranscriptSession | null>
    clearLog(threadId: string): Promise<void>
    /** "Delete all conversation logs" on the settings screen (4.3.1). */
    clearAllLogs(): Promise<void>
    /** Resolves an attachment from D&D / paste (4.5). */
    resolveAttachment(threadId: string, uri: string): Promise<AttachmentResolution>
    /**
     * The `aios-res://` URL for reading a sent image (an attachment pointing to a file, TODO 550) with `<img>`. Only when it has an image extension,
     * does not hit exclusions, and still exists. Otherwise null (only the name is shown).
     */
    attachmentImage(uri: string): Promise<string | null>
    /**
     * The `aios-res://` URL for reading a local image in an answer's Markdown (`![](/abs/x.png)`, relative to cwd, TODO 876) with `<img>`.
     * main resolves `src` in the conversation's working folder, and only what passes the choke point (exclusion, read scope), the image extension and
     * the leading magic bytes is accepted. Otherwise null (the renderer shows the alt).
     */
    timelineImage(threadId: string, src: string): Promise<string | null>
    /**
     * The material for saving a conversation as a PDF (TODO 818). From all rows (including the past part of a transcript), only the bodies of the user's messages and the parent's answers
     * are assembled into turns of one question and one answer. The body is already redacted.
     */
    exportTurns(threadId: string): Promise<ConversationExport>
    /**
     * Saves the assembled print HTML as a PDF (TODO 818). main asks for the destination in a dialog each time.
     * If closed, `{ saved: false }`; a failure is an exception with a reason code (`export-pdf-failed`).
     */
    savePdf(threadId: string, scope: ExportScope, html: string): Promise<SavePdfResult>
    /**
     * Saves the assembled HTML as a single-file `.html` (TODO 866). main reads the images in the body and embeds them as `data:`
     * (up to 5 MB per image and 25 MB in total; ones over the limit or unreadable get an "image omitted" note). The destination is asked in a dialog each time, as with PDF.
     * If closed, `{ saved: false }`; a failure is an exception with a reason code (`export-html-failed`).
     */
    saveHtml(threadId: string, scope: ExportScope, html: string): Promise<SavePdfResult>
    /**
     * Saves the assembled Markdown as `.md` (TODO 1014). It does not go through HTML. Images are only the `[image]` mark.
     * main applies `redactText` again before writing. If closed, `{ saved: false }`; a failure is a reason code (`export-md-failed`).
     */
    saveMarkdown(threadId: string, scope: ExportScope, markdown: string): Promise<SavePdfResult>
    /** Adds a directory to the thread's read scope via the approval inbox (4.4). */
    allowDir(threadId: string, dirUri: string): Promise<Thread>
    /** The choices of the create dialog (T5): backends, models, and the history of working directories. */
    createOptions(): Promise<ThreadCreateOptions>
    /**
     * Only the backend's feature table, model list and command list (item 88 / 68). Unlike `createOptions`, it does not
     * `stat` the 50 cwd history entries, so the Composer uses this.
     */
    backends(): Promise<readonly BackendChoice[]>
    /**
     * The previous page of the timeline (item 88). Returns up to `limit` rows with `seq < before`, taken from the newest side
     * (the default is one page of main), in oldest-first order. From the "read more" button.
     */
    timelineBefore(threadId: string, before: number, limit?: number): Promise<Timeline>
    /**
     * The first-time-folder notice (item 123, 4.3.2). Returned if there is anything that runs without confirmation (hooks / MCP servers).
     * Null = say nothing (not the first time / nothing there / an unusable folder). It does not stop creation.
     */
    folderNotice(cwdUri: string): Promise<FolderNotice | null>
    /**
     * The `cwdMatchKey` of the chosen folder (item 239). Null if it does not pass the choke point (excluded or nonexistent).
     * Compared with `TranscriptSession.cwdMatchKey` to narrow down "conversations of this folder".
     */
    folderMatchKey(cwdUri: string): Promise<string | null>
    removeCwdHistory(uri: string): Promise<void>
    clearCwdHistory(): Promise<void>
    /**
     * Reads the `tool_result` that is not stored from the canonical copy **only at display time** (4.3.1 / 12.7).
     * Null if it cannot be fetched.
     */
    toolResult(
      threadId: string,
      toolUseId: string
    ): Promise<{ text: string; bytes: number; truncated: boolean } | null>
    onEvents(listener: (batch: AiosEventBatch) => void): Unsubscribe
    /** The whole list (item 75). Delivered only at launch, creation, deletion and rename. */
    onChanged(listener: (threads: readonly ThreadSummary[]) => void): Unsubscribe
    /**
     * Only one thread changed (item 75). Replace by `thread.id` and fix the order by `thread.updatedAt`
     * (main's list is newest first by `updated_at`).
     */
    onItemChanged(listener: (summary: ThreadSummary) => void): Unsubscribe
    /**
     * The list of deleted ones (item 191). Most recently deleted first. Only the fold "Deleted (N)" at the bottom of the SideBar
     * calls it (it is not placed on the settings screen). The retention period is unlimited.
     */
    listDeleted(): Promise<readonly DeletedThreadSummary[]>
    /**
     * Whole-list delivery of the deleted list (item 222). A delete / restore in another window is also reflected in this window's fold.
     * The frequency is low, so it is a whole-list delivery (the same form as `onChanged`).
     */
    onDeletedChanged(listener: (items: readonly DeletedThreadSummary[]) => void): Unsubscribe
    /**
     * Undoes a logical deletion (item 191). An id that is not deleted or does not exist gives null.
     * Scratch-area files (T19) do not come back (only the row does).
     */
    restore(threadId: string): Promise<Thread | null>
    /**
     * Where a `thread://<threadId>/<eventId>` link is (TODO 1155). main re-validates the shape of the ids and returns whether the thread is missing /
     * logically deleted / the message is missing. If `eventId` is null, only the thread is looked at.
     */
    locateLink(threadId: string, eventId: string | null): Promise<ThreadLinkLocation>
  }
  /**
   * Turns a `File` dropped by D&D / paste into a URI (4.5).
   *
   * Electron removed `File.path`, so `webUtils` has to be called in the preload.
   * `File` is a DOM-only type and is not in main's tsconfig, so it is received as `unknown`.
   * **What is obtained here is only the URI, and the path never reaches the renderer** (the convention of chapter 7).
   */
  readonly drop: {
    uriFor(file: unknown): string
    /**
     * Passes the URIs of files dropped onto the viewer through main's choke point (`FsAccess.assertAllowed`, read) (TODO 366).
     * Those that pass are turned into Markdown links and inserted into the viewer (`shared/drop-link.ts`). Things under an exclusion and so on are refused with a reason code.
     */
    checkLinks(uris: readonly string[]): Promise<DropLinkCheck>
    /** Log of the viewer's drop path (TODO 407). No paths included. It does not wait for a reply. */
    trace(trace: DropTrace): void
  }
  /**
   * The attachment button (the clip, item 161). The `file://` URIs of the files chosen in the OS file picker (multiple allowed, a sheet
   * attached to the window). Cancel is an empty array. **Not validated here**: the returned URIs are passed one by one to
   * `threads.resolveAttachment`, as with a drop, and main re-validates them with `assertAllowed`
   * (excluded or unreadable ones are refused for the same reasons as a drop).
   */
  readonly attachments: {
    pick(): Promise<readonly string[]>
  }
  /** TODO 999: "recent files" (ARCHITECTURE.md 4.5.12). */
  readonly recent: {
    /** Newest first. Empty if the index does not answer. Attaching after choosing goes through `threads.resolveAttachment` (the same path as a drop). */
    list(options?: RecentListOptions): Promise<readonly RecentFile[]>
    thumbnail(uri: string): Promise<string | null>
    /** TODO 1172: the badge of recent files (at most 3, within 5 minutes, newest first). Empty if turned off in settings. Does not throw. */
    offers(): Promise<readonly RecentFile[]>
    /** The setting "suggest recent files" (the key stays `composer.screenshotOffer` from 999; default on). */
    getScreenshotOfferEnabled(): Promise<boolean>
    setScreenshotOfferEnabled(enabled: boolean): Promise<boolean>
  }
  /** Cross search (ARCHITECTURE.md 6.1). The two search windows are separated by scope. */
  readonly search: {
    /**
     * `seq` is a query number that increases monotonically per scope (P6). On the main side, a search with an old number
     * is returned as `stale: true` **without being executed**, so the caller discards it. The number is compared **per window**
     * (main attaches the webContents id, TODO 497), so each window may count from 1.
     * `cwdUri` applies only to in-File search and separates the hits inside it into `SearchResponse.cwd`
     * (item 100). It is ignored for conversation search.
     * `scopeUri` (the scope of TODO 437) applies only to in-File search and returns only the inside of that subtree as one section of `hits`
     * (no `cwd` section is made). If refused at the choke point, 0 hits.
     */
    query(
      query: string,
      scope: SearchScope,
      limit?: number,
      seq?: number,
      cwdUri?: string | null,
      scopeUri?: string | null
    ): Promise<SearchResponse>
    /**
     * In-thread search (TODO 496, ARCHITECTURE 6.1.1). Queries the conversation-search index narrowed to the thread `threadId` and
     * returns the ids of matching messages, oldest first. `seq` is a sequence separate from conversation search (Cmd+K) (P6), compared per window (TODO 497); if old, `stale`.
     */
    thread(query: string, threadId: string, seq?: number): Promise<ThreadSearchResponse>
    /**
     * When the scope (TODO 437) is decided, builds ahead the body-pending entries of that subtree (`buildSubtree` of item 249,
     * limit 2,000 documents and 10 seconds). Returns the number of body-pending entries remaining after it finishes. **Rejects if refused at the choke point**.
     */
    buildScope(uri: string): Promise<ScopeBuildResult>
    getStatus(): Promise<IndexStatus>
    /** Stops the index build. The position stays in the DB, so the next time it continues from there. */
    pause(): Promise<void>
    resume(): Promise<void>
    onStatus(listener: (status: IndexStatus) => void): Unsubscribe
  }
  /** The approval inbox (ARCHITECTURE.md 4.2). */
  readonly approvals: {
    list(): Promise<readonly ApprovalItem[]>
    decide(id: string, decision: ApprovalDecision): Promise<void>
    /**
     * Before and after of a pending write request (`ApprovalItem.diffable`) (item 97 / 7.6.4). main reads the target path
     * through the choke point. The renderer does not pass paths (only the request id).
     */
    diff(id: string): Promise<ApprovalDiff>
    onChanged(listener: (items: readonly ApprovalItem[]) => void): Unsubscribe
    /** The list of rules made with "always allow" (T12). Whole-app since T40 (`approval.rules` of `app_settings`). */
    rules(): Promise<readonly ApprovalRule[]>
    removeRule(id: string): Promise<void>
    /**
     * The table of what a scheduled job was allowed (TODO 983 stage 2, `roleKey` is `job:<jobId>`). Rows past their expiry are not included.
     * There is no way to add (the seeds come from the approval box).
     */
    roleGrants(roleKey: string): Promise<readonly RoleGrantView[]>
    /** Removes one row without confirmation. If it is not a row of `roleKey`, nothing is removed and false is returned. */
    removeRoleGrant(roleKey: string, id: string): Promise<boolean>
    /** The default allow list and the stop patterns (T12 / 4.2). */
    getPolicy(): Promise<ApprovalPolicy>
    setPolicy(patch: ApprovalPolicyPatch): Promise<ApprovalPolicySetResult>
  }
  /**
   * The viewer (ARCHITECTURE.md 5.2 / 7.4). **Moved over from direct fs calls in Phase 4.**
   * Reads and writes go through the CapabilityBroker in main and are left in the audit log.
   */
  readonly viewer: {
    /** Resolves the viewer for a URI. Read access is granted at the same time as resolving (7.2). */
    open(uri: string): Promise<ResolvedViewer | null>
    /**
     * Resolves the viewer of a temporary view (item 104) by the kind of contents. The renderer passes the contents
     * directly to the viewer, so main grants no file access.
     */
    openPayload(kind: TransientPayloadKind): Promise<ResolvedViewer | null>
    /**
     * Resolves the viewer of a temporary-view file (TODO 905, a file inside a zip) by the extension of the last name element. The renderer
     * passes the contents directly to the viewer, so main grants no file access (the same as `openPayload`).
     */
    openTransientFile(name: string): Promise<ResolvedViewer | null>
    /**
     * Turns the bytes of a temporary-view image (`.heic` / `.heif` inside a zip) into a JPEG for display (TODO 1162). A format Chromium cannot read is
     * converted by main with `sips`. main checks the type, size and OS, and it is left in the audit. A failure is returned as a reason, not a reject.
     */
    convertImageForDisplay(name: string, data: Uint8Array): Promise<ViewerImageConversion>
    /** The contents handed to the viewer. The Broker decides with the plugin ID attached. */
    read(pluginId: string, uri: string): Promise<ViewerResource>
    write(
      pluginId: string,
      uri: string,
      content: string,
      expectedMtimeMs: number | null
    ): Promise<TextWriteResult>
    /**
     * Calls a plugin-host command. Execution is inside the isolated process (7.8). A failure is returned as
     * `{ ok: false }`, not a reject (item 149).
     */
    command(pluginId: string, command: string, arg: unknown): Promise<ViewerCommandResponse>
    /**
     * An "open / close" from main (item 97). Delivered when the model calls the gateway's `openFile` / `closeFile`,
     * **if this window is showing that thread**. A notice of a draft conflict
     * (the latter half of item 97, `kind: 'draftConflict'`) arrives through the same path.
     */
    onCommand(listener: (command: ViewerCommand) => void): Unsubscribe
    /**
     * The URI of the current draft changed (the latter half of item 97). main remembers it as this window's "current draft" and
     * matches it against the target path of write-type tools by exact match after folding. `null` = no draft.
     */
    reportDraft(uri: string | null): Promise<void>
    /**
     * The count of this window's table of drafts (TODO 312, including unsaved drafts of files navigated away from) changed
     * (code-review of TODO 103). Only the count: neither body nor URI is sent. main uses it only as material to stop the idle restart.
     */
    reportStoredDrafts(count: number): Promise<void>
    /**
     * TODO 832 (1): returns how an "open" with `replyId` (`open` of `ViewerCommand`) was handled. main puts in the return value of the gateway's
     * `openFile` that the draft was protected and not replaced (`kept`).
     */
    replyCommand(replyId: string, outcome: ViewerCommandOutcome): Promise<void>
    /**
     * TODO 1061 (3): reports what this window's ViewerPane currently has in front (a file, the Web, a temporary view, or closed).
     * main uses it as material to put a "showing" mark on the gateway's `listOpenFiles`. `null` = no conversation is shown.
     */
    reportShown(report: ViewerShownReport | null): Promise<void>
    /**
     * TODO 1338 (review Y): the `openDiff` that came while no window showed `threadId`. Asked once this window's viewer restore of that
     * conversation has settled. Usually null (nothing waits; no body travels). main re-checks that this window shows `threadId` now.
     */
    pendingDiff(threadId: string): Promise<PendingViewerDiff | null>
    /**
     * TODO 1338 (review Y): the waiting diff of `generation` was shown. Until this arrives main keeps it, so a diff the window did not
     * show (the conversation changed meanwhile) appears the next time the conversation is opened.
     */
    pendingDiffShown(threadId: string, generation: number): Promise<void>
    /**
     * A request before closing a window or quitting (TODO 606). For `list` it returns the URIs of unsaved drafts, and for `save` what remained after writing everything out,
     * via `replyDrafts`.
     */
    onDraftsRequest(listener: (request: ViewerDraftsRequest) => void): Unsubscribe
    replyDrafts(id: number, reply: ViewerDraftsReply): Promise<void>
    /** Received the `save` request (before starting to write, code-review of TODO 606). `pending` is the drafts about to be written. */
    ackDrafts(id: number, pending: ViewerDraftsReply): Promise<void>
    /**
     * Closed a URI opened with `open` (review D-3). Returns the permission for "the URI the user has open now".
     * Called once, paired with `open`, when the URI is switched or the ViewerPane disappears.
     */
    close(pluginId: string, uri: string): Promise<void>
    /**
     * The ViewerPane closed completely (TODO 673, a fix from code-review). Detaches the watcher for external rewrites
     * (`ViewerFileWatcher`) for this window. Does not throw and does not wait for a reply. It is a different path from the probe of 471
     * (`open` -> immediately `close`), so it is not confused with the probe.
     */
    untrackWatch(): void
    /**
     * Candidates for "open with another viewer" (TODO 907, VS Code's Reopen Editor With...). It only returns names and grants no access.
     */
    choices(uri: string): Promise<ViewerChoices>
    /**
     * Makes the chosen viewer the default for that extension (TODO 907). main re-checks that it is among the candidates, and returns false if not.
     * Reopening is done by the renderer (ViewerPane), which calls `open` next.
     */
    choose(uri: string, pluginId: string): Promise<boolean>
    /** The list of per-extension viewer defaults (TODO 907, the settings screen). */
    associations(): Promise<readonly ViewerAssociationEntry[]>
    /** Resets to the default (TODO 907). If `ext` is null, all of them. Returns the list after the reset. */
    resetAssociation(ext: string | null): Promise<readonly ViewerAssociationEntry[]>
  }
  /** The plugin foundation (ARCHITECTURE.md chapter 7). */
  readonly plugins: {
    list(): Promise<readonly PluginSummary[]>
    setEnabled(pluginId: string, enabled: boolean): Promise<void>
    /**
     * TODO 1144 stage 2: updates one extension to the version of the latest Release (8.5.1). Waits until it finishes. In progress / failure is shown in
     * `PluginSummary.update` (a fetch or validation failure does not throw). A case that cannot be updated or does not work throws with a reason code.
     */
    update(pluginId: string): Promise<void>
    /**
     * TODO 1144 stage 3: the bulk "update all" (8.5.1). Updates the bundled extensions that can be updated (an update exists and the assets are there, or the previous one failed) one at a time in order
     * by the same path as `update`, and waits until it finishes. Even if one fails the rest continue, and the result per extension is returned. The app's own version is not changed.
     * A case that does not work throws with a reason code (`update-unsupported`).
     */
    updateAll(): Promise<readonly PluginUpdateAllResult[]>
    /** The user's consent per capability (7.7). It can be revoked on the settings screen. */
    setConsent(pluginId: string, capability: CapabilityName, granted: boolean): Promise<void>
    /**
     * TODO 1233: uninstalls an external extension (7.2). The folder is moved to the trash, and that extension's trigger rules, setting values and
     * capability consents are removed. A bundled one throws `plugin-uninstall-bundled`, and if it cannot be removed `plugin-uninstall-failed`.
     */
    uninstall(pluginId: string): Promise<void>
    /** The latest N rows of the audit log (chapter 8). **No COUNT of all rows is taken.** */
    audit(limit?: number, pluginId?: string): Promise<readonly AuditEntry[]>
    /** Details of an extension view (TODO 367). Null for an unknown id. */
    detail(pluginId: string): Promise<PluginDetail | null>
    /** The current whole of the plugin surfaces (the sidebar list and sync progress) (TODO 1039 / 1038). */
    surfaces(): Promise<PluginSurfacesSnapshot>
    onSurfacesChanged(listener: (snapshot: PluginSurfacesSnapshot) => void): Unsubscribe
    /**
     * Queries a plugin section of the search sidebar (TODO 896). main drops the previous search of the same section in the same window (`cancelled`).
     * It does not throw: a failure is the reason code in `error`.
     */
    search(pluginId: string, query: string): Promise<PluginSearchResponse>
    onChanged(listener: (plugins: readonly PluginSummary[]) => void): Unsubscribe
    onNotification(
      listener: (notification: { pluginId: string; title: string; body: string | null }) => void
    ): Unsubscribe
  }
  /**
   * Color theme (7.4.1, T10). The value is one of `light` / `dark` / `system`, and
   * the resolution of `system` is held by main's `nativeTheme` (the renderer's
   * `prefers-color-scheme` is used only as insurance for the very first frame).
   */
  readonly theme: {
    get(): Promise<ThemeState>
    set(preference: ThemePreference): Promise<ThemeState>
    onChanged(listener: (state: ThemeState) => void): Unsubscribe
  }
  /**
   * Display language (7.4.4, TODO 66). The value is one of `en` / `ja` / `system`, and the resolution of `system` is held by
   * main (`app.getLocale()`). **main builds no wording**: only the name of the language is returned.
   */
  readonly locale: {
    get(): Promise<LocaleState>
    set(preference: LocalePreference): Promise<LocaleState>
    onChanged(listener: (state: LocaleState) => void): Unsubscribe
  }
  /**
   * The BottomBar's git information (5.6, TODO 51). cwd is the active thread's `cwdUri`.
   * main calls the real `git` after passing `assertAllowed`. Not under git, no `git`,
   * timeout and refusal are all `null` (the reason is not passed to the renderer). **It does not throw.**
   */
  readonly git: {
    status(cwdUri: string): Promise<GitStatus | null>
  }
  /**
   * Help (TODO 1174, ARCHITECTURE.md 7.4.13). `open` takes a URI such as `help://index?lang=ja`, and main reads and returns the bundled
   * HTML (the path is known only to main). Null for an unreadable or unknown URI. **It does not throw.**
   */
  readonly help: {
    open(uri: string): Promise<HelpDocument | null>
  }
  /**
   * Change history (TODO 1186). main reads and returns the bundled English `CHANGELOG.md`. Null if unreadable. **It does not throw.**
   */
  /**
   * Start at login (TODO 1266) and keep the computer awake while scheduled jobs wait (TODO 1270). Every call returns the state after the call;
   * a non-boolean argument changes nothing. **It does not throw.**
   */
  readonly osSettings: {
    get(): Promise<OsSettingsState>
    setOpenAtLogin(enabled: boolean): Promise<OsSettingsState>
    setPreventSleep(enabled: boolean): Promise<OsSettingsState>
    setMenuBar(enabled: boolean): Promise<OsSettingsState>
  }
  readonly releaseNotes: {
    /** The full text. */
    open(): Promise<ReleaseNotesDocument | null>
    /** The automatic display at launch. Only on the first launch after the version went up, it returns the current version's section and leaves a record that it was shown. */
    takeAuto(): Promise<ReleaseNotesDocument | null>
    /** The setting "open the change history after an update" (default on). */
    getAuto(): Promise<boolean>
    setAuto(enabled: boolean): Promise<boolean>
  }
  /**
   * Open in an external editor (item 115). main is the only writer of the setting (owner main,
   * `editor.id` of `app_settings`). For `open`, main re-validates the URI before launching
   * (`assertAllowed`). **It does not throw**: only a boolean for whether it opened (whether the process could be started).
   */
  readonly editor: {
    get(): Promise<EditorId>
    set(id: EditorId): Promise<EditorId>
    open(uri: string, options?: EditorOpenOptions): Promise<boolean>
    /**
     * Used only by the "open in external editor" of the band for links that could not be opened (`LinkNotice`) (TODO 808). Excluded places (except credentials,
     * other users' homes and volumes not allowed) are also handed to the external editor. **It does not throw**, only a boolean.
     */
    openHandoff(uri: string): Promise<boolean>
    /** Shows that file selected in Finder / Explorer (TODO 289). **It does not throw**, only a boolean. */
    reveal(uri: string, asDirectory?: boolean): Promise<boolean>
    /** Shows the log file currently being written, selected in Finder (TODO 376). **It does not throw**, only a boolean. */
    revealLogs(): Promise<boolean>
    /** Writes the problem report (masked logs + version) to a file and shows it in Finder (TODO 1308). **It does not throw**, only a boolean. */
    reportProblem(): Promise<boolean>
    /**
     * Opens with the OS default app (TODO 405). A path separate from the editor chosen in settings (`open`): a format such as `.avi` that
     * aios (Chromium) cannot play is requested here by the viewer (`aios.video`) via the host.
     * main re-validates the plugin (whether it is bundled) and the URI (the extension table and the choke point) and leaves it in the audit log (TODO 850). **It does not throw**, only a boolean.
     */
    openDefaultApp(uri: string, pluginId: string): Promise<boolean>
    /**
     * Opens with the OS default app from the host (aios's own UI) (TODO 1214). Used by the routing of the single "Open" button (`openRouteOf`) and
     * by the right-click "Open in default app". main re-validates the URI and the real file (after resolving symlinks) against `HOST_OPEN_DEFAULT_EXTENSIONS`,
     * and if it is not in the table or could not open, opens with the editor chosen in settings. **It does not throw**, only a boolean.
     */
    openInDefaultApp(uri: string): Promise<boolean>
  }
  /**
   * Desktop notifications ON/OFF (item 72). Default true. main is the only writer
   * (`notify.enabled` of `app_settings`).
   */
  readonly notifications: {
    getEnabled(): Promise<boolean>
    setEnabled(enabled: boolean): Promise<boolean>
  }
  /**
   * Global-side MCP servers (item 164, 4.6.4 "how it is shown"). The latest launch report of any thread, kept by
   * main (`mcp.lastGlobalReport` of `app_settings`). Read-only, with
   * no entry point for registering, switching or reconnecting (the policy of leaving it to the CLI, 4.6.4).
   */
  readonly mcp: {
    /** Null if no session has been started yet. */
    report(): Promise<McpGlobalReport | null>
    onReport(listener: (report: McpGlobalReport) => void): Unsubscribe
  }
  /** Skill management (TODO 773, ARCHITECTURE.md 4.5.3). Only main knows where they are kept. */
  readonly skills: {
    list(cwdUri: string | null): Promise<SkillListing>
    trash(request: SkillDeleteRequest): Promise<SkillDeleteResult>
    /** TODO 1099: the catalog of CLI plugins in the official marketplace (filtered by a word) and the list of installed plugins. */
    pluginCatalog(query: string): Promise<PluginCatalogResult>
    /** TODO 1099: have the CLI install it (aios does not write to the settings directory). */
    pluginInstall(name: string): Promise<PluginOpResult>
    /** TODO 1099: have the CLI remove it (`<name>@<marketplace>`, user scope only). */
    pluginUninstall(id: string): Promise<PluginOpResult>
  }
  /** The backend's state and settings (4.6 / 12.2). */
  readonly agent: {
    status(): Promise<AgentStatus>
    recheck(): Promise<AgentStatus>
    /** TODO 1019: the state of all backends in the registry. If `force` is true, detect again (also re-query Ollama's response). */
    backends(force: boolean): Promise<readonly BackendStatusRow[]>
    /**
     * TODO 1066: "recommendations for this PC" for local models. Null for a backend that has none or if there is no table.
     * `force` also re-examines the execution environment. It rewrites nothing.
     */
    localAdvice(backendId: string, force: boolean): Promise<LocalModelAdvice | null>
    /** TODO 1066: an operation that was pressed (fetching, creating a derived model with a context length). main re-validates `model` against the recommendation. **It does not throw.** */
    localAction(backendId: string, action: LocalModelAction, model: string): Promise<LocalModelActionResult>
    /** TODO 1066: only the running operations and their progress. It does not compute recommendations (queries to hardware and the runtime). For re-fetching every second. */
    localActivity(backendId: string): Promise<readonly LocalModelActivityRow[]>
    /** TODO 893: re-check only the login state (only the output of the public subcommand, constraint 2). If it changes, `onStatus` also arrives. */
    recheckLogin(): Promise<AgentStatus>
    /**
     * TODO 960: recovery from expired authentication. Runs the CLI's public subcommand (`auth login`) in Terminal, detects completion by polling every 3 seconds for up to 10 minutes (TODO 1282),
     * and resends the last input of the stopped thread exactly once. `threadId` is the source of the cwd (home if null).
     * Pressing again while waiting does not reopen Terminal. For API key users, `login-api-key`. **It does not throw.**
     */
    startLogin(threadId: string | null): Promise<OpenInTerminalResult>
    /** TODO 1282: the state of the recovery (main holds the only copy). */
    loginRecovery(): Promise<LoginRecoveryState>
    /** TODO 1282: cancel the wait (nothing is resent; the marks and "Send again" stay). False if it was not waiting. */
    cancelLogin(): Promise<boolean>
    /** TODO 1282: the guidance for unattended runs (null if the backend has none). Words for the screen only. */
    unattendedLoginGuide(): Promise<UnattendedLoginGuide | null>
    onLoginRecovery(listener: (state: LoginRecoveryState) => void): Unsubscribe
    /** The setting "open automatically when expired authentication is detected" (`auth.autoLogin` of `app_settings`, default on). */
    getAutoLogin(): Promise<boolean>
    setAutoLogin(enabled: boolean): Promise<boolean>
    getSettings(): Promise<SessionSettings>
    setSettings(patch: Partial<SessionSettings>): Promise<SessionSettings>
    onStatus(listener: (status: AgentStatus) => void): Unsubscribe
  }
  /** The settings editor (item 187, 5.8). The mark for "changed from the default", and the default value and current value for "reset to default". */
  readonly settings: {
    snapshot(): Promise<SettingsSnapshot>
    /** Any setting value changed (regardless of the source: the AI's `setSetting`, another window's settings screen, a menu, etc.). An open settings screen queries again. */
    onChanged(listener: () => void): Unsubscribe
  }
  /**
   * Voice input (item 226, 4.5.10, wave 14 bundle M). Given a 16 kHz / 16 bit / mono WAV, main transcribes it with
   * the macOS on-device recognition helper. **It does not throw** (a failure is a reason code). Audio is not stored.
   */
  /**
   * Export and import of threads and settings (TODO 1088, ARCHITECTURE 8.6, wave 64 bundle A). main opens the save / load dialogs
   * (paths do not reach the renderer). Only the passphrase is passed. **It does not throw** (a failure is a reason code).
   */
  readonly data: {
    export(passphrase: string): Promise<DataExportResult>
    import(passphrase: string): Promise<DataImportResult>
  }
  /**
   * Automatic backup and restore (TODO 1306, ARCHITECTURE 8.7). The passphrase goes one way only (it is never returned). The folder is chosen
   * with main's dialog (no path is sent). `restore` asks once with a native confirmation and restarts the app. **It does not throw** (reason codes).
   */
  readonly backup: {
    status(): Promise<BackupStatus>
    setPassphrase(passphrase: string): Promise<BackupActionResult>
    runNow(): Promise<BackupActionResult>
    chooseDir(): Promise<BackupActionResult>
    resetDir(): Promise<BackupActionResult>
    dismissNotice(): Promise<void>
    /**
     * `passphrase` only when the stored one cannot open the newest backup (`passphrase-needed` / `decrypt-failed`). It is used for this
     * restore only; the remembered passphrase is not changed.
     */
    restore(passphrase: string | null): Promise<BackupActionResult>
    /** After a restore that did not finish (`restore-incomplete`): keep the current database and resume backups. */
    keepCurrent(): Promise<BackupActionResult>
    onChanged(listener: (status: BackupStatus) => void): Unsubscribe
  }
  /** The font of Gmail draft bodies (TODO 1229). Owner is main, and this is the only writer. It takes effect from conversations started after the change. */
  readonly gmailDraftFont: {
    get(): Promise<GmailDraftFont>
    set(font: GmailDraftFont): Promise<GmailDraftFont>
  }
  readonly voice: {
    transcribe(wav: Uint8Array): Promise<VoiceTranscribeResult>
    /**
     * The recognition-language setting (TODO 626). Separate from the display language. `auto` is decided from the first of macOS's preferred languages
     * (main side, `resolveVoiceSpeechLocale`). Owner is main, and this is the only writer.
     */
    getLocale(): Promise<VoiceLocalePreference>
    setLocale(preference: VoiceLocalePreference): Promise<VoiceLocalePreference>
  }
  /**
   * The latest usage-limit values (5 hours / 7 days) (item 317, 12.2, wave 17 bundle B). One per account
   * for the whole app. Right after launch it is the previous record (with the time it was received), and null if never received.
   * A ratio against the plan's limits, not cost (item 165).
   */
  readonly usage: {
    get(): Promise<UsageSnapshot | null>
    onChanged(listener: (snapshot: UsageSnapshot) => void): Unsubscribe
  }
  /**
   * The state of the connection to the model (TODO 525, wave 26 bundle B). One for the whole app. The time of the latest connection failure (`api_retry`), or
   * null on success. It decides whether the BottomBar turns red (TODO 1171: `navigator.onLine` is not looked at). Not stored.
   */
  readonly connection: {
    get(): Promise<ConnectionStatus>
    onChanged(listener: (status: ConnectionStatus) => void): Unsubscribe
  }
  /**
   * The clipboard image (item 319, 4.5, wave 17 bundle F). When an image with no path (such as a screenshot) is
   * pasted with Cmd+V, main reads it with electron's `clipboard.read()` and makes it an image attachment (PNG preferred).
   * **It does not throw** (empty or too large is `paste-empty` / `paste-too-large`). `uri` is the mark `aios-clipboard:` and
   * does not point to a file. The name is provisional (`image.png`); the renderer renames it to a sequential name.
   */
  readonly paste: {
    image(): Promise<AttachmentResolution>
    /**
     * TODO 957: captures part of the screen as an image attachment (macOS only). If `keepWindows` is true, aios's windows are not hidden (Option).
     * **It does not throw**. A cancel with Esc is `capture-cancelled`, and no permission is `capture-permission`.
     */
    capture(keepWindows: boolean): Promise<AttachmentResolution>
    /**
     * TODO 1064: call it just before capturing. True only the first time (it guides the user that macOS will show one more confirmation after this; main writes the done mark).
     * Leaves time to read the band before capturing (only once). False the second time and later, on non-macOS, and when permission is denied.
     */
    captureHeadsUp(): Promise<boolean>
    /** Call it after showing the guidance band and leaving time to read it. main writes the done mark (it is not written by the query). */
    captureHeadsUpShown(): Promise<void>
  }
  /**
   * Scheduled runs (TODO 323, wave 18 bundle A). main is the only writer, and main re-validates the input
   * (shape, how the time is written, lower limit of the interval, working folder). If invalid, an exception with a reason code. All of them return the whole list.
   */
  readonly schedule: {
    list(): Promise<ScheduleOverview>
    create(input: ScheduledJobInput): Promise<ScheduleOverview>
    update(id: string, input: ScheduledJobInput): Promise<ScheduleOverview>
    remove(id: string): Promise<ScheduleOverview>
    /** Runs once without waiting for the schedule (the schedule's base is not moved). Refused if the previous run is still running. */
    runNow(id: string): Promise<ScheduleOverview>
    /**
     * TODO 1280: tells main which plugin's own list (sidebar view) this window shows now (`null` = none). While a list is shown, that plugin's "repeat while idle"
     * tasks may also run during a conversation (never closer together than a few minutes; main keeps the floor). Main re-checks the id and forgets it when the window closes.
     */
    setPluginListOpen(pluginId: string | null): Promise<void>
    /**
     * TODO 628: places a reservation to send `prompt` once to this thread at the specified time (resuming after the usage
     * limit lifts). The prompt is already a string built in the display language (main does not touch its wording).
     * It replaces the previous reservation of the same thread. Cancel with `remove(id)`.
     */
    reserveResume(threadId: string, prompt: string, at: number): Promise<ResumeReservation>
    /**
     * TODO 989: queues the body and attachments as a reservation to be sent once, as an ordinary send, to this thread at the specified time. Cancel with `remove(id)`.
     * If the time has passed, it is moved to now + 1 minute.
     */
    reserveLater(threadId: string, input: LaterInput): Promise<LaterSend>
    /** TODO 989: sends a reservation that could not be sent again (now + 1 minute). */
    retryLater(id: string): Promise<void>
    /** TODO 989: returns the contents of a reservation and removes the row (back into the input field). Null if none. */
    takeLater(id: string): Promise<LaterTaken | null>
    /** TODO 1265: notify again `minutes` from now (one of `REMINDER_SNOOZE_MINUTES`). Reminders only; replaces an earlier snooze. */
    snooze(id: string, minutes: number): Promise<ScheduleOverview>
    /** TODO 1265: cancel a reminder's pending snooze. */
    cancelSnooze(id: string): Promise<ScheduleOverview>
    onChanged(listener: (overview: ScheduleOverview) => void): Unsubscribe
  }
  /**
   * Roles, shown as "Teammates" (TODO 972, ARCHITECTURE 4.3.4). main is the only writer and re-validates the input (shape, working
   * folder). If invalid, an exception with a reason code. All of them return the whole list. A conversation is started under a role with
   * `threads.create({ roleId })`.
   */
  readonly roles: {
    list(): Promise<readonly Role[]>
    create(input: RoleInput): Promise<readonly Role[]>
    update(id: string, input: RoleInput): Promise<readonly Role[]>
    /** Deletes without confirmation. Its conversations stay, without a role. */
    remove(id: string): Promise<readonly Role[]>
    /**
     * TODO 1288: moves an existing conversation under a Teammate, or takes it out (`roleId` null). Only `threads.role_id` changes
     * (folder, Model and instructions of a running session are untouched; the Teammate's standing instructions apply from the next launch).
     * main re-checks the ids and refuses a running conversation and one started by a scheduled run / trigger (`role-move-busy` /
     * `role-move-unattended`). No confirmation. The list of conversations is pushed as usual.
     */
    moveThread(threadId: string, roleId: string | null): Promise<void>
    onChanged(listener: (roles: readonly Role[]) => void): Unsubscribe
  }
  /**
   * TODO 982 / 1292 item 2: a Teammate's drill (one run with every outward or irreversible operation stopped and recorded). main re-checks
   * every id. `start` returns the new conversation's id (with `jobId`, the job's prompt is sent at once; without, the person types it).
   * `report` is null for a conversation that is not a drill. `grant` takes only the ids of ops a person ticked; main adds the rows it
   * decided itself to the Teammate's table (`role:<id>`, `source: 'drill'`) and returns the new report.
   */
  readonly drills: {
    start(roleId: string, jobId: string | null): Promise<string>
    report(threadId: string): Promise<DrillReport | null>
    grant(threadId: string, opIds: readonly string[]): Promise<DrillReport | null>
    onChanged(listener: (threadId: string) => void): Unsubscribe
  }
  /**
   * Triggers (TODO 1216, 6.2.6). The list of triggers extensions declared, and the user's rules. main is the only writer, and main re-validates
   * the rules (shape, limits, working folder). If invalid, an exception with a reason code.
   */
  readonly trigger: {
    list(): Promise<TriggerOverview>
    /**
     * `acknowledged` is "the reason aios disabled it" the user saw (`TriggerRow.autoDisabled`). A rule changed by an extension is re-enabled
     * only when this equals main's current reason (fix X).
     */
    update(pluginId: string, triggerId: string, rule: TriggerRule, acknowledged?: TriggerAutoDisabled | null): Promise<TriggerOverview>
    onChanged(listener: (overview: TriggerOverview) => void): Unsubscribe
  }
  /**
   * The ViewerPane's web view (TODO 400, 5.2.1, wave 21 bundle A). The page is drawn in main's `WebContentsView` and
   * laid over this window's ViewerPane rectangle. One per window. main re-validates the URL with `isWebViewerUrl`.
   */
  readonly web: {
    /** Loads (creating the view if there is none). Refuses anything other than http(s) and returns false. */
    load(url: string): Promise<boolean>
    /** The rectangle to lay over (the renderer's CSS px). */
    setBounds(bounds: WebViewBounds): Promise<void>
    /** Show / hide. With `snapshot`, returns a copy from before hiding (a JPEG data URL). */
    setVisible(visible: boolean, snapshot: boolean): Promise<string | null>
    /** The table of keys to send back when the page has focus. */
    setShortcuts(table: readonly WebViewShortcut[]): Promise<void>
    reload(): Promise<void>
    stop(): Promise<void>
    focus(): Promise<void>
    find(request: WebFindRequest): Promise<void>
    stopFind(): Promise<void>
    /**
     * The pane was detached (switched to a file, another conversation, the shown tab was closed): main hides the views and keeps them
     * alive, and closes them if the pane does not come back within 10 minutes (TODO 580). There is no "close them all" request since
     * TODO 1326 removed the pane's close button.
     */
    close(): Promise<void>
    onEvent(listener: (event: WebViewEvent) => void): Unsubscribe
    // ---- Wave 26 bundle A: tabs, history, Favorites (TODO 522) ----
    /** This window's tabs (on the first query it takes over the memory of a previously closed window / of the last quit). */
    tabs(): Promise<WebTabsState>
    /** A new tab (to the right of the current tab, and it becomes the current tab). If `url` is null, a blank tab. It does not load (the renderer selects it). */
    newTab(url: string | null): Promise<WebTabsState>
    activateTab(id: string): Promise<WebTabsState>
    closeTab(id: string): Promise<WebTabsState>
    onTabsChanged(listener: (state: WebTabsState) => void): Unsubscribe
    /** History (newest first, up to 1,000 entries). */
    history(): Promise<readonly WebHistoryEntry[]>
    removeHistory(id: number): Promise<void>
    clearHistory(): Promise<void>
    favorites(): Promise<readonly WebFavorite[]>
    /** code-review (TODO 722): host -> the map of favicon data URLs, all in one call (shared by history and Favorites). */
    favicons(): Promise<WebFavicons>
    /** Adds to Favorites. False if the URL cannot be kept (a secret is visible) or the limit is reached. */
    addFavorite(url: string, title: string): Promise<boolean>
    /** Removes from Favorites (by id or URL). */
    removeFavorite(target: number | string): Promise<void>
    /** Reorders Favorites (move `id` to position `index`). */
    moveFavorite(id: number, index: number): Promise<void>
    onDataChanged(listener: (change: WebDataChange) => void): Unsubscribe
    /** The fold and height of the Sidebar's three windows (one for the whole app, `ui.webSections`). */
    sections(): Promise<WebSectionsLayout>
    setSections(layout: WebSectionsLayout): Promise<void>
    // ---- Wave 31 bundle C (TODO 676): import Chrome bookmarks ----
    /** The list of profiles (only those with Bookmarks, with display name and count). Null if Chrome is not found. */
    chromeProfiles(): Promise<readonly ChromeImportProfile[] | null>
    /** Imports the chosen profile into Favorites (appended at the end). Null if unreadable. */
    importChrome(profileDir: string): Promise<ChromeImportResult | null>
    /**
     * TODO 723: the icon (data URL) of the user's Chrome.app. main calls `app.getFileIcon` by the same mechanism as the `.app` icon of 562
     * (not bundled). Null if Chrome is missing or unreadable (the caller falls back to a generic icon).
     */
    chromeIcon(): Promise<string | null>
    // ---- Wave 27 bundle B (TODO 553) ----
    /**
     * Rewrites an answer's link before showing it in the ViewerPane (Slack's `/archives/<C>/p<ts>` -> a message on `app.slack.com`,
     * if the workspace ID is remembered). If nothing is rewritten, the original URL. Null if not http(s).
     */
    resolveLink(url: string): Promise<string | null>
    // ---- Wave 27 bundle B (TODO 547) ----
    /** Whether the certificate of a `url` that failed to load can be made an exception (if main remembers the certificate it had just refused). */
    certificateStatus(url: string): Promise<WebCertificateStatus>
    /** Trusts the certificate main had just refused for the host of `url` (only in the Web view's session). False if it is not remembered. */
    trustCertificate(url: string): Promise<boolean>
    /** The list of remembered exceptions (the settings screen). */
    trustedCertificates(): Promise<readonly TrustedCertificate[]>
    /** Revokes an exception. Returns the remaining list. */
    revokeCertificate(host: string): Promise<readonly TrustedCertificate[]>
    // ---- TODO 1055 (2) ----
    /** Whether consent has been given for the AI to read the body of an open Web tab. */
    tabReadConsent(): Promise<boolean>
    /** Revokes that consent (it will ask again next time it reads). Returns the state after revoking (false). */
    revokeTabReadConsent(): Promise<boolean>
    // ---- Wave 33 bundle B (TODO 697) ----
    /** The list of logged-in sites (hosts with cookies, per registrable domain). The settings screen. */
    loginSites(): Promise<readonly LoginSite[]>
    /** Deletes the login information of one site (cookies and site storage). Open tabs are reloaded. Returns the remaining list. */
    clearLoginSite(domain: string): Promise<readonly LoginSite[]>
    /** Deletes the login information of all sites. All open tabs are reloaded. */
    clearAllLoginSites(): Promise<readonly LoginSite[]>
  }
  /**
   * ASCII input in search fields (TODO 463, 4.5.11, wave 23 bundle C). The renderer only reports whether a search field of this window (including
   * those inside the viewer's iframe) has focus, and main decides whether to switch and when to switch back (does nothing on non-macOS, without the helper, or
   * when the setting is OFF). The setting (`input.asciiForSearch`, default true) has main as its only writer.
   */
  readonly input: {
    asciiForSearch(focused: boolean): void
    getAsciiForSearch(): Promise<boolean>
    setAsciiForSearch(enabled: boolean): Promise<boolean>
  }
  /**
   * The viewer's auto-save setting (TODO 555, 5.2.2, wave 28 bundle D). The same form as VS Code's `files.autoSave` / `files.autoSaveDelay`.
   * main only holds the setting; the clock and the save decision belong to the ViewerPane (writing is `viewer.write`).
   */
  readonly autoSave: {
    get(): Promise<AutoSaveSettings>
    /** Either field alone is fine. main validates and saves it, and notifies all windows. Returns the value after saving. */
    set(patch: Partial<AutoSaveSettings>): Promise<AutoSaveSettings>
    onChanged(listener: (settings: AutoSaveSettings) => void): Unsubscribe
  }
  /**
   * How many days of inactivity fold a row in the thread list (TODO 659, 4.3, wave 30 bundle C). Default 5 days, 0 = do not fold.
   * main only holds the setting; the staleness decision and the folding itself are in the renderer (`thread-sort.ts`).
   */
  /**
   * The Redmine base URL (TODO 811, 5.1). Used to turn ticket numbers in answers into links. https only, empty = unset.
   * main validates and saves it and notifies all windows (an unusable value is not saved, and the current value is returned).
   */
  readonly redmine: {
    get(): Promise<string>
    set(baseUrl: string): Promise<string>
    onChanged(listener: (baseUrl: string) => void): Unsubscribe
  }
  /** The search field's history (TODO 900). main holds it, newest first, up to 20 entries. The return value is the whole after the update. */
  readonly searchHistory: {
    get(): Promise<readonly SearchHistoryEntry[]>
    add(query: string, mode: SearchHistoryMode): Promise<readonly SearchHistoryEntry[]>
    remove(query: string, mode: SearchHistoryMode): Promise<readonly SearchHistoryEntry[]>
    clear(): Promise<readonly SearchHistoryEntry[]>
  }
  readonly fileSort: {
    get(): Promise<FileSortOrder>
    /** main ignores an unknown value and returns the current value. */
    set(order: FileSortOrder): Promise<FileSortOrder>
    onChanged(listener: (order: FileSortOrder) => void): Unsubscribe
  }
  readonly threadCollapse: {
    get(): Promise<number>
    /** main ignores a broken value and returns the current value. */
    set(days: number): Promise<number>
    onChanged(listener: (days: number) => void): Unsubscribe
  }
  /**
   * The user's assignments of keyboard shortcuts (TODO 549, 5.5.2, wave 27 bundle E). A diff of only the commands changed from the default.
   * main is the only writer; it validates before saving, notifies all windows, and rebuilds the menu.
   */
  readonly keybindings: {
    get(): Promise<KeybindingOverrides>
    /** Replaces the whole diff. Returns the value after validation. */
    set(overrides: KeybindingOverrides): Promise<KeybindingOverrides>
    /** The registration result of the global hotkey (`app.summon` / `app.summonDictate`) (item 1 of TODO 976). `failed` if it conflicts with another app. */
    globalStatus(): Promise<GlobalHotkeyStatuses>
    /** While keys are being recorded (true), stops this window's menu accelerators. */
    setRecording(recording: boolean): void
    onChanged(listener: (overrides: KeybindingOverrides) => void): Unsubscribe
  }
  /**
   * Auto-update (stage 1 of TODO 103, ARCHITECTURE 8.5, wave 28 bundle G). It updates without asking the user. This is the entry point for "Check for updates" on the settings screen,
   * the auto-update ON / OFF, showing the current and latest versions, and the BottomBar's "Updated".
   * A failure is the reason code in `UpdateStatus.failure` (not an exception). In a form where it does not work (such as a shell in development), `supported: false`.
   */
  readonly update: {
    status(): Promise<UpdateStatus>
    /** Checks the latest version (if auto-update is ON, it goes as far as fetching and staging the new version). Returns the state after it finishes. */
    check(): Promise<UpdateStatus>
    /** When auto-update is OFF, fetches and stages the new version. */
    install(): Promise<UpdateStatus>
    /** Restarts with the installed version. */
    restart(): Promise<void>
    setAuto(on: boolean): Promise<UpdateStatus>
    /** Dismisses "updated to version X" (all windows). */
    dismissNotice(): Promise<UpdateStatus>
    onChanged(listener: (status: UpdateStatus) => void): Unsubscribe
    /** TODO 1333: answer main's request for this window's unsaved drafts (right before an idle restart for an update). */
    onCollectDrafts(listener: (request: CarriedDraftsRequest) => void): Unsubscribe
    submitDrafts(requestId: string, reply: CarriedDraftsReply): Promise<void>
    /** TODO 1333: the drafts carried over the restart that started this launch (null if none). The first call deletes the stored copy. */
    takeCarriedDrafts(): Promise<CarriedDrafts | null>
  }
  /**
   * The update of the backend (agent CLI) itself (TODO 774, ARCHITECTURE 4.6.6, wave 36 bundle D). The entry point for "Update now" on the settings screen,
   * auto ON / OFF, "revert to the previous version", and the BottomBar's "Updated". A failure is the reason code in `AgentUpdateStatus.failure`
   * (not an exception). In a form where it does not work (a copy, dev, a fake backend), `supported: false`.
   */
  readonly agentUpdate: {
    status(): Promise<AgentUpdateStatus>
    /** Runs an update now. Returns the state after it finishes. */
    run(): Promise<AgentUpdateStatus>
    /** Reverts to the version before the update. Returns the state after it finishes. */
    revert(): Promise<AgentUpdateStatus>
    setAuto(on: boolean): Promise<AgentUpdateStatus>
    dismissNotice(): Promise<AgentUpdateStatus>
    onChanged(listener: (status: AgentUpdateStatus) => void): Unsubscribe
  }
  /**
   * The "Account" of the extension detail (TODO 952 stage 1 / items 1 and 2 of the remainder of 817). Whether there are, among the credentials a plugin declared, those main can handle logging in for
   * (Google), and loading the client's JSON, login and logout. **Not a single value is passed.** When the state changes,
   * `plugins.onChanged` is delivered again.
   */
  readonly pluginAccounts: {
    status(pluginId: string): Promise<readonly PluginAccountStatus[]>
    importClient(pluginId: string): Promise<PluginAccountResult>
    signIn(pluginId: string, credential: string): Promise<PluginAccountResult>
    cancelSignIn(pluginId: string, credential: string): Promise<PluginAccountResult>
    signOut(pluginId: string, credential: string): Promise<PluginAccountResult>
    /** TODO 1218: seals a fixed token (email address + token). The value is passed to main and never comes back. */
    saveToken(pluginId: string, credential: string, email: string, token: string): Promise<PluginAccountResult>
  }
  /**
   * The "Settings" of the extension detail (TODO 1225, 7.2.1). The fields of the manifest's `configuration` and their current values. main re-validates a save against the declaration and
   * refuses with `invalid-value` if it does not pass (it does not save part of it). The extension reads the new values from the next time it calls `aios.settings.get()`.
   */
  readonly pluginSettings: {
    get(pluginId: string): Promise<PluginSettingsView | null>
    /** Saves one field (fix X: other fields are not touched). */
    save(pluginId: string, name: string, value: PluginSettingValue): Promise<PluginSettingsView>
  }
}
