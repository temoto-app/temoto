/**
 * The restore that spans a restart (TODO 1306, ARCHITECTURE 8.7). Independent of electron (only `node:fs`).
 *
 * A broken DB cannot be swapped under the running services, so restoring is done across a restart:
 *
 * 1. (before the restart, after the user confirmed) main writes a marker `backup-restore.json` in userData: `{ file, moveKey, phase: 'move' }`.
 * 2. (next launch, **before the DB is opened**) `takePendingRestore` first checks that the backup file is still there (if not, the
 *    restore is given up and the DB is left where it was), then renames `aios.db` / `-wal` / `-shm` (and `db.key` when its key
 *    cannot be read) to `<name>.broken-<stamp>`, so nothing is deleted, then rewrites the marker as `phase: 'import'`.
 *    A fresh DB is created by the normal open.
 * 3. (after the services are up) the import of the backup file (TODO 1088's `runImport`). **The marker is rewritten as
 *    `phase: 'importing'` just before the import starts and removed only when it ends `restored`.** While a marker exists, automatic
 *    backups and rotation stay stopped (a fresh or half-filled DB must never push the good generations out). A launch that finds
 *    `importing` does not import again (no duplicate threads): it reports the restore as interrupted, and the user either restores
 *    again (step 2 then moves the half-filled DB aside like any broken one) or keeps the current DB (the marker is removed).
 *
 * The passphrase the user typed for this restore (if any) is sealed by the keychain in `backup-restore.pass` next to the marker
 * (`ipc.ts`), used only by the import, and removed with the marker. The remembered backup passphrase is never changed by a restore.
 *
 * The files are renamed while no connection is open (step 2 is before `openDatabase` and before the index process starts).
 */
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { errorFields, log } from '../../common/logger.js'
import { generationTime } from './generations.js'

export const RESTORE_MARKER_FILE = 'backup-restore.json'
/** The passphrase typed for the pending restore, sealed by the keychain (written by `ipc.ts`, removed with the marker). */
export const RESTORE_PASSPHRASE_FILE = 'backup-restore.pass'

export type RestorePhase = 'move' | 'import' | 'importing'

export interface RestoreMarker {
  readonly version: 1
  /** The backup file to import (absolute path). */
  readonly file: string
  /** Also move `db.key` aside (its key could not be read, so a new key must be created). */
  readonly moveKey: boolean
  readonly phase: RestorePhase
  readonly createdAt: number
}

function markerPath(userDataDir: string): string {
  return join(userDataDir, RESTORE_MARKER_FILE)
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

export function writeRestoreMarker(userDataDir: string, marker: RestoreMarker): void {
  writeAtomic(markerPath(userDataDir), JSON.stringify(marker))
}

/** Removes the marker and the passphrase sealed for it (they live and die together). */
export function removeRestoreMarker(userDataDir: string): void {
  rmSync(join(userDataDir, RESTORE_PASSPHRASE_FILE), { force: true })
  rmSync(markerPath(userDataDir), { force: true })
}

/** Reads the marker. A broken one (or a file that is not one of our generations) is treated as absent and removed. */
export function readRestoreMarker(userDataDir: string): RestoreMarker | null {
  const path = markerPath(userDataDir)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RestoreMarker>
    if (
      raw.version === 1 &&
      typeof raw.file === 'string' &&
      isAbsolute(raw.file) &&
      generationTime(basename(raw.file)) !== null &&
      typeof raw.moveKey === 'boolean' &&
      (raw.phase === 'move' || raw.phase === 'import' || raw.phase === 'importing') &&
      typeof raw.createdAt === 'number'
    ) {
      return raw as RestoreMarker
    }
  } catch (err) {
    log.warn('backup.restore.markerUnreadable', errorFields(err))
  }
  log.warn('backup.restore.markerInvalid', {})
  removeRestoreMarker(userDataDir)
  return null
}

function stampOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

export interface PendingRestore {
  readonly file: string
  readonly moveKey: boolean
  readonly createdAt: number
  /** The previous launch started the import and did not finish it (`phase: 'importing'`): do not import again. */
  readonly interrupted: boolean
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Step 2. Call **before** the DB is opened. Returns the restore to finish after startup, or null if there is no restore pending.
 * If the backup file is gone or moving the files fails, the restore is abandoned (marker removed) and the DB is left where it was.
 */
export function takePendingRestore(
  userDataDir: string,
  names: { readonly dbFile: string; readonly keyFile: string },
  now: number = Date.now()
): PendingRestore | null {
  const marker = readRestoreMarker(userDataDir)
  if (marker === null) return null
  const pending = (interrupted: boolean): PendingRestore => ({
    file: marker.file,
    moveKey: marker.moveKey,
    createdAt: marker.createdAt,
    interrupted
  })
  if (marker.phase === 'import') return pending(false)
  if (marker.phase === 'importing') {
    log.warn('backup.restore.interrupted', { file: marker.file })
    return pending(true)
  }
  // Never move the DB aside for a backup that is not there any more (an external disk that was unplugged, a deleted file).
  if (!regularFile(marker.file)) {
    removeRestoreMarker(userDataDir)
    log.error('backup.restore.fileMissing', { file: marker.file })
    return null
  }
  const suffix = `.broken-${stampOf(now)}`
  const moves: [string, string][] = []
  for (const tail of ['', '-wal', '-shm']) {
    const from = join(userDataDir, `${names.dbFile}${tail}`)
    if (existsSync(from)) moves.push([from, join(userDataDir, `${names.dbFile}${suffix}${tail}`)])
  }
  if (marker.moveKey) {
    const from = join(userDataDir, names.keyFile)
    if (existsSync(from)) moves.push([from, join(userDataDir, `${names.keyFile}${suffix}`)])
  }
  const done: [string, string][] = []
  try {
    for (const [from, to] of moves) {
      renameSync(from, to)
      done.push([from, to])
    }
    writeRestoreMarker(userDataDir, { ...marker, phase: 'import' })
  } catch (err) {
    // Put back what was moved so the DB opens as before, and give up this restore.
    for (const [from, to] of done.reverse()) {
      try {
        renameSync(to, from)
      } catch (undoErr) {
        log.error('backup.restore.undoFailed', { path: to, ...errorFields(undoErr) })
      }
    }
    removeRestoreMarker(userDataDir)
    log.error('backup.restore.moveFailed', errorFields(err))
    return null
  }
  log.info('backup.restore.applied', { file: marker.file, moved: done.length, suffix })
  return pending(false)
}
