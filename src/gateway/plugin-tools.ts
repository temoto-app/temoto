/**
 * Lists plugin tools in the gateway's `tools/list` (TODO 847, ARCHITECTURE 7.6.7).
 *
 * At startup the gateway receives the list (`pluginTools`) from main once and registers it on the `McpServer` here.
 * Enabling / disabling takes effect **from the next session** (owner decision 2026-10-18) - `notifications/tools/list_changed`
 * is not sent. A call is just forwarded to main; all checks (a disabled plugin, the argument schema, approval) are in main.
 *
 * **The schema is the manifest's JSON Schema, as is.** The SDK's `registerTool` only accepts zod, so
 * registration uses a zod that accepts any object (main does the checking), and only the `tools/list` response is
 * replaced so that each tool's `inputSchema` is the manifest's (`installSchemaOverride`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { PluginToolListing } from '../shared/plugin.js'
import { respond, type ToolResponse } from './respond.js'

/** Upper bound on the number of tools received from main (the same as main's `MAX_EXPOSED_PLUGIN_TOOLS`). */
const MAX_TOOLS = 64

/** Reject names shaped like built-in tool names (a plugin tool name always contains `__`). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*__[A-Za-z][A-Za-z0-9_-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads main's response (`{ tools: [...] }`). Rows of the wrong shape are dropped (the gateway still starts if main is old or broken). */
export function parsePluginToolList(value: unknown): readonly PluginToolListing[] {
  if (!isRecord(value) || !Array.isArray(value['tools'])) return []
  const out: PluginToolListing[] = []
  const seen = new Set<string>()
  for (const item of value['tools'] as unknown[]) {
    if (out.length >= MAX_TOOLS) break
    if (!isRecord(item)) continue
    const { name, title, description, inputSchema } = item
    if (typeof name !== 'string' || name.length > 64 || !NAME.test(name) || seen.has(name)) continue
    if (typeof description !== 'string' || !isRecord(inputSchema) || inputSchema['type'] !== 'object') continue
    seen.add(name)
    out.push({ name, title: typeof title === 'string' ? title : name, description, inputSchema })
  }
  return out
}

/** The entry point that sends a call to main. `extra` is the SDK handler's second argument (used for cancellation and progress). */
export type PluginToolCall = (name: string, args: Record<string, unknown>, extra: unknown) => Promise<unknown>

/**
 * Reads the `<namespace>/toolUseId` in the `_meta` that the CLI attaches to a tool call (the id of the original `tool_use`) (TODO 883).
 * The namespace is not written out (constraint 6); it looks for a key ending in `/toolUseId`. Returns null if absent (main matches the markers it holds, oldest first).
 */
export function toolUseIdOf(extra: unknown): string | null {
  if (!isRecord(extra) || !isRecord(extra['_meta'])) return null
  for (const [key, id] of Object.entries(extra['_meta'])) {
    if (key.endsWith('/toolUseId') && typeof id === 'string' && id !== '' && id.length <= 200) return id
  }
  return null
}

/** Turns main's response into the form returned to the model. `{ error }` sets `isError`. */
export function pluginToolResponse(value: unknown): ToolResponse {
  const response = respond(value)
  if (isRecord(value) && typeof value['error'] === 'string') return { ...response, isError: true }
  return response
}

/** Registers the tools and replaces the `inputSchema` in `tools/list` with the manifest's. */
export function registerPluginTools(
  server: McpServer,
  tools: readonly PluginToolListing[],
  call: PluginToolCall
): void {
  if (tools.length === 0) return
  const schemas = new Map<string, Readonly<Record<string, unknown>>>()
  for (const tool of tools) {
    schemas.set(tool.name, tool.inputSchema)
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Accept any object (main does the checking, 7.6.7).
        inputSchema: z.object({}).passthrough()
      },
      async (args, extra) => pluginToolResponse(await call(tool.name, args as Record<string, unknown>, extra))
    )
  }
  installSchemaOverride(server, schemas)
}

type ListHandler = (request: unknown, extra: unknown) => Promise<unknown>

/**
 * Wraps the SDK's `tools/list` handler so a plugin tool's `inputSchema` is the manifest's.
 * The original handler is taken from `Protocol`'s private table (the SDK has no public entry point). If it cannot be found we do not wrap -
 * the "any object" schema is then published as is (main checks calls, so behavior does not change).
 */
function installSchemaOverride(server: McpServer, schemas: ReadonlyMap<string, Readonly<Record<string, unknown>>>): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListHandler> })._requestHandlers
  const original = handlers?.get('tools/list')
  if (original === undefined) return
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const listed = (await original(request, extra)) as { tools?: { name: string; inputSchema?: unknown }[] }
    return {
      ...listed,
      tools: (listed.tools ?? []).map((tool) => {
        const schema = schemas.get(tool.name)
        return schema === undefined ? tool : { ...tool, inputSchema: schema }
      })
    } as never
  })
}
