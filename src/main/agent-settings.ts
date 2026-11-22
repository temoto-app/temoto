/**
 * Entry point for the conversation's AI to read and change aios's own settings (TODO 1060 stage 1, ARCHITECTURE 7.6.8).
 *
 * The main-side body of the gateway's `getSettings` / `setSetting`. **Does not depend on electron** (tests drive it with a fake setter).
 *
 * - The exposed settings are the same set of names as the settings editor's "defaults and current values" (`SettingValues`, item 187). `CATALOGUE` is
 *   a mapped type that requires every field of `SettingValues`, so when the settings editor gains a field the type check
 *   forces this file to be updated (use `exposed: false` to leave it out). Any other key (secrets, consent records, internal state) has no name at all and is invisible.
 * - The classification (whether it goes to the approval inbox) lives in the key table (`AGENT_SETTING_ACCESS`, `src/common/settings-keys.ts`). A key missing from the table
 *   falls back to `gated`.
 * - **Values coming from the gateway are re-validated here** (treated like values from the renderer, Conventions). Anything outside the type, enum or range
 *   is refused rather than clamped, and the model gets the allowed values back.
 * - Changes go only through the **existing setters** (`apply`). Each setter is the writer of its key (owner, TODO 85), and the notifications to windows
 *   (theme, language, auto-save, list folding, sort order, Redmine, update) travel the same path. This file never touches `app_settings`.
 * - Asking the approval inbox is the caller's job (`gateway-requests.ts`). This file exposes "should we ask?" and "change after asking" separately.
 */
import {
  MAX_DEFAULT_MODEL_ID_LENGTH,
  MIN_IDLE_TIMEOUT_MS,
  isDefaultModelIdValue,
  type SettingValueKey,
  type SettingValues,
  type SettingsSnapshot
} from '@shared/settings.js'
import { THEME_PREFERENCES, isThemePreference } from '@shared/theme.js'
import { PRODUCT_NAME } from '@shared/product.js'
import { LOCALE_PREFERENCES, isLocalePreference } from '@shared/locale.js'
import { EDITOR_IDS, isEditorId } from '@shared/editor.js'
import {
  AUTO_SAVE_MODES,
  MAX_AUTO_SAVE_DELAY_MS,
  MIN_AUTO_SAVE_DELAY_MS,
  isAutoSaveMode
} from '@shared/auto-save.js'
import { VOICE_LOCALE_PREFERENCES, isVoiceLocalePreference } from '@shared/voice-locale.js'
import { GMAIL_DRAFT_FONTS, isGmailDraftFont } from '@shared/gmail-draft-font.js'
import {
  MAX_COLLAPSE_OLD_AFTER_DAYS,
  MIN_COLLAPSE_OLD_AFTER_DAYS,
  isCollapseOldAfterDays
} from '@shared/thread-collapse.js'
import { FILE_SORT_ORDERS, isFileSortOrder } from '@shared/file-sort.js'
import { normalizeRedmineBase } from '@shared/redmine-link.js'
import { THINKING_LEVELS, isThinkingLevel } from '@shared/agent.js'
import { MAX_SSH_HOSTS, normalizeSshHost, sanitizeSshHosts } from '@shared/ssh-hosts.js'
import { isKeybindingCommandId, normalizeKeybinding, sanitizeKeybindingOverrides } from '@shared/keybindings.js'
import { keyPlatformOfProcess } from './keybindings.js'
import { hostPlatform } from '../common/os/platform.js'
import {
  AGENT_UPDATE_AUTO,
  APPROVAL_AUTO_ALLOW_ALL,
  APPROVAL_FULL_DELEGATION,
  APPROVAL_AUTO_ALLOW_TOOLS,
  APPROVAL_BASH_DENY_PATTERNS,
  APPROVAL_SSH_ALLOWED_HOSTS,
  AUTH_AUTO_LOGIN,
  BUNDLE_MAX,
  BUNDLE_MAX_CAP,
  COMPOSER_SCREENSHOT_OFFER,
  RELEASE_NOTES_AUTO,
  APP_OPEN_AT_LOGIN,
  POWER_PREVENT_SLEEP,
  APP_MENU_BAR,
  DEFAULT_SESSION_SETTINGS,
  EDITOR_ID,
  INPUT_ASCII_FOR_SEARCH,
  NOTIFY_ENABLED,
  SESSION_SETTINGS,
  THREADS_COLLAPSE_OLD_AFTER_DAYS,
  UI_FILE_SORT_ORDER,
  UI_KEYBINDINGS,
  UI_LOCALE,
  UI_SHOW_HIDDEN_FILES,
  UI_THEME,
  UPDATE_AUTO,
  VIEWER_AUTO_SAVE,
  VIEWER_AUTO_SAVE_DELAY,
  VOICE_LOCALE,
  GMAIL_DRAFT_FONT,
  WEB_REDMINE_BASE_URL,
  agentSettingAccess,
  type AgentSettingAccess
} from '../common/settings-keys.js'

/** Result of validation. A refusal carries a fixed English sentence returned to the model (TODO 567). */
export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

interface CatalogueEntry<K extends SettingValueKey> {
  /** The key it is stored under (the classification, and the key name shown to the model). */
  readonly key: { readonly key: string }
  /** Description shown to the model (a fixed English sentence). */
  readonly description: string
  /** Description of the allowed values (English). */
  readonly allowed: string
  readonly check: (raw: unknown) => Checked<SettingValues[K]>
}

type Catalogue = { readonly [K in SettingValueKey]: CatalogueEntry<K> }

/** Cap on a string array (the approval defaults list). Comfortably larger than what a person lists by hand in the settings screen. */
export const MAX_LIST_ITEMS = 200
export const MAX_LIST_ITEM_LENGTH = 500

function ok<T>(value: T): Checked<T> {
  return { ok: true, value }
}

function fail<T>(error: string): Checked<T> {
  return { ok: false, error }
}

function oneOf<T extends string>(values: readonly T[], is: (raw: unknown) => raw is T): (raw: unknown) => Checked<T> {
  return (raw) => (is(raw) ? ok(raw) : fail(`must be one of: ${values.join(', ')}`))
}

function bool(raw: unknown): Checked<boolean> {
  return typeof raw === 'boolean' ? ok(raw) : fail('must be true or false')
}

function integerIn(min: number, max: number): (raw: unknown) => Checked<number> {
  return (raw) =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= min && raw <= max
      ? ok(raw)
      : fail(`must be an integer from ${min} to ${max}`)
}

function stringList(raw: unknown): Checked<readonly string[]> {
  if (!Array.isArray(raw)) return fail('must be an array of strings')
  if (raw.length > MAX_LIST_ITEMS) return fail(`must have at most ${MAX_LIST_ITEMS} items`)
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '' || item.length > MAX_LIST_ITEM_LENGTH) {
      return fail(`every item must be a non-empty string of at most ${MAX_LIST_ITEM_LENGTH} characters`)
    }
    out.push(item)
  }
  return ok(out)
}

/** The concurrency cap is a safety valve, not a value (derived from memory, spike 5). Settings cannot exceed it. */
const MAX_CONCURRENT_CAP = DEFAULT_SESSION_SETTINGS.maxConcurrentCap
/** The lower bound is shared with `SessionManager.setSettings` (`@shared/settings`). The upper bound is closed at one day (anything longer is meaningless). */
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000

const CATALOGUE: Catalogue = {
  theme: {
    key: UI_THEME,
    description: `Color theme of all ${PRODUCT_NAME} windows. system follows the macOS appearance.`,
    allowed: THEME_PREFERENCES.join(' | '),
    check: oneOf(THEME_PREFERENCES, isThemePreference)
  },
  locale: {
    key: UI_LOCALE,
    description: `Display language of the ${PRODUCT_NAME} interface. system follows the macOS language.`,
    allowed: LOCALE_PREFERENCES.join(' | '),
    check: oneOf(LOCALE_PREFERENCES, isLocalePreference)
  },
  editor: {
    key: EDITOR_ID,
    description: 'External editor used by "Open in editor".',
    allowed: EDITOR_IDS.join(' | '),
    check: oneOf(EDITOR_IDS, isEditorId)
  },
  notifyEnabled: {
    key: NOTIFY_ENABLED,
    description: 'Desktop notifications when a conversation finishes or needs an answer.',
    allowed: 'true | false',
    check: bool
  },
  autoLogin: {
    key: AUTH_AUTO_LOGIN,
    description: 'Open the login automatically when the login has expired.',
    allowed: 'true | false',
    check: bool
  },
  asciiForSearch: {
    key: INPUT_ASCII_FOR_SEARCH,
    description: 'Switch the keyboard to English input while a search field has focus.',
    allowed: 'true | false',
    check: bool
  },
  autoSave: {
    key: VIEWER_AUTO_SAVE,
    description: 'Auto save of files edited in the viewer pane.',
    allowed: AUTO_SAVE_MODES.join(' | '),
    check: oneOf(AUTO_SAVE_MODES, isAutoSaveMode)
  },
  autoSaveDelayMs: {
    key: VIEWER_AUTO_SAVE_DELAY,
    description: 'Delay before auto save when autoSave is afterDelay (milliseconds).',
    allowed: `integer ${MIN_AUTO_SAVE_DELAY_MS}..${MAX_AUTO_SAVE_DELAY_MS}`,
    check: integerIn(MIN_AUTO_SAVE_DELAY_MS, MAX_AUTO_SAVE_DELAY_MS)
  },
  autoUpdate: {
    key: UPDATE_AUTO,
    description: `Update ${PRODUCT_NAME} itself automatically.`,
    allowed: 'true | false',
    check: bool
  },
  agentAutoUpdate: {
    key: AGENT_UPDATE_AUTO,
    description: 'Update the coding agent command line tool automatically.',
    allowed: 'true | false',
    check: bool
  },
  voiceLocale: {
    key: VOICE_LOCALE,
    description: 'Recognition language of voice input. auto uses the first macOS preferred language.',
    allowed: VOICE_LOCALE_PREFERENCES.join(' | '),
    check: oneOf(VOICE_LOCALE_PREFERENCES, isVoiceLocalePreference)
  },
  gmailDraftFont: {
    key: GMAIL_DRAFT_FONT,
    description:
      'Body font of Gmail drafts the assistant creates. default says nothing; monospace tells the assistant to use an HTML body wrapped in a monospace element.',
    allowed: GMAIL_DRAFT_FONTS.join(' | '),
    check: oneOf(GMAIL_DRAFT_FONTS, isGmailDraftFont)
  },
  threadCollapseDays: {
    key: THREADS_COLLAPSE_OLD_AFTER_DAYS,
    description: 'Collapse conversations in the list that had no activity for this many days. 0 never collapses.',
    allowed: `integer ${MIN_COLLAPSE_OLD_AFTER_DAYS}..${MAX_COLLAPSE_OLD_AFTER_DAYS}`,
    check: (raw) =>
      isCollapseOldAfterDays(raw)
        ? ok(raw)
        : fail(`must be an integer from ${MIN_COLLAPSE_OLD_AFTER_DAYS} to ${MAX_COLLAPSE_OLD_AFTER_DAYS}`)
  },
  fileSortOrder: {
    key: UI_FILE_SORT_ORDER,
    description: 'Order of files in the file tree.',
    allowed: FILE_SORT_ORDERS.join(' | '),
    check: oneOf(FILE_SORT_ORDERS, isFileSortOrder)
  },
  redmineBaseUrl: {
    key: WEB_REDMINE_BASE_URL,
    description: 'Base URL of Redmine; issue numbers like #123 in answers link there. Empty string turns it off.',
    allowed: 'https URL without credentials, query or fragment, or ""',
    check: (raw) => {
      if (typeof raw !== 'string') return fail('must be a string')
      if (raw.trim() === '') return ok('')
      const normalized = normalizeRedmineBase(raw)
      return normalized === null
        ? fail('must be an https URL without credentials, query or fragment, or an empty string')
        : ok(normalized)
    }
  },
  screenshotOffer: {
    key: COMPOSER_SCREENSHOT_OFFER,
    description: 'Offer files created or changed in the last 5 minutes (up to 3) above the prompt box.',
    allowed: 'true | false',
    check: bool
  },
  releaseNotesAuto: {
    key: RELEASE_NOTES_AUTO,
    description: `Open the release notes of the new version once, the first time ${PRODUCT_NAME} starts after an update.`,
    allowed: 'true | false',
    check: bool
  },
  openAtLogin: {
    key: APP_OPEN_AT_LOGIN,
    description:
      `Start ${PRODUCT_NAME} automatically when you log in to the computer. Only a distributed (installed) build can do this; a development copy ignores it.`,
    allowed: 'true | false',
    check: bool
  },
  preventSleep: {
    key: POWER_PREVENT_SLEEP,
    description:
      'Keep the computer from sleeping on idle while an enabled scheduled job exists and the power cable is connected, so scheduled runs happen. The display may still turn off, and closing the lid still sleeps.',
    allowed: 'true | false',
    check: bool
  },
  menuBar: {
    key: APP_MENU_BAR,
    description: `Show ${PRODUCT_NAME} in the macOS menu bar (a small icon with a menu: show the window, new conversation, waiting approvals, quit). macOS only.`,
    allowed: 'true | false',
    check: bool
  },
  maxConcurrent: {
    key: SESSION_SETTINGS,
    description: 'How many conversations may run at the same time.',
    allowed: `integer 1..${MAX_CONCURRENT_CAP}`,
    check: integerIn(1, MAX_CONCURRENT_CAP)
  },
  idleTimeoutMs: {
    key: SESSION_SETTINGS,
    description: 'Stop the process of an idle conversation after this long (milliseconds). It resumes on the next message.',
    allowed: `integer ${MIN_IDLE_TIMEOUT_MS}..${MAX_IDLE_TIMEOUT_MS}`,
    check: integerIn(MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS)
  },
  defaultModelId: {
    key: SESSION_SETTINGS,
    description: 'Model preselected for new conversations. null uses the default of the agent.',
    allowed: `model id string (at most ${MAX_DEFAULT_MODEL_ID_LENGTH} characters) or null`,
    check: (raw) =>
      isDefaultModelIdValue(raw)
        ? ok(raw)
        : fail(`must be a model id string of at most ${MAX_DEFAULT_MODEL_ID_LENGTH} characters, or null`)
  },
  defaultThinking: {
    key: SESSION_SETTINGS,
    description: 'Thinking level preselected for new conversations. null uses the default of the agent.',
    allowed: `${THINKING_LEVELS.join(' | ')} | null`,
    check: (raw) =>
      raw === null || isThinkingLevel(raw) ? ok(raw) : fail(`must be one of: ${THINKING_LEVELS.join(', ')}, or null`)
  },
  autoAllowAll: {
    key: APPROVAL_AUTO_ALLOW_ALL,
    description: 'Allow every tool use without asking (stop patterns and actions that send things out still ask).',
    allowed: 'true | false',
    check: bool
  },
  autoAllowTools: {
    key: APPROVAL_AUTO_ALLOW_TOOLS,
    description: 'Tools allowed without asking when autoAllowAll is false.',
    allowed: `array of tool names (at most ${MAX_LIST_ITEMS})`,
    check: stringList
  },
  bashDenyPatterns: {
    key: APPROVAL_BASH_DENY_PATTERNS,
    description: 'Shell command patterns that always ask before running.',
    allowed: `array of patterns (at most ${MAX_LIST_ITEMS})`,
    check: stringList
  },
  // TODO 1175: gated (asks in the approval inbox on every change. This change asks even when full delegation is ON).
  fullDelegation: {
    key: APPROVAL_FULL_DELEGATION,
    description:
      'Full delegation: also allow actions that send or publish things, persistence writes, egress after reading a secret and side-effect tools without asking. Questions, requested plans, stop patterns and strict threads still ask.',
    allowed: 'true | false',
    check: bool
  },
  // TODO 1060 stage 3: keys that stage 1 did not expose.
  sshAllowedHosts: {
    key: APPROVAL_SSH_ALLOWED_HOSTS,
    description: 'Hosts that ssh / scp / sftp / rsync may connect to without asking (host or user@host).',
    allowed: `array of host or user@host (at most ${MAX_SSH_HOSTS})`,
    check: (raw) => {
      if (!Array.isArray(raw)) return fail('must be an array of host or user@host strings')
      if (raw.length > MAX_SSH_HOSTS) return fail(`must have at most ${MAX_SSH_HOSTS} items`)
      for (const item of raw) {
        if (typeof item !== 'string' || normalizeSshHost(item) === null) {
          return fail('every item must be host or user@host (letters, digits, . _ -; no spaces, slash or colon)')
        }
      }
      return ok(sanitizeSshHosts(raw))
    }
  },
  hiddenFiles: {
    key: UI_SHOW_HIDDEN_FILES,
    description: 'Show files and folders whose name starts with a dot in the file tree. Display only; search and indexing are unchanged.',
    allowed: 'true | false',
    check: bool
  },
  keybindings: {
    key: UI_KEYBINDINGS,
    description:
      'Keyboard shortcut overrides as an object { commandId: "Cmd+Shift+K" | null }. null turns the shortcut off; a command that is absent keeps its default. The whole object replaces the current overrides ({} restores every default).',
    allowed: 'object of known command id -> shortcut string or null',
    check: (raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('must be an object of command id -> shortcut or null')
      for (const [id, value] of Object.entries(raw)) {
        if (!isKeybindingCommandId(id)) return fail(`unknown command id: ${id.slice(0, 100)}`)
        if (value !== null && normalizeKeybinding(value) === null) return fail(`unreadable shortcut for ${id}`)
      }
      return ok(sanitizeKeybindingOverrides(raw, keyPlatformOfProcess(hostPlatform())))
    }
  },
  bundleMax: {
    key: BUNDLE_MAX,
    description: 'How many conversations started with startBundles may run at the same time (unfinished bundles plus the new one).',
    allowed: `integer 1..${BUNDLE_MAX_CAP}`,
    check: integerIn(1, BUNDLE_MAX_CAP)
  }
}

/** The list of names (in the order of the settings editor's fields). */
export const AGENT_SETTING_NAMES: readonly SettingValueKey[] = Object.keys(CATALOGUE) as SettingValueKey[]

function isSettingName(name: unknown): name is SettingValueKey {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(CATALOGUE, name)
}

/** Name -> classification. A key missing from the table falls back to `gated` (owner decision 2026-10-31). */
export function accessOf(name: SettingValueKey): AgentSettingAccess {
  return agentSettingAccess(CATALOGUE[name].key) ?? 'gated'
}

/** Whether the name is `gated` (an unknown name is false; the tool side refuses it). Used so the `approve` stage does not ask twice. */
export function isGatedSettingName(name: unknown): boolean {
  return isSettingName(name) && accessOf(name) === 'gated'
}

/**
 * Validation of the name for `openSettings` (TODO 1060 stage 2). Returns the setting name if it is in the table, otherwise a fixed English sentence for the model.
 * The set of names is the same as `getSettings` / `setSetting` (the keys of `SettingValues` = the `value` of a settings editor field).
 */
export function checkSettingName(name: unknown): Checked<SettingValueKey> {
  return isSettingName(name)
    ? ok(name)
    : fail(`unknown setting. Call getSettings for the names. Known: ${AGENT_SETTING_NAMES.join(', ')}`)
}

export interface AgentSettingView {
  readonly name: SettingValueKey
  readonly storageKey: string
  readonly value: unknown
  readonly default: unknown
  readonly allowed: string
  readonly description: string
  /** If true, every change needs the user's approval. */
  readonly changeNeedsApproval: boolean
}

/** Per-name setters (the existing entry points). Values are already validated. */
export type AgentSettingAppliers = { readonly [K in SettingValueKey]: (value: SettingValues[K]) => unknown }

export interface AgentSettingsDeps {
  /** Current values and defaults (the same `settingsSnapshot` as the settings editor). */
  readonly snapshot: () => SettingsSnapshot
  readonly apply: AgentSettingAppliers
  /** Called after a change (TODO 1060 stage 3: tells an open settings screen). Optional. */
  readonly onChanged?: (name: SettingValueKey) => void
}

/** Result of `prepare`. If `unchanged`, nothing happens (no question is asked). */
export interface PreparedSettingChange {
  readonly name: SettingValueKey
  readonly value: SettingValues[SettingValueKey]
  readonly previous: SettingValues[SettingValueKey]
  readonly access: AgentSettingAccess
  readonly unchanged: boolean
  /** One line for the approval inbox (a fixed English sentence + the value). */
  readonly summary: string
}

const SUMMARY_VALUE_MAX = 80

function shortJson(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null'
  return text.length > SUMMARY_VALUE_MAX ? `${text.slice(0, SUMMARY_VALUE_MAX - 1)}…` : text
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export class AgentSettings {
  constructor(private readonly deps: AgentSettingsDeps) {}

  /** Body of `getSettings`. If `names` is passed, only those are returned (unknown names are listed in `unknown`). */
  list(names?: readonly unknown[]): { readonly settings: readonly AgentSettingView[]; readonly unknown: readonly string[] } {
    const snapshot = this.deps.snapshot()
    const wanted = names === undefined || names.length === 0 ? AGENT_SETTING_NAMES : names.filter(isSettingName)
    const unknown =
      names === undefined ? [] : names.filter((name) => !isSettingName(name)).map((name) => String(name).slice(0, 100))
    const settings = wanted.map((name) => {
      const entry = CATALOGUE[name]
      return {
        name,
        storageKey: entry.key.key,
        value: snapshot.values[name],
        default: snapshot.defaults[name],
        allowed: entry.allowed,
        description: entry.description,
        changeNeedsApproval: accessOf(name) === 'gated'
      }
    })
    return { settings, unknown }
  }

  /** Validates, and works out whether to ask. Changes nothing. */
  prepare(rawName: unknown, raw: unknown): Checked<PreparedSettingChange> {
    const known = checkSettingName(rawName)
    if (!known.ok) return fail(known.error)
    const name = known.value
    const checked = (CATALOGUE[name].check as (raw: unknown) => Checked<SettingValues[SettingValueKey]>)(raw)
    if (!checked.ok) return fail(`invalid value for ${name}: ${checked.error}`)
    const previous = this.deps.snapshot().values[name]
    return ok({
      name,
      value: checked.value,
      previous,
      access: accessOf(name),
      unchanged: sameValue(previous, checked.value),
      summary: `Change the ${PRODUCT_NAME} setting ${name}: ${shortJson(previous)} → ${shortJson(checked.value)}`
    })
  }

  /** Changes through the existing setter, then re-reads and returns the value after the change (if the setter clamped it, that shows). */
  commit(change: PreparedSettingChange): { readonly name: SettingValueKey; readonly value: unknown; readonly previous: unknown } {
    // If the user changed it in the settings screen while approval was pending, do not silently overwrite it with the value from `prepare` time (that would lose e.g. array additions).
    if (!sameValue(this.deps.snapshot().values[change.name], change.previous)) {
      throw new Error('the setting changed while waiting for the approval. Call getSettings and ask again if it is still wanted')
    }
    ;(this.deps.apply[change.name] as (value: SettingValues[SettingValueKey]) => unknown)(change.value)
    this.deps.onChanged?.(change.name)
    return { name: change.name, value: this.deps.snapshot().values[change.name], previous: change.previous }
  }
}
