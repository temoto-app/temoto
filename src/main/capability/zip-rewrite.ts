/**
 * Swapping parts in a zip (TODO 1212 stage 1, ARCHITECTURE 7.4.9.1). When writing `.xlsx` cells, it recompresses **only the rewritten parts** and
 * copies the other parts **as the original bytes**, down to the local header, the compressed data, and the data descriptor.
 *
 * With a library, "unpack -> rebuild" recompresses even untouched parts (the bytes change even if the contents are the same),
 * and risks dropping unreadable parts or extension fields (spike `docs/notes/spike-1212-xlsx-edit.md`). This reads the central directory
 * and keeps the order of entries, the prefix (such as a self-extracting head), and the zip comment as they are.
 *
 * Unpacking and packing use `node:zlib`'s asynchronous API (it runs on libuv threads) so main's JS thread is not blocked for long.
 * Not handled (reading throws `ZipRewriteError`): zip64, multiple disks, encrypted entries, and compression other than stored / deflate.
 */
import { promisify } from 'node:util'
import { crc32, deflateRaw, inflateRaw } from 'node:zlib'

const inflateRawAsync = promisify(inflateRaw)
const deflateRawAsync = promisify(deflateRaw)

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_DESCRIPTOR = 0x08074b50

/** A zip that cannot be handled. `message` is a reason code (it contains no body). */
export class ZipRewriteError extends Error {}

export interface ZipEntry {
  /** Name inside the zip (no distinction between UTF-8 / CP437; read as UTF-8, not latin1, since OOXML part names are ASCII). */
  readonly name: string
  readonly method: number
  readonly flags: number
  readonly crc: number
  readonly compressedSize: number
  readonly size: number
  readonly localOffset: number
  /** Byte range of the central directory entry (to copy it as it was). */
  readonly centralStart: number
  readonly centralEnd: number
}

export interface ZipArchive {
  readonly bytes: Buffer
  readonly entries: readonly ZipEntry[]
  readonly eocdOffset: number
  readonly centralOffset: number
}

function findEocd(bytes: Buffer): number {
  // The EOCD is the last 22 bytes + a comment (up to 65,535). Search from the end.
  const min = Math.max(0, bytes.length - 22 - 0xffff)
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes.readUInt32LE(i) === SIG_EOCD) return i
  }
  throw new ZipRewriteError('not-a-zip')
}

/** Reads the central directory. */
export function readZip(bytes: Buffer): ZipArchive {
  if (bytes.length < 22) throw new ZipRewriteError('not-a-zip')
  const eocd = findEocd(bytes)
  const disk = bytes.readUInt16LE(eocd + 4)
  const cdDisk = bytes.readUInt16LE(eocd + 6)
  const countOnDisk = bytes.readUInt16LE(eocd + 8)
  const count = bytes.readUInt16LE(eocd + 10)
  const cdSize = bytes.readUInt32LE(eocd + 12)
  const cdOffset = bytes.readUInt32LE(eocd + 16)
  if (disk !== 0 || cdDisk !== 0 || countOnDisk !== count) throw new ZipRewriteError('multi-disk')
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipRewriteError('zip64')
  if (cdOffset + cdSize > eocd) throw new ZipRewriteError('bad-zip')
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let k = 0; k < count; k++) {
    if (p + 46 > eocd || bytes.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipRewriteError('bad-zip')
    const flags = bytes.readUInt16LE(p + 8)
    const method = bytes.readUInt16LE(p + 10)
    const crc = bytes.readUInt32LE(p + 16)
    const compressedSize = bytes.readUInt32LE(p + 20)
    const size = bytes.readUInt32LE(p + 24)
    const nameLen = bytes.readUInt16LE(p + 28)
    const extraLen = bytes.readUInt16LE(p + 30)
    const commentLen = bytes.readUInt16LE(p + 32)
    const diskStart = bytes.readUInt16LE(p + 34)
    const localOffset = bytes.readUInt32LE(p + 42)
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff || diskStart === 0xffff) {
      throw new ZipRewriteError('zip64')
    }
    if ((flags & 0x1) !== 0) throw new ZipRewriteError('encrypted')
    const end = p + 46 + nameLen + extraLen + commentLen
    if (end > eocd) throw new ZipRewriteError('bad-zip')
    const name = bytes.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ name, method, flags, crc, compressedSize, size, localOffset, centralStart: p, centralEnd: end })
    p = end
  }
  return { bytes, entries, eocdOffset: eocd, centralOffset: cdOffset }
}

/** The range of a local entry (header + data + descriptor) and where the data starts. */
function localSpan(zip: ZipArchive, entry: ZipEntry): { readonly start: number; readonly dataStart: number; readonly end: number } {
  const bytes = zip.bytes
  const start = entry.localOffset
  if (start + 30 > bytes.length || bytes.readUInt32LE(start) !== SIG_LOCAL) throw new ZipRewriteError('bad-zip')
  const nameLen = bytes.readUInt16LE(start + 26)
  const extraLen = bytes.readUInt16LE(start + 28)
  const dataStart = start + 30 + nameLen + extraLen
  let end = dataStart + entry.compressedSize
  if ((entry.flags & 0x8) !== 0) {
    // The data descriptor (the signature is optional. zip64 is already refused above).
    end += end + 4 <= bytes.length && bytes.readUInt32LE(end) === SIG_DESCRIPTOR ? 16 : 12
  }
  if (end > bytes.length) throw new ZipRewriteError('bad-zip')
  return { start, dataStart, end }
}

/** Unpacks one entry. Contents over `maxBytes` are not unpacked (zip bomb). */
export async function readEntry(zip: ZipArchive, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
  if (entry.size > maxBytes) throw new ZipRewriteError('part-too-large')
  const span = localSpan(zip, entry)
  const data = zip.bytes.subarray(span.dataStart, span.dataStart + entry.compressedSize)
  let out: Buffer
  if (entry.method === 0) out = Buffer.from(data)
  else if (entry.method === 8) {
    try {
      out = await inflateRawAsync(data, { maxOutputLength: maxBytes })
    } catch {
      throw new ZipRewriteError('bad-zip')
    }
  } else throw new ZipRewriteError('unsupported-method')
  if (out.length !== entry.size || (crc32(out) >>> 0) !== entry.crc >>> 0) throw new ZipRewriteError('bad-crc')
  return out
}

/**
 * Builds a zip in which only the entries in `replacements` (name -> new contents) are deflated again. The other entries stay as the original bytes.
 * An entry to replace must already be in the zip (none are added). Entries in `removals` are dropped (TODO 1212 stage 2: the `calcChain.xml`
 * when a formula was overwritten with a value).
 */
export async function rewriteZip(
  zip: ZipArchive,
  replacements: ReadonlyMap<string, Buffer>,
  removals: ReadonlySet<string> = new Set()
): Promise<Buffer> {
  const names = new Set(zip.entries.map((entry) => entry.name))
  for (const name of replacements.keys()) if (!names.has(name) || removals.has(name)) throw new ZipRewriteError('missing-entry')
  for (const name of removals) if (!names.has(name)) throw new ZipRewriteError('missing-entry')
  const compressed = new Map<string, Buffer>()
  for (const [name, content] of replacements) compressed.set(name, await deflateRawAsync(content, { level: 6 }))

  const bytes = zip.bytes
  // Local entries are written in the original order (by offset). The prefix stays as it is.
  const kept = zip.entries.filter((entry) => !removals.has(entry.name))
  const byOffset = [...kept].sort((a, b) => a.localOffset - b.localOffset)
  // The prefix (such as a self-extracting head) extends to before all entries, so even if the dropped entry is first, its contents are not included in the prefix.
  const first = zip.entries.reduce((min, entry) => Math.min(min, entry.localOffset), zip.centralOffset)
  const parts: Buffer[] = [bytes.subarray(0, first)]
  let offset = first
  const newOffsets = new Map<ZipEntry, number>()
  const newCentralFields = new Map<ZipEntry, { crc: number; compressedSize: number; size: number; flags: number }>()
  for (const entry of byOffset) {
    newOffsets.set(entry, offset)
    const replacement = replacements.get(entry.name)
    const data = compressed.get(entry.name)
    if (replacement === undefined || data === undefined) {
      const span = localSpan(zip, entry)
      const raw = bytes.subarray(span.start, span.end)
      parts.push(raw)
      offset += raw.length
      continue
    }
    const span = localSpan(zip, entry)
    const nameLen = bytes.readUInt16LE(span.start + 26)
    const nameBytes = bytes.subarray(span.start + 30, span.start + 30 + nameLen)
    // The descriptor is not used (the sizes are written first). The UTF-8 name flag (bit 11) is kept.
    const flags = entry.flags & ~0x8 & 0xffff
    const crc = crc32(replacement) >>> 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(SIG_LOCAL, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(8, 8)
    // The time stays as it was (bytes 10 to 13 of the local header).
    bytes.copy(header, 10, span.start + 10, span.start + 14)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(replacement.length, 22)
    header.writeUInt16LE(nameLen, 26)
    header.writeUInt16LE(0, 28)
    parts.push(header, nameBytes, data)
    offset += header.length + nameBytes.length + data.length
    newCentralFields.set(entry, { crc, compressedSize: data.length, size: replacement.length, flags })
  }
  const centralStart = offset
  for (const entry of kept) {
    const central = Buffer.from(bytes.subarray(entry.centralStart, entry.centralEnd))
    const changed = newCentralFields.get(entry)
    if (changed !== undefined) {
      central.writeUInt16LE(Math.max(central.readUInt16LE(6), 20), 6)
      central.writeUInt16LE(changed.flags, 8)
      central.writeUInt16LE(8, 10)
      central.writeUInt32LE(changed.crc, 16)
      central.writeUInt32LE(changed.compressedSize, 20)
      central.writeUInt32LE(changed.size, 24)
    }
    central.writeUInt32LE(newOffsets.get(entry) ?? 0, 42)
    parts.push(central)
    offset += central.length
  }
  const eocd = Buffer.from(bytes.subarray(zip.eocdOffset))
  if (kept.length !== zip.entries.length) {
    eocd.writeUInt16LE(kept.length, 8)
    eocd.writeUInt16LE(kept.length, 10)
  }
  eocd.writeUInt32LE(offset - centralStart, 12)
  eocd.writeUInt32LE(centralStart, 16)
  parts.push(eocd)
  if (offset > 0xfffffff0) throw new ZipRewriteError('zip64')
  return Buffer.concat(parts)
}
