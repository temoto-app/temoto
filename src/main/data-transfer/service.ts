/**
 * The body of exporting and importing threads and settings (TODO 1088, ARCHITECTURE 8.6). Independent of electron (the dialog and
 * the files are passed in by the caller. Tests run it with fake entry points).
 *
 * - **Do not hold main's JS thread for long, and never hold the whole file** (TODO 1318: no whole-file size limit any more).
 *   - Export: live threads, oldest first, with the timeline read from the DB `EXPORT_PAGE` events at a time (the form stored in the DB =
 *     as it is after `toPersistable`), made into one JSON line per thread and streamed through gzip and AES (`createSealer`) **into the
 *     file** (`TransferFiles`: the backup's exclusive `.partial`, or a temporary file renamed over the manual export's target). The payload
 *     is written as the DB column's string as is (not re-stringified). It yields to `setImmediate` between pages. Each thread's line is kept
 *     within `LIMITS.lineBytes` (the events past it are dropped and counted). Settings are the values of the same snapshot as the settings
 *     editor (`SettingValues`), put in the head line. On any failure or stop the written file is removed; a target is never touched.
 *   - Import: the file is opened once (`openRead`) and read twice through that one descriptor. **Pass 1** streams it (decrypt -> gunzip ->
 *     split into lines, one line held at a time), parses and validates each line (`format.ts`; a single violation rejects the whole file
 *     with the thread and event number) and checks the GCM tag at the end - nothing is written. **Pass 2** streams it again, parses each
 *     line again and passes `IMPORT_CHUNK` events at a time to `ThreadStore.importThreadChunk` (one chunk per transaction, running
 *     `toPersistable` again), **checks the tag again at the end, and only then** publishes the threads, applies the settings and tells
 *     the list. It yields per thread and per chunk.
 *   - **Until that second tag check passes, nothing pass 2 wrote can be reached** (review X): the rows are created hidden (migration 51:
 *     `deleted_at` set and `import_pending` = this run), so the list, search, opening, rewind, the conversation index and the deleted
 *     list all miss them, and `publishImportedThreads` shows the whole run in one statement. If pass 2 fails (the tag, a changed line,
 *     the DB, a full disk) the run's threads are removed, a chunk at a time; what could not be removed stays hidden and is not told to
 *     the list. A stop for shutdown leaves them (the quit is not held). **At launch, `sweepPendingImports` removes every hidden row of
 *     a run that is not running** - the leftovers of a failed cleanup, a stop, a crash or a forced quit.
 * - **Export goes through the same validation as import** (`normalizeThreadMeta` / `checkEvent` / payload length / counts / line size).
 *   Threads and events that cannot be fixed are dropped and counted, and shown in the result (`skippedThreads` / `skippedEvents`). A file
 *   we wrote can always be read.
 * - Settings are changed per name through `AgentSettings` validation (`prepare`) and the existing setter (`commit`). Unknown names and unusable values are
 *   dropped and counted.
 * - **Does not touch the index tables** (constraint 8.1). For the threads added, the caller (`afterImport`) asks SessionManager to
 *   re-index (the same entry point as `restore`).
 * - No body, passphrase or setting value goes into the log. Only paths, counts, reason codes and the thread / event number are written.
 * - Only one at a time (`exclusive`). The IPC reserves **before** opening the dialog and releases on cancel (`ipc.ts`).
 * - **It can be stopped from shutdown** (`stop()`, TODO 1117). It raises a flag and returns after the running export / import / sweep
 *   leaves at a boundary. Import checks the flag at each read, chunk and thread boundary and leaves its hidden threads for the next
 *   launch's sweep (settings are not changed). Export leaves at page and thread boundaries and removes its file. A `runExport` /
 *   `runImport` that arrives after `stop()` is refused without touching the DB. Only the body is waited for, not the reservation while
 *   a dialog is open.
 * - A full disk (`ENOSPC` / `EDQUOT`, `SQLITE_FULL`) is its own reason (`disk-full`), so the user is told why rather than "could not write".
 */
import { basename } from 'node:path'
import type { JsonValue } from '@shared/agent.js'
import {
  DATA_TRANSFER_MAX_PASSPHRASE,
  DATA_TRANSFER_MIN_PASSPHRASE,
  type DataExportResult,
  type DataImportResult,
  type DataTransferFailed,
  type DataTransferFailure,
  type DataTransferFailureAt
} from '@shared/data-transfer.js'
import { errorFields, log } from '../../common/logger.js'
import type { ExportEventRow, ExportThreadRow, ImportThreadChunk } from '../session/store.js'
import { DEFAULT_KDF, SealError, createSealer, unseal, type KdfParams, type Sealer } from './crypto.js'
import { isDiskFull, nodeTransferFiles, type ExportWriter, type ImportReader, type TransferFiles } from './files.js'
import { LineSplitter, LineTooLong } from './lines.js'
import {
  EXPORT_FORMAT_NAME,
  EXPORT_FORMAT_VERSION,
  LIMITS,
  checkEvent,
  checkHead,
  checkThread,
  normalizeThreadMeta,
  rebaseHome,
  settingsForHead,
  type CheckFailureReason,
  type ExportHead,
  type ExportedThreadMeta
} from './format.js'

/** Number of events read from the DB at a time. */
export const EXPORT_PAGE = 2000
/** Number of events put into one transaction on import. */
export const IMPORT_CHUNK = 2000

/** The part of ThreadStore's interface that this file uses. */
export interface DataTransferStore {
  exportThreadRows(): readonly ExportThreadRow[]
  exportEventsPage(
    threadId: string,
    afterSeq: number,
    limit: number
  ): { readonly events: readonly ExportEventRow[]; readonly lastSeq: number | null; readonly scanned: number }
  importThreadChunk(chunk: ImportThreadChunk): { readonly written: number; readonly skipped: number; readonly nextSeq: number }
  publishImportedThreads(importRun: string): number
  pendingImportThreads(): readonly { readonly id: string; readonly importRun: string }[]
  removePendingImportPart(threadId: string, limit: number): boolean
}

/** Settings entry point (a thin shell over `AgentSettings`). */
export interface DataTransferSettings {
  /** Current values (settings editor name -> value). */
  values(): Readonly<Record<string, unknown>>
  /** Changes one. `invalid` is an unknown name or an unusable value (dropped and counted). */
  apply(name: string, value: unknown): 'applied' | 'unchanged' | 'invalid'
}

export interface DataTransferDeps {
  readonly store: DataTransferStore
  readonly settings: DataTransferSettings
  /** The DB's `user_version`. */
  readonly dbUserVersion: number
  readonly appVersion: string
  readonly home: string
  readonly newId: () => string
  /** The files (default: the real ones, `nodeTransferFiles`). Tests pass an in-memory twin. */
  readonly files?: TransferFiles
  /** Tells the list and the index about the imported threads. */
  readonly afterImport: (threadIds: readonly string[]) => void
  /**
   * Whether that backend has an OS sandbox (`os-sandbox`) (TODO 1109). A thread exported with it ON is also added with it OFF to a backend
   * that does not have it (including not yet probed) - the same decision as handover and the ⋯ switch (`SessionManager.supportsOsSandbox`).
   */
  readonly supportsOsSandbox: (backend: string) => boolean
  readonly now?: () => number
  /** Only tests weaken it (the default is `DEFAULT_KDF`). */
  readonly kdf?: KdfParams
  /** Only tests lower it (the default is `LIMITS.lineBytes`), to try the boundary without hundreds of MiB. */
  readonly lineBytes?: number
}

/** Options of `runExport`. */
export interface ExportOptions {
  /**
   * Create `path` itself exclusively (never follow or overwrite an entry already at the path), as the automatic backup's `.partial`.
   * Without it the file is written beside `path` and renamed over it when complete (the manual export overwrites the chosen file).
   */
  readonly createNew?: boolean
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** TODO 1117: stopped by shutdown (`stop()`). Thrown at a boundary; the body's catch cleans up and returns via `io`. */
class TransferStopped extends Error {
  constructor() {
    super('data-transfer: stopped for shutdown')
  }
}

/** Pass 1 found the content wrong: the reason and, where known, the place. */
class ImportRejected extends Error {
  constructor(
    readonly reason: CheckFailureReason,
    readonly at?: DataTransferFailureAt
  ) {
    super(`data-transfer: rejected (${reason})`)
  }
}

function failed(reason: DataTransferFailure, at?: DataTransferFailureAt): DataTransferFailed {
  return at === undefined ? { kind: 'failed', reason } : { kind: 'failed', reason, at }
}

/** An error that is not about the content: a full disk, or any other I/O / DB failure. */
function ioFailure(err: unknown): DataTransferFailure {
  return isDiskFull(err) ? 'disk-full' : 'io'
}

/** Validates the passphrase from the IPC. Export checks the minimum length. Import refuses only an empty one (`passphrase-empty`). */
export function checkPassphrase(raw: unknown, forExport: boolean): { ok: true; value: string } | { ok: false; reason: DataTransferFailure } {
  if (typeof raw !== 'string' || raw === '') return { ok: false, reason: forExport ? 'passphrase-short' : 'passphrase-empty' }
  if (raw.length > DATA_TRANSFER_MAX_PASSPHRASE) return { ok: false, reason: 'passphrase-long' }
  if (forExport && [...raw].length < DATA_TRANSFER_MIN_PASSPHRASE) return { ok: false, reason: 'passphrase-short' }
  return { ok: true, value: raw }
}

/** The JSON of the thread's fields only (drop the trailing `}` and continue with `"events":[`). */
function threadPrefix(meta: ExportedThreadMeta): string {
  return `${JSON.stringify(meta).slice(0, -1)},"events":[`
}

/** The end of a thread's line (its newline is not counted in the line's size). */
const THREAD_SUFFIX = ']}'

/** One event's JSON. The payload is inserted as the DB column's string as is (not re-stringified). */
function eventJson(event: ExportEventRow): string {
  const head = JSON.stringify({
    kind: event.kind,
    actor: event.actor,
    ts: event.ts,
    ...(event.parentToolUseId === undefined ? {} : { parentToolUseId: event.parentToolUseId })
  })
  return `${head.slice(0, -1)},"payload":${event.payloadJson}}`
}

function parseLine(line: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line.toString('utf8')) as unknown }
  } catch {
    return { ok: false }
  }
}

/** What pass 1 learned (all of it authenticated by pass 1's tag check). */
interface VerifiedFile {
  readonly head: ExportHead
  readonly formatVersion: number
  /** Version 1: the threads, already parsed and validated (pass 2 does not read the file again). null for version 2. */
  readonly legacyThreads: readonly unknown[] | null
  /** Version 2: the number of thread lines. */
  readonly threadLines: number
}

export class DataTransfer {
  private running = false
  /** TODO 1117: shutdown has begun (`stop()`). Once raised, it is never lowered (12.9). */
  private stopping = false
  /** TODO 1117: the body of the running export / import (`stop()` waits for it). Does not include waiting on a dialog. */
  private active: Promise<unknown> | null = null
  /** The run of the import whose pass 2 is writing hidden threads now (the launch sweep leaves its rows alone). */
  private importRun: string | null = null
  /** The running launch sweep (`stop()` waits for it too). */
  private sweeping: Promise<number> | null = null

  constructor(private readonly deps: DataTransferDeps) {}

  private get files(): TransferFiles {
    return this.deps.files ?? nodeTransferFiles
  }

  private get lineBytes(): number {
    return this.deps.lineBytes ?? LIMITS.lineBytes
  }

  get busy(): boolean {
    return this.running
  }

  /**
   * Runs only one at a time. If one is running, returns `busyResult`. The IPC reserves here before opening the dialog
   * (even if pressed from two windows at once, the second is immediately `busy`), and inside `fn` calls dialog -> `runExport` / `runImport`.
   */
  async exclusive<T>(busyResult: T, fn: () => Promise<T>): Promise<T> {
    if (this.running) return busyResult
    this.running = true
    try {
      return await fn()
    } finally {
      this.running = false
    }
  }

  /**
   * TODO 1117: shutdown. Raises the flag and returns after the running body leaves at a boundary (import removes the threads it added).
   * Called in the `before-quit` sequence before `sessions.stop` and `db.close()`. After that, `runExport` / `runImport` do not touch the DB.
   */
  async stop(): Promise<void> {
    this.stopping = true
    const running = [this.active, this.sweeping].filter((work): work is Promise<unknown> => work !== null)
    await Promise.all(running.map((work) => work.catch(() => undefined)))
  }

  /**
   * TODO 1318 review X: removes, at launch, the hidden threads of import runs that never published (a cleanup that failed, a stop for
   * shutdown, a crash or a forced quit). The rows are read once (one query) and removed `IMPORT_CHUNK` events per transaction, yielding
   * in between, so main is not held; an import running meanwhile keeps its own rows. Stops at a boundary on shutdown (the rest waits
   * for the next launch). Nothing is told to the list (nothing of it was ever visible). Returns the number of threads removed.
   */
  async sweepPendingImports(): Promise<number> {
    if (this.stopping || this.sweeping !== null) return 0
    const work = this.sweepBody()
    this.sweeping = work
    try {
      return await work
    } finally {
      this.sweeping = null
    }
  }

  private async sweepBody(): Promise<number> {
    let rows: readonly { readonly id: string; readonly importRun: string }[]
    try {
      rows = this.deps.store.pendingImportThreads().filter((row) => row.importRun !== this.importRun)
    } catch (err) {
      log.warn('data.import.sweepFailed', errorFields(err))
      return 0
    }
    if (rows.length === 0) return 0
    let removed = 0
    for (const row of rows) {
      if (this.stopping) break
      try {
        if (await this.removePending(row.id)) removed += 1
      } catch (err) {
        log.warn('data.import.sweepFailed', errorFields(err))
      }
      await yieldToLoop()
    }
    log.info('data.import.swept', { threads: removed, left: rows.length - removed })
    return removed
  }

  /** Removes one hidden imported thread a chunk at a time. False if shutdown stopped it first (the rest stays hidden). */
  private async removePending(threadId: string): Promise<boolean> {
    for (;;) {
      if (this.deps.store.removePendingImportPart(threadId, IMPORT_CHUNK)) return true
      await yieldToLoop()
      if (this.stopping) return false
    }
  }

  /** Runs the body and remembers it so `stop()` can wait. After `stop()`, it refuses without running. */
  private async track<T>(work: () => Promise<T>, onStopped: () => T): Promise<T> {
    if (this.stopping) return onStopped()
    const running = work()
    this.active = running
    try {
      return await running
    } finally {
      if (this.active === running) this.active = null
    }
  }

  /** Called at a boundary: leaves if shutdown has begun. */
  private checkStopping(): void {
    if (this.stopping) throw new TransferStopped()
  }

  async exportTo(path: string, passphraseRaw: unknown): Promise<DataExportResult> {
    const passphrase = checkPassphrase(passphraseRaw, true)
    if (!passphrase.ok) return failed(passphrase.reason)
    return this.exclusive<DataExportResult>(failed('busy'), () => this.runExport(path, passphrase.value))
  }

  async importFrom(path: string, passphraseRaw: unknown): Promise<DataImportResult> {
    const passphrase = checkPassphrase(passphraseRaw, false)
    if (!passphrase.ok) return failed(passphrase.reason)
    return this.exclusive<DataImportResult>(failed('busy'), () => this.runImport(path, passphrase.value))
  }

  /** The export body. Called from inside `exclusive` (the passphrase is already validated). */
  async runExport(path: string, passphrase: string, options: ExportOptions = {}): Promise<DataExportResult> {
    return this.track(
      () => this.exportBody(path, passphrase, options),
      () => failed('io')
    )
  }

  private async exportBody(path: string, passphrase: string, options: ExportOptions): Promise<DataExportResult> {
    const started = Date.now()
    let writer: ExportWriter | null = null
    let sealer: Sealer | null = null
    try {
      writer = options.createNew === true ? await this.files.createNew(path) : await this.files.replace(path)
      sealer = await createSealer(passphrase, writer, this.deps.kdf ?? DEFAULT_KDF)
      const head: ExportHead = {
        format: EXPORT_FORMAT_NAME,
        formatVersion: EXPORT_FORMAT_VERSION,
        dbUserVersion: this.deps.dbUserVersion,
        appVersion: this.deps.appVersion,
        exportedAt: (this.deps.now ?? Date.now)(),
        home: this.deps.home,
        settings: settingsForHead(JSON.parse(JSON.stringify(this.deps.settings.values())) as Record<string, JsonValue>, true)!
      }
      // The head is a few KiB (at most `LIMITS.settings` settings), far below the line limit.
      await sealer.write(`${JSON.stringify(head)}\n`)
      const lineLimit = this.lineBytes
      let threads = 0
      let events = 0
      let skippedThreads = 0
      let skippedEvents = 0
      this.checkStopping()
      for (const row of this.deps.store.exportThreadRows()) {
        this.checkStopping()
        const meta = normalizeThreadMeta(threadMetaOf(row))
        const prefix = meta === null ? null : threadPrefix(meta)
        let lineSize = prefix === null ? 0 : Buffer.byteLength(prefix, 'utf8') + THREAD_SUFFIX.length
        if (prefix === null || lineSize > lineLimit) {
          skippedThreads += 1
          continue
        }
        await sealer.write(prefix)
        let inThread = 0
        /** The line reached its limit: the rest of this thread's events are dropped (counted), keeping the conversation's beginning. */
        let full = false
        let after = 0
        for (;;) {
          const page = this.deps.store.exportEventsPage(row.id, after, EXPORT_PAGE)
          const parts: string[] = []
          for (const event of page.events) {
            // The same validation as import. Rows that fail, payloads that are too long, and the part over the count limit are counted rather than written.
            const fits =
              !full && inThread < LIMITS.eventsPerThread && event.payloadJson.length <= LIMITS.payloadChars && checkEvent(event).ok
            if (!fits) {
              skippedEvents += 1
              continue
            }
            const json = eventJson(event)
            const size = Buffer.byteLength(json, 'utf8') + (inThread > 0 ? 1 : 0)
            if (lineSize + size > lineLimit) {
              full = true
              skippedEvents += 1
              continue
            }
            parts.push(json)
            lineSize += size
            inThread += 1
            events += 1
          }
          if (parts.length > 0) await sealer.write((inThread > parts.length ? ',' : '') + parts.join(','))
          if (page.lastSeq === null || page.scanned < EXPORT_PAGE) break
          after = page.lastSeq
          await yieldToLoop()
          this.checkStopping()
        }
        await sealer.write(`${THREAD_SUFFIX}\n`)
        threads += 1
        await yieldToLoop()
      }
      this.checkStopping()
      const bytes = await sealer.finish()
      await writer.commit()
      const settings = Object.keys(head.settings).length
      log.info('data.export.saved', { path, threads, events, skippedThreads, skippedEvents, settings, bytes, ms: Date.now() - started })
      return { kind: 'done', fileName: basename(path), threads, events, settings, skippedThreads, skippedEvents }
    } catch (err) {
      sealer?.abort()
      await writer?.discard()
      if (err instanceof TransferStopped) {
        log.info('data.export.stopped', { path })
        return failed('io')
      }
      log.warn('data.export.failed', { path, ...errorFields(err) })
      return failed(ioFailure(err))
    }
  }

  /** The import body. Called from inside `exclusive` (the passphrase is already validated). */
  async runImport(path: string, passphrase: string): Promise<DataImportResult> {
    return this.track(
      () => this.importBody(path, passphrase),
      () => failed('io')
    )
  }

  private async importBody(path: string, passphrase: string): Promise<DataImportResult> {
    let reader: ImportReader
    try {
      reader = await this.files.openRead(path)
    } catch (err) {
      log.warn('data.import.readFailed', { path, ...errorFields(err) })
      return failed('io')
    }
    try {
      return await this.importFromReader(reader, path, passphrase)
    } finally {
      await reader.close().catch(() => undefined)
    }
  }

  private async importFromReader(reader: ImportReader, path: string, passphrase: string): Promise<DataImportResult> {
    const started = Date.now()
    const rejected = (reason: DataTransferFailure, at?: DataTransferFailureAt): DataTransferFailed => {
      log.info('data.import.rejected', { path, reason, ...(at === undefined ? {} : { thread: at.thread, event: at.event ?? null }) })
      return failed(reason, at)
    }
    let verified: VerifiedFile
    try {
      verified = await this.verifyPass(reader, passphrase)
    } catch (err) {
      if (err instanceof SealError) return rejected(err.reason)
      if (err instanceof ImportRejected) return rejected(err.reason, err.at)
      if (err instanceof TransferStopped) {
        log.info('data.import.stopped', { path })
        return failed('io')
      }
      log.warn('data.import.failed', { path, ...errorFields(err) })
      return failed(ioFailure(err))
    }
    const { head } = verified
    const ids: string[] = []
    const counts = { events: 0, skippedEvents: 0, sandboxDropped: 0 }
    // Pass 2's rows are hidden under this run until it publishes them (review X, migration 51).
    const run = this.deps.newId()
    this.importRun = run
    try {
      this.checkStopping()
      await this.importPass(reader, passphrase, verified, run, ids, counts)
      // The second tag check passed: the whole run becomes visible in one statement.
      this.deps.store.publishImportedThreads(run)
    } catch (err) {
      // Nothing of a failed pass 2 is ever seen (its plaintext was not authenticated by this pass's tag, or the import did not finish).
      // Its hidden threads are removed; what is not (a stop, a failed cleanup) stays hidden, is not told to the list, and is swept at
      // the next launch.
      if (err instanceof TransferStopped) {
        log.info('data.import.stopped', { path, left: ids.length })
        return failed('io')
      }
      const removed = await this.removeAdded(ids, path)
      if (err instanceof SealError) {
        log.info('data.import.removed', { path, removed, left: ids.length - removed })
        return rejected(err.reason)
      }
      log.warn('data.import.failed', { path, removed, left: ids.length - removed, ...errorFields(err) })
      return failed(ioFailure(err))
    } finally {
      this.importRun = null
    }
    if (ids.length > 0) this.deps.afterImport(ids)
    let settings = 0
    let skippedSettings = 0
    for (const [name, value] of Object.entries(head.settings)) {
      const outcome = this.deps.settings.apply(name, value)
      if (outcome === 'applied') settings += 1
      else if (outcome === 'invalid') skippedSettings += 1
    }
    log.info('data.import.done', {
      path,
      formatVersion: verified.formatVersion,
      dbUserVersion: head.dbUserVersion,
      threads: ids.length,
      events: counts.events,
      skippedEvents: counts.skippedEvents,
      sandboxDropped: counts.sandboxDropped,
      settings,
      skippedSettings,
      ms: Date.now() - started
    })
    return {
      kind: 'done',
      fileName: basename(path),
      threads: ids.length,
      events: counts.events,
      skippedEvents: counts.skippedEvents,
      settings,
      skippedSettings
    }
  }

  /** Streams the plaintext of `reader` line by line into `onLine` (the last line after the tag matched). */
  private async streamLines(
    reader: ImportReader,
    passphrase: string,
    onLine: (line: Buffer, index: number) => Promise<boolean | void>,
    isAbort: (error: unknown) => boolean
  ): Promise<void> {
    const splitter = new LineSplitter(this.lineBytes, onLine)
    let more = true
    await unseal(
      reader,
      passphrase,
      async (chunk) => {
        more = await splitter.push(chunk)
        return more
      },
      { checkpoint: () => this.checkStopping(), isAbort }
    )
    if (more) await splitter.end()
  }

  /**
   * Pass 1: parses and validates every line and checks the tag, writing nothing. Throws `ImportRejected` (with the place) for a wrong
   * content, `SealError` for the seal (a tag mismatch wins over a wrong content), `TransferStopped`, or an I/O error.
   */
  private async verifyPass(reader: ImportReader, passphrase: string): Promise<VerifiedFile> {
    // Filled by the line callback (a holder object, so the compiler does not keep the initial null narrowed).
    const found: { head: ExportHead | null; formatVersion: number; legacyThreads: readonly unknown[] | null; threadLines: number } = {
      head: null,
      formatVersion: 0,
      legacyThreads: null,
      threadLines: 0
    }
    try {
      await this.streamLines(
        reader,
        passphrase,
        async (line, index) => {
          const parsed = parseLine(line)
          if (index === 0) {
            if (!parsed.ok) throw new ImportRejected('invalid-file')
            const checked = checkHead(parsed.value)
            if (!checked.ok) throw new ImportRejected(checked.reason)
            found.head = checked.head
            found.formatVersion = (parsed.value as { formatVersion: number }).formatVersion
            if (checked.legacyThreads !== null) {
              found.legacyThreads = checked.legacyThreads
              for (let i = 0; i < checked.legacyThreads.length; i += 1) {
                this.checkThreadOrReject(checked.legacyThreads[i], i + 1)
                await yieldToLoop()
                this.checkStopping()
              }
              // Version 1 is one JSON: what follows its line was never read (the same as before).
              return false
            }
            return true
          }
          if (!parsed.ok) throw new ImportRejected('invalid-file', { thread: index })
          this.checkThreadOrReject(parsed.value, index)
          found.threadLines = index
          await yieldToLoop()
          this.checkStopping()
          return true
        },
        (error) => error instanceof TransferStopped
      )
    } catch (err) {
      if (err instanceof LineTooLong) throw new ImportRejected('too-large', err.index === 0 ? undefined : { thread: err.index })
      throw err
    }
    if (found.head === null) throw new ImportRejected('invalid-file')
    return { head: found.head, formatVersion: found.formatVersion, legacyThreads: found.legacyThreads, threadLines: found.threadLines }
  }

  private checkThreadOrReject(raw: unknown, thread: number): void {
    const checked = checkThread(raw)
    if (!checked.ok) throw new ImportRejected(checked.reason, checked.event === undefined ? { thread } : { thread, event: checked.event })
  }

  /**
   * Pass 2: adds one thread at a time, in a transaction per chunk. Version 2 reads the file again through the same descriptor and checks
   * the tag again at the end (pass 2 resolves only then); version 1 uses the threads pass 1 parsed. Every thread is created hidden under
   * `run`. `ids` collects every thread it started, so the caller can remove them all if this throws.
   */
  private async importPass(
    reader: ImportReader,
    passphrase: string,
    verified: VerifiedFile,
    run: string,
    ids: string[],
    counts: { events: number; skippedEvents: number; sandboxDropped: number }
  ): Promise<void> {
    const rebase = (p: string): string => rebaseHome(p, verified.head.home, this.deps.home)
    const addThread = async (raw: unknown): Promise<void> => {
      const checked = checkThread(raw)
      // Something that passed pass 1 cannot fail here unless the file changed in between; its tag check would fail too.
      if (!checked.ok) throw new Error('data-transfer: line changed between passes')
      const { events: threadEvents, ...meta } = checked.thread
      counts.skippedEvents += checked.skippedEvents
      // TODO 1109: if the destination does not have it, drop to OFF (adding it ON would be refused at launch and unable to send - 4.2.4).
      const osSandbox = meta.osSandbox && this.deps.supportsOsSandbox(meta.backend)
      if (meta.osSandbox && !osSandbox) counts.sandboxDropped += 1
      const threadId = this.deps.newId()
      ids.push(threadId)
      let seq = 1
      for (let offset = 0; offset === 0 || offset < threadEvents.length; offset += IMPORT_CHUNK) {
        // TODO 1117: check shutdown at a chunk boundary. If it throws, what was added stays hidden for the next launch's sweep.
        this.checkStopping()
        const result = this.deps.store.importThreadChunk({
          threadId,
          importRun: run,
          thread: offset === 0 ? { ...meta, osSandbox, cwd: rebase(meta.cwd), allowedDirs: meta.allowedDirs.map(rebase) } : null,
          events: threadEvents.slice(offset, offset + IMPORT_CHUNK),
          seqStart: seq,
          maxPayloadChars: LIMITS.payloadChars,
          newId: this.deps.newId
        })
        seq = result.nextSeq
        counts.events += result.written
        counts.skippedEvents += result.skipped
        await yieldToLoop()
      }
      this.checkStopping()
    }

    if (verified.legacyThreads !== null) {
      for (const raw of verified.legacyThreads) await addThread(raw)
      return
    }
    let threadLines = 0
    await this.streamLines(
      reader,
      passphrase,
      async (line, index) => {
        if (index === 0) return true
        const parsed = parseLine(line)
        if (!parsed.ok) throw new Error('data-transfer: line changed between passes')
        await addThread(parsed.value)
        threadLines = index
        return true
      },
      () => true
    )
    if (threadLines !== verified.threadLines) throw new Error('data-transfer: line count changed between passes')
  }

  /**
   * Removes the hidden threads a failed pass 2 added, a chunk at a time. Returns how many are gone; the rest (a DB failure, or shutdown
   * began meanwhile) stay hidden for the next launch's sweep.
   */
  private async removeAdded(ids: readonly string[], path: string): Promise<number> {
    let removed = 0
    for (const id of ids) {
      if (this.stopping) break
      try {
        if (await this.removePending(id)) removed += 1
      } catch (err) {
        log.warn('data.import.cleanupFailed', { path, ...errorFields(err) })
      }
      await yieldToLoop()
    }
    return removed
  }
}

/**
 * TODO 1306: checks, without writing anything, that `passphrase` opens the export file (the whole file is authenticated) and that its
 * head line is one this version reads. Used before a restore commits to a restart (so a wrong passphrase is told before the DB is moved
 * aside). Streams like the import: only the head line is decompressed and kept.
 */
export async function verifyExportFile(
  files: Pick<TransferFiles, 'openRead'>,
  path: string,
  passphrase: string
): Promise<{ ok: true } | { ok: false; reason: DataTransferFailure }> {
  let reader: ImportReader
  try {
    reader = await files.openRead(path)
  } catch {
    return { ok: false, reason: 'io' }
  }
  const found: { head: Buffer | null } = { head: null }
  try {
    const splitter = new LineSplitter(LIMITS.lineBytes, async (line) => {
      found.head = line
      return false
    })
    let more = true
    await unseal(reader, passphrase, async (chunk) => {
      more = await splitter.push(chunk)
      return more
    })
    if (more) await splitter.end()
  } catch (err) {
    if (err instanceof SealError) return { ok: false, reason: err.reason }
    if (err instanceof LineTooLong) return { ok: false, reason: 'too-large' }
    return { ok: false, reason: ioFailure(err) }
  } finally {
    await reader.close().catch(() => undefined)
  }
  if (found.head === null) return { ok: false, reason: 'invalid-file' }
  const parsed = parseLine(found.head)
  if (!parsed.ok) return { ok: false, reason: 'invalid-file' }
  const checked = checkHead(parsed.value)
  return checked.ok ? { ok: true } : { ok: false, reason: checked.reason }
}

function threadMetaOf(row: ExportThreadRow): ExportedThreadMeta {
  return {
    title: row.title,
    titleAuto: row.title_auto === 1,
    cwd: row.cwd,
    allowedDirs: [...row.allowedDirs],
    retention: row.retention === 'days' ? 'days' : 'forever',
    retentionDays: row.retention === 'days' ? row.retention_days : null,
    settingSources: [...row.settingSources],
    backend: row.backend,
    modelId: row.model_id,
    thinking: row.thinking,
    approvalStrict: row.approval_strict === 1,
    osSandbox: row.os_sandbox === 1,
    createdAt: row.created_at,
    lastEventAt: row.last_event_at,
    turns: row.turns
  }
}
