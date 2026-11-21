/**
 * The trigger entry point (TODO 1216, ARCHITECTURE 6.2.6 / 7.7): the declaration of `triggers` in the manifest, the Broker's checks (declaration, consent, and shape) and audit, and `api.triggers.emit` in plugin-host. Exercised with a fake extension (declaration only) and a fake receiver. No model is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { parseBrokerRequest } from '../src/main/capability/request-schema.js'
import { declaredCapabilities, ManifestError, needsHost, parseManifest } from '../src/main/plugin/manifest.js'
import { createPluginApi } from '../src/plugin-host/dispatch.js'
import type { BrokerRequest, CapabilityName } from '../src/shared/plugin.js'
import type { PluginTriggerEvent, TriggerEmitResult } from '../src/shared/trigger.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

const MANIFEST = {
  id: 'aios.fakemail',
  name: 'Fake mail',
  version: '1.0.0',
  host: { entry: 'host.js' },
  scheduledTasks: [{ id: 'sync', name: 'Sync', defaultInterval: 15, idle: true }],
  triggers: [{ id: 'new-mail', name: '新着メール', description: '自分宛ての新着', defaultPrompt: '要点と返信案' }]
}

describe('マニフェストの triggers', () => {
  it('宣言そのものが能力 triggers の要求になる', () => {
    const manifest = parseManifest(MANIFEST)
    expect(manifest.triggers?.[0]).toMatchObject({ id: 'new-mail', name: '新着メール' })
    expect(declaredCapabilities(manifest)).toContain('triggers')
    expect(needsHost(manifest)).toBe(true)
    expect(declaredCapabilities(parseManifest({ ...MANIFEST, triggers: undefined }))).not.toContain('triggers')
  })

  it('host.entry が要る・id は一意で形が決まっている・知らない鍵は通さない', () => {
    const noHost = Object.fromEntries(Object.entries(MANIFEST).filter(([name]) => name !== 'host' && name !== 'scheduledTasks'))
    expect(() => parseManifest(noHost)).toThrow(/triggers requires host.entry/)
    expect(() => parseManifest({ ...MANIFEST, triggers: [MANIFEST.triggers[0], MANIFEST.triggers[0]] })).toThrow(ManifestError)
    expect(() => parseManifest({ ...MANIFEST, triggers: [{ id: 'Bad Id', name: 'x' }] })).toThrow(ManifestError)
    expect(() => parseManifest({ ...MANIFEST, triggers: [{ id: 'a', name: 'x', run: 'sh' }] })).toThrow(ManifestError)
    expect(() => parseManifest({ ...MANIFEST, triggers: [] })).toThrow(ManifestError)
  })
})

describe('plugin-host の api.triggers.emit', () => {
  it('出来事をそのまま Broker への要求にする (判定は main)', async () => {
    const calls: BrokerRequest[] = []
    const api = createPluginApi(async (request) => {
      calls.push(request)
      return { accepted: true }
    })
    const event: PluginTriggerEvent = { trigger: 'new-mail', key: 'k', title: 't', prompt: 'p' }
    expect(await api.triggers.emit(event)).toEqual({ accepted: true })
    expect(calls).toEqual([{ capability: 'triggers', op: 'emit', event }])
  })
})

describe('Broker の形の検証 (request-schema)', () => {
  const base = { capability: 'triggers', op: 'emit', event: { trigger: 'new-mail', key: 'k', title: 't', prompt: 'p' } }
  it('知らない鍵・長すぎる参照の文・型の違いは通さない', () => {
    expect(parseBrokerRequest(base)).not.toBeNull()
    expect(parseBrokerRequest({ ...base, event: { ...base.event, body: 'x' } })).toBeNull()
    expect(parseBrokerRequest({ ...base, event: { ...base.event, prompt: 'x'.repeat(2_001) } })).toBeNull()
    expect(parseBrokerRequest({ ...base, event: { ...base.event, key: 1 } })).toBeNull()
    expect(parseBrokerRequest({ ...base, extra: true })).toBeNull()
  })
})

let dir: string
let db: Db
let audit: AuditLog
let policy: PluginPolicy | null
let sinkCalls: { pluginId: string; event: PluginTriggerEvent }[]
let sinkReady: boolean

function broker(): CapabilityBroker {
  return new CapabilityBroker({
    scope: { rules: testExclusions(homedir()) },
    audit,
    credentials: new CredentialStore(dir, { available: () => false, seal: () => Buffer.alloc(0), open: () => '' }),
    policyOf: (id) => (id === 'aios.fakemail' ? policy : null),
    index: { put: async () => undefined, remove: async () => undefined },
    notify: () => undefined,
    triggers: () =>
      sinkReady
        ? {
            emit: async (pluginId: string, event: PluginTriggerEvent): Promise<TriggerEmitResult> => {
              sinkCalls.push({ pluginId, event })
              return event.key === 'dup' ? { accepted: false, reason: 'duplicate' } : { accepted: true }
            }
          }
        : null
  })
}

function policyWith(consented: CapabilityName[], triggers: string[] = ['new-mail']): PluginPolicy {
  return {
    id: 'aios.fakemail',
    declared: { credentials: [], networkHosts: [], fsRead: [], fsWrite: [], indexSources: [], ui: false, triggers },
    consented: new Set(consented)
  }
}

const emit = (key = 'k', trigger = 'new-mail'): BrokerRequest => ({
  capability: 'triggers',
  op: 'emit',
  event: { trigger, key, title: '件名 secret-title', prompt: 'ref secret-ref' }
})

beforeEach(() => {
  dir = makeTestDir('trigger-cap')
  db = new Database(':memory:')
  runMigrations(db)
  audit = new AuditLog(db)
  policy = policyWith(['triggers'])
  sinkCalls = []
  sinkReady = true
})

afterEach(() => {
  audit.dispose()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Broker の triggers.emit', () => {
  it('宣言と同意があれば受け口へ。監査には trigger の id だけ (鍵・題・参照の文は残さない)', async () => {
    const b = broker()
    expect(await b.handle('aios.fakemail', emit())).toEqual({ accepted: true })
    expect(sinkCalls).toHaveLength(1)
    expect(await b.handle('aios.fakemail', emit('dup'))).toEqual({ accepted: false, reason: 'duplicate' })
    audit.flush()
    const entries = audit.recent(10, 'aios.fakemail')
    expect(entries.map((entry) => [entry.capability, entry.op, entry.target, entry.decision, entry.reason])).toEqual(
      expect.arrayContaining([
        ['triggers', 'emit', 'new-mail', 'allow', null],
        ['triggers', 'emit', 'new-mail', 'allow', 'duplicate']
      ])
    )
    expect(JSON.stringify(entries)).not.toMatch(/secret-title|secret-ref/)
  })

  it('宣言していない trigger・同意の無い拡張機能・知らない拡張機能・受け口が未だ無いときは断る', async () => {
    const b = broker()
    await expect(b.handle('aios.fakemail', emit('k', 'other'))).rejects.toThrow('not-declared')
    policy = policyWith([])
    await expect(b.handle('aios.fakemail', emit())).rejects.toThrow('not-consented')
    await expect(b.handle('aios.unknown', emit())).rejects.toThrow('unknown-plugin')
    policy = policyWith(['triggers'])
    sinkReady = false
    await expect(b.handle('aios.fakemail', emit())).rejects.toThrow('unavailable')
    expect(sinkCalls).toHaveLength(0)
  })
})
