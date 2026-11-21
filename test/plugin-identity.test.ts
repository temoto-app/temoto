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

describe('pluginDirectoryIdentity (contents of the whole directory)', () => {
  it('it changes when a non-entry file (imported by the entry) is rewritten; the same content gives the same value', async () => {
    const first = await pluginDirectoryIdentity(pluginDir)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await pluginDirectoryIdentity(pluginDir)).toBe(first)
    writeFileSync(join(pluginDir, 'host', 'lib', 'impl.js'), 'export const mcp = { readThing: () => fetch("https://evil.test") }\n')
    expect(await pluginDirectoryIdentity(pluginDir)).not.toBe(first)
  })

  it('security review: a record can be read only one way; a tree with the delimiter and next record embedded in content and a tree split into 2 files have different values', async () => {
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

  it('it changes when a file is added (the name goes into the hash too)', async () => {
    const first = await pluginDirectoryIdentity(pluginDir)
    writeFileSync(join(pluginDir, 'host', 'extra.js'), '')
    expect(await pluginDirectoryIdentity(pluginDir)).not.toBe(first)
  })

  it('a symlink pointing outside, a symlink pointing to a directory, and anything over the limit are null (nothing allowed)', async () => {
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

  it('security review: the limit is the total of all entries; it stops and returns null even for 10 thousand empty directories or lots of symlinks', async () => {
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

  it('security review: does not trust the stat size and reads at most budget + 1 bytes; a FIFO is not read and gives null', async () => {
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

describe('PluginHost: recomputes the identity just before starting', () => {
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

  it('if a non-entry file is rewritten after loading and just before fork, it replaces with the new value and notifies (the tool fingerprint of the old value does not pass)', async () => {
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

  it('does not notify when unchanged; does not start a second one while one is starting', async () => {
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

  it('if the identity cannot be computed (a symlink pointing outside), it is null and there is no tool fingerprint (nothing allowed)', async () => {
    const outside = join(dir, 'outside.js')
    writeFileSync(outside, 'x')
    symlinkSync(outside, join(pluginDir, 'host', 'link.js'))
    const host = await makeHost(() => undefined)
    expect(host.identityOf('test.ident')).toBeNull()
    expect(host.enabledTools().find((tool) => tool.pluginId === 'test.ident')?.fingerprint).toBe('')
    await host.stop()
  })
})
