/**
 * Wave 42 code-review: prefix matching on the index side (removeBySourcePrefix / removeConversationsBefore) is made into a range condition, so that the `documents_source` index is used (LIKE was a full scan). The model is not called.
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore, prefixRange } from '../src/index-kernel/store.js'

let db: Db | null = null
afterEach(() => {
  db?.close()
  db = null
})

function open(): { db: Db; store: IndexStore } {
  db = new Database(':memory:')
  runMigrations(db)
  return { db, store: new IndexStore(db) }
}

function add(d: Db, source: string, sourceId: string, updatedAt = 0): void {
  d.prepare(
    `INSERT INTO documents (source, source_id, name, name_folded, updated_at, kind) VALUES (?, ?, ?, ?, ?, 'file')`
  ).run(source, sourceId, sourceId, sourceId, updatedAt)
}

function ids(d: Db, source: string): string[] {
  return d.prepare(`SELECT source_id FROM documents WHERE source = ? ORDER BY source_id`).pluck().all(source) as string[]
}

describe('prefixRange', () => {
  it('returns the upper bound with the last character advanced by one; empty gives null', () => {
    expect(prefixRange('abc:')).toEqual({ from: 'abc:', to: 'abc;' })
    expect(prefixRange('')).toBeNull()
  })
})

describe('prefix delete', () => {
  it('% and _ are literal characters; other threads and case differences are not deleted', () => {
    const { db: d, store } = open()
    for (const id of ['a_b:1', 'axb:1', 'a%:1', 'A_B:1', 'a_b:2']) add(d, 'conversation', id)
    add(d, 'transcript', 'a_b:1')
    expect(store.removeBySourcePrefix('conversation', 'a_b:')).toBe(2)
    expect(ids(d, 'conversation')).toEqual(['A_B:1', 'a%:1', 'axb:1'])
    expect(ids(d, 'transcript')).toEqual(['a_b:1'])
    expect(store.removeBySourcePrefix('conversation', '')).toBe(3)
    expect(ids(d, 'conversation')).toEqual([])
  })

  it('removeConversationsBefore deletes only those with updated_at before the boundary', () => {
    const { db: d, store } = open()
    add(d, 'conversation', 't_1:a', 100)
    add(d, 'conversation', 't_1:b', 900)
    add(d, 'conversation', 'tx1:a', 100)
    expect(store.removeConversationsBefore('t_1', 500)).toBe(1)
    expect(ids(d, 'conversation')).toEqual(['t_1:b', 'tx1:a'])
  })

  it('both SELECTs are a SEARCH using the documents_source index', () => {
    const { db: d, store } = open()
    const priv = store as unknown as Record<string, { source: string }>
    const cases: [string, unknown[]][] = [
      ['selectBySourcePrefix', ['conversation', 'a', 'b']],
      ['selectConversationsBefore', ['a', 'b', 1]]
    ]
    for (const [name, args] of cases) {
      const plan = d.prepare(`EXPLAIN QUERY PLAN ${priv[name]!.source}`).all(...args) as { detail: string }[]
      const detail = plan.map((row) => row.detail).join('\n')
      expect(detail, name).toMatch(/SEARCH documents USING (COVERING )?INDEX documents_source/)
    }
  })
})
