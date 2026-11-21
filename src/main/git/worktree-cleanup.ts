/**
 * Cleanup of worktrees created by a conversation (TODO 633 stage 1, ARCHITECTURE 4.4). When a conversation is deleted, each
 * worktree it created (`thread_worktrees`) is examined one by one; **only if there are no changes and no unpushed commits** the git
 * lock is released and the worktree and its branch are removed. Anything that is kept is kept silently and the reason is returned
 * (the caller uses it as a marker in the list; no dialog is shown, TODO 167).
 *
 * - The real `git` is called through `runGit` in `run.ts` (same approach as `status.ts`). No shell. Neither hooks nor filters
 *   run (TODO 836). **The only exception is `worktree add` on restore**: it allows the repository's filters (`allowRepoFilters`),
 *   so LFS files get their real contents through smudge (owner decision 2026-10-16). The cleanup decision path stays locked down.
 * - **Only a worktree exactly one level below the worktree location of the conversation's cwd (the original repository) may be
 *   deleted.** The path suffix of that location is `WORKTREES_PATH_SUFFIX` in `common/exclusions.ts` (derived from compat,
 *   constraint 6). Both the logical path and the real path (realpath) are checked, and the worktree must appear in git's list
 *   (`worktree list --porcelain`) and not be the main one (the first entry).
 * - **Nothing under the credentials directory (the one containing `~/.<backend>`) is deleted** (constraint 2; in the wave 29
 *   code-review, `~/…/worktrees` slipped past the exclusion).
 * - "Unpushed": if there is an upstream, commits ahead of it; otherwise commits not in the HEAD of the main working copy.
 *   If there is even one, the worktree is kept. When removing, the branch is deleted with `branch -d` (merged only) and kept if that fails.
 * - Locks: if the reason contains `pid N` and that pid is alive, the worktree is kept (it belongs to a running CLI). Otherwise the lock is released.
 * - **git-ignored files** (TODO 748): `status` does not list ignored files, and `worktree remove` deletes the whole directory even
 *   when ignored files are inside. A `.env` or an ignored memo would not come back on restore (rebuild from HEAD) either, so if there is
 *   even one ignored file outside the rebuildable locations in `common/rebuildable-ignored.ts` (`node_modules/`, `dist/` ...) the
 *   worktree is kept with `ignored` (owner decision (a1) 2026-10-12).
 * - Paths may be logged, but git's output (the list of file names) is not.
 */
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { WORKTREES_PATH_SUFFIX, createMacosExclusions } from '../../common/exclusions.js'
import { foldPath } from '../../common/uri.js'
import { isRebuildableIgnoredPath } from '../../common/rebuildable-ignored.js'
import { isDirectWorktreeOf } from './worktree-path.js'
import { runGit } from './run.js'

export { isDirectWorktreeOf }

/** Result of the cleanup. `removed` / `gone` are dropped from the table; the others are the reason it was kept (marker in the list). */
export type WorktreeCleanupVerdict =
  | 'removed'
  | 'gone'
  | 'changes'
  | 'unpushed'
  /** There are git-ignored files (such as `.env`) that are not in the table of rebuildable locations (TODO 748). */
  | 'ignored'
  | 'locked'
  | 'unsafe'
  | 'failed'

/**
 * Result of the cleanup plus the material to rebuild it after removal (code-review fix: a soft-deleted conversation can be restored, so on
 * restore the worktree is recreated with the same path and the same branch name; owner decision 2026-10-11). `head` / `branch` are only meaningful for `removed`.
 */
export interface WorktreeCleanupOutcome {
  readonly verdict: WorktreeCleanupVerdict
  /** HEAD commit of the removed worktree (the base for recreating it). null if unknown. */
  readonly head: string | null
  /** Branch of the removed worktree (value from git's list). null if detached. */
  readonly branch: string | null
}

export interface WorktreeCleanupTarget {
  /** Path of the worktree (the recorded value; for a child worktree it may be an estimate built from the convention). */
  readonly path: string
  /** Branch name (without `refs/heads/`). null if unknown. */
  readonly branch: string | null
  /** The conversation's cwd (the original repository). git runs here. */
  readonly repoCwd: string
}

export interface GitRunResult {
  readonly ok: boolean
  readonly stdout: string
  /** Exit code on failure (set only by entry points that can read it; used to tell TODO 1022's "not applicable = 1" apart). */
  readonly code?: number | string | null
}

export interface WorktreeCleanupDeps {
  /** Run git once. A failure (non-zero exit code, cannot start) gives `ok: false`. Never throws. */
  readonly runGit?: (args: readonly string[], cwd: string, options?: GitFileOptions) => Promise<GitRunResult>
  /** Whether the pid is alive. Defaults to `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean
  /** Whether the path is under the credentials directory. Defaults to the `credentials` rule of `createMacosExclusions(home)`. */
  readonly isProtected?: (path: string) => boolean
  readonly suffix?: string
}

/** Time allowed for one git call. Removing a worktree takes long on a big tree. */
const GIT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export interface GitFileOptions {
  /** Same-named option as in `run.ts`. **Only for the `worktree add` on restore** (runs the repository's configured filters = LFS smudge). */
  readonly allowRepoFilters?: boolean
}

/** Run git once. The fixed safe flags and environment and the filter stop are in `runGit` in `run.ts` (TODO 836). Never throws. */
export async function runGitFile(args: readonly string[], cwd: string, options: GitFileOptions = {}): Promise<GitRunResult> {
  const { error, stdout } = await runGit(args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    ...(options.allowRepoFilters === true ? { allowRepoFilters: true } : {})
  })
  return { ok: error === null, stdout: stdout.toString('utf8') }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether the path is under the credentials rule (`credentials`). Paths outside the home are checked by the rule table too. */
export function credentialGuard(home: string = homedir()): (path: string) => boolean {
  const rules = createMacosExclusions(home)
  const prefixes = rules.prefixes.filter((rule) => rule.reason === 'credentials').map((rule) => rule.prefix)
  return (path) => {
    const folded = foldPath(resolve(path))
    return prefixes.some((prefix) => folded === prefix || folded.startsWith(`${prefix}/`))
  }
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  readonly path: string
  readonly head: string | null
  /** Branch name with `refs/heads/` stripped. null if detached. */
  readonly branch: string | null
  /** Lock reason (empty string if `locked` has no reason). null if not locked. */
  readonly locked: string | null
  /** Whether this is the first entry (the main working copy). */
  readonly main: boolean
}

/** Parse `git worktree list --porcelain` (pure function). Entries are separated by blank lines. */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: { path: string; head: string | null; branch: string | null; locked: string | null } | null = null
  const flush = (): void => {
    if (current !== null) entries.push({ ...current, main: entries.length === 0 })
    current = null
  }
  for (const line of text.split('\n')) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length), head: null, branch: null, locked: null }
      continue
    }
    if (current === null) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (line === 'locked') current.locked = ''
    else if (line.startsWith('locked ')) current.locked = line.slice('locked '.length)
  }
  flush()
  return entries
}

/**
 * Whether the branch has commits that are not in the head of the main working copy (basis of the dot on a child worktree,
 * TODO 633 stage 2 code-review 6). The baseline is the same as the "unpushed" check in `cleanupWorktree`: **the head of the main working copy**,
 * not the `HEAD` of the conversation's cwd: once the conversation has moved into a worktree, the cwd's HEAD is that worktree's,
 * which would shift the baseline. false when unknown (git failed, no main head, invalid branch name). **Never throws**.
 */
export async function branchHasCommits(
  repoCwd: string,
  branch: string,
  runGit: NonNullable<WorktreeCleanupDeps['runGit']> = runGitFile
): Promise<boolean> {
  if (branch.startsWith('-')) return false
  const list = await runGit(['worktree', 'list', '--porcelain'], repoCwd)
  if (!list.ok) return false
  const mainHead = parseWorktreeList(list.stdout).find((e) => e.main)?.head ?? null
  if (mainHead === null) return false
  const result = await runGit(['rev-list', '--count', `${mainHead}..refs/heads/${branch}`], repoCwd)
  return result.ok && Number(result.stdout.trim()) > 0
}

/**
 * From the output of `git status --porcelain -z --ignored=matching`, pull out only the paths of ignored entries (`!! <path>`)
 * (pure function). Because of `-z` paths are not quoted. Directories end with `/`.
 */
export function parseIgnoredEntries(text: string): string[] {
  const paths: string[] = []
  for (const record of text.split('\0')) {
    if (record.startsWith('!! ')) paths.push(record.slice(3))
  }
  return paths
}

/** Whether there are ignored files that fall outside the table of rebuildable locations (TODO 748). */
export function hasPreciousIgnored(paths: readonly string[]): boolean {
  return paths.some((path) => !isRebuildableIgnoredPath(path))
}

/**
 * From the output of `git ls-files -z --stage`, pull out only the paths of submodules (gitlinks, mode 160000) (pure function).
 * One entry is `<mode> <oid> <stage>\t<path>`.
 */
export function parseGitlinks(text: string): string[] {
  const paths: string[] = []
  for (const record of text.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0 || !record.startsWith('160000 ')) continue
    paths.push(record.slice(tab + 1))
  }
  return paths
}

/**
 * Whether the worktree has a submodule directory with contents. An uninitialized submodule is an empty directory
 * (or missing), so there is no work in it. If it has contents (initialized, or files placed by hand) there may be uncommitted work inside.
 * Failure to read (anything other than `ENOENT` / `ENOTDIR`) is treated as "yes".
 */
export async function hasPopulatedSubmodule(worktreePath: string, gitlinks: readonly string[]): Promise<boolean> {
  for (const link of gitlinks) {
    try {
      if ((await readdir(resolve(worktreePath, link))).length > 0) return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return true
    }
  }
  return false
}

/** The pid in the lock reason (`… (pid 1234 …)`). null if absent. */
export function lockPid(reason: string): number | null {
  const match = /\bpid (\d+)\b/.exec(reason)
  if (match === null) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

/**
 * For a path under `/Volumes/<name>/…`, whether the volume itself (`/Volumes/<name>`) is not mounted.
 * A `stat` on the leaf path under an unmounted volume gives `ENOENT` (the volume itself is missing), which is
 * indistinguishable from "the leaf was deleted", so the volume root is checked separately to tell them apart.
 */
async function isUnmountedVolumePath(path: string): Promise<boolean> {
  const match = /^\/Volumes\/[^/]+/.exec(path)
  if (match === null) return false
  try {
    await stat(match[0])
    return false
  } catch {
    return true
  }
}

/**
 * Whether the path exists (of whatever kind). **Only ENOENT / ENOTDIR (missing, or an intermediate component is not a directory) counts as
 * "missing"**; anything else (`EACCES` / `ETIMEDOUT`, under an unmounted external volume, etc.) is "unknown", so
 * it is conservatively treated as "exists" (code-review TODO 714: every `stat` failure used to be read as "gone"; fixed. Callers now
 * fall back to `unsafe` / `failed` and never go to `gone` / `forget` without proof). Shared with `reconcileWorktreePresence`
 * in `src/main/session/manager.ts` (there used to be two copies).
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return true
    // If the volume itself is missing (not mounted), an ENOENT on the leaf path is treated as "unknown".
    if (await isUnmountedVolumePath(path)) return true
    return false
  }
}

/**
 * Candidate roots of the worktree location: the conversation's cwd and its git top level (both logical and real). null if git does not answer.
 */
async function worktreeRoots(
  git: NonNullable<WorktreeCleanupDeps['runGit']>,
  repoCwd: string,
  suffix: string
): Promise<((path: string) => boolean) | null> {
  const top = await git(['rev-parse', '--show-toplevel'], repoCwd)
  if (!top.ok) return null
  const roots = new Set<string>([repoCwd, top.stdout.trim()])
  for (const root of [...roots]) {
    const real = await realOrNull(root)
    if (real !== null) roots.add(real)
  }
  return (path: string): boolean => [...roots].some((root) => isDirectWorktreeOf(path, root, suffix))
}

/**
 * Examine one worktree and remove it if it can be removed. **Never throws**.
 */
export async function cleanupWorktree(
  target: WorktreeCleanupTarget,
  deps: WorktreeCleanupDeps = {}
): Promise<WorktreeCleanupVerdict> {
  return (await cleanupWorktreeOutcome(target, deps)).verdict
}

/** Same as `cleanupWorktree`, but also returns the material for recreating it (HEAD and branch). **Never throws**. */
export async function cleanupWorktreeOutcome(
  target: WorktreeCleanupTarget,
  deps: WorktreeCleanupDeps = {}
): Promise<WorktreeCleanupOutcome> {
  let head: string | null = null
  let branch: string | null = null
  const verdict = await cleanupWorktreeInner(target, deps, (entry) => {
    head = entry.head
    branch = entry.branch
  })
  return verdict === 'removed' ? { verdict, head, branch } : { verdict, head: null, branch: null }
}

async function cleanupWorktreeInner(
  target: WorktreeCleanupTarget,
  deps: WorktreeCleanupDeps,
  onEntry: (entry: WorktreeEntry) => void
): Promise<WorktreeCleanupVerdict> {
  const git = deps.runGit ?? runGitFile
  const isAlive = deps.isAlive ?? defaultIsAlive
  const isProtected = deps.isProtected ?? credentialGuard()
  const suffix = deps.suffix ?? WORKTREES_PATH_SUFFIX
  try {
    const repoCwd = resolve(target.repoCwd)
    if (!(await exists(repoCwd))) return 'failed'
    const underRoots = await worktreeRoots(git, repoCwd, suffix)
    if (underRoots === null) return 'failed'

    const list = await git(['worktree', 'list', '--porcelain'], repoCwd)
    if (!list.ok) return 'failed'
    const entries = parseWorktreeList(list.stdout)
    const recordedReal = await realOrNull(target.path)
    // Look up by the recorded (real) path, else by branch (a child worktree's path is estimated from the convention).
    let entry =
      entries.find(
        (e) => !e.main && (e.path === target.path || (recordedReal !== null && e.path === recordedReal))
      ) ?? null
    if (entry === null) {
      for (const e of entries) {
        if (e.main || target.branch === null || e.branch !== target.branch) continue
        entry = e
        break
      }
    }
    if (entry === null) {
      // Unknown to git and no directory = already gone (removed by the user or the CLI). The branch is left alone.
      return (await exists(target.path)) ? 'unsafe' : 'gone'
    }
    const entryReal = (await realOrNull(entry.path)) ?? entry.path
    // Location check: both the logical and the real path must be exactly one level below the location of the conversation's cwd. Nothing under the credentials directory is removed.
    if (!underRoots(entry.path) || !underRoots(entryReal)) return 'unsafe'
    if (isProtected(entry.path) || isProtected(entryReal)) return 'unsafe'
    if (!(await exists(entry.path))) return 'gone'

    // Submodules (wave 41 code-review): `status` runs with `--ignore-submodules=all` so the child repository's config is not executed, and
    // it does not descend, so uncommitted work inside a child is invisible. If even one submodule has contents, keep with `changes`
    // (only reads the gitlinks in the index; no git is started in the child).
    const staged = await git(['ls-files', '-z', '--stage'], entry.path)
    if (!staged.ok) return 'failed'
    if (await hasPopulatedSubmodule(entry.path, parseGitlinks(staged.stdout))) return 'changes'

    // Changes (including untracked files).
    const status = await git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], entry.path)
    if (!status.ok) return 'failed'
    if (status.stdout.trim() !== '') return 'changes'

    // Unpushed commits.
    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], entry.path)
    let ahead: GitRunResult
    if (upstream.ok && upstream.stdout.trim() !== '') {
      ahead = await git(['rev-list', '--count', '@{u}..HEAD'], entry.path)
    } else {
      const mainEntry = entries.find((e) => e.main)
      const mainHead = mainEntry?.head ?? null
      if (mainHead === null) return 'failed'
      ahead = await git(['rev-list', '--count', `${mainHead}..HEAD`], entry.path)
    }
    if (!ahead.ok) return 'failed'
    const count = Number(ahead.stdout.trim())
    if (!Number.isFinite(count)) return 'failed'
    if (count > 0) return 'unpushed'

    // Ignored files (TODO 748). Keep if even one is outside the table of rebuildable locations. `-z` avoids path quoting.
    const ignored = await git(
      ['status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=normal', '--ignore-submodules=all'],
      entry.path
    )
    if (!ignored.ok) return 'failed'
    if (hasPreciousIgnored(parseIgnoredEntries(ignored.stdout))) return 'ignored'

    // Lock. One held by a running process is not released.
    if (entry.locked !== null) {
      const pid = lockPid(entry.locked)
      if (pid !== null && isAlive(pid)) return 'locked'
      const unlock = await git(['worktree', 'unlock', entry.path], repoCwd)
      if (!unlock.ok) return 'failed'
    }

    onEntry(entry)
    const removed = await git(['worktree', 'remove', entry.path], repoCwd)
    if (!removed.ok) return (await exists(entry.path)) ? 'failed' : 'removed'
    // Delete the branch only if merged (`-d`). git refuses the branch the main copy is on and branches of other worktrees.
    if (entry.branch !== null && entry.branch === (target.branch ?? entry.branch)) {
      await git(['branch', '-d', entry.branch], repoCwd)
    }
    return 'removed'
  } catch {
    return 'failed'
  }
}

/** Result of recreation. `restored` = recreated (or it already exists as a git worktree). */
export type WorktreeRestoreVerdict = 'restored' | 'unsafe' | 'failed'

export interface WorktreeRestoreTarget {
  /** Path to recreate (same as before the cleanup). */
  readonly path: string
  /** Branch name (same as before the cleanup). If null, create it detached. */
  readonly branch: string | null
  /** HEAD commit at the time of the cleanup (the base for recreating). */
  readonly head: string
  /** The conversation's cwd (the original repository). git runs here. */
  readonly repoCwd: string
}

const COMMIT_RE = /^[0-9a-f]{7,64}$/

/**
 * Recreate a cleaned-up worktree with the same path and the same branch name (code-review fix, TODO 633, owner decision
 * 2026-10-11: when a conversation is restored). Only worktrees with no changes and no unpushed commits were cleaned up, so recreating from
 * the HEAD at cleanup time restores the contents exactly; the transcript can also be resumed with `--resume` from the same cwd. **Never throws**.
 *
 * - The location check is the same as in the cleanup (exactly one level below the location of the conversation's cwd, not under credentials).
 * - If the branch still exists (`branch -d` refused), it is used; otherwise it is created from HEAD with the same name.
 * - If the same path already exists: `restored` if git knows it as that worktree, otherwise `failed` without touching it.
 */
export async function recreateWorktree(
  target: WorktreeRestoreTarget,
  deps: WorktreeCleanupDeps = {}
): Promise<WorktreeRestoreVerdict> {
  const git = deps.runGit ?? runGitFile
  const isProtected = deps.isProtected ?? credentialGuard()
  const suffix = deps.suffix ?? WORKTREES_PATH_SUFFIX
  try {
    const repoCwd = resolve(target.repoCwd)
    if (!(await exists(repoCwd))) return 'failed'
    if (!COMMIT_RE.test(target.head)) return 'unsafe'
    // A branch name starting with `-` would be read by git as an option.
    if (target.branch !== null && (target.branch === '' || target.branch.startsWith('-'))) return 'unsafe'
    const underRoots = await worktreeRoots(git, repoCwd, suffix)
    if (underRoots === null) return 'failed'
    if (!underRoots(target.path) || isProtected(target.path)) return 'unsafe'
    if (await exists(target.path)) {
      const list = await git(['worktree', 'list', '--porcelain'], repoCwd)
      if (!list.ok) return 'failed'
      const real = (await realOrNull(target.path)) ?? target.path
      const known = parseWorktreeList(list.stdout).some((e) => !e.main && (e.path === target.path || e.path === real))
      return known ? 'restored' : 'failed'
    }
    // First prune git's records of worktrees that no longer exist (e.g. deleted by hand by the user).
    await git(['worktree', 'prune'], repoCwd)
    let args: string[]
    if (target.branch === null) {
      args = ['worktree', 'add', '--detach', target.path, target.head]
    } else {
      const has = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}`], repoCwd)
      args = has.ok
        ? ['worktree', 'add', target.path, target.branch]
        : ['worktree', 'add', '-b', target.branch, target.path, target.head]
    }
    // Only the restore checkout runs the repository's filters (LFS smudge extracts the real contents; owner decision 2026-10-16:
    // it is the user's own repository where they started the conversation, and the CLI is free to run git there anyway). Hooks stay off.
    const added = await git(args, repoCwd, { allowRepoFilters: true })
    return added.ok && (await exists(target.path)) ? 'restored' : 'failed'
  } catch {
    return 'failed'
  }
}
