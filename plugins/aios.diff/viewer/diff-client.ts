/**
 * The viewer's side of the diff worker (TODO 1341 item 4, ARCHITECTURE 7.4.6).
 *
 * **Starting the worker inside the sandboxed iframe.** The iframe has an opaque origin, so `new Worker('aios-plugin://…')` is refused
 * (a Worker URL must be same-origin with the document) and a `blob:` worker fails as a "cross-origin redirect" (both seen by `aios.pdf`,
 * docs/notes/wave21.md). A `data:` module worker works: it inherits the document's CSP, so the viewer's meta CSP allows it with
 * `worker-src data:` (inside main's ceiling `worker-src aios-plugin: blob: data:`), and the `import()` inside it is allowed by
 * `script-src aios-plugin:` (main serves plugin files with `access-control-allow-origin: *`). Messages that arrive while the import runs are
 * held and dispatched again afterwards, or they would be lost (the `aios.pdf` stall).
 *
 * **Failure means the UI thread.** If the worker cannot be created, reports an error, or does not say it is ready within `readyTimeoutMs`,
 * the client is `broken` and every pending and later `compute` rejects; the caller then runs the same job on its own thread
 * (`UI_THREAD_LIMITS`). One job runs at a time: a new job while one is running terminates that worker (its result would be stale anyway)
 * and resolves the old job with `null`, which the caller ignores.
 */
import { isDiffJobResult, sameJob, type DiffJob, type DiffJobResult } from './diff-work.js'

/** The part of `Worker` used here (a fake in tests). */
export interface WorkerLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void
  terminate(): void
}

export interface DiffWorkerClient {
  /** The result; `null` when a newer job superseded this one. Rejects when the worker failed (run the job on the UI thread then). */
  compute(job: DiffJob): Promise<DiffJobResult | null>
  /** The worker failed once; later jobs reject at once. */
  readonly broken: boolean
  /** Stops the job that runs now, if any (its promise resolves with `null`; the worker is terminated and made again on the next job). */
  cancel(): void
  dispose(): void
}

/** How long the worker may take to load before the viewer stops waiting for it. */
export const WORKER_READY_TIMEOUT_MS = 5_000

/** The source of the `data:` module worker that imports the bundled worker at `scriptUrl` (an absolute `aios-plugin:` URL). */
export function workerBootstrap(scriptUrl: string): string {
  const source = [
    'const held = [];',
    'const hold = (event) => { held.push(event.data); event.stopImmediatePropagation(); };',
    "self.addEventListener('message', hold);",
    `await import(${JSON.stringify(scriptUrl)});`,
    "self.removeEventListener('message', hold);",
    "for (const data of held) self.dispatchEvent(new MessageEvent('message', { data }));",
    ''
  ].join('\n')
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`
}

export function createDiffWorkerClient(
  scriptUrl: string,
  options: {
    readonly createWorker?: (url: string) => WorkerLike
    readonly readyTimeoutMs?: number
  } = {}
): DiffWorkerClient {
  const createWorker = options.createWorker ?? ((url: string) => new Worker(url, { type: 'module' }) as unknown as WorkerLike)
  const readyTimeoutMs = options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS
  let broken = false
  let worker: WorkerLike | null = null
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  let nextId = 1
  let pending: {
    readonly id: number
    readonly kind: DiffJob['kind']
    readonly resolve: (result: DiffJobResult | null) => void
    readonly reject: (error: Error) => void
  } | null = null

  const clearReady = (): void => {
    if (readyTimer !== null) clearTimeout(readyTimer)
    readyTimer = null
  }
  const stop = (): void => {
    clearReady()
    const current = worker
    worker = null
    current?.terminate()
  }
  const fail = (): void => {
    broken = true
    stop()
    const job = pending
    pending = null
    job?.reject(new Error('diff worker failed'))
  }
  const start = (): WorkerLike | null => {
    let created: WorkerLike
    try {
      created = createWorker(workerBootstrap(scriptUrl))
    } catch {
      fail()
      return null
    }
    worker = created
    created.addEventListener('message', (event) => {
      if (worker !== created) return
      const data = (event as MessageEvent).data as { type?: unknown; id?: unknown; result?: unknown } | null
      if (data === null || typeof data !== 'object') return
      if (data.type === 'ready') {
        clearReady()
        return
      }
      if (pending === null || data.id !== pending.id) return
      const job = pending
      if (data.type === 'result' && isDiffJobResult(data.result, job.kind)) {
        pending = null
        job.resolve(data.result)
      } else {
        fail()
      }
    })
    const onError = (): void => {
      if (worker === created) fail()
    }
    created.addEventListener('error', onError)
    created.addEventListener('messageerror', onError)
    readyTimer = setTimeout(() => {
      if (worker === created) fail()
    }, readyTimeoutMs)
    return created
  }

  return {
    get broken() {
      return broken
    },
    compute(job) {
      if (broken) return Promise.reject(new Error('diff worker unavailable'))
      if (pending !== null) {
        // Still busy with an older job: drop that worker rather than wait for a result nobody will use.
        const old = pending
        pending = null
        stop()
        old.resolve(null)
      }
      const target = worker ?? start()
      if (target === null) return Promise.reject(new Error('diff worker unavailable'))
      const id = nextId++
      return new Promise<DiffJobResult | null>((resolve, reject) => {
        pending = { id, kind: job.kind, resolve, reject }
        try {
          target.postMessage({ id, job: { kind: job.kind, a: job.a, b: job.b } })
        } catch {
          fail()
        }
      })
    },
    cancel() {
      const job = pending
      if (job === null) return
      pending = null
      stop()
      job.resolve(null)
    },
    dispose() {
      const job = pending
      pending = null
      stop()
      job?.resolve(null)
    }
  }
}

export interface DiffScheduler {
  /**
   * The result for `job` if it is known. Otherwise starts it (once per contents: asking again while it runs does not start it again) and
   * returns undefined; `onReady` is called when it lands. Without a worker (or after the worker failed) the job runs here, at once.
   */
  resultFor(job: DiffJob): DiffJobResult | undefined
  /** The contents changed to something that needs no job: a result still on its way is dropped. */
  cancel(): void
  /** A job is on its way. */
  readonly running: boolean
}

/**
 * Which result belongs to the contents on screen (TODO 1341 item 4). Every started job gets a generation; a result is kept only while
 * its generation is the latest, so a slow result for older contents never replaces a newer view. A worker failure runs that same job
 * with `runHere` (the UI thread), again only if nothing newer was asked for meanwhile.
 */
export function createDiffScheduler(args: {
  readonly client: () => DiffWorkerClient | null
  readonly runHere: (job: DiffJob) => DiffJobResult
  readonly onReady: () => void
}): DiffScheduler {
  let done: { readonly job: DiffJob; readonly result: DiffJobResult } | null = null
  let running: { readonly job: DiffJob; readonly generation: number; readonly client: DiffWorkerClient } | null = null
  let generation = 0
  /**
   * Whatever runs now is for contents no longer wanted: its result is dropped (the generation moves on) and the worker stops working on it
   * (wave 109 fix X2: a cached result drawn while another job ran left that job current, and its late result replaced the cache).
   */
  const drop = (): void => {
    generation++
    const stale = running
    running = null
    stale?.client.cancel()
  }
  return {
    get running() {
      return running !== null
    },
    cancel: drop,
    resultFor(job) {
      if (done !== null && sameJob(done.job, job)) {
        if (running !== null) drop()
        return done.result
      }
      if (running !== null && sameJob(running.job, job)) return undefined
      const client = args.client()
      if (client === null || client.broken) {
        drop()
        const result = args.runHere(job)
        done = { job, result }
        return result
      }
      const mine = ++generation
      running = { job, generation: mine, client }
      const finish = (result: DiffJobResult): void => {
        if (mine !== generation) return
        running = null
        done = { job, result }
        args.onReady()
      }
      client.compute(job).then(
        (result) => {
          // null: a newer job took the worker; that job's own result arrives instead.
          if (result !== null) finish(result)
        },
        () => {
          if (mine === generation) finish(args.runHere(job))
        }
      )
      return undefined
    }
  }
}
