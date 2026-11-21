/**
 * Measures the list of direct children of a file tree (TODO 875 item 1, and the "newest first" of 872).
 *
 * 1. The index path (`IndexStore.children`): into an encrypted synthetic DB, it builds one folder with `N` children and the
 *    surrounding tree (`BENCH_BACKGROUND` rows, default 200,000). It repeats four cases (by name / newest first, with hidden items
 *    shown / not shown) and prints the median and the maximum (the real statements of `IndexStore`). Then, for comparison, it prints
 *    the time of a **candidate** (an index on `(parent_id, kind, mtime_ms DESC, name_folded) WHERE source = 'fs'`, plus two statements
 *    that fetch directories and files separately), the time to create the index, the index size (dbstat), and EQP. The candidate is made
 *    only inside this bench (it is not a migration; the reason is in bundle C of docs/notes/wave44.md).
 * 2. The path that reads live (`FsIndexer.listDirectory` → `readDirectoryLive`, for a folder that is not in the index):
 *    if counts are listed in `BENCH_LIVE` (e.g. `BENCH_LIVE=10000,100000`), it creates real files and prints the total time
 *    for by name / newest first, and the longest stop of the JS thread (the blank space of `setImmediate`).
 *
 * It does not start the app. It calls no model. It deletes the DB and the tree when done.
 *
 *   npx vite-node -c vitest.config.ts scripts/bench/tree-children.mts -- [child counts...]
 *   BENCH_LIVE=10000,100000 npx vite-node -c vitest.config.ts scripts/bench/tree-children.mts -- 1000
 *
 * The default is 1,000 / 10,000 / 100,000 items (3% directories, and 5% names starting with ".").
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../../src/common/migrations.js'
import { FsIndexer, MAX_ROWS } from '../../src/index-kernel/indexer.js'
import { IndexStore } from '../../src/index-kernel/store.js'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const SIZES = argv.length > 0 ? argv.map(Number) : [1_000, 10_000, 100_000]
const BACKGROUND = Number(process.env['BENCH_BACKGROUND'] ?? 200_000)
const LIVE = (process.env['BENCH_LIVE'] ?? '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const REPEAT = 15
const KEY = 'd'.repeat(64)
const COLUMNS = 'id, name, kind, ext, size, mtime_ms'

function openDb(dir: string): Db {
  const db = new Database(join(dir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

/** Puts `count` children under `parent`. 3% are directories and 5% are hidden. The mtimes are scattered. */
function fill(db: Db, parent: number, count: number, prefix: string): void {
  const insert = db.prepare(`
    INSERT INTO documents
      (source, parent_id, name, name_folded, kind, ext, size, mtime_ms, updated_at, version, index_state, seen_at)
    VALUES ('fs', ?, ?, ?, ?, ?, 100, ?, ?, '', 'skipped', 0)
  `)
  const now = Date.now()
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const directory = i % 33 === 0
      const hidden = i % 20 === 7
      const name = `${hidden ? '.' : ''}${prefix}${String(i).padStart(7, '0')}${directory ? '' : '.txt'}`
      // Scatters the mtimes with a linear congruential generator, so that name order and time order do not line up.
      const mtime = directory ? 0 : now - ((i * 2_654_435_761) % 1_000_000_007)
      insert.run(parent, name, name.toLowerCase(), directory ? 'directory' : 'file', directory ? '' : 'txt', mtime, mtime)
    }
  })()
}

function timeIt(fn: () => unknown): { median: number; max: number } {
  const times: number[] = []
  for (let r = 0; r < REPEAT; r += 1) {
    const at = performance.now()
    fn()
    times.push(performance.now() - at)
  }
  times.sort((a, b) => a - b)
  return { median: times[Math.floor(times.length / 2)] ?? 0, max: times[times.length - 1] ?? 0 }
}

function report(label: string, t: { median: number; max: number }, rows: number): void {
  console.log(`  ${label}: 中央値 ${t.median.toFixed(2)} ms / 最大 ${t.max.toFixed(2)} ms / ${rows.toLocaleString()} 行`)
}

function benchIndexed(): void {
  const dir = mkdtempSync(join(homedir(), '.aios-tree-children-bench-'))
  try {
    const db = openDb(dir)
    const store = new IndexStore(db)
    const root = store.ensureRoot()
    const makeDir = db.prepare(`
      INSERT INTO documents
        (source, parent_id, name, name_folded, kind, ext, size, mtime_ms, updated_at, version, index_state, seen_at)
      VALUES ('fs', ?, ?, ?, 'directory', '', 0, 0, 0, '', 'skipped', 0) RETURNING id
    `)
    // The surrounding tree: 50 items per folder (so that the table and index sizes are close to a real machine).
    const bgParents = Math.max(1, Math.floor(BACKGROUND / 50))
    for (let p = 0; p < bgParents; p += 1) {
      const id = (makeDir.get(root, `bg${p}`, `bg${p}`) as { id: number }).id
      fill(db, id, 50, `b${p}_`)
    }
    const big = new Map<number, number>()
    for (const size of SIZES) {
      const id = (makeDir.get(root, `big${size}`, `big${size}`) as { id: number }).id
      fill(db, id, size, 'f')
      big.set(size, id)
    }
    const total = (db.prepare(`SELECT count(*) AS n FROM documents`).get() as { n: number }).n
    console.log(`1. 索引の経路: 全 ${total.toLocaleString()} 行 / MAX_ROWS ${MAX_ROWS}`)
    for (const [size, id] of big) {
      console.log(` 子 ${size.toLocaleString()} 件`)
      for (const order of ['name', 'modified'] as const) {
        for (const hide of [false, true]) {
          let rows = 0
          const t = timeIt(() => {
            rows = store.children(id, MAX_ROWS, hide, order).length
          })
          report(`${order.padEnd(8)} hide=${String(hide).padEnd(5)}`, t, rows)
        }
      }
    }

    // Candidate (not made into a migration): one index, plus directories and files fetched separately.
    const at = performance.now()
    db.exec(
      `CREATE INDEX bench_tree_kind_mtime ON documents (parent_id, kind, mtime_ms DESC, name_folded) WHERE source = 'fs'`
    )
    console.log(` 候補の索引の作成: ${Math.round(performance.now() - at)} ms (${total.toLocaleString()} 行)`)
    try {
      const sizes = db
        .prepare(
          `SELECT name, SUM(pgsize) AS bytes FROM dbstat
           WHERE name IN ('documents', 'documents_tree', 'bench_tree_kind_mtime') GROUP BY name`
        )
        .all() as { name: string; bytes: number }[]
      for (const row of sizes) console.log(`  ${row.name}: ${(row.bytes / 1e6).toFixed(1)} MB`)
    } catch {
      console.log('  (dbstat が無いので大きさは出さない)')
    }
    const dirs = db.prepare(
      `SELECT ${COLUMNS} FROM documents INDEXED BY bench_tree_kind_mtime
       WHERE source = 'fs' AND parent_id = ? AND kind = 'directory' ORDER BY name_folded LIMIT ?`
    )
    const files = db.prepare(
      `SELECT ${COLUMNS} FROM documents INDEXED BY bench_tree_kind_mtime
       WHERE source = 'fs' AND parent_id = ? AND kind = 'file' ORDER BY mtime_ms DESC, name_folded LIMIT ?`
    )
    for (const [size, id] of big) {
      let rows = 0
      const t = timeIt(() => {
        const d = dirs.all(id, MAX_ROWS)
        rows = d.length + files.all(id, MAX_ROWS - d.length).length
      })
      report(`候補 modified 子 ${size.toLocaleString()} 件`, t, rows)
    }
    for (const statement of [dirs, files]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${statement.source}`).all(0, 1) as { detail: string }[]
      console.log(`  EQP ${plan.map((row) => row.detail).join(' | ')}`)
    }
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function benchLive(): Promise<void> {
  if (LIVE.length === 0) return
  const base = mkdtempSync(join(homedir(), '.aios-tree-live-bench-'))
  const dbDir = mkdtempSync(join(homedir(), '.aios-tree-live-benchdb-'))
  try {
    const db = openDb(dbDir)
    const indexer = new FsIndexer(
      db,
      { onScanStatus: () => {}, onFileChanges: () => {} },
      new IndexStore(db),
      base,
      [base],
      { volumesDir: join(base, 'Volumes'), probeUuid: async () => null }
    )
    console.log('2. その場で読む経路 (索引に無いフォルダ)')
    for (const size of LIVE) {
      const folder = join(base, `live${size}`)
      mkdirSync(folder, { recursive: true })
      for (let i = 0; i < size; i += 1) writeFileSync(join(folder, `f${String(i).padStart(7, '0')}.txt`), '')
      const uri = pathToFileURL(folder).href
      for (const sortOrder of ['name', 'modified'] as const) {
        let probing = true
        let last = performance.now()
        let maxBlock = 0
        const probe = (): void => {
          const now = performance.now()
          maxBlock = Math.max(maxBlock, now - last)
          last = now
          if (probing) setImmediate(probe)
        }
        setImmediate(probe)
        await new Promise((done) => setImmediate(done))
        const at = performance.now()
        const listing = await indexer.listDirectory(uri, { sortOrder })
        const totalMs = performance.now() - at
        probing = false
        console.log(
          `  子 ${size.toLocaleString()} 件 ${sortOrder.padEnd(8)}: ${Math.round(totalMs).toLocaleString()} ms ` +
            `(最長の停止 ${maxBlock.toFixed(1)} ms) / ${listing.entries.length.toLocaleString()} 行 live=${listing.live}`
        )
      }
    }
    await indexer.stop()
    db.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  }
}

benchIndexed()
benchLive().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
