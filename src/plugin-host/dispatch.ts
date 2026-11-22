/**
 * The part of plugin-host that does not depend on `process.parentPort` (ARCHITECTURE.md 7.1 / 7.8).
 *
 * `index.ts` is the entry point of the utility process and cannot be imported from plain Node, so
 * **building the `api` handed to the plugin and looking up exports** are split out here and called directly from tests.
 *
 * Review C-4: there is one entry point, and roles are separated by export.
 * `commands` / `mcp` / `indexer` are taken from a single module, and main names them by `kind`.
 */
import type {
  BrokerBrowserFetchPageResult,
  BrokerFsReadResult,
  BrokerNetFetchResult,
  BrokerRequest,
  HostExportKind,
  HostExports,
  HostPermissionReport,
  PluginApi,
  PluginHandler,
  PluginModule
} from '@shared/plugin.js'
import type { TriggerEmitResult } from '@shared/trigger.js'
import type { PluginSettingValues } from '@shared/plugin-settings.js'
import type { GitDiffResult, GitLogResult, GitShowResult, GitStatusResult } from '@shared/plugin-git.js'

/** Turns `aios.*` into requests to the Broker. **There is no direct I/O here** (7.7). */
export function createPluginApi(call: (request: BrokerRequest) => Promise<unknown>): PluginApi {
  return {
    fs: {
      read: (uri, options) =>
        call({
          capability: 'fs',
          op: 'read',
          uri,
          ...(options?.encoding === undefined ? {} : { encoding: options.encoding }),
          ...(options?.offset === undefined ? {} : { offset: options.offset }),
          ...(options?.length === undefined ? {} : { length: options.length })
        }) as Promise<BrokerFsReadResult>
    },
    net: {
      fetch: (url, init) =>
        call({
          capability: 'network',
          op: 'fetch',
          url,
          ...(init?.method === undefined ? {} : { method: init.method }),
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
          ...(init?.body === undefined ? {} : { body: init.body }),
          ...(init?.auth === undefined ? {} : { auth: init.auth })
        }) as Promise<BrokerNetFetchResult>
    },
    credentials: {
      status: (name) =>
        call({ capability: 'credentials', op: 'status', name }) as Promise<{
          present: boolean
          host: string | null
        }>
    },
    index: {
      put: async (document) => {
        await call({ capability: 'index', op: 'put', document })
      },
      remove: async (source, sourceId) => {
        await call({ capability: 'index', op: 'remove', source, sourceId })
      }
    },
    ui: {
      notify: async (title, body) => {
        await call({ capability: 'ui', op: 'notify', title, ...(body === undefined ? {} : { body }) })
      }
    },
    sidebar: {
      setRows: async (rows) => {
        await call({ capability: 'ui', op: 'setSidebarRows', rows })
      }
    },
    status: {
      report: async (report) => {
        await call({ capability: 'ui', op: 'reportStatus', done: report.done, total: report.total, state: report.state })
      }
    },
    browser: {
      // TODO 848: pass only the URL. Checks, cookies and following redirects are all in main (the Broker).
      fetchPage: (url) => call({ capability: 'browser', op: 'fetchPage', url }) as Promise<BrokerBrowserFetchPageResult>
    },
    // TODO 1216: just pass the event. Judgments on declarations, consent, duplicates, rules and limits are all in main.
    triggers: {
      emit: (event) => call({ capability: 'triggers', op: 'emit', event }) as Promise<TriggerEmitResult>
    },
    // TODO 1225: no arguments (main decides which extension's settings from the connection).
    settings: {
      get: () => call({ capability: 'settings', op: 'get' }) as Promise<PluginSettingValues>
    },
    // TODO 834 stage 1: only the intent and its values. argv, flags, the grant and the path checks are all in main (the Broker).
    git: {
      status: (repo) => call({ capability: 'git', op: 'status', repo }) as Promise<GitStatusResult>,
      diff: (repo, options) =>
        call({
          capability: 'git',
          op: 'diff',
          repo,
          ...(options?.from === undefined ? {} : { from: options.from }),
          ...(options?.to === undefined ? {} : { to: options.to }),
          ...(options?.staged === undefined ? {} : { staged: options.staged })
        }) as Promise<GitDiffResult>,
      show: (repo, rev, path) => call({ capability: 'git', op: 'show', repo, rev, path }) as Promise<GitShowResult>,
      log: (repo, options) =>
        call({
          capability: 'git',
          op: 'log',
          repo,
          ...(options?.rev === undefined ? {} : { rev: options.rev }),
          ...(options?.limit === undefined ? {} : { limit: options.limit }),
          ...(options?.skip === undefined ? {} : { skip: options.skip })
        }) as Promise<GitLogResult>
    }
  }
}

/**
 * Extracts a `PluginModule` from the result of `import()`. If there is a default export, that; otherwise
 * the collection of named exports (`export const commands = …`) is used as is.
 */
export function toPluginModule(loaded: unknown): PluginModule {
  if (typeof loaded !== 'object' || loaded === null) return {}
  const record = loaded as { default?: unknown }
  if (typeof record.default === 'object' && record.default !== null) return record.default as PluginModule
  return loaded as PluginModule
}

/** The export table per section. `indexer` has the shape `{ sync }` and `search` has `{ query }` (TODO 896). `task` is `tasks` (TODO 952 stage 1). */
function sectionOf(plugin: PluginModule, kind: HostExportKind): Record<string, unknown> | null {
  const section =
    kind === 'command'
      ? plugin.commands
      : kind === 'mcp'
        ? plugin.mcp
        : kind === 'task'
          ? plugin.tasks
          : kind === 'search'
            ? plugin.search
            : plugin.indexer
  return typeof section === 'object' && section !== null ? (section as Record<string, unknown>) : null
}

/**
 * Looks up a handler by name. **Own keys only** (`Object.hasOwn`) - even if main passes an inherited name such as
 * `constructor` / `__proto__` / `toString`, it is not called as a function.
 */
export function findHandler(plugin: PluginModule, kind: HostExportKind, name: string): PluginHandler | null {
  const section = sectionOf(plugin, kind)
  if (section === null || !Object.hasOwn(section, name)) return null
  const handler = section[name]
  return typeof handler === 'function' ? (handler as PluginHandler) : null
}

/** The names actually exported (main matches them against the declaration, C-4). */
export function describeExports(plugin: PluginModule): HostExports {
  const names = (kind: HostExportKind): string[] => {
    const section = sectionOf(plugin, kind)
    if (section === null) return []
    return Object.keys(section).filter((key) => typeof section[key] === 'function').slice(0, 64)
  }
  return {
    commands: names('command'),
    mcp: names('mcp'),
    indexer: names('indexer'),
    tasks: names('task'),
    search: names('search')
  }
}

/**
 * Whether the Node permission model is in effect in this process (TODO 499). `index.ts` calls it **before loading the plugin** and sends the result to main.
 * If in effect, `process.permission` exists and `has` returns false for reads outside the permitted area (`/`).
 * `helper` is only the name of the executable (the path is not sent).
 */
export function describePermission(permission: unknown, execPath: string): HostPermissionReport {
  let enabled = false
  if (typeof permission === 'object' && permission !== null) {
    const has = (permission as { has?: unknown }).has
    if (typeof has === 'function') {
      try {
        enabled = has.call(permission, 'fs.read', '/') === false
      } catch {
        enabled = false
      }
    }
  }
  const helper = execPath.split('/').pop() ?? ''
  return { enabled, helper: helper.slice(0, 64) }
}

/** The contents of `invoke` from main. If there is no `kind` (an old main), `command`. */
export function readInvoke(payload: unknown): { kind: HostExportKind; name: string; arg: unknown } | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as { kind?: unknown; command?: unknown; arg?: unknown }
  if (typeof record.command !== 'string') return null
  const kind = record.kind ?? 'command'
  if (kind !== 'command' && kind !== 'mcp' && kind !== 'indexer' && kind !== 'task' && kind !== 'search') return null
  return { kind, name: record.command, arg: record.arg }
}
