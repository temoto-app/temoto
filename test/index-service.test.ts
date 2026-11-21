/**
 * Integration test of IndexService (ARCHITECTURE.md 6.1 / 6.2 / 6.3 / 6.4 / 6.5).
 *
 * **Uses the real encrypted DB** (as confirmed in Phase 1, Vitest runs on plain Node and can read the N-API prebuild as it is). The model is not called.
 *
 * What is guarded here:
 * - Japanese recall (the needles of spike 11a; **including queries of two characters or fewer**)
 * - The body is not duplicated (constraint 9 / 6.5)
 * - When the canonical copy disappears, the index disappears too (tombstone, 6.2)
 * - Documents with `exposure = ui-only` do not appear in gateway responses (6.3 / 7.6.1)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService, STALE_GAP_WARN } from '../src/index-kernel/service.js'
import { log } from '../src/common/logger.js'
import type { IndexStatus } from '../src/shared/search.js'
import { makeTestDir } from './helpers/tmp.js'

const KEY = 'c'.repeat(64)

let root: string
let dbDir: string
let db: Db
let store: IndexStore
let index: IndexService
let fs: FsIndexer
const statuses: IndexStatus[] = []

/** The canonical conversation (in place of `thread_events`). The index side does not duplicate the body. */
const events = new Map<string, { text: string; threadId: string; ts: number }>()
/** A message that is alive but whose `indexableText` is null (its body cannot be read, but it is in the canonical copy). */
const unreadable = new Set<string>()

beforeAll(async () => {
  // macOS's tmpdir() is under /var/folders and hits the exclusion of 4.4.2, so create it under home.
  root = makeTestDir('index-test')
  dbDir = makeTestDir('indexdb-test')

  mkdirSync(join(root, 'notes'), { recursive: true })
  // Fills in the same needle as spike 11a.
  writeFileSync(
    join(root, 'notes/meeting.md'),
    [
      '# 週次の記録',
      '',
      '昨日の会議で決まったことをまとめる。',
      '承認インボックスの設計を見直す。',
      '青いラベルの付いた課題を先に片付ける。'
    ].join('\n')
  )
  writeFileSync(
    join(root, 'notes/design.md'),
    [
      '# 設計メモ',
      '',
      'DB 全体の暗号化と形態素解析について。',
      '検索応答時間は p50 40 ms だった。'
    ].join('\n')
  )
  writeFileSync(
    join(root, 'notes/infra.txt'),
    'kubernetes のデプロイ手順。rollout restart で更新する。\n'
  )
  writeFileSync(join(root, 'notes/secret.md'), '社外秘の資料。暗号化された記録。\n')
  // A needle for smart case (TODO 291). Place pairs that differ only in case.
  mkdirSync(join(root, 'case'), { recursive: true })
  writeFileSync(join(root, 'case/upper.md'), 'The Kernel System boots quickly.\n')
  writeFileSync(join(root, 'case/lower.md'), 'the kernel system boots quickly.\n')
  writeFileSync(join(root, 'case/config.txt'), 'System config lives here.\n')
  writeFileSync(join(root, 'case/lowconfig.txt'), 'system config lives here.\n')
  writeFileSync(join(root, 'case/cafe.md'), 'Café Latte menu\n')
  // TODO 301: an English chunk mixed with full-width letters (a needle showing that NFKC also applies to English chunks).
  writeFileSync(join(root, 'notes/fullwidth.txt'), 'Deploy to ＡＷＳ before the release.\n')
  // TODO 837: a needle for words that contain symbols.
  writeFileSync(
    join(root, 'notes/symbols.txt'),
    'see foo.bar and file_name and 192.168.1.10 and e-mail v2.3.1 here\n'
  )
  writeFileSync(join(root, 'notes/photo.png'), Buffer.from([0, 1, 2, 3]))
  writeFileSync(join(root, 'notes/huge.bin'), Buffer.from([0, 0, 0, 0]))

  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  runMigrations(db)

  store = new IndexStore(db)
  index = new IndexService({
    db,
    store,
    conversation: {
      readEventText: async (id) => (unreadable.has(id) ? null : (events.get(id) ?? null)),
      threadTitle: async () => 'テストスレッド',
      liveEventIds: async (ids) => ids.filter((id) => events.has(id))
    },
    transcripts: null,
    onStatus: (status) => statuses.push(status)
  })
  fs = new FsIndexer(
    db,
    { onScanStatus: () => {}, onFileChanges: () => {} },
    store,
    root,
    [root]
  )
  await fs.scan()
  await index.build()
}, 60_000)

afterAll(async () => {
  await index.stop()
  await fs.stop()
  db.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

describe('index build (6.2)', () => {
  it('indexes files with a body and notifies progress', () => {
    const status = index.getStatus()
    expect(status.indexed).toBeGreaterThan(0)
    expect(status.pending).toBe(0)
    expect(statuses.length).toBeGreaterThan(0)
  })

  it('kinds without a body are skipped (binaries, images)', () => {
    const rows = db
      .prepare(`SELECT name, index_state FROM documents WHERE kind = 'file'`)
      .all() as { name: string; index_state: string }[]
    const byName = new Map(rows.map((row) => [row.name, row.index_state]))
    expect(byName.get('photo.png')).toBe('skipped')
    expect(byName.get('huge.bin')).toBe('skipped')
    expect(byName.get('meeting.md')).toBe('indexed')
  })

  it('**does not duplicate body text** (constraint 9 / 6.5): no plaintext body in columns or in FTS', () => {
    const columns = (
      db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[]
    ).map((row) => row.name)
    expect(columns).not.toContain('body')
    expect(columns).not.toContain('text')

    // chunks hold only positions.
    const chunkColumns = (
      db.prepare(`PRAGMA table_info(chunks)`).all() as { name: string }[]
    ).map((row) => row.name)
    expect(chunkColumns).toEqual(
      expect.arrayContaining(['document_id', 'seq', 'byte_start', 'byte_end'])
    )
    expect(chunkColumns).not.toContain('text')
  })

  it('unchanged files are not reindexed (Deduplicate stage)', async () => {
    const before = db.prepare(`SELECT count(*) AS n FROM chunks`).get() as { n: number }
    await fs.scan()
    const pending = db
      .prepare(`SELECT count(*) AS n FROM documents WHERE index_state = 'pending'`)
      .get() as { n: number }
    expect(pending.n).toBe(0)
    const after = db.prepare(`SELECT count(*) AS n FROM chunks`).get() as { n: number }
    expect(after.n).toBe(before.n)
  })
})

describe('Japanese search recall (6.4.1 / regression test of spike 11a)', () => {
  // **Includes two characters or fewer.** A trigram gives 0 results here, so the morphological method was chosen.
  const needles: [string, string][] = [
    ['承認インボックス', 'meeting.md'],
    ['暗号化', 'design.md'],
    ['会議', 'meeting.md'],
    ['青', 'meeting.md'],
    ['kubernetes', 'infra.txt'],
    ['形態素解析', 'design.md'],
    ['検索応答時間', 'design.md']
  ]

  for (const [query, expected] of needles) {
    it(`「${query}」 finds ${expected}`, async () => {
      const result = await index.search(query, 'files')
      expect(result.hits.map((hit) => hit.title)).toContain(expected)
    })
  }

  // The minimum character count (P8 / item 41). **Below the minimum it returns `tooShort`, not 0 results.**
  it('two Latin letters do not query the index and return tooShort', async () => {
    const result = await index.search('ku', 'files')
    expect(result.tooShort).toBe(true)
    expect(result.missingChars).toBe(1)
    expect(result.hits).toEqual([])
  })

  it('the minimum length is not applied to gateway (forAgent) searches', async () => {
    const result = await index.search('ku', 'files', { forAgent: true })
    expect(result.tooShort).toBeUndefined()
  })

  it('snippets are made from the canonical copy (word-segmentation spaces do not mix in)', async () => {
    const result = await index.search('暗号化', 'files')
    const hit = result.hits.find((h) => h.title === 'design.md')
    expect(hit).toBeDefined()
    expect(hit?.snippet).toContain('暗号化')
    // The shadow text (the body with spaces inserted inside a Japanese word) must not appear as it is.
    expect(hit?.snippet).not.toContain('暗号 化')
  })

  it('even when a small count is requested, one document does not fill it', async () => {
    // Even when the top chunks are biased toward the same document, the folded result does not become thin.
    const result = await index.search('記録', 'files', { limit: 2 })
    expect(result.hits.length).toBeGreaterThan(1)
  })

  it('results are folded per document (the same file does not appear twice)', async () => {
    const result = await index.search('記録', 'files')
    const ids = result.hits.map((hit) => hit.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('smart case (TODO 291): only terms containing uppercase are case sensitive', () => {
  const titles = async (
    query: string,
    options: { forAgent?: boolean } = {}
  ): Promise<readonly string[]> =>
    (await index.search(query, 'files', options)).hits.map((hit) => hit.title).sort()

  it('all lowercase is case insensitive (as before)', async () => {
    expect(await titles('system')).toEqual(['config.txt', 'lowconfig.txt', 'lower.md', 'upper.md'])
    expect((await index.search('system', 'files')).caseSensitive).toBeUndefined()
  })

  it('a term containing uppercase matches only what is in the body with the same case', async () => {
    expect(await titles('System')).toEqual(['config.txt', 'upper.md'])
    expect((await index.search('System', 'files')).caseSensitive).toBe(true)
    expect(await titles('SYSTEM')).toEqual([])
  })

  it('the decision is per term: `System config` distinguishes case only for System', async () => {
    expect(await titles('System config')).toEqual(['config.txt'])
    expect(await titles('system config')).toEqual(['config.txt', 'lowconfig.txt'])
  })

  it('a full-width Latin query also matches half-width body text (TODO 301: always NFKC on both index and query side)', async () => {
    // Before, a full-width query gave 0 results against ASCII bodies (the shadow on the index side applied NFKC only to Japanese chunks). Now it applies NFKC regardless of language, so it gives the same result as half-width.
    expect(await titles('ｓｙｓｔｅｍ')).toEqual(await titles('system'))
    expect((await index.search('ｓｙｓｔｅｍ', 'files')).caseSensitive).toBeUndefined()
    // A full-width query containing uppercase gives the same judgment and lookup as half-width (smart case comes after NFKC).
    expect(await titles('Ｓｙｓｔｅｍ')).toEqual(await titles('System'))
    expect((await index.search('Ｓｙｓｔｅｍ', 'files')).caseSensitive).toBe(true)
  })

  it('also works for prefix matching while typing (`Syst` finds System)', async () => {
    expect(await titles('Kern')).toEqual(['upper.md'])
  })

  it('diacritics are still folded as before (a case-only matter)', async () => {
    expect(await titles('Cafe')).toEqual(['cafe.md'])
    expect(await titles('Café')).toEqual(['cafe.md'])
    expect(await titles('CAFE')).toEqual([])
  })

  it('the same rule also applies to gateway (forAgent) searches (owner decision (3))', async () => {
    expect(await titles('System', { forAgent: true })).toEqual(['config.txt', 'upper.md'])
    expect(await titles('system', { forAgent: true })).toHaveLength(4)
  })

  it('Japanese terms are unaffected (no case)', async () => {
    expect((await index.search('暗号化', 'files')).caseSensitive).toBeUndefined()
  })
})

describe('symbols inside terms (TODO 837)', () => {
  const titles = async (query: string, prefix = false): Promise<readonly string[]> =>
    (await index.search(query, 'files', prefix ? {} : { forAgent: true })).hits.map((hit) => hit.title)

  it('`foo.bar` / `file_name` / IPs / version numbers / e-mail addresses match', async () => {
    for (const query of ['foo.bar', 'file_name', '192.168.1.10', 'v2.3.1', 'e-mail']) {
      expect(await titles(query), query).toContain('symbols.txt')
    }
  })

  it('a term with the symbols removed and joined (`foobar`) does not match', async () => {
    expect(await titles('foobar')).not.toContain('symbols.txt')
  })

  it("prefix matching (the UI's incremental search) also matches", async () => {
    expect(await titles('foo.ba', true)).toContain('symbols.txt')
    expect(await titles('192.168.1', true)).toContain('symbols.txt')
  })
})

describe('file name filters (TODO 813)', () => {
  const titles = async (query: string): Promise<readonly string[]> =>
    (await index.search(query, 'files')).hits.map((hit) => hit.title)

  it('`ext:` filters by extension (case and a leading dot make no difference)', async () => {
    for (const query of ['foo.bar ext:txt', 'foo.bar ext:TXT', 'foo.bar ext:.txt', 'foo.bar *.txt']) {
      expect(await titles(query), query).toContain('symbols.txt')
    }
    expect(await titles('foo.bar ext:md')).not.toContain('symbols.txt')
    expect(await titles('foo.bar ext:md ext:txt')).toContain('symbols.txt')
  })

  it('`name:` filters by a term contained in the file name', async () => {
    expect(await titles('foo.bar name:symbol')).toContain('symbols.txt')
    expect(await titles('foo.bar name:nothing')).not.toContain('symbols.txt')
  })

  it('Japanese terms become a body search as they are', async () => {
    expect(await titles('会議 ext:md')).toContain('meeting.md')
    expect(await titles('会議 ext:txt')).not.toContain('meeting.md')
  })

  it('in conversation search, requires that the term appears in a message', async () => {
    events.set('f813a', { text: '22719.md を見直したい', threadId: 't813', ts: 5000 })
    events.set('f813b', { text: '22719 の件は電話で済ませた', threadId: 't813', ts: 5001 })
    index.indexConversationEvents([
      { id: 'f813a', threadId: 't813', title: 'あなた', ts: 5000 },
      { id: 'f813b', threadId: 't813', title: 'あなた', ts: 5001 }
    ])
    await index.idle()
    const ids = async (query: string): Promise<readonly (string | null)[]> =>
      (await index.search(query, 'conversation')).hits.map((hit) => hit.eventId)
    expect(await ids('22719')).toEqual(expect.arrayContaining(['f813a', 'f813b']))
    const narrowed = await ids('22719 ext:md')
    expect(narrowed).toContain('f813a')
    expect(narrowed).not.toContain('f813b')
  })
})

describe('full-width Latin and ASCII bodies (TODO 301)', () => {
  it('a half-width query matches an English chunk containing full-width Latin (NFKC on the index side)', async () => {
    const result = await index.search('AWS', 'files')
    expect(result.hits.map((hit) => hit.title)).toContain('fullwidth.txt')
  })

  it('a full-width query matches an English chunk of ASCII only (NFKC on the query side)', async () => {
    const result = await index.search('ｋｕｂｅｒｎｅｔｅｓ', 'files')
    expect(result.hits.map((hit) => hit.title)).toContain('infra.txt')
  })
})

describe('conversation index (6.1)', () => {
  beforeAll(async () => {
    events.set('e1', { text: '承認インボックスの実装を進めたい', threadId: 't1', ts: 1000 })
    events.set('e2', { text: 'インデックスの構築は背景で行います', threadId: 't1', ts: 2000 })
    index.indexConversationEvents([
      { id: 'e1', threadId: 't1', title: 'あなた', ts: 1000 },
      { id: 'e2', threadId: 't1', title: '回答', ts: 2000 }
    ])
    // Here we only want to wait for the write queue. stop() is the termination, and it accepts no writes afterward.
    await index.idle()
  })

  it('can be looked up with in-conversation search', async () => {
    const result = await index.search('インボックス', 'conversation')
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.threadId).toBe('t1')
    expect(result.hits[0]?.eventId).toBe('e1')
  })

  it('the same minimum length applies to in-conversation search (aligns the two adjacent windows)', async () => {
    const result = await index.search('ab', 'conversation')
    expect(result.tooShort).toBe(true)
    expect((await index.search('インボックス', 'conversation')).tooShort).toBeUndefined()
  })

  it('File search and in-conversation search are separated by source', async () => {
    const files = await index.search('インボックス', 'files')
    expect(files.hits.every((hit) => hit.source === 'fs')).toBe(true)
  })

  it('smart case (TODO 291) also works for conversation search (the canonical copy is the conversation body)', async () => {
    events.set('e3', { text: 'Kernel panic を見た', threadId: 't2', ts: 3000 })
    events.set('e4', { text: 'kernel panic はもう出ない', threadId: 't2', ts: 4000 })
    index.indexConversationEvents([
      { id: 'e3', threadId: 't2', title: 'あなた', ts: 3000 },
      { id: 'e4', threadId: 't2', title: '回答', ts: 4000 }
    ])
    await index.idle()
    const cased = await index.search('Kernel panic', 'conversation')
    expect(cased.hits.map((hit) => hit.eventId)).toEqual(['e3'])
    const folded = await index.search('kernel panic', 'conversation')
    expect(folded.hits.map((hit) => hit.eventId).sort()).toEqual(['e3', 'e4'])
    index.removeThread('t2')
    await index.idle()
  })

  it("in-thread search (TODO 496): returns only that thread's messages in chronological order", async () => {
    events.set('s1', { text: 'Deploy の手順をまとめる', threadId: 'ta', ts: 5000 })
    events.set('s2', { text: 'deploy は明日にする', threadId: 'ta', ts: 4000 })
    events.set('s3', { text: 'deploy の別スレッド', threadId: 'tb', ts: 4500 })
    // `_` and `%` are special characters in LIKE. A prefix match must not pick up other threads (`tAx` against `t_x`).
    events.set('s4', { text: 'deploy の特殊文字スレッド', threadId: 't_x', ts: 4600 })
    events.set('s5', { text: 'deploy の似た名前のスレッド', threadId: 'tAx', ts: 4700 })
    index.indexConversationEvents([
      { id: 's1', threadId: 'ta', title: 'user', ts: 5000 },
      { id: 's2', threadId: 'ta', title: 'assistant', ts: 4000 },
      { id: 's3', threadId: 'tb', title: 'user', ts: 4500 },
      { id: 's4', threadId: 't_x', title: 'user', ts: 4600 },
      { id: 's5', threadId: 'tAx', title: 'user', ts: 4700 }
    ])
    await index.idle()
    const folded = await index.searchThread('deploy', 'ta')
    expect(folded.eventIds).toEqual(['s2', 's1'])
    expect(folded.caseSensitive).toBeUndefined()
    // smart case (TODO 291): an uppercase word matches only the messages where the case is kept as it is.
    const cased = await index.searchThread('Deploy', 'ta')
    expect(cased.eventIds).toEqual(['s1'])
    expect(cased.caseSensitive).toBe(true)
    // Full-width letters (TODO 301) are folded to half-width.
    expect((await index.searchThread('ｄｅｐｌｏｙ', 'ta')).eventIds).toEqual(['s2', 's1'])
    expect((await index.searchThread('deploy', 't_x')).eventIds).toEqual(['s4'])
    // The minimum character count is the same as for conversation search.
    expect((await index.searchThread('de', 'ta')).tooShort).toBe(true)
    // Request number (P6): an old number is stale and is not run. It is a different column from the number of conversation search (⌘K).
    expect((await index.searchThread('deploy', 'ta', { seq: 10 })).eventIds).toHaveLength(2)
    expect((await index.searchThread('deploy', 'ta', { seq: 9 })).stale).toBe(true)
    expect((await index.search('deploy', 'conversation', { seq: 1 })).stale).toBeUndefined()
    for (const thread of ['ta', 'tb', 't_x', 'tAx']) index.removeThread(thread)
    await index.idle()
  })

  it('query numbers are compared per window (TODO 497): a smaller number from another window does not become stale', async () => {
    // After window 1 has advanced the number to 7, the first search of a second window (which counts numbers from 1) is also run. The shape that was hit in proxy verification #29: before, the bookkeeping was one for all windows, so window 2's seq 1 / 2 were stale and gave 0 results.
    expect((await index.search('インボックス', 'conversation', { seq: 7, origin: 101 })).stale).toBeUndefined()
    const second = await index.search('インボックス', 'conversation', { seq: 1, origin: 102 })
    expect(second.stale).toBeUndefined()
    expect(second.hits.length).toBeGreaterThan(0)
    // The same for the in-file search column.
    expect((await index.search('インボックス', 'files', { seq: 9, origin: 101 })).stale).toBeUndefined()
    expect((await index.search('インボックス', 'files', { seq: 1, origin: 102 })).stale).toBeUndefined()
    // The column for in-thread search (496) is also per window.
    expect((await index.searchThread('インボックス', 't1', { seq: 50, origin: 101 })).stale).toBeUndefined()
    expect((await index.searchThread('インボックス', 't1', { seq: 1, origin: 102 })).stale).toBeUndefined()
  })

  it('query numbers are compared per window (TODO 497): an old number in the same window is stale', async () => {
    expect((await index.search('インボックス', 'conversation', { seq: 5, origin: 201 })).stale).toBeUndefined()
    expect((await index.search('インボックス', 'conversation', { seq: 4, origin: 201 })).stale).toBe(true)
    // The same number is not stale (a resend).
    expect((await index.search('インボックス', 'conversation', { seq: 5, origin: 201 })).stale).toBeUndefined()
    expect((await index.searchThread('インボックス', 't1', { seq: 3, origin: 201 })).stale).toBeUndefined()
    expect((await index.searchThread('インボックス', 't1', { seq: 2, origin: 201 })).stale).toBe(true)
  })

  it('query numbers are compared per window (TODO 497): when a window is closed (reloaded) its ledger is cleared', async () => {
    const before = index.seqLedgerSize()
    await index.search('インボックス', 'conversation', { seq: 30, origin: 301 })
    await index.search('インボックス', 'files', { seq: 30, origin: 301 })
    await index.searchThread('インボックス', 't1', { seq: 30, origin: 301 })
    expect(index.seqLedgerSize()).toBe(before + 3)
    index.forgetOrigin(301)
    expect(index.seqLedgerSize()).toBe(before)
    // The first search of a renderer that was reloaded (the number returns to 1 with the same id) is run.
    expect((await index.search('インボックス', 'conversation', { seq: 1, origin: 301 })).stale).toBeUndefined()
    expect((await index.searchThread('インボックス', 't1', { seq: 1, origin: 301 })).stale).toBeUndefined()
    // The bookkeeping of other windows is not erased.
    expect((await index.search('インボックス', 'conversation', { seq: 4, origin: 201 })).stale).toBe(true)
  })

  it('TODO 551: a number that lost by a large margin at the entry (a ledger mix-up) is logged as warn only once per key; the search term is not written', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      await index.search('インボックス', 'conversation', { seq: 40, origin: 401 })
      // A small overtake from typing (a small difference) is not kept.
      expect((await index.search('インボックス', 'conversation', { seq: 39, origin: 401 })).stale).toBe(true)
      expect(warn.mock.calls.filter(([event]) => event === 'index.search.staleGap')).toHaveLength(0)
      // The window is reopened and the number starts from 1 (the shape before 497). However many times it is typed, it is logged only once.
      for (const seq of [1, 2, 3]) {
        expect((await index.search('インボックス', 'conversation', { seq, origin: 401 })).stale).toBe(true)
      }
      const gaps = warn.mock.calls.filter(([event]) => event === 'index.search.staleGap')
      expect(gaps).toEqual([['index.search.staleGap', { key: 'conversation:401', seq: 1, latest: 40 }]])
      expect(STALE_GAP_WARN).toBe(10)
      expect(JSON.stringify(gaps)).not.toContain('インボックス')
    } finally {
      warn.mockRestore()
      index.forgetOrigin(401)
    }
  })

  it('TODO 860: entries removed by the retention period (ts < before) are dropped with pruneConversations; they appear in neither search nor counts', async () => {
    events.set('r1', { text: 'retentionword の古い発言', threadId: 'tr', ts: 1000 })
    events.set('r2', { text: 'retentionword の新しい発言', threadId: 'tr', ts: 9000 })
    events.set('r3', { text: 'retentionword の別スレッド', threadId: 'tr2', ts: 1000 })
    index.indexConversationEvents([
      { id: 'r1', threadId: 'tr', title: 'user', ts: 1000 },
      { id: 'r2', threadId: 'tr', title: 'user', ts: 9000 },
      { id: 'r3', threadId: 'tr2', title: 'user', ts: 1000 }
    ])
    await index.idle()
    expect((await index.search('retentionword', 'conversation')).total).toBe(3)
    // r1 has disappeared from the canonical copy (thread_events). The boundary is the same as the canonical `ts < cutoff` (9000 remains).
    events.delete('r1')
    expect(await index.pruneConversations([{ threadId: 'tr', before: 9000 }])).toBe(1)
    const result = await index.search('retentionword', 'conversation')
    expect(result.hits.map((hit) => hit.eventId).sort()).toEqual(['r2', 'r3'])
    expect(result.total).toBe(2)
    expect((await index.searchThread('retentionword', 'tr')).eventIds).toEqual(['r2'])
    // Safe to call any number of times.
    expect(await index.pruneConversations([{ threadId: 'tr', before: 9000 }])).toBe(0)
    await index.removeThread('tr')
    await index.removeThread('tr2')
  })

  it('TODO 860: hits without a canonical copy are discarded and filled from the candidates below, and that document is dropped from the index', async () => {
    events.set('o1', { text: 'orphanword その一', threadId: 'to', ts: 1 })
    events.set('o2', { text: 'orphanword その二', threadId: 'to', ts: 2 })
    events.set('o3', { text: 'orphanword その三', threadId: 'to', ts: 3 })
    index.indexConversationEvents([
      { id: 'o1', threadId: 'to', title: 'user', ts: 1 },
      { id: 'o2', threadId: 'to', title: 'user', ts: 2 },
      { id: 'o3', threadId: 'to', title: 'user', ts: 3 }
    ])
    await index.idle()
    // Two entries disappeared from the canonical copy without the "delete" notice arriving.
    events.delete('o1')
    events.delete('o2')
    const result = await index.search('orphanword', 'conversation', { limit: 1 })
    expect(result.hits.map((hit) => hit.eventId)).toEqual(['o3'])
    expect(result.total).toBe(1)
    expect(result.truncated).toBe(false)
    await index.idle()
    const left = db
      .prepare(`SELECT source_id FROM documents WHERE source = 'conversation' AND source_id LIKE 'to:%'`)
      .pluck()
      .all()
    expect(left).toEqual(['to:o3'])
    await index.removeThread('to')
  })

  it('TODO 863: in-thread search does not return ids of messages missing from the canonical copy, and drops that document from the index', async () => {
    events.set('g1', { text: 'ghostword その一', threadId: 'tg', ts: 1 })
    events.set('g2', { text: 'ghostword その二', threadId: 'tg', ts: 2 })
    events.set('g3', { text: 'Ghostword その三', threadId: 'tg', ts: 3 })
    index.indexConversationEvents([
      { id: 'g1', threadId: 'tg', title: 'user', ts: 1 },
      { id: 'g2', threadId: 'tg', title: 'user', ts: 2 },
      { id: 'g3', threadId: 'tg', title: 'user', ts: 3 }
    ])
    await index.idle()
    expect((await index.searchThread('ghostword', 'tg')).eventIds).toEqual(['g1', 'g2', 'g3'])
    // g1 disappeared from the canonical copy without the "delete" notice arriving (a log was cleared; the thread is alive).
    events.delete('g1')
    // Not returned even on a path that is not smart case (which does not read the body). Before the fix it was ['g1', 'g2', 'g3'].
    expect((await index.searchThread('ghostword', 'tg')).eventIds).toEqual(['g2', 'g3'])
    await index.idle()
    const left = () =>
      db
        .prepare(`SELECT source_id FROM documents WHERE source = 'conversation' AND source_id LIKE 'tg:%' ORDER BY source_id`)
        .pluck()
        .all()
    expect(left()).toEqual(['tg:g2', 'tg:g3'])
    // Even on the smart-case path (which reads the body), remnants that could not be read are dropped.
    events.delete('g3')
    expect((await index.searchThread('Ghostword', 'tg')).eventIds).toEqual([])
    await index.idle()
    expect(left()).toEqual(['tg:g2'])
    await index.removeThread('tg')
  })

  it('TODO 863: the smart case path does not drop documents of live messages that are merely unreadable', async () => {
    events.set('u1', { text: 'Unreadword その一', threadId: 'tu', ts: 1 })
    events.set('u2', { text: 'Unreadword その二', threadId: 'tu', ts: 2 })
    index.indexConversationEvents([
      { id: 'u1', threadId: 'tu', title: 'user', ts: 1 },
      { id: 'u2', threadId: 'tu', title: 'user', ts: 2 }
    ])
    await index.idle()
    const left = () =>
      db
        .prepare(`SELECT source_id FROM documents WHERE source = 'conversation' AND source_id LIKE 'tu:%' ORDER BY source_id`)
        .pluck()
        .all()
    // u1 is alive but its body cannot be read; u2 has disappeared from the canonical copy.
    unreadable.add('u1')
    events.delete('u2')
    expect((await index.searchThread('Unreadword', 'tu')).eventIds).toEqual([])
    await index.idle()
    expect(left()).toEqual(['tu:u1'])
    unreadable.delete('u1')
    await index.removeThread('tu')
  })

  it('TODO 863: the list of thread ids that have conversation documents (compared by the startup cleanup)', async () => {
    events.set('l1', { text: 'listword その一', threadId: 'tl1', ts: 1 })
    events.set('l2', { text: 'listword その二', threadId: 'tl1', ts: 2 })
    events.set('l3', { text: 'listword その三', threadId: 'tl2', ts: 3 })
    index.indexConversationEvents([
      { id: 'l1', threadId: 'tl1', title: 'user', ts: 1 },
      { id: 'l2', threadId: 'tl1', title: 'user', ts: 2 },
      { id: 'l3', threadId: 'tl2', title: 'user', ts: 3 }
    ])
    await index.idle()
    const ids = await index.listConversationThreadIds()
    expect(ids.filter((id) => id === 'tl1' || id === 'tl2').sort()).toEqual(['tl1', 'tl2'])
    // No duplicates.
    expect(new Set(ids).size).toBe(ids.length)
    await index.removeThread('tl1')
    await index.removeThread('tl2')
    expect(await index.listConversationThreadIds()).not.toContain('tl1')
  })

  it('deleting a thread also removes it from the index (tombstone)', async () => {
    index.removeThread('t1')
    await index.idle()
    const result = await index.search('インボックス', 'conversation')
    expect(result.hits).toHaveLength(0)
  })
})

describe('tombstone (6.2): when the canonical copy is gone, the index entry goes too', () => {
  it('deleting a file and rescanning drops that document and its chunks', async () => {
    const before = await index.search('rollout', 'files')
    expect(before.hits.length).toBeGreaterThan(0)

    rmSync(join(root, 'notes/infra.txt'))
    await fs.scan()

    const orphans = db
      .prepare(
        `SELECT count(*) AS n FROM chunks c
         LEFT JOIN documents d ON d.id = c.document_id WHERE d.id IS NULL`
      )
      .get() as { n: number }
    expect(orphans.n).toBe(0)

    const after = await index.search('rollout', 'files')
    expect(after.hits).toHaveLength(0)
  })
})

describe('exposure (6.3 / 7.6.1): separate what can be searched from what may be given to the AI', () => {
  let secretId: string

  beforeAll(async () => {
    const row = db
      .prepare(`SELECT id FROM documents WHERE name = 'secret.md'`)
      .get() as { id: number }
    secretId = String(row.id)
    db.prepare(`UPDATE documents SET exposure = 'ui-only' WHERE id = ?`).run(row.id)
  })

  it('appears in the UI search', async () => {
    const result = await index.search('社外秘', 'files')
    expect(result.hits.map((hit) => hit.title)).toContain('secret.md')
  })

  it('**does not appear in the gateway (AI) search**', async () => {
    const result = await index.search('社外秘', 'files', { forAgent: true })
    expect(result.hits.map((hit) => hit.title)).not.toContain('secret.md')
  })

  it('getDocument / getDocumentText / getChunk from the gateway are also refused', async () => {
    expect(await index.getDocument(secretId, 4096, true)).toBeNull()
    expect(await index.getDocumentText(secretId, 0, 100, true)).toBeNull()
    // Readable from the UI side.
    expect(await index.getDocument(secretId, 4096, false)).not.toBeNull()
  })
})

describe('retrieval for the gateway (7.6.1)', () => {
  it('getDocument returns the head of the body and has_more', async () => {
    const hits = await index.search('会議', 'files', { forAgent: true })
    const id = hits.hits[0]?.id
    expect(id).toBeDefined()
    const document = (await index.getDocument(id as string, 32, true)) as Record<string, unknown>
    expect(document['uri']).toMatch(/^file:\/\//)
    expect(document['has_more']).toBe(true)
    expect(String(document['text']).length).toBeGreaterThan(0)
  })

  it('getDocumentText rereads from the canonical copy (disk)', async () => {
    const hits = await index.search('会議', 'files', { forAgent: true })
    const id = hits.hits[0]?.id as string
    const range = (await index.getDocumentText(id, 0, 64, true)) as Record<string, unknown>
    expect(String(range['text']).length).toBeGreaterThan(0)
    expect(range['offset']).toBe(0)
  })
})

describe('gateway paging (TODO 839)', () => {
  /** Mixes 3-byte kanji and 4-byte emoji so that the 256-byte boundary falls in the middle of a character. */
  const PAGED = Array.from({ length: 60 }, (_, i) => `${i}行目: 頁送りの検査😀と漢字🎌。`).join('\n')

  function docIdOf(name: string): string {
    const row = db.prepare(`SELECT id FROM documents WHERE name = ?`).get(name) as { id: number }
    return String(row.id)
  }

  /** Keeps sending getDocumentText with next_offset to assemble the whole text. */
  async function readAll(id: string, start: number, length: number): Promise<string> {
    let text = ''
    let offset: number | null = start
    for (let guard = 0; offset !== null && guard < 1000; guard += 1) {
      const page = (await index.getDocumentText(id, offset, length, true)) as Record<string, unknown>
      const chunk = page['text'] as string
      expect(chunk).not.toContain('�')
      expect(page['bytes']).toBe(Buffer.byteLength(chunk, 'utf8'))
      expect(page['offset']! as number + (page['bytes'] as number)).toBe(
        page['next_offset'] ?? page['total_bytes']
      )
      text += chunk
      offset = page['next_offset'] as number | null
    }
    return text
  }

  beforeAll(async () => {
    writeFileSync(join(root, 'notes/paging.md'), PAGED)
    await fs.scan()
    await index.build()
    events.set('paging-ev', { text: PAGED, threadId: 'tp', ts: 9000 })
    index.indexConversationEvents([{ id: 'paging-ev', threadId: 'tp', title: '回答', ts: 9000 }])
    await index.idle()
  }, 60_000)

  it('after returning a short Japanese document in full, has_more is false and next_offset is null', async () => {
    const document = (await index.getDocument(docIdOf('meeting.md'), 4096, true)) as Record<
      string,
      unknown
    >
    expect(document['has_more']).toBe(false)
    expect(document['next_offset']).toBeNull()
    expect(Buffer.byteLength(document['text'] as string)).toBe(document['total_bytes'])
  })

  it('fs: sending getDocumentText by next_offset restores the same string as the canonical copy (no garbling at boundaries)', async () => {
    const id = docIdOf('paging.md')
    expect(await readAll(id, 0, 256)).toBe(PAGED)
    expect(await readAll(id, 0, 257)).toBe(PAGED)
  })

  it('fs: reading the continuation of getDocument from next_offset has no gaps', async () => {
    const id = docIdOf('paging.md')
    const head = (await index.getDocument(id, 300, true)) as Record<string, unknown>
    expect(head['has_more']).toBe(true)
    expect(head['text']).not.toContain('�')
    const rest = await readAll(id, head['next_offset'] as number, 256)
    expect((head['text'] as string) + rest).toBe(PAGED)
  })

  it('fs: an offset in the middle of a character is moved to the start of the next character', async () => {
    const id = docIdOf('paging.md')
    // The 3-byte character in the leading "0 + line" marker string starts at byte 1. It points to byte 2.
    const page = (await index.getDocumentText(id, 2, 256, true)) as Record<string, unknown>
    expect(page['offset']).toBe(4)
    expect((page['text'] as string).startsWith('目')).toBe(true)
  })

  it('conversation: sending getDocumentText by next_offset restores the same string as the canonical copy', async () => {
    const row = db
      .prepare(`SELECT id FROM documents WHERE source = 'conversation' AND source_id LIKE ?`)
      .get('%:paging-ev') as { id: number }
    const id = String(row.id)
    expect(await readAll(id, 0, 256)).toBe(PAGED)
    const head = (await index.getDocument(id, 300, true)) as Record<string, unknown>
    expect((head['text'] as string) + (await readAll(id, head['next_offset'] as number, 256))).toBe(
      PAGED
    )
  })
})
