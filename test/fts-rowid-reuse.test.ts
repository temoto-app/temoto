/**
 * TODO 965: in contentless FTS, a row whose rowid was reused keeps the earlier words.
 *
 * - First, the real SQLite (better-sqlite3-multiple-ciphers, encrypted, on disk) reproduces that "an INSERT into the same rowid keeps the earlier words" (a record of the behavior before the fix).
 * - With the high-water mark of migration 30 (`chunk_id_seq`), neither a deleted rowid nor a rowid left in FTS is ever handed out again.
 * - FTS that may be dirty (ids at or below the high-water mark as of migration 30) is gradually returned to `pending` by idle cleanup, and the normal build re-indexes it. After the rebuild the earlier words are gone.
 *
 * The model is not called. The real DB is not touched (`~/.aios-test/<run>/`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { LATEST_KNOWN_MIGRATION, runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import {
  INDEX_FTS_ORPHAN_CURSOR,
  INDEX_FTS_REBUILD_CURSOR,
  INDEX_LOSSY_BACKFILL_CURSOR
} from '../src/common/settings-keys.js'
import { CHUNK_ID_SEED_MARGIN, IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IdleUpkeep, REBUILD_MAX_DOCS, UPKEEP_DONE } from '../src/index-kernel/upkeep.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

let dbDir: string
let db: Db

function openDb(): Db {
  const opened = new Database(join(dbDir, 'aios.db'))
  opened.pragma(`key='${'e'.repeat(64)}'`)
  opened.pragma('foreign_keys = ON')
  return opened
}

beforeEach(() => {
  dbDir = makeTestDir('fts-rowid-db')
  db = openDb()
})

afterEach(() => {
  if (db.open) db.close()
  rmSync(dbDir, { recursive: true, force: true })
})

const matches = (term: string): number[] =>
  db.prepare(`SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY rowid`).pluck().all(term) as number[]
const chunkIds = (documentId: number): number[] =>
  db.prepare(`SELECT id FROM chunks WHERE document_id = ? ORDER BY id`).pluck().all(documentId) as number[]
const seq = (): { last_id: number; rebuild_below: number } =>
  db.prepare(`SELECT last_id, rebuild_below FROM chunk_id_seq WHERE id = 1`).get() as {
    last_id: number
    rebuild_below: number
  }

describe('TODO 965: contentless の FTS の rowid の再利用 (実物の SQLite で再現)', () => {
  it('同じ rowid に INSERT しても誤りにならず、前の語が残ったまま足される。DELETE は後の語しか消さず、前の語は二度と消せない', () => {
    // A table of the same shape as migration 3.
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(text, tokenize = 'unicode61 remove_diacritics 2',
      content = '', contentless_delete = 1)`)
    const insert = db.prepare(`INSERT INTO t (rowid, text) VALUES (?, ?)`)
    const hit = (term: string): number[] =>
      db.prepare(`SELECT rowid FROM t WHERE t MATCH ? ORDER BY rowid`).pluck().all(term) as number[]
    insert.run(2, 'gamma')
    insert.run(2, 'delta')
    expect(hit('gamma')).toEqual([2])
    expect(hit('delta')).toEqual([2])
    // A DELETE in contentless_delete places a tombstone only on the last version inserted. The earlier version's words remain.
    db.prepare(`DELETE FROM t WHERE rowid = ?`).run(2)
    expect(hit('gamma')).toEqual([2])
    expect(hit('delta')).toEqual([])
    // They remain even if deleted again or optimized. A 'delete' that takes the original words cannot be used with this table.
    db.prepare(`DELETE FROM t WHERE rowid = ?`).run(2)
    db.exec(`INSERT INTO t (t) VALUES ('optimize')`)
    expect(hit('gamma')).toEqual([2])
    expect(() => db.prepare(`INSERT INTO t (t, rowid, text) VALUES ('delete', 2, 'gamma')`).run()).toThrow(
      /contentless_delete/
    )
    // There is no per-row table (docsize) any more, so applying bm25 to an earlier word looks like a broken table.
    expect(() => db.prepare(`SELECT bm25(t) FROM t WHERE t MATCH 'gamma'`).all()).toThrow(/malformed/)
  })
})

describe('TODO 965: migration 30 の高水位 (種は索引プロセスが入れる)', () => {
  /** Returns the DB to the state up to migration 29 (the shape before migration 30). */
  function downgradeTo29(): void {
    db.exec(`DROP TABLE chunk_id_seq`)
    db.pragma('user_version = 29')
  }

  function parentDir(store: IndexStore): number {
    return store.ensureDirectory('/tmp/aios-fts-rowid', 1)
  }

  function document(store: IndexStore, name: string, words: readonly string[]): number {
    const { id } = store.upsertFsEntry({
      parentId: parentDir(store),
      name,
      isDirectory: false,
      ext: 'txt',
      size: 10,
      mtimeMs: 1,
      seenAt: 1
    })
    store.replaceChunks(
      id,
      words.map((word, i) => ({ shadow: word, byteStart: i, byteEnd: i + 1, chars: 1 })),
      { state: 'indexed', contentHash: 'h', lang: null }
    )
    return id
  }

  it('種は chunks と chunk_fts の最大の id (孤児の FTS 行が上にあればそれ)。rebuild_below も同じ値', () => {
    runMigrations(db)
    downgradeTo29()
    // Chunks that entered as "max + 1" in the old version, and the orphan FTS rows left above them.
    db.prepare(`INSERT INTO documents (source, name, name_folded, kind, index_state) VALUES ('fs', 'a', 'a', 'file', 'indexed')`).run()
    const docId = db.prepare(`SELECT max(id) FROM documents`).pluck().get() as number
    db.prepare(`INSERT INTO chunks (document_id, seq, byte_start, byte_end, chars) VALUES (?, 0, 0, 1, 1)`).run(docId)
    db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (1, 'alpha'), (40, 'ghost')`).run()
    expect(runMigrations(db)).toBe(LATEST_KNOWN_MIGRATION)
    // The migration only creates the table (main does not read the index tables). The seed goes in when the index process opens it.
    expect(db.prepare(`SELECT COUNT(*) FROM chunk_id_seq`).pluck().get()).toBe(0)
    new IndexStore(db)
    expect(seq()).toEqual({ last_id: 40 + CHUNK_ID_SEED_MARGIN, rebuild_below: 40 })
    // Opening it a second time does not rewrite the seed.
    db.prepare(`UPDATE chunk_id_seq SET last_id = 99`).run()
    new IndexStore(db)
    expect(seq()).toEqual({ last_id: 99, rebuild_below: 40 })
  })

  it('旧い版で再利用された後に消えた最上位の rowid (行ごとの表に無く、語だけ残る) も配らない (review)', () => {
    runMigrations(db)
    downgradeTo29()
    // "max + 1" of the old version: chunks 1 and 2 of document a. 3 above them was handed out twice (the earlier version's word ghostword remains), and was later deleted.
    db.prepare(`INSERT INTO documents (source, name, name_folded, kind, index_state) VALUES ('fs', 'a', 'a', 'file', 'indexed')`).run()
    const docId = db.prepare(`SELECT max(id) FROM documents`).pluck().get() as number
    const chunk = db.prepare(`INSERT INTO chunks (id, document_id, seq, byte_start, byte_end, chars) VALUES (?, ?, ?, 0, 1, 1)`)
    chunk.run(1, docId, 0)
    chunk.run(2, docId, 1)
    db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (1, 'alpha'), (2, 'alpha'), (3, 'ghostword'), (3, 'later')`).run()
    db.prepare(`DELETE FROM chunk_fts WHERE rowid = 3`).run()
    // Removed from the per-row table, and not in chunks either. Only the word remains, at 3.
    expect(db.prepare(`SELECT max(id) FROM chunk_fts_docsize`).pluck().get()).toBe(2)
    expect(matches('ghostword')).toEqual([3])

    expect(runMigrations(db)).toBe(LATEST_KNOWN_MIGRATION)
    const store = new IndexStore(db)
    // The range of the rebuild is up to the chunks that exist now; what is handed out is from above the margin.
    expect(seq().rebuild_below).toBe(2)
    expect(seq().last_id).toBe(2 + CHUNK_ID_SEED_MARGIN)
    const b = document(store, 'b.txt', ['betaword'])
    expect(chunkIds(b)[0]).toBeGreaterThan(3)
    // The remaining word does not hit b's chunk.
    const joined = db
      .prepare(`SELECT c.document_id FROM chunk_fts f JOIN chunks c ON c.id = f.rowid WHERE chunk_fts MATCH 'ghostword'`)
      .pluck()
      .all()
    expect(joined).toEqual([])
  })

  it('空の DB では 0 (作り直すものは無い)', () => {
    runMigrations(db)
    new IndexStore(db)
    expect(seq()).toEqual({ last_id: 0, rebuild_below: 0 })
  })

  it('一番上の文書を消しても、その rowid は次の文書に配らない', () => {
    runMigrations(db)
    const store = new IndexStore(db)
    document(store, 'a.txt', ['alphaword'])
    const top = document(store, 'b.txt', ['betaword', 'betaword2'])
    const topIds = chunkIds(top)
    // Delete correctly (both FTS and chunks). Before the fix, "max + 1" handed out the same rowid again.
    store.markSkipped(top)
    const next = document(store, 'c.txt', ['gammaword'])
    expect(Math.min(...chunkIds(next))).toBeGreaterThan(Math.max(...topIds))
    expect(seq().last_id).toBe(Math.max(...chunkIds(next)))
  })

  it('孤児の FTS 行 (chunks に無い rowid) が上にあっても、その rowid を配らない = 前の語が混ざらない', () => {
    runMigrations(db)
    const store = new IndexStore(db)
    const a = document(store, 'a.txt', ['alphaword'])
    const orphan = Math.max(...chunkIds(a)) + 1
    // The shape left by a range-scoped cleanup from before 923: only the FTS row exists, and the high-water mark does not know it.
    db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, 'ghostword')`).run(orphan)
    const b = document(store, 'b.txt', ['betaword'])
    expect(chunkIds(b)[0]).toBeGreaterThan(orphan)
    // The orphan's word does not hit b's chunk.
    expect(matches('ghostword')).toEqual([orphan])
    expect(matches('betaword')).toEqual(chunkIds(b))
  })
})

describe('TODO 965: 汚れている可能性のある FTS の作り直し', () => {
  let store: IndexStore
  let settings: AppSettingsStore
  let root: string | undefined
  let index: IndexService | undefined
  let fsIndexer: FsIndexer | undefined

  beforeEach(() => {
    runMigrations(db)
    store = new IndexStore(db)
    settings = new AppSettingsStore(db)
    // Treat the cleanup of 945 as already done (here only the rebuild is checked).
    settings.writeTyped(INDEX_FTS_ORPHAN_CURSOR, UPKEEP_DONE)
  })

  afterEach(async () => {
    await index?.stop()
    await fsIndexer?.stop()
    if (root !== undefined) removeTestDir(root)
    index = undefined
    fsIndexer = undefined
    root = undefined
  })

  function upkeepWith(options: { now?: () => number; rebuildable?: (source: string) => boolean } = {}): {
    upkeep: IdleUpkeep
    requeued: number[]
  } {
    let queue: Promise<void> = Promise.resolve()
    const requeued: number[] = []
    const upkeep = new IdleUpkeep({
      store,
      settings,
      enqueue: (work) => {
        const result = queue.then(work)
        queue = result.catch(() => undefined)
        return result
      },
      shouldYield: () => false,
      readGate: () => async () => true,
      rebuildable: options.rebuildable,
      onRequeued: (count) => requeued.push(count),
      now: options.now
    })
    return { upkeep, requeued }
  }

  /** Makes all current chunks count as "entered before migration 30". */
  function markAllAsPreMigration(): void {
    db.prepare(`UPDATE chunk_id_seq SET rebuild_below = (SELECT COALESCE(max(id), 0) FROM chunks)`).run()
  }

  const pendingCount = (): number =>
    db.prepare(`SELECT COUNT(*) FROM documents WHERE index_state = 'pending'`).pluck().get() as number

  it('再利用された rowid の前の語は、作り直し (pending → 構築) で消える。済んだら 946 の後付けも済み', async () => {
    const dir = makeTestDir('fts-rowid-files')
    root = dir
    writeFileSync(join(dir, 'a.txt'), 'the alphaword lives here\n')
    writeFileSync(join(dir, 'b.txt'), 'the betaword lives here\n')
    const indexer = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, dir, [dir])
    fsIndexer = indexer
    const service = new IndexService({
      db,
      store,
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: null,
      fsRules: () => indexer.exclusionRules,
      onStatus: () => {}
    })
    index = service
    await indexer.scan()
    await service.build()
    const a = db.prepare(`SELECT id FROM documents WHERE name = 'a.txt'`).pluck().get() as number
    const oldIds = chunkIds(a)
    expect(oldIds.length).toBeGreaterThan(0)

    // The shape dirtied by the old version: the word of a deleted file (an orphan) was first in a rowid, and a's chunk came in later. (To make the same shape, a's word is inserted again after the orphan's word; the later version becomes a's word.)
    const insert = db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`)
    insert.run(oldIds[0], 'ghostword')
    insert.run(oldIds[0], 'the alphaword lives here')
    expect(matches('ghostword')).toEqual([oldIds[0]])
    const ghostHits = async (): Promise<string[]> =>
      (await service.search('ghostword', 'files', {})).hits.map((hit) => hit.title)
    // This is the false hit: a matches on the word of a deleted file.
    expect(await ghostHits()).toEqual(['a.txt'])
    markAllAsPreMigration()

    const { upkeep, requeued } = upkeepWith()
    await upkeep.step()
    expect(requeued).toEqual([2])
    expect(pendingCount()).toBe(2)
    // Chunks remain until the build finishes (search works; only the false hits remain).
    expect(matches('alphaword')).toEqual(oldIds)

    await service.build()
    expect(pendingCount()).toBe(0)
    const newIds = chunkIds(a)
    expect(Math.min(...newIds)).toBeGreaterThan(Math.max(...oldIds))
    expect(matches('alphaword')).toEqual(newIds)
    // The earlier word cannot be removed from FTS (the reproduction above), but its rowid holds no chunk and is never handed out again, so it does not hit search (the JOIN with chunks). bm25 is applied only to the rows that hit, so the table does not look broken.
    expect(matches('ghostword')).toEqual([oldIds[0]])
    expect(await ghostHits()).toEqual([])
    expect((await service.search('alphaword', 'files', {})).hits.map((hit) => hit.title)).toEqual(['a.txt'])

    // It is finished in the next step. New chunks are above rebuild_below, so they are never returned to it.
    for (let i = 0; i < 5 && !upkeep.finished(); i += 1) await upkeep.step()
    expect(settings.readTyped(INDEX_FTS_REBUILD_CURSOR)).toBe(UPKEEP_DONE)
    expect(settings.readTyped(INDEX_LOSSY_BACKFILL_CURSOR)).toBe(UPKEEP_DONE)
    expect(upkeep.finished()).toBe(true)
    expect(pendingCount()).toBe(0)
  }, 30_000)

  function chunkedDocument(n: number, source = 'fs'): number {
    if (source !== 'fs') {
      const row = store.upsertDocument({
        source,
        sourceId: `s${n}`,
        uri: `x://${n}`,
        name: `doc${n}`,
        kind: 'message',
        updatedAt: 1,
        version: '1',
        exposure: 'ui+ai',
        metadata: {},
        seenAt: 1
      })
      store.replaceChunks(row.id, [{ shadow: `word${n}`, byteStart: 0, byteEnd: 1, chars: 1 }], {
        state: 'indexed',
        contentHash: 'h',
        lang: null
      })
      return row.id
    }
    const parent = store.ensureDirectory('/tmp/aios-fts-rowid', 1)
    const { id } = store.upsertFsEntry({
      parentId: parent,
      name: `d${n}.txt`,
      isDirectory: false,
      ext: 'txt',
      size: 1,
      mtimeMs: 1,
      seenAt: 1
    })
    store.replaceChunks(id, [{ shadow: `word${n}`, byteStart: 0, byteEnd: 1, chars: 1 }], {
      state: 'indexed',
      contentHash: 'h',
      lang: null
    })
    return id
  }

  it('1 歩に戻すのは REBUILD_MAX_DOCS 件まで。進みは app_settings に置き、再起動は続きから', async () => {
    const ids: number[] = []
    for (let n = 0; n < REBUILD_MAX_DOCS + 50; n += 1) ids.push(chunkedDocument(n))
    markAllAsPreMigration()
    // The clock does not advance, so it is not cut off by the time budget.
    const first = upkeepWith({ now: () => 0 })
    await first.upkeep.step()
    expect(first.requeued).toEqual([REBUILD_MAX_DOCS])
    expect(settings.readTyped(INDEX_FTS_REBUILD_CURSOR)).toBe(ids[REBUILD_MAX_DOCS - 1])

    // A restart (a new instance) continues from the progress that was saved.
    const second = upkeepWith({ now: () => 0 })
    await second.upkeep.step()
    expect(second.requeued).toEqual([50])
    expect(pendingCount()).toBe(REBUILD_MAX_DOCS + 50)
    for (let i = 0; i < 5 && !second.upkeep.finished(); i += 1) await second.upkeep.step()
    expect(settings.readTyped(INDEX_FTS_REBUILD_CURSOR)).toBe(UPKEEP_DONE)
  })

  it('構築が正本を読めない source は戻さない (戻すと skipped になってチャンクを失う)', async () => {
    const fs = chunkedDocument(1)
    const transcript = chunkedDocument(2, 'transcript')
    markAllAsPreMigration()
    const { upkeep } = upkeepWith({ now: () => 0, rebuildable: (source) => source !== 'transcript' })
    await upkeep.step()
    const state = (id: number): string =>
      db.prepare(`SELECT index_state FROM documents WHERE id = ?`).pluck().get(id) as string
    expect(state(fs)).toBe('pending')
    expect(state(transcript)).toBe('indexed')

    // Even after finishing, it is not marked as done, because some documents were skipped (review). The progress goes back to 0, and it does not run again in this launch. fs skipped nothing, so the back-fill of 946 is done.
    for (let i = 0; i < 5 && !upkeep.finished(); i += 1) await upkeep.step()
    expect(upkeep.finished()).toBe(true)
    expect(settings.readTyped(INDEX_FTS_REBUILD_CURSOR)).toBe(0)
    expect(settings.readTyped(INDEX_LOSSY_BACKFILL_CURSOR)).toBe(UPKEEP_DONE)

    // Assume the build recreated fs's documents (new ids).
    store.replaceChunks(fs, [{ shadow: 'word1', byteStart: 0, byteEnd: 1, chars: 1 }], {
      state: 'indexed',
      contentHash: 'h',
      lang: null
    })
    // If the readers are complete at the next launch, return only the skipped documents and mark it done.
    const next = upkeepWith({ now: () => 0 })
    for (let i = 0; i < 5 && !next.upkeep.finished(); i += 1) await next.upkeep.step()
    expect(next.requeued).toEqual([1])
    expect(state(transcript)).toBe('pending')
    expect(settings.readTyped(INDEX_FTS_REBUILD_CURSOR)).toBe(UPKEEP_DONE)
  })

  it('migration 30 の後に入ったチャンクだけなら、何も戻さずに済む', async () => {
    chunkedDocument(1)
    const { upkeep, requeued } = upkeepWith()
    for (let i = 0; i < 5 && !upkeep.finished(); i += 1) await upkeep.step()
    expect(requeued).toEqual([])
    expect(settings.readTyped(INDEX_FTS_REBUILD_CURSOR)).toBe(UPKEEP_DONE)
  })

  it('譲るべきとき (終了・構築中・アイドルでない) は DB に触らない', async () => {
    chunkedDocument(1)
    markAllAsPreMigration()
    const requeue = vi.spyOn(store, 'requeueIndexed')
    const upkeep = new IdleUpkeep({
      store,
      settings,
      enqueue: async (work) => work(),
      shouldYield: () => true,
      readGate: () => async () => true
    })
    await upkeep.step()
    expect(requeue).not.toHaveBeenCalled()
    expect(settings.readTyped(INDEX_FTS_REBUILD_CURSOR)).toBeNull()
  })
})
