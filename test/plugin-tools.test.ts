/**
 * TODO 847 (ARCHITECTURE 7.2 / 7.6.7): tools a plugin exposes to the model.
 *
 *  - The subset of the argument schema and its limits (`tool-schema.ts`)
 *  - Validation of the manifest's `mcp.tools` (names, duplicates, count, name length at the gateway)
 *  - Relay (`PluginToolRelay`): listing, lookup, re-checking of arguments, result limits, how failures are split, audit (no values kept)
 *  - `GatewayRequests`: listing and calls. `sideEffect` asks the approval inbox every time; the `approve` stage does not ask twice
 *  - `ApprovalBroker`'s `alwaysAsk`: queued even when everything is auto-allowed by default
 *
 * Does not start plugin-host (a fake `PluginToolSource`). Does not call the model.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AiosEvent } from '../src/shared/agent.js'
import type { AuditEntry, PluginToolDeclaration } from '../src/shared/plugin.js'
import type { Thread } from '../src/shared/thread.js'
import { DEFAULT_APPROVAL_POLICY, GATEWAY_TOOL_PREFIX } from '../src/shared/thread.js'
import {
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_SCHEMA_CHARS,
  checkToolArgs,
  checkToolSchema
} from '../src/main/plugin/tool-schema.js'
import {
  ManifestError,
  isDeclaredExport,
  missingExports,
  parseManifest,
  pluginToolExposedName
} from '../src/main/plugin/manifest.js'
import {
  MAX_PLUGIN_TOOL_RESULT_CHARS,
  PluginToolRelay,
  approvalDenyReason,
  type PluginToolSource
} from '../src/main/plugin/tools.js'
import type { EnabledPluginTool } from '../src/main/plugin/host.js'
import { GatewayRequests, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import type { ApprovalRequestInput, ApprovalResult } from '../src/main/approval/broker.js'
import { ApprovalBroker } from '../src/main/approval/broker.js'

const OBJECT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 200, description: 'page' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 3 }
  },
  required: ['url'],
  additionalProperties: false
}

describe('引数のスキーマ (checkToolSchema)', () => {
  it('部分集合のスキーマを受ける', () => {
    expect(checkToolSchema(OBJECT_SCHEMA)).toBeNull()
    expect(checkToolSchema({ type: 'object' })).toBeNull()
  })

  it('最上位が object でない・知らない語 (pattern など)・required の名前が無いものは断る', () => {
    expect(checkToolSchema({ type: 'string' })).toMatch(/type "object"/)
    expect(checkToolSchema([])).toMatch(/must be an object/)
    expect(checkToolSchema({ type: 'object', properties: { a: { type: 'string', pattern: '(a+)+$' } } })).toMatch(
      /unsupported keyword "pattern"/
    )
    expect(checkToolSchema({ type: 'object', $ref: '#/x' })).toMatch(/unsupported keyword/)
    expect(checkToolSchema({ type: 'object', required: ['x'] })).toMatch(/not in properties/)
    expect(checkToolSchema({ type: 'object', properties: { a: { type: 'date' } } })).toMatch(/type must be one of/)
    expect(checkToolSchema({ type: 'object', properties: { a: { type: 'string', enum: [] } } })).toMatch(/enum/)
    expect(checkToolSchema({ type: 'object', properties: { a: { type: 'string', enum: [{}] } } })).toMatch(/enum/)
    expect(checkToolSchema({ type: 'object', properties: { a: { type: 'string', items: { type: 'string' } } } })).toMatch(
      /only for type "array"/
    )
    expect(checkToolSchema({ type: 'object', additionalProperties: { type: 'string' } })).toMatch(/true or false/)
  })

  it('深さ・properties の数・大きさに上限', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 6; i += 1) deep = { type: 'object', properties: { x: deep } }
    expect(checkToolSchema(deep)).toMatch(/nested deeper than 6/)
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, { type: 'string' }]))
    expect(checkToolSchema({ type: 'object', properties: many })).toMatch(/more than 32 properties/)
    expect(checkToolSchema({ type: 'object', description: 'x'.repeat(MAX_TOOL_SCHEMA_CHARS) })).toMatch(/exceeds/)
  })
})

describe('引数の検め直し (checkToolArgs)', () => {
  it('合うものは通す', () => {
    expect(checkToolArgs(OBJECT_SCHEMA, { url: 'https://x', limit: 3, mode: 'a', tags: ['t'] })).toBeNull()
  })

  it('型・必須・知らない欄・enum・範囲・数を断り、値は文に入れない', () => {
    expect(checkToolArgs(OBJECT_SCHEMA, 'secret-value')).toBe('arguments: expected object')
    expect(checkToolArgs(OBJECT_SCHEMA, {})).toBe('arguments.url: required')
    expect(checkToolArgs(OBJECT_SCHEMA, { url: 'x', other: 'secret-value' })).toBe('arguments: unknown property')
    expect(checkToolArgs(OBJECT_SCHEMA, { url: 'x', mode: 'secret-value' })).toBe('arguments.mode: not one of the allowed values')
    expect(checkToolArgs(OBJECT_SCHEMA, { url: '' })).toBe('arguments.url: too short')
    expect(checkToolArgs(OBJECT_SCHEMA, { url: 'x', limit: 1.5 })).toBe('arguments.limit: expected integer')
    expect(checkToolArgs(OBJECT_SCHEMA, { url: 'x', limit: 99 })).toBe('arguments.limit: above maximum')
    expect(checkToolArgs(OBJECT_SCHEMA, { url: 'x', tags: ['a', 'b', 'c', 'd'] })).toBe('arguments.tags: too many items')
    expect(checkToolArgs(OBJECT_SCHEMA, { url: 'x', tags: [1] })).toBe('arguments.tags[0]: expected string')
    expect(checkToolArgs(OBJECT_SCHEMA, { url: 'x'.repeat(MAX_TOOL_ARGS_CHARS) })).toMatch(/exceed/)
  })

  it('additionalProperties を書かなければ知らない欄も通す (JSON Schema の既定)', () => {
    expect(checkToolArgs({ type: 'object', properties: {} }, { anything: 1 })).toBeNull()
  })
})

const base = { id: 'test.tools', name: 'Tools', version: '1.0.0', host: { entry: 'h.js' } }
const tool = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'fetchPage',
  description: 'Fetch a page.',
  inputSchema: OBJECT_SCHEMA,
  ...overrides
})

describe('マニフェストの mcp.tools', () => {
  it('道具を読み、宣言した道具だけを呼べる', () => {
    const manifest = parseManifest({ ...base, mcp: { tools: [tool(), tool({ name: 'send', sideEffect: true })] } })
    expect(manifest.mcp?.tools?.map((t) => t.name)).toEqual(['fetchPage', 'send'])
    expect(isDeclaredExport(manifest, 'mcp', 'fetchPage')).toBe(true)
    expect(isDeclaredExport(manifest, 'mcp', 'other')).toBe(false)
    expect(missingExports(manifest, { commands: [], mcp: ['fetchPage'], indexer: [] })).toEqual(['mcp:send'])
  })

  it('道具の宣言が無い mcp は何も呼べない', () => {
    const manifest = parseManifest({ ...base, mcp: {} })
    expect(isDeclaredExport(manifest, 'mcp', 'anything')).toBe(false)
  })

  it('名前・重複・数・知らない鍵・スキーマ・gateway での名前の長さを検める', () => {
    const bad = (tools: unknown[], id = base.id): unknown => () => parseManifest({ ...base, id, mcp: { tools } })
    expect(bad([tool({ name: '1abc' })])).toThrow(ManifestError)
    expect(bad([tool({ name: 'a.b' })])).toThrow(ManifestError)
    expect(bad([tool({ name: 'x'.repeat(33) })])).toThrow(ManifestError)
    expect(bad([tool(), tool()])).toThrow(/collide/)
    expect(bad(Array.from({ length: 17 }, (_, i) => tool({ name: `t${i}` })))).toThrow(ManifestError)
    expect(bad([tool({ extra: 1 })])).toThrow(ManifestError)
    expect(bad([tool({ description: '' })])).toThrow(ManifestError)
    expect(bad([tool({ inputSchema: { type: 'string' } })])).toThrow(/type "object"/)
    expect(bad([tool({ name: 'x'.repeat(30) })], `a.${'b'.repeat(30)}`)).toThrow(/longer than 53/)
  })

  it('gateway での名前は id の . を _ にして __ で道具名を繋ぐ (組み込みの道具と重ならない)', () => {
    expect(pluginToolExposedName('aios.reddit', 'fetchThread')).toBe('aios_reddit__fetchThread')
    expect(pluginToolExposedName('com.ex-ample.x', 'a')).toBe('com_ex-ample_x__a')
    for (const builtin of ['approve', 'search', 'openFile', 'startBundles']) expect(builtin.includes('__')).toBe(false)
  })
})

function declaration(overrides: Partial<PluginToolDeclaration> = {}): PluginToolDeclaration {
  return { name: 'fetchPage', description: 'Fetch.', inputSchema: OBJECT_SCHEMA, ...overrides }
}

function makeRelay(options: {
  tools?: EnabledPluginTool[]
  invoke?: PluginToolSource['invoke']
} = {}): { relay: PluginToolRelay; audit: AuditEntry[]; source: { tools: EnabledPluginTool[] } } {
  const audit: AuditEntry[] = []
  const source = {
    tools: options.tools ?? [
      { pluginId: 'test.tools', pluginName: 'Tools', tool: declaration() },
      { pluginId: 'test.tools', pluginName: 'Tools', tool: declaration({ name: 'send', sideEffect: true }) }
    ]
  }
  const relay = new PluginToolRelay({
    source: {
      enabledTools: () => source.tools,
      invoke: options.invoke ?? (async () => 'ok')
    },
    audit: { record: (entry) => audit.push(entry) }
  })
  return { relay, audit, source }
}

describe('中継 (PluginToolRelay)', () => {
  it('一覧は gateway での名前・見出し・説明・スキーマ', () => {
    const { relay } = makeRelay()
    expect(relay.list()).toEqual([
      { name: 'test_tools__fetchPage', title: 'Tools: fetchPage', description: 'Fetch.', inputSchema: OBJECT_SCHEMA },
      { name: 'test_tools__send', title: 'Tools: send', description: 'Fetch.', inputSchema: OBJECT_SCHEMA }
    ])
    expect(relay.lookup('test_tools__send')?.sideEffect).toBe(true)
    expect(relay.lookup('test_tools__fetchPage')?.sideEffect).toBe(false)
  })

  it('無効にした plugin の道具は引けず、呼ぶと拒んで監査に残る', () => {
    const { relay, audit, source } = makeRelay()
    source.tools = []
    expect(relay.list()).toEqual([])
    expect(relay.prepare('test_tools__fetchPage', { url: 'x' })).toEqual({
      ok: false,
      error: 'this tool is not available: its plugin is disabled or was removed'
    })
    // target is just the tool name, as in a normal call (the plugin id is in the pluginId field, TODO 883).
    expect(audit).toMatchObject([
      { pluginId: 'test.tools', capability: 'mcp', op: 'tool', target: 'fetchPage', decision: 'deny', reason: 'unavailable' }
    ])
  })

  it('引数はスキーマで検め直し、落ちたら plugin-host を呼ばない', async () => {
    const invoke = vi.fn(async () => 'ok')
    const { relay, audit } = makeRelay({ invoke })
    const prepared = relay.prepare('test_tools__fetchPage', { url: 'x', extra: 'secret-value' })
    expect(prepared).toEqual({ ok: false, error: 'invalid arguments: arguments: unknown property' })
    expect(invoke).not.toHaveBeenCalled()
    expect(audit[0]).toMatchObject({ target: 'fetchPage', reason: 'invalid-args' })
  })

  it('呼び出しは mcp 区分で plugin-host へ。文字列は text、それ以外は result。監査は値を残さない', async () => {
    const invoke = vi.fn(async (_id: string, _name: string, arg: unknown) => (typeof arg === 'object' ? { got: 1 } : 'x'))
    const { relay, audit } = makeRelay({ invoke })
    const prepared = relay.prepare('test_tools__fetchPage', { url: 'secret-value' })
    if (!prepared.ok) throw new Error('not prepared')
    expect(await relay.run(prepared.tool, prepared.args)).toEqual({ result: { got: 1 } })
    expect(invoke).toHaveBeenCalledWith('test.tools', 'fetchPage', { url: 'secret-value' }, 'mcp', 60_000)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ pluginId: 'test.tools', capability: 'mcp', op: 'tool', target: 'fetchPage', decision: 'allow', reason: null })
    expect(typeof audit[0]?.ms).toBe('number')
    expect(JSON.stringify(audit)).not.toContain('secret-value')

    const text = makeRelay({ invoke: async () => 'hello' })
    const p2 = text.relay.prepare('test_tools__fetchPage', { url: 'x' })
    if (!p2.ok) throw new Error('not prepared')
    expect(await text.relay.run(p2.tool, p2.args)).toEqual({ text: 'hello' })
  })

  it('落ちた・応答しない・投げた・大きすぎる結果はエラーの JSON で返す (投げない)', async () => {
    const cases: [PluginToolSource['invoke'], string, string][] = [
      [async () => Promise.reject(new Error('plugin host exited')), 'the plugin stopped while running this tool', 'crashed'],
      [async () => Promise.reject(new Error('plugin invoke timeout')), 'the plugin did not answer in time', 'timeout'],
      [async () => Promise.reject(new Error('plugin not available')), 'this tool is not available: its plugin is disabled or was removed', 'unavailable'],
      [async () => Promise.reject(new Error('boom')), 'the plugin reported an error: boom', 'error'],
      [async () => 'x'.repeat(MAX_PLUGIN_TOOL_RESULT_CHARS + 1), `the plugin returned more than ${MAX_PLUGIN_TOOL_RESULT_CHARS} characters`, 'too-large']
    ]
    for (const [invoke, error, reason] of cases) {
      const { relay, audit } = makeRelay({ invoke })
      const prepared = relay.prepare('test_tools__fetchPage', { url: 'x' })
      if (!prepared.ok) throw new Error('not prepared')
      expect(await relay.run(prepared.tool, prepared.args)).toEqual({ error })
      expect(audit.at(-1)).toMatchObject({ decision: 'deny', reason })
    }
  })
})

describe('GatewayRequests の plugin の道具 (7.6.7)', () => {
  function setup(answer: ApprovalResult = { allowed: true, by: 'user', message: '' }): {
    requests: GatewayRequests
    approvals: ApprovalRequestInput[]
    invoke: ReturnType<typeof vi.fn>
    audit: AuditEntry[]
    events: AiosEvent[]
  } {
    const invoke = vi.fn(async () => 'done')
    const { relay, audit } = makeRelay({ invoke })
    const approvals: ApprovalRequestInput[] = []
    const events: AiosEvent[] = []
    const host: Partial<GatewayRequestHost> = {
      isStopped: () => false,
      threadIdForSession: (sessionId) => (sessionId === 's1' ? 't1' : undefined),
      getThread: (id) =>
        id === 't1'
          ? ({ id, title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false } as unknown as Thread)
          : null,
      getLive: () => undefined,
      getAdapter: () => undefined,
      emitThread: () => undefined,
      record: (_threadId, event) => {
        events.push(event)
      },
      hasPlanMode: () => false,
      requestApproval: async (input) => {
        approvals.push(input)
        return answer
      },
      pluginTools: relay
    }
    return { requests: new GatewayRequests(host as GatewayRequestHost), approvals, invoke, audit, events }
  }

  /** The outcome and toolUseId of each recorded `permission_request`, in order. */
  function permissionRecords(
    events: readonly AiosEvent[]
  ): { toolName: string; toolUseId: string | null; outcome: unknown; requestId: string }[] {
    return events.flatMap((event) =>
      event.kind === 'permission_request'
        ? [
            {
              toolName: event.payload.toolName,
              toolUseId: event.payload.toolUseId,
              outcome: event.payload.outcome,
              requestId: event.payload.requestId
            }
          ]
        : []
    )
  }

  it('sideEffect の道具の承認は、approve と同じ permission_request の pending / decided を残す (第 45 波 code-review)', async () => {
    const { requests, events } = setup()
    await requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__send', arguments: { url: 'https://example.com' } }
    })
    const records = permissionRecords(events)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      toolName: `${GATEWAY_TOOL_PREFIX}test_tools__send`,
      toolUseId: null,
      outcome: { kind: 'pending' }
    })
    expect(records[1]).toMatchObject({ outcome: { kind: 'allowed', by: 'user' } })
    expect(records[1]?.requestId).toBe(records[0]?.requestId)
  })

  it('断ったときも決着 (denied) を残す。読み取りの道具は何も残さない', async () => {
    const denied = setup({ allowed: false, by: 'user', message: 'approval-denied-user', reply: { kind: 'stop' } })
    await denied.requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__send', arguments: { url: 'x' } }
    })
    expect(permissionRecords(denied.events).map((r) => r.outcome)).toEqual([
      { kind: 'pending' },
      { kind: 'denied', by: 'user', message: 'approval-denied-user', reply: 'stop' }
    ])
    const read = setup()
    await read.requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__fetchPage', arguments: { url: 'x' } }
    })
    expect(permissionRecords(read.events)).toEqual([])
  })

  it('approve の段で通した tool_use_id を中継の段の承認に付ける (タイムラインの道具の行に付く)', async () => {
    const { requests, events, approvals } = setup()
    const deferred = await requests.handle({
      sessionId: 's1',
      kind: 'approve',
      payload: { toolName: `${GATEWAY_TOOL_PREFIX}test_tools__send`, toolUseId: 'tu-1', input: { url: 'x' } }
    })
    expect(deferred).toEqual({ allowed: true, message: '' })
    // Not recorded at the approve stage (no "allowed" line before the user's answer).
    expect(permissionRecords(events)).toEqual([])
    await requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__send', arguments: { url: 'x' } }
    })
    expect(approvals[0]?.toolUseId).toBe('tu-1')
    expect(permissionRecords(events).map((r) => r.toolUseId)).toEqual(['tu-1', 'tu-1'])
    // A held result is consumed once.
    await requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__send', arguments: { url: 'x' } }
    })
    expect(approvals[1]?.toolUseId).toBeNull()
  })

  it('CLI が呼び出しに付けた tool_use_id (payload.toolUseId) があれば、並行の呼び出しでも自分の行に付く (TODO 883)', async () => {
    const { requests, approvals } = setup()
    for (const id of ['tu-a', 'tu-b']) {
      await requests.handle({
        sessionId: 's1',
        kind: 'approve',
        payload: { toolName: `${GATEWAY_TOOL_PREFIX}test_tools__send`, toolUseId: id, input: { url: 'x' } }
      })
    }
    // Even if a later call arrives first, it attaches to its own mark.
    await requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__send', arguments: { url: 'x' }, toolUseId: 'tu-b' }
    })
    await requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__send', arguments: { url: 'x' }, toolUseId: 'tu-a' }
    })
    expect(approvals.map((a) => a.toolUseId)).toEqual(['tu-b', 'tu-a'])
  })

  it('aios の取り下げ (取り消し・時間切れ・終了) は監査に cancelled で残し、user-denied と分ける', async () => {
    const { requests, audit, events } = setup({
      allowed: false,
      by: 'system',
      message: 'approval-cancelled-tool-timeout',
      reply: { kind: 'cancelled', reason: 'tool-timeout' }
    })
    const result = (await requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__send', arguments: { url: 'x' } }
    })) as { error: string }
    expect(result.error).toMatch(/timed out/)
    expect(audit.at(-1)).toMatchObject({ target: 'send', decision: 'deny', reason: 'cancelled' })
    expect(permissionRecords(events).at(-1)?.outcome).toEqual({
      kind: 'denied',
      by: 'system',
      message: 'approval-cancelled-tool-timeout'
    })
  })

  it('approvalDenyReason: 利用者の拒否・取り下げ・その他の system の拒否を分ける', () => {
    expect(approvalDenyReason({ by: 'user', reply: { kind: 'stop' } })).toBe('user-denied')
    expect(approvalDenyReason({ by: 'user', reply: { kind: 'feedback' } })).toBe('user-denied')
    expect(approvalDenyReason({ by: 'user' })).toBe('user-denied')
    expect(approvalDenyReason({ by: 'system', reply: { kind: 'cancelled' } })).toBe('cancelled')
    expect(approvalDenyReason({ by: 'system' })).toBe('system-denied')
  })

  it('一覧を返す', async () => {
    const { requests } = setup()
    const result = (await requests.handle({ sessionId: 's1', kind: 'pluginTools', payload: {} })) as { tools: { name: string }[] }
    expect(result.tools.map((t) => t.name)).toEqual(['test_tools__fetchPage', 'test_tools__send'])
  })

  it('読み取りの道具は聞かずに中継する', async () => {
    const { requests, approvals, invoke } = setup()
    const result = await requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__fetchPage', arguments: { url: 'x' } }
    })
    expect(result).toEqual({ text: 'done' })
    expect(approvals).toEqual([])
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('sideEffect の道具は承認箱で必ず聞く (alwaysAsk)。通れば中継する', async () => {
    const { requests, approvals, invoke } = setup()
    const result = await requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__send', arguments: { url: 'https://example.com' } }
    })
    expect(result).toEqual({ text: 'done' })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      threadId: 't1',
      toolName: `${GATEWAY_TOOL_PREFIX}test_tools__send`,
      alwaysAsk: true,
      summary: 'https://example.com',
      input: { url: 'https://example.com' }
    })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('断られたら中継せず、断った旨をモデルに返し、監査に残す', async () => {
    const { requests, invoke, audit } = setup({
      allowed: false,
      by: 'user',
      message: 'approval-denied-user',
      reply: { kind: 'stop' }
    })
    const result = (await requests.handle({
      sessionId: 's1',
      kind: 'pluginTool',
      payload: { name: 'test_tools__send', arguments: { url: 'x' } }
    })) as { error: string }
    expect(result.error).toMatch(/denied/)
    expect(invoke).not.toHaveBeenCalled()
    expect(audit.at(-1)).toMatchObject({ target: 'send', decision: 'deny', reason: 'user-denied' })
  })

  it('引数が合わない・無い道具は聞く前に断る', async () => {
    const { requests, approvals } = setup()
    expect(
      await requests.handle({ sessionId: 's1', kind: 'pluginTool', payload: { name: 'test_tools__send', arguments: {} } })
    ).toEqual({ error: 'invalid arguments: arguments.url: required' })
    expect(
      await requests.handle({ sessionId: 's1', kind: 'pluginTool', payload: { name: 'nope__x', arguments: {} } })
    ).toMatchObject({ error: expect.stringMatching(/not available/) })
    expect(approvals).toEqual([])
  })

  it('バックエンドの権限の確認 (approve) では、sideEffect の plugin の道具を積まない (中継で聞くので二重にしない)', async () => {
    const { requests, approvals } = setup()
    const deferred = await requests.handle({
      sessionId: 's1',
      kind: 'approve',
      payload: { toolName: `${GATEWAY_TOOL_PREFIX}test_tools__send`, input: { url: 'x' } }
    })
    expect(deferred).toEqual({ allowed: true, message: '' })
    expect(approvals).toEqual([])
    // Read-only tools go to the Broker as usual (the default auto-allow and strict mode are decided there).
    await requests.handle({
      sessionId: 's1',
      kind: 'approve',
      payload: { toolName: `${GATEWAY_TOOL_PREFIX}test_tools__fetchPage`, input: { url: 'x' } }
    })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.alwaysAsk).toBeUndefined()
  })
})

describe('ApprovalBroker の alwaysAsk (TODO 847)', () => {
  it('既定の全部自動許可でも積み、利用者の答えで決まる', async () => {
    const broker = new ApprovalBroker(
      { onChanged: () => undefined, onDecided: () => undefined },
      { ...DEFAULT_APPROVAL_POLICY, autoAllowAll: true }
    )
    const input = { threadId: 't', threadTitle: 'T', toolName: `${GATEWAY_TOOL_PREFIX}a__b`, summary: '', input: {} }
    expect(await broker.request(input)).toMatchObject({ allowed: true, by: 'default' })
    const pending = broker.request({ ...input, alwaysAsk: true })
    const queued = broker.list()
    expect(queued).toHaveLength(1)
    broker.decide(queued[0]?.id ?? '', { kind: 'allow' } as never)
    expect(await pending).toMatchObject({ allowed: true, by: 'user' })
  })
})
