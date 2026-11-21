import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore, type SecretSealer, type TokenRefresher } from '../src/main/capability/credentials.js'
import { OAuthError, type FetchFn, type OAuthClient } from '../src/main/capability/google-oauth.js'
import { registerGoogleRefresher, signInGoogle, signOutGoogle } from '../src/main/capability/google-credentials.js'

/** A sealer that only changes the form, so that the "sealed" state is visible (different from plaintext). */
const sealer: SecretSealer = {
  available: () => true,
  seal: (v) => Buffer.from(`sealed:${v.split('').reverse().join('')}`),
  open: (b) => b.toString().replace(/^sealed:/, '').split('').reverse().join('')
}

const client: OAuthClient = {
  clientId: 'id',
  clientSecret: 'cs',
  authUri: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token'
}
const NAME = 'google:gmail.readonly'
const HOST = 'gmail.googleapis.com'

let dir: string
let store: CredentialStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-cred-'))
  store = new CredentialStore(dir, sealer)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (expiresAt: number, refreshToken: string | null = 'rt-1'): void =>
  store.putOAuth(NAME, { host: HOST, accessToken: 'at-1', refreshToken, expiresAt, scope: 's' })

describe('putOAuth / status', () => {
  it('stores both tokens sealed, and never writes them in plain text', () => {
    put(10_000_000)
    const file = readFileSync(join(dir, 'credentials.json'), 'utf8')
    expect(file).not.toContain('at-1')
    expect(file).not.toContain('rt-1')
    expect(store.headerFor(NAME)).toEqual({ host: HOST, header: 'authorization', value: 'Bearer at-1' })
  })

  it('status() has the same three keys as before and no token', () => {
    put(10_000_000)
    const status = store.status(NAME)
    expect(Object.keys(status).sort()).toEqual(['host', 'present', 'updatedAt'])
    expect(JSON.stringify(status)).not.toMatch(/at-1|rt-1|Bearer/)
  })

  it('needs a refresh token the first time', () => {
    expect(() => put(1, null)).toThrow(/refresh token/)
  })

  it('keeps the previous refresh token when a later put has none', () => {
    put(1)
    store.putOAuth(NAME, { host: HOST, accessToken: 'at-2', refreshToken: null, expiresAt: 2, scope: 's' })
    expect(store.refreshTokenOf(NAME)).toBe('rt-1')
  })

  it('survives a restart (the file is read back)', () => {
    put(10_000_000)
    expect(new CredentialStore(dir, sealer).headerFor(NAME)?.value).toBe('Bearer at-1')
  })

  it('does not store anything when secret storage is unavailable', () => {
    const off = new CredentialStore(dir, { ...sealer, available: () => false })
    expect(() => off.putOAuth(NAME, { host: HOST, accessToken: 'a', refreshToken: 'r', expiresAt: 1, scope: '' })).toThrow()
  })
})

describe('headerForAsync', () => {
  const NOW = 1_000_000
  const refresher = (calls: string[], next: Partial<Awaited<ReturnType<TokenRefresher>>> = {}): TokenRefresher => async (rt) => {
    calls.push(rt)
    return { accessToken: 'at-2', refreshToken: null, expiresAt: NOW + 3_600_000, scope: 's', ...next }
  }

  it('does not refresh while the token is comfortably valid', async () => {
    put(NOW + 3_600_000)
    const calls: string[] = []
    store.setRefresher(NAME, refresher(calls))
    expect((await store.headerForAsync(NAME, () => NOW))?.value).toBe('Bearer at-1')
    expect(calls).toEqual([])
  })

  it('refreshes ahead of expiry (inside the 60 s margin) and uses the new token', async () => {
    put(NOW + 30_000)
    const calls: string[] = []
    store.setRefresher(NAME, refresher(calls))
    expect((await store.headerForAsync(NAME, () => NOW))?.value).toBe('Bearer at-2')
    expect(calls).toEqual(['rt-1'])
    // It was also saved: the next time it does not refresh.
    expect((await store.headerForAsync(NAME, () => NOW))?.value).toBe('Bearer at-2')
    expect(calls).toEqual(['rt-1'])
  })

  it('refreshes an expired token, and rotates the refresh token if Google sends a new one', async () => {
    put(NOW - 1)
    store.setRefresher(NAME, refresher([], { refreshToken: 'rt-2' }))
    await store.headerForAsync(NAME, () => NOW)
    expect(store.refreshTokenOf(NAME)).toBe('rt-2')
  })

  it('runs one refresh for concurrent callers', async () => {
    put(NOW - 1)
    const calls: string[] = []
    store.setRefresher(NAME, refresher(calls))
    const results = await Promise.all([1, 2, 3].map(() => store.headerForAsync(NAME, () => NOW)))
    expect(results.map((r) => r?.value)).toEqual(['Bearer at-2', 'Bearer at-2', 'Bearer at-2'])
    expect(calls).toHaveLength(1)
  })

  it('invalid-grant (7-day expiry / revoked): reauth flag, no header, status looks absent, nothing is deleted', async () => {
    put(NOW - 1)
    store.setRefresher(NAME, async () => {
      throw new OAuthError('invalid-grant', 'token endpoint: invalid_grant')
    })
    expect(await store.headerForAsync(NAME, () => NOW)).toBeNull()
    expect(store.needsReauth(NAME)).toBe(true)
    expect(store.status(NAME).present).toBe(false)
    // Even after a restart it still needs to be entered again.
    expect(new CredentialStore(dir, sealer).needsReauth(NAME)).toBe(true)
    // From the second time on, Google is not called.
    let called = false
    store.setRefresher(NAME, async () => {
      called = true
      throw new Error('x')
    })
    expect(await store.headerForAsync(NAME, () => NOW)).toBeNull()
    expect(called).toBe(false)
  })

  it('signing in again clears the reauth flag', async () => {
    put(NOW - 1)
    store.setRefresher(NAME, async () => {
      throw new OAuthError('invalid-grant', '')
    })
    await store.headerForAsync(NAME, () => NOW)
    put(NOW + 3_600_000, 'rt-new')
    expect(store.needsReauth(NAME)).toBe(false)
    expect(store.status(NAME).present).toBe(true)
  })

  it('a transient failure does NOT ask for re-login; an unexpired token keeps working', async () => {
    put(NOW + 30_000)
    store.setRefresher(NAME, async () => {
      throw new OAuthError('token-request-failed', 'network')
    })
    expect((await store.headerForAsync(NAME, () => NOW))?.value).toBe('Bearer at-1')
    expect(store.needsReauth(NAME)).toBe(false)
  })

  it('a transient failure with an already-expired token throws (and still no re-login)', async () => {
    put(NOW - 1)
    store.setRefresher(NAME, async () => {
      throw new OAuthError('token-request-failed', 'network')
    })
    await expect(store.headerForAsync(NAME, () => NOW)).rejects.toThrow('credential-refresh-failed')
    expect(store.needsReauth(NAME)).toBe(false)
  })

  it('static credentials (put) are returned as before', async () => {
    store.put('static', { value: 'Bearer x', host: 'api.example.com' })
    expect((await store.headerForAsync('static'))?.value).toBe('Bearer x')
    expect(await store.headerForAsync('missing')).toBeNull()
  })
})

describe('google-credentials', () => {
  const ok = (json: unknown): Awaited<ReturnType<FetchFn>> => ({ status: 200, text: async () => JSON.stringify(json) })

  /** Sends the return itself, in place of the browser. */
  const browser = (authUrl: string): void => {
    const u = new URL(authUrl)
    const back = new URL(u.searchParams.get('redirect_uri')!)
    back.searchParams.set('code', 'c')
    back.searchParams.set('state', u.searchParams.get('state')!)
    void fetch(back).catch(() => undefined)
  }

  it('signInGoogle stores the tokens; the refresher registered for the name is used later', async () => {
    const bodies: URLSearchParams[] = []
    const fetchFn: FetchFn = async (_u, init) => {
      const body = new URLSearchParams(init.body)
      bodies.push(body)
      return body.get('grant_type') === 'authorization_code'
        ? ok({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 1, scope: 'sc' })
        : ok({ access_token: 'at-2', expires_in: 3600, scope: 'sc' })
    }
    await signInGoogle({ store, name: NAME, host: HOST, client, scopes: ['sc'], openUrl: browser, fetchFn })
    registerGoogleRefresher(store, NAME, () => client, fetchFn)
    // expires_in: 1 -> immediately a target for refresh
    expect((await store.headerForAsync(NAME))?.value).toBe('Bearer at-2')
    expect(bodies.at(-1)!.get('refresh_token')).toBe('rt-1')
    expect(store.refreshTokenOf(NAME)).toBe('rt-1')
  })

  it('refuses to store when the user unticked a required scope', async () => {
    const fetchFn: FetchFn = async () => ok({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'other' })
    await expect(
      signInGoogle({ store, name: NAME, host: HOST, client, scopes: ['sc'], openUrl: browser, fetchFn })
    ).rejects.toMatchObject({ code: 'access-denied' })
    expect(store.names()).toEqual([])
  })

  it('refuses to store when no refresh token came back', async () => {
    const fetchFn: FetchFn = async () => ok({ access_token: 'a', expires_in: 3600, scope: 'sc' })
    await expect(
      signInGoogle({ store, name: NAME, host: HOST, client, scopes: ['sc'], openUrl: browser, fetchFn })
    ).rejects.toMatchObject({ code: 'token-request-failed' })
    expect(store.names()).toEqual([])
  })

  it('signOutGoogle revokes at Google, then removes locally — and removes even if the revoke fails', async () => {
    put(1)
    const seen: Array<{ url: string; token: string | null }> = []
    await signOutGoogle({
      store,
      name: NAME,
      fetchFn: async (url, init) => {
        seen.push({ url, token: new URLSearchParams(init.body).get('token') })
        return ok({})
      }
    })
    expect(seen).toEqual([{ url: 'https://oauth2.googleapis.com/revoke', token: 'rt-1' }])
    expect(store.names()).toEqual([])

    put(1)
    await signOutGoogle({
      store,
      name: NAME,
      fetchFn: async () => {
        throw new Error('offline')
      }
    })
    expect(store.names()).toEqual([])
  })

  it('TODO 1264 review: does not revoke while another Google credential of the shared client is kept; the last one revokes', async () => {
    const CALENDAR = 'google:calendar.readonly'
    const GMAIL = 'google:gmail.modify'
    store.putOAuth(GMAIL, { host: HOST, accessToken: 'at-g', refreshToken: 'rt-gmail', expiresAt: 1, scope: 's' })
    store.putOAuth(CALENDAR, { host: 'www.googleapis.com', accessToken: 'at-c', refreshToken: 'rt-cal', expiresAt: 1, scope: 's' })
    const revoked: Array<string | null> = []
    const fetchFn: FetchFn = async (_url, init) => {
      revoked.push(new URLSearchParams(init.body).get('token'))
      return ok({})
    }
    // Calendar signs out while Gmail is still signed in: local copy only, Gmail's grant is untouched.
    await signOutGoogle({ store, name: CALENDAR, fetchFn })
    expect(revoked).toEqual([])
    expect(store.names()).toEqual([GMAIL])
    expect(store.headerFor(GMAIL)?.value).toBe('Bearer at-g')
    // Gmail is now the last one: revoked at Google.
    await signOutGoogle({ store, name: GMAIL, fetchFn })
    expect(revoked).toEqual(['rt-gmail'])
    expect(store.names()).toEqual([])
  })

  it('TODO 1264 review: a credential waiting for a new sign-in still counts as kept; non-Google rows and the client row do not', async () => {
    const CALENDAR = 'google:calendar.readonly'
    store.putOAuth(NAME, { host: HOST, accessToken: 'at-r', refreshToken: 'rt-r', expiresAt: 1, scope: 's' })
    store.setRefresher(NAME, async () => {
      throw new OAuthError('invalid-grant', 'revoked')
    })
    await store.headerForAsync(NAME, () => 10_000_000)
    expect(store.needsReauth(NAME)).toBe(true)
    store.putOAuth(CALENDAR, { host: 'www.googleapis.com', accessToken: 'at-c', refreshToken: 'rt-cal', expiresAt: 1, scope: 's' })
    const revoked: Array<string | null> = []
    const fetchFn: FetchFn = async (_url, init) => {
      revoked.push(new URLSearchParams(init.body).get('token'))
      return ok({})
    }
    await signOutGoogle({ store, name: CALENDAR, fetchFn })
    expect(revoked).toEqual([])
    store.remove(NAME)

    store.put('redmine:api', { value: 'k', host: 'redmine.example.com' })
    store.putClient('google', { clientId: 'id', clientSecret: 'cs', authUri: client.authUri, tokenUri: client.tokenUri })
    store.putOAuth(CALENDAR, { host: 'www.googleapis.com', accessToken: 'at-c', refreshToken: 'rt-cal', expiresAt: 1, scope: 's' })
    await signOutGoogle({ store, name: CALENDAR, fetchFn })
    expect(revoked).toEqual(['rt-cal'])
  })
})
