/**
 * The `.app` icon in the Files tree (TODO 562). The check of `AppIconCache` (name, choke point, existence), the cache by path + mtime, and the
 * judgment of `isAppBundle`. electron is not used (the fetching is a fake).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppIconCache } from '../src/main/fs/app-icon.js'
import { isAppBundle, isAppBundleName } from '../src/shared/app-bundle.js'
import { pathToUri, uriToPath } from '../src/common/uri.js'
import { PathDenied } from '../src/common/fs-policy.js'
import { makeTestDir } from './helpers/tmp.js'

let root: string

beforeAll(() => {
  root = makeTestDir('app-icon')
  mkdirSync(join(root, 'Keynote.app', 'Contents'), { recursive: true })
  mkdirSync(join(root, 'Other.APP'), { recursive: true })
  mkdirSync(join(root, 'Folder'), { recursive: true })
  writeFileSync(join(root, 'fake.app'), 'not a bundle')
  symlinkSync(join(root, 'Keynote.app'), join(root, 'Link.app'))
  mkdirSync(join(root, 'secret.app'), { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Fake for the choke point: a path containing `secret` is refused. */
const fs = {
  assertAllowed(uri: string): string {
    const path = uriToPath(uri)
    if (path.includes('secret')) throw new PathDenied('excluded')
    return path
  }
}

describe('isAppBundle', () => {
  it('`.app` で終わるディレクトリだけ (大小は問わない)。ファイル・`.app` だけの名前は違う', () => {
    expect(isAppBundle({ name: 'Keynote.app', isDirectory: true })).toBe(true)
    expect(isAppBundle({ name: 'X.APP', isDirectory: true })).toBe(true)
    expect(isAppBundle({ name: 'Keynote.app', isDirectory: false })).toBe(false)
    expect(isAppBundle({ name: 'Folder', isDirectory: true })).toBe(false)
    expect(isAppBundle({ name: 'x.framework', isDirectory: true })).toBe(false)
    expect(isAppBundleName('.app')).toBe(false)
  })
})

describe('AppIconCache (TODO 562)', () => {
  it('`.app` のディレクトリはアイコンを返し、同じパス + mtime は 2 回目を取りに行かない', async () => {
    const load = vi.fn(async (path: string) => `data:image/png;base64,${Buffer.from(path).toString('base64')}`)
    const cache = new AppIconCache(fs, load)
    const uri = pathToUri(join(root, 'Keynote.app'))
    const first = await cache.iconFor(uri)
    expect(first?.startsWith('data:image/png;base64,')).toBe(true)
    expect(await cache.iconFor(uri)).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)
    // A second request made while fetching shares the same single fetch.
    const other = pathToUri(join(root, 'Other.APP'))
    await Promise.all([cache.iconFor(other), cache.iconFor(other)])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('mtime が変わったら取り直す (アプリの更新)', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,AA==')
    const cache = new AppIconCache(fs, load)
    const path = join(root, 'Keynote.app')
    await cache.iconFor(pathToUri(path))
    const later = new Date(Date.now() + 60_000)
    utimesSync(path, later, later)
    await cache.iconFor(pathToUri(path))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('`.app` でない・ファイル・symlink・関門で断られる・無い・URI でない値は null で、取りに行かない', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,AA==')
    const cache = new AppIconCache(fs, load)
    expect(await cache.iconFor(pathToUri(join(root, 'Folder')))).toBeNull()
    expect(await cache.iconFor(pathToUri(join(root, 'fake.app')))).toBeNull()
    expect(await cache.iconFor(pathToUri(join(root, 'Link.app')))).toBeNull()
    expect(await cache.iconFor(pathToUri(join(root, 'secret.app')))).toBeNull()
    expect(await cache.iconFor(pathToUri(join(root, 'Missing.app')))).toBeNull()
    expect(await cache.iconFor(42)).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it('取り方が失敗しても投げずに null', async () => {
    const cache = new AppIconCache(fs, async () => {
      throw new Error('boom')
    })
    expect(await cache.iconFor(pathToUri(join(root, 'Keynote.app')))).toBeNull()
  })

  it('上限を超えたら古いものから捨てる', async () => {
    const cache = new AppIconCache(fs, async () => 'data:,', 1)
    await cache.iconFor(pathToUri(join(root, 'Keynote.app')))
    await cache.iconFor(pathToUri(join(root, 'Other.APP')))
    expect(cache.size).toBe(1)
  })
})
