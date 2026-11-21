/**
 * Candidates for "recent files" (TODO 999, ARCHITECTURE.md 4.5.12). Inside the index process, it walks the fs file rows
 * in newest-first order of `mtime_ms` and narrows by the following:
 *
 * - The extension is in `RECENT_EXTENSION_SET` (`.o` / `.lock` / no extension are not shown from the start).
 * - No name starting with "." anywhere in the path (under `.git` / `.cache` / `.venv` ..., hidden files).
 * - It does not hit the exclusion rules (`node_modules` / `~/Library` / caches ...). Rules can be added later, and
 *   rows remain until the next cleanup, so the parent folder and the file itself are checked again here too (the same idea as the indexer's `sweep`).
 * - **Marker of a bulk update** (`bulk`): files changed (regardless of extension) `BULK_COUNT` or more at a time within a `BULK_WINDOW_MS`
 *   span in the same folder. Whether to drop them is main's decision (files written by the AI are kept, owner decision no. 1).
 *
 * The git judgment (only modified / untracked) is in main's `RecentFilesService` (the only entry point that calls git is `runGit`, TODO 836).
 * **This does not import electron** (lint:index).
 */
import { BULK_COUNT, BULK_WINDOW_MS, RECENT_EXTENSION_SET, type RecentCandidate } from '@shared/recent-files.js'
import { pathToUri } from '../common/uri.js'

/** Upper bound on the rows walked per query. Even if one `git checkout` makes tens of thousands of rows "recent", it stops here. */
export const RECENT_SCAN_MAX_ROWS = 20_000
/** Rows per page. */
const PAGE_ROWS = 1_000
/** Rows with a time in the future (clock skew, a broken mtime) would squat at the head, so nothing beyond now + this span is walked. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000

export interface RecentRow {
  readonly id: number
  readonly name: string
  readonly ext: string
  readonly size: number
  readonly mtime_ms: number
  readonly parent_id: number | null
}

export interface RecentScanDeps {
  page(sinceMs: number, beforeMtime: number, beforeId: number, limit: number): readonly RecentRow[]
  pathOf(id: number): string | null
  /** Whether it hits the exclusion rules (the boolean of `classify`). */
  isExcluded(path: string, name: string, isDirectory: boolean): boolean
}

export interface RecentScanOptions {
  readonly sinceMs: number
  readonly now: number
  readonly limit: number
  /** Only directly under this folder (row id) (the badge of new screenshots). If null, the whole index. */
  readonly parentId?: number | null
  readonly maxRows?: number
}

/** The number of ascending `values` that fall in `[from, to]` (binary search). */
function countInRange(values: readonly number[], from: number, to: number): number {
  const lower = (target: number, strict: boolean): number => {
    let lo = 0
    let hi = values.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const v = values[mid] as number
      if (strict ? v <= target : v < target) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  return lower(to, true) - lower(from, false)
}

/**
 * Is it a time that hits "`count` or more within a `windowMs` span in the same folder"? Counts `[m - windowMs, m + windowMs]`
 * (a little wider than a strict sliding window, but enough until the provisional values are tightened). A pure function.
 */
export function isBulkAt(sortedMtimes: readonly number[], mtime: number, count = BULK_COUNT, windowMs = BULK_WINDOW_MS): boolean {
  return countInRange(sortedMtimes, mtime - windowMs, mtime + windowMs) >= count
}

/** Whether the path has a name starting with "." (`/Users/a/.cache/x.png` -> true). */
export function hasHiddenSegment(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'))
}

export function collectRecent(deps: RecentScanDeps, options: RecentScanOptions): RecentCandidate[] {
  const maxRows = options.maxRows ?? RECENT_SCAN_MAX_ROWS
  const parentFilter = options.parentId ?? null
  // All rows (regardless of extension) are used to count bulk updates. Candidates are only those with an extension in the table.
  const mtimesByParent = new Map<number, number[]>()
  const candidates: RecentRow[] = []
  let beforeMtime = options.now + FUTURE_SLACK_MS
  let beforeId = Number.MAX_SAFE_INTEGER
  let scanned = 0
  while (scanned < maxRows) {
    const rows = deps.page(options.sinceMs, beforeMtime, beforeId, Math.min(PAGE_ROWS, maxRows - scanned))
    if (rows.length === 0) break
    for (const row of rows) {
      scanned += 1
      if (row.parent_id === null) continue
      if (parentFilter !== null && row.parent_id !== parentFilter) continue
      let list = mtimesByParent.get(row.parent_id)
      if (list === undefined) {
        list = []
        mtimesByParent.set(row.parent_id, list)
      }
      list.push(row.mtime_ms)
      if (row.name.startsWith('.')) continue
      if (!RECENT_EXTENSION_SET.has(row.ext.toLowerCase())) continue
      candidates.push(row)
    }
    const last = rows[rows.length - 1] as RecentRow
    beforeMtime = last.mtime_ms
    beforeId = last.id
    if (rows.length < PAGE_ROWS) break
  }
  for (const list of mtimesByParent.values()) list.sort((a, b) => a - b)

  const out: RecentCandidate[] = []
  /** The parent folder's judgment (path, hidden, exclusion) is made once per parent. null means dropped. */
  const parents = new Map<number, string | null>()
  for (const row of candidates) {
    if (out.length >= options.limit) break
    const parentId = row.parent_id as number
    let parentPath = parents.get(parentId)
    if (parentPath === undefined) {
      const path = deps.pathOf(parentId)
      const name = path === null ? '' : (path.slice(path.lastIndexOf('/') + 1) || '/')
      parentPath = path === null || hasHiddenSegment(path) || deps.isExcluded(path, name, true) ? null : path
      parents.set(parentId, parentPath)
    }
    if (parentPath === null) continue
    const full = parentPath === '/' ? `/${row.name}` : `${parentPath}/${row.name}`
    if (deps.isExcluded(full, row.name, false)) continue
    out.push({
      uri: pathToUri(full),
      parentUri: pathToUri(parentPath),
      name: row.name,
      ext: row.ext.toLowerCase(),
      size: row.size,
      mtimeMs: row.mtime_ms,
      bulk: isBulkAt(mtimesByParent.get(parentId) ?? [], row.mtime_ms)
    })
  }
  return out
}
