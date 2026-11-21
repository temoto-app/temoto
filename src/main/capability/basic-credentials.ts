/**
 * Table of credentials where the user enters a fixed token in an extension's details (TODO 1218, Basic authentication).
 *
 * Unlike OAuth (`google-credentials.ts`), there is no login flow; the user enters an email address and a token.
 * Main builds `Authorization: Basic base64(email:token)` and seals it with `CredentialStore.put`.
 * **The destination host is decided by the table here** (the plugin does not get to decide). The value is never returned to the renderer or to a plugin (7.7).
 * An input field appears in the details of a plugin whose manifest `capabilities.credentials.basic` lists a name from here.
 */

export interface BasicCredentialSpec {
  /** Credential name (the manifest's `credentials.basic` and `net.fetch`'s `auth`). */
  readonly name: string
  /** Destination to attach the credential to (attached only when it matches this host exactly). */
  readonly host: string
  /**
   * The id of the owning extension (bundled only). **Anything other than the owner can neither declare nor use this name** (wave 84 fix Z, `credential-owner.ts`).
   * Prevents another extension from writing the same name and borrowing the token the user entered for the owner.
   */
  readonly owner: string
}

export const BITBUCKET_CREDENTIAL = 'bitbucket:api-token'

export const BASIC_CREDENTIALS: readonly BasicCredentialSpec[] = [
  { name: BITBUCKET_CREDENTIAL, host: 'api.bitbucket.org', owner: 'aios.bitbucket' }
]

export function basicCredentialSpec(name: string): BasicCredentialSpec | null {
  return BASIC_CREDENTIALS.find((spec) => spec.name === name) ?? null
}

/** Upper bound on input length (an email is 254; an Atlassian token is a few hundred characters). */
export const MAX_BASIC_EMAIL = 254
export const MAX_BASIC_TOKEN = 1024

/** An email contains no whitespace or `:` and exactly one `@` (so it is not confused with Basic's separator). A token is printable ASCII only. */
export function checkBasicInput(email: string, token: string): boolean {
  if (email.length === 0 || email.length > MAX_BASIC_EMAIL || token.length === 0 || token.length > MAX_BASIC_TOKEN) return false
  if (!/^[^\s:@]+@[^\s:@]+$/.test(email)) return false
  return /^[\x21-\x7e]+$/.test(token)
}

/** `Basic <base64(email:token)>` (the header value). */
export function basicHeaderValue(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`
}
