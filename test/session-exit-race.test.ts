/**
 * The race between a process being stopped and the next send (`Live.retiring` / `onAgentExit` of SessionManager).
 *
 * The real `LiveSession` keeps `alive` true after `stop()` / `abort()` until `close` arrives,
 * and `stop()` may return without waiting for `close` after SIGKILL's 3 seconds. Previously:
 *
 * - Sending right after eviction (`sweepIdle`) wrote through a closed stdin to the old process that was still `alive`,
 *   and the message was silently dropped (it appeared on the timeline but never reached the CLI).
 * - A late exit of the old process, looked up by thread id in `live`, removed the registration, token and "in response" state of the **new** process.
 *
 * The fake session here does **not** send the end notification right away on `stop()` / `abort()` (it stays `alive` until `close()`
 * is called by hand). Neither the CLI nor the model is woken.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import type { ThreadSummary } from '../src/shared/thread.js'
import { runMigrations } from '../src/common/migrations.js'
import { SessionManager } from '../src/main/session/manager.js'
import type {
  AgentAdapter,
  AgentInput,
  AgentSession,
  SpawnHandlers,
  SpawnOptions
} from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'

class SlowExitSession implements AgentSession {
  readonly sent: AgentInput[] = []
  alive = true
  stops = 0
  constructor(
    readonly sessionId: string,
    readonly handlers: SpawnHandlers
  ) {}
  send(input: AgentInput): void {
    this.sent.push(input)
  }
  async interrupt(): Promise<void> {}
  abort(): void {}
  /** Returns without waiting for `close`, as with the real SIGKILL timeout. */
  async stop(): Promise<void> {
    this.stops += 1
  }
  /** The process's `close` has arrived. */
  close(): void {
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

class FakeAdapter implements AgentAdapter {
  readonly id = 'fake'
  readonly label = 'Fake'
  readonly transcripts = null
  readonly sessions: SlowExitSession[] = []
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers) => {
    const session = new SlowExitSession(options.sessionId, handlers)
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
let summaries: ThreadSummary[] = []
let revoked: string[] = []

function runtimeOf(threadId: string): ThreadSummary['runtime'] {
  const found = summaries.find((s) => s.thread.id === threadId)
  if (found === undefined) throw new Error('thread not in summaries')
  return found.runtime
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  summaries = []
  revoked = []
  let tokens = 0
  const home = '/Users/tester'
  manager = new SessionManager({
    db,
    adapters: [adapter],
    fs: {
      homePath: home,
      homeUri: `file://${home}`,
      defaultReferenceDirs: () => [`${home}/work`],
      isReferenceable: () => true,
      assertAllowed: (uri: string) => uri.replace('file://', '')
    } as unknown as FsAccess,
    index: {
      indexConversationEvents: () => undefined,
      removeThread: () => undefined,
      removeAllConversations: () => undefined,
      scanSubtree: () => undefined
    } as unknown as IndexClient,
    gateway: {
      socketPath: '/tmp/aios-test-exit-race.sock',
      issueToken: () => `token-${(tokens += 1)}`,
      revokeToken: (token: string) => {
        revoked.push(token)
      }
    } as unknown as GatewayServer,
    gatewayRuntimePath: '/bin/false',
    gatewayScriptPath: '/dev/null',
    gatewayConfigDir: '/tmp/aios-test-exit-race-mcp',
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
})

afterEach(async () => {
  for (const session of adapter.sessions) session.close()
  await manager.stop()
  db.close()
})

/** A thread where one turn was sent and finished, and is now `idle`. */
async function idleThread(): Promise<{ threadId: string; first: SlowExitSession }> {
  const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/work' })
  await manager.send(thread.id, { text: '1 つ目' })
  const first = adapter.sessions[0]
  if (first === undefined) throw new Error('not spawned')
  first.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
  return { threadId: thread.id, first }
}

describe('a process being stopped and the next send', () => {
  it('a send during the stop does not write to the old process, waits for it to end and wakes again', async () => {
    const { threadId, first } = await idleThread()
    // Eviction (the same path as sweepIdle). `close` has not arrived yet.
    void manager.stopThread(threadId)
    expect(first.alive).toBe(true)

    const sending = manager.send(threadId, { text: '2 つ目' })
    // The old process ends while waiting.
    await new Promise((resolve) => setTimeout(resolve, 5))
    first.close()
    await sending

    expect(first.sent.map((input) => input.text)).toEqual(['1 つ目'])
    const second = adapter.sessions[1]
    expect(second?.sent.map((input) => input.text)).toEqual(['2 つ目'])
    expect(runtimeOf(threadId).live).toBe(true)
    expect(runtimeOf(threadId).state).toBe('running')
  })

  it("a late exit of an old process does not remove the new process's registration", async () => {
    const { threadId, first } = await idleThread()
    void manager.stopThread(threadId)
    const sending = manager.send(threadId, { text: '2 つ目' })
    // A shape where `close` does not arrive even after the wait limit has passed (only the registration is removed, and the next one is woken).
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await vi.advanceTimersByTimeAsync(6_000)
    } finally {
      vi.useRealTimers()
    }
    await sending
    const second = adapter.sessions[1]
    expect(second?.sent.map((input) => input.text)).toEqual(['2 つ目'])

    // Here the old `close` finally arrives.
    first.close()
    expect(runtimeOf(threadId).live).toBe(true)
    expect(runtimeOf(threadId).state).toBe('running')
    // The "in response" state of the new turn remains: the next send becomes a reservation.
    const outcome = await manager.send(threadId, { text: '3 つ目' })
    expect(outcome.kind).toBe('queued')
    // A row (`result`) from the old process also does not bring down the new turn.
    first.emit({ threadId, kind: 'result', payload: RESULT })
    expect(runtimeOf(threadId).state).toBe('running')
    // The newer token is not revoked (only the older one's).
    expect(revoked).not.toContain('token-2')
  })
})
