/**
 * migration 15 (item 83 / 84) and the read/write entry points built on it. The model is not called.
 *
 * What it guarantees:
 * - An existing row's `title_auto` is set to 1 only when the title is exactly the default title.
 * - `threads.archived` / `documents.sensitivity` / `index_runs` are dropped.
 * - Duplicates in `cwd_history` that differ only in case merge into one row (the counts are added; the display is the last spelling).
 * - `scan_denials` does not exceed the newest 1,000 rows (pruning of existing rows, and a trigger on each insert).
 * - The list is ordered newest first by the last event, walking `threads_recent` in reverse (no temporary B-tree).
 * - `IndexStore.recentDenials` and the fixed-length `markSkippedBulk` (item 89).
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { MIGRATIONS, runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { IndexStore } from '../src/index-kernel/store.js'

const HOME = '/Users/tester'
const opened: Db[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

/** The DB with migrations up to 14 applied (= just before this change). */
function atVersion14(): Db {
  const db = new Database(':memory:')
  opened.push(db)
  db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS.filter((m) => m.version <= 14)) db.exec(migration.up)
  db.pragma('user_version = 14')
  return db
}

function latest(): Db {
  const db = new Database(':memory:')
  opened.push(db)
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function columns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
}

describe('migration 15 (項目 83 / 84)', () => {
  it('title_auto は既定題そのものの行だけ 1 に埋め、archived / sensitivity / index_runs を落とす', () => {
    const db = atVersion14()
    const insert = db.prepare(`
      INSERT INTO threads (id, title, cwd, allowed_dirs, retention, unread, archived,
                           setting_sources, backend, approval_strict, created_at, updated_at)
      VALUES (?, ?, '/w', '[]', 'forever', 0, 0, '["project"]', 'agent-cli', 0, 1, 1)`)
    insert.run('placeholder', '新しいスレッド')
    insert.run('named', '仕様の相談')
    db.prepare(
      `INSERT INTO documents (source, name, name_folded, kind, sensitivity) VALUES ('fs', 'a', 'a', 'file', 'high')`
    ).run()

    expect(runMigrations(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version)
    expect(db.prepare(`SELECT id, title_auto FROM threads ORDER BY id`).all()).toEqual([
      { id: 'named', title_auto: 0 },
      { id: 'placeholder', title_auto: 1 }
    ])
    expect(columns(db, 'threads')).not.toContain('archived')
    expect(columns(db, 'documents')).not.toContain('sensitivity')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM documents`).get()).toEqual({ n: 1 })
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((row) => row.name)
    expect(tables).not.toContain('index_runs')
    expect(tables).toContain('scan_denials')
  })

  it('cwd_history の大小違い (NFC / NFD を含む) を 1 行に寄せる', () => {
    const db = atVersion14()
    const insert = db.prepare(
      `INSERT INTO cwd_history (path, last_used_at, use_count) VALUES (?, ?, ?)`
    )
    insert.run('/Users/tester/Work', 10, 2)
    insert.run('/Users/tester/work', 20, 3)
    // Composed and decomposed dakuten (NFC / NFD) go to the same directory. SQLite's lower() does not merge them.
    insert.run('/Users/tester/データ'.normalize('NFD'), 5, 1)
    insert.run('/Users/tester/データ'.normalize('NFC'), 7, 1)
    runMigrations(db)

    const rows = db
      .prepare(`SELECT path_folded, path, last_used_at, use_count FROM cwd_history ORDER BY last_used_at DESC`)
      .all()
    expect(rows).toEqual([
      { path_folded: '/users/tester/work', path: '/Users/tester/work', last_used_at: 20, use_count: 5 },
      {
        path_folded: '/users/tester/データ'.normalize('NFC'),
        path: '/Users/tester/データ'.normalize('NFC'),
        last_used_at: 7,
        use_count: 2
      }
    ])

    // Later records also merge into one row by the folded key. Deletion also works with a spelling that differs only in case.
    const store = new ThreadStore(db, HOME)
    store.touchCwd('/USERS/TESTER/WORK', 30)
    expect(store.cwdHistory()[0]).toEqual({
      path: '/USERS/TESTER/WORK',
      lastUsedAt: 30,
      useCount: 6
    })
    store.removeCwd('/users/tester/work')
    expect(store.cwdHistory().map((row) => row.path)).toEqual([
      '/Users/tester/データ'.normalize('NFC')
    ])
  })

  it('scan_denials は新しい 1,000 行だけ残し、以後の挿入でも超えない', () => {
    const db = atVersion14()
    const insert = db.prepare(
      `INSERT INTO scan_denials (path_folded, path, code, seen_at) VALUES (?, ?, 'EACCES', ?)`
    )
    db.transaction(() => {
      for (let i = 0; i < 1200; i += 1) insert.run(`/d/${i}`, `/d/${i}`, i)
    })()
    runMigrations(db)
    const count = (): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM scan_denials`).get() as { n: number }).n
    expect(count()).toBe(1000)
    expect(db.prepare(`SELECT MIN(seen_at) AS m FROM scan_denials`).get()).toEqual({ m: 200 })

    // Each insert makes the trigger drop the oldest row. It has the same upsert shape as the writer (FsIndexer).
    const upsert = db.prepare(`
      INSERT INTO scan_denials (path_folded, path, code, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(path_folded) DO UPDATE SET code = excluded.code, seen_at = excluded.seen_at
    `)
    for (let i = 0; i < 50; i += 1) upsert.run(`/new/${i}`, `/new/${i}`, 'EPERM', 10_000 + i)
    expect(count()).toBe(1000)
    // Updating an existing row (ON CONFLICT DO UPDATE) adds no row, so nothing is dropped.
    upsert.run('/new/0', '/new/0', 'EACCES', 20_000)
    expect(count()).toBe(1000)

    const recent = new IndexStore(db).recentDenials(3)
    expect(recent).toEqual([
      { uri: 'file:///new/0', code: 'EACCES', seenAt: 20_000 },
      { uri: 'file:///new/49', code: 'EPERM', seenAt: 10_049 },
      { uri: 'file:///new/48', code: 'EPERM', seenAt: 10_048 }
    ])
  })
})

describe('スレッドの列ごとの UPDATE と並び (項目 83)', () => {
  function create(store: ThreadStore, id: string, titleAuto = false): void {
    store.createThread({
      id,
      title: titleAuto ? '新しいスレッド' : id,
      titleAuto,
      cwd: '/Users/tester/work',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
  }

  it('並びは最後の出来事 (無ければ作成) の新しい順。既読・設定の変更では動かない', () => {
    const db = latest()
    const store = new ThreadStore(db, HOME)
    create(store, 'a')
    create(store, 'b')
    create(store, 'c')
    db.prepare(`UPDATE threads SET created_at = CASE id WHEN 'a' THEN 1 WHEN 'b' THEN 2 ELSE 3 END`).run()
    expect(store.listThreads().map((t) => t.id)).toEqual(['c', 'b', 'a'])

    store.touchLastEvent('a', 10, { unread: true })
    expect(store.listThreads().map((t) => t.id)).toEqual(['a', 'c', 'b'])
    expect(store.getThread('a')?.unread).toBe(true)

    // Marking read, strict mode, renaming, and retention move only updated_at.
    const before = store.getThread('b')!.updatedAt
    store.setUnread('b', true, before + 100)
    store.setStrict('b', true, before + 200)
    store.setTitle('b', '改名', false, before + 300)
    store.setRetention('b', 'days', 3, before + 400)
    expect(store.getThread('b')?.updatedAt).toBe(before + 400)
    expect(store.listThreads().map((t) => t.id)).toEqual(['a', 'c', 'b'])
    expect(store.listThreadRecords().map((r) => r.thread.id)).toEqual(['a', 'c', 'b'])

    // Time only moves forward (an event that arrives late does not move it backward).
    store.touchLastEvent('a', 5)
    expect(store.getThread('a')?.lastEventAt).toBe(10)
  })

  it('一覧の問い合わせは threads_recent を使い、一時 B-tree を作らない', () => {
    const db = latest()
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM threads WHERE deleted_at IS NULL
           ORDER BY COALESCE(last_event_at, created_at) DESC, threads.rowid DESC`
        )
        .all() as { detail: string }[]
    ).map((row) => row.detail)
    expect(plan.join('\n')).toContain('threads_recent')
    expect(plan.join('\n')).not.toContain('TEMP B-TREE')
  })

  it('自動命名は仮題のときだけ。手で付けた題名は既定題と同じ文字列でも上書きしない', () => {
    const store = new ThreadStore(latest(), HOME)
    create(store, 'auto', true)
    create(store, 'manual')
    store.setTitle('manual', '新しいスレッド')

    expect(store.setAutoTitle('manual', '最初の行')).toBe(false)
    expect(store.getThread('manual')?.title).toBe('新しいスレッド')

    expect(store.setAutoTitle('auto', '最初の行')).toBe(true)
    expect(store.getThread('auto')?.title).toBe('最初の行')
    // Once named, it is not a provisional title.
    expect(store.setAutoTitle('auto', '次の行')).toBe(false)
    // Restoring the provisional title with an empty rename lets the next send name it again.
    store.setTitle('auto', '新しいスレッド', true)
    expect(store.setAutoTitle('auto', '三つ目')).toBe(true)
  })

  it('参照範囲への追加は重複しない', () => {
    const store = new ThreadStore(latest(), HOME)
    create(store, 'a')
    expect(store.addAllowedDir('a', '/Users/tester/extra')).toBe(true)
    expect(store.addAllowedDir('a', '/Users/tester/extra')).toBe(false)
    expect(store.getThread('a')?.allowedDirUris).toEqual(['file:///Users/tester/extra'])
  })
})

describe('IndexStore の固定長の文 (項目 89)', () => {
  it('markSkippedBulk は 100 件ずつの文で端数も含めて全部落とす', () => {
    const db = latest()
    const store = new IndexStore(db)
    const insert = db.prepare(
      `INSERT INTO documents (source, source_id, name, name_folded, kind, index_state)
       VALUES ('conversation', ?, 'n', 'n', 'message', 'indexed')`
    )
    const ids: number[] = []
    db.transaction(() => {
      for (let i = 0; i < 250; i += 1) ids.push(Number(insert.run(`e${i}`).lastInsertRowid))
    })()
    const addChunk = db.prepare(
      `INSERT INTO chunks (document_id, seq, byte_start, byte_end, chars) VALUES (?, 0, 0, 1, 1)`
    )
    for (const id of ids) addChunk.run(id)

    // Excludes 205 of the 250 (= 100 + 100 + the remaining 5) from the target.
    store.markSkippedBulk(ids.slice(0, 205))
    const states = db
      .prepare(`SELECT index_state AS s, COUNT(*) AS n FROM documents GROUP BY index_state ORDER BY s`)
      .all()
    expect(states).toEqual([
      { s: 'indexed', n: 45 },
      { s: 'skipped', n: 205 }
    ])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get()).toEqual({ n: 45 })
    expect(store.counters()).toMatchObject({ documents: 250, skipped: 205, indexed: 45, chunks: 45 })
  })
})
