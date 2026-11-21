/**
 * The execution part of file-name search (ARCHITECTURE.md 6.6). The matching rules themselves live in
 * `name-search.ts` (pure functions); this file only decides "how candidates are supplied".
 *
 * **The problem this fixed (TODO 9)**: it used to be a single `name_folded LIKE '%q%'`. The leading `%`
 * defeats the index, so it read every page of `documents` = decrypting a 2.9 GB encrypted DB
 * with ChaCha20, which took **over 2 minutes** at 1.15 million rows.
 * better-sqlite3 has a synchronous API, so main's whole event loop stopped for that time
 * (this is why it "froze" rather than "was slow"; the same shape as the post-scan cleanup).
 *
 * **How it works**:
 *
 * 1. Candidates are read from one end of the **covering partial index** of migration 8,
 *    `documents_name_scan (id, name, parent_id) WHERE source = 'fs'`. The table rows are never touched, so only
 *    index pages get decrypted (measured at 1/40 or less of the table).
 * 2. Reading is done in **pages of a fixed row count**; each page completes its statement and then
 *    awaits `yieldToEventLoop()`. **An iterator is never left open across a wait**:
 *    better-sqlite3 cannot run another statement on the same connection then, and IndexService
 *    writes would fail with `This database connection is busy`.
 *    This keeps "IndexService is the only index writer" (6.2) intact
 *    (a second read-only connection is **not created**).
 * 3. Matching is done on the JS side. SQL cannot express the tier or path matching, and even if it could,
 *    the index would not help and we would be back to the same problem.
 * 4. Path matching (tier 2) builds a **folded table of directory paths** once and reuses it.
 *    A term without `/` cannot span a `/`, so it is exactly equal to "hits the name or hits the parent's path".
 *    Only terms containing `/` need a separate check for the case spanning the last boundary
 *    (`dirStateOf` / `matchPath`).
 * 5. **Truncation is always declared**: the top `limit` + the total hit count + `truncated` /
 *    `scanTruncated`. Nothing is dropped silently (the same promise as qlm).
 */
import { yieldToEventLoop } from '../common/batch.js'
import type { IndexStore } from './store.js'
import { directoryTreeOf, type DirectoryTree } from './cwd-scope.js'
import {
  compareMatches,
  dirStateOf,
  foldForMatch,
  matchName,
  matchPath,
  parseNameQuery,
  type DirTermState,
  type NameMatch,
  type NameTerm
} from './name-search.js'
import { nfkc } from './smart-case.js'

/** Rows read per SQL statement. Sized so that one page is processed in a few ms. */
const PAGE_ROWS = 20_000
/** Time allowed for one query's scan. When exceeded, it stops and declares `scanTruncated`. */
const BUDGET_MS = 3_000
/** Maximum number of matches kept for ranking (per section). Matches beyond it are only counted. */
const MAX_MATCHES = 50_000
/**
 * The cwd's subtree is walked separately and first only when the subtree's directories are at most this fraction of all directories
 * (item 100). Above it (the cwd is the home directory, etc.) the matches are just sorted into sections within the single whole-index scan:
 * reading a subtree looks up names in the table from the `parent_id` index (not a covering index), so
 * it costs several times the whole-index scan per row, and with a large tree the double read makes it slower.
 * The value comes from the measurements of `scripts/bench/cwd-search.mts` (ARCHITECTURE.md 6.6.7).
 */
const CWD_PASS_MAX_SHARE = 1 / 8
/** Number of directories read together at once when walking the cwd's subtree (returns to the event loop in between). */
const CWD_DIRS_PER_STEP = 200

/** Result of one section (inside the cwd / the whole index). */
export interface FileSearchSection {
  /** `documents.id` of the top `limit` results (in rank order). */
  readonly ids: readonly number[]
  /** Total number of matches (exact up to `MAX_MATCHES`; counting continues after that). */
  readonly total: number
  /** The total is larger than the number returned. */
  readonly truncated: boolean
  /** The scan of this section was cut off by the time limit / the count limit. */
  readonly scanTruncated: boolean
}

export interface FileSearchOutcome extends FileSearchSection {
  /**
   * The section inside the cwd (item 100). null when no cwd was passed / it is not in the index.
   * The main part (`ids` / `total` …) becomes the section of the **whole index minus what is inside the cwd**.
   */
  readonly cwd: FileSearchSection | null
  /** A term contained an uppercase letter, and that term was matched case-sensitively (smart case, TODO 291). */
  readonly caseSensitive: boolean
  /** Dropped because a newer query overtook it. */
  readonly cancelled: boolean
  readonly tookMs: number
}

export interface FileSearchLimits {
  readonly pageRows?: number
  readonly budgetMs?: number
  readonly maxMatches?: number
  /** 0 to 1. Tests set it to 1 so that even a small tree walks the subtree first. */
  readonly cwdPassMaxShare?: number
}

const EMPTY: FileSearchOutcome = {
  ids: [],
  total: 0,
  truncated: false,
  scanTruncated: false,
  cwd: null,
  caseSensitive: false,
  cancelled: false,
  tookMs: 0
}

/** Directory id -> folded absolute path (the root is the empty string). */
type DirPaths = ReadonlyMap<number, string>

/** A box that collects the matches of one section. */
class Bucket {
  readonly matches: NameMatch[] = []
  total = 0
  overflow = false

  constructor(private readonly max: number) {}

  add(match: NameMatch): void {
    this.total += 1
    if (this.matches.length < this.max) this.matches.push(match)
    else this.overflow = true
  }

  finish(
    limit: number,
    dirPathOf: (id: number | null) => string,
    scanTruncated: boolean
  ): FileSearchSection {
    this.matches.sort((a, b) => compareMatches(a, b, dirPathOf))
    const ids = this.matches.slice(0, limit).map((m) => m.id)
    return {
      ids,
      total: this.total,
      truncated: this.total > ids.length,
      scanTruncated: scanTruncated || this.overflow
    }
  }
}

export class FileNameSearch {
  private readonly tree: DirectoryTree

  constructor(
    private readonly store: IndexStore,
    private readonly limits: FileSearchLimits = {}
  ) {
    this.tree = directoryTreeOf(store)
  }

  /**
   * @param cancelled Asks whether it was overtaken. Stops midway once it becomes true.
   * @param cwd Absolute path of the current working folder (item 100). Validation is already done by the caller (main and
   *   `FsIndexer.assertAllowed`). If null, there is just one section covering the whole index.
   * @param scope Absolute path (validated) of the Search screen's scope (TODO 437). When given, it searches **only inside that subtree**
   *   and the result is one section (`ids` / `total` … of the main part, `cwd` null). `cwd` is not used. If the subtree is
   *   not in the index, 0 results (it never silently drops the scope and returns the whole index).
   */
  async search(
    query: string,
    limit: number,
    cancelled: () => boolean = () => false,
    cwd: string | null = null,
    scope: string | null = null
  ): Promise<FileSearchOutcome> {
    const started = Date.now()
    const terms = parseNameQuery(query)
    if (terms.length === 0 || limit <= 0) return EMPTY
    const scoped = scope !== null

    const pageRows = this.limits.pageRows ?? PAGE_ROWS
    const budgetMs = this.limits.budgetMs ?? BUDGET_MS
    const maxMatches = this.limits.maxMatches ?? MAX_MATCHES
    const cwdPassMaxShare = this.limits.cwdPassMaxShare ?? CWD_PASS_MAX_SHARE

    const dirPaths = this.tree.dirPaths()
    // Only when there is a term with an uppercase letter (smart case, TODO 291) is the path table without lowercasing used too.
    const caseSensitive = terms.some((term) => term.cased)
    const casedPaths = caseSensitive ? this.tree.casedDirPaths() : dirPaths
    // The scope (TODO 437) reuses the cwd subtree strategy as it is (1. walk first / 2. sort within the whole scan),
    // and only discards rows outside the subtree.
    const base = scoped ? scope : cwd
    const subtree = base === null ? null : this.tree.subtree(base)
    if (scoped && subtree === null) {
      return { ...EMPTY, caseSensitive, tookMs: Date.now() - started }
    }
    // Per-term memo of the "parent directory state". Effective because the same parent runs for thousands of rows.
    const dirStates = terms.map(() => new Map<number, DirTermState>())

    const inside = new Bucket(maxMatches)
    const outside = new Bucket(maxMatches)
    /** Directories already read when the cwd's subtree was walked first. Not counted twice by the whole-index scan. */
    const visited = new Set<number>()
    let cwdCovered = false
    let scanTruncated = false
    let stopped = false

    const consider = (row: readonly [number, string, number | null], bucket: Bucket): void => {
      // TODO 436 (a revision of 357): folder rows are returned too. If it is a folder, the opening side (renderer) does not
      // open the viewer but selects that folder in the Files tree. Whether it is a folder is decided not by `documents_name_scan`
      // (which has no kind column) but by whether it is among the keys of `dirPaths` (= the full set of directory ids,
      // the same tree built from `fsDirectories()`): no SQL or migration is added.
      // With the same tier sum, files are ordered first (`compareMatches`).
      const isDirectory = dirPaths.has(row[0])
      const parentId = row[2]
      // When there is a term with an uppercase letter, foldForMatch (NFKC + lowercasing) is done while also
      // keeping the form before lowercasing. Otherwise as before (`casedName` is not used).
      const casedName = caseSensitive ? nfkc(row[1]) : ''
      const foldedName = caseSensitive ? casedName.toLowerCase() : foldForMatch(row[1])
      const hit = matchRow(terms, dirStates, dirPaths, casedPaths, foldedName, casedName, parentId)
      if (hit === null) return
      bucket.add({
        id: row[0],
        tierSum: hit.tierSum,
        posSum: hit.posSum,
        nameLen: foldedName.length,
        parentId,
        foldedName,
        isDirectory
      })
    }

    // 1. Walk the cwd's subtree first (so that truncation does not drop matches inside the cwd).
    //    When the tree is too large it is not walked, and matches are only sorted in 2.
    if (subtree !== null && subtree.ids.size <= dirPaths.size * cwdPassMaxShare) {
      const dirs = [...subtree.ids]
      for (let start = 0; start < dirs.length; start += CWD_DIRS_PER_STEP) {
        const step = dirs.slice(start, start + CWD_DIRS_PER_STEP)
        for (const row of this.store.fsNamesByParents(step)) consider(row, inside)
        for (const id of step) visited.add(id)
        if (start + CWD_DIRS_PER_STEP >= dirs.length) break
        if (cancelled()) {
          stopped = true
          break
        }
        if (Date.now() - started > budgetMs) {
          scanTruncated = true
          break
        }
        await yieldToEventLoop()
      }
      cwdCovered = !stopped && !scanTruncated
    }

    // If the scope (TODO 437) was fully read in 1., there is no reason to walk the whole index (outside the subtree is just discarded).
    if (scoped && cwdCovered) {
      const dirPathOf = (id: number | null): string =>
        id === null ? '' : (dirPaths.get(id) ?? '')
      return {
        ...inside.finish(limit, dirPathOf, false),
        cwd: null,
        caseSensitive,
        cancelled: false,
        tookMs: Date.now() - started
      }
    }

    // 2. Whole index. Rows whose parent 1. already read inside the cwd are skipped; rows whose parent was not read go to the cwd section.
    let after = 0
    while (!stopped && !scanTruncated) {
      const rows = this.store.scanFsNames(after, pageRows)
      if (rows.length === 0) {
        cwdCovered = true
        break
      }
      for (const row of rows) {
        const parentId = row[2]
        if (subtree !== null && parentId !== null && subtree.ids.has(parentId)) {
          if (!visited.has(parentId)) consider(row, inside)
          continue
        }
        if (!scoped) consider(row, outside)
      }
      const last = rows[rows.length - 1]
      if (last === undefined) break
      after = last[0]
      if (rows.length < pageRows) {
        cwdCovered = true
        break
      }
      if (cancelled()) {
        stopped = true
        break
      }
      if (Date.now() - started > budgetMs) {
        scanTruncated = true
        break
      }
      await yieldToEventLoop()
    }

    if (stopped) {
      return { ...EMPTY, cancelled: true, tookMs: Date.now() - started }
    }

    const dirPathOf = (id: number | null): string =>
      id === null ? '' : (dirPaths.get(id) ?? '')
    if (scoped) {
      // The scope (TODO 437) is one section. Truncation is declared by whether the inside of the scope was fully read (`cwdCovered`).
      return {
        ...inside.finish(limit, dirPathOf, !cwdCovered),
        cwd: null,
        caseSensitive,
        cancelled: false,
        tookMs: Date.now() - started
      }
    }
    const global = outside.finish(limit, dirPathOf, scanTruncated)
    return {
      ...global,
      cwd: subtree === null ? null : inside.finish(limit, dirPathOf, !cwdCovered),
      caseSensitive,
      cancelled: false,
      tookMs: Date.now() - started
    }
  }
}

/** Matches one row against all terms (all terms AND). null if it does not match. */
function matchRow(
  terms: readonly NameTerm[],
  dirStates: readonly Map<number, DirTermState>[],
  dirPaths: DirPaths,
  casedPaths: DirPaths,
  foldedName: string,
  casedName: string,
  parentId: number | null
): { tierSum: number; posSum: number } | null {
  let tierSum = 0
  let posSum = 0
  for (let i = 0; i < terms.length; i += 1) {
    const term = terms[i]
    if (term === undefined) continue
    const named = matchName(term, foldedName, casedName)
    if (named !== null) {
      tierSum += named.tier
      posSum += named.pos
      continue
    }
    if (parentId === null) return null
    const memo = dirStates[i]
    if (memo === undefined) return null
    let state = memo.get(parentId)
    if (state === undefined) {
      state = dirStateOf(term, (term.cased ? casedPaths : dirPaths).get(parentId) ?? '')
      memo.set(parentId, state)
    }
    const viaPath = matchPath(term, state, foldedName, casedName)
    if (viaPath === null) return null
    tierSum += viaPath.tier
    posSum += viaPath.pos
  }
  return { tierSum, posSum }
}
