/**
 * PluginHost - loading plugins, enable/disable, and managing the isolated process (7.1 / 7.2 / 7.8).
 *
 * **main never imports plugin code at all** (constraint 8). All it does here is
 * read manifests and start and connect to the plugin-host process.
 *
 * Isolation (7.8, measured in Phase 4):
 * - **`execArgv` of `utilityProcess.fork` has no effect.** It only
 *   shows up in `process.execArgv` and is not passed to Node's initialization, so the permission model is
 *   **passed through `NODE_OPTIONS`** (the same on Electron 44; wave 25 bundle H, TODO 499).
 * - That NODE_OPTIONS is discarded by Electron, which regards the app as "packaged", unless the name of the Helper that runs the utility process is the default `Electron Helper*`.
 *   The distributed build has electron-builder rename the Helper, so
 *   `restoreElectronHelpers` in `scripts/release-config.mjs` restores the name. Whether it is in effect is reported by plugin-host
 *   in a `permission` frame before it loads plugins, and this side turns it into one `plugin.host.permission` line
 *   (warn if it is not in effect).
 * - What the Node permission model stops is fs / child_process / worker.
 *   **`net` is not stopped** (Node has no network permission).
 *   Network restriction is carried only by the Broker's allowed-host check.
 * - The fs read that is allowed is only "that plugin's directory".
 *   `--allow-fs-read` is resolved by realpath, so a path through a symlink is not passed.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import type {
  CapabilityName,
  HostExportKind,
  HostExports,
  PluginDetail,
  PluginManifest,
  PluginPermission,
  PluginSummary,
  PluginToolDeclaration,
  ResolvedViewer,
  TransientPayloadKind,
  ViewerAssociationEntry,
  ViewerChoices
} from '@shared/plugin.js'
import { EXPLICIT_CONSENT_CAPABILITIES, PLUGIN_SCHEME, pluginViewerUrl } from '@shared/plugin.js'
import { pluginUpdateOf, type PluginUpdateInfo } from '@shared/plugin-update.js'
import { normalizeVersion } from '@shared/update.js'
import { reasonError } from '@shared/reason.js'
import type { SearchProviderDeclaration } from '@shared/plugin-search.js'
import { log, errorFields } from '../../common/logger.js'
import type { CapabilityBroker, PluginPolicy } from '../capability/broker.js'
import { credentialOwner, credentialUsableBy } from '../capability/credential-owner.js'
import {
  ManifestError,
  declaredCapabilities,
  hostEntryOf,
  iconFileOf,
  isDeclaredExport,
  missingExports,
  needsHost,
  readManifest,
  resolveEntry,
  type LoadedPlugin
} from './manifest.js'
import { buildHostEnv, permissionLogLine } from './host-env.js'
import { pluginToolFingerprint } from './tool-fingerprint.js'
import { pluginDirectoryIdentity } from './identity.js'
import { createRelay } from '../../common/log-relay.js'

/** Upper limit on how many times a crashed plugin is restarted (the "crash handling" of 7.8). */
const MAX_RESTARTS = 3
/** Interval between restarts. So that consecutive crashes do not eat CPU. */
const RESTART_DELAY_MS = 2000
/**
 * The default upper limit of `invoke` (TODO 573, owner decision: 30 seconds). Even if plugin code loops forever or returns
 * a Promise that never resolves, the caller (the viewer command IPC) is not made to wait forever. For long work the
 * caller passes its own limit.
 */
export const INVOKE_TIMEOUT_MS = 30_000
/**
 * If it does not crash for this long after `ready`, the crash count is reset to 0 (TODO 573). It used to
 * keep counting within one launch, so after 3 crashes it never restarted again, however many hours apart they were.
 */
export const CRASH_RESET_MS = 60_000
/** The default priority for viewer resolution. */
const DEFAULT_PRIORITY = 100
/**
 * Upper limit for waiting for a stopped process's `exit` (owner decision 2026-10-01). Shutdown (`stop`) waits for this before
 * moving on to the next step (closing the index process and the DB), so that a Broker request from a dying plugin does not
 * come to write after the DB is closed (12.9). If exceeded, it moves on without waiting (so that shutdown does not stall).
 */
const STOP_WAIT_MS = 2000

interface HostFrame {
  readonly id: number
  readonly kind: 'broker' | 'invoke' | 'result' | 'error' | 'ready' | 'permission'
  readonly payload?: unknown
}

interface Running {
  readonly process: UtilityProcess
  readonly pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  nextId: number
  /**
   * Waiting for the `ready` frame. Rejects if startup fails.
   * **`ensureRunning` always waits for this.** Registration happens before `ready`, so
   * this keeps a second request that arrives during startup from being thrown at an uninitialized process (review B-4).
   */
  readonly ready: Promise<void>
  readyResolve?: () => void
  readyReject?: (err: Error) => void
  /** A marker that we stopped it ourselves. `exit` does not count it as a crash, and it is not restarted (review B-7). */
  stopping: boolean
  /** Whether the `permission` frame (TODO 499) has already been logged. Only the first one (before plugins are loaded) is trusted. */
  permissionReported: boolean
  /** Resolves when `exit` arrives. `stopPlugin` waits for it (with an upper limit). */
  readonly exited: Promise<void>
  readonly markExited: () => void
  /** A timer that resets the crash count to 0 `CRASH_RESET_MS` after `ready`. Stopped by `exit` (TODO 573). */
  stableTimer?: ReturnType<typeof setTimeout>
}

/** One tool of an enabled plugin (TODO 847). */
export interface EnabledPluginTool {
  readonly pluginId: string
  /** The plugin's name appended to the tool's heading (`displayName` or `name`). */
  readonly pluginName: string
  readonly tool: PluginToolDeclaration
  /**
   * Capabilities that are declared, have no consent yet, and "need first-time consent" (TODO 848, `EXPLICIT_CONSENT_CAPABILITIES`).
   * If non-empty, the relay (`GatewayRequests.handlePluginTool`) asks in the approval inbox before calling, and records the consent if approved.
   */
  readonly pendingConsent?: readonly CapabilityName[]
  /** The scope of `pendingConsent` (`browser.hosts`). Shown in the approval inbox. */
  readonly consentTargets?: readonly string[]
  /**
   * TODO 1227: whether this is a tool of a bundled extension (`LoadedPlugin.bundled`, decided by where it was loaded from - not the manifest's self-report).
   * Looked at by the choke point of unattended read-only turns. Omitted means false (the strict side).
   */
  readonly bundled?: boolean
  /**
   * TODO 1227 (fix X): the fingerprint of the tool's declaration (`pluginToolFingerprint`). A trigger rule's permission is the pair of the name and this fingerprint, and the choke point
   * compares them at the time of use. Omitted means empty (matches no permission - the strict side).
   */
  readonly fingerprint?: string
  /**
   * TODO 1233: the extension's identity at the time the list was built (`identityOf`). When first-time consent (`pendingConsent`) is passed in the approval inbox,
   * it is recorded only if this value equals the current one (consent is not carried over to an extension whose contents were swapped after asking). Omitted is null (not recorded).
   */
  readonly identity?: string | null
}

/** One enabled plugin that shows a search section (TODO 896). */
export interface EnabledSearchProvider {
  readonly pluginId: string
  readonly declaration: SearchProviderDeclaration
  /** The scheme the plugin's viewer declares (lowercase, no `:`). Used to check where the result of `openWith: 'viewer'` opens. */
  readonly viewerSchemes: readonly string[]
}

export interface PluginHostDeps {
  readonly db: Database
  /** Location of bundled plugins (`out/plugins/`). */
  readonly bundledDir: string
  /** Location of user-installed plugins (`<userData>/plugins/`). */
  readonly userDir: string
  /** The plugin-host entry (`out/main/plugin-host.js`). */
  readonly hostEntry: string
  readonly broker: () => CapabilityBroker
  readonly onChanged: (plugins: readonly PluginSummary[]) => void
  /**
   * The per-extension viewer default (TODO 907, `ViewerAssociations.all`). Omitted = no table (existing tests).
   * Lowercase extension (no dot) -> plugin id.
   */
  readonly associations?: () => Readonly<Record<string, string>>
  /**
   * TODO 1144 stage 1: the update state of one plugin (matching against the version table of the latest Release, `PluginReleaseCatalog.updateOf`).
   * Omitted = not checked yet (existing tests).
   */
  readonly pluginUpdate?: (plugin: { readonly id: string; readonly version: string; readonly bundled: boolean }) => PluginUpdateInfo
  /**
   * TODO 1144 stage 2: the version placed by a per-extension update (`UpdatedPluginStore.resolver`). If a version greater than the bundled manifest's version
   * is in the location and matches the record, that directory is read in place of the bundled one. Omitted = no location (existing tests).
   * `resolver()` is called only once per `load()` (the record table is read only once, wave 73 review).
   */
  readonly updated?: {
    resolver(): UpdatedResolver
  }
  /**
   * TODO 1227 fix X (security review): the identity (`identityOf`) of an external extension changed - on recomputation after a reload, or
   * on recomputation just before starting plugin-host, it differed from the remembered value. Tells `TriggerService`, which turns trigger rules back to disabled.
   */
  readonly onIdentityChanged?: (pluginId: string) => void
  /**
   * TODO 1233: discards an external extension's directory on uninstall (`uninstall`). index.ts moves it to the trash
   * (`shell.trashItem`, restorable). Omitted = cannot uninstall (existing tests).
   */
  readonly removeDirectory?: (path: string) => Promise<void>
  /**
   * TODO 1233: erases the rows of an uninstalled extension that live outside PluginHost (trigger rules and waiting events, the `plugins.settings` values).
   * `uninstall` calls it inside the same DB transaction as its own rows (consent, enabled / disabled). If it throws, everything rolls back.
   * **It writes only DB rows** (wave 86 fix Y, code-review): it does not touch in-memory copies (the trigger queue) or notifications - they
   * could not be restored on a rollback. Those are done in `onPluginForgotten` after the commit.
   */
  readonly forgetPluginData?: (pluginId: string) => void
  /**
   * Wave 86 fix Y (code-review): called **after** the transaction that includes `forgetPluginData` has committed. Trims the in-memory copies (the trigger
   * queue) and notifies the screen. Even if it throws, the row deletion is already done, so only a log is left and the uninstall is treated as a success.
   */
  readonly onPluginForgotten?: (pluginId: string) => void
  /**
   * TODO 1237: erases the documents an uninstalled extension wrote to the index (an RPC to the index process; the only writer to the index is `IndexService` - constraint 8.1).
   * Called **after** the transaction that deletes the rows. If it fails (throws), the uninstall marker (`plugin_uninstall_pending`) is left and it is retried at the next launch.
   * Omitted = does nothing (existing tests).
   */
  readonly forgetPluginIndex?: (pluginId: string) => Promise<void>
}

/** TODO 1237: one row of `plugin_state`. `identity` is the extension's identity when it was decided (null for rows before migration 41). */
interface StateRow {
  readonly enabled: boolean
  readonly identity: string | null
}

/** TODO 1233: one consent row (per capability). `identity` is the extension's identity when it was decided (null for rows before migration 40). */
interface ConsentRecord {
  readonly capability: CapabilityName
  readonly granted: boolean
  readonly identity: string | null
}

/** TODO 1246: the key of the consent copy (capability + identity at the time of decision). Even for the same capability, each identity is a separate row (the same as the DB primary key). */
function consentKey(capability: string, identity: string | null): string {
  return `${identity ?? ''}\u0000${capability}`
}

/** TODO 1246: a row without an identity (before migration 40 / 41) is held as '' (the primary key is NOT NULL). */
function ownerColumn(identity: string | null): string {
  return identity ?? ''
}

const NO_CONSENTS: ReadonlySet<CapabilityName> = new Set<CapabilityName>()

/** From a bundled id and version, looks up the directory of the version placed by an update (the return value of `UpdatedPluginStore.resolver`). */
type UpdatedResolver = (id: string, bundledVersion: string) => { readonly dir: string; readonly version: string } | null

export class PluginHost {
  private readonly plugins = new Map<string, LoadedPlugin>()
  private readonly running = new Map<string, Running>()
  private readonly crashes = new Map<string, number>()
  private readonly enabledStatement: Statement
  private readonly consentStatement: Statement
  /**
   * Wave 89 automatic security review (TODO 1246): disabling and denying take effect on **all rows of that id (and capability) regardless of identity**.
   * Disabling / denying while the identity is not yet known wrote to the '' row, and when the computation finished, the pre-existing enabled / grant row for the current identity
   * won and the revocation vanished (on the opening side). Only enabling / granting is tied to an identity. The window where the identity is unknown exists only for external extensions,
   * so this is used only when an external one is operated on and does not reach the bundled row ('bundled') (so that a revocation of an external one in a launch where the bundled one cannot be read does not take away the bundled consent, 1233).
   */
  private readonly disableAllStatement: Statement
  /** TODO 1246 (wave 89 code-review): when the user enables an external extension, deletes the external rows other than the current identity (old identities, ''). */
  private readonly stateDropOtherOwnersStatement: Statement
  private readonly denyAllStatement: Statement
  /** TODO 1237 (wave 87 code-review): do not prepare every time (it is called per extension and per load). */
  private readonly stateSelectStatement: Statement
  private readonly stateAdoptBundledStatement: Statement
  private readonly stateAdoptIdentityStatement: Statement
  private readonly consentAdoptStatement: Statement
  private readonly consentDropLegacyStatement: Statement
  /**
   * TODO 1240: in a launch where the bundled one is back, deletes **only the permissive side** of the external identity's rows (rows written by an external one that claimed the same id in a launch where the bundled one could not be read)
   * (enabled rows, granted consents). Disabled rows and denied consents are kept - if they were deleted, in the next launch where the bundled one cannot be read, that external one would run
   * with the default enabled / undecided (fall to the closed side; wave 88 automatic security review). The kept rows do not affect the bundled one (the identity differs).
   */
  private readonly stateDropForeignStatement: Statement
  private readonly consentDropForeignStatement: Statement
  private readonly pendingStatement: Statement
  /** TODO 1237: whether the row stage (synchronous) of the previous launch's uninstall has been done at the head of the first `load()`. */
  private rowsSwept = false
  /** TODO 1237: the ids deleted in this launch's row stage (reflecting this in the in-memory copy is called by `sweepPendingUninstalls` after the commit). */
  private readonly sweptRows: string[] = []
  private enabled = new Set<string>()
  /**
   * TODO 1233: consent rows (plugin id -> capability -> what was decided + the identity at the time of decision). Only the `granted` of the row with the same identity as the current one (`identityOf`)
   * takes effect (`consentedOf`). It does not apply to something else that claims the same id or to an external extension whose contents changed (consent is asked again).
   */
  private consents = new Map<string, Map<string, ConsentRecord>>()
  /** TODO 1233: ids in the middle of uninstall (enabling, starting and writing consent are refused). */
  private readonly uninstalling = new Set<string>()
  /**
   * TODO 1237: external extensions whose disabled row's identity differs from now (something else with the same id, or an external extension whose contents changed). They are **kept disabled**
   * (the closed side, wave 87 automatic security review), and the extension detail shows "contents changed; re-enable if you want to use it" (`PluginDetail.enabledReset`).
   */
  private readonly stateReset = new Set<string>()
  /** App shutdown. From then on `ensureRunning` does not start anything (including reserved restarts). */
  private shutdown = false
  /**
   * TODO 1144 stage 3: (id, version) -> directory that has ever been loaded in this process. Looked up by delivery of `aios-plugin://<id>/@<version>/…`.
   * Even after an extension is updated, a viewer left open (opened with the previous version's URL) can get chunks from the previous version's directory.
   * Not removed (until the next launch. The previous version's directory itself is also kept by `UpdatedPluginStore` until the next launch, stage 3 of 8.5.1).
   */
  private readonly revisions = new Map<string, Map<string, string>>()
  /**
   * TODO 1227 (fix X): a copy of the external extension's identity (`pluginDirectoryIdentity`). Not discarded on reload (the previous value stays until recomputed), and
   * recomputed in `computeIdentities` and just before starting plugin-host (`ensureRunning`).
   */
  private readonly identities = new Map<string, { readonly dir: string; readonly identity: string | null }>()
  private identitiesComputed: Promise<void> = Promise.resolve()
  /** A plugin-host that is about to start (so that a second one is not started while waiting for the identity recomputation before starting). */
  private readonly starting = new Map<string, Promise<Running>>()

  constructor(private readonly deps: PluginHostDeps) {
    this.enabledStatement = deps.db.prepare(`
      INSERT INTO plugin_state (plugin_id, enabled, updated_at, owner_identity) VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id, owner_identity) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    `)
    this.consentStatement = deps.db.prepare(`
      INSERT INTO plugin_consents (plugin_id, capability, decision, at, owner_identity) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, capability, owner_identity) DO UPDATE SET decision = excluded.decision, at = excluded.at
    `)
    this.disableAllStatement = deps.db.prepare(`UPDATE plugin_state SET enabled = 0, updated_at = ? WHERE plugin_id = ? AND owner_identity != 'bundled'`)
    this.stateDropOtherOwnersStatement = deps.db.prepare(
      `DELETE FROM plugin_state WHERE plugin_id = ? AND owner_identity != 'bundled' AND owner_identity != ?`
    )
    this.denyAllStatement = deps.db.prepare(
      `UPDATE plugin_consents SET decision = 'denied', at = ? WHERE plugin_id = ? AND capability = ? AND owner_identity != 'bundled'`
    )
    this.stateSelectStatement = deps.db.prepare(`SELECT enabled, owner_identity FROM plugin_state WHERE plugin_id = ?`)
    this.stateAdoptBundledStatement = deps.db.prepare(
      `UPDATE plugin_state SET owner_identity = 'bundled' WHERE plugin_id = ? AND owner_identity = ''`
    )
    this.stateAdoptIdentityStatement = deps.db.prepare(
      `UPDATE plugin_state SET owner_identity = ? WHERE plugin_id = ? AND owner_identity = ''`
    )
    this.pendingStatement = deps.db.prepare(`SELECT 1 FROM plugin_uninstall_pending WHERE plugin_id = ?`)
    this.stateDropForeignStatement = deps.db.prepare(
      `DELETE FROM plugin_state WHERE plugin_id = ? AND enabled = 1 AND owner_identity != '' AND owner_identity != 'bundled'`
    )
    this.consentDropForeignStatement = deps.db.prepare(
      `DELETE FROM plugin_consents WHERE plugin_id = ? AND capability = ? AND decision = 'granted' AND owner_identity = ? AND owner_identity != '' AND owner_identity != 'bundled'`
    )
    this.consentAdoptStatement = deps.db.prepare(
      // TODO 1246: if a 'bundled' row for the same capability already exists, do not add (OR IGNORE). The remaining unmarked row is deleted by `consentDropLegacyStatement`.
      `UPDATE OR IGNORE plugin_consents SET owner_identity = 'bundled' WHERE plugin_id = ? AND capability = ? AND owner_identity = ''`
    )
    this.consentDropLegacyStatement = deps.db.prepare(
      `DELETE FROM plugin_consents WHERE plugin_id = ? AND capability = ? AND owner_identity = ''`
    )
  }

  /** Loads bundled first, then user ones. For the same id, the one loaded later is discarded. */
  load(): void {
    // TODO 1237 (wave 87 code-review): the row stage of the previous launch's uninstall is done **before the rows are read (`restoreState`)** -
    // so the old consent / enabled state that was supposed to be deleted does not take effect, even for a moment, on an extension restored from the trash. Only the synchronous DB part (the index stage is `sweepPendingUninstalls`).
    if (!this.rowsSwept) {
      this.rowsSwept = true
      this.sweepPendingRows()
    }
    this.plugins.clear()
    // TODO 1144 stage 2: the record of versions placed by updates is read only once per load (wave 73 review).
    let resolveUpdated: UpdatedResolver | null = null
    try {
      resolveUpdated = this.deps.updated?.resolver() ?? null
    } catch (err) {
      log.warn('plugin.updated.failed', errorFields(err))
    }
    for (const [dir, bundled] of [
      [this.deps.bundledDir, true],
      [this.deps.userDir, false]
    ] as const) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        let full = join(dir, name)
        try {
          if (!statSync(full).isDirectory()) continue
          let manifest = readManifest(full)
          // TODO 1144 stage 2: for a bundled one, if the version placed by an update is greater, that is read (8.5.1). If it cannot be read, it stays bundled.
          if (bundled && !this.plugins.has(manifest.id)) {
            const replaced = resolveUpdated === null ? null : this.updatedOf(resolveUpdated, manifest)
            if (replaced !== null) {
              full = replaced.dir
              manifest = replaced.manifest
            }
          }
          if (this.plugins.has(manifest.id)) {
            log.warn('plugin.duplicate', { id: manifest.id })
            continue
          }
          const icon = iconFileOf(full, manifest)
          if (manifest.icon !== undefined && icon === null) log.warn('plugin.icon.invalid', { id: manifest.id })
          // Code-review of TODO 523: activityBar can be used only by bundled plugins (owner decision, ARCHITECTURE 7.2).
          // Even if an external plugin claims it, it is not shown in the summary and only a warning is left (the public SDK's consent mechanism is in 368).
          if (manifest.activityBar !== undefined && !bundled) log.warn('plugin.activityBar.ignored', { id: manifest.id })
          if (manifest.sidebarView !== undefined && !bundled) log.warn('plugin.sidebarView.ignored', { id: manifest.id })
          // TODO 896: the search section is also bundled only (owner decision 2026-10-31).
          if (manifest.searchProvider !== undefined && !bundled) log.warn('plugin.searchProvider.ignored', { id: manifest.id })
          // Wave 84 fix Z: the credentials in the table (Gmail / Bitbucket) belong only to the bundled owner. Even if an external plugin claims the owner's id
          // (which happens only when the bundled one is absent), loading continues and only that credential is removed by `policyOf` / `PluginAccounts`.
          if (!bundled && [...(manifest.capabilities.credentials?.oauth ?? []), ...(manifest.capabilities.credentials?.basic ?? [])].some((name) => credentialOwner(name) !== null)) {
            log.warn('plugin.credentials.ignored', { id: manifest.id })
          }
          this.plugins.set(manifest.id, { manifest, dir: full, bundled, icon })
          this.rememberRevision(manifest.id, manifest.version, full)
        } catch (err) {
          if (err instanceof ManifestError) log.warn('plugin.manifest.invalid', { dir: name, message: err.message })
          else log.warn('plugin.load.failed', { dir: name, ...errorFields(err) })
        }
      }
    }
    this.restoreState()
    log.info('plugin.loaded', { count: this.plugins.size })
    // TODO 1227 fix X: recompute the identities of external extensions (asynchronous; callers that need to wait - the trigger at startup - wait for `identitiesReady`).
    this.identitiesComputed = this.computeIdentities().catch((err: unknown) => log.warn('plugin.identity.failed', errorFields(err)))
  }

  /** TODO 1227 fix X: waits until the identity computation of the last `load()` finishes. */
  identitiesReady(): Promise<void> {
    return this.identitiesComputed
  }

  /**
   * TODO 1227 fix X: recomputes all external extensions' identities. If different from the previous value, `onIdentityChanged`. Copies for plugins that are not loaded are discarded.
   * At startup, it is waited for before opening the trigger intake (`src/main/index.ts`).
   */
  async computeIdentities(): Promise<void> {
    for (const id of [...this.identities.keys()]) {
      const plugin = this.plugins.get(id)
      if (plugin === undefined || plugin.bundled) this.identities.delete(id)
    }
    for (const [id, plugin] of [...this.plugins]) {
      if (plugin.bundled) continue
      await this.refreshIdentity(id, plugin)
    }
  }

  /**
   * Recomputes one and puts it in the copy. Notifies if there was a previous value and it differs. **Also distributes to the screen when decided for the first time** (wave 86 fix Y, code-review:
   * the consent of an external extension starts to take effect at the first computation right after startup, and without redistributing, the extension detail would stay at "no consent" and could make the user consent again).
   * Returns the computed value.
   */
  private async refreshIdentity(pluginId: string, plugin: LoadedPlugin): Promise<string | null> {
    const identity = await pluginDirectoryIdentity(plugin.dir)
    // If it was reloaded during the computation (became a different directory), do not put it.
    if (this.plugins.get(pluginId)?.dir !== plugin.dir) return null
    const before = this.identities.get(pluginId)
    this.identities.set(pluginId, { dir: plugin.dir, identity })
    if (identity === null) log.warn('plugin.identity.unavailable', { pluginId })
    // TODO 1237: an enabled / disabled row takes effect only when it has the same identity as now. If different, it returns to the default (re-fetched here for both the closing side and the opening side).
    const stateChanged = this.reapplyState(pluginId, plugin)
    if (before !== undefined && (before.dir !== plugin.dir || before.identity !== identity)) {
      log.warn('plugin.identity.changed', { pluginId })
      this.deps.onIdentityChanged?.(pluginId)
      // TODO 1233: consent decided under the previous identity no longer takes effect (`consentedOf`). Redistribute the current state to the extension detail's "Permissions".
      if (!this.shutdown) this.deps.onChanged(this.summaries())
    } else if ((before === undefined && identity !== null || stateChanged) && !this.shutdown) {
      // Decided for the first time: matching against rules (`onIdentityChanged`) is handled by `identitiesReady` at startup, so it is not called.
      // How consent looks may change (null -> the current value), so only the screen is notified. If it cannot be read (stays null), how it looks does not change.
      this.deps.onChanged(this.summaries())
    }
    return identity
  }

  /** TODO 1144 stage 3: remembers the directory of a loaded (id, version) (looked up by `revisionDirectoryOf`). */
  private rememberRevision(id: string, version: string, dir: string): void {
    const byVersion = this.revisions.get(id) ?? new Map<string, string>()
    byVersion.set(version, dir)
    this.revisions.set(id, byVersion)
  }

  /** The version placed by an update, read in place of the bundled `bundledManifest` (TODO 1144 stage 2). null if absent or not matching. */
  private updatedOf(
    resolve: UpdatedResolver,
    bundledManifest: PluginManifest
  ): { readonly dir: string; readonly manifest: PluginManifest } | null {
    try {
      const hit = resolve(bundledManifest.id, bundledManifest.version)
      if (hit === null) return null
      const manifest = readManifest(hit.dir)
      // If the manifest in the location claims a different id or version, it is not read (even if the record and the contents match, this guards against mix-ups).
      if (manifest.id !== bundledManifest.id || normalizeVersion(manifest.version) !== hit.version) {
        log.warn('plugin.updated.mismatch', { pluginId: bundledManifest.id })
        return null
      }
      log.info('plugin.updated.loaded', { pluginId: manifest.id, version: hit.version, bundled: bundledManifest.version })
      return { dir: hit.dir, manifest }
    } catch (err) {
      log.warn('plugin.updated.failed', { pluginId: bundledManifest.id, ...errorFields(err) })
      return null
    }
  }

  /**
   * TODO 1144 stage 2: reload after one extension was switched to the version placed by an update. Like disabling (`setEnabled(false)`),
   * that plugin-host is stopped and the manifest is re-read - from the next call and the next viewer opened, it is the new version. Open viewers are
   * not closed (they keep the code already loaded; reopening gives the new version). Other extensions' processes are not touched.
   * `load()` re-resolves all the bundled ones, but the summaries of other extensions' locations are served from an already verified cache and are not hashed again
   * (the top of `UpdatedPluginStore`, wave 73 review).
   */
  async reloadAfterUpdate(pluginId: string): Promise<void> {
    // If shutdown has begun, do not reload (`load` writes to the DB. 12.9 - the location's version is read at the next launch).
    if (this.shutdown) return
    await this.stopPlugin(pluginId)
    if (this.shutdown) return
    this.crashes.delete(pluginId)
    this.load()
    this.deps.onChanged(this.summaries())
  }

  private restoreState(): void {
    this.enabled = new Set<string>()
    this.stateReset.clear()
    for (const [id, plugin] of this.plugins) {
      // **Only the last fallback (aios.text) is always enabled** (TODO 460 revised 12.9). Other built-in ones can be disabled individually -
      // as long as the fallback remains, any file can be opened at least by it ("nothing can be opened at all" does not happen).
      if (isRequiredPlugin(plugin)) {
        this.enabled.add(id)
        continue
      }
      // TODO 523: a bundled plugin in `DEFAULT_DISABLED_PLUGIN_IDS` that the user has never chosen about
      // is, as an exception to "bundled = enabled by default" (the form of the line above), given a disabled row only at the first launch.
      // After that the row exists, so this branch is never taken again (it is deleted) - it can be enabled at any time in the extension view (as in 460).
      // `plugin.bundled` is also checked (a code-review fix): an external plugin claiming the same id is not a target.
      // TODO 1237: a row takes effect only when it has the same identity as now (`appliedState`). If no row takes effect, the default (enabled).
      const applied = this.appliedState(id, plugin)
      if (applied === null && plugin.bundled && DEFAULT_DISABLED_PLUGIN_IDS.has(id)) {
        this.enabledStatement.run(id, 0, Date.now(), 'bundled')
        continue
      }
      if (applied !== false) this.enabled.add(id)
    }

    const consentRows = this.deps.db
      .prepare(`SELECT plugin_id, capability, decision, owner_identity FROM plugin_consents`)
      .all() as { plugin_id: string; capability: string; decision: string; owner_identity: string | null }[]
    this.consents = new Map()
    const adopt = this.consentAdoptStatement
    for (const row of consentRows) {
      if (row.decision !== 'granted' && row.decision !== 'denied') continue
      // TODO 1246: '' is a row from before migration 40 (no identity) - null in memory.
      let identity: string | null = row.owner_identity === '' ? null : row.owner_identity
      // TODO 1233: for a row from before migration 40 (no identity), if it is bundled now, that value is added (bundled is decided by location).
      // Old rows of an external extension are not added - it is unknown whether that row was decided for the contents just loaded (consent is asked again).
      // TODO 1246: if a 'bundled' row for the same capability already exists, it cannot be added (that row is the authority) - the old row is just discarded.
      if (identity === null && this.plugins.get(row.plugin_id)?.bundled === true) {
        if (!this.shutdown && !this.uninstalling.has(row.plugin_id)) {
          const adopted = adopt.run(row.plugin_id, row.capability).changes
          this.consentDropLegacyStatement.run(row.plugin_id, row.capability)
          if (adopted === 0) continue
        }
        identity = 'bundled'
      }
      // TODO 1240: in a launch where the bundled one is back, consent of an external identity is not applied to the bundled one (bundled consent is only the 'bundled' row). Only grant rows are deleted,
      // and deny rows are kept (the closed side. So that in the next launch where the bundled one cannot be read, that external one does not return to undecided).
      if (identity !== null && identity !== 'bundled' && this.plugins.get(row.plugin_id)?.bundled === true) {
        if (row.decision === 'granted' && !this.shutdown && !this.uninstalling.has(row.plugin_id)) {
          this.consentDropForeignStatement.run(row.plugin_id, row.capability, row.owner_identity)
          log.info('plugin.consent.foreign.dropped', { pluginId: row.plugin_id })
        }
        continue
      }
      const records = this.consents.get(row.plugin_id) ?? new Map<string, ConsentRecord>()
      records.set(consentKey(row.capability, identity), { capability: row.capability as CapabilityName, granted: row.decision === 'granted', identity })
      this.consents.set(row.plugin_id, records)
    }
    // Bundled plugins are treated as consented at install time (12.9). Anything outside the declaration is still refused.
    // Only capabilities that were "never decided" are granted - ones the user revoked (`denied`) are not restored (TODO 1070).
    // TODO 1233: "decided" means only rows decided as bundled (`bundled`). Rows decided by an external extension that claimed the same id in a launch where the bundled one could not be read
    // are not counted (granted again with the bundled value. That row is the external extension's identity, so it does not apply to the bundled one anyway).
    // TODO 848: only `browser` (cookies of a logged-in Web view) is not pre-granted even for bundled - the user is asked the first time.
    const now = Date.now()
    for (const [id, plugin] of this.plugins) {
      if (!plugin.bundled) continue
      const records = this.consents.get(id) ?? new Map<string, ConsentRecord>()
      for (const capability of declaredCapabilities(plugin.manifest)) {
        if (EXPLICIT_CONSENT_CAPABILITIES.has(capability)) continue
        if (records.has(consentKey(capability, 'bundled'))) continue
        records.set(consentKey(capability, 'bundled'), { capability, granted: true, identity: 'bundled' })
        this.consentStatement.run(id, capability, 'granted', now, 'bundled')
      }
      this.consents.set(id, records)
    }
  }

  /** TODO 1246: `plugin_state` rows are per identity (several per id). */
  private stateRowsOf(pluginId: string): StateRow[] {
    const rows = this.stateSelectStatement.all(pluginId) as { enabled: number; owner_identity: string }[]
    return rows.map((row) => ({ enabled: row.enabled !== 0, identity: row.owner_identity === '' ? null : row.owner_identity }))
  }

  /**
   * TODO 1237 (ARCHITECTURE 7.2): whether a `plugin_state` row **applies to the current extension**. If it does, returns enabled / disabled; if not, null (default).
   * TODO 1246: rows are held **per identity** (primary key plugin_id + owner_identity). The bundled row and the external row are separate, and a write to one does not overwrite the other.
   * Only the row for the current identity is read.
   *  - Bundled: only the 'bundled' row applies. A row without an identity (before migration 41) is made to apply by adding 'bundled' only when there is no 'bundled' row.
   *    Rows of an external identity do not apply. **Only enabled rows are deleted**, disabled rows are kept (so that in the next launch where the bundled one cannot be read, that external one does not return to the default enabled).
   *  - External: only the row with the same identity as now applies. While the identity does not exist yet (before computation, unreadable), if there is even one disabled row it stays disabled
   *    (the closed side. When the computation finishes, `refreshIdentity` re-fetches), otherwise the default.
   *    A row without an identity is made to apply, only when disabled, by adding the current identity at the first computation (the closed side that keeps it disabled). An enabled row equals the default, so it is not made to apply.
   *  - If there is no row for the current identity and there is a **disabled** row of a different identity, it is made to apply as disabled (the closed side. So that an extension the user stopped does not
   *    return to enabled by itself through a swap of its contents - wave 87 automatic security review), and put into `stateReset` to show in the detail. An enabled row of a different identity equals the default, so null.
   *    When the user re-enables it, a row for the current identity is added (the previous row stays, and the current row wins).
   */
  private appliedState(pluginId: string, plugin: LoadedPlugin): boolean | null {
    this.stateReset.delete(pluginId)
    const rows = this.stateRowsOf(pluginId)
    if (rows.length === 0) return null
    if (plugin.bundled) {
      const own = rows.find((row) => row.identity === 'bundled')
      const legacy = rows.find((row) => row.identity === null)
      // TODO 1240: rows of an external identity = rows written by an external one that claimed the same id in a launch where the bundled one could not be read. They are not applied to the bundled one. Only enabled rows are deleted.
      // Not written after shutdown or in the middle of an uninstall.
      if (!this.shutdown && !this.uninstalling.has(pluginId) && rows.some((row) => row.enabled && row.identity !== null && row.identity !== 'bundled')) {
        this.stateDropForeignStatement.run(pluginId)
        log.info('plugin.state.foreign.dropped', { pluginId })
      }
      if (own !== undefined) return own.enabled
      if (legacy !== undefined) {
        this.stateAdoptBundledStatement.run(pluginId)
        return legacy.enabled
      }
      return null
    }
    // TODO 1249: exclude 'bundled' from the rows counted in the external decision. A row that disabled the bundled one must not keep an external one with the same id disabled
    // (while the bundled one is loaded the external one is not loaded - disabling the bundled one has nothing to do with the external one).
    const others = rows.filter((row) => row.identity !== 'bundled')
    const current = this.identityOf(pluginId)
    if (current === null) return others.some((row) => !row.enabled) ? false : null
    const own = rows.find((row) => row.identity === current)
    if (own !== undefined) return own.enabled
    const legacy = rows.find((row) => row.identity === null)
    if (legacy !== undefined && !legacy.enabled) {
      this.stateAdoptIdentityStatement.run(current, pluginId)
      return false
    }
    if (others.some((row) => row.identity !== null && !row.enabled)) {
      this.stateReset.add(pluginId)
      return false
    }
    return null
  }

  /**
   * TODO 1237: re-fetches the enabled / disabled state of an external extension whose identity was decided or changed. Returns true if it changed (if it became disabled, plugin-host is stopped).
   * Bundled ones, the last fallback, and ones in the middle of uninstall are not touched.
   */
  private reapplyState(pluginId: string, plugin: LoadedPlugin): boolean {
    if (plugin.bundled || isRequiredPlugin(plugin) || this.uninstalling.has(pluginId)) return false
    const before = this.stateReset.has(pluginId)
    const want = this.appliedState(pluginId, plugin) !== false
    let changed = before !== this.stateReset.has(pluginId)
    if (want !== this.enabled.has(pluginId)) {
      if (want) this.enabled.add(pluginId)
      else {
        this.enabled.delete(pluginId)
        void this.stopPlugin(pluginId)
      }
      changed = true
    }
    return changed
  }

  /**
   * TODO 1233: the consents currently in effect. **Only `granted` rows decided under the same identity as the current one (`identityOf`)** - the previous consent does not apply to
   * something else that claims the same id (an external extension in a launch where the bundled one could not be read, or something else that came in after a vanished external extension) or to an
   * external extension whose contents changed (including by an update). An external extension whose identity is not yet computed or cannot be read gets empty (the closed side).
   */
  private consentedOf(pluginId: string): ReadonlySet<CapabilityName> {
    const records = this.consents.get(pluginId)
    if (records === undefined) return NO_CONSENTS
    const identity = this.identityOf(pluginId)
    if (identity === null) return NO_CONSENTS
    const out = new Set<CapabilityName>()
    for (const record of records.values()) if (record.granted && record.identity === identity) out.add(record.capability)
    return out
  }

  /** The policy the Broker refers to. Only the declaration (upper bound) and consent are passed. */
  policyOf(pluginId: string): PluginPolicy | null {
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined || !this.enabled.has(pluginId)) return null
    const caps = plugin.manifest.capabilities
    return {
      id: pluginId,
      declared: {
        // Wave 84 fix Z: the names of credentials in the table are, by the owner's id, only when bundled (`credentialUsableBy`).
        credentials: [...(caps.credentials?.oauth ?? []), ...(caps.credentials?.basic ?? [])].filter((name) =>
          credentialUsableBy(name, { id: pluginId, bundled: plugin.bundled })
        ),
        networkHosts: caps.network?.hosts ?? [],
        fsRead: caps.fs?.read ?? [],
        fsWrite: caps.fs?.write ?? [],
        indexSources: caps.index?.write ?? [],
        ui: caps.ui !== undefined,
        uiStatus: caps.ui?.status === true,
        // TODO 1039: bundled plugins only (the same as activityBar).
        uiSidebar: caps.ui?.sidebar === true && plugin.bundled,
        browserHosts: caps.browser?.hosts ?? [],
        // TODO 1216: the ids of the declared triggers.
        triggers: (plugin.manifest.triggers ?? []).map((trigger) => trigger.id)
      },
      consented: this.consentedOf(pluginId)
    }
  }

  /** Whether it is a bundled plugin (TODO 850). Even if an external plugin claims the same id, the `bundled` of the side that was loaded is looked at. */
  isBundled(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.bundled === true
  }

  /**
   * TODO 1227 (fix X, security review): the identity of a loaded extension. A **fact of main that the extension cannot forge**:
   * for a bundled one it is `bundled` (decided by where it was loaded from - even if an external extension claims a bundled id, if the bundled one can be read it is discarded as `plugin.duplicate`),
   * and for an external one the SHA-256 of the **contents of the whole directory** (`pluginDirectoryIdentity`; plugin-host can read the whole directory, so a single entry point
   * would not be enough). The id, name, author and tool declarations can be claimed by the extension, so trigger rules (enabled state, tool permissions) are tied to this value, and if it differs
   * they go back to disabled (`TriggerService`). The value is a copy already computed (`computeIdentities` / recomputed just before starting), and it is null (nothing is allowed) if not yet computed,
   * unreadable, over the limit, or not loaded. For an external extension the value also changes on an update (the closed side).
   */
  identityOf(pluginId: string): string | null {
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined) return null
    if (plugin.bundled) return 'bundled'
    const cached = this.identities.get(pluginId)
    return cached !== undefined && cached.dir === plugin.dir ? cached.identity : null
  }

  /**
   * The tools shown to the model (TODO 847, 7.6.7). **Only for enabled plugins**, in id order. The gateway receives this only once at startup
   * (switching enabled / disabled takes effect from the next session - owner decision 2026-10-18).
   */
  enabledTools(): readonly EnabledPluginTool[] {
    const out: EnabledPluginTool[] = []
    const ids = [...this.plugins.keys()].sort()
    for (const id of ids) {
      const plugin = this.plugins.get(id)
      if (plugin === undefined || !this.enabled.has(id)) continue
      const manifest = plugin.manifest
      const consented = this.consentedOf(id)
      const pendingConsent = declaredCapabilities(manifest).filter(
        (capability) => EXPLICIT_CONSENT_CAPABILITIES.has(capability) && !consented.has(capability)
      )
      const identity = (manifest.mcp?.tools ?? []).length === 0 ? null : this.identityOf(id)
      for (const tool of manifest.mcp?.tools ?? []) {
        out.push({
          pluginId: id,
          pluginName: manifest.displayName ?? manifest.name,
          tool,
          pendingConsent,
          consentTargets: pendingConsent.includes('browser') ? (manifest.capabilities.browser?.hosts ?? []) : [],
          bundled: plugin.bundled,
          fingerprint: identity === null ? '' : pluginToolFingerprint(manifest, tool, identity),
          identity
        })
      }
    }
    return out
  }

  /**
   * Plugins that show a search section (TODO 896, 7.5.1). Only those that are **enabled, bundled, and declare `searchProvider`**, in id order.
   * The relay (`PluginSearchRelay`) re-fetches with this on every call (the section of a disabled or removed plugin is not called).
   */
  searchProviders(): readonly EnabledSearchProvider[] {
    const out: EnabledSearchProvider[] = []
    for (const id of [...this.plugins.keys()].sort()) {
      const plugin = this.plugins.get(id)
      const declaration = plugin?.manifest.searchProvider
      if (plugin === undefined || declaration === undefined || !plugin.bundled || !this.enabled.has(id)) continue
      out.push({
        pluginId: id,
        declaration,
        viewerSchemes: (plugin.manifest.viewer?.schemes ?? []).map((scheme) => scheme.toLowerCase())
      })
    }
    return out
  }

  /**
   * Whether that scheduled task can be called now (TODO 952 stage 1): the plugin is installed and enabled, and the manifest declares that task.
   * `JobScheduler` looks at this before a run whose time has come - if false, it waits rather than skipping (the row of a plugin that was merely disabled is kept).
   */
  hasTask(pluginId: string, taskId: string): boolean {
    const manifest = this.plugins.get(pluginId)?.manifest
    if (manifest === undefined || !this.enabled.has(pluginId)) return false
    return isDeclaredExport(manifest, 'task', taskId)
  }

  manifestOf(pluginId: string): PluginManifest | null {
    return this.plugins.get(pluginId)?.manifest ?? null
  }

  /** The plugin's directory. **Used only for serving `aios-plugin://`.** */
  directoryOf(pluginId: string): string | null {
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined || !this.enabled.has(pluginId)) return null
    return plugin.dir
  }

  /**
   * Serves only the icon even for a disabled plugin (TODO 524; the extension view shows icons for disabled rows too).
   * Returns the directory only when `relativePath` matches the manifest's icon (a relative path checked at load time).
   * Otherwise the same as `directoryOf` (null if disabled).
   */
  servingDirectoryOf(pluginId: string, relativePath: string, revision: string | null = null): string | null {
    if (revision !== null) return this.revisionDirectoryOf(pluginId, revision)
    const enabled = this.directoryOf(pluginId)
    if (enabled !== null) return enabled
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined || plugin.icon === null) return null
    return relativePath.split(sep).join('/') === plugin.icon ? plugin.dir : null
  }

  /**
   * TODO 1144 stage 3: the source of `aios-plugin://<id>/@<version>/…`. The current directory for the current version, and that directory for a version loaded earlier in this process
   * (the version before an update). null if the plugin is disabled or gone (the same as `directoryOf`, a disabled viewer is not served).
   */
  private revisionDirectoryOf(pluginId: string, revision: string): string | null {
    const current = this.directoryOf(pluginId)
    if (current === null) return null
    if (this.plugins.get(pluginId)?.manifest.version === revision) return current
    return this.revisions.get(pluginId)?.get(revision) ?? null
  }

  summaries(): readonly PluginSummary[] {
    const out: PluginSummary[] = []
    for (const [id, plugin] of this.plugins) out.push(this.summaryOf(id, plugin))
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  }

  private summaryOf(id: string, plugin: LoadedPlugin): PluginSummary {
    const running = this.running.get(id)
    const manifest = plugin.manifest
    const declared = declaredCapabilities(manifest)
    const consented = this.consentedOf(id)
    return {
      id,
      name: manifest.name,
      displayName: manifest.displayName ?? manifest.name,
      description: manifest.description ?? null,
      publisher: manifest.publisher ?? null,
      iconUrl: plugin.icon === null ? null : `${PLUGIN_SCHEME}//${id}/${plugin.icon.split('/').map(encodeURIComponent).join('/')}`,
      version: manifest.version,
      // Bundled plugins only (a code-review fix). Even if an external plugin claims it, it is not shown in the summary.
      activityBar:
        manifest.activityBar === undefined || !plugin.bundled
          ? null
          : {
              title: manifest.activityBar.title,
              openUrl: manifest.activityBar.openUrl,
              // TODO 721: a copy of the manifest. undefined if absent - the default ('web') is decided by the renderer (extensions.ts).
              openWith: manifest.activityBar.openWith
            },
      // TODO 1039: bundled plugins only.
      ...(manifest.sidebarView === undefined || !plugin.bundled ? {} : { sidebarView: { title: manifest.sidebarView.title } }),
      // TODO 896: bundled plugins only.
      ...(manifest.searchProvider === undefined || !plugin.bundled
        ? {}
        : {
            searchProvider: {
              title: manifest.searchProvider.title,
              ...(manifest.searchProvider.placeholder === undefined ? {} : { placeholder: manifest.searchProvider.placeholder }),
              openWith: manifest.searchProvider.openWith
            }
          }),
      bundled: plugin.bundled,
      required: isRequiredPlugin(plugin),
      enabled: this.enabled.has(id),
      capabilities: declared,
      consented: declared.filter((capability) => consented.has(capability)),
      hasViewer: manifest.viewer !== undefined,
      host: !needsHost(manifest)
        ? 'none'
        : running === undefined
          ? (this.crashes.get(id) ?? 0) > 0
            ? 'crashed'
            : 'stopped'
          : 'running',
      crashes: this.crashes.get(id) ?? 0,
      update: (this.deps.pluginUpdate ?? ((entry) => pluginUpdateOf(entry, { kind: 'not-checked' })))({
        id,
        version: manifest.version,
        bundled: plugin.bundled
      })
    }
  }

  /**
   * The extension view's detail (TODO 367). Copies contributions and permissions from the manifest, and adds the consent and the process state.
   * **Plugin code is not run** (no process is started either). The directory's location is not handed over.
   */
  detail(pluginId: string): PluginDetail | null {
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined) return null
    const summary = this.summaryOf(pluginId, plugin)
    const manifest = plugin.manifest
    const viewer = manifest.viewer
    const caps = manifest.capabilities
    const targetsOf = (capability: CapabilityName): PluginPermission['targets'] => {
      switch (capability) {
        case 'credentials':
          return [...(caps.credentials?.oauth ?? []), ...(caps.credentials?.basic ?? [])].map((value) => ({ mode: null, value }))
        case 'network':
          return (caps.network?.hosts ?? []).map((value) => ({ mode: null, value }))
        case 'fs':
          return [
            ...(caps.fs?.read ?? []).map((value) => ({ mode: 'read' as const, value })),
            ...(caps.fs?.write ?? []).map((value) => ({ mode: 'write' as const, value }))
          ]
        case 'index':
          return (caps.index?.write ?? []).map((value) => ({ mode: null, value }))
        case 'ui':
          return []
        case 'browser':
          return (caps.browser?.hosts ?? []).map((value) => ({ mode: null, value }))
        case 'triggers':
          // TODO 1216: the names of the declared triggers.
          return (manifest.triggers ?? []).map((trigger) => ({ mode: null, value: trigger.name }))
      }
    }
    return {
      summary,
      contributions: {
        viewer:
          viewer === undefined
            ? null
            : {
                extensions: viewer.extensions ?? [],
                schemes: viewer.schemes ?? [],
                payloads: viewer.payloads ?? [],
                editable: viewer.editable ?? false,
                priority: viewer.priority ?? DEFAULT_PRIORITY,
                fallback:
                  viewer.extensions === undefined &&
                  viewer.schemes === undefined &&
                  viewer.payloads === undefined
              },
        commands: (manifest.command?.commands ?? []).map((command) => ({
          id: command.id,
          title: command.title,
          sideEffect: command.sideEffect ?? false
        })),
        mcp: manifest.mcp !== undefined,
        indexer: manifest.indexer === undefined ? null : { interval: manifest.indexer.interval ?? null }
      },
      permissions: summary.capabilities.map((capability) => ({
        capability,
        consented: summary.consented.includes(capability),
        targets: targetsOf(capability)
      })),
      restartLimit: MAX_RESTARTS,
      enabledReset: this.stateReset.has(pluginId)
    }
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined) return
    // TODO 1233: do not enable while an uninstall is in progress (do not start from a directory that is being moved to the trash).
    if (enabled && this.uninstalling.has(pluginId)) return
    // Only the last fallback cannot be disabled (TODO 460, 12.9). Other built-in ones can be disabled.
    if (isRequiredPlugin(plugin) && !enabled) return
    if (enabled) this.enabled.add(pluginId)
    else {
      this.enabled.delete(pluginId)
      void this.stopPlugin(pluginId)
    }
    // TODO 1237: write together with the identity at the time of the decision (bundled is 'bundled', external is the current value - if not yet known, null; if disabled, it is tied to the current value at the first computation).
    this.stateReset.delete(pluginId)
    const now = Date.now()
    // Disabling applies to all rows (so that a disable made while the identity is unknown does not lose to the enabled row of the current identity after the computation).
    if (!enabled && !plugin.bundled) this.disableAllStatement.run(now, pluginId)
    // When an external one is explicitly enabled, delete past decisions for that id outside the bundled one (old identities, disabled '' rows) so that only the present intent remains. Otherwise, each time the contents change,
    // it would return to disabled because of an old disabled row. Bundled rows are not touched (when an external one is loaded, the bundled one with the same id is not loaded).
    // Wave 89 automatic security review: delete only when the identity is known. Deleting while it is unknown would also erase a past disable for contents (after a swap) that
    // the user has not seen yet. Even if enabled in the meantime, if a disabled row of a different identity remains, it stays disabled (an inconvenience on the closed side).
    const identityNow = this.identityOf(pluginId)
    if (enabled && !plugin.bundled && identityNow !== null) this.stateDropOtherOwnersStatement.run(pluginId, identityNow)
    this.enabledStatement.run(pluginId, enabled ? 1 : 0, now, ownerColumn(this.identityOf(pluginId)))
    this.deps.onChanged(this.summaries())
  }

  /**
   * Per-capability user consent (7.7). Can be revoked from the settings screen.
   * TODO 1233: consent is kept together with the **current extension identity** (`identityOf`) and takes effect only while the identity is the same (`consentedOf`). A grant
   * is made only for an extension that is loaded and whose identity can be read (if it cannot be read, a grant would not take effect, so it is not written). If `expectedIdentity` is passed
   * (the value at the time of asking in the approval inbox, `PluginToolRelay.grantConsent`), the grant is made only when it equals the current value - consent is not carried over to
   * contents that were swapped after asking. Revocation is accepted regardless of identity (the closed side). Returns true if a grant was recorded.
   */
  setConsent(pluginId: string, capability: CapabilityName, granted: boolean, expectedIdentity?: string | null): boolean {
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined || this.uninstalling.has(pluginId)) {
      log.warn('plugin.consent.unavailable', { pluginId, capability })
      return false
    }
    const identity = this.identityOf(pluginId)
    if (granted && (identity === null || (expectedIdentity !== undefined && expectedIdentity !== identity))) {
      log.warn('plugin.consent.unbound', { pluginId, capability, reason: identity === null ? 'unknown' : 'changed' })
      return false
    }
    const records = this.consents.get(pluginId) ?? new Map<string, ConsentRecord>()
    const now = Date.now()
    if (!granted && !plugin.bundled) {
      // A denial goes to the rows of all external identities (so that a denial made while the identity is unknown does not lose to the grant row of the current identity). Bundled rows are excluded.
      for (const [key, record] of records) {
        if (record.capability === capability && record.identity !== 'bundled') records.set(key, { ...record, granted: false })
      }
      this.denyAllStatement.run(now, pluginId, capability)
    }
    records.set(consentKey(capability, identity), { capability, granted, identity })
    this.consents.set(pluginId, records)
    this.consentStatement.run(pluginId, capability, granted ? 'granted' : 'denied', now, ownerColumn(identity))
    this.deps.onChanged(this.summaries())
    return granted
  }

  /**
   * Wave 86 fix Y (code-review): the toggle on the extension detail's "Permissions" (IPC `plugin:setConsent`). `setConsent` silently returned false without writing while the identity
   * was not yet known, so the toggle appeared to do nothing. Here:
   *  - For a grant when there is no identity yet, wait for the startup computation (`identitiesReady`), and if still none, recompute only this extension before writing.
   *    What it is tied to is the identity **at the time of writing** (`setConsent` re-fetches it synchronously), and no path writes without an identity (owner decision 2026-11-14).
   *  - If it still cannot be written, refuse with `plugin-consent-unbound` (the renderer shows the reason). An unknown id is `invalid-value`.
   */
  async setConsentByUser(pluginId: string, capability: CapabilityName, granted: boolean): Promise<void> {
    const clicked = this.plugins.get(pluginId)
    if (clicked === undefined) throw reasonError('invalid-value', { field: 'pluginId' })
    if (this.uninstalling.has(pluginId)) throw reasonError('plugin-consent-unbound')
    if (granted && this.identityOf(pluginId) === null) {
      await this.identitiesReady()
      const plugin = this.plugins.get(pluginId)
      if (plugin !== undefined && !plugin.bundled && this.identityOf(pluginId) === null && !this.shutdown) {
        await this.refreshIdentity(pluginId, plugin)
      }
      // If, while waiting, it became a different directory (swapped, uninstalled), it is not the extension that was clicked, so nothing is written.
      if (this.plugins.get(pluginId)?.dir !== clicked.dir) throw reasonError('plugin-consent-unbound')
    }
    if (this.shutdown) throw reasonError('plugin-consent-unbound')
    if (!this.plugins.has(pluginId)) throw reasonError('invalid-value', { field: 'pluginId' })
    const recorded = this.setConsent(pluginId, capability, granted)
    if (granted && !recorded) throw reasonError('plugin-consent-unbound')
  }

  /**
   * TODO 1233 (ARCHITECTURE 7.2): uninstalls an external extension (directly under the user's location `<userData>/plugins/`).
   * **Bundled ones cannot be removed** (`plugin-uninstall-bundled`, they can only be disabled - the same as VS Code's built-in extensions). The order:
   *  1. Set the in-progress marker (`uninstalling`), disable, and stop plugin-host (wait for one that is starting). While the marker is set, enabling, starting and writing consent are refused.
   *  2. Send the item directly under the location (only the link if it is a symlink) to `removeDirectory` (the trash). If it fails, nothing is deleted and it stays disabled, with `plugin-uninstall-failed`.
   *  3. Reload (`load`) - from then on that id is not in the list, so the writers of consent, rules and settings (`setConsent` / `TriggerService.updateRule` /
   *     `PluginSettingsStore.update`) all refuse.
   *  4. **After that**, delete the rows in one DB transaction: consent (`plugin_consents`), enabled / disabled (`plugin_state`), and `forgetPluginData`
   *     (trigger rules and waiting events, the `plugins.settings` values). Rows written between 2 and 3 are also deleted (there is no await between 2 and 4).
   * Even if restored from the trash there are no rows, so it starts with rules disabled and, for an external extension, no consent (asked again).
   */
  async uninstall(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined) throw reasonError('invalid-value', { field: 'pluginId' })
    if (plugin.bundled) throw reasonError('plugin-uninstall-bundled')
    const removeDirectory = this.deps.removeDirectory
    if (removeDirectory === undefined || this.shutdown) throw reasonError('plugin-uninstall-failed')
    // Only an item directly under the location (`load` builds it with `join(userDir, name)`. Checked just in case - nothing outside the location, nor the location itself, is deleted).
    const userDir = resolve(this.deps.userDir)
    const entry = resolve(plugin.dir)
    if (dirname(entry) !== userDir || entry === userDir) {
      log.warn('plugin.uninstall.outside', { pluginId })
      throw reasonError('plugin-uninstall-failed')
    }
    if (this.uninstalling.has(pluginId)) throw reasonError('plugin-uninstall-failed')
    this.uninstalling.add(pluginId)
    try {
      this.enabled.delete(pluginId)
      await this.starting.get(pluginId)?.catch(() => undefined)
      await this.stopPlugin(pluginId)
      try {
        await removeDirectory(entry)
      } catch (err) {
        log.warn('plugin.uninstall.failed', { pluginId, ...errorFields(err) })
        // Could not delete: the rows are kept and it stays disabled (the user meant to delete it).
        if (!this.shutdown) {
          this.disableAllStatement.run(Date.now(), pluginId)
          this.enabledStatement.run(pluginId, 0, Date.now(), ownerColumn(this.identityOf(pluginId)))
          this.deps.onChanged(this.summaries())
        }
        throw reasonError('plugin-uninstall-failed')
      }
      if (this.shutdown) return
      this.crashes.delete(pluginId)
      this.identities.delete(pluginId)
      this.load()
      // TODO 1237: the directory is already discarded. Leave the marker first so that, even if the transaction that deletes the rows fails, it can be cleaned up at the next launch
      // (when discarding fails nothing is deleted, so nothing is written before this point - a leftover marker never deletes the rows of a live extension).
      // Even if the marker cannot be written (the same DB, so the rows probably cannot be deleted either), continue - the same limit as before.
      try {
        this.deps.db.prepare(`INSERT OR REPLACE INTO plugin_uninstall_pending (plugin_id, at) VALUES (?, ?)`).run(pluginId, Date.now())
      } catch (err) {
        log.error('plugin.uninstall.pending.failed', { pluginId, ...errorFields(err) })
      }
      try {
        this.forgetRows(pluginId)
      } catch (err) {
        // The directory is already in the trash. If the rows remain, consent and rules take effect again under the same identity when it is restored from the trash. The marker remains,
        // so the next launch's `sweepPendingUninstalls` deletes them (a limit only until then, 7.2).
        log.error('plugin.uninstall.forget.failed', { pluginId, ...errorFields(err) })
        throw reasonError('plugin-uninstall-failed')
      } finally {
        // Reflect the deleted rows in the copy too (if the location has another directory with the same id, the one that appears on reload starts from a state where nothing has been decided).
        this.restoreState()
        this.deps.onChanged(this.summaries())
      }
      // Fix Y: only after the commit, reflect in the in-memory copy outside PluginHost (the trigger queue).
      try {
        this.deps.onPluginForgotten?.(pluginId)
      } catch (err) {
        log.warn('plugin.uninstall.after.failed', { pluginId, ...errorFields(err) })
      }
      // TODO 1237: documents the extension wrote to the index (index first, then the canonical copy). Even on failure, only the marker is left and the uninstall is treated as a success
      // (the extension is already gone. The next launch's `sweepPendingUninstalls` retries).
      await this.forgetIndexed(pluginId)
      log.info('plugin.uninstalled', { pluginId })
    } finally {
      this.uninstalling.delete(pluginId)
    }
  }

  /**
   * TODO 1237: deletes the DB rows of an uninstalled extension in one transaction: consent, enabled / disabled, and the scheduled-task state
   * (`plugin_task_state`), plus `forgetPluginData` (trigger rules and waiting events, the `plugins.settings` values). **The audit log is kept**
   * (a record of who allowed what and when; if deleted it could not be checked later). The same however many times it runs (used for retrying from the marker).
   */
  private forgetRows(pluginId: string): void {
    this.deps.db.transaction(() => {
      this.deps.db.prepare(`DELETE FROM plugin_consents WHERE plugin_id = ?`).run(pluginId)
      this.deps.db.prepare(`DELETE FROM plugin_state WHERE plugin_id = ?`).run(pluginId)
      this.deps.db.prepare(`DELETE FROM plugin_task_state WHERE plugin_id = ?`).run(pluginId)
      this.deps.forgetPluginData?.(pluginId)
      // The row stage is done (make the marker's `at` negative). From then on, retries are only for the documents in the index and the canonical copy. It is the same transaction, so there is no case where the rows are gone but the marker is still at the row stage.
      this.deps.db.prepare(`UPDATE plugin_uninstall_pending SET at = -ABS(at) WHERE plugin_id = ?`).run(pluginId)
    })()
  }

  /**
   * TODO 1237 (wave 87 automatic security review): whether this id has an uninstall marker remaining (either at the row stage or the index stage).
   * While it remains, documents of the previous extension may be in the index, so the Broker refuses index writes and deletes for that id.
   * Also the closed side (true) when it cannot be read (a DB failure).
   */
  indexClearing(pluginId: string): boolean {
    try {
      return this.pendingStatement.get(pluginId) !== undefined
    } catch (err) {
      log.warn('plugin.uninstall.pending.check.failed', { pluginId, ...errorFields(err) })
      return true
    }
  }

  /** TODO 1237: if the documents in the index could be deleted, remove the uninstall marker. If not, leave the marker (does not throw). */
  private async forgetIndexed(pluginId: string): Promise<void> {
    try {
      await this.deps.forgetPluginIndex?.(pluginId)
      if (this.shutdown) return
      this.deps.db.prepare(`DELETE FROM plugin_uninstall_pending WHERE plugin_id = ?`).run(pluginId)
    } catch (err) {
      log.warn('plugin.uninstall.index.failed', { pluginId, ...errorFields(err) })
    }
  }

  /**
   * TODO 1237: cleanup of the previous launch's uninstalls, the **row stage** (synchronous, once at the head of `load()`). The marker (`plugin_uninstall_pending`) has two stages:
   * `at > 0` means the row stage is not done, `at < 0` means the row stage is done (what remains is only the documents in the index and the canonical copy). This deletes the rows of ids whose marker has `at > 0`
   * (when `forgetRows` succeeds, the marker becomes `at < 0`). An extension restored from the trash is also treated as uninstalled, and its consent, rules and settings are not restored
   * (nothing is loaded yet, so old rows never take effect even for a moment - wave 87 code-review). The caller must make the trigger rules' entry point (`forgetPluginData`) usable before `load()`.
   */
  private sweepPendingRows(): void {
    let ids: string[]
    try {
      ids = (this.deps.db.prepare(`SELECT plugin_id FROM plugin_uninstall_pending WHERE at > 0 ORDER BY at`).all() as { plugin_id: string }[]).map(
        (row) => row.plugin_id
      )
    } catch (err) {
      log.warn('plugin.uninstall.sweep.failed', errorFields(err))
      return
    }
    for (const id of ids) {
      try {
        this.forgetRows(id)
        this.sweptRows.push(id)
        log.info('plugin.uninstall.swept', { pluginId: id })
      } catch (err) {
        log.error('plugin.uninstall.sweep.failed', { pluginId: id, ...errorFields(err) })
      }
    }
  }

  /**
   * TODO 1237: startup cleanup, the **index stage** (asynchronous, after `load()`). For ids whose marker has finished the row stage (`at < 0`), reflect in the in-memory copy
   * (only for what had its rows deleted in this launch), delete the documents in the index and the canonical copy, and remove the marker.
   * **It deletes even if an extension with that id is currently loaded** (wave 87 automatic security review): because something else claiming the same id (a different author, different contents) could
   * inherit and read the previous extension's documents. Documents written afterwards by an extension reinstalled in the same launch may also be deleted, but they are rewritten at the next sync (a limit).
   * The marker stays until deletion finishes, so `indexClearing` refuses index writes and deletes for that id.
   */
  async sweepPendingUninstalls(): Promise<void> {
    if (this.shutdown) return
    const swept = this.sweptRows.splice(0)
    if (swept.length > 0) {
      this.deps.onChanged(this.summaries())
      for (const id of swept) {
        try {
          this.deps.onPluginForgotten?.(id)
        } catch (err) {
          log.warn('plugin.uninstall.after.failed', { pluginId: id, ...errorFields(err) })
        }
      }
    }
    let ids: string[]
    try {
      ids = (this.deps.db.prepare(`SELECT plugin_id FROM plugin_uninstall_pending WHERE at < 0 ORDER BY at DESC`).all() as { plugin_id: string }[]).map(
        (row) => row.plugin_id
      )
    } catch (err) {
      log.warn('plugin.uninstall.sweep.failed', errorFields(err))
      return
    }
    for (const id of ids) {
      if (this.shutdown) return
      if (this.uninstalling.has(id)) continue
      await this.forgetIndexed(id)
    }
  }

  /**
   * Lines up the viewers that claim a URI in ascending order of priority (7.1 / TODO 907). Those that claim by extension or scheme,
   * and also the last fallback (`aios.text`, a viewer that declares no extension), are always candidates (VS Code's "Text Editor").
   */
  private viewerCandidates(uri: string): readonly { readonly plugin: LoadedPlugin; readonly resolved: ResolvedViewer }[] {
    const ext = extensionOf(uri)
    const scheme = uri.slice(0, Math.max(uri.indexOf(':'), 0))
    const plugins = [...this.plugins.values()]
      .filter(
        (plugin) =>
          this.enabled.has(plugin.manifest.id) &&
          plugin.manifest.viewer !== undefined &&
          // A viewer that claims only by kind of content (item 104) does not open URIs. It is not made the fallback either.
          // If it also declares `extensions` / `schemes`, URIs of those extensions are opened (TODO 901, `.diff` / `.patch` of `aios.diff`).
          (plugin.manifest.viewer.payloads === undefined ||
            plugin.manifest.viewer.extensions !== undefined ||
            plugin.manifest.viewer.schemes !== undefined)
      )
      .sort(
        (a, b) =>
          (a.manifest.viewer?.priority ?? DEFAULT_PRIORITY) -
          (b.manifest.viewer?.priority ?? DEFAULT_PRIORITY)
      )
    const out: { plugin: LoadedPlugin; resolved: ResolvedViewer }[] = []
    for (const plugin of plugins) {
      const viewer = plugin.manifest.viewer
      if (viewer === undefined) continue
      const byExt = viewer.extensions?.includes(ext) ?? false
      const byScheme = viewer.schemes?.includes(scheme) ?? false
      // A viewer with neither extensions nor schemes is the "last fallback" (aios.text).
      const fallback =
        viewer.extensions === undefined && viewer.schemes === undefined && viewer.payloads === undefined
      // A URI that is not a file (`thread://`, `https://`, ...) is opened only by a viewer that declares its scheme: no extension match and no fallback,
      // so nothing opens it as text and the read is not refused later by the Broker.
      if (scheme !== 'file' ? !byScheme : !byExt && !byScheme && !fallback) continue
      const editable = viewer.editable ?? false
      const delivery = viewer.delivery ?? (byExt && !editable ? 'url' : 'text')
      // Cell-value drafts (TODO 1212 stage 1) apply only when claiming by extension and receiving by URL.
      const cellEdits = byExt && delivery === 'url' && (viewer.cellEdits as readonly string[] | undefined)?.includes(ext) === true
      out.push({
        plugin,
        resolved: {
          pluginId: plugin.manifest.id,
          name: plugin.manifest.name,
          url: pluginViewerUrl(plugin.manifest.id, plugin.manifest.version, viewer.entry),
          editable,
          // A viewer that claims by extension and does not edit is given a URL instead of the body (review C-2).
          // No separate table such as `IMAGE_EXTS` is kept - the manifest knows which extension is accepted by whom.
          // It can be stated explicitly with the manifest's `viewer.delivery` (`aios.diff` receives the body as text). If omitted, the default above.
          // A viewer re-chosen as the fallback (`.patch` with `aios.text`, TODO 907) has byExt false, so it is text.
          delivery,
          ...(cellEdits ? { cellEdits: true } : {})
        }
      })
    }
    return out
  }

  /**
   * Resolves the viewer for a URI (7.1).
   * **The per-extension default (setting, TODO 907) is looked at first.** If that viewer is not among the candidates (the plugin is disabled, gone, or
   * no longer claims that extension), it silently falls to the normal selection = look in ascending order of priority, and the first that claims it.
   */
  resolveViewer(uri: string): ResolvedViewer | null {
    const candidates = this.viewerCandidates(uri)
    const associated = this.associatedPluginId(uri)
    if (associated !== null) {
      const hit = candidates.find((candidate) => candidate.resolved.pluginId === associated)
      if (hit !== undefined) return hit.resolved
    }
    return candidates[0]?.resolved ?? null
  }

  /**
   * The resolution result when opening this URI with the specified viewer (TODO 907). null if not among the candidates. Used by `ViewerBroker.read` to
   * see "which way of delivery applies to this plugin" using the viewer it was opened with, even after the default has changed.
   */
  resolveViewerWith(uri: string, pluginId: string): ResolvedViewer | null {
    return this.viewerCandidates(uri).find((candidate) => candidate.resolved.pluginId === pluginId)?.resolved ?? null
  }

  /** The candidates for "Open with another viewer" (TODO 907). Also used to re-validate a choice that came from the renderer. */
  viewerChoices(uri: string): ViewerChoices {
    const candidates = this.viewerCandidates(uri)
    const current = this.resolveViewer(uri)
    const associated = this.associatedPluginId(uri)
    return {
      ext: extensionOf(uri),
      choices: candidates.map((candidate, index) => ({
        pluginId: candidate.resolved.pluginId,
        name: candidate.plugin.manifest.displayName ?? candidate.plugin.manifest.name,
        editable: candidate.resolved.editable,
        builtinDefault: index === 0
      })),
      current: current?.pluginId ?? null,
      associated: associated !== null && candidates.some((candidate) => candidate.resolved.pluginId === associated)
    }
  }

  /** The list on the settings screen (TODO 907). For each extension in the table, whether that viewer is currently in effect. */
  viewerAssociationEntries(): readonly ViewerAssociationEntry[] {
    const table = this.deps.associations?.() ?? {}
    return Object.keys(table)
      .sort()
      .map((ext) => {
        const pluginId = table[ext] ?? ''
        const plugin = this.plugins.get(pluginId)
        const valid = this.viewerCandidates(`file:///x.${ext}`).some((candidate) => candidate.resolved.pluginId === pluginId)
        return {
          ext,
          pluginId,
          name: plugin === undefined ? pluginId : (plugin.manifest.displayName ?? plugin.manifest.name),
          valid
        }
      })
  }

  private associatedPluginId(uri: string): string | null {
    const ext = extensionOf(uri)
    if (ext === '') return null
    const table = this.deps.associations?.()
    if (table === undefined || !Object.hasOwn(table, ext)) return null
    return table[ext] ?? null
  }

  /**
   * Resolves the viewer for a temporary view that has no URI (item 104, `diff`). Only those that declare that kind in the manifest's
   * `viewer.payloads` claim it. No read permission is granted - the host passes the contents directly, so the viewer reads no file at all.
   */
  resolvePayloadViewer(kind: TransientPayloadKind): ResolvedViewer | null {
    const candidates = [...this.plugins.values()]
      .filter(
        (plugin) =>
          this.enabled.has(plugin.manifest.id) &&
          (plugin.manifest.viewer?.payloads?.includes(kind) ?? false)
      )
      .sort(
        (a, b) =>
          (a.manifest.viewer?.priority ?? DEFAULT_PRIORITY) -
          (b.manifest.viewer?.priority ?? DEFAULT_PRIORITY)
      )
    const plugin = candidates[0]
    const viewer = plugin?.manifest.viewer
    if (plugin === undefined || viewer === undefined) return null
    return {
      pluginId: plugin.manifest.id,
      name: plugin.manifest.name,
      url: pluginViewerUrl(plugin.manifest.id, plugin.manifest.version, viewer.entry),
      editable: false
    }
  }

  // ---- plugin-host process (7.8) ----

  private async ensureRunning(pluginId: string): Promise<Running> {
    if (this.shutdown) throw new Error('plugin host is shutting down')
    const existing = this.running.get(pluginId)
    if (existing !== undefined) {
      await existing.ready
      return existing
    }
    const pending = this.starting.get(pluginId)
    if (pending !== undefined) return pending
    const plugin = this.plugins.get(pluginId)
    if (plugin === undefined || !this.enabled.has(pluginId) || this.uninstalling.has(pluginId)) throw new Error('plugin not available')
    if (!needsHost(plugin.manifest)) throw new Error('plugin has no host entry')
    if (plugin.bundled) return this.startHost(pluginId, plugin)
    // TODO 1227 fix X (security review): an external extension has its identity recomputed just before starting (if different from the remembered value,
    // `onIdentityChanged` -> trigger rules go back to disabled. The copy is replaced with the new value, so tool permissions tied to the previous value do not pass either).
    // Starting itself is not stopped (human conversations and imports go on as usual).
    const started = (async (): Promise<Running> => {
      await this.refreshIdentity(pluginId, plugin)
      if (this.shutdown) throw new Error('plugin host is shutting down')
      const again = this.running.get(pluginId)
      if (again !== undefined) {
        await again.ready
        return again
      }
      const current = this.plugins.get(pluginId)
      if (current === undefined || current.dir !== plugin.dir || !this.enabled.has(pluginId) || this.uninstalling.has(pluginId)) {
        throw new Error('plugin not available')
      }
      return this.startHost(pluginId, current)
    })().finally(() => this.starting.delete(pluginId))
    this.starting.set(pluginId, started)
    return started
  }

  /** Starts the plugin-host child process and waits for `ready`. */
  private async startHost(pluginId: string, plugin: LoadedPlugin): Promise<Running> {
    // There is one entry point (review C-4). `command` / `mcp` / `indexer` are distinguished by exports of the same entry point.
    // Previously only the first entry of `command ?? mcp ?? indexer` was started, and an indexer written in a
    // separate file was never loaded.
    const declared = hostEntryOf(plugin.manifest)
    if (declared === null) throw new Error('plugin has no host entry')
    const entry = resolveEntry(plugin.dir, declared)
    // The permission model **judges by realpath**, so what is passed is also the realpath
    // (a path through a symlink does not match - hit in Phase 4).
    const allowPlugin = realpathSync.native(plugin.dir)
    // **Also make the plugin-host's own files readable.** If this is forgotten,
    // Node gets ERR_ACCESS_DENIED at the moment it reads the entry script, and it
    // dies before reaching the plugin's code (hit in Phase 4).
    const allowHost = realpathSync.native(dirname(this.deps.hostEntry))

    const child = utilityProcess.fork(this.deps.hostEntry, [entry], {
      serviceName: `aios-plugin-${pluginId}`,
      stdio: 'pipe',
      // **It does not work via execArgv** (measured in Phase 4). It only
      // shows up in `process.execArgv` and is not passed to Node's initialization, so it is passed through NODE_OPTIONS.
      // If the Helper is renamed, NODE_OPTIONS is also discarded (TODO 499; the distributed build has the names restored).
      // This is an extra defense, not a boundary (7.8). Do not spend time investigating ways around it.
      // main's environment is not passed except for the allow list, and paths are enclosed in quotes (`host-env.ts`).
      env: buildHostEnv(process.env, [allowHost, allowPlugin])
    })

    let readyResolve: (() => void) | undefined
    let readyReject: ((err: Error) => void) | undefined
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('plugin host timeout')), 10_000)
      readyResolve = () => {
        clearTimeout(timer)
        resolve()
      }
      readyReject = (err: Error) => {
        clearTimeout(timer)
        reject(err)
      }
    })
    let markExited = (): void => undefined
    const exited = new Promise<void>((resolve) => {
      markExited = resolve
    })
    const running: Running = {
      process: child,
      pending: new Map(),
      nextId: 1,
      ready,
      readyResolve,
      readyReject,
      stopping: false,
      permissionReported: false,
      exited,
      markExited
    }
    this.running.set(pluginId, running)

    child.stderr?.on('data', (chunk: Buffer) => {
      // A plugin's stderr **may contain values**, so it is not kept in full (log convention).
      // But if the reason it cannot start is unknown, there is nothing to be done,
      // so **only the first line** is kept, cut at 200 characters.
      const first = chunk.toString('utf8').split('\n')[0] ?? ''
      // `proc` is that plugin (TODO 376, 12.9.1). Even in the file, entries can be looked up per plugin.
      log.warn('plugin.stderr', { proc: `plugin:${pluginId}`, pluginId, bytes: chunk.byteLength, head: first.slice(0, 200) })
    })
    // stdout is also relayed (TODO 376). plugin-host's own structured log goes through here. The plugin code's
    // `console.log` also comes into the same entry point, so it is **not trusted**: a line that is not JSON is kept only by length, and values in JSON lines are also cut short.
    const stdout = createRelay({ proc: `plugin:${pluginId}`, fallback: 'info', trusted: false })
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stdout?.on('end', () => stdout.end())

    child.on('message', (raw: unknown) => {
      void this.onFrame(pluginId, running, raw as HostFrame)
    })

    child.on('exit', (code) => {
      running.markExited()
      if (running.stableTimer !== undefined) clearTimeout(running.stableTimer)
      // Do not let the old process's exit remove the registration of a new process started again after a stop.
      if (this.running.get(pluginId) === running) this.running.delete(pluginId)
      // If it dies during startup, tell the waiting side too (a no-op after ready).
      running.readyReject?.(new Error(`plugin host exited (${code})`))
      for (const waiter of running.pending.values()) waiter.reject(new Error('plugin host exited'))
      running.pending.clear()
      // A stop we did ourselves (disable / shutdown) is not a crash (review B-7).
      // The `code` when stopped with `kill()` was confirmed on a real machine (the Phase 4 section of the repository's development notes).
      if (code !== 0 && !running.stopping) {
        const count = (this.crashes.get(pluginId) ?? 0) + 1
        this.crashes.set(pluginId, count)
        log.warn('plugin.crashed', { pluginId, code, count })
        // **Do not spread to other plugins or the main app** (7.8). Restart up to the limit.
        if (count <= MAX_RESTARTS && this.enabled.has(pluginId) && !this.shutdown) {
          setTimeout(() => void this.ensureRunning(pluginId).catch(() => undefined), RESTART_DELAY_MS)
        }
      }
      this.deps.onChanged(this.summaries())
    })

    try {
      await ready
    } catch (err) {
      // TODO 1069: if startup fails by timeout or load failure, do not leave the child process that was started behind, but stop it
      // (the same steps as `stopPlugin`). This prevents a second one from being started by the next `ensureRunning`.
      // The kill and the `stopping` marker are set synchronously (`stopPlugin` is synchronous up to its first await). The wait for exit is
      // not done and the original error is returned immediately - even if the child ignores SIGTERM, the caller is not made to wait `STOP_WAIT_MS`.
      if (this.running.get(pluginId) === running) {
        this.stopPlugin(pluginId).catch((e: unknown) =>
          log.warn('plugin.stop.failed', { pluginId, error: e instanceof Error ? e.message : String(e) })
        )
      } else if (!running.stopping) running.process.kill()
      throw err
    }
    this.deps.onChanged(this.summaries())
    return running
  }

  private async onFrame(pluginId: string, running: Running, raw: HostFrame): Promise<void> {
    // plugin-host is a separate trust domain. The outer shape of the frame is also checked before reading (review A-3).
    if (!isHostFrame(raw)) {
      log.warn('plugin.frame.invalid', { pluginId })
      return
    }
    const frame = raw
    if (frame.kind === 'permission') {
      // TODO 499: trust only the one message plugin-host sends before loading the plugin (what comes later can be sent by the plugin).
      if (running.permissionReported) return
      running.permissionReported = true
      const line = permissionLogLine(pluginId, frame.payload)
      log[line.level](line.event, line.fields)
      return
    }
    if (frame.kind === 'ready') {
      const manifest = this.plugins.get(pluginId)?.manifest
      const exports = asHostExports(frame.payload)
      if (manifest !== undefined && exports !== null) {
        const missing = missingExports(manifest, exports)
        // A kind or command that is declared but not in the exports fails with `unknown` when called. Tell about it beforehand.
        if (missing.length > 0) log.warn('plugin.exports.missing', { pluginId, missing: missing.slice(0, 16).join(',') })
      }
      running.readyResolve?.()
      // If it does not crash for a while, reset the crash count to 0 (TODO 573, the same idea as `restarts` of `IndexClient`).
      if (running.stableTimer === undefined) {
        running.stableTimer = setTimeout(() => {
          running.stableTimer = undefined
          if (this.running.get(pluginId) !== running) return
          if ((this.crashes.get(pluginId) ?? 0) === 0) return
          this.crashes.delete(pluginId)
          log.info('plugin.crashes.reset', { pluginId })
          this.deps.onChanged(this.summaries())
        }, CRASH_RESET_MS)
        running.stableTimer.unref?.()
      }
      return
    }
    if (frame.kind === 'error' && frame.id === 0) {
      running.readyReject?.(new Error(String(frame.payload)))
      return
    }
    if (frame.kind === 'result' || frame.kind === 'error') {
      const waiter = running.pending.get(frame.id)
      if (waiter === undefined) return
      running.pending.delete(frame.id)
      if (frame.kind === 'result') waiter.resolve(frame.payload)
      else waiter.reject(new Error(String(frame.payload)))
      return
    }
    if (frame.kind === 'broker') {
      // **This is the trust boundary.** Requests from plugin-host must always go through the Broker.
      // Shape validation (zod) is also done at the Broker's entrance, and rejected ones are left in the audit as `invalid-request` (A-3).
      try {
        const result = await this.deps.broker().handleUntrusted(pluginId, frame.payload)
        running.process.postMessage({ id: frame.id, kind: 'result', payload: result })
      } catch (err) {
        running.process.postMessage({
          id: frame.id,
          kind: 'error',
          payload: err instanceof Error ? err.message : 'denied'
        })
      }
    }
  }

  /**
   * Calls a plugin's export (7.1, review C-4). Execution happens inside plugin-host.
   * `kind` is `command` (default) / `mcp` / `indexer`. **A kind or command that the manifest does not declare is
   * refused before the process is started** (an arbitrary name from the renderer / viewer is not let through).
   */
  async invoke(
    pluginId: string,
    command: string,
    arg: unknown,
    kind: HostExportKind = 'command',
    timeoutMs: number = INVOKE_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<unknown> {
    const manifest = this.plugins.get(pluginId)?.manifest
    if (manifest === undefined || !this.enabled.has(pluginId)) throw new Error('plugin not available')
    if (!isDeclaredExport(manifest, kind, command)) throw new Error('undeclared-export')
    // TODO 896: the search section is for bundled plugins only (even if an external plugin claims `searchProvider`, it is not called).
    if (kind === 'search' && this.plugins.get(pluginId)?.bundled !== true) throw new Error('plugin not available')
    if (signal?.aborted === true) throw new Error('plugin invoke aborted')
    const running = await this.ensureRunning(pluginId)
    const id = running.nextId++
    return new Promise((resolve, reject) => {
      // After the limit, reject and remove from `pending` (TODO 573). A late-arriving `result` is
      // not in `pending`, so `onFrame` discards it (the same shape as the RPC's `RpcPeer`).
      const timer = setTimeout(() => {
        if (!running.pending.delete(id)) return
        signal?.removeEventListener('abort', onAbort)
        log.warn('plugin.invoke.timeout', { pluginId, kind, command, ms: timeoutMs })
        reject(new Error('plugin invoke timeout'))
      }, timeoutMs)
      // Review 56-6: aborting at shutdown. Remove from `pending` without waiting for the limit (5 minutes for a scheduled task) (a late `result` is discarded).
      // The work inside the plugin itself is stopped, process and all, by the `plugins.stop` that follows.
      function onAbort(): void {
        if (!running.pending.delete(id)) return
        clearTimeout(timer)
        reject(new Error('plugin invoke aborted'))
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          clearTimeout(timer)
          reject(new Error('plugin invoke aborted'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      running.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        }
      })
      running.process.postMessage({ id, kind: 'invoke', payload: { kind, command, arg } })
    })
  }

  /** Stops the process and waits for `exit` up to `STOP_WAIT_MS`. */
  async stopPlugin(pluginId: string): Promise<void> {
    const running = this.running.get(pluginId)
    if (running === undefined) return
    this.running.delete(pluginId)
    running.stopping = true
    running.readyReject?.(new Error('plugin host stopped'))
    running.process.kill()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      running.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), STOP_WAIT_MS)
      })
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (timedOut) log.warn('plugin.stop.timeout', { pluginId, ms: STOP_WAIT_MS })
  }

  /** Shutdown (12.9). Stops all plugins in parallel and returns after waiting for each `exit` (with an upper limit). */
  async stop(): Promise<void> {
    this.shutdown = true
    await Promise.all([...this.running.keys()].map((id) => this.stopPlugin(id)))
  }
}

const FRAME_KINDS: readonly string[] = ['broker', 'invoke', 'result', 'error', 'ready', 'permission']

function isHostFrame(value: unknown): value is HostFrame {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Record<string, unknown>
  return (
    typeof frame['id'] === 'number' &&
    Number.isSafeInteger(frame['id']) &&
    typeof frame['kind'] === 'string' &&
    FRAME_KINDS.includes(frame['kind'])
  )
}

/** The list of exports carried by `ready` (C-4). null if the shape is wrong (an old plugin-host carries nothing). */
function asHostExports(value: unknown): HostExports | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const names = (key: string): readonly string[] | null => {
    const list = record[key]
    return Array.isArray(list) && list.every((item) => typeof item === 'string') ? list : null
  }
  const commands = names('commands')
  const mcp = names('mcp')
  const indexer = names('indexer')
  if (commands === null || mcp === null || indexer === null) return null
  // TODO 952 stage 1: `tasks` is a kind added later. If absent, it is read as empty.
  // TODO 896: `search` is likewise a kind added later.
  return { commands, mcp, indexer, tasks: names('tasks') ?? [], search: names('search') ?? [] }
}

function extensionOf(uri: string): string {
  const withoutQuery = uri.split(/[?#]/, 1)[0] ?? uri
  const last = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return dot <= 0 ? '' : last.slice(dot + 1).toLowerCase()
}

/**
 * Bundled plugins delivered disabled by default (TODO 523). Unlike `isRequiredPlugin`, it is fixed by id
 * (the shape of the manifest alone cannot express "disabled only when first installed") - `aios.gmail` only
 * contributes opening a Web view, and whether to use it is up to the user (an Activity Bar icon that is unnecessary for people who do not use Gmail).
 * TODO 848 added `aios.reddit` (a tool that fetches pages through a logged-in Web view, owner decision 2026-10-15).
 * TODO 1264 added `aios.calendar` (same as Gmail: nothing leaves the machine until the user enables it and signs in).
 * After `restoreState` writes the disabled row at the first launch, this set is never looked at again (the user's choice simply remains).
 * **Applied only to bundled plugins** (`restoreState` also checks `plugin.bundled`) - even if an external plugin
 * claims the same id, it is not disabled by this set (a code-review fix).
 */
export const DEFAULT_DISABLED_PLUGIN_IDS: ReadonlySet<string> = new Set(['aios.gmail', 'aios.calendar', 'aios.reddit', 'aios.bitbucket'])

/**
 * Whether an extension cannot be disabled (TODO 460, 12.9). Only the **built-in "last fallback"** - a viewer that declares none of `extensions`, `schemes`
 * or `payloads` (currently `aios.text`). `resolveViewer` makes it the "destination when no extension claimed the file", so as long as it remains,
 * any file can be opened (for a binary, the fallback shows "cannot be displayed"). It is decided by the shape of the manifest rather than fixed by id (so it follows if the fallback is replaced).
 * A user-installed fallback is not a target.
 */
export function isRequiredPlugin(plugin: { readonly bundled: boolean; readonly manifest: PluginManifest }): boolean {
  const viewer = plugin.manifest.viewer
  return (
    plugin.bundled &&
    viewer !== undefined &&
    viewer.extensions === undefined &&
    viewer.schemes === undefined &&
    viewer.payloads === undefined
  )
}
