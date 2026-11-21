/**
 * Creates a new file / folder from the Files tree (TODO 370, wave 20 bundle C, ARCHITECTURE 5.3 / 12.7).
 *
 * **Writing is main only.** The renderer passes only "the parent's URI and the string in the input field", and this file re-validates all of it:
 *
 * ```
 * type -> name (`checkNewEntryName`, the same pure function as the renderer) -> the gate on the parent (`assertAllowed`)
 *    -> the gate on each intermediate and final logical path in turn -> realpath of the parent (create inside the real directory)
 *    -> preview (are the intermediates symlinks / files, does the final one not exist yet) -> create
 * ```
 *
 * - The name is a `/`-separated sequence, and an empty one, `.`, `..`, or one starting with `/` is refused (no way to leave the parent).
 * - **Intermediate elements are checked with lstat, and a symlink is refused** (`path-symlink-escape`). Creation happens only under
 *   the realpath-ed parent, and no symlink is followed on the way, so it always stays inside the realpath-ed parent.
 * - A file is created with `O_CREAT | O_EXCL | O_NOFOLLOW` (if it exists, `EEXIST` -> `create-exists`;
 *   it is not overwritten even if placed between the check and the creation). A folder uses `mkdir` (`EEXIST` if it exists).
 * - If it fails midway, the intermediate folders this call created are removed (if empty) and it returns.
 * - **Does not throw.** A refusal puts a reason code in `CreateEntryResult.reason` (the same shape as `DirectoryListing.reason`).
 *
 * Reflecting the result in the tree after creation (the index rows, the diff to the renderer) is requested by the caller (`ipc/handlers.ts`) from the index process
 * (`IndexClient.noteCreated`). This file does not touch the index tables (constraint 8.1).
 */
import { closeSync, constants, lstatSync, mkdirSync, realpathSync, rmdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Stats } from 'node:fs'
import { checkNewEntryName, type CreateEntryResult, type NewEntryKind } from '@shared/new-entry.js'
import type { ReasonCode, ReasonParams } from '@shared/reason.js'
import { pathToUri } from '../../common/uri.js'
import { pathDenialReason } from '../../common/fs-policy.js'
import { log, errorFields } from '../../common/logger.js'
import type { FsAccess } from './access.js'
import { openNoFollowSync } from '../../common/os/open-flags.js'

/** The result of creating. `created` is the logical paths to tell the index (intermediate folders first, the last one last). */
export interface CreateEntryOutcome extends CreateEntryResult {
  readonly created: readonly string[]
}

function denied(code: ReasonCode | string, params?: ReasonParams): CreateEntryOutcome {
  return { uri: null, reason: code, ...(params === undefined ? {} : { params }), created: [] }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : 'unknown'
}

/** errno -> reason code. `name` is the name of the element that was refused (embedded in the sentence). */
function fromErrno(err: unknown, name: string): CreateEntryOutcome {
  const code = errnoOf(err)
  if (code === 'EEXIST') return denied('create-exists', { name })
  if (code === 'ELOOP') return denied('path-symlink-escape')
  if (code === 'ENOTDIR') return denied('create-not-directory', { name })
  if (code === 'ENAMETOOLONG') return denied('create-name-too-long', { max: 255 })
  return denied('create-failed', { code })
}

/**
 * Creates a file / folder `rawName` inside `parentUri`. The values are accepted as they came from the renderer (`unknown`),
 * and validated here from the type.
 */
export function createEntry(
  gate: Pick<FsAccess, 'assertAllowed'>,
  kind: NewEntryKind,
  parentUri: unknown,
  rawName: unknown
): CreateEntryOutcome {
  if (typeof parentUri !== 'string') return denied('invalid-value', { field: 'parentUri' })
  if (typeof rawName !== 'string') return denied('invalid-value', { field: 'name' })

  const checked = checkNewEntryName(rawName, kind)
  if (!checked.ok) return denied(checked.code, checked.params)
  const segments = checked.segments

  // The parent: the gate (exclusion, non-file:, relative, symlink escape) -> the real directory.
  let parentPath: string
  try {
    parentPath = gate.assertAllowed(parentUri, true)
  } catch (err) {
    return denied(pathDenialReason(err))
  }
  let realParent: string
  try {
    realParent = realpathSync.native(parentPath)
  } catch {
    return denied('path-not-found')
  }
  if (lstatOrNull(realParent)?.isDirectory() !== true) {
    return denied('create-not-directory', { name: basename(parentPath) || parentPath })
  }

  // The intermediate and final logical paths also go through the gate (refuses creating an excluded folder / creating inside one).
  const logical: string[] = []
  for (let i = 0; i < segments.length; i += 1) {
    const path = join(parentPath, ...segments.slice(0, i + 1))
    const last = i === segments.length - 1
    try {
      gate.assertAllowed(pathToUri(path), !last || kind === 'folder')
    } catch (err) {
      return denied(pathDenialReason(err))
    }
    logical.push(path)
  }

  // Preview: before creating anything, check that the intermediates are not symlinks / files and that the final one does not already exist.
  let real = realParent
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string
    const path = join(real, segment)
    const stats = lstatOrNull(path)
    const last = i === segments.length - 1
    if (last) {
      if (stats !== null) return denied('create-exists', { name: segment })
      break
    }
    if (stats === null) break // everything from here on is yet to be created
    if (stats.isSymbolicLink()) return denied('path-symlink-escape')
    if (!stats.isDirectory()) return denied('create-not-directory', { name: segment })
    real = path
  }

  // Create. Intermediate folders are created if absent; if present (including one placed after the preview), re-check that it is not a symlink.
  const made: string[] = []
  const madeLogical: string[] = []
  const undo = (): void => {
    for (const path of [...made].reverse()) {
      try {
        rmdirSync(path)
      } catch {
        // Something was placed inside, or it cannot be removed. Leave it (do not go and delete its contents).
      }
    }
  }
  real = realParent
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string
    const path = join(real, segment)
    try {
      mkdirSync(path)
      made.push(path)
      madeLogical.push(logical[i] as string)
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') {
        undo()
        return fromErrno(err, segment)
      }
      const stats = lstatOrNull(path)
      if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
        undo()
        return stats?.isSymbolicLink() === true
          ? denied('path-symlink-escape')
          : denied('create-not-directory', { name: segment })
      }
    }
    real = path
  }

  const name = segments[segments.length - 1] as string
  const target = join(real, name)
  try {
    if (kind === 'file') {
      const fd = openNoFollowSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, {
        nonBlock: false,
        mode: 0o666
      })
      closeSync(fd)
    } else {
      mkdirSync(target)
    }
  } catch (err) {
    undo()
    log.warn('fs.create.failed', { kind, path: target, ...errorFields(err) })
    return fromErrno(err, name)
  }

  const finalLogical = logical[logical.length - 1] as string
  log.info('fs.create.done', { kind, path: finalLogical, folders: made.length })
  return { uri: pathToUri(finalLogical), reason: null, created: [...madeLogical, finalLogical] }
}
