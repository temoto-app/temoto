/**
 * The confirmation for Cmd+Q (TODO 1004). Only while a conversation is running (`SessionManager.activityBlocker()` is not null), a native
 * confirmation is shown once. There is no "do not ask again".
 *
 * Called from `before-quit`. When confirmed, it re-enters with `proceed` (= `app.quit()`) and, being `confirmed`, passes straight through.
 * A relaunch (967) and a restart for an update go through the same confirmation (`confirmForRestart`; only the wording says "restart"). "Confirmed" is kept until the window drafts
 * have been cleaned up, so the following `app.quit()` does not ask twice - it does not depend on the caller having already confirmed.
 * It does not ask during an OS logout / restart / shutdown (`systemShutdown`; it does not stop the OS from quitting).
 * Independent of electron (the confirmation and quitting are injected so it can be tested).
 */
export interface QuitConfirmDeps {
  /** `SessionManager.activityBlocker()`. If null, nothing is running. */
  readonly blocker: () => string | null
  /** The native confirmation (`quit` is Cmd+Q, `relaunch` is a restart). true if it may go on. */
  readonly ask: (kind: QuitConfirmKind) => Promise<boolean>
  /** Whether the OS is in the middle of quitting (logout / restart / shutdown). If so, do not ask - the confirmation must not stop the OS from quitting. */
  readonly systemShutdown?: () => boolean
  /** Quit after confirmation (`app.quit()`). */
  readonly proceed: () => void
  /**
   * Wave 105 review: for an idle restart for an update (`armIdleRestart`), whether nothing real is running now (`SessionManager.restartBlocker` with the
   * background-shell grace applied, which is looser than `blocker` only for background shells). If omitted the mark is never honoured.
   */
  readonly idleRestartStillOk?: () => boolean
  /** The mark was dropped at `before-quit` because something real is running by now (the normal confirmation follows). */
  readonly idleRestartLost?: () => void
}

export type QuitConfirmKind = 'quit' | 'relaunch'

export class QuitConfirm {
  private confirmed = false
  private asking = false
  /** An idle restart for an update decided this quit (wave 105 review). Dropped by `disarmIdleRestart` / `reset`; never survives an abandoned quit. */
  private idleRestart = false

  constructor(private readonly deps: QuitConfirmDeps) {}

  /** 'pass' goes straight to the quit processing. 'hold' stops `before-quit` (a confirmation is in progress, or was just shown). */
  check(): 'pass' | 'hold' {
    if (this.confirmed) return 'pass'
    if (this.deps.systemShutdown?.() === true) return 'pass'
    if (this.idleRestart) {
      // Only background shells past their grace may be ignored; a response, approval, subagent, `!` or reservation that appeared since sends it to the confirmation.
      if (this.deps.idleRestartStillOk?.() === true) return 'pass'
      this.idleRestart = false
      this.deps.idleRestartLost?.()
    }
    if (this.asking) return 'hold'
    if (this.deps.blocker() === null) return 'pass'
    this.asking = true
    void this.deps
      .ask('quit')
      .catch(() => false)
      .then((ok) => {
        this.asking = false
        if (!ok) return
        this.confirmed = true
        this.deps.proceed()
      })
    return 'hold'
  }

  /**
   * The choke point for a relaunch (967) and an update restart. If a conversation is running, ask only once, and on consent mark it "confirmed" (the following
   * `check()` of `app.quit()` passes through). If none is running, do not ask and remember nothing. If called while asking, false
   * (no overlap). If declined, false.
   */
  async confirmForRestart(): Promise<boolean> {
    if (this.confirmed) return true
    if (this.asking) return false
    if (this.deps.blocker() === null) return true
    this.asking = true
    const ok = await this.deps.ask('relaunch').catch(() => false)
    this.asking = false
    if (ok) this.confirmed = true
    return ok
  }

  /** The confirmation was done by another route. Later `before-quit` calls do not ask. */
  markConfirmed(): void {
    this.confirmed = true
  }

  /** An idle restart for an update is about to quit: skip the confirmation for that quit (see `idleRestartStillOk`). */
  armIdleRestart(): void {
    this.idleRestart = true
  }

  /** Take the mark back. Returns whether it was set. */
  disarmIdleRestart(): boolean {
    const was = this.idleRestart
    this.idleRestart = false
    return was
  }

  /** Quitting was abandoned midway (for example the draft cleanup was cancelled). The next Cmd+Q asks again. */
  reset(): void {
    this.confirmed = false
    this.idleRestart = false
  }
}
