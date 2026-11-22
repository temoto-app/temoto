/**
 * Recovery when the main window's renderer process goes away (TODO 1308, ARCHITECTURE.md 12.9.2).
 *
 * `decideRecovery` is a pure function (no electron): which exit reasons reload, when to stop, what is never reloaded.
 * `attachRendererRecovery` connects it to a window. Conversations live in main, so a reload leaves them running; the renderer comes
 * back with no thread open. Unsaved viewer edits and the composer text died with the renderer (there is no draft store outside it).
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
}

export function attachRendererRecovery(window: BrowserWindow, deps: RecoveryDeps): void {
  let history: readonly number[] = []
  const contents = window.webContents
  contents.on('render-process-gone', (_event, details: RenderProcessGoneDetails) => {
    const decision = decideRecovery({
      reason: details.reason,
      now: (deps.now ?? Date.now)(),
      history,
      shuttingDown: deps.isShuttingDown() || window.isDestroyed()
    })
    history = decision.history
    log.warn('window.renderer.gone', { reason: details.reason, exitCode: details.exitCode, action: decision.action })
    if (decision.action === 'give-up') {
      log.error('window.renderer.reloadGaveUp', { reason: details.reason, reloads: history.length, windowMs: RECOVERY_WINDOW_MS })
      return
    }
    if (decision.action !== 'reload') return
    try {
      contents.reload()
      log.info('window.renderer.reloaded', { reloads: history.length })
    } catch (err) {
      log.error('window.renderer.reloadFailed', { message: err instanceof Error ? err.message : 'unknown' })
    }
  })
  contents.on('unresponsive', () => log.warn('window.renderer.unresponsive'))
  contents.on('responsive', () => log.info('window.renderer.responsive'))
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
