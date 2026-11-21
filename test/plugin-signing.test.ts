/**
 * TODO 1144 stage 4 (wave 84 bundle G, ARCHITECTURE 8.5.1): signing of the extension distribution (SHA256SUMS.sig, Ed25519).
 *
 * - The check in the app (`sums-signature.ts`) and the release signing (`scripts/plugin-signing.mjs`) agree on the same format
 * - While the public key is empty, things stay as they are (no signature is required or asked for). A build with the key filled in refuses, with `plugin-update-unsigned`,
 *   a Release that is unsigned, does not match, or is signed with another key
 * - Up to two keys (current and next); either one passes
 * - release: if there is no key, it warns and continues only while the public key is empty, and fails if it is filled in. It refuses if the private key's permissions are too broad
 * Keys are made throwaway inside the test (no private key is put into the repo or into a fixed value). gh, the network, and the model are not called.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { createHash } from 'node:crypto'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import * as signing from '../scripts/plugin-signing.mjs'
// @ts-expect-error -- untyped .mjs
import { SUMS_SIGNATURE_ASSET as RELEASE_SIG, ghReleaseCommand, releaseAssets } from '../scripts/release-config.mjs'
import { pluginAssetName } from '../src/shared/plugin-update.js'
import { parseReason } from '../src/shared/reason.js'
import { PLUGIN_SIGNING_PUBLIC_KEYS, SUMS_SIGNATURE_ASSET, checkSumsSignature, sumsAssetNames, verifySumsSignature } from '../src/main/update/sums-signature.js'
import { UpdatedPluginStore, type UpdatedPluginRecords } from '../src/main/plugin/updated-store.js'
import { stagePluginRelease } from '../src/main/update/plugin-install.js'
import type { ReleaseSource } from '../src/main/update/release-source.js'
import type { UpdatedPluginRecord } from '../src/common/settings-keys.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-signing-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function newKey(): { privateKey: KeyObject; publicText: string } {
  const { privateKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicText: signing.publicKeyText(privateKey) as string }
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return parseReason(err instanceof Error ? err.message : String(err))?.code
  }
}

const SUMS = Buffer.from(`${'a'.repeat(64)}  plugin-aios.text-1.0.0.zip\n`)

describe('署名の形式 (release の署名と本体の検め)', () => {
  it('scripts の署名が本体の検めで通る・改ざんした SHA256SUMS と他の鍵は通らない', () => {
    const a = newKey()
    const b = newKey()
    const sig = signing.signSums(SUMS, a.privateKey) as string
    expect(verifySumsSignature(SUMS, sig, [a.publicText])).toBe(true)
    expect(signing.verifySums(SUMS, sig, [a.publicText])).toBe(true)
    expect(verifySumsSignature(Buffer.from(`${SUMS.toString()}x`), sig, [a.publicText])).toBe(false)
    expect(verifySumsSignature(SUMS, sig, [b.publicText])).toBe(false)
    expect(verifySumsSignature(SUMS, sig, [])).toBe(false)
    expect(verifySumsSignature(SUMS, 'not-a-signature', [a.publicText])).toBe(false)
  })

  it('鍵は 2 本まで。どちらでも通り、壊れた鍵は飛ばし、3 本目は見ない', () => {
    const [a, b, c] = [newKey(), newKey(), newKey()]
    const sigB = signing.signSums(SUMS, b.privateKey) as string
    expect(verifySumsSignature(SUMS, sigB, [a.publicText, b.publicText])).toBe(true)
    expect(verifySumsSignature(SUMS, sigB, ['garbage', b.publicText])).toBe(true)
    expect(verifySumsSignature(SUMS, signing.signSums(SUMS, c.privateKey) as string, [a.publicText, b.publicText, c.publicText])).toBe(false)
  })

  it('資産の名前は scripts と本体で同じ。埋め込みの鍵は今は空 (署名は任意)', () => {
    expect(RELEASE_SIG).toBe(SUMS_SIGNATURE_ASSET)
    expect(signing.SUMS_SIGNATURE_ASSET).toBe(SUMS_SIGNATURE_ASSET)
    // The embedded key that scripts read = the key the app holds
    const root = join(__dirname, '..')
    expect(signing.readEmbeddedPublicKeys(root)).toEqual([...PLUGIN_SIGNING_PUBLIC_KEYS])
    expect(PLUGIN_SIGNING_PUBLIC_KEYS.length).toBeLessThanOrEqual(2)
    expect(signing.parseEmbeddedPublicKeys("export const PLUGIN_SIGNING_PUBLIC_KEYS: readonly string[] = [\n  'AAA',\n  'BBB'\n]")).toEqual(['AAA', 'BBB'])
  })
})

describe('checkSumsSignature (取った SHA256SUMS の検め)', () => {
  function put(sums: Buffer, sig: string | null): string {
    const d = mkdtempSync(join(dir, 'dl-'))
    writeFileSync(join(d, 'SHA256SUMS'), sums)
    if (sig !== null) writeFileSync(join(d, SUMS_SIGNATURE_ASSET), sig)
    return d
  }

  it('鍵が空なら署名を頼まず、あっても見ない (今までどおり)', () => {
    expect(sumsAssetNames([])).toEqual(['SHA256SUMS'])
    expect(codeOf(() => checkSumsSignature(put(SUMS, null), []))).toBeUndefined()
    expect(codeOf(() => checkSumsSignature(put(SUMS, 'junk'), []))).toBeUndefined()
  })

  it('鍵を埋めたら署名も頼み、署名が無い・壊れている・合わない・他の鍵・大きすぎるは plugin-update-unsigned', () => {
    const a = newKey()
    const other = newKey()
    expect(sumsAssetNames([a.publicText])).toEqual(['SHA256SUMS', SUMS_SIGNATURE_ASSET])
    expect(codeOf(() => checkSumsSignature(put(SUMS, signing.signSums(SUMS, a.privateKey)), [a.publicText]))).toBeUndefined()
    expect(codeOf(() => checkSumsSignature(put(SUMS, null), [a.publicText]))).toBe('plugin-update-unsigned')
    expect(codeOf(() => checkSumsSignature(put(SUMS, 'junk'), [a.publicText]))).toBe('plugin-update-unsigned')
    expect(codeOf(() => checkSumsSignature(put(SUMS, signing.signSums(SUMS, other.privateKey)), [a.publicText]))).toBe('plugin-update-unsigned')
    const tampered = Buffer.from(`${SUMS.toString()}${'b'.repeat(64)}  evil.zip\n`)
    expect(codeOf(() => checkSumsSignature(put(tampered, signing.signSums(SUMS, a.privateKey)), [a.publicText]))).toBe('plugin-update-unsigned')
    expect(codeOf(() => checkSumsSignature(put(SUMS, 'A'.repeat(4096)), [a.publicText]))).toBe('plugin-update-unsigned')
  })
})

describe('拡張機能の更新の受け入れ条件 (stagePluginRelease)', () => {
  const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
  const asset = pluginAssetName('aios.alpha', '1.1.0')
  const zip = zipSync({ 'manifest.json': new TextEncoder().encode('{"id":"aios.alpha"}') })
  const sumsText = `${sha(zip)}  ${asset}\n`
  const entry = { version: '1.1.0', asset, sha256: sha(zip) }

  function store(): UpdatedPluginStore {
    const holder: UpdatedPluginRecords & { value: Record<string, UpdatedPluginRecord> } = {
      value: {},
      read: () => holder.value,
      write: (next) => {
        holder.value = { ...next }
      }
    }
    return new UpdatedPluginStore(join(dir, 'updates'), holder)
  }
  /** A fake Release that records the names it was asked for, and returns `sig` as SHA256SUMS.sig (not written if null). */
  function source(sig: string | null, asked: string[][]): ReleaseSource {
    return {
      latestTag: async () => 'v0.84.0',
      download: async (_tag, names, into) => {
        asked.push([...names])
        for (const name of names) {
          if (name === asset) writeFileSync(join(into, name), zip)
          else if (name === 'SHA256SUMS') writeFileSync(join(into, name), sumsText)
          else if (name === SUMS_SIGNATURE_ASSET && sig !== null) writeFileSync(join(into, name), sig)
        }
      }
    }
  }
  const stage = (s: ReleaseSource, keys: readonly string[]): Promise<string> =>
    stagePluginRelease(s, store(), 'v0.84.0', 'aios.alpha', entry, () => false, keys)
  async function codeOfAsync(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p
      return undefined
    } catch (err) {
      return parseReason(err instanceof Error ? err.message : String(err))?.code
    }
  }

  it('鍵が空の間は SHA256SUMS だけを頼み、署名が無くても署名の段では落ちない (manifest の検めまで進む)', async () => {
    const asked: string[][] = []
    expect(await codeOfAsync(stage(source(null, asked), []))).toBe('plugin-update-invalid')
    expect(asked[0]).toEqual([asset, 'SHA256SUMS'])
  })

  it('鍵を埋めた版は署名の無い Release・改ざんした SHA256SUMS・他の鍵の署名から更新しない。正しい署名なら次の検めに進む', async () => {
    const a = newKey()
    const other = newKey()
    const asked: string[][] = []
    expect(await codeOfAsync(stage(source(null, asked), [a.publicText]))).toBe('plugin-update-unsigned')
    expect(asked[0]).toEqual([asset, 'SHA256SUMS', SUMS_SIGNATURE_ASSET])
    expect(await codeOfAsync(stage(source(signing.signSums(Buffer.from('other'), a.privateKey), []), [a.publicText]))).toBe('plugin-update-unsigned')
    expect(await codeOfAsync(stage(source(signing.signSums(Buffer.from(sumsText), other.privateKey), []), [a.publicText]))).toBe('plugin-update-unsigned')
    // If the signature passes, the signature stage is cleared (here the manifest is a broken zip, so it stops at the next stage, plugin-update-invalid).
    expect(await codeOfAsync(stage(source(signing.signSums(Buffer.from(sumsText), a.privateKey), []), [a.publicText]))).toBe('plugin-update-invalid')
  })
})

describe('release の署名の段 (signReleaseSums)', () => {
  const root = join(__dirname, '..')

  function dist(): string {
    const d = mkdtempSync(join(dir, 'dist-'))
    writeFileSync(join(d, 'SHA256SUMS'), SUMS)
    return d
  }
  function writeKey(path: string, key: KeyObject, mode = 0o600): void {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, key.export({ type: 'pkcs8', format: 'pem' }), { mode })
    chmodSync(path, mode)
  }

  it('公開鍵が空 (今) で秘密鍵が無ければ警告して続け、SHA256SUMS.sig は作らない', () => {
    const d = dist()
    const result = signing.signReleaseSums({ distDir: d, writeFile: writeFileSync, root, secretKeyPath: join(dir, 'none.pem') })
    expect(result.signed).toBe(false)
    expect(result.warning).toContain('SHA256SUMS.sig なしで続ける')
    expect(existsSync(join(d, SUMS_SIGNATURE_ASSET))).toBe(false)
  })

  it('秘密鍵があれば署名して書く。その署名は本体の検めで通る', () => {
    const k = newKey()
    const keyPath = join(dir, 'keys', 'k.pem')
    writeKey(keyPath, k.privateKey)
    const d = dist()
    const result = signing.signReleaseSums({ distDir: d, writeFile: writeFileSync, root, secretKeyPath: keyPath })
    expect(result).toEqual({ signed: true, warning: null })
    expect(verifySumsSignature(SUMS, readFileSync(join(d, SUMS_SIGNATURE_ASSET), 'utf8'), [k.publicText])).toBe(true)
  })

  it('権限の広い秘密鍵は拒む', () => {
    const k = newKey()
    const keyPath = join(dir, 'wide.pem')
    writeKey(keyPath, k.privateKey, 0o644)
    expect(() => signing.signReleaseSums({ distDir: dist(), writeFile: writeFileSync, root, secretKeyPath: keyPath })).toThrow(/権限/)
  })

  it('公開鍵が埋まっているときに鍵が無い・対にならないは失敗する (埋め込みの鍵は root の sums-signature.ts から読む)', () => {
    const fakeRoot = join(dir, 'root')
    mkdirSync(join(fakeRoot, 'src', 'main', 'update'), { recursive: true })
    const embedded = newKey()
    writeFileSync(
      join(fakeRoot, 'src', 'main', 'update', 'sums-signature.ts'),
      `export const PLUGIN_SIGNING_PUBLIC_KEYS: readonly string[] = [\n  '${embedded.publicText}'\n]\n`
    )
    expect(() => signing.signReleaseSums({ distDir: dist(), writeFile: writeFileSync, root: fakeRoot, secretKeyPath: join(dir, 'none.pem') })).toThrow(/署名が必須/)
    const wrong = join(dir, 'wrong.pem')
    writeKey(wrong, newKey().privateKey)
    expect(() => signing.signReleaseSums({ distDir: dist(), writeFile: writeFileSync, root: fakeRoot, secretKeyPath: wrong })).toThrow(/対にならない/)
    const right = join(dir, 'right.pem')
    writeKey(right, embedded.privateKey)
    expect(signing.signReleaseSums({ distDir: dist(), writeFile: writeFileSync, root: fakeRoot, secretKeyPath: right }).signed).toBe(true)
  })

  it('署名ありの回だけ SHA256SUMS.sig を添付する資産の名前に入れる (SHA256SUMS の次)', () => {
    expect(releaseAssets('0.84.0')).not.toContain(SUMS_SIGNATURE_ASSET)
    const signed = releaseAssets('0.84.0', [], true) as string[]
    expect(signed.slice(-2)).toEqual(['SHA256SUMS', SUMS_SIGNATURE_ASSET])
    expect(ghReleaseCommand({ version: '0.84.0', commit: null, signed: true })).toContain(`dist/${SUMS_SIGNATURE_ASSET}`)
    expect(ghReleaseCommand({ version: '0.84.0', commit: null })).not.toContain(SUMS_SIGNATURE_ASSET)
  })
})
