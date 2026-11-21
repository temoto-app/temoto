/**
 * Replacing the command list while running (the rest of item 117, `system/commands_changed` of `/reload-plugins`),
 * and the SessionManager side of the hook line in settings (item 126-3) (wave 13 bundle E).
 *
 * - Replacing overwrites the **same cache** as the `session_started` list (`backendCommands`, per backend, item 68), and takes effect on the list that `backends()` returns (the `/` completion for new threads). The thread's own list is looked up by the renderer from the saved `commands_changed` (`lastCommands`).
 * - A hook line is saved but not passed to the conversation index.
 *
 * Does not wake the CLI or the model (`FakeSession.emit` pushes events by hand). The harness is separate from `test/session-manager.test.ts` (so as not to touch the same file as a bundle running in parallel, the lesson of item 112).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
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
    this.alive = false
  }
  emit(event: Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'> & { actor?: 'main' | 'subagent' }): void {
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
  /** The Adapter's cache (the list just after launch, while there is no session yet). */
  known: readonly string[] | null = ['compact']
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const session = new FakeSession(options.sessionId, handlers)
    this.sessions.push(session)
    return session
  })
  async listModels(): Promise<readonly { id: string; label: string }[]> {
    return [{ id: 'model-a', label: 'A' }]
  }
  knownCommands(): readonly string[] | null {
    return this.known
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
let indexed: { id: string }[] = []
let delivered: AiosEvent[] = []

function build(): void {
  adapter = new FakeAdapter()
  indexed = []
  delivered = []
  const home = '/Users/tester'
  const fs = {
    homePath: home,
    homeUri: `file://${home}`,
    defaultReferenceDirs: () => [`${home}/work`],
    isReferenceable: () => true,
    assertAllowed: (uri: string) => uri.replace('file://', '')
  } as unknown as FsAccess
  const index = {
    indexConversationEvents: (list: readonly { id: string }[]) => {
      indexed.push(...list)
    },
    removeThread: () => undefined,
    removeAllConversations: () => undefined
  } as unknown as IndexClient
  const gateway = {
    socketPath: '/tmp/aios-test-commands-changed.sock',
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
    gatewayConfigDir: '/tmp/aios-test-commands-changed-mcp',
    events: {
      onEvents: (batch) => {
        delivered.push(...batch.events)
      },
      onThreadsChanged: () => undefined,
      onThreadChanged: () => undefined,
      onApprovalsChanged: () => undefined,
      onAgentStatus: () => undefined
    }
  })
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  build()
})

afterEach(async () => {
  await manager.stop()
  db.close()
})

/** A thread that has been sent to once. */
async function sentThread(): Promise<{ threadId: string; session: FakeSession }> {
  const thread = await manager.createThread({})
  await manager.send(thread.id, { text: 'hello' })
  const session = adapter.sessions.at(-1)
  if (session === undefined) throw new Error('no session')
  return { threadId: thread.id, session }
}

/** Waits for the 16 ms Batcher to flush and save. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

function sessionStarted(threadId: string, commands: readonly string[]): Parameters<FakeSession['emit']>[0] {
  return {
    threadId,
    kind: 'session_started',
    payload: {
      backendSessionId: 'backend-1',
      backendVersion: '0.0.0',
      model: null,
      cwd: null,
      reportedPermissionMode: null,
      tools: [],
      toolServers: [],
      resumed: false,
      commands
    }
  }
}

async function commandsOf(): Promise<readonly string[] | null | undefined> {
  return (await manager.backends()).find((b) => b.id === 'fake')?.commands
}

describe('SessionManager - replacing the command list (the remainder of item 117, wave 13 bundle E)', () => {
  it('commands_changed replaces the same record as session_started and affects the backends() list', async () => {
    expect(await commandsOf()).toEqual(['compact'])
    const { threadId, session } = await sentThread()
    session.emit(sessionStarted(threadId, ['compact', 'cost']))
    expect(await commandsOf()).toEqual(['compact', 'cost'])

    session.emit({ threadId, kind: 'commands_changed', payload: { commands: ['compact', 'cost', 'new-skill'] } })
    expect(await commandsOf()).toEqual(['compact', 'cost', 'new-skill'])
  })

  it('is saved and also reaches the renderer (used by / completion in a reopened thread)', async () => {
    const { threadId, session } = await sentThread()
    session.emit(sessionStarted(threadId, ['compact']))
    session.emit({ threadId, kind: 'commands_changed', payload: { commands: ['compact', 'x'] } })
    await settle()
    expect(delivered.some((e) => e.kind === 'commands_changed')).toBe(true)
    const stored = (await manager.timeline(threadId)).events.find((e) => e.kind === 'commands_changed')
    expect(stored?.kind === 'commands_changed' && stored.payload.commands).toEqual(['compact', 'x'])
    // A list of names is not the body. It is not passed to the conversation index.
    expect(indexed.map((e) => e.id)).not.toContain(stored?.id)
  })

  it('a replacement from a sub-agent (with parentToolUseId) does not change the record', async () => {
    const { threadId, session } = await sentThread()
    session.emit(sessionStarted(threadId, ['compact']))
    session.emit({
      threadId,
      kind: 'commands_changed',
      actor: 'subagent',
      payload: { commands: ['child-only'] }
    })
    expect(await commandsOf()).toEqual(['compact'])
  })
})

describe('SessionManager - settings hook rows (item 126-3, wave 13 bundle E)', () => {
  it('a hook row is saved and delivered but not passed to the conversation index. The state (responding) does not change either', async () => {
    const { threadId, session } = await sentThread()
    session.emit({
      threadId,
      kind: 'hook_run',
      payload: {
        hookId: 'h1',
        hookName: 'SessionStart:startup',
        hookEvent: 'SessionStart',
        outcome: 'success',
        exitCode: 0
      }
    })
    await settle()
    const stored = (await manager.timeline(threadId)).events.find((e) => e.kind === 'hook_run')
    expect(stored?.kind === 'hook_run' && stored.payload).toEqual({
      hookId: 'h1',
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      outcome: 'success',
      exitCode: 0
    })
    expect(delivered.some((e) => e.kind === 'hook_run')).toBe(true)
    // Only the message sent (user_text) goes to the index.
    expect(indexed).toHaveLength(1)
    expect(indexed.map((e) => e.id)).not.toContain(stored?.id)
  })
})
