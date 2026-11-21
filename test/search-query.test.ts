/**
 * Regression of search queries (P6 / ARCHITECTURE.md 6.4).
 *
 * What this guards:
 * - **An old query returns `stale` without running a single SQL statement** (P6).
 *   better-sqlite3 has a synchronous API and no interrupt, so **a statement that is already running cannot be stopped**.
 *   Only what is waiting in front of the queue can be stopped, and this check looks at that.
 * - Query numbers are independent per scope (two search fields are fired separately).
 * - A search from the gateway (`forAgent`) has no number and always runs.
 *
 * The contents of the index itself are checked by `test/index-service.test.ts`. Here we count only
 * whether a search ran.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { makeTestDir } from './helpers/tmp.js'

const KEY = 'd'.repeat(64)

let dbDir: string
let db: Db
let store: IndexStore
let index: IndexService
/** The number of times `IndexStore.search` was called. **This is the measure of whether SQL was run.** */
let searches = 0

const events = new Map<string, { text: string; threadId: string; ts: number }>()

beforeAll(async () => {
  // On macOS tmpdir() is under /var/folders and hits the exclusions in 4.4.2, so it is created under home.
  dbDir = makeTestDir('searchq-test')
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  runMigrations(db)

  store = new IndexStore(db)
  const real = store.search.bind(store)
  // Counts whether it ran. Even when replaced, the SQL still runs as before.
  store.search = ((...args: Parameters<IndexStore['search']>) => {
    searches += 1
    return real(...args)
  }) as IndexStore['search']

  index = new IndexService({
    db,
    store,
    conversation: {
      // Since P1, reading the canonical copy became a reverse RPC to main, so this entry point is async.
      readEventText: async (id) => events.get(id) ?? null,
      threadTitle: async () => 'テストスレッド'
    },
    transcripts: null,
    onStatus: () => {}
  })

  events.set('e1', { text: '承認インボックスの設計を見直す', threadId: 't1', ts: 1000 })
  index.indexConversationEvents([{ id: 'e1', threadId: 't1', title: 'あなた', ts: 1000 }])
  await index.idle()
}, 60_000)

afterAll(async () => {
  await index.stop()
  db.close()
  rmSync(dbDir, { recursive: true, force: true })
})

describe('問い合わせ番号 (P6)', () => {
  it('新しい番号は実行され、hits が返る', async () => {
    const before = searches
    const result = await index.search('インボックス', 'conversation', { seq: 10 })
    expect(searches).toBe(before + 1)
    expect(result.stale).toBeUndefined()
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it('古い番号は**実行されずに** stale で返る', async () => {
    await index.search('インボックス', 'conversation', { seq: 20 })
    const before = searches

    const result = await index.search('インボックス', 'conversation', { seq: 19 })
    // That no SQL statement ran at all.
    expect(searches).toBe(before)
    expect(result.stale).toBe(true)
    expect(result.hits).toEqual([])
    expect(result.total).toBe(0)
  })

  it('同じ番号は実行する (境界は「より小さい」だけ)', async () => {
    await index.search('インボックス', 'conversation', { seq: 30 })
    const before = searches
    const result = await index.search('インボックス', 'conversation', { seq: 30 })
    expect(searches).toBe(before + 1)
    expect(result.stale).toBeUndefined()
  })

  it('番号は scope ごとに独立している (2 つの検索窓)', async () => {
    await index.search('インボックス', 'conversation', { seq: 100 })
    const before = searches
    // The files side is still at 1, so it is not dragged along by conversation's 100.
    const result = await index.search('インボックス', 'files', { seq: 1 })
    expect(searches).toBe(before + 1)
    expect(result.stale).toBeUndefined()
  })

  it('番号を持たない検索 (gateway の forAgent) は常に実行する', async () => {
    await index.search('インボックス', 'conversation', { seq: 1000 })
    const before = searches
    const result = await index.search('インボックス', 'conversation', { forAgent: true })
    expect(searches).toBe(before + 1)
    expect(result.stale).toBeUndefined()
  })

  it('番号無しの検索は最新番号を進めない (gateway が UI を止めない)', async () => {
    await index.search('インボックス', 'conversation', { seq: 2000 })
    await index.search('インボックス', 'conversation', { forAgent: true })
    const before = searches
    // It is still 2000, so 1999 is still old.
    expect((await index.search('x', 'conversation', { seq: 1999 })).stale).toBe(true)
    expect(searches).toBe(before)
    // 2001 is newer, so it passes.
    expect((await index.search('インボックス', 'conversation', { seq: 2001 })).stale).toBeUndefined()
  })

  it('引ける語が無いクエリは stale ではなく普通の空結果', async () => {
    const result = await index.search('!!!', 'conversation', { seq: 3000 })
    expect(result.stale).toBeUndefined()
    expect(result.hits).toEqual([])
  })
})
