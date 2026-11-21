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

describe('summarizeMcp (項目 164)', () => {
  it('全体側だけ (要認証を含む) なら札を出さない — スクリーンショットの「MCP 4 (3 要認証)」の場面', () => {
    const summary = summarizeMcp([gateway, ...connectors])
    expect(summary.visible).toBe(false)
    expect(summary.total).toBe(0)
    expect(summary.needsAuth).toBe(0)
    expect(summary.globalHidden).toBe(4)
  })

  it('gateway しか無い・何も無いなら出さない (項目 110 の「MCP 0」はやめた)', () => {
    expect(summarizeMcp([gateway]).visible).toBe(false)
    expect(summarizeMcp([]).visible).toBe(false)
  })

  it('フォルダ側のサーバがあれば出し、全体側の要認証は数えない', () => {
    const probe = server({ name: 'probe', source: 'project', scope: 'folder' })
    const summary = summarizeMcp([gateway, probe, ...connectors])
    expect(summary).toMatchObject({ visible: true, total: 1, failed: 0, needsAuth: 0, globalHidden: 4 })
    expect(summary.rows.map((s) => s.name)).toEqual(['probe'])
  })

  it('フォルダ側の要認証は数える', () => {
    const remote = server({ name: 'remote', state: 'needs-auth', source: 'local', scope: 'folder' })
    expect(summarizeMcp([remote, ...connectors])).toMatchObject({ visible: true, total: 1, needsAuth: 1 })
  })

  it('全体側でも失敗したものは出す (一覧にも失敗した行だけ)', () => {
    const broken = server({ name: 'mine', state: 'failed', source: 'user', scope: 'global' })
    const summary = summarizeMcp([gateway, broken, ...connectors])
    expect(summary).toMatchObject({ visible: true, total: 1, failed: 1, needsAuth: 0, globalHidden: 4 })
    expect(summary.rows.map((s) => s.name)).toEqual(['mine'])
  })

  it('gateway との名前の衝突だけでも出す', () => {
    const summary = summarizeMcp([gateway, ...connectors], true)
    expect(summary).toMatchObject({ visible: true, total: 0, conflict: true })
  })

  it('区分の分からない行 (表に無い出所・source の無い古い CLI・項目 164 より前の報告) は見出しの側に倒す', () => {
    const odd = server({ name: 'odd', source: 'agent', scope: 'unknown' })
    const legacy = server({ name: 'legacy', source: null, scope: 'unknown' })
    // Reports saved before item 164 have no scope.
    const old = server({ name: 'old', state: 'needs-auth', source: 'claudeai' })
    const summary = summarizeMcp([gateway, odd, legacy, old])
    expect(summary.visible).toBe(true)
    expect(summary.rows.map((s) => s.name)).toEqual(['odd', 'legacy', 'old'])
    expect(summary.needsAuth).toBe(1)
  })

  it('gateway は区分に関わらず数えず、一覧にも出さない', () => {
    const failedGateway = server({ name: 'aios', gateway: true, state: 'failed', scope: 'folder' })
    const summary = summarizeMcp([failedGateway])
    expect(summary.visible).toBe(false)
    expect(summary.rows).toEqual([])
    expect(summary.globalHidden).toBe(0)
  })
})

describe('groupMcpBySource (設定画面の「MCP サーバ」の節、項目 164)', () => {
  it('出所ごとに名前順で並べ、出所の無いものは最後', () => {
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

  it('空なら空', () => {
    expect(groupMcpBySource([])).toEqual([])
  })
})
