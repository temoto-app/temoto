/**
 * Shared helper for reading files bundled with the app (used by Help's `help.ts` and the changelog's `release-notes.ts`).
 * Does not import electron. These are not the user's files, so it does not go through `FsAccess`; it has only the check that the realpath is inside the root and a size limit.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

/** Whether the target is inside `root` even after realpath. `root` itself is not counted as inside. */
export function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Reads up to the limit. null if it is not a regular file or exceeds the limit. Throws if it cannot be opened. */
export function readCapped(path: string, maxBytes: number): string | null {
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) return null
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, offset)
      if (read === 0) break
      offset += read
    }
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    closeSync(fd)
  }
}
