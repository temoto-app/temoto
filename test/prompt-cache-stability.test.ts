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

describe('built-in tool definitions of the gateway (TODO 963)', () => {
  const source = readFileSync(new URL('../src/gateway/index.ts', import.meta.url), 'utf8')
  /** From `server.registerTool(` up to the tool's handler (`async (`): the name and definition part. */
  const blocks = source
    .split('server.registerTool(')
    .slice(1)
    .map((rest) => rest.slice(0, rest.search(/\basync\s*\(/)))

  it('the built-in tools are listed (a precondition for the read)', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(8)
    expect(blocks.every((block) => block.length > 0)).toBe(true)
  })

  it('does not put dynamic values (template interpolation, time, environment, random numbers, paths) in the definition part', () => {
    for (const block of blocks) {
      expect(block).not.toContain('${')
      expect(block).not.toMatch(/\bDate\b|process\.|Math\.random|homedir|randomUUID|SESSION|TOKEN|SOCKET/)
    }
  })

  it('the server name and version are fixed strings', () => {
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

describe('list of plugin tools (TODO 963)', () => {
  it('for the same enabled plugin, the order and content are the same however many times or whenever it is asked; whether consent exists does not show in the list', () => {
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
