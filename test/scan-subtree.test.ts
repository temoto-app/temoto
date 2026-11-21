/**
 * Subtree scan at thread creation (item 246, ARCHITECTURE.md 6.2.2 "subtree scan at thread creation").
 *
 * What must hold:
 * 1. A folder created while aios was stopped (= a tree made after the full scan, which the watcher did not see either), when `scanSubtree`-ed, appears in the "this working folder" section of file-name search (item 100 / `@` in 114).
 * 2. Choke point: exclusions (under `~/Library`, under `node_modules`), outside home, the scan root itself, and nonexistent paths are not walked.
 * 3. When cut off at the limit, it returns `truncated`, and the tree left unopened is picked up by the next incremental scan (it makes that scan forget the mtime).
 * 4. It does not overlap with any running full scan (the subtree is deferred; the full scan waits for the subtree that is running).
 * 5. Requests for the same path are merged, and a second pass over an unchanged tree writes no rows at all. Deleted files drop out in the scoped clean-up.
 * 6. (item 249) After a subtree scan, the bodies of that subtree are built **even when not idle**, and appear in the "this working folder" section of body search. What exceeds the limit, and bodies pending outside the subtree, are not built.
 *
 * Uses the real SQLite (in memory) and real directories. Does not call the model.
 * On macOS `os.tmpdir()` is under /var/folders and hits the exclusions in 4.4.2, so the directories are created under home
 * (same as `test/scan-incremental.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { ScanStatus } from '../src/shared/types.js'
import { runMigrations } from '../src/common/migrations.js'
import { pathToUri } from '../src/common/uri.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexService, type SubtreeBuildResult } from '../src/index-kernel/service.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { makeTestDir } from './helpers/tmp.js'

let base: string
let db: Db
let store: IndexStore
let service: FsIndexer
let statuses: ScanStatus['state'][]

/** The index's home (in tests, under a temporary directory). */
const home = (): string => join(base, 'home')

function makeService(): FsIndexer {
  return new FsIndexer(
    db,
    { onScanStatus: (status) => statuses.push(status.state), onFileChanges: () => {} },
    store,
    home(),
    [home()],
    { volumesDir: join(base, 'Volumes'), probeUuid: async () => null }
  )
}

/** The names that appeared in the "this working folder" section of file-name search. null if there is no such section. */
async function cwdNames(query: string, cwd: string): Promise<string[] | null> {
  const result = await service.searchFiles(query, 50, pathToUri(cwd))
  if (result.cwd === null) return null
  return result.cwd.entries.map((entry) => entry.name).sort()
}

const mtimeOf = (path: string): number | null => {
  const id = store.findByPath(path)
  if (id === null) return null
  return (db.prepare(`SELECT mtime_ms FROM documents WHERE id = ?`).get(id) as { mtime_ms: number })
    .mtime_ms
}

/** The shape of a new repository (two levels plus files directly under the root). */
function makeRepo(root: string): void {
  mkdirSync(join(root, 'src', 'lib'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# repo\n')
  writeFileSync(join(root, 'src', 'widget.ts'), 'export const widget = 1\n')
  writeFileSync(join(root, 'src', 'lib', 'widget-util.ts'), 'export const util = 1\n')
}

beforeEach(async () => {
  base = makeTestDir('subtree-test')
  mkdirSync(join(home(), 'old'), { recursive: true })
  writeFileSync(join(home(), 'old', 'kept.md'), '# 前からある\n')
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
  statuses = []
  service = makeService()
  // The index "before aios is closed" = one deep scan. Trees made after that are not seen by the watcher either.
  await service.scan({ deep: true })
})

afterEach(async () => {
  await service.stop()
  db.close()
  rmSync(base, { recursive: true, force: true })
})

describe('スレッド作成時の部分木走査 (項目 246)', () => {
  it('止まっている間に作ったフォルダが、部分木走査の後に「この作業フォルダ」区画に出る', async () => {
    const repo = join(home(), 'git', 'new-repo')
    makeRepo(repo)
    // The symptom of item 244: the section itself does not exist, because the folder is not in the index.
    expect(await cwdNames('widget', repo)).toBeNull()

    statuses = []
    const result = await service.scanSubtree(repo)
    expect(result).toMatchObject({ state: 'done', removed: 0 })
    if (result.state === 'skipped') throw new Error('skipped')
    // Rows: new-repo itself + README.md / src / widget.ts / lib / widget-util.ts. The ancestor git is also created.
    expect(result.seen).toBe(5)
    expect(result.written).toBe(6)

    expect(await cwdNames('widget', repo)).toEqual(['widget-util.ts', 'widget.ts'])
    // The root row has the real mtime (it can be pruned by the next incremental scan). The ancestor git is 0 (the next incremental scan opens it).
    expect(mtimeOf(repo)).toBeGreaterThan(0)
    expect(mtimeOf(join(home(), 'git'))).toBe(0)
    // Not a full scan: nothing is shown on the status bar (`ScanStatus`).
    expect(statuses).toEqual([])
  })

  it('変わっていない木の 2 回目は 1 行も書かず、消えたファイルは範囲付きの掃除で落ちる', async () => {
    const repo = join(home(), 'repo')
    makeRepo(repo)
    await service.scanSubtree(repo)

    const again = await service.scanSubtree(repo)
    expect(again).toMatchObject({ state: 'done', written: 0, removed: 0 })
    // src has the same mtime as last time, so it is not opened (pruning under home).
    expect(again).toMatchObject({ pruned: 1 })

    rmSync(join(repo, 'README.md'))
    const swept = await service.scanSubtree(repo)
    expect(swept).toMatchObject({ state: 'done', removed: 1 })
    expect(store.findByPath(join(repo, 'README.md'))).toBeNull()
    // Trees that were already there are not touched (no whole-table clean-up of `seen_at`).
    expect(store.findByPath(join(home(), 'old', 'kept.md'))).not.toBeNull()
  })

  it('根が symlink なら実体のパスを歩き、symlink のパスの下に行を作らない (第 49 波 review、TODO 924)', async () => {
    const real = join(home(), 'work', 'real-repo')
    makeRepo(real)
    const link = join(home(), 'link-repo')
    symlinkSync(real, link)

    const result = await service.scanSubtree(link)
    expect(result).toMatchObject({ state: 'done' })
    // Previously it created rows under the symlink path; the deep scan's removeStale deleted them, and the next creation created them again.
    expect(store.findByPath(join(link, 'README.md'))).toBeNull()
    expect(store.findByPath(join(link, 'src', 'widget.ts'))).toBeNull()
    expect(store.findByPath(join(real, 'src', 'widget.ts'))).not.toBeNull()
    // Even when the working folder is a symlink, it appears in the "this working folder" section (the cwd is resolved to the real path before lookup).
    expect(await cwdNames('widget', link)).toEqual(['widget-util.ts', 'widget.ts'])

    // After a deep scan the real rows remain, and nothing is under the symlink (it does not repeatedly create and delete).
    await service.scan({ deep: true })
    expect(store.findByPath(join(real, 'src', 'widget.ts'))).not.toBeNull()
    expect(store.findByPath(join(link, 'src', 'widget.ts'))).toBeNull()
    const again = await service.scanSubtree(link)
    expect(again).toMatchObject({ state: 'done', written: 0, removed: 0 })
  })

  it('同じパスの依頼が待っている / 走っている間は合流する', async () => {
    const repo = join(home(), 'repo')
    makeRepo(repo)
    const first = service.scanSubtree(repo)
    const second = service.scanSubtree(`${repo}/`)
    expect(second).toBe(first)
    await first
    // A request made after the previous one has finished runs anew (it is not merged).
    const third = service.scanSubtree(repo)
    expect(third).not.toBe(first)
    await third
  })

  it('除外・ホーム外・走査ルート・無いパスは歩かない', async () => {
    const library = join(home(), 'Library', 'Caches', 'thing')
    mkdirSync(library, { recursive: true })
    writeFileSync(join(library, 'secret.txt'), 'x')
    const underModules = join(home(), 'proj', 'node_modules', 'pkg')
    mkdirSync(underModules, { recursive: true })
    writeFileSync(join(underModules, 'index.js'), 'x')
    const outside = join(base, 'elsewhere')
    mkdirSync(outside, { recursive: true })

    expect(await service.scanSubtree(library)).toEqual({ state: 'skipped', reason: 'excluded' })
    // An ancestor (`node_modules`) hits a name rule. The full scan also prunes by ancestor, so it is outside the index's scope.
    expect(await service.scanSubtree(underModules)).toEqual({ state: 'skipped', reason: 'excluded' })
    expect(await service.scanSubtree(outside)).toEqual({ state: 'skipped', reason: 'outside' })
    expect(await service.scanSubtree(home())).toEqual({ state: 'skipped', reason: 'root' })
    expect(await service.scanSubtree(join(home(), 'no-such-dir'))).toEqual({
      state: 'skipped',
      reason: 'missing'
    })
    expect(await service.scanSubtree(join(home(), 'old', 'kept.md'))).toEqual({
      state: 'skipped',
      reason: 'missing'
    })
    expect(store.findByPath(join(library, 'secret.txt'))).toBeNull()
    expect(store.findByPath(join(underModules, 'index.js'))).toBeNull()
    expect(store.findByPath(join(home(), 'proj'))).toBeNull()
  })

  it('上限で打ち切ったら truncated を返し、残りは次の増分走査が拾う', async () => {
    const repo = join(home(), 'big')
    for (let d = 0; d < 4; d += 1) {
      mkdirSync(join(repo, `d${d}`), { recursive: true })
      for (let f = 0; f < 5; f += 1) writeFileSync(join(repo, `d${d}`, `note-${d}-${f}.md`), 'x')
    }
    const result = await service.scanSubtree(repo, { maxEntries: 6 })
    expect(result.state).toBe('truncated')
    if (result.state === 'skipped') throw new Error('skipped')
    expect(result.seen).toBeLessThan(20)
    // The directory rows of a tree that was cut off forget their mtime (the root, and the d* that were recorded as rows but not opened).
    expect(mtimeOf(repo)).toBe(0)
    for (let d = 0; d < 4; d += 1) {
      const m = mtimeOf(join(repo, `d${d}`))
      if (m !== null) expect(m).toBe(0)
    }

    // The scheduled incremental scan (home only, with pruning) picks up everything that remains.
    await service.scan({ deep: false, roots: [home()] })
    expect((await cwdNames('note', repo))?.length).toBe(20)
  })

  it('走っている全走査とは重ならない: 部分木は後回し、全走査は走っている部分木を待つ', async () => {
    const repo = join(home(), 'repo')
    makeRepo(repo)
    const order: string[] = []

    // (a) The full scan goes first → the subtree runs after it.
    const full = service.scan({ deep: true }).then(() => order.push('full'))
    const sub = service.scanSubtree(repo).then(() => order.push('subtree'))
    await Promise.all([full, sub])
    expect(order).toEqual(['full', 'subtree'])

    // (b) A full scan after the subtree has started writing → the full scan does not start until the subtree finishes.
    order.length = 0
    statuses = []
    rmSync(join(repo, 'README.md'))
    const sub2 = service.scanSubtree(repo).then(() => order.push('subtree'))
    // One cycle passes until `subtreeActive` is set, after the `then` of the queue and the gate.
    await new Promise((done) => setImmediate(done))
    const full2 = service.scan({ deep: true }).then(() => order.push('full'))
    await Promise.all([sub2, full2])
    expect(order).toEqual(['subtree', 'full'])
    expect(await cwdNames('widget', repo)).toEqual(['widget-util.ts', 'widget.ts'])
  })

  it('終了処理の後の依頼は DB に触らずに断る', async () => {
    const repo = join(home(), 'repo')
    makeRepo(repo)
    await service.stop()
    expect(await service.scanSubtree(repo)).toEqual({ state: 'skipped', reason: 'stopped' })
    expect(store.findByPath(repo)).toBeNull()
  })
})

describe('部分木走査の後の本文の構築 (項目 249)', () => {
  let index: IndexService
  let builds: Promise<SubtreeBuildResult>[]
  let limits: { maxDocs?: number; maxMs?: number }

  /**
   * Same as the index process's wiring (`kernel.ts`): connects the scan notifications to building. Omitting `idle` means
   * no check (it always runs); passing it gives that check.
   */
  async function wire(idle: ConstructorParameters<typeof IndexService>[0]['idle']): Promise<void> {
    await service.stop()
    index = new IndexService({
      db,
      store,
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: null,
      idle,
      onStatus: () => {}
    })
    builds = []
    service = new FsIndexer(
      db,
      {
        onScanStatus: () => {},
        onFileChanges: () => {},
        onIndexable: () => index.resume(),
        onSubtreeScanned: (rootId, path) => builds.push(index.buildSubtree(rootId, path, limits))
      },
      store,
      home(),
      [home()],
      { volumesDir: join(base, 'Volumes'), probeUuid: async () => null }
    )
  }

  /**
   * A machine where the usual build never starts. Since TODO 434 the scan also runs slowly during operation, so the thermal state is set to `serious`
   * (waiting). (Before 434, "during operation" played this role.) The timer is not run.
   */
  const busy = {
    idleSeconds: () => 0,
    thermalState: () => 'serious' as const,
    schedule: () => () => {}
  }

  const stateOf = (path: string): string | null => {
    const id = store.findByPath(path)
    if (id === null) return null
    return (
      db.prepare(`SELECT index_state FROM documents WHERE id = ?`).get(id) as {
        index_state: string
      }
    ).index_state
  }

  /** Hits in the "this working folder" section of body search (paths relative to the cwd). */
  async function cwdHits(query: string, cwd: string): Promise<string[]> {
    const result = await index.search(query, 'files', { cwd, cwdUri: pathToUri(cwd) })
    return (result.cwd?.hits ?? [])
      .map((hit) => decodeURIComponent(hit.uri).slice(`file://${cwd}/`.length))
      .sort()
  }

  beforeEach(async () => {
    limits = {}
    await wire(busy)
  })

  afterEach(async () => {
    await index.stop()
  })

  it('アイドルでなくても、部分木の本文が構築されて本文検索の cwd 区画に出る', async () => {
    const repo = join(home(), 'work', 'fresh-repo')
    makeRepo(repo)
    const result = await service.scanSubtree(repo)
    expect(result.state).toBe('done')
    expect(builds).toHaveLength(1)
    // Three documents: README.md / widget.ts / widget-util.ts (directories have no body).
    expect(await builds[0]).toMatchObject({ built: 3, left: 0, capped: false })
    expect(await cwdHits('export', repo)).toEqual(['src/lib/widget-util.ts', 'src/widget.ts'])
    // Bodies pending outside the subtree (`old/kept.md`, entered by the deep scan) are not built. They wait for idle.
    expect(stateOf(join(home(), 'old', 'kept.md'))).toBe('pending')
    // The usual build stays waiting (in a run that is only the subtree, it returns to the state from before it started).
    expect(index.getStatus().state).toBe('waiting')
  })

  it('上限を超えた分は本文待ちのまま残り、普段の構築に回る', async () => {
    const repo = join(home(), 'many')
    mkdirSync(join(repo, 'deep'), { recursive: true })
    for (let i = 0; i < 5; i += 1) writeFileSync(join(repo, `top-${i}.md`), `# top ${i}\n`)
    for (let i = 0; i < 5; i += 1) writeFileSync(join(repo, 'deep', `low-${i}.md`), `# low ${i}\n`)
    limits = { maxDocs: 4 }
    await service.scanSubtree(repo)
    expect(await builds[0]).toMatchObject({ built: 4, left: 0, capped: true })
    const tops = Array.from({ length: 5 }, (_, i) => stateOf(join(repo, `top-${i}.md`)))
    const lows = Array.from({ length: 5 }, (_, i) => stateOf(join(repo, 'deep', `low-${i}.md`)))
    // Chosen in shallow-first order: only 4 of the top-* directly under the root were built.
    expect(tops.filter((state) => state === 'indexed')).toHaveLength(4)
    expect(tops.filter((state) => state === 'pending')).toHaveLength(1)
    expect(lows).toEqual(['pending', 'pending', 'pending', 'pending', 'pending'])

    // Time limit: with 0 ms it returns without building even one (the rest stay pending).
    limits = { maxMs: 0 }
    expect((await service.scanSubtree(repo)).state).toBe('done')
    expect(await builds[1]).toMatchObject({ built: 0, left: 6, capped: false })
    expect(lows).toEqual(
      Array.from({ length: 5 }, (_, i) => stateOf(join(repo, 'deep', `low-${i}.md`)))
    )
  })

  it('普段の構築が走っていれば相乗りする (判定なしの構成)', async () => {
    await index.stop()
    await wire(undefined)
    const repo = join(home(), 'ride')
    makeRepo(repo)
    await service.scanSubtree(repo)
    expect(await builds[0]).toMatchObject({ left: 0 })
    expect(await cwdHits('export', repo)).toEqual(['src/lib/widget-util.ts', 'src/widget.ts'])
  })

  it('終了処理 (stop) の後の依頼は DB に触らずに返す', async () => {
    const repo = join(home(), 'late')
    makeRepo(repo)
    await index.stop()
    await service.scanSubtree(repo)
    expect(await builds[0]).toEqual({ built: 0, left: 0, capped: false, ms: 0 })
    expect(stateOf(join(repo, 'README.md'))).toBe('pending')
  })
})
