/**
 * Splits the application of watch diffs into groups of N (item 87, ARCHITECTURE.md 6.2).
 *
 * What is guarded:
 * - A diff of 1,000 items from `rm -rf` does **not become one transaction**. The limit per transaction is `STALE_BATCH` (200) items for deleting document rows, and `CHANGE_BATCH` (200) items for creating them
 * - A deletion takes its descendants with it, and neither orphan chunks nor orphan FTS rows remain (the two-step `deleteDocuments`)
 * - Termination (`stop()`) takes effect at batch boundaries, and nothing is written to the DB after `stop()` returns
 *
 * The counting is the same as in `test/index-ingest-batch.test.ts`: a Proxy counts the calls outside `db.transaction` and the write statements run inside it. It looks at deterministic counts, not at real time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db, Statement } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { CHANGE_BATCH, FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import type { RawChange } from '../src/index-kernel/watcher.js'
import type { FileChangeBatch } from '../src/shared/types.js'
import { makeTestDir } from './helpers/tmp.js'

/** The granularity of cleanup in `IndexStore` (`STALE_BATCH` in store.ts). */
const STALE_BATCH = 200

interface TxCounts {
  deletes: number
  upserts: number
}

/** For each outer transaction, counts the document row deletions and creations that ran inside it. */
function countTransactions(db: Db): TxCounts[] {
  const done: TxCounts[] = []
  let current: TxCounts | null = null
  const prepare = db.prepare.bind(db)
  const wrap = (statement: Statement): Statement => {
    const source = statement.source.trim()
    const kind = source.startsWith('DELETE FROM documents')
      ? 'deletes'
      : source.startsWith('INSERT INTO documents')
        ? 'upserts'
        : null
    return new Proxy(statement, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if ((prop === 'run' || prop === 'get') && kind !== null && current !== null) current[kind] += 1
          const result = (value as (...a: unknown[]) => unknown).apply(target, args)
          return result === target ? receiver : result
        }
      }
    })
  }
  db.prepare = ((source: string) => wrap(prepare(source))) as typeof db.prepare
  const transaction = db.transaction.bind(db)
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const wrapped = transaction(fn)
    return (...args: unknown[]) => {
      if (db.inTransaction) return wrapped(...args)
      current = { deletes: 0, upserts: 0 }
      try {
        return wrapped(...args)
      } finally {
        done.push(current)
        current = null
      }
    }
  }) as typeof db.transaction
  return done
}

let root: string
let db: Db
let store: IndexStore
let fs: FsIndexer
let tx: TxCounts[]
let batches: FileChangeBatch[]

beforeEach(async () => {
  // macOS's tmpdir() is under /var/folders and hits the exclusion of 4.4.2, so create it under home.
  root = makeTestDir('watch-batch-test')
  mkdirSync(join(root, 'keep'))
  writeFileSync(join(root, 'keep/a.txt'), 'a\n')
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  tx = countTransactions(db)
  store = new IndexStore(db)
  batches = []
  fs = new FsIndexer(
    db,
    { onScanStatus: () => {}, onFileChanges: (batch) => batches.push(batch) },
    store,
    root,
    [root]
  )
  await fs.scan()
})

afterEach(async () => {
  await fs.stop()
  if (db.open) db.close()
  rmSync(root, { recursive: true, force: true })
})

/** Creates `count` files under `dir` and returns the creation diff. */
function makeFiles(dir: string, count: number): RawChange[] {
  mkdirSync(join(root, dir), { recursive: true })
  const changes: RawChange[] = [{ type: 'create', path: join(root, dir) }]
  for (let i = 0; i < count; i += 1) {
    const path = join(root, dir, `f${i}.txt`)
    writeFileSync(path, `${i}\n`)
    changes.push({ type: 'create', path })
  }
  return changes
}

const fsRows = (): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE source = 'fs'`).get() as { n: number }).n

describe('監視の差分反映 (項目 87)', () => {
  it('作成 1,000 件は CHANGE_BATCH 件ずつのトランザクションに割れ、通知は 1 回', async () => {
    const before = fsRows()
    tx.length = 0
    const changes = makeFiles('big', 1000)
    await fs.enqueueChanges(changes)

    expect(fsRows()).toBe(before + 1001)
    const writes = tx.filter((t) => t.upserts > 0)
    expect(writes.length).toBeGreaterThanOrEqual(Math.ceil(1001 / CHANGE_BATCH))
    expect(Math.max(...writes.map((t) => t.upserts))).toBeLessThanOrEqual(CHANGE_BATCH)
    // All the diff notifications are sent once, after everything is done (the renderer re-fetches only once per batch).
    expect(batches).toHaveLength(1)
    expect(batches[0]?.changes).toHaveLength(1001)
  })

  it('rm -rf 1,000 件は子孫ごと消え、1 トランザクションの削除は STALE_BATCH 件まで', async () => {
    const before = fsRows()
    await fs.enqueueChanges(makeFiles('big', 1000))
    // Set up the state where a body index exists (chunks and FTS rows), to check that no orphans remain.
    const ids = db
      .prepare(`SELECT id FROM documents WHERE source = 'fs' AND ext = 'txt'`)
      .pluck()
      .all() as number[]
    for (const id of ids) {
      store.replaceChunks(id, [{ shadow: 'あ', byteStart: 0, byteEnd: 2, chars: 2 }], {
        state: 'indexed',
        contentHash: null,
        lang: null
      })
    }

    rmSync(join(root, 'big'), { recursive: true, force: true })
    tx.length = 0
    batches.length = 0
    // fsevents raises delete events for both the parent and the children. Order them so that the children come first.
    const deletes: RawChange[] = []
    for (let i = 0; i < 1000; i += 1) deletes.push({ type: 'delete', path: join(root, 'big', `f${i}.txt`) })
    deletes.push({ type: 'delete', path: join(root, 'big') })
    await fs.enqueueChanges(deletes)

    expect(fsRows()).toBe(before)
    const deleting = tx.filter((t) => t.deletes > 0)
    expect(deleting.length).toBeGreaterThanOrEqual(Math.ceil(1001 / STALE_BATCH))
    expect(Math.max(...deleting.map((t) => t.deletes))).toBeLessThanOrEqual(STALE_BATCH)
    // Only the chunks of the remaining document (keep/a.txt) remain; the chunks and FTS rows of the deleted documents do not.
    const orphanChunks = db
      .prepare(`SELECT COUNT(*) FROM chunks WHERE document_id NOT IN (SELECT id FROM documents)`)
      .pluck()
      .get() as number
    expect(orphanChunks).toBe(0)
    const ftsRows = db.prepare(`SELECT COUNT(*) FROM chunk_fts`).pluck().get() as number
    const chunkRows = db.prepare(`SELECT COUNT(*) FROM chunks`).pluck().get() as number
    expect(ftsRows).toBe(chunkRows)
    expect(batches).toHaveLength(1)
    expect(batches[0]?.changes).toHaveLength(1001)
  })

  it('削除と作成の順序を保つ (消した後に同じ名前で作り直す)', async () => {
    await fs.enqueueChanges(makeFiles('dir', 3))
    rmSync(join(root, 'dir'), { recursive: true, force: true })
    const recreate = makeFiles('dir2', 1)
    await fs.enqueueChanges([
      { type: 'delete', path: join(root, 'dir') },
      ...recreate
    ])
    const names = db
      .prepare(`SELECT name FROM documents WHERE source = 'fs'`)
      .pluck()
      .all() as string[]
    expect(names).not.toContain('dir')
    expect(names).toContain('dir2')
  })

  it('終了処理はバッチの境界で効き、stop() の後は DB に書かない', async () => {
    const changes = makeFiles('big', 1000)
    let upserts = 0
    let stopping: Promise<void> | null = null
    const upsert = store.upsertFsEntry.bind(store)
    store.upsertFsEntry = (row) => {
      upserts += 1
      // Termination arrives in the middle of the first batch. This batch is written to the end, and the next one is not written.
      if (upserts === 1) stopping = fs.stop()
      return upsert(row)
    }
    const applying = fs.enqueueChanges(changes)
    await applying
    await stopping
    expect(upserts).toBe(CHANGE_BATCH)
    // Changes that were stopped midway are not notified (and the index is not prompted to resume either).
    expect(batches).toHaveLength(0)

    db.close()
    // If anything flows in after closing, it fails with `The database connection is not open`.
    await fs.enqueueChanges([{ type: 'create', path: join(root, 'keep/b.txt') }])
    await new Promise((done) => setTimeout(done, 50))
    expect(db.open).toBe(false)
  })
})
