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
  it('鍵も DB も無ければ鍵を作って封じて書く', () => {
    const got = getOrCreateDatabaseKey(dir, dbFile)
    expect(got.mode).toBe('encrypted')
    expect(got.reason).toBeNull()
    expect(got.key).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(keyFile, 'utf8')).toBe(`sealed:${got.key}`)
  })

  it('鍵があれば読む', () => {
    writeFileSync(keyFile, 'sealed:abc')
    writeFileSync(dbFile, 'x')
    expect(getOrCreateDatabaseKey(dir, dbFile)).toEqual({ key: 'abc', mode: 'encrypted', reason: null })
  })

  it('鍵が無く中身のある DB だけがあれば、鍵を作らず memory-only (DB は消さない・書き換えない)', () => {
    writeFileSync(dbFile, 'existing encrypted database')
    expect(getOrCreateDatabaseKey(dir, dbFile)).toEqual({ key: null, mode: 'memory-only', reason: 'db-key-missing' })
    expect(existsSync(keyFile)).toBe(false)
    expect(readFileSync(dbFile, 'utf8')).toBe('existing encrypted database')
  })

  it('WAL だけが残っている場合も鍵を作らない', () => {
    writeFileSync(`${dbFile}-wal`, 'frames')
    expect(getOrCreateDatabaseKey(dir, dbFile).reason).toBe('db-key-missing')
    expect(existsSync(keyFile)).toBe(false)
  })

  it('0 バイトの DB は中身が無いので鍵を作ってよい', () => {
    writeFileSync(dbFile, '')
    const got = getOrCreateDatabaseKey(dir, dbFile)
    expect(got.mode).toBe('encrypted')
    expect(existsSync(keyFile)).toBe(true)
  })

  it('鍵を復号できなければ memory-only (理由は undecryptable)。鍵は上書きしない', () => {
    writeFileSync(keyFile, 'sealed:abc')
    fake.undecryptable = true
    expect(getOrCreateDatabaseKey(dir, dbFile)).toEqual({ key: null, mode: 'memory-only', reason: 'db-key-undecryptable' })
    expect(readFileSync(keyFile, 'utf8')).toBe('sealed:abc')
  })

  it('キーチェーンが使えなければ memory-only (理由は keychain-unavailable)。何も書かない', () => {
    fake.available = false
    expect(getOrCreateDatabaseKey(dir, dbFile)).toEqual({ key: null, mode: 'memory-only', reason: 'db-keychain-unavailable' })
    expect(existsSync(keyFile)).toBe(false)
  })
})
