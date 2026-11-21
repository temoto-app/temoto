/**
 * Regression: the watch's diff followed a file symlink and put the contents of credentials into the index (TODO 849).
 *
 * 1. The watch's diff (`enqueueChanges`) is checked with `lstat`, as the scan is: a file symlink does not become a row.
 *    A directory symlink reapplies the exclusion rules to the target too. If a normal file is replaced by a symlink, its row is dropped.
 * 2. Body extraction and range reading read only regular files, with `O_NOFOLLOW` + `fstat`.
 * 3. Reads (`getDocument*` / `getChunk` / the search snippet) reapply the exclusion rules at read time to both the logical path and the realpath
 *    (for a directory in an intermediate segment that now points inside an exclusion).
 *
 * The real SQLite (in memory) and the real disk (`~/.aios-test/<run>/`). The model is not called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { extractFile, extractGate, readUtf8Range } from '../src/index-kernel/extract.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

/** `@parcel/watcher` is not used (the diff is fed directly into `enqueueChanges`). */
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

const SECRET = 'Host needle-secret-host IdentityFile key'

let root: string
let db: Db
let store: IndexStore
let fs: FsIndexer
let index: IndexService

beforeEach(async () => {
  root = makeTestDir('watch-symlink')
  mkdirSync(join(root, '.ssh'))
  writeFileSync(join(root, '.ssh', 'config'), `${SECRET}\n`)
  mkdirSync(join(root, 'proj'))
  writeFileSync(join(root, 'proj', 'plain.md'), 'plain public words\n')
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
  fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, root, [root])
  index = new IndexService({
    db,
    store,
    conversation: { readEventText: async () => null, threadTitle: async () => null },
    transcripts: null,
    fsRules: () => fs.exclusionRules,
    onStatus: () => {}
  })
  await fs.scan()
  await index.build()
})

afterEach(async () => {
  await index.stop()
  await fs.stop()
  if (db.open) db.close()
  removeTestDir(root)
})

const rowOf = (name: string): { id: number; index_state: string } | undefined =>
  db
    .prepare(`SELECT id, index_state FROM documents WHERE source = 'fs' AND name = ?`)
    .get(name) as { id: number; index_state: string } | undefined

describe('watch diffs do not follow file symlinks (TODO 849)', () => {
  it('a symlink created after the scan (→ ~/.ssh/config) does not become a row, and its body does not appear in search', async () => {
    expect(rowOf('config')).toBeUndefined()
    const link = join(root, 'proj', 'notes.md')
    symlinkSync(join(root, '.ssh', 'config'), link)
    await fs.enqueueChanges([{ type: 'create', path: link }])
    expect(rowOf('notes.md')).toBeUndefined()
    await index.build()
    const hits = await index.search('needle', 'files', { forAgent: true })
    expect(hits.hits).toHaveLength(0)
  })

  it('a file symlink pointing outside the exclusions also does not become a row, as in the scan', async () => {
    const link = join(root, 'proj', 'alias.md')
    symlinkSync(join(root, 'proj', 'plain.md'), link)
    await fs.enqueueChanges([{ type: 'create', path: link }])
    expect(rowOf('alias.md')).toBeUndefined()
  })

  it('when a regular file is later replaced by a symlink, drops the row', async () => {
    const path = join(root, 'proj', 'plain.md')
    expect(rowOf('plain.md')?.index_state).toBe('indexed')
    unlinkSync(path)
    symlinkSync(join(root, '.ssh', 'config'), path)
    await fs.enqueueChanges([{ type: 'update', path }])
    expect(rowOf('plain.md')).toBeUndefined()
  })

  it('a directory symlink does not become a row if its target is inside an exclusion; if outside, it becomes a directory row', async () => {
    const bad = join(root, 'proj', 'keys')
    symlinkSync(join(root, '.ssh'), bad)
    mkdirSync(join(root, 'docs'))
    const good = join(root, 'proj', 'docs-link')
    symlinkSync(join(root, 'docs'), good)
    await fs.enqueueChanges([
      { type: 'create', path: bad },
      { type: 'create', path: good }
    ])
    expect(rowOf('keys')).toBeUndefined()
    expect(rowOf('docs-link')).toBeDefined()
  })
})

describe('reading the body does not follow symlinks (TODO 849)', () => {
  it('extractFile / extractGate / readUtf8Range do not read symlinks', async () => {
    const link = join(root, 'proj', 'link.md')
    symlinkSync(join(root, '.ssh', 'config'), link)
    expect(await extractFile(link)).toEqual({ ok: false, reason: 'unreadable' })
    expect(await extractGate(link)).toBe('unreadable')
    await expect(readUtf8Range(link, 0, 100)).rejects.toThrow()
    // A normal file can still be read as before.
    const plain = await extractFile(join(root, 'proj', 'plain.md'))
    expect(plain.ok).toBe(true)
    expect((await readUtf8Range(join(root, 'proj', 'plain.md'), 0, 5)).text).toBe('plain')
  })

  it('the body of a file replaced after indexing does not appear in getDocument* / getChunk / snippet', async () => {
    const row = rowOf('plain.md')
    expect(row?.index_state).toBe('indexed')
    const id = String(row?.id)
    expect(await index.getDocumentText(id, 0, 100, true)).not.toBeNull()
    const chunkId = (
      db.prepare(`SELECT id FROM chunks WHERE document_id = ? LIMIT 1`).get(row?.id) as { id: number }
    ).id

    // Before the watch's diff arrived (a missed one), the file was replaced with a symlink.
    const path = join(root, 'proj', 'plain.md')
    unlinkSync(path)
    symlinkSync(join(root, '.ssh', 'config'), path)
    expect(await index.getDocument(id, 1000, true)).toBeNull()
    expect(await index.getDocumentText(id, 0, 100, true)).toBeNull()
    expect(await index.getChunk(String(chunkId), true)).toBeNull()
    expect((await index.search('plain', 'files', { forAgent: true })).hits).toHaveLength(0)
  })

  it('when an intermediate directory comes to point inside an exclusion, the realpath recheck at read time stops it', async () => {
    // Replace proj/ with a symlink to ~/.ssh and put plain.md in ~/.ssh (O_NOFOLLOW only checks the last segment).
    const row = rowOf('plain.md')
    const id = String(row?.id)
    renameSync(join(root, 'proj'), join(root, 'proj-old'))
    writeFileSync(join(root, '.ssh', 'plain.md'), `${SECRET}\n`)
    symlinkSync(join(root, '.ssh'), join(root, 'proj'))
    expect(await index.getDocumentText(id, 0, 100, true)).toBeNull()
    expect(await index.getDocument(id, 1000, true)).toBeNull()
    rmSync(join(root, 'proj'))
  })
})
