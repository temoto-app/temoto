/**
 * The round trip of OpenCodeAdapter (TODO 529). Does not start `opencode serve` or any model; it connects to a fake HTTP + SSE server that imitates the v2 API shape (`link`). What it pins down:
 * - spawn: creates a session and emits `session_started`. The working directory is passed in the header
 * - send: POSTs the prompt, passes permission.asked to `onPermission`, and returns the answer with `once` / `reject`
 * - tools, text, usage and result stream in order; `sawResult` is set on the result
 * - interrupt: an interrupted result (`interrupted: true`)
 * - switchSettings: POSTs the model switch
 * - stop: `onExit` once with `requested: true`
 * - listModels: the list uses `provider/model` ids, free ones first, the preferred one first
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpenCodeAdapter, modelChoicesOf, serverConfigOf } from '../src/main/session/adapter-opencode/index.js'
import { OpenCodeServer } from '../src/main/session/adapter-opencode/server.js'
import { loadOpenCodeTable } from '../src/main/session/adapter-opencode/compat.js'
import { detectOllama, ollamaBaseOf, userConfiguresOllama } from '../src/main/session/adapter-opencode/local.js'
import type { AiosEvent } from '../src/shared/agent.js'
import type { GatewayEndpoint, PermissionAsk } from '../src/main/session/types.js'
import { APPROVAL_CANCEL_REASONS } from '../src/main/approval/reply.js'
import { EXTERNAL_DIRECTORY_TOOL, externalDirectoryPath } from '../src/shared/approval-tools.js'

const table = loadOpenCodeTable()

const gateway: GatewayEndpoint = {
  socketPath: '/tmp/aios-test.sock',
  token: 'tok',
  scriptPath: '/app/gateway.js',
  runtimePath: '/app/electron',
  configDir: '/tmp/aios-test-config'
}

/** A fake of the v2 API. It can emit any event to the SSE subscribers. */
class FakeServe {
  server: Server
  baseUrl = ''
  readonly requests: { method: string; url: string; body: unknown; headers: IncomingMessage['headers'] }[] = []
  private readonly subscribers = new Set<ServerResponse>()
  sessions = new Set<string>(['ses_old'])
  models: unknown[] = [
    { providerID: 'ollama', id: 'gpt-oss:20b', name: 'gpt-oss:20b', cost: [{ input: 0, output: 0 }], status: 'active' },
    { providerID: 'opencode', id: 'glm-5.3-flash-free', name: 'GLM 5.3 Flash', cost: [{ input: 0, output: 0 }], status: 'active' },
    { providerID: 'moonshot', id: 'kimi-k2.6', name: 'Kimi K2.6', cost: [{ input: 0.6, output: 2.5 }], status: 'active' },
    { providerID: 'opencode', id: 'big-pickle', name: 'Big Pickle', cost: [{ input: 0, output: 0 }], status: 'active' },
    { providerID: 'x', id: 'gone', name: 'gone', cost: [{ input: 0, output: 0 }], status: 'deprecated' }
  ]
  /**
   * TODO 1078: the response of `GET /api/config`. undefined gives 404 (a version that does not return settings; judged by the list row).
   * If it is a function, it receives the working-directory header and returns the response (the folder settings of the conversation).
   */
  config: unknown = undefined
  /** TODO 1024: the list of servers for `GET /api/mcp`. */
  mcpServers: string[] = ['aios', 'slack.work', 'google_search']
  /** The status of the `GET /api/mcp` response (imitates a failure). */
  mcpStatus = 200
  /** TODO 1115: the response to `POST …/prompt`. `'drop'` cuts the connection without a response (imitates a connection failure). */
  promptReply: number | 'drop' = 200
  private nextSession = 1

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res))
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
  }

  close(): void {
    for (const sub of this.subscribers) sub.end()
    this.server.close()
  }

  emit(type: string, data: unknown): void {
    const frame = `data: ${JSON.stringify({ id: 'evt', type, data })}\n\n`
    for (const sub of this.subscribers) sub.write(frame)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString()
    const body = raw === '' ? null : (JSON.parse(raw) as unknown)
    const url = req.url ?? ''
    const method = req.method ?? ''
    this.requests.push({ method, url, body, headers: req.headers })
    if (req.headers['authorization'] !== 'Basic dGVzdDp0ZXN0') {
      res.writeHead(401).end()
      return
    }
    if (method === 'GET' && url === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`)
      this.subscribers.add(res)
      req.on('close', () => this.subscribers.delete(res))
      return
    }
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    }
    if (method === 'GET' && url === '/api/model') {
      return json(200, { data: this.models })
    }
    if (method === 'GET' && url === '/api/mcp') {
      if (this.mcpStatus !== 200) return json(this.mcpStatus, { error: 'down' })
      return json(200, { data: this.mcpServers.map((name) => ({ name, status: { status: 'connected' } })) })
    }
    if (method === 'GET' && url === '/api/config') {
      const directory = req.headers[table.serve.directoryHeader]
      const config =
        typeof this.config === 'function'
          ? (this.config as (dir: string | undefined) => unknown)(typeof directory === 'string' ? directory : undefined)
          : this.config
      return config === undefined ? json(404, { error: 'no route' }) : json(200, config)
    }
    if (method === 'POST' && url === '/api/session') {
      const id = `ses_${(this.nextSession += 1)}`
      this.sessions.add(id)
      return json(200, { data: { id } })
    }
    const m = /^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(url)
    if (m === null) return json(404, { error: 'no route' })
    const id = decodeURIComponent(m[1] ?? '')
    const rest = m[2] ?? ''
    if (!this.sessions.has(id)) return json(404, { error: 'no session' })
    if (method === 'GET' && rest === '') return json(200, { data: { id } })
    if (method === 'POST' && rest === 'prompt') {
      if (this.promptReply === 'drop') {
        req.socket.destroy()
        return
      }
      return json(this.promptReply, this.promptReply < 300 ? { data: {} } : { error: 'busy' })
    }
    if (method === 'POST' && rest === 'interrupt') return json(200, { interrupted: true })
    if (method === 'POST' && rest === 'model') {
      res.writeHead(204).end()
      return
    }
    if (method === 'POST' && rest.startsWith('permission/')) {
      res.writeHead(204).end()
      return
    }
    return json(404, { error: 'no route' })
  }
}

const link = { baseUrl: '', authorization: 'Basic dGVzdDp0ZXN0' }

/** The default fetch, so as not to connect to a local Ollama. */
const noOllama: typeof fetch = async () => {
  throw new Error('connect ECONNREFUSED')
}

/** A fake Ollama `/api/tags` (TODO 1016). */
function fakeTags(models: unknown[], seen: string[] = []): typeof fetch {
  return async (input) => {
    seen.push(String(input))
    return new Response(JSON.stringify({ models }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

function spawnOptions(overrides: Partial<Parameters<OpenCodeAdapter['spawn']>[0]> = {}): Parameters<OpenCodeAdapter['spawn']>[0] {
  return {
    sessionId: 'aios-s1',
    threadId: 'thread-1',
    cwd: '/work/project',
    allowedDirs: [],
    resumeBackendSessionId: null,
    modelId: 'opencode/big-pickle',
    thinking: null,
    gateway,
    ...overrides
  }
}

const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const until = Date.now() + ms
  while (!pred()) {
    if (Date.now() > until) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('OpenCodeAdapter', () => {
  let fake: FakeServe
  let adapter: OpenCodeAdapter

  beforeEach(async () => {
    fake = new FakeServe()
    await fake.listen()
    adapter = new OpenCodeAdapter({ link: { ...link, baseUrl: fake.baseUrl }, fetch: noOllama }, table)
  })

  afterEach(async () => {
    await adapter.shutdown()
    fake.close()
  })

  it('getStatus / supports are as in the table; listModels puts free first, preferred first of all, and drops deprecated', async () => {
    const status = await adapter.getStatus()
    expect(status.available).toBe(true)
    expect(status.loggedIn).toBe(true)
    expect(adapter.supports('model-select')).toBe(true)
    expect(adapter.supports('thinking-level')).toBe(false)
    const models = await adapter.listModels()
    expect(models.map((m) => m.id)).toEqual([
      'opencode/big-pickle',
      'opencode/glm-5.3-flash-free',
      'ollama/gpt-oss:20b',
      'moonshot/kimi-k2.6'
    ])
    expect(models[1]?.label).toContain(table.models.freeSuffix.trim())
    // Local providers do not get (free) added (zero cost is a given).
    expect(models[2]?.label).not.toContain(table.models.freeSuffix.trim())
    expect(adapter.modelLabel('moonshot/kimi-k2.6')).toBe('moonshot/Kimi K2.6')
  })

  it('serverConfigOf passes the gateway as an MCP local server and permission follows the table rules', () => {
    const config = serverConfigOf(table, gateway, 'aios-s1') as Record<string, Record<string, unknown>>
    const mcp = config['mcp']?.[table.mcp.serverName] as Record<string, unknown>
    expect(mcp['type']).toBe('local')
    expect(mcp['command']).toEqual(['/app/electron', '/app/gateway.js'])
    expect((mcp['environment'] as Record<string, string>)['AIOS_TOKEN']).toBe('tok')
    expect((mcp['environment'] as Record<string, string>)['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(config['permission']?.['*']).toBe('ask')
    expect(config['permission']?.['read']).toBe('allow')
    // The ledger's serve does not get the gateway.
    expect(serverConfigOf(table, null, null)['mcp']).toBeUndefined()
  })

  it('one turn of spawn → send → permission → result (allowed)', async () => {
    const events: AiosEvent[] = []
    const asks: PermissionAsk[] = []
    const onExit = vi.fn()
    const session = await adapter.spawn(spawnOptions(), {
      onEvent: (e) => events.push(e),
      onExit,
      onPermission: async (ask) => {
        asks.push(ask)
        return { allowed: true, message: '' }
      }
    })
    expect(events[0]?.kind).toBe('session_started')
    expect(events[0]?.kind === 'session_started' && events[0].payload.backendSessionId).toBe('ses_2')
    expect(events[0]?.kind === 'session_started' && events[0].payload.cwd).toBe('/work/project')
    const created = fake.requests.find((r) => r.method === 'POST' && r.url === '/api/session')
    expect(created?.body).toEqual({ location: { directory: '/work/project' }, model: { providerID: 'opencode', id: 'big-pickle' } })
    expect(created?.headers[table.serve.directoryHeader]).toBe('/work/project')
    await waitFor(() => fake.requests.some((r) => r.url === '/api/event'))

    session.send({ text: 'run ls' })
    await waitFor(() => fake.requests.some((r) => r.url.endsWith('/prompt')))
    expect(fake.requests.find((r) => r.url.endsWith('/prompt'))?.body).toEqual({ text: 'run ls' })

    const sid = 'ses_2'
    const msg = 'msg_1'
    fake.emit('session.execution.started', { sessionID: sid })
    fake.emit('session.step.started', { sessionID: sid, assistantMessageID: msg, model: { id: 'big-pickle', providerID: 'opencode' } })
    fake.emit('session.tool.input.started', { sessionID: sid, assistantMessageID: msg, id: 'call_1', name: 'shell' })
    fake.emit('session.tool.called', { sessionID: sid, assistantMessageID: msg, id: 'call_1', input: { command: 'ls' } })
    fake.emit('permission.asked', {
      id: 'per_1',
      sessionID: sid,
      action: 'shell',
      resources: ['ls'],
      save: ['ls *'],
      source: { type: 'tool', messageID: msg, id: 'call_1' }
    })
    await waitFor(() => fake.requests.some((r) => r.url.endsWith('/permission/per_1/reply')))
    expect(asks).toEqual([{ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'call_1' }])
    expect(fake.requests.find((r) => r.url.endsWith('/permission/per_1/reply'))?.body).toEqual({ decision: 'once' })

    fake.emit('session.tool.success', { sessionID: sid, assistantMessageID: msg, id: 'call_1', content: [{ type: 'text', text: 'a\nb\n' }], metadata: { exit: 0 } })
    fake.emit('session.step.ended', { sessionID: sid, assistantMessageID: msg, finish: 'tool-calls', tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 3, write: 1 } } })
    fake.emit('session.text.delta', { sessionID: sid, assistantMessageID: 'msg_2', delta: '2' })
    fake.emit('session.text.ended', { sessionID: sid, assistantMessageID: 'msg_2', text: '2' })
    fake.emit('session.step.ended', { sessionID: sid, assistantMessageID: 'msg_2', finish: 'stop', tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
    fake.emit('session.execution.succeeded', { sessionID: sid })
    await waitFor(() => events.some((e) => e.kind === 'result'))

    expect(events.map((e) => e.kind)).toEqual([
      'session_started',
      'tool_use',
      'tool_result',
      'turn_usage',
      'assistant_delta',
      'assistant_text',
      'turn_usage',
      'result'
    ])
    const result = events.at(-1)
    expect(result?.kind === 'result' && result.payload.ok).toBe(true)
    expect(result?.kind === 'result' && result.payload.text).toBe('2')
    expect(result?.kind === 'result' && result.payload.usage).toEqual({ inputTokens: 15, outputTokens: 3, cacheCreationTokens: 1, cacheReadTokens: 3 })

    await session.stop()
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit.mock.calls[0]?.[0]).toMatchObject({ requested: true, sawResult: true })
    expect(session.alive).toBe(false)
  })

  it("a denial is returned as reject plus the order's sentence; allowed when there is no onPermission", async () => {
    const session = await adapter.spawn(spawnOptions(), {
      onEvent: () => undefined,
      onExit: () => undefined,
      onPermission: async () => ({ allowed: false, message: 'not now' })
    })
    await waitFor(() => fake.requests.some((r) => r.url === '/api/event'))
    fake.emit('permission.asked', { id: 'per_9', sessionID: 'ses_2', action: 'edit', resources: ['/work/project/a.ts'], source: { type: 'tool', id: 'call_x' } })
    await waitFor(() => fake.requests.some((r) => r.url.endsWith('/permission/per_9/reply')))
    expect(fake.requests.find((r) => r.url.endsWith('/permission/per_9/reply'))?.body).toEqual({ decision: 'reject', message: 'not now' })
    // Even if the same request arrives twice, it is answered only once.
    fake.emit('permission.asked', { id: 'per_9', sessionID: 'ses_2', action: 'edit', resources: ['/work/project/a.ts'] })
    await new Promise((r) => setTimeout(r, 30))
    expect(fake.requests.filter((r) => r.url.endsWith('/permission/per_9/reply'))).toHaveLength(1)
    await session.stop()

    const silent = await adapter.spawn(spawnOptions({ sessionId: 'aios-s2' }), { onEvent: () => undefined, onExit: () => undefined })
    await waitFor(() => fake.requests.filter((r) => r.url === '/api/event').length >= 2)
    fake.emit('permission.asked', { id: 'per_10', sessionID: 'ses_3', action: 'shell', resources: ['pwd'] })
    await waitFor(() => fake.requests.some((r) => r.url.endsWith('/permission/per_10/reply')))
    expect(fake.requests.find((r) => r.url.endsWith('/permission/per_10/reply'))?.body).toEqual({ decision: 'once' })
    await silent.stop()
  })

  it('TODO 1024: a request for an MCP tool goes to the approval inbox with the name mcp__<server>__<tool> and metadata.input, and outbound actions are also judged', async () => {
    const asks: PermissionAsk[] = []
    const session = await adapter.spawn(spawnOptions(), {
      onEvent: () => undefined,
      onExit: () => undefined,
      onPermission: async (ask) => {
        asks.push(ask)
        return { allowed: true, message: '' }
      }
    })
    await waitFor(() => fake.requests.some((r) => r.url === '/api/event'))
    const sid = 'ses_2'
    // The real shape from spike 34's (b) (2026-10-31): source.id is the carrier's execute, and the arguments are in metadata.input.
    fake.emit('session.tool.input.started', { sessionID: sid, id: 'call_7', name: 'execute' })
    fake.emit('session.tool.called', { sessionID: sid, id: 'call_7', input: { code: 'return await tools.slack_work.send_message({ channel: "C1", text: "hi" })' } })
    fake.emit('permission.asked', {
      id: 'per_m1',
      sessionID: sid,
      action: 'slack_work_send_message',
      resources: ['*'],
      save: ['*'],
      metadata: { input: { channel: 'C1', text: 'hi' } },
      source: { type: 'tool', messageID: 'msg_1', id: 'call_7' }
    })
    await waitFor(() => fake.requests.some((r) => r.url.endsWith('/permission/per_m1/reply')))
    // A `.` in a server name becomes `_` in the action, but it is split using the original name in the list.
    expect(asks[0]).toEqual({ toolName: 'mcp__slack.work__send_message', input: { channel: 'C1', text: 'hi' }, toolUseId: 'call_7' })
    expect(adapter.outboundAction(asks[0]?.toolName ?? '', asks[0]?.input)?.match).toBe('send')
    // Even if the server name contains a verb to read (search), only the tool's name is looked at.
    fake.emit('permission.asked', {
      id: 'per_m2',
      sessionID: sid,
      action: 'google_search_send_email',
      resources: ['*'],
      metadata: { input: {} },
      source: { type: 'tool', id: 'call_7' }
    })
    await waitFor(() => asks.length >= 2)
    expect(asks[1]?.toolName).toBe('mcp__google_search__send_email')
    expect(adapter.outboundAction(asks[1]?.toolName ?? '', {})?.match).toBe('send')
    // aios's own gateway tools have the gateway's name shape (the relay stage asks about them); this does not judge outward operations.
    fake.emit('permission.asked', { id: 'per_m3', sessionID: sid, action: 'aios_search', resources: ['*'], metadata: { input: { query: 'x' } } })
    await waitFor(() => asks.length >= 3)
    expect(asks[2]?.toolName).toBe('mcp__aios__search')
    expect(adapter.outboundAction('mcp__aios__search', { query: 'x' })).toBeNull()
    // The server list is fetched only once.
    expect(fake.requests.filter((r) => r.url === '/api/mcp')).toHaveLength(1)
    await session.stop()
  })

  it('review: does not round-trip GET /api/mcp on every approval even when the server list fails or the name cannot be split', async () => {
    const asks: PermissionAsk[] = []
    const session = await adapter.spawn(spawnOptions(), {
      onEvent: () => undefined,
      onExit: () => undefined,
      onPermission: async (ask) => {
        asks.push(ask)
        return { allowed: true, message: '' }
      }
    })
    await waitFor(() => fake.requests.some((r) => r.url === '/api/event'))
    const sid = 'ses_2'
    const mcpGets = (): number => fake.requests.filter((r) => r.url === '/api/mcp').length
    const ask = async (id: string, action: string): Promise<void> => {
      const before = asks.length
      fake.emit('permission.asked', { id, sessionID: sid, action, resources: ['*'], metadata: { input: {} } })
      await waitFor(() => asks.length > before)
    }
    // Failure: fetched once and remembered; following requests (even concurrent ones) do not fetch again. The name is split at the first delimiter.
    fake.mcpStatus = 500
    await ask('per_f1', 'slack_work_send_message')
    expect(asks[0]?.toolName).toBe('mcp__slack__work_send_message')
    await Promise.all([ask('per_f2', 'aios_search'), ask('per_f3', 'aios_ping')])
    expect(mcpGets()).toBe(1)
    // If there is a gap, fetch again (only once). The name becomes the one split by the list.
    fake.mcpStatus = 200
    const realNow = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(realNow + 6_000)
    try {
      await ask('per_f4', 'slack_work_send_message')
      expect(asks.at(-1)?.toolName).toBe('mcp__slack.work__send_message')
      expect(mcpGets()).toBe(2)
      // A server not in the list: it was just fetched, so it is not fetched again.
      await ask('per_f5', 'other_server_tool')
      expect(asks.at(-1)?.toolName).toBe('mcp__other__server_tool')
      expect(mcpGets()).toBe(2)
      // After a gap, an unsplittable name is fetched again only once (at most one round trip per approval).
      now.mockReturnValue(realNow + 12_000)
      await ask('per_f6', 'other_server_tool')
      expect(mcpGets()).toBe(3)
    } finally {
      now.mockRestore()
    }
    await session.stop()
  })

  it('interrupt gives an interrupted result, switchSettings POSTs the model, and resume uses the existing session', async () => {
    const events: AiosEvent[] = []
    const session = await adapter.spawn(spawnOptions({ resumeBackendSessionId: 'ses_old' }), {
      onEvent: (e) => events.push(e),
      onExit: () => undefined
    })
    expect(events[0]?.kind === 'session_started' && events[0].payload.backendSessionId).toBe('ses_old')
    expect(events[0]?.kind === 'session_started' && events[0].payload.resumed).toBe(true)
    expect(fake.requests.some((r) => r.method === 'POST' && r.url === '/api/session')).toBe(false)
    await waitFor(() => fake.requests.some((r) => r.url === '/api/event'))

    // interrupt when not running does nothing.
    await session.interrupt()
    expect(fake.requests.some((r) => r.url.endsWith('/interrupt'))).toBe(false)

    session.send({ text: 'count' })
    await waitFor(() => fake.requests.some((r) => r.url.endsWith('/prompt')))
    fake.emit('session.execution.started', { sessionID: 'ses_old' })
    fake.emit('session.text.delta', { sessionID: 'ses_old', assistantMessageID: 'm', delta: '1\n' })
    await waitFor(() => events.some((e) => e.kind === 'assistant_delta'))
    await session.interrupt()
    expect(fake.requests.some((r) => r.url.endsWith('/interrupt'))).toBe(true)
    fake.emit('session.step.failed', { sessionID: 'ses_old', assistantMessageID: 'm', error: { type: 'aborted', message: 'Step interrupted' } })
    fake.emit('session.execution.interrupted', { sessionID: 'ses_old', reason: 'user' })
    await waitFor(() => events.some((e) => e.kind === 'result'))
    const result = events.find((e) => e.kind === 'result')
    expect(result?.kind === 'result' && result.payload.interrupted).toBe(true)
    expect(result?.kind === 'result' && result.payload.subtype).toBe('interrupted')
    expect(events.some((e) => e.kind === 'error')).toBe(false)

    // Because the model was passed when resuming, it was POSTed once on open. The switch comes after it.
    expect(fake.requests.filter((r) => r.url.endsWith('/model')).at(-1)?.body).toEqual({ model: { providerID: 'opencode', id: 'big-pickle' } })
    expect(await session.switchSettings?.({ modelId: 'ollama/gpt-oss:20b', thinking: null })).toBe(true)
    const switched = fake.requests.filter((r) => r.url.endsWith('/model')).at(-1)
    expect(switched?.body).toEqual({ model: { providerID: 'ollama', id: 'gpt-oss:20b' } })
    expect(await session.switchSettings?.({ modelId: 'broken', thinking: null })).toBe(false)
    await session.stop()
  })

  it.each([500, 'drop'] as const)(
    'TODO 1115: when the prompt is not accepted (%s), emits a result with ok: false after the error and returns to the not-running state',
    async (reply) => {
      fake.promptReply = reply
      const events: AiosEvent[] = []
      const onExit = vi.fn()
      const session = await adapter.spawn(spawnOptions({ resumeBackendSessionId: 'ses_old' }), {
        onEvent: (e) => events.push(e),
        onExit
      })
      await waitFor(() => fake.requests.some((r) => r.url === '/api/event'))
      session.send({ text: 'hello' })
      await waitFor(() => events.some((e) => e.kind === 'result'))
      const kinds = events.map((e) => e.kind)
      expect(kinds.indexOf('error')).toBeGreaterThan(-1)
      expect(kinds.indexOf('error')).toBeLessThan(kinds.indexOf('result'))
      const result = events.find((e) => e.kind === 'result')
      expect(result?.kind === 'result' && result.payload.ok).toBe(false)
      expect(result?.kind === 'result' && result.payload.subtype).toBe('error')
      // It counts as not running, so stopping sends nothing to the serve.
      await session.interrupt()
      expect(fake.requests.some((r) => r.url.endsWith('/interrupt'))).toBe(false)
      // The next send, if accepted, runs normally.
      fake.promptReply = 200
      session.send({ text: 'again' })
      await waitFor(() => fake.requests.filter((r) => r.url.endsWith('/prompt')).length >= 2)
      fake.emit('session.execution.started', { sessionID: 'ses_old' })
      fake.emit('session.execution.succeeded', { sessionID: 'ses_old' })
      await waitFor(() => events.filter((e) => e.kind === 'result').length >= 2)
      expect(events.filter((e) => e.kind === 'result').at(-1)?.payload).toMatchObject({ ok: true })
      await session.stop()
      // Since a result was seen, the error "ended with no result" is not added.
      expect(events.filter((e) => e.kind === 'error')).toHaveLength(1)
    }
  )

  it.each([500, 'drop'] as const)(
    'TODO 1115 review: even if the receiver throws on the synthesized result (%s), does not emit the error and the result twice',
    async (reply) => {
      fake.promptReply = reply
      const events: AiosEvent[] = []
      let thrown = false
      const session = await adapter.spawn(spawnOptions({ resumeBackendSessionId: 'ses_old' }), {
        onEvent: (e) => {
          events.push(e)
          if (e.kind === 'result' && !thrown) {
            thrown = true
            throw new Error('recorder failed')
          }
        },
        onExit: vi.fn()
      })
      await waitFor(() => fake.requests.some((r) => r.url === '/api/event'))
      session.send({ text: 'hello' })
      await waitFor(() => events.some((e) => e.kind === 'result'))
      // If it flows twice, a second error and result arrive during this wait.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(events.filter((e) => e.kind === 'error')).toHaveLength(1)
      expect(events.filter((e) => e.kind === 'result')).toHaveLength(1)
      await session.stop()
    }
  )

  it('creates a new session when the resume target is missing; shutdown stops running sessions', async () => {
    const onExit = vi.fn()
    const events: AiosEvent[] = []
    await adapter.spawn(spawnOptions({ resumeBackendSessionId: 'ses_missing' }), { onEvent: (e) => events.push(e), onExit })
    expect(events[0]?.kind === 'session_started' && events[0].payload.backendSessionId).toBe('ses_2')
    expect(events[0]?.kind === 'session_started' && events[0].payload.resumed).toBe(false)
    await adapter.shutdown()
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit.mock.calls[0]?.[0]).toMatchObject({ requested: true })
    await expect(adapter.spawn(spawnOptions(), { onEvent: () => undefined, onExit: () => undefined })).rejects.toThrow()
  })

  it("when Ollama responds, adds the /api/tags models to the list and passes the provider to the session's serve (TODO 1016)", async () => {
    await adapter.shutdown()
    fake.models = fake.models.filter((m) => (m as { providerID: string }).providerID !== 'ollama')
    const seen: string[] = []
    adapter = new OpenCodeAdapter(
      {
        link: { ...link, baseUrl: fake.baseUrl },
        env: { OLLAMA_HOST: '0.0.0.0' },
        fetch: fakeTags(
          [
            { name: 'qwen3:0.6b', capabilities: ['completion', 'tools'] },
            { name: 'gpt-oss:20b', capabilities: ['completion', 'tools', 'thinking'] },
            { name: 'nomic-embed-text', capabilities: ['embedding'] }
          ],
          seen
        )
      },
      table
    )
    const models = await adapter.listModels()
    // The same URL is fetched for state detection (TODO 1019) and for the list.
    expect([...new Set(seen)]).toEqual(['http://localhost:11434/api/tags'])
    expect(models.map((m) => m.id)).toEqual([
      'opencode/big-pickle',
      'opencode/glm-5.3-flash-free',
      'moonshot/kimi-k2.6',
      'ollama/gpt-oss:20b',
      'ollama/qwen3:0.6b'
    ])
    expect(adapter.modelLabel('ollama/gpt-oss:20b')).toBe('ollama/gpt-oss:20b')
    const config = (await adapter.sessionConfigOf(spawnOptions())) as Record<string, Record<string, Record<string, unknown>>>
    expect(config['provider']?.['ollama']).toEqual({
      npm: table.ollama.npm,
      name: table.ollama.name,
      options: { baseURL: 'http://localhost:11434/v1' },
      models: { 'gpt-oss:20b': { name: 'gpt-oss:20b' }, 'qwen3:0.6b': { name: 'qwen3:0.6b' } }
    })
    expect(config['mcp']?.[table.mcp.serverName]).toBeDefined()
  })

  it('does not add when the user has already configured a provider; changes neither the list nor the config when there is no Ollama (TODO 1016)', async () => {
    // The ledger's list has an ollama row = it is in the user's opencode.json. env overrides baseURL, so it is not touched.
    await adapter.shutdown()
    adapter = new OpenCodeAdapter({ link: { ...link, baseUrl: fake.baseUrl }, fetch: fakeTags([{ name: 'other:7b' }]) }, table)
    const models = await adapter.listModels()
    expect(models.some((m) => m.id === 'ollama/other:7b')).toBe(false)
    expect((await adapter.sessionConfigOf(spawnOptions()))['provider']).toBeUndefined()

    await adapter.shutdown()
    fake.models = fake.models.filter((m) => (m as { providerID: string }).providerID !== 'ollama')
    adapter = new OpenCodeAdapter({ link: { ...link, baseUrl: fake.baseUrl }, fetch: noOllama }, table)
    expect((await adapter.listModels()).map((m) => m.id)).toEqual(['opencode/big-pickle', 'opencode/glm-5.3-flash-free', 'moonshot/kimi-k2.6'])
    expect((await adapter.sessionConfigOf(spawnOptions()))['provider']).toBeUndefined()
  })

  it('even if an ollama row appears in the list later, adds the provider when the user has no config and does not list the same model twice (TODO 1078)', async () => {
    // OpenCode 2.1.4 finds Ollama itself and shows a row in the ledger's list about 1 second after startup. That row cannot be resolved in a session.
    await adapter.shutdown()
    fake.models = fake.models.filter((m) => (m as { providerID: string }).providerID !== 'ollama')
    fake.config = [{ type: 'directory', path: '/home/u/.config/opencode' }, { type: 'document', info: {} }]
    const tags = fakeTags([
      { name: 'gpt-oss:20b', capabilities: ['completion', 'tools'] },
      { name: 'qwen3:0.6b', capabilities: ['completion'] },
      { name: 'nomic-embed-text', capabilities: ['embedding'] }
    ])
    adapter = new OpenCodeAdapter({ link: { ...link, baseUrl: fake.baseUrl }, fetch: tags }, table)
    const ollamaIds = (list: readonly { id: string }[]): string[] => list.map((m) => m.id).filter((id) => id.startsWith('ollama/'))
    expect(ollamaIds(await adapter.listModels())).toEqual(['ollama/gpt-oss:20b', 'ollama/qwen3:0.6b'])

    // The auto-detected row appears (including the one for embedding). It is fetched again after the cache (60 seconds) expires.
    const auto = (id: string): unknown => ({
      providerID: 'ollama',
      id,
      name: id,
      settings: { baseURL: 'http://127.0.0.1:11434/v1', provider: 'ollama' },
      cost: [],
      status: 'active'
    })
    fake.models.push(auto('gpt-oss:20b'), auto('qwen3:0.6b'), auto('nomic-embed-text'))
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    try {
      const models = await adapter.listModels()
      // Auto-detected rows are replaced by aios's rows (no duplicates; the embedding-only ones that cannot be used in conversation do not appear).
      expect(ollamaIds(models)).toEqual(['ollama/gpt-oss:20b', 'ollama/qwen3:0.6b'])
      const config = (await adapter.sessionConfigOf(spawnOptions())) as Record<string, Record<string, Record<string, unknown>>>
      expect(config['provider']?.['ollama']?.['models']).toEqual({
        'gpt-oss:20b': { name: 'gpt-oss:20b' },
        'qwen3:0.6b': { name: 'qwen3:0.6b' }
      })
    } finally {
      clock.mockRestore()
    }
  })

  it("does not add when the user's config (document of /api/config) has a provider and shows the list row as is (TODO 1078)", async () => {
    await adapter.shutdown()
    fake.config = [
      {
        type: 'document',
        path: '/home/u/.config/opencode/opencode.json',
        info: { providers: { ollama: { settings: { baseURL: 'http://gpu-box:11434/v1' }, models: { 'gpt-oss:20b': {} } } } }
      }
    ]
    adapter = new OpenCodeAdapter({ link: { ...link, baseUrl: fake.baseUrl }, fetch: fakeTags([{ name: 'other:7b' }]) }, table)
    const models = await adapter.listModels()
    expect(models.some((m) => m.id === 'ollama/gpt-oss:20b')).toBe(true)
    expect(models.some((m) => m.id === 'ollama/other:7b')).toBe(false)
    expect((await adapter.sessionConfigOf(spawnOptions()))['provider']).toBeUndefined()
  })

  it("when opencode.json in the conversation folder has a provider, looks it up with a directory in the session's serve and does not add (TODO 1078 review)", async () => {
    // The ledger's serve (no directory) only sees the global settings, so in the list judgment it counts as "not set".
    await adapter.shutdown()
    fake.models = fake.models.filter((m) => (m as { providerID: string }).providerID !== 'ollama')
    const envDoc = {
      type: 'document',
      info: { providers: { ollama: { settings: { baseURL: 'http://127.0.0.1:11434/v1' } } } }
    }
    const folderDoc = {
      type: 'document',
      path: '/work/project/opencode.json',
      info: { providers: { ollama: { settings: { baseURL: 'http://gpu-box:11434/v1' } } } }
    }
    fake.config = (dir: string | undefined) =>
      dir === '/work/project' ? [{ type: 'directory', path: '/home/u/.config/opencode' }, folderDoc, envDoc] : [envDoc]
    adapter = new OpenCodeAdapter(
      { link: { ...link, baseUrl: fake.baseUrl }, fetch: fakeTags([{ name: 'qwen3:0.6b', capabilities: ['completion'] }]) },
      table
    )
    expect((await adapter.listModels()).some((m) => m.id === 'ollama/qwen3:0.6b')).toBe(true)
    // The ledger's serve is not given a directory (giving one would leave a watch on that place in the ledger).
    const catalogAsk = fake.requests.filter((r) => r.url === '/api/config')
    expect(catalogAsk.length).toBeGreaterThan(0)
    expect(catalogAsk.every((r) => r.headers[table.serve.directoryHeader] === undefined)).toBe(true)
    // The form that passes no session serve is unchanged (the adding side).
    expect((await adapter.sessionConfigOf(spawnOptions()))['provider']).toBeDefined()
    const server = new OpenCodeServer(table, { cwd: '/work/project', config: {} }, { ...link, baseUrl: fake.baseUrl })
    expect((await adapter.sessionConfigOf(spawnOptions(), server))['provider']).toBeUndefined()
    // The part from env (a document with no place) is not counted: in another folder it is added.
    expect((await adapter.sessionConfigOf(spawnOptions({ cwd: '/work/other' }), server))['provider']).toBeDefined()

    // spawn fetches again with the directory, then creates the session.
    fake.requests.length = 0
    const events: AiosEvent[] = []
    await adapter.spawn(spawnOptions(), { onEvent: (e) => events.push(e), onExit: () => undefined })
    const sessionAsk = fake.requests.filter((r) => r.url === '/api/config')
    expect(sessionAsk.map((r) => r.headers[table.serve.directoryHeader])).toEqual(['/work/project'])
    expect(events[0]?.kind).toBe('session_started')
  })

  it("falls toward adding the provider when the conversation folder's config cannot be fetched or is empty (TODO 1078 review)", async () => {
    await adapter.shutdown()
    fake.models = fake.models.filter((m) => (m as { providerID: string }).providerID !== 'ollama')
    fake.config = (dir: string | undefined) => (dir === undefined ? [] : undefined)
    adapter = new OpenCodeAdapter(
      { link: { ...link, baseUrl: fake.baseUrl }, fetch: fakeTags([{ name: 'qwen3:0.6b', capabilities: ['completion'] }]) },
      table
    )
    const server = new OpenCodeServer(table, { cwd: '/work/project', config: {} }, { ...link, baseUrl: fake.baseUrl })
    // 404
    expect((await adapter.sessionConfigOf(spawnOptions(), server))['provider']).toBeDefined()
    // An empty response (right after startup)
    fake.config = (dir: string | undefined) => (dir === undefined ? [] : null)
    expect((await adapter.sessionConfigOf(spawnOptions(), server))['provider']).toBeDefined()
  })

  it('userConfiguresOllama: looks at info.providers / provider of the document; an unreadable shape gives null (TODO 1078)', () => {
    const doc = (info: unknown): unknown => ({ type: 'document', path: '/x/opencode.json', info })
    expect(userConfiguresOllama(table, [doc({ providers: { ollama: {} } })])).toBe(true)
    expect(userConfiguresOllama(table, { data: [doc({ provider: { ollama: {} } })] })).toBe(true)
    expect(userConfiguresOllama(table, [doc({ providers: { lmstudio: {} } }), { type: 'directory', path: '/x' }])).toBe(false)
    // Elements of kind directory have no contents (even if they have the provider key, it is not looked at).
    expect(userConfiguresOllama(table, [{ type: 'directory', info: { providers: { ollama: {} } } }])).toBe(false)
    // A document with no place is the part from env (OPENCODE_CONFIG_CONTENT that aios passed). It is not the user's setting.
    expect(userConfiguresOllama(table, [{ type: 'document', info: { providers: { ollama: {} } } }])).toBe(false)
    expect(userConfiguresOllama(table, [])).toBe(false)
    expect(userConfiguresOllama(table, null)).toBeNull()
    expect(userConfiguresOllama(table, 'oops')).toBeNull()
  })

  it('ollamaBaseOf reads OLLAMA_HOST with the same default as the CLI; detectOllama gives null for a broken response', async () => {
    expect(ollamaBaseOf(table, {})).toBe('http://localhost:11434')
    expect(ollamaBaseOf(table, { OLLAMA_HOST: '127.0.0.1:8080' })).toBe('http://127.0.0.1:8080')
    expect(ollamaBaseOf(table, { OLLAMA_HOST: 'http://gpu-box' })).toBe('http://gpu-box:11434')
    expect(ollamaBaseOf(table, { OLLAMA_HOST: 'https://ollama.example.com/' })).toBe('https://ollama.example.com')
    expect(await detectOllama(table, {}, noOllama)).toBeNull()
    expect(await detectOllama(table, {}, async () => new Response('nope', { status: 500 }))).toBeNull()
    expect(await detectOllama(table, {}, async () => new Response('{"x":1}', { status: 200 }))).toBeNull()
  })

  it('modelChoicesOf: broken rows and rows without a status', () => {
    const list = modelChoicesOf(table, [{ providerID: 'p', id: 'm' }, { id: 'no-provider' }, 'junk'])
    expect(list).toEqual([{ id: 'p/m', label: 'p/m', shortLabel: 'm' }])
  })
})

/**
 * TODO 1020: display of the approval box, the refusal text, and outward operations. The input shapes of the tools (edit = {path, oldString, newString, replaceAll?},
 * write = {path, content}, apply_patch = {patchText}) and the resources of external_directory (`<dir>/*`) were **inferred** from OpenCode 2.1.4's binary schema and its calls to Permission.assert (spike 34's (f) has not been run).
 */
describe('OpenCodeAdapter approval entry (TODO 1020)', () => {
  const adapter = new OpenCodeAdapter({ link: { ...link, baseUrl: 'http://127.0.0.1:9' } }, table)

  it('writePreview: edit is the replacement, write is the whole file, and patch and read-only tools give null', () => {
    expect(adapter.writePreview('Edit', { path: 'src/a.ts', oldString: 'a', newString: 'b' })).toEqual({
      path: 'src/a.ts',
      change: { kind: 'replace', edits: [{ oldText: 'a', newText: 'b', replaceAll: false }] }
    })
    expect(adapter.writePreview('Edit', { path: '/w/a.ts', oldString: 'x', newString: '', replaceAll: true })).toEqual({
      path: '/w/a.ts',
      change: { kind: 'replace', edits: [{ oldText: 'x', newText: '', replaceAll: true }] }
    })
    // OpenCode asks about the write tool too with the action `edit`, so the shape is decided by the argument keys.
    expect(adapter.writePreview('Edit', { path: 'new.txt', content: 'x' })).toEqual({
      path: 'new.txt',
      change: { kind: 'overwrite', content: 'x' }
    })
    expect(adapter.writePreview('Write', { filePath: 'old-v1.txt', content: '' })).toEqual({
      path: 'old-v1.txt',
      change: { kind: 'overwrite', content: '' }
    })
    expect(adapter.writePreview('Edit', { patchText: '*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch' })).toBeNull()
    expect(adapter.writePreview('Read', { path: 'a.ts' })).toBeNull()
    expect(adapter.writePreview('Edit', { oldString: 'a', newString: 'b' })).toBeNull()
    expect(adapter.writePreview('Edit', 'junk')).toBeNull()
  })

  it('writeToolTargetPath: the write target (the first file for patch); read-only tools and shell give null', () => {
    expect(adapter.writeToolTargetPath('Edit', { path: 'src/a.ts', oldString: 'a', newString: 'b' })).toBe('src/a.ts')
    expect(adapter.writeToolTargetPath('Write', { path: '/w/new.txt', content: 'x' })).toBe('/w/new.txt')
    expect(
      adapter.writeToolTargetPath('Edit', { patchText: '*** Begin Patch\n*** Add File: docs/n.md\n+x\n*** Update File: a.ts\n*** End Patch' })
    ).toBe('docs/n.md')
    expect(adapter.writeToolTargetPath('Read', { path: 'a.ts' })).toBeNull()
    expect(adapter.writeToolTargetPath('Bash', { command: 'echo > a.ts' })).toBeNull()
  })

  it("approvalReply: a denial has no message (OpenCode stops the turn), an order carries only the user's sentence, and a withdrawal carries the reason", () => {
    expect(adapter.approvalReply({ kind: 'stop' })).toBe('')
    expect(adapter.approvalReply({ kind: 'feedback', text: 'use {feedback} literally' })).toBe('use {feedback} literally')
    for (const reason of ['session-exited', 'thread-removed', 'quit', 'interrupt', 'stop'] as const) {
      expect(adapter.approvalReply({ kind: 'cancelled', reason }), reason).toBe('')
    }
    expect(adapter.approvalReply({ kind: 'cancelled', reason: 'expired' })).toMatch(/NOT run/)
    expect(adapter.approvalReply({ kind: 'cancelled', reason: 'tool-timeout' })).toMatch(/NOT run/)
    // The table has a reason for every cancellation (if one is forgotten, undefined is returned).
    for (const reason of APPROVAL_CANCEL_REASONS) expect(typeof table.approvalReplies.cancelled[reason], reason).toBe('string')
  })

  it('outboundAction: push and posting via shell (Bash) are outbound actions and read-only commands are not', () => {
    expect(adapter.outboundAction('Bash', { command: 'sendmail a@example.com' })).toMatchObject({ channel: 'shell', match: 'mail' })
    expect(adapter.outboundAction('Bash', { command: 'curl -X POST -d x=1 https://hooks.slack.com/services/T/B/x' })).toMatchObject({ match: 'chat-webhook' })
    expect(adapter.outboundAction('Bash', { command: 'git push --force origin main' })).toBeNull()
    expect(adapter.outboundAction('Bash', { command: 'git log -1' })).toBeNull()
    expect(adapter.outboundAction('Bash', {})).toBeNull()
  })

  it('table: the target of the actions mapping and the name of ExternalDirectory equal the shared constants', () => {
    expect(table.permission.actions[table.permission.externalDirectory.action]).toBe(EXTERNAL_DIRECTORY_TOOL)
    expect(table.outbound.shellTools).toContain(table.permission.actions['shell'])
    for (const tool of table.writes.tools) expect(Object.values(table.permission.actions), tool).toContain(tool)
  })
})

describe('OpenCodeSession approval (TODO 1020)', () => {
  let fake: FakeServe
  let adapter: OpenCodeAdapter

  beforeEach(async () => {
    fake = new FakeServe()
    await fake.listen()
    adapter = new OpenCodeAdapter({ link: { ...link, baseUrl: fake.baseUrl }, fetch: noOllama }, table)
  })

  afterEach(async () => {
    await adapter.shutdown()
    fake.close()
  })

  it("external_directory asks with ExternalDirectory and {path, resources}, edit asks with the tool's arguments; the tool_use name also matches", async () => {
    const events: AiosEvent[] = []
    const asks: PermissionAsk[] = []
    const session = await adapter.spawn(spawnOptions(), {
      onEvent: (e) => events.push(e),
      onExit: () => undefined,
      onPermission: async (ask) => {
        asks.push(ask)
        return { allowed: true, message: '' }
      }
    })
    await waitFor(() => fake.requests.some((r) => r.url === '/api/event'))
    const sid = 'ses_2'
    fake.emit('session.tool.input.started', { sessionID: sid, assistantMessageID: 'm', id: 'call_e', name: 'edit' })
    fake.emit('session.tool.called', { sessionID: sid, assistantMessageID: 'm', id: 'call_e', input: { path: '/outside/a.ts', oldString: 'a', newString: 'b' } })
    fake.emit('permission.asked', {
      id: 'per_x',
      sessionID: sid,
      action: 'external_directory',
      resources: ['/outside/*'],
      save: ['/outside/*'],
      source: { type: 'tool', messageID: 'm', id: 'call_e' }
    })
    await waitFor(() => fake.requests.some((r) => r.url.endsWith('/permission/per_x/reply')))
    fake.emit('permission.asked', {
      id: 'per_e',
      sessionID: sid,
      action: 'edit',
      resources: ['/outside/a.ts'],
      save: ['*'],
      source: { type: 'tool', messageID: 'm', id: 'call_e' }
    })
    await waitFor(() => fake.requests.some((r) => r.url.endsWith('/permission/per_e/reply')))
    expect(asks).toEqual([
      { toolName: EXTERNAL_DIRECTORY_TOOL, input: { path: '/outside', resources: ['/outside/*'] }, toolUseId: 'call_e' },
      { toolName: 'Edit', input: { path: '/outside/a.ts', oldString: 'a', newString: 'b' }, toolUseId: 'call_e' }
    ])
    expect(externalDirectoryPath(asks[0]?.input)).toBe('/outside')
    const toolUse = events.find((e) => e.kind === 'tool_use')
    expect(toolUse?.kind === 'tool_use' && toolUse.payload.name).toBe('Edit')
    await session.stop()
  })

  it('rejects without a message when the denial sentence is empty (stop)', async () => {
    const session = await adapter.spawn(spawnOptions(), {
      onEvent: () => undefined,
      onExit: () => undefined,
      onPermission: async () => ({ allowed: false, message: adapter.approvalReply({ kind: 'stop' }) ?? 'unexpected' })
    })
    await waitFor(() => fake.requests.some((r) => r.url === '/api/event'))
    fake.emit('permission.asked', { id: 'per_s', sessionID: 'ses_2', action: 'shell', resources: ['rm -rf x'] })
    await waitFor(() => fake.requests.some((r) => r.url.endsWith('/permission/per_s/reply')))
    expect(fake.requests.find((r) => r.url.endsWith('/permission/per_s/reply'))?.body).toEqual({ decision: 'reject' })
    await session.stop()
  })
})
