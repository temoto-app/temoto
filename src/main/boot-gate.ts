/**
 * The launch order "window first, key later" (TODO 807, ARCHITECTURE 3.1 "launch order"). **No electron here** (testable);
 * `index.ts` holds the `BrowserWindow` side and `boot-ipc.ts` the two IPC channels.
 *
 * Why: the DB key comes from `safeStorage`, which on macOS reads the keychain item `<name> Safe Storage` **synchronously on the
 * main thread**. When the item's access list does not trust this build (another signature, an ad-hoc rebuild, an item made by an
 * earlier build), macOS asks for the login keychain password and the main thread waits for as long as the dialog is up. Before
 * TODO 807 the first window was created only after the DB was open, so a dialog that went behind other windows left the app in
 * the Dock with no window at all. Now the first window is opened and painted first; the wait for the key happens with it on screen.
 * TODO 1341 item 8: an existing key is now unsealed with the asynchronous entry point (a worker thread reads the keychain), so the
 * main thread keeps running during the dialog; the synchronous read remains for the first launch and as the fallback (ARCHITECTURE 8.2).
 *
 * The gate's phases: `starting` (the window may be up, the DB is not open, only `boot.*` IPC exists) -> `ready` (every handler is
 * registered; the renderer loads the app) or `aborted` (quit during the launch, or the launch failed). A degraded DB (TODO 1129 /
 * 1306: no key, a key that does not open it, a damaged file) is still `ready`: the app runs on memory and says so in its band.
 */

/** What a renderer receives from `wait()`. */
export type BootGateAnswer<P> = { readonly ready: true; readonly look: P } | { readonly ready: false }

export type BootPhase = 'starting' | 'ready' | 'aborted'

/** Timers, injected for tests. */
export interface BootTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: BootTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export class BootGate<P> {
  private current: BootPhase = 'starting'
  private lookOf: (() => P) | null = null
  private readonly waiters: ((answer: BootGateAnswer<P>) => void)[] = []
  private painted = false
  private readonly paintWaiters: (() => void)[] = []

  get phase(): BootPhase {
    return this.current
  }

  isReady(): boolean {
    return this.current === 'ready'
  }

  /**
   * A renderer asks whether it may load the app (IPC `boot.wait`). Answered at once after `markReady` / `abort`; before that the
   * promise is held. The look is computed when answering (a window opened later gets the values of that moment).
   */
  wait(): Promise<BootGateAnswer<P>> {
    const answered = this.answer()
    if (answered !== null) return Promise.resolve(answered)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** Every handler the renderer calls is registered. Only from `starting` (a later call, or one after `abort`, does nothing). */
  markReady(lookOf: () => P): void {
    if (this.current !== 'starting') return
    this.current = 'ready'
    this.lookOf = lookOf
    this.flush()
  }

  /**
   * The launch is abandoned (quit while starting, or `bootstrap` failed). Held renderers get `ready: false` and load nothing; the
   * app is about to quit. Does nothing after `ready`.
   */
  abort(): void {
    if (this.current !== 'starting') return
    this.current = 'aborted'
    this.flush()
    this.notePainted()
  }

  /** A window painted its first frame (the boot entry's `boot.painted`, or `ready-to-show`). */
  notePainted(): void {
    if (this.painted) return
    this.painted = true
    for (const resolve of this.paintWaiters.splice(0)) resolve()
  }

  /**
   * Waits until a window has painted, at most `timeoutMs` (a renderer that never reports must not hold the launch). `'painted'`
   * also when it had already happened.
   */
  waitForPaint(timeoutMs: number, timers: BootTimers = realTimers): Promise<'painted' | 'timeout'> {
    if (this.painted) return Promise.resolve('painted')
    return new Promise((resolve) => {
      let settled = false
      const handle = timers.setTimeout(() => {
        if (settled) return
        settled = true
        resolve('timeout')
      }, timeoutMs)
      this.paintWaiters.push(() => {
        if (settled) return
        settled = true
        timers.clearTimeout(handle)
        resolve('painted')
      })
    })
  }

  private answer(): BootGateAnswer<P> | null {
    if (this.current === 'aborted') return { ready: false }
    if (this.current === 'ready' && this.lookOf !== null) return { ready: true, look: this.lookOf() }
    return null
  }

  private flush(): void {
    for (const resolve of this.waiters.splice(0)) {
      const answered = this.answer()
      if (answered !== null) resolve(answered)
    }
  }
}

/**
 * Whether this launch opens its first window before the DB key (TODO 807). Every launch does, except the idle restart of an
 * update (TODO 103), which must stay windowless when the previous run had no window: that is decided from the DB record, so it
 * keeps the old order (key first; the key was just read by the same signer, so no dialog is expected there).
 */
export function opensWindowBeforeKey(input: { readonly updateRelaunch: boolean }): boolean {
  return !input.updateRelaunch
}

/**
 * Waits for the DB key, then opens the DB with it - unless the launch was abandoned during the wait (TODO 1341 item 8). The key is
 * unsealed off the main thread now, so a quit can come while it is pending: `before-quit` does not wait for this (the promise is not one
 * of its steps), and when the key arrives after the quit began, nothing is opened (nothing opens after `db.close()`, 12.9). `null` =
 * abandoned. A rejection of `key` or a throw of `open` passes through unchanged (the launch handles them as before). The launch hands
 * the same `abandoned` to the key loader too, so the key's own fallback stops reading the keychain once a quit began (wave 107 review Y1).
 */
export async function openAfterKey<K, D>(steps: {
  readonly key: () => Promise<K>
  readonly abandoned: () => boolean
  readonly open: (key: K) => D
}): Promise<{ readonly opened: D } | null> {
  const key = await steps.key()
  if (steps.abandoned()) return null
  return { opened: steps.open(key) }
}

/**
 * Ms after `whenReady` that a window was first on screen and that the app was ready, for the one `app.boot.timing` log line
 * (no body text, only numbers and the paint outcome).
 */
export interface BootTimingMarks {
  readonly windowFirst: boolean
  readonly paint: 'painted' | 'timeout' | null
  /** The first window was shown (null when no window came first). */
  readonly shownMs: number | null
  /** How long `openDatabase` (the key + opening + migrations) took. */
  readonly databaseMs: number
  /** Every handler registered and the renderers told to load the app. */
  readonly readyMs: number
}
