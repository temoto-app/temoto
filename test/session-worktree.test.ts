/**
 * TODO 633 stage 1 (wave 33 bundle A): when a conversation moves into a worktree mid-way, make the working folder follow (SessionManager side).
 *
 * `worktree_changed` is emitted from a fake Adapter (reading from the stream is in `test/adapter-worktree.test.ts`). **No CLI, model, or git is started.** The worktree paths are throwaway directories under `os.tmpdir()`. Split from `test/session-manager.test.ts` into its own harness (so parallel bundles do not touch the same file).
 *
 * What is pinned down:
 * - Entering sets `worktreeUri` / `worktreeName`, and the list pair (`cwdUri`) stays as it was. Leaving clears them
 * - The next launch (`--resume`) and `!` run in the worktree's cwd. If the worktree is gone, go back to the original cwd
 * - The worktrees this conversation created (the one it moved to, children, and launch arguments) are remembered in the cleanup table. The original cwd itself is not remembered
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent, ResultPayload, WorktreeChangedPayload } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import { workingCwdUri, type ThreadSummary } from '../src/shared/thread.js'
import { runMigrations } from '../src/common/migrations.js'
import { SessionManager } from '../src/main/session/manager.js'
import { ThreadStore } from '../src/main/session/store.js'
import type { AgentAdapter, AgentInput, AgentSession, SpawnHandlers, SpawnOptions } from '../src/main/session/types.js'
import type { ShellRunRequest } from '../src/main/session/shell-run.js'
import {
  exists as realPathExists,
  type WorktreeCleanupOutcome,
  type WorktreeCleanupTarget,
  type WorktreeCleanupVerdict,
  type WorktreeRestoreTarget,
  type WorktreeRestoreVerdict
} from '../src/main/git/worktree-cleanup.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'
import { pathToUri } from '../src/common/uri.js'
import { WORKTREES_PATH_SUFFIX } from '../src/common/exclusions.js'
import type { OutsideWritePayload } from '../src/shared/agent.js'
import { parseEventWithRaw } from '../src/main/session/adapter/parse.js'
import { WorktreeWatch } from '../src/main/session/adapter/worktree.js'
import { loadBackendPaths, loadCompatTable } from '../src/main/session/adapter/compat.js'
import { ApprovalBroker } from '../src/main/approval/broker.js'
import type { WorktreeEntry } from '../src/main/git/worktree-cleanup.js'

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
    if (!this.alive) return
    this.alive = false
    this.handlers.onExit({ code: 0, signal: null, sawResult: true, requested: true })
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

class FakeAdapter implements AgentAdapter {
  readonly id = 'fake'
  readonly label = 'Fake'
  readonly transcripts = null
  readonly sessions: FakeSession[] = []
  readonly spawned: SpawnOptions[] = []
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers) => {
    this.spawned.push(options)
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
  startsParallelRun(text: string): boolean {
    return /^\/batch(\s|$)/.test(text)
  }
  writeToolTargetPath(toolName: string, input: unknown): string | null {
    if (toolName !== 'Edit' && toolName !== 'Write') return null
    const value = (input as Record<string, unknown> | null)?.['file_path']
    return typeof value === 'string' ? value : null
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
let manager: SessionManager
let summaries: ThreadSummary[] = []
let shellRequests: ShellRunRequest[] = []
let tmp: string
let repo: string
/** The targets passed to cleanup, and the answers to return (path -> result). */
let cleanupCalls: WorktreeCleanupTarget[] = []
let cleanupAnswers: Map<string, WorktreeCleanupVerdict | WorktreeCleanupOutcome> = new Map()
/** Replacing this lets the test return the cleanup answer by hand (a race with shutdown). */
let cleanupOverride:
  | ((target: WorktreeCleanupTarget) => Promise<WorktreeCleanupVerdict | WorktreeCleanupOutcome>)
  | null = null
/** The targets passed to recreation on restore, and the answers to return (path -> result; default is restored). */
let recreateCalls: WorktreeRestoreTarget[] = []
let recreateAnswers: Map<string, WorktreeRestoreVerdict> = new Map()
/** code-review (TODO 714): replace the stat in reconcileWorktreePresence to create an async gap (a race). */
let pathExistsOverride: ((path: string) => Promise<boolean>) | null = null
/** TODO 633 stage 2: the 'worktrees git knows about' that the check of child worktrees looks at (including the main one). */
let subtaskList: WorktreeEntry[] = []

beforeEach(() => {
  subtaskList = []
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  summaries = []
  shellRequests = []
  cleanupCalls = []
  cleanupAnswers = new Map()
  cleanupOverride = null
  recreateCalls = []
  recreateAnswers = new Map()
  pathExistsOverride = null
  tmp = mkdtempSync(join(tmpdir(), 'aios-session-worktree-'))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  const home = '/Users/tester'
  const fs = {
    homePath: home,
    homeUri: `file://${home}`,
    defaultReferenceDirs: () => [],
    isReferenceable: () => true,
    assertAllowed: (uri: string) => uri.replace('file://', '')
  } as unknown as FsAccess
  const index = {
    indexConversationEvents: () => undefined,
    removeThread: () => undefined,
    removeAllConversations: () => undefined
  } as unknown as IndexClient
  const gateway = {
    socketPath: '/tmp/aios-test-wt.sock',
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
    gatewayConfigDir: '/tmp/aios-test-wt-mcp',
    cleanupWorktree: async (target) => {
      cleanupCalls.push(target)
      if (cleanupOverride !== null) return cleanupOverride(target)
      return cleanupAnswers.get(target.path) ?? 'removed'
    },
    recreateWorktree: async (target) => {
      recreateCalls.push(target)
      return recreateAnswers.get(target.path) ?? 'restored'
    },
    pathExists: (path) => (pathExistsOverride ?? realPathExists)(path),
    subtaskWorktrees: {
      listWorktrees: async () => subtaskList,
      exists: async () => true,
      hasCommits: async () => false
    },
    runShell: async (request) => {
      shellRequests.push(request)
      return { stdout: '', stderr: '', exitCode: 0, status: 'ok', truncated: false, durationMs: 1, errorCode: null }
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
  rmSync(tmp, { recursive: true, force: true })
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

function threadOf(threadId: string): ThreadSummary['thread'] {
  const found = summaries.find((s) => s.thread.id === threadId)
  if (found === undefined) throw new Error('thread not in summaries')
  return found.thread
}

function emitWorktree(session: FakeSession, threadId: string, payload: WorktreeChangedPayload): void {
  session.emit({ threadId, kind: 'worktree_changed', payload })
}

function worktreeDir(name: string): string {
  const dir = join(repo, '.wt', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('SessionManager — worktree への追従 (TODO 633 段 1)', () => {
  it('入ると worktree が載り、組は元の cwd のまま。次の起動と ! は worktree で。出ると戻る', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const worktree = worktreeDir('feature')
    emitWorktree(session, thread.id, {
      change: 'enter',
      path: worktree,
      branch: 'wt-feature',
      returnCwd: null,
      toolUseId: 't1'
    })
    expect(threadOf(thread.id).cwdUri).toBe(pathToUri(repo))
    expect(threadOf(thread.id).worktreeUri).toBe(pathToUri(worktree))
    expect(threadOf(thread.id).worktreeName).toBe('feature')
    expect(workingCwdUri(threadOf(thread.id))).toBe(pathToUri(worktree))
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()

    // Kill the process, then the next send resumes in the worktree's cwd (the transcript is in the folder for the moved-to cwd).
    await manager.stopThread(thread.id)
    await manager.send(thread.id, { text: 'again' })
    expect(adapter.spawned.at(-1)?.cwd).toBe(worktree)
    // `!` also runs in the worktree.
    const live = adapter.sessions.at(-1)!
    live.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    await manager.send(thread.id, { text: '!pwd', shell: true })
    expect(shellRequests.at(-1)?.cwd).toBe(worktree)

    emitWorktree(live, thread.id, {
      change: 'exit',
      path: worktree,
      branch: 'wt-feature',
      returnCwd: repo,
      toolUseId: 't2'
    })
    expect(threadOf(thread.id).worktreeUri).toBeUndefined()
    expect(threadOf(thread.id).worktreeName).toBeUndefined()
    // Even after leaving, the worktree itself remains, so it stays a target of cleanup.
    expect(new ThreadStore(db).threadWorktrees(thread.id).map((w) => [w.path, w.origin, w.repoCwd])).toEqual([
      [worktree, 'enter', repo]
    ])
  })

  it('worktree が消えていたら元の cwd で起こし、列も消す', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const worktree = worktreeDir('gone')
    emitWorktree(session, thread.id, { change: 'enter', path: worktree, branch: null, returnCwd: null, toolUseId: null })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    await manager.stopThread(thread.id)
    rmSync(worktree, { recursive: true, force: true })
    await manager.send(thread.id, { text: 'again' })
    expect(adapter.spawned.at(-1)?.cwd).toBe(repo)
    expect(threadOf(thread.id).worktreeUri).toBeUndefined()
  })

  it('子の worktree と起動の指定の worktree は表に覚える (作業フォルダは子では動かない)。元の cwd は覚えない', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    emitWorktree(session, thread.id, {
      change: 'child',
      path: join(repo, '.wt', 'agent-a1'),
      branch: 'wt-agent-a1',
      returnCwd: null,
      toolUseId: 'spawn-1'
    })
    expect(threadOf(thread.id).worktreeUri).toBeUndefined()
    emitWorktree(session, thread.id, {
      change: 'enter',
      path: repo,
      branch: null,
      returnCwd: null,
      toolUseId: null
    })
    expect(threadOf(thread.id).worktreeUri).toBeUndefined()
    const launch = worktreeDir('flag')
    emitWorktree(session, thread.id, {
      change: 'enter',
      path: launch,
      branch: 'wt-flag',
      returnCwd: null,
      toolUseId: null,
      atLaunch: true
    })
    const rows = new ThreadStore(db).threadWorktrees(thread.id)
    expect(rows.map((w) => [w.path, w.origin, w.branch])).toEqual([
      [join(repo, '.wt', 'agent-a1'), 'child', 'wt-agent-a1'],
      [launch, 'launch', 'wt-flag']
    ])
    // Even if the same notice arrives twice, no extra rows are added.
    emitWorktree(session, thread.id, {
      change: 'child',
      path: join(repo, '.wt', 'agent-a1'),
      branch: 'wt-agent-a1',
      returnCwd: null,
      toolUseId: 'spawn-1'
    })
    expect(new ThreadStore(db).threadWorktrees(thread.id)).toHaveLength(2)
    // Enter/leave notices do not stay on the timeline (they are not saved).
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    expect((await manager.timeline(thread.id)).events.some((e) => e.kind === 'worktree_changed')).toBe(false)
  })

  it('worktree に移った会話を分岐すると、分岐も同じ worktree で起こす (片付けの表には参照 fork で入る)', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'first' })
    const session = adapter.sessions.at(-1)!
    session.emit({
      threadId: thread.id,
      kind: 'session_started',
      payload: {
        backendSessionId: 'backend-1',
        backendVersion: null,
        model: null,
        cwd: repo,
        reportedPermissionMode: null,
        tools: [],
        toolServers: [],
        resumed: false
      }
    })
    session.emit({ threadId: thread.id, kind: 'user_replay', payload: { messageId: 'u1', text: 'first' } })
    session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: 'ok', messageId: 'a1' } })
    const worktree = worktreeDir('fork')
    emitWorktree(session, thread.id, { change: 'enter', path: worktree, branch: null, returnCwd: null, toolUseId: 't' })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    await manager.send(thread.id, { text: 'second' })
    session.emit({ threadId: thread.id, kind: 'user_replay', payload: { messageId: 'u2', text: 'second' } })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    const second = (await manager.timeline(thread.id)).events.find(
      (e) => e.kind === 'user_text' && e.payload.text === 'second'
    )!
    const fork = await manager.rewind(thread.id, second.id, { files: false })
    expect(fork.worktreeUri).toBe(pathToUri(worktree))
    // code-review fix: a branch is also added to the table as a reference. Even after the original conversation is deleted, cleanup keeps it while the branch uses it.
    expect(new ThreadStore(db).threadWorktrees(fork.id).map((w) => [w.path, w.origin, w.repoCwd])).toEqual([
      [worktree, 'fork', repo]
    ])

    // Delete the original conversation: the branch uses it, so cleanup is not called and the shared mark is left.
    await manager.remove(thread.id)
    await settle()
    expect(cleanupCalls).toEqual([])
    expect(new ThreadStore(db).threadWorktrees(thread.id).map((w) => [w.path, w.kept])).toEqual([[worktree, 'shared']])
    expect(manager.listDeletedThreads().find((d) => d.id === thread.id)?.keptWorktrees).toBe(1)

    // Delete the branch too: nobody uses it any more, so clean up on the branch's row.
    await manager.remove(fork.id)
    await settle()
    expect(cleanupCalls.map((c) => c.path)).toEqual([worktree])
  })

  it('TODO 992 の 1: worktree に移った会話を引き継ぐと、新しい会話も同じ worktree で始める (参照 fork で表に入る)', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo), title: 'T' })
    await manager.send(thread.id, { text: 'first' })
    const session = adapter.sessions.at(-1)!
    session.emit({
      threadId: thread.id,
      kind: 'session_started',
      payload: { backendSessionId: 'backend-h', backendVersion: null, model: null, cwd: repo, reportedPermissionMode: null, tools: [], toolServers: [], resumed: false }
    })
    session.emit({ threadId: thread.id, kind: 'assistant_text', payload: { text: 'ok' } })
    const worktree = worktreeDir('handoff')
    emitWorktree(session, thread.id, { change: 'enter', path: worktree, branch: null, returnCwd: null, toolUseId: 't' })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()

    const created = await manager.handoff(thread.id)
    expect(created.worktreeUri).toBe(pathToUri(worktree))
    expect(created.cwdUri).toBe(thread.cwdUri)
    expect(new ThreadStore(db).threadWorktrees(created.id).map((w) => [w.path, w.origin, w.repoCwd])).toEqual([
      [worktree, 'fork', repo]
    ])
    // The first launch is in the worktree, and does not inherit the original conversation.
    await manager.send(created.id, { text: 'go' })
    const options = adapter.spawned.at(-1)
    expect(options?.threadId).toBe(created.id)
    expect(options?.cwd).toBe(worktree)
    expect(options?.resumeBackendSessionId).toBeNull()
  })

  it('2 つの会話が同じ既存の worktree に入ったら、片方を消してももう片方が使っている間は残す', async () => {
    const a = await manager.createThread({ cwdUri: pathToUri(repo) })
    const b = await manager.createThread({ cwdUri: pathToUri(repo) })
    const shared = worktreeDir('shared')
    for (const thread of [a, b]) {
      await manager.send(thread.id, { text: 'go' })
      const session = adapter.sessions.at(-1)!
      emitWorktree(session, thread.id, { change: 'enter', path: shared, branch: 'wb', returnCwd: null, toolUseId: 't' })
      session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    }
    await settle()
    await manager.remove(a.id)
    await settle()
    expect(cleanupCalls).toEqual([])
    // Even when b returns to the original cwd, keep it: the row in the cleanup table (still alive) references it.
    const session = adapter.sessions.at(-1)!
    emitWorktree(session, b.id, { change: 'exit', path: shared, branch: 'wb', returnCwd: repo, toolUseId: 'x' })
    await settle()
    await manager.remove(b.id)
    await settle()
    expect(cleanupCalls.map((c) => c.path)).toEqual([shared])
  })
})

// code-review fix (TODO 633, owner decision 2026-10-11): logical deletion can be undone by restore, so recreate the cleaned-up worktree at the same path with the same branch name. If it cannot be recreated, return to the original cwd and mark the list row.
describe('SessionManager — 復元で片付けた worktree を作り直す (TODO 633)', () => {
  async function enteredThread(name: string): Promise<{ id: string; worktree: string }> {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const worktree = worktreeDir(name)
    emitWorktree(session, thread.id, {
      change: 'enter',
      path: worktree,
      branch: `worktree-${name}`,
      returnCwd: null,
      toolUseId: 't'
    })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    return { id: thread.id, worktree }
  }

  it('片付けで消したら HEAD を覚え、復元で同じパス・ブランチ・HEAD で作り直す。作業フォルダは worktree のまま', async () => {
    const { id, worktree } = await enteredThread('restore-ok')
    cleanupAnswers.set(worktree, { verdict: 'removed', head: 'abc1234', branch: 'worktree-restore-ok' })
    await manager.remove(id)
    await settle()
    const store = new ThreadStore(db)
    expect(store.threadWorktrees(id).map((w) => [w.path, w.removedHead, w.kept])).toEqual([[worktree, 'abc1234', null]])
    // A deleted worktree is not counted as 'kept' in the deleted list.
    expect(manager.listDeletedThreads().find((d) => d.id === id)?.keptWorktrees).toBeUndefined()

    const restored = await manager.restore(id)
    expect(recreateCalls).toEqual([{ path: worktree, branch: 'worktree-restore-ok', head: 'abc1234', repoCwd: repo }])
    expect(restored?.worktreeUri).toBe(pathToUri(worktree))
    expect(restored?.worktreeLostName).toBeUndefined()
    expect(store.threadWorktrees(id).map((w) => [w.path, w.removedHead])).toEqual([[worktree, null]])

    // Delete again: check the recreated worktree again.
    cleanupCalls = []
    await manager.remove(id)
    await settle()
    expect(cleanupCalls.map((c) => c.path)).toEqual([worktree])
  })

  it('作り直せなければ表から外し、元の cwd に戻して一覧の行に印 (ダイアログなし)。次に worktree に入れば印は消える', async () => {
    const { id, worktree } = await enteredThread('restore-ng')
    cleanupAnswers.set(worktree, { verdict: 'removed', head: 'abc1234', branch: 'worktree-restore-ng' })
    recreateAnswers.set(worktree, 'failed')
    await manager.remove(id)
    await settle()
    const restored = await manager.restore(id)
    expect(restored?.worktreeUri).toBeUndefined()
    expect(restored?.worktreeLostName).toBe('restore-ng')
    expect(threadOf(id).worktreeLostName).toBe('restore-ng')
    expect(new ThreadStore(db).threadWorktrees(id)).toEqual([])

    await manager.send(id, { text: 'again' })
    const session = adapter.sessions.at(-1)!
    const next = worktreeDir('next')
    emitWorktree(session, id, { change: 'enter', path: next, branch: null, returnCwd: null, toolUseId: 'n' })
    await settle()
    expect(threadOf(id).worktreeLostName).toBeUndefined()
  })

  it('片付けの途中で復元したら、片付けが終わるのを待ってから作り直す', async () => {
    const { id, worktree } = await enteredThread('restore-race')
    let release: (outcome: WorktreeCleanupOutcome) => void = () => undefined
    cleanupOverride = () =>
      new Promise<WorktreeCleanupOutcome>((resolve) => {
        release = resolve
      })
    await manager.remove(id)
    const restoring = manager.restore(id)
    await settle()
    expect(recreateCalls).toEqual([])
    release({ verdict: 'removed', head: 'def5678', branch: 'worktree-restore-race' })
    const restored = await restoring
    expect(recreateCalls.map((c) => [c.path, c.head])).toEqual([[worktree, 'def5678']])
    expect(restored?.worktreeUri).toBe(pathToUri(worktree))
  })

  it('HEAD の分からない removed (古い答え) は従来どおり表から外し、復元では作り直さない', async () => {
    const { id } = await enteredThread('restore-legacy')
    await manager.remove(id)
    await settle()
    expect(new ThreadStore(db).threadWorktrees(id)).toEqual([])
    await manager.restore(id)
    expect(recreateCalls).toEqual([])
  })
})

describe('SessionManager — 会話を消すときの worktree の片付け (TODO 633 段 1)', () => {
  it('その会話が作った worktree だけを調べ、消せたものは表から外し、残したものは削除済みの一覧の印になる', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    const other = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const entered = worktreeDir('entered')
    const child = join(repo, '.wt', 'agent-a1')
    emitWorktree(session, thread.id, { change: 'enter', path: entered, branch: 'b1', returnCwd: null, toolUseId: 't' })
    emitWorktree(session, thread.id, { change: 'child', path: child, branch: 'b2', returnCwd: null, toolUseId: 's' })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    cleanupAnswers.set(child, 'unpushed')

    const result = await manager.remove(thread.id)
    expect(result.removed).toBe(true)
    await settle()
    expect(cleanupCalls.map((c) => [c.path, c.branch, c.repoCwd])).toEqual([
      [entered, 'b1', repo],
      [child, 'b2', repo]
    ])
    const store = new ThreadStore(db)
    expect(store.threadWorktrees(thread.id).map((w) => [w.path, w.kept])).toEqual([[child, 'unpushed']])
    expect(manager.listDeletedThreads().find((d) => d.id === thread.id)?.keptWorktrees).toBe(1)

    // Do not touch other conversations: deleting a conversation that created no worktree does not call cleanup.
    cleanupCalls = []
    await manager.remove(other.id)
    await settle()
    expect(cleanupCalls).toEqual([])
    expect(manager.listDeletedThreads().find((d) => d.id === other.id)?.keptWorktrees).toBeUndefined()
  })

  it('終了処理の後に片付けが返っても DB に書かない (12.9)', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const entered = worktreeDir('late')
    emitWorktree(session, thread.id, { change: 'enter', path: entered, branch: null, returnCwd: null, toolUseId: 't' })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    let release: (verdict: WorktreeCleanupVerdict) => void = () => undefined
    cleanupOverride = () =>
      new Promise<WorktreeCleanupVerdict>((resolve) => {
        release = resolve
      })
    await manager.remove(thread.id)
    await manager.stop()
    const store = new ThreadStore(db)
    const mark = vi.spyOn(ThreadStore.prototype, 'markThreadWorktreeKept')
    release('changes')
    await settle()
    expect(mark).not.toHaveBeenCalled()
    mark.mockRestore()
    expect(store.threadWorktrees(thread.id).map((w) => w.kept)).toEqual([null])
  })
})

describe('SessionManager — aios の外で消された worktree に起動時に気付く (TODO 714)', () => {
  it('生きている会話の worktree_cwd が実在しなければ元の cwd に戻す', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const worktree = worktreeDir('vanished')
    emitWorktree(session, thread.id, { change: 'enter', path: worktree, branch: 'b1', returnCwd: null, toolUseId: 't' })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    expect(threadOf(thread.id).worktreeUri).toBe(pathToUri(worktree))

    // The user ran `git worktree remove` outside (in a terminal, etc.). aios does not know about it.
    rmSync(worktree, { recursive: true, force: true })

    await manager.start()
    await manager.waitForWorktreeReconcile()
    expect(threadOf(thread.id).worktreeUri).toBeUndefined()
    expect(threadOf(thread.id).cwdUri).toBe(pathToUri(repo))
  })

  it('削除済みの一覧の「残した」worktree が実在しなければ表から外す (⎇ N が消える)', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const entered = worktreeDir('kept-then-gone')
    emitWorktree(session, thread.id, { change: 'enter', path: entered, branch: 'b1', returnCwd: null, toolUseId: 't' })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    cleanupAnswers.set(entered, 'changes')
    await manager.remove(thread.id)
    await settle()
    expect(manager.listDeletedThreads().find((d) => d.id === thread.id)?.keptWorktrees).toBe(1)

    // The user deleted it outside.
    rmSync(entered, { recursive: true, force: true })

    await manager.start()
    await manager.waitForWorktreeReconcile()
    expect(manager.listDeletedThreads().find((d) => d.id === thread.id)?.keptWorktrees).toBeUndefined()
    expect(new ThreadStore(db).threadWorktrees(thread.id)).toEqual([])
  })

  it('実在するものには触らない', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const worktree = worktreeDir('still-here')
    emitWorktree(session, thread.id, { change: 'enter', path: worktree, branch: 'b1', returnCwd: null, toolUseId: 't' })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()

    await manager.start()
    await manager.waitForWorktreeReconcile()
    expect(threadOf(thread.id).worktreeUri).toBe(pathToUri(worktree))
  })

  // code-review (TODO 714): the copy from `listThreads()` can go stale during the stat. After moving to another worktree, a `setWorktreeCwd(null)` aimed at the first, deleted worktree must not interrupt and erase the record of the new worktree.
  it('stat している間に別の worktree へ移った会話の worktree_cwd は消さない (race)', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const worktreeA = worktreeDir('race-a')
    emitWorktree(session, thread.id, { change: 'enter', path: worktreeA, branch: 'b1', returnCwd: null, toolUseId: 't' })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    expect(threadOf(thread.id).worktreeUri).toBe(pathToUri(worktreeA))
    // worktreeA is the one deleted outside.
    rmSync(worktreeA, { recursive: true, force: true })

    let releaseStat: (() => void) | null = null
    pathExistsOverride = (path) => {
      if (path !== worktreeA) return Promise.resolve(true)
      return new Promise((resolve) => {
        releaseStat = () => resolve(false)
      })
    }

    await manager.start()
    await vi.waitFor(() => expect(releaseStat).not.toBeNull())
    // While the stat is still blocked, the same conversation moved to another worktree (worktreeB).
    const worktreeB = worktreeDir('race-b')
    emitWorktree(session, thread.id, { change: 'enter', path: worktreeB, branch: 'b2', returnCwd: null, toolUseId: 't2' })
    expect(threadOf(thread.id).worktreeUri).toBe(pathToUri(worktreeB))
    // Release the stat of worktreeA now (the stale answer 'it was gone').
    releaseStat!()
    await manager.waitForWorktreeReconcile()
    // Check that it did not interrupt and erase worktreeB's record.
    expect(threadOf(thread.id).worktreeUri).toBe(pathToUri(worktreeB))
  })
})

describe('SessionManager — worktree で分けた回の、本体の作業コピーへの書き込みの印 (TODO 700)', () => {
  /** The location is built from the real suffix (from compat): the check looks at `WORKTREES_PATH_SUFFIX`. */
  const place = (name: string): string => join(repo, ...WORKTREES_PATH_SUFFIX.split('/').filter(Boolean), name)

  async function marks(threadId: string): Promise<OutsideWritePayload[]> {
    return (await manager.timeline(threadId)).events.flatMap((e) => (e.kind === 'outside_write' ? [e.payload] : []))
  }

  function write(
    session: FakeSession,
    threadId: string,
    id: string,
    filePath: string,
    ok: boolean,
    parentToolUseId?: string
  ): void {
    const actor = parentToolUseId === undefined ? 'main' : 'subagent'
    const parent = parentToolUseId === undefined ? {} : { parentToolUseId }
    session.emit({
      threadId,
      kind: 'tool_use',
      actor,
      ...parent,
      payload: { toolUseId: id, name: 'Edit', summary: filePath, input: { file_path: filePath }, truncated: false }
    })
    session.emit({ threadId, kind: 'tool_result', actor, ...parent, payload: { toolUseId: id, ok, bytes: 1 } })
  }

  it('/batch の回に親が本体を書き換えたら、一覧とタイムラインに印。ふつうの回・本体の外・失敗は印にしない', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'plain edit' })
    const session = adapter.sessions.at(-1)!
    // code-review fix: an ordinary turn does not look up the targets of writes (it does not even read the rows; the tracker's shortcut).
    const targetPath = vi.spyOn(adapter, 'writeToolTargetPath')
    write(session, thread.id, 'w0', join(repo, 'a.txt'), true)
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    expect(threadOf(thread.id).outsideWriteAt).toBeUndefined()
    expect(targetPath).not.toHaveBeenCalled()
    targetPath.mockRestore()

    await manager.send(thread.id, { text: '/batch split the work' })
    write(session, thread.id, 'w1', join(tmp, 'elsewhere.txt'), true)
    write(session, thread.id, 'w2', join(repo, 'b.txt'), false)
    write(session, thread.id, 'w3', join(repo, 'c.txt'), true)
    write(session, thread.id, 'w4', join(place('agent-x'), 'c.txt'), true)
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    expect(await marks(thread.id)).toEqual([{ toolUseId: 'w3', path: join(repo, 'c.txt'), scope: 'parallel' }])
    expect(threadOf(thread.id).outsideWriteAt).toBeTypeOf('number')
  })

  // TODO 709 (owner decision 2026-10-11): ⚠ (`outsideWriteAt`) is cleared when the conversation is opened (same as unread). The `outside_write` row on the timeline stays.
  it('一覧の ⚠ は会話を開いたら消える。タイムラインの行は残る', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: '/batch split the work' })
    const session = adapter.sessions.at(-1)!
    write(session, thread.id, 'w1', join(repo, 'a.txt'), true)
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    expect(threadOf(thread.id).outsideWriteAt).toBeTypeOf('number')

    manager.openThread(thread.id, 1)
    expect(threadOf(thread.id).outsideWriteAt).toBeUndefined()
    expect(await marks(thread.id)).toEqual([{ toolUseId: 'w1', path: join(repo, 'a.txt'), scope: 'parallel' }])

    // Opening it again (the mark is already gone) breaks nothing.
    manager.openThread(thread.id, 1)
    expect(threadOf(thread.id).outsideWriteAt).toBeUndefined()
  })

  // code-review (TODO 709): while the conversation is being viewed in the front window, do not raise ⚠ (the same test as unread). Clearing only on open kept it coming back and never clearing while the user kept watching new writes.
  it('前面の窓で見ている間に新しい書き込みが来ても ⚠ は付かない。タイムラインの行は残る', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: '/batch split the work' })
    const session = adapter.sessions.at(-1)!
    // This conversation is being viewed in the front window (viewId 1).
    manager.openThread(thread.id, 1)
    write(session, thread.id, 'w1', join(repo, 'a.txt'), true)
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    // Writes while viewing do not raise ⚠.
    expect(threadOf(thread.id).outsideWriteAt).toBeUndefined()
    // Timeline rows stay either way (they are a record of what happened).
    expect(await marks(thread.id)).toEqual([{ toolUseId: 'w1', path: join(repo, 'a.txt'), scope: 'parallel' }])

    // Writes after no longer viewing (the window was closed) raise ⚠ as before.
    manager.closeView(1)
    await manager.send(thread.id, { text: '/batch split more work' })
    write(session, thread.id, 'w2', join(repo, 'b.txt'), true)
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    expect(threadOf(thread.id).outsideWriteAt).toBeTypeOf('number')
  })

  it('worktree で走る子が本体を書き換えたら subtask。子の worktree の中は印にしない', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'run a child' })
    const session = adapter.sessions.at(-1)!
    emitWorktree(session, thread.id, {
      change: 'child',
      path: place('agent-c1'),
      branch: 'worktree-agent-c1',
      returnCwd: null,
      toolUseId: 'spawn-1'
    })
    write(session, thread.id, 'c1', join(place('agent-c1'), 'a.txt'), true, 'spawn-1')
    write(session, thread.id, 'c2', 'a.txt', true, 'spawn-1')
    write(session, thread.id, 'c3', join(repo, 'a.txt'), true, 'spawn-1')
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    expect(await marks(thread.id)).toEqual([{ toolUseId: 'c3', path: join(repo, 'a.txt'), scope: 'subtask' }])
  })

  // code-review fix: for a foreground isolated child, the result of the call that started it (= `child`) arrives after the child ends.
  it('前景の isolated の子 (child_start の後、child の前) が本体を書き換えても subtask。置き場の中・失敗は印にしない', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'run a foreground child' })
    const session = adapter.sessions.at(-1)!
    emitWorktree(session, thread.id, {
      change: 'child_start',
      path: repo,
      branch: null,
      returnCwd: null,
      toolUseId: 'spawn-f'
    })
    write(session, thread.id, 'f1', join(place('agent-f'), 'a.txt'), true, 'spawn-f')
    write(session, thread.id, 'f2', join(repo, 'a.txt'), false, 'spawn-f')
    write(session, thread.id, 'f3', join(repo, 'b.txt'), true, 'spawn-f')
    // The child ends: the result of the call that started it, and the child's worktree assembled from it.
    session.emit({ threadId: thread.id, kind: 'tool_result', payload: { toolUseId: 'spawn-f', ok: true, bytes: 1 } })
    emitWorktree(session, thread.id, {
      change: 'child',
      path: place('agent-f'),
      branch: 'worktree-agent-f',
      returnCwd: null,
      toolUseId: 'spawn-f'
    })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    expect(await marks(thread.id)).toEqual([{ toolUseId: 'f3', path: join(repo, 'b.txt'), scope: 'subtask' }])
    // child_start is not put into the cleanup table (only the child's row).
    expect(new ThreadStore(db).threadWorktrees(thread.id).map((w) => w.origin)).toEqual(['child'])
  })

  it('会話が worktree に移っているのに本体を書き換えたら worktree。相対パスは worktree で解く', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const worktree = place('moved')
    mkdirSync(worktree, { recursive: true })
    emitWorktree(session, thread.id, { change: 'enter', path: worktree, branch: null, returnCwd: null, toolUseId: 't' })
    write(session, thread.id, 'm1', 'a.txt', true)
    write(session, thread.id, 'm2', join(repo, 'a.txt'), true)
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    expect(await marks(thread.id)).toEqual([{ toolUseId: 'm2', path: join(repo, 'a.txt'), scope: 'worktree' }])
  })

  it('spike 30 の /batch (手順どおりの回): 子が本体へ書こうとして CLI に断られた Edit は印にならず、子の worktree は 2 つ覚える', async () => {
    const spikeRepo = '/tmp/aios-spike-repo'
    const thread = await manager.createThread({ cwdUri: pathToUri(spikeRepo) })
    await manager.send(thread.id, { text: '/batch append a line to a.txt and b.txt' })
    const session = adapter.sessions.at(-1)!
    const watch = new WorktreeWatch(spikeRepo, loadCompatTable(), loadBackendPaths().worktreesPathSuffix ?? null)
    let n = 0
    const ctx = {
      sessionId: session.sessionId,
      threadId: thread.id,
      now: () => Date.now(),
      newId: () => `fx${(n += 1)}`
    }
    for (const line of readFileSync(new URL('./fixtures/stream-worktree-batch.jsonl', import.meta.url), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const parsed = parseEventWithRaw(line, ctx)
      const events = parsed.raw === null ? parsed.events : watch.observe(parsed.raw, parsed.events, ctx)
      for (const event of events) session.handlers.onEvent(event)
    }
    await settle()
    expect(await marks(thread.id)).toEqual([])
    expect(new ThreadStore(db).threadWorktrees(thread.id).map((w) => [w.origin, w.branch])).toEqual([
      ['child', 'worktree-agent-a0000000000000001'],
      ['child', 'worktree-agent-a0000000000000002']
    ])
  })
})

// code-review fix (TODO 633): gateway openFile / closeFile, draft conflicts, and the approval cwd are resolved in the working folder the CLI runs in (the worktree, if it has moved there). Previously they stayed at `thread.cwdUri` (the original cwd).
describe('SessionManager — gateway の相対パスは会話の作業フォルダで解く (TODO 633)', () => {
  it('worktree に移った会話の openFile の相対パスは worktree で、承認の cwd も worktree', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const worktree = worktreeDir('gw')
    writeFileSync(join(worktree, 'only-here.ts'), 'x\n')
    emitWorktree(session, thread.id, { change: 'enter', path: worktree, branch: null, returnCwd: null, toolUseId: 't' })
    await settle()
    const opened = await manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'openFile',
      payload: { path: 'only-here.ts' }
    })
    expect(opened).toMatchObject({ opened: true, path: join(worktree, 'only-here.ts') })

    const request = vi.spyOn(ApprovalBroker.prototype, 'request')
    void manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Write', toolUseId: 'ap1', input: { file_path: 'x.txt' } }
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    expect(request.mock.calls[0]?.[0]).toMatchObject({ cwd: worktree })
    request.mockRestore()
  })
})

// TODO 748 (b): cleanup runs inside `remove` without waiting, and shutdown does not wait for it. Rows whose result could not be written because shutdown overlapped (both `kept` and `removed_head` NULL) are re-run in the next launch's review. For a worktree that git had already finished removing (gone), HEAD is unknown, so restore does not recreate it; it gets the same mark as `worktree_lost`.
describe('SessionManager — 終了処理と重なった片付けを次の起動で流し直す (TODO 748 (b))', () => {
  async function enteredThread(name: string): Promise<{ id: string; worktree: string }> {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    const worktree = worktreeDir(name)
    emitWorktree(session, thread.id, {
      change: 'enter',
      path: worktree,
      branch: `worktree-${name}`,
      returnCwd: null,
      toolUseId: 't'
    })
    session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    await settle()
    return { id: thread.id, worktree }
  }

  /** The shape where the previous launch had written logical deletion but ended before the cleanup result was written (the row's `kept` / `removed_head` are NULL). */
  function deletedWithoutCleanup(id: string): void {
    new ThreadStore(db).removeThread(id)
  }

  it('まだ始めていなかった片付けを流し直し、消せたら作り直しの材料を書く (復元で作り直せる)', async () => {
    const { id, worktree } = await enteredThread('retry-removed')
    deletedWithoutCleanup(id)
    cleanupAnswers.set(worktree, { verdict: 'removed', head: 'abc1234', branch: 'worktree-retry-removed' })

    await manager.start()
    await manager.waitForWorktreeReconcile()
    expect(cleanupCalls.map((c) => c.path)).toEqual([worktree])
    const store = new ThreadStore(db)
    expect(store.threadWorktrees(id).map((w) => [w.removedHead, w.kept])).toEqual([['abc1234', null]])

    const restored = await manager.restore(id)
    expect(recreateCalls.map((c) => [c.path, c.head])).toEqual([[worktree, 'abc1234']])
    expect(restored?.worktreeUri).toBe(pathToUri(worktree))
  })

  it('git が消し終えていた (gone) 分は表に「HEAD 不明」を残し、復元で作り直さず worktree_lost の印', async () => {
    const { id, worktree } = await enteredThread('retry-gone')
    deletedWithoutCleanup(id)
    cleanupAnswers.set(worktree, 'gone')

    await manager.start()
    await manager.waitForWorktreeReconcile()
    expect(new ThreadStore(db).threadWorktrees(id).map((w) => [w.removedHead, w.kept])).toEqual([['', null]])
    // Not counted as 'kept' in the deleted list.
    expect(manager.listDeletedThreads().find((d) => d.id === id)?.keptWorktrees).toBeUndefined()

    const restored = await manager.restore(id)
    expect(recreateCalls).toEqual([])
    expect(restored?.worktreeUri).toBeUndefined()
    expect(restored?.worktreeLostName).toBe('retry-gone')
    expect(new ThreadStore(db).threadWorktrees(id)).toEqual([])
  })

  it('結果を書いた行 (残した) と生きている会話には触らない', async () => {
    const kept = await enteredThread('retry-kept')
    cleanupAnswers.set(kept.worktree, 'changes')
    await manager.remove(kept.id)
    await settle()
    const live = await enteredThread('retry-live')
    cleanupCalls = []

    await manager.start()
    await manager.waitForWorktreeReconcile()
    expect(cleanupCalls).toEqual([])
    expect(new ThreadStore(db).threadWorktrees(kept.id).map((w) => w.kept)).toEqual(['changes'])
    expect(threadOf(live.id).worktreeUri).toBe(pathToUri(live.worktree))
  })

  it('流し直しの途中で復元したら、片付けが終わるのを待ってから作り直す', async () => {
    const { id, worktree } = await enteredThread('retry-race')
    deletedWithoutCleanup(id)
    let release: (outcome: WorktreeCleanupOutcome) => void = () => undefined
    cleanupOverride = () =>
      new Promise<WorktreeCleanupOutcome>((resolve) => {
        release = resolve
      })
    await manager.start()
    await vi.waitFor(() => expect(cleanupCalls.length).toBe(1))
    const restoring = manager.restore(id)
    await settle()
    expect(recreateCalls).toEqual([])
    release({ verdict: 'removed', head: 'def5678', branch: 'worktree-retry-race' })
    const restored = await restoring
    expect(recreateCalls.map((c) => [c.path, c.head])).toEqual([[worktree, 'def5678']])
    expect(restored?.worktreeUri).toBe(pathToUri(worktree))
  })
})

// TODO 748 (c): when A is deleted and branch B uses the same worktree, A's row stays as `shared`. Later, deleting B and the worktree is gone, copy the fact that it was removed, and the material for recreating it, onto A's row too (so A can be recreated even after it is restored).
describe('SessionManager — shared で残した行に、他の会話の片付けの結果を写す (TODO 748 (c))', () => {
  async function twoInShared(name: string): Promise<{ a: string; b: string; shared: string }> {
    const a = await manager.createThread({ cwdUri: pathToUri(repo) })
    const b = await manager.createThread({ cwdUri: pathToUri(repo) })
    const shared = worktreeDir(name)
    for (const thread of [a, b]) {
      await manager.send(thread.id, { text: 'go' })
      const session = adapter.sessions.at(-1)!
      emitWorktree(session, thread.id, { change: 'enter', path: shared, branch: 'wb', returnCwd: null, toolUseId: 't' })
      session.emit({ threadId: thread.id, kind: 'result', payload: RESULT })
    }
    await settle()
    await manager.remove(a.id)
    await settle()
    expect(new ThreadStore(db).threadWorktrees(a.id).map((w) => w.kept)).toEqual(['shared'])
    expect(manager.listDeletedThreads().find((d) => d.id === a.id)?.keptWorktrees).toBe(1)
    return { a: a.id, b: b.id, shared }
  }

  it('B の片付けで消えたら A の行にも HEAD とブランチを写し、A を復元すると作り直す', async () => {
    const { a, b, shared } = await twoInShared('shared-removed')
    cleanupAnswers.set(shared, { verdict: 'removed', head: 'abc1234', branch: 'wb' })
    await manager.remove(b)
    await settle()
    const store = new ThreadStore(db)
    expect(store.threadWorktrees(a).map((w) => [w.removedHead, w.kept, w.branch])).toEqual([['abc1234', null, 'wb']])
    expect(manager.listDeletedThreads().find((d) => d.id === a)?.keptWorktrees).toBeUndefined()

    const restored = await manager.restore(a)
    expect(recreateCalls).toEqual([{ path: shared, branch: 'wb', head: 'abc1234', repoCwd: repo }])
    expect(restored?.worktreeUri).toBe(pathToUri(shared))
    expect(restored?.worktreeLostName).toBeUndefined()

    // Even if B is restored later, ask for recreation at the same path (the real one answers 'already exists' via git, and so is restored).
    await manager.restore(b)
    expect(recreateCalls.map((c) => c.path)).toEqual([shared, shared])
  })

  it('B の片付けで既に無かった (gone) なら、A の行は「HEAD 不明」— A の復元は worktree_lost の印', async () => {
    const { a, b, shared } = await twoInShared('shared-gone')
    cleanupAnswers.set(shared, 'gone')
    await manager.remove(b)
    await settle()
    expect(new ThreadStore(db).threadWorktrees(a).map((w) => [w.removedHead, w.kept])).toEqual([['', null]])
    const restored = await manager.restore(a)
    expect(recreateCalls).toEqual([])
    expect(restored?.worktreeLostName).toBe('shared-gone')
  })

  it('B が残したら (changes) A の行は shared のまま', async () => {
    const { a, b, shared } = await twoInShared('shared-kept')
    cleanupAnswers.set(shared, 'changes')
    await manager.remove(b)
    await settle()
    expect(new ThreadStore(db).threadWorktrees(a).map((w) => [w.removedHead, w.kept])).toEqual([[null, 'shared']])
  })

  it('この直しより前に残った shared の行 (worktree は既に無い) は、起動時に「HEAD 不明」にする', async () => {
    const { a, b, shared } = await twoInShared('shared-legacy')
    // Before the fix: B's cleanup removed the worktree, but wrote nothing to A's row.
    const store = new ThreadStore(db)
    store.removeThread(b)
    store.forgetThreadWorktree(b, shared)
    rmSync(shared, { recursive: true, force: true })

    await manager.start()
    await manager.waitForWorktreeReconcile()
    expect(store.threadWorktrees(a).map((w) => [w.removedHead, w.kept])).toEqual([['', null]])
    const restored = await manager.restore(a)
    expect(restored?.worktreeLostName).toBe('shared-legacy')
  })
})

describe('SessionManager — 子の worktree の表示 (TODO 633 段 2、推し量り)', () => {
  const childPath = (id: string): string => join(repo, ...WORKTREES_PATH_SUFFIX.split('/').filter(Boolean), `agent-${id}`)
  const child = (id: string): WorktreeChangedPayload => ({
    change: 'child',
    path: childPath(id),
    branch: `worktree-agent-${id}`,
    returnCwd: null,
    toolUseId: `tu-${id}`
  })
  const lastRuntime = (threadId: string): ThreadSummary['runtime'] =>
    summaries.find((s) => s.thread.id === threadId)!.runtime

  it('git が知っている子だけ runtime に載り、commit の知らせで committed になる', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    subtaskList = [
      { path: repo, head: 'h', branch: 'main', locked: null, main: true },
      { path: childPath('a1'), head: 'h', branch: 'worktree-agent-a1', locked: null, main: false }
    ]
    emitWorktree(session, thread.id, child('a1'))
    emitWorktree(session, thread.id, child('a2'))
    await settle()
    expect(lastRuntime(thread.id).subagentWorktrees).toEqual({
      'tu-a1': { branch: 'worktree-agent-a1', uri: pathToUri(childPath('a1')), committed: false }
    })
    session.emit({
      threadId: thread.id,
      kind: 'vcs_state_changed',
      payload: { change: 'commit', branch: 'worktree-agent-a1', elsewhere: true }
    })
    await settle()
    expect(lastRuntime(thread.id).subagentWorktrees?.['tu-a1']?.committed).toBe(true)
  })

  it('子の worktree が git に無ければ欄ごと省く', async () => {
    const thread = await manager.createThread({ cwdUri: pathToUri(repo) })
    await manager.send(thread.id, { text: 'go' })
    const session = adapter.sessions.at(-1)!
    emitWorktree(session, thread.id, child('b1'))
    await settle()
    expect(lastRuntime(thread.id).subagentWorktrees).toBeUndefined()
  })
})
