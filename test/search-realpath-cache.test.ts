/**
 * Wave 42 code-review bundle X: the realpath at the read choke point (`IndexService.fsVerdict`) is applied only to the parent directory, and reused during one build batch or one search. A regression guard for calling realpath for every document (a syscall on the hot path).
 * Safety (if the target of a symlink at an intermediate stage is excluded, it is not read) is checked by `test/search-fs-debris.test.ts`.
 *
 * Real SQLite (in memory) and real disk (`~/.aios-test/<run>/`). Does not call the model.
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

const calls = vi.hoisted(() => ({ realpath: [] as string[] }))

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const realpath = (async (path: string, ...rest: unknown[]) => {
    calls.realpath.push(String(path))
    return (original.realpath as (p: string, ...r: unknown[]) => Promise<string>)(path, ...rest)
  }) as typeof original.realpath
  return { ...original, realpath, default: { ...original, realpath } }
})

const FILES = 30

let root: string
let db: Db
let fs: FsIndexer
let index: IndexService

beforeAll(async () => {
  root = makeTestDir('search-realpath-cache')
  mkdirSync(join(root, 'many'))
  for (let i = 0; i < FILES; i += 1) writeFileSync(join(root, 'many', `f${i}.md`), `cacheneedle number ${i}\n`)
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  const store = new IndexStore(db)
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
})

afterAll(async () => {
  await index.stop()
  await fs.stop()
  if (db.open) db.close()
  removeTestDir(root)
})

const underMany = (): string[] => calls.realpath.filter((p) => p.includes('many'))

describe('reuse of realpath in fsVerdict', () => {
  it('build: documents in the same folder once per bundle', async () => {
    calls.realpath.length = 0
    await index.build()
    expect(underMany().length).toBeGreaterThan(0)
    expect(underMany().length).toBeLessThan(FILES / 3)
    expect(underMany().every((p) => p.endsWith('many'))).toBe(true)
  })

  it('search: hits in the same folder once per search', async () => {
    calls.realpath.length = 0
    const result = await index.search('cacheneedle', 'files', { limit: FILES })
    expect(result.hits).toHaveLength(FILES)
    expect(underMany()).toHaveLength(1)
    // It is not reused by the next search (only during one search).
    await index.search('cacheneedle', 'files', { limit: FILES })
    expect(underMany()).toHaveLength(2)
  })
})
