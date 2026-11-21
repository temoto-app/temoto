/**
 * TODO 1237 (wave 87 bundle D, ARCHITECTURE 7.2 / 7.7 / 7.2.1):
 *  1. Enabled / disabled (`plugin_state`) and the setting values (`plugins.settings`) are also tied to the extension's identity. A different thing with the same id does not inherit the previous values.
 *  2. Uninstalling deletes `plugin_task_state` and the documents the extension wrote to the index (index → canonical copy). The audit log is kept.
 *  3. Even if the transaction that deletes the rows fails, the marker (`plugin_uninstall_pending`) remains, and the next start (`sweepPendingUninstalls`) cleans up.
 * plugin-host is not started (electron is a fake). **Neither the model nor the CLI is called.**
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations, MIGRATIONS } from '../src/common/migrations.js'
import { PLUGIN_SETTINGS, PLUGIN_SETTINGS_OWNERS_KEY } from '../src/common/settings-keys.js'
import { AppSettingsStore } from '../src/common/settings.js'
import type { CapabilityBroker } from '../src/main/capability/broker.js'
import { PluginDocumentStore } from '../src/main/capability/plugin-store.js'
import type { PluginHost, PluginHostDeps } from '../src/main/plugin/host.js'
import { PluginSettingsStore, type StoredPluginSettings } from '../src/main/plugin/settings.js'
import { IndexService } from '../src/index-kernel/service.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { parseReason } from '../src/shared/reason.js'
import type { PluginConfigurationDeclaration } from '../src/shared/plugin-settings.js'

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
  capabilities: { ui: {}, network: { hosts: ['api.example.com'] }, index: { write: ['test.ext:mail'] } },
  mcp: { entry: 'host.js', tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }] }
}
const ENTRY = { 'host.js': 'export const mcp = {}' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-values-'))
  mkdirSync(join(dir, 'bundled'), { recursive: true })
  mkdirSync(join(dir, 'user'), { recursive: true })
  db = new Database(':memory:')
  runMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function makeHost(extra: Partial<PluginHostDeps> = {}, ready = true) {
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
  if (ready) await host.identitiesReady()
  return host
}

function stateRow(id: string): { enabled: number; owner_identity: string | null } | undefined {
  return db.prepare(`SELECT enabled, owner_identity FROM plugin_state WHERE plugin_id = ?`).get(id) as
    | { enabled: number; owner_identity: string | null }
    | undefined
}

function enabledOf(host: { summaries(): readonly { id: string; enabled: boolean }[] }, id: string): boolean | undefined {
  return host.summaries().find((p) => p.id === id)?.enabled
}

function codeOf(err: unknown): string | null {
  return parseReason(err instanceof Error ? err.message : '')?.code ?? null
}

describe('有効 / 無効は拡張機能の同一性に結び付く (TODO 1237 の 1)', () => {
  it('外の拡張機能: 無効にした中身が変わっても無効のまま (閉じる側) で、詳細にその旨が出る。中身が戻れば印は消える', async () => {
    const pluginDir = writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    const host = await makeHost()
    const identity = host.identityOf('test.ext')
    host.setEnabled('test.ext', false)
    expect(stateRow('test.ext')).toEqual({ enabled: 0, owner_identity: identity })
    expect(host.detail('test.ext')?.enabledReset).toBe(false)

    writeFileSync(join(pluginDir, 'extra.js'), 'export {}')
    await host.computeIdentities()
    expect(enabledOf(host, 'test.ext')).toBe(false)
    expect(host.detail('test.ext')?.enabledReset).toBe(true)
    // The row is not deleted (if the contents come back, it takes effect as the disabled state of the same identity).
    expect(stateRow('test.ext')?.owner_identity).toBe(identity)

    rmSync(join(pluginDir, 'extra.js'))
    await host.computeIdentities()
    expect(enabledOf(host, 'test.ext')).toBe(false)
    expect(host.detail('test.ext')?.enabledReset).toBe(false)
  })

  it('次の起動でも同じ: 別の中身に入れ替わった外の拡張機能は無効のまま。有効にし直すと今の同一性で書き直す', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    const first = await makeHost()
    first.setEnabled('test.ext', false)
    rmSync(join(dir, 'user', 'ext'), { recursive: true })
    writePlugin(join(dir, 'user'), 'other', EXTERNAL, { 'host.js': 'export const mcp = { evil: true }' })
    const second = await makeHost()
    expect(enabledOf(second, 'test.ext')).toBe(false)
    expect(second.detail('test.ext')?.enabledReset).toBe(true)
    second.setEnabled('test.ext', true)
    expect(enabledOf(second, 'test.ext')).toBe(true)
    expect(second.detail('test.ext')?.enabledReset).toBe(false)
    expect(stateRow('test.ext')?.owner_identity).toBe(second.identityOf('test.ext'))
  })

  it('計算前の窓では、無効の行は無効のまま (閉じる側)。計算が終われば同じ中身は無効のまま', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    const first = await makeHost()
    first.setEnabled('test.ext', false)
    const second = await makeHost({}, false)
    expect(second.identityOf('test.ext')).toBeNull()
    expect(enabledOf(second, 'test.ext')).toBe(false)
    await second.identitiesReady()
    expect(enabledOf(second, 'test.ext')).toBe(false)
  })

  it('migration 41 より前の行 (同一性なし): 外の無効の行は最初の計算で今の値を書き足して無効のまま。有効の行は既定と同じ', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    writePlugin(join(dir, 'user'), 'other', { ...EXTERNAL, id: 'test.other', capabilities: { ui: {} } }, ENTRY)
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.ext', 0, 1, '')`).run()
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.other', 1, 1, '')`).run()
    const host = await makeHost()
    expect(enabledOf(host, 'test.ext')).toBe(false)
    expect(stateRow('test.ext')).toEqual({ enabled: 0, owner_identity: host.identityOf('test.ext') })
    expect(enabledOf(host, 'test.other')).toBe(true)
  })

  it('同梱: 同一性なしの行は bundled を書き足して効く。外が書いた行 (同梱が読めなかった起動) は効かない', async () => {
    writePlugin(join(dir, 'bundled'), 'b', { id: 'test.bundled', name: 'B', version: '1.0.0', capabilities: { ui: {} } })
    writePlugin(join(dir, 'bundled'), 'c', { id: 'test.bundled2', name: 'C', version: '1.0.0', capabilities: { ui: {} } })
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.bundled', 0, 1, '')`).run()
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.bundled2', 0, 1, 'sha256:aaaa')`).run()
    const host = await makeHost()
    expect(enabledOf(host, 'test.bundled')).toBe(false)
    expect(stateRow('test.bundled')?.owner_identity).toBe('bundled')
    expect(enabledOf(host, 'test.bundled2')).toBe(true)
    expect(host.detail('test.bundled2')?.enabledReset).toBe(false)
    // TODO 1240: the outside disabled row is kept rather than deleted (the closing side). The 'bundled' row the user set on the bundled plugin also remains.
    expect(stateRow('test.bundled2')).toEqual({ enabled: 0, owner_identity: 'sha256:aaaa' })
    expect(stateRow('test.bundled')).toBeDefined()
  })

  it('TODO 1240: 同梱が戻った起動で、外の同一性の有効の行は消える', async () => {
    writePlugin(join(dir, 'bundled'), 'b', { id: 'test.bundled', name: 'B', version: '1.0.0', capabilities: { ui: {} } })
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.bundled', 1, 1, 'sha256:bbbb')`).run()
    const host = await makeHost()
    expect(enabledOf(host, 'test.bundled')).toBe(true)
    expect(stateRow('test.bundled')).toBeUndefined()
  })

  it('TODO 1240: 同梱が戻った起動で、外の同一性の付与の同意は消え、拒否は残る。bundled の行は残る', async () => {
    writePlugin(join(dir, 'bundled'), 'b', { id: 'test.bundled', name: 'B', version: '1.0.0', capabilities: { ui: {} } })
    const ins = db.prepare(`INSERT INTO plugin_consents (plugin_id, capability, decision, at, owner_identity) VALUES ('test.bundled', ?, ?, 1, ?)`)
    ins.run('network', 'granted', 'sha256:ffff')
    ins.run('triggers', 'denied', 'sha256:ffff')
    ins.run('fs', 'denied', 'bundled')
    const consents = (): string[] =>
      (db.prepare(`SELECT capability FROM plugin_consents WHERE plugin_id = 'test.bundled' ORDER BY capability`).all() as { capability: string }[]).map(
        (r) => r.capability
      )
    await makeHost()
    // The outside grant 'network' is removed; the outside denial 'triggers' and bundled 'fs' remain ('ui' is a bundled grant).
    expect(consents()).toEqual(['fs', 'triggers', 'ui'])
  })

  it('TODO 1246: 同梱と外は同じ id でも別の行。同梱のトグル・付与・既定の無効の初回が、残した外の無効の行・拒否の同意を上書きしない', async () => {
    writePlugin(join(dir, 'bundled'), 'b', { id: 'test.bundled', name: 'B', version: '1.0.0', capabilities: { ui: {}, network: { hosts: ['api.example.com'] } } })
    writePlugin(join(dir, 'bundled'), 'g', { id: 'aios.gmail', name: 'G', version: '1.0.0', capabilities: { ui: {} } })
    const insState = db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES (?, 0, 1, 'sha256:ext')`)
    insState.run('test.bundled')
    insState.run('aios.gmail')
    db.prepare(`INSERT INTO plugin_consents (plugin_id, capability, decision, at, owner_identity) VALUES ('test.bundled', 'ui', 'denied', 1, 'sha256:ext')`).run()
    const host = await makeHost()
    // The first run with the default-disabled aios.gmail adds a 'bundled' row, and the outside rows remain.
    const rows = (id: string): { enabled: number; owner_identity: string }[] =>
      db.prepare(`SELECT enabled, owner_identity FROM plugin_state WHERE plugin_id = ? ORDER BY owner_identity`).all(id) as never
    expect(rows('aios.gmail')).toEqual([
      { enabled: 0, owner_identity: 'bundled' },
      { enabled: 0, owner_identity: 'sha256:ext' }
    ])
    // The bundled one is enabled, not dragged down by the outside disabled state; the outside row remains. Toggling does not overwrite the outside row.
    expect(enabledOf(host, 'test.bundled')).toBe(true)
    host.setEnabled('test.bundled', false)
    host.setEnabled('test.bundled', true)
    expect(rows('test.bundled')).toEqual([
      { enabled: 1, owner_identity: 'bundled' },
      { enabled: 0, owner_identity: 'sha256:ext' }
    ])
    // Consent: granting (at start) and revoking the bundled one use only the 'bundled' row. The outside denial remains.
    host.setConsent('test.bundled', 'network', false)
    const consents = (): { capability: string; decision: string; owner_identity: string }[] =>
      db
        .prepare(`SELECT capability, decision, owner_identity FROM plugin_consents WHERE plugin_id = 'test.bundled' ORDER BY capability, owner_identity`)
        .all() as never
    expect(consents()).toEqual([
      { capability: 'network', decision: 'denied', owner_identity: 'bundled' },
      { capability: 'ui', decision: 'granted', owner_identity: 'bundled' },
      { capability: 'ui', decision: 'denied', owner_identity: 'sha256:ext' }
    ])
    // Even at the next start (an outside one arrives on a start where the bundled one cannot be read), the outside denial remains, and the revoked bundled one does not come back.
    await makeHost()
    expect(consents().filter((r) => r.owner_identity === 'sha256:ext')).toEqual([{ capability: 'ui', decision: 'denied', owner_identity: 'sha256:ext' }])
    expect(consents().find((r) => r.capability === 'network')?.decision).toBe('denied')
  })

  it('TODO 1246: 同一性なし (\'\') の同意の行は、同梱では bundled の行が無ければ書き足し、あれば捨てる', async () => {
    writePlugin(join(dir, 'bundled'), 'b', { id: 'test.bundled', name: 'B', version: '1.0.0', capabilities: { ui: {}, network: { hosts: ['api.example.com'] } } })
    const ins = db.prepare(`INSERT INTO plugin_consents (plugin_id, capability, decision, at, owner_identity) VALUES ('test.bundled', ?, ?, 1, ?)`)
    ins.run('ui', 'denied', '')
    ins.run('network', 'denied', '')
    ins.run('network', 'granted', 'bundled')
    await makeHost()
    const all = db.prepare(`SELECT capability, decision, owner_identity FROM plugin_consents WHERE plugin_id = 'test.bundled' ORDER BY capability`).all()
    expect(all).toEqual([
      { capability: 'network', decision: 'granted', owner_identity: 'bundled' },
      { capability: 'ui', decision: 'denied', owner_identity: 'bundled' }
    ])
  })

  it('TODO 1246: 外は今の同一性の行だけを引く。違う同一性の無効の行は無効のまま、今の同一性で有効にし直せば今の行が勝つ', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.ext', 0, 1, 'sha256:old')`).run()
    const host = await makeHost()
    expect(enabledOf(host, 'test.ext')).toBe(false)
    expect(host.detail('test.ext')?.enabledReset).toBe(true)
    host.setEnabled('test.ext', true)
    const again = await makeHost()
    expect(enabledOf(again, 'test.ext')).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM plugin_state WHERE plugin_id = 'test.ext'`).get()).toEqual({ n: 1 })
  })

  it('TODO 1246 (第 89 波 code-review): 外を有効にし直すと古い同一性・\'\' の行が消え、中身が変わっても有効のまま。同梱の行は残る', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    const ins = db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.ext', 0, 1, ?)`)
    ins.run('sha256:old')
    ins.run('')
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.ext', 1, 1, 'bundled')`).run()
    const host = await makeHost()
    host.setEnabled('test.ext', true)
    const rows = db.prepare(`SELECT owner_identity AS o, enabled FROM plugin_state WHERE plugin_id = 'test.ext' ORDER BY o`).all()
    expect(rows).toEqual([
      { o: 'bundled', enabled: 1 },
      { o: host.identityOf('test.ext'), enabled: 1 }
    ].sort((a, b) => String(a.o).localeCompare(String(b.o))))
    // Even if the contents change and the identity changes, the stale disabled row is gone, so it stays enabled.
    db.prepare(`UPDATE plugin_state SET owner_identity = 'sha256:next' WHERE plugin_id = 'test.ext' AND owner_identity != 'bundled'`).run()
    const again = await makeHost()
    expect(enabledOf(again, 'test.ext')).toBe(true)
  })

  it('TODO 1246 (第 89 波 セキュリティレビュー): 同一性が分からない間に有効にしても他の同一性の無効の行は消さない (無効のまま、閉じる側)', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.ext', 0, 1, 'sha256:old')`).run()
    const host = await makeHost({}, false)
    expect(host.identityOf('test.ext')).toBeNull()
    host.setEnabled('test.ext', true)
    await host.identitiesReady()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM plugin_state WHERE plugin_id = 'test.ext' AND owner_identity = 'sha256:old'`).get()).toEqual({ n: 1 })
    const again = await makeHost()
    expect(enabledOf(again, 'test.ext')).toBe(false)
    // Once the identity is known and it is enabled again, the old row is removed and it is enabled.
    again.setEnabled('test.ext', true)
    const third = await makeHost()
    expect(enabledOf(third, 'test.ext')).toBe(true)
  })

  it('TODO 1246 (第 89 波 セキュリティレビュー): 無効と拒否は同一性に関わらず全部の行に効く (同一性が分からない間の取り消しが負けない)', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    const host = await makeHost()
    const current = host.identityOf('test.ext')
    expect(current).not.toBeNull()
    const insState = db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.ext', 1, 1, ?)
      ON CONFLICT(plugin_id, owner_identity) DO UPDATE SET enabled = 1`)
    insState.run(current)
    insState.run('')
    insState.run('sha256:other')
    host.setEnabled('test.ext', false)
    expect(db.prepare(`SELECT owner_identity FROM plugin_state WHERE plugin_id = 'test.ext' AND enabled = 1`).all()).toEqual([])
    const insConsent = db.prepare(`INSERT INTO plugin_consents (plugin_id, capability, decision, at, owner_identity) VALUES ('test.ext', 'network', 'granted', 1, ?)
      ON CONFLICT(plugin_id, capability, owner_identity) DO UPDATE SET decision = 'granted'`)
    insConsent.run(current)
    insConsent.run('')
    const again = await makeHost()
    again.setConsent('test.ext', 'network', false)
    expect(
      db.prepare(`SELECT owner_identity FROM plugin_consents WHERE plugin_id = 'test.ext' AND capability = 'network' AND decision = 'granted'`).all()
    ).toEqual([])
    // The copy (in memory) is the same: no copy of the grant for the current identity remains.
    expect((again as unknown as { consentedOf(id: string): ReadonlySet<string> }).consentedOf('test.ext').has('network')).toBe(false)
  })

  it('TODO 1249: 同梱を無効にしていた id を外が名乗っても、\'bundled\' の無効の行だけでは外は既定の有効で始まる', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.ext', 0, 1, 'bundled')`).run()
    // Even in a window where the identity is not known, the 'bundled' row does not stop the outside one (enabled by default).
    const window = await makeHost({}, false)
    expect(enabledOf(window, 'test.ext')).toBe(true)
    await window.identitiesReady()
    expect(enabledOf(window, 'test.ext')).toBe(true)
    expect(window.detail('test.ext')?.enabledReset).toBe(false)
  })

  it('TODO 1249: 外の他の同一性の無効の行があれば、\'bundled\' の無効の行があっても今までどおり無効のまま (閉じる側)', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    const ins = db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.ext', ?, 1, ?)`)
    ins.run(0, 'bundled')
    ins.run(0, 'sha256:old')
    const host = await makeHost()
    expect(enabledOf(host, 'test.ext')).toBe(false)
    expect(host.detail('test.ext')?.enabledReset).toBe(true)
    // The 'bundled' row is not deleted (the remaining rows are just not counted in the outside judgment).
    expect(db.prepare(`SELECT COUNT(*) AS n FROM plugin_state WHERE plugin_id = 'test.ext' AND owner_identity = 'bundled'`).get()).toEqual({ n: 1 })
  })

  it('TODO 1249: 外を有効にした後の次の起動でも有効のまま。\'bundled\' の行は残る', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES ('test.ext', 0, 1, 'bundled')`).run()
    const first = await makeHost()
    expect(enabledOf(first, 'test.ext')).toBe(true)
    first.setEnabled('test.ext', true)
    expect(enabledOf(first, 'test.ext')).toBe(true)
    const second = await makeHost()
    expect(enabledOf(second, 'test.ext')).toBe(true)
    expect(second.detail('test.ext')?.enabledReset).toBe(false)
    expect(db.prepare(`SELECT enabled FROM plugin_state WHERE plugin_id = 'test.ext' AND owner_identity = 'bundled'`).get()).toEqual({ enabled: 0 })
  })

  it('migration 42 (TODO 1246): 既存の行を壊さず移す。NULL は \'\' になり、もう一度流しても同じ', () => {
    db.exec(`DROP TABLE plugin_state; DROP TABLE plugin_consents;
      CREATE TABLE plugin_state (plugin_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, owner_identity TEXT);
      CREATE TABLE plugin_consents (plugin_id TEXT NOT NULL, capability TEXT NOT NULL, decision TEXT NOT NULL, at INTEGER NOT NULL, owner_identity TEXT, PRIMARY KEY (plugin_id, capability));
      INSERT INTO plugin_state VALUES ('a', 0, 5, NULL), ('b', 1, 6, 'bundled'), ('c', 0, 7, 'sha256:x');
      INSERT INTO plugin_consents VALUES ('a', 'fs', 'denied', 5, NULL), ('b', 'ui', 'granted', 6, 'bundled');`)
    db.pragma('user_version = 41')
    expect(runMigrations(db)).toBeGreaterThanOrEqual(42)
    const state = (): unknown => db.prepare(`SELECT * FROM plugin_state ORDER BY plugin_id`).all()
    const consents = (): unknown => db.prepare(`SELECT * FROM plugin_consents ORDER BY plugin_id, capability`).all()
    const expectedState = [
      { plugin_id: 'a', enabled: 0, updated_at: 5, owner_identity: '' },
      { plugin_id: 'b', enabled: 1, updated_at: 6, owner_identity: 'bundled' },
      { plugin_id: 'c', enabled: 0, updated_at: 7, owner_identity: 'sha256:x' }
    ]
    expect(state()).toEqual(expectedState)
    expect(consents()).toEqual([
      { plugin_id: 'a', capability: 'fs', decision: 'denied', at: 5, owner_identity: '' },
      { plugin_id: 'b', capability: 'ui', decision: 'granted', at: 6, owner_identity: 'bundled' }
    ])
    // The primary key is per identity.
    db.prepare(`INSERT INTO plugin_state VALUES ('b', 0, 9, 'sha256:y')`).run()
    expect(() => db.prepare(`INSERT INTO plugin_state VALUES ('b', 0, 9, 'sha256:y')`).run()).toThrow(/UNIQUE|PRIMARY/)
    db.prepare(`DELETE FROM plugin_state WHERE owner_identity = 'sha256:y'`).run()
    // Rolling the number back and applying again gives the same result (idempotent).
    db.pragma('user_version = 41')
    runMigrations(db)
    expect(state()).toEqual(expectedState)
  })

  it('migration 41 の列と表が入る', () => {
    expect(MIGRATIONS.some((m) => m.version === 41 && m.name === 'plugin-state-owner')).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending`).get()).toEqual({ n: 0 })
  })
})

describe('設定の値は拡張機能の同一性に結び付く (TODO 1237 の 1)', () => {
  const CONFIG: PluginConfigurationDeclaration = {
    title: 'Rules',
    properties: { label: { type: 'string', default: 'x', maxLength: 10, description: 'Label' } }
  }

  function settingsFor(identity: { value: string | null }, box: { value: StoredPluginSettings }): PluginSettingsStore {
    return new PluginSettingsStore({
      read: () => box.value,
      write: (value) => {
        box.value = value
      },
      configurationOf: () => CONFIG,
      known: () => true,
      identityOf: () => identity.value
    })
  }

  it('保存した値は今の同一性のときだけ効く。別の同一性では既定に戻り、view が reset を出し、保存し直すと持ち主が替わる', () => {
    const identity = { value: 'sha256:one' as string | null }
    const box: { value: StoredPluginSettings } = { value: {} }
    const store = settingsFor(identity, box)
    store.update('test.ext', 'label', 'mine')
    expect(store.values('test.ext')).toEqual({ label: 'mine' })
    expect(box.value[PLUGIN_SETTINGS_OWNERS_KEY]).toEqual({ 'test.ext': 'sha256:one' })
    expect(store.view('test.ext')?.reset).toBeUndefined()

    identity.value = 'sha256:two'
    expect(store.values('test.ext')).toEqual({ label: 'x' })
    expect(store.view('test.ext')?.reset).toBe(true)
    expect(store.view('test.ext')?.fields[0]?.value).toBe('x')

    // If the contents come back, the same value takes effect (as with consent).
    identity.value = 'sha256:one'
    expect(store.values('test.ext')).toEqual({ label: 'mine' })

    // Saving one field with a different identity does not mix in the previous value; the owner changes to the current one.
    identity.value = 'sha256:two'
    store.update('test.ext', 'label', 'new')
    expect(box.value['test.ext']).toEqual({ label: 'new' })
    expect(box.value[PLUGIN_SETTINGS_OWNERS_KEY]).toEqual({ 'test.ext': 'sha256:two' })
    identity.value = 'sha256:one'
    expect(store.values('test.ext')).toEqual({ label: 'x' })
  })

  it('同一性が分からない (計算前・読めない) 外の拡張機能は、値を渡さず保存も断る (plugin-settings-unbound)', () => {
    const identity = { value: 'sha256:one' as string | null }
    const box: { value: StoredPluginSettings } = { value: {} }
    const store = settingsFor(identity, box)
    store.update('test.ext', 'label', 'mine')
    identity.value = null
    expect(store.values('test.ext')).toEqual({ label: 'x' })
    expect(store.view('test.ext')?.reset).toBeUndefined()
    let thrown: unknown
    try {
      store.update('test.ext', 'label', 'other')
    } catch (err) {
      thrown = err
    }
    expect(codeOf(thrown)).toBe('plugin-settings-unbound')
    expect(box.value['test.ext']).toEqual({ label: 'mine' })
  })

  it('migration 前の値 (持ち主の記録なし): 同梱は効く、外は引き継がない', () => {
    const identity = { value: 'bundled' as string | null }
    const box: { value: StoredPluginSettings } = { value: { 'test.ext': { label: 'old' } } }
    const store = settingsFor(identity, box)
    expect(store.values('test.ext')).toEqual({ label: 'old' })
    identity.value = 'sha256:one'
    expect(store.values('test.ext')).toEqual({ label: 'x' })
    expect(store.view('test.ext')?.reset).toBe(true)
  })

  it('持ち主の表は plugins.settings の中で読み書きでき、plugin id の形でない鍵・文字列でない同一性は捨てる。forget は持ち主も消す', () => {
    const settings = new AppSettingsStore(db)
    settings.writeTyped(PLUGIN_SETTINGS, {
      'test.ext': { label: 'a' },
      [PLUGIN_SETTINGS_OWNERS_KEY]: { 'test.ext': 'sha256:one', 'not an id': 'x', 'test.num': 5 as unknown as string },
      $other: { a: 1 }
    })
    const stored = settings.readTyped(PLUGIN_SETTINGS)
    expect(stored[PLUGIN_SETTINGS_OWNERS_KEY]).toEqual({ 'test.ext': 'sha256:one' })
    expect(stored['$other']).toBeUndefined()

    const store = new PluginSettingsStore({
      read: () => settings.readTyped(PLUGIN_SETTINGS),
      write: (value) => settings.writeTyped(PLUGIN_SETTINGS, value),
      configurationOf: () => CONFIG,
      known: () => true,
      identityOf: () => 'sha256:one'
    })
    store.forget('test.ext')
    expect(settings.readTyped(PLUGIN_SETTINGS)).toEqual({})
  })
})

describe('アンインストールで消すもの・残るもの (TODO 1237 の 2 / 3)', () => {
  function seed(): void {
    db.prepare(`INSERT INTO plugin_task_state (plugin_id, task_id, state, updated_at) VALUES ('test.ext', 'sync', '{}', 1)`).run()
    db.prepare(`INSERT INTO plugin_task_state (plugin_id, task_id, state, updated_at) VALUES ('test.keep', 'sync', '{}', 1)`).run()
    db.prepare(
      `INSERT INTO audit_log (at, plugin_id, capability, op, target, decision, reason, ms) VALUES (1, 'test.ext', 'network', 'fetch', 'api.example.com', 'allow', NULL, 1)`
    ).run()
  }
  const count = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n

  it('plugin_task_state は消え、監査ログは残る。索引の文書を消す口は行を消した後に 1 回呼ばれ、成功すれば目印は外れる', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    seed()
    const order: string[] = []
    const forgetPluginIndex = vi.fn(async () => {
      // The rows are already gone. The mark is still there.
      order.push(`rows:${count(`SELECT COUNT(*) AS n FROM plugin_task_state WHERE plugin_id = 'test.ext'`)}`)
      order.push(`pending:${count(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending`)}`)
    })
    const host = await makeHost({ removeDirectory: async (path) => rmSync(path, { recursive: true }), forgetPluginIndex })
    await host.uninstall('test.ext')
    expect(forgetPluginIndex).toHaveBeenCalledWith('test.ext')
    expect(order).toEqual(['rows:0', 'pending:1'])
    expect(count(`SELECT COUNT(*) AS n FROM plugin_task_state WHERE plugin_id = 'test.ext'`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM plugin_task_state WHERE plugin_id = 'test.keep'`)).toBe(1)
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE plugin_id = 'test.ext'`)).toBe(1)
    expect(count(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending`)).toBe(0)
  })

  it('索引の文書を消せなくてもアンインストールは成功し、目印が残る。次の起動の片付けでやり直して外す', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    seed()
    let fail = true
    const forgetPluginIndex = vi.fn(async () => {
      if (fail) throw new Error('index down')
    })
    const host = await makeHost({ removeDirectory: async (path) => rmSync(path, { recursive: true }), forgetPluginIndex })
    await host.uninstall('test.ext')
    expect(count(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending WHERE plugin_id = 'test.ext'`)).toBe(1)

    fail = false
    const next = await makeHost({ forgetPluginIndex })
    await next.sweepPendingUninstalls()
    expect(forgetPluginIndex).toHaveBeenCalledTimes(2)
    expect(count(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending`)).toBe(0)
  })

  it('行を消す transaction が失敗したら目印が残り、次の起動の片付けが行を消す (ゴミ箱から戻しても効き直さない)', async () => {
    const pluginDir = writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    seed()
    let broken = true
    const forgetPluginData = vi.fn(() => {
      if (broken) throw new Error('settings write failed')
    })
    const host = await makeHost({ removeDirectory: async (path) => rmSync(path, { recursive: true }), forgetPluginData })
    host.setConsent('test.ext', 'network', true)
    host.setEnabled('test.ext', false)
    let thrown: unknown
    try {
      await host.uninstall('test.ext')
    } catch (err) {
      thrown = err
    }
    expect(codeOf(thrown)).toBe('plugin-uninstall-failed')
    // Rolled back: the row remains. The mark remains too.
    expect(count(`SELECT COUNT(*) AS n FROM plugin_consents WHERE plugin_id = 'test.ext'`)).toBe(1)
    expect(count(`SELECT COUNT(*) AS n FROM plugin_task_state WHERE plugin_id = 'test.ext'`)).toBe(1)
    expect(count(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending WHERE plugin_id = 'test.ext'`)).toBe(1)

    // Restores the same contents from the trash and starts next time. Since cleanup deletes the rows first, neither the consent nor the disabled state comes back.
    broken = false
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    expect(pluginDir).toContain('ext')
    const forgetPluginIndex = vi.fn(async () => undefined)
    const next = await makeHost({ forgetPluginData, forgetPluginIndex })
    await next.sweepPendingUninstalls()
    expect(next.policyOf('test.ext')?.consented.has('network')).toBe(false)
    expect(enabledOf(next, 'test.ext')).toBe(true)
    expect(count(`SELECT COUNT(*) AS n FROM plugin_consents WHERE plugin_id = 'test.ext'`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM plugin_task_state WHERE plugin_id = 'test.ext'`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM plugin_task_state WHERE plugin_id = 'test.keep'`)).toBe(1)
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE plugin_id = 'test.ext'`)).toBe(1)
    // Even if the restored extension is loaded, the previous documents are deleted (wave 87 automatic security review).
    expect(forgetPluginIndex).toHaveBeenCalledWith('test.ext')
    expect(count(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending`)).toBe(0)
  })

  it('第 87 波 code-review: 行の段は load() の中 (行を読む前) で済み、行が済んだ印は at が負になる', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    seed()
    const forgetPluginIndex = vi.fn(async () => {
      throw new Error('index down')
    })
    const host = await makeHost({ removeDirectory: async (path) => rmSync(path, { recursive: true }), forgetPluginIndex })
    host.setConsent('test.ext', 'network', true)
    await host.uninstall('test.ext')
    // The rows are gone, and only the mark remains at the index stage (at < 0).
    expect(count(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending WHERE plugin_id = 'test.ext' AND at < 0`)).toBe(1)
    expect(count(`SELECT COUNT(*) AS n FROM plugin_task_state WHERE plugin_id = 'test.ext'`)).toBe(0)

    // If the mark is still at the row stage (at > 0), then at the next start's load(), the rows are deleted before the extension restored from the trash is loaded.
    db.prepare(`UPDATE plugin_uninstall_pending SET at = 5 WHERE plugin_id = 'test.ext'`).run()
    db.prepare(`INSERT INTO plugin_consents (plugin_id, capability, decision, at, owner_identity) VALUES ('test.ext', 'network', 'granted', 1, '')`).run()
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    const forgetPluginData = vi.fn()
    // Check before `await`: by the time load() returns (synchronously), the row stage is already done.
    const next = await makeHost({ forgetPluginData }, false)
    expect(forgetPluginData).toHaveBeenCalledWith('test.ext')
    expect(count(`SELECT COUNT(*) AS n FROM plugin_consents WHERE plugin_id = 'test.ext'`)).toBe(0)
    expect(next.policyOf('test.ext')?.consented.has('network')).toBe(false)
  })

  it('第 87 波 自動セキュリティレビュー: 同じ id が読み込まれていても前の文書を消す。消し終わるまで indexClearing は true、終われば false', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    db.prepare(`INSERT INTO plugin_uninstall_pending (plugin_id, at) VALUES ('test.ext', -5)`).run()
    let during: boolean | null = null
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const holder: { host?: PluginHost } = {}
    const forgetPluginIndex = vi.fn(async () => {
      during = holder.host?.indexClearing('test.ext') ?? null
      await gate
    })
    const host = await makeHost({ forgetPluginIndex })
    holder.host = host
    expect(host.indexClearing('test.ext')).toBe(true)
    expect(host.indexClearing('test.keep')).toBe(false)
    const sweeping = host.sweepPendingUninstalls()
    await vi.waitFor(() => expect(forgetPluginIndex).toHaveBeenCalledWith('test.ext'))
    expect(during).toBe(true)
    expect(host.indexClearing('test.ext')).toBe(true)
    release()
    await sweeping
    expect(host.indexClearing('test.ext')).toBe(false)
    expect(count(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending`)).toBe(0)
  })

  it('第 87 波 自動セキュリティレビュー: 消すのに失敗したら印が残り、索引の書き込みは断られ続ける', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    db.prepare(`INSERT INTO plugin_uninstall_pending (plugin_id, at) VALUES ('test.ext', -5)`).run()
    const host = await makeHost({
      forgetPluginIndex: async () => {
        throw new Error('index down')
      }
    })
    await host.sweepPendingUninstalls()
    expect(host.indexClearing('test.ext')).toBe(true)
  })

  it('第 87 波 code-review: 終了が始まっていたら、索引の段は走らず印も外さない', async () => {
    db.prepare(`INSERT INTO plugin_uninstall_pending (plugin_id, at) VALUES ('test.gone', -5)`).run()
    const forgetPluginIndex = vi.fn(async () => undefined)
    const host = await makeHost({ forgetPluginIndex })
    await host.stop()
    await host.sweepPendingUninstalls()
    expect(forgetPluginIndex).not.toHaveBeenCalled()
    expect(count(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending`)).toBe(1)
  })

  it('ゴミ箱へ移せなかったときは目印を書かない (生きている拡張機能の行を次の起動で消さない)', async () => {
    writePlugin(join(dir, 'user'), 'ext', EXTERNAL, ENTRY)
    const host = await makeHost({
      removeDirectory: async () => {
        throw new Error('trash unavailable')
      }
    })
    await expect(host.uninstall('test.ext')).rejects.toSatisfy((err: unknown) => codeOf(err) === 'plugin-uninstall-failed')
    expect(count(`SELECT COUNT(*) AS n FROM plugin_uninstall_pending`)).toBe(0)
  })
})

describe('拡張機能が索引に書いた文書 (TODO 1237 の 2)', () => {
  it('その名前空間だけを消す: 索引 (IndexService) と正本 (plugin_documents)。他の拡張機能・似た id・組み込みの source には触らない', async () => {
    const pluginDocuments = new PluginDocumentStore(db)
    const store = new IndexStore(db)
    const index = new IndexService({
      db,
      store,
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: null,
      plugins: { read: async (source, sourceId) => pluginDocuments.read(source, sourceId) },
      onStatus: () => undefined
    })
    const put = async (source: string, sourceId: string): Promise<void> => {
      const document = { source, sourceId, title: sourceId, uri: `plugin://${source}/${sourceId}`, body: `body ${sourceId}`, updatedAt: 1 }
      pluginDocuments.put(document)
      await index.putPluginDocument(document)
    }
    await put('test.ext', 'a')
    await put('test.ext:mail', 'b')
    await put('test.ext/inbox', 'c')
    await put('test.extra:mail', 'd')
    await put('test.other:mail', 'e')
    const rows = (): string[] =>
      (db.prepare(`SELECT source || '|' || source_id AS k FROM documents ORDER BY source, source_id`).all() as { k: string }[]).map((r) => r.k)
    expect(rows()).toHaveLength(5)

    expect(await index.removePluginDocumentsOf('test.ext')).toBe(3)
    expect(rows()).toEqual(['test.extra:mail|d', 'test.other:mail|e'])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get()).toEqual({ n: 2 })

    // Wave 87 code-review: a name that is not in the plugin id shape, or a built-in source name, is refused even as an RPC argument (nothing is deleted).
    for (const bad of ['fs', 'conversation', 'transcript', 'test', '']) {
      await expect(index.removePluginDocumentsOf(bad), bad).rejects.toThrow(/invalid plugin id/)
      expect(() => pluginDocuments.removeOwnedBy(bad), bad).toThrow(/invalid plugin id/)
    }
    expect(rows()).toEqual(['test.extra:mail|d', 'test.other:mail|e'])

    expect(pluginDocuments.removeOwnedBy('test.ext')).toBe(3)
    expect(pluginDocuments.read('test.ext:mail', 'b')).toBeNull()
    expect(pluginDocuments.read('test.extra:mail', 'd')).toBe('body d')
    expect(pluginDocuments.read('test.other:mail', 'e')).toBe('body e')
  })
})

describe('設定の値: 計算前の保存を待つ・移行 (TODO 1237、第 87 波 code-review)', () => {
  const CONFIG: PluginConfigurationDeclaration = {
    title: 'Rules',
    properties: { label: { type: 'string', default: 'x', maxLength: 10, description: 'Label' } }
  }
  function make(identity: { value: string | null }, box: { value: StoredPluginSettings }, ready?: () => Promise<void>): PluginSettingsStore {
    return new PluginSettingsStore({
      read: () => box.value,
      write: (value) => {
        box.value = value
      },
      configurationOf: () => CONFIG,
      known: () => true,
      identityOf: () => identity.value,
      ...(ready === undefined ? {} : { identitiesReady: ready })
    })
  }

  it('updateWhenReady: 計算前なら終わるのを待ってから保存する。待っても null なら plugin-settings-unbound', async () => {
    const identity = { value: null as string | null }
    const box: { value: StoredPluginSettings } = { value: {} }
    const store = make(identity, box, async () => {
      identity.value = 'sha256:one'
    })
    const view = await store.updateWhenReady('test.ext', 'label', 'mine')
    expect(view.fields[0]?.value).toBe('mine')
    expect(box.value[PLUGIN_SETTINGS_OWNERS_KEY]).toEqual({ 'test.ext': 'sha256:one' })

    const stuck = { value: null as string | null }
    const empty: { value: StoredPluginSettings } = { value: {} }
    const unbound = make(stuck, empty, async () => undefined)
    await expect(unbound.updateWhenReady('test.ext', 'label', 'y')).rejects.toSatisfy((err: unknown) => codeOf(err) === 'plugin-settings-unbound')
    expect(empty.value).toEqual({})
  })

  it('adoptUnowned: 持ち主の記録の無い外の値は、最初の計算で今の同一性を書き足して採用する (1 回だけ。同梱・計算前は書かない)', () => {
    const identity = { value: null as string | null }
    const box: { value: StoredPluginSettings } = { value: { 'test.ext': { label: 'old' } } }
    const store = make(identity, box)
    store.adoptUnowned()
    expect(box.value[PLUGIN_SETTINGS_OWNERS_KEY]).toBeUndefined()
    identity.value = 'sha256:one'
    expect(store.values('test.ext')).toEqual({ label: 'x' })
    store.adoptUnowned()
    expect(box.value[PLUGIN_SETTINGS_OWNERS_KEY]).toEqual({ 'test.ext': 'sha256:one' })
    expect(store.values('test.ext')).toEqual({ label: 'old' })
    // From here on, the binding rule applies: if the identity changes, nothing is carried over.
    identity.value = 'sha256:two'
    store.adoptUnowned()
    expect(store.values('test.ext')).toEqual({ label: 'x' })
    expect(box.value[PLUGIN_SETTINGS_OWNERS_KEY]).toEqual({ 'test.ext': 'sha256:one' })

    const bundled = { value: 'bundled' as string | null }
    const box2: { value: StoredPluginSettings } = { value: { 'test.ext': { label: 'old' } } }
    make(bundled, box2).adoptUnowned()
    expect(box2.value[PLUGIN_SETTINGS_OWNERS_KEY]).toBeUndefined()
  })

})
