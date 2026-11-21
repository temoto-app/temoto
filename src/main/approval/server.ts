/**
 * IPC between the gateway and main (ARCHITECTURE.md 7.6).
 *
 * A Unix domain socket plus a session token. There is one gateway process per session,
 * launched by the CLI. Main **identifies the session by token** and rejects connections without a token.
 * This layer keeps other local processes from calling main's IPC.
 *
 * Measured in spike 10: transfer latency p50 0.10 ms. Authentication and degradation on disconnect are handled entirely here.
 * **No timeout is implemented** (approvals wait without limit; spike 2).
 */
import { createServer, type Server, type Socket } from 'node:net'
import { mkdirSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { gatewayEndpointPath, restrictEndpointToOwner } from '../os/endpoint.js'
import { log, errorFields } from '../../common/logger.js'
import { LineReader, LineTooLongError } from '../../common/line-reader.js'

/** Socket name. macOS's sun_path is 104 bytes, so keep it short. */

/**
 * Upper bound of one frame (the fragment without a newline) (TODO 569). An approval request's `input` carries the whole
 * `content` of a Write, so this is set larger than the plugin read limit of 8 MB. If exceeded, disconnect and log.
 */
export const MAX_FRAME_CHARS = 64 * 1024 * 1024

/** One frame arriving from the gateway. */
interface Frame {
  readonly id: number
  readonly token: string
  readonly payload?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the shape before reading (TODO 569). `null`, a number, a string, or a field of the wrong type is false. */
function isFrame(value: unknown): value is Frame {
  return (
    isRecord(value) &&
    typeof value['id'] === 'number' &&
    typeof value['token'] === 'string' &&
    (value['payload'] === undefined || isRecord(value['payload']))
  )
}

export interface GatewayRequest {
  /** aios's internal session ID identified from the token. */
  readonly sessionId: string
  readonly kind: string
  readonly payload: Record<string, unknown>
}

export type GatewayHandler = (request: GatewayRequest) => Promise<unknown>

export class GatewayServer {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  /** token -> aios session ID. */
  private readonly tokens = new Map<string, string>()
  readonly socketPath: string

  constructor(
    private readonly runtimeDir: string,
    private readonly handler: GatewayHandler,
    /** Upper bound of one frame (in characters). Tests make it smaller. */
    private readonly maxFrameChars: number = MAX_FRAME_CHARS
  ) {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    this.socketPath = gatewayEndpointPath(runtimeDir)
  }

  async start(): Promise<void> {
    rmSync(this.socketPath, { force: true })
    const server = createServer((socket) => this.onConnection(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        // Owner only (7.6).
        restrictEndpointToOwner(this.socketPath)
        server.removeListener('error', reject)
        resolve()
      })
    })
    server.on('error', (err) => log.error('gateway.server.error', errorFields(err)))
    log.info('gateway.server.listening', { socket: this.socketPath })
  }

  /** Issues a token for a session. */
  issueToken(sessionId: string): string {
    const token = randomBytes(32).toString('hex')
    this.tokens.set(token, sessionId)
    return token
  }

  revokeToken(token: string): void {
    this.tokens.delete(token)
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.tokens.clear()
    const server = this.server
    this.server = null
    if (server === null) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(this.socketPath, { force: true })
    log.info('gateway.server.stopped', {})
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())

    // One per connection. Does not garble text even if a chunk boundary falls in the middle of a UTF-8 character (TODO 565).
    const reader = new LineReader({ maxPendingChars: this.maxFrameChars, overflow: 'throw' })
    socket.on('data', (chunk: Buffer) => {
      let lines: string[]
      try {
        lines = reader.push(chunk)
      } catch (err) {
        if (!(err instanceof LineTooLongError)) throw err
        // Even if a gateway bug sends a huge frame with no newline, main's memory does not keep growing (TODO 569).
        log.warn('gateway.frame.too-long', { chars: err.chars })
        socket.destroy()
        return
      }
      for (const line of lines) {
        if (socket.destroyed) return
        void this.onFrame(socket, line)
      }
    })
  }

  private async onFrame(socket: Socket, line: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      socket.destroy()
      return
    }
    // A frame of the wrong shape is cut off unread (TODO 569). Previously a `null` / number line made `frame.token` throw a
    // TypeError, and since it is `void this.onFrame()` it became an unhandled rejection.
    if (!isFrame(parsed)) {
      log.warn('gateway.frame.malformed', {})
      socket.destroy()
      return
    }
    const frame = parsed

    const sessionId = this.tokens.get(frame.token)
    if (sessionId === undefined) {
      // A frame with a mismatched token is rejected and the connection is closed (7.6, implemented and confirmed in spike 10).
      log.warn('gateway.unauthorized', {})
      socket.write(`${JSON.stringify({ id: frame.id, error: 'unauthorized' })}\n`)
      socket.end()
      return
    }

    const payload = frame.payload ?? {}
    const kind = typeof payload['kind'] === 'string' ? payload['kind'] : 'unknown'
    try {
      const result = await this.handler({ sessionId, kind, payload })
      if (socket.destroyed || socket.writableEnded) return
      socket.write(`${JSON.stringify({ id: frame.id, result })}\n`)
    } catch (err) {
      if (socket.destroyed || socket.writableEnded) return
      socket.write(
        `${JSON.stringify({ id: frame.id, error: (err as Error).message ?? 'error' })}\n`
      )
    }
  }
}
