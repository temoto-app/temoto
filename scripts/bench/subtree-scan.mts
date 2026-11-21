/**
 * Measures the subtree scan at thread creation (item 246, ARCHITECTURE.md 6.2.2 "subtree scan at thread creation").
 *
 * It builds an "existing tree" under the home directory and runs a deep scan over it once (= the index from before aios was closed).
 * Then it builds a synthetic "new repository" tree and runs `FsIndexer.scanSubtree` in order:
 *   1. First time (everything is new): the default limit (50,000 entries / 10 seconds)
 *   2. First time with no limit (only when the size hits the limit; a separate DB from 1)
 *   3. Second time (tree unchanged = pruning)
 *   4. After adding one item at depth 1
 *   5. After deleting one directory at depth 1 (cleanup within a range)
 * Right after 1, it also measures building the body of that subtree **without waiting for idle** (item 249, `IndexService.buildSubtree`,
 * default limit 2,000 documents / 10 seconds). It also prints the time of the recursive CTE that looks up the subtree's bodies, separately.
 * For each run it prints the total time, the rows written, and **the longest time the JS thread was held in one go**: the blank space in
 * a loop that keeps running `setImmediate` (the time that RPCs such as `fs.searchFiles` wait meanwhile). It uses the same method as
 * `scripts/bench/watch-delete.mts`.
 *
 * **Uses an encrypted real DB.** It does not start the app. It calls no model. It deletes the tree and the DB when done.
 *
 *   npx vite-node -c vitest.config.ts scripts/bench/subtree-scan.mts -- [file count] [items per directory] [file count of the existing tree]
 *   (to make the body English only, set `BENCH_BODY=en` first)
 *
 * The default is 5,000 files / 40 items per directory / 20,000 files in the existing tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { SubtreeScanResult } from '../../src/shared/index-rpc.js'
import { runMigrations } from '../../src/common/migrations.js'
import { FsIndexer, SUBTREE_MAX_ENTRIES } from '../../src/index-kernel/indexer.js'
import {
  IndexService,
  SUBTREE_BUILD_MAX_DOCS,
  type SubtreeBuildResult
} from '../../src/index-kernel/service.js'
import { IndexStore } from '../../src/index-kernel/store.js'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const FILES = Number(argv[0] ?? 5_000)
const PER_DIR = Number(argv[1] ?? 40)
const EXISTING = Number(argv[2] ?? 20_000)
const KEY = 'd'.repeat(64)

const base = mkdtempSync(join(homedir(), '.aios-subtree-bench-'))
const home = join(base, 'home')
const repo = join(home, 'work', 'new-repo')

/** Creates `files` entries under `root` in two levels (d<n>/s<m>). Returns the number of directories made. */
function buildTree(root: string, files: number): number {
  let made = 0
  let dirs = 0
  // The body construction (item 249) is measured too, so the body is about 1.5 KB of source-like text. By default it is English plus
  // Japanese comments (each chunk goes to kuromoji); `BENCH_BODY=en` makes it English only.
  const comment = process.env['BENCH_BODY'] === 'en' ? '// design note for the approval inbox' : '// 承認インボックスの設計メモ (合成)'
  const body = `${comment}\nexport function widget(value: number): number {\n  return value * 2\n}\n`.repeat(12)
  for (let i = 0; made < files; i += 1) {
    const dir = join(root, `d${Math.floor(i / 50)}`, `s${i % 50}`)
    mkdirSync(dir, { recursive: true })
    dirs += 1
    for (let j = 0; j < PER_DIR && made < files; j += 1) {
      writeFileSync(join(dir, `f${j}.txt`), body)
      made += 1
    }
  }
  return dirs
}

function openDb(dir: string): Db {
  const db = new Database(join(dir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

/** Measures one run. It also records the longest blank in the loop at the same time. */
async function measure<T extends SubtreeScanResult | SubtreeBuildResult>(
  label: string,
  run: () => Promise<T>
): Promise<void> {
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
  const result = await run()
  const totalMs = performance.now() - started
  await new Promise((done) => setImmediate(done))
  probing = false
  const detail =
    !('state' in result)
      ? `構築 ${result.built.toLocaleString()} 文書 / 残り ${result.left.toLocaleString()} / ` +
        `上限超え ${result.capped ? 'あり' : 'なし'}`
      : result.state === 'skipped'
      ? `skipped (${result.reason})`
      : `${result.state} / 記録 ${result.seen.toLocaleString()} / 書いた ${result.written.toLocaleString()} 行 / ` +
        `刈った ${result.pruned.toLocaleString()} / 掃除 ${result.removed.toLocaleString()}`
  console.log(
    `${label}: ${Math.round(totalMs).toLocaleString()} ms (最長の停止 ${maxBlockMs.toFixed(1)} ms) — ${detail}`
  )
}

function makeIndexer(db: Db): FsIndexer {
  return new FsIndexer(
    db,
    { onScanStatus: () => {}, onFileChanges: () => {} },
    new IndexStore(db),
    home,
    [home],
    { volumesDir: join(base, 'Volumes'), probeUuid: async () => null }
  )
}

async function main(): Promise<void> {
  console.log(`前からある木: ${EXISTING.toLocaleString()} ファイル …`)
  const existingDirs = buildTree(join(home, 'old'), EXISTING)

  const dbDirA = mkdtempSync(join(homedir(), '.aios-subtree-benchdb-'))
  const dbDirB = mkdtempSync(join(homedir(), '.aios-subtree-benchdb-'))
  const dbA = openDb(dbDirA)
  const dbB = openDb(dbDirB)
  const a = makeIndexer(dbA)
  const b = makeIndexer(dbB)
  let at = Date.now()
  await a.scan({ deep: true })
  await b.scan({ deep: true })
  console.log(`  ${existingDirs.toLocaleString()} ディレクトリ / 深い走査 2 回 ${Date.now() - at} ms`)

  console.log(`新しいリポジトリ: ${FILES.toLocaleString()} ファイル / 1 ディレクトリ ${PER_DIR} 件 …`)
  at = Date.now()
  const dirs = buildTree(repo, FILES)
  const entries = FILES + dirs + Math.ceil(dirs / 50)
  console.log(`  ${dirs.toLocaleString()} ディレクトリ (エントリ約 ${entries.toLocaleString()}) / ${Date.now() - at} ms`)

  await measure('1. 初回 (既定の上限)', () => a.scanSubtree(repo))

  // 1c. Building the body of the subtree (item 249). On a machine in use (normally the build does not start by waiting for idle).
  const storeA = new IndexStore(dbA)
  const index = new IndexService({
    db: dbA,
    store: storeA,
    conversation: { readEventText: async () => null, threadTitle: async () => null },
    transcripts: null,
    idle: { idleSeconds: () => 0, onBattery: () => false, schedule: () => () => {} },
    onStatus: () => {}
  })
  const rootId = storeA.findByPath(repo)
  if (rootId === null) throw new Error('repo row missing')
  let cteAt = performance.now()
  const candidates = storeA.pendingInSubtree(rootId, SUBTREE_BUILD_MAX_DOCS + 1).length
  console.log(
    `1c-0. 部分木の本文待ちを引く (再帰 CTE、上限 +1 = ${SUBTREE_BUILD_MAX_DOCS + 1} 件): ` +
      `${(performance.now() - cteAt).toFixed(1)} ms / ${candidates.toLocaleString()} 件`
  )
  cteAt = performance.now()
  const all = storeA.pendingInSubtree(rootId, Number.MAX_SAFE_INTEGER).length
  console.log(
    `1c-0'. 同 (上限なし = 部分木を全部たどる): ${(performance.now() - cteAt).toFixed(1)} ms / ${all.toLocaleString()} 件`
  )
  await measure('1c. 本文の構築 (既定の上限)', () => index.buildSubtree(rootId, repo))
  await index.stop()
  if (entries > SUBTREE_MAX_ENTRIES) {
    // The second run on a tree that was cut short (its directory mtimes are forgotten, so nothing is pruned = everything is walked again).
    await measure('1b. 打ち切った後の 2 回目 (既定の上限)', () => a.scanSubtree(repo))
    await measure('2. 初回 (上限なし)', () =>
      b.scanSubtree(repo, { maxEntries: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY })
    )
  }
  // From here on, measure on the side where everything fit with no limit (the large tree), or on the side that fit within the default.
  const full = entries > SUBTREE_MAX_ENTRIES ? b : a
  const unlimited = { maxEntries: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY }
  await measure('3. 2 回目 (変更なし・枝刈り)', () => full.scanSubtree(repo, unlimited))
  writeFileSync(join(repo, 'd0', 'added.txt'), 'x')
  await measure('4. 深さ 1 に 1 件足した後', () => full.scanSubtree(repo, unlimited))
  rmSync(join(repo, 'd0', 's0'), { recursive: true, force: true })
  await measure('5. 深さ 2 の 1 ディレクトリを消した後', () => full.scanSubtree(repo, unlimited))

  await a.stop()
  await b.stop()
  dbA.close()
  dbB.close()
  rmSync(dbDirA, { recursive: true, force: true })
  rmSync(dbDirB, { recursive: true, force: true })
}

main()
  .catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => rmSync(base, { recursive: true, force: true }))
