/**
 * TODO 847 (ARCHITECTURE 7.6.7): calls the fixture plugin's tools through the real `PluginHost` + relay (`PluginToolRelay`).
 *
 * A utility process cannot be started from vitest, so `electron` is replaced and `fork` returns a fake child
 * (the same shape as `test/plugin-host-invoke.test.ts`).
 *  - Only the tools of an enabled plugin appear in the list; disabling removes them; calling a tool is refused (plugin-host is not started)
 *  - A call becomes `invoke` to plugin-host (kind `mcp`, with the arguments checked again), and the result comes back
 *  - If plugin-host crashes in the middle of a call, it returns an error JSON (it does not throw)
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
import type { AuditEntry } from '../src/shared/plugin.js'

interface Posted {
  id: number
  kind: string
  payload?: { kind?: string; command?: string; arg?: unknown }
}

class FakeChild extends EventEmitter {
  readonly stderr = null
  readonly posted: Posted[] = []
  postMessage(message: Posted): void {
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
      setTimeout(
        () => child.emit('message', { id: 0, kind: 'ready', payload: { commands: [], mcp: ['fetchPage', 'send'], indexer: [] } }),
        0
      )
      return child
    }
  }
}))

let dir: string
let db: Db

beforeEach(() => {
  children.length = 0
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-tools-'))
  const pluginDir = join(dir, 'user', 'test.tools')
  mkdirSync(join(pluginDir, 'host'), { recursive: true })
  // Fixture plugin: one read-only tool and one tool with side effects.
  writeFileSync(
    join(pluginDir, 'manifest.json'),
    JSON.stringify({
      id: 'test.tools',
      name: 'Tools',
      version: '1.0.0',
      host: { entry: 'host/index.js' },
      mcp: {
        tools: [
          {
            name: 'fetchPage',
            description: 'Fetch a page.',
            inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
          },
          { name: 'send', description: 'Send.', inputSchema: { type: 'object' }, sideEffect: true }
        ]
      }
    })
  )
  writeFileSync(join(pluginDir, 'host', 'index.js'), 'export const mcp = {}\n')
  mkdirSync(join(dir, 'host-entry'), { recursive: true })
  db = new Database(':memory:')
  runMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function setup(): Promise<{
  host: InstanceType<typeof import('../src/main/plugin/host.js').PluginHost>
  relay: InstanceType<typeof import('../src/main/plugin/tools.js').PluginToolRelay>
  audit: AuditEntry[]
}> {
  const { PluginHost } = await import('../src/main/plugin/host.js')
  const { PluginToolRelay } = await import('../src/main/plugin/tools.js')
  const host = new PluginHost({
    db,
    bundledDir: join(dir, 'bundled'),
    userDir: join(dir, 'user'),
    hostEntry: join(dir, 'host-entry', 'plugin-host.js'),
    broker: () => ({}) as unknown as CapabilityBroker,
    onChanged: () => undefined
  })
  host.load()
  const audit: AuditEntry[] = []
  const relay = new PluginToolRelay({ source: host, audit: { record: (entry) => audit.push(entry) } })
  return { host, relay, audit }
}

function invokeOf(child: FakeChild | undefined): Posted | undefined {
  return child?.posted.find((message) => message.kind === 'invoke')
}

describe('PluginHost の道具 (TODO 847)', () => {
  it('有効な plugin の道具を並べ、無効にすると消えて、呼ぶと plugin-host を起こさずに拒む', async () => {
    const { host, relay } = await setup()
    expect(relay.list().map((tool) => tool.name)).toEqual(['test_tools__fetchPage', 'test_tools__send'])
    host.setEnabled('test.tools', false)
    expect(relay.list()).toEqual([])
    expect(relay.prepare('test_tools__fetchPage', { url: 'x' })).toMatchObject({ ok: false })
    expect(children).toHaveLength(0)
    host.setEnabled('test.tools', true)
    expect(relay.list()).toHaveLength(2)
    await host.stop()
  })

  it('呼び出しは mcp 区分の invoke になり、結果が返る', async () => {
    const { host, relay, audit } = await setup()
    const prepared = relay.prepare('test_tools__fetchPage', { url: 'https://example.com' })
    if (!prepared.ok) throw new Error('not prepared')
    const pending = relay.run(prepared.tool, prepared.args)
    await vi.waitFor(() => expect(invokeOf(children[0])).toBeDefined())
    const invoke = invokeOf(children[0])!
    expect(invoke.payload).toEqual({ kind: 'mcp', command: 'fetchPage', arg: { url: 'https://example.com' } })
    children[0]!.emit('message', { id: invoke.id, kind: 'result', payload: 'page text' })
    expect(await pending).toEqual({ text: 'page text' })
    expect(audit.at(-1)).toMatchObject({ pluginId: 'test.tools', target: 'fetchPage', decision: 'allow' })
    await host.stop()
  })

  it('呼び出しの途中で plugin-host が落ちたら、エラーの JSON を返す', async () => {
    const { host, relay, audit } = await setup()
    const prepared = relay.prepare('test_tools__send', {})
    if (!prepared.ok) throw new Error('not prepared')
    const pending = relay.run(prepared.tool, prepared.args)
    await vi.waitFor(() => expect(invokeOf(children[0])).toBeDefined())
    children[0]!.emit('exit', 1)
    expect(await pending).toEqual({ error: 'the plugin stopped while running this tool' })
    expect(audit.at(-1)).toMatchObject({ target: 'send', decision: 'deny', reason: 'crashed' })
    await host.stop()
  })
})
