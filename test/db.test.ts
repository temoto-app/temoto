/**
 * Unit tests for the DB (ARCHITECTURE.md chapter 8 / constraint 11).
 *
 * `key.ts` depends on Electron's `safeStorage`, so it is not handled here
 * (verified by starting the real app). What is checked here is the encryption itself and the migrations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { DatabaseTooNewError, LATEST_KNOWN_MIGRATION, MIGRATIONS, runMigrations } from '../src/common/migrations.js'
import { openDatabaseFile } from '../src/common/db-open.js'
import { makeTestDir } from './helpers/tmp.js'

// `db/index.ts` reaches electron through `key.ts`. What is wanted here is only PRAGMA,
// so safeStorage is stubbed out (key retrieval itself is confirmed by starting the real app).
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

const { JOURNAL_SIZE_LIMIT, truncateOversizedWal } = await import(
  '../src/main/db/index.js'
)

const KEY = 'a'.repeat(64)
const dirs: string[] = []

function newDbPath(): string {
  const dir = makeTestDir('db-test')
  dirs.push(dir)
  return join(dir, 'aios.db')
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('migrations', () => {
  it('raises user_version to the latest and does not increase on rerun', () => {
    const db = new Database(newDbPath())
    db.pragma(`key='${KEY}'`)

    const applied = runMigrations(db)
    const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
    expect(applied).toBe(latest)
    expect(db.pragma('user_version', { simple: true })).toBe(latest)

    expect(runMigrations(db)).toBe(latest)
    db.close()
  })

  it('downgrade safety net (TODO 103): an encrypted DB whose user_version is newer than the latest it knows throws without opening or writing anything', () => {
    // A real encrypted DB (a file on disk). To avoid the pitfall that "in-memory does not accept PRAGMA key" (Phase 1),
    // it is created on disk, the same as all the other tests in `db.test.ts`.
    const path = newDbPath()
    const db = new Database(path)
    db.pragma(`key='${KEY}'`)
    runMigrations(db) // First, bring it up to the latest normally.
    const future = LATEST_KNOWN_MIGRATION + 1
    // Imitates "a newer version created it": only advance user_version to a future number
    // (the same state as when the next version adds one migration).
    db.pragma(`user_version = ${future}`)
    db.close()

    // Reopen on a separate connection (the same meaning as separate processes: this version's runMigrations
    // faces it for the first time).
    const reopened = new Database(path)
    reopened.pragma(`key='${KEY}'`)
    let thrown: unknown = null
    try {
      runMigrations(reopened)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DatabaseTooNewError)
    expect((thrown as DatabaseTooNewError).dbVersion).toBe(future)
    expect((thrown as DatabaseTooNewError).knownVersion).toBe(LATEST_KNOWN_MIGRATION)
    // Nothing was written: user_version stays as is (because migrations only move forward, it must neither be lowered nor changed).
    expect(reopened.pragma('user_version', { simple: true })).toBe(future)
    reopened.close()
  })

  it('creates documents / chunks / chunk_fts / scan_denials / scan_runs', () => {
    const db = new Database(newDbPath())
    db.pragma(`key='${KEY}'`)
    runMigrations(db)

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((row) => row.name)
    // Phase 3: `files` was dropped by merging it into `documents` (homework from 12.4).
    expect(tables).toEqual(
      expect.arrayContaining(['documents', 'chunks', 'chunk_fts', 'scan_denials', 'scan_runs'])
    )
    expect(tables).not.toContain('files')
    db.close()
  })

  it('the same name under the same parent converges to one row (APFS does not distinguish case)', () => {
    const db = new Database(newDbPath())
    db.pragma(`key='${KEY}'`)
    runMigrations(db)

    const insert = db.prepare(`
      INSERT INTO documents (source, parent_id, name, name_folded, kind, ext, seen_at)
      VALUES ('fs', 1, ?, ?, 'file', 'txt', 1)
      ON CONFLICT(parent_id, name_folded) WHERE source = 'fs' DO UPDATE SET name = excluded.name
    `)
    insert.run('A.txt', 'a.txt')
    insert.run('a.txt', 'a.txt')

    const count = db.prepare(`SELECT count(*) AS n FROM documents`).get() as { n: number }
    expect(count.n).toBe(1)
    db.close()
  })

  it('migration 7 (thread-defaults): creates model_id / thinking / setting_sources in threads, and cwd_history', () => {
    const db = new Database(newDbPath())
    db.pragma(`key='${KEY}'`)
    runMigrations(db)

    const columns = (db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[]).map(
      (row) => row.name
    )
    expect(columns).toEqual(expect.arrayContaining(['model_id', 'thinking', 'setting_sources', 'backend']))
    // load_user_settings (one boolean) was replaced with setting_sources (4.6.2).
    expect(columns).not.toContain('load_user_settings')
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((row) => row.name)
    expect(tables).toContain('cwd_history')
    db.close()
  })

  it("migration 7 copies the existing rows' load_user_settings into setting_sources", () => {
    const db = new Database(newDbPath())
    db.pragma(`key='${KEY}'`)
    // Make a DB with migrations up to 6 applied, insert rows with the old columns, then apply 7.
    for (const migration of MIGRATIONS) if (migration.version <= 6) db.exec(migration.up)
    db.pragma('user_version = 6')
    const insert = db.prepare(
      `INSERT INTO threads (id, title, cwd, load_user_settings, created_at, updated_at)
       VALUES (?, 't', '/x', ?, 1, 1)`
    )
    insert.run('unsafe', 1)
    insert.run('safe', 0)

    // From 7 onward (8 and later) also apply together, so the version number becomes the latest.
    expect(runMigrations(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0)
    const rows = db.prepare(`SELECT id, setting_sources FROM threads ORDER BY id`).all() as {
      id: string
      setting_sources: string
    }[]
    expect(rows).toEqual([
      // 0 (= "") is project only: the instruction file starts to take effect (the purpose of T5).
      { id: 'safe', setting_sources: '["project"]' },
      { id: 'unsafe', setting_sources: '["user","project","local"]' }
    ])
    db.close()
  })

  it('migration 8 (file-name-search): creates the covering partial index and drops the old documents_name', () => {
    const db = new Database(newDbPath())
    db.pragma(`key='${KEY}'`)
    runMigrations(db)

    const indexes = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]
    ).map((row) => row.name)
    expect(indexes).toEqual(expect.arrayContaining(['documents_name_scan', 'documents_dir_tree']))
    // LIKE '%q%' gets a % in front, so this index had never been usable (6.6).
    expect(indexes).not.toContain('documents_name')

    // Candidate supply must be done with **only the covering index**. Touching the table would freeze at 1 million rows.
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id, name, parent_id FROM documents
           INDEXED BY documents_name_scan WHERE source = 'fs' AND id > ? ORDER BY id LIMIT ?`
        )
        .all(0, 10) as { detail: string }[]
    ).map((row) => row.detail)
    expect(plan.join(' ')).toContain('COVERING INDEX documents_name_scan')
    // No temporary B-tree may be created for ORDER BY.
    expect(plan.join(' ')).not.toContain('TEMP B-TREE')
    db.close()
  })

  it('a failed migration does not raise the version', () => {
    const db = new Database(newDbPath())
    db.pragma(`key='${KEY}'`)
    runMigrations(db)
    const before = db.pragma('user_version', { simple: true })

    // Runs the same shape as a failure in the middle of a migration (BEGIN -> failure -> ROLLBACK).
    expect(() => {
      db.exec('BEGIN')
      try {
        db.exec('CREATE TABLE ok (a); CREATE TABLE ok (a);')
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }).toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(before)
    expect(
      db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name='ok'`).get()
    ).toEqual({ n: 0 })
    db.close()
  })
})

describe('encryption (not a recheck of spike 11b, but a check that the implementation applies the key)', () => {
  it('opening without the key gives file is not a database', () => {
    const path = newDbPath()
    const db = new Database(path)
    db.pragma(`key='${KEY}'`)
    runMigrations(db)
    db.close()

    const reopened = new Database(path)
    expect(() => reopened.prepare('SELECT count(*) FROM documents').get()).toThrow(
      /file is not a database/
    )
    reopened.close()
  })

  it('no plaintext appears on disk and no SQLite header remains', () => {
    const path = newDbPath()
    const db = new Database(path)
    db.pragma(`key='${KEY}'`)
    runMigrations(db)
    db.prepare(`
      INSERT INTO documents (source, parent_id, name, name_folded, kind, ext, seen_at)
      VALUES ('fs', NULL, ?, ?, 'file', 'txt', 1)
    `).run('SECRET-MARKER.txt', 'secret-marker.txt')
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()

    const raw = readFileSync(path)
    expect(raw.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3')
    expect(raw.includes(Buffer.from('SECRET-MARKER'))).toBe(false)
  })

  it('readable with the right key', () => {
    const path = newDbPath()
    const db = new Database(path)
    db.pragma(`key='${KEY}'`)
    runMigrations(db)
    db.close()

    const reopened = new Database(path)
    reopened.pragma(`key='${KEY}'`)
    expect(reopened.prepare('SELECT count(*) AS n FROM documents').get()).toEqual({ n: 0 })
    reopened.close()
  })
})

describe('WAL (P7): journal_size_limit and truncation at startup', () => {
  it('journal_size_limit reads back as 64 MB', () => {
    const db = openDatabaseFile(newDbPath(), KEY)

    expect(JOURNAL_SIZE_LIMIT).toBe(64 * 1024 * 1024)
    expect(db.pragma('journal_size_limit', { simple: true })).toBe(JOURNAL_SIZE_LIMIT)
    // Applied after journal_mode (without WAL, SQLite silently ignores it).
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    db.close()
  })

  it('a WAL over the limit is truncated with TRUNCATE once at startup', () => {
    const path = newDbPath()
    const db = openDatabaseFile(path, KEY)
    runMigrations(db)

    // Grows the WAL. With no checkpoint in between, it accumulates in -wal.
    const insert = db.prepare(`
      INSERT INTO documents (source, parent_id, name, name_folded, kind, ext, seen_at)
      VALUES ('fs', NULL, ?, ?, 'file', 'txt', 1)
    `)
    db.transaction(() => {
      for (let i = 0; i < 2000; i += 1) insert.run(`f${i}.txt`, `f${i}.txt`)
    })()
    const grown = statSync(`${path}-wal`).size
    expect(grown).toBeGreaterThan(0)

    // The limit can be injected (writing the real 64 MB in a test is expensive).
    truncateOversizedWal(db, path, 1024)
    expect(statSync(`${path}-wal`).size).toBe(0)

    // The contents remain (TRUNCATE flushes the WAL into the main file and then truncates it).
    expect(db.prepare(`SELECT count(*) AS n FROM documents`).get()).toEqual({ n: 2000 })
    db.close()
  })

  it('does not touch a WAL at or below the limit', () => {
    const path = newDbPath()
    const db = openDatabaseFile(path, KEY)
    runMigrations(db)
    db.prepare(`
      INSERT INTO documents (source, parent_id, name, name_folded, kind, ext, seen_at)
      VALUES ('fs', NULL, 'a.txt', 'a.txt', 'file', 'txt', 1)
    `).run()

    const before = statSync(`${path}-wal`).size
    expect(before).toBeGreaterThan(0)
    truncateOversizedWal(db, path, JOURNAL_SIZE_LIMIT)
    expect(statSync(`${path}-wal`).size).toBe(before)
    db.close()
  })

  it('does not fail even when there is no WAL yet (a new DB)', () => {
    const path = newDbPath()
    const db = new Database(path)
    db.pragma(`key='${KEY}'`)
    expect(() => truncateOversizedWal(db, path, 0)).not.toThrow()
    db.close()
  })
})
