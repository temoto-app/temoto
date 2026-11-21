/**
 * The allow list for external storage (ARCHITECTURE.md 4.4.2 'external storage', TODO 3 / T4).
 *
 * The first half is `VolumeRegistry` alone (the shape of the setting, the mount check, matching the UUID).
 * The second half runs with the real encrypted DB and FsIndexer, through 'allow -> take in -> eject -> not removed -> another disk -> not removed -> unallow -> removed'.
 * The real `/Volumes` is not touched: `volumesDir` is replaced with a temporary directory under home. `diskutil` is replaced by injection. The model is not called.
 *
 * **Since P1, of the three paths, `assertAllowed` and the Broker are on the main side (`FsAccess`).**
 * The indexing process (`FsIndexer`) emits `onRules` each time the allow list changes, and main rebuilds the rules with **the same pure function** (3.5).
 * Here the wiring is assembled in the same shape as the real machine, and it checks that the three paths pass together, or are refused together.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { FsAccess } from '../src/main/fs/access.js'
import {
  parseVolumeUuid,
  SETTING_ALLOWED_VOLUMES,
  VolumeRegistry
} from '../src/index-kernel/volumes.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import type { CapabilityName } from '../src/shared/plugin.js'
import { pathToUri } from '../src/common/uri.js'
import { makeTestDir } from './helpers/tmp.js'

const KEY = 'f'.repeat(64)

describe('parseVolumeUuid', () => {
  it('diskutil の plist から VolumeUUID を抜く', () => {
    const plist = `<plist><dict>
\t<key>VolumeName</key>
\t<string>HDD</string>
\t<key>VolumeUUID</key>
\t<string>85773722-2029-402E-929F-2E5543D0892A</string>
</dict></plist>`
    expect(parseVolumeUuid(plist)).toBe('85773722-2029-402E-929F-2E5543D0892A')
  })

  it('無ければ null (diskutil のエラー plist も同じ)', () => {
    expect(parseVolumeUuid('<plist><dict><key>Error</key><true/></dict></plist>')).toBeNull()
    expect(parseVolumeUuid('')).toBeNull()
  })
})

describe('VolumeRegistry', () => {
  let base: string
  let volumesDir: string
  let db: Db
  let settings: AppSettingsStore
  let uuids: Record<string, string | null>

  const registry = (): VolumeRegistry =>
    new VolumeRegistry(settings, {
      volumesDir,
      probeUuid: async (path) => uuids[path] ?? null
    })

  beforeAll(() => {
    base = makeTestDir('volreg-test')
    volumesDir = join(base, 'Volumes')
    mkdirSync(join(volumesDir, 'Disk A'), { recursive: true })
    mkdirSync(join(volumesDir, 'DiskB'), { recursive: true })
    // The startup disk's remount is a symlink (`/Volumes/Macintosh HD -> /`). Not shown in the list.
    symlinkSync('/', join(volumesDir, 'Startup'))
    writeFileSync(join(volumesDir, '.DS_Store'), '')
    db = new Database(':memory:')
    runMigrations(db)
    settings = new AppSettingsStore(db)
    uuids = { [join(volumesDir, 'Disk A')]: 'UUID-A', [join(volumesDir, 'DiskB')]: null }
  })

  afterAll(() => {
    db.close()
    rmSync(base, { recursive: true, force: true })
  })

  it('マウント中の一覧は実ディレクトリだけ (symlink とドットファイルは除く)', () => {
    expect(registry().listMounted().map((v) => v.name)).toEqual(['Disk A', 'DiskB'])
    expect(registry().listMounted()[0]?.path).toBe(join(volumesDir, 'Disk A'))
  })

  it('許可はマウント中のマウントパスにしかできず、UUID を覚える', async () => {
    const r = registry()
    await expect(r.allow(join(volumesDir, 'Missing'))).rejects.toThrow('not-mounted')
    await expect(r.allow(join(volumesDir, 'Disk A', 'sub'))).rejects.toThrow('not-a-volume')
    await expect(r.allow(join(volumesDir, 'Startup'))).rejects.toThrow('not-mounted')
    const entry = await r.allow(join(volumesDir, 'Disk A'))
    expect(entry).toMatchObject({ path: join(volumesDir, 'Disk A'), label: 'Disk A', volumeUuid: 'UUID-A' })
    expect(settings.readJson<unknown[]>(SETTING_ALLOWED_VOLUMES)).toHaveLength(1)
    expect(r.effectivePaths()).toEqual([join(volumesDir, 'Disk A')])
  })

  it('UUID が取れないディスクはパス一致だけで許可する', async () => {
    const r = registry()
    const entry = await r.allow(join(volumesDir, 'DiskB'))
    expect(entry.volumeUuid).toBeNull()
    await r.refresh()
    expect([...r.effectivePaths()].sort()).toEqual([join(volumesDir, 'Disk A'), join(volumesDir, 'DiskB')])
  })

  it('同じ名前で別のディスクが刺さっていたら (UUID 不一致) 有効にならない', async () => {
    uuids[join(volumesDir, 'Disk A')] = 'UUID-OTHER'
    const r = registry()
    await r.refresh()
    expect(r.isEffective(join(volumesDir, 'Disk A'))).toBe(false)
    expect(r.isConfigured(join(volumesDir, 'Disk A'))).toBe(true)
    const state = r.states().find((v) => v.name === 'Disk A')
    expect(state).toMatchObject({ mounted: true, allowed: true, uuidMismatch: true })
    uuids[join(volumesDir, 'Disk A')] = 'UUID-A'
  })

  it('未マウントの許可ボリュームは一覧に「未マウント」で残る', async () => {
    renameSync(join(volumesDir, 'DiskB'), join(base, 'DiskB.off'))
    try {
      const r = registry()
      await r.refresh()
      expect(r.effectivePaths()).toEqual([join(volumesDir, 'Disk A')])
      expect([...r.configuredPaths()].sort()).toEqual([join(volumesDir, 'Disk A'), join(volumesDir, 'DiskB')])
      const state = r.states().find((v) => v.name === 'DiskB')
      expect(state).toMatchObject({ mounted: false, allowed: true, uuidMismatch: false })
    } finally {
      renameSync(join(base, 'DiskB.off'), join(volumesDir, 'DiskB'))
    }
  })

  it('解除すると設定から消える。無いものの解除は false', async () => {
    const r = registry()
    expect(await r.disallow(join(volumesDir, 'DiskB'))).toBe(true)
    expect(await r.disallow(join(volumesDir, 'DiskB'))).toBe(false)
    expect(r.configuredPaths()).toEqual([join(volumesDir, 'Disk A')])
  })

  it('壊れた要素とマウントパスの形でないものは捨てる', () => {
    settings.writeJson(SETTING_ALLOWED_VOLUMES, [
      { path: join(volumesDir, 'Disk A'), label: 'Disk A', volumeUuid: null, addedAt: 1 },
      { path: join(volumesDir, 'Disk A', 'sub'), label: 'x', volumeUuid: null, addedAt: 1 },
      { path: '/Users/x', label: 'x', volumeUuid: null, addedAt: 1 },
      { path: 42 },
      'garbage'
    ])
    expect(registry().configuredPaths()).toEqual([join(volumesDir, 'Disk A')])
    settings.write(SETTING_ALLOWED_VOLUMES, 'not json')
    expect(registry().configuredPaths()).toEqual([])
  })
})

describe('FsIndexer と外部ストレージ (実物の DB)', () => {
  let base: string
  let home: string
  let volumesDir: string
  let dbDir: string
  let db: Db
  let store: IndexStore
  let uuidOfExt1: string | null = 'UUID-1'
  const ext1 = (): string => join(volumesDir, 'Ext1')
  const ext2 = (): string => join(volumesDir, 'Ext2')

  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
  const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (predicate()) return true
      await sleep(50)
    }
    return predicate()
  }

  /** The holder of the rules on the main side, synced from the indexing process by `onRules` (3.5). */
  let access: FsAccess

  function makeService(): FsIndexer {
    access = new FsAccess(home, [home])
    return new FsIndexer(
      db,
      {
        onScanStatus: () => {},
        onFileChanges: () => {},
        onRules: (allowed, dir) => access.rebuildRules(allowed, dir)
      },
      store,
      home,
      [home],
      {
        volumesDir,
        probeUuid: async (path) => (path === ext1() ? uuidOfExt1 : null)
      }
    )
  }

  async function fullScan(service: FsIndexer): Promise<void> {
    await service.start()
    if (service.getScanStatus().skipped) await service.rescan()
    await waitFor(() => service.getScanStatus().state === 'done', 10_000)
  }

  beforeAll(() => {
    base = makeTestDir('vol-test')
    home = join(base, 'home')
    volumesDir = join(base, 'Volumes')
    dbDir = makeTestDir('voldb-test')
    mkdirSync(join(home, 'docs'), { recursive: true })
    mkdirSync(join(ext1(), 'work'), { recursive: true })
    mkdirSync(join(ext2(), 'work'), { recursive: true })
    writeFileSync(join(home, 'docs', 'own.md'), '# own\n')
    writeFileSync(join(ext1(), 'work', 'a.md'), '# a\n')
    writeFileSync(join(ext2(), 'work', 'b.md'), '# b\n')
    // A symlink from under home to an unallowed volume. The scan must not descend into it.
    symlinkSync(ext2(), join(home, 'to-ext2'))

    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key='${KEY}'`)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new IndexStore(db)
  })

  afterAll(() => {
    if (db.open) db.close()
    rmSync(base, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('既定では外部ストレージを歩かない (symlink 経由でも)', async () => {
    const service = makeService()
    expect(service.scanRoots()).toEqual([home])
    await fullScan(service)
    await service.stop()
    expect(store.findByPath(join(home, 'docs', 'own.md'))).not.toBeNull()
    expect(store.findByPath(join(home, 'to-ext2', 'work', 'b.md'))).toBeNull()
    expect(store.findByPath(join(ext1(), 'work', 'a.md'))).toBeNull()
    expect(service.listVolumes().map((v) => [v.name, v.allowed])).toEqual([
      ['Ext1', false],
      ['Ext2', false]
    ])
  })

  it('許可するとルートに入り、3 経路 (走査 / assertAllowed / Broker) が同時に通る', async () => {
    const service = makeService()
    // Before allowing: both assertAllowed and the Broker refuse.
    expect(() => access.assertAllowed(pathToUri(join(ext1(), 'work', 'a.md')), false)).toThrow(
      'excluded'
    )

    const policy: PluginPolicy = {
      id: 'test.plugin',
      declared: {
        credentials: [],
        networkHosts: [],
        fsRead: [ext1()],
        fsWrite: [],
        indexSources: [],
        ui: false
      },
      consented: new Set<CapabilityName>(['fs'])
    }
    const audit = new AuditLog(db)
    const broker = new CapabilityBroker({
      // The same as index.ts: reads the rules of the main-side holder (FsAccess) through a getter.
      scope: {
        get rules() {
          return access.exclusionRules
        }
      },
      audit,
      credentials: new CredentialStore(dbDir, {
        available: () => false,
        seal: () => Buffer.alloc(0),
        open: () => ''
      }),
      policyOf: (id) => (id === 'test.plugin' ? policy : null),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined
    })
    const read = (): Promise<unknown> =>
      broker.handle('test.plugin', {
        capability: 'fs',
        op: 'read',
        uri: pathToUri(join(ext1(), 'work', 'a.md'))
      })
    await expect(read()).rejects.toThrow('excluded')

    const entries = await service.setVolumeAllowed(pathToUri(ext1()), true)
    expect(entries.find((v) => v.name === 'Ext1')).toMatchObject({ allowed: true, mounted: true })
    // setVolumeAllowed starts a rescan. rescan() joins the scan already running.
    await service.rescan()
    await waitFor(() => service.getScanStatus().state === 'done', 10_000)

    expect(service.scanRoots()).toEqual([home, ext1()])
    expect(store.findByPath(join(ext1(), 'work', 'a.md'))).not.toBeNull()
    expect(store.findByPath(join(ext2(), 'work', 'b.md'))).toBeNull()
    expect(access.assertAllowed(pathToUri(join(ext1(), 'work', 'a.md')), false)).toBe(
      join(ext1(), 'work', 'a.md')
    )
    const result = (await read()) as { kind: string; text: string }
    expect(result.kind).toBe('text')
    expect(result.text).toContain('# a')
    // An unallowed volume is still refused.
    expect(() => access.assertAllowed(pathToUri(join(ext2(), 'work', 'b.md')), false)).toThrow(
      'excluded'
    )
    await service.stop()
    audit.dispose()
  })

  it('抜いている間 (未マウント) は歩かず、行も消えず、ルート集合も変わらない', async () => {
    renameSync(ext1(), join(base, 'Ext1.off'))
    try {
      const service = makeService()
      // It stays in the roots even when unmounted, so T3's roots-changed does not do a full scan every time.
      expect(service.scanRoots()).toEqual([home, ext1()])
      expect(service.decide()).toMatchObject({ full: false })
      await fullScan(service)
      await service.stop()
      expect(store.findByPath(join(ext1(), 'work', 'a.md'))).not.toBeNull()
      const run = store.latestScanRuns().find((r) => r.root === ext1())
      expect(run).toMatchObject({ state: 'done' })
      expect(service.listVolumes().find((v) => v.name === 'Ext1')).toMatchObject({
        mounted: false,
        allowed: true
      })
      // While it is unplugged, naturally it cannot be read (it is also excluded by the rules).
      expect(() => access.assertAllowed(pathToUri(join(ext1(), 'work', 'a.md')), false)).toThrow(
        'excluded'
      )
    } finally {
      renameSync(join(base, 'Ext1.off'), ext1())
    }
  })

  it('同じ名前で別のディスク (UUID 不一致) が刺さっていても歩かず、行も消えない', async () => {
    uuidOfExt1 = 'UUID-OTHER'
    try {
      const service = makeService()
      await fullScan(service)
      await service.stop()
      expect(store.findByPath(join(ext1(), 'work', 'a.md'))).not.toBeNull()
      expect(service.listVolumes().find((v) => v.name === 'Ext1')).toMatchObject({
        mounted: true,
        allowed: true,
        uuidMismatch: true
      })
      expect(service.exclusionRules.allowedVolumes).toEqual([])
    } finally {
      uuidOfExt1 = 'UUID-1'
    }
  })

  it('部分走査 (増分) でも、未マウントの許可ボリュームの行は消えない', async () => {
    const settings = new AppSettingsStore(db)
    const first = makeService()
    await fullScan(first)
    await first.stop()
    expect(store.findByPath(join(ext1(), 'work', 'a.md'))).not.toBeNull()

    renameSync(ext1(), join(base, 'Ext1.off'))
    // Expire only home (outside home, volumes are 7 days by default, so they do not come around).
    settings.write('scan.intervalMs', '0')
    try {
      const service = makeService()
      const plan = service.plan()
      // A partial scan for increments: only home is walked. Cleanup is also limited to the walked range.
      expect(plan).toMatchObject({ deep: false })
      expect(plan?.roots).toEqual([home])
      await service.start()
      await waitFor(() => service.getScanStatus().state === 'done', 10_000)
      await service.stop()
      expect(store.findByPath(join(ext1(), 'work', 'a.md'))).not.toBeNull()
      expect(store.findByPath(join(home, 'docs', 'own.md'))).not.toBeNull()
    } finally {
      settings.remove('scan.intervalMs')
      renameSync(join(base, 'Ext1.off'), ext1())
    }
  }, 20_000)

  it('解除すると次の走査で行が消え、ルート集合からも外れる', async () => {
    const service = makeService()
    await service.start()
    const entries = await service.setVolumeAllowed(pathToUri(ext1()), false)
    expect(entries.find((v) => v.name === 'Ext1')).toMatchObject({ allowed: false, mounted: true })
    expect(service.scanRoots()).toEqual([home])
    await service.rescan()
    await waitFor(() => service.getScanStatus().state === 'done', 10_000)
    await service.stop()
    expect(store.findByPath(join(ext1(), 'work', 'a.md'))).toBeNull()
    expect(store.findByPath(join(home, 'docs', 'own.md'))).not.toBeNull()
    // The record of a completed run remains with the root set after unallowing.
    expect(makeService().decide()).toMatchObject({ full: false })
  })
  it('許可の途中で終了しても stop() は設定の書き込みを待ってから返る (TODO 1124)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    access = new FsAccess(home, [home])
    const service = new FsIndexer(
      db,
      { onScanStatus: () => {}, onFileChanges: () => {}, onRules: (a, d) => access.rebuildRules(a, d) },
      store,
      home,
      [home],
      { volumesDir, probeUuid: async () => (await gate, null) }
    )
    let settled = false
    const op = service.setVolumeAllowed(pathToUri(ext2()), true).finally(() => {
      settled = true
    })
    let stopped = false
    const stopping = service.stop().then(() => {
      stopped = true
    })
    await new Promise((done) => setTimeout(done, 50))
    // It does not return while diskutil's wait continues. If it returned, the settings would be written after the DB was closed.
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(settled).toBe(true)
    await op
  })
})
