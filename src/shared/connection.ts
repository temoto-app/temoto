/**
 * State of the connection to the model (TODO 525, wave 26 bundle B). Material for deciding whether to turn the BottomBar white text on a red background.
 *
 * - **One for the whole app** (owner decision 2026-10-08): red if any thread had a connection failure within the last 1 minute
 *   (`api_retry` = a retry of an API call). It returns to normal when any turn succeeds (`result` ok).
 *   Held by main's `ConnectionTracker` (`src/main/connection.ts`) and delivered to all windows.
 * - The OS offline state (`navigator.onLine`) is not looked at (TODO 1171, owner decision 2026-11-07). Chromium's value does not check whether we can actually get out, and it
 *   gets stuck at false with VPNs, virtual interfaces and after waking from sleep. aios itself does not go out to the network (constraints 2 / 4), so whether it reached the model is judged only by the CLI's `api_retry`.
 * - Only a time is held. No body or error sentence (constraints 9 / 10).
 */
import type { AiosEvent } from './agent.js'

export interface ConnectionStatus {
  /** The time of the last connection failure received (main's clock, epoch milliseconds). Returns to null on success. */
  readonly failedAt: number | null
}

/** How long a connection failure counts as "now". If the failure is older than this, it is not shown in red. */
export const CONNECTION_FAILURE_WINDOW_MS = 60_000

/**
 * The status code of a retry for the usage limit (HTTP 429). The connection works, so it is not red: the limit is handled by the usage badge
 * (`rate_limit`) in the warning color (TODO 546-1, proxy verification run 31. The same distinction as `reasonOfRetryStatus` of the interruption kinds).
 */
const LIMIT_STATUS = 429

/** The next value of the failure time. Returning `current` means unchanged. */
export function nextConnectionFailure(current: number | null, events: readonly AiosEvent[]): number | null {
  let next = current
  for (const event of events) {
    if (event.kind === 'api_retry') {
      if (event.payload.errorStatus !== LIMIT_STATUS) next = event.ts
    }
    else if (event.kind === 'result' && event.payload.ok) next = null
  }
  return next
}

export type ConnectionAlert = 'unreachable' | null

/** The reason for BottomBar's red. Only connection failures in the last 1 minute (`api_retry`, other than 429). */
export function connectionAlert(failedAt: number | null, now: number): ConnectionAlert {
  if (failedAt !== null && now - failedAt < CONNECTION_FAILURE_WINDOW_MS) return 'unreachable'
  return null
}

/** Reads a value from outside (IPC). Null if the shape is wrong. */
export function parseConnectionStatus(value: unknown): ConnectionStatus | null {
  if (typeof value !== 'object' || value === null) return null
  const failedAt = (value as { failedAt?: unknown }).failedAt
  if (failedAt === null) return { failedAt: null }
  return typeof failedAt === 'number' && Number.isFinite(failedAt) ? { failedAt } : null
}
