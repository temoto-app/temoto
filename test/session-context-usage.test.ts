/**
 * The breakdown of the SessionManager's context usage (item 155, ARCHITECTURE.md 4.5.1).
 *
 * With a fake Adapter (a minimal copy of the one in `session-plan.test.ts`), **neither the CLI nor the model is started**. The DB is the real
 * SQLite code (in memory). What is pinned:
 * - If the process is running, the value is taken on the spot, the cache is replaced, and `fresh: true`
 * - If there is no process or it cannot be taken, the last cached value with `fresh: false` (null if it was never taken)
 * - **The process is not woken for the breakdown**
 * - Memory files are made URIs, and a file that hits the choke point is marked as not openable
 * - The cache is discarded at a conversation boundary (`/clear` / compaction) and when a thread is deleted
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload, ThinkingLevel } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import type { ThreadSummary } from '../src/shared/thread.js'
import { runMigrations } from '../src/common/migrations.js'
import { SessionManager, type SessionManagerDeps } from '../src/main/session/manager.js'
import type {
  AgentAdapter,
  AgentContextUsage,
  AgentInput,
  AgentSession,
  SpawnHandlers,
  SpawnOptions
} from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'

const USAGE: AgentContextUsage = {
  model: 'model-x',
  totalTokens: 30_000,
  maxTokens: 200_000,
  percentage: 15,
  categories: [
    { name: 'System prompt', tokens: 6_000, kind: 'used', tone: 'system' },
    { name: 'Messages', tokens: 24_000, kind: 'used', tone: 'messages' },
    { name: 'Free space', tokens: 170_000, kind: 'free', tone: null }
  ],
  memoryFiles: [
    { path: '/p/CLAUDE.md', type: 'Project', tokens: 20 },
    { path: '/home/excluded/CLAUDE.md', type: 'User', tokens: 30 }
  ]
}

class FakeSession implements AgentSession {
  readonly sent: AgentInput[] = []
  alive = true
  /** The answer of `contextUsage` (null = cannot be taken). */
  usage: AgentContextUsage | null = USAGE
  contextCalls = 0
  constructor(
    readonly sessionId: string,
    readonly handlers: SpawnHandlers
  ) {}
  send(input: AgentInput): void {
    this.sent.push(input)
  }
  async interrupt(): Promise<void> {}
  abort(): void {}
  async stop(): Promise<void> {
    if (!this.alive) return
    this.alive = false
    this.handlers.onExit({ code: 0, signal: null, sawResult: true, requested: true })
  }
  /** The version that does not hold a model / thinking switch while running (it looks only at Plan). */
  async switchSettings(target: { modelId: string | null; thinking: ThinkingLevel | null }): Promise<boolean> {
    return target.modelId === null && target.thinking === null
  }
  async contextUsage(): Promise<AgentContextUsage | null> {
    this.contextCalls += 1
    return this.usage
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

class FakeAdapter implements AgentAdapter {
  readonly id = 'fake'
  readonly label = 'Fake'
  readonly transcripts = null
  readonly sessions: FakeSession[] = []
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const session = new FakeSession(options.sessionId, handlers)
    this.sessions.push(session)
    return session
  })
  async listModels(): Promise<readonly { id: string; label: string }[]> {
    return []
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

let db: Db
let adapter: FakeAdapter
let manager: SessionManager
let summaries: readonly ThreadSummary[] = []
let dir: string

function build(): SessionManager {
  const fs = {
    homePath: dir,
    homeUri: `file://${dir}`,
    defaultReferenceDirs: () => [],
    isReferenceable: () => true,
    assertAllowed: (uri: string) => {
      if (uri.includes('excluded')) throw new Error('除外対象です')
      return decodeURIComponent(uri.replace('file://', ''))
    }
  } as unknown as FsAccess
  const index = {
    indexConversationEvents: () => undefined,
    removeThread: () => undefined,
    removeAllConversations: () => undefined
  } as unknown as IndexClient
  const gateway = {
    socketPath: '/tmp/aios-test.sock',
    issueToken: () => 'token',
    revokeToken: () => undefined
  } as unknown as GatewayServer
  const deps: SessionManagerDeps = {
    db,
    adapters: [adapter],
    fs,
    index,
    gateway,
    gatewayRuntimePath: '/bin/false',
    gatewayScriptPath: '/dev/null',
    gatewayConfigDir: '/tmp/aios-test-mcp',
    events: {
      onEvents: () => undefined,
      onThreadsChanged: (list) => {
        summaries = list
      },
      onThreadChanged: (summary) => {
        const at = summaries.findIndex((s) => s.thread.id === summary.thread.id)
        summaries = at === -1 ? [...summaries, summary] : summaries.map((s, i) => (i === at ? summary : s))
      },
      onApprovalsChanged: () => undefined,
      onAgentStatus: () => undefined
    }
  }
  return new SessionManager(deps)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-ctx-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  summaries = []
  manager = build()
})

afterEach(async () => {
  await manager.stop()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

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

/** Sends one turn and returns the `result`. Returns the session it woke. */
async function turn(threadId: string, text: string): Promise<FakeSession> {
  await manager.send(threadId, { text })
  const session = adapter.sessions.at(-1)
  if (session === undefined) throw new Error('no session')
  session.emit({ threadId, kind: 'result', payload: RESULT })
  return session
}


describe('コンテキスト使用量の内訳 (項目 155)', () => {
  it('プロセスが無ければ起こさず、一度も取っていなければ null', async () => {
    const thread = await manager.createThread({})
    await expect(manager.contextBreakdown(thread.id)).resolves.toEqual({ breakdown: null, fresh: false })
    expect(adapter.spawn).not.toHaveBeenCalled()
  })

  it('走っていればその場で取り、メモリファイルを URI にして関門に当たるものを開けない印にする', async () => {
    const thread = await manager.createThread({})
    const session = await turn(thread.id, 'こんにちは')
    const result = await manager.contextBreakdown(thread.id)
    expect(session.contextCalls).toBe(1)
    expect(result.fresh).toBe(true)
    expect(result.breakdown).toMatchObject({ model: 'model-x', totalTokens: 30_000, maxTokens: 200_000, percentage: 15 })
    expect(result.breakdown?.memoryFiles).toEqual([
      { uri: 'file:///p/CLAUDE.md', type: 'Project', tokens: 20, openable: true },
      { uri: 'file:///home/excluded/CLAUDE.md', type: 'User', tokens: 30, openable: false }
    ])
  })

  it('プロセスが止まった後は最後の控えを fresh: false で返す (取った時刻はそのまま、起こさない)', async () => {
    const thread = await manager.createThread({})
    await turn(thread.id, 'こんにちは')
    const first = await manager.contextBreakdown(thread.id)
    await manager.stopThread(thread.id)
    const later = await manager.contextBreakdown(thread.id)
    expect(later).toEqual({ breakdown: first.breakdown, fresh: false })
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('走っていても取れなければ最後の控え', async () => {
    const thread = await manager.createThread({})
    const session = await turn(thread.id, 'こんにちは')
    const first = await manager.contextBreakdown(thread.id)
    session.usage = null
    await expect(manager.contextBreakdown(thread.id)).resolves.toEqual({ breakdown: first.breakdown, fresh: false })
  })

  it('会話の区切り (/clear・圧縮) で控えを捨てる', async () => {
    const thread = await manager.createThread({})
    const session = await turn(thread.id, 'こんにちは')
    await manager.contextBreakdown(thread.id)
    session.usage = null
    session.emit({ threadId: thread.id, kind: 'conversation_reset', payload: {} })
    await expect(manager.contextBreakdown(thread.id)).resolves.toEqual({ breakdown: null, fresh: false })
    session.usage = USAGE
    await manager.contextBreakdown(thread.id)
    session.usage = null
    session.emit({
      threadId: thread.id,
      kind: 'context_compacted',
      payload: { trigger: 'manual', preTokens: 1, postTokens: 1 }
    })
    await expect(manager.contextBreakdown(thread.id)).resolves.toEqual({ breakdown: null, fresh: false })
  })

  it('無いスレッドは断る', async () => {
    await expect(manager.contextBreakdown('no-such-thread')).rejects.toThrow()
  })
})
