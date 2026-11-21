/**
 * TODO 999: "recent files".
 *
 * - Index process: `IndexStore.recentFsFiles` (keyset pages, newest first), which walks `documents_recent` (created when the index process opens), and
 *   `collectRecent` (the file extension table, hidden folders, exclusions, the bulk-update mark, folder filtering).
 * - main: the order of judgment in `RecentFilesService` (keep AI-written → drop bulk → drop git-clean → keep if unreadable),
 *   `GitChangeIndex` (reads porcelain, briefly remembers per repository, and never calls git again if git is absent), the recent-files badge
 *   (TODO 1172: within 5 minutes among the first 3 of the small window), and the thumbnail choke point.
 * - Pure functions in the renderer (the signal for a diff, showing and hiding badges, the candidates for an empty `@`).
 *
 * Calls neither the model nor the real git. The DB is in-memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { collectRecent, hasHiddenSegment, isBulkAt, type RecentRow } from '../src/index-kernel/recent.js'
import { RecentFilesService, type RecentFilesDeps } from '../src/main/recent/recent-files.js'
import { GitChangeIndex, parsePorcelainV1Z } from '../src/main/recent/git-changes.js'
import { MAX_THUMBNAIL_BYTES, THUMBNAIL_SIZE, ThumbnailCache, pngDimensions, shrinkToFit } from '../src/main/recent/thumbnail.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPOSER_SCREENSHOT_OFFER } from '../src/common/settings-keys.js'
import {
  BULK_COUNT,
  BULK_WINDOW_MS,
  RECENT_MAX,
  RECENT_OFFER_FETCH,
  RECENT_OFFER_MAX,
  RECENT_OFFER_MS,
  asRecentListOptions,
  recentKindOf,
  type RecentCandidate
} from '../src/shared/recent-files.js'
import {
  batchTouchesOffers,
  batchTouchesRecent,
  nextOfferExpiry,
  offerKey,
  offerVisible,
  recentLocation,
  visibleOffers
} from '../src/renderer/src/recent-files.js'
import { recentAtCandidates } from '../src/renderer/src/composer-at.js'
import { pathToUri } from '../src/common/uri.js'
import type { FileChangeBatch, FileEntry } from '../src/shared/types.js'
import { ThreadStore } from '../src/main/session/store.js'
import type { AiosEvent } from '../src/shared/agent.js'

const NOW = 1_800_000_000_000
const MIN = 60_000

// ---------------------------------------------------------------------------
// Index process
// ---------------------------------------------------------------------------

describe('IndexStore.recentFsFiles (documents_recent)', () => {
  let db: Db
  let store: IndexStore

  function add(path: string, mtimeMs: number, isDirectory = false): void {
    const cut = path.lastIndexOf('/')
    const parentId = store.ensureDirectory(path.slice(0, cut), 1)
    const name = path.slice(cut + 1)
    const dot = name.lastIndexOf('.')
    store.upsertFsEntry({
      parentId,
      name,
      isDirectory,
      ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
      size: 10,
      mtimeMs,
      seenAt: 1
    })
  }

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    store = new IndexStore(db)
  })

  it('部分索引 documents_recent があり、問い合わせはそれを使う', () => {
    const index = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'documents_recent'`).pluck().get() as string
    expect(index).toContain("WHERE source = 'fs' AND kind = 'file'")
    // With an explicit index name (INDEXED BY) it does not re-sort with a temporary B-tree. Without the name, a DB with no statistics chose documents_seen.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM documents INDEXED BY documents_recent WHERE source = 'fs' AND kind = 'file'
         AND mtime_ms >= 0 AND (mtime_ms < 9 OR (mtime_ms = 9 AND id < 9)) ORDER BY mtime_ms DESC, id DESC LIMIT 5`
      )
      .all() as { detail: string }[]
    const detail = plan.map((row) => row.detail).join(' ')
    expect(detail).toContain('documents_recent')
    expect(detail).not.toContain('TEMP B-TREE')
  })

  it('索引は migration ではなく索引プロセスの IndexStore が作る (制約 8.1 — migration は main で走る)', () => {
    const bare = new Database(':memory:')
    runMigrations(bare)
    const has = (): boolean =>
      bare.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'documents_recent'`).pluck().get() === 1
    expect(has()).toBe(false)
    new IndexStore(bare)
    expect(has()).toBe(true)
    // The second time (every launch) passes straight through.
    new IndexStore(bare)
    expect(has()).toBe(true)
    bare.close()
  })

  it('索引が無い DB でも名指し無しに倒して答える', () => {
    db.exec('DROP INDEX documents_recent')
    // Imitate the case where it cannot be created: drop CREATE INDEX (replace exec).
    const exec = db.exec.bind(db)
    const spy = vi.spyOn(db, 'exec').mockImplementation((source: string) => {
      if (source.includes('documents_recent')) throw new Error('disk full')
      return exec(source)
    })
    const fresh = new IndexStore(db)
    spy.mockRestore()
    expect(fresh.recentFsFiles(0, NOW, Number.MAX_SAFE_INTEGER, 5)).toEqual([])
  })

  it('ファイルだけを新しい順に、keyset で次のページへ進む。since より古いものは出ない', () => {
    add('/Users/a/old.png', NOW - 10 * 24 * 60 * MIN)
    add('/Users/a/one.png', NOW - 3 * MIN)
    add('/Users/a/two.pdf', NOW - 2 * MIN)
    add('/Users/a/three.c', NOW - 1 * MIN)
    add('/Users/a/dir', NOW, true)
    const since = NOW - 7 * 24 * 60 * MIN
    const first = store.recentFsFiles(since, NOW + 1, Number.MAX_SAFE_INTEGER, 2)
    expect(first.map((row) => row.name)).toEqual(['three.c', 'two.pdf'])
    const last = first[1] as { mtime_ms: number; id: number }
    const second = store.recentFsFiles(since, last.mtime_ms, last.id, 2)
    expect(second.map((row) => row.name)).toEqual(['one.png'])
  })

  it('collectRecent を実物の行で: 表に無い拡張子と隠しファイル・隠しフォルダの下は出ない', () => {
    add('/Users/a/Desktop/shot.png', NOW - 1 * MIN)
    add('/Users/a/Desktop/build.o', NOW - 1 * MIN)
    add('/Users/a/Desktop/.DS_Store', NOW - 1 * MIN)
    add('/Users/a/.cache/x.png', NOW - 1 * MIN)
    const out = collectRecent(
      {
        page: (s, m, i, l) => store.recentFsFiles(s, m, i, l),
        pathOf: (id) => store.pathOf(id),
        isExcluded: () => false
      },
      { sinceMs: 0, now: NOW, limit: 10 }
    )
    expect(out.map((c) => c.name)).toEqual(['shot.png'])
    expect(out[0]).toMatchObject({ uri: pathToUri('/Users/a/Desktop/shot.png'), parentUri: pathToUri('/Users/a/Desktop'), bulk: false })
  })
})

describe('collectRecent (偽の行)', () => {
  const paths = new Map<number, string>([
    [1, '/Users/a/Desktop'],
    [2, '/Users/a/proj/out'],
    [3, '/Users/a/node_modules/x'],
    [4, '/Users/a/Downloads']
  ])
  function rows(list: readonly Omit<RecentRow, 'size'>[]): readonly RecentRow[] {
    return list.map((row) => ({ ...row, size: 1 }))
  }
  function run(list: readonly Omit<RecentRow, 'size'>[], options: { parentId?: number; limit?: number } = {}): RecentCandidate[] {
    const all = rows(list)
      .slice()
      .sort((a, b) => b.mtime_ms - a.mtime_ms || b.id - a.id)
    return collectRecent(
      {
        page: (since, beforeMtime, beforeId, limit) =>
          all
            .filter((r) => r.mtime_ms >= since && (r.mtime_ms < beforeMtime || (r.mtime_ms === beforeMtime && r.id < beforeId)))
            .slice(0, limit),
        pathOf: (id) => paths.get(id) ?? null,
        isExcluded: (path) => path.includes('/node_modules')
      },
      { sinceMs: 0, now: NOW, limit: options.limit ?? 100, parentId: options.parentId ?? null }
    )
  }

  it('同じフォルダで 2 分の幅に 20 件以上 (拡張子を問わず) なら一括の印。他のフォルダは印なし', () => {
    const bulk = Array.from({ length: BULK_COUNT }, (_, i) => ({
      id: 100 + i,
      name: i % 2 === 0 ? `f${i}.c` : `f${i}.o`,
      ext: i % 2 === 0 ? 'c' : 'o',
      mtime_ms: NOW - 5 * MIN + i * 1000,
      parent_id: 2
    }))
    const out = run([...bulk, { id: 1, name: 'shot.png', ext: 'png', mtime_ms: NOW - 6 * MIN, parent_id: 1 }])
    expect(out.filter((c) => c.ext === 'c').every((c) => c.bulk)).toBe(true)
    expect(out.find((c) => c.name === 'shot.png')?.bulk).toBe(false)
    // `.o` is not in the table, so it is not a candidate, but it counts in the tallies.
    expect(out.some((c) => c.ext === 'o')).toBe(false)
  })

  it('除外規則に当たるフォルダの下は出ない (規則が後から増えても)', () => {
    const out = run([
      { id: 1, name: 'a.js', ext: 'js', mtime_ms: NOW - MIN, parent_id: 3 },
      { id: 2, name: 'b.pdf', ext: 'pdf', mtime_ms: NOW - 2 * MIN, parent_id: 4 }
    ])
    expect(out.map((c) => c.name)).toEqual(['b.pdf'])
  })

  it('parentId を渡すとそのフォルダの直下だけ。limit で止まる', () => {
    const list = [
      { id: 1, name: 'a.png', ext: 'png', mtime_ms: NOW - MIN, parent_id: 1 },
      { id: 2, name: 'b.png', ext: 'png', mtime_ms: NOW - 2 * MIN, parent_id: 4 },
      { id: 3, name: 'c.png', ext: 'png', mtime_ms: NOW - 3 * MIN, parent_id: 1 }
    ]
    expect(run(list, { parentId: 1 }).map((c) => c.name)).toEqual(['a.png', 'c.png'])
    expect(run(list, { limit: 1 }).map((c) => c.name)).toEqual(['a.png'])
  })

  it('isBulkAt / hasHiddenSegment', () => {
    const times = Array.from({ length: 20 }, (_, i) => i * 1000)
    expect(isBulkAt(times, 5000)).toBe(true)
    expect(isBulkAt(times.slice(0, 19), 5000)).toBe(false)
    expect(isBulkAt(times, 10 * MIN)).toBe(false)
    expect(hasHiddenSegment('/Users/a/.git/x')).toBe(true)
    expect(hasHiddenSegment('/Users/a/proj/x')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function candidate(path: string, mtimeMs: number, bulk = false): RecentCandidate {
  const cut = path.lastIndexOf('/')
  const name = path.slice(cut + 1)
  return {
    uri: pathToUri(path),
    parentUri: pathToUri(path.slice(0, cut)),
    name,
    ext: name.slice(name.lastIndexOf('.') + 1),
    size: 1,
    mtimeMs,
    bulk
  }
}

function service(overrides: Partial<RecentFilesDeps> & { list?: readonly RecentCandidate[] } = {}): {
  service: RecentFilesService
  candidates: ReturnType<typeof vi.fn>
} {
  const candidates = vi.fn(async (params: { sinceMs: number; limit: number; parentUri?: string }) => {
    void params
    return overrides.list ?? []
  })
  return {
    candidates,
    service: new RecentFilesService({
      candidates,
      aiWrittenPaths: () => [],
      gitState: async () => 'not-repo',
      screenshotOfferEnabled: () => true,
      now: () => NOW,
      home: () => '/Users/a',
      realpath: async (path: string) => path,
      ...overrides
    })
  }
}

describe('RecentFilesService.list', () => {
  it('判定の順: AI の書いたファイルは一括でも clean でも残す。一括は外す。clean は外す。unknown / git の外は残す', async () => {
    const list = [
      candidate('/r/ai.ts', NOW - 1, true),
      candidate('/r/bulk.c', NOW - 2, true),
      candidate('/r/clean.c', NOW - 3),
      candidate('/r/changed.c', NOW - 4),
      candidate('/r/unknown.c', NOW - 5),
      candidate('/elsewhere/doc.pdf', NOW - 6)
    ]
    const states: Record<string, 'changed' | 'clean' | 'unknown' | 'not-repo'> = {
      '/r/ai.ts': 'clean',
      '/r/bulk.c': 'changed',
      '/r/clean.c': 'clean',
      '/r/changed.c': 'changed',
      '/r/unknown.c': 'unknown',
      '/elsewhere/doc.pdf': 'not-repo'
    }
    const gitState = vi.fn(async (path: string) => states[path] ?? 'not-repo')
    const { service: s } = service({ list, aiWrittenPaths: () => ['/R/AI.ts'], gitState })
    const out = await s.list(null)
    expect(out.map((f) => f.name)).toEqual(['ai.ts', 'changed.c', 'unknown.c', 'doc.pdf'])
    expect(out[0]).toMatchObject({ ai: true, kind: 'code' })
    expect(out[3]).toMatchObject({ ai: false, kind: 'document' })
    // Files written by AI and files marked as bulk do not call git.
    expect(gitState).not.toHaveBeenCalledWith('/r/ai.ts')
    expect(gitState).not.toHaveBeenCalledWith('/r/bulk.c')
  })

  it('種類の絞り込みと件数。期間は 7 日 (since を索引に渡す)', async () => {
    const list = [candidate('/a/x.png', NOW - 1), candidate('/a/y.mp4', NOW - 2), candidate('/a/z.png', NOW - 3)]
    const { service: s, candidates } = service({ list })
    expect((await s.list(['image'])).map((f) => f.name)).toEqual(['x.png', 'z.png'])
    expect((await s.list(null, 1)).map((f) => f.name)).toEqual(['x.png'])
    expect(candidates.mock.calls[0]?.[0]).toMatchObject({ sinceMs: NOW - 7 * 24 * 60 * MIN })
  })

  it('索引が答えなければ空 (投げない)。AI の一覧が読めなくても続ける', async () => {
    const { service: s } = service({
      candidates: async () => {
        throw new Error('index down')
      }
    })
    await expect(s.list(null)).resolves.toEqual([])
    const { service: t } = service({
      list: [candidate('/a/x.png', NOW)],
      aiWrittenPaths: () => {
        throw new Error('db closed')
      }
    })
    expect((await t.list(null)).map((f) => f.name)).toEqual(['x.png'])
  })
})

describe('ThreadStore.recentSucceededToolUses (AI の書いたファイルの材料)', () => {
  it('窓 (sinceMs) より前の tool_use と、拒否・失敗した tool_use は返さない', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const store = new ThreadStore(db, '/Users/tester')
      const thread = store.createThread({
        id: 't1',
        title: 't',
        cwd: '/Users/tester/w',
        allowedDirs: ['/Users/tester/w'],
        retention: 'forever',
        backend: 'agent-cli',
        modelId: null,
        thinking: null
      })
      const base = { sessionId: 's1', threadId: 't1', actor: 'main' }
      const use = (id: string, path: string, ts: number): AiosEvent =>
        ({
          ...base,
          id: `e-${id}`,
          ts,
          kind: 'tool_use',
          payload: { toolUseId: id, name: 'Write', summary: path, input: { file_path: path }, truncated: false }
        }) as AiosEvent
      const result = (id: string, ok: boolean, ts: number): AiosEvent =>
        ({ ...base, id: `r-${id}`, ts, kind: 'tool_result', payload: { toolUseId: id, ok, bytes: 1 } }) as AiosEvent
      const since = NOW - 7 * 24 * 60 * MIN
      store.appendEvents(thread, 's1', [
        use('old', '/w/old.txt', since - MIN),
        result('old', true, since - MIN),
        use('ok', '/w/ok.txt', NOW - 2 * MIN),
        result('ok', true, NOW - 2 * MIN),
        use('denied', '/w/denied.txt', NOW - MIN),
        result('denied', false, NOW - MIN),
        use('pending', '/w/pending.txt', NOW)
      ])
      expect(store.recentSucceededToolUses('t1', since)).toEqual([{ name: 'Write', input: { file_path: '/w/ok.txt' } }])
      expect(store.recentSucceededToolUses('missing', since)).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('RecentFilesService.offers (TODO 1172)', () => {
  it('新しい順 (フォルダ・拡張子の絞りは 1180)。消した分を renderer が繰り上げられるよう 3 件より多め (RECENT_OFFER_FETCH) に返す', async () => {
    const list = [
      candidate('/Users/a/Desktop/IMG_1.heic', NOW - 1),
      candidate('/Users/a/Documents/notes.md', NOW - 2),
      candidate('/Users/a/Downloads/clip.mov', NOW - 3),
      candidate('/Users/a/Pictures/main.png', NOW - 4),
      ...Array.from({ length: 30 }, (_, i) => candidate(`/Users/a/Desktop/x${i}.pdf`, NOW - 10 - i))
    ]
    const { service: s, candidates } = service({ list })
    const offers = await s.offers()
    expect(RECENT_OFFER_MAX).toBe(12)
    expect(RECENT_OFFER_FETCH).toBeGreaterThan(RECENT_OFFER_MAX)
    expect(offers).toHaveLength(RECENT_OFFER_FETCH)
    expect(offers.slice(0, 4).map((file) => file.name)).toEqual(['IMG_1.heic', 'notes.md', 'clip.mov', 'main.png'])
    expect(offers.slice(0, 3).map((file) => file.kind)).toEqual(['image', 'document', 'video'])
    // Asks from BULK_WINDOW_MS, just before the 5-minute window (so the width of the bulk count covers every file in the window).
    expect(candidates.mock.calls[0]?.[0]).toEqual({ sinceMs: NOW - RECENT_OFFER_MS - BULK_WINDOW_MS, limit: expect.any(Number) })
  })

  it('TODO 1180: ホームの 5 フォルダの下の文書・画像・動画だけ。リポジトリの .md・.zip・コードは出さない。大文字の拡張子も', async () => {
    const list = [
      candidate('/Users/a/proj/aios/todo/1179.md', NOW - 1),
      candidate('/Users/a/Desktop/shot.png', NOW - 2),
      candidate('/Users/a/Movies/rec.mov', NOW - 3),
      candidate('/Users/a/Downloads/a.zip', NOW - 4),
      candidate('/Users/a/Downloads/IMG.PNG', NOW - 5),
      candidate('/Users/a/Documents/sub/dir/x.xlsx', NOW - 6),
      candidate('/Users/a/Desktop/main.ts', NOW - 7),
      candidate('/Users/a/Desktopx/y.png', NOW - 8),
      candidate('/Users/a/Downloads/a.dmg', NOW - 9)
    ]
    const { service: s } = service({ list })
    expect((await s.offers()).map((file) => file.name)).toEqual(['shot.png', 'rec.mov', 'IMG.PNG', 'x.xlsx'])
    // The small window (list) does not narrow
    expect((await s.list(null)).length).toBeGreaterThan(4)
  })

  it('TODO 1180: symlink は実パスで判定する (フォルダの外へ向く symlink は出ない)', async () => {
    const list = [candidate('/Users/a/Desktop/link.png', NOW - 1), candidate('/Users/a/Downloads/real.png', NOW - 2)]
    const { service: s } = service({
      list,
      realpath: async (path) => (path === '/Users/a/Desktop/link.png' ? '/Users/a/proj/link.png' : path)
    })
    expect((await s.offers()).map((file) => file.name)).toEqual(['real.png'])
  })

  it('TODO 1180 review Y: epub / markdown は札に出る (小窓の表にも入っている)', async () => {
    const list = [candidate('/Users/a/Documents/x.epub', NOW - 1), candidate('/Users/a/Desktop/n.markdown', NOW - 2)]
    const { service: s } = service({ list })
    expect((await s.offers()).map((file) => [file.name, file.kind])).toEqual([
      ['x.epub', 'document'],
      ['n.markdown', 'document']
    ])
  })

  it('TODO 1180 review Y: 一括の候補は realpath を呼ぶ前に落とす', async () => {
    const realpath = vi.fn(async (path: string) => path)
    const list = [{ ...candidate('/Users/a/Downloads/build.png', NOW - 1), bulk: true }]
    const { service: s } = service({ list, realpath })
    const before = realpath.mock.calls.length
    expect(await s.offers()).toEqual([])
    expect(realpath.mock.calls.slice(before).some(([p]) => p === '/Users/a/Downloads/build.png')).toBe(false)
  })

  it('第 75 波 review: 5 分の境界をまたいだ一括の更新 (ビルド) も、7 日の一覧と同じく一括と判定して外す', async () => {
    // In one folder: 20 entries every 4 seconds, starting 1 minute before the 5-minute boundary (= BULK_COUNT, within a 2-minute width). After the boundary, only 5.
    const parent = 2
    const rows: RecentRow[] = Array.from({ length: BULK_COUNT }, (_, i) => ({
      id: 100 + i,
      name: `chunk${i}.js`,
      ext: 'js',
      size: 1,
      mtime_ms: NOW - RECENT_OFFER_MS - MIN + i * 4_000,
      parent_id: parent
    })).sort((a, b) => b.mtime_ms - a.mtime_ms || b.id - a.id)
    const inWindow = rows.filter((row) => row.mtime_ms >= NOW - RECENT_OFFER_MS)
    expect(inWindow.length).toBeGreaterThan(0)
    expect(inWindow.length).toBeLessThan(BULK_COUNT)
    const scan = async (params: { sinceMs: number; limit: number }): Promise<readonly RecentCandidate[]> =>
      collectRecent(
        {
          page: (since, beforeMtime, beforeId, limit) =>
            rows
              .filter((r) => r.mtime_ms >= since && (r.mtime_ms < beforeMtime || (r.mtime_ms === beforeMtime && r.id < beforeId)))
              .slice(0, limit),
          pathOf: (id) => (id === parent ? '/Users/a/proj/dist' : null),
          isExcluded: () => false
        },
        { sinceMs: params.sinceMs, now: NOW, limit: params.limit }
      )
    // Querying only the 5-minute window does not match the bulk among the 5 entries of that window (the shape before the fix).
    expect((await scan({ sinceMs: NOW - RECENT_OFFER_MS, limit: 100 })).some((c) => c.bulk)).toBe(false)
    const { service: s } = service({ candidates: scan })
    expect(await s.offers()).toEqual([])
    // The same for the 7-day list (all of them are bulk).
    expect(await s.list(null)).toEqual([])
  })

  it('小窓と同じ絞り込み: 一括の更新と git の clean は外し、AI の書いたファイルは残す。5 分より古いものは出さない', async () => {
    const list = [
      candidate('/Users/a/Desktop/bulk.png', NOW - 1, true),
      candidate('/Users/a/Desktop/clean.md', NOW - 2),
      candidate('/Users/a/Desktop/ai.md', NOW - 3, true),
      candidate('/Users/a/Desktop/old.png', NOW - RECENT_OFFER_MS - 1)
    ]
    const { service: s } = service({
      list,
      aiWrittenPaths: () => ['/Users/a/Desktop/ai.md'],
      gitState: async (path) => (path === '/Users/a/Desktop/clean.md' ? 'clean' : 'not-repo')
    })
    const offers = await s.offers()
    expect(offers.map((file) => [file.name, file.ai])).toEqual([['ai.md', true]])
  })

  it('設定で切っていれば空で、索引にも聞かない。索引が落ちても投げずに空', async () => {
    const list = [candidate('/Users/a/Desktop/s.png', NOW)]
    const off = service({ list, screenshotOfferEnabled: () => false })
    expect(await off.service.offers()).toEqual([])
    expect(off.candidates).not.toHaveBeenCalled()
    const broken = service({
      candidates: async () => {
        throw new Error('index down')
      }
    })
    expect(await broken.service.offers()).toEqual([])
  })
})

describe('GitChangeIndex', () => {
  it('porcelain v1 -z: rename の元の名前を読み飛ばし、未追跡のフォルダを分ける', () => {
    const out = parsePorcelainV1Z(' M src/a.ts\0R  new.ts\0old.ts\0?? tmp/\0?? note.md\0')
    expect(out.changed).toEqual(['src/a.ts', 'new.ts', 'note.md'])
    expect(out.untrackedDirs).toEqual(['tmp/'])
  })

  it('リポジトリの根を上へ探し、status を覚えて 1 回だけ呼ぶ。clean / changed / 未追跡のフォルダ / git の外', async () => {
    const run = vi.fn(async () => ({ error: null, stdout: Buffer.from(' M src/a.ts\0?? tmp/\0'), stderr: '' }))
    const git = new GitChangeIndex({
      run,
      hasDotGit: async (dir) => dir === '/repo',
      now: () => NOW
    })
    expect(await git.stateOf('/repo/src/a.ts')).toBe('changed')
    expect(await git.stateOf('/repo/src/b.ts')).toBe('clean')
    expect(await git.stateOf('/repo/tmp/deep/c.png')).toBe('changed')
    expect(await git.stateOf('/other/x.png')).toBe('not-repo')
    expect(run).toHaveBeenCalledTimes(1)
    const call = run.mock.calls[0] as unknown as [readonly string[], { cwd: string }]
    expect(call[0]).toContain('--porcelain=v1')
    expect(call[1].cwd).toBe('/repo')
  })

  it('読めなければ unknown。git が無い (xcode-select) と分かったら以後は呼ばない', async () => {
    const error = Object.assign(new Error('x'), { code: 1 })
    const run = vi.fn(async () => ({ error, stdout: Buffer.alloc(0), stderr: 'xcode-select: note: no developer tools' }))
    let now = NOW
    const git = new GitChangeIndex({ run, hasDotGit: async (dir) => dir === '/repo', now: () => now })
    expect(await git.stateOf('/repo/a.ts')).toBe('unknown')
    now += 60_000
    expect(await git.stateOf('/repo/a.ts')).toBe('unknown')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('dispose (main の終了) の後は git を呼ばず、走っている子には abort を送る', async () => {
    let signal: AbortSignal | undefined
    const run = vi.fn(async (_args: readonly string[], options: { signal?: AbortSignal }) => {
      signal = options.signal
      return { error: null, stdout: Buffer.alloc(0), stderr: '' }
    })
    const git = new GitChangeIndex({ run, hasDotGit: async (dir) => dir === '/repo', now: () => NOW })
    await git.stateOf('/repo/a.ts')
    expect(signal?.aborted).toBe(false)
    git.dispose()
    expect(signal?.aborted).toBe(true)
    expect(await git.stateOf('/repo2/a.ts')).toBe('unknown')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('ThumbnailCache', () => {
  it('第 75 波 review: 件数だけでなく、取れた絵の大きさの合計でも古いものから捨てる', async () => {
    const big = 'x'.repeat(1_000)
    const load = vi.fn(async () => big)
    const allow = { assertAllowed: (uri: string) => uri.replace('file://', '') }
    const dir = mkdtempSync(join(tmpdir(), 'aios-thumb-'))
    try {
      const uris = ['a', 'b', 'c'].map((name) => {
        const path = join(dir, `${name}.png`)
        writeFileSync(path, 'png')
        return pathToUri(path)
      })
      // The upper limit on count is 10, and the upper limit on size is 2 entries' worth.
      const cache = new ThumbnailCache(allow, load, 10, 2_000)
      for (const uri of uris) expect(await cache.thumbnailFor(uri)).toBe(big)
      expect(cache.size).toBe(2)
      expect(cache.bytes).toBe(2_000)
      // The oldest, a, was discarded (fetched again). b remains (not fetched again).
      await cache.thumbnailFor(uris[1])
      expect(load).toHaveBeenCalledTimes(3)
      await cache.thumbnailFor(uris[0])
      expect(load).toHaveBeenCalledTimes(4)
      expect(cache.size).toBe(2)
      expect(cache.bytes).toBe(2_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('第 75 波 review: 大きさの上限の既定は 100 MB より十分に小さい', () => {
    expect(MAX_THUMBNAIL_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024)
  })

  it('TODO 1172: 生成する一辺は 384 px (小窓のタイルを 999 の 2 倍にした分)', () => {
    expect(THUMBNAIL_SIZE).toBe(384)
  })

  it('関門に断られた・サムネイルを取らない拡張子・文字列でない値は null で、取りに行かない', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,AAAA')
    const cache = new ThumbnailCache(
      {
        assertAllowed: (uri) => {
          if (uri.includes('secret')) throw new Error('denied')
          return uri.replace('file://', '')
        }
      },
      load
    )
    expect(await cache.thumbnailFor(pathToUri('/secret/a.png'))).toBeNull()
    expect(await cache.thumbnailFor(pathToUri('/tmp/a.c'))).toBeNull()
    expect(await cache.thumbnailFor(42)).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Shared and renderer
// ---------------------------------------------------------------------------

describe('共有の表・設定の鍵', () => {
  it('種類の表と引数の検め', () => {
    expect(recentKindOf('PNG')).toBe('image')
    expect(recentKindOf('mp4')).toBe('video')
    expect(recentKindOf('xlsx')).toBe('document')
    expect(recentKindOf('h')).toBe('code')
    expect(recentKindOf('o')).toBeNull()
    expect(asRecentListOptions({ kinds: ['image', 'bogus'], limit: 9999 })).toEqual({ kinds: ['image'], limit: RECENT_MAX })
    expect(asRecentListOptions(null)).toEqual({ kinds: null, limit: RECENT_MAX })
  })

  it('composer.screenshotOffer は既定でオン、owner は main', () => {
    expect(COMPOSER_SCREENSHOT_OFFER.parse(null)).toBe(true)
    expect(COMPOSER_SCREENSHOT_OFFER.parse('false')).toBe(false)
    expect(COMPOSER_SCREENSHOT_OFFER.owner).toBe('main')
  })
})

describe('renderer の純関数', () => {
  const entry = (name: string, isDirectory = false): FileEntry => ({
    uri: pathToUri(`/a/${name}`),
    parentUri: pathToUri('/a'),
    name,
    isDirectory,
    size: 1,
    mtimeMs: NOW,
    ext: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  })
  const batch = (changes: FileChangeBatch['changes']): FileChangeBatch => ({ changes, at: NOW })

  it('差分の合図: 表にある拡張子の作成・更新だけ (小窓と札の両方の合図、TODO 1172)', () => {
    const png = entry('s.png')
    expect(batchTouchesRecent(batch([{ type: 'update', uri: png.uri, parentUri: png.parentUri, entry: png }]))).toBe(true)
    expect(batchTouchesRecent(batch([{ type: 'delete', uri: png.uri, parentUri: png.parentUri, entry: null }]))).toBe(false)
    const o = entry('x.o')
    expect(batchTouchesRecent(batch([{ type: 'create', uri: o.uri, parentUri: o.parentUri, entry: o }]))).toBe(false)
    const md = entry('notes.md')
    expect(batchTouchesRecent(batch([{ type: 'create', uri: md.uri, parentUri: md.parentUri, entry: md }]))).toBe(true)
    const hidden = entry('.env.json')
    expect(batchTouchesRecent(batch([{ type: 'update', uri: hidden.uri, parentUri: hidden.parentUri, entry: hidden }]))).toBe(false)
  })

  it('札: 5 分を過ぎた・消した・添付済みなら出さない', () => {
    const offer = { uri: pathToUri('/d/s.png'), mtimeMs: NOW }
    expect(offerVisible(offer, NOW + MIN, new Set(), [])).toBe(true)
    expect(offerVisible(offer, NOW + 6 * MIN, new Set(), [])).toBe(false)
    expect(offerVisible(offer, NOW, new Set([offerKey(offer)]), [])).toBe(false)
    expect(offerVisible(offer, NOW, new Set(), [offer.uri])).toBe(false)
    // TODO 1172: a dismissed badge is not shown again for the same file (it does not come back even if the AI rewrites it and the mtime changes).
    expect(offerVisible({ ...offer, mtimeMs: NOW + 1 }, NOW + 1, new Set([offerKey(offer)]), [])).toBe(false)
    expect(offerVisible(null, NOW, new Set(), [])).toBe(false)
  })

  it('TODO 1172: 札の並びは順のまま消した・添付済み・期限切れを落とす。次に出し直すのはいちばん古い札の 5 分後', () => {
    const a = { uri: pathToUri('/d/a.png'), mtimeMs: NOW }
    const b = { uri: pathToUri('/d/b.md'), mtimeMs: NOW - 2 * MIN }
    const c = { uri: pathToUri('/d/c.ts'), mtimeMs: NOW - 6 * MIN }
    expect(visibleOffers([a, b, c], NOW, new Set(), [])).toEqual([a, b])
    expect(visibleOffers([a, b, c], NOW, new Set([offerKey(a)]), [])).toEqual([b])
    expect(visibleOffers([a, b, c], NOW, new Set(), [b.uri])).toEqual([a])
    expect(nextOfferExpiry([a, b])).toBe(b.mtimeMs + RECENT_OFFER_MS)
    expect(nextOfferExpiry([])).toBeNull()
    // Review of wave 75: main returns more, so after the exclusions it cuts to the first 3.
    const more = Array.from({ length: 30 }, (_, i) => ({ uri: pathToUri(`/d/m${i}.png`), mtimeMs: NOW - i }))
    expect(visibleOffers(more, NOW, new Set(), [])).toEqual(more.slice(0, RECENT_OFFER_MAX))
    expect(visibleOffers(more, NOW, new Set(more.slice(0, 3).map(offerKey)), [])).toEqual(more.slice(3, 3 + RECENT_OFFER_MAX))
  })

  it('第 75 波 review: 札を聞き直す合図は 5 分の幅の中の作成・更新で、消した札のファイルでないものだけ', () => {
    const fresh = { ...entry('s.png'), mtimeMs: NOW - MIN }
    const stale = { ...entry('t.png'), mtimeMs: NOW - RECENT_OFFER_MS - 1 }
    const change = (e: FileEntry): FileChangeBatch['changes'][number] => ({ type: 'update', uri: e.uri, parentUri: e.parentUri, entry: e })
    expect(batchTouchesOffers(batch([change(fresh)]), NOW, new Set())).toBe(true)
    expect(batchTouchesOffers(batch([change(stale)]), NOW, new Set())).toBe(false)
    expect(batchTouchesOffers(batch([change(fresh)]), NOW, new Set([offerKey(fresh)]))).toBe(false)
    expect(batchTouchesOffers(batch([change(stale), change(fresh)]), NOW, new Set())).toBe(true)
    const o = { ...entry('x.o'), mtimeMs: NOW }
    expect(batchTouchesOffers(batch([change(o)]), NOW, new Set())).toBe(false)
  })

  it('場所はホームを ~ に畳む', () => {
    expect(recentLocation({ parentUri: pathToUri('/Users/a/Desktop') }, pathToUri('/Users/a'))).toBe('~/Desktop')
    expect(recentLocation({ parentUri: pathToUri('/tmp/x') }, '')).toBe('/tmp/x')
  })

  it('空の `@` の候補は新しい順のまま、作業フォルダの中は相対', () => {
    const files = [
      { uri: pathToUri('/w/src/b.ts'), name: 'b.ts' },
      { uri: pathToUri('/Users/a/Desktop/s.png'), name: 's.png' },
      { uri: pathToUri('/w/a.ts'), name: 'a.ts' }
    ]
    const out = recentAtCandidates(files, pathToUri('/w'), 2)
    expect(out.map((c) => c.path)).toEqual(['src/b.ts', '/Users/a/Desktop/s.png'])
    expect(out.map((c) => c.inCwd)).toEqual([true, false])
  })
})

describe('サムネイルの縦横比 (TODO 1179)', () => {
  it('pngDimensions: IHDR の縦横を読む。PNG でなければ null', () => {
    const header = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
    header.writeUInt32BE(13, 8)
    header.write('IHDR', 12, 'ascii')
    header.writeUInt32BE(768, 16)
    header.writeUInt32BE(384, 20)
    expect(pngDimensions(header)).toEqual({ width: 768, height: 384 })
    expect(pngDimensions(Buffer.alloc(40))).toBeNull()
    expect(pngDimensions(Buffer.alloc(3))).toBeNull()
  })

  it('shrinkToFit: 長い辺を 384 にして縦横比を保つ (横長・縦長・正方形)。収まる小さい絵は引き伸ばさない', () => {
    expect(shrinkToFit(768, 384)).toEqual({ width: 384, height: 192 })
    expect(shrinkToFit(256, 768)).toEqual({ width: 128, height: 384 })
    expect(shrinkToFit(768, 768)).toEqual({ width: 384, height: 384 })
    expect(shrinkToFit(40, 20)).toBeNull()
    expect(shrinkToFit(384, 200)).toBeNull()
    expect(shrinkToFit(100_000, 10)).toEqual({ width: 384, height: 1 })
  })
})
