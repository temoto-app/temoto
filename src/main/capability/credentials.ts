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
 *
 * TODO 1344: sealing and unsealing are asynchronous (the app passes `Keychain`, which uses `safeStorage`'s asynchronous entry points).
 * Every change of the file goes through one queue (`mutate`): it seals first and applies the change to the map only after the seal,
 * so a slow seal can never put an older value over a newer one, and a removal made meanwhile is never undone. A keychain that cannot
 * be used now (`SecretUnavailableError`) never deletes, rewrites or flags a stored value. After `stop()` nothing is written.
 */
import { chmodSync, renameSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { errorFields, log } from '../../common/logger.js'
import { SECRET_STORAGE_UNAVAILABLE, SecretUnavailableError } from '../keychain/keychain.js'
import { OAuthError } from './google-oauth.js'

/**
 * The seal / unseal entry point. Replaceable for tests and for environments where `safeStorage` is unavailable.
 * `seal` / `open` may be synchronous (test fakes) or asynchronous (the app's `Keychain`). `open` throws `SecretUnavailableError` when
 * the keychain cannot be used now (the value may be fine), and anything else when the value does not unseal.
 */
export interface SecretSealer {
  /** A cheap check that asks no keychain: false = do not try to seal. */
  available(): boolean
  seal(value: string): Buffer | Promise<Buffer>
  open(sealed: Buffer): string | Promise<string>
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

/** The input of `putOAuth`. */
export interface OAuthInput {
  readonly host: string
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly expiresAt: number
  readonly scope: string
  readonly header?: string
}

/** Refresh starts this long before expiry (so it does not expire in the middle of a send). */
const REFRESH_SKEW_MS = 60_000

export class CredentialStore {
  private readonly file: string
  private entries = new Map<string, StoredCredential>()
  private readonly refreshers = new Map<string, TokenRefresher>()
  /** Never run two refreshes of the same credential at once (avoids fighting over the refresh token and wasted round trips). */
  private readonly refreshing = new Map<string, Promise<string | null>>()
  /** The tail of the write queue (never rejects). */
  private writes: Promise<void> = Promise.resolve()
  private stopped = false

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

  /** Replaced atomically (0600), so a crash never leaves a half-written file. Never after `stop()`. */
  private save(): void {
    if (this.stopped) return
    const out: Record<string, StoredCredential> = {}
    for (const [name, value] of this.entries) out[name] = value
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }

  /**
   * Runs one change of the file after the ones before it. `change` seals what it needs and then applies everything to the map in one
   * synchronous step (no `await` between reading the map and saving it), so no change is lost or reordered.
   */
  private mutate<T>(change: () => Promise<T>): Promise<T> {
    const run = this.writes.then(async () => {
      if (this.stopped) throw new SecretUnavailableError('abandoned')
      return change()
    })
    this.writes = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** Seals, or throws `SECRET_STORAGE_UNAVAILABLE` (never stores a token in plaintext - the same decision as 8.2). */
  private async sealToBase64(value: string): Promise<string> {
    if (!this.sealer.available()) throw new Error(SECRET_STORAGE_UNAVAILABLE)
    const sealed = await this.sealer.seal(value)
    // A quit that began while sealing: nothing more is written.
    if (this.stopped) throw new SecretUnavailableError('abandoned')
    return sealed.toString('base64')
  }

  private async openBase64(sealed: string): Promise<string> {
    return this.sealer.open(Buffer.from(sealed, 'base64'))
  }

  /** Saves a credential. **Only main calls this** (main also runs the OAuth flow). */
  put(name: string, input: { value: string; host: string; header?: string }): Promise<void> {
    return this.mutate(async () => {
      const sealed = await this.sealToBase64(input.value)
      this.entries.set(name, {
        header: input.header ?? 'authorization',
        sealed,
        host: input.host,
        updatedAt: Date.now()
      })
      this.save()
      log.info('credentials.stored', { name, host: input.host })
    })
  }

  /**
   * Saves OAuth tokens (TODO 817). **Only main calls this** (when the login flow finishes).
   * If `refreshToken` is null (such as in a refresh response), the current refresh token is kept. Signing in again clears `reauth`.
   */
  async putOAuth(name: string, input: OAuthInput): Promise<void> {
    await this.writeOAuth(name, input, null)
  }

  /**
   * The body of `putOAuth`. With `expected`, the write happens only if the row is still `expected` once sealed (a refresh must not put
   * its result over a sign-in or a removal that happened meanwhile). Returns whether it wrote.
   */
  private writeOAuth(name: string, input: OAuthInput, expected: StoredCredential | null): Promise<boolean> {
    return this.mutate(async () => {
      // Wave 108 fix Y2: a refresh whose row was removed or replaced while it waited in the queue withdraws quietly - before anything
      // else is checked (a removed row has no refresh token, which would otherwise throw). Checked again after sealing, below.
      if (expected !== null && this.entries.get(name) !== expected) return false
      if (input.refreshToken === null && this.entries.get(name)?.refreshSealed === undefined) {
        throw new Error('oauth credential needs a refresh token')
      }
      const newRefresh = input.refreshToken !== null ? await this.sealToBase64(input.refreshToken) : null
      const access = await this.sealToBase64(`Bearer ${input.accessToken}`)
      // Read the row only now (after the seals): this step and the save below run without a break.
      const previous = this.entries.get(name)
      if (expected !== null && previous !== expected) return false
      const refreshSealed = newRefresh ?? previous?.refreshSealed
      if (refreshSealed === undefined) throw new Error('oauth credential needs a refresh token')
      this.entries.set(name, {
        header: input.header ?? 'authorization',
        sealed: access,
        host: input.host,
        updatedAt: Date.now(),
        refreshSealed,
        expiresAt: input.expiresAt,
        scope: input.scope
      })
      this.save()
      log.info('credentials.stored', { name, host: input.host, oauth: true })
      return true
    })
  }

  /**
   * Seals and saves an OAuth client (TODO 952 stage 1). **Only main calls this** (when it reads the JSON chosen in the extension's details).
   * The value is not logged.
   */
  putClient(provider: string, client: StoredOAuthClient): Promise<void> {
    const json = JSON.stringify({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      authUri: client.authUri,
      tokenUri: client.tokenUri
    })
    return this.mutate(async () => {
      const sealed = await this.sealToBase64(json)
      this.entries.set(oauthClientEntryName(provider), {
        header: '',
        sealed,
        host: '',
        updatedAt: Date.now(),
        kind: 'client'
      })
      this.save()
      log.info('credentials.client.stored', { provider })
    })
  }

  /** Whether a client row is stored (TODO 1344: asks no keychain; whether it unseals is known only when it is used). */
  hasClient(provider: string): boolean {
    return this.entries.get(oauthClientEntryName(provider))?.kind === 'client'
  }

  /** The sealed client (TODO 952 stage 1). **Used only by main's OAuth flow and refresh.** Absent or unreadable -> null. */
  async clientOf(provider: string): Promise<StoredOAuthClient | null> {
    const entry = this.entries.get(oauthClientEntryName(provider))
    if (entry === undefined || entry.kind !== 'client') return null
    let text: string
    try {
      text = await this.openBase64(entry.sealed)
    } catch (err) {
      this.warnUnseal(oauthClientEntryName(provider), err)
      return null
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
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
  async refreshTokenOf(name: string): Promise<string | null> {
    const sealed = this.credentialEntry(name)?.refreshSealed
    if (sealed === undefined) return null
    try {
      return await this.openBase64(sealed)
    } catch (err) {
      this.warnUnseal(name, err)
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

  /** Removes a row. Queued behind any write in progress, so a put that was still sealing cannot bring it back. */
  remove(name: string): Promise<void> {
    return this.mutate(async () => {
      if (this.entries.delete(name)) this.save()
    })
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
  async headerFor(name: string): Promise<{ host: string; header: string; value: string } | null> {
    const entry = this.credentialEntry(name)
    if (entry === undefined) return null
    try {
      return {
        host: entry.host,
        header: entry.header,
        value: await this.openBase64(entry.sealed)
      }
    } catch (err) {
      this.warnUnseal(name, err)
      return null
    }
  }

  /**
   * The OAuth version of `headerFor`: **refreshes first if expiry is near**, then returns the header (the Broker's send uses this one).
   *  - No refresh needed / a static credential -> just `headerFor`.
   *  - `invalid-grant` -> set `reauth` and return null (the send stops with `no-credential`). The saved value is not deleted.
   *  - Any other failure (network, a keychain that cannot be used now, and so on) -> throw. **`reauth` is not set** (a temporary
   *    failure does not ask for a new sign-in). However, if the access token has not expired yet, it keeps being used.
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
      refreshToken = await this.openBase64(entry.refreshSealed)
    } catch (err) {
      this.warnUnseal(name, err)
      // TODO 1344: a keychain that cannot be used now (refused, quitting) says nothing about the token: no new sign-in is asked and
      // nothing is written. Only a token the keychain cannot unseal (another key, damage) needs the user to sign in again.
      if (err instanceof SecretUnavailableError) throw new Error('credential-refresh-unavailable')
      this.markReauth(name, entry)
      return null
    }
    try {
      const next = await refresher(refreshToken)
      // If a remove / re-sign-in happened during the refresh, do not overwrite with the stale result.
      if (this.entries.get(name) !== entry) return null
      // The same check again once sealed (`writeOAuth`): a sign-in or removal queued while sealing wins.
      const wrote = await this.writeOAuth(name, { host: entry.host, header: entry.header, ...next }, entry)
      if (wrote) log.info('credentials.refreshed', { name, expiresInSec: Math.round((next.expiresAt - now()) / 1000) })
      return null
    } catch (err) {
      if (err instanceof OAuthError && err.code === 'invalid-grant') {
        this.markReauth(name, entry)
        log.warn('credentials.reauth-required', { name })
        return null
      }
      if (err instanceof SecretUnavailableError || (err instanceof Error && err.message === SECRET_STORAGE_UNAVAILABLE)) {
        log.warn('credentials.refresh.unsaved', { name })
        throw new Error('credential-refresh-unavailable')
      }
      log.warn('credentials.refresh.failed', { name, code: err instanceof OAuthError ? err.code : 'error' })
      throw new Error('credential-refresh-failed')
    }
  }

  /** Flags `reauth` on the row the refresh started from - not on a row that a new sign-in wrote meanwhile. */
  private markReauth(name: string, expected: StoredCredential): void {
    const entry = this.entries.get(name)
    if (entry === undefined || entry !== expected) return
    this.entries.set(name, { ...entry, reauth: true })
    // TODO 1346 item 8: the flag holds in memory either way. A save that fails (an fs error) must not break the refresh path that is
    // asking for a new sign-in; the file is left as it is (not deleted or rebuilt) and the next launch asks Google again.
    try {
      this.save()
    } catch (err) {
      log.warn('credentials.reauth.unsaved', { name, ...errorFields(err) })
    }
  }

  private warnUnseal(name: string, err: unknown): void {
    if (err instanceof SecretUnavailableError) log.warn('credentials.unseal.unavailable', { name, reason: err.miss })
    else log.warn('credentials.unseal.failed', { name })
  }

  names(): readonly string[] {
    return [...this.entries.keys()]
  }

  /**
   * Shutdown (`before-quit`). From now on nothing is written: a seal that finishes later is dropped (nothing half-done - the map and
   * the file change together only after a seal), and new changes are refused. Returns at once; it never waits for a keychain dialog.
   */
  stop(): Promise<void> {
    this.stopped = true
    return Promise.resolve()
  }
}
