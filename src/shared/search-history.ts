/**
 * History of the sidebar search box (TODO 900, wave 47 bundle C). Pure functions independent of electron and the DB.
 *
 * The 3 windows (in files / file names / in conversations) share one history, and an entry carries the search mode (TODO 1157). Newest first, duplicates are moved to the front, at most 20.
 * Search terms may contain secrets, so they are not written to the log (saved in the encrypted DB's `app_settings`, owned by main).
 */

/** How many to keep (owner decision 2026-10-20: 20). */
export const SEARCH_HISTORY_MAX = 20

/** Maximum length of one entry (in UTF-16 units). So that pasted long text does not pile up in the history. */
export const SEARCH_HISTORY_MAX_LENGTH = 200

/** Arranges a term into one allowed in the history. null if empty or too long. */
export function normalizeHistoryQuery(query: unknown): string | null {
  if (typeof query !== 'string') return null
  const trimmed = query.trim()
  if (trimmed === '' || trimmed.length > SEARCH_HISTORY_MAX_LENGTH) return null
  return trimmed
}

/** The mode attached to a history entry (the sidebar's 3 fields. TODO 1157). */
export type SearchHistoryMode = 'files' | 'names' | 'conversation'

export const SEARCH_HISTORY_MODES: readonly SearchHistoryMode[] = ['files', 'names', 'conversation']

/** One history entry. The same term with a different mode is a different entry. */
export interface SearchHistoryEntry {
  readonly query: string
  readonly mode: SearchHistoryMode
}

export function isSearchHistoryMode(value: unknown): value is SearchHistoryMode {
  return typeof value === 'string' && (SEARCH_HISTORY_MODES as readonly string[]).includes(value)
}

/** Arranges an entry. null for a broken element or an unknown mode. */
export function normalizeHistoryEntry(query: unknown, mode: unknown): SearchHistoryEntry | null {
  const q = normalizeHistoryQuery(query)
  if (q === null || !isSearchHistoryMode(mode)) return null
  return { query: q, mode }
}

const same = (a: SearchHistoryEntry, b: SearchHistoryEntry): boolean => a.query === b.query && a.mode === b.mode

/**
 * Turns a saved value (read from JSON) into a validated history. Broken elements are dropped, and duplicates (the query + mode pair) and the excess count are arranged too.
 * The old format (strings only. Before TODO 1157) has no mode, so it is read as `files`.
 */
export function sanitizeHistory(value: unknown): readonly SearchHistoryEntry[] {
  if (!Array.isArray(value)) return []
  const out: SearchHistoryEntry[] = []
  for (const item of value) {
    const entry =
      typeof item === 'string'
        ? normalizeHistoryEntry(item, 'files')
        : typeof item === 'object' && item !== null
          ? normalizeHistoryEntry((item as { query?: unknown }).query, (item as { mode?: unknown }).mode)
          : null
    if (entry === null || out.some((o) => same(o, entry))) continue
    out.push(entry)
    if (out.length >= SEARCH_HISTORY_MAX) break
  }
  return out
}

/** A history with the entry added at the front (the same query + mode are merged into one). Unchanged if it cannot be added. */
export function pushHistory(
  history: readonly SearchHistoryEntry[],
  query: unknown,
  mode: unknown
): readonly SearchHistoryEntry[] {
  const entry = normalizeHistoryEntry(query, mode)
  if (entry === null) return history
  return [entry, ...history.filter((item) => !same(item, entry))].slice(0, SEARCH_HISTORY_MAX)
}

/** A history without the entry (query + mode). */
export function removeFromHistory(
  history: readonly SearchHistoryEntry[],
  query: unknown,
  mode: unknown
): readonly SearchHistoryEntry[] {
  const entry = normalizeHistoryEntry(query, mode)
  if (entry === null) return history
  return history.filter((item) => !same(item, entry))
}
