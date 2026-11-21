/**
 * Thinning out the full scan at startup (ARCHITECTURE.md 6.2 "scan thinning", TODO 8 / T3).
 *
 * The first half covers all the conditions of the pure function `shouldFullScan`. The second half runs, on the real encrypted DB,
 * "the first time runs → it is recorded → the second time is skipped and only watching is set up → it stops".
 * Does not call the model.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { FsIndexer, SETTING_SCAN_INTERVAL_MS } from '../src/index-kernel/indexer.js'
import { RULES_VERSION } from '../src/common/exclusions.js'
import {
  DEFAULT_OUTSIDE_HOME_INTERVAL_MS,
  DEFAULT_SCAN_INTERVAL_MS,
  dueRoots,
  nextScanAt,
  planScan,
  shouldFullScan,
  type ScanRunRecord,
  type ScanScheduleInput
} from '../src/index-kernel/schedule.js'
import {
  decideAutoScan,
  shouldAbortAutoScan,
  ScanScheduler,
  type AutoScanVerdict
} from '../src/index-kernel/scheduler.js'
import type { ScanDecision } from '../src/index-kernel/schedule.js'
import { SLOW_SCAN_BATCH, SlowPacer, type ThermalState } from '../src/index-kernel/pace.js'
import { IndexStore } from '../src/index-kernel/store.js'
import type { FileChangeBatch, ScanStatus } from '../src/shared/types.js'
import { makeTestDir } from './helpers/tmp.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe('shouldFullScan (pure function)', () => {
  const home = '/Users/me'
  const roots = [home, '/', '/usr/local']
  const now = 1_700_000_000_000
  const done = (root: string, finishedAt: number): ScanRunRecord => ({
    root,
    startedAt: finishedAt - 60_000,
    finishedAt,
    state: 'done'
  })
  const fresh = (): ScanScheduleInput => ({
    now,
    home,
    roots,
    rulesVersion: RULES_VERSION,
    recorded: { finishedAt: now - HOUR, home, roots, rulesVersion: RULES_VERSION },
    runs: roots.map((root) => done(root, now - HOUR))
  })

  it('skips when everything is in place', () => {
    const decision = shouldFullScan(fresh())
    expect(decision).toEqual({ full: false, lastFullScanAt: now - HOUR })
  })

  it('runs when there is no record of completion', () => {
    const decision = shouldFullScan({ ...fresh(), recorded: null })
    expect(decision).toMatchObject({ full: true, reason: 'no-record', lastFullScanAt: null })
  })

  it('runs when the exclusion rules version differs', () => {
    const base = fresh()
    const decision = shouldFullScan({
      ...base,
      recorded: { ...base.recorded!, rulesVersion: RULES_VERSION + 1 }
    })
    expect(decision).toMatchObject({ full: true, reason: 'rules-changed' })
  })

  it('TODO 262 / 633 / 855: under version 6, records of version 5 (TODO 633), version 4 (TODO 262), version 3 (T20), version 2 (T4), and version 1 (Phase 3) run', () => {
    // /Users was moved to exclude (T20), so the next launch is always a full scan, to remove rows from other users' homes with removeStale
    // (T4's /Volumes was also version 1 → 2 for the same reason). Version 4 (the exclusion of `~/.aios-test`) is the same: rows the test used to leave directly under home are dropped by it.
    // Version 5 (the exclusion of `.claude/worktrees/`, TODO 633 stage 1) is for the same reason.
    // Version 6 (the credentials location, TODO 855) too. The symlink row of the file in TODO 849 is also dropped by this full scan.
    expect(RULES_VERSION).toBe(6)
    const base = fresh()
    for (const rulesVersion of [1, 2, 3, 4, 5]) {
      const decision = shouldFullScan({ ...base, recorded: { ...base.recorded!, rulesVersion } })
      expect(decision).toMatchObject({ full: true, reason: 'rules-changed' })
    }
  })

  it('runs when the home path changes', () => {
    const base = fresh()
    const decision = shouldFullScan({
      ...base,
      recorded: { ...base.recorded!, home: '/Users/someone-else' }
    })
    expect(decision).toMatchObject({ full: true, reason: 'home-changed' })
  })

  it('runs when the set of roots changes (whether it grows or shrinks)', () => {
    const base = fresh()
    expect(shouldFullScan({ ...base, roots: [...roots, '/opt'] })).toMatchObject({
      full: true,
      reason: 'roots-changed'
    })
    expect(shouldFullScan({ ...base, roots: [home, '/'] })).toMatchObject({
      full: true,
      reason: 'roots-changed'
    })
    // Order and letter case (APFS is case-insensitive) are not treated as a difference in the sets.
    expect(shouldFullScan({ ...base, roots: ['/usr/local', '/', '/Users/Me'] })).toMatchObject({
      full: false
    })
  })

  it('runs when the previous one was aborted', () => {
    const base = fresh()
    const runs = base.runs.map((run) => (run.root === '/' ? { ...run, state: 'aborted' as const } : run))
    expect(shouldFullScan({ ...base, runs })).toMatchObject({
      full: true,
      reason: 'aborted',
      root: '/'
    })
  })

  it('a previous one still running (crashed midway) is the same as aborted', () => {
    const base = fresh()
    const runs = base.runs.map((run) =>
      run.root === home ? { ...run, state: 'running' as const, finishedAt: null } : run
    )
    expect(shouldFullScan({ ...base, runs })).toMatchObject({ full: true, reason: 'aborted' })
  })

  it('runs when there is no root row', () => {
    const base = fresh()
    const runs = base.runs.filter((run) => run.root !== '/usr/local')
    expect(shouldFullScan({ ...base, runs })).toMatchObject({
      full: true,
      reason: 'no-record',
      root: '/usr/local'
    })
  })

  it('default thresholds: 24 hours under home, 7 days outside home', () => {
    expect(DEFAULT_SCAN_INTERVAL_MS).toBe(DAY)
    expect(DEFAULT_OUTSIDE_HOME_INTERVAL_MS).toBe(7 * DAY)
    const base = fresh()
    // Home only, 25 hours ago → expired.
    const homeOld = base.runs.map((run) => (run.root === home ? done(home, now - 25 * HOUR) : run))
    expect(shouldFullScan({ ...base, runs: homeOld })).toMatchObject({
      full: true,
      reason: 'expired',
      root: home
    })
    // Outside home 25 hours ago → still within 7 days, so it is skipped.
    const outsideRecent = base.runs.map((run) => (run.root === '/' ? done('/', now - 25 * HOUR) : run))
    expect(shouldFullScan({ ...base, runs: outsideRecent })).toMatchObject({ full: false })
    // Outside home 8 days ago → expired.
    const outsideOld = base.runs.map((run) => (run.root === '/' ? done('/', now - 8 * DAY) : run))
    expect(shouldFullScan({ ...base, runs: outsideOld })).toMatchObject({
      full: true,
      reason: 'expired',
      root: '/'
    })
  })

  it('the thresholds can be overridden', () => {
    const base = fresh()
    expect(shouldFullScan({ ...base, intervalMs: 30 * 60_000 })).toMatchObject({
      full: true,
      reason: 'expired',
      root: home
    })
    const outsideOld = base.runs.map((run) => (run.root === '/' ? done('/', now - 2 * DAY) : run))
    expect(
      shouldFullScan({ ...base, runs: outsideOld, outsideHomeIntervalMs: DAY })
    ).toMatchObject({ full: true, reason: 'expired', root: '/' })
  })

  it('runs when the clock went backward (the completion time is in the future)', () => {
    const base = fresh()
    const runs = base.runs.map((run) => (run.root === home ? done(home, now + HOUR) : run))
    expect(shouldFullScan({ ...base, runs })).toMatchObject({ full: true, reason: 'expired' })
  })
})

describe('throttling of FsIndexer.start() (real DB)', () => {
  const KEY = 'e'.repeat(64)
  let root: string
  let dbDir: string
  let db: Db
  let store: IndexStore

  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
  const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (predicate()) return true
      await sleep(50)
    }
    return predicate()
  }

  function makeService(
    onScanStatus: (status: ScanStatus) => void = () => {},
    onFileChanges: (batch: FileChangeBatch) => void = () => {}
  ): FsIndexer {
    return new FsIndexer(db, { onScanStatus, onFileChanges }, store, root, [root])
  }

  beforeAll(() => {
    // macOS's tmpdir() is under /var/folders and hits the exclusions in 4.4.2, so it is created under home.
    root = makeTestDir('schedule-test')
    dbDir = makeTestDir('scheduledb-test')
    mkdirSync(join(root, 'notes'), { recursive: true })
    writeFileSync(join(root, 'notes/a.md'), '# 記録\n')

    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key='${KEY}'`)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new IndexStore(db)
  })

  afterAll(() => {
    if (db.open) db.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('the first run with no record runs, and leaves the completion in scan_runs and app_settings', async () => {
    const statuses: ScanStatus[] = []
    const service = makeService((status) => statuses.push(status))
    expect(service.decide()).toMatchObject({ full: true, reason: 'no-record' })

    await service.start()
    await waitFor(() => service.getScanStatus().state === 'done', 10_000)
    await service.stop()

    const status = service.getScanStatus()
    expect(status.skipped).toBe(false)
    expect(status.indexed).toBeGreaterThan(0)
    expect(status.lastFullScanAt).not.toBeNull()

    const runs = store.latestScanRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ root, state: 'done' })
    expect(runs[0]?.finishedAt).not.toBeNull()

    const settings = new AppSettingsStore(db)
    expect(settings.readInteger('scan.rulesVersion')).toBe(RULES_VERSION)
    expect(settings.readJson<{ roots: string[]; home: string }>('scan.lastFull')).toMatchObject({
      home: root,
      roots: [root]
    })
  })

  it('the second run is skipped and only sets up watching, and stop() also stops watching', async () => {
    const statuses: ScanStatus[] = []
    const batches: FileChangeBatch[] = []
    const service = makeService(
      (status) => statuses.push(status),
      (batch) => batches.push(batch)
    )
    expect(service.decide()).toMatchObject({ full: false })

    await service.start()
    const status = service.getScanStatus()
    expect(status.state).toBe('done')
    expect(status.skipped).toBe(true)
    expect(status.lastFullScanAt).not.toBeNull()
    // No scan is running: there is no scanning state notification at all.
    expect(statuses.every((s) => s.state !== 'scanning')).toBe(true)
    // No row for this run was added to scan_runs.
    expect(store.latestScanRuns()).toHaveLength(1)

    // Watching is set up: a change arrives as a diff.
    await sleep(300)
    writeFileSync(join(root, 'notes/b.md'), '# 追加\n')
    expect(await waitFor(() => batches.length > 0, 8_000)).toBe(true)

    await service.stop()
    const seen = batches.length
    writeFileSync(join(root, 'notes/c.md'), '# 止めた後\n')
    await sleep(600)
    expect(batches.length).toBe(seen)
  }, 20_000)

  it('even after skipping, a manual rescan runs', async () => {
    const statuses: ScanStatus[] = []
    const service = makeService((status) => statuses.push(status))
    await service.start()
    expect(service.getScanStatus().skipped).toBe(true)
    await service.rescan()
    const status = service.getScanStatus()
    expect(status.state).toBe('done')
    expect(status.skipped).toBe(false)
    expect(statuses.some((s) => s.state === 'scanning')).toBe(true)
    await service.stop()
  }, 20_000)

  it('shortening the threshold in app_settings makes it run', async () => {
    const settings = new AppSettingsStore(db)
    settings.write(SETTING_SCAN_INTERVAL_MS, '0')
    try {
      // Expired if even 1 ms has passed since the completion.
      await sleep(5)
      expect(makeService().decide()).toMatchObject({ full: true, reason: 'expired', root })
    } finally {
      settings.remove(SETTING_SCAN_INTERVAL_MS)
    }
    expect(makeService().decide()).toMatchObject({ full: false })
  })

  it('an interrupted scan is not treated as complete, and the next one runs', async () => {
    const service = makeService()
    // Stopped right after the scan starts. The root's row becomes aborted.
    const task = service.rescan()
    await service.stop()
    await task
    const runs = store.latestScanRuns()
    expect(runs[0]).toMatchObject({ root, state: 'aborted' })
    expect(makeService().decide()).toMatchObject({ full: true, reason: 'aborted', root })
  })

  it('T20: home is not included twice in the whole-PC root set', () => {
    // Since T20, home is an include (`own-home`) under `/Users` (excluded).
    // scanRoots() adds an include that sits under an exclusion as an independent root, so without removing duplicates it would be [home, '/', home].
    const service = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, root, null)
    const roots = service.scanRoots()
    expect(roots[0]).toBe(root)
    expect(roots[1]).toBe('/')
    expect(roots.filter((value) => value.toLowerCase() === root.toLowerCase())).toHaveLength(1)
    expect(new Set(roots.map((value) => value.toLowerCase())).size).toBe(roots.length)
  })

  it('raising the exclusion rules version makes it run', () => {
    const settings = new AppSettingsStore(db)
    settings.write('scan.rulesVersion', String(RULES_VERSION + 1))
    expect(makeService().decide()).toMatchObject({ full: true, reason: 'rules-changed' })
  })
})

// ---- T9: planning a partial scan, and the scheduled run while resident (6.2.2) ----

describe('planScan / dueRoots / nextScanAt (pure functions)', () => {
  const home = '/Users/me'
  const roots = [home, '/', '/usr/local']
  const now = 1_700_000_000_000
  const done = (root: string, finishedAt: number): ScanRunRecord => ({
    root,
    startedAt: finishedAt - 60_000,
    finishedAt,
    state: 'done'
  })
  const fresh = (): ScanScheduleInput => ({
    now,
    home,
    roots,
    rulesVersion: RULES_VERSION,
    recorded: { finishedAt: now - HOUR, home, roots, rulesVersion: RULES_VERSION },
    runs: roots.map((root) => done(root, now - HOUR))
  })

  it('there is no plan when no deadline has come', () => {
    expect(planScan(fresh(), now - HOUR)).toBeNull()
  })

  it('if only home is expired, only home is walked incrementally', () => {
    const base = fresh()
    const runs = base.runs.map((run) => (run.root === home ? done(home, now - 25 * HOUR) : run))
    expect(dueRoots({ ...base, runs }).map((d) => d.root)).toEqual([home])
    const plan = planScan({ ...base, runs }, now - HOUR)
    expect(plan).toMatchObject({ deep: false, reason: 'expired', roots: [home] })
  })

  it('a reason that applies to everything (a rules change) is a deep scan of all roots', () => {
    const base = fresh()
    const plan = planScan({ ...base, recorded: { ...base.recorded!, rulesVersion: 99 } }, now - HOUR)
    expect(plan).toMatchObject({ deep: true, reason: 'rules-changed' })
    expect(plan?.roots).toEqual(roots)
  })

  it('if the interval since the last deep scan has opened up, a deep scan even when only a per-root deadline expired', () => {
    const base = fresh()
    const runs = base.runs.map((run) => (run.root === home ? done(home, now - 25 * HOUR) : run))
    // No record / too old / in the future: all fall back to a deep scan.
    expect(planScan({ ...base, runs }, null)).toMatchObject({ deep: true })
    expect(planScan({ ...base, runs }, now - 8 * DAY)).toMatchObject({ deep: true })
    expect(planScan({ ...base, runs }, now + DAY)).toMatchObject({ deep: true })
    expect(planScan({ ...base, runs }, now - DAY)).toMatchObject({ deep: false })
    // The interval can be overridden.
    expect(planScan({ ...base, runs }, now - 2 * HOUR, HOUR)).toMatchObject({ deep: true })
  })

  it('the next deadline is the earliest of the per-root thresholds', () => {
    const base = fresh()
    // Home 24 hours vs outside home 7 days → home comes first.
    expect(nextScanAt(base)).toBe(now - HOUR + DAY)
    // If already expired, null (= due now).
    const runs = base.runs.map((run) => (run.root === home ? done(home, now - 25 * HOUR) : run))
    expect(nextScanAt({ ...base, runs })).toBeNull()
    expect(nextScanAt({ ...base, recorded: null })).toBeNull()
  })
})

describe('deciding periodic runs (decideAutoScan, revised in TODO 434)', () => {
  const base = {
    due: true,
    scanning: false,
    thermalState: 'nominal' as ThermalState,
    lowPower: false
  }

  it('runs when the deadline has come: does not look at whether the user is active or the power type (speed is a matter of pace)', () => {
    expect(decideAutoScan(base)).toBe('run')
  })

  // The table for 434: the verdict for each combination of heat and Low Power.
  it.each([
    ['unknown', false, 'run'],
    ['nominal', false, 'run'],
    ['fair', false, 'run'],
    ['serious', false, 'thermal'],
    ['critical', false, 'thermal'],
    ['nominal', true, 'low-power'],
    ['serious', true, 'thermal']
  ] as const)('thermal %s / Low Power %s -> %s', (thermalState, lowPower, verdict) => {
    expect(decideAutoScan({ ...base, thermalState, lowPower })).toBe(verdict)
  })

  it('does not run when the deadline has not come', () => {
    expect(decideAutoScan({ ...base, due: false })).toBe('not-due')
  })

  it('does nothing when a scan is already running', () => {
    expect(decideAutoScan({ ...base, scanning: true })).toBe('busy')
  })

  it('aborts on thermal / Low Power Mode (does not abort merely because the user came back)', () => {
    expect(shouldAbortAutoScan('serious', false)).toBe(true)
    expect(shouldAbortAutoScan('nominal', true)).toBe(true)
    expect(shouldAbortAutoScan('fair', false)).toBe(false)
    expect(shouldAbortAutoScan('unknown', false)).toBe(false)
  })
})

describe('ScanScheduler (injected clock and idle)', () => {
  const full: ScanDecision = { full: true, reason: 'expired', root: '/', lastFullScanAt: 0 }
  const notFull: ScanDecision = { full: false, lastFullScanAt: 0 }

  function harness(options: {
    idle: number
    due?: boolean
    scanning?: boolean
    thermal?: ThermalState
    lowPower?: boolean
  }): {
    scheduler: ScanScheduler
    started: number
    aborted: string[]
    set: (
      patch: Partial<{ idle: number; scanning: boolean; thermal: ThermalState; lowPower: boolean }>
    ) => void
    tick: () => ReturnType<ScanScheduler['tick']>
    verdicts: AutoScanVerdict[]
  } {
    const state = {
      idle: options.idle,
      scanning: options.scanning ?? false,
      due: options.due ?? true,
      thermal: options.thermal ?? ('nominal' as ThermalState),
      lowPower: options.lowPower ?? false
    }
    const box = { started: 0 }
    const aborted: string[] = []
    const verdicts: AutoScanVerdict[] = []
    const scheduler = new ScanScheduler(
      {
        decide: () => (state.due ? full : notFull),
        isScanning: () => state.scanning,
        startAutoScan: () => {
          box.started += 1
          state.scanning = true
        },
        abortAutoScan: (reason) => {
          aborted.push(reason)
          state.scanning = false
        }
      },
      {
        enabled: true,
        now: () => 1_700_000_000_000,
        idleSeconds: () => state.idle,
        thermalState: () => state.thermal,
        lowPower: () => state.lowPower,
        idleThresholdSeconds: 300,
        // No timer is used (the tests call tick() directly).
        schedule: () => () => {},
        onVerdict: (verdict) => verdicts.push(verdict)
      }
    )
    return {
      scheduler,
      get started(): number {
        return box.started
      },
      aborted,
      set: (patch) => Object.assign(state, patch),
      tick: () => scheduler.tick(),
      verdicts
    }
  }

  it('starts even while the user is active (walks slowly, TODO 434), and does not start twice while running', () => {
    const h = harness({ idle: 10 })
    expect(h.scheduler.pace()).toBe('slow')
    expect(h.tick()).toBe('run')
    expect(h.started).toBe(1)
    expect(h.tick()).toBe('busy')
    expect(h.started).toBe(1)
    // When it becomes idle, the same scan goes to full speed (it neither stops nor restarts).
    h.set({ idle: 600 })
    expect(h.scheduler.pace()).toBe('full')
    expect(h.tick()).toBe('busy')
    expect(h.aborted).toEqual([])
  })

  it('does not abort even if the user comes back while running (TODO 434; the speed only drops to slow)', () => {
    const h = harness({ idle: 600 })
    expect(h.tick()).toBe('run')
    h.set({ idle: 1 })
    expect(h.tick()).toBe('busy')
    expect(h.aborted).toEqual([])
    expect(h.scheduler.pace()).toBe('slow')
  })

  it('if the thermal state becomes serious while running, it asks to abort and does not start until the heat subsides', () => {
    const h = harness({ idle: 1 })
    expect(h.tick()).toBe('run')
    h.set({ thermal: 'serious' })
    expect(h.scheduler.pace()).toBe('hold')
    expect(h.tick()).toBe('aborting')
    expect(h.aborted).toEqual(['thermal'])
    expect(h.tick()).toBe('thermal')
    expect(h.started).toBe(1)
    h.set({ thermal: 'fair' })
    expect(h.tick()).toBe('run')
    expect(h.started).toBe(2)
  })

  it('does not start in Low Power Mode', () => {
    const h = harness({ idle: 600, lowPower: true })
    expect(h.tick()).toBe('low-power')
    expect(h.verdicts).toEqual(['low-power'])
    expect(h.started).toBe(0)
  })

  it('does nothing when the deadline has not come', () => {
    const h = harness({ idle: 600, due: false })
    expect(h.tick()).toBe('not-due')
    expect(h.started).toBe(0)
  })

  it('never starts again after stop()', () => {
    const h = harness({ idle: 600 })
    h.scheduler.stop()
    h.scheduler.start()
    expect(h.tick()).toBe('busy')
    expect(h.started).toBe(0)
  })

  it('disabled by default (start() does not set a timer)', () => {
    let scheduled = 0
    const scheduler = new ScanScheduler(
      {
        decide: () => full,
        isScanning: () => false,
        startAutoScan: () => undefined,
        abortAutoScan: () => undefined
      },
      {
        schedule: () => {
          scheduled += 1
          return () => {}
        }
      }
    )
    scheduler.start()
    expect(scheduled).toBe(0)
  })
})

describe('walks a periodic scan at a speed tier (TODO 434, real DB)', () => {
  const KEY = 'e'.repeat(64)
  let root: string
  let dbDir: string
  let db: Db
  let store: IndexStore

  beforeAll(() => {
    root = makeTestDir('pace-scan')
    dbDir = makeTestDir('pace-scandb')
    // A file that only spans a few steps of the slow scan (`SLOW_SCAN_BATCH` = 250 entries).
    mkdirSync(join(root, 'bulk'), { recursive: true })
    for (let i = 0; i < 700; i += 1) writeFileSync(join(root, 'bulk', `f${i}.txt`), 'x')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key='${KEY}'`)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new IndexStore(db)
  })

  afterAll(() => {
    if (db.open) db.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  })

  function make(state: { idle: number; thermal: ThermalState }, onSleep: () => void = () => {}): {
    service: FsIndexer
    sleeps: number[]
    statuses: ScanStatus[]
  } {
    let cpu = 0
    const sleeps: number[] = []
    const statuses: ScanStatus[] = []
    const pacer = new SlowPacer({
      cpuMicros: () => (cpu += 1_000),
      sleep: async (ms) => {
        sleeps.push(ms)
        onSleep()
      }
    })
    const service = new FsIndexer(
      db,
      { onScanStatus: (status) => statuses.push(status), onFileChanges: () => {} },
      store,
      root,
      [root],
      {},
      {
        idleSeconds: () => state.idle,
        thermalState: () => state.thermal,
        schedule: () => () => {},
        pacer
      }
    )
    return { service, sleeps, statuses }
  }

  it('a periodic run during activity walks to the end in small steps with rests', async () => {
    const { service, sleeps, statuses } = make({ idle: 1, thermal: 'nominal' })
    await service.scan({ auto: true })
    expect(service.getScanStatus().state).toBe('done')
    expect(service.getScanStatus().indexed).toBeGreaterThanOrEqual(701)
    // One step = up to 250 entries: the notification of entries written comes in steps of 250.
    const steps = statuses.filter((s) => s.state === 'scanning' && s.indexed > 0).map((s) => s.indexed)
    expect(steps[0]).toBeLessThanOrEqual(SLOW_SCAN_BATCH)
    // It rests between steps (701 entries / 250 per step → 3 or more steps).
    expect(sleeps.length).toBeGreaterThanOrEqual(3)
    await service.stop()
  }, 30_000)

  it('when idle, full speed (no rests; one step is as large as before)', async () => {
    const { service, sleeps, statuses } = make({ idle: 10_000, thermal: 'nominal' })
    await service.scan({ auto: true })
    expect(service.getScanStatus().state).toBe('done')
    expect(sleeps).toEqual([])
    const steps = statuses.filter((s) => s.state === 'scanning' && s.indexed > 0).map((s) => s.indexed)
    expect(steps[0]).toBeGreaterThan(SLOW_SCAN_BATCH)
    await service.stop()
  }, 30_000)

  it('if the thermal state becomes serious while walking, it aborts (not treated as complete)', async () => {
    const state = { idle: 1, thermal: 'nominal' as ThermalState }
    const { service } = make(state, () => {
      state.thermal = 'serious'
    })
    await service.scan({ auto: true })
    expect(service.getScanStatus().state).toBe('done')
    expect(store.latestScanRuns().find((run) => run.root === root)?.state).toBe('aborted')
    await service.stop()
  }, 30_000)

  it('a manual rescan (neither auto nor startup) is full speed even during activity (no rests)', async () => {
    const { service, sleeps } = make({ idle: 1, thermal: 'nominal' })
    await service.scan({})
    expect(sleeps).toEqual([])
    await service.stop()
  }, 30_000)

  it('TODO 448: the full startup scan (startup) also walks at the same tier as the periodic one: slow during activity', async () => {
    const { service, sleeps, statuses } = make({ idle: 1, thermal: 'nominal' })
    await service.scan({ startup: true })
    expect(service.getScanStatus().state).toBe('done')
    const steps = statuses.filter((s) => s.state === 'scanning' && s.indexed > 0).map((s) => s.indexed)
    expect(steps[0]).toBeLessThanOrEqual(SLOW_SCAN_BATCH)
    expect(sleeps.length).toBeGreaterThanOrEqual(3)
    await service.stop()
  }, 30_000)

  it('TODO 448: the full startup scan (startup) is full speed when left idle (no rests)', async () => {
    const { service, sleeps } = make({ idle: 10_000, thermal: 'nominal' })
    await service.scan({ startup: true })
    expect(service.getScanStatus().state).toBe('done')
    expect(sleeps).toEqual([])
    await service.stop()
  }, 30_000)

  it('TODO 448: the full startup scan (startup) also aborts when the thermal state becomes serious', async () => {
    const state = { idle: 1, thermal: 'nominal' as ThermalState }
    const { service } = make(state, () => {
      state.thermal = 'serious'
    })
    await service.scan({ startup: true })
    expect(service.getScanStatus().state).toBe('done')
    expect(store.latestScanRuns().find((run) => run.root === root)?.state).toBe('aborted')
    await service.stop()
  }, 30_000)
})
