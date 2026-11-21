/**
 * The decision to thin out the full scan at launch (ARCHITECTURE.md 6.2 "thinning out scans").
 *
 * **A pure function.** It touches neither the DB nor the file system, and decides "whether to run a full scan this time" only from the inputs FsService gathered.
 * The reason is returned so that the grounds appear in the log and the status bar both when it skipped and when it ran
 * (skipping silently would look like a bug).
 *
 * There are two kinds of inputs:
 * - `recorded`: the record of the last **completed** full scan (`scan.lastFull` /
 *   `scan.rulesVersion` of `app_settings`). It compares the root set, the home directory and the version of the exclusion rules.
 * - `runs`: **the latest row per root** of `scan_runs`. It looks at the time and whether it ended by interruption.
 *
 * The threshold changes by whether the root is under the home directory. Under the home directory the watch (fsevents) picks up
 * diffs, so a short default (24 hours) suffices; outside the home directory there is no watch and
 * scanning is heavy (the part under `/` is most of the whole), so the default is long (7 days).
 * At the time of this T the scan always goes over all roots, so the two thresholds mean "when either
 * expires, everything runs". The decision is kept per root so that it works
 * as it is once scanning is split per root.
 */
import { foldPath } from '../common/uri.js'

export const DEFAULT_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_OUTSIDE_HOME_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export type ScanRunState = 'running' | 'done' | 'aborted'

/** One row of `scan_runs` (per root). */
export interface ScanRunRecord {
  readonly root: string
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly state: ScanRunState
}

/** The record of the last completed full scan (`app_settings`). */
export interface LastFullScanRecord {
  readonly finishedAt: number
  readonly home: string
  readonly roots: readonly string[]
  readonly rulesVersion: number
}

export interface ScanScheduleInput {
  readonly now: number
  readonly home: string
  /** This time's set of scan roots (`FsService.scanRoots()`). */
  readonly roots: readonly string[]
  /** The current version of the exclusion rules (`RULES_VERSION`). */
  readonly rulesVersion: number
  readonly recorded: LastFullScanRecord | null
  /** The latest scan row per root. A root without one is "no record". */
  readonly runs: readonly ScanRunRecord[]
  readonly intervalMs?: number
  readonly outsideHomeIntervalMs?: number
}

export type ScanSkipReason =
  | 'no-record'
  | 'rules-changed'
  | 'home-changed'
  | 'roots-changed'
  | 'aborted'
  | 'expired'
  /** TODO 805: the protected-folder deferral ended (including an early release). Walks the home directory incrementally and brings in protected folders that have no rows yet. */
  | 'tcc-released'

export type ScanDecision =
  | {
      readonly full: true
      readonly reason: ScanSkipReason
      /** The root that decided the judgment (for time and interruption reasons). */
      readonly root: string | null
      readonly lastFullScanAt: number | null
    }
  | { readonly full: false; readonly lastFullScanAt: number }

function sameRootSet(a: readonly string[], b: readonly string[]): boolean {
  const fold = (roots: readonly string[]): string[] => [...new Set(roots.map(foldPath))].sort()
  const left = fold(a)
  const right = fold(b)
  return left.length === right.length && left.every((root, i) => root === right[i])
}

export function isUnderHome(root: string, home: string): boolean {
  const folded = foldPath(root)
  const foldedHome = foldPath(home)
  return folded === foldedHome || folded.startsWith(`${foldedHome}/`)
}

export function shouldFullScan(input: ScanScheduleInput): ScanDecision {
  const { recorded } = input
  const lastFullScanAt = recorded?.finishedAt ?? null
  const full = (reason: ScanSkipReason, root: string | null = null): ScanDecision => ({
    full: true,
    reason,
    root,
    lastFullScanAt
  })

  if (recorded === null) return full('no-record')
  if (recorded.rulesVersion !== input.rulesVersion) return full('rules-changed')
  if (foldPath(recorded.home) !== foldPath(input.home)) return full('home-changed')
  if (!sameRootSet(recorded.roots, input.roots)) return full('roots-changed')

  const intervalMs = input.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS
  const outsideMs = input.outsideHomeIntervalMs ?? DEFAULT_OUTSIDE_HOME_INTERVAL_MS
  const byRoot = new Map(input.runs.map((run) => [foldPath(run.root), run]))

  for (const root of input.roots) {
    const run = byRoot.get(foldPath(root))
    if (run === undefined) return full('no-record', root)
    // `running` means the previous launch crashed in the middle of that scan. Treated the same as an interruption.
    if (run.state !== 'done' || run.finishedAt === null) return full('aborted', root)
    const limit = isUnderHome(root, input.home) ? intervalMs : outsideMs
    // If the clock went backwards (finishedAt is in the future), it also falls to the "expired" side and runs.
    const age = input.now - run.finishedAt
    if (age < 0 || age > limit) return full('expired', root)
  }

  return { full: false, lastFullScanAt: recorded.finishedAt }
}

/**
 * Default interval for walking all roots again without pruning (7 days).
 *
 * The incremental scan relies on "if a directory's mtime is the same as last time, its direct children have not changed",
 * but mtime **reflects only the direct children**, so changes in grandchildren and below are invisible.
 * Under the home directory the watch (fsevents) picks them up, but nobody sees changes made while the app was down.
 * This interval bounds how much can be missed: a scan past it stops pruning,
 * walks all roots and applies the `seen_at`-style cleanup (the safe-side treatment).
 */
export const DEFAULT_DEEP_SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export interface ScanPlan {
  /** The roots to walk this time. In a deep scan, always all roots. */
  readonly roots: readonly string[]
  /** Is this a run that walks all roots without pruning and cleans up by `seen_at`? */
  readonly deep: boolean
  /** The reason to run (for the log and the status bar). */
  readonly reason: ScanSkipReason
  /** The root that decided the judgment. */
  readonly root: string | null
}

/** The deadline judgment of one root. null if no scan is needed. */
function rootReason(
  root: string,
  input: ScanScheduleInput,
  byRoot: ReadonlyMap<string, ScanRunRecord>
): ScanSkipReason | null {
  const run = byRoot.get(foldPath(root))
  if (run === undefined) return 'no-record'
  if (run.state !== 'done' || run.finishedAt === null) return 'aborted'
  const limit = isUnderHome(root, input.home)
    ? (input.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS)
    : (input.outsideHomeIntervalMs ?? DEFAULT_OUTSIDE_HOME_INTERVAL_MS)
  const age = input.now - run.finishedAt
  if (age < 0 || age > limit) return 'expired'
  return null
}

/** Returns only the roots that are due (the targets of a partial scan). */
export function dueRoots(
  input: ScanScheduleInput
): readonly { root: string; reason: ScanSkipReason }[] {
  const byRoot = new Map(input.runs.map((run) => [foldPath(run.root), run]))
  const due: { root: string; reason: ScanSkipReason }[] = []
  for (const root of input.roots) {
    const reason = rootReason(root, input, byRoot)
    if (reason !== null) due.push({ root, reason })
  }
  return due
}

/**
 * The time the next full scan comes due (the status bar's "next full scan").
 *
 * null if already overdue / there is no record / an interruption remains (= due right now).
 */
export function nextScanAt(input: ScanScheduleInput): number | null {
  if (shouldFullScan(input).full) return null
  const byRoot = new Map(input.runs.map((run) => [foldPath(run.root), run]))
  let earliest: number | null = null
  for (const root of input.roots) {
    const run = byRoot.get(foldPath(root))
    if (run?.finishedAt == null) return null
    const limit = isUnderHome(root, input.home)
      ? (input.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS)
      : (input.outsideHomeIntervalMs ?? DEFAULT_OUTSIDE_HOME_INTERVAL_MS)
    const at = run.finishedAt + limit
    if (earliest === null || at < earliest) earliest = at
  }
  return earliest
}

/**
 * This time's scan plan. null if no scan needs to run.
 *
 * - Reasons that affect everything (`no-record` / `rules-changed` / `home-changed` /
 *   `roots-changed`) give a **deep scan**. When the exclusion rules change, this is needed to drop
 *   trees that became out of scope through the `seen_at` cleanup (4.4.2.1).
 * - A deep scan also when `deepIntervalMs` has passed since the last deep scan (the bound on what pruning can miss).
 * - Otherwise (the per-root `expired` / `aborted`), **only the due roots** are walked
 *   with pruning. Cleanup too is limited to "directly under directories whose mtime changed".
 */
export function planScan(
  input: ScanScheduleInput,
  lastDeepAt: number | null,
  deepIntervalMs: number = DEFAULT_DEEP_SCAN_INTERVAL_MS
): ScanPlan | null {
  const decision = shouldFullScan(input)
  if (!decision.full) return null
  const deepAge = lastDeepAt === null ? null : input.now - lastDeepAt
  const deepExpired = deepAge === null || deepAge < 0 || deepAge > deepIntervalMs
  if (decision.root === null || deepExpired) {
    return { roots: [...input.roots], deep: true, reason: decision.reason, root: decision.root }
  }
  const due = dueRoots(input)
  if (due.length === 0) {
    // The judgments disagree (should not happen in theory). Fall to the safe side and make it a deep scan.
    return { roots: [...input.roots], deep: true, reason: decision.reason, root: decision.root }
  }
  return {
    roots: due.map((entry) => entry.root),
    deep: false,
    reason: decision.reason,
    root: decision.root
  }
}
