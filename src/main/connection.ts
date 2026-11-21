/**
 * Aggregation of the state of the connection to the model (TODO 525, wave 26 bundle B). The same shape as `UsageTracker` (item 317);
 * it only watches the batches of SessionManager's `onEvents` (SessionManager does not know the connection state).
 *
 * - One for the whole app. An `api_retry` from any thread advances the failure time, and a successful `result` from any thread resets it.
 * - **Not persisted** (after a restart it does not start red - the previous failure does not represent the current connection).
 * - On change, `onChanged` (a push to all windows). Independent of electron (`connection-ipc.ts` connects it to ipcMain).
 * - "Recovers after 1 minute" is decided by the renderer with a clock (main holds no timer).
 */
import type { AiosEventBatch } from '@shared/agent.js'
import { nextConnectionFailure, type ConnectionStatus } from '@shared/connection.js'

export class ConnectionTracker {
  private failedAt: number | null = null

  constructor(private readonly onChanged: (status: ConnectionStatus) => void = () => undefined) {}

  get(): ConnectionStatus {
    return { failedAt: this.failedAt }
  }

  observe(batch: AiosEventBatch): void {
    const next = nextConnectionFailure(this.failedAt, batch.events)
    if (next === this.failedAt) return
    this.failedAt = next
    this.onChanged(this.get())
  }
}
