/**
 * Latest report of the global-side MCP servers (item 164, ARCHITECTURE.md 4.6.4 "how to show it").
 *
 * Global-side servers (vendor connectors, the user's own registrations, plugin-bundled ones) are the same in every thread,
 * so they are shown in the "MCP servers" section of the settings screen, not in a thread's heading. This is where that data comes from:
 * every time a session starts in any thread (`session_started`), only the rows with `scope === 'global'` are
 * rewritten into `mcp.lastGlobalReport` in `app_settings` (it survives a restart).
 *
 * - **No new process is started** (starting one takes 2-4 seconds and also runs the user's SessionStart hooks).
 *   The state is "the state in the last session we saw", shown together with the report time (`at`).
 * - **Folder-side rows are not written** (we could no longer tell which folder a report belongs to). Rows whose scope is unknown
 *   (`unknown`) are not written either - those are shown on the thread heading side. The gateway is not written either.
 * - A report without `mcpServers` (the CLI shape from before item 110) does not overwrite anything.
 */
import type { McpGlobalReport, McpGlobalServer, McpServerReport } from '@shared/agent.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { MCP_LAST_GLOBAL_REPORT } from '../../common/settings-keys.js'

/** Picks only the global-side rows out of a start report (pure function). Drops the gateway and anything not global. */
export function globalServersOf(servers: readonly McpServerReport[]): McpGlobalServer[] {
  return servers
    .filter((s) => !s.gateway && s.scope === 'global')
    .map((s) => ({ name: s.name, state: s.state, source: s.source }))
}

export class McpReportRegistry {
  constructor(private readonly settings: AppSettingsStore) {}

  /** The latest report. null if no session has been started yet (or the stored value is broken). */
  get(): McpGlobalReport | null {
    return this.settings.readTyped(MCP_LAST_GLOBAL_REPORT)
  }

  /** Rewrites the global-side rows from the `mcpServers` of `session_started` and returns the value written. */
  record(servers: readonly McpServerReport[], at: number): McpGlobalReport {
    const report: McpGlobalReport = { at, servers: globalServersOf(servers) }
    this.settings.writeTyped(MCP_LAST_GLOBAL_REPORT, report)
    return report
  }
}
