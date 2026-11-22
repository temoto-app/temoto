/**
 * IndexClient: the "thin client to the index" that remains on the main side (P1, ARCHITECTURE.md chapter 3).
 *
 * **No index SQL is executed on main's JS thread.** All this does is
 * start the utility process (`aios-index`), do RPC round trips and relay notifications.
 *
 * ```
 * renderer ──IPC──► main (IndexClient) ──postMessage──► index process (IndexKernel)
 *                         ◄── ntf scanStatus / fileChanges / indexStatus / rules ──
 *                         ◄── req conversation.* / transcript.* / plugin.read ──
 * ```
 *
 * It follows the shape of `PluginHost` (7.8):
 * - `utilityProcess.fork` + environment narrowing (`HOST_ENV_ALLOWLIST`)
 * - on a crash, restart with exponential backoff; past the limit, `state: 'error'`
 * - exits we caused ourselves (`stopping`) are not counted as crashes (Phase 4 review B-7)
 *
 * Two differences:
 * - **No Node permission model is applied.** The index process reads the whole PC, which is not a range
 *   that `--allow-fs-read` can enumerate (3.2).
 * - **The key is passed in the `open` message.** Putting it in argv / env would show it in `ps` (3.3).
 *
 * Progress (`ScanStatus` / `IndexStatus`) **keeps the last value that arrived**.
 * The renderer's `fsScanStatus` / `searchStatus` are synchronous IPC, so they are answered here
 * without waiting for an RPC round trip.
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import type { PluginDocumentInput } from '@shared/plugin.js'
import type { DbBreakdown } from '@shared/db-breakdown.js'
import type {
  IndexStatus,
  ScopeBuildResult,
  SearchResponse,
  SearchScope,
  ThreadSearchResponse
} from '@shared/search.js'
import type {
  DirectoryListing,
  ListDirectoryOptions,
  FileChangeBatch,
  FileSearchResult,
  ScanDenial,
  ScanStatus,
  VolumeEntry
} from '@shared/types.js'
import type { RecentCandidate } from '@shared/recent-files.js'
import type {
  IndexOpenParams,
  IndexPowerReport,
  IndexRpcMessage,
  IndexRulesPayload,
  SubtreeScanResult
} from '@shared/index-rpc.js'
import { INDEX_PROCESS_BUSY, INDEX_PROCESS_CRASHED } from '@shared/index-rpc.js'
import { reasonError, type ReasonCode } from '@shared/reason.js'
import { RPC_TIMEOUT, RpcPeer, type RpcMethods } from '../../common/rpc.js'
import { log, errorFields } from '../../common/logger.js'
import { createRelay } from '../../common/log-relay.js'
import { HOST_ENV_ALLOWLIST } from '../plugin/host-env.js'
import type { DbQuickCheckResult } from '@shared/backup.js'

/** Upper bound for `start()` waiting for `ready` (= the response to `open`). Past it the child is not killed, and it keeps waiting for the `open` response. */
const READY_TIMEOUT_MS = 15_000
/** Upper bound for waiting for the response to `stop` on shutdown. Past it, kill and move on (3.6). */
const STOP_TIMEOUT_MS = 10_000
/** Restart limit and intervals (1 s -> 2 s -> 4 s ...). */
const MAX_RESTARTS = 5
const RESTART_BASE_DELAY_MS = 1000

/**
 * Upper bound for waiting on a response (item 87). Applied **only to requests the screen is waiting on**.
 *
 * When the index process is alive but stuck (one long statement, applying a huge diff),
 * the `rejectAll` for the dead case does not help, so without a limit the renderer's "searching..."
 * and "loading..." would go on indefinitely. Past the limit it rejects with `IndexProcessBusy` (reason code
 * `index-busy`), and a response that arrives late is discarded by `RpcPeer` by id.
 *
 * Methods not listed are unlimited: scanning (`fs.rescan` waits for one scan), ingestion
 * (`index.conversationEvents` / `index.transcriptMessages`), stopping / resuming the build,
 * and volume permission (calls `diskutil`). `stop` is wrapped by `stop()` with its own
 * `STOP_TIMEOUT_MS`, including the wait for `ready`.
 * The time waiting for `ready` is not included (that is `READY_TIMEOUT_MS`).
 */
const CALL_TIMEOUT_MS: Readonly<Record<string, number>> = {
  'fs.listDirectory': 10_000,
  'fs.searchFiles': 10_000,
  'fs.searchFilesForLink': 10_000,
  'fs.searchFilesForAgent': 10_000,
  'fs.listVolumes': 10_000,
  // Reflecting something just created from the Files tree (TODO 370). The screen waits for the answer.
  'fs.noteCreated': 10_000,
  'index.search': 10_000,
  // Building a scope (TODO 437). The index process side cuts it off at 10 seconds (item 249), so this is longer to allow for queue waiting.
  'index.buildScope': 30_000,
  'index.getDocument': 10_000,
  'index.getDocumentText': 10_000,
  'index.resolveDocument': 10_000,
  'index.getChunk': 10_000
}

/**
 * Where one message is (item 78). The index keeps it in `documents.metadata`, and it comes back via
 * reverse RPC every time a snippet is re-read. The contents are only numbers and an opaque version.
 */
export interface TranscriptLocator {
  readonly offset: number
  readonly length: number
  readonly version: string
}

/** Source of transcript ingestion. **Only the Adapter knows the location and format** (constraint 6). */
export interface TranscriptFeed {
  listFiles(): Promise<readonly { id: string; uri: string; version: string; mtimeMs: number }[]>
  /** One file. `version` is the version of the fd that was read, and the locations are valid against this version. */
  readMessages(fileId: string): Promise<{
    id: string
    uri: string
    version: string
    /** The backend session id of this transcript (item 111: used to exclude conversations aios owns). */
    sessionId: string | null
    messages: readonly {
      id: string
      role: string
      text: string
      ts: number
      sessionId: string
      offset: number
      length: number
    }[]
  } | null>
  /**
   * `stale` = the locations were unusable and it fell back to a full-line parse. A signal to re-ingest that file.
   * `missing` = the file itself is gone (ENOENT, item 241). A signal to drop that file from the index.
   */
  readMessageText(
    fileId: string,
    messageId: string,
    locator: TranscriptLocator | null
  ): Promise<{ text: string | null; stale: boolean; missing: boolean }>
}

/** Restore the locations that arrived via reverse RPC to the type. null if the shape does not match (= fall back to a full-line parse). */
function asLocator(value: unknown): TranscriptLocator | null {
  if (typeof value !== 'object' || value === null) return null
  const { offset, length, version } = value as Record<string, unknown>
  if (typeof offset !== 'number' || typeof length !== 'number' || typeof version !== 'string') {
    return null
  }
  return { offset, length, version }
}

/** The side that returns the canonical copy (what remains in main). The index process asks here in reverse (3.4). */
export interface CanonicalSources {
  readonly conversation: {
    readEventText(eventId: string): { text: string; threadId: string; ts: number } | null
    threadTitle(threadId: string): string | null
    /** Of `eventIds`, those still present in the canonical copy (TODO 863, `ThreadStore.liveEventIds`). When omitted, it answers that all are present. */
    liveEventIds?(eventIds: readonly string[]): readonly string[]
  }
  readonly transcripts: TranscriptFeed | null
  /**
   * Backend session id owned by an aios thread -> the read limit (bytes) up to which it may go into the index as a transcript
   * (item 111). null means "that transcript is not put in the index" (its body is in aios's conversation index). Ids not in the table
   * are all included. When omitted, all are included (tests etc.).
   */
  readonly ownedTranscripts?: () => ReadonlyMap<string, number | null>
  readonly plugins: { read(source: string, sourceId: string): string | null }
}

/**
 * Remove conversation transcripts that aios owns from the index / narrow them to the read limit (item 111, 4.5.9). A pure function.
 * - an id not in the table (a conversation only in the terminal / VS Code): include all
 * - `limit` is null (a conversation aios started / branched): do not include (`skip`)
 * - `limit` is set (a conversation continued with the same id): only the lines up to the read limit. What comes after is held by aios's conversation index
 */
export function filterOwnedTranscript<T extends { readonly offset: number; readonly length: number }>(
  sessionId: string | null,
  messages: readonly T[],
  owned: ReadonlyMap<string, number | null>
): { readonly skip: boolean; readonly messages: readonly T[] } {
  if (sessionId === null || !owned.has(sessionId)) return { skip: false, messages }
  const limit = owned.get(sessionId) ?? null
  if (limit === null) return { skip: true, messages: [] }
  return { skip: false, messages: messages.filter((m) => m.offset + m.length <= limit) }
}

/**
 * One notice of a write to the conversation index. Put on `IndexClient.pendingWrites`. A delete notice (TODO 860), and the
 * submission of conversation events (TODO 875: so that a restore's rebuild does not run before an earlier queued delete or get lost during a restart wait).
 */
interface ConversationWrite {
  readonly method:
    | 'index.removeThread'
    | 'index.removeAllConversations'
    | 'index.pruneConversations'
    | 'index.conversationEvents'
  readonly params: Record<string, unknown>
}

export interface IndexClientEvents {
  onScanStatus(status: ScanStatus): void
  onFileChanges(batch: FileChangeBatch): void
  onIndexStatus(status: IndexStatus): void
  /** The allowed volumes changed. `FsAccess` on the main side rebuilds the rules (3.5). */
  onRules(payload: IndexRulesPayload): void
}

export interface IndexClientDeps {
  /** `out/main/index-host.js`. */
  readonly entry: string
  readonly open: IndexOpenParams
  readonly canonical: CanonicalSources
  readonly events: IndexClientEvents
  /** Override of the per-method limits (for tests). Defaults to `CALL_TIMEOUT_MS`. */
  readonly timeouts?: Readonly<Record<string, number>>
  /** Override of the limit for waiting for `ready` (for tests, TODO 854). Defaults to `READY_TIMEOUT_MS`. */
  readonly readyTimeoutMs?: number
}

const INITIAL_SCAN_STATUS: ScanStatus = {
  state: 'idle',
  seen: 0,
  indexed: 0,
  excluded: 0,
  denied: 0,
  deniedExamples: [],
  startedAt: null,
  finishedAt: null,
  message: null,
  lastFullScanAt: null,
  skipped: false,
  nextFullScanAt: null,
  tccDeferredUntil: null
}

const INITIAL_INDEX_STATUS: IndexStatus = {
  state: 'starting',
  documents: 0,
  indexed: 0,
  pending: 0,
  skipped: 0,
  failed: 0,
  chunks: 0,
  startedAt: null,
  finishedAt: null,
  message: null
}

/** Environment passed to the index process. **No environment variable of main is passed unless allowlisted** (A-1 of 7.8). */
function buildIndexEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string') env[key] = value
  }
  return env
}

export class IndexClient {
  private child: UtilityProcess | null = null
  private peer: RpcPeer | null = null
  /** Waiting for the response to `open`. **Until this resolves, all other requests wait here** (3.3). */
  private ready: Promise<void> = Promise.reject(new Error('index process not started'))
  private restarts = 0
  /** A marker that we stopped it ourselves. `exit` is not counted as a crash and there is no restart. */
  private stopping = false
  /** Whether the current child has finished `open` (TODO 854). `whenReady` looks at it. */
  private readyNow = false
  /** Whether any child has finished `open` so far. Used to decide whether a restart resumes the build (TODO 854). */
  private everReady = false
  /** Scanning has been requested (`startScanning`). From then on a child that becomes ready always gets `start` (TODO 854). */
  private wantScan = false
  /** The child that `start` (scan) has already been sent to. Not sent twice to the same child: the launch sequence is in the one place `afterReady` (TODO 854). */
  private scanStartedFor: UtilityProcess | null = null
  /** Those waiting for the next ready (`whenReady`). Rejected when we give up or stop (TODO 854). */
  private readyWaiters: { resolve: () => void; reject: (err: Error) => void }[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The entry point that rejects the current child's `ready` (TODO 926). If a child ends without emitting `spawn`, or `stop()` kills it,
   * there is neither a response to `open` nor anyone for `rejectAll` to catch, and a `call()` that had already `await`ed that `ready` waited forever.
   * `crashed()` / `stop()` always release the previous one with this before replacing it (nothing happens if it is already settled).
   */
  private rejectReady: ((err: Error) => void) | null = null
  /** The child that emitted `spawn` (TODO 926). A child before that has not opened the DB, so `stop()` kills it without sending `stop`. */
  private spawnedChild: UtilityProcess | null = null
  private scanStatus: ScanStatus = INITIAL_SCAN_STATUS
  private indexStatus: IndexStatus = INITIAL_INDEX_STATUS

  constructor(private readonly deps: IndexClientDeps) {
    // So that it does not crash on an unhandled rejection. start() replaces it with the real one.
    this.ready.catch(() => undefined)
  }

  /** Method table for reverse RPC (3.4). **Anything not here is not accepted.** */
  private canonicalMethods(): RpcMethods {
    const { conversation, transcripts, plugins } = this.deps.canonical
    return {
      'conversation.readEventText': (params) =>
        conversation.readEventText(String((params as { eventId: string }).eventId)),
      'conversation.threadTitle': (params) =>
        conversation.threadTitle(String((params as { threadId: string }).threadId)),
      'conversation.liveEventIds': (params) => {
        const raw = (params as { eventIds?: unknown }).eventIds
        const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
        return conversation.liveEventIds === undefined ? ids : conversation.liveEventIds(ids)
      },
      'transcript.readMessageText': async (params) => {
        if (transcripts === null) return null
        const { fileId, messageId, locator } = params as {
          fileId: string
          messageId: string
          locator?: unknown
        }
        const result = await transcripts.readMessageText(
          String(fileId),
          String(messageId),
          asLocator(locator)
        )
        // The locations were stale (item 78). Re-ingest only that file to refresh the record.
        // The parse remains in the Adapter's LRU, so a second parse does not happen here.
        if (result.stale) this.refreshTranscript(String(fileId))
        // The file itself is gone (item 241, ENOENT). Send a request to drop it from the index.
        // The Adapter side limits the warning to once per `fileId`, so calling here repeatedly is
        // fine (`removeTranscriptFile` is safe to call any number of times), but to avoid sending the RPC
        // many times for the remaining hits of the same search, it is narrowed with `droppingMissing`.
        if (result.missing) this.dropMissingTranscript(String(fileId))
        return result.text
      },
      'plugin.read': (params) => {
        const { source, sourceId } = params as { source: string; sourceId: string }
        return plugins.read(source, sourceId)
      }
    }
  }

  /**
   * Start the index process and wait until the first child's `open` returns (= `ready`). **Never throws** (TODO 854):
   * a crash right after launch is put on the restart path (`crashed`), and on a timeout the child is not killed and waiting continues. In both cases this just returns `false`.
   * The index is an additional feature, so conversations, approvals and viewers keep working even if it does not start (state in `indexStatus`).
   * Callers who want to wait for it to become ready later use `whenReady()`.
   */
  async start(): Promise<boolean> {
    this.stopping = false
    this.spawn()
    const ready = this.ready
    let timer: ReturnType<typeof setTimeout> | undefined
    const slow = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        log.warn('index.client.ready.slow', {})
        resolve(false)
      }, this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS)
    })
    try {
      // On timeout, do not kill the child; just resolve with `false`. An `open` that returns late is picked up by `afterReady`.
      return await Promise.race([ready.then(() => true), slow])
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Resolves when the next (any) child becomes ready (TODO 854). Resolves immediately if it is ready now.
   * Rejects if the restart limit was exceeded or `stop()` was called. The launch-time ingestion waits on this.
   */
  whenReady(): Promise<void> {
    if (this.readyNow && this.peer !== null) return Promise.resolve()
    if (this.stopping) return Promise.reject(new Error('index process is stopping'))
    if (this.indexStatus.state === 'error' && this.child === null && this.restartTimer === null) {
      return Promise.reject(new Error('index process gave up restarting'))
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject })
    })
  }

  private settleWaiters(err: Error | null): void {
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const waiter of waiters) {
      if (err === null) waiter.resolve()
      else waiter.reject(err)
    }
  }

  private spawn(): void {
    this.readyNow = false
    const child = utilityProcess.fork(this.deps.entry, [], {
      serviceName: 'aios-index',
      stdio: 'pipe',
      env: buildIndexEnv(process.env)
    })
    this.child = child
    const restarted = this.everReady

    const peer = new RpcPeer(
      (message) => child.postMessage(message),
      this.canonicalMethods(),
      (notify) => this.onNotify(notify.event, notify.payload)
    )
    this.peer = peer

    // Lines from the index process are also written to the file by main (TODO 376, 12.9.1). main re-attaches `proc`.
    const out = createRelay({ proc: 'index', fallback: 'info', trusted: true })
    const err = createRelay({ proc: 'index', fallback: 'warn', trusted: true })
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stdout?.on('end', () => out.end())
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    child.stderr?.on('end', () => err.end())
    child.on('message', (raw: unknown) => peer.receive(raw as IndexRpcMessage))
    child.on('exit', (code) => this.onExit(child, code))

    // `open` is sent right after spawn. **The key is passed here** (not put in argv / env).
    // A failed `open` is treated the same as "crashed" (TODO 854): detach and kill the child and put it on the restart path
    // (limit and exponential wait unchanged). **It is not killed on a timeout** (wave 42 code-review):
    // in an environment where `open` takes 20 seconds, e.g. for WAL recovery, it used to be killed at 15 seconds every time and give up at the restart limit.
    // While the child is alive it keeps waiting for the `open` response, and when it returns late it becomes ready (`start()`
    // waits only up to the limit, and bootstrap is not stopped).
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject
      const fail = (failure: Error, reason: string): void => {
        reject(failure)
        if (this.child !== child) return
        this.crashed(child, null, reason)
        child.kill()
      }
      child.once('spawn', () => {
        this.spawnedChild = child
        peer.request('open', this.deps.open).then(
          () => {
            if (this.child !== child) return
            this.restarts = 0
            this.readyNow = true
            this.everReady = true
            resolve()
          },
          (openErr: unknown) =>
            fail(openErr instanceof Error ? openErr : new Error(String(openErr)), 'open-failed')
        )
      })
    })
    this.ready.catch((readyErr: unknown) => log.error('index.client.ready.failed', errorFields(readyErr)))
    void this.ready.then(
      () => this.afterReady(child, restarted),
      () => undefined
    )
  }

  /**
   * The sequence after a child becomes ready (TODO 854). **The launch sequence is in this one place**: for both the first launch and
   * a restart, the scan (`start`) is sent exactly once per child. Even if `bootstrap`'s `startScanning` and a
   * restart overlap, it is not duplicated. Resuming the build (`index.resume`) is only for a restart
   * (at the first launch, `bootstrap` calls it after the ingestion).
   */
  private afterReady(child: UtilityProcess, restarted: boolean): void {
    if (this.child !== child || this.stopping) return
    // Flush the "delete" notices queued before launch or during a restart wait ahead of everything else (TODO 860).
    this.flushWrites()
    this.settleWaiters(null)
    if (!this.wantScan && !restarted) return
    // The resume position is held by `documents.index_state = 'pending'`, so
    // there is no state to carry over (3.7). Just start the scan and build again.
    this.scanStartedFor = child
    void this.call('start', {})
      .then(() => (restarted ? this.call('index.resume', {}) : undefined))
      .catch((startErr: unknown) => log.warn('index.client.restart.failed', errorFields(startErr)))
  }

  private onNotify(event: string, payload: unknown): void {
    if (event === 'scanStatus') {
      this.scanStatus = payload as ScanStatus
      this.deps.events.onScanStatus(this.scanStatus)
      return
    }
    if (event === 'indexStatus') {
      this.indexStatus = payload as IndexStatus
      this.deps.events.onIndexStatus(this.indexStatus)
      return
    }
    if (event === 'fileChanges') {
      this.deps.events.onFileChanges(payload as FileChangeBatch)
      return
    }
    if (event === 'rules') {
      this.deps.events.onRules(payload as IndexRulesPayload)
    }
  }

  private onExit(child: UtilityProcess, code: number): void {
    this.crashed(child, code, 'exit')
  }

  /**
   * A child crashed / did not start (TODO 854). Detach the child, reject the unanswered, and, up to the limit,
   * start it again with an exponential wait. A child that was already detached (an `exit` after killing it for a failed `open`, etc.) does nothing.
   */
  private crashed(child: UtilityProcess, code: number | null, reason: string): void {
    if (this.child !== child) return
    this.child = null
    this.readyNow = false
    if (this.scanStartedFor === child) this.scanStartedFor = null
    const peer = this.peer
    this.peer = null
    const err = new Error('index process exited')
    err.name = INDEX_PROCESS_CRASHED
    peer?.rejectAll(err)
    // Release a `call()` that is waiting for the `ready` of a child that ended before `spawn` (TODO 926).
    this.rejectReady?.(err)
    this.rejectReady = null
    this.ready = Promise.reject(err)
    this.ready.catch(() => undefined)

    if (this.stopping) return
    // Do not leave the `scanning` + count from just before the crash (item 87). Continuing to show
    // "scanning" until the new process's notification arrives would be a lie. The last completion time and the next scheduled
    // time come from the DB and do not change, so they stay. The same applies when the restart limit is exceeded (there is no scan any more).
    this.resetScanStatus()
    // The code of `UtilityProcess.kill()` is 0 (measured in Phase 4). An external signal or
    // an exception gives non-zero, so what arrives at `exit` is only a real crash. What we kill ourselves is
    // a failed `open`, and then the child is detached first, so the `exit` is dropped above.
    this.restarts += 1
    log.warn('index.client.crashed', { code, reason, restarts: this.restarts })
    if (this.restarts > MAX_RESTARTS) {
      this.indexStatus = {
        ...this.indexStatus,
        state: 'error',
        // The wording is in the renderer's dictionary (7.4.4, TODO 66). Only a reason code here.
        message: 'index-restart-failed' satisfies ReasonCode
      }
      this.deps.events.onIndexStatus(this.indexStatus)
      this.settleWaiters(new Error('index process gave up restarting'))
      return
    }
    this.indexStatus = {
      ...this.indexStatus,
      state: 'starting',
      message: 'index-restarting' satisfies ReasonCode
    }
    this.deps.events.onIndexStatus(this.indexStatus)
    const delay = RESTART_BASE_DELAY_MS * 2 ** (this.restarts - 1)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      // The sequence (the scan's `start` and the build's `index.resume`) is held by `afterReady`.
      this.spawn()
    }, delay)
  }

  private resetScanStatus(): void {
    this.scanStatus = {
      ...INITIAL_SCAN_STATUS,
      lastFullScanAt: this.scanStatus.lastFullScanAt,
      nextFullScanAt: this.scanStatus.nextFullScanAt,
      tccDeferredUntil: this.scanStatus.tccDeferredUntil
    }
    this.deps.events.onScanStatus(this.scanStatus)
  }

  /**
   * Wait for `ready`, then one round trip. A request that arrives before launch waits here (3.3).
   * A method listed in `CALL_TIMEOUT_MS` rejects with `index-busy` once past its limit (item 87).
   */
  private async call(method: string, params: unknown): Promise<unknown> {
    await this.ready
    const peer = this.peer
    if (peer === null) throw new Error('index process is not running')
    const timeoutMs = this.deps.timeouts?.[method] ?? CALL_TIMEOUT_MS[method]
    try {
      return await peer.request(method, params, timeoutMs === undefined ? {} : { timeoutMs })
    } catch (err) {
      if (err instanceof Error && err.name === RPC_TIMEOUT && timeoutMs !== undefined) {
        log.warn('index.client.busy', { method, timeoutMs })
        const busy = reasonError('index-busy', { seconds: Math.ceil(timeoutMs / 1000) })
        busy.name = INDEX_PROCESS_BUSY
        throw busy
      }
      throw err
    }
  }

  // ---- scan / files (the index side of the old FsService) ----

  /**
   * Material for the pace stages of periodic scanning and index building (6.2.2 / TODO 434). `powerMonitor` exists only in main, so
   * it is sent at a fixed interval. **It does not wait**: if it does not arrive, the index process keeps walking at low speed as "in use".
   * If heat is `serious` or above / Low Power Mode, the index process stops building and scanning and waits.
   */
  reportPower(report: IndexPowerReport): void {
    if (this.peer === null) return
    void this.call('power', { ...report }).catch(() => undefined)
  }

  /**
   * Start the scan (`FsIndexer.start`). The index process takes care of decisions and watching. **Never throws** (TODO 854):
   * if the current child is not ready, only a marker is set, and `afterReady` sends it to the child that becomes ready.
   * If it was already sent to the current child, do nothing (do not duplicate the restart sequence).
   */
  async startScanning(): Promise<void> {
    this.wantScan = true
    const child = this.child
    if (!this.readyNow || child === null || this.scanStartedFor === child) return
    this.scanStartedFor = child
    try {
      await this.call('start', {})
    } catch (err) {
      log.warn('index.client.startScanning.failed', errorFields(err))
    }
  }

  getScanStatus(): ScanStatus {
    return this.scanStatus
  }

  async listDirectory(uri: string, options: ListDirectoryOptions = {}): Promise<DirectoryListing> {
    return (await this.call('fs.listDirectory', { uri, ...options })) as DirectoryListing
  }

  /**
   * `cwdUri` / `scopeUri` (the scope of TODO 437) have gone through main's choke point (`FsAccess.assertAllowed`).
   * The index process side checks again.
   */
  async searchFiles(
    query: string,
    limit?: number,
    cwdUri?: string,
    scopeUri?: string
  ): Promise<FileSearchResult> {
    return (await this.call('fs.searchFiles', {
      query,
      ...(limit === undefined ? {} : { limit }),
      ...(cwdUri === undefined ? {} : { cwdUri }),
      ...(scopeUri === undefined ? {} : { scopeUri })
    })) as FileSearchResult
  }

  /**
   * Re-searching for links in an answer (code-review of TODO 816). The same matching as `searchFiles`, but it does not advance the generation of
   * the user's search (Cmd+P / Sidebar) and is not cut off by it. No cwd or scope is attached (whole range).
   */
  async searchFilesForLink(query: string, limit: number): Promise<FileSearchResult> {
    return (await this.call('fs.searchFilesForLink', { query, limit })) as FileSearchResult
  }

  /**
   * The gateway's `searchFiles` (TODO 1158, 7.6.1). The same matching as Cmd+P, but it does not advance the generation of the user's search and is not cut off by it.
   * `cwdUri` is the conversation's working folder (having gone through main's choke point). Matches inside it are returned split into the `cwd` section.
   */
  async searchFilesForAgent(query: string, limit: number, cwdUri?: string): Promise<FileSearchResult> {
    return (await this.call('fs.searchFilesForAgent', {
      query,
      limit,
      ...(cwdUri === undefined ? {} : { cwdUri })
    })) as FileSearchResult
  }

  /**
   * Have the subtree of a scope (TODO 437) built, and receive the number of bodies still waiting. `uri` has gone through main's choke point
   * (the index process side checks again and rejects if refused).
   */
  async buildScope(uri: string): Promise<ScopeBuildResult> {
    return (await this.call('index.buildScope', { uri })) as ScopeBuildResult
  }

  async rescan(): Promise<void> {
    await this.call('fs.rescan', {})
  }

  /**
   * End the scan / watch deferral for protected folders (TODO 805). Without `uri` it is the setting's "include now"; with one, it is a folder
   * added to the reference scope (the index process ends it only when it is inside a protected folder). It does not wait for the scan.
   */
  async releaseTccDeferral(uri?: string): Promise<void> {
    await this.call('fs.releaseTccDeferral', uri === undefined ? {} : { uri })
  }

  /**
   * Have the subtree of `path` incrementally scanned right now (item 246, 6.2.2). SessionManager calls it once when a
   * thread is created. **It does not wait**: the choke point, merging and limits are on the index process side, and
   * the result (and failure) is only left in the debug log. `fs.scanSubtree` is not put in `CALL_TIMEOUT_MS`
   * (it is not a request the screen waits on, and the index process side cuts it off at 10 seconds).
   */
  scanSubtree(path: string): void {
    void this.call('fs.scanSubtree', { path })
      .then((result) => {
        const outcome = result as SubtreeScanResult
        log.debug('index.client.scanSubtree', {
          path,
          state: outcome.state,
          ...(outcome.state === 'skipped' ? { reason: outcome.reason } : {})
        })
      })
      .catch((err: unknown) =>
        log.debug('index.client.scanSubtree.failed', { path, ...errorFields(err) })
      )
  }

  /**
   * Have files / folders created from the Files tree (TODO 370) put in the index without waiting for the watch.
   * When the reflection is done, the index process notifies `fileChanges`, and the renderer's tree re-fetches the parent's list.
   * The URIs have gone through main's choke point (`createEntry`). The index process side checks again.
   */
  async noteCreated(uris: readonly string[]): Promise<void> {
    await this.call('fs.noteCreated', { uris })
  }

  async listVolumes(): Promise<readonly VolumeEntry[]> {
    return (await this.call('fs.listVolumes', {})) as readonly VolumeEntry[]
  }

  async setVolumeAllowed(uri: string, allowed: boolean): Promise<readonly VolumeEntry[]> {
    return (await this.call('fs.setVolumeAllowed', { uri, allowed })) as readonly VolumeEntry[]
  }

  /** Directories refused by the scan (newest first, item 84). The display (the permanent banner of 12.8) does not exist yet. */
  async recentDenials(limit = 100): Promise<readonly ScanDenial[]> {
    return (await this.call('fs.recentDenials', { limit })) as readonly ScanDenial[]
  }

  /**
   * Candidates for "recent files" (TODO 999). The index process narrows them by extension, exclusion and hidden folders, and returns them with bulk updates marked.
   * The git and AI decisions belong to the caller (`src/main/recent/`). `parentUri` is passed after going through main's choke point (the index side checks again).
   */
  async recentFiles(params: {
    readonly sinceMs: number
    readonly limit: number
    readonly parentUri?: string
  }): Promise<readonly RecentCandidate[]> {
    return (await this.call('fs.recentFiles', params)) as readonly RecentCandidate[]
  }

  // ---- index (6.1 / 6.4 / 7.6.1) ----

  getStatus(): IndexStatus {
    return this.indexStatus
  }

  /** Breakdown of the DB (TODO 846 / 914 / 988). The index process measures it. main writes no SQL. */
  async measureDatabase(): Promise<DbBreakdown> {
    return (await this.call('index.measureDatabase', { top: 30 })) as DbBreakdown
  }

  /** TODO 1306: the light check of the DB (`quick_check` per table). The index process runs it; main writes no SQL. */
  async quickCheck(): Promise<DbQuickCheckResult> {
    return (await this.call('index.quickCheck', {})) as DbQuickCheckResult
  }

  async search(
    query: string,
    scope: SearchScope,
    options: {
      limit?: number
      forAgent?: boolean
      sources?: readonly string[]
      /**
       * Query number of the UI's incremental search (P6). **Carry it to the index process
       * as is**: the decision to discard a search with an old number without running SQL
       * is on that side. If it is dropped here, cancellation silently stops working.
       */
      seq?: number
      /**
       * The originating window of the query (the renderer's webContents id, TODO 497). `seq` is compared within this window.
       * When the window is closed / reloaded, clear the ledger with `forgetSearchOrigin`.
       */
      origin?: number
      /**
       * The current working folder (item 100). Pass a validated URI. In-file search is a subtree, and conversation search
       * builds the "this working folder" section together with `threadIds` (TODO 1096).
       */
      cwdUri?: string
      /**
       * Threads for the "this working folder" section of conversation search (TODO 1096). The ids of threads whose cwd is that folder (or under it),
       * which main looks up from the thread table. Effective only when passed together with `cwdUri`.
       */
      threadIds?: readonly string[]
      /** The scope of the Search screen (TODO 437). Affects in-file search only and takes priority over cwd. Pass a validated URI. */
      scopeUri?: string
    } = {}
  ): Promise<SearchResponse> {
    return (await this.call('index.search', { query, scope, options })) as SearchResponse
  }

  /**
   * In-thread search (TODO 496, ARCHITECTURE 6.1.1). Narrows the conversation search index to one thread. `seq` is a separate sequence from conversation search
   * and is compared per `origin` (window) (P6 / TODO 497).
   */
  async searchThread(
    query: string,
    threadId: string,
    options: { seq?: number; origin?: number } = {}
  ): Promise<ThreadSearchResponse> {
    return (await this.call('index.searchThread', { query, threadId, options })) as ThreadSearchResponse
  }

  /**
   * A window (the renderer's webContents) was closed / reloaded (TODO 497). Clears the ledger of that window's query numbers
   * held by the index process. It does not wait for a response (if the index process has restarted, the ledger is already gone).
   */
  forgetSearchOrigin(origin: number): void {
    // On shutdown `stop()` runs first and the windows are closed after it; the index process is already gone, so do nothing
    // (wave 25 code-review: a `forgetOrigin.failed` warning used to appear for every window).
    if (this.stopping || this.peer === null) return
    void this.call('index.forgetOrigin', { origin }).catch((err: unknown) =>
      log.warn('index.client.forgetOrigin.failed', errorFields(err))
    )
  }

  async pause(): Promise<void> {
    await this.call('index.pause', {})
  }

  /** `manual` is when the user pressed "Resume" (does not go through the idle check, P4). */
  async resume(options: { manual?: boolean } = {}): Promise<void> {
    await this.call('index.resume', { manual: options.manual === true })
  }

  async getDocument(
    id: string,
    limitBytes: number,
    forAgent: boolean
  ): Promise<Record<string, unknown> | null> {
    return (await this.call('index.getDocument', { id, limitBytes, forAgent })) as Record<
      string,
      unknown
    > | null
  }

  /** TODO 1235: `(source, sourceId)` or uri -> one document id (or the reason there is none). The SQL runs in the index process. */
  async resolveDocument(
    query: { uri?: string; source?: string; sourceId?: string },
    forAgent: boolean
  ): Promise<{ id: string } | { reason: 'not-found' | 'ambiguous' | 'unsupported' | 'source-required' }> {
    return (await this.call('index.resolveDocument', { ...query, forAgent })) as
      | { id: string }
      | { reason: 'not-found' | 'ambiguous' | 'unsupported' | 'source-required' }
  }

  async getDocumentText(
    id: string,
    offset: number,
    length: number,
    forAgent: boolean
  ): Promise<Record<string, unknown> | null> {
    return (await this.call('index.getDocumentText', {
      id,
      offset,
      length,
      forAgent
    })) as Record<string, unknown> | null
  }

  async getChunk(id: string, forAgent: boolean): Promise<Record<string, unknown> | null> {
    return (await this.call('index.getChunk', { id, forAgent })) as Record<
      string,
      unknown
    > | null
  }

  /**
   * Submit conversation events. **It does not wait** (the caller is SessionManager's synchronous path).
   *
   * It is put on the **same queue** (`pendingWrites`) as the delete notices (TODO 875). It used to be sent with `call()`, so when the index process was
   * before launch or in a restart wait (`ready` still rejected), it failed immediately and vanished, and only the deletes queued meanwhile flowed later.
   * If "delete a thread in the trash -> restore" hit a restart wait, the restore's rebuild (`SessionManager.reindexThread`)
   * failed, and the delete emptied the index of the restored thread (it did not appear in search until the full re-send every 7 days). With the same queue,
   * they reach the index process in the order queued, and the index process's write queue (`IndexService.enqueue`) also handles them in arrival order.
   * Once restarting has been given up, nothing is queued (do not keep accumulating for a child that receives nothing).
   */
  indexConversationEvents(
    events: readonly { id: string; threadId: string; title: string; ts: number }[]
  ): void {
    if (events.length === 0 || this.stopping || this.restarts > MAX_RESTARTS) return
    this.eventsSeq += 1
    this.queueWrite(`events:${this.eventsSeq}`, { method: 'index.conversationEvents', params: { events } })
  }

  /** Serial number for the keys of `indexConversationEvents` (submissions do not replace each other: each one has its own key). */
  private eventsSeq = 0

  /**
   * Launch-time ingestion (item 76). **It waits**: it returns how many items from the start the index process
   * finished processing, and the caller (`conversation-backfill.ts`) advances the high-water mark up to there.
   */
  async backfillConversationEvents(
    events: readonly { id: string; threadId: string; title: string; ts: number }[]
  ): Promise<number> {
    if (events.length === 0) return 0
    const handled = await this.call('index.conversationEvents', { events })
    return typeof handled === 'number' ? handled : 0
  }

  /**
   * Notices to delete from the conversation index (TODO 860) and submissions of conversation events (TODO 875). **They are not dropped**: whatever was queued because the index process was not ready (before launch or
   * in a restart wait) or because sending failed is kept here, and `afterReady` flushes it first of all to the
   * next child that becomes ready. All are safe to send any number of times (delete only / upsert), so those not known to have arrived are re-sent.
   * The key is `all` / `thread:<id>` / `prune:<id>` / `events:<serial number>`. Memory only: for what spans a quit, retention is
   * re-notified for all threads by `applyRetention` at the next launch, and the rest is dropped by the index process itself when a search
   * finds a hit with no canonical copy (`IndexService.collectHits`).
   */
  private readonly pendingWrites = new Map<string, ConversationWrite>()

  /** A thread was deleted / the log was deleted (the tombstone of 6.2). It does not wait. */
  removeThread(threadId: string): void {
    this.pendingWrites.delete(`prune:${threadId}`)
    this.queueWrite(`thread:${threadId}`, { method: 'index.removeThread', params: { threadId } })
  }

  /** Delete all conversation logs (4.3.1). Everything queued before it is covered by this. */
  removeAllConversations(): void {
    this.pendingWrites.clear()
    this.queueWrite('all', { method: 'index.removeAllConversations', params: {} })
  }

  /**
   * Also remove from the conversation index what was deleted from the canonical copy by the retention period (4.3.1, TODO 860). `before` means "messages of this thread
   * with `ts < before` are gone", and null means "this thread has no messages at all". It does not wait.
   */
  pruneConversations(items: readonly { threadId: string; before: number | null }[]): void {
    const prunes: { threadId: string; before: number }[] = []
    for (const item of items) {
      if (item.before === null) {
        this.removeThread(item.threadId)
        continue
      }
      prunes.push({ threadId: item.threadId, before: item.before })
    }
    for (const item of prunes) {
      if (this.pendingWrites.has(`thread:${item.threadId}`)) continue
      this.queueWrite(`prune:${item.threadId}`, {
        method: 'index.pruneConversations',
        params: { items: [item] }
      })
    }
  }

  /**
   * Launch-time cleanup of the conversation index (TODO 863). `pendingWrites` is memory only, so if a thread is deleted while waiting for the
   * index process to restart and the app quits, the "delete" notice is lost. Retention's part is re-sent by `applyRetention` at every launch, but
   * a soft-deleted thread leaves its canonical row, so there is nothing to re-send from. So it asks the index for the thread ids that have conversation documents
   * and calls `removeThread` on those not in `liveThreadIds` (threads that are not soft-deleted).
   * Whether a thread is alive is read **after** receiving the list: a thread restored in between stays, and one deleted is dropped
   * (the restore's re-send is lined up in the index process's queue after the delete queued here). Returns the number deleted (notices sent).
   */
  async sweepGoneConversationThreads(liveThreadIds: () => ReadonlySet<string> | null): Promise<number> {
    let indexed: readonly string[]
    try {
      const reply = await this.call('index.listConversationThreadIds', {})
      indexed = Array.isArray(reply) ? reply.filter((id): id is string => typeof id === 'string') : []
    } catch (err) {
      log.warn('index.client.conversationSweep.failed', errorFields(err))
      return 0
    }
    if (indexed.length === 0) return 0
    // null means "can no longer be read" (shutdown has begun). Do nothing.
    const live = liveThreadIds()
    if (live === null || this.stopping) return 0
    let removed = 0
    for (const threadId of indexed) {
      if (live.has(threadId)) continue
      this.removeThread(threadId)
      removed += 1
    }
    if (removed > 0) log.info('index.client.conversationSweep', { threads: removed })
    return removed
  }

  private queueWrite(key: string, removal: ConversationWrite): void {
    // An old notice of the same key is replaced by the new one (a Map keeps order, so the deletion order is not disturbed).
    this.pendingWrites.delete(key)
    this.pendingWrites.set(key, removal)
    this.flushWrites()
  }

  /**
   * Flush the queued notices if the current child is ready. They are sent directly to `peer` without `call()`: when called from `afterReady`,
   * it is to line them up in the index process's queue ahead of other requests that were waiting for `ready` (the launch-time ingestion, etc.)
   * (if they came after, a delete-all could erase even newly inserted messages). Conversation submissions are in the order queued within this queue.
   */
  private flushWrites(): void {
    const peer = this.peer
    if (!this.readyNow || peer === null || this.stopping || this.pendingWrites.size === 0) return
    const batch = [...this.pendingWrites.entries()]
    this.pendingWrites.clear()
    for (const [key, removal] of batch) {
      void peer.request(removal.method, removal.params).catch((err: unknown) => {
        if (removal.method === 'index.conversationEvents') {
          log.warn('index.client.conversationEvents.failed', errorFields(err))
          // Re-queue only what did not arrive because the child crashed (TODO 875). The reject at the crash comes in the
          // microtask right after `crashed`, in the order sent together with the other notices of the same batch, so re-queuing does not break the order.
          // What a live child threw is dropped as before (re-sending would throw the same).
          if (this.stopping || !(err instanceof Error) || err.name !== INDEX_PROCESS_CRASHED) return
          this.pendingWrites.set(key, removal)
          return
        }
        log.warn('index.client.removal.failed', { method: removal.method, ...errorFields(err) })
        if (this.stopping) return
        // Not known whether it arrived. If a newer notice with the same key queued later, or a delete-all, exists, leave it to that.
        // It is not re-flushed here (if a live child threw it, re-sending immediately would throw again and loop).
        // It flows together at the next ready (after a crash) or when the next notice is queued.
        if (this.pendingWrites.has(key) || this.pendingWrites.has('all')) return
        this.pendingWrites.set(key, removal)
      })
    }
  }

  /**
   * Transcript ingestion (12.7). **The file is opened by main (the Adapter)**, and
   * only the body is passed to the index process: the location and format of transcripts are in the domain of constraint 6.
   */
  async indexTranscripts(): Promise<number> {
    const feed = this.deps.canonical.transcripts
    if (feed === null) return 0
    const files = await feed.listFiles()
    let added = 0
    for (const file of files) {
      added += await this.indexTranscriptFile(feed, file.id)
    }
    const removed = await this.removeVanishedTranscripts(files)
    log.info('index.transcripts.done', { files: files.length, messages: added, removed })
    return added
  }

  /**
   * The launch-time ingestion drops the rows of "files not in the list (= gone)" (item 241).
   * `listFiles()` silently skips vanished files, so what had been put in the index up to last time
   * did not go through `indexTranscriptFile` and stayed until the next search hit on that file
   * (`dropMissingTranscript`). At every launch, the transcript file ids in the index now are
   * compared with this time's list, and those not present are dropped together.
   */
  private async removeVanishedTranscripts(files: readonly { id: string }[]): Promise<number> {
    let indexed: readonly string[]
    try {
      indexed = (await this.call('index.listTranscriptFileIds', {})) as readonly string[]
    } catch (err) {
      log.warn('index.client.transcriptVanished.failed', errorFields(err))
      return 0
    }
    const present = new Set(files.map((file) => file.id))
    const vanished = indexed.filter((fileId) => !present.has(fileId))
    let removed = 0
    for (const fileId of vanished) {
      removed += (await this.call('index.removeTranscript', { fileId })) as number
      this.droppedMissing.add(fileId)
    }
    return removed
  }

  /**
   * Read one transcript file and hand it to the index process. **`version` is the version of the fd that was read**
   * (not the stat from `listFiles`): the locations (item 78) are valid against this version,
   * so the record does not drift even if something is appended between the listing and the read.
   */
  private async indexTranscriptFile(feed: TranscriptFeed, fileId: string): Promise<number> {
    const content = await feed.readMessages(fileId)
    if (content === null) return 0
    // Transcripts of conversations that aios owns are not included / only up to the read limit (item 111). Drop what was included before
    // (before this version, aios's own conversations were also double-included as transcripts).
    const owned = this.deps.canonical.ownedTranscripts?.() ?? new Map<string, number | null>()
    const filtered = filterOwnedTranscript(content.sessionId, content.messages, owned)
    if (filtered.skip) {
      await this.call('index.removeTranscript', { fileId: content.id })
      return 0
    }
    return (await this.call('index.transcriptMessages', {
      file: { id: content.id, uri: content.uri, version: content.version },
      messages: filtered.messages
    })) as number
  }

  /** Files currently being re-ingested. So that 50 hits in the same search do not run it 50 times. */
  private readonly refreshing = new Set<string>()

  /** Re-ingest a file whose locations were stale (item 78). A failure does not break the search. */
  private refreshTranscript(fileId: string): void {
    const feed = this.deps.canonical.transcripts
    if (feed === null || this.stopping || this.refreshing.has(fileId)) return
    this.refreshing.add(fileId)
    void this.indexTranscriptFile(feed, fileId)
      .catch((err: unknown) => log.warn('index.client.transcriptRefresh.failed', errorFields(err)))
      .finally(() => this.refreshing.delete(fileId))
  }

  /**
   * Drop from the index a transcript found to have no file (ENOENT) (item 241). During one process's lifetime,
   * `index.removeTranscript` is sent only once per `fileId`: there can be dozens of hits on a vanished file
   * within the same search, but once it is dropped, that file no longer hits.
   */
  private readonly droppedMissing = new Set<string>()

  private dropMissingTranscript(fileId: string): void {
    if (this.stopping || this.droppedMissing.has(fileId)) return
    this.droppedMissing.add(fileId)
    void this.call('index.removeTranscript', { fileId }).catch((err: unknown) =>
      log.warn('index.client.transcriptDrop.failed', errorFields(err))
    )
  }

  async putPluginDocument(document: PluginDocumentInput): Promise<void> {
    await this.call('index.putPluginDocument', { document })
  }

  /** TODO 1237: uninstalling an extension. Delete all the index documents of its namespace (returns the number deleted). */
  async removePluginDocumentsOf(pluginId: string): Promise<number> {
    return (await this.call('index.removePluginDocumentsOf', { pluginId })) as number
  }

  async removePluginDocument(source: string, sourceId: string): Promise<void> {
    await this.call('index.removePluginDocument', { source, sourceId })
  }

  /**
   * Shutdown (3.6 / 12.9). Waits until the index process stops scanning and building, drains the queue, and
   * **closes its own DB**. Main closes the DB after this.
   * If it does not return, kill it and move on: being unable to quit because we keep waiting is the worse outcome.
   */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.settleWaiters(new Error('index process is stopping'))
    const child = this.child
    if (child === null) return
    try {
      // Cannot send to a child that has not reached `spawn` (`call` waits for `ready`). It has not opened the DB either, so kill it without waiting (TODO 926).
      if (this.spawnedChild !== child) throw new Error('index process has not spawned')
      await Promise.race([
        this.call('stop', {}),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('index process stop timeout')), STOP_TIMEOUT_MS)
        )
      ])
    } catch (err) {
      log.warn('index.client.stop.failed', errorFields(err))
    }
    const peer = this.peer
    this.child = null
    this.peer = null
    child.kill()
    // After the kill, `crashed` does nothing even if `exit` arrives (already detached). Release the unanswered requests and the `call()` waiting for the `ready` of
    // a child stopped before `spawn` here (TODO 926).
    const stopped = new Error('index process is stopping')
    peer?.rejectAll(stopped)
    this.rejectReady?.(stopped)
    this.rejectReady = null
    this.ready = Promise.reject(stopped)
    this.ready.catch(() => undefined)
  }
}
