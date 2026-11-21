/**
 * The list and past parts of transcripts (item 111, ARCHITECTURE.md 4.5.9). On the Adapter side.
 * ('Continue in terminal' resume command was removed in item 162.)
 *
 * It runs the real `TranscriptReader` pointed at transcripts in a temp directory (`<home>/.claude/projects/<dir>/<sid>.jsonl`). Neither the CLI nor a model is called. The line shapes mirror the real CLI 2.1.280 transcript (from this machine): `user` / `assistant` (`uuid` / `cwd` / `sessionId` / `isSidechain` / `isMeta`), `ai-title`, and `queue-operation` (a line that is not a conversation).
 *
 * What is pinned down:
 * - List: session id / cwd / title (`ai-title`) / first message / model of the last response / size. Child transcripts (all sidechain) and transcripts without a conversation do not appear. Most recent first.
 * - Past parts: only the lines up to the read-through point (`limit`). For user / assistant bodies, tool_use, and tool_result, only the length. Sidechain and meta lines do not appear. The id starts with `transcript:`.
 * - `describeUri`: can be turned back into the file from an index hit's `uri`.
 * - `filterOwnedTranscript`: conversations aios owns are not included / up to the read-through point.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptReader } from '../src/main/session/adapter/transcript.js'
import { loadBackendPaths, loadCompatTable } from '../src/main/session/adapter/compat.js'
import { filterOwnedTranscript } from '../src/main/index/client.js'
import { TRANSCRIPT_EVENT_ID_PREFIX } from '../src/shared/thread.js'

let home: string
let projects: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aios-transcript-H-'))
  const configured = loadBackendPaths().transcriptDir
  projects = join(home, configured.replace(/^~\//, ''))
  mkdirSync(projects, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

interface LineOptions {
  readonly sidechain?: boolean
  readonly meta?: boolean
  readonly model?: string
  readonly ts?: string
}

function userLine(sid: string, cwd: string, uuid: string, text: string | unknown[], options: LineOptions = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: options.sidechain === true,
    ...(options.meta === true ? { isMeta: true } : {}),
    type: 'user',
    message: { role: 'user', content: typeof text === 'string' ? text : text },
    uuid,
    timestamp: options.ts ?? '2026-09-27T01:00:00.000Z',
    cwd,
    sessionId: sid,
    version: '2.1.280'
  })
}

function assistantLine(sid: string, cwd: string, uuid: string, content: unknown[], options: LineOptions = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: options.sidechain === true,
    type: 'assistant',
    message: { role: 'assistant', model: options.model ?? 'claude-sonnet-5', content, usage: { input_tokens: 1, output_tokens: 1 } },
    uuid,
    timestamp: options.ts ?? '2026-09-27T01:00:01.000Z',
    cwd,
    sessionId: sid,
    version: '2.1.280'
  })
}

function writeTranscript(project: string, sid: string, lines: readonly string[], mtimeMs?: number): string {
  const dir = join(projects, project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sid}.jsonl`)
  writeFileSync(file, lines.join('\n') + '\n')
  if (mtimeMs !== undefined) utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
  return file
}

const CWD = '/Users/tester/work/app'
const SID = '11111111-1111-4111-8111-111111111111'

describe('転写の一覧 (項目 111)', () => {
  it('session id・cwd・題名・最初の発言・最後の応答のモデル・大きさを読む。最近順', async () => {
    writeTranscript('-Users-tester-work-app', SID, [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: SID }),
      userLine(SID, CWD, 'u1', [{ type: 'text', text: '  テストを直して\n2 行目 ' }]),
      assistantLine(SID, CWD, 'a1', [{ type: 'text', text: 'はい' }], { model: 'claude-haiku-4-5-20251001' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'テストの修正', sessionId: SID }),
      userLine(SID, CWD, 'u2', [{ type: 'text', text: '続けて' }]),
      assistantLine(SID, CWD, 'a2', [{ type: 'text', text: '了解' }], { model: 'claude-sonnet-5' }),
      // The model name is not taken from the answer of a built-in command (which does not call the API).
      assistantLine(SID, CWD, 'a3', [{ type: 'text', text: 'cost' }], { model: loadCompatTable().streamEvents?.syntheticModel ?? '<synthetic>' })
    ], Date.now() - 60_000)
    const OTHER = '22222222-2222-4222-8222-222222222222'
    writeTranscript('-Users-tester-other', OTHER, [
      userLine(OTHER, '/Users/tester/other', 'u1', 'plain string prompt'),
      assistantLine(OTHER, '/Users/tester/other', 'a1', [{ type: 'text', text: 'ok' }])
    ], Date.now())

    const reader = new TranscriptReader(home)
    const sessions = await reader.listSessions()
    expect(sessions.map((s) => s.sessionId)).toEqual([OTHER, SID])
    const found = sessions[1]!
    expect(found.cwd).toBe(CWD)
    expect(found.title).toBe('テストの修正')
    expect(found.firstPrompt).toBe('テストを直して 2 行目')
    expect(found.model).toBe('claude-sonnet-5')
    expect(found.uri).toBe(`transcript://-Users-tester-work-app/${SID}.jsonl`)
    expect(found.size).toBeGreaterThan(0)
    // A message whose body is a plain string also becomes the 'first message'. If there is no title, it is null.
    expect(sessions[0]!.firstPrompt).toBe('plain string prompt')
    expect(sessions[0]!.title).toBeNull()
    expect(await reader.findSession(SID)).toEqual(found)
    expect(await reader.findSession('nope')).toBeNull()
  })

  it('子エージェントの転写 (全部 sidechain)・会話の無い転写・コマンドの包みの発言は出さない / 使わない', async () => {
    const SIDE = '33333333-3333-4333-8333-333333333333'
    writeTranscript('-Users-tester-work-app', SIDE, [
      userLine(SIDE, CWD, 'u1', [{ type: 'text', text: 'child task' }], { sidechain: true }),
      assistantLine(SIDE, CWD, 'a1', [{ type: 'text', text: 'done' }], { sidechain: true })
    ])
    const EMPTY = '44444444-4444-4444-8444-444444444444'
    writeTranscript('-Users-tester-work-app', EMPTY, [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: EMPTY })
    ])
    const CMD = '55555555-5555-4555-8555-555555555555'
    writeTranscript('-Users-tester-work-app', CMD, [
      userLine(CMD, CWD, 'u0', '<command-name>/model</command-name>'),
      userLine(CMD, CWD, 'u1', '<local-command-stdout>Set model</local-command-stdout>', { meta: true }),
      userLine(CMD, CWD, 'u2', [{ type: 'text', text: '本題' }]),
      assistantLine(CMD, CWD, 'a1', [{ type: 'text', text: 'ok' }])
    ])
    const reader = new TranscriptReader(home)
    const sessions = await reader.listSessions()
    expect(sessions.map((s) => s.sessionId)).toEqual([CMD])
    expect(sessions[0]!.firstPrompt).toBe('本題')
  })

  it('大きい転写でも頭と尻尾だけ読み、題名は尻尾でも拾う', async () => {
    const filler = 'x'.repeat(1000)
    const lines = [userLine(SID, CWD, 'u1', [{ type: 'text', text: '最初' }])]
    for (let i = 0; i < 200; i++) {
      lines.push(assistantLine(SID, CWD, `a${i}`, [{ type: 'text', text: filler }], { model: 'claude-haiku-4-5-20251001' }))
    }
    lines.push(JSON.stringify({ type: 'ai-title', aiTitle: '尻尾の題名', sessionId: SID }))
    lines.push(assistantLine(SID, CWD, 'last', [{ type: 'text', text: '最後' }], { model: 'claude-opus-5-5' }))
    writeTranscript('-Users-tester-work-app', SID, lines)
    const reader = new TranscriptReader(home)
    const found = await reader.findSession(SID)
    expect(found?.title).toBe('尻尾の題名')
    expect(found?.model).toBe('claude-opus-5-5')
    expect(found?.firstPrompt).toBe('最初')
  })

  it('describeUri: 索引のヒットの uri (メッセージ id 付き) からファイルへ戻す', async () => {
    writeTranscript('-Users-tester-work-app', SID, [
      userLine(SID, CWD, 'u1', [{ type: 'text', text: 'q' }]),
      assistantLine(SID, CWD, 'a1', [{ type: 'text', text: 'a' }])
    ])
    const reader = new TranscriptReader(home)
    const content = await reader.readMessages(`-Users-tester-work-app/${SID}.jsonl`)
    expect(content?.sessionId).toBe(SID)
    const hitUri = `transcript://-Users-tester-work-app/${SID}.jsonl/a1`
    expect((await reader.describeUri(hitUri))?.sessionId).toBe(SID)
    expect(await reader.describeUri('transcript://nope')).toBeNull()
    expect(await reader.describeUri('file:///etc/passwd')).toBeNull()
    // Nothing comes out of the transcript directory.
    expect(await reader.describeUri('transcript://../../etc/passwd.jsonl/x')).toBeNull()
  })
})

describe('転写の過去分 (項目 111)', () => {
  it('読みどめまでの行を user / assistant / tool_use / tool_result のイベントにする。sidechain と meta は出ない', async () => {
    const lines = [
      userLine(SID, CWD, 'u1', [{ type: 'text', text: '質問' }], { ts: '2026-09-27T01:00:00.000Z' }),
      assistantLine(SID, CWD, 'a1', [
        { type: 'thinking', thinking: '…' },
        { type: 'text', text: '見ます' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/Users/tester/work/app/a.ts' } }
      ]),
      userLine(SID, CWD, 'r1', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'const a = 1\n' }]),
      userLine(SID, CWD, 'side', [{ type: 'text', text: 'child' }], { sidechain: true }),
      userLine(SID, CWD, 'meta', '<local-command-stdout>x</local-command-stdout>', { meta: true }),
      assistantLine(SID, CWD, 'a2', [{ type: 'text', text: '答え' }]),
      userLine(SID, CWD, 'u2', [{ type: 'text', text: '続きの質問 (aios で送った分)' }])
    ]
    const file = writeTranscript('-Users-tester-work-app', SID, lines)
    // The read-through point = up to just before the last line (the part sent by aios).
    const limit = Buffer.byteLength(lines.slice(0, -1).join('\n') + '\n', 'utf8')
    const reader = new TranscriptReader(home)
    const events = await reader.readHistory(`-Users-tester-work-app/${SID}.jsonl`, { threadId: 't1', sessionId: SID }, limit)
    expect(events).not.toBeNull()
    expect(events!.map((e) => e.kind)).toEqual(['user_text', 'assistant_text', 'tool_use', 'tool_result', 'assistant_text'])
    for (const event of events!) {
      expect(event.id.startsWith(TRANSCRIPT_EVENT_ID_PREFIX)).toBe(true)
      expect(event.threadId).toBe('t1')
      expect(event.sessionId).toBe(SID)
      expect(event.actor).toBe('main')
    }
    const [q, a, tool, result] = events!
    expect(q!.kind === 'user_text' && q!.payload).toEqual({ text: '質問', messageId: 'u1' })
    expect(q!.ts).toBe(Date.parse('2026-09-27T01:00:00.000Z'))
    expect(a!.kind === 'assistant_text' && a!.payload.text).toBe('見ます')
    expect(tool!.kind === 'tool_use' && tool!.payload.toolUseId).toBe('toolu_1')
    expect(tool!.kind === 'tool_use' && tool!.payload.name).toBe('Read')
    // tool_result is only the length (the body is not included; constraint 10).
    expect(result!.kind === 'tool_result' && result!.payload).toEqual({ toolUseId: 'toolu_1', ok: true, bytes: 12 })
    // Nothing past the read-through point comes out. Specifying beyond it (the whole file) does return it.
    const whole = await reader.readHistory(`-Users-tester-work-app/${SID}.jsonl`, { threadId: 't1', sessionId: SID }, 1 << 30)
    expect(whole!.map((e) => e.kind)).toEqual([...events!.map((e) => e.kind), 'user_text'])
    expect(await reader.readHistory('nope/x.jsonl', { threadId: 't1', sessionId: SID }, limit)).toBeNull()
    expect(file.endsWith('.jsonl')).toBe(true)
  })
  it('TODO 878: user 行の画像ブロックの数だけ名前の無い添付を出す。base64 は載せない・画像だけの発言も出る', async () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA'.repeat(50) } }
    const lines = [
      userLine(SID, CWD, 'u1', [{ type: 'text', text: '見て' }, img, img]),
      assistantLine(SID, CWD, 'a1', [{ type: 'text', text: 'はい' }]),
      userLine(SID, CWD, 'u2', [img]),
      userLine(SID, CWD, 'u3', [{ type: 'text', text: '画像なし' }])
    ]
    writeTranscript('-Users-tester-work-app', SID, lines)
    const reader = new TranscriptReader(home)
    const events = await reader.readHistory(`-Users-tester-work-app/${SID}.jsonl`, { threadId: 't1', sessionId: SID }, 1 << 30)
    const users = events!.filter((e) => e.kind === 'user_text').map((e) => (e.kind === 'user_text' ? e.payload : null))
    expect(users[0]).toEqual({ text: '見て', attachments: [{ name: '' }, { name: '' }], messageId: 'u1' })
    expect(users[1]).toEqual({ text: '', attachments: [{ name: '' }], messageId: 'u2' })
    expect(users[2]).toEqual({ text: '画像なし', messageId: 'u3' })
    expect(JSON.stringify(events)).not.toContain('AAAA')
  })
})

describe('aios が持つ会話の転写を索引から外す (項目 111)', () => {
  const messages = [
    { id: 'm1', offset: 0, length: 100 },
    { id: 'm2', offset: 101, length: 100 },
    { id: 'm3', offset: 202, length: 100 }
  ]
  it('表に無い id は全部、null (aios が始めた) は載せない、読みどめがあればそこまで', () => {
    const owned = new Map<string, number | null>([
      ['own', null],
      ['adopted', 201]
    ])
    expect(filterOwnedTranscript('other', messages, owned)).toEqual({ skip: false, messages })
    expect(filterOwnedTranscript(null, messages, owned)).toEqual({ skip: false, messages })
    expect(filterOwnedTranscript('own', messages, owned)).toEqual({ skip: true, messages: [] })
    expect(filterOwnedTranscript('adopted', messages, owned)).toEqual({
      skip: false,
      messages: messages.slice(0, 2)
    })
  })
})
