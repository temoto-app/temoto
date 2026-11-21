/**
 * Runs the prompt field's `!` (item 116, ARCHITECTURE.md 4.5.7).
 *
 * - Starts `/bin/zsh -lc <command>` **with an argument array** (the same form as `execFile`. `spawn` is used to handle
 *   `detached` and the output limit ourselves). Going through the shell is intended (the user is
 *   typing a shell statement), but aios does not build a string and hand it to another shell - the command is
 *   passed as is as a single argument.
 * - Approval is not involved (the user's own input. The same as the CLI's bash mode).
 * - cwd is the thread's working folder. If there is none, it does not run and returns `no-cwd`.
 * - A timeout uses our own timer and sends SIGKILL **to the whole process group** (`detached` creates a new group so that
 *   the children of `zsh -lc 'a | b'` do not remain).
 * - The output has control sequences (colors) removed, and what exceeds the limit loses its middle (keeping head and tail - the reason
 *   for a failure often appears at the end).
 *
 * Only SessionManager calls it. Tests either replace it with `SessionManagerDeps.runShell` or
 * call this function with a real zsh (`test/shell-input.test.ts`, no model is called).
 */
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { ShellRunPayload } from '@shared/agent.js'
import type { ShellLimits } from './types.js'
import { OS_TOOLS } from '../../common/os/tools.js'

/** The shell to run. The default login shell on macOS (owner decision of item 116). */
export const SHELL_PATH = OS_TOOLS.zsh

export interface ShellRunRequest extends ShellLimits {
  readonly command: string
  readonly cwd: string
  /** When raised, stops the running process (app quit, thread deletion). */
  readonly signal?: AbortSignal
}

/** `ShellRunPayload` without `command` (the caller adds it). */
export type ShellRunResult = Omit<ShellRunPayload, 'command'>

export type ShellRunner = (request: ShellRunRequest) => Promise<ShellRunResult>

/**
 * Upper bound on buffering the child's output. **Separate from the display and context limit (`maxOutputChars`)**; it is a net so that
 * non-stopping output such as `yes` does not eat up memory. When exceeded, it stops and cuts what was collected before output.
 */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024

/**
 * Grace period to wait for the pipe to close (`close`) after zsh ends (TODO 576, owner decision 500 ms).
 * If a background child of `x &` holds the pipe, `close` never comes, so after this it stops the whole group and returns what was collected
 * (the background child is ended - releasing it would not close the pipe either).
 */
export const EXIT_GRACE_MS = 500

export const runShellCommand: ShellRunner = async (request) => {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started
  try {
    if (!(await stat(request.cwd)).isDirectory()) return noCwd(elapsed())
  } catch {
    return noCwd(elapsed())
  }
  if (request.signal?.aborted === true) return aborted(elapsed())

  return new Promise<ShellRunResult>((resolve) => {
    const env = { ...process.env }
    // A leftover from launching in a terminal built on Electron (the "launch pitfalls" section of the guide).
    // If a child calls node / electron, it would run as plain Node.
    delete env['ELECTRON_RUN_AS_NODE']
    const out = new Collector()
    const err = new Collector()
    let timedOut = false
    let stopped = false
    let overflowed = false
    let settled = false
    /** zsh's exit code (`exit`). It arrives even if a background child holds the pipe (TODO 576). */
    let exitCode: number | null | undefined
    let grace: NodeJS.Timeout | null = null
    // As with `execFile`, pass arguments as an array (aios does not build a shell string). `detached` creates
    // a new process group, and a timeout stops the whole group.
    const child = spawn(SHELL_PATH, ['-lc', request.command], {
      cwd: request.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    // Close stdin right away so a command that waits for input (just `cat`, etc.) does not hang until the timeout.
    child.stdin.on('error', () => undefined)
    child.stdin.end()
    const killGroup = (): void => {
      // Even if zsh itself has ended, `close` does not come if a child put in the background (`x &`) holds the output pipe.
      // So we stop the whole group without watching for zsh's exit (if nobody is left, ESRCH makes it a no-op).
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already gone.
      }
    }
    const onData = (collector: Collector) => (chunk: Buffer) => {
      if (!collector.push(chunk)) {
        // Exceeded the buffering limit (non-stopping output such as `yes`). Stop and output what was collected.
        overflowed = true
        killGroup()
      }
    }
    child.stdout.on('data', onData(out))
    child.stderr.on('data', onData(err))
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, request.timeoutMs)
    const onAbort = (): void => {
      stopped = true
      killGroup()
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (result: ShellRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (grace !== null) clearTimeout(grace)
      request.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const base = (): Omit<ShellRunResult, 'status' | 'exitCode' | 'errorCode'> => {
      const stdout = clip(out.text(), request.maxOutputChars)
      const stderr = clip(err.text(), request.maxOutputChars)
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: elapsed(),
        truncated: stdout.truncated || stderr.truncated || overflowed
      }
    }
    // Could not start (`/bin/zsh` is missing, or no permission). Keep only a code (a message may contain a path).
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ ...base(), status: 'failed', exitCode: null, errorCode: error.code ?? 'UNKNOWN' })
    })
    const settle = (code: number | null): void => {
      if (timedOut) finish({ ...base(), status: 'timeout', exitCode: null, errorCode: null })
      else if (stopped) finish({ ...base(), status: 'failed', exitCode: null, errorCode: 'ABORTED' })
      else if (code === 0) finish({ ...base(), status: 'ok', exitCode: 0, errorCode: null })
      // code is null when it ended by a signal (stopped by the buffering limit, or killed from outside).
      else finish({ ...base(), status: 'exit', exitCode: code, errorCode: null })
    }
    child.on('exit', (code) => {
      exitCode = code
      if (settled) return
      // Wait a little for the pipe to close (picking up what a background child emits in the meantime). If it does not come, stop it together with
      // the background child and return what was collected (TODO 576). Before, only `close` was watched, and it did not return until the timeout.
      grace = setTimeout(() => {
        grace = null
        killGroup()
        child.stdout.destroy()
        child.stderr.destroy()
        settle(code)
      }, EXIT_GRACE_MS)
    })
    child.on('close', (code) => {
      settle(exitCode === undefined ? code : exitCode)
    })
  })
}

/** Buffers the child's output. After the limit is exceeded, later output is discarded and false is returned. */
class Collector {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  push(chunk: Buffer): boolean {
    if (this.bytes >= MAX_BUFFER_BYTES) return false
    const room = MAX_BUFFER_BYTES - this.bytes
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
    this.chunks.push(kept)
    this.bytes += kept.length
    return kept.length === chunk.length
  }
  /** Reads as UTF-8. A multibyte character split at a boundary becomes a replacement character (only when cut by the buffering limit). */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

function noCwd(durationMs: number): ShellRunResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    status: 'no-cwd',
    truncated: false,
    durationMs,
    errorCode: null
  }
}

function aborted(durationMs: number): ShellRunResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    status: 'failed',
    truncated: false,
    durationMs,
    errorCode: 'ABORTED'
  }
}

/**
 * Removes terminal control sequences (colors, cursor movement, OSC). So that output such as `ls --color` is not
 * passed as is to the model and the screen.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/**
 * What exceeds the limit loses its **middle** (head and tail are kept). `\r\n` is normalized to `\n`.
 * The marker sentence is a value shown on screen and to the model, so it has a language-independent form (numbers only).
 */
export function clip(raw: string, max: number): { text: string; truncated: boolean } {
  const text = stripAnsi(raw).replace(/\r\n/g, '\n')
  if (text.length <= max) return { text, truncated: false }
  const head = Math.ceil(max / 2)
  const tail = max - head
  // Do not cut in the middle of a surrogate pair (for the same reason as the kuromoji case, do not create broken characters).
  let headEnd = head
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1
  let tailStart = text.length - tail
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1
  const dropped = tailStart - headEnd
  return {
    text: `${text.slice(0, headEnd)}\n[… ${dropped} chars truncated …]\n${text.slice(tailStart)}`,
    truncated: true
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
