/**
 * Item 100: returns the in-file search (body) in two sections: "inside the current working folder" -> "all".
 *
 * Real files are scanned and indexed into the real encrypted DB (the same shape as `test/index-service.test.ts`).
 * The tree is made separately; the checks there count the entries, so it is not mixed in. The model is not called.
 *
 * What is looked at:
 * - Hits inside the cwd go into the `cwd` section, the rest go into `hits`, and they do not overlap
 * - Boundaries are respected (`appx` is not included under the `app` cwd)
 * - Even if the top of "all" is filled by things outside the cwd, hits inside the cwd are not dropped
 * - Not applied to conversation search or the gateway (`forAgent`)
 * - With no cwd, or a cwd not in the index, there is one section as before
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { pathToUri } from '../src/common/uri.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { makeTestDir } from './helpers/tmp.js'

const KEY = 'e'.repeat(64)

let root: string
let dbDir: string
let db: Db
let store: IndexStore
let index: IndexService
let fs: FsIndexer
let cwd: string

beforeAll(async () => {
  // macOS tmpdir() is /var/folders, which falls under the exclusions of 4.4.2, so it is made under home.
  root = makeTestDir('cwd-search-test')
  dbDir = makeTestDir('cwd-searchdb-test')
  cwd = join(root, 'app')

  mkdirSync(join(cwd, 'src'), { recursive: true })
  mkdirSync(join(root, 'appx'), { recursive: true })
  mkdirSync(join(root, 'other'), { recursive: true })
  // Inside the cwd the word appears only once (ranked lower by BM25). Outside it appears many times (it takes the top).
  writeFileSync(join(cwd, 'src/inbox.md'), '承認インボックスの設計メモ。\n')
  writeFileSync(join(cwd, 'readme.md'), '手順書。承認インボックスについて少し触れる。\n')
  writeFileSync(join(root, 'appx/inbox.md'), '承認インボックス 承認インボックス 承認インボックス\n')
  for (let i = 0; i < 6; i += 1) {
    writeFileSync(
      join(root, `other/note-${i}.md`),
      '承認インボックス 承認インボックス 承認インボックス 承認インボックス\n'
    )
  }

  // smart case (TODO 291): pairs that differ only in case are placed inside and outside the cwd.
  writeFileSync(join(cwd, 'src/zero.md'), 'Inbox Zero plan\n')
  writeFileSync(join(cwd, 'lower.md'), 'inbox zero plan, lowercase\n')
  writeFileSync(join(root, 'other/zero.md'), 'inbox zero plan\n')
  writeFileSync(join(root, 'other/upper-zero.md'), 'Inbox Zero plan outside\n')

  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  runMigrations(db)
  store = new IndexStore(db)
  index = new IndexService({
    db,
    store,
    conversation: {
      readEventText: async () => null,
      threadTitle: async () => null
    },
    transcripts: null,
    onStatus: () => {}
  })
  fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, root, [root])
  await fs.scan()
  await index.build()
}, 60_000)

afterAll(async () => {
  await index.stop()
  await fs.stop()
  db.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

const names = (hits: readonly { uri: string }[]): readonly string[] =>
  hits.map((hit) => decodeURIComponent(hit.uri).slice(`file://${root}/`.length)).sort()

describe('cwd section of full-text search (item 100)', () => {
  it('hits inside cwd go into the cwd section and are not repeated in the everywhere section', async () => {
    const result = await index.search('承認インボックス', 'files', { cwd, cwdUri: pathToUri(cwd) })
    expect(result.cwd?.uri).toBe(pathToUri(cwd))
    expect(names(result.cwd?.hits ?? [])).toEqual(['app/readme.md', 'app/src/inbox.md'])
    expect(result.cwd?.total).toBe(2)
    expect(names(result.hits)).not.toContain('app/readme.md')
    expect(names(result.hits)).toContain('appx/inbox.md')
    expect(result.total).toBe(7)
  })

  it('looks up to the separator: `appx` does not enter a cwd of `app`', async () => {
    const result = await index.search('承認インボックス', 'files', { cwd, cwdUri: pathToUri(cwd) })
    expect(names(result.cwd?.hits ?? [])).not.toContain('appx/inbox.md')
  })

  it('even if the top of everywhere is filled outside cwd, hits inside cwd are not dropped', async () => {
    // Limit of 1 result. The top result in "all" is an outside file with many occurrences of the word.
    const result = await index.search('承認インボックス', 'files', {
      cwd,
      cwdUri: pathToUri(cwd),
      limit: 1
    })
    expect(result.cwd?.hits).toHaveLength(1)
    expect(result.cwd?.total).toBe(2)
    expect(result.cwd?.truncated).toBe(true)
    expect(names(result.hits)[0]?.startsWith('app/')).toBe(false)
  })

  it('without cwd, stays one section (as before)', async () => {
    const result = await index.search('承認インボックス', 'files')
    expect(result.cwd).toBeUndefined()
    expect(result.total).toBe(9)
  })

  it('a cwd not in the index makes no section', async () => {
    const missing = join(root, 'nowhere')
    const result = await index.search('承認インボックス', 'files', {
      cwd: missing,
      cwdUri: pathToUri(missing)
    })
    expect(result.cwd).toBeUndefined()
    expect(result.total).toBe(9)
  })

  it('not applied to conversation search or the gateway (forAgent)', async () => {
    const conversation = await index.search('承認インボックス', 'conversation', {
      cwd,
      cwdUri: pathToUri(cwd)
    })
    expect(conversation.cwd).toBeUndefined()
    const agent = await index.search('承認インボックス', 'files', {
      cwd,
      cwdUri: pathToUri(cwd),
      forAgent: true
    })
    expect(agent.cwd).toBeUndefined()
    expect(agent.total).toBe(9)
  })

  it('smart case (TODO 291) applies to both the cwd section and the everywhere section', async () => {
    const cased = await index.search('Inbox Zero', 'files', { cwd, cwdUri: pathToUri(cwd) })
    expect(cased.caseSensitive).toBe(true)
    expect(names(cased.cwd?.hits ?? [])).toEqual(['app/src/zero.md'])
    expect(names(cased.hits)).toEqual(['other/upper-zero.md'])
    const folded = await index.search('inbox zero', 'files', { cwd, cwdUri: pathToUri(cwd) })
    expect(folded.caseSensitive).toBeUndefined()
    expect(names(folded.cwd?.hits ?? [])).toEqual(['app/lower.md', 'app/src/zero.md'])
    expect(names(folded.hits)).toEqual(['other/upper-zero.md', 'other/zero.md'])
  })

  it('FsIndexer choke point: a cwd that hits an exclusion is null (no section, search is not stopped)', () => {
    expect(fs.cwdPathOf(pathToUri(cwd))).toBe(cwd)
    expect(fs.cwdPathOf(pathToUri(join(homedir(), '.ssh')))).toBeNull()
    expect(fs.cwdPathOf('not a uri')).toBeNull()
  })
})

/**
 * TODO 437: the scope of the Search screen ("search in this folder" from a folder in the Files tree). The scope is applied as the narrowing of
 * the subtree in 100, and only what is inside the scope is returned, in one section (`hits`). No `cwd` section is made.
 */
describe('scope (TODO 437)', () => {
  it('full-text search: returns only inside the scope in one section and looks up to the separator (`appx` does not enter a scope of `app`)', async () => {
    const result = await index.search('承認インボックス', 'files', { scope: cwd })
    expect(names(result.hits)).toEqual(['app/readme.md', 'app/src/inbox.md'])
    expect(result.total).toBe(2)
    expect(result.cwd).toBeUndefined()
  })

  it('full-text search: the scope takes priority over cwd and makes no cwd section', async () => {
    const other = join(root, 'other')
    const result = await index.search('承認インボックス', 'files', {
      scope: other,
      cwd,
      cwdUri: pathToUri(cwd)
    })
    expect(result.cwd).toBeUndefined()
    expect(names(result.hits).every((name) => name.startsWith('other/'))).toBe(true)
    expect(result.total).toBe(6)
  })

  it('full-text search: a scope not in the index gives 0 hits (does not drop it and return everywhere); not applied to conversation search or the gateway', async () => {
    const missing = await index.search('承認インボックス', 'files', { scope: join(root, 'nowhere') })
    expect(missing.hits).toEqual([])
    expect(missing.total).toBe(0)
    const agent = await index.search('承認インボックス', 'files', { scope: cwd, forAgent: true })
    expect(agent.total).toBe(9)
  })

  it('file-name search: only inside the scope (up to the separator); cwd is not used', async () => {
    const result = await fs.searchFiles('inbox', 50, pathToUri(join(root, 'other')), pathToUri(cwd))
    expect(result.cwd).toBeNull()
    expect(names(result.entries)).toEqual(['app/src/inbox.md'])
    const whole = await fs.searchFiles('inbox', 50)
    expect(names(whole.entries)).toEqual(['app/src/inbox.md', 'appx/inbox.md'])
  })

  it('file-name search: a scope refused at the choke point (excluded) gives 0 hits', async () => {
    const result = await fs.searchFiles('inbox', 50, null, pathToUri(join(homedir(), '.ssh')))
    expect(result.entries).toEqual([])
    expect(result.total).toBe(0)
  })

  it('buildScope: builds the pending bodies of the scope (buildSubtree) and returns the remaining count; what was built appears in the scope search', async () => {
    writeFileSync(join(cwd, 'src/late.md'), '後から足した遅延メモ。\n')
    writeFileSync(join(root, 'other/late.md'), '後から足した遅延メモ。範囲の外。\n')
    await fs.scan()
    const result = await index.buildScope(cwd)
    expect(result.built).toBeGreaterThanOrEqual(1)
    expect(result.pending).toBe(0)
    expect(result.pendingCapped).toBe(false)
    const hits = await index.search('遅延メモ', 'files', { scope: cwd })
    expect(names(hits.hits)).toEqual(['app/src/late.md'])
    // Does not build waiting for bodies outside the scope (leaves it to the usual build).
    expect(store.pendingInSubtree(directoryRootId(join(root, 'other')), 10)).toHaveLength(1)
  })
})

/** For tests: the id of the directory row (the root of the subtree). */
function directoryRootId(path: string): number {
  const entries = store.entriesByIds([...Array(10_000).keys()])
  const target = entries.find(
    (row) => row.kind === 'directory' && store.pathOf(row.id) === path
  ) as { id: number } | undefined
  if (target === undefined) throw new Error(`no directory row: ${path}`)
  return target.id
}
