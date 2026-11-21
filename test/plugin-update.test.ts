/**
 * TODO 1144 stage 1 (wave 72 bundle C, ARCHITECTURE 8.5.1): the version and update state of each extension.
 *
 * - Checking the shape of the version table (`plugins.json`) (`parsePluginVersionTable`), and matching it against the plugin's version (`pluginUpdateOf`).
 * - `PluginReleaseCatalog`: takes the version table along with the app's own update check. Does not re-fetch the same tag. Keeps the previous version table on failure. Discards stale fetches.
 * - `fetchPluginVersionTable`: reads only after matching against SHA256SUMS. A Release with no version table gives null.
 * - `UpdateService` passes the result of the check through `onReleaseChecked`.
 * - The version table from `npm run release` (`scripts/release-config.mjs`) has the same name and shape as the shared one, and aios can read it.
 *
 * Does not call gh, the network, or the model (ReleaseSource is a fake).
 */
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { PLUGIN_VERSIONS_ASSET as RELEASE_ASSET, PLUGIN_VERSIONS_FORMAT as RELEASE_FORMAT, pluginVersionTable, pluginVersionTableText, releaseAssets } from '../scripts/release-config.mjs'
import {
  PLUGIN_VERSIONS_ASSET,
  PLUGIN_VERSIONS_FORMAT,
  parsePluginVersionTable,
  pluginUpdateOf,
  type PluginReleaseState,
  type PluginVersionTable
} from '../src/shared/plugin-update.js'
import { parseReason, reasonError } from '../src/shared/reason.js'
import { fetchPluginVersionTable, PluginReleaseCatalog } from '../src/main/update/plugin-versions.js'
import type { ReleaseSource } from '../src/main/update/release-source.js'
import { UpdateService } from '../src/main/update/service.js'
import type { SettingKey } from '../src/common/settings-keys.js'

const table = (plugins: Record<string, string>, aios = '0.72.0'): PluginVersionTable => ({
  format: 1,
  aios,
  plugins: Object.fromEntries(Object.entries(plugins).map(([id, version]) => [id, { version }]))
})

const bundled = (id: string, version: string) => ({ id, version, bundled: true })

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (err) {
    return parseReason(err instanceof Error ? err.message : String(err))?.code
  }
}

describe('版表の形 (parsePluginVersionTable)', () => {
  it('format 1 / aios の版 / plugins の id → { version } を読み、知らない鍵は捨てる', () => {
    expect(
      parsePluginVersionTable({
        format: 1,
        aios: 'v0.72.0',
        extra: true,
        plugins: { 'aios.text': { version: '1.0.0', asset: 'x.zip' }, 'aios.gmail': { version: '1.1.0' } }
      })
    ).toEqual(table({ 'aios.text': '1.0.0', 'aios.gmail': '1.1.0' }))
  })

  it('形が違えば null (format 違い・aios が版でない・plugins が配列・id や版が壊れている)', () => {
    const ok = { format: 1, aios: '0.72.0', plugins: { 'aios.text': { version: '1.0.0' } } }
    expect(parsePluginVersionTable(ok)).not.toBeNull()
    expect(parsePluginVersionTable(null)).toBeNull()
    expect(parsePluginVersionTable([])).toBeNull()
    expect(parsePluginVersionTable({ ...ok, format: 2 })).toBeNull()
    expect(parsePluginVersionTable({ ...ok, aios: 'latest' })).toBeNull()
    expect(parsePluginVersionTable({ ...ok, plugins: [] })).toBeNull()
    expect(parsePluginVersionTable({ ...ok, plugins: { '../x': { version: '1.0.0' } } })).toBeNull()
    expect(parsePluginVersionTable({ ...ok, plugins: { 'aios.text': '1.0.0' } })).toBeNull()
    expect(parsePluginVersionTable({ ...ok, plugins: { 'aios.text': { version: 1 } } })).toBeNull()
    expect(parsePluginVersionTable({ ...ok, plugins: { 'aios.text': { version: '' } } })).toBeNull()
  })
})

describe('版との突き合わせ (pluginUpdateOf)', () => {
  const released: PluginReleaseState = { kind: 'table', tag: 'v0.72.0', table: table({ 'aios.text': '1.0.0', 'aios.gmail': '1.2.0', 'aios.odd': 'beta' }) }

  it('同じ版・入っている方が新しいは最新、版表が新しいは更新あり (新しい版を添える)', () => {
    expect(pluginUpdateOf(bundled('aios.text', '1.0.0'), released)).toEqual({ state: 'up-to-date', latest: '1.0.0' })
    expect(pluginUpdateOf(bundled('aios.text', '1.0.1'), released)).toEqual({ state: 'up-to-date', latest: '1.0.0' })
    expect(pluginUpdateOf(bundled('aios.gmail', '1.1.0'), released)).toEqual({ state: 'available', latest: '1.2.0', installable: false })
  })

  it('確認できない理由: 利用者が入れた / 版表に無い / 版が読めない', () => {
    const reason = (plugin: { id: string; version: string; bundled: boolean }, state: PluginReleaseState = released) => {
      const info = pluginUpdateOf(plugin, state)
      return info.state === 'unknown' ? info.reason : info.state
    }
    // An extension the user installed is not matched, even if the version table has the same id (its source is not aios's Release).
    expect(reason({ id: 'aios.text', version: '0.1.0', bundled: false })).toBe('not-bundled')
    expect(reason(bundled('aios.gone', '1.0.0'))).toBe('not-listed')
    expect(reason(bundled('aios.odd', '1.0.0'))).toBe('invalid-version')
    expect(reason(bundled('aios.text', 'dev'))).toBe('invalid-version')
  })

  it('確認できない理由: 本体の自動更新が動かない形 (理由を添える) / まだ / 取れなかった (理由コード) / 版表の無い Release', () => {
    const plugin = bundled('aios.text', '1.0.0')
    expect(pluginUpdateOf(plugin, { kind: 'unsupported', reason: 'dev-shell' })).toEqual({
      state: 'unknown',
      reason: 'unsupported',
      updateUnsupported: 'dev-shell',
      failure: null
    })
    expect(pluginUpdateOf(plugin, { kind: 'not-checked' })).toMatchObject({ state: 'unknown', reason: 'not-checked' })
    expect(pluginUpdateOf(plugin, { kind: 'failed', failure: 'update-gh-missing' })).toEqual({
      state: 'unknown',
      reason: 'check-failed',
      updateUnsupported: null,
      failure: 'update-gh-missing'
    })
    expect(pluginUpdateOf(plugin, { kind: 'no-table', tag: 'v0.71.1' })).toMatchObject({ state: 'unknown', reason: 'no-table' })
  })
})

describe('PluginReleaseCatalog', () => {
  it('はじめは「まだ」。タグが引けたら版表を取り、変わったら知らせる', async () => {
    const changed = vi.fn()
    const catalog = new PluginReleaseCatalog(changed)
    expect(catalog.updateOf(bundled('aios.text', '1.0.0'))).toMatchObject({ reason: 'not-checked' })
    const fetch = vi.fn(async () => table({ 'aios.text': '1.1.0' }))
    await catalog.releaseChecked({ tag: 'v0.72.0' }, fetch)
    expect(fetch).toHaveBeenCalledWith('v0.72.0')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(catalog.updateOf(bundled('aios.text', '1.0.0'))).toEqual({ state: 'available', latest: '1.1.0', installable: false })
  })

  it('同じタグは取り直さない (6 時間ごとの確認で資産を落とし直さない)。新しいタグは取る', async () => {
    const catalog = new PluginReleaseCatalog(() => undefined)
    const fetch = vi.fn(async (tag: string) => (tag === 'v0.72.0' ? table({ 'aios.text': '1.0.0' }) : null))
    await catalog.releaseChecked({ tag: 'v0.72.0' }, fetch)
    await catalog.releaseChecked({ tag: 'v0.72.0' }, fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    // A Release with no version table is not re-fetched if it has the same tag.
    await catalog.releaseChecked({ tag: 'v0.73.0' }, fetch)
    await catalog.releaseChecked({ tag: 'v0.73.0' }, fetch)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(catalog.current()).toEqual({ kind: 'no-table', tag: 'v0.73.0' })
  })

  it('確認の失敗: 前に読めた版表は残し、無ければ理由コード付きの「確認できない」', async () => {
    const fresh = new PluginReleaseCatalog(() => undefined)
    await fresh.releaseChecked({ failure: 'update-gh-auth' }, vi.fn())
    expect(fresh.updateOf(bundled('aios.text', '1.0.0'))).toMatchObject({ reason: 'check-failed', failure: 'update-gh-auth' })

    const known = new PluginReleaseCatalog(() => undefined)
    await known.releaseChecked({ tag: 'v0.72.0' }, async () => table({ 'aios.text': '1.0.0' }))
    await known.releaseChecked({ failure: 'update-check-failed' }, vi.fn())
    expect(known.updateOf(bundled('aios.text', '1.0.0'))).toEqual({ state: 'up-to-date', latest: '1.0.0' })
    // A failure to fetch the version table itself is the same (the previous version table is kept).
    await known.releaseChecked({ tag: 'v0.73.0' }, async () => {
      throw reasonError('update-checksum-mismatch')
    })
    expect(known.current()).toMatchObject({ kind: 'table', tag: 'v0.72.0' })

    const broken = new PluginReleaseCatalog(() => undefined)
    await broken.releaseChecked({ tag: 'v0.72.0' }, async () => {
      throw reasonError('update-checksum-mismatch')
    })
    expect(broken.current()).toEqual({ kind: 'failed', failure: 'update-checksum-mismatch' })
  })

  it('動かない形では以後なにも取らない', async () => {
    const catalog = new PluginReleaseCatalog(() => undefined)
    catalog.setUnsupported('instance')
    const fetch = vi.fn(async () => table({}))
    await catalog.releaseChecked({ tag: 'v0.72.0' }, fetch)
    expect(fetch).not.toHaveBeenCalled()
    expect(catalog.updateOf(bundled('aios.text', '1.0.0'))).toMatchObject({ reason: 'unsupported', updateUnsupported: 'instance' })
  })

  it('取っている間に次の確認が来たら、古い取得の結果は捨てる', async () => {
    const catalog = new PluginReleaseCatalog(() => undefined)
    let release: (value: PluginVersionTable) => void = () => undefined
    const slow = catalog.releaseChecked({ tag: 'v0.72.0' }, () => new Promise((resolve) => (release = resolve)))
    await catalog.releaseChecked({ tag: 'v0.73.0' }, async () => table({ 'aios.text': '2.0.0' }, '0.73.0'))
    release(table({ 'aios.text': '1.0.0' }))
    await slow
    expect(catalog.current()).toMatchObject({ kind: 'table', tag: 'v0.73.0' })
  })

  it('同じタグの取得が走っている間の再要求は取り直さず、走っているものを待つ (第 72 波 review)', async () => {
    const changed = vi.fn()
    const catalog = new PluginReleaseCatalog(changed)
    let release: (value: PluginVersionTable) => void = () => undefined
    const fetch = vi.fn(() => new Promise<PluginVersionTable>((resolve) => (release = resolve)))
    const first = catalog.releaseChecked({ tag: 'v0.72.0' }, fetch)
    const second = catalog.releaseChecked({ tag: 'v0.72.0' }, fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    release(table({ 'aios.text': '1.1.0' }))
    await Promise.all([first, second])
    expect(catalog.current()).toMatchObject({ kind: 'table', tag: 'v0.72.0' })
    expect(changed).toHaveBeenCalledTimes(1)
    // After a fetch has finished, it is not re-fetched (it holds the table).
    await catalog.releaseChecked({ tag: 'v0.72.0' }, fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('取っている間に確認の失敗が来ても、走っている取得の結果は捨てない (成功すれば表を採る)', async () => {
    const catalog = new PluginReleaseCatalog(() => undefined)
    let release: (value: PluginVersionTable) => void = () => undefined
    const slow = catalog.releaseChecked({ tag: 'v0.72.0' }, () => new Promise((resolve) => (release = resolve)))
    await catalog.releaseChecked({ failure: 'update-gh-auth' }, vi.fn())
    expect(catalog.current()).toEqual({ kind: 'failed', failure: 'update-gh-auth' })
    release(table({ 'aios.text': '1.0.0' }))
    await slow
    expect(catalog.current()).toMatchObject({ kind: 'table', tag: 'v0.72.0' })
  })

  it('同じ理由の失敗が続いても知らせ直さない (全窓へ一覧を押し直さない)。理由が変われば知らせる', async () => {
    const changed = vi.fn()
    const catalog = new PluginReleaseCatalog(changed)
    await catalog.releaseChecked({ failure: 'update-gh-auth' }, vi.fn())
    await catalog.releaseChecked({ failure: 'update-gh-auth' }, vi.fn())
    expect(changed).toHaveBeenCalledTimes(1)
    // A failure to fetch the version table (a new object each time) is the same.
    const broken = async (): Promise<PluginVersionTable> => {
      throw reasonError('update-checksum-mismatch')
    }
    await catalog.releaseChecked({ tag: 'v0.72.0' }, broken)
    expect(changed).toHaveBeenCalledTimes(2)
    await catalog.releaseChecked({ tag: 'v0.72.0' }, broken)
    expect(changed).toHaveBeenCalledTimes(2)
    await catalog.releaseChecked({ failure: 'update-check-failed' }, vi.fn())
    expect(changed).toHaveBeenCalledTimes(3)
  })
})

describe('版表を取る (fetchPluginVersionTable)', () => {
  /** A fake ReleaseSource that writes `files` into `dir` (following gh's "fetch only the matching assets": names that do not exist are skipped). */
  function fakeSource(files: Record<string, string>): ReleaseSource & { readonly asked: string[][] } {
    const asked: string[][] = []
    return {
      asked,
      latestTag: async () => 'v0.72.0',
      download: async (_tag, names, dir) => {
        asked.push([...names])
        for (const name of names) if (files[name] !== undefined) writeFileSync(join(dir, name), files[name] ?? '')
      }
    }
  }
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
  const workDir = (): string => mkdtempSync(join(tmpdir(), 'aios-test-plugin-versions-'))

  it('plugins.json と SHA256SUMS を頼み、値が合えば読む。一時ディレクトリは消す', async () => {
    const body = pluginVersionTableText(pluginVersionTable({ version: '0.72.0', manifests: [{ id: 'aios.text', version: '1.0.0' }] }))
    const source = fakeSource({ 'plugins.json': body, SHA256SUMS: `${sha(body)}  plugins.json\n${'a'.repeat(64)}  aios.zip\n` })
    let dir = ''
    const result = await fetchPluginVersionTable(source, 'v0.72.0', () => (dir = workDir()))
    expect(source.asked).toEqual([['plugins.json', 'SHA256SUMS']])
    expect(result).toEqual(table({ 'aios.text': '1.0.0' }))
    expect(existsSync(dir)).toBe(false)
  })

  it('版表の無い Release (版表を足す前) は null', async () => {
    const source = fakeSource({ SHA256SUMS: `${'a'.repeat(64)}  aios.zip\n` })
    expect(await fetchPluginVersionTable(source, 'v0.71.1', workDir)).toBeNull()
  })

  it('SHA256SUMS に無い・値が違うは update-checksum-mismatch、壊れた JSON は update-check-failed、取得の失敗はその理由', async () => {
    const body = '{"format":1,"aios":"0.72.0","plugins":{}}\n'
    expect(await reasonOf(fetchPluginVersionTable(fakeSource({ 'plugins.json': body, SHA256SUMS: '' }), 'v1.0.0', workDir))).toBe(
      'update-checksum-mismatch'
    )
    expect(
      await reasonOf(
        fetchPluginVersionTable(fakeSource({ 'plugins.json': body, SHA256SUMS: `${sha('x')}  plugins.json\n` }), 'v1.0.0', workDir)
      )
    ).toBe('update-checksum-mismatch')
    const broken = '{"format":1,'
    expect(
      await reasonOf(
        fetchPluginVersionTable(fakeSource({ 'plugins.json': broken, SHA256SUMS: `${sha(broken)}  plugins.json\n` }), 'v1.0.0', workDir)
      )
    ).toBe('update-check-failed')
    const failing: ReleaseSource = {
      latestTag: async () => 'v1.0.0',
      download: async () => {
        throw reasonError('update-gh-auth')
      }
    }
    expect(await reasonOf(fetchPluginVersionTable(failing, 'v1.0.0', workDir))).toBe('update-gh-auth')
  })
})

describe('UpdateService が確認の結果を渡す (onReleaseChecked)', () => {
  const settings = {
    readTyped<T>(def: SettingKey<T>): T {
      return def.parse(null)
    },
    writeTyped(): void {}
  }
  function service(latestTag: () => Promise<string>, onReleaseChecked: (result: unknown) => void): UpdateService {
    return new UpdateService({
      settings,
      currentVersion: '0.72.0',
      detection: {
        kind: 'versioned',
        layout: { root: '/r', versionsDir: '/r/versions', link: '/A/aios.app', repo: 'o/r', runningVersion: '0.72.0' }
      },
      latestTag,
      stage: async () => ({ reused: false }),
      linkedVersion: () => '0.72.0',
      swapLink: () => undefined,
      prune: () => [],
      restartBlocker: () => null,
      systemIdleSeconds: () => 0,
      closing: () => false,
      relaunch: () => undefined,
      onChanged: () => undefined,
      onReleaseChecked,
      schedule: () => () => undefined
    })
  }

  it('タグが引けたらタグ、引けなければ理由コード', async () => {
    const ok = vi.fn()
    await service(async () => 'v0.72.0', ok).check()
    expect(ok).toHaveBeenCalledWith({ tag: 'v0.72.0' })
    const failed = vi.fn()
    await service(async () => {
      throw reasonError('update-gh-missing')
    }, failed).check()
    expect(failed).toHaveBeenCalledWith({ failure: 'update-gh-missing' })
  })
})

describe('npm run release の版表 (scripts/release-config.mjs)', () => {
  it('資産の名前と形の番号は shared と同じで、資産に含まれ、SHA256SUMS より前に並ぶ', () => {
    expect(RELEASE_ASSET).toBe(PLUGIN_VERSIONS_ASSET)
    expect(RELEASE_FORMAT).toBe(PLUGIN_VERSIONS_FORMAT)
    const assets = releaseAssets('0.72.0') as string[]
    expect(assets).toContain(PLUGIN_VERSIONS_ASSET)
    expect(assets.indexOf(PLUGIN_VERSIONS_ASSET)).toBeLessThan(assets.indexOf('SHA256SUMS'))
  })

  it('manifest から id の順の版表を作り、aios がそのまま読める。id の重複・版の欠けは止める', () => {
    const built = pluginVersionTable({
      version: '0.72.0',
      manifests: [
        { id: 'aios.text', version: '1.0.0' },
        { id: 'aios.gmail', version: '1.1.0' }
      ]
    })
    const text = pluginVersionTableText(built) as string
    expect(text.endsWith('\n')).toBe(true)
    expect(Object.keys(built.plugins)).toEqual(['aios.gmail', 'aios.text'])
    expect(parsePluginVersionTable(JSON.parse(text))).toEqual(table({ 'aios.gmail': '1.1.0', 'aios.text': '1.0.0' }))
    expect(() =>
      pluginVersionTable({ version: '0.72.0', manifests: [{ id: 'aios.text', version: '1.0.0' }, { id: 'aios.text', version: '1.0.1' }] })
    ).toThrow()
    expect(() => pluginVersionTable({ version: '0.72.0', manifests: [{ id: 'aios.text' }] })).toThrow()
  })
})
