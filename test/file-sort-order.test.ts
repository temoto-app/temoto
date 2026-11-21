/**
 * Order of the file tree (TODO 872, wave 43 bundle C).
 *
 * - `sortOrder: 'modified'` in the list from the index process (`FsIndexer.listDirectory`): directories first (by name), files by mtime newest first, and ties by name. Both for index rows and for the path that reads on the spot.
 * - Without a specification the name order is kept as before.
 * - The setting (`FileSortPreference`) does not save invalid values. `asListDirectoryOptions` drops an invalid `sortOrder`.
 *
 * Real SQLite (in memory) and the real disk. The model is not called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { UI_FILE_SORT_ORDER } from '../src/common/settings-keys.js'
import { pathToUri } from '../src/common/uri.js'
import { FsIndexer, MAX_ROWS, listComparator, sortForList } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { FileSortPreference } from '../src/main/file-sort.js'
import { asListDirectoryOptions } from '../src/shared/types.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

let root: string
let db: Db
let fs: FsIndexer

function touch(path: string, seconds: number): void {
  writeFileSync(path, 'x\n')
  utimesSync(path, seconds, seconds)
}

beforeAll(async () => {
  root = makeTestDir('file-sort-order')
  mkdirSync(join(root, 'zdir'))
  mkdirSync(join(root, 'adir'))
  touch(join(root, 'old.txt'), 1_700_000_000)
  touch(join(root, 'new.txt'), 1_700_001_000)
  touch(join(root, 'mid-b.txt'), 1_700_000_500)
  touch(join(root, 'mid-a.txt'), 1_700_000_500)
  touch(join(root, '.hidden-new'), 1_700_002_000)
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, new IndexStore(db), root, [root])
  await fs.scan()
  // Created after the scan, so this is the path that reads on the spot.
  mkdirSync(join(root, 'late'))
  touch(join(root, 'late', 'a.txt'), 1_700_000_000)
  touch(join(root, 'late', 'b.txt'), 1_700_001_000)
  mkdirSync(join(root, 'late', 'dir'))
})

afterAll(async () => {
  await fs.stop()
  db.close()
  removeTestDir(root)
})

const names = async (dir: string, options?: Parameters<FsIndexer['listDirectory']>[1]) =>
  (await fs.listDirectory(pathToUri(dir), options)).entries.map((entry) => entry.name)

describe('list order (TODO 872)', () => {
  it('modified: directories first (by name), files newest first, by name at the same time', async () => {
    expect(await names(root, { sortOrder: 'modified' })).toEqual([
      'adir',
      'zdir',
      '.hidden-new',
      'new.txt',
      'mid-a.txt',
      'mid-b.txt',
      'old.txt'
    ])
  })

  it('the newest-first order is kept even when combined with the setting that hides modified and hidden files', async () => {
    expect(await names(root, { sortOrder: 'modified', showHidden: false })).toEqual([
      'adir',
      'zdir',
      'new.txt',
      'mid-a.txt',
      'mid-b.txt',
      'old.txt'
    ])
  })

  it('unspecified and name sort by name (directories first)', async () => {
    const expected = ['adir', 'zdir', '.hidden-new', 'mid-a.txt', 'mid-b.txt', 'new.txt', 'old.txt']
    expect(await names(root)).toEqual(expected)
    expect(await names(root, { sortOrder: 'name' })).toEqual(expected)
  })

  it('the same rules apply on the path that reads in place (not in the index)', async () => {
    const dir = join(root, 'late')
    const listing = await fs.listDirectory(pathToUri(dir), { sortOrder: 'modified' })
    expect(listing.live).toBe(true)
    expect(listing.entries.map((entry) => entry.name)).toEqual(['dir', 'b.txt', 'a.txt'])
    expect(await names(dir, { sortOrder: 'name' })).toEqual(['dir', 'a.txt', 'b.txt'])
  })
})

describe('a folder exceeding MAX_ROWS (TODO 872 code-review)', () => {
  it('the read-in-place path sorts and then cuts (newer files are not dropped by readdir order)', async () => {
    const dir = join(root, 'big')
    mkdirSync(dir)
    const total = MAX_ROWS + 20
    for (let i = 0; i < total; i += 1) {
      touch(join(dir, `f${String(i).padStart(5, '0')}.txt`), 1_600_000_000 + i)
    }
    // Last in name order; the oldest and the newest by update, one each.
    touch(join(dir, 'zzz-newest.txt'), 1_800_000_000)
    touch(join(dir, 'aaa-oldest.txt'), 1_000_000_000)
    const listing = await fs.listDirectory(pathToUri(dir), { sortOrder: 'modified' })
    expect(listing.live).toBe(true)
    const got = listing.entries.map((entry) => entry.name)
    expect(got).toHaveLength(MAX_ROWS)
    expect(got[0]).toBe('zzz-newest.txt')
    expect(got).not.toContain('aaa-oldest.txt')
    expect(got).toContain(`f${String(total - 1).padStart(5, '0')}.txt`)
    // By name, the front of the name is kept.
    const byName = (await fs.listDirectory(pathToUri(dir), { sortOrder: 'name' })).entries.map((e) => e.name)
    expect(byName[0]).toBe('aaa-oldest.txt')
    expect(byName).not.toContain('zzz-newest.txt')
  })
})

describe('sortForList (TODO 875: sorting with folding done once per item)', () => {
  it('the same order as listComparator (case, NFD, same time, directories)', () => {
    const items = [
      { name: 'B.txt', isDirectory: false, mtimeMs: 5 },
      { name: 'a.txt', isDirectory: false, mtimeMs: 5 },
      { name: 'Ｚ.txt', isDirectory: false, mtimeMs: 9 },
      { name: 'ga゙.txt', isDirectory: false, mtimeMs: 1 },
      { name: 'が.txt', isDirectory: false, mtimeMs: 2 },
      { name: 'Zdir', isDirectory: true, mtimeMs: 100 },
      { name: 'adir', isDirectory: true, mtimeMs: 0 },
      { name: 'c.txt', isDirectory: false, mtimeMs: 7 }
    ]
    for (const order of ['name', 'modified'] as const) {
      expect(sortForList(items, order)).toEqual([...items].sort(listComparator(order)))
    }
    expect(sortForList(items, 'modified').map((i) => i.name).slice(0, 3)).toEqual(['adir', 'Zdir', 'Ｚ.txt'])
    // The original array is not sorted.
    expect(items[0]?.name).toBe('B.txt')
  })

  it('name order keeps shapes without mtime as they are (wave 44 code-review: makes no copy)', () => {
    const items = [
      { name: 'b', isDirectory: false, full: '/x/b' },
      { name: 'A', isDirectory: false, full: '/x/A' },
      { name: 'dir', isDirectory: true, full: '/x/dir' }
    ]
    const sorted = sortForList(items, 'name')
    expect(sorted.map((i) => i.name)).toEqual(['dir', 'A', 'b'])
    // The same object (not a copy).
    expect(sorted[1]).toBe(items[1])
  })
})

describe('directly under ~/Downloads exceeds MAX_ROWS (wave 44 code-review: aligns the Downloads special case and the cutting)', () => {
  it('even with the name-order setting, shows newest first without dropping new files (read-in-place path)', async () => {
    const home = makeTestDir('file-sort-downloads')
    const downloadsDb = new Database(':memory:')
    downloadsDb.pragma('foreign_keys = ON')
    runMigrations(downloadsDb)
    const indexer = new FsIndexer(
      downloadsDb,
      { onScanStatus: () => {}, onFileChanges: () => {} },
      new IndexStore(downloadsDb),
      home,
      [home]
    )
    try {
      const dir = join(home, 'Downloads')
      mkdirSync(dir)
      for (let i = 0; i < MAX_ROWS + 20; i += 1) {
        touch(join(dir, `f${String(i).padStart(5, '0')}.txt`), 1_600_000_000 + i)
      }
      // Last in name order (it would be dropped if cut by name first), and newest by update.
      touch(join(dir, 'zzz-newest.txt'), 1_800_000_000)
      mkdirSync(join(dir, 'a-folder'))
      const listing = await indexer.listDirectory(pathToUri(dir), { sortOrder: 'name' })
      expect(listing.live).toBe(true)
      const got = listing.entries.map((entry) => entry.name)
      expect(got).toHaveLength(MAX_ROWS)
      expect(got[0]).toBe('zzz-newest.txt')
      expect(got[1]).toBe(`f${String(MAX_ROWS + 19).padStart(5, '0')}.txt`)
      // Folders come after files (TODO 627).
      expect(got.at(-1)).toBe('a-folder')
    } finally {
      await indexer.stop()
      downloadsDb.close()
      removeTestDir(home)
    }
  })
})

describe('sort setting (TODO 872)', () => {
  it('the default is modified, an invalid value is not saved and returns the current value, and notifies when it changes', () => {
    const settings = new AppSettingsStore(db)
    const seen: string[] = []
    const pref = new FileSortPreference(settings, (order) => seen.push(order))
    expect(pref.get()).toBe('modified')
    expect(pref.set('size')).toBe('modified')
    expect(pref.set(3)).toBe('modified')
    expect(pref.set('name')).toBe('name')
    expect(pref.set('name')).toBe('name')
    expect(seen).toEqual(['name'])
    expect(settings.readTyped(UI_FILE_SORT_ORDER)).toBe('name')
    expect(new FileSortPreference(settings).get()).toBe('name')
  })

  it('validation of the RPC value: drops an invalid sortOrder', () => {
    expect(asListDirectoryOptions({ sortOrder: 'modified' })).toEqual({ sortOrder: 'modified' })
    expect(asListDirectoryOptions({ sortOrder: 'bogus' })).toEqual({})
    expect(asListDirectoryOptions({ sortOrder: 1 })).toEqual({})
  })
})
