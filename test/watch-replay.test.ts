/**
 * TODO 833: separating and fixing the case where the scan at startup was skipped because it had 'just run', and newly created folders did not show in the file name search until the next 'rescan'.
 *
 * - (b) Does a folder that the watch picked up enter the name table? -> It does (this was not the cause).
 * - (a) Things created while aios was stopped (and between launch and the watch being set up): before, the watch only looked from 'now', so in a launch that skipped the scan they did not enter until the next scan. Now the FSEvents history is replayed from the previous mark.
 * - (c) First launch with an empty userData: before, the watch was set up **after** the full scan, so folders created inside the one that finished walking during the several-minute full scan were dropped. Now it is set up before the scan.
 *
 * The real FSEvents (`@parcel/watcher`), the real encrypted DB, and the tree under `~/.aios-test/<run>/`. The model is not called.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { FS_WATCH_MARK } from '../src/common/settings-keys.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { changesSince, isExcludedEvent, takeWatchMark, watchMarkTime } from '../src/index-kernel/watcher.js'
import { createMacosExclusions } from '../src/common/exclusions.js'
import type { ScanStatus } from '../src/shared/types.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'
import { makeFakeWatcher, markNumber, type FakeWatcher } from './helpers/fake-watcher.js'

const KEY = 'f'.repeat(64)
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await predicate()) return true
    await sleep(50)
  }
  return predicate()
}

describe('watch marks and replay (watcher.ts, TODO 833)', () => {
  let root: string
  beforeAll(() => {
    root = makeTestDir('watch-mark')
  })
  afterAll(() => removeTestDir(root))

  it('the mark is the FSEvents event id and time, and what was created after it is returned from the history (exclusions are dropped)', async () => {
    const mark = await takeWatchMark(root)
    expect(mark).toMatch(/^\d+\n\d+$/)
    const at = watchMarkTime(mark as string)
    expect(at).not.toBeNull()
    expect(Math.abs((at as number) - Date.now())).toBeLessThan(60_000)

    mkdirSync(join(root, 'made-while-down', 'deep'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'x.js'), '')
    await sleep(200)

    const changes = await changesSince(root, createMacosExclusions(root), mark as string)
    const paths = changes.map((change) => change.path)
    expect(paths).toContain(join(root, 'made-while-down'))
    expect(paths).toContain(join(root, 'made-while-down', 'deep'))
    // The contents are dropped (`**/node_modules` is passed to the native ignore). `node_modules` itself passes, as with delete, since its kind is unknown,
    // and it is dropped when applying (`classify` in `applyUpsert`), the same handling as the live watch.
    expect(paths.some((path) => path.includes('node_modules/'))).toBe(false)
  })

  it('a watch diff is dropped if an intermediate element matches a name rule (node_modules etc.); above the root is not looked at', () => {
    const rules = createMacosExclusions('/Users/dist')
    expect(isExcludedEvent('/Users/dist/proj/node_modules/pkg/x.js', rules, '/Users/dist')).toBe(true)
    // `build` is conditional (TODO 1324): nothing is on disk under this fake home, so there is no marker and it passes.
    expect(isExcludedEvent('/Users/dist/proj/build/out.o', rules, '/Users/dist')).toBe(false)
    expect(isExcludedEvent('/Users/dist/proj/build/out.o', rules, '/Users/dist', { has: () => true })).toBe(true)
    // The home name (`dist`) is above the root, so the name rule does not apply to it.
    expect(isExcludedEvent('/Users/dist/proj/src/a.ts', rules, '/Users/dist')).toBe(false)
    // The last element's kind is unknown (delete), so it is treated as a file: a file named `build` is not dropped.
    expect(isExcludedEvent('/Users/dist/proj/build', rules, '/Users/dist')).toBe(false)
  })
})

describe('FsIndexer: a newly created folder appears in file name search (TODO 833)', () => {
  let root: string
  let dbDir: string
  let db: Db
  let store: IndexStore

  function make(onScanStatus: (status: ScanStatus) => void = () => {}): FsIndexer {
    return new FsIndexer(db, { onScanStatus, onFileChanges: () => {} }, store, root, [root])
  }

  const found = async (indexer: FsIndexer, name: string): Promise<boolean> => {
    const result = await indexer.searchFiles(name, 20)
    return result.entries.some((entry) => entry.name === name)
  }

  const settings = (): AppSettingsStore => new AppSettingsStore(db)

  beforeAll(() => {
    root = makeTestDir('watch-replay')
    dbDir = makeTestDir('watch-replay-db')
    mkdirSync(join(root, 'notes', 'sub'), { recursive: true })
    writeFileSync(join(root, 'notes', 'a.md'), '# a\n')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key='${KEY}'`)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new IndexStore(db)
  })

  afterAll(() => {
    if (db.open) db.close()
    removeTestDir(root)
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('(c) first launch: the watch is set up before the full scan, and a mark remains at the end of the scan', async () => {
    let watchingAtScanStart: boolean | null = null
    const indexer = make((status) => {
      if (status.state === 'scanning' && watchingAtScanStart === null) {
        watchingAtScanStart = (indexer as unknown as { watch: unknown }).watch !== null
      }
    })
    await indexer.start()
    expect(await waitFor(() => indexer.getScanStatus().state === 'done', 10_000)).toBe(true)
    expect(watchingAtScanStart).toBe(true)
    expect(await waitFor(() => settings().readTyped(FS_WATCH_MARK) !== null, 5_000)).toBe(true)
    await indexer.stop()
  }, 20_000)

  it('(b) on a launch that skipped the scan, a folder picked up by the watch appears in name search', async () => {
    const indexer = make()
    await indexer.start()
    expect(indexer.getScanStatus().skipped).toBe(true)
    await sleep(300)
    mkdirSync(join(root, 'notes', 'sub', 'live-folder-b'))
    expect(await waitFor(() => found(indexer, 'live-folder-b'), 8_000)).toBe(true)
    await indexer.stop()
  }, 20_000)

  it('(a) folders created and files deleted while stopped are replayed on the next launch that skipped the scan', async () => {
    // The end mark of the previous launch (b) remains.
    expect(settings().readTyped(FS_WATCH_MARK)).not.toBeNull()
    expect(await found(make(), 'a.md')).toBe(true)

    // Changes while aios was down.
    mkdirSync(join(root, 'notes', 'sub', 'made-while-down'))
    writeFileSync(join(root, 'notes', 'sub', 'made-while-down', 'inside.txt'), 'x')
    rmSync(join(root, 'notes', 'a.md'))
    await sleep(200)

    const indexer = make()
    await indexer.start()
    // The scan is skipped (before, it stopped here: the watch only looks from 'now').
    expect(indexer.getScanStatus().skipped).toBe(true)
    expect(await waitFor(() => found(indexer, 'made-while-down'), 8_000)).toBe(true)
    expect(await waitFor(() => found(indexer, 'inside.txt'), 8_000)).toBe(true)
    expect(await waitFor(async () => !(await found(indexer, 'a.md')), 8_000)).toBe(true)
    await indexer.stop()
  }, 30_000)

  it('does not replay when the mark is older than the deep scan interval (does not bloat the history)', async () => {
    const old = `1\n${(Date.now() - 30 * 24 * 60 * 60 * 1000) * 1_000_000}`
    settings().writeTyped(FS_WATCH_MARK, old)
    mkdirSync(join(root, 'notes', 'sub', 'too-old-folder'))
    await sleep(200)
    const indexer = make()
    await indexer.start()
    // Wait until a new mark is written (the mark for which the decision on replaying was made).
    expect(await waitFor(() => settings().readTyped(FS_WATCH_MARK) !== old, 5_000)).toBe(true)
    expect(await found(indexer, 'too-old-folder')).toBe(false)
    await indexer.stop()
  }, 20_000)
})

/**
 * TODO 805 / 833 code-review fixes. Checks the order of subscription, mark, and replay with a fake watcher (`makeFakeWatcher`).
 * The scan uses the real tree under `~/.aios-test/<run>/` and the encrypted DB.
 */
describe('re-establishing the watch and quitting (TODO 805 / 833 code-review)', () => {
  let root: string
  let dbDir: string
  let db: Db
  let store: IndexStore
  let fake: FakeWatcher
  let indexer: FsIndexer | null = null

  const settings = (): AppSettingsStore => new AppSettingsStore(db)
  const found = async (fs: FsIndexer, name: string): Promise<boolean> =>
    (await fs.searchFiles(name, 20)).entries.some((entry) => entry.name === name)
  function make(tccDeferral: boolean): FsIndexer {
    indexer = new FsIndexer(
      db,
      { onScanStatus: () => {}, onFileChanges: () => {} },
      store,
      root,
      [root],
      {},
      {},
      { tccDeferral, watcher: fake.backend }
    )
    return indexer
  }

  beforeEach(() => {
    fake = makeFakeWatcher()
    root = makeTestDir('rewatch')
    dbDir = makeTestDir('rewatch-db')
    mkdirSync(join(root, 'Desktop'), { recursive: true })
    mkdirSync(join(root, 'notes'), { recursive: true })
    writeFileSync(join(root, 'notes', 'a.md'), 'a')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key='${KEY}'`)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new IndexStore(db)
  })

  afterEach(async () => {
    await indexer?.stop()
    indexer = null
    if (db.open) db.close()
    removeTestDir(root)
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('4: re-establishing sets up the new subscription before stopping the old one, replays from the mark before re-establishing, and advances the mark only afterwards', async () => {
    const fs = make(true)
    await fs.start()
    expect(await waitFor(() => fs.getScanStatus().state === 'done', 10_000)).toBe(true)
    // Wait until the startup mark (without replay) is saved.
    expect(await waitFor(() => markNumber(settings().readTyped(FS_WATCH_MARK)) === 1, 5_000)).toBe(true)

    // Created in the gap of re-arming (it is a fake watcher, so it does not come live: only replaying the history picks it up).
    const gap = join(root, 'notes', 'gap-file.md')
    writeFileSync(gap, 'g')
    let openGate!: () => void
    const gate = new Promise<void>((done) => {
      openGate = done
    })
    fake.since = async (n) => {
      await gate
      return n === 2 ? [{ type: 'create', path: gap }] : []
    }
    // Set the delay as finished and re-arm (no scan is run: if the scan picked it up, the replay could not be checked).
    ;(fs as unknown as { tccDeferUntil: number }).tccDeferUntil = 0
    await (fs as unknown as { rewatchIfStale(): Promise<void> }).rewatchIfStale()

    const at = (entry: string): number => fake.log.indexOf(entry)
    expect(at('mark:2')).toBeGreaterThanOrEqual(0)
    expect(at('mark:2')).toBeLessThan(at('subscribe#2'))
    expect(at('subscribe#2')).toBeLessThan(at('stop#1'))
    expect(await waitFor(() => fake.log.includes('since:2'), 2_000)).toBe(true)
    // The saved mark does not advance until the replay has finished being applied.
    await sleep(300)
    expect(markNumber(settings().readTyped(FS_WATCH_MARK))).toBe(1)
    expect(await found(fs, 'gap-file.md')).toBe(false)

    openGate()
    expect(await waitFor(() => found(fs, 'gap-file.md'), 5_000)).toBe(true)
    expect(await waitFor(() => markNumber(settings().readTyped(FS_WATCH_MARK)) === 3, 5_000)).toBe(true)
  }, 30_000)

  it('6: quit does not wait for a long replay, and the replay does not write to the DB after quit', async () => {
    const first = make(false)
    await first.start()
    expect(await waitFor(() => first.getScanStatus().state === 'done', 10_000)).toBe(true)
    await first.stop()

    const stale = `5\n${Date.now() * 1_000_000}`
    settings().writeTyped(FS_WATCH_MARK, stale)
    const late = join(root, 'notes', 'late.md')
    writeFileSync(late, 'l')
    let openGate!: () => void
    const gate = new Promise<void>((done) => {
      openGate = done
    })
    fake.since = async () => {
      await gate
      return [{ type: 'create', path: late }]
    }
    const fs = make(false)
    await fs.start()
    expect(fs.getScanStatus().skipped).toBe(true)
    expect(await waitFor(() => fake.log.includes('since:5'), 2_000)).toBe(true)

    // Exits while the replay has not returned. Before, `stop()` waited for this.
    const opener = setTimeout(openGate, 1_500)
    const startedAt = Date.now()
    await fs.stop()
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    clearTimeout(opener)

    // Even if the history returns after the exit, nothing is applied and no mark is saved.
    openGate()
    await sleep(300)
    expect(fake.sinceStopped).toBe(true)
    expect(settings().readTyped(FS_WATCH_MARK)).toBe(stale)
    expect(store.findByPath(late)).toBeNull()
  }, 30_000)

  it('7 (TODO 889): changes left in the batch when the watch stopped enter the index before quit, and the mark does not advance', async () => {
    const fs = make(false)
    await fs.start()
    expect(await waitFor(() => fs.getScanStatus().state === 'done', 10_000)).toBe(true)
    expect(await waitFor(() => settings().readTyped(FS_WATCH_MARK) !== null, 5_000)).toBe(true)
    const markBefore = settings().readTyped(FS_WATCH_MARK)

    // Created and deleted just before the exit. The exit came while it was waiting in the batch (16 ms).
    const made = join(root, 'notes', 'made-just-before-quit.md')
    writeFileSync(made, 'm')
    rmSync(join(root, 'notes', 'a.md'))
    expect(store.findByPath(join(root, 'notes', 'a.md'))).not.toBeNull()
    const sub = fake.subscriptions.at(-1)
    expect(sub).toBeDefined()
    sub?.pending.push({ type: 'create', path: made }, { type: 'delete', path: join(root, 'notes', 'a.md') })

    await fs.stop()
    // Before, `dispose()` discarded it.
    expect(store.findByPath(made)).not.toBeNull()
    expect(store.findByPath(join(root, 'notes', 'a.md'))).toBeNull()
    // The mark does not advance during shutdown (the saved mark stays before the changes already applied: the starting point of the next launch's replay).
    expect(settings().readTyped(FS_WATCH_MARK)).toBe(markBefore)

    // Things that arrive after `stop()` has returned (e.g. a subscription mid-re-arm that stopped late) do not touch the DB.
    const after = join(root, 'notes', 'after-stop.md')
    writeFileSync(after, 'x')
    sub?.emit([{ type: 'create', path: after }])
    await sleep(100)
    expect(store.findByPath(after)).toBeNull()
  }, 30_000)
})
