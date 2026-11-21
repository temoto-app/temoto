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

describe('per-extension assets of release (scripts/release-config.mjs)', () => {
  it('the asset name is the same as in shared; the version table row has asset and sha256, and aios reads it as installable (format stays 1)', () => {
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

  it('a stage 1 row (no asset), a row with only one of them, and a name containing a separator are read as "rows that cannot be updated" (the row is not dropped)', () => {
    const read = (entry: Record<string, unknown>) =>
      parsePluginVersionTable({ format: 1, aios: '0.73.0', plugins: { 'aios.text': entry } })?.plugins['aios.text']
    expect(read({ version: '1.2.0' })).toEqual({ version: '1.2.0' })
    expect(read({ version: '1.2.0', asset: 'plugin-aios.text-1.2.0.zip' })).toEqual({ version: '1.2.0' })
    expect(read({ version: '1.2.0', asset: '../x.zip', sha256: 'a'.repeat(64) })).toEqual({ version: '1.2.0' })
    expect(read({ version: '1.2.0', asset: 'a/b.zip', sha256: 'a'.repeat(64) })).toEqual({ version: '1.2.0' })
    expect(read({ version: '1.2.0', asset: 'p.zip', sha256: 'A'.repeat(64) })).toEqual({ version: '1.2.0' })
  })

  it('collectPluginFiles stops when it finds a symlink (the aios extraction does not accept symlinks)', () => {
    const src = join(dir, 'with-link')
    writePlugin(src, 'aios.text', '1.0.0')
    symlinkSync('/etc/hosts', join(src, 'viewer', 'hosts'))
    expect(() => collectPluginFiles(src)).toThrow()
  })

  it('the main extraction reads the release zip and the content comes back unchanged', async () => {
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

describe('extraction (extractPluginZip) rejects a crafted zip', () => {
  it('wave 73 review: I/O uses fs/promises (no synchronous reads or writes; synchronous only for parsing headers in memory)', () => {
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

  it('name stage: rejects ../, absolute paths, \\, drive names, empty segments, and .', () => {
    for (const bad of ['../evil', 'a/../../evil', '/etc/x', 'a\\b', 'C:/x', 'a//b', './a', 'a/./b', '', 'a\0b']) {
      expect(safeEntrySegments(bad), bad).toBeNull()
    }
    expect(safeEntrySegments('viewer/index.html')).toEqual(['viewer', 'index.html'])
    expect(safeEntrySegments('viewer/')).toEqual(['viewer'])
  })

  it('entries with ../ and absolute paths give plugin-update-invalid without writing anything outside the extraction', async () => {
    const escape = await extract({ 'manifest.json': data, '../evil.txt': data })
    expect(escape.code).toBe('plugin-update-invalid')
    expect(existsSync(join(escape.dest, '..', 'evil.txt'))).toBe(false)
    const absolute = await extract({ '/tmp/aios-evil.txt': data })
    expect(absolute.code).toBe('plugin-update-invalid')
  })

  it('rejects a symlink entry (Unix mode S_IFLNK)', async () => {
    const link = await extract({ 'manifest.json': data, 'viewer/link': [new TextEncoder().encode('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] })
    expect(link.code).toBe('plugin-update-invalid')
    expect(existsSync(join(link.dest, 'viewer', 'link'))).toBe(false)
  })

  it('rejects names equal after case folding, sizes over the limit, and too many entries', async () => {
    expect((await extract({ 'Manifest.json': data, 'manifest.json': data })).code).toBe('plugin-update-invalid')
    expect((await extract({ 'big.bin': new Uint8Array(4096) }, { maxEntryBytes: 1024 })).code).toBe('plugin-update-invalid')
    expect((await extract({ a: data, b: data, c: data }, { maxEntries: 2 })).code).toBe('plugin-update-invalid')
  })

  it('rejects a non-zip and broken content (CRC mismatch)', async () => {
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

describe('store (UpdatedPluginStore)', () => {
  function staged(store: UpdatedPluginStore, id: string, version: string, body?: string): string {
    const staging = store.createStaging()
    const bundle = join(staging, 'bundle')
    writePlugin(bundle, id, version, body)
    return bundle
  }

  it('a placed version is read only when the record and digest match and it is larger than the bundled one', () => {
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    const placed = store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0'))
    expect(placed).toBe(join(dir, 'updates', 'aios.text', '1.2.0'))
    expect(records.value['aios.text']).toEqual({ version: '1.2.0', digest: treeDigest(placed) })
    expect(store.resolve('aios.text', '1.0.0')).toEqual({ dir: placed, version: '1.2.0' })
    // An id with no record is not read either.
    expect(store.resolve('aios.markdown', '1.0.0')).toBeNull()
  })

  it('a version that was rewritten (digest mismatch) or is not in the record is not read', () => {
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    const placed = store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0'))
    writeFileSync(join(placed, 'viewer', 'index.html'), '<script>evil()</script>')
    expect(store.resolve('aios.text', '1.0.0')).toBeNull()
    // A directory placed from outside (no record) is not read either.
    writePlugin(join(dir, 'updates', 'aios.markdown', '9.0.0'), 'aios.markdown', '9.0.0')
    expect(store.resolve('aios.markdown', '1.0.0')).toBeNull()
  })

  it('wave 73 review: resolve removes the store of an id not in the record and any directory other than the recorded version (orphans, old versions, half-written)', () => {
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

  it('wave 73 review: the resolver reads the record only once, and the digest check is cached for the process lifetime per (id, version)', () => {
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

  it('when the bundled one overtakes (catches up with) the store after an app update, it removes the store and the record and returns to the bundled one', () => {
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0'))
    expect(store.resolve('aios.text', '1.2.0')).toBeNull()
    expect(existsSync(join(dir, 'updates', 'aios.text'))).toBe(false)
    expect(records.value['aios.text']).toBeUndefined()
  })

  it('removes old versions, keeping only the recorded version (the latest one)', () => {
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    store.install('aios.text', '1.1.0', staged(store, 'aios.text', '1.1.0'))
    store.install('aios.text', '1.2.0', staged(store, 'aios.text', '1.2.0'))
    expect(store.versionsOf('aios.text')).toEqual(['1.2.0', '1.1.0'])
    expect(store.prune('aios.text')).toEqual(['1.1.0'])
    expect(store.versionsOf('aios.text')).toEqual(['1.2.0'])
  })

  it('wave 73 review: the shape of a plugin id and x.y.z uses the single one in shared (PLUGIN_ID_RE / PLAIN_VERSION_RE) everywhere', async () => {
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

  it('the record is in a shape that fits in app_settings (`plugins.updated`) of the encrypted DB (a broken row is read and dropped)', () => {
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

describe('acceptance: updates only one extension (PluginReleaseCatalog -> store -> PluginHost)', () => {
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

  it('it is placed in the store and PluginHost reads the larger version; other extensions and the app (bundled, the Release app zip) are unchanged', async () => {
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

  it('shows "updating" during the update and redistributes the list when done', async () => {
    const ctx = await setup(releaseZip('aios.alpha', '1.1.0'))
    const running = ctx.update()
    expect(ctx.host.summaries().find((s) => s.id === 'aios.alpha')?.update).toEqual({ state: 'updating', latest: '1.1.0' })
    // A repeated request for the same id waits for the same end (not fetched twice).
    const again = ctx.update()
    await Promise.all([running, again])
    expect(ctx.asked).toHaveLength(1)
    expect(ctx.changed).toHaveBeenCalled()
  })

  it('a mismatch with SHA256SUMS or with the sha256 of the version table is a "failure" of update-checksum-mismatch, and the current version stays', async () => {
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

  it('also refuses when only the sha256 of the version table differs (it matches SHA256SUMS)', async () => {
    const ctx = await setup(releaseZip('aios.alpha', '1.1.0'), { tableSha: 'f'.repeat(64) })
    await ctx.update()
    expect(ctx.catalog.updateOf({ id: 'aios.alpha', version: '1.0.0', bundled: true })).toMatchObject({
      state: 'failed',
      failure: 'update-checksum-mismatch'
    })
    expect(ctx.versions()['aios.alpha']).toBe('1.0.0')
  })

  it('a zip with path escapes or a zip whose manifest id or version differs gives plugin-update-invalid and leaves nothing in the store', async () => {
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

  it('wave 73 review: PluginHost.load reads the store record only once (does not re-read per plugin)', async () => {
    const ctx = await setup(releaseZip('aios.alpha', '1.1.0'))
    await ctx.update()
    const read = vi.spyOn(ctx.records, 'read')
    ctx.host.load()
    expect(read).toHaveBeenCalledTimes(1)
    expect(ctx.versions()).toEqual({ 'aios.alpha': '1.1.0', 'aios.beta': '1.0.0' })
  })

  it('wave 73 review: a previous failure is not made a "failure" (update again) once the version table row is replaced by a row without an asset', async () => {
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

  it('cannot update (the version table has the same version, not bundled, or no version table) gives plugin-update-unavailable and does not start', async () => {
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

  it('stagePluginRelease runs the extracted manifest through the app validation (a broken manifest is plugin-update-invalid)', async () => {
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
