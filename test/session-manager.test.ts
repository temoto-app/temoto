/**
 * Unit tests for SessionManager (ARCHITECTURE.md 4.2 / 4.3, review chapter E).
 *
 * `AgentAdapter` is an interface, so it can be replaced. Here a mock whose spawn timing can be controlled by hand is used, and **neither the CLI nor the model is started**.
 * The DB is the real encrypted SQLite code (in memory).
 *
 * What is pinned:
 * - B-2: even if a second send arrives while starting, spawn happens only once
 * - B-3: a message whose launch failed is neither saved nor indexed (so resending does not duplicate it)
 * - Item 94 (formerly B-8): a send during a response becomes a reservation and is not written to stdin. The head is sent one at a time on `result`.
 *   An interrupt sends the interruption, and the interrupting input is sent ahead of the reservations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosActor, AiosEvent, ResultPayload, ThinkingLevel } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import type { SwitchRestart, ThreadSummary, ViewerCommand } from '../src/shared/thread.js'
import { GATEWAY_TOOL_PREFIX } from '../src/shared/thread.js'
import type { PluginToolDeclaration } from '../src/shared/plugin.js'
import { PluginToolRelay } from '../src/main/plugin/tools.js'
import type { EnabledPluginTool } from '../src/main/plugin/host.js'
import { pluginToolFingerprint } from '../src/main/plugin/tool-fingerprint.js'
import { runMigrations } from '../src/common/migrations.js'
import { uriToPath } from '../src/common/uri.js'
import {
  SCHEDULED_APPROVAL_MARGIN_MS,
  SessionManager,
  scheduledApprovalDeadline,
  type SessionManagerDeps
} from '../src/main/session/manager.js'
import { ThreadStore } from '../src/main/session/store.js'
import type {
  AgentAdapter,
  AgentInput,
  AgentProbeResult,
  AgentSession,
  GatewayEndpoint,
  RewindFilesResult,
  SpawnHandlers,
  SpawnOptions
} from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'
import { scratchCwd, scratchRoot } from '../src/main/session/scratch.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'

/** A session that only records what is sent. */
class FakeSession implements AgentSession {
  readonly sent: AgentInput[] = []
  alive = true
  /** When set, `send` throws synchronously (imitates an implementation that breaks the contract, item 82). */
  throwOnSend = false
  constructor(
    readonly sessionId: string,
    readonly handlers: SpawnHandlers
  ) {}
  send(input: AgentInput): void {
    if (this.throwOnSend) throw new Error('write EPIPE')
    this.sent.push(input)
  }
  /** The number of times `interrupt()` (a control-request interruption, item 94) was called. */
  interrupts = 0
  /** The number of times `abort()` (SIGINT from the stop button) was called. */
  aborts = 0
  /** When set, `interrupt()` rejects (imitates a version that does not accept the interruption). */
  rejectInterrupt = false
  async interrupt(): Promise<void> {
    this.interrupts += 1
    if (this.rejectInterrupt) throw new Error('control request rejected')
  }
  /**
   * The answer to a switch while running (item 95). The default is false (= the entry point exists but cannot switch → wake again), and the tests up to T7 look at the "wake again" form as it is.
   */
  switchResult = false
  /** The settings passed to `switchSettings`. */
  readonly switches: { modelId: string | null; thinking: ThinkingLevel | null }[] = []
  switchRestart: SwitchRestart = 'always'
  async switchSettings(target: { modelId: string | null; thinking: ThinkingLevel | null }): Promise<boolean> {
    this.switches.push({ ...target })
    return this.switchResult
  }
  /** The answer to a rewind (item 113). null means "no entry point". Calls are kept in `rewinds`. */
  rewindResult: RewindFilesResult | null = { canRewind: true, filesChanged: ['/Users/tester/work/a.txt'], insertions: 2, deletions: 1 }
  readonly rewinds: { userMessageId: string; dryRun: boolean }[] = []
  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindFilesResult | null> {
    this.rewinds.push({ userMessageId, dryRun })
    return this.rewindResult
  }
  /** As in the real thing, the process dies without emitting a result (requested, since it was stopped by itself). */
  abort(): void {
    this.aborts += 1
    if (!this.alive) return
    this.alive = false
    this.handlers.onExit({ code: 0, signal: null, sawResult: false, requested: true })
  }
  async stop(): Promise<void> {
    if (!this.alive) return
    this.alive = false
    this.handlers.onExit({ code: 0, signal: null, sawResult: true, requested: true })
  }
  /** Imitates events from the backend. */
  emit(
    event: Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'> & { id?: string; actor?: AiosActor }
  ): void {
    this.handlers.onEvent({
      id: event.id ?? `${this.sessionId}:${this.sent.length}:${Math.random()}`,
      sessionId: this.sessionId,
      ts: Date.now(),
      // The real parseEvent makes the top-level event 'main'. Subagents set it explicitly.
      actor: 'main',
      ...event
    } as unknown as AiosEvent)
  }
}

/** An Adapter whose spawn completion can be controlled from outside. */
class FakeAdapter implements AgentAdapter {
  readonly transcripts = null
  readonly sessions: FakeSession[] = []
  /** The features available. All true by default. Turned off when trying the degradation of model / thinking. */
  features: Partial<Record<AgentFeature, boolean>> = {}
  /** Imitates an unknown version (item 81). When set, `getStatus` returns `needsProbe`. */
  unknownVersion = false
  /** The value written to `features` as the result that probe confirmed. If null, probe fails. */
  probeFeatures: Partial<Record<AgentFeature, boolean>> | null = {}
  /** The gateway passed to probe (the result of calling the factory). */
  probeGateways: GatewayEndpoint[] = []
  readonly probe = vi.fn(
    async (gateway: () => GatewayEndpoint): Promise<AgentProbeResult> => {
      this.probeGateways.push(gateway())
      await new Promise((resolve) => setTimeout(resolve, 10))
      // As in the real thing, regardless of success or failure, "do not try again during this launch".
      this.unknownVersion = false
      if (this.probeFeatures === null) return { ok: false, status: await this.getStatus() }
      this.features = { ...this.probeFeatures }
      return { ok: true, status: await this.getStatus() }
    }
  )
  models = [
    { id: 'model-a', label: 'A' },
    { id: 'model-b', label: 'B' }
  ]
  constructor(
    readonly id = 'fake',
    readonly label = 'Fake'
  ) {}
  async listModels(): Promise<readonly { id: string; label: string }[]> {
    return this.models
  }
  /** Replaced to imitate whether an instructions file exists. */
  /**
   * Item 97 second half (draft conflict). Only the write-type tools that match the real compat table return a path
   * (Edit / Write / NotebookEdit). Replacing this can imitate an Adapter that does not have them.
   */
  writeToolTargetPath: (toolName: string, input: unknown) => string | null = (toolName, input) => {
    if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'NotebookEdit') return null
    if (typeof input !== 'object' || input === null) return null
    const record = input as Record<string, unknown>
    const value = record['file_path'] ?? record['notebook_path'] ?? record['path']
    return typeof value === 'string' && value.trim() !== '' ? value : null
  }
  readonly spawn = vi.fn(
    (options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> =>
      this.nextSpawn(options, handlers)
  )
  /** Replaced to change the behavior of spawn. The default is "wait a little, then succeed". */
  nextSpawn: (options: SpawnOptions, handlers: SpawnHandlers) => Promise<AgentSession> =
    this.spawnOk.bind(this)
  async spawnOk(options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const session = new FakeSession(options.sessionId, handlers)
    this.sessions.push(session)
    return session
  }
  /** TODO 1114: imitates not installed / not logged in. */
  available = true
  loggedIn = true
  async getStatus(): Promise<AgentStatus> {
    const features = {} as Record<AgentFeature, boolean>
    for (const feature of AGENT_FEATURES) features[feature] = this.features[feature] ?? true
    return {
      available: this.available,
      version: '0.0.0',
      loggedIn: this.loggedIn,
      authMethod: null,
      subscriptionType: null,
      features,
      degradations: [],
      source: this.unknownVersion ? 'probe' : 'known-version',
      needsProbe: this.unknownVersion,
      checkedAt: Date.now(),
      message: null,
      messageCode: null
    }
  }
  supports(feature: AgentFeature): boolean {
    return this.features[feature] ?? true
  }
  /** The denominator for the static table (item 60). Only knows the full name of `model-a`. */
  contextWindow(model: string): number | null {
    return model === 'model-a-full-name' ? 1000 : null
  }
}

let db: Db
let adapter: FakeAdapter
let manager: SessionManager
let summaries: readonly ThreadSummary[] = []
/** The thread id received by `onThreadChanged` (single-item delivery, item 75). */
let threadChanges: string[] = []
/** The number of times `onThreadsChanged` (full delivery) was called. */
let fullLists = 0
let indexed: { id: string; threadId: string }[] = []
/** The thread id for which `index.removeThread` (the tombstone of conversation search) was called. */
let tombstoned: string[] = []
/** The windows in front (TODO 71). null = every window is in front (the default). */
let focusedViews: Set<number> | null = null
/** The `sources` passed to the index by search through the gateway (item 86). */
let searchedSources: (readonly string[] | undefined)[] = []
/** The "open / close" delivered to the windows (item 97). */
let viewerCommands: { viewId: number; command: ViewerCommand }[] = []
/** Item 72: records of calls to the desktop notification. */
let notifyCalls: {
  kind: 'approval' | 'turnEnded' | 'scheduledDone' | 'scheduledApproval' | 'triggerDone'
  threadId: string
  threadTitle: string
  excerpt?: string
}[] = []
/** TODO 351 (351-2): the job id for which `scheduledJobRunningChanged` was called. */
let runningChangedCalls: string[] = []
/** TODO 628 (code-review): the thread id for which `threadResumed` was called. */
let resumedCalls: string[] = []
/** TODO 1216: the thread id for which `triggerTurnSettled` was called. */
let triggerSettled: string[] = []

/** Made so that the Adapters placed in the registry can be replaced (for backend selection tests). */
function build(adapters: readonly AgentAdapter[], home = '/Users/tester'): SessionManager {
  const fs = {
    homePath: home,
    homeUri: `file://${home}`,
    defaultReferenceDirs: () => [`${home}/work`],
    isReferenceable: (path: string) => !path.includes('excluded'),
    isViewable: (path: string) => !path.includes('excluded'),
    assertAllowed: (uri: string) => {
      if (uri.includes('excluded')) throw new Error('除外対象です')
      return uri.replace('file://', '')
    }
  } as unknown as FsAccess
  const index = {
    indexConversationEvents: (events: { id: string; threadId: string }[]) => {
      indexed.push(...events)
    },
    removeThread: (threadId: string) => {
      tombstoned.push(threadId)
    },
    removeAllConversations: () => undefined,
    search: async (_query: string, _scope: string, options: { sources?: readonly string[] }) => {
      searchedSources.push(options.sources)
      return { hits: [], total: 0, truncated: false }
    }
  } as unknown as IndexClient
  const gateway = {
    socketPath: '/tmp/aios-test.sock',
    issueToken: () => 'token',
    revokeToken: () => undefined
  } as unknown as GatewayServer
  const deps: SessionManagerDeps = {
    db,
    adapters,
    fs,
    index,
    gateway,
    gatewayRuntimePath: '/bin/false',
    gatewayScriptPath: '/dev/null',
    gatewayConfigDir: '/tmp/aios-test-mcp',
    isViewFocused: (viewId) => focusedViews === null || focusedViews.has(viewId),
    // Item 72: SessionManager calls this only when not displayed, so here it only records.
    notify: {
      approvalPending: (threadId, threadTitle) =>
        notifyCalls.push({ kind: 'approval', threadId, threadTitle }),
      turnEnded: (threadId, threadTitle) =>
        notifyCalls.push({ kind: 'turnEnded', threadId, threadTitle }),
      // TODO 323: the first turn of a scheduled run.
      scheduledTurnEnded: (threadId, threadTitle, excerpt) =>
        notifyCalls.push({ kind: 'scheduledDone', threadId, threadTitle, excerpt }),
      scheduledApprovalPending: (threadId, threadTitle) =>
        notifyCalls.push({ kind: 'scheduledApproval', threadId, threadTitle }),
      // TODO 1216: the first turn of a trigger. Adds the trigger's name to the heading.
      triggeredTurnEnded: (threadId, triggerName, threadTitle, excerpt) =>
        notifyCalls.push({ kind: 'triggerDone', threadId, threadTitle: `${triggerName}|${threadTitle}`, excerpt }),
      triggerTurnSettled: (threadId) => triggerSettled.push(threadId),
      // TODO 351 (351-2): a signal to fix "running" at turn end or process death.
      scheduledJobRunningChanged: (jobId) => runningChangedCalls.push(jobId),
      threadResumed: (threadId) => resumedCalls.push(threadId)
    },
    events: {
      onEvents: () => undefined,
      onThreadsChanged: (list) => {
        fullLists += 1
        summaries = list
      },
      // Single-item delivery (item 75). As in the renderer, replaces by id (does not look at the order).
      onThreadChanged: (summary) => {
        threadChanges.push(summary.thread.id)
        const at = summaries.findIndex((s) => s.thread.id === summary.thread.id)
        summaries =
          at === -1
            ? [...summaries, summary]
            : summaries.map((s, i) => (i === at ? summary : s))
      },
      onApprovalsChanged: () => undefined,
      onAgentStatus: () => undefined,
      onViewerCommand: (viewId, command) => {
        viewerCommands.push({ viewId, command })
      }
    }
  }
  return new SessionManager(deps)
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  indexed = []
  tombstoned = []
  threadChanges = []
  fullLists = 0
  focusedViews = null
  searchedSources = []
  viewerCommands = []
  notifyCalls = []
  resumedCalls = []
  runningChangedCalls = []
  triggerSettled = []
  manager = build([adapter])
})

afterEach(async () => {
  await manager.stop()
  db.close()
})

/** The payload of `result`. Only the cost is used for state transitions. */
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

/** Waits until the Batcher (16 ms) finishes saving. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

/**
 * Finishes the current turn with the session that was woken last. **A send during a response becomes a reservation** (item 94),
 * so tests of the form that sends in succession return a `result` in between, as the real thing does.
 */
function finishTurn(threadId: string): void {
  const session = adapter.sessions.at(-1)
  if (session === undefined) throw new Error('no session')
  session.emit({ threadId, kind: 'result', payload: RESULT })
}

function runtimeOf(threadId: string): ThreadSummary['runtime'] {
  const found = summaries.find((s) => s.thread.id === threadId)
  if (found === undefined) throw new Error('thread not in summaries')
  return found.runtime
}

describe('SessionManager — 起動中の待ち合わせ (B-2)', () => {
  it('同じスレッドに続けて 2 回送っても spawn は 1 本で、2 回目は予約になる (項目 94)', async () => {
    const thread = await manager.createThread({})
    const outcomes = await Promise.all([
      manager.send(thread.id, { text: '一つ目' }),
      manager.send(thread.id, { text: '二つ目' })
    ])
    expect(outcomes.map((o) => o.kind)).toEqual(['sent', 'queued'])
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(adapter.sessions).toHaveLength(1)
    // The second send while starting (before the response) is not written to stdin.
    expect(adapter.sessions[0]?.sent.map((i) => i.text)).toEqual(['一つ目'])
    expect(runtimeOf(thread.id).reservations.map((r) => r.preview)).toEqual(['二つ目'])
  })

  it('起動が失敗したら呼んだ側に伝わり、その間に積んだ予約は止めたまま残す。次の送信で改めて起動する', async () => {
    const thread = await manager.createThread({})
    adapter.nextSpawn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error('起動できない')
    }
    const results = await Promise.allSettled([
      manager.send(thread.id, { text: 'a' }),
      manager.send(thread.id, { text: 'b' })
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    await settle()
    // So that it does not keep failing for the same reason: b is not sent on its own, and it remains on the chip.
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(runtimeOf(thread.id).reservations.map((r) => r.preview)).toEqual(['b'])

    adapter.nextSpawn = adapter.spawnOk.bind(adapter)
    // The queue starts moving on the next send. b, which was queued earlier, goes first; c goes behind it.
    expect((await manager.send(thread.id, { text: 'c' })).kind).toBe('queued')
    await vi.waitFor(() => expect(adapter.sessions[0]?.sent.map((i) => i.text)).toEqual(['b']))
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(runtimeOf(thread.id).reservations.map((r) => r.preview)).toEqual(['c'])
  })

  it('TODO 568: 起動中に削除すると、spawn の後に発言は送られず、プロセスは止められる', async () => {
    const thread = await manager.createThread({})
    let release = (): void => undefined
    adapter.nextSpawn = async (options, handlers) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      const session = new FakeSession(options.sessionId, handlers)
      adapter.sessions.push(session)
      return session
    }
    const sending = manager.send(thread.id, { text: '消す前の発言' })
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledTimes(1))
    const removing = manager.remove(thread.id)
    release()
    await expect(sending).rejects.toThrow()
    await expect(removing).resolves.toEqual({ removed: true, scratchEntries: 0 })
    const session = adapter.sessions[0]
    expect(session?.sent).toEqual([])
    expect(session?.alive).toBe(false)
  })

  it('TODO 568: 起動中に終了 (stop) しても、spawn した後のプロセスを止めてから返る', async () => {
    const thread = await manager.createThread({})
    let release = (): void => undefined
    adapter.nextSpawn = async (options, handlers) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      const session = new FakeSession(options.sessionId, handlers)
      adapter.sessions.push(session)
      return session
    }
    const sending = manager.send(thread.id, { text: '終了前の発言' })
    sending.catch(() => undefined)
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledTimes(1))
    const stopping = manager.stop()
    release()
    await stopping
    await expect(sending).rejects.toThrow()
    expect(adapter.sessions[0]?.sent).toEqual([])
    expect(adapter.sessions[0]?.alive).toBe(false)
  })

  /** Sends to a thread that has finished one turn, with the given change (it cannot be switched, so it is woken again). The second spawn is held until `release`. */
  async function restartingThread(): Promise<{
    id: string
    first: FakeSession
    sending: Promise<unknown>
    release: () => void
  }> {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '1' })
    const first = adapter.sessions.at(-1)
    if (first === undefined) throw new Error('no session')
    finishTurn(thread.id)
    await settle()
    let release = (): void => undefined
    adapter.nextSpawn = async (options, handlers) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      const session = new FakeSession(options.sessionId, handlers)
      adapter.sessions.push(session)
      return session
    }
    const sending = manager.send(thread.id, { text: '2', modelId: 'model-b' })
    sending.catch(() => undefined)
    return { id: thread.id, first, sending, release: () => release() }
  }

  it('TODO 928: 起こし直しの最中 (新しい spawn の途中) に削除すると、新しいプロセスも止めてから返る', async () => {
    const { id, first, sending, release } = await restartingThread()
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledTimes(2))
    expect(first.alive).toBe(false)
    const removing = manager.remove(id)
    release()
    await expect(removing).resolves.toEqual({ removed: true, scratchEntries: 0 })
    await expect(sending).rejects.toThrow()
    const second = adapter.sessions.at(-1)
    expect(second).not.toBe(first)
    expect(second?.sent).toEqual([])
    expect(second?.alive).toBe(false)
    expect(manager.activityBlocker()).toBeNull()
  })

  it('TODO 928: 起こし直しの最中 (古いほうの終了待ち) に削除すると、新しいプロセスを起こさない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '1' })
    const first = adapter.sessions.at(-1)
    if (first === undefined) throw new Error('no session')
    finishTurn(thread.id)
    await settle()
    // Delays the end of the old process (in the real thing, SIGTERM → close takes 1 to 3 seconds).
    let finishStop = (): void => undefined
    const stopped = new Promise<void>((resolve) => {
      finishStop = resolve
    })
    const originalStop = first.stop.bind(first)
    first.stop = async () => {
      await stopped
      await originalStop()
    }
    const sending = manager.send(thread.id, { text: '2', modelId: 'model-b' })
    sending.catch(() => undefined)
    await vi.waitFor(() => expect(runtimeOf(thread.id).state).toBe('stopping'))
    const removing = manager.remove(thread.id)
    finishStop()
    await expect(removing).resolves.toEqual({ removed: true, scratchEntries: 0 })
    await expect(sending).rejects.toThrow()
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(first.alive).toBe(false)
    expect(manager.activityBlocker()).toBeNull()
  })

  it('TODO 928: 起こし直しの最中 (新しい spawn の途中) に終了 (stop) しても、新しいプロセスを止めてから返る', async () => {
    const { first, sending, release } = await restartingThread()
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledTimes(2))
    const stopping = manager.stop()
    release()
    await stopping
    await expect(sending).rejects.toThrow()
    const second = adapter.sessions.at(-1)
    expect(second).not.toBe(first)
    expect(second?.sent).toEqual([])
    expect(second?.alive).toBe(false)
  })

  it('TODO 928: 起こし直しの最中 (古いほうの終了待ち) に終了 (stop) すると、新しいプロセスを起こさない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '1' })
    const first = adapter.sessions.at(-1)
    if (first === undefined) throw new Error('no session')
    finishTurn(thread.id)
    await settle()
    let finishStop = (): void => undefined
    const stopped = new Promise<void>((resolve) => {
      finishStop = resolve
    })
    const originalStop = first.stop.bind(first)
    first.stop = async () => {
      await stopped
      await originalStop()
    }
    const sending = manager.send(thread.id, { text: '2', modelId: 'model-b' })
    sending.catch(() => undefined)
    await vi.waitFor(() => expect(runtimeOf(thread.id).state).toBe('stopping'))
    const stopping = manager.stop()
    finishStop()
    await stopping
    await expect(sending).rejects.toThrow()
    await settle()
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(first.alive).toBe(false)
  })
})

describe('SessionManager — 送れなかった発言は残さない (B-3)', () => {
  it('spawn が失敗した発言は保存も索引もされず、スレッド名も変わらない', async () => {
    const thread = await manager.createThread({})
    adapter.nextSpawn = async () => {
      throw new Error('起動できない')
    }
    await expect(manager.send(thread.id, { text: '送れない発言' })).rejects.toThrow('起動できない')
    await settle()

    const events = (await manager.timeline(thread.id)).events
    expect(events.filter((e) => e.kind === 'user_text')).toHaveLength(0)
    // The failure itself remains as an error (so the user can see it).
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(1)
    expect(indexed.filter((e) => e.threadId === thread.id)).toHaveLength(0)
    // The provisional title is an empty string regardless of language (TODO 66).
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread.title).toBe('')
  })

  it('再送すると発言は 1 行だけ保存され、スレッド名はその発言になる', async () => {
    const thread = await manager.createThread({})
    adapter.nextSpawn = async () => {
      throw new Error('起動できない')
    }
    await expect(manager.send(thread.id, { text: '同じ発言' })).rejects.toThrow()
    adapter.nextSpawn = adapter.spawnOk.bind(adapter)
    await manager.send(thread.id, { text: '同じ発言' })
    await settle()

    const userTexts = (await manager.timeline(thread.id)).events.filter((e) => e.kind === 'user_text')
    expect(userTexts).toHaveLength(1)
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread.title).toBe('同じ発言')
    expect(indexed.filter((e) => e.threadId === thread.id)).toHaveLength(1)
  })
})

describe('SessionManager — 予約と割り込み (項目 94、旧 B-8)', () => {
  /** Creates a thread and sends once, putting it in the in-response state. */
  async function running(): Promise<{ id: string; session: FakeSession }> {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '一つ目' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    return { id: thread.id, session }
  }
  const texts = (session: FakeSession): string[] => session.sent.map((i) => i.text)
  const reserved = (threadId: string): string[] =>
    runtimeOf(threadId).reservations.map((r) => r.preview)
  const finish = (session: FakeSession, threadId: string, payload: ResultPayload = RESULT): void =>
    session.emit({ threadId, kind: 'result', payload })
  const INTERRUPTED: ResultPayload = { ...RESULT, ok: false, subtype: 'interrupted', interrupted: true }

  it('応答中の送信は session.send を呼ばずに予約になり、記録もしない', async () => {
    const { id, session } = await running()
    expect(runtimeOf(id).state).toBe('running')
    const outcome = await manager.send(id, { text: '二つ目' })
    expect(outcome.kind).toBe('queued')
    expect(texts(session)).toEqual(['一つ目'])
    expect(reserved(id)).toEqual(['二つ目'])
    await settle()
    // A reservation is not in the timeline (it is recorded at the time it is sent).
    const users = (await manager.timeline(id)).events.filter((e) => e.kind === 'user_text')
    expect(users.map((e) => (e.kind === 'user_text' ? e.payload.text : ''))).toEqual(['一つ目'])
  })

  it('result で先頭が 1 件だけ送られ、次の result で次が送られる。送信 1 回 = result 1 回', async () => {
    const { id, session } = await running()
    await manager.send(id, { text: '二つ目' })
    await manager.send(id, { text: '三つ目' })
    expect(reserved(id)).toEqual(['二つ目', '三つ目'])

    finish(session, id)
    await vi.waitFor(() => expect(texts(session)).toEqual(['一つ目', '二つ目']))
    expect(reserved(id)).toEqual(['三つ目'])
    expect(runtimeOf(id).state).toBe('running')

    finish(session, id)
    await vi.waitFor(() => expect(texts(session)).toEqual(['一つ目', '二つ目', '三つ目']))
    expect(reserved(id)).toEqual([])

    finish(session, id)
    // Since the B form (a message sent during a response gets mixed into the current turn, and only one result arrives) does not occur,
    // it always returns to standby at the last result. The earlier `queued` remained at 1 here.
    expect(runtimeOf(id).state).toBe('idle')
    await settle()
    const users = (await manager.timeline(id)).events.filter((e) => e.kind === 'user_text')
    expect(users.map((e) => (e.kind === 'user_text' ? e.payload.text : ''))).toEqual([
      '一つ目',
      '二つ目',
      '三つ目'
    ])
  })

  it('承認待ちの間は予約を送らない (result が来ていない)', async () => {
    const thread = await manager.createThread({ approvalStrict: true })
    await manager.send(thread.id, { text: '一つ目' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const approval = manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't1', input: { file_path: '/tmp/x' } }
    })
    await vi.waitFor(() => expect(runtimeOf(thread.id).state).toBe('awaiting-approval'))
    await manager.send(thread.id, { text: '二つ目' })
    await settle()
    expect(texts(session)).toEqual(['一つ目'])

    // Even if permitted, the message is not sent until the turn ends (result).
    const item = manager.listApprovals()[0]
    if (item === undefined) throw new Error('no approval')
    manager.decideApproval(item.id, { kind: 'allow' })
    await approval
    expect(runtimeOf(thread.id).state).toBe('running')
    await settle()
    expect(texts(session)).toEqual(['一つ目'])

    finish(session, thread.id)
    await vi.waitFor(() => expect(texts(session)).toEqual(['一つ目', '二つ目']))
  })

  it('TODO 927: 並行する承認の 1 件に答えても、残りが保留中なら承認待ちのまま', async () => {
    const thread = await manager.createThread({ approvalStrict: true })
    await manager.send(thread.id, { text: '一つ目' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const approval1 = manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't1', input: { file_path: '/tmp/x' } }
    })
    const approval2 = manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't2', input: { file_path: '/tmp/y' } }
    })
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(2))
    expect(runtimeOf(thread.id).state).toBe('awaiting-approval')

    const [first, second] = manager.listApprovals()
    if (first === undefined || second === undefined) throw new Error('no approval')
    manager.decideApproval(first.id, { kind: 'allow' })
    await Promise.race([approval1, approval2])
    await settle()
    expect(manager.listApprovals()).toHaveLength(1)
    expect(runtimeOf(thread.id).state).toBe('awaiting-approval')

    // When the last one is answered, it returns to the rest of the turn (waiting for result).
    manager.decideApproval(second.id, { kind: 'allow' })
    await Promise.all([approval1, approval2])
    expect(runtimeOf(thread.id).state).toBe('running')
  })

  it('割り込みは中断を送り、割り込んだ入力が先・予約は後ろに残る', async () => {
    const { id, session } = await running()
    await manager.send(id, { text: '予約' })
    const outcome = await manager.sendInterrupt(id, { text: '割り込み' })
    expect(outcome.kind).toBe('queued')
    expect(session.interrupts).toBe(1)
    // The process is not stopped (it is separate from the stop button).
    expect(session.aborts).toBe(0)
    expect(session.alive).toBe(true)
    expect(runtimeOf(id).reservations.map((r) => [r.preview, r.interrupt])).toEqual([
      ['割り込み', true],
      ['予約', false]
    ])

    // On the result of an interruption (the one the Adapter tagged as interrupted), the interrupting input is sent.
    finish(session, id, INTERRUPTED)
    await vi.waitFor(() => expect(texts(session)).toEqual(['一つ目', '割り込み']))
    expect(reserved(id)).toEqual(['予約'])
    // It is not woken again (no startup cost for --resume).
    expect(adapter.spawn).toHaveBeenCalledTimes(1)

    finish(session, id)
    await vi.waitFor(() => expect(texts(session)).toEqual(['一つ目', '割り込み', '予約']))
  })

  it('起動中 (まだ書いていない) の割り込みは、書き終えてから中断を送る', async () => {
    const thread = await manager.createThread({})
    const first = manager.send(thread.id, { text: '一つ目' })
    expect((await manager.sendInterrupt(thread.id, { text: '割り込み' })).kind).toBe('queued')
    await first
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    await vi.waitFor(() => expect(session.interrupts).toBe(1))
    expect(texts(session)).toEqual(['一つ目'])
  })

  it('⌘Enter を 2 回押しても、1 件目の割り込みを 2 件目が中断しない', async () => {
    const { id, session } = await running()
    await manager.sendInterrupt(id, { text: 'x' })
    await manager.sendInterrupt(id, { text: 'y' })
    expect(session.interrupts).toBe(1)
    expect(reserved(id)).toEqual(['x', 'y'])
    finish(session, id, INTERRUPTED)
    await vi.waitFor(() => expect(texts(session)).toEqual(['一つ目', 'x']))
    await settle()
    expect(session.interrupts).toBe(1)
    finish(session, id)
    await vi.waitFor(() => expect(texts(session)).toEqual(['一つ目', 'x', 'y']))
  })

  it('割り込み後の result は中断として記録され、状態はエラーにならない', async () => {
    const { id, session } = await running()
    await manager.sendInterrupt(id, { text: '割り込み' })
    finish(session, id, INTERRUPTED)
    expect(runtimeOf(id).state).not.toBe('error')
    await vi.waitFor(() => expect(texts(session)).toEqual(['一つ目', '割り込み']))
    await settle()
    const results = (await manager.timeline(id)).events.filter((e) => e.kind === 'result')
    expect(results).toHaveLength(1)
    expect(results[0]?.kind === 'result' && results[0].payload.interrupted).toBe(true)
    expect((await manager.timeline(id)).events.filter((e) => e.kind === 'error')).toHaveLength(0)
  })

  it('応答していないときの割り込みは普通の送信と同じ (中断は送らない)', async () => {
    const { id, session } = await running()
    finish(session, id)
    const outcome = await manager.sendInterrupt(id, { text: '二つ目' })
    expect(outcome.kind).toBe('sent')
    expect(session.interrupts).toBe(0)
    expect(texts(session)).toEqual(['一つ目', '二つ目'])
  })

  it('承認待ちへの割り込みは、宙に浮く承認を取り消す', async () => {
    const thread = await manager.createThread({ approvalStrict: true })
    await manager.send(thread.id, { text: '一つ目' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const approval = manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't1', input: { file_path: '/tmp/x' } }
    })
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
    await manager.sendInterrupt(thread.id, { text: '割り込み' })
    await expect(approval).resolves.toMatchObject({ allowed: false })
    expect(manager.listApprovals()).toHaveLength(0)
    expect(session.interrupts).toBe(1)
  })

  it('中断が受理されなければ停止 (SIGINT) に倒し、割り込んだ入力は再開で送る', async () => {
    const { id, session } = await running()
    session.rejectInterrupt = true
    await manager.sendInterrupt(id, { text: '割り込み' })
    await vi.waitFor(() => expect(session.aborts).toBe(1))
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2))
    const resumed = adapter.sessions[1]
    if (resumed === undefined) throw new Error('no resumed session')
    await vi.waitFor(() => expect(texts(resumed)).toEqual(['割り込み']))
  })

  it('停止ボタンは中断を送り、プロセスは残す。予約は送らずに残し、次の送信で同じプロセスから動き出す (項目 96)', async () => {
    const { id, session } = await running()
    await manager.send(id, { text: '予約' })
    await manager.interrupt(id)
    expect(session.interrupts).toBe(1)
    expect(session.aborts).toBe(0)
    expect(session.alive).toBe(true)
    expect(runtimeOf(id).state).toBe('stopping')
    // The turn ends with the result of the interruption. A queue that was stopped does not move on its own.
    finish(session, id, INTERRUPTED)
    await settle()
    expect(runtimeOf(id).state).toBe('idle')
    expect(texts(session)).toEqual(['一つ目'])
    expect(reserved(id)).toEqual(['予約'])

    // The queue starts moving on the next send (the reservation queued earlier goes first). It is not woken again (no startup cost for --resume).
    expect((await manager.send(id, { text: '次' })).kind).toBe('queued')
    await vi.waitFor(() => expect(texts(session)).toEqual(['一つ目', '予約']))
    expect(reserved(id)).toEqual(['次'])
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('停止ボタンの中断が受理されなければ SIGINT に倒し、予約は残して次の送信で再開から動き出す (項目 96)', async () => {
    const { id, session } = await running()
    session.rejectInterrupt = true
    await manager.send(id, { text: '予約' })
    await manager.interrupt(id)
    expect(session.interrupts).toBe(1)
    expect(session.aborts).toBe(1)
    await settle()
    expect(adapter.sessions).toHaveLength(1)
    expect(reserved(id)).toEqual(['予約'])

    expect((await manager.send(id, { text: '次' })).kind).toBe('queued')
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2))
    const resumed = adapter.sessions[1]
    if (resumed === undefined) throw new Error('no resumed session')
    await vi.waitFor(() => expect(texts(resumed)).toEqual(['予約']))
    expect(reserved(id)).toEqual(['次'])
  })

  it('停止ボタンは承認待ちの承認も取り消す (項目 96)', async () => {
    const thread = await manager.createThread({ approvalStrict: true })
    await manager.send(thread.id, { text: '一つ目' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const approval = manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't1', input: { file_path: '/tmp/x' } }
    })
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
    await manager.interrupt(thread.id)
    await expect(approval).resolves.toMatchObject({ allowed: false })
    expect(manager.listApprovals()).toHaveLength(0)
    expect(session.interrupts).toBe(1)
    expect(session.aborts).toBe(0)
  })

  it('応答していないときの停止ボタンは以前どおり SIGINT (中断する相手のターンが無い)', async () => {
    const { id, session } = await running()
    finish(session, id)
    await manager.interrupt(id)
    expect(session.interrupts).toBe(0)
    expect(session.aborts).toBe(1)
  })

  it('予約は取り消せる / 中身ごと取り出せる (チップの ✕ / ✎)', async () => {
    const { id, session } = await running()
    const a = await manager.send(id, { text: '消す' })
    const b = await manager.send(id, {
      text: '直す',
      attachments: [
        { uri: 'file:///Users/tester/a.txt', name: 'a.txt', kind: 'reference', mediaType: null, bytes: 1 }
      ]
    })
    if (a.kind !== 'queued' || b.kind !== 'queued') throw new Error('not queued')
    expect(runtimeOf(id).reservations.map((r) => r.attachments)).toEqual([0, 1])
    expect(manager.cancelReservation(id, a.reservationId)).toBe(true)
    expect(manager.cancelReservation(id, a.reservationId)).toBe(false)
    const taken = manager.takeReservation(id, b.reservationId)
    expect(taken?.text).toBe('直す')
    expect(taken?.attachments?.[0]?.name).toBe('a.txt')
    expect(reserved(id)).toEqual([])
    finish(session, id)
    await settle()
    expect(texts(session)).toEqual(['一つ目'])
  })

  it('予約は積む前に指定を検証する (一覧に無いモデルは積まない)', async () => {
    const { id } = await running()
    await expect(manager.send(id, { text: 'x', modelId: 'no-such-model' })).rejects.toThrow(
      'aios-reason:model-not-selectable'
    )
    expect(reserved(id)).toEqual([])
  })

  it('スレッドを消すと予約も消え、送られない', async () => {
    const { id, session } = await running()
    await manager.send(id, { text: '予約' })
    await manager.remove(id)
    await settle()
    expect(texts(session)).toEqual(['一つ目'])
  })
})

describe('SessionManager — 窓ごとの表示中と未読 (TODO 71)', () => {
  function unreadOf(threadId: string): boolean {
    const found = summaries.find((s) => s.thread.id === threadId)
    if (found === undefined) throw new Error('thread not in summaries')
    return found.thread.unread
  }

  /** Creates one thread, wakes the session, and returns a function that finishes one response. */
  async function started(): Promise<{ id: string; finish: () => void }> {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hi' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    return {
      id: thread.id,
      finish: () => session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    }
  }

  it('窓に表示中のスレッドには未読を付けない', async () => {
    const x = await started()
    manager.openThread(x.id, 1)
    x.finish()
    expect(unreadOf(x.id)).toBe(false)
  })

  it('表示していた窓を閉じたら、そのスレッドの回答には未読が付く (窓 0 枚)', async () => {
    const x = await started()
    manager.openThread(x.id, 1)
    manager.closeView(1)
    x.finish()
    expect(unreadOf(x.id)).toBe(true)
    // If the next window is opened and that thread is selected, it falls over.
    manager.openThread(x.id, 2)
    expect(unreadOf(x.id)).toBe(false)
  })

  it('別の窓で表示中なら付けない (最後に開いた 1 つだけで判定しない)', async () => {
    const x = await started()
    const y = await started()
    manager.openThread(x.id, 1)
    manager.openThread(y.id, 2)
    x.finish()
    y.finish()
    expect(unreadOf(x.id)).toBe(false)
    expect(unreadOf(y.id)).toBe(false)
    // Closing only window 2 does not attach to window 1's X, but does attach to Y.
    manager.closeView(2)
    x.finish()
    y.finish()
    expect(unreadOf(x.id)).toBe(false)
    expect(unreadOf(y.id)).toBe(true)
  })

  it('表示中でも窓が背面なら付け、前面に戻ったら落とす', async () => {
    const x = await started()
    manager.openThread(x.id, 1)
    focusedViews = new Set()
    x.finish()
    expect(unreadOf(x.id)).toBe(true)
    focusedViews = new Set([1])
    manager.focusView(1)
    expect(unreadOf(x.id)).toBe(false)
  })

  it('同じ窓で別のスレッドに移ったら、前のスレッドは表示中ではない', async () => {
    const x = await started()
    const y = await started()
    manager.openThread(x.id, 1)
    manager.openThread(y.id, 1)
    x.finish()
    expect(unreadOf(x.id)).toBe(true)
  })

  // Item 80: opening the window alone does not clear unread (item 71, decision 3). The renderer's
  // `init()` used to auto-select `threads[0]` and call `threads.open` (→ `openThread` here),
  // so the unread was cleared the moment a window was opened from the Dock (an accident).
  // What can be checked as the main-side contract is that "unless `openThread` is called, merely reading the list
  // (`listSummaries`, which the renderer's `init()` calls) does not mark it as read".
  it('窓を開いただけ (一覧を読むだけ) では既読にならない。openThread を呼んで初めて既読になる', async () => {
    const x = await started()
    x.finish()
    expect(unreadOf(x.id)).toBe(true)

    // Equivalent to the renderer's init(): only reads the list, and no thread has been selected yet.
    const beforeSelection = manager.listSummaries().find((s) => s.thread.id === x.id)
    expect(beforeSelection?.thread.unread).toBe(true)

    const openThreadSpy = vi.spyOn(manager, 'openThread')
    // No matter how many times the list is re-read, openThread is not called (there is no auto-selection).
    manager.listSummaries()
    manager.listSummaries()
    expect(openThreadSpy).not.toHaveBeenCalled()
    expect(unreadOf(x.id)).toBe(true)

    // Marked as read only when the user clicks (the renderer's selectThread).
    manager.openThread(x.id, 1)
    expect(openThreadSpy).toHaveBeenCalledTimes(1)
    expect(unreadOf(x.id)).toBe(false)
  })
})

describe('SessionManager — 手で未読 / 既読にする (TODO 741)', () => {
  function unreadOf(threadId: string): boolean {
    const found = summaries.find((s) => s.thread.id === threadId)
    if (found === undefined) throw new Error('thread not in summaries')
    return found.thread.unread
  }

  it('既読のスレッドを手で未読にできる', async () => {
    const thread = await manager.createThread({})
    expect(unreadOf(thread.id)).toBe(false)
    manager.setThreadUnread(thread.id, true)
    expect(unreadOf(thread.id)).toBe(true)
    manager.setThreadUnread(thread.id, false)
    expect(unreadOf(thread.id)).toBe(false)
  })

  it('表示中のスレッドを未読にしても、窓の focus の出入り (選択の変化ではない) では消えない', async () => {
    const thread = await manager.createThread({})
    manager.openThread(thread.id, 1)
    expect(unreadOf(thread.id)).toBe(false)

    manager.setThreadUnread(thread.id, true)
    expect(unreadOf(thread.id)).toBe(true)

    // Background → front (focusView) is not a "selection". What was marked unread by hand remains (as in Slack).
    focusedViews = new Set()
    focusedViews = new Set([1])
    manager.focusView(1)
    expect(unreadOf(thread.id)).toBe(true)
  })

  it('手で未読にした後、他のスレッドへ移って戻ると (openThread) 消える', async () => {
    const a = await manager.createThread({})
    const b = await manager.createThread({})
    manager.openThread(a.id, 1)
    manager.setThreadUnread(a.id, true)
    expect(unreadOf(a.id)).toBe(true)

    // Moves elsewhere.
    manager.openThread(b.id, 1)
    expect(unreadOf(a.id)).toBe(true)

    // Going back → cleared by openThread (a change of selection).
    manager.openThread(a.id, 1)
    expect(unreadOf(a.id)).toBe(false)
  })

  it('背面で自動的に付いた未読は、手で未読にした分とは別物: focusView で普通に消える', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hi' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    manager.openThread(thread.id, 1)
    focusedViews = new Set()
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    expect(unreadOf(thread.id)).toBe(true)
    focusedViews = new Set([1])
    manager.focusView(1)
    expect(unreadOf(thread.id)).toBe(false)
  })
})

describe('SessionManager — デスクトップ通知 (項目 72)', () => {
  /** Creates one thread and wakes the session. Makes approval strict so it is not auto-allowed. */
  async function startedStrict(): Promise<{ id: string; session: FakeSession }> {
    const thread = await manager.createThread({ approvalStrict: true })
    await manager.send(thread.id, { text: 'hi' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    return { id: thread.id, session }
  }

  it('見えていないスレッドで承認が積まれたら通知する', async () => {
    const { id, session } = await startedStrict()
    const title = summaries.find((s) => s.thread.id === id)?.thread.title
    void manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't1', input: { file_path: '/tmp/x' } }
    })
    await vi.waitFor(() => expect(notifyCalls).toHaveLength(1))
    expect(notifyCalls[0]).toEqual({ kind: 'approval', threadId: id, threadTitle: title })
  })

  it('表示中のスレッドで承認が積まれても通知しない', async () => {
    const { id, session } = await startedStrict()
    manager.openThread(id, 1)
    void manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't1', input: { file_path: '/tmp/x' } }
    })
    await settle()
    expect(notifyCalls).toEqual([])
  })

  it('見えていないスレッドでターンが終わったら通知する', async () => {
    const { id, session } = await startedStrict()
    const title = summaries.find((s) => s.thread.id === id)?.thread.title
    session.emit({ threadId: id, kind: 'result', payload: RESULT })
    expect(notifyCalls).toEqual([{ kind: 'turnEnded', threadId: id, threadTitle: title }])
  })

  it('表示中のスレッドでターンが終わっても通知しない', async () => {
    const { id, session } = await startedStrict()
    manager.openThread(id, 1)
    session.emit({ threadId: id, kind: 'result', payload: RESULT })
    expect(notifyCalls).toEqual([])
  })

  it('中断で終わったターンは通知しない (利用者が自分で止めたので)', async () => {
    const { id, session } = await startedStrict()
    session.emit({
      threadId: id,
      kind: 'result',
      payload: { ...RESULT, ok: false, subtype: 'interrupted', interrupted: true }
    })
    expect(notifyCalls).toEqual([])
  })

  it('新しく積まれた分だけ通知する。既に積まれている分は結果を出しても再通知しない', async () => {
    const { session } = await startedStrict()
    const approval1 = manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't1', input: { file_path: '/tmp/x' } }
    })
    await vi.waitFor(() => expect(notifyCalls).toHaveLength(1))
    // Even if a second item is queued, the first notification is not redone (the first one is not yet resolved).
    void manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't2', input: { file_path: '/tmp/y' } }
    })
    await vi.waitFor(() => expect(notifyCalls).toHaveLength(2))
    // Resolving the first one is only a "decrease", so the notification does not increase.
    const first = manager.listApprovals().find((a) => a.toolName === 'Write')
    if (first !== undefined) manager.decideApproval(first.id, { kind: 'allow' })
    await approval1
    await settle()
    expect(notifyCalls).toHaveLength(2)
  })
})

describe('SessionManager — 作成ダイアログの既定 (T5)', () => {
  it('選んだ model / thinking がスレッドに保存され、SpawnOptions に載る', async () => {
    const thread = await manager.createThread({ modelId: 'model-b', thinking: 'high' })
    expect(thread.modelId).toBe('model-b')
    expect(thread.thinking).toBe('high')
    expect(thread.backend).toBe('fake')
    await manager.send(thread.id, { text: 'hi' })
    const options = adapter.spawn.mock.calls[0]?.[0]
    expect(options?.modelId).toBe('model-b')
    expect(options?.thinking).toBe('high')
    // Item 109: the origin of the settings is not passed (the CLI reads the same three as the plain CLI). Only a record is kept in the row.
    expect('settingSources' in (options ?? {})).toBe(false)
    expect(thread.settingSources).toEqual(['user', 'project', 'local'])
  })

  it('省略すると設定の既定を引き継ぎ、null の明示は「バックエンドの既定」', async () => {
    manager.setSettings({ defaultModelId: 'model-a', defaultThinking: 'low' })
    const inherited = await manager.createThread({})
    expect(inherited.modelId).toBe('model-a')
    expect(inherited.thinking).toBe('low')
    const explicit = await manager.createThread({ modelId: null, thinking: null })
    expect(explicit.modelId).toBeNull()
    expect(explicit.thinking).toBeNull()
  })

  it('一覧に無いモデルは拒否する (renderer の入力は main で再検証)', async () => {
    await expect(manager.createThread({ modelId: 'no-such' })).rejects.toThrow('aios-reason:model-not-selectable')
  })

  it('機能が無ければ保存されていても SpawnOptions では null になる', async () => {
    adapter.features = { 'model-select': false, 'thinking-level': false }
    manager.setSettings({ defaultModelId: 'model-a', defaultThinking: 'high' })
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hi' })
    const options = adapter.spawn.mock.calls[0]?.[0]
    expect(options?.modelId).toBeNull()
    expect(options?.thinking).toBeNull()
  })

  it('createOptions はバックエンドごとの一覧と可否を返す', async () => {
    const options = await manager.createOptions()
    expect(options.defaultBackend).toBe('fake')
    expect(options.homeUri).toBe('file:///Users/tester')
    expect(options.backends).toHaveLength(1)
    expect(options.backends[0]?.models.map((m) => m.id)).toEqual(['model-a', 'model-b'])
    expect(options.backends[0]?.modelSelect).toBe(true)
  })
})

describe('SessionManager — 登録簿 (4.6.1、T5 は器だけ)', () => {
  it('backend で Adapter を選び、スレッドはその id を持つ', async () => {
    await manager.stop()
    const a = new FakeAdapter('a', 'A')
    const b = new FakeAdapter('b', 'B')
    manager = build([a, b])
    const onB = await manager.createThread({ backend: 'b' })
    const onDefault = await manager.createThread({})
    expect(onB.backend).toBe('b')
    expect(onDefault.backend).toBe('a')
    await manager.send(onB.id, { text: 'x' })
    await manager.send(onDefault.id, { text: 'y' })
    expect(b.spawn).toHaveBeenCalledTimes(1)
    expect(a.spawn).toHaveBeenCalledTimes(1)
    const options = await manager.createOptions()
    expect(options.backends.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('TODO 1114: 送信の関門はスレッドのバックエンドの状態で判定する (既定のバックエンドではない)', async () => {
    await manager.stop()
    const a = new FakeAdapter('a', 'A')
    const b = new FakeAdapter('b', 'B')
    manager = build([a, b])
    const onB = await manager.createThread({ backend: 'b' })
    const onA = await manager.createThread({})
    // Even if the default (a) is not installed, a conversation on b can be sent.
    a.available = false
    await manager.send(onB.id, { text: 'x' })
    expect(b.spawn).toHaveBeenCalledTimes(1)
    // The same even if the default is not logged in.
    a.available = true
    a.loggedIn = false
    await manager.send(onB.id, { text: 'y' })
    // Conversely, when b cannot be used, a conversation on b stops before spawn even if the default can be used.
    a.loggedIn = true
    b.available = false
    const other = await manager.createThread({ backend: 'b' })
    await expect(manager.send(other.id, { text: 'z' })).rejects.toThrow()
    expect(b.spawn).toHaveBeenCalledTimes(1)
    // A conversation on the default backend is judged in the default state, as before.
    a.available = false
    await expect(manager.send(onA.id, { text: 'w' })).rejects.toThrow()
    expect(a.spawn).not.toHaveBeenCalled()
  })

  it('TODO 1114 の review: 終了が始まった後 (beginStop) の別バックエンドの送信は getStatus の前に断る', async () => {
    await manager.stop()
    const a = new FakeAdapter('a', 'A')
    const b = new FakeAdapter('b', 'B')
    manager = build([a, b])
    const onB = await manager.createThread({ backend: 'b' })
    const onA = await manager.createThread({})
    const statusB = vi.spyOn(b, 'getStatus')
    const statusA = vi.spyOn(a, 'getStatus')
    manager.beginStop()
    await expect(manager.send(onB.id, { text: 'x' })).rejects.toThrow('aios is shutting down')
    await expect(manager.send(onA.id, { text: 'y' })).rejects.toThrow('aios is shutting down')
    expect(statusB).not.toHaveBeenCalled()
    expect(statusA).not.toHaveBeenCalled()
    expect(b.spawn).not.toHaveBeenCalled()
  })

  it('登録簿に無い backend は拒否する', async () => {
    await expect(manager.createThread({ backend: 'nope' })).rejects.toThrow('aios-reason:backend-not-registered')
  })

  it('同じ id を 2 つ登録できない', async () => {
    expect(() => build([new FakeAdapter('x'), new FakeAdapter('x')])).toThrow('duplicate')
  })
})

describe('SessionManager — 作業ディレクトリの履歴 (T5 / TODO 6)', () => {
  it('createThread で upsert され、同じ cwd は回数が増える', async () => {
    await manager.createThread({ cwdUri: 'file:///Users/tester/work' })
    await manager.createThread({ cwdUri: 'file:///Users/tester/work' })
    await manager.createThread({})
    const rows = db
      .prepare('SELECT path, use_count FROM cwd_history ORDER BY path')
      .all() as { path: string; use_count: number }[]
    expect(rows).toEqual([
      { path: '/Users/tester', use_count: 1 },
      { path: '/Users/tester/work', use_count: 2 }
    ])
  })

  it('一覧は URI と名前だけで、消えたものと除外対象は usable=false', async () => {
    await manager.createThread({ cwdUri: 'file:///Users/tester/does-not-exist' })
    await manager.createThread({ cwdUri: 'file:///Users/tester/excluded' })
    await manager.createThread({ cwdUri: `file://${process.cwd()}` })
    const history = await manager.cwdHistory()
    const byName = new Map(history.map((h) => [h.name, h]))
    expect(byName.get('does-not-exist')?.usable).toBe(false)
    expect(byName.get('does-not-exist')?.reason).toBe('cwd-not-found')
    expect(byName.get('excluded')?.usable).toBe(false)
    expect(byName.get('excluded')?.reason).toContain('除外')
    const cwd = history.find((h) => h.uri === `file://${process.cwd()}`)
    expect(cwd?.usable).toBe(true)
    expect(cwd?.parentName).not.toBe('')
    for (const entry of history) {
      expect(entry.uri.startsWith('file://')).toBe(true)
      expect(JSON.stringify(entry)).not.toContain('"path"')
    }
  })

  it('TODO 742: 虹色は Sidebar の Threads と同じ番号 (履歴の行は必ず useCount > 0 = 既にスレッドがある)', async () => {
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/rainbow-me' })
    const history = await manager.cwdHistory()
    const row = history.find((h) => h.uri === 'file:///Users/tester/rainbow-me')
    expect(row?.rainbow).not.toBeNull()
    expect(row?.rainbow).toBe(thread.rainbow)
  })

  it('TODO 1118: deferCwdHistory で作ると履歴に載せず、最初の送信で載せる (2 回目以降は数えない)', async () => {
    const count = (): number | null =>
      (
        db.prepare('SELECT use_count FROM cwd_history WHERE path = ?').get('/Users/tester/url-proj') as
          | { use_count: number }
          | undefined
      )?.use_count ?? null
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/url-proj' }, null, { deferCwdHistory: true })
    expect(count()).toBeNull()
    await manager.send(thread.id, { text: '1' })
    expect(count()).toBe(1)
    finishTurn(thread.id)
    await manager.send(thread.id, { text: '2' })
    expect(count()).toBe(1)
    // A conversation made from the creation dialog is attached at creation time, and is not counted again at the first send (the order of history = the order of creation).
    const normal = await manager.createThread({ cwdUri: 'file:///Users/tester/url-proj' })
    expect(count()).toBe(2)
    await manager.send(normal.id, { text: '1' })
    expect(count()).toBe(2)
  })

  it('TODO 1118 の review: 印は遅らせた会話だけに付き、最初の送信で外れる。作成ダイアログの会話は履歴から消しても戻さない', async () => {
    const count = (path: string): number | null =>
      (db.prepare('SELECT use_count FROM cwd_history WHERE path = ?').get(path) as { use_count: number } | undefined)
        ?.use_count ?? null
    const summary = (id: string) => manager.listSummaries().find((s) => s.thread.id === id)?.thread
    // A conversation made from the creation dialog: no mark. Even if the user removes it from recent folders, it is not returned to history at the first send.
    const normal = await manager.createThread({ cwdUri: 'file:///Users/tester/dialog-proj' })
    expect(summary(normal.id)?.cwdHistoryDeferred).toBeUndefined()
    manager.removeCwdHistory('file:///Users/tester/dialog-proj')
    expect(count('/Users/tester/dialog-proj')).toBeNull()
    await manager.send(normal.id, { text: '1' })
    expect(count('/Users/tester/dialog-proj')).toBeNull()
    // A conversation made from a link: it is marked, and the mark is removed at the first send and it enters history.
    const deferred = await manager.createThread({ cwdUri: 'file:///Users/tester/link-proj' }, null, { deferCwdHistory: true })
    expect(summary(deferred.id)?.cwdHistoryDeferred).toBe(true)
    // Even if the same folder is used first in the creation dialog, the first send of the deferred conversation is counted once (it was not counted at creation).
    await manager.createThread({ cwdUri: 'file:///Users/tester/link-proj' })
    expect(count('/Users/tester/link-proj')).toBe(1)
    await manager.send(deferred.id, { text: '1' })
    expect(summary(deferred.id)?.cwdHistoryDeferred).toBeUndefined()
    expect(count('/Users/tester/link-proj')).toBe(2)
  })

  it('1 件削除と全消去', async () => {
    await manager.createThread({ cwdUri: 'file:///Users/tester/one' })
    await manager.createThread({ cwdUri: 'file:///Users/tester/two' })
    manager.removeCwdHistory('file:///Users/tester/one')
    expect((await manager.cwdHistory()).map((h) => h.name)).toEqual(['two'])
    manager.clearCwdHistory()
    expect(await manager.cwdHistory()).toEqual([])
  })

  it('行の setting_sources が古い値 (project だけ) でも、spawn には出所を渡さない (項目 109)', async () => {
    const thread = await manager.createThread({})
    // Imitates a row created before item 109.
    db.prepare(`UPDATE threads SET setting_sources = '["project"]' WHERE id = ?`).run(thread.id)
    expect(
      manager.listSummaries().find((s) => s.thread.id === thread.id)?.thread.settingSources
    ).toEqual(['project'])
    await manager.send(thread.id, { text: 'hi' })
    const options = adapter.spawn.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(options).toBeDefined()
    expect('settingSources' in (options ?? {})).toBe(false)
  })
})

describe('SessionManager — 発言ごとの model / thinking (T7)', () => {
  it('上書きすると走っているプロセスを落として、新しい指定で起こし直す', async () => {
    const thread = await manager.createThread({ modelId: 'model-a', thinking: 'low' })
    await manager.send(thread.id, { text: '一つ目' })
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(adapter.spawn.mock.calls[0]?.[0].modelId).toBe('model-a')
    finishTurn(thread.id)

    await manager.send(thread.id, { text: '二つ目', modelId: 'model-b', thinking: 'high' })
    // It can only be passed as a startup flag, so the second process is woken (4.6.2). The first one has crashed.
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    const options = adapter.spawn.mock.calls[1]?.[0]
    expect(options?.modelId).toBe('model-b')
    expect(options?.thinking).toBe('high')
    expect(adapter.sessions[0]?.alive).toBe(false)
    expect(adapter.sessions[1]?.sent.map((i) => i.text)).toEqual(['二つ目'])
    // The thread's default does not change (only for this message).
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread.modelId).toBe('model-a')
  })

  it('同じ指定を続けて送っても起こし直さない', async () => {
    const thread = await manager.createThread({ modelId: 'model-a' })
    await manager.send(thread.id, { text: '1', modelId: 'model-b' })
    finishTurn(thread.id)
    await manager.send(thread.id, { text: '2', modelId: 'model-b' })
    // Omitted = not the thread's default, and not compared with the spec of the running process:
    // since it was omitted, it returns to the default (model-a), and only here is it woken again.
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(adapter.sessions[0]?.sent.map((i) => i.text)).toEqual(['1', '2'])
  })

  it('スレッドの既定に戻す発言では、また起こし直す', async () => {
    const thread = await manager.createThread({ modelId: 'model-a' })
    await manager.send(thread.id, { text: '1', modelId: 'model-b' })
    finishTurn(thread.id)
    await manager.send(thread.id, { text: '2' })
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(adapter.spawn.mock.calls[1]?.[0].modelId).toBe('model-a')
  })

  it('再起動中に来た送信は予約になり、spawn は 1 本だけ増える', async () => {
    const thread = await manager.createThread({ modelId: 'model-a' })
    await manager.send(thread.id, { text: '1' })
    finishTurn(thread.id)
    const outcomes = await Promise.all([
      manager.send(thread.id, { text: '2', modelId: 'model-b' }),
      manager.send(thread.id, { text: '3', modelId: 'model-b' })
    ])
    expect(outcomes.map((o) => o.kind)).toEqual(['sent', 'queued'])
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(adapter.sessions[1]?.sent.map((i) => i.text)).toEqual(['2'])
    // Since the spec is the same, the next turn is sent to the same process without waking it again.
    finishTurn(thread.id)
    await vi.waitFor(() => expect(adapter.sessions[1]?.sent.map((i) => i.text)).toEqual(['2', '3']))
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
  })

  it('settings_changed が永続化され、開き直しても残る', async () => {
    const thread = await manager.createThread({ modelId: 'model-a' })
    await manager.send(thread.id, { text: '1', modelId: 'model-b', thinking: 'high' })
    await settle()
    const events = (await manager.timeline(thread.id)).events
    const changed = events.filter((e) => e.kind === 'settings_changed')
    expect(changed).toHaveLength(1)
    if (changed[0]?.kind !== 'settings_changed') throw new Error('wrong kind')
    expect(changed[0].payload).toEqual({ modelId: 'model-b', thinking: 'high', scope: 'message', via: 'none' })
    // The line for the switch appears before the message.
    const kinds = events.map((e) => e.kind)
    expect(kinds.indexOf('settings_changed')).toBeLessThan(kinds.indexOf('user_text'))
  })

  it('「以後ずっと」はスレッドの既定も書き換え、同じイベントで残る', async () => {
    const thread = await manager.createThread({ modelId: 'model-a' })
    await manager.send(thread.id, {
      text: '1',
      modelId: 'model-b',
      thinking: 'medium',
      settingsScope: 'thread'
    })
    await settle()
    const summary = summaries.find((s) => s.thread.id === thread.id)
    expect(summary?.thread.modelId).toBe('model-b')
    expect(summary?.thread.thinking).toBe('medium')
    const changed = (await manager.timeline(thread.id)).events.filter((e) => e.kind === 'settings_changed')
    if (changed[0]?.kind !== 'settings_changed') throw new Error('wrong kind')
    expect(changed[0].payload.scope).toBe('thread')
    // It has become the default, so the next message does not wake it again.
    await manager.send(thread.id, { text: '2' })
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('一覧に無いモデルは拒否し、その発言は残らない', async () => {
    const thread = await manager.createThread({})
    await expect(manager.send(thread.id, { text: 'x', modelId: 'no-such' })).rejects.toThrow(
      'aios-reason:model-not-selectable'
    )
    await settle()
    expect((await manager.timeline(thread.id)).events).toHaveLength(0)
    expect(adapter.spawn).not.toHaveBeenCalled()
  })

  it('機能が無いバックエンドでは上書きしても SpawnOptions は null のまま', async () => {
    adapter.features = { 'model-select': false, 'thinking-level': false }
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '1', modelId: 'model-b', thinking: 'high' })
    await manager.send(thread.id, { text: '2' })
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(adapter.spawn.mock.calls[0]?.[0].modelId).toBeNull()
    expect(adapter.spawn.mock.calls[0]?.[0].thinking).toBeNull()
    await settle()
    expect(
      (await manager.timeline(thread.id)).events.filter((e) => e.kind === 'settings_changed')
    ).toHaveLength(0)
  })
})

describe('SessionManager — 所属なし (使い捨て) の捨て場 (T19 / TODO 24)', () => {
  // FsAccess is a mock, so the home can be a real temporary directory (the exclusion rules do not apply).
  let home: string
  beforeEach(async () => {
    await manager.stop()
    home = mkdtempSync(join(tmpdir(), 'aios-scratch-home-'))
    manager = build([adapter], home)
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('cwd は ~/aios/scratch/<threadId> で、履歴には載らず、ディレクトリはまだ無い', async () => {
    const thread = await manager.createThread({ scratch: true })
    const cwd = scratchCwd(home, thread.id)
    expect(thread.cwdUri).toBe(`file://${cwd}`)
    // Reference scope: the default reference scope + cwd (not narrowed; only one scratch area is added).
    expect(thread.allowedDirUris).toContain(`file://${cwd}`)
    expect(thread.allowedDirUris).toContain(`file://${home}/work`)
    expect(thread.allowedDirUris).not.toContain(`file://${home}`)
    expect(db.prepare('SELECT COUNT(*) AS n FROM cwd_history').get()).toEqual({ n: 0 })
    // Merely asking a question does not add an empty directory.
    expect(existsSync(cwd)).toBe(false)
    expect(existsSync(scratchRoot(home))).toBe(false)
  })

  it('cwdUri 省略 = ホーム、の意味は変わらない (scratch を付けないと捨て場にならない)', async () => {
    const thread = await manager.createThread({})
    expect(thread.cwdUri).toBe(`file://${home}`)
    expect(db.prepare('SELECT path FROM cwd_history').all()).toEqual([{ path: home }])
  })

  it('scratch と cwdUri の同時指定は拒否する', async () => {
    await expect(
      manager.createThread({ scratch: true, cwdUri: `file://${home}/work` })
    ).rejects.toThrow('aios-reason:scratch-with-cwd')
  })

  it('ディレクトリは初回の spawn 直前に作られ、SpawnOptions の cwd がそこを指す', async () => {
    const thread = await manager.createThread({ scratch: true })
    const cwd = scratchCwd(home, thread.id)
    let existedAtSpawn: boolean | null = null
    adapter.nextSpawn = async (options, handlers) => {
      existedAtSpawn = existsSync(options.cwd)
      return adapter.spawnOk(options, handlers)
    }
    await manager.send(thread.id, { text: 'hi', attachments: [] })
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(adapter.spawn.mock.calls[0]?.[0].cwd).toBe(cwd)
    expect(existedAtSpawn).toBe(true)
    expect(existsSync(cwd)).toBe(true)
  })

  it('retention = none でも捨て場は作る (ディレクトリは会話ログではない)', async () => {
    const thread = await manager.createThread({ scratch: true })
    manager.setRetention(thread.id, 'none', null)
    await manager.send(thread.id, { text: 'hi', attachments: [] })
    expect(existsSync(scratchCwd(home, thread.id))).toBe(true)
  })

  it('空の捨て場は remove で黙って消える', async () => {
    const thread = await manager.createThread({ scratch: true })
    const cwd = scratchCwd(home, thread.id)
    await manager.send(thread.id, { text: 'hi', attachments: [] })
    expect(existsSync(cwd)).toBe(true)
    const result = await manager.remove(thread.id)
    expect(result).toEqual({ removed: true, scratchEntries: 0 })
    expect(existsSync(cwd)).toBe(false)
    expect(summaries.some((s) => s.thread.id === thread.id)).toBe(false)
  })

  it('まだ作られていない捨て場のスレッドも remove できる (件数 0)', async () => {
    const thread = await manager.createThread({ scratch: true })
    const result = await manager.remove(thread.id)
    expect(result).toEqual({ removed: true, scratchEntries: 0 })
    expect(existsSync(scratchRoot(home))).toBe(false)
  })

  it('TODO 577: 捨て場が読めなければ (ENOTDIR 等) 件数は null で確認に倒し、force で消せる', async () => {
    const thread = await manager.createThread({ scratch: true })
    const cwd = scratchCwd(home, thread.id)
    mkdirSync(scratchRoot(home), { recursive: true })
    // Puts a file in place of the directory: `readdir` fails with anything other than ENOENT (ENOTDIR).
    writeFileSync(cwd, 'not a directory')
    const first = await manager.remove(thread.id)
    expect(first).toEqual({ removed: false, scratchEntries: null })
    expect(summaries.some((s) => s.thread.id === thread.id)).toBe(true)
    const second = await manager.remove(thread.id, { force: true })
    expect(second).toEqual({ removed: true, scratchEntries: null })
    expect(summaries.some((s) => s.thread.id === thread.id)).toBe(false)
  })

  it('中身があれば force 無しでは何も消さず件数を返し、force で中身ごと消える', async () => {
    const thread = await manager.createThread({ scratch: true })
    const cwd = scratchCwd(home, thread.id)
    await manager.send(thread.id, { text: 'hi', attachments: [] })
    writeFileSync(join(cwd, 'out.txt'), 'x')
    mkdirSync(join(cwd, 'sub'))
    writeFileSync(join(cwd, 'sub', 'deep.txt'), 'y')

    const first = await manager.remove(thread.id)
    expect(first).toEqual({ removed: false, scratchEntries: 2 })
    expect(existsSync(join(cwd, 'out.txt'))).toBe(true)
    expect(summaries.some((s) => s.thread.id === thread.id)).toBe(true)
    // Not stopped either (the session stays alive while waiting for confirmation).
    expect(adapter.sessions[0]?.alive).toBe(true)

    const second = await manager.remove(thread.id, { force: true })
    expect(second).toEqual({ removed: true, scratchEntries: 2 })
    expect(existsSync(cwd)).toBe(false)
    expect(summaries.some((s) => s.thread.id === thread.id)).toBe(false)
    expect(adapter.sessions[0]?.alive).toBe(false)
    // The root and the neighboring scratch area remain.
    expect(existsSync(scratchRoot(home))).toBe(true)
  })

  it('捨て場でない cwd のスレッドを消しても、その cwd は消えない (ホーム / 選んだフォルダ)', async () => {
    mkdirSync(join(home, 'work'), { recursive: true })
    writeFileSync(join(home, 'work', 'keep.txt'), 'x')
    const onHome = await manager.createThread({})
    const onWork = await manager.createThread({ cwdUri: `file://${home}/work` })
    expect(await manager.remove(onHome.id)).toEqual({ removed: true, scratchEntries: 0 })
    expect(await manager.remove(onWork.id, { force: true })).toEqual({ removed: true, scratchEntries: 0 })
    expect(existsSync(join(home, 'work', 'keep.txt'))).toBe(true)
    expect(existsSync(home)).toBe(true)
  })

  it('他スレッドの捨て場を cwd に選んだスレッドを消しても、その捨て場は消えない', async () => {
    const owner = await manager.createThread({ scratch: true })
    const cwd = scratchCwd(home, owner.id)
    await manager.send(owner.id, { text: 'hi', attachments: [] })
    writeFileSync(join(cwd, 'out.txt'), 'x')
    // The form where "choose another folder…" selected the owner's scratch area.
    const borrower = await manager.createThread({ cwdUri: `file://${cwd}` })
    expect(await manager.remove(borrower.id, { force: true })).toEqual({ removed: true, scratchEntries: 0 })
    expect(existsSync(join(cwd, 'out.txt'))).toBe(true)
    // The same for a thread whose cwd is the root itself.
    const onRoot = await manager.createThread({ cwdUri: `file://${scratchRoot(home)}` })
    expect(await manager.remove(onRoot.id, { force: true })).toEqual({ removed: true, scratchEntries: 0 })
    expect(existsSync(join(cwd, 'out.txt'))).toBe(true)
  })
})

describe('SessionManager — 削除は論理削除 (項目 64)', () => {
  let home: string
  beforeEach(async () => {
    await manager.stop()
    home = mkdtempSync(join(tmpdir(), 'aios-soft-delete-home-'))
    manager = build([adapter], home)
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('行は deleted_at 付きで残り、一覧・timeline から消え、索引は tombstone、捨て場は実削除', async () => {
    const thread = await manager.createThread({ scratch: true })
    const cwd = scratchCwd(home, thread.id)
    await manager.send(thread.id, { text: 'hi', attachments: [] })
    writeFileSync(join(cwd, 'out.txt'), 'x')

    const before = Date.now()
    expect(await manager.remove(thread.id, { force: true })).toEqual({
      removed: true,
      scratchEntries: 1
    })

    const row = db.prepare(`SELECT deleted_at FROM threads WHERE id = ?`).get(thread.id) as
      | { deleted_at: number | null }
      | undefined
    expect(row?.deleted_at).toBeGreaterThanOrEqual(before)
    expect(summaries.some((s) => s.thread.id === thread.id)).toBe(false)
    expect(manager.listSummaries().some((s) => s.thread.id === thread.id)).toBe(false)
    expect((await manager.timeline(thread.id)).events).toEqual([])
    expect(tombstoned).toContain(thread.id)
    expect(existsSync(cwd)).toBe(false)
    expect(adapter.sessions[0]?.alive).toBe(false)
  })

  it('捨て場を持たないスレッドも同じ (行は残り、cwd には触らない)', async () => {
    mkdirSync(join(home, 'work'), { recursive: true })
    writeFileSync(join(home, 'work', 'keep.txt'), 'x')
    const thread = await manager.createThread({ cwdUri: `file://${home}/work` })
    await manager.remove(thread.id)
    const row = db.prepare(`SELECT deleted_at FROM threads WHERE id = ?`).get(thread.id) as
      | { deleted_at: number | null }
      | undefined
    expect(row?.deleted_at).not.toBeNull()
    expect(tombstoned).toContain(thread.id)
    expect(existsSync(join(home, 'work', 'keep.txt'))).toBe(true)
  })
})

describe('SessionManager — 空のまま残った捨て場の掃除 (T23 / TODO 32)', () => {
  // FsAccess is a mock, so the home can be a real temporary directory (the exclusion rules do not apply).
  let home: string
  let root: string
  const DEAD = '11111111-2222-3333-4444-555555555555'
  const DEAD2 = '66666666-7777-8888-9999-aaaaaaaaaaaa'

  beforeEach(async () => {
    await manager.stop()
    home = mkdtempSync(join(tmpdir(), 'aios-scratch-sweep-'))
    manager = build([adapter], home)
    root = scratchRoot(home)
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  /** Waits until the cleanup that `start()` begins in the background finishes (`stop()` gives up without waiting). */
  async function startAndSweep(): Promise<void> {
    await manager.start()
    await manager.waitForScratchSweep()
  }

  it('根が無ければ何も起きない (捨て場を一度も使っていない場合)', async () => {
    await startAndSweep()
    expect(existsSync(root)).toBe(false)
  })

  it('スレッドの行が無い空の捨て場は消える (作ったが何も書かなかった / rm が失敗した形)', async () => {
    mkdirSync(join(root, DEAD), { recursive: true })
    mkdirSync(join(root, DEAD2), { recursive: true })
    await startAndSweep()
    expect(existsSync(join(root, DEAD))).toBe(false)
    expect(existsSync(join(root, DEAD2))).toBe(false)
    // The root itself remains (the next thread uses it).
    expect(existsSync(root)).toBe(true)
  })

  it('中身があるものは残る (「捨てるつもりが残したくなった」を壊さない)', async () => {
    mkdirSync(join(root, DEAD), { recursive: true })
    writeFileSync(join(root, DEAD, 'out.txt'), 'x')
    mkdirSync(join(root, DEAD2), { recursive: true })
    mkdirSync(join(root, DEAD2, 'sub'))
    await startAndSweep()
    expect(existsSync(join(root, DEAD, 'out.txt'))).toBe(true)
    expect(existsSync(join(root, DEAD2, 'sub'))).toBe(true)
  })

  it('UUID でない名前は空でも残る (人が手で置いたディレクトリ)', async () => {
    mkdirSync(join(root, 'メモ'), { recursive: true })
    mkdirSync(join(root, 'tmp'), { recursive: true })
    mkdirSync(join(root, `${DEAD}.old`), { recursive: true })
    await startAndSweep()
    expect(existsSync(join(root, 'メモ'))).toBe(true)
    expect(existsSync(join(root, 'tmp'))).toBe(true)
    expect(existsSync(join(root, `${DEAD}.old`))).toBe(true)
  })

  it('2 段下は触らない (根の直下しか見ない)', async () => {
    mkdirSync(join(root, DEAD, DEAD2), { recursive: true })
    await startAndSweep()
    // The DEAD directly under the root is not empty (DEAD2 is in it), so it remains, and the empty DEAD2 under it also remains.
    expect(existsSync(join(root, DEAD, DEAD2))).toBe(true)
  })

  it('生きているスレッドの捨て場は空でも残る', async () => {
    const thread = await manager.createThread({ scratch: true })
    await manager.send(thread.id, { text: 'hi', attachments: [] })
    const cwd = scratchCwd(home, thread.id)
    expect(existsSync(cwd)).toBe(true)
    mkdirSync(join(root, DEAD), { recursive: true })
    await startAndSweep()
    expect(existsSync(cwd)).toBe(true)
    expect(existsSync(join(root, DEAD))).toBe(false)
  })

  it('捨て場でない cwd を持つスレッドがあっても、掃除の判定は変わらない', async () => {
    mkdirSync(join(home, 'work'), { recursive: true })
    await manager.createThread({ cwdUri: `file://${home}/work` })
    mkdirSync(join(root, DEAD), { recursive: true })
    await startAndSweep()
    expect(existsSync(join(root, DEAD))).toBe(false)
    expect(existsSync(join(home, 'work'))).toBe(true)
  })

  it('前方一致だけの別名は触らない (~/aios/scratchy, ~/aios/scratch-old)', async () => {
    mkdirSync(join(home, 'aios', 'scratchy', DEAD), { recursive: true })
    mkdirSync(join(home, 'aios', `scratch-old`, DEAD), { recursive: true })
    mkdirSync(join(root, DEAD2), { recursive: true })
    await startAndSweep()
    expect(existsSync(join(home, 'aios', 'scratchy', DEAD))).toBe(true)
    expect(existsSync(join(home, 'aios', 'scratch-old', DEAD))).toBe(true)
    expect(existsSync(join(root, DEAD2))).toBe(false)
  })

  it('ファイルと symlink は消さない (名前が UUID でも)', async () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, DEAD), 'x')
    mkdirSync(join(home, 'elsewhere'))
    symlinkSync(join(home, 'elsewhere'), join(root, DEAD2))
    await startAndSweep()
    expect(existsSync(join(root, DEAD))).toBe(true)
    expect(existsSync(join(root, DEAD2))).toBe(true)
    expect(existsSync(join(home, 'elsewhere'))).toBe(true)
  })
})

describe('SessionManager — コンテキスト使用量 (項目 60)', () => {
  const usage = (
    model: string,
    cacheRead: number,
    actor: 'main' | 'subagent' = 'main'
  ): Parameters<FakeSession['emit']>[0] => ({
    threadId: '',
    kind: 'turn_usage',
    actor,
    payload: { model, inputTokens: 2, outputTokens: 1, cacheCreationTokens: 10, cacheReadTokens: cacheRead }
  })

  async function started(): Promise<{ threadId: string; session: FakeSession }> {
    const thread = await manager.createThread({ modelId: 'model-a' })
    await manager.send(thread.id, { text: 'x' })
    const session = adapter.sessions[0]
    if (session === undefined) throw new Error('no session')
    return { threadId: thread.id, session }
  }

  it('最後に届いた turn_usage が runtime に載り、累積しない。分母は静的表から', async () => {
    const { threadId, session } = await started()
    expect(runtimeOf(threadId).contextUsage).toBeNull()
    session.emit({ ...usage('model-a-full-name', 100), threadId })
    session.emit({ ...usage('model-a-full-name', 200), threadId })
    const current = runtimeOf(threadId).contextUsage
    expect(current?.cacheReadTokens).toBe(200) // Replaced. Not 100 + 200
    expect(current?.inputTokens).toBe(2)
    expect(current?.contextWindow).toBe(1000)
    expect(current?.windowSource).toBe('table')
  })

  it('サブエージェントの turn_usage は親のコンテキストに数えない', async () => {
    const { threadId, session } = await started()
    session.emit({ ...usage('model-a-full-name', 100), threadId })
    session.emit({ ...usage('model-a-full-name', 999, 'subagent'), threadId })
    expect(runtimeOf(threadId).contextUsage?.cacheReadTokens).toBe(100)
  })

  it('表に無いモデルは分母 null (円グラフ非表示)、result の報告が来たら上書きされる (項目 74)', async () => {
    const { threadId, session } = await started()
    session.emit({ ...usage('model-unknown', 100), threadId })
    expect(runtimeOf(threadId).contextUsage?.contextWindow).toBeNull()
    session.emit({
      threadId,
      kind: 'result',
      payload: { ...RESULT, contextWindows: [{ model: 'model-unknown', contextWindow: 5000 }] }
    })
    const current = runtimeOf(threadId).contextUsage
    expect(current?.contextWindow).toBe(5000)
    expect(current?.windowSource).toBe('reported')
    // Later turn_usage also uses the reported value as the denominator (newer than the table).
    session.emit({ ...usage('model-unknown', 300), threadId })
    expect(runtimeOf(threadId).contextUsage).toMatchObject({
      cacheReadTokens: 300,
      contextWindow: 5000,
      windowSource: 'reported'
    })
  })

  it('再起動後は最後に保存した turn_usage から復元する', async () => {
    const { threadId, session } = await started()
    session.emit({ ...usage('model-a-full-name', 100), threadId })
    session.emit({ ...usage('model-a-full-name', 250), threadId })
    await settle()
    await manager.stop()
    manager = build([new FakeAdapter()])
    // Listing the summaries makes the runtime get assembled (only the first time reads the DB).
    manager.listSummaries()
    const again = manager.listSummaries().find((s) => s.thread.id === threadId)
    expect(again?.runtime.contextUsage).toMatchObject({
      model: 'model-a-full-name',
      cacheReadTokens: 250,
      contextWindow: 1000,
      windowSource: 'table'
    })
  })
})

describe('SessionManager — ViewerPane の記憶 (項目 63)', () => {
  const viewerOf = (threadId: string): ThreadSummary['thread'] | undefined =>
    summaries.find((s) => s.thread.id === threadId)?.thread

  it('file: の URI と検索語を書き、一覧を配り直す', async () => {
    const thread = await manager.createThread({})
    manager.setViewerState(thread.id, 'file:///Users/tester/work/a.cpp', '  needle  ')
    expect(viewerOf(thread.id)?.lastViewerUri).toBe('file:///Users/tester/work/a.cpp')
    expect(viewerOf(thread.id)?.lastViewerHighlight).toBe('needle')
  })

  it('閉じた (null) は検索語ごと無しになる (項目 70)', async () => {
    const thread = await manager.createThread({})
    manager.setViewerState(thread.id, 'file:///Users/tester/work/a.cpp', 'q')
    manager.setViewerState(thread.id, null, 'q')
    expect(viewerOf(thread.id)?.lastViewerUri).toBeNull()
    expect(viewerOf(thread.id)?.lastViewerHighlight).toBeNull()
  })

  it('file: 以外・除外規則に当たるパスは書かない (前の記憶のまま)', async () => {
    const thread = await manager.createThread({})
    manager.setViewerState(thread.id, 'file:///Users/tester/work/a.cpp', null)
    manager.setViewerState(thread.id, 'ftp://example.com/x', null)
    manager.setViewerState(thread.id, 'javascript:alert(1)', null)
    manager.setViewerState(thread.id, 'file:///Users/tester/excluded/secret', null)
    expect(viewerOf(thread.id)?.lastViewerUri).toBe('file:///Users/tester/work/a.cpp')
  })

  it('web ページ (TODO 400): http(s) の URL は覚える (検索語は持たない)。資格情報・秘密入りは覚えない', async () => {
    const thread = await manager.createThread({})
    manager.setViewerState(thread.id, 'https://example.com/docs?q=1', 'term')
    expect(viewerOf(thread.id)?.lastViewerUri).toBe('https://example.com/docs?q=1')
    expect(viewerOf(thread.id)?.lastViewerHighlight).toBeNull()
    manager.setViewerState(thread.id, 'https://user:pass@example.com/', null)
    manager.setViewerState(thread.id, `https://example.com/?key=AIza${'a'.repeat(35)}`, null)
    expect(viewerOf(thread.id)?.lastViewerUri).toBe('https://example.com/docs?q=1')
  })

  it('検索語は上限で切り、空白だけなら無し', async () => {
    const thread = await manager.createThread({})
    manager.setViewerState(thread.id, 'file:///Users/tester/work/a.cpp', 'x'.repeat(1000))
    expect(viewerOf(thread.id)?.lastViewerHighlight?.length).toBe(200)
    manager.setViewerState(thread.id, 'file:///Users/tester/work/a.cpp', '   ')
    expect(viewerOf(thread.id)?.lastViewerHighlight).toBeNull()
  })

  it('無いスレッドには何もしない', () => {
    expect(() => manager.setViewerState('no-such-thread', null, null)).not.toThrow()
  })
})

describe('SessionManager — 一覧の差分配信 (項目 75)', () => {
  async function started(): Promise<{ threadId: string; session: FakeSession }> {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hi' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    // The cumulative total is keyed by the backend's session ID, so `session_started` is needed.
    session.emit({
      threadId: thread.id,
      kind: 'session_started',
      payload: {
        backendSessionId: `backend-${thread.id}`,
        backendVersion: null,
        model: null,
        cwd: null,
        reportedPermissionMode: null,
        tools: [],
        toolServers: [],
        resumed: false
      }
    })
    await settle()
    return { threadId: thread.id, session }
  }

  it('turn_usage / result / error は 1 件だけ配り、全件は配らない', async () => {
    const other = await manager.createThread({ title: '別' })
    const { threadId, session } = await started()
    fullLists = 0
    threadChanges = []

    session.emit({
      threadId,
      kind: 'turn_usage',
      payload: { model: 'model-a-full-name', inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 5 }
    })
    session.emit({ threadId, kind: 'result', payload: RESULT })
    session.emit({ threadId, kind: 'error', payload: { message: 'x', code: null, origin: 'exit' } } as Parameters<FakeSession['emit']>[0])

    expect(fullLists).toBe(0)
    expect(threadChanges.length).toBeGreaterThanOrEqual(3)
    // Only the changed thread. Rows of other threads are not sent.
    expect(new Set(threadChanges)).toEqual(new Set([threadId]))
    expect(threadChanges).not.toContain(other.id)
    // The runtime is up to date with one delivery alone (the cumulative total comes from the threads' columns).
    expect(runtimeOf(threadId).turns).toBe(1)
    expect(runtimeOf(threadId).costUsd).toBeCloseTo(RESULT.costUsd, 10)
    expect(runtimeOf(threadId).contextUsage?.cacheReadTokens).toBe(5)
    expect(runtimeOf(threadId).state).toBe('error')
  })

  it('既読・表示の記憶・停止も 1 件。作成・改名・削除は全件', async () => {
    const { threadId, session } = await started()
    focusedViews = new Set()
    session.emit({ threadId, kind: 'result', payload: RESULT })
    fullLists = 0
    threadChanges = []

    focusedViews = null
    manager.openThread(threadId, 1)
    manager.setViewerState(threadId, 'file:///Users/tester/work/a.md', null)
    await manager.stopThread(threadId)
    expect(fullLists).toBe(0)
    expect(threadChanges.filter((id) => id === threadId).length).toBeGreaterThanOrEqual(3)
    expect(summaries.find((s) => s.thread.id === threadId)?.thread.unread).toBe(false)

    manager.rename(threadId, '改名')
    expect(fullLists).toBe(1)
    const created = await manager.createThread({})
    expect(fullLists).toBe(2)
    await manager.remove(created.id)
    expect(fullLists).toBe(3)
  })

  it('listSummaries は累積とプレビューを列から返す (sessions / thread_events を数え直さない)', async () => {
    const { threadId, session } = await started()
    session.emit({ threadId, kind: 'assistant_text', payload: { text: '回答  です' } } as Parameters<FakeSession['emit']>[0])
    session.emit({ threadId, kind: 'result', payload: RESULT })
    session.emit({ threadId, kind: 'result', payload: RESULT })
    await settle()
    const summary = manager.listSummaries().find((s) => s.thread.id === threadId)
    expect(summary?.preview).toBe('回答 です')
    expect(summary?.runtime.turns).toBe(2)
    expect(summary?.runtime.costUsd).toBeCloseTo(RESULT.costUsd * 2, 10)
  })

  it('TODO 686: ターンの終わりの回答は、保存の後の 1 件の配信で一覧の行に届く (表示中のスレッドでも)', async () => {
    const { threadId, session } = await started()
    // While being shown (kept as read): a shape where the path that sets unread does not deliver it again later.
    manager.openThread(threadId, 1)
    await settle()
    threadChanges = []
    // As in the real thing, the last answer and the `result` go into the same 16 ms batch (the delivery of `result` comes before the save).
    session.emit({ threadId, kind: 'assistant_text', payload: { text: '新しい 回答' } } as Parameters<FakeSession['emit']>[0])
    session.emit({ threadId, kind: 'result', payload: RESULT })
    await settle()
    const pushed = summaries.find((s) => s.thread.id === threadId)
    expect(pushed?.preview).toBe('新しい 回答')
    expect(pushed?.thread.unread).toBe(false)
    // The same right after a message is sent (the sent sentence becomes material for the third stage).
    threadChanges = []
    await manager.send(threadId, { text: '次の 質問' })
    await settle()
    expect(summaries.find((s) => s.thread.id === threadId)?.preview).toBe('次の 質問')
    expect(threadChanges).toContain(threadId)
  })
})

describe('SessionManager — 未知バージョンの probe (項目 81)', () => {
  it('初回の送信の前に probe が 1 回だけ走り、結果が機能表に反映されてから spawn する', async () => {
    adapter.unknownVersion = true
    // Result of probe: the flag for the model choice was not accepted.
    adapter.probeFeatures = { 'model-select': false }
    const a = await manager.createThread({})
    const b = await manager.createThread({})
    // Even if sent from two threads at the same time, probe runs only once (it shares the running Promise).
    await Promise.all([
      manager.send(a.id, { text: 'a', modelId: 'model-a' }),
      manager.send(b.id, { text: 'b', modelId: 'model-a' })
    ])
    expect(adapter.probe).toHaveBeenCalledTimes(1)
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    // probe happens before spawn.
    const probeOrder = adapter.probe.mock.invocationCallOrder[0] ?? Infinity
    for (const order of adapter.spawn.mock.invocationCallOrder) expect(order).toBeGreaterThan(probeOrder)
    // It is launched with the feature table that was confirmed (no model is passed, since model-select is absent).
    for (const call of adapter.spawn.mock.calls) expect(call[0].modelId).toBeNull()
    // The gateway connection info is made from the same source as a real session.
    expect(adapter.probeGateways).toHaveLength(1)
    expect(adapter.probeGateways[0]?.socketPath).toBe('/tmp/aios-test.sock')
    expect(adapter.probeGateways[0]?.configDir).toBe('/tmp/aios-test-mcp')
    expect((await manager.agentStatus()).needsProbe).toBe(false)

    // Does not run on the second and later sends.
    await manager.send(a.id, { text: 'a2' })
    expect(adapter.probe).toHaveBeenCalledTimes(1)
  })

  it('既知バージョン (またはキャッシュ済み) では probe を呼ばない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'x' })
    expect(adapter.probe).not.toHaveBeenCalled()
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('probe が失敗しても送信は止めない (仮の機能表のまま起動する)', async () => {
    adapter.unknownVersion = true
    adapter.probeFeatures = null
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'x' })
    expect(adapter.probe).toHaveBeenCalledTimes(1)
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(adapter.sessions[0]?.sent.map((i) => i.text)).toEqual(['x'])
  })

  it('TODO 943: probeInBackground は裏で 1 回だけ走らせ、その間の送信は同じ probe に相乗りする', async () => {
    adapter.unknownVersion = true
    adapter.probeFeatures = { 'model-select': false }
    manager.probeInBackground()
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'x' })
    expect(adapter.probe).toHaveBeenCalledTimes(1)
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    // Calling it after it has finished does not run it.
    manager.probeInBackground()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(adapter.probe).toHaveBeenCalledTimes(1)
  })

  it('TODO 943: 既知の版では probeInBackground は何もしない', async () => {
    manager.probeInBackground()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(adapter.probe).not.toHaveBeenCalled()
  })

  it('probe が throw しても送信は止めない', async () => {
    adapter.unknownVersion = true
    adapter.probe.mockImplementationOnce(async () => {
      adapter.unknownVersion = false
      throw new Error('予期しない失敗')
    })
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'x' })
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })
})

describe('SessionManager — stdin の書き込み失敗 (項目 82)', () => {
  it('session.send が throw しても送信は失敗にせず、stream の error としてタイムラインに出す', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '一つ目' })
    const session = adapter.sessions[0]
    if (session === undefined) throw new Error('no session')
    finishTurn(thread.id)
    session.throwOnSend = true
    await expect(manager.send(thread.id, { text: '二つ目' })).resolves.toEqual({ kind: 'sent' })
    await settle()
    const errors = (await manager.timeline(thread.id)).events.filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.kind === 'error' && errors[0].payload.origin).toBe('stream')
    expect(runtimeOf(thread.id).state).toBe('error')
  })

  it('stream の error イベント (EPIPE) は状態を error にして記録するだけで、落ちない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'x' })
    adapter.sessions[0]?.emit({
      threadId: thread.id,
      kind: 'error',
      payload: { message: 'write EPIPE', code: 'EPIPE', origin: 'stream' }
    })
    await settle()
    expect(runtimeOf(thread.id).state).toBe('error')
    const errors = (await manager.timeline(thread.id)).events.filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(1)
  })
})

describe('SessionManager — IPC / gateway の値の検証 (項目 86)', () => {
  it('設定の並走上限・アイドル停止は安全な整数で範囲内だけ。NaN で上限が外れない', () => {
    const before = manager.getSettings()
    for (const maxConcurrent of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, 0, -1, before.maxConcurrentCap + 1]) {
      expect(() => manager.setSettings({ maxConcurrent })).toThrow('aios-reason:invalid-value')
    }
    for (const idleTimeoutMs of [Number.NaN, 59_999, 90_000.5]) {
      expect(() => manager.setSettings({ idleTimeoutMs })).toThrow('aios-reason:invalid-value')
    }
    // A rejected value writes nothing (nor does part of it take effect).
    expect(() => manager.setSettings({ maxConcurrent: 3, idleTimeoutMs: Number.NaN })).toThrow()
    expect(manager.getSettings()).toEqual(before)

    expect(manager.setSettings({ maxConcurrent: before.maxConcurrentCap, idleTimeoutMs: 60_000 })).toMatchObject({
      maxConcurrent: before.maxConcurrentCap,
      idleTimeoutMs: 60_000
    })
  })

  it('保存済みの壊れた値 (以前の NaN は JSON で null) は既定に戻して読む', () => {
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('session', ?)`).run(
      JSON.stringify({ maxConcurrent: null, idleTimeoutMs: 1.5 })
    )
    const reloaded = build([adapter])
    expect(reloaded.getSettings().maxConcurrent).toBe(5)
    expect(reloaded.getSettings().idleTimeoutMs).toBe(20 * 60 * 1000)
  })

  it('retention の日数は 1 以上の整数だけ。0 や負数でその場の全消しが起きない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '残る発言' })
    await settle()
    for (const days of [0, -3, 1.5, Number.NaN, null]) {
      expect(() => manager.setRetention(thread.id, 'days', days)).toThrow('aios-reason:invalid-value')
    }
    expect((await manager.timeline(thread.id)).events.filter((e) => e.kind === 'user_text')).toHaveLength(1)

    manager.setRetention(thread.id, 'days', 7)
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread).toMatchObject({
      retention: 'days',
      retentionDays: 7
    })
    // Anything other than 'days' has no day count.
    manager.setRetention(thread.id, 'forever', 7)
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread.retentionDays).toBeNull()
  })

  it('作成時の題名は改名と同じ 120 文字で切り、空白だけなら仮題にする', async () => {
    const long = await manager.createThread({ title: `  ${'あ'.repeat(500)}  ` })
    expect(long.title).toBe('あ'.repeat(120))
    const blank = await manager.createThread({ title: '   ' })
    expect(blank.title).toBe('')
    // The provisional title is named by the first send.
    await manager.send(blank.id, { text: '\n最初の行\n二行目' })
    expect(summaries.find((s) => s.thread.id === blank.id)?.thread.title).toBe('最初の行')
  })

  it('gateway の検索の source は fs / conversation / transcript だけ', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hi' })
    const sessionId = adapter.sessions[0]!.sessionId
    const search = (source: unknown): Promise<unknown> =>
      manager.handleGatewayRequest({ sessionId, kind: 'search', payload: { query: 'q', source } })

    await search('transcript')
    await search('')
    await search(undefined)
    expect(searchedSources).toEqual([['transcript'], undefined, undefined])
    for (const bad of ['documents', 'fs OR 1', 42, ['fs']]) {
      await expect(search(bad)).rejects.toThrow('aios-reason:invalid-value')
    }
    expect(searchedSources).toHaveLength(3)
  })

  it('TODO 1225: 有効な拡張機能が宣言した source でも絞れる。宣言に無い拡張機能の source は断る', async () => {
    await manager.stop()
    manager = new SessionManager({
      ...(manager as unknown as { deps: SessionManagerDeps }).deps,
      pluginIndexSources: () => ['aios.gmail']
    })
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hi' })
    const sessionId = adapter.sessions.at(-1)!.sessionId
    const search = (source: unknown): Promise<unknown> =>
      manager.handleGatewayRequest({ sessionId, kind: 'search', payload: { query: 'q', source } })
    await search('aios.gmail')
    expect(searchedSources).toEqual([['aios.gmail']])
    for (const bad of ['aios.bitbucket', 'aios.gmail:other', 'aios.gmailx']) {
      await expect(search(bad)).rejects.toThrow('aios-reason:invalid-value')
    }
  })
})

describe('SessionManager — 列ごとの更新と一覧の並び (項目 83)', () => {
  it('既読にする・厳格モードを切り替えるだけでは先頭へ跳ねない。送ると先頭へ来る', async () => {
    const a = await manager.createThread({ title: 'a' })
    await manager.createThread({ title: 'b' })
    db.prepare(`UPDATE threads SET created_at = CASE id WHEN ? THEN 1 ELSE 2 END`).run(a.id)
    const order = (): string[] => manager.listSummaries().map((s) => s.thread.title)
    expect(order()).toEqual(['b', 'a'])

    db.prepare(`UPDATE threads SET unread = 1 WHERE id = ?`).run(a.id)
    manager.openThread(a.id, 1)
    manager.setApprovalStrict(a.id, true)
    manager.allowDir(a.id, 'file:///Users/tester/extra')
    expect(order()).toEqual(['b', 'a'])
    expect(manager.listSummaries().find((s) => s.thread.id === a.id)?.thread).toMatchObject({
      unread: false,
      approvalStrict: true
    })

    await manager.send(a.id, { text: '送る' })
    expect(order()).toEqual(['a', 'b'])
    // The title was set by hand, so it does not change when sent.
    expect(manager.listSummaries()[0]?.thread.title).toBe('a')
  })

  it('TODO 994: 厳格モードを切ると「この会話では Bash を聞かない」を忘れる (入れたときは触らない)', async () => {
    const a = await manager.createThread({ title: 'a' })
    const broker = (manager as unknown as { broker: { forgetThread(threadId: string): void } }).broker
    const forget = vi.spyOn(broker, 'forgetThread')
    manager.setApprovalStrict(a.id, true)
    expect(forget).not.toHaveBeenCalled()
    manager.setApprovalStrict(a.id, false)
    expect(forget).toHaveBeenCalledWith(a.id)
  })

  it('TODO 600: 参照範囲に足せないフォルダは理由コードで投げる (黙って返さない)。足せるものは足す', async () => {
    const a = await manager.createThread({ title: 'a' })
    const before = a.allowedDirUris
    expect(() => manager.allowDir(a.id, 'file:///Users/tester/excluded')).toThrow(
      'aios-reason:allow-dir-excluded'
    )
    expect(manager.listSummaries().find((s) => s.thread.id === a.id)?.thread.allowedDirUris).toEqual(before)
    expect(manager.allowDir(a.id, 'file:///tmp/x')?.allowedDirUris).toEqual([...before, 'file:///tmp/x'])
  })

  it('手で「新しいスレッド」と付けた題名は、次の送信で上書きされない', async () => {
    const thread = await manager.createThread({})
    manager.rename(thread.id, '新しいスレッド')
    await manager.send(thread.id, { text: '上書きしないで' })
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread.title).toBe('新しいスレッド')
  })

  it('空の題名での改名は仮題に戻し、次の送信でまた名付ける', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '一つ目' })
    finishTurn(thread.id)
    manager.rename(thread.id, '   ')
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread.title).toBe('')
    await manager.send(thread.id, { text: '二つ目' })
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread.title).toBe('二つ目')
  })

  it('TODO 608: 添付つきの最初の発言は、印の行を飛ばした本文の行で名付ける。本文が添付だけなら添付の名前', async () => {
    const image = {
      uri: 'aios-clipboard:00000000-0000-0000-0000-000000000608',
      name: 'shot.png',
      kind: 'image' as const,
      mediaType: 'image/png',
      base64: Buffer.from('fake').toString('base64'),
      bytes: 4
    }
    const withText = await manager.createThread({})
    await manager.send(withText.id, { text: '見て', attachments: [image] })
    expect(summaries.find((s) => s.thread.id === withText.id)?.thread.title).toBe('見て')

    const attachmentOnly = await manager.createThread({})
    await manager.send(attachmentOnly.id, { text: '', attachments: [image] })
    expect(summaries.find((s) => s.thread.id === attachmentOnly.id)?.thread.title).toBe('shot.png')
  })

  it('code-review (608): 名前に括弧を含む画像 (image (1).png) でも印を飛ばして名付ける', async () => {
    const image = {
      uri: 'aios-clipboard:00000000-0000-0000-0000-000000000609',
      name: 'スクリーンショット (2).png',
      kind: 'image' as const,
      mediaType: 'image/png',
      base64: Buffer.from('fake').toString('base64'),
      bytes: 4
    }
    const withText = await manager.createThread({})
    await manager.send(withText.id, { text: '見て', attachments: [image] })
    expect(summaries.find((s) => s.thread.id === withText.id)?.thread.title).toBe('見て')

    const attachmentOnly = await manager.createThread({})
    await manager.send(attachmentOnly.id, { text: '', attachments: [image] })
    expect(summaries.find((s) => s.thread.id === attachmentOnly.id)?.thread.title).toBe('スクリーンショット (2).png')
  })
})

describe('SessionManager — コマンド一覧とタイムラインのページ (項目 68 / 88)', () => {
  function startedWith(session: FakeSession, threadId: string, commands: readonly string[] | null): void {
    session.emit({
      threadId,
      kind: 'session_started',
      payload: {
        backendSessionId: `backend-${threadId}`,
        backendVersion: null,
        model: null,
        cwd: null,
        reportedPermissionMode: null,
        tools: [],
        toolServers: [],
        resumed: false,
        commands
      }
    })
  }

  it('起動直後は一覧を知らない (null)。session_started の一覧をバックエンド単位で控える', async () => {
    expect((await manager.backends())[0]?.commands).toBeNull()
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hi' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    startedWith(session, thread.id, ['compact', 'context'])
    await settle()
    expect((await manager.backends())[0]?.commands).toEqual(['compact', 'context'])
    // The thread's own list remains as the payload of session_started (it can be looked up even after reopening).
    const init = (await manager.timeline(thread.id)).events.find((e) => e.kind === 'session_started')
    expect(init?.kind === 'session_started' && init.payload.commands).toEqual(['compact', 'context'])
  })

  it('一覧を報告しない版 (null) は控えを消さない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hi' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    startedWith(session, thread.id, ['compact'])
    startedWith(session, thread.id, null)
    await settle()
    expect((await manager.backends())[0]?.commands).toEqual(['compact'])
  })

  it('backends() は cwd 履歴を読まず、createOptions と同じバックエンドを返す', async () => {
    const options = await manager.createOptions()
    const light = await manager.backends()
    expect(light).toEqual(options.backends)
  })

  it('「さらに読む」は seq < before を新しい側から 1 ページ、古い順で返し、残りを数える', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'hi' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    for (let i = 0; i < 9; i++) {
      session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: `a${i}` } })
    }
    await settle()
    const all = await manager.timeline(thread.id)
    // One user_text from the send + 9 others. All fit in one page, so the remainder is 0.
    expect(all.events).toHaveLength(10)
    expect(all.remaining).toBe(0)
    expect(all.oldestSeq).not.toBeNull()

    // seq is numbered from 1. The seq of the last one (a8) is oldestSeq + 9. Three entries before the two preceding it.
    const lastSeq = (all.oldestSeq ?? 0) + all.events.length - 1
    const page = (await manager.timelineBefore(thread.id, lastSeq - 1, 3))
    expect(page.events.map((e) => (e.kind === 'assistant_text' ? e.payload.text : e.kind))).toEqual([
      'a4',
      'a5',
      'a6'
    ])
    expect(page.remaining).toBe(5)
    const next = (await manager.timelineBefore(thread.id, page.oldestSeq ?? 0, 100))
    expect(next.events).toHaveLength(5)
    expect(next.remaining).toBe(0)
    // Before the head it is empty, and there is no position either.
    const none = (await manager.timelineBefore(thread.id, next.oldestSeq ?? 0))
    expect(none.events).toHaveLength(0)
    expect(none.oldestSeq).toBeNull()
    expect(none.remaining).toBe(0)
  })

  it('PDF の書き出し (TODO 818) は最初のページより前まで全件を読み、1 問 1 答に組む', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'first' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    // Makes it more than the first page (TIMELINE_LIMIT = 2,000 rows), so the head message is read from the second page.
    for (let i = 0; i < 2_100; i++) {
      session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: `a${i}` } })
    }
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    await manager.send(thread.id, { text: 'second' })
    session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: 'done' } })
    await settle()
    expect((await manager.timeline(thread.id)).remaining).toBeGreaterThan(0)
    const exported = await manager.exportTurns(thread.id)
    expect(exported.turns.map((turn) => [turn.number, turn.question?.text ?? null, turn.answers.length])).toEqual([
      [1, 'first', 2_100],
      [2, 'second', 1]
    ])
    expect(exported.turns[0]?.answers[0]).toBe('a0')
    expect(manager.threadTitle(thread.id)).not.toBeNull()
    expect((await manager.exportTurns('no-such-thread')).turns).toEqual([])
    // TODO 866: the base for relative image paths in an HTML export is the working folder. An unknown thread gives null.
    expect(manager.threadWorkingCwd(thread.id)).toBe(uriToPath(thread.cwdUri))
    expect(manager.threadWorkingCwd('no-such-thread')).toBeNull()
  })

  it('「さらに読む」の件数は 1 ページに丸め、消えたスレッドは空で返す', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'a' })
    await manager.send(thread.id, { text: 'b' })
    await settle()
    // Even when asked for 0 entries, one is returned (lower limit 1).
    expect((await manager.timelineBefore(thread.id, 1_000, 0)).events).toHaveLength(1)
    expect((await manager.timelineBefore('no-such-thread', 10)).oldestSeq).toBeNull()
  })
})

describe('SessionManager — 仮題は言語に依らない印 (TODO 66)', () => {
  const row = (id: string): { title: string; title_auto: number } =>
    db.prepare(`SELECT title, title_auto FROM threads WHERE id = ?`).get(id) as {
      title: string
      title_auto: number
    }

  it('新しいスレッドは DB に空文字列の題名と title_auto = 1 を書く (日本語を書かない)', async () => {
    const thread = await manager.createThread({})
    expect(thread.title).toBe('')
    expect(row(thread.id)).toEqual({ title: '', title_auto: 1 })
    // An empty rename also goes back to the same mark.
    manager.rename(thread.id, '名前')
    manager.rename(thread.id, '  ')
    expect(row(thread.id)).toEqual({ title: '', title_auto: 1 })
  })

  it('以前の DB に残る「新しいスレッド」(title_auto = 1) は空文字列として読み出す', async () => {
    const thread = await manager.createThread({})
    db.prepare(`UPDATE threads SET title = '新しいスレッド' WHERE id = ?`).run(thread.id)
    const listed = manager.listSummaries().find((s) => s.thread.id === thread.id)?.thread
    expect(listed?.title).toBe('')
    // The title of a conversation that is a search hit (the entry point the index process looks up by RPC) gets the same mark too.
    const store = new ThreadStore(db, '/Users/tester')
    expect(store.threadTitle(thread.id)).toBe('')
    expect(store.getThread(thread.id)?.title).toBe('')
    // It is still the provisional title, so it is named by the next send (the decision is made by a column; the string is not looked at).
    await manager.send(thread.id, { text: '名付ける' })
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread.title).toBe('名付ける')
    expect(row(thread.id)).toEqual({ title: '名付ける', title_auto: 0 })
  })

  it('手で「新しいスレッド」と付けた題名 (title_auto = 0) は仮題の印に寄せない', async () => {
    const thread = await manager.createThread({})
    manager.rename(thread.id, '新しいスレッド')
    expect(row(thread.id)).toEqual({ title: '新しいスレッド', title_auto: 0 })
    expect(manager.listSummaries().find((s) => s.thread.id === thread.id)?.thread.title).toBe(
      '新しいスレッド'
    )
    expect(new ThreadStore(db, '/Users/tester').threadTitle(thread.id)).toBe('新しいスレッド')
  })
})

describe('SessionManager — 裏で動く子エージェントと追い出し (項目 93)', () => {
  const started = (taskId: string, isSubagent = true): Parameters<FakeSession['emit']>[0] => ({
    threadId: '',
    kind: 'subtask_started',
    payload: {
      taskId,
      toolUseId: `tu-${taskId}`,
      description: `子 ${taskId}`,
      subagentType: isSubagent ? 'general-purpose' : null,
      isSubagent,
      isBackgroundShell: false
    }
  })
  const finished = (taskId: string): Parameters<FakeSession['emit']>[0] => ({
    threadId: '',
    kind: 'subtask_finished',
    payload: {
      taskId,
      toolUseId: `tu-${taskId}`,
      status: 'completed',
      summary: null,
      usage: { totalTokens: 10, toolUses: 1, durationMs: 5 },
      outputFile: null
    }
  })

  /** A thread sent once (no `result` has arrived yet). */
  async function sentThread(): Promise<{ threadId: string; session: FakeSession }> {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '子を 2 本走らせて' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    return { threadId: thread.id, session }
  }

  /** Runs the thinning decision (the sweep every 60 seconds) once, with the clock advanced. */
  function sweepAfter(ms: number): void {
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + ms)
    try {
      ;(manager as unknown as { sweepIdle(): void }).sweepIdle()
    } finally {
      spy.mockRestore()
    }
  }

  it('result の後も子が残っていれば idle にはなるが、アイドルの時間切れで追い出されない', async () => {
    manager.setSettings({ idleTimeoutMs: 60_000 })
    const { threadId, session } = await sentThread()
    session.emit({ ...started('a'), threadId })
    session.emit({ ...started('b'), threadId })
    session.emit({ threadId, kind: 'result', payload: RESULT })
    // State names are not increased. The number of children is carried separately in the runtime.
    expect(runtimeOf(threadId).state).toBe('idle')
    expect(runtimeOf(threadId).subtasks).toHaveLength(2)

    sweepAfter(10 * 60_000)
    expect(session.alive).toBe(true)

    session.emit({ ...finished('a'), threadId })
    expect(runtimeOf(threadId).subtasks).toHaveLength(1)
    sweepAfter(10 * 60_000)
    expect(session.alive).toBe(true)

    // Once the last child finishes, it can be evicted as usual.
    session.emit({ ...finished('b'), threadId })
    expect(runtimeOf(threadId).subtasks).toHaveLength(0)
    sweepAfter(10 * 60_000)
    expect(session.alive).toBe(false)
  })

  it('項目 322: 子が残ったままプロセスが落ちても (異常終了・再起動)、subtasks は 0 に戻り 1 件配信が届く', async () => {
    const { threadId, session } = await sentThread()
    session.emit({ ...started('a'), threadId })
    session.emit({ ...started('b'), threadId })
    session.emit({ threadId, kind: 'result', payload: RESULT })
    expect(runtimeOf(threadId).subtasks).toHaveLength(2)
    threadChanges.length = 0

    // Dies without emitting `result` (other abnormal exits take the same path, and the whole `Live` is removed).
    session.abort()

    expect(runtimeOf(threadId).live).toBe(false)
    expect(runtimeOf(threadId).subtasks).toHaveLength(0)
    // Does not circulate forever: checks that a single delivery to a list row has arrived (item 75).
    expect(threadChanges).toContain(threadId)
  })

  it('並走数の上限でも、子が動いているセッションは追い出し候補に入らない', async () => {
    manager.setSettings({ maxConcurrent: 1 })
    const first = await sentThread()
    first.session.emit({ ...started('a'), threadId: first.threadId })
    first.session.emit({ threadId: first.threadId, kind: 'result', payload: RESULT })

    const other = await manager.createThread({})
    await expect(manager.send(other.id, { text: '別のスレッド' })).rejects.toThrow(
      'aios-reason:concurrency-limit'
    )
    expect(first.session.alive).toBe(true)

    first.session.emit({ ...finished('a'), threadId: first.threadId })
    await manager.send(other.id, { text: '別のスレッド' })
    expect(first.session.alive).toBe(false)
    expect(adapter.sessions.at(-1)?.sent.map((i) => i.text)).toEqual(['別のスレッド'])
  })

  it('TODO 840: 上限 1 で 2 スレッドへほぼ同時に送ると、起動中を数えて 2 本目は concurrency-limit (上限を超えない)', async () => {
    manager.setSettings({ maxConcurrent: 1 })
    // Releases spawn from outside (imitates taking 1 to 2 seconds, including the gateway startup).
    const releases: (() => void)[] = []
    adapter.nextSpawn = async (options, handlers) => {
      await new Promise<void>((resolve) => releases.push(resolve))
      const session = new FakeSession(options.sessionId, handlers)
      adapter.sessions.push(session)
      return session
    }
    const a = await manager.createThread({})
    const b = await manager.createThread({})
    const sendA = manager.send(a.id, { text: 'A' })
    const sendB = manager.send(b.id, { text: 'B' })
    const settledB = sendB.then(
      () => 'ok',
      (err: Error) => err.message
    )
    // A takes a slot and waits for spawn. Since it is starting, the advance judgment of scheduled runs is also "no room".
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    expect(manager.hasSessionRoom()).toBe(false)
    expect(await settledB).toContain('aios-reason:concurrency-limit')
    releases.shift()?.()
    await sendA
    expect(adapter.sessions).toHaveLength(1)
    expect(adapter.sessions.filter((s) => s.alive)).toHaveLength(1)
  })

  it('TODO 840: 追い出しを待つ間に来た別の起動は、追い出し中のものを数えて上限を超えない', async () => {
    manager.setSettings({ maxConcurrent: 1 })
    const first = await sentThread()
    first.session.emit({ threadId: first.threadId, kind: 'result', payload: RESULT })
    // Releases the eviction (stop) from outside.
    let releaseStop = (): void => undefined
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const originalStop = first.session.stop.bind(first.session)
    first.session.stop = async () => {
      await stopGate
      await originalStop()
    }
    const b = await manager.createThread({})
    const c = await manager.createThread({})
    const sendB = manager.send(b.id, { text: 'B' })
    const sendC = manager.send(c.id, { text: 'C' })
    const settledC = sendC.then(
      () => 'ok',
      (err: Error) => err.message
    )
    expect(await settledC).toContain('aios-reason:concurrency-limit')
    releaseStop()
    await sendB
    expect(adapter.sessions.filter((s) => s.alive)).toHaveLength(1)
    expect(adapter.sessions.at(-1)?.sent.map((i) => i.text)).toEqual(['B'])
  })

  it('第 41 波 code-review: 追い出しの 1 つが失敗しても、他の追い出しが終わるまで待ってから最初の理由で投げる', async () => {
    manager.setSettings({ maxConcurrent: 3 })
    const sent = [await sentThread(), await sentThread(), await sentThread()]
    for (const { threadId, session } of sent) session.emit({ threadId, kind: 'result', payload: RESULT })
    // Lowering the limit to 2 means the 4th launch needs two evictions. The first stop called fails at once, and the second does not finish until released from outside.
    manager.setSettings({ maxConcurrent: 2 })
    let releaseStop = (): void => undefined
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    let stopCalls = 0
    for (const { session } of sent) {
      const originalStop = session.stop.bind(session)
      session.stop = async () => {
        stopCalls += 1
        if (stopCalls === 1) throw new Error('stop failed')
        await stopGate
        await originalStop()
      }
    }
    const d = await manager.createThread({})
    let settled: string | null = null
    const sendD = manager.send(d.id, { text: 'D' }).then(
      () => {
        settled = 'ok'
      },
      (err: Error) => {
        settled = err.message
      }
    )
    await vi.waitFor(() => expect(stopCalls).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Does not throw while the second eviction is running (before, it was thrown first with Promise.all).
    expect(settled).toBeNull()
    releaseStop()
    await sendD
    expect(settled).toBe('stop failed')
  })

  it('ツールの実行 (子エージェントでない作業) は数えず、追い出しを止めない', async () => {
    manager.setSettings({ idleTimeoutMs: 60_000 })
    const { threadId, session } = await sentThread()
    session.emit({ ...started('shell', false), threadId })
    session.emit({ threadId, kind: 'result', payload: RESULT })
    expect(runtimeOf(threadId).subtasks).toHaveLength(0)
    sweepAfter(10 * 60_000)
    expect(session.alive).toBe(false)
  })

  it('知らない作業の終わり (再開前の子の通知など) は数を動かさない。同じ開始の重複も 1 本', async () => {
    const { threadId, session } = await sentThread()
    session.emit({ ...started('a'), threadId })
    session.emit({ ...started('a'), threadId })
    session.emit({ ...finished('orphan'), threadId })
    expect(runtimeOf(threadId).subtasks).toHaveLength(1)
  })

  it('開始と終わりは保存され、経過は保存されない', async () => {
    const { threadId, session } = await sentThread()
    session.emit({ ...started('a'), threadId })
    session.emit({
      threadId,
      kind: 'subtask_progress',
      payload: {
        taskId: 'a',
        toolUseId: 'tu-a',
        description: null,
        activity: null,
        subagentType: 'general-purpose',
        status: null,
        usage: { totalTokens: 5, toolUses: 1, durationMs: 3 },
        lastToolName: 'Read',
        summary: null
      }
    })
    session.emit({ ...finished('a'), threadId })
    await settle()
    const kinds = (await manager.timeline(threadId)).events.map((e) => e.kind)
      .filter((k) => k.startsWith('subtask_'))
    expect(kinds).toEqual(['subtask_started', 'subtask_finished'])
  })

  it('一覧の控え (見せ方): 経過で使用量と最後のツールが runtime に載り、終わりで消える', async () => {
    const { threadId, session } = await sentThread()
    session.emit({ ...started('a'), threadId })
    expect(runtimeOf(threadId).subtasks[0]).toMatchObject({
      taskId: 'a',
      description: '子 a',
      status: 'running',
      usage: null,
      lastToolName: null
    })
    session.emit({
      threadId,
      kind: 'subtask_progress',
      payload: {
        taskId: 'a',
        toolUseId: 'tu-a',
        description: null,
        activity: null,
        subagentType: 'general-purpose',
        status: null,
        usage: { totalTokens: 1234, toolUses: 2, durationMs: 4000 },
        lastToolName: 'Grep',
        summary: null
      }
    })
    const [row] = runtimeOf(threadId).subtasks
    expect(row?.usage?.totalTokens).toBe(1234)
    expect(row?.lastToolName).toBe('Grep')
    expect(row?.usageAt).not.toBeNull()
    session.emit({ ...finished('a'), threadId })
    expect(runtimeOf(threadId).subtasks).toHaveLength(0)
  })

  /**
   * Runs the real spike 19 data (`test/fixtures/subagents.jsonl`) through parseEvent, and as LiveSession does, drops the responses to control requests and the second and later inits before emitting.
   */
  function fixtureEvents(session: FakeSession, threadId: string): AiosEvent[] {
    const lines = readFileSync(new URL('./fixtures/subagents.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('"control_response"'))
    let n = 0
    const ctx = { sessionId: session.sessionId, threadId, now: () => Date.now(), newId: () => `fx${(n += 1)}` }
    let sawInit = false
    return lines
      .flatMap((line) => [...parseEvent(line, ctx)])
      .filter((event) => {
        if (event.kind !== 'session_started') return true
        if (sawInit) return false
        sawInit = true
        return true
      })
  }

  it('実物 (spike 19): 子の終わりの後に親が自分で始めたターンは「応答中」で、その間は追い出さない', async () => {
    manager.setSettings({ idleTimeoutMs: 60_000 })
    const { threadId, session } = await sentThread()
    const states: string[] = []
    let evictableDuringAutonomous = 0
    let results = 0
    for (const event of fixtureEvents(session, threadId)) {
      session.handlers.onEvent(event)
      if (event.kind === 'result') results += 1
      if (results === 0) continue
      const state = runtimeOf(threadId).state
      if (states.at(-1) !== state) states.push(state)
      // Even if the thinning runs with the clock advanced while the parent is advancing its own turn, it does not drop anything.
      if (state === 'running') {
        sweepAfter(10 * 60_000)
        if (!session.alive) evictableDuringAutonomous += 1
      }
    }
    // Waiting after the first result → two parent turns after the children's end arrive (both in response → waiting).
    expect(states).toEqual(['idle', 'running', 'idle', 'running', 'idle'])
    expect(evictableDuringAutonomous).toBe(0)
    expect(runtimeOf(threadId).subtasks).toHaveLength(0)
    // Sent only once (the parent's turn started without any user input).
    expect(session.sent).toHaveLength(1)
    // Once everything has finished, it can be evicted as usual.
    sweepAfter(10 * 60_000)
    expect(session.alive).toBe(false)
  })

  it('親が自分で始めたターンの間に送った発言は予約になり、そのターンの result の後に送る', async () => {
    const { threadId, session } = await sentThread()
    session.emit({ ...started('a'), threadId })
    session.emit({ threadId, kind: 'result', payload: RESULT })
    session.emit({ ...finished('a'), threadId })
    expect(runtimeOf(threadId).state).toBe('idle')
    // Not decided by the child's end alone (if no turn starts, it could not return). It is learned from the content rows.
    session.emit({ threadId, kind: 'assistant_delta', payload: { text: '子が' } })
    expect(runtimeOf(threadId).state).toBe('running')
    const outcome = await manager.send(threadId, { text: '割り込まずに待つ' })
    expect(outcome.kind).toBe('queued')
    expect(session.sent).toHaveLength(1)
    session.emit({ threadId, kind: 'result', payload: RESULT })
    await vi.waitFor(() => expect(session.sent.map((i) => i.text)).toEqual(['子を 2 本走らせて', '割り込まずに待つ']))
  })

  it('子の発言 (subagent の行) は親のターンの始まりとみなさない', async () => {
    const { threadId, session } = await sentThread()
    session.emit({ ...started('a'), threadId })
    session.emit({ threadId, kind: 'result', payload: RESULT })
    session.emit({
      threadId,
      actor: 'subagent',
      parentToolUseId: 'tu-a',
      kind: 'assistant_text',
      payload: { text: '17' }
    })
    expect(runtimeOf(threadId).state).toBe('idle')
    const outcome = await manager.send(threadId, { text: '次' })
    expect(outcome.kind).toBe('sent')
  })

  it('承認要求がどの子のツール呼び出しかを、子の tool_use の行から引いて載せる (実物の id)', async () => {
    const thread = await manager.createThread({ approvalStrict: true })
    await manager.send(thread.id, { text: '子を 2 本走らせて' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const events = fixtureEvents(session, thread.id)
    // Emits up to the Bash tool_use row of the first child (in spike 19 it arrives 3 to 4 ms before the approval request).
    const childToolUse = events.findIndex(
      (e) => e.kind === 'tool_use' && e.actor === 'subagent'
    )
    for (const event of events.slice(0, childToolUse + 1)) session.handlers.onEvent(event)
    const child = events[childToolUse]
    if (child?.kind !== 'tool_use') throw new Error('kind')

    const approvals = [
      manager.handleGatewayRequest({
        sessionId: session.sessionId,
        kind: 'approve',
        payload: { toolName: 'Bash', toolUseId: child.payload.toolUseId, input: { command: './echo17.sh' } }
      }),
      // Not included in the parent's own requests (ids that are not in the child's rows).
      manager.handleGatewayRequest({
        sessionId: session.sessionId,
        kind: 'approve',
        payload: { toolName: 'Bash', toolUseId: 'toolu_parent', input: { command: './ls.sh' } }
      })
    ]
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(2))
    const [fromChild, fromParent] = manager.listApprovals()
    expect(fromChild?.subtask).toEqual({ taskId: 'a3a38f1eee28eb7ef', description: 'Run echo 17' })
    expect(fromParent?.subtask).toBeNull()
    for (const item of manager.listApprovals()) manager.decideApproval(item.id, { kind: 'allow' })
    await Promise.all(approvals)
  })
})

describe('SessionManager — モデルの旧 id と効く thinking の段階 (項目 91 / 92)', () => {
  /** An Adapter that reads the old id `legacy-a` as the alias `model-a`, and has levels that take effect per model. */
  class VersionedAdapter extends FakeAdapter {
    override models = [
      { id: 'model-a', label: 'A 1.0', thinkingLevels: ['low', 'medium', 'high'] as ThinkingLevel[] },
      { id: 'model-b', label: 'B', thinkingLevels: ['off', 'medium'] as ThinkingLevel[] }
    ]
    listener: (() => void) | null = null
    canonicalModelId(id: string): string {
      return id === 'legacy-a' ? 'model-a' : id
    }
    onModelsChanged(listener: () => void): () => void {
      this.listener = listener
      return () => {
        this.listener = null
      }
    }
  }

  async function rebuild(): Promise<VersionedAdapter> {
    await manager.stop()
    const versioned = new VersionedAdapter()
    manager = build([versioned])
    return versioned
  }

  it('設定の既定に旧 id が残っていても createThread は落ちず、別名で作る', async () => {
    // The Adapter that does not know the alias stores the old id as the default (the state of an earlier version).
    manager.setSettings({ defaultModelId: 'legacy-a' })
    await rebuild()
    expect(manager.getSettings().defaultModelId).toBe('model-a')
    const thread = await manager.createThread({})
    expect(thread.modelId).toBe('model-a')
    // Same even if the old id is passed explicitly.
    expect((await manager.createThread({ modelId: 'legacy-a' })).modelId).toBe('model-a')
  })

  it('行に旧 id が残るスレッドは、一覧では別名で見え、別名で起動する', async () => {
    const versioned = await rebuild()
    const thread = await manager.createThread({ modelId: 'model-a' })
    db.prepare('UPDATE threads SET model_id = ? WHERE id = ?').run('legacy-a', thread.id)
    await manager.start()
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread.modelId).toBe('model-a')
    await manager.send(thread.id, { text: 'x' })
    expect(versioned.spawn.mock.calls[0]?.[0].modelId).toBe('model-a')
  })

  it('効かない段階は一番近い効く段階に寄せて保存・起動する (nearestThinkingLevel)', async () => {
    const versioned = await rebuild()
    // model-a does not take effect with "none" → saved as "shallow".
    const a = await manager.createThread({ modelId: 'model-a', thinking: 'off' })
    expect(a.thinking).toBe('low')
    // model-b does not take effect with "deep" → "normal" at launch.
    const b = await manager.createThread({ modelId: 'model-b', thinking: 'off' })
    await manager.send(b.id, { text: '1', thinking: 'high' })
    expect(versioned.spawn.mock.calls[0]?.[0].thinking).toBe('medium')
    // A send during a response becomes a reservation (item 94), so as in the real thing, the first turn is finished before sending.
    versioned.sessions.at(-1)?.emit({ threadId: b.id, kind: 'result', payload: RESULT })
    // The same rule when switching models: staying at "none" and going to model-a → saved and launched as "shallow".
    await manager.send(b.id, { text: '2', modelId: 'model-a', thinking: 'off', settingsScope: 'thread' })
    expect(versioned.spawn.mock.calls[1]?.[0]).toMatchObject({ modelId: 'model-a', thinking: 'low' })
    expect(summaries.find((s) => s.thread.id === b.id)?.thread.thinking).toBe('low')
  })

  it('Adapter のモデル一覧が変わったら状態を通知し、止めたら購読を外す', async () => {
    const versioned = await rebuild()
    const spy = vi.spyOn(versioned, 'getStatus')
    expect(versioned.listener).not.toBeNull()
    versioned.listener?.()
    await settle()
    expect(spy).toHaveBeenCalled()
    await manager.stop()
    expect(versioned.listener).toBeNull()
  })
})

describe('SessionManager — ViewerPane と会話 (項目 97)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-viewer-tools-'))
    writeFileSync(join(dir, 'a.ts'), 'const a = 1\n')
    mkdirSync(join(dir, 'sub'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Creates a thread whose cwd is a temporary directory, sends once, and wakes the session (so the gateway can claim it). */
  async function started(): Promise<{ threadId: string; sessionId: string }> {
    const thread = await manager.createThread({ cwdUri: `file://${dir}` })
    await manager.send(thread.id, { text: 'hi' })
    const sessionId = adapter.sessions.at(-1)!.sessionId
    return { threadId: thread.id, sessionId }
  }
  const call = (sessionId: string, kind: string, payload: Record<string, unknown> = {}): Promise<unknown> =>
    manager.handleGatewayRequest({ sessionId, kind, payload })
  const memoryOf = (threadId: string): string | null =>
    summaries.find((s) => s.thread.id === threadId)?.thread.lastViewerUri ?? null

  it('openFile: 表示している窓があればその窓にだけ届け、記憶も書く', async () => {
    const { threadId, sessionId } = await started()
    const other = await manager.createThread({})
    manager.openThread(threadId, 1)
    manager.openThread(other.id, 2)
    const result = await call(sessionId, 'openFile', { path: 'a.ts', highlight: '  const  ' })
    const uri = `file://${join(dir, 'a.ts')}`
    expect(result).toMatchObject({ opened: true, path: join(dir, 'a.ts'), windows: 1 })
    expect(viewerCommands).toEqual([
      { viewId: 1, command: { kind: 'open', threadId, uri, highlight: 'const' } }
    ])
    expect(memoryOf(threadId)).toBe(uri)
  })

  it('openFile: 窓が無ければ記憶だけ更新して成功を返す (次に開いたときに出る)', async () => {
    const { threadId, sessionId } = await started()
    const result = await call(sessionId, 'openFile', { path: join(dir, 'a.ts') })
    expect(result).toMatchObject({ opened: true, windows: 0 })
    expect((result as { note?: string }).note).toBeTypeOf('string')
    expect(viewerCommands).toEqual([])
    expect(memoryOf(threadId)).toBe(`file://${join(dir, 'a.ts')}`)
  })

  it('openFile: ディレクトリ・無いファイル・除外・壊れたパスは断り、記憶も窓も触らない', async () => {
    const { threadId, sessionId } = await started()
    manager.openThread(threadId, 1)
    expect(await call(sessionId, 'openFile', { path: 'sub' })).toMatchObject({ opened: false })
    expect(await call(sessionId, 'openFile', { path: 'nope.ts' })).toMatchObject({ opened: false })
    expect(await call(sessionId, 'openFile', { path: '/Users/tester/excluded/x' })).toMatchObject({
      opened: false,
      error: 'this path is not allowed'
    })
    for (const path of ['', 42, 'thread://x/y', undefined]) {
      expect(await call(sessionId, 'openFile', { path })).toMatchObject({ opened: false, error: 'invalid path' })
    }
    expect(viewerCommands).toEqual([])
    expect(memoryOf(threadId)).toBeNull()
  })

  it('項目 273: openFile の line は窓への指示にだけ載り、記憶には残らない', async () => {
    const { threadId, sessionId } = await started()
    manager.openThread(threadId, 1)
    const uri = `file://${join(dir, 'a.ts')}`
    expect(await call(sessionId, 'openFile', { path: 'a.ts', line: 42 })).toMatchObject({ opened: true, windows: 1 })
    expect(await call(sessionId, 'openFile', { path: 'a.ts', line: null })).toMatchObject({ opened: true })
    expect(viewerCommands).toEqual([
      { viewId: 1, command: { kind: 'open', threadId, uri, highlight: null, line: 42 } },
      { viewId: 1, command: { kind: 'open', threadId, uri, highlight: null } }
    ])
    // Memory is only a URI (there is no column in the row).
    expect(memoryOf(threadId)).toBe(uri)
  })

  it('項目 273 / 86: openFile の line は 1 以上の安全な整数だけ。それ以外は断り、記憶も窓も触らない', async () => {
    const { threadId, sessionId } = await started()
    manager.openThread(threadId, 1)
    for (const line of [0, -3, 1.5, '12', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, true, {}]) {
      expect(await call(sessionId, 'openFile', { path: 'a.ts', line }), String(line)).toMatchObject({
        opened: false,
        error: 'line must be a positive integer'
      })
    }
    expect(viewerCommands).toEqual([])
    expect(memoryOf(threadId)).toBeNull()
  })

  it('知らないセッションからの要求は投げる (他のツールと同じ)', async () => {
    await expect(call('no-such-session', 'openFile', { path: '/x' })).rejects.toThrow('unknown session')
  })

  it('closeFile: 開いているファイルを閉じる。違うパスを指したら閉じない', async () => {
    const { threadId, sessionId } = await started()
    manager.openThread(threadId, 1)
    expect(await call(sessionId, 'closeFile')).toMatchObject({ closed: false })
    await call(sessionId, 'openFile', { path: 'a.ts' })
    viewerCommands = []
    expect(await call(sessionId, 'closeFile', { path: 'b.ts' })).toMatchObject({ closed: false })
    expect(memoryOf(threadId)).not.toBeNull()
    expect(await call(sessionId, 'closeFile', { path: 'a.ts' })).toMatchObject({ closed: true, windows: 1 })
    expect(viewerCommands).toEqual([
      { viewId: 1, command: { kind: 'close', threadId, uri: `file://${join(dir, 'a.ts')}` } }
    ])
    expect(memoryOf(threadId)).toBeNull()
  })

  it('TODO 400: web ページが開いているとき、listOpenFiles は載せず、closeFile はパス指定なら断り、無指定なら閉じる', async () => {
    const { threadId, sessionId } = await started()
    manager.openThread(threadId, 1)
    manager.setViewerState(threadId, 'https://example.com/a', null)
    expect(await call(sessionId, 'listOpenFiles')).toEqual({ files: [], inView: [{ kind: 'unknown' }] })
    expect(await call(sessionId, 'closeFile', { path: 'a.ts' })).toMatchObject({ closed: false })
    expect(memoryOf(threadId)).toBe('https://example.com/a')
    expect(await call(sessionId, 'closeFile')).toMatchObject({ closed: true, url: 'https://example.com/a' })
    expect(memoryOf(threadId)).toBeNull()
  })

  it('TODO 822: openUrl は http(s) の URL を表示している窓に届け、記憶も書く。窓が無ければ記憶だけ', async () => {
    const { threadId, sessionId } = await started()
    const url = 'https://mail.google.com/mail/u/0/#drafts'
    expect(await call(sessionId, 'openUrl', { url })).toMatchObject({ opened: true, url, windows: 0 })
    expect(viewerCommands).toEqual([])
    expect(memoryOf(threadId)).toBe(url)
    manager.openThread(threadId, 1)
    const next = 'https://example.com/b'
    expect(await call(sessionId, 'openUrl', { url: `  ${next}  ` })).toMatchObject({ opened: true, url: next, windows: 1 })
    expect(viewerCommands).toEqual([{ viewId: 1, command: { kind: 'open', threadId, uri: next, highlight: null } }])
    expect(memoryOf(threadId)).toBe(next)
    // An opened web page is not listed in listOpenFiles, and is closed by closeFile (with no argument), as in TODO 400.
    expect(await call(sessionId, 'listOpenFiles')).toEqual({ files: [], inView: [{ kind: 'unknown' }] })
  })

  it('TODO 822: openUrl は http(s) 以外・資格情報入り・壊れた値を断り、記憶も窓も触らない', async () => {
    const { threadId, sessionId } = await started()
    manager.openThread(threadId, 1)
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'mailto:a@example.com',
      'https://user:pass@example.com/',
      'https://',
      '',
      42,
      undefined
    ]) {
      expect(await call(sessionId, 'openUrl', { url }), String(url)).toMatchObject({ opened: false })
    }
    expect(viewerCommands).toEqual([])
    expect(memoryOf(threadId)).toBeNull()
  })

  it('listOpenFiles: このスレッドの記憶 (窓が無くても) と、ほかの窓のスレッドのファイル', async () => {
    const { threadId, sessionId } = await started()
    const other = await manager.createThread({})
    manager.setViewerState(other.id, 'file:///Users/tester/work/b.md', null)
    manager.openThread(other.id, 2)
    await call(sessionId, 'openFile', { path: 'a.ts' })
    expect(await call(sessionId, 'listOpenFiles')).toEqual({
      files: [
        { path: join(dir, 'a.ts'), thread: 'current', visible: false, shown: false },
        { path: '/Users/tester/work/b.md', thread: 'other', visible: true, shown: false }
      ]
    })
    manager.openThread(threadId, 1)
    const listed = (await call(sessionId, 'listOpenFiles')) as { files: { visible: boolean }[] }
    expect(listed.files[0]?.visible).toBe(true)
  })

  it('TODO 1061 (3): listOpenFiles の shown / inView は窓の ViewerPane がいま前に出しているもの', async () => {
    const { threadId, sessionId } = await started()
    const other = await manager.createThread({})
    const otherUri = 'file:///Users/tester/work/b.md'
    manager.setViewerState(other.id, otherUri, null)
    manager.openThread(other.id, 2)
    manager.openThread(threadId, 1)
    await call(sessionId, 'openFile', { path: 'a.ts' })
    const own = `file://${join(dir, 'a.ts')}`
    // No notification yet: unknown.
    expect(await call(sessionId, 'listOpenFiles')).toMatchObject({ inView: [{ kind: 'unknown' }] })
    manager.reportViewerShown(1, { threadId, kind: 'file', uri: own })
    manager.reportViewerShown(2, { threadId: other.id, kind: 'diff', uri: null })
    expect(await call(sessionId, 'listOpenFiles')).toEqual({
      files: [
        { path: join(dir, 'a.ts'), thread: 'current', visible: true, shown: true },
        { path: '/Users/tester/work/b.md', thread: 'other', visible: true, shown: false }
      ],
      inView: [{ kind: 'file', path: join(dir, 'a.ts') }]
    })
    // A notification for another conversation (an old notification during a switch) is not used.
    manager.reportViewerShown(1, { threadId: other.id, kind: 'file', uri: own })
    expect(await call(sessionId, 'listOpenFiles')).toMatchObject({
      files: [{ shown: false }, { shown: false }],
      inView: [{ kind: 'unknown' }]
    })
    // The pane was closed, the window was closed.
    manager.reportViewerShown(1, { threadId, kind: 'none', uri: null })
    expect(await call(sessionId, 'listOpenFiles')).toMatchObject({ inView: [{ kind: 'none' }] })
    manager.closeView(1)
    const closed = (await call(sessionId, 'listOpenFiles')) as Record<string, unknown>
    expect(closed['inView']).toBeUndefined()
  })

  it('下書きの衝突の知らせ (項目 97 後半): 表示している窓が対象ファイルの下書きを持っていれば知らせる', async () => {
    const { threadId, sessionId } = await started()
    manager.openThread(threadId, 1)
    manager.reportDraft(1, `file://${join(dir, 'a.ts')}`)
    const approval = manager.handleGatewayRequest({
      sessionId,
      kind: 'approve',
      payload: { toolName: 'Edit', toolUseId: 't1', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }
    })
    // The notification arrives synchronously, without waiting for the approval decision (T40: auto-allow by default; the notification does not wait for the result).
    expect(viewerCommands).toEqual([
      {
        viewId: 1,
        command: { kind: 'draftConflict', threadId, uri: `file://${join(dir, 'a.ts')}`, toolName: 'Edit' }
      }
    ])
    const item = manager.listApprovals()[0]
    if (item !== undefined) manager.decideApproval(item.id, { kind: 'allow' })
    await approval
  })

  it('下書きが無ければ知らせない', async () => {
    const { threadId, sessionId } = await started()
    manager.openThread(threadId, 1)
    const approval = manager.handleGatewayRequest({
      sessionId,
      kind: 'approve',
      payload: { toolName: 'Edit', toolUseId: 't1', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }
    })
    expect(viewerCommands).toEqual([])
    const item = manager.listApprovals()[0]
    if (item !== undefined) manager.decideApproval(item.id, { kind: 'allow' })
    await approval
  })

  it('別のファイルの下書きは対象外。読むだけのツール (Read) は通知しない', async () => {
    const { threadId, sessionId } = await started()
    manager.openThread(threadId, 1)
    manager.reportDraft(1, `file://${join(dir, 'b.ts')}`)
    let approval = manager.handleGatewayRequest({
      sessionId,
      kind: 'approve',
      payload: { toolName: 'Edit', toolUseId: 't1', input: { file_path: 'a.ts' } }
    })
    expect(viewerCommands).toEqual([])
    let item = manager.listApprovals()[0]
    if (item !== undefined) manager.decideApproval(item.id, { kind: 'allow' })
    await approval

    manager.reportDraft(1, `file://${join(dir, 'a.ts')}`)
    approval = manager.handleGatewayRequest({
      sessionId,
      kind: 'approve',
      payload: { toolName: 'Read', toolUseId: 't2', input: { file_path: 'a.ts' } }
    })
    expect(viewerCommands).toEqual([])
    item = manager.listApprovals()[0]
    if (item !== undefined) manager.decideApproval(item.id, { kind: 'allow' })
    await approval
  })

  it('そのスレッドを表示していない窓には届かない', async () => {
    const { sessionId } = await started()
    const other = await manager.createThread({})
    manager.openThread(other.id, 2)
    manager.reportDraft(2, `file://${join(dir, 'a.ts')}`)
    const approval = manager.handleGatewayRequest({
      sessionId,
      kind: 'approve',
      payload: { toolName: 'Edit', toolUseId: 't1', input: { file_path: 'a.ts' } }
    })
    expect(viewerCommands).toEqual([])
    const item = manager.listApprovals()[0]
    if (item !== undefined) manager.decideApproval(item.id, { kind: 'allow' })
    await approval
  })

  it('送信に添えた選択範囲はプロンプトに埋まり、題名には使わない', async () => {
    const thread = await manager.createThread({ cwdUri: `file://${dir}` })
    await manager.send(thread.id, {
      text: 'これは何?',
      selection: {
        uri: `file://${join(dir, 'a.ts')}`,
        text: 'const a = 1',
        fromLine: 1,
        toLine: 1,
        truncated: false
      }
    })
    const sent = adapter.sessions.at(-1)?.sent.at(-1)?.text
    expect(sent).toBe('Selected in a.ts (line 1):\n```\nconst a = 1\n```\nこれは何?')
    expect(summaries.find((s) => s.thread.id === thread.id)?.thread.title).toBe('これは何?')
  })

  it('除外に当たる選択は送らずに断る。空白だけの選択は外して送る。予約では添付に数える', async () => {
    const thread = await manager.createThread({ cwdUri: `file://${dir}` })
    const selection = { uri: 'file:///Users/tester/excluded/k', text: 'x', fromLine: 1, toLine: 1, truncated: false }
    await expect(manager.send(thread.id, { text: 'q', selection })).rejects.toThrow('aios-reason:invalid-value')
    expect(adapter.spawn).not.toHaveBeenCalled()

    await manager.send(thread.id, {
      text: 'q',
      selection: { ...selection, uri: `file://${join(dir, 'a.ts')}`, text: '  ' }
    })
    expect(adapter.sessions.at(-1)?.sent.at(-1)?.text).toBe('q')

    // It is a reservation since it is mid-response. The selection counts as one attachment.
    await manager.send(thread.id, { text: 'r', selection: { ...selection, uri: `file://${join(dir, 'a.ts')}` } })
    expect(runtimeOf(thread.id).reservations.map((r) => r.attachments)).toEqual([1])
  })
})

describe('SessionManager — 走ったままの Model / Thinking の切り替え (項目 95)', () => {
  it('切り替えが通れば起こし直さず、同じプロセスに送る。切り替えの行は via: live', async () => {
    const thread = await manager.createThread({ modelId: 'model-a', thinking: 'low' })
    await manager.send(thread.id, { text: '1' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    session.switchResult = true
    finishTurn(thread.id)
    await manager.send(thread.id, { text: '2', modelId: 'model-b', thinking: 'high', settingsScope: 'thread' })
    expect(session.switches).toEqual([{ modelId: 'model-b', thinking: 'high' }])
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(session.sent.map((i) => i.text)).toEqual(['1', '2'])
    await settle()
    const changed = (await manager.timeline(thread.id)).events.filter((e) => e.kind === 'settings_changed')
    expect(changed.map((e) => (e.kind === 'settings_changed' ? e.payload.via : null))).toEqual(['live'])
    // The switched spec becomes "the spec now in effect": the next send with the same spec does nothing.
    finishTurn(thread.id)
    await manager.send(thread.id, { text: '3' })
    expect(session.switches).toHaveLength(1)
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('review Y-2: 指定が同じでもバックエンドに渡す値がずれた (modelDrifted) なら、次の送信の直前に同じ指定で切り替える', async () => {
    const thread = await manager.createThread({ modelId: 'model-a', thinking: 'low' })
    await manager.send(thread.id, { text: '1' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    let drifted = true
    const switchSettings = session.switchSettings.bind(session)
    Object.assign(session, {
      modelDrifted: () => drifted,
      switchSettings: async (target: { modelId: string | null; thinking: ThinkingLevel | null }) => {
        const ok = await switchSettings(target)
        if (ok) drifted = false
        return ok
      }
    })
    session.switchResult = true
    finishTurn(thread.id)
    await manager.send(thread.id, { text: '2' })
    expect(session.switches).toEqual([{ modelId: 'model-a', thinking: 'low' }])
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    // Sending after they are aligned does nothing.
    finishTurn(thread.id)
    await manager.send(thread.id, { text: '3' })
    expect(session.switches).toHaveLength(1)
    // If it cannot be switched, it is woken again, as before.
    drifted = true
    session.switchResult = false
    finishTurn(thread.id)
    await manager.send(thread.id, { text: '4' })
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
  })

  it('切り替えられなければ (口が拒否・時間切れ・戻せない指定) 落として再開で起こし直す。via: restart', async () => {
    const thread = await manager.createThread({ modelId: 'model-a' })
    await manager.send(thread.id, { text: '1' })
    const first = adapter.sessions.at(-1)
    if (first === undefined) throw new Error('no session')
    first.switchResult = false
    finishTurn(thread.id)
    await manager.send(thread.id, { text: '2', modelId: 'model-b' })
    expect(first.switches).toHaveLength(1)
    expect(first.alive).toBe(false)
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(adapter.spawn.mock.calls[1]?.[0].modelId).toBe('model-b')
    await settle()
    const changed = (await manager.timeline(thread.id)).events.filter((e) => e.kind === 'settings_changed')
    expect(changed.map((e) => (e.kind === 'settings_changed' ? e.payload.via : null))).toEqual(['restart'])
  })

  it('応答中に指定を変えて送った分は予約になり、切り替えは前のターンの result の後・送る直前に行う', async () => {
    const thread = await manager.createThread({ modelId: 'model-a' })
    await manager.send(thread.id, { text: '1' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    session.switchResult = true
    expect((await manager.send(thread.id, { text: '2', modelId: 'model-b' })).kind).toBe('queued')
    await settle()
    expect(session.switches).toHaveLength(0)
    finishTurn(thread.id)
    await vi.waitFor(() => expect(session.sent.map((i) => i.text)).toEqual(['1', '2']))
    expect(session.switches).toEqual([{ modelId: 'model-b', thinking: null }])
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('切り替え方は runtime.switchRestart で renderer に届く (走っていなければ always)', async () => {
    const thread = await manager.createThread({})
    expect(runtimeOf(thread.id).switchRestart).toBe('always')
    adapter.nextSpawn = async (options, handlers) => {
      const session = await adapter.spawnOk(options, handlers)
      ;(session as FakeSession).switchRestart = 'thinking-on'
      return session
    }
    await manager.send(thread.id, { text: '1' })
    await vi.waitFor(() => expect(runtimeOf(thread.id).switchRestart).toBe('thinking-on'))
  })

  it('backends() のコマンド一覧は、セッションが始まる前でも Adapter が教わった分を返す (項目 68 の穴)', async () => {
    const withCommands = new FakeAdapter()
    let known: readonly string[] | null = null
    Object.assign(withCommands, { knownCommands: () => known })
    await manager.stop()
    manager = build([withCommands])
    expect((await manager.backends())[0]?.commands).toBeNull()
    known = ['compact', 'context']
    expect((await manager.backends())[0]?.commands).toEqual(['compact', 'context'])
    // Once a session starts, its list (which may contain the cwd project's commands) wins.
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '1' })
    const session = withCommands.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    session.emit({
      threadId: thread.id,
      kind: 'session_started',
      payload: {
        backendSessionId: 'b-1',
        model: null,
        cwd: '/Users/tester',
        tools: [],
        permissionMode: null,
        resumed: false,
        commands: ['compact', 'project-cmd']
      }
    } as never)
    expect((await manager.backends())[0]?.commands).toEqual(['compact', 'project-cmd'])
  })
})

describe('SessionManager — 会話の区切りと作業リスト (項目 117 / 118、束 C)', () => {
  const started = (sessionIdOf: string, threadId: string): Parameters<FakeSession['emit']>[0] => ({
    threadId,
    kind: 'session_started',
    payload: {
      backendSessionId: sessionIdOf,
      backendVersion: null,
      model: null,
      cwd: null,
      reportedPermissionMode: null,
      tools: [],
      toolServers: [],
      resumed: false
    }
  })
  const usage = (threadId: string, cacheRead: number): Parameters<FakeSession['emit']>[0] => ({
    threadId,
    kind: 'turn_usage',
    payload: { model: 'model-a-full-name', inputTokens: 1, outputTokens: 1, cacheCreationTokens: 1, cacheReadTokens: cacheRead }
  })
  const todoWrite = (
    threadId: string,
    toolUseId: string,
    todos: { content: string; activeForm: string | null; status: 'pending' | 'in_progress' | 'completed' }[],
    actor: AiosActor = 'main'
  ): Parameters<FakeSession['emit']>[0] => ({
    threadId,
    kind: 'tool_use',
    actor,
    ...(actor === 'subagent' ? { parentToolUseId: 'parent' } : {}),
    payload: { toolUseId, name: 'todo-tool', summary: '', input: {}, truncated: false, todos }
  })

  async function begin(): Promise<{ threadId: string; session: FakeSession }> {
    const thread = await manager.createThread({ modelId: 'model-a' })
    await manager.send(thread.id, { text: 'x' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    session.emit(started('backend-1', thread.id))
    return { threadId: thread.id, session }
  }

  it('リセットの後の session_started は新しいバックエンドの id で別の行になり、再開はそちらに続く', async () => {
    const spawns: string[] = []
    const original = adapter.nextSpawn
    adapter.nextSpawn = (options, handlers) => {
      spawns.push(options.resumeBackendSessionId ?? 'new')
      return original(options, handlers)
    }
    const { threadId, session } = await begin()
    finishTurn(threadId)
    await manager.send(threadId, { text: '/clear' })
    session.emit({ threadId, kind: 'conversation_reset', payload: {} })
    // As in the real thing: after the reset, the same process emits an init with a new session_id (LiveSession passes it through).
    expect(() => session.emit(started('backend-2', threadId))).not.toThrow()
    session.emit({ threadId, kind: 'result', payload: { ...RESULT, costUsd: 0 } })
    const rows = db
      .prepare('SELECT backend_session_id, ended_at FROM sessions WHERE thread_id = ? ORDER BY started_at, rowid')
      .all(threadId) as { backend_session_id: string; ended_at: number | null }[]
    expect(rows.map((r) => r.backend_session_id)).toEqual(['backend-1', 'backend-2'])
    expect(rows[0]?.ended_at).not.toBeNull()
    expect(runtimeOf(threadId).backendSessionId).toBe('backend-2')

    // Resuming after eviction (stopping the process) continues the conversation after the reset.
    await manager.stopThread(threadId)
    await manager.send(threadId, { text: 'again' })
    expect(spawns).toEqual(['new', 'backend-2'])
  })

  it('リセットと圧縮でコンテキスト使用量は「分からない」に戻り、次の応答でまた出る', async () => {
    const { threadId, session } = await begin()
    session.emit(usage(threadId, 500))
    expect(runtimeOf(threadId).contextUsage?.cacheReadTokens).toBe(500)
    session.emit({ threadId, kind: 'context_compacted', payload: { trigger: 'manual', preTokens: 32679, postTokens: 1888 } })
    expect(runtimeOf(threadId).contextUsage).toBeNull()
    session.emit(usage(threadId, 300))
    expect(runtimeOf(threadId).contextUsage?.cacheReadTokens).toBe(300)
    session.emit({ threadId, kind: 'conversation_reset', payload: {} })
    expect(runtimeOf(threadId).contextUsage).toBeNull()
  })

  it('親の作業リストの書き換えが runtime に載る。子の作業リストは載らない。リセットで消え、圧縮では残る', async () => {
    const { threadId, session } = await begin()
    expect(runtimeOf(threadId).todos).toBeNull()
    session.emit(todoWrite(threadId, 'tu-1', [{ content: 'A', activeForm: 'Doing A', status: 'in_progress' }]))
    expect(runtimeOf(threadId).todos).toMatchObject({
      toolUseId: 'tu-1',
      items: [{ content: 'A', activeForm: 'Doing A', status: 'in_progress' }]
    })
    session.emit(todoWrite(threadId, 'tu-child', [{ content: 'X', activeForm: null, status: 'pending' }], 'subagent'))
    expect(runtimeOf(threadId).todos?.toolUseId).toBe('tu-1')
    session.emit({ threadId, kind: 'context_compacted', payload: { trigger: 'auto', preTokens: null, postTokens: null } })
    expect(runtimeOf(threadId).todos?.toolUseId).toBe('tu-1')
    session.emit({ threadId, kind: 'conversation_reset', payload: {} })
    expect(runtimeOf(threadId).todos).toBeNull()
  })

  it('再起動後は保存した最後の作業リストから復元する (リセットより後に無ければ null)', async () => {
    const { threadId, session } = await begin()
    session.emit(todoWrite(threadId, 'tu-1', [{ content: 'A', activeForm: null, status: 'pending' }]))
    session.emit(
      todoWrite(threadId, 'tu-2', [
        { content: 'A', activeForm: null, status: 'completed' },
        { content: 'B', activeForm: 'Doing B', status: 'in_progress' }
      ])
    )
    session.emit(usage(threadId, 700))
    session.emit({ threadId, kind: 'context_compacted', payload: { trigger: 'manual', preTokens: 10, postTokens: 1 } })
    await settle()
    await manager.stop()
    manager = build([new FakeAdapter()])
    manager.listSummaries()
    const again = manager.listSummaries().find((s) => s.thread.id === threadId)
    expect(again?.runtime.todos).toMatchObject({
      toolUseId: 'tu-2',
      items: [
        { content: 'A', activeForm: null, status: 'completed' },
        { content: 'B', activeForm: 'Doing B', status: 'in_progress' }
      ]
    })
    // Usage from before compaction is not "now", so it is not restored (item 117).
    expect(again?.runtime.contextUsage).toBeNull()
  })

  it('再起動後、リセットより前の作業リストは復元しない', async () => {
    const { threadId, session } = await begin()
    session.emit(todoWrite(threadId, 'tu-1', [{ content: 'A', activeForm: null, status: 'pending' }]))
    session.emit({ threadId, kind: 'conversation_reset', payload: {} })
    await settle()
    await manager.stop()
    manager = build([new FakeAdapter()])
    const again = manager.listSummaries().find((s) => s.thread.id === threadId)
    expect(again?.runtime.todos).toBeNull()
  })
})

describe('SessionManager — ここまで戻す (項目 113)', () => {
  /** One turn: sends, and streams the echo (with identifier), the response (with identifier), and the result. */
  async function turn(threadId: string, text: string, n: number): Promise<{ userId: string }> {
    await manager.send(threadId, { text })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    if (session.sent.length === 1) {
      session.emit({
        threadId,
        kind: 'session_started',
        payload: { backendSessionId: `b-${threadId.slice(0, 4)}`, backendVersion: null, model: null, cwd: null, reportedPermissionMode: null, tools: [], toolServers: [], resumed: false }
      })
    }
    session.emit({ threadId, kind: 'user_replay', payload: { messageId: `u-${n}`, text } })
    session.emit({ threadId, kind: 'assistant_text', payload: { text: `answer ${n}`, messageId: `a-${n}` } })
    finishTurn(threadId)
    await settle()
    const users = (await manager.timeline(threadId)).events.filter((e) => e.kind === 'user_text')
    const last = users[users.length - 1]
    if (last === undefined) throw new Error('no user_text')
    return { userId: last.id }
  }

  it('反射で届いた識別子を、記録済みの user_text に写す (本文が違えば写さない)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'one' })
    const session = adapter.sessions.at(-1)!
    // An echo whose text differs (another message) is ignored.
    session.emit({ threadId: thread.id, kind: 'user_replay', payload: { messageId: 'wrong', text: 'other' } })
    session.emit({ threadId: thread.id, kind: 'user_replay', payload: { messageId: 'u-1', text: 'one' } })
    await settle()
    const users = (await manager.timeline(thread.id)).events.filter((e) => e.kind === 'user_text')
    expect(users).toHaveLength(1)
    expect((users[0]?.payload as { messageId?: string }).messageId).toBe('u-1')
    // The echo itself does not remain on the timeline.
    expect((await manager.timeline(thread.id)).events.some((e) => e.kind === 'user_replay')).toBe(false)
    // It also remains on saved rows (even after a reload): this is the path that fixes the DB, not waiting to save.
    finishTurn(thread.id)
    await settle()
    await manager.send(thread.id, { text: 'two' })
    await settle()
    session.emit({ threadId: thread.id, kind: 'user_replay', payload: { messageId: 'u-2', text: 'two' } })
    await settle()
    const store = new ThreadStore(db, '/Users/tester')
    const ids = store
      .readTimeline(thread.id)
      .filter((e) => e.kind === 'user_text')
      .map((e) => (e.payload as { messageId?: string }).messageId)
    expect(ids).toEqual(['u-1', 'u-2'])
  })

  it('下見: ファイルの一覧を URI にして返す。応答中は rewind-busy、識別子の無い行は理由コード', async () => {
    const thread = await manager.createThread({})
    const first = await turn(thread.id, 'first', 1)
    const preview = await manager.rewindPreview(thread.id, first.userId)
    expect(preview).toEqual({
      canRewind: true,
      files: ['file:///Users/tester/work/a.txt'],
      insertions: 2,
      deletions: 1,
      reason: null
    })
    expect(adapter.sessions.at(-1)?.rewinds).toEqual([{ userMessageId: 'u-1', dryRun: true }])
    // Uses the running process as it is (does not wake it again).
    expect(adapter.spawn).toHaveBeenCalledTimes(1)

    // Refused while responding.
    await manager.send(thread.id, { text: 'busy' })
    await expect(manager.rewindPreview(thread.id, first.userId)).rejects.toThrow('aios-reason:rewind-busy')
    await expect(manager.rewind(thread.id, first.userId, { files: false })).rejects.toThrow('aios-reason:rewind-busy')
    finishTurn(thread.id)
    await settle()

    // A message that did not receive an echo (has no identifier) cannot restore files.
    const users = (await manager.timeline(thread.id)).events.filter((e) => e.kind === 'user_text')
    const noId = users[users.length - 1]!
    expect((await manager.rewindPreview(thread.id, noId.id)).reason).toBe('aios-reason:rewind-no-checkpoint')
    // A row that is not a user's message throws.
    const answer = (await manager.timeline(thread.id)).events.find((e) => e.kind === 'assistant_text')!
    await expect(manager.rewindPreview(thread.id, answer.id)).rejects.toThrow('rewind-not-user-message')
  })

  it('下見: 走っていなければ再開で起こして聞く。バックエンドが戻せないと言えば rewind-failed', async () => {
    const thread = await manager.createThread({})
    const first = await turn(thread.id, 'first', 1)
    await manager.stopThread(thread.id)
    adapter.nextSpawn = async (options, handlers) => {
      const session = await adapter.spawnOk(options, handlers)
      ;(session as FakeSession).rewindResult = { canRewind: false, filesChanged: [], insertions: 0, deletions: 0 }
      return session
    }
    const preview = await manager.rewindPreview(thread.id, first.userId)
    expect(preview.canRewind).toBe(false)
    expect(preview.reason).toBe('aios-reason:rewind-failed')
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    const options = adapter.spawn.mock.calls[1]?.[0]
    expect(options?.resumeBackendSessionId).toBe(`b-${thread.id.slice(0, 4)}`)
    expect(options?.forkSession).not.toBe(true)
  })

  it('TODO 916: 止まったスレッドで下見 → 会話とファイルの確定が通り、起こしたプロセスは starting に残らない', async () => {
    const thread = await manager.createThread({})
    const first = await turn(thread.id, 'first', 1)
    await manager.stopThread(thread.id)
    await settle()
    expect(manager.activityBlocker()).toBeNull()

    const preview = await manager.rewindPreview(thread.id, first.userId)
    expect(preview.canRewind).toBe(true)
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    // The CLI does not emit init until a user's line arrives, so session_started is not emitted (same as the real thing).
    expect(runtimeOf(thread.id).state).toBe('idle')
    expect(manager.activityBlocker()).toBeNull()

    const fork = await manager.rewind(thread.id, first.userId, { files: true })
    expect(fork.forkedFrom).toEqual({ threadId: thread.id, eventId: first.userId, files: true })
    // Uses as it is the process woken for the preview (does not wake it again).
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(adapter.sessions.at(-1)?.rewinds).toEqual([
      { userMessageId: 'u-1', dryRun: true },
      { userMessageId: 'u-1', dryRun: false }
    ])
    expect(runtimeOf(thread.id).state).toBe('idle')
    expect(manager.activityBlocker()).toBeNull()
  })

  it('TODO 916: 下見なしで止まったスレッドのファイルを戻しても、起こしたプロセスは idle (追い出せる)', async () => {
    const thread = await manager.createThread({})
    const first = await turn(thread.id, 'first', 1)
    await manager.stopThread(thread.id)
    await settle()
    await manager.rewind(thread.id, first.userId, { files: true })
    expect(runtimeOf(thread.id).state).toBe('idle')
    expect(manager.activityBlocker()).toBeNull()
    // Sending on continues as a normal turn (idle → running).
    await manager.send(thread.id, { text: 'next' })
    expect(runtimeOf(thread.id).state).toBe('running')
  })

  it('TODO 992 の 1: 分岐から「軽くして」引き継ぐと、分岐より前 (元のスレッドの行) も入る。分岐点から後は入らない', async () => {
    const thread = await manager.createThread({ title: '相談' })
    await turn(thread.id, 'first', 1)
    const second = await turn(thread.id, 'second', 2)
    const fork = await manager.rewind(thread.id, second.userId, { files: false })
    await turn(fork.id, 'branch', 3)

    const created = await manager.handoff(fork.id)
    expect(created.forkedFrom?.threadId).toBe(fork.id)
    await manager.send(created.id, { text: 'go' })
    const sent = adapter.sessions.at(-1)!.sent[0]?.text ?? ''
    expect(sent).toContain('first')
    expect(sent).toContain('answer 1')
    expect(sent).toContain('branch')
    expect(sent).toContain('answer 3')
    expect(sent).not.toContain('second')
    expect(sent).not.toContain('answer 2')
    expect(sent.indexOf('answer 1')).toBeLessThan(sent.indexOf('branch'))
  })

  it('TODO 992 の 1: 最初の発言より前に戻した分岐 (元の会話を継がない) から引き継いでも、元のスレッドの行は足さない', async () => {
    const thread = await manager.createThread({ title: '相談' })
    const first = await turn(thread.id, 'first', 1)
    const empty = await manager.rewind(thread.id, first.userId, { files: false })
    await turn(empty.id, 'solo', 5)
    const created = await manager.handoff(empty.id)
    await manager.send(created.id, { text: 'go' })
    const sent = adapter.sessions.at(-1)!.sent[0]?.text ?? ''
    expect(sent).toContain('solo')
    expect(sent).not.toContain('answer 1')
  })

  it('review X (TODO 992 の 1): 先祖は分岐点までしか読まず、先祖が分岐点より後に進んでも控えは外れない', async () => {
    const a = await manager.createThread({ title: '相談' })
    await turn(a.id, 'first', 1)
    const second = await turn(a.id, 'second', 2)
    const aSession = adapter.sessions.at(-1)!
    const fork = await manager.rewind(a.id, second.userId, { files: false })
    await turn(fork.id, 'branch', 3)
    const reads = vi.spyOn(ThreadStore.prototype, 'readTimelinePage')
    try {
      await manager.handoffEstimate(fork.id)
      const parentReads = reads.mock.calls.filter((call) => call[0] === a.id)
      // The ancestor is read only up to the branch-point message (inclusive). It is not read from the end.
      expect(parentReads.length).toBeGreaterThan(0)
      expect(parentReads.every((call) => typeof call[2] === 'number')).toBe(true)

      // Even if the ancestor advances past the branch point, the handoff text is the same, so it is not rebuilt (neither the ancestor nor oneself is re-read).
      // (The helper's turn goes to the last session, which is the branch's, so it is fed directly into the original session.)
      await manager.send(a.id, { text: 'third' })
      aSession.emit({ threadId: a.id, kind: 'assistant_text', payload: { text: 'answer 4', messageId: 'a-4' } })
      aSession.emit({ threadId: a.id, kind: 'result', payload: RESULT })
      await settle()
      expect((await manager.timeline(a.id)).events.some((e) => e.kind === 'user_text' && (e.payload as { text: string }).text === 'third')).toBe(true)
      const afterGrow = reads.mock.calls.length
      await manager.handoffEstimate(fork.id)
      expect(reads.mock.calls.length).toBe(afterGrow)

      // If a row is added to oneself, it is rebuilt. The contents are the rows before the branch point plus one's own; nothing after the ancestor's branch point is included.
      await turn(fork.id, 'branch more', 5)
      const created = await manager.handoff(fork.id)
      await manager.send(created.id, { text: 'go' })
      const sent = adapter.sessions.at(-1)!.sent[0]?.text ?? ''
      expect(sent).toContain('answer 1')
      expect(sent).toContain('answer 5')
      expect(sent).not.toContain('answer 2')
      expect(sent).not.toContain('third')
    } finally {
      reads.mockRestore()
    }
  })

  it('会話だけ:直前の応答までの会話から分岐した新しいスレッドを作り、元は無傷', async () => {
    const thread = await manager.createThread({ title: '相談' })
    await turn(thread.id, 'first', 1)
    const second = await turn(thread.id, 'second', 2)
    const before = (await manager.timeline(thread.id)).events.length

    const fork = await manager.rewind(thread.id, second.userId, { files: false })
    expect(fork.id).not.toBe(thread.id)
    expect(fork.forkedFrom).toEqual({ threadId: thread.id, eventId: second.userId, files: false })
    expect(fork.title).toBe('相談')
    expect(fork.cwdUri).toBe(thread.cwdUri)
    expect(fork.backend).toBe(thread.backend)
    // Past entries are not copied. The original thread also does not change.
    expect((await manager.timeline(fork.id)).events).toEqual([])
    expect((await manager.timeline(thread.id)).events).toHaveLength(before)
    expect(summaries.map((s) => s.thread.id)).toContain(fork.id)
    // Files were not touched (no control request was sent).
    expect(adapter.sessions.at(-1)?.rewinds).toEqual([])

    // First launch of the branch: the original session as a separate session, from the conversation up to the first response (a-1).
    await manager.send(fork.id, { text: 'branch' })
    const options = adapter.spawn.mock.calls.at(-1)?.[0]
    expect(options?.threadId).toBe(fork.id)
    expect(options?.resumeBackendSessionId).toBe(`b-${thread.id.slice(0, 4)}`)
    expect(options?.resumeAtMessageId).toBe('a-1')
    expect(options?.forkSession).toBe(true)
    // When a new session id arrives, the sessions row carries forked_from, and afterwards it resumes with its own id.
    const session = adapter.sessions.at(-1)!
    session.emit({
      threadId: fork.id,
      kind: 'session_started',
      payload: { backendSessionId: 'b-fork', backendVersion: null, model: null, cwd: null, reportedPermissionMode: null, tools: [], toolServers: [], resumed: true }
    })
    finishTurn(fork.id)
    await settle()
    const row = db.prepare(`SELECT forked_from FROM sessions WHERE backend_session_id = 'b-fork'`).get() as { forked_from: string | null }
    expect(row.forked_from).toBe(`b-${thread.id.slice(0, 4)}`)
    await manager.stopThread(fork.id)
    await manager.send(fork.id, { text: 'again' })
    const again = adapter.spawn.mock.calls.at(-1)?.[0]
    expect(again?.resumeBackendSessionId).toBe('b-fork')
    expect(again?.forkSession).not.toBe(true)
    expect(again?.resumeAtMessageId ?? null).toBeNull()
  })

  it('最初の発言より前に戻すと、何も引き継がない空のスレッド (再開しない)', async () => {
    const thread = await manager.createThread({})
    const first = await turn(thread.id, 'first', 1)
    const fork = await manager.rewind(thread.id, first.userId, { files: false })
    await manager.send(fork.id, { text: 'fresh' })
    const options = adapter.spawn.mock.calls.at(-1)?.[0]
    expect(options?.resumeBackendSessionId).toBeNull()
    expect(options?.forkSession).not.toBe(true)
  })

  it('会話とファイル: 元のセッションにチェックポイントへ戻させてから分岐する。戻せなければ作らない', async () => {
    const thread = await manager.createThread({})
    await turn(thread.id, 'first', 1)
    const second = await turn(thread.id, 'second', 2)
    const session = adapter.sessions.at(-1)!
    session.rewindResult = { canRewind: false, filesChanged: [], insertions: 0, deletions: 0 }
    const count = summaries.length
    await expect(manager.rewind(thread.id, second.userId, { files: true })).rejects.toThrow('rewind-failed')
    expect(summaries).toHaveLength(count)
    session.rewindResult = { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }
    const fork = await manager.rewind(thread.id, second.userId, { files: true })
    expect(session.rewinds).toEqual([
      { userMessageId: 'u-2', dryRun: false },
      { userMessageId: 'u-2', dryRun: false }
    ])
    expect(fork.forkedFrom?.files).toBe(true)
  })

  it('直前の応答に識別子が無い (対応前の行) なら分岐点を作れない。対応していない版は unsupported', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'old' })
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: 'no id' } })
    finishTurn(thread.id)
    await settle()
    await manager.send(thread.id, { text: 'next' })
    finishTurn(thread.id)
    await settle()
    const users = (await manager.timeline(thread.id)).events.filter((e) => e.kind === 'user_text')
    const next = users[users.length - 1]!
    await expect(manager.rewind(thread.id, next.id, { files: false })).rejects.toThrow('rewind-no-branch-point')

    adapter.features = { rewind: false }
    expect((await manager.rewindPreview(thread.id, next.id)).reason).toBe('aios-reason:rewind-unsupported')
    await expect(manager.rewind(thread.id, next.id, { files: false })).rejects.toThrow('rewind-unsupported')
    expect((await manager.backends())[0]?.rewind).toBe(false)
  })
})

describe('SessionManager — 軽くして新しい会話で続ける (TODO 961)', () => {
  /** One turn: sends, and streams the response (and at first session_started and usage) and the result. */
  async function turn(threadId: string, text: string, answer: string, usage?: number): Promise<void> {
    await manager.send(threadId, { text })
    const session = adapter.sessions.at(-1)!
    if (session.sent.length === 1) {
      session.emit({
        threadId,
        kind: 'session_started',
        payload: { backendSessionId: `b-${threadId.slice(0, 6)}`, backendVersion: null, model: null, cwd: null, reportedPermissionMode: null, tools: [], toolServers: [], resumed: false }
      })
    }
    if (usage !== undefined) {
      session.emit({
        threadId,
        kind: 'turn_usage',
        payload: { model: 'model-a', inputTokens: 3, outputTokens: 10, cacheCreationTokens: usage, cacheReadTokens: 0 }
      })
    }
    session.emit({ threadId, kind: 'tool_use', payload: { toolUseId: `t-${text}`, name: 'Read', input: { file_path: '/x' }, summary: 'x', truncated: false } })
    session.emit({ threadId, kind: 'assistant_text', payload: { text: answer } })
    finishTurn(threadId)
    await settle()
  }

  it('新しいスレッドを作り、最初の送信だけ元の発言と回答の text を頭に添える (記録はしない)。元は無傷', async () => {
    const thread = await manager.createThread({ title: '大きな相談' })
    await turn(thread.id, 'first question', 'first answer', 40_000)
    await turn(thread.id, 'second question', 'second answer')
    const before = (await manager.timeline(thread.id)).events.length

    const estimate = await manager.handoffEstimate(thread.id)
    expect(estimate.baseTokens).toBe(40_003)
    expect(estimate.handoffTokens).toBeGreaterThan(0)

    const created = await manager.handoff(thread.id)
    expect(created.id).not.toBe(thread.id)
    expect(created.title).toBe('大きな相談')
    expect(created.forkedFrom?.handoff).toBe(true)
    expect(created.forkedFrom?.threadId).toBe(thread.id)
    expect(created.forkedFrom?.files).toBe(false)
    expect((await manager.timeline(created.id)).events).toEqual([])
    expect((await manager.timeline(thread.id)).events).toHaveLength(before)

    // The first launch does not inherit the original conversation (it starts empty).
    await manager.send(created.id, { text: 'continue please' })
    const options = adapter.spawn.mock.calls.at(-1)?.[0]
    expect(options?.threadId).toBe(created.id)
    expect(options?.resumeBackendSessionId).toBeNull()
    const session = adapter.sessions.at(-1)!
    const sent = session.sent[0]?.text ?? ''
    expect(sent).toContain('first question')
    expect(sent).toContain('second answer')
    expect(sent).not.toContain('t-first') // Tool calls are not included
    expect(sent.endsWith('continue please')).toBe(true)
    await settle()
    const users = (await manager.timeline(created.id)).events.filter((e) => e.kind === 'user_text')
    expect(users.map((e) => (e.payload as { text: string }).text)).toEqual(['continue please'])

    // Not attached to sends after its own session has been created.
    session.emit({
      threadId: created.id,
      kind: 'session_started',
      payload: { backendSessionId: 'b-new', backendVersion: null, model: null, cwd: null, reportedPermissionMode: null, tools: [], toolServers: [], resumed: false }
    })
    finishTurn(created.id)
    await settle()
    await manager.send(created.id, { text: 'next' })
    expect(adapter.sessions.at(-1)?.sent.at(-1)?.text).toBe('next')
  })

  it('/clear より前は引き継がない。発言の無いスレッドは handoff-empty', async () => {
    // Set so that the title (which goes into the preamble) is not named from the first message.
    const thread = await manager.createThread({ title: 'T' })
    await turn(thread.id, 'old topic', 'old answer')
    adapter.sessions.at(-1)!.emit({ threadId: thread.id, kind: 'conversation_reset', payload: { trigger: 'clear' } } as never)
    await settle()
    await turn(thread.id, 'new topic', 'new answer')
    const created = await manager.handoff(thread.id)
    await manager.send(created.id, { text: 'go' })
    const sent = adapter.sessions.at(-1)!.sent[0]?.text ?? ''
    expect(sent).toContain('new topic')
    expect(sent).not.toContain('old topic')

    const empty = await manager.createThread({})
    await expect(manager.handoff(empty.id)).rejects.toThrow('aios-reason:handoff-empty')
  })

  it('最初の発言がスラッシュコマンドなら添えず、次の普通の発言まで持ち越す (review)', async () => {
    const thread = await manager.createThread({ title: 'T' })
    await turn(thread.id, 'first question', 'first answer')
    const created = await manager.handoff(thread.id)

    await manager.send(created.id, { text: '/review' })
    const session = adapter.sessions.at(-1)!
    // Nothing is added at the head = the backend receives it as a command.
    expect(session.sent[0]?.text).toBe('/review')
    session.emit({
      threadId: created.id,
      kind: 'session_started',
      payload: { backendSessionId: 'b-cmd', backendVersion: null, model: null, cwd: null, reportedPermissionMode: null, tools: [], toolServers: [], resumed: false }
    })
    finishTurn(created.id)
    await settle()

    // Its own session exists already, but the handoff text has not yet been passed, so it is attached to the next ordinary message.
    await manager.send(created.id, { text: 'continue' })
    const second = session.sent.at(-1)?.text ?? ''
    expect(second).toContain('first question')
    expect(second.endsWith('continue')).toBe(true)
    finishTurn(created.id)
    await settle()

    // Not attached after it has been passed.
    await manager.send(created.id, { text: 'next' })
    expect(session.sent.at(-1)?.text).toBe('next')
  })

  it('引き継ぎの反射は送った文で照合し、識別子を写す', async () => {
    const thread = await manager.createThread({ title: 'T' })
    await turn(thread.id, 'first question', 'first answer')
    const created = await manager.handoff(thread.id)
    await manager.send(created.id, { text: 'go on' })
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId: created.id, kind: 'user_replay', payload: { messageId: 'u-h', text: session.sent[0]!.text } })
    await settle()
    const users = (await manager.timeline(created.id)).events.filter((e) => e.kind === 'user_text')
    expect((users[0]?.payload as { messageId?: string }).messageId).toBe('u-h')
  })

  it('TODO 992 の 1: 引き継いだ会話からさらに引き継ぐと、最初に添えた分 (記録しない) も入る', async () => {
    const a = await manager.createThread({ title: 'T' })
    await turn(a.id, 'alpha question', 'alpha answer')
    const aSession = adapter.sessions.at(-1)!
    const b = await manager.handoff(a.id)
    // What a has advanced by the time of b's first send is included in the sentence attached to b (built from a as of the moment it was sent).
    await turn(a.id, 'alpha more', 'alpha more answer')
    await turn(b.id, 'beta question', 'beta answer')
    // b's records contain only the user's sentences (there is no handoff text).
    const bUsers = (await manager.timeline(b.id)).events.filter((e) => e.kind === 'user_text')
    expect(bUsers.map((e) => (e.payload as { text: string }).text)).toEqual(['beta question'])
    // What a moved on after the send with b's handoff was attached is not in b, so it is not included.
    await manager.send(a.id, { text: 'alpha later' })
    aSession.emit({ threadId: a.id, kind: 'assistant_text', payload: { text: 'alpha later answer' } })
    aSession.emit({ threadId: a.id, kind: 'result', payload: RESULT })
    await settle()

    const c = await manager.handoff(b.id)
    // The destination jumped to from the band is b's own message.
    expect(c.forkedFrom?.eventId).toBe(bUsers[0]!.id)
    await manager.send(c.id, { text: 'gamma' })
    const sent = adapter.sessions.at(-1)!.sent[0]?.text ?? ''
    expect(sent).toContain('alpha question')
    expect(sent).toContain('alpha answer')
    expect(sent).toContain('alpha more answer')
    expect(sent).toContain('beta question')
    expect(sent.indexOf('alpha more answer')).toBeLessThan(sent.indexOf('beta question'))
    expect(sent).not.toContain('alpha later')
    expect(sent.endsWith('gamma')).toBe(true)
  })

  it('TODO 992 の 1: 引き継いだだけで自分の発言の無いスレッドは今までどおり handoff-empty', async () => {
    const a = await manager.createThread({ title: 'T' })
    await turn(a.id, 'alpha question', 'alpha answer')
    const b = await manager.handoff(a.id)
    await expect(manager.handoff(b.id)).rejects.toThrow('aios-reason:handoff-empty')
  })

  it('同じ元のスレッドの引き継ぎ文は、行が増えるまで組み直さない (見積もり → 軽くして → 最初の送信)', async () => {
    const thread = await manager.createThread({ title: 'T' })
    await turn(thread.id, 'first question', 'first answer')
    const reads = vi.spyOn(ThreadStore.prototype, 'readTimelinePage')
    try {
      await manager.handoffEstimate(thread.id)
      const afterFirst = reads.mock.calls.length
      expect(afterFirst).toBeGreaterThan(0)
      await manager.handoffEstimate(thread.id)
      const created = await manager.handoff(thread.id)
      await manager.send(created.id, { text: 'go' })
      expect(adapter.sessions.at(-1)!.sent[0]?.text).toContain('first question')
      // The rows of the original thread are not read again (for the new thread's part, the original thread's id is not used to read).
      expect(reads.mock.calls.slice(afterFirst).filter((call) => call[0] === thread.id)).toHaveLength(0)

      // If rows are added to the original thread, it is rebuilt.
      await turn(thread.id, 'second question', 'second answer')
      const before = reads.mock.calls.filter((call) => call[0] === thread.id).length
      await manager.handoffEstimate(thread.id)
      expect(reads.mock.calls.filter((call) => call[0] === thread.id).length).toBeGreaterThan(before)
    } finally {
      reads.mockRestore()
    }
  })

  it('review X (TODO 992 の 1): 引き継ぎの先祖は添えた発言のターンが閉じるまでは版で、閉じた後は分岐点で控える', async () => {
    const a = await manager.createThread({ title: 'T' })
    await turn(a.id, 'alpha question', 'alpha answer')
    const aSession = adapter.sessions.at(-1)!
    const b = await manager.handoff(a.id)
    await turn(b.id, 'beta question', 'beta answer')
    // (The helper's turn is fed to the last session, so for a it is fed directly into a's own session.)
    const alpha = async (text: string): Promise<void> => {
      await manager.send(a.id, { text })
      aSession.emit({ threadId: a.id, kind: 'assistant_text', payload: { text: `${text} answer` } })
      aSession.emit({ threadId: a.id, kind: 'result', payload: RESULT })
      await settle()
    }
    // The next message from a arrives = the turn of the attached message is closed. From then on, b's handoff text does not change even if a advances.
    await alpha('alpha later')
    await manager.handoffEstimate(b.id)
    const reads = vi.spyOn(ThreadStore.prototype, 'readTimelinePage')
    try {
      await alpha('alpha even later')
      const afterGrow = reads.mock.calls.length
      await manager.handoffEstimate(b.id)
      expect(reads.mock.calls.length).toBe(afterGrow)
    } finally {
      reads.mockRestore()
    }
    const c = await manager.handoff(b.id)
    await manager.send(c.id, { text: 'gamma' })
    const sent = adapter.sessions.at(-1)!.sent[0]?.text ?? ''
    expect(sent).toContain('alpha answer')
    expect(sent).toContain('beta answer')
    expect(sent).not.toContain('alpha later')
  })
})

describe('SessionManager — バックエンドをまたぐモデルの選択 (TODO 1018)', () => {
  let other: FakeAdapter
  beforeEach(() => {
    other = new FakeAdapter('other', 'Other')
    other.models = [
      { id: 'o-1', label: 'O1' },
      { id: 'o-2', label: 'O2' }
    ]
    other.features = { 'thinking-level': false }
    manager = build([adapter, other])
  })

  async function turn(threadId: string, text: string, answer: string): Promise<void> {
    await manager.send(threadId, { text })
    const session = adapter.sessions.at(-1)!
    if (session.sent.length === 1) {
      session.emit({
        threadId,
        kind: 'session_started',
        payload: { backendSessionId: `b-${threadId.slice(0, 6)}`, backendVersion: null, model: null, cwd: null, reportedPermissionMode: null, tools: [], toolServers: [], resumed: false }
      })
    }
    session.emit({ threadId, kind: 'assistant_text', payload: { text: answer } })
    finishTurn(threadId)
    await settle()
  }

  it('まだ送っていないスレッドはその場でバックエンドを替える (thinking の無いバックエンドでは null)', async () => {
    const thread = await manager.createThread({ title: 'T', modelId: 'model-a', thinking: 'high' })
    const switched = await manager.switchBackend(thread.id, 'other', 'o-2')
    expect(switched.id).toBe(thread.id)
    expect(switched.backend).toBe('other')
    expect(switched.modelId).toBe('o-2')
    expect(switched.thinking).toBeNull()
    // It can be changed any number of times before sending (it does not branch).
    const back = await manager.switchBackend(thread.id, 'fake', 'model-b')
    expect(back.id).toBe(thread.id)
    expect(back.backend).toBe('fake')
    // Sending starts it with other.
    await manager.switchBackend(thread.id, 'other', 'o-1')
    await manager.send(thread.id, { text: 'hello' })
    expect(other.spawn).toHaveBeenCalledTimes(1)
    expect(adapter.spawn).not.toHaveBeenCalled()
  })

  it('会話のあるスレッドは backend を替えた新しいスレッドに分岐し、最初の送信に転写を添える。元は無傷', async () => {
    const thread = await manager.createThread({ title: '相談', modelId: 'model-a' })
    await turn(thread.id, 'first question', 'first answer')
    const created = await manager.switchBackend(thread.id, 'other', 'o-1')
    expect(created.id).not.toBe(thread.id)
    expect(created.backend).toBe('other')
    expect(created.modelId).toBe('o-1')
    expect(created.thinking).toBeNull()
    expect(created.forkedFrom).toMatchObject({ threadId: thread.id, handoff: true, files: false })
    expect(manager.listSummaries().find((s) => s.thread.id === thread.id)?.thread.backend).toBe('fake')

    await manager.send(created.id, { text: 'continue here' })
    const options = other.spawn.mock.calls.at(-1)?.[0]
    expect(options?.threadId).toBe(created.id)
    expect(options?.resumeBackendSessionId).toBeNull()
    const sent = other.sessions.at(-1)!.sent[0]?.text ?? ''
    expect(sent).toContain('first question')
    expect(sent).toContain('first answer')
    expect(sent).toContain('different coding agent')
    expect(sent.endsWith('continue here')).toBe(true)
  })

  it('同じバックエンドなら何もしない。登録簿に無い・一覧に無いモデルは断る', async () => {
    const thread = await manager.createThread({ title: 'T' })
    expect((await manager.switchBackend(thread.id, 'fake', 'model-b')).backend).toBe('fake')
    await expect(manager.switchBackend(thread.id, 'nope', null)).rejects.toThrow('aios-reason:backend-not-registered')
    await expect(manager.switchBackend(thread.id, 'other', 'model-a')).rejects.toThrow('aios-reason:model-not-selectable')
  })

  it('review: 使えない・ログインしていないバックエンドへは main でも断る (行は替えない)', async () => {
    const thread = await manager.createThread({ title: 'T', thinking: 'high' })
    const base = await other.getStatus()
    const spy = vi.spyOn(other, 'getStatus')
    spy.mockResolvedValueOnce({ ...base, available: false, loggedIn: false })
    await expect(manager.switchBackend(thread.id, 'other', 'o-1')).rejects.toThrow('aios-reason:agent-unavailable')
    spy.mockResolvedValueOnce({ ...base, loggedIn: false })
    await expect(manager.switchBackend(thread.id, 'other', 'o-1')).rejects.toThrow('aios-reason:agent-not-logged-in')
    spy.mockRestore()
    const row = manager.listSummaries().find((s) => s.thread.id === thread.id)?.thread
    expect(row?.backend).toBe('fake')
    expect(row?.thinking).toBe('high')
  })

  it('review: 発言の無いスレッドでその場の切り替えに外れたら handoff-empty ではなく backend-switch-busy', async () => {
    // A process is running.
    const live = await manager.createThread({ title: 'T' })
    const internals = manager as unknown as { live: Map<string, unknown> }
    const has = vi.spyOn(internals.live, 'has').mockImplementation((id) => id === live.id)
    try {
      await expect(manager.switchBackend(live.id, 'other', 'o-1')).rejects.toThrow('aios-reason:backend-switch-busy')
    } finally {
      has.mockRestore()
    }
    // There is no process, but there is a session row (it falls outside the SQL condition).
    const started = await manager.createThread({ title: 'T' })
    db.prepare(
      `INSERT INTO sessions (id, thread_id, backend_session_id, started_at, turns, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('s-1018', started.id, 'b-1018', 1, 0, 0)
    await expect(manager.switchBackend(started.id, 'other', 'o-1')).rejects.toThrow('aios-reason:backend-switch-busy')
    expect(manager.listSummaries().find((s) => s.thread.id === started.id)?.thread.backend).toBe('fake')
    expect(manager.listSummaries().filter((s) => s.thread.forkedFrom?.threadId === started.id)).toHaveLength(0)
  })

  it('review: 別のバックエンドへの分岐は、作るときと最初の送信で引き継ぎ文を組み直さない', async () => {
    const thread = await manager.createThread({ title: '相談', modelId: 'model-a' })
    await turn(thread.id, 'first question', 'first answer')
    const reads = vi.spyOn(ThreadStore.prototype, 'readTimelinePage')
    try {
      const created = await manager.switchBackend(thread.id, 'other', 'o-1')
      const afterCreate = reads.mock.calls.filter((call) => call[0] === thread.id).length
      expect(afterCreate).toBeGreaterThan(0)
      await manager.send(created.id, { text: 'continue here' })
      expect(other.sessions.at(-1)!.sent[0]?.text ?? '').toContain('different coding agent')
      expect(reads.mock.calls.filter((call) => call[0] === thread.id).length).toBe(afterCreate)
    } finally {
      reads.mockRestore()
    }
  })
})

describe('SessionManager — MCP の接続待ち (TODO 869 案 C)', () => {
  it('mcp_connecting は runtime.mcpPending に載り、0 か session_started で外れる。保存しない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    expect(runtimeOf(thread.id).mcpPending).toBeUndefined()
    session.emit({ threadId: thread.id, kind: 'mcp_connecting', payload: { pending: 2 } })
    expect(runtimeOf(thread.id).mcpPending).toBe(2)
    session.emit({ threadId: thread.id, kind: 'mcp_connecting', payload: { pending: 0 } })
    expect(runtimeOf(thread.id).mcpPending).toBeUndefined()
    session.emit({ threadId: thread.id, kind: 'mcp_connecting', payload: { pending: 1 } })
    expect(runtimeOf(thread.id).mcpPending).toBe(1)
    session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: 'ok' } })
    finishTurn(thread.id)
    await settle()
    const kinds = (await manager.timeline(thread.id)).events.map((e) => e.kind)
    expect(kinds).not.toContain('mcp_connecting')
    expect(kinds).not.toContain('unknown')
  })
})

describe('SessionManager — API の再試行と版管理の変化 (項目 277)', () => {
  it('api_retry は runtime に載り、次の本文で消える。どちらも保存しない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    expect(runtimeOf(thread.id).apiRetry).toBeUndefined()
    session.emit({
      threadId: thread.id,
      kind: 'api_retry',
      payload: { attempt: 5, maxRetries: 10, retryDelayMs: 9612, errorStatus: 529 }
    })
    expect(runtimeOf(thread.id).apiRetry).toMatchObject({ attempt: 5, maxRetries: 10, retryDelayMs: 9612, errorStatus: 529 })
    session.emit({
      threadId: thread.id,
      kind: 'api_retry',
      payload: { attempt: 6, maxRetries: 10, retryDelayMs: 19000, errorStatus: null }
    })
    expect(runtimeOf(thread.id).apiRetry).toMatchObject({ attempt: 6, errorStatus: null })
    session.emit({ threadId: thread.id, kind: 'vcs_state_changed', payload: { change: 'push', branch: 'main' } })
    // The notice of version management does not touch the retry memo.
    expect(runtimeOf(thread.id).apiRetry).toMatchObject({ attempt: 6 })
    session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: 'ok' } })
    expect(runtimeOf(thread.id).apiRetry).toBeUndefined()
    finishTurn(thread.id)
    await settle()
    const kinds = (await manager.timeline(thread.id)).events.map((e) => e.kind)
    expect(kinds).not.toContain('api_retry')
    expect(kinds).not.toContain('vcs_state_changed')
    expect(kinds).not.toContain('unknown')
  })
})

describe('SessionManager — ツールの経過 (項目 259)', () => {
  it('経過が runtime に載り、結果で消える。保存はされない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    session.emit({
      threadId: thread.id,
      kind: 'tool_use',
      payload: { toolUseId: 'tu-bash', name: 'Bash', summary: 'sleep', input: { command: 'sleep' }, truncated: false }
    })
    expect(runtimeOf(thread.id).toolProgress).toBeUndefined()
    session.emit({
      threadId: thread.id,
      kind: 'tool_progress',
      payload: { toolUseId: 'tu-bash', toolName: 'Bash', elapsedSeconds: 30, heartbeat: true }
    })
    expect(runtimeOf(thread.id).toolProgress).toMatchObject([
      { toolUseId: 'tu-bash', toolName: 'Bash', elapsedSeconds: 30 }
    ])
    session.emit({ threadId: thread.id, kind: 'tool_result', payload: { toolUseId: 'tu-bash', ok: true, bytes: 1 } })
    expect(runtimeOf(thread.id).toolProgress).toBeUndefined()
    finishTurn(thread.id)
    await settle()
    const kinds = (await manager.timeline(thread.id)).events.map((e) => e.kind)
    expect(kinds).not.toContain('tool_progress')
    expect(kinds).toContain('tool_use')
  })
})

describe('SessionManager — クリップボードから貼った画像 (項目 319、第 17 波 束 F)', () => {
  const BASE64 = Buffer.from('fake-png-bytes-for-319').toString('base64')
  const pasted = {
    uri: 'aios-clipboard:00000000-0000-0000-0000-000000000319',
    name: 'Pasted image 1.png',
    kind: 'image' as const,
    mediaType: 'image/png',
    base64: BASE64,
    bytes: 22
  }

  it('送信で image ブロックになり、文には名前だけ。中身は保存されない (制約 9 / 10)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '見て', attachments: [pasted] })
    const session = adapter.sessions.at(-1)!
    expect(session.sent[0]?.images).toEqual([{ mediaType: 'image/png', base64: BASE64 }])
    expect(session.sent[0]?.text).toBe('(添付: Pasted image 1.png)\n見て')
    finishTurn(thread.id)
    await settle()
    const events = (await manager.timeline(thread.id)).events
    expect(JSON.stringify(events)).not.toContain(BASE64)
    const stored = db.prepare('SELECT payload FROM thread_events').all() as { payload: string }[]
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.some((row) => row.payload.includes(BASE64))).toBe(false)
  })

  it('TODO 550: 送った画像は user_text に残る — 貼り付けは縮小版だけ、見られるファイルはパスだけ、原寸は残さない', async () => {
    const thumbnail = `data:image/webp;base64,${Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]).toString('base64')}`
    const thread = await manager.createThread({})
    await manager.send(thread.id, {
      text: '見て',
      attachments: [
        { ...pasted, thumbnail },
        { ...pasted, uri: 'file:///Users/tester/work/shot.png', name: 'shot.png', thumbnail },
        { ...pasted, uri: 'file:///Users/tester/excluded/tmp.png', name: 'tmp.png', thumbnail: 'data:image/png;base64,AAAA' }
      ]
    })
    const expected = [
      { name: 'Pasted image 1.png', thumbnail },
      { name: 'shot.png', uri: 'file:///Users/tester/work/shot.png' },
      // If the reduced copy is broken in an excluded place (in place of a temporary folder), only the name.
      { name: 'tmp.png' }
    ]
    finishTurn(thread.id)
    await settle()
    const user = (await manager.timeline(thread.id)).events.find((e) => e.kind === 'user_text')
    expect(user?.kind === 'user_text' ? user.payload.attachments : null).toEqual(expected)
    const stored = db.prepare("SELECT payload FROM thread_events WHERE kind = 'user_text'").get() as { payload: string }
    expect(JSON.parse(stored.payload).attachments).toEqual(expected)
    expect(stored.payload).not.toContain(BASE64)
  })

  it('予約に積んでも ThreadRuntime には数だけ (base64 を載せない)。取り出すと中身ごと戻る', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '一つ目' })
    const queued = await manager.send(thread.id, { text: '二つ目', attachments: [pasted] })
    if (queued.kind !== 'queued') throw new Error('not queued')
    expect(runtimeOf(thread.id).reservations.map((r) => r.attachments)).toEqual([1])
    expect(JSON.stringify(summaries)).not.toContain(BASE64)
    expect(manager.takeReservation(thread.id, queued.reservationId)?.attachments?.[0]?.base64).toBe(BASE64)
  })

  it('画像でない形で来た貼り付けの添付はパス参照にせず落とす (送信は失敗しない)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'x', attachments: [{ ...pasted, kind: 'reference' }] })
    const session = adapter.sessions.at(-1)!
    expect(session.sent[0]?.text).toBe('x')
    expect(session.sent[0]?.images ?? []).toEqual([])
  })
})

describe('SessionManager — 定期実行のスレッド (TODO 323、第 18 波 束 A)', () => {
  const request = {
    jobId: 'job-1',
    name: '朝の確認',
    prompt: 'メールを見て',
    cwd: '/Users/tester/work',
    modelId: 'model-b',
    thinking: 'high' as const,
    approvalStrict: false
  }

  it('新しいスレッドを起こして送る: 題名はジョブ名、⏰ の印、指定どおりの model / thinking', async () => {
    const threadId = await manager.runScheduledJob(request)
    const thread = summaries.find((s) => s.thread.id === threadId)?.thread
    expect(thread?.title).toBe('朝の確認')
    expect(thread?.scheduledJobId).toBe('job-1')
    expect(thread?.cwdUri).toBe('file:///Users/tester/work')
    expect(thread?.modelId).toBe('model-b')
    expect(thread?.thinking).toBe('high')
    expect(thread?.approvalStrict).toBe(false)
    expect(adapter.sessions).toHaveLength(1)
    // A new thread every time (not continued with `--resume`).
    const second = await manager.runScheduledJob(request)
    expect(second).not.toBe(threadId)
    expect(adapter.sessions).toHaveLength(2)
    // An ordinary thread has no mark column.
    const plain = await manager.createThread({})
    expect('scheduledJobId' in plain).toBe(false)
  })

  it('作業フォルダが null なら所属なし (捨て場)。厳格モードはジョブの指定', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aios-schedule-'))
    try {
      await manager.stop()
      manager = build([adapter], home)
      const threadId = await manager.runScheduledJob({ ...request, cwd: null, approvalStrict: true })
      const thread = summaries.find((s) => s.thread.id === threadId)?.thread
      expect(thread?.cwdName).toBe('')
      expect(thread?.cwdUri).toBe(`file://${scratchCwd(home, threadId)}`)
      expect(thread?.approvalStrict).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('走っている間は busy、ターンが終われば busy でない', async () => {
    const threadId = await manager.runScheduledJob(request)
    expect(manager.isThreadBusy(threadId)).toBe(true)
    finishTurn(threadId)
    expect(manager.isThreadBusy(threadId)).toBe(false)
    expect(manager.isThreadBusy('unknown')).toBe(false)
  })

  it('TODO 351 (351-2): ターンが終わったら、設定画面の一覧を直すための合図 (scheduledJobRunningChanged) を出す', async () => {
    const threadId = await manager.runScheduledJob(request)
    expect(runningChangedCalls).toHaveLength(0)
    finishTurn(threadId)
    expect(runningChangedCalls).toEqual(['job-1'])
  })

  it('TODO 351 (351-2): プロセスが死んでも (承認待ちのまま含む) 同じ合図を出す', async () => {
    const threadId = await manager.runScheduledJob({ ...request, approvalStrict: true })
    const session = adapter.sessions.at(-1)!
    void manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't1', input: { file_path: '/tmp/x' } }
    })
    await vi.waitFor(() => expect(manager.isThreadBusy(threadId)).toBe(true))
    runningChangedCalls = []
    // Dies with no one having stopped it, like `kill -9` (the same way of dying as the NG case of 351-3).
    session.handlers.onExit({ code: null, signal: 'SIGKILL', sawResult: false, requested: false })
    await settle()
    expect(runningChangedCalls).toEqual(['job-1'])
  })

  it('最初のターンの終わりは応答の先頭を添えて通知する (redaction 済み)。2 回目以降は普段の通知', async () => {
    const threadId = await manager.runScheduledJob(request)
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId, kind: 'assistant_text', payload: { text: '要返信は 2 件。\n\n鍵 sk-ant-api03-' + 'a'.repeat(40) } })
    session.emit({ threadId, kind: 'result', payload: RESULT })
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]?.kind).toBe('scheduledDone')
    expect(notifyCalls[0]?.excerpt).toMatch(/^要返信は 2 件。 鍵 /)
    expect(notifyCalls[0]?.excerpt).not.toContain('a'.repeat(40))
    await manager.send(threadId, { text: '続けて' })
    finishTurn(threadId)
    expect(notifyCalls.at(-1)?.kind).toBe('turnEnded')
  })

  it('最初のターンで承認待ちになったら「止まった」通知', async () => {
    const threadId = await manager.runScheduledJob({ ...request, approvalStrict: true })
    const session = adapter.sessions.at(-1)!
    void manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 't1', input: { file_path: '/tmp/x' } }
    })
    await vi.waitFor(() => expect(notifyCalls).toHaveLength(1))
    expect(notifyCalls[0]).toMatchObject({ kind: 'scheduledApproval', threadId })
    expect(manager.isThreadBusy(threadId)).toBe(true)
  })

  it('TODO 959 (review): 無人のターンの承認の締め切りは起こした時に固定し、次の予定より前に切る', async () => {
    const hour = 3_600_000
    let next: number | null = Date.now() + hour
    await manager.stop()
    manager = new SessionManager({
      ...(manager as unknown as { deps: SessionManagerDeps }).deps,
      scheduledJobNextRunAt: () => next
    })
    const deadlineOf = (threadId: string): number | null =>
      (
        manager as unknown as {
          gatewayRequests: { host: { approvalDeadline: (threadId: string) => number | null } }
        }
      ).gatewayRequests.host.approvalDeadline(threadId)
    const fixed = next - SCHEDULED_APPROVAL_MARGIN_MS
    const threadId = await manager.runScheduledJob(request)
    expect(deadlineOf(threadId)).toBe(fixed)
    // The scheduler's "skip if running" moves the base to now; even if the next scheduled time advances one cycle, the deadline does not change.
    next = next + hour
    expect(deadlineOf(threadId)).toBe(fixed)
    // If the first turn ends, there is no deadline (a turn continued by a person is the same as an ordinary thread).
    finishTurn(threadId)
    expect(deadlineOf(threadId)).toBeNull()
    // A job with no next scheduled time (once only and disabled) has no deadline.
    next = null
    const once = await manager.runScheduledJob(request)
    expect(deadlineOf(once)).toBeNull()
  })

  it('TODO 959 (review): 締め切りの式 — 余白が持てない短い周期は中間、過ぎた予定は今', () => {
    const start = 1_000_000
    expect(scheduledApprovalDeadline(start, null)).toBeNull()
    expect(scheduledApprovalDeadline(start, start + 3_600_000)).toBe(start + 3_600_000 - SCHEDULED_APPROVAL_MARGIN_MS)
    expect(scheduledApprovalDeadline(start, start + 60_000)).toBe(start + 30_000)
    expect(scheduledApprovalDeadline(start, start - 5)).toBe(start)
  })

  it('送れなかったら空のスレッドを消して投げる', async () => {
    adapter.nextSpawn = async () => {
      throw new Error('spawn failed')
    }
    await expect(manager.runScheduledJob(request)).rejects.toThrow('spawn failed')
    await settle()
    expect(summaries.some((s) => s.thread.scheduledJobId === 'job-1')).toBe(false)
  })

  it('確認用の複製 (AIOS_DISABLE_AGENT) ではスレッドも作らない', async () => {
    await manager.stop()
    manager = new SessionManager({ ...(manager as unknown as { deps: SessionManagerDeps }).deps, agentDisabled: true })
    await expect(manager.runScheduledJob(request)).rejects.toThrow(/agent-disabled/)
    expect(new ThreadStore(db).listThreads()).toHaveLength(0)
  })

  it('並走の上限: 応答中のセッションで埋まっていれば余地なし、追い出せれば余地あり', async () => {
    manager.setSettings({ maxConcurrent: 1 })
    expect(manager.hasSessionRoom()).toBe(true)
    const threadId = await manager.runScheduledJob(request)
    expect(manager.hasSessionRoom()).toBe(false)
    finishTurn(threadId)
    expect(manager.hasSessionRoom()).toBe(true)
  })
})

describe('添付: 除外された一時フォルダの画像は中身で添付する (TODO 489)', () => {
  /**
   * A place near the ⌘⇧4 thumbnail (under `os.tmpdir()` = `/var/folders/…/T/`). **A directory named `TemporaryItems` is not created** — macOS refuses readdir / rmdir / rename on a directory with that name (EPERM, even outside the sandbox), so it cannot be cleaned up and remains (measured 2026-10-07, wave25.md bundle A). Opening a file inside it by its path does work.
   */
  let top: string
  let shotDir: string
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

  beforeEach(async () => {
    top = mkdtempSync(join(tmpdir(), 'aios-489-'))
    shotDir = join(top, 'NSIRD_screencaptureui_x')
    mkdirSync(shotDir, { recursive: true })
    const { PathDenied } = await import('../src/common/fs-policy.js')
    await manager.stop()
    const deps = (manager as unknown as { deps: SessionManagerDeps }).deps
    // As with the real gate, temporary folders are refused by the exclusions (`/var` / `/private` / `.TemporaryItems`).
    const fs = {
      ...(deps.fs as unknown as Record<string, unknown>),
      assertAllowed: () => {
        throw new PathDenied('excluded')
      }
    } as unknown as FsAccess
    manager = new SessionManager({ ...deps, fs })
  })

  afterEach(() => {
    rmSync(top, { recursive: true, force: true })
  })

  it('PNG は kind: image (base64 入り) になり、参照範囲の許可は聞かない。名前はファイル名', async () => {
    const path = join(shotDir, 'スクリーンショット 2026-10-05 9.40.11.png')
    writeFileSync(path, PNG)
    const thread = await manager.createThread({})
    const uri = `file://${encodeURI(path)}`
    const result = await manager.resolveAttachment(thread.id, uri)
    expect(result).toEqual({
      ok: true,
      attachment: {
        uri,
        name: 'スクリーンショット 2026-10-05 9.40.11.png',
        kind: 'image',
        mediaType: 'image/png',
        base64: PNG.toString('base64'),
        bytes: PNG.length
      },
      outsideAllowed: false,
      keepsThumbnail: true
    })
  })

  it('一時フォルダでも画像でないものは理由コード (attach-temp-not-image)、消えていたら attach-gone', async () => {
    const thread = await manager.createThread({})
    const text = join(shotDir, 'note.png')
    writeFileSync(text, 'not an image')
    expect(await manager.resolveAttachment(thread.id, `file://${text}`)).toEqual({
      ok: false,
      reason: 'attach-temp-not-image'
    })
    expect(await manager.resolveAttachment(thread.id, `file://${join(shotDir, 'gone.png')}`)).toEqual({
      ok: false,
      reason: 'attach-gone'
    })
  })

  it('一時フォルダの外の除外 (例: ~/.ssh) は今までどおり path-excluded。読まない', async () => {
    const thread = await manager.createThread({})
    expect(await manager.resolveAttachment(thread.id, 'file:///Users/tester/.ssh/id.png')).toEqual({
      ok: false,
      reason: 'path-excluded'
    })
  })
})

describe('SessionManager — 中断の印 (TODO 521、第 26 波 束 B)', () => {
  const failed: ResultPayload = { ...RESULT, ok: false, subtype: 'success' }
  const interruptedOf = (threadId: string): string | undefined =>
    summaries.find((s) => s.thread.id === threadId)?.thread.interrupted
  const storedOf = (threadId: string): string | undefined => new ThreadStore(db).getThread(threadId)?.interrupted

  it('接続の再試行の後の失敗は interrupt-network。DB に残り、開いても消えず、次のターンの本文で消える', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    session.emit({
      threadId: thread.id,
      kind: 'api_retry',
      payload: { attempt: 10, maxRetries: 10, retryDelayMs: 1000, errorStatus: null }
    })
    // The mark is not set during retries yet (the turn has not ended).
    expect(interruptedOf(thread.id)).toBeUndefined()
    session.emit({ threadId: thread.id, kind: 'result', payload: failed })
    expect(interruptedOf(thread.id)).toBe('interrupt-network')
    expect(storedOf(thread.id)).toBe('interrupt-network')
    // Merely opening the thread does not remove it (owner decision 2026-10-08).
    manager.openThread(thread.id, 1)
    manager.focusView(1)
    expect(storedOf(thread.id)).toBe('interrupt-network')
    // Resume (the next send) → it remains during retries → it is cleared when the body arrives.
    await manager.send(thread.id, { text: 'resume' })
    session.emit({
      threadId: thread.id,
      kind: 'api_retry',
      payload: { attempt: 1, maxRetries: 10, retryDelayMs: 1000, errorStatus: null }
    })
    expect(interruptedOf(thread.id)).toBe('interrupt-network')
    session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: 'back' } })
    expect(interruptedOf(thread.id)).toBeUndefined()
    expect(storedOf(thread.id)).toBeUndefined()
    finishTurn(thread.id)
    expect(interruptedOf(thread.id)).toBeUndefined()
  })

  it('code-review (628): 送信と中断が解けたときに threadResumed を呼び、isThreadInterrupted が印を映す', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'go' })
    // The conversation's send was received (synchronously, before the `await`).
    expect(resumedCalls).toEqual([thread.id])
    const session = adapter.sessions.at(-1)!
    session.emit({ threadId: thread.id, kind: 'result', payload: failed })
    expect(manager.isThreadInterrupted(thread.id)).toBe(true)
    resumedCalls = []
    const sent = manager.send(thread.id, { text: 'resume' })
    expect(resumedCalls).toEqual([thread.id])
    await sent
    resumedCalls = []
    // The body arrived and the interruption was resolved.
    session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: 'back' } })
    expect(manager.isThreadInterrupted(thread.id)).toBe(false)
    expect(resumedCalls).toEqual([thread.id])
    expect(manager.isThreadInterrupted('no-such-thread')).toBe(false)
  })

  it('rate_limit の rejected の後の失敗は interrupt-limit、手がかりが無ければ interrupt-error', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    session.emit({
      threadId: thread.id,
      kind: 'rate_limit',
      payload: { status: 'rejected', windowType: null, resetsAt: null, usingOverage: false }
    })
    session.emit({ threadId: thread.id, kind: 'result', payload: failed })
    expect(interruptedOf(thread.id)).toBe('interrupt-limit')

    const other = await manager.createThread({})
    await manager.send(other.id, { text: 'go' })
    adapter.sessions.at(-1)!.emit({ threadId: other.id, kind: 'result', payload: failed })
    expect(interruptedOf(other.id)).toBe('interrupt-error')
  })

  it('ターンの途中でプロセスが落ちたら interrupt-exit。停止ボタン (自分で止めた) と割り込みでは立てない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    session.alive = false
    session.handlers.onExit({ code: 1, signal: null, sawResult: false, requested: false })
    expect(interruptedOf(thread.id)).toBe('interrupt-exit')

    const stopped = await manager.createThread({})
    await manager.send(stopped.id, { text: 'go' })
    adapter.sessions.at(-1)!.abort()
    expect(interruptedOf(stopped.id)).toBeUndefined()

    const cut = await manager.createThread({})
    await manager.send(cut.id, { text: 'go' })
    adapter.sessions.at(-1)!.emit({ threadId: cut.id, kind: 'result', payload: { ...failed, interrupted: true } })
    expect(interruptedOf(cut.id)).toBeUndefined()
  })

  it('ターンの合間 (result の後) にプロセスが終わっても立てない', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: 'go' })
    finishTurn(thread.id)
    const session = adapter.sessions.at(-1)!
    session.alive = false
    session.handlers.onExit({ code: 0, signal: null, sawResult: true, requested: false })
    expect(interruptedOf(thread.id)).toBeUndefined()
  })
})

describe('SessionManager — loginTarget の cwd (TODO 960 の review)', () => {
  it('会話の cwd が使えればそこ、無い・除外・消えた・ディレクトリでないならホームに落とす (断らない)', async () => {
    const login = { kind: 'ok' as const, command: 'tool', args: ['auth', 'login'] }
    ;(adapter as unknown as { loginCommand: () => typeof login }).loginCommand = () => login
    const dir = mkdtempSync(join(tmpdir(), 'aios-login-cwd-'))
    try {
      const file = join(dir, 'file.txt')
      writeFileSync(file, 'x')
      const live = await manager.createThread({ cwdUri: `file://${dir}` })
      const excluded = await manager.createThread({ cwdUri: 'file:///Users/tester/excluded' })
      const gone = await manager.createThread({ cwdUri: 'file:///Users/tester/does-not-exist' })
      const notDir = await manager.createThread({ cwdUri: `file://${file}` })
      expect(manager.loginTarget(live.id)).toEqual({ cwd: dir, command: 'tool', args: ['auth', 'login'] })
      for (const thread of [excluded, gone, notDir]) {
        expect(manager.loginTarget(thread.id)).toEqual({ cwd: homedir(), command: 'tool', args: ['auth', 'login'] })
      }
      expect(manager.loginTarget(null)).toMatchObject({ cwd: homedir() })
      expect(manager.loginTarget('no-such-thread')).toMatchObject({ cwd: homedir() })
      rmSync(dir, { recursive: true, force: true })
      expect(manager.loginTarget(live.id)).toMatchObject({ cwd: homedir() })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('SessionManager — OS の sandbox (TODO 1106、第 68 波 束 A)', () => {
  const request = {
    jobId: 'job-sandbox',
    name: '夜の整理',
    prompt: '片付けて',
    cwd: '/Users/tester/work',
    modelId: null,
    thinking: null,
    approvalStrict: false
  }
  const lastSpawn = (): SpawnOptions => {
    const options = adapter.spawn.mock.calls.at(-1)?.[0]
    if (options === undefined) throw new Error('no spawn')
    return options
  }
  const threadOf = (id: string): ThreadSummary['thread'] | undefined =>
    manager.listSummaries().find((s) => s.thread.id === id)?.thread

  it('無人のスレッド (定時ジョブ) は既定で ON、対話のスレッドは OFF。ON なら許可表を起動に渡す', async () => {
    const threadId = await manager.runScheduledJob(request)
    expect(threadOf(threadId)?.osSandbox).toBe(true)
    expect(lastSpawn().osSandbox).toEqual({
      allowedDomains: ['registry.npmjs.org', 'github.com', '*.github.com'],
      allowWrite: ['~/.npm']
    })
    const plain = await manager.createThread({})
    expect(plain.osSandbox).toBeUndefined()
    await manager.send(plain.id, { text: 'x' })
    expect(lastSpawn().osSandbox).toBeUndefined()
  })

  it('バックエンドが持たなければ、定時ジョブでも OFF で作る (ON のまま作ると送れない)', async () => {
    adapter.features = { 'os-sandbox': false }
    const threadId = await manager.runScheduledJob(request)
    expect(threadOf(threadId)?.osSandbox).toBeUndefined()
    expect(lastSpawn().osSandbox).toBeUndefined()
  })

  it('許可表は設定から読む: 聞かない接続先のホストも足し、読めない値は落とす', async () => {
    manager.setApprovalPolicy({
      sandboxAllowedDomainsAdd: ['*.Example.com', 'https://bad'],
      sandboxAllowWriteRemove: ['~/.npm'],
      sandboxAllowWriteAdd: ['~/.cache/pip', 'relative/path'],
      sshAllowedHostsAdd: ['me@build.example.org', 'winbox']
    })
    const thread = await manager.createThread({})
    manager.setOsSandbox(thread.id, true)
    await manager.send(thread.id, { text: 'x' })
    expect(lastSpawn().osSandbox).toEqual({
      allowedDomains: ['registry.npmjs.org', 'github.com', '*.github.com', '*.example.com', 'build.example.org', 'winbox'],
      allowWrite: ['~/.cache/pip']
    })
  })

  it('書ける場所からホームそのものとその親を落とす。別の場所のホーム (shared の形では拒めない) も (TODO 1109 の 8)', async () => {
    // On POSIX, os.homedir() reads $HOME. Makes a home in another place and compares.
    const saved = process.env.HOME
    process.env.HOME = '/Volumes/data/me'
    try {
      const next = manager.setApprovalPolicy({
        sandboxAllowWriteAdd: ['/Volumes/data/me', '/Volumes/data', '/Volumes', '~/.cache/pip', '/Volumes/data/other']
      })
      expect(next.sandboxAllowWrite).toEqual(['~/.npm', '~/.cache/pip', '/Volumes/data/other'])
      // Dropped items are not silently ignored: they are returned in the result (the settings screen shows them below the field; review 9 of TODO 1109, stage 8). They are not included in the value to save.
      expect(next.sandboxWriteDropped).toEqual([
        { path: '/Volumes/data/me', reason: 'home-or-parent' },
        { path: '/Volumes/data', reason: 'home-or-parent' },
        { path: '/Volumes', reason: 'home-or-parent' }
      ])
      expect(manager.getApprovalPolicy()).not.toHaveProperty('sandboxWriteDropped')
      // If there is nothing to drop, the whole field is absent.
      expect(manager.setApprovalPolicy({ sandboxAllowWriteAdd: ['/opt/cache'] })).not.toHaveProperty('sandboxWriteDropped')
      // Also dropped at startup (for a value saved before this test, or when the home moved). Checked by writing the saved value directly.
      ;(manager as unknown as { broker: { setPolicy(p: unknown): void; getPolicy(): Record<string, unknown> } }).broker.setPolicy({
        ...manager.getApprovalPolicy(),
        sandboxAllowWrite: ['~/.npm', '/Volumes/data']
      })
      const thread = await manager.createThread({})
      manager.setOsSandbox(thread.id, true)
      await manager.send(thread.id, { text: 'x' })
      expect(lastSpawn().osSandbox?.allowWrite).toEqual(['~/.npm'])
    } finally {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
    }
  })

  it('⋯ で切り替えると、走っているプロセスは次の送信で起こし直す (起動の旗なので走ったままは揃えられない)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '一つ目' })
    finishTurn(thread.id)
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    manager.setOsSandbox(thread.id, true)
    expect(threadOf(thread.id)?.osSandbox).toBe(true)
    await manager.send(thread.id, { text: '二つ目' })
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledTimes(2))
    expect(lastSpawn().osSandbox).toBeDefined()
    expect(adapter.sessions[0]?.alive).toBe(false)
  })

  it('ON にできるのはバックエンドが持つときだけ。OFF にはいつでもできる。ON のまま使えなくなったら起動を断る', async () => {
    const thread = await manager.createThread({})
    adapter.features = { 'os-sandbox': false }
    expect(() => manager.setOsSandbox(thread.id, true)).toThrow(/os-sandbox-unsupported/)
    expect(threadOf(thread.id)?.osSandbox).toBeUndefined()

    adapter.features = {}
    manager.setOsSandbox(thread.id, true)
    adapter.features = { 'os-sandbox': false }
    await expect(manager.send(thread.id, { text: 'x' })).rejects.toThrow(/os-sandbox-blocked/)
    expect(adapter.spawn).not.toHaveBeenCalled()
    manager.setOsSandbox(thread.id, false)
    expect(threadOf(thread.id)?.osSandbox).toBeUndefined()
    await manager.send(thread.id, { text: 'y' })
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('sandbox を有効にして起こしたプロセスの「sandbox の外で走らせる」要求は、既定の全部許可でも聞かずに拒む', async () => {
    ;(adapter as unknown as { unsandboxedRequest: (tool: string, input: unknown) => boolean }).unsandboxedRequest = (tool, input) =>
      tool === 'Bash' && (input as Record<string, unknown>)['dangerouslyDisableSandbox'] === true
    const threadId = await manager.runScheduledJob(request)
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const denied = await manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Bash', toolUseId: 't1', input: { command: 'touch ~/x', dangerouslyDisableSandbox: true } }
    })
    expect(denied).toMatchObject({ allowed: false })
    expect(manager.listApprovals()).toEqual([])
    const allowed = await manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Bash', toolUseId: 't2', input: { command: 'ls' } }
    })
    expect(allowed).toMatchObject({ allowed: true })
    // The result row is saved on a 16 ms cycle.
    await vi.waitFor(async () => {
      const outcomes = (await manager.timeline(threadId)).events
        .filter((e) => e.kind === 'permission_request')
        .map((e) => (e.kind === 'permission_request' ? e.payload.outcome : null))
      expect(outcomes).toContainEqual({ kind: 'denied', by: 'system', message: 'approval-cancelled-os-sandbox' })
    })

    // A process without a sandbox (an interactive thread, OFF) is judged as usual even with the same mark (the default lets it through).
    const plain = await manager.createThread({})
    await manager.send(plain.id, { text: 'x' })
    const plainSession = adapter.sessions.at(-1)
    if (plainSession === undefined) throw new Error('no session')
    await expect(
      manager.handleGatewayRequest({
        sessionId: plainSession.sessionId,
        kind: 'approve',
        payload: { toolName: 'Bash', toolUseId: 't3', input: { command: 'touch ~/x', dangerouslyDisableSandbox: true } }
      })
    ).resolves.toMatchObject({ allowed: true })
  })
})

describe('SessionManager — OS の sandbox の review の直し (TODO 1106、第 68 波 X)', () => {
  it('ON にできないバックエンドで ON を頼むと理由コードで断る (未 probe を含む)', async () => {
    const thread = await manager.createThread({})
    adapter.features = { 'os-sandbox': false }
    expect(() => manager.setOsSandbox(thread.id, true)).toThrow(/os-sandbox-unsupported/)
  })

  it('起動中 (spawn の途中) に合流した送信も、sandbox の設定が違えば起動の後で起こし直す', async () => {
    const thread = await manager.createThread({})
    let release = (): void => undefined
    adapter.nextSpawn = async (options, handlers) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      const session = new FakeSession(options.sessionId, handlers)
      adapter.sessions.push(session)
      return session
    }
    const first = manager.send(thread.id, { text: '一つ目' })
    first.catch(() => undefined)
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledTimes(1))
    manager.setOsSandbox(thread.id, true)
    const second = manager.send(thread.id, { text: '二つ目' })
    second.catch(() => undefined)
    release()
    await first
    finishTurn(thread.id)
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledTimes(2))
    expect(adapter.spawn.mock.calls.at(-1)?.[0].osSandbox).toBeDefined()
    release()
    await second
  })
})

describe('SessionManager — トリガーの無人の読み取り専用のターン (TODO 1216、第 84 波 束 A)', () => {
  const request = {
    pluginId: 'aios.fake',
    triggerId: 'new-mail',
    triggerName: '新着メール',
    title: '見積もりの件',
    url: 'https://mail.example.com/t/1',
    cwd: '/Users/tester/work',
    prompt: '[aios trigger] read-only',
    modelId: 'model-b',
    thinking: 'high' as const
  }

  /** As in the real Adapter, gives it an entry point that passes only the built-in read-only tools. */
  function withReadOnlyTools(): void {
    Object.assign(adapter, { unattendedReadOnlyTool: (toolName: string) => toolName === 'Read' || toolName === 'Grep' })
  }

  async function approve(sessionId: string, toolName: string, input: Record<string, unknown> = {}): Promise<{ allowed: boolean; message: string }> {
    return (await manager.handleGatewayRequest({
      sessionId,
      kind: 'approve',
      payload: { toolName, toolUseId: `tu-${toolName}`, input }
    })) as { allowed: boolean; message: string }
  }

  it('新しい会話を起こす: 出所の印・OS の sandbox・読み取り専用の起動・指定の model / thinking', async () => {
    const threadId = await manager.runTriggered(request)
    const thread = summaries.find((s) => s.thread.id === threadId)?.thread
    expect(thread?.title).toBe('見積もりの件')
    expect(thread?.triggerOrigin).toEqual({ pluginId: 'aios.fake', triggerId: 'new-mail', url: 'https://mail.example.com/t/1' })
    expect(thread?.osSandbox).toBe(true)
    expect(thread?.modelId).toBe('model-b')
    expect(thread?.approvalStrict).toBe(false)
    expect('scheduledJobId' in (thread ?? {})).toBe(false)
    expect(adapter.spawn.mock.calls[0]?.[0].readOnly).toBe(true)
    expect(adapter.sessions.at(-1)?.sent[0]?.text).toBe('[aios trigger] read-only')
    expect(manager.isUnattendedTurn(threadId)).toBe(true)
  })

  it('無人のターンの関門: 書き込み・シェル・外への道・副作用は聞かずに断り、読み取りは通す', async () => {
    withReadOnlyTools()
    const threadId = await manager.runTriggered(request)
    const session = adapter.sessions.at(-1)!
    for (const tool of ['Bash', 'Write', 'WebFetch', 'mcp__aios__openUrl', 'mcp__aios__startBundles', 'mcp__other__send']) {
      const answer = await approve(session.sessionId, tool, { command: 'rm -rf /', url: 'https://x.example' })
      expect(answer.allowed, tool).toBe(false)
      expect(answer.message).toContain('read-only')
    }
    // Nothing is queued in the approval inbox (nobody answers, so nothing is asked).
    expect(manager.listApprovals()).toHaveLength(0)
    expect((await approve(session.sessionId, 'Read', { file_path: '/Users/tester/work/a.txt' })).allowed).toBe(true)
    expect((await approve(session.sessionId, 'mcp__aios__search', { query: 'x' })).allowed).toBe(true)
    await settle()
    const decided = (await manager.timeline(threadId)).events.filter(
      (event) => event.kind === 'permission_request' && event.payload.outcome.kind === 'denied'
    )
    expect(decided.length).toBeGreaterThan(0)
    expect(decided.every((event) => event.kind === 'permission_request' && event.payload.outcome.kind === 'denied' && event.payload.outcome.message === 'approval-denied-unattended')).toBe(true)
    // Tools that move the gateway's screen are also refused (even if approve is skipped).
    const opened = (await manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'openUrl',
      payload: { url: 'https://evil.example/?d=secret' }
    })) as { error?: string }
    expect(opened.error).toContain('read-only')
  })

  it('直し X: 道具の段も許可の列挙 — 列挙の外の種類 (新しい道具・知らない種類) は入口で断り、読み取りの種類は通す', async () => {
    const threadId = await manager.runTriggered(request)
    const session = adapter.sessions.at(-1)!
    const call = async (kind: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
      (await manager.handleGatewayRequest({ sessionId: session.sessionId, kind, payload })) as Record<string, unknown>
    for (const kind of ['openFile', 'closeFile', 'openDiff', 'getOpenUrlText', 'getViewerScreenshot', 'setSetting', 'someFutureTool']) {
      expect(String((await call(kind)).error), kind).toContain('read-only')
    }
    expect(await call('openSettings', { name: 'x' })).toMatchObject({ opened: false })
    expect(await call('startBundles', { bundles: [] })).toMatchObject({ status: 'error' })
    // The read kind goes through the entry point (regardless of the result of the earlier processing; it must not be a read-only refusal).
    const listed = await call('listOpenFiles')
    expect(String(listed['error'] ?? '')).not.toContain('read-only')
    // Fix V: even after the first turn ends, it stays read-only until a person speaks (in preparation for automatic sends).
    finishTurn(threadId)
    await settle()
    expect(manager.isUnattendedTurn(threadId)).toBe(false)
    expect(String((await call('someFutureTool')).error)).toContain('read-only')
    // If a person speaks (in the next session woken because the flag differs), the same kind proceeds to the normal processing.
    await manager.send(threadId, { text: '続けて' }, 'human')
    const next = adapter.sessions.at(-1)!
    expect(next).not.toBe(session)
    const after = (await manager
      .handleGatewayRequest({ sessionId: next.sessionId, kind: 'someFutureTool', payload: {} })
      .catch((err: unknown) => ({ error: String(err) }))) as Record<string, unknown>
    expect(String(after['error'] ?? '')).not.toContain('read-only')
  })

  it('最初のターンが終わったら読み取り専用を外し、人の続きは旗なしで起こし直す。通知は trigger の名前と応答の先頭', async () => {
    withReadOnlyTools()
    focusedViews = new Set()
    const threadId = await manager.runTriggered(request)
    const first = adapter.sessions.at(-1)!
    first.emit({ threadId, kind: 'assistant_text', payload: { text: '要点: 見積もりの返事が要る', messageId: 'm1' } } as never)
    finishTurn(threadId)
    await settle()
    expect(manager.isUnattendedTurn(threadId)).toBe(false)
    expect(triggerSettled).toEqual([threadId])
    const done = notifyCalls.find((call) => call.kind === 'triggerDone')
    expect(done?.threadTitle).toBe('新着メール|見積もりの件')
    expect(done?.excerpt).toContain('要点')
    // A person's continuation: woken again because the flag differs (no read-only).
    await manager.send(threadId, { text: '返信案を短くして' }, 'human')
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(adapter.spawn.mock.calls[1]?.[0].readOnly).toBeUndefined()
    const second = adapter.sessions.at(-1)!
    expect(second).not.toBe(first)
    // Returns to the usual default (equivalent to Bypass): writes pass automatically.
    expect((await approve(second.sessionId, 'Write', { file_path: '/Users/tester/work/a.txt', content: 'x' })).allowed).toBe(true)
  })

  /** As with a real authentication expiry or abnormal exit, the process dies without emitting a result (it is not an exit that aios asked for). */
  function crash(session: FakeSession): void {
    session.alive = false
    session.handlers.onExit({ code: 1, signal: null, sawResult: false, requested: false })
  }

  it('直し V: 途中で落ちた後の自動の再送 (LoginRecovery の resendLast) は読み取り専用のまま起こす', async () => {
    withReadOnlyTools()
    const threadId = await manager.runTriggered(request)
    const first = adapter.sessions.at(-1)!
    crash(first)
    await settle()
    expect(manager.isUnattendedTurn(threadId)).toBe(false)
    await manager.resendLast(threadId)
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(adapter.spawn.mock.calls[1]?.[0].readOnly).toBe(true)
    const second = adapter.sessions.at(-1)!
    expect(second.sent[0]?.text).toBe('[aios trigger] read-only')
    // Refused without asking, even by the gate (not queued in the approval inbox).
    expect((await approve(second.sessionId, 'Write', { file_path: '/Users/tester/work/a.txt', content: 'x' })).allowed).toBe(false)
    expect(manager.listApprovals()).toHaveLength(0)
    expect(summaries.find((s) => s.thread.id === threadId)?.thread.triggerOrigin?.attended).toBeUndefined()
  })

  it('直し V: 人の操作でない送信 (中断からの再開・束の報告 = origin 省略) も読み取り専用のまま。走っている読み取り専用のプロセスは起こし直さない', async () => {
    withReadOnlyTools()
    const threadId = await manager.runTriggered(request)
    finishTurn(threadId)
    await settle()
    await manager.send(threadId, { text: '続けてください' })
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    const session = adapter.sessions.at(-1)!
    expect((await approve(session.sessionId, 'Bash', { command: 'curl https://x.example' })).allowed).toBe(false)
    // An automatic send after a crash also wakes the process as read-only.
    finishTurn(threadId)
    crash(session)
    await settle()
    await manager.send(threadId, { text: '続けてください' }, 'auto')
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(adapter.spawn.mock.calls[1]?.[0].readOnly).toBe(true)
  })

  it('直し V: 無人のターン中に人が予約した発言は、そのターンの後に普段の既定で送る。以後の自動の再送も普段の既定', async () => {
    withReadOnlyTools()
    const threadId = await manager.runTriggered(request)
    const first = adapter.sessions.at(-1)!
    const outcome = await manager.send(threadId, { text: '返信案も' }, 'human')
    expect(outcome.kind).toBe('queued')
    // An unattended turn that is running stays read-only (the mark is set, but it is refused by the turn's mark).
    expect((await approve(first.sessionId, 'Write', { file_path: '/Users/tester/work/a.txt', content: 'x' })).allowed).toBe(false)
    expect(summaries.find((s) => s.thread.id === threadId)?.thread.triggerOrigin?.attended).toBe(true)
    finishTurn(threadId)
    await settle()
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(adapter.spawn.mock.calls[1]?.[0].readOnly).toBeUndefined()
    const second = adapter.sessions.at(-1)!
    expect(second.sent[0]?.text).toBe('返信案も')
    crash(second)
    await settle()
    await manager.resendLast(threadId)
    expect(adapter.spawn.mock.calls[2]?.[0].readOnly).toBeUndefined()
  })

  describe('TODO 1227: 無人のターンの拡張機能の道具 — 同梱だけ通し、外のものは規則が許したときだけ', () => {
    const invoked: string[] = []
    /** Rule allowances (fix X: the pair of the name and the fingerprint of the tool's declaration at the time it was allowed). */
    let allowance: Map<string, readonly (readonly [string, string])[]>
    /** The tools of the loaded extensions (replaced in the middle of the test, imitating an update or a swap). */
    let loadedTools: EnabledPluginTool[]
    const tool = (name: string, sideEffect = false, description = 'x'): PluginToolDeclaration => ({
      name,
      description,
      inputSchema: { type: 'object' },
      ...(sideEffect ? { sideEffect: true } : {})
    })
    /** `identity` is an identity that an extension cannot fake (`PluginHost.identityOf`; for outside extensions, a hash of the contents). */
    const loaded = (
      pluginId: string,
      declaration: PluginToolDeclaration,
      bundled: boolean,
      pluginName = pluginId,
      identity = bundled ? 'bundled' : `sha256:${pluginId}`
    ): EnabledPluginTool => ({
      pluginId,
      pluginName,
      tool: declaration,
      bundled,
      fingerprint: pluginToolFingerprint({ id: pluginId, name: pluginName }, declaration, identity)
    })
    const grant = (pluginId: string, declaration: PluginToolDeclaration): readonly [string, string] => [
      declaration.name,
      pluginToolFingerprint({ id: pluginId, name: pluginId }, declaration, `sha256:${pluginId}`)
    ]

    /** Fake extension tools (one bundled, two outside). Whether a tool is bundled is the value from the loading source (`bundled`), not the manifest's self-declaration. */
    function withPluginTools(): void {
      invoked.length = 0
      allowance = new Map([
        ['aios.fake\u0000new-mail', [grant('aios.fake', tool('readThing'))]],
        // Even if another extension's rule allows its own tool, it does not apply to a conversation caused by an event of aios.fake.
        ['aios.evil\u0000x', [grant('aios.evil', tool('evilRead'))]]
      ])
      loadedTools = [
        loaded('aios.bundled', tool('bundledRead'), true),
        loaded('aios.bundled', tool('bundledPost', true), true),
        loaded('aios.fake', tool('readThing'), false),
        loaded('aios.fake', tool('otherRead'), false),
        loaded('aios.fake', tool('postThing', true), false),
        loaded('aios.evil', tool('evilRead'), false)
      ]
      const pluginTools = new PluginToolRelay({
        source: {
          enabledTools: () => loadedTools,
          invoke: async (pluginId, name) => {
            invoked.push(`${pluginId}/${name}`)
            return 'ok'
          }
        },
        audit: { record: () => undefined }
      })
      manager = new SessionManager({
        ...(manager as unknown as { deps: SessionManagerDeps }).deps,
        pluginTools,
        triggerToolAllowance: (pluginId, triggerId, toolName, fingerprint) =>
          allowance.get(`${pluginId}\u0000${triggerId}`)?.some(([name, fp]) => name === toolName && fp === fingerprint) === true
      })
    }

    const exposed = (pluginId: string, name: string): string => `${pluginId.replace(/\./g, '_')}__${name}`

    /** Whether it passed at both the approval stage and the tool stage. */
    async function passes(sessionId: string, pluginId: string, name: string): Promise<{ approve: boolean; run: boolean }> {
      const toolName = `${GATEWAY_TOOL_PREFIX}${exposed(pluginId, name)}`
      const approved = (await manager.handleGatewayRequest({
        sessionId,
        kind: 'approve',
        payload: { toolName, toolUseId: `tu-${name}`, input: {} }
      })) as { allowed: boolean }
      const before = invoked.length
      const result = (await manager.handleGatewayRequest({
        sessionId,
        kind: 'pluginTool',
        payload: { name: exposed(pluginId, name), arguments: {} }
      })) as { error?: string }
      const ran = invoked.length > before
      if (!ran) expect(String(result.error)).toContain('read-only')
      return { approve: approved.allowed, run: ran }
    }

    async function expectGate(sessionId: string): Promise<void> {
      expect(await passes(sessionId, 'aios.bundled', 'bundledRead')).toEqual({ approve: true, run: true })
      expect(await passes(sessionId, 'aios.fake', 'readThing')).toEqual({ approve: true, run: true })
      for (const [pluginId, name] of [
        ['aios.bundled', 'bundledPost'],
        ['aios.fake', 'otherRead'],
        ['aios.fake', 'postThing'],
        ['aios.evil', 'evilRead']
      ] as const) {
        expect(await passes(sessionId, pluginId, name), `${pluginId}/${name}`).toEqual({ approve: false, run: false })
      }
      expect(manager.listApprovals()).toHaveLength(0)
    }

    it('同梱の読み取りの道具は通る。外の道具は規則が許した自分の道具だけ。副作用・他の拡張機能の道具は断る (両方の段)', async () => {
      withPluginTools()
      const threadId = await manager.runTriggered(request)
      await expectGate(adapter.sessions.at(-1)!.sessionId)
      // Rules are looked up on each call: if the user removes the permission, it takes effect at once.
      allowance.set('aios.fake\u0000new-mail', [])
      expect(await passes(adapter.sessions.at(-1)!.sessionId, 'aios.fake', 'readThing')).toEqual({ approve: false, run: false })
      // The refusal remains on the timeline (the reason code is the refusal of an unattended turn).
      await settle()
      const denied = (await manager.timeline(threadId)).events.filter(
        (event) => event.kind === 'permission_request' && event.payload.outcome.kind === 'denied'
      )
      expect(denied.length).toBeGreaterThan(0)
    })

    it('直し X: 許可は使う時点で今の宣言と突き合わせる — 更新で副作用が付いた・宣言が変わった・道具が消えた・同じ id の別の拡張機能に入れ替わったら通らない', async () => {
      withPluginTools()
      await manager.runTriggered(request)
      const sessionId = adapter.sessions.at(-1)!.sessionId
      expect(await passes(sessionId, 'aios.fake', 'readThing')).toEqual({ approve: true, run: true })
      const others = loadedTools.filter((entry) => !(entry.pluginId === 'aios.fake' && entry.tool.name === 'readThing'))
      for (const [label, replacement] of [
        ['更新で sideEffect が付いた', [loaded('aios.fake', tool('readThing', true), false)]],
        ['更新で宣言 (説明) が変わった', [loaded('aios.fake', tool('readThing', false, 'now sends mail'), false)]],
        ['同じ id の別の拡張機能に入れ替わった (名前の違うもの)', [loaded('aios.fake', tool('readThing'), false, 'Someone else')]],
        // Security review: even if the id, the name and the tool declaration are all claimed as the same, it does not pass if the contents (identity) differ.
        ['同じ id・同じ名前・同じ宣言を名乗る別物 (中身が違う)', [loaded('aios.fake', tool('readThing'), false, 'aios.fake', 'sha256:other-content')]],
        ['指紋の無い道具 (読み込み元が指紋を付けなかった)', [{ pluginId: 'aios.fake', pluginName: 'aios.fake', tool: tool('readThing'), bundled: false }]]
      ] as const) {
        loadedTools = [...others, ...replacement]
        expect(await passes(sessionId, 'aios.fake', 'readThing'), label).toEqual({ approve: false, run: false })
      }
      // The tool is gone: it does not pass at either stage (the tool stage refuses it as unavailable).
      loadedTools = others
      const approved = (await manager.handleGatewayRequest({
        sessionId,
        kind: 'approve',
        payload: { toolName: `${GATEWAY_TOOL_PREFIX}${exposed('aios.fake', 'readThing')}`, toolUseId: 'tu-gone', input: {} }
      })) as { allowed: boolean }
      expect(approved.allowed).toBe(false)
      const before = invoked.length
      await manager.handleGatewayRequest({
        sessionId,
        kind: 'pluginTool',
        payload: { name: exposed('aios.fake', 'readThing'), arguments: {} }
      })
      expect(invoked.length).toBe(before)
      // Going back to the original declaration, the saved allowance takes effect as it is (same declaration = same fingerprint).
      loadedTools = [...others, loaded('aios.fake', tool('readThing'), false)]
      expect(await passes(sessionId, 'aios.fake', 'readThing')).toEqual({ approve: true, run: true })
      expect(manager.listApprovals()).toHaveLength(0)
    })

    it('最初のターンの後の自動の再送 (印が外れる経路) でも許可は広がらない。人が続ければ普段の既定', async () => {
      withPluginTools()
      const threadId = await manager.runTriggered(request)
      const first = adapter.sessions.at(-1)!
      crash(first)
      await settle()
      await manager.resendLast(threadId)
      const second = adapter.sessions.at(-1)!
      expect(second).not.toBe(first)
      await expectGate(second.sessionId)
      // Sends whose origin is omitted, such as reservations and resumes, are the same (still read-only).
      finishTurn(threadId)
      await settle()
      await manager.send(threadId, { text: '続けて' })
      await expectGate(adapter.sessions.at(-1)!.sessionId)
      // After a person speaks themselves, it is an ordinary conversation (the unattended gate does not apply).
      finishTurn(threadId)
      await settle()
      await manager.send(threadId, { text: '続けて' }, 'human')
      expect((await passes(adapter.sessions.at(-1)!.sessionId, 'aios.fake', 'otherRead')).run).toBe(true)
    })
  })

  it('起こせなかったら空の会話を消して投げる (印も残さない)', async () => {
    adapter.loggedIn = false
    adapter.nextSpawn = async () => {
      throw new Error('spawn failed')
    }
    await expect(manager.runTriggered(request)).rejects.toThrow()
    await settle()
    expect(summaries.some((s) => s.thread.triggerOrigin !== undefined)).toBe(false)
  })
})
