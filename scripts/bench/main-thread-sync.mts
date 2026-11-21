/**
 * "Before" measurement of item 90: five synchronous processes that stay on main's JS thread and scale with the count
 * (the table in TODO.md 90), measured against the real TS modules.
 *
 * Targets (each runs on main's one thread and uses better-sqlite3's synchronous API):
 *   1. The equivalent of `listSummaries`: `ThreadStore.listThreads` + per thread
 *      `previewOf` / `sessionTotals` (the 2N-call path that item 75 aims to reduce)
 *   2. The equivalent of `eventText`: one SELECT + JSON.parse per conversation event
 *      (what item 76 aims to reduce: the re-index at startup)
 *   3. Full-line JSON.parse of a transcript: `TranscriptReader.readMessageText` reads the whole file
 *      and JSON.parses every line for a single snippet (item 78 is the target)
 *   4. `readTimeline` + JSON.parse: up to 2,000 lines every time a thread is opened
 *   5. `redactText`: 14 regular expressions run every time before saving
 *
 * **The real DB is not used; everything here is synthetic data.** The real machine was measured with a different table
 * (2.9 GB / 114.7 × 10,000 = 1,147,000 documents; see the optimization section P1–P7), but the real sizes of `thread_events` and the
 * transcripts have not been measured yet, so the counts that TODO 90 specifies are built here
 * (300 threads / 10,000 events / 16 MB transcript / 2,000 timeline lines / redactText of several KB × 1,000 times). **It calls no model.**
 *
 * How to run (through `vite-node`, as with the other scripts in `scripts/bench/`):
 *
 *   npx vite-node -c vitest.config.ts scripts/bench/main-thread-sync.mts
 *
 * While other sessions run in parallel, the wall-clock time varies by 2 to 3 times (CLAUDE.md, "traps in the measurement itself").
 * Run it 3 times and take the median. Record `uptime` before measuring.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../../src/common/migrations.js'
import { redactText } from '../../src/common/redact.js'
import { ThreadStore } from '../../src/main/session/store.js'
import { TranscriptReader } from '../../src/main/session/adapter/transcript.js'

const KEY = 'c'.repeat(64)

// ---- Counts (as TODO 90 requested) ----
const THREADS = Number(process.argv[2] ?? 300)
const EVENTS_FOR_EVENT_TEXT = Number(process.argv[3] ?? 10_000)
const TRANSCRIPT_TARGET_BYTES = Number(process.argv[4] ?? 16 * 1024 * 1024)
const TRANSCRIPT_READS = Number(process.argv[5] ?? 50)
const TIMELINE_ROWS = Number(process.argv[6] ?? 2_000)
const REDACT_ITERATIONS = Number(process.argv[7] ?? 1_000)

function fmt(ms: number): string {
  return `${ms.toFixed(3)} ms`
}

/** `console.table` can misalign its columns, so output uses our own fixed width. */
function report(label: string, totalMs: number, count: number): void {
  const per = totalMs / count
  console.log(
    `${label}: 合計 ${fmt(totalMs)} / ${count.toLocaleString()} 件 / 1 件あたり ${fmt(per)}`
  )
}

function now(): number {
  return performance.now()
}

// ---------------------------------------------------------------------------
// 1. The equivalent of listSummaries: ThreadStore.listThreads + previewOf + sessionTotals
// ---------------------------------------------------------------------------
function benchListSummaries(db: Database.Database, home: string): void {
  const store = new ThreadStore(db, home)
  const ids: string[] = []
  for (let i = 0; i < THREADS; i += 1) {
    const thread = store.createThread({
      id: `thread-${i}`,
      title: `合成スレッド ${i}`,
      cwd: join(home, `scratch-${i}`),
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    ids.push(thread.id)
    // A session row (the side that sessionTotals sums). Two per thread.
    for (let s = 0; s < 2; s += 1) {
      db.prepare(
        `INSERT INTO sessions (id, thread_id, backend_session_id, started_at, turns, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(`sess-${i}-${s}`, thread.id, `backend-${i}-${s}`, Date.now(), 12, 0.34)
    }
    // The one latest utterance that previewOf picks up.
    db.prepare(
      `INSERT INTO thread_events (id, thread_id, session_id, seq, ts, kind, actor, payload, payload_bytes)
       VALUES (?, ?, NULL, 1, ?, 'assistant_text', 'main', ?, ?)`
    ).run(
      `ev-preview-${i}`,
      thread.id,
      Date.now(),
      JSON.stringify({ text: `合成スレッド ${i} の最後の応答です。` }),
      64
    )
  }

  const at = now()
  // What `emitThreads` does every time: it takes the list, and calls two functions for each thread.
  const threads = store.listThreads()
  for (const thread of threads) {
    store.previewOf(thread.id)
    store.sessionTotals(thread.id)
  }
  const elapsed = now() - at
  report('1. listSummaries (listThreads + previewOf×N + sessionTotals×N)', elapsed, THREADS)
}

// ---------------------------------------------------------------------------
// 2. The equivalent of eventText: one SELECT + JSON.parse per conversation event (the re-index at startup)
// ---------------------------------------------------------------------------
function benchEventText(db: Database.Database, home: string): void {
  const store = new ThreadStore(db, home)
  const thread = store.createThread({
    id: 'thread-eventtext',
    title: '会話索引の流し直し用',
    cwd: home,
    allowedDirs: [],
    retention: 'forever',
    backend: 'agent-cli',
    modelId: null,
    thinking: null
  })
  const ids: string[] = []
  const insert = db.prepare(
    `INSERT INTO thread_events (id, thread_id, session_id, seq, ts, kind, actor, payload, payload_bytes)
     VALUES (?, ?, NULL, ?, ?, ?, 'main', ?, ?)`
  )
  const tx = db.transaction(() => {
    for (let i = 0; i < EVENTS_FOR_EVENT_TEXT; i += 1) {
      const id = `ev-${i}`
      ids.push(id)
      const kind = i % 2 === 0 ? 'user_text' : 'assistant_text'
      const payload = JSON.stringify({ text: `会話イベント本文 ${i} です。数行分のテキストを想定します。` })
      insert.run(id, thread.id, i + 1, Date.now(), kind, payload, Buffer.byteLength(payload))
    }
  })
  tx()

  const at = now()
  for (const id of ids) store.eventText(id)
  const elapsed = now() - at
  report('2. eventText (SELECT + JSON.parse ×N、索引の流し直し相当)', elapsed, EVENTS_FOR_EVENT_TEXT)
}

// ---------------------------------------------------------------------------
// 3. Full-line JSON.parse of a transcript: the whole file is re-read for one snippet
// ---------------------------------------------------------------------------
async function benchTranscriptSnippet(fakeHome: string): Promise<void> {
  const projectsDir = join(fakeHome, '.claude', 'projects', 'proj-a')
  mkdirSync(projectsDir, { recursive: true })
  const fileName = 'session-a.jsonl'
  const filePath = join(projectsDir, fileName)

  // The real-machine shape (as described in 12.7): one JSON per line, with user and assistant mixed.
  // The one item to find is placed near the end (close to the worst case: it is found only after reading every line).
  const lines: string[] = []
  let bytes = 0
  let i = 0
  let targetId = ''
  while (bytes < TRANSCRIPT_TARGET_BYTES) {
    const uuid = `msg-${i}`
    if (bytes > TRANSCRIPT_TARGET_BYTES * 0.9 && targetId === '') targetId = uuid
    const line = JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      uuid,
      timestamp: new Date().toISOString(),
      sessionId: 'session-a',
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `転写の 1 行分の本文です。番号 ${i}。` }]
      }
    })
    lines.push(line)
    bytes += Buffer.byteLength(line) + 1
    i += 1
  }
  writeFileSync(filePath, lines.join('\n') + '\n')

  const reader = new TranscriptReader(fakeHome)
  const fileId = `proj-a/${fileName}`

  const at = now()
  for (let r = 0; r < TRANSCRIPT_READS; r += 1) {
    await reader.readMessageText(fileId, targetId)
  }
  const elapsed = now() - at
  report(
    `3. 転写スニペット (readMessageText、ファイル ${(bytes / 1024 / 1024).toFixed(1)} MB を毎回全行 JSON.parse)`,
    elapsed,
    TRANSCRIPT_READS
  )
}

// ---------------------------------------------------------------------------
// 4. readTimeline + JSON.parse: up to 2,000 lines every time a thread is opened
// ---------------------------------------------------------------------------
function benchReadTimeline(db: Database.Database, home: string): void {
  const store = new ThreadStore(db, home)
  const thread = store.createThread({
    id: 'thread-timeline',
    title: 'タイムライン復元用',
    cwd: home,
    allowedDirs: [],
    retention: 'forever',
    backend: 'agent-cli',
    modelId: null,
    thinking: null
  })
  const insert = db.prepare(
    `INSERT INTO thread_events (id, thread_id, session_id, seq, ts, kind, actor, payload, payload_bytes)
     VALUES (?, ?, NULL, ?, ?, ?, 'main', ?, ?)`
  )
  const tx = db.transaction(() => {
    for (let i = 0; i < TIMELINE_ROWS; i += 1) {
      const kind = i % 2 === 0 ? 'user_text' : 'assistant_text'
      const payload = JSON.stringify({ text: `タイムライン行 ${i}` })
      insert.run(`tl-${i}`, thread.id, i + 1, Date.now(), kind, payload, Buffer.byteLength(payload))
    }
  })
  tx()

  const REPEATS = 20
  const at = now()
  for (let r = 0; r < REPEATS; r += 1) store.readTimeline(thread.id)
  const elapsed = now() - at
  report(`4. readTimeline (${TIMELINE_ROWS.toLocaleString()} 行、開き直し ×N 回)`, elapsed, REPEATS)
}

// ---------------------------------------------------------------------------
// 5. redactText: 14 regular expressions run every time before saving
// ---------------------------------------------------------------------------
function benchRedactText(): void {
  // A few KB, with a few spots that match the patterns mixed in, imitating an ordinary response.
  const paragraph =
    'この応答は普通の説明文です。'.repeat(30) +
    'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" https://example.com\n' +
    'password=hunter2 export AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz0123456789\n' +
    '普通の説明文の続きです。'.repeat(30)
  const text = paragraph.repeat(3) // a few KB
  console.log(`   (redactText 入力: ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)`)

  const at = now()
  for (let i = 0; i < REDACT_ITERATIONS; i += 1) redactText(text)
  const elapsed = now() - at
  report('5. redactText (数 KB の本文 ×N 回)', elapsed, REDACT_ITERATIONS)
}

async function main(): Promise<void> {
  const dbDir = mkdtempSync(join(homedir(), '.aios-benchdb-'))
  const fakeHome = mkdtempSync(join(homedir(), '.aios-benchhome-'))
  const db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)

  console.log(`main-thread-sync bench — ${new Date().toISOString()}`)
  console.log(
    `件数: スレッド ${THREADS} / イベント ${EVENTS_FOR_EVENT_TEXT.toLocaleString()} / ` +
      `転写 ${(TRANSCRIPT_TARGET_BYTES / 1024 / 1024).toFixed(0)} MB ×${TRANSCRIPT_READS} 回 / ` +
      `タイムライン ${TIMELINE_ROWS.toLocaleString()} 行 / redactText ×${REDACT_ITERATIONS.toLocaleString()} 回`
  )
  console.log('')

  try {
    benchListSummaries(db, fakeHome)
    benchEventText(db, fakeHome)
    await benchTranscriptSnippet(fakeHome)
    benchReadTimeline(db, fakeHome)
    benchRedactText()
  } finally {
    db.close()
    rmSync(dbDir, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
