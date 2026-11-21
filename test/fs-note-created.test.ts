/**
 * TODO 370 (wave 20 bundle C): puts what was created from the Files tree into the index without waiting for the watcher (fsevents)
 * (`FsIndexer.noteCreated`, the RPC `fs.noteCreated` of the index process).
 *
 * - For a folder whose rows are in the index, the list returns the index rows (`live: false`), so files created before watching do not appear in the list. After `noteCreated` they appear, and the diff to the renderer (`create` in `onFileChanges`) also arrives.
 * - Even if the same `create` from the watcher arrives later, there is still one row (no duplicates).
 * - URIs refused by the choke point (under an exclusion) are not put in.
 *
 * Real SQLite (in memory) and the real disk (`~/.aios-test/<run>/`). The watcher is a fake. The model is not called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { pathToUri } from '../src/common/uri.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import type { FileChangeBatch } from '../src/shared/types.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: {
    subscribe: async () => ({ unsubscribe: async () => {} })
  }
}))

let root: string
let db: Db
let fs: FsIndexer
let batches: FileChangeBatch[]

beforeEach(async () => {
  root = makeTestDir('note-created')
  mkdirSync(join(root, 'keep'))
  writeFileSync(join(root, 'keep', 'a.txt'), 'a\n')
  mkdirSync(join(root, 'node_modules'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  batches = []
  fs = new FsIndexer(
    db,
    { onScanStatus: () => {}, onFileChanges: (batch) => batches.push(batch) },
    new IndexStore(db),
    root,
    [root]
  )
  await fs.scan()
})

afterEach(async () => {
  await fs.stop()
  if (db.open) db.close()
  removeTestDir(root)
})

const names = async (dir: string): Promise<string[]> =>
  (await fs.listDirectory(pathToUri(dir))).entries.map((entry) => entry.name)

const rows = (name: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE source = 'fs' AND name = ?`).get(name) as { n: number }).n

describe('FsIndexer.noteCreated (TODO 370)', () => {
  it('監視を待たずに索引へ入り、一覧に出て、renderer への create の差分が届く', async () => {
    const listing = await fs.listDirectory(pathToUri(join(root, 'keep')))
    expect(listing.live).toBe(false)
    // Before watching (so there is no row in the index): not in the list that returns index rows.
    writeFileSync(join(root, 'keep', 'b.txt'), '')
    mkdirSync(join(root, 'keep', 'newdir'))
    expect(await names(join(root, 'keep'))).toEqual(['a.txt'])

    batches.length = 0
    await fs.noteCreated([pathToUri(join(root, 'keep', 'newdir')), pathToUri(join(root, 'keep', 'b.txt'))])
    expect(await names(join(root, 'keep'))).toEqual(['newdir', 'a.txt', 'b.txt'])
    const created = batches.flatMap((batch) => batch.changes)
    expect(created.map((change) => [change.type, change.uri])).toEqual([
      ['create', pathToUri(join(root, 'keep', 'newdir'))],
      ['create', pathToUri(join(root, 'keep', 'b.txt'))]
    ])
    expect(created[0]?.parentUri).toBe(pathToUri(join(root, 'keep')))
    expect(created[0]?.entry?.isDirectory).toBe(true)
  })

  it('後から監視の同じ create が来ても行は 1 つ', async () => {
    writeFileSync(join(root, 'keep', 'twice.txt'), '')
    await fs.noteCreated([pathToUri(join(root, 'keep', 'twice.txt'))])
    await fs.enqueueChanges([{ type: 'create', path: join(root, 'keep', 'twice.txt') }])
    expect(rows('twice.txt')).toBe(1)
    expect((await names(join(root, 'keep'))).filter((name) => name === 'twice.txt')).toHaveLength(1)
  })

  it('関門に断られる URI (除外の下・file: 以外) は入れない', async () => {
    writeFileSync(join(root, 'node_modules', 'x.js'), '')
    batches.length = 0
    await fs.noteCreated([pathToUri(join(root, 'node_modules', 'x.js')), 'https://example.com/x'])
    expect(rows('x.js')).toBe(0)
    expect(batches).toEqual([])
  })
})
