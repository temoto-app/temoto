// TODO 1144 stage 4: signs the distributed extensions (the detached Ed25519 signature of SHA256SUMS). Used by release.mjs, key generation, and the tests.
// Same format as the check on the app side (src/main/update/sums-signature.ts): the signature is Ed25519 over the contents of SHA256SUMS itself,
// and SHA256SUMS.sig is the base64 of the 64-byte signature (one line). The public key is the base64 of SPKI's DER (one line).
// The value of the secret key is printed nowhere (only its path).
import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The name of the signature asset (the same as `SUMS_SIGNATURE_ASSET` in src/main/update/sums-signature.ts; a test checks that they match). */
export const SUMS_SIGNATURE_ASSET = 'SHA256SUMS.sig'

/** The default location of the secret key (outside the repo). It can be changed with `AIOS_PLUGIN_SIGNING_KEY`. */
export function defaultSecretKeyPath(env = process.env) {
  const fromEnv = env.AIOS_PLUGIN_SIGNING_KEY
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.config', 'aios-release', 'plugin-signing.key.pem')
}

/**
 * The public keys embedded in the app (`PLUGIN_SIGNING_PUBLIC_KEYS` in src/main/update/sums-signature.ts). If it is empty, signing is optional.
 * @param {string} source the contents of sums-signature.ts
 * @returns {string[]}
 */
export function parseEmbeddedPublicKeys(source) {
  const m = /PLUGIN_SIGNING_PUBLIC_KEYS\s*:\s*readonly string\[\]\s*=\s*\[([^\]]*)\]/.exec(source)
  if (m === null) throw new Error('PLUGIN_SIGNING_PUBLIC_KEYS が sums-signature.ts に見つからない')
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
}

/** @param {string} root the root of the repo */
export function readEmbeddedPublicKeys(root) {
  return parseEmbeddedPublicKeys(readFileSync(join(root, 'src', 'main', 'update', 'sums-signature.ts'), 'utf8'))
}

/** Reads the secret key (PEM of PKCS8). Refuses it if group or other can read it (enforces 0600). */
export function readSecretKey(path) {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`秘密鍵の権限が広い (chmod 600 ${path})`)
  return createPrivateKey(readFileSync(path, 'utf8'))
}

/** The public key (the base64 of SPKI's DER) */
export function publicKeyText(privateKey) {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64')
}

/** The signature (base64, one line ending in a newline) of `sums` (a Buffer) */
export function signSums(sums, privateKey) {
  return `${sign(null, sums, privateKey).toString('base64')}\n`
}

/** Whether `signatureText` verifies with any of `publicKeys` (base64 of SPKI) */
export function verifySums(sums, signatureText, publicKeys) {
  const signature = Buffer.from(signatureText.trim(), 'base64')
  if (signature.length !== 64) return false
  return publicKeys.some((key) => {
    try {
      return verify(null, sums, createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), signature)
    } catch {
      return false
    }
  })
}

/**
 * Called right after release.mjs writes SHA256SUMS.
 * - If there is a secret key, it signs and writes `SHA256SUMS.sig`, and checks that it verifies with the embedded public key (if any).
 * - When there is no secret key: if the public key is empty, it warns and continues (a Release without a signature); if one is embedded, it fails.
 * - If the secret key does not pair with any of the embedded public keys, it fails when a public key is embedded.
 * @returns {{ signed: boolean, warning: string | null }}
 */
export function signReleaseSums({ distDir, writeFile, root, secretKeyPath = defaultSecretKeyPath() }) {
  const embedded = readEmbeddedPublicKeys(root)
  const sums = readFileSync(join(distDir, 'SHA256SUMS'))
  if (!existsSync(secretKeyPath)) {
    if (embedded.length > 0) {
      throw new Error(`拡張機能の署名鍵が無い (${secretKeyPath})。公開鍵を埋めた版は署名が必須。docs/notes/wave84.md の手順で鍵を置く`)
    }
    return { signed: false, warning: `拡張機能の署名鍵が無い (${secretKeyPath}) — SHA256SUMS.sig なしで続ける (公開鍵が空の間だけ許す)` }
  }
  const key = readSecretKey(secretKeyPath)
  const text = signSums(sums, key)
  if (embedded.length > 0 && !verifySums(sums, text, embedded)) {
    throw new Error('署名鍵が本体に埋め込んだ公開鍵のどれとも対にならない。鍵を取り違えている')
  }
  writeFile(join(distDir, SUMS_SIGNATURE_ASSET), text)
  return { signed: true, warning: null }
}
