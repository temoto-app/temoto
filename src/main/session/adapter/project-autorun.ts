/**
 * Finds what runs without confirmation in a first-time folder (hooks / MCP servers) (item 123, ARCHITECTURE 4.3.2 / 4.6.2 (10)).
 *
 * spike 25 (CLI 2.1.280): `-p` has no trust confirmation, and merely starting the process launches the servers of the project's `.mcp.json`
 * and runs SessionStart hooks. aios **only informs** in the creation dialog and does not stop it.
 *
 * - The file names, locations and the keys inside are held by the compat table (`projectAutorun`).
 * - **The choke point is passed in by the caller** (`allowed`). It is applied to each file before `stat` / reading
 *   (merely `stat`-ing under `~/Library` can raise a TCC prompt, the same reason as item 98). Places that fall under an exclusion
 *   (including where credentials live) are not read.
 * - From the contents only the key names (hooks' event names / server names) are taken. Command lines are not read or returned.
 * - Broken JSON is treated as "absent" (the CLI presumably cannot read it either: unmeasured). A file that is too large is treated as
 *   "present" without reading the contents (the contents are unknown, so we lean toward informing).
 */
import { open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProjectAutorunFile, ProjectAutorunReport } from '../types.js'

/** Where the file is. `cwd` = that folder / `repoRoot` = the repository root / `ancestors` = from that folder up to `/`. */
export type ProjectAutorunPlace = 'cwd' | 'repoRoot' | 'ancestors'

export interface ProjectAutorunGroup {
  /** The key to report if it has contents (the value is an object with one or more non-empty keys). */
  readonly key: string
  readonly files: readonly { readonly name: string; readonly at: ProjectAutorunPlace }[]
}

export interface ProjectAutorunTable {
  /** The repository root marker (the nearest ancestor that has an entry with this name is the root). */
  readonly repoMarker: string
  readonly hooks: ProjectAutorunGroup
  readonly mcp: ProjectAutorunGroup
}

/** The read limit. A settings file is normally a few KB. Over it, it is treated as "present" without reading the contents. */
export const MAX_AUTORUN_FILE_BYTES = 256 * 1024
/** Upper bound on returned names (for display). */
export const MAX_AUTORUN_NAMES = 8

/** The directories from `dir` up to `/` (nearest first). */
function ancestorsOf(dir: string): string[] {
  const out: string[] = []
  let current = dir
  for (;;) {
    out.push(current)
    const parent = dirname(current)
    if (parent === current) return out
    current = parent
  }
}

async function exists(path: string, allowed: (path: string) => boolean): Promise<boolean> {
  if (!allowed(path)) return false
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The nearest ancestor (including itself) that has `marker`. Null if none. */
async function findRepoRoot(
  cwd: string,
  marker: string,
  allowed: (path: string) => boolean
): Promise<string | null> {
  for (const dir of ancestorsOf(cwd)) {
    if (await exists(join(dir, marker), allowed)) return dir
  }
  return null
}

/**
 * The names of the keys under `key` in the file. **null = do not report** (absent / broken / empty contents).
 * A file that is too large gives `[]` (the names are unknown, but it exists).
 */
async function readKeyNames(
  path: string,
  key: string,
  allowed: (path: string) => boolean
): Promise<readonly string[] | null> {
  if (!allowed(path)) return null
  // Check that it is a regular file before opening (opening a FIFO blocks until a writer comes).
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    if (info.size > MAX_AUTORUN_FILE_BYTES) return []
  } catch {
    return null
  }
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return null
    if (info.size > MAX_AUTORUN_FILE_BYTES) return []
    const text = await handle.readFile({ encoding: 'utf8' })
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const value = (parsed as Record<string, unknown>)[key]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const names = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== null && entry !== undefined && !(Array.isArray(entry) && entry.length === 0))
      .map(([name]) => name)
    return names.length === 0 ? null : names.slice(0, MAX_AUTORUN_NAMES)
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function locateGroup(
  group: ProjectAutorunGroup,
  cwd: string,
  repoRoot: () => Promise<string | null>,
  allowed: (path: string) => boolean
): Promise<ProjectAutorunFile[]> {
  const found: ProjectAutorunFile[] = []
  const seen = new Set<string>()
  for (const file of group.files) {
    let dirs: string[]
    if (file.at === 'cwd') dirs = [cwd]
    else if (file.at === 'ancestors') dirs = ancestorsOf(cwd)
    else {
      const root = await repoRoot()
      dirs = root === null ? [] : [root]
    }
    for (const dir of dirs) {
      const path = join(dir, file.name)
      if (seen.has(path)) continue
      seen.add(path)
      const names = await readKeyNames(path, group.key, allowed)
      if (names !== null) found.push({ path, names })
    }
  }
  return found
}

/** Searches according to the table. If there is no table, nothing is there. */
export async function locateProjectAutorun(
  table: ProjectAutorunTable | undefined,
  cwd: string,
  allowed: (path: string) => boolean
): Promise<ProjectAutorunReport> {
  if (table === undefined) return { hooks: [], mcp: [] }
  let root: Promise<string | null> | null = null
  const repoRoot = (): Promise<string | null> => (root ??= findRepoRoot(cwd, table.repoMarker, allowed))
  const hooks = await locateGroup(table.hooks, cwd, repoRoot, allowed)
  const mcp = await locateGroup(table.mcp, cwd, repoRoot, allowed)
  return { hooks, mcp }
}
