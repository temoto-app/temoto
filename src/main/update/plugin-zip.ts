/**
 * TODO 1144 stage 2 (wave 73 bundle C, ARCHITECTURE 8.5.1): extract an extension bundle zip (`plugin-<id>-<version>.zip`) into an empty directory.
 *
 * A small reader in main (the plugin code of `aios.zip` / `aios.office` is inside constraint 8, so it is not used. The index process's
 * `ooxml.ts` cannot be imported from main either — constraint 8.1). `ditto` is not used: `../` in names, absolute paths, and symlinks
 * cannot be checked before extraction. **Only a zip whose SHA-256 has been verified is passed in**, but it is still defended on the assumption of a crafted zip:
 *
 *  - Names: reject any that are empty, contain NUL, `\`, a leading `/`, a drive name (`C:`), or a `.` / `..` / empty segment. Also reject two names that are the same after case folding
 *    (the default macOS FS is case-insensitive — a later entry could overwrite an earlier one).
 *  - Kinds: reject symlinks (Unix mode `S_IFLNK`) and anything other than regular files and directories. Encrypted entries, methods other than stored / deflate,
 *    zip64, and multi-disk archives are not read.
 *  - Size: limits on the number of entries, on one entry after extraction, and on the total. Declared sizes can lie, so the extraction limit is applied with the remaining budget, and the declared size and
 *    the CRC-32 are also checked.
 *  - Writing: the destination is an empty directory the caller made. No symlink is ever created, so no intermediate segment can point outside.
 *    Files are written with `wx` (fails if it already exists).
 *
 * If any of these is hit, it throws with the reason code `plugin-update-invalid` (the caller deletes the half-written output along with the staging area).
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { crc32, inflateRaw } from 'node:zlib'
import { reasonError } from '@shared/reason.js'

/** Upper bound on the zip itself (the largest bundled one, aios.pdf, is around 7 MB extracted). */
export const MAX_PLUGIN_ZIP_BYTES = 64 * 1024 * 1024
/** Upper bound on the number of entries (the largest bundled one has around 200). */
export const MAX_PLUGIN_ZIP_ENTRIES = 5000
/** Upper bound on one entry after extraction. */
export const MAX_PLUGIN_ENTRY_BYTES = 64 * 1024 * 1024
/** Upper bound on the total extracted. */
export const MAX_PLUGIN_TOTAL_BYTES = 256 * 1024 * 1024

export interface PluginZipLimits {
  readonly maxZipBytes?: number
  readonly maxEntries?: number
  readonly maxEntryBytes?: number
  readonly maxTotalBytes?: number
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
/** The type bits of a Unix mode. */
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

interface Entry {
  readonly name: string
  readonly directory: boolean
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly size: number
  readonly localOffset: number
}

function invalid(): Error {
  return reasonError('plugin-update-invalid')
}

/**
 * Split a name inside the zip into the segments of a relative path under the destination. Null if it is not allowed. A trailing `/` marks a directory (it does not become a segment).
 */
export function safeEntrySegments(name: string): readonly string[] | null {
  if (name === '' || name.length > 512) return null
  if (name.includes('\0') || name.includes('\\')) return null
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null
  const body = name.endsWith('/') ? name.slice(0, -1) : name
  if (body === '') return null
  const segments = body.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
  }
  return segments
}

function readEntries(buf: Buffer, maxEntries: number): readonly Entry[] {
  if (buf.byteLength < 22) throw invalid()
  let eocd = -1
  const stop = Math.max(0, buf.byteLength - 22 - 0xffff)
  for (let i = buf.byteLength - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw invalid()
  const disk = buf.readUInt16LE(eocd + 4)
  const cdDisk = buf.readUInt16LE(eocd + 6)
  const diskCount = buf.readUInt16LE(eocd + 8)
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  // Multi-disk and zip64 are not read.
  if (disk !== 0 || cdDisk !== 0 || diskCount !== count) throw invalid()
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw invalid()
  if (count > maxEntries) throw invalid()
  if (cdOffset + cdSize > buf.byteLength) throw invalid()
  const entries: Entry[] = []
  const seen = new Set<string>()
  let at = cdOffset
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.byteLength || buf.readUInt32LE(at) !== SIG_CENTRAL) throw invalid()
    const madeBy = buf.readUInt16LE(at + 4)
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const crc = buf.readUInt32LE(at + 16)
    const compressedSize = buf.readUInt32LE(at + 20)
    const size = buf.readUInt32LE(at + 24)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const external = buf.readUInt32LE(at + 38)
    const localOffset = buf.readUInt32LE(at + 42)
    if (at + 46 + nameLength > buf.byteLength) throw invalid()
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength
    // Encrypted (bit 0) and strongly encrypted (bit 6) entries are not read.
    if ((flags & 0x41) !== 0) throw invalid()
    if (method !== 0 && method !== 8) throw invalid()
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw invalid()
    if (safeEntrySegments(name) === null) throw invalid()
    // For entries made on Unix, look at the type in the mode (reject symlinks, devices, FIFOs). A mode of 0 (a writer that does not record it) is a regular entry.
    const directory = name.endsWith('/')
    if (madeBy >> 8 === 3) {
      const type = (external >>> 16) & S_IFMT
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) throw invalid()
      if (type === S_IFDIR && !directory) throw invalid()
      if (type === S_IFREG && directory) throw invalid()
    }
    const folded = (directory ? name.slice(0, -1) : name).toLowerCase()
    if (seen.has(folded)) throw invalid()
    seen.add(folded)
    entries.push({ name, directory, method, crc, compressedSize, size, localOffset })
  }
  return entries
}

function inflateAsync(data: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    inflateRaw(data, { maxOutputLength }, (err, out) => (err === null ? resolvePromise(out) : reject(err)))
  })
}

/**
 * Extract `zipPath` into the empty directory `dest`. Returns the relative paths (`/`-separated) of the files written.
 * A crafted, broken, or oversized zip throws `plugin-update-invalid`.
 */
export async function extractPluginZip(zipPath: string, dest: string, limits: PluginZipLimits = {}): Promise<readonly string[]> {
  const maxZipBytes = limits.maxZipBytes ?? MAX_PLUGIN_ZIP_BYTES
  const maxEntryBytes = limits.maxEntryBytes ?? MAX_PLUGIN_ENTRY_BYTES
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_PLUGIN_TOTAL_BYTES
  // I/O goes through fs/promises (wave 73 review — do not do a 64 MB read and per-entry writes synchronously on main's JS thread).
  // Only the header parsing in memory (`readEntries`) and the CRC are synchronous.
  if ((await stat(zipPath)).size > maxZipBytes) throw invalid()
  const buf = await readFile(zipPath)
  const entries = readEntries(buf, limits.maxEntries ?? MAX_PLUGIN_ZIP_ENTRIES)
  const root = resolve(dest)
  const written: string[] = []
  let total = 0
  for (const entry of entries) {
    const segments = safeEntrySegments(entry.name)
    if (segments === null) throw invalid()
    const target = join(root, ...segments)
    // Even after checking the segments, check once more that the resolved path is inside the destination (a guard against differences in normalization).
    const inside = relative(root, target)
    if (inside === '' || inside.startsWith('..') || inside.startsWith(sep)) throw invalid()
    if (entry.directory) {
      try {
        await mkdir(target, { recursive: true })
      } catch {
        throw invalid()
      }
      continue
    }
    const at = entry.localOffset
    if (at + 30 > buf.byteLength || buf.readUInt32LE(at) !== SIG_LOCAL) throw invalid()
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
    const end = start + entry.compressedSize
    if (end > buf.byteLength) throw invalid()
    const room = Math.min(maxEntryBytes, maxTotalBytes - total)
    if (entry.size > room) throw invalid()
    let out: Buffer
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw invalid()
      out = buf.subarray(start, end)
    } else {
      try {
        out = await inflateAsync(buf.subarray(start, end), Math.max(1, room))
      } catch {
        throw invalid()
      }
    }
    if (out.byteLength !== entry.size || crc32(out) !== entry.crc) throw invalid()
    total += out.byteLength
    try {
      await mkdir(join(root, ...segments.slice(0, -1)), { recursive: true })
      await writeFile(target, out, { flag: 'wx', mode: 0o644 })
    } catch {
      // A file and a directory fighting over a name (`a` and `a/b`), or a second entry with the same name.
      throw invalid()
    }
    written.push(segments.join('/'))
  }
  return written
}
