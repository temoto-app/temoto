/**
 * TODO 1024: the name of a permission request for an MCP tool (ARCHITECTURE 4.2.1 / 4.6.1).
 *
 * OpenCode 2.1.4 passes `Permission.assert` even when an MCP tool is called from inside codemode's `execute`, and asks the action as
 * `<server>_<tool>` (both are names with characters matching the table's `sanitizePattern` replaced by `_`) (spike 34 (b), measured 2026-10-31).
 * The approval inbox gets it in the same form as Claude (`outbound.mcpPrefix` + server + `outbound.mcpSeparator` + tool) - because the outbound-operation decision
 * (959), the route out after secrets (1043) and how the gateway's own tools are treated (asked at the relay stage, 7.6.7) all work on the shape of the name.
 * A server name can also contain the separator character, so it is split by longest match against the list of servers on the running serve. If the list cannot be fetched, it is split at the first separator.
 */
import type { OpenCodeTable } from './compat.js'

/** Takes names from the response of serve's server list (`{ data: [{ name }] }` or an array). */
export function mcpServersOf(json: unknown): string[] {
  const list = Array.isArray(json)
    ? json
    : typeof json === 'object' && json !== null && Array.isArray((json as Record<string, unknown>)['data'])
      ? ((json as Record<string, unknown>)['data'] as unknown[])
      : []
  return list.flatMap((row) => {
    const name = typeof row === 'object' && row !== null ? (row as Record<string, unknown>)['name'] : undefined
    return typeof name === 'string' && name !== '' ? [name] : []
  })
}

/**
 * action (`<server>_<tool>`) -> the approval inbox name (`mcp__<server>__<tool>`). The server is the original name in `servers`.
 * When it cannot be split by `servers` (null, or no match), it is split at the first separator. With no separator, the action stays as it is.
 */
export function mcpToolNameOf(table: OpenCodeTable, action: string, servers: readonly string[] | null): string {
  const { actionSeparator, sanitizePattern } = table.permission.mcp
  const { mcpPrefix, mcpSeparator } = table.outbound
  const sanitize = (name: string): string => name.replace(new RegExp(sanitizePattern, 'g'), '_')
  let server: string | null = null
  let tool = ''
  for (const name of [...(servers ?? [])].sort((a, b) => sanitize(b).length - sanitize(a).length)) {
    const head = `${sanitize(name)}${actionSeparator}`
    if (action.startsWith(head) && action.length > head.length) {
      server = name
      tool = action.slice(head.length)
      break
    }
  }
  if (server === null) {
    const cut = action.indexOf(actionSeparator)
    if (cut <= 0 || cut + actionSeparator.length >= action.length) return action
    server = action.slice(0, cut)
    tool = action.slice(cut + actionSeparator.length)
  }
  return `${mcpPrefix}${server}${mcpSeparator}${tool}`
}
