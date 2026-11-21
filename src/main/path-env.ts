/**
 * Recovering `PATH` on a GUI launch.
 *
 * An app launched from Finder / Dock / Spotlight / BetterTouchTool receives its environment from launchd,
 * so `PATH` is only `/usr/bin:/bin:/usr/sbin:/sbin`.
 * Commands the user installed anywhere cannot be found, and detection of the agent CLI
 * fails with "not found". This is why it appears to work only when launched from a terminal.
 *
 * The fix has two stages:
 *   1. Ask a login shell for `$PATH` (the places the user wrote in their rc are taken as they are).
 *   2. If that fails or times out, add the standard bin directories that actually exist.
 *
 * This is backend-independent. It does not know which command is looked for (constraint 6).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { log } from '../common/logger.js'
import { GUI_LAUNCH_DEFAULT_PATH, GUI_LAUNCH_FALLBACK_BIN_DIRS } from '../common/os/macos-paths.js'
import { OS_TOOLS } from '../common/os/tools.js'

/** A login shell is dragged down by heavy rc files, so the wait is cut short. */
const SHELL_TIMEOUT_MS = 3000

function split(path: string | undefined): string[] {
  return (path ?? '').split(':').filter((entry) => entry.length > 0)
}

/** Whether `PATH` is still just launchd's default. When launched from a terminal, something has always been added. */
export function looksLikeGuiLaunch(path: string | undefined): boolean {
  const entries = split(path)
  if (entries.length === 0) return true
  return entries.every((entry) => GUI_LAUNCH_DEFAULT_PATH.includes(entry))
}

/**
 * Asks a login shell for `$PATH`.
 *
 * **`-i` (interactive) is needed.** zsh reads `.zshrc` only in an interactive shell, and
 * many people write PATH there. With only `-lc`, just what is in `.zprofile` is obtained, and
 * on a real machine the **older copy** of the same command was found first
 * (2.1.76 in `/usr/local/bin` came before 2.1.207 in `~/.local/bin`).
 * In exchange, what the rc `echo`es gets mixed in, so **only the last non-empty line** is taken.
 */
export type ShellPathReader = (shell: string) => Promise<string>

function runShell(shell: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      shell,
      [...args],
      { timeout: SHELL_TIMEOUT_MS, maxBuffer: 1024 * 64 },
      (_err, stdout) => resolve(stdout)
    )
  })
}

const PRINT_PATH = 'printf "%s" "$PATH"'

const readViaLoginShell: ShellPathReader = async (shell) => {
  const interactive = await runShell(shell, ['-ilc', PRINT_PATH])
  if (parseShellPath(interactive).length > 0) return interactive
  // Some shells dislike interactive mode, so in that case ask again with login only.
  return runShell(shell, ['-lc', PRINT_PATH])
}

/** What the rc `echo`es gets mixed in, so **only the last non-empty line** is taken. */
function parseShellPath(stdout: string): string[] {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
  const last = lines.at(-1)
  return last === undefined ? [] : split(last.trim())
}

/**
 * Widens `process.env.PATH`. The return value is the `PATH` after applying.
 *
 * Child processes inherit the environment, so fixing it once here saves both the CLI and the gateway.
 */
export async function widenPathForGuiLaunch(
  env: NodeJS.ProcessEnv = process.env,
  readShellPath: ShellPathReader = readViaLoginShell
): Promise<string> {
  const current = split(env.PATH)
  if (!looksLikeGuiLaunch(env.PATH)) return current.join(':')

  const shell = env.SHELL ?? OS_TOOLS.zsh
  const fromShell = parseShellPath(await readShellPath(shell))
  const fallback = GUI_LAUNCH_FALLBACK_BIN_DIRS.filter((dir) => existsSync(dir))

  // Put the login shell's answer first. The priority order the user intended is kept as it is.
  const merged: string[] = []
  for (const entry of [...fromShell, ...current, ...fallback]) {
    if (!merged.includes(entry)) merged.push(entry)
  }

  const path = merged.join(':')
  env.PATH = path
  log.info('path.widened', {
    shell,
    fromShell: fromShell.length,
    added: merged.length - current.length,
  })
  return path
}
