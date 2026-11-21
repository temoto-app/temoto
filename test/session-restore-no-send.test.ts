/**
 * Item 186 (2026-09-27): regression of "33 seconds after launch, the last message of a restored thread was re-sent by itself".
 *
 * The investigation found no path by which the app itself sent it (the macOS unified log still held 45 real trackpad clicks and key inputs that reached the duplicated window of the proxy verification; see the "response" of TODO 186). What is pinned here:
 *
 * - Restarting (creating a SessionManager anew on the same DB), opening a thread, reading the timeline, marking it as read, and closing a window: **no process is woken and nothing is sent** (reservations are only in memory, and do not cross a restart).
 * - With `agentDisabled` (the environment variable `AIOS_DISABLE_AGENT=1`, used in the duplicate for proxy verification), a send, a reservation, `!`, and a rewind confirmation are all refused with `agent-disabled`, and nothing is recorded.
 *
 * Neither the CLI nor the model is woken (a fake Adapter). The harness was copied from `test/session-shell.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload } from '../src/shared/agent.js'
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
const managers: SessionManager[] = []
let shellRequests: ShellRunRequest[] = []
/** Distribution of the list from the most recently created SessionManager. */
let summaries: ThreadSummary[] = []

function build(adapter: FakeAdapter, options: { agentDisabled?: boolean } = {}): SessionManager {
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
    ...(options.agentDisabled === true ? { agentDisabled: true } : {}),
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

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The first launch: creates a thread, sends one message, and finishes the response (the identifier is attached through the echo).
 * It ends with one reservation during a response still in place, to check that reservations do not cross a restart.
 */
async function firstRun(): Promise<{ threadId: string; userEventId: string }> {
  const adapter = new FakeAdapter()
  const manager = build(adapter)
  await manager.start()
  const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
  await manager.send(thread.id, { text: 'push まで進めて' })
  const session = adapter.sessions.at(-1)!
  session.emit({ kind: 'session_started', payload: { backendSessionId: 'backend-1', model: 'model-a' } })
  session.emit({ kind: 'user_replay', payload: { messageId: 'msg-1', text: 'push まで進めて' } })
  session.emit({ kind: 'result', payload: RESULT })
  await settle()
  // Queues a reservation during a response, and then ends as it is.
  await manager.send(thread.id, { text: '次の発言' })
  const queued = await manager.send(thread.id, { text: '予約した発言' })
  expect(queued.kind).toBe('queued')
  await manager.stop()
  const events = (await build(new FakeAdapter()).timeline(thread.id)).events
  const user = events.find((e) => e.kind === 'user_text' && e.payload.text === 'push まで進めて')
  if (user === undefined) throw new Error('user_text not recorded')
  return { threadId: thread.id, userEventId: user.id }
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  shellRequests = []
})

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop()
  db.close()
})

describe('再起動と復元だけでは送らない (項目 186)', () => {
  it('開く・読む・既読・窓を閉じる、を経てもプロセスを起こさず何も送らない', async () => {
    const { threadId } = await firstRun()
    const adapter = new FakeAdapter()
    const manager = build(adapter)
    await manager.start()
    // The call that comes to main on the path of window restore (item 36) → the renderer's init → selectThread.
    manager.openThread(threadId, 1)
    await manager.timeline(threadId)
    manager.focusView(1)
    manager.closeView(1)
    manager.openThread(threadId, 2)
    await settle(80)
    expect(adapter.spawn).not.toHaveBeenCalled()
    // Reservations are only in memory (item 94): the ones queued in the previous launch are gone.
    const summary = summaries.find((s) => s.thread.id === threadId)
    expect(summary).toBeDefined()
    expect(summary?.runtime.reservations ?? []).toEqual([])
    expect(summary?.runtime.state).not.toBe('running')
  })
})

describe('agentDisabled (AIOS_DISABLE_AGENT=1、項目 186)', () => {
  it('送信・予約は agent-disabled で断り、起こさず、発言も記録しない', async () => {
    const { threadId } = await firstRun()
    const adapter = new FakeAdapter()
    const manager = build(adapter, { agentDisabled: true })
    await manager.start()
    const before = (await manager.timeline(threadId)).events.length
    await expect(manager.send(threadId, { text: 'push まで進めて' })).rejects.toThrow(
      'aios-reason:agent-disabled'
    )
    await expect(manager.sendInterrupt(threadId, { text: 'push まで進めて' })).rejects.toThrow(
      'aios-reason:agent-disabled'
    )
    await settle()
    expect(adapter.spawn).not.toHaveBeenCalled()
    expect((await manager.timeline(threadId)).events.length).toBe(before)
  })

  it('`!` も走らせない', async () => {
    const { threadId } = await firstRun()
    const manager = build(new FakeAdapter(), { agentDisabled: true })
    await expect(manager.send(threadId, { text: '!ls', shell: true })).rejects.toThrow(
      'aios-reason:agent-disabled'
    )
    expect(shellRequests).toEqual([])
  })

  it('巻き戻しの確認 (プロセスを再開で起こす経路) も起こさない', async () => {
    const { threadId, userEventId } = await firstRun()
    const adapter = new FakeAdapter()
    const manager = build(adapter, { agentDisabled: true })
    await expect(manager.rewindPreview(threadId, userEventId)).rejects.toThrow('aios-reason:agent-disabled')
    expect(adapter.spawn).not.toHaveBeenCalled()
  })

  it('無効でなければ同じ巻き戻しの確認は再開で起こす (上の検査が空振りしていない対照)', async () => {
    const { threadId, userEventId } = await firstRun()
    const adapter = new FakeAdapter()
    const manager = build(adapter)
    const preview = await manager.rewindPreview(threadId, userEventId)
    expect(preview.canRewind).toBe(true)
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })
})
