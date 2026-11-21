/**
 * Relay for a plugin's search section (TODO 896, ARCHITECTURE 7.5.1). The main stage of renderer -> main -> plugin-host.
 *
 * - **Lookup**: it is redone on every call with `PluginHost.searchProviders()` (enabled, bundled, with a `searchProvider` declaration).
 *   A section of a plugin that is disabled, removed or external is answered with `unavailable` without starting plugin-host.
 * - **Cancellation**: when the next search arrives for the same section from the same window (`caller`), the previous call is dropped
 *   with an `AbortSignal` (the work inside plugin-host is not stopped, but its answer is discarded; the `signal` of `PluginHost.invoke`).
 * - **Re-checking** (`sanitizeSearchReturn`): the plugin's return value is not trusted. Shape, count (`MAX_PLUGIN_SEARCH_RESULTS`) and
 *   length are cut down, and the destination is checked against the manifest's `openWith` - `web` / `external` by `isWebViewerUrl`
 *   (http(s), has a host, no credentials), `viewer` only URIs of that plugin's `viewer.schemes`. Rows that do not pass are dropped and counted.
 * - **Logging**: one line per call (plugin id, count, success or failure, elapsed time). **The search term and result values are not kept**
 *   (the logging rule in Conventions). Results are only returned to the renderer and not stored.
 *
 * Plugin code does not run here (constraint 8) - `invoke` only throws to the plugin-host process. Failures are not thrown but returned as
 * an `error` reason code (the renderer turns it into text; a message the plugin threw is not passed on, since it may contain an external API's response).
 */
import type { HostExportKind } from '@shared/plugin.js'
import {
  MAX_PLUGIN_SEARCH_DESCRIPTION,
  MAX_PLUGIN_SEARCH_ID,
  MAX_PLUGIN_SEARCH_OPEN,
  MAX_PLUGIN_SEARCH_QUERY,
  MAX_PLUGIN_SEARCH_RESULTS,
  MAX_PLUGIN_SEARCH_SNIPPET,
  MAX_PLUGIN_SEARCH_TITLE,
  type PluginSearchArg,
  type PluginSearchError,
  type PluginSearchOpenWith,
  type PluginSearchResponse,
  type PluginSearchResult
} from '@shared/plugin-search.js'
import { isWebViewerUrl } from '@shared/open-external.js'
import { log } from '../../common/logger.js'
import type { EnabledSearchProvider } from './host.js'

/** Upper limit for one search (milliseconds). A slow external API response must not leave a section stuck at "searching". */
export const PLUGIN_SEARCH_TIMEOUT_MS = 20_000

/** The entry point borrowed from `PluginHost`. Tests pass a fake. */
export interface PluginSearchSource {
  searchProviders(): readonly EnabledSearchProvider[]
  invoke(
    pluginId: string,
    command: string,
    arg: unknown,
    kind: HostExportKind,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown>
}

function schemeOf(uri: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(uri)
  return match === null ? null : (match[1] ?? '').toLowerCase()
}

/** Whether a result's destination may be opened under the section's `openWith`. */
export function acceptsOpen(openWith: PluginSearchOpenWith, viewerSchemes: readonly string[], open: string): boolean {
  if (open.length === 0 || open.length > MAX_PLUGIN_SEARCH_OPEN) return false
  if (openWith === 'viewer') {
    const scheme = schemeOf(open)
    return scheme !== null && viewerSchemes.includes(scheme)
  }
  return isWebViewerUrl(open)
}

/** Turn control characters (including newlines and tabs) into spaces, trim both ends and cut at the limit. null if empty. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (text === '') return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Re-check a plugin's return value (supposed to be a `PluginSearchReturn`). A wrong shape gives null (reason `invalid`).
 * A defect in a row (missing id / title / open, a destination that does not pass, a duplicate id) drops that row and counts it in `dropped`.
 */
export function sanitizeSearchReturn(
  raw: unknown,
  openWith: PluginSearchOpenWith,
  viewerSchemes: readonly string[]
): { readonly results: PluginSearchResult[]; readonly dropped: number } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const list = (raw as { results?: unknown }).results
  if (!Array.isArray(list)) return null
  const results: PluginSearchResult[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const item of list) {
    if (results.length >= MAX_PLUGIN_SEARCH_RESULTS) {
      dropped += 1
      continue
    }
    if (typeof item !== 'object' || item === null) {
      dropped += 1
      continue
    }
    const record = item as Record<string, unknown>
    const id = typeof record['id'] === 'string' && record['id'].length <= MAX_PLUGIN_SEARCH_ID ? record['id'] : null
    const title = cleanText(record['title'], MAX_PLUGIN_SEARCH_TITLE)
    const open = typeof record['open'] === 'string' ? record['open'] : null
    if (id === null || id === '' || seen.has(id) || title === null || open === null || !acceptsOpen(openWith, viewerSchemes, open)) {
      dropped += 1
      continue
    }
    seen.add(id)
    const snippet = cleanText(record['snippet'], MAX_PLUGIN_SEARCH_SNIPPET)
    const description = cleanText(record['description'], MAX_PLUGIN_SEARCH_DESCRIPTION)
    results.push({
      id,
      title,
      ...(snippet === null ? {} : { snippet }),
      ...(description === null ? {} : { description }),
      open
    })
  }
  return { results, dropped }
}

/** Derive the reason from the failure message of `PluginHost.invoke` (the message is host.ts's). */
function failureOf(message: string): PluginSearchError {
  if (message === 'plugin invoke aborted') return 'cancelled'
  if (message === 'plugin invoke timeout' || message === 'plugin host timeout') return 'timeout'
  if (message.startsWith('plugin host exited') || message === 'plugin host stopped') return 'crashed'
  if (message === 'plugin not available' || message === 'undeclared-export' || message === 'plugin host is shutting down') {
    return 'unavailable'
  }
  return 'failed'
}

export class PluginSearchRelay {
  /** `<caller>\0<pluginId>` -> cancellation of the search currently running. */
  private readonly inflight = new Map<string, AbortController>()

  constructor(
    private readonly deps: {
      readonly source: PluginSearchSource
      readonly now?: () => number
      readonly timeoutMs?: number
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * Query `query` in the section `pluginId`. `caller` is the window (webContents id) - "the next search drops the previous one" is per window.
   * Values from the renderer are re-checked (is it a string, its length). Never throws.
   */
  async search(caller: number, pluginId: unknown, query: unknown): Promise<PluginSearchResponse> {
    const id = typeof pluginId === 'string' ? pluginId.slice(0, 64) : ''
    const text = typeof query === 'string' ? query.trim().slice(0, MAX_PLUGIN_SEARCH_QUERY) : ''
    const empty = (error: PluginSearchError | null): PluginSearchResponse => ({
      pluginId: id,
      query: text,
      results: [],
      error,
      dropped: 0
    })
    const provider = this.deps.source.searchProviders().find((entry) => entry.pluginId === id)
    if (provider === undefined) {
      log.info('plugin.search', { pluginId: id.slice(0, 64), ok: false, reason: 'unavailable' })
      return empty('unavailable')
    }
    // An empty term is not queried (the renderer does not call when it is empty, but just in case). Only the previous search is dropped.
    const key = `${caller}\u0000${id}`
    this.inflight.get(key)?.abort()
    this.inflight.delete(key)
    if (text === '') return empty(null)

    const controller = new AbortController()
    this.inflight.set(key, controller)
    const started = this.now()
    const arg: PluginSearchArg = { query: text, limit: MAX_PLUGIN_SEARCH_RESULTS }
    let raw: unknown
    try {
      raw = await this.deps.source.invoke(
        id,
        'query',
        arg,
        'search',
        this.deps.timeoutMs ?? PLUGIN_SEARCH_TIMEOUT_MS,
        controller.signal
      )
    } catch (err) {
      const reason = failureOf(err instanceof Error ? err.message : String(err))
      this.finish(key, controller, id, started, false, 0, reason)
      return empty(reason)
    }
    if (controller.signal.aborted) {
      this.finish(key, controller, id, started, false, 0, 'cancelled')
      return empty('cancelled')
    }
    const sanitized = sanitizeSearchReturn(raw, provider.declaration.openWith, provider.viewerSchemes)
    if (sanitized === null) {
      this.finish(key, controller, id, started, false, 0, 'invalid')
      return empty('invalid')
    }
    this.finish(key, controller, id, started, true, sanitized.results.length, null, sanitized.dropped)
    return { pluginId: id, query: text, results: sanitized.results, error: null, dropped: sanitized.dropped }
  }

  /** The window closed (or closed the section). Drop all searches running for that window. */
  cancelCaller(caller: number): void {
    const prefix = `${caller}\u0000`
    for (const [key, controller] of [...this.inflight]) {
      if (!key.startsWith(prefix)) continue
      controller.abort()
      this.inflight.delete(key)
    }
  }

  private finish(
    key: string,
    controller: AbortController,
    pluginId: string,
    started: number,
    ok: boolean,
    count: number,
    reason: PluginSearchError | null,
    dropped = 0
  ): void {
    if (this.inflight.get(key) === controller) this.inflight.delete(key)
    log.info('plugin.search', {
      pluginId,
      ok,
      count,
      ms: Math.max(0, this.now() - started),
      ...(dropped > 0 ? { dropped } : {}),
      ...(reason === null ? {} : { reason })
    })
  }
}
