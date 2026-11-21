/**
 * TODO 1147 (wave 72 bundle D): the bundle of diagnostics for expired auth, and a single retry 30 seconds later.
 *
 * - Adapter: from the auth-expiry line, API retries, and the copy of `auth status --json`, builds one line of `agent.auth.diagnostics`.
 *   **No secret gets in** (the token in the fixture `auth-diagnostics-secrets.jsonl`, and the token / email / org of the fake `auth status`, and the secrets in the keychain output are dropped).
 *   `auth-expired-2.1.310.jsonl` is a real line from item 909 (a synthetic assistant line from a 2.1.310 transcript, only the id replaced).
 * - Keychain: does not pass `-g` / `-w`. It picks up only `mdat` / `cdat`. Not called on non-macOS.
 * - `AuthExpiryWatch`: once it recognizes an expiry it writes the bundle once, and checks again once 30 seconds later (fake timer). If it recovers, the retry is cancelled and
 *   the bundle for the recovery is written.
 *
 * `node:child_process` is replaced, and **neither the CLI, the model, nor `security` is started**.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiosEvent } from '../src/shared/agent.js'
import type { GatewayEndpoint } from '../src/main/session/types.js'
import { setLogSink } from '../src/common/logger.js'

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

/** Secrets and personal information mixed into the fake public subcommand output (they must not appear in the bundle). */
const FAKE_ACCESS = 'sk-ant-oat01-FAKEACCESSFAKEACCESS1147'
const FAKE_EMAIL = 'owner-1147@example.invalid'
const FAKE_ORG = 'Fake Org 1147'

const state = vi.hoisted(() => ({ children: [] as unknown[], loggedIn: true, execCalls: [] as string[][] }))

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
        queueMicrotask(() => callback(null, '2.1.318 (test)\n', ''))
        return
      }
      const stdout = JSON.stringify({
        loggedIn: state.loggedIn,
        authMethod: state.loggedIn ? 'subscription' : 'none',
        apiProvider: 'firstParty',
        loginExpiresAt: '2026-11-04T08:40:00.000Z',
        storedClaudeAiLogin: true,
        email: FAKE_EMAIL,
        orgName: FAKE_ORG,
        orgId: 'org-1147',
        configDirectory: '/Users/someone/.config',
        accessToken: FAKE_ACCESS,
        subscriptionType: 'max'
      })
      queueMicrotask(() => callback(null, stdout, ''))
    }
  )
}))

const { ClaudeCodeAdapter } = await import('../src/main/session/adapter/index.js')
const { loadCompatTable } = await import('../src/main/session/adapter/compat.js')
const { readKeychainMeta } = await import('../src/main/session/adapter/auth-diagnostics.js')
const { AuthExpiryWatch, AUTH_RETRY_DELAY_MS } = await import('../src/main/session/auth-expiry.js')

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

let dir: string
let lines: string[]
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
  state.loggedIn = true
  lines = []
  setLogSink((line) => lines.push(line))
  dir = mkdtempSync(join(tmpdir(), 'aios-auth-diag-'))
})

afterEach(() => {
  setLogSink(null)
  rmSync(dir, { recursive: true, force: true })
})

const diagnosticsLines = (): Record<string, unknown>[] =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['event'] === 'agent.auth.diagnostics')

/** A fake read of the keychain (the real `security` is not called). */
const keychainFound = async () =>
  ({
    state: 'found',
    service: 'item',
    modifiedAt: '2026-11-04T09:41:00Z',
    createdAt: '2026-05-26T00:27:54Z',
    exitCode: 0
  }) as const

async function start(adapter: InstanceType<typeof ClaudeCodeAdapter>): Promise<{ child: FakeChild; events: AiosEvent[] }> {
  const events: AiosEvent[] = []
  await adapter.getStatus()
  await adapter.spawn(
    {
      sessionId: '00000000-0000-4000-8000-000000000002',
      threadId: 't-1147',
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

describe('Adapter — 診断の束 (TODO 1147)', () => {
  it('実物の行 (2.1.310 の転写): 版・auth status の許可した欄・行の種類と長さ・キーチェーンの時刻が 1 行に入る', async () => {
    const adapter = new ClaudeCodeAdapter()
    adapter.keychainReader = keychainFound
    const { child, events } = await start(adapter)
    child.stdout.write(readFileSync(join(__dirname, 'fixtures', 'auth-expired-2.1.310.jsonl'), 'utf8'))
    await flush()
    const result = events.find((e) => e.kind === 'result')
    expect(result?.kind === 'result' && result.payload.authFailed).toBe(true)

    state.loggedIn = false
    await adapter.recheckLogin()
    await adapter.recordAuthDiagnostics('interrupt-auth', { threadId: 't-1147' })
    const [entry] = diagnosticsLines()
    expect(entry).toMatchObject({
      level: 'warn',
      trigger: 'interrupt-auth',
      threadId: 't-1147',
      version: '2.1.318',
      loggedIn: false,
      authParse: 'ok',
      authExitCode: 0,
      auth_loggedIn: false,
      auth_authMethod: 'none',
      auth_apiProvider: 'firstParty',
      auth_loginExpiresAt: '2026-11-04T08:40:00.000Z',
      auth_subscriptionType: 'max',
      errorSource: 'assistant',
      errorValue: 'authentication_failed',
      errorPattern: 'Failed to authenticate',
      errorTextLength: 'Failed to authenticate: OAuth session expired and could not be refreshed'.length,
      errorThreadId: 't-1147',
      keychain: 'found',
      keychainModifiedAt: '2026-11-04T09:41:00Z',
      keychainCreatedAt: '2026-05-26T00:27:54Z'
    })
    // The body is not kept (only the length and kind).
    expect(JSON.stringify(entry)).not.toContain('could not be refreshed')
    // Do not call the CLI anew to write the bundle (only the recheck calls it).
    const authCalls = state.execCalls.filter((args) => !args.includes('--version')).length
    expect(authCalls).toBe(2)
  })

  it('秘密が入らない: 行・stderr・auth status・キーチェーンの出力の token / email / org は落ち、request id と状態コードは残る', async () => {
    const adapter = new ClaudeCodeAdapter()
    adapter.keychainReader = () =>
      readKeychainMeta(loadCompatTable(), {
        platform: 'darwin',
        run: async () => ({
          code: 0,
          // Even if a fake mixes in the shape with `-g`, only the time is picked up.
          stdout: [
            'keychain: "/Users/someone/Library/Keychains/login.keychain-db"',
            'attributes:',
            '    "acct"<blob>="someone"',
            '    "cdat"<timedate>=0x32303236303532363030323735345A00  "20260526002754Z\\000"',
            '    "mdat"<timedate>=0x32303236313130343039343130305A00  "20261104094100Z\\000"',
            `password: "${FAKE_ACCESS}"`
          ].join('\n')
        })
      })
    const { child, events } = await start(adapter)
    child.stderr.write(`refresh failed: Authorization: Bearer ${FAKE_ACCESS} request_id=req_011CgSTDERRFAKE1147bb\n`)
    child.stdout.write(readFileSync(join(__dirname, 'fixtures', 'auth-diagnostics-secrets.jsonl'), 'utf8'))
    await flush()
    expect(events.some((e) => e.kind === 'result' && e.payload.authFailed === true)).toBe(true)

    await adapter.recheckLogin()
    await adapter.recordAuthDiagnostics('interrupt-auth', { threadId: 't-1147' })
    const [entry] = diagnosticsLines()
    const text = JSON.stringify(entry)
    for (const secret of [
      FAKE_ACCESS,
      'sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKE1147',
      'rt-FAKEFAKEFAKEFAKEFAKE1147',
      FAKE_EMAIL,
      FAKE_ORG,
      'org-1147',
      '/Users/someone',
      'someone'
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(entry).toMatchObject({
      retryStatus: 401,
      retryError: 'authentication_failed',
      retryAttempt: 1,
      retryRequestId: 'req_011CgFAKEFAKEFAKE1147aa',
      errorSource: 'assistant',
      // The line has no id, so only the id is taken from the end of stderr.
      errorRequestId: 'req_011CgSTDERRFAKE1147bb',
      keychain: 'found',
      keychainModifiedAt: '2026-11-04T09:41:00Z'
    })
    expect(entry?.['auth_email']).toBeUndefined()
    expect(entry?.['auth_accessToken']).toBeUndefined()
  })

  it('assistant 行の無い版: 失敗の result の文から種類と長さだけを控える', async () => {
    const adapter = new ClaudeCodeAdapter()
    adapter.keychainReader = keychainFound
    const { child } = await start(adapter)
    child.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        duration_ms: 1,
        num_turns: 1,
        result: 'Login expired · Please run /login',
        session_id: '00000000-0000-4000-8000-000000000002',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        permission_denials: []
      })}\n`
    )
    await flush()
    await adapter.recordAuthDiagnostics('login-lost')
    expect(diagnosticsLines()[0]).toMatchObject({
      trigger: 'login-lost',
      threadId: null,
      errorSource: 'result',
      errorPattern: 'Login expired',
      errorTextLength: 'Login expired · Please run /login'.length
    })
  })
})

describe('キーチェーンの属性の読み取り (TODO 1147)', () => {
  const table = loadCompatTable()
  const service = table.authFailure?.diagnostics?.keychainService ?? ''

  it('-g / -w を渡さない。項目名は compat の表から。拾うのは mdat / cdat だけ', async () => {
    const calls: { command: string; args: readonly string[] }[] = []
    const meta = await readKeychainMeta(table, {
      platform: 'darwin',
      run: async (command, args) => {
        calls.push({ command, args })
        return {
          code: 0,
          stdout:
            '    "mdat"<timedate>=0x32303236313130343039343130305A00  "20261104094100Z\\000"\n    "svce"<blob>="x"\n'
        }
      }
    })
    expect(service).not.toBe('')
    expect(calls).toEqual([{ command: '/usr/bin/security', args: ['find-generic-password', '-s', service] }])
    expect(calls[0]?.args).not.toContain('-g')
    expect(calls[0]?.args).not.toContain('-w')
    expect(meta).toEqual({ state: 'found', service, modifiedAt: '2026-11-04T09:41:00Z', createdAt: null, exitCode: 0 })
  })

  it('項目が無い (44)・ほかの失敗・macOS 以外', async () => {
    expect((await readKeychainMeta(table, { platform: 'darwin', run: async () => ({ code: 44, stdout: '' }) })).state).toBe(
      'not-found'
    )
    expect((await readKeychainMeta(table, { platform: 'darwin', run: async () => ({ code: 51, stdout: '' }) }))).toMatchObject({
      state: 'error',
      exitCode: 51
    })
    const run = vi.fn(async () => ({ code: 0, stdout: '' }))
    expect((await readKeychainMeta(table, { platform: 'linux', run })).state).toBe('unsupported')
    expect(run).not.toHaveBeenCalled()
  })

  it('既定の読み手は共用の runCapture を通す (5 秒・64 KiB の上限。第 72 波 review)', async () => {
    const { execFile } = await import('node:child_process')
    const mocked = vi.mocked(execFile)
    mocked.mockClear()
    await readKeychainMeta(table, { platform: 'darwin' })
    expect(mocked).toHaveBeenCalledTimes(1)
    const [command, args, options] = mocked.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(command).toBe('/usr/bin/security')
    expect(args).toEqual(['find-generic-password', '-s', service])
    expect(options).toEqual({ timeout: 5_000, maxBuffer: 64 * 1024 })
  })
})

describe('AuthExpiryWatch — 30 秒後に 1 回だけ打ち直す (TODO 1147)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function watch(loggedInAtRetry: () => boolean) {
    const recheck = vi.fn(async () => loggedInAtRetry())
    const diagnose = vi.fn(async () => undefined)
    return { recheck, diagnose, watch: new AuthExpiryWatch({ recheck, diagnose }) }
  }

  it('束は 1 回、確かめ直しは 30 秒後に 1 回だけ。戻らなければ打ち直しの後の束をもう 1 行', async () => {
    const { recheck, diagnose, watch: w } = watch(() => false)
    w.noteExpired('interrupt-auth', 't1')
    w.noteExpired('interrupt-auth', 't2')
    w.noteExpired('login-lost')
    expect(diagnose).toHaveBeenCalledTimes(1)
    expect(diagnose).toHaveBeenLastCalledWith('interrupt-auth', 't1')
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS - 1)
    expect(recheck).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(diagnose).toHaveBeenCalledTimes(2)
    expect(diagnose).toHaveBeenLastCalledWith('retry-failed', null)
    await vi.advanceTimersByTimeAsync(10 * AUTH_RETRY_DELAY_MS)
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('打ち直しを待っている間に戻ったら打ち直しは取り消す。stop の後は何もしない', async () => {
    const { recheck, diagnose, watch: w } = watch(() => true)
    w.noteExpired('login-lost')
    w.noteRestored()
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS * 2)
    expect(recheck).not.toHaveBeenCalled()
    expect(diagnose.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['login-lost', 'login-restored'])

    w.noteExpired('interrupt-auth', 't1')
    expect(vi.getTimerCount()).toBe(1)
    w.stop()
    expect(vi.getTimerCount()).toBe(0)
    w.noteExpired('interrupt-auth', 't2')
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS * 2)
    expect(recheck).not.toHaveBeenCalled()
  })

  it('起動時の未ログインは束だけ (打ち直さない)。失効を見分けていなければ戻ったときの束も書かない', async () => {
    const { recheck, diagnose, watch: w } = watch(() => true)
    w.noteRestored()
    expect(diagnose).not.toHaveBeenCalled()
    w.noteLoggedOutAtStart()
    expect(vi.getTimerCount()).toBe(0)
    w.noteRestored()
    expect(diagnose.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['logged-out-at-start', 'login-restored'])
    expect(recheck).not.toHaveBeenCalled()
  })

  const retryResults = (): unknown[] =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['event'] === 'agent.auth.retry')
      .map((entry) => entry['result'])

  it('確かめ直しが走らなかった (throw) なら recheck-failed — retry-failed の束は書かない (第 72 波 review)', async () => {
    const recheck = vi.fn(async (): Promise<boolean> => {
      throw new Error('spawn ENOENT')
    })
    const diagnose = vi.fn(async () => undefined)
    const w = new AuthExpiryWatch({ recheck, diagnose })
    w.noteExpired('interrupt-auth', 't1')
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(diagnose.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['interrupt-auth'])
    expect(retryResults()).toEqual(['recheck-failed'])
    expect(w.isPending()).toBe(false)
    // The expiry mark remains: a real false -> true writes login-restored.
    w.noteRestored()
    expect(diagnose.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['interrupt-auth', 'login-restored'])
  })

  it('失効の後も真のまま (偽 → 真を見ていない) なら unchanged。印を解き、後の無関係な偽 → 真で login-restored を書かない', async () => {
    const { recheck, diagnose, watch: w } = watch(() => true)
    w.noteExpired('interrupt-auth', 't1')
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(retryResults()).toEqual(['unchanged'])
    w.noteRestored()
    expect(diagnose.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['interrupt-auth'])
  })

  it('打ち直しの確かめ直しの配信で偽 → 真を見たなら recovered。retry-failed は書かず、login-restored を 1 回', async () => {
    const diagnose = vi.fn(async () => undefined)
    let w: InstanceType<typeof AuthExpiryWatch> | null = null
    const recheck = vi.fn(async () => {
      w?.noteRestored() // SessionManager.recheckLogin resolves after it publishes (publishStatus).
      return true
    })
    w = new AuthExpiryWatch({ recheck, diagnose })
    w.noteExpired('login-lost')
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(retryResults()).toEqual(['recovered'])
    w.noteRestored()
    expect(diagnose.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['login-lost', 'login-restored'])
  })
})
