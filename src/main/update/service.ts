/**
 * Auto-update (TODO 103 stage 1, wave 28 bundle G, ARCHITECTURE.md 8.5). The core, independent of electron
 * (`ipc.ts` connects it to ipcMain and `app.relaunch`).
 *
 * Owner decisions (do not change):
 * - **Update without asking the user** (no "Update now?" prompt). A setting `update.auto` turns it off; the default is ON.
 * - The layout is the **real `~/Applications/Temoto.app` + directories of set-aside versions** (`layout.ts`, TODO 1050. The Dock remembers the real path, so
 *   the latest always opens). Fetching, verifying, and placing happen in the background, and **the swap (rename) happens at the next quit** (`applyAtQuit`, at the
 *   end of `before-quit`). In addition, when **idle** (no reply in progress, nothing awaiting approval, no queued messages, no running background children, and the user has not touched the machine for a while)
 *   it restarts. Windows and threads come back through the restore of item 36. **The running version's .app is never moved**: in the real-copy form, even on a restart
 *   the swap happens inside the shutdown (`applyAtQuit`), and `relaunch` is set up beforehand (`deferSwap`).
 * - No downgrades (newer versions only. `DatabaseTooNewError` is the safety net on the old version's side). The CLI is not updated (constraint 1).
 * - It does not run in a development shell, under `npm run dev`, or in a duplicate (`detectInstall` returns `unsupported`).
 */
import { log } from '../../common/logger.js'
import { UPDATE_AUTO, UPDATE_LAST_RUN_VERSION, type SettingKey } from '../../common/settings-keys.js'
import { parseReason, reasonError, type ReasonCode } from '@shared/reason.js'
import {
  isNewerVersion,
  normalizeVersion,
  type UpdatePhase,
  type UpdateStatus,
  type UpdateUnsupportedReason
} from '@shared/update.js'
import type { InstallDetection } from './layout.js'

/** From launch to the first query (so it does not overlap with the scan and indexing right after launch). */
export const FIRST_CHECK_DELAY_MS = 2 * 60_000
/** Interval between queries (every few hours, like Chrome / VS Code). Also the cap on retries when failures continue. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000
/**
 * TODO 751: the retry interval when check failures (thrown by `latestTag()`) continue. For "no `gh`" and "login required"
 * (which do not change until the user fixes them) it is a fixed `CHECK_INTERVAL_MS`; for timeouts and being offline it
 * starts here and doubles, stopping at `CHECK_INTERVAL_MS` — so `gh` is not called every minute (`TICK_MS`).
 */
export const CHECK_RETRY_BASE_MS = 15 * 60_000
/** The tick of the decision loop (it looks at the time for a query and for an idle restart). */
export const TICK_MS = 60_000
/** Seconds of "the user has not touched the machine" required for an idle restart (`powerMonitor.getSystemIdleTime()`). */
export const IDLE_RESTART_SECONDS = 10 * 60

export interface UpdateSettings {
  readTyped<T>(def: SettingKey<T>): T
  writeTyped<T>(def: SettingKey<T>, value: T): void
}

export interface UpdateServiceDeps {
  readonly settings: UpdateSettings
  /** The running version (`app.getVersion()`, the same as the badge of 316). */
  readonly currentVersion: string
  readonly detection: InstallDetection
  /** The tag of the latest Release (`v0.29.0`). A failure is an exception with a reason code. */
  readonly latestTag: () => Promise<string>
  /** Place the tagged version in a version directory (does not re-point the link). A failure is an exception with a reason code. */
  readonly stage: (tag: string, version: string) => Promise<{ readonly reused: boolean }>
  /** The version `~/Applications/Temoto.app` currently points at / is. */
  readonly linkedVersion: () => string | null
  /** The hold ceiling (`hold` in install.json: versions at or below this are not installed). Null if absent. If omitted, nothing is held. */
  readonly heldVersion?: () => string | null
  /** Swap `~/Applications/Temoto.app` to version `version` (rename). */
  readonly swapLink: (version: string) => void
  /**
   * TODO 1277: called after a swap succeeded (the new version is now at the install location). The caller re-registers the login item here. A failure is
   * logged and does not fail the update. Only meaningful in the real-copy form (`deferSwap`), where the running bundle's path is the install location.
   */
  readonly afterSwap?: (version: string) => void
  /**
   * If true (`~/Applications/Temoto.app` is the real copy and is the running version itself), do not swap before the restart — call `relaunch` first
   * and leave the swap to `applyAtQuit` inside the shutdown. If omitted, false (the symlink form does not move the running version, so it swaps first).
   */
  readonly deferSwap?: () => boolean
  /** Delete old versions (always keep `keep`). Returns the versions deleted. */
  readonly prune: (keep: readonly string[]) => readonly string[]
  /** What blocks an idle restart (SessionManager's `restartBlocker`). Null if nothing. */
  readonly restartBlocker: () => string | null
  /** Seconds since the user last touched the machine. */
  readonly systemIdleSeconds: () => number
  /** Whether shutdown has begun (nothing is started afterwards, 12.9). */
  readonly closing: () => boolean
  /** Start again on version `version` (`app.relaunch` + `app.quit`). */
  readonly relaunch: (version: string) => void
  /**
   * Confirmation before "restart and update" (TODO 606: finish writing / ask about the viewer's unsaved drafts). If false, abort — neither the re-point nor
   * the restart happens. If omitted, no confirmation.
   */
  readonly confirmRestart?: () => Promise<boolean>
  /**
   * TODO 1090: whether updating to `version` may bring up a keychain prompt on the first launch after the restart (the signer changes, is unreadable, or is ad-hoc).
   * If omitted, false. A failure (exception) falls to true.
   */
  readonly keychainPromptExpected?: (version: string) => Promise<boolean>
  /** The re-point failed after `confirmRestart` passed and no restart happened (reset the confirmation's "done"). */
  readonly restartAborted?: () => void
  readonly onChanged: (status: UpdateStatus) => void
  /**
   * TODO 1144 stage 1: the latest tag was / was not resolved (rides the extension version table on the same check, 8.5.1). If omitted, nothing happens.
   */
  readonly onReleaseChecked?: (result: { readonly tag: string } | { readonly failure: ReasonCode }) => void
  readonly now?: () => number
  /** The tick timer. Stopped with the return value. */
  readonly schedule?: (fn: () => void, ms: number) => () => void
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Turn an exception into a reason code. `fallback` if it is not a code. */
function failureOf(err: unknown, fallback: ReasonCode): ReasonCode {
  return parseReason(err instanceof Error ? err.message : String(err))?.code ?? fallback
}

export class UpdateService {
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly startedAt: number
  private readonly unsupportedReason: UpdateUnsupportedReason | null
  private auto: boolean
  private phase: UpdatePhase = 'idle'
  private latest: string | null = null
  /** The tag that `latest` was resolved from (`v0.29.0`). Used when placing from `available` via "install". */
  private latestTagName: string | null = null
  private staged: string | null = null
  private checkedAt: number | null = null
  /** TODO 751: the time a check was last **attempted** (success or failure). The retry interval after a failure is counted from here. */
  private lastAttemptAt: number | null = null
  /** The number of consecutive failures of the check (`latestTag()`). Resets to 0 on success. */
  private checkFailureStreak = 0
  /** The reason for the most recent check failure. "No `gh`" and "login required" use a fixed 6 hours; anything else retries with doubling. */
  private lastCheckFailureCode: ReasonCode | null = null
  private failure: ReasonCode | null = null
  private justUpdated: { from: string; to: string } | null = null
  private held: string | null = null
  /** TODO 1090: whether updating to `staged` may bring up a keychain prompt. */
  private keychainPrompt = false
  private busy: Promise<void> | null = null
  private cancelTick: (() => void) | null = null
  private stopped = false
  private restarting = false
  /** The last "what blocked the restart" written to the log (so the same reason is not written every minute). */
  private lastBlocker: string | null = null

  constructor(private readonly deps: UpdateServiceDeps) {
    this.now = deps.now ?? Date.now
    this.schedule = deps.schedule ?? defaultSchedule
    this.startedAt = this.now()
    this.unsupportedReason = deps.detection.kind === 'unsupported' ? deps.detection.reason : null
    this.auto = deps.settings.readTyped(UPDATE_AUTO)
  }

  /** Once at startup. Look at the previous version to decide "updated", pick up a new version already placed, and start the tick. */
  start(): void {
    const current = this.deps.currentVersion
    const previous = this.deps.settings.readTyped(UPDATE_LAST_RUN_VERSION)
    if (this.supported && previous !== null && isNewerVersion(current, previous)) {
      this.justUpdated = { from: previous, to: current }
      log.info('update.updated', { from: previous, to: current })
    }
    if (normalizeVersion(current) !== null && previous !== current) {
      this.deps.settings.writeTyped(UPDATE_LAST_RUN_VERSION, normalizeVersion(current))
    }
    if (!this.supported) {
      log.info('update.unsupported', { reason: this.unsupportedReason })
      return
    }
    this.held = this.readHeld()
    // If a version was placed at the previous launch and not yet re-pointed (crashed or force-quit), or the target someone else (install-aios.sh)
    // re-pointed to is newer than the current one, treat it as "installed".
    const linked = this.deps.linkedVersion()
    if (linked !== null && isNewerVersion(linked, current)) {
      this.staged = linked
      this.phase = 'staged'
      void this.evaluateKeychain(linked)
    }
    this.cancelTick = this.schedule(() => this.tick(), TICK_MS)
  }

  /** Shutdown. Afterwards it does not tick and does not start queries. */
  stop(): void {
    this.stopped = true
    this.cancelTick?.()
    this.cancelTick = null
  }

  get supported(): boolean {
    return this.unsupportedReason === null
  }

  status(): UpdateStatus {
    return {
      supported: this.supported,
      unsupportedReason: this.unsupportedReason,
      auto: this.auto,
      current: this.deps.currentVersion,
      latest: this.latest,
      staged: this.staged,
      phase: this.phase,
      checkedAt: this.checkedAt,
      failure: this.failure,
      held: this.held,
      justUpdated: this.justUpdated,
      keychainPromptExpected: this.staged !== null && this.keychainPrompt
    }
  }

  /** Turn auto-update ON / OFF. When turned ON, check right away if it has not been checked yet. */
  setAuto(next: boolean): UpdateStatus {
    if (next !== this.auto) {
      this.auto = next
      this.deps.settings.writeTyped(UPDATE_AUTO, next)
      log.info('update.auto', { on: next })
      if (next && this.supported && this.checkedAt === null && !this.stopped) void this.check()
    }
    this.emit()
    return this.status()
  }

  /** Dismiss the "updated to version X" notice (all windows). */
  dismissNotice(): UpdateStatus {
    if (this.justUpdated !== null) {
      this.justUpdated = null
      this.emit()
    }
    return this.status()
  }

  /**
   * Check for the latest version ("check for updates" and the periodic query). If there is a newer version and auto-update is ON (or `install`),
   * fetch and place it. If OFF it stops at `available`. If one is already running, it waits for the same job.
   */
  check(options: { readonly install?: boolean } = {}): Promise<void> {
    if (!this.supported) return Promise.reject(reasonError('update-unsupported'))
    if (this.busy !== null) return this.busy
    const job = this.runCheck(options.install === true).finally(() => {
      this.busy = null
    })
    this.busy = job
    return job
  }

  /**
   * Install the new version ("install" when auto-update is OFF). If a check is running, wait for it, and if the result is
   * `available`, go on to place it (just returning the running `busy` would silently drop `install: true`. code-review).
   */
  async install(): Promise<void> {
    if (!this.supported) throw reasonError('update-unsupported')
    if (this.busy === null) return this.check({ install: true })
    while (this.busy !== null) await this.busy.catch(() => undefined)
    if (this.stopped || this.phase !== 'available') return
    const tag = this.latestTagName
    const version = this.latest
    if (tag === null || version === null) return this.check({ install: true })
    const job = this.runStage(tag, version).finally(() => {
      this.busy = null
    })
    this.busy = job
    return job
  }

  /**
   * Restart on the installed version ("restart and update", pressed by the user). The idle condition is not checked — as with Cmd+Q, shutdown
   * stops the sessions. If no version is installed, nothing happens.
   */
  async restartNow(): Promise<void> {
    if (!this.supported || this.staged === null || this.stopped || this.restarting) return
    if (this.deps.confirmRestart !== undefined) {
      if (!(await this.deps.confirmRestart())) {
        log.info('update.restart.cancelled', { reason: 'viewer-draft' })
        return
      }
      // If it stopped during the confirmation (while the user was looking at the dialog), or was restarted some other way, do nothing.
      if (this.staged === null || this.stopped || this.restarting) {
        this.deps.restartAborted?.()
        return
      }
    }
    if (!this.restartInto(this.staged, 'manual')) this.deps.restartAborted?.()
  }

  /**
   * A restart for a reason other than an update (e.g. after the screen-recording permission of TODO 967). The caller has already confirmed the drafts.
   * If a version is installed, restart on that version through the same `restartInto` as "restart and update" and return `true`. If none is installed or
   * the swap failed, return `false` — the caller restarts on the current version (with plain `app.relaunch()`, even if `applyAtQuit`
   * re-points the symlink at quit, what launches is `process.execPath` = the old version's executable).
   */
  relaunchIntoStaged(): boolean {
    if (!this.supported || this.staged === null || this.stopped || this.restarting) return false
    return this.restartInto(this.staged, 'relaunch')
  }

  /**
   * Called at the end of shutdown (`before-quit`). If a version is installed, re-point the symlink — the next launch is on the new version.
   * A failure does not stop the quit (the next launch of the old version picks up the placed version again).
   */
  applyAtQuit(): void {
    this.stop()
    if (!this.supported || this.staged === null) return
    this.applyLink(this.staged)
  }

  /** The tick. Looks at the time for a query and for an idle restart. */
  tick(): void {
    if (this.stopped || !this.supported || this.deps.closing()) return
    const now = this.now()
    if (this.auto && this.busy === null) {
      const due =
        this.lastAttemptAt === null
          ? now - this.startedAt >= FIRST_CHECK_DELAY_MS
          : now - this.lastAttemptAt >= this.nextCheckDelayMs()
      if (due) void this.check().catch(() => undefined)
    }
    this.maybeRestart()
  }

  /**
   * TODO 751: the interval until the next check. If checks are not failing consecutively (the last one succeeded, or none was ever tried),
   * the normal interval. "No `gh`", "login required", and "Release not found" (does not exist yet / repo not visible, TODO 1213) do not change until the user fixes them, so a fixed 6 hours. Anything else
   * (timeouts, offline) starts at 15 minutes and doubles, stopping at 6 hours.
   */
  private nextCheckDelayMs(): number {
    if (this.checkFailureStreak === 0) return CHECK_INTERVAL_MS
    if (
      this.lastCheckFailureCode === 'update-gh-missing' ||
      this.lastCheckFailureCode === 'update-gh-auth' ||
      this.lastCheckFailureCode === 'update-no-release'
    ) {
      return CHECK_INTERVAL_MS
    }
    const exponent = Math.min(this.checkFailureStreak - 1, 10)
    return Math.min(CHECK_RETRY_BASE_MS * 2 ** exponent, CHECK_INTERVAL_MS)
  }

  private async runCheck(install: boolean): Promise<void> {
    this.phase = 'checking'
    this.failure = null
    this.emit()
    let tag: string
    try {
      tag = await this.deps.latestTag()
    } catch (err) {
      // TODO 751: `checkedAt` is not written here (it keeps meaning "the last successful check", the value shown on the settings screen).
      // Only `lastAttemptAt` advances, and the interval to the next tick is decided by the kind of failure (`nextCheckDelayMs`) — so `gh`
      // is not called every minute (`TICK_MS`).
      this.lastAttemptAt = this.now()
      this.checkFailureStreak += 1
      this.lastCheckFailureCode = failureOf(err, 'update-check-failed')
      this.fail('check', this.lastCheckFailureCode)
      this.deps.onReleaseChecked?.({ failure: this.lastCheckFailureCode })
      return
    }
    // `gh` answered, including the reason code = the check itself works. From now on, return to the normal interval.
    this.checkFailureStreak = 0
    this.lastCheckFailureCode = null
    if (this.stopped) return
    const latest = normalizeVersion(tag)
    this.checkedAt = this.now()
    this.lastAttemptAt = this.checkedAt
    if (latest === null) {
      this.fail('check', 'update-check-failed')
      return
    }
    this.latest = latest
    this.latestTagName = tag
    this.deps.onReleaseChecked?.({ tag })
    const current = this.deps.currentVersion
    log.info('update.check', { current, latest, staged: this.staged })
    if (!isNewerVersion(latest, current)) {
      this.phase = this.staged === null ? 'up-to-date' : 'staged'
      this.emit()
      return
    }
    // Rolled back with `--version` of install-aios.sh: versions at or below the pre-rollback one (hold) are not installed. Resume with a newer version.
    this.held = this.readHeld()
    if (this.held !== null && !isNewerVersion(latest, this.held)) {
      log.info('update.held', { latest, held: this.held })
      this.phase = this.staged === null ? 'held' : 'staged'
      this.emit()
      return
    }
    if (this.staged === latest) {
      this.phase = 'staged'
      this.emit()
      return
    }
    if (!this.auto && !install) {
      this.phase = 'available'
      this.emit()
      return
    }
    await this.runStage(tag, latest)
  }

  private async runStage(tag: string, version: string): Promise<void> {
    this.phase = 'downloading'
    this.emit()
    const started = this.now()
    let reused = false
    try {
      reused = (await this.deps.stage(tag, version)).reused
    } catch (err) {
      this.fail('stage', failureOf(err, 'update-download-failed'))
      return
    }
    if (this.stopped) return
    this.staged = version
    this.phase = 'staged'
    this.keychainPrompt = false
    log.info('update.staged', { version, reused, ms: this.now() - started })
    try {
      const linked = this.deps.linkedVersion()
      const keep = [this.deps.currentVersion, version, ...(linked === null ? [] : [linked])]
      const removed = this.deps.prune(keep)
      if (removed.length > 0) log.info('update.pruned', { versions: removed.join(',') })
    } catch (err) {
      // A cleanup failure does not stop the update itself.
      log.warn('update.prune.failed', { code: failureOf(err, 'update-install-failed') })
    }
    this.emit()
    // Publish staged first without waiting for codesign (up to 15 seconds). If the result changes, evaluateKeychain notifies by itself.
    void this.evaluateKeychain(version)
  }

  /** TODO 1090: whether the update changes the signer. If the check fails, it falls to "show". Notify if the result changes. */
  private async evaluateKeychain(version: string): Promise<void> {
    const probe = this.deps.keychainPromptExpected
    if (probe === undefined) return
    let expected: boolean
    try {
      expected = await probe(version)
    } catch {
      expected = true
    }
    if (this.stopped || this.staged !== version || expected === this.keychainPrompt) return
    this.keychainPrompt = expected
    log.info('update.keychain', { version, expected })
    this.emit()
  }

  /** The version whose re-point failed in an idle restart (TODO 1133). Not retried for the same version during this launch. */
  private idleRestartFailed: string | null = null

  /** If idle, re-point and restart. */
  private maybeRestart(): void {
    if (!this.auto || this.staged === null || this.busy !== null || this.restarting) return
    // TODO 1133: for a version whose re-point failed, do not try an idle restart during this launch (do not repeat the failure and the notice every 60 seconds). It is still left to `applyAtQuit` at quit.
    if (this.idleRestartFailed === this.staged) return
    const idle = this.deps.systemIdleSeconds()
    if (idle < IDLE_RESTART_SECONDS) return
    const blocker = this.deps.restartBlocker()
    if (blocker !== null) {
      if (blocker !== this.lastBlocker) log.info('update.restart.held', { reason: blocker })
      this.lastBlocker = blocker
      return
    }
    this.lastBlocker = null
    if (!this.restartInto(this.staged, 'idle', idle)) this.idleRestartFailed = this.staged
  }

  /**
   * Swap and restart. If the swap fails, false (no restart). In the real-copy form (`deferSwap`), so as not to move the running version's .app,
   * the swap is left to the shutdown (`applyAtQuit`) and only the restart is set up here.
   */
  private restartInto(version: string, trigger: 'idle' | 'manual' | 'relaunch', idleSeconds?: number): boolean {
    if (this.deps.deferSwap?.() !== true && !this.applyLink(version)) return false
    this.restarting = true
    log.info('update.restart', { version, trigger, idleSeconds })
    this.stop()
    this.deps.relaunch(version)
    return true
  }

  /** Swap. If `version` or newer is already installed, do nothing (do not overwrite what was rolled back or reinstalled by hand). */
  private applyLink(version: string): boolean {
    try {
      const linked = this.deps.linkedVersion()
      if (linked !== null && !isNewerVersion(version, linked)) return linked === version
      this.deps.swapLink(version)
      log.info('update.applied', { from: linked, to: version })
    } catch (err) {
      this.fail('apply', failureOf(err, 'update-install-failed'))
      return false
    }
    try {
      this.deps.afterSwap?.(version)
    } catch (err) {
      log.warn('update.afterSwapFailed', { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  private readHeld(): string | null {
    try {
      return normalizeVersion(this.deps.heldVersion?.() ?? '')
    } catch {
      return null
    }
  }

  private fail(step: 'check' | 'stage' | 'apply', code: ReasonCode): void {
    this.phase = 'failed'
    this.failure = code
    log.warn('update.failed', { step, code })
    this.emit()
  }

  private emit(): void {
    if (this.deps.closing()) return
    this.deps.onChanged(this.status())
  }
}
