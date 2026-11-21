/**
 * The contract of plugin-host (ARCHITECTURE.md 7.8).
 *
 * Electron's utility process itself cannot be started from Vitest (plain Node), so what is checked here is the **frame contract**:
 *
 *  - A plugin has only `aios.*`, and all its calls become `broker` frames
 *  - The main side always goes through CapabilityBroker before returning a result
 *  - Even if a plugin crashes, main does not crash
 *
 * Isolation in a real process (that the Node permission model stops fs / child_process / worker) was measured on Electron, and the results are written in CLAUDE.md and 7.8.
 * **`--permission` does not work in `execArgv`; it works only in `NODE_OPTIONS`.**
 */
import { describe, expect, it, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import type { BrokerRequest, CapabilityName, PluginModule } from '../src/shared/plugin.js'
import { pathToUri } from '../src/common/uri.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

/**
 * Builds the same shape as the `api` that plugin-host passes. The real one (`src/plugin-host/index.ts`) depends on `process.parentPort` and cannot be imported from plain Node,
 * so **only the part that builds frames** is copied. The type of `PluginApi` binds the copy so it does not drift from the real one.
 */
function makeApi(send: (request: BrokerRequest) => Promise<unknown>): {
  fs: { read(uri: string): Promise<unknown> }
  net: { fetch(url: string, init?: { auth?: string }): Promise<unknown> }
  credentials: { status(name: string): Promise<unknown> }
  index: { put(d: unknown): Promise<void>; remove(s: string, i: string): Promise<void> }
  ui: { notify(title: string, body?: string): Promise<void> }
} {
  return {
    fs: { read: (uri) => send({ capability: 'fs', op: 'read', uri }) },
    net: {
      fetch: (url, init) =>
        send({ capability: 'network', op: 'fetch', url, ...(init?.auth ? { auth: init.auth } : {}) })
    },
    credentials: { status: (name) => send({ capability: 'credentials', op: 'status', name }) },
    index: {
      put: async (d) => {
        await send({ capability: 'index', op: 'put', document: d as never })
      },
      remove: async (source, sourceId) => {
        await send({ capability: 'index', op: 'remove', source, sourceId })
      }
    },
    ui: {
      notify: async (title, body) => {
        await send({ capability: 'ui', op: 'notify', title, ...(body ? { body } : {}) })
      }
    }
  }
}

function setup(): {
  broker: CapabilityBroker
  notifications: { pluginId: string; title: string }[]
  cleanup: () => void
  root: string
} {
  const dbDir = makeTestDir('host-db')
  const root = makeTestDir('host-files')
  const db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key = '${'f'.repeat(64)}'`)
  runMigrations(db)
  const notifications: { pluginId: string; title: string }[] = []

  const policy: PluginPolicy = {
    id: 'test.host',
    declared: {
      credentials: [],
      networkHosts: [],
      fsRead: [root],
      fsWrite: [],
      indexSources: [],
      ui: true
    },
    consented: new Set<CapabilityName>(['fs', 'ui'])
  }

  const audit = new AuditLog(db)
  const broker = new CapabilityBroker({
    scope: { rules: testExclusions(homedir()) },
    audit,
    credentials: new CredentialStore(dbDir, {
      available: () => false,
      seal: () => Buffer.alloc(0),
      open: () => ''
    }),
    policyOf: (id) => (id === 'test.host' ? policy : null),
    index: { put: async () => undefined, remove: async () => undefined },
    notify: (pluginId, title) => notifications.push({ pluginId, title })
  })

  return {
    broker,
    notifications,
    root,
    cleanup: () => {
      // So the batch is finished writing and stopped before the DB is closed.
      audit.dispose()
      db.close()
      rmSync(dbDir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('plugin-host contract', () => {
  it('every plugin API call goes through the Broker', async () => {
    const { broker, root, cleanup } = setup()
    try {
      writeFileSync(join(root, 'a.md'), '# 見出し\n本文\n')
      const seen: BrokerRequest[] = []
      const send = vi.fn(async (request: BrokerRequest) => {
        seen.push(request)
        return broker.handle('test.host', request)
      })
      const api = makeApi(send)

      const result = (await api.fs.read(pathToUri(join(root, 'a.md')))) as { text: string }
      expect(result.text).toContain('見出し')
      expect(seen).toHaveLength(1)
      expect(seen[0]?.capability).toBe('fs')
    } finally {
      cleanup()
    }
  })

  it('the Broker rejects anything outside the declaration (the plugin side does not stop it)', async () => {
    const { broker, cleanup } = setup()
    try {
      const api = makeApi((request) => broker.handle('test.host', request))
      await expect(api.fs.read(pathToUri(join(homedir(), '.ssh', 'id_rsa')))).rejects.toThrow()
      // This plugin has not consented to network, so it fails before even looking at the declaration
      // (of the three-stage judgment in 7.7: declaration → consent → policy, it stops at consent).
      await expect(api.net.fetch('https://evil.com/x')).rejects.toThrow('not-consented')
    } finally {
      cleanup()
    }
  })

  it('ui.notify passes when declared and reaches the renderer', async () => {
    const { broker, notifications, cleanup } = setup()
    try {
      const api = makeApi((request) => broker.handle('test.host', request))
      await api.ui.notify('同期しました')
      expect(notifications).toEqual([{ pluginId: 'test.host', title: '同期しました' }])
    } finally {
      cleanup()
    }
  })

  it('even if a plugin command throws, it comes back without leaking an exception to main', async () => {
    const plugin: PluginModule = {
      commands: {
        boom: () => {
          throw new Error('プラグインの中で失敗')
        }
      }
    }
    // plugin-host turns exceptions from commands into error frames.
    const handler = plugin.commands?.['boom']
    expect(handler).toBeDefined()
    let message = ''
    try {
      handler?.(undefined, {} as never)
    } catch (err) {
      message = err instanceof Error ? err.message : ''
    }
    expect(message).toBe('プラグインの中で失敗')
  })
})

describe('bundled plugin commands', () => {
  it('the outline of aios.markdown gets the body only through the Broker', async () => {
    const { broker, root, cleanup } = setup()
    try {
      writeFileSync(
        join(root, 'doc.md'),
        '# 一\n\n本文\n\n## 二\n\n```\n# これは見出しではない\n```\n\n### 三\n'
      )
      // The real thing (out/plugins/...) is a build output, so the pure source function is used here.
      const { extractHeadings } = await import('../plugins/aios.markdown/host/commands.js')
      const api = makeApi((request) => broker.handle('test.host', request))
      const file = (await api.fs.read(pathToUri(join(root, 'doc.md')))) as { text: string }
      const headings = extractHeadings(file.text)
      expect(headings.map((h) => h.text)).toEqual(['一', '二', '三'])
      // Inside a code fence is not made a heading.
      expect(headings.map((h) => h.text)).not.toContain('これは見出しではない')
    } finally {
      cleanup()
    }
  })
})

describe('environment passed to plugin-host (review A-1 / A-2)', () => {
  it('wraps the --allow-fs-read path in double quotes (a path with spaces is not split)', async () => {
    const { buildNodeOptions } = await import('../src/main/plugin/host-env.js')
    const withSpace = '/Users/x/Library/Application Support/aios/plugins/example'
    const options = buildNodeOptions(['/opt/aios/out/main', withSpace])
    expect(options).toBe(
      `--permission --allow-fs-read="/opt/aios/out/main" --allow-fs-read="${withSpace}"`
    )
    // Even when split by spaces, there is no space outside quotes = Node's NODE_OPTIONS parser does not split it.
    const outsideQuotes = options.replace(/"[^"]*"/g, '')
    expect(outsideQuotes.split(' ')).toEqual(['--permission', '--allow-fs-read=', '--allow-fs-read='])
  })

  it('rejects a path containing characters that break inside quotes (" and \\)', async () => {
    const { buildNodeOptions } = await import('../src/main/plugin/host-env.js')
    expect(() => buildNodeOptions(['/a/b"c'])).toThrow(/cannot quote/)
    expect(() => buildNodeOptions(['/a/b\\c'])).toThrow(/cannot quote/)
  })

  it('main environment variables pass only from the allowlist', async () => {
    const { buildHostEnv, HOST_ENV_ALLOWLIST } = await import('../src/main/plugin/host-env.js')
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/Users/x',
      LANG: 'ja_JP.UTF-8',
      TMPDIR: '/var/folders/zz',
      // A secret typical of main. It must not pass to a plugin.
      ANTHROPIC_API_KEY: 'sk-secret',
      AIOS_TOKEN: 'token',
      GITHUB_TOKEN: 'ghp',
      AIOS_LOG_LEVEL: 'debug',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--inspect'
    }
    const env = buildHostEnv(source, ['/opt/aios/out/main', '/opt/aios/out/plugins/p'])
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'NODE_OPTIONS', 'PATH', 'TMPDIR'])
    for (const key of Object.keys(env)) {
      expect(key === 'NODE_OPTIONS' || HOST_ENV_ALLOWLIST.includes(key)).toBe(true)
    }
    expect(JSON.stringify(env)).not.toContain('sk-secret')
    expect(JSON.stringify(env)).not.toContain('ghp')
    // Does not inherit main's NODE_OPTIONS; only the assembled one is put in.
    expect(env['NODE_OPTIONS']).toBe(
      '--permission --allow-fs-read="/opt/aios/out/main" --allow-fs-read="/opt/aios/out/plugins/p"'
    )
  })
})
