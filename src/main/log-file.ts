/**
 * Location of the log file and its attachment to main (TODO 376, ARCHITECTURE.md 12.9.1).
 *
 * - Location: if `userData` is the default, `app.getPath('logs')` (on macOS `~/Library/Logs/aios/`);
 *   for a `--user-data-dir` duplicate (verification build, proxy verification), `<userData>/logs/` - not mixed with the real logs.
 *   `app.getPath('logs')` does not follow `--user-data-dir` (like `appData`, it is the OS location).
 * - Only the **primary instance** attaches it (the second one asks for a window and ends, so it neither creates nor deletes the file).
 * - Shutdown calls `closeLogFile()` after the last step of `before-quit` (the `db.close()` -> `app.quit` line).
 *   Lines after that are written synchronously, and the fd is closed in `process.on('exit')`.
 *
 * What touches electron is only the `paths` passed to `startFileLogging` (tests can pass a fake).
 */
import { join } from 'node:path'
import { LogFile } from '../common/log-file.js'
import { errorFields, log, setLogProc, setLogSink } from '../common/logger.js'

export interface LogPaths {
  /**
   * `app.getPath('logs')`. **Passed only for the default userData** (received as a value, not a function, but the caller calls
   * `app.getPath('logs')` only when `defaultUserData`). Calling it for a duplicate (`--user-data-dir`) makes
   * Electron create the real `~/Library/Logs/aios/` empty (the 25th proxy verification, 399-1).
   */
  readonly logs: string | null
  /** `app.getPath('userData')` */
  readonly userData: string
  /** Whether `userData` is the default (= the real one) (`isDefaultUserData`, item 192). */
  readonly defaultUserData: boolean
}

let current: LogFile | null = null

// Lines from main get `proc: 'main'`. Set at import time - so that it is also attached to lines before `startFileLogging`
// (`app.singleton.retry`, the second instance's lines).
setLogProc('main')

/** Decides the location (pure function). */
export function logDirectoryFor(paths: LogPaths): string {
  return paths.defaultUserData && paths.logs !== null ? paths.logs : join(paths.userData, 'logs')
}

/**
 * Starts writing main's log to a file as well. Later lines carry `proc: 'main'`.
 * If it cannot be opened (permissions, disk), continue with the terminal only - startup is not stopped for the log.
 */
export function startFileLogging(paths: LogPaths): LogFile | null {
  if (current !== null) return current
  const dir = logDirectoryFor(paths)
  try {
    const file = new LogFile({ dir })
    current = file
    setLogSink((line) => file.append(line))
    process.on('exit', () => file.dispose())
    log.info('log.file.opened', { path: file.path })
    file.pruned.then(
      (removed) => {
        if (removed > 0) log.info('log.file.pruned', { removed })
      },
      () => undefined
    )
    return file
  } catch (err) {
    setLogSink(null)
    log.warn('log.file.open.failed', { dir, ...errorFields(err) })
    return null
  }
}

/** Path of the file currently being written (Settings "Open log folder"). null if none. */
export function currentLogFilePath(): string | null {
  return current?.path ?? null
}

/** Last in the shutdown order (just before `app.quit`). Finishes writing what has piled up. */
export async function closeLogFile(): Promise<void> {
  await current?.close()
}
