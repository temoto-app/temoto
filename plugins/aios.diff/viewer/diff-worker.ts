/**
 * The Web Worker of `aios.diff` (TODO 1341 item 4): runs `runDiffJob` with `WORKER_LIMITS` off the iframe's UI thread.
 *
 * It is built by Vite as its own file (`?worker&url` in `main.ts`) inside this plugin's output, and loaded through a `data:` module worker
 * that imports it (`diff-client.ts`; the same way as `aios.pdf`, because a document with an opaque origin cannot start a Worker from an
 * `aios-plugin:` URL). It reads nothing and sends nothing but the result.
 *
 * Messages in: `{ id, job }`. Out: `{ type: 'ready' }` once loaded, `{ type: 'result', id, result }` or `{ type: 'error', id }`.
 */
import { WORKER_LIMITS } from './coarse-diff.js'
import { runDiffJob, type DiffJob } from './diff-work.js'

/** The part of the worker's global scope used here (the project's DOM typings describe a window, not a worker). */
interface WorkerScope {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

const scope = self as unknown as WorkerScope

function isJob(value: unknown): value is { id: number; job: DiffJob } {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { id?: unknown; job?: { kind?: unknown; a?: unknown; b?: unknown } }
  return (
    typeof message.id === 'number' &&
    typeof message.job === 'object' &&
    message.job !== null &&
    (message.job.kind === 'chars' || message.job.kind === 'lines') &&
    typeof message.job.a === 'string' &&
    typeof message.job.b === 'string'
  )
}

scope.addEventListener('message', (event) => {
  const data: unknown = event.data
  if (!isJob(data)) return
  try {
    scope.postMessage({ type: 'result', id: data.id, result: runDiffJob(data.job, WORKER_LIMITS) })
  } catch {
    scope.postMessage({ type: 'error', id: data.id })
  }
})

scope.postMessage({ type: 'ready' })
