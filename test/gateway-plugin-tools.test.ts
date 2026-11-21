/**
 * TODO 847 (ARCHITECTURE 7.6.7): the gateway lists the plugin's tools in `tools/list`, and when one is called it forwards the call to main.
 *
 * Connects the real `McpServer` and the SDK's `Client` through a transport in the same process (it starts neither the CLI nor the model).
 *  - The list shows the manifest's JSON Schema as it is, and the schemas of built-in tools do not change
 *  - A call passes the name and arguments to main as they are, and `{ error }` becomes `isError`
 *  - A row whose response from main has a different shape is dropped
 */
import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { parsePluginToolList, registerPluginTools, toolUseIdOf, type PluginToolCall } from '../src/gateway/plugin-tools.js'

const SCHEMA = {
  type: 'object',
  properties: { url: { type: 'string', description: 'page' } },
  required: ['url'],
  additionalProperties: false
}

async function connect(call: PluginToolCall, tools = parsePluginToolList({ tools: [
  { name: 'test_tools__fetchPage', title: 'Tools: fetchPage', description: 'Fetch a page.', inputSchema: SCHEMA }
] })): Promise<Client> {
  const server = new McpServer({ name: 'aios', version: '0.0.0' })
  server.registerTool('search', { description: 'builtin', inputSchema: { query: z.string() } }, async () => ({
    content: [{ type: 'text' as const, text: 'builtin' }]
  }))
  registerPluginTools(server, tools, call)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 't', version: '0.0.0' })
  await client.connect(b)
  return client
}

describe('gateway plugin tools', () => {
  it('are listed in tools/list with the manifest schema, and built-in tools stay as they are', async () => {
    const client = await connect(async () => 'unused')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['search', 'test_tools__fetchPage'])
    const plugin = tools.find((t) => t.name === 'test_tools__fetchPage')
    expect(plugin?.inputSchema).toEqual(SCHEMA)
    expect(plugin?.title).toBe('Tools: fetchPage')
    expect(plugin?.description).toBe('Fetch a page.')
    const builtin = tools.find((t) => t.name === 'search')
    expect(builtin?.inputSchema).toMatchObject({ type: 'object', properties: { query: { type: 'string' } } })
    await client.close()
  })

  it('a call passes the name and arguments to main and returns the response; { error } is isError', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const client = await connect(async (name, args) => {
      calls.push({ name, args })
      return args['url'] === 'bad' ? { error: 'invalid arguments' } : { text: 'hello' }
    })
    const ok = await client.callTool({ name: 'test_tools__fetchPage', arguments: { url: 'x', more: 1 } })
    expect(calls).toEqual([{ name: 'test_tools__fetchPage', args: { url: 'x', more: 1 } }])
    expect(ok.content).toEqual([{ type: 'text', text: '{"text":"hello"}' }])
    expect(ok.isError).toBeFalsy()
    const failed = await client.callTool({ name: 'test_tools__fetchPage', arguments: { url: 'bad' } })
    expect(failed.isError).toBe(true)
    await client.close()
  })

  it('adds nothing when the list is empty', async () => {
    const client = await connect(async () => 'unused', [])
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['search'])
    await client.close()
  })

  it('drops rows with a wrong response shape from main, names shaped like built-ins, and duplicates', () => {
    expect(parsePluginToolList(null)).toEqual([])
    expect(parsePluginToolList({ tools: 'x' })).toEqual([])
    const listed = parsePluginToolList({
      tools: [
        { name: 'search', description: 'd', inputSchema: { type: 'object' } },
        { name: 'a__b', description: 'd', inputSchema: { type: 'string' } },
        { name: 'a__b', description: 3, inputSchema: { type: 'object' } },
        { name: 'a__b', description: 'd', inputSchema: { type: 'object' } },
        { name: 'a__b', description: 'd', inputSchema: { type: 'object' } },
        { name: 'a b__c', description: 'd', inputSchema: { type: 'object' } }
      ]
    })
    expect(listed).toEqual([{ name: 'a__b', title: 'a__b', description: 'd', inputSchema: { type: 'object' } }])
  })
})

describe('toolUseIdOf (TODO 883)', () => {
  it('reads only the _meta claudecode/toolUseId that the CLI attaches', () => {
    expect(toolUseIdOf({ _meta: { progressToken: 3, 'vendor/toolUseId': 'toolu_1' } })).toBe('toolu_1')
    expect(toolUseIdOf({ _meta: { progressToken: 3 } })).toBeNull()
    expect(toolUseIdOf({ _meta: { 'vendor/toolUseId': 5 } })).toBeNull()
    expect(toolUseIdOf({ _meta: { 'vendor/toolUseId': '' } })).toBeNull()
    expect(toolUseIdOf(undefined)).toBeNull()
    expect(toolUseIdOf({})).toBeNull()
  })
})
