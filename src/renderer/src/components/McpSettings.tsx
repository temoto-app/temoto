/**
 * The "MCP servers" section of the settings screen (item 164, ARCHITECTURE.md 4.6.4 "how to show"). In item 187 it became the operation component of
 * one entry in the settings editor (the title and description are drawn by the frame in `Settings.tsx`).
 *
 * - Only **global** servers are shown (the same in every thread: vendor connectors, user registrations, plugin-bundled ones).
 *   Folder-side ones (the project's `.mcp.json`, local registrations) appear in the thread heading's badge (`McpBadge`).
 * - The contents are main's cache (`mcp.lastGlobalReport` in `app_settings`). It is rewritten every time a session starts
 *   in any thread. **No new process is started**, so the state is "the state in the last session seen", and
 *   it is accompanied by "a report from N minutes ago". If there is no report at all, "no session has been started yet".
 * - Read-only. It has no operations for registering, enabling / disabling or reconnecting (4.6.4: left to the CLI). For rows that need auth, a note is kept
 *   to run the `/mcp` command in a terminal session (there is no setting to silence it, owner decision 4).
 */
import { useEffect, useRef, useState } from 'react'
import type { McpGlobalReport } from '@shared/agent.js'
import { useT } from '../i18n/index.js'
import { groupMcpBySource } from '../mcp-groups.js'
import { formatAgo } from './Sidebar.js'
import { MCP_STATE_LABEL } from './McpBadge.js'

/** The interval for redrawing "N minutes ago". */
const AGO_TICK_MS = 30_000

export function McpSettings(): React.JSX.Element {
  const t = useT()
  // undefined = not fetched from main yet. null = there is no report at all.
  const [report, setReport] = useState<McpGlobalReport | null | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  // If a push arrives while fetching, that one is newer (do not overwrite it with the invoke's reply).
  const pushed = useRef(false)

  useEffect(() => {
    let alive = true
    const off = window.aios.mcp.onReport((next) => {
      pushed.current = true
      setReport(next)
      setNow(Date.now())
    })
    void window.aios.mcp.report().then((next) => {
      if (alive && !pushed.current) setReport(next)
    })
    const timer = window.setInterval(() => setNow(Date.now()), AGO_TICK_MS)
    return () => {
      alive = false
      off()
      window.clearInterval(timer)
    }
  }, [])

  return (
    <div className="mcp-settings">
      {report === undefined ? null : report === null ? (
        <p className="hint">{t('settings.mcp.noReport')}</p>
      ) : (
        <>
          <p className="hint" title={new Date(report.at).toLocaleString()}>
            {t('settings.mcp.reportedAt', { ago: formatAgo(t, report.at, now) })}
          </p>
          {report.servers.length === 0 ? (
            <p className="hint">{t('settings.mcp.none')}</p>
          ) : (
            groupMcpBySource(report.servers).map((group) => (
              <div className="mcp-settings-group" key={group.source ?? ''}>
                <h4 className="mcp-settings-source">{group.source ?? t('settings.mcp.sourceUnknown')}</h4>
                <ul className="mcp-settings-list" role="list">
                  {group.servers.map((server) => (
                    <li key={server.name}>
                      <span className="thread-mcp-name">{server.name}</span>
                      <span className={`thread-mcp-state ${server.state}`}>
                        {t(MCP_STATE_LABEL[server.state])}
                      </span>
                      {server.state === 'needs-auth' ? (
                        <span className="thread-mcp-hint">{t('thread.mcp.needsAuthHint')}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </>
      )}
    </div>
  )
}
