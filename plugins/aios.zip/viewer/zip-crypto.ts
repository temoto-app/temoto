/**
 * Decryption for `aios.zip` (TODO 1151). Pure functions that depend on neither the DOM nor a port — tests can call them directly.
 *
 *  - ZipCrypto (the traditional encryption, flag bit 0): a stream cipher that runs three keys through CRC-32. The first 12 bytes are random data + 1 check byte.
 *  - WinZip AES (method 99, AE-1 / AE-2): salt + 2 check-value bytes + ciphertext + 10 bytes of HMAC-SHA1. The key is made with
 *    PBKDF2-HMAC-SHA1 (1000 iterations), and the ciphertext is AES-CTR **with a little-endian counter** (the counter starts at 1).
 *    PBKDF2 and HMAC use WebCrypto (`crypto.subtle`). WebCrypto's AES-CTR is fixed to a big-endian counter and does not match WinZip's
 *    form, so only the key stream (counter -> one AES block encryption) is built with the small AES below (no library is added).
 *
 * The password is held only for the duration of a call. It is neither stored nor recorded.
 */

import { crc32Byte } from './crc32.js'

/** A decryption failure. `zip.ts` maps it to a `ZipError`. */
export class CryptoFailure extends Error {
  constructor(readonly code: 'wrong-password' | 'corrupt') {
    super(code)
    this.name = 'CryptoFailure'
  }
}

// ---- ZipCrypto ----

/** The length of the encryption header. */
export const ZIPCRYPTO_HEADER = 12

/**
 * Decrypt ZipCrypto. `checkBytes` are the values accepted as the 1 check byte (the top byte of the CRC, or, when flag bit 3 is set, the top byte of
 * the modification time. They differ by writer, so passing any one of them is accepted). If none match, `wrong-password`.
 * The check is 1 byte, so 1 in 256 slips through — the CRC-32 after that decides in the end.
 */
export function zipCryptoDecrypt(data: Uint8Array, password: Uint8Array, checkBytes: readonly number[]): Uint8Array {
  if (data.length < ZIPCRYPTO_HEADER) throw new CryptoFailure('corrupt')
  let k0 = 0x12345678
  let k1 = 0x23456789
  let k2 = 0x34567890
  const update = (c: number): void => {
    k0 = crc32Byte(k0, c)
    k1 = (k1 + (k0 & 0xff)) >>> 0
    k1 = (Math.imul(k1, 134775813) + 1) >>> 0
    k2 = crc32Byte(k2, k1 >>> 24)
  }
  const keyByte = (): number => {
    const t = (k2 | 2) & 0xffff
    return (Math.imul(t, t ^ 1) >>> 8) & 0xff
  }
  for (const byte of password) update(byte)
  let last = 0
  for (let i = 0; i < ZIPCRYPTO_HEADER; i++) {
    last = (data[i] ?? 0) ^ keyByte()
    update(last)
  }
  if (!checkBytes.includes(last)) throw new CryptoFailure('wrong-password')
  const out = new Uint8Array(data.length - ZIPCRYPTO_HEADER)
  for (let i = 0; i < out.length; i++) {
    const plain = (data[i + ZIPCRYPTO_HEADER] ?? 0) ^ keyByte()
    out[i] = plain
    update(plain)
  }
  return out
}

// ---- WinZip AES ----

export interface AesInfo {
  /** 1 = AES-128, 2 = AES-192, 3 = AES-256. */
  readonly strength: 1 | 2 | 3
  /** AE-1 (with CRC) = 1, AE-2 (without CRC) = 2. */
  readonly version: 1 | 2
  /** The compression method before encryption (0 = stored, 8 = deflate). */
  readonly method: number
}

const AES_SALT_LENGTH = { 1: 8, 2: 12, 3: 16 } as const
const AES_KEY_LENGTH = { 1: 16, 2: 24, 3: 32 } as const
const AES_AUTH_LENGTH = 10

/** Read the body (7 bytes) of the 0x9901 extra field. null if the shape is different. */
export function parseAesExtraBody(body: DataView): AesInfo | null {
  if (body.byteLength < 7) return null
  const version = body.getUint16(0, true)
  const strength = body.getUint8(4)
  if ((version !== 1 && version !== 2) || (strength !== 1 && strength !== 2 && strength !== 3)) return null
  return { strength, version, method: body.getUint16(5, true) }
}

/** The extra length of the encrypted data: salt, check value and HMAC added. */
export function aesOverhead(strength: 1 | 2 | 3): number {
  return AES_SALT_LENGTH[strength] + 2 + AES_AUTH_LENGTH
}

function bufferOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>
}

export async function aesDecrypt(data: Uint8Array, password: Uint8Array, info: AesInfo): Promise<Uint8Array> {
  const saltLength = AES_SALT_LENGTH[info.strength]
  const keyLength = AES_KEY_LENGTH[info.strength]
  if (data.length < aesOverhead(info.strength)) throw new CryptoFailure('corrupt')
  const salt = data.subarray(0, saltLength)
  const verifier = data.subarray(saltLength, saltLength + 2)
  const cipher = data.subarray(saltLength + 2, data.length - AES_AUTH_LENGTH)
  const auth = data.subarray(data.length - AES_AUTH_LENGTH)

  const subtle = globalThis.crypto.subtle
  const base = await subtle.importKey('raw', bufferOf(password), 'PBKDF2', false, ['deriveBits'])
  const derived = new Uint8Array(
    await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-1', salt: bufferOf(salt), iterations: 1000 },
      base,
      (keyLength * 2 + 2) * 8
    )
  )
  const encKey = derived.subarray(0, keyLength)
  const authKey = derived.subarray(keyLength, keyLength * 2)
  const expected = derived.subarray(keyLength * 2)
  if (expected[0] !== verifier[0] || expected[1] !== verifier[1]) throw new CryptoFailure('wrong-password')

  const hmacKey = await subtle.importKey('raw', bufferOf(authKey), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await subtle.sign('HMAC', hmacKey, bufferOf(cipher)))
  let diff = 0
  for (let i = 0; i < AES_AUTH_LENGTH; i++) diff |= (mac[i] ?? 0) ^ (auth[i] ?? 0)
  if (diff !== 0) throw new CryptoFailure('corrupt')

  return aesCtrLittleEndian(encKey, cipher)
}

/** WinZip's AES-CTR: the counter starts at 1, little-endian from the start of each 16-byte block. */
export function aesCtrLittleEndian(key: Uint8Array, data: Uint8Array): Uint8Array {
  const schedule = expandKey(key)
  const rounds = schedule.length / 4 - 1
  const out = new Uint8Array(data.length)
  const block = new Uint8Array(16)
  for (let at = 0, counter = 1; at < data.length; at += 16, counter++) {
    // The counter does not exceed 2^32 (4M blocks at the 64 MB limit). The upper 12 bytes are 0.
    const stream = encryptCounter(schedule, rounds, counter, block)
    const n = Math.min(16, data.length - at)
    for (let i = 0; i < n; i++) out[at + i] = (data[at + i] ?? 0) ^ (stream[i] ?? 0)
  }
  return out
}

// ---- A small AES (encryption direction only. T-table) ----

let sbox: Uint8Array | null = null
let te0: Uint32Array
let te1: Uint32Array
let te2: Uint32Array
let te3: Uint32Array

function initTables(): Uint8Array {
  if (sbox !== null) return sbox
  const s = new Uint8Array(256)
  let p = 1
  let q = 1
  const rotl8 = (x: number, n: number): number => ((x << n) | (x >>> (8 - n))) & 0xff
  do {
    // Multiply p by 3 and divide q by 3 (going once around the multiplicative group of GF(2^8)).
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff
    q ^= (q << 1) & 0xff
    q ^= (q << 2) & 0xff
    q ^= (q << 4) & 0xff
    if (q & 0x80) q ^= 0x09
    s[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff
  } while (p !== 1)
  s[0] = 0x63
  te0 = new Uint32Array(256)
  te1 = new Uint32Array(256)
  te2 = new Uint32Array(256)
  te3 = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    const v = s[i] ?? 0
    const v2 = ((v << 1) ^ (v & 0x80 ? 0x1b : 0)) & 0xff
    const v3 = v2 ^ v
    const word = ((v2 << 24) | (v << 16) | (v << 8) | v3) >>> 0
    te0[i] = word
    te1[i] = ((word >>> 8) | (word << 24)) >>> 0
    te2[i] = ((word >>> 16) | (word << 16)) >>> 0
    te3[i] = ((word >>> 24) | (word << 8)) >>> 0
  }
  sbox = s
  return s
}

function expandKey(key: Uint8Array): Uint32Array {
  const s = initTables()
  const nk = key.length / 4
  if (nk !== 4 && nk !== 6 && nk !== 8) throw new CryptoFailure('corrupt')
  const total = 4 * (nk + 7)
  const w = new Uint32Array(total)
  for (let i = 0; i < nk; i++) {
    w[i] = (((key[4 * i] ?? 0) << 24) | ((key[4 * i + 1] ?? 0) << 16) | ((key[4 * i + 2] ?? 0) << 8) | (key[4 * i + 3] ?? 0)) >>> 0
  }
  const sub = (x: number): number =>
    (((s[x >>> 24] ?? 0) << 24) | ((s[(x >>> 16) & 0xff] ?? 0) << 16) | ((s[(x >>> 8) & 0xff] ?? 0) << 8) | (s[x & 0xff] ?? 0)) >>> 0
  let rcon = 1
  for (let i = nk; i < total; i++) {
    let t = w[i - 1] ?? 0
    if (i % nk === 0) {
      t = sub(((t << 8) | (t >>> 24)) >>> 0) ^ (rcon << 24)
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff
    } else if (nk > 6 && i % nk === 4) {
      t = sub(t)
    }
    w[i] = ((w[i - nk] ?? 0) ^ t) >>> 0
  }
  return w
}

/** The 16 bytes from encrypting the block of the counter (little-endian, only the low 4 bytes). The returned array is reused. */
function encryptCounter(w: Uint32Array, rounds: number, counter: number, out: Uint8Array): Uint8Array {
  const s = sbox ?? initTables()
  let s0 = ((counter & 0xff) << 24) | (((counter >>> 8) & 0xff) << 16) | (((counter >>> 16) & 0xff) << 8) | ((counter >>> 24) & 0xff)
  let s1 = 0
  let s2 = 0
  let s3 = 0
  s0 ^= w[0] ?? 0
  s1 ^= w[1] ?? 0
  s2 ^= w[2] ?? 0
  s3 ^= w[3] ?? 0
  for (let r = 1; r < rounds; r++) {
    const k = r * 4
    const t0 = (te0[s0 >>> 24] ?? 0) ^ (te1[(s1 >>> 16) & 0xff] ?? 0) ^ (te2[(s2 >>> 8) & 0xff] ?? 0) ^ (te3[s3 & 0xff] ?? 0) ^ (w[k] ?? 0)
    const t1 = (te0[s1 >>> 24] ?? 0) ^ (te1[(s2 >>> 16) & 0xff] ?? 0) ^ (te2[(s3 >>> 8) & 0xff] ?? 0) ^ (te3[s0 & 0xff] ?? 0) ^ (w[k + 1] ?? 0)
    const t2 = (te0[s2 >>> 24] ?? 0) ^ (te1[(s3 >>> 16) & 0xff] ?? 0) ^ (te2[(s0 >>> 8) & 0xff] ?? 0) ^ (te3[s1 & 0xff] ?? 0) ^ (w[k + 2] ?? 0)
    const t3 = (te0[s3 >>> 24] ?? 0) ^ (te1[(s0 >>> 16) & 0xff] ?? 0) ^ (te2[(s1 >>> 8) & 0xff] ?? 0) ^ (te3[s2 & 0xff] ?? 0) ^ (w[k + 3] ?? 0)
    s0 = t0
    s1 = t1
    s2 = t2
    s3 = t3
  }
  const k = rounds * 4
  const last = (a: number, b: number, c: number, d: number, key: number): number =>
    (((s[a >>> 24] ?? 0) << 24) | ((s[(b >>> 16) & 0xff] ?? 0) << 16) | ((s[(c >>> 8) & 0xff] ?? 0) << 8) | (s[d & 0xff] ?? 0)) ^ key
  const o0 = last(s0, s1, s2, s3, w[k] ?? 0)
  const o1 = last(s1, s2, s3, s0, w[k + 1] ?? 0)
  const o2 = last(s2, s3, s0, s1, w[k + 2] ?? 0)
  const o3 = last(s3, s0, s1, s2, w[k + 3] ?? 0)
  const words = [o0, o1, o2, o3]
  for (let i = 0; i < 4; i++) {
    const v = words[i] ?? 0
    out[4 * i] = v >>> 24
    out[4 * i + 1] = (v >>> 16) & 0xff
    out[4 * i + 2] = (v >>> 8) & 0xff
    out[4 * i + 3] = v & 0xff
  }
  return out
}
