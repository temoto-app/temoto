/**
 * Item 164 (rewrite of the item 110 badge): the summary of the MCP server badge (`summarizeMcp`, a pure function), and
 * the order of the "MCP servers" section in the settings screen (`groupMcpBySource`). The DOM is not used (rendering is checked on the real app).
 *
 * The heading badge appears only when (a) there is a server on the folder side (or of unknown scope), (b) there is a failed server
 * (on the global side too), or (c) a server's name collided with the gateway's. "Needs auth" on the global side is not counted.
 */
import { describe, expect, it } from 'vitest'
import type { McpServerReport } from '../src/shared/agent.js'
import { summarizeMcp } from '../src/renderer/src/components/McpBadge.js'
import { groupMcpBySource } from '../src/renderer/src/mcp-groups.js'

const server = (patch: Partial<McpServerReport>): McpServerReport => ({
  name: 'x',
  state: 'connected',
  source: null,
  gateway: false,
  ...patch
})

const gateway = server({ name: 'aios', gateway: true, source: 'dynamic', scope: 'unknown' })
const connectors = [
  server({ name: 'Docs', state: 'connected', source: 'claudeai', scope: 'global' }),
  server({ name: 'Gmail', state: 'needs-auth', source: 'claudeai', scope: 'global' }),
  server({ name: 'Drive', state: 'needs-auth', source: 'claudeai', scope: 'global' }),
  server({ name: 'Calendar', state: 'needs-auth', source: 'claudeai', scope: 'global' })
]

describe('summarizeMcp (item 164)', () => {
  it('shows no badge when only the global side (including needs-auth) is present, the screenshot case 「MCP 4 (3 要認証)」', () => {
    const summary = summarizeMcp([gateway, ...connectors])
    expect(summary.visible).toBe(false)
    expect(summary.total).toBe(0)
    expect(summary.needsAuth).toBe(0)
    expect(summary.globalHidden).toBe(4)
  })

  it('shows nothing when there is only the gateway or nothing (drops the 「MCP 0」 of item 110)', () => {
    expect(summarizeMcp([gateway]).visible).toBe(false)
    expect(summarizeMcp([]).visible).toBe(false)
  })

  it("shows the badge when a folder-side server exists and does not count the global side's needs-auth", () => {
    const probe = server({ name: 'probe', source: 'project', scope: 'folder' })
    const summary = summarizeMcp([gateway, probe, ...connectors])
    expect(summary).toMatchObject({ visible: true, total: 1, failed: 0, needsAuth: 0, globalHidden: 4 })
    expect(summary.rows.map((s) => s.name)).toEqual(['probe'])
  })

  it("counts the folder side's needs-auth", () => {
    const remote = server({ name: 'remote', state: 'needs-auth', source: 'local', scope: 'folder' })
    expect(summarizeMcp([remote, ...connectors])).toMatchObject({ visible: true, total: 1, needsAuth: 1 })
  })

  it('shows failed ones even on the global side (only the failed rows in the list)', () => {
    const broken = server({ name: 'mine', state: 'failed', source: 'user', scope: 'global' })
    const summary = summarizeMcp([gateway, broken, ...connectors])
    expect(summary).toMatchObject({ visible: true, total: 1, failed: 1, needsAuth: 0, globalHidden: 4 })
    expect(summary.rows.map((s) => s.name)).toEqual(['mine'])
  })

  it('shows the badge for a name collision with the gateway alone', () => {
    const summary = summarizeMcp([gateway, ...connectors], true)
    expect(summary).toMatchObject({ visible: true, total: 0, conflict: true })
  })

  it('falls back to the heading side for rows with unknown scope (a source missing from the table, an old CLI without source, a report from before item 164)', () => {
    const odd = server({ name: 'odd', source: 'agent', scope: 'unknown' })
    const legacy = server({ name: 'legacy', source: null, scope: 'unknown' })
    // Reports saved before item 164 have no scope.
    const old = server({ name: 'old', state: 'needs-auth', source: 'claudeai' })
    const summary = summarizeMcp([gateway, odd, legacy, old])
    expect(summary.visible).toBe(true)
    expect(summary.rows.map((s) => s.name)).toEqual(['odd', 'legacy', 'old'])
    expect(summary.needsAuth).toBe(1)
  })

  it('does not count the gateway regardless of scope and does not list it', () => {
    const failedGateway = server({ name: 'aios', gateway: true, state: 'failed', scope: 'folder' })
    const summary = summarizeMcp([failedGateway])
    expect(summary.visible).toBe(false)
    expect(summary.rows).toEqual([])
    expect(summary.globalHidden).toBe(0)
  })
})

describe('groupMcpBySource (the 「MCP サーバ」 section of the settings screen, item 164)', () => {
  it('sorts by name within each source and puts those without a source last', () => {
    const groups = groupMcpBySource([
      { name: 'b', state: 'connected', source: 'user' },
      { name: 'Gmail', state: 'needs-auth', source: 'claudeai' },
      { name: 'Docs', state: 'connected', source: 'claudeai' },
      { name: 'z', state: 'other', source: null },
      { name: 'a', state: 'failed', source: 'user' },
      { name: 'p', state: 'connected', source: 'plugin' }
    ])
    expect(groups.map((g) => g.source)).toEqual(['claudeai', 'plugin', 'user', null])
    expect(groups[0]?.servers.map((s) => s.name)).toEqual(['Docs', 'Gmail'])
    expect(groups[2]?.servers.map((s) => s.name)).toEqual(['a', 'b'])
  })

  it('returns empty for empty', () => {
    expect(groupMcpBySource([])).toEqual([])
  })
})
