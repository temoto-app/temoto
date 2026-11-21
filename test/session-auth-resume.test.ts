/**
 * TODO 1282 (wave 95 bundle A): what SessionManager tells the login recovery when a thread stops on the login.
 *
 * The decision "may the last input be resent automatically" comes from main's own record of the stopped turn (the send queue's
 * flags, set from the events) - never from the renderer: a turn that had started a tool (the parent's or a subagent's) is held,
 * an auth failure in a turn the CLI started by itself after the sent turn had ended is `unavailable`, and an ordinary one is
 * safe. The Adapter's kind (`credential`) turns the login off. The end-to-end resend goes through the real `resendLast`.
 *
 * With a fake Adapter (the same minimal construction as `test/session-auth-expired.test.ts`), so neither the CLI nor the model is started.
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
import { SessionManager, type SessionManagerDeps } from '../src/main/session/manager.js'
import { LoginRecovery, type ExpiryInfo } from '../src/main/session/login-recovery.js'
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
  emit(event: Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'> & { actor?: AiosEvent['actor'] }): void {
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
  readonly recordAuthDiagnostics = vi.fn(async () => undefined)
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> => {
    const session = new FakeSession(options.sessionId, handlers)
    this.sessions.push(session)
    return session
  })
  unattendedLoginGuide(): { setupCommand: string; tokenEnv: string } {
    return { setupCommand: 'tool setup-token', tokenEnv: 'TOOL_TOKEN' }
  }
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
let expired: Array<{ threadId: string; info: ExpiryInfo }>

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
    socketPath: '/tmp/aios-test-auth-resume.sock',
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
    gatewayConfigDir: '/tmp/aios-test-auth-resume-mcp',
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
  dir = mkdtempSync(join(tmpdir(), 'aios-auth-resume-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  expired = []
  manager = build()
  manager.setAuthRecovery({
    expired: (threadId, info) => expired.push({ threadId, info }),
    cleared: () => undefined,
    stop: () => undefined
  })
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
  text: 'Failed to authenticate: this login reached its time limit and cannot be renewed.',
  authFailed: true,
  authFailureKind: 'login'
} as ResultPayload
const OK: ResultPayload = {
  ...AUTH_FAILED,
  ok: true,
  text: 'done',
  authFailed: undefined,
  authFailureKind: undefined,
  usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }
} as ResultPayload

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))
const toolUse = (id: string): AiosEvent['payload'] =>
  ({ toolUseId: id, name: 'Bash', input: { command: 'touch x' }, summary: 'touch x', truncated: false }) as AiosEvent['payload']
const textsOf = (session: FakeSession): string[] => session.sent.map((input) => (input as { text?: string }).text ?? '')

describe('SessionManager: the stopped turn as main recorded it (TODO 1282)', () => {
  it('no tool had started: may be resent automatically; a fresh login fixes it', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'summarize the notes' })
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId: thread.id, kind: 'result', payload: AUTH_FAILED })
    await settle()
    expect(expired).toEqual([{ threadId: thread.id, info: { relogin: true, hold: null, unattended: false } }])
    expect(manager.authExpiryInfo(thread.id)).toEqual({ relogin: true, hold: null, unattended: false })
  })

  it('a tool had started (by the parent): held as tool-started', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'make the file' })
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId: thread.id, kind: 'tool_use', payload: toolUse('t1') })
    session.emit({ threadId: thread.id, kind: 'result', payload: AUTH_FAILED })
    await settle()
    expect(expired.at(-1)?.info.hold).toBe('tool-started')
  })

  it("a subagent's tool counts too", async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'delegate it' })
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId: thread.id, kind: 'tool_use', payload: toolUse('t2'), actor: 'subagent', parentToolUseId: 'p1' } as never)
    session.emit({ threadId: thread.id, kind: 'result', payload: AUTH_FAILED })
    await settle()
    expect(expired.at(-1)?.info.hold).toBe('tool-started')
  })

  it('an auth failure in a turn after the sent turn had ended: unavailable (the kept input belongs to the earlier turn)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'first' })
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId: thread.id, kind: 'result', payload: OK })
    await settle()
    // The CLI starts a turn by itself (item 93) and it stops on the login.
    session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: 'continuing' } } as never)
    session.emit({ threadId: thread.id, kind: 'result', payload: AUTH_FAILED })
    await settle()
    expect(expired.at(-1)?.info.hold).toBe('unavailable')
  })

  it('a new input resets the record: the next turn without tools is safe again', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'one' })
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId: thread.id, kind: 'tool_use', payload: toolUse('t3') })
    session.emit({ threadId: thread.id, kind: 'result', payload: OK })
    await settle()
    await manager.send(thread.id, { text: 'two' })
    session.emit({ threadId: thread.id, kind: 'result', payload: AUTH_FAILED })
    await settle()
    expect(expired.at(-1)?.info.hold).toBeNull()
  })

  it('the credential kind turns the login off (relogin: false)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hello' })
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId: thread.id, kind: 'result', payload: { ...AUTH_FAILED, authFailureKind: 'credential' } })
    await settle()
    expect(expired.at(-1)?.info.relogin).toBe(false)
  })

  it('a new auth failure on a thread that still had the mark is reported again', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'again' })
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId: thread.id, kind: 'result', payload: AUTH_FAILED })
    await settle()
    await manager.resendLast(thread.id)
    session.emit({ threadId: thread.id, kind: 'result', payload: AUTH_FAILED })
    await settle()
    expect(expired.map((entry) => entry.threadId)).toEqual([thread.id, thread.id])
  })

  it('hasThread / unattendedLoginGuide are main-side checks only', async () => {
    const thread = await manager.createThread({})
    expect(manager.hasThread(thread.id)).toBe(true)
    expect(manager.hasThread('not-a-thread')).toBe(false)
    expect(manager.unattendedLoginGuide()).toEqual({ setupCommand: 'tool setup-token', tokenEnv: 'TOOL_TOKEN' })
  })
})

describe('SessionManager + LoginRecovery end to end (TODO 1282)', () => {
  it('after the login is confirmed, the safe thread gets the same input once; the tool thread does not', async () => {
    let loggedIn = false
    const timers: Array<() => void> = []
    const recovery = new LoginRecovery({
      openLogin: async () => ({ opened: true }),
      isLoggedIn: async () => loggedIn,
      stillExpired: (threadId) => manager.isAuthInterrupted(threadId),
      resend: (threadId) => manager.resendLast(threadId),
      autoOpen: () => false,
      describe: (threadId) => manager.authExpiryInfo(threadId),
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => undefined
    })
    manager.setAuthRecovery({
      expired: (threadId, info) => recovery.noteExpired(threadId, info),
      cleared: (threadId) => recovery.noteCleared(threadId),
      stop: () => recovery.stop()
    })
    const safe = await manager.createThread({})
    const tools = await manager.createThread({})
    await manager.send(safe.id, { text: 'plain question' })
    await manager.send(tools.id, { text: 'edit the file' })
    const [safeSession, toolSession] = adapter.sessions.slice(-2) as [FakeSession, FakeSession]
    safeSession.emit({ threadId: safe.id, kind: 'result', payload: AUTH_FAILED })
    toolSession.emit({ threadId: tools.id, kind: 'tool_use', payload: toolUse('t9') })
    toolSession.emit({ threadId: tools.id, kind: 'result', payload: AUTH_FAILED })
    await settle()

    expect(await recovery.start(safe.id)).toEqual({ opened: true })
    loggedIn = true
    timers.shift()?.()
    await settle()

    expect(textsOf(safeSession)).toEqual(['plain question', 'plain question'])
    expect(textsOf(toolSession)).toEqual(['edit the file'])
    expect(recovery.state()).toMatchObject({
      phase: 'recovered',
      resent: [safe.id],
      held: [{ threadId: tools.id, why: 'tool-started' }]
    })
  })

  it('review: after a cancel, another Log in from one thread covers the other expired thread again (from main\'s record)', async () => {
    let loggedIn = false
    const timers: Array<() => void> = []
    const recovery = new LoginRecovery({
      openLogin: async () => ({ opened: true }),
      isLoggedIn: async () => loggedIn,
      stillExpired: (threadId) => manager.isAuthInterrupted(threadId),
      resend: (threadId) => manager.resendLast(threadId),
      autoOpen: () => false,
      describe: (threadId) => manager.authExpiryInfo(threadId),
      expiredThreads: () => manager.authExpiredThreads(),
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => undefined
    })
    manager.setAuthRecovery({
      expired: (threadId, info) => recovery.noteExpired(threadId, info),
      cleared: (threadId) => recovery.noteCleared(threadId),
      stop: () => recovery.stop()
    })
    const a = await manager.createThread({})
    const b = await manager.createThread({})
    const idle = await manager.createThread({})
    await manager.send(a.id, { text: 'question a' })
    await manager.send(b.id, { text: 'question b' })
    const [aSession, bSession] = adapter.sessions.slice(-2) as [FakeSession, FakeSession]
    aSession.emit({ threadId: a.id, kind: 'result', payload: AUTH_FAILED })
    bSession.emit({ threadId: b.id, kind: 'result', payload: AUTH_FAILED })
    await settle()
    expect(manager.authExpiredThreads().sort()).toEqual([a.id, b.id].sort())
    expect(manager.authExpiredThreads()).not.toContain(idle.id)

    await recovery.start(a.id)
    expect(recovery.cancel()).toBe(true)
    await recovery.start(a.id)
    expect(recovery.state().waiting.map((entry) => entry.threadId).sort()).toEqual([a.id, b.id].sort())
    loggedIn = true
    timers.shift()?.()
    await settle()
    expect(textsOf(aSession)).toEqual(['question a', 'question a'])
    expect(textsOf(bSession)).toEqual(['question b', 'question b'])
  })
})
