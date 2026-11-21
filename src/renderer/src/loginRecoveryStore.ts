/**
 * The login recovery as main reports it (TODO 1282, ARCHITECTURE 4.6.7). main holds the only copy; this store only mirrors it
 * (`agent.loginRecovery()` once, then the `onLoginRecovery` push on every phase change).
 *
 * When a recovery ends in `failed`, the common error notice (TODO 1281) is raised once per change with the reason code
 * (`login-timeout` / `login-check-failed` / `login-still-failing`): state, cause and next step come from the dictionaries.
 * Initialization happens once, from `App` (and the expired-login bar, in case it is drawn first).
 */
import { create } from 'zustand'
import { formatReason } from '@shared/reason.js'
import { LOGIN_RECOVERY_IDLE, type LoginRecoveryState } from '@shared/login-recovery.js'
import { useThreads } from './threadStore.js'

interface LoginRecoveryStore {
  readonly state: LoginRecoveryState
}

export const useLoginRecovery = create<LoginRecoveryStore>(() => ({ state: LOGIN_RECOVERY_IDLE }))

let started = false

/** The minutes the wait lasted, for the timeout's sentence. */
function minutesOf(state: LoginRecoveryState, startedAt: number | null): number {
  if (startedAt === null) return 10
  return Math.max(1, Math.round((state.changedAt - startedAt) / 60_000))
}

let waitingSince: number | null = null

function apply(next: LoginRecoveryState): void {
  const before = useLoginRecovery.getState().state
  if (next.changedAt < before.changedAt) return
  if (next.phase === 'waiting' && before.phase !== 'waiting') waitingSince = next.changedAt
  useLoginRecovery.setState({ state: next })
  // Raise the notice once per change (a re-fetch of the same state does not raise it again).
  if (next.phase === 'failed' && next.failure !== null && next.changedAt !== before.changedAt) {
    const params = next.failure === 'login-timeout' ? { minutes: minutesOf(next, waitingSince) } : undefined
    useThreads.setState({ error: formatReason(next.failure, params) })
  }
  if (next.phase !== 'waiting') waitingSince = null
}

/** Read main's value and subscribe to changes. Does nothing from the second call on. */
export function ensureLoginRecovery(): void {
  if (started) return
  started = true
  if (typeof window === 'undefined') return
  // With no entry point (an old preload / a test fake), nothing is shown.
  const api = window.aios?.agent
  if (api?.onLoginRecovery === undefined || api.loginRecovery === undefined) return
  api.onLoginRecovery((next) => apply(next))
  void api
    .loginRecovery()
    .then((state) => {
      // Do not raise a notice for a failure that happened before this window opened.
      const before = useLoginRecovery.getState().state
      if (state.changedAt > before.changedAt) useLoginRecovery.setState({ state })
      if (state.phase === 'waiting') waitingSince = state.changedAt
    })
    .catch(() => undefined)
}

/** For tests. */
export function resetLoginRecoveryForTest(): void {
  started = false
  waitingSince = null
  useLoginRecovery.setState({ state: LOGIN_RECOVERY_IDLE })
}
