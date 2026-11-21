/**
 * Wave 42 code-review bundle X: the redaction of the body passed to the gateway does not miss a secret that is split at a page or chunk boundary (`…DB_PA` | `SSWORD=hunter2secret`). A regression for when each slice was redacted on its own.
 *
 * Real SQLite (in memory) and the real disk (`~/.aios-test/<run>/`). The model is not called.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

const SECRET = 'hunter2secret'
const ASSIGN = `DB_PASSWORD=${SECRET}`

let root: string
let db: Db
let store: IndexStore
let fs: FsIndexer
let index: IndexService

/** An ASCII body with a number on each line (long enough to make several chunks). */
function filler(lines: number, tag: string): string {
  let out = ''
  for (let i = 0; i < lines; i += 1) out += `${tag} filler line ${String(i).padStart(4, '0')} lorem ipsum dolor\n`
  return out
}

/** A PEM private key whose body is about `bytes` bytes (lines of 64 base64-like characters). */
function pem(bytes: number): string {
  const line = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj'
  let body = ''
  while (body.length < bytes) body += `${line}\n`
  return `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n`
}

/** Overwrites `text` at `at` in the file (the size does not change). */
function overwrite(path: string, at: number, text: string): void {
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, text, at)
  } finally {
    closeSync(fd)
  }
}

const docIdOf = (name: string): number =>
  (db.prepare(`SELECT id FROM documents WHERE source = 'fs' AND name = ?`).get(name) as { id: number }).id

const chunksOf = (documentId: number): { id: number; seq: number; byte_start: number; byte_end: number }[] =>
  db
    .prepare(`SELECT id, seq, byte_start, byte_end FROM chunks WHERE document_id = ? ORDER BY seq`)
    .all(documentId) as { id: number; seq: number; byte_start: number; byte_end: number }[]

beforeAll(async () => {
  root = makeTestDir('gateway-redaction-window')
  mkdirSync(join(root, 'notes'))
  writeFileSync(join(root, 'notes', 'paged.md'), `${filler(10, 'paged')}${ASSIGN}\n${filler(10, 'paged')}`)
  writeFileSync(join(root, 'notes', 'chunked.md'), filler(120, 'chunked'))
  // For the search snippet: a word that is only in the middle of chunk 2
  const snip = filler(120, 'snip').split('\n')
  writeFileSync(join(root, 'notes', 'snip.md'), snip.join('\n'))
  // TODO 863: a page that returns only the middle of a PEM private key. A 6 KiB key has BEGIN and END inside the window (4 KiB before and after), while the middle of a 12 KiB key has neither (the limit of 7.6.1).
  writeFileSync(join(root, 'notes', 'pem-small.md'), `${filler(5, 'pem')}${pem(6 * 1024)}${filler(5, 'pem')}`)
  writeFileSync(join(root, 'notes', 'pem-large.md'), `${filler(5, 'pem')}${pem(12 * 1024)}${filler(5, 'pem')}`)
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

describe('getDocumentText page boundaries', () => {
  it('a page starting in the middle of a key name also masks the value', async () => {
    const id = String(docIdOf('paged.md'))
    const whole = (await index.getDocumentText(id, 0, 1 << 16, false)) as Record<string, unknown>
    const at = (whole['text'] as string).indexOf(ASSIGN)
    // A page that starts from "SSWORD=…" (`DB_PA` is in the previous page)
    const page = (await index.getDocumentText(id, at + 5, 200, true)) as Record<string, unknown>
    expect(page['offset']).toBe(at + 5)
    expect(page['text']).toMatch(/^SSWORD=\[redacted\]/)
    expect(page['text']).not.toContain('hunter2')
    expect(page['redacted']).toBe(true)
    // The position fields stay in the coordinates of the canonical copy
    expect(page['bytes']).toBe(200)
    expect(page['next_offset']).toBe(at + 5 + 200)
  })

  it('the page after one ending in the middle of a key name, and a page ending in the middle of a value, do not leak either', async () => {
    const id = String(docIdOf('paged.md'))
    const whole = (await index.getDocumentText(id, 0, 1 << 16, false)) as Record<string, unknown>
    const at = (whole['text'] as string).indexOf(SECRET)
    const head = (await index.getDocumentText(id, 0, at + 4, true)) as Record<string, unknown>
    expect(head['text']).toMatch(/DB_PASSWORD=\[redacted\]$/)
    const tail = (await index.getDocumentText(id, at + 4, 100, true)) as Record<string, unknown>
    expect(tail['text']).toMatch(/^\[redacted\]\n/)
    expect(tail['text']).not.toContain('er2secret')
    // The screen (not forAgent) is returned as it is
    const ui = (await index.getDocumentText(id, at + 4, 100, false)) as Record<string, unknown>
    expect(ui['text']).toMatch(/^er2secret/)
  })
})

describe('getChunk chunk boundaries', () => {
  it('masks a secret split at the start of the returned range', async () => {
    const documentId = docIdOf('chunked.md')
    const chunks = chunksOf(documentId)
    expect(chunks.length).toBeGreaterThanOrEqual(4)
    const target = chunks[2]
    const from = chunks[1]
    if (target === undefined || from === undefined) throw new Error('chunks')
    // The range returned is [chunks[1].byte_start, chunks[3].byte_end). Split at its head into `DB_PA` | `SSWORD=…`.
    overwrite(join(root, 'notes', 'chunked.md'), from.byte_start - 5, ASSIGN)
    const agent = (await index.getChunk(String(target.id), true)) as Record<string, unknown>
    expect(agent['text']).toMatch(/^SSWORD=\[redacted\]/)
    expect(agent['text']).not.toContain('hunter2')
    const ui = (await index.getChunk(String(target.id), false)) as Record<string, unknown>
    expect(ui['text']).toMatch(/^SSWORD=hunter2secret/)
  })
})

describe('search snippet chunk boundaries', () => {
  it('masks a secret split at the start of the excerpt', async () => {
    const path = join(root, 'notes', 'snip.md')
    const documentId = docIdOf('snip.md')
    const chunks = chunksOf(documentId)
    const target = chunks[2]
    if (target === undefined) throw new Error('chunks')
    // Place the secret split at the head of chunk 2. The search word (the line number) is in the middle of chunk 2.
    overwrite(path, target.byte_start - 5, ASSIGN)
    const whole = (await index.getDocumentText(String(documentId), 0, 1 << 16, false)) as Record<string, unknown>
    const text = whole['text'] as string
    // The line number about 300 bytes from the head of chunk 2 (after the 100-character overlap)
    const line = text.slice(target.byte_start + 300).match(/snip filler line (\d{4})/)?.[1]
    if (line === undefined) throw new Error('line')
    // Erase the word from the body so that it is not found in the excerpt, and so that the snippet is cut from the head of the excerpt
    const lineAt = text.indexOf(`line ${line}`)
    overwrite(path, lineAt, `line ${'x'.repeat(4)}`)
    const agent = await index.search(line, 'files', { forAgent: true })
    const hit = agent.hits.find((h) => h.id === String(documentId))
    expect(hit).toBeDefined()
    expect(hit?.snippet).not.toContain('hunter2')
    expect(hit?.snippet).toMatch(/^SSWORD=\[redacted\]/)
    const ui = await index.search(line, 'files', {})
    expect(ui.hits.find((h) => h.id === String(documentId))?.snippet).toMatch(/^SSWORD=hunter2secret/)
  })
})

describe('a page returning the middle of a PEM private key (TODO 863, the limit of 7.6.1)', () => {
  const BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'

  async function middlePage(name: string): Promise<Record<string, unknown>> {
    const id = String(docIdOf(name))
    const whole = (await index.getDocumentText(id, 0, 1 << 16, false)) as Record<string, unknown>
    const text = whole['text'] as string
    const begin = text.indexOf('-----BEGIN PRIVATE KEY-----')
    const end = text.indexOf('-----END PRIVATE KEY-----')
    const middle = Math.floor((begin + end) / 2)
    return (await index.getDocumentText(id, middle, 256, true)) as Record<string, unknown>
  }

  it('a key whose BEGIN / END fall within the 4 KiB window before and after also has a middle-only page masked', async () => {
    const page = await middlePage('pem-small.md')
    expect(page['text']).not.toContain(BODY)
    expect(page['text']).toBe('[redacted]')
    expect(page['redacted']).toBe(true)
  })

  it('the middle of a key beyond the window (BEGIN / END both farther than 4 KiB) cannot be masked; this pins the limit', async () => {
    // If this is changed, change the "limit" paragraph of 7.6.1 and this test together.
    const page = await middlePage('pem-large.md')
    expect(page['text']).toContain(BODY)
    expect(page['redacted']).toBeUndefined()
  })

  it('even for a key beyond the window, a page where BEGIN is within the window is masked to the end of the window', async () => {
    const id = String(docIdOf('pem-large.md'))
    const whole = (await index.getDocumentText(id, 0, 1 << 16, false)) as Record<string, unknown>
    const begin = (whole['text'] as string).indexOf('-----BEGIN PRIVATE KEY-----')
    const page = (await index.getDocumentText(id, begin + 1024, 256, true)) as Record<string, unknown>
    expect(page['text']).not.toContain(BODY)
    expect(page['redacted']).toBe(true)
  })
})
