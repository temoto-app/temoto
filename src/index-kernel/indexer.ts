/**
 * FsIndexer: scanning, watching, diff notification, and the query entry point for listings / file-name search
 * (ARCHITECTURE.md 4.4, IMPLEMENTATION_BRIEF chapter 5).
 *
 * Only URIs are returned to the renderer. Paths are handled only inside this module.
 *
 * **Changes in P1 (the move to the index process, chapter 3)**:
 * - Of the old `FsService`, the side that **touches the index tables** stays here (the index process),
 *   and the side that does not touch the DB (`stat` / `roots` /
 *   `defaultReferenceDirs` / `isReferenceable` / `assertAllowed`) was split off into
 *   main's `FsAccess` (`src/main/fs/access.ts`)
 *   (`readResource` was removed in item 160 (2026-09-28) and `writeTextFile` in the review of 2026-10-01,
 *   both with no production caller left).
 * - Both sides build the exclusion rules from `createMacosExclusions(home, { allowedVolumes })`, **the same pure function**.
 *   When the allow list changes, main is only notified via `onRules`;
 *   the rules themselves never cross the process boundary (3.5).
 *
 * **Changes in Phase 3**:
 * - Scan results are now stored in `documents` instead of `files` (6.3). A row has no path,
 *   only `name` and the parent's id. The absolute path is assembled by `IndexStore.pathOf` (12.4).
 * - The scan scope went from **under the home directory to the whole PC** (user decision, 12.7). The exclusion list is
 *   shared as in 4.4.1 / 4.4.2, and network volumes are off by default.
 * - Writes go through `IndexStore`, following IndexService's single-writer principle (6.2).
 *
 * **Changes in T3 (thinning out scans, 6.2)**:
 * - The history of full scans is kept in `scan_runs` (one row per root), and on completion
 *   `scan.lastFull` / `scan.rulesVersion` of `app_settings` are updated.
 * - `start()` skips the scan when `shouldFullScan` (a pure function, `fs/schedule.ts`) is false, and only
 *   sets up watching. A manual `rescan()` always runs without going through the decision.
 *
 * **Changes in T4 (external storage, 4.4.2)**:
 * - `/Volumes` is excluded by default. Only volumes allowed in settings (`VolumeRegistry`) become
 *   includes. The exclusion rules are exposed via `exclusionRules` (a getter), and the Broker reads the
 *   **same instance** too: the scan, `assertAllowed` and the Broker, three paths, go through one
 *   `classify`.
 * - An allowed volume **stays among the scan roots as long as it is in settings** (even when not mounted),
 *   so that the T3 `roots-changed` decision does not flap with mount state. An unmounted root is
 *   not walked and is also excluded from `removeStale` (it is not gone, it is just absent).
 */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import type {
  DirectoryListing,
  ListDirectoryOptions,
  FileChange,
  FileChangeBatch,
  FileEntry,
  FileSearchResult,
  ScanStatus,
  VolumeEntry
} from '@shared/types.js'
import type { SubtreeScanResult, SubtreeScanSkipReason } from '@shared/index-rpc.js'
import type { FileSortOrder } from '@shared/file-sort.js'
import { pathToUri, foldPath } from '../common/uri.js'
import { pathFromUri, resolvePath, type PathAccess } from '../common/fs-policy.js'
import { yieldToEventLoop } from '../common/batch.js'
import { log, errorFields } from '../common/logger.js'
import { AppSettingsStore } from '../common/settings.js'
import {
  SCAN_DEEP_INTERVAL_MS,
  SCAN_INTERVAL_MS,
  SCAN_LAST_DEEP,
  SCAN_LAST_FULL,
  SCAN_OUTSIDE_HOME_INTERVAL_MS,
  SCAN_PRUNE,
  SCAN_RULES_VERSION,
  FS_TCC_DEFER_UNTIL,
  FS_WATCH_MARK
} from '../common/settings-keys.js'
import type { IndexStore, ChildRow } from './store.js'
import { FileNameSearch } from './file-search.js'
import { collectRecent } from './recent.js'
import type { RecentCandidate } from '@shared/recent-files.js'
import type { ExclusionRules } from '../common/exclusions.js'
import {
  classify,
  classifyAccess,
  createMacosExclusions,
  isUnderTccDeferred,
  isVolumeMountPath,
  RULES_VERSION,
  TCC_DEFER_MS,
  withTccDeferred
} from '../common/exclusions.js'
import { VolumeRegistry, type VolumeRegistryOptions } from './volumes.js'
import {
  isUnderHome,
  nextScanAt,
  planScan,
  shouldFullScan,
  DEFAULT_DEEP_SCAN_INTERVAL_MS,
  type LastFullScanRecord,
  type ScanDecision,
  type ScanPlan,
  type ScanScheduleInput
} from './schedule.js'
import { ScanScheduler, type ScanSchedulerOptions } from './scheduler.js'
import { SLOW_SCAN_BATCH } from './pace.js'
import { isDataless, walk, type ScannedEntry, type ScanCounters } from './scanner.js'
import {
  changesSince,
  takeWatchMark,
  watchMarkTime,
  watchTree,
  type RawChange,
  type WatchHandle
} from './watcher.js'

/** Upper bound per listing / search. Not unbounded even with a virtual list. */
export const MAX_ROWS = 5000
const DEFAULT_SEARCH_LIMIT = 200

/**
 * Key of `app_settings` (scan thinning). **The key string itself exists only in
 * `src/common/settings-keys.ts`** (TODO 85); this is a re-export for
 * compatibility with existing callers (including tests).
 */
export const SETTING_LAST_FULL_SCAN = SCAN_LAST_FULL.key
export const SETTING_RULES_VERSION = SCAN_RULES_VERSION.key
export const SETTING_SCAN_INTERVAL_MS = SCAN_INTERVAL_MS.key
export const SETTING_OUTSIDE_HOME_INTERVAL_MS = SCAN_OUTSIDE_HOME_INTERVAL_MS.key
/** T9: the time all roots were last walked **without pruning**, and the interval for that (6.2.2). */
export const SETTING_LAST_DEEP_SCAN = SCAN_LAST_DEEP.key
export const SETTING_DEEP_INTERVAL_MS = SCAN_DEEP_INTERVAL_MS.key
/** T9: the escape hatch that turns pruning off (`0` disables it). */
export const SETTING_PRUNE = SCAN_PRUNE.key
/** Number of rows kept in `scan_runs`. Grows by the number of roots (3 to 5 rows) per launch. */
const SCAN_RUNS_KEEP = 500

/**
 * Number of watch diffs written in one transaction (item 87).
 *
 * The idea is the same as `STALE_BATCH` of `IndexStore` (cleanup after a scan): the larger this is, the fewer
 * COMMITs, but **this JS thread stops meanwhile**. The index process is separate from main, so
 * UI rendering does not stop, but the RPCs `fs.listDirectory` / `index.search` /
 * `fs.searchFiles`, which answer synchronously on the same connection, are made to wait (`rm -rf` of 100,000 files was one transaction).
 * Deletions go to `IndexStore.deleteDocuments`, so the `STALE_BATCH` inside it applies.
 */
export const CHANGE_BATCH = 200

/**
 * Upper bound on the number of changes applied by the drain just before shutdown (TODO 889). A batch is 16 ms worth, so usually a few entries; this is insurance
 * so that quitting in the middle of an `rm -rf` does not make shutdown wait long. The excess is dropped: the saved watch mark is not
 * advanced during shutdown, so the replay at the next launch (TODO 833) picks it up.
 */
export const DRAIN_LIMIT = 1000

/**
 * Limits of the subtree scan at thread creation (item 246, 6.2.2). Exceeding either one stops it and
 * returns `truncated`. The scheduled scan picks up the rest (the directory rows of a truncated tree get their mtime set back to 0).
 * 50,000 entries takes about 1 second the first time by measurement (`scripts/bench/subtree-scan.mts`); 10 seconds is insurance an order of magnitude above that.
 */
export const SUBTREE_MAX_ENTRIES = 50_000
export const SUBTREE_MAX_MS = 10_000
/**
 * Number of rows per transaction of the subtree scan. Smaller than the full scan's (`walk` default 2,000), so as not to make
 * RPCs such as `fs.searchFiles`, which answer synchronously on the same connection, wait long (the same idea as item 87).
 */
const SUBTREE_BATCH = 500

/**
 * Reasons for ending the protected-folder deferral (TODO 805). `expired` means 3 days passed, `button` is "include now" in settings,
 * `opened` means a protected folder (or something inside it) was opened in the Files tree, `cwd` means it became a thread's working folder,
 * and `reference` means it was added to the reference scope.
 */
export type TccReleaseReason = 'expired' | 'button' | 'opened' | 'cwd' | 'reference'

/**
 * Interval for rechecking the deferral deadline against the wall clock (code-review of TODO 805). `setTimeout` uses the monotonic clock, which does not
 * advance while a Mac sleeps: with a one-shot 3-day timer, the release (re-establishing the watch, clearing state) would be delayed by the time the lid was closed.
 * It compares with `Date.now()` again at a short interval.
 */
export const TCC_CHECK_MS = 60_000

/** Entry point for watching (code-review of TODO 805 / 833). Tests inject a fake watcher. */
export interface WatchBackend {
  readonly watchTree: typeof watchTree
  readonly takeWatchMark: typeof takeWatchMark
  readonly changesSince: typeof changesSince
}

/** Additional settings of `FsIndexer`. */
export interface FsIndexerOptions {
  /** Protected-folder deferral (TODO 805). Disabled by default (only the index process enables it). */
  readonly tccDeferral?: boolean
  /** Wall clock used for the protected-folder deferral and scan decisions (replaced by tests). Defaults to `Date.now`. */
  readonly now?: () => number
  /** Interval for rechecking the deferral deadline (default `TCC_CHECK_MS`). */
  readonly tccCheckMs?: number
  /** Entry point for watching (default `@parcel/watcher`). */
  readonly watcher?: Partial<WatchBackend>
}

/** Interval for retaking the watch mark (TODO 833). The replay at the next launch then covers only changes after the last saved mark. */
const WATCH_MARK_INTERVAL_MS = 10 * 60 * 1000

/** Does it exist right now? (symlinks are not followed) To confirm a delete during the replay (TODO 833). */
function existsNow(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Limits of the subtree scan (tests replace them with small ones). */
export interface SubtreeScanLimits {
  readonly maxEntries?: number
  readonly maxMs?: number
}

/** Marker that shutdown interrupted applying diffs (thrown at a batch boundary and caught by `applyChanges`). */
class ChangesAborted extends Error {
  constructor() {
    super('changes aborted')
    this.name = 'ChangesAborted'
  }
}

/** How to run one scan (6.2.2). */
export interface ScanRunOptions {
  /** Roots to walk. Defaults to all roots. */
  readonly roots?: readonly string[]
  /**
   * Deep scan: no pruning, `seen_at` is re-stamped on every entry, and cleanup is done by `seen_at`.
   * A manual rescan and reasons that affect everything (rule changes, etc.) use this. Default true.
   */
  readonly deep?: boolean
  /** Is it a scan coming from the scheduled run (at idle)? It is interrupted when the user's operation resumes. */
  readonly auto?: boolean
  /**
   * Is it the full scan at launch (the one run by the thinning decision of 6.2.1) (TODO 448)? Like `auto`, it goes through the pacing stage
   * (TODO 434), and is interrupted under heat / Low Power Mode. It is distinguished from a manual `rescan()`:
   * a manual rescan and a subtree scan stay at full speed.
   */
  readonly startup?: boolean
}

export interface FsIndexerEvents {
  onScanStatus(status: ScanStatus): void
  onFileChanges(batch: FileChangeBatch): void
  /** A scan ended / diffs arrived. Prompts processing of the index's remaining items (the entrance of 6.2). */
  onIndexable?(): void
  /**
   * A subtree scan (item 246) finished (`done` / `truncated`). The index process builds the bodies of this subtree
   * without waiting for idle (item 249, `IndexService.buildSubtree`). `rootId` is the row of the subtree's root.
   * It does not wait: the build runs outside the scan chain (`subtreeChain`) and does not make the full scan wait.
   */
  onSubtreeScanned?(rootId: number, path: string): void
  /**
   * The inputs of the exclusion rules changed (3.5). These are the inputs for the sole holder on the main side (`FsAccess`)
   * to rebuild them with **the same pure function**; the rules themselves are not passed.
   */
  onRules?(allowedVolumes: readonly string[], volumesDir: string): void
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * The empty result of file-name search (6.6). T8's rule is to **never turn the query into a regular expression or a LIKE pattern**,
 * so the former `escapeLike` is no longer needed
 * (matching uses only `indexOf` / `startsWith`).
 */
const EMPTY_SEARCH: FileSearchResult = {
  entries: [],
  total: 0,
  truncated: false,
  scanTruncated: false,
  cwd: null,
  cancelled: false,
  tookMs: 0
}

export class FsIndexer {
  /** Exclusion rules. Rebuilt when the allowed volumes change (`rebuildRules`). */
  private rules: ExclusionRules
  private readonly home: string
  private readonly index: IndexStore
  private readonly settings: AppSettingsStore
  private watch: WatchHandle | null = null
  private scanning = false
  /**
   * Paths of rows that the watch (or a listing reconcile) deleted during a scan (TODO 262). Between the scan reading a directory's children and
   * writing the batch, the watch's delete can be applied first. Then the batch writes the deleted
   * folder's row back with `seen_at` = this time (`ensureDirectory` recreates it along with its ancestors), and the deep scan's
   * `removeStale` keeps it as "seen this time". At the end of the scan the paths here are checked again and dropped.
   */
  private deletedDuringScan: Set<string> | null = null
  private stopRequested = false
  /**
   * Whether it entered shutdown. `stopRequested` is the interruption of a single scan and is reset to false at the start of
   * `scan()`. This one is the app's shutdown itself and never returns from true.
   * It blocks every path that would write after the DB is closed.
   */
  private stopped = false
  /** The scan in progress. At shutdown, the DB can be closed only after waiting for it. */
  private scanTask: Promise<void> | null = null
  /**
   * The queue that applies watch diffs (item 87). Applying returns to the event loop between batches, so
   * it is lined up as one so that the next flush does not overtake the previous application. `stop()` waits for this too.
   */
  private changesTask: Promise<void> = Promise.resolve()
  /** The running `setVolumeAllowed` calls (they write the setting after waiting for diskutil). `stop()` waits for them (TODO 1124). */
  private readonly volumeOps = new Set<Promise<unknown>>()
  /**
   * The drain just before shutdown (TODO 889). What remained in the batch (16 ms) when the watch was stopped is applied by
   * `drainChanges` even after `stopped`. `drainedCount` is that count (upper bound `DRAIN_LIMIT`), `applyingDrain` is the flag for applying
   * (it does not bail out even if it sees `stopped` at a boundary), and `drainClosed` is the marker that `stop()` finished waiting for the application (after that nothing more is queued,
   * so nothing is written after the DB is closed).
   */
  private drainedCount = 0
  private applyingDrain = false
  private drainClosed = false
  /** The queue for taking the watch mark and replaying (TODO 833). `stop()` waits for this too (the mark is written to the DB). */
  private markTask: Promise<void> = Promise.resolve()
  private markTimer: ReturnType<typeof setInterval> | null = null
  /**
   * The queue of subtree scans (item 246). Requests flow one at a time and never overlap the full scan
   * (one index writer, 6.2). `stop()` waits for this too.
   */
  private subtreeChain: Promise<unknown> = Promise.resolve()
  /** Subtree scans waiting / running (folded path -> result). Merges consecutive requests for the same cwd. */
  private readonly subtreePending = new Map<string, Promise<SubtreeScanResult>>()
  /** The subtree scan currently writing to the DB. The full scan (`scan`) waits for this before starting. */
  private subtreeActive: Promise<unknown> | null = null
  private status: ScanStatus
  /** Allow list of external storage (4.4.2 "external storage"). */
  readonly volumes: VolumeRegistry

  private readonly denialStatement: Statement

  /** File-name search (6.6). Holds the candidate supply and qlm-style matching. */
  private readonly nameSearch: FileNameSearch
  /** Generation number that grows with each keystroke. An old search notices by itself and stops midway. */
  private searchSeq = 0

  /** Explicit specification of the scan roots (for tests and a future settings UI). If null, the whole PC. */
  private readonly explicitRoots: readonly string[] | null

  /** The resident scheduled run (6.2.2). Disabled by default; `index.ts` enables and injects it. */
  private readonly auto: ScanScheduler
  /**
   * Whether the running scan is one that goes through the pacing stage (TODO 434): the scheduled run (`auto`) or the full scan at launch
   * (`startup`, TODO 448). Both are interrupted under heat / Low Power Mode. A manual `rescan()` and
   * a subtree scan are not included (they stay at full speed and are never interrupted).
   */
  private currentScanPaced = false

  /**
   * Whether to use the protected-folder deferral (TODO 805). **Disabled by default**: only the index process (`kernel.ts`) enables it
   * (the same as `ScanScheduler`; so that a `FsIndexer` made by a test does not skip protected folders on its own).
   */
  private readonly tccDeferral: boolean
  /** The value of `FS_TCC_DEFER_UNTIL` (read / decided by `start()`). 0 means no deferral. */
  private tccDeferUntil = 0
  /** Timer that rechecks the deferral deadline on the wall clock (every `TCC_CHECK_MS`; for the 3 days that pass while resident). */
  private tccTimer: ReturnType<typeof setTimeout> | null = null
  private readonly tccCheckMs: number
  /** The wall clock (`Date.now`; a fake clock in tests). */
  private readonly clock: () => number
  private readonly watchBackend: WatchBackend
  /** Whether protected folders were left out when the current watch was set up (set it up again once the deferral ends). */
  private watchDeferred = false
  /** Setting up the watch is in progress (during the await in `startWatching`). Re-setups do not overlap. */
  private watchStarting = false
  /** The watch is being re-established (`rewatchIfStale`). Does not overlap. */
  private rewatching: Promise<void> | null = null
  /** The old subscription to stop after the new subscription is made by a re-setup. `stop()` stops it too. */
  private retiringWatch: WatchHandle | null = null
  /**
   * The scan at launch (the one `start()` planned, `startup`) has not finished yet. The catch-up scan for protected folders left behind
   * goes after it (code-review of TODO 805: when a full-speed scan started first, the launch scan was dropped by `scanning`).
   */
  private startupTask: Promise<void> | null = null

  constructor(
    db: Database,
    private readonly events: FsIndexerEvents,
    index: IndexStore,
    home: string = homedir(),
    roots: readonly string[] | null = null,
    volumeOptions: VolumeRegistryOptions = {},
    schedulerOptions: ScanSchedulerOptions = {},
    options: FsIndexerOptions = {}
  ) {
    this.tccDeferral = options.tccDeferral ?? false
    this.clock = options.now ?? Date.now
    this.tccCheckMs = options.tccCheckMs ?? TCC_CHECK_MS
    this.watchBackend = {
      watchTree: options.watcher?.watchTree ?? watchTree,
      takeWatchMark: options.watcher?.takeWatchMark ?? takeWatchMark,
      changesSince: options.watcher?.changesSince ?? changesSince
    }
    this.home = home
    this.explicitRoots = roots
    this.index = index
    this.nameSearch = new FileNameSearch(index)
    this.settings = new AppSettingsStore(db)
    this.volumes = new VolumeRegistry(this.settings, volumeOptions)
    // Right after launch the "effective allowance" is empty (UUID matching is asynchronous), so every volume is excluded.
    // `start()` rebuilds after `refresh()`. It starts from the safe side.
    this.rules = this.buildRules()
    this.denialStatement = db.prepare(`
      INSERT INTO scan_denials (path_folded, path, code, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(path_folded) DO UPDATE SET code = excluded.code, seen_at = excluded.seen_at
    `)
    this.status = {
      state: 'idle',
      seen: 0,
      indexed: 0,
      excluded: 0,
      denied: 0,
      deniedExamples: [],
      startedAt: null,
      finishedAt: null,
      message: null,
      lastFullScanAt: this.readLastFullScan()?.finishedAt ?? null,
      skipped: false,
      nextFullScanAt: null,
      tccDeferredUntil: null
    }
    this.auto = new ScanScheduler(
      {
        decide: (now) => this.decide(now),
        isScanning: () => this.scanning,
        startAutoScan: () => this.startAutoScan(),
        abortAutoScan: (reason) => this.abortAutoScan(reason)
      },
      schedulerOptions
    )
  }

  private recordDenial(path: string, code: string): void {
    this.denialStatement.run(foldPath(path), path, code, Date.now())
  }

  get homePath(): string {
    return this.home
  }

  /**
   * The current exclusion rules. The scan, `assertAllowed` and the watch, three paths, go through the same `classify`.
   * The main-side rules (Broker / ViewerBroker) are built by `FsAccess` from the same inputs (3.5).
   */
  get exclusionRules(): ExclusionRules {
    return this.rules
  }

  /** The inputs of the rules (what is passed to main via `onRules`). */
  get allowedVolumePaths(): readonly string[] {
    return this.volumes.effectivePaths()
  }

  get volumesDir(): string {
    return this.volumes.volumesDir
  }

  private buildRules(): ExclusionRules {
    return createMacosExclusions(this.home, {
      allowedVolumes: this.volumes.effectivePaths(),
      volumesDir: this.volumes.volumesDir
    })
  }

  private rebuildRules(): void {
    this.rules = this.buildRules()
    // The main-side rules are rebuilt from the same inputs (3.5). The rules themselves are not sent.
    this.events.onRules?.(this.volumes.effectivePaths(), this.volumes.volumesDir)
  }

  /**
   * The set of roots for indexing and scanning (the table of 4.4, "the index covers the whole PC except the exclusion list").
   *
   * The home directory is walked first so the UI fills early, followed by `/`.
   * Includes **under an exclusion prefix**, such as `/usr/local` or iCloud Drive,
   * cannot be reached by the scan of `/` (they are pruned at the parent), so they are added as independent roots.
   *
   * Roots are deduplicated by folded path. In T20 the home directory became an include (`own-home`)
   * under `/Users` (excluded), so this rule's scan brings the home directory up again:
   * unless it is removed it becomes `[home, '/', home]`, rows of `scan_runs` get created twice, and
   * the `roots-changed` decision (compared as a set) would disagree with the record.
   */
  scanRoots(): readonly string[] {
    const roots: string[] = []
    const seen = new Set<string>()
    const push = (root: string): void => {
      const folded = foldPath(root)
      if (seen.has(folded)) return
      seen.add(folded)
      roots.push(root)
    }
    for (const root of this.explicitRoots ?? [this.home, '/']) push(root)
    if (this.explicitRoots === null) {
      for (const rule of this.rules.prefixes) {
        if (rule.action !== 'include') continue
        // Allowed volumes are added together below (as configured, regardless of mount state).
        if (rule.reason === 'allowed-volume') continue
        const parent = dirname(rule.raw)
        if (parent === rule.raw) continue
        // If the parent is excluded, it cannot be reached unless it is put into the root set.
        if (!classify(parent, basename(parent), true, this.rules).excluded) continue
        try {
          if (statSync(rule.raw).isDirectory()) push(rule.raw)
        } catch {
          // An include that does not exist (an unused iCloud Drive, etc.) is skipped.
        }
      }
    }
    // An allowed volume is a root **as long as it is in settings**. It is not dropped even when unmounted:
    // dropping it would make every plug / unplug a full scan through `roots-changed` (6.2.1).
    for (const mount of this.volumes.configuredPaths()) push(mount)
    return roots
  }

  /**
   * Allowed volumes not walked in this scan: unmounted, or UUID mismatch
   * (a different disk). Since they are not walked, `seen_at` is not updated and, left as is,
   * `removeStale` would mistake them for "gone". The caller excludes the whole tree.
   */
  private skippedVolumeRoot(root: string): boolean {
    return this.volumes.isConfigured(root) && !this.volumes.isEffective(root)
  }

  getScanStatus(): ScanStatus {
    return this.status
  }

  private setStatus(patch: Partial<ScanStatus>): void {
    this.status = { ...this.status, ...patch }
    this.events.onScanStatus(this.status)
  }

  /**
   * Processing at launch (6.2 "thinning out scans").
   *
   * If the previous full scan completed within the threshold and neither the exclusion rules nor the root set changed, the full scan is skipped and
   * **only the watch is set up first**. When skipped, the watch is the only way to keep up,
   * so it is set up immediately rather than after the scan.
   *
   * When a scan does run, the watch is also set up first and the scan starts after (TODO 833: setting it up after the scan
   * dropped what was created during a full scan lasting several minutes). Changes made while stopped are picked up by the replay from the watch mark.
   */
  async start(): Promise<void> {
    if (this.stopped) return
    // Matching of allowed volumes (mount + UUID). Until this finishes, every volume is excluded.
    await this.volumes.refresh()
    this.rebuildRules()
    if (this.stopped) return
    this.initTccDeferral()
    const plan = this.plan()
    // **The watch is set up before the scan** (TODO 833). Previously, on runs that scan, it was set up "after the scan completes", so during the
    // multi-minute full scan of the first launch (empty userData), anything created inside a folder already walked did not enter the index until the next scan.
    // Scan and watch diffs are written alternately inside the same index process (the watch keeps running during a scheduled scan too: TODO 262's
    // `deletedDuringScan` cleans up after that mismatch). Changes after the previous mark (while stopped, between launch and the watch) are
    // replayed from the FSEvents history. On a run where a deep scan of all roots happens, the scan picks everything up, so there is no replay.
    const watching = this.startWatching({
      replayFrom: plan === null || !plan.deep ? this.settings.readTyped(FS_WATCH_MARK) : null
    })
    if (plan === null) {
      const decision = this.decide() as { full: false; lastFullScanAt: number }
      log.info('fs.scan.skipped', {
        lastFullScanAt: decision.lastFullScanAt,
        ageMs: Date.now() - decision.lastFullScanAt
      })
      this.setStatus({
        state: 'done',
        startedAt: null,
        finishedAt: null,
        message: null,
        lastFullScanAt: decision.lastFullScanAt,
        skipped: true,
        nextFullScanAt: this.nextFullScanAt()
      })
      this.scanTask = watching.then(() => this.auto.start())
      void this.scanTask
      // If a document was left pending by the previous scan, advance the index.
      this.events.onIndexable?.()
      return
    }
    log.info('fs.scan.scheduled', {
      reason: plan.reason,
      root: plan.root,
      deep: plan.deep,
      roots: plan.roots.length
    })
    // TODO 448: the full scan at launch also goes through the pacing stage (slow while the user is operating, full speed when left alone).
    // Wait for the subscription (`subscribe`) before starting to walk: the subscription takes a few ms, and the replay is not waited for (it advances alternately with the scan on the diff queue).
    // Until the launch scan ends it is held in `startupTask`: even if the protected-folder deferral lifts in the meantime, the catch-up scan
    // goes after it (`runTccCatchUp`). If it lifted before walking starts, the launch scan also walks the protected folders
    // (the rules and `tccCatchUp` are decided at the head of `scan()`), so the later scan is not needed and disappears.
    const startup = watching.then(() => this.scan({ ...plan, startup: true }))
    this.startupTask = startup
    startup
      .finally(() => {
        if (this.startupTask === startup) this.startupTask = null
      })
      .catch(() => {})
    this.scanTask = startup.then(() => this.auto.start())
    void this.scanTask
  }

  /**
   * A scan started from the scheduled run (6.2.2). It does not wait: it is put on `scanTask`
   * so that `stop()` can wait for the running scan.
   */
  private startAutoScan(): void {
    if (this.stopped || this.scanning) return
    const plan = this.plan()
    if (plan === null) return
    log.info('fs.scan.auto.start', { reason: plan.reason, deep: plan.deep, roots: plan.roots.length })
    const task = this.scan({ ...plan, auto: true }).finally(() => this.auto.finished())
    this.scanTask = task
    void task.catch(() => {})
  }

  /**
   * Heat / Low Power Mode started, so the running scheduled run / launch full scan is stopped
   * (TODO 434 / 448). A manual scan (`rescan()`) and a subtree scan are not stopped.
   */
  private abortAutoScan(reason: string): void {
    if (!this.scanning || !this.currentScanPaced || this.stopRequested) return
    // The cleanup after a scan (`removeStale` / `sweepChangedDirs`) does not look at `stopRequested` and goes to the end at a slow
    // pace. Meanwhile `paceStep` comes here on every yield, so from the second time on the
    // flag is not set again and the log is written only once (a finding of the wave 22 code-review).
    log.info('fs.scan.auto.abort', { reason })
    this.stopRequested = true
  }

  /** This time's scan plan (roots to walk and depth). null if no scan needs to run. */
  plan(now: number = this.clock()): ScanPlan | null {
    const plan = planScan(
      this.scheduleInput(now),
      this.settings.readTyped(SCAN_LAST_DEEP),
      this.settings.readTyped(SCAN_DEEP_INTERVAL_MS) ?? DEFAULT_DEEP_SCAN_INTERVAL_MS
    )
    // The protected-folder deferral has ended, but protected folders have not been walked yet (TODO 805). A root containing the home
    // directory is added incrementally: protected folders with no rows are walked entirely without pruning, and the rest are pruned by mtime.
    const root = this.tccCatchUpPending(now) ? this.tccCatchUpRoot() : null
    if (root === null) return plan
    if (plan === null) return { roots: [root], deep: false, reason: 'tcc-released', root }
    if (plan.roots.some((value) => foldPath(value) === foldPath(root))) return plan
    return { ...plan, roots: [root, ...plan.roots] }
  }

  /** The time the next full scan comes due (the status bar's "next full scan"). */
  nextFullScanAt(now: number = this.clock()): number | null {
    return nextScanAt(this.scheduleInput(now))
  }

  /** Inputs of the decision (the form passed to the pure function). */
  private scheduleInput(now: number): ScanScheduleInput {
    return {
      now,
      home: this.home,
      roots: this.scanRoots(),
      rulesVersion: RULES_VERSION,
      recorded: this.readLastFullScan(),
      runs: this.index.latestScanRuns(),
      intervalMs: this.settings.readTyped(SCAN_INTERVAL_MS) ?? undefined,
      outsideHomeIntervalMs: this.settings.readTyped(SCAN_OUTSIDE_HOME_INTERVAL_MS) ?? undefined
    }
  }

  /** Decides whether to run a full scan. Gathers the inputs and passes them to the pure function. */
  decide(now: number = this.clock()): ScanDecision {
    const decision = shouldFullScan(this.scheduleInput(now))
    if (decision.full || !this.tccCatchUpPending(now)) return decision
    const root = this.tccCatchUpRoot()
    if (root === null) return decision
    return { full: true, reason: 'tcc-released', root, lastFullScanAt: decision.lastFullScanAt }
  }

  /** Is the deferral in effect right now? (protected folders are left out of the scan and the watch) */
  private tccDeferred(now: number = this.clock()): boolean {
    return this.tccDeferral && this.tccDeferUntil > now
  }

  /** The deferral has ended, but a scan including the protected folders has not been done yet. */
  private tccCatchUpPending(now: number = this.clock()): boolean {
    return this.tccDeferral && this.tccDeferUntil > 0 && this.tccDeferUntil <= now
  }

  /** The rules applied to the scan and the watch. During the deferral, a copy with the protected-folder exclusion added (the gate and listings keep using `this.rules`). */
  private scanRules(now: number = this.clock()): ExclusionRules {
    return this.tccDeferred(now) ? withTccDeferred(this.rules) : this.rules
  }

  /** The deepest of the scan roots that contain protected folders (normally the home directory). null if none. */
  private tccCatchUpRoot(): string | null {
    let best: string | null = null
    for (const root of this.scanRoots()) {
      if (!isUnderHome(this.home, root)) continue
      if (best === null || foldPath(root).length > foldPath(best).length) best = root
    }
    return best
  }

  /**
   * Reads the deferral deadline. If it has not been decided yet, decides and writes it: if the DB has a scan track record (a completion record or `scan_runs` rows),
   * the user is already using the app so there is no deferral (`0`); otherwise they are new, so "now + 3 days".
   */
  private initTccDeferral(now: number = this.clock()): void {
    if (!this.tccDeferral) return
    const stored = this.settings.readTyped(FS_TCC_DEFER_UNTIL)
    if (stored !== null) {
      this.tccDeferUntil = stored
    } else {
      const used = this.readLastFullScan() !== null || this.index.latestScanRuns().length > 0
      this.tccDeferUntil = used ? 0 : now + TCC_DEFER_MS
      this.settings.writeTyped(FS_TCC_DEFER_UNTIL, this.tccDeferUntil)
      log.info('fs.tcc.decided', { deferred: !used, until: this.tccDeferUntil })
    }
    this.armTccTimer(now)
    this.status = { ...this.status, tccDeferredUntil: this.tccDeferred(now) ? this.tccDeferUntil : null }
  }

  /**
   * Timer that rechecks the deferral deadline on the wall clock (code-review of TODO 805). The earlier one-shot 3-day `setTimeout` used the monotonic clock
   * and did not advance during sleep; even if the scheduled run's decision (`decide()`, wall clock) ran the catch-up scan in the meantime, re-establishing the watch and
   * clearing state did not come until the timer fired. Every `tccCheckMs` (or the remainder if shorter) it compares with `clock()` again,
   * and if the deadline has passed it goes through the release (`releaseTccDeferral('expired')` -> `settleTccRelease`).
   */
  private armTccTimer(now: number = this.clock()): void {
    this.clearTccTimer()
    if (!this.tccDeferred(now) || this.stopped) return
    const timer = setTimeout(
      () => {
        this.tccTimer = null
        if (this.stopped) return
        if (this.tccDeferred()) this.armTccTimer()
        else void this.releaseTccDeferral('expired')
      },
      Math.min(Math.max(0, this.tccDeferUntil - now), this.tccCheckMs)
    )
    timer.unref?.()
    this.tccTimer = timer
  }

  private clearTccTimer(): void {
    if (this.tccTimer !== null) clearTimeout(this.tccTimer)
    this.tccTimer = null
  }

  /**
   * Ends the protected-folder deferral (TODO 805). If `path` is given, it ends only when that is inside a protected folder
   * (opened in the Files tree / made a working folder / added to the reference scope). It does nothing unless the deferral is in effect or the deadline has passed but the catch-up scan
   * has not been done. After ending it does the release cleanup (`settleTccRelease`: re-establish the watch including the protected folders)
   * and starts an incremental scan including the protected folders (full speed if triggered by the user's action; for a release by the deadline, the same pacing stage as the scheduled run).
   * It does not wait for the scan.
   */
  async releaseTccDeferral(reason: TccReleaseReason, path: string | null = null): Promise<void> {
    if (this.stopped || !this.tccDeferral) return
    const now = this.clock()
    if (path !== null && !isUnderTccDeferred(path, this.home)) return
    if (this.tccDeferred(now)) {
      this.tccDeferUntil = now
      this.settings.writeTyped(FS_TCC_DEFER_UNTIL, now)
    } else if (!this.tccCatchUpPending(now)) {
      return
    }
    log.info('fs.tcc.released', { reason })
    await this.settleTccRelease()
    void this.runTccCatchUp(reason !== 'expired')
  }

  /**
   * Cleanup after the deferral ends (code-review of TODO 805). The deadline recheck, an early release by the user, and the catch-up scan picked up first by the scheduled run's decision (`decide()`) and
   * that scan's completion, **every path goes through this same place**: it stops the recheck timer,
   * clears the "deferred" state, and re-establishes the watch that had been set up without the protected folders. Safe to call any number of times (does nothing if already done).
   */
  private settleTccRelease(): Promise<void> {
    if (this.stopped || this.tccDeferred()) return Promise.resolve()
    this.clearTccTimer()
    if (this.status.tccDeferredUntil !== null) this.setStatus({ tccDeferredUntil: null })
    return this.rewatchIfStale()
  }

  /** Re-establishes the watch if the deferral state differs from when it was set up. If one is being set up, it is re-established within that. */
  private rewatchIfStale(): Promise<void> {
    if (this.rewatching !== null) return this.rewatching
    if (this.stopped || this.watchStarting || this.watch === null) return Promise.resolve()
    if (this.watchDeferred === this.tccDeferred()) return Promise.resolve()
    const task = this.rewatch(this.watch)
      .catch((err: unknown) => log.warn('fs.watch.rewatch.failed', errorFields(err)))
      .finally(() => {
        this.rewatching = null
      })
    this.rewatching = task
    return task
  }

  /**
   * Re-establishes the watch with the current rules (code-review of TODO 805). **Leaves no gap**: (1) take the mark while the old subscription is alive,
   * (2) set up the new subscription, (3) stop the old one, (4) replay the FSEvents history from the mark of (1). The saved mark
   * (`FS_WATCH_MARK`) is advanced only after (4) has been applied (`catchUpWatch`). What remained in the old subscription's batch (16 ms)
   * is discarded when it stops, but it is a change after (1), so (4) picks it up. Diffs in the overlapping period arrive twice, but applying them
   * just rewrites the same row. If the mark could not be taken, no replay is possible, so the saved mark is not advanced either (left to the replay at the next launch).
   */
  private async rewatch(old: WatchHandle): Promise<void> {
    const from = await this.watchBackend.takeWatchMark(this.home)
    if (this.stopped || this.watch !== old) return
    this.watch = null
    this.retiringWatch = old
    try {
      await this.startWatching(from === null ? { saveMark: false } : { replayFrom: from })
    } finally {
      // If `stop()` took it first (stopped it), do not touch it.
      if (this.retiringWatch === old) {
        this.retiringWatch = null
        await old.stop()
      }
    }
  }

  /**
   * The scan including protected folders. **It first waits for the launch scan to finish** (code-review of TODO 805: if a release right after launch
   * started a full-speed scan first, the launch scan (`startup`, pacing stage and interruption under heat / low power) was dropped by `scanning`).
   * If a scan is running, it waits for that too. If the scan it waited for has finished walking the protected folders (`tccCatchUpPending` is false),
   * it does nothing.
   */
  private async runTccCatchUp(byUser: boolean): Promise<void> {
    for (;;) {
      if (this.stopped) return
      const startup = this.startupTask
      if (startup !== null) {
        await startup.catch(() => {})
        continue
      }
      if (!this.scanning) break
      const running = this.scanTask
      if (running !== null) await running.catch(() => {})
      if (this.scanning) await new Promise((done) => setTimeout(done, 50))
    }
    if (!this.tccCatchUpPending()) return
    const plan = this.plan()
    if (plan === null) return
    log.info('fs.scan.tcc-catch-up', { reason: plan.reason, deep: plan.deep, roots: plan.roots.length, byUser })
    const task = byUser ? this.scan(plan) : this.scan({ ...plan, auto: true })
    this.scanTask = task
    await task.catch(() => {})
  }

  /** The record of the last completed full scan. If broken, it is treated as "no record" and falls back to a full scan. */
  private readLastFullScan(): LastFullScanRecord | null {
    const record = this.settings.readTyped(SCAN_LAST_FULL)
    const rulesVersion = this.settings.readTyped(SCAN_RULES_VERSION)
    if (record === null || rulesVersion === null) return null
    return { finishedAt: record.finishedAt, home: record.home, roots: record.roots, rulesVersion }
  }

  /** The completion record. `rulesVersion` is read from T4 on, so it is also stored under a separate key. */
  private writeLastFullScan(record: LastFullScanRecord): void {
    this.transaction(() => {
      this.settings.writeTyped(SCAN_LAST_FULL, {
        finishedAt: record.finishedAt,
        home: record.home,
        roots: record.roots
      })
      this.settings.writeTyped(SCAN_RULES_VERSION, record.rulesVersion)
    })
  }

  /**
   * Shutdown. Even if called while a scan is running, it waits until the scan ends.
   * If it returned without waiting, after the caller closed the DB the scan's transaction
   * would run and fail with `The database connection is not open`.
   *
   * The watch is stopped twice: first (the one currently set up, immediately), and again
   * after waiting for the scan / watch start-up (the one whose shutdown arrived during the `watchTree` await).
   * On the skip path (`start()` skipped the scan), `scanTask` is the watch start-up itself.
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.stopRequested = true
    this.auto.stop()
    if (this.markTimer !== null) clearInterval(this.markTimer)
    this.markTimer = null
    this.clearTccTimer()
    await this.stopWatching()
    const task = this.scanTask
    this.scanTask = null
    await task?.catch(() => {})
    // A subtree scan (item 246) looks at `stopped` at a boundary and leaves. Waiting requests return with
    // `stopped` without touching the DB. It waits for the whole chain: returning without waiting would send a batch to write into a closed DB (12.9).
    await this.subtreeChain.catch(() => {})
    // A permission change writes the setting after waiting for diskutil. Returning without waiting would write into a closed DB (TODO 1124).
    while (this.volumeOps.size > 0) await Promise.allSettled([...this.volumeOps])
    await this.stopWatching()
    // Applying diffs looks at `stopped` at batch boundaries and leaves. We wait until it leaves:
    // returning without waiting would let the next batch write into the DB the caller closed (12.9).
    // The remainder of the batch from when the watch was stopped (`drainChanges`, TODO 889) is also queued on this chain. What is queued
    // while waiting (from stopping a subscription being re-established) is waited for too: `drainClosed` is set at the very moment (synchronously) the chain stops growing, and after that nothing is queued.
    for (;;) {
      const tail = this.changesTask
      await tail
      if (tail === this.changesTask) break
    }
    this.drainClosed = true
    // The watch mark (`FS_WATCH_MARK`) is not advanced during shutdown (`saveWatchMark` refuses on `stopped`). The saved mark is
    // before the changes already applied, so what was dropped by the drain limit and changes that happened after the watch was removed are picked up by the replay at the next launch.
    // Taking the mark and replaying (`markTask`, TODO 833) are **not waited for** (code-review of TODO 833). Reading the FSEvents history
    // (`getEventsSince`) cannot be cancelled, and quitting right after a long absence used to make shutdown wait several seconds or more. Nothing is written after the DB is closed even without waiting,
    // because every DB access of `markTask` is confined to "a synchronous stretch right after seeing `stopped`"
    // (marks are written right where `stopped` is seen, and `enqueueChanges` refuses applying the replay on `stopped`).
    // `stopped` is set synchronously at the head of this function, so any stretch that starts after this always sees it.
  }

  private async stopWatching(): Promise<void> {
    const handle = this.watch
    this.watch = null
    const retiring = this.retiringWatch
    this.retiringWatch = null
    await handle?.stop()
    await retiring?.stop()
  }

  /**
   * Sets up the watch. If `replayFrom` (a mark) is given, after setting up it replays changes after that mark from the FSEvents history
   * (TODO 833; proceeds without waiting, via `markTask`). It takes a mark right after setting up, and saves it once the replay and the live diffs that came
   * until then have been applied (the starting point for the next launch). With `saveMark: false` it does not save (to leave the gap that could not be replayed).
   */
  private async startWatching(
    options: { readonly replayFrom?: string | null; readonly saveMark?: boolean } = {}
  ): Promise<void> {
    // If a scan ends during shutdown, a watch set up here could not be stopped by anyone.
    if (this.stopped || this.watch !== null || this.watchStarting) return
    this.watchStarting = true
    try {
      for (;;) {
        // During the deferral, set up without the protected folders (TODO 805: they go into the native ignore, and on ambiguous FSEvents diffs
        // parcel does not `stat` / `open` = no TCC dialog appears).
        const deferred = this.tccDeferred()
        const rules = this.scanRules()
        // The watch is set up only under the home directory. Changes elsewhere on the PC are picked up by rescans (12.7 / 12.8).
        const handle = await this.watchBackend.watchTree(this.home, rules, (changes) => {
          // What arrives during shutdown is only the remainder of the batch when the watch was stopped (and the flush while it was detached) (TODO 889).
          if (this.stopped) this.drainChanges(changes)
          else void this.enqueueChanges(changes)
        })
        if (this.stopped) {
          // Shutdown arrived while setting up. `stop()` is waiting for this Promise,
          // so stopping here means no diff flows after the DB is closed.
          await handle.stop()
          return
        }
        if (deferred !== this.tccDeferred()) {
          // The deferral ended while setting up (TODO 805). Set it up again in the current state.
          await handle.stop()
          continue
        }
        this.watch = handle
        this.watchDeferred = deferred
        const previous = options.replayFrom ?? null
        const saveMark = options.saveMark ?? true
        this.markTask = this.markTask
          .then(() => this.catchUpWatch(rules, previous, saveMark))
          .catch((err: unknown) => {
            log.warn('fs.watch.replay.failed', errorFields(err))
          })
        this.startMarkTimer()
        return
      }
    } finally {
      this.watchStarting = false
    }
  }

  /**
   * Takes a mark right after setting up, replays changes after `previous`, and saves the mark once they are applied (TODO 833).
   * When the mark is too old (older than the deep-scan interval), no replay: the history would balloon, and the deep scan runs because it is overdue anyway.
   */
  private async catchUpWatch(rules: ExclusionRules, previous: string | null, saveMark: boolean): Promise<void> {
    const mark = await this.watchBackend.takeWatchMark(this.home)
    if (this.stopped) return
    if (previous !== null) {
      const at = watchMarkTime(previous)
      const deepMs = this.settings.readTyped(SCAN_DEEP_INTERVAL_MS) ?? DEFAULT_DEEP_SCAN_INTERVAL_MS
      if (at === null || Date.now() - at > deepMs) {
        log.info('fs.watch.replay.skipped', { reason: at === null ? 'unreadable' : 'too-old' })
      } else {
        const startedAt = Date.now()
        let changes: RawChange[]
        try {
          // It also looks at `stopped` between roots and leaves (so shutdown is not made to wait: `stop()` does not wait here).
          changes = await this.watchBackend.changesSince(this.home, rules, previous, () => this.stopped)
        } catch (err) {
          // The history cannot be used (FSEvents DB recreated, or events lost). What was missed is picked up by the next scan.
          log.warn('fs.watch.replay.failed', errorFields(err))
          changes = []
        }
        if (this.stopped) return
        // A delete in the replay is limited to what does not exist right now, so that it does not remove something recreated afterwards
        // (a live create applied first). create / update do an `lstat` when applied, so they fail if the file is gone.
        const effective = changes.filter((change) => change.type !== 'delete' || !existsNow(change.path))
        log.info('fs.watch.replayed', {
          events: changes.length,
          applied: effective.length,
          sinceMs: startedAt - (at ?? startedAt),
          ms: Date.now() - startedAt
        })
        await this.enqueueChanges(effective)
      }
    }
    if (saveMark) await this.saveWatchMark(mark)
  }

  /**
   * Saves the mark (TODO 833). It writes only after applying the live diffs up to the moment the mark was taken (waiting out FSEvents' 1 ms latency and the 16 ms batching)
   * and the replay queued before that: if the mark passes changes that were not applied, the replay at the next launch cannot
   * pick them up either. Not written during shutdown (written right where `stopped` is seen; `stop()` does not wait here).
   */
  private async saveWatchMark(mark: string | null): Promise<void> {
    if (mark === null || this.stopped) return
    await new Promise((done) => setTimeout(done, 100))
    await this.changesTask
    if (this.stopped) return
    this.settings.writeTyped(FS_WATCH_MARK, mark)
  }

  /**
   * Retakes the mark periodically (TODO 833). It saves after applying the live diffs up to the moment it was taken, so the replay at the next
   * launch only needs "after the last saved mark" (when resident for long, the history from the launch-time mark would balloon).
   */
  private startMarkTimer(): void {
    if (this.markTimer !== null || this.stopped) return
    const timer = setInterval(() => {
      if (this.stopped || this.watch === null) return
      this.markTask = this.markTask
        .then(async () => {
          // Not taken while a re-establishment is in progress, so that the mark does not skip over the gap before the re-establishment's replay (`rewatch`) is done.
          if (this.stopped || this.watch === null || this.rewatching !== null) return
          await this.saveWatchMark(await this.watchBackend.takeWatchMark(this.home))
        })
        .catch((err: unknown) => log.warn('fs.watch.mark.failed', errorFields(err)))
    }, WATCH_MARK_INTERVAL_MS)
    timer.unref?.()
    this.markTimer = timer
  }

  /**
   * Scans the set of roots in order and reflects them into `documents`.
   * Writes to the encrypted DB cost +77% compared with plaintext, so batches are grouped into transactions.
   *
   * **There are two ways to run it** (6.2.2):
   *
   * - **Deep scan** (`deep`, the default): walks all roots, re-stamps `seen_at` on every entry, and cleans up
   *   `seen_at < this time`. Only this can drop trees that became out of scope when the exclusion rules changed.
   *   A manual rescan also uses this.
   * - **Incremental scan**: walks only the roots that are due. A directory whose mtime is unchanged
   *   is **not opened and none of its child rows is touched** (pruning). Unchanged rows are not written either.
   *   Cleanup is limited to "entries directly under directories whose mtime changed that do not exist now",
   *   so rows of roots that were not walked do not disappear.
   */
  async scan(options: ScanRunOptions = {}): Promise<void> {
    if (this.scanning || this.stopped) return
    this.scanning = true
    this.stopRequested = false
    this.currentScanPaced = options.auto === true || options.startup === true
    // If a subtree scan (item 246) is writing, wait for it to finish before starting
    // (to keep one writer, 6.2). It does not wait long, thanks to the upper bound (`SUBTREE_MAX_MS`).
    // `scanning` is set first: subtree requests that arrive while waiting go after this scan.
    if (this.subtreeActive !== null) {
      await this.subtreeActive.catch(() => {})
      if (this.stopped) {
        this.currentScanPaced = false
        this.scanning = false
        return
      }
    }
    const deep = options.deep ?? true
    const startedAt = Date.now()
    this.deletedDuringScan = new Set()
    const counters: ScanCounters = { seen: 0, excluded: 0, denied: 0, pruned: 0 }
    const deniedExamples: string[] = []
    let indexed = 0
    let written = 0

    // **The scheduled scan and the launch full scan walk by the pacing stage** (TODO 434 -> TODO 448). When idle:
    // full speed; when the user is operating: slow (after each step it rests (100/N - 1) times the CPU time); under heat / Low Power Mode:
    // interrupted. One step is one batch of `walk` (`SLOW_SCAN_BATCH` entries if started slow) plus its write, and
    // in the cleanup afterward one `yieldToLoop`. A manual rescan (`rescan()`) and a subtree scan stay
    // at full speed (what the user pressed / is waiting for).
    const pacer = this.auto.pacer
    const scanClock = this.currentScanPaced ? pacer.clock() : null
    const walkBatchSize =
      scanClock !== null && this.auto.pace() !== 'full' ? SLOW_SCAN_BATCH : undefined
    const paceStep = async (items: number): Promise<void> => {
      if (scanClock === null) return
      const pace = this.auto.pace()
      pacer.note('scan', pace, items)
      if (pace === 'full') {
        scanClock.restMs()
        return
      }
      if (pace === 'hold') this.abortAutoScan(this.auto.holdReason() ?? 'thermal')
      await pacer.rest(scanClock.restMs(), () => this.stopped || this.auto.pace() === 'full')
    }
    const scanYield = async (): Promise<void> => {
      await yieldToEventLoop()
      await paceStep(0)
    }

    this.setStatus({
      state: 'scanning',
      seen: 0,
      indexed: 0,
      excluded: 0,
      denied: 0,
      deniedExamples: [],
      startedAt,
      finishedAt: null,
      message: null,
      skipped: false
    })

    const allRoots = this.scanRoots()
    const roots = options.roots ?? allRoots
    const inRun = new Set(roots.map(foldPath))
    // Protected-folder deferral (TODO 805): during the deferral, walk with the rules that leave out protected folders (no rows are created either). On a run after the deferral ended
    // where protected folders have not been walked yet (`tccCatchUp`), it counts as done once the root containing the home directory completes.
    // The deferral is judged by the wall clock (`clock`).
    const tccNow = this.clock()
    const rules = this.scanRules(tccNow)
    const tccCatchUp = this.tccCatchUpPending(tccNow) && roots.some((root) => isUnderHome(this.home, root))
    // A catch-up scan, wherever it starts (including a run the scheduled decision `decide()` picked up before the deadline recheck), goes through the release
    // cleanup (timer, state, re-establishing the watch) by the same path. The re-establishment is not waited for (it proceeds alongside the scan).
    if (tccCatchUp) void this.settleTccRelease()
    /**
     * A catch-up scan does **not prune** inside protected folders (code-review of TODO 805). The watch is re-established including the protected
     * folders at the time of release, so before the scan reaches them, watch diffs may write directory rows inside protected folders with the real
     * mtime. If pruned, their contents that have no rows (never walked during the deferral) would be skipped.
     */
    const noPrune = (path: string): boolean => tccCatchUp && isUnderTccDeferred(path, this.home)
    // In a partial scan, do not descend into roots outside this run's scope (trees walked on a different cycle).
    const otherRoot = (path: string): boolean => {
      const folded = foldPath(path)
      return !inRun.has(folded) && allRoots.some((root) => foldPath(root) === folded)
    }

    // Roots already scanned. `/` is scanned after the home directory, so this avoids doing the work twice.
    const walked: string[] = []
    const alreadyWalked = (path: string): boolean => {
      const folded = foldPath(path)
      return walked.some((root) => folded === root || folded.startsWith(`${root}/`))
    }

    /** Directories whose mtime differed from last time in an incremental scan (the scope of cleanup). */
    const changedDirs = new Map<number, string>()
    /** Row ids of the roots walked (so that cleanup after an interruption does not make it forget their mtime; roots are opened every time). */
    const rootIds = new Set<number>()
    /**
     * Directories put into the queue to open in an incremental scan but not yet fully walked (folded path -> row id;
     * null before the row is written). If interrupted, the mtime of these rows is forgotten (item 250).
     */
    const unfinished = new Map<string, number | null>()
    /** Directories whose direct children have all been queued but that batch has not been written yet (`onDirectoryDone` of `walk`). */
    let doneSinceBatch: string[] = []
    const settleDone = (): void => {
      for (const dir of doneSinceBatch) unfinished.delete(foldPath(dir))
      doneSinceBatch = []
    }

    const writeBatch = (entries: readonly ScannedEntry[]): void => {
      for (const entry of entries) {
        const parentId = this.index.ensureDirectory(entry.parentPath, startedAt)
        const input = {
          parentId,
          name: entry.name,
          isDirectory: entry.isDirectory,
          ext: entry.isDirectory ? '' : extensionOf(entry.name),
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          seenAt: startedAt,
          dataless: entry.dataless
        }
        let id: number
        if (deep) {
          id = this.index.upsertFsEntry(input).id
          written += 1
        } else {
          const row = this.index.upsertFsEntryIncremental(input)
          id = row.id
          if (row.changed) written += 1
        }
        if (entry.isDirectory) {
          this.index.rememberDirectory(entry.path, id)
          const folded = foldPath(entry.path)
          if (unfinished.has(folded)) unfinished.set(folded, id)
        }
      }
    }

    /** Trees protected from cleanup (row ids of unmounted allowed volumes). */
    const keepSubtrees: number[] = []
    let completed = false

    try {
      this.index.resetCaches()
      this.index.ensureRoot()
      // Scan history (6.2). First tidy what the previous launch left unfinished when it crashed, then create this time's rows.
      this.index.abortDanglingScanRuns(startedAt)
      this.index.beginScanRun(roots, startedAt)

      for (const root of roots) {
        if (this.stopRequested) break
        const before = { ...counters, indexed }
        const finishRoot = (): void =>
          this.index.finishScanRoot(root, startedAt, Date.now(), {
            seen: counters.seen - before.seen,
            indexed: indexed - before.indexed,
            excluded: counters.excluded - before.excluded,
            denied: counters.denied - before.denied
          })
        if (alreadyWalked(root)) {
          // The parent root has already been walked. The scan is done, so the row is also made done.
          finishRoot()
          continue
        }
        if (this.skippedVolumeRoot(root)) {
          // An allowed volume that is unmounted (or a different disk). It is not walked, but
          // if a row already exists, the whole tree is protected from cleanup. The ancestor's (`/Volumes`) `seen_at` must
          // also be touched, or the ancestor goes stale and is removed, taking the tree with it via CASCADE.
          const existing = this.index.findByPath(root)
          if (existing !== null) {
            this.index.ensureDirectory(dirname(root), startedAt)
            keepSubtrees.push(existing)
          }
          log.info('fs.scan.volume-skipped', { root, mounted: this.volumes.isMounted(root) })
          finishRoot()
          continue
        }
        const rootId = this.index.ensureDirectory(root, startedAt)
        rootIds.add(rootId)
        // **Pruning applies only to roots under the home directory** (6.2.2). The mtime reflects only the direct children, so
        // changes in grandchildren and below are allowed only to the extent the watch (fsevents) can pick them up. Outside the home directory
        // there is no watch, so even an incremental scan walks everything (it only skips writes).
        const prune = !deep && this.pruneEnabled() && isUnderHome(root, this.home)
        // In an incremental scan, the direct children of a walked root are always subject to cleanup.
        if (!deep) changedDirs.set(rootId, root)

        for await (const batch of walk(root, rules, counters, {
          onDenied: (denial) => {
            if (deniedExamples.length < 10) deniedExamples.push(pathToUri(denial.path))
            this.recordDenial(denial.path, denial.code)
          },
          shouldStop: () => this.stopRequested,
          shouldSkipDirectory: (path) => alreadyWalked(path) || otherRoot(path),
          // Even a deep scan looks up the previous row (it does not prune: `prune` is false). To know
          // which rows are "not fully walked" and "need cleanup" if interrupted (item 250). One index lookup per directory.
          shouldPrune: (path: string, mtimeMs: number): boolean => {
            const previous = this.index.fsRowAt(path)
            if (previous !== null && previous.kind === 'directory') {
              // mtime is the same as last time: either prune (an incremental scan under the home directory) or open without pruning. In both cases the row's
              // mtime stays as last time, so even if it stops before opening, the next run's decision does not change.
              if (previous.mtimeMs === Math.round(mtimeMs)) return prune && !noPrune(path)
              // Entries directly under it increased or decreased = this directory is subject to cleanup (the scoped cleanup of an incremental scan).
              changedDirs.set(previous.id, path)
            }
            // The row of a directory that differs from last time (or did not exist last time) is written with the new mtime
            // before it is opened. Remember it until it is fully walked (item 250).
            unfinished.set(foldPath(path), null)
            return false
          },
          onDirectoryDone: (path: string): void => {
            doneSinceBatch.push(path)
          },
          ...(walkBatchSize === undefined ? {} : { batchSize: walkBatchSize })
        })) {
          // One batch = one transaction (to counter the write cost of the encrypted DB).
          this.transaction(() => writeBatch(batch))
          // Directories whose direct children were queued before this batch now have all their direct rows in.
          settleDone()
          indexed += batch.length
          this.setStatus({
            seen: counters.seen,
            indexed,
            excluded: counters.excluded,
            denied: counters.denied,
            deniedExamples: [...deniedExamples]
          })
          await paceStep(batch.length)
        }
        // Those whose queueing finished after the last batch (their direct children had all gone into earlier batches) are also fully walked.
        settleDone()
        walked.push(foldPath(root))
        if (this.stopRequested) break
        finishRoot()
      }

      // **Cleanup after an interrupted incremental scan** (item 250). An incremental scan rewrites a directory's row to the
      // new mtime "at the moment it is found" and opens it later. The (scoped) cleanup also runs all at once at the end. If it stops here,
      // the next incremental scan prunes it as "same mtime as last time", and does not pick up additions and removals inside until the deep scan (7 days).
      // So the rows of (1) directories put in the queue to open but not fully walked, and (2) directories whose mtime changed
      // (= need cleanup) are set back to mtime 0. New directories that were fully walked and
      // unchanged (pruned) ones are not touched. Roots are opened every time, so they are out of scope.
      // **An interrupted deep scan is the same**: not treating it as complete (T3) is as before, and in addition the same rows are put back.
      // If a scheduled deep scan is interrupted, the next one is deep too, so there is no harm, but when a manual rescan (deep) was
      // stopped by shutdown, the next launch becomes `aborted` -> incremental and falls into the same hole. A run stopped by shutdown
      // also passes through here (`stop()` waits for this scan, so the DB is still open).
      let forgotten = 0
      if (this.stopRequested) {
        const ids = new Set<number>()
        for (const id of changedDirs.keys()) if (!rootIds.has(id)) ids.add(id)
        for (const id of unfinished.values()) if (id !== null && !rootIds.has(id)) ids.add(id)
        forgotten = ids.size
        if (ids.size > 0) await this.index.forgetDirectoryMtimes([...ids], yieldToEventLoop)
      }

      // What disappeared during the scan (TODO 262). If a batch wrote it back, it is dropped here.
      // This is done for an interrupted run too (the rows written back remain even if interrupted).
      const resurrected = await this.dropDeletedDuringScan()

      // Drop rows that existed last time but were not seen this time. Deletions and moves vanish through this
      // (the index's chunks vanish with them = the tombstone of 6.2).
      // **Await it**: it deletes a little at a time inside, freeing the main thread.
      if (!this.stopRequested) {
        const sweepStartedAt = Date.now()
        const removed = deep
          ? await this.index.removeStale(startedAt, scanYield, keepSubtrees)
          : await this.sweepChangedDirs(changedDirs, keepSubtrees, undefined, scanYield)
        log.info('fs.scan.swept', {
          deep,
          removed,
          resurrected,
          scope: deep ? roots.length : changedDirs.size,
          kept: keepSubtrees.length,
          ms: Date.now() - sweepStartedAt
        })
      }

      const finishedAt = Date.now()
      if (!this.stopRequested) {
        // The completion record. An interrupted run does not reach here, so it is not "treated as complete".
        completed = true
        // Only a run that walked the protected folders to the end without pruning counts as done (an interrupted run does not reach here).
        if (tccCatchUp && this.tccCatchUpPending()) {
          this.tccDeferUntil = 0
          this.settings.writeTyped(FS_TCC_DEFER_UNTIL, 0)
          log.info('fs.tcc.caught-up', {})
          void this.settleTccRelease()
        }
        // **A partial scan does not rewrite `scan.lastFull`**: that is the record of a run that
        // walked all roots to the end; the freshness of each root is held by `scan_runs`.
        if (deep) {
          this.writeLastFullScan({
            finishedAt,
            home: this.home,
            roots: allRoots,
            rulesVersion: RULES_VERSION
          })
          this.settings.writeTyped(SCAN_LAST_DEEP, finishedAt)
        }
        this.index.pruneScanRuns(SCAN_RUNS_KEEP)
      }

      this.setStatus({
        state: 'done',
        finishedAt,
        seen: counters.seen,
        indexed,
        excluded: counters.excluded,
        denied: counters.denied,
        deniedExamples: [...deniedExamples],
        message: null,
        nextFullScanAt: this.nextFullScanAt(),
        ...(completed && deep ? { lastFullScanAt: finishedAt } : {})
      })
      log.info(completed ? 'fs.scan.done' : 'fs.scan.aborted', {
        ms: Date.now() - startedAt,
        deep,
        seen: counters.seen,
        indexed,
        written,
        pruned: counters.pruned,
        excluded: counters.excluded,
        denied: counters.denied,
        ...(completed ? {} : { forgotten })
      })
      this.events.onIndexable?.()
    } catch (err) {
      log.error('fs.scan.failed', errorFields(err))
      this.setStatus({
        state: 'error',
        finishedAt: Date.now(),
        message: err instanceof Error ? err.message : 'scan failed'
      })
    } finally {
      // A run that did not complete (interrupted or an exception) marks all rows of the same run aborted.
      // That includes roots that finished walking: since the cleanup did not run, it is not a completion.
      // It cannot write if the DB is closed, but `stop()` returns only after waiting for this scan,
      // so the connection is still open by the time we get here.
      if (!completed) {
        try {
          this.index.abortScanRun(startedAt, Date.now())
        } catch (err) {
          log.warn('fs.scan.abort-record.failed', errorFields(err))
        }
      }
      this.deletedDuringScan = null
      if (scanClock !== null) pacer.idle('scan')
      this.currentScanPaced = false
      this.scanning = false
    }
  }

  /**
   * Of the paths deleted during a scan, drops those that **still do not exist** but have a row, together with their descendants
   * (TODO 262). Called in the same flow as the scan's writes (at the end of `scan`). Returns the number of rows dropped.
   */
  private async dropDeletedDuringScan(): Promise<number> {
    const paths = this.deletedDuringScan
    this.deletedDuringScan = null
    if (paths === null || paths.size === 0) return 0
    const ids = new Set<number>()
    let checked = 0
    for (const path of paths) {
      if (this.stopped) return 0
      if ((checked += 1) % CHANGE_BATCH === 0) await yieldToEventLoop()
      const id = this.index.findByPath(path)
      if (id === null || ids.has(id)) continue
      const exists = await lstat(path).then(
        () => true,
        (err: NodeJS.ErrnoException) => err.code !== 'ENOENT' && err.code !== 'ENOTDIR'
      )
      if (exists) continue
      for (const sub of this.index.subtreeIds(id)) ids.add(sub)
    }
    if (ids.size === 0 || this.stopped) return 0
    await this.index.deleteDocuments([...ids], yieldToEventLoop)
    return ids.size
  }

  /** Whether pruning is enabled (setting `0` in `scan.prune` turns it off). */
  private pruneEnabled(): boolean {
    return this.settings.readTyped(SCAN_PRUNE) !== 0
  }

  /**
   * Cleanup of an incremental scan (6.2.2). Only directories whose mtime changed are **read again**, and
   * rows whose names no longer exist are dropped. It does not look at `seen_at`, so it never touches rows of roots that were not walked or of
   * pruned trees. A directory that could not be read is **skipped** (the safe side:
   * contents are not deleted just because a permission was revoked).
   */
  private async sweepChangedDirs(
    changed: ReadonlyMap<number, string>,
    keepIds: readonly number[],
    // A subtree scan (item 246) does not look at `stopRequested`: that is the interruption flag for one full scan, and
    // after an interrupted scheduled scan it stays true until the next full scan.
    shouldStop: () => boolean = () => this.stopRequested || this.stopped,
    // A scheduled scan passes the entry point that rests at the slow stage (TODO 434). The default only yields.
    yieldToLoop: () => Promise<void> = yieldToEventLoop
  ): Promise<number> {
    const entries: { parentId: number; present: Set<string> }[] = []
    for (const [parentId, path] of changed) {
      if (shouldStop()) return 0
      let present: Set<string>
      try {
        present = new Set<string>()
        const handle = await opendir(path)
        for await (const dirent of handle) present.add(foldPath(dirent.name))
      } catch {
        continue
      }
      entries.push({ parentId, present })
      await yieldToLoop()
    }
    return this.index.removeMissingChildren(entries, yieldToLoop, keepIds)
  }

  /**
   * A manual rescan. It does not go through the launch-time thinning decision and always runs.
   * If one is already running, it just waits for that scan (to avoid replacing `scanTask`
   * so that `stop()` could no longer wait for the real one).
   */
  async rescan(): Promise<void> {
    if (this.stopped) return
    if (this.scanning) {
      await this.scanTask?.catch(() => {})
      return
    }
    this.scanTask = this.scan()
    await this.scanTask
  }

  /**
   * Incrementally scans only the subtree of `path`, right now. Main requests it exactly once
   * when a thread is created (when the cwd is decided). A folder created / cloned while aios was stopped
   * is not in the index until the next scheduled scan, because the launch scan is thinned out (T3) and the watch sees only changes after launch.
   * The `@` candidates (114) and the "this working folder" section (100) are both drawn from the index's tree,
   * so they stay empty in the meantime (the measurement of 244).
   *
   * The shape is exactly T9's incremental scan: unchanged rows are not written, pruning applies under the home directory,
   * and cleanup covers only "directly under directories whose mtime changed" (no whole `seen_at` cleanup).
   * It does not touch `scan.lastFull` / `scan.lastDeep` / `scan_runs` / the status bar (`ScanStatus`):
   * this is not a full scan.
   *
   * - **While a request for the same path is waiting / running, it merges** (returns the same Promise).
   * - Requests flow one at a time, and **if a full scan is running they run after it finishes**. Conversely a full scan
   *   starts after waiting for a running subtree scan (`scan`). There is one index writer (6.2).
   * - If the limits (`SUBTREE_MAX_ENTRIES` / `SUBTREE_MAX_MS`) are exceeded, it stops and returns `truncated`.
   */
  scanSubtree(path: string, limits: SubtreeScanLimits = {}): Promise<SubtreeScanResult> {
    if (this.stopped) return Promise.resolve({ state: 'skipped', reason: 'stopped' })
    const target = isAbsolute(path) ? resolve(path) : path
    // Making something inside a protected folder the working folder = the user chose it explicitly. End the deferral (TODO 805).
    if (isAbsolute(target) && this.tccDeferred()) void this.releaseTccDeferral('cwd', target)
    const key = foldPath(target)
    const pending = this.subtreePending.get(key)
    if (pending !== undefined) return pending
    const task = this.subtreeChain.then(() => this.runSubtreeScan(target, limits))
    const settled = task.finally(() => {
      if (this.subtreePending.get(key) === settled) this.subtreePending.delete(key)
    })
    this.subtreePending.set(key, settled)
    this.subtreeChain = settled.catch(() => {})
    return settled
  }

  /** One slot of the chain. If a full scan is running it waits, and once it starts writing it is put on `subtreeActive`. */
  private async runSubtreeScan(path: string, limits: SubtreeScanLimits): Promise<SubtreeScanResult> {
    // If a full scan is running, defer. While `scanning` is set, `scanTask` is that scan
    // (`start` / `rescan` / the scheduled run all assign it in the same synchronous stretch where they call `scan()`).
    while (this.scanning && !this.stopped) {
      const running = this.scanTask
      if (running === null) await new Promise((done) => setTimeout(done, 50))
      else await running.catch(() => {})
    }
    if (this.stopped) return { state: 'skipped', reason: 'stopped' }
    // From here on, `subtreeActive` is set in the same synchronous stretch where `scanning` was seen
    // (an await in between would overlap with a full scan that started in the gap).
    const run = this.walkSubtree(path, limits)
    this.subtreeActive = run
    try {
      return await run
    } finally {
      if (this.subtreeActive === run) this.subtreeActive = null
    }
  }

  /**
   * The gate of the subtree scan. null if it may be walked, otherwise the reason for refusing.
   *
   * Only "under the home directory" or "under an effective allowed volume" may be walked (of the index scope of T20 / T4,
   * the places backed by the watch or by an allowance). **The scan roots themselves** (the home directory,
   * iCloud Drive, the roots of allowed volumes) are the scheduled scan's job, so they are refused. For exclusion, `path` itself and
   * **all ancestors** up to the scan root containing it are run through `classify`: a full scan prunes at an ancestor,
   * so something like `node_modules/x`, "under an ancestor that matches a name rule", is outside the index scope. Finally
   * `resolvePath` (one implementation of fs-policy) also checks the real target of symlinks.
   */
  private subtreeGate(path: string): SubtreeScanSkipReason | null {
    if (!isAbsolute(path)) return 'excluded'
    const folded = foldPath(path)
    const bases = this.scanRoots().filter(
      (root) => isUnderHome(root, this.home) || this.volumes.isEffective(root)
    )
    let base: string | null = null
    for (const root of bases) {
      if (!isUnderHome(path, root)) continue
      if (base === null || foldPath(root).length > foldPath(base).length) base = root
    }
    if (base === null) return 'outside'
    if (foldPath(base) === folded) return 'root'
    const baseFolded = foldPath(base)
    for (let current = path; foldPath(current) !== baseFolded; current = dirname(current)) {
      if (classify(current, basename(current), true, this.rules).excluded) return 'excluded'
      if (dirname(current) === current) break
    }
    try {
      resolvePath(path, { rules: this.rules }, true)
    } catch {
      return 'excluded'
    }
    return null
  }

  /** The body of the subtree scan. Gate -> root row -> incremental walk -> scoped cleanup (on truncation, forget the mtime). */
  private async walkSubtree(path: string, limits: SubtreeScanLimits): Promise<SubtreeScanResult> {
    const startedAt = Date.now()
    const skipped = (reason: SubtreeScanSkipReason): SubtreeScanResult => {
      log.debug('fs.scan.subtree.skipped', { path, reason })
      return { state: 'skipped', reason }
    }
    const gate = this.subtreeGate(path)
    if (gate !== null) return skipped(gate)
    // **If the root (or an intermediate component) is a symlink, walk the real path** (wave 49 review, the remainder of TODO 924). A full scan does not descend into
    // directory symlinks, and the contents enter under the real path. Walking the logical path made rows under the symlink path, the deep scan's
    // `removeStale` removed them, and the next thread creation made them again, repeatedly. The reason for walking the real target rather than refusing (rows only) is to
    // preserve the purpose of the subtree scan (item 246: showing up at once in the "this working folder" section) even for a thread whose working folder is a symlink:
    // the search's cwd / scope is also converted to the real path with `indexedPathOf` before lookup. The real path goes through the gate again.
    const real = await realpath(path).catch(() => null)
    if (real === null) return skipped('missing')
    if (real !== path) {
      const realGate = this.subtreeGate(real)
      if (realGate !== null) return skipped(realGate)
      log.debug('fs.scan.subtree.realpath', { path, real })
      path = real
    }
    const rootStat = await stat(path).catch(() => null)
    if (rootStat === null || !rootStat.isDirectory()) return skipped('missing')
    if (this.stopped) return skipped('stopped')

    const maxEntries = limits.maxEntries ?? SUBTREE_MAX_ENTRIES
    const deadline = startedAt + (limits.maxMs ?? SUBTREE_MAX_MS)
    const counters: ScanCounters = { seen: 0, excluded: 0, denied: 0, pruned: 0 }
    let written = 0
    let truncated = false
    /** Directory rows touched (those whose mtime is forgotten when truncated). */
    const dirIds: number[] = []
    /** Directories whose mtime differed from last time (the scope of cleanup). The root is always included. */
    const changedDirs = new Map<number, string>()

    try {
      let rootId = 0
      this.transaction(() => {
        // Uses the same connection and the same cache as applying watch diffs. As at the start of a full scan,
        // the cache is dropped before looking up, so as not to hold stale ids.
        this.index.resetCaches()
        const parentId = this.index.ensureDirectory(dirname(path), startedAt)
        const row = this.index.upsertFsEntryIncremental({
          parentId,
          name: basename(path),
          isDirectory: true,
          ext: '',
          size: 0,
          mtimeMs: rootStat.mtimeMs,
          seenAt: startedAt
        })
        if (row.changed) written += 1
        rootId = row.id
        this.index.rememberDirectory(path, row.id)
      })
      dirIds.push(rootId)
      changedDirs.set(rootId, path)

      // Pruning only applies under the home directory (6.2.2). Under an allowed volume there is no watch, so everything is walked.
      const prune = this.pruneEnabled() && isUnderHome(path, this.home)
      for await (const batch of walk(path, this.scanRules(), counters, {
        batchSize: SUBTREE_BATCH,
        onDenied: (denial) => this.recordDenial(denial.path, denial.code),
        shouldStop: () => {
          if (this.stopped) return true
          if (counters.seen >= maxEntries || Date.now() >= deadline) {
            truncated = true
            return true
          }
          return false
        },
        shouldPrune: (dir: string, mtimeMs: number): boolean => {
          const previous = this.index.fsRowAt(dir)
          if (previous === null || previous.kind !== 'directory') return false
          if (previous.mtimeMs !== Math.round(mtimeMs)) {
            changedDirs.set(previous.id, dir)
            return false
          }
          return prune
        }
      })) {
        if (this.stopped) break
        this.transaction(() => {
          for (const entry of batch) {
            const parentId = this.index.ensureDirectory(entry.parentPath, startedAt)
            const row = this.index.upsertFsEntryIncremental({
              parentId,
              name: entry.name,
              isDirectory: entry.isDirectory,
              ext: entry.isDirectory ? '' : extensionOf(entry.name),
              size: entry.size,
              mtimeMs: entry.mtimeMs,
              seenAt: startedAt,
              dataless: entry.dataless
            })
            if (row.changed) written += 1
            if (entry.isDirectory) {
              this.index.rememberDirectory(entry.path, row.id)
              dirIds.push(row.id)
            }
          }
        })
        // Yield between batches (the await in `walk` lasts only during opendir).
        await yieldToEventLoop()
      }
      let removed = 0
      if (truncated || this.stopped) {
        // So that the next incremental scan does not prune trees left unopened (see the store's explanation). No cleanup is done:
        // the next incremental scan opens them because the mtimes disagree and does the direct-children cleanup there. A run that
        // left because of shutdown is the same (`stop()` waits for this scan, so the DB is still open).
        await this.index.forgetDirectoryMtimes(dirIds, yieldToEventLoop)
        if (this.stopped) return skipped('stopped')
      } else {
        removed = await this.sweepChangedDirs(changedDirs, [], () => this.stopped)
      }
      const result: SubtreeScanResult = {
        state: truncated ? 'truncated' : 'done',
        seen: counters.seen,
        written,
        pruned: counters.pruned,
        removed,
        ms: Date.now() - startedAt
      }
      log.info('fs.scan.subtree.done', {
        path,
        state: result.state,
        seen: result.seen,
        written,
        pruned: result.pruned,
        removed,
        excluded: counters.excluded,
        denied: counters.denied,
        ms: result.ms
      })
      // New files enter as `pending`. The usual build rides on P4's decision (waiting for idle), but
      // this subtree's part is built without waiting (item 249). `onIndexable` is signaled first so that
      // if the usual build has already started at idle, this piggybacks on it.
      if (written > 0 || removed > 0) this.events.onIndexable?.()
      this.events.onSubtreeScanned?.(rootId, path)
      return result
    } catch (err) {
      log.warn('fs.scan.subtree.failed', { path, ...errorFields(err) })
      return { state: 'skipped', reason: 'failed' }
    }
  }

  /** For the settings screen: the union of mounted and allowed volumes. Only URIs and names go to the renderer. */
  listVolumes(): readonly VolumeEntry[] {
    return this.volumes.states().map((v) => ({
      uri: pathToUri(v.path),
      name: v.name,
      mounted: v.mounted,
      allowed: v.allowed,
      uuidMismatch: v.uuidMismatch
    }))
  }

  /**
   * Allows / revokes a volume. From the renderer only a URI of the form `/Volumes/<name>` is
   * accepted (no allowing per directory under it). Allowing is limited to mounted volumes
   * (the UUID is taken on the spot).
   *
   * A change takes effect on the 3 paths at once (`rebuildRules`). Reflection into the index is by the next full scan:
   * it erases the previous completed version so the next launch falls back to a full scan, and if resident, starts a rescan right now
   * (if one is running, it is picked up after that run completes via `roots-changed`).
   */
  async setVolumeAllowed(uri: string, allowed: boolean): Promise<readonly VolumeEntry[]> {
    if (this.stopped) return this.listVolumes()
    const op = this.applyVolumeAllowed(uri, allowed)
    this.volumeOps.add(op)
    try {
      return await op
    } finally {
      this.volumeOps.delete(op)
    }
  }

  private async applyVolumeAllowed(uri: string, allowed: boolean): Promise<readonly VolumeEntry[]> {
    const path = pathFromUri(uri)
    if (!isVolumeMountPath(path, this.volumes.volumesDir)) throw new Error('not-a-volume')
    let changed: boolean
    if (allowed) {
      await this.volumes.allow(path)
      changed = true
    } else {
      changed = await this.volumes.disallow(path)
    }
    this.rebuildRules()
    if (changed && !this.stopped) {
      this.settings.removeTyped(SCAN_RULES_VERSION)
      void this.rescan()
    }
    return this.listVolumes()
  }

  /** A small entry point for opening a transaction on the same DB as IndexStore. */
  private transaction(fn: () => void): void {
    this.index.transaction(fn)
  }

  /**
   * Queues one flush of the watch. It runs after the previous application finishes (preserving order).
   * The return value resolves when **this batch has been applied** (for tests and observation; the watch does not wait).
   */
  enqueueChanges(changes: readonly RawChange[]): Promise<void> {
    if (this.stopped || changes.length === 0) return this.changesTask
    const task = this.changesTask.then(() => this.applyChanges(changes))
    this.changesTask = task.catch((err: unknown) => {
      log.warn('fs.watch.apply.failed', { changes: changes.length, ...errorFields(err) })
    })
    return this.changesTask
  }

  /**
   * Queues diffs that arrived from the watch during shutdown (the remainder of the batch when it was stopped, TODO 889). Unlike `enqueueChanges`, it does not
   * refuse on `stopped`, and applying does not bail out at boundaries (`applyingDrain`). After `stop()` finishes waiting for the chain (`drainClosed`) nothing is queued:
   * e.g. what a subscription stopped after `stop()` in the middle of a re-establishment delivers. What exceeds the limit (`DRAIN_LIMIT`) is dropped (the mark is not advanced,
   * so the replay at the next launch picks it up). No notification (`onFileChanges`) is sent: main is no longer listening.
   */
  private drainChanges(changes: readonly RawChange[]): void {
    if (this.drainClosed || changes.length === 0) return
    const take = changes.slice(0, Math.max(0, DRAIN_LIMIT - this.drainedCount))
    if (take.length < changes.length) {
      log.info('fs.watch.drain.dropped', { dropped: changes.length - take.length })
    }
    if (take.length === 0) return
    this.drainedCount += take.length
    const task = this.changesTask.then(() => this.applyChanges(take, true))
    this.changesTask = task.catch((err: unknown) => {
      log.warn('fs.watch.drain.failed', { changes: take.length, ...errorFields(err) })
    })
  }

  /**
   * Puts files / folders that main made from the Files tree (TODO 370) into the index without waiting for the watch (fsevents).
   * **They are queued as `create` on the same chain as watch diffs (`enqueueChanges`)**: still one writer
   * (6.2), and after applying, `onFileChanges` distributes the diff to the renderer just like the watch. Even if the watch's
   * `create` for the same path comes later, `upsertFsEntry` only rewrites the same row (no duplicate row). Things made
   * outside the home directory (outside the watch) get in through this too. URIs are checked again at the gate, and those that fail are dropped silently (main has already checked).
   * The return value resolves when applied (main waits for it before answering the renderer).
   */
  noteCreated(uris: readonly string[]): Promise<void> {
    const changes: RawChange[] = []
    for (const uri of uris) {
      try {
        const path = this.assertAllowed(uri, false)
        // Name rules (`node_modules` etc.) apply only to the last component, so the parent also goes through the gate
        // (nothing inside an excluded folder is added. Main's `createEntry` also checks every intermediate component).
        this.assertAllowed(pathToUri(dirname(path)), true)
        changes.push({ type: 'create', path })
      } catch {
        // A URI refused by the gate is not put into the index.
      }
    }
    return this.enqueueChanges(changes)
  }

  /**
   * Applies diffs to the index (item 87).
   *
   * **It does not write everything in one transaction.** It used to
   * process one flush in one transaction and call `removeSubtree` (recursive CTE + deleting FTS rows) for each `delete`.
   * When an `rm -rf` of 100,000 files under the home directory came in, the "count equals stall time" that `removeStale` avoided
   * reappeared inside the index process, and all listing / search RPCs in the meantime were made to wait.
   *
   * - Keeping arrival order, it splits into stretches of **consecutive deletes** and **consecutive creates / updates**
   *   (the same path has been folded into the last one by `ChangeBatcher`, so keeping the order of stretches is enough).
   * - create / update are split into transactions of `CHANGE_BATCH` each, yielding in between.
   * - delete collects row ids (yielding every `CHANGE_BATCH`) and removes them with their descendants through
   *   `IndexStore.deleteDocuments`. The two-stage approach of dropping all FTS rows first and the
   *   `STALE_BATCH` splitting are owned by that side.
   * - At each boundary it looks at `stopped` (shutdown) and leaves. It does **not** look at `stopRequested`:
   *   that is the interruption of a single scan (a scheduled scan stops when the user's operation resumes), and looking at it here would
   *   keep deletes and creates of that moment out of the index until the next scan.
   *
   * Nothing breaks if it leaves midway: leftover rows merely disagree with the real files, and the next scan's
   * cleanup (`removeStale` / `removeMissingChildren`) picks them up. The notification is sent once, after everything is done.
   */
  private async applyChanges(changes: readonly RawChange[], drain = false): Promise<void> {
    if (this.stopped && !drain) return
    const now = Date.now()
    const out: FileChange[] = []

    this.applyingDrain = drain
    try {
      let i = 0
      while (i < changes.length) {
        if (this.stopped && !drain) return
        const deleting = changes[i]?.type === 'delete'
        let end = i
        while (end < changes.length && (changes[end]?.type === 'delete') === deleting) end += 1
        const run = changes.slice(i, end)
        if (deleting) await this.applyDeletes(run, out)
        else await this.applyUpserts(run, now, out)
        i = end
      }
    } catch (err) {
      if (err instanceof ChangesAborted) return
      throw err
    } finally {
      this.applyingDrain = false
    }

    if (out.length > 0 && !this.stopped) {
      this.events.onFileChanges({ changes: out, at: now })
      // For changed files, index_state has been set back to pending (the incremental update of 6.4).
      this.events.onIndexable?.()
    }
  }

  /** A batch boundary. Yields to the event loop, and leaves if shutdown has arrived. */
  private async yieldOrAbort(): Promise<void> {
    await yieldToEventLoop()
    if (this.stopped && !this.applyingDrain) throw new ChangesAborted()
  }

  private async applyDeletes(changes: readonly RawChange[], out: FileChange[]): Promise<void> {
    // Collect together with descendants. If a parent came first, its children are already collected, so the CTE is not run again
    // (an `rm -rf` lines up many deletes inside the same tree).
    const ids = new Set<number>()
    for (let k = 0; k < changes.length; k += 1) {
      if (k > 0 && k % CHANGE_BATCH === 0) await this.yieldOrAbort()
      const change = changes[k] as RawChange
      this.deletedDuringScan?.add(change.path)
      const id = this.index.findByPath(change.path)
      if (id !== null && !ids.has(id)) {
        for (const sub of this.index.subtreeIds(id)) ids.add(sub)
      }
      out.push({
        type: 'delete',
        uri: pathToUri(change.path),
        parentUri: pathToUri(dirname(change.path)),
        entry: null
      })
    }
    if (ids.size === 0) return
    await this.index.deleteDocuments([...ids], () => this.yieldOrAbort())
  }

  private async applyUpserts(
    changes: readonly RawChange[],
    now: number,
    out: FileChange[]
  ): Promise<void> {
    // Of the things that must not become rows (a file symlink, etc., TODO 849), those that already have a row.
    // A regular file that was later swapped for a symlink; it is dropped together with its descendants, like a delete.
    const drops: RawChange[] = []
    for (let k = 0; k < changes.length; k += CHANGE_BATCH) {
      if (k > 0) await this.yieldOrAbort()
      const batch = changes.slice(k, k + CHANGE_BATCH)
      this.transaction(() => {
        for (const change of batch) {
          if (this.applyUpsert(change, now, out) === 'drop' && this.index.findByPath(change.path) !== null) {
            drops.push({ type: 'delete', path: change.path })
          }
        }
      })
    }
    if (drops.length > 0) await this.applyDeletes(drops, out)
    // Yield between this stretch and the next one (or the next flush) too.
    await this.yieldOrAbort()
  }

  /**
   * Applies one create / update. `'drop'` means "do not make it a row" (a file symlink, a directory symlink whose real target is inside an excluded area,
   * or something that is neither a regular file nor a directory, TODO 849); if a row already exists, the caller removes it.
   */
  private applyUpsert(change: RawChange, now: number, out: FileChange[]): 'drop' | undefined {
    const stats = this.statSyncSafe(change.path)
    if (stats === null) return undefined
    if (stats === 'drop') return 'drop'
    const name = basename(change.path)
    if (classify(change.path, name, stats.isDirectory, this.rules).excluded) return undefined

    const parentId = this.index.ensureDirectory(dirname(change.path), now)
    const row = this.index.upsertFsEntry({
      parentId,
      name,
      isDirectory: stats.isDirectory,
      ext: stats.isDirectory ? '' : extensionOf(name),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      seenAt: now,
      dataless: stats.dataless
    })
    if (stats.isDirectory) this.index.rememberDirectory(change.path, row.id)
    out.push({
      type: change.type,
      uri: pathToUri(change.path),
      parentUri: pathToUri(dirname(change.path)),
      entry: {
        uri: pathToUri(change.path),
        parentUri: pathToUri(dirname(change.path)),
        name,
        isDirectory: stats.isDirectory,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ext: stats.isDirectory ? '' : extensionOf(name)
      }
    })
    return undefined
  }

  /**
   * Looks at one watch diff with `lstat` (TODO 849). **Handled the same as the scan (`walk` in `scanner.ts`)**:
   * a file symlink is not followed and does not become a row (`'drop'`). Only for a directory symlink is the real target examined,
   * and the exclusion rules are applied again to the real path (`'drop'` if it points at `~/.ssh`, etc.). Anything that is neither a regular file
   * nor a directory (FIFO, socket, etc.) does not become a row either, as in the scan.
   * It used to use `statSync` (which follows symlinks) and applied exclusion only to the logical path, so a
   * `notes.md -> ~/.ssh/config` created after a scan went in as a row of a regular file with the target's size, and its body entered the index.
   * null if it is gone.
   */
  private statSyncSafe(
    path: string
  ): { isDirectory: boolean; size: number; mtimeMs: number; dataless: boolean } | 'drop' | null {
    try {
      // Applying watch diffs can be synchronous (it yields every `CHANGE_BATCH` entries: item 87).
      let stats = lstatSync(path)
      if (stats.isSymbolicLink()) {
        let resolved: string
        try {
          resolved = realpathSync(path)
          stats = statSync(resolved)
        } catch {
          // A symlink with no target. It does not become a row (it is removed if present).
          return 'drop'
        }
        if (!stats.isDirectory()) return 'drop'
        if (classify(resolved, basename(resolved), true, this.rules).excluded) return 'drop'
      } else if (!stats.isDirectory() && !stats.isFile()) {
        return 'drop'
      }
      return {
        isDirectory: stats.isDirectory(),
        size: stats.isDirectory() ? 0 : stats.size,
        mtimeMs: stats.mtimeMs,
        // iCloud not downloaded (TODO 921). Once downloaded the version changes and the body is re-taken.
        dataless: isDataless(stats)
      }
    } catch {
      return null
    }
  }

  private toEntry(row: ChildRow, parentPath: string): FileEntry {
    const full = childPath(parentPath, row.name)
    return {
      uri: pathToUri(full),
      parentUri: pathToUri(parentPath),
      name: row.name,
      isDirectory: row.kind === 'directory',
      size: row.size,
      mtimeMs: row.mtime_ms,
      ext: row.ext
    }
  }

  /**
   * Returns the direct children of a directory. If the index has rows, those (`live: false`); otherwise it reads on the spot.
   *
   * **The index rows are also checked against the disk (TODO 262).** The index keeps rows for deletions the watch missed
   * (FSEvents losses, deletions while the app was down, scan / watch mismatches)
   * until the next cleanup. The tree used to show those rows as they were, so folders that no longer exist were listed.
   * It reads only the names one level down in the listing (names only from `opendir`, no `lstat`), drops the rows that do not exist,
   * and asks the index to delete them (queued on the same chain as watch diffs, `enqueueChanges`: one writer).
   * If it could not read (TCC denial, etc.) it returns the rows as they are (nothing is deleted just because a permission was revoked:
   * the same safe side as `sweepChangedDirs`). If every row vanishes, it falls to the path that reads on the spot.
   */
  async listDirectory(uri: string, options: ListDirectoryOptions = {}): Promise<DirectoryListing> {
    // A listing is a read (TODO 520): even inside a view-only exception (the trash) it can be listed. It is not in the index, so it
    // falls to the "read on the spot" path below, and children are filtered with the same `'read'`.
    const path = this.assertAllowed(uri, true, 'read')
    // Opening (something inside) a protected folder = the user touched it explicitly. End the deferral (TODO 805). Opening itself is allowed during the deferral.
    if (this.tccDeferred()) void this.releaseTccDeferral('opened', path)
    // Hide names starting with "." (TODO 261). **Display only**: what is indexed, searched and scanned does not change.
    // Filter before `MAX_ROWS` cuts (before the counting in SQL / when reading on the spot).
    const hide = options.showHidden === false
    // Directly under `~/Downloads` (TODO 627) files are shown newest first regardless of the user's sort order, so the retrieval and the
    // `MAX_ROWS` cut are also aligned to `modified` (code-review of wave 44: cutting by name and then re-sorting dropped the
    // newest files in an overflowing folder). The final re-sort is `orderEntries` (all three return paths).
    const sortOrder = this.isDownloadsRoot(path) ? 'modified' : (options.sortOrder ?? 'name')
    const keep = hide ? keptHiddenNames(path, options.keep) : NO_NAMES
    const id = this.index.findByPath(path)
    if (id !== null) {
      const rows = this.withKept(id, this.index.children(id, MAX_ROWS, hide, sortOrder), keep, sortOrder)
      if (rows.length > 0) {
        const present = await this.presentNames(path)
        if (present === 'missing') {
          // The directory asked to be listed itself is gone. Have it removed along with its own row.
          this.requestRemoval([path])
          return { uri, entries: [], live: true, reason: null }
        }
        const kept: ChildRow[] = []
        const gone: string[] = []
        for (const row of rows) {
          if (present === null || present.names.has(foldPath(row.name))) kept.push(row)
          else gone.push(childPath(path, row.name))
        }
        if (gone.length > 0) {
          log.info('fs.list.stale', { path, stale: gone.length })
          this.requestRemoval(gone)
        }
        if (kept.length > 0) {
          const entries = kept.map((row) => this.toEntry(row, path))
          const withLinks =
            present === null || present.links.length === 0
              ? entries
              : await this.withSymlinks(path, entries, present.links, hide ? keep : null, sortOrder)
          // TODO 558: add the symlinked files that do not go into the index, and mark the rows of symlinks.
          return { uri, entries: this.orderEntries(path, withLinks), live: false, reason: null }
        }
      }
    }

    // A directory the scan has not reached yet is read on the spot,
    // so that the sidebar is not empty even right after the first launch.
    const entries = await this.readDirectoryLive(path, hide ? keep : null, sortOrder)
    return { uri, entries: this.orderEntries(path, entries), live: true, reason: null }
  }

  /**
   * Whether it is directly under `~/Downloads` (TODO 627). Compared with folding (NFC + lowercase, `foldPath`), so
   * differences in case or NFD do not miss it. Subfolders and other folders do not match.
   */
  private isDownloadsRoot(path: string): boolean {
    return foldPath(path) === foldPath(childPath(this.home, 'Downloads'))
  }

  /** Only directly under `~/Downloads` goes through `sortDownloadsEntries`. Other orderings are unchanged (TODO 627). */
  private orderEntries(path: string, entries: readonly FileEntry[]): readonly FileEntry[] {
    return this.isDownloadsRoot(path) ? sortDownloadsEntries(entries) : entries
  }

  /**
   * Adds to a hidden listing the rows starting with "." that are kept as a path (TODO 261). The order is the same as SQL
   * (directories first, then byte order of the folded name).
   */
  private withKept(
    parentId: number,
    rows: readonly ChildRow[],
    keep: ReadonlySet<string>,
    sortOrder: FileSortOrder = 'name'
  ): readonly ChildRow[] {
    if (keep.size === 0) return rows
    const extra: ChildRow[] = []
    for (const name of keep) {
      const row = this.index.childRow(parentId, name)
      if (row !== null) extra.push(row)
    }
    if (extra.length === 0) return rows
    return sortForList(
      [...rows, ...extra].map((row) => ({ row, isDirectory: row.kind === 'directory', mtimeMs: row.mtime_ms, name: row.name })),
      sortOrder
    ).map((entry) => entry.row)
  }

  /**
   * The names that exist right now directly under it (folded). `'missing'` if the directory does not exist,
   * and null if it cannot be read (the caller trusts the index rows).
   */
  private async presentNames(
    path: string
  ): Promise<{ readonly names: ReadonlySet<string>; readonly links: readonly string[] } | 'missing' | null> {
    try {
      const names = new Set<string>()
      // Names of symlinks (TODO 558). The scan does not put file symlinks into the index, so the listing adds them.
      const links: string[] = []
      const handle = await opendir(path)
      for await (const dirent of handle) {
        names.add(foldPath(dirent.name))
        if (dirent.isSymbolicLink()) links.push(dirent.name)
      }
      return { names, links }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
      return null
    }
  }

  /**
   * Has the rows of paths known not to exist removed (TODO 262). They are queued on the same chain as watch deletes, so the
   * order does not get mixed up with the scan's and the watch's writes. The delete diff reaches the renderer too.
   */
  private requestRemoval(paths: readonly string[]): void {
    if (paths.length === 0 || this.stopped) return
    void this.enqueueChanges(paths.map((path) => ({ type: 'delete', path })))
  }

  /**
   * One symlink row (TODO 558). **The real target goes through the gate (`resolvePath`, read)**, and one that points at an excluded area, a dangling one, or
   * one that is neither a regular file nor a directory is null (not shown). Size, mtime and kind are the target's.
   * The scan (`walk`) does not put file symlinks into the index (to avoid double counting), so the listing adds them here.
   */
  private async symlinkEntry(parent: string, name: string): Promise<FileEntry | null> {
    const full = resolve(parent, name)
    let canonical: string
    let isDirectory: boolean
    try {
      const resolved = resolvePath(full, { rules: this.rules }, false, 'read')
      if (!resolved.exists) return null
      canonical = resolved.canonical
      isDirectory = resolved.isDirectory
    } catch {
      return null
    }
    // Name rules (generated directory names, etc.) are applied again once the kind is known.
    if (classifyAccess(full, name, isDirectory, this.rules, 'read').excluded) return null
    const stats = await stat(canonical).catch(() => null)
    if (stats === null || (!stats.isFile() && !stats.isDirectory())) return null
    return {
      uri: pathToUri(full),
      parentUri: pathToUri(parent),
      name,
      isDirectory,
      size: isDirectory ? 0 : stats.size,
      mtimeMs: stats.mtimeMs,
      ext: isDirectory ? '' : extensionOf(name),
      symlink: true
    }
  }

  /**
   * Adds symlinks to the list of index rows (TODO 558). For a name that already has a row (the scan puts a directory symlink in
   * as a directory) only the marker is set; a name that has none (a file symlink) is added with `symlinkEntry`.
   * The order is the same as SQL (directories first, then byte order of the folded name).
   */
  private async withSymlinks(
    parent: string,
    entries: readonly FileEntry[],
    links: readonly string[],
    hiddenKeep: ReadonlySet<string> | null,
    sortOrder: FileSortOrder = 'name'
  ): Promise<readonly FileEntry[]> {
    const linkNames = new Set(links.map(foldPath))
    const out = entries.map((entry) =>
      linkNames.has(foldPath(entry.name)) ? { ...entry, symlink: true as const } : entry
    )
    const listed = new Set(entries.map((entry) => foldPath(entry.name)))
    for (const name of links) {
      if (listed.has(foldPath(name))) continue
      if (hiddenKeep !== null && name.startsWith('.') && !hiddenKeep.has(foldPath(name))) continue
      if (out.length >= MAX_ROWS) break
      const entry = await this.symlinkEntry(parent, name)
      if (entry !== null) out.push(entry)
    }
    return sortForList(out, sortOrder)
  }

  /** If `hiddenKeep` is not null, hides names starting with "." and keeps only the names in it (folded) (TODO 261). */
  private async readDirectoryLive(
    path: string,
    hiddenKeep: ReadonlySet<string> | null = null,
    sortOrder: FileSortOrder = 'name'
  ): Promise<readonly FileEntry[]> {
    // TODO 872 (code-review): cutting in readdir order drops the newest files under `modified`. Collect everything as candidates,
    // sort, and then cut with `MAX_ROWS`. The `name` order does not use mtime, so only on overflow is it cut by name first to reduce lstat calls.
    const symlinks: FileEntry[] = []
    const candidates: { readonly name: string; readonly isDirectory: boolean; readonly full: string }[] = []
    try {
      const handle = await opendir(path)
      for await (const dirent of handle) {
        if (
          hiddenKeep !== null &&
          dirent.name.startsWith('.') &&
          !hiddenKeep.has(foldPath(dirent.name))
        ) {
          continue
        }
        // A symlink (TODO 558) goes through the gate for its real target and is then shown with the target's kind and size.
        if (dirent.isSymbolicLink()) {
          const entry = await this.symlinkEntry(path, dirent.name)
          if (entry !== null) symlinks.push(entry)
          continue
        }
        const full = resolve(path, dirent.name)
        const isDirectory = dirent.isDirectory()
        // Read judgment (TODO 520): children of a view-only exception (the trash) are shown. Otherwise the same as `classify`.
        if (classifyAccess(full, dirent.name, isDirectory, this.rules, 'read').excluded) continue
        candidates.push({ name: dirent.name, isDirectory, full })
      }
    } catch (err) {
      // A TCC denial also comes here. It returns an empty listing and the scan side's tally explains it.
      log.warn('fs.list.denied', { path, ...errorFields(err) })
    }
    let picked = candidates
    if (sortOrder === 'name' && candidates.length + symlinks.length > MAX_ROWS) {
      // The name order does not read mtime, so it sorts as is without making a copy (code-review of wave 44).
      picked = sortForList(candidates, 'name').slice(0, MAX_ROWS)
    }
    const collected: FileEntry[] = [...symlinks]
    const parentUri = pathToUri(path)
    for (let i = 0; i < picked.length; i += 64) {
      const batch = picked.slice(i, i + 64)
      const stats = await Promise.all(batch.map((c) => lstat(c.full).catch(() => null)))
      batch.forEach((c, j) => {
        const st = stats[j]
        if (st === null || st === undefined) return
        collected.push({
          uri: pathToUri(c.full),
          parentUri,
          name: c.name,
          isDirectory: c.isDirectory,
          size: c.isDirectory ? 0 : st.size,
          mtimeMs: st.mtimeMs,
          ext: c.isDirectory ? '' : extensionOf(c.name)
        })
      })
    }
    // Sort only once, and fold each name only once (TODO 875). A folder that overflows under `modified` takes lstat of
    // every entry (64 at a time in parallel, about +130 ms for 100,000 entries; it is asynchronous, so it does not hold the JS thread).
    const sorted = sortForList(collected, sortOrder)
    return sorted.length > MAX_ROWS ? sorted.slice(0, MAX_ROWS) : sorted
  }

  /**
   * File-name search (full-text search is on the IndexService side. Separate from the two windows of 6.1).
   *
   * The matching rules are 6.6 (qlm style). **It always returns the top N + the total hit count + truncation**:
   * nothing is dropped silently. The scan returns to the event loop after each page, so
   * when typing advances, an old query stops by itself via a mismatch in `searchSeq`.
   */
  async searchFiles(
    query: string,
    limit: number = DEFAULT_SEARCH_LIMIT,
    cwdUri: string | null = null,
    scopeUri: string | null = null,
    /**
     * `'link'` (code-review of TODO 816): re-looking up a link in an answer (main's `fs.resolveLink`). It does not advance the user's search generation
     * (`searchSeq`) and is not cut off by it (it stops only during shutdown). Even when keystrokes in ⌘P / the Sidebar overlap with a link
     * click, neither makes the other `cancelled`.
     */
    lane: 'user' | 'link' = 'user'
  ): Promise<FileSearchResult> {
    const max = Math.min(Math.max(1, Math.trunc(limit)), MAX_ROWS)
    if (this.stopped) return EMPTY_SEARCH
    // The scope (TODO 437) is also a URI that came over RPC, so it is checked again. **If refused, 0 results**: unlike the cwd, the scope is
    // a filter the user specified explicitly, so dropping it and returning the whole index would make the badge and the results disagree.
    const scopePath = scopeUri === null ? null : this.indexedPathOf(scopeUri)
    if (scopeUri !== null && scopePath === null) return EMPTY_SEARCH
    let shouldStop: () => boolean
    if (lane === 'link') {
      shouldStop = () => this.stopped
    } else {
      const seq = this.searchSeq + 1
      this.searchSeq = seq
      shouldStop = () => this.searchSeq !== seq || this.stopped
    }
    // The cwd (item 100) is also a URI that came over RPC, so it is not trusted. One that hits an exclusion or a broken URI falls back to
    // "no cwd": the search itself does not stop. It is not used when there is a scope.
    const cwdPath = cwdUri === null || scopePath !== null ? null : this.indexedPathOf(cwdUri)
    const outcome = await this.nameSearch.search(query, max, shouldStop, cwdPath, scopePath)
    if (outcome.cancelled || this.stopped) {
      return { ...EMPTY_SEARCH, cancelled: true, tookMs: outcome.tookMs }
    }
    return {
      entries: this.entriesOf(outcome.ids),
      total: outcome.total,
      truncated: outcome.truncated,
      scanTruncated: outcome.scanTruncated,
      cwd:
        outcome.cwd === null || cwdUri === null
          ? null
          : {
              uri: cwdUri,
              entries: this.entriesOf(outcome.cwd.ids),
              total: outcome.cwd.total,
              truncated: outcome.cwd.truncated,
              scanTruncated: outcome.cwd.scanTruncated
            },
      ...(outcome.caseSensitive ? { caseSensitive: true } : {}),
      cancelled: false,
      tookMs: outcome.tookMs
    }
  }

  /**
   * Candidates for "recent files" (TODO 999, `recent.ts`). If `parentUri` is given, only directly under that folder (the badge of new
   * screenshots). The folder's URI is a value that came over RPC, so it goes through the gate again (`indexedPathOf`); 0 results if refused.
   * 0 results during shutdown too.
   */
  recentFiles(sinceMs: number, limit: number, parentUri: string | null = null): RecentCandidate[] {
    if (this.stopped) return []
    let parentId: number | null = null
    if (parentUri !== null) {
      const parentPath = this.indexedPathOf(parentUri)
      if (parentPath === null) return []
      parentId = this.index.findByPath(parentPath)
      if (parentId === null) return []
    }
    return collectRecent(
      {
        page: (since, beforeMtime, beforeId, pageLimit) => this.index.recentFsFiles(since, beforeMtime, beforeId, pageLimit),
        pathOf: (id) => this.index.pathOf(id),
        isExcluded: (path, name, isDirectory) => classify(path, name, isDirectory, this.rules).excluded
      },
      { sinceMs, now: Date.now(), limit: Math.max(1, Math.trunc(limit)), parentId }
    )
  }

  /** Only the top N are turned back into paths (what reaches the renderer is the URI and the name). */
  private entriesOf(ids: readonly number[]): FileEntry[] {
    const entries: FileEntry[] = []
    for (const row of this.index.entriesByIds(ids)) {
      const parentPath = row.parent_id === null ? null : this.index.pathOf(row.parent_id)
      if (parentPath === null) continue
      // The document id (TODO 1158): returned in a form the gateway's `searchFiles` can pass to `getDocument`.
      entries.push({ ...this.toEntry(row, parentPath), documentId: row.id })
    }
    return entries
  }

  /**
   * URI -> absolute path of the working folder used as the base of a search (item 100). **The gate is the same as `assertAllowed`**,
   * and null if it does not pass (it only omits the cwd section; the search continues).
   * The cwd of full-text search (`IndexService.search`) is also passed through here before being handed over.
   */
  cwdPathOf(uri: string): string | null {
    try {
      return this.assertAllowed(uri, true)
    } catch {
      return null
    }
  }

  /**
   * The path of the cwd / scope used to look up the index (wave 49 review, the remainder of TODO 924). Turns the logical path of `cwdPathOf` into the real one.
   * There are no index rows below a directory symlink (the full scan does not descend, and the subtree scan walks the real target), so if the working folder or
   * the scope is (under) a symlink, the subtree is looked up by the real path. If the real path cannot be resolved, the logical path is kept.
   */
  indexedPathOf(uri: string): string | null {
    const path = this.cwdPathOf(uri)
    if (path === null) return null
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }

  /**
   * The only gate that validates a URI that came from the renderer (12.3).
   *
   * **In Phase 3 the premise "scan root = home directory" was dropped** (the index became the whole PC), so
   * the judgment became "is an absolute path" and "does not hit the exclusion list".
   *
   * **In Phase 4 the implementation moved to `capability/fs-policy.ts`** (the homework of 12.4 / 12.8).
   * The criteria are unchanged, but a re-check of the canonical path (realpath) was added:
   * a symlink placed inside the allowed range that points outside it is refused.
   * It shares **one implementation** with CapabilityBroker.fs,
   * so the app itself and plugins never disagree in their decisions.
   *
   * The return value is the **logical path** (not canonical): listings and the tree
   * must be displayed with the path the user followed.
   *
   * **Since P1, the first to receive a URI from the renderer is main's `FsAccess`**,
   * and this is the re-check on the index process side (a URI that came over RPC is not trusted either). The decision shares the same
   * one implementation in `common/fs-policy.ts`, so they never disagree.
   */
  private assertAllowed(uri: string, asDirectory: boolean, access: PathAccess = 'write'): string {
    const path = pathFromUri(uri)
    resolvePath(path, { rules: this.rules }, asDirectory, access)
    return path
  }
}

/** Builds a child's absolute path from the parent path and a name (directly under `/` it does not become `//`). */
function childPath(parentPath: string, name: string): string {
  return parentPath === '/' ? `/${name}` : `${parentPath}/${name}`
}

const NO_NAMES: ReadonlySet<string> = new Set()

/** The shape the listing order needs (the name order does not read mtime). */
interface ListNameKey {
  readonly isDirectory: boolean
  readonly name: string
}
interface ListKey extends ListNameKey {
  readonly mtimeMs: number
}

/**
 * The listing order rule itself (TODO 872, **this one place**; the code-review of wave 44 folded the copies of `listComparator` and `sortForList`).
 * It applies the same rule as SQL (`IndexStore.children`) to rows that do not go through the index (symlinks, read on the spot, the hidden
 * rows kept as a path): directories first and then byte order of the folded name (`key`); for `modified`, only files by newest modified time first
 * (the same time by name). The special case directly under `~/Downloads` (TODO 627) is applied afterwards by `sortDownloadsEntries`.
 */
function compareListKeys(
  a: { readonly isDirectory: boolean; readonly mtimeMs: number; readonly key: string },
  b: { readonly isDirectory: boolean; readonly mtimeMs: number; readonly key: string },
  modified: boolean
): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  if (modified && !a.isDirectory && a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** The shape of the comparison function of `compareListKeys` (it folds on every comparison; for large sorts use `sortForList`). */
export function listComparator(sortOrder: FileSortOrder): (a: ListKey, b: ListKey) => number {
  const modified = sortOrder === 'modified'
  return (a, b) =>
    compareListKeys(
      { isDirectory: a.isDirectory, mtimeMs: a.mtimeMs, key: foldPath(a.name) },
      { isDirectory: b.isDirectory, mtimeMs: b.mtimeMs, key: foldPath(b.name) },
      modified
    )
}

/**
 * A new array with `items` sorted in the order of `compareListKeys` (TODO 875). It builds the folded name just once per item:
 * calling `foldPath` (NFC + lowercase) on every comparison made sorting alone a list of 100,000 entries read on the spot
 * hold the index process's JS thread for 160 ms (`scripts/bench/tree-children.mts`). For the name order, a shape without mtime can be passed too.
 */
export function sortForList<T extends ListNameKey>(items: readonly T[], sortOrder: 'name'): T[]
export function sortForList<T extends ListKey>(items: readonly T[], sortOrder: FileSortOrder): T[]
export function sortForList<T extends ListNameKey & { readonly mtimeMs?: number }>(
  items: readonly T[],
  sortOrder: FileSortOrder
): T[] {
  const modified = sortOrder === 'modified'
  const keyed = items.map((item) => ({
    item,
    key: { isDirectory: item.isDirectory, mtimeMs: item.mtimeMs ?? 0, key: foldPath(item.name) }
  }))
  keyed.sort((a, b) => compareListKeys(a.key, b.key, modified))
  return keyed.map((entry) => entry.item)
}

/**
 * The order only directly under `~/Downloads` (TODO 627, owner request): files first, by
 * newest modified time (mtime). Folders go after, and the order among folders stays as passed (other orderings are unchanged).
 * Not applied to anything other than `~/Downloads`, nor to subfolders (the caller checks "is it directly under" and passes only the rows to apply it to).
 */
export function sortDownloadsEntries<T extends { readonly isDirectory: boolean; readonly mtimeMs: number }>(
  entries: readonly T[]
): readonly T[] {
  const files = entries.filter((entry) => !entry.isDirectory).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const dirs = entries.filter((entry) => entry.isDirectory)
  return [...files, ...dirs]
}

/**
 * The names directly under `dir` that start with "." and are kept in the listing even when hidden (folded, TODO 261). If a URI in `keep` is
 * under `dir`, the name of its ancestor directly under `dir` (or itself). Even if the working folder
 * (`~/.aios-v17/real`) or a file opened in the viewer is inside a hidden folder, the path to it
 * is not erased. A broken URI is dropped silently (it is only a display hint).
 */
export function keptHiddenNames(dir: string, keep: readonly string[] | undefined): ReadonlySet<string> {
  if (keep === undefined || keep.length === 0) return NO_NAMES
  const prefix = dir === '/' ? '/' : `${dir}/`
  const names = new Set<string>()
  for (const uri of keep) {
    let path: string
    try {
      path = pathFromUri(uri)
    } catch {
      continue
    }
    if (!foldPath(path).startsWith(foldPath(prefix))) continue
    const first = path.slice(prefix.length).split('/')[0] ?? ''
    if (first.startsWith('.') && first !== '.' && first !== '..') names.add(foldPath(first))
  }
  return names
}
