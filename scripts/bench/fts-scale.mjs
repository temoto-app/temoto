// How the worst stop time of a COMMIT (= FTS5 flush + merge) grows as the index grows. Encrypted; one document = one tx.
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'aios-scale-'))
const DOCS = Number(process.argv[2] ?? 120000), WINDOW = Number(process.argv[3] ?? 20000), CHUNKS = 8, WORDS = 40
let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const vocab = Array.from({ length: 60000 }, () => 'w' + Math.floor(rnd() * 1e9).toString(36))
const text = () => Array.from({ length: WORDS }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ')
const db = new Database(join(dir, 's.db'))
db.pragma(`key='bench'`)
db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); db.pragma('foreign_keys = ON'); db.pragma('cache_size = -65536')
db.exec(`
  CREATE TABLE documents (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, name TEXT, index_state TEXT NOT NULL DEFAULT 'pending', indexed_at INTEGER, content_hash TEXT, lang TEXT);
  CREATE TABLE chunks (id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, seq INTEGER NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, chars INTEGER NOT NULL);
  CREATE INDEX chunks_document ON chunks (document_id, seq);
  CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2', content = '', contentless_delete = 1);
  CREATE TABLE index_failures (document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, reason TEXT NOT NULL, at INTEGER NOT NULL);
`)
const ins = db.prepare(`INSERT INTO documents (name) VALUES (?)`)
db.transaction(() => { for (let i = 0; i < DOCS; i += 1) ins.run('d' + i) })()
const delFts = db.prepare(`DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)`)
const delChunks = db.prepare(`DELETE FROM chunks WHERE document_id = ?`)
const insChunk = db.prepare(`INSERT INTO chunks (document_id, seq, byte_start, byte_end, chars) VALUES (?, ?, ?, ?, ?)`)
const insFts = db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`)
const setState = db.prepare(`UPDATE documents SET index_state = ?, indexed_at = ?, content_hash = ?, lang = ? WHERE id = ?`)
const clearFailure = db.prepare(`DELETE FROM index_failures WHERE document_id = ?`)
const tx = db.transaction((docId, shadows) => {
  delFts.run(docId); delChunks.run(docId)
  for (let i = 0; i < shadows.length; i += 1) insFts.run(insChunk.run(docId, i, 0, 999, 999).lastInsertRowid, shadows[i])
  setState.run('indexed', Date.now(), 'h', 'en', docId); clearFailure.run(docId)
})
const seg = () => db.prepare(`SELECT COUNT(DISTINCT id >> 37) AS n, SUM(LENGTH(block)) AS bytes FROM chunk_fts_data WHERE id > 100`).get()
let max = 0, over100 = 0, sum = 0, t0 = performance.now()
console.log('docs      chunks    window_ms  max_tx_ms  tx>100ms  segments  fts_MB  wal_MB')
for (let d = 0; d < DOCS; d += 1) {
  const s = performance.now(); tx(d + 1, Array.from({ length: CHUNKS }, text)); const ms = performance.now() - s
  sum += ms; if (ms > max) max = ms; if (ms > 100) over100 += 1
  if ((d + 1) % WINDOW === 0) {
    const g = seg(); const wal = statSync(join(dir, 's.db-wal')).size / 1048576
    console.log(String(d + 1).padEnd(9), String((d + 1) * CHUNKS).padEnd(9), String(Math.round(sum)).padEnd(10), max.toFixed(1).padEnd(10), String(over100).padEnd(9), String(g.n).padEnd(9), (g.bytes / 1048576).toFixed(0).padEnd(7), wal.toFixed(0))
    max = 0; over100 = 0; sum = 0
  }
}
console.log('total s', ((performance.now() - t0) / 1000).toFixed(1), 'db MB', (statSync(join(dir, 's.db')).size / 1048576).toFixed(0))
