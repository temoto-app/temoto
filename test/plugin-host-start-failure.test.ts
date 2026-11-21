/**
 * TODO 1069: kills a plugin-host child process that failed to start (the ready timeout, or a load failure with error id 0).
 * Uses a fake utilityProcess (the same shape as `plugin-host-stop.test.ts`).
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
  readonly stderr = null
  postMessage(): void {}
  /** If true, the child ignores SIGTERM (no exit comes). */
  ignoreKill = false
  kill(): void {
    this.killed += 1
    if (!this.ignoreKill) setTimeout(() => this.emit('exit', 0), 5)
  }
}

const children: FakeChild[] = []
/** 'silent' = sends nothing (timeout) / 'error' = sends a load failure */
let mode: 'silent' | 'error' = 'silent'
let ignoreKill = false

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild()
      child.ignoreKill = ignoreKill
      children.push(child)
      if (mode === 'error') setTimeout(() => child.emit('message', { id: 0, kind: 'error', payload: 'load failed' }), 0)
      return child
    }
  }
}))


/**
 * TODO 1227 fix X: an outside extension recomputes its identity right before it is started (a hash of the whole directory, `fs/promises`), so fork comes after real I/O.
 * Wait for fork before advancing the fake clock (setImmediate is not faked).
 */
async function untilForked(count: number): Promise<void> {
  for (let i = 0; i < 1000 && children.length < count; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

let dir: string
let db: Db

beforeEach(() => {
  children.length = 0
  ignoreKill = false
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-startfail-'))
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

async function makeHost() {
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

describe('does not leave a plugin-host that failed to start behind (TODO 1069)', () => {
  it('kill is called after the ready timeout', async () => {
    mode = 'silent'
    const host = await makeHost()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = host.invoke('test.host', 'ping', null).then(
      () => 'ok',
      (e: Error) => e.message
    )
    await untilForked(1)
    await vi.advanceTimersByTimeAsync(10_100)
    expect(await result).toBe('plugin host timeout')
    expect(children).toHaveLength(1)
    expect(children[0]!.killed).toBe(1)
  })

  it('kill is also called after a load failure (error id 0)', async () => {
    mode = 'error'
    const host = await makeHost()
    await expect(host.invoke('test.host', 'ping', null)).rejects.toThrow('load failed')
    expect(children).toHaveLength(1)
    expect(children[0]!.killed).toBe(1)
  })

  it('even if the child ignores kill, reject returns immediately without waiting for exit (kill once)', async () => {
    mode = 'error'
    ignoreKill = true
    const host = await makeHost()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = host.invoke('test.host', 'ping', null).then(
      () => 'ok',
      (e: Error) => e.message
    )
    // Solved in a time that does not reach STOP_WAIT_MS (2 seconds).
    await untilForked(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toBe('load failed')
    expect(children).toHaveLength(1)
    expect(children[0]!.killed).toBe(1)
    await vi.advanceTimersByTimeAsync(3000)
  })
})
