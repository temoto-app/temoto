/**
 * The only entry point through which the app calls `git` (TODO 836, ARCHITECTURE.md 7.6.2 / 5.6 / 7.7 "execution" principle).
 *
 * git **can run arbitrary commands depending on the repository's config and attributes** (`core.fsmonitor`, hooks,
 * `filter.<name>.smudge` / `clean` / `process`, `core.pager`, `diff.external`, textconv,
 * `core.sshCommand` used by lazy fetch of a partial clone ...). If that is planted in the `.git/config` of a repository received as a zip or
 * in a shared folder, an arbitrary command runs just because the BottomBar reads that folder's git summary
 * (the same shape as the 2022 git vulnerabilities). Here **fixed flags and environment are always attached** to close that path:
 *
 * - `-c core.fsmonitor=false` / `-c core.hooksPath=/dev/null` / `-c core.pager=cat` / `--no-pager`
 *   / `-c submodule.recurse=false` / `-c protocol.allow=never` (no transfer at all) / `-c gc.auto=0` /
 *   `-c maintenance.auto=false` / `-c log.showSignature=false` (do not start gpg) / `--no-optional-locks`.
 * - Environment: drop every inherited `GIT_*` (`GIT_DIR` / `GIT_EXTERNAL_DIFF` / `GIT_SSH_COMMAND` ...) and
 *   add `GIT_CONFIG_NOSYSTEM=1` / `GIT_TERMINAL_PROMPT=0` / `GIT_PAGER=cat` / `PAGER=cat` /
 *   `GIT_NO_LAZY_FETCH=1` / `GIT_OPTIONAL_LOCKS=0`.
 * - **All filters (smudge / clean / process) are stopped**: right before execution, in the same cwd, it reads
 *   `git config -z --name-only --get-regexp '^(filter|include|includeif)\.'` (a remembered value while the config files do not change), and for each driver found
 *   sets `smudge` / `clean` / `process` to empty and `required` to false (passed via the `GIT_CONFIG_COUNT` environment variable -
 *   unlike `-c`, it does not break even if a driver's name contains `=`). git treats an empty command as "no filter".
 *   `git status` also passes stat-dirty files through the clean filter, so status needs this too. eol / `ident` /
 *   `working-tree-encoding` are git's built-in conversions that do not start commands, so they remain (`eol=crlf` of 828).
 *   **For read entry points, LFS files are seen as pointers** (owner decision 2026-10-16). The exception is `allowRepoFilters: true`
 *   (only `worktree add` when restoring a conversation's worktree, owner decision the same day): it stops neither filters nor transfers, and fetches the LFS contents.
 * - When diff commands (`diff` / `log -p` / `show`) are added in the future, attach `GIT_DIFF_SAFETY_FLAGS` (`--no-ext-diff --no-textconv`)
 *   after the subcommand. Do not use `--output`.
 * - **Do not remove `safe.directory`** (do not add `safe.directory=*`). git refuses a repository with a different owner.
 *
 * A failure is returned in `error` rather than thrown (the caller maps it to a reason code). The error message contains the command line and stderr,
 * so it is not written to the log.
 */
import { execFile, type ExecFileException } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Flags put before the subcommand in every call. */
export const GIT_SAFETY_ARGS: readonly string[] = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.pager=cat',
  '-c',
  'submodule.recurse=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'log.showSignature=false'
]

/**
 * The flag removed when `allowRepoFilters` is set (the transfer ban). Checkout of a partial clone fetches missing blobs by lazy fetch, and
 * LFS's smudge can also use git's config and transfers to fetch contents - an obstacle for an entry point that fetches the contents.
 */
const TRANSFER_BLOCK_ARG = 'protocol.allow=never'

/** The flags actually attached. */
function safetyArgs(allowRepoFilters: boolean): string[] {
  if (!allowRepoFilters) return [...GIT_SAFETY_ARGS]
  const out: string[] = []
  for (let i = 0; i < GIT_SAFETY_ARGS.length; i++) {
    const arg = GIT_SAFETY_ARGS[i] as string
    if (arg === '-c' && GIT_SAFETY_ARGS[i + 1] === TRANSFER_BLOCK_ARG) {
      i++
      continue
    }
    out.push(arg)
  }
  return out
}

/** Flags put after a diff subcommand (so external diff and textconv are not started). */
export const GIT_DIFF_SAFETY_FLAGS: readonly string[] = ['--no-ext-diff', '--no-textconv']

/** Drops `GIT_*` from the inherited environment and adds fixed values (a pure function). */
export function gitEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: readonly (readonly [string, string])[] = [],
  allowRepoFilters = false
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('GIT_')) continue
    env[key] = value
  }
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_PAGER = 'cat'
  env.PAGER = 'cat'
  if (!allowRepoFilters) env.GIT_NO_LAZY_FETCH = '1'
  env.GIT_OPTIONAL_LOCKS = '0'
  if (overrides.length > 0) {
    env.GIT_CONFIG_COUNT = String(overrides.length)
    overrides.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key
      env[`GIT_CONFIG_VALUE_${i}`] = value
    })
  }
  return env
}

/**
 * Builds the set of settings to stop from the output of `git config -z --name-only --get-regexp ^filter\.` (a pure function).
 * A key is `filter.<name>.<variable>` (the name keeps its case and may contain `.`).
 */
export function filterOverrides(configNames: string): Array<readonly [string, string]> {
  const drivers = new Set<string>()
  for (const key of configNames.split('\0')) {
    const trimmed = key.trim()
    if (!trimmed.toLowerCase().startsWith('filter.')) continue
    const last = trimmed.lastIndexOf('.')
    if (last <= 'filter.'.length) continue
    drivers.add(trimmed.slice('filter.'.length, last))
  }
  const out: Array<readonly [string, string]> = []
  for (const name of drivers) {
    out.push([`filter.${name}.smudge`, ''])
    out.push([`filter.${name}.clean`, ''])
    out.push([`filter.${name}.process`, ''])
    out.push([`filter.${name}.required`, 'false'])
  }
  return out
}

export interface GitRunOptions {
  readonly cwd: string
  /** The command to call. The default is `git` on PATH. */
  readonly gitCommand?: string
  /** The deadline for the preliminary step (the list of filters) and the real call combined. */
  readonly timeoutMs: number
  readonly maxBuffer: number
  readonly signal?: AbortSignal
  /**
   * **If true, the filters (smudge / clean / process) in the repository's config are not stopped, and the transfer ban
   * (`protocol.allow=never` / `GIT_NO_LAZY_FETCH`) is also removed** = commands in the repository's config run. Used only by entry points that fetch contents in a repository
   * where the user started a conversation themself (`worktree add` when restoring a conversation's worktree, LFS smudge - owner decision
   * 2026-10-16). Not used by read-only entry points (BottomBar, openDiff, cleanup decisions). Stopping fsmonitor, hooks and
   * the pager and the `GIT_*` cleanup remain.
   */
  readonly allowRepoFilters?: boolean
}

export interface GitRunOutput {
  /** null on success. On failure (cannot launch, non-zero exit code, timeout, over the limit), that exception. */
  readonly error: ExecFileException | null
  readonly stdout: Buffer
  readonly stderr: string
}

function execGit(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: GitRunOptions,
  maxBuffer: number,
  timeoutMs: number
): Promise<GitRunOutput> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...safetyArgs(options.allowRepoFilters === true), ...args],
      {
        cwd: options.cwd,
        env,
        timeout: Math.max(1, Math.ceil(timeoutMs)),
        maxBuffer,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        windowsHide: true,
        encoding: 'buffer'
      },
      (error, stdout, stderr) => {
        resolve({
          error,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : ''
        })
      }
    )
  })
}

/** Cap on the list of filter setting names (a config over it is abnormal, so it falls to failure). */
const MAX_CONFIG_BYTES = 1024 * 1024

/**
 * The config keys read in the preliminary step. In addition to filter drivers, include / includeIf are read - an include spreads the config's origin to
 * outside files that cannot be watched by mtime, so in that case it is not remembered (`filterListCache`).
 */
const CONFIG_LIST_ARGS: readonly string[] = ['config', '-z', '--name-only', '--get-regexp', '^(filter|include|includeif)\\.']

/** Whether the list output contains an include / includeIf key (a pure function). */
export function hasConfigIncludes(configNames: string): boolean {
  return configNames.split('\0').some((key) => {
    const lower = key.trim().toLowerCase()
    return lower.startsWith('include.') || lower.startsWith('includeif.')
  })
}

/** Builds a timeout as a failure of the same shape as execFile's (the caller's classification reads it as a timeout from `killed` / `SIGTERM`). */
function timedOut(): GitRunOutput {
  const error: ExecFileException = new Error('git timed out')
  error.killed = true
  error.signal = 'SIGTERM'
  error.code = 'ETIMEDOUT'
  return { error, stdout: Buffer.alloc(0), stderr: '' }
}

/** The signature of one file. `none` if absent, null if unreadable (not remembered). */
async function fileSignature(path: string): Promise<string | null> {
  try {
    const st = await stat(path, { bigint: true })
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : null
  }
}

/** Reads a small document. An empty string if absent, null if unreadable or too large. */
async function readSmallFile(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8')
    return text.length > 4096 ? null : text
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null
  }
}

/**
 * The list of config files the cwd's git reads (and the files that decide which repository it hits). Like git, it searches upward for
 * `.git`. **A shape it cannot tell (a bare repository, inside `.git`, an unreadable `.git` file, outside a repository) gives
 * null** = not remembered (read every time, the safe side). `GIT_*` is dropped by `gitEnv`, so `GIT_DIR` / `GIT_CONFIG_GLOBAL` have no effect, and
 * the system config is not read because of `GIT_CONFIG_NOSYSTEM`.
 */
export async function configSourceFiles(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string[] | null> {
  const home = env.HOME
  if (home === undefined || home === '' || !isAbsolute(cwd)) return null
  const xdg = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(home, '.config')
  const files = [join(home, '.gitconfig'), join(xdg, 'git', 'config')]
  let dir = resolve(cwd)
  for (;;) {
    const dotGit = join(dir, '.git')
    let kind: 'dir' | 'file' | 'none' = 'none'
    try {
      const st = await stat(dotGit)
      if (st.isDirectory()) kind = 'dir'
      else if (st.isFile()) kind = 'file'
      else return null
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
    }
    if (kind === 'none') {
      // If that level itself is a git directory (bare, inside `.git`), git uses it. Do not follow the shape; do not remember.
      if ((await fileSignature(join(dir, 'HEAD'))) !== 'none') return null
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
      continue
    }
    let gitDir = dotGit
    files.push(dotGit)
    if (kind === 'file') {
      const text = await readSmallFile(dotGit)
      const match = text === null ? null : /^gitdir: (.+)$/m.exec(text)
      if (match === null) return null
      gitDir = resolve(dir, (match[1] ?? '').trim())
    }
    const commonText = await readSmallFile(join(gitDir, 'commondir'))
    if (commonText === null) return null
    const commonDir = commonText.trim() === '' ? gitDir : resolve(gitDir, commonText.trim())
    files.push(join(gitDir, 'commondir'), join(commonDir, 'config'), join(gitDir, 'config.worktree'))
    if (commonDir !== gitDir) files.push(join(commonDir, 'config.worktree'))
    return files
  }
}

async function signatureOf(files: readonly string[]): Promise<string | null> {
  const parts: string[] = []
  for (const file of files) {
    const sig = await fileSignature(file)
    if (sig === null) return null
    parts.push(`${file}\0${sig}`)
  }
  return parts.join('\n')
}

interface CachedFilterList {
  readonly signature: string
  readonly overrides: ReadonlyArray<readonly [string, string]>
  readonly at: number
}

/** How many to remember, and for how long. Watching the files is the main mechanism; time is just in case. */
const FILTER_CACHE_MAX = 64
const FILTER_CACHE_TTL_MS = 60_000

/**
 * Briefly remembers the result of the preliminary step (the list of filters) per git command and cwd (code-review wave 41). The BottomBar
 * reads the same repository every 15 seconds, so this avoids starting two gits every time. **It is re-read if any of the inode, size, mtime or ctime of the config files
 * (global, the repository's `config` / `config.worktree`, `.git` and what it points to) changes**.
 * A config with includes, a repository of unknown shape, a failed list, and a config that changed while reading are not remembered.
 */
const filterListCache = new Map<string, CachedFilterList>()

/** For tests: discards the remembered lists. */
export function clearFilterListCache(): void {
  filterListCache.clear()
}

/** The preliminary step: the set of filters to stop. If unreadable, that failure (the real call is not made). */
async function filterOverridesFor(
  command: string,
  options: GitRunOptions,
  deadline: number
): Promise<{ readonly overrides: ReadonlyArray<readonly [string, string]> } | GitRunOutput> {
  const key = `${command}\0${resolve(options.cwd)}`
  const files = await configSourceFiles(options.cwd)
  const before = files === null ? null : await signatureOf(files)
  const cached = filterListCache.get(key)
  if (before !== null && cached !== undefined && cached.signature === before && Date.now() - cached.at < FILTER_CACHE_TTL_MS) {
    return { overrides: cached.overrides }
  }
  filterListCache.delete(key)
  const remaining = deadline - Date.now()
  if (remaining <= 0) return timedOut()
  const listed = await execGit(command, CONFIG_LIST_ARGS, gitEnv(), options, MAX_CONFIG_BYTES, remaining)
  let names = ''
  if (listed.error === null) names = listed.stdout.toString('utf8')
  else if (listed.error.code !== 1) return listed
  const overrides = filterOverrides(names)
  // Remember only when the config files are the same before and after reading and there is no include.
  if (before !== null && files !== null && !hasConfigIncludes(names) && (await signatureOf(files)) === before) {
    if (filterListCache.size >= FILTER_CACHE_MAX) {
      const oldest = filterListCache.keys().next().value
      if (oldest !== undefined) filterListCache.delete(oldest)
    }
    filterListCache.set(key, { signature: before, overrides, at: Date.now() })
  }
  return { overrides }
}

/**
 * Calls git once. **Does not throw**. First reads the filter config in the same cwd (using a remembered value if usable), stops all of them, then
 * makes the real call. If the list of filters cannot be read (cannot launch, timeout, abort), the real call is not made and that failure is returned
 * (never run without being able to stop them). Exit code 1 of `git config --get-regexp` means "no match".
 * **`timeoutMs` is the deadline for the preliminary step and the real call combined** (code-review wave 41: before, the whole was passed to both, effectively doubling it).
 */
export async function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunOutput> {
  const command = options.gitCommand ?? 'git'
  if (options.allowRepoFilters === true) {
    return execGit(command, args, gitEnv(process.env, [], true), options, options.maxBuffer, options.timeoutMs)
  }
  const deadline = Date.now() + options.timeoutMs
  const pre = await filterOverridesFor(command, options, deadline)
  if (!('overrides' in pre)) return pre
  const remaining = deadline - Date.now()
  if (remaining <= 0) return timedOut()
  return execGit(command, args, gitEnv(process.env, pre.overrides), options, options.maxBuffer, remaining)
}
