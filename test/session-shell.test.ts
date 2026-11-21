/**
 * The SessionManager side of the `!` in the prompt field (item 116, ARCHITECTURE.md 4.5.7).
 *
 * The shell is replaced by a fake of `SessionManagerDeps.runShell`, so **neither zsh, the CLI, nor a model is started** (the real zsh is in `test/shell-input.test.ts`). The DB is the real SQLite code (in memory). Split from `test/session-manager.test.ts` into its own harness so that parallel bundles do not touch the same file.
 *
 * What is pinned down:
 * - `!` runs without starting the backend, and leaves a `shell_run` row and a pending note to mix into the next message
 * - The note is mixed only into the head of the **text passed to the backend** in the next message, and is not in the recorded `user_text`
 * - While a response is in progress, it follows the same rule as reservations (item 94): it runs after the earlier reservation
 * - Saving goes through redaction (owner decision 2026-09-27)
 * - If the body is not a command, refuse. Attachments, selected ranges, and model / thinking settings are dropped
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload, ShellRunPayload } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import type { ThreadSummary } from '../src/shared/thread.js'
import { runMigrations } from '../src/common/migrations.js'
import { SessionManager } from '../src/main/session/manager.js'
import type {
  AgentAdapter,
  AgentInput,
  AgentSession,
  SpawnHandlers,
  SpawnOptions
} from '../src/main/session/types.js'
import type { ShellRunRequest, ShellRunResult } from '../src/main/session/shell-run.js'
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
  /** The real Adapter is wrapped by the compat table's template. Here only a marker is attached, to check the order. */
  formatShellContext(runs: readonly ShellRunPayload[]): string {
    return runs.map((run) => `[shell ${run.command} => ${run.stdout.trim()}]`).join('\n')
  }
  shellLimits(): { maxOutputChars: number; timeoutMs: number } {
    return { maxOutputChars: 1234, timeoutMs: 5678 }
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
/** Requests that reached the fake shell. */
let requests: ShellRunRequest[] = []
/** The answer of the fake shell. Replaced per command. */
let answer: (request: ShellRunRequest) => ShellRunResult | Promise<ShellRunResult>

const ok = (stdout: string): ShellRunResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
  status: 'ok',
  truncated: false,
  durationMs: 3,
  errorCode: null
})

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  summaries = []
  requests = []
  answer = (request) => ok(`out of ${request.command}`)
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
    socketPath: '/tmp/aios-test-D.sock',
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
    gatewayConfigDir: '/tmp/aios-test-D-mcp',
    runShell: async (request) => {
      requests.push(request)
      return answer(request)
    },
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
})

afterEach(async () => {
  await manager.stop()
  db.close()
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

function runtimeOf(threadId: string): ThreadSummary['runtime'] {
  const found = summaries.find((s) => s.thread.id === threadId)
  if (found === undefined) throw new Error('thread not in summaries')
  return found.runtime
}

function threadOf(threadId: string): ThreadSummary['thread'] {
  const found = summaries.find((s) => s.thread.id === threadId)
  if (found === undefined) throw new Error('thread not in summaries')
  return found.thread
}

async function shellRows(threadId: string): Promise<ShellRunPayload[]> {
  return (await manager.timeline(threadId)).events.flatMap((e) => (e.kind === 'shell_run' ? [e.payload] : []))
}

describe('SessionManager — プロンプト欄の ! (項目 116)', () => {
  it('バックエンドを起こさずにスレッドの cwd で走り、行と控えが残る', async () => {
    const thread = await manager.createThread({ cwdUri: 'file:///Users/tester/proj' })
    const outcome = await manager.send(thread.id, { text: '!ls -la', shell: true })
    expect(outcome.kind).toBe('sent')
    expect(adapter.spawn).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    // Pass the Adapter's limit (same value as the Bash tool). The command is the body with `!` removed.
    expect(requests[0]).toMatchObject({
      command: 'ls -la',
      cwd: '/Users/tester/proj',
      maxOutputChars: 1234,
      timeoutMs: 5678
    })
    expect(runtimeOf(thread.id).pendingShell).toBe(1)
    await settle()
    expect(await shellRows(thread.id)).toEqual([expect.objectContaining({ command: 'ls -la', status: 'ok' })])
    // Just running it does not start a turn (and no message is recorded).
    expect((await manager.timeline(thread.id)).events.some((e) => e.kind === 'user_text')).toBe(false)
  })

  it('次の発言の頭にだけ混ざり、記録する user_text には入らない。混ぜたら控えは消える', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '!ls', shell: true })
    await manager.send(thread.id, { text: '!git status', shell: true })
    expect(runtimeOf(thread.id).pendingShell).toBe(2)

    await manager.send(thread.id, { text: 'この結果を見て' })
    const session = adapter.sessions.at(-1)!
    expect(session.sent.map((i) => i.text)).toEqual([
      '[shell ls => out of ls]\n[shell git status => out of git status]\n\nこの結果を見て'
    ])
    expect(runtimeOf(thread.id).pendingShell).toBe(0)
    await settle()
    const users = (await manager.timeline(thread.id)).events.flatMap((e) =>
      e.kind === 'user_text' ? [e.payload.text] : []
    )
    expect(users).toEqual(['この結果を見て'])
    // The title comes from the user's message (not named from the shell wrapper).
    expect(threadOf(thread.id).title).toBe('この結果を見て')

    // Not mixed into the second message.
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await manager.send(thread.id, { text: '次' })
    expect(session.sent.at(-1)?.text).toBe('次')
  })

  it('応答中は予約になり、前の予約の後ろで走る。結果はその後の発言に混ざる', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '一つ目' })
    const session = adapter.sessions.at(-1)!
    expect((await manager.send(thread.id, { text: '二つ目' })).kind).toBe('queued')
    expect((await manager.send(thread.id, { text: '!pwd', shell: true })).kind).toBe('queued')
    expect((await manager.send(thread.id, { text: '三つ目' })).kind).toBe('queued')
    expect(runtimeOf(thread.id).reservations.map((r) => r.preview)).toEqual(['二つ目', '!pwd', '三つ目'])
    expect(requests).toHaveLength(0)

    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await vi.waitFor(() => expect(session.sent.map((i) => i.text)).toEqual(['一つ目', '二つ目']))
    // The second message does not run while the first response is in progress (keeps the reservation order).
    expect(requests).toHaveLength(0)

    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    // `!pwd` runs, and the next reservation (the third) is sent without waiting for `result`.
    await vi.waitFor(() => expect(session.sent).toHaveLength(3))
    expect(requests.map((r) => r.command)).toEqual(['pwd'])
    expect(session.sent[2]?.text).toBe('[shell pwd => out of pwd]\n\n三つ目')
    expect(runtimeOf(thread.id).reservations).toEqual([])
  })

  it('走っている間に送った発言は予約になり、走り終えたら結果を混ぜて送る', async () => {
    const thread = await manager.createThread({})
    let release: (() => void) | undefined
    answer = (request) =>
      new Promise((resolve) => {
        release = () => resolve(ok(`slow ${request.command}`))
      })
    const running = manager.send(thread.id, { text: '!sleep 1', shell: true })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect((await manager.send(thread.id, { text: 'その後で' })).kind).toBe('queued')
    release?.()
    await running
    await vi.waitFor(() => expect(adapter.sessions.at(-1)?.sent).toHaveLength(1))
    expect(adapter.sessions.at(-1)?.sent[0]?.text).toBe('[shell sleep 1 => slow sleep 1]\n\nその後で')
  })

  it('保存は redaction を通す (コマンドも出力も)', async () => {
    const thread = await manager.createThread({})
    answer = () => ({ ...ok('key AKIAABCDEFGHIJKLMNOP here'), stderr: 'password=hunter22', status: 'exit', exitCode: 1 })
    await manager.send(thread.id, { text: '!echo AKIAABCDEFGHIJKLMNOP', shell: true })
    await settle()
    const [row] = await shellRows(thread.id)
    expect(row?.command).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(row?.stdout).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(row?.stdout).toContain('here')
    expect(row?.stderr).not.toContain('hunter22')
    expect(row).toMatchObject({ status: 'exit', exitCode: 1 })
  })

  it('本文がコマンドでなければ断る (shell の印だけでは走らせない)', async () => {
    const thread = await manager.createThread({})
    await expect(manager.send(thread.id, { text: '!', shell: true })).rejects.toThrow('aios-reason:shell-invalid')
    await expect(manager.send(thread.id, { text: 'ls', shell: true })).rejects.toThrow('aios-reason:shell-invalid')
    await expect(manager.send(thread.id, { text: '!!ls', shell: true })).rejects.toThrow('aios-reason:shell-invalid')
    expect(requests).toHaveLength(0)
  })

  it('印の無い ! は普通の発言 (勝手にシェルに渡さない)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '!ls' })
    expect(requests).toHaveLength(0)
    expect(adapter.sessions.at(-1)?.sent[0]?.text).toBe('!ls')
  })

  it('一覧に無いモデルの指定が付いていても落として走る (効かない指定を持ち越さない)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '!ls', shell: true, modelId: 'no-such-model' })
    expect(requests).toHaveLength(1)
    expect(threadOf(thread.id).modelId).toBeNull()
  })

  it('失敗 (cwd が無い) も同じ行で残り、次の発言に混ざる', async () => {
    const thread = await manager.createThread({})
    answer = () => ({ ...ok(''), status: 'no-cwd', exitCode: null })
    await manager.send(thread.id, { text: '!ls', shell: true })
    await settle()
    expect(await shellRows(thread.id)).toEqual([expect.objectContaining({ status: 'no-cwd' })])
    expect(runtimeOf(thread.id).pendingShell).toBe(1)
  })

  it('スレッドを消すと走っているシェルを止め、結果は記録しない', async () => {
    const thread = await manager.createThread({})
    let signal: AbortSignal | undefined
    answer = (request) =>
      new Promise((resolve) => {
        signal = request.signal
        request.signal?.addEventListener('abort', () => resolve({ ...ok(''), status: 'failed', errorCode: 'ABORTED' }))
      })
    const running = manager.send(thread.id, { text: '!sleep 30', shell: true })
    await vi.waitFor(() => expect(signal).toBeDefined())
    await manager.remove(thread.id)
    expect(signal?.aborted).toBe(true)
    await running
    await settle()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM thread_events WHERE kind = 'shell_run'`).get()).toEqual({ n: 0 })
  })

  it('終了処理で走っているシェルを止め、終了後は DB に書かない', async () => {
    const thread = await manager.createThread({})
    let signal: AbortSignal | undefined
    answer = (request) =>
      new Promise((resolve) => {
        signal = request.signal
        request.signal?.addEventListener('abort', () =>
          setTimeout(() => resolve({ ...ok('late'), status: 'failed', errorCode: 'ABORTED' }), 5)
        )
      })
    const running = manager.send(thread.id, { text: '!sleep 30', shell: true })
    await vi.waitFor(() => expect(signal).toBeDefined())
    await manager.stop()
    expect(signal?.aborted).toBe(true)
    await running
    await settle()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM thread_events WHERE kind = 'shell_run'`).get()).toEqual({ n: 0 })
  })

  it('結果を混ぜた発言の反射は送った文で照合し、識別子を写す (巻き戻しの鍵 — 項目 113)', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '!ls', shell: true })
    await manager.send(thread.id, { text: '見て' })
    const session = adapter.sessions.at(-1)!
    const sent = session.sent[0]!.text
    expect(sent).toBe('[shell ls => out of ls]\n\n見て')
    session.emit({ threadId: thread.id, kind: 'user_replay', payload: { messageId: 'u-1', text: sent } })
    await settle()
    const users = (await manager.timeline(thread.id)).events.flatMap((e) => (e.kind === 'user_text' ? [e.payload] : []))
    expect(users.map((p) => p.text)).toEqual(['見て'])
    expect((users[0] as { messageId?: string }).messageId).toBe('u-1')
  })

  it('スラッシュコマンドの発言には混ぜず、控えは次の普通の発言まで残す', async () => {
    const thread = await manager.createThread({})
    await manager.send(thread.id, { text: '!pwd', shell: true })
    await manager.send(thread.id, { text: '/review' })
    const session = adapter.sessions.at(-1)!
    expect(session.sent[0]?.text).toBe('/review')
    expect(runtimeOf(thread.id).pendingShell).toBe(1)
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await manager.send(thread.id, { text: 'どう?' })
    expect(session.sent.at(-1)?.text).toBe('[shell pwd => out of pwd]\n\nどう?')
    expect(runtimeOf(thread.id).pendingShell).toBe(0)
  })
})
