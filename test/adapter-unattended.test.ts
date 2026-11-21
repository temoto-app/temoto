/**
 * The Adapter's unattended read-only launch (TODO 1216, ARCHITECTURE 6.2.6). Only when waking up read-only, one argument passes the flag that removes write, shell, Web, and
 * connector send tools. Also checks the table of built-in tools that the approval choke point lets through.
 *
 * `node:child_process` is replaced, and **neither the CLI nor the model is started** (the fake is the same shape as in `adapter-os-sandbox.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GatewayEndpoint, SpawnOptions } from '../src/main/session/types.js'

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
const { loadCompatTable } = await import('../src/main/session/adapter/compat.js')
const { unattendedDisallowed, unattendedLaunchArgs } = await import('../src/main/session/adapter/index.js')

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
  dir = mkdtempSync(join(tmpdir(), 'aios-unattended-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

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

describe('Adapter: unattended read-only launch (TODO 1216)', () => {
  it('when read-only, passes the flags that remove write, shell, Web, and connector-send tools in a single argument', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(options({ readOnly: true }), { onEvent: () => undefined, onExit: () => undefined })
    const args = lastArgs()
    const table = loadCompatTable()
    const flag = table.flags['disallowedTools'] as string
    const at = args.indexOf(flag)
    expect(at).toBeGreaterThan(0)
    expect(args.filter((arg) => arg === flag)).toHaveLength(1)
    const names = (args[at + 1] as string).split(',')
    for (const name of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']) expect(names).toContain(name)
    for (const name of table.outbound?.tools ?? []) expect(names).toContain(name)
    // Either no value follows or it is another flag (a variable-length value must not eat a positional argument; the utterance goes through stdin, so there is no positional argument).
    const next = args[at + 2]
    expect(next === undefined || next.startsWith('-')).toBe(true)
    expect(unattendedDisallowed(table)).toBe(args[at + 1])
  })

  it('fix X: allow-list — built-in tools are only the read ones (--tools) and MCP is only the gateway (--strict-mcp-config)', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(options({ readOnly: true }), { onEvent: () => undefined, onExit: () => undefined })
    const args = lastArgs()
    const table = loadCompatTable()
    const toolsFlag = table.flags['tools'] as string
    const strictFlag = table.flags['strictMcpConfig'] as string
    expect(args.filter((arg) => arg === toolsFlag)).toHaveLength(1)
    const allowed = (args[args.indexOf(toolsFlag) + 1] as string).split(',')
    expect(allowed).toEqual(['Read', 'Grep', 'Glob', 'TodoWrite', 'ToolSearch'])
    // Writing, running, sending outside, subagents, and new built-ins (Cron / RemoteTrigger / Skill ...) are not in the list = they do not appear in the conversation.
    for (const name of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'CronCreate', 'RemoteTrigger', 'SendMessage']) {
      expect(allowed).not.toContain(name)
    }
    expect(args).toContain(strictFlag)
    // The gateway setting is still passed (strict keeps only the gateway in --mcp-config).
    expect(args).toContain(table.flags['mcpConfig'] as string)
    expect(unattendedLaunchArgs(table)).toEqual(args.slice(args.indexOf(toolsFlag), args.indexOf(toolsFlag) + 5))
  })

  it('does not add the flags to a normal launch', async () => {
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(options({}), { onEvent: () => undefined, onExit: () => undefined })
    const table = loadCompatTable()
    expect(lastArgs()).not.toContain(table.flags['disallowedTools'])
    expect(lastArgs()).not.toContain(table.flags['tools'])
    expect(lastArgs()).not.toContain(table.flags['strictMcpConfig'])
  })

  it('fix X: refuses a read-only launch when the table cannot build the allow-list (never runs without the flags)', async () => {
    const table = loadCompatTable()
    const without = (name: string): typeof table => ({
      ...table,
      flags: Object.fromEntries(Object.entries(table.flags).filter(([key]) => key !== name))
    })
    expect(unattendedLaunchArgs(without('tools'))).toBeNull()
    expect(unattendedLaunchArgs(without('strictMcpConfig'))).toBeNull()
    expect(unattendedLaunchArgs({ ...table, unattended: undefined })).toBeNull()
    expect(unattendedLaunchArgs({ ...table, unattended: { readOnlyTools: ['bad name'], disallowedTools: [] } })).toBeNull()
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    Object.assign(adapter, { table: without('tools') })
    const before = vi.mocked(spawnProcess).mock.calls.length
    await expect(adapter.spawn(options({ readOnly: true }), { onEvent: () => undefined, onExit: () => undefined })).rejects.toThrow(
      /unattended read-only/
    )
    expect(vi.mocked(spawnProcess).mock.calls.length).toBe(before)
  })

  it('the built-in tools the gate lets through are only the read ones (subagents are not let through either)', () => {
    const adapter = new ClaudeCodeAdapter()
    for (const name of ['Read', 'Grep', 'Glob', 'TodoWrite', 'ToolSearch']) expect(adapter.unattendedReadOnlyTool(name)).toBe(true)
    for (const name of ['Bash', 'Write', 'Edit', 'WebFetch', 'Task', 'Agent', 'Skill', 'CronCreate', 'mcp__aios__search']) {
      expect(adapter.unattendedReadOnlyTool(name)).toBe(false)
    }
  })

  it('null on a table without flags or without the table (protect with the gate alone)', () => {
    const table = loadCompatTable()
    const flags = Object.fromEntries(Object.entries(table.flags).filter(([name]) => name !== 'disallowedTools'))
    expect(unattendedDisallowed({ ...table, flags })).toBeNull()
    expect(unattendedDisallowed({ ...table, unattended: undefined })).toBeNull()
  })
})
