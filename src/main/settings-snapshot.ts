/**
 * The settings editor's "defaults and current values" (item 187, ARCHITECTURE.md 5.8).
 *
 * The defaults use each key's `parse(null)` (the value read when there is no value) as it is, so that the default
 * is not written twice in a place separate from `settings-keys.ts`. Independent of electron.
 * **This only reads.** Resetting is done by the renderer passing the default to the existing setter, so
 * the writers of `app_settings` (owners, TODO 85) do not increase.
 */
import type { SettingValues, SettingsSnapshot } from '@shared/settings.js'
import {
  APPROVAL_AUTO_ALLOW_ALL,
  APPROVAL_AUTO_ALLOW_TOOLS,
  APPROVAL_BASH_DENY_PATTERNS,
  APPROVAL_FULL_DELEGATION,
  EDITOR_ID,
  INPUT_ASCII_FOR_SEARCH,
  NOTIFY_ENABLED,
  SESSION_SETTINGS,
  UI_LOCALE,
  UI_THEME,
  THREADS_COLLAPSE_OLD_AFTER_DAYS,
  UI_FILE_SORT_ORDER,
  WEB_REDMINE_BASE_URL,
  COMPOSER_SCREENSHOT_OFFER,
  RELEASE_NOTES_AUTO,
  APP_OPEN_AT_LOGIN,
  POWER_PREVENT_SLEEP,
  APP_MENU_BAR,
  UPDATE_AUTO,
  AGENT_UPDATE_AUTO,
  AUTH_AUTO_LOGIN,
  VIEWER_AUTO_SAVE,
  VIEWER_AUTO_SAVE_DELAY,
  VOICE_LOCALE,
  GMAIL_DRAFT_FONT,
  APPROVAL_SSH_ALLOWED_HOSTS,
  UI_SHOW_HIDDEN_FILES,
  UI_KEYBINDINGS,
  BUNDLE_MAX
} from '../common/settings-keys.js'
import type { AutoSaveSettings } from '@shared/auto-save.js'

/** The default per key. */
export function settingDefaults(): SettingValues {
  const session = SESSION_SETTINGS.parse(null)
  return {
    theme: UI_THEME.parse(null),
    locale: UI_LOCALE.parse(null),
    editor: EDITOR_ID.parse(null),
    notifyEnabled: NOTIFY_ENABLED.parse(null),
    autoLogin: AUTH_AUTO_LOGIN.parse(null),
    asciiForSearch: INPUT_ASCII_FOR_SEARCH.parse(null),
    autoSave: VIEWER_AUTO_SAVE.parse(null),
    autoSaveDelayMs: VIEWER_AUTO_SAVE_DELAY.parse(null),
    autoUpdate: UPDATE_AUTO.parse(null),
    agentAutoUpdate: AGENT_UPDATE_AUTO.parse(null),
    voiceLocale: VOICE_LOCALE.parse(null),
    gmailDraftFont: GMAIL_DRAFT_FONT.parse(null),
    threadCollapseDays: THREADS_COLLAPSE_OLD_AFTER_DAYS.parse(null),
    fileSortOrder: UI_FILE_SORT_ORDER.parse(null),
    redmineBaseUrl: WEB_REDMINE_BASE_URL.parse(null),
    screenshotOffer: COMPOSER_SCREENSHOT_OFFER.parse(null),
    releaseNotesAuto: RELEASE_NOTES_AUTO.parse(null),
    openAtLogin: APP_OPEN_AT_LOGIN.parse(null),
    preventSleep: POWER_PREVENT_SLEEP.parse(null),
    menuBar: APP_MENU_BAR.parse(null),
    maxConcurrent: session.maxConcurrent,
    idleTimeoutMs: session.idleTimeoutMs,
    defaultModelId: session.defaultModelId,
    defaultThinking: session.defaultThinking,
    autoAllowAll: APPROVAL_AUTO_ALLOW_ALL.parse(null),
    autoAllowTools: APPROVAL_AUTO_ALLOW_TOOLS.parse(null),
    bashDenyPatterns: APPROVAL_BASH_DENY_PATTERNS.parse(null),
    fullDelegation: APPROVAL_FULL_DELEGATION.parse(null),
    sshAllowedHosts: APPROVAL_SSH_ALLOWED_HOSTS.parse(null),
    hiddenFiles: UI_SHOW_HIDDEN_FILES.parse(null),
    keybindings: UI_KEYBINDINGS.parse(null) as SettingValues['keybindings'],
    bundleMax: BUNDLE_MAX.parse(null)
  }
}

/** The entry points that read the current values (main's controllers). Tests pass fakes. */
export interface SettingsSnapshotSources {
  readonly theme: () => SettingValues['theme']
  readonly locale: () => SettingValues['locale']
  readonly editor: () => SettingValues['editor']
  readonly notifyEnabled: () => boolean
  readonly autoLogin: () => boolean
  readonly asciiForSearch: () => boolean
  readonly autoSave: () => AutoSaveSettings
  /** Auto-update (TODO 103). */
  readonly autoUpdate: () => boolean
  /** The backend's own auto-update (TODO 774). */
  readonly agentAutoUpdate: () => boolean
  /** The recognition language of voice input (TODO 626). */
  readonly voiceLocale: () => SettingValues['voiceLocale']
  /** The font of Gmail drafts (TODO 1229). */
  readonly gmailDraftFont: () => SettingValues['gmailDraftFont']
  /** Days after which the thread list folds (TODO 659). */
  readonly threadCollapseDays: () => SettingValues['threadCollapseDays']
  /** The order of the file tree (TODO 872). */
  readonly fileSortOrder: () => SettingValues['fileSortOrder']
  /** Redmine's base URL (TODO 811). */
  readonly redmineBaseUrl: () => SettingValues['redmineBaseUrl']
  /** The new-screenshot badge (TODO 999). */
  readonly screenshotOffer: () => boolean
  /** Open the change history after an update (TODO 1186). */
  readonly releaseNotesAuto: () => boolean
  /** Start at login (TODO 1266). */
  readonly openAtLogin: () => boolean
  /** Prevent idle sleep while jobs wait on AC power (TODO 1270). */
  readonly preventSleep: () => boolean
  /** Menu bar icon (TODO 1269). */
  readonly menuBar: () => boolean
  readonly session: () => Pick<
    SettingValues,
    'maxConcurrent' | 'idleTimeoutMs' | 'defaultModelId' | 'defaultThinking'
  >
  readonly approval: () => Pick<SettingValues, 'autoAllowAll' | 'autoAllowTools' | 'bashDenyPatterns'> & {
    /** Omitted = empty (`ApprovalPolicy.sshAllowedHosts` may be omitted). */
    readonly sshAllowedHosts?: SettingValues['sshAllowedHosts']
    /** Omitted = false (`ApprovalPolicy.fullDelegation` may be omitted, TODO 1175). */
    readonly fullDelegation?: boolean
  }
  /** "Show hidden files" (TODO 261). */
  readonly hiddenFiles: () => boolean
  /** The keyboard shortcut assignments (TODO 549). */
  readonly keybindings: () => SettingValues['keybindings']
  /** The number of a bundle's conversations that can run at once (TODO 633 stage 3). */
  readonly bundleMax: () => number
}

export function settingsSnapshot(sources: SettingsSnapshotSources): SettingsSnapshot {
  const session = sources.session()
  const approval = sources.approval()
  const autoSave = sources.autoSave()
  return {
    values: {
      theme: sources.theme(),
      locale: sources.locale(),
      editor: sources.editor(),
      notifyEnabled: sources.notifyEnabled(),
      autoLogin: sources.autoLogin(),
      asciiForSearch: sources.asciiForSearch(),
      autoSave: autoSave.mode,
      autoSaveDelayMs: autoSave.delayMs,
      autoUpdate: sources.autoUpdate(),
      agentAutoUpdate: sources.agentAutoUpdate(),
      voiceLocale: sources.voiceLocale(),
      gmailDraftFont: sources.gmailDraftFont(),
      threadCollapseDays: sources.threadCollapseDays(),
      fileSortOrder: sources.fileSortOrder(),
      redmineBaseUrl: sources.redmineBaseUrl(),
      screenshotOffer: sources.screenshotOffer(),
      releaseNotesAuto: sources.releaseNotesAuto(),
      openAtLogin: sources.openAtLogin(),
      preventSleep: sources.preventSleep(),
      menuBar: sources.menuBar(),
      maxConcurrent: session.maxConcurrent,
      idleTimeoutMs: session.idleTimeoutMs,
      defaultModelId: session.defaultModelId,
      defaultThinking: session.defaultThinking,
      autoAllowAll: approval.autoAllowAll,
      autoAllowTools: approval.autoAllowTools,
      bashDenyPatterns: approval.bashDenyPatterns,
      fullDelegation: approval.fullDelegation === true,
      sshAllowedHosts: approval.sshAllowedHosts ?? [],
      hiddenFiles: sources.hiddenFiles(),
      keybindings: sources.keybindings(),
      bundleMax: sources.bundleMax()
    },
    defaults: settingDefaults()
  }
}
