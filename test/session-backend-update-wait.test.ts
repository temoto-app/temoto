/**
 * Wave 37 code-review 4 (folded into TODO 787, owner decision 2026-10-13): while the backend is being updated, wait until the entry point that wakes the backend (`startLive`) finishes. The send looks the same as a reservation (the queue is mid-send), and a second one does not wake it.
 * Does not wake the CLI or the model (a fake Adapter). The harness was copied from `test/session-restore-no-send.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent } from '../src/shared/agent.js'
import type { ThreadSummary } from '../src/shared/thread.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import { runMigrations } from '../src/common/migrations.js'
import { SessionManager } from '../src/main/session/manager.js'
import type {
  AgentAdapter,
  AgentInput,
  AgentSession,
  RewindFilesResult,
  SpawnHandlers,
  SpawnOptions
} from '../src/main/session/types.js'
import type { ShellRunRequest } from '../src/main/session/shell-run.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'

class FakeSession implements AgentSession {
  readonly sent: AgentInput[] = []
  alive = true
  constructor(
    readonly sessionId: string,
    readonly threadId: string,
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
    this.alive = false
  }
  async rewindFiles(): Promise<RewindFilesResult | null> {
    return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }
  }
  /** The shape is the same as the `AiosEvent` that the real Adapter builds. The test passes only the kind and the contents. */
  emit(event: { kind: string; payload: unknown }): void {
    this.handlers.onEvent({
      id: `${this.sessionId}:${Math.random()}`,
      sessionId: this.sessionId,
      threadId: this.threadId,
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
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const session = new FakeSession(options.sessionId, options.threadId, handlers)
    this.sessions.push(session)
    return session
  })
  async listModels(): Promise<readonly { id: string; label: string }[]> {
    return [{ id: 'model-a', label: 'A' }]
  }
  readonly statusCalls = vi.fn()
  async getStatus(): Promise<AgentStatus> {
    this.statusCalls()
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
const managers: SessionManager[] = []
let shellRequests: ShellRunRequest[] = []

/** Distribution of the list from the most recently created SessionManager. */
let summaries: ThreadSummary[] = []

function build(adapter: FakeAdapter, options: { isBackendUpdating?: () => boolean } = {}): SessionManager {
  const home = '/Users/tester'
  const fs = {
    homePath: home,
    homeUri: `file://${home}`,
    defaultReferenceDirs: () => [`${home}/work`],
    isReferenceable: () => true,
    assertAllowed: (uri: string) => uri.replace('file://', '')
  } as unknown as FsAccess
  const index = {
    indexConversationEvents: () => undefined,
    removeThread: () => undefined,
    removeAllConversations: () => undefined
  } as unknown as IndexClient
  const gateway = {
    socketPath: '/tmp/aios-test-N.sock',
    issueToken: () => 'token',
    revokeToken: () => undefined
  } as unknown as GatewayServer
  const manager = new SessionManager({
    db,
    adapters: [adapter],
    fs,
    index,
    gateway,
    gatewayRuntimePath: '/bin/false',
    gatewayScriptPath: '/dev/null',
    gatewayConfigDir: '/tmp/aios-test-N-mcp',
    ...(options.isBackendUpdating === undefined ? {} : { isBackendUpdating: options.isBackendUpdating }),
    runShell: async (request) => {
      shellRequests.push(request)
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        status: 'ok',
        truncated: false,
        durationMs: 1,
        errorCode: null
      }
    },
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
  managers.push(manager)
  return manager
}


beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  shellRequests = []
})

afterEach(async () => {
  vi.useRealTimers()
  for (const manager of managers.splice(0)) await manager.stop()
  db.close()
})

describe('バックエンドの更新中は起こす口で待つ (code-review 4)', () => {
  it('更新中は起こさず、終われば 1 本だけ起こして送る。待つ間の送信は予約になる', async () => {
    vi.useFakeTimers()
    let updating = true
    const adapter = new FakeAdapter()
    const manager = build(adapter, { isBackendUpdating: () => updating })
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    const first = manager.send(thread.id, { text: '最初' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(adapter.spawn).not.toHaveBeenCalled()
    // A second message while waiting is mid-send, so it becomes a reservation.
    const second = await manager.send(thread.id, { text: '次' })
    expect(second.kind).toBe('queued')
    updating = false
    await vi.advanceTimersByTimeAsync(1_000)
    await first
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(adapter.sessions[0]?.sent.length).toBe(1)
  })

  it('更新中でなければ待たない', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter()
    const manager = build(adapter, { isBackendUpdating: () => false })
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    const sent = manager.send(thread.id, { text: 'すぐ' })
    await vi.advanceTimersByTimeAsync(100)
    await sent
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('終了処理が始まれば待ちを打ち切る (更新が終わらなくても manager.stop が止まらない)', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter()
    const manager = build(adapter, { isBackendUpdating: () => true })
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    const sent = manager.send(thread.id, { text: '待つ' }).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(1_000)
    const stopping = manager.stop()
    await vi.advanceTimersByTimeAsync(2_000)
    await stopping
    await sent
    expect(adapter.sessions.every((s) => !s.alive)).toBe(true)
  })

  it('TODO 1116: beginStop だけで待ちを抜け、起こさずに失敗する (stop() より前の jobScheduler.stop が返る)', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter()
    // The update does not finish. The order for ending is `beginStop` → (wait for the scheduled run that was about to wake) → `stop`.
    const manager = build(adapter, { isBackendUpdating: () => true })
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
    const sent = manager.send(thread.id, { text: '定時の回' }).then(
      () => {
        outcome = 'resolved'
      },
      () => {
        outcome = 'rejected'
      }
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(outcome).toBe('pending')
    manager.beginStop()
    await vi.advanceTimersByTimeAsync(2_000)
    await sent
    // The send returns a failure before `stop()` is called (a scheduled run can record `failed` here). The CLI is not woken.
    expect(outcome).toBe('rejected')
    expect(adapter.spawn).not.toHaveBeenCalled()
  })

  it('TODO 1116: beginStop の後の送信も CLI を起こさない (更新中でなくても)', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter()
    const manager = build(adapter, { isBackendUpdating: () => false })
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    manager.beginStop()
    const sent = manager.send(thread.id, { text: '終了の途中' }).then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await sent).toBe('rejected')
    expect(adapter.spawn).not.toHaveBeenCalled()
  })
})

describe('送信の前の状態の読み取りも更新中は待つ (TODO 800)', () => {
  it('更新中は getStatus を呼ばず、終われば読んで起こす', async () => {
    vi.useFakeTimers()
    let updating = true
    const adapter = new FakeAdapter()
    const manager = build(adapter, { isBackendUpdating: () => updating })
    await manager.start()
    await vi.advanceTimersByTimeAsync(100)
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    adapter.statusCalls.mockClear()
    const first = manager.send(thread.id, { text: '最初' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(adapter.statusCalls).not.toHaveBeenCalled()
    updating = false
    await vi.advanceTimersByTimeAsync(1_000)
    await first
    expect(adapter.statusCalls).toHaveBeenCalled()
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })
})
