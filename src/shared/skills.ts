/**
 * Skill list and deletion (TODO 773, ARCHITECTURE.md 4.5.3). Types between the renderer and main.
 * Knowledge of the storage locations lives only in the adapter and compat/; this file uses neutral words only (constraint 6).
 */

/** The scope of a skill. `plugin` is read-only. */
export type SkillScope = 'user' | 'project' | 'plugin'

export interface SkillEntry {
  /** Display name (the `name` at the head of the body, or the directory name if none). */
  readonly name: string
  /** Directory name (deletion refers to it). */
  readonly dirName: string
  /** The `description` at the head of the body. Empty string if none. */
  readonly description: string
  readonly scope: SkillScope
  /** For a plugin's skill, the name of that plugin. */
  readonly pluginName: string | null
  /** `file://` URI of the main file (opened in the viewer). */
  readonly uri: string
  /** Whether it is a link to another location (deletion discards only the link). */
  readonly linked: boolean
  /** Cannot be deleted (plugin). */
  readonly readOnly: boolean
}

export interface SkillListing {
  readonly skills: readonly SkillEntry[]
  /** Whether the project skills of the working folder were examined (false if there is no cwd). */
  readonly projectChecked: boolean
}

/** Deletion request. `plugin` is not accepted (excluded by the type). */
export interface SkillDeleteRequest {
  readonly scope: 'user' | 'project'
  readonly dirName: string
  /** The working folder when pointing at a project skill (`file://` URI). */
  readonly cwdUri: string | null
}

export type SkillDeleteReason = 'invalid' | 'not-found' | 'not-allowed' | 'failed'

export type SkillDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SkillDeleteReason }

// ---- Catalog of CLI plugins, and installing / removing them (TODO 1099, ARCHITECTURE.md 4.5.3.3) ----
// Only the adapter and compat/ know the marketplace name, the catalog location and the subcommands. This file uses neutral words only.

/** The review badge of the catalog. `first-party` = the backend's provider, `partner` = a partner. */
export type PluginReview = 'first-party' | 'partner'

/**
 * Shown in the list but cannot be installed. `command-source` = a form that runs an arbitrary command when installing (not installed in stage 1),
 * `not-in-marketplace` = in the catalog but the official marketplace has no plugin with the same source,
 * `ambiguous-in-marketplace` = the official marketplace has several plugins with the same source, so the name to install is undecided (TODO 1177).
 */
export type PluginEntryBlock = 'command-source' | 'unsupported-source' | 'not-in-marketplace' | 'ambiguous-in-marketplace'

export interface PluginCatalogEntry {
  /** Name in the catalog (the key the renderer sends back to main when installing. main looks it up again from the catalog). */
  readonly name: string
  /**
   * The name passed to the CLI (the installed-plugin list also uses this name). It may differ from the catalog name (TODO 1177).
   * null for ones that cannot be installed.
   */
  readonly installName: string | null
  readonly title: string
  readonly summary: string
  readonly version: string | null
  readonly publisher: string | null
  readonly review: PluginReview | null
  /** Already installed (in any scope. Matched against the installed-plugin list by `installName`). */
  readonly installed: boolean
  readonly blocked: PluginEntryBlock | null
}

/** One installed CLI plugin (from the installed-plugin list). */
export interface InstalledCliPlugin {
  /** `<name>@<marketplace>` (removal refers to it). */
  readonly id: string
  readonly name: string
  readonly marketplace: string
  readonly scope: 'user' | 'project' | 'local' | 'other'
  readonly version: string | null
  /** Can be removed from aios (user scope only). */
  readonly removable: boolean
}

/** Reasons the catalog cannot be shown. In every case the list is empty, and the user is guided to refresh the catalog in a terminal. */
export type PluginCatalogUnavailable =
  /** The backend has no catalog (no table) */
  | 'no-backend-support'
  /** The official marketplace is not registered (e.g. a machine where an interactive session was never started) */
  | 'no-marketplace'
  /** The catalog cache is missing or empty */
  | 'no-cache'
  /** The catalog is stale */
  | 'stale'
  /** Wrong shape, too large, or unreadable */
  | 'malformed'

/** The form in which install / remove does not work (the same values as `AgentUpdateUnsupportedReason`). */
export type PluginOpsDisabled = 'instance' | 'dev' | 'agent-disabled' | 'fake-backend' | 'no-backend-support'

export interface PluginCatalogResult {
  /** Entries that matched the terms (from the start up to the limit). */
  readonly entries: readonly PluginCatalogEntry[]
  /** The number that matched the terms (before cutting at the limit). */
  readonly matched: number
  /** The total number in the catalog (installable ones). */
  readonly total: number
  /** The time (ms) the CLI fetched the catalog. */
  readonly fetchedAt: number | null
  readonly unavailable: PluginCatalogUnavailable | null
  /** The command for the user to type in a terminal (refreshes the catalog). A string for display. */
  readonly refreshCommand: string | null
  readonly installed: readonly InstalledCliPlugin[]
  /** The reason install / remove does not work. null if it works. */
  readonly opsDisabled: PluginOpsDisabled | null
}

export type PluginOpReason =
  /** The name's shape is wrong, or it is not in the catalog */
  | 'invalid'
  /** The form in which install / remove does not work (dev, a fake backend, etc.) */
  | 'disabled'
  /** A conversation is running (wait until it ends) */
  | 'session-busy'
  /** Another install / remove is running */
  | 'op-busy'
  /** A form that runs an arbitrary command (not installed from aios) */
  | 'command-source'
  /** Blocked by an administrator's policy */
  | 'policy'
  /** The catalog or the source is unreachable */
  | 'network'
  /** The CLI cannot install this plugin */
  | 'not-installable'
  /** Not installed */
  | 'not-installed'
  | 'timeout'
  /** The CLI cannot be started */
  | 'unavailable'
  | 'failed'

export type PluginOpResult =
  | { readonly ok: true; /** It was already in that state */ readonly already: boolean }
  | { readonly ok: false; readonly reason: PluginOpReason; readonly exitCode?: number }
