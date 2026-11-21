// TODO 1144 stage 4: makes the extension signing key (Ed25519). The owner runs it once, by hand.
//   npm run plugin-signing:keygen
// The secret key is written outside the repo (by default ~/.config/aios-release/plugin-signing.key.pem; change it with AIOS_PLUGIN_SIGNING_KEY), with permission 0600.
// If it already exists, it is not overwritten. Only the public key (the base64 of SPKI's DER, one line) is printed; paste it into
// PLUGIN_SIGNING_PUBLIC_KEYS in src/main/update/sums-signature.ts. The value of the secret key is not printed.
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultSecretKeyPath, publicKeyText } from './plugin-signing.mjs'

const path = defaultSecretKeyPath()
if (existsSync(path)) {
  console.error(`plugin-signing-keygen: 既に鍵がある (${path})。上書きしない。替えるなら別のパスを AIOS_PLUGIN_SIGNING_KEY で渡す`)
  process.exit(1)
}
const { privateKey } = generateKeyPairSync('ed25519')
mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
chmodSync(path, 0o600)
console.log(`秘密鍵: ${path} (0600。バックアップはオーナーの手で。repo に入れない)`)
console.log('公開鍵 (src/main/update/sums-signature.ts の PLUGIN_SIGNING_PUBLIC_KEYS に貼る):')
console.log(publicKeyText(privateKey))
