/**
 * IndexKernel: bundles the contents of the index process into one and turns them into the RPC method table
 * (P1, ARCHITECTURE.md chapter 3 / 6.2).
 *
 * **It does not know about the port.** Only `src/index-host/index.ts` touches the transport (`process.parentPort`),
 * and this class holds only the table "method name -> implementation" and
 * the "4 entry points that ask main" (`KernelBridge.call`). Thanks to this,
 * tests can call the kernel directly without starting a process (3.8).
 *
 * What it holds (= everything that touches `documents` / `chunks` / `chunk_fts` / `scan_runs` /
 * `index_failures` / `scan_denials`):
 *
 * ```
 * IndexStore   -- the only entry point to the index tables
 * IndexService -- build / search / ingesting conversations, transcripts and plugin documents
 * FsIndexer    -- scan / watch / listing / file-name search / volumes
 * ```
 *
 * What it asks in the reverse direction (kernel -> main) is **only the canonical copy** (3.4). No second reader of
 * `thread_events` / `plugin_documents` is made in the index process (constraint 9).
 */
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { PluginDocumentInput } from '@shared/plugin.js'
import { asNameTerms, parseQueryFilter } from './query-filter.js'
import type { SearchScope } from '@shared/search.js'
import type { IndexOpenParams } from '@shared/index-rpc.js'
import { asListDirectoryOptions } from '@shared/types.js'
import { formatReason } from '@shared/reason.js'
import type { RpcMethods } from '../common/rpc.js'
import { openDatabaseFile } from '../common/db-open.js'
import { runMigrations } from '../common/migrations.js'
import { log, errorFields } from '../common/logger.js'
import { IndexStore } from './store.js'
import {
  IndexService,
  type IndexIdlePolicy,
  type TranscriptFile,
  type TranscriptMessageInput
} from './service.js'
import { FsIndexer } from './indexer.js'
import { pathFromUri } from '../common/fs-policy.js'
import { conversationCwdPathOf } from '../common/uri.js'
import type { VolumeRegistryOptions } from './volumes.js'
import type { ScanSchedulerOptions } from './scheduler.js'
import { configurePdfHelper, setPdfExtractor } from './pdf.js'
import { configureVisionHelper, setImageAnalyzer } from './image.js'
import { SlowPacer, asThermalState, type ThermalState } from './pace.js'

/** The entry point from the kernel to the outside (main). `index-host` connects it to RPC, and tests connect a fake. */
export interface KernelBridge {
  notify(event: 'scanStatus' | 'fileChanges' | 'indexStatus' | 'rules' | 'ready' | 'stopped', payload: unknown): void
  /** Asks main for the canonical copy (3.4). The methods are only the 4 below. */
  call(method: string, params: unknown): Promise<unknown>
}

export interface IndexKernelOptions {
  readonly volumes?: VolumeRegistryOptions
  readonly scheduler?: ScanSchedulerOptions
  /**
   * Idle decision for index building (P4). By default it looks at the `power` value that arrives from main.
   * **Passing `null` means no decision** (so tests can proceed without waiting for the build).
   */
  readonly idle?: IndexIdlePolicy | null
  /** Protected-folder deferral (TODO 805). Enabled by default. */
  readonly tccDeferral?: boolean
  /** Entry point replaced in tests. The default is `common/db-open.ts`. */
  readonly openFile?: (file: string, key: string | null) => Database
}

interface Opened {
  readonly db: Database
  readonly store: IndexStore
  readonly service: IndexService
  readonly indexer: FsIndexer
}

/** A small helper for reading `params` plainly. RPC arguments are always one object. */
function record(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
}

function asString(params: unknown, key: string): string {
  const value = record(params)[key]
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

/** An optional string (null if missing, not a string, or empty). */
function asOptionalString(params: unknown, key: string): string | null {
  const value = record(params)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** The query number (P6) and the window the query came from (TODO 497). Dropped if not a number (rounded to an integer). */
function seqOptions(options: unknown): { seq?: number; origin?: number } {
  const seq = record(options)['seq']
  const origin = record(options)['origin']
  return {
    ...(typeof seq === 'number' && Number.isFinite(seq) ? { seq: Math.trunc(seq) } : {}),
    ...(typeof origin === 'number' && Number.isFinite(origin) ? { origin: Math.trunc(origin) } : {})
  }
}

/** Upper bound on the number of thread ids in the conversation search section (TODO 1096). If exceeded, or if there is a non-string element, the section is not made. */
export const MAX_CWD_THREAD_IDS = 50_000

/** The thread ids of the conversation search section (TODO 1096). Only when it is an array of strings within the limit. An empty array passes as "no matches". */
function asThreadIds(value: unknown): readonly string[] | null {
  // A rejection is logged on the same line as the rejections of other searches (no values, only the count and the reason). A missing (undefined) one is not a rejection.
  const reject = (reason: string): null => {
    log.warn('index.search.rejected', {
      field: 'threadIds',
      reason,
      ...(Array.isArray(value) ? { count: value.length } : {})
    })
    return null
  }
  if (value === undefined) return null
  if (!Array.isArray(value)) return reject('not-array')
  if (value.length > MAX_CWD_THREAD_IDS) return reject('too-many')
  for (const id of value) if (typeof id !== 'string' || id === '' || id.length > 200) return reject('invalid-id')
  return value as string[]
}

function asNumber(params: unknown, key: string, fallback: number): number {
  const value = record(params)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export class IndexKernel {
  private opened: Opened | null = null
  private stopping: Promise<void> | null = null
  /**
   * Inputs for the pacing stage of scheduled scans and index builds (6.2.2 / TODO 434). `powerMonitor` exists only in
   * main, so this holds the values main sends at regular intervals. The initial value is "in use", so
   * until the first one arrives it walks slowly (before 434 it was "does not start"). `onBattery` stopped
   * affecting the stage in 434 (it is only received for the log and for the future).
   */
  private power: {
    idleSeconds: number
    onBattery: boolean
    thermalState: ThermalState
    lowPower: boolean
  } = { idleSeconds: 0, onBattery: false, thermalState: 'unknown', lowPower: false }
  /** How to walk at the slow stage (TODO 434). One is shared between building and scanning, and there is one log line. */
  private readonly pacer = new SlowPacer()

  constructor(
    private readonly bridge: KernelBridge,
    private readonly options: IndexKernelOptions = {}
  ) {}

  /** The RPC method table. **The list of strings is only here**; the main side calls with explicit methods. */
  readonly methods: RpcMethods = {
    open: (params) => this.open(params as IndexOpenParams),
    start: () => this.require().indexer.start(),
    stop: () => this.stop(),
    /**
     * Inputs for the pacing stage of scheduled scans and builds (6.2.2 / TODO 434). Holds main's `powerMonitor` values as they are.
     * It logs one line only when heat / Low Power Mode changes (the value every 5 seconds is not logged).
     */
    power: (params) => {
      const next = {
        idleSeconds: asNumber(params, 'idleSeconds', 0),
        onBattery: record(params)['onBattery'] === true,
        thermalState: asThermalState(record(params)['thermalState']),
        lowPower: record(params)['lowPower'] === true
      }
      if (
        next.thermalState !== this.power.thermalState ||
        next.lowPower !== this.power.lowPower
      ) {
        log.info('index.power.changed', {
          thermalState: next.thermalState,
          lowPower: next.lowPower,
          onBattery: next.onBattery
        })
      }
      this.power = next
    },

    'fs.listDirectory': (params) =>
      this.require().indexer.listDirectory(asString(params, 'uri'), asListDirectoryOptions(params)),
    'fs.searchFiles': (params) =>
      this.require().indexer.searchFiles(
        // File-name filters (TODO 813): `ext:md` -> `.md`, `name:X` -> `X`.
        asNameTerms(parseQueryFilter(asString(params, 'query'))),
        asNumber(params, 'limit', 200),
        asOptionalString(params, 'cwdUri'),
        // The scope (TODO 437). After main's gate, FsIndexer checks it once more.
        asOptionalString(params, 'scopeUri')
      ),
    // Re-looking up a link in an answer (code-review of TODO 816). It does not advance the user's search generation and is not cut off.
    'fs.searchFilesForLink': (params) =>
      this.require().indexer.searchFiles(asString(params, 'query'), asNumber(params, 'limit', 200), null, null, 'link'),
    // The gateway's `searchFiles` (TODO 1158, 7.6.1). The same matching as ⌘P (including the filters `ext:` / `name:` / `*.md`), and the cwd is the conversation's
    // working folder (after main's gate, FsIndexer checks it once more). It does not advance the user's search generation and is not cut off (the same road as 'link').
    'fs.searchFilesForAgent': (params) =>
      this.require().indexer.searchFiles(
        asNameTerms(parseQueryFilter(asString(params, 'query'))),
        asNumber(params, 'limit', 20),
        asOptionalString(params, 'cwdUri'),
        null,
        'link'
      ),
    'fs.getScanStatus': () => this.require().indexer.getScanStatus(),
    'fs.rescan': () => this.require().indexer.rescan(),
    // Subtree scan at thread creation (item 246, 6.2.2). The gate, merging and limits are on the FsIndexer side.
    'fs.scanSubtree': (params) => this.require().indexer.scanSubtree(asString(params, 'path')),
    // Puts things made from the Files tree (TODO 370) into the index without waiting for the watch. After main's gate, it is checked again here.
    'fs.noteCreated': (params) => {
      const uris = record(params)['uris']
      return this.require().indexer.noteCreated(
        Array.isArray(uris) ? uris.filter((uri): uri is string => typeof uri === 'string') : []
      )
    },
    // Ends the protected-folder deferral (TODO 805). Without `uri` = "include now" in settings; with one = added to the reference scope
    // (ends only if it is inside a protected folder). A broken URI does nothing.
    'fs.releaseTccDeferral': async (params) => {
      const uri = asOptionalString(params, 'uri')
      if (uri === null) return this.require().indexer.releaseTccDeferral('button')
      let path: string
      try {
        path = pathFromUri(uri)
      } catch {
        return
      }
      return this.require().indexer.releaseTccDeferral('reference', path)
    },
    // Candidates for "recent files" (TODO 999). The git and AI judgments are in main. `parentUri` is checked again at FsIndexer's gate.
    'fs.recentFiles': (params) =>
      this.require().indexer.recentFiles(
        asNumber(params, 'sinceMs', 0),
        asNumber(params, 'limit', 1000),
        asOptionalString(params, 'parentUri')
      ),
    'fs.listVolumes': () => this.require().indexer.listVolumes(),
    // Directories denied by the scan, newest first (item 84, the material for the permanent TCC banner).
    'fs.recentDenials': (params) => this.require().store.recentDenials(asNumber(params, 'limit', 100)),
    'fs.setVolumeAllowed': (params) =>
      this.require().indexer.setVolumeAllowed(
        asString(params, 'uri'),
        record(params)['allowed'] === true
      ),

    // In-thread search (TODO 496). Narrows the conversation search index to one thread and returns the ids of the matching messages, oldest first.
    'index.searchThread': (params) =>
      this.require().service.searchThread(
        asString(params, 'query'),
        asString(params, 'threadId'),
        seqOptions(record(params)['options'])
      ),
    // A window (the renderer's webContents) was closed / reloaded (TODO 497). Erases that window's ledger of query numbers.
    'index.forgetOrigin': (params) => {
      const origin = record(params)['origin']
      if (typeof origin === 'number' && Number.isFinite(origin)) this.require().service.forgetOrigin(Math.trunc(origin))
    },
    'index.search': (params) => {
      const scope: SearchScope = record(params)['scope'] === 'conversation' ? 'conversation' : 'files'
      const raw = record(record(params)['options'])
      const { cwdUri, scopeUri, threadIds, seq: _seq, origin: _origin, ...rest } = raw
      // The number and the window (P6 / TODO 497) are passed on after their types are checked.
      const options = { ...rest, ...seqOptions(raw) }
      // The cwd (item 100) URI is re-verified at FsIndexer's gate before use. For in-File search the section is built from a path and a subtree,
      // and for conversation search from thread ids (TODO 1096).
      const opened = this.require()
      // The scope (TODO 437) is also for in-File search only. If refused at the gate, 0 results (the scope is not dropped to return the whole index).
      const scopeValue =
        scope === 'files' && typeof scopeUri === 'string' && scopeUri !== '' ? scopeUri : null
      if (scopeValue !== null) {
        const scopePath = opened.indexer.indexedPathOf(scopeValue)
        if (scopePath === null) return { hits: [], total: 0, truncated: false, tookMs: 0 }
        return opened.service.search(asString(params, 'query'), scope, { ...options, scope: scopePath })
      }
      // The "this working folder" section of conversation search (TODO 1096). The cwd is only the original text of the heading, and narrowing is done by main with the thread
      // ids it looked up from the threads table (the index does not hold threads' cwds). The section is made even if the cwd is not in the index.
      // The URI is re-checked with the same `conversationCwdPathOf` as main (an absolute file: path without NUL): it does not read files, so
      // the file index's exclusion rules are not applied (review). If refused, no section is made.
      if (scope === 'conversation') {
        const label = typeof cwdUri === 'string' && conversationCwdPathOf(cwdUri) !== null ? cwdUri : null
        const ids = asThreadIds(threadIds)
        return opened.service.search(asString(params, 'query'), scope, {
          ...options,
          ...(label === null || ids === null ? {} : { cwdUri: label, threadIds: ids })
        })
      }
      const uri = typeof cwdUri === 'string' && cwdUri !== '' ? cwdUri : null
      const cwd = uri === null ? null : opened.indexer.indexedPathOf(uri)
      return opened.service.search(asString(params, 'query'), scope, {
        ...options,
        ...(cwd === null || uri === null ? {} : { cwd, cwdUri: uri })
      })
    },
    // Builds the subtree at the moment the scope (TODO 437) is decided (`buildSubtree` of item 249). The URI is checked again here
    // after main's gate. If refused, it throws (the renderer does not show the badge).
    'index.buildScope': async (params) => {
      const opened = this.require()
      const path = opened.indexer.indexedPathOf(asString(params, 'uri'))
      if (path === null) throw new Error(formatReason('path-excluded'))
      return opened.service.buildScope(path)
    },
    // DB breakdown (TODO 846 / 914 / 988). Only when "count the breakdown" in settings is pressed. Heavy (dbstat reads every page).
    'index.measureDatabase': (params) => this.require().service.measureDatabase(asNumber(params, 'top', 30)),
    'index.getStatus': () => this.require().service.getStatus(),
    'index.pause': () => this.require().service.pause(),
    'index.resume': (params) =>
      this.require().service.resume({ manual: record(params)['manual'] === true }),
    'index.getDocument': (params) =>
      this.require().service.getDocument(
        asString(params, 'id'),
        asNumber(params, 'limitBytes', 8192),
        record(params)['forAgent'] === true
      ),
    'index.resolveDocument': (params) =>
      this.require().service.resolveDocument(
        {
          uri: asOptionalString(params, 'uri') ?? '',
          source: asOptionalString(params, 'source') ?? '',
          sourceId: asOptionalString(params, 'sourceId') ?? ''
        },
        record(params)['forAgent'] === true
      ),
    'index.getDocumentText': (params) =>
      this.require().service.getDocumentText(
        asString(params, 'id'),
        asNumber(params, 'offset', 0),
        asNumber(params, 'length', 8192),
        record(params)['forAgent'] === true
      ),
    'index.getChunk': (params) =>
      this.require().service.getChunk(asString(params, 'id'), record(params)['forAgent'] === true),
    // Returns the number processed (item 76). The launch-time ingestion has main wait for this
    // before advancing the high-water mark. Those from SessionManager's flush are not waited for.
    'index.conversationEvents': (params) => {
      const events = record(params)['events']
      return this.require().service.indexConversationEvents(
        Array.isArray(events)
          ? (events as readonly { id: string; threadId: string; title: string; ts: number }[])
          : []
      )
    },
    // Waits until the deletion finishes before returning (TODO 860): main treats the response as "arrived", and queues the failed ones to resend.
    'index.removeThread': (params) => this.require().service.removeThread(asString(params, 'threadId')),
    // Drops messages that vanished from the canonical copy through the retention period (4.3.1) (TODO 860). Items with the wrong shape are skipped.
    'index.pruneConversations': (params) => {
      const items = record(params)['items']
      return this.require().service.pruneConversations(
        Array.isArray(items)
          ? items.flatMap((item: unknown) => {
              const { threadId, before } = record(item)
              return typeof threadId === 'string' && threadId !== '' && typeof before === 'number' && Number.isFinite(before)
                ? [{ threadId, before }]
                : []
            })
          : []
      )
    },
    'index.removeTranscript': (params) =>
      this.require().service.removeTranscriptFile(asString(params, 'fileId')),
    'index.listTranscriptFileIds': () => this.require().service.listTranscriptFileIds(),
    'index.listConversationThreadIds': () => this.require().service.listConversationThreadIds(),
    'index.removeAllConversations': () => this.require().service.removeAllConversations(),
    'index.transcriptMessages': (params) => {
      const file = record(params)['file'] as TranscriptFile
      const messages = record(params)['messages']
      return this.require().service.indexTranscriptMessages(
        file,
        Array.isArray(messages) ? (messages as readonly TranscriptMessageInput[]) : []
      )
    },
    'index.putPluginDocument': (params) =>
      this.require().service.putPluginDocument(record(params)['document'] as PluginDocumentInput),
    'index.removePluginDocumentsOf': (params) => this.require().service.removePluginDocumentsOf(asString(params, 'pluginId')),
    'index.removePluginDocument': (params) =>
      this.require().service.removePluginDocument(
        asString(params, 'source'),
        asString(params, 'sourceId')
      )
  }

  private require(): Opened {
    if (this.opened === null) throw new Error('index kernel is not open')
    return this.opened
  }

  /**
   * Opens the DB and assembles the contents (3.3).
   *
   * **Migration is main's job**, so here it only verifies `user_version`.
   * On a mismatch it refuses without opening (so that an old index process cannot break a new DB).
   * In degraded mode (`file === null`) it creates the tables in its own `:memory:`: the index is
   * rebuilt on every launch, but nothing remains on disk (constraint 11).
   */
  private open(params: IndexOpenParams): { version: number } {
    if (this.opened !== null) throw new Error('index kernel is already open')
    const openFile = this.options.openFile ?? openDatabaseFile
    const memoryOnly = params.file === null
    const db = openFile(params.file ?? ':memory:', memoryOnly ? null : params.key)

    let version: number
    if (memoryOnly) {
      version = runMigrations(db)
    } else {
      version = Number(db.pragma('user_version', { simple: true }))
      if (version !== params.userVersion) {
        db.close()
        throw new Error(`index db version mismatch: ${version} != ${params.userVersion}`)
      }
    }

    // PDF body extraction (TODO 1009). Decided before the scan builds the version marker (`extractorTag`).
    configurePdfHelper(params.pdfHelperPath)
    // Image classification labels (TODO 998). Likewise before the version marker.
    configureVisionHelper(params.visionHelperPath)
    const store = new IndexStore(db)
    const service = new IndexService({
      db,
      store,
      plugins: {
        read: async (source, sourceId) =>
          (await this.bridge.call('plugin.read', { source, sourceId })) as string | null
      },
      conversation: {
        readEventText: async (eventId) =>
          (await this.bridge.call('conversation.readEventText', { eventId })) as {
            text: string
            threadId: string
            ts: number
          } | null,
        threadTitle: async (threadId) =>
          (await this.bridge.call('conversation.threadTitle', { threadId })) as string | null,
        // TODO 863: checks the matches of in-thread search in one round trip. An answer with the wrong shape falls back to "could not be checked".
        liveEventIds: async (eventIds) => {
          const live = await this.bridge.call('conversation.liveEventIds', { eventIds })
          if (!Array.isArray(live)) throw new Error('conversation.liveEventIds: unexpected reply')
          return live.filter((id): id is string => typeof id === 'string')
        }
      },
      transcripts: {
        readMessageText: async (fileId, messageId, locator) =>
          (await this.bridge.call('transcript.readMessageText', {
            fileId,
            messageId,
            locator
          })) as string | null
      },
      // Index building is also put on **the same pacing stage as the scan** (P4 -> TODO 434, 6.2.2). The thresholds are
      // the same constants as `ScanScheduler`. `powerMonitor` exists only in main, so
      // the values that arrived via `power` are used as they are (the same source as FsIndexer below).
      idle: this.options.idle ?? {
        idleSeconds: () => this.power.idleSeconds,
        thermalState: () => this.power.thermalState,
        lowPower: () => this.power.lowPower,
        pacer: this.pacer
      },
      onStatus: (status) => this.bridge.notify('indexStatus', status),
      // Re-applying exclusion at read time (TODO 849). The rules are the same as the scan's (rebuilt when allowed volumes change).
      // `indexer` is created below: this is called only when reading a body, and by then it exists.
      fsRules: () => indexer.exclusionRules
    })

    const indexer = new FsIndexer(
      db,
      {
        onScanStatus: (status) => this.bridge.notify('scanStatus', status),
        onFileChanges: (batch) => this.bridge.notify('fileChanges', batch),
        onIndexable: () => service.resume(),
        // After a subtree scan, only that subtree's bodies are built without waiting for idle (item 249).
        // The result appears in the `index.build.subtree.done` log. The RPC answer is not made to wait.
        onSubtreeScanned: (rootId, path) => {
          void service.buildSubtree(rootId, path)
        },
        onRules: (allowedVolumes, volumesDir) =>
          this.bridge.notify('rules', { allowedVolumes, volumesDir })
      },
      store,
      params.home,
      params.roots,
      this.options.volumes ?? {},
      // The resident scheduled run (6.2.2). **The thresholds and the decision stay here (the index process)**,
      // and only the `powerMonitor` values, which touch electron, arrive from main via `power`.
      this.options.scheduler ?? {
        enabled: true,
        idleSeconds: () => this.power.idleSeconds,
        thermalState: () => this.power.thermalState,
        lowPower: () => this.power.lowPower,
        pacer: this.pacer
      },
      // The protected-folder deferral (TODO 805) is enabled only in the index process (it is off for a bare `FsIndexer`).
      { tccDeferral: this.options.tccDeferral ?? true }
    )

    this.opened = { db, store, service, indexer }
    log.info('index.kernel.opened', { version, memoryOnly })
    this.bridge.notify('ready', { version })
    return { version }
  }

  /**
   * Shutdown (12.9). It does not return until the scan and build have stopped, the queue has drained completely, and **it has closed its own DB**.
   * Main closes its own connection after this returns.
   */
  async stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping
    this.stopping = (async () => {
      const opened = this.opened
      if (opened === null) return
      try {
        await opened.indexer.stop()
        await opened.service.stop()
      } catch (err) {
        log.warn('index.kernel.stop.failed', errorFields(err))
      }
      try {
        opened.db.close()
      } catch (err) {
        log.warn('index.kernel.close.failed', errorFields(err))
      }
      this.opened = null
      setPdfExtractor(null)
      setImageAnalyzer(null)
      log.info('index.kernel.stopped', {})
      this.bridge.notify('stopped', {})
    })()
    return this.stopping
  }
}
