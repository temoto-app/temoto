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
const { appIntroductionText, gatewayInstructions, loadCompatTable } = await import('../src/main/session/adapter/compat.js')
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

describe('Adapter: probe (item 81)', () => {
  it('an unknown version needs a probe and a cache makes it unnecessary', async () => {
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

  it('when init never arrives and it times out, stops the child, leaves no timer, and adds a degradation reason to the provisional feature table', async () => {
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

  it('when init arrives, stops the child, marks only the passed flags true, and writes the cache', async () => {
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

describe('Adapter: extra gateway instructions (TODO 822)', () => {
  it('adds one extra instruction telling it to use openUrl to a launch that passes the gateway', async () => {
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

  it("TODO 972: a role's standing instructions ride on the same single extra-instructions flag, after the gateway text", async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(
      {
        sessionId: '00000000-0000-4000-8000-000000000003',
        threadId: 't',
        cwd: dir,
        allowedDirs: [],
        resumeBackendSessionId: null,
        modelId: null,
        thinking: null,
        roleInstructions: 'Keep replies short.\nAsk before paying.',
        gateway: gateway()
      },
      { onEvent: () => undefined, onExit: () => undefined }
    )
    const args = (vi.mocked(spawnProcess).mock.calls.at(-1)?.[1] ?? []) as readonly string[]
    const table = loadCompatTable()
    const flagName = table.flags['appendSystemPrompt'] as string
    expect(args.filter((arg) => arg === flagName)).toHaveLength(1)
    const text = args[args.indexOf(flagName) + 1] ?? ''
    expect(text).toContain(`mcp__${table.mcp.serverName}__openUrl`)
    expect(text.endsWith('Keep replies short.\nAsk before paying.')).toBe(true)
    expect(text.indexOf('openUrl')).toBeLessThan(text.indexOf('Keep replies short.'))
  })

  it('every {tool:x} in the extra instructions is the name of a tool the gateway actually registers (TODO 1060 stage 2)', () => {
    const source = readFileSync(new URL('../src/gateway/index.ts', import.meta.url), 'utf8')
    const registered = new Set([...source.matchAll(/server\.registerTool\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]))
    expect(registered.has('openSettings')).toBe(true)
    const named = (loadCompatTable().mcp.instructions ?? []).flatMap((line) =>
      [...line.matchAll(/\{tool:([A-Za-z0-9_]+)\}/g)].map((m) => m[1])
    )
    expect(named.length).toBeGreaterThan(0)
    for (const tool of named) expect(registered, tool).toContain(tool)
  })

  it('appIntroductionText (TODO 1296): names the product, points to the guide, has no placeholder left, and is independent of the gateway lines', () => {
    const table = loadCompatTable()
    const text = appIntroductionText(table, '~/Temoto/help', 'Temoto') ?? ''
    expect(text).toContain('running inside Temoto')
    expect(text).toContain('~/Temoto/help/ai-guide.md')
    expect(text).not.toMatch(/\{(app|helpDir|tool:[A-Za-z0-9_]+)\}/)
    expect(text.length).toBeLessThan(700)
    expect(appIntroductionText({ ...table, mcp: { ...table.mcp, introduction: [] } })).toBeNull()
    expect(appIntroductionText({ ...table, mcp: { ...table.mcp, instructions: [] } })).toBe(appIntroductionText(table))
    // The gateway lines name the product too, from the same source.
    expect(gatewayInstructions(table, '~/x', 'Temoto')).not.toMatch(/\baios\b(?!__)/)
  })

  it('gatewayInstructions: null when missing from the table or empty; {tool:x} is replaced with the gateway tool name', () => {
    const table = loadCompatTable()
    expect(gatewayInstructions({ ...table, mcp: { ...table.mcp, instructions: [] } })).toBeNull()
    expect(gatewayInstructions({ ...table, mcp: { ...table.mcp, instructions: undefined } })).toBeNull()
    expect(gatewayInstructions({ ...table, mcp: { ...table.mcp, instructions: ['a {tool:openUrl}', ' ', 'b'] } })).toBe(
      `a mcp__${table.mcp.serverName}__openUrl\nb`
    )
  })
})

describe('Adapter: do not break the prompt cache (TODO 963)', () => {
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

  it('the extra instructions do not change by a single character even when relaunching mid-conversation (resume, Model / Thinking, reference scope, time differ)', async () => {
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
    expect(first).toBe(`${appIntroductionText(loadCompatTable())}\n${gatewayInstructions(loadCompatTable())}`)
    expect(first).not.toContain(dir)
    expect(first).not.toContain('00000000-0000-4000-8000-0000000000')
    expect(first).not.toMatch(/20\d\d-\d\d-\d\d|\d{1,2}:\d\d/)
  })
})

describe('Adapter: per-server gateway timeout (TODO 632)', () => {
  it("writes compat's toolTimeoutMs as timeout in the gateway line of --mcp-config", async () => {
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

  it('does not add it when the table value is missing, under 1000 ms, or not a number (the CLI ignores values under 1000)', () => {
    const table = loadCompatTable()
    const withTimeout = (value: unknown): typeof table => ({ ...table, mcp: { ...table.mcp, toolTimeoutMs: value as number } })
    expect(gatewayTimeout(withTimeout(undefined))).toEqual({})
    expect(gatewayTimeout(withTimeout(999))).toEqual({})
    expect(gatewayTimeout(withTimeout('1000'))).toEqual({})
    expect(gatewayTimeout(withTimeout(Number.NaN))).toEqual({})
    expect(gatewayTimeout(withTimeout(1000.5))).toEqual({ timeout: 1000 })
  })
})

describe('Adapter: stdin (item 82)', () => {
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

  it('an EPIPE on stdin does not become uncaught and becomes an error event on the stream', async () => {
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

  it('send and stop on a broken stdin do not throw', async () => {
    const { child, session } = await start()
    child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    await flush()
    expect(() => session.send({ text: 'x' })).not.toThrow()
    await flush()
    await expect(session.stop()).resolves.toBeUndefined()
  })

  it('under backpressure (write returns false) does not write the next line until drain', async () => {
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

describe('Adapter: waiting for connectors before the first message (TODO 869)', () => {
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

  it('does not write the user line while pending remains and writes it when it is gone; does not wait from the second message on', async () => {
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

  it('while waiting, reports the pending count with mcp_connecting and reports 0 at the end (plan C)', async () => {
    const seen: AiosEvent[] = []
    const { child, session } = await start(seen)
    child.mcpStatuses = [[], ['pending', 'pending'], ['connected', 'pending'], ['connected', 'connected']]
    session.send({ text: 'hello' })
    await vi.waitFor(() => expect(kinds(child)).toContain('user'), { timeout: 3000 })
    const counts = seen.flatMap((e) => (e.kind === 'mcp_connecting' ? [e.payload.pending] : []))
    expect(counts).toEqual([2, 1, 0])
    await session.stop()
  })

  it('an interrupt cuts the wait short and writes the user line first before sending', async () => {
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

describe('Adapter: initialize control request (items 91 / 92)', () => {
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

  it('writes one initialize line right after launch, and remembers, saves, and notifies the version and effective stages from the response', async () => {
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

  it('saved content takes effect from the start of the next launch (does not fall back to names only)', async () => {
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

  it('when it ends without a response the wait is released and it learns passively from the init model; the old id is passed as an alias', async () => {
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

  it('TODO 1204: an alias whose stage label was replaced by a newer version launches with the full name and does not rewrite what the alias points to at that init', async () => {
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

  it('review Y-3: does not remember the alias target even when the init of a session launched with the replacement uses a different notation (with a date)', async () => {
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

  it('review Y-3: the init of a session that was given the alias itself is still remembered as what the alias points to', async () => {
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

  it('review Y-1: when a version outside the stages (a full name in legacyIds) is chosen with ▾, passes it with the version pinned instead of reading it as an alias', async () => {
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

  it('review Y-6: when what it was taught changes, the lookups for replacement, pinned-version ids, and window size are rebuilt', async () => {
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

describe('Adapter: interrupt and init (item 94)', () => {
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

  it('interrupt writes one control request line and resolves on the accepted response; does not stop the process', async () => {
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

  it('error_during_execution after an abort is interrupted; not set if there was no abort', async () => {
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

  it('when an abort crosses the end of a turn (a success result comes first), does not treat the next failure as an abort', async () => {
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

  it('rejects if not accepted and rejects on timeout when no response comes, leaving no timer', async () => {
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

  it('rejects if the process ends before the response', async () => {
    const { child, session } = await start()
    const pending = session.interrupt()
    const assertion = expect(pending).rejects.toThrow('exited')
    await flush()
    child.emit('close', 0, null)
    await assertion
  })

  it('system/init appears every turn but session_started is emitted only the first time', async () => {
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

  it('interrupt and initialize share one path (writeControlRequest) and responses are not mixed up thanks to request_id', async () => {
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

  it('item 93: real parallel run (spike 19) — the result cost is cumulative per process, so convert it to a per-turn delta', async () => {
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

  it('when the cumulative cost decreases (recount), treats that value as the delta', async () => {
    const { child, events } = await start()
    const cost = (value: number): string =>
      line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: null, total_cost_usd: value })
    child.stdout.write(cost(0.5))
    child.stdout.write(cost(0.2))
    await flush()
    expect(events.flatMap((e) => (e.kind === 'result' ? [e.payload.costUsd] : []))).toEqual([0.5, 0.2])
  })

  it('abort (stop button) stops the whole process with SIGINT', async () => {
    const { child, session } = await start()
    session.abort()
    expect(child.kill).toHaveBeenCalledWith('SIGINT')
  })
})

describe('Adapter: switching while running (item 95)', () => {
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

  it('changing model and effort: sends set_model (alias) then effortLevel and does not stop the process', async () => {
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

  it('TODO 1205: stages above "deep" (xhigh / max) and unnamed stages are passed as is by the launch --effort and the running effortLevel', async () => {
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

  it('review Y-4: values not confirmed to be accepted by effortLevel (max on 2.1.280, unnamed stages) are not sent and fall back to a relaunch', async () => {
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

  it('review Y-4: the lower bound of the running effortLevel is looked up by version (max from 2.1.322; values not in the table are never sent on any version)', async () => {
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

  it('review Y-2: when the stage label changes to a newer version after launch, the next switch sends set_model to align even with the same specification', async () => {
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

  it('turning thinking off is budget 0 and turning it back is null (launch value) and effort', async () => {
    const { session, requests } = await start('2.1.280', 'sonnet', 'medium')
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: 'off' })).resolves.toBe(true)
    expect(requests()).toEqual([{ subtype: 'set_max_thinking_tokens', max_thinking_tokens: 0 }])
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: 'medium' })).resolves.toBe(true)
    expect(requests().slice(1)).toEqual([
      { subtype: 'set_max_thinking_tokens', max_thinking_tokens: null },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'medium' } }
    ])
  })

  it('turning thinking back on in a process launched with it off is a relaunch (returns false without sending anything)', async () => {
    const { session, requests } = await start('2.1.280', 'haiku', 'off')
    expect(session.switchRestart).toBe('thinking-on')
    await expect(session.switchSettings?.({ modelId: 'haiku', thinking: 'medium' })).resolves.toBe(false)
    expect(requests()).toEqual([])
    // A model change left at "none" can keep running.
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: 'off' })).resolves.toBe(true)
    expect(requests()).toEqual([{ subtype: 'set_model', model: 'sonnet' }])
  })

  it('stops there and returns false when rejected (the relaunch passes everything again)', async () => {
    const { session, requests } = await start('2.1.280', 'sonnet', 'low', (r) => r['subtype'] !== 'set_model')
    await expect(session.switchSettings?.({ modelId: 'opus', thinking: 'high' })).resolves.toBe(false)
    expect(requests().map((r) => r['subtype'])).toEqual(['set_model'])
    // A failed switch does not change the "setting currently in effect".
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: 'low' })).resolves.toBe(true)
    expect(requests()).toHaveLength(1)
  })

  it('uses always without the path on an unknown version (live-settings false)', async () => {
    const { session, requests } = await start('9.9.9', 'sonnet', 'low')
    expect(session.switchRestart).toBe('always')
    await expect(session.switchSettings?.({ modelId: 'opus', thinking: 'low' })).resolves.toBe(false)
    expect(requests()).toEqual([])
  })

  it('switching to the default (null) cannot be expressed as a control request, so returns false', async () => {
    const { session, requests } = await start('2.1.280', 'sonnet', 'low')
    await expect(session.switchSettings?.({ modelId: null, thinking: 'low' })).resolves.toBe(false)
    await expect(session.switchSettings?.({ modelId: 'sonnet', thinking: null })).resolves.toBe(false)
    expect(requests()).toEqual([])
  })
})

describe('Adapter: initialize command list (gap of item 68 / 95)', () => {
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

  it("remembers the response's commands (names), keeps them in the cache, and returns them from the start of the next launch; an empty list is treated as unknown", async () => {
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

describe('Adapter: real built-in commands (item 117, bundle C)', () => {
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

  it('only the init after a reset is streamed as a new session (no resume mark); the cumulative cost is also recounted from 0', async () => {
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

describe('Adapter: rewind flags and rewind_files (item 113)', () => {
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

  it('on supported versions adds --replay-user-messages, and a fork launch adds --resume-session-at and --fork-session', async () => {
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

  it('bundle conversation (TODO 633 stage 3): only a new launch adds --worktree <name>, and not on resume or with an invalid name', async () => {
    const fresh = await start('2.1.280', { worktreeName: 'fix-a-1b2c' })
    expect(fresh.args[fresh.args.indexOf('--worktree') + 1]).toBe('fix-a-1b2c')
    expect((await start('2.1.280')).args).not.toContain('--worktree')
    expect((await start('2.1.280', { resume: 'sid', worktreeName: 'x' })).args).not.toContain('--worktree')
    expect((await start('2.1.280', { worktreeName: '../evil' })).args).not.toContain('--worktree')
  })

  it('on an unmeasured version (2.1.207) emits no flags and rewindFiles is null (no path)', async () => {
    const { session, args } = await start('2.1.207', { resume: 'sid', at: 'm', fork: true })
    expect(args).not.toContain('--replay-user-messages')
    expect(args).not.toContain('--fork-session')
    expect(args).not.toContain('--resume-session-at')
    expect(await session.rewindFiles?.('u-1', true)).toBeNull()
  })

  it('rewindFiles writes one rewind_files line and converts the dry_run response into the result', async () => {
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

  it('a response with no checkpoint (canRewind: false inside success) is false, and a rejection rejects', async () => {
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
