/**
 * Runs a short child process and collects stdout / stderr / the exit code (the Adapter's public subcommands and reading `security` attributes).
 * In wave 72 review the two copies in `index.ts` and `auth-diagnostics.ts` were merged into one.
 *
 * **stdout is read even when the exit code is not 0** (spike 12: when not logged in the exit is 1, but stdout is correct JSON). execFile
 * rejects by default, so it is caught here. If it cannot start (ENOENT etc.), times out, or exceeds the limit, `code: null`. It never rejects.
 */
import { execFile } from 'node:child_process'

export interface CaptureOptions {
  readonly timeoutMs: number
  readonly maxBuffer: number
}

export interface CaptureResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

export function runCapture(command: string, args: readonly string[], options: CaptureOptions): Promise<CaptureResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: options.timeoutMs, maxBuffer: options.maxBuffer }, (err, stdout, stderr) => {
      const code =
        err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null
      resolve({
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        code
      })
    })
  })
}
