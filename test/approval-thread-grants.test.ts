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

describe('複合コマンドの分割 (1005 の 3、matchGrant)', () => {
  const rows = [row({ id: 'a', subject: 'git status' }), row({ id: 'b', subject: 'npm run build' })]

  it('全部の部分が許可に当たるときだけ通る', () => {
    const hit = matchGrant(cmd('git status && npm run build'), rows, ctx())
    expect(hit?.map((r) => r.id)).toEqual(['a', 'b'])
    expect(matchGrant(cmd('git status | npm run build'), rows, ctx())).not.toBeNull()
  })

  it('一部だけ当たる複合は通らない', () => {
    expect(matchGrant(cmd('git status && git push'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('git status ; rm -rf x'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('git status || npm run build && curl x'), rows, ctx())).toBeNull()
  })

  it('聞かない定番の部分は許可の行が無くても通る (他が当たるなら)', () => {
    const quiet = ctx({ quietSegment: (s) => s.startsWith('echo') })
    expect(matchGrant(cmd('git status && echo ok'), rows, quiet)).not.toBeNull()
    expect(matchGrant(cmd('git push && echo ok'), rows, quiet)).toBeNull()
  })

  it('安全でない文字を含む複合は分けず、全体の完全一致だけ', () => {
    expect(matchGrant(cmd('git status && git log "$(rm -rf x)"'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('git status; ls *'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('git status && echo `id`'), rows, ctx())).toBeNull()
  })

  it('部分だけの完全一致の行は、その部分にだけ効く', () => {
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
  it('処理系の部分 (sh など) は、その完全一致の行があっても複合の中では当てない', () => {
    const shExact = row({ id: 's', subjectKind: 'command-exact', subject: 'sh', subjectHash: grantCommandHash('sh') })
    // A lone `sh` still passes as an exact match of the whole, as before.
    expect(matchGrant(cmd('sh'), [shExact], ctx())).not.toBeNull()
    expect(matchGrant(cmd('git status | sh'), [shExact, ...rows], ctx())).toBeNull()
    expect(matchGrant(cmd('git status && sh'), [shExact, ...rows], ctx())).toBeNull()
    const xargs = row({ id: 'x', subjectKind: 'command-exact', subject: 'xargs rm', subjectHash: grantCommandHash('xargs rm') })
    expect(matchGrant(cmd('git status | xargs rm'), [xargs, ...rows], ctx())).toBeNull()
  })

  it('パイプの受け手は、部分だけの完全一致の行に当てない (`;` `&&` の後なら当たる)', () => {
    const tee = row({ id: 't', subjectKind: 'command-exact', subject: 'tee -a notes.txt', subjectHash: grantCommandHash('tee -a notes.txt') })
    expect(matchGrant(cmd('git status | tee -a notes.txt'), [tee, ...rows], ctx())).toBeNull()
    expect(matchGrant(cmd('git status && tee -a notes.txt'), [tee, ...rows], ctx())).not.toBeNull()
  })

  // wave 91 code-review: with a newline in between, the empty part after `|` was dropped and slipped past the receiver's judgment. A command containing a newline matches only as a whole.
  it('改行を含むコマンドは分けず、部分の行には当たらない', () => {
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

  it('改行を含むコマンドは、全体の完全一致の行なら通る (提案も全体の 1 行)', () => {
    const command = 'git status |\ntee -a notes.txt'
    const proposal = proposeGrants(cmd(command), rows, ctx())
    if (!('candidates' in proposal)) throw new Error('refused')
    expect(proposal.candidates.map((c) => c.subjectKind)).toEqual(['command-exact'])
    const exact = row({ id: 'e', subjectKind: 'command-exact', subject: proposal.candidates[0]!.subject, subjectHash: proposal.candidates[0]!.subjectHash })
    expect(matchGrant(cmd(command), [exact], ctx())).not.toBeNull()
    expect(matchGrant(cmd('git status | tee -a notes.txt'), [exact], ctx())).toBeNull()
  })

  it('処理系の部分・前方一致にできないパイプの受け手を含む複合は、分けずに全体の完全一致を提案する', () => {
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

describe('Broker: この会話では聞かない (983 段 3)', () => {
  it('Bash は頭の語の前方一致 — 同じ頭は通り、別の頭は聞く。表 (role_grants) には書かない', async () => {
    const { broker, store } = makeBroker()
    await allowThread(broker, bash('terraform plan -out=a'))
    expect(store.rows).toEqual([])
    expect(await broker.request(bash('terraform plan -refresh=false'))).toMatchObject({ allowed: true, by: 'rule' })
    void broker.request(bash('terraform apply'))
    void broker.request(bash('terraform destroy'))
    expect(pendingOf(broker)).toHaveLength(2)
  })

  it('複合: 全部の部分が当たるときだけ通る', async () => {
    const { broker } = makeBroker()
    await allowThread(broker, bash('terraform plan -out=a && make build'))
    expect(await broker.request(bash('terraform plan && make build'))).toMatchObject({ by: 'rule' })
    void broker.request(bash('terraform plan && terraform apply'))
    expect(pendingOf(broker)).toHaveLength(1)
  })

  it('ファイルの書き込みはパスの前方一致 (同じディレクトリは通り、外は聞く)', async () => {
    const { broker } = makeBroker()
    await allowThread(broker, pathReq('Write', 'write', '/work/proj/src/a.ts'))
    expect(await broker.request(pathReq('Write', 'write', '/work/proj/src/b.ts'))).toMatchObject({ by: 'rule' })
    void broker.request(pathReq('Write', 'write', '/work/proj/other/c.ts'))
    void broker.request(pathReq('Write', 'write', '/etc/passwd'))
    // A write whose target cannot be pinned to one (no target) is asked about.
    void broker.request({ ...pathReq('Write', 'write', '/work/proj/src/c.ts'), grantSubject: null })
    expect(pendingOf(broker)).toHaveLength(3)
  })

  it('読み取りの許可は書き込みを通さない', async () => {
    const { broker } = makeBroker()
    await allowThread(broker, pathReq('Read', 'read', '/work/proj/src/a.ts'))
    expect(await broker.request(pathReq('Read', 'read', '/work/proj/src/z.ts'))).toMatchObject({ by: 'rule' })
    void broker.request(pathReq('Write', 'write', '/work/proj/src/z.ts'))
    expect(pendingOf(broker)).toHaveLength(1)
  })

  it('読み取り専用と分かっている道具は名前、分からない道具は枠を出さず毎回聞く', async () => {
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

  it('別の会話・role のある会話・厳格でない会話には漏れない', async () => {
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

  it('外へ出す操作・段 0 の線・停止パターンは許可があっても今までどおり聞く', async () => {
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

  it('renderer の偽の allow-thread (提案の無い要求・外へ出す操作) は 1 回の許可に落ちる', async () => {
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

  it('既に積んである同じ会話の要求のうち、新しい行で通るものだけ解く', async () => {
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
  it('答えた時点で厳格でなければ行は足さず、1 回の許可に落とす (入れ直しても通らない)', async () => {
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

  it('厳格のまま押せば今までどおり行が足される (両方向)', async () => {
    const { broker } = makeBroker()
    broker.setStrictLookup(() => true)
    await allowThread(broker, bash('terraform plan -out=a'))
    expect(await broker.request(bash('terraform plan -refresh=false'))).toMatchObject({ by: 'rule' })
  })

  it('対象は要るときだけ組む: 行の無い会話の照合では組まず、枠を積むときと行があるときだけ組む', async () => {
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
