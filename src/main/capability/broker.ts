/**
 * CapabilityBroker: **the only entry point for privileged operations from plugins** (ARCHITECTURE.md 7.7).
 *
 * ```
 * plugin-host (utility)               main
 *   aios.fs.read(uri)          ──►  Broker.fs          ──► allowed-path check ──► disk
 *   aios.net.fetch(url, auth)  ──►  Broker.network     ──► allowed host + IP check ──► HTTPS
 *   aios.credentials.status()  ──►  Broker.credentials ──► **values are never passed**
 *   aios.index.put(doc)        ──►  Broker.index       ──► IndexService (single writer)
 *   aios.ui.notify(...)        ──►  Broker.ui          ──► renderer
 *   aios.browser.fetchPage(url) ──► Broker.browser     ──► declared host + per-hop checks ──► Web view session (TODO 848)
 * viewer (iframe)
 *   <img src="aios-res://local/<token>/…"> ──► protocol ──► Broker.openResource (A-4)
 * ```
 *
 * The decision has 3 stages:
 *
 * 1. **Declaration**: a capability not in the manifest's `capabilities` is rejected unconditionally.
 *    A declaration is the "upper bound of what may be requested", not a permission (7.2).
 * 2. **Consent**: per-capability user consent. Bundled plugins are treated as granted at install time
 *    (user decision, 12.9).
 * 3. **Policy**: exclusion list / realpath / allowed hosts / namespaces.
 *
 * Before these comes **shape validation** (review A-3, `handleUntrusted`). Values coming from the plugin-host
 * pass through a zod schema before they enter the decision.
 *
 * Every call is recorded in the audit log with the plugin ID (chapter 8).
 * **Standard plugins go through here without exception. No privileged shortcuts are made** (7.7).
 */
import { isUtf8 } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { basename, extname } from 'node:path'
import { closeSync, constants, readSync, fstatSync, realpathSync } from 'node:fs'
import {
  indexSourceOwnedBy,
  MAX_PLUGIN_READ_BYTES,
  MAX_PLUGIN_READ_CHUNK_BYTES,
  type BrokerBrowserFetchPageResult,
  type BrokerFsReadRequest,
  type BrokerFsReadResult,
  type BrokerNetFetchResult,
  type BrokerRequest,
  type CapabilityName,
  type PluginDocumentInput
} from '@shared/plugin.js'
import type { PluginSidebarRow, PluginSyncReport } from '@shared/plugin-surfaces.js'
import type { PluginTriggerEvent, TriggerEmitResult } from '@shared/trigger.js'
import type { PluginSettingValues } from '@shared/plugin-settings.js'
import { tokenResourceUrl } from '@shared/uri.js'
import { log } from '../../common/logger.js'
import { pathToUri } from '../../common/uri.js'
import type { AuditLog } from './audit.js'
import type { CredentialStore } from './credentials.js'
import { credentialOwnedBy } from './credential-owner.js'
import { googleRequestAllowed } from './google-credentials.js'
import { NetDenied, RateLimiter } from './net-policy.js'
import { brokeredFetch, nodeTransport, type NetTransport } from './network.js'
import { auditLabel, parseBrokerRequest } from './request-schema.js'
import {
  BROWSER_RATE_LIMIT_PER_MINUTE,
  BrowserDenied,
  ConcurrencyGate,
  auditUrl,
  brokeredPageFetch,
  type BrowserTransport
} from './browser.js'
import type { OpenedResource } from './resource.js'
import {
  PathDenied,
  insideRoots,
  openChecked,
  pathFromUri,
  resolvePath,
  type PathScope
} from '../../common/fs-policy.js'
import { decodeLegacyJapanese } from './legacy-text.js'

export { MAX_PLUGIN_READ_BYTES, MAX_PLUGIN_READ_CHUNK_BYTES }
/** How many grants for URIs the user opened to remember (7.2 "the URI the user has open right now"). */
const MAX_OPEN_GRANTS = 16
/** TODO 1280: the length limit of a document uri (the same as a request's uri) and the schemes `readOwnDocument` never serves. */
const MAX_DOCUMENT_URI = 8192
const NON_DOCUMENT_SCHEMES: ReadonlySet<string> = new Set(['file', 'thread'])

export class CapabilityDenied extends Error {
  constructor(
    readonly reason: string,
    /** `settings` (TODO 1225) is an entry point that is not a capability (no declaration or consent), so it is outside `CapabilityName`. */
    readonly capability: CapabilityName | 'settings'
  ) {
    super(reason)
    this.name = 'CapabilityDenied'
  }
}

/** A request that failed shape validation (review A-3). Even the capability name cannot be trusted, so it is separate from `CapabilityDenied`. */
export class InvalidBrokerRequest extends Error {
  readonly reason = 'invalid-request'
  constructor() {
    super('invalid-request')
    this.name = 'InvalidBrokerRequest'
  }
}

/** What the Broker needs to know about a plugin. Supplied by PluginHost. */
export interface PluginPolicy {
  readonly id: string
  /** Capabilities the manifest declared (the upper bound). */
  readonly declared: {
    readonly credentials: readonly string[]
    readonly networkHosts: readonly string[]
    readonly fsRead: readonly string[]
    readonly fsWrite: readonly string[]
    readonly indexSources: readonly string[]
    readonly ui: boolean
    /** Declaration of `ui.status` / `ui.sidebar` (TODO 1038 / 1039). If absent, same as false. */
    readonly uiStatus?: boolean
    readonly uiSidebar?: boolean
    /** `browser.hosts` (TODO 848). If absent, same as empty. */
    readonly browserHosts?: readonly string[]
    /** `triggers[].id` (TODO 1216). If absent, same as empty. */
    readonly triggers?: readonly string[]
  }
  /** Capabilities the user has consented to. */
  readonly consented: ReadonlySet<CapabilityName>
}

export interface BrokerDeps {
  /** The exclusion list. The rules of 4.4 **always** apply (7.7). */
  readonly scope: Omit<PathScope, 'roots'>
  readonly audit: AuditLog
  readonly credentials: CredentialStore
  /** Plugin ID -> policy. If absent, "no such plugin" = denied. */
  readonly policyOf: (pluginId: string) => PluginPolicy | null
  /**
   * TODO 1237 (wave 87 automatic security review): whether the documents of a previous extension with the same id are being deleted. While true, writes and
   * deletes of the `index` capability are refused with `index-clearing` (so that a different extension does not inherit the previous documents). Omitted = always false (tests).
   */
  readonly indexClearing?: (pluginId: string) => boolean
  /** Feeding the index (goes onto the single-writer queue of 6.2). */
  readonly index: {
    put(document: PluginDocumentInput): Promise<void>
    remove(source: string, sourceId: string): Promise<void>
  }
  /**
   * TODO 1280: the canonical copy of a document by its uri, **only among the calling extension's own documents** (`PluginDocumentStore.readByUri`).
   * If absent, `readOwnDocument` refuses with `unavailable` (tests).
   */
  readonly documents?: {
    readByUri(pluginId: string, uri: string): { source: string; title: string; body: string; updatedAt: number } | null
  }
  /** Show a notification in the renderer. */
  readonly notify: (pluginId: string, title: string, body: string | null) => void
  /**
   * The plugin's "surfaces" (TODO 1038 / 1039). Receives validated values and holds them for the host (renderer) to display. If absent,
   * refuses with `unavailable` (tests). The receiving side matches the scheme of a sidebar row's URI against the plugin's viewer.
   */
  readonly surfaces?: {
    setSidebarRows(pluginId: string, rows: readonly PluginSidebarRow[]): void
    reportStatus(pluginId: string, report: PluginSyncReport): void
  }
  readonly transport?: NetTransport
  /**
   * Transport for the `browser` capability (TODO 848, the Web view session). If absent, `browser.fetchPage` refuses with `unavailable`
   * (tests, and launches without a Web view session).
   */
  readonly browser?: BrowserTransport
  /**
   * Receiver for triggers (TODO 1216, 6.2.6). Events that passed declaration and consent are handed over. Decisions on duplicates, rules and limits are made on that side
   * (`TriggerService`). If absent, refuses with `unavailable` (tests, and while still being assembled).
   */
  readonly triggers?: () => { emit(pluginId: string, event: PluginTriggerEvent): Promise<TriggerEmitResult> } | null
  /**
   * TODO 1225 (7.2.1): the setting values of extension `pluginId` (declared fields only, defaults if unset). **Looked up only by the calling extension's own id.**
   * If absent, refuses with `unavailable` (tests).
   */
  readonly settings?: (pluginId: string) => PluginSettingValues
}

/**
 * One "the user opened it" grant (7.2). `refs` is the number of open ViewerPanes (per window).
 * It decreases by 1 on every close / switch and is removed at 0 (review D-3).
 */
interface OpenGrant {
  readonly path: string
  /**
   * The real path at the time of opening (realpath, TODO 558). When a symlinked file (`~/todo.md -> ~/sw2/todo.md`) is opened,
   * the scope is just two things: "the opened URI itself" and "what the link pointed to at that time".
   * If the link is re-pointed elsewhere after opening, the real path falls outside the scope and is refused with `symlink-escape`.
   */
  readonly canonical: string
  readonly refs: number
}

/** What one `aios-res://` token points to (review A-4). */
interface ResourceGrant {
  readonly pluginId: string
  readonly path: string
}

/** Stand-in plugin ID for the audit log when the token is not found. */
const UNKNOWN_PLUGIN = '(unknown)'

/**
 * TODO 550: the owner of `aios-res://` for the app itself (thumbnails of images sent from the renderer's timeline).
 * It has a form (parentheses) that cannot be a plugin ID, so it never mixes with plugin grants (`openGrants`).
 */
const HOST_RESOURCE_OWNER = '(host)'
/** Only images may be shown to the app itself (filtered by extension; the contents simply do not display if `<img>` cannot decode them). */
const HOST_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'])
/** Upper bound on the app's own tokens. When exceeded, the oldest are dropped (a dropped URL is re-fetched on redraw). */
const MAX_HOST_RESOURCES = 512

export class CapabilityBroker {
  private readonly rateLimiter = new RateLimiter()
  /** `browser` is counted separately from `network` (TODO 848). */
  private readonly browserRateLimiter = new RateLimiter(BROWSER_RATE_LIMIT_PER_MINUTE)
  private readonly browserGate = new ConcurrencyGate()
  /** pluginId -> URIs the user opened (newest first). */
  private readonly openGrants = new Map<string, OpenGrant[]>()
  /** token -> (pluginId, path). **When the grant goes away, the token goes too** (A-4). */
  private readonly resources = new Map<string, ResourceGrant>()
  private readonly transport: NetTransport

  constructor(private readonly deps: BrokerDeps) {
    this.transport = deps.transport ?? nodeTransport
  }

  /**
   * Records that "the user opened this URI" and lets that plugin read it (7.2).
   * **Only main calls this**: the ViewerPane path calls it after receiving the renderer's selection.
   * The path goes through the policy here too, so the scope does not widen even if the renderer lies.
   *
   * Opening the same URI again increases `refs` (the same file in another window). Closing is `revokeOpen`.
   * As an upper bound for missed closes (window reloads, crashes), only the most recent 16 are remembered.
   */
  grantOpen(pluginId: string, uri: string): void {
    const path = pathFromUri(uri)
    // A URI matching the exclusion list is not turned into a grant even if the user tries to open it.
    // The grant is a read grant, so the read exceptions (auto memory `.md`, item 254) pass.
    // The real path (canonical) is subject to the same check: a symlink pointing at an exclusion fails here with `symlink-escape`.
    const resolved = resolvePath(path, { rules: this.deps.scope.rules }, false, 'read')
    const list = this.openGrants.get(pluginId) ?? []
    const existing = list.find((entry) => entry.path === path)
    const next = [
      // On re-open, take the real path again at its current value (re-opening after the link was re-pointed makes it readable).
      { path, canonical: resolved.canonical, refs: (existing?.refs ?? 0) + 1 },
      ...list.filter((entry) => entry.path !== path)
    ]
    for (const dropped of next.slice(MAX_OPEN_GRANTS)) this.dropResources(pluginId, dropped.path)
    this.openGrants.set(pluginId, next.slice(0, MAX_OPEN_GRANTS))
  }

  /**
   * The ViewerPane closed / switched a URI (review D-3). Omitting `uri` drops all of
   * that plugin's grants (for example on disable). When a grant goes away, the `aios-res://`
   * tokens issued for that URI go too (A-4).
   */
  revokeOpen(pluginId: string, uri?: string): void {
    const list = this.openGrants.get(pluginId)
    if (list === undefined) return
    if (uri === undefined) {
      for (const entry of list) this.dropResources(pluginId, entry.path)
      this.openGrants.delete(pluginId)
      return
    }
    let path: string
    try {
      path = pathFromUri(uri)
    } catch {
      return
    }
    const entry = list.find((item) => item.path === path)
    if (entry === undefined) return
    if (entry.refs > 1) {
      this.openGrants.set(
        pluginId,
        list.map((item) => (item.path === path ? { ...item, refs: item.refs - 1 } : item))
      )
      return
    }
    this.dropResources(pluginId, path)
    const rest = list.filter((item) => item.path !== path)
    if (rest.length === 0) this.openGrants.delete(pluginId)
    else this.openGrants.set(pluginId, rest)
  }

  private isOpen(pluginId: string, path: string): boolean {
    return (this.openGrants.get(pluginId) ?? []).some((entry) => entry.path === path)
  }

  /**
   * The scope for reading and writing under an "opened URI" grant (TODO 558): two things, the logical path that was opened and the real path at the time it was opened.
   * If it is not open, only the logical path (same as the earlier `roots: [path]`). ViewerBroker checks against the same scope.
   */
  openGrantRoots(pluginId: string, path: string): readonly string[] {
    const grant = (this.openGrants.get(pluginId) ?? []).find((entry) => entry.path === path)
    if (grant === undefined || grant.canonical === path) return [path]
    return [path, grant.canonical]
  }

  /**
   * Whether that plugin may touch this path. Used by reads and writes through the ViewerPane.
   * **Do not create a path that bypasses this**: keep the decision in one place (inherits the policy of 12.3).
   */
  assertGranted(pluginId: string, path: string): void {
    const policy = this.deps.policyOf(pluginId)
    if (policy === null) throw new CapabilityDenied('unknown-plugin', 'fs')
    if (!policy.consented.has('fs')) throw new CapabilityDenied('not-consented', 'fs')
    if (this.isOpen(pluginId, path)) return
    if (insideRoots(path, policy.declared.fsRead) && policy.declared.fsRead.length > 0) return
    throw new CapabilityDenied('no-grant', 'fs')
  }

  /**
   * Entry point for a request from the plugin-host **whose type is unknown** (review A-3). Validates the shape and then
   * passes it to `handle`. Anything that fails is recorded in the audit as `deny('invalid-request')` and thrown.
   */
  async handleUntrusted(pluginId: string, raw: unknown): Promise<unknown> {
    const request = parseBrokerRequest(raw)
    if (request === null) {
      this.deps.audit.record({
        at: Date.now(),
        pluginId,
        capability: auditLabel(raw, 'capability'),
        op: auditLabel(raw, 'op'),
        target: null,
        decision: 'deny',
        reason: 'invalid-request',
        ms: 0
      })
      log.warn('broker.invalid', { pluginId })
      throw new InvalidBrokerRequest()
    }
    return this.handle(pluginId, request)
  }

  /**
   * TODO 1280: reads one of the extension's **own** documents by uri (the body of a row of its sidebar list, for its own viewer). Not a request the plugin-host can send:
   * only main's `ViewerBroker` calls this, with the extension id it resolved the viewer for (never an id the extension or the renderer names).
   *
   * The gates are those of `index.put`: the extension is installed and enabled (`policyOf`), the `index` consent is given, the document's source is declared and in the
   * extension's own id namespace (an exact match, `indexSourceOwnedBy`), and the extension's old documents are not being deleted. The uri must be a document uri:
   * `file:` and `thread:` (and anything that is not `scheme:`) never reach the store. Recorded in the audit (the uri only, never the body).
   */
  async readOwnDocument(pluginId: string, uri: string): Promise<{ title: string; text: string; updatedAt: number }> {
    const started = Date.now()
    const record = (decision: 'allow' | 'deny', reason: string | null): void =>
      this.deps.audit.record({ at: started, pluginId, capability: 'index', op: 'readDocument', target: uri.slice(0, 256), decision, reason, ms: Date.now() - started })
    try {
      if (uri.length === 0 || uri.length > MAX_DOCUMENT_URI) throw new CapabilityDenied('invalid-uri', 'index')
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase()
      if (scheme === undefined || NON_DOCUMENT_SCHEMES.has(scheme)) throw new CapabilityDenied('invalid-uri', 'index')
      const policy = this.policy(pluginId, 'index')
      if (this.deps.documents === undefined) throw new CapabilityDenied('unavailable', 'index')
      if (this.deps.indexClearing?.(pluginId) === true) throw new CapabilityDenied('index-clearing', 'index')
      const found = this.deps.documents.readByUri(pluginId, uri)
      if (found === null) throw new CapabilityDenied('not-found', 'index')
      // Check again here, so a store that ignores the namespace still cannot hand over another extension's document.
      if (!policy.declared.indexSources.includes(found.source) || !indexSourceOwnedBy(pluginId, found.source)) {
        throw new CapabilityDenied('namespace', 'index')
      }
      record('allow', null)
      return { title: found.title, text: found.body, updatedAt: found.updatedAt }
    } catch (err) {
      const reason = denyReason(err)
      record('deny', reason)
      log.warn('broker.denied', { pluginId, capability: 'index', op: 'readDocument', reason })
      throw err
    }
  }

  /** Entry point for validated requests. No privileged operation avoids this. */
  async handle(pluginId: string, request: BrokerRequest): Promise<unknown> {
    const started = Date.now()
    const target = targetOf(request)
    try {
      const result = await this.dispatch(pluginId, request)
      this.deps.audit.record({
        at: started,
        pluginId,
        capability: request.capability,
        op: request.op,
        target,
        decision: 'allow',
        // TODO 1216: for an event that passed the entry point but was not accepted (duplicate, invalid, over the limit), keep the reason.
        reason: request.capability === 'triggers' ? triggerAuditReason(result) : null,
        ms: Date.now() - started
      })
      return result
    } catch (err) {
      const reason = denyReason(err)
      this.deps.audit.record({
        at: started,
        pluginId,
        capability: request.capability,
        op: request.op,
        target,
        decision: 'deny',
        reason,
        ms: Date.now() - started
      })
      log.warn('broker.denied', {
        pluginId,
        capability: request.capability,
        op: request.op,
        reason
      })
      throw err
    }
  }

  private policy(pluginId: string, capability: CapabilityName): PluginPolicy {
    const policy = this.deps.policyOf(pluginId)
    if (policy === null) throw new CapabilityDenied('unknown-plugin', capability)
    // Consent (7.7 "user consent on first use"). A declaration alone does not pass.
    if (!policy.consented.has(capability)) throw new CapabilityDenied('not-consented', capability)
    return policy
  }

  private async dispatch(pluginId: string, request: BrokerRequest): Promise<unknown> {
    switch (request.capability) {
      case 'settings': {
        // TODO 1225: not a capability (it only reads the values of declared fields; no consent needed). But only for an extension that is installed and enabled, and
        // the lookup uses the calling extension's own id (`pluginId` is the value main decided from the plugin-host connection; it is not taken from the request body).
        if (this.deps.policyOf(pluginId) === null) throw new CapabilityDenied('unknown-plugin', 'settings')
        if (this.deps.settings === undefined) throw new CapabilityDenied('unavailable', 'settings')
        return this.deps.settings(pluginId)
      }
      case 'fs':
        return this.readFile(pluginId, request)
      case 'network':
        return this.fetch(pluginId, request)
      case 'credentials': {
        const policy = this.policy(pluginId, 'credentials')
        if (!policy.declared.credentials.includes(request.name)) {
          throw new CapabilityDenied('not-declared', 'credentials')
        }
        // Wave 84 fix Z: a name in the table belongs only to the owner extension (even if a path builds the policy from outside the manifest; `credential-owner.ts`).
        if (!credentialOwnedBy(request.name, pluginId)) throw new CapabilityDenied('not-owner', 'credentials')
        // **The value is not returned.** Only presence and the bound host (7.7).
        return this.deps.credentials.status(request.name)
      }
      case 'index': {
        const policy = this.policy(pluginId, 'index')
        const source = request.op === 'put' ? request.document.source : request.source
        // TODO 920: besides the declaration, the source must be in the plugin's own id namespace (`indexSourceOwnedBy`, same as manifest validation).
        // Even if a path builds the declaration table (`PluginPolicy`) from outside the manifest, it cannot write built-in sources or other plugins' sources.
        if (!policy.declared.indexSources.includes(source) || !indexSourceOwnedBy(pluginId, source)) {
          throw new CapabilityDenied('namespace', 'index')
        }
        if (this.deps.indexClearing?.(pluginId) === true) throw new CapabilityDenied('index-clearing', 'index')
        if (request.op === 'put') {
          await this.deps.index.put(request.document)
          return { ok: true }
        }
        await this.deps.index.remove(request.source, request.sourceId)
        return { ok: true }
      }
      case 'ui': {
        const policy = this.policy(pluginId, 'ui')
        if (!policy.declared.ui) throw new CapabilityDenied('not-declared', 'ui')
        if (request.op === 'setSidebarRows' || request.op === 'reportStatus') {
          const declared = request.op === 'setSidebarRows' ? policy.declared.uiSidebar : policy.declared.uiStatus
          if (declared !== true) throw new CapabilityDenied('not-declared', 'ui')
          if (this.deps.surfaces === undefined) throw new CapabilityDenied('unavailable', 'ui')
          if (request.op === 'setSidebarRows') this.deps.surfaces.setSidebarRows(pluginId, request.rows)
          else this.deps.surfaces.reportStatus(pluginId, request)
          return { ok: true }
        }
        this.deps.notify(pluginId, request.title, request.body ?? null)
        return { ok: true }
      }
      case 'browser':
        return this.fetchPage(pluginId, request.url)
      case 'triggers': {
        // TODO 1216: check consent (bundled is pre-granted) and declaration (`triggers[].id`), then go to main's receiver.
        const policy = this.policy(pluginId, 'triggers')
        if (!(policy.declared.triggers ?? []).includes(request.event.trigger)) {
          throw new CapabilityDenied('not-declared', 'triggers')
        }
        const sink = this.deps.triggers?.() ?? null
        if (sink === null) throw new CapabilityDenied('unavailable', 'triggers')
        return sink.emit(pluginId, request.event)
      }
      default: {
        const never: never = request
        throw new CapabilityDenied('unknown-capability', (never as BrokerRequest).capability)
      }
    }
  }

  /**
   * File read (the `fs` row of 7.7).
   *
   * Allowed only for either "inside the read paths the manifest declared" or
   * "a URI the user has open right now". The exclusion list **always** applies.
   *
   * Review C-1: with `encoding: 'bytes'` the contents are returned as a `Uint8Array`, and `offset` / `length`
   * select a range. One read is up to `MAX_PLUGIN_READ_CHUNK_BYTES`.
   */
  private async readFile(pluginId: string, request: BrokerFsReadRequest): Promise<BrokerFsReadResult> {
    const policy = this.policy(pluginId, 'fs')
    const path = pathFromUri(request.uri)
    const granted = this.isOpen(pluginId, path)
    const roots = [...policy.declared.fsRead]
    if (!granted && roots.length === 0) throw new CapabilityDenied('no-grant', 'fs')

    // With no declared roots, the scope is just "the opened URI itself".
    // TODO 558: for a symlinked file, the real path at the time of opening is also in scope (`openGrantRoots`).
    const scope: PathScope = granted
      ? { rules: this.deps.scope.rules, roots: this.openGrantRoots(pluginId, path) }
      : // Do not apply "not indexed but openable" (TODO 561, `/tmp`) to the declared scope. This is
        // an exception so the viewer can read what the user opened; a plugin cannot read `/tmp` by declaration alone (plugin permissions are unchanged).
        { rules: { ...this.deps.scope.rules, openableDirs: [] }, roots }
    const resolved = resolvePath(path, scope, false, 'read')
    if (!resolved.exists) throw new PathDenied('not-found')
    if (resolved.isDirectory) throw new CapabilityDenied('directory', 'fs')

    const encoding = request.encoding ?? 'utf8'
    const limit = Math.min(request.length ?? MAX_PLUGIN_READ_BYTES, MAX_PLUGIN_READ_CHUNK_BYTES)

    const fd = openChecked(resolved, constants.O_RDONLY)
    try {
      const stat = fstatSync(fd)
      const size = Number(stat.size)
      const start = Math.min(request.offset ?? 0, size)
      const want = Math.max(0, Math.min(size - start, limit))
      // **Read into a plain Uint8Array, not a Buffer.** A small Buffer is a slice of the shared pool (8 KB), and
      // structured clone sends not the view but **the whole backing ArrayBuffer**. A dedicated region is allocated so that
      // other values of main left in the pool do not reach the plugin.
      const data = new Uint8Array(want)
      let read = 0
      while (read < want) {
        const n = readSync(fd, data, read, want - read, start + read)
        if (n === 0) break
        read += n
      }
      const slice = read === want ? data : data.slice(0, read)
      const kind = looksBinary(slice) ? 'binary' : 'text'
      const base = { kind, bytes: size, offset: start, length: read, truncated: start + read < size, mtimeMs: stat.mtimeMs } as const
      if (encoding === 'bytes') return { ...base, data: slice }
      if (kind === 'binary') return base
      if (isValidUtf8(slice, base.truncated)) {
        return { ...base, text: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('utf8') }
      }
      // TODO 851: if not UTF-8, read-only (`invalidUtf8`, no write-back). TODO 1215: for display, if it reads plausibly as an old Japanese encoding
      // (EUC-JP / Shift_JIS, as in CSV written by Excel), read it that way (how it is chosen is in legacy-text.ts);
      // if it does not, replace with U+FFFD as before.
      return {
        ...base,
        invalidUtf8: true as const,
        text:
          decodeLegacyJapanese(slice, base.truncated) ??
          Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('utf8')
      }
    } finally {
      closeSync(fd)
    }
  }

  private async fetch(
    pluginId: string,
    request: Extract<BrokerRequest, { capability: 'network' }>
  ): Promise<BrokerNetFetchResult> {
    const policy = this.policy(pluginId, 'network')
    if (policy.declared.networkHosts.length === 0) {
      throw new CapabilityDenied('not-declared', 'network')
    }
    this.rateLimiter.take(pluginId)

    let credential: { host: string; header: string; value: string } | null = null
    if (request.auth !== undefined) {
      if (!policy.declared.credentials.includes(request.auth)) {
        throw new CapabilityDenied('not-declared', 'credentials')
      }
      // Wave 84 fix Z: do not let a request attach another extension's credentials (a token the user entered for its owner).
      if (!credentialOwnedBy(request.auth, pluginId)) throw new CapabilityDenied('not-owner', 'credentials')
      // TODO 1264: a read-only credential goes only on GET / HEAD under its API's path (checked before the token is even built).
      if (!googleRequestAllowed(request.auth, request.method ?? 'GET', request.url)) {
        throw new CapabilityDenied('read-only', 'credentials')
      }
      credential = await this.deps.credentials.headerForAsync(request.auth)
      if (credential === null) throw new CapabilityDenied('no-credential', 'credentials')
    }

    const auth = request.auth
    return brokeredFetch(
      {
        url: request.url,
        method: request.method ?? 'GET',
        headers: request.headers ?? {},
        body: request.body ?? null,
        allowedHosts: policy.declared.networkHosts,
        credential,
        // TODO 1264 review: the read-only / path binding holds on every redirect hop too (a same-host redirect elsewhere drops the token).
        ...(auth === undefined ? {} : { credentialAllowed: (method: string, url: string) => googleRequestAllowed(auth, method, url) })
      },
      this.transport
    )
  }

  /**
   * Fetches one page in the logged-in Web view session (TODO 848, 7.7). Declaration (`browser.hosts`) -> consent
   * (even for bundled, the user is asked the first time, `EXPLICIT_CONSENT_CAPABILITIES`) -> rate and concurrency -> per-hop checks
   * (`brokeredPageFetch`). The body is only returned to the plugin, never saved or logged (constraints 9 / 10).
   */
  private async fetchPage(pluginId: string, url: string): Promise<BrokerBrowserFetchPageResult> {
    const policy = this.policy(pluginId, 'browser')
    const hosts = policy.declared.browserHosts ?? []
    if (hosts.length === 0) throw new CapabilityDenied('not-declared', 'browser')
    const transport = this.deps.browser
    if (transport === undefined) throw new BrowserDenied('unavailable')
    this.browserRateLimiter.take(pluginId)
    if (!this.browserGate.acquire(pluginId)) throw new BrowserDenied('busy')
    try {
      return await brokeredPageFetch({ url, allowedHosts: hosts }, transport)
    } finally {
      this.browserGate.release(pluginId)
    }
  }

  /**
   * The URL handed to the viewer in place of the body (7.4 / review A-4). **Plugins are not given raw paths.**
   *
   * The `<token>` in `aios-res://local/<token>/<name>` is 128 bits of randomness bound to (pluginId, path).
   * The same token is reused while the same grant lasts (because PDF range requests and redraws fetch many times).
   * **When the grant (`grantOpen`) goes away the token goes too**, and later fetches get 403.
   * The check at serving time is `openResource`: the decision for building the URL and for serving are both in this one class.
   */
  resourceUrlFor(pluginId: string, uri: string): string {
    const policy = this.deps.policyOf(pluginId)
    if (policy === null) throw new CapabilityDenied('unknown-plugin', 'fs')
    const path = pathFromUri(uri)
    if (!this.isOpen(pluginId, path)) throw new CapabilityDenied('no-grant', 'fs')
    const resolved = resolvePath(
      path,
      { rules: this.deps.scope.rules, roots: this.openGrantRoots(pluginId, path) },
      false,
      'read'
    )
    let token: string | null = null
    for (const [candidate, grant] of this.resources) {
      if (grant.pluginId === pluginId && grant.path === resolved.logical) {
        token = candidate
        break
      }
    }
    if (token === null) {
      token = randomBytes(16).toString('hex')
      this.resources.set(token, { pluginId, path: resolved.logical })
    }
    return tokenResourceUrl(token, basename(resolved.logical))
  }

  /**
   * Serving `aios-res://` (A-4 / D-5). Looks up token -> (pluginId, path) and returns an fd only for what **still** passes
   * grant, consent, exclusion, realpath, and O_NOFOLLOW + fstat.
   * It does not read the body (D-5: it used to read up to 2 MB and discard it before serving).
   * The caller (protocol) closes the fd. The result is recorded in the audit as `fs` / `resource`.
   */
  openResource(token: string): OpenedResource {
    const started = Date.now()
    const grant = this.resources.get(token)
    const pluginId = grant?.pluginId ?? UNKNOWN_PLUGIN
    const target = grant === undefined ? null : pathToUri(grant.path)
    try {
      if (grant === undefined) throw new CapabilityDenied('unknown-token', 'fs')
      // The app's own images (TODO 550) do not consult plugin grants. Only the image extension is re-checked on every serve.
      if (grant.pluginId === HOST_RESOURCE_OWNER) {
        if (!HOST_IMAGE_EXTENSIONS.has(extname(grant.path).toLowerCase())) {
          throw new CapabilityDenied('not-image', 'fs')
        }
      } else {
        this.assertGranted(grant.pluginId, grant.path)
      }
      // TODO 590: the app's own images have no "open" event (every time is effectively a re-open), so the scope is
      // re-measured with `hostImageRoots` on every serve: even a symlink itself is reachable if its real path is not excluded.
      const resolved = resolvePath(
        grant.path,
        {
          rules: this.deps.scope.rules,
          roots:
            grant.pluginId === HOST_RESOURCE_OWNER
              ? hostImageRoots(grant.path)
              : this.openGrantRoots(grant.pluginId, grant.path)
        },
        false,
        'read'
      )
      if (!resolved.exists) throw new PathDenied('not-found')
      if (resolved.isDirectory) throw new CapabilityDenied('directory', 'fs')
      const fd = openChecked(resolved, constants.O_RDONLY)
      let size: number
      try {
        size = Number(fstatSync(fd).size)
      } catch (err) {
        closeSync(fd)
        throw err
      }
      this.deps.audit.record({
        at: started,
        pluginId,
        capability: 'fs',
        op: 'resource',
        target,
        decision: 'allow',
        reason: null,
        ms: Date.now() - started
      })
      return { fd, size, path: grant.path }
    } catch (err) {
      const reason = denyReason(err)
      this.deps.audit.record({
        at: started,
        pluginId,
        capability: 'fs',
        op: 'resource',
        target,
        decision: 'deny',
        reason,
        ms: Date.now() - started
      })
      log.warn('broker.resource.denied', { pluginId, reason })
      throw err
    }
  }

  /**
   * TODO 550: a URL that shows the renderer an image sent from the timeline (an attachment pointing at a file). No copy of the body is kept;
   * it is read through this URL on every display (constraint 9). No plugin grant is needed, but **only image extensions** are allowed, and the
   * exclusion and realpath checks are applied again by `openResource` on every serve (the same path as plugin tokens).
   */
  hostImageUrlFor(uri: string): string {
    const path = pathFromUri(uri)
    if (!HOST_IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
      throw new CapabilityDenied('not-image', 'fs')
    }
    // The scope is two things, the logical path and its real path (code-review 2026-10-10, a consequence of TODO 558 / 561). With `roots: [path]` alone,
    // `/tmp/x.png` (real path `/private/tmp/x.png`) or an image under a symlink would be refused with `symlink-escape`, leaving only a name label.
    // Same idea as `openGrantRoots` in the plugin path. Exclusion rules apply to the real path too (`resolvePath`).
    const resolved = resolvePath(
      path,
      { rules: this.deps.scope.rules, roots: hostImageRoots(path) },
      false,
      'read'
    )
    if (!resolved.exists) throw new PathDenied('not-found')
    if (resolved.isDirectory) throw new CapabilityDenied('directory', 'fs')
    for (const [candidate, grant] of this.resources) {
      if (grant.pluginId === HOST_RESOURCE_OWNER && grant.path === resolved.logical) {
        return tokenResourceUrl(candidate, basename(resolved.logical))
      }
    }
    const owned = [...this.resources].filter(([, grant]) => grant.pluginId === HOST_RESOURCE_OWNER)
    for (const [oldest] of owned.slice(0, Math.max(0, owned.length - MAX_HOST_RESOURCES + 1))) {
      this.resources.delete(oldest)
    }
    const token = randomBytes(16).toString('hex')
    this.resources.set(token, { pluginId: HOST_RESOURCE_OWNER, path: resolved.logical })
    return tokenResourceUrl(token, basename(resolved.logical))
  }

  private dropResources(pluginId: string, path: string): void {
    for (const [token, grant] of this.resources) {
      if (grant.pluginId === pluginId && grant.path === path) this.resources.delete(token)
    }
  }
}

/** The scope of `hostImageUrlFor`: the logical path and the current real path (if unreadable, only the logical path, which falls back to the earlier check). */
function hostImageRoots(path: string): readonly string[] {
  try {
    const canonical = realpathSync.native(path)
    return canonical === path ? [path] : [path, canonical]
  } catch {
    return [path]
  }
}

function denyReason(err: unknown): string {
  return err instanceof CapabilityDenied ||
    err instanceof NetDenied ||
    err instanceof PathDenied ||
    err instanceof BrowserDenied ||
    err instanceof InvalidBrokerRequest
    ? err.reason
    : 'error'
}

function targetOf(request: BrokerRequest): string | null {
  switch (request.capability) {
    case 'settings':
      // TODO 1225: values are not kept.
      return null
    case 'fs':
      return request.uri
    case 'network':
      // **Keep only the host, not the whole URL.** The query may contain values (the logging rules of chapter 7).
      return safeHost(request.url)
    case 'credentials':
      return request.name
    case 'index':
      return request.op === 'put' ? request.document.source : request.source
    case 'ui':
      return null
    case 'browser':
      // TODO 848: "URL in the audit log". Drop the query and fragment (they may contain values).
      return auditUrl(request.url)
    case 'triggers':
      // TODO 1216: only the trigger's id. Do not keep the key, title, or reference text (they may contain contents).
      return request.event.trigger
    default:
      return null
  }
}

/** TODO 1216: the reason an event was not accepted (the audit's `reason`). null if it was accepted. */
function triggerAuditReason(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const record = result as { accepted?: unknown; reason?: unknown }
  if (record.accepted === true) return null
  return typeof record.reason === 'string' && /^[a-z-]{1,32}$/.test(record.reason) ? record.reason : 'not-accepted'
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'invalid'
  }
}

/**
 * Whether it is valid UTF-8 (TODO 851). If `truncated` (more follows after the range), a partial character cut off at the end
 * (up to 3 bytes) is not counted as invalid.
 */
function isValidUtf8(buffer: Uint8Array, truncated: boolean): boolean {
  if (isUtf8(buffer)) return true
  if (!truncated) return false
  for (let cut = 1; cut <= 3 && cut < buffer.byteLength; cut += 1) {
    if (isUtf8(buffer.subarray(0, buffer.byteLength - cut))) return true
  }
  return false
}

/** Treated as binary if a NUL is mixed in (the same criterion as FsService). */
function looksBinary(buffer: Uint8Array): boolean {
  const limit = Math.min(buffer.byteLength, 8192)
  for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true
  return false
}

export { PathDenied, NetDenied }
