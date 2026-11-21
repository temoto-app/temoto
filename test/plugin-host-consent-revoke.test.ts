/**
 * TODO 1070: once the consent for a bundled plugin's capability is revoked (`denied`), it is not granted again at the next start (`load()`).
 * Only capabilities with no row (never decided) are granted.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import type { CapabilityBroker } from '../src/main/capability/broker.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => ({}) } }))

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-revoke-'))
  const pluginDir = join(dir, 'bundled', 'test.bundled')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'manifest.json'),
    JSON.stringify({
      id: 'test.bundled',
      name: 'B',
      version: '1.0.0',
      capabilities: { ui: {}, fs: {} }
    })
  )
  db = new Database(':memory:')
  runMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function makeHost() {
  const { PluginHost } = await import('../src/main/plugin/host.js')
  return new PluginHost({
    db,
    bundledDir: join(dir, 'bundled'),
    userDir: join(dir, 'user'),
    hostEntry: join(dir, 'host-entry', 'plugin-host.js'),
    broker: () => ({}) as unknown as CapabilityBroker,
    onChanged: () => undefined
  })
}

describe('同梱 plugin の同意の取り消しを再起動で戻さない (TODO 1070)', () => {
  it('denied の行がある能力は付与し直さず、行が無い能力だけ付与する', async () => {
    db.prepare(`INSERT INTO plugin_consents (plugin_id, capability, decision, at) VALUES (?, ?, ?, ?)`).run(
      'test.bundled',
      'ui',
      'denied',
      1
    )
    const host = await makeHost()
    host.load()
    const consented = host.policyOf('test.bundled')?.consented
    expect(consented?.has('ui')).toBe(false)
    expect(consented?.has('fs')).toBe(true)
    const row = db.prepare(`SELECT decision FROM plugin_consents WHERE plugin_id = ? AND capability = ?`).get(
      'test.bundled',
      'ui'
    ) as { decision: string }
    expect(row.decision).toBe('denied')
  })

  it('行が無ければ今までどおり付与する', async () => {
    const host = await makeHost()
    host.load()
    const consented = host.policyOf('test.bundled')?.consented
    expect(consented?.has('ui')).toBe(true)
    expect(consented?.has('fs')).toBe(true)
  })
})
