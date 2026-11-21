/**
 * Automatic recovery from an authentication expiry (TODO 960, wave 50 bundle D).
 *
 * When there is a thread stopped by an auth expiry, one user action (or the setting `auth.autoLogin`) opens Terminal, runs
 * the CLI's public subcommand (`auth login`; the Adapter returns the name from the compat table, constraint 6), detects completion by
 * rechecking the login state, and resends the last input that had stopped, exactly once.
 *
 * - **No key-input proxying or AppleScript** (no permission dialog is raised, TODO 167). Instead of typing `/login`,
 *   the contents of a `.command` file run `auth login` (the browser authentication is the CLI's own). Credentials are not touched (constraint 2).
 * - **It is not run for API key users** (constraint 3). `openLogin` only returns `login-api-key`.
 * - **One Terminal**: a `start` while waiting (`isActive`) does not reopen it, and only adds to the resend targets.
 * - **Polling**: every 3 seconds for 5 minutes. A timeout goes back to the guidance (no resend, the wait is dropped). Closing
 *   Terminal is not detected (it is treated the same as a timeout).
 * - The resend goes once, **only to waiting threads that still hold the auth-expired mark** (it is not sent to a conversation the user resent by hand).
 * - **A limit on the automatic (`auth.autoLogin`) loop** (review of TODO 960): if `auth status` stays logged in while the CLI keeps returning
 *   an auth error, open -> resend -> expire again -> open again... never stops. Automatic opening happens only (a) when the recheck says
 *   logged out, and (b) it does not open for a thread that expired again within `AUTO_RESEND_COOLDOWN_MS` of an automatic resend
 *   (the mark and badge remain: the user's "log in" works as before).
 *
 * Independent of electron. The clock, Terminal, login check and resend are all injected, and tests do not call the real ones.
 */
import type { OpenInTerminalResult } from '@shared/ipc.js'
import { errorFields, log } from '../../common/logger.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { AUTH_AUTO_LOGIN } from '../../common/settings-keys.js'

export const LOGIN_POLL_INTERVAL_MS = 3_000
export const LOGIN_POLL_TIMEOUT_MS = 5 * 60 * 1000
/** If a resent thread expires again within this time, do not open automatically (go back to the guidance). */
export const AUTO_RESEND_COOLDOWN_MS = 10 * 60 * 1000

export interface LoginRecoveryDeps {
  /** Opens `auth login` in Terminal. If `threadId` is null it does not depend on a conversation (home). For an API key, `login-api-key`. */
  readonly openLogin: (threadId: string | null) => Promise<OpenInTerminalResult>
  /** Rechecks the login state and returns whether logged in. If it throws, treated as logged out. */
  readonly isLoggedIn: () => Promise<boolean>
  /** Whether that thread is still stopped by an auth expiry. */
  readonly stillExpired: (threadId: string) => boolean
  /** Resends the last input. */
  readonly resend: (threadId: string) => Promise<unknown>
  /** The setting `auth.autoLogin`. */
  readonly autoOpen: () => boolean
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export class LoginRecovery {
  private readonly waiting = new Set<string>()
  /** Resent thread -> its time. Used for the limit on automatic opening (`AUTO_RESEND_COOLDOWN_MS`). */
  private readonly resentAt = new Map<string, number>()
  private timer: unknown = null
  private deadline = 0
  private active = false
  private opening = false
  private checking = false
  private stopped = false

  constructor(private readonly deps: LoginRecoveryDeps) {}

  /** Whether it is waiting (Terminal opened and polling). */
  isActive(): boolean {
    return this.active || this.opening
  }

  /** The auth-expired mark was set. If the setting is on, it does the same thing without a button. */
  noteExpired(threadId: string): void {
    if (this.stopped) return
    this.waiting.add(threadId)
    if (this.isActive() || !this.deps.autoOpen()) return
    if (this.recentlyResent(threadId)) {
      // The resend expired again: reopening would only repeat the same thing. Go back to the badge's guidance.
      log.info('login.recovery.autoSuppressed', { threadId, reason: 'resent-recently' })
      return
    }
    void this.autoStart(threadId).catch((err: unknown) => log.warn('login.recovery.autoFailed', errorFields(err)))
  }

  /** Rechecks before opening automatically. If already logged in, opening `auth login` cannot tell completion (it would resend immediately and expire again). */
  private async autoStart(threadId: string): Promise<void> {
    let loggedIn = false
    try {
      loggedIn = await this.deps.isLoggedIn()
    } catch (err) {
      log.warn('login.recovery.checkFailed', errorFields(err))
    }
    if (this.stopped || this.isActive()) return
    if (loggedIn) {
      log.info('login.recovery.autoSuppressed', { threadId, reason: 'logged-in' })
      return
    }
    await this.start(threadId)
  }

  private recentlyResent(threadId: string): boolean {
    const at = this.resentAt.get(threadId)
    if (at === undefined) return false
    if (this.now() - at < AUTO_RESEND_COOLDOWN_MS) return true
    this.resentAt.delete(threadId)
    return false
  }

  /** The mark was cleared (resent by hand, or returned to logged in). Remove it from the resend targets. */
  noteCleared(threadId: string): void {
    this.waiting.delete(threadId)
  }

  /** A user action. Not started more than once at the same time. */
  async start(threadId: string | null): Promise<OpenInTerminalResult> {
    if (this.stopped) return { opened: false, reason: 'terminal-open-failed' }
    if (threadId !== null) this.waiting.add(threadId)
    if (this.isActive()) return { opened: true }
    this.opening = true
    let result: OpenInTerminalResult
    try {
      result = await this.deps.openLogin(threadId)
    } finally {
      this.opening = false
    }
    if (!result.opened || this.stopped) return result
    this.active = true
    this.deadline = this.now() + LOGIN_POLL_TIMEOUT_MS
    log.info('login.recovery.started', { waiting: this.waiting.size })
    this.schedule()
    return result
  }

  stop(): void {
    this.stopped = true
    this.cancel()
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private schedule(): void {
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.timer = set(() => void this.tick(), LOGIN_POLL_INTERVAL_MS)
  }

  private cancel(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer)
    this.timer = null
    this.active = false
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.stopped || !this.active || this.checking) return
    this.checking = true
    let loggedIn = false
    try {
      loggedIn = await this.deps.isLoggedIn()
    } catch (err) {
      log.warn('login.recovery.checkFailed', errorFields(err))
    } finally {
      this.checking = false
    }
    if (this.stopped || !this.active) return
    if (loggedIn) {
      const targets = [...this.waiting].filter((id) => this.deps.stillExpired(id))
      this.waiting.clear()
      this.cancel()
      log.info('login.recovery.loggedIn', { resend: targets.length })
      for (const id of targets) {
        // Record first, so the limit works even if the auth expiry of the resend's result (noteExpired) arrives before the resend resolves.
        this.resentAt.set(id, this.now())
        try {
          await this.deps.resend(id)
        } catch (err) {
          log.warn('login.recovery.resendFailed', { threadId: id, ...errorFields(err) })
        }
      }
      return
    }
    if (this.now() >= this.deadline) {
      // Timeout: back to the guidance. No resend.
      log.info('login.recovery.timeout', { waiting: this.waiting.size })
      this.waiting.clear()
      this.cancel()
      return
    }
    this.schedule()
  }
}

/** The setting `auth.autoLogin` (TODO 960). Same type as `NotificationPreference`: default is true (TODO 1178), and its only writer is itself. */
export class AutoLoginPreference {
  private current: boolean

  constructor(private readonly settings: AppSettingsStore) {
    this.current = settings.readTyped(AUTH_AUTO_LOGIN)
  }

  get(): boolean {
    return this.current
  }

  set(enabled: boolean): boolean {
    this.current = enabled
    this.settings.writeTyped(AUTH_AUTO_LOGIN, enabled)
    return this.current
  }
}
