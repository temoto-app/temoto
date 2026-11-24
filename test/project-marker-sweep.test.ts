/**
 * TODO 1324 (review fix Z): a project marker that appears or vanishes AFTER the folders were indexed.
 *
 * `build` / `dist` / `target` / `venv` are excluded only beside a marker, so the verdict depends on the disk. Rows already in the index must follow:
 * the incremental scan's cleanup, the watch diff of the marker itself and the index side of `listDirectory` all use the same answer.
 * The real SQLite (in memory) and a real temporary tree. No model is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { pathToUri } from '../src/common/uri.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

let root: string
let db: Db
let fs: FsIndexer

const p = (...parts: string[]): string => join(root, ...parts)
const rows = (name: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE source = 'fs' AND name = ?`).get(name) as { n: number }).n
/** A change inside the same millisecond would not move the directory's mtime from the stored one; push it forward. */
const bump = (dir: string, seconds: number): void => {
  const at = new Date(Date.now() + seconds * 1000)
  utimesSync(dir, at, at)
}
const listed = async (dir: string): Promise<{ names: string[]; live: boolean }> => {
  const listing = await fs.listDirectory(pathToUri(dir))
  return { names: listing.entries.map((entry) => entry.name).sort(), live: listing.live }
}

beforeEach(async () => {
  root = makeTestDir('marker-sweep')
  // `site` has no marker yet: its dist / build are ordinary folders and get indexed.
  mkdirSync(p('site', 'dist', 'assets'), { recursive: true })
  mkdirSync(p('site', 'build'))
  mkdirSync(p('site', 'src'))
  writeFileSync(p('site', 'dist', 'assets', 'bundle.js'), 'x\n')
  writeFileSync(p('site', 'build', 'out.txt'), 'x\n')
  writeFileSync(p('site', 'src', 'a.ts'), 'x\n')
  // `plain` never gets a marker.
  mkdirSync(p('plain', 'build'), { recursive: true })
  writeFileSync(p('plain', 'build', 'keep.md'), 'x\n')
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, new IndexStore(db), root, [root])
  await fs.scan()
})

afterEach(async () => {
  await fs.stop()
  if (db.open) db.close()
  removeTestDir(root)
})

describe('a marker appears after the folders were indexed', () => {
  it('the baseline indexes them', () => {
    expect(rows('dist')).toBe(1)
    expect(rows('bundle.js')).toBe(1)
    expect(rows('build')).toBe(2)
  })

  it('the incremental scan drops the generated folders and their contents; the index listing and the live listing agree', async () => {
    writeFileSync(p('site', 'package.json'), '{}')
    bump(p('site'), 5)
    await fs.scan({ deep: false })
    expect(rows('dist')).toBe(0)
    expect(rows('bundle.js')).toBe(0)
    expect(rows('out.txt')).toBe(0)
    // Only the unmarked `plain/build` is left.
    expect(rows('build')).toBe(1)
    expect(rows('keep.md')).toBe(1)
    const listing = await listed(p('site'))
    expect(listing.names).toEqual(['package.json', 'src'])
    expect((await fs.searchFiles('bundle')).entries).toHaveLength(0)
  })

  it('the watch diff of the marker alone removes them, without waiting for a scan', async () => {
    writeFileSync(p('site', 'package.json'), '{}')
    await fs.enqueueChanges([{ type: 'create', path: p('site', 'package.json') }])
    expect(rows('dist')).toBe(0)
    expect(rows('bundle.js')).toBe(0)
    expect(rows('out.txt')).toBe(0)
    expect(rows('keep.md')).toBe(1)
  })

  it('listDirectory (index side) hides and removes the stale rows even before any scan or watch', async () => {
    writeFileSync(p('site', 'package.json'), '{}')
    // The index still has rows for dist / build / src, so this takes the index path and checks the names against the disk.
    const first = await listed(p('site'))
    expect(first.names).toEqual(['src'])
    expect(first.live).toBe(false)
    await fs.enqueueChanges([])
    expect(rows('dist')).toBe(0)
    expect(rows('bundle.js')).toBe(0)
    expect(rows('out.txt')).toBe(0)
  })

  it('a folder with no marker is untouched', async () => {
    await fs.scan({ deep: false })
    expect(rows('keep.md')).toBe(1)
    expect((await listed(p('plain'))).names).toEqual(['build'])
  })
})

describe('a marker vanishes', () => {
  beforeEach(async () => {
    writeFileSync(p('site', 'package.json'), '{}')
    await fs.enqueueChanges([{ type: 'create', path: p('site', 'package.json') }])
    expect(rows('dist')).toBe(0)
  })

  it('the incremental scan brings the folders back', async () => {
    rmSync(p('site', 'package.json'))
    bump(p('site'), 10)
    await fs.scan({ deep: false })
    expect(rows('dist')).toBe(1)
    expect(rows('bundle.js')).toBe(1)
    expect(rows('out.txt')).toBe(1)
  })

  it('the watch diff of the marker rescans the parent', async () => {
    rmSync(p('site', 'package.json'))
    bump(p('site'), 10)
    await fs.enqueueChanges([{ type: 'delete', path: p('site', 'package.json') }])
    // The rescan is queued by the diff; asking for the same path joins it.
    await fs.scanSubtree(p('site'))
    expect(rows('dist')).toBe(1)
    expect(rows('bundle.js')).toBe(1)
    expect(rows('out.txt')).toBe(1)
  })
})

describe('the name-only folders are unchanged', () => {
  it('node_modules beside a marker or not is never indexed', async () => {
    mkdirSync(p('site', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(p('site', 'node_modules', 'pkg', 'index.js'), 'x\n')
    writeFileSync(p('site', 'package.json'), '{}')
    bump(p('site'), 5)
    await fs.scan({ deep: false })
    expect(rows('node_modules')).toBe(0)
    rmSync(p('site', 'package.json'))
    bump(p('site'), 10)
    await fs.scan({ deep: false })
    expect(rows('node_modules')).toBe(0)
  })
})
