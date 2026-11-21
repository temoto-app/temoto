/**
 * Integration test of FsIndexer and FsAccess. Directly checks the Phase 1 completion condition,
 * "files under home can be listed, searched (by filename only), viewed, and edited".
 *
 * **Split into two in P1**: scanning, listing, and filename search are in `FsIndexer` of the index process, and the permission decision is in main's `FsAccess` (3.1; saving edits is `ViewerBroker.write`). Both are built from the same exclusion rules (`createMacosExclusions`), so their decisions agree.
 *
 * Uses the real encrypted DB. Only key retrieval goes through Electron's safeStorage, so the key is given directly here. The safeStorage path is checked by starting the app.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { FsAccess } from '../src/main/fs/access.js'
import { IndexStore } from '../src/index-kernel/store.js'
import type { FileChangeBatch, ScanStatus } from '../src/shared/types.js'
import { pathToUri } from '../src/common/uri.js'
import { PathDenied } from '../src/common/fs-policy.js'
import { makeTestDir } from './helpers/tmp.js'

const KEY = 'b'.repeat(64)
let root: string
let dbDir: string
let db: Db
let service: FsIndexer
let access: FsAccess
const statuses: ScanStatus[] = []
const batches: FileChangeBatch[] = []

// A 1x1 PNG. Real bytes are placed so that the image viewer path is exercised.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

beforeAll(async () => {
  // macOS's tmpdir() is under /var/folders and hits the exclusion of 4.4.2, so create it directly under home to meet the condition "scan under home".
  root = makeTestDir('fs-test')
  dbDir = makeTestDir('fsdb-test')

  mkdirSync(join(root, 'notes'))
  writeFileSync(join(root, 'notes/report.md'), '# 報告\n\n本文です。\n')
  writeFileSync(join(root, 'notes/memo.txt'), 'めも\n')
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets/pixel.png'), PNG)
  mkdirSync(join(root, 'project/node_modules/pkg'), { recursive: true })
  writeFileSync(join(root, 'project/node_modules/pkg/index.js'), '//')
  writeFileSync(join(root, 'project/main.ts'), 'export const a = 1\n')
  mkdirSync(join(root, '.ssh'))
  writeFileSync(join(root, '.ssh/id_rsa'), 'PRIVATE')
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))

  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  runMigrations(db)

  service = new FsIndexer(
    db,
    {
      onScanStatus: (status) => statuses.push(status),
      onFileChanges: (batch) => batches.push(batch)
    },
    new IndexStore(db),
    root,
    // In Phase 3 the default scan scope became the whole PC, so the test states the tree explicitly.
    [root]
  )
  access = new FsAccess(root, [root])
  await service.scan()
})

afterAll(async () => {
  await service.stop()
  db.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

describe('走査', () => {
  it('完了し、進捗を通知する', () => {
    const status = service.getScanStatus()
    expect(status.state).toBe('done')
    expect(status.indexed).toBeGreaterThan(0)
    expect(statuses.length).toBeGreaterThan(1)
    expect(statuses[0]?.state).toBe('scanning')
  })

  it('除外リストのものを入れない', () => {
    // In Phase 3 the rows moved from `files` to `documents`, and they **hold no path** (only the name and the parent id, 12.4). Check by name.
    const rows = db
      .prepare(`SELECT name FROM documents WHERE source = 'fs'`)
      .all() as { name: string }[]
    const names = rows.map((row) => row.name)
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('.ssh')
    expect(names).not.toContain('id_rsa')
  })
})

describe('一覧 (完了条件: 一覧)', () => {
  it('ルート直下を返す', async () => {
    const listing = await service.listDirectory(pathToUri(root))
    const names = listing.entries.map((e) => e.name)
    expect(names).toContain('notes')
    expect(names).toContain('assets')
    expect(names).toContain('project')
    expect(names).not.toContain('.ssh')
  })

  it('ディレクトリを先に、名前順で返す', async () => {
    const listing = await service.listDirectory(pathToUri(root))
    const dirFlags = listing.entries.map((e) => e.isDirectory)
    expect(dirFlags.indexOf(false)).toBeGreaterThan(dirFlags.lastIndexOf(true))
  })

  it('renderer にはパスではなく URI を返す', async () => {
    const listing = await service.listDirectory(pathToUri(join(root, 'notes')))
    for (const entry of listing.entries) expect(entry.uri.startsWith('file://')).toBe(true)
  })

  it('OS 領域は拒否する', async () => {
    // In Phase 3 the index covers the whole PC, so the rejection is "matches the exclusion list", not "outside the scan root" (4.4.2 / 12.7). `/etc` is a symlink to `/private/etc`, so in Phase 3 it was added to the exclusions explicitly.
    await expect(service.listDirectory('file:///etc')).rejects.toThrow(/excluded/)
    await expect(service.listDirectory('file:///System')).rejects.toThrow(/excluded/)
  })

  it('除外パスは拒否する', async () => {
    await expect(service.listDirectory(pathToUri(join(root, '.ssh')))).rejects.toThrow(/excluded/)
  })
})

describe('検索 (完了条件: ファイル名検索)', () => {
  // The matching rules themselves are fixed by test/file-search.test.ts (the qlm style of 6.6). Here only the FsIndexer path is checked: exclusion, URI conversion, and reporting of counts.
  it('部分一致で見つける', async () => {
    expect((await service.searchFiles('report')).entries.map((e) => e.name)).toContain('report.md')
    expect((await service.searchFiles('memo')).entries.map((e) => e.name)).toContain('memo.txt')
  })

  // Made smart case in TODO 291: all lowercase does not distinguish case, and words containing uppercase do.
  it('smart case: 全部小文字なら区別せず、大文字を含めば区別する (結果に caseSensitive を載せる)', async () => {
    expect((await service.searchFiles('rEpOrT')).entries.map((e) => e.name)).not.toContain('report.md')
    const upper = await service.searchFiles('REPORT')
    expect(upper.entries.map((e) => e.name)).not.toContain('report.md')
    expect(upper.caseSensitive).toBe(true)
    const lower = await service.searchFiles('report')
    expect(lower.entries.map((e) => e.name)).toContain('report.md')
    expect(lower.caseSensitive).toBeUndefined()
  })

  it('除外されたファイルは出ない', async () => {
    expect((await service.searchFiles('id_rsa')).entries).toHaveLength(0)
    expect((await service.searchFiles('pkg')).entries).toHaveLength(0)
  })

  it('空クエリは 0 件', async () => {
    expect((await service.searchFiles('   ')).entries).toHaveLength(0)
  })

  it('クエリの記号は literal として扱う (LIKE も正規表現も使わない)', async () => {
    // If '%' passed through, every row would come back. Only indexOf is used now, so with no name containing '%' there are 0 results.
    expect((await service.searchFiles('%')).entries).toHaveLength(0)
  })

  it('limit を守り、総数と打ち切りを申告する', async () => {
    const result = await service.searchFiles('e', 2)
    expect(result.entries.length).toBeLessThanOrEqual(2)
    expect(result.total).toBeGreaterThanOrEqual(result.entries.length)
    expect(result.truncated).toBe(result.total > result.entries.length)
  })
})

// The section "viewing (completion condition: viewing)" was removed in item 160 (2026-09-28), together with `FsAccess.readResource` (there was no production caller; the viewer's reads go through `ViewerBroker.read`, the Broker). The same viewpoints are covered by the text / binary check in the "C-2" section of `test/capability-resource.test.ts`, and the refusal of OS areas and excluded paths (the same `resolvePath` / `classify` as `assertAllowed`) is already in `test/capability-fs.test.ts`.
//
// The "editing" section was also removed, together with `FsAccess.writeTextFile`, in the 2026-10-01 review (likewise there was no production caller; saving is `ViewerBroker.write`). Saving, mtime conflicts, and refusals are held by the "ViewerBroker.write" section of `test/capability-resource.test.ts`. Only the exclusion check of the write-side choke point (`assertAllowed`, whose default is write) is kept here.

describe('書き込みの関門 (完了条件: 編集)', () => {
  it('走査範囲のファイルは通る', () => {
    const path = join(root, 'notes/memo.txt')
    expect(access.assertAllowed(pathToUri(path), false)).toBe(path)
  })

  it('OS 領域には通さない', () => {
    expect(() => access.assertAllowed('file:///etc/hosts', false)).toThrow(PathDenied)
  })

  it('除外パスには通さない', () => {
    expect(() => access.assertAllowed(pathToUri(join(root, '.ssh/id_rsa')), false)).toThrow(PathDenied)
  })
})

describe('削除の追従', () => {
  it('再走査で消えたファイルが一覧から落ちる', async () => {
    rmSync(join(root, 'notes/memo.txt'))
    await service.scan()
    expect((await service.searchFiles('memo')).entries).toHaveLength(0)
  })
})
