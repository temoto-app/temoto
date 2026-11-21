/**
 * Allow-list of external storage (ARCHITECTURE.md 4.4.2 "external storage", T4).
 *
 * Under `/Volumes` is excluded from scanning, indexing and reference by default, and **only the volumes explicitly allowed**
 * here are passed to `createMacosExclusions`'s `allowedVolumes` and become includes.
 *
 * - Stored in `app_settings` at `fs.allowedVolumes` (a JSON array). No migration is cut
 *   (TODO_PLAN 0.4). Elements are `{ path, label, volumeUuid | null, addedAt }`.
 * - The match condition is "the mount path matches, and if a UUID is remembered, the UUID also matches".
 *   A different disk mounted under the same name is not allowed.
 * - The UUID is the `VolumeUUID` of `diskutil info -plist <mount>`. If it cannot be obtained, it is null and
 *   only the path match applies. The call can be injected (swapped in tests).
 * - **An effective allowance** (`effectivePaths`) is one that "is in the settings, is currently mounted (a real directory,
 *   not a symlink), and passed the UUID check". An allowed volume that is not mounted
 *   stays among the scan roots but is not walked, and `removeStale` does not delete its rows either (it is not gone, just absent).
 */
import { execFile } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AppSettingsStore } from '../common/settings.js'
import { foldPath } from '../common/uri.js'
import { log, errorFields } from '../common/logger.js'
import { OS_TOOLS } from '../common/os/tools.js'
import { DEFAULT_VOLUMES_DIR, isVolumeMountPath } from '../common/exclusions.js'
import { FS_ALLOWED_VOLUMES, type AllowedVolume } from '../common/settings-keys.js'

/** The single source of truth for the element shape (`{ path, label, volumeUuid | null, addedAt }`) is `settings-keys.ts`. */
export type { AllowedVolume }

/**
 * The `app_settings` key. **The key string exists only in `src/common/settings-keys.ts`**
 * (TODO 85) — this is a re-export kept for compatibility with existing callers (including tests).
 */
export const SETTING_ALLOWED_VOLUMES = FS_ALLOWED_VOLUMES.key

export interface MountedVolume {
  readonly path: string
  readonly name: string
}

/** One row shown in the settings screen (main's internal shape. Converted to URIs when passed to the renderer). */
export interface VolumeState {
  readonly path: string
  readonly name: string
  readonly mounted: boolean
  readonly allowed: boolean
  /** It is allowed, but the UUID of the currently mounted disk differs (a different disk). */
  readonly uuidMismatch: boolean
}

export type UuidProbe = (mountPath: string) => Promise<string | null>

export interface VolumeRegistryOptions {
  /** For tests: replaces `/Volumes`. */
  readonly volumesDir?: string
  /** For tests: replaces `diskutil`. */
  readonly probeUuid?: UuidProbe
}

const DISKUTIL = OS_TOOLS.diskutil
const PROBE_TIMEOUT_MS = 5000

/**
 * Gets the VolumeUUID from `diskutil info -plist`. There is no need to interpret the whole plist
 * (just read the one `<string>` right after the key). Failure, timeout or no match gives null.
 */
export async function probeVolumeUuidWithDiskutil(mountPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      DISKUTIL,
      ['info', '-plist', mountPath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err !== null) {
          log.warn('fs.volume.uuid.failed', { path: mountPath, ...errorFields(err) })
          resolve(null)
          return
        }
        resolve(parseVolumeUuid(String(stdout)))
      }
    )
  })
}

/** Extracts `VolumeUUID` from plist text (a pure function, exported for tests). */
export function parseVolumeUuid(plist: string): string | null {
  const match = /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
  if (match === null) return null
  const value = match[1]?.trim() ?? ''
  return value === '' ? null : value
}

export class VolumeRegistry {
  readonly volumesDir: string
  private readonly probeUuid: UuidProbe
  /** Mount paths judged effective by the latest `refresh()` (folded → original path). */
  private effective = new Map<string, string>()
  /** Those with a UUID mismatch in the latest `refresh()` (folded). */
  private mismatched = new Set<string>()

  constructor(
    private readonly settings: AppSettingsStore,
    options: VolumeRegistryOptions = {}
  ) {
    this.volumesDir = options.volumesDir ?? DEFAULT_VOLUMES_DIR
    this.probeUuid = options.probeUuid ?? probeVolumeUuidWithDiskutil
  }

  /**
   * The allowances in the settings (broken elements are dropped by the table's `parse`). **Only the narrowing by this `volumesDir`
   * stays here** — `isVolumeMountPath` is knowledge of the index-kernel side's runtime directory, and
   * moving it to `src/common/` (the foundation shared by both sides) would break P1's boundary (see the comment in settings-keys.ts).
   */
  configured(): readonly AllowedVolume[] {
    return this.settings
      .readTyped(FS_ALLOWED_VOLUMES)
      .filter((v) => isVolumeMountPath(v.path, this.volumesDir))
  }

  configuredPaths(): readonly string[] {
    return this.configured().map((v) => v.path)
  }

  isConfigured(path: string): boolean {
    const folded = foldPath(path)
    return this.configured().some((v) => foldPath(v.path) === folded)
  }

  /**
   * The volumes mounted now. Does `lstat` directly under `volumesDir` and
   * **excludes symlinks** (allowing `/Volumes/Macintosh HD -> /` would
   * walk `/` a second time under another path).
   */
  listMounted(): readonly MountedVolume[] {
    let names: string[]
    try {
      names = readdirSync(this.volumesDir)
    } catch {
      return []
    }
    const mounted: MountedVolume[] = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      const path = join(this.volumesDir, name)
      try {
        const stats = lstatSync(path)
        if (!stats.isDirectory()) continue
      } catch {
        continue
      }
      mounted.push({ path, name })
    }
    mounted.sort((a, b) => foldPath(a.name).localeCompare(foldPath(b.name)))
    return mounted
  }

  /** Whether it is a mounted real directory (a symlink is not allowed). */
  isMounted(path: string): boolean {
    const folded = foldPath(path)
    return this.listMounted().some((v) => foldPath(v.path) === folded)
  }

  /**
   * Recomputes the effective allowances (at launch, and on every allow / revoke).
   * The UUID check calls `diskutil`, so it is async.
   */
  async refresh(): Promise<void> {
    const mounted = new Map(this.listMounted().map((v) => [foldPath(v.path), v.path]))
    const effective = new Map<string, string>()
    const mismatched = new Set<string>()
    for (const entry of this.configured()) {
      const key = foldPath(entry.path)
      const path = mounted.get(key)
      if (path === undefined) continue
      if (entry.volumeUuid !== null) {
        const uuid = await this.probeUuid(path)
        if (uuid === null || foldPath(uuid) !== foldPath(entry.volumeUuid)) {
          mismatched.add(key)
          log.warn('fs.volume.uuid.mismatch', { path, expected: entry.volumeUuid !== null })
          continue
        }
      }
      effective.set(key, path)
    }
    this.effective = effective
    this.mismatched = mismatched
  }

  /** Allowed volumes that were effective at the latest `refresh()`. Empty before `refresh()` (the safe side). */
  effectivePaths(): readonly string[] {
    return [...this.effective.values()]
  }

  isEffective(path: string): boolean {
    return this.effective.has(foldPath(path))
  }

  /** For the settings screen: the union of mounted and configured. */
  states(): readonly VolumeState[] {
    const mounted = this.listMounted()
    const configured = this.configured()
    const seen = new Set<string>()
    const out: VolumeState[] = []
    for (const v of mounted) {
      const key = foldPath(v.path)
      seen.add(key)
      const allowed = configured.some((c) => foldPath(c.path) === key)
      out.push({
        path: v.path,
        name: v.name,
        mounted: true,
        allowed,
        uuidMismatch: allowed && this.mismatched.has(key)
      })
    }
    for (const c of configured) {
      const key = foldPath(c.path)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ path: c.path, name: c.label, mounted: false, allowed: true, uuidMismatch: false })
    }
    return out
  }

  /**
   * Allows a volume. **Accepts only a mounted real directory** (to obtain the UUID on the spot).
   * If already allowed, it fetches the UUID again and overwrites.
   */
  async allow(path: string): Promise<AllowedVolume> {
    if (!isVolumeMountPath(path, this.volumesDir)) throw new Error('not-a-volume')
    if (!this.isMounted(path)) throw new Error('not-mounted')
    const volumeUuid = await this.probeUuid(path)
    const entry: AllowedVolume = {
      path,
      label: basename(path),
      volumeUuid,
      addedAt: Date.now()
    }
    const rest = this.configured().filter((v) => foldPath(v.path) !== foldPath(path))
    this.settings.writeTyped(FS_ALLOWED_VOLUMES, [...rest, entry])
    log.info('fs.volume.allowed', { path, hasUuid: volumeUuid !== null })
    await this.refresh()
    return entry
  }

  /** Revokes. false if it is not in the settings. */
  async disallow(path: string): Promise<boolean> {
    const before = this.configured()
    const rest = before.filter((v) => foldPath(v.path) !== foldPath(path))
    if (rest.length === before.length) return false
    this.settings.writeTyped(FS_ALLOWED_VOLUMES, rest)
    log.info('fs.volume.disallowed', { path })
    await this.refresh()
    return true
  }
}
