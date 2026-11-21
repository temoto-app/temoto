/**
 * Opens macOS's default Terminal.app in a conversation's working folder to start an interactive CLI session (TODO 908, a new finding of wave 47).
 * Used only by "open in Terminal" on the expired-authentication badge (`AuthExpiredBar`).
 *
 * - **Only the conversation's id is accepted from the renderer.** Main decides the cwd and the CLI's name
 *   (`SessionManager.terminalTarget`; the CLI's name is returned by the Adapter from the compat table - constraint 6).
 *   The cwd is used only after `assertAllowed` (`FsAccess`; if refused, it also tries the hand-out-only gate `'handoff'`).
 *   This is not an entry point for running arbitrary commands.
 * - **It does not log in on the user's behalf** (constraints 1 to 3). It only launches the CLI, and the user types `/login`
 *   (the badge text says so). It does not touch the credentials folder.
 * - Method: write one `.command` into a temporary directory readable and writable only by the user, and pass it with `open -a Terminal <file>`.
 *   AppleScript (`do script`) is not used because it shows the Automation permission dialog. At its start the script
 *   deletes itself and the temporary directory. The shell is `-il` (a login shell, so the CLI is found on the user's `PATH`
 *   rather than the `PATH` of a GUI-launched aios). The cwd and the CLI's name are enclosed in single quotes.
 * - Other than macOS it does nothing and returns `terminal-unsupported`. **Does not throw.** It returns whether the process could be started, or the reason code (7.4.4) why not.
 */
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OpenInTerminalResult } from '@shared/ipc.js'
import type { ReasonCode } from '@shared/reason.js'
import { log, errorFields } from '../../common/logger.js'
import { hostPlatform, isMac } from '../../common/os/platform.js'
import { OS_TERMINAL_APP, OS_TERMINAL_SCRIPT_SHEBANG, OS_TOOLS } from '../../common/os/tools.js'

/** The launch target decided by main (never from the renderer). */
export interface TerminalTarget {
  readonly cwd: string
  /** The CLI's executable name (returned by the Adapter from the compat table). */
  readonly command: string
  /**
   * Arguments to pass after it (TODO 960, `auth login` for recovering from expired authentication). If present, it is run without `exec`, and the shell exits when it finishes
   * (Terminal's default "close the window on a normal exit" closes the window. No key-input proxying or AppleScript is used).
   */
  readonly args?: readonly string[]
}

export interface TerminalDeps {
  /** The gate for the working folder (`FsAccess.assertAllowed` wrapped with `withHandoffFallback`). If it throws, nothing is opened. */
  readonly assertAllowed: (uri: string, asDirectory: boolean) => string
  readonly platform?: NodeJS.Platform
  /** Where to put the temporary file. The default is `os.tmpdir()`. */
  readonly tmpRoot?: string
  /** The default is `open -a Terminal <file>`. Tests inject a fake (so the real Terminal is not launched). */
  readonly openInTerminal?: (scriptPath: string) => Promise<void>
}

/** Encloses in shell single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The contents of the `.command`. */
export function terminalScript(cwd: string, command: string, args?: readonly string[]): string {
  if (args !== undefined && args.length > 0) {
    return [
      OS_TERMINAL_SCRIPT_SHEBANG,
      '# aios: 認証切れの復旧で開いたターミナル。自分自身を消してからログインを走らせ、終わったらシェルを抜ける。',
      'rm -f -- "$0"; rmdir -- "${0:h}" 2>/dev/null',
      `cd -- ${shellQuote(cwd)} || exit 1`,
      `${[command, ...args].map(shellQuote).join(' ')}`,
      'exit $?',
      ''
    ].join('\n')
  }
  return [
    OS_TERMINAL_SCRIPT_SHEBANG,
    '# aios: 認証切れの札から開いたターミナル。自分自身を消してから CLI を起動する。',
    'rm -f -- "$0"; rmdir -- "${0:h}" 2>/dev/null',
    `cd -- ${shellQuote(cwd)} || exit 1`,
    `exec ${shellQuote(command)}`,
    ''
  ].join('\n')
}

function openWithTerminalApp(scriptPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(OS_TOOLS.open, ['-a', OS_TERMINAL_APP, scriptPath], { timeout: 5000 }, (error) => (error === null ? resolve() : reject(error)))
  })
}

/** A value that is empty or contains a newline or NUL is not put into the script. */
function isSafeText(value: string): boolean {
  return value !== '' && !/[\0\r\n]/.test(value)
}

/** The reason `SessionManager.terminalTarget` could not build a target (the text of `reason.<code>`). */
export interface TerminalRefusal {
  readonly reason: Extract<ReasonCode, 'terminal-no-cwd' | 'terminal-no-command' | 'login-api-key'>
}

const fail = (reason: ReasonCode): OpenInTerminalResult => ({ opened: false, reason })

export async function openTerminalWithCli(
  deps: TerminalDeps,
  target: TerminalTarget | TerminalRefusal | null
): Promise<OpenInTerminalResult> {
  if (!isMac(deps.platform ?? hostPlatform())) return fail('terminal-unsupported')
  if (target === null) return fail('terminal-no-cwd')
  if ('reason' in target) return fail(target.reason)
  if (!isSafeText(target.cwd)) return fail('terminal-cwd-denied')
  if (!isSafeText(target.command) || !(target.args ?? []).every(isSafeText)) return fail('terminal-no-command')
  let cwd: string
  try {
    cwd = deps.assertAllowed(pathToFileURL(target.cwd).href, true)
  } catch {
    log.debug('terminal.denied')
    return fail('terminal-cwd-denied')
  }
  if (!isSafeText(cwd)) return fail('terminal-cwd-denied')
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'aios-terminal-'))
    const script = join(dir, 'aios-cli.command')
    await writeFile(script, terminalScript(cwd, target.command, target.args), { mode: 0o700 })
    await chmod(script, 0o700)
    await (deps.openInTerminal ?? openWithTerminalApp)(script)
    return { opened: true }
  } catch (err) {
    log.warn('terminal.failed', errorFields(err))
    // If it could not be handed over, delete it ourselves (if it was handed over, the script deletes itself).
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    return fail('terminal-open-failed')
  }
}
