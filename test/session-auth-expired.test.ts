/**
 * TODO 893 (wave 47 bundle D): SessionManager after a turn where authentication expired.
 *
 * - With `result.authFailed`, the interruption mark becomes `interrupt-auth`; the login state is re-checked once and distributed to all windows.
 * - "Send again" (`resendLast`) sends the last sent input as it is. If a response is in progress or approval is pending, it is queued as a reservation
 *   (it does not write two items to stdin). If nothing has been sent yet in this launch, `resend-unavailable`.
 * - The conversation is not broken: the failure row remains, and the next send works in the same process.
 *
 * - TODO 1147: when the mark is set, the diagnostics bundle is taken once, and the re-check is done once 30 seconds later (fake timer). If it returns, the display recovers with the distribution; if not, it stays at the not-logged-in display. After a re-login, the display recovers only when the re-check (public subcommand) returns true.
 *
 * With a fake Adapter (the same minimal construction as `test/session-replay-interrupt.test.ts`), so neither the CLI nor the model is started.
 */
import { AUTH_RETRY_DELAY_MS } from '../src/main/session/auth-expiry.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import { runMigrations } from '../src/common/migrations.js'
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

function status(loggedIn: boolean): AgentStatus {
  const features = {} as Record<AgentFeature, boolean>
  for (const feature of AGENT_FEATURES) features[feature] = true
  return {
    available: true,
    version: '0.0.0',
    loggedIn,
    authMethod: null,
    subscriptionType: null,
    features,
    degradations: [],
    source: 'known-version',
    needsProbe: false,
    checkedAt: Date.now(),
    message: null,
    messageCode: loggedIn ? null : 'agent-not-logged-in'
  }
}

class FakeAdapter implements AgentAdapter {
  readonly id = 'fake'
  readonly label = 'Fake'
  readonly transcripts = null
  readonly sessions: FakeSession[] = []
  loggedIn = true
  readonly recheckLogin = vi.fn(async (): Promise<AgentStatus> => status(this.loggedIn))
  /** TODO 1147: the diagnostics bundle (its contents are the Adapter's job; here we only look at the trigger and the count). */
  readonly recordAuthDiagnostics = vi.fn<(trigger: string, context?: { threadId?: string | null }) => Promise<void>>(
    async () => undefined
  )
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> => {
    const session = new FakeSession(options.sessionId, handlers)
    this.sessions.push(session)
    return session
  })
  async listModels(): Promise<readonly { id: string; label: string }[]> {
    return []
  }
  async getStatus(): Promise<AgentStatus> {
    return status(true)
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
let statuses: AgentStatus[]

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
    socketPath: '/tmp/aios-test-auth.sock',
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
    gatewayConfigDir: '/tmp/aios-test-auth-mcp',
    events: {
      onEvents: () => undefined,
      onThreadsChanged: () => undefined,
      onThreadChanged: () => undefined,
      onApprovalsChanged: () => undefined,
      onAgentStatus: (next) => statuses.push(next)
    }
  }
  return new SessionManager(deps)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-auth-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  statuses = []
  manager = build()
})

afterEach(async () => {
  await manager.stop()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const AUTH_FAILED: ResultPayload = {
  ok: false,
  subtype: 'success',
  turns: 1,
  durationMs: 1,
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  stopReason: null,
  denials: [],
  text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  authFailed: true
} as ResultPayload
const OK: ResultPayload = {
  ...AUTH_FAILED,
  ok: true,
  text: 'done',
  authFailed: undefined,
  // TODO 1184: a successful result that clears the mark is one that called the model (usage is positive).
  usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }
} as ResultPayload

const interruptedOf = (threadId: string): string | undefined =>
  manager.listSummaries().find((summary) => summary.thread.id === threadId)?.thread.interrupted
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))
const textsOf = (session: FakeSession): string[] =>
  session.sent.map((input) => (input as { text?: string }).text ?? '')

describe('SessionManager after authentication expires (TODO 893)', () => {
  it('the marker is interrupt-auth, re-checks the login state and broadcasts. Sending again delivers the same input to the same process', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'refactor the parser' })
    const session = adapter.sessions.at(-1)!
    adapter.loggedIn = false
    session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: AUTH_FAILED.text ?? '' } })
    session.emit({ threadId: thread.id, kind: 'result', payload: AUTH_FAILED })
    await settle()

    expect(interruptedOf(thread.id)).toBe('interrupt-auth')
    expect(adapter.recheckLogin).toHaveBeenCalledTimes(1)
    expect(statuses.at(-1)?.loggedIn).toBe(false)

    // Logged in again (the fake public subcommand returns logged in).
    adapter.loggedIn = true
    expect((await manager.recheckLogin()).loggedIn).toBe(true)
    expect(statuses.at(-1)?.loggedIn).toBe(true)

    const outcome = await manager.resendLast(thread.id)
    expect(outcome.kind).toBe('sent')
    expect(adapter.sessions).toHaveLength(1)
    expect(textsOf(session)).toEqual(['refactor the parser', 'refactor the parser'])

    // If the next turn finishes normally, the mark disappears (the conversation continues).
    session.emit({ threadId: thread.id, kind: 'result', payload: OK })
    await settle()
    expect(interruptedOf(thread.id)).toBeUndefined()
  })

  it('concurrent re-checks are merged into one (one Adapter call, one broadcast to all windows - code-review)', async () => {
    const before = statuses.length
    const results = await Promise.all([manager.recheckLogin(), manager.recheckLogin(), manager.recheckLogin()])
    expect(adapter.recheckLogin).toHaveBeenCalledTimes(1)
    expect(statuses.length - before).toBe(1)
    expect(new Set(results).size).toBe(1)
    // A call after it finishes still arrives (thinning out repeated calls is the Adapter's job).
    await manager.recheckLogin()
    expect(adapter.recheckLogin).toHaveBeenCalledTimes(2)
  })

  it('sending again while responding queues a reservation (does not write 2 messages to stdin)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'first' })
    const session = adapter.sessions.at(-1)!
    // result has not arrived yet = a response is in progress.
    const outcome = await manager.resendLast(thread.id)
    expect(outcome.kind).toBe('queued')
    expect(textsOf(session)).toEqual(['first'])
    session.emit({ threadId: thread.id, kind: 'result', payload: OK })
    await settle()
    expect(textsOf(session)).toEqual(['first', 'first'])
  })

  it('rejects with resend-unavailable if nothing has been sent yet in this launch', async () => {
    const thread = await manager.createThread({})
    await expect(manager.resendLast(thread.id)).rejects.toThrow(/resend-unavailable/)
  })
})

describe('auth-expired diagnostic bundle and re-check after 30 seconds (TODO 1147)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const triggers = (): unknown[] => adapter.recordAuthDiagnostics.mock.calls.map((call) => call[0])

  async function expire(): Promise<{ threadId: string }> {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'refactor the parser' })
    const session = adapter.sessions.at(-1)!
    adapter.loggedIn = false
    session.emit({ threadId: thread.id, kind: 'result', payload: AUTH_FAILED })
    await vi.advanceTimersByTimeAsync(0)
    return { threadId: thread.id }
  }

  it('one bundle when the marker is set (after the re-check). Re-checks once after 30 seconds, and stays logged out if it does not recover', async () => {
    const { threadId } = await expire()
    expect(interruptedOf(threadId)).toBe('interrupt-auth')
    expect(adapter.recheckLogin).toHaveBeenCalledTimes(1)
    expect(triggers()).toEqual(['interrupt-auth'])
    expect(adapter.recordAuthDiagnostics.mock.calls[0]?.[1]).toEqual({ threadId })
    expect(statuses.at(-1)?.loggedIn).toBe(false)

    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
    expect(adapter.recheckLogin).toHaveBeenCalledTimes(2)
    expect(triggers()).toEqual(['interrupt-auth', 'retry-failed'])
    expect(statuses.at(-1)?.loggedIn).toBe(false)
    // Only once.
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS * 4)
    expect(adapter.recheckLogin).toHaveBeenCalledTimes(2)

    // Logged in again (on the Terminal side). The display does not recover until the re-check returns true.
    adapter.loggedIn = true
    expect(statuses.at(-1)?.loggedIn).toBe(false)
    expect((await manager.recheckLogin()).loggedIn).toBe(true)
    expect(statuses.at(-1)?.loggedIn).toBe(true)
    expect(triggers()).toEqual(['interrupt-auth', 'retry-failed', 'login-restored'])
  })

  it('on a transient failure the re-check after 30 seconds recovers and the display returns (does not write retry-failed)', async () => {
    await expire()
    adapter.loggedIn = true
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
    expect(adapter.recheckLogin).toHaveBeenCalledTimes(2)
    expect(statuses.at(-1)?.loggedIn).toBe(true)
    expect(triggers()).toEqual(['interrupt-auth', 'login-restored'])
  })

  it('does not retry after it exits', async () => {
    await expire()
    await manager.stop()
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS * 2)
    expect(adapter.recheckLogin).toHaveBeenCalledTimes(1)
  })
})
