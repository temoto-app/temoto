/**
 * Regression for making the re-read of a transcript a partial read of one line (item 78).
 *
 * What it protects:
 * - A body read by location (`offset` / `length`) is exactly the same, to the single character, as a full-line parse.
 * - Positions are counted in **bytes** (they do not shift after lines with Japanese, emoji, or combining characters).
 * - If the version changes and lines have moved, the location is not trusted; it falls back to a full-line parse and returns `stale`.
 * - If the file only grew by appending, the locations can still be used as they are (the shape of an ongoing session).
 * - Parses that fell back to a full-line parse are reused via LRU, so 50 requests for the same file take one parse.
 * - The index holds the locations in metadata and passes them on every re-read.
 *
 * The transcripts are synthetic JSONL (there is no real transcript fixture). No model is called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService, type TranscriptLocator } from '../src/index-kernel/service.js'
import { loadBackendPaths } from '../src/main/session/adapter/compat.js'
import { TranscriptReader } from '../src/main/session/adapter/transcript.js'
import { makeTestDir } from './helpers/tmp.js'

const FILE_ID = 'proj/session-1.jsonl'

let home: string
let file: string

function line(value: unknown): string {
  return JSON.stringify(value)
}

function userText(uuid: string, text: string): string {
  return line({
    type: 'user',
    uuid,
    timestamp: '2026-09-23T00:00:00.000Z',
    sessionId: 's1',
    message: { role: 'user', content: [{ type: 'text', text }] }
  })
}

function assistantText(uuid: string, text: string): string {
  return line({
    type: 'assistant',
    uuid,
    timestamp: '2026-09-23T00:00:01.000Z',
    sessionId: 's1',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '考え中の独り言 (取らない)' },
        { type: 'text', text }
      ]
    }
  })
}

const LINES = [
  line({ type: 'summary', summary: '要約行 (メッセージではない)' }),
  userText('u1', '日本語の質問です。承認インボックスはどこ?'),
  assistantText('a1', '絵文字 🎉👨‍👩‍👧 と結合文字 é を含む回答。'),
  // A user line that has only tool_result carries no body (constraint 10).
  line({
    type: 'user',
    uuid: 'tr1',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '秘密のツール出力' }]
    }
  }),
  '{"type":"user","uuid":"broken", "message": ',
  '',
  userText('u2', 'ASCII only follow-up'),
  assistantText('a2', 'サロゲートペア 𠮷野家 の後ろでもずれない')
]

function writeTranscript(lines: readonly string[]): void {
  writeFileSync(file, lines.join('\n') + '\n')
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'aios-transcript-'))
  const configured = loadBackendPaths().transcriptDir
  const root = configured.startsWith('~/') ? join(home, configured.slice(2)) : configured
  mkdirSync(join(root, 'proj'), { recursive: true })
  file = join(root, FILE_ID)
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

function locatorOf(
  content: NonNullable<Awaited<ReturnType<TranscriptReader['readMessages']>>>,
  id: string
): TranscriptLocator {
  const message = content.messages.find((m) => m.id === id)
  if (message === undefined) throw new Error(`no message ${id}`)
  return { offset: message.offset, length: message.length, version: content.version }
}

describe('転写の在りか (項目 78)', () => {
  it('位置はバイトで数え、在りかで読んだ本文は全行解析と同じ', async () => {
    writeTranscript(LINES)
    const reader = new TranscriptReader(home)
    const content = await reader.readMessages(FILE_ID)
    expect(content).not.toBeNull()
    if (content === null) return
    expect(content.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    // tool_result and thinking do not enter the body (constraint 10 / 4.3.1).
    expect(content.messages.some((m) => m.text.includes('秘密のツール出力'))).toBe(false)
    expect(content.messages.some((m) => m.text.includes('独り言'))).toBe(false)

    const raw = readFileSync(file)
    const text = raw.toString('utf8')
    for (const message of content.messages) {
      // The byte position points at that line's own JSON.
      const slice = raw.subarray(message.offset, message.offset + message.length).toString('utf8')
      expect((JSON.parse(slice) as { uuid: string }).uuid).toBe(message.id)
      // If it were counted by character position, this would drift after multi-byte lines.
      const lineText = LINES.find((l) => l.includes(`"uuid":"${message.id}"`)) ?? ''
      expect(message.offset).toBe(Buffer.byteLength(text.slice(0, text.indexOf(lineText)), 'utf8'))
      expect(message.length).toBe(Buffer.byteLength(lineText, 'utf8'))
    }
    // On the line after a multi-byte line, the byte position and the character position really differ (the check is not vacuous).
    const a2 = content.messages.find((m) => m.id === 'a2')
    expect(a2?.offset).not.toBe(text.indexOf(LINES[7] ?? ''))

    const before = reader.fullParseCount
    for (const message of content.messages) {
      const result = await reader.readMessageText(FILE_ID, message.id, locatorOf(content, message.id))
      expect(result).toEqual({ text: message.text, stale: false, missing: false })
    }
    // What was read by location did not do a full-line parse even once.
    expect(reader.fullParseCount).toBe(before)
  })

  it('在りかが無い (項目 78 より前の行) ときは全行解析に倒し、50 件でも解析は 1 回', async () => {
    writeTranscript(LINES)
    const reader = new TranscriptReader(home)
    const results = []
    for (let i = 0; i < 50; i += 1) {
      results.push(await reader.readMessageText(FILE_ID, i % 2 === 0 ? 'u1' : 'a2', null))
    }
    expect(results[0]).toEqual({
      text: '日本語の質問です。承認インボックスはどこ?',
      stale: true,
      missing: false
    })
    expect(results[1]?.text).toBe('サロゲートペア 𠮷野家 の後ろでもずれない')
    expect(reader.fullParseCount).toBe(1)
    // A re-import (`readMessages`) also hits the LRU, so the second parse does not happen.
    const refreshed = await reader.readMessages(FILE_ID)
    expect(refreshed?.messages).toHaveLength(4)
    expect(reader.fullParseCount).toBe(1)
  })

  it('書き換わって行が動いたら在りかを信用せず、全行解析で正しい本文と stale を返す', async () => {
    writeTranscript(LINES)
    const reader = new TranscriptReader(home)
    const first = await reader.readMessages(FILE_ID)
    if (first === null) throw new Error('unreadable')
    const locator = locatorOf(first, 'a1')

    // Rewriting with a line added at the top = every byte position of every line shifts, and the size grows. The version differs but the size grew, so it goes into the 'append' side; the uuid check fails and it falls back.
    writeTranscript([userText('u0', '先頭に差し込んだ行'), ...LINES])
    const parses = reader.fullParseCount
    const shifted = await reader.readMessageText(FILE_ID, 'a1', locator)
    expect(shifted).toEqual({ text: '絵文字 🎉👨‍👩‍👧 と結合文字 é を含む回答。', stale: true, missing: false })
    expect(reader.fullParseCount).toBe(parses + 1)

    // It shrank = not an append. Fall back without even checking.
    writeTranscript(LINES.slice(0, 3))
    const shrunk = await reader.readMessageText(FILE_ID, 'a1', locator)
    expect(shrunk.stale).toBe(true)
    expect(shrunk.text).toBe('絵文字 🎉👨‍👩‍👧 と結合文字 é を含む回答。')
    // A message whose line is gone entirely returns null (stale is set, so the record is also corrected by the re-import).
    const gone = await reader.readMessageText(FILE_ID, 'a2', locatorOf(first, 'a2'))
    expect(gone).toEqual({ text: null, stale: true, missing: false })
  })

  it('追記で伸びただけなら版が違っても在りかをそのまま使う', async () => {
    writeTranscript(LINES)
    const reader = new TranscriptReader(home)
    const first = await reader.readMessages(FILE_ID)
    if (first === null) throw new Error('unreadable')
    appendFileSync(file, userText('u3', '後から追記された行') + '\n')
    const parses = reader.fullParseCount
    const result = await reader.readMessageText(FILE_ID, 'a2', locatorOf(first, 'a2'))
    expect(result).toEqual({ text: 'サロゲートペア 𠮷野家 の後ろでもずれない', stale: false, missing: false })
    expect(reader.fullParseCount).toBe(parses)
  })

  it('別のメッセージを指す在りか・範囲外・壊れた在りかは全行解析に倒す', async () => {
    writeTranscript(LINES)
    const reader = new TranscriptReader(home)
    const content = await reader.readMessages(FILE_ID)
    if (content === null) throw new Error('unreadable')
    const u1 = locatorOf(content, 'u1')
    // Asking for a1 with the location of u1 = the uuid does not match.
    expect(await reader.readMessageText(FILE_ID, 'a1', u1)).toEqual({
      text: '絵文字 🎉👨‍👩‍👧 と結合文字 é を含む回答。',
      stale: true,
      missing: false
    })
    // Pointing into the middle of a line (shifted by 1 byte) = it cannot be read as JSON.
    expect(
      (await reader.readMessageText(FILE_ID, 'u1', { ...u1, offset: u1.offset + 1 })).stale
    ).toBe(true)
    // Out of range, negative, and length 0.
    const size = readFileSync(file).length
    for (const bad of [
      { ...u1, offset: size },
      { ...u1, offset: -1 },
      { ...u1, length: 0 },
      { ...u1, offset: 1.5 }
    ]) {
      const result = await reader.readMessageText(FILE_ID, 'u1', bad)
      expect(result).toEqual({
        text: '日本語の質問です。承認インボックスはどこ?',
        stale: true,
        missing: false
      })
    }
  })

  it('転写ディレクトリの外は読まない', async () => {
    const reader = new TranscriptReader(home)
    expect(await reader.readMessages('../../etc/passwd.jsonl')).toBeNull()
    expect(
      await reader.readMessageText('../outside.jsonl', 'u1', { offset: 0, length: 10, version: '1:10' })
    ).toEqual({ text: null, stale: false, missing: false })
  })
})

describe('索引は在りかを metadata に持ち、読み直しで渡す (項目 78)', () => {
  let dbDir: string
  let db: InstanceType<typeof Database>
  let service: IndexService
  const asked: { fileId: string; messageId: string; locator: TranscriptLocator | null }[] = []

  beforeAll(() => {
    dbDir = makeTestDir('transcript-index-test')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key='${'d'.repeat(64)}'`)
    runMigrations(db)
    service = new IndexService({
      db,
      store: new IndexStore(db),
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: {
        readMessageText: async (fileId, messageId, locator) => {
          asked.push({ fileId, messageId, locator })
          return messageId === 'm1' ? '在りか経由で読んだ承認インボックスの話' : '古い行の本文'
        }
      },
      onStatus: () => undefined
    })
  })

  afterAll(async () => {
    await service.stop()
    db.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('取り込みで渡した offset / length / version が、ヒットの読み直しに渡る', async () => {
    await service.indexTranscriptMessages(
      { id: 'p/s.jsonl', uri: 'transcript://p/s.jsonl', version: '123:456' },
      [
        {
          id: 'm1',
          role: 'user',
          text: '在りか経由で読んだ承認インボックスの話',
          ts: 1,
          sessionId: 's',
          offset: 17,
          length: 99
        }
      ]
    )
    const metadata = db
      .prepare(`SELECT metadata FROM documents WHERE source = 'transcript' AND source_id = ?`)
      .pluck()
      .get('p/s.jsonl#m1') as string
    const parsed = JSON.parse(metadata) as Record<string, unknown>
    expect(parsed).toMatchObject({ offset: 17, length: 99, fileVersion: '123:456' })
    // The body does not go into metadata (constraint 9).
    expect(metadata).not.toContain('承認インボックス')

    asked.length = 0
    const result = await service.search('インボックス', 'conversation')
    expect(result.hits.length).toBeGreaterThan(0)
    expect(asked).toContainEqual({
      fileId: 'p/s.jsonl',
      messageId: 'm1',
      locator: { offset: 17, length: 99, version: '123:456' }
    })
  })

  it('在りかの無い行 (項目 78 より前) は null を渡し、取り込み直しで埋まる', async () => {
    const legacy = { id: 'p/old.jsonl', uri: 'transcript://p/old.jsonl' }
    const message = { id: 'm2', role: 'user', text: '古い行の本文', ts: 1, sessionId: 's' }
    await service.indexTranscriptMessages(legacy, [message])
    asked.length = 0
    await service.search('古い', 'conversation')
    expect(asked.find((a) => a.messageId === 'm2')?.locator).toBeNull()

    // The next import (the body does not change, so the index is not rebuilt) updates only the metadata.
    await service.indexTranscriptMessages({ ...legacy, version: '9:9' }, [
      { ...message, offset: 0, length: 42 }
    ])
    asked.length = 0
    await service.search('古い', 'conversation')
    expect(asked.find((a) => a.messageId === 'm2')?.locator).toEqual({
      offset: 0,
      length: 42,
      version: '9:9'
    })
  })

  it('見出し (name) には伏せ字を掛け、既に平文で残った見出しも次の取り込みで書き直す (TODO 1123)', async () => {
    const file = { id: 'p/secret.jsonl', uri: 'transcript://p/secret.jsonl' }
    const key = 'ghp_0123456789abcdefghijABCDEFGHIJ'
    const message = { id: 'm9', role: 'user', text: `${key} を使って`, ts: 1, sessionId: 's' }
    const nameOf = (): string =>
      db
        .prepare(`SELECT name FROM documents WHERE source = 'transcript' AND source_id = ?`)
        .pluck()
        .get('p/secret.jsonl#m9') as string
    await service.indexTranscriptMessages(file, [message])
    expect(nameOf()).not.toContain(key)
    expect(nameOf()).toContain('を使って')
    // Reproduces the plain-text heading left by an earlier version, and checks that re-importing corrects it.
    db.prepare(`UPDATE documents SET name = ? WHERE source = 'transcript' AND source_id = ?`).run(
      key,
      'p/secret.jsonl#m9'
    )
    await service.indexTranscriptMessages(file, [message])
    expect(nameOf()).not.toContain(key)
  })
})
