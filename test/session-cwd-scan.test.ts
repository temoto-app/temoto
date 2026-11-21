/**
 * Asks for a partial scan of the cwd when a thread is created (item 246, ARCHITECTURE.md 6.2.2 "subtree scan at thread creation").
 *
 * Looks only at the main side (SessionManager). The contents of the index process (choke point, merge, limit) are in
 * `test/scan-subtree.test.ts`, and the RPC wiring is "item 246" in `test/index-rpc.test.ts`.
 * `test/session-manager.test.ts` tends to conflict with bundles running in parallel, so the harness is separate (a minimal fake).
 * Neither the CLI nor the model is started. The DB is the real SQLite code (in memory).
 *
 * What is pinned:
 * - A normal creation (cwd given, or omitted = home) asks once, with the cwd's path
 * - Scratch areas (T19) do not ask (right after `mkdir` it is empty, and the watcher picks up its contents)
 * - Continuing from a transcript (item 111) also asks (a drop, and "new" from a heading, go through `createThread`, so it is the same)
 * - It does not wait: even if the index side never replies, creation finishes. Even with no entry point or a fake that throws, creation does not fail
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus, AiosEvent } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import { runMigrations } from '../src/common/migrations.js'
import { pathToUri } from '../src/common/uri.js'
import { SessionManager } from '../src/main/session/manager.js'
import type {
  AgentAdapter,
  AgentSession,
  TranscriptSessionInfo,
  TranscriptStore
} from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'

const SID = 'bbbbbbbb-2222-4222-8222-222222222222'

/** A fake transcript store. Only `findSession` has meaning. */
class FakeTranscripts implements TranscriptStore {
  sessions: TranscriptSessionInfo[] = []
  async listFiles(): Promise<readonly never[]> {
    return []
  }
  async readMessages(): Promise<null> {
    return null
  }
  async readMessageText(): Promise<{ text: null; stale: false; missing: false }> {
    return { text: null, stale: false, missing: false }
  }
  async findToolResult(): Promise<null> {
    return null
  }
  async listSessions(): Promise<readonly TranscriptSessionInfo[]> {
    return this.sessions
  }
  async findSession(sessionId: string): Promise<TranscriptSessionInfo | null> {
    return this.sessions.find((s) => s.sessionId === sessionId) ?? null
  }
  async describeUri(): Promise<TranscriptSessionInfo | null> {
    return null
  }
  async readHistory(): Promise<readonly AiosEvent[] | null> {
    return null
  }
}

class FakeAdapter implements AgentAdapter {
  readonly id = 'fake'
  readonly label = 'Fake'
  readonly transcripts = new FakeTranscripts()
  readonly spawn = vi.fn(async (): Promise<AgentSession> => {
    throw new Error('この test は起動しない')
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
let dir: string
let adapter: FakeAdapter
let manager: SessionManager
/** The partial-scan requests (paths) received by the fake IndexClient. */
let scans: string[]

function build(index: Partial<IndexClient>): SessionManager {
  const fs = {
    homePath: dir,
    homeUri: pathToUri(dir),
    defaultReferenceDirs: () => [],
    isReferenceable: () => true,
    assertAllowed: (uri: string) => decodeURIComponent(uri.replace('file://', ''))
  } as unknown as FsAccess
  const gateway = {
    socketPath: '/tmp/aios-test-cwdscan.sock',
    issueToken: () => 'token',
    revokeToken: () => undefined
  } as unknown as GatewayServer
  return new SessionManager({
    db,
    adapters: [adapter],
    fs,
    index: {
      indexConversationEvents: () => undefined,
      removeThread: () => undefined,
      removeAllConversations: () => undefined,
      ...index
    } as unknown as IndexClient,
    gateway,
    gatewayRuntimePath: '/bin/false',
    gatewayScriptPath: '/dev/null',
    gatewayConfigDir: '/tmp/aios-test-cwdscan-mcp',
    events: {
      onEvents: () => undefined,
      onThreadsChanged: () => undefined,
      onThreadChanged: () => undefined,
      onApprovalsChanged: () => undefined,
      onAgentStatus: () => undefined
    }
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-cwd-scan-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  adapter = new FakeAdapter()
  scans = []
  manager = build({ scanSubtree: (path: string) => void scans.push(path) })
})

afterEach(async () => {
  await manager.stop()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('スレッド作成時の部分木走査の依頼 (項目 246)', () => {
  it('cwd を指定して作ると、その cwd で 1 回だけ頼む', async () => {
    const cwd = join(dir, 'repo')
    await manager.createThread({ cwdUri: pathToUri(cwd) })
    expect(scans).toEqual([cwd])
  })

  it('cwd を省略 (= ホーム) しても頼む — 走査ルートかどうかは索引プロセスが判じる', async () => {
    await manager.createThread({})
    expect(scans).toEqual([dir])
  })

  it('捨て場 (所属なし) では頼まない', async () => {
    await manager.createThread({ scratch: true })
    expect(scans).toEqual([])
  })

  it('転写から続けるときも、転写の cwd で頼む', async () => {
    adapter.transcripts.sessions = [
      {
        id: `-proj/${SID}.jsonl`,
        uri: `transcript://-proj/${SID}.jsonl`,
        sessionId: SID,
        cwd: dir,
        title: '続き',
        firstPrompt: '続き',
        model: null,
        mtimeMs: Date.now(),
        size: 10
      }
    ]
    await manager.createThread({ transcript: { sessionId: SID, fork: false } })
    expect(scans).toEqual([dir])
  })

  it('依頼の口が無い / 投げる IndexClient でも作成は失敗しない', async () => {
    await manager.stop()
    manager = build({})
    await expect(manager.createThread({ cwdUri: pathToUri(join(dir, 'a')) })).resolves.toBeDefined()
    await manager.stop()
    manager = build({
      scanSubtree: () => {
        throw new Error('index process is not running')
      }
    })
    await expect(manager.createThread({ cwdUri: pathToUri(join(dir, 'b')) })).resolves.toBeDefined()
  })
})
