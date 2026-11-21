/**
 * Time taken by migration 15 (items 83 / 84). The DROP COLUMN of `documents.sensitivity` **rewrites the whole table** (this is how
 * SQLite's ALTER TABLE DROP COLUMN is implemented), so this measures how many seconds startup stops for, with a `documents` table
 * at real-machine scale (114.7 × 10,000 = 1,147,000 rows). It calls no model.
 *
 *   npx vite-node -c vitest.config.ts scripts/bench/migration-15.mts -- [document count]
 *
 * It builds an encrypted file DB (the same PRAGMAs as `openDatabaseFile`) at migration 14 and fills it with fs rows (directories 1/8,
 * files 7/8, with names, versions, hashes and metadata). Then it reopens the DB (with an empty page cache) and applies only 15 with
 * `runMigrations`. It deletes the DB when done.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabaseFile } from '../../src/common/db-open.js'
import { MIGRATIONS, runMigrations } from '../../src/common/migrations.js'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const COUNT = Number(argv[0] ?? 1_150_000)
const KEY = 'e'.repeat(64)
const dir = mkdtempSync(join(tmpdir(), 'aios-m15-bench-'))
const file = join(dir, 'aios.db')

try {
  const db = openDatabaseFile(file, KEY)
  for (const migration of MIGRATIONS) {
    if (migration.version > 14) break
    db.exec(migration.up)
  }
  db.pragma('user_version = 14')

  const insert = db.prepare(`
    INSERT INTO documents (id, source, parent_id, name, name_folded, kind, ext, size, mtime_ms,
                           updated_at, version, content_hash, lang, metadata, index_state, seen_at)
    VALUES (?, 'fs', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const started = Date.now()
  db.transaction(() => {
    insert.run(1, null, '/', '/', 'directory', '', 0, 0, 0, '', null, null, null, 'skipped', 1)
    for (let id = 2; id <= COUNT; id += 1) {
      const dirRow = id % 8 === 0
      const parent = Math.floor(id / 8) * 8
      const parentId = parent >= id || parent < 8 ? 1 : parent
      const name = dirRow ? `directory-${id.toString(36)}` : `file-${id.toString(36)}.ts`
      insert.run(
        id,
        parentId,
        name,
        name.toLowerCase(),
        dirRow ? 'directory' : 'file',
        dirRow ? '' : 'ts',
        dirRow ? 0 : 1000 + (id % 50_000),
        1_700_000_000_000 + id,
        1_700_000_000_000 + id,
        `${1_700_000_000_000 + id}:${id % 50_000}`,
        dirRow ? null : 'a'.repeat(64),
        dirRow ? null : 'en',
        dirRow ? null : '{"lines":120}',
        dirRow ? 'skipped' : 'indexed',
        1_700_000_000_000
      )
    }
  })()
  db.pragma('wal_checkpoint(TRUNCATE)')
  console.log(
    `fill: ${COUNT.toLocaleString()} rows in ${Date.now() - started} ms, db ${(statSync(file).size / 1e6).toFixed(1)} MB`
  )
  db.close()

  const reopened = openDatabaseFile(file, KEY)
  const t0 = performance.now()
  const version = runMigrations(reopened)
  const ms = performance.now() - t0
  const cols = (reopened.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[]).map(
    (c) => c.name
  )
  console.log(
    `migration 15: ${ms.toFixed(0)} ms (user_version ${version}, sensitivity ${cols.includes('sensitivity') ? 'remains' : 'dropped'})`
  )
  reopened.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}
