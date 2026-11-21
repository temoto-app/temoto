/**
 * TODO 813 code-review: filter-only searches (`ext:md` / `*.pdf` / `name:22719`) look up documents by the filter alone, even with no word in the body.
 * The lower limit is judged by the value of `name:`. Real SQLite (in memory) and disk. Does not call the model.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

/** Counts how many times the search called body extraction (PDF / Office) (TODO 1127). */
const extractCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/index-kernel/extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/index-kernel/extract.js')>()
  return {
    ...actual,
    extractFile: (...args: Parameters<typeof actual.extractFile>) => {
      extractCalls.n += 1
      return actual.extractFile(...args)
    }
  }
})

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

let root: string
let db: Db
let store: IndexStore
let fs: FsIndexer
let index: IndexService

beforeAll(async () => {
  root = makeTestDir('search-filter-only')
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs', 'note-22719.md'), 'alpha beta\n')
  writeFileSync(join(root, 'docs', 'other.md'), 'gamma delta\n')
  writeFileSync(join(root, 'docs', 'plain.txt'), 'epsilon 22719\n')
  writeFileSync(join(root, 'docs', 'カタログ.txt'), 'zeta\n')
  writeFileSync(join(root, 'docs', 'report.docx'), 'not a zip')
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

const titles = async (query: string): Promise<string[]> =>
  (await index.search(query, 'files')).hits.map((h) => h.title).sort()

describe('filter-only search', () => {
  it('ext:md can be looked up by extension alone', async () => {
    expect(await titles('ext:md')).toEqual(['note-22719.md', 'other.md'])
    expect(await titles('*.txt')).toEqual(['plain.txt', 'カタログ.txt'])
  })

  it('name:22719 can be looked up by file name alone (plain.txt, which has 22719 in its body, does not appear)', async () => {
    expect(await titles('name:22719')).toEqual(['note-22719.md'])
  })

  it('returns tooShort when the name: value is too short, and there is no lower limit for ext: alone', async () => {
    expect((await index.search('name:a', 'files')).tooShort).toBe(true)
    expect((await index.search('ext:md', 'files')).tooShort).toBeUndefined()
  })

  it('the name: value is folded the same way as name_folded (matches Japanese names)', async () => {
    expect(await titles('name:カタログ')).toEqual(['カタログ.txt'])
  })

  it('combined with a body term it queries FTS as before', async () => {
    expect(await titles('alpha ext:md')).toEqual(['note-22719.md'])
  })

  it('conversation search turns the filter back into a term (no files appear)', async () => {
    expect((await index.search('ext:md', 'conversation')).hits).toEqual([])
  })

  it('filter-only search on PDF / Office does not re-extract the body (TODO 1127)', async () => {
    extractCalls.n = 0
    expect(await titles('ext:docx')).toEqual(['report.docx'])
    expect(extractCalls.n).toBe(0)
  })
})
