/**
 * TODO 526 (wave 26 bundle C): physical deletion (main side) of threads that got no input and no answer for 3 minutes.
 *
 * - Pure functions and a small box (`src/main/session/abandoned.ts`): the set of per-window drafts, narrowing of the IPC values, and how candidates are picked.
 * - `ThreadStore.abandonedThreads` / `purgeAbandonedThread`: the conditions are in SQL, and the delete re-checks the same conditions at the moment of deletion.
 *   sessions / thread_events go away through `ON DELETE CASCADE`.
 * - `SessionManager.purgeAbandonedThreads`: keeps threads that an open window, a Composer draft, a non-zero setting, a finished run, or the scratch area still needs.
 *   After a delete, the index RPC (`index.removeThread`) and a full push run.
 *
 * The DB is a real in-memory one (with migrations). Neither the CLI nor the model is started (the Adapter is a minimal stub).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { ABANDONED_THREAD_TTL_MS, DEFAULT_ABANDONED_THREAD_TTL_MS } from '../src/common/settings-keys.js'
import { ThreadStore } from '../src/main/session/store.js'
import { SessionManager, type SessionManagerDeps } from '../src/main/session/manager.js'
import { ComposerDraftRegistry, asThreadIdList, pickAbandoned } from '../src/main/session/abandoned.js'
import { scratchCwd } from '../src/main/session/scratch.js'
import type { AgentAdapter } from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'
import type { ThreadSummary } from '../src/shared/thread.js'

const MINUTE = 60_000

describe('ComposerDraftRegistry', () => {
  it('replaces everything per window and answers has if any window holds it', () => {
    const r = new ComposerDraftRegistry()
    r.report(1, ['a', 'b'])
    r.report(2, ['c'])
    expect(r.has('a')).toBe(true)
    expect(r.has('c')).toBe(true)
    r.report(1, ['b'])
    expect(r.has('a')).toBe(false)
    expect(r.has('b')).toBe(true)
    r.report(2, [])
    expect(r.has('c')).toBe(false)
  })
  it("forgets a window's entries when the window closes", () => {
    const r = new ComposerDraftRegistry()
    r.report(1, ['a'])
    r.report(2, ['a'])
    r.close(1)
    expect(r.has('a')).toBe(true)
    r.close(2)
    expect(r.has('a')).toBe(false)
  })
})

describe('asThreadIdList', () => {
  it('keeps only the strings of an array', () => {
    expect(asThreadIdList(['a', 1, '', null, 'b', 'x'.repeat(201)])).toEqual(['a', 'b'])
    expect(asThreadIdList('a')).toEqual([])
    expect(asThreadIdList(undefined)).toEqual([])
    expect(asThreadIdList(['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
  })
})

describe('pickAbandoned', () => {
  const candidates = [
    { id: 'old', createdAt: 0 },
    { id: 'edge', createdAt: 7 * MINUTE },
    { id: 'new', createdAt: 9 * MINUTE }
  ]
  it('only rows at least ttl old and not protected', () => {
    expect(pickAbandoned(candidates, 10 * MINUTE, 3 * MINUTE, () => false)).toEqual(['old', 'edge'])
    expect(pickAbandoned(candidates, 10 * MINUTE, 3 * MINUTE, (id) => id === 'old')).toEqual(['edge'])
  })
  it('deletes nothing when ttl is 0 or less or NaN', () => {
    expect(pickAbandoned(candidates, 10 * MINUTE, 0, () => false)).toEqual([])
    expect(pickAbandoned(candidates, 10 * MINUTE, -1, () => false)).toEqual([])
    expect(pickAbandoned(candidates, 10 * MINUTE, Number.NaN, () => false)).toEqual([])
  })
})

let db: Db

function openDb(): Db {
  const d = new Database(':memory:')
  d.pragma('foreign_keys = ON')
  runMigrations(d)
  return d
}

function create(
  store: ThreadStore,
  id: string,
  extra: Partial<Parameters<ThreadStore['createThread']>[0]> = {},
  cwd = '/Users/tester/work'
): void {
  store.createThread({
    id,
    title: '',
    titleAuto: true,
    cwd,
    allowedDirs: [cwd],
    retention: 'forever',
    backend: 'fake',
    modelId: null,
    thinking: null,
    ...extra
  })
}

describe('ThreadStore: abandoned threads (TODO 526)', () => {
  let store: ThreadStore
  beforeEach(() => {
    db = openDb()
    store = new ThreadStore(db, '/Users/tester')
  })
  afterEach(() => db.close())

  const future = (): number => Date.now() + MINUTE

  it('only rows with a provisional title and no send or reply are candidates, and rows created after the cutoff are excluded', () => {
    create(store, 'plain')
    create(store, 'named', { title: '名前', titleAuto: false })
    create(store, 'scheduled', { scheduleJobId: 'job-1' })
    create(store, 'forked', {
      forkOrigin: { threadId: 'x', title: 'x', eventId: 'e', backendSessionId: null, responseId: null } as never
    })
    create(store, 'sent')
    store.touchLastEvent('sent', Date.now())
    create(store, 'deleted')
    store.removeThread('deleted')
    expect(store.abandonedThreads(future()).map((t) => t.id)).toEqual(['plain'])
    expect(store.abandonedThreads(Date.now() - MINUTE)).toEqual([])
  })

  it('a row with events or a session is not a candidate (a double check independent of the retention setting)', () => {
    create(store, 'with-session')
    store.recordSession({ id: 's1', threadId: 'with-session', backendSessionId: 'b1', forkedFrom: null, backendVersion: null })
    create(store, 'with-event')
    db.prepare(
      `INSERT INTO thread_events (id, thread_id, session_id, seq, ts, kind, actor, parent_tool_use_id, payload, payload_bytes)
       VALUES ('e1', 'with-event', NULL, 1, 1, 'user_text', 'main', NULL, '{"text":"x"}', 12)`
    ).run()
    expect(store.abandonedThreads(future())).toEqual([])
  })

  it('purge physically deletes rows and they do not appear in the deleted list; a row that no longer matches at deletion time is kept', () => {
    create(store, 'a')
    create(store, 'b')
    const cutoff = future()
    // A send came in after the candidates were read.
    store.touchLastEvent('b', Date.now())
    expect(store.purgeAbandonedThread('a', cutoff)).toBe(true)
    expect(store.purgeAbandonedThread('b', cutoff)).toBe(false)
    expect(store.getThread('a')).toBeNull()
    expect(store.listDeletedThreads()).toEqual([])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE id = 'a'`).get()).toEqual({ n: 0 })
    expect(store.getThread('b')).not.toBeNull()
  })

  it('defaults to 3 minutes and can be changed through the app_settings value', () => {
    expect(store.abandonedThreadTtlMs()).toBe(DEFAULT_ABANDONED_THREAD_TTL_MS)
    expect(DEFAULT_ABANDONED_THREAD_TTL_MS).toBe(3 * MINUTE)
    new AppSettingsStore(db).writeTyped(ABANDONED_THREAD_TTL_MS, 0)
    expect(store.abandonedThreadTtlMs()).toBe(0)
  })
})

describe('SessionManager.purgeAbandonedThreads (TODO 526)', () => {
  let store: ThreadStore
  let manager: SessionManager
  let home: string
  let tombstoned: string[]
  let fullLists: (readonly ThreadSummary[])[]

  function build(): SessionManager {
    const adapter = {
      id: 'fake',
      label: 'Fake',
      transcripts: null,
      listModels: async () => [],
      getStatus: async () => ({}),
      supports: () => true,
      contextWindow: () => null,
      spawn: async () => {
        throw new Error('not used')
      }
    } as unknown as AgentAdapter
    const deps: SessionManagerDeps = {
      db,
      store,
      adapters: [adapter],
      fs: { homePath: home, defaultReferenceDirs: () => [] } as unknown as FsAccess,
      index: {
        removeThread: (threadId: string) => tombstoned.push(threadId)
      } as unknown as IndexClient,
      gateway: {} as unknown as GatewayServer,
      gatewayRuntimePath: '/bin/false',
      gatewayScriptPath: '/dev/null',
      gatewayConfigDir: '/tmp/aios-test-mcp',
      events: {
        onEvents: () => undefined,
        onThreadsChanged: (list) => fullLists.push(list),
        onThreadChanged: () => undefined,
        onApprovalsChanged: () => undefined,
        onAgentStatus: () => undefined
      }
    }
    return new SessionManager(deps)
  }

  beforeEach(() => {
    db = openDb()
    home = mkdtempSync(join(tmpdir(), 'aios-526-'))
    store = new ThreadStore(db, home)
    tombstoned = []
    fullLists = []
    manager = build()
  })
  afterEach(async () => {
    await manager.stop()
    db.close()
    rmSync(home, { recursive: true, force: true })
  })

  const later = (): number => Date.now() + 4 * MINUTE

  it('deletes untouched threads older than 3 minutes and emits the index RPC and a full broadcast', () => {
    create(store, 'idle', {}, join(home, 'work'))
    expect(manager.purgeAbandonedThreads(Date.now())).toBe(0)
    expect(manager.purgeAbandonedThreads(later())).toBe(1)
    expect(store.getThread('idle')).toBeNull()
    expect(tombstoned).toEqual(['idle'])
    expect(fullLists).toHaveLength(1)
    expect(fullLists[0]?.some((s) => s.thread.id === 'idle')).toBe(false)
    // If nothing was deleted, nothing is broadcast.
    expect(manager.purgeAbandonedThreads(later())).toBe(0)
    expect(fullLists).toHaveLength(1)
  })

  it('does not delete a thread while it is open (selected) in any window; deletes it after the window closes', () => {
    create(store, 'open', {}, join(home, 'work'))
    manager.openThread('open', 7)
    expect(manager.purgeAbandonedThreads(later())).toBe(0)
    manager.closeView(7)
    expect(manager.purgeAbandonedThreads(later())).toBe(1)
  })

  it('does not delete while the Composer has a draft', () => {
    create(store, 'drafted', {}, join(home, 'work'))
    manager.reportComposerDrafts(3, ['drafted'])
    expect(manager.purgeAbandonedThreads(later())).toBe(0)
    manager.reportComposerDrafts(3, [])
    expect(manager.purgeAbandonedThreads(later())).toBe(1)
  })

  it('TODO 103 (code-review) / TODO 1333: a viewer draft for a file elsewhere (the count in the table) still stops the idle restart, and is not a draft to carry', () => {
    expect(manager.restartBlocker()).toBeNull()
    // The file on screen has no draft (reportDraft is null), but the table has two from other files.
    manager.reportDraft(3, null)
    manager.reportStoredViewerDrafts(3, 2)
    expect(manager.restartBlocker()).toBe('viewer-draft')
    expect(manager.hasDrafts()).toBe(false)
    manager.reportStoredViewerDrafts(3, 0)
    expect(manager.restartBlocker()).toBeNull()
    // Forget it when the window closes or is reloaded.
    manager.reportStoredViewerDrafts(4, 1)
    expect(manager.restartBlocker()).toBe('viewer-draft')
    manager.closeView(4)
    expect(manager.restartBlocker()).toBeNull()
    // The file being edited counts too
    manager.reportDraft(3, '/Work/A.md')
    expect(manager.restartBlocker()).toBe('viewer-draft')
    manager.reportDraft(3, null)
  })

  it('TODO 1333: the Composer draft does not block the idle restart (it is carried); activityBlocker never looks at drafts; the carried threads are protected from the purge', () => {
    manager.reportComposerDrafts(3, ['x'])
    expect(manager.restartBlocker()).toBeNull()
    expect(manager.activityBlocker()).toBeNull()
    expect(manager.hasDrafts()).toBe(true)
    expect([...manager.draftsOfView(3).composerThreads]).toEqual(['x'])
    manager.reportStoredViewerDrafts(3, 2)
    expect(manager.activityBlocker()).toBeNull()
    manager.reportStoredViewerDrafts(3, 0)
    manager.reportComposerDrafts(3, [])
    // The carried threads are protected from the purge until released.
    create(store, 'carried', {}, join(home, 'work'))
    const release = manager.holdCarriedComposerDrafts(['carried'])
    expect(manager.purgeAbandonedThreads(later())).toBe(0)
    release()
    expect(manager.purgeAbandonedThreads(later())).toBe(1)
  })

  it('does not delete when the scratch directory already exists (leaves the contents to sweepScratch / manual deletion)', () => {
    create(store, 'scratchy', {}, scratchCwd(home, 'scratchy'))
    create(store, 'scratch-none', {}, scratchCwd(home, 'scratch-none'))
    mkdirSync(scratchCwd(home, 'scratchy'), { recursive: true })
    expect(manager.purgeAbandonedThreads(later())).toBe(1)
    expect(store.getThread('scratchy')).not.toBeNull()
    expect(store.getThread('scratch-none')).toBeNull()
  })

  it('does not delete when the setting is 0', async () => {
    await manager.stop()
    new AppSettingsStore(db).writeTyped(ABANDONED_THREAD_TTL_MS, 0)
    manager = build()
    create(store, 'keep', {}, join(home, 'work'))
    expect(manager.purgeAbandonedThreads(later())).toBe(0)
    expect(store.getThread('keep')).not.toBeNull()
  })

  it('does not touch the DB after shutdown (12.9)', async () => {
    create(store, 'late', {}, join(home, 'work'))
    await manager.stop()
    expect(manager.purgeAbandonedThreads(later())).toBe(0)
    expect(store.getThread('late')).not.toBeNull()
  })
})
