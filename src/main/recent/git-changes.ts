/**
 * The git check for "recent files" (TODO 999, owner decision number 2). Of files under git, **only modified and untracked (not ignored)**
 * are kept as "recent" - files written by `git checkout` have the same contents as HEAD (clean), and build outputs are ignored by `.gitignore`, so both drop out.
 *
 * - git is called only through `runGit` in `src/main/git/run.ts` (TODO 836: fixed safe flags, environment, and filters turned off).
 * - Only repositories that contain candidate files are read, **remembered briefly** (`STATUS_TTL_MS`). It is not run for every repository every time.
 * - The repository root is found by searching upward for `.git` (a folder or a file - worktree / submodule). Results are remembered per folder.
 * - When it cannot be read (timeout, a `safe.directory` owned by someone else, a broken repository) the result is `unknown` - the caller **keeps** the file
 *   (it does not silently hide what it cannot tell). If it turns out that git is missing or the Command Line Tools are missing (the `xcode-select` dialog),
 *   it is never called again in this session (the same judgment as `status.ts`).
 * - Neither paths nor command output are logged.
 */
import { stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import type { ExecFileException } from 'node:child_process'
import { foldPath } from '../../common/uri.js'
import { log } from '../../common/logger.js'
import { runGit, type GitRunOptions, type GitRunOutput } from '../git/run.js'

/** How long one repository's status is remembered. Re-reading the diff while it is open does not run it again. */
export const STATUS_TTL_MS = 15_000
/** How long the folder -> repository root mapping is remembered. */
const ROOT_TTL_MS = 5 * 60_000
/** Time allowed for one `git status`. If exceeded on the first run in a large repository, `unknown` (keep). */
const STATUS_TIMEOUT_MS = 3_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** Number of `git status` runs allowed at the same time. */
const MAX_PARALLEL = 4

export type GitFileState = 'changed' | 'clean' | 'unknown' | 'not-repo'

interface RepoStatus {
  readonly at: number
  /** Modified and untracked files (collapsed absolute paths). null means it could not be read. */
  readonly files: ReadonlySet<string> | null
  /** Untracked folders (`?? dir/`, collapsed absolute path + `/`). All files inside are untracked. */
  readonly untrackedDirs: readonly string[]
}

export interface GitChangeDeps {
  readonly run?: (args: readonly string[], options: GitRunOptions) => Promise<GitRunOutput>
  /** Whether `.git` exists (a folder or a file will do). */
  readonly hasDotGit?: (dir: string) => Promise<boolean>
  readonly now?: () => number
  readonly gitCommand?: string
}

async function defaultHasDotGit(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * From the output of `git status --porcelain=v1 -z`, take out the modified and untracked paths (relative to the root) (a pure function).
 * For rename / copy (`R` / `C`) the next field is the original name, so it is skipped. An untracked folder ends with `/`.
 */
export function parsePorcelainV1Z(text: string): { readonly changed: readonly string[]; readonly untrackedDirs: readonly string[] } {
  const changed: string[] = []
  const untrackedDirs: string[] = []
  const fields = text.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string
    if (field.length < 4) continue
    const x = field[0]
    const y = field[1]
    const path = field.slice(3)
    if (x === '!') continue
    if (x === '?' && path.endsWith('/')) untrackedDirs.push(path)
    else changed.push(path)
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1
  }
  return { changed, untrackedDirs }
}

function isMissing(error: ExecFileException, stderr: string): boolean {
  return error.code === 'ENOENT' || /xcode-select/i.test(stderr)
}

export class GitChangeIndex {
  private readonly run: NonNullable<GitChangeDeps['run']>
  private readonly hasDotGit: NonNullable<GitChangeDeps['hasDotGit']>
  private readonly now: () => number
  private readonly roots = new Map<string, { readonly at: number; readonly root: string | null }>()
  private readonly statuses = new Map<string, RepoStatus>()
  private readonly inflight = new Map<string, Promise<RepoStatus>>()
  private running = 0
  private readonly waiting: (() => void)[] = []
  private unavailable = false
  private disposed = false
  /** On shutdown (`dispose`), stop the running `git` (the same as `GitStatusReader`, 12.9). */
  private readonly abort = new AbortController()

  constructor(private readonly deps: GitChangeDeps = {}) {
    this.run = deps.run ?? runGit
    this.hasDotGit = deps.hasDotGit ?? defaultHasDotGit
    this.now = deps.now ?? Date.now
  }

  /** The state of a file with an absolute path. **Never throws.** */
  async stateOf(path: string): Promise<GitFileState> {
    if (this.disposed) return 'unknown'
    const root = await this.rootOf(dirname(path))
    if (root === null) return 'not-repo'
    if (this.unavailable) return 'unknown'
    const status = await this.statusOf(root)
    if (status.files === null) return 'unknown'
    const folded = foldPath(path)
    if (status.files.has(folded)) return 'changed'
    if (status.untrackedDirs.some((dir) => folded.startsWith(dir))) return 'changed'
    return 'clean'
  }

  /** After this, do not call `git`, and abort running children (main's shutdown cleanup, `recentFiles.dispose`). */
  dispose(): void {
    this.disposed = true
    this.abort.abort()
  }

  /** Search upward from a folder for `.git`. The answers for the folders passed on the way are remembered too. */
  private async rootOf(dir: string): Promise<string | null> {
    const now = this.now()
    const visited: string[] = []
    let current = dir
    let found: string | null = null
    for (let depth = 0; depth < 64; depth++) {
      const cached = this.roots.get(current)
      if (cached !== undefined && now - cached.at < ROOT_TTL_MS) {
        found = cached.root
        break
      }
      visited.push(current)
      if (await this.hasDotGit(current)) {
        found = current
        break
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    for (const d of visited) this.roots.set(d, { at: now, root: found })
    return found
  }

  private async statusOf(root: string): Promise<RepoStatus> {
    const cached = this.statuses.get(root)
    if (cached !== undefined && this.now() - cached.at < STATUS_TTL_MS) return cached
    const pending = this.inflight.get(root)
    if (pending !== undefined) return pending
    const next = this.read(root).finally(() => this.inflight.delete(root))
    this.inflight.set(root, next)
    return next
  }

  private async read(root: string): Promise<RepoStatus> {
    await this.acquire()
    try {
      if (this.unavailable || this.disposed) return { at: this.now(), files: null, untrackedDirs: [] }
      // Do not descend into submodules (the filters configured in a child repository could run - the same as status.ts).
      const { error, stdout, stderr } = await this.run(
        ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'],
        {
          cwd: root,
          ...(this.deps.gitCommand === undefined ? {} : { gitCommand: this.deps.gitCommand }),
          timeoutMs: STATUS_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          signal: this.abort.signal
        }
      )
      if (error !== null) {
        if (isMissing(error, stderr)) {
          this.unavailable = true
          log.warn('recent.git.unavailable', {})
        } else {
          log.debug('recent.git.failed', { code: typeof error.code === 'number' ? error.code : String(error.code ?? '') })
        }
        const status = { at: this.now(), files: null, untrackedDirs: [] }
        this.statuses.set(root, status)
        return status
      }
      const parsed = parsePorcelainV1Z(stdout.toString('utf8'))
      const base = root.endsWith(sep) ? root : root + sep
      const files = new Set(parsed.changed.map((rel) => foldPath(join(root, rel))))
      const untrackedDirs = parsed.untrackedDirs.map((rel) => foldPath(base + rel))
      const status = { at: this.now(), files, untrackedDirs }
      this.statuses.set(root, status)
      return status
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < MAX_PARALLEL) {
      this.running++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
  }

  private release(): void {
    this.running--
    this.waiting.shift()?.()
  }
}

