/**
 * TODO 983 stage 2: the settings table (editing scheduled jobs). Listing, deleting one row at a time, sweeping expired ones, deleting jobs / conversations, recording use,
 * and `tool` rows for a tool of unknown read/write nature have no effect. Both directions of enabling and removing are pinned down.
 */
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalBroker, type ApprovalRequestInput } from '../src/main/approval/broker.js'
import { DEFAULT_APPROVAL_POLICY } from '../src/shared/thread.js'
import { RoleGrantStore, type RoleGrantPersistence } from '../src/main/approval/grant-store.js'
import { grantRowOf, type RoleGrantRow } from '../src/main/approval/grants.js'
import { runMigrations } from '../src/common/migrations.js'

function row(over: Partial<RoleGrantRow>): RoleGrantRow {
  return {
    id: over.id ?? 'g1',
    roleKey: 'job:A',
    toolName: 'Bash',
    subjectKind: 'command-prefix',
    subject: 'docker build',
    subjectHash: null,
    access: null,
    scope: 'forever',
    threadId: null,
    expiresAt: null,
    source: 'approval',
    createdAt: 1000,
    lastUsedAt: null,
    useCount: 0,
    ...over
  }
}

class MemoryGrants implements RoleGrantPersistence {
  rows: RoleGrantRow[] = []
  removed: string[] = []
  fail = false
  loadRoleGrants(): readonly RoleGrantRow[] {
    return this.rows
  }
  addRoleGrants(rows: readonly RoleGrantRow[]): void {
    this.rows.push(...rows)
  }
  removeRoleGrants(ids: readonly string[]): void {
    if (this.fail) throw new Error('disk')
    this.removed.push(...ids)
    this.rows = this.rows.filter((r) => !ids.includes(r.id))
  }
  touchRoleGrants(ids: readonly string[], now: number): void {
    this.rows = this.rows.map((r) => (ids.includes(r.id) ? { ...r, lastUsedAt: now, useCount: r.useCount + 1 } : r))
  }
}

function makeBroker(store: MemoryGrants, readOnly: ((tool: string, threadId: string | null) => boolean) | null = null): ApprovalBroker {
  const broker = new ApprovalBroker({ onChanged: () => undefined, onDecided: () => undefined }, DEFAULT_APPROVAL_POLICY, null, store)
  broker.setReadOnlyToolLookup(readOnly)
  return broker
}

const ROLE_A = { key: 'job:A', name: '朝の集計' }

function bash(command: string, over: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    threadId: 't1',
    threadTitle: 'job',
    toolName: 'Bash',
    summary: command,
    input: { command },
    strict: true,
    role: ROLE_A,
    grantSubject: { kind: 'command', command },
    ...over
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const HOUR = 3_600_000

describe('設定の表 (983 段 2)', () => {
  it('一覧: その role の効く行だけ。期限切れは出さず、掃いて置き場からも消す', () => {
    const store = new MemoryGrants()
    store.rows.push(
      row({ id: 'forever' }),
      row({ id: 'today', scope: 'today', expiresAt: Date.now() + HOUR, subject: 'make' }),
      row({ id: 'old', scope: 'today', expiresAt: Date.now() - 1000, subject: 'terraform plan' }),
      row({ id: 'other', roleKey: 'job:B' })
    )
    const broker = makeBroker(store)
    // Expired rows are swept at startup loading.
    expect(store.removed).toEqual(['old'])
    expect(broker.listRoleGrants('job:A').map((r) => r.id)).toEqual(['forever', 'today'])
    expect(broker.listRoleGrants('job:B').map((r) => r.id)).toEqual(['other'])
    expect(broker.listRoleGrants('job:none')).toEqual([])
  })

  it('期限を過ぎた行は効かない / 期限内は効く (両方向)', async () => {
    const store = new MemoryGrants()
    store.rows.push(row({ id: 'live', scope: 'today', expiresAt: Date.now() + HOUR }))
    const broker = makeBroker(store)
    await expect(broker.request(bash('docker build .'))).resolves.toMatchObject({ allowed: true, by: 'rule' })

    const expired = new MemoryGrants()
    const late = makeBroker(expired)
    // Rows that expire after loading (they stay in memory without taking effect, and are swept at matching time).
    ;(late as unknown as { roleGrants: RoleGrantRow[] }).roleGrants.push(row({ id: 'late', scope: 'today', expiresAt: Date.now() - 1 }))
    void late.request(bash('docker build .'))
    await settle()
    expect(late.list()).toHaveLength(1)
    expect(late.listRoleGrants('job:A')).toEqual([])
  })

  it('✕: その role の行だけ消せる。消したら次から聞く。別の role の id・知らない id は何も消さない', async () => {
    const store = new MemoryGrants()
    store.rows.push(row({ id: 'a1' }), row({ id: 'b1', roleKey: 'job:B' }))
    const broker = makeBroker(store)
    await expect(broker.request(bash('docker build .'))).resolves.toMatchObject({ by: 'rule' })
    expect(broker.removeRoleGrant('job:A', 'b1')).toBe(false)
    expect(broker.removeRoleGrant('job:A', 'nope')).toBe(false)
    expect(store.rows.map((r) => r.id)).toEqual(['a1', 'b1'])
    expect(broker.removeRoleGrant('job:A', 'a1')).toBe(true)
    expect(store.rows.map((r) => r.id)).toEqual(['b1'])
    void broker.request(bash('docker build .', { threadId: 't2' }))
    await settle()
    expect(broker.list()).toHaveLength(1)
  })

  it('置き場に書けない ✕ は消さない (表に残り、効き続けるのが利用者に見える)', () => {
    const store = new MemoryGrants()
    store.rows.push(row({ id: 'a1' }))
    const broker = makeBroker(store)
    store.fail = true
    expect(broker.removeRoleGrant('job:A', 'a1')).toBe(false)
    expect(broker.listRoleGrants('job:A').map((r) => r.id)).toEqual(['a1'])
  })

  it('ジョブを消すとその role の行が全部消え、他の role は残る', async () => {
    const store = new MemoryGrants()
    store.rows.push(row({ id: 'a1' }), row({ id: 'a2', subject: 'make' }), row({ id: 'b1', roleKey: 'job:B' }))
    const broker = makeBroker(store)
    broker.removeRoleGrantsOf('job:A')
    expect(store.rows.map((r) => r.id)).toEqual(['b1'])
    void broker.request(bash('docker build .'))
    await settle()
    expect(broker.list()).toHaveLength(1)
  })

  it('終了後・置き場の失敗では、ジョブ / 会話の削除もメモリを変えない', () => {
    const store = new MemoryGrants()
    store.rows.push(row({ id: 'a1' }), row({ id: 'th', scope: 'thread', threadId: 't1', subject: 'make' }))
    const broker = makeBroker(store)
    store.fail = true
    broker.removeRoleGrantsOf('job:A')
    broker.dropThread('t1')
    expect(broker.listRoleGrants('job:A').map((r) => r.id)).toEqual(['a1', 'th'])
    store.fail = false
    broker.shutdown()
    expect(broker.removeRoleGrant('job:A', 'a1')).toBe(false)
    expect(store.rows.map((r) => r.id)).toEqual(['a1', 'th'])
  })

  it('自動で通した使用の記録も renderer に知らせる (間引いて 1 回)', async () => {
    vi.useFakeTimers()
    try {
      const store = new MemoryGrants()
      store.rows.push(row({ id: 'a1' }))
      let changed = 0
      const broker = new ApprovalBroker({ onChanged: () => (changed += 1), onDecided: () => undefined }, DEFAULT_APPROVAL_POLICY, null, store)
      await broker.request(bash('docker build .'))
      await broker.request(bash('docker build -t x .', { threadId: 't2' }))
      expect(changed).toBe(0)
      vi.advanceTimersByTime(600)
      expect(changed).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('会話を消すとその会話の「この会話だけ」の行だけが消える', () => {
    const store = new MemoryGrants()
    store.rows.push(
      row({ id: 'th1', scope: 'thread', threadId: 't1' }),
      row({ id: 'th2', scope: 'thread', threadId: 't2', subject: 'make' }),
      row({ id: 'fv' , subject: 'npm run build' })
    )
    const broker = makeBroker(store)
    broker.dropThread('t1')
    expect(store.rows.map((r) => r.id)).toEqual(['th2', 'fv'])
    broker.dropThread('t1')
    expect(store.rows.map((r) => r.id)).toEqual(['th2', 'fv'])
  })

  it('表で通したら last_used_at と use_count を更新する', async () => {
    const store = new MemoryGrants()
    store.rows.push(row({ id: 'a1' }))
    const broker = makeBroker(store)
    await broker.request(bash('docker build .'))
    await broker.request(bash('docker build -t x .', { threadId: 't2' }))
    const [view] = broker.listRoleGrants('job:A')
    expect(view?.useCount).toBe(2)
    expect(view?.lastUsedAt).not.toBeNull()
    expect(store.rows[0]?.useCount).toBe(2)
  })

  it('許した行は ✕ と同じ置き場の行 (足す → 一覧に出る → 消す)', async () => {
    const store = new MemoryGrants()
    const broker = makeBroker(store)
    const first = broker.request(bash('docker build .'))
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-role', scope: 'today' })
    await first
    const [view] = broker.listRoleGrants('job:A')
    expect(view).toMatchObject({ scope: 'today', subjectKind: 'command-prefix', subject: 'docker build' })
    expect(broker.removeRoleGrant('job:A', view?.id ?? '')).toBe(true)
    expect(broker.listRoleGrants('job:A')).toEqual([])
  })
})

describe('書き込みか読み取りか分からない道具の tool の行 (オーナー決定 2026-11-15)', () => {
  const toolRow = (id: string, toolName: string): RoleGrantRow =>
    row({ id, toolName, subjectKind: 'tool', subject: toolName })
  const req = (toolName: string): ApprovalRequestInput => ({
    threadId: 't1',
    threadTitle: 'job',
    toolName,
    summary: '',
    input: {},
    strict: true,
    role: ROLE_A,
    grantSubject: { kind: 'tool' }
  })

  it('読み取り専用と分かる道具の行だけ効き、一覧にも出る。分からない道具の古い行は効かず出ない', async () => {
    const store = new MemoryGrants()
    store.rows.push(toolRow('ro', 'WebSearch'), toolRow('rw', 'mcp__x__send'))
    const broker = makeBroker(store, (tool) => tool === 'WebSearch')
    expect(broker.listRoleGrants('job:A').map((r) => r.id)).toEqual(['ro'])
    await expect(broker.request(req('WebSearch'))).resolves.toMatchObject({ allowed: true, by: 'rule' })
    void broker.request(req('mcp__x__send'))
    await settle()
    expect(broker.list().map((entry) => entry.toolName)).toEqual(['mcp__x__send'])
    // Rows that no longer take effect are also removed from the DB at startup (they are invisible in the table but would remain, and close the hole where they would take effect again when the judgment changes).
    expect(store.rows.map((r) => r.id)).toEqual(['ro'])
    expect(store.removed).toEqual(['rw'])
  })

  it('判定はその会話の Adapter だけ (要求の threadId を渡す)。行は読み取り専用でなければ起動時に消える', async () => {
    const store = new MemoryGrants()
    store.rows.push(toolRow('ro', 'Todo'))
    const asked: Array<string | null> = []
    const broker = makeBroker(store, (tool, threadId) => {
      asked.push(threadId)
      return tool === 'Todo' && threadId !== 'tOther'
    })
    await expect(broker.request(req('Todo'))).resolves.toMatchObject({ by: 'rule' })
    expect(asked).toContain('t1')
    void broker.request({ ...req('Todo'), threadId: 'tOther' })
    await settle()
    expect(broker.list()).toHaveLength(1)
  })

  it('孤児の「この会話だけ」の行は起動時に消す。存在する会話の行・他の行は残す', () => {
    const store = new MemoryGrants()
    store.rows.push(
      row({ id: 'gone', scope: 'thread', threadId: 'dead' }),
      row({ id: 'live', scope: 'thread', threadId: 't1', subject: 'make' }),
      row({ id: 'fv', subject: 'npm run build' })
    )
    const broker = makeBroker(store)
    broker.sweepOrphanThreadGrants((id) => id === 't1')
    expect(store.rows.map((r) => r.id)).toEqual(['live', 'fv'])
    expect(broker.listRoleGrants('job:A').map((r) => r.id)).toEqual(['live', 'fv'])
  })

  it('TODO 1251: 存在しないジョブの job: の行は起動時に消す。生きているジョブの行と job: 以外の行は残す', () => {
    const store = new MemoryGrants()
    store.rows.push(
      row({ id: 'gone', roleKey: 'job:dead' }),
      row({ id: 'live', roleKey: 'job:A', subject: 'make' }),
      row({ id: 'thread', roleKey: 'job:dead', scope: 'thread', threadId: 't1', subject: 'npm run lint' }),
      toolRow('rw', 'mcp__x__send'),
      row({ id: 'nokey', roleKey: 'role:x' })
    )
    const broker = makeBroker(store)
    broker.sweepOrphanJobGrants((key) => (key.startsWith('job:') ? key === 'job:A' : true))
    expect(store.rows.map((r) => r.id)).toEqual(['live', 'rw', 'nokey'])
    expect(broker.listRoleGrants('job:A').map((r) => r.id)).toEqual(['live'])
  })

  it('TODO 1251: 起動時の job: の掃除で DB から消せなければメモリも変えない (次の機会に消える)', () => {
    const store = new MemoryGrants()
    store.rows.push(row({ id: 'gone', roleKey: 'job:dead' }))
    store.fail = true
    const broker = makeBroker(store)
    broker.sweepOrphanJobGrants(() => false)
    expect(store.rows.map((r) => r.id)).toEqual(['gone'])
    store.fail = false
    broker.sweepOrphanJobGrants(() => false)
    expect(store.rows.map((r) => r.id)).toEqual([])
  })

  it('DB から消せなかった掃除はメモリも変えない (行は残り、次の機会に消える)', () => {
    const store = new MemoryGrants()
    store.rows.push(toolRow('rw', 'mcp__x__send'), row({ id: 'gone', scope: 'thread', threadId: 'dead' }))
    store.fail = true
    const broker = makeBroker(store, () => false)
    broker.sweepOrphanThreadGrants(() => false)
    store.fail = false
    expect(store.rows.map((r) => r.id)).toEqual(['rw', 'gone'])
    // If they remain in memory, the next sweep can remove them.
    broker.sweepOrphanThreadGrants(() => false)
    expect(store.rows.map((r) => r.id)).toEqual(['rw'])
  })

  it('読み取り専用かどうかを知らない Broker は tool の行を全部効かせない', async () => {
    const store = new MemoryGrants()
    store.rows.push(toolRow('ro', 'WebSearch'))
    const broker = makeBroker(store, null)
    void broker.request(req('WebSearch'))
    await settle()
    expect(broker.list()).toHaveLength(1)
    expect(broker.listRoleGrants('job:A')).toEqual([])
  })
})

describe('RoleGrantStore の削除と使用の記録', () => {
  const opened: Database.Database[] = []
  afterEach(() => {
    for (const db of opened.splice(0)) db.close()
  })

  it('removeRoleGrants は指した行だけ、touchRoleGrants は回数と時刻を進める', () => {
    const db = new Database(':memory:')
    opened.push(db)
    runMigrations(db)
    const store = new RoleGrantStore(db)
    const a = grantRowOf({ subjectKind: 'command-prefix', subject: 'make', subjectHash: null, access: null }, 'job:A', 'Bash', 'forever', 't1', 1000)
    const b = grantRowOf({ subjectKind: 'host', subject: 'example.com', subjectHash: null, access: null }, 'job:A', 'WebFetch', 'forever', 't1', 2000)
    store.addRoleGrants([a, b])
    store.touchRoleGrants([a.id], 5000)
    store.touchRoleGrants([a.id], 6000)
    expect(store.loadRoleGrants().find((r) => r.id === a.id)).toMatchObject({ lastUsedAt: 6000, useCount: 2 })
    expect(store.loadRoleGrants().find((r) => r.id === b.id)).toMatchObject({ lastUsedAt: null, useCount: 0 })
    store.removeRoleGrants([a.id])
    expect(store.loadRoleGrants().map((r) => r.id)).toEqual([b.id])
    store.removeRoleGrants([])
    store.touchRoleGrants([], 1)
  })
})
