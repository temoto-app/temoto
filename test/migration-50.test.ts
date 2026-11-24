/**
 * migration 50 (TODO 1284 item 2): the uri index on plugin_documents that PluginDocumentStore.readByUri relies on.
 */
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../src/common/migrations.js'

const opened: Db[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function open(): Db {
  const db = new Database(':memory:')
  opened.push(db)
  runMigrations(db)
  return db
}

describe('migration 50 (TODO 1284)', () => {
  it('answers the readByUri candidate lookup from the uri index', () => {
    const db = open()
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT source, source_id FROM plugin_documents
         WHERE uri = @uri AND (source = @id OR substr(source, 1, @prefixLength) IN (@colon, @slash))
         ORDER BY updated_at DESC, source, source_id`
      )
      .all({ uri: 'x://1', id: 'p', prefixLength: 2, colon: 'p:', slash: 'p/' }) as { detail: string }[]
    expect(plan.map((row) => row.detail).join('\n')).toContain('USING INDEX plugin_documents_uri')
  })

  it('applies to existing rows, can be re-applied, and is not UNIQUE (two rows may share a uri)', () => {
    const db = open()
    db.exec('DROP INDEX plugin_documents_uri')
    db.pragma('user_version = 49')
    const insert = db.prepare(
      `INSERT INTO plugin_documents (source, source_id, title, uri, body, updated_at) VALUES (?, ?, 't', ?, 'b', 0)`
    )
    insert.run('p:a', '1', 'x://same')
    insert.run('p:b', '2', 'x://same')
    expect(runMigrations(db)).toBeGreaterThanOrEqual(50)
    db.pragma('user_version = 49')
    expect(runMigrations(db)).toBeGreaterThanOrEqual(50)
    const rows = db.prepare(`SELECT source FROM plugin_documents INDEXED BY plugin_documents_uri WHERE uri = ?`).all('x://same')
    expect(rows).toHaveLength(2)
  })
})
