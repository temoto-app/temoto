/**
 * TODO 676 (wave 31 bundle C): imports Chrome bookmarks into aios Favorite. Neither the model nor electron is used.
 *
 * - pure functions in `src/main/web/chrome-bookmarks.ts` (flattening the JSON of `Bookmarks` / `Local State`; independent of fs)
 * - `src/main/web/chrome-import.ts` (the main-side entry point that reads fs): **a temporary fixture directory is passed as `home`, and the owner's real Chrome files are never read** (the common promise of wave 31)
 * - `importChromeBookmarks`: skips the same URL, skips what is over the cap, and does not count `javascript:` and the like
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { MAX_WEB_FAVORITES } from '../src/shared/web-tabs.js'
import {
  chromeAppBundlePath,
  flattenChromeBookmarks,
  loadChromeAppIcon,
  parseChromeProfiles,
  type LoadedIcon
} from '../src/main/web/chrome-bookmarks.js'
import { importChromeBookmarks, listChromeProfiles } from '../src/main/web/chrome-import.js'
import { WebDataStore } from '../src/main/web/data.js'

function urlNode(name: string, url: string): Record<string, unknown> {
  return { type: 'url', name, url }
}
function folderNode(name: string, children: readonly unknown[]): Record<string, unknown> {
  return { type: 'folder', name, children }
}

describe('main/web/chrome-bookmarks: 純関数', () => {
  it('ブックマーク バー → その他 → モバイルの深さ優先で平らにする', () => {
    const json = {
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: 'Bookmarks bar',
          children: [urlNode('A', 'https://a.example/'), folderNode('sub', [urlNode('B', 'https://b.example/')])]
        },
        other: { type: 'folder', name: 'Other', children: [urlNode('C', 'https://c.example/')] },
        synced: { type: 'folder', name: 'Mobile', children: [urlNode('D', 'https://d.example/')] }
      }
    }
    expect(flattenChromeBookmarks(json)).toEqual([
      { title: 'A', url: 'https://a.example/' },
      { title: 'B', url: 'https://b.example/' },
      { title: 'C', url: 'https://c.example/' },
      { title: 'D', url: 'https://d.example/' }
    ])
  })

  it('形が違う・空の JSON は空の配列', () => {
    expect(flattenChromeBookmarks(null)).toEqual([])
    expect(flattenChromeBookmarks({})).toEqual([])
    expect(flattenChromeBookmarks({ roots: {} })).toEqual([])
    expect(flattenChromeBookmarks('not json')).toEqual([])
  })

  it('`Local State` の `profile.info_cache` からプロファイルの表示名を作る。無ければディレクトリ名', () => {
    const json = {
      profile: {
        info_cache: {
          Default: { name: 'かずむ' },
          'Profile 1': {}
        }
      }
    }
    expect(parseChromeProfiles(json)).toEqual([
      { dir: 'Default', name: 'かずむ' },
      { dir: 'Profile 1', name: 'Profile 1' }
    ])
  })

  it('`info_cache` が無ければ空', () => {
    expect(parseChromeProfiles({})).toEqual([])
    expect(parseChromeProfiles(null)).toEqual([])
  })
})

// TODO 723: the Chrome.app icon shown on the button when Favorite is empty.
describe('main/web/chrome-bookmarks: chromeAppBundlePath / loadChromeAppIcon (TODO 723)', () => {
  it('chromeAppBundlePath: 既定は /Applications、テスト用に差し替え可能', () => {
    expect(chromeAppBundlePath()).toBe('/Applications/Google Chrome.app')
    expect(chromeAppBundlePath('/tmp/apps')).toBe('/tmp/apps/Google Chrome.app')
  })

  const icon = (dataUrl: string): LoadedIcon => ({ isEmpty: () => false, toDataURL: () => dataUrl })
  const emptyIcon: LoadedIcon = { isEmpty: () => true, toDataURL: () => '' }

  it('存在しなければ getIcon を呼ばずに null', async () => {
    let called = false
    const result = await loadChromeAppIcon(
      '/Applications/Google Chrome.app',
      () => false,
      async () => {
        called = true
        return emptyIcon
      }
    )
    expect(result).toBeNull()
    expect(called).toBe(false)
  })

  it('存在して読めれば data URL', async () => {
    const result = await loadChromeAppIcon('/Applications/Google Chrome.app', () => true, async () =>
      icon('data:image/png;base64,AAA')
    )
    expect(result).toBe('data:image/png;base64,AAA')
  })

  it('存在するが空の画像なら null', async () => {
    const result = await loadChromeAppIcon('/Applications/Google Chrome.app', () => true, async () => emptyIcon)
    expect(result).toBeNull()
  })

  it('getIcon が例外を投げても null (投げない)', async () => {
    const result = await loadChromeAppIcon('/Applications/Google Chrome.app', () => true, async () => {
      throw new Error('boom')
    })
    expect(result).toBeNull()
  })
})

describe('main/web/chrome-import: fs を読む口 (fixture の一時ディレクトリだけ、実物の Chrome は読まない)', () => {
  let home: string
  let chromeDir: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'aios-chrome-test-'))
    chromeDir = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    await mkdir(chromeDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function writeProfile(dir: string, bookmarks: unknown): Promise<void> {
    await mkdir(join(chromeDir, dir), { recursive: true })
    await writeFile(join(chromeDir, dir, 'Bookmarks'), JSON.stringify(bookmarks))
  }

  it('`Local State` が無ければ Chrome が無いとみなし null', async () => {
    expect(await listChromeProfiles(home)).toBeNull()
  })

  it('`Local State` はあるが Bookmarks を持つプロファイルが無ければ空の配列', async () => {
    await writeFile(join(chromeDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: {} } } }))
    expect(await listChromeProfiles(home)).toEqual([])
  })

  it('プロファイルごとに表示名と件数を返す', async () => {
    await writeFile(
      join(chromeDir, 'Local State'),
      JSON.stringify({ profile: { info_cache: { Default: { name: 'Work' }, 'Profile 1': { name: 'Personal' } } } })
    )
    await writeProfile('Default', {
      roots: { bookmark_bar: folderNode('bar', [urlNode('A', 'https://a.example/')]), other: folderNode('o', []) }
    })
    await writeProfile('Profile 1', {
      roots: {
        bookmark_bar: folderNode('bar', [urlNode('B', 'https://b.example/'), urlNode('C', 'https://c.example/')])
      }
    })
    const profiles = await listChromeProfiles(home)
    expect(profiles).toEqual([
      { dir: 'Default', name: 'Work', count: 1 },
      { dir: 'Profile 1', name: 'Personal', count: 2 }
    ])
  })

  describe('importChromeBookmarks', () => {
    let db: Db
    let store: WebDataStore

    /** Puts it in the state where `listChromeProfiles` knows `profileDir` (required since the code-review fix). */
    async function writeLocalState(dirs: readonly string[] = ['Default']): Promise<void> {
      const cache: Record<string, { name: string }> = {}
      for (const dir of dirs) cache[dir] = { name: dir }
      await writeFile(join(chromeDir, 'Local State'), JSON.stringify({ profile: { info_cache: cache } }))
    }

    beforeEach(() => {
      db = new Database(':memory:')
      runMigrations(db)
      store = new WebDataStore(db, () => 1_000_000_000_000)
    })
    afterEach(() => db.close())

    it('読めないプロファイルは null', async () => {
      expect(await importChromeBookmarks(store, 'Default', home)).toBeNull()
    })

    // code-review fix (security): the profileDir that came from the renderer is not used in join as it is.
    it('区切りや .. を含む profileDir は拒む (path.join での脱出を防ぐ)', async () => {
      await writeLocalState()
      for (const bad of ['../../etc', 'a/b', 'a\\b', '..', '.', '']) {
        expect(await importChromeBookmarks(store, bad, home)).toBeNull()
      }
    })

    it('listChromeProfiles が知らないプロファイル名 (Local State に無い) は拒む', async () => {
      await writeLocalState(['Default'])
      await writeProfile('Evil', {
        roots: { bookmark_bar: folderNode('bar', [urlNode('X', 'https://x.example/')]) }
      })
      // 'Evil' exists as a directory and its Bookmarks can be read too, but it is not in Local State's info_cache.
      expect(await importChromeBookmarks(store, 'Evil', home)).toBeNull()
      expect(store.listFavorites()).toEqual([])
    })

    it('平らにして Favorite へ足す。すでにある URL は数えるが足さない。javascript: は数えない', async () => {
      await writeLocalState()
      store.addFavorite('https://existing.example/', 'Existing')
      await writeProfile('Default', {
        roots: {
          bookmark_bar: folderNode('bar', [
            urlNode('Existing', 'https://existing.example/'),
            urlNode('New', 'https://new.example/'),
            urlNode('JS', 'javascript:alert(1)')
          ])
        }
      })
      const result = await importChromeBookmarks(store, 'Default', home)
      expect(result).toEqual({ imported: 1, alreadyPresent: 1, skippedOverLimit: 0 })
      const urls = store.listFavorites().map((f) => f.url)
      expect(urls).toContain('https://new.example/')
      expect(urls).toContain('https://existing.example/')
      expect(urls).not.toContain('javascript:alert(1)')
    })

    it('上限を超える分は飛ばして件数で知らせる', async () => {
      await writeLocalState()
      for (let i = 0; i < MAX_WEB_FAVORITES - 1; i += 1) {
        store.addFavorite(`https://existing-${i}.example/`, '')
      }
      await writeProfile('Default', {
        roots: {
          bookmark_bar: folderNode('bar', [
            urlNode('One', 'https://room.example/'),
            urlNode('Two', 'https://over.example/')
          ])
        }
      })
      const result = await importChromeBookmarks(store, 'Default', home)
      expect(result).toEqual({ imported: 1, alreadyPresent: 0, skippedOverLimit: 1 })
    })

    it('深さ優先の順で末尾に足す (position は既存の続き)', async () => {
      await writeLocalState()
      store.addFavorite('https://first.example/', 'First')
      await writeProfile('Default', {
        roots: { bookmark_bar: folderNode('bar', [urlNode('A', 'https://a.example/'), urlNode('B', 'https://b.example/')]) }
      })
      await importChromeBookmarks(store, 'Default', home)
      expect(store.listFavorites().map((f) => f.url)).toEqual([
        'https://first.example/',
        'https://a.example/',
        'https://b.example/'
      ])
    })
  })
})
