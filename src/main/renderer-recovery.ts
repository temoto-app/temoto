/**
 * Recovery when the main window's renderer process goes away (TODO 1308, ARCHITECTURE.md 12.9.2).
 *
 * `decideRecovery` is a pure function (no electron): which exit reasons reload, when to stop, what is never reloaded.
 * `attachRendererRecovery` connects it to a window. Conversations live in main, so a reload leaves them running; the renderer comes
 * back and, once its page has loaded, the thread the window was showing is opened again (TODO 1319). Unsaved viewer edits and the composer text died with the
 * renderer (there is no draft store outside it). After the limit the window shows a static failure page with "Load Again" instead of staying dead.
 * Web views, plugin-host and the index process have their own handling and are not touched here.
 */
import type { BrowserWindow, RenderProcessGoneDetails } from 'electron'
import { log } from '../common/logger.js'

/** At most this many reloads inside the window; the next crash gives up (no endless loop). */
export const RECOVERY_MAX_RELOADS = 3
export const RECOVERY_WINDOW_MS = 60_000

export type RecoveryAction = 'reload' | 'skip' | 'give-up'

export interface RecoveryInput {
  readonly reason: string
  readonly now: number
  /** Times of this window's earlier automatic reloads. */
  readonly history: readonly number[]
  /** The app is quitting or the window is closing / destroyed. */
  readonly shuttingDown: boolean
}

export interface RecoveryDecision {
  readonly action: RecoveryAction
  /** The history to keep (reload times inside the window, plus this one when reloading). */
  readonly history: readonly number[]
}

export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  const recent = input.history.filter((t) => input.now - t < RECOVERY_WINDOW_MS)
  // A clean exit is the renderer ending on purpose (window close, navigation away); never reload it.
  if (input.reason === 'clean-exit' || input.shuttingDown) return { action: 'skip', history: recent }
  if (recent.length >= RECOVERY_MAX_RELOADS) return { action: 'give-up', history: recent }
  return { action: 'reload', history: [...recent, input.now] }
}

export interface RecoveryDeps {
  /** App quitting / shutdown has begun. */
  readonly isShuttingDown: () => boolean
  readonly now?: () => number
  /** TODO 1319: the thread this window shows right now (main's own record, still intact when the renderer has just died), or null. */
  readonly threadOf?: () => string | null
  /**
   * TODO 1319: queue "open that thread" for the window's renderer to take when it starts (called right after the reload was started, so the renderer's
   * own init picks it up; a newer request for the window made in between wins, which is the caller's business). The caller re-checks that the thread
   * still exists. Called only when `threadOf` returned a thread: a second death during the reload (the view is already closed, so `threadOf` is null)
   * leaves the queued one alone. A throw is logged and ends there: it never starts another reload.
   */
  readonly reopenThread?: (threadId: string) => void
  /** Drop what `reopenThread` queued and the renderer has not taken (the limit was reached: "Load Again" must lead to a window with no thread). */
  readonly dropReopen?: () => void
  /** TODO 1319: show the failure page (reason code, "Load Again") in place of the dead renderer. */
  readonly showFailure?: (reason: string) => void
}

export interface RecoveryHandle {
  /**
   * TODO 1319: the "Load Again" button of the failure page. Loads the app page again (not `reload()`: the window is showing the failure page). It does not
   * add to the reload history, so a renderer that dies again at once meets the same limit (60 s, 3 reloads) and lands on the failure page again; only after the
   * window has passed can it get fresh automatic reloads, and each such round needs another press. No thread is reopened after it (see the note on give-up).
   */
  readonly loadAgain: () => void
}

export function attachRendererRecovery(window: BrowserWindow, deps: RecoveryDeps): RecoveryHandle {
  let history: readonly number[] = []
  const contents = window.webContents
  /** The app page's address, taken while the window still shows it (the failure page replaces it). */
  let appUrl: string | null = null
  /** The failure page is on screen: a death of the renderer now is not recovered again (no loop through the failure page itself). */
  let showingFailure = false
  /** The exit reason shown on the failure page, kept so a failed "Load Again" can put the page back. */
  let failureReason = 'unknown'

  contents.on('render-process-gone', (_event, details: RenderProcessGoneDetails) => {
    if (showingFailure) {
      log.warn('window.renderer.gone', { reason: details.reason, exitCode: details.exitCode, action: 'failure-page' })
      return
    }
    const decision = decideRecovery({
      reason: details.reason,
      now: (deps.now ?? Date.now)(),
      history,
      shuttingDown: deps.isShuttingDown() || window.isDestroyed()
    })
    history = decision.history
    log.warn('window.renderer.gone', { reason: details.reason, exitCode: details.exitCode, action: decision.action })
    if (decision.action === 'skip') return
    // Only the app page counts: if the renderer dies before a reload committed, `getURL()` is still the failure page's own `data:` address.
    let threadId: string | null = null
    try {
      const url = contents.getURL()
      if (url !== '' && !url.startsWith('data:')) appUrl = url
      threadId = decision.action === 'reload' ? (deps.threadOf?.() ?? null) : null
    } catch {
      threadId = null
    }
    if (decision.action === 'give-up') {
      // The thread is dropped here on purpose: if opening it is what kills the renderer, "Load Again" must lead to a window that stays up.
      log.error('window.renderer.reloadGaveUp', { reason: details.reason, reloads: history.length, windowMs: RECOVERY_WINDOW_MS })
      try {
        deps.dropReopen?.()
      } catch {
        // nothing queued is the same as dropped
      }
      try {
        showingFailure = true
        failureReason = details.reason
        deps.showFailure?.(details.reason)
      } catch (err) {
        showingFailure = false
        log.error('window.renderer.failurePageFailed', { message: err instanceof Error ? err.message : 'unknown' })
      }
      return
    }
    try {
      contents.reload()
      log.info('window.renderer.reloaded', { reloads: history.length })
    } catch (err) {
      log.error('window.renderer.reloadFailed', { message: err instanceof Error ? err.message : 'unknown' })
      return
    }
    if (threadId === null) return
    try {
      deps.reopenThread?.(threadId)
    } catch (err) {
      log.warn('window.renderer.reopenFailed', { message: err instanceof Error ? err.message : 'unknown' })
    }
  })

  contents.on('unresponsive', () => log.warn('window.renderer.unresponsive'))
  contents.on('responsive', () => log.info('window.renderer.responsive'))

  return {
    loadAgain: () => {
      if (!showingFailure || appUrl === null || window.isDestroyed()) return
      showingFailure = false
      log.info('window.renderer.loadAgain')
      void contents.loadURL(appUrl).catch((err: unknown) => {
        log.error('window.renderer.loadAgainFailed', { message: err instanceof Error ? err.message : 'unknown' })
        // The app page could not be loaded (dev server down, build in progress): put the failure page back so the button works again.
        if (window.isDestroyed() || showingFailure || deps.isShuttingDown()) return
        try {
          showingFailure = true
          deps.showFailure?.(failureReason)
        } catch {
          showingFailure = false
        }
      })
    }
  }
}

export interface ChildGoneDetails {
  readonly type: string
  readonly reason: string
  readonly exitCode: number
  readonly serviceName?: string
}

/** `app.on('child-process-gone')`: a GPU / utility / other child went away. Only the reason is recorded (Electron restarts GPU itself). */
export function logChildProcessGone(details: ChildGoneDetails): void {
  log.warn('process.child.gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName ?? null
  })
}
