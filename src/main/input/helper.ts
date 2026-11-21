/**
 * Entry point that keeps the input-source helper running (`tools/input-source-helper/`, built into
 * `out/input-source-helper/` by `npm run build:input-source`) (TODO 463, ARCHITECTURE 4.5.11). Does not
 * depend on electron.
 *
 * - **macOS only.** Elsewhere, or when the helper is missing, it does nothing (one log line only). Search
 *   still works as usual.
 * - It is started by `warm()` (once at launch when the setting is ON). It is not started on every focus -
 *   this avoids the first typed character being Japanese during the tens of ms the launch takes (owner
 *   decision 1).
 * - Commands are one line on stdin (`ascii` / `restore`). The answer (one JSON line on stdout) is not
 *   waited for. Logs hold only reason words (input source IDs are kept only in the reply's `from` / `to`).
 *   **TODO 675 (investigating why 463 does not work on the real machine)**: log everything at info: what
 *   was sent (`input.helper.sent`), what could not be sent (`input.helper.sendSkipped`), and replies
 *   (`input.helper.reply`, debug -> info).
 * - **If it crashes:** restart it at the next `ascii` (up to `MAX_HELPER_RESTARTS` times; after that, give
 *   up for this run). The input source remembered at the time of the crash is lost and **cannot be restored**
 *   (decision at the start of the work: it is not restored at the next launch either, because restoring
 *   later with a saved ID could overwrite an input source the user chose in the meantime). `restore` is sent
 *   only to a live helper (starting a new helper that has nothing to restore is pointless).
 * - On exit, stdin is closed. On EOF the helper restores what it remembers and then exits (the same when
 *   main dies).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { log, errorFields } from '../../common/logger.js'
import { hostPlatform, isMac } from '../../common/os/platform.js'
import type { AsciiInputCommand, AsciiInputPort } from './controller.js'

/** Upper limit on restarting a crashed helper (during this run). */
export const MAX_HELPER_RESTARTS = 3

/** The part of the helper's child process that is used (a fake in tests). */
export interface HelperProcess {
  readonly stdin: {
    write(chunk: string): boolean
    end(): void
    on(event: 'error', listener: (err: Error) => void): unknown
  } | null
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface InputSourceHelperDeps {
  /** Absolute path of the helper binary (`<appPath>/out/input-source-helper/input-source-helper`). */
  readonly helperPath: string
  readonly platform?: NodeJS.Platform
  readonly exists?: (path: string) => boolean
  readonly spawn?: (path: string) => HelperProcess
}

/**
 * From one line of the helper's answer, takes only the words to keep in the log. TODO 675 (wave 84): so that
 * the real-machine log shows whether the switch really landed on ASCII and whether the TIS return value is 0,
 * it also keeps the input source IDs (`from` / `to`, names of a kind such as `com.apple.keylayout.ABC`, not
 * typed characters) and the TIS status (a number).
 */
export function summarizeReply(line: string): Record<string, string | boolean | number> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const out: Record<string, string | boolean | number> = {}
  for (const key of ['ok', 'switched', 'restored', 'ready'] as const) {
    if (typeof record[key] === 'boolean') out[key] = record[key]
  }
  for (const key of ['reason', 'error', 'event', 'from', 'to'] as const) {
    if (typeof record[key] === 'string') out[key] = record[key]
  }
  if (typeof record['status'] === 'number') out['status'] = record['status']
  return out
}

export class InputSourceHelper implements AsciiInputPort {
  private child: HelperProcess | null = null
  private restarts = 0
  private gaveUp = false
  private disposed = false
  private missingLogged = false
  private stdoutBuffer = ''

  constructor(private readonly deps: InputSourceHelperDeps) {}

  /** Whether it can be used in this environment (macOS and the helper exists). */
  available(): boolean {
    if (!isMac(this.deps.platform ?? hostPlatform())) return false
    return (this.deps.exists ?? existsSync)(this.deps.helperPath)
  }

  /**
   * TODO 675 (investigating why 463 does not work on the real machine): once at launch, log the resolved
   * path and whether it exists, at info - even when the setting is OFF (to see whether path resolution
   * itself is broken when launched from the shell).
   */
  logResolvedPath(): void {
    log.info('input.helper.resolvedPath', {
      path: this.deps.helperPath,
      platform: this.deps.platform ?? hostPlatform(),
      exists: (this.deps.exists ?? existsSync)(this.deps.helperPath)
    })
  }

  /** Start it ahead of time (at launch when the setting is ON). Does nothing if unavailable. */
  warm(): void {
    this.ensure()
  }

  send(command: AsciiInputCommand): void {
    if (this.disposed) return
    // Only a live helper holds something to restore. If there is none, do nothing.
    const child = command === 'restore' ? this.child : this.ensure()
    if (child === null || child.stdin === null) {
      // TODO 675: a log to tell apart "looked sent but was not" (no helper, or no stdin).
      // The body is not logged (only the command name and the reason).
      log.info('input.helper.sendSkipped', { command, reason: child === null ? 'noChild' : 'noStdin' })
      return
    }
    try {
      child.stdin.write(`${command}\n`)
      // TODO 675 (investigating why 463 does not work on the real machine): one info line saying ascii / restore was actually sent.
      log.info('input.helper.sent', { command })
    } catch (err) {
      log.warn('input.helper.writeFailed', errorFields(err))
    }
  }

  /** Shut down. Closing stdin makes the helper restore what it remembers and exit. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    this.child = null
    if (child === null) return
    try {
      child.stdin?.end()
    } catch {
      child.kill('SIGTERM')
    }
  }

  private ensure(): HelperProcess | null {
    if (this.child !== null) return this.child
    if (this.disposed || this.gaveUp) return null
    if (!this.available()) {
      if (!this.missingLogged) {
        this.missingLogged = true
        log.info('input.helper.unavailable', {
          platform: this.deps.platform ?? hostPlatform(),
          path: this.deps.helperPath
        })
      }
      return null
    }
    let child: HelperProcess
    try {
      child = (this.deps.spawn ?? spawnHelper)(this.deps.helperPath)
    } catch (err) {
      log.warn('input.helper.spawnFailed', errorFields(err))
      this.gaveUp = true
      return null
    }
    this.child = child
    this.stdoutBuffer = ''
    // TODO 675: the helper was started (with the restart count). Together with the reply's ready, this shows "it could start".
    log.info('input.helper.spawned', { restarts: this.restarts })
    child.stdin?.on('error', (err) => {
      // A write to a crashed helper (EPIPE). Handled by exit.
      log.debug('input.helper.stdinError', errorFields(err))
    })
    child.stdout?.on('data', (chunk) => this.onStdout(String(chunk)))
    child.on('error', (err) => {
      log.warn('input.helper.error', errorFields(err))
      this.onGone(child, null, null)
    })
    child.on('exit', (code, signal) => this.onGone(child, code, signal))
    return child
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      const summary = summarizeReply(line)
      // TODO 675: debug -> info (so we can follow whether 463 works on the real machine). Only the words that
      // summarizeReply keeps (ok / switched / restored / reason / error / event); input source IDs are not logged.
      if (summary !== null) log.info('input.helper.reply', summary)
      newline = this.stdoutBuffer.indexOf('\n')
    }
    // Discard a line that is abnormally long (the helper's answers are short).
    if (this.stdoutBuffer.length > 64 * 1024) this.stdoutBuffer = ''
  }

  private onGone(child: HelperProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    if (this.disposed) return
    this.restarts += 1
    if (this.restarts > MAX_HELPER_RESTARTS) {
      this.gaveUp = true
      log.warn('input.helper.gaveUp', { code, signal, restarts: this.restarts - 1 })
      return
    }
    // The remembered input source is lost here (cannot be restored). Restart at the next `ascii`.
    log.warn('input.helper.exited', { code, signal })
  }
}

function spawnHelper(path: string): HelperProcess {
  return nodeSpawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'] })
}
