/**
 * Pure functions for smart case (TODO 291, the same idea as `smartcase` in ripgrep / vim).
 *
 * - The query is split into terms on whitespace, and **each term** is judged (owner decision (1)). For `System config`,
 *   only `System` is case-sensitive, and `config` is not.
 * - The judgment is after NFKC: `term !== term.toLowerCase()`. Full-width Latin letters are folded to the half-width
 *   `System` before looking, so they fall on the case-sensitive side. Non-ASCII capitals (`Ä`, Greek letters) are also caught.
 * - It is about case **only**. Diacritics are folded as they are now (matching FTS5's `remove_diacritics 2`).
 * - Japanese (kana, kanji) has no case, so a term made only of Japanese is on the case-insensitive side.
 *
 * File name search uses it per term in `name-search.ts`, and body search uses it in `IndexService.search`
 * to re-check FTS5 candidates against the canonical copy (`CaseFilter`).
 */

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return false
  }
  return true
}

/** NFKC only (no lowercasing). ASCII skips `normalize` (the same optimization as T8). */
export function nfkc(value: string): string {
  return isAscii(value) ? value : value.normalize('NFKC')
}

/** Whether an NFKC-normalized term contains an uppercase letter (= is a case-sensitive term). */
export function hasUpper(term: string): boolean {
  return term !== term.toLowerCase()
}

/** Whether any term in the query is case-sensitive (the basis for the renderer's `Aa` badge). */
export function isCaseSensitiveQuery(query: string): boolean {
  return hasUpper(nfkc(query))
}

/**
 * Strips diacritics (NFD → remove combining marks). An approximation of `remove_diacritics 2`,
 * applied to **both sides** when re-checking a term with uppercase (the term `Café` also matches a body with `Cafe`).
 */
function stripMarks(value: string): string {
  if (isAscii(value)) return value
  return value.normalize('NFD').replace(/\p{M}+/gu, '')
}

/** A run of cased letters and digits (the part corresponding to an FTS5 term). Kana and kanji (`Lo`) are break points. */
const CASED_RUN = /[\p{Lu}\p{Ll}\p{Lt}\p{N}]+/gu

/**
 * Re-check for body search (TODO 291). FTS5 folds case at indexing time,
 * so after fetching candidates, we check whether the matching range of the canonical copy contains the needle **with its case as is**.
 *
 * The needle is only the runs that contain uppercase within a "term with uppercase" (for `System` followed by Japanese text, that is `System`).
 * The Japanese part was matched by kuromoji's word segmentation, so it is not required to
 * appear in the body as a contiguous substring. Symbols are also break points in FTS5, so they are not part of the needle
 * (`Foo.Bar` is `Foo` and `Bar`). If there is no needle at all, null (= no re-check).
 */
export class CaseFilter {
  private constructor(readonly needles: readonly string[]) {}

  static of(query: string): CaseFilter | null {
    const needles: string[] = []
    for (const term of nfkc(query).split(/\s+/u)) {
      if (term === '' || !hasUpper(term)) continue
      for (const run of stripMarks(term).match(CASED_RUN) ?? []) {
        if (hasUpper(run) && !needles.includes(run)) needles.push(run)
      }
    }
    return needles.length === 0 ? null : new CaseFilter(needles)
  }

  /** Whether the matching range of the canonical copy contains all the uppercase needles (with case as is). */
  accepts(text: string): boolean {
    const haystack = stripMarks(nfkc(text))
    return this.needles.every((needle) => haystack.includes(needle))
  }
}
