/**
 * TODO 1144 stage 4 (wave 84 bundle G, ARCHITECTURE 8.5.1): verify the detached signature of `SHA256SUMS` (`SHA256SUMS.sig`).
 *
 * For an extension update, before matching the zip's SHA-256 against the `SHA256SUMS` row, check that `SHA256SUMS` itself was
 * signed with the release signing key. The signature is Ed25519 (Node's `crypto.verify`, no new dependency). The key is separate from the Developer ID of 951.
 *
 * - **While** `PLUGIN_SIGNING_PUBLIC_KEYS` **is empty**, nothing is verified (the `SHA256SUMS` match as before). From the version that embeds a key it becomes required,
 *   and extensions from a Release with no signature or a mismatching one are not updated (`plugin-update-unsigned`).
 * - Up to two keys (current and next). If either passes, it is accepted. How to rotate is in ARCHITECTURE 8.5.1.
 * - The main app's update does not go through here (the anchor is the codesign signer check, `verifyBundle`).
 */
import { createPublicKey, verify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reasonError } from '@shared/reason.js'

/** The name of the signature asset (same as `SUMS_SIGNATURE_ASSET` in `scripts/release-config.mjs`. A test compares them). */
export const SUMS_SIGNATURE_ASSET = 'SHA256SUMS.sig'

/**
 * The embedded public keys (Ed25519, one base64 line of SPKI DER). Up to two.
 * The keys are printed by `npm run plugin-signing:keygen`. While empty, no signature is required.
 * `readEmbeddedPublicKeys` in `scripts/plugin-signing.mjs` reads this array — keep one element per line and the quote as `'`.
 */
export const PLUGIN_SIGNING_PUBLIC_KEYS: readonly string[] = [
]

const MAX_KEYS = 2
/** Upper bound on the signature (64 bytes in base64) asset. */
const MAX_SIGNATURE_FILE_BYTES = 1024

/** Whether `signatureText` (base64) over `sums` passes with any of `keys`. A broken key is treated as not passing. */
export function verifySumsSignature(sums: Buffer, signatureText: string, keys: readonly string[]): boolean {
  const signature = Buffer.from(signatureText.trim(), 'base64')
  if (signature.length !== 64) return false
  for (const key of keys.slice(0, MAX_KEYS)) {
    try {
      const publicKey = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
      if (verify(null, sums, publicKey, signature)) return true
    } catch {
      // A broken key does not pass (try the other keys)
    }
  }
  return false
}

/**
 * Verify the `SHA256SUMS` and `SHA256SUMS.sig` fetched into `dir`. If the keys are empty, do nothing.
 * A missing, oversized, or mismatching signature is `plugin-update-unsigned`.
 */
export function checkSumsSignature(dir: string, keys: readonly string[] = PLUGIN_SIGNING_PUBLIC_KEYS): void {
  if (keys.length === 0) return
  const sumsPath = join(dir, 'SHA256SUMS')
  const sigPath = join(dir, SUMS_SIGNATURE_ASSET)
  if (!existsSync(sumsPath) || !existsSync(sigPath)) throw reasonError('plugin-update-unsigned')
  const signature = readFileSync(sigPath)
  if (signature.length > MAX_SIGNATURE_FILE_BYTES) throw reasonError('plugin-update-unsigned')
  if (!verifySumsSignature(readFileSync(sumsPath), signature.toString('utf8'), keys)) throw reasonError('plugin-update-unsigned')
}

/** The names of the assets to fetch: if the keys are not empty, ask for the signature too. */
export function sumsAssetNames(keys: readonly string[] = PLUGIN_SIGNING_PUBLIC_KEYS): string[] {
  return keys.length === 0 ? ['SHA256SUMS'] : ['SHA256SUMS', SUMS_SIGNATURE_ASSET]
}
