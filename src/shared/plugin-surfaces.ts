/**
 * Common types of the "surfaces" a plugin shows to the host (TODO 1039 / 1038, ARCHITECTURE.md 7.5).
 *
 * - Sidebar list (1039): the plugin passes row data through the Broker, and **the host (renderer) draws it**.
 *   Modeled on VS Code's `viewsContainers` / `views` / `TreeDataProvider`; selecting a row opens a URI of the plugin's own viewer.
 * - Sync progress (1038): the plugin reports `{ done, total, state }`, and the BottomBar shows it next to the index badge.
 *
 * It is not Gmail-specific (Slack / Drive / Calendar use the same entry point). There are no privileges here: only shapes and limits.
 */

/** Upper limit of the number of rows in the list (total over all levels). */
export const MAX_SIDEBAR_ROWS = 500
/** Upper limit of the tree depth (the 2 levels of label > thread plus one spare level). */
export const MAX_SIDEBAR_DEPTH = 3

/** One row of the sidebar list. A row without `uri` is a heading (not selectable, collapsible if it has children). */
export interface PluginSidebarRow {
  /** Unique within the plugin. Used for remembering selection and collapse state. */
  readonly id: string
  readonly label: string
  /** A supplement shown faintly to the right of the row (sender, date, etc.). */
  readonly description?: string
  /** The unread count and the like. 0 is not shown. */
  readonly badge?: number
  /** The URI opened on selection. Main discards it unless it is **one of the `schemes` of that plugin's viewer**. */
  readonly uri?: string
  readonly children?: readonly PluginSidebarRow[]
}

/** The `sidebarView` of the manifest (bundled plugins only). */
export interface SidebarViewDeclaration {
  /** The sidebar heading and the Activity Bar bubble. */
  readonly title: string
}

/** The sync state. `done` means finished (the badge is removed). For the others, the reason is shown on the badge. */
export type PluginSyncState = 'running' | 'paused' | 'offline' | 'rate-limited' | 'needs-reauth' | 'done'

export const PLUGIN_SYNC_STATES: readonly PluginSyncState[] = [
  'running',
  'paused',
  'offline',
  'rate-limited',
  'needs-reauth',
  'done'
]

/** What the plugin reports. `total` is null when it is not known. */
export interface PluginSyncReport {
  readonly done: number
  readonly total: number | null
  readonly state: PluginSyncState
}

export interface PluginSyncStatus extends PluginSyncReport {
  readonly pluginId: string
}

/** The whole that main sends to the renderer (not a diff, always everything). */
export interface PluginSurfacesSnapshot {
  readonly sidebar: readonly {
    readonly pluginId: string
    readonly title: string
    readonly rows: readonly PluginSidebarRow[]
  }[]
  readonly status: readonly PluginSyncStatus[]
}

export const EMPTY_SURFACES: PluginSurfacesSnapshot = { sidebar: [], status: [] }
