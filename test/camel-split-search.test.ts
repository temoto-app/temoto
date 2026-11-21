/**
 * TODO 1152: a word that starts in the middle of an identifier does not appear in full-text search.
 *
 * The owner's reproduction case is a C source with Shift_JIS comments (`agescore.c`, no NUL, extension `.c`, lossy). The word searched was `ScoreMgrEraseColorGr…`
 * (the word in the body is `ageScoreMgrEraseColorGroupOwner`). unicode61 makes a camelCase identifier a single word, so a word starting not at the word head did not match even by prefix.
 * The index now appends a form where identifiers are split at the case boundaries (`indexShadowText`), and the query is an OR of the original word and the split phrases (`buildMatchQuery`).
 *
 * A real SQLite (in memory) and a real disk (`~/.aios-test/<run>/`). The model is not called.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { INDEX_FTS_REBUILD_CURSOR, INDEX_SHADOW_EPOCH } from '../src/common/settings-keys.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { buildMatchQuery, indexShadowText, SHADOW_EPOCH, splitCamel } from '../src/index-kernel/tokenize.js'
import { UPKEEP_DONE } from '../src/index-kernel/upkeep.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

describe('TODO 1152: split words at case boundaries', () => {
  it('splitCamel: splits after lowercase letters and digits before a capital and at the end of a run of capitals; does not split before digits', () => {
    expect(splitCamel('ageScoreMgrEraseColorGroupOwner')).toBe('age Score Mgr Erase Color Group Owner')
    expect(splitCamel('AGESoundScoreData*')).toBe('AGE Sound Score Data*')
    expect(splitCamel('XMLHttpRequest')).toBe('XML Http Request')
    expect(splitCamel('MD5Hash')).toBe('MD5 Hash')
    expect(splitCamel('ageScoreCommnadVolume2')).toBe('age Score Commnad Volume2')
    expect(splitCamel('foo.barBaz')).toBe('foo.bar Baz')
    // A word with no boundary stays as is (the same string).
    for (const plain of ['lowercase', 'UPPER', 'Title', 'file_name', 's32', '日本語']) expect(splitCamel(plain)).toBe(plain)
  })

  it('indexShadowText: appends the split form after the original body (a body without boundaries is the same as shadowText)', () => {
    expect(indexShadowText('s32 ageScoreMgr( void );', 'other', null)).toBe('s32 ageScoreMgr( void ); age Score Mgr(')
    expect(indexShadowText('plain words only', 'other', null)).toBe('plain words only')
  })

  it('buildMatchQuery: a word with boundaries is an OR of the original word and the split phrase; prefix matching applies to both', () => {
    expect(buildMatchQuery('ScoreMgr', null)).toBe('("ScoreMgr" OR "Score Mgr")')
    expect(buildMatchQuery('ScoreMgrEraseColorGr', null, true)).toBe(
      '("ScoreMgrEraseColorGr"* OR "Score Mgr Erase Color Gr"*)'
    )
    // If the last split phrase is a single Latin letter, no prefix match is added to it (P6).
    expect(buildMatchQuery('fooB', null, true)).toBe('("fooB"* OR "foo B")')
    // A word with no boundary is as before.
    expect(buildMatchQuery('config system', null, true)).toBe('"config" AND "system"*')
  })
})

let root: string
let db: Db
let store: IndexStore
let fs: FsIndexer
let index: IndexService

/** The shape of the reproduction: a C source with Shift_JIS comments (invalid as UTF-8, no NUL) and camelCase identifiers. */
function shiftJisSource(): Buffer {
  const sjisComment = Buffer.concat([
    Buffer.from('/* '),
    // "Last updated date" (Shift_JIS). A byte sequence that is invalid as UTF-8.
    Buffer.from([0x8d, 0xc5, 0x8f, 0x49, 0x8d, 0x58, 0x90, 0x56, 0x93, 0xfa]),
    Buffer.from(' : 2014.11.19 */\n')
  ])
  const lines: Buffer[] = []
  for (let i = 0; i < 30; i += 1) lines.push(sjisComment)
  lines.push(Buffer.from('static s32 ageScoreMgrEraseColorGroupOwner( s32 ColorGroupIndex );\n'))
  lines.push(Buffer.from('s32 ageScoreCommnadPhrase( AGESoundScoreData* pScoreData ) {\n'))
  lines.push(Buffer.from('  return config.pathName;\n}\n'))
  return Buffer.concat(lines)
}

beforeAll(async () => {
  root = makeTestDir('camel-split')
  writeFileSync(join(root, 'agescore.c'), shiftJisSource())
  writeFileSync(join(root, 'notes.md'), 'The Owner and age are plain words here.\n')
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

afterAll(async () => {
  await index.stop()
  await fs.stop()
  if (db.open) db.close()
  removeTestDir(root)
})

const titles = async (query: string, forAgent = false): Promise<string[]> =>
  (await index.search(query, 'files', forAgent ? { forAgent: true } : {})).hits.map((hit) => hit.title).sort()

describe('TODO 1152: words starting in the middle of an identifier appear in body search', () => {
  it('reproduction: a word starting somewhere other than the word head (including mid-typing) finds the Shift_JIS file', async () => {
    expect(await titles('ScoreMgrEraseColorGroupOwner')).toEqual(['agescore.c'])
    expect(await titles('ScoreMgrEraseColorGr')).toEqual(['agescore.c'])
    expect(await titles('EraseColorGroupOwner')).toEqual(['agescore.c'])
    expect(await titles('SoundScoreData')).toEqual(['agescore.c'])
    // The gateway (no prefix match) is the same.
    expect(await titles('ScoreMgrEraseColorGroupOwner', true)).toEqual(['agescore.c'])
  })

  it('whole words, prefix matches from the word head, lowercase words, and symbols inside words still match as before', async () => {
    expect(await titles('ageScoreCommnadPhrase')).toEqual(['agescore.c'])
    expect(await titles('agescorecommnadphrase')).toEqual(['agescore.c'])
    expect(await titles('ageScoreMgrErase')).toEqual(['agescore.c'])
    expect(await titles('config.pathName')).toEqual(['agescore.c'])
    expect(await titles('pathName')).toEqual(['agescore.c'])
  })

  it('a phrase spanning adjacent identifiers is dropped by the smart case recheck', async () => {
    // The sequence after adding is `… Group Owner( age Score Commnad …` (the tail of one identifier sits next to the head of the next).
    expect(await titles('OwnerAge')).toEqual([])
  })

  it('the middle of an all-lowercase word (boundaries unknown) does not match as before', async () => {
    expect(await titles('erasecolorgroupowner')).toEqual([])
  })
})

describe('TODO 1152: when the shadow text version changes, run one more rebuild pass', () => {
  function openService(target: Db): IndexService {
    return new IndexService({
      db: target,
      store: new IndexStore(target),
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: null,
      onStatus: () => {}
    })
  }

  it('a DB with chunks of the previous version: raises the range to the current high-water mark and resets progress to 0; does nothing at the second launch', async () => {
    const dir = makeTestDir('shadow-epoch')
    const target = new Database(join(dir, 'aios.db'))
    try {
      target.pragma('foreign_keys = ON')
      runMigrations(target)
      const before = new IndexStore(target)
      const parent = before.ensureDirectory('/tmp/aios-shadow-epoch', 1)
      const { id } = before.upsertFsEntry({
        parentId: parent,
        name: 'old.ts',
        isDirectory: false,
        ext: 'ts',
        size: 10,
        mtimeMs: 1,
        seenAt: 1
      })
      before.replaceChunks(id, [{ shadow: 'fooBar', byteStart: 0, byteEnd: 6, chars: 6 }], {
        state: 'indexed',
        contentHash: 'h',
        lang: null
      })
      const settings = new AppSettingsStore(target)
      // The rebuild of item 965 was done in the earlier launch. There is no version mark yet (= indexed by a version before 1152).
      settings.writeTyped(INDEX_FTS_REBUILD_CURSOR, UPKEEP_DONE)
      const highWater = target.prepare(`SELECT last_id FROM chunk_id_seq WHERE id = 1`).pluck().get() as number
      const chunkId = target.prepare(`SELECT id FROM chunks WHERE document_id = ?`).pluck().get(id) as number

      const first = openService(target)
      const below = target.prepare(`SELECT rebuild_below FROM chunk_id_seq WHERE id = 1`).pluck().get() as number
      expect(below).toBeGreaterThanOrEqual(chunkId)
      expect(below).toBe(highWater)
      expect(settings.readTyped(INDEX_FTS_REBUILD_CURSOR)).toBe(0)
      expect(settings.readTyped(INDEX_SHADOW_EPOCH)).toBe(SHADOW_EPOCH)
      // The rebuild entry point lists documents from old chunks as candidates.
      expect(new IndexStore(target).ftsRebuildCandidates(0, 1000, below, 10).map((row) => row.id)).toEqual([id])
      await first.stop()

      // If the version is the same, do not touch it (do not redo a rebuild that is already done).
      settings.writeTyped(INDEX_FTS_REBUILD_CURSOR, UPKEEP_DONE)
      const second = openService(target)
      expect(settings.readTyped(INDEX_FTS_REBUILD_CURSOR)).toBe(UPKEEP_DONE)
      await second.stop()
    } finally {
      target.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a first launch (no chunks) leaves the range at 0 and writes only the version', async () => {
    const target = new Database(':memory:')
    try {
      target.pragma('foreign_keys = ON')
      runMigrations(target)
      const service = openService(target)
      expect(target.prepare(`SELECT rebuild_below FROM chunk_id_seq WHERE id = 1`).pluck().get()).toBe(0)
      expect(new AppSettingsStore(target).readTyped(INDEX_SHADOW_EPOCH)).toBe(SHADOW_EPOCH)
      await service.stop()
    } finally {
      target.close()
    }
  })
})
