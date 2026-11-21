/**
 * The Adapter's OS sandbox (TODO 1106, ARCHITECTURE 4.2.4). Building the `--settings` JSON, how `--add-dir` is narrowed (spike 38), refusal on versions that cannot use it,
 * degradation when the sandbox did not start at launch, and telling apart a request to run outside the sandbox.
 *
 * `node:child_process` is replaced, and **neither the CLI nor the model is started** (the fake is the same shape as in `adapter-plan.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GatewayEndpoint, SpawnOptions } from '../src/main/session/types.js'
import type { AiosEvent } from '../src/shared/agent.js'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() })
  readonly kill = vi.fn((signal?: string) => {
    setImmediate(() => this.emit('close', null, signal ?? 'SIGTERM'))
    return true
  })
}

const state = vi.hoisted(() => ({ children: [] as unknown[], version: '2.1.317' }))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new FakeChild()
    state.children.push(child)
    return child
  }),
  execFile: vi.fn(
    (_command: string, args: readonly string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
      const stdout = args.includes('--version')
        ? `${state.version} (test)\n`
        : JSON.stringify({ loggedIn: true, authMethod: 'test', subscriptionType: null })
      queueMicrotask(() => callback(null, stdout, ''))
    }
  )
}))

const { ClaudeCodeAdapter } = await import('../src/main/session/adapter/index.js')
const { spawn: spawnProcess } = await import('node:child_process')
const { sandboxLaunch, isUnsandboxedRequest, isSandboxUnavailableText } = await import('../src/main/session/adapter/os-sandbox.js')
const { loadCompatTable } = await import('../src/main/session/adapter/compat.js')

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
  state.version = '2.1.317'
  vi.mocked(spawnProcess).mockClear()
  dir = mkdtempSync(join(tmpdir(), 'aios-sandbox-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const POLICY = { allowedDomains: ['registry.npmjs.org', '*.github.com'], allowWrite: ['~/.npm'] }

function options(extra: Partial<SpawnOptions>): SpawnOptions {
  return {
    sessionId: '00000000-0000-4000-8000-000000000001',
    threadId: 't',
    cwd: '/Users/tester/git/app',
    allowedDirs: ['/Users/tester/git', '/Users/tester/Documents', '/Users/tester/git/app', '/Users/tester/git/app/vendor'],
    resumeBackendSessionId: null,
    modelId: null,
    thinking: null,
    gateway: gateway(),
    ...extra
  }
}

const lastArgs = (): readonly string[] => (vi.mocked(spawnProcess).mock.calls.at(-1)?.[1] ?? []) as readonly string[]
const addDirsOf = (args: readonly string[]): string[] =>
  args.flatMap((arg, i) => (arg === '--add-dir' ? [args[i + 1] as string] : []))

describe('Adapter — OS の sandbox の起動 (TODO 1106)', () => {
  it('--settings に sandbox の JSON を 1 つ渡す。必須の 2 つ (関門を残す・sandbox の外へ抜けない) と許可表', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    expect(adapter.supports('os-sandbox')).toBe(true)
    await adapter.spawn(options({ osSandbox: POLICY }), { onEvent: () => undefined, onExit: () => undefined })
    const args = lastArgs()
    const at = args.indexOf('--settings')
    expect(at).toBeGreaterThan(0)
    expect(args.filter((arg) => arg === '--settings')).toHaveLength(1)
    // The flag for where settings come from is still not passed (constraint 7).
    expect(args).not.toContain('--setting-sources')
    expect(JSON.parse(args[at + 1] as string)).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        network: { strictAllowlist: true, allowedDomains: ['registry.npmjs.org', '*.github.com'] },
        // spike 38: the reference scope including cwd (~/git) cannot go into denyWrite (cwd could no longer be written at all), so it is left out of --add-dir,
        // and what is inside cwd (vendor) is writable anyway. The rest (~/Documents) goes back to read-only.
        filesystem: { allowWrite: ['~/.npm'], denyWrite: ['/Users/tester/Documents'] }
      }
    })
    expect(addDirsOf(args)).toEqual(['/Users/tester/Documents', '/Users/tester/git/app/vendor'])
  })

  it('sandbox を頼まれていなければ --settings は無く、参照範囲はそのまま', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(options({}), { onEvent: () => undefined, onExit: () => undefined })
    expect(lastArgs()).not.toContain('--settings')
    expect(addDirsOf(lastArgs())).toEqual(options({}).allowedDirs)
  })

  it('機能の無い版 (2.1.296) では sandbox を頼まれても起こさない (sandbox 無しで走らせない)', async () => {
    state.version = '2.1.296'
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    expect(adapter.supports('os-sandbox')).toBe(false)
    await expect(
      adapter.spawn(options({ osSandbox: POLICY }), { onEvent: () => undefined, onExit: () => undefined })
    ).rejects.toThrow(/os-sandbox-blocked/)
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('起動が init の前に「sandbox が起きない」で終わったら機能を外して理由を出し、購読者に知らせる', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    const changed = vi.fn()
    adapter.onModelsChanged(changed)
    const events: AiosEvent[] = []
    const exited = new Promise<void>((resolve) => {
      void adapter.spawn(options({ osSandbox: POLICY }), {
        onEvent: (event) => events.push(event),
        onExit: () => resolve()
      })
    })
    await vi.waitFor(() => expect(state.children).toHaveLength(1))
    const child = state.children[0] as FakeChild
    child.stderr.write('Error: sandbox required but unavailable: bubblewrap is not installed\n')
    await new Promise((resolve) => setImmediate(resolve))
    child.emit('close', 1, null)
    await exited
    expect(events.some((event) => event.kind === 'error')).toBe(true)
    const status = await adapter.getStatus()
    expect(status.features['os-sandbox']).toBe(false)
    expect(status.degradations.find((entry) => entry.feature === 'os-sandbox')?.code).toMatch(/os-sandbox-failed/)
    expect(changed).toHaveBeenCalled()
    // From then on, do not wake it even when asked.
    await expect(
      adapter.spawn(options({ osSandbox: POLICY }), { onEvent: () => undefined, onExit: () => undefined })
    ).rejects.toThrow(/os-sandbox-blocked/)
  })

  it('init の前に別の理由で終わっても sandbox は外さない', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    const exited = new Promise<void>((resolve) => {
      void adapter.spawn(options({ osSandbox: POLICY }), { onEvent: () => undefined, onExit: () => resolve() })
    })
    await vi.waitFor(() => expect(state.children).toHaveLength(1))
    const child = state.children[0] as FakeChild
    child.stderr.write('Error: unknown option --foo\n')
    await new Promise((resolve) => setImmediate(resolve))
    child.emit('close', 1, null)
    await exited
    expect((await adapter.getStatus()).features['os-sandbox']).toBe(true)
  })

  it('「sandbox が起きない」の文の後に長い診断が続いても (末尾 500 文字の外でも) 見つけて機能を外す', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    const exited = new Promise<void>((resolve) => {
      void adapter.spawn(options({ osSandbox: POLICY }), { onEvent: () => undefined, onExit: () => resolve() })
    })
    await vi.waitFor(() => expect(state.children).toHaveLength(1))
    const child = state.children[0] as FakeChild
    child.stderr.write('Error: sandbox required but unavailable: bubblewrap is not installed\n')
    child.stderr.write(`${'  at some.frame (file.js:1:1)\n'.repeat(60)}`)
    await new Promise((resolve) => setImmediate(resolve))
    child.emit('close', 1, null)
    await exited
    expect((await adapter.getStatus()).features['os-sandbox']).toBe(false)
  })

  it('sandbox の外で走らせる要求はシェルの道具の印で見分ける (表の語、制約 6)', () => {
    const adapter = new ClaudeCodeAdapter()
    expect(adapter.unsandboxedRequest('Bash', { command: 'touch ~/x', dangerouslyDisableSandbox: true })).toBe(true)
    expect(adapter.unsandboxedRequest('Bash', { command: 'touch ~/x', dangerouslyDisableSandbox: false })).toBe(false)
    expect(adapter.unsandboxedRequest('Bash', { command: 'ls' })).toBe(false)
    expect(adapter.unsandboxedRequest('Write', { dangerouslyDisableSandbox: true })).toBe(false)
  })
})

describe('sandboxLaunch (spike 38 の絞り方)', () => {
  const table = loadCompatTable().osSandbox
  if (table === undefined) throw new Error('compat table has no osSandbox')
  const home = homedir()

  it('cwd・書ける場所を含む参照範囲は --add-dir から外し、その中のものは触らず、残りを読み取り専用に戻す', () => {
    const launch = sandboxLaunch(
      table,
      { allowedDomains: [], allowWrite: ['~/Documents/build', '/opt/out'] },
      join(home, 'git/app'),
      [join(home, 'git'), join(home, 'Documents'), join(home, 'Desktop'), '/opt/out/cache', join(home, 'git/app/sub')],
      home
    )
    expect(launch.addDirs).toEqual([join(home, 'Desktop'), '/opt/out/cache', join(home, 'git/app/sub')])
    expect(launch.denyWrite).toEqual([join(home, 'Desktop')])
    const sandbox = (JSON.parse(launch.settingsJson) as { sandbox: { filesystem: unknown; network: unknown } }).sandbox
    expect(sandbox.filesystem).toEqual({ allowWrite: ['~/Documents/build', '/opt/out'], denyWrite: [join(home, 'Desktop')] })
    expect(sandbox.network).toEqual({ strictAllowlist: true, allowedDomains: [] })
  })

  it('読み取り専用に戻すものが無ければ denyWrite の鍵を置かない。名前の前方一致では「中」と見なさない', () => {
    const launch = sandboxLaunch(table, { allowedDomains: ['a.example'], allowWrite: [] }, '/w/app', ['/w/app2', '/w/app'], home)
    expect(launch.addDirs).toEqual(['/w/app2'])
    expect(launch.denyWrite).toEqual(['/w/app2'])
    const none = sandboxLaunch(table, { allowedDomains: [], allowWrite: [] }, '/w/app', ['/w/app'], home)
    expect(JSON.parse(none.settingsJson)).toMatchObject({ sandbox: { filesystem: { allowWrite: [] } } })
    expect((JSON.parse(none.settingsJson) as { sandbox: { filesystem: Record<string, unknown> } }).sandbox.filesystem).not.toHaveProperty('denyWrite')
  })

  it('表の template を書き換えない (起動ごとに写す)', () => {
    sandboxLaunch(table, { allowedDomains: ['x.example'], allowWrite: [] }, '/w', ['/v'], home)
    expect(table.template).not.toHaveProperty('filesystem')
    expect(table.template['network']).toEqual({ strictAllowlist: true })
  })

  it('印と診断文の見分け', () => {
    expect(isUnsandboxedRequest(table, ['Bash'], 'Bash', { dangerouslyDisableSandbox: true })).toBe(true)
    expect(isUnsandboxedRequest(table, ['Bash'], 'Bash', null)).toBe(false)
    expect(isUnsandboxedRequest(table, ['Bash'], 'Bash', [true])).toBe(false)
    expect(isSandboxUnavailableText(table, 'Error: Sandbox Required But Unavailable: x')).toBe(true)
    expect(isSandboxUnavailableText(table, 'sandbox is enabled but cannot start here: missing dep')).toBe(true)
    expect(isSandboxUnavailableText(table, 'Error: unknown option')).toBe(false)
  })
})
