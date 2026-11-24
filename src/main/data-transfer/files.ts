/**
 * The files of export and import (TODO 1318, ARCHITECTURE 8.6 / 8.7). Independent of electron; tests pass an in-memory twin.
 *
 * - **Export streams into a file that is not yet the result.** `createNew` writes the path itself, created exclusively
 *   (`O_CREAT | O_EXCL`, no-follow through the OS gate `openNoFollow`, mode 0600): the automatic backup's `.partial`, which the backup
 *   renames itself. `replace` (the manual export, which overwrites the file picked in the save dialog) writes a fresh hidden temporary
 *   file next to the target, created the same way, and renames it over the target only after it is complete. Either way only
 *   ciphertext is on disk (the sealer's output), the data is fsynced through the one descriptor before it is closed, and a failure, a
 *   stop or a quit removes what was written (`discard`) - never the target, and never anything that replaced our file at the path
 *   (the device / inode is compared first). A crash midway can leave the hidden temporary file; its name ends in `.partial`, so it is
 *   never offered by the import dialog (`.aiosdata`) nor taken for a backup generation (`generations.ts` matches exact names only).
 * - **`replace` keeps what overwriting in place used to give** (review X of TODO 1318): a chosen path that is a symlink is resolved
 *   once and the file it points to is replaced (the link stays, e.g. one into a synced folder); an existing file keeps its permission
 *   bits (a new one is 0600, as before); and when no temporary file can be created beside the target (a folder without the right to
 *   create in it, a read-only volume: `EACCES` / `EPERM` / `EROFS`) it falls back to writing the target in place, as before TODO 1318
 *   (only ciphertext; a failure midway can leave a partly written target, which the old in-place write could too).
 * - **Import reads one descriptor at fixed positions** (`openRead`): both passes of an import read the same open file, so nothing can
 *   swap the file between them by renaming another one into the path. The size is the one seen when it was opened. The path is opened
 *   **once** (no-follow, so a symlink is refused; non-blocking, so a FIFO cannot hold the open) and only then checked, on the
 *   descriptor, to be a regular file - there is no check on the path before the open for a swap to slip past.
 */
import { constants as fsConstants } from 'node:fs'
import { lstat, readlink, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { openNoFollow } from '../../common/os/open-flags.js'
import type { SealSink, SealSource } from './crypto.js'

/** A file being written by an export. */
export interface ExportWriter extends SealSink {
  /** fsync, close and (for `replace`) rename over the target. After it resolves the file is complete under its final name. */
  commit(): Promise<void>
  /** Closes and removes what was written, unless committed. Never throws. */
  discard(): Promise<void>
}

/** A file being read by an import (one descriptor for every pass). */
export interface ImportReader extends SealSource {
  close(): Promise<void>
}

export interface TransferFiles {
  /** Writes `path` itself, created exclusively (an entry already there, a symlink included, is an error). */
  createNew(path: string): Promise<ExportWriter>
  /** Writes a temporary file next to `path` (or the file a symlink there points to) and renames it over that on commit. */
  replace(path: string): Promise<ExportWriter>
  openRead(path: string): Promise<ImportReader>
}

/**
 * The name of `replace`'s temporary file: hidden, random (not plantable in advance), not ending in `.aiosdata`, and of a fixed length
 * (the chosen name is not repeated, so a long one cannot push it over the file system's name limit).
 */
export function temporaryPathFor(path: string): string {
  return join(dirname(path), `.aios-export-${randomBytes(8).toString('hex')}.partial`)
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
}

function notRegular(): Error {
  return Object.assign(new Error('data-transfer: not a regular file'), { code: 'EINVAL' })
}

/** Creating a file beside the target is not allowed there (no right to create in the folder, or a read-only volume). */
function cannotCreateBeside(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null)
    offset += bytesWritten
  }
}

/**
 * Writes `path`, created exclusively (no-follow, 0600). On commit it is given `mode` when one is set (the permission bits of the file
 * it replaces), fsynced, closed and, when `target` is set, renamed over `target`.
 */
async function createWriter(path: string, target: string | null, mode: number | null = null): Promise<ExportWriter> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
  const handle = await openNoFollow(path, flags, { mode: 0o600, nonBlock: false })
  let identity: BigIntStats
  try {
    identity = await handle.stat({ bigint: true })
  } catch (err) {
    await handle.close().catch(() => undefined)
    await rm(path, { force: true }).catch(() => undefined)
    throw err
  }
  let closed = false
  let committed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await handle.close()
  }
  return {
    write: (chunk) => writeAll(handle, chunk),
    async commit() {
      // Only once every byte is written: while it is being written the temporary file stays 0600.
      if (mode !== null) await handle.chmod(mode)
      await handle.sync()
      await close()
      if (target !== null) await rename(path, target)
      committed = true
    },
    async discard() {
      if (committed) return
      await close().catch(() => undefined)
      try {
        const current = await lstat(path, { bigint: true })
        // Only the file this writer created: something renamed into the path meanwhile is left alone.
        if (current.isFile() && (identity.ino === 0n || sameFile(identity, current))) await rm(path, { force: true })
      } catch {
        // Already gone.
      }
    }
  }
}

/**
 * Writes the target itself, in place: the fallback of `replace` where no temporary file can be created beside it, the same as the
 * export before TODO 1318 (`writeFile(path, data, { mode: 0o600 })`). Truncated at open; a new file is 0600, an existing one keeps its
 * mode. `discard` only closes: the target was already truncated, and a folder that refused the temporary file would refuse removing too.
 */
async function inPlaceWriter(target: string): Promise<ExportWriter> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
  // Non-blocking, so a FIFO swapped in at the target cannot hold the open; it is then refused by the descriptor's type.
  const handle = await openNoFollow(target, flags, { mode: 0o600 })
  try {
    if (!(await handle.stat()).isFile()) throw notRegular()
  } catch (err) {
    await handle.close().catch(() => undefined)
    throw err
  }
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await handle.close()
  }
  return {
    write: (chunk) => writeAll(handle, chunk),
    async commit() {
      await handle.sync()
      await close()
    },
    async discard() {
      await close().catch(() => undefined)
    }
  }
}

/**
 * Where `replace` writes: the chosen path or, when it is a symlink, the file it points to, resolved once here (a dangling link: the
 * file it names, which will be created - writing through the link used to create it). With the permission bits of the existing file,
 * or null for a new one.
 */
async function replaceTarget(path: string): Promise<{ readonly target: string; readonly mode: number | null }> {
  let info
  try {
    info = await lstat(path)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { target: path, mode: null }
    throw err
  }
  let target = path
  if (info.isSymbolicLink()) {
    try {
      target = await realpath(path)
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err
      return { target: resolve(dirname(path), await readlink(path)), mode: null }
    }
    info = await lstat(target)
  }
  if (!info.isFile()) throw notRegular()
  return { target, mode: info.mode & 0o777 }
}

async function replaceWriter(path: string): Promise<ExportWriter> {
  const { target, mode } = await replaceTarget(path)
  try {
    return await createWriter(temporaryPathFor(target), target, mode)
  } catch (err) {
    if (!cannotCreateBeside(err)) throw err
    return inPlaceWriter(target)
  }
}

export const nodeTransferFiles: TransferFiles = {
  createNew: (path) => createWriter(path, null),
  replace: replaceWriter,
  async openRead(path) {
    // One open, no-follow and non-blocking; then the type of what was actually opened, through the descriptor.
    const handle = await openNoFollow(path, fsConstants.O_RDONLY)
    let size: number
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw notRegular()
      size = info.size
    } catch (err) {
      await handle.close().catch(() => undefined)
      throw err
    }
    return {
      size,
      async read(position, length) {
        const buffer = Buffer.allocUnsafe(length)
        let got = 0
        while (got < length) {
          const { bytesRead } = await handle.read(buffer, got, length - got, position + got)
          if (bytesRead === 0) break
          got += bytesRead
        }
        return got === length ? buffer : buffer.subarray(0, got)
      },
      close: () => handle.close()
    }
  }
}

/** A write or a database write failed for lack of space (`ENOSPC` / `EDQUOT`, SQLite's `SQLITE_FULL`). */
export function isDiskFull(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'ENOSPC' || code === 'EDQUOT' || code === 'SQLITE_FULL'
}
