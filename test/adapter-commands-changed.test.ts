/**
 * The Adapter's `system/commands_changed` (rest of item 117, wave 13 bundle E) and the hook events (item 126-3).
 *
 * - The replacement list replaces the copy kept from the `initialize` response (`backend.<id>.models` `commands`), and
 *   `knownCommands()` returns it from the start of the next run. The copy keeps **the list as reported** (before the table fixes it).
 * - Hook output is discarded once stdout is read, and does not appear in the `AiosEvent` passed to `onEvent`.
 *
 * `node:child_process` is replaced, and **neither the CLI nor the model is started** (the fake is the same shape as in `adapter-process.test.ts`).
 * The lines are synthetic (built from the key list of spike 25 and the zod of CLI 2.1.280).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiosEvent } from '../src/shared/agent.js'
import type { GatewayEndpoint } from '../src/main/session/types.js'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly written: string[] = []
  readonly stdin: Writable
  readonly kill = vi.fn((signal?: string) => {
    setImmediate(() => this.emit('close', null, signal ?? 'SIGTERM'))
    return true
  })

  constructor() {
    super()
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.written.push(chunk.toString('utf8'))
        callback()
      }
    })
  }
}

const state = vi.hoisted(() => ({ children: [] as unknown[] }))

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
      const stdout = args.includes('--version')
        ? '9.9.9 (test)\n'
        : JSON.stringify({ loggedIn: true, authMethod: 'test', subscriptionType: null })
      queueMicrotask(() => callback(null, stdout, ''))
    }
  )
}))

const { ClaudeCodeAdapter } = await import('../src/main/session/adapter/index.js')

const children = (): FakeChild[] => state.children as FakeChild[]

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
  dir = mkdtempSync(join(tmpdir(), 'aios-adapter-cc-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function start(
  adapter: InstanceType<typeof ClaudeCodeAdapter>
): Promise<{ child: FakeChild; events: AiosEvent[] }> {
  const events: AiosEvent[] = []
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
    { onEvent: (event) => events.push(event), onExit: () => undefined }
  )
  await flush()
  const child = children().at(-1)
  if (child === undefined) throw new Error('no child')
  return { child, events }
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

describe('Adapter — コマンド一覧の差し替え (項目 117 の残り)', () => {
  it('commands_changed で控えを置き換え、次の起動の最初から返す。控えは報告のまま', async () => {
    let saved: string | null = null
    const cache = {
      read: () => null,
      write: () => undefined,
      readModels: () => saved,
      writeModels: (_id: string, json: string) => {
        saved = json
      }
    }
    const adapter = new ClaudeCodeAdapter(cache)
    const { child, events } = await start(adapter)
    child.stdout.write(
      line({
        type: 'system',
        subtype: 'commands_changed',
        commands: [
          { name: 'compact', description: 'x', argumentHint: '', builtin: true },
          { name: 'status', description: 'y', argumentHint: '' },
          { name: 'plugin-cmd', description: 'z', argumentHint: '<a>', aliases: ['pc'] }
        ],
        uuid: '00000000-0000-4000-8000-00000000abce',
        session_id: '00000000-0000-4000-8000-000000000001'
      })
    )
    await flush()
    // The renderer / SessionManager get the list after the table fixes it (status does not change, cost is added).
    const changed = events.find((e) => e.kind === 'commands_changed')
    expect(changed?.kind === 'commands_changed' && changed.payload.commands).toEqual([
      'compact',
      'plugin-cmd',
      'cost'
    ])
    // The copy keeps the list as reported.
    expect(JSON.parse(saved ?? '{}').commands).toEqual(['compact', 'status', 'plugin-cmd'])
    expect(adapter.knownCommands()).toEqual(['compact', 'plugin-cmd', 'cost'])
    expect(new ClaudeCodeAdapter(cache).knownCommands()).toEqual(['compact', 'plugin-cmd', 'cost'])
    // Not the old path where raw lines flow through as unknown.
    expect(events.some((e) => e.kind === 'unknown')).toBe(false)
  })
})

describe('Adapter — hooks の事象 (項目 126-3)', () => {
  it('hook の開始・途中の出力は流さず、終わりだけを hook_run として出力抜きで流す', async () => {
    const adapter = new ClaudeCodeAdapter()
    const { child, events } = await start(adapter)
    const common = {
      type: 'system',
      hook_id: 'h1',
      hook_name: 'SessionStart:startup',
      hook_event: 'SessionStart',
      uuid: '00000000-0000-4000-8000-00000000abcd',
      session_id: '00000000-0000-4000-8000-000000000001'
    }
    child.stdout.write(line({ ...common, subtype: 'hook_started' }))
    child.stdout.write(line({ ...common, subtype: 'hook_progress', stdout: 'SECRET', stderr: '', output: 'SECRET' }))
    child.stdout.write(
      line({ ...common, subtype: 'hook_response', stdout: 'SECRET', stderr: 'SECRET', output: 'SECRET', exit_code: 0, outcome: 'success' })
    )
    await flush()
    expect(events.map((e) => e.kind)).toEqual(['hook_run'])
    expect(JSON.stringify(events)).not.toContain('SECRET')
  })
})
