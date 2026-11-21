/**
 * Read a zip's central directory and extract one entry (TODO 905, ARCHITECTURE.md 7.4.11). A pure reader that depends on neither the DOM nor a port —
 * given just a `RangeSource` (range reads), tests can call it directly.
 *
 * **It never reads the whole file at once**: it reads by range, in the order of the end (EOCD, with a comment of up to 64 KB) -> (for zip64) EOCD64 -> the central
 * directory, and reads an entry's local header and compressed data only when that entry is opened. **Nothing is written to disk** (the extracted
 * contents are only handed by the caller to a temporary view).
 *
 * Defenses:
 *  - zip slip: names with `../`, an absolute path, a drive name, `\` or control characters get `unsafeName` set and are shown **as they are**. There is no
 *    write destination so no harm is done, but the extension is taken only from the last element (`baseName`).
 *  - zip bomb: an upper limit on the size to open (`MAX_OPEN_ENTRY_BYTES`), an upper limit on the compression ratio (`MAX_COMPRESSION_RATIO`), stopping if the data grows past what was declared
 *    (unzipping counts as a stream), an upper limit on the number of listed entries (`MAX_LISTED_ENTRIES`), and a read limit for the central directory.
 *  - Encrypted entries (the traditional ZipCrypto = flag bit 0, and AES = method 99) open if a password is given (TODO 1151, `zip-crypto.ts`).
 *    Without a password it is `encrypted`, and with a wrong one `wrong-password`.
 *  - Name encoding: guessed in the order UTF-8 flag (bit 11) -> Info-ZIP's Unicode Path (0x7075) -> valid UTF-8 (macOS's
 *    Archive Utility does not set the flag) -> Shift_JIS (Japanese Windows) -> CP437.
 *  - zip64 (EOCD64 and the 0x0001 extra field), and the offset of a zip with other data in front (a self-extracting format).
 */

import { MAX_TRANSIENT_FILE_NAME } from '@shared/plugin.js'
import { transientFileBaseName } from '@shared/transient-file.js'
import { crc32 } from './crc32.js'

export { crc32 }
import { CryptoFailure, ZIPCRYPTO_HEADER, aesDecrypt, aesOverhead, parseAesExtraBody, zipCryptoDecrypt, type AesInfo } from './zip-crypto.js'

/** The entry point for range reads. `read` returns exactly `[offset, offset + length)` (it throws if short). */
export interface RangeSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

/** The upper limit on the number of entries in the list. A zip with more shows only this many from the start (`truncated`). */
export const MAX_LISTED_ENTRIES = 10_000
/** The upper limit for reading the central directory (bytes). If it is larger, only this much from the start is read and the list is cut. */
export const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024
/**
 * The upper limit on the expanded size when opening one entry (bytes). The same value as the limit for passing to a temporary view (`MAX_TRANSIENT_FILE_BYTES`)
 * (plugins can read the values of `@shared`, but the name is placed so the meaning of the limit can also be read on the zip side).
 */
export const MAX_OPEN_ENTRY_BYTES = 64 * 1024 * 1024
/** The upper limit of the compression ratio (expanded / compressed). It is not applied to small entries below `RATIO_CHECK_MIN_BYTES` (small text that is mostly blanks). */
export const MAX_COMPRESSION_RATIO = 1000
export const RATIO_CHECK_MIN_BYTES = 1024 * 1024

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const EOCD_SIZE = 22
const MAX_COMMENT = 0xffff
const LOCATOR_SIZE = 20
const EOCD64_SIZE = 56
const CENTRAL_SIZE = 46
const LOCAL_SIZE = 30

export const METHOD_STORED = 0
export const METHOD_DEFLATE = 8
const METHOD_AES = 99
/** Flag bit 0 = encrypted, bit 6 = strong encryption (unsupported). */
const FLAG_ENCRYPTED = 0x0001
const FLAG_STRONG = 0x0040

export type NameEncoding = 'utf8' | 'unicode-extra' | 'shift_jis' | 'cp437'

export type ZipErrorReason =
  /** Not a zip (there is no EOCD at the end). */
  | 'not-zip'
  /** Broken (the signature does not match, a range is outside the file, the CRC / size does not match, or unzipping failed). */
  | 'corrupt'
  /** A zip split into multiple volumes. */
  | 'spanned'
  /** An encrypted entry. Listing only. */
  | 'encrypted'
  /** A compression other than stored / deflate (bzip2, LZMA, zstd, deflate64, etc.). */
  | 'unsupported-method'
  /** The password does not match (the 1 check byte or the CRC for ZipCrypto, the check value for AES). */
  | 'wrong-password'
  /** An unsupported encryption (strong encryption, or an unknown AES form). */
  | 'unsupported-encryption'
  /** The expanded size exceeds the limit for opening. */
  | 'too-large'
  /** The compression ratio exceeds the limit (suspected zip bomb). */
  | 'suspicious-ratio'
  /** A folder entry. */
  | 'directory'

export class ZipError extends Error {
  constructor(readonly reason: ZipErrorReason, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`)
    this.name = 'ZipError'
  }
}

export interface ZipEntry {
  /** The order within the central directory (0-based). */
  readonly index: number
  /** The name (path) as read with the guessed encoding. **Not normalized** (`../` stays as it is). */
  readonly name: string
  readonly encoding: NameEncoding
  /** The last element from which the extension is taken (split on both `/` and `\`). For a folder, the last non-empty element. */
  readonly baseName: string
  readonly directory: boolean
  readonly encrypted: boolean
  /** The flags of the local header / central directory. */
  readonly flags: number
  /** The DOS modification time (used for the 1 check byte of ZipCrypto). */
  readonly dosTime: number
  /** The 0x9901 extra field of AES (method 99). null if it is not AES. */
  readonly aes: AesInfo | null
  readonly method: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly crc32: number
  /** The position of the local header (after adding the offset at the start). */
  readonly localHeaderOffset: number
  /** The modification time (ms). The extended timestamp (0x5455) if present (UTC); otherwise the DOS date-time read as local time. */
  readonly modifiedMs: number | null
  /** A name containing `../`, an absolute path, a drive name, `\` or control characters (the shape of zip slip). A mark is shown in the display. */
  readonly unsafeName: boolean
}

export interface ZipListing {
  readonly entries: readonly ZipEntry[]
  /** The total the central directory claims. */
  readonly totalEntries: number
  /** The list was cut by the entry-count limit or the central directory limit. */
  readonly truncated: boolean
  readonly zip64: boolean
}

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true)
}

function u32(view: DataView, at: number): number {
  return view.getUint32(at, true)
}

function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('corrupt', 'u64')
  return Number(value)
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

async function readExact(source: RangeSource, offset: number, length: number): Promise<Uint8Array> {
  if (offset < 0 || length < 0 || offset + length > source.size) throw new ZipError('corrupt', 'range')
  if (length === 0) return new Uint8Array(0)
  const bytes = await source.read(offset, length)
  if (bytes.byteLength !== length) throw new ZipError('corrupt', 'short read')
  return bytes
}

// ---- Name encoding ----

/** CP437 0x80 to 0xFF (the DOS default. English-speaking-world zips without a flag). */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

function decodeCp437(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : (CP437_HIGH[byte - 0x80] ?? '�')
  return out
}

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function isAscii(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte >= 0x80) return false
  return true
}

/**
 * Guess the encoding of a name without a flag (when there is no Unicode Path extension). ASCII -> valid UTF-8 -> Shift_JIS -> CP437.
 * A Shift_JIS byte sequence almost never happens to be valid UTF-8 (the second byte would have to be 0x80 to 0xBF every time),
 * so UTF-8 is checked first.
 */
export function decodeEntryName(raw: Uint8Array, utf8Flag: boolean): { name: string; encoding: NameEncoding } {
  if (utf8Flag || isAscii(raw)) return { name: new TextDecoder('utf-8').decode(raw), encoding: 'utf8' }
  const utf8 = tryDecode('utf-8', raw)
  if (utf8 !== null) return { name: utf8, encoding: 'utf8' }
  const sjis = tryDecode('shift_jis', raw)
  if (sjis !== null) return { name: sjis, encoding: 'shift_jis' }
  return { name: decodeCp437(raw), encoding: 'cp437' }
}

// ---- Name shape ----

/**
 * The last element (split on both `/` and `\`; a trailing separator, `.` and `..` are skipped). **The same rule as when the host accepts a temporary view**
 * (`transientFileBaseName` of `@shared/transient-file`) — if it differed, the host would silently drop an entry that looked openable here.
 */
export const baseNameOf = transientFileBaseName

/**
 * Whether the name can be opened as a temporary view (the same condition as the host's `acceptOpenEntry`: there is a last element and it is not too long). An entry with a name that cannot be opened
 * is made unpressable and the reason is shown.
 */
export function isOpenableEntryName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_TRANSIENT_FILE_NAME && transientFileBaseName(name) !== ''
}

/** Whether it is the shape of zip slip (a name that would go outside or point elsewhere if extracted). */
export function isUnsafeEntryName(name: string): boolean {
  // Control characters (including NUL) can fake the display.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return true
  if (name.includes('\\')) return true
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true
  return name.split('/').some((part) => part === '..')
}

// ---- The end (EOCD) ----

interface Directory {
  readonly totalEntries: number
  readonly size: number
  readonly offset: number
  readonly zip64: boolean
  /** The difference between where the central directory actually starts and where it claims to start (a zip with other data in front). */
  readonly shift: number
}

async function findDirectory(source: RangeSource): Promise<Directory> {
  if (source.size < EOCD_SIZE) throw new ZipError('not-zip')
  const tailLength = Math.min(source.size, EOCD_SIZE + MAX_COMMENT + LOCATOR_SIZE)
  const tailStart = source.size - tailLength
  const tail = await readExact(source, tailStart, tailLength)
  const view = viewOf(tail)
  // Search from the back. Prefer the one whose comment length exactly fits the end; if none, the first one found (a zip with a broken comment length).
  let found = -1
  let loose = -1
  for (let at = tail.length - EOCD_SIZE; at >= 0; at--) {
    if (u32(view, at) !== SIG_EOCD) continue
    if (loose < 0) loose = at
    if (at + EOCD_SIZE + u16(view, at + 20) === tail.length) {
      found = at
      break
    }
  }
  if (found < 0) found = loose
  if (found < 0) throw new ZipError('not-zip')
  const eocdAt = tailStart + found
  const disk = u16(view, found + 4)
  const directoryDisk = u16(view, found + 6)
  let totalEntries = u16(view, found + 10)
  let size = u32(view, found + 12)
  let offset = u32(view, found + 16)
  let zip64 = false
  let directoryEnd = eocdAt

  // zip64: if there is a locator right before the EOCD, read the EOCD64 (even if the 16 / 32-bit fields are not saturated, if it is there it is the truth).
  const locatorAt = found - LOCATOR_SIZE
  if (locatorAt >= 0 && u32(view, locatorAt) === SIG_EOCD64_LOCATOR) {
    const { at: eocd64At, bytes: eocd64 } = await readEocd64(source, u64(view, locatorAt + 8), tailStart + locatorAt)
    const v64 = viewOf(eocd64)
    if (u32(v64, 16) !== 0 || u32(v64, 20) !== 0) throw new ZipError('spanned')
    totalEntries = u64(v64, 32)
    size = u64(v64, 40)
    offset = u64(v64, 48)
    zip64 = true
    directoryEnd = eocd64At
  } else if (disk !== 0 || directoryDisk !== 0) {
    throw new ZipError('spanned')
  } else if (totalEntries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    // Saturated but there is no locator: it cannot be read.
    throw new ZipError('corrupt', 'zip64 locator')
  }

  // If there is other data in front (a self-extracting format), the claimed position is earlier than the real one. Get the difference from the end position.
  const shift = directoryEnd - (offset + size)
  if (shift < 0) throw new ZipError('corrupt', 'directory bounds')
  return { totalEntries, size, offset: offset + shift, zip64, shift }
}

/**
 * Read the EOCD64. The position the locator claims (`declaredAt`) is relative to the start of the archive, so in a zip with other data in front
 * (a self-extracting format) it points earlier than the real position. If there is no signature at the claimed position, look just before the locator (where an EOCD64
 * with no extensible data sits). If it is in neither, it is broken.
 */
async function readEocd64(
  source: RangeSource,
  declaredAt: number,
  locatorAt: number
): Promise<{ at: number; bytes: Uint8Array }> {
  const tryAt = async (at: number): Promise<Uint8Array | null> => {
    if (at < 0 || at + EOCD64_SIZE > locatorAt) return null
    const bytes = await readExact(source, at, EOCD64_SIZE)
    return u32(viewOf(bytes), 0) === SIG_EOCD64 ? bytes : null
  }
  const declared = await tryAt(declaredAt)
  if (declared !== null) return { at: declaredAt, bytes: declared }
  const adjacentAt = locatorAt - EOCD64_SIZE
  // A prefix only shifts the position later (it never goes earlier than the claimed position).
  if (adjacentAt > declaredAt) {
    const adjacent = await tryAt(adjacentAt)
    if (adjacent !== null) return { at: adjacentAt, bytes: adjacent }
  }
  throw new ZipError('corrupt', 'eocd64')
}

// ---- Central directory ----

function parseExtra(
  extra: DataView,
  needs: { usize: boolean; csize: boolean; offset: boolean }
): { usize?: number; csize?: number; offset?: number; unicodePath?: { crc: number; name: Uint8Array }; mtime?: number; aes?: AesInfo } {
  const out: { usize?: number; csize?: number; offset?: number; unicodePath?: { crc: number; name: Uint8Array }; mtime?: number; aes?: AesInfo } = {}
  let at = 0
  while (at + 4 <= extra.byteLength) {
    const id = u16(extra, at)
    const length = u16(extra, at + 2)
    const body = at + 4
    if (body + length > extra.byteLength) break
    if (id === 0x0001) {
      // The zip64 extra field: only the saturated fields appear, in this order.
      let p = body
      const take = (): number | undefined => {
        if (p + 8 > body + length) return undefined
        const value = u64(extra, p)
        p += 8
        return value
      }
      if (needs.usize) out.usize = take()
      if (needs.csize) out.csize = take()
      if (needs.offset) out.offset = take()
    } else if (id === 0x7075 && length >= 5 && extra.getUint8(body) === 1) {
      // Info-ZIP's Unicode Path: version 1, the CRC-32 of the original name, and the UTF-8 name.
      out.unicodePath = {
        crc: u32(extra, body + 1),
        name: new Uint8Array(extra.buffer, extra.byteOffset + body + 5, length - 5)
      }
    } else if (id === 0x9901) {
      const aes = parseAesExtraBody(new DataView(extra.buffer, extra.byteOffset + body, length))
      if (aes !== null) out.aes = aes
    } else if (id === 0x5455 && length >= 5 && (extra.getUint8(body) & 1) === 1) {
      // Extended timestamp: flag bit 0 = mtime (UTC seconds).
      out.mtime = u32(extra, body + 1) * 1000
    }
    at = body + length
  }
  return out
}

function dosTimeMs(date: number, time: number): number | null {
  if (date === 0) return null
  const year = 1980 + (date >>> 9)
  const month = ((date >>> 5) & 0x0f) - 1
  const day = date & 0x1f
  const hours = time >>> 11
  const minutes = (time >>> 5) & 0x3f
  const seconds = (time & 0x1f) * 2
  if (month < 0 || month > 11 || day < 1) return null
  return new Date(year, month, day, hours, minutes, seconds).getTime()
}

function isDirectoryEntry(name: string, versionMadeBy: number, externalAttributes: number, uncompressedSize: number): boolean {
  if (name.endsWith('/') || name.endsWith('\\')) return true
  if (uncompressedSize !== 0) return false
  const host = versionMadeBy >>> 8
  // For Unix (3) / macOS (19) the upper 16 bits are the mode. For DOS (0) / NTFS (10), bit 4 means a folder.
  if (host === 3 || host === 19) return ((externalAttributes >>> 16) & 0xf000) === 0x4000
  if (host === 0 || host === 10) return (externalAttributes & 0x10) !== 0
  return false
}

/** Build a zip's listing. `limits` exists so tests can shrink the limits to check them. */
export async function readZipListing(
  source: RangeSource,
  limits: { maxEntries?: number; maxDirectoryBytes?: number } = {}
): Promise<ZipListing> {
  const maxEntries = limits.maxEntries ?? MAX_LISTED_ENTRIES
  const maxDirectoryBytes = limits.maxDirectoryBytes ?? MAX_CENTRAL_DIRECTORY_BYTES
  const directory = await findDirectory(source)
  const readLength = Math.min(directory.size, maxDirectoryBytes)
  const bytes = await readExact(source, directory.offset, readLength)
  const view = viewOf(bytes)
  const entries: ZipEntry[] = []
  let at = 0
  let cutShort = readLength < directory.size
  while (entries.length < directory.totalEntries) {
    if (entries.length >= maxEntries) {
      cutShort = true
      break
    }
    if (at + CENTRAL_SIZE > bytes.length) {
      // The central directory was cut at the limit: entries in the middle are not read. If it is short without having been cut, it is broken.
      if (readLength < directory.size) break
      throw new ZipError('corrupt', 'central directory')
    }
    if (u32(view, at) !== SIG_CENTRAL) {
      if (entries.length === 0) throw new ZipError('corrupt', 'central signature')
      // The signatures ran out before the total: show only what could be read.
      cutShort = true
      break
    }
    const versionMadeBy = u16(view, at + 4)
    const flags = u16(view, at + 8)
    const method = u16(view, at + 10)
    const time = u16(view, at + 12)
    const date = u16(view, at + 14)
    const crc = u32(view, at + 16)
    let compressedSize = u32(view, at + 20)
    let uncompressedSize = u32(view, at + 24)
    const nameLength = u16(view, at + 28)
    const extraLength = u16(view, at + 30)
    const commentLength = u16(view, at + 32)
    const externalAttributes = u32(view, at + 38)
    let localOffset = u32(view, at + 42)
    const recordEnd = at + CENTRAL_SIZE + nameLength + extraLength + commentLength
    if (recordEnd > bytes.length) {
      if (readLength < directory.size) {
        cutShort = true
        break
      }
      throw new ZipError('corrupt', 'central record')
    }
    const rawName = bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength)
    const extra = parseExtra(
      new DataView(bytes.buffer, bytes.byteOffset + at + CENTRAL_SIZE + nameLength, extraLength),
      {
        usize: uncompressedSize === 0xffffffff,
        csize: compressedSize === 0xffffffff,
        offset: localOffset === 0xffffffff
      }
    )
    if (uncompressedSize === 0xffffffff && extra.usize !== undefined) uncompressedSize = extra.usize
    if (compressedSize === 0xffffffff && extra.csize !== undefined) compressedSize = extra.csize
    if (localOffset === 0xffffffff && extra.offset !== undefined) localOffset = extra.offset

    let decoded = decodeEntryName(rawName, (flags & 0x0800) !== 0)
    if (decoded.encoding !== 'utf8' && extra.unicodePath !== undefined && extra.unicodePath.crc === crc32(rawName)) {
      const unicode = tryDecode('utf-8', extra.unicodePath.name)
      if (unicode !== null) decoded = { name: unicode, encoding: 'unicode-extra' }
    }
    const name = decoded.name
    entries.push({
      index: entries.length,
      name,
      encoding: decoded.encoding,
      baseName: baseNameOf(name),
      directory: isDirectoryEntry(name, versionMadeBy, externalAttributes, uncompressedSize),
      encrypted: (flags & FLAG_ENCRYPTED) !== 0 || method === METHOD_AES,
      flags,
      dosTime: time,
      aes: method === METHOD_AES ? (extra.aes ?? null) : null,
      method,
      compressedSize,
      uncompressedSize,
      crc32: crc,
      localHeaderOffset: localOffset + directory.shift,
      modifiedMs: extra.mtime ?? dosTimeMs(date, time),
      unsafeName: isUnsafeEntryName(name)
    })
    at = recordEnd
  }
  return {
    entries,
    totalEntries: directory.totalEntries,
    truncated: cutShort || entries.length < directory.totalEntries,
    zip64: directory.zip64
  }
}

// ---- Extraction ----

/** Whether an encrypted entry is of a kind that can be decrypted. It is known from the listing information alone (decidable before asking for the password). */
export function encryptionSupport(entry: ZipEntry): { supported: boolean } {
  if (!entry.encrypted) return { supported: true }
  if ((entry.flags & FLAG_STRONG) !== 0) return { supported: false }
  if (entry.method === METHOD_AES && entry.aes === null) return { supported: false }
  return { supported: true }
}

/**
 * Extract one entry (in memory only). The limit, compression ratio, encryption and compression method are checked first, and unzipping counts as a stream and
 * stops if it exceeds the declared size. At the end the size and CRC-32 are verified.
 *
 * An encrypted entry needs `password` (used as UTF-8). Without it, `encrypted`; with a wrong one, `wrong-password`
 * (even if ZipCrypto slips past the 1 check byte, unzipping or the CRC-32 fails it, so the reason is the same). The password is not stored.
 */
export async function extractZipEntry(
  source: RangeSource,
  entry: ZipEntry,
  limits: { maxBytes?: number; maxRatio?: number; ratioMinBytes?: number } = {},
  password?: string
): Promise<Uint8Array> {
  const maxBytes = limits.maxBytes ?? MAX_OPEN_ENTRY_BYTES
  const maxRatio = limits.maxRatio ?? MAX_COMPRESSION_RATIO
  const ratioMinBytes = limits.ratioMinBytes ?? RATIO_CHECK_MIN_BYTES
  if (entry.directory) throw new ZipError('directory')
  if (entry.encrypted && password === undefined) throw new ZipError('encrypted')
  if (!encryptionSupport(entry).supported) throw new ZipError('unsupported-encryption')
  // The compression method before encryption (AES holds it in the extra field).
  const method = entry.method === METHOD_AES ? (entry.aes?.method ?? -1) : entry.method
  if (method !== METHOD_STORED && method !== METHOD_DEFLATE) throw new ZipError('unsupported-method', String(method))
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) throw new ZipError('too-large')
  if (!entry.encrypted && method === METHOD_STORED && entry.compressedSize !== entry.uncompressedSize) {
    throw new ZipError('corrupt', 'stored size')
  }
  if (entry.uncompressedSize >= ratioMinBytes) {
    if (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > maxRatio) {
      throw new ZipError('suspicious-ratio')
    }
  }

  const local = await readExact(source, entry.localHeaderOffset, LOCAL_SIZE)
  const lv = viewOf(local)
  if (u32(lv, 0) !== SIG_LOCAL) throw new ZipError('corrupt', 'local signature')
  const dataStart = entry.localHeaderOffset + LOCAL_SIZE + u16(lv, 26) + u16(lv, 28)
  const raw = await readExact(source, dataStart, entry.compressedSize)

  let compressed = raw
  if (entry.encrypted && password !== undefined) compressed = await decryptEntry(entry, raw, new TextEncoder().encode(password))
  if (method === METHOD_STORED && compressed.byteLength !== entry.uncompressedSize) {
    throw new ZipError(entry.encrypted && entry.aes === null ? 'wrong-password' : 'corrupt', 'stored size')
  }

  let out: Uint8Array
  try {
    out = method === METHOD_STORED ? compressed : await inflateBounded(compressed, entry.uncompressedSize)
  } catch (err) {
    // If a different password slips past the 1 check byte in ZipCrypto, unzipping fails.
    if (err instanceof ZipError && entry.encrypted && entry.aes === null) throw new ZipError('wrong-password')
    throw err
  }
  const wrong = entry.encrypted && entry.aes === null ? 'wrong-password' : 'corrupt'
  if (out.byteLength !== entry.uncompressedSize) throw new ZipError(wrong, 'size')
  // AE-2 has no CRC-32 (it is set to 0). Authentication is already done by the HMAC.
  const skipCrc = entry.aes !== null && entry.aes.version === 2
  if (!skipCrc && crc32(out) !== entry.crc32) throw new ZipError(wrong, 'crc')
  return out
}

async function decryptEntry(entry: ZipEntry, data: Uint8Array, password: Uint8Array): Promise<Uint8Array> {
  try {
    if (entry.aes !== null) {
      if (entry.compressedSize < aesOverhead(entry.aes.strength)) throw new ZipError('corrupt', 'aes size')
      return await aesDecrypt(data, password, entry.aes)
    }
    if (entry.compressedSize < ZIPCRYPTO_HEADER) throw new ZipError('corrupt', 'zipcrypto header')
    // The 1 check byte: normally the top of the CRC; for a zip with a data descriptor, the top of the modification time (they differ by writer, so both are accepted).
    return zipCryptoDecrypt(data, password, [(entry.crc32 >>> 24) & 0xff, (entry.dosTime >>> 8) & 0xff])
  } catch (err) {
    if (err instanceof CryptoFailure) throw new ZipError(err.code)
    throw err
  }
}

/** Inflate deflate up to `limit` bytes. If it goes past that, stop with `corrupt` (growing more than declared = the central directory lies). */
async function inflateBounded(compressed: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([compressed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new ZipError('corrupt', 'inflated past the declared size')
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof ZipError) throw err
    throw new ZipError('corrupt', 'inflate')
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

// ---- The entry point for range reads ----

/**
 * The entry point that reads a URL (the `aios-res://` the host passes, or a temporary view's `blob:`) with `Range`. If the server ignores the range and returns the whole thing
 * (200), it remembers that whole and slices from it afterward.
 */
export function urlRangeSource(url: string, size: number, fetchImpl: typeof fetch = fetch): RangeSource {
  let whole: Uint8Array | null = null
  return {
    size,
    async read(offset, length) {
      if (whole !== null) return whole.subarray(offset, offset + length)
      const response = await fetchImpl(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } })
      if (response.status === 206) return new Uint8Array(await response.arrayBuffer())
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      whole = new Uint8Array(await response.arrayBuffer())
      return whole.subarray(offset, offset + length)
    }
  }
}

/** The entry point for bytes in memory (for tests and small zips). */
export function bytesRangeSource(bytes: Uint8Array): RangeSource {
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      return bytes.subarray(offset, offset + length)
    }
  }
}
