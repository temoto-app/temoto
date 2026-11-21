/**
 * The table and pure functions of the settings editor (item 187, ARCHITECTURE.md 5.8). Independent of electron and React.
 *
 * - The shape follows VS Code's settings editor: 1 item = title ("category: name") -> description -> control.
 * - The order of categories (`SETTINGS_CATEGORIES`) is the order of both the table of contents on the left and the body. The diagnostics info (`about`) comes last.
 * - Search filters by title (including the category), description, and the name of the storage key. It looks up **only the dictionary of the display language**
 *   (the same as VS Code; words from another language do not match).
 * - An item that can be reset to default has `value`. Whether it was changed from the default is `isModified`.
 * - **Per-thread settings (retention period, log deletion, strict mode) are not here**: they moved to the thread heading's
 *   ⋯ menu (`ThreadSettingsMenu`) (matching VS Code's User / Workspace split).
 */
import type { SettingValueKey, SettingValues } from '@shared/settings.js'

export const SETTINGS_CATEGORIES = [
  // Wave 28 bundle G: auto update (TODO 103). Corresponds to VS Code's Update. Moved to the top in TODO 1211.
  'update',
  // TODO 1266 / 1270: how the app starts and how it treats the computer (start at login, keep awake). Corresponds to VS Code's Application.
  'application',
  'appearance',
  // Collapsing of the thread list (TODO 659). No direct counterpart in VS Code (it matches Slack's "Show more").
  'threadList',
  // Order of the file tree (TODO 872). Corresponds to VS Code's Explorer: Sort Order.
  'explorer',
  'editor',
  // File display (the auto save of TODO 555). Corresponds to VS Code's Files: Auto Save.
  'viewer',
  'input',
  // Keyboard shortcuts (TODO 549). The list and editing that correspond to VS Code's Keyboard Shortcuts.
  'keyboard',
  'notifications',
  'sessions',
  'newThread',
  'approval',
  'workspace',
  'logs',
  'storage',
  'mcp',
  // TODO 773: list, delete and create CLI skills (next to "MCP").
  'skills',
  // Wave 27 bundle B: certificate exceptions for Web display (TODO 547).
  'web',
  // Wave 64 bundle A: export / import of threads and settings (TODO 1088). Corresponds to VS Code's Profiles: Export / Import.
  'dataTransfer',
  // The "Plugins" section was moved to the extension view (Activity Bar, ⌘⇧X) in TODO 367 (wave 20 bundle A).
  // The policy is to put plugin setting values on the settings screen side, but no plugin currently has setting values, so no section is made.
  'account',
  'about'
] as const

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]

export type SettingsItemId =
  | 'theme'
  | 'locale'
  | 'threadListCollapseDays'
  | 'fileSortOrder'
  | 'editor'
  | 'asciiForSearch'
  | 'screenshotOffer'
  | 'voiceLocale'
  | 'gmailDraftFont'
  | 'autoSave'
  | 'autoSaveDelay'
  | 'viewerAssociations'
  | 'keybindings'
  | 'notifyEnabled'
  | 'autoLogin'
  | 'unattendedAuth'
  | 'maxConcurrent'
  | 'idleTimeout'
  | 'defaultModel'
  | 'defaultThinking'
  | 'cliAllowNotice'
  | 'autoAllowAll'
  | 'fullDelegation'
  | 'autoAllowTools'
  | 'bashDenyPatterns'
  | 'alwaysAllowed'
  | 'sshAllowedHosts'
  | 'sandboxAllowedDomains'
  | 'sandboxAllowWrite'
  | 'cwdHistory'
  | 'clearAllLogs'
  | 'volumes'
  | 'protectedFolders'
  | 'mcpServers'
  | 'skills'
  | 'redmineBaseUrl'
  | 'trustedCertificates'
  | 'webTabReadConsent'
  | 'loginSites'
  | 'autoUpdate'
  | 'updateStatus'
  | 'releaseNotesAuto'
  | 'agentAutoUpdate'
  | 'agentUpdateStatus'
  | 'openAtLogin'
  | 'preventSleep'
  | 'menuBar'
  | 'dataTransfer'
  | 'accountUsage'
  | 'agentCli'

/**
 * How one item is laid out. `checkbox` puts the checkbox at the start of the description line, as in VS Code.
 * `control` puts a control (an input field, a select, a list) below the description.
 */
export type SettingsItemKind = 'checkbox' | 'control'

export interface SettingsItem {
  readonly id: SettingsItemId
  readonly category: SettingsCategory
  readonly kind: SettingsItemKind
  /** The value that can be reset to default. For list, action and info items it is null (no gear menu is shown). */
  readonly value: SettingValueKey | null
  /** The `app_settings` key (matched by search; corresponds to VS Code's setting ID). null if none. */
  readonly storageKey: string | null
}

function item(
  id: SettingsItemId,
  category: SettingsCategory,
  kind: SettingsItemKind,
  value: SettingValueKey | null,
  storageKey: string | null
): SettingsItem {
  return { id, category, kind, value, storageKey }
}

/** The order is the on-screen order as is. Items must be grouped by category in the order of `SETTINGS_CATEGORIES`. */
export const SETTINGS_ITEMS: readonly SettingsItem[] = [
  item('autoUpdate', 'update', 'checkbox', 'autoUpdate', 'update.auto'),
  item('updateStatus', 'update', 'control', null, null),
  // TODO 1186: open the changelog on the first launch after an update (default on). The value is held by main's `ReleaseNotesService`.
  item('releaseNotesAuto', 'update', 'checkbox', 'releaseNotesAuto', 'releaseNotes.auto'),
  // TODO 774: update of the agent CLI itself (at startup and once a day). The value is held by main's `AgentUpdateService`.
  item('agentAutoUpdate', 'update', 'checkbox', 'agentAutoUpdate', 'agentUpdate.auto'),
  item('agentUpdateStatus', 'update', 'control', null, null),
  // TODO 1266: start at login (default off, installed builds only; the OS's own state is shown). TODO 1270: keep the computer awake while scheduled jobs wait on AC power (default off).
  item('openAtLogin', 'application', 'checkbox', 'openAtLogin', 'app.openAtLogin'),
  item('preventSleep', 'application', 'checkbox', 'preventSleep', 'power.preventSleep'),
  // TODO 1269: the macOS menu bar icon (default off; greyed out on other systems).
  item('menuBar', 'application', 'checkbox', 'menuBar', 'app.menuBar'),
  item('theme', 'appearance', 'control', 'theme', 'ui.theme'),
  item('locale', 'appearance', 'control', 'locale', 'ui.locale'),
  // TODO 659: the number of days after which threads with no activity (5 days or more) are collapsed (0 = do not collapse).
  item('threadListCollapseDays', 'threadList', 'control', 'threadCollapseDays', 'threads.collapseOldAfterDays'),
  // TODO 872: order of the file tree (the default is newest first).
  item('fileSortOrder', 'explorer', 'control', 'fileSortOrder', 'ui.fileSortOrder'),
  item('editor', 'editor', 'control', 'editor', 'editor.id'),
  item('autoSave', 'viewer', 'control', 'autoSave', 'viewer.autoSave'),
  item('autoSaveDelay', 'viewer', 'control', 'autoSaveDelayMs', 'viewer.autoSaveDelay'),
  // TODO 907: the list of per-extension viewers (those chosen with "open with another viewer") and resetting to default.
  item('viewerAssociations', 'viewer', 'control', null, 'viewer.associations'),
  item('asciiForSearch', 'input', 'checkbox', 'asciiForSearch', 'input.asciiForSearch'),
  // TODO 999: the badge for a new screenshot above the Composer (default on).
  item('screenshotOffer', 'input', 'checkbox', 'screenshotOffer', 'composer.screenshotOffer'),
  // TODO 626: the recognition language of voice input. A setting separate from the display language.
  item('voiceLocale', 'input', 'control', 'voiceLocale', 'voice.locale'),
  item('keybindings', 'keyboard', 'control', null, 'ui.keybindings'),
  item('notifyEnabled', 'notifications', 'checkbox', 'notifyEnabled', 'notify.enabled'),
  item('maxConcurrent', 'sessions', 'control', 'maxConcurrent', 'session.maxConcurrent'),
  item('idleTimeout', 'sessions', 'control', 'idleTimeoutMs', 'session.idleTimeoutMs'),
  item('defaultModel', 'newThread', 'control', 'defaultModelId', 'session.defaultModelId'),
  item('defaultThinking', 'newThread', 'control', 'defaultThinking', 'session.defaultThinking'),
  // TODO 1005 part 1: a notice that things corresponding to the CLI's own allow list do not reach aios's approvals (a description-only item, at the head of the approval section).
  item('cliAllowNotice', 'approval', 'control', null, null),
  item('autoAllowAll', 'approval', 'checkbox', 'autoAllowAll', 'approval.autoAllowAll'),
  // TODO 1175: full delegation mode (confirmed once inside this field only when enabling it).
  item('fullDelegation', 'approval', 'checkbox', 'fullDelegation', 'approval.fullDelegation'),
  // TODO 1222: the auto-selection of a question's recommendation (1194) became a per-conversation switch and was removed from settings (a badge in the Composer).
  item('autoAllowTools', 'approval', 'control', 'autoAllowTools', 'approval.autoAllowTools'),
  item('bashDenyPatterns', 'approval', 'control', 'bashDenyPatterns', 'approval.bashDenyPatterns'),
  item('alwaysAllowed', 'approval', 'control', null, 'approval.rules'),
  // TODO 1029: connection targets that are not asked about (the list of hosts for ssh / scp / sftp / rsync).
  item('sshAllowedHosts', 'approval', 'control', null, 'approval.sshAllowedHosts'),
  // TODO 1106: the allow table of the OS sandbox (connection targets, writable places). Takes effect from the next start of a conversation / scheduled job that turned it ON.
  item('sandboxAllowedDomains', 'approval', 'control', null, 'sandbox.allowedDomains'),
  item('sandboxAllowWrite', 'approval', 'control', null, 'sandbox.allowWrite'),
  // TODO 1055 (2): revoke the consent for the AI to read the body of a Web tab (the one taken the first time in the approval box).
  item('webTabReadConsent', 'approval', 'control', null, 'web.tabReadConsent'),
  // The list of "push targets not asked about" of TODO 1013 was folded away in TODO 1031 (owner decision 2026-10-28), and in 1048 the main side and the key were removed too.
  item('cwdHistory', 'workspace', 'control', null, null),
  item('clearAllLogs', 'logs', 'control', null, null),
  item('volumes', 'storage', 'control', null, 'fs.allowedVolumes'),
  // TODO 805: for the first 3 days after install, Desktop / Documents / Downloads are not scanned. Shows the deferral state and "include now".
  item('protectedFolders', 'storage', 'control', null, 'fs.tccDeferUntil'),
  item('mcpServers', 'mcp', 'control', null, null),
  // TODO 1229: the font of the body of Gmail drafts (standard / fixed width). Fixed width is requested from the AI with an additional instruction.
  item('gmailDraftFont', 'mcp', 'control', 'gmailDraftFont', 'gmail.draftFont'),
  item('skills', 'skills', 'control', null, null),
  // TODO 811: turn Redmine ticket numbers in an answer into links to that site's tickets (https only, empty = do nothing).
  item('redmineBaseUrl', 'web', 'control', 'redmineBaseUrl', 'web.redmineBaseUrl'),
  item('trustedCertificates', 'web', 'control', null, 'web.trustedCertificates'),
  // TODO 697: delete login information (cookies and site storage). No value is stored; it is a list that reads cookies on the spot.
  item('loginSites', 'web', 'control', null, null),
  // TODO 1088: write threads and settings into 1 file (encrypted with a passphrase) / read them back. Holds no value.
  item('dataTransfer', 'dataTransfer', 'control', null, null),
  // TODO 960: when an expired authentication is detected, open Terminal without a button and run the login (default off).
  item('autoLogin', 'account', 'checkbox', 'autoLogin', 'auth.autoLogin'),
  // TODO 1282: how to authenticate unattended / scheduled runs (guidance only; no value, no token is stored or asked for).
  item('unattendedAuth', 'account', 'control', null, null),
  item('accountUsage', 'account', 'control', null, 'usage.lastSnapshot'),
  item('agentCli', 'about', 'control', null, null)
]

/** Fold for matching (NFKC + lowercase). So full-width alphanumerics and case differences do not cause a miss. */
export function foldForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/**
 * Filter by the search term. Terms are split by whitespace, and only items that contain **all terms** somewhere remain (AND, same as VS Code).
 * With an empty term, everything. `textOf` returns the strings to match, such as the item's title and description (the dictionary is the caller's).
 */
export function filterSettingsItems(
  items: readonly SettingsItem[],
  query: string,
  textOf: (item: SettingsItem) => string
): readonly SettingsItem[] {
  const terms = foldForSearch(query)
    .split(/\s+/)
    .filter((term) => term !== '')
  if (terms.length === 0) return items
  return items.filter((entry) => {
    const haystack = foldForSearch(textOf(entry))
    return terms.every((term) => haystack.includes(term))
  })
}

/** Only the categories that still have at least one item, in table order (the table of contents and the body headings). */
export function categoriesOf(items: readonly SettingsItem[]): readonly SettingsCategory[] {
  const present = new Set(items.map((entry) => entry.category))
  return SETTINGS_CATEGORIES.filter((category) => present.has(category))
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

/** Equality as an unordered set (auto-allowed tools are listed in the order they were pressed). */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((value) => right.has(value))
}

/** Stop patterns do not count blank lines (main also drops blank lines when saving). */
function patterns(list: readonly string[]): readonly string[] {
  return list.map((line) => line.trim()).filter((line) => line !== '')
}

/** Whether it was changed from the default. While the value is not yet available (undefined), it counts as unchanged. */
export function isModified(
  key: SettingValueKey,
  values: Partial<SettingValues>,
  defaults: SettingValues | null
): boolean {
  if (defaults === null) return false
  const value = values[key]
  if (value === undefined) return false
  const fallback = defaults[key]
  if (key === 'autoAllowTools') {
    return !sameSet(value as readonly string[], fallback as readonly string[])
  }
  if (key === 'bashDenyPatterns') {
    return !sameList(patterns(value as readonly string[]), patterns(fallback as readonly string[]))
  }
  return value !== fallback
}

/** The number of changed items (to show "N changed" next to the search field). */
export function countModified(
  items: readonly SettingsItem[],
  values: Partial<SettingValues>,
  defaults: SettingValues | null
): number {
  return items.filter((entry) => entry.value !== null && isModified(entry.value, values, defaults))
    .length
}

/**
 * From the scroll position, decide the category to highlight in the table of contents. `tops` is the position of each category's heading from the top edge of
 * the scrolling container (px). Take the last heading that has passed the top edge (plus a little margin).
 */
export function currentCategory(
  tops: readonly { category: SettingsCategory; top: number }[],
  slack = 8
): SettingsCategory | null {
  let current: SettingsCategory | null = tops[0]?.category ?? null
  for (const entry of tops) {
    if (entry.top <= slack) current = entry.category
    else break
  }
  return current
}
