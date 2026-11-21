/**
 * Regression for folders that were removed appearing in the tree (TODO 262).
 *
 * The index keeps rows for deletions the watch missed until the next cleanup. The tree returned those rows as they were, so `~/.aios-*` folders that no longer existed were listed directly under home. What is checked here:
 *
 * 1. The listing (`listDirectory`) also checks index rows against the disk, drops rows that do not exist, and asks the index to delete them. Once the request takes effect, the file-name search drops them as well. Rows are not deleted for directories that cannot be read.
 * 2. If, during a scan, a watch delete is applied first, the batch writes back the removed folder (`seen_at` = this run, so the deep scan's cleanup also keeps it). It is dropped at the end of the scan.
 * 3. Even when an error (a missed FSEvents event) comes along with the watch callback, the events of the same run are not discarded.
 *
 * The real SQLite (in memory) and the real disk (`~/.aios-test/<run>/`). No model is called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { createMacosExclusions } from '../src/common/exclusions.js'
import { pathToUri } from '../src/common/uri.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import type { ScannedEntry } from '../src/index-kernel/scanner.js'
import { watchTree, type RawChange } from '../src/index-kernel/watcher.js'
import type { FileChangeBatch } from '../src/shared/types.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

/** A hook that cuts in just before a scan batch is written (to cause the race between the scan and the watch deterministically). */
const hooks = vi.hoisted(() => ({
  beforeBatch: null as null | ((batch: readonly { name: string }[]) => Promise<void>)
}))

vi.mock('../src/index-kernel/scanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/index-kernel/scanner.js')>()
  async function* walk(
    ...args: Parameters<typeof actual.walk>
  ): AsyncGenerator<readonly ScannedEntry[], void, undefined> {
    for await (const batch of actual.walk(...args)) {
      if (hooks.beforeBatch !== null) await hooks.beforeBatch(batch)
      yield batch
    }
  }
  return { ...actual, walk }
})

/** Intercepts the `@parcel/watcher` subscription so the test can call the native callback. */
const parcel = vi.hoisted(() => ({
  callbacks: [] as ((err: Error | null, events: { type: string; path: string }[]) => void)[]
}))

vi.mock('@parcel/watcher', () => ({
  default: {
    subscribe: async (
      _dir: string,
      callback: (err: Error | null, events: { type: string; path: string }[]) => void
    ) => {
      parcel.callbacks.push(callback)
      return { unsubscribe: async () => {} }
    }
  }
}))

let root: string
let db: Db
let fs: FsIndexer
let batches: FileChangeBatch[]

beforeEach(async () => {
  root = makeTestDir('stale-tree')
  mkdirSync(join(root, 'keep'))
  writeFileSync(join(root, 'keep', 'a.txt'), 'a\n')
  mkdirSync(join(root, '.aios-gone-test-1', 'sub'), { recursive: true })
  writeFileSync(join(root, '.aios-gone-test-1', 'sub', 'needle-gone.txt'), 'x\n')
  mkdirSync(join(root, '.aios-gone-test-2'))
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
  hooks.beforeBatch = null
  await fs.stop()
  if (db.open) db.close()
  removeTestDir(root)
})

const names = async (dir: string = root): Promise<string[]> =>
  (await fs.listDirectory(pathToUri(dir))).entries.map((entry) => entry.name)

const fsRow = (name: string): number =>
  (
    db
      .prepare(`SELECT COUNT(*) AS n FROM documents WHERE source = 'fs' AND name = ?`)
      .get(name) as { n: number }
  ).n

/** Waits until the deletion requests the listing queued are applied (`enqueueChanges([])` returns the end of the queue). */
const drain = (): Promise<void> => fs.enqueueChanges([])

describe('一覧は索引の行をディスクと突き合わせる (TODO 262)', () => {
  it('監視を通らずに消えたフォルダは一覧に出ず、索引からも消える (ファイル名検索にも出ない)', async () => {
    expect(await names()).toEqual(['.aios-gone-test-1', '.aios-gone-test-2', 'keep'])
    expect((await fs.searchFiles('needle-gone')).entries).toHaveLength(1)

    // Deletions while the app was down / missed FSEvents = no delete arrives from the watch.
    rmSync(join(root, '.aios-gone-test-1'), { recursive: true })
    rmSync(join(root, '.aios-gone-test-2'), { recursive: true })

    const listing = await fs.listDirectory(pathToUri(root))
    expect(listing.live).toBe(false)
    expect(listing.entries.map((entry) => entry.name)).toEqual(['keep'])

    await drain()
    expect(fsRow('.aios-gone-test-1')).toBe(0)
    expect(fsRow('sub')).toBe(0)
    expect(fsRow('needle-gone.txt')).toBe(0)
    expect((await fs.searchFiles('needle-gone')).entries).toHaveLength(0)
    // The delete diff also reaches the renderer's tree.
    const deleted = batches.flatMap((batch) => batch.changes).filter((c) => c.type === 'delete')
    expect(deleted.map((c) => c.uri).sort()).toEqual(
      [pathToUri(join(root, '.aios-gone-test-1')), pathToUri(join(root, '.aios-gone-test-2'))].sort()
    )
  })

  it('行が全部消えたらその場で読む経路に落ち、索引に無い新しいものも出る', async () => {
    const dir = join(root, '.aios-gone-test-1', 'sub')
    rmSync(join(dir, 'needle-gone.txt'))
    writeFileSync(join(dir, 'fresh.txt'), 'y\n')
    const listing = await fs.listDirectory(pathToUri(dir))
    expect(listing.live).toBe(true)
    expect(listing.entries.map((entry) => entry.name)).toEqual(['fresh.txt'])
    await drain()
    expect(fsRow('needle-gone.txt')).toBe(0)
  })

  it('一覧を頼まれたディレクトリそのものが無ければ空を返し、その行を消す', async () => {
    const dir = join(root, '.aios-gone-test-1')
    rmSync(dir, { recursive: true })
    expect((await fs.listDirectory(pathToUri(dir))).entries).toEqual([])
    await drain()
    expect(fsRow('.aios-gone-test-1')).toBe(0)
  })

  it('読めないディレクトリでは行を消さない (権限が外れただけで中身を消さない)', async () => {
    const dir = join(root, 'keep')
    chmodSync(dir, 0o000)
    try {
      expect(await names(dir)).toEqual(['a.txt'])
      await drain()
      expect(fsRow('a.txt')).toBe(1)
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})

describe('走査と監視の行き違い (TODO 262)', () => {
  it('走査の最中に監視が消したフォルダを、バッチが書き戻しても走査の終わりに落とす', async () => {
    const gone = join(root, '.aios-gone-test-2')
    let fired = false
    hooks.beforeBatch = async (batch) => {
      if (fired || !batch.some((entry) => entry.name === '.aios-gone-test-2')) return
      fired = true
      // The scan has finished reading the top level. Here it disappears, and the watch's delete is applied first.
      rmSync(gone, { recursive: true })
      await fs.enqueueChanges([{ type: 'delete', path: gone }])
      expect(fsRow('.aios-gone-test-2')).toBe(0)
    }
    await fs.scan() // Deep scan (removeStale keeps rows whose seen_at = this run).
    expect(fired).toBe(true)
    expect(fsRow('.aios-gone-test-2')).toBe(0)
    expect(fsRow('keep')).toBe(1)
  })

  it('走査の最中に消えて作り直されたものは残す', async () => {
    const path = join(root, '.aios-gone-test-2')
    let fired = false
    hooks.beforeBatch = async (batch) => {
      if (fired || !batch.some((entry) => entry.name === '.aios-gone-test-2')) return
      fired = true
      rmSync(path, { recursive: true })
      await fs.enqueueChanges([{ type: 'delete', path }])
      mkdirSync(path)
    }
    await fs.scan()
    expect(fired).toBe(true)
    expect(fsRow('.aios-gone-test-2')).toBe(1)
  })
})

describe('監視のコールバック (TODO 262)', () => {
  it('error (FSEvents の取りこぼし) が付いて来ても、同じ回の events は捨てない', async () => {
    parcel.callbacks.length = 0
    const received: RawChange[] = []
    const handle = await watchTree(root, createMacosExclusions(root), (changes) => {
      received.push(...changes)
    })
    try {
      // Two roots: home (here, a temp folder) and an include (iCloud Drive) under an exclusion.
      expect(parcel.callbacks.length).toBeGreaterThanOrEqual(1)
      parcel.callbacks[0]?.(new Error('Events were dropped by the FSEvents client.'), [
        { type: 'delete', path: join(root, '.aios-gone-test-1') }
      ])
      await new Promise((done) => setTimeout(done, 50))
      expect(received).toEqual([{ type: 'delete', path: join(root, '.aios-gone-test-1') }])
    } finally {
      await handle.stop()
    }
  })
})
