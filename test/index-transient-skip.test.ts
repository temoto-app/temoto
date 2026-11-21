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

describe('TODO 921: iCloud not-yet-downloaded state goes into the version', () => {
  it('isDataless is only for files with blocks === 0 and a nonzero size', () => {
    const file = (size: number, blocks: number) => ({ isFile: () => true, size, blocks })
    expect(isDataless(file(10, 0))).toBe(true)
    expect(isDataless(file(10, 8))).toBe(false)
    expect(isDataless(file(0, 0))).toBe(false)
    expect(isDataless({ isFile: () => false, size: 10, blocks: 0 })).toBe(false)
  })

  it('the version of a file with real content is the same string as before (existing rows are not refetched)', () => {
    expect(fsVersion({ isDirectory: false, mtimeMs: 1234.5, size: 100 })).toBe('1234.5:100')
    expect(fsVersion({ isDirectory: false, mtimeMs: 1234.5, size: 100, dataless: false })).toBe('1234.5:100')
    expect(fsVersion({ isDirectory: false, mtimeMs: 1234.5, size: 100, dataless: true })).toBe(
      '1234.5:100:dataless'
    )
  })

  it('a row skipped as not downloaded returns to pending when downloaded with the same mtime / size (deep scan)', () => {
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

  it('the incremental scan comparison also looks at whether the content exists', () => {
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

describe('TODO 921: a file that could not be read becomes failed and is retried by a rewrite', () => {
  it('a file that cannot be opened is failed, and when it becomes readable and the scan rewrites it, it becomes indexed', async () => {
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

  it('a permanent reason (binary) stays skipped and is not retried even by a rewrite', async () => {
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

describe('wave 49 review (TODO 921): permanent exclusions do not become failed', () => {
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

  it('a file excluded by a rule is skipped and does not return to pending even by a deep scan rewrite', async () => {
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

  it('one whose parent realpath cannot be resolved (possibly transient) is failed and retried', async () => {
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
