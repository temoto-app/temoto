/**
 * How `approve` waits (TODO 632, ARCHITECTURE 7.6.5). A pure part called from the gateway handler, split out of
 * index.ts so tests can check it without standing up the MCP SDK or a socket.
 *
 * The backend has two timeouts on an MCP tool call (spike 29, docs/notes/wave29.md bundle G):
 * idle (time with no response and no progress, default 30 minutes) and hard (wall clock, the `timeout` of the
 * `--mcp-config` server). An approval waits for the user, so it can take hours.
 */

/** The fields of the handler's second argument (`RequestHandlerExtra`) that this code uses. */
export interface ApproveCallExtra {
  readonly signal: AbortSignal
}

/**
 * Calls `onCancelled` when the backend cancels this call. Returns a function that detaches the listener.
 *
 * The SDK server calls `abort(params.reason)` on `notifications/cancelled`. The SDK client always sends the reason
 * as `String(reason)`, so **a string reason means the other side cancelled**. When the transport closes (the
 * backend ended) it is a bare `abort()` and the reason is a `DOMException` - we do not report that case
 * (main cleans up via `session-exited` as the end of the session; it must not show up as "timed out").
 */
export function watchCancellation(extra: ApproveCallExtra, onCancelled: () => void): () => void {
  const { signal } = extra
  const fire = (): void => {
    if (typeof signal.reason === 'string') onCancelled()
  }
  if (signal.aborted) {
    fire()
    return () => {}
  }
  signal.addEventListener('abort', fire, { once: true })
  return () => signal.removeEventListener('abort', fire)
}

/** Interval between progress notifications while waiting (TODO 632). The CLI's idle watcher ticks every 30 seconds; the threshold is 30 minutes by default. */
export const PROGRESS_INTERVAL_MS = 60_000

/** Shape of `notifications/progress` (MCP). `progress` must increase on every send. */
export interface ProgressNotification {
  readonly method: 'notifications/progress'
  readonly params: { readonly progressToken: string | number; readonly progress: number; readonly message?: string }
}

/** The fields of the handler's second argument used to send progress. */
export interface ProgressExtra extends ApproveCallExtra {
  readonly _meta?: { readonly progressToken?: string | number } | undefined
  sendNotification(notification: ProgressNotification): Promise<void>
}

export interface IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const REAL_TIMERS: IntervalTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

/**
 * If the call carries `_meta.progressToken`, sends `notifications/progress` every `intervalMs` until stopped
 * (TODO 632, 7.6.5). The CLI's idle timeout counts "time with no response and no progress", so this lets an approval
 * wait for hours (spike 29). Does nothing without a token (the MCP contract forbids sending one). Returns a stop function.
 * Stops by itself when cancelled (signal). If a send fails (transport closed, etc.) it quietly waits for the next tick.
 */
export function keepAlive(
  extra: ProgressExtra,
  intervalMs: number = PROGRESS_INTERVAL_MS,
  timers: IntervalTimers = REAL_TIMERS
): () => void {
  const token = extra._meta?.progressToken
  if (token === undefined || extra.signal.aborted) return () => {}
  let progress = 0
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    timers.clearInterval(handle)
  }
  const handle = timers.setInterval(() => {
    if (extra.signal.aborted) {
      stop()
      return
    }
    progress += 1
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, message: 'waiting for the user' }
      })
      .catch(() => {})
  }, intervalMs)
  return stop
}
