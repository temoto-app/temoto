/**
 * "Length of one stop" when a bulk delete equivalent to `rm -rf` arrives as a difference from watching (item 87).
 *
 * Into an encrypted real DB (the same PRAGMAs as `openDatabaseFile`), it puts in rows for a tree under the home directory
 * (with a body index: chunks + FTS rows), and then applies, as the difference that deletes the whole tree:
 *   - old: in one transaction for one flush, `removeSubtree` for each delete
 *     (the delete side of `applyChanges` in `indexer.ts` from before 2026-09-23 is copied here)
 *   - new: `FsIndexer.enqueueChanges` (collects row ids and calls `deleteDocuments`, STALE_BATCH items at a time)
 * What it looks at is not the total time but **the longest time the JS thread was held in one go**:
 * during that time, `fs.listDirectory` / `index.search` in the index process wait.
 * It prints the longest blank in a loop that keeps running `setImmediate` (= one stop), the longest single transaction, and
 * the number of times it went over 100 ms.
 * (`perf_hooks.monitorEventLoopDelay` missed the first long stop, so it is not used.)
 *
 * No real files are created (the delete is applied only by looking up rows with `findByPath`; the disk is not looked at).
 * It calls no model and does not start the app. It deletes the DB when done.
 *
 *   npx vite-node -c vitest.config.ts scripts/bench/watch-delete.mts -- [count to delete] [count to keep]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { openDatabaseFile } from '../../src/common/db-open.js'
import { runMigrations } from '../../src/common/migrations.js'
import { IndexStore } from '../../src/index-kernel/store.js'
import { FsIndexer } from '../../src/index-kernel/indexer.js'
import type { RawChange } from '../../src/index-kernel/watcher.js'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const DELETE_COUNT = Number(argv[0] ?? 20_000)
const KEEP_COUNT = Number(argv[1] ?? 100_000)
const FILES_PER_DIR = 200
const KEY = 'd'.repeat(64)
const dir = mkdtempSync(join(tmpdir(), 'aios-watch-delete-bench-'))
/** The path that only builds rows. It need not exist, and need not be under the home directory, but it imitates the real machine's shape. */
const ROOT = join(homedir(), '.aios-watch-delete-bench')

interface Measured {
  totalMs: number
  maxTxMs: number
  slowTx: number
  transactions: number
  maxBlockMs: number
}

function timeTransactions(db: Db): { maxTxMs: number; slowTx: number; transactions: number } {
  const counts = { maxTxMs: 0, slowTx: 0, transactions: 0 }
  const transaction = db.transaction.bind(db)
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const wrapped = transaction(fn)
    return (...args: unknown[]) => {
      if (db.inTransaction) return wrapped(...args)
      const started = performance.now()
      try {
        return wrapped(...args)
      } finally {
        const ms = performance.now() - started
        counts.transactions += 1
        if (ms > 100) counts.slowTx += 1
        counts.maxTxMs = Math.max(counts.maxTxMs, ms)
      }
    }
  }) as typeof db.transaction
  return counts
}

/** Builds rows under `ROOT/keep` and `ROOT/gone`, and returns the deletion difference for the `gone` side (children first, then the parent). */
function populate(store: IndexStore): RawChange[] {
  const now = Date.now()
  const changes: RawChange[] = []
  const add = (sub: string, count: number, record: boolean): void => {
    for (let start = 0; start < count; start += FILES_PER_DIR) {
      const dirPath = join(ROOT, sub, `d${start / FILES_PER_DIR}`)
      store.transaction(() => {
        const parentId = store.ensureDirectory(dirPath, now)
        for (let i = start; i < Math.min(start + FILES_PER_DIR, count); i += 1) {
          const name = `f${i}.txt`
          const row = store.upsertFsEntry({
            parentId,
            name,
            isDirectory: false,
            ext: 'txt',
            size: 100,
            mtimeMs: now,
            seenAt: now
          })
          // The shape that had a body index (two chunks + FTS rows). Most of the delete cost is here.
          store.replaceChunks(
            row.id,
            [
              { shadow: `承認 インボックス 索引 ${i}`, byteStart: 0, byteEnd: 50, chars: 50 },
              { shadow: `会話 検索 設計 ${i}`, byteStart: 50, byteEnd: 100, chars: 50 }
            ],
            { state: 'indexed', contentHash: null, lang: 'ja' }
          )
          if (record) changes.push({ type: 'delete', path: join(dirPath, name) })
        }
      })
      if (record) changes.push({ type: 'delete', path: dirPath })
    }
  }
  add('keep', KEEP_COUNT, false)
  add('gone', DELETE_COUNT, true)
  changes.push({ type: 'delete', path: join(ROOT, 'gone') })
  return changes
}

async function measure(name: string, run: (store: IndexStore, db: Db, changes: RawChange[]) => Promise<void>): Promise<Measured> {
  const db = openDatabaseFile(join(dir, `${name}.db`), KEY)
  runMigrations(db)
  const store = new IndexStore(db)
  const changes = populate(store)
  store.resetCaches()
  const tx = timeTransactions(db)
  // Called once per loop iteration. The blank since the previous call is the time the RPCs waited meanwhile.
  let probing = true
  let last = performance.now()
  let maxBlockMs = 0
  const probe = (): void => {
    const now = performance.now()
    maxBlockMs = Math.max(maxBlockMs, now - last)
    last = now
    if (probing) setImmediate(probe)
  }
  setImmediate(probe)
  await new Promise((done) => setImmediate(done))
  const started = performance.now()
  await run(store, db, changes)
  const totalMs = performance.now() - started
  await new Promise((done) => setImmediate(done))
  probing = false
  const left = db
    .prepare(`SELECT COUNT(*) FROM documents WHERE source = 'fs'`)
    .pluck()
    .get() as number
  db.close()
  console.log(`${name}: 残り ${left.toLocaleString()} 行`)
  return { totalMs, maxTxMs: tx.maxTxMs, slowTx: tx.slowTx, transactions: tx.transactions, maxBlockMs }
}

const old = await measure('old', async (store, _db, changes) => {
  // The delete side of `applyChanges` from before 2026-09-23 (one transaction, plus removeSubtree for each delete).
  store.transaction(() => {
    for (const change of changes) {
      const id = store.findByPath(change.path)
      if (id !== null) store.removeSubtree(id)
    }
  })
})

const batched = await measure('new', async (store, db, changes) => {
  const indexer = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, ROOT, [ROOT])
  await indexer.enqueueChanges(changes)
  await indexer.stop()
})

const fmt = (m: Measured): string =>
  `総時間 ${m.totalMs.toFixed(0)} ms / トランザクション ${m.transactions} 回 (最長 ${m.maxTxMs.toFixed(1)} ms、100 ms 超え ${m.slowTx} 回) / 1 回の停止最長 ${m.maxBlockMs.toFixed(1)} ms`
console.log(`消す ${DELETE_COUNT.toLocaleString()} 件 (+ ディレクトリ) / 残す ${KEEP_COUNT.toLocaleString()} 件`)
console.log(`旧: ${fmt(old)}`)
console.log(`新: ${fmt(batched)}`)
rmSync(dir, { recursive: true, force: true })
