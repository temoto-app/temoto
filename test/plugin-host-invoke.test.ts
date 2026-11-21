/**
 * TODO 573: the limit on `invoke` in plugin-host, and returning the crash count to 0 after 60 seconds from `ready`.
 *
 * A utility process cannot be started from vitest, so `electron` is replaced and `fork` returns a fake child
 * (the same shape as `test/plugin-host-stop.test.ts`).
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
  readonly stderr = null
  readonly posted: { id: number; kind: string }[] = []
  postMessage(message: { id: number; kind: string }): void {
    this.posted.push(message)
  }
  kill(): void {
    setTimeout(() => this.emit('exit', 0), 0)
  }
}

const children: FakeChild[] = []

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild()
      children.push(child)
      setTimeout(() => child.emit('message', { id: 0, kind: 'ready', payload: { commands: ['ping'], mcp: [], indexer: [] } }), 0)
      return child
    }
  }
}))


/**
 * TODO 1227 fix X: an outside extension recomputes its identity (a hash of the whole directory, `fs/promises`) right before it is started, so fork comes after real I/O.
 * Wait for fork before advancing the fake clock (setImmediate is not faked).
 */
async function untilForked(count: number): Promise<void> {
  for (let i = 0; i < 1000 && children.length < count; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

let dir: string
let db: Db

beforeEach(() => {
  children.length = 0
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-invoke-'))
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

async function newHost(): Promise<InstanceType<typeof import('../src/main/plugin/host.js').PluginHost>> {
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
  return host
}

describe('PluginHost.invoke limit (TODO 573)', () => {
  it('rejects after the limit and drops a result that arrives late', async () => {
    const host = await newHost()
    const pending = host.invoke('test.host', 'ping', null, 'command', 50)
    await expect(pending).rejects.toThrow('plugin invoke timeout')
    const child = children[0]!
    const id = child.posted.find((message) => message.kind === 'invoke')?.id ?? -1
    // Even if it arrives late, nothing happens (it is not in pending).
    child.emit('message', { id, kind: 'result', payload: 'late' })
    await host.stop()
  })

  it('returns a result that arrives before the limit as it is', async () => {
    const host = await newHost()
    const pending = host.invoke('test.host', 'ping', null)
    await vi.waitFor(() => expect(children[0]?.posted.some((message) => message.kind === 'invoke')).toBe(true))
    const child = children[0]!
    const id = child.posted.find((message) => message.kind === 'invoke')?.id ?? -1
    child.emit('message', { id, kind: 'result', payload: 'pong' })
    await expect(pending).resolves.toBe('pong')
    await host.stop()
  })

  it('review 56-6: aborting the signal rejects without waiting for the limit and drops a late result; does not start if already aborted', async () => {
    const host = await newHost()
    const controller = new AbortController()
    const pending = host.invoke('test.host', 'ping', null, 'command', 60_000, controller.signal)
    await vi.waitFor(() => expect(children[0]?.posted.some((message) => message.kind === 'invoke')).toBe(true))
    controller.abort()
    await expect(pending).rejects.toThrow('plugin invoke aborted')
    const child = children[0]!
    const id = child.posted.find((message) => message.kind === 'invoke')?.id ?? -1
    child.emit('message', { id, kind: 'result', payload: 'late' })
    await expect(host.invoke('test.host', 'ping', null, 'command', 60_000, controller.signal)).rejects.toThrow('plugin invoke aborted')
    expect(child.posted.filter((message) => message.kind === 'invoke')).toHaveLength(1)
    await host.stop()
  })
})

describe('resetting the crash count (TODO 573)', () => {
  it('resets to 0 when it survives 60 seconds after being restarted following a crash', async () => {
    const { CRASH_RESET_MS } = await import('../src/main/plugin/host.js')
    const host = await newHost()
    void host.invoke('test.host', 'ping', null).catch(() => undefined)
    await vi.waitFor(() => expect(host.summaries()[0]?.host).toBe('running'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    children[0]!.emit('exit', 1)
    expect(host.summaries()[0]?.crashes).toBe(1)
    // Restart (2 seconds later) → ready.
    await vi.advanceTimersByTimeAsync(2_100)
    await untilForked(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(children).toHaveLength(2)
    expect(host.summaries()[0]?.crashes).toBe(1)
    await vi.advanceTimersByTimeAsync(CRASH_RESET_MS - 1_000)
    expect(host.summaries()[0]?.crashes).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(host.summaries()[0]?.crashes).toBe(0)
    vi.useRealTimers()
    await host.stop()
  })

  it('does not reset the count when it crashes before 60 seconds', async () => {
    const host = await newHost()
    void host.invoke('test.host', 'ping', null).catch(() => undefined)
    await vi.waitFor(() => expect(host.summaries()[0]?.host).toBe('running'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    children[0]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(2_100)
    await untilForked(2)
    await vi.advanceTimersByTimeAsync(30_000)
    children[1]!.emit('exit', 1)
    expect(host.summaries()[0]?.crashes).toBe(2)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(host.summaries()[0]?.crashes).toBe(2)
    vi.useRealTimers()
    await host.stop()
  })
})
