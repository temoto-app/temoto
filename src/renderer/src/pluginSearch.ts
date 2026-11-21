/**
 * State and pure functions of the plugin sections of the search sidebar (TODO 896, ARCHITECTURE 7.5.1). Rendering is in `components/SearchMode.tsx`.
 *
 * - The plugins that show a section are those with `PluginSummary.searchProvider` (main puts it only on bundled plugins), and only the enabled ones.
 * - **A search is run on Enter, or when input has paused for `PLUGIN_SEARCH_DEBOUNCE_MS`** (owner decision 2026-10-31).
 *   Kept apart from the 3 local windows (a 150 ms debounce, per keystroke) because this calls an external API.
 * - Results are a typed shape (`PluginSearchResult`) that main re-validated. How the destination is handled is the section's `openWith`.
 *
 * Do not build values in a selector (a Phase 2 pitfall): the empty default is a module constant.
 */
import { create } from 'zustand'
import type { PluginSummary } from '@shared/plugin.js'
import {
  PLUGIN_SEARCH_DEBOUNCE_MS,
  type PluginSearchError,
  type PluginSearchOpenWith,
  type PluginSearchResult
} from '@shared/plugin-search.js'

/** One section as the renderer sees it. */
export interface PluginSearchProvider {
  readonly pluginId: string
  readonly title: string
  readonly placeholder: string | null
  readonly openWith: PluginSearchOpenWith
}

/** Marker for focus on a section's search field (`focused` of `SearchMode`). Sits alongside the local windows (`SearchTarget`). */
export type PluginSearchTarget = `plugin:${string}`

export function pluginSearchTarget(pluginId: string): PluginSearchTarget {
  return `plugin:${pluginId}`
}

/** Plugins that are enabled and have `searchProvider`, in heading order. */
export function pluginSearchProviders(list: readonly PluginSummary[] | null): readonly PluginSearchProvider[] {
  if (list === null) return NO_PROVIDERS
  const out = list
    .filter((plugin) => plugin.enabled && plugin.searchProvider !== undefined)
    .map((plugin) => ({
      pluginId: plugin.id,
      title: plugin.searchProvider?.title ?? plugin.displayName,
      placeholder: plugin.searchProvider?.placeholder ?? null,
      openWith: plugin.searchProvider?.openWith ?? 'web'
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.pluginId.localeCompare(b.pluginId))
  return out.length === 0 ? NO_PROVIDERS : out
}

export const NO_PROVIDERS: readonly PluginSearchProvider[] = []
export const NO_RESULTS: readonly PluginSearchResult[] = []

export interface ProviderSearchState {
  /** The field's contents. */
  readonly draft: string
  /** The search term last run (being run). If empty, the section shows no results. */
  readonly query: string
  readonly results: readonly PluginSearchResult[]
  readonly searching: boolean
  /** `cancelled` is not kept (dropped). */
  readonly error: Exclude<PluginSearchError, 'cancelled'> | null
  readonly dropped: number
}

export const IDLE_PROVIDER: ProviderSearchState = {
  draft: '',
  query: '',
  results: NO_RESULTS,
  searching: false,
  error: null,
  dropped: 0
}

interface PluginSearchState {
  readonly byPlugin: Readonly<Record<string, ProviderSearchState>>
  /** Typed into the field. Run once it has paused for `PLUGIN_SEARCH_DEBOUNCE_MS` (clearing the field clears the results). */
  setDraft(pluginId: string, draft: string): void
  /** Enter. Run without waiting (even with the same term, search again: an explicit action). */
  submit(pluginId: string): void
}

/** Per-section debounce timers and request numbers (kept out of state because they do not affect rendering). */
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const requests = new Map<string, number>()

export const usePluginSearch = create<PluginSearchState>((set, get) => {
  const patch = (pluginId: string, next: Partial<ProviderSearchState>): void => {
    const current = get().byPlugin[pluginId] ?? IDLE_PROVIDER
    set({ byPlugin: { ...get().byPlugin, [pluginId]: { ...current, ...next } } })
  }

  const run = (pluginId: string): void => {
    const timer = timers.get(pluginId)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(pluginId)
    const query = (get().byPlugin[pluginId] ?? IDLE_PROVIDER).draft.trim()
    const request = (requests.get(pluginId) ?? 0) + 1
    requests.set(pluginId, request)
    if (query === '') {
      patch(pluginId, { query: '', results: NO_RESULTS, searching: false, error: null, dropped: 0 })
      return
    }
    patch(pluginId, { query, searching: true, error: null })
    void window.aios.plugins.search(pluginId, query).then(
      (response) => {
        // If the next search has started (including a `cancelled` that main dropped), discard.
        if (requests.get(pluginId) !== request || response.error === 'cancelled') return
        patch(pluginId, {
          results: response.results.length === 0 ? NO_RESULTS : response.results,
          searching: false,
          error: response.error,
          dropped: response.dropped
        })
      },
      () => {
        if (requests.get(pluginId) !== request) return
        patch(pluginId, { results: NO_RESULTS, searching: false, error: 'failed', dropped: 0 })
      }
    )
  }

  return {
    byPlugin: {},
    setDraft(pluginId: string, draft: string): void {
      patch(pluginId, { draft })
      const timer = timers.get(pluginId)
      if (timer !== undefined) clearTimeout(timer)
      timers.set(
        pluginId,
        setTimeout(() => {
          timers.delete(pluginId)
          // If the term at the moment it paused is the same as the one already run (being run), do not search again (it paused after being run by Enter,
          // or only trailing whitespace was typed, etc.). If it failed, search again.
          const state = get().byPlugin[pluginId] ?? IDLE_PROVIDER
          if (state.draft.trim() === state.query && state.error === null) return
          run(pluginId)
        }, PLUGIN_SEARCH_DEBOUNCE_MS)
      )
    },
    submit(pluginId: string): void {
      run(pluginId)
    }
  }
})

/** Rows (for the sections) lined up in `SearchMode`'s single virtual list. */
export type PluginSearchRow =
  | { readonly kind: 'header'; readonly id: string; readonly label: string }
  | { readonly kind: 'note'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'plugin'
      readonly id: string
      readonly pluginId: string
      readonly openWith: PluginSearchOpenWith
      readonly result: PluginSearchResult
      readonly section: PluginSearchTarget
    }

export interface PluginSearchLabels {
  readonly section: (title: string, count: number) => string
  readonly searching: string
  readonly empty: string
  readonly dropped: (n: number) => string
  readonly error: (code: Exclude<PluginSearchError, 'cancelled'>) => string
}

/**
 * Per section: "heading -> results (or a single notice row)". A section with no search term shows nothing.
 * While searching, if there are previous results they stay shown (the heading count stays as before); if not, "Searching…".
 */
export function pluginSearchRows(
  providers: readonly PluginSearchProvider[],
  byPlugin: Readonly<Record<string, ProviderSearchState>>,
  labels: PluginSearchLabels
): PluginSearchRow[] {
  const out: PluginSearchRow[] = []
  for (const provider of providers) {
    const state = byPlugin[provider.pluginId] ?? IDLE_PROVIDER
    if (state.query === '') continue
    const prefix = `p-${provider.pluginId}`
    out.push({ kind: 'header', id: `h-${prefix}`, label: labels.section(provider.title, state.results.length) })
    if (state.error !== null) {
      out.push({ kind: 'note', id: `${prefix}-error`, text: labels.error(state.error) })
      continue
    }
    if (state.results.length === 0) {
      out.push({ kind: 'note', id: `${prefix}-note`, text: state.searching ? labels.searching : labels.empty })
      continue
    }
    for (const result of state.results) {
      out.push({
        kind: 'plugin',
        id: `${prefix}-${result.id}`,
        pluginId: provider.pluginId,
        openWith: provider.openWith,
        result,
        section: pluginSearchTarget(provider.pluginId)
      })
    }
    if (state.dropped > 0) out.push({ kind: 'note', id: `${prefix}-dropped`, text: labels.dropped(state.dropped) })
  }
  return out
}

/** The means of opening a result. Tests pass fakes. */
export interface PluginResultOpeners {
  readonly web: (url: string) => void
  readonly external: (url: string) => void
  readonly viewer: (uri: string) => void
}

/** Open according to the section's `openWith` (main already validated the destination via `openWith`. Each entry point that opens also re-validates). */
export function openPluginResult(openWith: PluginSearchOpenWith, open: string, openers: PluginResultOpeners): void {
  if (openWith === 'viewer') openers.viewer(open)
  else if (openWith === 'external') openers.external(open)
  else openers.web(open)
}
