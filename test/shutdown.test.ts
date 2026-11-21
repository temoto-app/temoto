/**
 * Shutdown (12.6). Guards that **there is no path that writes after the DB is closed**.
 *
 * The symptom was an uncaught exception of `The database connection is not open`.
 * There were three sources:
 *   1. The watch is attached after the startup scan finishes, so if the app quits during the scan, the watch is attached **after** `stop()`, and diffs flow with nobody able to stop it.
 *   2. `Batcher.dispose()` only stops the timer, and a later `push` re-arms it. Unsubscribing is asynchronous, so there is always a gap.
 *   3. The scan-completion `onIndexable` -> `IndexService.resume()` -> `build()` sets `stopped` back to false, and the index that was meant to be stopped restarts.
 *
 * Vitest fails on an uncaught exception as is, so here we check directly that "after closing the DB and waiting a while, nothing fails".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { Batcher } from '../src/common/batch.js'
import { log } from '../src/common/logger.js'
import type { AgentStatus, AiosEvent } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import { SessionManager } from '../src/main/session/manager.js'
import { ApprovalBroker } from '../src/main/approval/broker.js'
import type {
  AgentAdapter,
  AgentSession,
  SpawnHandlers,
  SpawnOptions
} from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'
import { makeTestDir } from './helpers/tmp.js'
import { SHUTDOWN_TIMEOUT_MS, shutdownWithin } from '../src/main/shutdown.js'

const KEY = 'd'.repeat(64)

let root: string
let dbDir: string
let db: Db
let store: IndexStore
let index: IndexService
let fs: FsIndexer

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

beforeAll(() => {
  // On macOS tmpdir() is under /var/folders, which hits the exclusion in 4.4.2, so create it under the home directory.
  root = makeTestDir('quit-test')
  dbDir = makeTestDir('quitdb-test')
  mkdirSync(join(root, 'notes'), { recursive: true })
  writeFileSync(join(root, 'notes/a.md'), '# 記録\n\n本文。\n')

  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key='${KEY}'`)
  runMigrations(db)
  store = new IndexStore(db)
  index = new IndexService({
    db,
    store,
    conversation: { readEventText: async () => null, threadTitle: async () => null },
    transcripts: null,
    onStatus: () => {}
  })
  fs = new FsIndexer(
    db,
    { onScanStatus: () => {}, onFileChanges: () => {}, onIndexable: () => index.resume() },
    store,
    root,
    [root]
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

describe('Batcher', () => {
  it('dispose の後の push はタイマーを張り直さない', () => {
    vi.useFakeTimers()
    const flushed: unknown[] = []
    const batcher = new Batcher<number>((items) => flushed.push(items), { intervalMs: 16 })
    batcher.dispose()
    // Events that arrive in the gap while unsubscribing is pending. If they are buffered here, they would flow out after the DB is closed.
    batcher.push(1)
    vi.advanceTimersByTime(1_000)
    expect(flushed).toHaveLength(0)
    vi.useRealTimers()
  })

  it('drain は残りを返して破棄する (onFlush は呼ばない、後の push は無視、TODO 889)', () => {
    vi.useFakeTimers()
    const flushed: unknown[] = []
    const batcher = new Batcher<{ k: string; v: number }>((items) => flushed.push(items), {
      intervalMs: 16,
      keyOf: (item) => item.k
    })
    batcher.push({ k: 'a', v: 1 })
    batcher.push({ k: 'a', v: 2 })
    batcher.push({ k: 'b', v: 3 })
    expect(batcher.drain()).toEqual([
      { k: 'a', v: 2 },
      { k: 'b', v: 3 }
    ])
    batcher.push({ k: 'c', v: 4 })
    vi.advanceTimersByTime(1_000)
    expect(flushed).toHaveLength(0)
    expect(batcher.drain()).toEqual([])
    vi.useRealTimers()
  })
})

describe('終了処理', () => {
  it('走査中に終了しても、その後に監視を張らない', async () => {
    await fs.start()
    await fs.stop()
    await index.stop()

    // After quitting, neither rescan nor index resume is accepted (both write to the DB).
    await fs.rescan()
    index.resume()

    db.close()

    // If the watch is still attached, this change flows 16 ms later into the closed DB and fails.
    writeFileSync(join(root, 'notes/b.md'), '# 追加\n')
    await sleep(500)

    expect(db.open).toBe(false)
    expect(index.getStatus().state).not.toBe('building')
  }, 30_000)
})

/**
 * SessionManager shutdown (item 79 / REVIEW D-6). After `stop()` returns, `before-quit` closes the DB. Whatever arrives afterwards must not touch the DB: (1) the continuation of an approval being decided, (2) the `error` / exit that comes out when the CLI exits, and (3) a new approval request.
 *
 * better-sqlite3 throws synchronously when a closed DB is touched. With `onAgentEvent` the throw comes back to the caller (here), and with the 16 ms `flush` a `thread.persist.failed` is recorded. Before the fix, (1) and (2) re-armed the timer in `record()`, so `flush` ran after the close.
 */
class QuitSession implements AgentSession {
  alive = true
  constructor(
    readonly sessionId: string,
    readonly handlers: SpawnHandlers
  ) {}
  send(): void {}
  async interrupt(): Promise<void> {}
  abort(): void {}
  /** As with the real LiveSession.finish: if it dies without a result, emit an error and then exit. */
  async stop(): Promise<void> {
    if (!this.alive) return
    this.alive = false
    this.emit('error', { message: 'exited', code: null, origin: 'exit' })
    this.handlers.onExit({ code: 0, signal: null, sawResult: false, requested: true })
  }
  emit(kind: string, payload: unknown): void {
    this.handlers.onEvent({
      id: `${this.sessionId}:${Math.random()}`,
      sessionId: this.sessionId,
      threadId: '',
      ts: Date.now(),
      actor: 'main',
      kind,
      payload
    } as unknown as AiosEvent)
  }
}

class QuitAdapter implements AgentAdapter {
  readonly id = 'fake'
  readonly label = 'Fake'
  readonly transcripts = null
  readonly sessions: QuitSession[] = []
  async listModels(): Promise<readonly { id: string; label: string }[]> {
    return []
  }
  supports(): boolean {
    return true
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
  async spawn(options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> {
    const session = new QuitSession(options.sessionId, handlers)
    this.sessions.push(session)
    return session
  }
}

describe('SessionManager の終了処理 (項目 79)', () => {
  it('stop の後に届いた event / exit / 承認の決着と新しい要求が DB に触らない', async () => {
    const sessionDb = new Database(':memory:')
    runMigrations(sessionDb)
    const adapter = new QuitAdapter()
    const fsAccess = {
      homePath: '/Users/tester',
      homeUri: 'file:///Users/tester',
      defaultReferenceDirs: () => [],
      isReferenceable: () => true
    } as unknown as FsAccess
    const indexClient = {
      indexConversationEvents: () => undefined,
      removeThread: () => undefined
    } as unknown as IndexClient
    const gateway = {
      socketPath: '/tmp/aios-test.sock',
      issueToken: () => 'token',
      revokeToken: () => undefined
    } as unknown as GatewayServer
    const threadLists: number[] = []
    const manager = new SessionManager({
      db: sessionDb,
      adapters: [adapter],
      fs: fsAccess,
      index: indexClient,
      gateway,
      gatewayRuntimePath: '/bin/false',
      gatewayScriptPath: '/dev/null',
      gatewayConfigDir: '/tmp/aios-test-mcp',
      events: {
        onEvents: () => undefined,
        onThreadsChanged: (list) => threadLists.push(list.length),
        onThreadChanged: () => threadLists.push(1),
        onApprovalsChanged: () => undefined,
        onAgentStatus: () => undefined
      }
    })
    const errors = vi.spyOn(log, 'error')

    // Thread in strict mode: approval requests are always queued (the decision is a system rejection on shutdown).
    const thread = await manager.createThread({ approvalStrict: true })
    await manager.send(thread.id, { text: 'hi' })
    const session = adapter.sessions[0]
    if (session === undefined) throw new Error('no session')
    session.emit('session_started', {
      backendSessionId: 'backend-quit',
      backendVersion: null,
      model: null,
      cwd: null,
      reportedPermissionMode: null,
      tools: [],
      toolServers: [],
      resumed: false
    })
    const held = manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', input: { file_path: '/tmp/x' } }
    })
    expect(manager.listApprovals()).toHaveLength(1)
    await sleep(40)

    await manager.stop()
    const listsAtStop = threadLists.length
    sessionDb.close()

    // (1) The approval that was held has been decided by a system rejection. Any record that follows is discarded.
    await expect(held).resolves.toMatchObject({ allowed: false })
    // (2) Events and exit that arrive late, after shutdown. Touching the closed DB would throw synchronously.
    expect(() => {
      session.emit('result', {
        ok: true,
        subtype: 'success',
        turns: 1,
        durationMs: 1,
        costUsd: 0.01,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
        denials: [],
        text: null
      })
      session.emit('assistant_text', { text: '遅れて届いた' })
      session.handlers.onExit({ code: 0, signal: null, sawResult: true, requested: false })
    }).not.toThrow()
    // (3) A new approval request after shutdown is refused without querying the DB, and is not queued in the inbox.
    await expect(
      manager.handleGatewayRequest({
        sessionId: session.sessionId,
        kind: 'approve',
        payload: { toolName: 'Write', input: {} }
      })
    ).resolves.toMatchObject({ allowed: false })
    expect(manager.listApprovals()).toHaveLength(0)

    // If the Batcher (16 ms) was re-armed, it would flush to the closed DB here and leave a record.
    await sleep(60)
    expect(errors.mock.calls.map(([event]) => event)).not.toContain('thread.persist.failed')
    // After shutdown, the list is not delivered either (delivering it reads the DB).
    expect(threadLists.length).toBe(listsAtStop)
    errors.mockRestore()
  })

  it('Broker は shutdown の後に届いた要求を即座に system 拒否し、pending に残さない', async () => {
    const decided: string[] = []
    const broker = new ApprovalBroker(
      { onChanged: () => undefined, onDecided: (_item, result) => decided.push(result.by) },
      { autoAllowAll: false, autoAllowTools: [], bashDenyPatterns: [] }
    )
    broker.shutdown()
    const result = await broker.request({
      threadId: 't',
      threadTitle: 't',
      toolName: 'Write',
      summary: '',
      input: {}
    })
    expect(result).toEqual({
      allowed: false,
      by: 'system',
      message: 'approval-cancelled-quit',
      reply: { kind: 'cancelled', reason: 'quit' }
    })
    expect(broker.list()).toHaveLength(0)
    expect(decided).toEqual(['system'])
  })
})

describe('before-quit の手順 (TODO 566、src/main/shutdown.ts)', () => {
  it('stop() の 1 つが reject しても db.close() と quit が呼ばれる', async () => {
    const calls: string[] = []
    const quit = vi.fn(() => calls.push('quit'))
    const onTimeout = vi.fn()
    await shutdownWithin(
      [
        { name: 'sessions.stop', run: async () => calls.push('sessions') },
        {
          name: 'plugins.stop',
          run: async () => {
            throw new Error('boom')
          }
        },
        {
          name: 'indexClient.stop',
          run: () => {
            throw new Error('sync boom')
          }
        },
        { name: 'gateway.stop', run: async () => calls.push('gateway') },
        { name: 'db.close', run: () => calls.push('db.close') }
      ],
      { quit, onTimeout }
    )
    expect(calls).toEqual(['sessions', 'gateway', 'db.close', 'quit'])
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('全体の上限を過ぎたら onTimeout (app.exit(1)) に倒し、quit は呼ばない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const quit = vi.fn()
      const onTimeout = vi.fn()
      let release: () => void = () => undefined
      const hung = new Promise<void>((resolve) => {
        release = resolve
      })
      const done = shutdownWithin([{ name: 'jobScheduler.stop', run: () => hung }], {
        quit,
        onTimeout,
        timeoutMs: SHUTDOWN_TIMEOUT_MS
      })
      await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1)
      expect(onTimeout).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onTimeout).toHaveBeenCalledTimes(1)
      release()
      await done
      expect(quit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
