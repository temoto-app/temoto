/**
 * DB breakdown (TODO 846 / 914 / 988, wave 61 bundle D). Measured against a fake DB (a temp file, not encrypted), and checks that
 * the list of tables, row counts, freelist_count, and WAL are returned. The model is not called.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { measureDb } from '../src/index-kernel/db-breakdown.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

const dir = makeTestDir('db-breakdown')
afterAll(() => removeTestDir(dir))

describe('measureDb', () => {
  it('lists tables with sizes and rows, and reports freelist pages', async () => {
    const db = new Database(join(dir, 'a.db'))
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE big(id INTEGER PRIMARY KEY, body TEXT); CREATE INDEX big_body ON big(body); CREATE TABLE small(x)')
    const insert = db.prepare('INSERT INTO big(body) VALUES (?)')
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) insert.run('x'.repeat(200) + i)
    })()
    db.exec('DELETE FROM big WHERE id > 100')
    db.pragma('wal_checkpoint(TRUNCATE)')

    const out = await measureDb(db, 10)
    const names = out.entries.map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['big', 'big_body', 'small']))
    expect(out.dbstatAvailable).toBe(true)
    expect(out.entries[0]!.bytes).toBeGreaterThanOrEqual(out.entries[out.entries.length - 1]!.bytes!)
    expect(out.entries.find((e) => e.name === 'big')).toMatchObject({ kind: 'table', rows: 100 })
    expect(out.entries.find((e) => e.name === 'big_body')).toMatchObject({ kind: 'index', rows: null })
    expect(out.freelistPages).toBeGreaterThan(0)
    expect(out.reclaimableBytes).toBe(out.freelistPages * out.pageSize)
    expect(out.fileBytes).toBeGreaterThan(out.reclaimableBytes)
    expect(out.walBytes).toBeGreaterThanOrEqual(0)
    db.close()
  })

  it('truncates to the top N and reports the total', async () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE a(x); CREATE TABLE b(x); CREATE TABLE c(x)')
    const out = await measureDb(db, 2)
    expect(out.entries).toHaveLength(2)
    expect(out.totalEntries).toBeGreaterThanOrEqual(3)
    db.close()
  })

  it('does not count virtual tables (FTS5) but counts plain ones, and yields between stages', async () => {
    const db = new Database(':memory:')
    db.exec("CREATE VIRTUAL TABLE docs_fts USING fts5(body); CREATE TABLE plain(x); INSERT INTO plain VALUES (1)")
    db.exec("INSERT INTO docs_fts(body) VALUES ('hello')")
    let yields = 0
    const out = await measureDb(db, 30, async () => {
      yields++
    })
    expect(out.entries.find((e) => e.name === 'docs_fts')).toMatchObject({ kind: 'table', rows: null })
    expect(out.entries.find((e) => e.name === 'plain')).toMatchObject({ rows: 1 })
    expect(yields).toBeGreaterThan(2)
    db.close()
  })
})
