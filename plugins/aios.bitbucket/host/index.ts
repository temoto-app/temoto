/**
 * The plugin-host side of `aios.bitbucket` (TODO 1218, ARCHITECTURE 7.5.3 / 6.2.6).
 *
 * **This code does not run in main** (constraint 8). Bitbucket Cloud is reached only through `api.net.fetch` (the Broker; the allowed host is `api.bitbucket.org`,
 * and the Broker adds the Basic auth header when the credential is attached by the name `bitbucket:api-token`). It only reads.
 * The periodic task `poll` reports events with `api.triggers.emit`, and three tools let the model read the contents of a PR.
 */
import type { PluginModule, PluginTaskArg } from '@shared/plugin.js'
import { runPoll } from './poll.js'
import { getPullRequest, getPullRequestDiff, listPullRequestComments } from './tools.js'

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
    poll: (arg, api) => runPoll(readArg(arg), api)
  },
  mcp: {
    getPullRequest,
    getPullRequestDiff,
    listPullRequestComments
  }
}

export default plugin
