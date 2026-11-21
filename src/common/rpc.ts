/**
 * A small pair of endpoints that only round-trips `IndexRpcMessage` (P1, ARCHITECTURE.md chapter 3).
 *
 * **Both** the main side (`IndexClient`) and the index process side (`index-host`) use it.
 * It does not know the transport (`UtilityProcess.postMessage` / `process.parentPort`) -
 * it only has `send` injected, so tests can connect two ends with two EventEmitters.
 *
 * It has just four responsibilities:
 *  - match the `id` of requests it sent with their responses (`pending`)
 *  - route requests from the peer to the method table and return the response
 *  - reject all unanswered requests together when the peer dies (`rejectAll`)
 *  - reject a request that exceeds an optional limit (`timeoutMs`) with `RPC_TIMEOUT` (item 87).
 *    When the peer is **alive but merely stuck**, `rejectAll` does not apply,
 *    so without this the caller would wait forever. A response that arrives late is
 *    dropped because its id is no longer in `pending`.
 */
import type {
  IndexRpcMessage,
  IndexRpcNotify,
  IndexRpcNotifyEvent
} from '@shared/index-rpc.js'

export type RpcHandler = (params: unknown) => unknown

/** method name -> implementation. **The string table is in this one place**; callers write explicit methods. */
export type RpcMethods = Readonly<Record<string, RpcHandler>>

interface Waiter {
  readonly resolve: (value: unknown) => void
  readonly reject: (err: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | null
}

/** The `Error.name` of a request that exceeded the limit. Callers use it to tell it apart and rephrase it in their own reason. */
export const RPC_TIMEOUT = 'RpcTimeout'

export interface RequestOptions {
  /** Limit on waiting for a response (ms). If omitted or 0 or less, unlimited (for long requests such as a scan). */
  readonly timeoutMs?: number
}

export class RpcPeer {
  private nextId = 1
  private readonly pending = new Map<number, Waiter>()
  private methods: RpcMethods

  constructor(
    private readonly send: (message: IndexRpcMessage) => void,
    methods: RpcMethods = {},
    private readonly onNotify: (notify: IndexRpcNotify) => void = () => undefined
  ) {
    this.methods = methods
  }

  setMethods(methods: RpcMethods): void {
    this.methods = methods
  }

  /** The number of unanswered requests (for tests and observation). */
  get pendingCount(): number {
    return this.pending.size
  }

  request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1
    const timeoutMs = options.timeoutMs ?? 0
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!this.pending.delete(id)) return
              const err = new Error(`rpc timeout: ${method} after ${timeoutMs} ms`)
              err.name = RPC_TIMEOUT
              reject(err)
            }, timeoutMs)
          : null
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ kind: 'req', id, method, params })
      } catch (err) {
        this.pending.delete(id)
        if (timer !== null) clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  notify(event: IndexRpcNotifyEvent, payload: unknown): void {
    this.send({ kind: 'ntf', event, payload })
  }

  /** One message from the peer. A request goes to the method table; a response resolves its pending entry. */
  receive(message: IndexRpcMessage): void {
    if (message.kind === 'ntf') {
      this.onNotify(message)
      return
    }
    if (message.kind === 'res') {
      // A late response to a request already given up on after the limit is silently dropped here.
      const waiter = this.pending.get(message.id)
      if (waiter === undefined) return
      this.pending.delete(message.id)
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      if (message.ok) waiter.resolve(message.result)
      else {
        const err = new Error(message.error.message)
        err.name = message.error.name
        waiter.reject(err)
      }
      return
    }
    void this.dispatch(message.id, message.method, message.params)
  }

  private async dispatch(id: number, method: string, params: unknown): Promise<void> {
    try {
      const handler = Object.hasOwn(this.methods, method) ? this.methods[method] : undefined
      if (handler === undefined) throw new Error(`unknown method: ${method}`)
      const result = await handler(params)
      this.send({ kind: 'res', id, ok: true, result: result ?? null })
    } catch (err) {
      const error =
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { name: 'Error', message: String(err) }
      this.send({ kind: 'res', id, ok: false, error })
    }
  }

  /** The peer died / stopped. Give everyone waiting the same reason. */
  rejectAll(err: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of waiting) {
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      waiter.reject(err)
    }
  }
}
