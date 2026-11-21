/**
 * The plugin-host side of `aios.markdown` (`command` in ARCHITECTURE.md 7.1, and 7.8).
 *
 * **This code does not run in main** (constraint 8). It runs inside an Electron utility process,
 * and files can be read only through `api.fs.read` = the CapabilityBroker.
 * Even if it imports `node:fs`, the Node permission model rejects it
 * (measured in Phase 4. But `net` is outside the permission model,
 *  so the network restriction rests only on the Broker's allowed-host check).
 *
 * This is the only path that exercises the Phase 4 isolation in practice, so it is deliberately
 * shaped to "read files through the Broker".
 *
 * The heading extraction itself is `@shared/markdown/headings.ts` (item 318). The viewer takes headings of a draft with the same function,
 * so the same body gives the same list (with line numbers). It is a dependency-free pure function, so it goes straight into the ssr bundle.
 */
import type { PluginApi, PluginModule } from '@shared/plugin.js'
import { extractHeadings, type Heading } from '@shared/markdown/headings.js'

export { extractHeadings, type Heading }

const plugin: PluginModule = {
  commands: {
    /**
     * Return the list of headings of the open Markdown (`{ level, text, line }`; line numbers were added in item 318).
     * **The body is not passed from the viewer; it is reread through the Broker** — so that every time
     * this path exercises that isolation and the path check actually work.
     */
    async outline(arg: unknown, api: PluginApi): Promise<readonly Heading[]> {
      const uri = typeof arg === 'string' ? arg : (arg as { uri?: string })?.uri
      if (typeof uri !== 'string') throw new Error('uri required')
      const file = await api.fs.read(uri)
      if (file.kind !== 'text' || file.text === undefined) return []
      return extractHeadings(file.text)
    }
  }
}

export default plugin
