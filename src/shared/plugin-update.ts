/**
 * TODO 1144 stage 1 (wave 72 bundle C, ARCHITECTURE 8.5.1): the version and update state of each extension (an aios plugin).
 *
 * - The canonical version is each plugin's `manifest.version`. Whether it is "the latest" is checked against the asset of the latest Release seen by the app's auto-update (8.5),
 *   `plugins.json` (**the extension version table**, produced by `npm run release`). No separate registry is made (owner decision 2026-11-06).
 * - It is checked only at the same times as the app's update check (2 minutes after launch, periodically after that, and "Check for updates" in settings). There is no separate schedule.
 * - It holds no wording (7.4.4). The renderer's dictionary turns it into sentences with `extensions.update.*`.
 *
 * Stage 2 (wave 73 bundle C, "stage 2" of ARCHITECTURE 8.5.1): the version table rows gained the asset name per plugin (`asset`) and a SHA-256 (`sha256`).
 * The format number stays 1 (old aios drops keys it does not know, so nothing breaks). Only rows with both can be "updated" (`installable`).
 * The updating state (`updating`) and failure (`failed`, a reason code) are overlaid by main's `PluginReleaseCatalog` on the version table matching.
 */
import type { ReasonCode } from './reason.js'
import { compareVersions, normalizeVersion, type UpdateUnsupportedReason } from './update.js'

/** The name of the Release asset (the same as `PLUGIN_VERSIONS_ASSET` in `scripts/release-config.mjs`; a test cross-checks them). */
export const PLUGIN_VERSIONS_ASSET = 'plugins.json'

/** The format number of the version table. If raised, old aios becomes "cannot check" (the version table cannot be read). */
export const PLUGIN_VERSIONS_FORMAT = 1

/** One row of the version table (one plugin). */
export interface PluginVersionEntry {
  readonly version: string
  /**
   * Stage 2: the bundle zip of that version (the name of the Release asset, `plugin-<id>-<version>.zip`) and its SHA-256 (lower-case hex).
   * Present only when both are there and well formed (the stage 1 version table does not have them).
   */
  readonly asset?: string
  readonly sha256?: string
}

/** Stage 2: the name of a plugin's asset (the same as `pluginAssetName` in `scripts/release-config.mjs`; a test cross-checks them). */
export function pluginAssetName(id: string, version: string): string {
  return `plugin-${id}-${version}.zip`
}

/** The form of an asset name (no path separators, ends with `.zip`). */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.zip$/
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * The extension version table (`plugins.json`).
 *
 * ```json
 * { "format": 1, "aios": "0.72.0", "plugins": { "aios.text": { "version": "1.0.0" }, … } }
 * ```
 *
 * `aios` is the app version of that Release, and `plugins` maps the ids of the bundled plugins to rows.
 */
export interface PluginVersionTable {
  readonly format: number
  readonly aios: string
  readonly plugins: Readonly<Record<string, PluginVersionEntry>>
}

/** The form of a plugin id (the same character set as the manifest id. The length is loose, matching the limit in manifest.ts). */
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
/** Upper limit of version table rows (so a broken / oversized asset is not read to the end). */
const MAX_ENTRIES = 512

/** Validates the contents of `plugins.json`. null if the shape is wrong (unknown keys are dropped). */
export function parsePluginVersionTable(value: unknown): PluginVersionTable | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record['format'] !== PLUGIN_VERSIONS_FORMAT) return null
  const aios = typeof record['aios'] === 'string' ? normalizeVersion(record['aios']) : null
  if (aios === null) return null
  const plugins = record['plugins']
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return null
  const entries = Object.entries(plugins as Record<string, unknown>)
  if (entries.length > MAX_ENTRIES) return null
  const out: Record<string, PluginVersionEntry> = {}
  for (const [id, entry] of entries) {
    if (!PLUGIN_ID.test(id)) return null
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const version = (entry as Record<string, unknown>)['version']
    if (typeof version !== 'string' || version.length === 0 || version.length > 32) return null
    // Stage 2: the asset name and SHA-256. Having only one, or a wrong shape, is read as "a row that cannot be updated" (the row itself is not dropped).
    const asset = (entry as Record<string, unknown>)['asset']
    const sha256 = (entry as Record<string, unknown>)['sha256']
    const installable =
      typeof asset === 'string' && ASSET_NAME.test(asset) && !asset.includes('..') && typeof sha256 === 'string' && SHA256_HEX.test(sha256)
    out[id] = installable ? { version, asset, sha256 } : { version }
  }
  return { format: PLUGIN_VERSIONS_FORMAT, aios, plugins: out }
}

/** Reasons for "cannot check". */
export const PLUGIN_UPDATE_UNKNOWN_REASONS = [
  /** An extension the user installed (not distributed in aios Releases, so there is no version table to match against) */
  'not-bundled',
  /** A form in which the app's auto-update does not run (dev, a shell in development, a copy of a verification build). The detailed reason is `updateUnsupported` */
  'unsupported',
  /** Not checked yet (within 2 minutes of launch; auto-update is OFF and "Check for updates" has not been pressed) */
  'not-checked',
  /** The latest Release or the version table could not be fetched, or the version table cannot be read (the reason code is in `failure`) */
  'check-failed',
  /** The latest Release has no version table (a Release from before the version table was added) */
  'no-table',
  /** Not in the version table (removed from the bundle in the latest version) */
  'not-listed',
  /** The installed version or the version table's version is not `x.y.z` */
  'invalid-version'
] as const

export type PluginUpdateUnknownReason = (typeof PLUGIN_UPDATE_UNKNOWN_REASONS)[number]

/** The update state of one extension, shown in the list and the details. */
export type PluginUpdateInfo =
  /** The installed version is the version table's version or newer (`latest` is the version table's version) */
  | { readonly state: 'up-to-date'; readonly latest: string }
  /**
   * The version table is newer (`latest` is the newer version). `installable` means the version table row has an asset and SHA-256 (the stage 2 "Update" can be pressed).
   * For a stage 1 version table (rows without an asset) it is false, and the update comes with the app update.
   */
  | { readonly state: 'available'; readonly latest: string; readonly installable: boolean }
  /** Stage 2: updating to `latest` (fetch, verify, extract, replace) */
  | { readonly state: 'updating'; readonly latest: string }
  /** Stage 2: the update to `latest` failed (`failure` is a reason code). It can be retried with "Update" */
  | { readonly state: 'failed'; readonly latest: string; readonly failure: ReasonCode }
  /** Cannot be determined (with a reason) */
  | {
      readonly state: 'unknown'
      readonly reason: PluginUpdateUnknownReason
      /** When `reason === 'unsupported'`, why the app's auto-update does not run (8.5). */
      readonly updateUnsupported: UpdateUnsupportedReason | null
      /** When `reason === 'check-failed'`, the reason code of the failure (`update-*`). */
      readonly failure: ReasonCode | null
    }

/**
 * Stage 3 (wave 74): the result for one extension in the bulk "update all" (one row of the return value of `plugins.updateAll`).
 * `from` is the version at the start, and `to` is the version it tried to install (null if it had become non-updatable before starting).
 */
export type PluginUpdateAllResult =
  | { readonly id: string; readonly from: string; readonly to: string; readonly outcome: 'updated' }
  | {
      readonly id: string
      readonly from: string | null
      readonly to: string | null
      readonly outcome: 'failed'
      /** A reason code (`update-*` / `plugin-update-*` for fetching, verifying and replacing). */
      readonly failure: ReasonCode
    }

/**
 * The state of "the latest Release's version table" that main holds (`PluginReleaseCatalog` in `src/main/update/plugin-versions.ts`).
 * Placed in shared so that it can be passed to the pure matching (`pluginUpdateOf`).
 */
export type PluginReleaseState =
  | { readonly kind: 'unsupported'; readonly reason: UpdateUnsupportedReason }
  | { readonly kind: 'not-checked' }
  | { readonly kind: 'failed'; readonly failure: ReasonCode }
  | { readonly kind: 'no-table'; readonly tag: string }
  | { readonly kind: 'table'; readonly tag: string; readonly table: PluginVersionTable }

function unknown(
  reason: PluginUpdateUnknownReason,
  extra: { readonly updateUnsupported?: UpdateUnsupportedReason; readonly failure?: ReasonCode } = {}
): PluginUpdateInfo {
  return { state: 'unknown', reason, updateUnsupported: extra.updateUnsupported ?? null, failure: extra.failure ?? null }
}

/** Matches one extension's version against the version table. */
export function pluginUpdateOf(
  plugin: { readonly id: string; readonly version: string; readonly bundled: boolean },
  release: PluginReleaseState
): PluginUpdateInfo {
  if (!plugin.bundled) return unknown('not-bundled')
  switch (release.kind) {
    case 'unsupported':
      return unknown('unsupported', { updateUnsupported: release.reason })
    case 'not-checked':
      return unknown('not-checked')
    case 'failed':
      return unknown('check-failed', { failure: release.failure })
    case 'no-table':
      return unknown('no-table')
    case 'table': {
      const entry = release.table.plugins[plugin.id]
      if (entry === undefined) return unknown('not-listed')
      const order = compareVersions(entry.version, plugin.version)
      if (order === null) return unknown('invalid-version')
      const latest = normalizeVersion(entry.version) ?? entry.version
      return order === 1
        ? { state: 'available', latest, installable: entry.asset !== undefined && entry.sha256 !== undefined }
        : { state: 'up-to-date', latest }
    }
  }
}
