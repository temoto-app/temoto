/**
 * The search section a plugin adds to the search sidebar (TODO 896, ARCHITECTURE 7.5.1).
 *
 * - A plugin declares the section with `searchProvider` in the manifest and implements `search.query` of `host.entry`.
 *   **The search code runs in the plugin-host** (constraint 8), and sending to external APIs and credentials go through the Broker's `net.fetch`.
 * - What reaches the renderer is only **typed results** (title, excerpt, supplement, destination). Main re-validates the shape, count, length and destination.
 * - How the destination is handled is declared with `openWith` in the manifest: `web` (Web view) / `external` (default browser) /
 *   `viewer` (the plugin's own viewer; the scheme of the destination is one of that plugin's `viewer.schemes`).
 * - A search is issued on Enter, or when input has paused for `PLUGIN_SEARCH_DEBOUNCE_MS` (owner decision 2026-10-31.
 *   It calls an external API, so it is kept apart from the local search that queries on every keystroke).
 * - At first, **bundled plugins only** (owner decision 2026-10-31, the same as `activityBar` / `sidebarView`).
 *
 * There are no privileges here: only shapes and limits.
 */

/** Where results open. `searchProvider.openWith` of the manifest. */
export type PluginSearchOpenWith = 'web' | 'external' | 'viewer'

export const PLUGIN_SEARCH_OPEN_WITH: readonly PluginSearchOpenWith[] = ['web', 'external', 'viewer']

/** The `searchProvider` of the manifest (bundled plugins only). */
export interface SearchProviderDeclaration {
  /** The section heading (such as `Drive`). */
  readonly title: string
  /** The placeholder of the search field. If absent, the renderer builds it from the heading. */
  readonly placeholder?: string
  readonly openWith: PluginSearchOpenWith
}

/** From when input stops until the search is issued (milliseconds). Enter does not wait for this. */
export const PLUGIN_SEARCH_DEBOUNCE_MS = 500
/** Upper limit of results passed to the renderer per search. Main drops the excess. */
export const MAX_PLUGIN_SEARCH_RESULTS = 50
/** Upper limit of the length of the search term (characters). */
export const MAX_PLUGIN_SEARCH_QUERY = 256
export const MAX_PLUGIN_SEARCH_ID = 128
export const MAX_PLUGIN_SEARCH_TITLE = 200
export const MAX_PLUGIN_SEARCH_SNIPPET = 400
export const MAX_PLUGIN_SEARCH_DESCRIPTION = 120
export const MAX_PLUGIN_SEARCH_OPEN = 2048

/** The argument that a plugin's `search.query` receives. */
export interface PluginSearchArg {
  readonly query: string
  /** Upper limit of the number of results that may be returned (`MAX_PLUGIN_SEARCH_RESULTS`). */
  readonly limit: number
}

/** One result. The plugin returns it, and main re-validates it before passing it to the renderer. */
export interface PluginSearchResult {
  /** Unique within the plugin (the row key). */
  readonly id: string
  /** The first line (subject, file name, etc.). */
  readonly title: string
  /** The excerpt on the second line. Plain text (HTML is not rendered). */
  readonly snippet?: string
  /** A supplement shown faintly to the right of the title (sender, date, etc.). */
  readonly description?: string
  /** The destination. An http(s) URL if `openWith` is `web` / `external`, the URI of the plugin's own viewer if `viewer`. */
  readonly open: string
}

/** The shape that a plugin's `search.query` returns. */
export interface PluginSearchReturn {
  readonly results: readonly PluginSearchResult[]
}

/**
 * Why a search could not return results (the renderer turns it into text).
 * - `unavailable`: no plugin, disabled, it does not declare a section, or it is not bundled
 * - `timeout` / `crashed`: the plugin-host did not answer in time / died midway
 * - `failed`: the plugin threw (the reason text is not passed to the renderer, since an external API's response may be mixed in)
 * - `invalid`: the return value is not in the shape of `PluginSearchReturn`
 * - `cancelled`: the next search of the same section started (the renderer discards it)
 */
export type PluginSearchError = 'unavailable' | 'timeout' | 'crashed' | 'failed' | 'invalid' | 'cancelled'

/** The answer to one search that main returns to the renderer. */
export interface PluginSearchResponse {
  readonly pluginId: string
  readonly query: string
  readonly results: readonly PluginSearchResult[]
  readonly error: PluginSearchError | null
  /** The total of the number dropped because the shape or destination did not pass and the number dropped for exceeding the limit (nothing is dropped silently). */
  readonly dropped: number
}
