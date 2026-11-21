/**
 * TODO 520 (wave 26 bundle D): the shortcuts at the top of the Files tree (Downloads / Desktop / Applications /
 * Movies / Documents / Trash), and the "view only" exception for the trash.
 *
 * - `FsAccess.roots()`: the shortcuts come first, in the order of `FOLDER_SHORTCUTS`, and missing folders are not listed. Then `~/` and `/`.
 * - Exclusion rules: the trash (`~/.Trash`) stays excluded in `classify` (not in the scan or the index), and only `classifyAccess(…, 'read')` lets it through. Items inside it such as `node_modules` and file-name rules, and symlink escapes, are not restored.
 * - Choke point: `assertAllowed` refuses with `'write'` (the default) and passes with `'read'`. Creation (`createEntry`) is refused.
 * - The list from the index process: the inside of the trash can be listed with `'read'` (the path that reads on the spot). The scan does not enter the trash.
 * - `listDirectoryGuarded` applies the list through the `'read'` choke point.
 *
 * Real SQLite (in memory) and the real disk (`~/.aios-test/<run>/`). Calls neither the model nor Electron.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { pathToUri } from '../src/common/uri.js'
import { classify, classifyAccess, createMacosExclusions } from '../src/common/exclusions.js'
import { PathDenied } from '../src/common/fs-policy.js'
import { FsIndexer, sortDownloadsEntries } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { FsAccess } from '../src/main/fs/access.js'
import { createEntry } from '../src/main/fs/create.js'
import { listDirectoryGuarded } from '../src/main/ipc/handlers.js'
import { FOLDER_SHORTCUTS, isReadOnlyShortcut } from '../src/shared/types.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

let home: string
let apps: string
let trash: string
/** A location (a folder that does not exist) so that the `/tmp` shortcut (TODO 561) is not shown. The `/tmp` shortcut is covered in `test/exclusions.test.ts`. */
let noTmp: string

beforeAll(() => {
  home = makeTestDir('folder-shortcuts')
  apps = join(home, 'Apps')
  trash = join(home, '.Trash')
  noTmp = join(home, 'no-tmp')
  for (const dir of ['Downloads', 'Desktop', 'Documents', 'Apps', '.ssh']) mkdirSync(join(home, dir))
  // There is no Movies (someone deleted it), so it does not appear as a shortcut.
  writeFileSync(join(home, 'Downloads', 'a.pdf'), 'pdf\n')
  // TODO 627: directly under `~/Downloads`, files come first, by mtime newest first. Folders (`old-folder`) come after, and a folder newer than an old file (`old.txt`) does not change the order.
  mkdirSync(join(home, 'Downloads', 'old-folder'))
  writeFileSync(join(home, 'Downloads', 'old.txt'), 'old\n')
  writeFileSync(join(home, 'Downloads', 'new.txt'), 'new\n')
  const oldTime = new Date('2020-01-01T00:00:00Z')
  const midTime = new Date('2021-01-01T00:00:00Z')
  const newTime = new Date('2022-01-01T00:00:00Z')
  utimesSync(join(home, 'Downloads', 'old.txt'), oldTime, oldTime)
  utimesSync(join(home, 'Downloads', 'a.pdf'), midTime, midTime)
  utimesSync(join(home, 'Downloads', 'new.txt'), newTime, newTime)
  utimesSync(join(home, 'Downloads', 'old-folder'), newTime, newTime)
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret\n')
  mkdirSync(join(trash, 'old', 'node_modules'), { recursive: true })
  writeFileSync(join(trash, 'old', 'node_modules', 'x.js'), 'x\n')
  writeFileSync(join(trash, 'deleted.md'), '# gone\n')
  writeFileSync(join(trash, 'old', 'note.txt'), 'n\n')
  writeFileSync(join(trash, '.netrc'), 'machine x\n')
  // A symlink inside the trash that points to a credential. Even for reading, the canonical re-check drops it.
  symlinkSync(join(home, '.ssh', 'id_ed25519'), join(trash, 'key-link'))
})

afterAll(() => {
  removeTestDir(home)
})

describe('FsAccess.roots() の近道 (TODO 520)', () => {
  it('近道が先頭に決まった順で並び、無いフォルダは出ない。続いて ~/ と /', () => {
    const roots = new FsAccess(home, null, apps, noTmp).roots()
    expect(roots.map((root) => root.shortcut ?? root.name)).toEqual([
      'downloads',
      'desktop',
      'applications',
      'documents',
      'trash',
      home.slice(home.lastIndexOf('/') + 1),
      '/'
    ])
    const downloads = roots[0]
    expect(downloads).toMatchObject({
      uri: pathToUri(join(home, 'Downloads')),
      parentUri: null,
      name: 'Downloads',
      isDirectory: true
    })
    expect(roots[2]?.uri).toBe(pathToUri(apps))
    expect(roots[4]?.uri).toBe(pathToUri(trash))
    // Roots that are not shortcuts have no mark.
    expect(roots.slice(5).every((root) => root.shortcut === undefined)).toBe(true)
  })

  it('走査ルートを明示したとき (テスト用) は近道を出さない', () => {
    expect(new FsAccess(home, [home], apps).roots().map((root) => root.uri)).toEqual([pathToUri(home)])
  })

  it('並びの表と、見るだけはゴミ箱だけ', () => {
    expect(FOLDER_SHORTCUTS).toEqual(['downloads', 'desktop', 'applications', 'movies', 'documents', 'trash', 'tmp'])
    expect(FOLDER_SHORTCUTS.filter((kind) => isReadOnlyShortcut(kind))).toEqual(['trash'])
    expect(isReadOnlyShortcut(undefined)).toBe(false)
  })
})

describe('ゴミ箱は見るだけの例外 (TODO 520)', () => {
  const rules = (): ReturnType<typeof createMacosExclusions> => createMacosExclusions(home)

  it('classify (走査・索引) は除外のまま、classifyAccess の read だけが通す', () => {
    const r = rules()
    const file = join(trash, 'deleted.md')
    expect(classify(trash, '.Trash', true, r)).toEqual({ excluded: true, reason: 'cache' })
    expect(classify(file, 'deleted.md', false, r).excluded).toBe(true)
    expect(classifyAccess(file, 'deleted.md', false, r, 'write').excluded).toBe(true)
    expect(classifyAccess(file, 'deleted.md', false, r, 'read').excluded).toBe(false)
    expect(classifyAccess(trash, '.Trash', true, r, 'read').excluded).toBe(false)
    expect(classifyAccess(join(trash, 'old'), 'old', true, r, 'read').excluded).toBe(false)
  })

  it('中の生成物・資格情報のファイル名、ほかの一時領域は戻さない', () => {
    const r = rules()
    expect(classifyAccess(join(trash, 'old', 'node_modules'), 'node_modules', true, r, 'read').excluded).toBe(true)
    expect(classifyAccess(join(trash, '.netrc'), '.netrc', false, r, 'read').excluded).toBe(true)
    expect(classifyAccess(join(home, '.cache', 'x'), 'x', false, r, 'read').excluded).toBe(true)
    // A sibling that merely has a similar name does not match.
    expect(classifyAccess(join(home, '.Trash2', 'x'), 'x', false, r, 'read').excluded).toBe(false)
    expect(classify(join(home, '.Trash2', 'x'), 'x', false, r).excluded).toBe(false)
  })

  it('関門: write (既定) は断り、read は通す。資格情報への symlink は read でも落ちる', () => {
    const fs = new FsAccess(home, null, apps, noTmp)
    const uri = pathToUri(join(trash, 'deleted.md'))
    expect(() => fs.assertAllowed(uri, false)).toThrow(PathDenied)
    expect(fs.assertAllowed(uri, false, 'read')).toBe(join(trash, 'deleted.md'))
    expect(fs.assertAllowed(pathToUri(trash), true, 'read')).toBe(trash)
    expect(() => fs.assertAllowed(pathToUri(join(trash, 'key-link')), false, 'read')).toThrow(PathDenied)
    expect(fs.isViewable(join(trash, 'deleted.md'))).toBe(true)
    // Not included in the reference scope (`--add-dir`).
    expect(fs.isReferenceable(trash)).toBe(false)
  })

  it('ゴミ箱の中には作れない (createEntry は write の関門)', () => {
    const fs = new FsAccess(home, null, apps, noTmp)
    const result = createEntry(fs, 'file', pathToUri(trash), 'new.txt')
    expect(result.uri).toBeNull()
    expect(result.created).toEqual([])
  })

  it('listDirectoryGuarded は一覧を read の関門で掛ける', async () => {
    const fs = new FsAccess(home, null, apps, noTmp)
    const listDirectory = vi.fn().mockResolvedValue({ uri: '', entries: [], live: true, reason: null })
    const listing = await listDirectoryGuarded(fs, { listDirectory }, pathToUri(trash), {})
    expect(listing.reason).toBeNull()
    expect(listDirectory).toHaveBeenCalledOnce()
    // Credential locations are still refused as before.
    const denied = await listDirectoryGuarded(fs, { listDirectory }, pathToUri(join(home, '.ssh')), {})
    expect(denied.reason).toBe('path-excluded')
    expect(listDirectory).toHaveBeenCalledOnce()
  })
})

describe('sortDownloadsEntries (TODO 627)', () => {
  type Row = { readonly name: string; readonly isDirectory: boolean; readonly mtimeMs: number }
  const row = (name: string, isDirectory: boolean, mtimeMs: number): Row => ({ name, isDirectory, mtimeMs })

  it('ファイルを先に mtime の新しい順、フォルダは後ろで元の順のまま', () => {
    const out = sortDownloadsEntries([
      row('dirA', true, 500),
      row('old.txt', false, 100),
      row('dirB', true, 999),
      row('new.txt', false, 300)
    ])
    expect(out.map((e) => e.name)).toEqual(['new.txt', 'old.txt', 'dirA', 'dirB'])
  })

  it('空・全ファイル・全フォルダでも壊れない', () => {
    expect(sortDownloadsEntries([])).toEqual([])
    expect(sortDownloadsEntries([row('a', false, 1), row('b', false, 2)]).map((e) => e.name)).toEqual(['b', 'a'])
    expect(sortDownloadsEntries([row('a', true, 1), row('b', true, 2)]).map((e) => e.name)).toEqual(['a', 'b'])
  })
})

describe('索引プロセスの一覧とゴミ箱 (TODO 520)', () => {
  let db: Db
  let indexer: FsIndexer

  beforeAll(async () => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    indexer = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, new IndexStore(db), home, [home])
    await indexer.scan()
  })

  afterAll(async () => {
    await indexer.stop()
    db.close()
  })

  it('走査はゴミ箱に入らない (ホームの一覧にも出ない)', async () => {
    const listing = await indexer.listDirectory(pathToUri(home))
    const names = listing.entries.map((entry) => entry.name)
    expect(names).toContain('Downloads')
    expect(names).not.toContain('.Trash')
    const found = await indexer.searchFiles('deleted', 50, null, null)
    expect(found.entries.map((entry) => entry.name)).not.toContain('deleted.md')
  })

  it('ゴミ箱の中は読み取りで一覧できる (その場で読む)。生成物・.netrc・symlink の脱出は出さない', async () => {
    const listing = await indexer.listDirectory(pathToUri(trash))
    expect(listing.live).toBe(true)
    expect(listing.reason).toBeNull()
    // `key-link` (a symlink pointing to a credential) does not appear, because since TODO 558 the real target is checked by the choke point (before, it was listed as a file).
    expect(listing.entries.map((entry) => entry.name)).toEqual(['old', 'deleted.md'])
    const old = await indexer.listDirectory(pathToUri(join(trash, 'old')))
    expect(old.entries.map((entry) => entry.name)).toEqual(['note.txt'])
  })

  it('TODO 627: ~/Downloads 直下はファイルを先に・mtime の新しい順。フォルダは mtime に関係なく後ろ', async () => {
    const listing = await indexer.listDirectory(pathToUri(join(home, 'Downloads')))
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      'new.txt',
      'a.pdf',
      'old.txt',
      'old-folder'
    ])
  })

  it('TODO 627: ~/Downloads 以外は今どおり (ディレクトリが先、走査の既定の並び)', async () => {
    const top = await indexer.listDirectory(pathToUri(home))
    const names = top.entries.map((entry) => entry.name)
    // Directly under home, Downloads (a directory) stays near the top in the default order, and does not change to mtime order.
    expect(top.entries.find((entry) => entry.name === 'Downloads')?.isDirectory).toBe(true)
    expect(names).toContain('Downloads')
    const subfolder = await indexer.listDirectory(pathToUri(join(home, 'Downloads', 'old-folder')))
    expect(subfolder.entries).toEqual([])
  })
})

/**
 * Wave 29 code-review: `sortDownloadsEntries` was inserted between the JSDoc of `keptHiddenNames` and its function.
 * Checks that the JSDoc directly above each of the two functions is its own description (two JSDocs do not run in a row).
 */
describe('indexer.ts の JSDoc の位置 (code-review)', () => {
  const source = readFileSync(join(__dirname, '../src/index-kernel/indexer.ts'), 'utf8')
  const docAbove = (signature: string): string => {
    const at = source.indexOf(signature)
    expect(at).toBeGreaterThan(0)
    const head = source.slice(0, at)
    expect(head.endsWith('*/\n')).toBe(true)
    const doc = head.slice(head.lastIndexOf('/**'))
    expect(doc.slice(3)).not.toContain('/**')
    return doc
  }
  it('keptHiddenNames の真上は TODO 261 の説明、sortDownloadsEntries の真上は TODO 627 の説明', () => {
    expect(docAbove('export function keptHiddenNames(')).toContain('TODO 261')
    expect(docAbove('export function sortDownloadsEntries<')).toContain('TODO 627')
  })
})
