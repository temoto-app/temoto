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
import { SessionManager } from '../src/main/session/manager.js'
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

describe('純関数', () => {
  it('parseBundles: 数・名前・重複・空の指示を断り、題名は省略できる', () => {
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

  it('bundleQuestionInput: 既存の選択式の質問として読める', () => {
    const asked = bundleQuestionInput([{ name: 'a', title: 'A', prompt: 'do a\nmore' }])
    const questions = questionsOf('AskUserQuestion', asked.input)
    expect(questions?.length).toBe(1)
    expect(questions?.[0]?.question).toBe(asked.question)
    expect(questions?.[0]?.options.map((o) => o.label)).toContain(BUNDLE_START_LABEL)
    expect(asked.question).toContain('do a')
    expect(asked.question).not.toContain('more')
  })

  it('bundleReport: ブランチと結果を載せ、長い結果は切る', () => {
    const text = bundleReport({ title: 'T', name: 'n', branch: 'wt-n-1', outcome: 'finished', text: 'x'.repeat(5000) })
    expect(text).toContain('[aios] Bundle "T" (n) finished. Branch: wt-n-1.')
    expect(text.length).toBeLessThan(1700)
    expect(bundleReport({ title: 'T', name: 'n', branch: null, outcome: 'exited', text: null })).toBe(
      '[aios] Bundle "T" (n) exited before finishing.'
    )
  })

  it('usageLimitReached: rejected で使い切った窓が戻る前だけ', () => {
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

  it('上限は走っている束と今回の合計で数える。使用量・git の外・終了処理では断る', async () => {
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

  it('TODO 1122: 子は親と同じバックエンド・モデルで作り、worktree で始められないバックエンドでは断る', async () => {
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

  it('始めた会話に名前を渡し、入れたら渡さない。終わりは 1 回だけ親に報告', async () => {
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

  it('枠が足りない束は作らず failed に入れ、承認済みでも始まらなかったと伝える', async () => {
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

  it('並行する start は枠を先に確保し、上限を超えない', async () => {
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

  it('会話が消えたら追跡と名前の控えを外し、報告しない', async () => {
    const { host: h, sent } = host()
    const service = new BundleService(h)
    await service.start('parent', [{ name: 'a', title: 'a', prompt: 'p' }])
    service.forget('c1')
    expect(service.activeCount()).toBe(0)
    expect(service.launchWorktreeName('c1')).toBeNull()
    await service.onExit('c1')
    expect(sent.filter(([id]) => id === 'parent')).toEqual([])
  })

  it('報告が拒否されたら数回だけ再送する', async () => {
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

  it('質問は各束の指示の全文を「始める」の説明に載せる', () => {
    const long = `first line\n${'x'.repeat(5000)}`
    const asked = bundleQuestionInput([{ name: 'a', title: 'A', prompt: long }])
    const options = (asked.input as { questions: { options: { label: string; description: string }[] }[] }).questions[0]?.options
    expect(options?.find((o) => o.label === BUNDLE_START_LABEL)?.description).toContain(long)
    expect(asked.question).toContain(`${long.length} chars`)
  })

  it('送れなかった束は会話を残さず failed に入れる', async () => {
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

describe('SessionManager の gateway startBundles', () => {
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

  it('一覧を 1 回だけ見せ、始めるを選ぶと束ごとに会話を作って指示を送る', async () => {
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

  it('TODO 1122: 束の子は親と同じバックエンドで起動する (既定のバックエンドに回さない)', async () => {
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

  it('TODO 1122: 親のモデルが今の一覧に無ければ、子は設定の既定のモデルで作る (束ごと失敗させない)', async () => {
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

  it('TODO 1122: worktree で始められないバックエンドの会話からは、聞かずに理由つきの error を返す', async () => {
    const { session } = await parentTurn(noWorktree)
    expect(await call(session.sessionId, [{ name: 'a', prompt: 'do a' }])).toEqual({
      status: 'error',
      error: BUNDLE_BACKEND_UNSUPPORTED
    })
    expect(manager.listApprovals().length).toBe(0)
    expect(adapter.spawn).not.toHaveBeenCalled()
    expect(noWorktree.spawn).toHaveBeenCalledTimes(1)
  })

  it('断る・別の答えでは何も作らず declined を返す', async () => {
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

  it('上限超え・使用量の上限・不正な入力は聞かずに error を返す', async () => {
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
})
