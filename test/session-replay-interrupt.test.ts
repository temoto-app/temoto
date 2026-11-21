/**
 * An "echo without a record" (`user_replay`) that arrives right after an interruption or a stop is dropped to debug, not warn (a small observation from TODO 196, the 14th proxy verification).
 *
 * When interrupting, the CLI sometimes echoes the user line just before it, which this side did not send. In that case the absence of
 * `pendingReplay` in `SessionManager` (waiting for the echo of the message just sent) is not a bug but a side effect of the interruption. Only for the period after `interrupt()` is called is `session.replay.unmatched` dropped to debug; otherwise (not interrupted, or time has passed) it stays at warn as before.
 *
 * With a fake Adapter (the same minimal construction as `test/session-plan.test.ts`), so neither the CLI nor the model is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import { runMigrations } from '../src/common/migrations.js'
import { log } from '../src/common/logger.js'
import { SessionManager, type SessionManagerDeps } from '../src/main/session/manager.js'
import type {
  AgentAdapter,
  AgentInput,
  AgentSession,
  SpawnHandlers,
  SpawnOptions,
  WritePreview
} from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'

class FakeSession implements AgentSession {
  readonly sent: AgentInput[] = []
  alive = true
  interruptCalls = 0
  constructor(
    readonly sessionId: string,
    readonly handlers: SpawnHandlers
  ) {}
  send(input: AgentInput): void {
    this.sent.push(input)
  }
  async interrupt(): Promise<void> {
    this.interruptCalls += 1
  }
  abort(): void {}
  async stop(): Promise<void> {
    if (!this.alive) return
    this.alive = false
    this.handlers.onExit({ code: 0, signal: null, sawResult: true, requested: true })
  }
  async switchSettings(): Promise<boolean> {
    return true
  }
  async setPlanMode(): Promise<boolean> {
    return true
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
  supportsPlanMode(): boolean {
    return false
  }
  planProposal(): string | null {
    return null
  }
  writePreview(): WritePreview | null {
    return null
  }
}

let db: Db
let adapter: FakeAdapter
let manager: SessionManager
let dir: string

function build(): SessionManager {
  const fs = {
    homePath: dir,
    homeUri: `file://${dir}`,
    defaultReferenceDirs: () => [],
    isReferenceable: () => true,
    assertAllowed: (uri: string) => decodeURIComponent(uri.replace('file://', ''))
  } as unknown as FsAccess
  const index = {
    indexConversationEvents: () => undefined,
    removeThread: () => undefined,
    removeAllConversations: () => undefined
  } as unknown as IndexClient
  const gateway = {
    socketPath: '/tmp/aios-test-replay.sock',
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
    gatewayConfigDir: '/tmp/aios-test-replay-mcp',
    events: {
      onEvents: () => undefined,
      onThreadsChanged: () => undefined,
      onThreadChanged: () => undefined,
      onApprovalsChanged: () => undefined,
      onAgentStatus: () => undefined
    }
  }
  return new SessionManager(deps)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-replay-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
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
  text: null,
  interrupted: true
} as ResultPayload

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

describe('an echo with no record right after an interrupt (TODO 196)', () => {
  it('an echo with no record right after calling interrupt() falls to debug and is not warn', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'count to 400' })
    const session = adapter.sessions.at(-1)!
    // Lets the echo be processed first, using up `pendingReplay` (as in the real thing, one echo per message).
    session.emit({ threadId: thread.id, kind: 'user_replay', payload: { messageId: 'u-1', text: 'count to 400' } })
    await settle()

    const warnSpy = vi.spyOn(log, 'warn')
    const debugSpy = vi.spyOn(log, 'debug')

    await manager.interrupt(thread.id)
    // When the CLI interrupts, it echoes again the user line just before it that was already used up (= has no record).
    session.emit({ threadId: thread.id, kind: 'user_replay', payload: { messageId: 'u-1', text: 'count to 400' } })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()

    const unmatchedWarns = warnSpy.mock.calls.filter((call) => call[0] === 'session.replay.unmatched')
    const unmatchedDebugs = debugSpy.mock.calls.filter((call) => call[0] === 'session.replay.unmatched')
    expect(unmatchedWarns).toHaveLength(0)
    expect(unmatchedDebugs).toHaveLength(1)
  })

  it('an echo with no record when not interrupted stays warn as before', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hello' })
    const session = adapter.sessions.at(-1)!
    const warnSpy = vi.spyOn(log, 'warn')

    // No interruption was called, so an echo whose body does not match (= has no record) is suspicious as usual.
    session.emit({ threadId: thread.id, kind: 'user_replay', payload: { messageId: 'u-y', text: 'never sent' } })
    await settle()

    const unmatchedWarns = warnSpy.mock.calls.filter((call) => call[0] === 'session.replay.unmatched')
    expect(unmatchedWarns).toHaveLength(1)
  })

  it('an echo whose body matches is just mapped as usual regardless of any interrupt (neither warn nor debug)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'matched' })
    const session = adapter.sessions.at(-1)!
    const warnSpy = vi.spyOn(log, 'warn')
    const debugSpy = vi.spyOn(log, 'debug')

    session.emit({ threadId: thread.id, kind: 'user_replay', payload: { messageId: 'u-z', text: 'matched' } })
    await settle()

    const unmatchedWarns = warnSpy.mock.calls.filter((call) => call[0] === 'session.replay.unmatched')
    const unmatchedDebugs = debugSpy.mock.calls.filter((call) => call[0] === 'session.replay.unmatched')
    expect(unmatchedWarns).toHaveLength(0)
    expect(unmatchedDebugs).toHaveLength(0)
  })
})
