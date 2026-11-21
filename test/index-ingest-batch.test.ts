/**
 * Feeding conversations, transcripts, and plugin documents into the index (items 76 / 77, ARCHITECTURE.md 6.2 / 6.2.3).
 *
 * What is guarded:
 * - **A document that is already indexed is not asked for its body** (upsert → the `needsContent` check → body).
 *   Previously the body was asked for one by one through a reverse RPC before the check (item 76).
 * - **N documents = 1 transaction** (item 77). Previously each document had an autocommit upsert plus `replaceChunks`, so two COMMITs. FTS5 writes out and merges its pending part at every COMMIT (P2), so the number of commits is the stop time as it is.
 * - Termination stops at a batch boundary, and no `pending` row is left behind.
 *
 * The number of COMMITs is measured by counting the outer calls of `db.transaction` and the write statements run outside a transaction (autocommit). It looks at deterministic counts, not at real time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db, Statement } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'

interface Commits {
  transactions: number
  autocommits: number
  /** Of these, the transactions of merging (`mergeStep`, P3). They are excluded from the count of writes. */
  merges: number
}

/** The number of write transactions, excluding merges. */
const writes = (): number => commits.transactions - commits.merges

/**
 * Counts the COMMITs of `db`. It must be applied **before the IndexStore is created** (statements are prepared in the constructor).
 * Also wraps statements that return themselves, such as `pluck()`.
 */
function countCommits(db: Db): Commits {
  const counts: Commits = { transactions: 0, autocommits: 0, merges: 0 }
  const prepare = db.prepare.bind(db)
  const wrap = (statement: Statement): Statement =>
    new Proxy(statement, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if (
            (prop === 'run' || prop === 'get' || prop === 'all') &&
            !target.readonly &&
            !db.inTransaction
          ) {
            counts.autocommits += 1
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
      if (!db.inTransaction) counts.transactions += 1
      return wrapped(...args)
    }
  }) as typeof db.transaction
  return counts
}

let db: Db
let store: IndexStore
let index: IndexService
let commits: Commits
const events = new Map<string, { text: string; threadId: string; ts: number }>()
let asked: string[]
let onAsk: ((id: string) => void) | null

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  commits = countCommits(db)
  store = new IndexStore(db)
  const mergeStep = store.mergeStep.bind(store)
  store.mergeStep = (pages?: number) => {
    commits.merges += 1
    return mergeStep(pages)
  }
  events.clear()
  asked = []
  onAsk = null
  index = new IndexService({
    db,
    store,
    conversation: {
      readEventText: async (id) => {
        asked.push(id)
        onAsk?.(id)
        if (id.startsWith('boom')) throw new Error('rpc failed')
        return events.get(id) ?? null
      },
      threadTitle: async () => 'スレッド'
    },
    transcripts: null,
    plugins: { read: async () => null },
    onStatus: () => {}
  })
})

afterEach(async () => {
  await index.stop()
  db.close()
})

function conversation(count: number, prefix = 'e') {
  const list: { id: string; threadId: string; title: string; ts: number }[] = []
  for (let i = 0; i < count; i += 1) {
    const id = `${prefix}${i}`
    events.set(id, { text: `承認インボックスの話題 その${i}`, threadId: 't1', ts: i })
    list.push({ id, threadId: 't1', title: 'あなた', ts: i })
  }
  return list
}

function states(source: string): Record<string, number> {
  const rows = db
    .prepare(`SELECT index_state AS s, count(*) AS n FROM documents WHERE source = ? GROUP BY 1`)
    .all(source) as { s: string; n: number }[]
  return Object.fromEntries(rows.map((row) => [row.s, row.n]))
}

describe('ingesting conversation events', () => {
  it('writes 100 items in a batch instead of 1 COMMIT per document (item 77)', async () => {
    const handled = await index.indexConversationEvents(conversation(100))
    expect(handled).toBe(100)
    expect(states('conversation')).toEqual({ indexed: 100 })
    // 40 items per batch × (1 upsert + 1 chunk write). Previously it was 100 × 2 = 200 times.
    expect(commits.autocommits).toBe(0)
    expect(writes()).toBeLessThanOrEqual(2 * Math.ceil(100 / 40) + 2)
    const result = await index.search('インボックス', 'conversation')
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it('replaying already indexed events does not ask for the body (item 76)', async () => {
    const list = conversation(50)
    await index.indexConversationEvents(list)
    expect(asked).toHaveLength(50)
    asked = []
    const before = writes()
    const handled = await index.indexConversationEvents(list)
    expect(handled).toBe(50)
    expect(asked).toEqual([])
    // Only the upsert transaction (it does not touch FTS).
    expect(writes() - before).toBe(Math.ceil(50 / 40))
    expect(states('conversation')).toEqual({ indexed: 50 })
  })

  it('an event with no body is skipped, and a read failure is marked failed and processing continues', async () => {
    events.set('ok', { text: '残る発言', threadId: 't1', ts: 1 })
    const handled = await index.indexConversationEvents([
      { id: 'gone', threadId: 't1', title: 'あなた', ts: 0 },
      { id: 'boom1', threadId: 't1', title: 'あなた', ts: 0 },
      { id: 'ok', threadId: 't1', title: 'あなた', ts: 1 }
    ])
    expect(handled).toBe(3)
    expect(states('conversation')).toEqual({ skipped: 1, failed: 1, indexed: 1 })
  })

  it('shutdown stops at a batch boundary and leaves no pending', async () => {
    const list = conversation(200)
    onAsk = (id) => {
      if (id === 'e0') void index.stop()
    }
    const handled = await index.indexConversationEvents(list)
    expect(handled).toBeGreaterThan(0)
    expect(handled).toBeLessThan(200)
    expect(states('conversation')['pending'] ?? 0).toBe(0)
  })

  it('deleting a thread is queued behind ingestion (no chunks are written to a deleted document)', async () => {
    const pending = index.indexConversationEvents(conversation(60))
    index.removeThread('t1')
    await pending
    await index.idle()
    expect(states('conversation')).toEqual({})
    const orphans = db
      .prepare(
        `SELECT count(*) AS n FROM chunks c LEFT JOIN documents d ON d.id = c.document_id
         WHERE d.id IS NULL`
      )
      .get() as { n: number }
    expect(orphans.n).toBe(0)
  })
})

describe('ingesting transcripts', () => {
  const file = { id: 'f1', uri: 'transcript://f1' }
  const messages = Array.from({ length: 90 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `デプロイ手順の確認 ${i}`,
    ts: i,
    sessionId: 's1'
  }))

  it('writes in batches, and the second time reindexes nothing', async () => {
    expect(await index.indexTranscriptMessages(file, messages)).toBe(90)
    expect(commits.autocommits).toBe(0)
    expect(writes()).toBeLessThanOrEqual(2 * Math.ceil(90 / 40) + 2)
    const before = writes()
    expect(await index.indexTranscriptMessages(file, messages)).toBe(0)
    expect(writes() - before).toBe(Math.ceil(90 / 40))
    expect(states('transcript')).toEqual({ indexed: 90 })
  })
})

describe('ingesting plugin documents', () => {
  it('writes the upsert and chunks in one transaction', async () => {
    const before = writes()
    await index.putPluginDocument({
      source: 'test-mail',
      sourceId: 'm1',
      uri: 'test-mail://m1',
      title: '請求書',
      body: '請求書の送付について'
    })
    expect(writes() - before).toBe(1)
    expect(commits.autocommits).toBe(0)
    expect(states('test-mail')).toEqual({ indexed: 1 })
  })
})
