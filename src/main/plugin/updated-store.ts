/**
 * TODO 1144 stage 2 (wave 73 bundle C, ARCHITECTURE 8.5.1): the store for versions fetched by per-extension updates.
 *
 * The bundle is placed as is under `<userData>/plugin-updates/<id>/<x.y.z>/` (manifest.json directly inside). The bundled app bundle
 * (`Resources/app/out/plugins/`) is not touched (the contents of the signed .app do not change). `PluginHost.load` compares the bundled
 * manifest's version with the version here and reads from here **only when this one is greater** (owner decision 2026-11-07). If an app update
 * makes the bundled one overtake (bundled >= here), the version here is deleted and it goes back to the bundled one.
 *
 * **The trust anchor is the record in the encrypted DB** (`plugins.updated`, the version and a digest of the contents). The store is a plaintext directory outside the DB,
 * so a version missing from the record or whose digest does not match is not read (so that a directory placed or rewritten from outside is not read with the same authority as a bundled one -
 * granting declared capabilities, activityBar). The digest is made from relative paths and each file's SHA-256 (`treeDigest`).
 *
 * Placement is the same as for the app's own versions (`src/main/update/stage.ts`): fetch, verify and extract inside `.staging-*` ->
 * move out to `<id>/<version>` with rename. Re-placing the same version is "move the old aside -> put the new in -> delete the old", and if it fails midway the old one is restored
 * (wave 73 review). Old versions are deleted keeping only "the latest one" (the version being read now) (`prune`; `resolve` also sweeps everything except the recorded version).
 *
 * The digest check is cached per (id, version) for the life of the process (wave 73 review): `PluginHost.load` re-reads all bundled ones at startup and at every update of one extension,
 * so the files of other extensions are not hashed every time. The cache is kept only when the check **matched**, and is forgotten when that version is re-placed or deleted. If the store is rewritten after startup,
 * it is not noticed until the next startup (the store is inside the user's userData, and only the user's process can write there).
 *
 * Stage 3 (wave 74): **a version read by this process is not deleted until the next startup** (`inUse`). Even after an extension is updated, a viewer that is still open
 * fetches lazily loaded chunks by the old version's URL (`aios-plugin://<id>/@<version>/...`), so the old version's directory is kept
 * (`sweep` / `prune` skip it). At the next startup `inUse` is empty, so everything except the recorded version is deleted by the cleanup in `resolve`.
 *
 * Independent of electron. Plugin code is neither read nor run (constraint 8).
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../../common/logger.js'
import type { UpdatedPluginRecord } from '../../common/settings-keys.js'
import { PLUGIN_ID_RE } from '@shared/plugin.js'
import { reasonError } from '@shared/reason.js'
import { compareVersions, normalizeVersion, PLAIN_VERSION_RE } from '@shared/update.js'

/** Prefix of an in-progress staging directory (`<root>/.staging-XXXXXX`). */
export const PLUGIN_STAGING_PREFIX = '.staging-'
/** An in-progress staging directory older than this is deleted as left over from a previous fetch that died midway. */
const STALE_STAGING_MS = 60 * 60 * 1000
/** Upper limit on the number of files when making the digest (the same as the extraction limit). */
const MAX_TREE_FILES = 5000

/** The answer of `resolve` (the directory and version to read instead of the bundled one). */
export type UpdatedPluginHit = { readonly dir: string; readonly version: string } | null

/** Reading and writing the record (`plugins.updated` of `app_settings`; replaced in tests). */
export interface UpdatedPluginRecords {
  read(): Readonly<Record<string, UpdatedPluginRecord>>
  write(records: Readonly<Record<string, UpdatedPluginRecord>>): void
}

/**
 * Digest of a directory's contents: the SHA-256 of `<path>\0<SHA-256>\n` lines in the order of relative paths (`/`-separated).
 * Throws (does not read) if there is a symlink or anything other than regular files and directories.
 */
export function treeDigest(dir: string): string {
  const files: string[] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel === '' ? name : `${rel}/${name}`
      const stat = lstatSync(join(dir, path))
      if (stat.isSymbolicLink()) throw new Error('symlink in plugin tree')
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) files.push(path)
      else throw new Error('special file in plugin tree')
      if (files.length > MAX_TREE_FILES) throw new Error('too many files in plugin tree')
    }
  }
  walk('')
  files.sort()
  const hash = createHash('sha256')
  for (const path of files) {
    const digest = createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')
    hash.update(`${path}\0${digest}\n`)
  }
  return hash.digest('hex')
}

export class UpdatedPluginStore {
  /** Versions whose digest was checked and matched (`<id>\0<version>` -> the matching digest). Kept for the life of the process (the note at the top). */
  private readonly verified = new Map<string, string>()
  /**
   * Stage 3: versions that `resolve` returned in this process (= that `PluginHost` read) (`<id>\0<version>`). So that a viewer left open can fetch
   * chunks from the previous version, they are not deleted by `sweep` / `prune` until the next startup (the note at the top).
   */
  private readonly inUse = new Set<string>()

  constructor(
    /** `<userData>/plugin-updates`. */
    readonly root: string,
    private readonly records: UpdatedPluginRecords
  ) {}

  /** The versions in `id`'s store (newest first, only directories that have manifest.json). */
  versionsOf(id: string): readonly string[] {
    return this.entriesOf(id)
      .filter((name) => PLAIN_VERSION_RE.test(name) && existsSync(join(this.root, id, name, 'manifest.json')))
      .sort((a, b) => compareVersions(b, a) ?? 0)
  }

  /**
   * The `resolve` for one `PluginHost.load`. The record (`plugins.updated`) is read **only once here**, and the returned function is called for each bundled
   * plugin (wave 73 review - the settings are not re-read for each plugin).
   */
  resolver(): (id: string, bundledVersion: string) => UpdatedPluginHit {
    const snapshot: Record<string, UpdatedPluginRecord> = { ...this.records.read() }
    return (id, bundledVersion) => this.resolveWith(snapshot, id, bundledVersion)
  }

  /** Look up just one (uses `resolver()` once). */
  resolve(id: string, bundledVersion: string): UpdatedPluginHit {
    return this.resolver()(id, bundledVersion)
  }

  /**
   * The directory to read instead of `id` at the bundled version `bundledVersion`. null if none (read the bundled one).
   * - Returned only when the recorded version is in the store, is greater than the bundled one, and the digest of its contents matches.
   * - If the bundled one caught up with or overtook the recorded version (an app update), that id's store and record are deleted.
   * - Stores of an id with no record (died midway through install, or placed from outside) and directories other than the recorded version (orphans, old versions)
   *   are deleted (wave 73 review). Nothing that is not read is left behind.
   */
  private resolveWith(records: Record<string, UpdatedPluginRecord>, id: string, bundledVersion: string): UpdatedPluginHit {
    // If the bundled version is not x.y.z, do not compare (do not touch the store).
    if (!PLUGIN_ID_RE.test(id) || normalizeVersion(bundledVersion) === null) return null
    const record = records[id]
    if (record === undefined) {
      if (this.entriesOf(id).length > 0) {
        log.info('plugin.updated.orphan', { pluginId: id })
        this.remove(records, id)
      }
      return null
    }
    const order = compareVersions(record.version, bundledVersion)
    if (order === null) return null
    if (order !== 1) {
      // An app update made the bundled one overtake (or equal) it. Go back to the bundled one and delete the version in the store.
      log.info('plugin.updated.superseded', { pluginId: id, version: record.version, bundled: bundledVersion })
      this.remove(records, id)
      return null
    }
    this.sweep(id, record.version)
    if (!this.versionsOf(id).includes(record.version)) {
      log.warn('plugin.updated.missing', { pluginId: id, version: record.version })
      return null
    }
    const dir = join(this.root, id, record.version)
    const key = verifiedKey(id, record.version)
    if (this.verified.get(key) === record.digest) {
      this.inUse.add(key)
      return { dir, version: record.version }
    }
    let digest: string
    try {
      digest = treeDigest(dir)
    } catch {
      log.warn('plugin.updated.unreadable', { pluginId: id, version: record.version })
      return null
    }
    if (digest !== record.digest) {
      log.warn('plugin.updated.tampered', { pluginId: id, version: record.version })
      return null
    }
    this.verified.set(key, digest)
    this.inUse.add(key)
    return { dir, version: record.version }
  }

  /** Create a staging directory (old in-progress ones are deleted). The caller deletes it when done. */
  createStaging(now: number = Date.now()): string {
    mkdirSync(this.root, { recursive: true })
    for (const name of readdirSync(this.root)) {
      if (!name.startsWith(PLUGIN_STAGING_PREFIX)) continue
      const path = join(this.root, name)
      try {
        if (now - lstatSync(path).mtimeMs >= STALE_STAGING_MS) rmSync(path, { recursive: true, force: true })
      } catch {
        // Gone or unreadable: next time.
      }
    }
    return mkdtempSync(join(this.root, PLUGIN_STAGING_PREFIX))
  }

  /**
   * Move a verified `staged` (an extracted bundle, an in-progress directory inside the store) out to `<id>/<version>` by rename, and record it.
   * Returns the directory it was placed in.
   *
   * If the same version already exists: "rename the old aside (`<staged>.replaced`, inside the in-progress directory) -> rename the new -> record -> delete the old".
   * If the new rename or writing the record fails, the old one is restored (wave 73 review - deleting the old first meant that a failure of the second rename
   * lost the verified copy while only the record remained).
   */
  install(id: string, version: string, staged: string): string {
    const normalized = normalizeVersion(version)
    if (!PLUGIN_ID_RE.test(id) || normalized === null) throw reasonError('plugin-update-invalid')
    let digest: string
    try {
      digest = treeDigest(staged)
    } catch {
      throw reasonError('plugin-update-invalid')
    }
    const parent = join(this.root, id)
    const target = join(parent, normalized)
    let aside: string | null = null
    try {
      mkdirSync(parent, { recursive: true })
      if (existsSync(target)) {
        aside = `${staged}.replaced`
        renameSync(target, aside)
      }
    } catch {
      throw reasonError('update-install-failed')
    }
    this.verified.delete(verifiedKey(id, normalized))
    try {
      renameSync(staged, target)
    } catch {
      this.putBack(id, aside, target)
      throw reasonError('update-install-failed')
    }
    try {
      this.records.write({ ...this.records.read(), [id]: { version: normalized, digest } })
    } catch {
      // The new contents do not match the record (for the same version the previous digest stays). Go back to the old one.
      rmSync(target, { recursive: true, force: true })
      this.putBack(id, aside, target)
      throw reasonError('update-install-failed')
    }
    if (aside !== null) rmSync(aside, { recursive: true, force: true })
    return target
  }

  /**
   * Delete the versions in `id`'s store other than the recorded one (the version being read now). Returns the deleted versions.
   * Stage 3: versions read in this process (a viewer left open may fetch chunks) are kept until the next startup.
   */
  prune(id: string): readonly string[] {
    const keep = this.records.read()[id]?.version
    const removed: string[] = []
    for (const version of this.versionsOf(id)) {
      if (version === keep || this.inUse.has(verifiedKey(id, version))) continue
      rmSync(join(this.root, id, version), { recursive: true, force: true })
      this.verified.delete(verifiedKey(id, version))
      removed.push(version)
    }
    return removed
  }

  /** Names directly under `<root>/<id>/` (empty if none). */
  private entriesOf(id: string): readonly string[] {
    if (!PLUGIN_ID_RE.test(id)) return []
    try {
      return readdirSync(join(this.root, id))
    } catch {
      return []
    }
  }

  /**
   * Delete everything directly under `<root>/<id>/` except `keep` (versions not in the record, half-written ones, old versions).
   * Stage 3: versions read in this process are kept (they are deleted by `resolve` at the next startup).
   */
  private sweep(id: string, keep: string): void {
    for (const name of this.entriesOf(id)) {
      if (name === keep || this.inUse.has(verifiedKey(id, name))) continue
      log.info('plugin.updated.orphan', { pluginId: id, version: PLAIN_VERSION_RE.test(name) ? name : null })
      try {
        rmSync(join(this.root, id, name), { recursive: true, force: true })
      } catch {
        // Cannot delete: it is not read, so no harm. Next time.
      }
      this.verified.delete(verifiedKey(id, name))
    }
  }

  /** Restore the old version moved aside (a failure of `install`). If it cannot be restored, only a warning (the next `resolve` finds it "missing" and goes back to the bundled one). */
  private putBack(id: string, aside: string | null, target: string): void {
    if (aside === null) return
    try {
      renameSync(aside, target)
    } catch {
      log.warn('plugin.updated.restoreFailed', { pluginId: id })
    }
  }

  /** Delete `id`'s store and record (go back to the bundled one). Also remove it from `snapshot` (the copy made by `resolver`). */
  private remove(snapshot: Record<string, UpdatedPluginRecord>, id: string): void {
    rmSync(join(this.root, id), { recursive: true, force: true })
    for (const key of [...this.verified.keys()]) if (key.startsWith(`${id}\0`)) this.verified.delete(key)
    delete snapshot[id]
    const records = this.records.read()
    if (records[id] === undefined) return
    const next = { ...records }
    delete next[id]
    this.records.write(next)
  }
}

function verifiedKey(id: string, version: string): string {
  return `${id}\0${version}`
}
