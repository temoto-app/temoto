/**
 * Shapes of the read-only git capability (TODO 834 stage 1, ARCHITECTURE.md 7.7 "execution" principle / 7.4.14).
 *
 * A plugin never builds argv: it states an intent (`status` / `diff` / `show` / `log`) and main's CapabilityBroker builds the command line,
 * attaches the fixed safe flags (`runGit`) and checks every path against the file policy. **There are no privileges here**: only shapes,
 * limits and the helpers both sides (main, plugin) use to validate values. It depends on neither electron nor Node.
 *
 * Scope: a git operation reaches only **a folder the user opened in the Source Control view** (`aios-git:` URI, the same idea as fs's
 * "a URI the user opened"). Paths are relative to that folder; nothing outside it is listed or read.
 */
import { isGitRev } from './git-rev.js'

/**
 * The scheme of "a folder opened in the Source Control view" (`aios-git:///abs/path`, the same path part as a `file:` URI).
 * Opening a URI of this scheme in the viewer is what grants the folder to the git viewer's extension (main's `ViewerBroker.open`).
 */
export const GIT_REPOSITORY_SCHEME = 'aios-git'

const GIT_URI_PREFIX = `${GIT_REPOSITORY_SCHEME}://`
const FILE_URI_PREFIX = 'file://'

/** `file:///a/b` -> `aios-git:///a/b`. null if not a `file:` URI. */
export function gitRepositoryUri(fileUri: string): string | null {
  if (!fileUri.startsWith(FILE_URI_PREFIX)) return null
  return `${GIT_URI_PREFIX}${fileUri.slice(FILE_URI_PREFIX.length)}`
}

/** `aios-git:///a/b` -> `file:///a/b`. null if not an absolute `aios-git:` URI. */
export function fileUriOfGitRepository(uri: string): string | null {
  if (!uri.startsWith(`${GIT_URI_PREFIX}/`)) return null
  return `${FILE_URI_PREFIX}${uri.slice(GIT_URI_PREFIX.length)}`
}

/** Whether the URI is of the Source Control scheme. */
export function isGitRepositoryUri(uri: string): boolean {
  return uri.startsWith(`${GIT_REPOSITORY_SCHEME}:`)
}

/** The "side" of `show` that is the staged copy (the index, stage 0). Contains `:`, so it can never be a rev (`isGitRev`). */
export const GIT_INDEX = ':index'
/** The "side" of `show` that is the file in the working tree. Contains `:`, so it can never be a rev. */
export const GIT_WORKTREE = ':worktree'

export type GitSide = typeof GIT_INDEX | typeof GIT_WORKTREE | string

/** Whether `value` is a side `show` accepts: the index, the working tree, or a rev that passes `isGitRev`. */
export function isGitSide(value: unknown): value is GitSide {
  return value === GIT_INDEX || value === GIT_WORKTREE || isGitRev(value)
}

/** Upper bound on a relative path (characters). */
export const MAX_GIT_PATH = 4096
/** Upper bound on the entries one `status` / `diff` returns. Beyond it, `truncated`. */
export const MAX_GIT_ENTRIES = 5000
/** Upper bound on the commits one `log` returns. */
export const MAX_GIT_LOG = 200
/** Upper bound on the contents one `show` returns (bytes). Beyond it, `too-large` (no contents). */
export const MAX_GIT_SHOW_BYTES = 2 * 1024 * 1024

/**
 * Whether a folder-relative path may be handed to a git operation (pure). Refused: empty, too long, absolute (`/` - also `:/` would be
 * git's "search commit messages" syntax), any control character (NUL, newline...), a `.` / `..` / empty segment, a `.git` segment in any
 * case (the repository's own files such as `.git/config` are never contents), and a leading `-`.
 * Pathspec magic (`:(…)`) is harmless anyway: main always passes `--literal-pathspecs`.
 */
export function isGitRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_GIT_PATH) return false
  if (value.startsWith('/') || value.startsWith('-')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git')
}

/** The kind of change of one file. `conflicted` is an unmerged path (VS Code's "Merge Changes"). */
export type GitChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflicted'

export interface GitChange {
  /** Relative to the opened folder, `/`-separated. */
  readonly path: string
  readonly status: GitChangeStatus
  /** The path before a rename / copy (relative to the opened folder). Omitted if it was outside the folder or excluded. */
  readonly oldPath?: string
}

export interface GitStatusResult {
  /** The branch name. null when detached or unknown. */
  readonly branch: string | null
  /** The commit of HEAD. null before the first commit. */
  readonly head: string | null
  /** HEAD vs the index ("Staged Changes"). */
  readonly staged: readonly GitChange[]
  /** The index vs the working tree, untracked and conflicted files ("Changes"). */
  readonly unstaged: readonly GitChange[]
  /** True if there were more than `MAX_GIT_ENTRIES` entries (the rest are not returned). */
  readonly truncated: boolean
  /** How many entries were dropped because they match the exclusion rules (they are neither listed nor readable). */
  readonly hidden: number
}

export interface GitDiffResult {
  readonly files: readonly GitChange[]
  readonly truncated: boolean
  readonly hidden: number
}

/** The contents of one side. `missing` = the file does not exist on that side (added / deleted). */
export type GitShowResult =
  | { readonly kind: 'text'; readonly text: string; readonly size: number }
  | { readonly kind: 'binary'; readonly size: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'too-large'; readonly limit: number }

export interface GitCommit {
  readonly hash: string
  readonly parents: readonly string[]
  readonly author: string
  /** Author time (ms since the epoch). */
  readonly time: number
  readonly subject: string
}

export interface GitLogResult {
  readonly commits: readonly GitCommit[]
  /** True if more commits may follow (exactly `limit` were returned). */
  readonly more: boolean
}

/** Options of `diff`. `{}` = index vs working tree, `staged` = HEAD (or `from`) vs index, `from` = rev vs working tree, `from` + `to` = rev vs rev. */
export interface GitDiffOptions {
  readonly from?: string
  readonly to?: string
  readonly staged?: boolean
}

export interface GitLogOptions {
  /** Where to start (default `HEAD`). */
  readonly rev?: string
  /** 1 to `MAX_GIT_LOG` (default 50). */
  readonly limit?: number
  readonly skip?: number
}

/** Broker requests of the `git` capability (validated by main's `request-schema.ts`). `repo` is the `file:` URI of the opened folder. */
export type BrokerGitRequest =
  | { readonly capability: 'git'; readonly op: 'status'; readonly repo: string }
  | ({ readonly capability: 'git'; readonly op: 'diff'; readonly repo: string } & GitDiffOptions)
  | { readonly capability: 'git'; readonly op: 'show'; readonly repo: string; readonly rev: GitSide; readonly path: string }
  | ({ readonly capability: 'git'; readonly op: 'log'; readonly repo: string } & GitLogOptions)

/** What `aios.git` gives a plugin (plugin-host turns each into a Broker request). */
export interface PluginGitApi {
  status(repo: string): Promise<GitStatusResult>
  diff(repo: string, options?: GitDiffOptions): Promise<GitDiffResult>
  /** `rev` is a rev, `GIT_INDEX` or `GIT_WORKTREE`. `path` is relative to the opened folder. */
  show(repo: string, rev: GitSide, path: string): Promise<GitShowResult>
  log(repo: string, options?: GitLogOptions): Promise<GitLogResult>
}
