/**
 * Incremental scan (ARCHITECTURE.md 6.2.2, TODO 12 / T9).
 *
 * Three things must hold:
 * 1. **A directory whose mtime is the same as last time is not opened, and its child rows are not touched** (pruning).
 * 2. **The clean-up is scoped**, so it does not delete the rows of roots that were not walked this time.
 * 3. Under a directory whose mtime changed, what was deleted is properly deleted.
 *
 * Uses the real encrypted DB and real directories. Does not call the model.
 * On macOS `os.tmpdir()` is under /var/folders and hits the exclusions in 4.4.2, so the directories are created under the home directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { FsIndexer, SETTING_SCAN_INTERVAL_MS } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { makeTestDir } from './helpers/tmp.js'

const KEY = 'c'.repeat(64)

let base: string
let dbDir: string
let db: Db
let store: IndexStore
let settings: AppSettingsStore

/** A root under home (the target of pruning). */
const home = (): string => join(base, 'home')
/** A stand-in for the mount point of external storage (replaces `/Volumes`). */
const volumesDir = (): string => join(base, 'Volumes')
/**
 * A root outside home (not pruned. Its expiry is 7 days too, so it does not run in a partial scan).
 *
 * Since T20, only your own home is covered under `/Users`, so a "outside home" placed next to `~/.aios-incr-test-*` is dropped by the rules and cannot be walked. On a real machine the
 * roots that are walked outside home are `/`, `/usr/local`, and allowed volumes; the only one a test can make is an allowed volume.
 * So it takes the shape of allowed external storage (4.4.2.1).
 */
const outside = (): string => join(volumesDir(), 'Outside')

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (predicate()) return true
    await sleep(25)
  }
  return predicate()
}

function makeService(): FsIndexer {
  return new FsIndexer(
    db,
    { onScanStatus: () => {}, onFileChanges: () => {} },
    store,
    home(),
    [home(), outside()],
    { volumesDir: volumesDir(), probeUuid: async () => null }
  )
}

/** Runs one scan, then stops. */
async function run(service: FsIndexer): Promise<void> {
  await service.start()
  await waitFor(() => service.getScanStatus().state === 'done', 15_000)
  await service.stop()
}

const rowOf = (path: string): { size: number; mtime_ms: number; seen_at: number } | null => {
  const id = store.findByPath(path)
  if (id === null) return null
  return db.prepare(`SELECT size, mtime_ms, seen_at FROM documents WHERE id = ?`).get(id) as {
    size: number
    mtime_ms: number
    seen_at: number
  }
}

beforeAll(async () => {
  base = makeTestDir('incr-test')
  dbDir = makeTestDir('incrdb-test')
  mkdirSync(join(home(), 'quiet'), { recursive: true })
  mkdirSync(join(home(), 'busy'), { recursive: true })
  mkdirSync(join(outside(), 'apps'), { recursive: true })
  writeFileSync(join(home(), 'quiet', 'kept.md'), '# 静かな側\n')
  writeFileSync(join(home(), 'busy', 'old.md'), '# 消える\n')
  writeFileSync(join(outside(), 'apps', 'tool.md'), '# ホーム外\n')

  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
  settings = new AppSettingsStore(db)

  // First time = no record, so a deep scan (all roots, no pruning).
  const service = makeService()
  // Passes a root outside home through the rules as an allowed volume (start() calls refresh() and rebuilds the rules).
  await service.volumes.allow(outside())
  expect(service.plan()).toMatchObject({ deep: true })
  await run(service)
})

afterAll(() => {
  if (db.open) db.close()
  rmSync(base, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

describe('incremental scan (partial scan + pruning)', () => {
  it('if only the home deadline has passed, it walks only home with pruning', () => {
    settings.write(SETTING_SCAN_INTERVAL_MS, '0')
    const plan = makeService().plan()
    // Outside home is 7 days by default, so it is still within the window → this run's roots are home only.
    expect(plan).toMatchObject({ deep: false, reason: 'expired' })
    expect(plan?.roots).toEqual([home()])
  })

  it('a directory with the same mtime is not opened, and the child rows are not touched', async () => {
    const target = join(home(), 'quiet', 'kept.md')
    const before = rowOf(target)
    expect(before).not.toBeNull()

    // Changes only the file's contents. **The parent directory's mtime does not change**, so
    // the incremental scan does not open `quiet` = this row is not updated (the safe-side handling is in 6.2.2).
    writeFileSync(target, '# 静かな側 (書き換えたが親の mtime は変わらない)\n')
    // Runs only the scan (`start()` sets up watching after the scan). If watching were set up, the FSEvents for the write just before
    // would arrive late at the new subscription (fseventsd delay), and watching would wrongly update this row
    // — what we want to see is the scan's pruning, so watching is not mixed in (it showed up 2 times in 8 in the whole-suite test of TODO 262).
    const incremental = makeService()
    const plan = incremental.plan()
    expect(plan).toMatchObject({ deep: false })
    await incremental.scan(plan ?? {})
    await incremental.stop()

    const after = rowOf(target)
    expect(after?.size).toBe(before?.size)
    expect(after?.seen_at).toBe(before?.seen_at)
    // A deep scan does pick it up (without pruning, a difference in contents shows up in the version).
    const service = makeService()
    await service.rescan()
    await service.stop()
    expect(rowOf(target)?.size).not.toBe(before?.size)
  }, 30_000)

  it('under a directory whose mtime changed, both added and removed rows are reflected', async () => {
    const gone = join(home(), 'busy', 'old.md')
    const added = join(home(), 'busy', 'new.md')
    expect(store.findByPath(gone)).not.toBeNull()
    rmSync(gone)
    writeFileSync(added, '# 増えた\n')

    const service = makeService()
    expect(service.plan()).toMatchObject({ deep: false })
    await run(service)

    expect(store.findByPath(gone)).toBeNull()
    expect(store.findByPath(added)).not.toBeNull()
  }, 30_000)

  it('cleanup with a range does not remove rows of roots not walked this time', async () => {
    const outsideFile = join(outside(), 'apps', 'tool.md')
    expect(store.findByPath(outsideFile)).not.toBeNull()
    // The roots outside home are not walked this time. Even if they stay on disk, an implementation that deletes things "not walked = not seen this time" would delete them here.
    const plan = makeService().plan()
    expect(plan?.roots).toEqual([home()])

    await run(makeService())

    expect(store.findByPath(outsideFile)).not.toBeNull()
  }, 30_000)

  it('a root outside home is not pruned (there is no watcher, so content differences are also picked up)', async () => {
    const target = join(outside(), 'apps', 'tool.md')
    const before = rowOf(target)
    writeFileSync(target, '# ホーム外 (書き換えた)\n')
    // Expires outside home too → an incremental scan that walks both roots.
    settings.write('scan.outsideHomeIntervalMs', '0')
    try {
      const plan = makeService().plan()
      expect(plan).toMatchObject({ deep: false })
      expect(plan?.roots).toEqual([home(), outside()])
      await run(makeService())
      // Since it does not prune, a difference in contents is picked up even if the parent's mtime did not change.
      expect(rowOf(target)?.size).not.toBe(before?.size)
    } finally {
      settings.remove('scan.outsideHomeIntervalMs')
    }
  }, 30_000)

  it('when the interval from the last deep scan has opened up, it returns to a deep scan even for only the roots whose deadline came', () => {
    settings.write('scan.deepIntervalMs', '0')
    try {
      const plan = makeService().plan()
      expect(plan).toMatchObject({ deep: true })
      expect(plan?.roots).toEqual([home(), outside()])
    } finally {
      settings.remove('scan.deepIntervalMs')
    }
  })

  it('if the version of the exclusion rules changes, it becomes a deep scan, not a partial scan', () => {
    settings.write('scan.rulesVersion', '999')
    try {
      expect(makeService().plan()).toMatchObject({ deep: true, reason: 'rules-changed' })
    } finally {
      settings.remove('scan.rulesVersion')
      settings.remove(SETTING_SCAN_INTERVAL_MS)
    }
  })
})
