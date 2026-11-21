/**
 * Idle cleanup of the index process (`src/index-kernel/upkeep.ts`).
 *
 * - TODO 945: deletes the accumulated orphan FTS rows (rowids in `chunk_fts` that are not in `chunks`) in batches.
 * - TODO 946: back-fills the `lossy` mark on non-UTF-8 files that were indexed before 925 (the body is not kept, and nothing is re-indexed).
 *
 * Real SQLite (encrypted, on disk) and the real disk (`~/.aios-test/<run>/`). The model is not called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import {
  INDEX_FTS_ORPHAN_CURSOR,
  INDEX_FTS_REBUILD_CURSOR,
  INDEX_LOSSY_BACKFILL_CURSOR
} from '../src/common/settings-keys.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { FTS_SWEEP_BATCH, FTS_SWEEP_MAX_DELETES, IdleUpkeep, UPKEEP_DONE } from '../src/index-kernel/upkeep.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

let dbDir: string
let db: Db
let store: IndexStore
let settings: AppSettingsStore

beforeEach(() => {
  dbDir = makeTestDir('upkeep-db')
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${'e'.repeat(64)}'`)
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
  settings = new AppSettingsStore(db)
})

afterEach(() => {
  if (db.open) db.close()
  rmSync(dbDir, { recursive: true, force: true })
})

/** One real document and its two chunks (`livewordN`). */
function liveDocument(n: number): number {
  const parent = store.ensureDirectory('/tmp/aios-upkeep', 1)
  const { id } = store.upsertFsEntry({
    parentId: parent,
    name: `live${n}.txt`,
    isDirectory: false,
    ext: 'txt',
    size: 10,
    mtimeMs: 1,
    seenAt: 1
  })
  store.replaceChunks(
    id,
    [
      { shadow: `liveword${n} alpha`, byteStart: 0, byteEnd: 5, chars: 5 },
      { shadow: `liveword${n} beta`, byteStart: 5, byteEnd: 10, chars: 5 }
    ],
    { state: 'indexed', contentHash: 'h', lang: null }
  )
  return id
}

/** Plants FTS rows for rowids that are not in `chunks` (what the range-scoped cleanup from before 923 left behind). */
function plantOrphans(rowids: readonly number[]): void {
  const insert = db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`)
  db.transaction(() => {
    for (const rowid of rowids) insert.run(rowid, `ghostword orphan${rowid}`)
  })()
}

const matches = (term: string): number[] =>
  db.prepare(`SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY rowid`).pluck().all(term) as number[]
const ftsCount = (): number => db.prepare(`SELECT COUNT(*) FROM chunk_fts`).pluck().get() as number
const chunkCount = (): number => db.prepare(`SELECT COUNT(*) FROM chunks`).pluck().get() as number

function upkeepWith(options: { shouldYield?: () => boolean; ftsBatch?: number; now?: () => number } = {}): IdleUpkeep {
  let queue: Promise<void> = Promise.resolve()
  return new IdleUpkeep({
    store,
    settings,
    enqueue: (work) => {
      const result = queue.then(work)
      queue = result.catch(() => undefined)
      return result
    },
    shouldYield: options.shouldYield ?? (() => false),
    readGate: () => async () => true,
    ftsBatch: options.ftsBatch,
    now: options.now
  })
}

describe('TODO 945: IndexStore.sweepOrphanFts', () => {
  it('contentless_delete の表なので、元の語なしに rowid だけで孤児を消せる。生きたチャンクは残る', () => {
    liveDocument(1)
    plantOrphans([1_000, 1_001, 1_002])
    expect(matches('ghostword')).toEqual([1_000, 1_001, 1_002])

    const result = store.sweepOrphanFts(0, 1_000)
    expect(result.removed).toBe(3)
    expect(result.last).toBe(1_002)
    expect(matches('ghostword')).toEqual([])
    expect(matches('liveword1')).toHaveLength(2)
    expect(ftsCount()).toBe(chunkCount())
    // Nothing is left after the last one is seen.
    expect(store.sweepOrphanFts(1_002, 1_000)).toEqual({ last: null, removed: 0 })
  })

  it('束は rowid の昇順に `limit` 個で、`after` より前は見ない', () => {
    plantOrphans([10, 20, 30, 40])
    expect(store.sweepOrphanFts(15, 2)).toEqual({ last: 30, removed: 2 })
    expect(matches('ghostword')).toEqual([10, 40])
  })
})

describe('TODO 945: IdleUpkeep の孤児の FTS 行の掃除', () => {
  it('時間予算で歩みを切り、進みを app_settings に置き、済んだら UPKEEP_DONE で二度と走らない', async () => {
    liveDocument(1)
    liveDocument(2)
    plantOrphans(Array.from({ length: 30 }, (_, i) => 5_000 + i))
    // Each time a batch is looked at, the clock exceeds the budget (50 ms), so it is one batch per step.
    let clock = 0
    const upkeep = upkeepWith({ ftsBatch: 10, now: () => (clock += 100) })

    await upkeep.step()
    const cursor = settings.readTyped(INDEX_FTS_ORPHAN_CURSOR)
    expect(cursor).not.toBeNull()
    expect(cursor).toBeGreaterThan(0)
    expect(upkeep.finished()).toBe(false)
    expect(matches('ghostword').length).toBeGreaterThan(0)

    for (let i = 0; i < 20 && !upkeep.finished(); i += 1) await upkeep.step()
    expect(upkeep.finished()).toBe(true)
    expect(settings.readTyped(INDEX_FTS_ORPHAN_CURSOR)).toBe(UPKEEP_DONE)
    expect(matches('ghostword')).toEqual([])
    expect(matches('liveword1')).toHaveLength(2)
    expect(matches('liveword2')).toHaveLength(2)

    // The next launch (a new instance) only reads the key and does not touch the index.
    plantOrphans([9_000])
    const sweep = vi.spyOn(store, 'sweepOrphanFts')
    const next = upkeepWith()
    await next.step()
    await next.step() // The second step is the rebuild of TODO 965 (there are no documents to rebuild here), and it does not touch FTS.
    expect(sweep).not.toHaveBeenCalled()
    expect(matches('ghostword')).toEqual([9_000])
  })

  it('1 歩で消す数は FTS_SWEEP_MAX_DELETES で縛る (COMMIT の中の deletemerge の書き直しを小さくする)', async () => {
    plantOrphans(Array.from({ length: 1_000 }, (_, i) => 100 + i))
    // The clock does not advance, so it is not cut off by the time budget.
    const upkeep = upkeepWith({ now: () => 0 })
    await upkeep.step()
    const left = matches('ghostword').length
    expect(1_000 - left).toBeGreaterThanOrEqual(FTS_SWEEP_MAX_DELETES)
    expect(1_000 - left).toBeLessThan(FTS_SWEEP_MAX_DELETES + FTS_SWEEP_BATCH)
  })

  it('再起動は置いた進みの続きから (前に見た rowid は見直さない)', async () => {
    plantOrphans([100, 200, 300])
    settings.writeTyped(INDEX_FTS_ORPHAN_CURSOR, 150)
    const upkeep = upkeepWith()
    await upkeep.step()
    expect(settings.readTyped(INDEX_FTS_ORPHAN_CURSOR)).toBe(UPKEEP_DONE)
    expect(matches('ghostword')).toEqual([100])
  })

  it('譲るべきとき (終了・構築中・アイドルでない) は DB に触らない', async () => {
    plantOrphans([100])
    const sweep = vi.spyOn(store, 'sweepOrphanFts')
    const upkeep = upkeepWith({ shouldYield: () => true })
    await upkeep.step()
    expect(sweep).not.toHaveBeenCalled()
    expect(settings.readTyped(INDEX_FTS_ORPHAN_CURSOR)).toBeNull()
    expect(upkeep.finished()).toBe(false)
  })
})

describe('TODO 945: IndexService のアイドルの tick から', () => {
  function manualTimer(): { schedule: (fn: () => void, ms: number) => () => void; fire: () => void } {
    let fns: (() => void)[] = []
    return {
      schedule: (fn) => {
        fns.push(fn)
        return () => {
          fns = fns.filter((f) => f !== fn)
        }
      },
      fire: () => {
        for (const fn of [...fns]) fn()
      }
    }
  }

  function service(idleSeconds: () => number, timer: ReturnType<typeof manualTimer>): IndexService {
    return new IndexService({
      db,
      store,
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: null,
      onStatus: () => {},
      idle: { idleSeconds, schedule: timer.schedule }
    })
  }

  it('残件の無いアイドル (全速) の tick で掃除が進み、操作中 (低速) の tick では進まない', async () => {
    liveDocument(1)
    plantOrphans([7_000, 7_001])
    let idle = 1
    const timer = manualTimer()
    const index = service(() => idle, timer)
    await index.build()

    // While in operation (the slow stage): only merging, and the cleanup does not start.
    timer.fire()
    await index.idle()
    expect(matches('ghostword')).toEqual([7_000, 7_001])

    idle = 10_000
    timer.fire()
    await index.idle()
    expect(matches('ghostword')).toEqual([])
    expect(settings.readTyped(INDEX_FTS_ORPHAN_CURSOR)).toBe(UPKEEP_DONE)
    expect(matches('liveword1')).toHaveLength(2)
    await index.stop()
  }, 30_000)

  it('終了の後の tick は DB に触らない (閉じた DB に書かない、12.9)', async () => {
    plantOrphans([7_000])
    const timer = manualTimer()
    const index = service(() => 10_000, timer)
    await index.build()
    const sweep = vi.spyOn(store, 'sweepOrphanFts')
    await index.stop()
    db.close()
    // Even if the function of a stopped timer remains in hand, it is called but does not touch the closed DB.
    expect(() => timer.fire()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sweep).not.toHaveBeenCalled()
  }, 30_000)
})

describe('TODO 946: 索引済みの UTF-8 でないファイルへの lossy の後付け', () => {
  let root: string | undefined
  let index: IndexService | undefined
  let fsIndexer: FsIndexer | undefined

  /** The first half is Shift_JIS (the hiragana letter is 0x82 0xA0, which is invalid as UTF-8); the second half is ASCII. */
  function shiftJis(): Buffer {
    const line = Buffer.concat([...Array.from({ length: 40 }, () => Buffer.from([0x82, 0xa0])), Buffer.from('\n')])
    return Buffer.concat([line, line, Buffer.from('the Laterword appears here\n')])
  }

  const metadataOf = (name: string): string | null =>
    (db.prepare(`SELECT metadata FROM documents WHERE source = 'fs' AND name = ?`).get(name) as { metadata: string | null })
      .metadata

  /** The shape of a DB indexed before 925: scanned and built, with the marks removed. */
  async function indexedWithoutMarks(): Promise<IndexService> {
    const dir = makeTestDir('upkeep-lossy')
    root = dir
    writeFileSync(join(dir, 'sjis.txt'), shiftJis())
    writeFileSync(join(dir, 'utf8.txt'), `${'日本語の本文です。\n'.repeat(50)}the Laterword\n`)
    writeFileSync(join(dir, 'later.txt'), shiftJis())
    const indexer = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, dir, [dir])
    fsIndexer = indexer
    const service = new IndexService({
      db,
      store,
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: null,
      fsRules: () => indexer.exclusionRules,
      onStatus: () => {}
    })
    index = service
    await indexer.scan()
    await service.build()
    expect(metadataOf('sjis.txt')).toBe('{"lossy":true}')
    db.prepare(`UPDATE documents SET metadata = NULL WHERE source = 'fs'`).run()
    // Treat the cleanup of TODO 945 as already done (here only the back-fill is checked).
    settings.writeTyped(INDEX_FTS_ORPHAN_CURSOR, UPKEEP_DONE)
    // Treat the rebuild of TODO 965 as also done in the earlier launch (as soon as it is done, 946 is also marked done, so it is not run here).
    settings.writeTyped(INDEX_FTS_REBUILD_CURSOR, UPKEEP_DONE)
    return service
  }

  afterEach(async () => {
    await index?.stop()
    await fsIndexer?.stop()
    if (root !== undefined) removeTestDir(root)
    index = undefined
    fsIndexer = undefined
    root = undefined
  })

  it('UTF-8 でないファイルにだけ印を付け、済んだら UPKEEP_DONE。索引し直しはしない', async () => {
    const service = await indexedWithoutMarks()
    // A file that changed after indexing (a different version): no mark is set (re-indexing sets it).
    writeFileSync(join(root as string, 'later.txt'), Buffer.concat([shiftJis(), Buffer.from('more\n')]))
    const chunksBefore = chunkCount()
    const replace = vi.spyOn(store, 'replaceChunks')
    const upkeep = upkeepWith()
    for (let i = 0; i < 20 && !upkeep.finished(); i += 1) await upkeep.step()
    expect(upkeep.finished()).toBe(true)
    expect(settings.readTyped(INDEX_LOSSY_BACKFILL_CURSOR)).toBe(UPKEEP_DONE)
    expect(metadataOf('sjis.txt')).toBe('{"lossy":true}')
    expect(metadataOf('utf8.txt')).toBeNull()
    expect(metadataOf('later.txt')).toBeNull()
    expect(replace).not.toHaveBeenCalled()
    expect(chunkCount()).toBe(chunksBefore)

    // Since the mark is set, the snippet is cut from the decoded string (the display path of 925).
    const result = await service.search('Laterword', 'files', {})
    const hit = result.hits.find((h) => h.title === 'sjis.txt')
    expect(hit?.snippet).toContain('Laterword')
  }, 30_000)

  it('読む関門 (除外・realpath) が断ったファイルは読まない', async () => {
    await indexedWithoutMarks()
    let queue: Promise<void> = Promise.resolve()
    const asked: string[] = []
    const upkeep = new IdleUpkeep({
      store,
      settings,
      enqueue: (work) => (queue = queue.then(work)),
      shouldYield: () => false,
      readGate: () => async (path) => {
        asked.push(path)
        return false
      }
    })
    for (let i = 0; i < 20 && !upkeep.finished(); i += 1) await upkeep.step()
    expect(upkeep.finished()).toBe(true)
    expect(asked.some((path) => path.endsWith('/sjis.txt'))).toBe(true)
    expect(metadataOf('sjis.txt')).toBeNull()
  }, 30_000)

  it('読んでいる間に終了したら、閉じた DB に触らず進みも置かない (12.9)', async () => {
    await indexedWithoutMarks()
    let yieldNow = false
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let queue: Promise<void> = Promise.resolve()
    const upkeep = new IdleUpkeep({
      store,
      settings,
      // As with `IndexService.enqueue`, work queued after the end is not run.
      enqueue: (work) => (yieldNow ? Promise.resolve() : (queue = queue.then(work))),
      shouldYield: () => yieldNow,
      readGate: () => async () => {
        await blocked
        return true
      }
    })
    const step = upkeep.step()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // End: set the yield mark, and return the reads after closing the DB.
    yieldNow = true
    await index?.stop()
    await fsIndexer?.stop()
    db.close()
    release()
    await expect(step).resolves.toBeUndefined()
    expect(upkeep.finished()).toBe(false)
  }, 30_000)
})
