/**
 * TODO 1089: the body of assembler sources (`.S` / `.s` / `.asm`) did not enter the index, so `mmu_init_c1` did not appear in body search. The cause was not word splitting: the table of extensions whose bodies are extracted (`TEXT_EXTENSIONS` in `extract.ts`) never had this kind from the start. This guards (1) that real FTS5 finds identifiers containing `_` and digits with both `.c` and `.S`, (2) that the development source extensions that are easy to drop from the table are extraction targets, and (3) that rows that became `skipped` before being added to the table return to `pending` at idle cleanup (their version `mtime:size` does not change, so incremental and full scans do not pick them up). No model is called.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { INDEX_DERIVED_REQUEUE_CURSOR } from '../src/common/settings-keys.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { isExtractable, LATE_TEXT_EXTENSIONS } from '../src/index-kernel/extract.js'
import { IdleUpkeep, UPKEEP_DONE } from '../src/index-kernel/upkeep.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

const KEY = 'd'.repeat(64)
const ASM = [
  '/* DDR_CortexA_MMU.S */',
  '        .global mmu_init',
  'mmu_init:',
  '        mov     r1, #0',
  'mmu_init_c1:',
  '        subs    r0, r0, #1',
  '        bne     mmu_init_c1',
  ''
].join('\n')

describe('TODO 1089: development source extensions are targets of body extraction', () => {
  it('assembler (also uppercase .S), linker scripts, HDL and C++ aliases', () => {
    for (const name of [
      'a.S', 'a.s', 'a.asm', 'a.inc', 'a.ld', 'a.lds',
      'a.v', 'a.sv', 'a.vhdl', 'a.cxx', 'a.hxx', 'a.hh', 'a.ino',
      // Ones that were there before (not dropped).
      'a.c', 'a.h', 'a.cpp', 'a.py', 'a.ts', 'Makefile'
    ]) {
      expect(isExtractable(`/x/${name}`), name).toBe(true)
    }
    // Extensions added later are lowercase, and all of them are extraction targets (so the cleanup candidates and the table do not disagree).
    for (const ext of LATE_TEXT_EXTENSIONS) {
      expect(ext).toBe(ext.toLowerCase())
      expect(isExtractable(`/x/a.${ext}`), ext).toBe(true)
    }
    // `.vhd` is also a virtual disk for Hyper-V / VirtualBox (do not put multi-GB images into the body extraction queue).
    expect(isExtractable('/x/a.vhd')).toBe(false)
    expect(LATE_TEXT_EXTENSIONS).not.toContain('vhd')
    expect(isExtractable('/x/a.o')).toBe(false)
    expect(isExtractable('/x/a.elf')).toBe(false)
  })
})

describe('TODO 1089: body search of identifiers containing `_` and digits (the real FTS5)', () => {
  let root: string
  let dbDir: string
  let db: Db
  let index: IndexService
  let fs: FsIndexer

  beforeAll(async () => {
    root = makeTestDir('src-ext-test')
    dbDir = makeTestDir('src-ext-db')
    mkdirSync(join(root, 'Driver/src/GCC'), { recursive: true })
    writeFileSync(join(root, 'Driver/src/GCC/DDR_CortexA_MMU.S'), ASM)
    writeFileSync(join(root, 'Driver/src/GCC/boot.asm'), 'call mmu_init_c1\n')
    writeFileSync(join(root, 'Driver/src/mmu.c'), 'extern void mmu_init_c1(void);\n')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key='${KEY}'`)
    runMigrations(db)
    const store = new IndexStore(db)
    index = new IndexService({
      db,
      store,
      conversation: {
        readEventText: async () => null,
        threadTitle: async () => '',
        liveEventIds: async () => []
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
    removeTestDir(root)
    removeTestDir(dbDir)
  })

  const titles = async (query: string, forAgent: boolean): Promise<readonly string[]> =>
    (await index.search(query, 'files', forAgent ? { forAgent: true } : {})).hits.map((hit) => hit.title)

  it('.S / .asm / .c appear with both an exact match (gateway) and a prefix match (the sidebar search field)', async () => {
    for (const forAgent of [true, false]) {
      const got = await titles('mmu_init_c1', forAgent)
      expect(got, String(forAgent)).toEqual(expect.arrayContaining(['DDR_CortexA_MMU.S', 'boot.asm', 'mmu.c']))
    }
    // Partial typing (incremental search). When the last part is a single character (`mmu_init_c`), the P6 rule does not add `*`, so it does not match (to avoid scanning the whole vocabulary; intended). From two characters on, it is a prefix match.
    expect(await titles('mmu_ini', false)).toEqual(expect.arrayContaining(['DDR_CortexA_MMU.S', 'mmu.c']))
  })

  it('the identifier part can be looked up even with a query containing uppercase (smart case)', async () => {
    expect(await titles('MMU', false)).toContain('DDR_CortexA_MMU.S')
  })
})

describe('TODO 1089: re-fetching rows that became skipped before being added to the table (upkeep)', () => {
  it('returns only the skipped rows of later-added extensions to pending and does not change the version. Once done it never runs again', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const store = new IndexStore(db)
    const settings = new AppSettingsStore(db)
    const parent = store.ensureDirectory('/tmp/aios-1089', 1)
    const add = (name: string, ext: string): number => {
      const { id } = store.upsertFsEntry({ parentId: parent, name, isDirectory: false, ext, size: 5, mtimeMs: 1, seenAt: 1 })
      store.markSkipped(id)
      return id
    }
    const asm = add('DDR_CortexA_MMU.S', 's')
    const binary = add('a.o', 'o')
    const text = add('note.txt', 'txt')
    let requeued = 0
    const upkeep = new IdleUpkeep({
      store,
      settings,
      enqueue: async (work) => {
        await work()
      },
      shouldYield: () => false,
      readGate: () => async () => true,
      onRequeued: (count) => {
        requeued += count
      }
    })
    for (let i = 0; i < 10 && !upkeep.finished(); i += 1) await upkeep.step()
    expect(upkeep.finished()).toBe(true)
    const row = (id: number): { version: string; index_state: string } =>
      db.prepare(`SELECT version, index_state FROM documents WHERE id = ?`).get(id) as {
        version: string
        index_state: string
      }
    expect(row(asm)).toEqual({ version: '1:5', index_state: 'pending' })
    expect(row(binary).index_state).toBe('skipped')
    expect(row(text).index_state).toBe('skipped')
    expect(requeued).toBe(1)
    expect(settings.readTyped(INDEX_DERIVED_REQUEUE_CURSOR)).toBe(UPKEEP_DONE)

    // Once done, do not put it back even if the same row becomes skipped again (it is not fetched again at every startup).
    store.markSkipped(asm)
    const again = new IdleUpkeep({
      store,
      settings,
      enqueue: async (work) => {
        await work()
      },
      shouldYield: () => false,
      readGate: () => async () => true
    })
    for (let i = 0; i < 10 && !again.finished(); i += 1) await again.step()
    expect(row(asm).index_state).toBe('skipped')
    db.close()
  })
})
