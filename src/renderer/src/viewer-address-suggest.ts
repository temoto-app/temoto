/**
 * The completion drop-down of the file viewer's address bar (TODO 1298, ARCHITECTURE 5.2.1). Pure functions only
 * (`test/viewer-address-suggest.test.ts`); the lookup and the drawing are in `ViewerAddressBar.tsx`.
 *
 * - Two kinds of rows: **file names inside the conversation's working folder** (the same file-name search as ⌘P, scoped
 *   to the cwd with `fs.searchFiles(…, scopeUri)`, at most 8, folders left out because the viewer opens files), and
 *   **one "Search Google for …" row** (no results are fetched; choosing it opens the search page in a Web tab).
 * - No working folder (an old row, a conversation without one): only the Google row.
 * - **A complete URL or path (`https://…`, `~/…`, `/…`, `file:`) gets no drop-down**, so Enter keeps opening it directly.
 *   Neither does a refused scheme (`javascript:` …): Enter shows the reason as before.
 * - Nothing is highlighted at first: Enter opens what was typed, as before. ↑ / ↓ pick a row (wrapping through "none").
 * - Nothing typed leaves the machine while typing: the file lookup is local, and Google sees the words only when its row
 *   is chosen.
 */
import type { FileEntry } from '@shared/types.js'
import { viewerAddressTarget } from '@shared/viewer-address.js'
import { googleSearchUrl } from '@shared/web-tabs.js'

/** At most this many file rows (owner decision 2026-11-22). The Google row comes on top of these. */
export const ADDRESS_FILE_LIMIT = 8

export type AddressSuggestion =
  | {
      readonly kind: 'file'
      readonly uri: string
      readonly name: string
      /** The path relative to the working folder (the parent folder part, shown dimly). */
      readonly path: string
    }
  | { readonly kind: 'google'; readonly query: string; readonly url: string }

/** The words to complete, or null when the drop-down should not open for this input. */
export function addressSuggestQuery(input: string | null): string | null {
  if (input === null) return null
  const text = input.trim()
  if (text === '') return null
  const target = viewerAddressTarget(text)
  if (target.kind === 'web' || target.kind === 'unsupported' || target.kind === 'none') return null
  if (target.kind === 'path' && (/^file:/i.test(text) || text.startsWith('~') || text.startsWith('/'))) return null
  return text
}

function withSlash(uri: string): string {
  return uri.endsWith('/') ? uri : `${uri}/`
}

/**
 * File rows from the scoped search's entries. Only files strictly inside `cwdUri` (the index process already scopes it;
 * this is the second look), folders dropped, the order kept, at most `limit`.
 */
export function addressFileRows(
  entries: readonly FileEntry[],
  cwdUri: string,
  limit: number = ADDRESS_FILE_LIMIT
): readonly AddressSuggestion[] {
  const prefix = withSlash(cwdUri)
  const rows: AddressSuggestion[] = []
  for (const entry of entries) {
    if (rows.length >= limit) break
    if (entry.isDirectory || !entry.uri.startsWith(prefix)) continue
    const relative = decodeSafe(entry.uri.slice(prefix.length))
    const cut = relative.lastIndexOf('/')
    rows.push({ kind: 'file', uri: entry.uri, name: entry.name, path: cut < 0 ? '' : relative.slice(0, cut) })
  }
  return rows
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** All rows of the drop-down: the file rows, then the Google row. */
export function addressSuggestions(query: string, files: readonly AddressSuggestion[]): readonly AddressSuggestion[] {
  return [...files, { kind: 'google', query, url: googleSearchUrl(query) }]
}

/** ↑ / ↓ in the drop-down. -1 is "nothing picked" (Enter opens what was typed); it sits between the last and the first row. */
export function moveAddressCursor(cursor: number, length: number, delta: 1 | -1): number {
  if (length <= 0) return -1
  const slots = length + 1
  const current = cursor < 0 || cursor >= length ? length : cursor
  const next = (current + delta + slots) % slots
  return next === length ? -1 : next
}
