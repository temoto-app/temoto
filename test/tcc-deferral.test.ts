/**
 * TODO 805: for the first 3 days after installing, the protected folders (Desktop / Documents / Downloads) are not scanned or watched.
 *
 * - Rule: the deferral appears only in the scan and watch rules (`withTccDeferred`); the choke point and list rules do not change. It does not overlap `TCC_DIRS`.
 * - A new user (no scan record in the DB) is deferred; someone already using it is not.
 * - During the deferral, the inside of protected folders is not walked, and watch diffs for them are not applied. Everything else is as before.
 * - Brought forward: 'Include now' in settings, opening a protected folder, making it the working folder, adding it to the scope. A startup after the deadline has passed. Each of these runs an incremental scan that includes the protected folders, and once it finishes, the record is reset to 0.
 *
 * The test tree is a fake home under `~/.aios-test/<run>/` (it does not touch the real `~/Desktop`). The real FSEvents and the encrypted DB. No model is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { FS_TCC_DEFER_UNTIL } from '../src/common/settings-keys.js'
import {
  classify,
  classifyAccess,
  createMacosExclusions,
  isUnderTccDeferred,
  TCC_DEFER_MS,
  TCC_DEFERRED_DIRS,
  TCC_DEFERRED_REASON,
  TCC_REASON,
  tccDeferredPaths,
  withTccDeferred
} from '../src/common/exclusions.js'
import { pathToUri } from '../src/common/uri.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { watchPlan } from '../src/index-kernel/watcher.js'
import type { ScanStatus } from '../src/shared/types.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'
import { makeFakeWatcher, type FakeSubscription, type FakeWatcher } from './helpers/fake-watcher.js'

const DAY = 24 * 60 * 60 * 1000
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await predicate()) return true
    await sleep(50)
  }
  return predicate()
}

describe('規則 (exclusions.ts)', () => {
  const home = '/Users/someone'
  const rules = createMacosExclusions(home)

  it('保護フォルダはデスクトップ / 書類 / ダウンロードで、ふだんの規則では除外ではない (索引・関門の対象)', () => {
    expect([...TCC_DEFERRED_DIRS]).toEqual(['~/Desktop', '~/Documents', '~/Downloads'])
    expect(TCC_DEFER_MS).toBe(3 * DAY)
    for (const dir of tccDeferredPaths(home)) {
      expect(classify(join(dir, 'a.txt'), 'a.txt', false, rules).excluded).toBe(false)
      expect(classifyAccess(join(dir, 'a.txt'), 'a.txt', false, rules, 'read').excluded).toBe(false)
    }
  })

  it('TCC_DIRS (常に除外、理由 tcc-protected) とは重ならない', () => {
    const tccPrefixes = rules.prefixes.filter((rule) => rule.reason === TCC_REASON).map((rule) => rule.prefix)
    expect(tccPrefixes.length).toBeGreaterThan(0)
    for (const dir of tccDeferredPaths(home).map((value) => value.toLowerCase())) {
      for (const prefix of tccPrefixes) {
        expect(dir === prefix || dir.startsWith(`${prefix}/`) || prefix.startsWith(`${dir}/`)).toBe(false)
      }
    }
  })

  it('withTccDeferred は走査・監視の写しにだけ除外を足す (元の規則は変えない)', () => {
    const deferred = withTccDeferred(rules)
    const file = join(home, 'Documents', 'deep', 'b.md')
    expect(classify(file, 'b.md', false, deferred)).toEqual({ excluded: true, reason: TCC_DEFERRED_REASON })
    expect(classify(file, 'b.md', false, rules).excluded).toBe(false)
    // A similar name (`Documents2`) does not match. Case is folded.
    expect(classify(join(home, 'Documents2', 'c'), 'c', false, deferred).excluded).toBe(false)
    expect(isUnderTccDeferred(join(home, 'downloads', 'x.zip'), home)).toBe(true)
    expect(isUnderTccDeferred(join(home, 'Downloads2'), home)).toBe(false)
    // The native ignore of the watch root (home) is given the path before folding (so FSEvents' ambiguous diffs do not trigger a stat).
    const ignore = watchPlan(home, deferred)[0]?.ignore ?? []
    for (const dir of tccDeferredPaths(home)) expect(ignore).toContain(dir)
    expect(watchPlan(home, rules)[0]?.ignore ?? []).not.toContain(join(home, 'Desktop'))
  })
})

describe('FsIndexer の保護フォルダの遅延 (TODO 805)', () => {
  const KEY = 'a'.repeat(64)
  let home: string
  let dbDir: string
  let db: Db
  let store: IndexStore
  let indexer: FsIndexer | null = null
  let statuses: ScanStatus[]

  function make(tccDeferral = true): FsIndexer {
    statuses = []
    indexer = new FsIndexer(
      db,
      { onScanStatus: (status) => statuses.push(status), onFileChanges: () => {} },
      store,
      home,
      [home],
      {},
      {},
      { tccDeferral }
    )
    return indexer
  }

  const found = async (fs: FsIndexer, name: string): Promise<boolean> =>
    (await fs.searchFiles(name, 20)).entries.some((entry) => entry.name === name)
  const settings = (): AppSettingsStore => new AppSettingsStore(db)
  const scanDone = (fs: FsIndexer): Promise<boolean> =>
    waitFor(() => fs.getScanStatus().state === 'done', 10_000)

  beforeEach(() => {
    home = makeTestDir('tcc-home')
    dbDir = makeTestDir('tcc-db')
    for (const dir of ['Desktop', 'Documents/sub', 'Downloads', 'notes']) mkdirSync(join(home, dir), { recursive: true })
    writeFileSync(join(home, 'Desktop', 'desk-note.txt'), 'd')
    writeFileSync(join(home, 'Documents', 'sub', 'report-doc.md'), 'r')
    writeFileSync(join(home, 'Downloads', 'setup-dl.zip'), 'z')
    writeFileSync(join(home, 'notes', 'plain-note.md'), 'p')
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
    removeTestDir(home)
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('新しく入れた人: 3 日の遅延を記録し、保護フォルダを歩かず、監視の差分も入れない', async () => {
    const before = Date.now()
    const fs = make()
    await fs.start()
    expect(await scanDone(fs)).toBe(true)

    const until = settings().readTyped(FS_TCC_DEFER_UNTIL) as number
    expect(until).toBeGreaterThanOrEqual(before + TCC_DEFER_MS)
    expect(until).toBeLessThanOrEqual(Date.now() + TCC_DEFER_MS)
    expect(fs.getScanStatus().tccDeferredUntil).toBe(until)
    expect(statuses.some((status) => status.tccDeferredUntil === until)).toBe(true)

    expect(await found(fs, 'plain-note.md')).toBe(true)
    for (const name of ['desk-note.txt', 'report-doc.md', 'setup-dl.zip']) expect(await found(fs, name)).toBe(false)
    // Do not create a row for the protected folder itself either (its inside was not walked).
    expect(store.findByPath(join(home, 'Desktop'))).toBeNull()

    // Watch: changes inside the protected folders do not come in; changes outside do.
    await sleep(300)
    writeFileSync(join(home, 'Desktop', 'later-desk.txt'), 'x')
    writeFileSync(join(home, 'notes', 'later-note.md'), 'x')
    expect(await waitFor(() => found(fs, 'later-note.md'), 8_000)).toBe(true)
    await sleep(300)
    expect(await found(fs, 'later-desk.txt')).toBe(false)
  }, 30_000)

  it('既に使っている人 (走査の実績がある DB) は遅延しない', async () => {
    const first = make(false)
    await first.start()
    expect(await scanDone(first)).toBe(true)
    await first.stop()

    const fs = make()
    await fs.start()
    expect(settings().readTyped(FS_TCC_DEFER_UNTIL)).toBe(0)
    expect(fs.getScanStatus().tccDeferredUntil).toBeNull()
    expect(await found(fs, 'desk-note.txt')).toBe(true)
  }, 30_000)

  it('「今すぐ含める」: 保護フォルダを含めた走査が走り、監視も張り直され、記録は 0 に戻る', async () => {
    const fs = make()
    await fs.start()
    expect(await scanDone(fs)).toBe(true)
    expect(await found(fs, 'report-doc.md')).toBe(false)

    await fs.releaseTccDeferral('button')
    expect(fs.getScanStatus().tccDeferredUntil).toBeNull()
    for (const name of ['desk-note.txt', 'report-doc.md', 'setup-dl.zip']) {
      expect(await waitFor(() => found(fs, name), 10_000)).toBe(true)
    }
    expect(await waitFor(() => settings().readTyped(FS_TCC_DEFER_UNTIL) === 0, 5_000)).toBe(true)

    await sleep(300)
    writeFileSync(join(home, 'Documents', 'after-release.md'), 'x')
    expect(await waitFor(() => found(fs, 'after-release.md'), 8_000)).toBe(true)
  }, 30_000)

  it('保護フォルダの外を開いても終わらず、中を開くと終わる (開くこと自体は遅延中も通る)', async () => {
    const fs = make()
    await fs.start()
    expect(await scanDone(fs)).toBe(true)

    await fs.listDirectory(pathToUri(join(home, 'notes')))
    expect(fs.getScanStatus().tccDeferredUntil).not.toBeNull()

    const listing = await fs.listDirectory(pathToUri(join(home, 'Desktop')))
    expect(listing.entries.map((entry) => entry.name)).toContain('desk-note.txt')
    expect(await waitFor(() => fs.getScanStatus().tccDeferredUntil === null, 2_000)).toBe(true)
    expect(await waitFor(() => found(fs, 'setup-dl.zip'), 10_000)).toBe(true)
  }, 30_000)

  it('参照範囲に足した・作業フォルダにした経路も、保護フォルダの中のときだけ終える', async () => {
    const fs = make()
    await fs.start()
    expect(await scanDone(fs)).toBe(true)
    await fs.releaseTccDeferral('reference', join(home, 'notes'))
    expect(fs.getScanStatus().tccDeferredUntil).not.toBeNull()
    await fs.scanSubtree(join(home, 'Documents', 'sub'))
    expect(fs.getScanStatus().tccDeferredUntil).toBeNull()
    expect(await waitFor(() => found(fs, 'report-doc.md'), 10_000)).toBe(true)
  }, 30_000)

  it('期限が過ぎた後の起動: 保護フォルダを含めた増分走査が「tcc-released」で走り、済んだら 0', async () => {
    const first = make()
    await first.start()
    expect(await scanDone(first)).toBe(true)
    await first.stop()

    // Three days have passed (the deadline is set in the past). Other scan records are still recent, so this is a startup that would normally skip the scan.
    settings().writeTyped(FS_TCC_DEFER_UNTIL, Date.now() - 1000)
    const fs = make()
    expect(fs.plan()).toBeNull()
    await fs.start()
    expect(fs.getScanStatus().tccDeferredUntil).toBeNull()
    expect(await waitFor(() => found(fs, 'desk-note.txt'), 10_000)).toBe(true)
    expect(await waitFor(() => settings().readTyped(FS_TCC_DEFER_UNTIL) === 0, 5_000)).toBe(true)
    expect(fs.plan()).toBeNull()
  }, 30_000)

  it('常駐中に期限が来たら、監視を張り直して保護フォルダを含める', async () => {
    const fs = make()
    await fs.start()
    expect(await scanDone(fs)).toBe(true)
    // Move the deadline to 'now' and call the deadline handling directly (the 3-day timer cannot be waited for).
    ;(fs as unknown as { tccDeferUntil: number }).tccDeferUntil = Date.now() - 1
    expect(fs.decide()).toMatchObject({ full: true, reason: 'tcc-released' })
    await fs.releaseTccDeferral('expired')
    expect(await waitFor(() => found(fs, 'desk-note.txt'), 10_000)).toBe(true)
    await sleep(300)
    writeFileSync(join(home, 'Desktop', 'after-expiry.txt'), 'x')
    expect(await waitFor(() => found(fs, 'after-expiry.txt'), 8_000)).toBe(true)
  }, 30_000)

  it('FsIndexer 単体 (既定) では遅延しない', async () => {
    const fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, home, [home])
    indexer = fs
    await fs.start()
    expect(await scanDone(fs)).toBe(true)
    expect(settings().readTyped(FS_TCC_DEFER_UNTIL)).toBeNull()
    expect(await found(fs, 'desk-note.txt')).toBe(true)
  }, 30_000)
})

/**
 * Code-review fixes for TODO 805. Checks the order with a fake clock (`now`) and a fake watch (`makeFakeWatcher`), without the real FSEvents. The scan uses the real tree under the fake home and the encrypted DB.
 */
describe('保護フォルダの遅延の解除 (TODO 805 の code-review)', () => {
  const KEY = 'b'.repeat(64)
  let home: string
  let dbDir: string
  let db: Db
  let store: IndexStore
  let indexer: FsIndexer | null = null
  let now: number
  let fake: FakeWatcher

  const deferredRules = (sub: FakeSubscription | undefined): boolean =>
    sub !== undefined && classify(join(home, 'Desktop', 'x.txt'), 'x.txt', false, sub.rules).excluded
  const latest = (): FakeSubscription | undefined => fake.subscriptions.at(-1)
  const settings = (): AppSettingsStore => new AppSettingsStore(db)
  const found = async (fs: FsIndexer, name: string): Promise<boolean> =>
    (await fs.searchFiles(name, 20)).entries.some((entry) => entry.name === name)
  const scanDone = (fs: FsIndexer): Promise<boolean> =>
    waitFor(() => fs.getScanStatus().state === 'done', 10_000)

  function make(
    options: { tccCheckMs?: number; onScanStatus?: (status: ScanStatus) => void } = {}
  ): FsIndexer {
    indexer = new FsIndexer(
      db,
      { onScanStatus: options.onScanStatus ?? (() => {}), onFileChanges: () => {} },
      store,
      home,
      [home],
      {},
      // Scheduled runs are enabled, but no timer is set (the test calls `tick()`). The clock is the same fake clock.
      { enabled: true, schedule: () => () => {}, now: () => now },
      { tccDeferral: true, now: () => now, tccCheckMs: options.tccCheckMs ?? 3_600_000, watcher: fake.backend }
    )
    return indexer
  }

  beforeEach(() => {
    now = Date.now()
    fake = makeFakeWatcher()
    home = makeTestDir('tcc-fix-home')
    dbDir = makeTestDir('tcc-fix-db')
    for (const dir of ['Desktop', 'Documents/sub', 'notes']) mkdirSync(join(home, dir), { recursive: true })
    writeFileSync(join(home, 'Desktop', 'desk-note.txt'), 'd')
    writeFileSync(join(home, 'Documents', 'sub', 'report-doc.md'), 'r')
    writeFileSync(join(home, 'notes', 'plain-note.md'), 'p')
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
    removeTestDir(home)
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('1: 定期実行の判定 (壁時計) が先に取り残しの走査を走らせても、監視の張り直し・状態の消去・タイマーの停止を通る', async () => {
    const fs = make()
    await fs.start()
    expect(await scanDone(fs)).toBe(true)
    expect(deferredRules(latest())).toBe(true)
    expect(fs.getScanStatus().tccDeferredUntil).not.toBeNull()

    // 4 days passed during sleep: the wall clock advanced, but the monotonic timer has not fired yet.
    now += 4 * DAY
    const verdict = (fs as unknown as { auto: { tick(): string } }).auto.tick()
    expect(verdict).toBe('run')
    expect(await waitFor(() => settings().readTyped(FS_TCC_DEFER_UNTIL) === 0, 10_000)).toBe(true)
    expect(await found(fs, 'desk-note.txt')).toBe(true)
    // Cleanup after the lift: the watch is set up again including the protected folders (the old subscription stops), the state is cleared, and the timer stops too.
    expect(await waitFor(() => !deferredRules(latest()), 5_000)).toBe(true)
    expect(await waitFor(() => fake.subscriptions.filter((sub) => !sub.stopped).length === 1, 5_000)).toBe(true)
    expect(fs.getScanStatus().tccDeferredUntil).toBeNull()
    expect((fs as unknown as { tccTimer: unknown }).tccTimer).toBeNull()
  }, 30_000)

  it('1: 期限の見直しは壁時計で比べる (スリープで単調時計が止まっていても、次の見直しで解ける)', async () => {
    const fs = make({ tccCheckMs: 20 })
    await fs.start()
    expect(await scanDone(fs)).toBe(true)
    expect(deferredRules(latest())).toBe(true)
    now += 4 * DAY
    expect(await waitFor(() => fs.getScanStatus().tccDeferredUntil === null, 5_000)).toBe(true)
    expect(await waitFor(() => !deferredRules(latest()), 5_000)).toBe(true)
    expect(await waitFor(() => found(fs, 'report-doc.md'), 10_000)).toBe(true)
    expect(await waitFor(() => settings().readTyped(FS_TCC_DEFER_UNTIL) === 0, 5_000)).toBe(true)
  }, 30_000)

  it('2・3: 監視が保護フォルダの中のフォルダの行を実物の mtime で先に書いても、取り残しの走査は枝刈りせずに歩く', async () => {
    const fs = make()
    await fs.start()
    expect(await scanDone(fs)).toBe(true)
    expect(await found(fs, 'report-doc.md')).toBe(false)

    now += 4 * DAY
    // The watch set up again at the lift delivered a diff for `~/Documents/sub` before the scan did (the row comes in with the real mtime).
    await fs.enqueueChanges([{ type: 'update', path: join(home, 'Documents', 'sub') }])
    expect(store.fsRowAt(join(home, 'Documents', 'sub'))?.mtimeMs).toBeGreaterThan(0)

    const plan = fs.plan()
    expect(plan?.deep).toBe(false)
    await fs.scan(plan ?? {})
    // If it had been pruned, `report-doc.md` would have been marked 'done' without being added.
    expect(await found(fs, 'report-doc.md')).toBe(true)
    expect(settings().readTyped(FS_TCC_DEFER_UNTIL)).toBe(0)
  }, 30_000)

  it('3: 取り残しの走査が中断されたら済みにしない', async () => {
    const fs = make()
    await fs.start()
    expect(await scanDone(fs)).toBe(true)
    now += 4 * DAY
    const scanning = fs.scan({ ...(fs.plan() ?? {}), auto: true })
    // Stop at the point where it started walking (the same flag as an interrupted scheduled run).
    ;(fs as unknown as { abortAutoScan(reason: string): void }).abortAutoScan('test')
    await scanning
    expect(settings().readTyped(FS_TCC_DEFER_UNTIL)).not.toBe(0)
    // It runs again on the next decision (the reason is recorded first, from the interruption).
    expect(fs.decide().full).toBe(true)
    expect(fs.plan()?.roots).toContain(home)
  }, 30_000)

  it('5:起動時の走査より前の解除では、取り残しの走査は起動時の走査 (速さの段) の後ろに回る', async () => {
    let openGate!: () => void
    fake.subscribeGate = new Promise((done) => {
      openGate = done
    })
    const pacedAtScanStart: boolean[] = []
    const fs = make({
      onScanStatus: (status) => {
        if (status.state === 'scanning' && status.seen === 0 && status.indexed === 0) {
          pacedAtScanStart.push((fs as unknown as { currentScanPaced: boolean }).currentScanPaced)
        }
      }
    })
    const starting = fs.start()
    // 'Include now' while the watch is being set up (the startup scan has not run yet).
    expect(await waitFor(() => (fs as unknown as { watchStarting: boolean }).watchStarting, 2_000)).toBe(true)
    const released = fs.releaseTccDeferral('button')
    await sleep(50)
    fake.subscribeGate = null
    openGate()
    await starting
    await released
    expect(await waitFor(() => settings().readTyped(FS_TCC_DEFER_UNTIL) === 0, 10_000)).toBe(true)
    expect(await scanDone(fs)).toBe(true)
    await sleep(200)
    // The first scan that started walking is the startup scan (it goes through the speed stage). Since it also walked the protected folders, the later scans are not needed.
    expect(pacedAtScanStart[0]).toBe(true)
    expect(pacedAtScanStart).toHaveLength(1)
    expect(await found(fs, 'desk-note.txt')).toBe(true)
    expect(deferredRules(latest())).toBe(false)
  }, 30_000)
})
