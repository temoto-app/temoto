/**
 * Continuing a terminal / VS Code conversation in aios (item 111, ARCHITECTURE.md 4.5.9), the main side.
 *
 * The transcript is a fake of `AgentAdapter.transcripts` (it returns the summary and past parts as arrays), so no CLI or model is called. The DB is the real SQLite code (in memory, up to migration 17). Split from `test/session-manager.test.ts` into its own harness (same decision as bundles B / D).
 *
 * What is pinned down:
 * - migration 17: the round trip of `threads.transcript_origin` and the `ownedBackendSessions` table
 * - Creating from a transcript: cwd is the transcript's, the model is the last response's (read as an alias), the title is the backend's title, and the read-through point is the size of the transcript. Refused together with cwdUri. Refused when the transcript is missing, already owned, or its cwd is unusable
 * - List: session ids that aios owns (including deleted threads) do not appear. A search hit gives `threadId`
 * - First launch: `--resume <transcript sid>` (`--fork-session` for a branch). `session_started` adds the sessions row, and from then on it is an ordinary resume
 * - Timeline: past parts come first (negative positions), and 'read more' goes further back. Rows aios adds do not show up twice
 * - Restoring `tool_result` also hits the original transcript
 * - 'Continue in terminal': stop the process and return `cd … && … --resume …`. Refused when there is no session
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentStatus, AiosEvent, ResultPayload } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import type { ThreadSummary } from '../src/shared/thread.js'
import { TRANSCRIPT_EVENT_ID_PREFIX } from '../src/shared/thread.js'
import { runMigrations } from '../src/common/migrations.js'
import { SessionManager } from '../src/main/session/manager.js'
import { ThreadStore } from '../src/main/session/store.js'
import type {
  AgentAdapter,
  AgentInput,
  AgentSession,
  SpawnHandlers,
  SpawnOptions,
  TranscriptHistoryContext,
  TranscriptSessionInfo,
  TranscriptStore
} from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'

class FakeSession implements AgentSession {
  readonly sent: AgentInput[] = []
  alive = true
  constructor(
    readonly sessionId: string,
    readonly handlers: SpawnHandlers
  ) {}
  send(input: AgentInput): void {
    this.sent.push(input)
  }
  async interrupt(): Promise<void> {}
  abort(): void {
    this.alive = false
  }
  async stop(): Promise<void> {
    if (!this.alive) return
    this.alive = false
    this.handlers.onExit({ code: 0, signal: null, sawResult: true, requested: true })
  }
  emit(event: Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'>): void {
    this.handlers.onEvent({
      id: `${this.sessionId}:${Math.random()}`,
      sessionId: this.sessionId,
      ts: Date.now(),
      actor: 'main',
      ...event
    } as unknown as AiosEvent)
  }
}

/** Fake transcript. Holds the summary and past parts as arrays. */
class FakeTranscripts implements TranscriptStore {
  sessions: TranscriptSessionInfo[] = []
  /** Past parts returned by `readHistory` (fills in threadId / sessionId from ctx). */
  history: Omit<AiosEvent, 'threadId' | 'sessionId'>[] = []
  /** The answer of `findToolResult(sid, toolUseId)`. */
  toolResults = new Map<string, { text: string; bytes: number; truncated: boolean }>()
  historyReads: { fileId: string; limit: number }[] = []
  async listFiles(): Promise<readonly never[]> {
    return []
  }
  async readMessages(): Promise<null> {
    return null
  }
  async readMessageText(): Promise<{ text: null; stale: false; missing: false }> {
    return { text: null, stale: false, missing: false }
  }
  async findToolResult(backendSessionId: string, toolUseId: string) {
    return this.toolResults.get(`${backendSessionId}/${toolUseId}`) ?? null
  }
  async listSessions(): Promise<readonly TranscriptSessionInfo[]> {
    return this.sessions
  }
  async findSession(sessionId: string): Promise<TranscriptSessionInfo | null> {
    return this.sessions.find((s) => s.sessionId === sessionId) ?? null
  }
  async describeUri(uri: string): Promise<TranscriptSessionInfo | null> {
    return this.sessions.find((s) => uri === s.uri || uri.startsWith(`${s.uri}/`)) ?? null
  }
  async readHistory(fileId: string, ctx: TranscriptHistoryContext, limit: number): Promise<readonly AiosEvent[] | null> {
    this.historyReads.push({ fileId, limit })
    if (!this.sessions.some((s) => s.id === fileId)) return null
    return this.history.map((event) => ({ ...event, threadId: ctx.threadId, sessionId: ctx.sessionId }) as AiosEvent)
  }
}

class FakeAdapter implements AgentAdapter {
  readonly id = 'fake'
  readonly label = 'Fake'
  readonly transcripts = new FakeTranscripts()
  readonly sessions: FakeSession[] = []
  readonly spawnOptions: SpawnOptions[] = []
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers) => {
    this.spawnOptions.push(options)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const session = new FakeSession(options.sessionId, handlers)
    this.sessions.push(session)
    return session
  })
  async listModels(): Promise<readonly { id: string; label: string }[]> {
    return [
      { id: 'model-a', label: 'A' },
      { id: 'model-b', label: 'B' }
    ]
  }
  /**
   * Old id -> alias (a copy of the real `canonicalModelId`). **Full names are not converted.** The bug of item 140 happened because an earlier fake turned a full name into an alias here (the real one does not), and the tests could not see it.
   */
  canonicalModelId(id: string): string {
    return id === 'model-a-legacy' ? 'model-a' : id
  }
  /** Reported full name -> alias (item 140, a copy of the real `modelIdForReported`). Null when nothing matches. */
  modelIdForReported(model: string): string | null {
    if (model === 'model-b-full-name') return 'model-b'
    const legacy = this.canonicalModelId(model)
    return legacy === 'model-a' || legacy === 'model-b' ? legacy : null
  }
  async getStatus(): Promise<AgentStatus> {
    const features = {} as Record<AgentFeature, boolean>
    for (const feature of AGENT_FEATURES) features[feature] = true
    return {
      available: true,
      version: '0.0.0',
      loggedIn: true,
      authMethod: null,
      subscriptionType: null,
      features,
      degradations: [],
      source: 'known-version',
      needsProbe: false,
      checkedAt: Date.now(),
      message: null,
      messageCode: null
    }
  }
  supports(): boolean {
    return true
  }
}

const RESULT: ResultPayload = {
  ok: true,
  subtype: 'success',
  turns: 1,
  durationMs: 1,
  costUsd: 0.01,
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  stopReason: null,
  denials: [],
  text: null
}

let db: Db
let adapter: FakeAdapter
let manager: SessionManager
let store: ThreadStore
let summaries: ThreadSummary[] = []
let cwd: string
const SID = 'aaaaaaaa-1111-4111-8111-111111111111'

function info(overrides: Partial<TranscriptSessionInfo> = {}): TranscriptSessionInfo {
  return {
    id: `-proj/${SID}.jsonl`,
    uri: `transcript://-proj/${SID}.jsonl`,
    sessionId: SID,
    cwd,
    title: 'テストの修正',
    firstPrompt: 'テストを直して',
    model: 'model-b-full-name',
    mtimeMs: Date.now() - 3_600_000,
    size: 4321,
    ...overrides
  }
}

function historyEvent(kind: AiosEvent['kind'], payload: unknown, n: number): Omit<AiosEvent, 'threadId' | 'sessionId'> {
  return { id: `${TRANSCRIPT_EVENT_ID_PREFIX}u${n}:0`, ts: 1_000 + n, actor: 'main', kind, payload } as Omit<AiosEvent, 'threadId' | 'sessionId'>
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  cwd = mkdtempSync(join(tmpdir(), 'aios-transcript-cwd-H-'))
  adapter = new FakeAdapter()
  adapter.transcripts.sessions = [info()]
  summaries = []
  const home = '/Users/tester'
  const fs = {
    homePath: home,
    homeUri: `file://${home}`,
    defaultReferenceDirs: () => [`${home}/work`],
    isReferenceable: () => true,
    assertAllowed: (uri: string) => {
      if (uri.includes('excluded')) throw new Error('除外対象です')
      return uri.replace('file://', '')
    }
  } as unknown as FsAccess
  const index = {
    indexConversationEvents: () => undefined,
    removeThread: () => undefined,
    removeAllConversations: () => undefined
  } as unknown as IndexClient
  const gateway = {
    socketPath: '/tmp/aios-test-H.sock',
    issueToken: () => 'token',
    revokeToken: () => undefined
  } as unknown as GatewayServer
  manager = new SessionManager({
    db,
    adapters: [adapter],
    fs,
    index,
    gateway,
    gatewayRuntimePath: '/bin/false',
    gatewayScriptPath: '/dev/null',
    gatewayConfigDir: '/tmp/aios-test-H-mcp',
    events: {
      onEvents: () => undefined,
      onThreadsChanged: (list) => {
        summaries = [...list]
      },
      onThreadChanged: (summary) => {
        const at = summaries.findIndex((s) => s.thread.id === summary.thread.id)
        if (at === -1) summaries.push(summary)
        else summaries[at] = summary
      },
      onApprovalsChanged: () => undefined,
      onAgentStatus: () => undefined
    }
  })
  store = new ThreadStore(db, home)
})

afterEach(async () => {
  await manager.stop()
  db.close()
  rmSync(cwd, { recursive: true, force: true })
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

function startSession(threadId: string, backendSessionId: string): void {
  const session = adapter.sessions.at(-1)
  if (session === undefined) throw new Error('no session')
  session.emit({
    threadId,
    kind: 'session_started',
    payload: {
      backendSessionId,
      backendVersion: null,
      model: null,
      cwd: null,
      reportedPermissionMode: null,
      tools: [],
      toolServers: [],
      resumed: true
    }
  })
  session.emit({ threadId, kind: 'result', payload: RESULT })
}

describe('migration 17 と ThreadStore (項目 111)', () => {
  it('transcript_origin が往復し、renderer には fork だけ届く', () => {
    const columns = (db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[]).map((c) => c.name)
    expect(columns).toContain('transcript_origin')
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(17)
    const thread = store.createThread({
      id: 't-1',
      title: 'x',
      cwd: '/Users/tester/work',
      allowedDirs: [],
      retention: 'forever',
      backend: 'fake',
      modelId: null,
      thinking: null,
      transcriptOrigin: { sessionId: SID, fileId: 'f', limit: 100, fork: false }
    })
    expect(thread.transcriptOrigin).toEqual({ fork: false })
    expect(store.transcriptOriginOf('t-1')).toEqual({ sessionId: SID, fileId: 'f', limit: 100, fork: false })
    const plain = store.createThread({
      id: 't-2',
      title: 'y',
      cwd: '/Users/tester/work',
      allowedDirs: [],
      retention: 'forever',
      backend: 'fake',
      modelId: null,
      thinking: null
    })
    expect(plain.transcriptOrigin).toBeNull()
    expect(store.transcriptOriginOf('t-2')).toBeNull()
    // Broken JSON counts as 'no origin'.
    db.prepare(`UPDATE threads SET transcript_origin = '{bad' WHERE id = 't-1'`).run()
    expect(store.getThread('t-1')?.transcriptOrigin).toBeNull()
  })

  it('ownedBackendSessions: sessions の行は載せない (null)、同じ id で続けた転写は読みどめ、分岐は載らない、消したスレッドは alive=false', () => {
    for (const [id, origin] of [
      ['t-own', null],
      ['t-adopt', { sessionId: 'sid-adopt', fileId: 'f1', limit: 500, fork: false }],
      ['t-fork', { sessionId: 'sid-forked-from', fileId: 'f2', limit: 700, fork: true }]
    ] as const) {
      store.createThread({
        id,
        title: id,
        cwd: '/Users/tester/work',
        allowedDirs: [],
        retention: 'forever',
        backend: 'fake',
        modelId: null,
        thinking: null,
        transcriptOrigin: origin
      })
    }
    store.recordSession({ id: 's1', threadId: 't-own', backendSessionId: 'sid-own', forkedFrom: null, backendVersion: null })
    store.recordSession({ id: 's2', threadId: 't-fork', backendSessionId: 'sid-fork-new', forkedFrom: 'sid-forked-from', backendVersion: null })
    store.removeThread('t-own')
    const owned = store.ownedBackendSessions()
    expect(owned.get('sid-own')).toEqual({ threadId: 't-own', alive: false, limit: null })
    expect(owned.get('sid-adopt')).toEqual({ threadId: 't-adopt', alive: true, limit: 500 })
    expect(owned.get('sid-fork-new')).toEqual({ threadId: 't-fork', alive: true, limit: null })
    // The original transcript of a branch is not aios's (the original conversation stays on the terminal side).
    expect(owned.has('sid-forked-from')).toBe(false)
  })
})

describe('SessionManager — 転写から作る (項目 111)', () => {
  it('cwd は転写、モデルは最後の応答を別名に読み替え、題名はバックエンドの題名、読みどめは転写の大きさ', async () => {
    const thread = await manager.createThread({ transcript: { sessionId: SID, fork: false }, approvalStrict: true })
    expect(thread.cwdUri).toBe(`file://${cwd}`)
    expect(thread.modelId).toBe('model-b')
    expect(thread.title).toBe('テストの修正')
    expect(thread.approvalStrict).toBe(true)
    expect(thread.transcriptOrigin).toEqual({ fork: false })
    expect(store.transcriptOriginOf(thread.id)).toEqual({ sessionId: SID, fileId: `-proj/${SID}.jsonl`, limit: 4321, fork: false })
    // It also appears in the history (it can be picked in the next dialog).
    expect(store.cwdHistory().map((row) => row.path)).toContain(cwd)
    expect(summaries.map((s) => s.thread.id)).toContain(thread.id)
  })

  it('題名が無ければ最初の発言、モデルが一覧に無ければ設定の既定', async () => {
    adapter.transcripts.sessions = [info({ title: null, firstPrompt: '最初の発言', model: 'unknown-model' })]
    const thread = await manager.createThread({ transcript: { sessionId: SID, fork: true } })
    expect(thread.title).toBe('最初の発言')
    expect(thread.modelId).toBe(manager.getSettings().defaultModelId ?? thread.modelId)
    // Marks that it fell back to the default, shown in the band (item 140).
    expect(thread.transcriptOrigin).toEqual({ fork: true, modelFallback: true })
    expect(store.transcriptOriginOf(thread.id)?.modelFallback).toBe(true)
  })

  it('完全名は canonicalModelId ではなく modelIdForReported で読み替える (項目 140、代理確認 138 の再現)', async () => {
    const canonical = vi.spyOn(adapter, 'canonicalModelId')
    const thread = await manager.createThread({ transcript: { sessionId: SID, fork: false } })
    expect(thread.modelId).toBe('model-b')
    expect(canonical).not.toHaveBeenCalledWith('model-b-full-name')
    // When it hits, no mark is set.
    expect(thread.transcriptOrigin).toEqual({ fork: false })
    // Sending (waking it) resumes with the transcript's id, and the model is the converted alias.
    await manager.send(thread.id, { text: 'つづき' })
    await vi.waitFor(() => expect(adapter.spawnOptions).toHaveLength(1))
    expect(adapter.spawnOptions[0]?.modelId).toBe('model-b')
  })

  it('転写にモデルが無ければ既定で作り、印は付けない (項目 140)', async () => {
    adapter.transcripts.sessions = [info({ model: null })]
    const thread = await manager.createThread({ transcript: { sessionId: SID, fork: false } })
    expect(thread.transcriptOrigin).toEqual({ fork: false })
  })

  it('cwdUri / scratch と同時、無い転写、cwd が使えない転写は断る', async () => {
    await expect(manager.createThread({ transcript: { sessionId: SID, fork: false }, cwdUri: `file://${cwd}` })).rejects.toThrow(
      'aios-reason:transcript-with-cwd'
    )
    await expect(manager.createThread({ transcript: { sessionId: SID, fork: false }, scratch: true })).rejects.toThrow(
      'aios-reason:transcript-with-cwd'
    )
    await expect(manager.createThread({ transcript: { sessionId: 'nope', fork: false } })).rejects.toThrow(
      'aios-reason:transcript-not-found'
    )
    adapter.transcripts.sessions = [info({ cwd: '/Users/tester/excluded' })]
    await expect(manager.createThread({ transcript: { sessionId: SID, fork: false } })).rejects.toThrow(
      'aios-reason:transcript-cwd-unusable'
    )
    adapter.transcripts.sessions = [info({ cwd: join(cwd, 'gone') })]
    await expect(manager.createThread({ transcript: { sessionId: SID, fork: false } })).rejects.toThrow(
      /transcript-cwd-unusable.*cwd-not-found/
    )
    adapter.transcripts.sessions = [info({ cwd: null })]
    await expect(manager.createThread({ transcript: { sessionId: SID, fork: false } })).rejects.toThrow(
      'aios-reason:transcript-cwd-unusable'
    )
  })

  it('aios のスレッドが既に持つ session id は同じ id では断り、分岐なら通る。消したスレッドの id も同じ', async () => {
    const first = await manager.createThread({ transcript: { sessionId: SID, fork: false } })
    await expect(manager.createThread({ transcript: { sessionId: SID, fork: false } })).rejects.toThrow(
      'aios-reason:transcript-owned'
    )
    const fork = await manager.createThread({ transcript: { sessionId: SID, fork: true } })
    expect(fork.transcriptOrigin).toEqual({ fork: true })
    await manager.remove(first.id, { force: true })
    await expect(manager.createThread({ transcript: { sessionId: SID, fork: false } })).rejects.toThrow(
      'aios-reason:transcript-owned'
    )
  })

  it('一覧は aios が持つ id を出さず、検索ヒットからは持っているスレッドが引ける', async () => {
    const other = info({ id: '-proj/other.jsonl', uri: 'transcript://-proj/other.jsonl', sessionId: 'sid-other', cwd: '/Users/tester/excluded' })
    adapter.transcripts.sessions = [info(), other]
    const before = await manager.listTranscriptSessions()
    expect(before.map((s) => s.sessionId)).toEqual([SID, 'sid-other'])
    expect(before[0]).toMatchObject({ usable: true, reason: null, threadId: null, cwdUri: `file://${cwd}`, title: 'テストの修正' })
    expect(before[1]).toMatchObject({ usable: false, threadId: null })
    expect(before[1]!.reason).toContain('除外対象')

    const thread = await manager.createThread({ transcript: { sessionId: SID, fork: false } })
    const after = await manager.listTranscriptSessions()
    expect(after.map((s) => s.sessionId)).toEqual(['sid-other'])
    const hit = await manager.transcriptSessionOfUri(`transcript://-proj/${SID}.jsonl/u1`)
    expect(hit?.threadId).toBe(thread.id)
    expect(await manager.transcriptSessionOfUri('transcript://nope/x.jsonl/y')).toBeNull()
    // The id of a deleted thread is 'held', but cannot be opened.
    await manager.remove(thread.id, { force: true })
    const gone = await manager.transcriptSessionOfUri(`transcript://-proj/${SID}.jsonl/u1`)
    expect(gone).toMatchObject({ threadId: null, usable: false, reason: 'transcript-owned' })
  })
})

describe('SessionManager — 続けたスレッドの起動とタイムライン (項目 111)', () => {
  it('最初の起動は転写の id で --resume。session_started で sessions の行が入り、以後は普通の再開', async () => {
    const thread = await manager.createThread({ transcript: { sessionId: SID, fork: false } })
    await manager.send(thread.id, { text: '続き' })
    expect(adapter.spawnOptions[0]).toMatchObject({ resumeBackendSessionId: SID, forkSession: false, cwd })
    startSession(thread.id, SID)
    await settle()
    expect(store.latestBackendSessionId(thread.id)).toBe(SID)
    expect(store.ownedBackendSessions().get(SID)).toEqual({ threadId: thread.id, alive: true, limit: 4321 })
    await manager.stopThread(thread.id)
    await manager.send(thread.id, { text: 'もう一度' })
    expect(adapter.spawnOptions[1]).toMatchObject({ resumeBackendSessionId: SID, forkSession: false })
  })

  it('分岐は --fork-session で起こし、新しい id の行が forked_from 付きで入る', async () => {
    const thread = await manager.createThread({ transcript: { sessionId: SID, fork: true } })
    await manager.send(thread.id, { text: '続き' })
    expect(adapter.spawnOptions[0]).toMatchObject({ resumeBackendSessionId: SID, forkSession: true })
    startSession(thread.id, 'sid-new')
    await settle()
    const row = db.prepare(`SELECT forked_from FROM sessions WHERE backend_session_id = 'sid-new'`).get() as { forked_from: string | null }
    expect(row.forked_from).toBe(SID)
    // The original id of a branch is not aios's (it appears in the list as is).
    expect(store.ownedBackendSessions().has(SID)).toBe(false)
    expect((await manager.listTranscriptSessions()).map((s) => s.sessionId)).toEqual([SID])
  })

  it('タイムラインの頭に過去分が付き (負の位置)、さらに読むで遡れる。aios の行と二重にならない', async () => {
    adapter.transcripts.history = [
      historyEvent('user_text', { text: 'q1' }, 1),
      historyEvent('assistant_text', { text: 'a1' }, 2),
      historyEvent('user_text', { text: 'q2' }, 3),
      historyEvent('assistant_text', { text: 'a2' }, 4)
    ]
    const thread = await manager.createThread({ transcript: { sessionId: SID, fork: false } })
    const initial = await manager.timeline(thread.id)
    expect(initial.events.map((e) => e.kind)).toEqual(['user_text', 'assistant_text', 'user_text', 'assistant_text'])
    expect(initial.events.every((e) => e.id.startsWith(TRANSCRIPT_EVENT_ID_PREFIX) && e.threadId === thread.id)).toBe(true)
    expect(initial.oldestSeq).toBe(-4)
    expect(initial.remaining).toBe(0)
    // The read-through point is read with the row's value (4321).
    expect(adapter.transcripts.historyReads.at(-1)).toEqual({ fileId: `-proj/${SID}.jsonl`, limit: 4321 })

    // What aios sends becomes a DB row, and lines up after the past parts.
    await manager.send(thread.id, { text: '続き' })
    await settle()
    const merged = await manager.timeline(thread.id)
    expect(merged.events.map((e) => e.kind)).toEqual(['user_text', 'assistant_text', 'user_text', 'assistant_text', 'user_text'])
    const last = merged.events.at(-1)
    expect(last?.kind === 'user_text' ? last.payload.text : null).toBe('続き')

    // Go back 2 items per page: 1 from the DB + the last 1 of the past parts -> 3 left -> the next page starts from a negative position.
    const page1 = await manager.timelineBefore(thread.id, 1 << 30, 2)
    expect(page1.events.map((e) => (e.kind === 'user_text' || e.kind === 'assistant_text' ? e.payload.text : e.kind))).toEqual(['a2', '続き'])
    expect(page1.oldestSeq).toBe(-1)
    expect(page1.remaining).toBe(3)
    const page2 = await manager.timelineBefore(thread.id, page1.oldestSeq!, 2)
    expect(page2.events.map((e) => (e.kind === 'user_text' || e.kind === 'assistant_text' ? e.payload.text : e.kind))).toEqual(['a1', 'q2'])
    expect(page2.oldestSeq).toBe(-3)
    expect(page2.remaining).toBe(1)
    const page3 = await manager.timelineBefore(thread.id, page2.oldestSeq!, 2)
    expect(page3.events.map((e) => (e.kind === 'user_text' ? e.payload.text : e.kind))).toEqual(['q1'])
    expect(page3.oldestSeq).toBe(-4)
    expect(page3.remaining).toBe(0)
    const page4 = await manager.timelineBefore(thread.id, page3.oldestSeq!, 2)
    expect(page4.events).toEqual([])
    expect(page4.oldestSeq).toBeNull()
  })

  it('普通のスレッドのタイムラインは変わらない (転写を読まない)', async () => {
    const thread = await manager.createThread({ cwdUri: `file://${cwd}` })
    const page = await manager.timeline(thread.id)
    expect(page).toMatchObject({ events: [], oldestSeq: null, remaining: 0 })
    expect(adapter.transcripts.historyReads).toEqual([])
  })

  it('tool_result の復元は自分の id で見つからなければ元の転写に当たる', async () => {
    adapter.transcripts.toolResults.set(`${SID}/toolu_1`, { text: 'old output', bytes: 10, truncated: false })
    const thread = await manager.createThread({ transcript: { sessionId: SID, fork: true } })
    // Even before it is woken (no sessions row), it can be read from the original transcript.
    expect(await manager.readToolResult(thread.id, 'toolu_1')).toEqual({ text: 'old output', bytes: 10, truncated: false })
    await manager.send(thread.id, { text: 'x' })
    startSession(thread.id, 'sid-new')
    await settle()
    expect(await manager.readToolResult(thread.id, 'toolu_1')).toEqual({ text: 'old output', bytes: 10, truncated: false })
    expect(await manager.readToolResult(thread.id, 'toolu_none')).toBeNull()
  })
})

// 'Continue in terminal' (the resume command of item 111) was removed by item 162 (2026-09-27).
