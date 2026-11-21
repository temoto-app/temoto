/**
 * TODO 1235: `IndexService.resolveDocument` — the entry point that looks up one id by (source, source_id) or by uri.
 * Exact match only; does not look up fs; an audience the agent cannot see counts as "none"; 0 or several matches return the reason.
 * Does not call the model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import type { Exposure } from '../src/shared/search.js'
import { makeTestDir } from './helpers/tmp.js'

let dir: string
let db: Db
let store: IndexStore
let service: IndexService

function put(source: string, sourceId: string, uri: string, exposure: Exposure = 'ui+ai'): number {
  return store.upsertDocument({
    source,
    sourceId,
    uri,
    name: sourceId,
    kind: 'message',
    updatedAt: 1,
    version: 'v1',
    exposure,
    metadata: {},
    seenAt: 1
  }).id
}

beforeEach(() => {
  dir = makeTestDir('resolve-document')
  db = new Database(join(dir, 'aios.db'))
  db.pragma(`key='${'d'.repeat(64)}'`)
  runMigrations(db)
  store = new IndexStore(db)
  service = new IndexService({
    db,
    store,
    conversation: { readEventText: async () => null, threadTitle: async () => null, liveEventIds: async (ids) => ids },
    transcripts: null,
    onStatus: () => {}
  })
})

afterEach(() => {
  if (db.open) db.close()
  rmSync(dir, { recursive: true, force: true })
})

const none = { uri: '', source: '', sourceId: '' }

describe('resolveDocument', () => {
  it('can be looked up as one row by (source, source_id)', () => {
    const id = put('aios.gmail', 'm1', 'gmail://t-m1/m1')
    expect(service.resolveDocument({ ...none, source: 'aios.gmail', sourceId: 'm1' }, true)).toEqual({ id: String(id) })
  })

  it('the uri is looked up in SQL with the source attached; a different source does not match', () => {
    const id = put('aios.gmail', 'm1', 'gmail://t-m1/m1')
    expect(service.resolveDocument({ ...none, uri: 'gmail://t-m1/m1', source: 'aios.gmail' }, true)).toEqual({ id: String(id) })
    expect(service.resolveDocument({ ...none, uri: 'gmail://t-m1/m1', source: 'other' }, true)).toEqual({ reason: 'not-found' })
  })

  it('no normalization: differences in case, trailing slash, or surrounding whitespace do not match', () => {
    put('aios.gmail', 'm1', 'gmail://t-m1/m1')
    for (const uri of ['GMAIL://t-m1/m1', 'gmail://t-m1/m1/', ' gmail://t-m1/m1', 'gmail://t-m1/./m1']) {
      expect(service.resolveDocument({ ...none, uri, source: 'aios.gmail' }, true)).toEqual({ reason: 'not-found' })
    }
  })

  it('0 rows is not-found, and multiple rows is ambiguous (not read)', () => {
    expect(service.resolveDocument({ ...none, uri: 'gmail://nope', source: 'aios.gmail' }, true)).toEqual({ reason: 'not-found' })
    put('a.one', 'x', 'dup://same')
    put('a.one', 'y', 'dup://same')
    put('b.two', 'z', 'dup://same')
    expect(service.resolveDocument({ ...none, uri: 'dup://same', source: 'a.one' }, true)).toEqual({ reason: 'ambiguous' })
    expect(service.resolveDocument({ ...none, uri: 'dup://same', source: 'b.two' }, true)).toMatchObject({ id: expect.any(String) })
  })

  it('a uri without a source is looked up only when the form decides the source; otherwise it asks for a source (does not scan the table)', () => {
    const c = put('conversation', 'th1:ev1', 'thread://th1/ev1')
    const t = put('transcript', 'f1#m1', 'transcript://f1/m1')
    put('aios.gmail', 'm1', 'gmail://t-m1/m1')
    expect(service.resolveDocument({ ...none, uri: 'thread://th1/ev1' }, true)).toEqual({ id: String(c) })
    expect(service.resolveDocument({ ...none, uri: 'transcript://f1/m1' }, true)).toEqual({ id: String(t) })
    expect(service.resolveDocument({ ...none, uri: 'thread://th1/nope' }, true)).toEqual({ reason: 'not-found' })
    expect(service.resolveDocument({ ...none, uri: 'gmail://t-m1/m1' }, true)).toEqual({ reason: 'source-required' })
    // The derived key is only a way to find the row: the stored uri must be the very string asked for.
    put('conversation', 'th2:ev2', 'other://elsewhere')
    expect(service.resolveDocument({ ...none, uri: 'thread://th2/ev2' }, true)).toEqual({ reason: 'not-found' })
  })

  it('the SQL uses the index on the leading column of source (not a full table scan)', () => {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM documents WHERE source = ? AND uri = ? AND source <> 'fs' LIMIT 50`)
      .all('aios.gmail', 'x') as { detail: string }[]
    expect(plan.map((row) => row.detail).join('\n')).toMatch(/USING (COVERING )?INDEX documents_/)
  })

  it('a visibility that cannot be shown to the agent is the same as "missing"; the UI can look up ui-only; hidden cannot be looked up by either', () => {
    const only = put('aios.gmail', 'm2', 'gmail://t-m2/m2', 'ui-only')
    const hidden = put('aios.gmail', 'm3', 'gmail://t-m3/m3', 'hidden')
    expect(service.resolveDocument({ ...none, uri: 'gmail://t-m2/m2', source: 'aios.gmail' }, true)).toEqual({ reason: 'not-found' })
    expect(service.resolveDocument({ ...none, uri: 'gmail://t-m2/m2', source: 'aios.gmail' }, false)).toEqual({ id: String(only) })
    expect(service.resolveDocument({ ...none, source: 'aios.gmail', sourceId: 'm3' }, true)).toEqual({ reason: 'not-found' })
    expect(service.resolveDocument({ ...none, source: 'aios.gmail', sourceId: 'm3' }, false)).toEqual({ reason: 'not-found' })
    expect(hidden).toBeGreaterThan(0)
  })

  it('does not look up fs and file: (so the path check cannot be bypassed); an empty query is also refused', () => {
    expect(service.resolveDocument({ ...none, uri: 'file:///etc/passwd' }, true)).toEqual({ reason: 'unsupported' })
    expect(service.resolveDocument({ ...none, source: 'fs', sourceId: '/etc/passwd' }, true)).toEqual({ reason: 'unsupported' })
    expect(service.resolveDocument(none, true)).toEqual({ reason: 'unsupported' })
    expect(service.resolveDocument({ ...none, source: 'aios.gmail' }, true)).toEqual({ reason: 'unsupported' })
  })

  it('an fs row is not returned even if the uri matches', () => {
    db.prepare(
      `INSERT INTO documents (source, name, name_folded, kind, uri, index_state) VALUES ('fs', 'a', 'a', 'file', 'file:///tmp/a', 'indexed')`
    ).run()
    expect(service.resolveDocument({ ...none, uri: 'file:///tmp/a' }, true)).toEqual({ reason: 'unsupported' })
    db.prepare(`UPDATE documents SET uri = 'weird://fs-row' WHERE source = 'fs'`).run()
    expect(service.resolveDocument({ ...none, uri: 'weird://fs-row', source: 'aios.gmail' }, true)).toEqual({ reason: 'not-found' })
    expect(service.resolveDocument({ ...none, uri: 'weird://fs-row', source: 'fs' }, true)).toEqual({ reason: 'unsupported' })
  })
})
