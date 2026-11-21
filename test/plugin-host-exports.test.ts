/**
 * The plugin-host has one entry point, and its roles are split by export (review C-4 of 2026-09-21, ARCHITECTURE.md 7.1 / 7.2).
 *
 * Previously only the first entry of `command ?? mcp ?? indexer` was started, so a plugin that wrote `indexer` in a separate file never had its indexer loaded.
 * Now `commands` / `mcp` / `indexer` are looked up by export from one `host.entry`, and main names the one it wants by `kind`.
 *
 * A utility process cannot be started from vitest, so this checks `src/plugin-host/dispatch.ts` (the part that does not depend on parentPort),
 * the manifest validation, and that `PluginHost.invoke` refuses anything not declared before it starts a process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import {
  ManifestError,
  hostEntryOf,
  isDeclaredExport,
  missingExports,
  needsHost,
  parseManifest,
  readManifest
} from '../src/main/plugin/manifest.js'
import {
  createPluginApi,
  describeExports,
  findHandler,
  readInvoke,
  toPluginModule
} from '../src/plugin-host/dispatch.js'
import type { BrokerRequest, PluginModule } from '../src/shared/plugin.js'

const fork = vi.fn(() => {
  throw new Error('fork must not be called')
})
vi.mock('electron', () => ({ utilityProcess: { fork: (...args: unknown[]) => fork(...(args as [])) } }))

const base = { id: 'test.host', name: 'T', version: '1.0.0' }

describe('manifest: one entry point', () => {
  it('reads command / mcp / indexer split by host.entry and export', () => {
    const manifest = parseManifest({
      ...base,
      host: { entry: 'host/index.js' },
      command: { commands: [{ id: 'sync', title: '同期' }] },
      mcp: {},
      indexer: { interval: '15m' }
    })
    expect(hostEntryOf(manifest)).toBe('host/index.js')
    expect(needsHost(manifest)).toBe(true)
  })

  it('still reads the legacy form (command.entry only) for compatibility', () => {
    const manifest = parseManifest({
      ...base,
      command: { entry: 'host/commands.js', commands: [{ id: 'outline', title: 'x' }] }
    })
    expect(hostEntryOf(manifest)).toBe('host/commands.js')
  })

  it('reads it when host.entry and the legacy entry are the same file', () => {
    const manifest = parseManifest({
      ...base,
      host: { entry: 'host/index.js' },
      indexer: { entry: './host/index.js' }
    })
    expect(hostEntryOf(manifest)).toBe('host/index.js')
  })

  it('does not load entries pointing to different files (the second and later were silently ignored before)', () => {
    expect(() =>
      parseManifest({
        ...base,
        command: { entry: 'host/commands.js', commands: [] },
        indexer: { entry: 'indexer/sync.js' }
      })
    ).toThrow(ManifestError)
    expect(() =>
      parseManifest({ ...base, host: { entry: 'a.js' }, mcp: { entry: 'b.js' } })
    ).toThrow(/exactly one entry/)
  })

  it('does not load when there is a command / mcp / indexer but no entry', () => {
    expect(() => parseManifest({ ...base, mcp: {} })).toThrow(/require host.entry/)
  })

  it('host.entry cannot point outside the directory either', () => {
    expect(() => parseManifest({ ...base, host: { entry: '../x.js' }, mcp: {} })).toThrow(ManifestError)
    expect(() => parseManifest({ ...base, host: { entry: '/abs/x.js' }, mcp: {} })).toThrow(ManifestError)
  })

  it('the bundled aios.markdown is written in the new form (host.entry)', () => {
    const manifest = readManifest(join(process.cwd(), 'plugins', 'aios.markdown'))
    expect(manifest.host?.entry).toBe('host/commands.js')
    expect(manifest.command?.entry).toBeUndefined()
    expect(hostEntryOf(manifest)).toBe('host/commands.js')
  })

  it('can call only the declared kinds and commands (isDeclaredExport)', () => {
    const manifest = parseManifest({
      ...base,
      host: { entry: 'h.js' },
      command: { commands: [{ id: 'outline', title: 'x' }] },
      indexer: {}
    })
    expect(isDeclaredExport(manifest, 'command', 'outline')).toBe(true)
    expect(isDeclaredExport(manifest, 'command', 'rm')).toBe(false)
    expect(isDeclaredExport(manifest, 'indexer', 'sync')).toBe(true)
    expect(isDeclaredExport(manifest, 'indexer', 'other')).toBe(false)
    expect(isDeclaredExport(manifest, 'mcp', 'search')).toBe(false)
  })

  it('lists what is declared but missing from the exports (startup warning)', () => {
    const manifest = parseManifest({
      ...base,
      host: { entry: 'h.js' },
      command: { commands: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }] },
      mcp: {},
      indexer: {}
    })
    expect(missingExports(manifest, { commands: ['a'], mcp: [], indexer: [] })).toEqual([
      'command:b',
      'mcp',
      'indexer:sync'
    ])
    expect(missingExports(manifest, { commands: ['a', 'b'], mcp: ['search'], indexer: ['sync'] })).toEqual([])
  })
})

describe('inside plugin-host (dispatch.ts)', () => {
  const plugin: PluginModule = {
    commands: { outline: () => 'commands.outline' },
    mcp: { search: () => 'mcp.search' },
    indexer: { sync: () => 'indexer.sync' }
  }

  it('resolves the 3 kinds from one module', () => {
    expect(findHandler(plugin, 'command', 'outline')?.(undefined, {} as never)).toBe('commands.outline')
    expect(findHandler(plugin, 'mcp', 'search')?.(undefined, {} as never)).toBe('mcp.search')
    expect(findHandler(plugin, 'indexer', 'sync')?.(undefined, {} as never)).toBe('indexer.sync')
    expect(findHandler(plugin, 'mcp', 'outline')).toBeNull()
  })

  it('does not call inherited names (constructor / __proto__ / toString) as functions', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(findHandler(plugin, 'command', name)).toBeNull()
    }
  })

  it('accepts both a default export and named exports', () => {
    const named = toPluginModule({ commands: { a: () => 1 } })
    expect(Object.keys(named.commands ?? {})).toEqual(['a'])
    const viaDefault = toPluginModule({ default: { indexer: { sync: () => 1 } }, commands: { ignored: () => 0 } })
    expect(describeExports(viaDefault)).toEqual({ commands: [], mcp: [], indexer: ['sync'], tasks: [], search: [] })
    expect(toPluginModule(null)).toEqual({})
  })

  it('describeExports counts only functions', () => {
    const odd = { commands: { a: () => 1, b: 'not a function' } } as unknown as PluginModule
    expect(describeExports(odd)).toEqual({ commands: ['a'], mcp: [], indexer: [], tasks: [], search: [] })
  })

  it('invoke internals: a missing kind is command (old main), an unknown kind is dropped', () => {
    expect(readInvoke({ command: 'outline', arg: 1 })).toEqual({ kind: 'command', name: 'outline', arg: 1 })
    expect(readInvoke({ kind: 'indexer', command: 'sync' })).toEqual({ kind: 'indexer', name: 'sync', arg: undefined })
    expect(readInvoke({ kind: 'shell', command: 'x' })).toBeNull()
    expect(readInvoke({ command: 3 })).toBeNull()
    expect(readInvoke(null)).toBeNull()
  })

  it('the range and byte-array arguments of api.fs.read go into the Broker request as they are (C-1)', async () => {
    const seen: BrokerRequest[] = []
    const api = createPluginApi(async (request) => {
      seen.push(request)
      return {}
    })
    await api.fs.read('file:///a.pdf')
    await api.fs.read('file:///a.pdf', { encoding: 'bytes', offset: 10, length: 20 })
    await api.net.fetch('https://x.example.com/', { method: 'POST', body: new Uint8Array([1]) })
    expect(seen[0]).toEqual({ capability: 'fs', op: 'read', uri: 'file:///a.pdf' })
    expect(seen[1]).toEqual({
      capability: 'fs',
      op: 'read',
      uri: 'file:///a.pdf',
      encoding: 'bytes',
      offset: 10,
      length: 20
    })
    expect(seen[2]).toMatchObject({ capability: 'network', method: 'POST' })
  })
})

describe('PluginHost.invoke: refuses undeclared calls before starting', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-host-exports-'))
    fork.mockClear()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not start the utility process for an undeclared command or kind', async () => {
    const { runMigrations } = await import('../src/common/migrations.js')
    const { PluginHost } = await import('../src/main/plugin/host.js')
    const db = new Database(':memory:')
    runMigrations(db)
    const userDir = join(dir, 'user')
    mkdirSync(join(userDir, 'p'), { recursive: true })
    writeFileSync(
      join(userDir, 'p', 'manifest.json'),
      JSON.stringify({
        id: 'test.exports',
        name: 'x',
        version: '1',
        host: { entry: 'host.js' },
        command: { commands: [{ id: 'ok', title: 'ok' }] }
      })
    )
    const plugins = new PluginHost({
      db,
      bundledDir: join(dir, 'none'),
      userDir,
      hostEntry: join(dir, 'plugin-host.js'),
      broker: () => {
        throw new Error('not used')
      },
      onChanged: () => {}
    })
    plugins.load()
    await expect(plugins.invoke('test.exports', 'rm', undefined)).rejects.toThrow('undeclared-export')
    await expect(plugins.invoke('test.exports', 'sync', undefined, 'indexer')).rejects.toThrow('undeclared-export')
    await expect(plugins.invoke('no.such', 'ok', undefined)).rejects.toThrow('plugin not available')
    expect(fork).not.toHaveBeenCalled()
    // A declared command does start a process (here the fake fork throws).
    await expect(plugins.invoke('test.exports', 'ok', undefined)).rejects.toThrow('fork must not be called')
    expect(fork).toHaveBeenCalledTimes(1)
    db.close()
  })
})
