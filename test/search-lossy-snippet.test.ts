/**
 * TODO 925: for files that are not UTF-8 (Shift_JIS etc.), the byte range of a chunk (counted in the decoded string, where
 * an invalid byte is U+FFFD = 3 bytes) and the position in the raw bytes of the canonical copy drift apart. Because the snippet was cut from the raw bytes,
 * a place that did not contain the word that hit in a later chunk was shown, and in a search with uppercase letters (smart case) the
 * hit itself was dropped. Files whose decoding does not round-trip are marked on their row, and the snippet is cut from the decoded string.
 *
 * Real SQLite (in memory) and real disk (`~/.aios-test/<run>/`). Does not call the model.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { extractFile, isLossy } from '../src/index-kernel/extract.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

let root: string
let db: Db
let store: IndexStore
let fs: FsIndexer
let index: IndexService

/** The first half is Shift_JIS (the hiragana for a = 0x82 0xA0, invalid as UTF-8); the second half is an ASCII body containing the word. */
function shiftJisFile(): Buffer {
  const parts: Buffer[] = []
  const sjisLine = Buffer.concat([...Array.from({ length: 80 }, () => Buffer.from([0x82, 0xa0])), Buffer.from('\n')])
  for (let i = 0; i < 40; i += 1) parts.push(sjisLine)
  for (let i = 0; i < 40; i += 1) parts.push(Buffer.from(`filler line number ${i} with plain ascii words only\n`))
  parts.push(Buffer.from('the Laterword appears only here near the end\n'))
  return Buffer.concat(parts)
}

beforeAll(async () => {
  root = makeTestDir('search-lossy')
  writeFileSync(join(root, 'sjis.txt'), shiftJisFile())
  writeFileSync(join(root, 'utf8.txt'), `${'日本語の本文です。\n'.repeat(200)}the Laterword in utf8\n`)
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

const metadataOf = (name: string): string | null =>
  (db.prepare(`SELECT metadata FROM documents WHERE source = 'fs' AND name = ?`).get(name) as { metadata: string | null })
    .metadata

describe('TODO 925: 復号が往復一致しないファイルのスニペット', () => {
  it('isLossy: 不正なバイトを置き換えたときだけ真 (本物の U+FFFD は往復する)', () => {
    const invalid = Buffer.from([0x41, 0x82, 0xa0, 0x42])
    expect(isLossy(invalid.toString('utf8'), invalid)).toBe(true)
    const real = Buffer.from('A�B', 'utf8')
    expect(isLossy(real.toString('utf8'), real)).toBe(false)
    const plain = Buffer.from('日本語', 'utf8')
    expect(isLossy(plain.toString('utf8'), plain)).toBe(false)
  })

  it('上限で切った UTF-8 の末尾の書きかけの文字では lossy にしない', async () => {
    const path = join(root, 'big.md')
    // Lines up 3-byte characters, so that the 256 KB limit falls in the middle of a character.
    writeFileSync(path, `a${'あ'.repeat(100_000)}`)
    const result = await extractFile(path)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.truncated).toBe(true)
      expect(result.lossy).toBe(false)
      expect(result.text.endsWith('�')).toBe(false)
    }
  })

  it('索引は Shift_JIS のファイルにだけ印を付ける', () => {
    expect(metadataOf('sjis.txt')).toBe('{"lossy":true}')
    expect(metadataOf('utf8.txt')).toBeNull()
  })

  it('後ろのチャンクのスニペットに当たった語が入り、smart case でも落ちない', async () => {
    const lower = await index.search('laterword', 'files', {})
    const sjis = lower.hits.find((hit) => hit.title === 'sjis.txt')
    expect(sjis).toBeDefined()
    expect(sjis?.snippet.toLowerCase()).toContain('laterword')

    // A search with uppercase letters (smart case) needs the word with its case kept in the snippet. Previously it failed with a mis-cut snippet.
    const upper = await index.search('Laterword', 'files', {})
    expect(upper.hits.map((hit) => hit.title).sort()).toEqual(['sjis.txt', 'utf8.txt'])
    for (const hit of upper.hits) expect(hit.snippet).toContain('Laterword')
  })
})
