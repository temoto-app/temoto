/**
 * The entry point to a small helper kept resident as a child of the index process (PDF bodies: TODO 1009, image labels: TODO 998).
 *
 * Protocol: a request is "a one-line JSON header (containing `id` and the content's `size`)" followed by the content bytes written to stdin.
 * Responses are one JSON per line on stdout (matched by `id`). **No path is passed** (review of TODO 1009): the content is what the caller
 * read with O_NOFOLLOW. Requests go one at a time (the child processes them serially). On timeout the whole child is killed and recreated by the next request.
 * A child that is no longer used is ended after `idleMs`. A request held by a child that crashed or was killed returns null.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { log, errorFields } from '../common/logger.js'

export type HelperReply = Readonly<Record<string, unknown>>

interface Pending {
  readonly resolve: (value: HelperReply | null) => void
  readonly timer: NodeJS.Timeout
}

type Child = ChildProcessByStdio<Writable, Readable, null>

export interface StdioHelperOptions {
  /** Name for logs (`index.<name>.timeout` etc.). */
  readonly name: string
  readonly timeoutMs: number
  readonly idleMs: number
}

/** Per-request settings. */
export interface StdioRequestOptions {
  /** Name of a kind that uses a long limit only the first time per child (warm-up such as model loading). It counts as warmed once a response returns. */
  readonly warmKey?: string
  /** Limit (ms) of the warm-up request. */
  readonly warmTimeoutMs?: number
}

export class StdioHelper {
  private child: Child | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private idleTimer: NodeJS.Timeout | null = null
  /** Requests go one at a time (the child processes them serially). */
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
  /** Kinds for which a response has returned with the current child (`StdioRequestOptions.warmKey`). Emptied when the child is recreated. */
  private warmed = new Set<string>()

  constructor(
    private readonly helperPath: string,
    private readonly options: StdioHelperOptions
  ) {}

  /** Sends the header (`id` / `size` are added here) and the content, and returns the response JSON. null on failure, timeout, or child exit. */
  request(
    header: Readonly<Record<string, unknown>>,
    data: Uint8Array,
    requestOptions?: StdioRequestOptions
  ): Promise<HelperReply | null> {
    const run = this.tail.then(() => this.send(header, data, requestOptions))
    this.tail = run.catch(() => undefined)
    return run
  }

  dispose(): void {
    this.disposed = true
    this.clearIdle()
    this.kill()
  }

  private send(
    header: Readonly<Record<string, unknown>>,
    data: Uint8Array,
    requestOptions?: StdioRequestOptions
  ): Promise<HelperReply | null> {
    if (this.disposed) return Promise.resolve(null)
    const child = this.ensureChild()
    if (child === null) return Promise.resolve(null)
    this.clearIdle()
    const id = this.nextId++
    const warmKey = requestOptions?.warmKey
    const cold = warmKey !== undefined && !this.warmed.has(warmKey)
    const timeoutMs = cold ? Math.max(this.options.timeoutMs, requestOptions?.warmTimeoutMs ?? 0) : this.options.timeoutMs
    return new Promise<HelperReply | null>((resolve) => {
      const settle = (value: HelperReply | null): void => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        if (value !== null && warmKey !== undefined) this.warmed.add(warmKey)
        resolve(value)
        this.armIdle()
      }
      const timer = setTimeout(() => {
        // Timeout: kill the whole child (recreated by the next request).
        log.warn(`index.${this.options.name}.timeout`, { ms: timeoutMs })
        this.kill()
      }, timeoutMs)
      this.pending.set(id, { resolve: settle, timer })
      // The content follows right after the header. The child reads `size` bytes and then the next header.
      child.stdin.write(`${JSON.stringify({ ...header, id, size: data.byteLength })}\n`)
      child.stdin.write(data, (err) => {
        if (err) settle(null)
      })
    })
  }

  private ensureChild(): Child | null {
    if (this.child !== null) return this.child
    try {
      const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], env: {} })
      child.stdin.on('error', () => undefined)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        // Even if stdout of a child killed on timeout arrives late, it is not mixed into the current child's buffer.
        if (this.child !== child) return
        this.onData(chunk)
      })
      child.on('error', (err) => {
        log.warn(`index.${this.options.name}.helper.error`, errorFields(err))
        this.onExit(child)
      })
      child.on('exit', () => this.onExit(child))
      this.child = child
      this.buffer = ''
      this.warmed = new Set()
      return child
    } catch (err) {
      log.warn(`index.${this.options.name}.helper.spawn.failed`, errorFields(err))
      return null
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      let reply: unknown
      try {
        reply = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof reply !== 'object' || reply === null) continue
      const id = (reply as Record<string, unknown>)['id']
      if (typeof id !== 'number') continue
      this.pending.get(id)?.resolve(reply as HelperReply)
    }
  }

  private onExit(child: Child): void {
    if (this.child !== child) return
    this.child = null
    // Every request held by a crashed child becomes null (the caller treats it as "cannot be extracted").
    for (const entry of [...this.pending.values()]) entry.resolve(null)
  }

  private kill(): void {
    const child = this.child
    if (child === null) return
    this.onExit(child)
    try {
      child.kill('SIGKILL')
    } catch {
      // already ended
    }
  }

  private armIdle(): void {
    if (this.pending.size > 0 || this.disposed) return
    this.clearIdle()
    this.idleTimer = setTimeout(() => this.kill(), this.options.idleMs)
    this.idleTimer.unref()
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
