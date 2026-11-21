/**
 * Integration test of `ThreadStore`. **It uses the real encrypted DB code as is** (Phase 1 finding: the native module is an N-API prebuild, so it runs in plain Node).
 *
 * What is confirmed here:
 * - The contents of `tool_result` are not saved (constraint 10).
 * - Deltas (assistant / thinking) are not saved (4.3.1).
 * - Redaction runs before saving. It applies **to the user's messages too**.
 * - With `retention = 'none'`, not a single row is written.
 * - An ordinary resume does not add `sessions` rows (spike 1).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent } from '../src/shared/agent.js'
import type { Thread } from '../src/shared/thread.js'
import { MIGRATIONS, runMigrations } from '../src/common/migrations.js'
import { ThreadStore, threadCwdName, type ThreadRecord } from '../src/main/session/store.js'
import { ApprovalBroker } from '../src/main/approval/broker.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { scratchCwd } from '../src/main/session/scratch.js'
import { foldPath } from '../src/common/uri.js'
import { join } from 'node:path'

/** The home for tests. It does not depend on the real machine's `homedir()` (used to derive T18's display names). */
const HOME = '/Users/tester'

let db: Db
let store: ThreadStore
let thread: Thread

beforeEach(() => {
  // In memory. PRAGMA key cannot be used in memory, so no key is set (8.2).
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new ThreadStore(db, HOME)
  thread = store.createThread({
    id: 'thread-1',
    title: 'テスト',
    cwd: '/Users/tester/work',
    allowedDirs: ['/Users/tester/work'],
    retention: 'forever',
    backend: 'agent-cli',
    modelId: null,
    thinking: null
  })
})

afterEach(() => {
  db.close()
})

function event(partial: Partial<AiosEvent> & Pick<AiosEvent, 'kind' | 'payload'>): AiosEvent {
  return {
    id: partial.id ?? `e${Math.random()}`,
    sessionId: 'session-1',
    threadId: 'thread-1',
    ts: Date.now(),
    actor: 'main',
    ...partial
  } as AiosEvent
}

describe('ThreadStore — スレッド', () => {
  it('作成して読み戻せる。参照範囲は URI で返る', () => {
    expect(thread.title).toBe('テスト')
    expect(thread.cwdUri).toBe('file:///Users/tester/work')
    expect(thread.allowedDirUris).toEqual(['file:///Users/tester/work'])
    expect(thread.retention).toBe('forever')
    // The records are the same 3 as the plain CLI (item 109). They are not read at startup (4.6.4).
    expect(thread.settingSources).toEqual(['user', 'project', 'local'])
    expect(thread.backend).toBe('agent-cli')
    expect(thread.modelId).toBeNull()
    expect(thread.thinking).toBeNull()
  })

  it('厳格モードは既定 false で、保存して読み戻せる (migration 9 / T12)', () => {
    expect(thread.approvalStrict).toBe(false)
    const strict = store.createThread({
      id: 'thread-strict',
      title: '厳格',
      cwd: '/Users/tester/work',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null,
      approvalStrict: true
    })
    expect(strict.approvalStrict).toBe(true)
    expect(store.setStrict('thread-strict', false)).toBe(true)
    expect(store.getThread('thread-strict')?.approvalStrict).toBe(false)
  })

  it('cwd の表示名が行から導出されて届く。パスは名前だけ (T18 / TODO 22)', () => {
    expect(thread.cwdName).toBe('work')
    // A thread in the dump (T19) shows neither a UUID nor even a label (TODO 62).
    const scratch = store.createThread({
      id: '7a851af7-8169-4bfa-ae3a-64caa3624db4',
      title: '使い捨て',
      cwd: scratchCwd(HOME, '7a851af7-8169-4bfa-ae3a-64caa3624db4'),
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    expect(scratch.cwdName).toBe('')
    expect(store.getThread(scratch.id)?.cwdName).toBe('')
    const names = store.listThreads().map((t) => t.cwdName)
    expect(names).toContain('work')
    // Even after saving and reading back, it is re-derived (no column was added).
    store.setTitle(thread.id, '改名')
    expect(store.getThread(thread.id)?.cwdName).toBe('work')
  })

  it('作業ディレクトリの虹色は出現順に配られ、永続化される (項目 108)', () => {
    // The color of the first thread (created in beforeEach, cwd = /Users/tester/work) is 0.
    expect(thread.rainbow).toBe(0)
    const second = store.createThread({
      id: 'thread-2',
      title: '2 本目',
      cwd: '/Users/tester/git/foo',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    // The second cwd is new, so it gets 8, the farthest on the hue wheel.
    expect(second.rainbow).toBe(8)
    // Another thread with the same cwd has the same color (it is already in the table).
    const third = store.createThread({
      id: 'thread-3',
      title: '同じ場所',
      cwd: '/Users/tester/git/foo',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    expect(third.rainbow).toBe(8)
    // Still the same value after reading back (persisted).
    expect(store.getThread(second.id)?.rainbow).toBe(8)
    // A ThreadStore rebuilt on the table (equivalent to a restart) also reads the same value.
    const restarted = new ThreadStore(db, HOME)
    expect(restarted.getThread(second.id)?.rainbow).toBe(8)
  })

  it('無所属 (捨て場) と cwd 無しの古い行は虹色を持たず、表も汚さない (項目 108 / 58)', () => {
    const scratch = store.createThread({
      id: 'scratch-thread',
      title: '使い捨て',
      cwd: scratchCwd(HOME, 'scratch-thread'),
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    expect(scratch.rainbow).toBeNull()
    const table = new AppSettingsStore(db).readJson<Record<string, number>>('thread.rainbowTable')
    // The folded path of the dump is not in the table (it would grow without bound if written). The table holds only the one entry for thread-1 created in beforeEach (cwd = /Users/tester/work).
    expect(Object.keys(table ?? {})).toEqual([foldPath('/Users/tester/work')])
  })

  it('承認の既定は無ければ既定、空配列は空のまま (T12 / T40)', () => {
    // T40: the default is 'ask as little as possible'. This applies when there is no setting.
    expect(store.readApprovalPolicy().autoAllowAll).toBe(true)
    expect(store.readApprovalPolicy().autoAllowTools).toEqual(['Bash', 'WebFetch', 'WebSearch'])
    store.writeApprovalPolicy({ autoAllowAll: false, autoAllowTools: [], bashDenyPatterns: ['sudo'] })
    expect(store.readApprovalPolicy()).toEqual({
      autoAllowAll: false,
      autoAllowTools: [],
      bashDenyPatterns: ['sudo'],
      // TODO 1029: with no non-asking destinations, it is empty. Writing it with the key omitted does not touch the saved value.
      // (TODO 1048: the non-asking push destination of 1013 was removed together with its key.)
      sshAllowedHosts: [],
      // TODO 1106: the OS sandbox allow list defaults to (npm's registry and GitHub, ~/.npm) when absent.
      sandboxAllowedDomains: ['registry.npmjs.org', 'github.com', '*.github.com'],
      sandboxAllowWrite: ['~/.npm'],
      // TODO 1175: full delegation mode is false when absent.
      fullDelegation: false
    })
    store.writeApprovalPolicy({ autoAllowAll: false, autoAllowTools: [], bashDenyPatterns: [], sshAllowedHosts: ['WinBox', 'a b'] })
    expect(store.readApprovalPolicy().sshAllowedHosts).toEqual(['winbox'])
    store.writeApprovalPolicy({ autoAllowAll: false, autoAllowTools: [], bashDenyPatterns: [] })
    expect(store.readApprovalPolicy().sshAllowedHosts).toEqual(['winbox'])
  })

  it('model / thinking / 設定の出所は保存して読み戻せる (migration 7)', () => {
    const created = store.createThread({
      id: 'thread-2',
      title: 't',
      cwd: '/Users/tester/other',
      allowedDirs: [],
      retention: 'forever',
      settingSources: ['user', 'project'],
      backend: 'agent-cli',
      modelId: 'some-model',
      thinking: 'medium'
    })
    expect(created.modelId).toBe('some-model')
    expect(created.thinking).toBe('medium')
    expect(created.settingSources).toEqual(['user', 'project'])
    expect(store.setModelAndThinking('thread-2', null, 'off')).toBe(true)
    const reloaded = store.getThread('thread-2')
    expect(reloaded?.thinking).toBe('off')
    expect(reloaded?.modelId).toBeNull()
    // Per-column UPDATE (item 83) does not touch other columns.
    expect(reloaded?.settingSources).toEqual(['user', 'project'])
  })

  it('ViewerPane の記憶は既定で無し、書いて読み戻せる (migration 12 / 項目 63)', () => {
    const columns = db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[]
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['last_viewer_uri', 'last_viewer_highlight'])
    )
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(12)
    expect(thread.lastViewerUri).toBeNull()
    expect(thread.lastViewerHighlight).toBeNull()

    expect(store.setViewerState('thread-1', 'file:///Users/tester/work/a.cpp', 'needle')).toBe(true)
    const [reloaded] = store.listThreads()
    expect(reloaded?.lastViewerUri).toBe('file:///Users/tester/work/a.cpp')
    expect(reloaded?.lastViewerHighlight).toBe('needle')

    // Closed (item 70) = none. If the uri is null, the search term is not kept either.
    store.setViewerState('thread-1', null, 'needle')
    expect(store.getThread('thread-1')?.lastViewerUri).toBeNull()
    expect(store.getThread('thread-1')?.lastViewerHighlight).toBeNull()
  })

  it('ViewerPane の記憶を書いても updated_at は動かない (一覧の並びを変えない)', () => {
    db.prepare(`UPDATE threads SET updated_at = 1 WHERE id = 'thread-1'`).run()
    store.setViewerState('thread-1', 'file:///Users/tester/work/a.cpp', null)
    expect(store.getThread('thread-1')?.updatedAt).toBe(1)
    // A thread with no row cannot be written to.
    expect(store.setViewerState('no-such-thread', null, null)).toBe(false)
  })

  it('列ごとの UPDATE は ViewerPane の記憶を保つ (他の列の更新で消さない)', () => {
    store.setViewerState('thread-1', 'file:///Users/tester/work/b.py', 'q')
    store.setTitle('thread-1', '改名')
    const reloaded = store.getThread('thread-1')
    expect(reloaded?.title).toBe('改名')
    expect(reloaded?.lastViewerUri).toBe('file:///Users/tester/work/b.py')
    expect(reloaded?.lastViewerHighlight).toBe('q')
  })

  it('一覧と更新', () => {
    store.setTitle('thread-1', '変更後')
    expect(store.setUnread('thread-1', true)).toBe(true)
    // A write that does not change the value returns false (judged by the UPDATE's condition).
    expect(store.setUnread('thread-1', true)).toBe(false)
    const [reloaded] = store.listThreads()
    expect(reloaded?.title).toBe('変更後')
    expect(reloaded?.unread).toBe(true)
  })

})

describe('ThreadStore — 論理削除 (項目 64)', () => {
  function rawThread(id: string): { id: string; deleted_at: number | null } | undefined {
    return db.prepare(`SELECT id, deleted_at FROM threads WHERE id = ?`).get(id) as
      | { id: string; deleted_at: number | null }
      | undefined
  }

  it('削除後は一覧に出ず getThread も null。行は残って deleted_at が入る', () => {
    expect(rawThread('thread-1')?.deleted_at).toBeNull()
    expect(store.removeThread('thread-1', 1234)).toBe(true)
    expect(store.listThreads()).toHaveLength(0)
    expect(store.getThread('thread-1')).toBeNull()
    expect(rawThread('thread-1')).toEqual({ id: 'thread-1', deleted_at: 1234 })
  })

  it('タイムラインとセッションの行は消えない (CASCADE が走らない)', () => {
    store.recordSession({
      id: 'internal-1',
      threadId: 'thread-1',
      backendSessionId: 'backend-1',
      forkedFrom: null,
      backendVersion: null
    })
    store.appendEvents(thread, 'session-1', [event({ kind: 'user_text', payload: { text: 'hi' } })])
    store.removeThread('thread-1')
    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id = ?`).get('thread-1') as {
        n: number
      }).n
    expect(count('thread_events')).toBe(1)
    expect(count('sessions')).toBe(1)
  })

  it('二度消しても最初の時刻を保つ。存在しない id は false', () => {
    store.removeThread('thread-1', 1000)
    expect(store.removeThread('thread-1', 2000)).toBe(false)
    expect(rawThread('thread-1')?.deleted_at).toBe(1000)
    expect(store.removeThread('no-such-thread')).toBe(false)
  })

  it('消したスレッドには保存も表示の記憶も書かない', () => {
    store.removeThread('thread-1', 1000)
    expect(store.setTitle('thread-1', '蘇生')).toBe(false)
    expect(store.setUnread('thread-1', true)).toBe(false)
    expect(store.touchLastEvent('thread-1', 5000)).toBe(false)
    expect(store.addAllowedDir('thread-1', '/Users/tester/x')).toBe(false)
    expect(store.setViewerState('thread-1', 'file:///Users/tester/work/a.py', null)).toBe(false)
    const row = db.prepare(`SELECT title, last_viewer_uri FROM threads WHERE id = ?`).get('thread-1')
    expect(row).toEqual({ title: 'テスト', last_viewer_uri: null })
    expect(store.getThread('thread-1')).toBeNull()
  })

  it('索引の読み口 (本文・題名・起動時の一覧) からも消える', () => {
    store.appendEvents(thread, 'session-1', [
      event({ id: 'ev-1', kind: 'user_text', payload: { text: '消える発言' } })
    ])
    expect(store.eventText('ev-1')?.text).toBe('消える発言')
    expect(store.threadTitle('thread-1')).toBe('テスト')
    expect(store.indexableEvents().map((e) => e.id)).toEqual(['ev-1'])

    store.removeThread('thread-1')
    expect(store.eventText('ev-1')).toBeNull()
    expect(store.threadTitle('thread-1')).toBeNull()
    // The list that is streamed to the index at every startup. If it stays here, search will return at the next startup.
    expect(store.indexableEvents()).toHaveLength(0)
  })

  it('TODO 863: liveEventIds / liveThreadIds は消したスレッド・消えた行を在ると言わない', () => {
    store.appendEvents(thread, 'session-1', [
      event({ id: 'ev-a', kind: 'user_text', payload: { text: 'a' } }),
      event({ id: 'ev-b', kind: 'user_text', payload: { text: 'b' } })
    ])
    // Input beyond the number of ids in one statement (200), and ids that do not exist. The order is the input order.
    const many = [...Array.from({ length: 250 }, (_, i) => `missing-${i}`), 'ev-b', 'ev-a']
    expect(store.liveEventIds(many)).toEqual(['ev-b', 'ev-a'])
    expect(store.liveEventIds([])).toEqual([])
    expect([...store.liveThreadIds()]).toEqual(['thread-1'])
    store.clearTimeline('thread-1')
    expect(store.liveEventIds(['ev-a'])).toEqual([])
    store.appendEvents(thread, 'session-1', [
      event({ id: 'ev-c', kind: 'user_text', payload: { text: 'c' } })
    ])
    store.removeThread('thread-1')
    expect(store.liveEventIds(['ev-c'])).toEqual([])
    expect(store.liveThreadIds().size).toBe(0)
    store.restoreThread('thread-1')
    expect(store.liveEventIds(['ev-c'])).toEqual(['ev-c'])
  })

  it('retention は消したスレッドにも効き続ける', () => {
    const days = { ...thread, retention: 'days' as const, retentionDays: 7 }
    store.setRetention('thread-1', 'days', 7)
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000
    store.appendEvents(days, 's1', [
      event({ id: 'old', ts: old, kind: 'user_text', payload: { text: '古い' } }),
      event({ id: 'new', kind: 'user_text', payload: { text: '新しい' } })
    ])
    store.removeThread('thread-1')
    expect(store.applyRetention()).toBe(1)
    const ids = (
      db.prepare(`SELECT id FROM thread_events WHERE thread_id = ?`).all('thread-1') as {
        id: string
      }[]
    ).map((row) => row.id)
    expect(ids).toEqual(['new'])
  })

  it('TODO 860: applyRetention は retention を持つ全部のスレッドの境界を知らせる (消した行が無くても)', () => {
    const now = Date.now()
    store.setRetention('thread-1', 'days', 7)
    const reported: { threadId: string; before: number | null }[] = []
    // Notify even when no rows were removed: if the notice for what was removed at the previous startup never reached the index, pick it up again.
    expect(store.applyRetention(now, (threadId, before) => reported.push({ threadId, before }))).toBe(0)
    expect(reported).toEqual([{ threadId: 'thread-1', before: now - 7 * 24 * 60 * 60 * 1000 }])
    reported.length = 0
    store.setRetention('thread-1', 'none', null)
    store.applyRetention(now, (threadId, before) => reported.push({ threadId, before }))
    expect(reported).toEqual([{ threadId: 'thread-1', before: null }])
  })
})

describe('ThreadStore — 削除済みの復元 (項目 191)', () => {
  function rawThread(id: string): { id: string; deleted_at: number | null; updated_at: number } | undefined {
    return db
      .prepare(`SELECT id, deleted_at, updated_at FROM threads WHERE id = ?`)
      .get(id) as { id: string; deleted_at: number | null; updated_at: number } | undefined
  }

  it('削除 → 一覧から消える → 削除済み一覧に出る → 復元 → 一覧に戻り削除済みから消える', () => {
    store.removeThread('thread-1', 1234)
    expect(store.listThreads()).toHaveLength(0)
    const deleted = store.listDeletedThreads()
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toMatchObject({ id: 'thread-1', title: 'テスト', deletedAt: 1234 })

    expect(store.restoreThread('thread-1')).toBe(true)
    expect(store.listThreads().map((t) => t.id)).toEqual(['thread-1'])
    expect(store.getThread('thread-1')).not.toBeNull()
    expect(store.listDeletedThreads()).toHaveLength(0)
  })

  it('復元は updated_at を動かさない', () => {
    const before = rawThread('thread-1')!.updated_at
    store.removeThread('thread-1')
    expect(store.restoreThread('thread-1')).toBe(true)
    expect(rawThread('thread-1')!.updated_at).toBe(before)
    expect(rawThread('thread-1')!.deleted_at).toBeNull()
  })

  it('二重復元・存在しない id は false。削除していないスレッドの復元も false', () => {
    store.removeThread('thread-1')
    expect(store.restoreThread('thread-1')).toBe(true)
    expect(store.restoreThread('thread-1')).toBe(false)
    expect(store.restoreThread('no-such-thread')).toBe(false)

    const other = store.createThread({
      id: 'thread-2',
      title: '別のスレッド',
      cwd: '/Users/tester/other',
      allowedDirs: ['/Users/tester/other'],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    expect(other.id).toBe('thread-2')
    expect(store.restoreThread('thread-2')).toBe(false)
  })

  it('削除済み一覧は削除の新しい順', () => {
    store.createThread({
      id: 'thread-2',
      title: '2 番目',
      cwd: '/Users/tester/two',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    store.removeThread('thread-1', 1000)
    store.removeThread('thread-2', 2000)
    expect(store.listDeletedThreads().map((t) => t.id)).toEqual(['thread-2', 'thread-1'])
  })
})

describe('ThreadStore — 保存してよいもの / いけないもの', () => {
  it('tool_result の中身を保存しない (制約 10)', () => {
    store.appendEvents(thread, 'session-1', [
      event({
        id: 'tr',
        kind: 'tool_result',
        payload: { toolUseId: 't1', ok: true, bytes: 4096, text: 'SECRET FILE CONTENTS' }
      })
    ])
    const raw = db.prepare(`SELECT payload FROM thread_events WHERE id = 'tr'`).get() as {
      payload: string
    }
    expect(raw.payload).not.toContain('SECRET FILE CONTENTS')
    expect(raw.payload).toContain('4096')

    const [restored] = store.readTimeline('thread-1')
    if (restored?.kind !== 'tool_result') throw new Error('wrong kind')
    // After restoring, only the length and the success flag remain. The UI draws 'omitted (N KB)'.
    expect(restored.payload.text).toBeUndefined()
    expect(restored.payload.bytes).toBe(4096)
    expect(restored.payload.ok).toBe(true)
  })

  it('delta (本文・思考) を保存しない (4.3.1)', () => {
    const written = store.appendEvents(thread, 'session-1', [
      event({ kind: 'assistant_delta', payload: { text: 'abc' } }),
      event({ kind: 'thinking_delta', payload: { text: 'なるほど' } }),
      event({ kind: 'assistant_text', payload: { text: 'abc' } })
    ])
    expect(written.written).toBe(1)
    const kinds = store.readTimeline('thread-1').map((e) => e.kind)
    expect(kinds).toEqual(['assistant_text'])
  })

  it('TODO 686 の code-review: previewChanged は親の user_text / assistant_text を書いたときだけ真', () => {
    // A child's message (actor subagent) is not used as the list preview: previewChanged is false even though written > 0.
    const child = store.appendEvents(thread, 'session-1', [
      event({ kind: 'assistant_text', actor: 'subagent', payload: { text: '子の発言' } })
    ])
    expect(child.written).toBe(1)
    expect(child.previewChanged).toBe(false)
    // Other kinds such as tool_use are also false.
    const tool = store.appendEvents(thread, 'session-1', [
      event({ kind: 'tool_use', payload: { toolUseId: 't1', name: 'Read', summary: 'x', input: {}, truncated: false } })
    ])
    expect(tool.written).toBe(1)
    expect(tool.previewChanged).toBe(false)
    // The parent's user_text / assistant_text are true.
    const parent = store.appendEvents(thread, 'session-1', [event({ kind: 'user_text', payload: { text: '親の発言' } })])
    expect(parent.written).toBe(1)
    expect(parent.previewChanged).toBe(true)
  })

  it('turn_usage は数値とモデル名だけなので残り、latestTurnUsage が最後の 1 件を返す (項目 60)', () => {
    const usage = (id: string, cacheRead: number, actor: 'main' | 'subagent' = 'main') =>
      event({
        id,
        kind: 'turn_usage',
        actor,
        payload: { model: 'model-x', inputTokens: 2, outputTokens: 1, cacheCreationTokens: 10, cacheReadTokens: cacheRead }
      })
    expect(store.latestTurnUsage('thread-1')).toBeNull()
    const written = store.appendEvents(thread, 'session-1', [usage('u1', 100), usage('u2', 200), usage('u3', 999, 'subagent')])
    expect(written.written).toBe(3)
    // A subagent's entries are a separate context, so main's last one (u2) is returned.
    expect(store.latestTurnUsage('thread-1')).toEqual({
      model: 'model-x',
      inputTokens: 2,
      outputTokens: 1,
      cacheCreationTokens: 10,
      cacheReadTokens: 200
    })
  })

  it('model / thinking の切り替え (settings_changed) は toPersistable を通って残る (T7)', () => {
    const written = store.appendEvents(thread, 'session-1', [
      event({
        id: 'sc',
        kind: 'settings_changed',
        payload: { modelId: 'some-model', thinking: 'high', scope: 'message' }
      })
    ])
    expect(written.written).toBe(1)
    const restored = store.readTimeline('thread-1')[0]
    if (restored?.kind !== 'settings_changed') throw new Error('wrong kind')
    expect(restored.payload).toEqual({
      modelId: 'some-model',
      thinking: 'high',
      scope: 'message'
    })
    // Not a message body, so it is not in the index (not among the kinds in 6.1).
    expect(store.eventText('sc')).toBeNull()
  })

  it('result の cacheTtlMs (TODO 466) は数だけなので toPersistable を通って残り、本文 (text) は落ちる', () => {
    store.appendEvents(thread, 'session-1', [
      event({
        id: 'r1',
        kind: 'result',
        payload: {
          ok: true,
          subtype: 'success',
          turns: 1,
          durationMs: 1234,
          costUsd: 0,
          usage: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 },
          stopReason: null,
          denials: [],
          text: '最後の応答の本文',
          cacheTtlMs: 3_600_000
        }
      })
    ])
    const restored = store.readTimeline('thread-1')[0]
    if (restored?.kind !== 'result') throw new Error('wrong kind')
    expect(restored.payload.cacheTtlMs).toBe(3_600_000)
    expect(restored.payload.text).toBeNull()
  })

  it('保存前に redaction を通す (ユーザ発言にも)', () => {
    store.appendEvents(thread, 'session-1', [
      event({ id: 'u', kind: 'user_text', payload: { text: 'api_key=abcd1234efgh5678 で試して' } }),
      event({
        id: 'a',
        kind: 'assistant_text',
        payload: { text: '了解です。Bearer abcdefghij0123456789 を使います' }
      }),
      event({
        id: 't',
        kind: 'tool_use',
        payload: {
          toolUseId: 't1',
          name: 'Bash',
          summary: 'curl -H "Authorization: Bearer sk-abc123DEF456ghi789"',
          input: { command: 'curl -H "Authorization: Bearer sk-abc123DEF456ghi789"' },
          truncated: false
        }
      })
    ])
    const rows = db.prepare(`SELECT payload FROM thread_events`).all() as { payload: string }[]
    const all = rows.map((r) => r.payload).join('\n')
    expect(all).not.toContain('abcd1234efgh5678')
    expect(all).not.toContain('abcdefghij0123456789')
    expect(all).not.toContain('sk-abc123DEF456ghi789')
    expect(all).toContain('[redacted]')
    // The context remains.
    expect(all).toContain('で試して')
  })

  it('TODO 403: 親が指定した子の model (subagentModel) は保存しない (runtime だけ)', () => {
    store.appendEvents(thread, 'session-1', [
      event({
        id: 'spawn',
        kind: 'tool_use',
        payload: {
          toolUseId: 'agent-1',
          name: 'Agent',
          summary: 'd',
          input: { description: 'd' },
          truncated: false,
          subagentModel: 'sonnet'
        }
      })
    ])
    const restored = store.readTimeline('thread-1')[0]
    if (restored?.kind !== 'tool_use') throw new Error('wrong kind')
    expect(restored.payload.toolUseId).toBe('agent-1')
    expect('subagentModel' in restored.payload).toBe(false)
  })

  it('項目 93: 裏で動く作業は開始と終わりだけ残し、説明と要約に redaction を通す', () => {
    store.appendEvents(thread, 'session-1', [
      event({
        id: 's',
        kind: 'subtask_started',
        payload: {
          taskId: 'a',
          toolUseId: 'tu-a',
          description: 'token=abcd1234efgh5678 で調べる',
          subagentType: 'general-purpose',
          isSubagent: true,
          isBackgroundShell: false
        }
      }),
      event({
        id: 'p',
        kind: 'subtask_progress',
        payload: {
          taskId: 'a',
          toolUseId: 'tu-a',
          description: null,
          activity: null,
          subagentType: null,
          status: null,
          usage: { totalTokens: 1, toolUses: 1, durationMs: 1 },
          lastToolName: 'Read',
          summary: '途中'
        }
      }),
      event({
        id: 'f',
        kind: 'subtask_finished',
        payload: {
          taskId: 'a',
          toolUseId: 'tu-a',
          status: 'completed',
          summary: '結果は Bearer abcdefghij0123456789 で取れた',
          usage: { totalTokens: 100, toolUses: 3, durationMs: 900 },
          outputFile: '/tmp/tasks/a.output'
        }
      })
    ])
    const rows = db.prepare(`SELECT kind, payload FROM thread_events ORDER BY seq`).all() as {
      kind: string
      payload: string
    }[]
    expect(rows.map((r) => r.kind)).toEqual(['subtask_started', 'subtask_finished'])
    const all = rows.map((r) => r.payload).join('\n')
    expect(all).not.toContain('abcd1234efgh5678')
    expect(all).not.toContain('abcdefghij0123456789')
    expect(all).toContain('[redacted]')
    const finished = JSON.parse(rows[1]?.payload ?? '{}') as Record<string, unknown>
    expect(finished['usage']).toEqual({ totalTokens: 100, toolUses: 3, durationMs: 900 })
    expect(finished['outputFile']).toBe('/tmp/tasks/a.output')
    // Not a message body, so it is not in conversation search either.
    expect(store.eventText('s')).toBeNull()
  })

  it("retention='none' では 1 行も書かない", () => {
    const secret: Thread = { ...thread, retention: 'none' }
    store.setRetention('thread-1', 'none', null)
    const written = store.appendEvents(secret, 'session-1', [
      event({ kind: 'user_text', payload: { text: '機密の作業' } })
    ])
    expect(written.written).toBe(0)
    expect(written.previewChanged).toBe(false)
    expect(store.readTimeline('thread-1')).toHaveLength(0)
  })

  it('未知のイベントは hint を残す。本文の無い JSON はそのまま残る (4.6 / D-8)', () => {
    store.appendEvents(thread, 'session-1', [
      event({ id: 'x', kind: 'unknown', payload: { raw: '{"type":"future"}', hint: 'future' } })
    ])
    const [restored] = store.readTimeline('thread-1')
    if (restored?.kind !== 'unknown') throw new Error('wrong kind')
    expect(restored.payload.hint).toBe('future')
    expect(restored.payload.raw).toBe('{"type":"future"}')
  })

  it('未知のイベントは本文を運びうる欄を落として保存する (レビュー D-8、2026-09-27)', () => {
    const raw = JSON.stringify({
      type: 'future_tool',
      tool_use_id: 't1',
      content: 'secret body text',
      nested: { result: { text: 'more secret text' }, stdout: 'stdout body', keep: 'kept' }
    })
    store.appendEvents(thread, 'session-1', [event({ id: 'x', kind: 'unknown', payload: { raw, hint: 'future_tool' } })])
    const [restored] = store.readTimeline('thread-1')
    if (restored?.kind !== 'unknown') throw new Error('wrong kind')
    expect(restored.payload.raw).not.toContain('secret body text')
    expect(restored.payload.raw).not.toContain('more secret text')
    expect(restored.payload.raw).not.toContain('stdout body')
    expect(restored.payload.raw).toContain('t1')
    expect(restored.payload.raw).toContain('kept')
    // The body must not remain in the saved raw data (`row.payload`) itself either.
    const rows = db
      .prepare(`SELECT payload FROM thread_events WHERE thread_id = 'thread-1'`)
      .all() as { payload: string }[]
    for (const row of rows) {
      expect(row.payload).not.toContain('secret body text')
    }
  })

  it('パースできない生データは本文を残さず捨てる (レビュー D-8)', () => {
    store.appendEvents(thread, 'session-1', [
      event({ id: 'x', kind: 'unknown', payload: { raw: '{not json, "prompt": "secret"', hint: 'invalid-json' } })
    ])
    const [restored] = store.readTimeline('thread-1')
    if (restored?.kind !== 'unknown') throw new Error('wrong kind')
    expect(restored.payload.hint).toBe('invalid-json')
    expect(restored.payload.raw).toBe('')
  })

  it('承認の決着を同じ行に上書きする (pending → denied)', () => {
    const base = {
      requestId: 'r1',
      toolUseId: 't1',
      toolName: 'Bash',
      summary: 'rm -rf x',
      input: { command: 'rm -rf x' },
      requestedAt: 1000
    }
    store.appendEvents(thread, 'session-1', [
      event({ id: 'p', kind: 'permission_request', payload: { ...base, decidedAt: null, outcome: { kind: 'pending' } } })
    ])
    store.appendEvents(thread, 'session-1', [
      event({
        id: 'p',
        kind: 'permission_request',
        payload: {
          ...base,
          decidedAt: 2000,
          outcome: { kind: 'denied', by: 'user', message: 'ユーザが拒否しました' }
        }
      })
    ])
    const timeline = store.readTimeline('thread-1')
    expect(timeline).toHaveLength(1)
    const [item] = timeline
    if (item?.kind !== 'permission_request') throw new Error('wrong kind')
    expect(item.payload.outcome).toEqual({
      kind: 'denied',
      by: 'user',
      message: 'ユーザが拒否しました'
    })
  })

  it('拒否の注文と選択式の質問の答えに redaction を掛ける (TODO 749)', () => {
    const base = {
      requestId: 'r2',
      toolUseId: 't2',
      toolName: 'Bash',
      summary: 'rm -rf x',
      input: { command: 'rm -rf x' },
      requestedAt: 1000
    }
    store.appendEvents(thread, 'session-1', [
      event({
        id: 'd',
        kind: 'permission_request',
        payload: {
          ...base,
          decidedAt: 2000,
          outcome: { kind: 'denied', by: 'user', message: '代わりに password=hunter2 を使って' }
        }
      })
    ])
    store.appendEvents(thread, 'session-1', [
      event({
        id: 'a',
        kind: 'permission_request',
        payload: {
          ...base,
          requestId: 'r3',
          toolUseId: 't3',
          decidedAt: 3000,
          outcome: { kind: 'allowed', by: 'user', answer: 'その他: PASSWORD: s3cr3t!' }
        }
      })
    ])
    const timeline = store.readTimeline('thread-1')
    const denied = timeline.find((e) => e.id === 'd')
    const allowed = timeline.find((e) => e.id === 'a')
    if (denied?.kind !== 'permission_request') throw new Error('wrong kind')
    if (allowed?.kind !== 'permission_request') throw new Error('wrong kind')
    expect(denied.payload.outcome).toMatchObject({ kind: 'denied' })
    if (denied.payload.outcome.kind !== 'denied') throw new Error('wrong outcome kind')
    expect(denied.payload.outcome.message).not.toContain('hunter2')
    expect(allowed.payload.outcome).toMatchObject({ kind: 'allowed' })
    if (allowed.payload.outcome.kind !== 'allowed') throw new Error('wrong outcome kind')
    expect(allowed.payload.outcome.answer).not.toContain('s3cr3t')
    // The body (secret) must not remain in the saved raw data either.
    const rows = db
      .prepare(`SELECT payload FROM thread_events WHERE thread_id = 'thread-1' AND id IN ('d', 'a')`)
      .all() as { payload: string }[]
    for (const row of rows) {
      expect(row.payload).not.toContain('hunter2')
      expect(row.payload).not.toContain('s3cr3t')
    }
  })
})

describe('ThreadStore — セッション', () => {
  it('通常の再開では行が増えない (spike 1: --resume で ID が変わらない)', () => {
    store.recordSession({
      id: 's1',
      threadId: 'thread-1',
      backendSessionId: 'backend-abc',
      forkedFrom: null,
      backendVersion: '2.1.207'
    })
    store.recordSession({
      id: 's2',
      threadId: 'thread-1',
      backendSessionId: 'backend-abc', // Same, since it is a resume.
      forkedFrom: null,
      backendVersion: '2.1.207'
    })
    const count = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }
    expect(count.n).toBe(1)
    expect(store.latestBackendSessionId('thread-1')).toBe('backend-abc')
  })

  it('累積ターン数とコストは aios 側で数える', () => {
    store.recordSession({
      id: 's1',
      threadId: 'thread-1',
      backendSessionId: 'backend-abc',
      forkedFrom: null,
      backendVersion: null
    })
    store.addTurn('backend-abc', 0.0168)
    store.addTurn('backend-abc', 0.0168)
    const totals = store.sessionTotals('thread-1')
    expect(totals.turns).toBe(2)
    expect(totals.costUsd).toBeCloseTo(0.0336, 5)
  })

  it('再開後のターンも同じ行に積む (内部 ID は振り直される)', () => {
    // `--resume` does not change the backend's session_id, so the row stays as one. aios's internal session ID is renewed at every launch, so it **cannot be the key**.
    store.recordSession({
      id: 'internal-1',
      threadId: 'thread-1',
      backendSessionId: 'backend-abc',
      forkedFrom: null,
      backendVersion: null
    })
    store.addTurn('backend-abc', 0.01)
    store.recordSession({
      id: 'internal-2', // The new internal ID assigned by the resume.
      threadId: 'thread-1',
      backendSessionId: 'backend-abc',
      forkedFrom: null,
      backendVersion: null
    })
    store.addTurn('backend-abc', 0.02)

    const totals = store.sessionTotals('thread-1')
    expect(totals.turns).toBe(2)
    expect(totals.costUsd).toBeCloseTo(0.03, 5)
  })
})

describe('ThreadStore — retention と一括削除 (4.3.1)', () => {
  it('N 日を過ぎた行を落とす', () => {
    store.setRetention('thread-1', 'days', 7)
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000
    store.appendEvents({ ...thread, retention: 'days', retentionDays: 7 }, 's1', [
      event({ id: 'old', ts: old, kind: 'user_text', payload: { text: '古い' } }),
      event({ id: 'new', kind: 'user_text', payload: { text: '新しい' } })
    ])
    store.applyRetention()
    const ids = store.readTimeline('thread-1').map((e) => e.id)
    expect(ids).toEqual(['new'])
  })

  it('全会話ログの削除はスレッドを残す', () => {
    store.appendEvents(thread, 's1', [event({ kind: 'user_text', payload: { text: 'hi' } })])
    store.clearAllTimelines()
    expect(store.readTimeline('thread-1')).toHaveLength(0)
    expect(store.getThread('thread-1')).not.toBeNull()
  })
})

describe('ThreadStore — 設定', () => {
  it('既定は spike 5 の推奨に従う', () => {
    const settings = store.readSettings()
    expect(settings.maxConcurrent).toBe(5)
    expect(settings.maxConcurrentCap).toBe(8)
    expect(settings.defaultRetention).toBe('forever')
  })

  it('保存して読み戻せる', () => {
    store.writeSettings({ ...store.readSettings(), maxConcurrent: 3 })
    expect(store.readSettings().maxConcurrent).toBe(3)
  })
})

describe('承認規則の永続化 (T22 / T40、`app_settings` の `approval.rules`)', () => {
  /** Creates one 'always allow'. It goes through the Broker, so the real path is used as is. */
  async function always(
    broker: ApprovalBroker,
    toolName: string,
    input: object,
    threadId = 'thread-1'
  ): Promise<void> {
    const pending = broker.request({
      threadId,
      threadTitle: 'テスト',
      toolName,
      summary: '',
      input: input as never
    })
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    await pending
  }

  const STOP_ALL = { autoAllowAll: false, autoAllowTools: [], bashDenyPatterns: [] }

  function makeBroker(target: ThreadStore = store): ApprovalBroker {
    return new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, STOP_ALL, target)
  }

  it('「常に許可」→ 新しい ThreadStore + Broker で効く (再起動をまたぐ往復)', async () => {
    await always(makeBroker(), 'Bash', { command: './build.sh  all' })

    // 'Restart': the ThreadStore and the Broker are rebuilt on the same DB.
    const broker = makeBroker(new ThreadStore(db, HOME))
    const rules = broker.listRules()
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ toolName: 'Bash', command: './build.sh all' })
    expect(
      await broker.request({
        threadId: 'thread-1',
        threadTitle: 'テスト',
        toolName: 'Bash',
        summary: '',
        input: { command: './build.sh all' } as never
      })
    ).toMatchObject({ by: 'rule' })
  })

  /** The point of T40. If it does not work across threads, this change means nothing. */
  it('**別のスレッドでも効く** (T40: 新しいスレッドで聞き直さない)', async () => {
    const broker = makeBroker()
    await always(broker, 'Bash', { command: './build.sh all' }, 'thread-1')
    store.createThread({
      id: 'thread-2',
      title: '別',
      cwd: '/Users/tester/work',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    expect(
      await broker.request({
        threadId: 'thread-2',
        threadTitle: '別',
        toolName: 'Bash',
        summary: '',
        input: { command: './build.sh all' } as never
      })
    ).toMatchObject({ by: 'rule' })
  })

  it('スレッドを消しても規則は残る (アプリ全体の設定なので)', async () => {
    await always(makeBroker(), 'Read', { file_path: '/a' })
    expect(store.loadApprovalRules()).toHaveLength(1)
    store.removeThread('thread-1')
    expect(store.loadApprovalRules()).toHaveLength(1)
  })

  it('作業フォルダの外を触る要求でも通る (規則に場所の概念が無い — T40)', async () => {
    const broker = makeBroker()
    await always(broker, 'Write', { file_path: join(HOME, 'proj', 'a.txt') })
    expect(
      await broker.request({
        threadId: 'thread-1',
        threadTitle: 'テスト',
        toolName: 'Write',
        summary: '',
        input: { file_path: '/tmp/なにか.txt' } as never,
        cwd: join(HOME, 'proj')
      })
    ).toMatchObject({ by: 'rule' })
  })

  it('規則ができた後の同じ要求は積まれない (2 行目ができる余地が無い)', async () => {
    const broker = makeBroker()
    await always(broker, 'Read', { file_path: '/a' })
    // The second time, the rule matches and passes immediately, so there is no chance to press 'always allow' in the first place.
    expect(
      await broker.request({
        threadId: 'thread-1',
        threadTitle: 'テスト',
        toolName: 'Read',
        summary: '',
        input: { file_path: '/b' } as never
      })
    ).toMatchObject({ by: 'rule' })
    expect(broker.listRules()).toHaveLength(1)
    expect(store.loadApprovalRules()).toHaveLength(1)
  })

  it('壊れた JSON / 形の合わない要素は落とす', () => {
    const settings = new AppSettingsStore(db)
    settings.write('approval.rules', '{壊れ')
    expect(store.loadApprovalRules()).toHaveLength(0)

    settings.writeJson('approval.rules', [
      { id: 'ok', toolName: 'Read', command: null, createdAt: 1 },
      { id: '', toolName: 'Read', command: null, createdAt: 1 },
      { id: 'x', toolName: 'Read', command: null, createdAt: 'いつか' },
      { id: 'y', toolName: 'Read', command: 7, createdAt: 1 },
      'ただの文字列',
      null
    ])
    expect(store.loadApprovalRules().map((r) => r.id)).toEqual(['ok'])
  })

  it('migration 11 でスレッドの列は消えている (置き場は 1 つだけ)', () => {
    const columns = db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[]
    expect(columns.map((c) => c.name)).not.toContain('approval_rules')
  })

  it('既定は空配列', () => {
    expect(store.loadApprovalRules()).toEqual([])
  })
})

describe('threadCwdName (T18 / TODO 22)', () => {
  it('末尾のディレクトリ名を返す', () => {
    expect(threadCwdName('/Users/tester/git/hoge', HOME)).toBe('hoge')
  })

  it('ホームそのものは ~', () => {
    expect(threadCwdName(HOME, HOME)).toBe('~')
    // A trailing / and case differences are folded as the same (APFS is case-insensitive by default).
    expect(threadCwdName('/Users/tester/', HOME)).toBe('~')
    expect(threadCwdName('/users/tester', HOME)).toBe('~')
  })

  it('末尾スラッシュを名前に混ぜない', () => {
    expect(threadCwdName('/Users/tester/git/hoge/', HOME)).toBe('hoge')
    expect(threadCwdName('/Users/tester/git/hoge//', HOME)).toBe('hoge')
  })

  it('捨て場は空文字列。UUID もラベルも出さない (T19 / TODO 62)', () => {
    const id = '7a851af7-8169-4bfa-ae3a-64caa3624db4'
    expect(threadCwdName(scratchCwd(HOME, id), HOME)).toBe('')
    // A thread that chose another thread's dump is treated the same way.
    expect(threadCwdName(scratchCwd(HOME, 'ffffffff-0000-0000-0000-000000000000'), HOME)).toBe('')
    // The root of the dump itself, two levels down, and a false prefix match are not folded.
    expect(threadCwdName('/Users/tester/aios/scratch', HOME)).toBe('scratch')
    expect(threadCwdName(`/Users/tester/aios/scratch/${id}/out`, HOME)).toBe('out')
    expect(threadCwdName('/Users/tester/aios/scratchy/hoge', HOME)).toBe('hoge')
  })

  it('cwd を持たない古い行は空文字列 (呼び出し側は何も描かない)', () => {
    expect(threadCwdName('', HOME)).toBe('')
    expect(threadCwdName('   ', HOME)).toBe('')
  })

  it('ルートだけは / と出す (basename が空になる)', () => {
    expect(threadCwdName('/', HOME)).toBe('/')
  })
})

describe('ThreadStore — 一覧の 1 行を列に持つ (項目 75、migration 14)', () => {
  const text = (kind: 'user_text' | 'assistant_text', body: string): AiosEvent =>
    event({ kind, payload: { text: body } } as Parameters<typeof event>[0])

  function recordOf(id: string): ThreadRecord {
    const found = store.listThreadRecords().find((r) => r.thread.id === id)
    if (found === undefined) throw new Error('not listed')
    return found
  }

  it('addTurn はセッションの行とスレッドの行を同時に進める', () => {
    store.recordSession({
      id: 's1',
      threadId: 'thread-1',
      backendSessionId: 'b1',
      forkedFrom: null,
      backendVersion: null
    })
    store.addTurn('b1', 0.01)
    store.addTurn('b1', 0.02)
    const record = recordOf('thread-1')
    expect(record.turns).toBe(2)
    expect(record.costUsd).toBeCloseTo(0.03, 5)
    // Does not disagree with the recounted breakdown.
    expect(store.sessionTotals('thread-1').turns).toBe(record.turns)
    expect(store.sessionTotals('thread-1').costUsd).toBeCloseTo(record.costUsd, 10)
    expect(record.latestBackendSessionId).toBe('b1')
    expect(store.getThreadRecord('thread-1')).toEqual(record)
  })

  it('プレビューは最後の発言で決まり、previewOf (数え直し) と一致する', () => {
    expect(recordOf('thread-1').preview).toBeNull()
    store.appendEvents(thread, null, [text('user_text', '質問  です\n改行')])
    expect(recordOf('thread-1').preview).toBe('質問 です 改行')
    // A kind that is not a message does not move the preview.
    store.appendEvents(thread, null, [
      event({
        kind: 'tool_result',
        payload: { toolUseId: 't', ok: true, bytes: 3, text: 'x' }
      } as Parameters<typeof event>[0])
    ])
    expect(recordOf('thread-1').preview).toBe('質問 です 改行')
    store.appendEvents(thread, null, [text('assistant_text', 'a'.repeat(300))])
    expect(recordOf('thread-1').preview).toBe('a'.repeat(120))
    expect(recordOf('thread-1').preview).toBe(store.previewOf('thread-1'))
  })

  it('プレビューは redaction 後の文から作る', () => {
    const secret = 'sk-ant-api03-' + 'x'.repeat(40)
    store.appendEvents(thread, null, [text('user_text', `鍵は ${secret} です`)])
    expect(recordOf('thread-1').preview).not.toContain(secret)
    expect(recordOf('thread-1').preview).toBe(store.previewOf('thread-1'))
  })

  it('会話ログを消すとプレビューも消える (1 件 / 全件 / retention)', () => {
    store.appendEvents(thread, null, [text('user_text', '残らない')])
    store.clearTimeline('thread-1')
    expect(recordOf('thread-1').preview).toBeNull()

    store.appendEvents(thread, null, [text('user_text', '残らない')])
    store.clearAllTimelines()
    expect(recordOf('thread-1').preview).toBeNull()

    // With an N-day retention, if the last message is dropped, it returns to the last one among those kept.
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    store.appendEvents(thread, null, [
      { ...text('user_text', '古いけど残る'), ts: now - 2 * day },
      { ...text('assistant_text', 'もっと新しいのに消える'), ts: now - 10 * day }
    ])
    store.setRetention('thread-1', 'days', 5)
    store.applyRetention(now)
    expect(recordOf('thread-1').preview).toBe('古いけど残る')
  })

  it("retention='none' のスレッドはプレビューを持たない (1 行も書かないので)", () => {
    const none = store.createThread({
      id: 'thread-none',
      title: 'n',
      cwd: '/w',
      allowedDirs: [],
      retention: 'none',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    store.appendEvents(none, null, [text('user_text', '書かれない')])
    expect(recordOf('thread-none').preview).toBeNull()
  })

  it('既存 DB は migration 14 が累積とプレビューを 1 回だけ埋め戻す (壊れた payload でも落ちない)', () => {
    const old = new Database(':memory:')
    for (const migration of MIGRATIONS.filter((m) => m.version <= 13)) old.exec(migration.up)
    old.pragma('user_version = 13')
    const insertThread = old.prepare(`
      INSERT INTO threads (id, title, cwd, allowed_dirs, retention, unread, archived,
                           setting_sources, backend, approval_strict, created_at, updated_at)
      VALUES (?, 't', '/w', '[]', 'forever', 0, 0, '["project"]', 'agent-cli', 0, 1, 1)`)
    for (const id of ['a', 'b', 'c']) insertThread.run(id)
    const insertSession = old.prepare(
      `INSERT INTO sessions (id, thread_id, backend_session_id, started_at, turns, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    insertSession.run('s1', 'a', 'b1', 1, 2, 0.5)
    insertSession.run('s2', 'a', 'b2', 2, 3, 0.25)
    const insertEvent = old.prepare(`
      INSERT INTO thread_events (id, thread_id, session_id, seq, ts, kind, actor, payload, payload_bytes)
      VALUES (?, ?, NULL, ?, 1, ?, 'main', ?, 0)`)
    insertEvent.run('e1', 'a', 1, 'user_text', JSON.stringify({ text: '最初' }))
    insertEvent.run('e2', 'a', 2, 'assistant_text', JSON.stringify({ text: '最後の  回答' }))
    insertEvent.run('e3', 'a', 3, 'tool_use', JSON.stringify({ name: 'Read' }))
    insertEvent.run('e4', 'b', 1, 'user_text', '{壊れた')

    expect(runMigrations(old)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version)
    const rows = old.prepare(`SELECT id, turns, cost_usd, preview FROM threads ORDER BY id`).all()
    expect(rows).toEqual([
      { id: 'a', turns: 5, cost_usd: 0.75, preview: '最後の  回答' },
      { id: 'b', turns: 0, cost_usd: 0, preview: null },
      { id: 'c', turns: 0, cost_usd: 0, preview: null }
    ])
    // The reader normalizes it (SQL backfill cannot fold whitespace). The latest session is in started_at order.
    const migrated = new ThreadStore(old, HOME)
    expect(migrated.getThreadRecord('a')?.preview).toBe('最後の 回答')
    expect(migrated.getThreadRecord('a')?.latestBackendSessionId).toBe('b2')
    old.close()
  })
})
