/**
 * Settings editor (item 187, ARCHITECTURE.md 5.8): "default values and current values".
 *
 * To mark "items changed from the default" on the settings screen and restore them with the gear menu's "reset to default",
 * main hands over each key's default value (`parse(null)` of each key in `src/common/settings-keys.ts`) and the current value in
 * one round trip. **No new write entry point is added** - restoring just passes the default value to the existing setters (theme, language,
 * editor, notifications, `agent.setSettings`, `approvals.setPolicy`), so
 * the `app_settings` owner rule (TODO 85) is still kept.
 */
import type { ThinkingLevel } from './agent.js'
import type { EditorId } from './editor.js'
import type { LocalePreference } from './locale.js'
import type { ThemePreference } from './theme.js'
import type { AutoSaveMode } from './auto-save.js'
import type { VoiceLocalePreference } from './voice-locale.js'
import type { GmailDraftFont } from './gmail-draft-font.js'
import type { FileSortOrder } from './file-sort.js'
import type { KeybindingOverrides } from './keybindings.js'

/** Setting values that can be reset to default. Per-thread ones (retention period, strict mode) are not included. */
export interface SettingValues {
  readonly theme: ThemePreference
  readonly locale: LocalePreference
  readonly editor: EditorId
  readonly notifyEnabled: boolean
  /** Open the login automatically when an auth expiry is detected (TODO 960). Default off. */
  readonly autoLogin: boolean
  /** Switch to ASCII input in the search box (TODO 463). */
  readonly asciiForSearch: boolean
  /** The viewer's auto-save (TODO 555). The same 3 values as VS Code's `files.autoSave`. */
  readonly autoSave: AutoSaveMode
  /** The wait time of `afterDelay` (ms, TODO 555). VS Code's `files.autoSaveDelay`. */
  readonly autoSaveDelayMs: number
  /** Auto-update (TODO 103). Default ON. */
  readonly autoUpdate: boolean
  /** Auto-update of the backend (agent CLI) itself (TODO 774). Default ON. */
  readonly agentAutoUpdate: boolean
  /** Recognition language of voice input (TODO 626). Separate from the display language. Default `auto` (the first of macOS's preferred languages). */
  readonly voiceLocale: VoiceLocalePreference
  /** Font of the body of Gmail drafts (TODO 1229). Default `default` (specifies nothing). */
  readonly gmailDraftFont: GmailDraftFont
  /** After how many idle days rows in the thread list are collapsed (TODO 659). Default 5, 0 = do not collapse. */
  readonly threadCollapseDays: number
  /** Sort order of the file tree (TODO 872). Default `modified` (newest first). */
  readonly fileSortOrder: FileSortOrder
  /** Redmine base URL (TODO 811). https only, empty = unset. */
  readonly redmineBaseUrl: string
  /** The new-screenshot badge above the Composer (TODO 999). Default on. */
  readonly screenshotOffer: boolean
  /** Open the new version's change history on the first launch after an update (TODO 1186). Default on. */
  readonly releaseNotesAuto: boolean
  /** Start the app at login (TODO 1266). Default off. The screen shows the OS's own state where it can be read. */
  readonly openAtLogin: boolean
  /** Prevent idle sleep while scheduled jobs wait and the machine is on AC power (TODO 1270). Default off. */
  readonly preventSleep: boolean
  /** Show the menu bar icon (TODO 1269, macOS only). Default off. */
  readonly menuBar: boolean
  readonly maxConcurrent: number
  readonly idleTimeoutMs: number
  readonly defaultModelId: string | null
  readonly defaultThinking: ThinkingLevel | null
  readonly autoAllowAll: boolean
  readonly autoAllowTools: readonly string[]
  readonly bashDenyPatterns: readonly string[]
  /** Full delegation mode (TODO 1175). Default off. */
  readonly fullDelegation: boolean
  /** Connection targets that are not asked about (TODO 1029, `host` / `user@host`). A dedicated list on the settings screen (no gear). Also an AI tool in TODO 1060 stage 3. */
  readonly sshAllowedHosts: readonly string[]
  /** The file tree's "show hidden files" (TODO 261). There is no item on the settings screen (the button / menu above the tree). */
  readonly hiddenFiles: boolean
  /** The user's keyboard shortcut assignments (TODO 549). Only the differences from the default. A dedicated table on the settings screen (no gear). */
  readonly keybindings: KeybindingOverrides
  /** The number of bundle conversations that can run at once (TODO 633 stage 3). There is no item on the settings screen. */
  readonly bundleMax: number
}

/**
 * Values without a "reset to default" gear on the settings screen (a dedicated component, or no item on the screen). All the keys that do not appear in `value` of `SETTINGS_ITEMS`,
 * and the correspondence between the settings editor's table and the value keys (`test/settings-editor.test.ts`) consults this list.
 */
export const SETTING_KEYS_WITHOUT_RESET = ['sshAllowedHosts', 'hiddenFiles', 'keybindings', 'bundleMax'] as const satisfies readonly (keyof SettingValues)[]

export type SettingValueKey = keyof SettingValues

/** The reply of `settings.snapshot`. */
export interface SettingsSnapshot {
  readonly values: SettingValues
  readonly defaults: SettingValues
}

/** Lower limit of the idle stop (1 minute). Anything shorter loses to the cost of waking it up again (about 21k tokens). Shared by `SessionManager.setSettings` and the agent's settings entry point. */
export const MIN_IDLE_TIMEOUT_MS = 60_000

/** Upper limit of the default model id's length. */
export const MAX_DEFAULT_MODEL_ID_LENGTH = 200

/** Whether it is a value usable as the default model id (a non-empty string of 200 characters or fewer, or null meaning "not chosen yet"). Shared by the settings screen's entry point and the agent's entry point. */
export function isDefaultModelIdValue(raw: unknown): raw is string | null {
  return raw === null || (typeof raw === 'string' && raw.trim() !== '' && raw.length <= MAX_DEFAULT_MODEL_ID_LENGTH)
}
