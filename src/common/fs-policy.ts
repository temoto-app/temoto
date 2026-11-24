/**
 * Path permission check (the `fs` row of ARCHITECTURE.md 7.7; homework from 12.4 / 12.8).
 *
 * **The only implementation that replaces the Phase 1-3 `FsService.assertAllowed`.**
 * In Phase 3 the criterion changed from "inside a scan root" to "does not match the exclusion list"
 * (because the index now covers the whole machine - 12.7); this keeps that criterion as is and
 * Phase 4 adds the **canonical path (realpath) and TOCTOU protection**.
 *
 * The order of checks follows 7.7:
 *
 * ```
 * logical path -> canonical path (realpath) -> policy check -> open(O_NOFOLLOW) -> fstat
 * ```
 *
 * - A symlink in an intermediate component is folded with `realpath` and then checked again.
 * - A symlink as the final component has its folded target run through the policy **once more**.
 *   If it points outside the allowed scope it is denied (7.7).
 * - `open` uses `O_NOFOLLOW`, and the opened fd is `fstat`ed to confirm it is the same file
 *   (dev + ino) as the entity that was checked. A swap between the check and the open is caught.
 */
import { closeSync, fstatSync, lstatSync, realpathSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { ReasonCode } from '@shared/reason.js'
import type { ExclusionRules, PathAccess } from './exclusions.js'
import { classifyAccessOnDisk } from './project-marker.js'

export type { PathAccess } from './exclusions.js'
import { openNoFollowSync, UnsafeOpenError } from './os/open-flags.js'
import { uriToPath } from './uri.js'

/** Upper bound on how many symlinks are followed. Stops loops and wasted stats. */
const MAX_SYMLINK_HOPS = 8

export type DenyReason =
  | 'not-a-file-uri'
  | 'not-absolute'
  | 'excluded'
  | 'symlink-escape'
  | 'outside-grant'
  | 'not-found'
  | 'changed'
  /** TODO 918: not a regular file (FIFO, device, socket). */
  | 'not-regular'

export class PathDenied extends Error {
  constructor(readonly reason: DenyReason) {
    super(reason)
    this.name = 'PathDenied'
  }
}

/** `DenyReason` -> the reason code in `shared/reason.ts` (item 141). */
const DENY_REASON_CODES: Readonly<Record<DenyReason, ReasonCode>> = {
  'not-a-file-uri': 'path-invalid-uri',
  'not-absolute': 'path-not-absolute',
  excluded: 'path-excluded',
  'symlink-escape': 'path-symlink-escape',
  'outside-grant': 'path-outside-grant',
  'not-found': 'path-not-found',
  changed: 'path-changed',
  'not-regular': 'path-not-regular'
}

/** `PathDenied.reason` -> a reason code the renderer can show with `describeReason` (bare, without `aios-reason:`). */
export function pathDenialCode(reason: DenyReason): ReasonCode {
  return DENY_REASON_CODES[reason]
}

/**
 * Turns an exception caught from `assertAllowed` into a string that may be shown to the renderer (item 141).
 * `PathDenied` is converted to a code; anything else returns its `message` as is
 * (a total function for callers that use it generically. To rethrow, use `pathDenialCode` instead).
 */
export function pathDenialReason(err: unknown): string {
  if (err instanceof PathDenied) return pathDenialCode(err.reason)
  return err instanceof Error ? err.message : String(err)
}

export interface ResolvedPath {
  /** The requested logical path. This is what goes into the audit log. */
  readonly logical: string
  /** The path of the entity after folding symlinks. This is what is actually opened. */
  readonly canonical: string
  /** Whether the entity exists. False when creating a new file for writing. */
  readonly exists: boolean
  readonly isDirectory: boolean
  /**
   * dev + ino of the entity `lstat`ed at check time (TODO 861). `openChecked` compares the opened fd against this.
   * null if there is no entity (new file). `bigint` (TODO 1259): an NTFS file id is 64 bits and loses precision as a `Number`.
   */
  readonly identity?: { readonly dev: bigint; readonly ino: bigint } | null
}

/**
 * The permitted scope. An empty `roots` means "anywhere that does not match the exclusion list",
 * which is the default for the aios core (FsService). Always give a plugin `roots`.
 */
export interface PathScope {
  readonly rules: ExclusionRules
  /** Permitted absolute-path roots. An empty array means no scope restriction. */
  readonly roots?: readonly string[]
}

/** `file:` URI -> absolute path. Only the scheme and absoluteness are checked here. */
export function pathFromUri(uri: string): string {
  if (!uri.startsWith('file://')) throw new PathDenied('not-a-file-uri')
  const path = resolve(uriToPath(uri))
  if (!isAbsolute(path)) throw new PathDenied('not-absolute')
  return path
}

/**
 * Whether it matches the exclusion list (4.4.1 / 4.4.2). Only the root `/` is let through, as the entrance to listing.
 * The read exception (`readOnlyIncludes`, item 254) applies only when `access === 'read'`.
 */
function excluded(
  path: string,
  rules: ExclusionRules,
  asDirectory: boolean,
  access: PathAccess
): boolean {
  if (path === '/') return false
  // Only the final name is judged (the owner decision of TODO 1324: no per-level check here). For `build` and the like the
  // parent is looked at once, the same answer as the scan and the watch.
  return classifyAccessOnDisk(path, basename(path), asDirectory, rules, access).excluded
}

/** Whether it is inside any of the permitted roots. Always true if the root set is empty. */
export function insideRoots(path: string, roots: readonly string[] | undefined): boolean {
  if (roots === undefined || roots.length === 0) return true
  return roots.some((root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`))
}

/**
 * Whether `path` is under `dir` (including itself). **This is the one place that decides an approval rule's `scope: 'cwd'`**
 * (T26 / 4.2.1.2). To avoid a second copy of path normalization on the approval side,
 * **it lives in this module of 7.7 and shares `insideRoots`**.
 *
 * The folding follows the same idea as `resolvePath`:
 *
 * - `..` is folded with `resolve`.
 * - **Both sides are realpathed.** With only one side, `<cwd>/link -> /etc` would look "inside".
 *   For a tail that does not exist (a file about to be created), realpath **the nearest existing ancestor**
 *   and append the remaining names.
 * - **A dangling symlink falls to null** (denied). realpath fails on it, so treating it as a
 *   "nonexistent tail" would answer "inside" even when the link target is out of scope.
 * - **Case folding (`foldPath`) is not used.** Folding would make `<cwd>/Proj` and `<cwd>/proj` look like the same
 *   directory on a case-sensitive file system, though they are **different directories**, and widen the scope.
 *   `realpathSync.native` on macOS returns existing components with their on-disk spelling, so matches
 *   on a case-insensitive file system are absorbed correctly by realpath.
 * - Anything that cannot be decided is false = falls to "ask".
 *
 * **TOCTOU is not guaranteed.** After permission is given here, the one that actually writes is the backend's process,
 * and aios holds no fd (there is nothing equivalent to `openChecked`). All that can be stopped is the case where
 * it "already pointed out of scope at the time of the check"; this is a limit of the approval mechanism, not
 * of this function (4.2.1.2).
 */
export function withinDirectory(path: string, dir: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(dir)) return false
  const root = canonicalize(resolve(dir))
  const target = canonicalize(resolve(path))
  if (root === null || target === null) return false
  return insideRoots(target, [root])
}

/** Upper bound on how many times the ancestors of a path are walked up. So it does not loop on an abnormally deep path. */
const MAX_PATH_HOPS = 64

/**
 * The path of the entity. If the tail does not exist, realpath the nearest existing ancestor and append the rest.
 * null on a dangling symlink (cannot decide = the safe side).
 */
function canonicalize(path: string): string | null {
  const rest: string[] = []
  let current = path
  for (let hops = 0; hops < MAX_PATH_HOPS; hops += 1) {
    try {
      const real = realpathSync.native(current)
      if (rest.length === 0) return real
      return `${real === '/' ? '' : real}/${rest.join('/')}`
    } catch {
      // realpath fails either because the path does not exist or because of a dangling symlink. The latter is denied.
      if (statLink(current)?.isSymbolicLink() === true) return null
      const parent = dirname(current)
      if (parent === current) return null
      rest.unshift(basename(current))
      current = parent
    }
  }
  return null
}

/**
 * Folds a logical path to a canonical path and runs both through the policy.
 *
 * Intermediate components are folded with `realpath`. If the folded result points out of scope it is denied
 * (the case where a symlink pointing outside is placed inside an allowed directory).
 */
export function resolvePath(
  path: string,
  scope: PathScope,
  asDirectory: boolean,
  /**
   * What the path is used for (item 254). The default `'write'` has no exceptions. Only **read-only paths** (the Broker's fs reads,
   * serving `aios-res://`, the viewer's reads, link resolution) pass `'read'`, and
   * `readOnlyIncludes` (auto memory `.md`) are let through. The same value is applied to both the logical path and the canonical path,
   * so a symlink inside an exception that points at credentials fails the canonical re-check.
   */
  access: PathAccess = 'write'
): ResolvedPath {
  // Anything that matches an exclusion at the logical path is not let through, wherever the entity is.
  // (even if `~/.ssh/key` is a symlink pointing into the allowed scope, `~/.ssh` is not readable)
  if (excluded(path, scope.rules, asDirectory, access)) throw new PathDenied('excluded')
  if (!insideRoots(path, scope.roots)) throw new PathDenied('outside-grant')

  // Fold the intermediate components. If the parent does not exist, the entity does not either, so return as is.
  let parent: string
  try {
    parent = realpathSync.native(dirname(path))
  } catch {
    return { logical: path, canonical: path, exists: false, isDirectory: false, identity: null }
  }

  let candidate = path === '/' ? '/' : `${parent === '/' ? '' : parent}/${basename(path)}`
  let stat = statLink(candidate)
  let hops = 0
  while (stat !== null && stat.isSymbolicLink() && hops < MAX_SYMLINK_HOPS) {
    // The final component is a symlink. Its folded target is run through the policy **once more** below.
    let next: string
    try {
      next = realpathSync.native(candidate)
    } catch {
      throw new PathDenied('symlink-escape')
    }
    candidate = next
    stat = statLink(candidate)
    hops += 1
  }
  if (stat !== null && stat.isSymbolicLink()) throw new PathDenied('symlink-escape')

  const isDirectory = stat?.isDirectory() ?? asDirectory
  // Re-check the canonical path. **This is the only place that stops an escape through a symlink.**
  if (excluded(candidate, scope.rules, isDirectory, access)) {
    // If the logical path itself is excluded by its real kind (a folder), it is an exclusion, not a symlink escape. A folder such as `node_modules`
    // that the caller applied with `asDirectory: false` slips past the first check on name rules and falls here (wave 33 proxy
    // verification 620-2: the reason for a folder link had become "a symlink pointing out of scope"). It is not let through either way.
    if (isDirectory !== asDirectory && excluded(path, scope.rules, isDirectory, access)) throw new PathDenied('excluded')
    throw new PathDenied('symlink-escape')
  }
  if (!insideRoots(candidate, scope.roots)) throw new PathDenied('symlink-escape')

  return {
    logical: path,
    canonical: candidate,
    exists: stat !== null,
    isDirectory,
    identity: stat === null ? null : { dev: stat.dev, ino: stat.ino }
  }
}

function statLink(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true })
  } catch {
    return null
  }
}

/**
 * Opens a checked path. `O_NOFOLLOW` stops following the final component, and the opened fd is
 * `fstat`ed to confirm it is the same entity that was checked (TOCTOU protection).
 *
 * The caller must always `closeSync`.
 */
export function openChecked(resolved: ResolvedPath, flags: number): number {
  // The comparison baseline is the dev + ino taken **at check time** (resolvePath). With an lstat just before open as the baseline,
  // if an intermediate folder is swapped after the check, both would point at the swapped one and match (TODO 861).
  const before = resolved.identity ?? statLink(resolved.canonical)
  if (before === null) throw new PathDenied('not-found')

  // TODO 918: always add `O_NONBLOCK`. Opening a FIFO for reading blocks `openSync` until a writer arrives, and opening for writing
  // blocks until a reader arrives, which freezes main's JS thread (= every window). With `O_NONBLOCK` a read returns at once and a write
  // returns `ENXIO` if there is no reader. Both are refused by the `fstat().isFile()` right after (same as the index side's `openRegularFile`, 849).
  // `O_NONBLOCK` has no effect on read / write of regular files. Refusing by an lstat before open alone is not enough: if the file is
  // swapped for a FIFO afterwards, open blocks, so this is the only defense.
  let fd: number
  try {
    // TODO 1238: where the OS has no O_NOFOLLOW / O_NONBLOCK the gate does an lstat + fstat check instead, or refuses.
    fd = openNoFollowSync(resolved.canonical, flags)
  } catch (err) {
    if (err instanceof UnsafeOpenError) {
      // ECHANGED = replaced between the check and the open (not a symlink): the same reason as the dev / ino check below.
      throw new PathDenied(err.code === 'EINVAL' ? 'not-regular' : err.code === 'ECHANGED' ? 'changed' : 'symlink-escape')
    }
    if ((err as NodeJS.ErrnoException).code === 'ENXIO') throw new PathDenied('not-regular')
    throw err
  }
  try {
    const after = fstatSync(fd, { bigint: true })
    // If it was swapped between the check and the open, dev / ino change.
    if (after.dev !== before.dev || after.ino !== before.ino) throw new PathDenied('changed')
    if (!after.isFile()) throw new PathDenied('not-regular')
    return fd
  } catch (err) {
    closeSync(fd)
    throw err
  }
}
