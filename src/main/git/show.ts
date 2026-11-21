/**
 * Reads a file's contents at a git rev (TODO 826, `openDiff` in ARCHITECTURE.md 7.6.2).
 *
 * The same style as `status.ts` (GitStatusReader): it calls the real `git` with `execFile` and does not touch the DB.
 * **The path gate is the caller's** (only an absolute path that passed `FsAccess.assertAllowed` is handed over). This file
 * only calls `git cat-file --filters <rev>:./<file name>` once (with cwd = the file's folder; `./` makes it relative to the cwd, so
 * the repository root need not be looked up first). `--filters` returns the **working-tree form** (eol conversion) -
 * with the stored blob of `git show`, a repo with `eol=crlf` would show every line different from the right side (the checked-out file).
 * **The smudge filter is not run** (TODO 836): `runGit` in `run.ts` stops every filter driver in the config, so
 * the conversion is only git's built-in ones (eol / ident / working-tree-encoding). LFS files are seen as pointers
 * (owner decision 2026-10-16). `runGit` also attaches the fixed safe flags and environment.
 *
 * - The rev is not trusted: only one that passed `isGitRev` (alphanumerics and `_./~^@{}+-`, not starting with `-`, up to 200 characters).
 *   `:` is not allowed, so a `rev:path` form cannot be built from outside, and since it does not start with `-` it cannot turn into a flag.
 * - Failures are returned as reason codes and **not thrown**. The error message (command line, stderr) is not passed outward (no paths in the log).
 * - The output limit is `maxBytes`. Beyond it, `too-large`.
 */
import type { ExecFileException } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { MAX_GIT_REV, isGitRev } from '../../common/git-rev.js'
import { runGit } from './run.js'

/** Time allowed for one `git show`. */
export const GIT_SHOW_TIMEOUT_MS = 10_000

// The rev rule is one shared with the gateway (`common/git-rev.ts`). Re-exported so existing import sites need not change.
export { MAX_GIT_REV, isGitRev }

export type GitShowFailure = 'missing' | 'not-a-repo' | 'not-found' | 'timeout' | 'too-large' | 'invalid-rev' | 'error'

export type GitShowResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: GitShowFailure }

export interface GitShowOptions {
  readonly gitCommand?: string
  readonly timeoutMs?: number
  readonly maxBytes: number
}

/** The contents of `path` (an absolute path that passed the gate) at `rev`. Does not throw. */
export function readFileAtRevision(path: string, rev: string, options: GitShowOptions): Promise<GitShowResult> {
  if (!isGitRev(rev)) return Promise.resolve({ ok: false, reason: 'invalid-rev' })
  return runGit(['cat-file', '--filters', `${rev}:./${basename(path)}`], {
    cwd: dirname(path),
    gitCommand: options.gitCommand,
    timeoutMs: options.timeoutMs ?? GIT_SHOW_TIMEOUT_MS,
    maxBuffer: options.maxBytes
  }).then(
    ({ error, stdout, stderr }): GitShowResult =>
      error === null ? { ok: true, bytes: stdout } : { ok: false, reason: classifyShowError(error, stderr) }
  )
}

/** Maps an execFile failure to a reason code (a pure function). */
export function classifyShowError(error: ExecFileException, stderr: string): GitShowFailure {
  if (error.code === 'ENOENT') return 'missing'
  if (/xcode-select/i.test(stderr)) return 'missing'
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(error.message)) return 'too-large'
  if (error.killed === true || error.signal === 'SIGTERM') return 'timeout'
  if (/not a git repository/i.test(stderr)) return 'not-a-repo'
  if (error.code === 128) return 'not-found'
  return 'error'
}
