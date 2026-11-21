/**
 * How to find and fetch a new version (TODO 103 stage 1, ARCHITECTURE.md 8.5).
 *
 * Distributed versions are in the GitHub Releases of the public repo (TODO 492 / 1185, ARCHITECTURE 8.4). As with install-aios.sh, they are
 * **fetched with the user's `gh` (the GitHub CLI)** — aios does not read, hold, or pass a GitHub token (gh fetches with its own
 * login). The only place that reaches the network is this entry point in main, separate from the plugin Broker's network (plugins do not go through it).
 *
 * gh's output (stderr) is not written to the log — it may contain URLs or account names. Only exit codes and reason codes.
 */
import { execFile } from 'node:child_process'
import { reasonError } from '@shared/reason.js'

export interface CommandResult {
  readonly code: number
  /** Cut off by timeout (`killed` of `execFile`. A kill for exceeding the output limit is not included). */
  readonly timedOut?: boolean
  readonly stdout: string
  readonly stderr: string
}

/**
 * The entry point that runs one child process (replaced in tests). If the command does not exist, an `ENOENT` exception;
 * a non-zero exit code is not an exception but is returned in `code`.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { readonly timeoutMs?: number; readonly cwd?: string }
) => Promise<CommandResult>

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: options.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024, cwd: options.cwd, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err !== null) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(err)
            return
          }
          resolve(execFailureResult(err, String(stdout), String(stderr)))
          return
        }
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

/** The part of the failure Node's `execFile` passes that is looked at here. */
interface ExecFailure {
  readonly code?: unknown
  readonly killed?: boolean
}

/** The failure code of `execFile` when the output exceeds `maxBuffer` (the child is killed in this case too). */
const MAXBUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

/**
 * Turn an `execFile` failure (other than ENOENT) into a `CommandResult`. 1 if the exit code is not a number.
 * A timeout is detected by "`execFile` killed it itself" (`killed`), but a kill for exceeding the output limit is not counted as a timeout
 * (code-review of TODO 1213. On Node 22 `killed` is not set for an output-limit failure, but it is excluded by the code too so that it does not depend on the version).
 */
export function execFailureResult(err: ExecFailure, stdout: string, stderr: string): CommandResult {
  const timedOut = err.killed === true && err.code !== MAXBUFFER_CODE
  return {
    code: typeof err.code === 'number' ? err.code : 1,
    stdout,
    stderr,
    ...(timedOut ? { timedOut } : {})
  }
}

export interface ReleaseSource {
  /** The tag of the latest Release (`v0.29.0`). gh excludes drafts and prereleases. A failure is an exception with a reason code. */
  latestTag(): Promise<string>
  /** Fetch the `names` of the assets of tag `tag` into `dir`. A failure is an exception with a reason code. */
  download(tag: string, names: readonly string[], dir: string): Promise<void>
}

/** Upper bound for a query. */
const VIEW_TIMEOUT_MS = 60_000
/** Upper bound for a download (the zip is around 150 MB). */
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000
/** gh's exit code for "login required" (`cmdutil.ExitAuth` in gh). */
const GH_EXIT_AUTH = 4

/**
 * Turn a gh failure into a reason code (TODO 1213). Failures that looked like network problems are separated into forms the person who can fix them can act on.
 * Applied in order from the top: timeout -> login required -> rate limit -> auth wording -> Release not found -> network -> default (`fallback`).
 * stderr is only classified here and written nowhere.
 *
 * - `release not found` appears both for "the Release does not exist yet" and for "the repo is not visible (wrong login, not invited, or a wrong repo name)"
 *   (measured with gh 2.96.0. gh does not give a 404 wording even for an invisible repo). They cannot be told apart from stderr, so
 *   there is a single reason code `update-no-release`, and its wording mentions both possibilities and `gh auth status`.
 * - Timeout and `release not found` are reason codes phrased for the check (`release view`). For downloading (`release download`, where `fallback` is
 *   `update-download-failed`) they stay `fallback` — so that a download timeout is not called "the check timed out", and a failure to download a tag the check could see
 *   is not called "no version yet". Login, rate limit, and network are phrased the same for the check and the download and read correctly either way.
 */
export function ghFailure(
  result: CommandResult,
  fallback: 'update-check-failed' | 'update-download-failed'
): Error {
  const text = result.stderr
  const checking = fallback === 'update-check-failed'
  if (result.timedOut === true) return reasonError(checking ? 'update-timeout' : fallback)
  if (result.code === GH_EXIT_AUTH) return reasonError('update-gh-auth')
  if (/rate limit|HTTP 429|secondary rate|abuse detection/i.test(text)) return reasonError('update-rate-limited')
  if (/HTTP 40[134]|Could not resolve to a Repository|gh auth login|not logged in/i.test(text)) {
    return reasonError('update-gh-auth')
  }
  if (/release not found/i.test(text)) return reasonError(checking ? 'update-no-release' : fallback)
  if (
    /could not resolve host|no such host|dial tcp|connection (refused|reset|timed out)|i\/o timeout|network is unreachable|x509|certificate|tls:|proxyconnect|proxy|\bEOF\b|timeout awaiting|temporary failure in name resolution|getaddrinfo|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(
      text
    )
  ) {
    return reasonError('update-network')
  }
  return reasonError(fallback)
}

async function runGh(run: CommandRunner, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  try {
    return await run('gh', args, { timeoutMs })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw reasonError('update-gh-missing')
    throw err
  }
}

/** The entry point that fetches with `gh release view` / `gh release download`. */
export function ghReleaseSource(repo: string, run: CommandRunner = runCommand): ReleaseSource {
  return {
    async latestTag() {
      const result = await runGh(run, ['release', 'view', '-R', repo, '--json', 'tagName', '--jq', '.tagName'], VIEW_TIMEOUT_MS)
      if (result.code !== 0) throw ghFailure(result, 'update-check-failed')
      const tag = result.stdout.trim()
      if (tag === '') throw reasonError('update-check-failed')
      return tag
    },
    async download(tag, names, dir) {
      const patterns = names.flatMap((name) => ['-p', name])
      const result = await runGh(
        run,
        ['release', 'download', tag, '-R', repo, '-D', dir, '--clobber', ...patterns],
        DOWNLOAD_TIMEOUT_MS
      )
      if (result.code !== 0) throw ghFailure(result, 'update-download-failed')
    }
  }
}
