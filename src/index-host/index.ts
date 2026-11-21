/**
 * index-host - the entry point of the index process (`aios-index`) (P1, ARCHITECTURE.md chapter 3).
 *
 * It has the same standing as `plugin-host` (7.8), and **this is the only place that touches `process.parentPort`**.
 * What it does comes down to 3 lines:
 *
 *   1. Create an `IndexKernel`
 *   2. Connect an `RpcPeer` to parentPort
 *   3. Put the kernel's method table on the RPC, and route calls in the reverse direction into the RPC
 *
 * **It does not import electron** (`process.parentPort` is a global Electron adds to the
 * utility process, not a module import).
 * `npm run lint:index` checks this constraint mechanically.
 *
 * No Node flags are needed: `execArgv` of `utilityProcess.fork` has no effect
 * (measured in Phase 4), and since the index process reads the whole PC, no permission model
 * is applied either (3.2).
 */
import { setPriority } from 'node:os'
import type { IndexRpcMessage } from '@shared/index-rpc.js'
import { RpcPeer } from '../common/rpc.js'
import { IndexKernel } from '../index-kernel/kernel.js'
import { log, errorFields } from '../common/logger.js'

/**
 * Ask the OS to run the index process at a low priority (the second step of TODO 434, nice 19).
 * The cap itself is held by the duty cycle (`pace.ts`); this is a safety net - when the machine is idle it uses everything,
 * so nice alone does not give N%. macOS's background QoS (`PRIO_DARWIN_BG`, which also throttles I/O) needs
 * native code, so we decide after measuring. If it fails, the index still runs.
 */
const INDEX_PROCESS_NICE = 19
try {
  setPriority(INDEX_PROCESS_NICE)
  log.info('index.host.priority', { nice: INDEX_PROCESS_NICE })
} catch (err) {
  log.warn('index.host.priority.failed', errorFields(err))
}

const port = process.parentPort

const peer = new RpcPeer((message) => port.postMessage(message))

const kernel = new IndexKernel({
  notify: (event, payload) => peer.notify(event, payload),
  call: (method, params) => peer.request(method, params)
})

peer.setMethods(kernel.methods)

port.on('message', (event) => {
  peer.receive(event.data as IndexRpcMessage)
})

process.on('uncaughtException', (err: unknown) => {
  // If the index process dies silently, main can only see "crashed".
  // Leave at least the reason on stderr (no body text or argument values - the logging rule).
  log.error('index.host.uncaught', errorFields(err))
  void kernel.stop().finally(() => process.exit(1))
})
