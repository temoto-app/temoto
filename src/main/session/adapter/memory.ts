/**
 * Where auto memory lives (item 254, the read exception in ARCHITECTURE.md 4.4.1).
 *
 * The CLI keeps per-working-folder notes in `<transcriptDir>/<encoded cwd>/<memorySubdir>/`
 * (`compat/backend-paths.json`). `[…](memory/xxx.md)` links in answers usually point here, so
 * link resolution (`src/main/fs/link.ts`) uses it as the next candidate after the cwd.
 *
 * - **Encoding**: every non-alphanumeric character becomes `-` (`/Users/me/.x` → `-Users-me--x`).
 *   This matches the names under `projects` on this machine (e.g. `/Users/alice/.aios-ask-…` → `-Users-alice--aios-ask-…`).
 * - **Candidate folders**: the cwd itself, its realpath (spike cleanup hit `/var` → `/private/var`,
 *   see `docs/notes/threads-and-store.md`), the git work tree root, and for a worktree the main
 *   checkout's root. The CLI reads the main root's memory even when it runs in a git worktree (on
 *   this machine a session inside a worktree was handed the main checkout's
 *   `-Users-alice-git-aios/memory/MEMORY.md`).
 * - **Long names**: an encoding over 200 characters may be truncated and extended by the CLI, so we look in
 *   `projects` for a name whose first 200 characters match (only the list of names is read, never contents).
 *
 * **This only lists locations; it does not read.** Whether a path may be read (whether it falls under an
 * exclusion-rule exception) is decided by the caller with `FsAccess.assertAllowed(…, 'read')`. Credentials
 * (`~/.claude/.credentials.json` etc.) are never touched: only the list of names directly under `projects` and a
 * `stat` of whether `memory` is a directory (constraint 2).
 */
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { loadBackendPaths } from './compat.js'

/** Upper bound on the encoded name length (above this, search by prefix match). */
const MAX_ENCODED = 200
/** Upper bound on how many parents to climb (when looking for the git root). */
const MAX_HOPS = 64

/** Working folder → name under `projects`. Every non-alphanumeric character becomes `-`. */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Climbs looking for `.git`; returns the work tree root and (for a worktree) the main checkout's root. */
export function gitRootsOf(start: string): readonly string[] {
  let dir = start
  for (let hops = 0; hops < MAX_HOPS; hops += 1) {
    const dotGit = join(dir, '.git')
    let stats
    try {
      stats = lstatSync(dotGit)
    } catch {
      stats = null
    }
    if (stats?.isDirectory() === true) return [dir]
    if (stats?.isFile() === true) {
      const roots = [dir]
      try {
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
        if (match?.[1] !== undefined) {
          const gitdir = resolve(dir, match[1].trim())
          let common = gitdir
          try {
            common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim())
          } catch {
            // No commondir (submodule etc.): the main root is unknown.
          }
          if (common !== gitdir && basename(common) === '.git') roots.push(dirname(common))
        }
      } catch {
        // An unreadable .git file yields only the work tree root.
      }
      return roots
    }
    const parent = dirname(dir)
    if (parent === dir) return []
    dir = parent
  }
  return []
}

/**
 * Candidate auto memory directories for `cwd` (existing ones only, no duplicates, nearest first).
 * `home` is for tests (defaults to the real home).
 */
export function memoryDirsFor(cwd: string, home: string = homedir()): readonly string[] {
  if (!isAbsolute(cwd)) return []
  const paths = loadBackendPaths()
  const configured = paths.transcriptDir
  const projects = configured.startsWith('~/') ? join(home, configured.slice(2)) : configured
  const subdir = paths.memorySubdir ?? 'memory'

  const roots: string[] = [resolve(cwd)]
  let real: string | null = null
  try {
    real = realpathSync.native(cwd)
    roots.push(real)
  } catch {
    // Keep the name-derived candidates even if the cwd is gone.
  }
  roots.push(...gitRootsOf(real ?? resolve(cwd)))

  const names: string[] = []
  let listing: readonly string[] | null = null
  for (const root of roots) {
    const encoded = encodeProjectDir(root)
    if (encoded.length <= MAX_ENCODED) {
      names.push(encoded)
      continue
    }
    try {
      listing ??= readdirSync(projects)
    } catch {
      listing = []
    }
    const prefix = encoded.slice(0, MAX_ENCODED)
    names.push(...listing.filter((name) => name.startsWith(prefix)))
  }

  const dirs: string[] = []
  for (const name of names) {
    const dir = join(projects, name, subdir)
    if (!dirs.includes(dir) && isDirectory(dir)) dirs.push(dir)
  }
  return dirs
}
