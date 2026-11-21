/**
 * State of the connection to the model (TODO 525, wave 26 bundle B). The only input for whether the BottomBar turns white-on-red is `failedAt`:
 *
 * - `failedAt`: the time of the most recent connection failure (`api_retry`) distributed by main's `ConnectionTracker`. Null on success.
 * - The OS being offline (`navigator.onLine`) is not looked at (TODO 1171).
 *
 * The decision (`connectionAlert`, `shared/connection.ts`) is on the drawing side. "Recovers in 1 minute" is checked by `useConnectionAlert`
 * redrawing once at the deadline time (no always-running clock). Initialization happens once, when the BottomBar is first drawn.
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import {
  CONNECTION_FAILURE_WINDOW_MS,
  connectionAlert,
  parseConnectionStatus,
  type ConnectionAlert
} from '@shared/connection.js'

interface ConnectionState {
  readonly failedAt: number | null
}

export const useConnection = create<ConnectionState>(() => ({ failedAt: null }))

let started = false

/** Read main's value and subscribe to change notices. Does nothing from the second call on. */
export function ensureConnection(): void {
  if (started) return
  started = true
  if (typeof window === 'undefined') return
  // With no entry point (an old preload / a test fake), nothing is turned red.
  const api = window.aios?.connection
  if (api === undefined) return
  let pushed = false
  api.onChanged((status) => {
    const parsed = parseConnectionStatus(status)
    if (parsed === null) return
    pushed = true
    useConnection.setState({ failedAt: parsed.failedAt })
  })
  void api
    .get()
    .then((status) => {
      // A push that arrived after subscribing is newer.
      const parsed = parseConnectionStatus(status)
      if (parsed !== null && !pushed) useConnection.setState({ failedAt: parsed.failedAt })
    })
    .catch(() => undefined)
}

/** For tests. */
export function resetConnectionForTest(): void {
  started = false
  useConnection.setState({ failedAt: null })
}

/** The current reason for red. One minute after the failure, redraw at that time and return to null. */
export function useConnectionAlert(): ConnectionAlert {
  const failedAt = useConnection((state) => state.failedAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (failedAt === null) return
    const left = failedAt + CONNECTION_FAILURE_WINDOW_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setNow(Date.now()), left + 50)
    return () => clearTimeout(timer)
  }, [failedAt])
  return connectionAlert(failedAt, now)
}
