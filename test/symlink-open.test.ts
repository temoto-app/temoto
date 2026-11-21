/**
 * TODO 558: makes a symlinked file openable (reading and writing both, if the link target is within the allowed range).
 *
 * - Where it used to fail to open: (1) Tree: the scan does not put file symlinks into the index (`walk`), so they did not appear in the indexed list. In the list that reads directly, they appeared as files, but their size came from lstat (the link itself). (2) Viewer: the range of the 'opened URI' in `ViewerBroker` / the Broker is a single logical path (`roots: [path]`), so a symlink whose real target is a different path was unreadable with `symlink-escape` (TODO 558 in `test/capability-resource.test.ts`).
 * - Here it checks the tree listing (`FsIndexer.listDirectory`) and main's choke point (`FsAccess.assertAllowed`).
 *
 * The real SQLite (in memory) and the real disk (`~/.aios-test/<run>/`). Neither a model nor Electron is called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { pathToUri } from '../src/common/uri.js'
import { PathDenied } from '../src/common/fs-policy.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { FsAccess } from '../src/main/fs/access.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

let home: string

beforeAll(() => {
  home = makeTestDir('symlink-open')
  mkdirSync(join(home, 'sw2'))
  mkdirSync(join(home, 'proj'))
  mkdirSync(join(home, '.ssh'))
  mkdirSync(join(home, 'live'))
  writeFileSync(join(home, 'sw2', 'todo.md'), '# todo\n')
  writeFileSync(join(home, 'proj', 'a.ts'), 'export {}\n')
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret\n')
  // A link directly under home (the owner's example `~/todo.md -> ~/sw2/todo.md`).
  symlinkSync(join(home, 'sw2', 'todo.md'), join(home, 'proj', 'todo.md'))
  // A link to credentials, a dangling link, and a link to a folder.
  symlinkSync(join(home, '.ssh', 'id_ed25519'), join(home, 'proj', 'key'))
  symlinkSync(join(home, 'sw2', 'gone.md'), join(home, 'proj', 'dangling.md'))
  symlinkSync(join(home, 'sw2'), join(home, 'proj', 'sw2-link'))
  // A link inside a folder that is not in the index (the path that reads in place). Created after the scan.
})

afterAll(() => {
  removeTestDir(home)
})

describe('Files ツリーの一覧の symlink (TODO 558)', () => {
  let db: Db
  let indexer: FsIndexer

  beforeAll(async () => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    indexer = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, new IndexStore(db), home, [home])
    await indexer.scan()
    writeFileSync(join(home, 'live', 'plain.txt'), 'p\n')
    symlinkSync(join(home, 'sw2', 'todo.md'), join(home, 'live', 'todo.md'))
    symlinkSync(join(home, '.ssh', 'id_ed25519'), join(home, 'live', 'key'))
    symlinkSync(join(home, 'sw2'), join(home, 'live', 'dir-link'))
  })

  afterAll(async () => {
    await indexer.stop()
    db.close()
  })

  it('索引のある一覧: ファイルの symlink を足し (実体の大きさ)、フォルダの symlink にも印。除外・ぶら下がりは出さない', async () => {
    const listing = await indexer.listDirectory(pathToUri(join(home, 'proj')))
    expect(listing.live).toBe(false)
    const byName = new Map(listing.entries.map((entry) => [entry.name, entry]))
    expect([...byName.keys()]).toEqual(['sw2-link', 'a.ts', 'todo.md'])
    expect(byName.get('todo.md')).toMatchObject({
      uri: pathToUri(join(home, 'proj', 'todo.md')),
      isDirectory: false,
      size: '# todo\n'.length,
      ext: 'md',
      symlink: true
    })
    expect(byName.get('sw2-link')).toMatchObject({ isDirectory: true, symlink: true })
    expect(byName.get('a.ts')?.symlink).toBeUndefined()
  })

  it('その場で読む一覧: symlink は実体の種類で出し、資格情報を指すものは出さない', async () => {
    const listing = await indexer.listDirectory(pathToUri(join(home, 'live')))
    expect(listing.live).toBe(true)
    const byName = new Map(listing.entries.map((entry) => [entry.name, entry]))
    expect([...byName.keys()]).toEqual(['dir-link', 'plain.txt', 'todo.md'])
    expect(byName.get('dir-link')).toMatchObject({ isDirectory: true, symlink: true })
    expect(byName.get('todo.md')).toMatchObject({ isDirectory: false, size: 7, symlink: true })
    expect(byName.get('plain.txt')?.symlink).toBeUndefined()
  })

  it('走査は今までどおりファイルの symlink を索引に入れない (ファイル名検索に出ない)', async () => {
    const found = await indexer.searchFiles('todo', 50, null, null)
    expect(found.entries.map((entry) => entry.uri)).toEqual([pathToUri(join(home, 'sw2', 'todo.md'))])
  })
})

describe('main の関門と symlink (TODO 558)', () => {
  it('実体が除外でなければ通り、論理パス (リンクのパス) を返す。資格情報を指すものは symlink-escape', () => {
    const fs = new FsAccess(home, [home])
    const link = join(home, 'proj', 'todo.md')
    expect(fs.assertAllowed(pathToUri(link), false, 'read')).toBe(link)
    expect(fs.assertAllowed(pathToUri(link), false)).toBe(link)
    try {
      fs.assertAllowed(pathToUri(join(home, 'proj', 'key')), false, 'read')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(PathDenied)
      expect((err as PathDenied).reason).toBe('symlink-escape')
    }
  })
})
