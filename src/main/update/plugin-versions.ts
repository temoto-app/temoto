/**
 * TODO 1144 stage 1 (wave 72 bundle C, ARCHITECTURE 8.5.1): holds the extension version table (`plugins.json`) of the latest Release.
 * Does not depend on electron (`ipc.ts` rides it on the main app's update check, and `index.ts` hooks it to re-sending the plugin list).
 *
 * - It fetches only after the main app's update check (`UpdateService.runCheck`) has resolved the latest tag. It has no schedule of its own.
 *   If the version table for the same tag was already fetched, it is not fetched again (assets are not downloaded on every 6-hourly check).
 * - The fetch is the same as for the main zip: with the user's `gh`, take `plugins.json` and `SHA256SUMS` into a temporary directory,
 *   and read it only after matching its SHA-256 against `SHA256SUMS` (the same verification as "how it is placed" in 8.5; stage 2 uses the same entry point when fetching plugin contents).
 * - If a check fails, the previously read version table is kept (like the main app's `latest`, it keeps showing "the latest known").
 * - Stage 2 (wave 73 bundle C): "update" (`update`) of one extension. The job itself of fetching, verifying, and replacing the version-table row's asset is in
 *   `plugin-install.ts`; this file holds the "updating / failed" state and layers it onto the version-table matching (`updateOf`).
 * - Stage 3 (wave 74): bulk "update all" (`updateAll`). Updatable extensions are put one at a time through the same path as `update`;
 *   if one fails the rest continue, and the results are returned per extension. The main app's version is untouched.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log } from '../../common/logger.js'
import { parseReason, reasonError, type ReasonCode } from '@shared/reason.js'
import {
  PLUGIN_VERSIONS_ASSET,
  parsePluginVersionTable,
  pluginUpdateOf,
  type PluginReleaseState,
  type PluginUpdateAllResult,
  type PluginUpdateInfo,
  type PluginVersionEntry,
  type PluginVersionTable
} from '@shared/plugin-update.js'
import type { UpdateUnsupportedReason } from '@shared/update.js'
import type { ReleaseSource } from './release-source.js'
import { checksumFor, sha256OfFile } from './stage.js'
import { checkSumsSignature, sumsAssetNames } from './sums-signature.js'

/** Result of the main app's check (`latestTag()`). */
export type ReleaseCheckResult = { readonly tag: string } | { readonly failure: ReasonCode }

/** The entry point that fetches the version table. Null if there is no asset (a Release from before the table was added); failures to fetch, mismatches, and unreadable files are exceptions with a reason code. */
export type PluginTableFetcher = (tag: string) => Promise<PluginVersionTable | null>

/** A version-table row that can be updated (a row that has both the asset and the SHA-256). */
export type InstallableEntry = PluginVersionEntry & { readonly asset: string; readonly sha256: string }

/** The job that replaces one extension's version (`installPluginRelease` in `plugin-install.ts`). A failure is an exception with a reason code. */
export type PluginInstaller = (tag: string, id: string, entry: InstallableEntry) => Promise<void>

/** A row of the list (a copy of the plugin list main holds, not a renderer value). */
export type CatalogPlugin = { readonly id: string; readonly version: string; readonly bundled: boolean }

/** Upper bound on the version-table asset (there are a dozen or so bundled ones; a broken or oversized asset is not read to the end). */
const MAX_TABLE_BYTES = 256 * 1024

/**
 * Fetch the version table from the Release for `tag`. Asks together with `SHA256SUMS`; null if there is no version table (gh fetches only matching assets).
 * An exception if `SHA256SUMS` has no row, the value does not match, or the JSON is unreadable.
 */
export async function fetchPluginVersionTable(
  source: ReleaseSource,
  tag: string,
  workDir: () => string = () => mkdtempSync(join(tmpdir(), 'aios-plugin-versions-'))
): Promise<PluginVersionTable | null> {
  const dir = workDir()
  try {
    await source.download(tag, [PLUGIN_VERSIONS_ASSET, ...sumsAssetNames()], dir)
    const tablePath = join(dir, PLUGIN_VERSIONS_ASSET)
    const sumsPath = join(dir, 'SHA256SUMS')
    if (!existsSync(tablePath)) return null
    if (!existsSync(sumsPath)) throw reasonError('update-download-failed')
    checkSumsSignature(dir)
    const expected = checksumFor(readFileSync(sumsPath, 'utf8'), PLUGIN_VERSIONS_ASSET)
    if (expected === null || (await sha256OfFile(tablePath)) !== expected) throw reasonError('update-checksum-mismatch')
    const bytes = readFileSync(tablePath)
    if (bytes.length > MAX_TABLE_BYTES) throw reasonError('update-check-failed')
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw reasonError('update-check-failed')
    }
    const table = parsePluginVersionTable(parsed)
    if (table === null) throw reasonError('update-check-failed')
    return table
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Whether it is a target of "update all" (has an update and an asset, or the previous update failed). Same condition as the renderer's `canUpdate`. */
function isUpdatable(info: PluginUpdateInfo): boolean {
  return (info.state === 'available' && info.installable) || info.state === 'failed'
}

function failureOf(err: unknown): ReasonCode {
  return parseReason(err instanceof Error ? err.message : String(err))?.code ?? 'update-check-failed'
}

/**
 * Whether an update looks the same (wave 72 review). Even if a new `{ kind: 'failed' }` is created on every failure, with the same reason code
 * the plugin list is not pushed again to all windows. `unsupported` is the same if the reason is the same. Tables count as equal only when identical.
 */
function sameState(a: PluginReleaseState, b: PluginReleaseState): boolean {
  if (a === b) return true
  if (a.kind === 'failed' && b.kind === 'failed') return a.failure === b.failure
  if (a.kind === 'unsupported' && b.kind === 'unsupported') return a.reason === b.reason
  if (a.kind === 'no-table' && b.kind === 'no-table') return a.tag === b.tag
  return a.kind === 'not-checked' && b.kind === 'not-checked'
}

export class PluginReleaseCatalog {
  private state: PluginReleaseState = { kind: 'not-checked' }
  /** The number of the most recently requested fetch. The result of an older fetch is dropped. */
  private generation = 0
  /** The fetch in progress (the tag and its completion). A repeat request for the same tag waits for it. */
  private inFlight: { readonly tag: string; readonly done: Promise<void> } | null = null
  /** Stage 2: extensions being updated (id -> the version being installed and the completion — a reason code on failure, null on success). A repeat request for the same id waits for it. */
  private readonly installing = new Map<string, { readonly latest: string; readonly done: Promise<ReasonCode | null> }>()
  /** Stage 3: the "update all" in progress. If pressed again, it waits for the same completion. */
  private updatingAll: Promise<readonly PluginUpdateAllResult[]> | null = null
  /** Stage 2: extensions whose last update failed (id -> that version and the reason). "Failed" is shown only while the same version is still "update available". */
  private readonly failures = new Map<string, { readonly latest: string; readonly failure: ReasonCode }>()

  constructor(private readonly onChanged: () => void) {}

  current(): PluginReleaseState {
    return this.state
  }

  /** The update state of one plugin (called by `PluginHost.summaryOf`). */
  updateOf(plugin: { readonly id: string; readonly version: string; readonly bundled: boolean }): PluginUpdateInfo {
    const base = pluginUpdateOf(plugin, this.state)
    if (!plugin.bundled) return base
    const running = this.installing.get(plugin.id)
    if (running !== undefined) return { state: 'updating', latest: running.latest }
    const failed = this.failures.get(plugin.id)
    // A row with no asset (`installable` is false) does not get a failure layered on (wave 73 review — showing "update again" would only reject).
    if (failed !== undefined && base.state === 'available' && base.installable && base.latest === failed.latest) {
      return { state: 'failed', latest: failed.latest, failure: failed.failure }
    }
    return base
  }

  /**
   * Stage 2: update one extension to the version in the latest version table (TODO 1144, 8.5.1). `plugin` is a row of the list main holds (after re-validating
   * the renderer's value). If it cannot be updated (not bundled, no version table, a row with no asset, the installed version is newer), it throws
   * `plugin-update-unavailable`. In a form that cannot run, `update-unsupported`. If an update for the same id is running, it waits for that.
   * Failures of fetching, verifying, and replacing are not thrown but carried in the "failed" state (reason code), like the main app's "check now".
   */
  update(plugin: CatalogPlugin, install: PluginInstaller): Promise<void> {
    return this.start(plugin, install).then(() => undefined)
  }

  /**
   * Stage 3: bulk "update all" (TODO 1144, 8.5.1). `plugins()` is the list main holds (the current versions on every call). The bundled extensions that were updatable
   * when it started (an asset exists under `available`, the previous update failed, or a single "update" is running) are put one at a time, in id order, through the same path as `update`
   * (never run concurrently — the reload `PluginHost.load` happens once per extension). If one fails the rest continue, and
   * the results are returned per extension. Once `closing()` is true the remaining ones are not started (and not included in the results). A repeat request while running waits for the same completion.
   * A form that cannot run throws `update-unsupported`. If nothing can be updated, an empty array.
   */
  updateAll(
    plugins: () => readonly CatalogPlugin[],
    install: PluginInstaller,
    closing: () => boolean = () => false
  ): Promise<readonly PluginUpdateAllResult[]> {
    if (this.updatingAll !== null) return this.updatingAll
    if (this.state.kind === 'unsupported') return Promise.reject(reasonError('update-unsupported'))
    const targets = plugins()
      // Include the ones where a single "update" is running (wait for it to finish and put it in the results).
      .filter((plugin) => plugin.bundled && (isUpdatable(this.updateOf(plugin)) || this.installing.has(plugin.id)))
      .map((plugin) => ({ id: plugin.id, from: plugin.version }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const run = async (): Promise<readonly PluginUpdateAllResult[]> => {
      const results: PluginUpdateAllResult[] = []
      for (const { id, from } of targets) {
        if (closing()) break
        // The previous extension's reload changes the list. Ask with the current row (the current version).
        const plugin = plugins().find((entry) => entry.id === id)
        const latest = plugin === undefined ? null : this.latestOf(this.updateOf(plugin))
        if (plugin !== undefined && latest === null && plugin.version !== from) {
          // Before its turn came, a separately pressed single "update" finished it (the version changed from when it started).
          results.push({ id, from, to: plugin.version, outcome: 'updated' })
          continue
        }
        if (plugin === undefined || latest === null) {
          results.push({ id, from: plugin?.version ?? from, to: null, outcome: 'failed', failure: 'plugin-update-unavailable' })
          continue
        }
        try {
          const failure = await this.start(plugin, install)
          results.push(
            failure === null
              ? { id, from: plugin.version, to: latest, outcome: 'updated' }
              : { id, from: plugin.version, to: latest, outcome: 'failed', failure }
          )
        } catch (err) {
          results.push({ id, from: plugin.version, to: latest, outcome: 'failed', failure: failureOf(err) })
        }
      }
      log.info('update.plugins.all', {
        updated: results.filter((result) => result.outcome === 'updated').length,
        failed: results.filter((result) => result.outcome === 'failed').length
      })
      return results
    }
    const done = run().finally(() => {
      this.updatingAll = null
    })
    this.updatingAll = done
    return done
  }

  /** The version an update is heading to (update available, updating, failed). Null otherwise. */
  private latestOf(info: PluginUpdateInfo): string | null {
    return info.state === 'available' || info.state === 'updating' || info.state === 'failed' ? info.latest : null
  }

  /** The body of `update`. Its completion is the reason code of a failure (null on success). Failing to start is an exception. */
  private start(plugin: CatalogPlugin, install: PluginInstaller): Promise<ReasonCode | null> {
    const running = this.installing.get(plugin.id)
    if (running !== undefined) return running.done
    if (this.state.kind === 'unsupported') return Promise.reject(reasonError('update-unsupported'))
    const base = pluginUpdateOf(plugin, this.state)
    if (this.state.kind !== 'table' || base.state !== 'available') return Promise.reject(reasonError('plugin-update-unavailable'))
    const { tag } = this.state
    const entry = this.state.table.plugins[plugin.id]
    if (entry?.asset === undefined || entry.sha256 === undefined) return Promise.reject(reasonError('plugin-update-unavailable'))
    const installable: InstallableEntry = { ...entry, asset: entry.asset, sha256: entry.sha256 }
    const latest = base.latest
    let finish: (failure: ReasonCode | null) => void = () => undefined
    const done = new Promise<ReasonCode | null>((resolve) => (finish = resolve))
    // Put "updating" in first and then start (so "updating" also shows when the list is re-sent in the middle of replacing).
    this.installing.set(plugin.id, { latest, done })
    this.failures.delete(plugin.id)
    this.onChanged()
    void (async () => {
      let outcome: ReasonCode | null = null
      try {
        await install(tag, plugin.id, installable)
        log.info('update.plugin.installed', { pluginId: plugin.id, from: plugin.version, to: latest, tag })
      } catch (err) {
        outcome = failureOf(err)
        this.failures.set(plugin.id, { latest, failure: outcome })
        log.warn('update.plugin.failed', { pluginId: plugin.id, version: latest, code: outcome })
      } finally {
        this.installing.delete(plugin.id)
        this.onChanged()
        finish(outcome)
      }
    })()
    return done
  }

  /** The form where the main app's auto-update cannot run (`detectInstall` in 8.5). It is not checked afterwards. */
  setUnsupported(reason: UpdateUnsupportedReason): void {
    this.set({ kind: 'unsupported', reason })
  }

  /**
   * The main app's check finished. If the tag was resolved, fetch that tag's version table unless it is already held. On failure, keep the previously read
   * version table, and if there is none, set "cannot check". The return value is the completion of the fetch (tests wait on it).
   *
   * A repeat request while a fetch for the same tag is running does not start a new fetch but waits for the running one (wave 72 review).
   * A failed check does not discard a fetch in progress (if it succeeds the table is adopted). It is discarded only when a fetch for a different tag starts later.
   */
  releaseChecked(result: ReleaseCheckResult, fetch: PluginTableFetcher): Promise<void> {
    if (this.state.kind === 'unsupported') return Promise.resolve()
    if ('failure' in result) {
      if (this.state.kind !== 'table' && this.state.kind !== 'no-table') this.set({ kind: 'failed', failure: result.failure })
      return Promise.resolve()
    }
    const { tag } = result
    if ((this.state.kind === 'table' || this.state.kind === 'no-table') && this.state.tag === tag) return Promise.resolve()
    if (this.inFlight !== null && this.inFlight.tag === tag) return this.inFlight.done
    const generation = ++this.generation
    const done = this.fetchTable(tag, generation, fetch)
    this.inFlight = { tag, done }
    return done
  }

  private async fetchTable(tag: string, generation: number, fetch: PluginTableFetcher): Promise<void> {
    let next: PluginReleaseState
    try {
      const table = await fetch(tag)
      next = table === null ? { kind: 'no-table', tag } : { kind: 'table', tag, table }
    } catch (err) {
      const failure = failureOf(err)
      log.warn('update.plugins.failed', { code: failure })
      next = this.state.kind === 'table' || this.state.kind === 'no-table' ? this.state : { kind: 'failed', failure }
    }
    if (generation !== this.generation) return
    this.inFlight = null
    if (this.state.kind === 'unsupported') return
    if (next.kind === 'table') log.info('update.plugins', { tag, plugins: Object.keys(next.table.plugins).length })
    this.set(next)
  }

  private set(next: PluginReleaseState): void {
    if (sameState(next, this.state)) return
    this.state = next
    // Do not notify after shutdown (12.9) — `onChanged` of the caller (`index.ts`) looks at `closingDown`.
    this.onChanged()
  }
}
