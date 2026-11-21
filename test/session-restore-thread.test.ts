/**
 * Regression test: an item removed with the ✕ in the SideBar can be restored from the main side (item 191, 2026-09-28, wave 14 bundle G).
 *
 * `test/session-manager.test.ts` is over 2,600 lines and parallel bundles often touch it, so, following the other bundles of the same wave (`test/session-shell.test.ts` / `test/session-restore-no-send.test.ts`), this uses a separate file with a minimal copied fake. No CLI or model is started (fake Adapter).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload } from '../src/shared/agent.js'
import type { ThreadSummary } from '../src/shared/thread.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import { runMigrations } from '../src/common/migrations.js'
import { SessionManager } from '../src/main/session/manager.js'
import { ThreadStore } from '../src/main/session/store.js'
import type {
  AgentAdapter,
  AgentSession,
  RewindFilesResult,
  SpawnHandlers,
  SpawnOptions
} from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'

class FakeSession implements AgentSession {
  alive = true
  constructor(
    readonly sessionId: string,
    readonly threadId: string,
    readonly handlers: SpawnHandlers
  ) {}
  send(): void {}
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
  async locateInstructionFiles(): Promise<readonly never[]> {
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
const managers: SessionManager[] = []
let summaries: ThreadSummary[] = []
/** Records the arguments of `IndexClient.indexConversationEvents` (for checking re-indexing on restore). */
let indexedConversationEvents: { id: string; threadId: string; title: string; ts: number }[][] = []
/** Records the full list each time `onDeletedThreadsChanged` (item 222) is called. */
let deletedPushes: { id: string }[][] = []

function build(adapter: FakeAdapter): SessionManager {
  const home = '/Users/tester'
  const fs = {
    homePath: home,
    homeUri: `file://${home}`,
    defaultReferenceDirs: () => [`${home}/work`],
    isReferenceable: () => true,
    assertAllowed: (uri: string) => uri.replace('file://', '')
  } as unknown as FsAccess
  const index = {
    indexConversationEvents: (events: { id: string; threadId: string; title: string; ts: number }[]) => {
      indexedConversationEvents.push(events)
    },
    removeThread: () => undefined,
    removeAllConversations: () => undefined
  } as unknown as IndexClient
  const gateway = {
    socketPath: '/tmp/aios-test-G.sock',
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
    gatewayConfigDir: '/tmp/aios-test-G-mcp',
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
      onAgentStatus: () => undefined,
      onDeletedThreadsChanged: (items) => {
        deletedPushes.push(items.map((entry) => ({ id: entry.id })))
      }
    }
  })
  managers.push(manager)
  return manager
}

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  summaries = []
  indexedConversationEvents = []
  deletedPushes = []
})

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop()
  db.close()
})

describe('restoring deleted threads (item 191)', () => {
  it('deleting removes it from the list and shows it in the deleted list. Restoring returns it to the list and removes it from the deleted list', async () => {
    const adapter = new FakeAdapter()
    const manager = build(adapter)
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })

    expect(manager.listDeletedThreads()).toEqual([])
    const removed = await manager.remove(thread.id)
    expect(removed.removed).toBe(true)
    expect(summaries.find((s) => s.thread.id === thread.id)).toBeUndefined()
    const deleted = manager.listDeletedThreads()
    expect(deleted).toHaveLength(1)
    expect(deleted[0]?.id).toBe(thread.id)

    const restored = await manager.restore(thread.id)
    expect(restored?.id).toBe(thread.id)
    expect(manager.listDeletedThreads()).toEqual([])
    // Back in the list via `emitThreads()` (full-list delivery) (item 75).
    expect(summaries.find((s) => s.thread.id === thread.id)).toBeDefined()
  })

  it("restore re-indexes the woken thread's recent timeline on the spot (does not wait for startup, the upsert of item 76)", async () => {
    const adapter = new FakeAdapter()
    const manager = build(adapter)
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    await manager.send(thread.id, { text: '消される前の発言' })
    const session = adapter.sessions.at(-1)!
    session.emit({ kind: 'session_started', payload: { backendSessionId: 'backend-1', model: 'model-a' } })
    session.emit({ kind: 'result', payload: RESULT })
    await settle()

    await manager.remove(thread.id)
    indexedConversationEvents = [] // Ignore inserts made before the deletion.

    await manager.restore(thread.id)
    const flat = indexedConversationEvents.flat()
    expect(flat.some((e) => e.threadId === thread.id)).toBe(true)
  })

  it('restore replays all indexable rows of the thread (including messages older than the latest 2000, owner decision 2026-10-01)', async () => {
    const adapter = new FakeAdapter()
    const manager = build(adapter)
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    // Write rows beyond one page (2000 items) directly (do not run 2,500 sends). Also mix in kinds that are not indexed.
    const store = new ThreadStore(db)
    const events: AiosEvent[] = []
    for (let i = 0; i < 2500; i += 1) {
      events.push({
        id: `e-${i}`,
        sessionId: 's',
        threadId: thread.id,
        ts: i,
        actor: 'main',
        kind: i % 2 === 0 ? 'user_text' : 'assistant_text',
        payload: { text: `発言 ${i}` }
      } as AiosEvent)
    }
    events.push({
      id: 'not-indexed',
      sessionId: 's',
      threadId: thread.id,
      ts: 9999,
      actor: 'main',
      kind: 'error',
      payload: { message: 'x', code: null, origin: 'internal' }
    } as AiosEvent)
    store.appendEvents(thread, null, events)

    await manager.remove(thread.id)
    indexedConversationEvents = []
    await manager.restore(thread.id)
    const ids = indexedConversationEvents.flat().map((e) => e.id)
    expect(ids).toHaveLength(2500)
    expect(new Set(ids).size).toBe(2500)
    expect(ids).toContain('e-0')
    expect(ids).toContain('e-2499')
    expect(ids).not.toContain('not-indexed')
    // Send in pages split at the one-page limit.
    expect(indexedConversationEvents.every((page) => page.length <= 2000)).toBe(true)
  })

  it('an id that is not deleted or does not exist is null (not restored)', async () => {
    const adapter = new FakeAdapter()
    const manager = build(adapter)
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    await expect(manager.restore(thread.id)).resolves.toBeNull()
    await expect(manager.restore('no-such-thread')).resolves.toBeNull()
  })

  it('a thread with retention=none is not re-indexed on restore because its timeline is empty (does not throw)', async () => {
    const adapter = new FakeAdapter()
    const manager = build(adapter)
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    manager.setRetention(thread.id, 'none', null)
    await manager.remove(thread.id)
    await expect(manager.restore(thread.id)).resolves.not.toBeNull()
  })
})

describe('push of the deleted list (item 222, wave 14 bundle L)', () => {
  it('every delete / restore calls onDeletedThreadsChanged as a full broadcast (to align other windows)', async () => {
    const adapter = new FakeAdapter()
    const manager = build(adapter)
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })

    expect(deletedPushes).toEqual([]) // Not called on create.

    await manager.remove(thread.id)
    expect(deletedPushes).toHaveLength(1)
    expect(deletedPushes[0]).toEqual([{ id: thread.id }])

    await manager.restore(thread.id)
    expect(deletedPushes).toHaveLength(2)
    expect(deletedPushes[1]).toEqual([])
  })

  it('restoring a nonexistent id does nothing so it does not push', async () => {
    const adapter = new FakeAdapter()
    const manager = build(adapter)
    await manager.start()
    await expect(manager.restore('no-such-thread')).resolves.toBeNull()
    expect(deletedPushes).toEqual([])
  })

  it('remove / restore do not fail even in a setup that omits onDeletedThreadsChanged (the convention of other tests)', async () => {
    const adapter = new FakeAdapter()
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
      socketPath: '/tmp/aios-test-G2.sock',
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
      gatewayConfigDir: '/tmp/aios-test-G2-mcp',
      events: {
        onEvents: () => undefined,
        onThreadsChanged: () => undefined,
        onThreadChanged: () => undefined,
        onApprovalsChanged: () => undefined,
        onAgentStatus: () => undefined
        // onDeletedThreadsChanged omitted.
      }
    })
    managers.push(manager)
    await manager.start()
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    await expect(manager.remove(thread.id)).resolves.toEqual({ removed: true, scratchEntries: 0 })
    await expect(manager.restore(thread.id)).resolves.not.toBeNull()
  })
})
