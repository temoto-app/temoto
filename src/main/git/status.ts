/**
 * GitStatusReader - the **read-only entry point** that stays in main and reads the BottomBar's git information
 * (ARCHITECTURE.md chapter 3 / 5.6, TODO 51). It has the same standing as `FsAccess` and does not touch the DB.
 *
 * - It calls the real `git` through `runGit` in `run.ts` (no library that reads `.git` directly is added). The fixed safe
 *   flags and environment and the stopping of filters are attached by `runGit` (TODO 836).
 *   One run of `git --no-optional-locks status --porcelain=v2 --branch` gives
 *   branch / ahead / behind / the change count. `--no-optional-locks` is there so the 15-second
 *   polling does not rewrite the index (`index.lock`) and conflict with an in-progress CLI or IDE.
 * - A URI from the renderer **must** go through `assertAllowed` (FsAccess's gate).
 * - Every "cannot show" reason falls to `null`: no `git` / timeout / not under git /
 *   no cwd / a refused URI. Exceptions are **not thrown** to the caller.
 * - The log never contains the command's output or arguments (or paths). Only reason codes.
 * - If `git` is missing (ENOENT), or macOS's `/usr/bin/git` complained about `xcode-select` because the
 *   Command Line Tools are absent, it is **never called again in this session** -
 *   the latter shows an OS dialog every time it is called.
 * - After `dispose()` it does not run (12.9). A running child process is aborted.
 */
import type { ExecFileException } from 'node:child_process'
import { statSync } from 'node:fs'
import type { GitStatus } from '@shared/git.js'
import { log } from '../../common/logger.js'
import { runGit } from './run.js'

/** Time allowed for one `git status`. If exceeded, it is hidden this time (such as the first run in a large repository). */
export const GIT_STATUS_TIMEOUT_MS = 3000
/** Cap on porcelain output. Even with hundreds of thousands of untracked files, main is not inflated. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export type GitFailure = 'missing' | 'timeout' | 'not-a-repo' | 'denied' | 'error' | 'disposed'

/**
 * Summarizes the output of `git status --porcelain=v2 --branch` (a pure function).
 *
 * ```
 * # branch.oid <commit> | (initial)
 * # branch.head <name> | (detached)
 * # branch.upstream <name>          (only when there is an upstream)
 * # branch.ab +<ahead> -<behind>    (only when there is an upstream)
 * 1 <XY> …   changed (ordinary)
 * 2 <XY> …   rename / copy
 * u <XY> …   unmerged
 * ? <path>   untracked
 * ! <path>   ignored (not shown by default)
 * ```
 */
export function parsePorcelainV2(text: string): GitStatus {
  let oid = ''
  let head = ''
  let hasUpstream = false
  let ahead = 0
  let behind = 0
  let changed = 0
  let untracked = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (line.startsWith('# ')) {
      const rest = line.slice(2)
      if (rest.startsWith('branch.oid ')) oid = rest.slice('branch.oid '.length)
      else if (rest.startsWith('branch.head ')) head = rest.slice('branch.head '.length)
      else if (rest.startsWith('branch.upstream ')) hasUpstream = true
      else if (rest.startsWith('branch.ab ')) {
        const m = /^branch\.ab \+(\d+) -(\d+)$/.exec(rest)
        if (m !== null) {
          ahead = Number(m[1])
          behind = Number(m[2])
        }
      }
      continue
    }
    const tag = line.slice(0, 2)
    if (tag === '1 ' || tag === '2 ' || tag === 'u ') changed += 1
    else if (tag === '? ') untracked += 1
  }
  const detached = head === '(detached)'
  const branch = detached ? (oid === '(initial)' ? 'HEAD' : oid.slice(0, 7)) : head
  return { branch, detached, hasUpstream, ahead, behind, changed, untracked }
}

export interface GitStatusReaderDeps {
  /** The gate for URIs from the renderer. Pass `FsAccess.assertAllowed(uri, true)`. If it throws, `null`. */
  readonly assertAllowed: (uri: string) => string
  /** The command to call. The default is `git` on PATH (`src/main/path-env.ts` widens it even for a GUI launch). */
  readonly gitCommand?: string
  readonly timeoutMs?: number
}

interface RunResult {
  readonly ok: true
  readonly stdout: string
}

interface RunFailure {
  readonly ok: false
  readonly reason: GitFailure
}

export class GitStatusReader {
  private disposed = false
  /** Once `git` is found unusable, it is not called again (avoids a flood of dialogs and ENOENT). */
  private unavailable = false
  private readonly inflight = new Set<AbortController>()
  private readonly gitCommand: string
  private readonly timeoutMs: number

  constructor(private readonly deps: GitStatusReaderDeps) {
    this.gitCommand = deps.gitCommand ?? 'git'
    this.timeoutMs = deps.timeoutMs ?? GIT_STATUS_TIMEOUT_MS
  }

  /**
   * The git summary of the URI's cwd. **Does not throw**. Every reason it cannot be shown is `null`.
   * It does not even trust the type, so it takes `unknown` (it is called directly from IPC).
   */
  async read(cwdUri: unknown): Promise<GitStatus | null> {
    if (this.disposed || this.unavailable) return null
    if (typeof cwdUri !== 'string' || cwdUri === '') return null
    let cwd: string
    try {
      cwd = this.deps.assertAllowed(cwdUri)
    } catch {
      log.debug('git.status.skipped', { reason: 'denied' })
      return null
    }
    // A spawn failure when the cwd does not exist is the same ENOENT as when `git` is missing and cannot be told apart, and
    // left alone, a single deleted scratch area (T19) would set `unavailable`. Check this first.
    if (!isDirectory(cwd)) return null
    const result = await this.run(cwd)
    if (!result.ok) {
      if (result.reason === 'missing') {
        // Warn only once. Do not call afterwards (`unavailable`).
        this.unavailable = true
        log.warn('git.status.unavailable', { reason: result.reason })
      } else if (result.reason !== 'not-a-repo' && result.reason !== 'disposed') {
        log.debug('git.status.failed', { reason: result.reason })
      }
      return null
    }
    try {
      return parsePorcelainV2(result.stdout)
    } catch {
      return null
    }
  }

  /** Shutdown (12.9). After this `read` returns `null`, and a running child process is stopped. */
  dispose(): void {
    this.disposed = true
    for (const controller of this.inflight) controller.abort()
    this.inflight.clear()
  }

  private run(cwd: string): Promise<RunResult | RunFailure> {
    if (this.disposed) return Promise.resolve({ ok: false, reason: 'disposed' })
    const controller = new AbortController()
    this.inflight.add(controller)
    // The fixed flags and environment and the stopping of filters are in `run.ts` (TODO 836). Do not descend into submodules - descending could run
    // the filters in the child repository's config (submodule changes are not counted in the BottomBar's count).
    return runGit(['status', '--porcelain=v2', '--branch', '--ignore-submodules=all'], {
      cwd,
      gitCommand: this.gitCommand,
      timeoutMs: this.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      signal: controller.signal
    }).then(({ error, stdout, stderr }): RunResult | RunFailure => {
      this.inflight.delete(controller)
      if (error === null) return { ok: true, stdout: stdout.toString('utf8') }
      return { ok: false, reason: classifyError(error, stderr, controller.signal.aborted) }
    })
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Maps an execFile failure to a reason code. **The error's message contains the command line and stderr,
 * so it is not passed beyond here** (so that no paths appear in the log).
 */
function classifyError(error: ExecFileException, stderr: string, aborted: boolean): GitFailure {
  if (aborted) return 'disposed'
  if (error.code === 'ENOENT') return 'missing'
  // macOS: without the Command Line Tools, /usr/bin/git is a shim and shows the xcode-select dialog.
  if (/xcode-select/i.test(stderr)) return 'missing'
  if (error.killed === true || error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
    return 'timeout'
  }
  // Outside git is exit 128 with "fatal: not a git repository".
  if (error.code === 128) return 'not-a-repo'
  return 'error'
}
