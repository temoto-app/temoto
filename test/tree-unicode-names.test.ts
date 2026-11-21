/**
 * TODO 1231: a directory whose name is in Japanese or similar must not drop out of the tree (the list).
 *
 * The reproduction case is a single kanji followed by a slash (it cannot be explained by a normalization mismatch, since NFC and NFD have the same form). It follows the same order as the renderer: listing (`FsIndexer.listDirectory`, both the path that answers from index rows and the path that reads in place) -> URI -> list again with that URI. The real SQLite (in memory) and the real disk. No model is called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { pathToUri, uriToPath } from '../src/common/uri.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

// The name where the hiragana 'ga' is written in NFD (hiragana ka + U+3099).
const NFD_DIR = 'がぞく'
// APFS treats NFC and NFD as the same name (they become the same directory), so only one of them is placed.
const NAMES = ['株', NFD_DIR, '😀絵文字', '한글', 'café', '日本語の 名前 (1)', '100%の#?']

let root: string
let db: Db
let store: IndexStore
let fs: FsIndexer

beforeAll(async () => {
  root = makeTestDir('tree-unicode')
  for (const name of NAMES) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'a.md'), 'a\n')
    writeFileSync(join(root, name, 'b.md'), 'b\n')
    writeFileSync(join(root, name, 'c.md'), 'c\n')
  }
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
  fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, root, [root])
  await fs.scan()
  // Created after the scan = there is no row in the index (the path that reads in place).
  for (const name of NAMES) {
    mkdirSync(join(root, name, '後から'), { recursive: true })
    writeFileSync(join(root, name, '後から', 'late.md'), 'l\n')
    writeFileSync(join(root, name, 'd.md'), 'd\n')
  }
})

afterAll(async () => {
  await fs.stop()
  db.close()
  removeTestDir(root)
})

describe('directories with Japanese, NFD, emoji, and Hangul names (TODO 1231)', () => {
  it("all appear in the parent's listing, and listing again by that URI shows what is under it (the path of index rows)", async () => {
    const top = await fs.listDirectory(pathToUri(root))
    const byName = new Map(top.entries.map((entry) => [entry.name, entry]))
    for (const name of NAMES) {
      const dir = byName.get(name)
      expect(dir, `親の一覧に ${name} が出る`).toBeDefined()
      expect(dir?.isDirectory).toBe(true)
      // Converting the URI back to a path matches the original name on disk (NFD is not normalized either).
      expect(uriToPath(dir!.uri)).toBe(join(root, name))
      const listing = await fs.listDirectory(dir!.uri)
      expect(listing.reason).toBeNull()
      expect(listing.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['a.md', 'b.md', 'c.md']))
      // A child's parentUri matches the opened URI as a string (the renderer builds the tree keyed by URI).
      for (const child of listing.entries) expect(child.parentUri).toBe(dir!.uri)
    }
  })

  it('a directory with no index row (made after the scan) is also read on the spot and shown', async () => {
    for (const name of NAMES) {
      const live = await fs.listDirectory(pathToUri(join(root, name, '後から')))
      expect(live.entries.map((e) => e.name)).toEqual(['late.md'])
    }
  })

  it('even when a name made as NFD is requested with the NFC spelling (APFS treats it as the same name), what is under it is shown', async () => {
    const nfc = await fs.listDirectory(pathToUri(join(root, NFD_DIR.normalize('NFC'))))
    expect(nfc.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['a.md', 'b.md', 'c.md']))
  })

  it('filename search also matches the .md under `株`', async () => {
    const result = await fs.searchFiles('a.md', 50)
    const hit = result.entries.some((h) => h.uri === pathToUri(join(root, '株', 'a.md')))
    expect(hit).toBe(true)
  })
})
