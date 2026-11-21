/**
 * The Adapter's Plan mode (item 112, ARCHITECTURE.md 4.2.3) and reading the diff of the approval frame (item 97, 7.6.4).
 *
 * `node:child_process` is replaced, and **neither the CLI nor the model is started** (the fake is the same shape as in `adapter-process.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      ? { subtype: 'success', request_id: message.request_id, response: { mode: message.request?.['mode'] } }
      : { subtype: 'error', request_id: message.request_id, error: 'no' }
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
})

describe('Adapter — Plan モード (項目 112)', () => {
  it('起動フラグ: ON なら --permission-mode plan、OFF なら manual のまま', async () => {
    const on = await start('2.1.280', true)
    expect(on.args[on.args.indexOf('--permission-mode') + 1]).toBe('plan')
    const off = await start('2.1.280', false)
    expect(off.args[off.args.indexOf('--permission-mode') + 1]).toBe('manual')
  })

  it('走ったまま入れる / 外す: set_permission_mode に plan / manual を送り、プロセスは止めない (spike 22)', async () => {
    const { child, session, requests } = await start('2.1.280', false)
    await expect(session.setPlanMode?.(true)).resolves.toBe(true)
    await expect(session.setPlanMode?.(false)).resolves.toBe(true)
    expect(requests()).toEqual([
      { subtype: 'set_permission_mode', mode: 'plan' },
      { subtype: 'set_permission_mode', mode: 'manual' }
    ])
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('拒否されたら false (呼び出し側が起こし直す)', async () => {
    const { session } = await start('2.1.280', false, () => false)
    await expect(session.setPlanMode?.(true)).resolves.toBe(false)
  })

  it('live-settings の無い版 (2.1.207) は何も送らずに false', async () => {
    const { session, requests } = await start('2.1.207', false)
    await expect(session.setPlanMode?.(true)).resolves.toBe(false)
    expect(requests()).toEqual([])
  })

  it('計画の提示と diff を出せる書き込みは表から読む (制約 6)', async () => {
    const adapter = new ClaudeCodeAdapter()
    expect(adapter.supportsPlanMode()).toBe(true)
    expect(adapter.planProposal('ExitPlanMode', { plan: '# Plan', planFilePath: '/x.md' })).toBe('# Plan')
    expect(adapter.planProposal('Write', { plan: '# Plan' })).toBeNull()
    expect(adapter.writePreview('Write', { file_path: '/a.txt', content: 'x' })).toEqual({
      path: '/a.txt',
      change: { kind: 'overwrite', content: 'x' }
    })
    expect(adapter.writePreview('Read', { file_path: '/a.txt' })).toBeNull()
  })
})
