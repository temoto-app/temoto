/**
 * ApprovalBroker and the gateway <-> main IPC (ARCHITECTURE.md 4.2 / 7.6).
 *
 * What is checked:
 * - **There is no timeout** (spike 2 demonstrated a 600-second hold). This is confirmed without waiting real time,
 *   by showing it does not resolve on its own.
 * - Distinguishes who rejected (the user or the system).
 * - Refuses and disconnects a connection without a token. The socket is owned only by its owner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalBroker, type ApprovalRuleStore } from '../src/main/approval/broker.js'
import { GatewayServer } from '../src/main/approval/server.js'
import {
  DEFAULT_APPROVAL_POLICY,
  LEGACY_BASH_DENY_PATTERNS,
  GATEWAY_SERVER_NAME,
  GATEWAY_TOOL_PREFIX,
  canAllowForThread,
  canAlwaysAllow,
  type ApprovalPolicy,
  type ApprovalRule
} from '../src/shared/thread.js'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'

/**
 * The default was loosened by T12 (Bash / WebFetch / WebSearch pass without asking). The tests from Phase 2 assume that things stop,
 * so those are built with a setting that **stops everything**.
 */
const STRICT_POLICY: ApprovalPolicy = {
  autoAllowAll: false,
  autoAllowTools: [],
  bashDenyPatterns: []
}

/**
 * A setting that adds stop patterns to the default (allow everything). At item 167 the default stop patterns became empty.
 * The patterns added are from the default list from before item 167: the typical thing a user adds.
 */
const WITH_DENY_PATTERNS: ApprovalPolicy = {
  ...DEFAULT_APPROVAL_POLICY,
  bashDenyPatterns: LEGACY_BASH_DENY_PATTERNS
}

function makeBroker(policy: ApprovalPolicy = STRICT_POLICY): {
  broker: ApprovalBroker
  changes: number[]
  decided: string[]
} {
  const changes: number[] = []
  const decided: string[] = []
  const broker = new ApprovalBroker(
    {
      onChanged: (items) => changes.push(items.length),
      onDecided: (item, result) => decided.push(`${item.toolName}:${result.by}:${result.allowed}`)
    },
    policy
  )
  return { broker, changes, decided }
}

const req = (
  toolName: string,
  input: Record<string, unknown> = {},
  extra: { threadId?: string; strict?: boolean; cwd?: string } = {}
): Parameters<ApprovalBroker['request']>[0] => ({
  threadId: extra.threadId ?? 't1',
  threadTitle: 'A',
  toolName,
  summary: typeof input['command'] === 'string' ? input['command'] : '',
  input: input as never,
  ...(extra.strict === undefined ? {} : { strict: extra.strict }),
  ...(extra.cwd === undefined ? {} : { cwd: extra.cwd })
})

describe('ApprovalBroker', () => {
  it('ユーザが応答するまで解決しない (タイムアウトを実装しない)', async () => {
    const { broker } = makeBroker()
    let settled = false
    const pending = broker
      .request({
        threadId: 't1',
        threadTitle: 'A',
        toolName: 'Bash',
        summary: 'rm -rf x',
        input: { command: 'rm -rf x' }
      })
      .then((result) => {
        settled = true
        return result
      })

    // Advancing the timer does not resolve it = there is no internal timeout.
    vi.useFakeTimers()
    vi.advanceTimersByTime(600_000) // The 600 seconds demonstrated by spike 2
    vi.useRealTimers()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(broker.list()).toHaveLength(1)

    const [item] = broker.list()
    broker.decide(item!.id, { kind: 'allow' })
    const result = await pending
    expect(result).toEqual({ allowed: true, by: 'user', message: '' })
    expect(broker.list()).toHaveLength(0)
  })

  it('拒否はユーザが主体として記録される', async () => {
    const { broker, decided } = makeBroker()
    const pending = broker.request({
      threadId: 't1',
      threadTitle: 'A',
      toolName: 'Write',
      summary: '/a.txt',
      input: {}
    })
    broker.decide(broker.list()[0]!.id, { kind: 'deny', message: 'だめ' })
    const result = await pending
    // The text written is wrapped in the backend's sentence as "do this instead" (item 182; the Adapter builds the sentence).
    expect(result).toEqual({
      allowed: false,
      by: 'user',
      message: 'だめ',
      reply: { kind: 'feedback', text: 'だめ' }
    })
    expect(decided).toEqual(['Write:user:false'])
  })

  it('何も書かずに断れば「止まって待て」の形 (項目 183)', async () => {
    const { broker } = makeBroker()
    const pending = broker.request({ threadId: 't1', threadTitle: 'A', toolName: 'Write', summary: '/a', input: {} })
    broker.decide(broker.list()[0]!.id, { kind: 'deny', message: '   ' })
    expect(await pending).toMatchObject({ allowed: false, by: 'user', reply: { kind: 'stop' } })
  })

  it('main 側の事情による拒否はシステムが主体 (UI で区別する)', async () => {
    const { broker } = makeBroker()
    const pending = broker.request({
      threadId: 't1',
      threadTitle: 'A',
      toolName: 'Bash',
      summary: 'x',
      input: {}
    })
    broker.cancelThread('t1', 'session-exited')
    const result = await pending
    expect(result.allowed).toBe(false)
    expect(result.by).toBe('system')
    // A reason code, not a sentence (TODO 567). The Adapter builds the sentence returned to the model from `reply`.
    expect(result.message).toBe('approval-cancelled-session-exited')
    expect(result.reply).toEqual({ kind: 'cancelled', reason: 'session-exited' })
  })

  it('TODO 632: cancelRequest は callId か toolUseId で 1 件だけ取り下げ、同じスレッドの他の件は残す', async () => {
    const { broker, changes } = makeBroker()
    const base = { threadId: 't1', threadTitle: 'A', toolName: 'Bash', summary: 'x', input: {} }
    const a = broker.request({ ...base, toolUseId: 'tu-a', callId: 'c-a' })
    const b = broker.request({ ...base, toolUseId: 'tu-b', callId: 'c-b' })
    const other = broker.request({ ...base, threadId: 't2', toolUseId: 'tu-a', callId: 'c-x' })
    expect(broker.list()).toHaveLength(3)

    // If there is no matching field, do nothing (do not withdraw all of the thread's approvals).
    expect(broker.cancelRequest('t1', {}, 'tool-timeout')).toBe(false)
    expect(broker.cancelRequest('t1', { toolUseId: '', callId: null }, 'tool-timeout')).toBe(false)
    // It does not match the same toolUseId in another thread.
    expect(broker.cancelRequest('t1', { toolUseId: 'tu-a' }, 'tool-timeout')).toBe(true)
    const result = await a
    expect(result).toEqual({
      allowed: false,
      by: 'system',
      message: 'approval-cancelled-tool-timeout',
      reply: { kind: 'cancelled', reason: 'tool-timeout' }
    })
    expect(broker.list().map((item) => item.threadId).sort()).toEqual(['t1', 't2'])
    expect(broker.cancelRequest('t1', { callId: 'c-b' }, 'tool-timeout')).toBe(true)
    await expect(b).resolves.toMatchObject({ by: 'system', message: 'approval-cancelled-tool-timeout' })
    // The second time does not match.
    expect(broker.cancelRequest('t1', { callId: 'c-b' }, 'tool-timeout')).toBe(false)
    expect(broker.list()).toHaveLength(1)
    expect(changes.at(-1)).toBe(1)
    broker.cancelThread('t2', 'session-exited')
    await other
  })

  it('「常に許可」はツール名で効き、**どのスレッドでも**効く (T40)', async () => {
    const { broker } = makeBroker()
    const first = broker.request({
      threadId: 't1',
      threadTitle: 'A',
      toolName: 'Read',
      summary: '/a',
      input: {}
    })
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    expect((await first).allowed).toBe(true)

    // The same thread and the same tool are not queued and are allowed at once (the actor is rule).
    const second = await broker.request({
      threadId: 't1',
      threadTitle: 'A',
      toolName: 'Read',
      summary: '/b',
      input: {}
    })
    expect(second).toEqual({ allowed: true, by: 'rule', message: '' })
    expect(broker.list()).toHaveLength(0)

    // It takes effect in other threads too (T40: a rule covers the whole app).
    expect(
      await broker.request({
        threadId: 't2',
        threadTitle: 'B',
        toolName: 'Read',
        summary: '/c',
        input: {}
      })
    ).toMatchObject({ by: 'rule' })
    expect(broker.list()).toHaveLength(0)
  })

  it('gateway 自身のツールには「常に許可」のルールを作らない (B-5)。Bash は T12 で、利用者の MCP は項目 110 で解禁', async () => {
    expect(canAlwaysAllow('Bash')).toBe(true)
    expect(canAlwaysAllow('mcp__aios__search')).toBe(false)
    expect(canAlwaysAllow('mcp__aios__approve')).toBe(false)
    expect(canAlwaysAllow('Read')).toBe(true)
    expect(canAlwaysAllow('Edit')).toBe(true)
    // A user's MCP server tools (item 110: strict is dropped, and they are read as in the stock CLI) can be made, as in VS Code.
    expect(canAlwaysAllow('mcp__probe__ping')).toBe(true)
    expect(canAlwaysAllow('mcp__aios2__x')).toBe(true)
    // Namespace boundary: starting with `mcp__aios` alone does not make it the gateway.
    expect(GATEWAY_TOOL_PREFIX).toBe('mcp__aios__')

    const { broker } = makeBroker()
    const first = broker.request(req('mcp__aios__search', { query: 'x' }))
    // Even if the renderer falsely sends allow-always, it falls back to a one-time allow.
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    expect(await first).toEqual({ allowed: true, by: 'user', message: '' })
    expect(broker.listRules()).toHaveLength(0)

    // The next call is queued again.
    void broker.request(req('mcp__aios__search', { query: 'y' }))
    expect(broker.list()).toHaveLength(1)
  })

  it('キューは古い順に並ぶ (滞留時間の表示に使う)', () => {
    const { broker } = makeBroker()
    void broker.request({ threadId: 't1', threadTitle: 'A', toolName: 'X', summary: '', input: {} })
    void broker.request({ threadId: 't2', threadTitle: 'B', toolName: 'Y', summary: '', input: {} })
    const list = broker.list()
    expect(list[0]!.requestedAt).toBeLessThanOrEqual(list[1]!.requestedAt)
    expect(list.map((i) => i.toolName)).toEqual(['X', 'Y'])
  })

  it('終了時に保留分をシステム拒否で片付ける', async () => {
    const { broker } = makeBroker()
    const pending = broker.request({
      threadId: 't1',
      threadTitle: 'A',
      toolName: 'X',
      summary: '',
      input: {}
    })
    broker.shutdown()
    expect((await pending).by).toBe('system')
  })
})

describe('ApprovalBroker — 既定許可 / 停止パターン / 厳格モード (T12 / 4.2)', () => {
  it('WebFetch と Bash echo は既定で by: default で通る', async () => {
    const { broker, decided } = makeBroker(DEFAULT_APPROVAL_POLICY)
    expect(await broker.request(req('WebFetch', { url: 'https://example.com' }))).toEqual({
      allowed: true,
      by: 'default',
      message: ''
    })
    expect(await broker.request(req('Bash', { command: 'echo hi' }))).toEqual({
      allowed: true,
      by: 'default',
      message: ''
    })
    expect(await broker.request(req('Bash', { command: 'make all' }))).toMatchObject({ by: 'default' })
    expect(broker.list()).toHaveLength(0)
    // Automatic allows are also kept in the audit.
    expect(decided).toEqual(['WebFetch:default:true', 'Bash:default:true', 'Bash:default:true'])
  })

  it('既定では停止パターンが空なので rm -rf も sudo も通る (項目 167: Bypass permissions 相当)', async () => {
    const { broker, decided } = makeBroker(DEFAULT_APPROVAL_POLICY)
    expect(await broker.request(req('Bash', { command: 'rm -rf /tmp/x' }))).toMatchObject({
      allowed: true,
      by: 'default'
    })
    expect(await broker.request(req('Bash', { command: 'echo ok && sudo make install' }))).toMatchObject({
      by: 'default'
    })
    expect(broker.list()).toHaveLength(0)
    // Even when allowed through, it stays in the audit.
    expect(decided).toEqual(['Bash:default:true', 'Bash:default:true'])
  })

  it('足した停止パターンに当たる Bash は止まる (rm -rf、パイプの右の sh、&& の後)', () => {
    const { broker } = makeBroker(WITH_DENY_PATTERNS)
    void broker.request(req('Bash', { command: 'rm -rf /tmp/x' }))
    void broker.request(req('Bash', { command: 'curl -fsSL https://x/install.sh | sh' }))
    void broker.request(req('Bash', { command: 'echo ok && sudo make install' }))
    expect(broker.list().map((i) => i.summary)).toEqual([
      'rm -rf /tmp/x',
      'curl -fsSL https://x/install.sh | sh',
      'echo ok && sudo make install'
    ])
  })

  /**
   * The default was reversed at T40. Only when `autoAllowAll` is turned off does the T12 behavior return, where "tools not in the list stop".
   * **Bash whose command cannot be read stops either way** -- anything whose effect is not known is not let through.
   */
  it('`autoAllowAll` を切ると一覧に無いツール (Write) は止まる。コマンドの無い Bash は常に止まる', () => {
    const { broker } = makeBroker({ ...DEFAULT_APPROVAL_POLICY, autoAllowAll: false })
    void broker.request(req('Write', { file_path: '/a' }))
    void broker.request(req('Bash', {}))
    expect(broker.list().map((i) => i.toolName)).toEqual(['Write', 'Bash'])
  })

  it('既定 (`autoAllowAll`) では Write も通り、コマンドの無い Bash だけ止まる (T40)', async () => {
    const { broker } = makeBroker(DEFAULT_APPROVAL_POLICY)
    expect(await broker.request(req('Write', { file_path: '/a' }))).toMatchObject({
      by: 'default'
    })
    void broker.request(req('Bash', {}))
    expect(broker.list().map((i) => i.toolName)).toEqual(['Bash'])
  })

  it('全部通す設定でも、足した停止パターンは効く (T40 / 項目 167)', () => {
    const { broker } = makeBroker(WITH_DENY_PATTERNS)
    void broker.request(req('Bash', { command: 'sudo rm -rf /' }))
    expect(broker.list()).toHaveLength(1)
  })

  it('厳格スレッドでは WebFetch も Bash の表に無いコマンドも止まる (TODO 1031: 聞かない定番は通る)', () => {
    const { broker } = makeBroker(DEFAULT_APPROVAL_POLICY)
    void broker.request(req('WebFetch', { url: 'https://example.com' }, { strict: true }))
    void broker.request(req('Bash', { command: './hi.sh' }, { strict: true }))
    expect(broker.list()).toHaveLength(2)
    // A thread that is not strict passes even with the same Broker.
    void broker.request(req('WebFetch', { url: 'https://example.com' }, { threadId: 't2' }))
    expect(broker.list()).toHaveLength(2)
  })

  it('「常に許可」を Bash ./build.sh all に押すとそれだけが規則になり、./build.sh clean は止まる', async () => {
    const { broker } = makeBroker()
    const first = broker.request(req('Bash', { command: './build.sh all' }))
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    expect((await first).by).toBe('user')

    const rules = broker.listRules()
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ toolName: 'Bash', command: './build.sh all' })

    // A whitespace difference is the same command.
    expect(await broker.request(req('Bash', { command: './build.sh   all' }))).toMatchObject({ by: 'rule' })
    // A different command still stops.
    void broker.request(req('Bash', { command: './build.sh clean' }))
    expect(broker.list().map((i) => i.summary)).toEqual(['./build.sh clean'])
    // **It takes effect in other threads too** (T40: a rule covers the whole app).
    expect(
      await broker.request(req('Bash', { command: './build.sh all' }, { threadId: 't2' }))
    ).toMatchObject({ by: 'rule' })
  })

  it('コマンド単位の規則は厳格スレッドでも効く (ユーザが自分で作ったものだから)', async () => {
    const { broker } = makeBroker(DEFAULT_APPROVAL_POLICY)
    const first = broker.request(req('Bash', { command: './build.sh all' }, { strict: true }))
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    await first
    expect(await broker.request(req('Bash', { command: './build.sh all' }, { strict: true }))).toMatchObject({
      by: 'rule'
    })
  })

  it('TODO 994: ツール名だけの規則は厳格スレッドでは効かず、厳格でないスレッドでは効く', async () => {
    const { broker } = makeBroker(STRICT_POLICY)
    const first = broker.request(req('Write', { file_path: '/a' }, { strict: true }))
    expect(broker.list()[0]!.reason).toEqual({ kind: 'strict' })
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    await first
    expect(broker.listRules()).toMatchObject([{ toolName: 'Write', command: null }])
    // In a strict thread, the following is also queued (a single "always allow" must not cross the line of an unattended job).
    void broker.request(req('Write', { file_path: '/b' }, { strict: true }))
    expect(broker.list()).toHaveLength(1)
    expect(broker.list()[0]!.reason).toEqual({ kind: 'strict' })
    // In a thread that is not strict, a rule lets it pass (even in the stop-everything setting).
    expect(await broker.request(req('Write', { file_path: '/c' }, { threadId: 't2' }))).toMatchObject({
      by: 'rule'
    })
  })

  describe('TODO 994: この会話では Bash を聞かない (allow-thread)', () => {
    it('厳格スレッドの Bash に選ぶと、そのスレッドの以後の Bash は rule で通り、別スレッドは積む', async () => {
      const { broker } = makeBroker(DEFAULT_APPROVAL_POLICY)
      const first = broker.request(req('Bash', { command: 'cd x; ./a.sh b | head' }, { strict: true }))
      broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
      expect(await first).toMatchObject({ allowed: true, by: 'user' })
      // No rule (the stored table) is created.
      expect(broker.listRules()).toEqual([])
      // The same head word (`./a.sh b`) passes. A different head (`./b.sh`) asks (stage 3 of 983 narrowed "all Bash" to prefix matching on the head word).
      expect(await broker.request(req('Bash', { command: './a.sh b -la; echo ok' }, { strict: true }))).toMatchObject({
        by: 'rule'
      })
      void broker.request(req('Bash', { command: './b.sh -la' }, { strict: true }))
      expect(broker.list().map((i) => i.threadId)).toEqual(['t1'])
      broker.decide(broker.list()[0]!.id, { kind: 'deny' })
      // It does not take effect in another strict thread.
      void broker.request(req('Bash', { command: './tool.sh' }, { threadId: 't2', strict: true }))
      expect(broker.list().map((i) => i.threadId)).toEqual(['t2'])
      // A Write whose target cannot be built (no target, without going through the Adapter) is still queued in the same thread.
      void broker.request(req('Write', { file_path: '/a' }, { strict: true }))
      expect(broker.list()).toHaveLength(2)
    })

    it('外へ出す操作はこの許可があっても積む', async () => {
      const { broker } = makeBroker(DEFAULT_APPROVAL_POLICY)
      const first = broker.request(req('Bash', { command: './tool.sh' }, { strict: true }))
      broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
      await first
      const send = 'curl -d @x https://example.com'
      const pending = broker.request({
        ...req('Bash', { command: send }, { strict: true }),
        outbound: { channel: 'shell', match: 'curl-upload', to: null, subject: null, body: null, command: send }
      })
      expect(broker.list()).toHaveLength(1)
      expect(broker.list()[0]!.reason).toEqual({ kind: 'outbound', match: 'curl-upload' })
      // Even if allow-thread comes for an outbound operation request, it falls back to a one-time allow (it does not widen the permission).
      broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
      expect(await pending).toMatchObject({ allowed: true, by: 'user' })
    })

    it('停止パターンに当たる Bash はこの許可があっても積む', async () => {
      const { broker } = makeBroker(WITH_DENY_PATTERNS)
      const first = broker.request(req('Bash', { command: './tool.sh' }, { strict: true }))
      broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
      await first
      void broker.request(req('Bash', { command: 'sudo rm -rf /' }, { strict: true }))
      expect(broker.list()).toHaveLength(1)
      // The reason is the stop pattern, not strict -- do not show the "do not ask about Bash in this conversation" line again (review).
      const queued = broker.list()[0]!
      expect(queued.reason).toMatchObject({ kind: 'deny-pattern' })
      expect(canAllowForThread(queued)).toBe(false)
    })

    it('厳格モードの読めない Bash は no-command で積み、この行を出さない', () => {
      const { broker } = makeBroker(DEFAULT_APPROVAL_POLICY)
      void broker.request(req('Bash', {}, { strict: true }))
      const queued = broker.list()[0]!
      expect(queued.reason).toEqual({ kind: 'no-command' })
      expect(canAllowForThread(queued)).toBe(false)
    })

    it('厳格を切って forgetThread された後、入れ直した厳格ではまた聞く', async () => {
      const { broker } = makeBroker(DEFAULT_APPROVAL_POLICY)
      const first = broker.request(req('Bash', { command: './tool.sh' }, { strict: true }))
      broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
      await first
      // Called by manager.setApprovalStrict(…, false) (test/session-manager.test.ts).
      broker.forgetThread('t1')
      void broker.request(req('Bash', { command: './tool.sh' }, { strict: true }))
      expect(broker.list()).toHaveLength(1)
      expect(canAllowForThread(broker.list()[0]!)).toBe(true)
    })

    it('厳格でない要求 (停止パターンで積んだ Bash) に来たら 1 回の許可に落ち、以後も聞く', async () => {
      const { broker } = makeBroker(WITH_DENY_PATTERNS)
      const first = broker.request(req('Bash', { command: 'sudo ls' }))
      expect(broker.list()[0]!.reason).toMatchObject({ kind: 'deny-pattern' })
      broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
      expect(await first).toMatchObject({ allowed: true, by: 'user' })
      void broker.request(req('Bash', { command: './tool.sh' }, { strict: true }))
      expect(broker.list()).toHaveLength(1)
    })

    it('同じスレッドで既に積んである厳格の Bash も通す', async () => {
      const { broker, decided } = makeBroker(DEFAULT_APPROVAL_POLICY)
      const first = broker.request(req('Bash', { command: './tool.sh a' }, { strict: true }))
      const second = broker.request(req('Bash', { command: './tool.sh a more' }, { strict: true }))
      void broker.request(req('Write', { file_path: '/x' }, { strict: true }))
      broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
      await first
      expect(await second).toMatchObject({ allowed: true, by: 'rule' })
      expect(broker.list().map((i) => i.toolName)).toEqual(['Write'])
      expect(decided).toContain('Bash:rule:true')
    })

    it('forgetThread で消え (スレッドの削除)、新しい Broker (再起動) にも残らない', async () => {
      const { broker } = makeBroker(DEFAULT_APPROVAL_POLICY)
      const first = broker.request(req('Bash', { command: './tool.sh' }, { strict: true }))
      broker.decide(broker.list()[0]!.id, { kind: 'allow-thread' })
      await first
      broker.forgetThread('t1')
      void broker.request(req('Bash', { command: './tool.sh' }, { strict: true }))
      expect(broker.list()).toHaveLength(1)
      const { broker: restarted } = makeBroker(DEFAULT_APPROVAL_POLICY)
      void restarted.request(req('Bash', { command: './tool.sh' }, { strict: true }))
      expect(restarted.list()).toHaveLength(1)
    })
  })

  it('規則は一覧でき、id で解除できる', async () => {
    const { broker } = makeBroker()
    const first = broker.request(req('Read', { file_path: '/a' }))
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    await first
    const [rule] = broker.listRules()
    expect(rule).toMatchObject({ toolName: 'Read', command: null })
    expect(broker.removeRule(rule!.id)).toBe(true)
    expect(broker.removeRule(rule!.id)).toBe(false)
    void broker.request(req('Read', { file_path: '/b' }))
    expect(broker.list()).toHaveLength(1)
  })

  it('設定で autoAllowTools を空にすると全部止まる (Phase 2 までの挙動に戻せる)', () => {
    const { broker } = makeBroker(DEFAULT_APPROVAL_POLICY)
    broker.setPolicy({ autoAllowAll: false, autoAllowTools: [], bashDenyPatterns: [] })
    void broker.request(req('WebFetch', { url: 'https://example.com' }))
    void broker.request(req('Bash', { command: './hi.sh' }))
    expect(broker.list()).toHaveLength(2)
  })
})

describe('ApprovalBroker — 規則の永続化 (T22 / T40、4.2.1.1)', () => {
  /**
   * A stand-in for the store. **The real one is ThreadStore** (`approval.rules` in `app_settings`), and the round trip across DBs is checked by `test/thread-store.test.ts`.
   * What is checked here is only that "the Broker receives the store by injection, writes back when it changes, and the next Broker reads it".
   */
  function makeRuleStore(initial: readonly ApprovalRule[] = []): ApprovalRuleStore & {
    saves: number
    rules: ApprovalRule[]
  } {
    const state = {
      saves: 0,
      rules: [...initial],
      loadApprovalRules(): readonly ApprovalRule[] {
        return state.rules
      },
      saveApprovalRules(rules: readonly ApprovalRule[]): void {
        state.saves += 1
        state.rules = [...rules]
      }
    }
    return state
  }

  function brokerWith(store: ApprovalRuleStore): ApprovalBroker {
    return new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, STRICT_POLICY, store)
  }

  it('「常に許可」で書き戻し、次のプロセスの Broker がそれを読んで効かせる', async () => {
    const store = makeRuleStore()
    const first = brokerWith(store)
    const pending = first.request(req('Bash', { command: './build.sh all' }))
    first.decide(first.list()[0]!.id, { kind: 'allow-always' })
    await pending
    expect(store.saves).toBe(1)
    expect(store.rules).toHaveLength(1)

    // Equivalent to a restart: create a new Broker from the same store.
    const second = brokerWith(store)
    expect(second.listRules()).toHaveLength(1)
    expect(await second.request(req('Bash', { command: './build.sh   all' }))).toMatchObject({
      by: 'rule'
    })
    // A different command still stops.
    void second.request(req('Bash', { command: './build.sh clean' }))
    expect(second.list()).toHaveLength(1)
  })

  it('解除も書き戻すので、再起動しても戻ってこない', async () => {
    const store = makeRuleStore()
    const first = brokerWith(store)
    const pending = first.request(req('Read', { file_path: '/a' }))
    first.decide(first.list()[0]!.id, { kind: 'allow-always' })
    await pending
    expect(first.removeRule(first.listRules()[0]!.id)).toBe(true)
    expect(store.rules).toHaveLength(0)
    expect(brokerWith(store).listRules()).toHaveLength(0)
  })

  it('スレッドを消しても規則は残る (T40: アプリ全体の設定になった)', async () => {
    const store = makeRuleStore()
    const broker = brokerWith(store)
    const pending = broker.request(req('Read', { file_path: '/a' }))
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    await pending
    broker.cancelThread('t1', 'thread-removed')
    expect(broker.listRules()).toHaveLength(1)
    expect(store.rules).toHaveLength(1)
  })

  it('置き場を渡さなければ今までどおりメモリだけ (既存のテストの作りを壊さない)', async () => {
    const { broker } = makeBroker()
    const pending = broker.request(req('Read', { file_path: '/a' }))
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    await pending
    expect(broker.listRules()).toHaveLength(1)
  })

  it('shutdown の後は書き戻さない (DB が閉じた後に書かない — 12.9)', () => {
    const store = makeRuleStore([
      { id: 'r1', toolName: 'Read', command: null, createdAt: 1 }
    ])
    const broker = brokerWith(store)
    broker.shutdown()
    const saves = store.saves
    // Releasing after exit does not touch the store.
    broker.removeRule('r1')
    expect(store.saves).toBe(saves)
    expect(store.rules).toHaveLength(1)
  })

  it('置き場から読んだ規則も検証する (いま作れない規則を復活させない)', async () => {
    const rule = (patch: Partial<ApprovalRule>): ApprovalRule => ({
      id: `r${Math.random()}`,
      toolName: 'Read',
      command: null,
      createdAt: 1,
      ...patch
    })
    const store = makeRuleStore([
      // A rule cannot be made for the gateway's own `mcp__aios__*` (B-5). It is applied to old rows too.
      rule({ toolName: 'mcp__aios__search' }),
      // Rules for a user's MCP server tools remain (item 110).
      rule({ toolName: 'mcp__probe__ping', command: 'ignored' }),
      // A Bash rule with no command would let every command through.
      rule({ toolName: 'Bash', command: null }),
      // An empty tool name.
      rule({ toolName: '' }),
      // Drops the command for anything other than Bash (aligns to a form that works by tool name alone).
      rule({ toolName: 'Write', command: 'rm -rf /' }),
      // Bash keeps its whitespace normalized.
      rule({ toolName: 'Bash', command: 'make   all' })
    ])
    const broker = brokerWith(store)
    expect(broker.listRules().map((r) => [r.toolName, r.command])).toEqual([
      ['mcp__probe__ping', null],
      ['Write', null],
      ['Bash', 'make all']
    ])
    // Thanks to the dropped Bash rule, no arbitrary command passes.
    void broker.request(req('Bash', { command: 'sudo rm -rf /' }))
    expect(broker.list()).toHaveLength(1)
    // Remaining rules take effect.
    expect(await broker.request(req('Bash', { command: 'make all' }))).toMatchObject({ by: 'rule' })
  })
})

describe('TODO 859: 「常に許可」の Bash の規則はハッシュで照合し、秘密を保存しない', () => {
  const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
  const cmd = `curl -H "Authorization: Bearer ${SECRET}" https://example.com`
  const mem = (initial: readonly ApprovalRule[] = []) => {
    const state = {
      rules: [...initial],
      loadApprovalRules: (): readonly ApprovalRule[] => state.rules,
      saveApprovalRules: (rules: readonly ApprovalRule[]): void => {
        state.rules = [...rules]
      }
    }
    return state
  }
  const brokerOf = (store: ApprovalRuleStore): ApprovalBroker =>
    new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, STRICT_POLICY, store)

  it('新しい規則: 保存・一覧に秘密が無く、同じコマンドには効き、別のコマンドは止まる', async () => {
    const store = mem()
    const broker = brokerOf(store)
    const pending = broker.request(req('Bash', { command: cmd }))
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    await pending
    expect(JSON.stringify(store.rules)).not.toContain(SECRET)
    expect(JSON.stringify(broker.listRules())).not.toContain(SECRET)
    expect(broker.listRules()[0]).not.toHaveProperty('commandHash')
    expect(store.rules[0]?.commandHash).toMatch(/^[0-9a-f]{64}$/)
    // It takes effect on the same command even across an equivalent restart.
    const second = brokerOf(store)
    expect(await second.request(req('Bash', { command: cmd.replace(' ', '  ') }))).toMatchObject({ by: 'rule' })
    void second.request(req('Bash', { command: cmd + ' --x' }))
    expect(second.list()).toHaveLength(1)
  })

  it('古い規則 (平文のコマンドだけ) は読み込み時にハッシュ + 伏せた表示へ変換して書き戻す', async () => {
    const store = mem([{ id: 'old', toolName: 'Bash', command: cmd, createdAt: 1 }])
    const broker = brokerOf(store)
    expect(JSON.stringify(store.rules)).not.toContain(SECRET)
    expect(store.rules[0]?.commandHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(broker.listRules())).not.toContain(SECRET)
    expect(await broker.request(req('Bash', { command: cmd }))).toMatchObject({ by: 'rule' })
  })
})

describe('第 42 波 code-review: 規則の表示と変換の冪等', () => {
  const mem = (initial: readonly ApprovalRule[]) => {
    const state = {
      rules: [...initial],
      saves: 0,
      loadApprovalRules: (): readonly ApprovalRule[] => state.rules,
      saveApprovalRules: (rules: readonly ApprovalRule[]): void => {
        state.rules = [...rules]
        state.saves += 1
      }
    }
    return state
  }
  const brokerOf = (store: ApprovalRuleStore): ApprovalBroker =>
    new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, STRICT_POLICY, store)
  const cmdA = 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://example.com'
  const cmdB = 'curl -H "Authorization: Bearer ghp_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210" https://example.com'

  it('伏せた秘密だけが違う 2 つの規則は、hashHead で区別できる (照合の hash 自体は渡さない)', () => {
    const broker = brokerOf(mem([
      { id: 'a', toolName: 'Bash', command: cmdA, createdAt: 1 },
      { id: 'b', toolName: 'Bash', command: cmdB, createdAt: 2 }
    ]))
    const [a, b] = broker.listRules()
    expect(a?.command).toBe(b?.command)
    expect(a?.hashHead).toMatch(/^[0-9a-f]{8}$/)
    expect(a?.hashHead).not.toBe(b?.hashHead)
    expect(a).not.toHaveProperty('commandHash')
  })

  it('一度変換した行は、次の起動で書き戻さない (伏せ字への redaction は冪等)', () => {
    const store = mem([
      { id: 'a', toolName: 'Bash', command: cmdA, createdAt: 1 },
      { id: 'c', toolName: 'Bash', command: 'mysql --password hunter2 -e "select 1"', createdAt: 2 },
      { id: 'd', toolName: 'Bash', command: 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 ./run.sh', createdAt: 3 }
    ])
    brokerOf(store)
    expect(store.saves).toBe(1)
    const once = JSON.stringify(store.rules)
    brokerOf(store)
    brokerOf(store)
    expect(store.saves).toBe(1)
    expect(JSON.stringify(store.rules)).toBe(once)
  })
})

describe('gateway の名前 (項目 110)', () => {
  it('shared の GATEWAY_SERVER_NAME は compat の mcp.serverName と一致する', () => {
    // The namespace of `canAlwaysAllow` (shared), the names passed to the CLI (compat), and the name the gateway claims
    // (src/gateway/index.ts) must all be the same value.
    expect(loadCompatTable().mcp.serverName).toBe(GATEWAY_SERVER_NAME)
    const gateway = readFileSync(join(process.cwd(), 'src/gateway/index.ts'), 'utf8')
    expect(gateway).toContain(`new McpServer({ name: '${GATEWAY_SERVER_NAME}'`)
  })

  it('利用者の MCP ツールに「常に許可」を押すと規則になり、次は聞かれない', async () => {
    const { broker } = makeBroker()
    const first = broker.request(req('mcp__probe__ping', { n: 1 }))
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    expect(await first).toEqual({ allowed: true, by: 'user', message: '' })
    expect(broker.listRules().map((r) => r.toolName)).toEqual(['mcp__probe__ping'])
    expect(await broker.request(req('mcp__probe__ping', { n: 2 }))).toMatchObject({ by: 'rule' })
    expect(broker.list()).toHaveLength(0)
  })
})

describe('規則に場所の概念は無い (T40 / 4.2.1.1)', () => {
  const cwd = join(homedir(), 'proj')

  /**
   * In T26 there was a rule "only inside this working folder" (`scope: 'cwd'`), and for each request it checked whether the target path was under the working folder.
   * **At T40 that concept was removed altogether** (owner decision 2026-09-22): a rule covers the whole app and applies the same way in any thread and any folder.
   * This pins down that "way it takes effect".
   */
  it('作業フォルダの外を触る要求にも同じ規則が当たる', async () => {
    const { broker } = makeBroker()
    const first = broker.request(req('Write', { file_path: join(cwd, 'a.txt') }, { cwd }))
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' })
    await first

    // A different folder, a different thread, or no cwd given -- all pass.
    expect(
      await broker.request(req('Write', { file_path: '/tmp/b.txt' }, { cwd }))
    ).toMatchObject({ by: 'rule' })
    expect(
      await broker.request(req('Write', { file_path: '/tmp/c.txt' }, { threadId: 't2' }))
    ).toMatchObject({ by: 'rule' })
  })

  it('広さ (`scope`) を送ってきても無視する (renderer の値は main で再検証する)', async () => {
    const { broker } = makeBroker()
    const first = broker.request(req('Read', { file_path: join(cwd, 'a.txt') }, { cwd }))
    broker.decide(broker.list()[0]!.id, { kind: 'allow-always' } as never)
    await first
    expect(broker.listRules()[0]).not.toHaveProperty('scope')
  })
})


describe('GatewayServer (7.6)', () => {
  const dirs: string[] = []
  let server: GatewayServer | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'aios-gw-'))
    dirs.push(dir)
    return dir
  }

  /** Sends one frame and reads one line of response. */
  function roundTrip(
    socketPath: string,
    frame: unknown
  ): Promise<{ line: string | null; closed: boolean }> {
    return new Promise((resolve) => {
      const socket = connect(socketPath)
      let buffer = ''
      let line: string | null = null
      socket.on('connect', () => socket.write(`${JSON.stringify(frame)}\n`))
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const index = buffer.indexOf('\n')
        if (index < 0 || line !== null) return
        line = buffer.slice(0, index)
        // Once the response arrives, it does not wait for disconnect. Whether it disconnects is picked up by the close handler.
        setTimeout(() => socket.destroy(), 20)
      })
      socket.on('close', () => resolve({ line, closed: true }))
      socket.on('error', () => resolve({ line, closed: true }))
      setTimeout(() => {
        socket.destroy()
        resolve({ line, closed: false })
      }, 2000)
    })
  }

  it('トークンでセッションを特定して転送する', async () => {
    const seen: string[] = []
    server = new GatewayServer(makeDir(), async (request) => {
      seen.push(request.sessionId)
      return { allowed: true, message: '' }
    })
    await server.start()
    const token = server.issueToken('session-abc')

    const { line } = await roundTrip(server.socketPath, {
      id: 1,
      token,
      payload: { kind: 'approve', toolName: 'Read' }
    })
    expect(JSON.parse(line ?? '{}')).toEqual({ id: 1, result: { allowed: true, message: '' } })
    expect(seen).toEqual(['session-abc'])
  })

  it('トークン不一致のフレームは拒否して切断する', async () => {
    let called = false
    server = new GatewayServer(makeDir(), async () => {
      called = true
      return {}
    })
    await server.start()
    server.issueToken('session-abc')

    const { line } = await roundTrip(server.socketPath, {
      id: 7,
      token: 'wrong',
      payload: { kind: 'approve' }
    })
    expect(JSON.parse(line ?? '{}')).toEqual({ id: 7, error: 'unauthorized' })
    expect(called).toBe(false)
  })

  it('失効したトークンは通らない', async () => {
    server = new GatewayServer(makeDir(), async () => ({}))
    await server.start()
    const token = server.issueToken('session-abc')
    server.revokeToken(token)

    const { line } = await roundTrip(server.socketPath, { id: 1, token, payload: {} })
    expect(JSON.parse(line ?? '{}').error).toBe('unauthorized')
  })

  it('ハンドラの例外はエラーとして返し、接続を殺さない', async () => {
    server = new GatewayServer(makeDir(), async () => {
      throw new Error('broker down')
    })
    await server.start()
    const token = server.issueToken('s1')
    const { line } = await roundTrip(server.socketPath, {
      id: 3,
      token,
      payload: { kind: 'approve' }
    })
    expect(JSON.parse(line ?? '{}')).toEqual({ id: 3, error: 'broker down' })
  })

  it('ソケットは所有者のみ (0600)', async () => {
    server = new GatewayServer(makeDir(), async () => ({}))
    await server.start()
    const mode = statSync(server.socketPath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('TODO 1055 (review): toolStageAsks — 聞くことだけを道具の段に譲る', () => {
  const base = { threadId: 't1', threadTitle: 'T', toolName: 'mcp__aios__getOpenUrlText', summary: '', input: {} }
  const make = (): ApprovalBroker => new ApprovalBroker({ onChanged: () => {}, onDecided: () => {} }, STRICT_POLICY)

  it('厳格モードでも既定の外でも、積む理由がそれだけなら聞かずに通す', async () => {
    const broker = make()
    await expect(broker.request({ ...base, strict: true, toolStageAsks: true })).resolves.toMatchObject({ allowed: true })
    expect(broker.list()).toHaveLength(0)
    // A request that does not yield (no flag) is queued as before.
    void broker.request({ ...base, strict: true })
    expect(broker.list()).toHaveLength(1)
  })

  it('秘密を読んだ後の外への道・外へ出す操作は、旗があっても積む', () => {
    const broker = make()
    broker.markSecretRead('t1', 'ssh-key')
    void broker.request({ ...base, egress: 'open-url', toolStageAsks: true })
    void broker.request({
      ...base,
      outbound: { match: 'curl', kind: 'network' } as never,
      toolStageAsks: true
    })
    expect(broker.list()).toHaveLength(2)
  })
})
