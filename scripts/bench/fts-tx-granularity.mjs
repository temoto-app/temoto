// What "1 document = 1 transaction" does to the number of FTS5 segments and to the stop time of a COMMIT.
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'aios-merge-'))
const DOCS = Number(process.argv[2] ?? 30000), CHUNKS = 8, WORDS = 40
let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const vocab = Array.from({ length: 30000 }, () => 'w' + Math.floor(rnd() * 1e9).toString(36))
const text = () => Array.from({ length: WORDS }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ')
function setup(name, opts) {
  const db = new Database(join(dir, name))
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); db.pragma('foreign_keys = ON'); db.pragma('cache_size = -65536')
  db.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, name TEXT, index_state TEXT NOT NULL DEFAULT 'pending', indexed_at INTEGER, content_hash TEXT, lang TEXT);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, seq INTEGER NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, chars INTEGER NOT NULL);
    CREATE INDEX chunks_document ON chunks (document_id, seq);
    CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2', content = '', contentless_delete = 1);
    CREATE TABLE index_failures (document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, reason TEXT NOT NULL, at INTEGER NOT NULL);
  `)
  if (opts.automerge === false) { db.exec(`INSERT INTO chunk_fts(chunk_fts, rank) VALUES('automerge', 0)`); db.exec(`INSERT INTO chunk_fts(chunk_fts, rank) VALUES('crisismerge', 100000)`) }
  const ins = db.prepare(`INSERT INTO documents (name) VALUES (?)`)
  db.transaction(() => { for (let i = 0; i < DOCS; i += 1) ins.run('d' + i) })()
  return db
}
const segments = (db) => db.prepare(`SELECT COUNT(DISTINCT id >> 37) AS n, COUNT(*) AS rows, SUM(LENGTH(block)) AS bytes FROM chunk_fts_data WHERE id > 100`).get()
const mb = (name) => { const s = (f) => { try { return statSync(join(dir, f)).size } catch { return 0 } }; return { dbMB: (s(name) / 1048576).toFixed(0), walMB: (s(name + '-wal') / 1048576).toFixed(0) } }
function run(label, name, opts) {
  const db = setup(name, opts)
  const delFts = db.prepare(`DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)`)
  const delChunks = db.prepare(`DELETE FROM chunks WHERE document_id = ?`)
  const insChunk = db.prepare(`INSERT INTO chunks (document_id, seq, byte_start, byte_end, chars) VALUES (?, ?, ?, ?, ?)`)
  const insFts = db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`)
  const setState = db.prepare(`UPDATE documents SET index_state = ?, indexed_at = ?, content_hash = ?, lang = ? WHERE id = ?`)
  const clearFailure = db.prepare(`DELETE FROM index_failures WHERE document_id = ?`)
  const one = (docId, shadows) => {
    delFts.run(docId); delChunks.run(docId)
    for (let i = 0; i < shadows.length; i += 1) insFts.run(insChunk.run(docId, i, 0, 999, 999).lastInsertRowid, shadows[i])
    setState.run('indexed', Date.now(), 'h', 'en', docId); clearFailure.run(docId)
  }
  const tx = db.transaction((ids, texts) => { for (let k = 0; k < ids.length; k += 1) one(ids[k], texts[k]) })
  seed = 42
  const times = []
  const t0 = performance.now()
  const per = opts.perTx
  for (let d = 0; d < DOCS; d += per) {
    const ids = [], texts = []
    for (let k = d; k < Math.min(DOCS, d + per); k += 1) { ids.push(k + 1); texts.push(Array.from({ length: CHUNKS }, text)) }
    const s = performance.now(); tx(ids, texts); times.push(performance.now() - s)
  }
  const total = performance.now() - t0
  times.sort((a, b) => a - b)
  const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(1)
  const seg = segments(db)
  let mergeMs = null
  if (opts.automerge === false) { const s = performance.now(); db.exec(`INSERT INTO chunk_fts(chunk_fts) VALUES('optimize')`); mergeMs = Math.round(performance.now() - s) }
  console.log(JSON.stringify({ label, docs: DOCS, txCount: times.length, totalMs: Math.round(total), txMs: { p50: p(0.5), p99: p(0.99), max: times[times.length - 1].toFixed(1) }, segments: seg.n, ftsMB: (seg.bytes / 1048576).toFixed(1), ...mb(name), optimizeMs: mergeMs, segmentsAfterOptimize: mergeMs === null ? undefined : segments(db).n }))
  db.close()
}
run('A: 1 文書 = 1 トランザクション (現行)', 'a.db', { perTx: 1 })
run('B: 40 文書 = 1 トランザクション', 'b.db', { perTx: 40 })
// C / D (automerge stopped) hit SQLITE_FULL at FTS5's limit of 2,000 segments. They are kept for the record but not run by default.
// run('C: current + automerge stopped (optimize at the end)', 'c.db', { perTx: 1, automerge: false })
// run('D: 40 documents/tx + automerge stopped', 'd.db', { perTx: 40, automerge: false })
