/**
 * Hides entries starting with "." by default in the file tree (TODO 261, wave 15 bundle D).
 *
 * - The list of the index process (`FsIndexer.listDirectory`) hides entries starting with "." when `showHidden: false`, both for index rows and for the path that reads on the spot. It narrows **before** the cut by `MAX_ROWS`.
 * - Even while hidden, the paths that match `keep` (the working folder `~/.aios-v17/real`, and a file opened in the viewer) remain.
 * - **Display only**: filename search results are not hidden. The default (no options) still returns everything, as before.
 * - The pure functions of the renderer (building keep, pin, ⌘⇧.), main's saving (`HiddenFilesPreference`), and checking of IPC / RPC values (`asListDirectoryOptions`).
 *
 * Real SQLite (in memory) and the real disk (`~/.aios-test/<run>/`). The model is not called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { UI_SHOW_HIDDEN_FILES } from '../src/common/settings-keys.js'
import { pathToUri } from '../src/common/uri.js'
import { FsIndexer, keptHiddenNames, MAX_ROWS } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { HiddenFilesPreference } from '../src/main/hidden-files.js'
import { asListDirectoryOptions, LIST_KEEP_MAX } from '../src/shared/types.js'
import {
  isToggleHiddenKey,
  keepUnder,
  lastSegment,
  listOptions,
  parentUri,
  shouldPin
} from '../src/renderer/src/hidden-files.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

let root: string
let db: Db
let store: IndexStore
let fs: FsIndexer

beforeAll(async () => {
  root = makeTestDir('hidden-files')
  mkdirSync(join(root, 'notes'))
  writeFileSync(join(root, 'notes', 'a.md'), 'a\n')
  writeFileSync(join(root, '.env'), 'X=1\n')
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'HEAD'), 'ref\n')
  // The working folder itself is inside a hidden folder (the shape `~/.aios-v17/real`).
  mkdirSync(join(root, '.aios-v17', 'real'), { recursive: true })
  writeFileSync(join(root, '.aios-v17', 'real', 'plan.md'), 'p\n')
  writeFileSync(join(root, 'visible.txt'), 'v\n')
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
  fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, root, [root])
  await fs.scan()
  // Created after the scan, so there is no row in the index (no watch either). It becomes the path that reads on the spot. It does not appear in the list answered from the index rows (root), because the list does not add anything that is not in the index.
  mkdirSync(join(root, 'late', '.cache-like'), { recursive: true })
  writeFileSync(join(root, 'late', '.hidden.txt'), 'h\n')
  writeFileSync(join(root, 'late', 'shown.txt'), 's\n')
})

afterAll(async () => {
  await fs.stop()
  db.close()
  removeTestDir(root)
})

const names = async (dir: string, options?: Parameters<FsIndexer['listDirectory']>[1]) =>
  (await fs.listDirectory(pathToUri(dir), options)).entries.map((entry) => entry.name)

describe('index process listing (TODO 261)', () => {
  it('the default (no options) returns everything as before', async () => {
    expect(await names(root)).toEqual([
      '.aios-v17',
      '.git',
      'notes',
      '.env',
      'visible.txt'
    ])
  })

  it('showHidden: false hides dot-prefixed items (index rows)', async () => {
    const listing = await fs.listDirectory(pathToUri(root), { showHidden: false })
    expect(listing.live).toBe(false)
    expect(listing.entries.map((entry) => entry.name)).toEqual(['notes', 'visible.txt'])
  })

  it('hides them also on the path read on the spot (the scan has not reached it)', async () => {
    const listing = await fs.listDirectory(pathToUri(join(root, 'late')), { showHidden: false })
    expect(listing.live).toBe(true)
    expect(listing.entries.map((entry) => entry.name)).toEqual(['shown.txt'])
    expect(await names(join(root, 'late'))).toEqual(['.cache-like', '.hidden.txt', 'shown.txt'])
  })

  it('even if the working folder is inside a hidden folder, the path to it remains (keep)', async () => {
    const cwd = pathToUri(join(root, '.aios-v17', 'real'))
    expect(await names(root, { showHidden: false, keep: [cwd] })).toEqual([
      '.aios-v17',
      'notes',
      'visible.txt'
    ])
    expect(await names(join(root, '.aios-v17'), { showHidden: false, keep: [cwd] })).toEqual(['real'])
    // It remains even as a path itself (when keep is that directory itself).
    expect(
      await names(root, { showHidden: false, keep: [pathToUri(join(root, '.git'))] })
    ).toContain('.git')
  })

  it('a file opened in the viewer (the hidden file itself) also remains; unrelated keep entries are ignored', async () => {
    expect(
      await names(root, {
        showHidden: false,
        keep: [pathToUri(join(root, '.env')), pathToUri('/elsewhere/.x'), 'not-a-uri']
      })
    ).toEqual(['notes', '.env', 'visible.txt'])
  })

  it('filters before being cut by MAX_ROWS (hidden items do not eat the quota)', async () => {
    const dir = join(root, 'crowded')
    mkdirSync(dir)
    writeFileSync(join(dir, 'real.txt'), 'r\n')
    await fs.scan()
    // Adds MAX_ROWS entries starting with "." to the index only. They are not on disk, but since they are hidden, they are not matched in the comparison either.
    const parentId = store.findByPath(dir) as number
    store.transaction(() => {
      for (let i = 0; i < MAX_ROWS; i += 1) {
        store.upsertFsEntry({
          parentId,
          name: `.h${String(i).padStart(5, '0')}`,
          isDirectory: false,
          ext: '',
          size: 1,
          mtimeMs: 1,
          seenAt: Date.now()
        })
      }
    })
    expect(await names(dir, { showHidden: false })).toEqual(['real.txt'])
  })

  it('display only: file name search does not hide', async () => {
    const found = await fs.searchFiles('HEAD')
    expect(found.entries.map((entry) => entry.name)).toContain('HEAD')
    expect((await fs.searchFiles('.env')).entries.map((entry) => entry.name)).toContain('.env')
  })

  it('keptHiddenNames: only the dot-prefixed ancestors directly under dir (already collapsed)', () => {
    const dir = '/Users/me'
    expect([
      ...keptHiddenNames(dir, [
        pathToUri('/Users/me/.Aios-V17/real'),
        pathToUri('/Users/me/visible/.x'),
        pathToUri('/Users/meow/.y'),
        pathToUri('/Users/me/.env'),
        'file:///relative/../Users/me/.z'
      ])
    ].sort()).toEqual(['.aios-v17', '.env', '.z'])
    expect(keptHiddenNames('/', [pathToUri('/.hidden/a')]).has('.hidden')).toBe(true)
    expect(keptHiddenNames(dir, undefined).size).toBe(0)
  })
})

describe('value validation (asListDirectoryOptions)', () => {
  it('does not trust types: a showHidden that is not a boolean is dropped, and keep takes only strings up to the limit', () => {
    expect(asListDirectoryOptions(null)).toEqual({})
    expect(asListDirectoryOptions({ showHidden: 'no' })).toEqual({})
    expect(asListDirectoryOptions({ showHidden: false })).toEqual({ showHidden: false })
    const keep = asListDirectoryOptions({
      showHidden: false,
      keep: ['file:///a', 1, null, '', 'x'.repeat(5000), ...Array.from({ length: 50 }, (_, i) => `file:///k${i}`)]
    }).keep
    expect(keep?.[0]).toBe('file:///a')
    expect(keep).toHaveLength(LIST_KEEP_MAX)
    expect(keep?.every((item) => typeof item === 'string' && item.length < 5000)).toBe(true)
  })
})

describe('renderer pure functions (hidden-files.ts)', () => {
  it('lastSegment / parentUri', () => {
    expect(lastSegment('file:///Users/me/.git/')).toBe('.git')
    expect(parentUri('file:///Users/me/.git')).toBe('file:///Users/me')
    expect(parentUri('file:///Users')).toBe('file:///')
    expect(parentUri('file:///')).toBeNull()
  })

  it('shouldPin: only when a dot-prefixed item is opened while hiding', () => {
    expect(shouldPin('file:///Users/me/.aios-v17', false)).toBe(true)
    expect(shouldPin('file:///Users/me/.aios-v17', true)).toBe(false)
    expect(shouldPin('file:///Users/me/git', false)).toBe(false)
  })

  it('keepUnder / listOptions: attach only what applies under the listing, and filter nothing when shown', () => {
    const home = 'file:///Users/me'
    expect(
      keepUnder(home, ['file:///Users/me/.aios-v17/real', null, 'file:///Users/other/.x', home, 'file:///Users/me/'])
    ).toEqual(['file:///Users/me/.aios-v17/real'])
    expect(listOptions(home, true, ['file:///Users/me/.git'])).toEqual({ showHidden: true })
    expect(listOptions(home, false, [])).toEqual({ showHidden: false })
    expect(listOptions(home, false, ['file:///Users/me/.git'])).toEqual({
      showHidden: false,
      keep: ['file:///Users/me/.git']
    })
  })

  it('watches Cmd+Shift+. (mac) / Ctrl+Shift+. (other) by physical key', () => {
    const key = (over: Partial<Parameters<typeof isToggleHiddenKey>[0]>) => ({
      key: '>',
      code: 'Period',
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      ...over
    })
    expect(isToggleHiddenKey(key({ metaKey: true }), 'mac')).toBe(true)
    expect(isToggleHiddenKey(key({ metaKey: true, key: '.' }), 'mac')).toBe(true)
    expect(isToggleHiddenKey(key({ ctrlKey: true }), 'mac')).toBe(false)
    expect(isToggleHiddenKey(key({ ctrlKey: true }), 'other')).toBe(true)
    expect(isToggleHiddenKey(key({ metaKey: true, shiftKey: false }), 'mac')).toBe(false)
    expect(isToggleHiddenKey(key({ metaKey: true, code: 'Comma' }), 'mac')).toBe(false)
    expect(isToggleHiddenKey(key({ metaKey: true, altKey: true }), 'mac')).toBe(false)
  })
})

describe('saving (HiddenFilesPreference, main)', () => {
  it('hidden by default; the switch is saved, and a notification to all windows goes out once only when it changes', () => {
    const memory = new Database(':memory:')
    runMigrations(memory)
    const settings = new AppSettingsStore(memory)
    const changes: boolean[] = []
    const preference = new HiddenFilesPreference(settings, (show) => changes.push(show))
    expect(preference.get()).toBe(false)
    expect(preference.set(true)).toBe(true)
    expect(preference.set(true)).toBe(true)
    expect(changes).toEqual([true])
    expect(settings.readTyped(UI_SHOW_HIDDEN_FILES)).toBe(true)
    // Still remembered at the next launch (the re-creation).
    expect(new HiddenFilesPreference(settings).get()).toBe(true)
    memory.close()
  })
})
