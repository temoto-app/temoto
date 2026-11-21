/**
 * Pure functions for a plugin's own sidebar list (TODO 1039) and the sync badge (TODO 1038), and the global subscription coming from main.
 * Rendering is in `components/PluginViewMode.tsx` and `components/PluginSyncBar.tsx`.
 *
 * Row data has been validated by main (shape, count, depth, URI scheme). This only decides the "flat list of visible rows" and the
 * arrow-key behavior, the same as VS Code's Tree View.
 */
import { create } from 'zustand'
import {
  EMPTY_SURFACES,
  type PluginSidebarRow,
  type PluginSurfacesSnapshot,
  type PluginSyncStatus
} from '@shared/plugin-surfaces.js'
import type { ScheduleOverview } from '@shared/schedule.js'
import type { MessageKey } from './i18n/index.js'

export interface VisibleRow {
  readonly row: PluginSidebarRow
  readonly depth: number
  readonly hasChildren: boolean
  readonly expanded: boolean
}

/** The list of visible rows, walking only branches that are not collapsed (depth first). */
export function visibleRows(rows: readonly PluginSidebarRow[], collapsed: ReadonlySet<string>): VisibleRow[] {
  const out: VisibleRow[] = []
  const walk = (list: readonly PluginSidebarRow[], depth: number): void => {
    for (const row of list) {
      const hasChildren = (row.children?.length ?? 0) > 0
      const expanded = hasChildren && !collapsed.has(row.id)
      out.push({ row, depth, hasChildren, expanded })
      if (expanded) walk(row.children ?? [], depth + 1)
    }
  }
  walk(rows, 0)
  return out
}

export type TreeKeyResult =
  | { readonly kind: 'move'; readonly index: number }
  | { readonly kind: 'toggle'; readonly id: string; readonly expand: boolean }
  | { readonly kind: 'activate'; readonly id: string }
  | null

/**
 * Arrow keys of the tree (same as VS Code's Tree View): ↑↓ move, Home/End, → opens (if already open, to the first child),
 * ← closes (if already closed, to the parent), Enter/Space selects (a branch toggles open / closed).
 */
export function treeKey(items: readonly VisibleRow[], index: number, key: string): TreeKeyResult {
  const item = items[index]
  if (item === undefined) return items.length > 0 && (key === 'ArrowDown' || key === 'Home') ? { kind: 'move', index: 0 } : null
  switch (key) {
    case 'ArrowDown':
      return { kind: 'move', index: Math.min(items.length - 1, index + 1) }
    case 'ArrowUp':
      return { kind: 'move', index: Math.max(0, index - 1) }
    case 'Home':
      return { kind: 'move', index: 0 }
    case 'End':
      return { kind: 'move', index: items.length - 1 }
    case 'ArrowRight':
      if (item.hasChildren && !item.expanded) return { kind: 'toggle', id: item.row.id, expand: true }
      return item.hasChildren ? { kind: 'move', index: Math.min(items.length - 1, index + 1) } : null
    case 'ArrowLeft': {
      if (item.hasChildren && item.expanded) return { kind: 'toggle', id: item.row.id, expand: false }
      for (let i = index - 1; i >= 0; i -= 1) {
        if ((items[i]?.depth ?? 0) < item.depth) return { kind: 'move', index: i }
      }
      return null
    }
    case 'Enter':
    case ' ':
      if (item.row.uri === undefined && item.hasChildren) return { kind: 'toggle', id: item.row.id, expand: !item.expanded }
      return { kind: 'activate', id: item.row.id }
    default:
      return null
  }
}

/** The message key and substitutions for the badge text. null for `done`, since no badge is shown. */
export function syncLabel(status: PluginSyncStatus): { key: MessageKey; values: Record<string, string> } | null {
  const values = {
    done: status.done.toLocaleString(),
    total: (status.total ?? 0).toLocaleString()
  }
  switch (status.state) {
    case 'done':
      return null
    case 'running':
      return { key: status.total === null ? 'pluginSync.runningUnknown' : 'pluginSync.running', values }
    case 'paused':
      return { key: 'pluginSync.paused', values }
    case 'offline':
      return { key: 'pluginSync.offline', values }
    case 'rate-limited':
      return { key: 'pluginSync.rateLimited', values }
    case 'needs-reauth':
      return { key: 'pluginSync.needsReauth', values }
  }
}

interface PluginSurfacesState {
  readonly snapshot: PluginSurfacesSnapshot
  /** The plugin shown in the sidebar (chosen with an Activity Bar icon). */
  readonly selectedPluginId: string | null
  select(pluginId: string): void
}

export const usePluginSurfaces = create<PluginSurfacesState>((set) => ({
  snapshot: EMPTY_SURFACES,
  selectedPluginId: null,
  select: (pluginId) => set({ selectedPluginId: pluginId })
}))

let subscribed = false

/** One per window. Fetches the first full state and receives the changes after that. */
export function initPluginSurfaces(): void {
  if (subscribed) return
  subscribed = true
  void window.aios.plugins.surfaces().then(
    (snapshot) => usePluginSurfaces.setState({ snapshot }),
    () => undefined
  )
  window.aios.plugins.onSurfacesChanged((snapshot) => usePluginSurfaces.setState({ snapshot }))
}

/** The part of the schedule entry point that `requestPluginRefresh` uses (tests pass a fake). */
export interface PluginRefreshSchedule {
  list(): Promise<ScheduleOverview>
  runNow(id: string): Promise<unknown>
}

const refreshRequested = new Set<string>()

/**
 * TODO 1264: the first time in this window that a plugin's list is opened while it has no rows yet (right after launch the plugin-host has not run,
 * and an idle task waits 2 minutes), run that plugin's enabled tasks once with the existing "run now" of the scheduled runs. Once per plugin
 * per window; failures (already running, plugin unavailable) are ignored - the scheduled run fills the list later anyway.
 */
export async function requestPluginRefresh(pluginId: string, schedule: PluginRefreshSchedule = window.aios.schedule): Promise<void> {
  if (refreshRequested.has(pluginId)) return
  refreshRequested.add(pluginId)
  let overview: ScheduleOverview
  try {
    overview = await schedule.list()
  } catch {
    return
  }
  if (!overview.autoRun) return
  for (const job of overview.jobs) {
    if (job.action.kind !== 'plugin' || job.action.pluginId !== pluginId || !job.enabled || job.running) continue
    try {
      await schedule.runNow(job.id)
    } catch {
      // Already running or unavailable: the next scheduled run fills the list.
    }
  }
}

/** For tests: forget which plugins were already refreshed. */
export function resetPluginRefreshForTest(): void {
  refreshRequested.clear()
}
