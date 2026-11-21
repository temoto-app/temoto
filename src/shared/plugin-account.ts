/**
 * The "Account" section of an extension's details (TODO 952 stage 1 / the remainder of 817 (1)(2)). Of the credentials a plugin
 * declared in `capabilities.credentials.oauth`, the state of those that main handles the login for (only Google for now) and the results of operations.
 *
 * **No value is ever passed** (tokens, client secrets, account addresses). The renderer sees only presence.
 * Main does the login flow (loopback + PKCE, the default browser) and the loading of the client JSON (7.7).
 */

/** The state of one credential. */
export interface PluginAccountStatus {
  /** The name of the credential (`google:gmail.modify`). */
  readonly credential: string
  /** `google` = OAuth login, `token` = a fixed token the user enters (TODO 1218; neither a client JSON nor a browser is needed). */
  readonly provider: 'google' | 'token'
  /** Whether the OAuth client (ID / secret) has been loaded. Without it, login is impossible. */
  readonly clientConfigured: boolean
  /** Signed in and usable. */
  readonly signedIn: boolean
  /** Signed in but the refresh token no longer works (7-day expiry, revocation). It must be entered again. */
  readonly needsReauth: boolean
  /** Currently waiting for consent in the browser. */
  readonly signingIn: boolean
}

/** The reason an operation failed (the display is looked up in the renderer's wording table). */
export type PluginAccountError =
  /** There is no client JSON yet. */
  | 'no-client'
  /** The email address or token entered has an invalid form (the `token` field). */
  | 'bad-input'
  /** The chosen JSON is not a "desktop app" type client, or cannot be read. */
  | 'bad-client-config'
  /** Cancelled (dialog, consent screen, cancel button). */
  | 'cancelled'
  /** There was no return from the consent screen after waiting 5 minutes. */
  | 'timeout'
  /** Refused on the consent screen, or removed a required scope. */
  | 'access-denied'
  /** Fetching the token failed (network, Google's response). */
  | 'token-request-failed'
  /** The secret storage (`safeStorage`) is not available. */
  | 'secret-storage'
  /** The plugin does not declare this credential, or the credential is unknown. */
  | 'unavailable'
  /** A login is already in progress. */
  | 'busy'
  | 'error'

export type PluginAccountResult =
  | { readonly ok: true; readonly accounts: readonly PluginAccountStatus[] }
  | { readonly ok: false; readonly error: PluginAccountError; readonly accounts: readonly PluginAccountStatus[] }
