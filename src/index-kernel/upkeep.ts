/**
 * Idle cleanup of the index process (jobs that need to run only once).
 *
 * - **TODO 945**: deletes accumulated orphan FTS rows (rowids in `chunk_fts` but not in `chunks`). These are what the
 *   scoped cleanup before 923 left behind for grandchildren and below. If a rowid is reused, the terms of a deleted file match another document.
 * - **TODO 946**: retroactively sets the `lossy` mark on non-UTF-8 files (Shift_JIS etc.) indexed before 925. 925's mark was set
 *   only when a row was rebuilt, and the version (`mtime:size`) does not change, so snippets stayed misaligned until
 *   the file changed. Neither by raising `RULES_VERSION` (everyone does a full scan) nor by rebuilding rows with no mark (word segmentation is heavy),
 *   but by reading the first 256 KB, checking the round trip, and writing only the mark. The body is not kept (constraint 9).
 * - **TODO 965**: rebuilds the FTS that may have earlier terms mixed in because of rowid reuse (before migration 30, `chunks.id` was "max + 1").
 *   The mixed rows do not look like orphans and cannot be told apart, so documents that have chunks with ids at or below the high-water mark as of migration 30
 *   (`chunk_id_seq.rebuild_below`) are put back to `pending` a little at a time. Re-reading the canonical copy and
 *   word segmentation are done by the normal build (`runBuild`), and `replaceChunks` re-inserts them with new ids. The old terms cannot be removed from FTS
 *   (a contentless_delete DELETE works only on the last version), but no chunk holds the old rowid and it is never handed out again,
 *   so search (the JOIN with `chunks`) does not match them. Documents of sources the build cannot read the canonical copy of (no transcript or plugin reader in this launch) are
 *   skipped rather than put back, and if any were skipped it is not marked done (progress is reset to 0, and at the next launch, if the readers are present, it continues.
 *   The chunks of rebuilt documents are above `rebuild_below`, so the next round has only the skipped documents as candidates). If it finishes looking without
 *   skipping a single fs document, all indexed fs documents have been re-indexed with this version (after 925), so 946's
 *   retroactive pass is also marked done.
 *
 * - **TODO 1152**: when the way the shadow text is made (`SHADOW_EPOCH` in `tokenize.ts`, which appends the split form of camelCase identifiers) changes,
 *   it makes 965's rebuild entry point run one more round (`applyShadowEpoch`). When the index process opens (before the build writes new chunks) it just
 *   raises `rebuild_below` to the current high-water mark and resets progress to 0; how candidates are chosen, put back and yielded is as in 965.
 *
 * - **TODO 997**: re-attaches the extraction-version mark (`:oxN`) to the version of files whose extracted text is indexed (Office) and puts them back to
 *   `pending`. Rows that became `skipped` by extension before 997 do not change version (`mtime:size`), so the incremental scan does not pick them up, and they do not show in search until the next full scan
 *   (default 7 days). When the extraction version is raised, the same entry point re-indexes them (progress is per version).
 *   **TODO 1089**: through the same entry point, `skipped` rows of text kinds added later to the extension table (`LATE_TEXT_EXTENSIONS`, assembler, etc.) are put back to
 *   `pending` (there is no version mark, so the version is not changed. A full scan does not re-fetch them if the version is the same).
 *
 * What to keep in mind:
 * - **Do not make it a migration** (migrations run in main — constraint 8.1). The index process's `IndexService` calls it one step at a time from the
 *   per-second idle tick (`onTick`, `pace === 'full'`) with no remaining work.
 * - **Writes go through the sole writer's column (`IndexService.enqueue`)** (6.2). One step is cut by a time budget (`UPKEEP_BUDGET_MS`) so that
 *   the column is not held long (RPCs such as search are also answered on the same process's JS thread).
 * - Progress is kept in an `app_settings` key (`settings-keys.ts`, owner `index`). A restart continues from where it left off, and once finished `UPKEEP_DONE`
 *   means it never runs again.
 * - After shutdown (`shouldYield` is true), do not touch the DB. `IndexService.stop()` waits for the running step before returning.
 */
import { join } from 'node:path'
import { log } from '../common/logger.js'
import type { AppSettingsStore } from '../common/settings.js'
import {
  INDEX_DERIVED_REQUEUE_CURSOR,
  INDEX_DERIVED_REQUEUE_VERSION,
  INDEX_FTS_ORPHAN_CURSOR,
  INDEX_FTS_REBUILD_CURSOR,
  INDEX_LOSSY_BACKFILL_CURSOR,
  INDEX_SHADOW_EPOCH
} from '../common/settings-keys.js'
import { derivedEpoch, LATE_TEXT_EXTENSIONS, probeLossy } from './extract.js'
import { SHADOW_EPOCH } from './tokenize.js'
import { retagFsVersion, type IndexStore } from './store.js'

const LATE_TEXT: ReadonlySet<string> = new Set(LATE_TEXT_EXTENSIONS)

/** The "done" value placed in the progress key. */
export const UPKEEP_DONE = -1
/** Time budget (ms) of one step. The same order of magnitude as the merge budget (`MERGE_BUDGET_MS`). */
export const UPKEEP_BUDGET_MS = 50
/** Number of rowids in one batch when looking for orphan FTS rows (TODO 945). The budget is checked at batch boundaries. */
export const FTS_SWEEP_BATCH = 300
/**
 * Cap on orphan FTS rows deleted per step (TODO 945). **A time budget alone cannot bound COMMIT**: deleted rows become FTS5
 * tombstones, and when a segment's tombstones exceed `deletemerge` (default 10%), the automerge inside COMMIT
 * rewrites that segment. Measured (1.5 million rows, encrypted, `crisismerge` 256): deleting 2,000-3,000 per step makes COMMIT take
 * 100-800 ms, while up to 200 keeps most steps around 50 ms (of 2,892 steps, 123 exceeded 80 ms, worst 429 ms).
 */
export const FTS_SWEEP_MAX_DELETES = 200
/** Width of the `documents.id` range fetched at a time for the `lossy` retroactive pass (TODO 946). */
export const LOSSY_ID_WINDOW = 2_000
/** Width of the `documents.id` range fetched at a time for the FTS rebuild (TODO 965). */
export const REBUILD_ID_WINDOW = 2_000
/**
 * Cap on documents put back to `pending` per step of the FTS rebuild (TODO 965). The normal build re-indexes what was put back from the next tick
 * (the cleanup is paused meanwhile). The COMMIT of one build batch (`BATCH_SIZE`) deletes old FTS rows, so as in 945
 * the `deletemerge` rewrite comes on top. Keep one step small so the build finishes in one go.
 */
export const REBUILD_MAX_DOCS = 200
/** Width of the `documents.id` range fetched at a time for re-attaching the extraction version (TODO 997). */
export const DERIVED_ID_WINDOW = 5_000
/** Cap on documents put back to `pending` per step of re-attaching the extraction version (TODO 997). The normal build indexes what was put back. */
export const DERIVED_MAX_DOCS = 200

export interface UpkeepDeps {
  readonly store: IndexStore
  readonly settings: AppSettingsStore
  /** The sole writer's column (`IndexService.enqueue`). Work queued after shutdown does not run. */
  readonly enqueue: (work: () => Promise<void> | void) => Promise<void>
  /** Whether to yield (shutdown, a build started, the user stopped it, or it is no longer idle). If true, leave without touching the DB. */
  readonly shouldYield: () => boolean
  /**
   * "May this fs canonical copy be read" used for one step only (TODO 946, whether `IndexService.fsVerdict` is `ok`).
   * Recreated at every step (so reuse of parent realpaths is limited to one step).
   */
  readonly readGate: () => (path: string) => Promise<boolean>
  /**
   * Whether documents of this source may be put back to `pending` (TODO 965). Putting back a source whose canonical copy the build cannot read (no transcript reader, etc.)
   * would make it `skipped` and lose its chunks, so only sources that can be read.
   */
  readonly rebuildable?: (source: string) => boolean
  /** Reports the number put back to `pending` (TODO 965). `IndexService` adds it to the remainder and starts the build on the next tick. */
  readonly onRequeued?: (count: number) => void
  readonly now?: () => number
  /** For tests: the number of rowids in one batch (default `FTS_SWEEP_BATCH`). */
  readonly ftsBatch?: number
}

export class IdleUpkeep {
  private readonly now: () => number
  private readonly ftsBatch: number
  /** Set once the key has been read and found done (so the DB is not read on every tick). */
  private ftsDone = false
  private ftsRemoved = 0
  private ftsStartedAt: number | null = null
  private rebuildDone = false
  /** The end of the rebuild (the max `documents` id when it started). Documents that come in later are indexed with new ids. */
  private rebuildEnd: number | null = null
  private rebuildRequeued = 0
  private rebuildStartedAt: number | null = null
  /** Sources skipped in this round and not put back because the build cannot read their canonical copy (TODO 965 review). */
  private readonly rebuildSkipped = new Set<string>()
  private lossyDone = false
  /** The end of the retroactive pass (the max `documents` id when it started). Rows that come in later get the mark through 925's path. */
  private lossyEnd: number | null = null
  private lossyChecked = 0
  private lossyMarked = 0
  private lossyStartedAt: number | null = null
  private derivedDone = false
  /** The end of re-attaching (the max `documents` id when it started). Rows that come in later are written by the scan with the current version. */
  private derivedEnd: number | null = null
  private derivedRequeued = 0

  constructor(private readonly deps: UpkeepDeps) {
    this.now = deps.now ?? Date.now
    this.ftsBatch = deps.ftsBatch ?? FTS_SWEEP_BATCH
  }

  /**
   * If the shadow text version changed, arranges for the rebuild (965) to run one more round (TODO 1152). **Call it before the build writes chunks made the new way**
   * (`IndexService`'s constructor) — the high-water mark is the value at this point, and only chunks from before it become candidates.
   * On a first launch (no chunks) the range stays 0 and there is nothing to rebuild. Only the version is written, and that is all.
   */
  applyShadowEpoch(): void {
    const { store, settings } = this.deps
    if (settings.readTyped(INDEX_SHADOW_EPOCH) === SHADOW_EPOCH) return
    let below = 0
    store.atomically(() => {
      below = store.raiseFtsRebuildBelow()
      settings.writeTyped(INDEX_FTS_REBUILD_CURSOR, 0)
      settings.writeTyped(INDEX_SHADOW_EPOCH, SHADOW_EPOCH)
    })
    log.info('index.upkeep.shadowEpoch', { epoch: SHADOW_EPOCH, below })
  }

  /** All cleanups are done (known to be done). */
  finished(): boolean {
    return this.ftsDone && this.rebuildDone && this.lossyDone && this.derivedDone
  }

  /**
   * One step (up to `budgetMs`). Does nothing if done. If the previous cleanup was found to be done just by reading its key,
   * it moves on to the next cleanup in the same step (so one tick is not wasted per launch).
   */
  async step(budgetMs: number = UPKEEP_BUDGET_MS): Promise<void> {
    const until = this.now() + budgetMs
    if (!this.ftsDone && (await this.sweepFts(until))) return
    if (!this.rebuildDone && (await this.rebuildFts(until))) return
    if (!this.lossyDone) {
      await this.backfillLossy(until)
      return
    }
    if (!this.derivedDone) await this.requeueDerived(until)
  }

  /**
   * One step of re-attaching the extraction version (TODO 997). Looks at Office file rows in ascending id order, and if the version mark differs from the current one, re-attaches it and
   * puts the row back to `pending` (1 step = 1 transaction, only writing `documents` rows and not touching FTS). The body is not read.
   */
  private async requeueDerived(until: number): Promise<void> {
    let requeued = 0
    await this.deps.enqueue(() => {
      if (this.deps.shouldYield()) return
      const { store, settings } = this.deps
      const version = settings.readTyped(INDEX_DERIVED_REQUEUE_VERSION)
      let cursor = version === derivedEpoch() ? (settings.readTyped(INDEX_DERIVED_REQUEUE_CURSOR) ?? 0) : 0
      if (cursor === UPKEEP_DONE) {
        this.derivedDone = true
        return
      }
      if (this.derivedEnd === null) {
        this.derivedEnd = store.maxDocumentId()
        log.info('index.upkeep.derived.start', { from: cursor, to: this.derivedEnd, version: derivedEpoch() })
      }
      const end = this.derivedEnd
      let done = false
      store.atomically(() => {
        for (;;) {
          if (cursor >= end) {
            done = true
            break
          }
          const window = Math.min(DERIVED_ID_WINDOW, end - cursor)
          let last = cursor + window
          for (const row of store.derivedRequeueCandidates(cursor, window)) {
            if (LATE_TEXT.has(row.ext)) {
              // Text extensions added to the table later (TODO 1089): re-fetch rows that became skipped by extension before they were added.
              if (row.index_state === 'skipped' && store.requeueSkippedFs(row.id, row.version)) requeued += 1
            } else {
              const next = retagFsVersion(row.version, row.name)
              if (next !== row.version && store.retagFsDocument(row.id, row.version, next)) requeued += 1
            }
            if (requeued >= DERIVED_MAX_DOCS) {
              last = row.id
              break
            }
          }
          cursor = last
          if (requeued >= DERIVED_MAX_DOCS || this.now() >= until) break
        }
        settings.writeTyped(INDEX_DERIVED_REQUEUE_VERSION, derivedEpoch())
        settings.writeTyped(INDEX_DERIVED_REQUEUE_CURSOR, done ? UPKEEP_DONE : cursor)
      })
      this.derivedRequeued += requeued
      if (done) {
        this.derivedDone = true
        log.info('index.upkeep.derived.done', { requeued: this.derivedRequeued })
      }
    })
    if (requeued > 0) this.deps.onRequeued?.(requeued)
  }

  /**
   * One step of cleaning orphan FTS rows (TODO 945). Looks in batches in ascending rowid order and deletes those not in `chunks`.
   * 1 step = 1 transaction (FTS5 flushes at each COMMIT, so do not COMMIT per batch).
   */
  private async sweepFts(until: number): Promise<boolean> {
    let worked = true
    await this.deps.enqueue(() => {
      if (this.deps.shouldYield()) return
      const { store, settings } = this.deps
      let cursor = settings.readTyped(INDEX_FTS_ORPHAN_CURSOR) ?? 0
      if (cursor === UPKEEP_DONE) {
        this.ftsDone = true
        worked = false
        return
      }
      if (this.ftsStartedAt === null) {
        this.ftsStartedAt = this.now()
        log.info('index.upkeep.ftsOrphans.start', { from: cursor })
      }
      let done = false
      let removed = 0
      store.atomically(() => {
        for (;;) {
          const result = store.sweepOrphanFts(cursor, this.ftsBatch)
          removed += result.removed
          if (result.last === null) {
            done = true
            break
          }
          cursor = result.last
          if (this.now() >= until || removed >= FTS_SWEEP_MAX_DELETES) break
        }
        settings.writeTyped(INDEX_FTS_ORPHAN_CURSOR, done ? UPKEEP_DONE : cursor)
      })
      this.ftsRemoved += removed
      if (done) {
        this.ftsDone = true
        // Only counts and elapsed time (what was deleted in this launch. What was deleted across restarts is not counted).
        log.info('index.upkeep.ftsOrphans.done', {
          removed: this.ftsRemoved,
          ms: this.now() - (this.ftsStartedAt ?? this.now())
        })
      }
    })
    return worked
  }

  /**
   * One step of rebuilding FTS that may be dirty (TODO 965). In ascending `documents.id` order, puts up to `REBUILD_MAX_DOCS` indexed documents
   * that have chunks with ids at or below `rebuild_below` back to `pending`. 1 step = 1 transaction
   * (only writing `documents` rows, not touching FTS). Progress is the last id put back, or the end of the range if it was fully seen.
   * A round that skipped sources it cannot read is not marked done even if it finished looking, and resets progress to 0 (it does not run again in this launch).
   */
  private async rebuildFts(until: number): Promise<boolean> {
    let requeued = 0
    let worked = true
    await this.deps.enqueue(() => {
      if (this.deps.shouldYield()) return
      const { store, settings } = this.deps
      let cursor = settings.readTyped(INDEX_FTS_REBUILD_CURSOR) ?? 0
      if (cursor === UPKEEP_DONE) {
        this.rebuildDone = true
        worked = false
        return
      }
      const below = store.ftsRebuildBelow()
      if (this.rebuildEnd === null) {
        this.rebuildEnd = below > 0 ? store.maxDocumentId() : 0
        this.rebuildStartedAt = this.now()
        log.info('index.upkeep.ftsRebuild.start', { from: cursor, to: this.rebuildEnd, below })
      }
      const end = this.rebuildEnd
      const rebuildable = this.deps.rebuildable ?? (() => true)
      let done = false
      store.atomically(() => {
        for (;;) {
          if (cursor >= end) {
            done = true
            break
          }
          const left = REBUILD_MAX_DOCS - requeued
          const window = Math.min(REBUILD_ID_WINDOW, end - cursor)
          const rows = store.ftsRebuildCandidates(cursor, window, below, left)
          for (const row of rows) {
            if (!rebuildable(row.source)) this.rebuildSkipped.add(row.source)
            else if (store.requeueIndexed(row.id)) requeued += 1
          }
          // If cut at the cap, we have seen up to the last row seen; if not cut, we have seen to the end of the range.
          cursor = rows.length >= left ? (rows[rows.length - 1]?.id ?? cursor + window) : cursor + window
          if (requeued >= REBUILD_MAX_DOCS || this.now() >= until) break
        }
        const waiting = done && this.rebuildSkipped.size > 0
        // A round where skipped documents remain starts again from the head at the next launch (and continues if the readers are present).
        settings.writeTyped(INDEX_FTS_REBUILD_CURSOR, waiting ? 0 : done ? UPKEEP_DONE : cursor)
        // Finished looking without skipping a single fs document = all indexed fs documents have been re-indexed with this version (after 925).
        // 946's retroactive pass (fs documents only) is not needed.
        if (done && !this.rebuildSkipped.has('fs')) settings.writeTyped(INDEX_LOSSY_BACKFILL_CURSOR, UPKEEP_DONE)
      })
      this.rebuildRequeued += requeued
      if (done) {
        // Readers do not increase within this launch (the transcript and plugin readers are decided at build time), so even a skipped round does not run again.
        this.rebuildDone = true
        if (!this.rebuildSkipped.has('fs')) this.lossyDone = true
        log.info(this.rebuildSkipped.size > 0 ? 'index.upkeep.ftsRebuild.waiting' : 'index.upkeep.ftsRebuild.done', {
          requeued: this.rebuildRequeued,
          ms: this.now() - (this.rebuildStartedAt ?? this.now()),
          ...(this.rebuildSkipped.size > 0 ? { skippedSources: [...this.rebuildSkipped].sort().join(',') } : {})
        })
      }
    })
    if (requeued > 0) this.deps.onRequeued?.(requeued)
    return worked
  }

  /**
   * One step of the `lossy` retroactive pass (TODO 946). In ascending id order, reads indexed fs files that have no mark and judges them.
   * **The read is outside the column** (the column is not held during body reads), **the mark is written inside the column**, and only to rows still at the version as read.
   * If it learns inside the column that it should yield, it writes nothing and records no progress (the next step re-reads from the same place).
   */
  private async backfillLossy(until: number): Promise<void> {
    const { store, settings } = this.deps
    if (this.deps.shouldYield()) return
    const start = settings.readTyped(INDEX_LOSSY_BACKFILL_CURSOR) ?? 0
    if (start === UPKEEP_DONE) {
      this.lossyDone = true
      return
    }
    if (this.lossyEnd === null) {
      this.lossyEnd = store.maxDocumentId()
      this.lossyStartedAt = this.now()
      log.info('index.upkeep.lossy.start', { from: start, to: this.lossyEnd })
    }
    const end = this.lossyEnd
    const canRead = this.deps.readGate()
    const marks: { readonly id: number; readonly version: string }[] = []
    let cursor = start
    let checked = 0
    let done = false
    scan: for (;;) {
      if (cursor >= end) {
        done = true
        break
      }
      if (this.deps.shouldYield()) break
      const windowEnd = Math.min(cursor + LOSSY_ID_WINDOW, end)
      for (const row of store.lossyCandidates(cursor, windowEnd - cursor)) {
        // Advance at least 1 row per step (so it does not stay stuck even if a read takes longer than the budget).
        if (cursor > start && this.now() >= until) break scan
        const dir = store.pathOf(row.parent_id)
        if (dir !== null) {
          const path = join(dir, row.name)
          if ((await canRead(path)) && (await probeLossy(path, row.version)) === true) {
            marks.push({ id: row.id, version: row.version })
          }
          checked += 1
        }
        cursor = row.id
        // If shutdown or the user's return happens during a read, leave without reading the DB.
        if (this.deps.shouldYield()) break scan
      }
      cursor = windowEnd
      if (this.now() >= until) break
    }
    await this.deps.enqueue(() => {
      if (this.deps.shouldYield()) return
      let marked = 0
      store.atomically(() => {
        for (const mark of marks) if (store.markFsLossyIfUnchanged(mark.id, mark.version)) marked += 1
        settings.writeTyped(INDEX_LOSSY_BACKFILL_CURSOR, done ? UPKEEP_DONE : cursor)
      })
      this.lossyChecked += checked
      this.lossyMarked += marked
      if (done) {
        this.lossyDone = true
        // Only counts and elapsed time (no path or body is output).
        log.info('index.upkeep.lossy.done', {
          checked: this.lossyChecked,
          marked: this.lossyMarked,
          ms: this.now() - (this.lossyStartedAt ?? this.now())
        })
      }
    })
  }
}
