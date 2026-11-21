/**
 * How the shutdown of `before-quit` is arranged (TODO 566, 12.9). Only the parts independent of electron are here, and
 * `src/main/index.ts` passes the steps (tests are in `test/shutdown.test.ts`).
 *
 * - **Each step is caught individually and the next one goes on.** Previously, when one `stop()` rejected, the
 *   IIFE became an unhandled rejection, and `quitting` stayed set without reaching `db.close()` or `app.quit()`,
 *   so the next Cmd+Q also passed through and the app could not quit.
 * - `quit` is **always** called (finally).
 * - An overall limit (owner decision, 30 seconds). When exceeded it falls back to `onTimeout` (index.ts does `app.exit(1)`).
 *   After the limit is hit, `quit` is not called (it has already finished).
 */
import { log, errorFields } from '../common/logger.js'

/** The overall limit of shutdown (TODO 566, owner decision). */
export const SHUTDOWN_TIMEOUT_MS = 30_000

export interface ShutdownStep {
  /** The name kept in the log (such as `sessions.stop`). */
  readonly name: string
  readonly run: () => unknown
}

export interface ShutdownOptions {
  readonly quit: () => void
  readonly onTimeout: () => void
  readonly timeoutMs?: number
}

/** Run the steps in order. Even if one throws (rejects), the rest are not skipped. */
export async function runShutdownSteps(steps: readonly ShutdownStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await step.run()
    } catch (err) {
      log.error('app.quit.step-failed', { step: step.name, ...errorFields(err) })
    }
  }
}

/** Run the steps with a limit, and always call `quit` at the end. */
export async function shutdownWithin(steps: readonly ShutdownStep[], options: ShutdownOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    log.error('app.quit.timeout', { ms: timeoutMs })
    options.onTimeout()
  }, timeoutMs)
  try {
    await runShutdownSteps(steps)
  } finally {
    clearTimeout(timer)
    if (!timedOut) options.quit()
  }
}
