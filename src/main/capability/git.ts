/**
 * The read-only git capability of the CapabilityBroker (TODO 834 stage 1, ARCHITECTURE.md 7.7 "execution" principle / 7.4.14).
 *
 * A plugin states an intent (`status` / `diff` / `show` / `log`, `@shared/plugin-git.ts`); **this file builds every argv** from validated
 * values only, and runs git only through `runGit` (fixed safe flags and environment, every filter driver stopped - TODO 836). There is no
 * way for a plugin to add a flag, a config, a pathspec or an environment variable. It never writes (no commit / add / checkout / stash...).
 *
 * Scope = the folder the user opened in the Source Control view (the Broker's repository grant):
 *
 * - git runs with `cwd` = the folder's real path and the pathspec `.` (with `--literal-pathspecs`), so status / diff / log only see changes
 *   inside the folder. Paths going in and out are relative to the folder; an entry outside it (a rename from outside) loses that side.
 * - **Every path is checked against the exclusion rules** (`classifyAccess(..., 'read')`, both the folder's logical and real spellings) before it is
 *   listed or read. An excluded path is counted in `hidden` and never listed, and `show` refuses it, so git is not a way around the file policy.
 * - The repository must be this folder's own: the git dir is inside the work tree's top level (a normal `.git`), or it is a linked worktree
 *   whose git dir points back at this top level (`<gitdir>/gitdir`). A `.git` file that points at another repository (`gitdir: ~/private/.git`),
 *   a submodule checkout, a bare repository and a git dir under an excluded place are refused (`unsupported-repo`).
 * - **The repository's data must be the folder's own too**: `objects` and `refs` (and the entries directly under them) may not be symlinks out of the
 *   common dir, `objects/info/alternates` / `http-alternates` must be absent or empty (they would borrow another repository's objects), and
 *   `HEAD` / `packed-refs` / `index` may not be symlinks. Refused as `unsupported-repo`. `GIT_ALTERNATE_OBJECT_DIRECTORIES` is dropped by `runGit` (every `GIT_*`).
 * - `GIT_DIR` / `GIT_WORK_TREE` and every other inherited `GIT_*` are dropped by `runGit`; `safe.bareRepository=explicit` refuses implicit bare repos.
 * - The working-tree side of `show` is read through the file policy (realpath, roots, O_NOFOLLOW + fstat); a symlink yields its target text, as git does.
 * - Output sizes, entry counts and time are bounded; binary contents are never returned.
 *
 * Failures are thrown as `GitDenied` with a short reason (the Broker records it in the audit; stderr and argv are never logged).
 */
import { closeSync, constants, fstatSync, lstatSync, readSync, readlinkSync, realpathSync, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import type { ExecFileException } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  GIT_INDEX,
  GIT_WORKTREE,
  MAX_GIT_ENTRIES,
  MAX_GIT_LOG,
  MAX_GIT_SHOW_BYTES,
  isGitRelativePath,
  type BrokerGitRequest,
  type GitChange,
  type GitChangeStatus,
  type GitCommit,
  type GitDiffOptions,
  type GitDiffResult,
  type GitLogOptions,
  type GitLogResult,
  type GitShowResult,
  type GitStatusResult
} from '@shared/plugin-git.js'
import { isGitRev } from '@shared/git-rev.js'
import { classifyAccess, type ExclusionRules } from '../../common/exclusions.js'
import { classifyAccessOnDisk } from '../../common/project-marker.js'
import { PathDenied, insideRoots, openChecked, resolvePath } from '../../common/fs-policy.js'
import { openNoFollowSync } from '../../common/os/open-flags.js'
import { GIT_DIFF_SAFETY_FLAGS, runGit, type GitRunOptions, type GitRunOutput } from '../git/run.js'

export type GitDenyReason =
  | 'git-missing'
  | 'not-a-repo'
  | 'unsupported-repo'
  | 'invalid-rev'
  | 'timeout'
  | 'too-large'
  | 'excluded'
  | 'busy'
  | 'error'

export class GitDenied extends Error {
  constructor(readonly reason: GitDenyReason) {
    super(reason)
    this.name = 'GitDenied'
  }
}

export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitRunOutput>

/** The folder a grant points at (already through the file policy). */
export interface GitFolder {
  /** The path the user opened (the logical spelling). */
  readonly logical: string
  /** Its real path (realpath). git runs here. */
  readonly canonical: string
}

/** What `inspectRepository` learned (used to build every later command). */
export interface GitRepository extends GitFolder {
  /** The work tree's top level (git prints it with symlinks resolved). */
  readonly toplevel: string
  /** The folder relative to the top level, with a trailing `/` (empty at the top level). */
  readonly prefix: string
}

export interface GitReadContext {
  readonly rules: ExclusionRules
  readonly run?: GitRunner
  /** The `git` to call (tests). Default: `git` on PATH. */
  readonly gitCommand?: string
}

/**
 * Placed after `runGit`'s own safety flags and before every subcommand. Configs here only override repository settings that would change the
 * output shape we parse (`diff.relative`, `log.follow`, colour, quoting) or widen what git reads (`safe.bareRepository`).
 */
export const GIT_READ_PREFIX: readonly string[] = [
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'core.quotePath=false',
  '-c',
  'color.ui=false',
  '-c',
  'diff.relative=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'log.follow=false',
  '--literal-pathspecs'
]

const INSPECT_TIMEOUT_MS = 5_000
const READ_TIMEOUT_MS = 15_000
const LIST_MAX_BUFFER = 16 * 1024 * 1024
const LOG_MAX_BUFFER = 2 * 1024 * 1024
const INSPECT_MAX_BUFFER = 64 * 1024
/** git's own heuristic: a NUL in the first 8000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000
const DEFAULT_LOG_LIMIT = 50

// ---------------------------------------------------------------------------
// argv builders (pure; exported for tests)
// ---------------------------------------------------------------------------

export function inspectArgs(): string[] {
  return [...GIT_READ_PREFIX, 'rev-parse', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-prefix']
}

export function statusArgs(): string[] {
  return [
    ...GIT_READ_PREFIX,
    'status',
    '--porcelain=v2',
    '-z',
    '--branch',
    '--no-ahead-behind',
    '--untracked-files=all',
    '--ignore-submodules=all',
    '--',
    '.'
  ]
}

/** Throws `GitDenied('invalid-rev')` for a combination the schema already refuses (defence in depth). */
export function diffArgs(options: GitDiffOptions): string[] {
  const { from, to, staged } = options
  if (from !== undefined && !isGitRev(from)) throw new GitDenied('invalid-rev')
  if (to !== undefined && (!isGitRev(to) || from === undefined || staged === true)) throw new GitDenied('invalid-rev')
  return [
    ...GIT_READ_PREFIX,
    'diff',
    ...GIT_DIFF_SAFETY_FLAGS,
    '--no-color',
    '--name-status',
    '-z',
    '-M',
    '--ignore-submodules=all',
    ...(staged === true ? ['--cached'] : []),
    ...(from === undefined ? [] : [from]),
    ...(to === undefined ? [] : [to]),
    '--',
    '.'
  ]
}

/** `cat-file --filters <object>`: the working-tree form (eol), with every filter driver stopped by `runGit`. */
export function showArgs(rev: string, repoPath: string): string[] {
  if (rev !== GIT_INDEX && !isGitRev(rev)) throw new GitDenied('invalid-rev')
  // `:<path>` is stage 0 of the index. `repoPath` never starts with `/` (that would be `:/<text>`, a commit-message search).
  if (repoPath.startsWith('/') || repoPath.length === 0) throw new GitDenied('error')
  const object = rev === GIT_INDEX ? `:${repoPath}` : `${rev}:${repoPath}`
  return [...GIT_READ_PREFIX, 'cat-file', '--filters', object]
}

export const LOG_FORMAT = '--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1e'

export function logArgs(options: GitLogOptions): { args: string[]; limit: number } {
  const limit = Math.max(1, Math.min(MAX_GIT_LOG, Math.floor(options.limit ?? DEFAULT_LOG_LIMIT)))
  const skip = Math.max(0, Math.floor(options.skip ?? 0))
  const rev = options.rev ?? 'HEAD'
  if (!isGitRev(rev)) throw new GitDenied('invalid-rev')
  return {
    limit,
    args: [
      ...GIT_READ_PREFIX,
      'log',
      ...GIT_DIFF_SAFETY_FLAGS,
      '--no-color',
      LOG_FORMAT,
      // One more than asked, to know whether more follow.
      `--max-count=${limit + 1}`,
      ...(skip > 0 ? [`--skip=${skip}`] : []),
      rev,
      '--',
      '.'
    ]
  }
}

// ---------------------------------------------------------------------------
// parsers (pure; exported for tests)
// ---------------------------------------------------------------------------

function statusOfLetter(letter: string): GitChangeStatus | null {
  switch (letter) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    case 'U':
      return 'conflicted'
    default:
      return null
  }
}

/** Splits off `count` space-separated fields; the remainder (a path may contain spaces) is the last element. */
function splitFields(record: string, count: number): string[] | null {
  const out: string[] = []
  let rest = record
  for (let i = 0; i < count; i += 1) {
    const at = rest.indexOf(' ')
    if (at < 0) return null
    out.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  out.push(rest)
  return out
}

/** A change as git printed it: paths relative to the top level. */
export interface RawGitChange {
  readonly path: string
  readonly status: GitChangeStatus
  readonly oldPath?: string
}

export interface RawGitStatus {
  readonly branch: string | null
  readonly head: string | null
  readonly staged: RawGitChange[]
  readonly unstaged: RawGitChange[]
}

/** Parses `git status --porcelain=v2 -z --branch`. Unknown records are skipped. */
export function parseStatusV2(output: string): RawGitStatus {
  const tokens = output.split('\0')
  let branch: string | null = null
  let head: string | null = null
  const staged: RawGitChange[] = []
  const unstaged: RawGitChange[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const record = tokens[i] ?? ''
    if (record === '') continue
    if (record.startsWith('# branch.head ')) {
      const name = record.slice('# branch.head '.length)
      branch = name === '(detached)' ? null : name
      continue
    }
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length)
      head = /^[0-9a-f]{40,64}$/.test(oid) ? oid : null
      continue
    }
    const kind = record[0]
    if (kind === '?') {
      const path = record.slice(2)
      // A nested repository / directory shows as `dir/`: there is nothing to diff.
      if (path !== '' && !path.endsWith('/')) unstaged.push({ path, status: 'untracked' })
      continue
    }
    if (kind === '1' || kind === '2') {
      const fields = splitFields(record, kind === '1' ? 8 : 9)
      if (fields === null) continue
      const xy = fields[1] ?? ''
      const path = fields[fields.length - 1] ?? ''
      let oldPath: string | undefined
      if (kind === '2') {
        i += 1
        oldPath = tokens[i]
      }
      if (path === '' || xy.length !== 2) continue
      const x = statusOfLetter(xy[0] ?? '.')
      const y = statusOfLetter(xy[1] ?? '.')
      const withOld = (status: GitChangeStatus): RawGitChange =>
        (status === 'renamed' || status === 'copied') && oldPath !== undefined && oldPath !== '' ? { path, status, oldPath } : { path, status }
      if (x !== null) staged.push(withOld(x))
      if (y !== null) unstaged.push(withOld(y))
      continue
    }
    if (kind === 'u') {
      const fields = splitFields(record, 10)
      const path = fields?.[fields.length - 1] ?? ''
      if (path !== '') unstaged.push({ path, status: 'conflicted' })
    }
  }
  return { branch, head, staged, unstaged }
}

/** Parses `git diff --name-status -z` (`R<score>` / `C<score>` carry two paths). */
export function parseNameStatusZ(output: string): RawGitChange[] {
  const tokens = output.split('\0')
  const out: RawGitChange[] = []
  let i = 0
  while (i < tokens.length) {
    const code = tokens[i] ?? ''
    if (code === '') {
      i += 1
      continue
    }
    const status = statusOfLetter(code[0] ?? '')
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = tokens[i + 1] ?? ''
      const path = tokens[i + 2] ?? ''
      i += 3
      if (status !== null && path !== '') out.push(oldPath === '' ? { path, status } : { path, status, oldPath })
      continue
    }
    const path = tokens[i + 1] ?? ''
    i += 2
    if (status !== null && path !== '') out.push({ path, status })
  }
  return out
}

/** Parses the `LOG_FORMAT` output. A record that does not have the expected shape is skipped. */
export function parseLog(output: string): GitCommit[] {
  const out: GitCommit[] = []
  for (const raw of output.split('\x1e')) {
    const record = raw.replace(/^\n/, '')
    if (record === '') continue
    const [hash, parents, author, time, ...subject] = record.split('\x1f')
    if (hash === undefined || !/^[0-9a-f]{40,64}$/.test(hash) || parents === undefined || author === undefined || time === undefined) continue
    const seconds = Number(time)
    out.push({
      hash,
      parents: parents === '' ? [] : parents.split(' ').filter((parent) => /^[0-9a-f]{40,64}$/.test(parent)),
      author,
      time: Number.isFinite(seconds) ? seconds * 1000 : 0,
      subject: subject.join('\x1f')
    })
  }
  return out
}

/** Whether the bytes look binary (a NUL in the first 8000 bytes, git's rule). */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, BINARY_SNIFF_BYTES)
  for (let i = 0; i < limit; i += 1) if (bytes[i] === 0) return true
  return false
}

/** Maps a failed run to a reason (pure). stderr is only matched, never passed on. */
export function classifyGitError(error: ExecFileException, stderr: string): GitDenyReason {
  if (error.code === 'ENOENT' || /xcode-select/i.test(stderr)) return 'git-missing'
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(error.message)) return 'too-large'
  if (error.killed === true || error.signal === 'SIGTERM') return 'timeout'
  if (/not a git repository|must be run in a work tree|cannot use bare repository/i.test(stderr)) return 'not-a-repo'
  if (/unknown revision|bad revision|ambiguous argument|bad default revision|does not have any commits|invalid object name/i.test(stderr)) {
    return 'invalid-rev'
  }
  return 'error'
}

// ---------------------------------------------------------------------------
// the operations
// ---------------------------------------------------------------------------

async function run(context: GitReadContext, cwd: string, args: readonly string[], timeoutMs: number, maxBuffer: number): Promise<GitRunOutput> {
  const runner = context.run ?? runGit
  return runner(args, { cwd, timeoutMs, maxBuffer, ...(context.gitCommand === undefined ? {} : { gitCommand: context.gitCommand }) })
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

function excludedDirectory(path: string, rules: ExclusionRules): boolean {
  return classifyAccessOnDisk(path, basename(path), true, rules, 'read').excluded
}

/**
 * Finds the repository of the folder and checks that it is the folder's own (see the file comment). Throws `GitDenied` otherwise.
 */
export async function inspectRepository(folder: GitFolder, context: GitReadContext): Promise<GitRepository> {
  const out = await run(context, folder.canonical, inspectArgs(), INSPECT_TIMEOUT_MS, INSPECT_MAX_BUFFER)
  if (out.error !== null) {
    const reason = classifyGitError(out.error, out.stderr)
    throw new GitDenied(reason === 'invalid-rev' || reason === 'error' ? 'not-a-repo' : reason)
  }
  const lines = out.stdout.toString('utf8').split('\n')
  const [inside, toplevelRaw, gitDirRaw, commonDirRaw, prefixRaw] = lines
  if (inside !== 'true' || toplevelRaw === undefined || gitDirRaw === undefined || commonDirRaw === undefined) {
    throw new GitDenied('not-a-repo')
  }
  if (!isAbsolute(toplevelRaw) || !isAbsolute(gitDirRaw) || commonDirRaw === '') throw new GitDenied('unsupported-repo')
  const toplevel = realpathOrNull(toplevelRaw)
  const gitDir = realpathOrNull(gitDirRaw)
  const commonDir = realpathOrNull(resolve(folder.canonical, commonDirRaw))
  if (toplevel === null || gitDir === null || commonDir === null) throw new GitDenied('unsupported-repo')
  // The folder must be inside the work tree (a `core.worktree` elsewhere is refused).
  if (!insideRoots(folder.canonical, [toplevel])) throw new GitDenied('unsupported-repo')
  const ownRepository = commonDir === gitDir && gitDir !== toplevel && insideRoots(gitDir, [toplevel])
  if (!ownRepository && !isLinkedWorktreeOf(gitDir, commonDir, toplevel)) throw new GitDenied('unsupported-repo')
  // The repository's data may not live in an excluded place either.
  if (excludedDirectory(gitDir, context.rules) || excludedDirectory(commonDir, context.rules)) throw new GitDenied('excluded')
  // The objects and refs this repository reads must be its own (no symlink out, no borrowed object store).
  if (!(await repositoryDataIsOwn(commonDir, gitDir))) throw new GitDenied('unsupported-repo')
  return { ...folder, toplevel, prefix: folderPrefix(folder.canonical, toplevel, prefixRaw) }
}

/**
 * The folder relative to the top level, with a trailing `/`. **git's own `--show-prefix` is the source** (it prints the path NFC-composed on macOS, the
 * same spelling as every path git later prints, while the file system may hand back NFD); without that line the real-path difference is used, normalized
 * to NFC. This is the one place the spelling is decided, so listing, exclusion and `show` agree.
 */
function folderPrefix(canonical: string, toplevel: string, shown: string | undefined): string {
  if (canonical === toplevel) return ''
  const fromPath = `${canonical.slice(toplevel.length).replace(/^\/+/, '')}/`.normalize('NFC')
  if (shown === undefined || shown === '') return fromPath
  const prefix = shown.endsWith('/') ? shown : `${shown}/`
  // A prefix that is absolute, climbs, or differs from the real path (modulo spelling) is not trusted.
  if (prefix.startsWith('/') || prefix.split('/').includes('..') || prefix.normalize('NFC') !== fromPath) return fromPath
  return prefix
}

function isSymlinkAt(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Alternates are absent or empty (a non-empty one names another repository's object store). Anything odd counts as non-empty. */
function noAlternates(commonDir: string, name: string): boolean {
  const path = join(commonDir, 'objects', 'info', name)
  try {
    lstatSync(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  if (isSymlinkAt(path)) return false
  return readSmallRegularFile(path, MAX_GITDIR_FILE_BYTES) === ''
}

/** Upper bound of entries looked at under `objects` and `refs` (a repository beyond it is refused: the safe side). */
export const MAX_REPOSITORY_DATA_ENTRIES = 200_000

/**
 * Whether a whole tree is free of symlinks (review, TODO 834): a pack, a loose object or a ref file that is a symlink would make git read
 * another repository's data. Every level is listed (no stat per entry), asynchronously, and the walk stops at `budget.left` entries.
 * An unreadable directory or an exhausted budget counts as "not clean".
 */
async function treeHasNoSymlink(dir: string, budget: { left: number }): Promise<boolean> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  budget.left -= entries.length
  if (budget.left < 0) return false
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return false
    if (entry.isDirectory() && !(await treeHasNoSymlink(join(dir, entry.name), budget))) return false
  }
  return true
}

/**
 * The data git reads for this repository stays inside it: `objects` / `refs` are real directories of the common dir, **nothing anywhere under
 * them is a symlink** (packs, loose objects, ref files), no alternates, and the files git opens by name (`HEAD`, `packed-refs`, `index`) are not
 * symlinks. Only lstat / realpath / readdir and a bounded non-blocking read: nothing here can block main.
 */
export async function repositoryDataIsOwn(commonDir: string, gitDir: string): Promise<boolean> {
  for (const name of ['objects', 'refs']) {
    const real = realpathOrNull(join(commonDir, name))
    if (real === null || !insideRoots(real, [commonDir])) return false
  }
  const budget = { left: MAX_REPOSITORY_DATA_ENTRIES }
  const trees = [join(commonDir, 'objects'), join(commonDir, 'refs')]
  // A linked worktree keeps its own refs (bisect, rebase) under its git dir.
  if (gitDir !== commonDir && !isSymlinkAt(join(gitDir, 'refs')) && realpathOrNull(join(gitDir, 'refs')) !== null) trees.push(join(gitDir, 'refs'))
  for (const dir of trees) {
    if (isSymlinkAt(dir) || !(await treeHasNoSymlink(dir, budget))) return false
  }
  if (gitDir !== commonDir && isSymlinkAt(join(gitDir, 'refs'))) return false
  if (!noAlternates(commonDir, 'alternates') || !noAlternates(commonDir, 'http-alternates')) return false
  for (const file of [join(commonDir, 'HEAD'), join(commonDir, 'packed-refs'), join(gitDir, 'HEAD'), join(gitDir, 'index')]) {
    if (isSymlinkAt(file)) return false
  }
  return true
}

/** Upper bound of a linked worktree's `gitdir` file (one path). */
const MAX_GITDIR_FILE_BYTES = 4096

/**
 * Reads a small file whose content the repository controls, without ever blocking main's thread: O_NOFOLLOW + O_NONBLOCK, then
 * `fstat().isFile()` (a FIFO or a device planted at that name is refused, not waited on), and at most `max` bytes. Null when it is not such a file.
 */
function readSmallRegularFile(path: string, max: number): string | null {
  let fd: number
  try {
    fd = openNoFollowSync(path, constants.O_RDONLY)
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || Number(stat.size) > max) return null
    const data = Buffer.alloc(max)
    const n = readSync(fd, data, 0, max, 0)
    return data.subarray(0, n).toString('utf8').trim()
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * A linked worktree (`git worktree add`): its git dir is `<common>/worktrees/<name>`, and that git dir's `gitdir` file points back at
 * `<this top level>/.git`. A `.git` file that merely names another repository has no such back-link.
 */
function isLinkedWorktreeOf(gitDir: string, commonDir: string, toplevel: string): boolean {
  if (gitDir === commonDir || dirname(gitDir) !== join(commonDir, 'worktrees')) return false
  const back = readSmallRegularFile(join(gitDir, 'gitdir'), MAX_GITDIR_FILE_BYTES)
  if (back === null || back === '') return false
  const target = realpathOrNull(resolve(gitDir, back))
  const own = realpathOrNull(join(toplevel, '.git'))
  if (target === null || own === null || target !== own) return false
  try {
    return lstatSync(own).isFile()
  } catch {
    return false
  }
}

/** Whether a folder-relative path may be listed / read: a valid relative path that matches no exclusion (both spellings of the folder). */
export function pathAllowed(repository: GitFolder, relative: string, rules: ExclusionRules): boolean {
  if (!isGitRelativePath(relative)) return false
  for (const base of new Set([repository.logical, repository.canonical])) {
    const absolute = join(base, relative)
    if (classifyAccess(absolute, basename(absolute), false, rules, 'read').excluded) return false
  }
  return true
}

/** Turns git's top-level-relative changes into folder-relative ones, dropping what is outside, malformed or excluded. */
export function toFolderChanges(
  raw: readonly RawGitChange[],
  repository: GitRepository,
  rules: ExclusionRules,
  limit: number
): { changes: GitChange[]; hidden: number; truncated: boolean } {
  const changes: GitChange[] = []
  let hidden = 0
  let truncated = false
  const relative = (path: string): string | null => (path.startsWith(repository.prefix) ? path.slice(repository.prefix.length) : null)
  for (const change of raw) {
    const path = relative(change.path)
    if (path === null) continue
    if (!pathAllowed(repository, path, rules)) {
      hidden += 1
      continue
    }
    if (changes.length >= limit) {
      truncated = true
      break
    }
    const old = change.oldPath === undefined ? null : relative(change.oldPath)
    changes.push(old !== null && pathAllowed(repository, old, rules) ? { path, status: change.status, oldPath: old } : { path, status: change.status })
  }
  return { changes, hidden, truncated }
}

function failed(out: GitRunOutput): never {
  throw new GitDenied(out.error === null ? 'error' : classifyGitError(out.error, out.stderr))
}

export async function gitStatus(repository: GitRepository, context: GitReadContext): Promise<GitStatusResult> {
  const out = await run(context, repository.canonical, statusArgs(), READ_TIMEOUT_MS, LIST_MAX_BUFFER)
  if (out.error !== null) failed(out)
  const parsed = parseStatusV2(out.stdout.toString('utf8'))
  const staged = toFolderChanges(parsed.staged, repository, context.rules, MAX_GIT_ENTRIES)
  const unstaged = toFolderChanges(parsed.unstaged, repository, context.rules, Math.max(0, MAX_GIT_ENTRIES - staged.changes.length))
  return {
    branch: parsed.branch,
    head: parsed.head,
    staged: staged.changes,
    unstaged: unstaged.changes,
    truncated: staged.truncated || unstaged.truncated,
    hidden: staged.hidden + unstaged.hidden
  }
}

export async function gitDiff(repository: GitRepository, options: GitDiffOptions, context: GitReadContext): Promise<GitDiffResult> {
  const out = await run(context, repository.canonical, diffArgs(options), READ_TIMEOUT_MS, LIST_MAX_BUFFER)
  if (out.error !== null) failed(out)
  const { changes, hidden, truncated } = toFolderChanges(parseNameStatusZ(out.stdout.toString('utf8')), repository, context.rules, MAX_GIT_ENTRIES)
  return { files: changes, hidden, truncated }
}

export async function gitLog(repository: GitRepository, options: GitLogOptions, context: GitReadContext): Promise<GitLogResult> {
  const { args, limit } = logArgs(options)
  const out = await run(context, repository.canonical, args, READ_TIMEOUT_MS, LOG_MAX_BUFFER)
  if (out.error !== null) {
    const reason = classifyGitError(out.error, out.stderr)
    // A repository without commits has no `HEAD` to walk: an empty history, not a failure.
    if (reason === 'invalid-rev' && options.rev === undefined) return { commits: [], more: false }
    throw new GitDenied(reason)
  }
  const commits = parseLog(out.stdout.toString('utf8'))
  return { commits: commits.slice(0, limit), more: commits.length > limit }
}

function textOrBinary(bytes: Uint8Array): GitShowResult {
  if (looksBinary(bytes)) return { kind: 'binary', size: bytes.byteLength }
  return { kind: 'text', text: new TextDecoder('utf-8').decode(bytes), size: bytes.byteLength }
}

export async function gitShow(repository: GitRepository, rev: string, relative: string, context: GitReadContext): Promise<GitShowResult> {
  if (!pathAllowed(repository, relative, context.rules)) {
    throw isGitRelativePath(relative) ? new GitDenied('excluded') : new GitDenied('error')
  }
  if (rev === GIT_WORKTREE) return readWorktree(repository, relative, context.rules)
  const out = await run(context, repository.canonical, showArgs(rev, `${repository.prefix}${relative}`), READ_TIMEOUT_MS, MAX_GIT_SHOW_BYTES)
  if (out.error !== null) {
    const reason = classifyGitError(out.error, out.stderr)
    if (reason === 'too-large') return { kind: 'too-large', limit: MAX_GIT_SHOW_BYTES }
    // "path does not exist in <rev>" / "not in the index": that side has no such file. An unknown version (a bad name, a range) is not "empty":
    // it is `invalid-rev`, except `HEAD` of a repository without commits (nothing there yet).
    if (out.error.code === 128 && reason === 'invalid-rev' && rev === 'HEAD') return { kind: 'missing' }
    if (out.error.code === 128 && reason === 'error') return { kind: 'missing' }
    throw new GitDenied(reason)
  }
  return textOrBinary(out.stdout)
}

/**
 * The working-tree side, through the file policy: the folder's two spellings are the roots, the exclusion rules apply to the logical and real paths,
 * and the file is opened with O_NOFOLLOW + fstat (`openChecked`). A symlink yields its target text (what git stores for it), never what it points at.
 */
function readWorktree(repository: GitFolder, relative: string, rules: ExclusionRules): GitShowResult {
  const roots = [...new Set([repository.logical, repository.canonical])]
  const logical = join(repository.logical, relative)
  let parent: string
  try {
    parent = realpathSync.native(dirname(logical))
  } catch {
    return { kind: 'missing' }
  }
  if (!insideRoots(parent, roots)) throw new PathDenied('symlink-escape')
  const real = join(parent, basename(logical))
  let isLink = false
  try {
    isLink = lstatSync(real).isSymbolicLink()
  } catch {
    return { kind: 'missing' }
  }
  if (isLink) {
    if (classifyAccess(real, basename(real), false, rules, 'read').excluded) throw new GitDenied('excluded')
    const target = readlinkSync(real)
    return { kind: 'text', text: target, size: Buffer.byteLength(target) }
  }
  const resolved = resolvePath(logical, { rules, roots }, false, 'read')
  if (!resolved.exists || resolved.isDirectory) return { kind: 'missing' }
  const fd = openChecked(resolved, constants.O_RDONLY)
  try {
    const size = Number(fstatSync(fd).size)
    if (size > MAX_GIT_SHOW_BYTES) return { kind: 'too-large', limit: MAX_GIT_SHOW_BYTES }
    // A dedicated buffer (not a pooled Buffer): the result is structured-cloned to the plugin-host.
    const data = new Uint8Array(size)
    let read = 0
    while (read < size) {
      const n = readSync(fd, data, read, size - read, read)
      if (n === 0) break
      read += n
    }
    return textOrBinary(read === size ? data : data.slice(0, read))
  } finally {
    closeSync(fd)
  }
}

/** Runs one validated request on a granted folder. */
export async function runGitRead(request: BrokerGitRequest, folder: GitFolder, context: GitReadContext): Promise<unknown> {
  const repository = await inspectRepository(folder, context)
  switch (request.op) {
    case 'status':
      return gitStatus(repository, context)
    case 'diff':
      return gitDiff(
        repository,
        {
          ...(request.from === undefined ? {} : { from: request.from }),
          ...(request.to === undefined ? {} : { to: request.to }),
          ...(request.staged === undefined ? {} : { staged: request.staged })
        },
        context
      )
    case 'show':
      return gitShow(repository, request.rev, request.path, context)
    case 'log':
      return gitLog(
        repository,
        {
          ...(request.rev === undefined ? {} : { rev: request.rev }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.skip === undefined ? {} : { skip: request.skip })
        },
        context
      )
    default: {
      const never: never = request
      void never
      throw new GitDenied('error')
    }
  }
}
