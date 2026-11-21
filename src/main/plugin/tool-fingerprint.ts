/**
 * Fingerprint of one tool of an extension (fix X of TODO 1227, code-review, ARCHITECTURE 6.2.6). **Independent of electron.**
 *
 * A tool that a trigger rule allowed for "use in an unattended turn" is stored in `trigger_rules.allowed_tools` as a pair of the name and this fingerprint.
 * The unattended turn's choke point compares it **at the time of use** with the fingerprint of the tool of the currently loaded extension (`TriggerStore.allowsTool`).
 * So when, after the user allowed it,
 *  - an extension update changed the tool's declaration (description, argument shape, `sideEffect`), or
 *  - it was replaced by a different extension with the same id (a different name or author),
 * the saved permission does not pass (the user allows it again in the rule - the closed side). Rule rows are not deleted even when they could not be loaded at startup
 * (rows are not deleted at startup - 6.2.6), so with a name-only permission the permission would come back to a same-named tool of the swapped-in extension.
 *
 * The ingredients are the extension's id, `name`, `publisher`, the tool declaration (name, title, description, JSON Schema of the arguments, `sideEffect`), and
 * **an identity the extension cannot fake** (`PluginHost.identityOf`: `bundled` for bundled ones, the SHA-256 of the whole directory's contents for external ones - `identity.ts`).
 * The id, name, author and declaration can be claimed by the extension itself, so it is the identity that tells apart a different thing with the same id and the same tool name
 * (security review of fix X). An external extension's identity changes on update too, so its permission is dropped (the closed side).
 */
import { createHash } from 'node:crypto'
import type { PluginManifest, PluginToolDeclaration } from '@shared/plugin.js'

/** Turn a JSON value into a string with the object keys sorted (the same declaration gives the same string). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function pluginToolFingerprint(
  manifest: Pick<PluginManifest, 'id' | 'name' | 'publisher'>,
  tool: PluginToolDeclaration,
  identity: string
): string {
  const material = canonical({
    identity,
    pluginId: manifest.id,
    pluginName: manifest.name,
    publisher: manifest.publisher ?? null,
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description,
    inputSchema: tool.inputSchema,
    sideEffect: tool.sideEffect === true
  })
  return createHash('sha256').update(material, 'utf8').digest('hex')
}
