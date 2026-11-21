import { describe, expect, it } from 'vitest'
import {
  OAuthError,
  authorizationUrl,
  createPkce,
  loginWithLoopback,
  parseClientConfig,
  refreshAccessToken,
  type FetchFn,
  type OAuthClient
} from '../src/main/capability/google-oauth.js'
import { createHash } from 'node:crypto'

const client: OAuthClient = {
  clientId: 'id.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  authUri: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token'
}

const ok = (json: unknown): Awaited<ReturnType<FetchFn>> => ({ status: 200, text: async () => JSON.stringify(json) })

describe('parseClientConfig', () => {
  const file = (installed: unknown): string => JSON.stringify({ installed })

  it('reads the desktop-app shape', () => {
    const parsed = parseClientConfig(file({ client_id: 'a', client_secret: 'b' }))
    expect(parsed).toMatchObject({ clientId: 'a', clientSecret: 'b' })
    expect(parsed.tokenUri).toBe('https://oauth2.googleapis.com/token')
  })

  it('rejects the web-app shape, missing fields and non-JSON', () => {
    expect(() => parseClientConfig(JSON.stringify({ web: { client_id: 'a', client_secret: 'b' } }))).toThrow(OAuthError)
    expect(() => parseClientConfig(file({ client_id: 'a' }))).toThrow(OAuthError)
    expect(() => parseClientConfig('nope')).toThrow(OAuthError)
  })

  it('refuses a token endpoint that is not Google (the secret would be sent there)', () => {
    expect(() =>
      parseClientConfig(file({ client_id: 'a', client_secret: 'b', token_uri: 'https://evil.example/token' }))
    ).toThrow(/non-Google/)
  })

  it('never puts the secret in an error message', () => {
    try {
      parseClientConfig(file({ client_id: 'a', client_secret: 'b', token_uri: 'https://evil.example/token' }))
    } catch (err) {
      expect(String(err)).not.toContain('"b"')
    }
  })
})

describe('PKCE and the authorization URL', () => {
  it('challenge is the S256 of the verifier, both in base64url', () => {
    const { verifier, challenge } = createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('asks for offline access with S256 and carries state', () => {
    const url = new URL(
      authorizationUrl({
        client,
        redirectUri: 'http://127.0.0.1:5000/',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        state: 'st',
        challenge: 'ch'
      })
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5000/')
    // The secret is not put in the authorization URL (it would remain in the browser history).
    expect(url.toString()).not.toContain('secret-value')
  })
})

describe('loginWithLoopback', () => {
  /** Instead of a browser, returns by itself to the redirect_uri of the URL it was given. */
  const browser = (mutate: (back: URL, state: string) => void) => async (authUrl: string) => {
    const u = new URL(authUrl)
    const back = new URL(u.searchParams.get('redirect_uri')!)
    back.searchParams.set('code', 'the-code')
    back.searchParams.set('state', u.searchParams.get('state')!)
    mutate(back, u.searchParams.get('state')!)
    await fetch(back).catch(() => undefined)
  }

  it('exchanges the code with the verifier and returns tokens', async () => {
    let sent: URLSearchParams | null = null
    const tokens = await loginWithLoopback({
      client,
      scopes: ['s'],
      openUrl: browser(() => undefined),
      fetchFn: async (_url, init) => {
        sent = new URLSearchParams(init.body)
        return ok({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' })
      },
      now: () => 1000
    })
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 3_600_000, scope: 's' })
    expect(sent!.get('grant_type')).toBe('authorization_code')
    expect(sent!.get('code')).toBe('the-code')
    expect(sent!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(sent!.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  })

  it('fails on a wrong state without calling the token endpoint', async () => {
    let called = false
    await expect(
      loginWithLoopback({
        client,
        scopes: ['s'],
        openUrl: browser((back) => back.searchParams.set('state', 'forged')),
        fetchFn: async () => {
          called = true
          return ok({})
        }
      })
    ).rejects.toMatchObject({ code: 'state-mismatch' })
    expect(called).toBe(false)
  })

  it('maps access_denied (the user pressed cancel)', async () => {
    await expect(
      loginWithLoopback({
        client,
        scopes: ['s'],
        openUrl: browser((back) => {
          back.searchParams.delete('code')
          back.searchParams.set('error', 'access_denied')
        }),
        fetchFn: async () => ok({})
      })
    ).rejects.toMatchObject({ code: 'access-denied' })
  })

  it('times out when nobody comes back, and can be cancelled', async () => {
    await expect(
      loginWithLoopback({ client, scopes: ['s'], openUrl: () => undefined, fetchFn: async () => ok({}), timeoutMs: 30 })
    ).rejects.toMatchObject({ code: 'timeout' })
    const ac = new AbortController()
    const pending = loginWithLoopback({ client, scopes: ['s'], openUrl: () => ac.abort(), fetchFn: async () => ok({}), signal: ac.signal })
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('refreshAccessToken', () => {
  it('keeps the old refresh token when the response has none', async () => {
    const t = await refreshAccessToken(client, 'old-rt', async () => ok({ access_token: 'at2', expires_in: 10 }), () => 0)
    expect(t).toMatchObject({ accessToken: 'at2', refreshToken: 'old-rt', expiresAt: 10_000 })
  })

  it('reports invalid_grant (7-day expiry / revoked) as its own code', async () => {
    await expect(
      refreshAccessToken(client, 'rt', async () => ({ status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) }))
    ).rejects.toMatchObject({ code: 'invalid-grant' })
  })

  it('does not echo the response body in the error', async () => {
    await expect(
      refreshAccessToken(client, 'rt', async () => ({ status: 500, text: async () => 'secret-leak-body' }))
    ).rejects.not.toThrow(/secret-leak-body/)
  })
})
