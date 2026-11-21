/**
 * Update of the CLI itself (TODO 774, wave 36 bundle D, ARCHITECTURE.md 4.6.6). The electron-independent body
 * (`ipc.ts` connects it to ipcMain). It is a separate entry point from the auto-update of aios itself (TODO 103, `src/main/update/`, 8.5), but the idle
 * check, the BottomBar notice and the layout of the settings field are kept the same.
 *
 * Owner decisions (2026-10-12, do not change):
 * - **Automatic, with a setting to turn it off** (`agentUpdate.auto`, default ON). At startup and once a day, when no conversation is doing anything (no response in progress, no pending approval,
 *   no queued message, no background child), run the CLI's own update. Running conversations stay on the old version; conversations started afterwards use the new one.
 *   After an update, show a short notice in the BottomBar (`notice`), and in settings show "update now" and the current version.
 * - **A button to go back to the previous version.** If the check after an update (version detection, probe, 4.6) fails, offer `revertTo`. **It is never reverted automatically.**
 * - If the version moves to one not in the table, only show "unverified version" (`unverified`) in the settings field. The BottomBar shows only the "updated" notice.
 * - Does not run in a verification build (`--user-data-dir`), dev, or a fake backend (`unsupportedReason`; the reason goes only to the log).
 * - A failure goes only to a warn log and the settings field. It does not stop conversations. Even if failures continue, do not keep calling at short intervals (the lesson of TODO 751).
 */
import { log } from '../../common/logger.js'
import {
  AGENT_UPDATE_AUTO,
  AGENT_UPDATE_HELD_AT,
  AGENT_UPDATE_HELD_FROM,
  AGENT_UPDATE_LAST,
  type SettingKey
} from '../../common/settings-keys.js'
import { parseReason, reasonError, type ReasonCode, type ReasonParams } from '@shared/reason.js'
import type { AgentStatus } from '@shared/agent.js'
import type {
  AgentUpdatePhase,
  AgentUpdateRecord,
  AgentUpdateStatus,
  AgentUpdateUnsupportedReason
} from '@shared/agent-update.js'
import type { AgentSelfUpdate, AgentSelfUpdateRun } from '../session/types.js'

/** From launch to the first run (so it does not overlap the scan, index and first send right after launch). */
export const FIRST_RUN_DELAY_MS = 2 * 60_000
/** Interval between runs (once a day). Also the cap on the retry interval when failures continue. */
export const RUN_INTERVAL_MS = 24 * 60 * 60_000
/** Initial retry interval for a transient failure (network, timeout, another update in progress). Doubles each time and stops at `RUN_INTERVAL_MS`. */
export const RETRY_BASE_MS = 30 * 60_000
/** Time until a hold set after reverting is released automatically (owner decision 2026-10-12). "Update now" can release it earlier. */
export const HOLD_TTL_MS = 7 * 24 * 60 * 60_000
/**
 * TODO 787: the upper bound on how long the scheduled run waits to fire while an update (`update` / `install`) is running. Slightly longer than the update's timeout (300 seconds + the
 * grace before forced kill). Even if the completion notice never arrives, the wait is not forever.
 */
export const UPDATE_WAIT_CAP_MS = 6 * 60_000
/** Tick of the decision (checks the schedule and idleness). */
export const TICK_MS = 60_000

/**
 * Failures that do not change until the user fixes them. The retry is a fixed `RUN_INTERVAL_MS` (no doubling). Managed by a package manager,
 * stopped by an administrator, permissions, executable missing.
 */
const PERSISTENT_FAILURES: ReadonlySet<ReasonCode> = new Set([
  'agent-update-managed',
  'agent-update-disabled',
  'agent-update-permission',
  'agent-update-unavailable'
])

export interface AgentUpdateSettings {
  readTyped<T>(def: SettingKey<T>): T
  writeTyped<T>(def: SettingKey<T>, value: T): void
}

export interface AgentUpdateServiceDeps {
  readonly settings: AgentUpdateSettings
  /** Why it does not run (duplicate, dev, fake backend). null if it runs. If there is no `backend`, it becomes `no-backend-support`. */
  readonly unsupportedReason: AgentUpdateUnsupportedReason | null
  /** Entry point for updating the CLI. undefined for a backend that has none. */
  readonly backend: AgentSelfUpdate | undefined
  /**
   * What stops an automatic run (response in progress, pending approval, queued message, background child). null if none. This is 103's `restartBlocker`
   * minus what a restart merely loses (drafts, `!` results).
   */
  readonly blocker: () => string | null
  /** After raising or reverting, re-detect the feature table and distribute it to all windows (`SessionManager.agentStatus(true)`). */
  readonly redetect: () => Promise<AgentStatus>
  /**
   * TODO 943: after raising the version (after re-detection), start a probe of the new version in the background (`SessionManager.probeInBackground`),
   * so the first send does not wait for the probe (0.6 to 2.1 seconds). Not called at startup detection or after reverting (the cost reasoning of item 81).
   * Does not wait (the probe waits for the update to finish, so waiting here would deadlock). Does nothing if absent.
   */
  readonly prewarm?: () => void
  /** Whether shutdown has begun (nothing is started after that, 12.9). */
  readonly closing: () => boolean
  readonly onChanged: (status: AgentUpdateStatus) => void
  readonly now?: () => number
  readonly schedule?: (fn: () => void, ms: number) => () => void
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Why it does not run (owner decision 2026-10-12: only the everyday aios = the default userData updates). Does not run in a verification-build duplicate
 * (`--user-data-dir`), the dev server, `AIOS_DISABLE_AGENT=1`, or the environment variable of a fake backend script.
 * A fake backend is a PATH substitution, so it cannot always be recognized. Normally it is paired with a duplicate, so `instance` matches first.
 */
export function detectAgentUpdateUnsupported(input: {
  readonly defaultUserData: boolean
  readonly env: NodeJS.ProcessEnv
}): AgentUpdateUnsupportedReason | null {
  if (!input.defaultUserData) return 'instance'
  if (input.env['ELECTRON_RENDERER_URL'] !== undefined) return 'dev'
  if (input.env['AIOS_DISABLE_AGENT'] === '1') return 'agent-disabled'
  if (input.env['AIOS_FIXTURES'] !== undefined || input.env['AIOS_FAKE_LOG'] !== undefined) return 'fake-backend'
  return null
}

/** Whether the state means the check after an update failed (version not obtainable, probe failure, too old). */
export function verificationFailed(status: AgentStatus): boolean {
  if (!status.available) return true
  return status.degradations.some((d) => {
    const code = parseReason(d.code ?? null)?.code
    return code === 'agent-probe-failed' || code === 'agent-version-too-old'
  })
}

export class AgentUpdateService {
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly startedAt: number
  private readonly unsupportedReason: AgentUpdateUnsupportedReason | null
  private auto: boolean
  private phase: AgentUpdatePhase = 'idle'
  private current: string | null = null
  private unverified = false
  private checkedAt: number | null = null
  private failure: ReasonCode | null = null
  private failureParams: ReasonParams | null = null
  private failureStreak = 0
  private lastFailure: ReasonCode | null = null
  private lastUpdate: AgentUpdateRecord | null
  private heldFrom: string | null
  private heldAt: number | null
  private revertTo: string | null = null
  private notice: { from: string; to: string } | null = null
  private busy: Promise<void> | null = null
  private busySince = 0
  private cancelTick: (() => void) | null = null
  private stopped = false
  /** The last "what stopped the automatic run" written to the log (so the same reason is not written every minute). */
  private lastHold: string | null = null
  /** TODO 1143: the reason the run is due but is waiting because a conversation etc. is active (the `activityBlocker` value). null if not waiting. */
  private waiting: string | null = null

  constructor(private readonly deps: AgentUpdateServiceDeps) {
    this.now = deps.now ?? Date.now
    this.schedule = deps.schedule ?? defaultSchedule
    this.startedAt = this.now()
    this.unsupportedReason = deps.unsupportedReason ?? (deps.backend === undefined ? 'no-backend-support' : null)
    this.auto = deps.settings.readTyped(AGENT_UPDATE_AUTO)
    this.lastUpdate = deps.settings.readTyped(AGENT_UPDATE_LAST)
    this.heldFrom = deps.settings.readTyped(AGENT_UPDATE_HELD_FROM)
    this.heldAt = deps.settings.readTyped(AGENT_UPDATE_HELD_AT)
    if (this.heldFrom !== null && this.heldAt === null) {
      // A hold without a timestamp (one placed before this item): count from the time it was first read.
      this.heldAt = this.now()
      deps.settings.writeTyped(AGENT_UPDATE_HELD_AT, this.heldAt)
    }
  }

  get supported(): boolean {
    return this.unsupportedReason === null
  }

  /** Once at startup. If running is possible, start ticking (the first run is after `FIRST_RUN_DELAY_MS`, when nothing is active). */
  start(): void {
    if (!this.supported) {
      log.info('agentUpdate.unsupported', { reason: this.unsupportedReason })
      return
    }
    this.cancelTick = this.schedule(() => this.tick(), TICK_MS)
  }

  /** Shutdown. Stops ticking and starts no more runs (a running child is not waited for until its timeout; it is detected again at the next launch). */
  stop(): void {
    this.stopped = true
    this.cancelTick?.()
    this.cancelTick = null
  }

  status(): AgentUpdateStatus {
    return {
      supported: this.supported,
      unsupportedReason: this.unsupportedReason,
      auto: this.auto,
      autoBlockedByBackend: this.deps.backend?.autoBlockedByBackend() ?? false,
      heldFrom: this.heldFrom,
      heldUntil: this.heldFrom === null || this.heldAt === null ? null : this.heldAt + HOLD_TTL_MS,
      current: this.current,
      unverified: this.unverified,
      phase: this.phase,
      checkedAt: this.checkedAt,
      nextCheckAt: this.nextCheckAt(),
      waiting: this.auto && this.phase !== 'updating' ? this.waiting : null,
      failure: this.failure,
      failureParams: this.failureParams,
      lastUpdate: this.lastUpdate,
      revertTo: this.revertTo,
      notice: this.notice
    }
  }

  setAuto(next: boolean): AgentUpdateStatus {
    if (next !== this.auto) {
      this.auto = next
      this.deps.settings.writeTyped(AGENT_UPDATE_AUTO, next)
      log.info('agentUpdate.auto', { on: next })
    }
    this.emit()
    return this.status()
  }

  /** Dismisses the BottomBar "updated" notice (all windows). */
  dismissNotice(): AgentUpdateStatus {
    if (this.notice !== null) {
      this.notice = null
      this.emit()
    }
    return this.status()
  }

  /**
   * Notice of the CLI's state (startup detection, probe result, "re-detect"). Reflects the current version and the "unverified version",
   * and offers "revert to the previous version" if the check of the raised version failed.
   */
  observe(status: AgentStatus): void {
    const before = JSON.stringify([this.current, this.unverified, this.revertTo])
    this.current = status.version
    const backend = this.deps.backend
    this.unverified =
      status.available && status.version !== null && backend !== undefined && !backend.isKnownVersion(status.version)
    const last = this.lastUpdate
    if (last !== null && last.confirmed !== true && this.supported) {
      if (verificationFailed(status) && (status.version === null || status.version === last.to)) {
        if (this.revertTo !== last.from) log.warn('agentUpdate.verifyFailed', { version: last.to, revertTo: last.from })
        this.revertTo = last.from
      } else if (status.version !== null && status.version !== last.to) {
        // The version was changed or reverted by hand. The revert target no longer means anything.
        this.revertTo = null
      } else if (status.version === last.to && !status.needsProbe) {
        // The check passed (a known version, or the probe succeeded). Settled: from now on, a later unrelated detection failure (e.g. the CLI
        // vanished from PATH) does not offer "revert". The version record stays.
        this.revertTo = null
        this.lastUpdate = { ...last, confirmed: true }
        this.deps.settings.writeTyped(AGENT_UPDATE_LAST, this.lastUpdate)
      }
    }
    if (JSON.stringify([this.current, this.unverified, this.revertTo]) !== before) this.emit()
  }

  /** Tick. Checks the schedule and whether nothing is active. */
  tick(): void {
    if (this.stopped || !this.supported || this.deps.closing()) return
    this.expireHold()
    if (!this.auto || this.busy !== null) {
      this.setWaiting(null)
      return
    }
    const now = this.now()
    const due =
      this.checkedAt === null
        ? now - this.startedAt >= FIRST_RUN_DELAY_MS
        : now - this.checkedAt >= this.nextDelayMs()
    if (!due) {
      this.setWaiting(null)
      return
    }
    const hold = this.autoHold()
    if (hold !== null) {
      if (hold !== this.lastHold) log.info('agentUpdate.held', { reason: hold })
      this.lastHold = hold
      // A hold means "wait", not "skip": `checkedAt` is not advanced, so when it clears the run happens at the next tick (1 minute) (TODO 1143).
      // The reverted hold and the backend setting have their own text in the settings screen, so only a wait for conversations etc. becomes `waiting`.
      this.setWaiting(hold === 'reverted' || hold === 'backend-setting' ? null : hold)
      return
    }
    this.lastHold = null
    this.setWaiting(null)
    void this.runUpdate('auto').catch(() => undefined)
  }

  private setWaiting(next: string | null): void {
    if (next === this.waiting) return
    this.waiting = next
    this.emit()
  }

  /** Next time to check (ms). null while it does not run, auto is OFF, or on hold (reverted, backend setting). */
  private nextCheckAt(): number | null {
    if (!this.supported || !this.auto || this.heldFrom !== null || this.deps.backend?.autoBlockedByBackend() === true) {
      return null
    }
    return this.checkedAt === null ? this.startedAt + FIRST_RUN_DELAY_MS : this.checkedAt + this.nextDelayMs()
  }

  /** "Update now". Runs even if something is active (running conversations stay on the old version). Also clears the hold from reverting. */
  updateNow(): Promise<void> {
    if (!this.supported) return Promise.reject(reasonError('agent-update-unsupported'))
    if (this.busy !== null) return this.busy
    this.clearHold('manual')
    return this.runUpdate('manual')
  }

  /** "Revert to the previous version" (the user pressed it). After reverting, the automatic run is put on hold so it does not raise to the same version again. */
  revert(): Promise<void> {
    if (!this.supported) return Promise.reject(reasonError('agent-update-unsupported'))
    if (this.busy !== null) return this.busy
    const last = this.lastUpdate
    const target = this.revertTo ?? last?.from ?? null
    if (target === null) return Promise.resolve()
    return this.track(this.runRevert(target, last?.to ?? null))
  }

  /** Clears the hold ("update now", or 7 days elapsed). If it was cleared, distributes the state. */
  private clearHold(by: 'manual' | 'expired'): void {
    if (this.heldFrom === null) return
    log.info('agentUpdate.hold.cleared', { heldFrom: this.heldFrom, by })
    this.heldFrom = null
    this.heldAt = null
    this.deps.settings.writeTyped(AGENT_UPDATE_HELD_FROM, null)
    this.deps.settings.writeTyped(AGENT_UPDATE_HELD_AT, null)
    if (by === 'expired') this.emit()
  }

  /** Automatically releases a hold when 7 days have passed since the revert (resumes the automatic run). */
  private expireHold(): void {
    if (this.heldFrom !== null && this.heldAt !== null && this.now() - this.heldAt >= HOLD_TTL_MS) this.clearHold('expired')
  }

  /** What stops the automatic run. null if none. */
  private autoHold(): string | null {
    if (this.heldFrom !== null) return 'reverted'
    if (this.deps.backend?.autoBlockedByBackend() === true) return 'backend-setting'
    return this.deps.blocker()
  }

  /**
   * Interval until the next run. One day if the last one succeeded. A failure that does not change until the user fixes it is also fixed at one day. Others (network, timeout,
   * another update in progress) start at 30 minutes, double, and stop at one day. Do not keep calling every minute (`TICK_MS`) (TODO 751).
   */
  private nextDelayMs(): number {
    if (this.failureStreak === 0) return RUN_INTERVAL_MS
    if (this.lastFailure !== null && PERSISTENT_FAILURES.has(this.lastFailure)) return RUN_INTERVAL_MS
    const exponent = Math.min(this.failureStreak - 1, 10)
    return Math.min(RETRY_BASE_MS * 2 ** exponent, RUN_INTERVAL_MS)
  }

  /**
   * TODO 787: whether an update (automatic, manual, revert) is running now. The scheduled run waits to fire during this time (it does not skip).
   * After `UPDATE_WAIT_CAP_MS` it returns false, so a stuck update does not hold the schedule forever.
   */
  isUpdating(): boolean {
    return this.busy !== null && this.now() - this.busySince < UPDATE_WAIT_CAP_MS
  }

  private track(job: Promise<void>): Promise<void> {
    this.busySince = this.now()
    const tracked = job.finally(() => {
      this.busy = null
    })
    this.busy = tracked
    return tracked
  }

  private runUpdate(trigger: 'auto' | 'manual'): Promise<void> {
    return this.track(this.doUpdate(trigger))
  }

  private async doUpdate(trigger: 'auto' | 'manual'): Promise<void> {
    const backend = this.deps.backend
    if (backend === undefined) return
    this.phase = 'updating'
    this.failure = null
    this.failureParams = null
    this.emit()
    log.info('agentUpdate.start', { trigger })
    let run: AgentSelfUpdateRun
    try {
      run = await backend.update()
    } catch (err) {
      run = { outcome: 'failed', before: null, after: null, failure: failureOf(err) }
    }
    this.checkedAt = this.now()
    if (this.stopped) return
    if (run.outcome === 'failed') {
      this.recordFailure(run.failure, run.params)
      return
    }
    this.failureStreak = 0
    this.lastFailure = null
    if (run.outcome === 'unchanged') {
      this.phase = 'up-to-date'
      if (run.after !== null) this.current = run.after
      log.info('agentUpdate.upToDate', { trigger, version: run.after })
      this.emit()
      return
    }
    const from = run.before
    const to = run.after
    this.phase = 'updated'
    this.current = to
    this.notice = from === null ? null : { from, to }
    if (from !== null) {
      this.lastUpdate = { from, to, at: this.checkedAt }
      this.deps.settings.writeTyped(AGENT_UPDATE_LAST, this.lastUpdate)
    }
    this.revertTo = null
    log.info('agentUpdate.updated', { trigger, from, to })
    this.emit()
    await this.redetect()
    if (!this.stopped && !this.deps.closing()) this.deps.prewarm?.()
  }

  private async runRevert(target: string, from: string | null): Promise<void> {
    const backend = this.deps.backend
    if (backend === undefined) return
    this.phase = 'reverting'
    this.failure = null
    this.failureParams = null
    this.emit()
    log.info('agentUpdate.revert.start', { from, to: target })
    let run: AgentSelfUpdateRun
    try {
      run = await backend.install(target)
    } catch (err) {
      run = { outcome: 'failed', before: null, after: null, failure: failureOf(err) }
    }
    if (this.stopped) return
    if (run.outcome === 'failed') {
      // Reverting is a user action, so it is not counted in the retry interval of automatic runs (`failureStreak`).
      this.phase = 'failed'
      this.failure = run.failure
      this.failureParams = run.params ?? null
      log.warn('agentUpdate.revert.failed', { failure: run.failure })
      this.emit()
      return
    }
    this.phase = 'reverted'
    this.current = run.after
    this.revertTo = null
    this.notice = null
    this.lastUpdate = null
    this.deps.settings.writeTyped(AGENT_UPDATE_LAST, null)
    const held = from ?? run.before
    if (held !== null && held !== run.after) {
      this.heldFrom = held
      this.heldAt = this.now()
      this.deps.settings.writeTyped(AGENT_UPDATE_HELD_FROM, held)
      this.deps.settings.writeTyped(AGENT_UPDATE_HELD_AT, this.heldAt)
    }
    log.info('agentUpdate.reverted', { from: run.before, to: run.after, heldFrom: this.heldFrom })
    this.emit()
    await this.redetect()
  }

  private recordFailure(code: ReasonCode, params?: ReasonParams): void {
    this.failureStreak += 1
    this.lastFailure = code
    this.phase = 'failed'
    this.failure = code
    this.failureParams = params ?? null
    log.warn('agentUpdate.failed', { failure: code, streak: this.failureStreak })
    this.emit()
  }

  /** Re-detects the feature table (conversations started from now on use the new version's table). A failure does not change the update's result. */
  private async redetect(): Promise<void> {
    if (this.stopped || this.deps.closing()) return
    try {
      this.observe(await this.deps.redetect())
    } catch (err) {
      log.warn('agentUpdate.redetect.failed', { message: err instanceof Error ? err.name : 'unknown' })
    }
  }

  private emit(): void {
    if (this.deps.closing()) return
    this.deps.onChanged(this.status())
  }
}

function failureOf(err: unknown): ReasonCode {
  return parseReason(err instanceof Error ? err.message : String(err))?.code ?? 'agent-update-failed'
}
