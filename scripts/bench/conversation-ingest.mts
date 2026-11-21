/**
 * Before/after comparison of ingesting conversation events and transcripts (items 76 / 77, ARCHITECTURE.md 6.2.3).
 *
 * Into an encrypted real DB (the same PRAGMAs as `openDatabaseFile`), it runs two forms, both for the first ingest and for
 * "re-index everything already indexed" (the safety net at startup):
 *   - old: for each item, read the body → upsert (autocommit) → `replaceChunks` (its own transaction). The form of `service.ts`
 *     before 2026-09-23 is copied here
 *   - new: `IndexService.indexConversationEvents` / `indexTranscriptMessages`
 *     (upserts of N items in one transaction → only the bodies needed → N items in one transaction)
 *
 * **Wall-clock time varies by 2 to 3 times while other sessions run in parallel** (CLAUDE.md), so the deterministic numbers are printed too:
 *   - tx: the number of COMMITs of write transactions (the part from the merge step `mergeStep` is counted separately as merges)
 *   - auto: write statements run outside a transaction (= one COMMIT per statement)
 *   - rpc: the number of times a body was read (on the real machine, a conversation is a reverse RPC to main plus one SQL in main)
 *   - maxTxMs: the longest single transaction (one stop of the index process)
 *
 * It calls no model and does not start the app. It deletes the DB when done.
 *
 *   npx vite-node -c vitest.config.ts scripts/bench/conversation-ingest.mts -- [count]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Database as Db, Statement } from 'better-sqlite3-multiple-ciphers'
import { openDatabaseFile } from '../../src/common/db-open.js'
import { runMigrations } from '../../src/common/migrations.js'
import { IndexStore } from '../../src/index-kernel/store.js'
import { IndexService } from '../../src/index-kernel/service.js'
import { chunkText } from '../../src/index-kernel/chunk.js'
import { detectLanguage, ensureTokenizer, shadowText } from '../../src/index-kernel/tokenize.js'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const COUNT = Number(argv[0] ?? 5000)
const KEY = 'd'.repeat(64)
const dir = mkdtempSync(join(tmpdir(), 'aios-ingest-bench-'))

interface Counts {
  tx: number
  auto: number
  merges: number
  maxTxMs: number
}

function instrument(db: Db): Counts {
  const counts: Counts = { tx: 0, auto: 0, merges: 0, maxTxMs: 0 }
  const prepare = db.prepare.bind(db)
  const wrap = (statement: Statement): Statement =>
    new Proxy(statement, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if ((prop === 'run' || prop === 'get' || prop === 'all') && !target.readonly && !db.inTransaction) {
            counts.auto += 1
          }
          const result = (value as (...a: unknown[]) => unknown).apply(target, args)
          return result === target ? receiver : result
        }
      }
    })
  db.prepare = ((source: string) => wrap(prepare(source))) as typeof db.prepare
  const transaction = db.transaction.bind(db)
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const wrapped = transaction(fn)
    return (...args: unknown[]) => {
      if (db.inTransaction) return wrapped(...args)
      counts.tx += 1
      const started = performance.now()
      try {
        return wrapped(...args)
      } finally {
        counts.maxTxMs = Math.max(counts.maxTxMs, performance.now() - started)
      }
    }
  }) as typeof db.transaction
  return counts
}

function open(name: string): { db: Db; store: IndexStore; counts: Counts } {
  const db = openDatabaseFile(join(dir, name), KEY)
  runMigrations(db)
  const counts = instrument(db)
  const store = new IndexStore(db)
  const mergeStep = store.mergeStep.bind(store)
  store.mergeStep = (pages?: number) => {
    counts.merges += 1
    return mergeStep(pages)
  }
  return { db, store, counts }
}

// ---- Synthetic data ----

let seed = 7
const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const WORDS = ['承認', 'インボックス', '索引', '会話', '検索', '設計', 'デプロイ', 'kubernetes', 'rollout', 'restart', 'セッション', '暗号化', '背景', '構築', '転写']
const sentence = (): string =>
  Array.from({ length: 12 + Math.floor(rnd() * 30) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ')

const eventText = new Map<string, { text: string; threadId: string; ts: number }>()
const events = Array.from({ length: COUNT }, (_, i) => {
  const id = `ev-${i}`
  const threadId = `t${i % 40}`
  eventText.set(id, { text: sentence(), threadId, ts: i })
  return { id, threadId, title: 'あなた', ts: i }
})
const file = { id: 'session-1', uri: 'transcript://session-1' }
const messages = Array.from({ length: COUNT }, (_, i) => ({
  id: `m-${i}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  text: sentence(),
  ts: i,
  sessionId: 'session-1'
}))

// ---- The old form (the service.ts as it was before 2026-09-23, copied as it is) ----

type Tokenizer = Awaited<ReturnType<typeof ensureTokenizer>>

function analyze(text: string, tokenizer: Tokenizer) {
  const lang = detectLanguage(text)
  const contentHash = createHash('sha256').update(text).digest('hex')
  const chunks = chunkText(text).map((chunk) => ({
    shadow: shadowText(chunk.text, detectLanguage(chunk.text), tokenizer),
    byteStart: chunk.byteStart,
    byteEnd: chunk.byteEnd,
    chars: chunk.chars
  }))
  return { chunks, contentHash, lang }
}

function indexText(store: IndexStore, id: number, text: string, tokenizer: Tokenizer): void {
  const analyzed = analyze(text, tokenizer)
  store.replaceChunks(id, analyzed.chunks, {
    state: analyzed.chunks.length === 0 ? 'skipped' : 'indexed',
    contentHash: analyzed.contentHash,
    lang: analyzed.lang
  })
}

async function legacyConversation(
  store: IndexStore,
  read: (id: string) => Promise<{ text: string } | null>
): Promise<void> {
  const tokenizer = await ensureTokenizer()
  for (const event of events) {
    const canonical = await read(event.id)
    if (canonical === null) continue
    const row = store.upsertDocument({
      source: 'conversation',
      sourceId: `${event.threadId}:${event.id}`,
      uri: `thread://${event.threadId}/${event.id}`,
      name: event.title,
      kind: 'message',
      updatedAt: event.ts,
      version: event.id,
      exposure: 'ui+ai',
      metadata: { threadId: event.threadId },
      seenAt: Date.now()
    })
    if (!row.needsContent) continue
    const stored = store.getDocument(row.id)
    if (stored === null) continue
    indexText(store, stored.id, canonical.text, tokenizer)
  }
}

async function legacyTranscript(store: IndexStore): Promise<void> {
  const tokenizer = await ensureTokenizer()
  for (const message of messages) {
    const row = store.upsertDocument({
      source: 'transcript',
      sourceId: `${file.id}#${message.id}`,
      uri: `transcript://${file.id}/${message.id}`,
      name: message.text.slice(0, 80).replace(/\s+/g, ' ').trim() || message.role,
      kind: 'message',
      updatedAt: message.ts,
      version: message.id,
      exposure: 'ui+ai',
      metadata: { fileId: file.id, messageId: message.id, role: message.role, sessionId: message.sessionId, context: file.uri },
      seenAt: Date.now()
    })
    if (!row.needsContent) continue
    const stored = store.getDocument(row.id)
    if (stored === null) continue
    indexText(store, stored.id, message.text, tokenizer)
  }
}

// ---- Run ----

interface Row {
  case: string
  ms: number
  tx: number
  auto: number
  merges: number
  rpc: number
  maxTxMs: string
}
const rows: Row[] = []

async function measure(
  label: string,
  target: { counts: Counts },
  rpc: { n: number },
  run: () => Promise<unknown>
): Promise<void> {
  const before = { ...target.counts }
  const rpcBefore = rpc.n
  target.counts.maxTxMs = 0
  const started = performance.now()
  await run()
  rows.push({
    case: label,
    ms: Math.round(performance.now() - started),
    tx: target.counts.tx - before.tx - (target.counts.merges - before.merges),
    auto: target.counts.auto - before.auto,
    merges: target.counts.merges - before.merges,
    rpc: rpc.n - rpcBefore,
    maxTxMs: target.counts.maxTxMs.toFixed(1)
  })
}

/** Stands in for the reverse RPC. It returns to the event loop once per round trip only. */
function reverseRpc(counter: { n: number }) {
  return async (id: string) => {
    counter.n += 1
    await new Promise((resolve) => setImmediate(resolve))
    return eventText.get(id) ?? null
  }
}

async function main(): Promise<void> {
  console.log(`件数: ${COUNT.toLocaleString()} (会話 / 転写それぞれ)`)
  await ensureTokenizer()

  // Old
  const legacy = open('legacy.db')
  const legacyRpc = { n: 0 }
  const legacyRead = reverseRpc(legacyRpc)
  await measure('旧 会話 初回', legacy, legacyRpc, () => legacyConversation(legacy.store, legacyRead))
  await measure('旧 会話 全件流し直し', legacy, legacyRpc, () => legacyConversation(legacy.store, legacyRead))
  await measure('旧 転写 初回', legacy, legacyRpc, () => legacyTranscript(legacy.store))
  await measure('旧 転写 全件流し直し', legacy, legacyRpc, () => legacyTranscript(legacy.store))
  legacy.db.close()

  // New
  const fresh = open('new.db')
  const freshRpc = { n: 0 }
  const freshRead = reverseRpc(freshRpc)
  const service = new IndexService({
    db: fresh.db,
    store: fresh.store,
    conversation: { readEventText: freshRead, threadTitle: async () => null },
    transcripts: null,
    onStatus: () => {}
  })
  await measure('新 会話 初回', fresh, freshRpc, () => service.indexConversationEvents(events))
  await measure('新 会話 全件流し直し (7 日ごとの保険)', fresh, freshRpc, () => service.indexConversationEvents(events))
  await measure('新 会話 高水位より後だけ (通常の起動)', fresh, freshRpc, () => service.indexConversationEvents([]))
  await measure('新 転写 初回', fresh, freshRpc, () => service.indexTranscriptMessages(file, messages))
  await measure('新 転写 全件流し直し', fresh, freshRpc, () => service.indexTranscriptMessages(file, messages))
  await service.stop()
  fresh.db.close()

  console.table(rows)
  rmSync(dir, { recursive: true, force: true })
}

main().catch((err: unknown) => {
  console.error(err)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
})
