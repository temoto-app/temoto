/**
 * TODO 983 stage 4 (wave 97 bundle A, ARCHITECTURE 4.2.5 "stage 4"): the grant table keyed by Teammate (`role:<roleId>`) next to the job's
 * rows (`job:<jobId>`, not moved), and the Teammate defaults (TODO 1109 item 1: OS sandbox ON; strict mode per Teammate, default OFF).
 *
 * What is pinned (owner decision 2026-11-21):
 * - What Teammate A was allowed waits for approval in Teammate B; a job's rows apply only to that job's runs (not to another job, nor to
 *   the Teammate's conversations started by hand); a Teammate's job run consults both and a press adds the Teammate's row only.
 * - The role is read from main's `threads.role_id` on every request: after a conversation moves to another Teammate, the new Teammate's
 *   table applies, the old one's "this conversation only" row does not, and a frame queued before the move does not write into the old table.
 * - A fake `allow-role` (no role, or the conversation moved) falls to a one-time allow and makes no row.
 * - Deleting a Teammate deletes its rows (the DB in one transaction with the role, the Broker's memory too); the startup sweep removes
 *   rows of Teammates that are gone.
 * - Migration 47 (`roles.approval_strict`) can be rewound and applied again.
 * Neither the CLI nor the model is started. The DB is the real SQLite code (in memory).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AgentStatus } from '../src/shared/agent.js'
import { AGENT_FEATURES, type AgentFeature } from '../src/shared/agent.js'
import type { ApprovalItem, GrantSubject } from '../src/shared/thread.js'
import { DEFAULT_APPROVAL_POLICY, canAllowForRole, canAllowForThread } from '../src/shared/thread.js'
import { MIGRATIONS, runMigrations } from '../src/common/migrations.js'
import { ApprovalBroker, type ApprovalRequestInput, type ApprovalRole } from '../src/main/approval/broker.js'
import type { RoleGrantPersistence } from '../src/main/approval/grant-store.js'
import { RoleGrantStore } from '../src/main/approval/grant-store.js'
import { grantRowOf, type RoleGrantRow } from '../src/main/approval/grants.js'
import { RoleStore, roleGrantKey } from '../src/main/role/store.js'
import { emptyRoleInput, validateRoleInput } from '../src/shared/role.js'
import { SessionManager } from '../src/main/session/manager.js'
import type { AgentAdapter, AgentInput, AgentSession, SpawnHandlers, SpawnOptions } from '../src/main/session/types.js'
import type { FsAccess } from '../src/main/fs/access.js'
import type { IndexClient } from '../src/main/index/client.js'
import type { GatewayServer } from '../src/main/approval/server.js'

const NOW = Date.now()

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---- Broker level ----

class MemoryGrants implements RoleGrantPersistence {
  rows: RoleGrantRow[] = []
  loadRoleGrants(): readonly RoleGrantRow[] {
    return this.rows
  }
  addRoleGrants(rows: readonly RoleGrantRow[]): void {
    this.rows.push(...rows)
  }
  removeRoleGrants(ids: readonly string[]): void {
    this.rows = this.rows.filter((r) => !ids.includes(r.id))
  }
  touchRoleGrants(): void {}
}

function makeBroker(store: MemoryGrants = new MemoryGrants()): ApprovalBroker {
  return new ApprovalBroker({ onChanged: () => undefined, onDecided: () => undefined }, DEFAULT_APPROVAL_POLICY, null, store)
}

const TEAM_A: ApprovalRole = { key: 'role:A', name: 'Secretary', kind: 'teammate' }
const TEAM_B: ApprovalRole = { key: 'role:B', name: 'Researcher', kind: 'teammate' }
/** A run of job J1 under Teammate A: both keys apply, a press adds to the Teammate's. */
const TEAM_A_JOB: ApprovalRole = { key: 'role:A', name: 'Secretary', kind: 'teammate', keys: ['role:A', 'job:J1'] }
const JOB_1: ApprovalRole = { key: 'job:J1', name: 'Morning' }
const JOB_2: ApprovalRole = { key: 'job:J2', name: 'Evening' }

function bash(command: string, role: ApprovalRole | null, over: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    threadId: 't1',
    threadTitle: 'T',
    toolName: 'Bash',
    summary: command,
    input: { command },
    strict: true,
    role,
    grantSubject: { kind: 'command', command },
    ...over
  }
}

function prefixRow(roleKey: string, subject: string, id = `${roleKey}:${subject}`): RoleGrantRow {
  return { ...grantRowOf({ subjectKind: 'command-prefix', subject, subjectHash: null, access: null }, roleKey, 'Bash', 'forever', 't0', NOW), id }
}

describe('Broker: Teammate keys next to job keys (983 stage 4)', () => {
  it('acceptance: what Teammate A was allowed waits for approval in Teammate B; the frame says Teammate and the row is role:A', async () => {
    const store = new MemoryGrants()
    const broker = makeBroker(store)
    const first = broker.request(bash('docker build .', TEAM_A))
    const item = broker.list()[0]
    expect(item?.roleGrant).toEqual({ roleName: 'Secretary', roleKind: 'teammate', subjects: [{ kind: 'command-prefix', value: 'docker build' }] })
    expect(item !== undefined && canAllowForRole(item) && !canAllowForThread(item)).toBe(true)
    broker.decide(item?.id ?? '', { kind: 'allow-role', scope: 'forever' })
    await expect(first).resolves.toMatchObject({ allowed: true, by: 'user' })
    expect(store.rows.map((row) => row.roleKey)).toEqual(['role:A'])
    // Another conversation of Teammate A passes; Teammate B and a conversation with no role are queued.
    await expect(broker.request(bash('docker build -t x .', TEAM_A, { threadId: 't2' }))).resolves.toMatchObject({ by: 'rule' })
    void broker.request(bash('docker build .', TEAM_B, { threadId: 't3' }))
    void broker.request(bash('docker build .', null, { threadId: 't4' }))
    await settle()
    expect(broker.list().map((entry) => entry.threadId)).toEqual(['t3', 't4'])
  })

  it("a job's rows apply only to that job's runs; a Teammate's job run consults the job's rows and the Teammate's", async () => {
    const store = new MemoryGrants()
    store.rows.push(prefixRow('job:J1', 'docker build'), prefixRow('role:A', 'terraform plan'))
    const broker = makeBroker(store)
    // The run of J1 under Teammate A: both rows apply.
    await expect(broker.request(bash('docker build .', TEAM_A_JOB))).resolves.toMatchObject({ by: 'rule' })
    await expect(broker.request(bash('terraform plan', TEAM_A_JOB))).resolves.toMatchObject({ by: 'rule' })
    // A compound command may use one row of each key (both are rows of this conversation).
    await expect(broker.request(bash('docker build . && terraform plan', TEAM_A_JOB))).resolves.toMatchObject({ by: 'rule' })
    // J1 with no Teammate: only its own rows.
    await expect(broker.request(bash('docker build .', JOB_1, { threadId: 'j1' }))).resolves.toMatchObject({ by: 'rule' })
    void broker.request(bash('terraform plan', JOB_1, { threadId: 'j1b' }))
    // The job's row does not reach Teammate A's conversation started by hand, nor another job.
    void broker.request(bash('docker build .', TEAM_A, { threadId: 'manual' }))
    void broker.request(bash('docker build .', JOB_2, { threadId: 'j2' }))
    await settle()
    expect(broker.list().map((entry) => entry.threadId)).toEqual(['j1b', 'manual', 'j2'])
  })

  it("a Teammate's job run offers one row, the Teammate's (segments a job row already covers are not offered again)", async () => {
    const store = new MemoryGrants()
    store.rows.push(prefixRow('job:J1', 'docker build'))
    const broker = makeBroker(store)
    void broker.request(bash('docker build . && terraform apply', TEAM_A_JOB))
    await settle()
    const item = broker.list()[0]
    expect(item?.roleGrant).toEqual({ roleName: 'Secretary', roleKind: 'teammate', subjects: [{ kind: 'command-prefix', value: 'terraform apply' }] })
    broker.decide(item?.id ?? '', { kind: 'allow-role', scope: 'forever' })
    expect(store.rows.filter((row) => row.roleKey !== 'job:J1').map((row) => [row.roleKey, row.subjectKind])).toEqual([['role:A', 'command-prefix']])
    // A job with no Teammate still adds to the job and its frame says "job" (no roleKind).
    void broker.request(bash('pulumi up', JOB_2, { threadId: 'j2' }))
    await settle()
    expect(broker.list()[0]?.roleGrant).toEqual({ roleName: 'Evening', subjects: [{ kind: 'command-prefix', value: 'pulumi up' }] })
  })

  it('the role is read again from main: a move to another Teammate switches the table, and a frame queued before the move adds nothing', async () => {
    const store = new MemoryGrants()
    store.rows.push(prefixRow('role:B', 'terraform plan'))
    const broker = makeBroker(store)
    const current = new Map<string, ApprovalRole | null>([['t1', TEAM_A]])
    broker.setRoleLookup((threadId) => current.get(threadId) ?? null)
    const before = broker.request(bash('pulumi up', TEAM_A))
    const item = broker.list()[0]
    // Moved to Teammate B while the frame waits. Pressing "Always allow for Teammate A" makes no row (one-time allow).
    current.set('t1', TEAM_B)
    broker.decide(item?.id ?? '', { kind: 'allow-role', scope: 'forever' })
    await expect(before).resolves.toMatchObject({ allowed: true, by: 'user' })
    expect(store.rows.map((row) => row.roleKey)).toEqual(['role:B'])
    // The next request is built with the new role (as the manager does) and B's table applies.
    await expect(broker.request(bash('terraform plan -out x', TEAM_B))).resolves.toMatchObject({ by: 'rule' })
  })

  it('a queued request of a moved conversation is not released by the old Teammate\'s new row', async () => {
    const broker = makeBroker()
    const current = new Map<string, ApprovalRole | null>([
      ['t1', TEAM_A],
      ['t2', TEAM_A]
    ])
    broker.setRoleLookup((threadId) => current.get(threadId) ?? null)
    void broker.request(bash('pulumi up', TEAM_A))
    const moved = broker.request(bash('pulumi up', TEAM_A, { threadId: 't2' }))
    await settle()
    current.set('t2', TEAM_B)
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-role', scope: 'forever' })
    await settle()
    // t2 now belongs to B: still waiting.
    expect(broker.list().map((entry) => entry.threadId)).toEqual(['t2'])
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'deny' })
    await expect(moved).resolves.toMatchObject({ allowed: false })
  })

  it('"do not ask in this conversation" pressed after the conversation moved under a Teammate adds no row and releases nothing', async () => {
    const broker = makeBroker()
    const current = new Map<string, ApprovalRole | null>([['t1', null]])
    broker.setRoleLookup((threadId) => current.get(threadId) ?? null)
    const first = broker.request(bash('pulumi up', null))
    const second = broker.request(bash('pulumi up --yes', null))
    await settle()
    expect(broker.list()[0]?.threadGrant).toBeDefined()
    current.set('t1', TEAM_A)
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-thread' })
    await expect(first).resolves.toMatchObject({ allowed: true, by: 'user' })
    await settle()
    // The other queued request is not released by an in-memory row.
    expect(broker.list()).toHaveLength(1)
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'deny' })
    await expect(second).resolves.toMatchObject({ allowed: false })
  })

  it('a "this conversation only" row of Teammate A stops applying when the conversation moves to Teammate B', async () => {
    const store = new MemoryGrants()
    const broker = makeBroker(store)
    void broker.request(bash('terraform plan', TEAM_A))
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-role', scope: 'thread' })
    expect(store.rows[0]).toMatchObject({ roleKey: 'role:A', scope: 'thread', threadId: 't1' })
    await expect(broker.request(bash('terraform plan', TEAM_A))).resolves.toMatchObject({ by: 'rule' })
    void broker.request(bash('terraform plan', TEAM_B))
    void broker.request(bash('terraform plan', null))
    await settle()
    expect(broker.list()).toHaveLength(2)
  })

  it('a fake allow-role for a conversation with no role falls to a one-time allow', async () => {
    const store = new MemoryGrants()
    const broker = makeBroker(store)
    const plain = broker.request(bash('docker build .', null))
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-role', scope: 'forever' })
    await expect(plain).resolves.toMatchObject({ allowed: true, by: 'user' })
    expect(store.rows).toHaveLength(0)
  })

  it("deleting a Teammate removes its rows (other Teammates' and jobs' remain); the sweep removes rows of Teammates that are gone", async () => {
    const store = new MemoryGrants()
    store.rows.push(prefixRow('role:A', 'docker build'), prefixRow('role:B', 'docker build'), prefixRow('job:J1', 'docker build'))
    store.rows.push(prefixRow('role:gone', 'docker build'))
    const broker = makeBroker(store)
    broker.removeRoleGrantsOf('role:A', 'role-deleted')
    expect(store.rows.map((row) => row.roleKey)).toEqual(['role:B', 'job:J1', 'role:gone'])
    void broker.request(bash('docker build .', TEAM_A))
    await settle()
    expect(broker.list()).toHaveLength(1)
    broker.sweepOrphanRoleGrants((key) => key !== 'role:gone')
    expect(store.rows.map((row) => row.roleKey)).toEqual(['role:B', 'job:J1'])
  })
})

// ---- SessionManager level ----

class FakeSession implements AgentSession {
  alive = true
  readonly sent: AgentInput[] = []
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
}

class FakeAdapter implements AgentAdapter {
  readonly id = 'fake'
  readonly label = 'Fake'
  readonly transcripts = null
  readonly sessions: FakeSession[] = []
  readonly spawns: SpawnOptions[] = []
  readonly spawn = vi.fn(async (options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> => {
    this.spawns.push(options)
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
  grantSubjectOf(toolName: string, input: unknown): GrantSubject | null {
    const command = (input as { command?: unknown }).command
    return toolName === 'Bash' && typeof command === 'string' ? { kind: 'command', command } : null
  }
}

let db: Db
let home: string
let adapter: FakeAdapter
let roles: RoleStore
let manager: SessionManager
const JOB_NAMES: Record<string, string> = { J1: 'Morning', J2: 'Evening' }

function build(): SessionManager {
  const fs = {
    homePath: home,
    homeUri: `file://${home}`,
    defaultReferenceDirs: () => [],
    isReferenceable: () => true,
    isViewable: () => true,
    assertAllowed: (uri: string) => decodeURIComponent(uri.replace('file://', ''))
  } as unknown as FsAccess
  return new SessionManager({
    db,
    adapters: [adapter],
    fs,
    index: {
      indexConversationEvents: () => undefined,
      removeThread: () => undefined,
      removeAllConversations: () => undefined
    } as unknown as IndexClient,
    gateway: { socketPath: '/tmp/aios-test-teammate.sock', issueToken: () => 'token', revokeToken: () => undefined } as unknown as GatewayServer,
    gatewayRuntimePath: '/bin/false',
    gatewayScriptPath: '/dev/null',
    gatewayConfigDir: '/tmp/aios-test-teammate-mcp',
    roles,
    scheduledJobName: (jobId) => JOB_NAMES[jobId] ?? null,
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
  home = mkdtempSync(join(tmpdir(), 'aios-teammate-'))
  db = new Database(':memory:')
  runMigrations(db)
  adapter = new FakeAdapter()
  roles = new RoleStore(db)
  manager = build()
})

afterEach(async () => {
  await manager.stop()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function grantKeysInDb(): string[] {
  return (db.prepare(`SELECT role_key FROM role_grants ORDER BY created_at, rowid`).all() as { role_key: string }[]).map((row) => row.role_key)
}

/** Starts the conversation's process and sends one Bash approval request through the gateway entry point. */
async function approveBash(threadId: string, command: string): Promise<{ allowed: boolean }> {
  await manager.send(threadId, { text: 'go' })
  const session = adapter.sessions.at(-1)
  if (session === undefined) throw new Error('no session')
  const reply = manager.handleGatewayRequest({
    sessionId: session.sessionId,
    kind: 'approve',
    payload: { toolName: 'Bash', toolUseId: `tu-${Math.random()}`, input: { command } }
  }) as Promise<{ allowed?: boolean }>
  return reply.then((value) => ({ allowed: value.allowed === true }))
}

function queued(threadId: string): ApprovalItem | undefined {
  return manager.listApprovals().find((item) => item.threadId === threadId)
}

describe('SessionManager: Teammate defaults (1109 item 1, 983 stage 4)', () => {
  it('a Teammate conversation starts with the OS sandbox ON; strict follows the Teammate toggle (default OFF), OR-ed with the request / job', async () => {
    const relaxed = roles.create({ ...emptyRoleInput(), name: 'Relaxed' })
    const strict = roles.create({ ...emptyRoleInput(), name: 'Strict', approvalStrict: true })
    const byHand = await manager.createThread({ roleId: relaxed.id })
    expect(byHand.osSandbox).toBe(true)
    expect(byHand.approvalStrict).toBe(false)
    // The renderer cannot turn a strict Teammate's conversation non-strict by sending false.
    const strictByHand = await manager.createThread({ roleId: strict.id, approvalStrict: false })
    expect(strictByHand.approvalStrict).toBe(true)
    // A job run under a strict Teammate is strict even if the job is not; a strict job under a relaxed Teammate stays strict.
    expect((await manager.createThread({ roleId: strict.id, approvalStrict: false }, 'J1')).approvalStrict).toBe(true)
    expect((await manager.createThread({ roleId: relaxed.id, approvalStrict: true }, 'J1')).approvalStrict).toBe(true)
    // An ordinary conversation is unchanged (sandbox OFF, strict as requested).
    const plain = await manager.createThread({})
    expect(plain.osSandbox === true).toBe(false)
    expect(plain.approvalStrict).toBe(false)
  })

  it('the strict toggle is saved on the role, checked as a boolean, and given back to the renderer', () => {
    const role = roles.create({ ...emptyRoleInput(), name: 'R', approvalStrict: true })
    expect(roles.get(role.id)?.approvalStrict).toBe(true)
    expect(roles.updateRole(role.id, { ...emptyRoleInput(), name: 'R' })?.approvalStrict).toBe(false)
    expect(validateRoleInput({ name: 'R', approvalStrict: 'yes' })).toBe('invalid-value')
    expect(validateRoleInput({ name: 'R', approvalStrict: true })).toMatchObject({ approvalStrict: true })
  })
})

describe('SessionManager: the grant table by Teammate (983 stage 4)', () => {
  it('acceptance: Teammate A allows, its other conversation passes, Teammate B and a plain strict conversation are asked', async () => {
    const a = roles.create({ ...emptyRoleInput(), name: 'Secretary', approvalStrict: true })
    const b = roles.create({ ...emptyRoleInput(), name: 'Researcher', approvalStrict: true })
    const first = await manager.createThread({ roleId: a.id })
    const pending = approveBash(first.id, 'docker build .')
    await vi.waitFor(() => expect(queued(first.id)).toBeDefined())
    expect(queued(first.id)?.roleGrant).toEqual({
      roleName: 'Secretary',
      roleKind: 'teammate',
      subjects: [{ kind: 'command-prefix', value: 'docker build' }]
    })
    manager.decideApproval(queued(first.id)?.id ?? '', { kind: 'allow-role', scope: 'forever' })
    await pending
    expect(grantKeysInDb()).toEqual([roleGrantKey(a.id)])

    const second = await manager.createThread({ roleId: a.id })
    await expect(approveBash(second.id, 'docker build -t x .')).resolves.toMatchObject({ allowed: true })
    expect(queued(second.id)).toBeUndefined()

    const other = await manager.createThread({ roleId: b.id })
    void approveBash(other.id, 'docker build .')
    await vi.waitFor(() => expect(queued(other.id)).toBeDefined())
    const plain = await manager.createThread({ approvalStrict: true })
    void approveBash(plain.id, 'docker build .')
    await vi.waitFor(() => expect(queued(plain.id)).toBeDefined())
    // The plain strict conversation keeps "do not ask in this conversation" (stage 3), not the Teammate row.
    expect(queued(plain.id)?.roleGrant).toBeUndefined()
    expect(queued(plain.id)?.threadGrant).toBeDefined()
  })

  it("a job's row (not moved) applies to that job's runs under the Teammate, not to the Teammate's conversation started by hand", async () => {
    const a = roles.create({ ...emptyRoleInput(), name: 'Secretary', approvalStrict: true })
    new RoleGrantStore(db).addRoleGrants([prefixRow('job:J1', 'docker build', 'old-job-row')])
    await manager.stop()
    manager = build()
    const run = await manager.createThread({ roleId: a.id, approvalStrict: true }, 'J1')
    await expect(approveBash(run.id, 'docker build .')).resolves.toMatchObject({ allowed: true })
    const byHand = await manager.createThread({ roleId: a.id })
    void approveBash(byHand.id, 'docker build .')
    await vi.waitFor(() => expect(queued(byHand.id)).toBeDefined())
    const otherJob = await manager.createThread({ approvalStrict: true }, 'J2')
    void approveBash(otherJob.id, 'docker build .')
    await vi.waitFor(() => expect(queued(otherJob.id)).toBeDefined())
    // The job's row stays as it was (not rewritten to role:).
    expect(grantKeysInDb()).toEqual(['job:J1'])
  })

  it('a conversation moved to another Teammate gets the new Teammate\'s table at the next request (the key is never cached)', async () => {
    const a = roles.create({ ...emptyRoleInput(), name: 'A', approvalStrict: true })
    const b = roles.create({ ...emptyRoleInput(), name: 'B', approvalStrict: true })
    new RoleGrantStore(db).addRoleGrants([prefixRow(roleGrantKey(b.id), 'terraform plan', 'b-row')])
    await manager.stop()
    manager = build()
    const thread = await manager.createThread({ roleId: a.id })
    void approveBash(thread.id, 'terraform plan')
    await vi.waitFor(() => expect(queued(thread.id)).toBeDefined())
    manager.decideApproval(queued(thread.id)?.id ?? '', { kind: 'deny' })
    // What bundle B's "move to Teammate" writes: the row's role_id.
    db.prepare(`UPDATE threads SET role_id = ? WHERE id = ?`).run(b.id, thread.id)
    const session = adapter.sessions.at(-1)!
    const reply = await manager.handleGatewayRequest({
      sessionId: session.sessionId,
      kind: 'approve',
      payload: { toolName: 'Bash', toolUseId: 'tu-moved', input: { command: 'terraform plan -out x' } }
    })
    expect(reply).toMatchObject({ allowed: true })
    expect(queued(thread.id)).toBeUndefined()
  })

  it('deleting a Teammate deletes its rows from the DB (one transaction with the role) and from memory; other rows remain', async () => {
    const a = roles.create({ ...emptyRoleInput(), name: 'A', approvalStrict: true })
    const b = roles.create({ ...emptyRoleInput(), name: 'B', approvalStrict: true })
    new RoleGrantStore(db).addRoleGrants([
      prefixRow(roleGrantKey(a.id), 'docker build', 'a-row'),
      prefixRow(roleGrantKey(b.id), 'docker build', 'b-row'),
      prefixRow('job:J1', 'docker build', 'j-row')
    ])
    await manager.stop()
    manager = build()
    const thread = await manager.createThread({ roleId: a.id })
    expect(manager.listRoleGrants(roleGrantKey(a.id)).map((row) => row.id)).toEqual(['a-row'])
    // What the role IPC does: delete the row, then tell the manager.
    expect(roles.delete(a.id)).toBe(true)
    expect(grantKeysInDb()).toEqual([roleGrantKey(b.id), 'job:J1'])
    manager.forgetRole(a.id)
    expect(manager.listRoleGrants(roleGrantKey(a.id))).toEqual([])
    // The conversation is back to no role: strict, so it is asked (and with "do not ask in this conversation", not a Teammate row).
    void approveBash(thread.id, 'docker build .')
    await vi.waitFor(() => expect(queued(thread.id)).toBeDefined())
    expect(queued(thread.id)?.roleGrant).toBeUndefined()
  })

  it('the startup sweep removes rows of Teammates that do not exist (and keeps live Teammates\' and other keys\')', async () => {
    const a = roles.create({ ...emptyRoleInput(), name: 'A' })
    new RoleGrantStore(db).addRoleGrants([
      prefixRow(roleGrantKey(a.id), 'docker build', 'a-row'),
      prefixRow('role:gone', 'docker build', 'gone-row'),
      prefixRow('role:bad key', 'docker build', 'bad-row'),
      prefixRow('job:J1', 'docker build', 'j-row')
    ])
    await manager.stop()
    manager = build()
    expect(grantKeysInDb()).toEqual([roleGrantKey(a.id), 'job:J1'])
  })

  it('the table IPC accepts job: and role: keys only, and removes only a row of that key', () => {
    const a = roles.create({ ...emptyRoleInput(), name: 'A' })
    const b = roles.create({ ...emptyRoleInput(), name: 'B' })
    new RoleGrantStore(db).addRoleGrants([prefixRow(roleGrantKey(a.id), 'docker build', 'a-row')])
    manager.stop().catch(() => undefined)
    manager = build()
    expect(manager.listRoleGrants('thread:x')).toEqual([])
    expect(manager.removeRoleGrant(roleGrantKey(b.id), 'a-row')).toBe(false)
    expect(manager.removeRoleGrant('thread:x', 'a-row')).toBe(false)
    expect(grantKeysInDb()).toEqual([roleGrantKey(a.id)])
    expect(manager.removeRoleGrant(roleGrantKey(a.id), 'a-row')).toBe(true)
    expect(grantKeysInDb()).toEqual([])
  })
})

describe('migration 47 (roles.approval_strict)', () => {
  it('adds the column with 0 for existing roles, and applying again after the number is rewound is a no-op', () => {
    const fresh = new Database(':memory:')
    try {
      runMigrations(fresh)
      expect(MIGRATIONS.find((m) => m.version === 47)?.name).toBe('role-approval-strict')
      // Back to the shape of 46 with an existing role, then apply 47.
      fresh.exec(`ALTER TABLE roles DROP COLUMN approval_strict`)
      fresh.prepare(`INSERT INTO roles (id, name, cwd, instructions, model_id, thinking, created_at, updated_at) VALUES ('r', 'R', NULL, '', NULL, NULL, 1, 1)`).run()
      fresh.pragma('user_version = 46')
      runMigrations(fresh)
      expect(new RoleStore(fresh).get('r')?.approvalStrict).toBe(false)
      new RoleStore(fresh).updateRole('r', { ...emptyRoleInput(), name: 'R', approvalStrict: true })
      fresh.pragma('user_version = 46')
      expect(() => runMigrations(fresh)).not.toThrow()
      expect(new RoleStore(fresh).get('r')?.approvalStrict).toBe(true)
    } finally {
      fresh.close()
    }
  })
})
