/**
 * Renames a row of the Files tree (TODO 1145, ARCHITECTURE 5.3 / 12.7).
 *
 * **Writing is main only.** The renderer passes only "the original URI and the string in the input field", and this file re-validates all of it:
 *
 * ```
 * type -> name (`checkRenameName`, no `/`) -> the gate on the source (`assertAllowed`) -> the source exists (lstat)
 *    -> the gate on the destination (same parent + new name) -> the destination does not exist (lstat) -> rename
 * ```
 *
 * - **It does not move**: the destination is in the same parent folder as the source. The name cannot contain `/` or `..`.
 * - If the source is a symlink, the link itself is renamed (the target is not touched). `rename(2)` does not follow symlinks.
 *   A symlink pointing outside the allowed range is refused first by the gate (`path-symlink-escape`) (the same as creating and reading).
 * - If the destination already exists, it is refused (`create-exists`). APFS is case-insensitive by default, so as with `a.txt` -> `A.txt`,
 *   if the destination's lstat is the same entity (dev + ino) as the source and the names are equal ignoring case, it passes as a case-only change (a hard-link sibling is
 *   a different item even with the same entity, so it is refused). The gap in which a destination could be placed
 *   between the check and the rename remains (POSIX `rename` overwrites), but only a process of the same user can place it, and it does not go beyond their permissions.
 * - **Does not throw.** A refusal puts a reason code in `RenameEntryResult.reason`. The log has only the path.
 *
 * The index follows via the watcher (`unlink` + `add`). This file does not touch the index tables (constraint 8.1).
 */
import { lstatSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Stats } from 'node:fs'
import { checkRenameName, type RenameEntryResult } from '@shared/new-entry.js'
import type { ReasonCode, ReasonParams } from '@shared/reason.js'
import { pathToUri } from '../../common/uri.js'
import { pathDenialReason } from '../../common/fs-policy.js'
import { log, errorFields } from '../../common/logger.js'
import type { FsAccess } from './access.js'

function denied(code: ReasonCode | string, params?: ReasonParams): RenameEntryResult {
  return { uri: null, reason: code, ...(params === undefined ? {} : { params }) }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** Passes `uri` through the gate. Whether it is a folder for the exclusion rules is decided from the real entry (refused if it does not exist). */
function gateExisting(
  gate: Pick<FsAccess, 'assertAllowed'>,
  uri: string
): { readonly path: string; readonly stats: Stats } | { readonly reason: string } {
  try {
    let path = gate.assertAllowed(uri, false)
    const stats = lstatOrNull(path)
    if (stats === null) return { reason: 'path-not-found' }
    if (stats.isDirectory()) path = gate.assertAllowed(uri, true)
    return { path, stats }
  } catch (err) {
    return { reason: pathDenialReason(err) }
  }
}

/**
 * Whether the destination's lstat is the same item as the source (`a.txt` -> `A.txt` on a case-insensitive FS). When the entity (dev + ino) is the same and **the names are also equal ignoring case and
 * normalization**. Looking at the entity alone would pass a change to a hard-link sibling (`a.txt` and `b.txt` with the same ino) as
 * "the same item" and skip `create-exists` (a review fix. `rename(2)` does
 * nothing and succeeds between two names of the same entity, so nothing changes although it looks changed).
 */
function isSameEntry(existing: Stats, source: Stats, fromName: string, toName: string): boolean {
  const fold = (name: string): string => name.normalize('NFC').toLowerCase()
  return existing.dev === source.dev && existing.ino === source.ino && fold(fromName) === fold(toName)
}

export function renameEntry(gate: Pick<FsAccess, 'assertAllowed'>, uri: unknown, rawName: unknown): RenameEntryResult {
  if (typeof uri !== 'string') return denied('invalid-value', { field: 'uri' })
  if (typeof rawName !== 'string') return denied('invalid-value', { field: 'name' })
  const checked = checkRenameName(rawName)
  if (!checked.ok) return denied(checked.code, checked.params)

  const source = gateExisting(gate, uri)
  if ('reason' in source) return denied(source.reason)
  const { path: from, stats } = source

  const to = join(dirname(from), checked.name)
  if (to === from) return { uri: pathToUri(from), reason: null }
  try {
    gate.assertAllowed(pathToUri(to), stats.isDirectory())
  } catch (err) {
    return denied(pathDenialReason(err))
  }

  const existing = lstatOrNull(to)
  if (existing !== null && !isSameEntry(existing, stats, basename(from), checked.name)) {
    return denied('create-exists', { name: checked.name })
  }
  try {
    renameSync(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    log.warn('fs.rename.failed', { from, to, ...errorFields(err) })
    if (code === 'ENAMETOOLONG') return denied('create-name-too-long', { max: 255 })
    return denied('rename-failed', { code: typeof code === 'string' ? code : 'unknown' })
  }
  log.info('fs.rename.done', { from, to })
  return { uri: pathToUri(to), reason: null }
}
