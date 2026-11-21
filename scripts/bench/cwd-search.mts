/**
 * Item 100: the cost of the search that shows "inside the current cwd" first (body search and file name search).
 *
 * Into an encrypted real DB (`openDatabaseFile` + `runMigrations`), it builds a tree that imitates the home directory
 * (no real files are created). Body search also gets FTS rows. Then it measures:
 *
 * body search (`chunk_fts MATCH` + JOIN with `documents`):
 *   - one query over the whole tree (the current SQL)
 *   - A: one query restricted to the cwd (`d.parent_id IN (SELECT value FROM json_each(?))`) + one query over the whole tree
 *   - B: one query giving two partitions (`ROW_NUMBER() OVER (<partition> ORDER BY score)`)
 * file name search (`FileNameSearch`):
 *   - no cwd / cwd (small tree) / cwd (large tree)
 *
 * and prints `EXPLAIN QUERY PLAN`. What it looks at is the length of one synchronous call: it runs inside the index process,
 * but RPCs (list, search) wait meanwhile. It calls no model and does not start the app. It deletes the DB when done.
 *
 *   npx vite-node -c vitest.config.ts scripts/bench/cwd-search.mts -- [file count] [cwd file count]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabaseFile } from '../../src/common/db-open.js'
import { runMigrations } from '../../src/common/migrations.js'
import { IndexStore } from '../../src/index-kernel/store.js'
import { FileNameSearch } from '../../src/index-kernel/file-search.js'
import { directoryTreeOf } from '../../src/index-kernel/cwd-scope.js'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const FILES = Number(argv[0] ?? 100_000)
const CWD_FILES = Number(argv[1] ?? 5_000)
const FILES_PER_DIR = 40
const CHUNKS_PER_FILE = 2
const WORDS = 30
const KEY = 'c'.repeat(64)
const dir = mkdtempSync(join(tmpdir(), 'aios-cwd-search-bench-'))
const ROOT = join(homedir(), '.aios-cwd-search-bench')
const CWD = join(ROOT, 'git', 'repo')
const OTHER = join(ROOT, 'other')

let seed = 11
const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const letters = 'abcdefghijklmnopqrstuvwxyz'
const vocab = Array.from({ length: 30_000 }, () =>
  Array.from({ length: 3 + Math.floor(rnd() * 6) }, () => letters[Math.floor(rnd() * 26)]).join('')
)
// Mixes frequent words (appearing in a third of all chunks) with rare words (a few dozen).
const text = (): string => {
  const words = Array.from({ length: WORDS }, () => vocab[Math.floor(rnd() * vocab.length)])
  if (rnd() < 0.33) words.push('common')
  if (rnd() < 0.0005) words.push('rareword')
  return words.join(' ')
}

const db = openDatabaseFile(join(dir, 'bench.db'), KEY)
runMigrations(db)
const store = new IndexStore(db)

function populate(base: string, count: number): void {
  const now = Date.now()
  for (let start = 0; start < count; start += FILES_PER_DIR) {
    // A two-level tree: base/a<n>/d<m>
    const index = start / FILES_PER_DIR
    const dirPath = join(base, `a${index % 50}`, `d${index}`)
    store.transaction(() => {
      const parentId = store.ensureDirectory(dirPath, now)
      for (let i = start; i < Math.min(start + FILES_PER_DIR, count); i += 1) {
        const row = store.upsertFsEntry({
          parentId,
          name: `file${i}-${vocab[i % vocab.length]}.txt`,
          isDirectory: false,
          ext: 'txt',
          size: 100,
          mtimeMs: now,
          seenAt: now
        })
        store.replaceChunks(
          row.id,
          Array.from({ length: CHUNKS_PER_FILE }, (_, seq) => ({
            shadow: text(),
            byteStart: seq * 100,
            byteEnd: seq * 100 + 100,
            chars: 100
          })),
          { state: 'indexed', contentHash: null, lang: 'en' }
        )
      }
    })
  }
}

const built = performance.now()
populate(CWD, CWD_FILES)
populate(OTHER, FILES - CWD_FILES)
db.exec(`INSERT INTO chunk_fts(chunk_fts) VALUES('optimize')`)
console.log(
  `合成: ファイル ${FILES.toLocaleString()} (cwd ${CWD_FILES.toLocaleString()}) / チャンク ${(FILES * CHUNKS_PER_FILE).toLocaleString()} / ${Math.round(performance.now() - built)} ms`
)
store.resetCaches()

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
function time(run: () => unknown, times = 5): { ms: number; max: number } {
  run()
  const samples: number[] = []
  for (let i = 0; i < times; i += 1) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
  }
  return { ms: median(samples), max: Math.max(...samples) }
}

// ---- Body search ----

const LIMIT = 250
const base = `
  SELECT c.id AS chunk_id, c.document_id, bm25(chunk_fts) AS score, d.parent_id
  FROM chunk_fts
  JOIN chunks c ON c.id = chunk_fts.rowid
  JOIN documents d ON d.id = c.document_id
  WHERE chunk_fts MATCH ?
    AND d.source NOT IN ('conversation', 'transcript')
    AND d.exposure IN ('ui+ai', 'ui-only')`
const globalSql = db.prepare(`${base} ORDER BY score LIMIT ?`)
const cwdSql = db.prepare(
  `${base} AND d.parent_id IN (SELECT value FROM json_each(?)) ORDER BY score LIMIT ?`
)
const windowSql = db.prepare(`
  SELECT * FROM (
    SELECT hit.*, ROW_NUMBER() OVER (PARTITION BY hit.inside ORDER BY hit.score) AS rn
    FROM (
      SELECT c.id AS chunk_id, c.document_id, bm25(chunk_fts) AS score, d.parent_id,
             d.parent_id IN (SELECT value FROM json_each(?)) AS inside
      FROM chunk_fts
      JOIN chunks c ON c.id = chunk_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE chunk_fts MATCH ?
        AND d.source NOT IN ('conversation', 'transcript')
        AND d.exposure IN ('ui+ai', 'ui-only')
    ) AS hit
  ) WHERE rn <= ?`)

const tree = directoryTreeOf(store)
const scopes = [
  { name: 'cwd (小さい木)', path: CWD },
  { name: 'cwd (全体を含む木)', path: ROOT }
]
for (const scope of scopes) {
  const started = performance.now()
  const sub = tree.subtree(scope.path)
  const first = performance.now() - started
  const again = time(() => tree.subtree(scope.path))
  console.log(
    `${scope.name}: 部分木のディレクトリ ${sub?.ids.size ?? 0} 件 / 初回 ${first.toFixed(1)} ms (パス表込み) / 2 回目 ${again.ms.toFixed(2)} ms`
  )
}

console.log('\nEQP 全域:')
for (const row of db.prepare(`EXPLAIN QUERY PLAN ${base} ORDER BY score LIMIT ?`).all('"common"', LIMIT) as { detail: string }[])
  console.log('  ', row.detail)
console.log('EQP cwd 絞り:')
for (const row of db
  .prepare(`EXPLAIN QUERY PLAN ${base} AND d.parent_id IN (SELECT value FROM json_each(?)) ORDER BY score LIMIT ?`)
  .all('"common"', '[]', LIMIT) as { detail: string }[])
  console.log('  ', row.detail)

console.log('EQP ファイル名検索の部分木 (fsNamesByParents):')
for (const row of db
  .prepare(
    `EXPLAIN QUERY PLAN SELECT id, name, parent_id FROM documents INDEXED BY documents_tree
     WHERE source = 'fs' AND parent_id IN (${Array.from({ length: 200 }, () => '?').join(',')})`
  )
  .all(...Array.from({ length: 200 }, (_, i) => i)) as { detail: string }[])
  console.log('  ', row.detail)

const queries = ['"common"', '"rareword"', '"ab"*', `"${vocab[7]}"`]
for (const scope of scopes) {
  const json = tree.subtree(scope.path)?.json ?? '[]'
  console.log(`\n本文検索 — ${scope.name}`)
  for (const match of queries) {
    const g = time(() => globalSql.all(match, LIMIT))
    const c = time(() => cwdSql.all(match, json, LIMIT))
    const w = time(() => windowSql.all(json, match, LIMIT))
    const hits = (globalSql.all(match, 1_000_000) as unknown[]).length
    const inside = (cwdSql.all(match, json, 1_000_000) as unknown[]).length
    console.log(
      `  ${match.padEnd(12)} 一致 ${String(hits).padStart(7)} (cwd ${String(inside).padStart(6)}) | 全域 ${g.ms.toFixed(1).padStart(7)} ms | cwd 絞り ${c.ms.toFixed(1).padStart(7)} ms | A 合計 ${(g.ms + c.ms).toFixed(1).padStart(7)} ms | B 窓関数 ${w.ms.toFixed(1).padStart(7)} ms`
    )
  }
}

// The fixed cost when the subtree is the size of a real home directory (12.4 × 10,000 = 124,000 directories, measured for T8).
// A rare word makes the MATCH cost almost zero, so only the cost of building the temporary index for `json_each` is seen.
{
  const big = JSON.stringify(Array.from({ length: 124_000 }, (_, i) => i + 1))
  const fixed = time(() => cwdSql.all('"rareword"', big, LIMIT))
  console.log(
    `\ncwd 絞りの固定費 (部分木 124,000 ディレクトリ・JSON ${(big.length / 1024).toFixed(0)} KB): ${fixed.ms.toFixed(1)} ms (JSON を作るのは初回だけ)`
  )
}

// ---- File name search ----

const nameSearch = new FileNameSearch(store)
// A version that always walks the subtree first (the share threshold is turned off). It shows how much a second read helps on a large tree.
const forced = new FileNameSearch(store, { cwdPassMaxShare: 1 })
console.log('\nファイル名検索 (中央値 / 3 回)')
for (const query of ['file1', 'a', vocab[3] ?? 'x']) {
  const results: string[] = []
  const cases: { label: string; search: FileNameSearch; cwd: string | null }[] = [
    { label: 'cwd 無し', search: nameSearch, cwd: null },
    { label: 'cwd 小', search: nameSearch, cwd: CWD },
    { label: 'cwd 大', search: nameSearch, cwd: ROOT },
    { label: 'cwd 大 (先に歩く)', search: forced, cwd: ROOT }
  ]
  for (const item of cases) {
    const samples: number[] = []
    let outcome = await item.search.search(query, 50, () => false, item.cwd)
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now()
      outcome = await item.search.search(query, 50, () => false, item.cwd)
      samples.push(performance.now() - started)
    }
    results.push(
      `${item.label} ${median(samples).toFixed(0)} ms (cwd ${outcome.cwd?.total ?? '-'} / 全域 ${outcome.total})`
    )
  }
  console.log(`  ${JSON.stringify(query).padEnd(8)} ${results.join(' | ')}`)
}

db.close()
rmSync(dir, { recursive: true, force: true })
