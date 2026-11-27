/**
 * IndexService — the only write entry point to the index, and the Ingestion Pipeline
 * (ARCHITECTURE.md 6.2 / 6.4 / 6.5).
 *
 * ```
 * Indexer (fs / conversation / transcript / future plugins)
 *   ▼ Normalize     source-specific raw data → common Document (6.3)
 *   ▼ Deduplicate   skip unchanged ones by version and content_hash
 *   ▼ Metadata      language detection / date / exposure
 *   ▼ Chunk         split into search units (keeping only byte positions inside the canonical copy)
 *   ▼ Index         write to chunks + contentless FTS5
 * ```
 *
 * **Ingestion is serialized through a single queue** (6.2 "single writer principle").
 * Writes to the encrypted DB cost +77% over plaintext (spike 11b), so batches are always
 * grouped in a transaction, and control returns to the event loop between them.
 */
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type {
  Exposure,
  IndexStatus,
  ScopeBuildResult,
  SearchHit,
  SearchResponse,
  SearchRoleCode,
  SearchScope,
  ThreadSearchResponse
} from '@shared/search.js'
import { isSearchRoleCode, THREAD_SEARCH_LIMIT } from '@shared/search.js'
import { BUILTIN_INDEX_SOURCES, PLUGIN_ID_RE, indexSourceOwnedBy, type PluginDocumentInput } from '@shared/plugin.js'
import type { DbBreakdown } from '@shared/db-breakdown.js'
import { measureDb } from './db-breakdown.js'
import { quickCheckDb } from './db-check.js'
import type { DbQuickCheckResult } from '@shared/backup.js'
import { yieldToEventLoop } from '../common/batch.js'
import { log, errorFields } from '../common/logger.js'
import { pathToUri } from '../common/uri.js'
import { classify, type ExclusionRules } from '../common/exclusions.js'
import { redactSlice, redactText, type RedactionContext } from '../common/redact.js'
import { chunkImageText, chunkText, type Chunk } from './chunk.js'
import { directoryTreeOf } from './cwd-scope.js'
import { CaseFilter } from './smart-case.js'
import {
  derivedTextDigest,
  extractFile,
  extractGate,
  isDerivedText,
  isExtractable,
  isImagePath,
  readUtf8Range,
  sliceUtf8,
  type Utf8Range
} from './extract.js'
import { pdfPageOfByte, sanitizePageLengths } from './pdf.js'
import {
  imageAnalyzer,
  imageAvailable,
  imageOcrAvailable,
  IMAGE_EXTENSIONS,
  storedImageBoost,
  storedImageLabelsOf,
  storedImageText,
  type StoredImageLabels
} from './image.js'
import {
  AGENT_EXPOSURES,
  UI_EXPOSURES,
  type ChunkInput,
  type DocumentRow,
  type IndexStore,
  type SearchRow,
  type UpsertedRow
} from './store.js'
import { asTextTerms, isPlainQuery, likeContains, parseQueryFilter } from './query-filter.js'
import {
  buildMatchQuery,
  detectLanguage,
  ensureTokenizer,
  indexShadowText,
  missingQueryChars
} from './tokenize.js'
import { DEFAULT_IDLE_SECONDS, DEFAULT_TICK_MS } from './scheduler.js'
import {
  SLOW_BATCH_SIZE,
  SLOW_MERGE_BUDGET_MS,
  SLOW_SYNC_BUDGET_MS,
  SlowPacer,
  decidePace,
  holdReason,
  type Pace,
  type StepClock,
  type ThermalState
} from './pace.js'
import { IdleUpkeep } from './upkeep.js'
import { AppSettingsStore } from '../common/settings.js'

/** Number of documents handled per index batch. Control is returned in between so the UI does not stall. */
const BATCH_SIZE = 40
/**
 * Budget for the **synchronous section** of one batch (P2). Extraction is async, but word
 * segmentation (kuromoji) and chunking hold the main thread synchronously. Once this is
 * exceeded the batch proceeds to the write even before `BATCH_SIZE` documents have accumulated.
 */
const SYNC_BUDGET_MS = 50
/** Time budget for one merge loop (P3). Whatever remains after this is left for the next chance. */
const MERGE_BUDGET_MS = 50
/** Time budget (ms) for one OCR step in the full-speed stage. It cannot be cut mid-image (worst case up to the 5 s cap), so once the budget is exceeded the rest goes to the next tick. */
const OCR_FULL_BUDGET_MS = 1_500
/** How long to wait before retrying an image that timed out (a transient failure). */
const OCR_RETRY_DELAY_MS = 60_000
/** A deferral record this far past its due time was never revisited (the row is gone or the step stopped): forget it, including its failure count. */
const DEFERRED_STALE_MS = 10 * OCR_RETRY_DELAY_MS
/** After this many consecutive timeouts the image is marked `failed` (the first one is retried later). */
const OCR_MAX_TRANSIENT = 2
/** How many images, and how much total time, one search may spend re-running OCR (for the OCR text-match excerpt; beyond that, results come back without an excerpt). */
const SEARCH_OCR_MAX_IMAGES = 5
const SEARCH_OCR_BUDGET_MS = 3_000
/** Interval between merge ticks while the build is stopped (P3). */
const MERGE_TICK_MS = 1000
const STATUS_INTERVAL_MS = 1000
/**
 * Interval for re-running the counts (COUNT). Do not count repeatedly during an index build.
 * `SELECT COUNT(*) FROM chunks` takes tens of ms at 7.1 million rows, so the interval is wide (P2).
 */
const COUNT_INTERVAL_MS = 15_000
const PROGRESS_LOG_MS = 10_000
/** Default result count for UI search. */
const DEFAULT_LIMIT = 50
/**
 * Number of chunks fetched from FTS5 for smart case (TODO 291). Fetch extra to cover the
 * candidates dropped for case mismatch (usually `max(limit * 5, 200)`). The cost of MATCH
 * barely depends on LIMIT (BM25 ranks everything), so what matters is the number of reads
 * in the re-check below.
 */
const CASE_FETCH_MIN = 1_000
const CASE_FETCH_MAX = 4_000
/** Cap on canonical-copy reads in the smart case re-check (per partition). Beyond it, `truncated`. */
const CASE_MAX_READS = 600
/**
 * Minimum number of candidates with no canonical copy (deleted files, deleted messages) that
 * may be discarded while filling in from below (TODO 860). The actual cap is `max(limit, this)`.
 * Beyond it we stop and return `truncated`.
 */
const GONE_MAX_READS = 50
/**
 * Cap on bodies built **without waiting for idle** after the subtree scan on thread creation (item 249).
 * Whatever exceeds either limit is left to the normal build (P4 idle wait).
 */
export const SUBTREE_BUILD_MAX_DOCS = 2_000
export const SUBTREE_BUILD_MAX_MS = 10_000
/** Cap on the count of bodies pending after a scope build (TODO 437). The badge shows "N or more". */
export const SCOPE_PENDING_COUNT_MAX = 10_000
/** Sources seen by in-conversation search. File search covers everything else (6.1). */
const CONVERSATION_SOURCES = ['conversation', 'transcript'] as const
const SNIPPET_RADIUS = 90

/** Columns of the query sequence number (P6): File search / conversation search (⌘K) / in-thread search (TODO 496). */
type SeqLane = SearchScope | 'thread'
const SEQ_LANES: readonly SeqLane[] = ['files', 'conversation', 'thread']
/** Key of the query sequence number ledger (TODO 497). Queries without a window (tests, calls that pass no window) share a single lane. */
function seqKeyOf(lane: SeqLane, origin: number | undefined): string {
  return origin === undefined ? lane : `${lane}:${origin}`
}
/**
 * A number this much or more below the latest at the entry point is not typing overtaking (at most 2-3
 * with the 150 ms debounce) but treated as a ledger mix-up (TODO 551 / 497), and is logged.
 */
export const STALE_GAP_WARN = 10

/**
 * Entry point for reading the canonical copy of conversations (`thread_events`). IndexService holds no SQL.
 *
 * **Became async in P1.** The canonical copy lives in main's `ThreadStore`, and the index process
 * asks via reverse RPC (3.4). This is so the index process does not become a second reader of
 * `thread_events` — we do not multiply canonical copies (constraint 9).
 */
export interface ConversationSource {
  /** Event body to index. null if absent (a kind that is not stored). */
  readEventText(eventId: string): Promise<{ text: string; threadId: string; ts: number } | null>
  /** Thread name (used to show context in search results). */
  threadTitle(threadId: string): Promise<string | null>
  /**
   * Of `eventIds`, returns only those still present in the canonical copy (thread not soft-deleted and row not gone)
   * (TODO 863). One round trip that lets in-thread search confirm hits without reading bodies. It does not filter by
   * thread (the index prefix match is a case-insensitive `LIKE`, so a live message of another thread must not be
   * mistaken for a leftover and dropped). When omitted, no confirmation is done (tests etc.).
   */
  liveEventIds?(eventIds: readonly string[]): Promise<readonly string[]>
}

/**
 * The part of the backend transcript (read-only) that the index process needs.
 *
 * **Only the Adapter knows the location and format of transcripts** (constraint 6). Ingestion is
 * arranged so that main reads the file and **passes the body** to `indexTranscriptMessages`,
 * so all that remains here is one re-read for snippets, which also goes through reverse RPC.
 */
export interface TranscriptSource {
  /**
   * Body of one message (for snippets and getDocumentText; read from the canonical copy).
   * `locator` is the location recorded at ingestion (item 78). If present, main partially reads
   * just that one line; if absent (rows from before item 78) it parses the whole file.
   */
  readMessageText(
    fileId: string,
    messageId: string,
    locator: TranscriptLocator | null
  ): Promise<string | null>
}

/**
 * Location of one transcript message (item 78). **Contains no knowledge of the format** — only the
 * byte position and length of the line, and the version of the file when they were measured
 * (an opaque string). Validation is done by main.
 */
export interface TranscriptLocator {
  readonly offset: number
  readonly length: number
  readonly version: string
}

/** One transcript file to ingest (read and passed by main). */
export interface TranscriptFile {
  readonly id: string
  readonly uri: string
  /** Item 78: the version of the file when the location (`offset` / `length`) was measured. */
  readonly version?: string
}

/** One message of a transcript. tool_result is not included (constraint 10). */
export interface TranscriptMessageInput {
  readonly id: string
  readonly role: string
  readonly text: string
  readonly ts: number
  readonly sessionId: string
  /** Item 78: byte position and length of the line (not character counts). */
  readonly offset?: number
  readonly length?: number
}

/**
 * Canonical copy of plugin-derived bodies (6.5). **Plugins do not write to the index directly** —
 * `CapabilityBroker.index.put` routes through here (7.7). The canonical copy is kept in exactly
 * one place, the encrypted DB's `plugin_documents` (12.9).
 *
 * **Became read-only in P1.** Writes and deletes of the canonical copy are done by main's
 * `PluginDocumentStore` (the order is still "canonical copy first"), and the index process
 * only asks for bodies via reverse RPC (3.4).
 */
export interface PluginSource {
  /** Reads the canonical copy (for snippets and getDocumentText). */
  read(source: string, sourceId: string): Promise<string | null>
}

/**
 * Inputs for the pace stage of index building (P4 → TODO 434). **Uses the same decision
 * (`decidePace`) and the same thresholds** as the scan (`ScanScheduler`, 6.2.2). `powerMonitor`
 * exists only in main, so this takes the same "function injection" shape as `ScanScheduler`
 * (on the real machine `src/main/index.ts` sends it via `power` and the kernel passes it; tests pass fake values).
 *
 * Stages (`pace.ts`): full speed when idle (300 s), slow while the user is active (N% of one core),
 * wait when thermal state is `serious` or above / Low Power Mode. **The power source is not looked at**
 * (434 revised P4's "do not run on battery").
 *
 * If not injected, **the check is disabled** (always runs at full speed) — existing tests stay in that form.
 */
export interface IndexIdlePolicy {
  /** Seconds since the last user input (`powerMonitor.getSystemIdleTime()`). */
  readonly idleSeconds: () => number
  /** Thermal state (`powerMonitor.getCurrentThermalState()`). If omitted, `unknown` (do not stop). */
  readonly thermalState?: () => ThermalState
  /** Whether Low Power Mode is on. If omitted, false. */
  readonly lowPower?: () => boolean
  /** Threshold for full speed. Default is 300 s, same as `ScanScheduler`. Below it, run slow. */
  readonly idleThresholdSeconds?: number
  /** Interval for re-running the check while waiting. Default is 60 s, same as `ScanScheduler`. */
  readonly tickMs?: number
  /** For tests: own timer. Calling the return value stops it. */
  readonly schedule?: (fn: () => void, ms: number) => () => void
  /** Pacing for the slow stage (TODO 434). The kernel shares one with the scan. Tests pass a fake clock. */
  readonly pacer?: SlowPacer
}

export interface IndexServiceDeps {
  readonly db: Database
  readonly store: IndexStore
  readonly conversation: ConversationSource
  readonly transcripts: TranscriptSource | null
  /** Entry point added in Phase 4 (7.7). May be null while there are no plugins. */
  readonly plugins?: PluginSource | null
  /** P4. If omitted, there is no check (runs unconditionally, as before). */
  readonly idle?: IndexIdlePolicy | null
  /**
   * The current exclusion rules (TODO 849). Re-applied to both the logical path and the realpath
   * before reading the fs canonical copy (`fsVerdict`). In the index process this is `FsIndexer.exclusionRules`.
   * If omitted, nothing is applied (tests).
   */
  readonly fsRules?: (() => ExclusionRules) | null
  readonly onStatus: (status: IndexStatus) => void
}

/**
 * One document after extraction and word segmentation (P2). **The write is not part of this** —
 * `runBuild` accumulates N of them and then writes them together in one transaction.
 */
interface PreparedDocument {
  readonly id: number
  /** fs: decoding does not round-trip to the original bytes (TODO 925). `writeBatch` marks the row. undefined for other sources. */
  readonly lossy?: boolean
  /** fs: PDF page starts (TODO 1009 stage 2, `ExtractResult.pdfPages`). `writeBatch` puts it in `metadata`. */
  readonly pdfPages?: readonly number[]
  /** fs: image classification labels (TODO 998, `ExtractResult.image`). `writeBatch` puts it in `metadata`. */
  readonly image?: StoredImageLabels
  /**
   * Version of the row when the body was read (TODO 922). `runBuild` waits for the read outside the write
   * column, so in the meantime the row may disappear (watcher deletion, `removeThread`) or the version may
   * advance and the row go back to `pending`. `writeBatch` compares against the current row and does not
   * write to rows that are gone or whose version changed. `ingestBatched`, which reads while holding the column, does not set it.
   */
  readonly version?: string
  readonly outcome:
    | {
        readonly kind: 'index'
        readonly chunks: readonly ChunkInput[]
        readonly contentHash: string
        readonly lang: string | null
      }
    | { readonly kind: 'skip' }
    | { readonly kind: 'fail'; readonly reason: string }
}

/** Limits for building subtree bodies (item 249) (tests swap in small ones). */
export interface SubtreeBuildLimits {
  readonly maxDocs?: number
  readonly maxMs?: number
}

/** Result of building subtree bodies (item 249). Only counts and ms (no bodies or paths). */
export interface SubtreeBuildResult {
  /** Number of documents built (indexed, marked out of scope, or marked failed). */
  readonly built: number
  /** Number of documents that were selected but still wait for a body (left over by timeout, shutdown, or pause). */
  readonly left: number
  /** The subtree's pending bodies exceeded the count cap (the excess was not selected). */
  readonly capped: boolean
  readonly ms: number
}

/**
 * One request to build subtree bodies (item 249). `runBuild` processes these `ids` ahead of the usual remainder.
 * Writes go through the same path as usual (`enqueue` → `writeBatch`); no separate writer is created.
 */
interface BuildScope {
  readonly path: string
  /** Target document ids (shallowest first). Everything before `cursor` has been processed. */
  readonly ids: readonly number[]
  cursor: number
  built: number
  readonly capped: boolean
  readonly startedAt: number
  readonly deadline: number
  readonly settle: (result: SubtreeBuildResult) => void
}

interface Canonical {
  readonly text: string
  readonly uri: string
  readonly title: string
  readonly context: string
  /** Code for when `context` is a standard label (TODO 66, `@shared/search.js`). */
  readonly contextCode: SearchRoleCode | null
  readonly threadId: string | null
  readonly eventId: string | null
  /** fs: decoding does not round-trip to the original bytes (TODO 925, `ExtractResult.lossy`). Other sources do not have it. */
  readonly lossy?: boolean
  /** fs: PDF page starts (TODO 1009 stage 2). */
  readonly pdfPages?: readonly number[]
  /** fs: image classification labels (TODO 998). */
  readonly image?: StoredImageLabels
}

export class IndexService {
  private readonly store: IndexStore
  private readonly conversation: ConversationSource
  private readonly transcripts: TranscriptSource | null
  private readonly plugins: PluginSource | null
  private readonly fsRules: (() => ExclusionRules) | null
  private readonly onStatus: (status: IndexStatus) => void

  private status: IndexStatus
  private running = false
  private paused = false
  private stopped = false
  /**
   * Whether shutdown has begun. `stopped` means "stop the current build" and is reset to false
   * at the start of `build()`. This one is the app quitting and never goes back.
   * When the scan finished and `onIndexable` arrived, `resume()` → `build()` reset
   * `stopped` to false, which wrote to the DB after it was closed and crashed with
   * `The database connection is not open`.
   */
  private shutdown = false
  private lastStatusAt = 0
  private lastCountAt = 0
  /** Queue for serialization. Writes to the index always happen on this chain. */
  private queue: Promise<void> = Promise.resolve()
  /** The running build loop. On shutdown we wait for it before closing the DB. */
  private buildTask: Promise<void> | null = null
  /**
   * Latest query sequence number per (lane, window) (P6 → TODO 497). A search with an older number
   * is returned as `stale` **without running**. Searches from the gateway carry no number, so they pass through.
   * The lanes are File search / conversation search (⌘K) / in-thread search (TODO 496); the window is the
   * renderer's webContents id (`origin`) that main attaches. The renderer counts from 1 per window,
   * so with a single ledger for all windows, the first few queries of the second window lost to the
   * first window's numbers and were discarded (TODO 497).
   * Cleared with `forgetOrigin` when a window is closed / reloaded. The key is `seqKey`.
   */
  private readonly latestSeq = new Map<string, number>()
  /** Keys for which `index.search.staleGap` was logged (TODO 551). Removed once a search with that key passes. */
  private readonly staleGapWarned = new Set<string>()

  // ---- P4 → TODO 434: pace stages ----
  private readonly idlePolicy: IndexIdlePolicy | null
  private readonly idleThresholdSeconds: number
  private readonly tickMs: number
  private readonly pacer: SlowPacer
  /** After a merge tick in the slow stage, the time at which the next tick is allowed (TODO 434, the N% budget). */
  private mergeRestUntil = 0
  /**
   * The user pressed "stop" (TODO 434). Automatic resumes (`onIndexable` / the wait timer) do not
   * clear it; only "resume" (`manual`) does. Since 434 the build also runs while the user is active,
   * so without this a single watcher delta would clear the stop.
   */
  private userPaused = false
  private readonly schedule: (fn: () => void, ms: number) => () => void
  /** Hook to stop the wait / merge timer. */
  private cancelTimer: (() => void) | null = null
  /**
   * Requests to build subtree bodies (item 249). Processed in order from the front, ahead of the usual remainder.
   * While any remain, we do not yield on "user is active again" (P4) — they are what the user is waiting on in a
   * thread they just created. They have caps (count and time), so they are not held for long.
   */
  private scopes: BuildScope[] = []
  /** One-time idle cleanup (TODO 945 / 946, `upkeep.ts`). */
  private readonly upkeep: IdleUpkeep
  /** The running step of the cleanup. `stop()` waits for it before returning. */
  private upkeepTask: Promise<void> | null = null
  /** The running OCR step (TODO 998 stage 2). `stop()` waits for it before returning. */
  private ocrTask: Promise<void> | null = null
  /** After OCR in the slow stage, the time at which the next one is allowed (the N% budget; same shape as the merge's `mergeRestUntil`). */
  private ocrRestUntil = 0
  /**
   * Images postponed after a timeout (a transient failure): document id → count, and the time at which a retry is allowed. The first is retried later,
   * and two timeouts in a row mark it `failed` (remembered only for the lifetime of the index process; counting restarts after a restart).
   */
  private readonly ocrDeferred = new Map<number, { readonly fails: number; readonly until: number }>()
  /**
   * Images whose classification timed out in the build (TODO 1234): the same counting as `ocrDeferred` (the first timeout is retried after
   * `OCR_RETRY_DELAY_MS`, a second in a row settles as before; remembered only for the lifetime of the index process). The row stays `pending` meanwhile.
   */
  private readonly classifyDeferred = new Map<number, { readonly fails: number; readonly until: number }>()
  /** How often the build re-reads the pending rows while only deferred classifications remain (a field so that tests can shorten it). */
  private classifyPollMs = 1000

  private readonly db: Database

  constructor(deps: IndexServiceDeps) {
    this.db = deps.db
    this.store = deps.store
    this.conversation = deps.conversation
    this.transcripts = deps.transcripts
    this.plugins = deps.plugins ?? null
    this.fsRules = deps.fsRules ?? null
    this.onStatus = deps.onStatus
    this.idlePolicy = deps.idle ?? null
    this.idleThresholdSeconds = this.idlePolicy?.idleThresholdSeconds ?? DEFAULT_IDLE_SECONDS
    this.pacer = this.idlePolicy?.pacer ?? new SlowPacer()
    this.tickMs = this.idlePolicy?.tickMs ?? DEFAULT_TICK_MS
    this.schedule = this.idlePolicy?.schedule ?? defaultSchedule
    this.upkeep = new IdleUpkeep({
      store: this.store,
      settings: new AppSettingsStore(deps.db),
      enqueue: (work) => this.enqueue(work),
      shouldYield: () =>
        this.shutdown || this.running || this.userPaused || this.currentPace() !== 'full',
      // Same choke point as the index build (TODO 849): apply the current exclusion rules and the parent's realpath before reading.
      readGate: () => {
        const dirs: RealDirCache = new Map()
        return async (path) => (await this.fsVerdict(path, dirs)) === 'ok'
      },
      // TODO 965: rebuild only the sources whose canonical copy the build (`readCanonical`) can read.
      rebuildable: (source) =>
        source === 'fs' ||
        source === 'conversation' ||
        (source === 'transcript' ? this.transcripts !== null : this.plugins !== null),
      // Add the restored ones to the remainder. The next tick (`onTick`) sees the remainder and starts the build (the count is recomputed at the end of the build).
      onRequeued: (count) => {
        if (this.shutdown) return
        this.status = { ...this.status, pending: this.status.pending + count }
      }
    })
    // If the way the shadow text is made has changed (TODO 1152), decide the rebuild range before the build writes new chunks.
    this.upkeep.applyShadowEpoch()
    const counters = this.store.counters()
    this.status = {
      state: 'idle',
      ...counters,
      startedAt: null,
      finishedAt: null,
      message: null
    }
  }

  getStatus(): IndexStatus {
    return this.status
  }

  /**
   * Measures the DB breakdown (TODO 846 / 914 / 988). `dbstat` reads every page, so it is heavy. It is put on the same
   * queue as writes so that it does not overlap the build (the index build waits while it runs). A
   * `yieldToEventLoop` is inserted between per-table steps, so RPCs such as search do not stall. Read-only; writes nothing.
   */
  async measureDatabase(top = 30): Promise<DbBreakdown> {
    let result: DbBreakdown | null = null
    await this.enqueue(async () => {
      result = await measureDb(this.db, top, yieldToEventLoop)
    })
    if (result === null) throw new Error('index service is shut down')
    return result
  }

  /**
   * TODO 1306: the light check of the DB after startup (`db-check.ts`). One table per queue item, so index writes interleave and shutdown
   * stops it between tables (`stopped`). Read-only.
   */
  async quickCheck(): Promise<DbQuickCheckResult> {
    return quickCheckDb(this.db, async (work) => {
      if (this.shutdown) return false
      let ran = false
      await this.enqueue(() => {
        ran = true
        work()
      })
      return ran
    })
  }

  /** Puts work on the queue. **Every write to the index goes through here** (6.2). */
  private enqueue(work: () => Promise<void> | void): Promise<void> {
    // **Work queued after shutdown is not accepted**. The DB may already be closed.
    // Work queued before shutdown runs to the end: `stop()` waits for the queue and then returns,
    // and the caller closes the DB after that.
    if (this.shutdown) return Promise.resolve()
    const result = this.queue.then(work)
    // Do not break the chain on failure.
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private publish(force = false): void {
    // After shutdown the DB may be closed. Count aggregation is also a read, so do not touch it.
    if (this.shutdown) return
    const now = Date.now()
    if (!force && now - this.lastStatusAt < STATUS_INTERVAL_MS) return
    this.lastStatusAt = now
    if (force || now - this.lastCountAt >= COUNT_INTERVAL_MS) {
      this.lastCountAt = now
      this.status = { ...this.status, ...this.store.counters() }
    }
    this.onStatus(this.status)
  }

  private setStatus(patch: Partial<IndexStatus>): void {
    this.status = { ...this.status, ...patch }
    this.lastStatusAt = 0
    this.publish(true)
    // Write back only the status afterwards, so that the patch is not overwritten by counters.
    this.status = { ...this.status, ...patch }
  }

  // ---- Index build (background work) ----

  /**
   * Advances the remaining index work. **It starts automatically at launch, can be stopped at any time,
   * and resumes from where it stopped** (user decision, 12.7). The resume point is
   * `documents.index_state = 'pending'` itself, so no separate state is kept.
   */
  async build(options: { manual?: boolean } = {}): Promise<void> {
    if (this.running || this.shutdown) return
    const manual = options.manual === true
    if (manual) this.userPaused = false
    // What the user stopped is not resumed automatically (TODO 434).
    else if (this.userPaused) return
    // **The first launch (empty index) and the "resume" the user pressed use the same check** (TODO 434 → TODO 448).
    // While the user is active we start slow, and wait without starting only on thermal state / Low Power Mode — this drops
    // P4's default where "resume" skipped the check and ran at full speed all the way (the first build would run at full speed for hours even while the user was active).
    if (this.currentPace() === 'hold') {
      this.enterWaiting()
      return
    }
    this.clearTimer()
    const task = this.runBuild()
    this.buildTask = task
    try {
      await task
    } finally {
      // If the subtree build (item 249) has started the next run near the end, do not clear that one.
      if (this.buildTask === task) this.buildTask = null
    }
  }

  /**
   * Builds the pending bodies of the subtree under `rootId` (a thread's working folder) **without waiting
   * for the idle check** (item 249, ARCHITECTURE.md 6.2.2 "subtree scan on thread creation"). Called inside the index
   * process right after the subtree scan (`FsIndexer.scanSubtree`).
   *
   * - Targets up to `SUBTREE_BUILD_MAX_DOCS` pending bodies of the subtree, shallowest first, for at most
   *   `SUBTREE_BUILD_MAX_MS`. The rest is picked up by the normal build (P4 idle wait).
   * - Writes are done by the normal build loop (`runBuild`) — 1 batch = 1 transaction,
   *   a time-budgeted merge right after COMMIT (P2 / P3), and through `enqueue` (6.2). If the normal build
   *   is running, that loop handles these first from the next batch (piggybacking).
   * - It does not stop on "user is active again" (P4). It does stop on shutdown (`stop`) and pause (`pause`).
   */
  buildSubtree(
    rootId: number,
    path: string,
    limits: SubtreeBuildLimits = {}
  ): Promise<SubtreeBuildResult> {
    const startedAt = Date.now()
    if (this.shutdown) return Promise.resolve({ built: 0, left: 0, capped: false, ms: 0 })
    const maxDocs = limits.maxDocs ?? SUBTREE_BUILD_MAX_DOCS
    // Fetch one extra to also learn whether the cap was exceeded.
    const found = this.store.pendingInSubtree(rootId, maxDocs + 1)
    const ids = found.slice(0, maxDocs)
    const capped = found.length > maxDocs
    if (ids.length === 0) {
      log.info('index.build.subtree.done', { path, built: 0, left: 0, capped, ms: Date.now() - startedAt })
      return Promise.resolve({ built: 0, left: 0, capped, ms: Date.now() - startedAt })
    }
    return new Promise<SubtreeBuildResult>((resolve) => {
      this.scopes.push({
        path,
        ids,
        cursor: 0,
        built: 0,
        capped,
        startedAt,
        deadline: startedAt + (limits.maxMs ?? SUBTREE_BUILD_MAX_MS),
        settle: resolve
      })
      // If the normal build is running, piggyback (the loop picks it up in the next batch). If it is stopped, start a subtree-only run.
      this.startScopedRun()
    })
  }

  /**
   * Build done when the Search screen's scope (TODO 437) is decided. Runs the subtree of `path` (already validated) through
   * `buildSubtree` (item 249, limit 2,000 documents / 10 s, skips the idle check), then counts the bodies still pending
   * in the subtree and returns it (the "N unindexed in this folder" next to the badge; nothing is silently left out).
   * Counting goes up to `SCOPE_PENDING_COUNT_MAX` (beyond that, `pendingCapped`). If the subtree is not in the index, 0.
   */
  async buildScope(path: string): Promise<ScopeBuildResult> {
    if (this.shutdown) return { built: 0, pending: 0, pendingCapped: false }
    const subtree = directoryTreeOf(this.store).subtree(path)
    if (subtree === null) return { built: 0, pending: 0, pendingCapped: false }
    const result = await this.buildSubtree(subtree.rootId, path)
    // If shutdown has begun, do not read the DB (estimate without counting).
    if (this.shutdown) return { built: result.built, pending: result.left, pendingCapped: result.capped }
    const pending = this.store.pendingInSubtree(subtree.rootId, SCOPE_PENDING_COUNT_MAX + 1).length
    return {
      built: result.built,
      pending: Math.min(pending, SCOPE_PENDING_COUNT_MAX),
      pendingCapped: pending > SCOPE_PENDING_COUNT_MAX
    }
  }

  /** Starts a subtree-only build run (item 249). Does nothing if one is running (that run picks it up). */
  private startScopedRun(): void {
    if (this.running || this.shutdown) return
    // While the user has "stopped", subtree builds do not run either (owner decision 2026-11-05, TODO 1136 part 2).
    // Stop is an explicit action, so it takes priority over thread creation. Waiting requests return their result unbuilt.
    // (`runBuild` starts by setting `paused = false`, so without refusing here it would run at full speed and break "stopped".)
    if (this.userPaused) {
      const settled = this.scopes
      this.scopes = []
      for (const scope of settled) this.settleScope(scope)
      return
    }
    this.clearTimer()
    const task = this.runBuild(true)
    this.buildTask = task
    void task.finally(() => {
      if (this.buildTask === task) this.buildTask = null
    })
  }

  /** The first subtree request. A request that is finished or timed out returns its result here and is removed. */
  private currentScope(): BuildScope | null {
    for (;;) {
      const scope = this.scopes[0]
      if (scope === undefined) return null
      if (scope.cursor < scope.ids.length && Date.now() < scope.deadline) return scope
      this.scopes.shift()
      this.settleScope(scope)
    }
  }

  private settleScope(scope: BuildScope): void {
    // During shutdown, do not read the DB (estimate without counting).
    const left = this.shutdown
      ? Math.max(0, scope.ids.length - scope.built)
      : this.store.pendingAmong(scope.ids).length
    const result: SubtreeBuildResult = {
      built: scope.built,
      left,
      capped: scope.capped,
      ms: Date.now() - scope.startedAt
    }
    log.info('index.build.subtree.done', { path: scope.path, ...result })
    scope.settle(result)
  }

  /** The current pace stage (TODO 434). Always `full` if no check was injected. */
  private currentPace(): Pace {
    if (this.idlePolicy === null) return 'full'
    return decidePace({
      idleSeconds: this.idlePolicy.idleSeconds(),
      idleThresholdSeconds: this.idleThresholdSeconds,
      thermalState: this.idlePolicy.thermalState?.() ?? 'unknown',
      lowPower: this.idlePolicy.lowPower?.() ?? false
    })
  }

  /** Reason for waiting (`hold`). The status bar's `waiting` `message` (`thermal` / `low-power`). */
  private holdMessage(): string {
    return (
      holdReason(
        this.idlePolicy?.thermalState?.() ?? 'unknown',
        this.idlePolicy?.lowPower?.() ?? false
      ) ?? 'thermal'
    )
  }

  /**
   * Enters waiting (P4 → TODO 434: only on thermal state / Low Power Mode). The status bar shows "waiting",
   * and the check is redone every second.
   */
  private enterWaiting(): void {
    if (this.shutdown) return
    this.setStatus({ state: 'waiting', message: this.holdMessage() })
    this.armTimer()
  }

  /** Arms the wait / merge timer (never twice). */
  private armTimer(): void {
    if (this.shutdown || this.cancelTimer !== null) return
    // While waiting, run at the check interval (default 60 s); if the build is merely finished,
    // at the merge tick interval (1 s). Use the shorter one and check every time.
    const period = Math.min(this.tickMs, MERGE_TICK_MS)
    this.cancelTimer = this.schedule(() => this.onTick(), period)
  }

  private clearTimer(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  /**
   * One tick while the build is stopped. If not waiting (thermal / Low Power Mode), resumes the build, and
   * if nothing remains, ticks **only the merge** within the time budget (P3(b)). In the slow stage the merge is also
   * put in the N% budget (after a tick, do not tick again for (100/N − 1) times the CPU time spent, TODO 434).
   */
  private onTick(): void {
    if (this.shutdown || this.running || this.userPaused) return
    const pace = this.currentPace()
    if (pace === 'hold') return
    if (this.status.pending > 0 || this.status.state === 'waiting') {
      this.clearTimer()
      void this.build()
      return
    }
    // When nothing remains, advance only the merge (in effect doing optimize in small steps).
    if (pace === 'slow' && Date.now() < this.mergeRestUntil) return
    void this.enqueue(() => {
      if (pace === 'slow') {
        const clock = this.pacer.clock()
        this.mergeWithin(SLOW_MERGE_BUDGET_MS)
        this.mergeRestUntil = Date.now() + clock.restMs()
      } else {
        this.mergeWithin(MERGE_BUDGET_MS)
      }
    })
    // Only in the full-speed stage (idle), advance the one-time cleanup by one step (TODO 945 / 946).
    if (pace === 'full') this.runUpkeep()
    // If nothing remains (= all images are classified) and no thermal state / Low Power Mode, advance image OCR sparsely, newest first.
    this.runOcr(pace)
  }

  /**
   * One step of image OCR (TODO 998 stage 2, owner decision 2026-11-13: classify all images first, then OCR sparsely afterwards, newest first,
   * with a 5 s cap per image). The full-speed stage runs up to `OCR_FULL_BUDGET_MS` per step; the slow stage does one image and rests for
   * the helper's CPU time (`cpuUs`, `addHelperCpuMicros`) that it counted (N% of one core). Does nothing if the previous step is still running.
   */
  private runOcr(pace: Pace): void {
    if (pace === 'hold' || this.shutdown || this.ocrTask !== null || !imageOcrAvailable()) return
    if (pace === 'slow' && Date.now() < this.ocrRestUntil) return
    const task = this.ocrStep(pace)
      .catch((err: unknown) => log.warn('index.ocr.failed', errorFields(err)))
      .finally(() => {
        if (this.ocrTask === task) this.ocrTask = null
      })
    this.ocrTask = task
  }

  private async ocrStep(pace: Pace): Promise<void> {
    const clock = pace === 'slow' ? this.pacer.clock() : null
    const until = Date.now() + (pace === 'slow' ? 0 : OCR_FULL_BUDGET_MS)
    let done = 0
    do {
      if (this.shutdown || this.running || this.userPaused || this.status.pending > 0) break
      const now = Date.now()
      const waiting = new Set<number>()
      for (const [id, entry] of this.ocrDeferred) {
        if (entry.until > now) waiting.add(id)
        else if (now - entry.until > DEFERRED_STALE_MS) this.ocrDeferred.delete(id)
      }
      // Fetching candidates only reads. Rows to drop are removed inside the writer's column (through `enqueue`).
      const { rows, stale } = this.store.ocrCandidates(1, waiting)
      if (stale.length > 0) {
        await this.enqueue(() => {
          for (const id of stale) this.store.dequeueOcr(id)
        })
      }
      const row = rows[0]
      if (row === undefined) break
      await this.ocrOne(row)
      done += 1
    } while (Date.now() < until && !this.shutdown)
    if (done > 0) {
      this.pacer.note('build', pace, done)
      if (clock !== null) this.ocrRestUntil = Date.now() + clock.restMs()
    }
  }

  /**
   * OCR of one image. Read → extract text (`extractFile` with `ocr: 'run'`) → rebuild the sentence. **The text is not saved** (constraint 9): only the
   * result mark (`image.ocr`), the chunks built from the sentence (byte ranges) and the FTS terms are saved. If the sentence does not change (no text, or a failure), the chunks are
   * not rebuilt and only the mark is written. Whatever the result, it leaves the queue (`setFsLossy` / `dequeueOcr`).
   *
   * **This is the only place that writes the OCR state (done / none / failed).** A timeout or a helper crash (`transient`) is not assumed to be the image's fault:
   * the first time no mark is written and it is retried later (excluded from candidates during `OCR_RETRY_DELAY_MS`), and two in a row give `failed`.
   */
  private async ocrOne(row: {
    readonly id: number
    readonly version: string
    readonly metadata: string | null
    readonly content_hash: string | null
  }): Promise<void> {
    const path = this.store.pathOf(row.id)
    const stored = storedImageLabelsOf(parseMetadata(row.metadata))
    if (path === null || stored === null) {
      await this.enqueue(() => this.store.dequeueOcr(row.id))
      return
    }
    // TODO 1331 item 5: the version check the classification side makes (the version only: the row's version marker is built from the
    // versions and has no backend, so a row dropped for its backend alone would never be re-indexed; production has one backend). Labels from another analyzer version are not this stage's to
    // handle: `extractFile` would re-classify (no OCR) and store fresh labels under the row's old version marker. Leave the queue; the
    // marker no longer matches, so the re-index classifies the row again and puts it back (`enqueueOcr` on save).
    const analyzer = imageAnalyzer()
    if (analyzer === null || stored.v !== analyzer.version) {
      await this.enqueue(() => this.store.dequeueOcr(row.id))
      return
    }
    if ((await this.fsVerdict(path)) !== 'ok') {
      await this.enqueue(() => this.store.dequeueOcr(row.id))
      return
    }
    const result = await extractFile(path, { image: stored, ocr: 'run' })
    if (this.shutdown) return
    let failedImage: StoredImageLabels | null = null
    if (!result.ok && result.reason === 'transient') {
      const fails = (this.ocrDeferred.get(row.id)?.fails ?? 0) + 1
      if (fails < OCR_MAX_TRANSIENT) {
        this.ocrDeferred.set(row.id, { fails, until: Date.now() + OCR_RETRY_DELAY_MS })
        log.info('index.ocr.deferred', { id: row.id, fails })
        return
      }
    }
    if (!result.ok && (result.reason === 'transient' || result.reason === 'ocr-failed')) {
      const ocrVersion = imageAnalyzer()?.ocrVersion
      if (ocrVersion !== undefined) failedImage = { ...stored, ocr: { v: ocrVersion, state: 'failed' } }
    }
    this.ocrDeferred.delete(row.id)
    const tokenizer = await ensureTokenizer()
    await this.enqueue(() => {
      // Do not write to rows that disappeared or whose version advanced while reading (same as `writeBatch`; a row whose version advanced returns to the queue after re-indexing).
      if (this.store.versionOf(row.id) !== row.version) return
      if (failedImage !== null) {
        // Unreadable image: leave the term rows as they are and only mark `failed` (not retried for the same version).
        const image = failedImage
        this.store.atomically(() => this.store.setFsLossy(row.id, false, undefined, image))
        return
      }
      if (!result.ok || result.image === undefined) {
        // Unreadable or no longer in scope: remove from the queue (if a scan or the watcher rewrites the row, it comes back after starting again from classification).
        this.store.dequeueOcr(row.id)
        return
      }
      const image = result.image
      const digest = createHash('sha256').update(result.text).digest('hex')
      if (digest === row.content_hash) {
        // The sentence is unchanged (there was no text): only write the mark.
        this.store.atomically(() => this.store.setFsLossy(row.id, false, undefined, image))
        return
      }
      const prepared = this.prepareText(row.id, 'fs', result.text, tokenizer, image)
      this.writeBatch([], [{ ...prepared, version: row.version, lossy: false, image }])
    })
  }

  /** Starts one step of cleanup (does nothing if the previous step is running). */
  private runUpkeep(): void {
    if (this.shutdown || this.upkeepTask !== null || this.upkeep.finished()) return
    const task = this.upkeep
      .step()
      .catch((err: unknown) => log.warn('index.upkeep.failed', errorFields(err)))
      .finally(() => {
        if (this.upkeepTask === task) this.upkeepTask = null
      })
    this.upkeepTask = task
  }

  /**
   * Ticks the merge within a time budget (P3). **Do not call `optimize` as one statement** —
   * it rewrites the whole index into one segment, an unbounded job during which
   * search and the UI both stop. Calling `merge` many times in small amounts is the way FTS5 intends to be used.
   *
   * @returns true when the merge has run out of work.
   */
  private mergeWithin(budgetMs: number): boolean {
    if (this.shutdown) return true
    const until = Date.now() + budgetMs
    for (;;) {
      let work = 0
      try {
        work = this.store.mergeStep()
      } catch (err) {
        log.warn('index.merge.failed', errorFields(err))
        return true
      }
      if (work === 0) return true
      if (Date.now() >= until) return false
    }
  }

  /**
   * The build loop. `scopeOnly` is a run that only handles subtree requests (item 249) and then exits;
   * it starts without passing the idle check, so it does not touch the usual remainder.
   */
  private async runBuild(scopeOnly = false): Promise<void> {
    this.running = true
    this.paused = false
    this.stopped = false
    /** The state before starting, restored when a subtree-only run finishes (stays waiting if it was waiting). */
    const before = { state: this.status.state, message: this.status.message }
    let failed = false
    /** A subtree request left rows that wait for a classification retry: start a normal build afterwards so they are not forgotten. */
    let retryBuild = false
    /** The stage shown on the status bar (TODO 434). If `slow`, `message: 'slow'`. */
    let shownPace: Pace = scopeOnly ? 'full' : this.currentPace()
    this.setStatus({
      state: 'building',
      startedAt: this.status.startedAt ?? Date.now(),
      finishedAt: null,
      message: shownPace === 'slow' ? 'slow' : null
    })

    // Load the dictionary only the first time (about 0.2 s).
    const tokenizer = await ensureTokenizer()
    let processed = 0
    let reported = 0
    let reportedAt = Date.now()
    /** Yielded because of thermal state / Low Power Mode (P4 → TODO 434). Distinct from `paused` (stopped by the user). */
    let yielded = false

    try {
      for (;;) {
        if (this.stopped || this.paused) break
        // Subtree requests (item 249), if any, go first. While they run we do not yield on "user is active again".
        const scope = this.currentScope()
        let window: readonly number[] = []
        let rows: readonly DocumentRow[]
        /** The stage for this step (TODO 434). Subtree requests are what the user is waiting on, so full speed. */
        let pace: Pace = 'full'
        /** Clock that measures the CPU time of one step in the slow stage (only when `slow`). */
        let clock: StepClock | null = null
        if (scope !== null) {
          window = scope.ids.slice(scope.cursor, scope.cursor + BATCH_SIZE)
          const windowPending = this.store.pendingAmong(window)
          rows = this.dueRows(windowPending)
          // A row waiting for a classification retry is not built by this request: the normal build must take it once due (see `finally`).
          if (rows.length < windowPending.length) retryBuild = true
          if (rows.length === 0) {
            // All already built or gone. On to the next window.
            scope.cursor += window.length
            continue
          }
        } else {
          if (scopeOnly) break
          // **Look at the stage at batch boundaries** (P4 → TODO 434). Not in the middle of a document
          // — the extraction and write of one document cannot be split, so stopping there is pointless.
          pace = this.currentPace()
          if (pace === 'hold') {
            yielded = true
            break
          }
          if (pace !== shownPace) {
            shownPace = pace
            this.setStatus({ state: 'building', message: pace === 'slow' ? 'slow' : null })
          }
          if (pace === 'slow') clock = this.pacer.clock()
          const limit = pace === 'slow' ? SLOW_BATCH_SIZE : BATCH_SIZE
          this.pruneClassifyDeferred()
          const raw = this.store.pending(limit + this.classifyDeferred.size)
          rows = this.dueRows(raw)
          if (rows.length === 0) {
            if (raw.length === 0) break
            // Only images waiting for a classification retry are left (TODO 1234): wait until the first is due, then take it again.
            // Re-read the pending rows while waiting: a file that became pending meanwhile (or a row that came due) ends the wait,
            // and so does a stop, a subtree request, or the `hold` stage (the loop head then yields).
            for (;;) {
              await new Promise((resolve) => setTimeout(resolve, this.classifyPollMs))
              if (this.stopped || this.paused || this.shutdown || this.scopes.length > 0) break
              if (this.currentPace() === 'hold') break
              this.pruneClassifyDeferred()
              const fresh = this.store.pending(limit + this.classifyDeferred.size)
              if (fresh.length === 0 || this.dueRows(fresh).length > 0) break
            }
            continue
          }
          if (rows.length > limit) rows = rows.slice(0, limit)
        }
        const syncBudgetMs = pace === 'slow' ? SLOW_SYNC_BUDGET_MS : SYNC_BUDGET_MS

        // **Documents known to be out of scope without reading the body are dropped in a batch.**
        // Across the whole PC more documents are out of scope, and marking them one at a time costs more than the indexing.
        const skips: number[] = []
        const work: DocumentRow[] = []
        for (const row of rows) {
          const path = row.source === 'fs' ? this.store.pathOf(row.id) : null
          if (row.source === 'fs' && (path === null || !isExtractable(path))) skips.push(row.id)
          else work.push(row)
        }

        // **(1) Extraction and word segmentation. Not a single row is written here** (P2).
        // Extraction is async I/O, so `await` is fine — but inside the transaction in (2)
        // `await` is not possible (the iterator pitfall, 6.6.4).
        const prepared: PreparedDocument[] = []
        // Reuse the parent directory's realpath only within one write batch (`fsVerdict`).
        const dirs: RealDirCache = new Map()
        let syncMs = 0
        /** Rows deferred in this batch (a classification timeout). They stay `pending` and are taken again once due. */
        let deferredNow = 0
        for (const row of work) {
          if (this.stopped || this.paused) break
          const canonical = await this.readCanonical(row, dirs).catch((err: unknown) => {
            log.warn('index.ingest.failed', {
              id: row.id,
              source: row.source,
              ...errorFields(err)
            })
            return { failed: err instanceof Error ? err.name : 'error' } as const
          })
          if (canonical === DEFERRED) {
            deferredNow += 1
            continue
          }
          const startedSync = Date.now()
          prepared.push({ ...this.prepare(row, canonical, tokenizer), version: row.version })
          syncMs += Date.now() - startedSync
          // Budget for the synchronous section. Proceed to the write even before `BATCH_SIZE` documents have accumulated.
          if (syncMs >= syncBudgetMs) break
        }

        // **(2) Write N documents in one transaction** (P2).
        // FTS5 flushes and merges pending index data at every COMMIT and SAVEPOINT,
        // so the number of flushes is directly the stall time. P2 cuts it to 1/N.
        if (skips.length > 0 || prepared.length > 0) {
          await this.enqueue(() => {
            this.writeBatch(skips, prepared)
            // Tick the merge right after COMMIT (P3). In exchange for raising crisismerge,
            // we run a time-budgeted `merge` here so that work does not pile up. In the slow stage the budget is smaller,
            // and that CPU time also counts toward the step's rest (TODO 434).
            this.mergeWithin(pace === 'slow' ? SLOW_MERGE_BUDGET_MS : MERGE_BUDGET_MS)
          })
          processed += skips.length + prepared.length
        }
        if (scope !== null) {
          scope.built += skips.length + prepared.length
          // If the sync-section budget cut processing short, fetch the same window again
          // (the rows already processed are no longer pending, so they drop out).
          if (skips.length + prepared.length === rows.length) scope.cursor += window.length
        }
        if (prepared.length === 0 && skips.length === 0 && deferredNow === 0) break
        this.publish()
        // Log the measured progress (only counts and elapsed time; no body).
        const elapsed = Date.now() - reportedAt
        if (elapsed >= PROGRESS_LOG_MS) {
          log.info('index.build.progress', {
            docsPerSec: Math.round((processed - reported) / (elapsed / 1000)),
            processed,
            pending: this.status.pending
          })
          reported = processed
          reportedAt = Date.now()
        }
        this.pacer.note('build', pace, skips.length + prepared.length)
        // Return control to the event loop (so the UI and the session stream do not stall).
        await new Promise((resolve) => setImmediate(resolve))
        // **Slow stage: rest for (100/N − 1) times this step's CPU time** (TODO 434). Time spent long on
        // one indivisible document is also rested off in full, so that the average stays at N%. Wake up early if stopped, if the stage changed, or
        // if a subtree request arrives (RPCs such as search are answered during the rest too).
        if (clock !== null) {
          await this.pacer.rest(
            clock.restMs(),
            () =>
              this.stopped ||
              this.paused ||
              this.shutdown ||
              this.scopes.length > 0 ||
              this.currentPace() !== 'slow'
          )
        }
      }
      const remaining = this.store.counters().pending
      if (scopeOnly) {
        // A subtree-only run (item 249). Restore the overall state to what it was before starting — still waiting if it was waiting,
        // and the normal build starts continuing at the next idle.
        log.info('index.build.scoped', { processed, pending: remaining })
        if (remaining === 0) this.setStatus({ state: 'done', finishedAt: Date.now() })
        else this.setStatus({ state: before.state, message: before.message, finishedAt: Date.now() })
      } else if (yielded) {
        // Yielded because of thermal state / Low Power Mode (TODO 434). It was not stopped, so it is not `paused`
        // — when the heat subsides the wait timer starts continuing by itself.
        const reason = this.holdMessage()
        log.info('index.build.yielded', { processed, pending: remaining, reason })
        this.setStatus({ state: 'waiting', message: reason, finishedAt: Date.now() })
      } else {
        this.setStatus({
          state: this.paused ? 'paused' : remaining === 0 ? 'done' : 'paused',
          finishedAt: Date.now()
        })
        log.info('index.build.done', { ...this.store.counters() })
      }
    } catch (err) {
      failed = true
      log.error('index.build.failed', errorFields(err))
      this.setStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'index failed'
      })
    } finally {
      this.running = false
      this.pacer.idle('build')
      // If subtree requests (item 249) remain: if the reason for stopping was shutdown, pause or failure,
      // return the result there. Otherwise (a request that arrived after leaving the loop) continue with a subtree-only run.
      if (retryBuild && !this.shutdown && !this.stopped && !this.paused && !failed) {
        // `build` itself declines while the user stopped or the stage is `hold`; the idle tick covers those.
        void this.build().catch((err: unknown) => log.warn('index.build.retry-failed', errorFields(err)))
      }
      if (this.scopes.length > 0) {
        if (this.shutdown || this.stopped || this.paused || failed) {
          const settled = this.scopes
          this.scopes = []
          for (const scope of settled) this.settleScope(scope)
        } else {
          this.startScopedRun()
        }
      }
      // Even while the build is stopped, tick only the merge when idle (P3(b)).
      // Configurations with no check injected (existing tests) arm no timer.
      if (this.idlePolicy !== null && !this.shutdown) this.armTimer()
    }
  }

  /** Stops the index build in progress (the state stays in the DB, so the next time it continues from where it left off). */
  pause(): void {
    // Stopping while waiting (P4) is also accepted — it is the same "stop" from the user's point of view.
    if (!this.running && this.status.state !== 'waiting') return
    this.paused = true
    this.userPaused = true
    this.clearTimer()
    this.setStatus({ state: 'paused' })
  }

  /**
   * Resume. **`manual` is only when the user pressed "resume"** — only that clears `userPaused`;
   * calls that come automatically from the scan or the watcher (`onIndexable`) do not (after the user
   * stopped, it does not resume automatically). **The stage check itself is the same with or without `manual`** (TODO 448.
   * Previously `manual` skipped the check and ran at full speed all the way; it was aligned with the full scan at launch).
   */
  resume(options: { manual?: boolean } = {}): void {
    if (this.running || this.shutdown) return
    void this.build(options)
  }

  /** Waits until all queued writes finish. Does not shut down (for places where ordering is needed). */
  async idle(): Promise<void> {
    await this.queue
  }

  /**
   * Shutdown. Discards queued work and returns after waiting for what is running.
   * The build loop exits on seeing `stopped`, but writes state after exiting,
   * so without waiting here the loop would touch the DB the caller has closed.
   */
  async stop(): Promise<void> {
    this.shutdown = true
    this.stopped = true
    // **Stop the timer first** (12.9). If the wait timer is alive,
    // `build` / `mergeStep` may run after the DB is closed.
    this.clearTimer()
    await this.buildTask?.catch(() => {})
    // A cleanup (TODO 945 / 946) step may read bodies outside the column, so wait for it separately from the column.
    await this.upkeepTask
    await this.ocrTask
    await this.queue
  }

  // ---- Pipeline ----

  /**
   * Up to Normalize → Metadata → Chunk for one document (P2). **Writes no rows** —
   * `writeBatch` writes N of them together in one transaction.
   */
  private prepare(
    row: DocumentRow,
    canonical: Canonical | null | { readonly failed: string },
    tokenizer: Awaited<ReturnType<typeof ensureTokenizer>>
  ): PreparedDocument {
    const text = canonical === null || 'failed' in canonical ? canonical : canonical.text
    const image = canonical === null || 'failed' in canonical ? undefined : canonical.image
    const prepared = this.prepareText(row.id, row.source, text, tokenizer, image)
    if (row.source !== 'fs' || canonical === null || 'failed' in canonical) return prepared
    return {
      ...prepared,
      lossy: canonical.lossy === true,
      ...(canonical.pdfPages === undefined ? {} : { pdfPages: canonical.pdfPages }),
      ...(canonical.image === undefined ? {} : { image: canonical.image })
    }
  }

  /**
   * The body-only version of `prepare` (item 77). For conversations / transcripts only the body is at hand,
   * with no need to assemble a canonical row (`Canonical`), so this is called directly.
   * null means "no body = skipped", and `failed` is a read failure.
   */
  private prepareText(
    id: number,
    source: string,
    text: string | null | { readonly failed: string },
    tokenizer: Awaited<ReturnType<typeof ensureTokenizer>>,
    /** Image (TODO 998): make the term row a standalone chunk and repeat the high-confidence terms in the shadow text. */
    image?: StoredImageLabels
  ): PreparedDocument {
    if (text !== null && typeof text !== 'string') {
      return { id, outcome: { kind: 'fail', reason: text.failed } }
    }
    if (text === null) return { id, outcome: { kind: 'skip' } }
    try {
      const analyzed = this.analyze(text, tokenizer, image)
      return {
        id,
        outcome: {
          kind: 'index',
          chunks: analyzed.chunks,
          contentHash: analyzed.contentHash,
          lang: analyzed.lang
        }
      }
    } catch (err) {
      log.warn('index.ingest.failed', { id, source, ...errorFields(err) })
      return {
        id,
        outcome: { kind: 'fail', reason: err instanceof Error ? err.name : 'error' }
      }
    }
  }

  /**
   * **Writes N documents in one transaction** (P2).
   *
   * `IndexStore.atomically` does not nest (P5), so `replaceChunks` / `markSkipped` /
   * `markFailed` called inside do not issue a SAVEPOINT.
   * FTS5 flushes only once, at the outer COMMIT.
   */
  private writeBatch(skips: readonly number[], prepared: readonly PreparedDocument[]): void {
    let stale = 0
    this.store.atomically(() => {
      if (skips.length > 0) this.store.markSkippedBulk(skips)
      for (const item of prepared) {
        // Do not write to rows that disappeared or were updated after reading (TODO 922). Writing to a vanished row fails on the foreign key and
        // rolls back the whole batch, and marking a row whose version advanced as `indexed` would freeze the old body. The rest of the batch is written.
        if (item.version !== undefined && this.store.versionOf(item.id) !== item.version) {
          stale += 1
          continue
        }
        if (item.outcome.kind === 'index') {
          this.store.replaceChunks(item.id, item.outcome.chunks, {
            state: item.outcome.chunks.length === 0 ? 'skipped' : 'indexed',
            contentHash: item.outcome.contentHash,
            lang: item.outcome.lang
          })
          if (item.lossy !== undefined) this.store.setFsLossy(item.id, item.lossy, item.pdfPages, item.image)
        } else if (item.outcome.kind === 'skip') {
          this.store.markSkipped(item.id)
        } else {
          this.store.markFailed(item.id, item.outcome.reason)
        }
      }
    })
    if (stale > 0) log.info('index.build.stale', { count: stale })
  }

  /** Forgets deferral records of rows that are no longer pending, and records that were never revisited (their failure count must not carry over). */
  private pruneClassifyDeferred(): void {
    if (this.classifyDeferred.size === 0) return
    const now = Date.now()
    const pending = new Set(this.store.pendingAmong([...this.classifyDeferred.keys()]).map((row) => row.id))
    for (const [id, entry] of this.classifyDeferred) {
      if (!pending.has(id) || now - entry.until > DEFERRED_STALE_MS) this.classifyDeferred.delete(id)
    }
  }

  /** Drops the rows whose classification retry is not due yet (TODO 1234). They stay `pending`. */
  private dueRows(rows: readonly DocumentRow[]): readonly DocumentRow[] {
    if (this.classifyDeferred.size === 0) return rows
    const now = Date.now()
    return rows.filter((row) => (this.classifyDeferred.get(row.id)?.until ?? 0) <= now)
  }

  /**
   * Metadata → Chunk stage (synchronous). **Contains no writes**, so it can be done
   * ahead of time outside `writeBatch` (P2).
   *
   * Language detection selects the tokenizer (6.4.1). The document's language is kept as metadata, but
   * **word segmentation is chosen per chunk** — passing a large ASCII file with even
   * one Japanese character (such as minified JS with translations) wholesale through kuromoji
   * makes that the bottleneck (measured in Phase 3).
   */
  private analyze(
    text: string,
    tokenizer: Awaited<ReturnType<typeof ensureTokenizer>>,
    image?: StoredImageLabels
  ): { chunks: readonly ChunkInput[]; contentHash: string; lang: string | null } {
    const lang = detectLanguage(text)
    // Deduplicate stage: if the contents are the same, do not rebuild the index.
    const contentHash = createHash('sha256').update(text).digest('hex')
    // Chunk stage. Chunks hold only byte positions inside the canonical copy (6.5).
    // For images (TODO 998 stage 2) the term row (seq 0) becomes a standalone chunk and the high-confidence terms are repeated in its shadow text
    // (so they count in bm25 order; they are not put in the canonical sentence).
    const chunks: readonly Chunk[] = image === undefined ? chunkText(text) : chunkImageText(text)
    const boost = image === undefined ? '' : storedImageBoost(image)
    return {
      chunks: chunks.map((chunk) => ({
        // Append identifiers split at case boundaries (TODO 1152, `indexShadowText`).
        shadow:
          indexShadowText(chunk.text, detectLanguage(chunk.text), tokenizer) +
          (image !== undefined && chunk.seq === 0 && boost !== ''
            ? ` ${indexShadowText(boost, detectLanguage(boost), tokenizer)}`
            : ''),
        byteStart: chunk.byteStart,
        byteEnd: chunk.byteEnd,
        chars: chunk.chars
      })),
      contentHash,
      lang
    }
  }

  /**
   * How to read the canonical copy per source (6.5 canonical store).
   * **Writes no rows** — `writeBatch` does the marking in bulk (P2).
   * null means "no body = skipped". `failed` is a read failure that may be temporary (TODO 921):
   * `skipped` is never retried until the version changes, so cannot open / cannot read (`EMFILE` / `EIO`) / the parent's
   * realpath cannot be resolved all become `failed`. An exclusion (`drop`) is permanent, so it is `skipped`. It returns to `pending` when a scan or the watcher rewrites the row
   * (`IndexStore.upsertFsEntry`). An iCloud file not yet downloaded stays `skipped`, because its version (`:dataless`) changes when it is downloaded.
   */
  private async readCanonical(
    row: DocumentRow,
    dirs: RealDirCache | null = null
  ): Promise<Canonical | null | { readonly failed: string } | typeof DEFERRED> {
    if (row.source === 'fs') {
      const path = this.store.pathOf(row.id)
      if (path === null) return null
      const verdict = await this.fsVerdict(path, dirs)
      // Exclusion (a rule, or the parent's realpath is under an exclusion) is permanent, so skipped (wave 49 review: making it `failed` would repeat
      // pending → failed at every deep scan / watcher rewrite. The next full scan's `removeStale` drops the row).
      // Not being able to resolve the parent's realpath may be temporary, so failed (TODO 921).
      if (verdict === 'skip' || verdict === 'drop') return null
      if (verdict === 'unresolved') return { failed: 'unavailable' }
      // Image (TODO 998): if the saved labels match the current file, do not run Vision again (bump the version of the mapping table).
      const result = await extractFile(path, { image: storedImageLabelsOf(parseMetadata(row.metadata)) })
      if (!result.ok && result.reason === 'transient') {
        // A classification timeout (TODO 1234). The first one defers the row (still `pending`); a second in a row settles it as it always was (skipped).
        const fails = (this.classifyDeferred.get(row.id)?.fails ?? 0) + 1
        if (fails < OCR_MAX_TRANSIENT) {
          this.classifyDeferred.set(row.id, { fails, until: Date.now() + OCR_RETRY_DELAY_MS })
          log.info('index.classify.deferred', { id: row.id, fails })
          return DEFERRED
        }
      }
      this.classifyDeferred.delete(row.id)
      if (!result.ok) return result.reason === 'unreadable' ? { failed: 'unreadable' } : null
      return {
        text: result.text,
        uri: pathToUri(path),
        title: row.name,
        // **Do not pass the path to the renderer** (chapter 7). The context is only the parent directory name.
        context: parentFolderName(this.store, row.parent_id),
        contextCode: null,
        threadId: null,
        eventId: null,
        lossy: result.lossy,
        ...(result.pdfPages === undefined ? {} : { pdfPages: result.pdfPages }),
        ...(result.image === undefined ? {} : { image: result.image })
      }
    }

    if (row.source === 'conversation') {
      const eventId = conversationEventId(row.source_id)
      if (eventId === null) return null
      const event = await this.conversation.readEventText(eventId)
      if (event === null) return null
      return {
        text: event.text,
        uri: row.uri ?? '',
        title: row.name,
        context: (await this.conversation.threadTitle(event.threadId)) ?? '',
        contextCode: null,
        threadId: event.threadId,
        eventId
      }
    }

    if (row.source === 'transcript' && this.transcripts !== null) {
      const meta = parseMetadata(row.metadata)
      const fileId = typeof meta['fileId'] === 'string' ? meta['fileId'] : null
      const messageId = typeof meta['messageId'] === 'string' ? meta['messageId'] : null
      if (fileId === null || messageId === null) return null
      const text = await this.transcripts.readMessageText(
        fileId,
        messageId,
        transcriptLocatorOf(meta)
      )
      if (text === null) return null
      return {
        text,
        uri: row.uri ?? '',
        title: row.name,
        // Marker code (the renderer's dictionary `search.role.transcript` turns it into text, TODO 66).
        context: 'transcript',
        contextCode: 'transcript',
        threadId: null,
        eventId: null
      }
    }

    if (this.plugins !== null && row.source_id !== null) {
      // A plugin-derived document. The canonical copy is `plugin_documents` (6.5 / 12.9).
      const body = await this.plugins.read(row.source, row.source_id)
      if (body !== null) {
        return {
          text: body,
          uri: row.uri ?? '',
          title: row.name,
          context: row.source,
          contextCode: null,
          threadId: null,
          eventId: null
        }
      }
    }

    return null
  }

  // ---- Per-source ingestion (entry points from the Indexer) ----

  /**
   * Puts conversation events into the index (6.1). The canonical copy of the body is the single place `thread_events`,
   * and no duplicate is made here — chunks hold only positions (6.5).
   *
   * **The body is asked for only for `needsContent` documents** (item 76). Previously the body was asked
   * by reverse RPC one at a time before the check, so merely re-feeding already indexed events
   * cost a round trip per event and main's SQL.
   *
   * @returns How many were processed from the start. main advances the high-water mark up to here
   *   (`src/main/index/conversation-backfill.ts`). If shutdown stops it midway, it is smaller than the count.
   */
  async indexConversationEvents(
    events: readonly { id: string; threadId: string; title: string; ts: number }[]
  ): Promise<number> {
    if (events.length === 0 || this.shutdown) return 0
    let handled = 0
    try {
      await this.enqueue(async () => {
        const result = await this.ingestBatched(
          events,
          'conversation',
          (event, seenAt) => ({
            source: 'conversation',
            // Prefix the thread ID so that deleting a thread can remove its rows by prefix match.
            sourceId: `${event.threadId}:${event.id}`,
            uri: `thread://${event.threadId}/${event.id}`,
            name: event.title,
            kind: 'message',
            updatedAt: event.ts,
            // Conversation events are immutable, so the event id itself is enough as the version (the table in 6.3).
            version: event.id,
            exposure: 'ui+ai',
            metadata: { threadId: event.threadId },
            seenAt
          }),
          async (event) => (await this.conversation.readEventText(event.id))?.text ?? null
        )
        handled = result.handled
        this.publish()
      })
    } catch (err) {
      // The caller (SessionManager's flush) does not wait, so we catch and log here.
      log.warn('index.conversation.failed', errorFields(err))
    }
    return handled
  }

  /**
   * Tombstone for when a thread or log is deleted (6.2).
   * When the canonical copy (`thread_events`) is deleted, the index must be deleted too (6.5).
   */
  async removeThread(threadId: string): Promise<number> {
    let removed = 0
    await this.enqueue(() => {
      removed = this.store.removeBySourcePrefix('conversation', `${threadId}:`)
      log.info('index.conversation.removed', { threadId, removed })
    })
    return removed
  }

  /**
   * Drops messages that left the canonical copy because of the retention period (retention `days`, 4.3.1) (TODO 860). For each item,
   * deletes "documents of conversations whose thread `threadId` has `updated_at` (= the event's `ts`) before `before`".
   * The same boundary as the canonical copy's `DELETE ... WHERE ts < cutoff`. Safe to call any number of times (main sends it for all
   * retention threads at every launch).
   */
  async pruneConversations(items: readonly { threadId: string; before: number }[]): Promise<number> {
    if (items.length === 0) return 0
    let removed = 0
    await this.enqueue(() => {
      for (const item of items) {
        removed += this.store.removeConversationsBefore(item.threadId, item.before)
      }
      if (removed > 0) log.info('index.conversation.pruned', { threads: items.length, removed })
    })
    return removed
  }

  /**
   * Drops one transcript file from the index (item 111). Transcripts of conversations owned by an aios thread are not
   * indexed (their bodies are in aios's conversation index), so main's decision removes what was indexed earlier. **Waits**
   * (the caller processes them in order inside the ingestion column).
   */
  async removeTranscriptFile(fileId: string): Promise<number> {
    if (this.shutdown) return 0
    let removed = 0
    await this.enqueue(() => {
      removed = this.store.removeBySourcePrefix('transcript', `${fileId}#`)
      if (removed > 0) log.info('index.transcript.removed', { file: fileId, removed })
    })
    return removed
  }

  /**
   * List of transcript file ids currently in the index (item 241). main's launch-time ingestion uses it
   * to spot files "not in the list (= gone)" and `removeTranscriptFile` them.
   */
  async listTranscriptFileIds(): Promise<readonly string[]> {
    if (this.shutdown) return []
    let ids: readonly string[] = []
    await this.enqueue(() => {
      ids = this.store.transcriptFileIds()
    })
    return ids
  }

  /**
   * List of thread ids that currently have conversation documents in the index (TODO 863). main's launch-time cleanup uses it to spot threads
   * that are not alive (soft-deleted or physically deleted) and `removeThread` them.
   */
  async listConversationThreadIds(): Promise<readonly string[]> {
    if (this.shutdown) return []
    let ids: readonly string[] = []
    await this.enqueue(() => {
      ids = this.store.conversationThreadIds()
    })
    return ids
  }

  /** Follows the delete-all-conversation-logs setting (4.3.1). */
  async removeAllConversations(): Promise<number> {
    let removed = 0
    await this.enqueue(() => {
      removed = this.store.removeBySourcePrefix('conversation', '')
      log.info('index.conversation.removed.all', { removed })
    })
    return removed
  }

  /**
   * Ingests the backend transcript read-only (user decision, 12.7).
   * Only **the bodies of the user's messages and the answers** are ingested; `tool_result` is not
   * included (constraint 10). Timeline restore reads directly from the canonical copy.
   *
   * **In P1 this became "receive one file at a time"** (3.3). Only the Adapter knows the location and
   * format of transcripts (constraint 6), so main does everything up to opening the file and
   * turning it into bodies, and the index process receives the bodies.
   */
  async indexTranscriptMessages(
    file: TranscriptFile,
    messages: readonly TranscriptMessageInput[]
  ): Promise<number> {
    if (this.shutdown) return 0
    let added = 0
    await this.enqueue(async () => {
      const result = await this.ingestBatched(
        messages,
        'transcript',
        (message, seenAt) => ({
          source: 'transcript',
          sourceId: `${file.id}#${message.id}`,
          uri: `transcript://${file.id}/${message.id}`,
          name: transcriptName(message),
          kind: 'message',
          updatedAt: message.ts,
          version: message.id,
          exposure: 'ui+ai',
          metadata: transcriptMetadata(file, message),
          seenAt
        }),
        // The body main passed is the copy of the canonical one as is. No re-read is needed.
        (message) => Promise.resolve(message.text)
      )
      added = result.indexed
    })
    this.publish(true)
    return added
  }

  /**
   * Common part of conversation / transcript ingestion (items 76 / 77). **The same 3 stages as `runBuild`**:
   *
   * 1. Upsert `BATCH_SIZE` documents in one transaction and get `needsContent`.
   *    It only touches `documents`, so no FTS5 flush happens.
   * 2. Collect bodies only for the `needsContent` documents (async; for conversations, reverse RPC) and finish
   *    word segmentation. **Not a single row is written here** — `await` is not possible inside a transaction.
   *    If the sync section exceeds `SYNC_BUDGET_MS`, proceed to 3 even before reaching `BATCH_SIZE`.
   * 3. Write what was collected in one transaction with `writeBatch`, and tick the merge (P3).
   *
   * It used to be an upsert per document (autocommit) + `replaceChunks` (its own
   * transaction), two COMMITs each, so FTS5 flushed once per document.
   *
   * Used inside the caller's `enqueue` (it holds the queue while waiting for bodies — so that
   * `removeThread` cannot cut in midway and a chunk gets written to a deleted document).
   * Between batches, `yieldToEventLoop()` gives way to RPCs such as search.
   *
   * Once shutdown begins, it stops at a batch boundary. It does not stop in the state where only the upsert is done and
   * the body is not written, so no `pending` row is left (and if one were, `runBuild` would pick it up).
   */
  private async ingestBatched<T>(
    items: readonly T[],
    source: string,
    toDocument: (item: T, seenAt: number) => Parameters<IndexStore['upsertDocument']>[0],
    readText: (item: T) => Promise<string | null>
  ): Promise<{ handled: number; indexed: number }> {
    const tokenizer = await ensureTokenizer()
    let handled = 0
    let indexed = 0
    while (handled < items.length) {
      if (this.shutdown) break
      const slice = items.slice(handled, handled + BATCH_SIZE)

      // (1) upsert → check.
      const seenAt = Date.now()
      let rows: readonly UpsertedRow[] = []
      this.store.atomically(() => {
        rows = slice.map((item) => this.store.upsertDocument(toDocument(item, seenAt)))
      })

      // (2) Bodies and word segmentation. Nothing is written.
      const prepared: PreparedDocument[] = []
      let consumed = 0
      let syncMs = 0
      for (let k = 0; k < slice.length; k += 1) {
        consumed = k + 1
        const row = rows[k]
        const item = slice[k]
        if (row === undefined || item === undefined || !row.needsContent) continue
        const text = await readText(item).catch((err: unknown) => {
          log.warn('index.ingest.failed', { id: row.id, source, ...errorFields(err) })
          return { failed: err instanceof Error ? err.name : 'error' } as const
        })
        const startedSync = Date.now()
        prepared.push(this.prepareText(row.id, source, text, tokenizer))
        syncMs += Date.now() - startedSync
        // The rest is upserted again on the next round (nothing changes if the version is the same).
        if (syncMs >= SYNC_BUDGET_MS) break
      }

      // (3) N documents in one transaction.
      if (prepared.length > 0) {
        this.writeBatch([], prepared)
        this.mergeWithin(MERGE_BUDGET_MS)
        for (const item of prepared) if (item.outcome.kind === 'index') indexed += 1
      }
      handled += consumed
      if (handled < items.length) await yieldToEventLoop()
    }
    return { handled, indexed }
  }

  /**
   * Ingestion from plugins (the `index` capability in 7.7).
   *
   * **Do not write to `documents` / `chunks` / `chunk_fts` by another route** (the single writer in 6.2).
   * The Broker has already checked the namespace; here the write to the canonical copy and
   * the indexing happen on the single queue.
   */
  async putPluginDocument(document: PluginDocumentInput): Promise<void> {
    if (this.plugins === null) throw new Error('plugin index not configured')
    await this.enqueue(async () => {
      const tokenizer = await ensureTokenizer()
      // **main has written the canonical copy first** (3.4). The index follows the canonical copy (6.5).
      const updatedAt = document.updatedAt ?? Date.now()
      // Word segmentation is done first, outside the transaction (P2). The body is at hand and
      // it is always re-indexed regardless of version (as before), so there is no need to wait for the upsert's check.
      const analyzed = this.analyze(document.body, tokenizer)
      // **Upsert and chunks in one transaction** (item 77). Previously the upsert's
      // autocommit and `replaceChunks` made 2 COMMITs.
      this.store.atomically(() => {
        const row = this.store.upsertDocument({
          source: document.source,
          sourceId: document.sourceId,
          uri: document.uri,
          name: document.title,
          kind: 'message',
          updatedAt,
          // The version is update time + body length. If unchanged, the body is not re-read (Deduplicate in 6.2).
          version: `${updatedAt}:${document.body.length}`,
          exposure: 'ui+ai',
          metadata: { pluginSource: document.source },
          seenAt: Date.now()
        })
        this.store.replaceChunks(row.id, analyzed.chunks, {
          state: analyzed.chunks.length === 0 ? 'skipped' : 'indexed',
          contentHash: analyzed.contentHash,
          lang: analyzed.lang
        })
      })
      this.mergeWithin(MERGE_BUDGET_MS)
      this.publish()
    })
  }

  /**
   * Deletion from a plugin (tombstone). Removes the index entry. main deletes the canonical copy (`plugin_documents`)
   * right after (3.4).
   */
  async removePluginDocument(source: string, sourceId: string): Promise<void> {
    if (this.plugins === null) throw new Error('plugin index not configured')
    await this.enqueue(() => {
      const row = this.store.getBySourceId(source, sourceId)
      if (row !== null) this.store.removeDocument(row.id)
    })
  }

  /**
   * TODO 1237: uninstalling an extension. Deletes all index documents in that extension's namespace (`indexSourceOwnedBy`).
   * Touches neither a source that has disappeared from the declaration, nor other extensions' namespaces, nor the built-in sources (`fs` / `conversation` / `transcript`).
   * main deletes the canonical copy (`plugin_documents`) right after (3.4). Returns the number deleted. **This is the only writer to the index** (6.2).
   */
  async removePluginDocumentsOf(pluginId: string): Promise<number> {
    if (this.plugins === null) throw new Error('plugin index not configured')
    // Do not trust the RPC argument (wave 87 code-review): if it is not shaped like a plugin id, then even if a built-in source (`fs` etc., which matches the first term of
    // `indexSourceOwnedBy` where `<id>` itself becomes the source) is passed in, not all of it is deleted.
    if (typeof pluginId !== 'string' || pluginId.length > 64 || !PLUGIN_ID_RE.test(pluginId) || BUILTIN_INDEX_SOURCES.has(pluginId)) {
      throw new Error('invalid plugin id')
    }
    let removed = 0
    await this.enqueue(() => {
      for (const source of this.store.pluginSourcesOf(pluginId)) {
        if (!indexSourceOwnedBy(pluginId, source)) continue
        removed += this.store.removeAllOfSource(source)
      }
      if (removed > 0) this.publish()
    })
    return removed
  }

  // ---- Search (6.4) ----

  /**
   * Whether the query sequence number (P6) is stale. With `claim`, when it is not stale it records itself as the latest (once, at the entry point).
   * A query without a number (gateway) never goes stale.
   */
  private isStale(key: string, seq: number | undefined, claim = false): boolean {
    if (seq === undefined) return false
    const latest = this.latestSeq.get(key)
    if (latest !== undefined && seq < latest) {
      // TODO 551: losing by a large margin at the entry point is not typing overtaking but a ledger mix-up (the pre-497 "reopening the
      // window restarts numbers at 1"). Then search returns no results at all. Logged once per key (no body or search terms are written).
      if (claim && latest - seq >= STALE_GAP_WARN && !this.staleGapWarned.has(key)) {
        this.staleGapWarned.add(key)
        log.warn('index.search.staleGap', { key, seq, latest })
      }
      return true
    }
    if (claim) {
      this.latestSeq.set(key, seq)
      this.staleGapWarned.delete(key)
    }
    return false
  }

  /**
   * A window (renderer webContents) was closed / reloaded (TODO 497). Clears that window's query sequence ledger —
   * a reloaded renderer counts numbers from 1 again, so if kept, its first few queries would be discarded as old numbers.
   */
  forgetOrigin(origin: number): void {
    for (const scope of SEQ_LANES) {
      this.latestSeq.delete(seqKeyOf(scope, origin))
      this.staleGapWarned.delete(seqKeyOf(scope, origin))
    }
  }

  /** Size of the ledger (for tests). */
  seqLedgerSize(): number {
    return this.latestSeq.size
  }

  async search(
    rawQuery: string,
    scope: SearchScope,
    options: {
      limit?: number
      forAgent?: boolean
      sources?: readonly string[]
      /** Query sequence number of UI incremental search (P6). The gateway does not pass it. */
      seq?: number
      /** The window the query came from (the renderer's webContents id, TODO 497). Numbers are compared within this window. */
      origin?: number
      /**
       * Absolute path of the current working folder (item 100). **Validated** (main's `assertAllowed` and
       * the index process's `FsIndexer.cwdPathOf`). Only affects File search; when passed, the results are split into
       * two sections, "inside cwd" and "everything else". `cwdUri` is the original text to return for the heading.
       */
      cwd?: string
      cwdUri?: string
      /**
       * Threads for the conversation search's "this working folder" section (TODO 1096). The ids of threads whose cwd is (under) that folder,
       * which main looks up from the thread table (the index does not hold a thread's cwd). When passed together with `cwdUri`, the conversation search results are split into
       * two sections, "messages of these threads" and "everything else (including transcripts)". An empty array means "none" (the section has 0 hits).
       */
      threadIds?: readonly string[]
      /**
       * Absolute path of the Search screen's scope (TODO 437). **Validated** (main's `assertAllowed` and the index process's
       * `FsIndexer.cwdPathOf`). Only affects File search; when passed, returns **only the inside of that subtree** as a single section
       * (no `cwd` section is made). If the subtree is not in the index, 0 hits.
       */
      scope?: string
    } = {}
  ): Promise<SearchResponse> {
    const started = Date.now()
    // **If a newer query has arrived, do not run a single statement** (P6).
    // better-sqlite3 has no interrupt, so **a statement already running cannot be stopped**.
    // What is dropped here is only "what was waiting in front of the queue", but that is enough to stop
    // input that got past the 150 ms debounce from piling up one character at a time.
    const seqKey = seqKeyOf(scope, options.origin)
    if (this.isStale(seqKey, options.seq, true)) {
      return { hits: [], total: 0, truncated: false, tookMs: 0, stale: true }
    }
    // File-name filters (TODO 813): `ext:md` / `name:22719` / `*.md`. UI search only (the gateway looks up
    // the terms as they are). File search applies them in SQL to `documents.ext` / `name_folded`, and conversation search
    // (messages have no file) turns them back into body terms and requires that they "appear in the message".
    // "a photo of a dog" (TODO 998): only when File search can analyze images, drop "photo / image" from the terms and narrow to images.
    const parsed =
      options.forAgent === true
        ? null
        : parseQueryFilter(rawQuery, { images: scope !== 'conversation' && imageAvailable() })
    const filtered = parsed !== null && !isPlainQuery(parsed)
    const query = parsed === null || !filtered ? rawQuery : scope === 'conversation' ? asTextTerms(parsed) : parsed.text
    const fileFilter =
      filtered && scope !== 'conversation'
        ? {
            // If an extension was written (`ext:png <dog photo>`), that wins.
            exts: parsed.exts.length === 0 && parsed.images ? IMAGE_EXTENSIONS : parsed.exts,
            likes: parsed.names.map(likeContains)
          }
        : undefined
    // Too-short queries do not hit the index (P8 / item 41). Not applied to the gateway.
    // Placed before the dictionary load (`ensureTokenizer`): so the first character
    // does not trigger a 1.3 s load.
    // When there is only a filter and no body terms (`ext:md` / `*.pdf` / `name:22719`), FTS is not queried and
    // documents are fetched newest first by the filter. The lower bound is judged by the value of `name:` (no lower bound for `ext:` alone).
    const filterOnly = fileFilter !== undefined && query.trim() === ''
    if (options.forAgent !== true) {
      const missingChars = missingQueryChars(
        filterOnly && parsed !== null && parsed.exts.length === 0 ? parsed.names.join(' ') : query
      )
      if (missingChars > 0) {
        return { hits: [], total: 0, truncated: false, tookMs: 0, tooShort: true, missingChars }
      }
    }
    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 200)
    const tokenizer = await ensureTokenizer()
    // It may have been overtaken while waiting for the dictionary load (about 1.3 s the first time).
    if (this.isStale(seqKey, options.seq)) {
      return { hits: [], total: 0, truncated: false, tookMs: Date.now() - started, stale: true }
    }
    // Search from the gateway does not use prefix match (only the UI's incremental search).
    const match = filterOnly ? null : buildMatchQuery(query, tokenizer, options.forAgent !== true)
    if (match === null && !filterOnly) return { hits: [], total: 0, truncated: false, tookMs: 0 }

    const exposures: readonly Exposure[] = options.forAgent === true ? AGENT_EXPOSURES : UI_EXPOSURES
    // File search is "everything except conversations". **Plugin-derived documents are included here too** (6.1).
    const sources: { include?: readonly string[]; exclude?: readonly string[] } =
      options.sources !== undefined
        ? { include: options.sources }
        : scope === 'conversation'
          ? { include: CONVERSATION_SOURCES }
          : { exclude: CONVERSATION_SOURCES }

    // Fetch extra chunk-level hits and fold them to document level (6.4).
    // **Set a lower bound**: when a small count is requested, if the top chunks are
    // all from the same document, the folded result becomes a single hit (hit on a real machine).
    // smart case (TODO 291): if the query has a term with capital letters, the FTS5 candidates (which fold case) are
    // re-checked against the canonical copy. Fetch extra candidates to cover the ones dropped (with a cap). It applies to the gateway as well.
    const caseFilter = CaseFilter.of(query)
    const fetch =
      caseFilter === null
        ? Math.max(limit * 5, 200)
        : Math.min(Math.max(limit * 20, CASE_FETCH_MIN), CASE_FETCH_MAX)
    // Scope (TODO 437): run only the one query narrowed to the subtree. Not applied to conversation search or the gateway.
    if (scope === 'files' && options.scope !== undefined && options.forAgent !== true) {
      const scoped = directoryTreeOf(this.store).subtree(options.scope)
      if (scoped === null) return { hits: [], total: 0, truncated: false, tookMs: Date.now() - started }
      let scopedRows: readonly SearchRow[]
      try {
        scopedRows = this.store.search(match, sources, exposures, fetch, scoped.json, fileFilter)
      } catch (err) {
        log.warn('index.search.rejected', errorFields(err))
        return { hits: [], total: 0, truncated: false, tookMs: Date.now() - started }
      }
      const inside = await this.collectHits(
        scopedRows,
        limit,
        query,
        caseFilter,
        scopedRows.length >= fetch
      )
      return {
        hits: inside.hits,
        total: inside.total,
        truncated: inside.truncated,
        ...(caseFilter === null ? {} : { caseSensitive: true }),
        tookMs: Date.now() - started
      }
    }
    // The cwd subtree (item 100). File search only. Not applied to the gateway.
    const subtree =
      scope === 'files' && options.cwd !== undefined && options.forAgent !== true
        ? directoryTreeOf(this.store).subtree(options.cwd)
        : null
    // The cwd section of conversation search (TODO 1096): the set of threads whose cwd is (under) that folder. Not applied to the gateway.
    const cwdThreads =
      scope === 'conversation' &&
      options.threadIds !== undefined &&
      options.cwdUri !== undefined &&
      options.sources === undefined &&
      options.forAgent !== true
        ? new Set(options.threadIds)
        : null
    // The JSON array passed to the narrowed query (after dropping duplicates with a Set). If there are 0 matches, null (no SQL is run).
    const cwdThreadsJson = cwdThreads !== null && cwdThreads.size > 0 ? JSON.stringify([...cwdThreads]) : null

    let cwdRows: readonly SearchRow[] | null = null
    let rows: readonly SearchRow[]
    try {
      const narrowed =
        subtree !== null
          ? { scope: subtree.json }
          : cwdThreadsJson !== null
            ? { threads: cwdThreadsJson }
            : null
      if (narrowed !== null) {
        // **Run the cwd-narrowed query first, separately from the global one** (6.6.7). Combining them into one
        // (taking the top per section with a window function) would sort every MATCH row,
        // and one synchronous call would take longer than the single global query. Split, each is at most the single global query,
        // and we can return to the event loop in between (so list and search RPCs arriving meanwhile are not kept waiting).
        cwdRows =
          'scope' in narrowed
            ? this.store.search(match, sources, exposures, fetch, narrowed.scope, fileFilter)
            : this.store.search(match, sources, exposures, fetch, undefined, fileFilter, narrowed.threads)
        await yieldToEventLoop()
        if (this.isStale(seqKey, options.seq)) {
          return { hits: [], total: 0, truncated: false, tookMs: Date.now() - started, stale: true }
        }
      } else if (cwdThreads !== null) {
        // No matching threads: the section has 0 hits (show the "not found here" line of item 292). No SQL is run.
        cwdRows = []
      }
      // The global query later excludes the ones inside cwd, so fetch that many extra.
      rows = this.store.search(match, sources, exposures, fetch + (cwdRows?.length ?? 0), undefined, fileFilter)
    } catch (err) {
      // A FTS5 syntax error (such as a symbol typed midway) is treated as an empty result.
      log.warn('index.search.rejected', errorFields(err))
      return { hits: [], total: 0, truncated: false, tookMs: Date.now() - started }
    }

    const outside =
      subtree !== null
        ? rows.filter((row) => row.parent_id === null || !subtree.ids.has(row.parent_id))
        : cwdThreads !== null
          ? rows.filter((row) => {
              const threadId = conversationThreadOf(row)
              return threadId === null || !cwdThreads.has(threadId)
            })
          : rows
    const global = await this.collectHits(
      outside,
      limit,
      query,
      caseFilter,
      rows.length >= fetch + (cwdRows?.length ?? 0),
      // Gateway search applies redaction to the snippet (TODO 855).
      options.forAgent === true
    )
    const inside =
      cwdRows === null || options.cwdUri === undefined
        ? null
        : await this.collectHits(cwdRows, limit, query, caseFilter, cwdRows.length >= fetch)

    return {
      hits: global.hits,
      total: global.total,
      truncated: global.truncated,
      ...(inside === null || options.cwdUri === undefined
        ? {}
        : { cwd: { uri: options.cwdUri, ...inside } }),
      ...(caseFilter === null ? {} : { caseSensitive: true }),
      tookMs: Date.now() - started
    }
  }

  /**
   * In-thread search (TODO 496, ARCHITECTURE 6.1.1). Narrows the same index and the same matching as conversation search (`buildMatchQuery`, prefix match,
   * minimum length, smart case, NFKC) to one thread and returns the ids of the matching messages, oldest first. No snippets are made.
   * The query sequence number (P6) is a separate lane from conversation search (⌘K) and is counted per window (`origin`) (TODO 497) — so
   * typing in both search boxes at once, or in different windows, never discards each other.
   */
  async searchThread(
    query: string,
    threadId: string,
    options: { seq?: number; origin?: number } = {}
  ): Promise<ThreadSearchResponse> {
    const seqKey = seqKeyOf('thread', options.origin)
    if (this.isStale(seqKey, options.seq, true)) return { eventIds: [], truncated: false, stale: true }
    if (missingQueryChars(query) > 0) return { eventIds: [], truncated: false, tooShort: true }
    if (threadId === '') return { eventIds: [], truncated: false }
    const tokenizer = await ensureTokenizer()
    if (this.isStale(seqKey, options.seq)) {
      return { eventIds: [], truncated: false, stale: true }
    }
    const match = buildMatchQuery(query, tokenizer, true)
    if (match === null) return { eventIds: [], truncated: false }
    let rows: readonly { readonly document_id: number; readonly source_id: string }[]
    try {
      rows = this.store.searchThreadEvents(match, threadId, UI_EXPOSURES, THREAD_SEARCH_LIMIT + 1)
    } catch (err) {
      // A FTS5 syntax error (such as a symbol typed midway) is treated as an empty result.
      log.warn('index.search.rejected', errorFields(err))
      return { eventIds: [], truncated: false }
    }
    let truncated = rows.length > THREAD_SEARCH_LIMIT
    if (truncated) rows = rows.slice(0, THREAD_SEARCH_LIMIT)
    const caseFilter = CaseFilter.of(query)
    // Drop from the hits the messages no longer in the canonical copy (leftovers whose "delete" notice never arrived) (TODO 863). When it is not smart case,
    // bodies are not read, so only the ids are confirmed in one round trip. Leftovers found are dropped from the index, as in conversation search.
    const live =
      caseFilter === null && this.conversation.liveEventIds !== undefined
        ? await this.liveThreadEvents(rows)
        : null
    if (this.isStale(seqKey, options.seq)) return { eventIds: [], truncated: false, stale: true }
    const eventIds: string[] = []
    let reads = 0
    for (const row of rows) {
      const eventId = conversationEventId(row.source_id)
      if (eventId === null) continue
      if (live !== null && !live.has(eventId)) {
        this.dropOrphanConversation(row.document_id)
        continue
      }
      if (caseFilter !== null) {
        // smart case: whether the canonical copy of the message has the needle with its capitalization as is (conversation search checks the chunk's range; this checks the whole message).
        if (reads >= CASE_MAX_READS) {
          truncated = true
          break
        }
        reads += 1
        const event = await this.conversation.readEventText(eventId)
        if (event === null) {
          // Unreadable does not mean gone (even a live message gives null if `indexableText` is null). Decide by whether the canonical copy exists.
          if (await this.isGoneEvent(eventId)) this.dropOrphanConversation(row.document_id)
          continue
        }
        if (!caseFilter.accepts(event.text)) continue
      }
      eventIds.push(eventId)
    }
    return { eventIds, truncated, ...(caseFilter === null ? {} : { caseSensitive: true }) }
  }

  /**
   * Folds chunk-level rows to document level and makes the top `limit` into hits (6.4).
   *
   * When there is a `caseFilter` (smart case, TODO 291), it looks at chunks in order of quality and re-checks the capitalized terms against **that chunk's
   * canonical range**, and makes the first chunk that passes the document's representative
   * (even if the best chunk differs in case, another chunk of the same document is picked up if it matches).
   * Stops when it reaches `limit` or the reads reach `CASE_MAX_READS`. `total` is
   * the number that passed the re-check, so if stopped / the candidates were not exhausted (`more`), it is `truncated`.
   */
  private async collectHits(
    rows: readonly SearchRow[],
    limit: number,
    query: string,
    caseFilter: CaseFilter | null = null,
    more = false,
    redact = false
  ): Promise<{ hits: SearchHit[]; total: number; truncated: boolean }> {
    if (caseFilter !== null) return this.collectCaseHits(rows, limit, query, caseFilter, more, redact)
    const best = new Map<number, SearchRow>()
    for (const row of rows) {
      const current = best.get(row.document_id)
      if (current === undefined || row.score < current.score) best.set(row.document_id, row)
    }

    // Candidates with no canonical copy (deleted files, messages removed by retention or deletion) are discarded, and **the gap is filled from the candidates below**
    // (TODO 860). Previously the top `limit` were cut first and then discarded, so when leftovers got into the top ranks
    // that many real hits were missing, and `total` also included the leftovers. So that re-reading does not go on without end, we stop when the discarded count
    // reaches `max(limit, GONE_MAX_READS)` (`truncated`). Conversation leftovers
    // (`dropOrphanConversation`) and fs leftovers (excluded, symlink, or gone files drop the whole document; kinds that
    // carry no body drop only the chunk — `dropFsDebris`, wave 42 code-review bundle X) are dropped from the index as soon as found, so
    // the same leftover never stops it repeatedly. Transcripts and plugin canonical copies that cannot be read may be temporary, so they are not dropped
    // (they do count in the discarded count).
    const hits: SearchHit[] = []
    const goneCap = Math.max(limit, GONE_MAX_READS)
    const dirs: RealDirCache = new Map()
    const ocrBudget: SearchOcrBudget = { images: 0, spentMs: 0 }
    let gone = 0
    for (const row of [...best.values()].sort((a, b) => a.score - b.score)) {
      if (hits.length >= limit || gone >= goneCap) break
      const hit = await this.toHit(row, query, null, null, redact, dirs, ocrBudget)
      if (hit === null) gone += 1
      else hits.push(hit)
    }
    const total = best.size - gone
    return { hits, total, truncated: total > hits.length }
  }

  private async collectCaseHits(
    rows: readonly SearchRow[],
    limit: number,
    query: string,
    caseFilter: CaseFilter,
    more: boolean,
    redact: boolean
  ): Promise<{ hits: SearchHit[]; total: number; truncated: boolean }> {
    const sorted = [...rows].sort((a, b) => a.score - b.score)
    const accepted = new Set<number>()
    const canonicals = new Map<number, Canonical | null>()
    const hits: SearchHit[] = []
    const dirs: RealDirCache = new Map()
    const ocrBudget: SearchOcrBudget = { images: 0, spentMs: 0 }
    let reads = 0
    let stoppedEarly = false
    for (let i = 0; i < sorted.length; i += 1) {
      const row = sorted[i]
      if (row === undefined || accepted.has(row.document_id)) continue
      if (hits.length >= limit || reads >= CASE_MAX_READS) {
        stoppedEarly = true
        break
      }
      reads += 1
      const hit = await this.toHit(row, query, caseFilter, canonicals, redact, dirs, ocrBudget)
      if (hit === null) continue
      accepted.add(row.document_id)
      hits.push(hit)
    }
    return { hits, total: hits.length, truncated: stoppedEarly || more }
  }

  /**
   * Search row → hit for display. **The snippet is cut from the canonical copy** (6.5).
   *
   * For fs, only **the byte range of the matching chunk** is read. Re-reading the whole document
   * would open 50 whole files in one search. That is exactly why chunks
   * hold positions.
   */
  private async toHit(
    row: SearchRow,
    query: string,
    caseFilter: CaseFilter | null = null,
    canonicals: Map<number, Canonical | null> | null = null,
    /** Gateway search (TODO 855). Apply redaction to the excerpt before cutting the snippet (so a secret is not split at the boundary). */
    redact = false,
    /** Parent-directory realpaths reused only during one search (`fsVerdict`). */
    dirs: RealDirCache | null = null,
    /** Cap on the number of images and the time for re-running OCR to get the excerpt of an OCR text match (within one search; TODO 998 fix Y). */
    ocrBudget: SearchOcrBudget | null = null
  ): Promise<SearchHit | null> {
    const document = this.store.getDocument(row.document_id)
    if (document === null) return null

    let excerpt: string
    /** The canonical copy before and after the excerpt (`redactSlice`), needed only for gateway search. */
    let around: RedactionContext | null = null
    let uri: string
    let title: string
    let context: string
    let contextCode: SearchRoleCode | null = null
    let threadId: string | null = null
    let eventId: string | null = null
    /** PDF: the page of the matching chunk (1-based, TODO 1009 stage 2). */
    let page: number | null = null
    /** The excerpt could not be made (the OCR re-run exceeded the cap, or failed temporarily). Returned with only the file name and thumbnail. */
    let noExcerpt = false

    if (document.source === 'fs') {
      const path = this.store.pathOf(document.id)
      if (path === null) return null
      const verdict = await this.fsVerdict(path, dirs)
      if (verdict !== 'ok') {
        this.dropFsDebris(document.id, verdict === 'skip' ? 'skip' : 'drop')
        return null
      }
      try {
        if (row.byte_end <= row.byte_start) {
          // A row of a filter-only search (`*.pdf` / `ext:docx`) has an empty range (no excerpt). The body is not read —
          // running PDF / Office extraction for each hit would exceed the search cap at 50 hits (TODO 1127).
          // The canonical copy was already confirmed by `fsVerdict` above.
          excerpt = ''
        } else if (isLossyFsRow(document) || isDerivedText(path)) {
          // Files whose decoding does not round-trip (Shift_JIS etc., TODO 925). The chunk ranges are counted in
          // bytes of the decoded string, so reading raw bytes by that range would misalign positions. As with `getChunk`, cut from the decoded text.
          // Office documents (TODO 997) are the same: the range is a position inside the extracted text, so re-extract and cut
          // (`extractFile` keeps the result briefly, so the zip is not unpacked again for the following chunks of the same document).
          const isImage = isImagePath(path)
          const image = isImage ? storedImageLabelsOf(parseMetadata(document.metadata)) : null
          const analyzer = image === null ? null : imageAnalyzer()
          let canonical: Canonical | null | undefined
          if (image !== null && analyzer !== null && row.byte_start === 0 && image.v === analyzer.version && image.backend === analyzer.backend) {
            // A hit on an image's term row (seq 0) builds the excerpt from the saved labels — it runs neither Vision nor OCR nor loads the image
            // (so an already OCR-ed image does not redo OCR each time it matches a search. TODO 998 fix Y).
            canonical = { ...EMPTY_CANONICAL, text: storedImageText(image) }
          } else {
            canonical = canonicals?.get(document.id)
            if (canonical === undefined) {
              if (isImage && ocrBudget !== null && (ocrBudget.images >= SEARCH_OCR_MAX_IMAGES || ocrBudget.spentMs >= SEARCH_OCR_BUDGET_MS)) {
                // OCR text matches have a cap on the number of images and the time to re-run in one search. Beyond it, no excerpt.
                canonical = NO_EXCERPT
              } else {
                const startedAt = Date.now()
                const result = await extractFile(path, { image, ocr: 'reread' })
                if (isImage && ocrBudget !== null) {
                  ocrBudget.images += 1
                  ocrBudget.spentMs += Date.now() - startedAt
                }
                canonical =
                  !result.ok && result.reason === 'transient' && isImage
                    ? NO_EXCERPT
                    : result.ok && this.derivedMatches(document.id, path, result.text)
                      ? { ...EMPTY_CANONICAL, text: result.text }
                      : null
              }
              canonicals?.set(document.id, canonical)
            }
          }
          if (canonical === null) return null
          if (canonical === NO_EXCERPT) noExcerpt = true
          const from = byteToCharApprox(canonical.text, row.byte_start)
          const to = byteToCharApprox(canonical.text, row.byte_end)
          excerpt = canonical.text.slice(from, to)
          if (redact) around = charRedactionContext(canonical.text, from, to)
          // A chunk may span several pages. Look at where in the chunk the matched term is, and use the page at that byte position.
          const starts = pdfPagesOf(document)
          if (starts.length > 0) {
            const at = firstMatchOffset(excerpt, query)
            page = pdfPageOfByte(starts, row.byte_start + Buffer.byteLength(excerpt.slice(0, at), 'utf8'))
          }
        } else {
          const range = await readUtf8Range(path, row.byte_start, row.byte_end)
          excerpt = range.text
          if (redact) around = await fsRedactionContext(path, range)
        }
      } catch (err) {
        // A file that disappeared between search and display, or was replaced by a symlink (`O_NOFOLLOW`). Drop it from the index too.
        if (isGoneError(err)) this.dropFsDebris(document.id, 'drop')
        return null
      }
      uri = pathToUri(path)
      title = document.name
      context = parentFolderName(this.store, document.parent_id)
    } else {
      // The smart case re-check looks at other chunks of the same document in a row, so reuse the canonical copy.
      let canonical = canonicals?.get(document.id)
      if (canonical === undefined) {
        canonical = await this.readCanonicalNonFs(document)
        canonicals?.set(document.id, canonical)
      }
      if (canonical === null) return null
      const from = byteToCharApprox(canonical.text, row.byte_start)
      const to = byteToCharApprox(canonical.text, row.byte_end)
      excerpt = canonical.text.slice(from, to)
      if (redact) around = charRedactionContext(canonical.text, from, to)
      uri = canonical.uri
      title = canonical.title
      context = canonical.context
      contextCode = canonical.contextCode
      threadId = canonical.threadId
      eventId = canonical.eventId
    }

    // smart case (TODO 291): whether the capitalized term is in this chunk's canonical copy with its capitalization as is.
    // An image whose excerpt could not be made (`noExcerpt`) cannot be checked, so return it as is.
    if (caseFilter !== null && !noExcerpt && !caseFilter.accepts(excerpt)) return null

    return {
      id: String(document.id),
      uri,
      // For the gateway, apply the redaction mask to the heading too (TODO 1123. Even an old saved heading in plaintext is not shown).
      title: redact ? redactText(title).text : title,
      source: document.source,
      kind: document.kind,
      updatedAt: document.updated_at,
      // Smaller is better for BM25. Pass it to the UI as a value where larger is better.
      score: -row.score,
      snippet: makeSnippet(redact ? redactSlice(excerpt, around ?? NO_CONTEXT).text : excerpt, query),
      threadId,
      eventId,
      context,
      contextCode,
      ...(page === null ? {} : { page })
    }
  }

  /** Full text and metadata of the canonical copy (used to display search results and for gateway fetches). */
  private async canonicalOf(row: DocumentRow): Promise<Canonical | null> {
    if (row.source === 'fs') {
      const path = this.store.pathOf(row.id)
      if (path === null) return null
      if ((await this.fsVerdict(path)) !== 'ok') return null
      const result = await extractFile(path, { image: storedImageLabelsOf(parseMetadata(row.metadata)), ocr: 'reread' })
      if (!result.ok) return null
      if (!this.derivedMatches(row.id, path, result.text)) return null
      return {
        text: result.text,
        uri: pathToUri(path),
        title: row.name,
        context: parentFolderName(this.store, row.parent_id),
        contextCode: null,
        threadId: null,
        eventId: null
      }
    }
    return this.readCanonicalNonFs(row)
  }

  /**
   * Of the in-thread search hits, the ids of messages still in the canonical copy (TODO 863). If we could not ask, null (return without confirming —
   * as before. The search itself does not fail).
   */
  private async liveThreadEvents(
    rows: readonly { readonly source_id: string }[]
  ): Promise<ReadonlySet<string> | null> {
    const check = this.conversation.liveEventIds
    if (check === undefined) return null
    const ids: string[] = []
    for (const row of rows) {
      const eventId = conversationEventId(row.source_id)
      if (eventId !== null) ids.push(eventId)
    }
    if (ids.length === 0) return new Set()
    try {
      return new Set(await check.call(this.conversation, ids))
    } catch (err) {
      log.warn('index.searchThread.liveCheck.failed', errorFields(err))
      return null
    }
  }

  /**
   * Whether it has been confirmed that the message is gone from the canonical copy (no row / thread soft-deleted) (TODO 863). A null from `readEventText`
   * also covers "the body is not indexable", so it is not a basis for deleting. The same decision as the `liveEventIds` route (in tests with no entry point, as before,
   * null = gone). If it could not be confirmed (RPC failure), do not delete.
   */
  private async isGoneEvent(eventId: string): Promise<boolean> {
    if (this.conversation.liveEventIds === undefined) return true
    const live = await this.liveThreadEvents([{ source_id: `event:${eventId}` }])
    return live !== null && !live.has(eventId)
  }

  /** Document ids of leftovers scheduled to be dropped. Queued only once even if hit many times in the same search (TODO 860). */
  private readonly droppingOrphans = new Set<number>()

  /**
   * Drops from the index a conversation document with no canonical copy (TODO 860). A conversation document has chunks only if
   * the canonical copy could be read at ingestion time, and messages are immutable, so unreadable later = gone from the canonical copy. The write is queued on the column (6.2).
   */
  private dropOrphanConversation(documentId: number): void {
    if (this.shutdown || this.droppingOrphans.has(documentId)) return
    this.droppingOrphans.add(documentId)
    void this.enqueue(() => {
      const document = this.store.getDocument(documentId)
      if (document === null || document.source !== 'conversation') return
      this.store.removeDocument(documentId)
      log.info('index.conversation.orphanDropped', { documentId })
    })
      .catch((err: unknown) => log.warn('index.conversation.orphanDrop.failed', errorFields(err)))
      .finally(() => this.droppingOrphans.delete(documentId))
  }

  private async readCanonicalNonFs(row: DocumentRow): Promise<Canonical | null> {
    if (row.source === 'conversation') {
      const eventId = conversationEventId(row.source_id)
      if (eventId === null) return null
      const event = await this.conversation.readEventText(eventId)
      if (event === null) {
        // A message no longer in the canonical copy (TODO 860). It is a leftover whose "delete" notice from main never arrived, so drop it here.
        // But do not drop it merely because it is unreadable (a live message whose `indexableText` is null) (TODO 863).
        if (await this.isGoneEvent(eventId)) this.dropOrphanConversation(row.id)
        return null
      }
      // `row.name` is the role marker attached when the conversation event was indexed (you / answer / tool,
      // `ThreadStore.labelOf`. TODO 66). Only known markers are also put into `contextCode`.
      return {
        text: event.text,
        uri: row.uri ?? '',
        title: (await this.conversation.threadTitle(event.threadId)) ?? row.name,
        context: row.name,
        contextCode: isSearchRoleCode(row.name) ? row.name : null,
        threadId: event.threadId,
        eventId
      }
    }
    if (row.source === 'transcript' && this.transcripts !== null) {
      const meta = parseMetadata(row.metadata)
      const fileId = typeof meta['fileId'] === 'string' ? meta['fileId'] : null
      const messageId = typeof meta['messageId'] === 'string' ? meta['messageId'] : null
      if (fileId === null || messageId === null) return null
      const text = await this.transcripts.readMessageText(
        fileId,
        messageId,
        transcriptLocatorOf(meta)
      )
      if (text === null) return null
      return {
        text,
        uri: row.uri ?? '',
        title: row.name,
        // Marker code (the renderer's dictionary `search.role.transcript` turns it into text, TODO 66).
        context: 'transcript',
        contextCode: 'transcript',
        threadId: null,
        eventId: null
      }
    }
    if (this.plugins !== null && row.source_id !== null) {
      const body = await this.plugins.read(row.source, row.source_id)
      if (body !== null) {
        return {
          text: body,
          uri: row.uri ?? '',
          title: row.name,
          context: row.source,
          contextCode: null,
          threadId: null,
          eventId: null
        }
      }
    }
    return null
  }

  // ---- For the gateway (7.6.1). The exposure decision is made **always here** ----

  /** `aios.getDocument`: metadata + the start of the body. */
  async getDocument(
    id: string,
    limitBytes: number,
    forAgent: boolean
  ): Promise<Record<string, unknown> | null> {
    const row = this.documentFor(id, forAgent)
    if (row === null) return null
    // fs counts in raw bytes on disk (the same coordinates as getDocumentText. Extraction covers only the first 256 KB, and
    // the length after replacing invalid UTF-8 with U+FFFD does not match the original). TODO 839.
    // fs uri / title are determined from the row. Do not go through canonicalOf, which reads the whole canonical copy and decodes it (TODO 845).
    let head: Utf8Range | null
    let around: RedactionContext | null = null
    let uri: string
    let title: string
    if (row.source === 'fs' && !this.isDerivedFsRow(row)) {
      const path = this.store.pathOf(row.id)
      if (path === null) return null
      // Apply the extractFile gate (not-yet-downloaded iCloud, bundles, binaries, too large...) without reading the whole file.
      if ((await extractGate(path)) !== null) return null
      head = await this.readFsRange(row, 0, limitBytes)
      if (head !== null && forAgent) around = await fsRedactionContext(path, head)
      uri = pathToUri(path)
      title = row.name
    } else {
      const canonical = await this.canonicalOf(row)
      if (canonical === null) return null
      const buffer = Buffer.from(canonical.text, 'utf8')
      head = sliceUtf8(buffer, 0, limitBytes)
      if (forAgent) around = bufferRedactionContext(buffer, head)
      uri = canonical.uri
      title = canonical.title
    }
    if (head === null) return null
    const hasMore = head.end < head.size
    const chunks = this.store.chunksOf(row.id)
    return {
      id: String(row.id),
      uri,
      title: forAgent ? redactText(title).text : title,
      source: row.source,
      kind: row.kind,
      updated_at: row.updated_at,
      size: row.size,
      lang: row.lang,
      // For the gateway, the body has redaction applied (TODO 855). The position fields below stay in the canonical copy's coordinates, before the redaction mask.
      ...agentText(head.text, forAgent, around),
      // The number of bytes the returned body occupies in the canonical copy. When the gateway's respond truncates,
      // if this matches the body length it can give next_offset exactly without recounting U+FFFD.
      bytes: head.end - head.start,
      // Whether the returned body reached the end of the canonical copy (compared in bytes. Until TODO 839
      // it compared bytes with characters, so a Japanese document was true even when the whole text was returned).
      has_more: hasMore,
      // To continue, call getDocumentText with this offset. null if returned to the end.
      next_offset: hasMore ? head.end : null,
      total_bytes: head.size,
      chunks: chunks.length
    }
  }

  /**
   * `aios.getDocumentText`: any range of the canonical copy (6.5: fs re-reads the disk).
   *
   * The range is snapped to UTF-8 character boundaries (TODO 839): if `offset` is in the middle of a character, reading starts at the next character,
   * and a partly written character at the end is not returned. `offset` is the position where reading actually started, `bytes` is the number of bytes
   * advanced in the canonical copy, and `next_offset` is the position to continue from (null if read to the end).
   */
  async getDocumentText(
    id: string,
    offset: number,
    length: number,
    forAgent: boolean
  ): Promise<Record<string, unknown> | null> {
    const row = this.documentFor(id, forAgent)
    if (row === null) return null
    let range: Utf8Range | null
    // The canonical copy before and after, to catch a secret split at a page boundary (wave 42 code-review bundle X).
    let around: RedactionContext | null = null
    let uri: string
    if (row.source === 'fs' && !this.isDerivedFsRow(row)) {
      const path = this.store.pathOf(row.id)
      if (path === null) return null
      // A file deleted after the search gives null (not found), as with getDocument.
      range = await this.readFsRange(row, offset, offset + length)
      if (range === null) return null
      if (forAgent) around = await fsRedactionContext(path, range)
      uri = pathToUri(path)
    } else {
      const canonical = await this.canonicalOf(row)
      if (canonical === null) return null
      const buffer = Buffer.from(canonical.text, 'utf8')
      range = sliceUtf8(buffer, offset, length)
      if (forAgent) around = bufferRedactionContext(buffer, range)
      uri = canonical.uri
    }
    return {
      id,
      uri,
      offset: range.start,
      ...agentText(range.text, forAgent, around),
      bytes: range.end - range.start,
      next_offset: range.end < range.size ? range.end : null,
      total_bytes: range.size
    }
  }

  /**
   * Whether the fs canonical copy may be read (TODO 849). **At the time of reading**, the exclusion rules are applied again to both the logical path and the realpath.
   * The "realpath → re-check" choke point that the Broker / ViewerBroker / `openDiff` have is also placed on this route, which
   * passes bodies to the AI and to screen search: it does not read the real target of a file that was replaced by a symlink after indexing, or one where an intermediate directory
   * now points to `~/.ssh` etc. (a symlink at the last component is also stopped by `O_NOFOLLOW` in `openRegularFile`). Even in the period after the rules change
   * until the next full scan drops the row, it stops by the current rules.
   * When there are no rules (in tests), nothing is applied.
   *
   * Results: `ok` may be read; `skip` is a kind that holds no body (the row stays for name search and only the chunks are dropped);
   * `drop` is an exclusion or an intermediate symlink pointing to an exclusion (permanent. The whole row is dropped); `unresolved` means the parent's realpath
   * cannot be resolved (gone, or temporarily unreadable. Search drops the whole row, and the index build makes it `failed` and retries).
   *
   * realpath is applied **only to the parent directory**, and if `dirs` is given it is reused only during one build batch / one search
   * (wave 42 code-review bundle X: realpath + classify twice per document were on the hot path of build and search).
   * Where the last component (the file itself) is a symlink, even without looking at it by realpath, the reading entry point (`openRegularFile`)'s
   * `O_NOFOLLOW` stops it with `ELOOP`. Intermediate components are covered because the exclusion is applied to the parent's realpath, so the inside of an exclusion is not read.
   * The window in which an intermediate component is swapped during reuse (one batch, one search) is the same kind as the window between realpath and open,
   * and its length is limited to a single operation.
   */
  private async fsVerdict(path: string, dirs: RealDirCache | null = null): Promise<FsVerdict> {
    // A kind that holds no body (such as `*.env`, which TODO 855 removed) is not shown even if earlier chunks remain.
    if (!isExtractable(path)) return 'skip'
    const rules = this.fsRules?.() ?? null
    if (rules === null) return 'ok'
    const name = basename(path)
    if (classify(path, name, false, rules).excluded) return 'drop'
    const dir = dirname(path)
    let pending = dirs?.get(dir)
    if (pending === undefined) {
      pending = realpath(dir).catch(() => null)
      dirs?.set(dir, pending)
    }
    const realDir = await pending
    if (realDir === null) return 'unresolved'
    if (realDir === dir) return 'ok'
    return classify(join(realDir, name), name, false, rules).excluded ? 'drop' : 'ok'
  }

  /** Document ids of fs leftovers scheduled to be dropped (wave 42 code-review bundle X). */
  private readonly droppingFsDebris = new Set<number>()
  /** Documents being requeued because the re-extraction hash did not match (TODO 1009; not queued twice). */
  private readonly requeueingDerived = new Set<number>()

  /**
   * Drops from the index the fs leftovers found by search (wave 42 code-review bundle X). `collectHits` discards leftovers
   * up to `GONE_MAX_READS` and fills from below, but fs leftovers (a `*.env` indexed before 855, a path that
   * became excluded later, a deleted file, a file replaced by a symlink) stay in the index until the next full scan, so
   * if not dropped they eat the top ranks on every search and real hits can drop to 0.
   * `skip` drops only the chunks and FTS (the row stays for name search), and `drop` drops the whole row (the scan also drops the same row
   * with `removeStale`). The write is queued on the sole writer's column (6.2).
   */
  private dropFsDebris(documentId: number, verdict: 'skip' | 'drop'): void {
    if (this.shutdown || this.droppingFsDebris.has(documentId)) return
    this.droppingFsDebris.add(documentId)
    void this.enqueue(() => {
      const document = this.store.getDocument(documentId)
      if (document === null || document.source !== 'fs') return
      if (verdict === 'skip') this.store.markSkipped(documentId)
      else this.store.removeDocument(documentId)
      log.info('index.fs.debrisDropped', { documentId, verdict })
    })
      .catch((err: unknown) => log.warn('index.fs.debrisDrop.failed', errorFields(err)))
      .finally(() => this.droppingFsDebris.delete(documentId))
  }

  /**
   * Whether the re-extracted text is the same as when it was indexed (TODO 1009 safety net, Office / PDF). Chunk ranges are positions in the extracted
   * text, so if the extractor's output changes (PDFKit may change with a macOS update) the ranges shift.
   * Compares `documents.content_hash` with sha256, and if they differ, **no excerpt is shown** (false), and the document is put back to `pending`
   * and queued for re-indexing. Documents that are not extracted text, or that have no hash yet, are always true.
   */
  private derivedMatches(documentId: number, path: string, text: string): boolean {
    if (!isDerivedText(path)) return true
    const stored = this.store.contentHashOf(documentId)
    if (stored === null) return true
    // The digest is computed only once for the entry in the extraction store and remembered (`derivedTextDigest`).
    if (derivedTextDigest(path, text) === stored) return true
    if (!this.shutdown && !this.requeueingDerived.has(documentId)) {
      this.requeueingDerived.add(documentId)
      void this.enqueue(() => {
        if (this.store.requeueIndexed(documentId)) {
          this.status = { ...this.status, pending: this.status.pending + 1 }
          log.info('index.derived.hashMismatch', { documentId })
        }
      })
        .catch((err: unknown) => log.warn('index.derived.requeue.failed', errorFields(err)))
        .finally(() => this.requeueingDerived.delete(documentId))
    }
    return false
  }

  /**
   * Whether the body is the text extracted from an fs document (TODO 997, Office / TODO 1009, PDF). getDocument / getDocumentText cut the canonical string
   * (`canonicalOf` → re-extraction by `extractFile`) in UTF-8 coordinates, as for conversations and the like, not the raw bytes.
   * The position fields (`offset` / `next_offset` / `total_bytes`) are bytes of the extracted text.
   */
  private isDerivedFsRow(row: DocumentRow): boolean {
    if (row.source !== 'fs') return false
    const path = this.store.pathOf(row.id)
    return path !== null && isDerivedText(path)
  }

  /** Raw byte range of an fs document (getDocument / getDocumentText). null if unreadable. */
  private async readFsRange(row: DocumentRow, start: number, end: number): Promise<Utf8Range | null> {
    const path = this.store.pathOf(row.id)
    if (path === null) return null
    if ((await this.fsVerdict(path)) !== 'ok') return null
    try {
      return await readUtf8Range(path, start, end)
    } catch {
      return null
    }
  }

  /** `aios.getChunk`: the matching chunk and one chunk before and after. */
  async getChunk(chunkId: string, forAgent: boolean): Promise<Record<string, unknown> | null> {
    const numeric = Number(chunkId)
    if (!Number.isFinite(numeric)) return null
    const chunk = this.store.chunkById(numeric)
    if (chunk === null) return null
    const row = this.documentFor(String(chunk.document_id), forAgent)
    if (row === null) return null
    const canonical = await this.canonicalOf(row)
    if (canonical === null) return null

    const all = this.store.chunksOf(row.id)
    const index = all.findIndex((c) => c.id === chunk.id)
    const from = all[Math.max(0, index - 1)]
    const to = all[Math.min(all.length - 1, index + 1)]
    if (from === undefined || to === undefined) return null
    const fromChar = byteToCharApprox(canonical.text, from.byte_start)
    const toChar = byteToCharApprox(canonical.text, to.byte_end)
    const text = canonical.text.slice(fromChar, toChar)
    return {
      id: String(chunk.id),
      document_id: String(row.id),
      uri: canonical.uri,
      title: canonical.title,
      seq: chunk.seq,
      ...agentText(text, forAgent, forAgent ? charRedactionContext(canonical.text, fromChar, toChar) : null)
    }
  }

  /** The `exposure` decision is made here in main, not in the gateway (7.6.1). */
  /**
   * TODO 1235: looks up the id of one document by `(source, source_id)` or uri (the entry point that lets the gateway's `getDocument` / `getDocumentText`
   * also accept a uri). **It only returns the id** and does not read the body — the caller calls `getDocument` / `getDocumentText` with this id,
   * so every check (exclusion rules, realpath re-check, redaction mask, etc.) goes through exactly the same path as when looked up by rowid.
   * Strings are not normalized, only exact match (so scheme differences, case, or relative paths cannot be used to get around the checks). fs is not looked up
   * (its path checks live on the `Read` / `searchFiles` side, and the row has neither uri nor source_id). A row whose exposure cannot go to the agent is
   * not distinguished from "not found" (existence is not leaked). 0 or multiple matches return a reason.
   *
   * How the uri is looked up: if `source` is given, `(source, uri)` in SQL (the leading column of `documents_source` is used). If `source` is absent, only conversations (`thread://`)
   * and transcripts (`transcript://`), whose source and source_id can be determined from the uri scheme, are looked up
   * with the `(source, source_id)` unique index; if it cannot be determined, `source-required` is returned (no full table scan).
   */
  resolveDocument(
    query: { uri: string; source: string; sourceId: string },
    forAgent: boolean
  ): { id: string } | { reason: 'not-found' | 'ambiguous' | 'unsupported' | 'source-required' } {
    const allowed: readonly string[] = forAgent ? AGENT_EXPOSURES : UI_EXPOSURES
    let rows: DocumentRow[]
    if (query.source !== '' && query.sourceId !== '') {
      if (query.source === 'fs') return { reason: 'unsupported' }
      const row = this.store.getBySourceId(query.source, query.sourceId)
      rows = row === null ? [] : [row]
    } else if (query.uri !== '') {
      if (query.uri.startsWith('file:')) return { reason: 'unsupported' }
      if (query.source === 'fs') return { reason: 'unsupported' }
      if (query.source !== '') {
        rows = this.store.findNonFsByUri(query.source, query.uri)
      } else {
        const derived = sourceKeyOfUri(query.uri)
        if (derived === null) return { reason: 'source-required' }
        const row = this.store.getBySourceId(derived.source, derived.sourceId)
        // The key came from the uri's shape: take the row only if its stored uri is the same string.
        rows = row !== null && row.uri === query.uri ? [row] : []
      }
    } else {
      return { reason: 'unsupported' }
    }
    const visible = rows.filter((row) => row.source !== 'fs' && allowed.includes(row.exposure))
    if (visible.length === 0) return { reason: 'not-found' }
    if (visible.length > 1) return { reason: 'ambiguous' }
    return { id: String((visible[0] as DocumentRow).id) }
  }

  private documentFor(id: string, forAgent: boolean): DocumentRow | null {
    const numeric = Number(id)
    if (!Number.isFinite(numeric)) return null
    const row = this.store.getDocument(numeric)
    if (row === null) return null
    const allowed: readonly string[] = forAgent ? AGENT_EXPOSURES : UI_EXPOSURES
    if (!allowed.includes(row.exposure)) return null
    return row
  }
}

/** Wait / merge timer (P3 / P4). Does not hold up app shutdown. */
function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Only the sources (conversation, transcript) whose `(source, source_id)` can be determined from the shape of the uri. Other uris (those an extension assigns) do not
 * determine the source from their shape, so null (`resolveDocument` asks for `source`).
 */
function sourceKeyOfUri(uri: string): { source: string; sourceId: string } | null {
  const conversation = /^thread:\/\/([^/]+)\/([^/]+)$/.exec(uri)
  if (conversation !== null) return { source: 'conversation', sourceId: `${conversation[1]}:${conversation[2]}` }
  const transcript = /^transcript:\/\/([^/]+)\/([^/]+)$/.exec(uri)
  if (transcript !== null) return { source: 'transcript', sourceId: `${transcript[1]}#${transcript[2]}` }
  return null
}

/** The `source_id` of a conversation document is `<threadId>:<eventId>`. */
function conversationEventId(sourceId: string | null): string | null {
  if (sourceId === null) return null
  const at = sourceId.indexOf(':')
  return at < 0 ? sourceId : sourceId.slice(at + 1)
}

/** Body-only canonical copy placed in `toHit`'s reuse table (TODO 925, fs lossy rows). */
/** Number of images whose OCR was re-run in one search, and the time it took (`toHit`). */
interface SearchOcrBudget {
  images: number
  spentMs: number
}

/** `readCanonical`'s answer for an image whose classification timed out for the first time: leave the row `pending` (TODO 1234). */
const DEFERRED = Symbol('deferred')

const EMPTY_CANONICAL: Canonical = {
  text: '',
  uri: '',
  title: '',
  context: '',
  contextCode: null,
  threadId: null,
  eventId: null
}

/** Marker for an image whose excerpt could not be made (`toHit` tells it apart by identity). The hit stays and only the excerpt is empty. */
const NO_EXCERPT: Canonical = { ...EMPTY_CANONICAL }

/** Whether the fs row carries the "decoding does not round-trip" mark (TODO 925, `IndexStore.setFsLossy`). */
function isLossyFsRow(row: DocumentRow): boolean {
  return row.source === 'fs' && row.metadata !== null && parseMetadata(row.metadata)['lossy'] === true
}

/** Returns only the parent directory's name (so the path is not passed to the renderer). */
function parentFolderName(store: IndexStore, parentId: number | null): string {
  if (parentId === null) return ''
  const path = store.pathOf(parentId)
  return path === null ? '' : basename(path)
}

/**
 * Name of a transcript document = the first 80 characters of the body. **Redaction is applied before cutting** (TODO 1123, constraint 10): a key the user pasted
 * at the start of a message stayed in plaintext in `documents.name` and appeared in the `title` of gateway search results.
 * Headings already stored are rewritten by the next ingestion's upsert, which overwrites `name` (the name is overwritten even if the version is the same).
 * So that a key split at the cut boundary does not slip past the redaction mask, redaction is applied to a start longer than 80 characters and then cut.
 */
function transcriptName(message: TranscriptMessageInput): string {
  const head = redactText(message.text.slice(0, 400)).text
  return head.slice(0, 80).replace(/\s+/g, ' ').trim() || message.role
}

/**
 * `documents.metadata` for one transcript message (item 78). The location (`offset` / `length` /
 * `fileVersion`) is included only when it came from main. **Neither the body nor `tool_result` is
 * included** (constraints 9 / 10) — only positions and identifiers.
 */
function transcriptMetadata(
  file: TranscriptFile,
  message: TranscriptMessageInput
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    fileId: file.id,
    messageId: message.id,
    role: message.role,
    sessionId: message.sessionId,
    context: file.uri
  }
  if (
    typeof file.version === 'string' &&
    Number.isSafeInteger(message.offset) &&
    Number.isSafeInteger(message.length)
  ) {
    metadata['offset'] = message.offset
    metadata['length'] = message.length
    metadata['fileVersion'] = file.version
  }
  return metadata
}

/**
 * The id of the thread that a conversation document row belongs to (TODO 1096). `source_id` is not SELECTed, so it is taken from the URI
 * (`thread://<threadId>/<eventId>`, `indexConversationEvents`). null for non-conversations (transcripts etc.).
 */
function conversationThreadOf(row: SearchRow): string | null {
  if (row.source !== 'conversation' || row.uri === null) return null
  const prefix = 'thread://'
  if (!row.uri.startsWith(prefix)) return null
  const end = row.uri.indexOf('/', prefix.length)
  return end <= prefix.length ? null : row.uri.slice(prefix.length, end)
}

/** The inverse of `transcriptMetadata`. null if the location is incomplete (main falls back to parsing the whole file). */
function transcriptLocatorOf(meta: Record<string, unknown>): TranscriptLocator | null {
  const { offset, length, fileVersion } = meta
  if (typeof offset !== 'number' || typeof length !== 'number') return null
  if (typeof fileVersion !== 'string') return null
  return { offset, length, version: fileVersion }
}

/** `metadata.pdfPages` of a PDF row (the byte position of the start of each page, TODO 1009 stage 2). Empty if absent or corrupt. */
function pdfPagesOf(row: DocumentRow): readonly number[] {
  if (row.source !== 'fs' || row.metadata === null) return []
  const pages = parseMetadata(row.metadata)['pdfPages']
  return sanitizePageLengths(pages)
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Approximation converting a byte position to a character position. One UTF-8 character is 1 to 4 bytes, so
 * it narrows in from a rough position, forward or backward. It is only used to cut snippets,
 * so it need not be exact.
 */
function byteToCharApprox(text: string, bytePosition: number): number {
  if (bytePosition <= 0) return 0
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const bytes = Buffer.byteLength(text.slice(0, mid), 'utf8')
    if (bytes < bytePosition) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * Snippet for display. **FTS5's `snippet()` is not used** — the shadow column is
 * already word-segmented and reads like a Japanese phrase split into space-separated words, which is unreadable (6.5, spike 11).
 * Cuts around the query from the matching range of the canonical copy.
 */
/**
 * Body passed to the gateway (AI) (TODO 855). For `forAgent`, apply redaction, and attach `redacted: true` if anything was masked.
 * Applying it to the body alone would miss a secret split at a page / chunk boundary (`…DB_PA` | `SSWORD=…`), so
 * matches are found in a window with the surrounding canonical copy (`around`, `REDACTION_CONTEXT` on each side) added (`redactSlice`, wave 42 code-review bundle X).
 * Even if the gateway's `respond` advances a little less and the next page starts in the middle of a key name, it matches in the same window.
 * It is insurance for credential locations not in the table (outside `CREDENTIAL_DIRS` in `exclusions.ts`), and being a regular expression it misses some
 * (the same premise as 4.3.1). **The position fields (`offset` / `bytes` / `next_offset` / `total_bytes`) stay in the canonical copy's coordinates
 * from before the redaction mask** — the caller swaps in only the body. `redacted` is a mark so that when the gateway's `respond` cuts the body, it does not
 * treat "body length = bytes of the canonical copy" and advances a little less (`withCut` in `src/gateway/respond.ts`).
 * It is not applied for the screen (not forAgent).
 */
function agentText(
  text: string,
  forAgent: boolean,
  /** The canonical copy before and after the body (wave 42 code-review bundle X). Catches a secret split at a boundary. null means no context. */
  around: RedactionContext | null
): { text: string; redacted?: true } {
  if (!forAgent) return { text }
  const result = redactSlice(text, around ?? NO_CONTEXT)
  return result.text === text ? { text } : { text: result.text, redacted: true }
}

/**
 * Size of the canonical copy added before and after the range returned to the AI as redaction context (bytes / characters, wave 42 code-review bundle X).
 * Big enough for a key name + value (a few hundred bytes) and an RSA 4096 PEM private key (about 3.3 KiB). A page that returns only the middle of a PEM
 * longer than this has neither BEGIN nor END in the window and does not match (the premise of missing some is the same as 4.3.1).
 */
const REDACTION_CONTEXT = 4096

const NO_CONTEXT: RedactionContext = { before: '', after: '', moreBefore: false, moreAfter: false }

/** Reads the part before and after `range` of the fs canonical copy. If unreadable, no context (redaction is applied to the body only). */
async function fsRedactionContext(path: string, range: Utf8Range): Promise<RedactionContext> {
  const readOr = async (start: number, end: number): Promise<Utf8Range | null> => {
    if (end <= start) return null
    try {
      return await readUtf8Range(path, start, end)
    } catch {
      return null
    }
  }
  const from = Math.max(0, range.start - REDACTION_CONTEXT)
  const before = await readOr(from, range.start)
  const after = await readOr(range.end, range.end + REDACTION_CONTEXT)
  return {
    before: before?.text ?? '',
    after: after?.text ?? '',
    moreBefore: from > 0,
    moreAfter: (after?.end ?? range.end) < range.size
  }
}

/** The part before and after `range` of an in-memory canonical copy (a UTF-8 `buffer`). */
function bufferRedactionContext(buffer: Buffer, range: Utf8Range): RedactionContext {
  const from = Math.max(0, range.start - REDACTION_CONTEXT)
  const before = sliceUtf8(buffer, from, range.start - from)
  const after = sliceUtf8(buffer, range.end, REDACTION_CONTEXT)
  return { before: before.text, after: after.text, moreBefore: from > 0, moreAfter: after.end < buffer.byteLength }
}

/** The part before and after `[from, to)` (UTF-16 positions) of a string canonical copy. */
function charRedactionContext(text: string, from: number, to: number): RedactionContext {
  const start = Math.max(0, from - REDACTION_CONTEXT)
  const end = Math.min(text.length, to + REDACTION_CONTEXT)
  return { before: text.slice(start, from), after: text.slice(to, end), moreBefore: start > 0, moreAfter: end < text.length }
}

/** Parent directory → realpath (null means it cannot be resolved). Kept only during one build batch / one search (`fsVerdict`). */
type RealDirCache = Map<string, Promise<string | null>>

/** Result of `fsVerdict`. */
type FsVerdict = 'ok' | 'skip' | 'drop' | 'unresolved'

/**
 * Whether a read failure means "the file is gone (as a regular file)". `ELOOP` means `O_NOFOLLOW` hit a
 * symlink, and `EINVAL` means `openRegularFile` refused because it is not a regular file.
 * A transient failure such as `EMFILE` / `EIO` does not cause a drop.
 */
function isGoneError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EINVAL'
}

/**
 * The position where the query first matches in `text` (characters; -1 if none). Lowercases, and searches the whole query first, then term by term (split on whitespace).
 * Shared by `makeSnippet` and `firstMatchOffset` (so the way of finding the needle is not kept in two places).
 */
function locateNeedle(text: string, query: string): number {
  const needle = query.trim().toLowerCase()
  if (needle === '') return -1
  const lower = text.toLowerCase()
  const whole = lower.indexOf(needle)
  if (whole >= 0) return whole
  for (const token of needle.split(/\s+/)) {
    if (token === '') continue
    const found = lower.indexOf(token)
    if (found >= 0) return found
  }
  return -1
}

/** The position where the query first matches in the excerpt (characters, searched the same way as `makeSnippet`; 0 if none). */
export function firstMatchOffset(excerpt: string, query: string): number {
  // Characters whose length changes when lowercased (such as İ) shift positions, so if it shifts, return the start.
  if (excerpt.toLowerCase().length !== excerpt.length) return 0
  return Math.max(0, locateNeedle(excerpt, query))
}

export function makeSnippet(excerpt: string, query: string): string {
  const flat = excerpt.replace(/\s+/g, ' ').trim()
  const needle = query.trim()
  if (flat === '') return ''
  const at = locateNeedle(flat, needle)
  if (at < 0) return flat.slice(0, SNIPPET_RADIUS * 2)
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(flat.length, at + needle.length + SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
