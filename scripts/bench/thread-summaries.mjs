// Item 75: compares the SQL cost of one thread-list call (`SessionManager.listSummaries`) before the fix (2N+1 statements, of which 2 or 3
// per thread call `db.prepare` every time) and after the fix (1 statement).
// No model is called.
//
//   node scripts/bench/thread-summaries.mjs            # 300 threads / 200 events per thread
//   node scripts/bench/thread-summaries.mjs 300 1000   # 1,000 events per thread
//
// The implementation's SQL is copied as is (the old and new versions in `src/main/session/store.ts`). Since the migration TS
// cannot be read from .mjs, the tables are built in the form that folds migrations 2 to 14 together (the columns and indexes are the same).
// An encrypted (PRAGMA key) + WAL file DB. It reports the cost of **the first run right after reopening** (the SQLite page cache is
// empty; the OS cache remains), and the median once warmed up.
//
// The cost of one `emitThreads()` is itself the stop time of main's JS thread. Before the fix, this ran every time `turn_usage` was
// recorded (for each assistant row). After the fix, the only frequent trigger is one `getThreadRecord` statement (primary key), so that is measured too.
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'

const THREADS = Number(process.argv[2] ?? 300)
const EVENTS_PER_THREAD = Number(process.argv[3] ?? 200)
const WARM_RUNS = 50

const dir = mkdtempSync(join(tmpdir(), 'aios-thread-summaries-'))
const file = join(dir, 'aios.db')

function open() {
  const db = new Database(file)
  db.pragma(`key='bench'`) // Encrypted, as on the real machine
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  return db
}

let seed = 7
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const words = Array.from({ length: 4000 }, (_, i) => `語${i.toString(36)}`)
const sentence = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ')

// ---- Build the synthetic DB ----
{
  const db = open()
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL,
      allowed_dirs TEXT NOT NULL DEFAULT '[]', backend TEXT NOT NULL DEFAULT 'agent-cli',
      retention TEXT NOT NULL DEFAULT 'forever', retention_days INTEGER,
      unread INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_event_at INTEGER,
      model_id TEXT, thinking TEXT, setting_sources TEXT NOT NULL DEFAULT '["project"]',
      approval_strict INTEGER NOT NULL DEFAULT 0,
      last_viewer_uri TEXT, last_viewer_highlight TEXT, deleted_at INTEGER,
      turns INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, preview TEXT
    );
    CREATE INDEX threads_updated ON threads (archived, updated_at DESC);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      backend_session_id TEXT NOT NULL, forked_from TEXT, started_at INTEGER NOT NULL,
      ended_at INTEGER, backend_version TEXT,
      turns INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX sessions_thread ON sessions (thread_id, started_at);
    CREATE UNIQUE INDEX sessions_backend ON sessions (backend_session_id);
    CREATE TABLE thread_events (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      session_id TEXT, seq INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'main', parent_tool_use_id TEXT,
      payload TEXT NOT NULL, payload_bytes INTEGER NOT NULL
    );
    CREATE INDEX thread_events_thread ON thread_events (thread_id, seq);
  `)
  const insThread = db.prepare(`
    INSERT INTO threads (id, title, cwd, allowed_dirs, created_at, updated_at, last_event_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const insSession = db.prepare(`
    INSERT INTO sessions (id, thread_id, backend_session_id, started_at, turns, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?)`)
  const insEvent = db.prepare(`
    INSERT INTO thread_events (id, thread_id, session_id, seq, ts, kind, actor, payload, payload_bytes)
    VALUES (?, ?, ?, ?, ?, ?, 'main', ?, ?)`)
  const kinds = ['user_text', 'assistant_text', 'tool_use', 'tool_result', 'turn_usage', 'tool_use', 'tool_result', 'turn_usage']
  const now = Date.now()
  db.transaction(() => {
    for (let t = 0; t < THREADS; t += 1) {
      const id = randomUUID()
      insThread.run(id, sentence(4), `/Users/bench/work/p${t}`, JSON.stringify([`/Users/bench/work/p${t}`, '/Users/bench/Documents']), now - t * 1000, now - t * 1000, now - t * 1000)
      for (let s = 0; s < 2; s += 1) insSession.run(randomUUID(), id, randomUUID(), now - t * 1000 + s, 3 + s, 0.18 * (3 + s))
      for (let e = 0; e < EVENTS_PER_THREAD; e += 1) {
        const kind = kinds[e % kinds.length]
        const payload =
          kind === 'user_text' || kind === 'assistant_text'
            ? JSON.stringify({ text: sentence(kind === 'user_text' ? 20 : 150) })
            : kind === 'tool_use'
              ? JSON.stringify({ toolUseId: randomUUID(), name: 'Read', summary: sentence(6), input: { file_path: `/Users/bench/${sentence(3)}` }, truncated: false })
              : kind === 'tool_result'
                ? JSON.stringify({ toolUseId: randomUUID(), ok: true, bytes: 1234 })
                : JSON.stringify({ model: 'model-x', inputTokens: 3, outputTokens: 100, cacheCreationTokens: 2000, cacheReadTokens: 30000 })
        insEvent.run(randomUUID(), id, null, e + 1, now - t * 1000 + e, kind, payload, Buffer.byteLength(payload))
      }
    }
  })()
  // Fills the columns with the same SQL as the migration 14 backfill (the values the fixed read path reads).
  db.exec(`
    UPDATE threads SET turns = s.turns, cost_usd = s.cost
    FROM (SELECT thread_id, SUM(turns) AS turns, SUM(cost_usd) AS cost FROM sessions GROUP BY thread_id) AS s
    WHERE threads.id = s.thread_id;
    UPDATE threads SET preview = p.text
    FROM (
      SELECT thread_id, CASE WHEN json_valid(payload) THEN substr(json_extract(payload, '$.text'), 1, 480) END AS text
      FROM (
        SELECT thread_id, payload, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY seq DESC) AS rn
        FROM thread_events WHERE kind IN ('assistant_text', 'user_text')
      ) WHERE rn = 1
    ) AS p
    WHERE threads.id = p.thread_id;
  `)
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
}

const normalize = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 120) || null : null)
const toThread = (row) => ({
  id: row.id,
  title: row.title,
  allowedDirs: JSON.parse(row.allowed_dirs),
  settingSources: JSON.parse(row.setting_sources),
  updatedAt: row.updated_at
})

// ---- Before the fix: listThreads, plus sessionTotals / previewOf / latestBackendSessionId for each thread ----
function before(db, stmts) {
  const rows = stmts.selectThreads.all()
  return rows.map((row) => {
    const thread = toThread(row)
    // The old `sessionTotals`: calls prepare every time.
    const totals = db
      .prepare(`SELECT COALESCE(SUM(turns),0) AS turns, COALESCE(SUM(cost_usd),0) AS cost FROM sessions WHERE thread_id = ?`)
      .get(row.id)
    // The old `latestBackendSessionId`: already prepared.
    const latest = stmts.selectLatestSession.get(row.id)
    // The old `previewOf`: calls prepare + JSON.parse every time.
    const p = db
      .prepare(`SELECT payload FROM thread_events WHERE thread_id = ? AND kind IN ('assistant_text','user_text') ORDER BY seq DESC LIMIT 1`)
      .get(row.id)
    const preview = p === undefined ? null : normalize(JSON.parse(p.payload).text)
    return { thread, turns: totals.turns, costUsd: totals.cost, backend: latest?.backend_session_id ?? null, preview }
  })
}

// ---- After the fix: one statement ----
function after(stmts) {
  return stmts.selectRecords.all().map((row) => ({
    thread: toThread(row),
    turns: row.turns,
    costUsd: row.cost_usd,
    backend: row.latest_backend_session_id ?? null,
    preview: normalize(row.preview)
  }))
}

function prepare(db) {
  const latest = `(SELECT s.backend_session_id FROM sessions s WHERE s.thread_id = threads.id ORDER BY s.started_at DESC LIMIT 1)`
  return {
    selectThreads: db.prepare(`SELECT * FROM threads WHERE archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC`),
    selectLatestSession: db.prepare(`SELECT * FROM sessions WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1`),
    selectRecords: db.prepare(`SELECT threads.*, ${latest} AS latest_backend_session_id FROM threads WHERE archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC`),
    selectRecord: db.prepare(`SELECT threads.*, ${latest} AS latest_backend_session_id FROM threads WHERE id = ? AND deleted_at IS NULL`)
  }
}

function time(fn) {
  const started = process.hrtime.bigint()
  const result = fn()
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, result }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const max = (xs) => Math.max(...xs)

function measure(label, run) {
  // The one run right after reopening (the SQLite page cache is empty).
  let db = open()
  let stmts = prepare(db)
  const cold = time(() => run(db, stmts)).ms
  db.close()
  db = open()
  stmts = prepare(db)
  for (let i = 0; i < 5; i += 1) run(db, stmts)
  const warm = Array.from({ length: WARM_RUNS }, () => time(() => run(db, stmts)).ms)
  const sample = run(db, stmts)
  db.close()
  console.log(
    `${label.padEnd(34)} cold ${cold.toFixed(2).padStart(8)} ms   warm median ${median(warm).toFixed(3).padStart(8)} ms   max ${max(warm).toFixed(3).padStart(8)} ms`
  )
  return sample
}

console.log(`threads=${THREADS} events/thread=${EVENTS_PER_THREAD} (encrypted, WAL)`)
const a = measure('before: listSummaries (2N+1)', (db, stmts) => before(db, stmts))
const b = measure('after:  listSummaries (1 文)', (_db, stmts) => after(stmts))
// The results must be the same (so that what is measured is the same).
const same =
  a.length === b.length &&
  a.every((x, i) => x.thread.id === b[i].thread.id && x.turns === b[i].turns && Math.abs(x.costUsd - b[i].costUsd) < 1e-9 && x.backend === b[i].backend && x.preview === b[i].preview)
console.log(`same result: ${same}`)
const ids = b.map((x) => x.thread.id)
measure('after:  getThreadRecord (1 件)', (_db, stmts) => stmts.selectRecord.get(ids[Math.floor(rnd() * ids.length)]))

rmSync(dir, { recursive: true, force: true })
