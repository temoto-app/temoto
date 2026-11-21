/**
 * How the Adapter handles the child process (items 81 / 82, ARCHITECTURE.md 4.6).
 *
 * `node:child_process` is replaced, and **neither the CLI nor the model is started**. The child is a fake made of
 * EventEmitter + streams, and its stdin contents, kill, and close are driven by hand.
 *
 * What is pinned down:
 * - 81: if the probe times out without receiving init, the started child is stopped and no timer is left behind
 * - 81: a successful probe does not turn on a feature that was not passed (subagent-text stays at the assumed false)
 * - 82: the stdin `error` (EPIPE) is caught and emitted as an error event with `origin: 'stream'`
 * - 82: when `write` returns back pressure (false), the next line is not written until `drain`
 * - 91 / 92: the version and the effective level are learned from the initialize control request at startup (the response is not made an event)
 * - 94: an interrupt writes a control request and resolves on the response, and does not stop the process. Only the result after the interruption gets
 *   `interrupted`. The per-turn `system/init` is emitted only the first time. Interrupts go through the same `writeControlRequest` choke point as
 *   initialize (the initialize line at startup is excluded when looking)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiosEvent, ThinkingLevel } from '../src/shared/agent.js'
import type { GatewayEndpoint } from '../src/main/session/types.js'

/** Fake child process. Writes to stdin can be intercepted with `onWrite`. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly written: string[] = []
  /** Holds back the completion of a write (imitates back pressure). */
  hold = false
  private readonly held: (() => void)[] = []
  /** Called when one line reaches stdin (for example, to return init). */
  onLine: ((line: string) => void) | null = null
  readonly stdin: Writable
  readonly kill = vi.fn((signal?: string) => {
    // As in the real thing, the exit arrives asynchronously as `close`.
    setImmediate(() => this.emit('close', null, signal ?? 'SIGTERM'))
    return true
  })

  /** The answer to `mcp_status` (TODO 869). Each query uses one element; once they run out, the last element is returned. */
  mcpStatuses: string[][] = [['connected']]
  private mcpAsked = 0
  private answerMcpStatus(line: string): void {
    const parsed = JSON.parse(line) as { request_id?: string; request?: { subtype?: string } }
    if (parsed.request?.subtype !== 'mcp_status') return
    const statuses = this.mcpStatuses[Math.min(this.mcpAsked, this.mcpStatuses.length - 1)] ?? []
    this.mcpAsked += 1
    const mcpServers = statuses.map((status, i) => ({ name: `s${i}`, status }))
    setImmediate(() =>
      this.stdout.write(
        `${JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: parsed.request_id, response: { mcpServers } }
        })}\n`
      )
    )
  }

  constructor() {
    super()
    this.stdin = new Writable({
      highWaterMark: 16,
      write: (chunk: Buffer, _encoding, callback) => {
        const text = chunk.toString('utf8')
        this.written.push(text)
        for (const line of text.split('\n')) {
          if (line === '') continue
          this.answerMcpStatus(line)
          this.onLine?.(line)
        }
        if (this.hold) this.held.push(() => callback())
        else callback()
      }
    })
  }

  release(): void {
    this.hold = false
    for (const done of this.held.splice(0)) done()
  }
}

const state = vi.hoisted(() => ({
  children: [] as unknown[],
  version: '9.9.9'
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new FakeChild()
    state.children.push(child)
    return child
  }),
  execFile: vi.fn(
    (
      _command: string,
      args: readonly string[],
      _options: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      // Is it `--version` or the login state? Both have the real shape (spike 12).
      const stdout = args.includes('--version')
        ? `${state.version} (test)\n`
        : JSON.stringify({ loggedIn: true, authMethod: 'test', subscriptionType: null })
      queueMicrotask(() => callback(null, stdout, ''))
    }
  )
}))

// Load after the mock (vi.mock is hoisted, but make it explicit).
const { ClaudeCodeAdapter, gatewayTimeout } = await import('../src/main/session/adapter/index.js')
const { gatewayInstructions, loadCompatTable } = await import('../src/main/session/adapter/compat.js')
const { spawn: spawnProcess } = await import('node:child_process')

const children = (): FakeChild[] => state.children as FakeChild[]
/** Runs a few real macrotask turns (lets the close from `setImmediate` and the stream notifications through). */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

let dir: string
const gateway = (): GatewayEndpoint => ({
  socketPath: join(dir, 'gw.sock'),
  token: 'token',
  scriptPath: '/dev/null',
  runtimePath: '/bin/false',
  configDir: join(dir, 'mcp')
})

beforeEach(() => {
  state.children.length = 0
  dir = mkdtempSync(join(tmpdir(), 'aios-adapter-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('Adapter — probe (項目 81)', () => {
  it('未知バージョンは needsProbe、キャッシュがあれば不要', async () => {
    const fresh = new ClaudeCodeAdapter()
    expect((await fresh.getStatus()).needsProbe).toBe(true)
    const cached = new ClaudeCodeAdapter({
      read: () => (fresh as unknown as { status: { features: never } }).status.features,
      write: () => undefined
    })
    const status = await cached.getStatus()
    expect(status.source).toBe('probe')
    expect(status.needsProbe).toBe(false)
  })

  it('init が来ずにタイムアウトしたら子を止め、timer を残さず、仮の機能表のまま縮退理由を足す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const write = vi.fn()
    const adapter = new ClaudeCodeAdapter({ read: () => null, write })
    const before = await adapter.getStatus()
    expect(before.needsProbe).toBe(true)

    const pending = adapter.probe(gateway, dir)
    await flush()
    expect(children()).toHaveLength(1)
    // The first line (the probe input) is sent. init is not returned.
    expect(children()[0]?.written.length).toBe(1)

    // First timeout -> stop -> remove model / thinking and try once more.
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(children()[0]?.kill).toHaveBeenCalledWith('SIGTERM')
    expect(children()).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    const result = await pending
    expect(children()[1]?.kill).toHaveBeenCalledWith('SIGTERM')
    expect(result.ok).toBe(false)
    expect(result.status.needsProbe).toBe(false)
    // Not everything is set to false (if structured-io also became false, the process could not start).
    expect(result.status.features).toEqual(before.features)
    expect(result.status.degradations.map((d) => d.reason).join('\n')).toContain('timeout')
    // TODO 519: a reason code is attached too, so it can be drawn in the display language (the diagnostic text is an inserted value).
    expect(result.status.degradations.map((d) => d.code)).toContain(
      'aios-reason:agent-probe-failed {"detail":"timeout"}'
    )
    expect(write).not.toHaveBeenCalled()
    // The 3-second SIGKILL timer of stop is also cleared by close.
    expect(vi.getTimerCount()).toBe(0)
    // Do not try twice during this launch. Only "re-detect" makes it forget.
    expect((await adapter.getStatus()).needsProbe).toBe(false)
    expect((await adapter.getStatus(true)).needsProbe).toBe(true)
  })

  it('init が来たら子を止め、渡したフラグだけを真にしてキャッシュに書く', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const write = vi.fn()
    const adapter = new ClaudeCodeAdapter({ read: () => null, write })
    await adapter.getStatus()

    const pending = adapter.probe(gateway, dir)
    await flush()
    const child = children()[0]
    if (child === undefined) throw new Error('no child')
    // The init returned when the gateway is connected. A user's server mixed in is fine (item 110).
    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'x',
        mcp_servers: [
          { name: 'aios', status: 'connected', source: 'dynamic' },
          { name: 'mine', status: 'needs-auth', source: 'claudeai' }
        ],
        tools: [],
        model: 'm'
      })}\n`
    )
    await flush()
    const result = await pending
    expect(result.ok).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(result.status.features['structured-io']).toBe(true)
    expect(result.status.features['mcp-config']).toBe(true)
    // Items 109 / 110: the flags for where settings come from and strict are not passed (a launch identical to the stock CLI).
    const spawnMock = vi.mocked(spawnProcess)
    const args = (spawnMock.mock.calls[0]?.[1] ?? []) as readonly string[]
    expect(args).toContain('--mcp-config')
    expect(args).not.toContain('--strict-mcp-config')
    expect(args).not.toContain('--setting-sources')
    // A flag assumed false (a nonexistent flag) is not passed, so it must not become true.
    expect(result.status.features['subagent-text']).toBe(false)
    expect(result.status.degradations).toEqual([])
    expect(write).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Adapter — gateway の追加の指示 (TODO 822)', () => {
  it('gateway を渡す起動に、openUrl を使えという追加の指示を 1 つ付ける', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000002',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: null,
        modelId: null,
        thinking: null,
        gateway: gateway()
      },
      { onEvent: () => undefined, onExit: () => undefined }
    )
    const args = (vi.mocked(spawnProcess).mock.calls.at(-1)?.[1] ?? []) as readonly string[]
    const table = loadCompatTable()
    const flagName = table.flags['appendSystemPrompt']
    expect(flagName).toBe('--append-system-prompt')
    expect(args.filter((arg) => arg === flagName)).toHaveLength(1)
    const text = args[args.indexOf(flagName as string) + 1] ?? ''
    expect(text).toContain(`mcp__${table.mcp.serverName}__openUrl`)
    expect(text).toContain(`mcp__${table.mcp.serverName}__openDiff`)
    expect(text).toContain(`mcp__${table.mcp.serverName}__getViewerScreenshot`)
    // TODO 1060 stage 2: aios's own settings go through getSettings / setSetting / openSettings.
    expect(text).toContain(`mcp__${table.mcp.serverName}__getSettings`)
    expect(text).toContain(`mcp__${table.mcp.serverName}__setSetting`)
    expect(text).toContain(`mcp__${table.mcp.serverName}__openSettings`)
    expect(text).not.toContain('{tool:')
  })

  it('追加の指示の {tool:x} はどれも gateway が実際に登録している道具の名前 (TODO 1060 段 2)', () => {
    const source = readFileSync(new URL('../src/gateway/index.ts', import.meta.url), 'utf8')
    const registered = new Set([...source.matchAll(/server\.registerTool\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]))
    expect(registered.has('openSettings')).toBe(true)
    const named = (loadCompatTable().mcp.instructions ?? []).flatMap((line) =>
      [...line.matchAll(/\{tool:([A-Za-z0-9_]+)\}/g)].map((m) => m[1])
    )
    expect(named.length).toBeGreaterThan(0)
    for (const tool of named) expect(registered, tool).toContain(tool)
  })

  it('gatewayInstructions: 表に無い / 空なら null、{tool:x} は gateway のツールの名前に置き換える', () => {
    const table = loadCompatTable()
    expect(gatewayInstructions({ ...table, mcp: { ...table.mcp, instructions: [] } })).toBeNull()
    expect(gatewayInstructions({ ...table, mcp: { ...table.mcp, instructions: undefined } })).toBeNull()
    expect(gatewayInstructions({ ...table, mcp: { ...table.mcp, instructions: ['a {tool:openUrl}', ' ', 'b'] } })).toBe(
      `a mcp__${table.mcp.serverName}__openUrl\nb`
    )
  })
})

describe('Adapter — prompt cache を壊さない (TODO 963)', () => {
  /** Wakes it once and returns the extra instruction passed (null if none). */
  async function instructionsOf(options: {
    sessionId: string
    resume: string | null
    modelId: string | null
    thinking: 'high' | null
    allowedDirs: readonly string[]
    now: number
  }): Promise<string | null> {
    vi.setSystemTime(options.now)
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(
      {
        sessionId: options.sessionId,
        threadId: 't',
        cwd: dir,
        allowedDirs: options.allowedDirs,
        resumeBackendSessionId: options.resume,
        modelId: options.modelId,
        thinking: options.thinking,
        gateway: gateway()
      },
      { onEvent: () => undefined, onExit: () => undefined }
    )
    const args = (vi.mocked(spawnProcess).mock.calls.at(-1)?.[1] ?? []) as readonly string[]
    const flagName = loadCompatTable().flags['appendSystemPrompt'] as string
    const at = args.indexOf(flagName)
    return at === -1 ? null : (args[at + 1] ?? null)
  }

  it('会話の途中の起こし直し (再開・Model / Thinking・参照範囲・時刻が違う) でも、追加の指示は一字も変わらない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const first = await instructionsOf({
      sessionId: '00000000-0000-4000-8000-000000000011',
      resume: null,
      modelId: null,
      thinking: null,
      allowedDirs: [],
      now: Date.UTC(2026, 9, 25, 9, 0, 0)
    })
    const later = await instructionsOf({
      sessionId: '00000000-0000-4000-8000-000000000012',
      resume: 'backend-session-1',
      modelId: 'opus',
      thinking: 'high',
      allowedDirs: [dir],
      now: Date.UTC(2026, 9, 26, 23, 59, 0)
    })
    expect(first).not.toBeNull()
    expect(later).toBe(first)
    // The contents are only the fixed text of the table (no time, path, or session id is put in).
    expect(first).toBe(gatewayInstructions(loadCompatTable()))
    expect(first).not.toContain(dir)
    expect(first).not.toContain('00000000-0000-4000-8000-0000000000')
    expect(first).not.toMatch(/20\d\d-\d\d-\d\d|\d{1,2}:\d\d/)
  })
})

describe('Adapter — gateway のサーバごとの timeout (TODO 632)', () => {
  it('--mcp-config の gateway の行に compat の toolTimeoutMs を timeout として書く', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000001',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: null,
        modelId: null,
        thinking: null,
        gateway: gateway()
      },
      { onEvent: () => undefined, onExit: () => undefined }
    )
    const args = (vi.mocked(spawnProcess).mock.calls.at(-1)?.[1] ?? []) as readonly string[]
    const configPath = args[args.indexOf('--mcp-config') + 1] ?? ''
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { timeout?: number; type?: string }>
    }
    const table = loadCompatTable()
    const entry = config.mcpServers[table.mcp.serverName]
    expect(entry?.type).toBe('stdio')
    // 7 days. The CLI's idle timeout (default 30 minutes) is extended up to this length (spike 29).
    expect(table.mcp.toolTimeoutMs).toBe(7 * 24 * 60 * 60 * 1000)
    expect(entry?.timeout).toBe(table.mcp.toolTimeoutMs)
  })

  it('表の値が無い / 1000 ms 未満 / 数でなければ付けない (CLI は 1000 未満を無視する)', () => {
    const table = loadCompatTable()
    const withTimeout = (value: unknown): typeof table => ({ ...table, mcp: { ...table.mcp, toolTimeoutMs: value as number } })
    expect(gatewayTimeout(withTimeout(undefined))).toEqual({})
    expect(gatewayTimeout(withTimeout(999))).toEqual({})
    expect(gatewayTimeout(withTimeout('1000'))).toEqual({})
    expect(gatewayTimeout(withTimeout(Number.NaN))).toEqual({})
    expect(gatewayTimeout(withTimeout(1000.5))).toEqual({ timeout: 1000 })
  })
})

describe('Adapter — stdin (項目 82)', () => {
  async function start(): Promise<{ child: FakeChild; events: AiosEvent[]; session: Awaited<ReturnType<InstanceType<typeof ClaudeCodeAdapter>['spawn']>> }> {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    const events: AiosEvent[] = []
    const session = await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000000',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: null,
        modelId: null,
        thinking: null,
        gateway: gateway()
      },
      { onEvent: (event) => events.push(event), onExit: () => undefined }
    )
    const child = children()[0]
    if (child === undefined) throw new Error('no child')
    return { child, events, session }
  }

  it('stdin の EPIPE は uncaught にならず、stream の error イベントになる', async () => {
    const { child, events } = await start()
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    child.stdin.destroy(err)
    await flush()
    const errors = events.filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(1)
    const payload = errors[0]?.kind === 'error' ? errors[0].payload : null
    expect(payload?.origin).toBe('stream')
    expect(payload?.code).toBe('EPIPE')
  })

  it('壊れた stdin への send と stop は throw しない', async () => {
    const { child, session } = await start()
    child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    await flush()
    expect(() => session.send({ text: 'x' })).not.toThrow()
    await flush()
    await expect(session.stop()).resolves.toBeUndefined()
  })

  it('背圧 (write が false) なら drain まで次の行を書かない', async () => {
    const { child, session } = await start()
    ;(session as unknown as { skipConnectorWait(): void }).skipConnectorWait() // Only look at back pressure (the connector wait of TODO 869 is in a separate describe).
    const writeSpy = vi.spyOn(child.stdin, 'write')
    child.hold = true
    // The line is longer than highWaterMark (16 B), so write returns false on the first line.
    session.send({ text: 'first line that is long' })
    session.send({ text: 'second' })
    await flush()
    expect(writeSpy).toHaveBeenCalledTimes(1)
    child.release()
    await flush()
    expect(writeSpy).toHaveBeenCalledTimes(2)
    // The first line is the initialize control request at startup (item 91). Only the user's lines are looked at.
    const userLines = child.written.map((w) => JSON.parse(w)).filter((m) => m.type === 'user')
    expect(userLines.map((m) => m.message.content[0].text)).toEqual([
      'first line that is long',
      'second'
    ])
    await session.stop()
  })
})

describe('Adapter — 1 通目の前のコネクタ待ち (TODO 869)', () => {
  const start = async (seen: AiosEvent[] = []): Promise<{ child: FakeChild; session: Awaited<ReturnType<InstanceType<typeof ClaudeCodeAdapter>['spawn']>> }> => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    const session = await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000000',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: null,
        modelId: null,
        thinking: null,
        gateway: gateway()
      },
      { onEvent: (e) => void seen.push(e), onExit: () => undefined }
    )
    const child = children()[0]
    if (child === undefined) throw new Error('no child')
    return { child, session }
  }
  const kinds = (child: FakeChild): string[] =>
    child.written.map((w) => {
      const m = JSON.parse(w) as { type: string; request?: { subtype: string } }
      return m.type === 'user' ? 'user' : (m.request?.subtype ?? m.type)
    })

  it('pending が残る間は user 行を書かず、消えたら書く。2 通目以降は待たない', async () => {
    const { child, session } = await start()
    child.mcpStatuses = [[], ['pending', 'needs-auth'], ['connected', 'needs-auth']]
    session.send({ text: 'hello' })
    await flush()
    expect(kinds(child)).not.toContain('user')
    await vi.waitFor(() => expect(kinds(child)).toContain('user'), { timeout: 3000 })
    expect(kinds(child).filter((k) => k === 'mcp_status').length).toBe(3)
    session.send({ text: 'again' })
    await flush()
    expect(kinds(child).filter((k) => k === 'mcp_status').length).toBe(3)
    expect(kinds(child).filter((k) => k === 'user').length).toBe(2)
    await session.stop()
  })

  it('待っている間は mcp_connecting で pending の数を知らせ、終わりに 0 を知らせる (案 C)', async () => {
    const seen: AiosEvent[] = []
    const { child, session } = await start(seen)
    child.mcpStatuses = [[], ['pending', 'pending'], ['connected', 'pending'], ['connected', 'connected']]
    session.send({ text: 'hello' })
    await vi.waitFor(() => expect(kinds(child)).toContain('user'), { timeout: 3000 })
    const counts = seen.flatMap((e) => (e.kind === 'mcp_connecting' ? [e.payload.pending] : []))
    expect(counts).toEqual([2, 1, 0])
    await session.stop()
  })

  it('割り込みは待ちを切り上げて、user 行を先に書いてから送る', async () => {
    const seen: AiosEvent[] = []
    const { child, session } = await start(seen)
    child.mcpStatuses = [['pending']]
    session.send({ text: 'hello' })
    await flush()
    void session.interrupt().catch(() => undefined)
    await vi.waitFor(() => expect(kinds(child)).toContain('interrupt'), { timeout: 3000 })
    const order = kinds(child).filter((k) => k === 'user' || k === 'interrupt')
    expect(order).toEqual(['user', 'interrupt'])
    // Even if released during the sleep of the wait, the heading's "connected" count returns to 0 (code-review).
    const counts = seen.flatMap((e) => (e.kind === 'mcp_connecting' ? [e.payload.pending] : []))
    expect(counts.at(-1)).toBe(0)
    await session.stop()
  })
})

describe('Adapter — initialize 制御要求 (項目 91 / 92)', () => {
  const fixture = readFileSync(new URL('./fixtures/initialize-response.json', import.meta.url), 'utf8')
    .split('\n')
    .join('')

  async function spawnWith(
    cache: ConstructorParameters<typeof ClaudeCodeAdapter>[0],
    modelId: string | null = null
  ): Promise<{
    adapter: InstanceType<typeof ClaudeCodeAdapter>
    child: FakeChild
    events: AiosEvent[]
  }> {
    const adapter = new ClaudeCodeAdapter(cache)
    await adapter.getStatus()
    const events: AiosEvent[] = []
    await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000001',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: null,
        modelId,
        thinking: null,
        gateway: gateway()
      },
      { onEvent: (event) => events.push(event), onExit: () => undefined }
    )
    await flush()
    const child = children().at(-1)
    if (child === undefined) throw new Error('no child')
    return { adapter, child, events }
  }

  /** Returns the fixture response using the request_id of the initialize that was written. */
  function answer(child: FakeChild): void {
    const request = child.written
      .map((w) => JSON.parse(w) as { type: string; request_id?: string })
      .find((m) => m.type === 'control_request')
    const reply = JSON.parse(fixture) as { response: { request_id: string } }
    reply.response.request_id = request?.request_id ?? ''
    child.stdout.write(`${JSON.stringify(reply)}\n`)
  }

  it('起動直後に initialize を 1 行書き、応答で版と効く段階を覚えて保存・通知する', async () => {
    const writeModels = vi.fn()
    const { adapter, child, events } = await spawnWith({
      read: () => null,
      write: () => undefined,
      readModels: () => null,
      writeModels
    })
    const first = JSON.parse(child.written[0] ?? '{}') as { type: string; request: { subtype: string } }
    expect(first.type).toBe('control_request')
    expect(first.request.subtype).toBe('initialize')
    // Before the response, only the name.
    expect((await adapter.listModels()).map((m) => m.label)).toEqual(['Haiku', 'Sonnet', 'Opus', 'Fable'])

    const changed = vi.fn()
    adapter.onModelsChanged(changed)
    answer(child)
    await flush()
    const models = await adapter.listModels()
    expect(models.filter((m) => m.pinned !== true).map((m) => m.label)).toEqual([
      'Haiku 4.5',
      'Sonnet 5',
      'Opus 4.8',
      'Fable 5'
    ])
    // TODO 769: unavailable_models is the gray line at the bottom.
    expect(models.filter((m) => m.unavailable === true).map((m) => m.label)).toEqual(['Fable 5.1', 'Opus 5.5'])
    expect(models.find((m) => m.id === 'haiku')?.thinkingLevels).toEqual(['off', 'medium'])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(writeModels).toHaveBeenCalledTimes(1)
    expect(writeModels.mock.calls[0]?.[0]).toBe(adapter.id)
    // The response line is not made an event (if it were saved as unknown, account information would stay in the DB).
    expect(events).toEqual([])
    // Even if the same response arrives (there is no waiting request anymore), it is neither saved nor notified.
    answer(child)
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(events).toEqual([])
  })

  it('保存した内容は次の起動の最初から効く (名前だけに戻らない)', async () => {
    let saved: string | null = null
    const first = await spawnWith({
      read: () => null,
      write: () => undefined,
      readModels: () => saved,
      writeModels: (_id, json) => {
        saved = json
      }
    })
    answer(first.child)
    await flush()
    const next = new ClaudeCodeAdapter({ read: () => null, write: () => undefined, readModels: () => saved })
    expect((await next.listModels()).map((m) => m.label)).toEqual([
      'Haiku 4.5',
      'Sonnet 5',
      'Opus 4.8',
      'Fable 5',
      // TODO 769: the lower section (models that cannot be used) is also restored from the copy.
      'Fable 5.1',
      'Opus 5.5'
    ])
  })

  it('応答が来ないまま終われば待ちは解け、init の model から受け身で覚える。旧 id は別名で渡す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { adapter, child } = await spawnWith(
      { read: () => null, write: () => undefined },
      'claude-haiku-4-5-20251001'
    )
    expect(child.written).toHaveLength(1)
    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'x',
        mcp_servers: [],
        tools: [],
        model: 'claude-haiku-4-5-20251001'
      })}\n`
    )
    await flush()
    expect((await adapter.listModels()).find((m) => m.id === 'haiku')?.label).toBe('Haiku 4.5')
    const spawnMock = vi.mocked(spawnProcess)
    const args = (spawnMock.mock.calls.at(-1)?.[1] ?? []) as readonly string[]
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
    // There is one timer waiting for the initialize response.
    expect(vi.getTimerCount()).toBe(1)
    child.emit('close', 0, null)
    await flush()
    // On exit, the response-wait timer is also cleared.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('TODO 1204: 段の札を新しい版に差し替えた別名は完全名で起動し、その init で別名の指す先を書き換えない', async () => {
    // CLI 2.1.319 shape: the alias fable = 5.1, and Fable 5.2 is a line with a fixed version.
    const saved = JSON.stringify({
      v: 1,
      models: { fable: { resolved: 'claude-fable-5-1', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] } },
      pinned: [
        { value: 'claude-fable-5-2', resolved: 'claude-fable-5-2', displayName: 'Fable 5.2', supportsEffort: true, effortLevels: null }
      ]
    })
    const writeModels = vi.fn()
    const { adapter, child } = await spawnWith(
      { read: () => null, write: () => undefined, readModels: () => saved, writeModels },
      'fable'
    )
    const spawnMock = vi.mocked(spawnProcess)
    const args = (spawnMock.mock.calls.at(-1)?.[1] ?? []) as readonly string[]
    expect(args[args.indexOf('--model') + 1]).toBe('claude-fable-5-2')
    child.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x', mcp_servers: [], tools: [], model: 'claude-fable-5-2' })}\n`
    )
    await flush()
    // The copy is not rewritten (the target of the alias fable stays at the CLI's 5.1, and the badge on the stage shows 5.2).
    expect(writeModels).not.toHaveBeenCalled()
    expect((await adapter.listModels()).find((m) => m.id === 'fable')?.label).toBe('Fable 5.2')
    child.emit('close', 0, null)
    await flush()
  })

  it('review Y-3: 差し替え先で起こしたセッションの init が別の表記 (日付付き) でも、別名の指す先として覚えない', async () => {
    const saved = JSON.stringify({
      v: 1,
      models: { fable: { resolved: 'claude-fable-5-1', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] } },
      pinned: [
        { value: 'claude-fable-5-2', resolved: 'claude-fable-5-2', displayName: 'Fable 5.2', supportsEffort: true, effortLevels: null }
      ]
    })
    const writeModels = vi.fn()
    const { adapter, child } = await spawnWith(
      { read: () => null, write: () => undefined, readModels: () => saved, writeModels },
      'fable'
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x', mcp_servers: [], tools: [], model: 'claude-fable-5-2-20261101' })}\n`
    )
    await flush()
    // Before, only an exact match that dropped `[1m]` was compared, so a dated spelling was learned as the target of the alias fable and replacement was stopped.
    expect(writeModels).not.toHaveBeenCalled()
    expect(adapter.cliModelValue('fable')).toBe('claude-fable-5-2')
    expect((await adapter.listModels()).find((m) => m.id === 'fable')?.label).toBe('Fable 5.2')
    child.emit('close', 0, null)
    await flush()
  })

  it('review Y-3: 別名そのものを渡したセッションの init は、今までどおり別名の指す先として覚える', async () => {
    const writeModels = vi.fn()
    const { adapter, child } = await spawnWith(
      { read: () => null, write: () => undefined, readModels: () => null, writeModels },
      'fable'
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x', mcp_servers: [], tools: [], model: 'claude-fable-5-1' })}\n`
    )
    await flush()
    expect(writeModels).toHaveBeenCalledTimes(1)
    expect((await adapter.listModels()).find((m) => m.id === 'fable')?.label).toBe('Fable 5.1')
    child.emit('close', 0, null)
    await flush()
  })

  it('review Y-1: 段から外れた版 (legacyIds にある完全名) を ▾ で選んだら、別名に読み替えず版を固定したまま渡す', async () => {
    // The alias haiku points to 4.5 (the dated full name = the key of legacyIds), and the CLI has Haiku 5.5 in the lower section.
    const saved = JSON.stringify({
      v: 1,
      models: { haiku: { resolved: 'claude-haiku-4-5-20251001', supportsEffort: false, effortLevels: null } },
      pinned: [
        { value: 'claude-haiku-5-5', resolved: 'claude-haiku-5-5', displayName: 'Haiku 5.5', supportsEffort: true, effortLevels: null }
      ]
    })
    const writeModels = vi.fn()
    const { adapter, child } = await spawnWith(
      { read: () => null, write: () => undefined, readModels: () => saved, writeModels },
      'claude-haiku-4-5-20251001'
    )
    const models = await adapter.listModels()
    expect(models.find((m) => m.id === 'haiku')?.label).toBe('Haiku 5.5')
    expect(models.find((m) => m.id === 'claude-haiku-4-5-20251001')?.pinned).toBe(true)
    // Both the thread's line and the value passed to the CLI stay 4.5 (before, haiku was read as 5.5 and ran as that).
    expect(adapter.canonicalModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    expect(adapter.cliModelValue('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    const args = (vi.mocked(spawnProcess).mock.calls.at(-1)?.[1] ?? []) as readonly string[]
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5-20251001')
    // The denominator of the pie chart is also the 4.5 one (200K, not 5.5's 1M).
    expect(adapter.contextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
    // The init of a session started at a fixed version does not tell what the alias haiku points to.
    child.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x', mcp_servers: [], tools: [], model: 'claude-haiku-4-5-20251001' })}\n`
    )
    await flush()
    expect(writeModels).not.toHaveBeenCalled()
    child.emit('close', 0, null)
    await flush()
  })

  it('review Y-6: 教わったことが変わると、差し替え・版固定の id・窓の大きさの引き当てが組み直される', async () => {
    const fixture319 = readFileSync(new URL('./fixtures/initialize-response-2.1.319.json', import.meta.url), 'utf8')
    const { adapter, child } = await spawnWith(
      { read: () => null, write: () => undefined, readModels: () => null, writeModels: () => undefined },
      'fable'
    )
    expect(adapter.cliModelValue('fable')).toBe('fable')
    const request = child.written
      .map((w) => JSON.parse(w) as { type: string; request_id?: string })
      .find((m) => m.type === 'control_request')
    const reply = JSON.parse(fixture319) as { response: { request_id: string } }
    reply.response.request_id = request?.request_id ?? ''
    child.stdout.write(`${JSON.stringify(reply)}\n`)
    await flush()
    expect(adapter.cliModelValue('fable')).toBe('claude-fable-5-2')
    // A 5.1 that has dropped off the stage becomes a fixed-version value (it is not read back as an alias).
    expect(adapter.canonicalModelId('claude-fable-5-1')).toBe('claude-fable-5-1')
    child.emit('close', 0, null)
    await flush()
  })
})

describe('Adapter — 割り込みと init (項目 94)', () => {
  async function start(): Promise<{
    child: FakeChild
    events: AiosEvent[]
    exits: number[]
    session: Awaited<ReturnType<InstanceType<typeof ClaudeCodeAdapter>['spawn']>>
  }> {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    const events: AiosEvent[] = []
    const exits: number[] = []
    const session = await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000001',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: null,
        modelId: null,
        thinking: null,
        gateway: gateway()
      },
      { onEvent: (event) => events.push(event), onExit: () => exits.push(1) }
    )
    const child = children()[0]
    if (child === undefined) throw new Error('no child')
    return { child, events, exits, session }
  }
  const line = (value: unknown): string => `${JSON.stringify(value)}\n`
  /**
   * The lines written, minus the initialize at startup (item 91). Interrupts also go through the same
   * `writeControlRequest` choke point, so they are told apart by their kind (`request.subtype`).
   */
  const writtenExceptInit = (child: FakeChild): Record<string, unknown>[] =>
    child.written
      .map((w) => JSON.parse(w) as Record<string, unknown>)
      .filter((w) => {
        const subtype = (w['request'] as { subtype?: string } | undefined)?.subtype
        return subtype !== 'initialize' && subtype !== 'mcp_status'
      })
  /** The request_id of the last interrupt written. */
  const lastInterruptId = (child: FakeChild): string => {
    const request = writtenExceptInit(child).at(-1) as { request_id: string; request: { subtype: string } }
    expect(request.request.subtype).toBe('interrupt')
    return request.request_id
  }
  const result = (subtype: string): string =>
    line({ type: 'result', subtype, is_error: subtype !== 'success', num_turns: 1, result: null })
  const results = (events: AiosEvent[]): { subtype: string; interrupted: boolean | undefined }[] =>
    events.flatMap((e) =>
      e.kind === 'result' ? [{ subtype: e.payload.subtype, interrupted: e.payload.interrupted }] : []
    )

  it('interrupt は制御要求を 1 行書き、受理の応答で解決する。プロセスは止めない', async () => {
    const { child, session, exits } = await start()
    session.send({ text: 'q' })
    const pending = session.interrupt()
    await flush()
    const written = writtenExceptInit(child)
    // Lined up after the user line (the write chain keeps the order). The initialize at startup is excluded when looking.
    expect(written.map((w) => w['type'])).toEqual(['user', 'control_request'])
    const request = written[1] as { request_id: string; request: { subtype: string } }
    expect(request.request.subtype).toBe('interrupt')
    child.stdout.write(
      line({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } })
    )
    await expect(pending).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
    expect(session.alive).toBe(true)
    expect(exits).toEqual([])
  })

  it('中断の後の error_during_execution は interrupted。中断していなければ付けない', async () => {
    const { child, session, events } = await start()
    // A failure that is not from an interruption stays an error.
    child.stdout.write(result('error_during_execution'))
    await flush()
    const pending = session.interrupt()
    await flush()
    const request = { request_id: lastInterruptId(child) }
    child.stdout.write(
      line({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } })
    )
    await pending
    child.stdout.write(result('error_during_execution'))
    // The mark is set off once: a failure in the next turn is not mistaken for an interruption.
    child.stdout.write(result('error_during_execution'))
    await flush()
    expect(results(events)).toEqual([
      { subtype: 'error_during_execution', interrupted: undefined },
      { subtype: 'error_during_execution', interrupted: true },
      { subtype: 'error_during_execution', interrupted: undefined }
    ])
    // Control responses are not emitted as events (and not as unknown either).
    expect(events.filter((e) => e.kind === 'unknown')).toEqual([])
  })

  it('中断がターンの終わりと行き違ったら (先に success の result)、次の失敗を中断にしない', async () => {
    const { child, session, events } = await start()
    const pending = session.interrupt()
    await flush()
    child.stdout.write(result('success'))
    const request = { request_id: lastInterruptId(child) }
    child.stdout.write(
      line({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } })
    )
    await pending
    child.stdout.write(result('error_during_execution'))
    await flush()
    expect(results(events).map((r) => r.interrupted)).toEqual([undefined, undefined])
  })

  it('受理されなければ reject、応答が来なければ時間切れで reject し、timer を残さない', async () => {
    const { child, session } = await start()
    const rejected = session.interrupt()
    await flush()
    const request = { request_id: lastInterruptId(child) }
    child.stdout.write(
      line({ type: 'control_response', response: { subtype: 'error', request_id: request.request_id, error: 'x' } })
    )
    await expect(rejected).rejects.toThrow()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timedOut = session.interrupt()
    const assertion = expect(timedOut).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('応答の前にプロセスが終われば reject する', async () => {
    const { child, session } = await start()
    const pending = session.interrupt()
    const assertion = expect(pending).rejects.toThrow('exited')
    await flush()
    child.emit('close', 0, null)
    await assertion
  })

  it('system/init はターンごとに出るが、session_started は最初の 1 回だけ流す', async () => {
    const { child, events } = await start()
    const init = line({ type: 'system', subtype: 'init', session_id: 's', tools: [], model: 'm' })
    child.stdout.write(init)
    child.stdout.write(result('success'))
    child.stdout.write(init)
    child.stdout.write(result('success'))
    await flush()
    expect(events.filter((e) => e.kind === 'session_started')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'result')).toHaveLength(2)
  })

  it('割り込みと initialize は同じ口 (writeControlRequest) で、応答は request_id で取り違えない', async () => {
    const { child, session, events } = await start()
    const pending = session.interrupt()
    await flush()
    const requests = child.written
      .map((w) => JSON.parse(w) as { type: string; request_id: string; request: { subtype: string } })
      .filter((w) => w.type === 'control_request')
    expect(requests.map((r) => r.request.subtype)).toEqual(['initialize', 'interrupt'])
    // Even if a success arrives with the request_id of initialize, the wait for the interrupt is not resolved.
    let settled = false
    void pending.then(() => (settled = true))
    child.stdout.write(
      line({ type: 'control_response', response: { subtype: 'success', request_id: requests[0]?.request_id, response: {} } })
    )
    await flush()
    expect(settled).toBe(false)
    child.stdout.write(
      line({ type: 'control_response', response: { subtype: 'success', request_id: requests[1]?.request_id } })
    )
    await expect(pending).resolves.toBeUndefined()
    expect(events).toEqual([])
    await session.stop()
  })

  it('項目 93: 実物の並走 (spike 19) — result の費用はプロセスの累積なのでターンごとの差分に直す', async () => {
    const { child, events } = await start()
    const fixture = readFileSync(new URL('./fixtures/subagents.jsonl', import.meta.url), 'utf8')
    child.stdout.write(fixture)
    await flush()
    // Including the 2 turns the parent started itself, result comes 3 times, and init starts once although it is per turn.
    const costs = events.flatMap((e) => (e.kind === 'result' ? [e.payload.costUsd] : []))
    expect(costs).toHaveLength(3)
    expect(events.filter((e) => e.kind === 'session_started')).toHaveLength(1)
    // The report is $0.0926 -> $0.1096 -> $0.1139 (cumulative). The sum of the differences becomes the last cumulative value.
    expect(costs[0]).toBeCloseTo(0.09262835, 8)
    expect(costs[1]).toBeCloseTo(0.10959600 - 0.09262835, 8)
    expect(costs[2]).toBeCloseTo(0.11387730 - 0.10959600, 8)
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.1138773, 8)
    // Neither the full set of background tasks (background_tasks_changed) nor the initialize response is made unknown.
    expect(events.filter((e) => e.kind === 'unknown')).toEqual([])
  })

  it('費用の累積が減ったら (数え直し) その値を差分とみなす', async () => {
    const { child, events } = await start()
    const cost = (value: number): string =>
      line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: null, total_cost_usd: value })
    child.stdout.write(cost(0.5))
    child.stdout.write(cost(0.2))
    await flush()
    expect(events.flatMap((e) => (e.kind === 'result' ? [e.payload.costUsd] : []))).toEqual([0.5, 0.2])
  })

  it('abort (停止ボタン) は SIGINT でプロセスごと止める', async () => {
    const { child, session } = await start()
    session.abort()
    expect(child.kill).toHaveBeenCalledWith('SIGINT')
  })
})

describe('Adapter — 走ったままの切り替え (項目 95)', () => {
  type Written = { type: string; request_id?: string; request?: Record<string, unknown> }
  /** Starts a child that answers control requests other than initialize automatically, and returns it. */
  async function start(
    version: string,
    modelId: string | null,
    thinking: ThinkingLevel | null,
    reply: (request: Record<string, unknown>) => boolean = () => true
  ): Promise<{
    child: FakeChild
    session: Awaited<ReturnType<InstanceType<typeof ClaudeCodeAdapter>['spawn']>>
    requests: () => Record<string, unknown>[]
  }> {
    state.version = version
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    const session = await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000001',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: null,
        modelId,
        thinking,
        gateway: gateway()
      },
      { onEvent: () => undefined, onExit: () => undefined }
    )
    const child = children().at(-1)
    if (child === undefined) throw new Error('no child')
    child.onLine = (text) => {
      const message = JSON.parse(text) as Written
      if (message.type !== 'control_request' || message.request?.['subtype'] === 'initialize') return
      const ok = reply(message.request ?? {})
      const response = ok
        ? { subtype: 'success', request_id: message.request_id }
        : { subtype: 'error', request_id: message.request_id, error: 'no' }
      setImmediate(() => child.stdout.write(`${JSON.stringify({ type: 'control_response', response })}\n`))
    }
    const requests = (): Record<string, unknown>[] =>
      child.written
        .map((w) => JSON.parse(w) as Written)
        .filter((w) => w.type === 'control_request' && w.request?.['subtype'] !== 'initialize')
        .map((w) => w.request ?? {})
    return { child, session, requests }
  }

  afterEach(() => {
    state.version = '9.9.9'
  })

  it('モデルと effort を変える: set_model (別名) → effortLevel の順に送り、プロセスは止めない', async () => {
    const { child, session, requests } = await start('2.1.280', 'sonnet', 'low')
    expect(session.switchRestart).toBe('never')
    await expect(session.switchSettings?.({ modelId: 'opus', thinking: 'high' })).resolves.toBe(true)
    expect(requests()).toEqual([
      { subtype: 'set_model', model: 'opus' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }
    ])
    expect(child.kill).not.toHaveBeenCalled()
    // The same setting sends nothing (it remembers the setting currently in effect).
    await expect(session.switchSettings?.({ modelId: 'opus', thinking: 'high' })).resolves.toBe(true)
    expect(requests()).toHaveLength(2)
  })

  it('TODO 1205: 「深く」より上の段 (xhigh / max) と名前の無い段も、起動の --effort と走ったままの effortLevel で値のまま渡す', async () => {
    const { session, requests } = await start('2.1.280', 'opus', 'xhigh')
    const spawnMock = vi.mocked(spawnProcess)
    const args = (spawnMock.mock.calls.at(-1)?.[1] ?? []) as readonly string[]
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh')
    expect(args).not.toContain('--thinking')
    await expect(session.switchSettings?.({ modelId: 'opus', thinking: 'high' })).resolves.toBe(true)
    await expect(session.switchSettings?.({ modelId: 'opus', thinking: 'xhigh' })).resolves.toBe(true)
    expect(requests()).toEqual([
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh' } }
    ])
  })

  it('review Y-4: effortLevel が受けると確かめていない値 (2.1.280 の max・名前の無い段) は送らずに起こし直しへ倒す', async () => {
    const { session, requests } = await start('2.1.280', 'opus', 'high')
    // CLI 2.1.280's effortLevel options do not include max (spike 18). A value it does not accept still returns success and keeps the previous value, so it is not sent.
    await expect(session.switchSettings?.({ modelId: 'opus', thinking: 'max' })).resolves.toBe(false)
    await expect(session.switchSettings?.({ modelId: 'opus', thinking: 'effort:ultra' })).resolves.toBe(false)
    // TODO 1208: 2.1.322 is in the feature table, and max is sent too while running. For 2.1.321, which is not in the table, it restarts (live-settings fake).
    const live = await start('2.1.322', 'opus', 'high')
    await expect(live.session.switchSettings?.({ modelId: 'opus', thinking: 'max' })).resolves.toBe(true)
    const unknown = await start('2.1.321', 'opus', 'high')
    await expect(unknown.session.switchSettings?.({ modelId: 'opus', thinking: 'low' })).resolves.toBe(false)
    // Changing the model also sends effort again, so if it stays max it is restarted in the same way (set_model is not sent either).
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: 'max' })).resolves.toBe(false)
    expect(requests()).toEqual([])
    // The restart flag (`--effort`) passes max as a value too.
    const { session: restarted } = await start('2.1.280', 'opus', 'max')
    const args = (vi.mocked(spawnProcess).mock.calls.at(-1)?.[1] ?? []) as readonly string[]
    expect(args[args.indexOf('--effort') + 1]).toBe('max')
    // Lowering from max can be sent.
    await expect(restarted.switchSettings?.({ modelId: 'opus', thinking: 'high' })).resolves.toBe(true)
  })

  it('review Y-4: 走ったままの effortLevel の下限は版で引く (max は 2.1.322 から、表に無い値はどの版でも送らない)', async () => {
    const accepted = async (version: string, value: string): Promise<boolean> => {
      state.version = version
      const adapter = new ClaudeCodeAdapter()
      await adapter.getStatus()
      return (adapter as unknown as { liveEffortAccepted: (v: string) => boolean }).liveEffortAccepted(value)
    }
    await expect(accepted('2.1.280', 'xhigh')).resolves.toBe(true)
    await expect(accepted('2.1.280', 'max')).resolves.toBe(false)
    await expect(accepted('2.1.317', 'max')).resolves.toBe(false)
    await expect(accepted('2.1.322', 'max')).resolves.toBe(true)
    await expect(accepted('2.1.322', 'ultra')).resolves.toBe(false)
  })

  it('review Y-2: 起動後に段の札が新しい版に替わったら、同じ指定のままでも次の切り替えで set_model を送って揃える', async () => {
    const fixture319 = readFileSync(new URL('./fixtures/initialize-response-2.1.319.json', import.meta.url), 'utf8')
    const { child, session, requests } = await start('2.1.280', 'fable', 'high')
    const spawnArgs = (vi.mocked(spawnProcess).mock.calls.at(-1)?.[1] ?? []) as readonly string[]
    // Before it is taught, it stays an alias (= the CLI's default 5.1) and starts that way.
    expect(spawnArgs[spawnArgs.indexOf('--model') + 1]).toBe('fable')
    expect(session.modelDrifted?.()).toBe(false)
    const request = child.written
      .map((w) => JSON.parse(w) as { type: string; request_id?: string; request?: Record<string, unknown> })
      .find((m) => m.type === 'control_request' && m.request?.['subtype'] === 'initialize')
    const reply = JSON.parse(fixture319) as { response: { request_id: string } }
    reply.response.request_id = request?.request_id ?? ''
    child.stdout.write(`${JSON.stringify(reply)}\n`)
    await flush()
    // The initialize response made the stage badge 5.2. The process is still 5.1.
    expect(session.modelDrifted?.()).toBe(true)
    await expect(session.switchSettings?.({ modelId: 'fable', thinking: 'high' })).resolves.toBe(true)
    expect(requests()).toEqual([
      { subtype: 'set_model', model: 'claude-fable-5-2' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }
    ])
    expect(session.modelDrifted?.()).toBe(false)
    await expect(session.switchSettings?.({ modelId: 'fable', thinking: 'high' })).resolves.toBe(true)
    expect(requests()).toHaveLength(2)
  })

  it('thinking を切るのは予算 0、戻すのは null (起動時の値) と effort', async () => {
    const { session, requests } = await start('2.1.280', 'sonnet', 'medium')
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: 'off' })).resolves.toBe(true)
    expect(requests()).toEqual([{ subtype: 'set_max_thinking_tokens', max_thinking_tokens: 0 }])
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: 'medium' })).resolves.toBe(true)
    expect(requests().slice(1)).toEqual([
      { subtype: 'set_max_thinking_tokens', max_thinking_tokens: null },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'medium' } }
    ])
  })

  it('thinking を切って起動したプロセスで点け直すのは起こし直し (何も送らずに false)', async () => {
    const { session, requests } = await start('2.1.280', 'haiku', 'off')
    expect(session.switchRestart).toBe('thinking-on')
    await expect(session.switchSettings?.({ modelId: 'haiku', thinking: 'medium' })).resolves.toBe(false)
    expect(requests()).toEqual([])
    // A model change left at "none" can keep running.
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: 'off' })).resolves.toBe(true)
    expect(requests()).toEqual([{ subtype: 'set_model', model: 'sonnet' }])
  })

  it('拒否されたらそこで止めて false (起こし直しが全部を渡し直す)', async () => {
    const { session, requests } = await start('2.1.280', 'sonnet', 'low', (r) => r['subtype'] !== 'set_model')
    await expect(session.switchSettings?.({ modelId: 'opus', thinking: 'high' })).resolves.toBe(false)
    expect(requests().map((r) => r['subtype'])).toEqual(['set_model'])
    // A failed switch does not change the "setting currently in effect".
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: 'low' })).resolves.toBe(true)
    expect(requests()).toHaveLength(1)
  })

  it('既知でない版 (live-settings が偽) では口を使わず always', async () => {
    const { session, requests } = await start('9.9.9', 'sonnet', 'low')
    expect(session.switchRestart).toBe('always')
    await expect(session.switchSettings?.({ modelId: 'opus', thinking: 'low' })).resolves.toBe(false)
    expect(requests()).toEqual([])
  })

  it('既定 (null) への切り替えは制御要求で表せないので false', async () => {
    const { session, requests } = await start('2.1.280', 'sonnet', 'low')
    await expect(session.switchSettings?.({ modelId: null, thinking: 'low' })).resolves.toBe(false)
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: null })).resolves.toBe(false)
    expect(requests()).toEqual([])
  })
})

describe('Adapter — initialize のコマンド一覧 (項目 68 の穴 / 95)', () => {
  async function spawnOnce(
    adapter: InstanceType<typeof ClaudeCodeAdapter>,
    commands: unknown[]
  ): Promise<void> {
    await adapter.getStatus()
    await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000001',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: null,
        modelId: null,
        thinking: null,
        gateway: gateway()
      },
      { onEvent: () => undefined, onExit: () => undefined }
    )
    await flush()
    const child = children().at(-1)
    if (child === undefined) throw new Error('no child')
    const request = JSON.parse(child.written[0] ?? '{}') as { request_id: string }
    child.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: request.request_id, response: { commands, models: [] } }
      })}\n`
    )
    await flush()
  }

  it('応答の commands (名前) を覚えて控えに残し、次の起動の最初から返す。空の一覧は知らない扱い', async () => {
    let saved: string | null = null
    const cache = {
      read: () => null,
      write: () => undefined,
      readModels: () => saved,
      writeModels: (_id: string, json: string) => {
        saved = json
      }
    }
    const first = new ClaudeCodeAdapter(cache)
    expect(first.knownCommands()).toBeNull()
    await spawnOnce(first, [])
    expect(first.knownCommands()).toBeNull()
    expect(saved).toBeNull()

    const second = new ClaudeCodeAdapter(cache)
    await spawnOnce(second, [
      { name: 'compact', description: 'x', argumentHint: '', builtin: true },
      { name: 'context', description: 'y' }
    ])
    // Item 117: a built-in that works without being in the list (builtinCommands in compat/) is appended to the end.
    expect(second.knownCommands()).toEqual(['compact', 'context', 'cost'])
    expect(saved).not.toBeNull()
    // The copy keeps the list as reported (the table fixes it when it is passed).
    expect(JSON.parse(saved ?? '{}').commands).toEqual(['compact', 'context'])
    // The next launch (a new Adapter) returns it first from the copy.
    expect(new ClaudeCodeAdapter(cache).knownCommands()).toEqual(['compact', 'context', 'cost'])
  })
})

describe('Adapter — 組み込みコマンドの実物 (項目 117、束 C)', () => {
  async function startWith(resume: string | null): Promise<{ child: FakeChild; events: AiosEvent[] }> {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    const events: AiosEvent[] = []
    await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000001',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: resume,
        modelId: null,
        thinking: null,
        gateway: gateway()
      },
      { onEvent: (event) => events.push(event), onExit: () => undefined }
    )
    const child = children().at(-1)
    if (child === undefined) throw new Error('no child')
    return { child, events }
  }
  const fixture = (): string => readFileSync(new URL('./fixtures/builtins.jsonl', import.meta.url), 'utf8')

  it('リセットの後の init だけは新しいセッションとして流す (再開の印は付けない)。費用の累積も 0 から数え直す', async () => {
    const { child, events } = await startWith('d0b6146d-9c7a-4e51-b9cb-8347de35e717')
    child.stdout.write(fixture())
    await flush()
    const starts = events.flatMap((e) =>
      e.kind === 'session_started' ? [{ id: e.payload.backendSessionId, resumed: e.payload.resumed }] : []
    )
    expect(starts).toEqual([
      { id: 'd0b6146d-9c7a-4e51-b9cb-8347de35e717', resumed: true },
      { id: 'b5c24320-c280-45fb-b89a-0b6c9c391703', resumed: false }
    ])
    // The separator is one item, before session_started.
    const kinds = events.map((e) => e.kind)
    expect(kinds.indexOf('conversation_reset')).toBeLessThan(kinds.lastIndexOf('session_started'))
    // The report is cumulative (...0.06856 -> reset to 0 -> 0.01079). The sum of the differences becomes the total before and after the reset.
    const costs = events.flatMap((e) => (e.kind === 'result' ? [e.payload.costUsd] : []))
    expect(costs).toHaveLength(10)
    expect(costs[8]).toBe(0)
    expect(costs[9]).toBeCloseTo(0.0107938, 8)
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.06855725 + 0.0107938, 8)
    expect(events.filter((e) => e.kind === 'unknown')).toEqual([])
  })
})

describe('Adapter — 巻き戻しの旗と rewind_files (項目 113)', () => {
  type Written = { type: string; request_id?: string; request?: Record<string, unknown> }
  async function start(
    version: string,
    options: { resume?: string | null; at?: string | null; fork?: boolean; worktreeName?: string } = {},
    reply: (request: Record<string, unknown>) => Record<string, unknown> | 'error' = () => ({})
  ): Promise<{
    child: FakeChild
    session: Awaited<ReturnType<InstanceType<typeof ClaudeCodeAdapter>['spawn']>>
    args: readonly string[]
    requests: () => Record<string, unknown>[]
  }> {
    state.version = version
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    const session = await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000001',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: options.resume ?? null,
        resumeAtMessageId: options.at ?? null,
        forkSession: options.fork === true,
        ...(options.worktreeName === undefined ? {} : { worktreeName: options.worktreeName }),
        modelId: null,
        thinking: null,
        gateway: gateway()
      },
      { onEvent: () => undefined, onExit: () => undefined }
    )
    const child = children().at(-1)
    if (child === undefined) throw new Error('no child')
    const calls = vi.mocked(spawnProcess).mock.calls
    const args = (calls[calls.length - 1]?.[1] ?? []) as readonly string[]
    child.onLine = (text) => {
      const message = JSON.parse(text) as Written
      if (message.type !== 'control_request' || message.request?.['subtype'] === 'initialize') return
      const body = reply(message.request ?? {})
      const response =
        body === 'error'
          ? { subtype: 'error', request_id: message.request_id, error: 'Unsupported control request subtype' }
          : { subtype: 'success', request_id: message.request_id, response: body }
      setImmediate(() => child.stdout.write(`${JSON.stringify({ type: 'control_response', response })}\n`))
    }
    const requests = (): Record<string, unknown>[] =>
      child.written
        .map((w) => JSON.parse(w) as Written)
        .filter((w) => w.type === 'control_request' && w.request?.['subtype'] !== 'initialize')
        .map((w) => w.request ?? {})
    return { child, session, args, requests }
  }

  afterEach(() => {
    state.version = '9.9.9'
  })

  it('対応する版では --replay-user-messages を付け、分岐の起動は --resume-session-at と --fork-session を足す', async () => {
    const plain = await start('2.1.280')
    expect(plain.args).toContain('--replay-user-messages')
    expect(plain.args).not.toContain('--fork-session')
    expect(plain.args).not.toContain('--resume-session-at')

    const fork = await start('2.1.280', { resume: 'sid-orig', at: 'msg-a1', fork: true })
    const at = fork.args.indexOf('--resume')
    expect(fork.args[at + 1]).toBe('sid-orig')
    expect(fork.args.indexOf('--resume-session-at')).toBeGreaterThan(-1)
    expect(fork.args[fork.args.indexOf('--resume-session-at') + 1]).toBe('msg-a1')
    expect(fork.args).toContain('--fork-session')
    expect(fork.args).not.toContain('--session-id')

    // Even on a branch, if there is no `at`, it counts from the end (no flag is emitted).
    const tail = await start('2.1.280', { resume: 'sid-orig', at: null, fork: true })
    expect(tail.args).toContain('--fork-session')
    expect(tail.args).not.toContain('--resume-session-at')
  })

  it('束の会話 (TODO 633 段 3): 新規の起動だけ --worktree <名前> を付け、再開と不正な名前では付けない', async () => {
    const fresh = await start('2.1.280', { worktreeName: 'fix-a-1b2c' })
    expect(fresh.args[fresh.args.indexOf('--worktree') + 1]).toBe('fix-a-1b2c')
    expect((await start('2.1.280')).args).not.toContain('--worktree')
    expect((await start('2.1.280', { resume: 'sid', worktreeName: 'x' })).args).not.toContain('--worktree')
    expect((await start('2.1.280', { worktreeName: '../evil' })).args).not.toContain('--worktree')
  })

  it('測っていない版 (2.1.207) では旗を出さず、rewindFiles は null (口が無い)', async () => {
    const { session, args } = await start('2.1.207', { resume: 'sid', at: 'm', fork: true })
    expect(args).not.toContain('--replay-user-messages')
    expect(args).not.toContain('--fork-session')
    expect(args).not.toContain('--resume-session-at')
    expect(await session.rewindFiles?.('u-1', true)).toBeNull()
  })

  it('rewindFiles は rewind_files を 1 行書き、dry_run の応答を結果に直す', async () => {
    const { session, requests } = await start('2.1.280', {}, (request) =>
      request['dry_run'] === true
        ? { canRewind: true, filesChanged: ['/w/note.txt', '/w/b.ts'], insertions: 3, deletions: 1 }
        : { canRewind: true, skippedLinks: 0 }
    )
    const dry = await session.rewindFiles?.('u-2', true)
    expect(dry).toEqual({ canRewind: true, filesChanged: ['/w/note.txt', '/w/b.ts'], insertions: 3, deletions: 1 })
    const real = await session.rewindFiles?.('u-2', false)
    expect(real).toEqual({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 })
    expect(requests()).toEqual([
      { subtype: 'rewind_files', user_message_id: 'u-2', dry_run: true },
      { subtype: 'rewind_files', user_message_id: 'u-2' }
    ])
  })

  it('チェックポイントが無い応答 (success の中の canRewind: false) は false、拒否は reject', async () => {
    let mode: 'none' | 'reject' = 'none'
    const { session } = await start('2.1.280', {}, () =>
      mode === 'reject' ? 'error' : { canRewind: false, error: 'No file checkpoint found for this message.' }
    )
    const none = await session.rewindFiles?.('bogus', true)
    expect(none?.canRewind).toBe(false)
    mode = 'reject'
    await expect(session.rewindFiles?.('bogus', false)).rejects.toThrow('Unsupported')
  })
})
