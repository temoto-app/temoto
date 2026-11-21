/**
 * Wave 42 code-review bundle X: file debris that eats the top of a search (files that have disappeared, files replaced by a symlink,
 * and files whose intermediate stage now points into an exclusion) is dropped from the index at the moment it is found. If it were not dropped,
 * `collectHits` would stop at `GONE_MAX_READS` (50) entries, and it would stop every time with zero real hits.
 *
 * Real SQLite (in memory) and real disk (`~/.aios-test/<run>/`). Does not call the model.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

const DEBRIS = 60

let root: string
let db: Db
let store: IndexStore
let fs: FsIndexer
let index: IndexService

const rowOf = (name: string): { id: number; index_state: string } | undefined =>
  db
    .prepare(`SELECT id, index_state FROM documents WHERE source = 'fs' AND name = ?`)
    .get(name) as { id: number; index_state: string } | undefined

const countFs = (like: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE source = 'fs' AND name LIKE ?`).get(like) as { n: number }).n

beforeAll(async () => {
  root = makeTestDir('search-fs-debris')
  mkdirSync(join(root, 'gone'))
  mkdirSync(join(root, 'real'))
  mkdirSync(join(root, 'proj', 'sub'), { recursive: true })
  mkdirSync(join(root, '.ssh'))
  // Debris that repeats a short word (ranks high under BM25), and the real file where the word appears once in a long body
  for (let i = 0; i < DEBRIS; i += 1) {
    writeFileSync(join(root, 'gone', `d${i}.md`), 'debrisneedle debrisneedle debrisneedle\n')
  }
  writeFileSync(
    join(root, 'real', 'real.md'),
    `${'plain words about something else entirely. '.repeat(40)}debrisneedle\n`
  )
  writeFileSync(join(root, 'proj', 'sub', 'swapped.md'), 'swapneedle swapneedle\n')
  writeFileSync(join(root, 'proj', 'link.md'), 'linkneedle linkneedle\n')
  writeFileSync(join(root, '.ssh', 'swapped.md'), 'swapneedle swapneedle\n')
  writeFileSync(join(root, '.ssh', 'config'), 'linkneedle linkneedle\n')
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
  fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, root, [root])
  index = new IndexService({
    db,
    store,
    conversation: { readEventText: async () => null, threadTitle: async () => null },
    transcripts: null,
    fsRules: () => fs.exclusionRules,
    onStatus: () => {}
  })
  await fs.scan()
  await index.build()
})

afterAll(async () => {
  await index.stop()
  await fs.stop()
  if (db.open) db.close()
  removeTestDir(root)
})

/** Waits for the writes queued for dropping the debris to finish. */
async function settle(): Promise<void> {
  await index.build()
}

describe('fs の残骸を検索で見つけたら索引から落とす', () => {
  it('消えたファイルが上位を食っても、次の検索では本物が出る', async () => {
    expect(countFs('d%.md')).toBe(DEBRIS)
    rmSync(join(root, 'gone'), { recursive: true })
    const first = await index.search('debrisneedle', 'files', { limit: 5 })
    // After 50 pieces of debris are discarded, the search is cut off and does not yet reach the real file
    expect(first.hits).toHaveLength(0)
    expect(first.truncated).toBe(true)
    await settle()
    // The discarded debris has been dropped from the index
    expect(countFs('d%.md')).toBe(DEBRIS - 50)
    const second = await index.search('debrisneedle', 'files', { limit: 5 })
    expect(second.hits.map((h) => h.title)).toEqual(['real.md'])
    await settle()
    expect(countFs('d%.md')).toBe(0)
  })

  it('ファイルの symlink に差し替わったものは行ごと落とす', async () => {
    const link = join(root, 'proj', 'link.md')
    expect(rowOf('link.md')).toBeDefined()
    rmSync(link)
    symlinkSync(join(root, '.ssh', 'config'), link)
    const result = await index.search('linkneedle', 'files', {})
    expect(result.hits).toHaveLength(0)
    await settle()
    expect(rowOf('link.md')).toBeUndefined()
  })

  it('途中の段が除外の中を指すようになったものは読まずに落とす', async () => {
    const sub = join(root, 'proj', 'sub')
    renameSync(sub, join(root, 'proj', 'sub-old'))
    symlinkSync(join(root, '.ssh'), sub)
    const id = rowOf('swapped.md')?.id
    expect(id).toBeDefined()
    expect(await index.getDocumentText(String(id), 0, 100, true)).toBeNull()
    const result = await index.search('swapneedle', 'files', {})
    expect(result.hits).toHaveLength(0)
    await settle()
    expect(rowOf('swapped.md')).toBeUndefined()
  })
})

describe('本文を入れない種類になった文書 (TODO 863: markSkipped の道)', () => {
  it('前に入った *.env はヒットに出さず、チャンクと FTS だけ落として行は名前の検索に残す', async () => {
    // Builds an index from before 855: enters it under a name of a kind that holds a body, and changes the row's name and the disk name to `.env`
    // (the directory rows are not changed). Reopens it with a new IndexStore / IndexService = the next launch after the version was bumped.
    const dir = join(root, 'legacy')
    mkdirSync(dir)
    writeFileSync(join(dir, 'stage.md'), 'envneedle envneedle DB_PASSWORD=hunter2secret\n')
    await fs.scan()
    await index.build()
    const before = rowOf('stage.md')
    expect(before?.index_state).toBe('indexed')
    const id = before?.id ?? -1
    db.prepare(`UPDATE documents SET name = 'stage.env' WHERE id = ?`).run(id)
    renameSync(join(dir, 'stage.md'), join(dir, 'stage.env'))
    const chunks = (): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?`).get(id) as { n: number }).n
    expect(chunks()).toBeGreaterThan(0)
    const ftsHits = (): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'envneedle'`).get() as { n: number }).n
    expect(ftsHits()).toBeGreaterThan(0)

    const reopened = new IndexService({
      db,
      store: new IndexStore(db),
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: null,
      fsRules: () => fs.exclusionRules,
      onStatus: () => {}
    })
    try {
      // No body hits are shown (neither the on-screen search nor the gateway search).
      expect((await reopened.search('envneedle', 'files', {})).hits).toHaveLength(0)
      expect((await reopened.search('envneedle', 'files', { forAgent: true })).hits).toHaveLength(0)
      // Waits for the queued drop to finish (no pending remain, so build just runs the queue).
      await reopened.build()
      expect(rowOf('stage.env')).toMatchObject({ id, index_state: 'skipped' })
      expect(chunks()).toBe(0)
      // Not left in FTS either: even searched for the same word, the candidates are 0 (if not dropped, every search would use up the count limit).
      expect(ftsHits()).toBe(0)
    } finally {
      await reopened.stop()
    }
  })
})
