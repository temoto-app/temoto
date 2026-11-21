/**
 * Conversations in bundles (TODO 633 stage 3, ARCHITECTURE 7.6.6): `startBundles` of the gateway.
 *
 * With a fake Adapter (built the same way as `session-plan.test.ts`), **neither the CLI nor the model is started**. What is pinned:
 * - Pure functions: validation (count, names, duplicates, empty instructions), the question can be read as a choice, the length of the report's sentence
 * - The list is shown once, as a choice question. Anything other than "start" (refuse, or a different answer) creates nothing
 * - After approval, a new conversation is made per bundle and sent the instruction with `worktreeName` (the name gets a mark). Inherits the parent's cwd and strict mode
 * - At the end (`result`) a report is sent to the parent (with the branch; only once)
 * - At the limit, at the usage limit, outside git, and at shutdown, it returns the reason without asking
 * - Once it has entered the working tree at startup, the name is not passed to later launches (resumption uses the working tree's cwd)
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
import { ThreadStore } from '../src/main/session/store.js'
import { SessionManager, type SessionManagerDeps } from '../src/main/session/manager.js'
import { SETTING_UNATTENDED_MESSAGE } from '../src/main/session/gateway-requests.js'
import type { AgentSettings } from '../src/main/agent-settings.js'
import type { AgentAdapter, AgentInput, AgentSession, SpawnHandlers, SpawnOptions } from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'
import { questionsOf } from '../src/main/approval/questions.js'
import {
  BUNDLE_BACKEND_UNSUPPORTED,
  BUNDLE_START_LABEL,
  bundleQuestionInput,
  bundleReport,
  parseBundles,
  BundleService,
  type BundleHost
} from '../src/main/session/bundles.js'
import { usageLimitReached } from '../src/shared/usage.js'

describe('pure functions', () => {
  it('parseBundles: rejects counts, names, duplicates and empty instructions, and the title can be omitted', () => {
    expect(parseBundles([], 5).ok).toBe(false)
    expect(parseBundles('x', 5).ok).toBe(false)
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `n${i}`, prompt: 'p' }))
    expect(parseBundles(six, 5).ok).toBe(false)
    expect(parseBundles([{ name: 'a b', prompt: 'p' }], 5).ok).toBe(false)
    expect(parseBundles([{ name: '../x', prompt: 'p' }], 5).ok).toBe(false)
    expect(parseBundles([{ name: 'a', prompt: '  ' }], 5).ok).toBe(false)
    expect(
      parseBundles(
        [
          { name: 'a', prompt: 'p' },
          { name: 'a', prompt: 'q' }
        ],
        5
      ).ok
    ).toBe(false)
    const ok = parseBundles(
      [
        { name: 'a', prompt: 'p' },
        { name: 'b', title: ' Bee  x ', prompt: 'q' }
      ],
      5
    )
    expect(ok).toEqual({
      ok: true,
      bundles: [
        { name: 'a', title: 'a', prompt: 'p' },
        { name: 'b', title: 'Bee x', prompt: 'q' }
      ]
    })
  })

  it('bundleQuestionInput: can be read as an existing choice question', () => {
    const asked = bundleQuestionInput([{ name: 'a', title: 'A', prompt: 'do a\nmore' }])
    const questions = questionsOf('AskUserQuestion', asked.input)
    expect(questions?.length).toBe(1)
    expect(questions?.[0]?.question).toBe(asked.question)
    expect(questions?.[0]?.options.map((o) => o.label)).toContain(BUNDLE_START_LABEL)
    expect(asked.question).toContain('do a')
    expect(asked.question).not.toContain('more')
  })

  it('bundleReport: includes the branch and result, and truncates a long result', () => {
    const text = bundleReport({ title: 'T', name: 'n', branch: 'wt-n-1', outcome: 'finished', text: 'x'.repeat(5000) })
    expect(text).toContain('[aios] Bundle "T" (n) finished. Branch: wt-n-1.')
    expect(text.length).toBeLessThan(1700)
    expect(bundleReport({ title: 'T', name: 'n', branch: null, outcome: 'exited', text: null })).toBe(
      '[aios] Bundle "T" (n) exited before finishing.'
    )
  })

  it('usageLimitReached: only until the window used up by rejected returns', () => {
    const base = { status: 'rejected', usingOverage: false, receivedAt: 0 }
    const now = 1_000_000
    expect(usageLimitReached(null, now)).toBe(false)
    expect(usageLimitReached({ ...base, status: 'allowed', fiveHour: { utilization: 1, resetsAt: null } }, now)).toBe(false)
    expect(usageLimitReached({ ...base, fiveHour: { utilization: 1, resetsAt: now / 1000 + 60 } }, now)).toBe(true)
    expect(usageLimitReached({ ...base, fiveHour: { utilization: 1, resetsAt: now / 1000 - 60 } }, now)).toBe(false)
    expect(usageLimitReached({ ...base, fiveHour: { utilization: 0.5, resetsAt: null } }, now)).toBe(true)
    expect(usageLimitReached({ ...base, usingOverage: true, fiveHour: { utilization: 0.2, resetsAt: now / 1000 - 5 } }, now)).toBe(true)
  })
})

describe('BundleService', () => {
  function host(over: Partial<BundleHost> = {}): { host: BundleHost; sent: [string, string][] } {
    const sent: [string, string][] = []
    let n = 0
    const threads = new Map<string, { id: string; cwdUri: string; approvalStrict: boolean; backend?: string; modelId?: string | null }>()
    threads.set('parent', { id: 'parent', cwdUri: 'file:///repo', approvalStrict: true, backend: 'second', modelId: 'm-1' })
    const h: BundleHost = {
      isStopped: () => false,
      isAgentDisabled: () => false,
      getThread: (id) => (threads.get(id) ?? null) as never,
      isUsageLimited: () => false,
      isGitWorkTree: async () => true,
      supportsWorktreeLaunch: () => true,
      createThread: async (input) => {
        n += 1
        const t = { id: `c${n}`, cwdUri: input.cwdUri, approvalStrict: input.approvalStrict }
        threads.set(t.id, t)
        return t as never
      },
      send: async (id, text) => {
        sent.push([id, text])
      },
      remove: async () => undefined,
      branchOf: () => 'wt-x',
      maxBundles: () => 2,
      hasSessionRoom: () => true,
      ...over
    }
    return { host: h, sent }
  }

  it('the limit counts running bundles plus this batch. Refuses on usage, outside git, and during shutdown', async () => {
    const { host: h } = host()
    const service = new BundleService(h)
    expect(service.precheck(2)).toBeNull()
    expect(service.precheck(3)).toMatch(/too many/)
    await service.start('parent', [{ name: 'a', title: 'a', prompt: 'p' }])
    expect(service.precheck(2)).toMatch(/1 still running/)
    expect(new BundleService(host({ isUsageLimited: () => true }).host).precheck(1)).toMatch(/usage limit/)
    expect(new BundleService(host({ isStopped: () => true }).host).precheck(1)).toMatch(/shutting down/)
    const outside = new BundleService(host({ isGitWorkTree: async () => false }).host)
    expect(await outside.start('parent', [{ name: 'a', title: 'a', prompt: 'p' }])).toMatchObject({ status: 'error' })
  })

  it('TODO 1122: a child is created with the same backend and model as the parent, and refused on a backend that cannot start in a worktree', async () => {
    const inputs: Parameters<BundleHost['createThread']>[0][] = []
    const { host: h } = host({
      createThread: async (input) => {
        inputs.push(input)
        return { id: 'c1', cwdUri: input.cwdUri, approvalStrict: input.approvalStrict } as never
      }
    })
    const service = new BundleService(h)
    expect(await service.start('parent', [{ name: 'a', title: 'a', prompt: 'p' }])).toMatchObject({ status: 'started' })
    expect(inputs[0]).toMatchObject({ backend: 'second', modelId: 'm-1' })

    const created: string[] = []
    const unsupported = host({
      supportsWorktreeLaunch: () => false,
      createThread: async (input) => {
        created.push(input.title)
        return { id: 'x' } as never
      }
    }).host
    const refusing = new BundleService(unsupported)
    const parent = unsupported.getThread('parent')!
    expect(refusing.precheck(1, parent)).toBe(BUNDLE_BACKEND_UNSUPPORTED)
    // A call whose parent is unknown (only the count check) is as before.
    expect(refusing.precheck(1)).toBeNull()
    expect(await refusing.start('parent', [{ name: 'a', title: 'a', prompt: 'p' }])).toEqual({
      status: 'error',
      error: BUNDLE_BACKEND_UNSUPPORTED
    })
    expect(created).toEqual([])
    expect(refusing.activeCount()).toBe(0)
  })

  it("wave 96 fix Y: a child stays under the parent's Teammate, and a child started from an unattended turn is marked through the host before its first send (TODO 1289)", async () => {
    const inputs: Parameters<BundleHost['createThread']>[0][] = []
    const marked: string[] = []
    const order: string[] = []
    const { host: h } = host({
      getThread: (id) =>
        (id === 'parent'
          ? { id: 'parent', cwdUri: 'file:///repo', approvalStrict: false, backend: 'second', modelId: null, roleId: 'role-1' }
          : null) as never,
      isUnattended: (id) => id === 'parent',
      markStartedUnattended: (id) => {
        marked.push(id)
        order.push(`mark ${id}`)
      },
      send: async (id) => {
        order.push(`send ${id}`)
      },
      createThread: async (input) => {
        inputs.push(input)
        return { id: `c${inputs.length}`, cwdUri: input.cwdUri, approvalStrict: input.approvalStrict } as never
      }
    })
    const service = new BundleService(h)
    await service.start('parent', [{ name: 'a', title: 'a', prompt: 'p' }])
    expect(inputs[0]?.roleId).toBe('role-1')
    // Code-review (wave 97 fix Y): the mark is the host's (a DB column), set before the first send, and the service keeps no copy to lose.
    expect(marked).toEqual(['c1'])
    expect(order).toEqual(['mark c1', 'send c1'])
    await service.onTurnEnded('c1', { ok: true, interrupted: false, text: 'done' })
    service.forget('c1')
    expect(marked).toEqual(['c1'])

    // From an attended parent without a Teammate: no role, not unattended.
    const plain = host()
    const created: Parameters<BundleHost['createThread']>[0][] = []
    const spy = new BundleService({
      ...plain.host,
      markStartedUnattended: (id) => marked.push(id),
      createThread: async (input) => {
        created.push(input)
        return { id: 'k1', cwdUri: input.cwdUri, approvalStrict: input.approvalStrict } as never
      }
    })
    await spy.start('parent', [{ name: 'b', title: 'b', prompt: 'p' }])
    expect('roleId' in created[0]!).toBe(false)
    expect(marked).toEqual(['c1'])
  })

  it('passes the name to the started conversation and does not pass it once entered. Reports to the parent only once at the end', async () => {
    const { host: h, sent } = host()
    const service = new BundleService(h)
    const result = await service.start('parent', [{ name: 'a', title: 'A', prompt: 'do a' }])
    expect(result).toMatchObject({ status: 'started', threads: [{ name: 'a', threadId: 'c1' }] })
    expect(sent).toEqual([['c1', 'do a']])
    expect(service.launchWorktreeName('c1')).toMatch(/^a-[0-9a-f]{4}$/)
    service.enteredWorktree('c1')
    expect(service.launchWorktreeName('c1')).toBeNull()
    service.noteText('c1', 'last words')
    await service.onTurnEnded('c1', { ok: true, interrupted: false, text: null })
    await service.onExit('c1')
    await service.onTurnEnded('c1', { ok: true, interrupted: false, text: 'again' })
    const reports = sent.filter(([id]) => id === 'parent')
    expect(reports.length).toBe(1)
    expect(reports[0]?.[1]).toContain('Bundle "A" (a) finished. Branch: wt-x.')
    expect(reports[0]?.[1]).toContain('last words')
    expect(service.activeCount()).toBe(0)
  })

  it('a bundle without a free slot is not created but put into failed, and says it did not start even if approved', async () => {
    let room = 1
    const created: string[] = []
    const { host: h, sent } = host({
      hasSessionRoom: () => room > 0,
      createThread: async (input) => {
        created.push(input.title)
        room -= 1
        return { id: `c${created.length}`, cwdUri: input.cwdUri, approvalStrict: false } as never
      }
    })
    const service = new BundleService(h)
    const result = await service.start('parent', [
      { name: 'a', title: 'a', prompt: 'p' },
      { name: 'b', title: 'b', prompt: 'q' }
    ])
    expect(created).toEqual(['a'])
    expect(sent).toEqual([['c1', 'p']])
    expect(result).toMatchObject({ status: 'started', threads: [{ name: 'a' }], failed: [{ name: 'b' }] })
    expect((result as { note: string }).note).toMatch(/not started/)
  })

  it('concurrent starts reserve slots first and do not exceed the limit', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { host: h } = host({ isGitWorkTree: async () => (await gate, true) })
    const service = new BundleService(h)
    const first = service.start('parent', [
      { name: 'a', title: 'a', prompt: 'p' },
      { name: 'b', title: 'b', prompt: 'q' }
    ])
    const second = await service.start('parent', [{ name: 'c', title: 'c', prompt: 'r' }])
    expect(second).toMatchObject({ status: 'error', error: expect.stringMatching(/too many/) })
    release()
    expect(await first).toMatchObject({ status: 'started' })
    expect(service.activeCount()).toBe(2)
  })

  it('when a conversation disappears, drops the tracking and the name record and does not report', async () => {
    const { host: h, sent } = host()
    const service = new BundleService(h)
    await service.start('parent', [{ name: 'a', title: 'a', prompt: 'p' }])
    service.forget('c1')
    expect(service.activeCount()).toBe(0)
    expect(service.launchWorktreeName('c1')).toBeNull()
    await service.onExit('c1')
    expect(sent.filter(([id]) => id === 'parent')).toEqual([])
  })

  it('retries a few times when the report is refused', async () => {
    let calls = 0
    const { host: h, sent } = host({
      send: async (id, text) => {
        if (id === 'parent') {
          calls += 1
          if (calls < 3) return { kind: 'rejected' }
          sent.push([id, text])
          return { kind: 'sent' }
        }
        return undefined
      }
    })
    const service = new BundleService(h, 1)
    await service.start('parent', [{ name: 'a', title: 'a', prompt: 'p' }])
    await service.onTurnEnded('c1', { ok: true, interrupted: false, text: 'x' })
    expect(calls).toBe(3)
    expect(sent.length).toBe(1)
  })

  it('the question puts the full instruction text of every bundle in the description of 「始める」', () => {
    const long = `first line\n${'x'.repeat(5000)}`
    const asked = bundleQuestionInput([{ name: 'a', title: 'A', prompt: long }])
    const options = (asked.input as { questions: { options: { label: string; description: string }[] }[] }).questions[0]?.options
    expect(options?.find((o) => o.label === BUNDLE_START_LABEL)?.description).toContain(long)
    expect(asked.question).toContain(`${long.length} chars`)
  })

  it('a bundle that could not be sent leaves no conversation and goes into failed', async () => {
    const removed: string[] = []
    const { host: h } = host({
      send: async (id) => {
        if (id === 'c1') throw new Error('boom')
      },
      remove: async (id) => {
        removed.push(id)
      }
    })
    const service = new BundleService(h)
    const result = await service.start('parent', [
      { name: 'a', title: 'a', prompt: 'p' },
      { name: 'b', title: 'b', prompt: 'q' }
    ])
    expect(result).toMatchObject({
      status: 'started',
      threads: [{ name: 'b' }],
      failed: [{ name: 'a', error: 'boom' }]
    })
    expect(removed).toEqual(['c1'])
    expect(service.activeCount()).toBe(1)
  })
})

describe('SessionManager gateway startBundles', () => {
  class FakeSession implements AgentSession {
    readonly sent: AgentInput[] = []
    alive = true
    constructor(
      readonly sessionId: string,
      readonly threadId: string,
      readonly handlers: SpawnHandlers
    ) {}
    send(input: AgentInput): void {
      this.sent.push(input)
    }
    async interrupt(): Promise<void> {}
    abort(): void {}
    async stop(): Promise<void> {
      this.alive = false
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
    readonly label = 'Fake'
    constructor(
      readonly id = 'fake',
      /** TODO 1122: whether a conversation can be started in a worktree (OpenCode is a fake). */
      private readonly worktree = true
    ) {}
    supportsWorktreeLaunch(): boolean {
      return this.worktree
    }
    readonly transcripts = null
    readonly sessions: FakeSession[] = []
    readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      const session = new FakeSession(options.sessionId, options.threadId, handlers)
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
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    stopReason: null,
    denials: [],
    text: null
  }

  let db: Db
  let adapter: FakeAdapter
  /** TODO 1122: one more backend that can be started in a worktree, and a backend that cannot. */
  let second: FakeAdapter
  let noWorktree: FakeAdapter
  let manager: SessionManager
  let dir: string
  let usageLimited = false

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-bundles-'))
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    adapter = new FakeAdapter()
    second = new FakeAdapter('second')
    noWorktree = new FakeAdapter('no-worktree', false)
    usageLimited = false
    const fs = {
      homePath: dir,
      homeUri: `file://${dir}`,
      defaultReferenceDirs: () => [],
      isReferenceable: () => true,
      assertAllowed: (uri: string) => decodeURIComponent(uri.replace('file://', ''))
    } as unknown as FsAccess
    manager = new SessionManager({
      db,
      adapters: [adapter, second, noWorktree],
      fs,
      index: {
        indexConversationEvents: () => undefined,
        removeThread: () => undefined,
        removeAllConversations: () => undefined
      } as unknown as IndexClient,
      gateway: { socketPath: '/tmp/x.sock', issueToken: () => 'token', revokeToken: () => undefined } as unknown as GatewayServer,
      gatewayRuntimePath: '/bin/false',
      gatewayScriptPath: '/dev/null',
      gatewayConfigDir: '/tmp/aios-test-bundles-mcp',
      isUsageLimited: () => usageLimited,
      isGitWorkTree: async () => true,
      events: {
        onEvents: () => undefined,
        onThreadsChanged: () => undefined,
        onThreadChanged: () => undefined,
        onApprovalsChanged: () => undefined,
        onAgentStatus: () => undefined
      }
    })
  })

  afterEach(async () => {
    await manager.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function parentTurn(on: FakeAdapter = adapter): Promise<{ threadId: string; session: FakeSession }> {
    const thread = await manager.createThread({ cwdUri: `file://${dir}`, approvalStrict: true, backend: on.id })
    await manager.send(thread.id, { text: '分けて' })
    const session = on.sessions.at(-1) as FakeSession
    session.emit({ kind: 'result', payload: RESULT })
    return { threadId: thread.id, session }
  }

  const call = (sessionId: string, bundles: unknown) =>
    manager.handleGatewayRequest({ sessionId, kind: 'startBundles', payload: { bundles, callId: 'call-1' } })

  async function pendingQuestion(): Promise<{ id: string; question: string }> {
    await vi.waitFor(() => expect(manager.listApprovals().length).toBe(1))
    const item = manager.listApprovals()[0]
    const question = item?.questions?.[0]?.question
    if (item === undefined || question === undefined) throw new Error('no question')
    return { id: item.id, question }
  }

  it('shows the list only once, and choosing start creates a conversation per bundle and sends the instructions', async () => {
    const { session } = await parentTurn()
    const started = call(session.sessionId, [
      { name: 'a', prompt: 'do a' },
      { name: 'b', title: 'Bee', prompt: 'do b' }
    ])
    const { id, question } = await pendingQuestion()
    expect(manager.decideApproval(id, { kind: 'answer', answers: { [question]: [BUNDLE_START_LABEL] } })).toBe(true)
    const result = (await started) as { status: string; threads: { threadId: string; name: string }[] }
    expect(result.status).toBe('started')
    expect(result.threads.map((t) => t.name)).toEqual(['a', 'b'])
    expect(manager.listApprovals().length).toBe(0)
    // Parent + 2 children
    expect(adapter.spawn).toHaveBeenCalledTimes(3)
    const childOptions = adapter.spawn.mock.calls.slice(1).map((c) => c[0])
    expect(childOptions.map((o) => o.worktreeName)).toEqual([
      expect.stringMatching(/^a-[0-9a-f]{4}$/),
      expect.stringMatching(/^b-[0-9a-f]{4}$/)
    ])
    expect(childOptions.every((o) => o.cwd === dir && o.resumeBackendSessionId === null)).toBe(true)
    expect(adapter.sessions.slice(1).map((s) => s.sent[0]?.text)).toEqual(['do a', 'do b'])
    const child = manager.listSummaries().find((s) => s.thread.id === result.threads[1]?.threadId)
    expect(child?.thread.title).toBe('Bee')
    expect(child?.thread.approvalStrict).toBe(true)

    // Child a enters the working tree and finishes → reports to the parent (the parent is not responding, so it goes straight to the parent's process)
    const childA = adapter.sessions[1] as FakeSession
    childA.emit({
      kind: 'worktree_changed',
      payload: {
        change: 'enter',
        path: join(dir, '.wt', 'a-1'),
        branch: 'wt-a-1',
        returnCwd: null,
        toolUseId: null,
        atLaunch: true
      }
    })
    childA.emit({ kind: 'result', payload: { ...RESULT, text: 'a is done' } })
    await vi.waitFor(() => expect(session.sent.length).toBe(2))
    const report = session.sent[1]?.text ?? ''
    expect(report).toContain('[aios] Bundle "a" (a) finished. Branch: wt-a-1.')
    expect(report).toContain('a is done')

    // The second turn of the same child is not reported
    childA.emit({ kind: 'result', payload: { ...RESULT, text: 'more' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(session.sent.length).toBe(2)
  })

  it("TODO 1122: a bundle's child starts on the same backend as the parent (not routed to the default backend)", async () => {
    const { session } = await parentTurn(second)
    const started = call(session.sessionId, [{ name: 'a', prompt: 'do a' }])
    const { id, question } = await pendingQuestion()
    manager.decideApproval(id, { kind: 'answer', answers: { [question]: [BUNDLE_START_LABEL] } })
    const result = (await started) as { status: string; threads: { threadId: string }[] }
    expect(result.status).toBe('started')
    expect(adapter.spawn).not.toHaveBeenCalled()
    expect(second.spawn).toHaveBeenCalledTimes(2)
    expect(second.spawn.mock.calls[1]?.[0].worktreeName).toMatch(/^a-[0-9a-f]{4}$/)
    const child = manager.listSummaries().find((s) => s.thread.id === result.threads[0]?.threadId)
    expect(child?.thread.backend).toBe('second')
  })

  it("TODO 1122: if the parent's model is not in the current list, the child is created with the default model from settings (does not fail the whole bundle)", async () => {
    const { threadId, session } = await parentTurn()
    db.prepare(`UPDATE threads SET model_id = 'gone' WHERE id = ?`).run(threadId)
    const started = call(session.sessionId, [{ name: 'a', prompt: 'do a' }])
    const { id, question } = await pendingQuestion()
    manager.decideApproval(id, { kind: 'answer', answers: { [question]: [BUNDLE_START_LABEL] } })
    const result = (await started) as { status: string; threads: { threadId: string }[]; failed: unknown[] }
    expect(result).toMatchObject({ status: 'started', failed: [] })
    const child = manager.listSummaries().find((s) => s.thread.id === result.threads[0]?.threadId)
    expect(child?.thread.modelId).toBeNull()
  })

  it('TODO 1122: from a conversation on a backend that cannot start in a worktree, returns an error with a reason without asking', async () => {
    const { session } = await parentTurn(noWorktree)
    expect(await call(session.sessionId, [{ name: 'a', prompt: 'do a' }])).toEqual({
      status: 'error',
      error: BUNDLE_BACKEND_UNSUPPORTED
    })
    expect(manager.listApprovals().length).toBe(0)
    expect(adapter.spawn).not.toHaveBeenCalled()
    expect(noWorktree.spawn).toHaveBeenCalledTimes(1)
  })

  it('refusing or answering differently creates nothing and returns declined', async () => {
    const { session } = await parentTurn()
    const started = call(session.sessionId, [{ name: 'a', prompt: 'do a' }])
    const { id } = await pendingQuestion()
    manager.decideApproval(id, { kind: 'deny' })
    expect(await started).toMatchObject({ status: 'declined' })
    const again = call(session.sessionId, [{ name: 'a', prompt: 'do a' }])
    const second = await pendingQuestion()
    manager.decideApproval(second.id, { kind: 'answer', answers: { [second.question]: ['Cancel'] } })
    expect(await again).toMatchObject({ status: 'declined' })
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('over the limit, usage limit and invalid input return an error without asking', async () => {
    const { session } = await parentTurn()
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `n${i}`, prompt: 'p' }))
    expect(await call(session.sessionId, six)).toMatchObject({ status: 'error' })
    expect(await call(session.sessionId, [{ name: '', prompt: 'p' }])).toMatchObject({ status: 'error' })
    usageLimited = true
    expect(await call(session.sessionId, [{ name: 'a', prompt: 'p' }])).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/usage limit/)
    })
    expect(manager.listApprovals().length).toBe(0)
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
  })

  it('TODO 1289: a bundle started from an unattended scheduled turn stays unattended on the turns aios starts on its own, until a person sends', async () => {
    const committed: unknown[] = []
    manager.setAppSettings({
      list: () => ({ settings: [], unknown: [] }),
      prepare: (name: unknown, value: unknown) => ({
        ok: true,
        value: { name, value, previous: 'light', unchanged: false, access: 'display', summary: String(name) }
      }),
      commit: (change: { name: unknown; value: unknown }) => {
        committed.push(change)
        return { name: change.name, value: change.value, previous: 'light' }
      }
    } as unknown as AgentSettings)
    const setTheme = async (sessionId: string): Promise<unknown> =>
      manager.handleGatewayRequest({ sessionId, kind: 'setSetting', payload: { name: 'theme', value: 'dark' } })

    const parentId = await manager.runScheduledJob({
      jobId: 'job-1',
      name: 'Nightly',
      prompt: 'split the work',
      cwd: dir,
      modelId: null,
      thinking: null,
      approvalStrict: false
    })
    const parent = adapter.sessions.at(-1) as FakeSession
    const started = call(parent.sessionId, [{ name: 'a', prompt: 'do a' }])
    const { id, question } = await pendingQuestion()
    manager.decideApproval(id, { kind: 'answer', answers: { [question]: [BUNDLE_START_LABEL] } })
    const result = (await started) as { threads: { threadId: string }[] }
    const childId = result.threads[0]!.threadId
    const child = adapter.sessions.at(-1) as FakeSession

    // The child's first turn (sent by aios).
    expect(await setTheme(child.sessionId)).toEqual({ error: SETTING_UNATTENDED_MESSAGE })
    child.emit({ kind: 'result', payload: RESULT })
    // The report waits as a reservation behind the parent's own (still running) first turn.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // A later turn aios starts on its own (a resend, a reservation, a resume): still nobody watching.
    await manager.send(childId, { text: 'automatic follow-up' })
    expect(await setTheme(child.sessionId)).toEqual({ error: SETTING_UNATTENDED_MESSAGE })
    child.emit({ kind: 'result', payload: RESULT })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // A person sends to the child themselves: that turn is attended.
    await manager.send(childId, { text: 'change the theme' }, 'human')
    expect(await setTheme(child.sessionId)).toMatchObject({ ok: true, changed: true })
    expect(committed).toHaveLength(1)
    expect(manager.listSummaries().some((s) => s.thread.id === parentId)).toBe(true)
  })

  it('code-review (wave 97 fix Y): migration 48 adds the mark with 0 for existing rows and can be applied again', () => {
    const store = new ThreadStore(db)
    db.prepare(
      `INSERT INTO threads (id, title, cwd, created_at, updated_at) VALUES ('old', 'Old', '/tmp', 1, 1)`
    ).run()
    expect(store.isStartedUnattended('old')).toBe(false)
    store.markStartedUnattended('old')
    expect(store.isStartedUnattended('old')).toBe(true)
    db.pragma('user_version = 47')
    expect(() => runMigrations(db)).not.toThrow()
    expect(store.isStartedUnattended('old')).toBe(true)
    expect(store.isStartedUnattended('missing')).toBe(false)
  })

  it("code-review (wave 97 fix Y): the child's unattended mark is in the DB - after a restart its automatic turns are still unattended; a child of an attended turn is not marked", async () => {
    const settings = {
      list: () => ({ settings: [], unknown: [] }),
      prepare: (name: unknown, value: unknown) => ({
        ok: true,
        value: { name, value, previous: 'light', unchanged: false, access: 'display', summary: String(name) }
      }),
      commit: (change: { name: unknown; value: unknown }) => ({ name: change.name, value: change.value, previous: 'light' })
    } as unknown as AgentSettings
    manager.setAppSettings(settings)
    const setTheme = async (sessionId: string): Promise<unknown> =>
      manager.handleGatewayRequest({ sessionId, kind: 'setSetting', payload: { name: 'theme', value: 'dark' } })
    const startOne = async (parentSession: string, name: string): Promise<string> => {
      const started = call(parentSession, [{ name, prompt: `do ${name}` }])
      const { id, question } = await pendingQuestion()
      manager.decideApproval(id, { kind: 'answer', answers: { [question]: [BUNDLE_START_LABEL] } })
      return ((await started) as { threads: { threadId: string }[] }).threads[0]!.threadId
    }
    const last = (): FakeSession => adapter.sessions.at(-1) as FakeSession

    await manager.runScheduledJob({
      jobId: 'job-1',
      name: 'Nightly',
      prompt: 'split the work',
      cwd: dir,
      modelId: null,
      thinking: null,
      approvalStrict: false
    })
    const unattendedChild = await startOne(last().sessionId, 'a')
    last().emit({ kind: 'result', payload: RESULT })
    // A person's own conversation starts a bundle too (approved by the same question).
    const { threadId: attendedParentId } = await parentTurn()
    await manager.send(attendedParentId, { text: 'split this' }, 'human')
    const attendedChild = await startOne(last().sessionId, 'b')
    last().emit({ kind: 'result', payload: RESULT })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The app restarts: nothing in memory survives, the DB does.
    const deps = (manager as unknown as { deps: SessionManagerDeps }).deps
    await manager.stop()
    manager = new SessionManager(deps)
    manager.setAppSettings(settings)

    // An automatic turn of the child (a resume, an automatic resend): still nobody watching.
    await manager.send(unattendedChild, { text: 'automatic resume' })
    expect(await setTheme(last().sessionId)).toEqual({ error: SETTING_UNATTENDED_MESSAGE })
    // The child of an attended turn is an ordinary conversation, as before.
    await manager.send(attendedChild, { text: 'automatic resume' })
    expect(await setTheme(last().sessionId)).toMatchObject({ ok: true, changed: true })
  })
})
