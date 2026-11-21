/**
 * Watcher for authentication expiry (TODO 1147, wave 72 bundle D, ARCHITECTURE 4.6.7). Backend-neutral; depends on
 * neither electron nor the DB.
 *
 * - **Diagnostic bundle**: at the moment an expiry is recognized (a conversation's `interrupt-auth`, or the login state
 *   turning from true to false), makes the Adapter write one diagnostic bundle line (`recordAuthDiagnostics`). Only once
 *   during the same expiry (that is, until the retry is done).
 * - **Retry exactly once after 30 seconds** (owner decision 2026-11-06): a transient failure (a momentary keychain lock,
 *   an update race, etc.) recovers by itself. If it recovers (the recheck broadcast) the display returns. If it does not,
 *   one more bundle line is written after the retry and the rest is left to the existing guidance (the auth-expired
 *   badge, the logged-out display, 893 / 960). No automatic login.
 * - **On recovery**: when the state goes back from false to true after an expiry, one more bundle line is written
 *   (`login-restored`) (to line up the keychain item's update time with the recovery time). If it recovers while waiting
 *   for the retry, the retry is cancelled. Whether it really recovered is judged only from the result of the
 *   `auth status --json` recheck (a success on the display does not count).
 * - **The retry has four outcomes** (wave 72 review): `recovered` (saw false -> true after the expiry), `unchanged`
 *   (the recheck says true, but the login state did not change across the expiry: `interrupt-auth` while `auth status`
 *   stays true), `still-logged-out` (writes bundle `retry-failed`), and `recheck-failed` (the recheck itself did not
 *   run: a spawn failure, shutting down, etc. No bundle is written, only one log line). `unchanged` clears the expiry
 *   mark here (so a later unrelated false -> true does not write `login-restored`).
 *
 * The clock is injected (tests use fake timers). After `stop()` it does nothing (12.9).
 */
import { errorFields, log } from '../../common/logger.js'
import type { AuthDiagnosticsTrigger } from './types.js'

/** From recognizing the expiry to the retry (owner decision 2026-11-06). */
export const AUTH_RETRY_DELAY_MS = 30_000

/** The result of the retry after 30 seconds (the `result` of `agent.auth.retry` in the log). */
export type AuthRetryResult = 'recovered' | 'unchanged' | 'still-logged-out' | 'recheck-failed'

export interface AuthExpiryDeps {
  /**
   * Rechecks the login state (`auth status --json`, including the broadcast to all windows) and returns whether
   * the user is logged in. If it throws, it means "could not be checked" (`recheck-failed`), not logged out. Assumes
   * that a false -> true change has already reached `noteRestored` before this resolves.
   */
  readonly recheck: () => Promise<boolean>
  /** Writes one diagnostic bundle line. Failures are swallowed here. */
  readonly diagnose: (trigger: AuthDiagnosticsTrigger, threadId: string | null) => Promise<void>
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export class AuthExpiryWatch {
  /** The retry timer. null means nothing is being waited for. */
  private timer: unknown = null
  /** A retry is in progress (waiting for the recheck). */
  private retrying = false
  /** The expiry was recognized and the state has not yet returned to true (the mark for whether to write the bundle on recovery). */
  private expired = false
  private stopped = false

  constructor(private readonly deps: AuthExpiryDeps) {}

  /** Whether a retry is being waited for or is in progress. */
  isPending(): boolean {
    return this.timer !== null || this.retrying
  }

  /**
   * An expiry was recognized. If not already waiting, writes the bundle and schedules the 30-second retry exactly once.
   * Second and later calls while waiting or during a retry (another conversation that stopped at the same time, a
   * recheck that turned false) do nothing.
   */
  noteExpired(trigger: 'interrupt-auth' | 'login-lost', threadId: string | null = null): void {
    if (this.stopped) return
    this.expired = true
    if (this.isPending()) return
    this.record(trigger, threadId)
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.timer = set(() => void this.retry(), AUTH_RETRY_DELAY_MS)
    log.info('agent.auth.retry.scheduled', { trigger, delayMs: AUTH_RETRY_DELAY_MS })
  }

  /** The first detection after launch found the user logged out. Writes only the bundle (no retry: an expiry was not recognized). */
  noteLoggedOutAtStart(): void {
    if (this.stopped) return
    this.expired = true
    // If a conversation's auth expiry already wrote the bundle (the first broadcast after launch was that recheck), do not write it again.
    if (this.isPending()) return
    this.record('logged-out-at-start', null)
  }

  /**
   * The recheck went from false back to true (the result of `auth status --json`). After an expiry, writes the bundle
   * and cancels any waiting retry.
   */
  noteRestored(): void {
    if (this.stopped) return
    if (this.timer !== null) {
      this.clear()
      log.info('agent.auth.retry.cancelled', { reason: 'restored' })
    }
    if (!this.expired) return
    this.expired = false
    this.record('login-restored', null)
  }

  stop(): void {
    this.stopped = true
    this.clear()
  }

  private clear(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer)
    this.timer = null
  }

  private record(trigger: AuthDiagnosticsTrigger, threadId: string | null): void {
    void this.deps.diagnose(trigger, threadId).catch((err: unknown) => log.warn('agent.auth.diagnostics.failed', errorFields(err)))
  }

  private async retry(): Promise<void> {
    this.timer = null
    if (this.stopped) return
    this.retrying = true
    let loggedIn: boolean
    try {
      loggedIn = await this.deps.recheck()
    } catch (err) {
      if (this.stopped) return
      // The recheck did not run (a spawn failure, shutting down, etc.). Do not assume logged out and write a bundle.
      // Keep the expiry mark (a real false -> true will write `login-restored`).
      log.warn('agent.auth.retry', { result: 'recheck-failed' satisfies AuthRetryResult, ...errorFields(err) })
      return
    } finally {
      this.retrying = false
    }
    if (this.stopped) return
    if (loggedIn) {
      if (!this.expired) {
        // The recheck broadcast saw false -> true, and `noteRestored` wrote the bundle (`login-restored`).
        log.info('agent.auth.retry', { result: 'recovered' satisfies AuthRetryResult })
        return
      }
      // Still true (no false -> true change was seen): the login state did not change across the recognized expiry. Clear the mark here.
      this.expired = false
      log.info('agent.auth.retry', { result: 'unchanged' satisfies AuthRetryResult })
      return
    }
    log.warn('agent.auth.retry', { result: 'still-logged-out' satisfies AuthRetryResult })
    this.record('retry-failed', null)
  }
}
