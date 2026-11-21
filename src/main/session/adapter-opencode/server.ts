/**
 * Starts `opencode serve` as a child process and talks to it over HTTP and SSE (TODO 529, ARCHITECTURE 4.6.1).
 *
 * - One `OpenCodeServer` = one serve process. One is started per session (because the gateway
 *   token is per session, while OpenCode's MCP settings are per process). The "catalog" serve that only
 *   fetches the model list uses the same class (without the gateway).
 * - The port is 0, read from `server listening on <url>` in the startup log. aios decides the password and
 *   passes it through env (it is not read from the log. `OPENCODE_SERVER_PASSWORD`).
 * - Settings are layered on via env (`OPENCODE_CONFIG_CONTENT`). The user's settings file is not rewritten (the OpenCode edition
 *   of constraint 7).
 * - The working directory is passed per request in a header.
 * - `ELECTRON_RUN_AS_NODE` is removed (it changes the child process's behavior).
 */
import { spawn as spawnProcess } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { log } from '../../../common/logger.js'
import type { OpenCodeTable } from './compat.js'
import type { ServerEvent } from './events.js'

export interface ServerOptions {
  readonly cwd: string
  /** The settings put into `OPENCODE_CONFIG_CONTENT` (passed as JSON). */
  readonly config: unknown
  /** Override of the executable name (tests). */
  readonly command?: string
  readonly env?: NodeJS.ProcessEnv
  readonly spawn?: typeof spawnProcess
}

export interface ApiResult {
  readonly status: number
  readonly json: unknown
}

/** A hook that tests replace: connect directly to an already started server. */
export interface ServerLink {
  readonly baseUrl: string
  readonly authorization: string
}

const SSE_RETRY_MS = 1000

export class OpenCodeServer {
  private child: ChildProcess | null = null
  private link: ServerLink | null = null
  private starting: Promise<ServerLink> | null = null
  private stopped = false
  private stderrTail = ''
  private readonly exitListeners = new Set<(code: number | null) => void>()

  constructor(
    private readonly table: OpenCodeTable,
    private readonly options: ServerOptions,
    /** Connect to an already running server (tests). If given, no child process is started. */
    link: ServerLink | null = null
  ) {
    this.link = link
  }

  get alive(): boolean {
    return !this.stopped && (this.link !== null || this.child !== null)
  }

  /** Called when the child process ends (also when we stopped it ourselves). */
  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** Start (only once). */
  ensure(): Promise<ServerLink> {
    if (this.link !== null) return Promise.resolve(this.link)
    if (this.starting === null) this.starting = this.start()
    return this.starting
  }

  private start(): Promise<ServerLink> {
    const t = this.table.serve
    const password = randomUUID()
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env) }
    delete env['ELECTRON_RUN_AS_NODE']
    env[t.passwordEnv] = password
    env[t.configEnv] = JSON.stringify(this.options.config)
    const spawner = this.options.spawn ?? spawnProcess
    const startedAt = Date.now()
    return new Promise<ServerLink>((resolve, reject) => {
      let settled = false
      const child = spawner(this.options.command ?? this.table.command, [...t.args], {
        cwd: this.options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.child = child
      const pattern = new RegExp(t.listeningPattern)
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        log.warn('backend.server.timeout', { ms: Date.now() - startedAt })
        child.kill('SIGTERM')
        reject(new Error('backend server did not start'))
      }, t.startTimeoutMs)
      const onChunk = (chunk: Buffer): void => {
        const text = chunk.toString()
        this.stderrTail = `${this.stderrTail}${text}`.slice(-2000)
        if (settled) return
        const m = pattern.exec(text)
        if (m?.[1] === undefined) return
        settled = true
        clearTimeout(timer)
        this.link = {
          baseUrl: m[1].replace(/\/$/, ''),
          authorization: `Basic ${Buffer.from(`${t.basicUser}:${password}`).toString('base64')}`
        }
        log.info('backend.server.started', { ms: Date.now() - startedAt })
        resolve(this.link)
      }
      child.stdout?.on('data', onChunk)
      child.stderr?.on('data', onChunk)
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child = null
        reject(err)
      })
      child.on('close', (code) => {
        this.child = null
        this.link = null
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(this.stderrTail.trim().slice(-300) || 'backend server exited'))
        }
        for (const listener of this.exitListeners) listener(code)
      })
    })
  }

  /** A JSON round trip. `directory` is the working directory (header). Does not throw (returns status and json). */
  async api(method: string, path: string, body?: unknown, directory?: string): Promise<ApiResult> {
    const link = await this.ensure()
    const headers: Record<string, string> = { authorization: link.authorization, 'content-type': 'application/json' }
    if (directory !== undefined) headers[this.table.serve.directoryHeader] = directory
    try {
      const res = await fetch(`${link.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      const text = await res.text()
      let json: unknown = null
      if (text !== '') {
        try {
          json = JSON.parse(text)
        } catch {
          json = text
        }
      }
      return { status: res.status, json }
    } catch (err) {
      return { status: 0, json: { error: (err as Error).message } }
    }
  }

  /**
   * Reads the SSE. If it drops, reconnects (if the server is alive). Stop it with the return value.
   * `onEvent` is called once per `data:` JSON.
   */
  subscribe(path: string, directory: string, onEvent: (ev: ServerEvent) => void): () => void {
    const controller = new AbortController()
    const run = async (): Promise<void> => {
      while (!controller.signal.aborted && !this.stopped) {
        let link: ServerLink
        try {
          link = await this.ensure()
        } catch {
          return
        }
        try {
          const res = await fetch(`${link.baseUrl}${path}`, {
            headers: { authorization: link.authorization, [this.table.serve.directoryHeader]: directory },
            signal: controller.signal
          })
          if (res.body === null) throw new Error('no body')
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let at: number
            while ((at = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, at)
              buffer = buffer.slice(at + 2)
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('')
              if (data === '') continue
              try {
                const parsed = JSON.parse(data) as ServerEvent
                if (typeof parsed.type === 'string') onEvent(parsed)
              } catch {
                // Drop a broken single message.
              }
            }
          }
        } catch (err) {
          if (controller.signal.aborted || this.stopped) return
          log.warn('backend.sse.dropped', { message: (err as Error).message })
        }
        if (controller.signal.aborted || this.stopped || this.child === null) return
        await new Promise((resolve) => setTimeout(resolve, SSE_RETRY_MS))
      }
    }
    void run()
    return () => controller.abort()
  }

  /** Stops. Waits for `close` (so that the exit handling does not run after the DB is closed, 12.9). */
  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    if (child === null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, 3000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}
