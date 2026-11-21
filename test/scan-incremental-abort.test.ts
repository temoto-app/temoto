/**
 * Clean-up after an interrupted incremental scan (item 250, ARCHITECTURE.md 6.2.2).
 *
 * An incremental scan rewrites the rows of directories whose mtime changed to the new mtime, in the batch **before** it opens them
 * (`walk` makes the row when it finds the directory, and opens it after the breadth-first queue). If it is then interrupted by "the operation returned",
 * the next incremental scan treats that row as "same as last time" and prunes it, and changes inside it did not get in until the deep scan (7 days).
 * Likewise, if it was interrupted after the walk finished but before the clean-up (which is scoped), the rows of deleted files remained.
 *
 * What must hold:
 * 1. A directory interrupted before it was opened is opened by the next incremental scan (added files come in, deleted files drop out).
 * 2. A "directory whose mtime changed" that finished walking but was interrupted before the clean-up is also cleaned by the next incremental scan.
 * 3. The mtime of rows of new directories that finished walking, and of unchanged directories, is not touched.
 * 4. Even when a manual rescan (a deep scan) is stopped by shutdown and the next launch is an incremental scan, it is picked up the same way.
 *
 * So that it does not depend on time, the directory's mtime is moved explicitly with `utimes`. The interruption uses the same entry point as the scheduled-run interruption (`abortAutoScan`), called from the state notification (which arrives after each batch is written).
 * Uses the real encrypted DB and real directories. Does not call the model.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { ScanStatus } from '../src/shared/types.js'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { makeTestDir } from './helpers/tmp.js'

const KEY = 'e'.repeat(64)
/** Puts files directly under the root, enough to span one batch (`walk`'s default is 2,000 entries). */
const BULK = 2_500

let base: string
let dbDir: string
let db: Db
let store: IndexStore

const home = (): string => join(base, 'home')
const dirA = (): string => join(home(), 'a')
const dirQ = (): string => join(home(), 'quiet')

/** Hook called on each state notification. If it returns true, the scan is interrupted. */
let stopWhen: ((status: ScanStatus) => boolean) | null = null
/** How to interrupt. The default is interrupting the scheduled run (the operation returned); `quit` is shutdown (`stop()`). */
let stopBy: 'auto' | 'quit' = 'auto'
let service: FsIndexer

function makeService(): FsIndexer {
  const created: FsIndexer = new FsIndexer(
    db,
    {
      onScanStatus: (status) => {
        if (status.state !== 'scanning' || stopWhen === null) return
        if (!stopWhen(status)) return
        stopWhen = null
        // Shutdown (`stop()` waits for the running scan; here it only sets the flag without waiting).
        if (stopBy === 'quit') void created.stop()
        // The same entry point as the scheduled-run interruption (the operation returned).
        else (created as unknown as { abortAutoScan(reason: string): void }).abortAutoScan('test')
      },
      onFileChanges: () => {}
    },
    store,
    home(),
    [home()],
    { volumesDir: join(base, 'Volumes'), probeUuid: async () => null }
  )
  return created
}

/** The incremental scan of the scheduled run (home only, with pruning). */
const incremental = (): Promise<void> =>
  service.scan({ deep: false, auto: true, roots: [home()] })

const mtimeOf = (path: string): number | null => {
  const id = store.findByPath(path)
  if (id === null) return null
  return (db.prepare(`SELECT mtime_ms FROM documents WHERE id = ?`).get(id) as { mtime_ms: number })
    .mtime_ms
}
const lastRunState = (): string =>
  (
    db.prepare(`SELECT state FROM scan_runs ORDER BY started_at DESC, id DESC LIMIT 1`).get() as {
      state: string
    }
  ).state

/**
 * The `indexed` (= the entries `walk` records) when an incremental scan runs to completion. Subtracts from all entries under the root
 * the contents of the directories that are pruned and not opened (`pruned`).
 */
const entriesWalked = (pruned: readonly string[]): number =>
  readdirSync(home(), { recursive: true }).length -
  pruned.reduce((sum, dir) => sum + readdirSync(dir, { recursive: true }).length, 0)

beforeAll(async () => {
  base = makeTestDir('incr-abort-test')
  dbDir = makeTestDir('incr-abortdb-test')
  mkdirSync(dirA(), { recursive: true })
  mkdirSync(dirQ(), { recursive: true })
  writeFileSync(join(dirA(), 'old.md'), '# 消える\n')
  writeFileSync(join(dirQ(), 'kept.md'), '# 静かな側\n')
  for (let i = 0; i < BULK; i += 1) writeFileSync(join(home(), `bulk-${i}.txt`), 'x')

  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
  service = makeService()
  // The "previous" index = one deep scan.
  await service.scan({ deep: true })
}, 60_000)

afterAll(async () => {
  await service.stop()
  if (db.open) db.close()
  rmSync(base, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

describe('cleanup after an interrupted incremental scan (item 250)', () => {
  it('a directory interrupted before opening is opened by the next incremental scan', async () => {
    const quietBefore = mtimeOf(dirQ())
    expect(quietBefore).toBeGreaterThan(0)
    rmSync(join(dirA(), 'old.md'))
    writeFileSync(join(dirA(), 'new.md'), '# 増えた\n')
    utimesSync(dirA(), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
    // A directory that did not exist last time (no clean-up is needed, but its contents do not get in unless it is opened).
    const born = join(home(), 'born')
    mkdirSync(born)
    writeFileSync(join(born, 'child.md'), '# 新しいディレクトリの中\n')
    utimesSync(born, new Date('2019-01-01T00:00:00Z'), new Date('2019-01-01T00:00:00Z'))

    // The first batch is written in the middle of listing the root's direct children (2,500 + 2 entries) → interrupt there.
    // The root listing goes to the end, so the row for `a` is written with the new mtime, but `a` is not opened.
    stopWhen = (status) => status.indexed > 0
    await incremental()
    expect(stopWhen).toBeNull()
    expect(lastRunState()).toBe('aborted')
    expect(store.findByPath(join(dirA(), 'new.md'))).toBeNull()
    // `a`, which was not opened, forgets its mtime. The unchanged `quiet` (pruned) is not touched.
    expect(mtimeOf(dirA())).toBe(0)
    expect(mtimeOf(born)).toBe(0)
    expect(store.findByPath(join(born, 'child.md'))).toBeNull()
    expect(mtimeOf(dirQ())).toBe(quietBefore)

    // The next incremental scan (no interruption) opens `a` and reflects what was added and what was removed.
    await incremental()
    expect(lastRunState()).toBe('done')
    expect(store.findByPath(join(dirA(), 'new.md'))).not.toBeNull()
    expect(store.findByPath(join(dirA(), 'old.md'))).toBeNull()
    expect(mtimeOf(dirA())).toBe(Date.parse('2020-01-01T00:00:00Z'))
    expect(store.findByPath(join(born, 'child.md'))).not.toBeNull()
    expect(mtimeOf(born)).toBe(Date.parse('2019-01-01T00:00:00Z'))
  }, 60_000)

  it('a "changed directory" that finished walking but was interrupted before cleanup is cleaned by the next incremental scan', async () => {
    rmSync(join(dirA(), 'new.md'))
    writeFileSync(join(dirA(), 'newer.md'), '# もう 1 つ\n')
    utimesSync(dirA(), new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'))
    const fresh = join(home(), 'fresh')
    mkdirSync(fresh)
    writeFileSync(join(fresh, 'inside.md'), '# 新しいディレクトリ\n')
    utimesSync(fresh, new Date('2022-01-01T00:00:00Z'), new Date('2022-01-01T00:00:00Z'))

    // Interrupted after the last batch was written (= everything was walked) → the clean-up does not run.
    // `quiet`, and `born` which got in during the previous run, have the same mtime, so they are pruned.
    const total = entriesWalked([dirQ(), join(home(), 'born')])
    stopWhen = (status) => status.indexed >= total
    await incremental()
    expect(stopWhen).toBeNull()
    expect(lastRunState()).toBe('aborted')
    // It was walked, so the additions are in. The clean-up did not run, so the deletions still remain.
    expect(store.findByPath(join(dirA(), 'newer.md'))).not.toBeNull()
    expect(store.findByPath(join(dirA(), 'new.md'))).not.toBeNull()
    // `a`, which needs clean-up, forgets its mtime. The new directory `fresh`, which finished walking, is not touched.
    expect(mtimeOf(dirA())).toBe(0)
    expect(mtimeOf(fresh)).toBe(Date.parse('2022-01-01T00:00:00Z'))

    await incremental()
    expect(lastRunState()).toBe('done')
    expect(store.findByPath(join(dirA(), 'new.md'))).toBeNull()
    expect(store.findByPath(join(dirA(), 'newer.md'))).not.toBeNull()
    expect(store.findByPath(join(fresh, 'inside.md'))).not.toBeNull()
  }, 60_000)

  it('even if a manual rescan (deep scan) is stopped by shutdown, the next startup incremental scan picks it up', async () => {
    rmSync(join(dirA(), 'newer.md'))
    writeFileSync(join(dirA(), 'newest.md'), '# 3 つ目\n')
    utimesSync(dirA(), new Date('2023-01-01T00:00:00Z'), new Date('2023-01-01T00:00:00Z'))
    const quietBefore = mtimeOf(dirQ())

    // Shutdown during the first batch (in the middle of the root listing) → the deep scan stops without opening `a`.
    stopBy = 'quit'
    stopWhen = (status) => status.indexed > 0
    try {
      await service.rescan()
    } finally {
      stopBy = 'auto'
    }
    expect(stopWhen).toBeNull()
    expect(lastRunState()).toBe('aborted')
    expect(store.findByPath(join(dirA(), 'newest.md'))).toBeNull()
    expect(mtimeOf(dirA())).toBe(0)
    // Even a deep scan that does not prune does not put back the row of the unchanged `quiet` (it can still be pruned by the next incremental scan).
    expect(mtimeOf(dirQ())).toBe(quietBefore)

    // The next launch = a new FsIndexer. The previous deep scan is new, so the continuation of `aborted` is an incremental scan.
    service = makeService()
    await incremental()
    expect(lastRunState()).toBe('done')
    expect(store.findByPath(join(dirA(), 'newest.md'))).not.toBeNull()
    expect(store.findByPath(join(dirA(), 'newer.md'))).toBeNull()
  }, 60_000)
})
