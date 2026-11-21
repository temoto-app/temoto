/**
 * TODO 1225 (ARCHITECTURE 7.2.1): the entry point for extension settings: validation of the manifest's `configuration`, checking of values (shared), storage
 * (`PluginSettingsStore`, `plugins.settings` in `app_settings`), the Broker's `settings.get` (only its own), the plugin-host entry point,
 * and the declaration of `aios.gmail`. Neither the model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { PLUGIN_SETTINGS } from '../src/common/settings-keys.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { parseBrokerRequest } from '../src/main/capability/request-schema.js'
import { ManifestError, parseManifest } from '../src/main/plugin/manifest.js'
import { PluginSettingsStore } from '../src/main/plugin/settings.js'
import { createPluginApi } from '../src/plugin-host/dispatch.js'
import type { BrokerRequest } from '../src/shared/plugin.js'
import {
  checkPluginSettingUpdate,
  pluginSettingsView,
  resolvePluginSettings,
  type PluginConfigurationDeclaration
} from '../src/shared/plugin-settings.js'
import { parseTriggerSettings } from '../plugins/aios.gmail/host/trigger.js'
import { linesToList } from '../src/renderer/src/components/PluginSettingsSection.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

const CONFIG: PluginConfigurationDeclaration = {
  title: 'Rules',
  properties: {
    allowFrom: { type: 'array', items: { type: 'string' }, default: [], maxLength: 20, maxItems: 3, description: 'Senders', order: 1 },
    includeCc: { type: 'boolean', default: false, description: 'Cc', order: 2 },
    label: { type: 'string', default: 'x', maxLength: 10, description: 'Label' }
  }
}

const MANIFEST = { id: 'test.settings', name: 'S', version: '1.0.0', host: { entry: 'host.js' } }

describe('マニフェストの configuration', () => {
  it('真偽・文字列・文字列の表を読む', () => {
    const manifest = parseManifest({ ...MANIFEST, configuration: CONFIG })
    expect(Object.keys(manifest.configuration?.properties ?? {})).toEqual(['allowFrom', 'includeCc', 'label'])
  })

  it('秘密に見える名前・型に合わない既定・上限を超える既定・知らない鍵・知らない型・入口なしは読み込まない', () => {
    const bad = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
      expect(() => parseManifest({ ...MANIFEST, ...extra, configuration: { properties } }), JSON.stringify(properties)).toThrow(ManifestError)
    }
    for (const name of ['apiToken', 'password', 'clientSecret', 'APIKEY', 'sessionCookie']) {
      bad({ [name]: { type: 'string', default: '', description: 'x' } })
    }
    bad({ a: { type: 'boolean', default: 'yes', description: 'x' } })
    bad({ a: { type: 'string', default: 'x'.repeat(11), maxLength: 10, description: 'x' } })
    bad({ a: { type: 'array', items: { type: 'string' }, default: ['a', 'b'], maxItems: 1, description: 'x' } })
    bad({ a: { type: 'array', items: { type: 'number' }, default: [], description: 'x' } })
    bad({ a: { type: 'number', default: 1, description: 'x' } })
    bad({ a: { type: 'boolean', default: true, description: 'x', scope: 'machine' } })
    bad({ 'a.b': { type: 'boolean', default: true, description: 'x' } })
    bad({})
    bad(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, { type: 'boolean', default: true, description: 'x' }])))
    expect(() => parseManifest({ id: 'test.settings', name: 'S', version: '1.0.0', configuration: CONFIG })).toThrow(/host.entry/)
  })

  it('直し X: 項目の形は固定の表の名前 (format) だけ。知らない名前・任意の正規表現 (pattern)・形に合わない既定は読み込まない', () => {
    const withFormat = (format: unknown, extra: Record<string, unknown> = {}) => ({
      ...MANIFEST,
      configuration: {
        properties: {
          allowFrom: { type: 'array', items: { type: 'string', format }, default: [], description: 'x', ...extra },
          label: { type: 'string', default: '', format, description: 'x' }
        }
      }
    })
    for (const format of ['email', 'hostname', 'email-or-domain']) {
      const manifest = parseManifest(withFormat(format))
      const allow = manifest.configuration?.properties['allowFrom']
      expect(allow?.type === 'array' ? allow.items.format : null).toBe(format)
    }
    for (const format of ['uri', 'regex', 'EMAIL', '', 1]) {
      expect(() => parseManifest(withFormat(format)), String(format)).toThrow(ManifestError)
    }
    expect(() => parseManifest(withFormat('hostname', { default: ['not a host'] }))).toThrow(ManifestError)
    for (const items of [
      { type: 'string', pattern: '^(a+)+$' },
      { type: 'string', patternErrorMessage: 'x' },
      { type: 'string', flags: 'i' }
    ]) {
      expect(() => parseManifest({ ...MANIFEST, configuration: { properties: { a: { type: 'array', items, default: [], description: 'x' } } } })).toThrow(
        ManifestError
      )
    }
  })
})

describe('値の検め (shared)', () => {
  it('直し X (セキュリティレビュー): 読む値は宣言の欄だけ。未設定は既定、保存済みだが今の宣言に合わない欄は値に入れない (既定に倒さない)', () => {
    expect(resolvePluginSettings(CONFIG, { allowFrom: ['a.com'], includeCc: 'yes', label: 'y'.repeat(11), stray: 1 })).toEqual({
      allowFrom: ['a.com']
    })
    expect(resolvePluginSettings(CONFIG, {})).toEqual({ allowFrom: [], includeCc: false, label: 'x' })
    expect(resolvePluginSettings(undefined, { a: 1 })).toEqual({})
    // On screen, fields that are not used are marked, and the saved rows are shown so they can be fixed.
    const view = pluginSettingsView('test.settings', CONFIG, { allowFrom: ['a.com', 'x'.repeat(30)], includeCc: 'yes' })
    expect(view.fields.map((field) => [field.name, field.value, field.storedInvalid === true])).toEqual([
      ['allowFrom', ['a.com', 'x'.repeat(30)], true],
      ['includeCc', false, true],
      ['label', 'x', false]
    ])
  })

  it('直し X: renderer の値は欄 1 つ。宣言の欄で型と上限に合うときだけ。知らない欄・改行・長すぎ・多すぎ・型の違いは null', () => {
    expect(checkPluginSettingUpdate(CONFIG, 'allowFrom', ['a.com', 'a.com', 'b.com'])).toEqual(['a.com', 'b.com'])
    expect(checkPluginSettingUpdate(CONFIG, 'includeCc', true)).toBe(true)
    for (const [name, raw] of [
      ['extra', 1],
      ['constructor', true],
      ['label', 'a\nb'],
      ['label', 'y'.repeat(11)],
      ['allowFrom', ['a', 'b', 'c', 'd']],
      ['allowFrom', ['']],
      ['allowFrom', 'a.com'],
      ['includeCc', 1],
      [null, true]
    ] as const) {
      expect(checkPluginSettingUpdate(CONFIG, name, raw), `${String(name)} ${JSON.stringify(raw)}`).toBeNull()
    }
    expect(checkPluginSettingUpdate(undefined, 'a', true)).toBeNull()
  })

  it('詳細の欄は order の順、見出しが無ければ名前', () => {
    const view = pluginSettingsView('test.settings', CONFIG, {})
    expect(view.fields.map((field) => [field.name, field.title, field.value])).toEqual([
      ['allowFrom', 'allowFrom', []],
      ['includeCc', 'includeCc', false],
      ['label', 'label', 'x']
    ])
    expect(view.title).toBe('Rules')
  })

  it('表の textarea は前後の空白と空行を落とす', () => {
    expect(linesToList(' a.com \n\n\r\nb.com\n')).toEqual(['a.com', 'b.com'])
  })
})

let db: Db

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
})

afterEach(() => {
  db.close()
})

/** Saves the fields one at a time (the same entry point as the renderer). */
function saveAll(s: PluginSettingsStore, pluginId: string, values: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(values)) s.update(pluginId, name, value)
}

function store(configs: Record<string, PluginConfigurationDeclaration | undefined>): PluginSettingsStore {
  const settings = new AppSettingsStore(db)
  return new PluginSettingsStore({
    read: () => settings.readTyped(PLUGIN_SETTINGS),
    write: (value) => settings.writeTyped(PLUGIN_SETTINGS, value),
    configurationOf: (id) => configs[id],
    known: (id) => Object.hasOwn(configs, id),
    identityOf: () => 'bundled'
  })
}

describe('置き場 (PluginSettingsStore)', () => {
  it('保存した値を自分の分だけ返す。他の拡張機能の値には触らない。入っていない拡張機能は断る', () => {
    const s = store({ 'test.settings': CONFIG, 'test.other': CONFIG })
    expect(s.values('test.settings')).toEqual({ allowFrom: [], includeCc: false, label: 'x' })
    saveAll(s, 'test.other', { allowFrom: ['o.com'], includeCc: false, label: 'o' })
    saveAll(s, 'test.settings', { allowFrom: ['a.com'], label: 'y' })
    const view = s.update('test.settings', 'includeCc', true)
    expect(view.fields.find((field) => field.name === 'includeCc')?.value).toBe(true)
    expect(s.values('test.settings')).toEqual({ allowFrom: ['a.com'], includeCc: true, label: 'y' })
    expect(s.values('test.other')).toEqual({ allowFrom: ['o.com'], includeCc: false, label: 'o' })
    expect(() => s.update('test.missing', 'label', 'x')).toThrow(/invalid-value/)
    expect(s.view('test.missing')).toBeNull()
  })

  it('renderer の偽りの値は何も書かずに断る (前の値が残る)', () => {
    const s = store({ 'test.settings': CONFIG })
    saveAll(s, 'test.settings', { allowFrom: ['a.com'], includeCc: true, label: 'y' })
    expect(() => s.update('test.settings', 'other', 'x')).toThrow(/invalid-value/)
    expect(() => s.update('test.settings', 'includeCc', 'true')).toThrow(/invalid-value/)
    expect(s.values('test.settings')).toEqual({ allowFrom: ['a.com'], includeCc: true, label: 'y' })
  })

  it('直し X: 欄 1 つの更新は他の欄の保存済みの値に触らない (続けて 2 つの欄を変えても両方残る)', () => {
    const s = store({ 'test.settings': CONFIG })
    s.update('test.settings', 'allowFrom', ['a.com'])
    s.update('test.settings', 'includeCc', true)
    expect(s.values('test.settings')).toEqual({ allowFrom: ['a.com'], includeCc: true, label: 'x' })
    // The limit on total length is checked together with the other fields.
    const big = store({
      'test.settings': {
        properties: {
          a: { type: 'array', items: { type: 'string' }, default: [], maxLength: 2_000, maxItems: 500, description: 'x' },
          b: { type: 'array', items: { type: 'string' }, default: [], maxLength: 2_000, maxItems: 500, description: 'x' }
        }
      }
    })
    const half = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(1_800, 'x'))
    big.update('test.settings', 'a', half)
    expect(() => big.update('test.settings', 'b', half)).toThrow(/invalid-value/)
    expect(big.values('test.settings')['a']).toEqual(half)
  })

  it('直し X: 宣言が変わって合わなくなった値は拡張機能に渡さない (版の更新で型が変わった欄)。直して保存すれば戻る', () => {
    const s = store({ 'test.settings': CONFIG })
    saveAll(s, 'test.settings', { allowFrom: ['a.com'], includeCc: true, label: 'y' })
    const next = store({
      'test.settings': { properties: { ...CONFIG.properties, includeCc: { type: 'string', default: 'no', description: 'x' } } }
    })
    expect(next.values('test.settings')).toEqual({ allowFrom: ['a.com'], label: 'y' })
    expect(next.view('test.settings')?.fields.find((field) => field.name === 'includeCc')?.storedInvalid).toBe(true)
    next.update('test.settings', 'includeCc', 'yes')
    expect(next.values('test.settings')).toEqual({ allowFrom: ['a.com'], includeCc: 'yes', label: 'y' })
  })
})

describe('Broker の settings.get と plugin-host の口', () => {
  let dir: string
  let audit: AuditLog

  beforeEach(() => {
    dir = makeTestDir('plugin-settings')
    audit = new AuditLog(db)
  })

  afterEach(() => {
    audit.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const policy = (id: string): PluginPolicy => ({
    id,
    declared: { credentials: [], networkHosts: [], fsRead: [], fsWrite: [], indexSources: [], ui: false },
    consented: new Set()
  })

  it('呼んだ拡張機能自身の値だけを返す (同意は要らない)。無効・知らない拡張機能は断る。監査に値は残さない', async () => {
    const s = store({ 'test.settings': CONFIG, 'test.other': CONFIG })
    saveAll(s, 'test.other', { allowFrom: ['secret-other.com'], includeCc: true, label: 'o' })
    saveAll(s, 'test.settings', { allowFrom: ['mine.com'], includeCc: false, label: 'm' })
    const broker = new CapabilityBroker({
      scope: { rules: testExclusions(homedir()) },
      audit,
      credentials: new CredentialStore(dir, { available: () => false, seal: () => Buffer.alloc(0), open: () => '' }),
      policyOf: (id) => (id === 'test.settings' || id === 'test.other' ? policy(id) : null),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined,
      settings: (id) => s.values(id)
    })
    const request: BrokerRequest = { capability: 'settings', op: 'get' }
    expect(await broker.handle('test.settings', request)).toEqual({ allowFrom: ['mine.com'], includeCc: false, label: 'm' })
    await expect(broker.handle('test.disabled', request)).rejects.toThrow('unknown-plugin')
    // There is no entry point for writing another extension's id into a request (the shape check drops keys it does not know).
    expect(parseBrokerRequest({ capability: 'settings', op: 'get', pluginId: 'test.other' })).toBeNull()
    expect(parseBrokerRequest({ capability: 'settings', op: 'get' })).toEqual(request)
    audit.flush()
    const entries = audit.recent(10, 'test.settings')
    expect(entries.map((entry) => [entry.capability, entry.op, entry.target, entry.decision])).toContainEqual(['settings', 'get', null, 'allow'])
    expect(JSON.stringify(audit.recent(20))).not.toMatch(/mine\.com|secret-other/)
  })

  it('plugin-host の api.settings.get は引数の無い要求にする', async () => {
    const calls: BrokerRequest[] = []
    const api = createPluginApi(async (request) => {
      calls.push(request)
      return { a: true }
    })
    expect(await api.settings.get()).toEqual({ a: true })
    expect(calls).toEqual([{ capability: 'settings', op: 'get' }])
  })
})

describe('aios.gmail の宣言 (1217 の allowFrom / includeCc / requireAuth)', () => {
  const manifest = parseManifest(JSON.parse(readFileSync(join(__dirname, '../plugins/aios.gmail/manifest.json'), 'utf8')))

  it('3 つの欄を宣言し、既定は許可表なし・Cc なし・認証あり。requireAuth の説明に危険を書く', () => {
    const values = resolvePluginSettings(manifest.configuration, undefined)
    expect(values).toEqual({ allowFrom: [], includeCc: false, requireAuth: true })
    // Not saved (the default empty table) = no allow list (null).
    expect(parseTriggerSettings(values)).toEqual({ allowFrom: null, includeCc: false, requireAuth: true })
    expect(manifest.configuration?.properties['requireAuth']?.description).toMatch(/危険/)
    const view = pluginSettingsView('aios.gmail', manifest.configuration, {})
    expect(view.fields.map((field) => field.name)).toEqual(['allowFrom', 'includeCc', 'requireAuth'])
  })

  it('直し X: 形に合わない許可表の行 (表示名つき・空白で 2 つ) は保存しない (黙って直さない)。前の値が残る', () => {
    const s = store({ 'aios.gmail': manifest.configuration })
    s.update('aios.gmail', 'allowFrom', ['acme.com'])
    for (const line of ['Alice <alice@example.com>', 'a@x.com b@y.com', 'localhost']) {
      expect(() => s.update('aios.gmail', 'allowFrom', ['bob@acme.com', line]), line).toThrow(/invalid-value/)
    }
    expect(s.values('aios.gmail')).toEqual({ allowFrom: ['acme.com'], includeCc: false, requireAuth: true })
    // Passes the shape's name to the screen (the renderer marks rows that do not fit with the same function, and explains them in aios's wording).
    expect(s.view('aios.gmail')?.fields.find((item) => item.name === 'allowFrom')?.format).toBe('email-or-domain')
  })

  it('保存した値は拡張機能の読み方 (parseTriggerSettings) でそのまま効く', () => {
    const s = store({ 'aios.gmail': manifest.configuration })
    saveAll(s, 'aios.gmail', { allowFrom: ['Boss@Example.com', 'acme.com'], includeCc: true, requireAuth: false })
    expect(parseTriggerSettings(s.values('aios.gmail'))).toEqual({ allowFrom: ['boss@example.com', 'acme.com'], includeCc: true, requireAuth: false })
  })
})
