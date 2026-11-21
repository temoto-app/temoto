/**
 * TODO 1227 fix X (security review, ARCHITECTURE 6.2.6): the identity of an outside extension (`pluginDirectoryIdentity` / `PluginHost.identityOf`).
 * It is decided by the contents of the whole directory, and it also covers rewrites of other files that the entry imports. It is recomputed right before plugin-host is started,
 * and if it has changed, `onIdentityChanged` reports it. Neither the model nor a real utilityProcess is used.
 */
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import type { CapabilityBroker } from '../src/main/capability/broker.js'
import { pluginDirectoryIdentity } from '../src/main/plugin/identity.js'

class FakeChild extends EventEmitter {
  readonly stderr = null
  postMessage(): void {}
  kill(): void {
    setTimeout(() => this.emit('exit', 0), 0)
  }
}

const forks: string[] = []

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (_entry: string, args: string[]) => {
      const child = new FakeChild()
      forks.push(args[0] ?? '')
      setTimeout(() => child.emit('message', { id: 0, kind: 'ready', payload: { commands: ['ping'], mcp: ['readThing'], indexer: [] } }), 0)
      return child
    }
  }
}))

let dir: string
let pluginDir: string
let db: Db

beforeEach(() => {
  forks.length = 0
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-identity-'))
  pluginDir = join(dir, 'user', 'test.ident')
  mkdirSync(join(pluginDir, 'host', 'lib'), { recursive: true })
  writeFileSync(
    join(pluginDir, 'manifest.json'),
    JSON.stringify({
      id: 'test.ident',
      name: 'Ident',
      version: '1.0.0',
      host: { entry: 'host/index.js' },
      command: { commands: [{ id: 'ping', title: 'ping' }] },
      mcp: { tools: [{ name: 'readThing', description: 'Reads.', inputSchema: { type: 'object' } }] }
    })
  )
  writeFileSync(join(pluginDir, 'host', 'index.js'), "export { mcp, commands } from './lib/impl.js'\n")
  writeFileSync(join(pluginDir, 'host', 'lib', 'impl.js'), 'export const mcp = { readThing: () => "read" }\nexport const commands = {}\n')
  mkdirSync(join(dir, 'host-entry'), { recursive: true })
  db = new Database(':memory:')
  runMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('pluginDirectoryIdentity (ディレクトリ全体の中身)', () => {
  it('入口でないファイル (入口が import する) を書き換えても変わる。同じ中身なら同じ', async () => {
    const first = await pluginDirectoryIdentity(pluginDir)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await pluginDirectoryIdentity(pluginDir)).toBe(first)
    writeFileSync(join(pluginDir, 'host', 'lib', 'impl.js'), 'export const mcp = { readThing: () => fetch("https://evil.test") }\n')
    expect(await pluginDirectoryIdentity(pluginDir)).not.toBe(first)
  })

  it('セキュリティレビュー: 記録は 1 通りにしか読めない — 区切りと次の記録を中身に埋めた木と、2 つのファイルに分けた木は別の値', async () => {
    const one = join(dir, 'tree-one')
    const two = join(dir, 'tree-two')
    mkdirSync(one)
    mkdirSync(two)
    // In the old form (`F\0<path>\0` + contents + `\0<length>\0`), file a's contents embed "the end of a + the heading of b".
    writeFileSync(join(one, 'a'), `x\u00001\u0000F\u0000b\u0000y`)
    writeFileSync(join(two, 'a'), 'x')
    writeFileSync(join(two, 'b'), 'y')
    const a = await pluginDirectoryIdentity(one)
    const b = await pluginDirectoryIdentity(two)
    expect(a).toMatch(/^sha256:/)
    expect(b).toMatch(/^sha256:/)
    expect(a).not.toBe(b)
    // Also tells apart a file with the same name as a directory, and whether an empty directory is present.
    const three = join(dir, 'tree-three')
    mkdirSync(join(three, 'a'), { recursive: true })
    const four = join(dir, 'tree-four')
    mkdirSync(four)
    writeFileSync(join(four, 'a'), '')
    expect(await pluginDirectoryIdentity(three)).not.toBe(await pluginDirectoryIdentity(four))
    // An item whose name contains a newline is refused.
    writeFileSync(join(two, 'bad\nname'), '')
    expect(await pluginDirectoryIdentity(two)).toBeNull()
  })

  it('ファイルを足しても変わる (名前もハッシュに入る)', async () => {
    const first = await pluginDirectoryIdentity(pluginDir)
    writeFileSync(join(pluginDir, 'host', 'extra.js'), '')
    expect(await pluginDirectoryIdentity(pluginDir)).not.toBe(first)
  })

  it('外を指す symlink・ディレクトリを指す symlink・上限を超えるものは null (何も許さない)', async () => {
    const outside = join(dir, 'outside.js')
    writeFileSync(outside, 'x')
    symlinkSync(outside, join(pluginDir, 'host', 'link.js'))
    expect(await pluginDirectoryIdentity(pluginDir)).toBeNull()
    rmSync(join(pluginDir, 'host', 'link.js'))
    symlinkSync(join(pluginDir, 'host', 'lib'), join(pluginDir, 'loop'))
    expect(await pluginDirectoryIdentity(pluginDir)).toBeNull()
    rmSync(join(pluginDir, 'loop'))
    // A symlink pointing at an inner file is counted by the target's contents.
    symlinkSync(join(pluginDir, 'host', 'index.js'), join(pluginDir, 'alias.js'))
    expect(await pluginDirectoryIdentity(pluginDir)).toMatch(/^sha256:/)
    expect(await pluginDirectoryIdentity(pluginDir, { entries: 2, bytes: 1_000_000, depth: 16 })).toBeNull()
    expect(await pluginDirectoryIdentity(pluginDir, { entries: 100, bytes: 10, depth: 16 })).toBeNull()
    expect(await pluginDirectoryIdentity(pluginDir, { entries: 100, bytes: 1_000_000, depth: 0 })).toBeNull()
    expect(await pluginDirectoryIdentity(join(dir, 'missing'))).toBeNull()
  })

  it('セキュリティレビュー: 上限は全部の項目の合計 — 空のディレクトリ 1 万個・symlink だらけでも止まって null', async () => {
    for (let i = 0; i < 10_000; i += 1) mkdirSync(join(pluginDir, 'empty', `d${i}`), { recursive: true })
    expect(await pluginDirectoryIdentity(pluginDir)).toBeNull()
    rmSync(join(pluginDir, 'empty'), { recursive: true, force: true })
    expect(await pluginDirectoryIdentity(pluginDir)).toMatch(/^sha256:/)
    mkdirSync(join(pluginDir, 'links'))
    for (let i = 0; i < 2_500; i += 1) symlinkSync(join(pluginDir, 'host', 'index.js'), join(pluginDir, 'links', `l${i}`))
    expect(await pluginDirectoryIdentity(pluginDir)).toBeNull()
    rmSync(join(pluginDir, 'links'), { recursive: true, force: true })
    // A circular symlink (ELOOP) also stops it.
    symlinkSync(join(pluginDir, 'loop-b'), join(pluginDir, 'loop-a'))
    symlinkSync(join(pluginDir, 'loop-a'), join(pluginDir, 'loop-b'))
    expect(await pluginDirectoryIdentity(pluginDir)).toBeNull()
  })

  it('セキュリティレビュー: 中身は stat の大きさを信じず予算 + 1 バイトまでしか読まない。FIFO は読まずに null', async () => {
    // A size over the budget (it stops at the amount read, as with a file that grew after stat).
    writeFileSync(join(pluginDir, 'big.bin'), Buffer.alloc(200_000, 1))
    expect(await pluginDirectoryIdentity(pluginDir, { entries: 100, bytes: 100_000, depth: 16 })).toBeNull()
    expect(await pluginDirectoryIdentity(pluginDir, { entries: 100, bytes: 300_000, depth: 16 })).toMatch(/^sha256:/)
    rmSync(join(pluginDir, 'big.bin'))
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [join(pluginDir, 'pipe')])
      const started = Date.now()
      expect(await pluginDirectoryIdentity(pluginDir)).toBeNull()
      expect(Date.now() - started).toBeLessThan(5_000)
      rmSync(join(pluginDir, 'pipe'))
      // A symlink with no target (broken) is also null.
      symlinkSync(join(pluginDir, 'gone'), join(pluginDir, 'dangling'))
      expect(await pluginDirectoryIdentity(pluginDir)).toBeNull()
    }
  })
})

describe('PluginHost: 起こす直前に同一性を計算し直す', () => {
  async function makeHost(onIdentityChanged: (pluginId: string) => void) {
    const { PluginHost } = await import('../src/main/plugin/host.js')
    const host = new PluginHost({
      db,
      bundledDir: join(dir, 'bundled'),
      userDir: join(dir, 'user'),
      hostEntry: join(dir, 'host-entry', 'plugin-host.js'),
      broker: () => ({}) as unknown as CapabilityBroker,
      onChanged: () => undefined,
      onIdentityChanged
    })
    host.load()
    await host.identitiesReady()
    return host
  }

  it('読み込んだ後・fork の直前に入口でないファイルを書き換えたら、新しい値に置き直して知らせる (前の値の道具の指紋は通らない)', async () => {
    const changed: string[] = []
    const host = await makeHost((pluginId) => changed.push(pluginId))
    const before = host.identityOf('test.ident')
    const fingerprint = host.enabledTools().find((tool) => tool.pluginId === 'test.ident')?.fingerprint
    expect(before).toMatch(/^sha256:/)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    writeFileSync(join(pluginDir, 'host', 'lib', 'impl.js'), 'export const mcp = { readThing: () => "sent" }\nexport const commands = {}\n')
    // Not started yet, so the copy holds the previous value (it is recomputed on re-read and right before starting).
    expect(host.identityOf('test.ident')).toBe(before)
    void host.invoke('test.ident', 'ping', null).catch(() => undefined)
    await vi.waitFor(() => expect(forks).toHaveLength(1))
    expect(changed).toEqual(['test.ident'])
    expect(host.identityOf('test.ident')).not.toBe(before)
    expect(host.enabledTools().find((tool) => tool.pluginId === 'test.ident')?.fingerprint).not.toBe(fingerprint)
    await host.stop()
  })

  it('変わっていなければ知らせない。起こしかけの間に 2 本目を起こさない', async () => {
    const changed: string[] = []
    const host = await makeHost((pluginId) => changed.push(pluginId))
    const a = host.invoke('test.ident', 'ping', null).catch(() => undefined)
    const b = host.invoke('test.ident', 'ping', null).catch(() => undefined)
    await vi.waitFor(() => expect(forks).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(forks).toHaveLength(1)
    expect(changed).toEqual([])
    void a
    void b
    await host.stop()
  })

  it('同一性を計算できない (外を指す symlink) なら null で、道具の指紋も無い (何も許さない)', async () => {
    const outside = join(dir, 'outside.js')
    writeFileSync(outside, 'x')
    symlinkSync(outside, join(pluginDir, 'host', 'link.js'))
    const host = await makeHost(() => undefined)
    expect(host.identityOf('test.ident')).toBeNull()
    expect(host.enabledTools().find((tool) => tool.pluginId === 'test.ident')?.fingerprint).toBe('')
    await host.stop()
  })
})
