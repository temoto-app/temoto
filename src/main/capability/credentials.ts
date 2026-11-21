/**
 * The credentials capability (ARCHITECTURE.md 7.7 / 8.2).
 *
 * **Token values are never handed to plugins.** All a plugin can hold is the credential's
 * *name* (such as `google:gmail`); when it attaches that name to `net.fetch`,
 * the Broker adds the header at send time. The value never leaves this module.
 *
 * Storage matches the Phase 1 decision (8.2): no `keytar`; it is sealed with Electron's
 * `safeStorage` and placed in `<userData>/credentials.json` (0600).
 * This avoids adding native dependencies, and it is a separate file from the DB key (`db.key`).
 *
 * Constraint 2: only **the plugins'** credentials go in here.
 * The backend CLI's credentials directory is never touched
 * (only the Adapter and compat/ know where it is; constraint 6).
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../../common/logger.js'
import { OAuthError } from './google-oauth.js'

/** The seal / unseal entry point. Replaceable for tests and for environments where `safeStorage` is unavailable. */
export interface SecretSealer {
  available(): boolean
  seal(value: string): Buffer
  open(sealed: Buffer): string
}

interface StoredCredential {
  /** Header name to attach. Defaults to Authorization. */
  readonly header: string
  /** The **fully assembled** value such as `Bearer <token>`, sealed (base64). */
  readonly sealed: string
  /** Attached only when this matches the host exactly (7.7). */
  readonly host: string
  readonly updatedAt: number
  /**
   * OAuth credentials only (TODO 817). `sealed` is the access token (`Bearer …`); this is the refresh token.
   * **The refresh token never leaves main**: it appears in neither `status()` nor `headerFor()`.
   */
  readonly refreshSealed?: string
  /** Expiry of the access token (epoch ms). */
  readonly expiresAt?: number
  readonly scope?: string
  /** The refresh token no longer works (7-day expiry, password change, revocation). Unusable until the user signs in again. */
  readonly reauth?: boolean
  /**
   * TODO 952 stage 1: a row sealing an OAuth **client** (ID / secret). `sealed` is the client's JSON.
   * Not used for headers: to `status` / `headerFor` / `headerForAsync` it looks like "absent" (there is no path out to a plugin).
   */
  readonly kind?: 'client'
}

/** An OAuth client kept sealed (TODO 952 stage 1). The same shape as `OAuthClient` in `google-oauth.ts`. */
export interface StoredOAuthClient {
  readonly clientId: string
  readonly clientSecret: string
  readonly authUri: string
  readonly tokenUri: string
}

/** Name of a client's row (`client:<provider>`). It does not overlap with plugin credential names (`google:gmail.modify`). */
export function oauthClientEntryName(provider: string): string {
  return `client:${provider}`
}

/** refresh token -> a new access token. Throwing `invalid-grant` means "sign in again"; other failures are treated as temporary. */
export type TokenRefresher = (refreshToken: string) => Promise<{
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  scope: string
}>

/** Refresh starts this long before expiry (so it does not expire in the middle of a send). */
const REFRESH_SKEW_MS = 60_000

export class CredentialStore {
  private readonly file: string
  private entries = new Map<string, StoredCredential>()
  private readonly refreshers = new Map<string, TokenRefresher>()
  /** Never run two refreshes of the same credential at once (avoids fighting over the refresh token and wasted round trips). */
  private readonly refreshing = new Map<string, Promise<string | null>>()

  constructor(
    userDataDir: string,
    private readonly sealer: SecretSealer
  ) {
    this.file = join(userDataDir, 'credentials.json')
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, StoredCredential>
      this.entries = new Map(Object.entries(raw))
    } catch {
      // If missing or corrupt, start empty. So that we **do not rebuild and silently break it** (8.2),
      // even when it was corrupt the file is not overwritten until the next save.
      this.entries = new Map()
    }
  }

  private save(): void {
    const out: Record<string, StoredCredential> = {}
    for (const [name, value] of this.entries) out[name] = value
    writeFileSync(this.file, JSON.stringify(out), { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }

  /** Saves a credential. **Only main calls this** (main also runs the OAuth flow). */
  put(name: string, input: { value: string; host: string; header?: string }): void {
    if (!this.sealer.available()) {
      // If it cannot be sealed, do not save. Never store a token in plaintext (the same decision as 8.2).
      throw new Error('secret storage unavailable')
    }
    this.entries.set(name, {
      header: input.header ?? 'authorization',
      sealed: this.sealer.seal(input.value).toString('base64'),
      host: input.host,
      updatedAt: Date.now()
    })
    this.save()
    log.info('credentials.stored', { name, host: input.host })
  }

  /**
   * Saves OAuth tokens (TODO 817). **Only main calls this** (when the login flow finishes).
   * If `refreshToken` is null (such as in a refresh response), the current refresh token is kept. Signing in again clears `reauth`.
   */
  putOAuth(
    name: string,
    input: {
      host: string
      accessToken: string
      refreshToken: string | null
      expiresAt: number
      scope: string
      header?: string
    }
  ): void {
    if (!this.sealer.available()) throw new Error('secret storage unavailable')
    const previous = this.entries.get(name)
    const refreshSealed =
      input.refreshToken !== null
        ? this.sealer.seal(input.refreshToken).toString('base64')
        : previous?.refreshSealed
    if (refreshSealed === undefined) throw new Error('oauth credential needs a refresh token')
    this.entries.set(name, {
      header: input.header ?? 'authorization',
      sealed: this.sealer.seal(`Bearer ${input.accessToken}`).toString('base64'),
      host: input.host,
      updatedAt: Date.now(),
      refreshSealed,
      expiresAt: input.expiresAt,
      scope: input.scope
    })
    this.save()
    log.info('credentials.stored', { name, host: input.host, oauth: true })
  }

  /**
   * Seals and saves an OAuth client (TODO 952 stage 1). **Only main calls this** (when it reads the JSON chosen in the extension's details).
   * The value is not logged.
   */
  putClient(provider: string, client: StoredOAuthClient): void {
    if (!this.sealer.available()) throw new Error('secret storage unavailable')
    const json = JSON.stringify({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      authUri: client.authUri,
      tokenUri: client.tokenUri
    })
    this.entries.set(oauthClientEntryName(provider), {
      header: '',
      sealed: this.sealer.seal(json).toString('base64'),
      host: '',
      updatedAt: Date.now(),
      kind: 'client'
    })
    this.save()
    log.info('credentials.client.stored', { provider })
  }

  /** The sealed client (TODO 952 stage 1). **Used only by main's OAuth flow and refresh.** Absent or unreadable -> null. */
  clientOf(provider: string): StoredOAuthClient | null {
    const entry = this.entries.get(oauthClientEntryName(provider))
    if (entry === undefined || entry.kind !== 'client') return null
    try {
      const parsed = JSON.parse(this.sealer.open(Buffer.from(entry.sealed, 'base64'))) as Record<string, unknown>
      const { clientId, clientSecret, authUri, tokenUri } = parsed
      if (
        typeof clientId !== 'string' ||
        typeof clientSecret !== 'string' ||
        typeof authUri !== 'string' ||
        typeof tokenUri !== 'string'
      ) {
        return null
      }
      return { clientId, clientSecret, authUri, tokenUri }
    } catch {
      log.warn('credentials.unseal.failed', { name: oauthClientEntryName(provider) })
      return null
    }
  }

  /** Registers how to refresh this name (once at startup). */
  setRefresher(name: string, refresher: TokenRefresher): void {
    this.refreshers.set(name, refresher)
  }

  /**
   * Returns the refresh token for revocation (sign-out). **Called only from `signOutGoogle` in `google-credentials.ts`.**
   * There is no path to a plugin (the Broker does not call it).
   */
  refreshTokenOf(name: string): string | null {
    const sealed = this.credentialEntry(name)?.refreshSealed
    if (sealed === undefined) return null
    try {
      return this.sealer.open(Buffer.from(sealed, 'base64'))
    } catch {
      return null
    }
  }

  /** Whether signing in again is needed. **Only main looks at this** (to a plugin it just looks like `status().present` is false). */
  needsReauth(name: string): boolean {
    return this.credentialEntry(name)?.reauth === true
  }

  /** The credential row used for headers. A client row (TODO 952 stage 1) is treated as absent. */
  private credentialEntry(name: string): StoredCredential | undefined {
    const entry = this.entries.get(name)
    return entry?.kind === 'client' ? undefined : entry
  }

  remove(name: string): void {
    if (this.entries.delete(name)) this.save()
  }

  /** Information that may be returned to a plugin. **It does not include the value.** */
  status(name: string): { present: boolean; host: string | null; updatedAt: number | null } {
    const entry = this.credentialEntry(name)
    if (entry === undefined) return { present: false, host: null, updatedAt: null }
    // One that needs a new sign-in looks the same as "absent" (it cannot be used). The reason is held by main's `needsReauth`.
    if (entry.reauth === true) return { present: false, host: entry.host, updatedAt: entry.updatedAt }
    return { present: true, host: entry.host, updatedAt: entry.updatedAt }
  }

  /**
   * Builds the header at send time. **Call only from inside the Broker.**
   * There is no path for the return value to reach a plugin (`network.ts` uses it only for sending).
   */
  headerFor(name: string): { host: string; header: string; value: string } | null {
    const entry = this.credentialEntry(name)
    if (entry === undefined) return null
    try {
      return {
        host: entry.host,
        header: entry.header,
        value: this.sealer.open(Buffer.from(entry.sealed, 'base64'))
      }
    } catch {
      log.warn('credentials.unseal.failed', { name })
      return null
    }
  }

  /**
   * The OAuth version of `headerFor`: **refreshes first if expiry is near**, then returns the header (the Broker's send uses this one).
   *  - No refresh needed / a static credential -> just `headerFor`.
   *  - `invalid-grant` -> set `reauth` and return null (the send stops with `no-credential`). The saved value is not deleted.
   *  - Any other failure (network and so on) -> throw. **`reauth` is not set** (a temporary failure does not ask for a new sign-in).
   *    However, if the access token has not expired yet, it keeps being used.
   */
  async headerForAsync(name: string, now: () => number = Date.now): Promise<{ host: string; header: string; value: string } | null> {
    const entry = this.credentialEntry(name)
    if (entry === undefined || entry.reauth === true) return null
    const stillValid = entry.refreshSealed === undefined || entry.expiresAt === undefined || entry.expiresAt - now() > REFRESH_SKEW_MS
    if (stillValid) return this.headerFor(name)

    let pending = this.refreshing.get(name)
    if (pending === undefined) {
      pending = this.refresh(name, entry, now).finally(() => this.refreshing.delete(name))
      this.refreshing.set(name, pending)
    }
    try {
      await pending
    } catch (err) {
      // If there is an access token that has not expired yet, carry on with it (the SKEW before expiry is a margin, not a limit).
      if (entry.expiresAt !== undefined && entry.expiresAt > now()) return this.headerFor(name)
      throw err
    }
    return this.entries.get(name)?.reauth === true ? null : this.headerFor(name)
  }

  private async refresh(name: string, entry: StoredCredential, now: () => number): Promise<string | null> {
    const refresher = this.refreshers.get(name)
    if (refresher === undefined || entry.refreshSealed === undefined) {
      throw new Error('credential-refresh-unavailable')
    }
    let refreshToken: string
    try {
      refreshToken = this.sealer.open(Buffer.from(entry.refreshSealed, 'base64'))
    } catch {
      log.warn('credentials.unseal.failed', { name })
      this.markReauth(name)
      return null
    }
    try {
      const next = await refresher(refreshToken)
      // If a remove / re-sign-in happened during the refresh, do not overwrite with the stale result.
      if (this.entries.get(name) !== entry) return null
      this.putOAuth(name, { host: entry.host, header: entry.header, ...next })
      log.info('credentials.refreshed', { name, expiresInSec: Math.round((next.expiresAt - now()) / 1000) })
      return null
    } catch (err) {
      if (err instanceof OAuthError && err.code === 'invalid-grant') {
        this.markReauth(name)
        log.warn('credentials.reauth-required', { name })
        return null
      }
      log.warn('credentials.refresh.failed', { name, code: err instanceof OAuthError ? err.code : 'error' })
      throw new Error('credential-refresh-failed')
    }
  }

  private markReauth(name: string): void {
    const entry = this.entries.get(name)
    if (entry === undefined) return
    this.entries.set(name, { ...entry, reauth: true })
    this.save()
  }

  names(): readonly string[] {
    return [...this.entries.keys()]
  }
}
