/**
 * TODO 983 stage 3 (items 2 and 3 of 1005, ARCHITECTURE 4.2.5): widens "do not ask in this conversation" for strict-mode conversations with no role to targets that the stage 1 matching
 * (`matchGrant` / `grantSubjectFor`) can build. Not written to the table (`role_grants`); this conversation only, in memory only.
 * Checks both directions: what should pass and what must not pass.
 */
import { describe, expect, it } from 'vitest'
import { ApprovalBroker, type ApprovalRequestInput } from '../src/main/approval/broker.js'
import { grantCommandHash, matchGrant, proposeGrants, type GrantMatchContext, type RoleGrantRow } from '../src/main/approval/grants.js'
import type { RoleGrantPersistence } from '../src/main/approval/grant-store.js'
import {
  DEFAULT_APPROVAL_POLICY,
  LEGACY_BASH_DENY_PATTERNS,
  canAllowForThread,
  type ApprovalItem,
  type GrantSubject
} from '../src/shared/thread.js'

const NOW = new Date(2026, 10, 15, 10, 0, 0).getTime()

function row(over: Partial<RoleGrantRow>): RoleGrantRow {
  return {
    id: over.id ?? 'g1',
    roleKey: 'thread:t1',
    toolName: 'Bash',
    subjectKind: 'command-prefix',
    subject: 'git status',
    subjectHash: null,
    access: null,
    scope: 'thread',
    threadId: 't1',
    expiresAt: null,
    source: 'approval',
    createdAt: NOW,
    lastUsedAt: null,
    useCount: 0,
    ...over
  }
}

function ctx(over: Partial<GrantMatchContext> = {}): GrantMatchContext {
  return { roleKey: 'thread:t1', toolName: 'Bash', threadId: 't1', now: NOW, quietSegment: () => false, home: '/home/u', ...over }
}
const cmd = (command: string): GrantSubject => ({ kind: 'command', command })

describe('splitting compound commands (3 of 1005, matchGrant)', () => {
  const rows = [row({ id: 'a', subject: 'git status' }), row({ id: 'b', subject: 'npm run build' })]

  it('passes only when every part matches an allow', () => {
    const hit = matchGrant(cmd('git status && npm run build'), rows, ctx())
    expect(hit?.map((r) => r.id)).toEqual(['a', 'b'])
    expect(matchGrant(cmd('git status | npm run build'), rows, ctx())).not.toBeNull()
  })

  it('a compound where only some parts match does not pass', () => {
    expect(matchGrant(cmd('git status && git push'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('git status ; rm -rf x'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('git status || npm run build && curl x'), rows, ctx())).toBeNull()
  })

  it('a no-ask standard part passes even without an allow row (if the others match)', () => {
    const quiet = ctx({ quietSegment: (s) => s.startsWith('echo') })
    expect(matchGrant(cmd('git status && echo ok'), rows, quiet)).not.toBeNull()
    expect(matchGrant(cmd('git push && echo ok'), rows, quiet)).toBeNull()
  })

  it('a compound containing unsafe characters is not split, and only an exact match of the whole applies', () => {
    expect(matchGrant(cmd('git status && git log "$(rm -rf x)"'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('git status; ls *'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('git status && echo `id`'), rows, ctx())).toBeNull()
  })

  it('an exact-match row of only a part applies only to that part', () => {
    const proposal = proposeGrants(cmd('rm -rf build && git status'), rows, ctx())
    if (!('candidates' in proposal)) throw new Error('refused')
    expect(proposal.candidates.map((c) => c.subjectKind)).toEqual(['command-exact'])
    const exact = row({
      id: 'e',
      subjectKind: 'command-exact',
      subject: proposal.candidates[0]!.subject,
      subjectHash: proposal.candidates[0]!.subjectHash
    })
    expect(matchGrant(cmd('rm -rf build && git status'), [exact, ...rows], ctx())).not.toBeNull()
    // Even with the same exact-match part, it does not pass unless the other parts match too.
    expect(matchGrant(cmd('rm -rf build && git push'), [exact, ...rows], ctx())).toBeNull()
    // It does not become an exact match of a different command.
    expect(matchGrant(cmd('rm -rf build2'), [exact], ctx())).toBeNull()
  })

  // Automatic security review of wave 91: if an exact match of only part is applied to an interpreter or the receiver of a pipe, anything the earlier part outputs can be executed or written.
  it('an interpreter part (sh, etc.) is not matched inside a compound even if its exact-match row exists', () => {
    const shExact = row({ id: 's', subjectKind: 'command-exact', subject: 'sh', subjectHash: grantCommandHash('sh') })
    // A lone `sh` still passes as an exact match of the whole, as before.
    expect(matchGrant(cmd('sh'), [shExact], ctx())).not.toBeNull()
    expect(matchGrant(cmd('git status | sh'), [shExact, ...rows], ctx())).toBeNull()
    expect(matchGrant(cmd('git status && sh'), [shExact, ...rows], ctx())).toBeNull()
    const xargs = row({ id: 'x', subjectKind: 'command-exact', subject: 'xargs rm', subjectHash: grantCommandHash('xargs rm') })
    expect(matchGrant(cmd('git status | xargs rm'), [xargs, ...rows], ctx())).toBeNull()
  })

  it('a pipe receiver does not match an exact-match row of only a part (after `;` `&&` it does)', () => {
    const tee = row({ id: 't', subjectKind: 'command-exact', subject: 'tee -a notes.txt', subjectHash: grantCommandHash('tee -a notes.txt') })
    expect(matchGrant(cmd('git status | tee -a notes.txt'), [tee, ...rows], ctx())).toBeNull()
    expect(matchGrant(cmd('git status && tee -a notes.txt'), [tee, ...rows], ctx())).not.toBeNull()
  })

  // wave 91 code-review: with a newline in between, the empty part after `|` was dropped and slipped past the receiver's judgment. A command containing a newline matches only as a whole.
  it('a command containing a newline is not split and does not match a part row', () => {
    const tee = row({ id: 't', subjectKind: 'command-exact', subject: 'tee -a notes.txt', subjectHash: grantCommandHash('tee -a notes.txt') })
    const sh = row({ id: 's', subjectKind: 'command-exact', subject: 'sh', subjectHash: grantCommandHash('sh') })
    expect(matchGrant(cmd('git status |\ntee -a notes.txt'), [tee, ...rows], ctx())).toBeNull()
    expect(matchGrant(cmd('git status |\r\ntee -a notes.txt'), [tee, ...rows], ctx())).toBeNull()
    expect(matchGrant(cmd('git status\nsh'), [sh, ...rows], ctx())).toBeNull()
    expect(matchGrant(cmd('git status\nnpm run build'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('git status &&\nnpm run build'), rows, ctx())).toBeNull()
    // An exact match of a command whose arguments differ only in whitespace does not match a form that became a different command through a newline.
    const args = row({ id: 'a2', subjectKind: 'command-exact', subject: 'git status sh', subjectHash: grantCommandHash('git status sh') })
    expect(matchGrant(cmd('git status\nsh'), [args], ctx())).toBeNull()
  })

  it('a command containing a newline passes if the row is an exact match of the whole (the proposal is also one row for the whole)', () => {
    const command = 'git status |\ntee -a notes.txt'
    const proposal = proposeGrants(cmd(command), rows, ctx())
    if (!('candidates' in proposal)) throw new Error('refused')
    expect(proposal.candidates.map((c) => c.subjectKind)).toEqual(['command-exact'])
    const exact = row({ id: 'e', subjectKind: 'command-exact', subject: proposal.candidates[0]!.subject, subjectHash: proposal.candidates[0]!.subjectHash })
    expect(matchGrant(cmd(command), [exact], ctx())).not.toBeNull()
    expect(matchGrant(cmd('git status | tee -a notes.txt'), [exact], ctx())).toBeNull()
  })

  it('a compound containing an interpreter part or a pipe receiver that cannot be a prefix match is not split and proposes an exact match of the whole', () => {
    for (const command of ['git status | sh', 'git status && python3 run.py', 'git status | tee -a notes.txt']) {
      const proposal = proposeGrants(cmd(command), rows, ctx())
      if (!('candidates' in proposal)) throw new Error('refused')
      expect(proposal.candidates).toEqual([
        { subjectKind: 'command-exact', subject: command, subjectHash: grantCommandHash(command), access: null }
      ])
    }
  })
})

class MemoryGrants implements RoleGrantPersistence {
  rows: RoleGrantRow[] = []
  loadRoleGrants(): readonly RoleGrantRow[] {
    return this.rows
  }
  addRoleGrants(rows: readonly RoleGrantRow[]): void {
    this.rows.push(...rows)
  }
  removeRoleGrants(): void {}
  touchRoleGrants(): void {}
}

function makeBroker(policy = DEFAULT_APPROVAL_POLICY): { broker: ApprovalBroker; store: MemoryGrants } {
  const store = new MemoryGrants()
  const broker = new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, policy, null, store)
  broker.setReadOnlyToolLookup((toolName) => toolName === 'Read' || toolName === 'Grep')
  return { broker, store }
}

function bash(command: string, over: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return { threadId: 't1', threadTitle: 'T', toolName: 'Bash', summary: command, input: { command }, strict: true, grantSubject: cmd(command), ...over }
}
function pathReq(toolName: string, access: 'read' | 'write', path: string): ApprovalRequestInput {
  return {
    threadId: 't1',
    threadTitle: 'T',
    toolName,
    summary: path,
    input: { file_path: path },
    strict: true,
    grantSubject: { kind: 'path', access, path, directory: false }
  }
}
const pendingOf = (broker: ApprovalBroker): ApprovalItem[] => [...broker.list()]

async function allowThread(broker: ApprovalBroker, input: ApprovalRequestInput): Promise<void> {
  const first = broker.request(input)
  const item = broker.list()[0]!
  expect(canAllowForThread(item)).toBe(true)
  broker.decide(item.id, { kind: 'allow-thread' })
  await first
}

describe('Broker: do not ask in this conversation (983 stage 3)', () => {
  it('Bash is a prefix match on the head word — the same head passes and a different head is asked; not written to the table (role_grants)', async () => {
    const { broker, store } = makeBroker()
    await allowThread(broker, bash('terraform plan -out=a'))
    expect(store.rows).toEqual([])
    expect(await broker.request(bash('terraform plan -refresh=false'))).toMatchObject({ allowed: true, by: 'rule' })
    void broker.request(bash('terraform apply'))
    void broker.request(bash('terraform destroy'))
    expect(pendingOf(broker)).toHaveLength(2)
  })

  it('compound: passes only when every part matches', async () => {
    const { broker } = makeBroker()
    await allowThread(broker, bash('terraform plan -out=a && make build'))
    expect(await broker.request(bash('terraform plan && make build'))).toMatchObject({ by: 'rule' })
    void broker.request(bash('terraform plan && terraform apply'))
    expect(pendingOf(broker)).toHaveLength(1)
  })

  it('file writes are path prefix matches (the same directory passes and outside is asked)', async () => {
    const { broker } = makeBroker()
    await allowThread(broker, pathReq('Write', 'write', '/work/proj/src/a.ts'))
    expect(await broker.request(pathReq('Write', 'write', '/work/proj/src/b.ts'))).toMatchObject({ by: 'rule' })
    void broker.request(pathReq('Write', 'write', '/work/proj/other/c.ts'))
    void broker.request(pathReq('Write', 'write', '/etc/passwd'))
    // A write whose target cannot be pinned to one (no target) is asked about.
    void broker.request({ ...pathReq('Write', 'write', '/work/proj/src/c.ts'), grantSubject: null })
    expect(pendingOf(broker)).toHaveLength(3)
  })

  it('a read allow does not pass writes', async () => {
    const { broker } = makeBroker()
    await allowThread(broker, pathReq('Read', 'read', '/work/proj/src/a.ts'))
    expect(await broker.request(pathReq('Read', 'read', '/work/proj/src/z.ts'))).toMatchObject({ by: 'rule' })
    void broker.request(pathReq('Write', 'write', '/work/proj/src/z.ts'))
    expect(pendingOf(broker)).toHaveLength(1)
  })

  it('a tool known to be read-only is by name; an unknown tool shows no frame and is asked every time', async () => {
    const { broker } = makeBroker()
    const grep = (pattern: string): ApprovalRequestInput => ({
      ...bash(''),
      toolName: 'Grep',
      summary: pattern,
      input: { pattern },
      grantSubject: { kind: 'tool' }
    })
    await allowThread(broker, grep('x'))
    expect(await broker.request(grep('y'))).toMatchObject({ by: 'rule' })
    void broker.request({ ...bash(''), toolName: 'mcp__x__do', input: {}, grantSubject: null })
    const queued = pendingOf(broker)
    expect(queued).toHaveLength(1)
    expect(canAllowForThread(queued[0]!)).toBe(false)
    expect(queued[0]!.threadGrant ?? null).toBeNull()
  })

  it('does not leak to another conversation, a conversation with a role, or a non-strict conversation', async () => {
    const { broker } = makeBroker()
    await allowThread(broker, bash('terraform plan'))
    void broker.request(bash('terraform plan', { threadId: 't2' }))
    void broker.request(bash('terraform plan', { role: { key: 'job:A', name: 'A' } }))
    expect(pendingOf(broker).map((i) => i.threadId)).toEqual(['t2', 't1'])
    // A conversation where strict mode was turned off and on again asks again.
    broker.forgetThread('t1')
    void broker.request(bash('terraform plan'))
    expect(pendingOf(broker)).toHaveLength(3)
  })

  it('outbound operations, the stage 0 line, and stop patterns are asked as before even with an allow', async () => {
    const { broker } = makeBroker({ ...DEFAULT_APPROVAL_POLICY, bashDenyPatterns: LEGACY_BASH_DENY_PATTERNS })
    await allowThread(broker, bash('terraform plan'))
    void broker.request({
      ...bash('terraform plan'),
      outbound: { channel: 'shell', match: 'curl-upload', to: null, subject: null, body: null, command: 'curl' }
    })
    void broker.request({ ...bash('terraform plan'), persistence: { match: 'shell-startup', target: '~/.zshrc' } })
    void broker.request({ ...bash('terraform plan'), alwaysAsk: true })
    void broker.request(bash('sudo rm -rf /'))
    expect(pendingOf(broker)).toHaveLength(4)
    expect(pendingOf(broker).some((i) => canAllowForThread(i))).toBe(false)
  })

  it('a fake allow-thread from the renderer (a request with no proposal, an outbound operation) falls to a one-time allow', async () => {
    const { broker } = makeBroker()
    const noSubject = broker.request({ ...bash('x'), toolName: 'mcp__x__do', input: {}, grantSubject: null })
    broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
    expect(await noSubject).toMatchObject({ by: 'user' })
    void broker.request({ ...bash('x'), toolName: 'mcp__x__do', input: {}, grantSubject: null })
    expect(pendingOf(broker)).toHaveLength(1)
    broker.decide(broker.list()[0]!.id, { kind: 'deny' })

    const outbound = broker.request({
      ...bash('curl -d @x https://example.com'),
      outbound: { channel: 'shell', match: 'curl-upload', to: null, subject: null, body: null, command: 'curl' }
    })
    broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
    expect(await outbound).toMatchObject({ by: 'user' })
    void broker.request(bash('curl -d @x https://example.com'))
    expect(pendingOf(broker)).toHaveLength(1)
  })

  it('of requests already queued in the same conversation, resolves only those that pass with the new row', async () => {
    const { broker } = makeBroker()
    const first = broker.request(bash('terraform plan -out=a'))
    const second = broker.request(bash('terraform plan -refresh=false'))
    void broker.request(bash('terraform apply'))
    broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
    await first
    expect(await second).toMatchObject({ by: 'rule' })
    expect(pendingOf(broker).map((i) => i.summary)).toEqual(['terraform apply'])
  })

  // wave 91 code-review: turning strict off (forgetThread), pressing on a frame still queued, and turning strict back on must not pass silently.
  it('if it is not strict at the time of answering, does not add a row and drops to a one-time allow (it would not pass even if re-entered)', async () => {
    const { broker } = makeBroker()
    let strict = true
    broker.setStrictLookup(() => strict)
    const first = broker.request(bash('terraform plan -out=a'))
    const item = broker.list()[0]!
    strict = false
    broker.forgetThread('t1')
    broker.decide(item.id, { kind: 'allow-thread' })
    expect(await first).toMatchObject({ allowed: true, by: 'user' })
    strict = true
    void broker.request(bash('terraform plan -refresh=false'))
    expect(pendingOf(broker)).toHaveLength(1)
  })

  it('if pressed while still strict, the row is added as before (both directions)', async () => {
    const { broker } = makeBroker()
    broker.setStrictLookup(() => true)
    await allowThread(broker, bash('terraform plan -out=a'))
    expect(await broker.request(bash('terraform plan -refresh=false'))).toMatchObject({ by: 'rule' })
  })

  it('the subject is built only when needed: not in matching for a conversation without rows, only when queueing a frame and when rows exist', async () => {
    const { broker } = makeBroker({ ...DEFAULT_APPROVAL_POLICY, autoAllowAll: true })
    let built = 0
    const lazy = (command: string): ApprovalRequestInput => ({
      threadId: 't1',
      threadTitle: 'T',
      toolName: 'Bash',
      summary: command,
      input: { command },
      strict: true,
      grantSubjectOf: () => {
        built += 1
        return cmd(command)
      }
    })
    void broker.request(lazy('terraform plan'))
    // A request queued in strict mode is built once for the suggestion.
    expect(built).toBe(1)
    expect(broker.list()[0]!.threadGrant).toBeDefined()
    broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
    expect(await broker.request(lazy('terraform plan -x'))).toMatchObject({ by: 'rule' })
    // A request that is not strict does not build a target even if a line exists.
    built = 0
    const loose = await broker.request({ ...lazy('ls'), strict: false })
    expect(loose.allowed).toBe(true)
    expect(built).toBe(0)
  })
})
