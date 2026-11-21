/**
 * Automatic recovery from an authentication expiry (TODO 960, wave 50 bundle D; TODO 1282, wave 95 bundle A).
 *
 * When there is a thread stopped by an auth expiry, one user action (or the setting `auth.autoLogin`) opens Terminal, runs
 * the CLI's public subcommand (`auth login`; the Adapter returns the name from the compat table, constraint 6), detects completion by
 * rechecking the login state, and resends the last input that had stopped, exactly once.
 *
 * - **No key-input proxying or AppleScript** (no permission dialog is raised, TODO 167). Instead of typing `/login`,
 *   the contents of a `.command` file run `auth login` (the browser authentication is the CLI's own, the user does it in
 *   Terminal and the browser; aios never bypasses it). Credentials are not touched (constraint 2).
 * - **It is not run for API key users** (constraint 3). `openLogin` only returns `login-api-key`. **Nor for a rejected
 *   credential** (TODO 1282: `relogin: false`, e.g. an invalid API key in the environment) - `login-credential-invalid`.
 * - **One Terminal**: a `start` while waiting (`isActive`) does not reopen it, and only adds to the resend targets.
 * - **Polling** (TODO 1282 widened it to 10 minutes): every 3 seconds. Starting is not success - only a recheck that says
 *   logged in counts. A timeout goes back to the guidance (`failed` / `login-timeout`, no resend). Five checks in a row that
 *   throw end it as `login-check-failed`. The user can cancel (`cancel`); closing every window cancels too (`hasViewer`).
 *   Closing Terminal is not detected (it is treated the same as a timeout).
 * - The resend goes once, **only to waiting threads that still hold the auth-expired mark** (it is not sent to a conversation
 *   the user resent by hand), and (TODO 1282) **only when main's record of the stopped turn says it is safe**
 *   (`ExpiryInfo.hold === null`): a turn that had started running tools, or a thread whose input is no longer kept, is left
 *   with "Send again" (`held`). A thread whose automatic resend stopped on the login again is never resent automatically a
 *   second time within `AUTO_RESEND_COOLDOWN_MS` (`still-failing`), so there is no loop. The cooldown is kept in `resentAt`, not in
 *   the wait, so a cancel / timeout followed by another "Log in" does not reset it (review of TODO 1282): `start` and `recover`
 *   both look at it.
 * - **Every start covers every thread still stopped on the login** (review of TODO 1282): a cancel or a timeout drops the wait,
 *   so a later "Log in" (the bar, the badge or the notice's "Log in again") puts back the threads main still knows as expired
 *   (`expiredThreads`), each with main's own record (`describe`) and the same rules for the automatic resend.
 * - **Why a thread was not resent stays per thread** (`heldReasons`, review of TODO 1282) until its mark is cleared or it expires
 *   again, so a later `failed` (e.g. another thread's resend stopped on the login again) does not wipe it from the bar.
 * - **A limit on the automatic (`auth.autoLogin`) loop** (review of TODO 960): automatic opening happens only (a) when the
 *   recheck says logged out, (b) not for a thread that expired again within `AUTO_RESEND_COOLDOWN_MS` of an automatic resend,
 *   and (TODO 1282) (c) never for an unattended conversation (a scheduled run, a trigger before a person spoke) - guidance only.
 * - The state for the screen (`LoginRecoveryState`) is pushed with `onState` on every phase change, not on every poll.
 *
 * Independent of electron. The clock, Terminal, login check and resend are all injected, and tests do not call the real ones.
 */
import type { OpenInTerminalResult } from '@shared/ipc.js'
import {
  LOGIN_RECOVERY_IDLE,
  type LoginRecoveryFailure,
  type LoginRecoveryPhase,
  type LoginRecoveryState,
  type LoginResendHold
} from '@shared/login-recovery.js'
import { errorFields, log } from '../../common/logger.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { AUTH_AUTO_LOGIN } from '../../common/settings-keys.js'

export const LOGIN_POLL_INTERVAL_MS = 3_000
/** TODO 1282: 10 minutes (a browser sign-in with two-factor steps can take longer than the earlier 5). */
export const LOGIN_POLL_TIMEOUT_MS = 10 * 60 * 1000
/** TODO 1282: this many checks in a row that throw end the wait (`login-check-failed`). */
export const LOGIN_CHECK_FAILURE_LIMIT = 5
/** If a resent thread expires again within this time, do not open automatically and do not resend automatically again. */
export const AUTO_RESEND_COOLDOWN_MS = 10 * 60 * 1000

/** What main knew about a thread when its auth-expired mark was set (TODO 1282). */
export interface ExpiryInfo {
  /** Signing in again can fix it (false: the credential itself was rejected - no login is offered). */
  readonly relogin: boolean
  /** null = the last input may be resent automatically; otherwise why it is left for the user. */
  readonly hold: Exclude<LoginResendHold, 'still-failing'> | null
  /** An unattended conversation (a scheduled run, a trigger before a person spoke): the login is never opened automatically. */
  readonly unattended: boolean
}

/** For a thread main knows nothing about (e.g. a mark kept from before a restart): no input is kept. */
const UNKNOWN_EXPIRY: ExpiryInfo = { relogin: true, hold: 'unavailable', unattended: false }
/** The default of `noteExpired` without details (the TODO 960 behaviour). */
const PLAIN_EXPIRY: ExpiryInfo = { relogin: true, hold: null, unattended: false }

interface WaitingEntry {
  readonly relogin: boolean
  readonly hold: LoginResendHold | null
  readonly unattended: boolean
}

export interface LoginRecoveryDeps {
  /** Opens `auth login` in Terminal. If `threadId` is null it does not depend on a conversation (home). For an API key, `login-api-key`. */
  readonly openLogin: (threadId: string | null) => Promise<OpenInTerminalResult>
  /** Rechecks the login state and returns whether logged in. If it throws, it counts as a failed check (and as logged out). */
  readonly isLoggedIn: () => Promise<boolean>
  /** Whether that thread is still stopped by an auth expiry. */
  readonly stillExpired: (threadId: string) => boolean
  /** Resends the last input. */
  readonly resend: (threadId: string) => Promise<unknown>
  /** The setting `auth.autoLogin`. */
  readonly autoOpen: () => boolean
  /** TODO 1282: what main knows of a thread that is added by a button (no `noteExpired` came for it). Default: `UNKNOWN_EXPIRY`. */
  readonly describe?: (threadId: string) => ExpiryInfo | null
  /**
   * Review of TODO 1282: the threads main records as stopped on the login in this launch (its own record, never the renderer's).
   * Each `start` puts the ones not in the wait back into it. Default: none.
   */
  readonly expiredThreads?: () => Iterable<string>
  /** TODO 1282: whether any window is open. When none is, the wait is cancelled (nobody can see the result). Default: always true. */
  readonly hasViewer?: () => boolean
  /** TODO 1282: the state changed (a phase change; not every poll). Pushed to every window. */
  readonly onState?: (state: LoginRecoveryState) => void
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export class LoginRecovery {
  private readonly waiting = new Map<string, WaitingEntry>()
  /** Resent thread -> its time. Used for the limit on automatic opening and resending (`AUTO_RESEND_COOLDOWN_MS`). */
  private readonly resentAt = new Map<string, number>()
  /** Thread -> why it was left for the user. Kept across phases until the mark is cleared or the thread expires again. */
  private readonly heldReasons = new Map<string, LoginResendHold>()
  /** TODO 1286: threads stopped on a rejected credential (`relogin: false`). They are never in the wait; the button refuses them. */
  private readonly rejected = new Set<string>()
  private timer: unknown = null
  private deadline = 0
  private active = false
  private opening = false
  private checking = false
  private stopped = false
  private checkFailures = 0
  private current: LoginRecoveryState = LOGIN_RECOVERY_IDLE

  constructor(private readonly deps: LoginRecoveryDeps) {}

  /** Whether it is waiting (Terminal opened and polling). */
  isActive(): boolean {
    return this.active || this.opening
  }

  /** The state for the screen (TODO 1282). */
  state(): LoginRecoveryState {
    return this.current
  }

  /** The auth-expired mark was set. If the setting is on, it does the same thing without a button. */
  noteExpired(threadId: string, info: ExpiryInfo = PLAIN_EXPIRY): void {
    if (this.stopped) return
    if (!info.relogin) {
      // TODO 1286: a rejected credential is not fixed by signing in again, so it never joins the wait (a resend after the login came
      // back would only fail the same way once). Drop anything kept from an earlier expiry of this thread.
      log.info('login.recovery.autoSuppressed', { threadId, reason: 'credential' })
      this.waiting.delete(threadId)
      this.heldReasons.delete(threadId)
      this.rejected.add(threadId)
      if (this.isActive()) this.publishWaiting()
      return
    }
    this.rejected.delete(threadId)
    if (this.recentlyResent(threadId)) {
      // The automatic resend stopped on the login again: reopening and resending would only repeat it. Leave it to the user.
      log.info('login.recovery.autoSuppressed', { threadId, reason: 'resent-recently' })
      this.waiting.set(threadId, { ...info, hold: 'still-failing' })
      this.heldReasons.set(threadId, 'still-failing')
      if (this.isActive()) this.publishWaiting()
      else this.finish('failed', 'login-still-failing')
      return
    }
    // A new expiry: the reason kept from an earlier recovery no longer describes the stopped turn.
    this.heldReasons.delete(threadId)
    this.waiting.set(threadId, info)
    if (this.isActive()) {
      this.publishWaiting()
      return
    }
    if (!this.deps.autoOpen()) return
    if (info.unattended) {
      // Owner decision 2026-11-21: an unattended conversation gets the guidance only (nobody is there to finish a browser sign-in).
      log.info('login.recovery.autoSuppressed', { threadId, reason: 'unattended' })
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
    this.heldReasons.delete(threadId)
    this.rejected.delete(threadId)
  }

  /**
   * The entry for a thread that is put into the wait without a `noteExpired` (a button, or put back by `start`): main's record,
   * and `still-failing` while the cooldown of an automatic resend runs (review of TODO 1282: a cancel or a timeout must not reset it).
   */
  private entryFor(threadId: string): WaitingEntry {
    const base = this.deps.describe === undefined ? PLAIN_EXPIRY : (this.deps.describe(threadId) ?? UNKNOWN_EXPIRY)
    return this.recentlyResent(threadId) ? { ...base, hold: 'still-failing' } : base
  }

  /** Review of TODO 1282: puts back the threads main still records as stopped on the login (dropped by a cancel or a timeout). */
  private rejoinExpired(): void {
    for (const id of this.deps.expiredThreads?.() ?? []) {
      if (this.waiting.has(id) || !this.deps.stillExpired(id)) continue
      const entry = this.entryFor(id)
      // A rejected credential is not fixed by this login (constraint 3); it keeps its own guidance.
      if (!entry.relogin) continue
      this.waiting.set(id, entry)
    }
  }

  /** A user action. Not started more than once at the same time. */
  async start(threadId: string | null): Promise<OpenInTerminalResult> {
    if (this.stopped) return { opened: false, reason: 'terminal-open-failed' }
    if (threadId !== null) {
      if (this.rejected.has(threadId)) return { opened: false, reason: 'login-credential-invalid' }
      const known = this.waiting.get(threadId)
      const entry = known ?? this.entryFor(threadId)
      // A rejected credential is not fixed by signing in again (constraint 3: no subscription login is pushed on it).
      if (!entry.relogin) return { opened: false, reason: 'login-credential-invalid' }
      if (known === undefined) this.waiting.set(threadId, entry)
    }
    this.rejoinExpired()
    if (this.isActive()) {
      this.publishWaiting()
      return { opened: true }
    }
    this.opening = true
    let result: OpenInTerminalResult
    try {
      result = await this.deps.openLogin(threadId)
    } finally {
      this.opening = false
    }
    if (!result.opened || this.stopped) return result
    this.active = true
    this.checkFailures = 0
    this.deadline = this.now() + LOGIN_POLL_TIMEOUT_MS
    log.info('login.recovery.started', { waiting: this.waiting.size })
    this.publishWaiting()
    this.schedule()
    return result
  }

  /** TODO 1282: the user's "Cancel". Drops the wait (nothing is resent; the marks and "Send again" stay). False if not waiting. */
  cancel(): boolean {
    if (this.stopped || !this.active) return false
    log.info('login.recovery.cancelled', { waiting: this.waiting.size, by: 'user' })
    this.waiting.clear()
    this.finish('cancelled', null)
    return true
  }

  /** Shutdown: drops the timer. Nothing is pushed after this (12.9). */
  stop(): void {
    this.stopped = true
    this.clear()
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private schedule(): void {
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.timer = set(() => void this.tick(), LOGIN_POLL_INTERVAL_MS)
  }

  private clear(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer)
    this.timer = null
    this.active = false
  }

  private publish(state: Omit<LoginRecoveryState, 'changedAt'>): void {
    if (this.stopped) return
    this.current = { ...state, changedAt: this.now() }
    try {
      this.deps.onState?.(this.current)
    } catch (err) {
      log.warn('login.recovery.publishFailed', errorFields(err))
    }
  }

  private publishWaiting(): void {
    if (!this.active) return
    this.publish({
      phase: 'waiting',
      deadline: this.deadline,
      waiting: [...this.waiting].map(([threadId, entry]) => ({ threadId, resend: entry.hold === null, why: entry.hold })),
      resent: [],
      held: this.heldList(),
      failure: null
    })
  }

  /** The reasons kept per thread, for threads that still hold the mark. */
  private heldList(): { threadId: string; why: LoginResendHold }[] {
    return [...this.heldReasons]
      .filter(([threadId]) => this.deps.stillExpired(threadId))
      .map(([threadId, why]) => ({ threadId, why }))
  }

  /** Ends the wait (or reports a failure while idle) and pushes the phase. */
  private finish(phase: Exclude<LoginRecoveryPhase, 'idle' | 'waiting' | 'recovered'>, failure: LoginRecoveryFailure | null): void {
    this.clear()
    this.publish({ phase, deadline: null, waiting: [], resent: [], held: this.heldList(), failure })
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.stopped || !this.active || this.checking) return
    if (this.deps.hasViewer?.() === false) {
      // Every window was closed: nobody would see the resend or the Terminal guidance. Drop the wait (no resend).
      log.info('login.recovery.cancelled', { waiting: this.waiting.size, by: 'windows-closed' })
      this.waiting.clear()
      this.finish('cancelled', null)
      return
    }
    this.checking = true
    let loggedIn = false
    try {
      loggedIn = await this.deps.isLoggedIn()
      this.checkFailures = 0
    } catch (err) {
      this.checkFailures += 1
      log.warn('login.recovery.checkFailed', { failures: this.checkFailures, ...errorFields(err) })
    } finally {
      this.checking = false
    }
    if (this.stopped || !this.active) return
    if (loggedIn) {
      await this.recover()
      return
    }
    if (this.checkFailures >= LOGIN_CHECK_FAILURE_LIMIT) {
      log.info('login.recovery.checkGaveUp', { waiting: this.waiting.size, failures: this.checkFailures })
      this.waiting.clear()
      this.finish('failed', 'login-check-failed')
      return
    }
    if (this.now() >= this.deadline) {
      // Timeout: back to the guidance. No resend.
      log.info('login.recovery.timeout', { waiting: this.waiting.size })
      this.waiting.clear()
      this.finish('failed', 'login-timeout')
      return
    }
    this.schedule()
  }

  /** The login is back (a recheck said so). Resend once where it is safe; leave the rest with "Send again". */
  private async recover(): Promise<void> {
    const targets = [...this.waiting].filter(([id]) => this.deps.stillExpired(id))
    this.waiting.clear()
    this.clear()
    const resent: string[] = []
    let held = 0
    for (const [id, entry] of targets) {
      // The cooldown is checked here too (review of TODO 1282), whatever the entry says.
      const hold = entry.hold ?? (this.recentlyResent(id) ? 'still-failing' : null)
      if (hold !== null) {
        this.heldReasons.set(id, hold)
        held += 1
        continue
      }
      // Cleared before the await: a `still-failing` noted while the resend runs (its result stopped on the login again) must stay.
      this.heldReasons.delete(id)
      // Record first, so the limit works even if the auth expiry of the resend's result (noteExpired) arrives before the resend resolves.
      this.resentAt.set(id, this.now())
      try {
        await this.deps.resend(id)
        resent.push(id)
      } catch (err) {
        log.warn('login.recovery.resendFailed', { threadId: id, ...errorFields(err) })
        this.heldReasons.set(id, 'unavailable')
        held += 1
      }
      if (this.stopped) return
    }
    log.info('login.recovery.loggedIn', { resend: resent.length, held })
    this.publish({ phase: 'recovered', deadline: null, waiting: [], resent, held: this.heldList(), failure: null })
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
