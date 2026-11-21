/**
 * Bookkeeping for gateway -> main calls (7.6): a table mapping a response `id` to the Promise waiting on it.
 * Importing index.ts starts an MCP server, so this is split out so that tests can check it without
 * standing up a socket or the SDK.
 *
 * Calls get **no timeout by default** (an approval goes through even after 600 seconds, 7.6). A timeout is attached
 * only to calls with a bounded wait, such as the plugin tool list at startup (TODO 847). A timed-out entry is
 * removed from the table (wave 45 code-review: before, `Promise.race` only stopped waiting and the table entry stayed forever).
 */

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (err: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | null
}

export class PendingCalls {
  private readonly entries = new Map<number, Pending>()
  private nextId = 1

  /** Number of calls being waited on (for tests). */
  get size(): number {
    return this.entries.size
  }

  /**
   * Starts one call. Hands the id to `send` to write. With `timeoutMs`, after that time the entry is
   * removed from the table and rejected with a `timeout` Error (a response that arrives later is dropped).
   */
  start(send: (id: number) => void, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId
      this.nextId += 1
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              if (!this.entries.delete(id)) return
              reject(new Error('aios main did not answer in time'))
            }, timeoutMs)
      this.entries.set(id, { resolve, reject, timer })
      try {
        send(id)
      } catch (err) {
        this.take(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Passes in main's response. An unknown id (e.g. removed by a timeout) is dropped. */
  settle(id: number, error: string | undefined, result: unknown): void {
    const entry = this.take(id)
    if (entry === undefined) return
    if (error !== undefined) entry.reject(new Error(error))
    else entry.resolve(result)
  }

  /** The connection is gone: reject everything being waited on and empty the table. */
  failAll(message: string): void {
    const all = [...this.entries.values()]
    for (const entry of all) if (entry.timer !== null) clearTimeout(entry.timer)
    this.entries.clear()
    for (const entry of all) entry.reject(new Error(message))
  }

  private take(id: number): Pending | undefined {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    this.entries.delete(id)
    if (entry.timer !== null) clearTimeout(entry.timer)
    return entry
  }
}
