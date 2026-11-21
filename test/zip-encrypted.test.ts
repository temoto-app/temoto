/**
 * TODO 1151: decryption of the encrypted items of `aios.zip` (ZipCrypto and WinZip AES). The model is not called.
 *
 * fixtures (the password is, as the name says, `secret123`, and the contents are `note.txt` = "hello encrypted zip\n" x 50):
 *  - `zip-zipcrypto-pw-secret123.zip`: `zip -e -P secret123 zipcrypto.zip note.txt` (Info-ZIP)
 *  - `zip-aes256-pw-secret123.zip`: `7z a -tzip -psecret123 -mem=AES256 aes256.zip note.txt` (AE-2, deflate)
 * AES-128 / 192 / AE-1 cannot be made by 7z for some combinations, so below they are assembled per the spec with Node's crypto.
 */
import { describe, expect, it } from 'vitest'
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib'
import { ZipError, bytesRangeSource, encryptionSupport, extractZipEntry, readZipListing } from '../plugins/aios.zip/viewer/zip.js'
import { aesCtrLittleEndian } from '../plugins/aios.zip/viewer/zip-crypto.js'

const fixtures = join(import.meta.dirname, 'fixtures')
const expected = new TextEncoder().encode('hello encrypted zip\n'.repeat(50))

async function open(bytes: Uint8Array, password?: string): Promise<Uint8Array> {
  const source = bytesRangeSource(bytes)
  const { entries } = await readZipListing(source)
  const entry = entries[0]
  if (entry === undefined) throw new Error('no entry')
  return extractZipEntry(source, entry, {}, password)
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ZipError) return err.reason
    throw err
  }
  return 'resolved'
}

describe('ZipCrypto (zip -e)', () => {
  const zip = new Uint8Array(readFileSync(join(fixtures, 'zip-zipcrypto-pw-secret123.zip')))
  it('opens with the correct password', async () => {
    const { entries } = await readZipListing(bytesRangeSource(zip))
    expect(entries[0]?.encrypted).toBe(true)
    expect(entries[0]?.aes).toBeNull()
    expect(await open(zip, 'secret123')).toEqual(expected)
  })
  it('encrypted when there is no password, wrong-password when it is wrong', async () => {
    expect(await reason(open(zip))).toBe('encrypted')
    for (const pw of ['secret124', '', 'x', 'SECRET123']) expect(await reason(open(zip, pw))).toBe('wrong-password')
  })
})

describe('WinZip AES-256 (7z, AE-2)', () => {
  const zip = new Uint8Array(readFileSync(join(fixtures, 'zip-aes256-pw-secret123.zip')))
  it('the listing shows the AES shape, and opens with the correct password', async () => {
    const { entries } = await readZipListing(bytesRangeSource(zip))
    expect(entries[0]?.encrypted).toBe(true)
    expect(entries[0]?.method).toBe(99)
    expect(entries[0]?.aes).toMatchObject({ strength: 3 })
    expect(await open(zip, 'secret123')).toEqual(expected)
  })
  it('a wrong password is wrong-password by the check value, and encrypted if none', async () => {
    expect(await reason(open(zip, 'nope'))).toBe('wrong-password')
    expect(await reason(open(zip))).toBe('encrypted')
  })
  it('corrupt by HMAC if the ciphertext is broken', async () => {
    const broken = zip.slice()
    const { entries } = await readZipListing(bytesRangeSource(zip))
    const entry = entries[0]
    if (entry === undefined) throw new Error('no entry')
    // The start of the ciphertext, after the local header + name + extra + salt (16) + check value (2).
    const at = entry.localHeaderOffset + 30 + 8 + 11 + 16 + 2 + 3
    broken[at] = (broken[at] ?? 0) ^ 0xff
    expect(await reason(open(broken, 'secret123'))).toBe('corrupt')
  })
})

// ---- assembled per the spec (AES-128 / 192, AE-1, stored) ----

function ctrKeystreamXor(key: Buffer, data: Uint8Array): Uint8Array {
  const algo = `aes-${key.length * 8}-ecb`
  const out = new Uint8Array(data.length)
  for (let at = 0, n = 1; at < data.length; at += 16, n++) {
    const block = Buffer.alloc(16)
    block.writeUInt32LE(n, 0)
    const stream = createCipheriv(algo, key, null).setAutoPadding(false).update(block)
    for (let i = 0; i < Math.min(16, data.length - at); i++) out[at + i] = (data[at + i] ?? 0) ^ (stream[i] ?? 0)
  }
  return out
}

function buildAesZip(strength: 1 | 2 | 3, version: 1 | 2, password: string, plain: Uint8Array, innerMethod: 0 | 8): Uint8Array {
  const keyLength = { 1: 16, 2: 24, 3: 32 }[strength]
  const salt = randomBytes({ 1: 8, 2: 12, 3: 16 }[strength])
  const derived = pbkdf2Sync(password, salt, 1000, keyLength * 2 + 2, 'sha1')
  const compressed = innerMethod === 8 ? new Uint8Array(deflateRawSync(plain)) : plain
  const cipher = ctrKeystreamXor(derived.subarray(0, keyLength), compressed)
  const mac = createHmac('sha1', derived.subarray(keyLength, keyLength * 2)).update(cipher).digest().subarray(0, 10)
  const body = Buffer.concat([salt, derived.subarray(keyLength * 2), cipher, mac])
  const name = Buffer.from('a.txt')
  const extra = Buffer.alloc(11)
  extra.writeUInt16LE(0x9901, 0)
  extra.writeUInt16LE(7, 2)
  extra.writeUInt16LE(version, 4)
  extra.write('AE', 6, 'latin1')
  extra.writeUInt8(strength, 8)
  extra.writeUInt16LE(innerMethod, 9)
  const crc = version === 1 ? zlibCrc32(plain) : 0
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(51, 4)
  local.writeUInt16LE(0x0801, 6)
  local.writeUInt16LE(99, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(plain.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(extra.length, 28)
  const localAll = Buffer.concat([local, name, extra, body])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x0333, 4)
  central.writeUInt16LE(51, 6)
  central.writeUInt16LE(0x0801, 8)
  central.writeUInt16LE(99, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(plain.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(extra.length, 30)
  const centralAll = Buffer.concat([central, name, extra])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralAll.length, 12)
  eocd.writeUInt32LE(localAll.length, 16)
  return new Uint8Array(Buffer.concat([localAll, centralAll, eocd]))
}

describe('WinZip AES combinations (zips built to the spec)', () => {
  const plain = new TextEncoder().encode('こんにちは、暗号化。'.repeat(40))
  for (const strength of [1, 2, 3] as const) {
    for (const version of [1, 2] as const) {
      for (const inner of [0, 8] as const) {
        it(`AES-${{ 1: 128, 2: 192, 3: 256 }[strength]} AE-${version} ${inner === 8 ? 'deflate' : 'stored'}`, async () => {
          const zip = buildAesZip(strength, version, 'pässword', plain, inner)
          expect(await open(zip, 'pässword')).toEqual(plain)
          expect(await reason(open(zip, 'password'))).toBe('wrong-password')
        })
      }
    }
  }
  it('AE-1 also checks CRC-32 (corrupt if the CRC lies)', async () => {
    const zip = buildAesZip(3, 1, 'pw', plain, 8)
    const view = new DataView(zip.buffer)
    // Rewrites only the CRC of the central directory (central's +16).
    const centralAt = zip.length - 22 - 46 - 5 - 11
    view.setUint32(centralAt + 16, view.getUint32(centralAt + 16, true) ^ 1, true)
    expect(await reason(open(zip, 'pw'))).toBe('corrupt')
  })
  it('with AES stored, a decrypted size different from the declared one is corrupt (not wrong-password)', async () => {
    const zip = buildAesZip(3, 1, 'pw', plain, 0)
    const view = new DataView(zip.buffer)
    const centralAt = zip.length - 22 - 46 - 5 - 11
    view.setUint32(centralAt + 24, view.getUint32(centralAt + 24, true) + 1, true)
    expect(await reason(open(zip, 'pw'))).toBe('corrupt')
  })
})

describe('encryptionSupport (judgment before asking for a password)', () => {
  const plain = new TextEncoder().encode('abc'.repeat(30))
  async function firstEntry(bytes: Uint8Array) {
    const { entries } = await readZipListing(bytesRangeSource(bytes))
    const entry = entries[0]
    if (entry === undefined) throw new Error('no entry')
    return entry
  }
  it('AES (with the extension) is supported, and no encryption is supported', async () => {
    expect(encryptionSupport(await firstEntry(buildAesZip(3, 2, 'pw', plain, 8)))).toEqual({ supported: true })
    expect(encryptionSupport({ encrypted: false } as never)).toEqual({ supported: true })
  })
  it('the strong-encryption flag and AES without the extension are unsupported', async () => {
    const entry = await firstEntry(buildAesZip(3, 2, 'pw', plain, 8))
    expect(encryptionSupport({ ...entry, flags: entry.flags | 0x40 }).supported).toBe(false)
    expect(encryptionSupport({ ...entry, aes: null }).supported).toBe(false)
  })
})

describe('small AES-CTR (little-endian counter)', () => {
  it("the same key stream as Node's AES (128 / 192 / 256, with partial blocks)", () => {
    for (const bytes of [16, 24, 32]) {
      const key = randomBytes(bytes)
      const data = randomBytes(16 * 37 + 5)
      expect(aesCtrLittleEndian(key, data)).toEqual(ctrKeystreamXor(key, data))
    }
  })
})
