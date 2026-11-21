/**
 * Highlights in-file search terms in the source view (ARCHITECTURE.md 7.4.3, TODO 56).
 *
 * The host puts the search-field string as is in `ViewerHostMessage.highlightQuery`.
 * Both splitting out the terms and enumerating the matches are done **here (inside the iframe)**, touching neither
 * the host nor the Broker. Matching uses `@codemirror/search`'s `SearchQuery` (literal / case-insensitive),
 * which reads the same way as the search panel (Mod-f).
 *
 * Multiple terms are split on whitespace and **each term** is lit separately. This is the same as the index side's (6.4) AND search:
 * word order and adjacency do not matter.
 */
import type { Text } from '@codemirror/state'
import { SearchQuery } from '@codemirror/search'

export interface HighlightRange {
  readonly from: number
  readonly to: number
}

/** Splits the search-field string into terms. Separated by whitespace (including full-width), with empty ones and duplicates dropped. */
export function splitHighlightTerms(query: string | null | undefined): readonly string[] {
  if (query === null || query === undefined) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of query.split(/[\s\u3000]+/u)) {
    const term = raw.trim()
    if (term === '' || seen.has(term)) continue
    seen.add(term)
    out.push(term)
  }
  return out
}

/**
 * Enumerates the matches of each term in `from` order. Terms may overlap each other
 * (mark decorations can overlap). The limit is insurance for rendering; matches beyond it are not lit.
 *
 * **The limit is counted "from the head of all terms sorted in `from` order" (TODO 431 (a)).** It used to count in term order and
 * cut everything off at the limit, so `limit = 1` meant "the first match of the first term" and skipped a match of the second term that
 * comes earlier in the document (= the "first" centered on opening was not the first in the document).
 * Now matches are gathered up to the limit per term, then sorted and cut, so for any limit the result is "N matches from the start of the document".
 */
export function findHighlightRanges(
  doc: Text,
  terms: readonly string[],
  limit = 5000
): readonly HighlightRange[] {
  const out: HighlightRange[] = []
  for (const term of terms) {
    const query = new SearchQuery({ search: term, caseSensitive: false, literal: true })
    // `getCursor` returns an Iterator, not an Iterable, so `for…of` cannot be used.
    const cursor = query.getCursor(doc)
    let count = 0
    for (let step = cursor.next(); !step.done && count < limit; step = cursor.next()) {
      const match = step.value
      if (match.from === match.to) continue
      out.push({ from: match.from, to: match.to })
      count += 1
    }
  }
  out.sort((a, b) => a.from - b.from || a.to - b.to)
  // Terms that differ only in case (`foo` and `FOO`) hit the same range. So that the box's "n / N" (TODO 431) does not count the same match
  // twice, an identical range is made one.
  const unique = out.filter((range, i) => i === 0 || range.from !== out[i - 1]!.from || range.to !== out[i - 1]!.to)
  return unique.length > limit ? unique.slice(0, limit) : unique
}
