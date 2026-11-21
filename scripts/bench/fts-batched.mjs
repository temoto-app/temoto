// Measures the shape after P2 + P3 are in, grown to a million chunks.
//
// The control for `fts-scale.mjs` (one document = one transaction, crisismerge default 16). Here it is built the same way as the implementation:
//   - N documents (default 40) are written in one transaction (P2)
//   - `crisismerge` is set to 256 (P3). `automerge` stays at its default (4)
//   - after each COMMIT, `merge N` is run in slices within a time budget (50 ms) (P3)
//
// What it looks at is **the largest single synchronous block**. better-sqlite3 has a synchronous API, so whether the UI freezes
// is decided here, not by the total time (same viewpoint as T8).
//
//   node scripts/bench/fts-batched.mjs 125000 25000 40
//
// For comparison, the old form can also be run:
//   node scripts/bench/fts-batched.mjs 125000 25000 1 legacy
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DOCS = Number(process.argv[2] ?? 125000)
const WINDOW = Number(process.argv[3] ?? 25000)
const PER_TX = Number(process.argv[4] ?? 40)
const LEGACY = process.argv[5] === 'legacy'
const CHUNKS = 8
const WORDS = 40
/** Same as the implementation (`IndexService.MERGE_BUDGET_MS`). */
const MERGE_BUDGET_MS = 50
/** Same as the implementation (`IndexStore.MERGE_PAGES`). */
const MERGE_PAGES = 32
/** Same as the implementation (`IndexStore.CRISIS_MERGE`). */
const CRISIS_MERGE = 256

const dir = mkdtempSync(join(tmpdir(), 'aios-batched-'))
let seed = 42
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const vocab = Array.from({ length: 60000 }, () => 'w' + Math.floor(rnd() * 1e9).toString(36))
const text = () =>
  Array.from({ length: WORDS }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ')

const db = new Database(join(dir, 's.db'))
db.pragma(`key='bench'`) // Encrypted, as on the real machine
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')
db.pragma('cache_size = -65536')
db.exec(`
  CREATE TABLE documents (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, name TEXT, index_state TEXT NOT NULL DEFAULT 'pending', indexed_at INTEGER, content_hash TEXT, lang TEXT);
  CREATE TABLE chunks (id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, seq INTEGER NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, chars INTEGER NOT NULL);
  CREATE INDEX chunks_document ON chunks (document_id, seq);
  CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2', content = '', contentless_delete = 1);
  CREATE TABLE index_failures (document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, reason TEXT NOT NULL, at INTEGER NOT NULL);
`)
if (!LEGACY) db.exec(`INSERT INTO chunk_fts(chunk_fts, rank) VALUES('crisismerge', ${CRISIS_MERGE})`)

const ins = db.prepare(`INSERT INTO documents (name) VALUES (?)`)
db.transaction(() => {
  for (let i = 0; i < DOCS; i += 1) ins.run('d' + i)
})()

const delFts = db.prepare(
  `DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)`
)
const delChunks = db.prepare(`DELETE FROM chunks WHERE document_id = ?`)
const insChunk = db.prepare(
  `INSERT INTO chunks (document_id, seq, byte_start, byte_end, chars) VALUES (?, ?, ?, ?, ?)`
)
const insFts = db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`)
const setState = db.prepare(
  `UPDATE documents SET index_state = ?, indexed_at = ?, content_hash = ?, lang = ? WHERE id = ?`
)
const clearFailure = db.prepare(`DELETE FROM index_failures WHERE document_id = ?`)
const mergeStmt = db.prepare(`INSERT INTO chunk_fts(chunk_fts, rank) VALUES('merge', ?)`)
const totalChanges = db.prepare(`SELECT total_changes() AS t`).pluck()

// **`run().changes` cannot be used**: an INSERT into a virtual table always returns 1.
// The signal FTS5 exposes is the growth of `total_changes()`, which goes up by 1 only when the step had no work to do (measured).
function mergeStep(pages = MERGE_PAGES) {
  const before = totalChanges.get()
  mergeStmt.run(pages)
  return Math.max(0, totalChanges.get() - before - 1)
}

const one = (docId, shadows) => {
  delFts.run(docId)
  delChunks.run(docId)
  for (let i = 0; i < shadows.length; i += 1) {
    insFts.run(insChunk.run(docId, i, 0, 999, 999).lastInsertRowid, shadows[i])
  }
  setState.run('indexed', Date.now(), 'h', 'en', docId)
  clearFailure.run(docId)
}
const tx = db.transaction((ids, texts) => {
  for (let k = 0; k < ids.length; k += 1) one(ids[k], texts[k])
})

const segments = () =>
  db.prepare(`SELECT COUNT(DISTINCT id >> 37) AS n, SUM(LENGTH(block)) AS bytes FROM chunk_fts_data WHERE id > 100`).get()

console.log(
  `# ${LEGACY ? 'legacy (crisismerge 既定, merge なし)' : `P2+P3 (${PER_TX} 文書/tx, crisismerge ${CRISIS_MERGE}, merge 刻み)`} — 暗号化あり`
)
console.log('docs      chunks    window_s  max_tx_ms  max_merge_ms  max_block_ms  block>100  segments  fts_MB  wal_MB')

let maxTx = 0
let maxMerge = 0
let maxBlock = 0
let over100 = 0
let sum = 0
let mergeCalls = 0
const t0 = performance.now()

for (let d = 0; d < DOCS; d += PER_TX) {
  const ids = []
  const texts = []
  for (let k = d; k < Math.min(DOCS, d + PER_TX); k += 1) {
    ids.push(k + 1)
    texts.push(Array.from({ length: CHUNKS }, text))
  }
  const s = performance.now()
  tx(ids, texts)
  const txMs = performance.now() - s

  // Merge right after each COMMIT (P3). Once the budget is exceeded, the rest waits for the next chance.
  let mergeMs = 0
  let worstStep = 0
  if (!LEGACY) {
    const m0 = performance.now()
    for (;;) {
      const step = performance.now()
      const work = mergeStep()
      mergeCalls += 1
      const stepMs = performance.now() - step
      if (stepMs > worstStep) worstStep = stepMs
      if (work === 0) break
      if (performance.now() - m0 >= MERGE_BUDGET_MS) break
    }
    mergeMs = performance.now() - m0
  }
  if (worstStep > maxMerge) maxMerge = worstStep

  // **One synchronous block**: the transaction and one merge step can be split apart, so the longer of the two
  // is the UI's stop time.
  const block = Math.max(txMs, worstStep)
  sum += txMs + mergeMs
  if (txMs > maxTx) maxTx = txMs
  if (block > maxBlock) maxBlock = block
  if (block > 100) over100 += 1

  const done = Math.min(DOCS, d + PER_TX)
  if (done % WINDOW === 0 || done === DOCS) {
    const g = segments()
    const wal = statSync(join(dir, 's.db-wal')).size / 1048576
    console.log(
      String(done).padEnd(9),
      String(done * CHUNKS).padEnd(9),
      (sum / 1000).toFixed(1).padEnd(9),
      maxTx.toFixed(1).padEnd(10),
      maxMerge.toFixed(1).padEnd(13),
      maxBlock.toFixed(1).padEnd(13),
      String(over100).padEnd(10),
      String(g.n).padEnd(9),
      (g.bytes / 1048576).toFixed(0).padEnd(7),
      wal.toFixed(0)
    )
    maxTx = 0
    maxMerge = 0
    maxBlock = 0
    over100 = 0
    sum = 0
  }
}

const g = segments()
console.log(
  'total s',
  ((performance.now() - t0) / 1000).toFixed(1),
  '| db MB',
  (statSync(join(dir, 's.db')).size / 1048576).toFixed(0),
  '| segments',
  g.n,
  '| mergeStep 呼び出し',
  mergeCalls
)
db.close()
