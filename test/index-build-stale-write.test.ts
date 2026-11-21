/**
 * TODO 922: building the body (`runBuild`) waits for the read of the body outside the write sequence. Even if rows disappear or the version advances in the meantime, the other documents in the batch are written, nothing is written to a row that disappeared (a failing foreign key does not cancel the whole batch), and a row whose version advanced stays `pending` (it is not fixed as `indexed` with the old body).
 *
 * An interruption during a read is made by deleting a row or advancing its version inside the canonical conversation entry (`readEventText`).
 * The model is not called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { makeTestDir } from './helpers/tmp.js'

let dbDir: string
let db: Db
let store: IndexStore

beforeEach(() => {
  dbDir = makeTestDir('stale-write-db')
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${'d'.repeat(64)}'`)
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dbDir, { recursive: true, force: true })
})

function upsert(eventId: string, version: string): number {
  return store.upsertDocument({
    source: 'conversation',
    sourceId: `t1:${eventId}`,
    uri: `thread://t1#${eventId}`,
    name: eventId,
    kind: 'message',
    updatedAt: 1,
    version,
    exposure: 'ui+ai',
    metadata: {},
    seenAt: 1
  }).id
}

function stateOf(id: number): string | null {
  const row = db.prepare(`SELECT index_state FROM documents WHERE id = ?`).get(id) as
    | { index_state: string }
    | undefined
  return row?.index_state ?? null
}

describe('TODO 922: do not write to rows that disappeared or were updated after reading', () => {
  it('writes the other documents in the batch, skips the deleted rows, and leaves rows whose version advanced as pending', async () => {
    const ids = new Map<string, number>()
    for (const name of ['e1', 'e2', 'e3', 'e4']) ids.set(name, upsert(name, 'v1'))
    let readsAfterUpdate = 0
    const index = new IndexService({
      db,
      store,
      conversation: {
        readEventText: async (eventId: string) => {
          // Deleted right after e2 has been read (the same shape as a watch deletion and removeThread).
          if (eventId === 'e2') store.removeDocument(ids.get('e2') as number)
          // e3 is saved after it is read, the version advances to v2, and it returns to pending. The second read is the new body.
          if (eventId === 'e3') {
            if (readsAfterUpdate === 0) {
              readsAfterUpdate += 1
              upsert('e3', 'v2')
              return { text: 'oldword body', threadId: 't1', ts: 1 }
            }
            return { text: 'newword body', threadId: 't1', ts: 1 }
          }
          // e4 is the path of the failure mark (index_failures has a foreign key to documents).
          if (eventId === 'e4') {
            store.removeDocument(ids.get('e4') as number)
            throw new Error('read failed')
          }
          return { text: `body of ${eventId} sharedword`, threadId: 't1', ts: 1 }
        },
        threadTitle: async () => null
      },
      transcripts: null,
      onStatus: () => {}
    })
    await index.build()
    await index.stop()

    expect(index.getStatus().state).not.toBe('error')
    expect(stateOf(ids.get('e1') as number)).toBe('indexed')
    expect(stateOf(ids.get('e2') as number)).toBeNull()
    expect(stateOf(ids.get('e4') as number)).toBeNull()
    // e3 is not written with the old body, since its version advanced; it was indexed from the new body in the next pass.
    expect(stateOf(ids.get('e3') as number)).toBe('indexed')
    const match = (word: string): number =>
      (db.prepare(`SELECT count(*) AS n FROM chunk_fts WHERE chunk_fts MATCH ?`).get(word) as { n: number }).n
    expect(match('oldword')).toBe(0)
    expect(match('newword')).toBe(1)
    // No chunk is written to a row that disappeared.
    const orphans = db
      .prepare(`SELECT count(*) AS n FROM chunks WHERE document_id NOT IN (SELECT id FROM documents)`)
      .get() as { n: number }
    expect(orphans.n).toBe(0)
  }, 60_000)

  it("a conversation document's failed returns to pending when rewritten at the same version (TODO 1136)", () => {
    const id = upsert('e1', 'v1')
    store.markFailed(id, 'rpc')
    expect(stateOf(id)).toBe('failed')
    upsert('e1', 'v1')
    expect(stateOf(id)).toBe('pending')
    // An indexed document keeps its state if the version is the same (as before).
    store.markSkipped(id)
    upsert('e1', 'v1')
    expect(stateOf(id)).toBe('skipped')
  })
})
