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

describe('configuration in the manifest', () => {
  it('reads boolean, string, and string table', () => {
    const manifest = parseManifest({ ...MANIFEST, configuration: CONFIG })
    expect(Object.keys(manifest.configuration?.properties ?? {})).toEqual(['allowFrom', 'includeCc', 'label'])
  })

  it('does not load names that look secret, defaults that do not fit the type, defaults over the limit, unknown keys, unknown types, or a missing entry', () => {
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

  it('fix X: the item format is only a name from a fixed table (format); unknown names, arbitrary regular expressions (pattern), and defaults that do not fit the format are not loaded', () => {
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

describe('value validation (shared)', () => {
  it('fix X (security review): the values read are only the declared fields; unset is the default, and a saved field that does not match the current declaration is not put in the values (it does not fall back to the default)', () => {
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

  it('fix X: the renderer value is one field; only when it is a declared field and fits type and limit; unknown field, newline, too long, too many, or type mismatch is null', () => {
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

  it('the detail fields follow order, and use the name when there is no heading', () => {
    const view = pluginSettingsView('test.settings', CONFIG, {})
    expect(view.fields.map((field) => [field.name, field.title, field.value])).toEqual([
      ['allowFrom', 'allowFrom', []],
      ['includeCc', 'includeCc', false],
      ['label', 'label', 'x']
    ])
    expect(view.title).toBe('Rules')
  })

  it('the table textarea drops leading and trailing whitespace and blank lines', () => {
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

describe('store (PluginSettingsStore)', () => {
  it("returns the saved values for its own extension only; does not touch other extensions' values; refuses an extension that is not installed", () => {
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

  it('a forged renderer value is refused without writing anything (the previous value stays)', () => {
    const s = store({ 'test.settings': CONFIG })
    saveAll(s, 'test.settings', { allowFrom: ['a.com'], includeCc: true, label: 'y' })
    expect(() => s.update('test.settings', 'other', 'x')).toThrow(/invalid-value/)
    expect(() => s.update('test.settings', 'includeCc', 'true')).toThrow(/invalid-value/)
    expect(s.values('test.settings')).toEqual({ allowFrom: ['a.com'], includeCc: true, label: 'y' })
  })

  it('fix X: updating one field does not touch the saved values of other fields (changing two fields in a row keeps both)', () => {
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

  it('fix X: a value that no longer fits after the declaration changed is not passed to the extension (a field whose type changed in a version update); fixing and saving brings it back', () => {
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

describe('Broker settings.get and the plugin-host entry point', () => {
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

  it('returns only the values of the calling extension itself (no consent needed); refuses a disabled or unknown extension; leaves no value in the audit', async () => {
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

  it('api.settings.get of plugin-host is a request with no arguments', async () => {
    const calls: BrokerRequest[] = []
    const api = createPluginApi(async (request) => {
      calls.push(request)
      return { a: true }
    })
    expect(await api.settings.get()).toEqual({ a: true })
    expect(calls).toEqual([{ capability: 'settings', op: 'get' }])
  })
})

describe('aios.gmail declaration (allowFrom / includeCc / requireAuth of 1217)', () => {
  const manifest = parseManifest(JSON.parse(readFileSync(join(__dirname, '../plugins/aios.gmail/manifest.json'), 'utf8')))

  it('declares 3 fields; defaults are no allow list, no Cc, and authentication required; the description of requireAuth states the danger', () => {
    const values = resolvePluginSettings(manifest.configuration, undefined)
    expect(values).toEqual({ allowFrom: [], includeCc: false, requireAuth: true })
    // Not saved (the default empty table) = no allow list (null).
    expect(parseTriggerSettings(values)).toEqual({ allowFrom: null, includeCc: false, requireAuth: true })
    expect(manifest.configuration?.properties['requireAuth']?.description).toMatch(/危険/)
    const view = pluginSettingsView('aios.gmail', manifest.configuration, {})
    expect(view.fields.map((field) => field.name)).toEqual(['allowFrom', 'includeCc', 'requireAuth'])
  })

  it('fix X: an allow list row that does not fit the shape (with a display name, or 2 entries separated by a space) is not saved (not silently fixed); the previous value stays', () => {
    const s = store({ 'aios.gmail': manifest.configuration })
    s.update('aios.gmail', 'allowFrom', ['acme.com'])
    for (const line of ['Alice <alice@example.com>', 'a@x.com b@y.com', 'localhost']) {
      expect(() => s.update('aios.gmail', 'allowFrom', ['bob@acme.com', line]), line).toThrow(/invalid-value/)
    }
    expect(s.values('aios.gmail')).toEqual({ allowFrom: ['acme.com'], includeCc: false, requireAuth: true })
    // Passes the shape's name to the screen (the renderer marks rows that do not fit with the same function, and explains them in aios's wording).
    expect(s.view('aios.gmail')?.fields.find((item) => item.name === 'allowFrom')?.format).toBe('email-or-domain')
  })

  it("the saved value takes effect as it is through the extension's reading (parseTriggerSettings)", () => {
    const s = store({ 'aios.gmail': manifest.configuration })
    saveAll(s, 'aios.gmail', { allowFrom: ['Boss@Example.com', 'acme.com'], includeCc: true, requireAuth: false })
    expect(parseTriggerSettings(s.values('aios.gmail'))).toEqual({ allowFrom: ['boss@example.com', 'acme.com'], includeCc: true, requireAuth: false })
  })
})
