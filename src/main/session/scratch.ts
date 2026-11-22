/**
 * The scratch area of a throwaway thread, `~/<data name>/scratch/<threadId>/` (T19 / TODO 24, ARCHITECTURE.md 4.3.2; the data name is TODO 1263).
 *
 * This file has **pure functions only**. Creating and deleting the directory is done by SessionManager;
 * this module only decides "where" and "whether it may be deleted".
 *
 * - The location is a **visible place under the home**. Under `~/Library` it would hit the exclusion rules (4.4.2),
 *   and `assertAllowed` would reject it so the app could not open its own scratch area.
 * - `isScratchCwd` is true **only for exactly one level below the root, with the same name as the thread id**.
 *   `remove` deletes the whole contents only when this is true, so the root itself, two levels down,
 *   a prefix-match false hit like `~/aios/scratchy/...`, and a thread that picked another thread's scratch area
 *   (possible via "choose another folder...") are never deleted.
 */
import { join, resolve, sep } from 'node:path'
import { foldPath } from '../../common/uri.js'
import { homeDataDir } from '../../common/app-identity.js'

/** The folder under `~/<data name>/` that holds the scratch areas. */
export const SCRATCH_FOLDER = 'scratch'

/**
 * The scratch root `~/<data name>/scratch` (TODO 1263: `~/Temoto/scratch` on a new machine, `~/aios/scratch` where the legacy userData
 * exists; `src/common/app-identity.ts`). `dataName` is for tests; main uses the identity fixed at launch.
 */
export function scratchRoot(home: string, dataName?: string): string {
  return join(homeDataDir(home, dataName), SCRATCH_FOLDER)
}

/**
 * A thread's new scratch area `<root>/<threadId>`. `ownRoot` is the root of a profile that is not the default userData (TODO 1314:
 * `<userData>/scratch`, so a verification build never shares the real instance's root); without it the root is `~/<data name>/scratch`.
 */
export function scratchCwd(home: string, threadId: string, ownRoot?: string): string {
  return join(ownRoot ?? scratchRoot(home), threadId)
}

/** The roots whose children count as scratch areas for display and protection: the shared one under the home, plus this profile's own. */
function knownRoots(home: string, ownRoot?: string): string[] {
  const roots = [foldPath(resolve(scratchRoot(home)))]
  if (ownRoot !== undefined) roots.push(foldPath(resolve(ownRoot)))
  return roots
}

/** The child name when `cwd` is exactly one level below `root` (both already folded), else null. */
function childName(root: string, folded: string): string | null {
  if (!folded.startsWith(root + sep)) return null
  const rest = folded.slice(root.length + sep.length)
  return rest !== '' && !rest.includes(sep) ? rest : null
}

/**
 * Whether `cwd` is **exactly one level below** the scratch root (regardless of which thread it belongs to).
 *
 * This is the "no prefix-match false hits" check of `isScratchCwd`, pulled out. Deriving the display name
 * (`threadCwdName`, T18) is also called from places that have no thread id - even for a thread that picked another thread's
 * scratch area we do not want to show the UUID, so this is used.
 */
export function isScratchChild(home: string, cwd: string, ownRoot?: string): boolean {
  const folded = foldPath(resolve(cwd))
  return knownRoots(home, ownRoot).some((root) => childName(root, folded) !== null)
}

function isNamedChild(roots: readonly string[], cwd: string, threadId: string): boolean {
  if (threadId === '' || threadId.includes(sep) || threadId === '.' || threadId === '..') return false
  const folded = foldPath(resolve(cwd))
  return roots.some((root) => childName(root, folded) === foldPath(threadId))
}

/**
 * Whether `cwd` is the scratch area of thread `threadId` itself, under either known root.
 * Not a prefix match but an **exact match** with "root + separator + threadId" (after normalization, a trailing `/` is ignored).
 * Used for protection and display; **deletion uses `isOwnScratchCwd`**.
 */
export function isScratchCwd(home: string, cwd: string, threadId: string, ownRoot?: string): boolean {
  return isNamedChild(knownRoots(home, ownRoot), cwd, threadId)
}

/**
 * Like `isScratchCwd`, but only for **this profile's own root** (`ownRoot`, else the one under the home). What may be created, emptied
 * and deleted: a copied profile's rows can point into the real instance's root, and removing such a conversation must not delete
 * the real instance's files (TODO 1314).
 */
export function isOwnScratchCwd(home: string, cwd: string, threadId: string, ownRoot?: string): boolean {
  return isNamedChild([foldPath(resolve(ownRoot ?? scratchRoot(home)))], cwd, threadId)
}

/**
 * The shape of a scratch area name (T23). True only for the 8-4-4-4-12 hex that `randomUUID()` produces.
 * **The version (start of the third group) is not checked** - existing tests use ids that are not v4,
 * and even if the way thread ids are made changes, it is better that they do not drop out of the cleanup targets.
 *
 * The condition exists so that nothing is deleted when a person puts a folder by hand under `~/aios/scratch/` (for example one named with the Japanese word for "memo").
 */
const SCRATCH_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Whether the name has the scratch area shape (a UUID). Case does not matter. */
export function isScratchDirName(name: string): boolean {
  return SCRATCH_NAME.test(foldPath(name))
}

/** One entry directly under the scratch root. The shape for passing the `readdir` result to the cleanup decision. */
export interface ScratchRootEntry {
  /** Name directly under the root (not a path). */
  readonly name: string
  /** Whether it is a directory. A symlink is naturally excluded because `Dirent.isDirectory()` is false for it. */
  readonly isDirectory: boolean
  /** Whether it is empty directly under it. False is fine if it is not a directory. */
  readonly isEmpty: boolean
}

/**
 * **The list of scratch area names that may be swept** (T23, ARCHITECTURE.md 4.3.2). A pure function.
 *
 * It is true only for entries that satisfy **all three**:
 *
 * 1. A **directory exactly one level below** the root (the caller only does one `readdir` of the root,
 *    so anything two levels down structurally cannot be a candidate. A symlink is excluded too because `isDirectory` is false)
 * 2. The name has the **scratch area shape (a UUID)** and **matches no live thread's id**
 * 3. **Empty**
 *
 * Anything with contents might be something the user meant to throw away but now wants to keep, so it is never touched.
 * `SessionManager` does the actual deletion. This module does not touch directories.
 */
export function sweepableScratchDirs(
  entries: readonly ScratchRootEntry[],
  knownThreadIds: Iterable<string>
): readonly string[] {
  const known = new Set<string>()
  for (const id of knownThreadIds) known.add(foldPath(id))
  const sweepable: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.isEmpty) continue
    if (!isScratchDirName(entry.name)) continue
    if (known.has(foldPath(entry.name))) continue
    sweepable.push(entry.name)
  }
  return sweepable
}
