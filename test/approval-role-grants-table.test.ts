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

describe('settings table (983 stage 2)', () => {
  it('list: only the rows in effect for that role; expired ones are not shown and are swept and removed from the location too', () => {
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

  it('an expired row has no effect / one within its expiry has effect (both directions)', async () => {
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

  it('✕: can remove only rows of that role; after removal it asks from the next time; an id of another role or an unknown id removes nothing', async () => {
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

  it('a ✕ that cannot write to the location does not remove (it stays in the table and the user can see it still applies)', () => {
    const store = new MemoryGrants()
    store.rows.push(row({ id: 'a1' }))
    const broker = makeBroker(store)
    store.fail = true
    expect(broker.removeRoleGrant('job:A', 'a1')).toBe(false)
    expect(broker.listRoleGrants('job:A').map((r) => r.id)).toEqual(['a1'])
  })

  it('deleting a job removes all rows of that role and the other roles remain', async () => {
    const store = new MemoryGrants()
    store.rows.push(row({ id: 'a1' }), row({ id: 'a2', subject: 'make' }), row({ id: 'b1', roleKey: 'job:B' }))
    const broker = makeBroker(store)
    broker.removeRoleGrantsOf('job:A')
    expect(store.rows.map((r) => r.id)).toEqual(['b1'])
    void broker.request(bash('docker build .'))
    await settle()
    expect(broker.list()).toHaveLength(1)
  })

  it('after shutdown or on a location failure, deleting a job / conversation does not change memory either', () => {
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

  it('also notifies the renderer of records of use passed automatically (thinned to once)', async () => {
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

  it('deleting a conversation removes only that conversation\'s "this conversation only" rows', () => {
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

  it('passing via the table updates last_used_at and use_count', async () => {
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

  it('an allowed row is the same location row as ✕ (add → appears in the list → remove)', async () => {
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

describe('tool rows for tools not known to write or read (owner decision 2026-11-15)', () => {
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

  it('only rows for tools known to be read-only take effect and appear in the list; old rows for unknown tools have no effect and do not appear', async () => {
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

  it("the judgment is only that conversation's Adapter (pass the request's threadId); rows that are not read-only are removed at launch", async () => {
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

  it('orphaned "this conversation only" rows are removed at launch; rows of existing conversations and other rows remain', () => {
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

  it('TODO 1251: job: rows of nonexistent jobs are removed at launch; rows of live jobs and rows other than job: remain', () => {
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

  it('TODO 1251: if the launch-time job: sweep cannot remove from the DB, memory does not change either (removed at the next chance)', () => {
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

  it('a sweep that could not remove from the DB does not change memory either (the rows stay and are removed at the next chance)', () => {
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

  it('a Broker that does not know whether a tool is read-only makes none of the tool rows take effect', async () => {
    const store = new MemoryGrants()
    store.rows.push(toolRow('ro', 'WebSearch'))
    const broker = makeBroker(store, null)
    void broker.request(req('WebSearch'))
    await settle()
    expect(broker.list()).toHaveLength(1)
    expect(broker.listRoleGrants('job:A')).toEqual([])
  })
})

describe('RoleGrantStore removal and record of use', () => {
  const opened: Database.Database[] = []
  afterEach(() => {
    for (const db of opened.splice(0)) db.close()
  })

  it('removeRoleGrants removes only the rows pointed to, and touchRoleGrants advances the count and time', () => {
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
