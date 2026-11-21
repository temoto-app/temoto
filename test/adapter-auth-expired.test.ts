/**
 * TODO 893 (wave 47 bundle D): whether the Adapter recognizes the CLI's auth expiry (`Failed to authenticate: OAuth session expired and could not be refreshed`) and sets `result.authFailed`, and the login-state-only recheck (`recheckLogin`).
 *
 * The lines are in `test/fixtures/auth-expired.jsonl` (built from the shape of CLI 2.1.303's synthetic responses: an assistant line with
 * `error: "authentication_failed"`, and a failed result). `node:child_process` is replaced, and **neither the CLI nor the model is started**.
 * The login state is changed only through fake output of the public subcommands (the credential file is not read, constraint 2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiosEvent } from '../src/shared/agent.js'
import type { AgentSession, GatewayEndpoint } from '../src/main/session/types.js'

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
    this.stdin = new Writable({
      write: (_chunk: Buffer, _encoding, callback) => callback()
    })
  }
}

const state = vi.hoisted(() => ({ children: [] as unknown[], loggedIn: true, authCalls: 0, authMethod: 'test' }))

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
      if (args.includes('--version')) {
        queueMicrotask(() => callback(null, '9.9.9 (test)\n', ''))
        return
      }
      state.authCalls += 1
      // The real output while logged out is `authMethod: "none"` (spikes/RESULTS.md, item 12).
      const stdout = JSON.stringify({
        loggedIn: state.loggedIn,
        authMethod: state.loggedIn ? state.authMethod : 'none',
        subscriptionType: null
      })
      queueMicrotask(() => callback(null, stdout, ''))
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
  state.loggedIn = true
  state.authCalls = 0
  state.authMethod = 'test'
  dir = mkdtempSync(join(tmpdir(), 'aios-adapter-auth-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function start(
  adapter: InstanceType<typeof ClaudeCodeAdapter>
): Promise<{ child: FakeChild; events: AiosEvent[]; session: AgentSession }> {
  const events: AiosEvent[] = []
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
      gateway: gateway()
    },
    { onEvent: (event) => events.push(event), onExit: () => undefined }
  )
  await flush()
  const child = state.children.at(-1) as FakeChild | undefined
  if (child === undefined) throw new Error('no child')
  return { child, events, session }
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`
const resultOf = (events: readonly AiosEvent[]) => {
  const result = events.find((e) => e.kind === 'result')
  if (result === undefined || result.kind !== 'result') throw new Error('no result')
  return result.payload
}

const failedResult = (text: string, isError = true): Record<string, unknown> => ({
  type: 'result',
  subtype: 'success',
  is_error: isError,
  duration_ms: 1,
  num_turns: 1,
  result: text,
  session_id: '00000000-0000-4000-8000-000000000001',
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  permission_denials: []
})

describe('Adapter — 認証切れの見分け (TODO 893)', () => {
  it('fixture: assistant 行の error 欄と失敗の result から authFailed を付ける', async () => {
    const { child, events } = await start(new ClaudeCodeAdapter())
    child.stdout.write(readFileSync(join(__dirname, 'fixtures', 'auth-expired.jsonl'), 'utf8'))
    await flush()
    const payload = resultOf(events)
    expect(payload.ok).toBe(false)
    expect(payload.authFailed).toBe(true)
    // The synthetic response text still flows through as the body (the failure line remains).
    expect(events.some((e) => e.kind === 'assistant_text')).toBe(true)
  })

  it('assistant 行が無くても、失敗の result の文 (API キー・ログインの期限切れ) で拾う', async () => {
    const { child, events } = await start(new ClaudeCodeAdapter())
    child.stdout.write(line(failedResult('Login expired · Please run /login')))
    await flush()
    expect(resultOf(events).authFailed).toBe(true)
  })

  it('ほかの失敗や、成功の応答の文中の言及では付けない。次のターンにも持ち越さない', async () => {
    const { child, events } = await start(new ClaudeCodeAdapter())
    child.stdout.write(line(failedResult('API Error: 500 Internal server error')))
    child.stdout.write(line(failedResult('Failed to authenticate は CLI の文言です', false)))
    await flush()
    const results = events.filter((e) => e.kind === 'result')
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.kind === 'result' && result.payload.authFailed).toBeFalsy()
    }
  })

  it('モデルの応答が「Invalid API key」等に触れていても、別の失敗なら付けない (1 行・短い文の頭だけを見る — code-review)', async () => {
    const { child, events } = await start(new ClaudeCodeAdapter())
    child.stdout.write(line(failedResult('Invalid API key のエラーは、環境変数を見直すと直ります。\n\n手順は次のとおり…')))
    child.stdout.write(line(failedResult('The script printed "Not logged in" and "Login expired" before it crashed.')))
    child.stdout.write(line(failedResult(`Invalid API key ${'x'.repeat(400)}`)))
    await flush()
    const results = events.filter((e) => e.kind === 'result')
    expect(results).toHaveLength(3)
    for (const result of results) {
      expect(result.kind === 'result' && result.payload.authFailed).toBeFalsy()
    }
  })

  it('古い版の 401 の文 (API Error: 401 …) は拾う', async () => {
    const { child, events } = await start(new ClaudeCodeAdapter())
    child.stdout.write(
      line(
        failedResult(
          'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}'
        )
      )
    )
    await flush()
    expect(resultOf(events).authFailed).toBe(true)
  })

  describe('印は result 無しで終わったターンから次のターンへ持ち越さない (code-review)', () => {
    const authLine = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate' }] },
      parent_tool_use_id: null,
      error: 'authentication_failed'
    }
    const init = {
      type: 'system',
      subtype: 'init',
      session_id: '00000000-0000-4000-8000-000000000001',
      tools: [],
      mcp_servers: [],
      model: 'test-model'
    }

    it('同じターンの result には付く', async () => {
      const { child, events } = await start(new ClaudeCodeAdapter())
      child.stdout.write(line(authLine))
      child.stdout.write(line(failedResult('API Error: 500')))
      await flush()
      expect(resultOf(events).authFailed).toBe(true)
    })

    it('次の入力を送ると捨てる', async () => {
      const { child, events, session } = await start(new ClaudeCodeAdapter())
      child.stdout.write(line(authLine))
      await flush()
      session.send({ text: 'next' })
      child.stdout.write(line(failedResult('API Error: 500')))
      await flush()
      expect(resultOf(events).authFailed).toBeFalsy()
    })

    it('次のターンの init で捨てる', async () => {
      const { child, events } = await start(new ClaudeCodeAdapter())
      child.stdout.write(line(init))
      child.stdout.write(line(authLine))
      child.stdout.write(line(init))
      child.stdout.write(line(failedResult('API Error: 500')))
      await flush()
      expect(resultOf(events).authFailed).toBeFalsy()
    })

    it('中断すると捨てる', async () => {
      const { child, events, session } = await start(new ClaudeCodeAdapter())
      child.stdout.write(line(authLine))
      await flush()
      // No response arrives (timeout), but the mark was already discarded when it was written.
      void session.interrupt?.().catch(() => undefined)
      await flush()
      child.stdout.write(line(failedResult('API Error: 500')))
      await flush()
      expect(resultOf(events).authFailed).toBeFalsy()
      // Do not leave the timer for the pending control request behind.
      child.emit('close', 0, null)
    })
  })

  it('子エージェントの assistant 行の error 欄は親のターンの印にしない', async () => {
    const { child, events } = await start(new ClaudeCodeAdapter())
    child.stdout.write(
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        parent_tool_use_id: 'toolu_1',
        error: 'authentication_failed'
      })
    )
    child.stdout.write(line(failedResult('API Error: 500')))
    await flush()
    expect(resultOf(events).authFailed).toBeFalsy()
  })
})

describe('Adapter — ログイン状態だけの確かめ直し (TODO 893)', () => {
  it('公開サブコマンドを 1 回呼び、loggedIn と案内の符丁だけを差し替える (版・機能表はそのまま)', async () => {
    const adapter = new ClaudeCodeAdapter()
    const first = await adapter.getStatus()
    expect(first.loggedIn).toBe(true)
    const calls = state.authCalls

    state.loggedIn = false
    const expired = await adapter.recheckLogin()
    expect(state.authCalls).toBe(calls + 1)
    expect(expired.loggedIn).toBe(false)
    expect(expired.messageCode).toBe('agent-not-logged-in')
    expect(expired.version).toBe(first.version)
    expect(expired.features).toEqual(first.features)
    // It also shows in local state (matches the "not logged in" in the settings screen and the Sidebar).
    expect((await adapter.getStatus()).loggedIn).toBe(false)

    state.loggedIn = true
    // Do not call again within 2 seconds after it finished (throttle).
    expect((await adapter.recheckLogin()).loggedIn).toBe(false)
    expect(state.authCalls).toBe(calls + 1)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 2_500)
    try {
      const back = await adapter.recheckLogin()
      expect(state.authCalls).toBe(calls + 2)
      expect(back.loggedIn).toBe(true)
      expect(back.messageCode).toBeNull()
    } finally {
      clock.mockRestore()
    }
  })

  it('同時の呼び出しは 1 回の公開サブコマンドにまとめる (code-review)', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    const calls = state.authCalls
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
    try {
      const results = await Promise.all([adapter.recheckLogin(), adapter.recheckLogin(), adapter.recheckLogin()])
      expect(state.authCalls).toBe(calls + 1)
      expect(new Set(results).size).toBe(1)
    } finally {
      clock.mockRestore()
    }
  })
})

describe('Adapter — ログインの 1 行と API キーの見分け (TODO 960 の review)', () => {
  async function logOut(adapter: InstanceType<typeof ClaudeCodeAdapter>): Promise<void> {
    state.loggedIn = false
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
    try {
      expect((await adapter.recheckLogin()).loggedIn).toBe(false)
    } finally {
      clock.mockRestore()
    }
  }

  it('ログイン中に API キーと分かったら、ログアウト中 (none) の応答の後も断る', async () => {
    state.authMethod = 'api_key'
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    expect(adapter.loginCommand()).toEqual({ kind: 'api-key' })
    await logOut(adapter)
    expect(adapter.loginCommand()).toEqual({ kind: 'api-key' })
  })

  it('購読・分からない方式・token を含む方式はログインを走らせる', async () => {
    for (const method of ['claude.ai', 'oauth_token', 'something-new']) {
      state.loggedIn = true
      state.authMethod = method
      const adapter = new ClaudeCodeAdapter()
      await adapter.getStatus()
      expect(adapter.loginCommand()).toMatchObject({ kind: 'ok' })
      await logOut(adapter)
      expect(adapter.loginCommand()).toMatchObject({ kind: 'ok' })
    }
  })
})
