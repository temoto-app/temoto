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

describe('マニフェスト: 入口は 1 つ', () => {
  it('host.entry と export で分けた command / mcp / indexer を読める', () => {
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

  it('旧形式 (command.entry だけ) もそのまま読める (互換)', () => {
    const manifest = parseManifest({
      ...base,
      command: { entry: 'host/commands.js', commands: [{ id: 'outline', title: 'x' }] }
    })
    expect(hostEntryOf(manifest)).toBe('host/commands.js')
  })

  it('host.entry と旧形式の entry が同じファイルなら読める', () => {
    const manifest = parseManifest({
      ...base,
      host: { entry: 'host/index.js' },
      indexer: { entry: './host/index.js' }
    })
    expect(hostEntryOf(manifest)).toBe('host/index.js')
  })

  it('**別々のファイルを指す entry は読み込まない** (以前は 2 つ目以降が黙って無視された)', () => {
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

  it('command / mcp / indexer があって入口が無ければ読み込まない', () => {
    expect(() => parseManifest({ ...base, mcp: {} })).toThrow(/require host.entry/)
  })

  it('host.entry もディレクトリの外は指せない', () => {
    expect(() => parseManifest({ ...base, host: { entry: '../x.js' }, mcp: {} })).toThrow(ManifestError)
    expect(() => parseManifest({ ...base, host: { entry: '/abs/x.js' }, mcp: {} })).toThrow(ManifestError)
  })

  it('同梱の aios.markdown は新しい形 (host.entry) で書かれている', () => {
    const manifest = readManifest(join(process.cwd(), 'plugins', 'aios.markdown'))
    expect(manifest.host?.entry).toBe('host/commands.js')
    expect(manifest.command?.entry).toBeUndefined()
    expect(hostEntryOf(manifest)).toBe('host/commands.js')
  })

  it('宣言した区分・コマンドだけを呼べる (isDeclaredExport)', () => {
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

  it('宣言にあって export に無いものを挙げる (起動時の警告)', () => {
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

describe('plugin-host の中身 (dispatch.ts)', () => {
  const plugin: PluginModule = {
    commands: { outline: () => 'commands.outline' },
    mcp: { search: () => 'mcp.search' },
    indexer: { sync: () => 'indexer.sync' }
  }

  it('1 つのモジュールから 3 区分を引ける', () => {
    expect(findHandler(plugin, 'command', 'outline')?.(undefined, {} as never)).toBe('commands.outline')
    expect(findHandler(plugin, 'mcp', 'search')?.(undefined, {} as never)).toBe('mcp.search')
    expect(findHandler(plugin, 'indexer', 'sync')?.(undefined, {} as never)).toBe('indexer.sync')
    expect(findHandler(plugin, 'mcp', 'outline')).toBeNull()
  })

  it('**継承した名前 (constructor / __proto__ / toString) は関数として呼ばない**', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(findHandler(plugin, 'command', name)).toBeNull()
    }
  })

  it('default export と名前付き export のどちらでもよい', () => {
    const named = toPluginModule({ commands: { a: () => 1 } })
    expect(Object.keys(named.commands ?? {})).toEqual(['a'])
    const viaDefault = toPluginModule({ default: { indexer: { sync: () => 1 } }, commands: { ignored: () => 0 } })
    expect(describeExports(viaDefault)).toEqual({ commands: [], mcp: [], indexer: ['sync'], tasks: [], search: [] })
    expect(toPluginModule(null)).toEqual({})
  })

  it('describeExports は関数だけを数える', () => {
    const odd = { commands: { a: () => 1, b: 'not a function' } } as unknown as PluginModule
    expect(describeExports(odd)).toEqual({ commands: ['a'], mcp: [], indexer: [], tasks: [], search: [] })
  })

  it('invoke の中身: kind が無ければ command (古い main)、知らない kind は落とす', () => {
    expect(readInvoke({ command: 'outline', arg: 1 })).toEqual({ kind: 'command', name: 'outline', arg: 1 })
    expect(readInvoke({ kind: 'indexer', command: 'sync' })).toEqual({ kind: 'indexer', name: 'sync', arg: undefined })
    expect(readInvoke({ kind: 'shell', command: 'x' })).toBeNull()
    expect(readInvoke({ command: 3 })).toBeNull()
    expect(readInvoke(null)).toBeNull()
  })

  it('api.fs.read の範囲とバイト列の指定は Broker の要求にそのまま載る (C-1)', async () => {
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

describe('PluginHost.invoke: 宣言外は起こす前に断る', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-host-exports-'))
    fork.mockClear()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('宣言していないコマンド・区分では utility process を起こさない', async () => {
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
