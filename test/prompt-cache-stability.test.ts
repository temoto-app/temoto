/**
 * TODO 963 (1): aios does not break the prompt cache. Within a conversation, the part near the start that goes to the model (the gateway's tool definitions) is pinned so that it does not change for aios's reasons.
 * Additional instructions (the added part of the system prompt) are covered by "prompt cache is not broken (TODO 963)" in `adapter-process.test.ts`. Does not call the model or the CLI.
 *
 *  - The gateway's built-in tools: name, description and schema are the same fixed values on every launch (no time, environment or path is inserted).
 *    `src/gateway/index.ts` connects to the socket and stdio on import, so the `registerTool` blocks in the source are read instead.
 *  - The list of plugin tools (`PluginToolRelay.list`): for the same enabled plugins, the order and contents are the same however many times and whenever it is asked.
 *    Whether consent (TODO 848) is given does not appear in the list (`tools/list` does not change when consent is given).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PluginToolRelay, type PluginToolSource } from '../src/main/plugin/tools.js'
import type { EnabledPluginTool } from '../src/main/plugin/host.js'

describe('gateway の組み込みの道具の定義 (TODO 963)', () => {
  const source = readFileSync(new URL('../src/gateway/index.ts', import.meta.url), 'utf8')
  /** From `server.registerTool(` up to the tool's handler (`async (`): the name and definition part. */
  const blocks = source
    .split('server.registerTool(')
    .slice(1)
    .map((rest) => rest.slice(0, rest.search(/\basync\s*\(/)))

  it('組み込みの道具が並んでいる (読み取りの前提)', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(8)
    expect(blocks.every((block) => block.length > 0)).toBe(true)
  })

  it('定義の部分に動的な値 (テンプレートの差し込み・時刻・環境・乱数・パス) を入れない', () => {
    for (const block of blocks) {
      expect(block).not.toContain('${')
      expect(block).not.toMatch(/\bDate\b|process\.|Math\.random|homedir|randomUUID|SESSION|TOKEN|SOCKET/)
    }
  })

  it('サーバの名前と版は固定の文字列', () => {
    expect(source).toMatch(/new McpServer\(\{ name: '[^']+', version: '[^']+' \}\)/)
  })
})

function tool(pluginId: string, name: string): EnabledPluginTool {
  return {
    pluginId,
    pluginName: pluginId,
    tool: { name, description: `${name} tool`, inputSchema: { type: 'object' } },
    pendingConsent: [],
    consentTargets: []
  }
}

describe('plugin の道具の一覧 (TODO 963)', () => {
  it('同じ有効な plugin なら、何度・いつ聞いても同じ並び・同じ中身。同意の有無は一覧に出ない', () => {
    let consented = false
    const source: PluginToolSource = {
      enabledTools: () =>
        [tool('a.one', 'fetch'), tool('b.two', 'list')].map((entry) =>
          entry.pluginId === 'b.two' && !consented ? { ...entry, pendingConsent: ['browser'] as const } : entry
        ),
      invoke: async () => null
    }
    let now = 1_000
    const relay = new PluginToolRelay({ source, audit: { record: () => undefined }, now: () => now })
    const first = JSON.stringify(relay.list())
    now += 3_600_000
    consented = true
    expect(JSON.stringify(relay.list())).toBe(first)
  })
})
