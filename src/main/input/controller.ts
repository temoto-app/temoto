/**
 * Decisions for switching to ASCII input in the search field (TODO 463, ARCHITECTURE 4.5.11). Depends neither
 * on electron nor on the real helper (the timer and the helper port can be replaced; `test/ascii-input.test.ts`).
 *
 * - **Collects "does the search field have focus" per window** (`report(source, focused)`, source is the
 *   webContents id). If any one has focus, switch to ASCII (send `ascii` exactly once); when all have lost
 *   it, switch back after a grace period (`ASCII_INPUT_GRACE_MS`) (`restore`). If another field (another
 *   window, including inside a viewer iframe) gets focus during the grace period, do not switch back -
 *   switching back and forth every time focus moves from field to field would flicker and lag.
 * - **Only one `ascii` per "switching period".** If the user switches to Japanese by hand inside the field,
 *   the helper notices and stops restoring (`user-changed`). main does not resend `ascii` in that time, so
 *   for the rest of that focus the input source stays what the user chose. The period starts over once focus
 *   has left all fields and the grace period has passed.
 * - The helper checks whether the source was ASCII originally (if `already-ascii`, it remembers nothing and
 *   `restore` does nothing).
 * - When the app goes to the background (`deactivate`) or ends (`dispose`), switch back immediately without
 *   waiting for the grace period - the input source is shared by all apps by default, so other apps must
 *   not be left in ASCII.
 */

import { log } from '../../common/logger.js'

/** Grace period (ms) between leaving a field and switching back. Moving from field to field (blur -> focus) fits within it. */
export const ASCII_INPUT_GRACE_MS = 100

export type AsciiInputCommand = 'ascii' | 'restore'

/** Port to the helper. Only sends, does not wait for an answer (`InputSourceHelper`). */
export interface AsciiInputPort {
  send(command: AsciiInputCommand): void
}

export interface AsciiInputControllerDeps {
  readonly helper: AsciiInputPort
  /** The setting (`input.asciiForSearch`). If false, no switching happens. */
  readonly enabled: () => boolean
  readonly graceMs?: number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export class AsciiInputController {
  /** Windows whose search field currently has focus (webContents ids). */
  private readonly focused = new Set<number>()
  /** The period after `ascii` was sent and before `restore` has been sent. */
  private switching = false
  private timer: unknown = null
  private disposed = false

  constructor(private readonly deps: AsciiInputControllerDeps) {}

  /** Search-field focus of window `source` changed. */
  report(source: number, focused: boolean): void {
    if (this.disposed) return
    if (focused) {
      this.focused.add(source)
      this.cancelTimer()
      this.begin()
      return
    }
    if (!this.focused.delete(source)) return
    if (this.focused.size === 0) this.scheduleEnd()
  }

  /** The window closed (its webContents is gone). Treated the same as focus being lost. */
  dropSource(source: number): void {
    this.report(source, false)
  }

  /** The app went to the background. Switch back without waiting for the grace period. When it returns, the renderer reports focus again. */
  deactivate(): void {
    this.focused.clear()
    this.cancelTimer()
    this.end()
  }

  /** The setting changed. Turning it off switches back at once. Turning it on switches now if a field is focused. */
  settingChanged(enabled: boolean): void {
    if (this.disposed) return
    if (!enabled) {
      this.cancelTimer()
      this.end()
      return
    }
    if (this.focused.size > 0) this.begin()
  }

  /** Shutdown. Switches back at once and ignores later reports. */
  dispose(): void {
    if (this.disposed) return
    this.deactivate()
    this.disposed = true
  }

  /** For tests: whether a switching period is active. */
  get active(): boolean {
    return this.switching
  }

  private begin(): void {
    if (this.switching) return
    if (!this.deps.enabled()) {
      // TODO 675: one reason why focusReport appears but sent does not (setting is OFF).
      log.info('input.helper.beginSkipped', { reason: 'settingOff' })
      return
    }
    this.switching = true
    this.deps.helper.send('ascii')
  }

  private end(): void {
    if (!this.switching) return
    this.switching = false
    this.deps.helper.send('restore')
  }

  private scheduleEnd(): void {
    this.cancelTimer()
    const set = this.deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
    this.timer = set(() => {
      this.timer = null
      if (this.focused.size === 0) this.end()
    }, this.deps.graceMs ?? ASCII_INPUT_GRACE_MS)
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    const clear = this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    clear(this.timer)
    this.timer = null
  }
}
