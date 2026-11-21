/**
 * TODO 1096 (wave 66 bundle A): the two sections of conversation search (⌘K): "this working folder" -> "all".
 *
 * The index does not hold a thread's cwd. main looks up the ids of threads "whose cwd is this folder (or under it)" from the threads table
 * (`ThreadStore.threadIdsUnderCwd`), and the index process narrows conversation documents by those ids (`threadIds` of `IndexService.search`).
 *
 * What is looked at:
 * - Boundary: `/a/bc` is not included under `/a/b` (`isSameOrUnderPath` / `threadIdsUnderCwd`). Case and NFC are folded. Logically deleted ones are excluded
 * - Sections: messages from threads in the cwd go into `cwd`, and the rest (other threads, transcripts) go into `hits`, with no overlap
 * - Even if the top of the "all" section is filled with other threads, messages from the cwd thread are not dropped
 * - A section is kept even with 0 matching threads (0 results, item 292). Not applied when there is no cwd or for the gateway
 * - Kernel RPC: checks the array of thread ids, and if it is malformed, no section is made
 *
 * Uses a real SQLite (FTS5, migrations). The model is not called.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { SearchResponse } from '../src/shared/search.js'
import { runMigrations } from '../src/common/migrations.js'
import { conversationCwdPathOf, isSameOrUnderPath, pathToUri } from '../src/common/uri.js'
import { log } from '../src/common/logger.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { IndexKernel } from '../src/index-kernel/kernel.js'
import { ThreadStore } from '../src/main/session/store.js'
import { makeTestDir } from './helpers/tmp.js'

describe('isSameOrUnderPath (TODO 1096)', () => {
  it('the thing itself and below match, a break in the middle (/a/bc) does not', () => {
    expect(isSameOrUnderPath('/a/b', '/a/b')).toBe(true)
    expect(isSameOrUnderPath('/a/b/c', '/a/b')).toBe(true)
    expect(isSameOrUnderPath('/a/bc', '/a/b')).toBe(false)
    expect(isSameOrUnderPath('/a', '/a/b')).toBe(false)
  })

  it('ignores a trailing /, and folds case and NFC; / includes everything; empty matches nothing', () => {
    expect(isSameOrUnderPath('/a/b/', '/a/b')).toBe(true)
    expect(isSameOrUnderPath('/a/b/c', '/a/b/')).toBe(true)
    expect(isSameOrUnderPath('/Users/X/Work', '/users/x/work')).toBe(true)
    expect(isSameOrUnderPath('/a/café', '/a/café')).toBe(true)
    expect(isSameOrUnderPath('/anything', '/')).toBe(true)
    expect(isSameOrUnderPath('', '/a')).toBe(false)
    expect(isSameOrUnderPath('/a', '')).toBe(false)
  })

  it('a slash-only value (//) is treated as / (review)', () => {
    expect(isSameOrUnderPath('/anything', '//')).toBe(true)
    expect(isSameOrUnderPath('//', '/')).toBe(true)
    expect(isSameOrUnderPath('//', '/a')).toBe(false)
    expect(isSameOrUnderPath('relative', '//')).toBe(false)
  })
})

describe('conversationCwdPathOf (review of TODO 1096)', () => {
  it('for an absolute file:// path, passes it even where it hits the exclusion rules', () => {
    expect(conversationCwdPathOf('file:///Users/x/Library/Caches/x')).toBe('/Users/x/Library/Caches/x')
    expect(conversationCwdPathOf('file:///w/app/node_modules/pkg')).toBe('/w/app/node_modules/pkg')
    expect(conversationCwdPathOf('file:///w/a/../b')).toBe('/w/b')
  })

  it('null for non-file:, file:relative, NUL and non-string values', () => {
    for (const bad of ['thread://x', 'file:relative', 'https://example.com/', 'file:///a%00b', 'file://host/a', '', 3, null]) {
      expect(conversationCwdPathOf(bad), String(bad)).toBeNull()
    }
  })
})

describe('ThreadStore.threadIdsUnderCwd (TODO 1096)', () => {
  it('only threads whose cwd is that folder (or under it); /a/bc is not included, and logically deleted ones are excluded', () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      runMigrations(db)
      const store = new ThreadStore(db, '/Users/tester')
      const make = (id: string, cwd: string): void => {
        store.createThread({
          id,
          title: id,
          cwd,
          allowedDirs: [cwd],
          retention: 'forever',
          backend: 'agent-cli',
          modelId: null,
          thinking: null
        })
      }
      make('same', '/w/app')
      make('under', '/w/app/packages/core')
      make('upper', '/W/App')
      make('sibling', '/w/appx')
      make('parent', '/w')
      make('gone', '/w/app')
      store.removeThread('gone')

      expect([...store.threadIdsUnderCwd('/w/app')].sort()).toEqual(['same', 'under', 'upper'])
      expect([...store.threadIdsUnderCwd('/w/app/')].sort()).toEqual(['same', 'under', 'upper'])
      expect(store.threadIdsUnderCwd('/w/ap')).toEqual([])
      expect(store.threadIdsUnderCwd('')).toEqual([])

      // The remembered results are discarded when a thread is created, logically deleted, or restored (review: avoids a full scan on every keystroke).
      make('later', '/w/app/later')
      expect([...store.threadIdsUnderCwd('/w/app')].sort()).toEqual(['later', 'same', 'under', 'upper'])
      store.removeThread('under')
      expect([...store.threadIdsUnderCwd('/w/app')].sort()).toEqual(['later', 'same', 'upper'])
      store.restoreThread('gone')
      expect([...store.threadIdsUnderCwd('/W/APP')].sort()).toEqual(['gone', 'later', 'same', 'upper'])
    } finally {
      db.close()
    }
  })

  it('the second time for the same cwd does not re-read the table', () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      runMigrations(db)
      const store = new ThreadStore(db, '/Users/tester')
      store.createThread({
        id: 't1',
        title: 't1',
        cwd: '/w/app',
        allowedDirs: ['/w/app'],
        retention: 'forever',
        backend: 'agent-cli',
        modelId: null,
        thinking: null
      })
      const first = store.threadIdsUnderCwd('/w/app')
      // Even if the table is rewritten directly (a change that does not go through the proper entry point), the remembered result comes back = it was not reread.
      db.prepare(`UPDATE threads SET cwd = '/elsewhere' WHERE id = 't1'`).run()
      expect(store.threadIdsUnderCwd('/w/app')).toBe(first)
      expect(store.threadIdsUnderCwd('/w/app/')).toBe(first)
    } finally {
      db.close()
    }
  })
})

// ---- index (IndexService) ----

let dbDir: string
let db: Db
let store: IndexStore
let index: IndexService

const KEY = 'e'.repeat(64)
const CWD_URI = 'file:///w/app'

/** The canonical copy of conversations (fake). id -> body, thread, time. */
const events = new Map<string, { text: string; threadId: string; ts: number }>()

function say(id: string, threadId: string, text: string, ts: number): void {
  events.set(id, { text, threadId, ts })
}

beforeAll(async () => {
  dbDir = makeTestDir('conv-cwd-searchdb-test')
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  runMigrations(db)
  store = new IndexStore(db)
  index = new IndexService({
    db,
    store,
    conversation: {
      readEventText: async (id) => events.get(id) ?? null,
      threadTitle: async (threadId) => `題 ${threadId}`,
      liveEventIds: async (ids) => ids.filter((id) => events.has(id))
    },
    transcripts: { readMessageText: async () => '承認インボックス 承認インボックス (転写)' },
    onStatus: () => {}
  })

  // The cwd threads (in1 / in2) have the word only once (lower in BM25); the others (out*) appear many times (they take the top).
  say('a1', 'in1', '承認インボックスの設計を相談した', 1000)
  say('a2', 'in2', '承認インボックスに触れた', 1001)
  for (let i = 0; i < 8; i += 1) {
    say(`o${i}`, `out${i}`, '承認インボックス 承認インボックス 承認インボックス 承認インボックス', 2000 + i)
  }
  await index.indexConversationEvents(
    [...events.entries()].map(([id, event]) => ({ id, threadId: event.threadId, title: 'あなた', ts: event.ts }))
  )
  await index.indexTranscriptMessages({ id: 'tf1', uri: 'transcript://tf1' }, [
    {
      id: 'm1',
      role: 'user',
      text: '承認インボックス 承認インボックス (転写)',
      ts: 3000,
      sessionId: 's1'
    }
  ])
  await index.idle()
}, 60_000)

afterAll(async () => {
  await index.stop()
  db.close()
  rmSync(dbDir, { recursive: true, force: true })
})

function eventIds(hits: SearchResponse['hits']): string[] {
  return hits.map((hit) => hit.eventId ?? hit.uri).sort()
}

describe('conversation section of IndexService.search (TODO 1096)', () => {
  it("messages of the cwd's threads go into the cwd section, other threads and transcripts go everywhere, with no overlap", async () => {
    const result = await index.search('承認インボックス', 'conversation', {
      cwdUri: CWD_URI,
      threadIds: ['in1', 'in2']
    })
    expect(result.cwd?.uri).toBe(CWD_URI)
    expect(eventIds(result.cwd?.hits ?? [])).toEqual(['a1', 'a2'])
    expect(result.cwd?.total).toBe(2)
    const outside = eventIds(result.hits)
    expect(outside).not.toContain('a1')
    expect(outside).not.toContain('a2')
    expect(outside).toEqual(expect.arrayContaining(['o0', 'o7', 'transcript://tf1/m1']))
    expect(result.hits.some((hit) => hit.source === 'transcript')).toBe(true)
  })

  it("even if the top of everywhere is filled by other threads, the cwd threads' messages are not dropped", async () => {
    // When the "all" section is narrowed to 2 results, the top is filled with out* / transcripts (a1 / a2 have the word once, so BM25 ranks them low).
    const plain = await index.search('承認インボックス', 'conversation', { limit: 2 })
    expect(eventIds(plain.hits)).not.toContain('a1')
    const result = await index.search('承認インボックス', 'conversation', {
      limit: 2,
      cwdUri: CWD_URI,
      threadIds: ['in1', 'in2']
    })
    expect(eventIds(result.cwd?.hits ?? [])).toEqual(['a1', 'a2'])
    expect(result.hits).toHaveLength(2)
  })

  it('thread ids are compared by exact match (another thread like in10 that is a prefix match does not enter the in1 section)', async () => {
    say('p1', 'in10', '承認インボックスを別件で', 1500)
    await index.indexConversationEvents([{ id: 'p1', threadId: 'in10', title: 'あなた', ts: 1500 }])
    await index.idle()
    const result = await index.search('承認インボックス', 'conversation', { cwdUri: CWD_URI, threadIds: ['in1'] })
    expect(eventIds(result.cwd?.hits ?? [])).toEqual(['a1'])
    expect(eventIds(result.hits)).toEqual(expect.arrayContaining(['a2', 'p1']))
  })

  it('with no matching thread, a section of 0 hits (item 292); everywhere as usual', async () => {
    const result = await index.search('承認インボックス', 'conversation', { cwdUri: CWD_URI, threadIds: [] })
    expect(result.cwd).toEqual({ uri: CWD_URI, hits: [], total: 0, truncated: false })
    expect(eventIds(result.hits)).toEqual(expect.arrayContaining(['a1', 'a2', 'o0']))
  })

  it('makes no section with no cwd, no thread id, or via the gateway (forAgent)', async () => {
    const none = await index.search('承認インボックス', 'conversation')
    expect(none.cwd).toBeUndefined()
    const noIds = await index.search('承認インボックス', 'conversation', { cwdUri: CWD_URI })
    expect(noIds.cwd).toBeUndefined()
    const agent = await index.search('承認インボックス', 'conversation', {
      cwdUri: CWD_URI,
      threadIds: ['in1'],
      forAgent: true
    })
    expect(agent.cwd).toBeUndefined()
    expect(eventIds(agent.hits)).toContain('a1')
  })

  it('passing a thread id to in-File search changes nothing (no conversation documents appear)', async () => {
    const result = await index.search('承認インボックス', 'files', { cwdUri: CWD_URI, threadIds: ['in1'] })
    expect(result.cwd).toBeUndefined()
    expect(result.hits.some((hit) => hit.source === 'conversation')).toBe(false)
  })

  it('a query that was overtaken (P6) is dropped without making a section', async () => {
    const options = { cwdUri: CWD_URI, threadIds: ['in1'], origin: 9 }
    expect((await index.search('承認インボックス', 'conversation', { ...options, seq: 5 })).stale).toBeUndefined()
    const old = await index.search('承認インボックス', 'conversation', { ...options, seq: 4 })
    expect(old.stale).toBe(true)
    expect(old.cwd).toBeUndefined()
  })
})

describe('kernel index.search (TODO 1096)', () => {
  it('validates the thread id before passing it; makes no section when the cwd URI is refused at the choke point or the id is broken', async () => {
    const root = makeTestDir('conv-cwd-kernel-test')
    try {
      mkdirSync(join(root, 'app'))
      const texts = new Map([
        ['k1', { text: 'カーネルの区画の針', threadId: 'kin', ts: 1 }],
        ['k2', { text: 'カーネルの区画の針', threadId: 'kout', ts: 2 }]
      ])
      const kernel = new IndexKernel({
        notify: () => {},
        call: async (method, params) => {
          if (method === 'conversation.readEventText') {
            return texts.get((params as { eventId: string }).eventId) ?? null
          }
          if (method === 'conversation.threadTitle') return 'テスト'
          return null
        }
      })
      await kernel.methods['open']?.({ file: null, key: null, userVersion: 0, home: root, roots: [root] })
      try {
        await kernel.methods['index.conversationEvents']?.({
          events: [
            { id: 'k1', threadId: 'kin', title: 'あなた', ts: 1 },
            { id: 'k2', threadId: 'kout', title: 'あなた', ts: 2 }
          ]
        })
        const search = async (options: Record<string, unknown>): Promise<SearchResponse> =>
          (await kernel.methods['index.search']?.({
            query: 'カーネルの区画の針',
            scope: 'conversation',
            options
          })) as SearchResponse
        const cwdUri = pathToUri(join(root, 'app'))

        const ok = await search({ cwdUri, threadIds: ['kin'] })
        expect(ok.cwd?.uri).toBe(cwdUri)
        expect(ok.cwd?.hits.map((hit) => hit.eventId)).toEqual(['k1'])
        expect(ok.hits.map((hit) => hit.eventId)).toEqual(['k2'])

        // Even for a cwd that hits an exclusion rule (under node_modules), the section is made (review: the id is looked up from the threads table).
        const excludedCwd = pathToUri(join(root, 'app', 'node_modules', 'pkg'))
        const excluded = await search({ cwdUri: excludedCwd, threadIds: ['kin'] })
        expect(excluded.cwd?.uri).toBe(excludedCwd)
        expect(excluded.cwd?.hits.map((hit) => hit.eventId)).toEqual(['k1'])

        // A malformed id array or a non-array value gives no section (just 2 results in "all"). A refusal is logged without printing the value.
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
        try {
          for (const threadIds of [['kin', 3], 'kin', [''], null]) {
            const broken = await search({ cwdUri, threadIds })
            expect(broken.cwd, JSON.stringify(threadIds)).toBeUndefined()
            expect(broken.hits).toHaveLength(2)
          }
          const rejected = warn.mock.calls.filter(([event]) => event === 'index.search.rejected')
          expect(rejected.map(([, fields]) => fields)).toEqual([
            { field: 'threadIds', reason: 'invalid-id', count: 2 },
            { field: 'threadIds', reason: 'not-array' },
            { field: 'threadIds', reason: 'invalid-id', count: 1 },
            { field: 'threadIds', reason: 'not-array' }
          ])
        } finally {
          warn.mockRestore()
        }
        // A URI that is not file: or is relative is refused at the choke point.
        for (const bad of ['thread://x', 'file:relative', 'https://example.com/']) {
          expect((await search({ cwdUri: bad, threadIds: ['kin'] })).cwd, bad).toBeUndefined()
        }
      } finally {
        await kernel.methods['stop']?.({})
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
