/**
 * Connects Google credentials to the `CredentialStore` (TODO 817 stage A).
 *
 *   Sign-in  : loopback + PKCE in `google-oauth.ts` -> sealed and saved with `putOAuth`
 *   Refresh  : registered per name with `registerGoogleRefresher` -> before the Broker sends, `headerForAsync` checks expiry and fetches a new one
 *   Sign-out : ask Google to revoke (continue even if it fails), then delete the local credentials
 *
 * **Token values are never given to plugins** (7.7). A plugin holds only the name (`google:gmail`) and attaches it to the `auth` of `net.fetch`.
 * Where the client (ID / secret) is stored is not decided here: the caller passes `getClient`.
 */
import { log } from '../../common/logger.js'
import type { CredentialStore } from './credentials.js'
import {
  loginWithLoopback,
  refreshAccessToken,
  type FetchFn,
  type OAuthClient,
  OAuthError
} from './google-oauth.js'

export const GOOGLE_REVOKE_URI = 'https://oauth2.googleapis.com/revoke'

/** Destination of the import API. The credentials are attached **only when this matches the host exactly** (7.7). */
export const GMAIL_API_HOST = 'gmail.googleapis.com'

/** Credential name (the manifest's `capabilities.credentials.oauth` and the `auth` of `net.fetch`). */
export const GMAIL_READONLY_CREDENTIAL = 'google:gmail.readonly'
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/**
 * TODO 952 (owner decision 2026-10-28): the scope of `aios.gmail` is the single `gmail.modify` (read, draft, send, mark read / archive /
 * label; only permanent deletion is impossible). The credential name matches it.
 */
export const GMAIL_MODIFY_CREDENTIAL = 'google:gmail.modify'
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

/**
 * TODO 1264 stage 1 (owner decision 2026-11-20): `aios.calendar` only reads. The Calendar API lives under `/calendar/v3/` on the shared
 * `www.googleapis.com` host, so besides the read-only scope the row below also pins the method (GET / HEAD) and the path prefix (7.7).
 */
export const CALENDAR_API_HOST = 'www.googleapis.com'
export const CALENDAR_API_PATH_PREFIX = '/calendar/v3/'
export const CALENDAR_READONLY_CREDENTIAL = 'google:calendar.readonly'
export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

/** Provider name of the row that seals the OAuth client (ID / secret) (`CredentialStore.putClient`). */
export const GOOGLE_PROVIDER = 'google'

/**
 * Default location when choosing the client JSON in the extension's details (TODO 952 owner decision 2026-10-24). Outside the repository, permission 600.
 * Once loaded it is sealed into the Broker's credentials, so aios does not use the file after loading.
 */
export const GOOGLE_CLIENT_FILE_HINT = '.config/aios/google-oauth-client.json'

/**
 * The table of Google credentials for which aios looks after sign-in in main (TODO 817 remainder 3, 952 stage 1). A plugin that writes a name from here in the manifest's
 * `capabilities.credentials.oauth` gets sign-in / sign-out fields in the extension's details.
 * **Main does not sign in for a name not in the table** (the scope and destination host are not left to the plugin).
 */
export interface GoogleCredentialSpec {
  readonly name: string
  readonly scopes: readonly string[]
  /** Destination to attach the credential to (attached only when this matches the host exactly, 7.7). */
  readonly host: string
  /**
   * The id of the owning extension (bundled only). **Anything other than the owner can neither declare nor use this name** (wave 84 fix Z, `credential-owner.ts`).
   * Prevents another extension from writing the same name and borrowing the Gmail token.
   */
  readonly owner: string
  /**
   * TODO 1264: a read-only credential. The Broker attaches it only to `GET` / `HEAD`, and sign-in refuses a token that carries any scope
   * that was not asked for (so a read-only name never holds a wider token). Writes go through a separate name in a later stage (959).
   */
  readonly readOnly?: boolean
  /** TODO 1264: attached only when the request path starts with this (the host is shared by many Google APIs). */
  readonly pathPrefix?: string
}

export const GOOGLE_CREDENTIALS: readonly GoogleCredentialSpec[] = [
  { name: GMAIL_MODIFY_CREDENTIAL, scopes: [GMAIL_MODIFY_SCOPE], host: GMAIL_API_HOST, owner: 'aios.gmail' },
  { name: GMAIL_READONLY_CREDENTIAL, scopes: [GMAIL_READONLY_SCOPE], host: GMAIL_API_HOST, owner: 'aios.gmail' },
  {
    name: CALENDAR_READONLY_CREDENTIAL,
    scopes: [CALENDAR_READONLY_SCOPE],
    host: CALENDAR_API_HOST,
    owner: 'aios.calendar',
    readOnly: true,
    pathPrefix: CALENDAR_API_PATH_PREFIX
  }
]

export function googleCredentialSpec(name: string): GoogleCredentialSpec | null {
  return GOOGLE_CREDENTIALS.find((spec) => spec.name === name) ?? null
}

/** Methods a read-only credential may be attached to. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

/**
 * TODO 1264: whether the Broker may attach this credential to this request (method and path; the host is checked separately by the fetch).
 * A name not in the table, or a row without `readOnly` / `pathPrefix`, is not restricted here. The path is read **after** URL parsing,
 * so `..` and `%2e%2e` segments are already resolved.
 */
export function googleRequestAllowed(name: string, method: string, url: string): boolean {
  const spec = googleCredentialSpec(name)
  if (spec === null) return true
  if (spec.readOnly === true && !READ_ONLY_METHODS.has(method.toUpperCase())) return false
  if (spec.pathPrefix !== undefined) {
    let pathname: string
    try {
      pathname = new URL(url).pathname
    } catch {
      return false
    }
    if (!pathname.startsWith(spec.pathPrefix)) return false
  }
  return true
}

/** Registers how to refresh, per name. Once at startup (it may be registered even if no credentials exist yet). */
export function registerGoogleRefresher(
  store: CredentialStore,
  name: string,
  getClient: () => OAuthClient | Promise<OAuthClient>,
  fetchFn: FetchFn
): void {
  store.setRefresher(name, async (refreshToken) => refreshAccessToken(await getClient(), refreshToken, fetchFn))
}

export interface SignInInput {
  readonly store: CredentialStore
  readonly name: string
  readonly host: string
  readonly client: OAuthClient
  readonly scopes: readonly string[]
  readonly openUrl: (url: string) => void | Promise<void>
  readonly fetchFn: FetchFn
  readonly loginHint?: string
  /** TODO 1264: refuse a token whose granted scopes go beyond `scopes` (read-only credentials). */
  readonly exactScopes?: boolean
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** Obtains consent in the browser and saves. **If the scopes granted by consent are insufficient, nothing is saved** (when only part was allowed). */
export async function signInGoogle(input: SignInInput): Promise<void> {
  const tokens = await loginWithLoopback({
    client: input.client,
    scopes: input.scopes,
    openUrl: input.openUrl,
    fetchFn: input.fetchFn,
    loginHint: input.loginHint,
    signal: input.signal,
    timeoutMs: input.timeoutMs
  })
  const granted = new Set(tokens.scope.split(' ').filter((s) => s !== ''))
  const missing = input.scopes.filter((s) => !granted.has(s))
  if (missing.length > 0) {
    // The checkbox was unchecked on the consent screen. Do not silently save an unusable credential.
    throw new OAuthError('access-denied', `required scope was not granted (${missing.length} missing)`)
  }
  if (input.exactScopes === true) {
    // TODO 1264: a read-only name must not end up holding a wider token (for example if Google merged earlier grants of the same client).
    const asked = new Set(input.scopes)
    const extra = [...granted].filter((s) => !asked.has(s))
    if (extra.length > 0) throw new OAuthError('access-denied', `unexpected extra scope was granted (${extra.length} extra)`)
  }
  if (tokens.refreshToken === null) {
    throw new OAuthError('token-request-failed', 'no refresh token was returned')
  }
  await input.store.putOAuth(input.name, {
    host: input.host,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope
  })
}

/**
 * TODO 1264 review: the other Google credentials that are still kept locally (signed in, or waiting for a new sign-in). Every row of
 * `GOOGLE_CREDENTIALS` is issued through the one sealed client `client:google`, so they are all grants of the same OAuth client.
 * Decided inside main only: a plugin is never told whether another owner's credential exists.
 */
function otherGoogleCredentialsKept(store: CredentialStore, name: string): number {
  return GOOGLE_CREDENTIALS.filter((spec) => spec.name !== name && store.status(spec.name).host !== null).length
}

/**
 * Deletes the local credentials. Revocation at Google is **best effort** (the local copy is always deleted, even without a connection).
 * The destination of the revocation is fixed to Google's revoke endpoint.
 *
 * TODO 1264 review: revocation is sent **only when this is the last Google credential of the client**. Google's revoke is expected to drop
 * the user's whole grant to the OAuth client (every scope, every token of that client), and `aios.gmail` / `aios.calendar` share one client,
 * so signing out of one would silently sign the other out too (for the same Google account). aios does not record which Google account a
 * credential belongs to, so it takes the safe side: while any other Google credential of the client is kept, only the local copy is deleted
 * (the grant stays listed under the user's Google account permissions until the last one signs out). Google's exact behavior is not yet
 * confirmed on a real account (wave 94 notes).
 */
export async function signOutGoogle(input: { store: CredentialStore; name: string; fetchFn: FetchFn }): Promise<void> {
  const others = otherGoogleCredentialsKept(input.store, input.name)
  if (others > 0) {
    log.info('google-oauth.revoke.skipped', { others })
    await input.store.remove(input.name)
    return
  }
  // Revoking the refresh token also invalidates the access token.
  const refreshToken = await input.store.refreshTokenOf(input.name)
  if (refreshToken !== null) {
    try {
      await input.fetchFn(GOOGLE_REVOKE_URI, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString()
      })
    } catch (err) {
      log.warn('google-oauth.revoke.failed', { message: err instanceof Error ? err.message : 'error' })
    }
  }
  await input.store.remove(input.name)
}
