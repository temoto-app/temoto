/**
 * The plugin-host side of `aios.gmail` (TODO 952 stage 2, ARCHITECTURE 7.5 / 6.2.4).
 *
 * **This code does not run in main** (constraint 8). It reaches Gmail only through `api.net.fetch` (Broker; the allowed host is `gmail.googleapis.com`,
 * and the Broker attaches the token when given the credential name `google:gmail.modify`), and stores locally only through `api.index.put` (the canonical copy is main's
 * `plugin_documents`, the index lives in the index process). Tasks are called by aios's `JobScheduler` (no timers of its own).
 */
import type { PluginModule, PluginTaskArg } from '@shared/plugin.js'
import { runSync } from './sync.js'

function readArg(arg: unknown): PluginTaskArg {
  const record = (typeof arg === 'object' && arg !== null ? arg : {}) as Record<string, unknown>
  const state = record['state']
  const reason = record['reason']
  return {
    state: typeof state === 'object' && state !== null && !Array.isArray(state) ? (state as PluginTaskArg['state']) : null,
    reason: reason === 'idle' || reason === 'manual' ? reason : 'scheduled'
  }
}

const plugin: PluginModule = {
  tasks: {
    sync: (arg, api) => runSync(readArg(arg), api)
  }
}

export default plugin
