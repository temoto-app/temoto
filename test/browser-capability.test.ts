/**
 * TODO 848 (ARCHITECTURE 7.2 / 7.7): the Broker's `browser.fetchPage` (fetches a page in the logged-in Web display session).
 *
 *  - Per-stage checks (`brokeredPageFetch`): outside the declaration, leaving via redirect, not https, a literal IP, internal resolution,
 *    count, type, size, time
 *  - Broker: no declaration, no consent, no send part, rate, concurrency, audit (the URL drops its query), and shape validation
 *  - The manifest's `capabilities.browser.hosts` (IP / localhost cannot be written)
 *  - PluginHost: even bundled, browser is not granted by default; `aios.reddit` is disabled by default; the tool's `pendingConsent`
 *  - Relay (GatewayRequests): asks the first consent in the approval inbox, and if allowed, records it and does not ask again
 *
 * The real network is not used (`BrowserTransport` is replaced). Neither the model nor Electron is used.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import {
  MAX_BROWSER_CONCURRENT_PER_PLUGIN,
  MAX_BROWSER_PAGE_BYTES,
  MAX_BROWSER_REDIRECTS,
  BROWSER_RATE_LIMIT_PER_MINUTE,
  auditUrl,
  brokeredPageFetch,
  isLiteralOrLocalHost,
  type BrowserHop,
  type BrowserTransport
} from '../src/main/capability/browser.js'
import { parseBrokerRequest } from '../src/main/capability/request-schema.js'
import { ManifestError, declaredCapabilities, parseManifest } from '../src/main/plugin/manifest.js'
import { PluginHost } from '../src/main/plugin/host.js'
import { PluginToolRelay, consentSummary } from '../src/main/plugin/tools.js'
import type { EnabledPluginTool } from '../src/main/plugin/host.js'
import { GatewayRequests, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import type { ApprovalRequestInput, ApprovalResult } from '../src/main/approval/broker.js'
import type { AuditEntry, CapabilityName } from '../src/shared/plugin.js'
import type { Thread } from '../src/shared/thread.js'
import { GATEWAY_TOOL_PREFIX } from '../src/shared/thread.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      throw new Error('fork must not be called')
    }
  }
}))

const PUBLIC = [{ address: '151.101.1.140', family: 4 }]
const HOSTS = ['reddit.com', '*.reddit.com']

function page(text: string, contentType = 'text/html; charset=utf-8', status = 200): BrowserHop {
  return { kind: 'response', status, contentType, body: new TextEncoder().encode(text), truncated: false }
}

/** URL -> the stage's result. Records the URLs sent, in order. */
function fakeTransport(
  routes: Record<string, BrowserHop>,
  options: { addresses?: Record<string, { address: string; family: number }[]>; delayMs?: number } = {}
): BrowserTransport & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    resolve: async (hostname) => options.addresses?.[hostname] ?? PUBLIC,
    send: async (url, { signal }) => {
      sent.push(url.toString())
      if (options.delayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })
      }
      const hop = routes[url.toString()]
      if (hop === undefined) throw new Error(`no route ${url.toString()}`)
      return hop
    }
  }
}

describe('段ごとの検査 (brokeredPageFetch)', () => {
  it('宣言したホストのページを取り、文字列で返す', async () => {
    const transport = fakeTransport({ 'https://www.reddit.com/r/x/': page('<p>héllo</p>') })
    const result = await brokeredPageFetch({ url: 'https://www.reddit.com/r/x/', allowedHosts: HOSTS }, transport)
    expect(result).toEqual({
      status: 200,
      url: 'https://www.reddit.com/r/x/',
      contentType: 'text/html',
      text: '<p>héllo</p>',
      truncated: false
    })
  })

  it('宣言の外のホスト・https でない URL には 1 度も送らない', async () => {
    const transport = fakeTransport({})
    await expect(brokeredPageFetch({ url: 'https://mail.google.com/', allowedHosts: HOSTS }, transport)).rejects.toThrow(
      'host-not-allowed'
    )
    await expect(brokeredPageFetch({ url: 'http://www.reddit.com/', allowedHosts: HOSTS }, transport)).rejects.toThrow('scheme')
    await expect(brokeredPageFetch({ url: 'https://evilreddit.com/', allowedHosts: HOSTS }, transport)).rejects.toThrow(
      'host-not-allowed'
    )
    await expect(brokeredPageFetch({ url: 'https://u:p@www.reddit.com/', allowedHosts: HOSTS }, transport)).rejects.toThrow(
      'scheme'
    )
    expect(transport.sent).toEqual([])
  })

  it('リダイレクトで宣言の外へ出るなら、行き先には送らずに断る', async () => {
    const transport = fakeTransport({
      'https://www.reddit.com/go': { kind: 'redirect', status: 302, location: 'https://bank.example.com/account' },
      'https://bank.example.com/account': page('secret')
    })
    await expect(brokeredPageFetch({ url: 'https://www.reddit.com/go', allowedHosts: HOSTS }, transport)).rejects.toThrow(
      'host-not-allowed'
    )
    expect(transport.sent).toEqual(['https://www.reddit.com/go'])
  })

  it('宣言の中のリダイレクト (相対の Location も) は辿り、最後の URL を返す。http へ落ちるのは断る', async () => {
    const transport = fakeTransport({
      'https://reddit.com/r/x/s/abc': { kind: 'redirect', status: 301, location: 'https://www.reddit.com/r/x/s/abc' },
      'https://www.reddit.com/r/x/s/abc': { kind: 'redirect', status: 302, location: '/r/x/comments/abc1/title/' },
      'https://www.reddit.com/r/x/comments/abc1/title/': page('ok')
    })
    const result = await brokeredPageFetch({ url: 'https://reddit.com/r/x/s/abc', allowedHosts: HOSTS }, transport)
    expect(result.url).toBe('https://www.reddit.com/r/x/comments/abc1/title/')
    expect(transport.sent).toHaveLength(3)

    const down = fakeTransport({ 'https://www.reddit.com/a': { kind: 'redirect', status: 302, location: 'http://www.reddit.com/b' } })
    await expect(brokeredPageFetch({ url: 'https://www.reddit.com/a', allowedHosts: HOSTS }, down)).rejects.toThrow('scheme')
  })

  it('リダイレクトの回数に上限', async () => {
    const routes: Record<string, BrowserHop> = {}
    for (let i = 0; i <= MAX_BROWSER_REDIRECTS + 1; i += 1) {
      routes[`https://www.reddit.com/${i}`] = { kind: 'redirect', status: 302, location: `/${i + 1}` }
    }
    const transport = fakeTransport(routes)
    await expect(brokeredPageFetch({ url: 'https://www.reddit.com/0', allowedHosts: HOSTS }, transport)).rejects.toThrow(
      'too-many-redirects'
    )
    expect(transport.sent).toHaveLength(MAX_BROWSER_REDIRECTS + 1)
  })

  it('IP の直書き・localhost は宣言にあっても断り、内側に解決される名前も断る', async () => {
    const transport = fakeTransport({}, { addresses: { 'internal.reddit.com': [{ address: '10.0.0.5', family: 4 }] } })
    await expect(
      brokeredPageFetch({ url: 'https://192.168.1.1/', allowedHosts: ['192.168.1.1'] }, transport)
    ).rejects.toThrow('host-literal')
    await expect(brokeredPageFetch({ url: 'https://localhost/', allowedHosts: ['localhost'] }, transport)).rejects.toThrow(
      'host-literal'
    )
    await expect(
      brokeredPageFetch({ url: 'https://internal.reddit.com/', allowedHosts: HOSTS }, transport)
    ).rejects.toThrow('private-address')
    expect(transport.sent).toEqual([])
    expect(isLiteralOrLocalHost('127.1')).toBe(true)
    expect(isLiteralOrLocalHost('[::1]')).toBe(true)
    expect(isLiteralOrLocalHost('app.localhost')).toBe(true)
    expect(isLiteralOrLocalHost('www.reddit.com')).toBe(false)
  })

  it('HTML / JSON / テキストだけ。画像などは断る', async () => {
    const json = fakeTransport({ 'https://www.reddit.com/a.json': page('[1]', 'application/json; charset=UTF-8') })
    expect((await brokeredPageFetch({ url: 'https://www.reddit.com/a.json', allowedHosts: HOSTS }, json)).contentType).toBe(
      'application/json'
    )
    const image = fakeTransport({ 'https://www.reddit.com/a.png': page('x', 'image/png') })
    await expect(brokeredPageFetch({ url: 'https://www.reddit.com/a.png', allowedHosts: HOSTS }, image)).rejects.toThrow(
      'unsupported-type'
    )
  })

  it('大きさは上限で切る (transport が守らなくても)', async () => {
    const big: BrowserHop = {
      kind: 'response',
      status: 200,
      contentType: 'text/plain',
      body: new Uint8Array(MAX_BROWSER_PAGE_BYTES + 10).fill(0x61),
      truncated: false
    }
    const result = await brokeredPageFetch(
      { url: 'https://www.reddit.com/big', allowedHosts: HOSTS },
      fakeTransport({ 'https://www.reddit.com/big': big })
    )
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(MAX_BROWSER_PAGE_BYTES)
  })

  it('時間の上限を過ぎたら止めて断る', async () => {
    const slow = fakeTransport({ 'https://www.reddit.com/slow': page('late') }, { delayMs: 1000 })
    await expect(
      brokeredPageFetch({ url: 'https://www.reddit.com/slow', allowedHosts: HOSTS, timeoutMs: 20 }, slow)
    ).rejects.toThrow('timeout')
  })

  it('監査の URL はクエリと断片を落とす', () => {
    expect(auditUrl('https://www.reddit.com/r/x/comments/1/.json?token=secret#frag')).toBe(
      'https://www.reddit.com/r/x/comments/1/.json'
    )
    expect(auditUrl('not a url')).toBe('invalid')
  })
})

describe('Broker 越しの browser 能力', () => {
  let dbDir: string
  let db: InstanceType<typeof Database>
  let audit: AuditLog
  let policy: PluginPolicy | null

  const makePolicy = (consented: CapabilityName[], browserHosts: string[] = HOSTS): PluginPolicy => ({
    id: 'aios.reddit',
    declared: { credentials: [], networkHosts: [], fsRead: [], fsWrite: [], indexSources: [], ui: false, browserHosts },
    consented: new Set(consented)
  })

  const makeBroker = (browser?: BrowserTransport): CapabilityBroker =>
    new CapabilityBroker({
      scope: { rules: testExclusions(homedir()) },
      audit,
      credentials: new CredentialStore(dbDir, { available: () => false, seal: () => Buffer.alloc(0), open: () => '' }),
      policyOf: (id) => (id === 'aios.reddit' ? policy : null),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined,
      ...(browser === undefined ? {} : { browser })
    })

  beforeEach(() => {
    dbDir = makeTestDir('browser-db')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key = '${'d'.repeat(64)}'`)
    runMigrations(db)
    audit = new AuditLog(db)
    policy = makePolicy(['browser'])
  })
  afterEach(() => {
    // Stop it first so the audit log batch (16 ms) does not run after the DB is closed.
    audit.dispose()
    db.close()
  })

  const request = (url: string) => ({ capability: 'browser', op: 'fetchPage', url }) as const

  it('同意が無ければ送らずに断る (同梱でも初回の同意が要る)', async () => {
    policy = makePolicy([])
    const transport = fakeTransport({ 'https://www.reddit.com/': page('x') })
    await expect(makeBroker(transport).handle('aios.reddit', request('https://www.reddit.com/'))).rejects.toThrow(
      'not-consented'
    )
    expect(transport.sent).toEqual([])
    expect((audit.flush(), audit.recent(10))[0]).toMatchObject({ capability: 'browser', op: 'fetchPage', decision: 'deny', reason: 'not-consented' })
  })

  it('宣言が無ければ断る。知らない plugin も断る', async () => {
    policy = makePolicy(['browser'], [])
    const transport = fakeTransport({})
    await expect(makeBroker(transport).handle('aios.reddit', request('https://www.reddit.com/'))).rejects.toThrow('not-declared')
    await expect(makeBroker(transport).handle('other.plugin', request('https://www.reddit.com/'))).rejects.toThrow(
      'unknown-plugin'
    )
  })

  it('送信部が無い起動では unavailable', async () => {
    await expect(makeBroker().handle('aios.reddit', request('https://www.reddit.com/'))).rejects.toThrow('unavailable')
  })

  it('通れば本文を返し、監査に URL (クエリなし) を残す。本文は監査に入らない', async () => {
    const url = 'https://www.reddit.com/r/x/comments/1/.json?raw_json=1&token=secret'
    const transport = fakeTransport({ [url]: page('{"body":"private text"}', 'application/json') })
    const result = (await makeBroker(transport).handle('aios.reddit', request(url))) as { text: string }
    expect(result.text).toBe('{"body":"private text"}')
    const rows = (audit.flush(), audit.recent(10))
    expect(rows[0]).toMatchObject({
      pluginId: 'aios.reddit',
      capability: 'browser',
      op: 'fetchPage',
      target: 'https://www.reddit.com/r/x/comments/1/.json',
      decision: 'allow'
    })
    expect(JSON.stringify(rows)).not.toContain('private text')
    expect(JSON.stringify(rows)).not.toContain('secret')
  })

  it('リダイレクトで外へ出る要求は、監査に host-not-allowed で残る', async () => {
    const transport = fakeTransport({
      'https://www.reddit.com/out': { kind: 'redirect', status: 302, location: 'https://mail.google.com/' }
    })
    await expect(makeBroker(transport).handle('aios.reddit', request('https://www.reddit.com/out'))).rejects.toThrow(
      'host-not-allowed'
    )
    expect((audit.flush(), audit.recent(10))[0]).toMatchObject({ decision: 'deny', reason: 'host-not-allowed', target: 'https://www.reddit.com/out' })
  })

  it('同時数に上限 (待たせずに busy で断る)', async () => {
    const transport = fakeTransport({ 'https://www.reddit.com/slow': page('x') }, { delayMs: 50 })
    const broker = makeBroker(transport)
    const running = Array.from({ length: MAX_BROWSER_CONCURRENT_PER_PLUGIN }, () =>
      broker.handle('aios.reddit', request('https://www.reddit.com/slow'))
    )
    await expect(broker.handle('aios.reddit', request('https://www.reddit.com/slow'))).rejects.toThrow('busy')
    await Promise.all(running)
    // Empties once done.
    await expect(broker.handle('aios.reddit', request('https://www.reddit.com/slow'))).resolves.toMatchObject({ status: 200 })
  })

  it('レートに上限', async () => {
    const transport = fakeTransport({ 'https://www.reddit.com/': page('x') })
    const broker = makeBroker(transport)
    for (let i = 0; i < BROWSER_RATE_LIMIT_PER_MINUTE; i += 1) {
      await broker.handle('aios.reddit', request('https://www.reddit.com/'))
    }
    await expect(broker.handle('aios.reddit', request('https://www.reddit.com/'))).rejects.toThrow('rate-limited')
  })

  it('形の検証: GET の URL だけ。ヘッダや本文・知らない鍵は invalid-request', async () => {
    expect(parseBrokerRequest(request('https://www.reddit.com/'))).not.toBeNull()
    expect(parseBrokerRequest({ ...request('https://www.reddit.com/'), headers: { cookie: 'x' } })).toBeNull()
    expect(parseBrokerRequest({ capability: 'browser', op: 'evaluate', url: 'https://www.reddit.com/', script: '1' })).toBeNull()
    await expect(
      makeBroker(fakeTransport({})).handleUntrusted('aios.reddit', { capability: 'browser', op: 'fetchPage', url: 1 })
    ).rejects.toThrow('invalid-request')
  })
})

describe('マニフェストの capabilities.browser', () => {
  const minimal = { id: 'test.browser', name: 'B', version: '1.0.0' }

  it('hosts を読み、宣言した能力に browser が立つ', () => {
    const manifest = parseManifest({ ...minimal, capabilities: { browser: { hosts: ['reddit.com', '*.reddit.com'] } } })
    expect(manifest.capabilities.browser).toEqual({ hosts: ['reddit.com', '*.reddit.com'] })
    expect(declaredCapabilities(manifest)).toEqual(['browser'])
    expect(declaredCapabilities(parseManifest({ ...minimal, capabilities: { browser: { hosts: [] } } }))).toEqual([])
  })

  it('IP の直書き・localhost・URL・知らない鍵は読み込まない', () => {
    for (const browser of [
      { hosts: ['192.168.1.1'] },
      { hosts: ['127.0.0.1'] },
      { hosts: ['*.localhost'] },
      { hosts: ['https://reddit.com/'] },
      { hosts: ['reddit.com'], cdp: true }
    ]) {
      expect(() => parseManifest({ ...minimal, capabilities: { browser } })).toThrow(ManifestError)
    }
  })
})

describe('PluginHost と同梱の aios.reddit', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-browser-host-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function load(db: InstanceType<typeof Database>): PluginHost {
    const plugins = new PluginHost({
      db,
      bundledDir: join(process.cwd(), 'plugins'),
      userDir: join(dir, 'user'),
      hostEntry: join(dir, 'host.js'),
      broker: () => {
        throw new Error('not used')
      },
      onChanged: () => undefined
    })
    plugins.load()
    return plugins
  }

  it('TODO 1227: 利用者が入れた拡張機能の道具は bundled: false (マニフェストに何を書いても読み込み元で決まる)', () => {
    const userPlugin = join(dir, 'user', 'test-tools')
    mkdirSync(userPlugin, { recursive: true })
    writeFileSync(
      join(userPlugin, 'manifest.json'),
      JSON.stringify({
        id: 'test.tools',
        name: 'Tools',
        version: '1.0.0',
        bundled: true,
        host: { entry: 'host.js' },
        mcp: { tools: [{ name: 'readThing', description: 'x', inputSchema: { type: 'object' } }] }
      })
    )
    writeFileSync(join(userPlugin, 'host.js'), '')
    const db = new Database(':memory:')
    runMigrations(db)
    const plugins = load(db)
    // An unknown manifest key (`bundled`) is not loaded (.strict()). Remove the key and it loads, and is not bundled.
    expect(plugins.summaries().some((p) => p.id === 'test.tools')).toBe(false)
    writeFileSync(
      join(userPlugin, 'manifest.json'),
      JSON.stringify({
        id: 'test.tools',
        name: 'Tools',
        version: '1.0.0',
        host: { entry: 'host.js' },
        mcp: { tools: [{ name: 'readThing', description: 'x', inputSchema: { type: 'object' } }] }
      })
    )
    const reloaded = load(db)
    expect(reloaded.enabledTools().find((t) => t.pluginId === 'test.tools')).toMatchObject({ bundled: false })
    expect(reloaded.isBundled('test.tools')).toBe(false)
  })

  it('TODO 1227 直し X: 同一性は main の事実 — 外は中身のハッシュ (中身が変われば変わる)、同梱は場所。同梱の id を外が名乗っても同梱のまま', async () => {
    const userPlugin = join(dir, 'user', 'test-tools')
    mkdirSync(userPlugin, { recursive: true })
    const manifest = {
      id: 'test.tools',
      name: 'Tools',
      version: '1.0.0',
      host: { entry: 'host.js' },
      mcp: { tools: [{ name: 'readThing', description: 'x', inputSchema: { type: 'object' } }] }
    }
    writeFileSync(join(userPlugin, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(userPlugin, 'host.js'), 'export const mcp = {}')
    // An external extension that claims the same id as the bundled aios.reddit.
    const impostor = join(dir, 'user', 'impostor')
    mkdirSync(impostor, { recursive: true })
    writeFileSync(join(impostor, 'manifest.json'), JSON.stringify({ ...manifest, id: 'aios.reddit' }))
    writeFileSync(join(impostor, 'host.js'), '')
    const db = new Database(':memory:')
    runMigrations(db)
    const first = load(db)
    await first.identitiesReady()
    const before = first.identityOf('test.tools')
    expect(before).toMatch(/^sha256:[0-9a-f]{64}$/)
    const fingerprint = first.enabledTools().find((t) => t.pluginId === 'test.tools')?.fingerprint
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(first.identityOf('aios.reddit')).toBe('bundled')
    expect(first.isBundled('aios.reddit')).toBe(true)
    expect(first.identityOf('nope.missing')).toBeNull()
    // The same id and the same declaration, but only the contents (the host's entry point) were swapped.
    writeFileSync(join(userPlugin, 'host.js'), 'export const mcp = { readThing: () => "sent" }')
    const second = load(db)
    await second.identitiesReady()
    expect(second.identityOf('test.tools')).not.toBe(before)
    expect(second.enabledTools().find((t) => t.pluginId === 'test.tools')?.fingerprint).not.toBe(fingerprint)
  })

  it('既定で無効。有効にしても browser は同梱でも同意済みにしない', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const plugins = load(db)
    const reddit = plugins.summaries().find((p) => p.id === 'aios.reddit')
    expect(reddit).toMatchObject({ bundled: true, enabled: false, capabilities: ['browser'], consented: [] })
    expect(plugins.policyOf('aios.reddit')).toBeNull()
    expect(plugins.enabledTools().filter((t) => t.pluginId === 'aios.reddit')).toEqual([])

    plugins.setEnabled('aios.reddit', true)
    const tools = plugins.enabledTools().filter((t) => t.pluginId === 'aios.reddit')
    expect(tools.map((t) => t.tool.name)).toEqual(['fetchRedditThread'])
    // TODO 1227: whether it is bundled is decided by where it was loaded from (the bundled location), and the gate for unattended turns checks that.
    expect(tools[0]).toMatchObject({ pendingConsent: ['browser'], consentTargets: ['reddit.com', '*.reddit.com'], bundled: true })
    expect(plugins.policyOf('aios.reddit')?.consented.has('browser')).toBe(false)
    expect(plugins.policyOf('aios.reddit')?.declared.browserHosts).toEqual(['reddit.com', '*.reddit.com'])
    expect(plugins.detail('aios.reddit')?.permissions).toEqual([
      {
        capability: 'browser',
        consented: false,
        targets: [
          { mode: null, value: 'reddit.com' },
          { mode: null, value: '*.reddit.com' }
        ]
      }
    ])

    // Not granted again on restart.
    expect(load(db).policyOf('aios.reddit')?.consented.has('browser')).toBe(false)

    // If the user consents it stays, and it can be revoked.
    plugins.setConsent('aios.reddit', 'browser', true)
    expect(plugins.enabledTools().find((t) => t.pluginId === 'aios.reddit')?.pendingConsent).toEqual([])
    expect(load(db).policyOf('aios.reddit')?.consented.has('browser')).toBe(true)
    plugins.setConsent('aios.reddit', 'browser', false)
    expect(load(db).policyOf('aios.reddit')?.consented.has('browser')).toBe(false)
    db.close()
  })
})

describe('中継の初回の同意 (GatewayRequests)', () => {
  function setup(answer: ApprovalResult, sideEffect = false): {
    requests: GatewayRequests
    approvals: ApprovalRequestInput[]
    invoke: ReturnType<typeof vi.fn>
    consents: [string, CapabilityName, boolean][]
    audit: AuditEntry[]
  } {
    const consents: [string, CapabilityName, boolean][] = []
    const tools: EnabledPluginTool[] = [
      {
        pluginId: 'aios.reddit',
        pluginName: 'Reddit',
        tool: {
          name: 'fetchRedditThread',
          description: 'Fetch.',
          inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
          ...(sideEffect ? { sideEffect: true } : {})
        },
        pendingConsent: ['browser'],
        bundled: true,
        consentTargets: HOSTS
      }
    ]
    const invoke = vi.fn(async () => '# thread')
    const audit: AuditEntry[] = []
    const relay = new PluginToolRelay({
      source: {
        enabledTools: () => tools,
        invoke,
        setConsent: (pluginId, capability, granted) => {
          consents.push([pluginId, capability, granted])
          tools[0] = { ...tools[0]!, pendingConsent: [], consentTargets: [] }
        }
      },
      audit: { record: (entry) => audit.push(entry) }
    })
    const approvals: ApprovalRequestInput[] = []
    const host: Partial<GatewayRequestHost> = {
      isStopped: () => false,
      threadIdForSession: () => 't1',
      getThread: (id) =>
        ({ id, title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false }) as unknown as Thread,
      getLive: () => undefined,
      getAdapter: () => undefined,
      emitThread: () => undefined,
      record: () => undefined,
      hasPlanMode: () => false,
      requestApproval: async (input) => {
        approvals.push(input)
        return answer
      },
      pluginTools: relay
    }
    return { requests: new GatewayRequests(host as GatewayRequestHost), approvals, invoke, consents, audit }
  }

  const call = { sessionId: 's1', kind: 'pluginTool', payload: { name: 'aios_reddit__fetchRedditThread', arguments: { url: 'https://www.reddit.com/r/x/comments/1/' } } } as const

  it('読み取りの道具でも、初回は承認箱で聞き、通れば同意を記録して呼ぶ。2 回目は聞かない', async () => {
    const { requests, approvals, invoke, consents } = setup({ allowed: true, by: 'user', message: '' })
    expect(await requests.handle(call)).toEqual({ text: '# thread' })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ alwaysAsk: true, toolName: `${GATEWAY_TOOL_PREFIX}aios_reddit__fetchRedditThread` })
    expect(approvals[0]?.summary).toContain('reddit.com, *.reddit.com')
    expect(consents).toEqual([['aios.reddit', 'browser', true]])
    expect(invoke).toHaveBeenCalledOnce()

    expect(await requests.handle(call)).toEqual({ text: '# thread' })
    expect(approvals).toHaveLength(1)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('副作用のある道具の初回は、同意の文に引数の要約を添える (読み取りの道具には添えない)', async () => {
    const side = setup({ allowed: true, by: 'user', message: '' }, true)
    await side.requests.handle(call)
    expect(side.approvals).toHaveLength(1)
    expect(side.approvals[0]?.summary).toContain('First use: allow aios.reddit')
    expect(side.approvals[0]?.summary).toContain(' — https://www.reddit.com/r/x/comments/1/')
    const read = setup({ allowed: true, by: 'user', message: '' })
    await read.requests.handle(call)
    expect(read.approvals[0]?.summary).not.toContain('https://www.reddit.com/r/x')
  })

  it('断られたら同意を記録せず、呼ばない', async () => {
    const { requests, invoke, consents, audit } = setup({ allowed: false, by: 'user', message: '', reply: { kind: 'stop' } })
    const result = (await requests.handle(call)) as { error?: string }
    expect(result.error).toBeDefined()
    expect(consents).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
    expect(audit.at(-1)).toMatchObject({ decision: 'deny', reason: 'user-denied' })
  })

  it('バックエンドの approve の段では積まない (中継で聞くので二重にしない)', async () => {
    const { requests, approvals } = setup({ allowed: true, by: 'user', message: '' })
    expect(
      await requests.handle({
        sessionId: 's1',
        kind: 'approve',
        payload: { toolName: `${GATEWAY_TOOL_PREFIX}aios_reddit__fetchRedditThread`, input: {} }
      })
    ).toEqual({ allowed: true, message: '' })
    expect(approvals).toEqual([])
  })

  it('同意の要約は plugin id とホストを出す', () => {
    expect(
      consentSummary({
        pluginId: 'aios.reddit',
        exposedName: 'aios_reddit__fetchRedditThread',
        declaration: { name: 'fetchRedditThread', description: 'x', inputSchema: { type: 'object' } },
        sideEffect: false,
        pendingConsent: ['browser'],
        consentTargets: HOSTS,
        bundled: true,
        fingerprint: ''
      })
    ).toBe('First use: allow aios.reddit to read pages with your Web view sign-in (cookies) on reddit.com, *.reddit.com')
  })
})
