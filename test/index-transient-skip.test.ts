/**
 * TODO 921: when the reason a body could not be read is temporary (iCloud not yet downloaded, cannot be opened, cannot be read), and the row became `skipped`, it was never fetched again until the version (mtime:size) changed.
 *
 * - Not yet downloaded from iCloud (`blocks === 0`) adds `:dataless` to the version. Even if the mtime and size do not change by the download, the version changes and it returns to `pending` (both the upsert of the deep scan and the comparison of the incremental scan).
 * - Cannot be opened or read becomes `failed`, and returns to `pending` when the scan or watch rewrites the row.
 *
 * The model is not called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore, fsVersion, type FsEntryInput } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { isDataless } from '../src/index-kernel/scanner.js'
import { createMacosExclusions } from '../src/common/exclusions.js'
import { makeTestDir } from './helpers/tmp.js'

let dbDir: string
let root: string
let db: Db
let store: IndexStore

beforeEach(() => {
  dbDir = makeTestDir('transient-db')
  root = makeTestDir('transient-files')
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${'d'.repeat(64)}'`)
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dbDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

function stateOf(id: number): string {
  return (db.prepare(`SELECT index_state FROM documents WHERE id = ?`).get(id) as { index_state: string })
    .index_state
}

function entry(parentId: number, extra: Partial<FsEntryInput> = {}): FsEntryInput {
  return {
    parentId,
    name: 'note.txt',
    isDirectory: false,
    ext: 'txt',
    size: 100,
    mtimeMs: 1234.5,
    seenAt: 1,
    ...extra
  }
}

describe('TODO 921: iCloud の未取得は版に入る', () => {
  it('isDataless は blocks === 0 で大きさのあるファイルだけ', () => {
    const file = (size: number, blocks: number) => ({ isFile: () => true, size, blocks })
    expect(isDataless(file(10, 0))).toBe(true)
    expect(isDataless(file(10, 8))).toBe(false)
    expect(isDataless(file(0, 0))).toBe(false)
    expect(isDataless({ isFile: () => false, size: 10, blocks: 0 })).toBe(false)
  })

  it('実体のあるファイルの版は以前と同じ文字列 (既存の行を取り直さない)', () => {
    expect(fsVersion({ isDirectory: false, mtimeMs: 1234.5, size: 100 })).toBe('1234.5:100')
    expect(fsVersion({ isDirectory: false, mtimeMs: 1234.5, size: 100, dataless: false })).toBe('1234.5:100')
    expect(fsVersion({ isDirectory: false, mtimeMs: 1234.5, size: 100, dataless: true })).toBe(
      '1234.5:100:dataless'
    )
  })

  it('未取得で skipped になった行が、同じ mtime / size の取得で pending に戻る (深い走査)', () => {
    const parent = store.ensureDirectory(join(root, 'icloud'), 1)
    const first = store.upsertFsEntry(entry(parent, { dataless: true }))
    store.markSkipped(first.id)
    // If the version is the same (still not downloaded), it stays skipped.
    expect(store.upsertFsEntry(entry(parent, { dataless: true })).needsContent).toBe(false)
    expect(stateOf(first.id)).toBe('skipped')

    const after = store.upsertFsEntry(entry(parent, { dataless: false }))
    expect(after.id).toBe(first.id)
    expect(after.needsContent).toBe(true)
    expect(stateOf(first.id)).toBe('pending')
  })

  it('増分走査の比較も実体の有無を見る', () => {
    const parent = store.ensureDirectory(join(root, 'icloud-inc'), 1)
    const first = store.upsertFsEntry(entry(parent, { dataless: true }))
    store.markSkipped(first.id)
    expect(store.upsertFsEntryIncremental(entry(parent, { dataless: true })).changed).toBe(false)

    const after = store.upsertFsEntryIncremental(entry(parent, { dataless: false }))
    expect(after.changed).toBe(true)
    expect(after.needsContent).toBe(true)
    expect(stateOf(first.id)).toBe('pending')
    // Seeing the same thing after the download does not write.
    expect(store.upsertFsEntryIncremental(entry(parent, { dataless: false })).changed).toBe(false)
  })
})

describe('TODO 921: 読めなかったファイルは failed にして、書き直しで取り直す', () => {
  it('開けないファイルは failed、読めるようになって走査が書き直すと indexed になる', async () => {
    if (process.getuid?.() === 0) return // root can read even with chmod 000
    const dir = join(root, 'locked')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'secret.md')
    writeFileSync(path, '# 見出し\n\n一時的に読めない本文 transientword\n')
    const stats = statSync(path)
    const parent = store.ensureDirectory(dir, 1)
    const input: FsEntryInput = {
      parentId: parent,
      name: 'secret.md',
      isDirectory: false,
      ext: 'md',
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      seenAt: 1
    }
    const row = store.upsertFsEntry(input)
    const service = (): IndexService =>
      new IndexService({
        db,
        store,
        conversation: { readEventText: async () => null, threadTitle: async () => null },
        transcripts: null,
        onStatus: () => {}
      })

    chmodSync(path, 0o000)
    try {
      const index = service()
      await index.build()
      await index.stop()
      expect(stateOf(row.id)).toBe('failed')
    } finally {
      chmodSync(path, 0o644)
    }

    // The version has not changed (chmod does not change mtime). Before, it stayed skipped and was never fetched again.
    expect(store.upsertFsEntry(input).needsContent).toBe(true)
    expect(stateOf(row.id)).toBe('pending')
    const index = service()
    await index.build()
    await index.stop()
    expect(stateOf(row.id)).toBe('indexed')
  }, 60_000)

  it('恒久的な理由 (バイナリ) は skipped のまま、書き直しでも取り直さない', async () => {
    const dir = join(root, 'binary')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'data.txt')
    writeFileSync(path, Buffer.from([0x41, 0x00, 0x42]))
    const stats = statSync(path)
    const parent = store.ensureDirectory(dir, 1)
    const input: FsEntryInput = {
      parentId: parent,
      name: 'data.txt',
      isDirectory: false,
      ext: 'txt',
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      seenAt: 1
    }
    const row = store.upsertFsEntry(input)
    const index = new IndexService({
      db,
      store,
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: null,
      onStatus: () => {}
    })
    await index.build()
    await index.stop()
    expect(stateOf(row.id)).toBe('skipped')
    expect(store.upsertFsEntry(input).needsContent).toBe(false)
    expect(stateOf(row.id)).toBe('skipped')
  }, 60_000)
})

describe('第 49 波 review (TODO 921): 恒久の除外は failed にしない', () => {
  const service = (): IndexService =>
    new IndexService({
      db,
      store,
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: null,
      // Treat root as the home: `<root>/.ssh` hits the credential exclusion.
      fsRules: () => createMacosExclusions(root),
      onStatus: () => {}
    })

  it('規則で除外のファイルは skipped、深い走査の書き直しでも pending に戻らない', async () => {
    const dir = join(root, '.ssh')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.md'), 'excludedword\n')
    const parent = store.ensureDirectory(dir, 1)
    const input = entry(parent, { name: 'notes.md', ext: 'md' })
    const row = store.upsertFsEntry(input)
    const index = service()
    await index.build()
    await index.stop()
    expect(stateOf(row.id)).toBe('skipped')
    // Before, it became failed, and each time the deep scan or watch rewrote it, it repeated pending → failed.
    expect(store.upsertFsEntry(input).needsContent).toBe(false)
    expect(stateOf(row.id)).toBe('skipped')
  }, 60_000)

  it('親の realpath が引けない (一時的かもしれない) ものは failed で取り直す', async () => {
    const parent = store.ensureDirectory(join(root, 'missing-dir'), 1)
    const input = entry(parent, { name: 'later.md', ext: 'md' })
    const row = store.upsertFsEntry(input)
    const index = service()
    await index.build()
    await index.stop()
    expect(stateOf(row.id)).toBe('failed')
    expect(store.upsertFsEntry(input).needsContent).toBe(true)
  }, 60_000)
})
