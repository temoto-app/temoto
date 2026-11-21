/**
 * Measurement of the scan (a tool for making the table in ARCHITECTURE.md 6.2.2; T9).
 *
 * It builds a synthetic directory tree under the home directory, and against an **encrypted real DB** it runs, in order:
 *   1. a deep scan (the form until now: upsert of all items + cleaning up `seen_at`)
 *   2. an incremental scan (does not write rows that have not changed, and does not open directories whose mtime is the same)
 * and prints the time and the number of rows written. It does not start the app. It calls no model.
 *
 *   npx vite-node -c vitest.config.ts scripts/scan-bench.mts -- [file count] [items per directory]
 *
 * The default is 100,000 files / 40 items per directory. The tree and the DB are deleted when done.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { AppSettingsStore } from '../src/common/settings.js'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const FILES = Number(argv[0] ?? 100_000)
const PER_DIR = Number(argv[1] ?? 40)
const KEY = 'b'.repeat(64)

const base = mkdtempSync(join(homedir(), '.aios-bench-'))
const dbDir = mkdtempSync(join(homedir(), '.aios-benchdb-'))
const root = join(base, 'home')

function buildTree(): number {
  let made = 0
  let dirs = 0
  const body = 'x'.repeat(64)
  for (let i = 0; made < FILES; i += 1) {
    const dir = join(root, `d${Math.floor(i / 50)}`, `s${i % 50}`)
    mkdirSync(dir, { recursive: true })
    dirs += 1
    for (let j = 0; j < PER_DIR && made < FILES; j += 1) {
      writeFileSync(join(dir, `f${j}.txt`), body)
      made += 1
    }
  }
  return dirs
}

const ms = (at: number): string => `${(Date.now() - at).toLocaleString()} ms`

async function main(): Promise<void> {
  console.log(`木を作る: ${FILES.toLocaleString()} ファイル …`)
  let at = Date.now()
  const dirs = buildTree()
  console.log(`  ${dirs.toLocaleString()} ディレクトリ / ${ms(at)}`)

  const db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  const store = new IndexStore(db)
  const settings = new AppSettingsStore(db)
  const service = new FsIndexer(
    db,
    { onScanStatus: () => {}, onFileChanges: () => {} },
    store,
    root,
    [root]
  )

  at = Date.now()
  await service.scan({ deep: true })
  console.log(`1. 深い走査 (初回・全件 INSERT): ${ms(at)}`)

  at = Date.now()
  await service.scan({ deep: true })
  console.log(`2. 深い走査 (2 回目・全件 upsert = これまでの毎回): ${ms(at)}`)

  at = Date.now()
  await service.scan({ deep: false, roots: [root] })
  console.log(`3. 増分走査 (変更なし・枝刈りあり): ${ms(at)}`)

  // Adds one item to a directory at depth 1 (the route on which the parent's mtime changes, so the pruning is disabled).
  writeFileSync(join(root, 'd0', 'new.txt'), 'new')
  at = Date.now()
  await service.scan({ deep: false, roots: [root] })
  console.log(`4. 増分走査 (深さ 1 に 1 件追加 = 枝刈りが外れる): ${ms(at)}`)
  console.log(`   拾えたか: ${store.findByPath(join(root, 'd0', 'new.txt')) !== null}`)

  // Adds one item to a grandchild or deeper (the parent's mtime does not change = a blind spot of pruning, which the watcher is responsible for catching).
  writeFileSync(join(root, 'd1', 's0', 'deep.txt'), 'deep')
  at = Date.now()
  await service.scan({ deep: false, roots: [root] })
  console.log(`4b. 増分走査 (孫以下に 1 件追加 = 枝刈りの死角): ${ms(at)}`)
  console.log(`   拾えたか: ${store.findByPath(join(root, 'd1', 's0', 'deep.txt')) !== null}`)

  // Deletes an entire tree at depth 1 (to see how well the cleanup works).
  rmSync(join(root, 'd2'), { recursive: true, force: true })
  at = Date.now()
  await service.scan({ deep: false, roots: [root] })
  console.log(`4c. 増分走査 (深さ 1 の木を削除 = 範囲付きの掃除): ${ms(at)}`)
  console.log(`   消えたか: ${store.findByPath(join(root, 'd2')) === null}`)

  // Incremental scan with pruning turned off (only the writes are skipped; this is the form for roots outside the home directory).
  settings.write('scan.prune', '0')
  at = Date.now()
  await service.scan({ deep: false, roots: [root] })
  console.log(`5. 増分走査 (枝刈り無し = ホーム外のルート): ${ms(at)}`)
  settings.remove('scan.prune')

  await service.stop()
  const rows = db.prepare(`SELECT count(*) AS n FROM documents`).get() as { n: number }
  console.log(`documents: ${rows.n.toLocaleString()} 行`)
  db.close()
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    rmSync(base, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  })

