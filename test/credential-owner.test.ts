/**
 * Fix Z of wave 84 (TODO 1218 / the security review of 952): the credential names that main handles for login and input
 * (`bitbucket:api-token` / `google:gmail.modify` / `google:gmail.readonly`) can be used only by the owner's bundled extension.
 *
 *  - Manifest validation: a different id declares it -> not loaded
 *  - `PluginHost.policyOf`: even the owner's id is stripped if it is not bundled (when an external plugin claims an id that has no bundled version)
 *  - `PluginAccounts`: no field is shown for an extension that is not the owner or not bundled, and it does not receive a token
 *  - The Broker's double guard is in `capability-net.test.ts` (`not-owner`)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import type { CapabilityBroker } from '../src/main/capability/broker.js'
import { BITBUCKET_CREDENTIAL } from '../src/main/capability/basic-credentials.js'
import { credentialOwnedBy, credentialOwner, credentialUsableBy } from '../src/main/capability/credential-owner.js'
import { CredentialStore, type SecretSealer } from '../src/main/capability/credentials.js'
import { GMAIL_MODIFY_CREDENTIAL, GMAIL_READONLY_CREDENTIAL } from '../src/main/capability/google-credentials.js'
import { PluginAccounts } from '../src/main/plugin/accounts.js'
import { ManifestError, parseManifest } from '../src/main/plugin/manifest.js'
import type { PluginManifest } from '../src/shared/plugin.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => ({}) } }))

const manifestOf = (id: string, credentials: { oauth?: string[]; basic?: string[] }): Record<string, unknown> => ({
  id,
  name: id,
  version: '1.0.0',
  capabilities: { credentials: { oauth: credentials.oauth ?? [], ...(credentials.basic ? { basic: credentials.basic } : {}) }, network: { hosts: ['api.bitbucket.org', 'gmail.googleapis.com'] } }
})

describe('owner of credential names', () => {
  it('a name in the table has an owner, and a name not in the table is not bound', () => {
    expect(credentialOwner(BITBUCKET_CREDENTIAL)).toBe('aios.bitbucket')
    expect(credentialOwner(GMAIL_MODIFY_CREDENTIAL)).toBe('aios.gmail')
    expect(credentialOwner(GMAIL_READONLY_CREDENTIAL)).toBe('aios.gmail')
    expect(credentialOwner('other:thing')).toBeNull()
    expect(credentialOwnedBy(BITBUCKET_CREDENTIAL, 'evil.plugin')).toBe(false)
    expect(credentialOwnedBy('other:thing', 'evil.plugin')).toBe(true)
    expect(credentialUsableBy(GMAIL_MODIFY_CREDENTIAL, { id: 'aios.gmail', bundled: true })).toBe(true)
    expect(credentialUsableBy(GMAIL_MODIFY_CREDENTIAL, { id: 'aios.gmail', bundled: false })).toBe(false)
  })

  it('manifest: does not load when a different id declares a bitbucket / Google name', () => {
    expect(() => parseManifest(manifestOf('evil.plugin', { basic: [BITBUCKET_CREDENTIAL] }))).toThrow(ManifestError)
    expect(() => parseManifest(manifestOf('evil.plugin', { oauth: [GMAIL_MODIFY_CREDENTIAL] }))).toThrow(/belongs to aios\.gmail/)
    expect(() => parseManifest(manifestOf('evil.plugin', { oauth: [GMAIL_READONLY_CREDENTIAL] }))).toThrow(ManifestError)
    // Written with the wrong kind, it is the same (a Google name under basic)
    expect(() => parseManifest(manifestOf('evil.plugin', { basic: [GMAIL_MODIFY_CREDENTIAL] }))).toThrow(ManifestError)
    // The owner is as before. Names not in the table are also as before.
    expect(parseManifest(manifestOf('aios.bitbucket', { basic: [BITBUCKET_CREDENTIAL] })).capabilities.credentials?.basic).toEqual([
      BITBUCKET_CREDENTIAL
    ])
    expect(parseManifest(manifestOf('aios.gmail', { oauth: [GMAIL_MODIFY_CREDENTIAL] })).id).toBe('aios.gmail')
    expect(parseManifest(manifestOf('evil.plugin', { oauth: ['other:thing'] })).id).toBe('evil.plugin')
  })
})

describe('PluginHost.policyOf: credentials in the table only for the bundled owner', () => {
  let dir: string
  let db: Db

  const writePlugin = (where: 'bundled' | 'user', id: string, credentials: { oauth?: string[]; basic?: string[] }): void => {
    const pluginDir = join(dir, where, id)
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifestOf(id, credentials)))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-cred-owner-'))
    db = new Database(':memory:')
    runMigrations(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function load() {
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

  it('the bundled owner keeps the declared names as before', async () => {
    writePlugin('bundled', 'aios.bitbucket', { basic: [BITBUCKET_CREDENTIAL] })
    writePlugin('bundled', 'aios.gmail', { oauth: [GMAIL_MODIFY_CREDENTIAL] })
    // Both are disabled by default (`DEFAULT_DISABLED_PLUGIN_IDS`). The shape is after the user has enabled them.
    for (const id of ['aios.bitbucket', 'aios.gmail']) {
      db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at) VALUES (?, 1, 1)`).run(id)
    }
    const host = await load()
    expect(host.policyOf('aios.bitbucket')?.declared.credentials).toEqual([BITBUCKET_CREDENTIAL])
    expect(host.policyOf('aios.gmail')?.declared.credentials).toEqual([GMAIL_MODIFY_CREDENTIAL])
  })

  it("an outside extension declaring with a different id is not loaded; one claiming the owner's id without being bundled is removed", async () => {
    writePlugin('user', 'evil.plugin', { basic: [BITBUCKET_CREDENTIAL] })
    writePlugin('user', 'aios.gmail', { oauth: [GMAIL_MODIFY_CREDENTIAL, 'other:thing'] })
    const host = await load()
    expect(host.policyOf('evil.plugin')).toBeNull()
    expect(host.isBundled('aios.gmail')).toBe(false)
    expect(host.policyOf('aios.gmail')?.declared.credentials).toEqual(['other:thing'])
  })
})

describe('PluginAccounts: shows no field and accepts no token for an extension that is not the owner or not bundled', () => {
  const sealer: SecretSealer = {
    available: () => true,
    seal: (v) => Buffer.from(v),
    open: (b) => b.toString()
  }
  let dir: string
  let store: CredentialStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-cred-owner-acct-'))
    store = new CredentialStore(dir, sealer)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // A shape that does not pass manifest validation is also assembled directly, in case manifestOf returned it anyway (the double guard).
  const raw = (id: string): PluginManifest =>
    ({
      id,
      name: id,
      version: '1.0.0',
      capabilities: { credentials: { oauth: [GMAIL_MODIFY_CREDENTIAL], basic: [BITBUCKET_CREDENTIAL] } }
    }) as unknown as PluginManifest

  const make = (bundled: ReadonlySet<string>): PluginAccounts =>
    new PluginAccounts({
      credentials: store,
      manifestOf: (id) => raw(id),
      isBundled: (id) => bundled.has(id),
      fetchFn: async () => ({ status: 200, text: async () => '{}' }),
      openUrl: () => undefined,
      chooseClientFile: async () => null
    })

  it('a different id: no field is shown, and saving, login and logout are all unavailable', async () => {
    const accounts = make(new Set(['evil.plugin']))
    expect(accounts.status('evil.plugin')).toEqual([])
    expect(accounts.saveToken('evil.plugin', BITBUCKET_CREDENTIAL, 'a@b.c', 'tok')).toMatchObject({ ok: false, error: 'unavailable' })
    expect(store.status(BITBUCKET_CREDENTIAL).present).toBe(false)
    expect(await accounts.signIn('evil.plugin', GMAIL_MODIFY_CREDENTIAL)).toMatchObject({ ok: false, error: 'unavailable' })
    expect(await accounts.importClient('evil.plugin')).toMatchObject({ ok: false, error: 'unavailable' })
    // A token the owner entered cannot be removed by another extension.
    store.put(BITBUCKET_CREDENTIAL, { value: 'Basic x', host: 'api.bitbucket.org' })
    expect(await accounts.signOut('evil.plugin', BITBUCKET_CREDENTIAL)).toMatchObject({ ok: false, error: 'unavailable' })
    expect(store.status(BITBUCKET_CREDENTIAL).present).toBe(true)
  })

  it("even with the owner's id, shows no field unless bundled; the bundled owner is as before", () => {
    expect(make(new Set()).status('aios.bitbucket')).toEqual([])
    expect(make(new Set()).saveToken('aios.bitbucket', BITBUCKET_CREDENTIAL, 'a@b.c', 'tok')).toMatchObject({ ok: false, error: 'unavailable' })
    const owner = make(new Set(['aios.bitbucket']))
    expect(owner.status('aios.bitbucket').map((row) => row.credential)).toEqual([BITBUCKET_CREDENTIAL])
    expect(owner.saveToken('aios.bitbucket', BITBUCKET_CREDENTIAL, 'a@b.c', 'tok')).toMatchObject({ ok: true })
    expect(make(new Set(['aios.gmail'])).status('aios.gmail').map((row) => row.credential)).toEqual([GMAIL_MODIFY_CREDENTIAL])
  })
})
