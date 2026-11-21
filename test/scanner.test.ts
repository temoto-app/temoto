/**
 * Unit tests for the scanner (PHASE1_BRIEF 3.3).
 * Checks symlink loops, inode resolution of duplicates, and skipping of access-denied entries.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMacosExclusions } from '../src/common/exclusions.js'
import { walk, type ScanCounters, type ScannedEntry } from '../src/index-kernel/scanner.js'
import { makeTestDir } from './helpers/tmp.js'

let root: string

beforeAll(() => {
  // On macOS tmpdir() is under /var/folders, which hits the exclusion list in 4.4.2.
  // The scan itself is tested, so it is created in a place that is not excluded (directly under home) and removed afterwards.
  root = makeTestDir('scan-test')
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs/a.md'), '# a')
  writeFileSync(join(root, 'docs/b.txt'), 'b')
  mkdirSync(join(root, 'code/node_modules/pkg'), { recursive: true })
  writeFileSync(join(root, 'code/node_modules/pkg/index.js'), '//')
  writeFileSync(join(root, 'code/main.ts'), 'export {}')
  mkdirSync(join(root, '.ssh'))
  writeFileSync(join(root, '.ssh/id_rsa'), 'secret')

  // Loop: a symlink pointing to one of its own ancestors.
  symlinkSync(root, join(root, 'docs/loop'), 'dir')
  // Duplicate: a symlink pointing to a directory that has already been scanned.
  symlinkSync(join(root, 'docs'), join(root, 'code/docs-alias'), 'dir')

  // Access denied (equivalent to TCC).
  mkdirSync(join(root, 'locked'))
  writeFileSync(join(root, 'locked/hidden.txt'), 'x')
  chmodSync(join(root, 'locked'), 0o000)
})

afterAll(() => {
  chmodSync(join(root, 'locked'), 0o700)
  rmSync(root, { recursive: true, force: true })
})

async function scan(): Promise<{
  entries: ScannedEntry[]
  counters: ScanCounters
  denied: string[]
}> {
  // The exclusion rules are made by treating a temporary directory for the test as home.
  const rules = createMacosExclusions(root)
  const counters: ScanCounters = { seen: 0, excluded: 0, denied: 0, pruned: 0 }
  const denied: string[] = []
  const entries: ScannedEntry[] = []
  for await (const batch of walk(root, rules, counters, {
    batchSize: 3,
    onDenied: (d) => denied.push(d.path)
  })) {
    entries.push(...batch)
  }
  return { entries, counters, denied }
}

describe('walk', () => {
  it('通常のファイルとディレクトリを拾う', async () => {
    const { entries } = await scan()
    const names = entries.map((e) => e.name).sort()
    expect(names).toContain('a.md')
    expect(names).toContain('b.txt')
    expect(names).toContain('main.ts')
    expect(names).toContain('docs')
  })

  it('除外リストに当たるものを飛ばす', async () => {
    const { entries, counters } = await scan()
    const paths = entries.map((e) => e.path)
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false)
    expect(paths.some((p) => p.includes('.ssh'))).toBe(false)
    expect(paths.some((p) => p.endsWith('id_rsa'))).toBe(false)
    expect(counters.excluded).toBeGreaterThan(0)
  })

  it('symlink のループで無限に回らない', async () => {
    // That it completes even with a loop is itself the check. A set of inodes rejects revisits.
    const { entries } = await scan()
    expect(entries.length).toBeLessThan(50)
  })

  it('symlink 経由の重複を inode で弾く', async () => {
    const { entries } = await scan()
    // docs-alias has the same inode as docs, so its contents do not appear twice.
    const mdCount = entries.filter((e) => e.name === 'a.md').length
    expect(mdCount).toBe(1)
  })

  it('アクセス拒否はエラーにせずスキップして記録する', async () => {
    const { counters, denied, entries } = await scan()
    expect(counters.denied).toBe(1)
    expect(denied[0]).toContain('locked')
    // The scan does not stop, and the other files are obtained.
    expect(entries.some((e) => e.name === 'main.ts')).toBe(true)
  })

  it('バッチ単位で yield する (暗号化 DB の書き込み用)', async () => {
    const rules = createMacosExclusions(root)
    const counters: ScanCounters = { seen: 0, excluded: 0, denied: 0, pruned: 0 }
    const sizes: number[] = []
    for await (const batch of walk(root, rules, counters, { batchSize: 2 })) {
      sizes.push(batch.length)
    }
    expect(sizes.length).toBeGreaterThan(1)
    for (const size of sizes.slice(0, -1)) expect(size).toBe(2)
  })

  it('shouldStop で打ち切れる', async () => {
    const rules = createMacosExclusions(root)
    const counters: ScanCounters = { seen: 0, excluded: 0, denied: 0, pruned: 0 }
    let batches = 0
    let entries = 0
    for await (const batch of walk(root, rules, counters, {
      batchSize: 1,
      shouldStop: () => batches >= 2
    })) {
      batches += 1
      entries += batch.length
    }
    expect(batches).toBeLessThanOrEqual(3)
    expect(entries).toBeLessThanOrEqual(3)
  })

  it('ディレクトリの symlink が実体より浅くても、実体のディレクトリと中身の行が残る (TODO 924)', async () => {
    const base = makeTestDir('scan-symlink-first')
    try {
      mkdirSync(join(base, 'x/y'), { recursive: true })
      writeFileSync(join(base, 'x/y/note.md'), '# y')
      // A shallow symlink found first in breadth-first order. Previously it took the inode, and the rows for the real x/y were not created.
      symlinkSync(join(base, 'x/y'), join(base, 'a'), 'dir')
      const counters: ScanCounters = { seen: 0, excluded: 0, denied: 0, pruned: 0 }
      const entries: ScannedEntry[] = []
      for await (const batch of walk(base, createMacosExclusions(base), counters)) entries.push(...batch)
      const paths = entries.map((e) => e.path)
      expect(paths).toContain(join(base, 'x/y'))
      expect(paths).toContain(join(base, 'x/y/note.md'))
      // A symlink is made as a row only (as a directory), and the scan does not descend into it.
      const link = entries.find((e) => e.path === join(base, 'a'))
      expect(link?.isDirectory).toBe(true)
      expect(paths.some((p) => p.startsWith(join(base, 'a') + '/'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

