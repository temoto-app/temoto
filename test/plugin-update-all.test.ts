/**
 * TODO 1144 stage 3 (wave 74 bundle B, ARCHITECTURE 8.5.1 "stage 3").
 *
 * - Bulk "update all" (`PluginReleaseCatalog.updateAll`): the updatable extensions go one at a time, in id order, through the same path as `update`
 *   (`installPluginRelease` → store → `PluginHost.reloadAfterUpdate`). If one fails, the rest continue, and the result is returned per extension.
 *   Acceptance: other extensions (with no update) and the app version do not change (the app's own assets are not fetched).
 * - Serving the previous version to viewers still open: the viewer URL is `aios-plugin://<id>/@<version>/<entry>`. After an update, a URL of the
 *   previous version's stage is still served from the previous version's directory, read by this process. That directory (in the store) is kept until the next launch.
 *
 * Does not call gh, the network, or the model (ReleaseSource is a fake).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { collectPluginFiles, pluginBundleZip } from '../scripts/release-config.mjs'
import { pluginAssetName, type PluginVersionTable } from '../src/shared/plugin-update.js'
import { pluginViewerUrl } from '../src/shared/plugin.js'
import { parseReason } from '../src/shared/reason.js'
import { runMigrations } from '../src/common/migrations.js'
import type { UpdatedPluginRecord } from '../src/common/settings-keys.js'
import { UpdatedPluginStore, type UpdatedPluginRecords } from '../src/main/plugin/updated-store.js'
import { installPluginRelease } from '../src/main/update/plugin-install.js'
import { PluginReleaseCatalog } from '../src/main/update/plugin-versions.js'
import type { ReleaseSource } from '../src/main/update/release-source.js'
import type { CapabilityBroker } from '../src/main/capability/broker.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => ({}) }, protocol: {}, app: {} }))

const { pluginFileOf, splitPluginRevision } = await import('../src/main/protocol.js')
const { PluginHost } = await import('../src/main/plugin/host.js')

let dir: string
let db: Db

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'aios-plugin-update-all-')))
  db = new Database(':memory:')
  runMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

/** An extension's directory (manifest, the viewer entry, and the lazily loaded chunks that exist only in that version). */
function writePlugin(at: string, id: string, version: string): void {
  mkdirSync(join(at, 'viewer'), { recursive: true })
  mkdirSync(join(at, 'chunks'), { recursive: true })
  writeFileSync(join(at, 'manifest.json'), JSON.stringify({ id, name: id, version, capabilities: {}, viewer: { entry: 'viewer/index.html', extensions: ['x'] } }))
  writeFileSync(join(at, 'viewer', 'index.html'), `<script type="module" src="../chunks/main-${version}.js"></script>`)
  writeFileSync(join(at, 'chunks', `main-${version}.js`), `import('./lazy-${version}.js')`)
  writeFileSync(join(at, 'chunks', `lazy-${version}.js`), `export const v = '${version}'`)
}

function releaseZip(id: string, version: string): Uint8Array {
  const src = mkdtempSync(join(dir, 'src-'))
  writePlugin(src, id, version)
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

interface Offer {
  readonly version: string
  /** Breaks the sha256 in the version table (the check fails). */
  readonly corrupt?: boolean
}

/** A fake Release (assets and SHA256SUMS). Adds the names asked for to `asked`. */
function fakeRelease(offers: Readonly<Record<string, Offer>>) {
  const assets = new Map<string, Uint8Array>()
  const plugins: Record<string, { version: string; asset: string; sha256: string }> = {}
  for (const [id, offer] of Object.entries(offers)) {
    const asset = pluginAssetName(id, offer.version)
    const bytes = releaseZip(id, offer.version)
    assets.set(asset, bytes)
    plugins[id] = { version: offer.version, asset, sha256: offer.corrupt === true ? 'f'.repeat(64) : sha(bytes) }
  }
  const sums = [...assets].map(([name, bytes]) => `${sha(bytes)}  ${name}`).join('\n') + `\n${'c'.repeat(64)}  aios-0.74.0-arm64-mac.zip\n`
  const asked: string[][] = []
  let active = 0
  let maxActive = 0
  const source: ReleaseSource = {
    latestTag: async () => 'v0.74.0',
    download: async (_tag, names, into) => {
      asked.push([...names])
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      for (const name of names) {
        const bytes = assets.get(name)
        if (bytes !== undefined) writeFileSync(join(into, name), bytes)
        if (name === 'SHA256SUMS') writeFileSync(join(into, name), sums)
      }
      active -= 1
    }
  }
  const table: PluginVersionTable = { format: 1, aios: '0.74.0', plugins }
  return { source, table, asked, maxActive: () => maxActive }
}

function makeHost(store: UpdatedPluginStore, catalog: PluginReleaseCatalog) {
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
  return host
}

async function setup(bundled: Readonly<Record<string, string>>, offers: Readonly<Record<string, Offer>>) {
  for (const [id, version] of Object.entries(bundled)) writePlugin(join(dir, 'bundled', id), id, version)
  const release = fakeRelease(offers)
  const records = memoryRecords()
  const store = new UpdatedPluginStore(join(dir, 'updates'), records)
  const catalog = new PluginReleaseCatalog(() => undefined)
  const host = makeHost(store, catalog)
  await catalog.releaseChecked({ tag: 'v0.74.0' }, async () => release.table)
  const versions = () => Object.fromEntries(host.summaries().map((s) => [s.id, s.version]))
  const list = () => host.summaries().map((s) => ({ id: s.id, version: s.version, bundled: s.bundled }))
  const install = (tag: string, id: string, entry: Parameters<typeof installPluginRelease>[3]) =>
    installPluginRelease({ source: release.source, store, host }, tag, id, entry)
  return { host, catalog, store, records, release, versions, list, install }
}

describe('一括の「全部更新」(PluginReleaseCatalog.updateAll)', () => {
  it('更新できるものだけを id の順に 1 つずつ更新し、1 つ失敗しても残りを続け、結果を拡張機能ごとに返す', async () => {
    const ctx = await setup(
      { 'aios.alpha': '1.0.0', 'aios.beta': '1.0.0', 'aios.gamma': '1.0.0' },
      // alpha fails first (its sha256 in the version table does not match). beta passes. gamma has no update.
      { 'aios.alpha': { version: '1.1.0', corrupt: true }, 'aios.beta': { version: '1.2.0' }, 'aios.gamma': { version: '1.0.0' } }
    )
    const results = await ctx.catalog.updateAll(ctx.list, ctx.install)
    expect(results).toEqual([
      { id: 'aios.alpha', from: '1.0.0', to: '1.1.0', outcome: 'failed', failure: 'update-checksum-mismatch' },
      { id: 'aios.beta', from: '1.0.0', to: '1.2.0', outcome: 'updated' }
    ])
    // Acceptance: only the updated ones change version. Extensions with no update and failed ones stay as they are.
    expect(ctx.versions()).toEqual({ 'aios.alpha': '1.0.0', 'aios.beta': '1.2.0', 'aios.gamma': '1.0.0' })
    // The app's own asset (the aios zip) is not fetched. Only the extension's asset and SHA256SUMS, one at a time (never two at once).
    expect(ctx.release.asked).toEqual([
      [pluginAssetName('aios.alpha', '1.1.0'), 'SHA256SUMS'],
      [pluginAssetName('aios.beta', '1.2.0'), 'SHA256SUMS']
    ])
    expect(ctx.release.maxActive()).toBe(1)
    // A failure also stays on the detail badge (it can be updated again); success shows the latest.
    expect(ctx.host.summaries().find((s) => s.id === 'aios.alpha')?.update).toEqual({
      state: 'failed',
      latest: '1.1.0',
      failure: 'update-checksum-mismatch'
    })
    expect(ctx.host.summaries().find((s) => s.id === 'aios.beta')?.update).toEqual({ state: 'up-to-date', latest: '1.2.0' })
    // The bundled copy is not rewritten.
    expect(existsSync(join(dir, 'bundled', 'aios.beta', 'chunks', 'main-1.0.0.js'))).toBe(true)
  })

  it('前に失敗したものも対象。更新できるものが無ければ空の配列', async () => {
    const ctx = await setup({ 'aios.alpha': '1.0.0' }, { 'aios.alpha': { version: '1.1.0' } })
    expect(await ctx.catalog.updateAll(ctx.list, async () => Promise.reject(new Error('boom')))).toEqual([
      { id: 'aios.alpha', from: '1.0.0', to: '1.1.0', outcome: 'failed', failure: 'update-check-failed' }
    ])
    expect(await ctx.catalog.updateAll(ctx.list, ctx.install)).toEqual([{ id: 'aios.alpha', from: '1.0.0', to: '1.1.0', outcome: 'updated' }])
    expect(await ctx.catalog.updateAll(ctx.list, ctx.install)).toEqual([])
  })

  it('走っている間の再要求は同じ終わりを待つ。1 つの更新が走っていればそれを待って結果に載せる', async () => {
    const ctx = await setup({ 'aios.alpha': '1.0.0', 'aios.beta': '1.0.0' }, { 'aios.alpha': { version: '1.1.0' }, 'aios.beta': { version: '1.1.0' } })
    const single = ctx.catalog.update({ id: 'aios.beta', version: '1.0.0', bundled: true }, ctx.install)
    const first = ctx.catalog.updateAll(ctx.list, ctx.install)
    const second = ctx.catalog.updateAll(ctx.list, ctx.install)
    expect(second).toBe(first)
    await single
    expect(await first).toEqual([
      { id: 'aios.alpha', from: '1.0.0', to: '1.1.0', outcome: 'updated' },
      { id: 'aios.beta', from: '1.0.0', to: '1.1.0', outcome: 'updated' }
    ])
    // beta was fetched only once.
    expect(ctx.release.asked.filter((names) => names[0] === pluginAssetName('aios.beta', '1.1.0'))).toHaveLength(1)
  })

  it('終了処理に入ったら残りは始めない。動かない形は update-unsupported', async () => {
    const ctx = await setup({ 'aios.alpha': '1.0.0', 'aios.beta': '1.0.0' }, { 'aios.alpha': { version: '1.1.0' }, 'aios.beta': { version: '1.1.0' } })
    let closing = false
    const results = await ctx.catalog.updateAll(
      ctx.list,
      async (tag, id, entry) => {
        await ctx.install(tag, id, entry)
        closing = true
      },
      () => closing
    )
    expect(results.map((result) => result.id)).toEqual(['aios.alpha'])
    expect(ctx.versions()).toEqual({ 'aios.alpha': '1.1.0', 'aios.beta': '1.0.0' })

    const unsupported = new PluginReleaseCatalog(() => undefined)
    unsupported.setUnsupported('dev')
    const err = await unsupported.updateAll(ctx.list, ctx.install).catch((e: unknown) => e)
    expect(parseReason(err instanceof Error ? err.message : String(err))?.code).toBe('update-unsupported')
  })
})

describe('開いたままの viewer に前の版を配る (aios-plugin://<id>/@<版>/…)', () => {
  it('版の段を分ける (無ければ null、壊れた符号化は配らない)', () => {
    expect(splitPluginRevision('/@1.2.0/viewer/index.html')).toEqual({ revision: '1.2.0', rest: '/viewer/index.html' })
    expect(splitPluginRevision('/viewer/index.html')).toEqual({ revision: null, rest: '/viewer/index.html' })
    expect(splitPluginRevision('/@1.0%20beta/x.js')).toEqual({ revision: '1.0 beta', rest: '/x.js' })
    expect(splitPluginRevision('/@1.2.0')).toEqual({ revision: '1.2.0', rest: '/' })
    expect(splitPluginRevision('/@%E0%A4%A/x.js')).toBeNull()
    expect(splitPluginRevision('/@/x.js')).toBeNull()
    expect(pluginViewerUrl('aios.text', '1.2.0', 'viewer/index.html')).toBe('aios-plugin://aios.text/@1.2.0/viewer/index.html')
  })

  it('viewer の URL は版の段つき。更新の後も前の版の段は前の版のディレクトリから配り、前の版は次の起動まで残す', async () => {
    const ctx = await setup({ 'aios.alpha': '1.0.0', 'aios.beta': '1.0.0' }, { 'aios.alpha': { version: '1.1.0' } })
    const opened = ctx.host.resolveViewerWith('file:///tmp/a.x', 'aios.alpha')
    expect(opened?.url).toBe('aios-plugin://aios.alpha/@1.0.0/viewer/index.html')
    const at = (url: string) => pluginFileOf(ctx.host, url)
    // 1.0.0 (bundled) → 1.1.0 (store).
    await ctx.catalog.update({ id: 'aios.alpha', version: '1.0.0', bundled: true }, ctx.install)
    expect(ctx.versions()['aios.alpha']).toBe('1.1.0')
    expect(ctx.host.resolveViewerWith('file:///tmp/a.x', 'aios.alpha')?.url).toBe('aios-plugin://aios.alpha/@1.1.0/viewer/index.html')
    // A chunk that a viewer left open (opened with the 1.0.0 URL) requests later is served from the 1.0.0 directory.
    expect(at('aios-plugin://aios.alpha/@1.0.0/chunks/lazy-1.0.0.js')).toBe(join(dir, 'bundled', 'aios.alpha', 'chunks', 'lazy-1.0.0.js'))
    expect(at('aios-plugin://aios.alpha/@1.0.0/chunks/lazy-1.1.0.js')).toBe(404)
    // A newly opened viewer is 1.1.0. A URL with no stage (such as the icon) is also the current version.
    expect(at('aios-plugin://aios.alpha/@1.1.0/chunks/lazy-1.1.0.js')).toBe(join(dir, 'updates', 'aios.alpha', '1.1.0', 'chunks', 'lazy-1.1.0.js'))
    expect(at('aios-plugin://aios.alpha/chunks/lazy-1.1.0.js')).toBe(join(dir, 'updates', 'aios.alpha', '1.1.0', 'chunks', 'lazy-1.1.0.js'))
    // A version that was never read, or another extension's version, is not served. A `..` after the stage does not escape either.
    expect(at('aios-plugin://aios.alpha/@0.9.0/chunks/lazy-1.0.0.js')).toBe(404)
    expect(at('aios-plugin://aios.beta/@1.1.0/chunks/lazy-1.0.0.js')).toBe(404)
    expect(at('aios-plugin://aios.alpha/@1.0.0/%2E%2E/%2E%2E/updates/aios.alpha/1.1.0/manifest.json')).toBe(404)
    // A disabled extension does not serve its previous version either.
    ctx.host.setEnabled('aios.alpha', false)
    expect(at('aios-plugin://aios.alpha/@1.0.0/chunks/lazy-1.0.0.js')).toBe(404)
    ctx.host.setEnabled('aios.alpha', true)
  })

  it('置き場の版から置き場の版への更新でも、前の版のディレクトリは次の起動まで残る (sweep / prune が飛ばす)', async () => {
    writePlugin(join(dir, 'bundled', 'aios.alpha'), 'aios.alpha', '1.0.0')
    const records = memoryRecords()
    const store = new UpdatedPluginStore(join(dir, 'updates'), records)
    const catalog = new PluginReleaseCatalog(() => undefined)
    // 1.1.0 was installed in the previous run.
    const staging = store.createStaging()
    writePlugin(join(staging, 'bundle'), 'aios.alpha', '1.1.0')
    store.install('aios.alpha', '1.1.0', join(staging, 'bundle'))
    rmSync(staging, { recursive: true, force: true })
    const host = makeHost(store, catalog)
    expect(host.summaries()[0]?.version).toBe('1.1.0')
    const release = fakeRelease({ 'aios.alpha': { version: '1.2.0' } })
    await catalog.releaseChecked({ tag: 'v0.74.0' }, async () => release.table)
    await catalog.update({ id: 'aios.alpha', version: '1.1.0', bundled: true }, (tag, id, entry) =>
      installPluginRelease({ source: release.source, store, host }, tag, id, entry)
    )
    expect(host.summaries()[0]?.version).toBe('1.2.0')
    expect(store.versionsOf('aios.alpha')).toEqual(['1.2.0', '1.1.0'])
    expect(pluginFileOf(host, 'aios-plugin://aios.alpha/@1.1.0/chunks/lazy-1.1.0.js')).toBe(
      join(dir, 'updates', 'aios.alpha', '1.1.0', 'chunks', 'lazy-1.1.0.js')
    )
    // A version not read by this process (it was 1.1.0 in the store at launch — no viewer was opened with the bundled 1.0.0) is not served.
    expect(pluginFileOf(host, 'aios-plugin://aios.alpha/@1.0.0/chunks/lazy-1.0.0.js')).toBe(404)
    // Not removed by the next load in the same process either (another extension's update, toggling enabled).
    host.load()
    store.prune('aios.alpha')
    expect(store.versionsOf('aios.alpha')).toEqual(['1.2.0', '1.1.0'])
    // At the next launch (a new store and PluginHost) only the recorded version remains, and the previous version's stage is not served.
    const nextStore = new UpdatedPluginStore(join(dir, 'updates'), records)
    const nextHost = makeHost(nextStore, new PluginReleaseCatalog(() => undefined))
    expect(nextStore.versionsOf('aios.alpha')).toEqual(['1.2.0'])
    expect(pluginFileOf(nextHost, 'aios-plugin://aios.alpha/@1.1.0/chunks/lazy-1.1.0.js')).toBe(404)
    expect(pluginFileOf(nextHost, 'aios-plugin://aios.alpha/@1.2.0/chunks/lazy-1.2.0.js')).toBe(
      join(dir, 'updates', 'aios.alpha', '1.2.0', 'chunks', 'lazy-1.2.0.js')
    )
  })
})
