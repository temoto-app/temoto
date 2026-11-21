/**
 * Ordering for the "MCP servers" section of the settings screen (item 164). Pure functions with no DOM or store
 * (`McpSettings.tsx` pulls in the theme store via the Sidebar's `formatAgo`, so tests read this file instead).
 */
import type { McpGlobalServer } from '@shared/agent.js'

export interface McpSourceGroup {
  /** Name of the backend's origin (opaque, display only). null if none. */
  readonly source: string | null
  readonly servers: readonly McpGlobalServer[]
}

/** Group by origin. Origins in name order (those without one last), servers within a group in name order. */
export function groupMcpBySource(servers: readonly McpGlobalServer[]): readonly McpSourceGroup[] {
  const groups = new Map<string | null, McpGlobalServer[]>()
  for (const server of servers) {
    const list = groups.get(server.source)
    if (list === undefined) groups.set(server.source, [server])
    else list.push(server)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([source, list]) => ({
      source,
      servers: [...list].sort((x, y) => x.name.localeCompare(y.name))
    }))
}
