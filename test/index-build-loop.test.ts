/**
 * Regression for the optimizations of the index build loop (P5 / P2 / P3 / P4).
 *
 * Each one pins down by machine a "fact settled by investigation" in the performance TODO file at the repository root (`TODO.*.md`).
 * The model is not called. Time is not claimed (the counts are kept small): claims about speed are measured on the `scripts/bench/` side.
 *
 * - **P5**: nested transactions were stopped. SAVEPOINT forces an FTS5 flush.
 * - **P2**: N documents = one transaction. The number of flushes is the stop time as it is.
 * - **P3**: raises `crisismerge` and cuts the merge into steps with `mergeStep`.
 * - **P4**: the build is put under the same idle judgment as the scan (6.2.2).
 * - **TODO 434** (revision of P4): idle runs at full speed, slow while in operation (N% of one core), and heat or Low Power waits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService, type IndexIdlePolicy } from '../src/index-kernel/service.js'
import { SLOW_DUTY_PERCENT, SlowPacer, decidePace, restMsFor } from '../src/index-kernel/pace.js'
import { log } from '../src/common/logger.js'
import type { IndexStatus } from '../src/shared/search.js'
import { makeTestDir } from './helpers/tmp.js'

let dbDir: string
let root: string
let db: Db
let store: IndexStore
/** SQL picked up by `new Database(file, { verbose })`. It is the evidence for P5 / P2. */
let sql: string[]

function openDb(): void {
  dbDir = makeTestDir('loop-db')
  sql = []
  db = new Database(join(dbDir, 'aios.db'), {
    verbose: (statement?: unknown) => {
      if (typeof statement === 'string') sql.push(statement)
    }
  })
  db.pragma(`key='${'d'.repeat(64)}'`)
  runMigrations(db)
  store = new IndexStore(db)
}

beforeEach(() => {
  openDb()
})

afterEach(() => {
  db.close()
  rmSync(dbDir, { recursive: true, force: true })
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

/** A call of the same shape as the scan / watch diff application (`FsService.applyChanges`). */
function applyChangesShaped(): void {
  const parent = store.ensureDirectory('/tmp/aios-p5', 1)
  const doomed = store.upsertFsEntry({
    parentId: parent,
    name: 'gone',
    isDirectory: true,
    ext: '',
    size: 0,
    mtimeMs: 1,
    seenAt: 1
  })
  sql = []
  store.transaction(() => {
    store.removeSubtree(doomed.id)
    const dir = store.ensureDirectory('/tmp/aios-p5/sub', 2)
    store.upsertFsEntry({
      parentId: dir,
      name: 'a.txt',
      isDirectory: false,
      ext: 'txt',
      size: 10,
      mtimeMs: 2,
      seenAt: 2
    })
    store.upsertFsEntry({
      parentId: dir,
      name: 'b.txt',
      isDirectory: false,
      ext: 'txt',
      size: 10,
      mtimeMs: 2,
      seenAt: 2
    })
  })
}

describe('P5: 入れ子トランザクションをやめる', () => {
  it('外側のトランザクションの中では SAVEPOINT を 1 回も出さない', () => {
    applyChangesShaped()
    const savepoints = sql.filter((s) => /^\s*SAVEPOINT\b/i.test(s))
    expect(savepoints).toEqual([])
    expect(sql.filter((s) => /^\s*BEGIN\b/i.test(s))).toHaveLength(1)
    expect(sql.filter((s) => /^\s*COMMIT\b/i.test(s))).toHaveLength(1)
  })

  it('外側が無ければ、いままでどおり自分でトランザクションを張る', () => {
    store.ensureDirectory('/tmp/aios-p5b', 1)
    sql = []
    store.markSkippedBulk([store.ensureRoot()])
    expect(sql.filter((s) => /^\s*BEGIN\b/i.test(s))).toHaveLength(1)
    expect(sql.filter((s) => /^\s*SAVEPOINT\b/i.test(s))).toEqual([])
  })

  it('`atomically` は既にトランザクション中かどうかを `db.inTransaction` で見る', () => {
    let inner: boolean | null = null
    store.transaction(() => {
      store.atomically(() => {
        inner = db.inTransaction
      })
    })
    expect(inner).toBe(true)
  })
})

/** The smallest IndexService needed for an index build. It puts N files in place and runs it. */
function buildService(
  files: number,
  idle?: IndexIdlePolicy
): { index: IndexService; statuses: IndexStatus[] } {
  // macOS's tmpdir() hits the exclusion of 4.4.2, so create it under home.
  root = makeTestDir('loop-files')
  mkdirSync(join(root, 'n'), { recursive: true })
  const parent = store.ensureDirectory(join(root, 'n'), 1)
  for (let i = 0; i < files; i += 1) {
    const name = `f${i}.md`
    writeFileSync(join(root, 'n', name), `# 見出し ${i}\n\n本文の検索テストです。index ${i}\n`)
    store.upsertFsEntry({
      parentId: parent,
      name,
      isDirectory: false,
      ext: 'md',
      size: 40,
      mtimeMs: i + 1,
      seenAt: 1
    })
  }
  const statuses: IndexStatus[] = []
  const index = new IndexService({
    db,
    store,
    // Since reading the canonical copy became a reverse RPC to main in P1, this entry is async.
    conversation: { readEventText: async () => null, threadTitle: async () => null },
    transcripts: null,
    ...(idle === undefined ? {} : { idle }),
    onStatus: (status) => statuses.push(status)
  })
  return { index, statuses }
}

describe('P2: N 文書 = 1 トランザクション', () => {
  it('1 バッチぶんの文書が 1 つの BEGIN / COMMIT の中で書かれる', async () => {
    const { index } = buildService(12)
    sql = []
    await index.build()
    await index.stop()

    const begins = sql.filter((s) => /^\s*BEGIN\b/i.test(s)).length
    const inserts = sql.filter((s) => /INSERT INTO chunk_fts\s*\(rowid/i.test(s)).length
    expect(inserts).toBeGreaterThanOrEqual(12)
    // 12 documents fit in one batch (BATCH_SIZE = 40), so the write happens once.
    // Even if a few transactions are added by the final tally and the like, it is far fewer than the number of documents.
    expect(begins).toBeLessThanOrEqual(3)
    expect(sql.filter((s) => /^\s*SAVEPOINT\b/i.test(s))).toEqual([])
    expect(index.getStatus().pending).toBe(0)
    expect(index.getStatus().indexed).toBe(12)
  }, 60_000)
})

describe('P3: 併合を刻む', () => {
  it('`crisismerge` が 256 に設定されている', () => {
    const row = db.prepare(`SELECT v FROM chunk_fts_config WHERE k = 'crisismerge'`).get() as
      | { v: number }
      | undefined
    expect(row?.v).toBe(256)
  })

  it('`automerge` は既定のまま (0 にすると 2,000 セグメントで SQLITE_FULL)', () => {
    const row = db.prepare(`SELECT v FROM chunk_fts_config WHERE k = 'automerge'`).get() as
      | { v: number }
      | undefined
    // By default nothing is written (there is no row). Even if it is specified, it is not 0.
    expect(row?.v ?? 4).not.toBe(0)
  })

  it('`mergeStep` は併合する仕事の量を返し、繰り返すと 0 になる', async () => {
    const { index } = buildService(30)
    await index.build()
    await index.stop()
    let steps = 0
    for (; steps < 50; steps += 1) {
      if (store.mergeStep(64) === 0) break
    }
    expect(steps).toBeLessThan(50)
    expect(store.mergeStep(64)).toBe(0)
    // Even when stopped at the limit, the segments remain (merging them into one is the job of optimize).
    expect(store.ftsSegments()).toBeGreaterThanOrEqual(0)
  }, 60_000)
})

describe('P4 → TODO 434: 速さの段 (全速 / 低速 / 待機)', () => {
  /**
   * The timer is advanced by hand (it does not wait for real time). The same shape as the test of `ScanScheduler`.
   */
  function manualTimer(): {
    schedule: (fn: () => void, ms: number) => () => void
    fire: () => void
    pending: () => number
    cancels: () => number
  } {
    let fns: (() => void)[] = []
    let cancels = 0
    return {
      schedule: (fn) => {
        fns.push(fn)
        return () => {
          cancels += 1
          fns = fns.filter((f) => f !== fn)
        }
      },
      fire: () => {
        for (const fn of [...fns]) fn()
      },
      pending: () => fns.length,
      cancels: () => cancels
    }
  }

  /**
   * Fake CPU time and sleep. CPU time advances by 2 ms each time it is read (it does not wait for real time).
   * `onSleep` is called for each slice of sleep: the test wakes here what happened while it was resting.
   */
  function fakePacer(onSleep: (ms: number) => void = () => {}): {
    pacer: SlowPacer
    sleeps: number[]
  } {
    let cpu = 0
    const sleeps: number[] = []
    const pacer = new SlowPacer({
      cpuMicros: () => (cpu += 2_000),
      sleep: async (ms) => {
        sleeps.push(ms)
        onSleep(ms)
      }
    })
    return { pacer, sleeps }
  }

  async function settle(index: IndexService): Promise<void> {
    // Wait until what was run from the timer without waiting for `build` has finished.
    for (let i = 0; i < 300 && index.getStatus().state === 'building'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await index.idle()
  }

  it('操作中 (バッテリーでも) は待たずに低速で進み、最後まで索引する', async () => {
    const timer = manualTimer()
    const firstSteps: number[] = []
    const { pacer, sleeps } = fakePacer(() => {
      if (firstSteps.length === 0) firstSteps.push(store.counters().indexed)
    })
    const { index, statuses } = buildService(25, {
      idleSeconds: () => 1,
      schedule: timer.schedule,
      pacer
    })
    await index.build()
    expect(index.getStatus().state).toBe('done')
    expect(store.counters().pending).toBe(0)
    // The status bar was showing "slow".
    expect(statuses.some((s) => s.state === 'building' && s.message === 'slow')).toBe(true)
    expect(statuses.some((s) => s.state === 'waiting')).toBe(false)
    // **A step is small** (up to 10 items, not the 40 of full speed).
    expect(firstSteps[0]).toBeGreaterThan(0)
    expect(firstSteps[0]).toBeLessThanOrEqual(10)
    // It rests after each step (25 items / 10 items → 3 or more steps).
    expect(sleeps.length).toBeGreaterThanOrEqual(3)
    expect(sleeps.every((ms) => ms > 0)).toBe(true)
    await index.stop()
  }, 60_000)

  it('休みの長さは 1 歩の CPU 時間の (100/N − 1) 倍で、500 ms ごとに刻んで早めに起きられる', async () => {
    let cpu = 0
    const sleeps: number[] = []
    let wake = false
    const pacer = new SlowPacer({
      cpuMicros: () => cpu,
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    })
    expect(pacer.dutyPercent).toBe(SLOW_DUTY_PERCENT)
    const clock = pacer.clock()
    cpu += 30_000 // 30 ms of CPU time
    const rest = clock.restMs()
    expect(rest).toBeCloseTo(30 * (100 / SLOW_DUTY_PERCENT - 1))
    // With N = 10, it is 270 ms → one slice.
    await pacer.rest(1_200, () => wake)
    expect(sleeps).toEqual([500, 500, 200])
    // If one item that cannot be split takes 2 seconds, rest that much longer (it is not postponed).
    cpu += 2_000_000
    expect(clock.restMs()).toBeCloseTo(2_000 * (100 / SLOW_DUTY_PERCENT - 1))
    // If the condition to wake is set, discard the rest and wake.
    sleeps.length = 0
    let slices = 0
    await pacer.rest(10_000, () => (slices += 1) > 2)
    expect(sleeps).toEqual([500, 500])
    wake = true
    sleeps.length = 0
    await pacer.rest(10_000, () => wake)
    expect(sleeps).toEqual([])
    // Edges of the pure function
    expect(restMsFor(0)).toBe(0)
    expect(restMsFor(1_000, 20)).toBeCloseTo(4)
    expect(restMsFor(1_000, 100)).toBe(0)
  })

  it('段の判定 (decidePace): アイドルは全速、操作中は低速、熱 / Low Power は待機。電源は見ない', () => {
    const base = { idleSeconds: 1, idleThresholdSeconds: 300, thermalState: 'nominal', lowPower: false } as const
    expect(decidePace(base)).toBe('slow')
    expect(decidePace({ ...base, idleSeconds: 300 })).toBe('full')
    expect(decidePace({ ...base, thermalState: 'fair' })).toBe('slow')
    expect(decidePace({ ...base, thermalState: 'serious' })).toBe('hold')
    expect(decidePace({ ...base, idleSeconds: 10_000, thermalState: 'critical' })).toBe('hold')
    expect(decidePace({ ...base, idleSeconds: 10_000, lowPower: true })).toBe('hold')
    expect(decidePace({ ...base, thermalState: 'unknown' })).toBe('slow')
  })

  it('熱が serious 以上なら走らず、`waiting` (thermal) になる', async () => {
    const timer = manualTimer()
    const { index } = buildService(4, {
      idleSeconds: () => 10_000,
      thermalState: () => 'serious',
      schedule: timer.schedule
    })
    await index.build()
    expect(index.getStatus().state).toBe('waiting')
    expect(index.getStatus().message).toBe('thermal')
    expect(index.getStatus().pending).toBeGreaterThan(0)
    await index.stop()
  }, 60_000)

  it('Low Power Mode なら走らず、`waiting` (low-power) になる', async () => {
    const timer = manualTimer()
    const { index } = buildService(4, {
      idleSeconds: () => 1,
      lowPower: () => true,
      schedule: timer.schedule
    })
    await index.build()
    expect(index.getStatus().state).toBe('waiting')
    expect(index.getStatus().message).toBe('low-power')
    await index.stop()
  }, 60_000)

  it('低速で走っている間にアイドルになると、次の歩から全速に戻る (休みも途中で起きる)', async () => {
    const timer = manualTimer()
    let idle = 1
    const { pacer, sleeps } = fakePacer(() => {
      idle = 10_000
    })
    const { index, statuses } = buildService(60, {
      idleSeconds: () => idle,
      schedule: timer.schedule,
      pacer
    })
    await index.build()
    expect(index.getStatus().state).toBe('done')
    // It rested only after the first step (it became idle during that rest).
    expect(sleeps).toHaveLength(1)
    const messages = statuses.filter((s) => s.state === 'building').map((s) => s.message)
    expect(messages).toContain('slow')
    // After "slow", a building status at full speed (message: null) appears.
    expect(messages.lastIndexOf(null)).toBeGreaterThan(messages.indexOf('slow'))
    await index.stop()
  }, 60_000)

  it('走行中に熱が上がると、次の歩の境界で止まって `waiting` になり、熱が引けば自分で続ける', async () => {
    const timer = manualTimer()
    let thermal: 'nominal' | 'serious' = 'nominal'
    let heated = false
    // It heats up only once, during the first rest.
    const { pacer } = fakePacer(() => {
      if (heated) return
      heated = true
      thermal = 'serious'
    })
    const { index } = buildService(30, {
      idleSeconds: () => 1,
      thermalState: () => thermal,
      schedule: timer.schedule,
      pacer
    })
    await index.build()
    const status = index.getStatus()
    expect(status.state).toBe('waiting')
    expect(status.message).toBe('thermal')
    // **A step has advanced**. It does not stop in the middle of a document (it is checked at step boundaries).
    const counters = store.counters()
    expect(counters.indexed).toBeGreaterThan(0)
    expect(counters.indexed).toBeLessThanOrEqual(10)
    expect(counters.pending).toBe(30 - counters.indexed)
    // The timer is set while waiting. Nothing happens while the heat remains.
    expect(timer.pending()).toBe(1)
    timer.fire()
    expect(index.getStatus().state).toBe('waiting')
    // If the heat drops, it continues by itself (it stays in operation, so it is slow).
    thermal = 'nominal'
    timer.fire()
    await settle(index)
    expect(store.counters().pending).toBe(0)
    await index.stop()
  }, 60_000)

  it('ユーザが押した「再開」(manual) も 434 と同じ判定を通す — 熱 / Low Power Mode なら待つ (TODO 448)', async () => {
    const timer = manualTimer()
    const { index } = buildService(12, {
      // Heat is critical and Low Power. Previously only manual did not pass the judgment and ran to the end at full speed, but at 448 it was aligned with the full scan at startup: it enters waiting, and advances not even one item.
      idleSeconds: () => 0,
      thermalState: () => 'critical',
      lowPower: () => true,
      schedule: timer.schedule
    })
    await index.build({ manual: true })
    expect(index.getStatus().state).toBe('waiting')
    expect(store.counters().pending).toBeGreaterThan(0)
    await index.stop()
  }, 60_000)

  it('ユーザが押した「再開」(manual) は操作中なら低速で、最後まで進む (TODO 448)', async () => {
    const timer = manualTimer()
    const { pacer, sleeps } = fakePacer()
    const { index } = buildService(12, {
      idleSeconds: () => 1,
      thermalState: () => 'nominal',
      schedule: timer.schedule,
      pacer
    })
    await index.build({ manual: true })
    expect(index.getStatus().state).toBe('done')
    expect(store.counters().pending).toBe(0)
    // It walked slowly because it was in operation (rests were inserted), not at full speed (no rests).
    expect(sleeps.length).toBeGreaterThan(0)
    await index.stop()
  }, 60_000)

  it('「停止」は自動では解けない (監視の差分・タイマーで再開しない)。「再開」でだけ解ける', async () => {
    const timer = manualTimer()
    let index: IndexService | null = null
    let idle = 1
    const { pacer } = fakePacer(() => index?.pause())
    const built = buildService(30, { idleSeconds: () => idle, schedule: timer.schedule, pacer })
    index = built.index
    await index.build()
    expect(index.getStatus().state).toBe('paused')
    const left = store.counters().pending
    expect(left).toBeGreaterThan(0)
    // Automatic resume from the end of the scan, or from a watch diff (`onIndexable` → `resume()`).
    index.resume()
    await index.idle()
    timer.fire()
    await index.idle()
    expect(index.getStatus().state).toBe('paused')
    expect(store.counters().pending).toBe(left)
    // It is resolved by the "resume" the user presses. Switch while left alone and then press it: since 448 "resume" also passes the judgment, so on entering a rest (slow while in operation) the injected `pacer` calls `pause()` again, which would spoil the point of this case (a stop is resolved only by resume).
    idle = 10_000
    await index.build({ manual: true })
    expect(store.counters().pending).toBe(0)
    await index.stop()
  }, 60_000)

  it('「停止」中は部分木の構築も走らない (TODO 1136 の 2)', async () => {
    const timer = manualTimer()
    let index: IndexService | null = null
    // Press "stop" just once at the first rest (so that it is not pressed again during a rest of the subtree run and the result is not clouded).
    let pressed = false
    const { pacer } = fakePacer(() => {
      if (pressed) return
      pressed = true
      index?.pause()
    })
    const built = buildService(30, { idleSeconds: () => 1, schedule: timer.schedule, pacer })
    index = built.index
    await index.build()
    expect(index.getStatus().state).toBe('paused')
    const left = store.counters().pending
    expect(left).toBeGreaterThan(0)
    const dir = store.findByPath(join(root, 'n'))
    expect(dir).not.toBeNull()
    const result = await index.buildSubtree(dir as number, join(root, 'n'))
    expect(result.built).toBe(0)
    expect(store.counters().pending).toBe(left)
    expect(index.getStatus().state).toBe('paused')
    await index.stop()
  }, 60_000)

  it('判定を注入しなければ今までどおり無条件に全速で走る', async () => {
    const { index, statuses } = buildService(4)
    await index.build()
    expect(index.getStatus().state).toBe('done')
    expect(statuses.some((s) => s.message === 'slow')).toBe(false)
    await index.stop()
  }, 60_000)

  it('`stop()` は待機中のタイマーを止める (12.9: 閉じた後に書かない)', async () => {
    const timer = manualTimer()
    const { index } = buildService(4, {
      idleSeconds: () => 0,
      thermalState: () => 'serious',
      schedule: timer.schedule
    })
    await index.build()
    expect(timer.pending()).toBe(1)
    await index.stop()
    expect(timer.cancels()).toBeGreaterThanOrEqual(1)
    expect(timer.pending()).toBe(0)
  }, 60_000)

  it('段の切り替わりと 60 秒ごとに `index.pace` を 1 行出す (CPU 時間 / 経過時間と件数だけ)', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {})
    try {
      let now = 0
      let cpu = 0
      const pacer = new SlowPacer({ now: () => now, cpuMicros: () => cpu, sleep: async () => {} })
      pacer.note('build', 'slow', 10)
      expect(pacer.paceOf('build')).toBe('slow')
      expect(info).toHaveBeenCalledWith('index.pace.change', expect.objectContaining({ worker: 'build', to: 'slow' }))
      // 3 seconds of CPU time in 30 seconds = 10%. 60 seconds have not passed yet, so it is not shown.
      now += 30_000
      cpu += 3_000_000
      pacer.note('build', 'slow', 10)
      expect(info.mock.calls.filter(([event]) => event === 'index.pace')).toHaveLength(0)
      now += 30_000
      cpu += 3_000_000
      pacer.note('scan', 'slow', 250)
      const lines = info.mock.calls.filter(([event]) => event === 'index.pace')
      // One line at the switch of the scan stage (the window so far), then one line at the 60-second boundary.
      expect(lines.length).toBeGreaterThanOrEqual(1)
      expect(lines[0]?.[1]).toMatchObject({ cpuMs: 6_000, elapsedMs: 60_000, cpuPercent: 10, built: 20 })
      for (const [, fields] of lines) {
        expect(Object.keys(fields as object).sort()).toEqual(
          ['build', 'built', 'cpuMs', 'cpuPercent', 'dutyPercent', 'elapsedMs', 'reason', 'restMs', 'scan', 'scanned', 'steps'].sort()
        )
      }
      pacer.idle('build')
      pacer.idle('scan')
      expect(pacer.paceOf('build')).toBeNull()
      expect(pacer.paceOf('scan')).toBeNull()
    } finally {
      info.mockRestore()
    }
  })
})
