/**
 * Identity of an external extension (TODO 1227 fix X, security review, ARCHITECTURE 6.2.6). **Independent of electron.**
 *
 * A trigger rule (enabled, and the tool permissions for unattended turns) is tied to the extension's identity at the time it was
 * written (`trigger_rules.owner_identity`). The id, name, author and tool declarations can all be claimed by the extension itself,
 * so main builds the identity from the **contents of the whole extension directory**: plugin-host can read the entire directory
 * (the permission model grants the directory), so the entry file alone would not cover the other files it imports.
 *
 * - Walk in name order (sorted per directory, depth first) and feed an external SHA-256 (`sha256:<hex>`) a **record that can be
 *   read in only one way** (security review: previously the length was placed after the contents, so a tree that embedded a
 *   delimiter and the next record in its contents could hash to the same value as a different tree).
 *   A directory is `D\0<byte length of relative path>\0<relative path>\0`; a file's contents go through a separate SHA-256 and the
 *   record is `F\0<byte length of relative path>\0<relative path>\0<size>\0<32-byte digest>`. A name containing NUL, LF or CR is
 *   refused (null).
 * - **Limits are counted as one total** (security review): all entries (files, directories, symlinks) (`entries`), depth (`depth`)
 *   and bytes read (`bytes`). Entries are counted while reading with `opendir`, so a directory with an enormous number of entries
 *   stops before it is read to the end.
 * - Do not trust the stat `size`: open the file (`O_NOFOLLOW | O_NONBLOCK`, so a FIFO cannot block), check with `fstat` that it is
 *   a regular file, then read at most "remaining budget + 1 byte" (a file that grew between stat and read is also stopped by the budget).
 * - A symlink is resolved with `realpath` (a loop stops with ELOOP); if any points outside the directory, points at a directory, or
 *   is not a regular file, the result is null. Entries that are neither regular files nor directories (FIFO, device, socket) also
 *   give null without being read.
 * - null means "no identity": the rule cannot be enabled and the tool permissions do not pass (the closed side). Reads are async
 *   (`fs/promises`) so main's JS thread is not blocked for long.
 */
import { constants } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { createHash, type Hash } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import { openNoFollow } from '../../common/os/open-flags.js'

export const PLUGIN_IDENTITY_LIMITS = {
  /** Total of files, directories and symlinks. */
  entries: 2_000,
  bytes: 16 * 1024 * 1024,
  depth: 16
} as const

export interface PluginIdentityLimits {
  readonly entries: number
  readonly bytes: number
  readonly depth: number
}

class Refused extends Error {}

const CHUNK = 64 * 1024

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Identity of the whole directory. null if it cannot be read, exceeds a limit, has a symlink pointing outside, or has a special file. */
export async function pluginDirectoryIdentity(
  dir: string,
  limits: PluginIdentityLimits = PLUGIN_IDENTITY_LIMITS
): Promise<string | null> {
  try {
    const root = await realpath(dir)
    const hash = createHash('sha256')
    const budget = { entries: limits.entries, bytes: limits.bytes }
    await walk(root, root, '', 0, limits, budget, hash)
    return `sha256:${hash.digest('hex')}`
  } catch {
    return null
  }
}

async function walk(
  root: string,
  current: string,
  rel: string,
  depth: number,
  limits: PluginIdentityLimits,
  budget: { entries: number; bytes: number },
  hash: Hash
): Promise<void> {
  if (depth > limits.depth) throw new Refused()
  // Even if the directory is swapped for a symlink pointing outside after lstat, do not walk outside.
  if (!within(await realpath(current), root)) throw new Refused()
  const names: string[] = []
  const handle = await opendir(current)
  try {
    for await (const entry of handle) {
      budget.entries -= 1
      if (budget.entries < 0) throw new Refused()
      names.push(entry.name)
    }
  } finally {
    // Close it even if the `for await` is left early (if it is not left early, we have already closed it ourselves).
    await handle.close().catch(() => undefined)
  }
  names.sort()
  for (const name of names) {
    if (name.includes('\u0000') || name.includes('\n') || name.includes('\r')) throw new Refused()
    const full = join(current, name)
    const relPath = rel === '' ? name : `${rel}/${name}`
    const relBytes = Buffer.from(relPath, 'utf8')
    const info = await lstat(full)
    if (info.isDirectory()) {
      hash.update(`D\u0000${relBytes.length}\u0000`).update(relBytes).update('\u0000')
      await walk(root, full, relPath, depth + 1, limits, budget, hash)
      continue
    }
    let target = full
    if (info.isSymbolicLink()) {
      // Resolve the real path (a loop throws ELOOP). Refuse anything pointing outside, and anything pointing at a directory (so the walked range does not grow).
      target = await realpath(full)
      if (!within(target, root)) throw new Refused()
    } else if (!info.isFile()) {
      throw new Refused()
    }
    const { size, digest } = await hashFile(target, budget)
    hash.update(`F\u0000${relBytes.length}\u0000`).update(relBytes).update(`\u0000${size}\u0000`).update(digest)
  }
}

/** Open the file, check it is a regular file, and read only up to the remaining budget + 1 byte. Refuse if that is exceeded. Returns the size and the SHA-256 (32 bytes) of the contents. */
async function hashFile(path: string, budget: { bytes: number }): Promise<{ size: number; digest: Buffer }> {
  const hash = createHash('sha256')
  const file = await openNoFollow(path, constants.O_RDONLY)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Refused()
    const buffer = Buffer.allocUnsafe(CHUNK)
    let total = 0
    for (;;) {
      const want = Math.min(CHUNK, budget.bytes - total + 1)
      if (want <= 0) throw new Refused()
      const { bytesRead } = await file.read(buffer, 0, want, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > budget.bytes) throw new Refused()
      hash.update(buffer.subarray(0, bytesRead))
    }
    budget.bytes -= total
    return { size: total, digest: hash.digest() }
  } finally {
    await file.close().catch(() => undefined)
  }
}
