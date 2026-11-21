/**
 * Getting the DB key (`src/main/db/key.ts`, TODO 1129). `safeStorage` is a fake (sealing = only marking the head).
 *
 * What to check: if the key file is missing but a DB with contents exists, it does not create the key (does not write one) and degrades to `memory-only`.
 * If it were created, the existing DB could not be opened (startup keeps failing), and even if the original key is found it has already been overwritten and cannot be restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestDir } from './helpers/tmp.js'

const fake = vi.hoisted(() => ({ available: true, undecryptable: false }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => fake.available,
    encryptString: (plain: string) => Buffer.from(`sealed:${plain}`),
    decryptString: (sealed: Buffer) => {
      if (fake.undecryptable) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return sealed.toString().replace(/^sealed:/, '')
    }
  }
}))

const { getOrCreateDatabaseKey } = await import('../src/main/db/key.js')

let dir: string
let dbFile: string
let keyFile: string

beforeEach(() => {
  fake.available = true
  fake.undecryptable = false
  dir = makeTestDir('db-key')
  dbFile = join(dir, 'aios.db')
  keyFile = join(dir, 'db.key')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('getOrCreateDatabaseKey (TODO 1129)', () => {
  it('with neither a key nor a DB, makes a key, seals and writes', () => {
    const got = getOrCreateDatabaseKey(dir, dbFile)
    expect(got.mode).toBe('encrypted')
    expect(got.reason).toBeNull()
    expect(got.key).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(keyFile, 'utf8')).toBe(`sealed:${got.key}`)
  })

  it('reads when there is a key', () => {
    writeFileSync(keyFile, 'sealed:abc')
    writeFileSync(dbFile, 'x')
    expect(getOrCreateDatabaseKey(dir, dbFile)).toEqual({ key: 'abc', mode: 'encrypted', reason: null })
  })

  it('with no key and only a DB with content, makes no key and is memory-only (the DB is not deleted or rewritten)', () => {
    writeFileSync(dbFile, 'existing encrypted database')
    expect(getOrCreateDatabaseKey(dir, dbFile)).toEqual({ key: null, mode: 'memory-only', reason: 'db-key-missing' })
    expect(existsSync(keyFile)).toBe(false)
    expect(readFileSync(dbFile, 'utf8')).toBe('existing encrypted database')
  })

  it('does not make a key when only a WAL remains', () => {
    writeFileSync(`${dbFile}-wal`, 'frames')
    expect(getOrCreateDatabaseKey(dir, dbFile).reason).toBe('db-key-missing')
    expect(existsSync(keyFile)).toBe(false)
  })

  it('a 0-byte DB has no content, so making a key is fine', () => {
    writeFileSync(dbFile, '')
    const got = getOrCreateDatabaseKey(dir, dbFile)
    expect(got.mode).toBe('encrypted')
    expect(existsSync(keyFile)).toBe(true)
  })

  it('when the key cannot be decrypted, memory-only (reason undecryptable); the key is not overwritten', () => {
    writeFileSync(keyFile, 'sealed:abc')
    fake.undecryptable = true
    expect(getOrCreateDatabaseKey(dir, dbFile)).toEqual({ key: null, mode: 'memory-only', reason: 'db-key-undecryptable' })
    expect(readFileSync(keyFile, 'utf8')).toBe('sealed:abc')
  })

  it('when the keychain is unavailable, memory-only (reason keychain-unavailable); writes nothing', () => {
    fake.available = false
    expect(getOrCreateDatabaseKey(dir, dbFile)).toEqual({ key: null, mode: 'memory-only', reason: 'db-keychain-unavailable' })
    expect(existsSync(keyFile)).toBe(false)
  })
})
