/**
 * Assembling the launch that enables the CLI's own sandbox (TODO 1106, ARCHITECTURE 4.2.4). The settings key names live only in the compat table's `osSandbox`
 * (constraint 6). This holds only pure functions that build, from the table and aios's allow table, the JSON passed to `flags.settings` and the
 * reference scope passed to `--add-dir`.
 *
 * Measurements (wave 67 spike 37 / wave 68 spike 38, CLI 2.1.317):
 * - Folders under `--add-dir` fall within the sandbox's **writable** scope. Other repositories' `.git/hooks` / `.git/config` / `.mcp.json` inside them
 *   are not protected (protection covers only the cwd). aios passes every folder directly under the home with `--add-dir` (4.4), so as is,
 *   the writable scope would be nearly the whole home.
 * - A folder put in `filesystem.denyWrite` can be read but not written (EPERM even when written from inside the runtime). **But denyWrite beats both the cwd and
 *   the narrower `allowWrite`**: putting in a reference scope that contains the cwd (`~/git` with cwd `~/git/x`) makes the cwd unwritable.
 *
 * So the reference scope is split in three:
 * 1. Those containing the cwd or a writable place (`allowWrite`) → removed from `--add-dir` (the cwd is writable anyway. Once removed, sibling folders are not
 *    writable under the sandbox default. Reading reaches nearly the whole machine under the sandbox default, so Bash is unchanged, and read tools go through the approval entry point, which by default passes automatically).
 * 2. Those inside the cwd or a writable place → left as is (they are writable already).
 * 3. Everything else → passed to `--add-dir` and put in `denyWrite` to make them read-only again.
 */
import { isAbsolute, relative, resolve } from 'node:path'
import type { OsSandboxPolicy } from '@shared/os-sandbox.js'
import type { OsSandboxTable } from './compat.js'
import { expandHome } from '../../home-path.js'

export interface SandboxLaunch {
  /** The JSON string passed to `flags.settings`. */
  readonly settingsJson: string
  /** The reference scope passed to `--add-dir` (what remains after removing those containing the cwd or a writable place). */
  readonly addDirs: readonly string[]
  /** The reference scope made read-only again (for the log count and for tests). */
  readonly denyWrite: readonly string[]
}

/** Whether `child` is the same as `parent` or inside it. Both are absolute paths. */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = target
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i] as string
    const next = node[key]
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      node = next as Record<string, unknown>
    } else {
      const created: Record<string, unknown> = {}
      node[key] = created
      node = created
    }
  }
  const last = path[path.length - 1]
  if (last !== undefined) node[last] = value
}

/**
 * Assembles the launch that enables the sandbox. `allowedDirs` is SpawnOptions' reference scope (it may contain the cwd).
 * The allow table is already normalized by aios's settings (`src/shared/os-sandbox.ts`); it is not reordered here.
 */
export function sandboxLaunch(
  table: OsSandboxTable,
  policy: OsSandboxPolicy,
  cwd: string,
  allowedDirs: readonly string[],
  home: string
): SandboxLaunch {
  const writable = [cwd, ...policy.allowWrite.map((path) => expandHome(path, home))].map((path) => resolve(path))
  const addDirs: string[] = []
  const denyWrite: string[] = []
  for (const dir of allowedDirs) {
    // 1. Contains the cwd or a writable place → do not pass it (putting it in denyWrite would make the whole cwd unwritable).
    if (writable.some((path) => isWithin(path, dir))) continue
    addDirs.push(dir)
    // 2. Inside the cwd or a writable place → writable already. 3. Everything else → made read-only again.
    if (!writable.some((path) => isWithin(dir, path))) denyWrite.push(dir)
  }
  const sandbox = structuredClone(table.template) as Record<string, unknown>
  setPath(sandbox, table.paths.domains, [...policy.allowedDomains])
  setPath(sandbox, table.paths.allowWrite, [...policy.allowWrite])
  if (denyWrite.length > 0) setPath(sandbox, table.paths.denyWrite, denyWrite)
  return { settingsJson: JSON.stringify({ [table.settingsKey]: sandbox }), addDirs, denyWrite }
}

/** Whether a shell tool request carries the "run outside the sandbox" mark (it reaches approve as an ordinary shell request, spike 37). */
export function isUnsandboxedRequest(
  table: OsSandboxTable,
  shellTools: readonly string[],
  toolName: string,
  input: unknown
): boolean {
  if (!shellTools.includes(toolName)) return false
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  return (input as Record<string, unknown>)[table.unsandboxedField] === true
}

/** Whether the diagnostic text of a launch that ended before init says "the sandbox cannot start in this environment". */
export function isSandboxUnavailableText(table: OsSandboxTable, text: string): boolean {
  const lower = text.toLowerCase()
  return table.unavailableSignals.some((signal) => signal !== '' && lower.includes(signal.toLowerCase()))
}
