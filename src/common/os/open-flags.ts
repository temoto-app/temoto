/**
 * OS gate for "open without following a symlink" (TODO 1238, ARCHITECTURE 3.5).
 *
 * `fs.constants.O_NOFOLLOW` / `O_NONBLOCK` do not exist on every OS (they are undefined on Windows). Writing
 * `flags | constants.O_NOFOLLOW` there silently ORs in `undefined` (= 0) and the guard disappears. This module
 * decides by *feature presence* (not by OS name) and, when a flag is missing, replaces it with a check that must
 * pass: `lstat` before opening (refuse a symlink / a non-regular file) and a `fstat` dev/ino match afterwards.
 * If neither the flag nor the check can be done, nothing is opened (fail closed).
 *
 * On macOS / Linux both flags exist, so the behaviour is exactly the plain `open(path, flags | O_NOFOLLOW ...)`.
 * No electron import (the index process uses this too, constraint 8.1).
 */
import { constants as fsConstants, closeSync, fstatSync, ftruncateSync, lstatSync, openSync, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'

/** The part of `fs.constants` this module reads. Tests pass a table with flags removed. */
export interface OpenFlagTable {
  O_NOFOLLOW?: number
  O_NONBLOCK?: number
}

/** Which of the two guards the OS gives us as open flags. */
export interface OpenFlagSupport {
  /** `O_NOFOLLOW` is usable (a real, non-zero bit). */
  noFollow: boolean
  /** `O_NONBLOCK` is usable (a real, non-zero bit). */
  nonBlock: boolean
}

export interface OpenNoFollowOptions {
  /** Flag table to read (default `fs.constants`). Tests pass one with flags removed. */
  table?: OpenFlagTable
  /** Add `O_NONBLOCK` (default true, so a FIFO cannot block open). */
  nonBlock?: boolean
  mode?: number
}

function usable(flag: number | undefined): flag is number {
  return typeof flag === 'number' && flag !== 0
}

export function openFlagSupport(table: OpenFlagTable = fsConstants): OpenFlagSupport {
  return { noFollow: usable(table.O_NOFOLLOW), nonBlock: usable(table.O_NONBLOCK) }
}

/**
 * An open that cannot be made safe. `code` mimics the errno the missing flag would have produced:
 * `ELOOP` = a symlink, `EINVAL` = not a regular file. `ECHANGED` (not a real errno) = the path was replaced by
 * something else between the lstat and the open (an editor's rename-save, say) and a retry did not settle it.
 * It is NOT a symlink and NOT "gone": callers must not treat it as either (an index row must survive it).
 */
export class UnsafeOpenError extends Error {
  constructor(
    readonly code: 'ELOOP' | 'EINVAL' | 'ECHANGED',
    message: string
  ) {
    super(message)
    this.name = 'UnsafeOpenError'
  }
}

/** Flag bits to OR into `flags`: only the ones that exist. */
export function guardFlags(table: OpenFlagTable = fsConstants, nonBlock = true): number {
  const support = openFlagSupport(table)
  return (support.noFollow ? (table.O_NOFOLLOW as number) : 0) | (nonBlock && support.nonBlock ? (table.O_NONBLOCK as number) : 0)
}

interface Plan {
  bits: number
  support: OpenFlagSupport
  nonBlock: boolean
  /** A flag is missing, so the lstat / fstat check must run. */
  manual: boolean
  /** O_CREAT: the file may not exist yet. */
  creating: boolean
  /** O_TRUNC was asked for. The manual path truncates only after the checks pass. */
  truncating: boolean
}

function plan(flags: number, options: OpenNoFollowOptions): Plan {
  const table = options.table ?? fsConstants
  const nonBlock = options.nonBlock ?? true
  const support = openFlagSupport(table)
  return {
    bits: guardFlags(table, nonBlock),
    support,
    nonBlock,
    manual: !support.noFollow || (nonBlock && !support.nonBlock),
    // O_CREAT exists on every OS; read it from the real table even when a test swaps the guard flags out.
    creating: (flags & fsConstants.O_CREAT) !== 0,
    truncating: (flags & fsConstants.O_TRUNC) !== 0
  }
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

/**
 * Flags for the manual path, where open() itself would follow a symlink. Nothing may be created or emptied
 * through a link before the checks have run:
 * - the path exists: drop O_CREAT and O_TRUNC (truncate through the verified descriptor afterwards);
 * - the path is missing (only allowed with O_CREAT): add O_EXCL, which fails on anything that appeared in
 *   between, a dangling symlink included.
 */
function manualFlags(flags: number, exists: boolean): number {
  if (exists) return flags & ~fsConstants.O_CREAT & ~fsConstants.O_TRUNC & ~fsConstants.O_EXCL
  return (flags | fsConstants.O_EXCL) & ~fsConstants.O_TRUNC
}

function refuseExclusive(flags: number, exists: boolean): void {
  if (exists && (flags & fsConstants.O_CREAT) !== 0 && (flags & fsConstants.O_EXCL) !== 0) {
    const err = new Error('file already exists') as NodeJS.ErrnoException
    err.code = 'EEXIST'
    throw err
  }
}

// All stats on the manual path are bigint: an NTFS file id is 64 bits and loses precision as a `Number`.
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  // ino 0 means the OS gives no usable identity: a dev / ino comparison would prove nothing.
  return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino
}

function checkBefore(before: BigIntStats, p: Plan): void {
  if (!p.support.noFollow && before.isSymbolicLink()) throw new UnsafeOpenError('ELOOP', 'refusing to open a symlink')
  // Without O_NONBLOCK a FIFO would block open() forever: only a regular file may reach it.
  if (p.nonBlock && !p.support.nonBlock && !before.isFile()) throw new UnsafeOpenError('EINVAL', 'not a regular file')
}

function checkAfter(before: BigIntStats | null, opened: BigIntStats, current: BigIntStats | null): void {
  if (current === null) throw new UnsafeOpenError('ECHANGED', 'cannot verify the opened file')
  if (current.isSymbolicLink()) throw new UnsafeOpenError('ELOOP', 'refusing to open a symlink')
  if (!sameFile(opened, current) || (before !== null && !sameFile(before, opened))) {
    throw new UnsafeOpenError('ECHANGED', 'the path changed while opening')
  }
}

/** One retry is allowed, and only for an existing file (a create with O_EXCL must not run twice). */
function retryable(err: unknown, before: BigIntStats | null, attempt: number): boolean {
  return attempt === 0 && before !== null && err instanceof UnsafeOpenError && err.code === 'ECHANGED'
}

/** `openSync(path, flags | O_NOFOLLOW | O_NONBLOCK)`; a manual check replaces any flag the OS lacks. */
export function openNoFollowSync(path: string, flags: number, options: OpenNoFollowOptions = {}): number {
  const p = plan(flags, options)
  if (!p.manual) return openSync(path, flags | p.bits, options.mode)
  for (let attempt = 0; ; attempt++) {
    let before: BigIntStats | null = null
    try {
      before = lstatSync(path, { bigint: true })
    } catch (err) {
      // Missing is fine only when creating; any other failure opens nothing.
      if (!(p.creating && isMissing(err))) throw err
    }
    if (before !== null) {
      refuseExclusive(flags, true)
      checkBefore(before, p)
    }
    const fd = openSync(path, manualFlags(flags, before !== null) | p.bits, options.mode)
    try {
      let current: BigIntStats | null = null
      try {
        current = lstatSync(path, { bigint: true })
      } catch {
        current = null
      }
      checkAfter(before, fstatSync(fd, { bigint: true }), current)
      if (before !== null && p.truncating) ftruncateSync(fd, 0)
      return fd
    } catch (err) {
      closeSync(fd)
      if (retryable(err, before, attempt)) continue
      throw err
    }
  }
}

/** Async twin of `openNoFollowSync` (returns a FileHandle). */
export async function openNoFollow(path: string, flags: number, options: OpenNoFollowOptions = {}): Promise<FileHandle> {
  const p = plan(flags, options)
  if (!p.manual) return open(path, flags | p.bits, options.mode)
  for (let attempt = 0; ; attempt++) {
    let before: BigIntStats | null = null
    try {
      before = await lstat(path, { bigint: true })
    } catch (err) {
      if (!(p.creating && isMissing(err))) throw err
    }
    if (before !== null) {
      refuseExclusive(flags, true)
      checkBefore(before, p)
    }
    const handle = await open(path, manualFlags(flags, before !== null) | p.bits, options.mode)
    try {
      let current: BigIntStats | null = null
      try {
        current = await lstat(path, { bigint: true })
      } catch {
        current = null
      }
      checkAfter(before, await handle.stat({ bigint: true }), current)
      if (before !== null && p.truncating) await handle.truncate(0)
      return handle
    } catch (err) {
      await handle.close().catch(() => undefined)
      if (retryable(err, before, attempt)) continue
      throw err
    }
  }
}
