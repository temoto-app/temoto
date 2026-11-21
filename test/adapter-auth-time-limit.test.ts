/**
 * TODO 1282 (wave 95 bundle A): the Adapter's side of the re-login flow.
 *
 * - The newer message ("this login reached its time limit and cannot be renewed", CLI 2.1.329) is recognized as an auth failure of
 *   the kind that a fresh login fixes (`authFailureKind: 'login'`). `test/fixtures/auth-expired-2.1.329.jsonl` takes the shape of the
 *   real 2.1.310 lines (item 909) with the message text of a real 2.1.329 transcript line (only ids replaced).
 * - A rejected credential ("Invalid API key · Fix external API key", the form seen for real) is `credential`: signing in again does
 *   not fix it (constraint 3). Other "Invalid API key" forms (one asking for a fresh login has not been seen) stay `login`.
 * - The unattended-run guidance is only words from the compat table: nothing is spawned for it.
 *
 * `node:child_process` is replaced, and **neither the CLI nor the model is started**.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiosEvent } from '../src/shared/agent.js'
import type { GatewayEndpoint } from '../src/main/session/types.js'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  readonly kill = vi.fn((signal?: string) => {
    setImmediate(() => this.emit('close', null, signal ?? 'SIGTERM'))
    return true
  })

  constructor() {
    super()
    this.stdin = new Writable({ write: (_chunk: Buffer, _encoding, callback) => callback() })
  }
}

const state = vi.hoisted(() => ({ children: [] as unknown[], execCalls: [] as string[][] }))

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
      state.execCalls.push([...args])
      if (args.includes('--version')) {
        queueMicrotask(() => callback(null, '9.9.9 (test)\n', ''))
        return
      }
      queueMicrotask(() => callback(null, JSON.stringify({ loggedIn: true, authMethod: 'test' }), ''))
    }
  )
}))

const { ClaudeCodeAdapter } = await import('../src/main/session/adapter/index.js')

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
  state.execCalls.length = 0
  dir = mkdtempSync(join(tmpdir(), 'aios-adapter-time-limit-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function start(): Promise<{ child: FakeChild; events: AiosEvent[] }> {
  const adapter = new ClaudeCodeAdapter()
  const events: AiosEvent[] = []
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
      gateway: gateway()
    },
    { onEvent: (event) => events.push(event), onExit: () => undefined }
  )
  await flush()
  const child = state.children.at(-1) as FakeChild | undefined
  if (child === undefined) throw new Error('no child')
  return { child, events }
}

const resultOf = (events: readonly AiosEvent[]) => {
  const result = events.find((e) => e.kind === 'result')
  if (result === undefined || result.kind !== 'result') throw new Error('no result')
  return result.payload
}

const failedResult = (text: string): string =>
  `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    duration_ms: 1,
    num_turns: 1,
    result: text,
    session_id: '00000000-0000-4000-8000-000000000003',
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    permission_denials: []
  })}\n`

describe('Adapter: the unrenewable login and other auth failures (TODO 1282)', () => {
  it('fixture 2.1.329: "reached its time limit and cannot be renewed" is an auth failure that a fresh login fixes', async () => {
    const { child, events } = await start()
    child.stdout.write(readFileSync(join(__dirname, 'fixtures', 'auth-expired-2.1.329.jsonl'), 'utf8'))
    await flush()
    const payload = resultOf(events)
    expect(payload.authFailed).toBe(true)
    expect(payload.authFailureKind).toBe('login')
  })

  it('the same message on a failed result alone (no assistant line) is caught by the table too', async () => {
    const { child, events } = await start()
    child.stdout.write(
      failedResult(
        'Failed to authenticate: this login reached its time limit and cannot be renewed. Run `x auth login` to sign in again'
      )
    )
    await flush()
    expect(resultOf(events)).toMatchObject({ authFailed: true, authFailureKind: 'login' })
  })

  it('a rejected credential (Invalid API key) is the credential kind: no login is offered for it', async () => {
    const { child, events } = await start()
    child.stdout.write(failedResult('Invalid API key · Fix external API key'))
    await flush()
    expect(resultOf(events)).toMatchObject({ authFailed: true, authFailureKind: 'credential' })
  })

  it('an invalid key that asks for a fresh login (not seen for real) stays the login kind, so the Log in button works (review)', async () => {
    for (const text of ['Invalid API key · Please run /login', 'Invalid API key']) {
      const { child, events } = await start()
      child.stdout.write(failedResult(text))
      await flush()
      expect(resultOf(events)).toMatchObject({ authFailed: true, authFailureKind: 'login' })
    }
  })

  it('a turn that is not an auth failure carries no kind', async () => {
    const { child, events } = await start()
    child.stdout.write(failedResult('API Error: 500 Internal server error'))
    await flush()
    const payload = resultOf(events)
    expect(payload.authFailed).toBeUndefined()
    expect(payload.authFailureKind).toBeUndefined()
  })

  it('the unattended guidance is words from the table only: nothing is started for it', async () => {
    const adapter = new ClaudeCodeAdapter()
    const before = { exec: state.execCalls.length, spawn: state.children.length }
    const guide = adapter.unattendedLoginGuide()
    expect(guide).not.toBeNull()
    expect(guide?.setupCommand.endsWith(' setup-token')).toBe(true)
    expect(guide?.tokenEnv).toMatch(/^[A-Z][A-Z0-9_]+$/)
    expect(state.execCalls.length).toBe(before.exec)
    expect(state.children.length).toBe(before.spawn)
  })
})
