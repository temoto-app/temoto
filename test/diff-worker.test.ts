/**
 * The diff viewer's Web Worker (TODO 1341 item 4, ARCHITECTURE 7.4.6): the client that starts it inside the sandboxed iframe, the worker
 * module itself, and the scheduler that decides which result belongs to the contents on screen.
 *
 * No real Worker here (Node has none with the iframe's rules): a fake stands in, and for the end-to-end case it forwards to the real
 * `diff-worker.ts` module loaded with a stubbed `self`. Whether Chromium starts the `data:` module worker in the sandboxed iframe is
 * not checked here (see the notes of wave 109).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createDiffScheduler,
  createDiffWorkerClient,
  workerBootstrap,
  type DiffWorkerClient,
  type WorkerLike
} from '../plugins/aios.diff/viewer/diff-client.js'
import { WORKER_LIMITS } from '../plugins/aios.diff/viewer/coarse-diff.js'
import { diffJobFor, runDiffJob, type DiffJob, type DiffJobResult } from '../plugins/aios.diff/viewer/diff-work.js'

type Listener = (event: Event) => void

class FakeWorker implements WorkerLike {
  readonly listeners: Record<'message' | 'error' | 'messageerror', Listener[]> = { message: [], error: [], messageerror: [] }
  readonly posted: unknown[] = []
  terminated = false
  constructor(
    readonly url: string,
    private readonly onJob: (worker: FakeWorker, message: unknown) => void
  ) {}
  postMessage(message: unknown): void {
    this.posted.push(message)
    setTimeout(() => {
      if (!this.terminated) this.onJob(this, message)
    }, 0)
  }
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: Listener): void {
    this.listeners[type].push(listener)
  }
  terminate(): void {
    this.terminated = true
  }
  emit(type: 'message', data: unknown): void
  emit(type: 'error' | 'messageerror'): void
  emit(type: 'message' | 'error' | 'messageerror', data?: unknown): void {
    const event = type === 'message' ? new MessageEvent('message', { data }) : new Event(type)
    for (const listener of this.listeners[type]) listener(event)
  }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n'
const BIG = lines(2000, (i) => `const value_${i} = compute(${i}, 'item ${i}') // padding ${i}`)
const JOB: DiffJob = diffJobFor(BIG, BIG.replace('value_100 =', 'renamed_100 =').replace('value_1900 =', 'renamed_1900 ='))!

/** A worker that says ready and answers every job with `runDiffJob` (what `diff-worker.ts` does). */
function answering(created: FakeWorker[]): (url: string) => WorkerLike {
  return (url) => {
    const worker = new FakeWorker(url, (self, message) => {
      const { id, job } = message as { id: number; job: DiffJob }
      self.emit('message', { type: 'result', id, result: runDiffJob(job, WORKER_LIMITS) })
    })
    created.push(worker)
    setTimeout(() => worker.emit('message', { type: 'ready' }), 0)
    return worker
  }
}

describe('diffJobFor', () => {
  it('asks for no job below the line-diff threshold, a character job above it, and a line job above the diff limit', () => {
    expect(diffJobFor('a\n', 'b\n')).toBeNull()
    expect(JOB.kind).toBe('chars')
    const huge = lines(40_000, (i) => `row ${i} ..............................`)
    expect(diffJobFor(huge, huge)?.kind).toBe('lines')
  })
})

describe('workerBootstrap', () => {
  it('is a data: module source that holds messages while it imports the bundled worker, then replays them', () => {
    const url = workerBootstrap('aios-plugin://aios.diff/@1.0.0/assets/diff-worker-x.js')
    expect(url.startsWith('data:text/javascript;charset=utf-8,')).toBe(true)
    const source = decodeURIComponent(url.slice(url.indexOf(',') + 1))
    expect(source).toContain('await import("aios-plugin://aios.diff/@1.0.0/assets/diff-worker-x.js");')
    // Held before the import, replayed after it (a message posted while the import runs must not be lost).
    expect(source.indexOf("addEventListener('message', hold)")).toBeLessThan(source.indexOf('await import('))
    expect(source.indexOf('dispatchEvent')).toBeGreaterThan(source.indexOf('await import('))
  })
})

describe('createDiffWorkerClient', () => {
  it('returns the worker result for a job (even one posted before the worker said ready)', async () => {
    const created: FakeWorker[] = []
    const client = createDiffWorkerClient('aios-plugin://aios.diff/assets/w.js', { createWorker: answering(created) })
    const result = await client.compute(JOB)
    expect(result).toEqual(runDiffJob(JOB, WORKER_LIMITS))
    expect(created).toHaveLength(1)
    expect(created[0]!.url.startsWith('data:text/javascript')).toBe(true)
    // The worker is kept for the next job.
    await client.compute(JOB)
    expect(created).toHaveLength(1)
    expect(client.broken).toBe(false)
  })

  it('a new job while one runs drops that worker and resolves the old job with null', async () => {
    const created: FakeWorker[] = []
    const make = answering(created)
    let first = true
    const client = createDiffWorkerClient('u', {
      createWorker: (url) => {
        if (!first) return make(url)
        first = false
        // The first worker is slow: it never answers.
        const slow = new FakeWorker(url, () => undefined)
        created.push(slow)
        return slow
      }
    })
    const old = client.compute(JOB)
    const next = client.compute({ ...JOB, b: JOB.a })
    expect(await old).toBeNull()
    expect(created[0]!.terminated).toBe(true)
    expect(await next).toEqual({ kind: 'chars', changes: [] })
    expect(created).toHaveLength(2)
  })

  it('cancel stops the running job (null, worker terminated) and the next job starts a new worker', async () => {
    const created: FakeWorker[] = []
    const make = answering(created)
    let first = true
    const client = createDiffWorkerClient('u', {
      createWorker: (url) => {
        if (!first) return make(url)
        first = false
        const slow = new FakeWorker(url, () => undefined)
        created.push(slow)
        return slow
      }
    })
    const old = client.compute(JOB)
    client.cancel()
    expect(await old).toBeNull()
    expect(created[0]!.terminated).toBe(true)
    // Nothing runs: a second cancel is a no-op.
    client.cancel()
    expect(await client.compute(JOB)).toEqual(runDiffJob(JOB, WORKER_LIMITS))
    expect(created).toHaveLength(2)
    expect(client.broken).toBe(false)
  })

  it('a worker error rejects the job and every later one, without starting another worker', async () => {
    const created: FakeWorker[] = []
    const client = createDiffWorkerClient('u', {
      createWorker: (url) => {
        const worker = new FakeWorker(url, (self) => self.emit('error'))
        created.push(worker)
        return worker
      }
    })
    await expect(client.compute(JOB)).rejects.toThrow()
    expect(client.broken).toBe(true)
    expect(created[0]!.terminated).toBe(true)
    await expect(client.compute(JOB)).rejects.toThrow()
    expect(created).toHaveLength(1)
  })

  it('a worker that cannot be created (CSP, no Worker) rejects at once', async () => {
    const client = createDiffWorkerClient('u', {
      createWorker: () => {
        throw new Error('SecurityError')
      }
    })
    await expect(client.compute(JOB)).rejects.toThrow()
    expect(client.broken).toBe(true)
  })

  it('a worker that never says ready (its import failed silently) is given up after the timeout', async () => {
    const client = createDiffWorkerClient('u', {
      createWorker: (url) => new FakeWorker(url, () => undefined),
      readyTimeoutMs: 20
    })
    await expect(client.compute(JOB)).rejects.toThrow()
    expect(client.broken).toBe(true)
  })

  it('a malformed or error answer counts as a failure', async () => {
    for (const answer of [{ type: 'result', result: { kind: 'lines', chunks: [] } }, { type: 'error' }, { type: 'result', result: 7 }]) {
      const client = createDiffWorkerClient('u', {
        createWorker: (url) => {
          const worker = new FakeWorker(url, (self, message) => self.emit('message', { ...answer, id: (message as { id: number }).id }))
          setTimeout(() => worker.emit('message', { type: 'ready' }), 0)
          return worker
        }
      })
      await expect(client.compute(JOB), JSON.stringify(answer)).rejects.toThrow()
    }
  })
})

describe('diff-worker.ts (the worker module, with a stubbed worker scope)', () => {
  const posted: unknown[] = []
  let onMessage: ((event: MessageEvent) => void) | null = null
  beforeAll(async () => {
    vi.stubGlobal('self', {
      postMessage: (message: unknown) => posted.push(message),
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        onMessage = listener
      }
    })
    await import('../plugins/aios.diff/viewer/diff-worker.js')
    vi.unstubAllGlobals()
  })

  it('says ready once loaded, answers a job with WORKER_LIMITS and ignores what is not a job', () => {
    expect(posted).toEqual([{ type: 'ready' }])
    onMessage!(new MessageEvent('message', { data: { id: 3, job: JOB } }))
    expect(posted[1]).toEqual({ type: 'result', id: 3, result: runDiffJob(JOB, WORKER_LIMITS) })
    onMessage!(new MessageEvent('message', { data: { id: 4, job: { kind: 'shell', a: 'x', b: 'y' } } }))
    onMessage!(new MessageEvent('message', { data: 'hello' }))
    expect(posted).toHaveLength(2)
  })

  it('works end to end behind the client', async () => {
    const client = createDiffWorkerClient('u', {
      createWorker: (url) => {
        const worker = new FakeWorker(url, (_self, message) => {
          posted.length = 0
          onMessage!(new MessageEvent('message', { data: message }))
          for (const answer of posted) worker.emit('message', answer)
        })
        setTimeout(() => worker.emit('message', { type: 'ready' }), 0)
        return worker
      }
    })
    expect(await client.compute(JOB)).toEqual(runDiffJob(JOB, WORKER_LIMITS))
  })
})

describe('createDiffScheduler', () => {
  interface Deferred {
    readonly job: DiffJob
    resolve(result: DiffJobResult | null): void
    reject(): void
  }
  const fakeClient = (): { client: DiffWorkerClient; calls: Deferred[]; broken: { value: boolean }; cancels: { count: number } } => {
    const calls: Deferred[] = []
    const broken = { value: false }
    const cancels = { count: 0 }
    const client: DiffWorkerClient = {
      get broken() {
        return broken.value
      },
      compute: (job) =>
        new Promise((resolve, reject) => {
          calls.push({ job, resolve, reject: () => reject(new Error('failed')) })
        }),
      cancel: () => {
        cancels.count++
      },
      dispose: () => undefined
    }
    return { client, calls, broken, cancels }
  }
  const resultOf = (tag: number): DiffJobResult => ({ kind: 'chars', changes: [{ fromA: tag, toA: tag, fromB: tag, toB: tag + 1 }] })
  const jobA = JOB
  const jobB: DiffJob = { ...JOB, b: JOB.b.replace('renamed_100', 'other_100') }
  afterEach(() => vi.restoreAllMocks())

  it('without a worker, runs the job here at once and keeps the result for a redraw', () => {
    const runHere = vi.fn(() => resultOf(1))
    const onReady = vi.fn()
    const jobs = createDiffScheduler({ client: () => null, runHere, onReady })
    expect(jobs.resultFor(jobA)).toEqual(resultOf(1))
    expect(jobs.resultFor(jobA)).toEqual(resultOf(1))
    expect(runHere).toHaveBeenCalledTimes(1)
    expect(onReady).not.toHaveBeenCalled()
  })

  it('starts a job once, reports when it lands, and then serves the result', async () => {
    const { client, calls } = fakeClient()
    const onReady = vi.fn()
    const jobs = createDiffScheduler({ client: () => client, runHere: () => resultOf(0), onReady })
    expect(jobs.resultFor(jobA)).toBeUndefined()
    // A redraw while it runs (theme, language) does not start it again.
    expect(jobs.resultFor(jobA)).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(jobs.running).toBe(true)
    calls[0]!.resolve(resultOf(1))
    await tick()
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(jobs.running).toBe(false)
    expect(jobs.resultFor(jobA)).toEqual(resultOf(1))
  })

  it('drops a result that arrives after newer contents were asked for (it never replaces the newer view)', async () => {
    const { client, calls } = fakeClient()
    const onReady = vi.fn()
    const jobs = createDiffScheduler({ client: () => client, runHere: () => resultOf(0), onReady })
    jobs.resultFor(jobA)
    jobs.resultFor(jobB)
    // The old one lands late.
    calls[0]!.resolve(resultOf(1))
    await tick()
    expect(onReady).not.toHaveBeenCalled()
    expect(jobs.resultFor(jobB)).toBeUndefined()
    calls[1]!.resolve(resultOf(2))
    await tick()
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(jobs.resultFor(jobB)).toEqual(resultOf(2))
  })

  it('a cached result drawn while another job runs makes that job stale (wave 109 fix X2)', async () => {
    const { client, calls, cancels } = fakeClient()
    const onReady = vi.fn()
    const jobs = createDiffScheduler({ client: () => client, runHere: () => resultOf(0), onReady })
    // A is computed and cached.
    jobs.resultFor(jobA)
    calls[0]!.resolve(resultOf(1))
    await tick()
    expect(onReady).toHaveBeenCalledTimes(1)
    // B starts; before it lands, A comes back and is drawn from the cache.
    expect(jobs.resultFor(jobB)).toBeUndefined()
    expect(jobs.resultFor(jobA)).toEqual(resultOf(1))
    expect(jobs.running).toBe(false)
    // The worker is told to stop B.
    expect(cancels.count).toBe(1)
    // B's late result must neither redraw nor push A out of the cache (which would recompute A and rebuild the view).
    calls[1]!.resolve(resultOf(2))
    await tick()
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(jobs.resultFor(jobA)).toEqual(resultOf(1))
    expect(calls).toHaveLength(2)
  })

  it('drops a result after `cancel` (the contents changed to something that needs no job)', async () => {
    const { client, calls } = fakeClient()
    const onReady = vi.fn()
    const jobs = createDiffScheduler({ client: () => client, runHere: () => resultOf(0), onReady })
    jobs.resultFor(jobA)
    jobs.cancel()
    expect(jobs.running).toBe(false)
    calls[0]!.resolve(resultOf(1))
    await tick()
    expect(onReady).not.toHaveBeenCalled()
  })

  it('a worker failure runs the same job here (as before the worker), but not for contents that are gone', async () => {
    const { client, calls, broken } = fakeClient()
    const runHere = vi.fn((job: DiffJob) => (job === jobA ? resultOf(7) : resultOf(8)))
    const onReady = vi.fn()
    const jobs = createDiffScheduler({ client: () => client, runHere, onReady })
    jobs.resultFor(jobA)
    calls[0]!.reject()
    await tick()
    expect(runHere).toHaveBeenCalledWith(jobA)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(jobs.resultFor(jobA)).toEqual(resultOf(7))

    jobs.resultFor(jobB)
    jobs.cancel()
    calls[1]!.reject()
    await tick()
    expect(runHere).toHaveBeenCalledTimes(1)

    // Once the client is broken, a job runs here at once.
    broken.value = true
    expect(jobs.resultFor(jobB)).toEqual(resultOf(8))
  })
})
