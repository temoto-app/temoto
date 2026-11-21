/**
 * The ■ stop in the prompt field (item 161, ARCHITECTURE.md 4.5.4). The main side of "stop can always be pressed".
 *
 * With a fake Adapter (a copy of the minimal harness in `session-plan.test.ts`), **no CLI and no model is started**. The DB is the real SQLite code (in memory).
 *
 * What is pinned down:
 * - Stopping while starting (before spawn completes = `starting`) does not return without doing anything. It sends the interrupt right after the write finishes, and after the interrupted `result` it leaves the reservation unsent. (The header stop button was shown in `running` / `starting`, but pressing it in `starting` did nothing.)
 * - A stop during startup does not fall back to SIGINT (the message being written is not dropped)
 * - Stopping while awaiting approval (`awaiting-approval`) withdraws the pending approval and sends the interrupt (same path as the test 'the stop button also withdraws the approval' in `session-manager.test.ts`, entered through the ■)
 * - Background subagent (TODO 1153 stage 1): after the interrupt, if the child is still running, stop the process itself after a grace period; the child is closed by 'stop'. A ■ after the parent turn has ended (idle) stops immediately. The next send restarts it by resuming
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload, ThinkingLevel } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import type { ThreadRuntime, ThreadSummary } from '../src/shared/thread.js'
import { runMigrations } from '../src/common/migrations.js'
import { SessionManager, type SessionManagerDeps } from '../src/main/session/manager.js'
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
  interrupts = 0
  aborts = 0
  stops = 0
  /** While set, holds `stop` (creates a retiring state, i.e. a stop in progress). */
  stopGate: Promise<void> | null = null
  constructor(
    readonly sessionId: string,
    readonly handlers: SpawnHandlers
  ) {}
  send(input: AgentInput): void {
    this.sent.push(input)
  }
  async interrupt(): Promise<void> {
    this.interrupts += 1
  }
  abort(): void {
    this.aborts += 1
  }
  async stop(): Promise<void> {
    this.stops += 1
    if (this.stopGate !== null) await this.stopGate
    if (!this.alive) return
    this.alive = false
    this.handlers.onExit({ code: 0, signal: null, sawResult: true, requested: true })
  }
  async switchSettings(target: { modelId: string | null; thinking: ThinkingLevel | null }): Promise<boolean> {
    return target.modelId === null && target.thinking === null
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
  /** While set, holds `spawn` (creates the `starting` state). */
  gate: Promise<void> | null = null
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> => {
    if (this.gate !== null) await this.gate
    await new Promise((resolve) => setTimeout(resolve, 5))
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
}

let db: Db
let adapter: FakeAdapter
let manager: SessionManager
let summaries: readonly ThreadSummary[] = []
let recorded: AiosEvent[] = []
let dir: string
/** TODO 1153: time to wait after ■ for a background child to end (3 seconds in production). */
const GRACE_MS = 40

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
    socketPath: '/tmp/aios-test.sock',
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
    gatewayConfigDir: '/tmp/aios-test-mcp',
    events: {
      onEvents: (batch) => {
        recorded.push(...batch.events)
      },
      onThreadsChanged: (list) => {
        summaries = list
      },
      onThreadChanged: (summary) => {
        const at = summaries.findIndex((s) => s.thread.id === summary.thread.id)
        summaries = at === -1 ? [...summaries, summary] : summaries.map((s, i) => (i === at ? summary : s))
      },
      onApprovalsChanged: () => undefined,
      onAgentStatus: () => undefined
    }
  }
  return new SessionManager({ ...deps, subtaskStopGraceMs: GRACE_MS })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-stop-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  summaries = []
  recorded = []
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
  text: null
}
const INTERRUPTED: ResultPayload = { ...RESULT, ok: false, subtype: 'interrupted', interrupted: true }

function runtimeOf(threadId: string): ThreadRuntime {
  const summary = summaries.find((s) => s.thread.id === threadId)
  if (summary === undefined) throw new Error('no summary')
  return summary.runtime
}

const texts = (session: FakeSession): string[] => session.sent.map((input) => input.text)
const reserved = (threadId: string): string[] =>
  (runtimeOf(threadId).reservations ?? []).map((item) => item.preview)

describe('プロンプト欄の ■ 停止 (項目 161)', () => {
  it('起動中 (starting) の停止は、書き終えた直後に中断を送る (何もせずに戻らない。SIGINT にも倒さない)', async () => {
    let open: () => void = () => undefined
    adapter.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const thread = await manager.createThread({})
    const sending = manager.send(thread.id, { text: '一つ目' })
    await vi.waitFor(() => expect(runtimeOf(thread.id).state).toBe('starting'))

    await manager.interrupt(thread.id)
    // There is no subject to interrupt yet. The stop is still shown (`stopping`).
    expect(runtimeOf(thread.id).state).toBe('stopping')

    open()
    await sending
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    // The message is written (so it matches the record), and the interrupt is sent right after.
    expect(texts(session)).toEqual(['一つ目'])
    await vi.waitFor(() => expect(session.interrupts).toBe(1))
    expect(session.aborts).toBe(0)
    expect(runtimeOf(thread.id).state).toBe('stopping')

    session.emit({ threadId: thread.id, kind: 'result', payload: INTERRUPTED })
    await vi.waitFor(() => expect(runtimeOf(thread.id).state).toBe('idle'))
    expect(session.alive).toBe(true)
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('起動中に積んだ予約は、停止の後も送らずに残す (項目 96 の停止と同じ)', async () => {
    let open: () => void = () => undefined
    adapter.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const thread = await manager.createThread({})
    const sending = manager.send(thread.id, { text: '一つ目' })
    await vi.waitFor(() => expect(runtimeOf(thread.id).state).toBe('starting'))
    expect((await manager.send(thread.id, { text: '予約' })).kind).toBe('queued')
    await manager.interrupt(thread.id)
    open()
    await sending
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    await vi.waitFor(() => expect(session.interrupts).toBe(1))
    session.emit({ threadId: thread.id, kind: 'result', payload: INTERRUPTED })
    await vi.waitFor(() => expect(runtimeOf(thread.id).state).toBe('idle'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(texts(session)).toEqual(['一つ目'])
    expect(reserved(thread.id)).toEqual(['予約'])
  })

  it('承認待ち (awaiting-approval) の停止は、保留中の承認を取り消して中断を送る', async () => {
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
    await manager.interrupt(thread.id)
    await expect(approval).resolves.toMatchObject({ allowed: false })
    expect(manager.listApprovals()).toHaveLength(0)
    expect(session.interrupts).toBe(1)
    expect(session.aborts).toBe(0)
    session.emit({ threadId: thread.id, kind: 'result', payload: INTERRUPTED })
    await vi.waitFor(() => expect(runtimeOf(thread.id).state).toBe('idle'))
  })
})

describe('■ で裏の子エージェントまで止める (TODO 1153 段 1)', () => {
  const started = (threadId: string, taskId: string): Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'> =>
    ({
      threadId,
      kind: 'subtask_started',
      payload: {
        taskId,
        toolUseId: `tu-${taskId}`,
        description: `子 ${taskId}`,
        subagentType: 'general-purpose',
        isSubagent: true,
        isBackgroundShell: false
      }
    }) as Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'>
  const progress = (threadId: string, taskId: string, totalTokens: number): Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'> =>
    ({
      threadId,
      kind: 'subtask_progress',
      payload: {
        taskId,
        toolUseId: `tu-${taskId}`,
        description: null,
        activity: null,
        subagentType: null,
        status: null,
        usage: { totalTokens, toolUses: 1, durationMs: 5 },
        lastToolName: null,
        summary: null
      }
    }) as Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'>
  const finished = (threadId: string, taskId: string): Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'> =>
    ({
      threadId,
      kind: 'subtask_finished',
      payload: { taskId, toolUseId: `tu-${taskId}`, status: 'completed', summary: null, usage: null, outputFile: null }
    }) as Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'>
  const stoppedRows = (): { taskId: string; status: string; tokens: number | null }[] =>
    recorded.flatMap((event) =>
      event.kind === 'subtask_finished' && event.payload.status === 'stopped'
        ? [{ taskId: event.payload.taskId, status: event.payload.status, tokens: event.payload.usage?.totalTokens ?? null }]
        : []
    )

  /** A thread that ran one send with two background children started (the parent turn has not ended yet). */
  async function withSubtasks(): Promise<{ threadId: string; session: FakeSession }> {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '子を 2 本走らせて' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    session.emit(started(thread.id, 'a'))
    session.emit(started(thread.id, 'b'))
    session.emit(progress(thread.id, 'a', 1200))
    await vi.waitFor(() => expect(runtimeOf(thread.id).subtasks).toHaveLength(2))
    return { threadId: thread.id, session }
  }

  it('応答中の ■: 中断の後も子が残っていれば、猶予の後にプロセスごと止め、子は「停止」で閉じる', async () => {
    const { threadId, session } = await withSubtasks()
    await manager.interrupt(threadId)
    expect(session.interrupts).toBe(1)
    expect(session.aborts).toBe(0)
    // An interrupt stops only the parent turn: even when the interrupted `result` brings it to idle, the children keep running.
    session.emit({ threadId, kind: 'result', payload: INTERRUPTED })
    await vi.waitFor(() => expect(runtimeOf(threadId).state).toBe('idle'))
    expect(session.alive).toBe(true)
    expect(runtimeOf(threadId).subtasks).toHaveLength(2)
    // After the grace period, stop the process itself (stop = SIGTERM, then SIGKILL; not SIGINT).
    await vi.waitFor(() => expect(session.alive).toBe(false))
    expect(session.aborts).toBe(0)
    await vi.waitFor(() => expect(runtimeOf(threadId).subtasks).toHaveLength(0))
    // A child is closed by 'stop'. Keep the tokens at the moment of stopping (the last progress).
    await vi.waitFor(() =>
      expect(stoppedRows()).toEqual([
        { taskId: 'a', status: 'stopped', tokens: 1200 },
        { taskId: 'b', status: 'stopped', tokens: null }
      ])
    )
    // The next send resumes the same conversation (does not write to the stopped process).
    await manager.send(threadId, { text: '続き' })
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(adapter.sessions.at(-1)?.sent.map((input) => input.text)).toEqual(['続き'])
  })

  it('親のターンが終わった後 (idle) の ■ は、待たずに子を「停止」で閉じてプロセスごと止める', async () => {
    const { threadId, session } = await withSubtasks()
    session.emit({ threadId, kind: 'result', payload: RESULT })
    await vi.waitFor(() => expect(runtimeOf(threadId).state).toBe('idle'))
    expect(runtimeOf(threadId).subtasks).toHaveLength(2)
    await manager.interrupt(threadId)
    // There is no parent turn to interrupt. Do not fall back to SIGINT (abort) either; stop with `stop`.
    expect(session.interrupts).toBe(0)
    expect(session.aborts).toBe(0)
    expect(session.alive).toBe(false)
    await vi.waitFor(() => expect(stoppedRows().map((row) => row.taskId)).toEqual(['a', 'b']))
    expect(runtimeOf(threadId).subtasks).toHaveLength(0)
  })

  it('既に retire 中 (止めている途中) の会話の idle の ■ は、停止と子の「停止」の行を重ねない (第 71 波 review X)', async () => {
    const { threadId, session } = await withSubtasks()
    session.emit({ threadId, kind: 'result', payload: RESULT })
    await vi.waitFor(() => expect(runtimeOf(threadId).state).toBe('idle'))
    let release: () => void = () => undefined
    session.stopGate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Another entry point (cleanup, switching, etc.) is in the middle of stopping the process. The child list still remains.
    const stopping = manager.stopThread(threadId)
    await vi.waitFor(() => expect(session.stops).toBe(1))
    expect(runtimeOf(threadId).subtasks).toHaveLength(2)
    const pressed = manager.interrupt(threadId)
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await Promise.all([stopping, pressed])
    // ■ shows neither a second stop nor the synthesized 'stopped' line (the earlier entry point is the one doing the stopping).
    expect(session.stops).toBe(1)
    expect(session.aborts).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stoppedRows()).toEqual([])
  })

  it('猶予の間に子が全部終われば、プロセスは止めない (中断で子も止まった版)', async () => {
    const { threadId, session } = await withSubtasks()
    await manager.interrupt(threadId)
    session.emit(finished(threadId, 'a'))
    session.emit(finished(threadId, 'b'))
    session.emit({ threadId, kind: 'result', payload: INTERRUPTED })
    await vi.waitFor(() => expect(runtimeOf(threadId).state).toBe('idle'))
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3))
    expect(session.alive).toBe(true)
    expect(stoppedRows()).toEqual([])
  })

  it('猶予の間に利用者が新しく送ったら、その応答ごと落とさないよう止めない', async () => {
    const { threadId, session } = await withSubtasks()
    await manager.interrupt(threadId)
    session.emit({ threadId, kind: 'result', payload: INTERRUPTED })
    await vi.waitFor(() => expect(runtimeOf(threadId).state).toBe('idle'))
    await manager.send(threadId, { text: '別の話' })
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3))
    expect(session.alive).toBe(true)
    expect(texts(session)).toEqual(['子を 2 本走らせて', '別の話'])
    expect(runtimeOf(threadId).subtasks).toHaveLength(2)
  })

  it('子が居なければ従来どおり (idle の ■ は SIGINT、プロセスは stop しない)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '一つ目' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await vi.waitFor(() => expect(runtimeOf(thread.id).state).toBe('idle'))
    await manager.interrupt(thread.id)
    expect(session.aborts).toBe(1)
    expect(session.alive).toBe(true)
  })
})
