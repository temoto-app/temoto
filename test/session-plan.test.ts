/**
 * SessionManager's Plan mode (item 112, ARCHITECTURE.md 4.2.3) and the diff of the approval frame (item 97, 7.6.4).
 *
 * With a fake Adapter (built the same way as `session-manager.test.ts`), **neither the CLI nor the model is started**. The DB is the real
 * SQLite code (in memory). Presenting a plan and reading the writes are left to the pure functions of the Adapter that reads the real compat table
 * (`planProposalOf` / `writePreviewOf`) as they are.
 *
 * What is pinned:
 * - The toggle is held by main, and aligned with the process only just before the next send (a control request if it is running, a startup flag if not)
 * - If it cannot be aligned by a control request, the process is dropped and woken again (passed again as a startup flag)
 * - Presenting a plan is queued even under the default of auto-allow-everything, and "proceed with this plan" returns the toggle to OFF.
 *   The process's record is also OFF, so the next send does not send an unnecessary control request (the CLI exits Plan by itself, spike 22)
 * - "Fix it" returns the message as it is to the gateway, and the toggle stays ON
 * - diff: before and after applied to the current contents of a path that passed the gate. If it cannot be applied, a fragment; if it hits the gate, not-allowed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload, ThinkingLevel } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import type { ThreadSummary } from '../src/shared/thread.js'
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
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import { planProposalOf, writePreviewOf } from '../src/main/session/adapter/write-preview.js'
import { formatApprovalReply } from '../src/main/approval/replies.js'
import { fallbackApprovalReply } from '../src/main/approval/reply.js'
import type { ApprovalReply } from '../src/main/approval/reply.js'

const table = loadCompatTable()

class FakeSession implements AgentSession {
  readonly sent: AgentInput[] = []
  alive = true
  /** The answer of `setPlanMode`. The default is true (the version that can switch while running). */
  planResult = true
  readonly planSwitches: boolean[] = []
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
  /** The version that does not hold a switch of model / thinking while running (it looks only at Plan). */
  async switchSettings(target: { modelId: string | null; thinking: ThinkingLevel | null }): Promise<boolean> {
    return target.modelId === null && target.thinking === null
  }
  async setPlanMode(on: boolean): Promise<boolean> {
    this.planSwitches.push(on)
    return this.planResult
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
  /** When set to false, imitates a backend that does not know Plan. */
  plan = true
  /** When set to true, the refusal sentence is built from the real compat table (items 182 / 183). The default is false (earlier tests stay as they are). */
  replies = false
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> => {
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
  supportsPlanMode(): boolean {
    return this.plan
  }
  planProposal(toolName: string, input: unknown): string | null {
    return planProposalOf(table, toolName, input)
  }
  writePreview(toolName: string, input: unknown): WritePreview | null {
    return writePreviewOf(table, toolName, input)
  }
  approvalReply(reply: ApprovalReply): string | null {
    const replies = table.approvalReplies
    return this.replies && replies !== undefined ? formatApprovalReply(replies, reply) : null
  }
}

let db: Db
let adapter: FakeAdapter
let manager: SessionManager
let summaries: readonly ThreadSummary[] = []
let dir: string

function build(extra: Partial<SessionManagerDeps> = {}): SessionManager {
  const fs = {
    homePath: dir,
    homeUri: `file://${dir}`,
    defaultReferenceDirs: () => [],
    isReferenceable: () => true,
    assertAllowed: (uri: string) => {
      if (uri.includes('excluded')) throw new Error('除外対象です')
      return decodeURIComponent(uri.replace('file://', ''))
    }
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
      onEvents: () => undefined,
      onThreadsChanged: (list) => {
        summaries = list
      },
      onThreadChanged: (summary) => {
        const at = summaries.findIndex((s) => s.thread.id === summary.thread.id)
        summaries = at === -1 ? [...summaries, summary] : summaries.map((s, i) => (i === at ? summary : s))
      },
      onApprovalsChanged: () => undefined,
      onAgentStatus: () => undefined
    },
    ...extra
  }
  return new SessionManager(deps)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-plan-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  summaries = []
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

function planOf(threadId: string): boolean {
  return summaries.find((s) => s.thread.id === threadId)?.runtime.planMode === true
}

/** Sends one turn and returns the `result`. Returns the session that was woken. */
async function turn(threadId: string, text: string): Promise<FakeSession> {
  await manager.send(threadId, { text })
  const session = adapter.sessions.at(-1)
  if (session === undefined) throw new Error('no session')
  session.emit({ threadId, kind: 'result', payload: RESULT })
  return session
}

const exitPlan = (sessionId: string, plan: string) =>
  manager.handleGatewayRequest({
    sessionId,
    kind: 'approve',
    payload: { toolName: table.planMode?.exitTool ?? '?', toolUseId: 't1', input: { plan, planFilePath: '/x.md' } }
  })

describe('Plan mode toggle (item 112)', () => {
  it('without a process it is passed as a startup flag', async () => {
    const thread = await manager.createThread({})
    manager.setPlanMode(thread.id, true)
    expect(planOf(thread.id)).toBe(true)
    await manager.send(thread.id, { text: '計画して' })
    expect(adapter.spawn.mock.calls[0]?.[0].planMode).toBe(true)
  })

  it('a running process is aligned by a control request just before the next send, without waking again', async () => {
    const thread = await manager.createThread({})
    const session = await turn(thread.id, '一つ目')
    expect(adapter.spawn.mock.calls[0]?.[0].planMode).toBeUndefined()
    manager.setPlanMode(thread.id, true)
    // The toggle alone sends nothing to the process (so as not to switch during a response).
    expect(session.planSwitches).toEqual([])
    await manager.send(thread.id, { text: '二つ目' })
    expect(session.planSwitches).toEqual([true])
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(session.sent.map((i) => i.text)).toEqual(['一つ目', '二つ目'])
  })

  it('if it cannot be aligned by a control request it stops and wakes again (passes it again as a startup flag)', async () => {
    const thread = await manager.createThread({})
    const session = await turn(thread.id, '一つ目')
    session.planResult = false
    manager.setPlanMode(thread.id, true)
    await manager.send(thread.id, { text: '二つ目' })
    expect(adapter.spawn).toHaveBeenCalledTimes(2)
    expect(adapter.spawn.mock.calls[1]?.[0].planMode).toBe(true)
    expect(session.alive).toBe(false)
  })

  it('does not turn ON for a backend that does not know Plan', async () => {
    adapter.plan = false
    const thread = await manager.createThread({})
    manager.setPlanMode(thread.id, true)
    expect(planOf(thread.id)).toBe(false)
    const backends = await manager.backends()
    expect(backends[0]?.planMode).toBeUndefined()
  })

  it('a plan is queued even with the default allow-all, and 「この計画で進める」 turns both the toggle and the process record back OFF', async () => {
    const thread = await manager.createThread({})
    manager.setPlanMode(thread.id, true)
    await manager.send(thread.id, { text: '計画して' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const approval = exitPlan(session.sessionId, '# Plan\n\n1. a')
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
    const item = manager.listApprovals()[0]
    expect(item?.plan).toBe('# Plan\n\n1. a')
    manager.decideApproval(item?.id ?? '', { kind: 'allow' })
    await expect(approval).resolves.toMatchObject({ allowed: true })
    expect(planOf(thread.id)).toBe(false)
    // The CLI exits Plan by itself (spike 22), so the next send does not send an OFF control request.
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await manager.send(thread.id, { text: '次' })
    expect(session.planSwitches).toEqual([])
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('「直して」 returns the message as is, and the toggle stays ON', async () => {
    const thread = await manager.createThread({})
    manager.setPlanMode(thread.id, true)
    await manager.send(thread.id, { text: '計画して' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const approval = exitPlan(session.sessionId, '# Plan')
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
    manager.decideApproval(manager.listApprovals()[0]?.id ?? '', {
      kind: 'deny',
      message: '先にバックアップを取る手順を足して'
    })
    await expect(approval).resolves.toMatchObject({ allowed: false, message: '先にバックアップを取る手順を足して' })
    expect(planOf(thread.id)).toBe(true)
  })

  describe('three choices for plan approval (item 256, wave 15 bundle F)', () => {
    const strictOf = (threadId: string): boolean =>
      summaries.find((s) => s.thread.id === threadId)?.thread.approvalStrict === true

    async function pendingPlan(): Promise<{ threadId: string; sessionId: string; approval: ReturnType<typeof exitPlan> }> {
      const thread = await manager.createThread({})
      manager.setPlanMode(thread.id, true)
      await manager.send(thread.id, { text: '計画して' })
      const session = adapter.sessions.at(-1)
      if (session === undefined) throw new Error('no session')
      const approval = exitPlan(session.sessionId, '# Plan\n\n1. a')
      await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
      return { threadId: thread.id, sessionId: session.sessionId, approval }
    }

    it('"Yes, auto-accept edits" = allow only proceeds as before and does not make strict mode', async () => {
      const { threadId, approval } = await pendingPlan()
      manager.decideApproval(manager.listApprovals()[0]?.id ?? '', { kind: 'allow' })
      await expect(approval).resolves.toMatchObject({ allowed: true })
      expect(strictOf(threadId)).toBe(false)
      expect(planOf(threadId)).toBe(false)
    })

    it('"Yes, manually approve edits" = allow-manual puts the thread in strict mode and then returns the permission, and Plan returns to OFF', async () => {
      const { threadId, sessionId, approval } = await pendingPlan()
      expect(strictOf(threadId)).toBe(false)
      manager.decideApproval(manager.listApprovals()[0]?.id ?? '', { kind: 'allow-manual' })
      // At the moment the permission returns, strict mode is already on (the next request that comes right after the return is judged strictly).
      expect(strictOf(threadId)).toBe(true)
      await expect(approval).resolves.toMatchObject({ allowed: true })
      expect(planOf(threadId)).toBe(false)
      // Actually in effect: even if the default is "let everything through", the next request is held (strict mode, T12).
      const next = manager.handleGatewayRequest({
        sessionId,
        kind: 'approve',
        payload: { toolName: 'Bash', toolUseId: 't2', input: { command: './run.sh' } }
      })
      await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
      expect(manager.listApprovals()[0]?.toolName).toBe('Bash')
      manager.decideApproval(manager.listApprovals()[0]?.id ?? '', { kind: 'allow' })
      await expect(next).resolves.toMatchObject({ allowed: true })
    })

    it("a thread's strict mode is the thread's setting, and other threads do not change", async () => {
      const other = await manager.createThread({})
      const { threadId } = await pendingPlan()
      manager.decideApproval(manager.listApprovals()[0]?.id ?? '', { kind: 'allow-manual' })
      expect(strictOf(threadId)).toBe(true)
      expect(strictOf(other.id)).toBe(false)
      // Going back is done from the thread's settings menu (the existing entry point).
      manager.setApprovalStrict(threadId, false)
      expect(strictOf(threadId)).toBe(false)
    })

    it('even if allow-manual comes for a non-plan request (the renderer lied), it does not make strict mode and passes as a one-time permission', async () => {
      // Takes "let everything through" off the default, so that ordinary requests are held.
      manager.setApprovalPolicy({ autoAllowAll: false, autoAllowTools: [] })
      const thread = await manager.createThread({})
      await manager.send(thread.id, { text: 'ls して' })
      const session = adapter.sessions.at(-1)
      if (session === undefined) throw new Error('no session')
      const approval = manager.handleGatewayRequest({
        sessionId: session.sessionId,
        kind: 'approve',
        payload: { toolName: 'Bash', toolUseId: 't1', input: { command: './run.sh' } }
      })
      await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
      manager.decideApproval(manager.listApprovals()[0]?.id ?? '', { kind: 'allow-manual' })
      await expect(approval).resolves.toMatchObject({ allowed: true })
      expect(strictOf(thread.id)).toBe(false)
    })

    it('allow-manual for a request that no longer exists changes nothing (returns false)', async () => {
      const thread = await manager.createThread({})
      expect(manager.decideApproval('no-such', { kind: 'allow-manual' })).toBe(false)
      expect(strictOf(thread.id)).toBe(false)
    })
  })

  it('a plan the AI issued on its own with the toggle OFF is not queued and passes by default, and touches neither toggle nor process (item 167)', async () => {
    const thread = await manager.createThread({})
    const session = await turn(thread.id, '一つ目')
    await manager.send(thread.id, { text: '二つ目' })
    await expect(exitPlan(session.sessionId, '# Plan\n\n1. a')).resolves.toMatchObject({ allowed: true })
    expect(manager.listApprovals()).toHaveLength(0)
    expect(planOf(thread.id)).toBe(false)
    expect(session.planSwitches).toEqual([])
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('even a plan with the toggle OFF is queued on a strict-mode thread (item 167)', async () => {
    const thread = await manager.createThread({ approvalStrict: true })
    await manager.send(thread.id, { text: '計画して' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const approval = exitPlan(session.sessionId, '# Plan')
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
    expect(manager.listApprovals()[0]?.plan).toBe('# Plan')
    manager.decideApproval(manager.listApprovals()[0]?.id ?? '', { kind: 'allow' })
    await expect(approval).resolves.toMatchObject({ allowed: true })
    expect(planOf(thread.id)).toBe(false)
  })

  it('returning to OFF sends a control request on the next send', async () => {
    const thread = await manager.createThread({})
    manager.setPlanMode(thread.id, true)
    const session = await turn(thread.id, '一つ目')
    manager.setPlanMode(thread.id, false)
    await manager.send(thread.id, { text: '二つ目' })
    expect(session.planSwitches).toEqual([false])
  })
})

describe('approval frame diff (item 97)', () => {
  async function pendingWrite(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ id: string; diffable: boolean | undefined }> {
    const thread = await manager.createThread({ approvalStrict: true, cwdUri: `file://${dir}` })
    await manager.send(thread.id, { text: '書いて' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    void manager.handleGatewayRequest({ sessionId: session.sessionId, kind: 'approve', payload: { toolName, toolUseId: 'w', input } })
    await vi.waitFor(() => expect(manager.listApprovals().length).toBeGreaterThan(0))
    const item = manager.listApprovals().at(-1)
    if (item === undefined) throw new Error('no item')
    return { id: item.id, diffable: item.diffable }
  }

  it('Edit shows before and after applied to the current content (a relative path from cwd)', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const a = 1\n')
    const { id, diffable } = await pendingWrite('Edit', { file_path: 'a.ts', old_string: '1', new_string: '2' })
    expect(diffable).toBe(true)
    await expect(manager.approvalDiff(id)).resolves.toEqual({
      ok: true,
      name: 'a.ts',
      before: 'const a = 1\n',
      after: 'const a = 2\n',
      basis: 'file'
    })
  })

  it('a new file from Write starts from empty. A fragment if there is no replacement source', async () => {
    const created = await pendingWrite('Write', { file_path: join(dir, 'new.txt'), content: 'hello' })
    await expect(manager.approvalDiff(created.id)).resolves.toMatchObject({ ok: true, before: '', after: 'hello', basis: 'file' })
    writeFileSync(join(dir, 'b.txt'), 'something else')
    const stale = await pendingWrite('Edit', { file_path: join(dir, 'b.txt'), old_string: 'gone', new_string: 'x' })
    await expect(manager.approvalDiff(stale.id)).resolves.toMatchObject({ ok: true, before: 'gone', after: 'x', basis: 'fragment' })
  })

  it('a path hitting the choke point, a read tool, and a request that no longer exists', async () => {
    const excluded = await pendingWrite('Write', { file_path: join(dir, 'excluded', 'x'), content: 'x' })
    await expect(manager.approvalDiff(excluded.id)).resolves.toEqual({ ok: false, reason: 'not-allowed' })
    const read = await pendingWrite('Read', { file_path: join(dir, 'a.ts') })
    expect(read.diffable).toBe(false)
    await expect(manager.approvalDiff(read.id)).resolves.toEqual({ ok: false, reason: 'not-diffable' })
    await expect(manager.approvalDiff('no-such-id')).resolves.toEqual({ ok: false, reason: 'gone' })
  })
})

describe('refusal text and timeline summary (items 182 / 183 / 196, wave 14 bundle C)', () => {
  /** The last approval row saved (the record is written in batches every 16 ms, so it waits). */
  async function lastDecided(threadId: string): Promise<Record<string, unknown>> {
    let found: Record<string, unknown> | null = null
    await vi.waitFor(async () => {
      const events = (await manager.timeline(threadId)).events
      const last = events.filter((e) => e.kind === 'permission_request').at(-1)
      const payload = last?.kind === 'permission_request' ? last.payload : null
      expect(payload?.decidedAt ?? null).not.toBeNull()
      found = payload as unknown as Record<string, unknown>
    })
    if (found === null) throw new Error('no decided request')
    return found
  }

  async function pendingBash(): Promise<{ threadId: string; approval: Promise<unknown>; id: string; sessionId: string }> {
    const thread = await manager.createThread({ approvalStrict: true })
    await manager.send(thread.id, { text: '走らせて' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const approval = manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Bash', toolUseId: 'b', callId: 'call-b', input: { command: './run.sh' } }
    })
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
    return { threadId: thread.id, approval, id: manager.listApprovals()[0]?.id ?? '', sessionId: session.sessionId }
  }

  it("refusing without writing anything returns compat's 「止まって待て」 text and marks the timeline not to keep the text", async () => {
    adapter.replies = true
    const { threadId, approval, id } = await pendingBash()
    manager.decideApproval(id, { kind: 'deny' })
    await expect(approval).resolves.toEqual({ allowed: false, message: table.approvalReplies?.stop })
    expect(table.approvalReplies?.stop).toMatch(/STOP what you are doing/)
    expect((await lastDecided(threadId))['outcome']).toMatchObject({
      kind: 'denied',
      by: 'user',
      reply: 'stop'
    })
  })

  it('refusing with a written reason wraps it in a 「代わりにこうして」 text. The timeline has only the text that was written', async () => {
    adapter.replies = true
    const { threadId, approval, id } = await pendingBash()
    manager.decideApproval(id, { kind: 'deny', message: 'ls -la にして' })
    const result = (await approval) as { message: string }
    expect(result.message).toMatch(/^The user doesn't want to proceed with this tool use\./)
    expect(result.message.endsWith('the user said:\nls -la にして')).toBe(true)
    expect((await lastDecided(threadId))['outcome']).toMatchObject({
      message: 'ls -la にして',
      reply: 'feedback'
    })
  })

  it("an Adapter without a table returns a neutral English text (TODO 567: formerly the Broker's Japanese text)", async () => {
    const { threadId, approval, id } = await pendingBash()
    manager.decideApproval(id, { kind: 'deny' })
    await expect(approval).resolves.toEqual({
      allowed: false,
      message: fallbackApprovalReply({ kind: 'stop' })
    })
    // The timeline has the reason code (the display adds no sentence for `reply: 'stop'`).
    expect((await lastDecided(threadId))['outcome']).toMatchObject({
      message: 'approval-denied-user',
      reply: 'stop'
    })
  })

  it("TODO 567: aios's withdrawal (stop) gives the table's English text to the model and the reason code to the timeline", async () => {
    adapter.replies = true
    const { threadId, approval } = await pendingBash()
    // Deleting it would make the row unreadable, so it is checked by withdrawing via the stop button (`interrupt`).
    await manager.interrupt(threadId)
    const result = (await approval) as { allowed: boolean; message: string }
    expect(result.allowed).toBe(false)
    expect(result.message).toBe(table.approvalReplies?.cancelled.stop)
    expect(result.message).not.toMatch(/[ぁ-んァ-ン一-龥]/)
    const outcome = (await lastDecided(threadId))['outcome'] as Record<string, unknown>
    expect(outcome).toMatchObject({ kind: 'denied', by: 'system', message: 'approval-cancelled-stop' })
    expect(outcome['reply']).toBeUndefined()
  })

  it('TODO 632: a gateway cancellation notice (callId) removes it from the inbox and leaves a timeout reason code in the timeline', async () => {
    adapter.replies = true
    const { threadId, approval, sessionId } = await pendingBash()
    await expect(
      manager.handleGatewayRequest({ sessionId, kind: 'approveCancelled', payload: { callId: 'call-b', toolUseId: 'b' } })
    ).resolves.toEqual({ cancelled: true })
    expect(manager.listApprovals()).toEqual([])
    const result = (await approval) as { allowed: boolean; message: string }
    expect(result.allowed).toBe(false)
    expect(result.message).toBe(table.approvalReplies?.cancelled['tool-timeout'])
    const outcome = (await lastDecided(threadId))['outcome'] as Record<string, unknown>
    expect(outcome).toMatchObject({ kind: 'denied', by: 'system', message: 'approval-cancelled-tool-timeout' })
    expect(outcome['reply']).toBeUndefined()
    // The second time (already decided) does nothing.
    await expect(
      manager.handleGatewayRequest({ sessionId, kind: 'approveCancelled', payload: { callId: 'call-b' } })
    ).resolves.toEqual({ cancelled: false })
  })

  it("TODO 632: when a result arrives for an approval's tool_use in the inbox (the CLI's idle timeout), it is withdrawn", async () => {
    const { threadId, approval } = await pendingBash()
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    // It is not removed by the result of another tool_use.
    session.emit({ threadId, kind: 'tool_result', payload: { toolUseId: 'other', ok: true, bytes: 1 } })
    expect(manager.listApprovals()).toHaveLength(1)
    session.emit({ threadId, kind: 'tool_result', payload: { toolUseId: 'b', ok: false, bytes: 120 } })
    expect(manager.listApprovals()).toEqual([])
    await expect(approval).resolves.toMatchObject({ allowed: false })
    expect((await lastDecided(threadId))['outcome']).toMatchObject({
      kind: 'denied',
      by: 'system',
      message: 'approval-cancelled-tool-timeout'
    })
  })

  it('TODO 632: a cancellation from an unknown callId / another session does nothing', async () => {
    const { sessionId } = await pendingBash()
    await expect(
      manager.handleGatewayRequest({ sessionId, kind: 'approveCancelled', payload: { callId: 'nope' } })
    ).resolves.toEqual({ cancelled: false })
    await expect(
      manager.handleGatewayRequest({ sessionId: 'other-session', kind: 'approveCancelled', payload: { callId: 'call-b' } })
    ).resolves.toEqual({ cancelled: false })
    await expect(
      manager.handleGatewayRequest({ sessionId, kind: 'approveCancelled', payload: {} })
    ).resolves.toEqual({ cancelled: false })
    expect(manager.listApprovals()).toHaveLength(1)
  })

  it('the row of a plan-presentation approval empties the summary and keeps only the line count (observation of item 196)', async () => {
    const thread = await manager.createThread({})
    manager.setPlanMode(thread.id, true)
    await manager.send(thread.id, { text: '計画して' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    const approval = exitPlan(session.sessionId, '# Plan\n\n1. a\n2. b')
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
    manager.decideApproval(manager.listApprovals()[0]?.id ?? '', { kind: 'allow' })
    await approval
    expect(await lastDecided(thread.id)).toMatchObject({ summary: '', planLines: 3 })
  })
})

describe('hosts not asked about (TODO 1029): manager allow-host', () => {
  async function strictSession(): Promise<string> {
    const thread = await manager.createThread({ approvalStrict: true })
    await manager.send(thread.id, { text: '箱を見て' })
    const session = adapter.sessions.at(-1)
    if (session === undefined) throw new Error('no session')
    return session.sessionId
  }
  const bashRequest = (sessionId: string, command: string) =>
    manager.handleGatewayRequest({
      sessionId,
      kind: 'approve',
      payload: { toolName: 'Bash', toolUseId: `tu-${Math.random()}`, input: { command } }
    })

  it('「このホストは今後聞かない」 adds the host, also resolves pending requests for the same host, and from then on does not ask even in strict mode', async () => {
    const sessionId = await strictSession()
    const first = bashRequest(sessionId, 'ssh kzm@winbox hostname')
    const second = bashRequest(sessionId, 'scp a.txt kzm@winbox:/tmp/')
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(2))
    expect(manager.listApprovals()[0]?.quietHosts).toEqual(['kzm@winbox'])
    manager.decideApproval(manager.listApprovals()[0]?.id ?? '', { kind: 'allow-host' })
    await expect(first).resolves.toMatchObject({ allowed: true })
    await expect(second).resolves.toMatchObject({ allowed: true })
    expect(manager.getApprovalPolicy().sshAllowedHosts).toEqual(['kzm@winbox'])
    await expect(bashRequest(sessionId, 'ssh kzm@winbox dir')).resolves.toMatchObject({ allowed: true })
    expect(manager.listApprovals()).toHaveLength(0)
  })

  it('even if allow-host comes for a request that does not meet the conditions, it is not added to the list (a one-time permission)', async () => {
    const sessionId = await strictSession()
    const first = bashRequest(sessionId, './deploy.sh winbox')
    await vi.waitFor(() => expect(manager.listApprovals()).toHaveLength(1))
    manager.decideApproval(manager.listApprovals()[0]?.id ?? '', { kind: 'allow-host' })
    await expect(first).resolves.toMatchObject({ allowed: true })
    expect(manager.getApprovalPolicy().sshAllowedHosts).toEqual([])
  })
})
