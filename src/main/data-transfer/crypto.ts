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
 * - **Header values are bounded by limits before use** (the file comes from outside). scrypt N, r, p must not exceed the memory and time limits.
 * - **Both directions stream (TODO 1318).** There is no cap on the whole file: memory is bounded per piece, never by the file size.
 *   - Writing (`createSealer`): the payload is written piece by piece into a gzip stream, each emitted chunk goes through AES and on to the
 *     sink (the file being written) in batches of about `WRITE_BATCH`, with backpressure. Nothing accumulates; the tag is written last.
 *   - Reading (`unseal`): the ciphertext is read from one source at fixed positions (`READ_CHUNK` at a time, never re-opened by path),
 *     decrypted and decompressed, and handed to the caller piece by piece. **The tag sits at the end, so the plaintext is handed out before
 *     it is verified**: callers must not commit anything until `unseal` resolves (the importer validates first and writes in a second pass
 *     that it undoes when the second tag check fails). A tag mismatch wins over anything the plaintext said (`decrypt-failed`): when the
 *     caller rejects the content or the compressed data is broken, the rest is still decrypted (not decompressed) to check the tag.
 * - scrypt / gzip run on libuv threads. AES runs on main's JS thread one chunk at a time (well under a millisecond per chunk), with the
 *   reads in between.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, type DecipherGCM } from 'node:crypto'
import { createGunzip, createGzip } from 'node:zlib'
import type { Duplex } from 'node:stream'

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
/** Ciphertext read per step when opening. */
const READ_CHUNK = 256 * 1024
/** Sealed bytes collected before one write to the sink. */
const WRITE_BATCH = 1024 * 1024

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

export type OpenFailure = 'not-export-file' | 'too-new' | 'decrypt-failed'

export class SealError extends Error {
  constructor(readonly reason: OpenFailure) {
    super(`data-transfer: ${reason}`)
    this.name = 'SealError'
  }
}

/** The source changed size under us (a short read): an I/O failure, not a seal failure. */
export class SourceChangedError extends Error {
  constructor() {
    super('data-transfer: the file changed while it was read')
    this.name = 'SourceChangedError'
  }
}

interface Header {
  readonly container: number
  readonly kdf: { readonly name: 'scrypt'; readonly N: number; readonly r: number; readonly p: number; readonly salt: string }
  readonly cipher: { readonly name: 'aes-256-gcm'; readonly iv: string }
  readonly compression: 'gzip'
}

/** Where a sealer writes (the file being written). Writes are awaited one at a time, in order. */
export interface SealSink {
  write(chunk: Buffer): Promise<void>
}

/** A sealed file opened once: its size when opened, and reads at fixed positions (the same descriptor for every pass). */
export interface SealSource {
  readonly size: number
  /** Up to `length` bytes at `position` (fewer only past the end). */
  read(position: number, length: number): Promise<Buffer>
}

/** Streaming seal (`createSealer`). Call `write` in order, and at the end `finish`. */
export interface Sealer {
  /** The next part of the payload (strings are UTF-8). */
  write(chunk: string | Uint8Array): Promise<void>
  /** Ends the payload and writes the tag. Returns the number of bytes written to the sink in all. */
  finish(): Promise<number>
  /** Gives up (after a failure or a stop): releases the compression stream. Never throws. Writes nothing more to the sink. */
  abort(): void
}

/** Resolves once `stream` can take more (`drain`) or is gone (`close`), so a destroyed stream never leaves a waiter hanging. */
function writable(stream: Duplex): Promise<void> {
  if (stream.destroyed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      stream.off('drain', done)
      stream.off('close', done)
      resolve()
    }
    stream.on('drain', done)
    stream.on('close', done)
  })
}

/**
 * Seals the payload by streaming into `sink`: the header first, then gzip's output through AES-256-GCM as it comes, then the tag. Only
 * about `WRITE_BATCH` of sealed bytes are held at a time, whatever the payload's size. If the sink throws (a full disk), the next
 * `write` / `finish` throws the same error.
 */
export async function createSealer(passphrase: string, sink: SealSink, kdf: KdfParams = DEFAULT_KDF): Promise<Sealer> {
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
  await sink.write(aad)
  let written = aad.length
  let failure: { readonly error: unknown } | null = null
  const gz = createGzip()
  // Pulls gzip's output through AES into the sink in order. While the sink is busy gzip's buffer fills and `write` waits (backpressure).
  const pumped = (async () => {
    let batch: Buffer[] = []
    let batchBytes = 0
    const flush = async (): Promise<void> => {
      if (batchBytes === 0) return
      const data = batch.length === 1 ? batch[0]! : Buffer.concat(batch, batchBytes)
      batch = []
      batchBytes = 0
      await sink.write(data)
      written += data.length
    }
    for await (const chunk of gz) {
      const encrypted = cipher.update(chunk as Buffer)
      batch.push(encrypted)
      batchBytes += encrypted.length
      if (batchBytes >= WRITE_BATCH) await flush()
    }
    if (failure === null) await flush()
  })().catch((error: unknown) => {
    failure ??= { error }
    gz.destroy()
  })
  const check = (): void => {
    if (failure !== null) throw failure.error
  }
  return {
    async write(chunk) {
      check()
      if (!gz.write(chunk)) await writable(gz)
      check()
    },
    async finish() {
      check()
      gz.end()
      await pumped
      check()
      const tail = Buffer.concat([cipher.final(), cipher.getAuthTag()])
      await sink.write(tail)
      written += tail.length
      return written
    },
    abort() {
      failure ??= { error: new Error('data-transfer: sealing aborted') }
      gz.destroy()
    }
  }
}

/** A sink that collects in memory (for `seal`). */
function memorySink(): SealSink & { bytes(): Buffer } {
  const parts: Buffer[] = []
  return {
    write: async (chunk) => void parts.push(Buffer.from(chunk)),
    bytes: () => Buffer.concat(parts)
  }
}

/** Seals the payload (UTF-8) in one call, in memory. **For tests and small payloads only** (the app streams into a file). */
export async function seal(plain: Uint8Array, passphrase: string, kdf: KdfParams = DEFAULT_KDF): Promise<Buffer> {
  const sink = memorySink()
  const sealer = await createSealer(passphrase, sink, kdf)
  await sealer.write(plain)
  await sealer.finish()
  return sink.bytes()
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

/** Exactly `length` bytes at `position`, or `SourceChangedError` (the file shrank after it was opened). */
async function readExactly(source: SealSource, position: number, length: number): Promise<Buffer> {
  const bytes = await source.read(position, length)
  if (bytes.length !== length) throw new SourceChangedError()
  return bytes
}

/** A buffer as a `SealSource` (tests and `open`). */
export function bufferSource(file: Uint8Array): SealSource {
  const data = Buffer.from(file.buffer, file.byteOffset, file.byteLength)
  return {
    size: data.length,
    read: async (position, length) => Buffer.from(data.subarray(position, Math.min(data.length, position + length)))
  }
}

/** Reads and checks the header, derives the key, and readies the decipher (AAD and tag set). */
async function beginOpen(
  source: SealSource,
  passphrase: string
): Promise<{ readonly decipher: DecipherGCM; readonly bodyStart: number; readonly bodyEnd: number }> {
  const prefixBytes = MAGIC.length + 4
  if (source.size < prefixBytes) throw new SealError('not-export-file')
  const prefix = await readExactly(source, 0, prefixBytes)
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealError('not-export-file')
  const headerLength = prefix.readUInt32BE(MAGIC.length)
  const headerEnd = prefixBytes + headerLength
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || headerEnd + TAG_BYTES > source.size) {
    throw new SealError('not-export-file')
  }
  const headerBytes = await readExactly(source, prefixBytes, headerLength)
  const header = parseHeader(headerBytes)
  const salt = Buffer.from(header.kdf.salt, 'base64')
  const iv = Buffer.from(header.cipher.iv, 'base64')
  if (salt.length < SALT_BYTES || salt.length > 64 || iv.length !== IV_BYTES) throw new SealError('not-export-file')
  const key = await scrypt(passphrase, salt, header.kdf)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.concat([prefix, headerBytes]))
  decipher.setAuthTag(await readExactly(source, source.size - TAG_BYTES, TAG_BYTES))
  return { decipher, bodyStart: headerEnd, bodyEnd: source.size - TAG_BYTES }
}

export interface UnsealOptions {
  /** Called before each read (the caller's stop check). If it throws, `unseal` ends at once with that error, without checking the tag. */
  readonly checkpoint?: () => void
  /**
   * Errors of `onPlain` that end `unseal` at once (a stop, a write that failed), instead of decrypting the rest to check the tag first.
   * Other errors of `onPlain` are "the content is wrong": the tag is still checked, and a mismatch wins (`decrypt-failed`).
   */
  readonly isAbort?: (error: unknown) => boolean
}

/**
 * Opens the seal by streaming: `onPlain` receives the decompressed payload piece by piece, in order (awaited one at a time, so a slow
 * consumer holds the reading back). It returns false when it needs no more; the rest is then only decrypted, to check the tag.
 *
 * Resolves only after the tag matched and `onPlain` saw everything it asked for. Rejects with, in this order: an I/O error or an abort
 * (`checkpoint`, `isAbort`) as it happens; `decrypt-failed` (wrong passphrase or tampering); the error `onPlain` threw; `not-export-file`
 * (the compressed data is broken although the tag matched). Header failures (`not-export-file` / `too-new`) come before any plaintext.
 */
export async function unseal(
  source: SealSource,
  passphrase: string,
  onPlain: (chunk: Buffer) => Promise<boolean | void>,
  options: UnsealOptions = {}
): Promise<void> {
  const { decipher, bodyStart, bodyEnd } = await beginOpen(source, passphrase)
  const gz = createGunzip()
  // Set by the consumer below (a holder object, so the compiler does not keep the initial values narrowed).
  const state: {
    /** The consumer still wants plaintext (false once it stopped, failed, or the stream broke). */
    wanted: boolean
    aborted: { readonly error: unknown } | null
    rejected: { readonly error: unknown } | null
    broken: boolean
  } = { wanted: true, aborted: null, rejected: null, broken: false }
  const consumed = (async () => {
    try {
      for await (const chunk of gz) {
        let more: boolean | void
        try {
          more = await onPlain(chunk as Buffer)
        } catch (error) {
          if (options.isAbort?.(error) === true) state.aborted ??= { error }
          else state.rejected ??= { error }
          state.wanted = false
          // Leaving the loop destroys the stream; the feeder stops writing into it.
          return
        }
        if (more === false) {
          state.wanted = false
          return
        }
      }
    } catch {
      // Thrown by the stream itself: the compressed data is broken (or the stream was destroyed below).
      state.broken = true
      state.wanted = false
    }
  })()

  let failed: { readonly error: unknown } | null = null
  let tagOk = false
  try {
    for (let position = bodyStart; position < bodyEnd && state.aborted === null; ) {
      options.checkpoint?.()
      const length = Math.min(READ_CHUNK, bodyEnd - position)
      const encrypted = await readExactly(source, position, length)
      position += length
      const compressed = decipher.update(encrypted)
      if (state.wanted && !gz.destroyed && !gz.write(compressed)) await writable(gz)
    }
    if (state.aborted === null) {
      try {
        decipher.final()
        tagOk = true
      } catch {
        tagOk = false
      }
    }
  } catch (error) {
    failed = { error }
  }
  // Only an authenticated stream is allowed to reach its end; anything else is cut off.
  if (failed === null && state.aborted === null && tagOk && state.wanted && !gz.destroyed) gz.end()
  else gz.destroy()
  await consumed
  if (failed !== null) throw failed.error
  if (state.aborted !== null) throw state.aborted.error
  if (!tagOk) throw new SealError('decrypt-failed')
  if (state.rejected !== null) throw state.rejected.error
  if (state.broken) throw new SealError('not-export-file')
}

/**
 * Opens the seal and returns the whole payload in memory. **For tests and small files only** - the app reads with `unseal`, which
 * never holds the whole payload. `decrypt-failed` if the passphrase is wrong or it was tampered with.
 */
export async function open(file: Uint8Array, passphrase: string): Promise<Buffer> {
  const parts: Buffer[] = []
  await unseal(bufferSource(file), passphrase, async (chunk) => void parts.push(Buffer.from(chunk)))
  return Buffer.concat(parts)
}
