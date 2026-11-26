/**
 * Shared types of the plugin foundation (ARCHITECTURE.md chapter 7).
 *
 * Definitions so that the four parties (main / plugin-host / renderer / plugins) see the same vocabulary.
 * **There are no privileges here**: only the shape of the manifest and the shapes of Broker requests / responses.
 * The actual permission decisions are made by main's CapabilityBroker (7.7).
 */

import type { Theme } from './theme.js'
import type { Locale } from './locale.js'
import type { ViewerKeybindingCommandId } from './keybindings.js'
import type { ViewerViewMode } from './viewer-view-mode.js'
import type { PluginSidebarRow, PluginSyncReport, SidebarViewDeclaration } from './plugin-surfaces.js'
import type { SearchProviderDeclaration } from './plugin-search.js'
import type { PluginUpdateInfo } from './plugin-update.js'
import type { PluginTriggerEvent, TriggerDeclaration, TriggerEmitResult } from './trigger.js'
import type { PluginConfigurationDeclaration, PluginSettingValues } from './plugin-settings.js'
import type { BrokerGitRequest, PluginGitApi } from './plugin-git.js'

/**
 * The form of a plugin id (reverse-domain style such as `aios.text`). It is used for a URL authority and a directory name, so it is tightly restricted.
 * Manifest validation, the key of `plugins.updated`, and the place updates are stored all use the same one (wave 73 review). The length (3 to 64) is checked separately by the manifest.
 */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/

/** The names of capabilities. The keys of the manifest's `capabilities` correspond to the Broker's entry points. */
export const CAPABILITY_NAMES = ['credentials', 'network', 'fs', 'index', 'ui', 'browser', 'triggers', 'git'] as const
export type CapabilityName = (typeof CAPABILITY_NAMES)[number]

/** TODO 1237: validates a capability name that came from the renderer, such as in the consent IPC. The canonical list of capability names is `CAPABILITY_NAMES`, in one place. */
export function isCapabilityName(value: unknown): value is CapabilityName {
  return typeof value === 'string' && (CAPABILITY_NAMES as readonly string[]).includes(value)
}

/**
 * Capabilities that are not treated as granted at install time even for bundled plugins (TODO 848, owner decision 2026-10-15). The user's first consent is required.
 * `browser` uses the cookies of the logged-in Web view, so it is stronger than plain `network`.
 */
export const EXPLICIT_CONSENT_CAPABILITIES: ReadonlySet<CapabilityName> = new Set<CapabilityName>(['browser'])

/**
 * The manifest's capability declaration (7.2).
 *
 * **This is "the upper bound of what may be requested", not a permission.** The Broker refuses requests outside the declaration
 * unconditionally, and even for those inside the declaration it checks consent and policy separately.
 */
export interface CapabilityDeclaration {
  /** Credential names (such as `google:gmail`). **The value is never passed to the plugin** (7.7). */
  readonly credentials?: {
    readonly oauth: readonly string[]
    /** TODO 1218: a fixed token (Basic auth) that the user enters in the extension's details. Only names that are in main's table (`basic-credentials.ts`). */
    readonly basic?: readonly string[]
  }
  /** Allowed hosts. `*.example.com` covers only the same domain. */
  readonly network?: { readonly hosts: readonly string[] }
  /** Empty by default. The Broker permits a URI the user opened each time (7.2). */
  readonly fs?: { readonly read?: readonly string[]; readonly write?: readonly string[] }
  /** The source names of the index that may be written (only the plugin's own namespace). */
  readonly index?: { readonly write: readonly string[] }
  /** Notifications and viewer update requests. There is no direct access to the DOM. */
  readonly ui?: {
    readonly notify?: boolean
    /** May report sync progress (TODO 1038, the BottomBar badge). */
    readonly status?: boolean
    /** May pass rows of the sidebar list (TODO 1039). Requires the `sidebarView` declaration and being bundled. */
    readonly sidebar?: boolean
  }
  /**
   * Hosts from which pages may be fetched in the logged-in Web view session (`persist:aios-web`) (TODO 848, 7.7).
   * The shape is the same as `network.hosts` (`*.example.com` covers only the same domain). Raw IPs and `localhost` cannot be written.
   * **The first consent is required** (`EXPLICIT_CONSENT_CAPABILITIES`; not treated as granted even when bundled).
   */
  readonly browser?: { readonly hosts: readonly string[] }
  /**
   * Read-only git operations (TODO 834 stage 1, `plugin-git.ts`): `status` / `diff` / `show` / `log`, with argv built by main. Only on folders
   * the user opened in the Source Control view (`aios-git:` URI), like fs's "a URI the user opened". Writes (commit, push...) will be a separate capability.
   */
  readonly git?: { readonly read: boolean }
}

/** The viewer declaration (7.1). It claims files by extension or scheme. */
export interface ViewerDeclaration {
  readonly entry: string
  readonly extensions?: readonly string[]
  readonly schemes?: readonly string[]
  /** Whether it accepts text editing. Used by the host to decide whether to show the save UI. */
  readonly editable?: boolean
  /** Resolution priority. A smaller value claims first. The default is 100. */
  readonly priority?: number
  /**
   * Claims by the kind of contents rather than by URI (item 104, 7.4.6). Only `diff` for now.
   * A viewer that declares this **never appears in URI resolution** (it is not a fallback either).
   */
  readonly payloads?: readonly TransientPayloadKind[]
  /** How the body is delivered. If omitted: `url` for a non-editing viewer that claims by extension, `text` otherwise. */
  readonly delivery?: 'text' | 'url'
  /**
   * Extensions that are received by URL but can return a draft of cell values (the edit list of `@shared/xlsx-cells.ts`) and be saved (TODO 1212 stage 1, ARCHITECTURE 7.4.9.1).
   * `xlsx` and `xlsm` (stage 2; the macro parts are left as raw bytes). Saving stays the host's `viewer.write`: main looks at this declaration,
   * reads the draft as an edit list, and writes it to the original file as a diff (`xlsx-cells-write.ts`).
   */
  readonly cellEdits?: readonly ('xlsx' | 'xlsm')[]
}

/**
 * Kinds of temporary views that have no URI (item 104). The host passes the contents directly, and they are not kept in
 * the per-thread memory (item 63).
 */
export type TransientPayloadKind = 'diff'

export const TRANSIENT_PAYLOAD_KINDS: readonly TransientPayloadKind[] = ['diff']

export function isTransientPayloadKind(value: unknown): value is TransientPayloadKind {
  return typeof value === 'string' && (TRANSIENT_PAYLOAD_KINDS as readonly string[]).includes(value)
}

/**
 * The entry point of code that runs in the plugin-host (7.1, review C-4). **One per plugin**; `command` / `mcp` / `indexer`
 * are told apart by the **exports** of the same entry point (`PluginModule`).
 * None of them runs in main (constraint 8).
 */
export interface HostEntryDeclaration {
  readonly entry: string
}

/**
 * The declaration of `command` / `mcp` / `indexer`. `entry` is a remnant of the old Phase 4 form;
 * if written, it must be the same file as `host.entry` (and as each other, if several), otherwise it is not loaded (C-4).
 */
export interface LegacyEntryDeclaration {
  /** @deprecated Write it in `host.entry`. If kept, it must be the same file as `host.entry`. */
  readonly entry?: string
}

export interface CommandDeclaration extends LegacyEntryDeclaration {
  readonly commands: readonly {
    readonly id: string
    readonly title: string
    /** If it has side effects, it goes through the approval inbox (7.6). */
    readonly sideEffect?: boolean
  }[]
}

/**
 * The form of a plugin tool name (`mcp.tools[].name` of the manifest, TODO 847). It starts with a letter and has only alphanumerics, `_` and `-` (1 to 32 characters).
 * Manifest validation (`src/main/plugin/manifest.ts`) and the tool allowlist of trigger rules (`checkAllowedToolNames`, TODO 1227)
 * use this one (fix X, code-review: the same expression was in 2 places).
 */
export const PLUGIN_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

/**
 * The declaration of one tool that a plugin exposes to the model (TODO 847, 7.2 / 7.6.7). In the gateway's `tools/list` it is listed as
 * `<plugin id with . replaced by _>__<name>` (`pluginToolExposedName`). The implementation is the `mcp.<name>` export of `host.entry`,
 * and it runs inside the plugin-host (constraint 8).
 */
export interface PluginToolDeclaration {
  /** Unique within the plugin. Starts with a letter and has only alphanumerics, `_` and `-` (1 to 32 characters). */
  readonly name: string
  /** The heading in the list (optional). */
  readonly title?: string
  /** The description shown to the model. */
  readonly description: string
  /** The JSON Schema of the arguments (a small subset, `tool-schema.ts`). The top level is `type: "object"`. */
  readonly inputSchema: Readonly<Record<string, unknown>>
  /** If it has side effects, the user is asked in the approval box on every call (owner decision 2026-10-15). The default is false (no asking). */
  readonly sideEffect?: boolean
}

/**
 * One row of the tool listing passed from main to the gateway (TODO 847, the gateway's `pluginTools` response). The gateway
 * lists it as is in `tools/list`. It is not passed to the renderer.
 */
export interface PluginToolListing {
  /** The name in the gateway (in the form `aios_reddit__fetchThread`). */
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** The `mcp` declaration (TODO 847). The old form without `tools` exposes no tools. */
export interface McpDeclaration extends LegacyEntryDeclaration {
  readonly tools?: readonly PluginToolDeclaration[]
}

/**
 * A contribution to the Activity Bar (TODO 523, 7.2). The icon uses the manifest's `icon` (it is not held here).
 * Pressing it only opens `openUrl` in the Web view (the tab mechanism of 522) or the default browser: the plugin's code is
 * not run, and the plugin cannot touch the contents of the page (the policy of 400 / 522).
 */
export interface ActivityBarDeclaration {
  /** The Activity Bar bubble and the title of the Web tab. */
  readonly title: string
  /** The URL opened when pressed. The same rule as `isWebViewerUrl` (http(s) only). */
  readonly openUrl: string
  /**
   * TODO 721: `'web'` (the default) is the Web view (`persist:aios-web`), `'external'` is the default browser
   * (`shell.openExternal`). For sites that refuse login from an embedded browser.
   */
  readonly openWith?: 'web' | 'external'
}

/**
 * The declaration of a plugin's scheduled task (TODO 372, 7.2 / 6.2.4). **The plugin only declares it**; counting the time is done by
 * aios's `JobScheduler`. From the declaration a row appears in the list of scheduled runs (**disabled at install time**). The user can change the time and whether it is
 * enabled. A task is code only (it cannot start a CLI turn). In this version, when the time comes it is skipped as "not supported":
 * starting the plugin-host and calling the export is Phase 5 (`aios.gmail`).
 */
export interface ScheduledTaskDeclaration {
  /** Unique within the plugin (such as `fetch`). */
  readonly id: string
  /** The name shown in the list. */
  readonly name: string
  /** The default interval (minutes, 15 to 1440). If the user changes it, theirs is kept. */
  readonly defaultInterval: number
  /**
   * "Repeat while idle" (TODO 952 stage 1). If true, even when the time (interval) comes it runs only **while no conversation is running**
   * (`SessionManager.activityBlocker()` is null, the same decision as 774), and it does not run until 2 minutes after launch.
   * If the task returns `{ more: true }`, it is called again during idle without waiting for the interval (to advance the first full ingestion bit by bit).
   * The row of this declaration is **enabled from install time** (the plugin itself is disabled by default, and without credentials the task does nothing).
   */
  readonly idle?: boolean
}

/**
 * The argument of a scheduled task call (TODO 952 stage 1). `state` is the `state` that task returned last time (main keeps it in the encrypted DB's
 * `plugin_task_state`; null on the first run and after logout). The plugin keeps no state of its own and receives the position to continue from here.
 */
export interface PluginTaskArg {
  readonly state: PluginTaskState | null
  /** `scheduled` = the time came / `idle` = a continuation during idle / `manual` = run now or right after login. */
  readonly reason: 'scheduled' | 'idle' | 'manual'
  /**
   * TODO 1264: the display language at the time of the call (for words a task puts in front of the user, such as sidebar rows).
   * Absent from callers that do not know it (tests, old main); a task falls back to English.
   */
  readonly locale?: Locale
}

/** The state the task carries over. Only JSON-able values (main cuts it at `MAX_PLUGIN_TASK_STATE_BYTES`). */
export type PluginTaskState = Readonly<Record<string, unknown>>

/** The return value of a scheduled task (TODO 952 stage 1). If the shape is wrong, main reads it as "state unchanged, no continuation". */
export interface PluginTaskResult {
  /** The state to pass next time. Omitted = unchanged. null = delete. */
  readonly state?: PluginTaskState | null
  /** There is more to do (call again during idle). */
  readonly more?: boolean
  /** Wait this long before the next call (during 429 and the like). Main decides the upper limit. */
  readonly retryAfterMs?: number
}

/** Upper limit of the JSON of a task's state (bytes). Large enough to hold a continuation position (pageToken, historyId). */
export const MAX_PLUGIN_TASK_STATE_BYTES = 16 * 1024

/** The manifest (7.2). */
export interface PluginManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  /** The name shown in lists and details (TODO 368). `name` if absent. VS Code's `displayName`. */
  readonly displayName?: string
  /** A one-line description (TODO 368). VS Code's `description`. */
  readonly description?: string
  /** The icon file (relative to the plugin directory, `.svg` / `.png`, TODO 368). Shown in the extensions view from TODO 524. */
  readonly icon?: string
  /** The author (TODO 368). VS Code's `publisher`. */
  readonly publisher?: string
  /** A contribution to the Activity Bar (TODO 523). If absent, no icon is shown on the Activity Bar. */
  readonly activityBar?: ActivityBarDeclaration
  /** The plugin's own list in the sidebar (TODO 1039). Bundled plugins only. Opened by the Activity Bar icon. */
  readonly sidebarView?: SidebarViewDeclaration
  /** The plugin's section in the search sidebar (TODO 896). Bundled plugins only. `search.query` of `host.entry` answers. */
  readonly searchProvider?: SearchProviderDeclaration
  readonly capabilities: CapabilityDeclaration
  readonly viewer?: ViewerDeclaration
  /** The entry point of the plugin-host (C-4). Required when any of `command` / `mcp` / `indexer` is present. */
  readonly host?: HostEntryDeclaration
  readonly command?: CommandDeclaration
  readonly mcp?: McpDeclaration
  readonly indexer?: LegacyEntryDeclaration & { readonly interval?: string }
  /** Scheduled tasks (TODO 372). Requires `host.entry`. */
  readonly scheduledTasks?: readonly ScheduledTaskDeclaration[]
  /**
   * Triggers (TODO 1216, 6.2.6). The kinds of events this extension reports with `api.triggers.emit`. The declaration itself counts as a request for the `triggers`
   * capability (granted for bundled ones, the user's consent for others). Requires `host.entry`. Rules are disabled by default.
   */
  readonly triggers?: readonly TriggerDeclaration[]
  /**
   * Settings fields (TODO 1225, 7.2.1). A subset of VS Code's `contributes.configuration`. The user changes values in the extension details' "Settings",
   * and the extension reads only its own values with `aios.settings.get()`. No secrets are put here (use the credentials entry point).
   */
  readonly configuration?: PluginConfigurationDeclaration
}

/**
 * The kinds that the plugin-host's entry point has as exports (C-4). Named by main's `PluginHost.invoke`.
 * `task` is a scheduled task (`tasks.<id>` for each `scheduledTasks[].id`, TODO 952 stage 1).
 * `search` is a search section (`search.query` of `searchProvider`, TODO 896).
 */
export type HostExportKind = 'command' | 'mcp' | 'indexer' | 'task' | 'search'

/** "The names that were actually exported" which the plugin-host returns after loading (C-4). Main matches them against the declaration. */
export interface HostExports {
  readonly commands: readonly string[]
  readonly mcp: readonly string[]
  readonly indexer: readonly string[]
  /** Scheduled tasks (TODO 952 stage 1). An old plugin-host does not include it (main reads it as empty). */
  readonly tasks?: readonly string[]
  /** Search sections (TODO 896). An old plugin-host does not include it (main reads it as empty). */
  readonly search?: readonly string[]
}

/**
 * The state of the Node permission model, which the plugin-host reports to main right after launch (before loading plugin code) (TODO 499, 7.8).
 * `enabled` means `process.permission` exists and reading `/` is not allowed. `helper` is the name of the executable that runs the utility process
 * (for `Electron Helper` NODE_OPTIONS takes effect; if it is renamed, Electron regards the app as packaged and discards it).
 */
export interface HostPermissionReport {
  readonly enabled: boolean
  readonly helper: string
}

/** The plugin state shown to the renderer. **Paths are not included** (the convention of chapter 7). */
export interface PluginSummary {
  readonly id: string
  readonly name: string
  /** The name shown in lists and details (TODO 367 / 368). The manifest's `displayName`, or `name` if absent. */
  readonly displayName: string
  /** A one-line description (the manifest's `description`, TODO 368). null if absent. */
  readonly description: string | null
  /** The author (the manifest's `publisher`, TODO 368). null if absent. */
  readonly publisher: string | null
  /**
   * The icon URL (`aios-plugin://<id>/<icon>`, TODO 524). Only one whose existence and being inside the directory main
   * checked at load time. null if absent (the renderer uses the default icon). An SVG may contain a script, so it is drawn with `<img>`.
   */
  readonly iconUrl: string | null
  readonly version: string
  /**
   * The Activity Bar contribution (TODO 523). A copy of the manifest's `activityBar`, or null if absent.
   * **It is included regardless of `enabled`**: whether to show the icon on the Activity Bar is decided by the renderer together with
   * `enabled` (treated like other manifest values).
   */
  readonly activityBar: { readonly title: string; readonly openUrl: string; readonly openWith?: 'web' | 'external' } | null
  /** TODO 1039: the declaration of the sidebar list (bundled only). Omitted if absent. */
  readonly sidebarView?: SidebarViewDeclaration
  /** TODO 896: the declaration of the search sidebar section (bundled only). Omitted if absent. */
  readonly searchProvider?: SearchProviderDeclaration
  /** Whether it is bundled (built in). Since TODO 460 built-in ones can also be disabled individually (except `required`, 12.9). */
  readonly bundled: boolean
  /**
   * Whether it is an extension that cannot be disabled (TODO 460). Only the last fallback among the built-in ones (`aios.text`) is true: turning it off
   * would make files that no viewer claims impossible to open. The decision is main's `isRequiredPlugin`.
   */
  readonly required: boolean
  readonly enabled: boolean
  /** The declared capabilities (the upper bound, 7.2). */
  readonly capabilities: readonly CapabilityName[]
  /** Of those, the capabilities that were consented to (the second step of 7.7). Bundled plugins are granted at install time (12.9). */
  readonly consented: readonly CapabilityName[]
  readonly hasViewer: boolean
  /** The plugin-host's process state. 'none' for a plugin with only a viewer. */
  readonly host: 'none' | 'stopped' | 'running' | 'crashed'
  readonly crashes: number
  /**
   * TODO 1144 stage 1: the update state (latest / update available / cannot check). The version (`version`) matched against the latest Release's
   * extension version table (ARCHITECTURE 8.5.1).
   */
  readonly update: PluginUpdateInfo
}

/**
 * The contributions and permissions read from the manifest, shown in the extensions view's details (TODO 367). **Paths are not included**:
 * the `fs.read` / `fs.write` declarations are the strings as written in the manifest (the location of the plugin directory is not passed).
 * The renderer draws it on its own screen, and the plugin's code is not run.
 */
export interface PluginDetail {
  readonly summary: PluginSummary
  readonly contributions: PluginContributions
  readonly permissions: readonly PluginPermission[]
  /** The upper limit of automatic restarts after a crash (7.8). Beyond it, it stays stopped. */
  readonly restartLimit: number
  /**
   * TODO 1237: the earlier "disabled" record belongs to different contents under the same id (an update or replacement). It is **kept disabled** (so that an extension the user stopped
   * does not become enabled by itself through a content swap; the fail-closed side). The details overview says once "enable it again if you want to use it". Always false for bundled ones.
   */
  readonly enabledReset: boolean
}

/** Contributions of features (the "contributions" tab of TODO 367). The manifest's `viewer` / `command` / `mcp` / `indexer`. */
export interface PluginContributions {
  readonly viewer: {
    readonly extensions: readonly string[]
    readonly schemes: readonly string[]
    readonly payloads: readonly TransientPayloadKind[]
    readonly editable: boolean
    readonly priority: number
    /** Has none of `extensions`, `schemes` or `payloads` = the fallback for files that nobody claims (7.2). */
    readonly fallback: boolean
  } | null
  readonly commands: readonly { readonly id: string; readonly title: string; readonly sideEffect: boolean }[]
  readonly mcp: boolean
  readonly indexer: { readonly interval: string | null } | null
}

/** One permission (of 7.7's declaration -> consent -> policy, the declaration and consent). */
export interface PluginPermission {
  readonly capability: CapabilityName
  readonly consented: boolean
  /**
   * The contents of the declaration (credential names, allowed hosts, index sources, fs scope). For fs, `mode` separates read / write.
   * Empty = there is no scope declaration (for fs, "only files the user opened"; for ui, notifications only).
   */
  readonly targets: readonly { readonly mode: 'read' | 'write' | null; readonly value: string }[]
}

/** The result of resolving a viewer. The renderer looks at it and shows an iframe. */
export interface ResolvedViewer {
  readonly pluginId: string
  readonly name: string
  /** `aios-plugin://<id>/<entry>`. The renderer only puts this URL into the iframe. */
  readonly url: string
  readonly editable: boolean
  /**
   * How the contents are delivered (review C-2). `url` = the body is not passed; an `aios-res://` URL is passed instead.
   * `url` only when "this viewer claimed the extension via `extensions`, and it does not edit (= does not receive text)".
   * It is not decided by sniffing the contents (an SVG has no NUL but should be passed as an image).
   * It is not attached to temporary views (`resolvePayloadViewer`).
   */
  readonly delivery?: 'text' | 'url'
  /**
   * The draft of this URI is an edit list of cell values (TODO 1212 stage 1). Attached only for `delivery: 'url'`. `ViewerBroker.write`
   * looks at it and routes the draft to a diff write.
   */
  readonly cellEdits?: boolean
  /**
   * If the last element of the opened URI is a symlink, the URI of its target (TODO 558). The ViewerPane heading shows it
   * faintly next to the link's path. Only `ViewerBroker.open` sets it (for the renderer; it is not passed to plugins).
   */
  readonly linkTargetUri?: string
}

/**
 * One candidate for "open with another viewer" (TODO 907, VS Code's Reopen Editor With...). An enabled viewer that claims that file
 * (by extension, scheme, or as the last fallback). Ordered by smaller priority first (= the order of normal selection).
 */
export interface ViewerChoice {
  readonly pluginId: string
  /** The name shown in the heading (`displayName` or `name`). */
  readonly name: string
  readonly editable: boolean
  /** The viewer chosen when there is no per-extension default (VS Code's "(default)"). */
  readonly builtinDefault: boolean
}

/** The answer of `viewer.choices(uri)` (TODO 907). */
export interface ViewerChoices {
  /** The lower-case extension (without the dot). `''` for a file with no extension: a default cannot be remembered. */
  readonly ext: string
  readonly choices: readonly ViewerChoice[]
  /** The id of the viewer that `resolveViewer` would choose now. null if there are no candidates. */
  readonly current: string | null
  /** Whether a per-extension default (setting) is in effect. */
  readonly associated: boolean
}

/**
 * One row of "viewer per extension" on the settings screen (TODO 907). `valid` false = that viewer no longer exists or is disabled, and
 * normal selection is back in effect (it remains in settings; it takes effect if the plugin is enabled again).
 */
export interface ViewerAssociationEntry {
  readonly ext: string
  readonly pluginId: string
  /** The name for the heading. The id as is if the plugin no longer exists. */
  readonly name: string
  readonly valid: boolean
}

/**
 * The key of a per-extension default (TODO 907). Only lower-case alphanumerics and `_` `+` `-`, 1 to 32 characters (matching the result of `extensionOf`).
 * Used by both the settings parse (dropping broken values) and the IPC re-validation. `__proto__` cannot be a key of the table (a plain object), so it is refused.
 */
export function isAssociationExt(value: unknown): value is string {
  return typeof value === 'string' && value !== '__proto__' && /^[a-z0-9_+-]{1,32}$/.test(value)
}

// ---- Broker requests / responses (plugin-host <-> main) ----

/**
 * How `fs.read` is received (review C-1). `utf8` = `text` if it is text (as before; no contents for binary),
 * `bytes` = the contents are **always** returned as `data` (`Uint8Array`). A utility process's `postMessage` is a
 * structured clone, so a `Uint8Array` is passed as is.
 */
export type BrokerReadEncoding = 'utf8' | 'bytes'

/** The default length returned by one `fs.read` (when `length` is omitted). The same as the viewer's text limit. */
export const MAX_PLUGIN_READ_BYTES = 2 * 1024 * 1024
/**
 * The maximum length that one `fs.read` can return (C-1). A larger file (a PDF, etc.) is read in ranges by advancing
 * `offset`. Matched with the limit of a `net.fetch` response (8 MB).
 */
export const MAX_PLUGIN_READ_CHUNK_BYTES = 8 * 1024 * 1024

export interface BrokerFsReadOptions {
  /** Default `utf8`. */
  readonly encoding?: BrokerReadEncoding
  /** The byte position to start reading. Default 0. Past the end of the file, 0 bytes are returned. */
  readonly offset?: number
  /** The length to read. Default `MAX_PLUGIN_READ_BYTES`, at most `MAX_PLUGIN_READ_CHUNK_BYTES`. */
  readonly length?: number
}

export interface BrokerFsReadRequest extends BrokerFsReadOptions {
  readonly capability: 'fs'
  readonly op: 'read'
  readonly uri: string
}

export interface BrokerNetFetchRequest {
  readonly capability: 'network'
  readonly op: 'fetch'
  readonly url: string
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  /** A string is sent as UTF-8. A byte sequence (such as an attachment upload) is sent as is (C-3). */
  readonly body?: string | Uint8Array
  /** The **name** of the credential. The Broker attaches the value (7.7). */
  readonly auth?: string
}

export interface BrokerCredentialsStatusRequest {
  readonly capability: 'credentials'
  readonly op: 'status'
  readonly name: string
}

export interface BrokerIndexPutRequest {
  readonly capability: 'index'
  readonly op: 'put'
  readonly document: PluginDocumentInput
}

export interface BrokerIndexRemoveRequest {
  readonly capability: 'index'
  readonly op: 'remove'
  readonly source: string
  readonly sourceId: string
}

export interface BrokerUiNotifyRequest {
  readonly capability: 'ui'
  readonly op: 'notify'
  readonly title: string
  readonly body?: string
}

/**
 * Fetches one page in the logged-in Web view session (TODO 848, 7.7). GET only; the plugin can pass neither headers nor a body.
 * It does not render (it returns the body HTML / JSON as is; JS does not run).
 */
export interface BrokerBrowserFetchPageRequest {
  readonly capability: 'browser'
  readonly op: 'fetchPage'
  readonly url: string
}

/** TODO 1039: replaces the rows of the sidebar list wholesale. Main validates (shape, count, depth, URI scheme). */
export interface BrokerUiSidebarRowsRequest {
  readonly capability: 'ui'
  readonly op: 'setSidebarRows'
  readonly rows: readonly PluginSidebarRow[]
}

/** TODO 1038: a report of sync progress. With `state: 'done'` the badge disappears. */
export interface BrokerUiStatusRequest extends PluginSyncReport {
  readonly capability: 'ui'
  readonly op: 'reportStatus'
}

/**
 * TODO 1216: reports one event. The Broker checks the declaration (`triggers[].id`) and consent; main's `TriggerService`
 * checks duplicates, rules and limits. The return value is `TriggerEmitResult`.
 */
export interface BrokerTriggersEmitRequest {
  readonly capability: 'triggers'
  readonly op: 'emit'
  readonly event: PluginTriggerEvent
}

/**
 * TODO 1225 (7.2.1): reads its own settings values. There is no argument: whose values they are is decided by the plugin-host's connection (the id main knows), and
 * the settings of other extensions cannot be read.
 */
export interface BrokerSettingsGetRequest {
  readonly capability: 'settings'
  readonly op: 'get'
}

export type BrokerRequest =
  | BrokerSettingsGetRequest
  | BrokerFsReadRequest
  | BrokerNetFetchRequest
  | BrokerCredentialsStatusRequest
  | BrokerIndexPutRequest
  | BrokerIndexRemoveRequest
  | BrokerUiNotifyRequest
  | BrokerUiSidebarRowsRequest
  | BrokerUiStatusRequest
  | BrokerBrowserFetchPageRequest
  | BrokerTriggersEmitRequest
  | BrokerGitRequest

/** A document the plugin puts into the index (the part of 6.3's Document that the plugin decides). */
export interface PluginDocumentInput {
  readonly source: string
  readonly sourceId: string
  readonly title: string
  readonly uri: string
  readonly body: string
  readonly updatedAt?: number
}

export interface BrokerFsReadResult {
  /** `binary` if there is a NUL in the first 8 KB of the range read. */
  readonly kind: 'text' | 'binary'
  /** Only for `encoding: 'utf8'` and `kind: 'text'`. A character may be cut in the middle of the range (use `bytes` for range reads). */
  readonly text?: string
  /** Only for `encoding: 'bytes'`. The range read itself (C-1). */
  readonly data?: Uint8Array
  /** The size of the whole file (bytes). */
  readonly bytes: number
  /** The start of the range read (C-1). */
  readonly offset: number
  /** The length read (bytes, C-1). */
  readonly length: number
  /** There is more after the range (`offset + length < bytes`). */
  readonly truncated: boolean
  /** The mtime from `fstat` on the **same fd** the body was read from (TODO 853). If taken by opening again separately, an outside rewrite in between would make it disagree with the body. */
  readonly mtimeMs: number
  /**
   * `kind: 'text'` and it contains a byte sequence that is invalid as UTF-8 (Shift_JIS, etc., TODO 851). `text` contains U+FFFD, and
   * writing it back would lose the original bytes. A character cut in the middle at the end of truncation is not counted.
   */
  readonly invalidUtf8?: boolean
}

export interface BrokerNetFetchResult {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /**
   * The response body **as bytes** (C-3). Converting to text is done by the plugin with `TextDecoder`
   * (the encoding is decided by looking at `content-type`). The 8 MB limit is also counted in bytes.
   */
  readonly body: Uint8Array
  readonly truncated: boolean
}

/** The result of `browser.fetchPage` (TODO 848). The body is a string (read with the charset of `content-type`; UTF-8 if none). */
export interface BrokerBrowserFetchPageResult {
  readonly status: number
  /** The URL after following redirects (every hop is within the declared hosts). */
  readonly url: string
  /** The type part of `content-type` (such as `text/html`, lower case, without parameters). */
  readonly contentType: string
  readonly text: string
  /** Cut at the limit (`MAX_BROWSER_PAGE_BYTES`). */
  readonly truncated: boolean
}

/** The result of the display conversion of images (TODO 1154 / 1162 / 1173). The one type shared by main's `convertForDisplay` family and `viewer.convertImageForDisplay`. */
export type ViewerImageConversion =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly contentType: 'image/jpeg' }
  | { readonly ok: false; readonly reason: 'unsupported-platform' | 'failed' | 'too-large' }

/** One row of the audit log (chapter 8). **Values are not kept**: only up to the path / host / source name. */
export interface AuditEntry {
  readonly at: number
  readonly pluginId: string
  readonly capability: string
  readonly op: string
  /** Path / host / source. Body text and argument values are not put in (the convention of chapter 7). */
  readonly target: string | null
  readonly decision: 'allow' | 'deny'
  readonly reason: string | null
  readonly ms: number | null
}

// ---- Messages between the viewer (iframe) and the ViewerPane (host) ----

/**
 * host -> viewer. **The viewer has no I/O** (5.2), so the contents always arrive here.
 * The route is a MessageChannel port, which the host passes just once right after load.
 */
export type ViewerHostMessage =
  | {
      readonly type: 'resource'
      readonly uri: string
      /** The display name. **No absolute path is passed** (the convention of chapter 7). */
      readonly label: string
      /** `bytes` is converted by the bridge to `binary` (a `blob:` URL) before being given to the viewer (TODO 905). */
      readonly resource: ViewerWirePayload
      readonly editable: boolean
      /**
       * The color theme (7.4.1). The iframe is a different origin, so the parent's CSS variables do not reach it, and
       * constraint 8 forbids the viewer from reading the parent's DOM. So the host passes the name.
       * The host resends this message when only the theme changes, too.
       */
      readonly theme: Theme
      /**
       * The display language (7.4.4, TODO 66). As with the theme, only the **name** is passed. The viewer looks up the small dictionary in
       * `plugins/_shared/i18n.ts` (the renderer's dictionary cannot be used because of the boundary check).
       * The host resends this message when only the language changes, too.
       */
      readonly locale: Locale
      /**
       * The term of the search within a file (TODO 56). Present only when opened from a search hit. The viewer
       * splits it into words by whitespace and highlights the matches. If absent, it does nothing.
       */
      readonly highlightQuery?: string
      /**
       * App shortcuts that the viewer should send back to the host when pressed inside it (item 189, wave 14 bundle D).
       * When the iframe (OOPIF) has focus, the parent's `keydown` does not receive them, so the bridge looks in the **capture phase**
       * and on a match calls `preventDefault` + `stopPropagation` and returns `{ type: 'shortcut', id }`.
       * **The table has one owner, the renderer's `shortcuts.ts`** (plugins cannot import the renderer:
       * constraint 8). Keys the viewer uses itself (such as the editor's Cmd+F) are removed from this table by the host before passing it.
       * Omitted = nothing is sent.
       */
      readonly shortcuts?: readonly ViewerShortcut[]
      /**
       * The keys currently in effect for commands inside the viewer's editor (TODO 692, go to declaration F12 / list assignments and uses Shift+F12).
       * The values are key strings of `src/shared/keybindings.ts` (`Shift+F12`). **The table is owned by the renderer** (the user can change it in
       * settings). The viewer builds them into CodeMirror's keymap with `codeMirrorKeysOf`. A command whose assignment was removed is not included.
       * Separate from `shortcuts` (send-back): these are keys the viewer takes itself. Omitted = the default keys.
       */
      readonly editorKeys?: Readonly<Partial<Record<ViewerKeybindingCommandId, string>>>
      /**
       * The version of the contents (item 309-2 / 303, wave 16 bundle I). A number the host advances on every read, save and re-read,
       * and it does **not change on a resend** for a theme / language / search term change or on `ready`. For the same URI and the same version the viewer
       * does not replace the body, and keeps the draft, cursor and line markers (`plugins/_shared/resource-update.ts`).
       * Omitted = unknown (the viewer replaces the body by comparing contents).
       */
      readonly revision?: number
      /**
       * The unsaved draft of this file that the host remembered (a small observation of TODO 312, wave 18 bundle B).
       * Present only when the user moved to another file while holding a draft and came back. The viewer shows this in the editor
       * instead of the body. **`resource.text` stays the contents on disk** (the heading list of aios.markdown decides whether to use the plugin-host's result by checking
       * whether "the current body = the body on disk", item 318).
       * The rule for the version (`revision`) is unchanged: on a resend with the same version the viewer does not touch the body.
       * Omitted = no draft.
       */
      readonly draft?: string
    }
  /**
   * Bring this line of the displayed file into view and mark it (item 273). From `foo.ts:42` / `#L42` in a body link
   * and `line` of the gateway's `openFile`. It is a **one-shot instruction**, so it is not put in
   * `resource`: `resource` is resent whenever the theme / language changes, and putting it there would
   * jump again every time. The host sends it once, keyed by a per-instruction number (the store's `revealLine.nonce`),
   * and only after sending `resource` (the order is kept because it is on the same port). `uri` is the file the host
   * is giving the viewer now, and the viewer discards it if it differs from what it is displaying.
   * Line / column are 1-based, and the viewer clamps them to the range of the body.
   */
  | {
      readonly type: 'reveal'
      readonly uri: string
      readonly line: number
      readonly column?: number
    }
  /**
   * Insert a string at the cursor position of the displayed file (TODO 366, wave 20 bundle E / TODO 407, wave 21 bundle B). The host turns a file
   * dropped on the viewer into a string (`aios.markdown` uses a Markdown link, others use the raw full path:
   * `dropInsertFormat` in `shared/drop-link.ts`), and only what passed main's choke point (`assertAllowed`) is included.
   * **The viewer does not know absolute paths by itself**: it knows only this string. The insertion point is the **caret** (the head of the main selection.
   * It was changed from "where it was dropped" (`posAtCoords`) in 407, so no coordinates are included). As with `reveal`, `uri` is discarded if it differs from
   * what the viewer is displaying. Nothing happens in a view that accepts no edits (Markdown preview, read-only). A one-shot instruction.
   */
  | {
      readonly type: 'insert-text'
      readonly uri: string
      readonly text: string
    }
  | { readonly type: 'command-result'; readonly id: string; readonly result: unknown }
  | { readonly type: 'command-error'; readonly id: string; readonly message: string }
  /**
   * Re-center on the search hit (TODO 446, wave 23 bundle G). The host sends it once each time a body search result is pressed
   * (as with `reveal`, a one-shot instruction not put in `resource`, which is resent on theme / language changes). When the same hit of the same
   * file is pressed again, `resource` is not sent because it has the same contents, and only this arrives. The viewer reapplies the current search term
   * (`resource.highlightQuery`), makes the first match in the document the current one, and shows it in the center. `uri` is discarded if it differs from
   * what the viewer is displaying.
   */
  | { readonly type: 'recenter'; readonly uri: string }
  /**
   * Show this page of the displayed file (TODO 1009 stage 2, a PDF body search hit). The page version of `reveal`'s line, and likewise
   * a **one-shot instruction**: it is not put in `resource`, and the host sends it once after `resource`, keyed by a per-instruction number (the store's `viewerLine.nonce`).
   * `uri` is discarded if it differs from what the viewer is displaying. `page` is 1-based, and the viewer clamps it to the range.
   */
  | { readonly type: 'reveal-page'; readonly uri: string; readonly page: number }
  /**
   * Open the symbol list of the displayed file (TODO 468, wave 23 bundle F). From the button in the ViewerPane heading. The host shows the button
   * only for files the viewer reported as having symbols via `symbols`. As with `reveal`, `uri` is discarded if it differs from what the viewer is
   * displaying. A one-shot instruction.
   */
  | { readonly type: 'open-symbols'; readonly uri: string }
  /**
   * The right-click menu's "Go to declaration" / "List assignments and uses" (TODO 692). The host shows these two only when the viewer reported `codeNav: true`
   * with `context-menu`, and sends this when one is chosen. `uri` is discarded if it differs from what the viewer is displaying.
   * The target is the name at the right-clicked position (which the viewer remembers). A one-shot instruction.
   */
  | { readonly type: 'code-nav'; readonly uri: string; readonly action: CodeNavAction }
  /**
   * Switch the view (TODO 969, ARCHITECTURE 7.4.12). Chosen with the host heading's "view switch" (`SegmentedControl`).
   * `mode` is one of those the viewer reported with `view-modes` (the host's vocabulary `ViewerViewMode`). `uri` is discarded if it differs from
   * what the viewer is displaying. The viewer switches, redraws, and resends `view-modes`. A one-shot instruction.
   */
  | { readonly type: 'set-view-mode'; readonly uri: string; readonly mode: ViewerViewMode }
  /**
   * Restore the previous position (TODO 1146). When the viewer's back / forward (arrows) returns to this file, this returns the position the viewer reported earlier with
   * `scroll-position`. A **one-shot instruction** like `reveal`: it goes through the same sending path (the store's `viewerLine`) and arrives
   * once after `resource`. `uri` is discarded if it differs from what the viewer is displaying. Clamping to the range is done by the viewer
   * (which knows the number of lines / pages). The viewer ignores an unknown `kind` (a viewer with no notion of position does nothing).
   */
  | { readonly type: 'restore-position'; readonly uri: string; readonly position: ViewerScrollPosition }

/** Go to declaration / list assignments and uses (TODO 692). */
export type CodeNavAction = 'declaration' | 'references'

/**
 * The unit of a document's display position (TODO 1146, ARCHITECTURE 5.3 "viewer back / forward"). The meaning is decided per viewer:
 * `line` is the topmost line on screen (1-based, `aios.text`), `page` is the page (1-based, `aios.pdf` in stage 2),
 * `offset` is the vertical scroll amount (CSS px, an integer of 0 or more, the `aios.markdown` preview in stage 2).
 */
export type ViewerScrollPositionKind = 'line' | 'page' | 'offset'

/**
 * A document's display position (TODO 1146). The viewer reports it to the host with `scroll-position`, and the host returns it with `restore-position`.
 * The host does not interpret the contents; it only keeps it per URI (together with the back / forward history, left in main). Validation is in `shared/viewer-position.ts`.
 */
export interface ViewerScrollPosition {
  readonly kind: ViewerScrollPositionKind
  readonly value: number
}

/**
 * The response to a viewer command (`window.aios.viewer.command`) (item 149). **Failure is also returned as a value.**
 * Electron writes a rejection of `ipcMain.handle` to main's log as `Error occurred in handler`.
 * An old request being refused by the Broker (`no-grant`) because of a mix-up while switching is an ordinary failure that can
 * happen, and the refusal itself is left in the audit (`broker.denied`), so it is not sent to the log.
 * It reaches the viewer side as `command-error` as before.
 */
export type ViewerCommandResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly message: string }

/**
 * viewer -> host. Only edited contents, command requests, and "please open in the external browser".
 * It has no means of writing.
 *
 * `open-external` is a **request**, not a permission: the host (ViewerPane) passes it to main's IPC, and
 * main re-validates it, narrowing to `http:` / `https:` / `mailto:` (5.1 "external links").
 * The iframe has only `sandbox="allow-scripts"` and no `allow-popups`, so even if the viewer
 * uses `target="_blank"` or `window.open` itself, nothing happens (constraint 8).
 */
export type ViewerGuestMessage =
  | { readonly type: 'ready'; readonly pluginId: string }
  /**
   * The edited body. `uri` is the file the viewer was drawing that body for (TODO 938). The host accepts it only when it equals the URI of the `resource` it sent most recently
   * (so that, right after a switch, the previous file's body does not become the next file's draft).
   */
  | { readonly type: 'draft'; readonly uri: string; readonly text: string }
  | { readonly type: 'command'; readonly id: string; readonly command: string; readonly arg?: unknown }
  | {
      readonly type: 'open-external'
      readonly url: string
      /**
       * The modifier keys of the click (TODO 400). A plain click on an `http(s)` link is sent by the host to the ViewerPane's web view,
       * and shift / Cmd (Ctrl) to the OS browser. If absent, a plain click.
       */
      readonly shiftKey?: boolean
      readonly metaKey?: boolean
      readonly ctrlKey?: boolean
    }
  /**
   * Please open a link in the body (relative, scheme-less, `file:`) (item 254). The viewer does not resolve it: the host
   * passes it to main's `fs.resolveLink` relative to the displayed file, and main checks the choke point and existence and opens it.
   */
  | { readonly type: 'open-link'; readonly href: string }
  /**
   * One of `ViewerHostMessage.shortcuts` was pressed (item 189). `id` is a copy of the value the host passed, and
   * the host discards an id not in its own table (the viewer's value is not trusted).
   */
  | { readonly type: 'shortcut'; readonly id: string }
  /**
   * A file drag entered over the viewer (iframe) (TODO 366). Drag events over an iframe (OOPIF) never reach
   * the parent, so the host cannot notice a drag that went straight from outside the window onto the viewer. On receiving this, the host
   * puts a transparent cover over the iframe and receives later dragover / drop itself. **A notification only**: neither the file itself nor
   * a path is included (the viewer does not know absolute paths).
   */
  | { readonly type: 'drag-files' }
  /**
   * The cover was too late, and a file drop landed inside the viewer (iframe) (TODO 407, wave 21 bundle B). The viewer only sends the dropped `File`
   * back to the host **as is** (by structured clone), and neither reads nor inserts it. The host passes it, like a drop it received itself, through
   * preload's `drop.uriFor` -> main's `drop.checkLinks`. The path of a `File` cannot be read from JS, and
   * a fabricated `File` has no path (`getPathForFile` is empty), so a plugin cannot claim an arbitrary path here.
   * The type is `unknown` (the contents are a `File`) so that it does not depend on the DOM. The host accepts it only during a drag (while the cover's watcher is alive).
   * TODO 429: when the viewer sees a drop inside the iframe it sends this even with 0 `File`s (`count` = the number seen, for telling cases apart in logs).
   * If structured cloning a `File` fails, only the count is sent as `files: []` + `cloneFailed: true` (no name or path is included).
   */
  | {
      readonly type: 'drop-files'
      readonly files: readonly unknown[]
      readonly count?: number
      readonly cloneFailed?: boolean
    }
  /**
   * The selection changed (item 97, 7.4.5). `uri` is the file the viewer is displaying (a copy of the value the host passed), and
   * the host discards it if it differs from what it is displaying (a mix-up while switching). `null` means no selection.
   * **A notification only**: the host just keeps it as a candidate for attaching to a submission (it is not saved).
   */
  | {
      readonly type: 'selection'
      readonly uri: string
      readonly selection: ViewerSelectionRange | null
    }
  /**
   * The page being viewed changed (TODO 1061 part 2, `aios.pdf`). `page` is 1-based. `uri` is the file the viewer is displaying
   * (a copy of the value the host passed), and the host discards it if it differs from what it is displaying (the same shape as `selection`). **A notification only**: the host
   * keeps it as the window's "display state" and puts it in `inView.page` of the gateway's `listOpenFiles`. The body is not included.
   */
  | { readonly type: 'page'; readonly uri: string; readonly page: number }
  /**
   * The position being viewed changed (TODO 1146). The viewer throttles it on every scroll (the bridge's `reportScrollPosition`) and
   * sends it. `uri` is the file the viewer was drawing that position for (a copy of the value the host passed). The host accepts it only for URIs that are in the
   * back / forward history of the displayed conversation, remembers it per URI, and leaves it in main (the body is not included). When back / forward returns to this file,
   * it comes back with `restore-position`. **A notification only**.
   */
  | { readonly type: 'scroll-position'; readonly uri: string; readonly position: ViewerScrollPosition }
  /**
   * Please open with the OS's default app (TODO 405, the `.avi` of `aios.video`). From the guidance for formats that Chromium
   * cannot play. `uri` is the file the viewer is displaying (a copy of the value the host passed), and the host discards it if it differs from what it is
   * displaying (a mix-up while switching, the same shape as `open-link` / `selection`). Main re-validates and then opens with
   * `shell.openPath`. The viewer does not know the path.
   */
  | { readonly type: 'open-default-app'; readonly uri: string }
  /**
   * Please open a file inside an archive (zip) as a temporary view (TODO 905, `aios.zip`). The viewer sends the contents it extracted itself
   * **as is** (by port transfer). **A request, not a permission**: the host only shows bytes the viewer already holds
   * in a temporary view with no URI (7.4.6), and no permission to read files is added. `uri` is the archive the viewer is displaying
   * (a copy of the value the host passed; an empty string inside a temporary view), and the host discards it if it differs from what it is displaying. `name` is the path
   * inside the archive as is (including `../`). The host looks up the viewer by the last element only, and re-checks the size against `MAX_TRANSIENT_FILE_BYTES`.
   */
  | { readonly type: 'open-entry'; readonly uri: string; readonly name: string; readonly data: Uint8Array }
  /**
   * Please show these two texts in the diff view (TODO 834 stage 1, `aios.git`: one change picked from the Source Control list). **A request, not a
   * permission**: the viewer already holds both texts (it read them through its own capability), and the host only puts them into the temporary
   * diff view (7.4.6, `aios.diff`). `uri` is what the viewer is displaying (a copy of the value the host passed); the host discards it if it differs, and
   * re-checks the shape and sizes (`MAX_GUEST_DIFF_CHARS`).
   */
  | {
      readonly type: 'open-diff'
      readonly uri: string
      readonly before: DiffSide
      readonly after: DiffSide
      readonly layout?: DiffLayout
    }
  /**
   * The focus of a search field inside the viewer (such as the Cmd+F field) changed (TODO 463, wave 23 bundle C). **A notification only**: the host
   * (renderer) receives it, folds it into the window's "does a search field have focus", and reports it to main, and main decides
   * whether to switch the input source. No capability is passed to the plugin. The host treats a non-boolean value as false.
   */
  | { readonly type: 'search-focus'; readonly focused: boolean }
  /**
   * Whether the displayed file has a symbol list (TODO 468, wave 23 bundle F). The viewer sends it each time the language pack is applied again.
   * The host accepts it only when `uri` equals what it is displaying, and if `available` shows a "Go to symbol" button in the heading.
   * **A notification only**: the symbols themselves are not included (the list is self-contained in the viewer).
   */
  | { readonly type: 'symbols'; readonly uri: string; readonly available: boolean }
  /**
   * Whether the current view accepts edits (a drop's insertion = `insert-text`) (TODO 587, wave 28 bundle D). Sent by a viewer that switches views
   * (the Source / Preview of `aios.markdown` / `aios.html`) each time it redraws. The host accepts it only when `uri` equals what it is displaying, and while
   * `accepts: false`, a drop on the viewer is turned into "open" instead of insertion (the same as the non-editing viewer of 563). **A notification only**: a viewer that does not send it
   * is decided by the host's `editable` as before.
   */
  | { readonly type: 'accepts-edits'; readonly uri: string; readonly accepts: boolean }
  /**
   * The selectable views and the current view (TODO 969, ARCHITECTURE 7.4.12). Sent by a viewer that switches views (the Source / Preview of `aios.markdown` / `aios.html`,
   * and in TODO 1200 the interpolation Nearest / Bilinear of `aios.image` / `aios.video`) each time it redraws.
   * One message carries only one group of the vocabulary (`viewModeGroup`). The host accepts it only when `uri` equals what it is displaying, and if there are 2 or more, shows a switch in the heading
   * using the same component as the Composer's Model selector. **The values are only the host's vocabulary (`ViewerViewMode`)**: the wording is looked up in the host's dictionary
   * and the plugin's strings are not shown in the heading. An empty array = no switch. **A notification only**.
   */
  | {
      readonly type: 'view-modes'
      readonly uri: string
      readonly modes: readonly ViewerViewMode[]
      readonly current: ViewerViewMode
    }
  /**
   * A right-click on selected text inside the viewer (TODO 630). **A notification only**: whether to put the selected term into the body search
   * (Cmd+Shift+F) and run it is decided by the host (a plugin does not call search directly, constraint 8).
   * A right-click with no selection is not sent (nothing happens, as before). But for a name (`codeNav`) of TODO 692 it is
   * sent even with no selection (`text` is empty). `uri` is the file the viewer is displaying
   * (a copy of the value the host passed), and the host discards it if it differs from what it is displaying (the same shape as `selection`).
   * `x` / `y` are coordinates inside the iframe (`MouseEvent.clientX` / `clientY`). The host adds the iframe's
   * `getBoundingClientRect()` to convert them to host coordinates. `text` is the selected string as is
   * (only an oversized selection is cut with `clipSelectionText`); shortening multiple lines to the first line is the host's job.
   */
  | {
      readonly type: 'context-menu'
      readonly uri: string
      readonly x: number
      readonly y: number
      readonly text: string
      /**
       * Whether the right-clicked position is on a name for which go to declaration / list assignments and uses are available (TODO 692). If true the host adds those
       * two to the menu (sent even if `text` is empty). Omitted = false.
       */
      readonly codeNav?: boolean
    }

/**
 * One shortcut sent back from the viewer to the host (item 189). Modifiers are compared by **exact match**
 * (Cmd+P and Cmd+Shift+P are distinguished). `key` is a single character folded to lower case, or a `KeyboardEvent.key` name.
 */
export interface ViewerShortcut {
  readonly id: string
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  /** The physical key of a row with Alt (TODO 589, `KeyboardEvent.code`). If present, it is matched with this instead of `key`. */
  readonly code?: string
  /**
   * A mouse button (TODO 369, the viewer's back / forward). A row with this set is matched not against a key but against the
   * mouse button released inside the viewer (`button` of `mouseup`, 3 = back / 4 = forward). `key` is empty. Omitted = a key row.
   */
  readonly button?: number
}

/**
 * The viewer's selection range (item 97). Line numbers are 1-based and inclusive at both ends. null for a view where
 * lines are not known (the Markdown preview). The body is cut at `MAX_SELECTION_TEXT` characters, and if cut,
 * `truncated`.
 */
export interface ViewerSelectionRange {
  readonly text: string
  readonly fromLine: number | null
  readonly toLine: number | null
  readonly truncated: boolean
}

/**
 * Upper limit of the selection body (characters, item 97). So that selecting everything does not send a 256 KB body back and forth over the port and IPC
 * and straight into the prompt, the same value is used to cut in three places: viewer, host and main.
 */
export const MAX_SELECTION_TEXT = 20_000

/** The contents passed to the viewer. The same shape as `ViewerResource`, but placed where plugins can refer to it. */
export type ViewerPayload =
  | { readonly kind: 'text'; readonly text: string; readonly truncated: boolean; readonly size: number }
  | { readonly kind: 'binary'; readonly resourceUrl: string; readonly size: number }
  | { readonly kind: 'error'; readonly message: string }
  | DiffPayload

/**
 * A shape only on the host -> bridge port (TODO 905). The temporary view of a file inside a zip has no URL, so the host passes the contents'
 * bytes as is, and **the bridge converts them to a `blob:` URL inside the iframe** and passes them to the viewer as `binary`
 * (the viewer just fetches `resourceUrl` / uses `<img src>` as before). The viewer never sees this shape.
 * `mime` is for when a type is needed, as for an SVG in `<img>` (`transientFileMime`).
 */
export interface ViewerBytesPayload {
  readonly kind: 'bytes'
  readonly data: Uint8Array
  readonly size: number
  readonly mime: string | null
}

/**
 * A marker for "the same bytes sent earlier on the same port" (code-review of TODO 905). So that up to 64 MB is not duplicated every time on a resend for theme / language / key assignment changes,
 * the host sends this from the second time. The bridge uses the previous `blob:` URL as is
 * (`error` if it does not hold the previous bytes).
 */
export interface ViewerBytesRefPayload {
  readonly kind: 'bytes-ref'
  readonly size: number
}

/** The contents that flow over the port (`ViewerPayload` + `ViewerBytesPayload` + `ViewerBytesRefPayload`). */
export type ViewerWirePayload = ViewerPayload | ViewerBytesPayload | ViewerBytesRefPayload

/**
 * Upper limit of file contents passed to a temporary view (bytes, TODO 905). The same as the limit after extraction when opening one entry in a zip.
 * The host (renderer) re-validates the bytes that arrived from the viewer with this.
 */
export const MAX_TRANSIENT_FILE_BYTES = 64 * 1024 * 1024

/** Upper limit of the length of a temporary-view file name (the path inside a zip) (characters). */
export const MAX_TRANSIENT_FILE_NAME = 4096

/**
 * One side of a diff (item 104). **The body is passed only for display and saved nowhere** (constraints 9 / 10).
 * `name` is the display name (no absolute path). `language` is a language hint (such as `typescript`);
 * if absent it is derived from the extension of `name`.
 */
export interface DiffSide {
  readonly name: string
  readonly text: string
  readonly language: string | null
}

/** How a diff is laid out (item 104): one column (`unified`) / side by side (`split`). */
export type DiffLayout = 'unified' | 'split'

/** The two sides, before and after (item 104). A temporary view the host passes directly, with no URI. */
export interface DiffPayload {
  readonly kind: 'diff'
  readonly before: DiffSide
  readonly after: DiffSide
  /**
   * The initial layout (TODO 826). A diff opened by the AI (the gateway's `openDiff`) is `split`. If absent, the viewer keeps its
   * current layout (the default is one column). The viewer follows this only when the contents change, and on a resend of the same contents (such as a theme switch)
   * it keeps the layout the user switched to.
   */
  readonly layout?: DiffLayout
}

/**
 * Upper limit of one side for computing a diff (UTF-8 bytes, item 104). If either exceeds this,
 * the character diff is not computed and the two sides are shown side by side (changed lines are still marked by a coarse line diff and
 * can be jumped to, TODO 1339). Raised from 256 KB to 1 MB in TODO 1339: above 32 KB characters the viewer diffs by lines
 * (a linear-time pass), so the size no longer costs a stall (numbers in docs/notes/wave106.md).
 */
export const MAX_DIFF_BYTES = 1024 * 1024

/**
 * Upper limit of one side of a diff a viewer asks the host to open (`open-diff`, TODO 834 stage 1), in characters. Above `MAX_DIFF_BYTES` the diff
 * view only lays the two side by side; this only stops a viewer from pushing an unbounded string through the port and the store.
 */
export const MAX_GUEST_DIFF_CHARS = 4 * 1024 * 1024

/** Whether `text` exceeds the diff limit. A short string is judged without encoding (one character is at most 3 bytes). */
export function exceedsDiffLimit(text: string): boolean {
  if (text.length * 3 <= MAX_DIFF_BYTES) return false
  if (text.length > MAX_DIFF_BYTES) return true
  return new TextEncoder().encode(text).length > MAX_DIFF_BYTES
}

/** The scheme of `aios-plugin://<id>/<path>` and the constants used for its permission decision. */
export const PLUGIN_SCHEME = 'aios-plugin:'

/**
 * TODO 1144 stage 3 (ARCHITECTURE 8.5.1): the marker of the version segment placed in a viewer's URL. `aios-plugin://<id>/@<version>/<entry>`.
 * A viewer's bundle uses relative imports (`base: './'`), so chunks loaded lazily later also come from under the same `@<version>/`:
 * even after the extension is updated, a viewer that is still open can be served from the directory of the version it was opened with.
 */
export const PLUGIN_REVISION_PREFIX = '@'

/** The URL of the viewer's entry point (with the version segment). `version` is the manifest's version (it is encoded and put in even if it is not x.y.z). */
export function pluginViewerUrl(id: string, version: string, entry: string): string {
  return `${PLUGIN_SCHEME}//${id}/${PLUGIN_REVISION_PREFIX}${encodeURIComponent(version)}/${entry}`
}

// ---- The API visible to code that plugins write (implemented by the plugin-host) ----

/**
 * The API the plugin-host gives to plugins. **What is here is all of the capabilities, and
 * there is no direct I/O**: every one is converted into a request to the CapabilityBroker (7.7).
 *
 * This is the shape that goes outside when an SDK is published in the future (milestone 8).
 */
export interface PluginApi {
  readonly fs: {
    /**
     * Only a URI the user opened, or the scope declared in the manifest, can be read (7.7).
     * Binary (such as a PDF) is read in ranges with `{ encoding: 'bytes', offset, length }` (C-1).
     */
    read(uri: string, options?: BrokerFsReadOptions): Promise<BrokerFsReadResult>
  }
  readonly net: {
    /**
     * `auth` is the **name** of a credential. The Broker attaches the value. The plugin cannot hold the value.
     * The response's `body` is bytes (C-3).
     */
    fetch(
      url: string,
      init?: {
        method?: string
        headers?: Record<string, string>
        body?: string | Uint8Array
        auth?: string
      }
    ): Promise<BrokerNetFetchResult>
  }
  readonly credentials: {
    /** Only presence and the host bound to it. **The value is not returned.** */
    status(name: string): Promise<{ present: boolean; host: string | null }>
  }
  readonly index: {
    put(document: PluginDocumentInput): Promise<void>
    remove(source: string, sourceId: string): Promise<void>
  }
  readonly ui: {
    notify(title: string, body?: string): Promise<void>
  }
  /** TODO 1039: the sidebar list. Only row data is passed (the host draws it). Requires the manifest's `sidebarView` and `ui.sidebar`. */
  readonly sidebar: {
    setRows(rows: readonly PluginSidebarRow[]): Promise<void>
  }
  /** TODO 1038: sync progress (requires the `ui.status` declaration). Shown in the BottomBar next to the index badge. */
  readonly status: {
    report(report: PluginSyncReport): Promise<void>
  }
  readonly browser: {
    /**
     * Fetches a page in the logged-in Web view session (TODO 848). Only within the manifest's `browser.hosts`;
     * the same for redirect destinations. The first use requires the user's consent. HTML / JSON / text only.
     */
    fetchPage(url: string): Promise<BrokerBrowserFetchPageResult>
  }
  /**
   * TODO 1216 (6.2.6): reports an event. Requires the manifest's `triggers` declaration. aios drops duplicates, and if the rule is enabled
   * starts one unattended conversation per event. Do not put the body in `prompt` (references only; the model fetches the body with a read tool).
   */
  readonly triggers: {
    emit(event: PluginTriggerEvent): Promise<TriggerEmitResult>
  }
  /**
   * TODO 1225 (7.2.1): the values the user decided for the fields declared in the manifest's `configuration` (the default if none). **Only its own.**
   * The current values are returned on every call (if the user changes them, they take effect from the next call). `{}` if there is no declaration.
   */
  readonly settings: {
    get(): Promise<PluginSettingValues>
  }
  /**
   * TODO 834 stage 1: read-only git operations on a folder the user opened in the Source Control view (`plugin-git.ts`). Requires the manifest's
   * `capabilities.git.read`. The plugin states the intent; main builds argv, attaches the fixed safe flags and checks every path.
   */
  readonly git: PluginGitApi
}

/** One handler the plugin-host calls. **The only privilege is the argument `api`.** */
export type PluginHandler = (arg: unknown, api: PluginApi) => unknown | Promise<unknown>

/**
 * The shape that a plugin's implementation (`host.entry`) exports. **The only privileges are what is passed as arguments.**
 *
 * There is one entry point, and roles are separated by exports (review C-4). Either a default export or named exports will do
 * (if there is a default, it is looked at). Main names it with `PluginHost.invoke(id, name, arg, kind)`, and
 * **main does not call a kind or command that the manifest does not declare**.
 */
export interface PluginModule {
  activate?(api: PluginApi): void | Promise<void>
  /** The implementation for each `command.commands[].id`. */
  commands?: Record<string, PluginHandler>
  /** Tools exposed to the model (name -> implementation, TODO 847). The same names as `mcp.tools[].name`. The arguments are values after main validated them against the schema. */
  mcp?: Record<string, PluginHandler>
  /** The indexer. Calls `sync` every `indexer.interval` (the scheduler is Phase 5). */
  indexer?: { sync?: PluginHandler }
  /**
   * Scheduled tasks (`scheduledTasks[].id` -> implementation, TODO 952 stage 1). The argument is `PluginTaskArg` and the return value is `PluginTaskResult`.
   * Only aios's `JobScheduler` calls it (a plugin has no timers of its own).
   */
  tasks?: Record<string, PluginHandler>
  /**
   * A search section (TODO 896). The argument of `query` is `PluginSearchArg` and the return value is `PluginSearchReturn`
   * (`src/shared/plugin-search.ts`). It is called only when the user searches in the section of the search sidebar.
   */
  search?: { query?: PluginHandler }
}

/** TODO 920: upper limit of the length of a plugin's index source (the length that holds `<plugin id>:<name>`; an id is at most 64). */
export const MAX_PLUGIN_INDEX_SOURCE = 128

/** Built-in index sources (a plugin cannot claim them). */
export const BUILTIN_INDEX_SOURCES: ReadonlySet<string> = new Set(['fs', 'conversation', 'transcript'])

/**
 * TODO 920 (owner decision 2026-10-24, (a)): the index sources a plugin may write are **only in its own id's namespace**:
 * `<id>` itself, or `<id>:<name>` / `<id>/<name>` (the name is lower-case letters, digits, `.` `_` `-`).
 * The built-in `fs` / `conversation` / `transcript` and other plugins' documents cannot be written even if declared.
 * A plugin id contains neither `:` nor `/` (the form of the manifest's ID), so `aios.mail.evil` cannot enter the namespace of `aios.mail`.
 * Both manifest validation (`index.write`) and the Broker's decision (`index.put` / `index.remove`) use this.
 */
export function indexSourceOwnedBy(pluginId: string, source: string): boolean {
  if (source.length === 0 || source.length > MAX_PLUGIN_INDEX_SOURCE) return false
  if (source === pluginId) return true
  const prefixLength = pluginId.length + 1
  if (!source.startsWith(pluginId) || source.length <= prefixLength) return false
  const separator = source[pluginId.length]
  if (separator !== ':' && separator !== '/') return false
  return /^[a-z0-9][a-z0-9._-]*$/.test(source.slice(prefixLength))
}
