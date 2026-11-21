// Measures the cost of a one-character prefix search and of COUNT(*), with the same SQL as the real code (200,000 chunks).
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'aios-srch-'))
const DOCS = Number(process.argv[2] ?? 25000), CHUNKS = 8, WORDS = 40
const db = new Database(join(dir, 's.db'))
db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); db.pragma('foreign_keys = ON'); db.pragma('cache_size = -65536')
db.exec(`
  CREATE TABLE documents (id INTEGER PRIMARY KEY, source TEXT NOT NULL DEFAULT 'fs', exposure TEXT NOT NULL DEFAULT 'ui+ai', kind TEXT, name TEXT, uri TEXT, parent_id INTEGER, updated_at INTEGER, metadata TEXT);
  CREATE TABLE chunks (id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, seq INTEGER NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, chars INTEGER NOT NULL);
  CREATE INDEX chunks_document ON chunks (document_id, seq);
  CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2', content = '', contentless_delete = 1);
`)
// English-like vocabulary: the first-letter distribution is made to resemble English (words starting with a are about 1/12 of the total)
const letters = 'abcdefghijklmnopqrstuvwxyz'
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const vocab = Array.from({ length: 30000 }, () => Array.from({ length: 3 + Math.floor(rnd() * 6) }, () => letters[Math.floor(rnd() * 26)]).join(''))
const text = () => Array.from({ length: WORDS }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ')
const insDoc = db.prepare(`INSERT INTO documents (name, kind) VALUES (?, 'file')`)
const insChunk = db.prepare(`INSERT INTO chunks (document_id, seq, byte_start, byte_end, chars) VALUES (?, ?, ?, ?, ?)`)
const insFts = db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`)
const t0 = performance.now()
db.transaction(() => {
  for (let d = 0; d < DOCS; d += 1) {
    const docId = insDoc.run('d' + d).lastInsertRowid
    const ids = []
    for (let i = 0; i < CHUNKS; i += 1) ids.push(insChunk.run(docId, i, 0, 999, 999).lastInsertRowid)
    for (const id of ids) insFts.run(id, text())
  }
})()
db.exec(`INSERT INTO chunk_fts(chunk_fts) VALUES('optimize')`)
console.log('built', DOCS * CHUNKS, 'chunks in', Math.round(performance.now() - t0), 'ms')
const sql = `SELECT c.id, c.document_id, bm25(chunk_fts) AS score, d.name FROM chunk_fts
  JOIN chunks c ON c.id = chunk_fts.rowid JOIN documents d ON d.id = c.document_id
  WHERE chunk_fts MATCH ? AND d.source NOT IN ('conversation','transcript') AND d.exposure IN ('ui+ai','ui') ORDER BY score LIMIT 250`
const q = db.prepare(sql)
// P6: what changes when the one-character prefix match is removed. Exact and prefix matches are printed side by side.
for (const m of ['"a"', '"a"*', '"ab"', '"ab"*', '"abc"*', '"abcd"*', `"${vocab[5]}"`, '"a" AND "b"*']) {
  const t = performance.now(); const n = q.all(m).length
  console.log(m.padEnd(14), String(Math.round(performance.now() - t)).padStart(6), 'ms', n, 'hits')
}
const t = performance.now(); db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get(); console.log('COUNT(*) chunks', Math.round(performance.now() - t), 'ms for', DOCS * CHUNKS, 'rows')
