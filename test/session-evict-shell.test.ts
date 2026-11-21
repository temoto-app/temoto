/**
 * Eviction of a shell running in the background (`run_in_background`) (item 105, ARCHITECTURE.md 4.6.3).
 *
 * Owner decision (2026-09-27): unlike subagents, if eviction were stopped for as long as it is running, a long-lived job such as a watcher would never stop. A shell that has passed the upper time limit counted from its start (default 30 minutes; the `session.backgroundShellEvictTimeoutMs` of `app_settings`, which has no UI) is not counted
 * (it may be evicted). Neither the CLI nor the model is woken (`FakeSession.emit` pushes `subtask_started` / `subtask_finished` by hand). The harness is separate from `test/session-manager.test.ts`
 * (so as not to touch the same file as a bundle running in parallel).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import type { ThreadSummary } from '../src/shared/thread.js'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { BACKGROUND_SHELL_EVICT_TIMEOUT_MS } from '../src/common/settings-keys.js'
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
  emit(event: Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'> & { ts?: number }): void {
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
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const session = new FakeSession(options.sessionId, handlers)
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
let adapter: FakeAdapter
let manager: SessionManager
let summaries: ThreadSummary[] = []

function runtimeOf(threadId: string): ThreadSummary['runtime'] {
  const found = summaries.find((s) => s.thread.id === threadId)
  if (found === undefined) throw new Error('thread not in summaries')
  return found.runtime
}

/** A `run_in_background` shell with a `taskId` (task_type: local_bash, no subagent_type). */
const shellStarted = (taskId: string): Parameters<FakeSession['emit']>[0] => ({
  threadId: '',
  kind: 'subtask_started',
  payload: {
    taskId,
    toolUseId: `tu-${taskId}`,
    description: `シェル ${taskId}`,
    subagentType: null,
    isSubagent: false,
    isBackgroundShell: true
  }
})

const shellFinished = (taskId: string): Parameters<FakeSession['emit']>[0] => ({
  threadId: '',
  kind: 'subtask_finished',
  payload: {
    taskId,
    toolUseId: `tu-${taskId}`,
    status: 'completed',
    summary: null,
    usage: { totalTokens: 1, toolUses: 1, durationMs: 1 },
    outputFile: null
  }
})

/**
 * A clock that `Date.now()` can be advanced by hand (`vi.spyOn` is replaced for the whole time). To make the elapsed times of several shells that start at different times correct, not only the `sweepIdle` calls but also the `event.ts` of `session.emit` (= `Date.now()` at call time) must advance on the same clock. Otherwise
 * the start times of "the shell started first" and "the shell started later" come out almost the same (except for the few ms the test run takes), and the times just before and after the upper limit cannot be made separately.
 */
function useClock(): { advance: (ms: number) => void; restore: () => void } {
  let current = Date.now()
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => current)
  return {
    advance: (ms: number) => {
      current += ms
    },
    restore: () => spy.mockRestore()
  }
}

function sweepIdle(): void {
  ;(manager as unknown as { sweepIdle(): void }).sweepIdle()
}

function build(): void {
  adapter = new FakeAdapter()
  summaries = []
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
    socketPath: '/tmp/aios-test-evict-shell.sock',
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
    gatewayConfigDir: '/tmp/aios-test-evict-shell-mcp',
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
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
})

afterEach(async () => {
  await manager.stop()
  db.close()
})

/** A thread that has been sent once (no `result` has arrived yet). */
async function sentThread(): Promise<{ threadId: string; session: FakeSession }> {
  const thread = await manager.createThread({})
  await manager.send(thread.id, { text: 'バックグラウンドで走らせて' })
  const session = adapter.sessions.at(-1)
  if (session === undefined) throw new Error('no session')
  return { threadId: thread.id, session }
}

describe('SessionManager — 裏で動くシェルの追い出し (項目 105)', () => {
  it('シェルが動いている間 (上限時間内) はアイドルの時間切れで追い出されない', async () => {
    build()
    manager.setSettings({ idleTimeoutMs: 60_000 })
    const clock = useClock()
    try {
      const { threadId, session } = await sentThread()
      session.emit({ ...shellStarted('sh-a'), threadId })
      session.emit({ threadId, kind: 'result', payload: RESULT })
      expect(runtimeOf(threadId).state).toBe('idle')

      clock.advance(10 * 60_000) // 10 minutes later (before the default upper limit of 30 minutes)
      sweepIdle()
      expect(session.alive).toBe(true)
    } finally {
      clock.restore()
    }
  })

  it('シェルが終われば、開始からの時間に関わらず普段どおり追い出せる', async () => {
    build()
    manager.setSettings({ idleTimeoutMs: 60_000 })
    const clock = useClock()
    try {
      const { threadId, session } = await sentThread()
      session.emit({ ...shellStarted('sh-a'), threadId })
      session.emit({ threadId, kind: 'result', payload: RESULT })
      clock.advance(10 * 60_000)
      sweepIdle()
      expect(session.alive).toBe(true)

      session.emit({ ...shellFinished('sh-a'), threadId })
      clock.advance(20 * 60_000)
      sweepIdle()
      expect(session.alive).toBe(false)
    } finally {
      clock.restore()
    }
  })

  it('開始から上限時間 (既定 30 分) を過ぎたシェルは数えない — 監視のような長寿命の作業でも追い出せる', async () => {
    build()
    manager.setSettings({ idleTimeoutMs: 60_000 })
    const clock = useClock()
    try {
      const { threadId, session } = await sentThread()
      session.emit({ ...shellStarted('sh-long'), threadId })
      session.emit({ threadId, kind: 'result', payload: RESULT })

      // The end notification never arrives (a long-lived job such as a `dev server`).
      clock.advance(20 * 60_000) // 20 minutes later: still within the upper limit (default 30 minutes), so it is not evicted
      sweepIdle()
      expect(session.alive).toBe(true)

      clock.advance(11 * 60_000) // 31 minutes after the start: past the upper limit, so it is not counted and is evicted on timeout
      sweepIdle()
      expect(session.alive).toBe(false)
    } finally {
      clock.restore()
    }
  })

  it('上限時間は app_settings (session.backgroundShellEvictTimeoutMs) で上書きできる。UI は無い', async () => {
    const settings = new AppSettingsStore(db)
    settings.writeTyped(BACKGROUND_SHELL_EVICT_TIMEOUT_MS, 5 * 60_000)
    build()
    manager.setSettings({ idleTimeoutMs: 60_000 })
    const clock = useClock()
    try {
      const { threadId, session } = await sentThread()
      session.emit({ ...shellStarted('sh-short'), threadId })
      session.emit({ threadId, kind: 'result', payload: RESULT })

      clock.advance(4 * 60_000) // 4 minutes later: still within the overwritten upper limit (5 minutes)
      sweepIdle()
      expect(session.alive).toBe(true)

      clock.advance(2 * 60_000) // 6 minutes after the start: past the overwritten upper limit
      sweepIdle()
      expect(session.alive).toBe(false)
    } finally {
      clock.restore()
    }
  })

  it('複数のシェルのうち 1 本でも上限内なら追い出さない (子エージェントと違い、上限切れの分は数えない)', async () => {
    build()
    manager.setSettings({ idleTimeoutMs: 60_000 })
    const clock = useClock()
    try {
      const { threadId, session } = await sentThread()
      session.emit({ ...shellStarted('sh-old'), threadId })
      clock.advance(35 * 60_000) // sh-old has already passed its upper limit here (default 30 minutes)
      session.emit({ ...shellStarted('sh-new'), threadId }) // From here it counts anew
      session.emit({ threadId, kind: 'result', payload: RESULT })

      clock.advance(5 * 60_000) // sh-new is still within the upper limit; sh-old is not counted
      sweepIdle()
      expect(session.alive).toBe(true)

      clock.advance(26 * 60_000) // sh-new is also past the upper limit (31 minutes after the start)
      sweepIdle()
      expect(session.alive).toBe(false)
    } finally {
      clock.restore()
    }
  })
})

describe('SessionManager — 裏のシェルの間は一覧のスピナーを回す (TODO 1196)', () => {
  const progressBackgrounded = (taskId: string): Parameters<FakeSession['emit']>[0] => ({
    threadId: '',
    kind: 'subtask_backgrounded',
    payload: { taskId }
  })

  /** Peeks into the contents of the timer at the boundary (the wave 81 review Y). */
  const expiryOf = (): { at: number | null; armed: boolean } => {
    const lifecycle = (manager as unknown as {
      lifecycle: { shellExpiryAt: number | null; shellExpiryTimer: unknown }
    }).lifecycle
    return { at: lifecycle.shellExpiryAt, armed: lifecycle.shellExpiryTimer !== null }
  }

  it('親のターンが終わっても裏のシェルの数を配り、終われば欄ごと消える', async () => {
    build()
    const { threadId, session } = await sentThread()
    session.emit({ ...shellStarted('sh-a'), threadId })
    session.emit({ threadId, kind: 'result', payload: RESULT })
    expect(runtimeOf(threadId).state).toBe('idle')
    expect(runtimeOf(threadId).backgroundShells).toBe(1)

    session.emit({ ...shellFinished('sh-a'), threadId })
    expect(runtimeOf(threadId).backgroundShells).toBeUndefined()
  })

  it('前面のシェルは数えず、裏へ回ったら数える (時間切れで裏へ回った長いコマンド)', async () => {
    build()
    const { threadId, session } = await sentThread()
    session.emit({
      threadId,
      kind: 'subtask_started',
      payload: {
        taskId: 'sh-fg',
        toolUseId: 'tu-sh-fg',
        description: 'slow script',
        subagentType: null,
        isSubagent: false,
        isBackgroundShell: true,
        backgrounded: false
      }
    })
    session.emit({ threadId, kind: 'result', payload: RESULT })
    expect(runtimeOf(threadId).backgroundShells).toBeUndefined()

    session.emit({ ...progressBackgrounded('sh-fg'), threadId })
    expect(runtimeOf(threadId).backgroundShells).toBe(1)
  })

  it('終わりの通知を取りこぼしても、裏の作業の全集合で止まる', async () => {
    build()
    const clock = useClock()
    try {
      const { threadId, session } = await sentThread()
      session.emit({ ...shellStarted('sh-a'), threadId })
      session.emit({ threadId, kind: 'result', payload: RESULT })
      expect(runtimeOf(threadId).backgroundShells).toBe(1)

      // review Y: a set that does not contain that shell, arriving right after registration, might be stale, so it is not deleted.
      session.emit({ threadId, kind: 'background_tasks', payload: { shellTaskIds: [] } })
      expect(runtimeOf(threadId).backgroundShells).toBe(1)

      clock.advance(10_000)
      session.emit({ threadId, kind: 'background_tasks', payload: { shellTaskIds: [] } })
      expect(runtimeOf(threadId).backgroundShells).toBeUndefined()
    } finally {
      clock.restore()
    }
  })

  it('review Y: 上限時間の境目に one-shot の timer を 1 本張り、終われば外し、stop で消す', async () => {
    build()
    const clock = useClock()
    try {
      const { threadId, session } = await sentThread()
      expect(expiryOf()).toEqual({ at: null, armed: false })
      const t0 = Date.now()
      session.emit({ ...shellStarted('sh-a'), threadId })
      expect(expiryOf()).toEqual({ at: t0 + 30 * 60_000, armed: true })
      // For a shell started later, the boundary does not move (it stays at the earliest one).
      clock.advance(60_000)
      session.emit({ ...shellStarted('sh-b'), threadId })
      expect(expiryOf()).toEqual({ at: t0 + 30 * 60_000, armed: true })
      // When the earlier one finishes, it is re-armed at the next boundary.
      session.emit({ ...shellFinished('sh-a'), threadId })
      expect(expiryOf()).toEqual({ at: t0 + 31 * 60_000, armed: true })
      // If all of them finish, nothing is armed.
      session.emit({ ...shellFinished('sh-b'), threadId })
      expect(expiryOf()).toEqual({ at: null, armed: false })

      session.emit({ ...shellStarted('sh-c'), threadId })
      expect(expiryOf().armed).toBe(true)
      await manager.stop()
      expect(expiryOf()).toEqual({ at: null, armed: false })
    } finally {
      clock.restore()
    }
  })

  it('review Y: 境目の timer が来たら、知らせが無くても配り直して止める', async () => {
    build()
    // To keep it apart from eviction, the idle timeout is made long.
    manager.setSettings({ idleTimeoutMs: 24 * 60 * 60_000 })
    const clock = useClock()
    try {
      const { threadId, session } = await sentThread()
      session.emit({ ...shellStarted('dev-server'), threadId })
      session.emit({ threadId, kind: 'result', payload: RESULT })
      expect(runtimeOf(threadId).backgroundShells).toBe(1)

      // Calls the timer's contents directly (does not wait the real 30 minutes; the clock was advanced by hand).
      const fire = (): void => (manager as unknown as { lifecycle: { onShellExpiry(): void } }).lifecycle.onShellExpiry()
      clock.advance(30 * 60_000 - 1)
      fire()
      expect(runtimeOf(threadId).backgroundShells).toBe(1)
      expect(expiryOf().armed).toBe(true)
      clock.advance(1)
      fire()
      expect(runtimeOf(threadId).backgroundShells).toBeUndefined()
      expect(expiryOf()).toEqual({ at: null, armed: false })
      expect(session.alive).toBe(true)
    } finally {
      clock.restore()
    }
  })

  it('上限時間を過ぎたら、知らせが無くても 1 分の見回りで配り直して止める', async () => {
    build()
    // To keep it apart from eviction, the idle timeout is made long.
    manager.setSettings({ idleTimeoutMs: 24 * 60 * 60_000 })
    const clock = useClock()
    try {
      const { threadId, session } = await sentThread()
      session.emit({ ...shellStarted('dev-server'), threadId })
      session.emit({ threadId, kind: 'result', payload: RESULT })
      expect(runtimeOf(threadId).backgroundShells).toBe(1)

      clock.advance(29 * 60_000)
      sweepIdle()
      expect(runtimeOf(threadId).backgroundShells).toBe(1)

      clock.advance(2 * 60_000) // 31 minutes from the start (past the default upper limit of 30 minutes)
      sweepIdle()
      expect(runtimeOf(threadId).backgroundShells).toBeUndefined()
      expect(session.alive).toBe(true)
    } finally {
      clock.restore()
    }
  })
})
