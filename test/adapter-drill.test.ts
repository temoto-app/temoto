/**
 * TODO 982 (ARCHITECTURE 4.2.5 "drill", wave 101 security review and review fix Y): a drill's launch. The built-in tools are an allow
 * list (reads, the recorded writes and shell, the question); the recorded ones are forced to ask (`--settings` ask list); every other tool
 * the unattended read-only launch removes is also denied, MCP is the gateway only, the permission mode is aios's default (never Plan), and a
 * launch that cannot be built is refused.
 *
 * `node:child_process` is replaced, and **neither the CLI nor the model is started** (the same fake as `adapter-unattended.test.ts`).
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

const { ClaudeCodeAdapter, drillLaunchArgs, drillSettingsJson } = await import('../src/main/session/adapter/index.js')
const { spawn: spawnProcess } = await import('node:child_process')
const { loadCompatTable } = await import('../src/main/session/adapter/compat.js')
const { OpenCodeAdapter } = await import('../src/main/session/adapter-opencode/index.js')

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
  vi.mocked(spawnProcess).mockClear()
  dir = mkdtempSync(join(tmpdir(), 'aios-drill-adapter-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function options(extra: Partial<SpawnOptions>): SpawnOptions {
  return {
    sessionId: '00000000-0000-4000-8000-000000000002',
    threadId: 't',
    cwd: '/Users/tester/git/app',
    allowedDirs: ['/Users/tester/git/app'],
    resumeBackendSessionId: null,
    modelId: null,
    thinking: null,
    gateway: gateway(),
    ...extra
  }
}

const lastArgs = (): readonly string[] => (vi.mocked(spawnProcess).mock.calls.at(-1)?.[1] ?? []) as readonly string[]
const handlers = { onEvent: () => undefined, onExit: () => undefined }
const POLICY = { allowedDomains: ['registry.npmjs.org'], allowWrite: ['~/.npm'] }

describe('Adapter: a drill launch (TODO 982)', () => {
  it('MCP is the gateway only; what a drill does not record is removed; writes and the shell stay and are forced to ask', async () => {
    const table = loadCompatTable()
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    expect(adapter.supportsDrill()).toBe(true)
    await adapter.spawn(options({ drill: true }), handlers)
    const args = lastArgs()
    expect(args).toContain(table.flags['strictMcpConfig'] as string)
    // Wave 101 review fix Y: the built-in tools are an allow list - reads, the recorded writes and shell, and the question; nothing else.
    const toolsFlag = table.flags['tools'] as string
    expect(args.filter((arg) => arg === toolsFlag)).toHaveLength(1)
    const allowed = (args[args.indexOf(toolsFlag) + 1] ?? '').split(',')
    expect([...allowed].sort()).toEqual(
      [...new Set([...table.unattended!.readOnlyTools, ...table.drill!.recordTools, ...(table.drill!.questionTools ?? [])])].sort()
    )
    expect(allowed).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'AskUserQuestion']))
    // Tools not in the table (the Web, subagents, Cron, teams / tasks / workflows of a newer version) are not in the allow list.
    for (const name of ['WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'CronCreate', 'RemoteTrigger', 'SendMessage', 'TeamCreate', 'TaskCreate', 'Workflow', 'ExitPlanMode']) {
      expect(allowed).not.toContain(name)
    }
    for (const name of table.outbound?.tools ?? []) expect(allowed).not.toContain(name)
    // The deny list stays as a second line, and never names what the allow list keeps.
    const deny = (args[args.indexOf(table.flags['disallowedTools'] as string) + 1] ?? '').split(',')
    for (const name of ['WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'CronCreate', 'RemoteTrigger', 'SendMessage', ...(table.outbound?.tools ?? [])]) {
      expect(deny).toContain(name)
    }
    for (const name of allowed) expect(deny).not.toContain(name)
    const settings = JSON.parse(args[args.indexOf(table.flags['settings'] as string) + 1] ?? '{}') as Record<string, Record<string, string[]>>
    expect(settings[table.drill!.settingsKey]?.[table.drill!.askKey]).toEqual(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
    expect(drillLaunchArgs(table)).toEqual(args.slice(args.indexOf(toolsFlag), args.indexOf(toolsFlag) + 5))
  })

  it('a tool name that is not a plain name never reaches the allow list; a broken recorded name refuses the whole launch', () => {
    const table = loadCompatTable()
    const sneaky = {
      ...table,
      unattended: { ...table.unattended!, readOnlyTools: [...table.unattended!.readOnlyTools, 'Read,Bash(rm:*)', 'Web Fetch'] },
      drill: { ...table.drill!, questionTools: ['AskUserQuestion', 'mcp__x__send,Write'] }
    }
    const args = drillLaunchArgs(sneaky) ?? []
    const allowed = (args[args.indexOf(table.flags['tools'] as string) + 1] ?? '').split(',')
    expect(allowed).not.toContain('Bash(rm:*)')
    expect(allowed).not.toContain('Web Fetch')
    expect(allowed).not.toContain('mcp__x__send')
    expect(allowed.every((name) => /^[A-Za-z0-9_-]+$/.test(name))).toBe(true)
    expect(drillLaunchArgs({ ...table, drill: { ...table.drill!, recordTools: ['Bash', 'Write,WebFetch'] } })).toBeNull()
    expect(drillLaunchArgs({ ...table, drill: { ...table.drill!, recordTools: [] } })).toBeNull()
  })

  it('the permission mode is aios’s default even if Plan is asked for; the approval tool is passed', async () => {
    const table = loadCompatTable()
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(options({ drill: true, planMode: true }), handlers)
    const args = lastArgs()
    expect(args[args.indexOf(table.flags['permissionMode'] as string) + 1]).toBe(table.permissionModes['manual']?.sent)
    expect(args).toContain(table.flags['permissionPromptTool'] as string)
  })

  it('with the OS sandbox the ask list goes into the same single settings JSON', async () => {
    const table = loadCompatTable()
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(options({ drill: true, osSandbox: POLICY }), handlers)
    const args = lastArgs()
    const flag = table.flags['settings'] as string
    expect(args.filter((arg) => arg === flag)).toHaveLength(1)
    const settings = JSON.parse(args[args.indexOf(flag) + 1] ?? '{}') as Record<string, unknown>
    expect(settings[table.osSandbox!.settingsKey]).toMatchObject({ enabled: true })
    expect(settings[table.drill!.settingsKey]).toEqual({ [table.drill!.askKey]: table.drill!.recordTools })
    expect(drillSettingsJson(table, 'not json')).toBeNull()
  })

  it('a launch that cannot be built is refused before anything starts; another backend refuses a drill too', async () => {
    const table = loadCompatTable()
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    for (const broken of [
      { ...table, drill: undefined },
      { ...table, flags: Object.fromEntries(Object.entries(table.flags).filter(([key]) => key !== 'strictMcpConfig')) },
      // Wave 101 review fix Y: no allow list for the built-in tools = no drill (never a deny list alone).
      { ...table, flags: Object.fromEntries(Object.entries(table.flags).filter(([key]) => key !== 'tools')) },
      { ...table, unattended: undefined },
      { ...table, flags: Object.fromEntries(Object.entries(table.flags).filter(([key]) => key !== 'settings')) }
    ]) {
      Object.assign(adapter, { table: broken })
      expect(adapter.supportsDrill()).toBe(false)
      const before = vi.mocked(spawnProcess).mock.calls.length
      await expect(adapter.spawn(options({ drill: true }), handlers)).rejects.toThrow(/drill launch/)
      expect(vi.mocked(spawnProcess).mock.calls.length).toBe(before)
    }
    const opencode = new OpenCodeAdapter()
    expect((opencode as { supportsDrill?: () => boolean }).supportsDrill?.() ?? false).toBe(false)
    await expect(opencode.spawn(options({ drill: true }), handlers)).rejects.toThrow(/drill launch/)
  })

  it('an ordinary launch gets none of it', async () => {
    const table = loadCompatTable()
    const adapter = new ClaudeCodeAdapter()
    await adapter.getStatus()
    await adapter.spawn(options({}), handlers)
    expect(lastArgs()).not.toContain(table.flags['strictMcpConfig'] as string)
    expect(lastArgs()).not.toContain(table.flags['settings'] as string)
  })
})
