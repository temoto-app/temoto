/**
 * The latest usage-limit values (item 317, wave 17 bundle B).
 *
 * **The source is a single place in main** (`UsageTracker`, one for the whole app per account). At startup it fetches the previous
 * record with `usage.get()`, and afterwards replaces it with pushes to all windows (`usage.onChanged`).
 * Other bundles also touch `store.ts`, so this is kept self-contained here. Initialization happens once, when the first display component
 * (`UsageBadge` / `UsageSection`) is rendered (`ensureUsage`).
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { UsageSnapshot } from '@shared/usage.js'

interface UsageState {
  readonly snapshot: UsageSnapshot | null
}

export const useUsage = create<UsageState>(() => ({ snapshot: null }))

let started = false

/** Reads the previous record and subscribes to change notifications. Does nothing from the second call on. */
export function ensureUsage(): void {
  if (started) return
  started = true
  // If the entry point is missing (an old preload / a test fake), show nothing.
  const api = typeof window === 'undefined' ? undefined : window.aios?.usage
  if (api === undefined) return
  api.onChanged((snapshot) => useUsage.setState({ snapshot }))
  void api
    .get()
    .then((snapshot) => {
      // A push that arrived after subscribing is newer. Put the record in only while there is nothing yet.
      if (snapshot !== null && useUsage.getState().snapshot === null) useUsage.setState({ snapshot })
    })
    .catch(() => undefined)
}

export function resetUsageForTest(): void {
  started = false
  useUsage.setState({ snapshot: null })
}

/** The current time that drives relative displays ("n minutes ago", "Resets in 1h"). Redraws every `intervalMs`. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
