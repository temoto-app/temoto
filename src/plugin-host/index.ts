/**
 * plugin-host - one process per plugin (ARCHITECTURE.md 7.8).
 *
 * **Constraint 8: plugin code is not run in main.** This is an Electron
 * utility process, and all it shows the plugin is the `aios.*` IPC API.
 * Code that uses fs / net / child_process directly is not written here
 * (even if it were, the Node permission model would stop it - see below).
 *
 * **The Node permission model does not take effect through `execArgv`** (measured in Phase 4, and re-confirmed on Electron 44 in wave 25 bundle H).
 * `execArgv` of `utilityProcess.fork` only shows up in `process.execArgv` and
 * is not passed to V8 / Node initialization. Only `NODE_OPTIONS` works,
 * so PluginHost passes it that way (7.8 / the Phase 4 section of the repository's dev notes).
 * That NODE_OPTIONS is discarded because Electron regards the app as "packaged" unless the Helper's name is the default `Electron Helper*` (TODO 499).
 * Whether it is in effect is reported to main right after startup (the `permission` frame).
 *
 * This process's roles:
 *  - dynamically import the plugin's entry
 *  - hand over `aios.*` (a proxy to the Broker)
 *  - forward command calls from main and return the results
 */
import type { BrokerRequest, PluginModule } from '@shared/plugin.js'
import {
  createPluginApi,
  describeExports,
  describePermission,
  findHandler,
  readInvoke,
  toPluginModule
} from './dispatch.js'

/** The main <-> plugin-host frame. */
interface HostFrame {
  readonly id: number
  readonly kind: 'broker' | 'invoke' | 'result' | 'error' | 'ready' | 'permission'
  readonly payload?: unknown
}

const port = process.parentPort
let nextId = 1
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()

function callBroker(request: BrokerRequest): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    port.postMessage({ id, kind: 'broker', payload: request } satisfies HostFrame)
  })
}

// Building `aios.*` is in `dispatch.ts` (in a form tests can call).
const api = createPluginApi(callBroker)

let plugin: PluginModule | null = null

async function loadPlugin(entry: string): Promise<void> {
  // One entry point (review C-4). `commands` / `mcp` / `indexer` are taken from here by export.
  plugin = toPluginModule(await import(entry))
  await plugin.activate?.(api)
}

port.on('message', (event) => {
  const frame = event.data as HostFrame
  if (frame.kind === 'result' || frame.kind === 'error') {
    const waiter = pending.get(frame.id)
    if (waiter === undefined) return
    pending.delete(frame.id)
    if (frame.kind === 'result') waiter.resolve(frame.payload)
    else waiter.reject(new Error(String(frame.payload ?? 'broker error')))
    return
  }

  if (frame.kind === 'invoke') {
    const payload = readInvoke(frame.payload)
    void (async () => {
      try {
        if (payload === null) throw new Error('invalid invoke')
        const handler = plugin === null ? null : findHandler(plugin, payload.kind, payload.name)
        if (handler === null) throw new Error(`unknown ${payload.kind}: ${payload.name}`)
        const result = await handler(payload.arg, api)
        port.postMessage({ id: frame.id, kind: 'result', payload: result } satisfies HostFrame)
      } catch (err) {
        port.postMessage({
          id: frame.id,
          kind: 'error',
          payload: err instanceof Error ? err.message : 'error'
        } satisfies HostFrame)
      }
    })()
  }
})

// TODO 499: report whether the permission model is in effect **before loading the plugin's code** (main turns it into one log line).
// After loading, the plugin could replace `process.permission`. main trusts only the first message.
port.postMessage({
  id: 0,
  kind: 'permission',
  payload: describePermission((process as { permission?: unknown }).permission, process.execPath)
} satisfies HostFrame)

// The entry is passed as the last element of argv. **main does not import plugin code.**
const entry = process.argv[process.argv.length - 1]
if (entry === undefined || !entry.endsWith('.js')) {
  port.postMessage({ id: 0, kind: 'error', payload: 'no entry' } satisfies HostFrame)
} else {
  loadPlugin(entry).then(
    // Attach the names actually exported. main matches them against the manifest's declaration and warns (C-4).
    () =>
      port.postMessage({
        id: 0,
        kind: 'ready',
        payload: plugin === null ? undefined : describeExports(plugin)
      } satisfies HostFrame),
    (err: unknown) => {
      port.postMessage({
        id: 0,
        kind: 'error',
        payload: err instanceof Error ? err.message : 'load failed'
      } satisfies HostFrame)
      // TODO 1069: do not leave behind a process that failed to load (main also kills it, so doing it twice is harmless).
      setTimeout(() => process.exit(1), 100)
    }
  )
}
