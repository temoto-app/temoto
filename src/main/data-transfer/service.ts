/**
 * The body of exporting and importing threads and settings (TODO 1088, ARCHITECTURE 8.6). Independent of electron (the dialog and
 * file reads and writes are passed in by the caller. Tests run it with fake entry points).
 *
 * - **Do not hold main's JS thread for long.** Neither direction makes the whole a single value or string.
 *   - Export: live threads, oldest first, with the timeline read from the DB `EXPORT_PAGE` events at a time (the form stored in the DB =
 *     as it is after `toPersistable`), made into one JSON line per thread and streamed into gzip (`createSealer`). The payload is written as
 *     the DB column's string as is (not re-stringified). It yields to `setImmediate` between pages. Settings are the values of the same snapshot as the settings editor
 *     (`SettingValues`), put in the head line.
 *   - Import: decrypt -> split into lines (look for newlines in the buffer) -> **pass 1** parses and validates each line (`format.ts`; a single violation
 *     rejects the whole file with the thread and event number and writes nothing) -> **pass 2** parses each line again and passes
 *     `IMPORT_CHUNK` events at a time to `ThreadStore.importThreadChunk` (one chunk per transaction, running `toPersistable` again).
 *     It yields per thread and per chunk. Two passes keep "validate everything, then write" without holding everything in memory.
 * - **Export goes through the same validation as import** (`normalizeThreadMeta` / `checkEvent` / payload length / counts). Threads and events that cannot
 *   be fixed are dropped and counted, and shown in the result (`skippedThreads` / `skippedEvents`). A file we wrote can always be read.
 * - Settings are changed per name through `AgentSettings` validation (`prepare`) and the existing setter (`commit`). Unknown names and unusable values are
 *   dropped and counted.
 * - **Does not touch the index tables** (constraint 8.1). For the threads added, the caller (`afterImport`) asks SessionManager to
 *   re-index (the same entry point as `restore`).
 * - No body, passphrase or setting value goes into the log. Only paths, counts, reason codes and the thread / event number are written.
 * - Only one at a time (`exclusive`). The IPC reserves **before** opening the dialog and releases on cancel (`ipc.ts`).
 * - **It can be stopped from shutdown** (`stop()`, TODO 1117). It raises a flag and returns after the running export / import leaves at a boundary.
 *   Import checks the flag at chunk and thread boundaries, and removes a half-written thread with `removeImportedThread` before leaving (threads that were
 *   fully added stay. Settings are not changed). Export leaves at page and thread boundaries and does not write the file. A `runExport` / `runImport` that arrives after `stop()`
 *   is refused without touching the DB. Only the body is waited for, not the reservation while a dialog is open.
 */
import { constants as fsConstants } from 'node:fs'
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
import { openNoFollow } from '../../common/os/open-flags.js'
import type { ExportEventRow, ExportThreadRow, ImportThreadChunk } from '../session/store.js'
import { DEFAULT_KDF, MAX_FILE_BYTES, SealError, createSealer, open, type KdfParams } from './crypto.js'
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
  removeImportedThread(threadId: string): void
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
  readonly readFile: (path: string) => Promise<Uint8Array>
  /** The file size (check the limit before reading). */
  readonly fileSize: (path: string) => Promise<number>
  readonly writeFile: (path: string, data: Uint8Array) => Promise<void>
  /**
   * TODO 1306 (wave 99 review): writes a file that must not exist yet (`runExport(…, { createNew: true })`, the automatic backup's partial
   * file in a folder the user chose). Defaults to `writeNewFileDurably`. The manual export keeps `writeFile` (it overwrites the file the
   * user picked in the save dialog).
   */
  readonly writeNewFile?: (path: string, data: Uint8Array) => Promise<void>
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
}

/** Options of `runExport`. */
export interface ExportOptions {
  /** Create the file exclusively (never follow or overwrite an entry already at the path) and fsync it before returning. */
  readonly createNew?: boolean
}

/**
 * Creates `path` exclusively (`O_CREAT | O_EXCL`, and no-follow through the OS gate `openNoFollow`: an existing file or symlink at the
 * path is an error, never followed or overwritten), mode 0600, writes `data`, and fsyncs before closing, through the one descriptor
 * (nothing re-opens the path afterwards).
 */
export async function writeNewFileDurably(path: string, data: Uint8Array): Promise<void> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
  const handle = await openNoFollow(path, flags, { mode: 0o600, nonBlock: false })
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** TODO 1117: stopped by shutdown (`stop()`). Thrown at a boundary; the body's catch cleans up and returns via `io`. */
class TransferStopped extends Error {
  constructor() {
    super('data-transfer: stopped for shutdown')
  }
}

function failed(reason: DataTransferFailure, at?: DataTransferFailureAt): DataTransferFailed {
  return at === undefined ? { kind: 'failed', reason } : { kind: 'failed', reason, at }
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

/** Splits the decrypted contents into lines (at newline bytes. Newlines inside JSON strings are escaped, so they do not appear). */
function splitLines(plain: Buffer): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = []
  let start = 0
  while (start < plain.length) {
    const end = plain.indexOf(0x0a, start)
    const stop = end === -1 ? plain.length : end
    lines.push({ start, end: stop })
    start = stop + 1
  }
  return lines
}

type ImportFailure = { readonly reason: CheckFailureReason; readonly at?: DataTransferFailureAt }

/** The sequence of threads to import (version 2 from line 2, version 1 from the head's `threads[]`). `get` returns undefined if it cannot be parsed. */
interface ThreadSource {
  readonly count: number
  get(index: number): { ok: true; value: unknown } | { ok: false }
}

export class DataTransfer {
  private running = false
  /** TODO 1117: shutdown has begun (`stop()`). Once raised, it is never lowered (12.9). */
  private stopping = false
  /** TODO 1117: the body of the running export / import (`stop()` waits for it). Does not include waiting on a dialog. */
  private active: Promise<unknown> | null = null

  constructor(private readonly deps: DataTransferDeps) {}

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
   * TODO 1117: shutdown. Raises the flag and returns after the running body leaves at a boundary (import removes a half-written thread).
   * Called in the `before-quit` sequence before `sessions.stop` and `db.close()`. After that, `runExport` / `runImport` do not touch the DB.
   */
  async stop(): Promise<void> {
    this.stopping = true
    const active = this.active
    if (active !== null) await active.catch(() => undefined)
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
    try {
      const sealer = await createSealer(passphrase, this.deps.kdf ?? DEFAULT_KDF)
      const head: ExportHead = {
        format: EXPORT_FORMAT_NAME,
        formatVersion: EXPORT_FORMAT_VERSION,
        dbUserVersion: this.deps.dbUserVersion,
        appVersion: this.deps.appVersion,
        exportedAt: (this.deps.now ?? Date.now)(),
        home: this.deps.home,
        settings: settingsForHead(JSON.parse(JSON.stringify(this.deps.settings.values())) as Record<string, JsonValue>, true)!
      }
      await sealer.write(`${JSON.stringify(head)}\n`)
      let threads = 0
      let events = 0
      let skippedThreads = 0
      let skippedEvents = 0
      this.checkStopping()
      for (const row of this.deps.store.exportThreadRows()) {
        this.checkStopping()
        const meta = threads < LIMITS.threads ? normalizeThreadMeta(threadMetaOf(row)) : null
        if (meta === null) {
          skippedThreads += 1
          continue
        }
        await sealer.write(threadPrefix(meta))
        let inThread = 0
        let after = 0
        for (;;) {
          const page = this.deps.store.exportEventsPage(row.id, after, EXPORT_PAGE)
          const parts: string[] = []
          for (const event of page.events) {
            // The same validation as import. Rows that fail, payloads that are too long, and the part over the count limit are counted rather than written.
            const fits =
              inThread < LIMITS.eventsPerThread &&
              events < LIMITS.eventsTotal &&
              event.payloadJson.length <= LIMITS.payloadChars &&
              checkEvent(event).ok
            if (!fits) {
              skippedEvents += 1
              continue
            }
            parts.push(eventJson(event))
            inThread += 1
            events += 1
          }
          if (parts.length > 0) await sealer.write((inThread > parts.length ? ',' : '') + parts.join(','))
          if (page.lastSeq === null || page.scanned < EXPORT_PAGE) break
          after = page.lastSeq
          await yieldToLoop()
          this.checkStopping()
        }
        await sealer.write(']}\n')
        threads += 1
        await yieldToLoop()
      }
      this.checkStopping()
      const sealed = await sealer.finish()
      if (sealed.length > MAX_FILE_BYTES) return failed('too-large')
      if (options.createNew === true) await (this.deps.writeNewFile ?? writeNewFileDurably)(path, sealed)
      else await this.deps.writeFile(path, sealed)
      const settings = Object.keys(head.settings).length
      log.info('data.export.saved', {
        path,
        threads,
        events,
        skippedThreads,
        skippedEvents,
        settings,
        bytes: sealed.length,
        ms: Date.now() - started
      })
      return { kind: 'done', fileName: basename(path), threads, events, settings, skippedThreads, skippedEvents }
    } catch (err) {
      if (err instanceof TransferStopped) {
        log.info('data.export.stopped', { path })
        return failed('io')
      }
      log.warn('data.export.failed', { path, ...errorFields(err) })
      return failed(err instanceof RangeError ? 'too-large' : 'io')
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
    const started = Date.now()
    const rejected = (reason: DataTransferFailure, at?: DataTransferFailureAt): DataTransferFailed => {
      log.info('data.import.rejected', { path, reason, ...(at === undefined ? {} : { thread: at.thread, event: at.event ?? null }) })
      return failed(reason, at)
    }
    try {
      let bytes: Uint8Array
      try {
        if ((await this.deps.fileSize(path)) > MAX_FILE_BYTES) return failed('too-large')
        bytes = await this.deps.readFile(path)
      } catch (err) {
        log.warn('data.import.readFailed', { path, ...errorFields(err) })
        return failed('io')
      }
      let plain: Buffer
      try {
        plain = await open(bytes, passphrase)
      } catch (err) {
        if (err instanceof SealError) return rejected(err.reason)
        throw err
      }
      const lines = splitLines(plain)
      const parseLine = (index: number): { ok: true; value: unknown } | { ok: false } => {
        const line = lines[index]
        if (line === undefined) return { ok: false }
        try {
          return { ok: true, value: JSON.parse(plain.toString('utf8', line.start, line.end)) as unknown }
        } catch {
          return { ok: false }
        }
      }
      const first = parseLine(0)
      if (!first.ok) return rejected('invalid-file')
      const headCheck = checkHead(first.value)
      if (!headCheck.ok) return rejected(headCheck.reason)
      const { head, legacyThreads } = headCheck
      const source: ThreadSource =
        legacyThreads === null
          ? { count: lines.length - 1, get: (i) => parseLine(i + 1) }
          : { count: legacyThreads.length, get: (i) => ({ ok: true, value: legacyThreads[i] }) }
      if (source.count > LIMITS.threads) return rejected('too-large')

      // Pass 1: validate every line (before writing. If there is a violation, nothing is written).
      const verified = await this.verifyThreads(source)
      if (verified !== null) return rejected(verified.reason, verified.at)
      this.checkStopping()

      // Pass 2: add one thread at a time, in a transaction per chunk.
      const ids: string[] = []
      let events = 0
      let skippedEvents = 0
      let sandboxDropped = 0
      const rebase = (p: string): string => rebaseHome(p, head.home, this.deps.home)
      try {
        const budget = { events: 0 }
        for (let i = 0; i < source.count; i += 1) {
          const parsed = source.get(i)
          // Something that passed pass 1 cannot fail in pass 2 (same buffer). Just in case.
          const checked = parsed.ok ? checkThread(parsed.value, budget) : null
          if (checked === null || !checked.ok) throw new Error('data-transfer: line changed between passes')
          const { events: threadEvents, ...meta } = checked.thread
          skippedEvents += checked.skippedEvents
          // TODO 1109: if the destination does not have it, drop to OFF (adding it ON would be refused at launch and unable to send - 4.2.4).
          const osSandbox = meta.osSandbox && this.deps.supportsOsSandbox(meta.backend)
          if (meta.osSandbox && !osSandbox) sandboxDropped += 1
          const threadId = this.deps.newId()
          let seq = 1
          try {
            for (let offset = 0; offset === 0 || offset < threadEvents.length; offset += IMPORT_CHUNK) {
              // TODO 1117: check shutdown at a chunk boundary. If it throws, the catch below removes the half-written thread (the DB is still open).
              this.checkStopping()
              const result = this.deps.store.importThreadChunk({
                threadId,
                thread: offset === 0 ? { ...meta, osSandbox, cwd: rebase(meta.cwd), allowedDirs: meta.allowedDirs.map(rebase) } : null,
                events: threadEvents.slice(offset, offset + IMPORT_CHUNK),
                seqStart: seq,
                maxPayloadChars: LIMITS.payloadChars,
                newId: this.deps.newId
              })
              seq = result.nextSeq
              events += result.written
              skippedEvents += result.skipped
              await yieldToLoop()
            }
          } catch (err) {
            try {
              this.deps.store.removeImportedThread(threadId)
            } catch (cleanupErr) {
              log.warn('data.import.cleanupFailed', { path, ...errorFields(cleanupErr) })
            }
            throw err
          }
          ids.push(threadId)
          // TODO 1117: a thread boundary. Threads fully added stay; leave without changing settings.
          this.checkStopping()
        }
      } finally {
        // Even if the DB fails midway, tell the list and the index about the threads that were fully added.
        if (ids.length > 0) this.deps.afterImport(ids)
      }
      let settings = 0
      let skippedSettings = 0
      for (const [name, value] of Object.entries(head.settings)) {
        const outcome = this.deps.settings.apply(name, value)
        if (outcome === 'applied') settings += 1
        else if (outcome === 'invalid') skippedSettings += 1
      }
      log.info('data.import.done', {
        path,
        formatVersion: (first.value as { formatVersion: number }).formatVersion,
        dbUserVersion: head.dbUserVersion,
        threads: ids.length,
        events,
        skippedEvents,
        sandboxDropped,
        settings,
        skippedSettings,
        ms: Date.now() - started
      })
      return { kind: 'done', fileName: basename(path), threads: ids.length, events, skippedEvents, settings, skippedSettings }
    } catch (err) {
      if (err instanceof TransferStopped) {
        log.info('data.import.stopped', { path })
        return failed('io')
      }
      log.warn('data.import.failed', { path, ...errorFields(err) })
      return failed('io')
    }
  }

  /** Pass 1: parses and validates every thread's line. If there is a violation, the location of the first one. */
  private async verifyThreads(source: ThreadSource): Promise<ImportFailure | null> {
    const budget = { events: 0 }
    for (let i = 0; i < source.count; i += 1) {
      const parsed = source.get(i)
      if (!parsed.ok) return { reason: 'invalid-file', at: { thread: i + 1 } }
      const checked = checkThread(parsed.value, budget)
      if (!checked.ok) {
        return { reason: checked.reason, at: checked.event === undefined ? { thread: i + 1 } : { thread: i + 1, event: checked.event } }
      }
      await yieldToLoop()
      this.checkStopping()
    }
    return null
  }
}

/**
 * TODO 1306: checks, without writing anything, that `passphrase` opens the export file and that its head line is one this version reads.
 * Used before a restore commits to a restart (so a wrong passphrase is told before the DB is moved aside).
 */
export async function verifyExportFile(
  io: { readonly readFile: (path: string) => Promise<Uint8Array>; readonly fileSize: (path: string) => Promise<number> },
  path: string,
  passphrase: string
): Promise<{ ok: true } | { ok: false; reason: DataTransferFailure }> {
  let plain: Buffer
  try {
    if ((await io.fileSize(path)) > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' }
    plain = await open(await io.readFile(path), passphrase)
  } catch (err) {
    if (err instanceof SealError) return { ok: false, reason: err.reason }
    return { ok: false, reason: 'io' }
  }
  const end = plain.indexOf(0x0a)
  let head: unknown
  try {
    head = JSON.parse(plain.toString('utf8', 0, end === -1 ? plain.length : end))
  } catch {
    return { ok: false, reason: 'invalid-file' }
  }
  const checked = checkHead(head)
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
