/**
 * The MCP server badge (item 110 -> item 164, ARCHITECTURE.md 4.6.4 "how to show"). In ThreadPane's heading, next to the instruction file badge.
 *
 * - The source is `mcpServers` of that thread's last `session_started` (`threadStore.threadMcp`).
 * - **Only abnormal and folder-side ones are shown** (item 164, owner decision 2026-09-27). The badge is shown only in one of these cases:
 *   (a) there is a folder-side server (the project's `.mcp.json`, a local registration) or one whose scope is unknown (`unknown`),
 *   (b) a server failed in this session (even a global one), (c) a name collided with the gateway (`gatewayConflict`).
 *   **"Needs auth" for global ones (vendor connectors, user registrations, plugins) is neither shown nor counted**:
 *   global ones appear in the "MCP servers" section of the settings screen (`McpSettings`). If none apply, no badge is shown
 *   (item 110's "show `MCP 0` even for 0 servers" was dropped).
 * - The scope (`scope`) is a neutral vocabulary the Adapter derived from the raw `source` value. Reports saved before item 164 have no
 *   such field, so they are treated as `unknown` (leaning toward the heading side: showing is safer than hiding).
 * - **The gateway itself is neither counted nor shown anywhere** (the row with `gateway: true`).
 * - Pressing it opens the per-server state list. For global ones only failed rows. For ones that need auth (`needs-auth`),
 *   a note is added to run the `/mcp` command in a terminal (aios cannot authenticate: constraint 2 / OAuth is the CLI's own flow).
 * - Re-rendering is closed within this component (`threadMcp[threadId]` changes only on `session_started`).
 */
import { useEffect, useRef, useState } from 'react'
import type { McpServerReport, McpServerScope, McpServerState } from '@shared/agent.js'
import { useThreads } from '../threadStore.js'
import { useT, type MessageKey } from '../i18n/index.js'

export const MCP_STATE_LABEL: Record<McpServerState, MessageKey> = {
  connected: 'thread.mcp.state.connected',
  failed: 'thread.mcp.state.failed',
  'needs-auth': 'thread.mcp.state.needsAuth',
  pending: 'thread.mcp.state.pending',
  disabled: 'thread.mcp.state.disabled',
  other: 'thread.mcp.state.other'
}

/** How to read the scope. Reports from before item 164 (no field) are `unknown`. */
export function mcpScope(server: McpServerReport): McpServerScope {
  return server.scope ?? 'unknown'
}

export interface McpBadgeSummary {
  /** Whether to show the badge. */
  readonly visible: boolean
  /** The rows shown in the list (all folder-side and unknown-scope ones, plus failures of global ones). The gateway is not included. */
  readonly rows: readonly McpServerReport[]
  /** The badge's count (= the number of `rows`). */
  readonly total: number
  readonly failed: number
  /** Of `rows`, those that need auth (= only folder-side and unknown-scope ones; global ones needing auth are not counted). */
  readonly needsAuth: number
  /** The number of global rows not shown in the list (the part shown in the settings screen). */
  readonly globalHidden: number
  readonly conflict: boolean
}

/** The badge's summary (a pure function, put outside to be easy to test). The rules are as at the top of the file. */
export function summarizeMcp(
  servers: readonly McpServerReport[],
  gatewayConflict = false
): McpBadgeSummary {
  const others = servers.filter((s) => !s.gateway)
  const rows = others.filter((s) => mcpScope(s) !== 'global' || s.state === 'failed')
  return {
    visible: rows.length > 0 || gatewayConflict,
    rows,
    total: rows.length,
    failed: rows.filter((s) => s.state === 'failed').length,
    needsAuth: rows.filter((s) => s.state === 'needs-auth').length,
    globalHidden: others.length - rows.length,
    conflict: gatewayConflict
  }
}

export function McpBadge({ threadId }: { threadId: string }): React.JSX.Element | null {
  const t = useT()
  const mcp = useThreads((state) => state.threadMcp[threadId])
  // TODO 869 plan C: the number connecting while waiting for connector connections before the first message (main's cache).
  const connecting = useThreads((state) => state.threadsById[threadId]?.runtime.mcpPending ?? 0)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement | null>(null)

  // Close when the thread is switched. Pressing outside also closes it.
  useEffect(() => setOpen(false), [threadId])
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  if (connecting > 0) {
    return (
      <span className="thread-mcp" ref={root}>
        <button type="button" title={t('thread.mcp.connectingHint')} disabled>
          {t('thread.mcp.connecting', { count: connecting })}
        </button>
      </span>
    )
  }
  if (mcp === undefined) return null
  const summary = summarizeMcp(mcp.servers, mcp.gatewayConflict)
  if (!summary.visible) return null
  const warn = summary.conflict || summary.failed > 0 || summary.needsAuth > 0
  const notes: string[] = []
  if (summary.failed > 0) notes.push(t('thread.mcp.failedCount', { count: summary.failed }))
  if (summary.needsAuth > 0) notes.push(t('thread.mcp.needsAuthCount', { count: summary.needsAuth }))
  if (summary.conflict) notes.push(t('thread.mcp.conflictNote'))
  const head = summary.total > 0 ? t('thread.mcp.label', { count: summary.total }) : 'MCP'
  const label = notes.length === 0 ? head : `${head} (${notes.join(', ')})`

  return (
    <span className={`thread-mcp${warn ? ' warn' : ''}`} ref={root}>
      <button
        type="button"
        title={t('thread.mcp.hint')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open ? (
        <ul className="thread-mcp-list" role="list">
          {summary.conflict ? <li className="conflict">{t('thread.mcp.gatewayConflict')}</li> : null}
          {summary.rows.map((server) => (
            <li key={`${server.source ?? ''}:${server.name}`}>
              <span className="thread-mcp-name">{server.name}</span>
              {server.source !== null ? <span className="thread-mcp-source">{server.source}</span> : null}
              <span className={`thread-mcp-state ${server.state}`}>{t(MCP_STATE_LABEL[server.state])}</span>
              {server.state === 'needs-auth' ? (
                <span className="thread-mcp-hint">{t('thread.mcp.needsAuthHint')}</span>
              ) : null}
            </li>
          ))}
          {summary.globalHidden > 0 ? (
            <li className="note">{t('thread.mcp.globalHidden', { count: summary.globalHidden })}</li>
          ) : null}
        </ul>
      ) : null}
    </span>
  )
}
