/**
 * The seal of an export file (TODO 1088, ARCHITECTURE 8.6). **Only Node's `crypto` / `zlib`**, independent of electron.
 *
 * File layout (all big-endian):
 *
 * ```
 * "AIOSDATA"            8-byte magic
 * u32                   header length (bytes)
 * header (UTF-8 JSON)   { container: 1, kdf: { name: 'scrypt', N, r, p, salt }, cipher: { name: 'aes-256-gcm', iv }, compression: 'gzip' }
 * ciphertext            the gzipped payload (JSON) under AES-256-GCM
 * tag                   16 bytes
 * ```
 *
 * - The key is derived with scrypt from the passphrase (normalized to NFC so the same key results even if another PC's input method composes characters differently).
 *   The salt and IV are random per export.
 * - **The magic, length and header go into GCM's additional authenticated data (AAD).** A file with a rewritten header (scrypt strength or IV)
 *   also fails on the tag. A wrong passphrase cannot be told apart from tampering (both are `decrypt-failed`).
 * - **Header values are bounded by limits before use** (the file comes from outside). scrypt N, r, p must not exceed the memory and time limits,
 *   and decompression is stopped by `maxOutputLength` (zip bomb).
 * - scrypt / gzip run on libuv threads (they do not block main's JS thread). **Export streams through `createSealer`**:
 *   the payload is written piece by piece into a gzip stream, and each emitted chunk is passed through AES immediately (the whole payload never becomes one string).
 *   Reading does AES in one synchronous call, but even at the limit size (`MAX_FILE_BYTES`) it takes under a second.
 *   Plaintext is not used before the tag is verified (decompression and parsing happen after `decipher.final()` passes).
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { createGzip, gunzip as gunzipCallback } from 'node:zlib'
import { once } from 'node:events'
import { promisify } from 'node:util'

const gunzip = promisify(gunzipCallback) as (buffer: Uint8Array, options: { maxOutputLength: number }) => Promise<Buffer>

function scrypt(passphrase: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      passphrase.normalize('NFC'),
      salt,
      KEY_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: scryptMemory(params) + 16 * 1024 * 1024 },
      (err, key) => (err === null ? resolve(key) : reject(err))
    )
  })
}

export const MAGIC = Buffer.from('AIOSDATA', 'ascii')
/** Version of the seal format (separate from the payload's format version `formatVersion`). */
export const CONTAINER_VERSION = 1

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16
const MAX_HEADER_BYTES = 4096

/** Cap on the export file (reading does not read a larger file). */
export const MAX_FILE_BYTES = 512 * 1024 * 1024
/** Cap on the decompressed payload. Kept below V8's string limit (about 512 MiB) - stop before passing to `JSON.parse`. */
export const MAX_PLAIN_BYTES = 384 * 1024 * 1024

export interface KdfParams {
  readonly N: number
  readonly r: number
  readonly p: number
}

/** Default strength (128 MiB, about 0.3 seconds on a development Mac). Same as OWASP's scrypt recommendation (N=2^17, r=8, p=1). */
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 }

/** Memory scrypt uses (128 * N * r * p bytes). */
function scryptMemory(params: KdfParams): number {
  return 128 * params.N * params.r * params.p
}

/** Upper bound on the scrypt strength accepted on read (memory up to 256 MiB). Too weak a setting (N < 2^14) is also rejected. */
function acceptableKdf(params: KdfParams): boolean {
  const { N, r, p } = params
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false
  if (N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0) return false
  if (r < 1 || r > 16 || p < 1 || p > 4) return false
  return scryptMemory(params) <= 256 * 1024 * 1024
}

export type OpenFailure = 'not-export-file' | 'too-new' | 'decrypt-failed' | 'too-large'

export class SealError extends Error {
  constructor(readonly reason: OpenFailure) {
    super(`data-transfer: ${reason}`)
    this.name = 'SealError'
  }
}

interface Header {
  readonly container: number
  readonly kdf: { readonly name: 'scrypt'; readonly N: number; readonly r: number; readonly p: number; readonly salt: string }
  readonly cipher: { readonly name: 'aes-256-gcm'; readonly iv: string }
  readonly compression: 'gzip'
}

/** Streaming seal (`createSealer`). Call `write` in order, and at the end `finish` returns the contents of the sealed file. */
export interface Sealer {
  /** The next part of the payload (strings are UTF-8). Throws `RangeError` when over the limit (the caller maps it to `too-large`). */
  write(chunk: string | Uint8Array): Promise<void>
  finish(): Promise<Buffer>
}

/**
 * Seals the payload by streaming. Writes into a gzip stream and passes each emitted chunk through AES-256-GCM, accumulating it (only the size after compression and encryption
 * accumulates). It does not write when the plaintext size exceeds the reader's limit (`MAX_PLAIN_BYTES`) or the sealed size exceeds `MAX_FILE_BYTES`,
 * so that a file we wrote can always be read back.
 */
export async function createSealer(passphrase: string, kdf: KdfParams = DEFAULT_KDF): Promise<Sealer> {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const header: Header = {
    container: CONTAINER_VERSION,
    kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64') },
    compression: 'gzip'
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(headerBytes.length)
  const aad = Buffer.concat([MAGIC, length, headerBytes])
  const key = await scrypt(passphrase, salt, kdf)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const parts: Buffer[] = [aad]
  let sealedBytes = aad.length
  let plainBytes = 0
  let failure: Error | null = null
  const gz = createGzip()
  gz.on('data', (chunk: Buffer) => {
    const encrypted = cipher.update(chunk)
    parts.push(encrypted)
    sealedBytes += encrypted.length
    if (sealedBytes + TAG_BYTES > MAX_FILE_BYTES) failure ??= new RangeError('data-transfer: sealed output exceeds the limit')
  })
  gz.on('error', (err: Error) => {
    failure ??= err
  })
  const ended = once(gz, 'end')
  // `once` rejects on 'error'. Do not turn a failure that happens before finish into an unhandled rejection.
  ended.catch(() => undefined)
  return {
    async write(chunk) {
      if (failure !== null) throw failure
      plainBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength
      if (plainBytes > MAX_PLAIN_BYTES) {
        failure = new RangeError('data-transfer: plain contents exceed the limit')
        throw failure
      }
      if (!gz.write(chunk)) await once(gz, 'drain')
      if (failure !== null) throw failure
    },
    async finish() {
      if (failure !== null) throw failure
      gz.end()
      await ended
      if (failure !== null) throw failure
      parts.push(cipher.final(), cipher.getAuthTag())
      return Buffer.concat(parts)
    }
  }
}

/** Seals the payload (UTF-8) in one call (a thin shell over `createSealer`. For tests and small payloads). */
export async function seal(plain: Uint8Array, passphrase: string, kdf: KdfParams = DEFAULT_KDF): Promise<Buffer> {
  const sealer = await createSealer(passphrase, kdf)
  await sealer.write(plain)
  return sealer.finish()
}

function parseHeader(bytes: Buffer): Header {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new SealError('not-export-file')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new SealError('not-export-file')
  const header = parsed as Partial<Record<keyof Header, unknown>>
  if (typeof header.container !== 'number') throw new SealError('not-export-file')
  if (header.container > CONTAINER_VERSION) throw new SealError('too-new')
  if (header.container !== CONTAINER_VERSION) throw new SealError('not-export-file')
  const kdf = header.kdf as Partial<Header['kdf']> | undefined
  const cipher = header.cipher as Partial<Header['cipher']> | undefined
  if (
    typeof kdf !== 'object' ||
    kdf === null ||
    kdf.name !== 'scrypt' ||
    typeof kdf.salt !== 'string' ||
    typeof cipher !== 'object' ||
    cipher === null ||
    cipher.name !== 'aes-256-gcm' ||
    typeof cipher.iv !== 'string' ||
    header.compression !== 'gzip'
  ) {
    // A different name = a scheme this version does not know. Treat it as written by a newer version.
    throw new SealError('too-new')
  }
  const params = { N: kdf.N as number, r: kdf.r as number, p: kdf.p as number }
  if (!acceptableKdf(params)) throw new SealError('not-export-file')
  return header as Header
}

/** Opens the seal. `decrypt-failed` if the passphrase is wrong or it was tampered with. */
export async function open(file: Uint8Array, passphrase: string): Promise<Buffer> {
  const data = Buffer.from(file.buffer, file.byteOffset, file.byteLength)
  if (data.length > MAX_FILE_BYTES) throw new SealError('too-large')
  if (data.length < MAGIC.length + 4 || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new SealError('not-export-file')
  }
  const headerLength = data.readUInt32BE(MAGIC.length)
  const headerEnd = MAGIC.length + 4 + headerLength
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || headerEnd + TAG_BYTES > data.length) {
    throw new SealError('not-export-file')
  }
  const header = parseHeader(data.subarray(MAGIC.length + 4, headerEnd))
  const salt = Buffer.from(header.kdf.salt, 'base64')
  const iv = Buffer.from(header.cipher.iv, 'base64')
  if (salt.length < SALT_BYTES || salt.length > 64 || iv.length !== IV_BYTES) throw new SealError('not-export-file')
  const key = await scrypt(passphrase, salt, header.kdf)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(data.subarray(0, headerEnd))
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES))
  let compressed: Buffer
  try {
    compressed = Buffer.concat([decipher.update(data.subarray(headerEnd, data.length - TAG_BYTES)), decipher.final()])
  } catch {
    throw new SealError('decrypt-failed')
  }
  try {
    return await gunzip(compressed, { maxOutputLength: MAX_PLAIN_BYTES })
  } catch (err) {
    // Authentication passed = it is the writer's own file. Stopping at decompression happens only when the limit is exceeded.
    if ((err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') throw new SealError('too-large')
    throw new SealError('not-export-file')
  }
}
