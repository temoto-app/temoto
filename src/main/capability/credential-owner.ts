/**
 * Owners of credential names (wave 84 fix Z, security review of TODO 1218 / 952).
 *
 * For the credentials whose login or input main handles (`GOOGLE_CREDENTIALS` / `BASIC_CREDENTIALS`), each row of the table carries the **owner extension's id**
 * (bundled only). Even if a non-owner extension writes the same name in its manifest, it cannot make its own requests carry the token the user entered
 * for that owner (even with a fixed destination host, it could read with someone else's token). This is not a "trust tier" but a
 * destination binding: it only ties one credential name to one extension and does not change the breadth of the capability (7.7).
 *
 * It is guarded in 3 places (all decided by the same function):
 *   - Manifest validation (`manifest.ts`): if a non-owner id declares a name in the table, it is not loaded (the same practice as `index.write` in TODO 920).
 *   - Policy assembly (`policyOf` in `host.ts`) and the input entry point (`PluginAccounts`): even for the owner's id, it is dropped **if not bundled**.
 *   - The Broker (`credentials.status` / the `auth` of `net.fetch`): whether the requesting extension's id is the owner (even if a path builds the policy from outside).
 *
 * Names not in the table get no value from main (only table names and the client's rows go into `CredentialStore`), so they are not restricted here.
 */
import { BASIC_CREDENTIALS } from './basic-credentials.js'
import { GOOGLE_CREDENTIALS } from './google-credentials.js'

/** The id of the extension that owns the name. null for a name not in the table. */
export function credentialOwner(name: string): string | null {
  return (
    GOOGLE_CREDENTIALS.find((spec) => spec.name === name)?.owner ??
    BASIC_CREDENTIALS.find((spec) => spec.name === name)?.owner ??
    null
  )
}

/** Whether this id may declare and use this name (bundled-ness is not checked here; used by manifest validation and the Broker). */
export function credentialOwnedBy(name: string, pluginId: string): boolean {
  const owner = credentialOwner(name)
  return owner === null || owner === pluginId
}

/** Whether a loaded extension may use this name. For a name in the table, only if it is the owner's id **and** bundled. */
export function credentialUsableBy(name: string, plugin: { readonly id: string; readonly bundled: boolean }): boolean {
  const owner = credentialOwner(name)
  return owner === null || (owner === plugin.id && plugin.bundled)
}
