/**
 * The record of MCP server reports on the global side (item 164, wave 13 bundle J, ARCHITECTURE.md 4.6.4 "how it is shown").
 *
 * With a fake Adapter (copied from the minimal harness of `session-plan.test.ts`), **neither the CLI nor the model is started**.
 * The DB is the real SQLite code (in memory). What is pinned:
 * - Each time `session_started` is received, only the global rows are written to `mcp.lastGlobalReport` (folder-side rows, unknown-kind rows and gateway rows are not written). Whichever thread's report it is, it overwrites the same single key.
 * - A report without `mcpServers` (the old shape) does not rewrite it.
 * - After writing, it notifies with `onMcpReportChanged`. The record remains in the DB (a SessionManager created anew can still read it).
 * - If there is no report at all, null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type {
  AgentStatus,
  AiosEvent,
  McpGlobalReport,
  McpServerReport,
  ThinkingLevel
} from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { MCP_LAST_GLOBAL_REPORT } from '../src/common/settings-keys.js'
import { SessionManager, type SessionManagerDeps } from '../src/main/session/manager.js'
import { globalServersOf } from '../src/main/session/mcp-report.js'
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
  abort(): void {}
  async stop(): Promise<void> {
    if (!this.alive) return
    this.alive = false
    this.handlers.onExit({ code: 0, signal: null, sawResult: true, requested: true })
  }
  async switchSettings(target: { modelId: string | null; thinking: ThinkingLevel | null }): Promise<boolean> {
    return target.modelId === null && target.thinking === null
  }
  emit(event: Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'>, ts = Date.now()): void {
    this.handlers.onEvent({
      id: `${this.sessionId}:${Math.random()}`,
      sessionId: this.sessionId,
      ts,
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
}

let db: Db
let adapter: FakeAdapter
let manager: SessionManager
let dir: string
let pushed: McpGlobalReport[] = []

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
      onEvents: () => undefined,
      onThreadsChanged: () => undefined,
      onThreadChanged: () => undefined,
      onApprovalsChanged: () => undefined,
      onAgentStatus: () => undefined,
      onMcpReportChanged: (report) => {
        pushed.push(report)
      }
    }
  }
  return new SessionManager(deps)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-mcp-report-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  pushed = []
  manager = build()
})

afterEach(async () => {
  await manager.stop()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const report = (patch: Partial<McpServerReport>): McpServerReport => ({
  name: 'x',
  state: 'connected',
  source: null,
  gateway: false,
  scope: 'unknown',
  ...patch
})

const SERVERS: readonly McpServerReport[] = [
  report({ name: 'aios', source: 'dynamic', gateway: true }),
  report({ name: 'Docs', source: 'claudeai', scope: 'global' }),
  report({ name: 'Gmail', state: 'needs-auth', source: 'claudeai', scope: 'global' }),
  report({ name: 'mine', state: 'failed', source: 'user', scope: 'global' }),
  report({ name: 'probe', source: 'project', scope: 'folder' }),
  report({ name: 'odd', source: 'agent', scope: 'unknown' })
]

/** Creates a thread, sends once, and passes the report of the launch. */
async function started(servers: readonly McpServerReport[] | undefined, ts: number): Promise<void> {
  const thread = await manager.createThread({})
  await manager.send(thread.id, { text: 'hi' })
  const session = adapter.sessions.at(-1)
  if (session === undefined) throw new Error('no session')
  session.emit(
    {
      threadId: thread.id,
      kind: 'session_started',
      payload: {
        backendSessionId: `b-${Math.random()}`,
        backendVersion: '0.0.0',
        model: null,
        cwd: null,
        reportedPermissionMode: null,
        tools: [],
        toolServers: [],
        resumed: false,
        ...(servers === undefined ? {} : { mcpServers: servers })
      }
    } as unknown as Omit<AiosEvent, 'id' | 'sessionId' | 'ts' | 'actor'>,
    ts
  )
}

describe('globalServersOf (項目 164)', () => {
  it('全体側だけを名前・状態・出所で取り出し、gateway・フォルダ側・区分不明は落とす', () => {
    expect(globalServersOf(SERVERS)).toEqual([
      { name: 'Docs', state: 'connected', source: 'claudeai' },
      { name: 'Gmail', state: 'needs-auth', source: 'claudeai' },
      { name: 'mine', state: 'failed', source: 'user' }
    ])
  })

  it('区分の無い古い報告は全体側に数えない', () => {
    expect(globalServersOf([{ name: 'old', state: 'connected', source: 'claudeai', gateway: false }])).toEqual([])
  })
})

describe('全体側の MCP サーバの報告の控え (項目 164)', () => {
  it('報告が 1 件も無ければ null', () => {
    expect(manager.mcpReport()).toBeNull()
  })

  it('session_started のたびに全体側の行を書き、知らせる', async () => {
    await started(SERVERS, 1_000)
    const expected: McpGlobalReport = {
      at: 1_000,
      servers: [
        { name: 'Docs', state: 'connected', source: 'claudeai' },
        { name: 'Gmail', state: 'needs-auth', source: 'claudeai' },
        { name: 'mine', state: 'failed', source: 'user' }
      ]
    }
    expect(manager.mcpReport()).toEqual(expected)
    expect(pushed).toEqual([expected])
    // The record is in one key of app_settings (it remains even after a restart).
    expect(new AppSettingsStore(db).readTyped(MCP_LAST_GLOBAL_REPORT)).toEqual(expected)
  })

  it('別のスレッドの新しい報告が同じ鍵を上書きする (失敗が直っていれば消える)', async () => {
    await started(SERVERS, 1_000)
    const healed = SERVERS.map((s) => (s.name === 'mine' ? { ...s, state: 'connected' as const } : s))
    await started(healed, 2_000)
    const latest = manager.mcpReport()
    expect(latest?.at).toBe(2_000)
    expect(latest?.servers.find((s) => s.name === 'mine')?.state).toBe('connected')
    expect(pushed).toHaveLength(2)
  })

  it('mcpServers の無い報告 (古い形) では書き換えない', async () => {
    await started(SERVERS, 1_000)
    await started(undefined, 2_000)
    expect(manager.mcpReport()?.at).toBe(1_000)
    expect(pushed).toHaveLength(1)
  })

  it('全体側が 0 件の報告は空の一覧として書く (まだ起動していない、とは別)', async () => {
    await started([report({ name: 'probe', source: 'project', scope: 'folder' })], 3_000)
    expect(manager.mcpReport()).toEqual({ at: 3_000, servers: [] })
  })

  it('作り直した SessionManager (再起動) でも控えを読める', async () => {
    await started(SERVERS, 1_000)
    await manager.stop()
    manager = build()
    expect(manager.mcpReport()?.servers.map((s) => s.name)).toEqual(['Docs', 'Gmail', 'mine'])
  })
})
