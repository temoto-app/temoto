/**
 * Waits for the plugin process's `exit` at shutdown (owner decision of 2026-10-01, ARCHITECTURE.md 12.9 / 7.8).
 *
 * The previous `PluginHost.stop()` only sent `kill()` and returned, so `before-quit` stopped the index process and closed the DB right after.
 * A Broker request that arrived from a dying plugin (an index insert = a write to `plugin_documents`) could then run after the DB was closed. Now it waits for `exit`, with a limit (`STOP_WAIT_MS` = 2 seconds).
 *
 * A utility process cannot be started from vitest, so `electron` is replaced and `fork` returns a fake child (the same shape as `test/index-rpc.test.ts`).
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import type { CapabilityBroker } from '../src/main/capability/broker.js'

class FakeChild extends EventEmitter {
  killed = 0
  /** When set, `kill()` emits no `exit` (a process that does not respond). */
  hang = false
  readonly stderr = null
  postMessage(): void {}
  kill(): void {
    this.killed += 1
    if (!this.hang) setTimeout(() => this.emit('exit', 0), 20)
  }
}

const children: FakeChild[] = []

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild()
      children.push(child)
      // The signal that loading the entry point is done (the `ready` that the real plugin-host sends).
      setTimeout(() => child.emit('message', { id: 0, kind: 'ready', payload: { commands: ['ping'], mcp: [], indexer: [] } }), 0)
      return child
    }
  }
}))

let dir: string
let db: Db

beforeEach(() => {
  children.length = 0
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-stop-'))
  const pluginDir = join(dir, 'user', 'test.host')
  mkdirSync(join(pluginDir, 'host'), { recursive: true })
  writeFileSync(
    join(pluginDir, 'manifest.json'),
    JSON.stringify({
      id: 'test.host',
      name: 'T',
      version: '1.0.0',
      host: { entry: 'host/index.js' },
      command: { commands: [{ id: 'ping', title: 'ping' }] }
    })
  )
  writeFileSync(join(pluginDir, 'host', 'index.js'), 'export const commands = {}\n')
  mkdirSync(join(dir, 'host-entry'), { recursive: true })
  db = new Database(':memory:')
  runMigrations(db)
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function startedHost(): Promise<{ host: InstanceType<typeof import('../src/main/plugin/host.js').PluginHost>; child: FakeChild }> {
  const { PluginHost } = await import('../src/main/plugin/host.js')
  const host = new PluginHost({
    db,
    bundledDir: join(dir, 'bundled'),
    userDir: join(dir, 'user'),
    hostEntry: join(dir, 'host-entry', 'plugin-host.js'),
    broker: () => ({}) as unknown as CapabilityBroker,
    onChanged: () => undefined
  })
  host.load()
  // Wakes the process with a call (no response comes back, so this Promise is left unresolved and discarded).
  void host.invoke('test.host', 'ping', null).catch(() => undefined)
  await vi.waitFor(() => expect(children).toHaveLength(1))
  const child = children[0]!
  await vi.waitFor(() => expect(host.summaries()[0]?.host).toBe('running'))
  return { host, child }
}

describe('PluginHost.stop waits for exit', () => {
  it('sends kill and returns after exit arrives', async () => {
    const { host, child } = await startedHost()
    let exited = false
    child.once('exit', () => {
      exited = true
    })
    await host.stop()
    expect(child.killed).toBe(1)
    expect(exited).toBe(true)
  })

  it('moves on at the limit (2 seconds) even if exit never arrives (does not block shutdown)', async () => {
    const { host, child } = await startedHost()
    child.hang = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let done = false
    const stopping = host.stop().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(1900)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    await stopping
    expect(done).toBe(true)
    expect(child.killed).toBe(1)
  })
})
