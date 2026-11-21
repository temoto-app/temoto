/**
 * A general-purpose buffer that batches main -> renderer events at a fixed interval.
 *
 * It descends from `ChangeBatcher` in Phase 1's `fs/watcher.ts`. Phase 2 needed the same approach for
 * session streaming, so it was generalized
 * (ARCHITECTURE.md 5.1 / spike 8: text_delta arrives at a median 26 ms interval,
 *  thinking flows about 7 times the volume of the body, and with 3-5 sessions in parallel it reaches hundreds of events per second).
 *
 * One message per event would flood the renderer, so **batch every 16 ms**.
 */
export const FLUSH_INTERVAL_MS = 16

/**
 * Frees the main thread for one tick.
 *
 * Synchronous reads and writes to the encrypted DB become main-thread stall time as the row count grows
 * (Phase 3's cleanup job stalled it for 100 seconds). Split long work into small pieces and call this between
 * them so IPC and rendering can run.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

export interface BatcherOptions<T> {
  readonly intervalMs?: number
  /**
   * Coalescing key. Items that return the same key keep **only the last one**.
   * If omitted, nothing is coalesced and every item is kept in arrival order (streaming deltas are
   * meaningful one by one, so they must not be coalesced).
   */
  readonly keyOf?: (item: T) => string
}

export class Batcher<T> {
  private readonly intervalMs: number
  private readonly keyOf: ((item: T) => string) | null
  private keyed: Map<string, T> | null
  private list: T[]
  private timer: ReturnType<typeof setTimeout> | null = null
  /**
   * Whether `dispose()` has been called.
   *
   * A `push` after disposal would **re-arm** the timer, and it would fire 16 ms later with nobody to stop it.
   * Shutdown goes "discard the buffer -> stop the subscription", and stopping the subscription is
   * asynchronous, so a flush of an event that arrives in that gap survives until after the DB is closed
   * (`The database connection is not open`). After disposal, drop.
   */
  private disposed = false

  constructor(
    private readonly onFlush: (items: readonly T[]) => void,
    options: BatcherOptions<T> = {}
  ) {
    this.intervalMs = options.intervalMs ?? FLUSH_INTERVAL_MS
    this.keyOf = options.keyOf ?? null
    this.keyed = this.keyOf === null ? null : new Map<string, T>()
    this.list = []
  }

  push(item: T): void {
    if (this.disposed) return
    if (this.keyOf !== null && this.keyed !== null) this.keyed.set(this.keyOf(item), item)
    else this.list.push(item)
    if (this.timer === null) this.timer = setTimeout(() => this.flushNow(), this.intervalMs)
  }

  flushNow(): void {
    if (this.disposed) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.size === 0) return
    const items = this.keyed !== null ? [...this.keyed.values()] : this.list
    if (this.keyed !== null) this.keyed.clear()
    else this.list = []
    this.onFlush(items)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.keyed?.clear()
    this.list = []
  }

  /**
   * Disposes and returns the items left in the batch (TODO 889). `onFlush` is not called, because the caller treats
   * them as "the last portion" with different handling (a final drain right before shutdown). Later `push` calls are ignored, as with `dispose()`.
   */
  drain(): T[] {
    const items = this.disposed ? [] : this.keyed !== null ? [...this.keyed.values()] : this.list
    this.dispose()
    return items
  }

  get size(): number {
    return this.keyed !== null ? this.keyed.size : this.list.length
  }
}
