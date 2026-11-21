/**
 * Google OAuth (desktop app type, loopback + PKCE), TODO 817 stage A.
 *
 * **Main runs the OAuth flow** (ARCHITECTURE.md 7.7). This holds pure parts that do not import electron; the entry point for opening a browser (`openUrl`)
 * and for HTTP (`fetchFn`) are passed in by the caller. Token values are never handed to plugins
 * (`CredentialStore` seals them, and the `auth` of `net.fetch` attaches them at send time).
 *
 * Flow (RFC 8252 / RFC 7636):
 *   1. Wait exactly once on `127.0.0.1:<free port>`. `state` and the PKCE `code_verifier` are random values for this one round.
 *   2. Open the consent screen in the default browser (Google rejects embedded browsers; 721).
 *   3. Send the returned `code` with the `code_verifier` to the token endpoint and exchange it for access / refresh tokens.
 *
 * **Logs say only "what happened".** Not one character of a code / token / secret is written (an extension of constraint 10).
 * On the consent screen in "testing" mode the refresh token expires in 7 days; `invalid_grant` is returned as `OAuthError('invalid-grant')`.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { log } from '../../common/logger.js'
import { PRODUCT_NAME } from '@shared/product.js'

export const GOOGLE_AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'

/** The needed part of `installed` in the downloaded `client_secret_*.json`. */
export interface OAuthClient {
  readonly clientId: string
  /** By Google's design a desktop-app secret cannot be fully secret. The value is still not logged. */
  readonly clientSecret: string
  readonly authUri: string
  readonly tokenUri: string
}

export interface OAuthTokens {
  readonly accessToken: string
  /** Not included in a refresh response unless consent is obtained again. */
  readonly refreshToken: string | null
  /** Expiry of the access token (epoch ms). */
  readonly expiresAt: number
  readonly scope: string
}

export type OAuthErrorCode =
  | 'bad-client-config'
  | 'timeout'
  | 'cancelled'
  | 'state-mismatch'
  | 'access-denied'
  | 'invalid-grant'
  | 'token-request-failed'

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

export type FetchFn = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{
  status: number
  text(): Promise<string>
}>

/** Reads `client_secret_*.json` and accepts only the desktop app type (`installed`). The value is returned but never put in an error message. */
export function parseClientConfig(json: string): OAuthClient {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new OAuthError('bad-client-config', 'client config is not JSON')
  }
  const installed = (raw as { installed?: Record<string, unknown> } | null)?.installed
  if (installed === undefined || installed === null || typeof installed !== 'object') {
    throw new OAuthError('bad-client-config', 'client config has no "installed" section (desktop app type is required)')
  }
  const { client_id: clientId, client_secret: clientSecret } = installed
  if (typeof clientId !== 'string' || clientId === '' || typeof clientSecret !== 'string' || clientSecret === '') {
    throw new OAuthError('bad-client-config', 'client config lacks client_id / client_secret')
  }
  const authUri = typeof installed.auth_uri === 'string' ? installed.auth_uri : GOOGLE_AUTH_URI
  const tokenUri = typeof installed.token_uri === 'string' ? installed.token_uri : GOOGLE_TOKEN_URI
  // Even if the config file names another host, the destinations tokens are sent to are fixed to Google's two.
  if (new URL(authUri).origin !== new URL(GOOGLE_AUTH_URI).origin || new URL(tokenUri).origin !== new URL(GOOGLE_TOKEN_URI).origin) {
    throw new OAuthError('bad-client-config', 'client config points at a non-Google endpoint')
  }
  return { clientId, clientSecret, authUri, tokenUri }
}

const base64url = (buf: Buffer): string => buf.toString('base64url')

/** RFC 7636: a verifier is 43 to 128 characters. 32 random bytes -> 43 characters. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function authorizationUrl(input: {
  client: OAuthClient
  redirectUri: string
  scopes: readonly string[]
  state: string
  challenge: string
  /** Preselect the user's account (narrows the addresses shown on the consent screen). */
  loginHint?: string
}): string {
  const url = new URL(input.client.authUri)
  url.searchParams.set('client_id', input.client.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', input.scopes.join(' '))
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // Get a refresh token (offline). Show consent every time so a refresh token is returned even if an earlier consent remains.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  if (input.loginHint !== undefined) url.searchParams.set('login_hint', input.loginHint)
  return url.toString()
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3em auto;max-width:28em"><h1>${title}</h1><p>${body}</p>`

interface LoopbackResult {
  readonly code: string
}

/**
 * Waits exactly once on `127.0.0.1`. Looks only at the first GET to `/` and then closes.
 * One whose `state` does not match **is made a failure, not ignored** (so a forged return from another tab cannot make us take a code).
 */
function listenOnce(input: {
  state: string
  timeoutMs: number
  signal?: AbortSignal
  onListening: (redirectUri: string) => void
}): Promise<LoopbackResult> {
  return new Promise<LoopbackResult>((resolve, reject) => {
    let settled = false
    let server: Server | null = null
    let timer: NodeJS.Timeout | null = null

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      // A keep-alive connection left open would keep close from returning, so close and then cut.
      server?.close()
      server?.closeAllConnections()
      fn()
    }

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      if (state !== input.state) {
        res.writeHead(400).end(PAGE(PRODUCT_NAME, 'The sign-in response did not match. Close this tab and try again.'))
        finish(() => reject(new OAuthError('state-mismatch', 'state mismatch in the loopback response')))
        return
      }
      if (error !== null) {
        res.writeHead(200).end(PAGE(PRODUCT_NAME, 'Sign-in was not completed. You can close this tab.'))
        finish(() =>
          reject(new OAuthError(error === 'access_denied' ? 'access-denied' : 'token-request-failed', `authorization error: ${error}`))
        )
        return
      }
      if (code === null || code === '') {
        res.writeHead(400).end(PAGE(PRODUCT_NAME, 'No authorization code was returned.'))
        finish(() => reject(new OAuthError('token-request-failed', 'no code in the loopback response')))
        return
      }
      res.writeHead(200).end(PAGE(PRODUCT_NAME, `Signed in. You can close this tab and return to ${PRODUCT_NAME}.`))
      finish(() => resolve({ code }))
    })

    server.on('error', (err) => finish(() => reject(err)))
    timer = setTimeout(() => finish(() => reject(new OAuthError('timeout', 'sign-in timed out'))), input.timeoutMs)
    input.signal?.addEventListener('abort', () => finish(() => reject(new OAuthError('cancelled', 'sign-in cancelled'))), { once: true })

    // Bind by number, not `localhost` (name resolution must not land on another interface). Let the OS choose the port.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server!.address() as AddressInfo
      input.onListening(`http://127.0.0.1:${port}/`)
    })
  })
}

async function tokenRequest(
  client: OAuthClient,
  params: Record<string, string>,
  fetchFn: FetchFn,
  now: () => number
): Promise<OAuthTokens> {
  const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }).toString()
  const res = await fetchFn(client.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // If the body is not JSON, just look at the status below and fail. The body is not put in the error message.
  }
  if (res.status !== 200) {
    const error = typeof json.error === 'string' ? json.error : `http ${res.status}`
    // The 7-day expiry, a password change, and revocation are all invalid_grant. The caller shows "please sign in again".
    throw new OAuthError(error === 'invalid_grant' ? 'invalid-grant' : 'token-request-failed', `token endpoint: ${error}`)
  }
  const accessToken = json.access_token
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || accessToken === '' || typeof expiresIn !== 'number') {
    throw new OAuthError('token-request-failed', 'token endpoint returned an unexpected shape')
  }
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token !== '' ? json.refresh_token : null,
    expiresAt: now() + expiresIn * 1000,
    scope: typeof json.scope === 'string' ? json.scope : ''
  }
}

export interface LoginInput {
  readonly client: OAuthClient
  readonly scopes: readonly string[]
  /** Opens a URL in the default browser (`shell.openExternal` and the like). */
  readonly openUrl: (url: string) => void | Promise<void>
  readonly fetchFn: FetchFn
  readonly loginHint?: string
  /** Default is 5 minutes. It waits while the user is stuck on the consent screen. */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly now?: () => number
}

/** Obtains consent in the browser and returns the tokens. Saving is the caller's job (`CredentialStore.put`). */
export async function loginWithLoopback(input: LoginInput): Promise<OAuthTokens> {
  const now = input.now ?? Date.now
  const state = base64url(randomBytes(16))
  const pkce = createPkce()
  let redirectUri = ''
  const waiting = listenOnce({
    state,
    timeoutMs: input.timeoutMs ?? 5 * 60_000,
    signal: input.signal,
    onListening: (uri) => {
      redirectUri = uri
      log.info('google-oauth.login.start', { scopes: input.scopes.length })
      const url = authorizationUrl({
        client: input.client,
        redirectUri: uri,
        scopes: input.scopes,
        state,
        challenge: pkce.challenge,
        loginHint: input.loginHint
      })
      void Promise.resolve(input.openUrl(url)).catch((err: unknown) => log.warn('google-oauth.open.failed', { message: String(err) }))
    }
  })
  const { code } = await waiting
  const tokens = await tokenRequest(
    input.client,
    { grant_type: 'authorization_code', code, code_verifier: pkce.verifier, redirect_uri: redirectUri },
    input.fetchFn,
    now
  )
  log.info('google-oauth.login.done', { hasRefreshToken: tokens.refreshToken !== null })
  return tokens
}

/** Gets a new access token from the refresh token. If the response has no refresh token, the one passed in keeps being used. */
export async function refreshAccessToken(
  client: OAuthClient,
  refreshToken: string,
  fetchFn: FetchFn,
  now: () => number = Date.now
): Promise<OAuthTokens> {
  const tokens = await tokenRequest(client, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchFn, now)
  log.info('google-oauth.refresh.done', {})
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
}
