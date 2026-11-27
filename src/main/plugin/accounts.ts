/**
 * The extension detail's "Account" (TODO 952 stage 1 / the remainder of 817, (1)(2)(3)). Independent of electron - the entry points for dialog, browser and HTTP are
 * passed in by the caller (`accounts-ipc.ts`).
 *
 *   Loading the client : main reads the `google-oauth-client.json` the user chose and seals it with `CredentialStore.putClient` ((1))
 *   At launch          : `registerGoogleRefresher` for each name in the table (`GOOGLE_CREDENTIALS`) ((1))
 *   Sign-in / re-sign-in: `signInGoogle` (loopback + PKCE, default browser) ((2))
 *   Sign-out           : `signOutGoogle` (revoke at Google, then erase locally) + discard that plugin's task resume position ((2))
 *   Declaration        : if `capabilities.credentials.oauth` in the manifest has a name in the table, the field is shown ((3))
 *
 * **Values are given neither to the renderer nor to plugins.** The state is only presence or absence (`PluginAccountStatus`). The plugin id and
 * credential name from the renderer are re-validated here against the manifest's declaration and the table (no sign-in for a name that is not declared).
 */
import type { PluginManifest } from '@shared/plugin.js'
import type { PluginAccountError, PluginAccountResult, PluginAccountStatus } from '@shared/plugin-account.js'
import { log } from '../../common/logger.js'
import type { CredentialStore } from '../capability/credentials.js'
import {
  GOOGLE_CREDENTIALS,
  GOOGLE_PROVIDER,
  googleCredentialSpec,
  registerGoogleRefresher,
  signInGoogle,
  signOutGoogle,
  type GoogleCredentialSpec
} from '../capability/google-credentials.js'
import { basicCredentialSpec, basicHeaderValue, checkBasicInput, type BasicCredentialSpec } from '../capability/basic-credentials.js'
import { credentialUsableBy } from '../capability/credential-owner.js'
import { OAuthError, parseClientConfig, type FetchFn, type OAuthClient } from '../capability/google-oauth.js'

/** Upper limit on the size of the client JSON (Google's is under 1 KB). */
export const MAX_CLIENT_FILE_BYTES = 64 * 1024

export interface PluginAccountsDeps {
  readonly credentials: CredentialStore
  readonly manifestOf: (pluginId: string) => PluginManifest | null
  /**
   * Whether it is a bundled extension (`PluginHost.isBundled`, decided by where it was loaded from - not the extension's self-report). The credentials in the table
   * show a field and accept input only when bundled, by the owner's id (wave 84 fix Z, `credential-owner.ts`).
   */
  readonly isBundled: (pluginId: string) => boolean
  readonly fetchFn: FetchFn
  /** Open in the default browser (`shell.openExternal`). */
  readonly openUrl: (url: string) => void | Promise<void>
  /** Lets the user choose the client JSON and returns its contents (main's dialog). Cancelled -> null. Too large -> exception. */
  readonly chooseClientFile: () => Promise<string | null>
  /** Sign-in finished (starts the task). */
  readonly onSignedIn?: (pluginId: string) => void
  /** Signed out (discards the resume position). */
  readonly onSignedOut?: (pluginId: string) => void
  /** The state changed (makes the detail redraw). */
  readonly onChanged?: (pluginId: string) => void
}

export class PluginAccounts {
  /** Sign-ins in progress (credential name -> cancel). A second one with the same name is `busy`. */
  private readonly pending = new Map<string, AbortController>()

  constructor(private readonly deps: PluginAccountsDeps) {}

  /** Once at launch. It is fine to register even if the credentials do not exist yet (a refresh just fails if there is no client). */
  registerRefreshers(): void {
    for (const spec of GOOGLE_CREDENTIALS) {
      registerGoogleRefresher(this.deps.credentials, spec.name, () => this.requireClient(), this.deps.fetchFn)
    }
  }

  private async requireClient(): Promise<OAuthClient> {
    const client = await this.deps.credentials.clientOf(GOOGLE_PROVIDER)
    if (client === null) throw new OAuthError('bad-client-config', 'no OAuth client is configured')
    return client
  }

  /** The credentials that plugin declared and that main can handle sign-in for. */
  private specsOf(pluginId: string): readonly GoogleCredentialSpec[] {
    const declared = this.deps.manifestOf(pluginId)?.capabilities.credentials?.oauth ?? []
    const plugin = { id: pluginId, bundled: this.deps.isBundled(pluginId) }
    return declared.flatMap((name) => {
      const spec = googleCredentialSpec(name)
      // Wave 84 fix Z: an extension that is not the owner (bundled) gets no field and is not allowed to sign in or out.
      return spec === null || !credentialUsableBy(spec.name, plugin) ? [] : [spec]
    })
  }

  /** The credentials that plugin declared where the user enters a fixed token (TODO 1218). */
  private basicSpecsOf(pluginId: string): readonly BasicCredentialSpec[] {
    const declared = this.deps.manifestOf(pluginId)?.capabilities.credentials?.basic ?? []
    const plugin = { id: pluginId, bundled: this.deps.isBundled(pluginId) }
    return declared.flatMap((name) => {
      const spec = basicCredentialSpec(name)
      // Wave 84 fix Z: no token is accepted or erased for an extension that is not the owner (bundled).
      return spec === null || !credentialUsableBy(spec.name, plugin) ? [] : [spec]
    })
  }

  status(pluginId: string): readonly PluginAccountStatus[] {
    const tokens = this.basicSpecsOf(pluginId).map((spec) => ({
      credential: spec.name,
      provider: 'token' as const,
      clientConfigured: true,
      signedIn: this.deps.credentials.status(spec.name).present,
      needsReauth: false,
      signingIn: false
    }))
    return [...this.oauthStatus(pluginId), ...tokens]
  }

  private oauthStatus(pluginId: string): readonly PluginAccountStatus[] {
    // TODO 1344: whether a client is stored, without unsealing it (showing the details asks no keychain).
    const clientConfigured = this.deps.credentials.hasClient(GOOGLE_PROVIDER)
    return this.specsOf(pluginId).map((spec) => {
      const needsReauth = this.deps.credentials.needsReauth(spec.name)
      return {
        credential: spec.name,
        provider: 'google' as const,
        clientConfigured,
        signedIn: this.deps.credentials.status(spec.name).present,
        needsReauth,
        signingIn: this.pending.has(spec.name)
      }
    })
  }

  private fail(pluginId: string, error: PluginAccountError): PluginAccountResult {
    return { ok: false, error, accounts: this.status(pluginId) }
  }

  private done(pluginId: string): PluginAccountResult {
    this.deps.onChanged?.(pluginId)
    return { ok: true, accounts: this.status(pluginId) }
  }

  /** Lets the user choose the client JSON and seals it. Values are not logged. */
  async importClient(pluginId: string): Promise<PluginAccountResult> {
    if (this.specsOf(pluginId).length === 0) return this.fail(pluginId, 'unavailable')
    let text: string | null
    try {
      text = await this.deps.chooseClientFile()
    } catch {
      return this.fail(pluginId, 'bad-client-config')
    }
    if (text === null) return this.fail(pluginId, 'cancelled')
    let client: OAuthClient
    try {
      client = parseClientConfig(text)
    } catch {
      log.warn('plugin.account.client.invalid', { pluginId })
      return this.fail(pluginId, 'bad-client-config')
    }
    try {
      await this.deps.credentials.putClient(GOOGLE_PROVIDER, client)
    } catch {
      return this.fail(pluginId, 'secret-storage')
    }
    log.info('plugin.account.client.imported', { pluginId, provider: GOOGLE_PROVIDER })
    return this.done(pluginId)
  }

  /** Sign-in (re-sign-in is the same). Does not return while waiting for consent in the browser (at most 5 minutes). */
  async signIn(pluginId: string, credential: string): Promise<PluginAccountResult> {
    const spec = this.specsOf(pluginId).find((candidate) => candidate.name === credential)
    if (spec === undefined) return this.fail(pluginId, 'unavailable')
    const client = await this.deps.credentials.clientOf(GOOGLE_PROVIDER)
    // A stored client that does not unseal now (the keychain refused, or another key) is a keychain problem, not a missing client.
    if (client === null) return this.fail(pluginId, this.deps.credentials.hasClient(GOOGLE_PROVIDER) ? 'secret-storage' : 'no-client')
    if (this.pending.has(spec.name)) return this.fail(pluginId, 'busy')
    const abort = new AbortController()
    this.pending.set(spec.name, abort)
    this.deps.onChanged?.(pluginId)
    try {
      await signInGoogle({
        store: this.deps.credentials,
        name: spec.name,
        host: spec.host,
        client,
        scopes: spec.scopes,
        exactScopes: spec.readOnly === true,
        openUrl: this.deps.openUrl,
        fetchFn: this.deps.fetchFn,
        signal: abort.signal
      })
    } catch (err) {
      const error = signInError(err)
      log.warn('plugin.account.signIn.failed', { pluginId, credential: spec.name, error })
      return this.fail(pluginId, error)
    } finally {
      this.pending.delete(spec.name)
      this.deps.onChanged?.(pluginId)
    }
    log.info('plugin.account.signedIn', { pluginId, credential: spec.name })
    this.deps.onSignedIn?.(pluginId)
    return this.done(pluginId)
  }

  /**
   * Seals a fixed token (TODO 1218). The email address and the token come from the renderer exactly once. **They are not logged and not returned.**
   * Checks the shape, builds the `Basic` header value, and calls `CredentialStore.put`. The destination host is decided by the table.
   */
  async saveToken(pluginId: string, credential: string, email: unknown, token: unknown): Promise<PluginAccountResult> {
    const spec = this.basicSpecsOf(pluginId).find((candidate) => candidate.name === credential)
    if (spec === undefined) return this.fail(pluginId, 'unavailable')
    if (typeof email !== 'string' || typeof token !== 'string') return this.fail(pluginId, 'bad-input')
    const trimmedEmail = email.trim()
    const trimmedToken = token.trim()
    if (!checkBasicInput(trimmedEmail, trimmedToken)) return this.fail(pluginId, 'bad-input')
    try {
      await this.deps.credentials.put(spec.name, { value: basicHeaderValue(trimmedEmail, trimmedToken), host: spec.host })
    } catch {
      return this.fail(pluginId, 'secret-storage')
    }
    log.info('plugin.account.tokenSaved', { pluginId, credential: spec.name })
    this.deps.onSignedIn?.(pluginId)
    return this.done(pluginId)
  }

  /** Stops waiting for consent in the browser. */
  cancelSignIn(pluginId: string, credential: string): PluginAccountResult {
    if (!this.specsOf(pluginId).some((spec) => spec.name === credential)) return this.fail(pluginId, 'unavailable')
    this.pending.get(credential)?.abort()
    return { ok: true, accounts: this.status(pluginId) }
  }

  /** Sign-out. Even if the revocation at Google fails, the local copy is erased. The resume position (task state) is also discarded. */
  async signOut(pluginId: string, credential: string): Promise<PluginAccountResult> {
    const basic = this.basicSpecsOf(pluginId).find((candidate) => candidate.name === credential)
    if (basic !== undefined) {
      try {
        await this.deps.credentials.remove(basic.name)
      } catch {
        return this.fail(pluginId, 'error')
      }
      log.info('plugin.account.signedOut', { pluginId, credential: basic.name })
      this.deps.onSignedOut?.(pluginId)
      return this.done(pluginId)
    }
    const spec = this.specsOf(pluginId).find((candidate) => candidate.name === credential)
    if (spec === undefined) return this.fail(pluginId, 'unavailable')
    try {
      await signOutGoogle({ store: this.deps.credentials, name: spec.name, fetchFn: this.deps.fetchFn })
    } catch {
      // Wave 108 fix Y3: the local erase could not be written (the store stopped for a quit). A result, not a rejected invoke.
      return this.fail(pluginId, 'error')
    }
    log.info('plugin.account.signedOut', { pluginId, credential: spec.name })
    this.deps.onSignedOut?.(pluginId)
    return this.done(pluginId)
  }
}

function signInError(err: unknown): PluginAccountError {
  if (err instanceof OAuthError) {
    switch (err.code) {
      case 'cancelled':
        return 'cancelled'
      case 'timeout':
        return 'timeout'
      case 'access-denied':
      case 'state-mismatch':
        return 'access-denied'
      case 'bad-client-config':
        return 'bad-client-config'
      case 'invalid-grant':
      case 'token-request-failed':
        return 'token-request-failed'
    }
  }
  if (err instanceof Error && err.message === 'secret storage unavailable') return 'secret-storage'
  return 'error'
}
