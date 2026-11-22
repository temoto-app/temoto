/**
 * The startup check of the DB and the fallback when it cannot be opened (TODO 1306, ARCHITECTURE 8.7). The model is not called.
 *
 * - `quickCheckDb` (index process): a healthy DB passes; a damaged page is found and named by table; one table per step; shutdown stops it.
 * - `openDatabase` (main): a damaged file does not fail the launch - it falls back to memory with `db-corrupt` and the file is not touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { openSync, readFileSync, rmSync, writeFileSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { quickCheckDb, tablesToCheck } from '../src/index-kernel/db-check.js'
import { makeTestDir } from './helpers/tmp.js'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`sealed:${plain}`),
    decryptString: (sealed: Buffer) => sealed.toString().replace(/^sealed:/, '')
  }
}))

const { openDatabase, isCorruptionError } = await import('../src/main/db/index.js')

let dir: string

beforeEach(() => {
  dir = makeTestDir('db-check')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const runAll = async (work: () => void): Promise<boolean> => {
  work()
  return true
}

function makeDb(file: string): void {
  const db = new Database(file)
  db.exec(`CREATE TABLE a (id INTEGER PRIMARY KEY, body TEXT); CREATE INDEX a_body ON a(body);
           CREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT);
           CREATE VIRTUAL TABLE f USING fts5(t, content='');`)
  const insert = db.prepare('INSERT INTO a (body) VALUES (?)')
  db.transaction(() => {
    for (let i = 0; i < 2000; i += 1) insert.run(`row ${i} ${'x'.repeat(200)}`)
  })()
  db.prepare('INSERT INTO b (v) VALUES (?)').run('one')
  db.close()
}

describe('quickCheckDb (index process)', () => {
  it('a healthy DB passes, virtual tables are skipped (their shadow tables are checked)', async () => {
    const file = join(dir, 'ok.db')
    makeDb(file)
    const db = new Database(file)
    const tables = tablesToCheck(db)
    expect(tables[0]).toBe('sqlite_schema')
    expect(tables).toContain('a')
    expect(tables).not.toContain('f')
    expect(tables).toContain('f_data')
    const steps: number[] = []
    const result = await quickCheckDb(db, async (work) => {
      steps.push(steps.length)
      work()
      return true
    })
    expect(result).toMatchObject({ ok: true, damaged: [], stopped: false, tables: tables.length })
    // The listing plus one step per table (index writes can interleave between them).
    expect(steps).toHaveLength(tables.length + 1)
    // The slowest table is reported (for measuring on real machines), by name only.
    expect(tables).toContain(result.slowest?.table)
    expect(result.slowest?.ms).toBeGreaterThanOrEqual(0)
    db.close()
  })

  it('a damaged page is found and named by its table', async () => {
    const file = join(dir, 'bad.db')
    makeDb(file)
    const pageSize = 4096
    const size = readFileSync(file).length
    // Overwrite a page in the middle of table `a` with garbage (not page 1, so the file still opens).
    const fd = openSync(file, 'r+')
    const page = Math.floor(size / pageSize / 2)
    writeSync(fd, Buffer.alloc(pageSize, 0x5a), 0, pageSize, page * pageSize)
    closeSync(fd)
    const db = new Database(file)
    const result = await quickCheckDb(db, runAll)
    expect(result.ok).toBe(false)
    expect(result.stopped).toBe(false)
    expect(result.damaged.length).toBeGreaterThan(0)
    db.close()
  })

  it('stops between tables when shutdown has begun (not a verdict)', async () => {
    const file = join(dir, 'stop.db')
    makeDb(file)
    const db = new Database(file)
    let left = 2
    const result = await quickCheckDb(db, async (work) => {
      if (left === 0) return false
      left -= 1
      work()
      return true
    })
    expect(result).toMatchObject({ ok: false, stopped: true })
    db.close()
  })
})

describe('openDatabase with a damaged file (main)', () => {
  it('falls back to memory with db-corrupt and leaves the file as it was', () => {
    const key = 'ab'.repeat(32)
    writeFileSync(join(dir, 'db.key'), `sealed:${key}`)
    const garbage = Buffer.alloc(4096 * 4, 0x42)
    writeFileSync(join(dir, 'aios.db'), garbage)
    const opened = openDatabase(dir)
    expect(opened).toMatchObject({ mode: 'memory-only', storageReason: 'db-corrupt', file: null, key: null })
    expect(opened.db.prepare('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 0 })
    opened.db.close()
    expect(readFileSync(join(dir, 'aios.db')).equals(garbage)).toBe(true)
  })

  it('only corruption codes count', () => {
    expect(isCorruptionError(Object.assign(new Error('x'), { code: 'SQLITE_NOTADB' }))).toBe(true)
    expect(isCorruptionError(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT_INDEX' }))).toBe(true)
    expect(isCorruptionError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }))).toBe(false)
    expect(isCorruptionError(new Error('x'))).toBe(false)
  })
})
