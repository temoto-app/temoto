/**
 * Matching rules of file-name search (ARCHITECTURE.md 6.6). Holds **pure functions only**:
 * they touch neither SQL nor fs, so the rules themselves can be pinned directly in `test/file-search.test.ts`.
 *
 * The rules were moved as they are from qlm (`src/kbFiles.js` of `/Users/axkzm/git/qlm`, and the readme.md section
 * "Search matching rules (VSCode Quick Open style, 2026-08-26)"):
 *
 * - The query is split into terms on whitespace, and **all terms are ANDed**. If even one term fails, no match.
 * - Each term is a **contiguous match (substring) only**. Subsequence (scattered) matching is not used.
 *   qlm once added a VSCode-faithful scattered match and **withdrew it the same day**
 *   (`ax pdf` hit `axi-spdif.c` and returned 52,998 results, so it did not narrow anything).
 *   **If it is ever revived, first decide how to sink this noise in the ranking.**
 * - Each term gets a tier: prefix match on the name 0 / substring match on the name 1 / substring match on the path 2.
 * - A term containing `/` or `\` is matched **against the path only** (a `\` in the query is folded to `/`).
 * - The fold is **NFKC + lowercasing**. A full-width space (U+3000) is also folded to a half-width one by NFKC, so
 *   terms split even with Japanese input left on.
 * - **The query is never turned into a regular expression** (only `indexOf` / `startsWith`. The `/\s+/u` used for splitting is
 *   a constant, not derived from the query). No per-character bonuses or highlighting are introduced.
 *
 * - **smart case (TODO 291)**: a term containing an uppercase letter (`term !== term.toLowerCase()` after NFKC) is compared
 *   against the name and parent path side **in NFKC without lowercasing** as well. The decision is per term (for `System config`,
 *   only `System` is case-sensitive). The rule itself is in `smart-case.ts`.
 *
 * There are only two differences specific to aios:
 *
 * 1. `documents.name_folded` is NFC + lowercase and is the **key of identity** (the unique index of
 *    `documents_tree`), so its folding cannot be changed (NFKC treats `①` and `1` as the same,
 *    so different files would collapse into one row). The folding for matching is done here on the JS side.
 * 2. Rows have no absolute path (6.3). Path matching is done against the "parent directory's path",
 *    and directory paths are assembled from the scanned tree (`DirectoryPaths`).
 *    A term without `/` cannot span a `/`, so it is exactly equal to "hits the name or hits the parent's path",
 *    and only a term containing `/` needs a separate check for the case spanning the last boundary.
 */

import { hasUpper, nfkc } from './smart-case.js'

/** One term to match. `path` = contains `/` (= matched against the path only). */
export interface NameTerm {
  readonly text: string
  readonly path: boolean
  /**
   * A term containing an uppercase letter (smart case, TODO 291). `text` is not lowercased, and it is compared with the name / path side
   * in NFKC without lowercasing (`casedName` of `matchName` / `DirectoryTree.casedDirPaths`).
   */
  readonly cased: boolean
  /** For `path`: the part before the last `/` (what is required at the end of the parent path). */
  readonly head: string
  /** For `path`: the part after the last `/` (what is required at the start of the file name). */
  readonly tail: string
}

/** How one term matched. The smaller the `tier`, the better. */
export interface TermHit {
  readonly tier: 0 | 1 | 2
  readonly pos: number
}

/**
 * Folding for matching (NFKC + lowercasing).
 *
 * For ASCII-only strings NFKC does nothing, so `normalize` is not called.
 * One query folds the names of a million entries, so the ICU calls here are directly what the user feels
 * (measurements are in the table of ARCHITECTURE.md 6.6).
 */
export function foldForMatch(value: string): string {
  return nfkc(value).toLowerCase()
}

/**
 * Query -> list of terms. A whitespace-only query gives an empty array (= no search).
 * Smart case is decided per term (a term with an uppercase letter is not lowercased, TODO 291).
 */
export function parseNameQuery(query: string): readonly NameTerm[] {
  const normalized = nfkc(query).replaceAll('\\', '/')
  const terms: NameTerm[] = []
  for (const raw of normalized.split(/\s+/u)) {
    if (raw === '') continue
    const cased = hasUpper(raw)
    const text = cased ? raw : raw.toLowerCase()
    const cut = text.lastIndexOf('/')
    terms.push({
      text,
      path: cut >= 0,
      cased,
      head: cut >= 0 ? text.slice(0, cut) : '',
      tail: cut >= 0 ? text.slice(cut + 1) : ''
    })
  }
  return terms
}

/**
 * Matches a term against a name (tier 0 / 1). A term containing `/` never hits a name.
 * `casedName` is the name in NFKC without lowercasing (used only by terms with an uppercase letter. When omitted, `foldedName`).
 */
export function matchName(
  term: NameTerm,
  foldedName: string,
  casedName: string = foldedName
): TermHit | null {
  if (term.path) return null
  const at = (term.cased ? casedName : foldedName).indexOf(term.text)
  if (at === 0) return { tier: 0, pos: 0 }
  if (at > 0) return { tier: 1, pos: at }
  return null
}

/**
 * The part of matching a term against a directory path that **does not depend on the per-row name**.
 * Computed only once per directory and reused (`DirTermIndex`).
 */
export interface DirTermState {
  /** The position of the hit inside the parent path. -1 if it does not hit. */
  readonly inPos: number
  /** For a term containing `/`: the parent path ends with `head` (= it can span the last boundary). */
  readonly boundary: boolean
  /** The match position when it spans. */
  readonly boundaryPos: number
}

/** The caller chooses `foldedDirPath` to suit the term (for a term with an uppercase letter, the path without lowercasing). */
export function dirStateOf(term: NameTerm, foldedDirPath: string): DirTermState {
  const inPos = foldedDirPath.indexOf(term.text)
  if (!term.path) return { inPos, boundary: false, boundaryPos: -1 }
  // The boundary can be spanned only at the last `/`: a name never contains `/`, so
  // a split where `tail` contains `/` cannot hold.
  const boundary = foldedDirPath.endsWith(term.head)
  return {
    inPos,
    boundary,
    boundaryPos: boundary ? foldedDirPath.length - term.head.length : -1
  }
}

/** Matches a term against the path (tier 2). `state` is the part reused per parent directory. */
export function matchPath(
  term: NameTerm,
  state: DirTermState,
  foldedName: string,
  casedName: string = foldedName
): TermHit | null {
  if (state.inPos >= 0) return { tier: 2, pos: state.inPos }
  if (!term.path || !state.boundary) return null
  if (!(term.cased ? casedName : foldedName).startsWith(term.tail)) return null
  return { tier: 2, pos: state.boundaryPos }
}

/** How one row matched. Holds only the values used for ranking. */
export interface NameMatch {
  readonly id: number
  readonly tierSum: number
  readonly posSum: number
  readonly nameLen: number
  readonly parentId: number | null
  readonly foldedName: string
  /** A folder row (TODO 436). With the same tier sum, files come first and folders after. */
  readonly isDirectory?: boolean
}

/**
 * Order (same as qlm): sum of tiers -> (TODO 436) files first, folders after -> sum of match positions ->
 * shorter names first -> path order.
 *
 * qlm's "path order" is a single `localeCompare` of the relative path, but aios rows have no
 * path, so it is decomposed into **parent directory path -> name** (which gives the same order).
 * Finally the id is added so that the order is fixed without depending on there being no same-name entries in the same directory.
 */
export function compareMatches(
  a: NameMatch,
  b: NameMatch,
  dirPath: (id: number | null) => string
): number {
  return (
    a.tierSum - b.tierSum ||
    (a.isDirectory === true ? 1 : 0) - (b.isDirectory === true ? 1 : 0) ||
    a.posSum - b.posSum ||
    a.nameLen - b.nameLen ||
    dirPath(a.parentId).localeCompare(dirPath(b.parentId)) ||
    a.foldedName.localeCompare(b.foldedName) ||
    a.id - b.id
  )
}
