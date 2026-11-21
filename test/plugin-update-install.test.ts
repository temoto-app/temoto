/**
 * TODO 1144 stage 2 (wave 73 bundle C, ARCHITECTURE 8.5.1): "update" of one extension.
 *
 * - The per-extension zip from `npm run release` (`scripts/release-config.mjs`) can be read by main's extraction (`extractPluginZip`).
 * - `asset` / `sha256` in the version table row (the shape number stays 1) and `installable`.
 * - Extraction refuses path escapes (`../`, absolute paths, `\`), symlinks, duplicates that differ only in case, and zips that are too large or broken.
 * - The store (`UpdatedPluginStore`): reads only versions whose record (a fake for `plugins.updated` in the encrypted DB) and summary match; removes them when the bundled one overtakes them; removes old versions.
 * - Acceptance: `PluginReleaseCatalog.update` with fake assets → placed in the store, and `PluginHost` picks the larger version. Other extensions and the app version do not change. A SHA-256 mismatch or a path escape is refused, and the current version stays.
 *
 * Does not call gh, the network, or the model (ReleaseSource is a fake).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { collectPluginFiles, pluginAssetName as releaseAssetName, pluginBundleZip, pluginVersionTable } from '../scripts/release-config.mjs'
import { parsePluginVersionTable, pluginAssetName, pluginUpdateOf, type PluginVersionTable } from '../src/shared/plugin-update.js'
import { parseReason, reasonError } from '../src/shared/reason.js'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { PLUGIN_UPDATED_VERSIONS, type UpdatedPluginRecord } from '../src/common/settings-keys.js'
import { extractPluginZip, safeEntrySegments } from '../src/main/update/plugin-zip.js'
import { UpdatedPluginStore, treeDigest, type UpdatedPluginRecords } from '../src/main/plugin/updated-store.js'
import { installPluginRelease, stagePluginRelease } from '../src/main/update/plugin-install.js'
import { PluginReleaseCatalog } from '../src/main/update/plugin-versions.js'
import type { ReleaseSource } from '../src/main/update/release-source.js'
import type { CapabilityBroker } from '../src/main/capability/broker.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => ({}) } }))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-install-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (err) {
    return parseReason(err instanceof Error ? err.message : String(err))?.code
  }
}

/** Writes an extension's directory (manifest and one viewer file). */
function writePlugin(at: string, id: string, version: string, body = 'console.log(1)'): void {
  mkdirSync(join(at, 'viewer'), { recursive: true })
  writeFileSync(join(at, 'manifest.json'), JSON.stringify({ id, name: id, version, capabilities: {}, viewer: { entry: 'viewer/index.html', extensions: ['x'] } }))
  writeFileSync(join(at, 'viewer', 'index.html'), `<script>${body}</script>`)
}

/** A zip made the same way as release (`collectPluginFiles` → `pluginBundleZip`). */
function releaseZip(id: string, version: string, body?: string): Uint8Array {
  const src = mkdtempSync(join(dir, 'src-'))
  writePlugin(src, id, version, body)
  return pluginBundleZip(collectPluginFiles(src)) as Uint8Array
}

function memoryRecords(): UpdatedPluginRecords & { value: Record<string, UpdatedPluginRecord> } {
  const holder = {
    value: {} as Record<string, UpdatedPluginRecord>,
    read: () => holder.value,
    write: (next: Readonly<Record<string, UpdatedPluginRecord>>) => {
      holder.value = { ...next }
    }
  }
  return holder
}

describe('release の拡張機能ごとの資産 (scripts/release-config.mjs)', () => {
  it('資産の名前は shared と同じ。版表の行に asset と sha256 が入り、aios が installable として読む (format は 1 のまま)', () => {
    expect(releaseAssetName('aios.text', '1.2.0')).toBe(pluginAssetName('aios.text', '1.2.0'))
    const built = pluginVersionTable({
      version: '0.73.0',
      manifests: [{ id: 'aios.text', version: '1.2.0' }],
      assets: { 'aios.text': { asset: 'plugin-aios.text-1.2.0.zip', sha256: 'a'.repeat(64) } }
    })
    expect(built).toEqual({
      format: 1,
      aios: '0.73.0',
      plugins: { 'aios.text': { version: '1.2.0', asset: 'plugin-aios.text-1.2.0.zip', sha256: 'a'.repeat(64) } }
    })
    const table = parsePluginVersionTable(JSON.parse(JSON.stringify(built)))
    expect(table?.plugins['aios.text']).toEqual({ version: '1.2.0', asset: 'plugin-aios.text-1.2.0.zip', sha256: 'a'.repeat(64) })
    expect(pluginUpdateOf({ id: 'aios.text', version: '1.0.0', bundled: true }, { kind: 'table', tag: 'v0.73.0', table: table as PluginVersionTable })).toEqual({
      state: 'available',
      latest: '1.2.0',
      installable: true
    })
    // A missing asset, a wrong name, or a wrongly shaped SHA-256 makes release stop.
    expect(() => pluginVersionTable({ version: '0.73.0', manifests: [{ id: 'aios.text', version: '1.2.0' }], assets: {} })).toThrow()
    expect(() =>
      pluginVersionTable({
        version: '0.73.0',
        manifests: [{ id: 'aios.text', version: '1.2.0' }],
        assets: { 'aios.text': { asset: 'x.zip', sha256: 'a'.repeat(64) } }
      })
    ).toThrow()
  })

  it('段 1 の行 (資産なし)・片方だけ・区切りを含む名前は「更新できない行」として読む (行は捨てない)', () => {
    const read = (entry: Record<string, unknown>) =>
      parsePluginVersionTable({ format: 1, aios: '0.73.0', plugins: { 'aios.text': entry } })?.plugins['aios.text']
    expect(read({ version: '1.2.0' })).toEqual({ version: '1.2.0' })
    expect(read({ version: '1.2.0', asset: 'plugin-aios.text-1.2.0.zip' })).toEqual({ version: '1.2.0' })
    expect(read({ version: '1.2.0', asset: '../x.zip', sha256: 'a'.repeat(64) })).toEqual({ version: '1.2.0' })
    expect(read({ version: '1.2.0', asset: 'a/b.zip', sha256: 'a'.repeat(64) })).toEqual({ version: '1.2.0' })
    expect(read({ version: '1.2.0', asset: 'p.zip', sha256: 'A'.repeat(64) })).toEqual({ version: '1.2.0' })
  })

  it('collectPluginFiles は symlink を見つけたら止める (aios の展開は symlink を受けない)', () => {
    const src = join(dir, 'with-link')
    writePlugin(src, 'aios.text', '1.0.0')
    symlinkSync('/etc/hosts', join(src, 'viewer', 'hosts'))
    expect(() => collectPluginFiles(src)).toThrow()
  })

  it('release の zip を main の展開が読み、中身がそのまま戻る', async () => {
    const zip = releaseZip('aios.text', '1.2.0', 'hello')
    const zipPath = join(dir, 'p.zip')
    writeFileSync(zipPath, zip)
    const dest = join(dir, 'out')
    mkdirSync(dest)
    const written = await extractPluginZip(zipPath, dest)
    expect([...written].sort()).toEqual(['manifest.json', 'viewer/index.html'])
    expect(readFileSync(join(dest, 'viewer', 'index.html'), 'utf8')).toBe('<script>hello</script>')
  })
})

describe('展開 (extractPluginZip) は細工された zip を拒む', () => {
  it('第 73 波 review: I/O は fs/promises (同期の読み書きをしない。同期はメモリの上のヘッダの解析だけ)', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'main', 'update', 'plugin-zip.ts'), 'utf8')
    expect(source).toContain(`from 'node:fs/promises'`)
    expect(source).not.toMatch(/\b\w+Sync\(/)
  })

  async function extract(entries: Parameters<typeof zipSync>[0], limits = {}): Promise<{ code: string | undefined; dest: string }> {
    const zipPath = join(dir, `z-${Math.random().toString(36).slice(2)}.zip`)
    writeFileSync(zipPath, zipSync(entries))
    const dest = mkdtempSync(join(dir, 'dest-'))
    return { code: await reasonOf(extractPluginZip(zipPath, dest, limits)), dest }
  }
  const data = new Uint8Array([1, 2, 3])

  it('名前の段: ../ ・絶対パス・\\・ドライブ名・空の段・. を拒む', () => {
    for (const bad of ['../evil', 'a/../../evil', '/etc/x', 'a\\b', 'C:/x', 'a//b', './a', 'a/./b', '', 'a\0b']) {
      expect(safeEntrySegments(bad), bad).toBeNull()
    }
    expect(safeEntrySegments('viewer/index.html')).toEqual(['viewer', 'index.html'])
    expect(safeEntrySegments('viewer/')).toEqual(['viewer'])
  })

  it('../ と絶対パスの項目は展開の外に何も書かずに plugin-update-invalid', async () => {
    const escape = await extract({ 'manifest.json': data, '../evil.txt': data })
    expect(escape.code).toBe('plugin-update-invalid')
    expect(existsSync(join(escape.dest, '..', 'evil.txt'))).toBe(false)
    const absolute = await extract({ '/tmp/aios-evil.txt': data })
    expect(absolute.code).toBe('plugin-update-invalid')
  })

  it('symlink (Unix の mode が S_IFLNK) の項目を拒む', async () => {
    const link = await extract({ 'manifest.json': data, 'viewer/link': [new TextEncoder().encode('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] })
    expect(link.code).toBe('plugin-update-invalid')
    expect(existsSync(join(link.dest, 'viewer', 'link'))).toBe(false)
  })

  it('大小を畳んで同じ名前・上限を超える大きさ・項目の数は拒む', async () => {
    expect((await extract({ 'Manifest.json': data, 'manifest.json': data })).code).toBe('plugin-update-invalid')
    expect((await extract({ 'big.bin': new Uint8Array(4096) }, { maxEntryBytes: 1024 })).code).toBe('plugin-update-invalid')
    expect((await extract({ a: data, b: data, c: data }, { maxEntries: 2 })).code).toBe('plugin-update-invalid')
  })

  it('zip でない・壊れた中身 (CRC が合わない) は拒む', async () => {
    const notZip = join(dir, 'not.zip')
    writeFileSync(notZip, 'hello')
    expect(await reasonOf(extractPluginZip(notZip, mkdtempSync(join(dir, 'd-'))))).toBe('plugin-update-invalid')
    const good = Buffer.from(zipSync({ 'a.txt': [new Uint8Array(64).fill(65), { level: 0 }] }))
    // Change one byte of the stored contents (the CRC no longer matches).
    const at = good.indexOf(Buffer.from('AAAA'))
    good[at] = 66
    const broken = join(dir, 'broken.zip')
    writeFileSync(broken, good)
    expect(await reasonOf(extractPluginZip(broken, mkdtempSync(join(dir, 'd-'))))).toBe('plugin-update-invalid')
  })
})

describe('置き場 (UpdatedPluginStore)', () => {
  function staged(store: UpdatedPluginStore, id: string, version: string, body?: string): string {
    const staging = store.createStaging()
    const bundle = join(staging, 'bundle')
    writePlugin(bundle, id, version, body)
    return bundle
  }

  it('置いた版は記録と要約が合えば、同梱より大きいときだけ読む', () => {
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    const placed = store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0'))
    expect(placed).toBe(join(dir, 'updates', 'aios.text', '1.2.0'))
    expect(records.value['aios.text']).toEqual({ version: '1.2.0', digest: treeDigest(placed) })
    expect(store.resolve('aios.text', '1.0.0')).toEqual({ dir: placed, version: '1.2.0' })
    // An id with no record is not read either.
    expect(store.resolve('aios.markdown', '1.0.0')).toBeNull()
  })

  it('書き換えられた (要約が合わない)・記録に無い版は読まない', () => {
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    const placed = store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0'))
    writeFileSync(join(placed, 'viewer', 'index.html'), '<script>evil()</script>')
    expect(store.resolve('aios.text', '1.0.0')).toBeNull()
    // A directory placed from outside (no record) is not read either.
    writePlugin(join(dir, 'updates', 'aios.markdown', '9.0.0'), 'aios.markdown', '9.0.0')
    expect(store.resolve('aios.markdown', '1.0.0')).toBeNull()
  })

  it('第 73 波 review: 記録に無い id の置き場・記録の版以外のディレクトリ (孤児・古い版・書きかけ) は resolve が消す', () => {
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    const placed = store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0'))
    // A version that failed midway through install (the record stays at 1.2.0), older versions at or below the bundled one, and an unfinished one with no manifest.
    writePlugin(join(dir, 'updates', 'aios.text', '1.3.0'), 'aios.text', '1.3.0')
    writePlugin(join(dir, 'updates', 'aios.text', '0.9.0'), 'aios.text', '0.9.0')
    mkdirSync(join(dir, 'updates', 'aios.text', '1.4.0'))
    // An id with no record (placed from outside, or failed before the record was written). Removed even if larger than the bundled one.
    writePlugin(join(dir, 'updates', 'aios.markdown', '9.0.0'), 'aios.markdown', '9.0.0')
    const resolve = store.resolver()
    expect(resolve('aios.text', '1.0.0')).toEqual({ dir: placed, version: '1.2.0' })
    expect(readdirSync(join(dir, 'updates', 'aios.text'))).toEqual(['1.2.0'])
    expect(resolve('aios.markdown', '1.0.0')).toBeNull()
    expect(existsSync(join(dir, 'updates', 'aios.markdown'))).toBe(false)
    expect(records.value).toEqual({ 'aios.text': { version: '1.2.0', digest: treeDigest(placed) } })
  })

  it('第 73 波 review: resolver は記録を 1 回だけ読み、要約の検めは (id, 版) ごとにプロセスの寿命でキャッシュする', () => {
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    const text = store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0'))
    store.install('aios.markdown', '2.0.0', staged(store, 'aios.markdown', '2.0.0'))
    const read = vi.spyOn(records, 'read')
    const resolve = store.resolver()
    expect(resolve('aios.text', '1.0.0')?.version).toBe('1.2.0')
    expect(resolve('aios.markdown', '1.0.0')?.version).toBe('2.0.0')
    expect(resolve('aios.image', '1.0.0')).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
    // A version already verified is not hashed again (a rewrite is not noticed within the same process — the trade-off in the note at the top).
    writeFileSync(join(text, 'viewer', 'index.html'), '<script>changed()</script>')
    expect(store.resolve('aios.text', '1.0.0')?.version).toBe('1.2.0')
    // At the next launch (a new process = a new store) it is verified again before it is read.
    expect(new UpdatedPluginStore(join(dir, 'updates'), records).resolve('aios.text', '1.0.0')).toBeNull()
    // Placing the same version again forgets the cache and verifies the new contents.
    const again = store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0', 'v2'))
    expect(store.resolve('aios.text', '1.0.0')).toEqual({ dir: again, version: '1.2.0' })
    writeFileSync(join(again, 'viewer', 'index.html'), '<script>changed()</script>')
    expect(new UpdatedPluginStore(join(dir, 'updates'), records).resolve('aios.text', '1.0.0')).toBeNull()
  })

  it('本体の更新で同梱が追い越した (並んだ) ら、置き場と記録を消して同梱に戻る', () => {
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0'))
    expect(store.resolve('aios.text', '1.2.0')).toBeNull()
    expect(existsSync(join(dir, 'updates', 'aios.text'))).toBe(false)
    expect(records.value['aios.text']).toBeUndefined()
  })

  it('古い版は記録の版 (直近 1 つ) だけを残して消す', () => {
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    store.install('aios.text', '1.1.0', staged(store, 'aios.text', '1.1.0'))
    store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0'))
    expect(store.versionsOf('aios.text')).toEqual(['1.2.0', '1.1.0'])
    expect(store.prune('aios.text')).toEqual(['1.1.0'])
    expect(store.versionsOf('aios.text')).toEqual(['1.2.0'])
  })

  it('第 73 波 review: plugin の id と x.y.z の形は shared の 1 つ (PLUGIN_ID_RE / PLAIN_VERSION_RE) を全部で使う', async () => {
    const { PLUGIN_ID_RE } = await import('../src/shared/plugin.js')
    const { PLAIN_VERSION_RE } = await import('../src/shared/update.js')
    expect(['aios.text', 'aios.my-ext', 'com.example.x1'].every((id) => PLUGIN_ID_RE.test(id))).toBe(true)
    expect(['aios', 'Aios.text', '../x', 'aios.text/x', 'aios..text', '1aios.text'].some((id) => PLUGIN_ID_RE.test(id))).toBe(false)
    expect(PLAIN_VERSION_RE.test('0.73.0')).toBe(true)
    expect(['v0.73.0', '0.73', '0.73.0-beta', '1234567.0.0'].some((v) => PLAIN_VERSION_RE.test(v))).toBe(false)
    const root = join(import.meta.dirname, '..')
    for (const file of [
      'src/main/plugin/manifest.ts',
      'src/main/plugin/updated-store.ts',
      'src/common/settings-keys.ts',
      'src/main/update/layout.ts',
      'src/main/session/adapter/self-update.ts'
    ]) {
      const text = readFileSync(join(root, file), 'utf8')
      expect(text, file).not.toContain('[a-z][a-z0-9]*(\\.[a-z0-9-]+)+')
      expect(text, file).not.toContain('\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}$/')
    }
  })

  it('記録は暗号化 DB の app_settings (`plugins.updated`) に置ける形 (壊れた行は読み捨てる)', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const settings = new AppSettingsStore(db)
    settings.writeTyped(PLUGIN_UPDATED_VERSIONS, { 'aios.text': { version: '1.2.0', digest: 'b'.repeat(64) } })
    expect(settings.readTyped(PLUGIN_UPDATED_VERSIONS)).toEqual({ 'aios.text': { version: '1.2.0', digest: 'b'.repeat(64) } })
    settings.write('plugins.updated', JSON.stringify({ 'aios.text': { version: 'x', digest: 'b'.repeat(64) }, '../x': { version: '1.0.0', digest: 'b'.repeat(64) } }))
    expect(settings.readTyped(PLUGIN_UPDATED_VERSIONS)).toEqual({})
    db.close()
  })
})

describe('受け入れ条件: 1 つの拡張機能だけを更新する (PluginReleaseCatalog → 置き場 → PluginHost)', () => {
  let db: Db

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    writePlugin(join(dir, 'bundled', 'aios.alpha'), 'aios.alpha', '1.0.0')
    writePlugin(join(dir, 'bundled', 'aios.beta'), 'aios.beta', '1.0.0')
  })

  afterEach(() => {
    db.close()
  })

  async function setup(assetBytes: Uint8Array, options: { sums?: string; tableSha?: string } = {}) {
    const asset = pluginAssetName('aios.alpha', '1.1.0')
    const assetSha = sha(assetBytes)
    const asked: string[][] = []
    const source: ReleaseSource = {
      latestTag: async () => 'v0.73.0',
      download: async (_tag, names, into) => {
        asked.push([...names])
        for (const name of names) {
          if (name === asset) writeFileSync(join(into, name), assetBytes)
          if (name === 'SHA256SUMS') writeFileSync(join(into, name), options.sums ?? `${assetSha}  ${asset}\n${'c'.repeat(64)}  aios-0.73.0-arm64-mac.zip\n`)
        }
      }
    }
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    const { PluginHost } = await import('../src/main/plugin/host.js')
    const changed = vi.fn()
    const catalog = new PluginReleaseCatalog(changed)
    const host = new PluginHost({
      db,
      bundledDir: join(dir, 'bundled'),
      userDir: join(dir, 'user'),
      hostEntry: join(dir, 'host-entry', 'plugin-host.js'),
      broker: () => ({}) as unknown as CapabilityBroker,
      onChanged: () => undefined,
      pluginUpdate: (plugin) => catalog.updateOf(plugin),
      updated: store
    })
    host.load()
    const table: PluginVersionTable = {
      format: 1,
      aios: '0.73.0',
      plugins: {
        'aios.alpha': { version: '1.1.0', asset, sha256: options.tableSha ?? assetSha },
        'aios.beta': { version: '1.0.0', asset: pluginAssetName('aios.beta', '1.0.0'), sha256: 'd'.repeat(64) }
      }
    }
    await catalog.releaseChecked({ tag: 'v0.73.0' }, async () => table)
    const versions = () => Object.fromEntries(host.summaries().map((s) => [s.id, s.version]))
    const update = () => {
      const alpha = host.summaries().find((s) => s.id === 'aios.alpha')
      if (alpha === undefined) throw new Error('no alpha')
      return catalog.update(alpha, (tag, id, entry) => installPluginRelease({ source, store, host }, tag, id, entry))
    }
    return { host, catalog, store, records, asked, versions, update, changed }
  }

  it('置き場に置かれ、PluginHost が大きい版を読む。他の拡張機能と本体 (同梱・Release の本体の zip) は変わらない', async () => {
    const ctx = await setup(releaseZip('aios.alpha', '1.1.0', 'new'))
    expect(ctx.host.summaries().find((s) => s.id === 'aios.alpha')?.update).toEqual({ state: 'available', latest: '1.1.0', installable: true })
    expect(ctx.versions()).toEqual({ 'aios.alpha': '1.0.0', 'aios.beta': '1.0.0' })
    await ctx.update()
    expect(ctx.versions()).toEqual({ 'aios.alpha': '1.1.0', 'aios.beta': '1.0.0' })
    expect(ctx.host.directoryOf('aios.alpha')).toBe(join(dir, 'updates', 'aios.alpha', '1.1.0'))
    expect(ctx.host.directoryOf('aios.beta')).toBe(join(dir, 'bundled', 'aios.beta'))
    expect(ctx.host.isBundled('aios.alpha')).toBe(true)
    expect(ctx.catalog.updateOf({ id: 'aios.alpha', version: '1.1.0', bundled: true })).toEqual({ state: 'up-to-date', latest: '1.1.0' })
    // Only that extension's asset and SHA256SUMS are fetched (the app's zip is not). The bundled copy is not rewritten.
    expect(ctx.asked).toEqual([[pluginAssetName('aios.alpha', '1.1.0'), 'SHA256SUMS']])
    expect(JSON.parse(readFileSync(join(dir, 'bundled', 'aios.alpha', 'manifest.json'), 'utf8')).version).toBe('1.0.0')
    // A partial fetch does not remain.
    expect(readdirSync(join(dir, 'updates')).filter((name) => name.startsWith('.staging-'))).toEqual([])
    // Even at the next load (re-read), the larger version is chosen.
    ctx.host.load()
    expect(ctx.versions()).toEqual({ 'aios.alpha': '1.1.0', 'aios.beta': '1.0.0' })
  })

  it('更新の間は「更新中」、終われば一覧を配り直す', async () => {
    const ctx = await setup(releaseZip('aios.alpha', '1.1.0'))
    const running = ctx.update()
    expect(ctx.host.summaries().find((s) => s.id === 'aios.alpha')?.update).toEqual({ state: 'updating', latest: '1.1.0' })
    // A repeated request for the same id waits for the same end (not fetched twice).
    const again = ctx.update()
    await Promise.all([running, again])
    expect(ctx.asked).toHaveLength(1)
    expect(ctx.changed).toHaveBeenCalled()
  })

  it('SHA256SUMS と合わない・版表の sha256 と合わないは update-checksum-mismatch の「失敗」で、いまの版のまま', async () => {
    const zip = releaseZip('aios.alpha', '1.1.0')
    const bySums = await setup(zip, { sums: `${'e'.repeat(64)}  ${pluginAssetName('aios.alpha', '1.1.0')}\n` })
    await bySums.update()
    expect(bySums.host.summaries().find((s) => s.id === 'aios.alpha')?.update).toEqual({
      state: 'failed',
      latest: '1.1.0',
      failure: 'update-checksum-mismatch'
    })
    expect(bySums.versions()).toEqual({ 'aios.alpha': '1.0.0', 'aios.beta': '1.0.0' })
    expect(bySums.store.versionsOf('aios.alpha')).toEqual([])
    expect(bySums.records.value).toEqual({})
  })

  it('版表の sha256 だけが違う (SHA256SUMS とは合う) も拒む', async () => {
    const ctx = await setup(releaseZip('aios.alpha', '1.1.0'), { tableSha: 'f'.repeat(64) })
    await ctx.update()
    expect(ctx.catalog.updateOf({ id: 'aios.alpha', version: '1.0.0', bundled: true })).toMatchObject({
      state: 'failed',
      failure: 'update-checksum-mismatch'
    })
    expect(ctx.versions()['aios.alpha']).toBe('1.0.0')
  })

  it('パスの脱出を含む zip・manifest の id や版が違う zip は plugin-update-invalid で、置き場に何も残さない', async () => {
    const escape = zipSync({ 'manifest.json': new TextEncoder().encode('{}'), '../../escaped.txt': new Uint8Array([1]) })
    const ctx = await setup(escape)
    await ctx.update()
    expect(ctx.catalog.updateOf({ id: 'aios.alpha', version: '1.0.0', bundled: true })).toMatchObject({
      state: 'failed',
      failure: 'plugin-update-invalid'
    })
    expect(existsSync(join(dir, 'escaped.txt'))).toBe(false)
    expect(readdirSync(join(dir, 'updates'))).toEqual([])
    expect(ctx.versions()['aios.alpha']).toBe('1.0.0')

    db.close()
    db = new Database(':memory:')
    runMigrations(db)
    const wrongId = await setup(releaseZip('aios.beta', '1.1.0'))
    await wrongId.update()
    expect(wrongId.catalog.updateOf({ id: 'aios.alpha', version: '1.0.0', bundled: true })).toMatchObject({ failure: 'plugin-update-invalid' })
    expect(wrongId.versions()).toEqual({ 'aios.alpha': '1.0.0', 'aios.beta': '1.0.0' })
  })

  it('第 73 波 review: PluginHost.load は置き場の記録を 1 回だけ読む (plugin ごとに読み直さない)', async () => {
    const ctx = await setup(releaseZip('aios.alpha', '1.1.0'))
    await ctx.update()
    const read = vi.spyOn(ctx.records, 'read')
    ctx.host.load()
    expect(read).toHaveBeenCalledTimes(1)
    expect(ctx.versions()).toEqual({ 'aios.alpha': '1.1.0', 'aios.beta': '1.0.0' })
  })

  it('第 73 波 review: 前の失敗は、版表の行が資産の無い行に替わったら「失敗」(もう一度更新) にしない', async () => {
    const catalog = new PluginReleaseCatalog(() => undefined)
    const plugin = { id: 'aios.alpha', version: '1.0.0', bundled: true }
    await catalog.releaseChecked({ tag: 'v0.73.0' }, async () => ({
      format: 1,
      aios: '0.73.0',
      plugins: { 'aios.alpha': { version: '1.1.0', asset: 'plugin-aios.alpha-1.1.0.zip', sha256: 'a'.repeat(64) } }
    }))
    await catalog.update(plugin, async () => {
      throw reasonError('update-download-failed')
    })
    expect(catalog.updateOf(plugin)).toMatchObject({ state: 'failed', failure: 'update-download-failed' })
    await catalog.releaseChecked({ tag: 'v0.73.1' }, async () => ({ format: 1, aios: '0.73.1', plugins: { 'aios.alpha': { version: '1.1.0' } } }))
    expect(catalog.updateOf(plugin)).toEqual({ state: 'available', latest: '1.1.0', installable: false })
  })

  it('更新できない (版表が同じ版・同梱でない・版表が無い) は plugin-update-unavailable で始めない', async () => {
    const catalog = new PluginReleaseCatalog(() => undefined)
    const install = vi.fn(async () => undefined)
    expect(await reasonOf(catalog.update({ id: 'aios.alpha', version: '1.0.0', bundled: true }, install))).toBe('plugin-update-unavailable')
    await catalog.releaseChecked({ tag: 'v0.73.0' }, async () => ({
      format: 1,
      aios: '0.73.0',
      plugins: { 'aios.alpha': { version: '1.0.0', asset: 'plugin-aios.alpha-1.0.0.zip', sha256: 'a'.repeat(64) }, 'aios.old': { version: '2.0.0' } }
    }))
    expect(await reasonOf(catalog.update({ id: 'aios.alpha', version: '1.0.0', bundled: true }, install))).toBe('plugin-update-unavailable')
    expect(await reasonOf(catalog.update({ id: 'aios.alpha', version: '0.9.0', bundled: false }, install))).toBe('plugin-update-unavailable')
    // A stage-1 row (no asset) cannot be updated even if an update exists.
    expect(await reasonOf(catalog.update({ id: 'aios.old', version: '1.0.0', bundled: true }, install))).toBe('plugin-update-unavailable')
    expect(install).not.toHaveBeenCalled()
    const unsupported = new PluginReleaseCatalog(() => undefined)
    unsupported.setUnsupported('dev')
    expect(await reasonOf(unsupported.update({ id: 'aios.alpha', version: '1.0.0', bundled: true }, install))).toBe('update-unsupported')
  })

  it('stagePluginRelease は展開した manifest を本体の検証に掛ける (壊れた manifest は plugin-update-invalid)', async () => {
    const broken = zipSync({ 'manifest.json': new TextEncoder().encode('{"id":"aios.alpha"}') })
    const asset = pluginAssetName('aios.alpha', '1.1.0')
    const source: ReleaseSource = {
      latestTag: async () => 'v0.73.0',
      download: async (_tag, names, into) => {
        for (const name of names) writeFileSync(join(into, name), name === asset ? broken : `${sha(broken)}  ${asset}\n`)
      }
    }
    const store = new UpdatedPluginStore(join(dir, 'updates'), memoryRecords())
    expect(
      await reasonOf(stagePluginRelease(source, store, 'v0.73.0', 'aios.alpha', { version: '1.1.0', asset, sha256: sha(broken) }))
    ).toBe('plugin-update-invalid')
  })
})
