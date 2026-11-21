/**
 * TODO 1144 stage 2 (wave 73 bundle C, ARCHITECTURE 8.5.1): update one extension from the Release assets.
 *
 * 1. Fetch: with the user's `gh`, fetch the asset of the version-table row (`plugin-<id>-<version>.zip`) and `SHA256SUMS` into the install location's staging area (`.staging-*`)
 *    (the same entry point `ReleaseSource` as the main app's zip, the same repo and the same tag).
 * 2. Verify: (in a build with the public key embedded, `SHA256SUMS.sig` must pass, stage 4) the zip's SHA-256 must match **both** the `SHA256SUMS` row and the `sha256` of the version table
 *    (`plugins.json`, already cross-checked against `SHA256SUMS` when fetched). The size limit too.
 * 3. Extract: `extractPluginZip` (rejects path escapes, symlinks, and oversize). The extracted manifest goes through the main app's validation (`readManifest`), and
 *    its id and version must match the version-table row.
 * 4. Replace: `UpdatedPluginStore.install` (one rename + a record in the encrypted DB) -> `PluginHost.reloadAfterUpdate`
 *    (stop that plugin-host and reload) -> delete the old version (`prune`).
 *
 * On failure anywhere, the staging area is deleted whole and the version currently loaded stays (the bundled one or a previously installed one). Other extensions and the main app's version are untouched.
 * Only main's `gh` entry point reaches the network (does not go through the plugin Broker, constraint 8). Plugin code is neither read nor run.
 *
 * Unlike the main app, the extension zip has no codesign signature (it is a bundle of JS outside the .app). The root of trust is the same as the main app's update,
 * "the `SHA256SUMS` of the same Release in the same repo, visible with the user's gh", and the signer (1090) does not change —
 * no keychain prompt appears either (the main app's .app is not replaced).
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { reasonError } from '@shared/reason.js'
import { normalizeVersion } from '@shared/update.js'
import { readManifest } from '../plugin/manifest.js'
import type { UpdatedPluginStore } from '../plugin/updated-store.js'
import type { InstallableEntry } from './plugin-versions.js'
import type { ReleaseSource } from './release-source.js'
import { checksumFor, sha256OfFile } from './stage.js'
import { PLUGIN_SIGNING_PUBLIC_KEYS, checkSumsSignature, sumsAssetNames } from './sums-signature.js'
import { MAX_PLUGIN_ZIP_BYTES, extractPluginZip } from './plugin-zip.js'

/** The reload entry point (part of `PluginHost`). */
export interface PluginReloader {
  reloadAfterUpdate(pluginId: string): Promise<void>
}

export interface PluginInstallDeps {
  readonly source: ReleaseSource
  readonly store: Pick<UpdatedPluginStore, 'createStaging' | 'install' | 'prune'>
  readonly host: PluginReloader
  /** Whether shutdown has begun. If it has, do not install or reload (do not write a record after the DB is closed, 12.9). */
  readonly closing?: () => boolean
}

/**
 * Fetch the `entry` (the row for extension `id`) of the Release with tag `tag`, verify it, and put it in the install location. Returns the directory it was placed in.
 * It does not reload (`installPluginRelease` calls that next).
 */
export async function stagePluginRelease(
  source: ReleaseSource,
  store: Pick<UpdatedPluginStore, 'createStaging' | 'install'>,
  tag: string,
  id: string,
  entry: InstallableEntry,
  closing: () => boolean = () => false,
  signingKeys: readonly string[] = PLUGIN_SIGNING_PUBLIC_KEYS
): Promise<string> {
  const version = normalizeVersion(entry.version)
  if (version === null) throw reasonError('plugin-update-invalid')
  const staging = store.createStaging()
  try {
    // The asset names have been narrowed to a shape without separators by the version-table validation (`parsePluginVersionTable`).
    await source.download(tag, [entry.asset, ...sumsAssetNames(signingKeys)], staging)
    const zipPath = join(staging, entry.asset)
    const sumsPath = join(staging, 'SHA256SUMS')
    if (!existsSync(zipPath) || !existsSync(sumsPath)) throw reasonError('update-download-failed')
    if (statSync(zipPath).size > MAX_PLUGIN_ZIP_BYTES) throw reasonError('plugin-update-invalid')
    // TODO 1144 stage 4: in a build with the public key embedded, never install an extension from a Release whose SHA256SUMS signature does not pass.
    checkSumsSignature(staging, signingKeys)
    const listed = checksumFor(readFileSync(sumsPath, 'utf8'), entry.asset)
    const actual = await sha256OfFile(zipPath)
    if (listed === null || listed !== actual || entry.sha256 !== actual) throw reasonError('update-checksum-mismatch')

    const extracted = join(staging, 'bundle')
    await extractPluginZip(zipPath, extracted)
    let manifest: ReturnType<typeof readManifest>
    try {
      manifest = readManifest(extracted)
    } catch {
      throw reasonError('plugin-update-invalid')
    }
    if (manifest.id !== id || normalizeVersion(manifest.version) !== version) throw reasonError('plugin-update-invalid')
    if (closing()) throw reasonError('update-install-failed')
    return store.install(id, version, extracted)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Fetch, verify, place -> reload only that extension -> delete the old version (the job handed to `PluginReleaseCatalog.update`). */
export async function installPluginRelease(deps: PluginInstallDeps, tag: string, id: string, entry: InstallableEntry): Promise<void> {
  const closing = deps.closing ?? (() => false)
  await stagePluginRelease(deps.source, deps.store, tag, id, entry, closing)
  if (closing()) return
  await deps.host.reloadAfterUpdate(id)
  if (closing()) return
  deps.store.prune(id)
}
