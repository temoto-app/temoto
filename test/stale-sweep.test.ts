/**
 * Regression test for the cleanup after a scan (`IndexStore.removeStale`).
 *
 * What happened in the field: on a 2.9 GB encrypted DB the cleanup stopped the main thread for **100 seconds**, and the unresponsive app was force-quit from outside (the stack in the hang report was all `sqlite3_step → sqlite3BtreeNext → DecryptPageChaCha20Cipher`).
 *
 * There were two causes, and both are covered here:
 * 1. There was no index for the foreign key of `documents.parent_id` (ON DELETE CASCADE). `documents_tree` is a partial index, so SQLite could not use it for the foreign key, and every row deletion ran a full scan of documents (`documents_parent` in migration 6).
 * 2. Everything was deleted in one transaction, so the row count directly became the stop time.
 *
 * No model is called. The real encrypted DB is used.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { makeTestDir } from './helpers/tmp.js'

const KEY = 'd'.repeat(64)
/** A count that surely crosses `STALE_BATCH` (200). Without crossing it, the two-stage design cannot be tested. */
const CHILDREN = 300

let dbDir: string
let db: Db
let store: IndexStore

beforeAll(() => {
  // On macOS tmpdir() is under /var/folders, which hits the exclusion in 4.4.2, so create it under the home directory.
  dbDir = makeTestDir('sweep-test')
})

afterAll(() => {
  db?.close()
  rmSync(dbDir, { recursive: true, force: true })
})

beforeEach(() => {
  db?.close()
  const file = join(dbDir, `sweep-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  db = new Database(file)
  db.pragma(`key='${KEY}'`)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
})

/** Creates a file row that holds one chunk. */
function addFile(parentId: number, name: string, seenAt: number): number {
  const row = store.upsertFsEntry({
    parentId,
    name,
    isDirectory: false,
    ext: 'txt',
    size: 10,
    mtimeMs: 1,
    seenAt
  })
  store.replaceChunks(row.id, [{ shadow: `ほん ぶん ${name}`, byteStart: 0, byteEnd: 10, chars: 5 }], {
    state: 'indexed',
    contentHash: `h-${name}`,
    lang: 'ja'
  })
  return row.id
}

const countDocuments = (): number =>
  (db.prepare(`SELECT count(*) AS n FROM documents`).get() as { n: number }).n
const countChunks = (): number =>
  (db.prepare(`SELECT count(*) AS n FROM chunks`).get() as { n: number }).n
const countFts = (): number =>
  (db.prepare(`SELECT count(*) AS n FROM chunk_fts`).get() as { n: number }).n
const noop = async (): Promise<void> => {}

describe('走査後の掃除', () => {
  it('外部キーの索引が部分索引ではない (migration 6)', () => {
    const indexes = db.pragma('index_list(documents)') as {
      name: string
      partial: number
    }[]
    const parent = indexes.find((row) => row.name === 'documents_parent')
    expect(parent).toBeDefined()
    // With a partial index (partial = 1), SQLite cannot use it for the child lookup of the foreign key, so each row deletion goes back to a full scan of documents.
    expect(parent?.partial).toBe(0)
    expect(indexes.some((row) => row.name === 'documents_seen')).toBe(true)
  })

  it('外部キーの子検索が索引を使う', () => {
    const dir = store.ensureDirectory(join(homedir(), '.aios-sweep-plan'), 100)
    addFile(dir, 'a.txt', 100)
    db.exec('ANALYZE')
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM documents WHERE parent_id = ?`)
      .all(dir) as { detail: string }[]
    expect(plan.map((row) => row.detail).join(' ')).toContain('documents_parent')
  })

  it('見えなかった行だけを、派生ごと落とす', async () => {
    const path = join(homedir(), '.aios-sweep-basic')
    // The first scan.
    const first = store.ensureDirectory(path, 100)
    const stale = addFile(first, 'gone.txt', 100)

    // The second scan. As in `FsService.scan`, discard the cache first (otherwise ensureDirectory returns the cache, the directory row's seen_at stays old, and the parent gets removed along with it as stale).
    store.resetCaches()
    const dir = store.ensureDirectory(path, 200)
    addFile(dir, 'kept.txt', 200)

    const removed = await store.removeStale(200, noop)

    expect(removed).toBe(1)
    expect(db.prepare(`SELECT id FROM documents WHERE id = ?`).get(stale)).toBeUndefined()
    expect(countChunks()).toBe(1)
    expect(countFts()).toBe(1)
  })

  it('CASCADE で消える子の FTS 行を孤児にしない', async () => {
    // The shape where a whole directory disappears. Deleting document rows cascades to the children, so if deleted in batches, rows in a later batch can be deleted first. chunk_fts is a virtual table and CASCADE does not apply to it, so the FTS rows of all targets must be dropped **before any document row is deleted**.
    const dir = store.ensureDirectory(join(homedir(), '.aios-sweep-subtree'), 100)
    for (let i = 0; i < CHILDREN; i += 1) addFile(dir, `f${i}.txt`, 100)
    expect(countFts()).toBe(CHILDREN)
    // Every entry except the root has seen_at = 100, so they are all cleanup targets.
    const target = countDocuments() - 1

    const removed = await store.removeStale(200, noop)

    // Children removed by CASCADE are counted too. Adding the DELETE's changes would give only 1.
    expect(removed).toBe(target)
    expect(countFts()).toBe(0)
    expect(countChunks()).toBe(0)
    // Only the root row remains (it has no parent, so it is not a cleanup target).
    expect(countDocuments()).toBe(1)
  })

  it('まとまりごとにイベントループへ戻る', async () => {
    const dir = store.ensureDirectory(join(homedir(), '.aios-sweep-yield'), 100)
    for (let i = 0; i < CHILDREN; i += 1) addFile(dir, `f${i}.txt`, 100)

    let yields = 0
    await store.removeStale(200, async () => {
      yields += 1
    })

    // Delete 301 rows, 200 at a time, in two stages = 2 stages x 2 batches.
    expect(yields).toBeGreaterThanOrEqual(4)
  })

  it('消すものが無ければ何もしない', async () => {
    const dir = store.ensureDirectory(join(homedir(), '.aios-sweep-empty'), 100)
    addFile(dir, 'a.txt', 100)

    let yields = 0
    const removed = await store.removeStale(100, async () => {
      yields += 1
    })

    expect(removed).toBe(0)
    expect(yields).toBe(0)
    expect(countFts()).toBe(1)
  })

  it('範囲付きの掃除は孫以下の FTS 行も落とす (TODO 923)', async () => {
    // The `a` in a/b/c.txt was removed. Deleting only the direct child `a` cascades to the chunks of c.txt, but the chunk_fts (virtual table) rows remain, and on rowid reuse they hit the next indexed document.
    const base = join(homedir(), '.aios-sweep-scoped')
    const top = store.ensureDirectory(base, 100)
    const b = store.ensureDirectory(join(base, 'a', 'b'), 100)
    addFile(b, 'secretword.txt', 100)
    expect(countFts()).toBe(1)

    const removed = await store.removeMissingChildren([{ parentId: top, present: new Set() }], noop)

    expect(removed).toBe(1)
    expect(countChunks()).toBe(0)
    expect(countFts()).toBe(0)

    // Even if the next indexed document takes the same rowid, it does not match on the words of the removed file.
    addFile(top, 'newfile.txt', 200)
    const hits = db
      .prepare(`SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH 'secretword'`)
      .all() as { rowid: number }[]
    expect(hits).toEqual([])
  })

  it('古い親の下の新しい子も FTS 行ごと落とす (removeStale、TODO 923)', async () => {
    const base = join(homedir(), '.aios-sweep-fresh-child')
    const dir = store.ensureDirectory(base, 100)
    // The shape where, during a scan, the watch made only the children newer (the parent keeps the old seen_at).
    addFile(dir, 'fresh.txt', 300)
    expect(countFts()).toBe(1)

    await store.removeStale(200, noop)

    expect(countChunks()).toBe(0)
    expect(countFts()).toBe(0)
  })

  it('子孫の広げ方は対象の件数に比例する問い合わせを重ねず、間で yield する (第 49 波 review、TODO 923)', async () => {
    // Previously, a recursive subtree query was run synchronously one per stale id, and before the first yield the queries for the whole target count overlapped (with 100,000 items the index process froze).
    const base = join(homedir(), '.aios-sweep-many')
    const FILES = 2000
    const dirs = [store.ensureDirectory(base, 100)]
    for (let d = 0; d < 4; d += 1) dirs.push(store.ensureDirectory(join(base, `d${d}`, 'deep', 'er'), 100))
    for (let i = 0; i < FILES; i += 1) addFile(dirs[i % dirs.length]!, `m${i}.txt`, 100)

    // better-sqlite3 Statements share one prototype. Count all the `all()` calls during the cleanup.
    const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as { all: (...args: unknown[]) => unknown }
    const spy = vi.spyOn(proto, 'all')
    let yields = 0
    let firstDeleteYield = -1
    try {
      await store.removeStale(200, async () => {
        yields += 1
        if (firstDeleteYield < 0 && countChunks() < FILES) firstDeleteYield = yields
      })
      const calls = spy.mock.calls.length
      // About 2000 targets + descendants (200 per expansion step): if it is proportional to the count, it goes above 2000 calls.
      expect(calls).toBeLessThan(50)
    } finally {
      spy.mockRestore()
    }
    // It also yields before deleting (while expanding the descendants).
    expect(firstDeleteYield).toBeGreaterThan(1)
    expect(countFts()).toBe(0)
    expect(countChunks()).toBe(0)
    // Only the root row remains (it has no parent, so it is not a cleanup target).
    expect(countDocuments()).toBe(1)
  })
  it('削除の待ちの間に別の書き手が来ても、消えた行の id を親にしない (TODO 1113)', async () => {
    const base = join(homedir(), '.aios-sweep-race')
    const other = store.ensureDirectory(join(base, 'other'), 100)
    const gone: number[] = []
    for (let i = 0; i < 250; i += 1) gone.push(addFile(other, `f${i}.txt`, 100))
    // Created last = the largest id. Deleting it means the next new row takes the same id.
    const dist = store.ensureDirectory(join(base, 'dist'), 100)
    gone.push(dist)
    let calls = 0
    let childId = -1
    let childParent = -1
    const interleave = async (): Promise<void> => {
      calls += 1
      // The last wait of the second stage, which deletes document rows.
      if (calls === 4) {
        const parent = store.ensureDirectory(join(base, 'dist'), 200)
        const row = store.upsertFsEntry({
          parentId: parent,
          name: 'a.js',
          isDirectory: false,
          ext: 'js',
          size: 1,
          mtimeMs: 1,
          seenAt: 200
        })
        childId = row.id
        childParent = parent
      }
    }
    await store.deleteDocuments(gone, interleave)
    expect(childId).toBeGreaterThan(0)
    expect(childParent).not.toBe(childId)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
  it('読み取りの失敗 (markFailed) でも古いチャンクと FTS の行を消す (TODO 1128)', () => {
    const dir = store.ensureDirectory(join(homedir(), '.aios-sweep-failed'), 100)
    const id = addFile(dir, 'a.txt', 100)
    expect(countChunks()).toBe(1)
    expect(countFts()).toBe(1)
    store.markFailed(id, 'unreadable')
    expect(countChunks()).toBe(0)
    expect(countFts()).toBe(0)
    const row = db.prepare(`SELECT index_state AS s FROM documents WHERE id = ?`).get(id) as { s: string }
    expect(row.s).toBe('failed')
  })
})
