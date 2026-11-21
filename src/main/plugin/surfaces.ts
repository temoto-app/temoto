/**
 * State of the "surfaces" a plugin shows on the host (TODO 1039 sidebar list / TODO 1038 sync progress, ARCHITECTURE.md 7.5).
 *
 * Plugin code runs in plugin-host and passes **values only** through the Broker (constraint 8). This holds the validated values and
 * sends a whole snapshot to the renderer (the renderer draws). A row's URI passes only if it is **a scheme of that plugin's viewer**
 * (it must not open another's viewer, `file:` or `https:`). A row with a different one loses its URI and remains as a heading.
 */
import type {
  PluginSidebarRow,
  PluginSurfacesSnapshot,
  PluginSyncReport,
  PluginSyncStatus
} from '@shared/plugin-surfaces.js'

export interface PluginSurfacesDeps {
  /** The heading of a plugin that may show a list (enabled, bundled, with a `sidebarView` declaration). null for others. */
  readonly sidebarTitleOf: (pluginId: string) => string | null
  /** The schemes a plugin's viewer claims (lowercase, no `:`). */
  readonly viewerSchemesOf: (pluginId: string) => readonly string[]
  /** Whether the plugin (enabled) may show state. */
  readonly isEnabled: (pluginId: string) => boolean
  /** A change of the snapshot (once, batched, after `COALESCE_MS`). */
  readonly onChange: (snapshot: PluginSurfacesSnapshot) => void
}

/** Even if reports come continuously, send to the renderer at most 4 times per second. */
const COALESCE_MS = 250

function schemeOf(uri: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(uri)
  return match === null ? null : (match[1] ?? '').toLowerCase()
}

/** Restrict rows' URIs to the plugin's viewer schemes (a URI that differs is dropped). */
export function restrictRowUris(rows: readonly PluginSidebarRow[], schemes: ReadonlySet<string>): PluginSidebarRow[] {
  return rows.map((row) => {
    const { uri, children, ...rest } = row
    const scheme = uri === undefined ? null : schemeOf(uri)
    return {
      ...rest,
      ...(uri !== undefined && scheme !== null && schemes.has(scheme) ? { uri } : {}),
      ...(children === undefined ? {} : { children: restrictRowUris(children, schemes) })
    }
  })
}

export class PluginSurfaces {
  private readonly rows = new Map<string, readonly PluginSidebarRow[]>()
  private readonly status = new Map<string, PluginSyncReport>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly deps: PluginSurfacesDeps) {}

  setSidebarRows(pluginId: string, rows: readonly PluginSidebarRow[]): void {
    if (this.deps.sidebarTitleOf(pluginId) === null) return
    this.rows.set(pluginId, restrictRowUris(rows, new Set(this.deps.viewerSchemesOf(pluginId))))
    this.schedule()
  }

  reportStatus(pluginId: string, report: PluginSyncReport): void {
    if (report.state === 'done') this.status.delete(pluginId)
    else {
      // If the denominator is known and the numerator exceeds it, align to the denominator (never show "12 / 10").
      const done = report.total === null ? report.done : Math.min(report.done, report.total)
      this.status.set(pluginId, { done, total: report.total, state: report.state })
    }
    this.schedule()
  }

  /** When a plugin is disabled or removed. Discard the rows and state it held. */
  clear(pluginId: string): void {
    const hadRows = this.rows.delete(pluginId)
    const hadStatus = this.status.delete(pluginId)
    if (hadRows || hadStatus) this.schedule()
  }

  /** When the snapshot's filtering may change, such as an enable / disable change. */
  refresh(): void {
    this.schedule()
  }

  snapshot(): PluginSurfacesSnapshot {
    const sidebar = [...this.rows.entries()]
      .flatMap(([pluginId, rows]) => {
        const title = this.deps.sidebarTitleOf(pluginId)
        return title === null ? [] : [{ pluginId, title, rows }]
      })
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
    const status: PluginSyncStatus[] = [...this.status.entries()]
      .filter(([pluginId]) => this.deps.isEnabled(pluginId))
      .map(([pluginId, report]) => ({ pluginId, ...report }))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
    return { sidebar, status }
  }

  /** App shutdown. Nothing is sent afterwards (the same shape as the rule of not writing after `db.close()`). */
  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.disposed || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.disposed) this.deps.onChange(this.snapshot())
    }, COALESCE_MS)
    this.timer.unref?.()
  }
}
