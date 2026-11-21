/**
 * Pure functions for matching in in-thread search (TODO 496, ARCHITECTURE 5.1.7). They know neither the DOM nor React.
 *
 * The rules are aligned with body search and the viewer highlight:
 * - **How terms are split** is the same as the viewer highlight (`splitHighlightTerms` in `plugins/_shared/highlight.ts`, 431): split on whitespace
 *   (including full-width), and highlight each term **separately**. As with the index-side AND search (6.4), word order and adjacency do not matter.
 * - **smart case** (TODO 291): per term, only terms containing an uppercase letter are case-sensitive (`hasUpper` in `src/index-kernel/smart-case.ts`.
 *   The renderer does not import index-kernel, so the same check is copied here).
 * - **Full-width Latin letters** (TODO 301): both the terms and the body are folded with NFKC before comparing. However, **characters whose length changes are not folded**, because
 *   positions in the folded string are used as positions in the original text as they are (same idea as `foldCase` in `dom-highlight.ts`). Full-width alphanumerics
 *   (a full-width A becomes `A`) stay one character, so they are folded.
 *
 * Plugin code (`plugins/_shared/`) is not imported from the renderer (so the boundary gets no new direction). A small copy of the same idea
 * is placed here.
 */

export interface FindRange {
  readonly from: number
  readonly to: number
}

/** A term in the form used for matching. */
export interface FindTerm {
  /** Already NFKC'd (only characters whose length does not change). A term that is not case-sensitive is folded to lowercase. */
  readonly needle: string
  readonly caseSensitive: boolean
}

/** NFKC per character. Characters whose length changes are left as is (to keep positions). ASCII passes through. */
export function nfkcSameLength(text: string): string {
  let ascii = true
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) {
      ascii = false
      break
    }
  }
  if (ascii) return text
  let out = ''
  for (const ch of text) {
    const folded = ch.normalize('NFKC')
    out += folded.length === ch.length ? folded : ch
  }
  return out
}

/** Folds case. Characters whose length changes (e.g. `İ`) are not folded. */
export function foldCaseSameLength(text: string): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    out += lower.length === ch.length ? lower : ch
  }
  return out
}

/** Turns the search box string into terms. Splits on whitespace (including full-width) and drops empty ones and duplicates. */
export function findTerms(query: string | null | undefined): readonly FindTerm[] {
  if (query === null || query === undefined) return []
  const seen = new Set<string>()
  const out: FindTerm[] = []
  for (const raw of query.split(/[\s\u3000]+/u)) {
    const term = nfkcSameLength(raw.trim())
    if (term === '') continue
    // smart case (TODO 291): only terms containing an uppercase letter are case-sensitive.
    const caseSensitive = term !== term.toLowerCase()
    const needle = caseSensitive ? term : foldCaseSameLength(term)
    const key = `${caseSensitive ? 'C' : 'i'}:${needle}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ needle, caseSensitive })
  }
  return out
}

/** The body folded for matching (two forms, chosen per term). */
export interface FoldedText {
  readonly exact: string
  readonly lower: string
}

export function foldText(text: string): FoldedText {
  const exact = nfkcSameLength(text)
  return { exact, lower: foldCaseSameLength(exact) }
}

/**
 * Lists the matches of each term in `from` order. Matches within a term do not overlap (the next one is searched after the match found). Exactly the same range is
 * made one (two terms that differ only in case), and of overlapping ranges the earlier one is kept (DOM highlights are indistinguishable when overlapped, so
 * the way boxes are counted is fixed to one reading). Matches beyond the limit are not counted.
 */
export function findRanges(text: string | FoldedText, terms: readonly FindTerm[], limit = 5000): readonly FindRange[] {
  if (terms.length === 0) return []
  const folded = typeof text === 'string' ? foldText(text) : text
  const out: FindRange[] = []
  for (const term of terms) {
    const haystack = term.caseSensitive ? folded.exact : folded.lower
    const needle = term.needle
    let count = 0
    for (let at = haystack.indexOf(needle); at >= 0 && count < limit; at = haystack.indexOf(needle, at + needle.length)) {
      out.push({ from: at, to: at + needle.length })
      count += 1
    }
  }
  out.sort((a, b) => a.from - b.from || a.to - b.to)
  const kept: FindRange[] = []
  let end = -1
  for (const range of out) {
    if (range.from < end) continue
    kept.push(range)
    end = range.to
    if (kept.length >= limit) break
  }
  return kept
}

/** Whether any term is in the body (to decide if collapsed contents have a match, decision 5 of TODO 496). */
export function textHasMatch(text: string, terms: readonly FindTerm[]): boolean {
  if (terms.length === 0 || text === '') return false
  const folded = foldText(text)
  return terms.some((term) => (term.caseSensitive ? folded.exact : folded.lower).includes(term.needle))
}

/** Whether any term is case-sensitive (the `Aa` badge of the search box, how TODO 291 is shown). */
export function termsCaseSensitive(terms: readonly FindTerm[]): boolean {
  return terms.some((term) => term.caseSensitive)
}
