/**
 * TODO 952 stage 1 (wave 56 bundle A): the "Accounts" in the extension details (`PluginAccounts`), and `CredentialStore.putClient` / `clientOf`, which seal the OAuth client.
 * Google is not called (instead of a browser, it returns to loopback itself, and the token endpoint is a fake fetch).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore, oauthClientEntryName, type SecretSealer } from '../src/main/capability/credentials.js'
import { GMAIL_MODIFY_CREDENTIAL, GMAIL_MODIFY_SCOPE, GOOGLE_PROVIDER } from '../src/main/capability/google-credentials.js'
import type { FetchFn } from '../src/main/capability/google-oauth.js'
import { PluginAccounts, type PluginAccountsDeps } from '../src/main/plugin/accounts.js'
import { parseManifest } from '../src/main/plugin/manifest.js'
import type { PluginManifest } from '../src/shared/plugin.js'

const sealer: SecretSealer = {
  available: () => true,
  seal: (v) => Buffer.from(`sealed:${v.split('').reverse().join('')}`),
  open: (b) => b.toString().replace(/^sealed:/, '').split('').reverse().join('')
}

const CLIENT_JSON = JSON.stringify({
  installed: { client_id: 'the-client-id', client_secret: 'the-client-secret' }
})

const manifest: PluginManifest = parseManifest({
  id: 'aios.gmail',
  name: 'Gmail',
  version: '1.0.0',
  capabilities: { credentials: { oauth: [GMAIL_MODIFY_CREDENTIAL, 'other:thing'] } }
})

const ok = (json: unknown): { status: number; text(): Promise<string> } => ({
  status: 200,
  text: async () => JSON.stringify(json)
})

let dir: string
let store: CredentialStore
let events: string[]
let chooser: () => Promise<string | null>
let fetchFn: FetchFn

/** Instead of a browser, returns by itself to the redirect_uri of the URL it was given. */
const browser = async (authUrl: string): Promise<void> => {
  const u = new URL(authUrl)
  events.push(`open:${u.searchParams.get('scope')}`)
  const back = new URL(u.searchParams.get('redirect_uri')!)
  back.searchParams.set('code', 'the-code')
  back.searchParams.set('state', u.searchParams.get('state')!)
  await fetch(back).catch(() => undefined)
}

const make = (overrides: Partial<PluginAccountsDeps> = {}): PluginAccounts =>
  new PluginAccounts({
    credentials: store,
    manifestOf: (id) => (id === 'aios.gmail' ? manifest : null),
    isBundled: (id) => id === 'aios.gmail',
    fetchFn: (url, init) => fetchFn(url, init),
    openUrl: browser,
    chooseClientFile: () => chooser(),
    onSignedIn: (id) => events.push(`signedIn:${id}`),
    onSignedOut: (id) => events.push(`signedOut:${id}`),
    onChanged: (id) => events.push(`changed:${id}`),
    ...overrides
  })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-acct-'))
  store = new CredentialStore(dir, sealer)
  events = []
  chooser = async () => CLIENT_JSON
  fetchFn = async () => ok({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: GMAIL_MODIFY_SCOPE })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('client rows of CredentialStore', () => {
  it('sealed when saved and leaves no plaintext; invisible from the plugin entries (status / headerFor)', async () => {
    store.putClient(GOOGLE_PROVIDER, {
      clientId: 'cid',
      clientSecret: 'csecret',
      authUri: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUri: 'https://oauth2.googleapis.com/token'
    })
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).not.toContain('csecret')
    expect(new CredentialStore(dir, sealer).clientOf(GOOGLE_PROVIDER)?.clientSecret).toBe('csecret')
    const name = oauthClientEntryName(GOOGLE_PROVIDER)
    expect(store.status(name).present).toBe(false)
    expect(store.headerFor(name)).toBeNull()
    expect(await store.headerForAsync(name)).toBeNull()
    expect(store.clientOf('other')).toBeNull()
  })
})

describe('PluginAccounts', () => {
  it('shows fields only for declarations in the table (unknown names and plugins without a declaration are not shown)', () => {
    const accounts = make()
    expect(accounts.status('aios.gmail')).toEqual([
      {
        credential: GMAIL_MODIFY_CREDENTIAL,
        provider: 'google',
        clientConfigured: false,
        signedIn: false,
        needsReauth: false,
        signingIn: false
      }
    ])
    expect(accounts.status('aios.other')).toEqual([])
  })

  it('loading the client: revoked, broken JSON and a plugin without a declaration are not saved', async () => {
    const accounts = make()
    chooser = async () => null
    expect(await accounts.importClient('aios.gmail')).toMatchObject({ ok: false, error: 'cancelled' })
    chooser = async () => JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } })
    expect(await accounts.importClient('aios.gmail')).toMatchObject({ ok: false, error: 'bad-client-config' })
    expect(await accounts.importClient('aios.other')).toMatchObject({ ok: false, error: 'unavailable' })
    expect(store.clientOf(GOOGLE_PROVIDER)).toBeNull()
    chooser = async () => CLIENT_JSON
    const result = await accounts.importClient('aios.gmail')
    expect(result).toMatchObject({ ok: true })
    expect(result.accounts[0]?.clientConfigured).toBe(true)
    expect(store.clientOf(GOOGLE_PROVIDER)?.clientId).toBe('the-client-id')
  })

  it('login: refuses when there is no client; otherwise takes consent with gmail.modify and starts the task', async () => {
    const accounts = make()
    expect(await accounts.signIn('aios.gmail', GMAIL_MODIFY_CREDENTIAL)).toMatchObject({ ok: false, error: 'no-client' })
    expect(await accounts.signIn('aios.gmail', 'google:gmail.send')).toMatchObject({ ok: false, error: 'unavailable' })
    await accounts.importClient('aios.gmail')
    const result = await accounts.signIn('aios.gmail', GMAIL_MODIFY_CREDENTIAL)
    expect(result).toMatchObject({ ok: true })
    expect(result.accounts[0]).toMatchObject({ signedIn: true, signingIn: false })
    expect(events).toContain(`open:${GMAIL_MODIFY_SCOPE}`)
    expect(events).toContain('signedIn:aios.gmail')
    // The token is stored so that it attaches only to the destination host.
    expect(store.headerFor(GMAIL_MODIFY_CREDENTIAL)).toMatchObject({ host: 'gmail.googleapis.com', value: 'Bearer at' })
  })

  it('does not save when the scope was removed in consent', async () => {
    const accounts = make()
    await accounts.importClient('aios.gmail')
    fetchFn = async () => ok({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid' })
    expect(await accounts.signIn('aios.gmail', GMAIL_MODIFY_CREDENTIAL)).toMatchObject({ ok: false, error: 'access-denied' })
    expect(store.status(GMAIL_MODIFY_CREDENTIAL).present).toBe(false)
    expect(events).not.toContain('signedIn:aios.gmail')
  })

  it('logout: asks Google to revoke (even if that fails), erases the local copy and discards the continuation position', async () => {
    const accounts = make()
    await accounts.importClient('aios.gmail')
    await accounts.signIn('aios.gmail', GMAIL_MODIFY_CREDENTIAL)
    const sent: string[] = []
    fetchFn = async (url) => {
      sent.push(url)
      throw new Error('offline')
    }
    const result = await accounts.signOut('aios.gmail', GMAIL_MODIFY_CREDENTIAL)
    expect(result).toMatchObject({ ok: true })
    expect(result.accounts[0]?.signedIn).toBe(false)
    expect(sent).toEqual(['https://oauth2.googleapis.com/revoke'])
    expect(events).toContain('signedOut:aios.gmail')
    // The client remains (used when entering it again).
    expect(store.clientOf(GOOGLE_PROVIDER)).not.toBeNull()
  })

  it('refresh: the refresher registered at launch re-fetches using the client', async () => {
    const accounts = make()
    accounts.registerRefreshers()
    await accounts.importClient('aios.gmail')
    store.putOAuth(GMAIL_MODIFY_CREDENTIAL, {
      host: 'gmail.googleapis.com',
      accessToken: 'old',
      refreshToken: 'rt',
      expiresAt: 0,
      scope: GMAIL_MODIFY_SCOPE
    })
    let body = ''
    fetchFn = async (_url, init) => {
      body = init.body
      return ok({ access_token: 'fresh', expires_in: 3600, scope: GMAIL_MODIFY_SCOPE })
    }
    expect((await store.headerForAsync(GMAIL_MODIFY_CREDENTIAL))?.value).toBe('Bearer fresh')
    expect(new URLSearchParams(body).get('client_id')).toBe('the-client-id')
  })
})
