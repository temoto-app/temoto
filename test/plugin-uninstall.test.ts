/**
 * TODO 1233 (wave 86 bundle A, ARCHITECTURE 7.2 / 7.7 / 6.2.6):
 *  - A capability consent (`plugin_consents`) is bound to the extension identity at the time it was decided (`owner_identity` in migration 40) and applies only while that identity holds.
 *    An outside extension must consent again when its contents change (update or replacement). A bundled consent does not apply to an outside extension that claims a bundled id.
 *  - Uninstalling an outside extension (`PluginHost.uninstall`): a bundled one is refused. After the folder is discarded and re-read, the consent, enabled/disabled state, trigger rules,
 *    pending events and setting values are deleted in one transaction. If the folder cannot be discarded, nothing is deleted and it stays disabled. Restoring from the trash does not revive the rows.
 * plugin-host is not started (electron is a fake). **Neither the model nor the CLI is called.**
 */
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import type { CapabilityBroker } from '../src/main/capability/broker.js'
import type { PluginHostDeps } from '../src/main/plugin/host.js'
import type { PluginSummary } from '../src/shared/plugin.js'
import { TriggerStore, hashTriggerKey } from '../src/main/trigger/store.js'
import { TriggerService, type TriggerSourceEntry } from '../src/main/trigger/service.js'
import { PluginSettingsStore, type StoredPluginSettings } from '../src/main/plugin/settings.js'
import { PluginToolRelay } from '../src/main/plugin/tools.js'
import { DEFAULT_TRIGGER_RULE } from '../src/shared/trigger.js'
import { parseReason } from '../src/shared/reason.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => ({}) } }))

let dir: string
let db: Db

function writePlugin(root: string, name: string, manifest: Record<string, unknown>, extra: Record<string, string> = {}): string {
  const pluginDir = join(root, name)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest))
  for (const [file, body] of Object.entries(extra)) writeFileSync(join(pluginDir, file), body)
  return pluginDir
}

const EXTERNAL = {
  id: 'test.ext',
  name: 'Ext',
  version: '1.0.0',
  capabilities: { ui: {}, network: { hosts: ['api.example.com'] }, browser: { hosts: ['example.com'] } },
  mcp: { entry: 'host.js', tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }] },
  triggers: [{ id: 'new-mail', name: 'New mail' }]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-uninstall-'))
  mkdirSync(join(dir, 'bundled'), { recursive: true })
  mkdirSync(join(dir, 'user'), { recursive: true })
  db = new Database(':memory:')
  runMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function makeHost(extra: Partial<PluginHostDeps> = {}) {
  const { PluginHost } = await import('../src/main/plugin/host.js')
  const host = new PluginHost({
    db,
    bundledDir: join(dir, 'bundled'),
    userDir: join(dir, 'user'),
    hostEntry: join(dir, 'host-entry', 'plugin-host.js'),
    broker: () => ({}) as unknown as CapabilityBroker,
    onChanged: () => undefined,
    ...extra
  })
  host.load()
  await host.identitiesReady()
  return host
}

function consentRow(pluginId: string, capability: string): { decision: string; owner_identity: string | null } | undefined {
  return db
    .prepare(`SELECT decision, owner_identity FROM plugin_consents WHERE plugin_id = ? AND capability = ?`)
    .get(pluginId, capability) as { decision: string; owner_identity: string | null } | undefined
}

function codeOf(err: unknown): string | null {
  return parseReason(err instanceof Error ? err.message : '')?.code ?? null
}

describe('capability consent is bound to the extension identity (TODO 1233 part 2)', () => {
  it('external extension: consent stays under the current identity and stops taking effect when the content changes (consent is asked again)', async () => {
    const pluginDir = writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const host = await makeHost()
    const identity = host.identityOf('test.ext')
    expect(identity).toMatch(/^sha256:/)
    expect(host.setConsent('test.ext', 'network', true)).toBe(true)
    expect(consentRow('test.ext', 'network')).toEqual({ decision: 'granted', owner_identity: identity })
    expect(host.policyOf('test.ext')?.consented.has('network')).toBe(true)

    // Adding just one non-entry file makes it different contents (an update and `.DS_Store` are treated the same way — the closing side).
    writeFileSync(join(pluginDir, 'extra.js'), 'export {}')
    await host.computeIdentities()
    expect(host.identityOf('test.ext')).not.toBe(identity)
    expect(host.policyOf('test.ext')?.consented.has('network')).toBe(false)
    expect(host.summaries().find((p) => p.id === 'test.ext')?.consented).toEqual([])

    // Going back to the original contents makes the consent decided for those contents apply again (same contents = same identity).
    rmSync(join(pluginDir, 'extra.js'))
    await host.computeIdentities()
    expect(host.policyOf('test.ext')?.consented.has('network')).toBe(true)
  })

  it('if replaced by a different thing with the same id and the same manifest (different content), the previous consent does not take effect on the next startup', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const first = await makeHost()
    first.setConsent('test.ext', 'network', true)
    rmSync(join(dir, 'user', 'ext'), { recursive: true })
    writePlugin(join(dir, 'user', 'other'), '', EXTERNAL, { 'host.js': 'export const mcp = { evil: true }' })
    const second = await makeHost()
    expect(second.manifestOf('test.ext')).not.toBeNull()
    expect(second.policyOf('test.ext')?.consented.has('network')).toBe(false)
  })

  it('does not grant to an external extension before the identity is computed or when it is unreadable (it would have no effect, so nothing is written); revokes are accepted', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
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
    // Not computed yet (the synchronous `identityOf` returns null).
    expect(host.identityOf('test.ext')).toBeNull()
    expect(host.setConsent('test.ext', 'network', true)).toBe(false)
    expect(consentRow('test.ext', 'network')).toBeUndefined()
    expect(host.setConsent('test.ext', 'network', false)).toBe(false)
    expect(consentRow('test.ext', 'network')?.decision).toBe('denied')
    await host.identitiesReady()
  })

  it('rows from before migration 40: bundled gets bundled added and keeps working, external does not (asked again)', async () => {
    writePlugin(join(dir, 'bundled'), 'b', { id: 'test.bundled', name: 'B', version: '1.0.0', capabilities: { ui: {}, fs: {} } })
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const insert = db.prepare(`INSERT INTO plugin_consents (plugin_id, capability, decision, at) VALUES (?, ?, ?, ?)`)
    insert.run('test.bundled', 'ui', 'denied', 1)
    insert.run('test.ext', 'network', 'granted', 1)
    const host = await makeHost()
    // Bundled: a revocation (denied) is kept by writing it on top, and fs with no row is granted (as in TODO 1070).
    expect(consentRow('test.bundled', 'ui')).toEqual({ decision: 'denied', owner_identity: 'bundled' })
    expect(host.policyOf('test.bundled')?.consented.has('ui')).toBe(false)
    expect(host.policyOf('test.bundled')?.consented.has('fs')).toBe(true)
    // Outside: old rows are not written again and do not apply.
    expect(consentRow('test.ext', 'network')).toEqual({ decision: 'granted', owner_identity: '' })
    expect(host.policyOf('test.ext')?.consented.has('network')).toBe(false)
  })

  it('consent of the bundled one does not take effect for an external extension that claimed the same id on a startup where the bundled one could not be read', async () => {
    const bundledDir = writePlugin(join(dir, 'bundled'), 'b', { id: 'test.same', name: 'B', version: '1.0.0', capabilities: { ui: {}, fs: {} } })
    const first = await makeHost()
    expect(first.policyOf('test.same')?.consented.has('fs')).toBe(true)
    // Startup where the bundled one cannot be read + an outside extension claims the same id.
    renameSync(bundledDir, join(dir, 'moved-away'))
    writePlugin(join(dir, 'user'), 'impostor', { id: 'test.same', name: 'B', version: '1.0.0', capabilities: { ui: {}, fs: {} } })
    const second = await makeHost()
    expect(second.isBundled('test.same')).toBe(false)
    expect(second.policyOf('test.same')?.consented.size).toBe(0)
    // A decision written by the outside side (a revocation) does not count as a "decision made" when the bundled one comes back (it is granted again with the bundled value).
    second.setConsent('test.same', 'fs', false)
    rmSync(join(dir, 'user', 'impostor'), { recursive: true })
    renameSync(join(dir, 'moved-away'), bundledDir)
    const third = await makeHost()
    expect(third.policyOf('test.same')?.consented.has('fs')).toBe(true)
  })

  it('if the content is swapped after asking in the approval inbox, the first-time consent (browser) is not recorded', async () => {
    const pluginDir = writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const host = await makeHost()
    const relay = new PluginToolRelay({ source: host, audit: { record: () => undefined } })
    const tool = relay.lookup('test_ext__read') ?? relay.lookup(relay.list()[0]?.name ?? '')
    expect(tool?.pendingConsent).toEqual(['browser'])
    expect(tool?.identity).toBe(host.identityOf('test.ext'))
    // The contents changed while it was being asked.
    writeFileSync(join(pluginDir, 'host.js'), 'export const mcp = { changed: true }')
    await host.computeIdentities()
    expect(relay.grantConsent(tool!)).toBe(false)
    expect(consentRow('test.ext', 'browser')).toBeUndefined()
    // A tool looked up again (the current identity) is recorded.
    const fresh = relay.lookup(tool!.exposedName)
    expect(relay.grantConsent(fresh!)).toBe(true)
    expect(host.policyOf('test.ext')?.consented.has('browser')).toBe(true)
  })
})

describe('uninstalling an external extension (TODO 1233 part 1)', () => {
  function settingsStore(host: { manifestOf(id: string): unknown }, box: { value: StoredPluginSettings }): PluginSettingsStore {
    return new PluginSettingsStore({
      read: () => box.value,
      write: (value) => {
        box.value = value
      },
      configurationOf: () => undefined,
      known: (id) => host.manifestOf(id) !== null,
      identityOf: (id) => (host as unknown as { identityOf(id: string): string | null }).identityOf(id)
    })
  }

  it('refuses a bundled one (it only disables)', async () => {
    writePlugin(join(dir, 'bundled'), 'b', { id: 'test.bundled', name: 'B', version: '1.0.0', capabilities: { ui: {} } })
    const removeDirectory = vi.fn(async () => undefined)
    const host = await makeHost({ removeDirectory })
    await expect(host.uninstall('test.bundled')).rejects.toSatisfy((err: unknown) => codeOf(err) === 'plugin-uninstall-bundled')
    expect(removeDirectory).not.toHaveBeenCalled()
    expect(host.manifestOf('test.bundled')).not.toBeNull()
  })

  it('discards the folder and removes consent, enabled / disabled, trigger rules with pending events, and setting values; rows of other extensions stay', async () => {
    const pluginDir = writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    writePlugin(join(dir, 'user'), 'keep', { ...EXTERNAL, id: 'test.keep' }, { 'host.js': 'export const mcp = {}' })
    const triggerStore = new TriggerStore(db)
    const box: { value: StoredPluginSettings } = { value: { 'test.ext': { a: 1 }, 'test.keep': { b: 2 } } }
    let settings: PluginSettingsStore | null = null
    const removed: string[] = []
    const host = await makeHost({
      removeDirectory: async (path) => {
        removed.push(path)
        rmSync(path, { recursive: true })
      },
      forgetPluginData: (id) => {
        triggerStore.forgetPlugin(id)
        settings?.forget(id)
      }
    })
    settings = settingsStore(host, box)
    host.setConsent('test.ext', 'network', true)
    host.setConsent('test.keep', 'network', true)
    host.setEnabled('test.ext', false)
    host.setEnabled('test.ext', true)
    triggerStore.setRule('test.ext', 'new-mail', { ...DEFAULT_TRIGGER_RULE, enabled: true, instructions: 'x' }, 1, {
      ownerIdentity: host.identityOf('test.ext')
    })
    triggerStore.setRule('test.keep', 'new-mail', { ...DEFAULT_TRIGGER_RULE, enabled: true }, 1, { ownerIdentity: host.identityOf('test.keep') })
    const eventId = triggerStore.insertQueued('test.ext', 'new-mail', hashTriggerKey('k'), 1, { trigger: 'new-mail', title: 't', prompt: 'p' })

    await host.uninstall('test.ext')

    expect(removed).toEqual([pluginDir])
    expect(host.manifestOf('test.ext')).toBeNull()
    expect(consentRow('test.ext', 'network')).toBeUndefined()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM plugin_state WHERE plugin_id = ?`).get('test.ext')).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM trigger_rules WHERE plugin_id = ?`).get('test.ext')).toEqual({ n: 0 })
    expect(db.prepare(`SELECT state, pending FROM trigger_events WHERE id = ?`).get(eventId)).toEqual({ state: 'failed', pending: null })
    expect(box.value).toEqual({ 'test.keep': { b: 2 } })
    // Other extensions are unchanged.
    expect(consentRow('test.keep', 'network')?.decision).toBe('granted')
    expect(triggerStore.rule('test.keep', 'new-mail').enabled).toBe(true)
    expect(host.policyOf('test.keep')?.consented.has('network')).toBe(true)
  })

  it('even if the same content is restored from the trash, neither consent nor rules come back (it starts from the defaults)', async () => {
    const pluginDir = writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const trash = join(dir, 'trash')
    const triggerStore = new TriggerStore(db)
    const host = await makeHost({
      removeDirectory: async (path) => {
        cpSync(path, trash, { recursive: true })
        rmSync(path, { recursive: true })
      },
      forgetPluginData: (id) => {
        triggerStore.forgetPlugin(id)
      }
    })
    const identity = host.identityOf('test.ext')
    host.setConsent('test.ext', 'network', true)
    triggerStore.setRule('test.ext', 'new-mail', { ...DEFAULT_TRIGGER_RULE, enabled: true }, 1, { ownerIdentity: identity })
    await host.uninstall('test.ext')
    cpSync(trash, pluginDir, { recursive: true })
    const again = await makeHost()
    expect(again.identityOf('test.ext')).toBe(identity)
    expect(again.policyOf('test.ext')?.consented.size).toBe(0)
    expect(triggerStore.rule('test.ext', 'new-mail').enabled).toBe(false)
    expect(triggerStore.rule('test.ext', 'new-mail').ownerIdentity).toBeNull()
  })

  it('if the folder cannot be discarded, nothing is removed, it stays disabled, and plugin-uninstall-failed', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const forgetPluginData = vi.fn()
    const host = await makeHost({
      removeDirectory: async () => {
        throw new Error('trash failed')
      },
      forgetPluginData
    })
    host.setConsent('test.ext', 'network', true)
    await expect(host.uninstall('test.ext')).rejects.toSatisfy((err: unknown) => codeOf(err) === 'plugin-uninstall-failed')
    expect(forgetPluginData).not.toHaveBeenCalled()
    expect(consentRow('test.ext', 'network')?.decision).toBe('granted')
    expect(host.summaries().find((p) => p.id === 'test.ext')?.enabled).toBe(false)
    // Still disabled at the next startup (the user meant to delete it).
    const again = await makeHost()
    expect(again.summaries().find((p) => p.id === 'test.ext')?.enabled).toBe(false)
  })

  it('if the row removal stage fails, the consent and enabled / disabled rows are rolled back too (one transaction)', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const host = await makeHost({
      removeDirectory: async (path) => rmSync(path, { recursive: true }),
      forgetPluginData: () => {
        throw new Error('not ready')
      }
    })
    host.setConsent('test.ext', 'network', true)
    await expect(host.uninstall('test.ext')).rejects.toSatisfy((err: unknown) => codeOf(err) === 'plugin-uninstall-failed')
    expect(consentRow('test.ext', 'network')?.decision).toBe('granted')
  })

  it('while discarding, enabling and granting consent are refused, and rows written in the meantime are removed at the end', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const host = await makeHost({
      removeDirectory: async (path) => {
        await gate
        rmSync(path, { recursive: true })
      }
    })
    const pending = host.uninstall('test.ext')
    await Promise.resolve()
    host.setEnabled('test.ext', true)
    expect(host.summaries().find((p) => p.id === 'test.ext')?.enabled).toBe(false)
    expect(host.setConsent('test.ext', 'network', true)).toBe(false)
    expect(consentRow('test.ext', 'network')).toBeUndefined()
    // A second call is refused.
    await expect(host.uninstall('test.ext')).rejects.toSatisfy((err: unknown) => codeOf(err) === 'plugin-uninstall-failed')
    release()
    await pending
    expect(host.manifestOf('test.ext')).toBeNull()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM plugin_state WHERE plugin_id = ?`).get('test.ext')).toEqual({ n: 0 })
    // After it is gone, consent cannot be written either.
    expect(host.setConsent('test.ext', 'network', true)).toBe(false)
  })

  it('does not remove something that is not directly under the store (read from the bundled location) or an unknown id', async () => {
    const removeDirectory = vi.fn(async () => undefined)
    const host = await makeHost({ removeDirectory })
    await expect(host.uninstall('nope.missing')).rejects.toSatisfy((err: unknown) => codeOf(err) === 'invalid-value')
    expect(removeDirectory).not.toHaveBeenCalled()
  })
})

describe('TriggerService.dropPlugin (TODO 1233, wave 86 fix Y)', () => {
  it("removes that extension's events from the queue (the rows are removed by TriggerStore.forgetPlugin); keeps those of other extensions", async () => {
    const store = new TriggerStore(db)
    const entries: TriggerSourceEntry[] = ['test.ext', 'test.keep'].map((pluginId) => ({
      pluginId,
      pluginName: pluginId,
      enabled: true,
      triggers: [{ id: 'new-mail', name: 'New mail' }],
      identity: 'bundled',
      bundled: true
    }))
    const service = new TriggerService(
      store,
      { entries: () => entries },
      { run: async () => 't1', isUnattended: () => true, hasRoom: () => false },
      { autoRun: true, cwdAllowed: () => true, setInterval: () => 0, clearInterval: () => undefined }
    )
    for (const entry of entries) store.setRule(entry.pluginId, 'new-mail', { ...DEFAULT_TRIGGER_RULE, enabled: true }, 1, { ownerIdentity: 'bundled' })
    service.start()
    await service.emit('test.ext', { trigger: 'new-mail', key: 'a', title: 't', prompt: 'p' })
    await service.emit('test.keep', { trigger: 'new-mail', key: 'b', title: 't', prompt: 'p' })
    expect(service.overview().queued).toBe(2)
    store.forgetPlugin('test.ext')
    service.dropPlugin('test.ext')
    expect(service.overview().queued).toBe(1)
    expect(store.rule('test.ext', 'new-mail').enabled).toBe(false)
    expect(store.rule('test.keep', 'new-mail').enabled).toBe(true)
    await service.stop()
  })
})

describe('wave 86 fix Y (code-review)', () => {
  async function bareHost(extra: Partial<PluginHostDeps> = {}) {
    const { PluginHost } = await import('../src/main/plugin/host.js')
    const host = new PluginHost({
      db,
      bundledDir: join(dir, 'bundled'),
      userDir: join(dir, 'user'),
      hostEntry: join(dir, 'host-entry', 'plugin-host.js'),
      broker: () => ({}) as unknown as CapabilityBroker,
      onChanged: () => undefined,
      ...extra
    })
    host.load()
    return host
  }

  it('1. when the identity is first decided right after startup, distributes summaries to the screen (the consent from the previous startup appears to take effect)', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const first = await makeHost()
    expect(first.setConsent('test.ext', 'network', true)).toBe(true)
    const sent: (readonly PluginSummary[])[] = []
    const onIdentityChanged = vi.fn()
    const second = await bareHost({ onChanged: (list) => sent.push(list), onIdentityChanged })
    // Before the computation: consent does not apply yet (closing side).
    expect(second.summaries().find((p) => p.id === 'test.ext')?.consented).toEqual([])
    await second.identitiesReady()
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.at(-1)?.find((p) => p.id === 'test.ext')?.consented).toEqual(['network'])
    // Only decided for the first time (nothing changed), so the rule matching is not called.
    expect(onIdentityChanged).not.toHaveBeenCalled()
  })

  it('1. when it is decided while still unreadable (null), it does not distribute (the appearance does not change)', async () => {
    const pluginDir = writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    writeFileSync(join(dir, 'outside.txt'), 'x')
    symlinkSync(join(dir, 'outside.txt'), join(pluginDir, 'link.txt'))
    const onChanged = vi.fn()
    const host = await bareHost({ onChanged })
    await host.identitiesReady()
    expect(host.identityOf('test.ext')).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('2. if the row removal stage fails, it does not call the reflection into the in-memory copy (onPluginForgotten)', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const onPluginForgotten = vi.fn()
    const host = await makeHost({
      removeDirectory: async (path) => rmSync(path, { recursive: true }),
      forgetPluginData: () => {
        throw new Error('db failed')
      },
      onPluginForgotten
    })
    await expect(host.uninstall('test.ext')).rejects.toSatisfy((err: unknown) => codeOf(err) === 'plugin-uninstall-failed')
    expect(onPluginForgotten).not.toHaveBeenCalled()
  })

  it('2. the queue is trimmed after the commit (the rows are already gone); uninstall succeeds even if it throws', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const triggerStore = new TriggerStore(db)
    const seen: { inTransaction: boolean; rules: unknown }[] = []
    const host = await makeHost({
      removeDirectory: async (path) => rmSync(path, { recursive: true }),
      forgetPluginData: (id) => {
        triggerStore.forgetPlugin(id)
      },
      onPluginForgotten: (id) => {
        seen.push({
          inTransaction: db.inTransaction,
          rules: db.prepare(`SELECT COUNT(*) AS n FROM trigger_rules WHERE plugin_id = ?`).get(id)
        })
        throw new Error('after failed')
      }
    })
    triggerStore.setRule('test.ext', 'new-mail', { ...DEFAULT_TRIGGER_RULE, enabled: true }, 1, { ownerIdentity: host.identityOf('test.ext') })
    await host.uninstall('test.ext')
    expect(seen).toEqual([{ inTransaction: false, rules: { n: 0 } }])
    expect(host.manifestOf('test.ext')).toBeNull()
  })

  it('2. even if the whole settings value cannot be read, uninstall does not stop and nothing is written to the settings', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const write = vi.fn()
    let settings: PluginSettingsStore | null = null
    const host = await makeHost({
      removeDirectory: async (path) => rmSync(path, { recursive: true }),
      forgetPluginData: (id) => settings?.forget(id)
    })
    settings = new PluginSettingsStore({
      read: () => {
        throw new Error('unreadable')
      },
      write,
      configurationOf: () => undefined,
      known: (id) => host.manifestOf(id) !== null,
      identityOf: (id) => host.identityOf(id)
    })
    host.setConsent('test.ext', 'network', true)
    await host.uninstall('test.ext')
    expect(write).not.toHaveBeenCalled()
    expect(consentRow('test.ext', 'network')).toBeUndefined()
  })

  it('3. screen toggle: if the identity is being computed, waits and records bound to the identity at the time of writing', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    const host = await bareHost()
    expect(host.identityOf('test.ext')).toBeNull()
    await host.setConsentByUser('test.ext', 'network', true)
    const identity = host.identityOf('test.ext')
    expect(identity).toMatch(/^sha256:/)
    expect(consentRow('test.ext', 'network')).toEqual({ decision: 'granted', owner_identity: identity })
    expect(host.policyOf('test.ext')?.consented.has('network')).toBe(true)
  })

  it('3. if the identity is unreadable, refuses with plugin-consent-unbound and writes nothing; revokes are accepted; an unknown id is invalid-value', async () => {
    const pluginDir = writePlugin(join(dir, 'user'), 'ext', EXTERNAL, { 'host.js': 'export const mcp = {}' })
    writeFileSync(join(dir, 'outside.txt'), 'x')
    symlinkSync(join(dir, 'outside.txt'), join(pluginDir, 'link.txt'))
    const host = await bareHost()
    await expect(host.setConsentByUser('test.ext', 'network', true)).rejects.toSatisfy(
      (err: unknown) => codeOf(err) === 'plugin-consent-unbound'
    )
    expect(consentRow('test.ext', 'network')).toBeUndefined()
    await host.setConsentByUser('test.ext', 'network', false)
    expect(consentRow('test.ext', 'network')?.decision).toBe('denied')
    await expect(host.setConsentByUser('nope.missing', 'network', true)).rejects.toSatisfy(
      (err: unknown) => codeOf(err) === 'invalid-value'
    )
  })
})
