/**
 * The Adapter's breakdown of context usage (item 155, ARCHITECTURE.md 4.5.1 / 4.6.2 (11)).
 *
 * `node:child_process` is replaced, and **neither the CLI nor the model is started** (the fake is a copy of the one in `adapter-plan.test.ts`).
 * The response body is the real one from spike 26 (`test/fixtures/context-usage-response.json`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GatewayEndpoint } from '../src/main/session/types.js'
import fixture from './fixtures/context-usage-response.json'

/** The body of the response the child returns (the real one by default). */
let body: unknown = fixture.response.response

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

  constructor() {
    super()
    this.stdin = new Writable({
      highWaterMark: 16,
      write: (chunk: Buffer, _encoding, callback) => {
        const text = chunk.toString('utf8')
        this.written.push(text)
        for (const line of text.split('\n')) if (line !== '') this.onLine?.(line)
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
const { ClaudeCodeAdapter } = await import('../src/main/session/adapter/index.js')
const { spawn: spawnProcess } = await import('node:child_process')

const children = (): FakeChild[] => state.children as FakeChild[]

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

type Written = { type: string; request_id?: string; request?: Record<string, unknown> }

/** Starts a child that answers control requests other than initialize with the `reply` answer, and returns it. */
async function start(
  version: string,
  planMode: boolean,
  reply: (request: Record<string, unknown>) => boolean = () => true
): Promise<{
  child: FakeChild
  session: Awaited<ReturnType<InstanceType<typeof ClaudeCodeAdapter>['spawn']>>
  requests: () => Record<string, unknown>[]
  args: readonly string[]
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
      modelId: null,
      thinking: null,
      ...(planMode ? { planMode: true } : {}),
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
      ? { subtype: 'success', request_id: message.request_id, response: body }
      : { subtype: 'error', request_id: message.request_id, error: 'Unsupported control request subtype' }
    setImmediate(() => child.stdout.write(`${JSON.stringify({ type: 'control_response', response })}\n`))
  }
  const requests = (): Record<string, unknown>[] =>
    child.written
      .map((w) => JSON.parse(w) as Written)
      .filter((w) => w.type === 'control_request' && w.request?.['subtype'] !== 'initialize')
      .map((w) => w.request ?? {})
  const args = (vi.mocked(spawnProcess).mock.calls.at(-1)?.[1] ?? []) as readonly string[]
  return { child, session, requests, args }
}

afterEach(() => {
  state.version = '9.9.9'
  body = fixture.response.response
})

describe('Adapter: context usage breakdown (item 155)', () => {
  it('sends get_context_usage with detail: full and converts the real response to a neutral shape (does not stop the process)', async () => {
    const { child, session, requests } = await start('2.1.280', false)
    const usage = await session.contextUsage?.()
    expect(requests()).toEqual([{ subtype: 'get_context_usage', detail: 'full' }])
    expect(child.kill).not.toHaveBeenCalled()
    expect(usage).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      totalTokens: 28845,
      maxTokens: 200000,
      percentage: 14,
      memoryFiles: [{ path: '/Users/tester/project/CLAUDE.md', type: 'Project', tokens: 26 }]
    })
    expect(usage?.categories.map((c) => [c.name, c.kind, c.tone])).toEqual([
      ['System prompt', 'used', 'system'],
      ['System tools', 'used', 'tools'],
      ['MCP tools (deferred)', 'deferred', null],
      ['System tools (deferred)', 'deferred', null],
      ['Memory files', 'used', 'memory'],
      ['Skills', 'used', 'skills'],
      ['Messages', 'used', 'messages'],
      ['Free space', 'free', null]
    ])
  })

  it('returns null on rejection (unsupported version) and does not throw', async () => {
    const { session } = await start('2.1.280', false, () => false)
    await expect(session.contextUsage?.()).resolves.toBeNull()
  })

  it('returns null for an unreadable response (no total or window)', async () => {
    body = { categories: [] }
    const { session } = await start('2.1.280', false)
    await expect(session.contextUsage?.()).resolves.toBeNull()
  })
})
