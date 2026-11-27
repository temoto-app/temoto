/**
 * The network capability of CapabilityBroker (ARCHITECTURE.md 7.7).
 *
 * The other of the two tests that IMPLEMENTATION_BRIEF chapter 7 makes **mandatory**.
 * **It must always include a private IP case.**
 *
 * The real network is not used. `NetTransport` is replaced, and the results of name resolution and redirects are given directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import {
  RateLimiter,
  checkRedirect,
  hostAllowed,
  isBlockedAddress,
  pickAddress
} from '../src/main/capability/net-policy.js'
import { brokeredFetch, type NetTransport } from '../src/main/capability/network.js'
import type { CapabilityName } from '../src/shared/plugin.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

describe('addresses that must not be connected to (7.7)', () => {
  const blocked = [
    '127.0.0.1',
    '127.53.1.9',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata; a classic SSRF target
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped
    '::ffff:10.0.0.1',
    '64:ff9b::192.168.0.1', // NAT64
    '64:ff9b:1::a00:1', // local NAT64 (TODO 1073)
    '2002:7f00:1::', // 6to4 with 127.0.0.1
    '2002:c0a8:101::1', // 6to4 with 192.168.1.1
    '2001:0:7f00:1::1', // Teredo server at 127.0.0.1
    '2001:0:808:808::f5ff:f5fe', // Teredo client at 10.0.10.1
    '0:0:0:0:0:0:0:1', // Expanded form of ::1 (TODO 575)
    '::ffff:7f00:1', // Hex form of the IPv4-mapped address (TODO 575)
    '0:0:0:0:0:ffff:a00:1', // Expanded form of the mapped 10.0.0.1 (TODO 575)
    '::127.0.0.1', // IPv4-compatible (TODO 1135)
    '::7f00:1',
    '::ffff:0:7f00:1', // IPv4-translated
    'fec0::1' // site-local
  ]
  for (const address of blocked) {
    it(`rejects ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(true)
    })
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '11.0.0.1', '2606:4700::1111', '2002:808:808::1', '64:ff9b::808:808']
  for (const address of allowed) {
    it(`passes ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(false)
    })
  }
})

describe('matching allowed hosts (7.2)', () => {
  it('exact match', () => {
    expect(hostAllowed('gmail.googleapis.com', ['gmail.googleapis.com'])).toBe(true)
    expect(hostAllowed('evil.com', ['gmail.googleapis.com'])).toBe(false)
  })

  it('a wildcard is only within the same domain', () => {
    expect(hostAllowed('a.example.com', ['*.example.com'])).toBe(true)
    expect(hostAllowed('a.b.example.com', ['*.example.com'])).toBe(true)
    // Does not match the domain itself
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false)
    // Does not match a different domain that only has a similar suffix either
    expect(hostAllowed('evil-example.com', ['*.example.com'])).toBe(false)
    expect(hostAllowed('exampleXcom', ['*.example.com'])).toBe(false)
  })

  it('ignores case', () => {
    expect(hostAllowed('GMail.GoogleAPIs.com', ['gmail.googleapis.com'])).toBe(true)
  })
})

describe('result of name resolution (DNS rebinding defense)', () => {
  it('rejects if even one resolves to the inside', () => {
    expect(() =>
      pickAddress([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 }
      ])
    ).toThrow('private-address')
  })

  it('if all are outside, pins to the first address', () => {
    const picked = pickAddress([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800::1', family: 6 }
    ])
    expect(picked.address).toBe('93.184.216.34')
  })

  it('rejects if it cannot be resolved', () => {
    expect(() => pickAddress([])).toThrow('no-address')
  })
})

describe('redirects (7.7)', () => {
  it('does not go outside the allow-list', () => {
    expect(() =>
      checkRedirect(new URL('https://api.example.com/a'), 'https://evil.com/x', ['api.example.com'], null)
    ).toThrow('host-not-allowed')
  })

  it('does not go to anything other than https', () => {
    expect(() =>
      checkRedirect(new URL('https://api.example.com/a'), 'http://api.example.com/x', ['api.example.com'], null)
    ).toThrow('scheme')
  })

  it('keeps credentials if the host is the same', () => {
    const decision = checkRedirect(
      new URL('https://api.example.com/a'),
      '/b',
      ['api.example.com'],
      'api.example.com'
    )
    expect(decision.keepCredentials).toBe(true)
    expect(decision.next.href).toBe('https://api.example.com/b')
  })

  it('**strips credentials if the host changes**', () => {
    const decision = checkRedirect(
      new URL('https://api.example.com/a'),
      'https://cdn.example.com/b',
      ['api.example.com', 'cdn.example.com'],
      'api.example.com'
    )
    expect(decision.keepCredentials).toBe(false)
  })
})

describe('rate limit', () => {
  it('rejects when the limit is exceeded within the window', () => {
    const limiter = new RateLimiter(3, 60_000)
    limiter.take('p', 1000)
    limiter.take('p', 1001)
    limiter.take('p', 1002)
    expect(() => limiter.take('p', 1003)).toThrow('rate-limited')
    // It passes once the window has passed
    expect(() => limiter.take('p', 62_000)).not.toThrow()
  })

  it('counts per plugin', () => {
    const limiter = new RateLimiter(1, 60_000)
    limiter.take('a', 1000)
    expect(() => limiter.take('b', 1000)).not.toThrow()
  })
})

// ---- the whole path (Broker -> brokeredFetch -> transport) ----

interface Sent {
  url: string
  headers: Record<string, string>
  address: string
}

function fakeTransport(
  responses: readonly { status: number; headers?: Record<string, string>; body?: string }[],
  addresses: Record<string, readonly { address: string; family: number }[]>,
  sent: Sent[]
): NetTransport {
  let hop = 0
  return {
    async resolve(hostname) {
      return addresses[hostname] ?? [{ address: '93.184.216.34', family: 4 }]
    },
    async send(url, options) {
      sent.push({ url: url.href, headers: options.headers, address: options.address })
      const response = responses[Math.min(hop, responses.length - 1)]
      hop += 1
      return {
        status: response?.status ?? 200,
        headers: response?.headers ?? {},
        body: new TextEncoder().encode(response?.body ?? 'ok'),
        truncated: false
      }
    }
  }
}

describe('brokeredFetch path', () => {
  it('connects pinned to the resolved address', async () => {
    const sent: Sent[] = []
    await brokeredFetch(
      {
        url: 'https://api.example.com/x',
        method: 'GET',
        headers: {},
        body: null,
        allowedHosts: ['api.example.com'],
        credential: null
      },
      fakeTransport([{ status: 200 }], { 'api.example.com': [{ address: '93.184.216.34', family: 4 }] }, sent)
    )
    expect(sent[0]?.address).toBe('93.184.216.34')
  })

  it('does not talk to a host that resolves to the inside', async () => {
    const sent: Sent[] = []
    await expect(
      brokeredFetch(
        {
          url: 'https://internal.example.com/x',
          method: 'GET',
          headers: {},
          body: null,
          allowedHosts: ['internal.example.com'],
          credential: null
        },
        fakeTransport([{ status: 200 }], { 'internal.example.com': [{ address: '127.0.0.1', family: 4 }] }, sent)
      )
    ).rejects.toThrow('private-address')
    expect(sent).toHaveLength(0)
  })

  it('**drops an Authorization that the plugin attached itself**', async () => {
    const sent: Sent[] = []
    await brokeredFetch(
      {
        url: 'https://api.example.com/x',
        method: 'GET',
        headers: { Authorization: 'Bearer stolen', Cookie: 'a=b', 'X-Ok': '1' },
        body: null,
        allowedHosts: ['api.example.com'],
        credential: null
      },
      fakeTransport([{ status: 200 }], {}, sent)
    )
    const headers = sent[0]?.headers ?? {}
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization')
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('cookie')
    expect(headers['X-Ok']).toBe('1')
  })

  it('credentials are attached only to the bound host and are stripped on redirect', async () => {
    const sent: Sent[] = []
    await brokeredFetch(
      {
        url: 'https://api.example.com/x',
        method: 'GET',
        headers: {},
        body: null,
        allowedHosts: ['api.example.com', 'cdn.example.com'],
        credential: { host: 'api.example.com', header: 'authorization', value: 'Bearer t0ken' }
      },
      fakeTransport(
        [
          { status: 302, headers: { location: 'https://cdn.example.com/y' } },
          { status: 200 }
        ],
        {},
        sent
      )
    )
    expect(sent[0]?.headers['authorization']).toBe('Bearer t0ken')
    expect(sent[1]?.url).toBe('https://cdn.example.com/y')
    expect(sent[1]?.headers['authorization']).toBeUndefined()
  })

  it('there is a limit on following redirects', async () => {
    const sent: Sent[] = []
    await expect(
      brokeredFetch(
        {
          url: 'https://api.example.com/x',
          method: 'GET',
          headers: {},
          body: null,
          allowedHosts: ['api.example.com'],
          credential: null
        },
        fakeTransport([{ status: 302, headers: { location: '/loop' } }], {}, sent)
      )
    ).rejects.toThrow('too-many-redirects')
  })

  it('does not send anything other than https', async () => {
    const sent: Sent[] = []
    await expect(
      brokeredFetch(
        {
          url: 'http://api.example.com/x',
          method: 'GET',
          headers: {},
          body: null,
          allowedHosts: ['api.example.com'],
          credential: null
        },
        fakeTransport([{ status: 200 }], {}, sent)
      )
    ).rejects.toThrow('scheme')
  })
})

describe('network capability through the Broker', () => {
  let broker: CapabilityBroker
  let dbDir: string
  let db: Db
  let audit: AuditLog
  let currentPolicy: PluginPolicy

  const makePolicy = (declared: Partial<PluginPolicy['declared']>): PluginPolicy => ({
    id: 'test.plugin',
    declared: {
      credentials: [],
      networkHosts: [],
      fsRead: [],
      fsWrite: [],
      indexSources: [],
      ui: false,
      ...declared
    },
    consented: new Set<CapabilityName>(['fs', 'network', 'credentials', 'index', 'ui'])
  })

  beforeEach(() => {
    dbDir = makeTestDir('net-db')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key = '${'d'.repeat(64)}'`)
    runMigrations(db)
    audit = new AuditLog(db)
    currentPolicy = makePolicy({})
    broker = new CapabilityBroker({
      scope: { rules: testExclusions(homedir()) },
      audit,
      credentials: new CredentialStore(dbDir, {
        available: () => false,
        seal: () => Buffer.alloc(0),
        open: () => ''
      }),
      policyOf: (id) => (id === 'test.plugin' ? currentPolicy : null),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined,
      transport: fakeTransport([{ status: 200 }], {}, [])
    })
  })

  it('cannot go to a host that is not declared', async () => {
    currentPolicy = makePolicy({ networkHosts: ['api.example.com'] })
    await expect(
      broker.handle('test.plugin', {
        capability: 'network',
        op: 'fetch',
        url: 'https://evil.com/x'
      })
    ).rejects.toThrow('host-not-allowed')
  })

  it('if no network is declared at all, the capability itself cannot be used', async () => {
    currentPolicy = makePolicy({})
    await expect(
      broker.handle('test.plugin', {
        capability: 'network',
        op: 'fetch',
        url: 'https://api.example.com/x'
      })
    ).rejects.toThrow('not-declared')
  })

  it('cannot use a credential name that is not declared', async () => {
    currentPolicy = makePolicy({ networkHosts: ['api.example.com'], credentials: [] })
    await expect(
      broker.handle('test.plugin', {
        capability: 'network',
        op: 'fetch',
        url: 'https://api.example.com/x',
        auth: 'google:gmail'
      })
    ).rejects.toThrow('not-declared')
  })

  it('**the credential value does not return to the plugin** (status is presence only)', async () => {
    currentPolicy = makePolicy({ credentials: ['google:gmail'] })
    const status = (await broker.handle('test.plugin', {
      capability: 'credentials',
      op: 'status',
      name: 'google:gmail'
    })) as Record<string, unknown>
    expect(Object.keys(status).sort()).toEqual(['host', 'present', 'updatedAt'])
    expect(JSON.stringify(status)).not.toContain('Bearer')
  })

  afterEach(() => {
    // Stop it first so the audit log batch (16 ms) does not run after the DB is removed.
    audit.dispose()
    db.close()
    rmSync(dbDir, { recursive: true, force: true })
  })
})

describe('OAuth credentials through the Broker (TODO 817): expired ones are refreshed before sending', () => {
  const HOST = 'gmail.googleapis.com'
  const NAME = 'google:gmail.readonly'
  let dbDir: string
  let db: Db
  let audit: AuditLog
  let store: CredentialStore
  let broker: CapabilityBroker
  let sent: Sent[]
  let refreshed: string[]

  const policy: PluginPolicy = {
    id: 'aios.gmail',
    declared: {
      credentials: [NAME],
      networkHosts: [HOST],
      fsRead: [],
      fsWrite: [],
      indexSources: [],
      ui: false
    },
    consented: new Set<CapabilityName>(['network', 'credentials'])
  }

  beforeEach(() => {
    dbDir = makeTestDir('net-oauth-db')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key = '${'d'.repeat(64)}'`)
    runMigrations(db)
    audit = new AuditLog(db)
    store = new CredentialStore(dbDir, {
      available: () => true,
      seal: (v) => Buffer.from(v, 'utf8'),
      open: (b) => b.toString('utf8')
    })
    refreshed = []
    store.setRefresher(NAME, async (rt) => {
      refreshed.push(rt)
      return { accessToken: 'fresh', refreshToken: null, expiresAt: Date.now() + 3_600_000, scope: 's' }
    })
    sent = []
    broker = new CapabilityBroker({
      scope: { rules: testExclusions(homedir()) },
      audit,
      credentials: store,
      policyOf: (id) => (id === 'aios.gmail' ? policy : null),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined,
      transport: fakeTransport([{ status: 200 }], {}, sent)
    })
  })

  afterEach(() => {
    audit.dispose()
    db.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  const request = {
    capability: 'network',
    op: 'fetch',
    url: `https://${HOST}/gmail/v1/users/me/profile`,
    auth: NAME
  } as const

  it('an expired access token is refreshed and then sent (the old value is not sent)', async () => {
    await store.putOAuth(NAME, { host: HOST, accessToken: 'stale', refreshToken: 'rt', expiresAt: Date.now() - 1000, scope: 's' })
    await broker.handle('aios.gmail', request)
    expect(refreshed).toEqual(['rt'])
    expect(sent[0]?.headers['authorization']).toBe('Bearer fresh')
  })

  it('if within the expiry, sends as is (no refresh)', async () => {
    await store.putOAuth(NAME, { host: HOST, accessToken: 'live', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: 's' })
    await broker.handle('aios.gmail', request)
    expect(refreshed).toEqual([])
    expect(sent[0]?.headers['authorization']).toBe('Bearer live')
  })

  it('for a credential that needs re-entry, sending stops with no-credential (the token is not sent)', async () => {
    await store.putOAuth(NAME, { host: HOST, accessToken: 'stale', refreshToken: 'rt', expiresAt: Date.now() - 1000, scope: 's' })
    const { OAuthError } = await import('../src/main/capability/google-oauth.js')
    store.setRefresher(NAME, async () => {
      throw new OAuthError('invalid-grant', 'x')
    })
    await expect(broker.handle('aios.gmail', request)).rejects.toThrow('no-credential')
    expect(sent).toHaveLength(0)
  })

  it('does not attach credentials to another host (even at a redirect target)', async () => {
    await store.putOAuth(NAME, { host: HOST, accessToken: 'live', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: 's' })
    const other = new CapabilityBroker({
      scope: { rules: testExclusions(homedir()) },
      audit,
      credentials: store,
      policyOf: () => ({ ...policy, declared: { ...policy.declared, networkHosts: [HOST, 'other.example.com'] } }),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined,
      transport: fakeTransport([{ status: 302, headers: { location: 'https://other.example.com/x' } }, { status: 200 }], {}, sent)
    })
    await other.handle('aios.gmail', request)
    expect(sent[0]?.headers['authorization']).toBe('Bearer live')
    expect(sent[1]?.headers['authorization']).toBeUndefined()
  })

  it('wave 84 fix Z: an extension that is not the owner cannot make credentials attached even if it declares the same name (and does not send either)', async () => {
    await store.putOAuth(NAME, { host: HOST, accessToken: 'live', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: 's' })
    const evil = new CapabilityBroker({
      scope: { rules: testExclusions(homedir()) },
      audit,
      credentials: store,
      // When the policy is assembled from outside, skipping manifest validation and policyOf (the Broker's double guard)
      policyOf: (id) => (id === 'evil.plugin' ? { ...policy, id } : null),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined,
      transport: fakeTransport([{ status: 200 }], {}, sent)
    })
    await expect(evil.handle('evil.plugin', request)).rejects.toThrow('not-owner')
    await expect(evil.handle('evil.plugin', { capability: 'credentials', op: 'status', name: NAME })).rejects.toThrow('not-owner')
    expect(sent).toHaveLength(0)
    // The owner is the same as before
    await broker.handle('aios.gmail', request)
    expect(sent[0]?.headers['authorization']).toBe('Bearer live')
  })
})
