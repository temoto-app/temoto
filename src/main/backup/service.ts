/**
 * Automatic backup and recovery (TODO 1306, ARCHITECTURE 8.7). Independent of electron: the keychain, the dialogs, the index process
 * and the idle decision are passed in by `ipc.ts` (tests run it with fakes and a temporary folder).
 *
 * - **A backup is TODO 1088's export file**, written by the same `DataTransfer.runExport` (the timeline as stored = after
 *   `ThreadStore.toPersistable`, sealed with the passphrase by scrypt + AES-256-GCM). No new encryption is invented here.
 * - **Nothing runs until the passphrase is decided** (owner decision 2026-11-22). After that it is kept sealed by the keychain
 *   (`BackupPassphraseStore`) and never asked again. Losing the keychain loses only the stored copy: the passphrase still opens the files.
 * - Once a day (`intervalMs`), only while idle (no running conversation = `SessionManager.activityBlocker()` is null, and the computer has
 *   been idle for a while unless the backup is overdue), keeping the newest `keep` generations. Whole contents every time (no differences).
 * - **A generation is written to a partial file and renamed** only when complete, so a crash midway never breaks a generation.
 *   The partial file's name has a random part and is created exclusively (never through a planted file or symlink).
 *   Rotation deletes only names of our exact shape and **our owner id** (`generations.ts`; the id is in `<userData>/backup.id`, outside
 *   the DB and the keychain). The generation just written is always kept.
 * - **Not when the DB is damaged or not open, nor while a restore has not ended `restored`** (`health`, `importing`): a backup of an
 *   empty or half-filled DB would rotate out the good generations.
 * - The light check of the DB (`quick_check` in the index process) runs **at most once a day**, not right after startup and only while
 *   idle; at once when the previous check did not finish, found damage, or the DB could not be opened (`<userData>/db-check.json`).
 * - **No writes after `db.close()`** (12.9). Two flags: `stopRequested`-like `active` handling per run and `shutdown` (never reset).
 *   `stop()` raises `shutdown`, clears the timers, stops the transfer (its body leaves at a boundary) and waits for the running run.
 * - A verification launch (non-default userData) never runs anything (`unsupportedReason: 'instance'`), and reads / writes none of the
 *   files above.
 * - Logs carry paths, counts and reason codes only - never the passphrase or contents.
 */
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import {
  BACKUP_KEEP,
  BACKUP_STALE_MS,
  type BackupActionResult,
  type BackupFailure,
  type BackupGeneration,
  type BackupRestoreOutcome,
  type BackupStatus,
  type BackupUnsupportedReason,
  type DbHealthState,
  type DbQuickCheckResult
} from '@shared/backup.js'
import type { DataExportResult, DataImportResult, DataTransferFailure } from '@shared/data-transfer.js'
import { errorFields, log } from '../../common/logger.js'
import { checkPassphrase } from '../data-transfer/service.js'
import {
  backupFileName,
  generationsOf,
  generationsToPrune,
  isBackupId,
  partialFileName,
  partialsToSweep,
  type GenerationOrder
} from './generations.js'
import type { PendingRestore, RestoreMarker } from './restore.js'

/** The part of `DataTransfer` this file uses. */
export interface BackupTransfer {
  exclusive<T>(busyResult: T, fn: () => Promise<T>): Promise<T>
  runExport(path: string, passphrase: string, options?: { readonly createNew?: boolean }): Promise<DataExportResult>
  runImport(path: string, passphrase: string): Promise<DataImportResult>
  stop(): Promise<void>
}

/** The passphrase sealed by the OS keychain (`safeStorage`). */
export interface BackupPassphraseStore {
  /** The keychain can seal. */
  available(): boolean
  /**
   * A usable passphrase is stored. Cheap: the answer is remembered (one unseal at most) and updated by `set`, so `status()` does not go
   * to the keychain every time.
   */
  isSet(): boolean
  /** null if none is stored or it can no longer be unsealed (e.g. the keychain item was lost). */
  get(): string | null
  set(passphrase: string): void
}

/** The passphrase typed for a pending restore, sealed by the keychain apart from the remembered one (removed with the marker). */
export interface RestorePassphraseStore {
  available(): boolean
  get(): string | null
  set(passphrase: string): void
}

/** `<userData>/db-check.json`: when the light check last finished, and whether the next launch should check at once. */
export interface DbCheckRecord {
  readonly checkedAt: number | null
  /** The last check did not finish, found damage, or the DB could not be opened: check as soon as the index is up. */
  readonly pending: boolean
}

/** The two small records kept in `app_settings` (owner: main). */
export interface BackupRecordStore {
  lastFailure(): { readonly at: number; readonly reason: BackupFailure } | null
  setLastFailure(value: { readonly at: number; readonly reason: BackupFailure } | null): void
  /** What the newest generation could not hold (TODO 1331 item 3). Counts and the generation's file name only. */
  lastSkipped(): { readonly file: string; readonly events: number; readonly threads: number } | null
  setLastSkipped(value: { readonly file: string; readonly events: number; readonly threads: number } | null): void
  noticeDismissed(): boolean
  dismissNotice(): void
}

export interface BackupDeps {
  readonly unsupportedReason: BackupUnsupportedReason | null
  /** The health known at startup (`unopenable` / `unavailable` when the DB fell back to memory, otherwise `unknown`). */
  readonly initialHealth: DbHealthState
  /** The DB's key could not be read, so a restore must also move `db.key` aside (a new key is created). */
  readonly keyUnreadable: boolean
  readonly transfer: BackupTransfer
  readonly passphrase: BackupPassphraseStore
  readonly restorePassphrase: RestorePassphraseStore
  readonly records: BackupRecordStore
  /** `<userData>/backup.json` (the chosen folder; kept outside the DB so it is readable when the DB is not). */
  readonly configFile: string
  /** `<userData>/backup.id`: this profile's owner id (created once, random, no machine or user name). */
  readonly ownerFile: string
  /** `<userData>/db-check.json` (see `DbCheckRecord`). */
  readonly checkRecordFile: string
  readonly defaultDir: string
  /** No conversation is running (`SessionManager.activityBlocker() === null`). */
  readonly isIdle: () => boolean
  /** Seconds since the last keyboard / mouse input (`powerMonitor.getSystemIdleTime`). */
  readonly systemIdleSeconds: () => number
  /** The light check in the index process. */
  readonly quickCheck: () => Promise<DbQuickCheckResult>
  /** Checks that the passphrase opens a backup file (TODO 1088's `verifyExportFile`). */
  readonly verifyFile: (path: string, passphrase: string) => Promise<{ ok: true } | { ok: false; reason: DataTransferFailure }>
  readonly writeRestoreMarker: (marker: RestoreMarker) => void
  /** Removes the marker and the passphrase sealed for it. */
  readonly removeRestoreMarker: () => void
  readonly onChanged: (status: BackupStatus) => void
  readonly now?: () => number
  readonly keep?: number
  readonly intervalMs?: number
  readonly firstDelayMs?: number
  readonly tickMs?: number
  readonly retryMs?: number
  /** Seconds of no input that count as "idle". */
  readonly idleSeconds?: number
  /** The light check runs at most once per this interval. */
  readonly checkIntervalMs?: number
  /** A due (not urgent) check waits at least this long after the index process is ready. */
  readonly checkDelayMs?: number
}

export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const FIRST_DELAY_MS = 5 * 60 * 1000
const TICK_MS = 10 * 60 * 1000
const RETRY_MS = 60 * 60 * 1000
const IDLE_SECONDS = 120
const PARTIAL_GRACE_MS = 60 * 60 * 1000
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const CHECK_DELAY_MS = 15 * 60 * 1000

/** A random 16-hex-digit id (owner ids and the partial files' nonces). */
function randomId(): string {
  return randomBytes(8).toString('hex')
}

/** Replaces a small file atomically (a fresh temporary name, created exclusively, then renamed over). */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${randomId()}.tmp`
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
}

function fail(reason: BackupFailure): BackupActionResult {
  return { kind: 'failed', reason }
}

/** TODO 1088's reasons -> ours. */
function fromTransfer(reason: DataTransferFailure): BackupFailure {
  switch (reason) {
    case 'busy':
    case 'too-large':
    case 'disk-full':
    case 'decrypt-failed':
    case 'passphrase-short':
    case 'passphrase-long':
      return reason
    default:
      return 'io'
  }
}

export interface PreparedRestore {
  readonly file: string
  readonly fileName: string
  readonly at: number
  readonly passphrase: string
  /** The passphrase came from the user: it is sealed apart for the import only (the remembered one is not changed). */
  readonly fromUser: boolean
}

export class BackupService {
  private shutdown = false
  private health: DbHealthState
  private generations: BackupGeneration[] = []
  private dir: string | null
  private active: Promise<unknown> | null = null
  private running = false
  private lastAttemptAt: number | null = null
  private forceDue = false
  private restoreOutcome: BackupRestoreOutcome | null = null
  /** The import of a restore is running (backups and rotation wait). */
  private importing = false
  private checking = false
  /** When a due check may start (set once the index process is ready). null = not yet / not this launch. */
  private checkNotBefore: number | null = null
  private checkRecord: DbCheckRecord = { checkedAt: null, pending: false }
  private readonly owner: string
  /** When this launch began watching: the reference for "no backup for N days" while there is no generation at all. */
  private readonly watchSince: number
  /** `stale.days` as last pushed (undefined = nothing pushed yet), so a 3-day boundary crossed with no other change is pushed. */
  private pushedStaleDays: number | null | undefined = undefined
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: BackupDeps) {
    this.health = deps.initialHealth
    this.watchSince = (deps.now ?? Date.now)()
    this.dir = this.readConfiguredDir()
    // A verification launch reads and writes none of these files.
    this.owner = this.supported ? this.readOrCreateOwner() : '0000000000000000'
    if (this.supported) {
      this.checkRecord = this.readCheckRecord()
      // The DB could not be opened: whatever opens next (a restore, a repaired file) is checked as soon as the index is up.
      if (deps.initialHealth === 'unopenable' && !this.checkRecord.pending) this.writeCheckRecord({ ...this.checkRecord, pending: true })
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private get keep(): number {
    return this.deps.keep ?? BACKUP_KEEP
  }

  private get interval(): number {
    return this.deps.intervalMs ?? BACKUP_INTERVAL_MS
  }

  private order(now: number): GenerationOrder {
    return { now, futureMs: this.interval }
  }

  get supported(): boolean {
    return this.deps.unsupportedReason === null
  }

  /** This profile's owner id (in the generations' names). */
  get ownerId(): string {
    return this.owner
  }

  // ---- files outside the DB (readable when the DB or the keychain is lost) ----

  private readConfiguredDir(): string | null {
    try {
      if (!existsSync(this.deps.configFile)) return null
      const raw = JSON.parse(readFileSync(this.deps.configFile, 'utf8')) as { dir?: unknown }
      return typeof raw.dir === 'string' && isAbsolute(raw.dir) ? raw.dir : null
    } catch (err) {
      log.warn('backup.config.unreadable', errorFields(err))
      return null
    }
  }

  private writeConfiguredDir(dir: string | null): void {
    writeAtomic(this.deps.configFile, JSON.stringify({ dir }))
    this.dir = dir
  }

  private readOrCreateOwner(): string {
    try {
      if (existsSync(this.deps.ownerFile)) {
        const text = readFileSync(this.deps.ownerFile, 'utf8').trim()
        if (isBackupId(text)) return text
        log.warn('backup.id.invalid', { path: this.deps.ownerFile })
      }
    } catch (err) {
      log.warn('backup.id.unreadable', { path: this.deps.ownerFile, ...errorFields(err) })
    }
    const id = randomId()
    try {
      writeAtomic(this.deps.ownerFile, `${id}\n`)
      log.info('backup.id.created', { path: this.deps.ownerFile })
    } catch (err) {
      // Used for this launch only; the next launch makes another one (this launch's generations then count as another owner's).
      log.warn('backup.id.writeFailed', { path: this.deps.ownerFile, ...errorFields(err) })
    }
    return id
  }

  private readCheckRecord(): DbCheckRecord {
    try {
      if (!existsSync(this.deps.checkRecordFile)) return { checkedAt: null, pending: false }
      const raw = JSON.parse(readFileSync(this.deps.checkRecordFile, 'utf8')) as { checkedAt?: unknown; pending?: unknown }
      return {
        checkedAt: typeof raw.checkedAt === 'number' && Number.isFinite(raw.checkedAt) ? raw.checkedAt : null,
        pending: raw.pending === true
      }
    } catch (err) {
      log.warn('db.checkRecord.unreadable', errorFields(err))
      // Unknown history: check soon rather than skip.
      return { checkedAt: null, pending: true }
    }
  }

  private writeCheckRecord(record: DbCheckRecord): void {
    this.checkRecord = record
    try {
      writeAtomic(this.deps.checkRecordFile, JSON.stringify(record))
    } catch (err) {
      log.warn('db.checkRecord.writeFailed', errorFields(err))
    }
  }

  get backupDir(): string {
    return this.dir ?? this.deps.defaultDir
  }

  // ---- status ----

  /**
   * Whole days without a successful backup when that has reached `BACKUP_STALE_MS` (TODO 1331 item 2), else null. Automatic backup waits
   * for no conversation to be running and records nothing then, so this is the only sign of a backup that quietly never happens.
   * The reference is the newest generation of ours, or, with none, when this launch began watching. Not reported when the DB is
   * unhealthy (its own band explains why nothing is made) or when backups are not set up.
   */
  private staleDays(now: number): number | null {
    if (!this.supported || !this.deps.passphrase.isSet() || this.broken()) return null
    const reference = this.generations[0]?.at ?? this.watchSince
    const age = now - reference
    return age >= BACKUP_STALE_MS ? Math.floor(age / (24 * 60 * 60 * 1000)) : null
  }

  /** The counts the newest generation could not hold, only while that generation is still the newest. */
  private skippedOfNewest(): { readonly events: number; readonly threads: number } | null {
    if (!this.supported) return null
    const newest = this.generations[0]
    if (newest === undefined) return null
    let record: ReturnType<BackupRecordStore['lastSkipped']> = null
    try {
      record = this.deps.records.lastSkipped()
    } catch (err) {
      log.warn('backup.record.failed', errorFields(err))
    }
    if (record === null || record.file !== newest.fileName || record.events + record.threads === 0) return null
    return { events: record.events, threads: record.threads }
  }

  status(): BackupStatus {
    const newest = this.generations[0]
    const failure = this.supported ? this.deps.records.lastFailure() : null
    const staleDays = this.staleDays(this.now())
    return {
      supported: this.supported,
      unsupportedReason: this.deps.unsupportedReason,
      passphraseSet: this.supported && this.deps.passphrase.isSet(),
      noticeDismissed: !this.supported || this.deps.records.noticeDismissed(),
      dir: this.backupDir,
      dirIsDefault: this.dir === null,
      running: this.running,
      generations: [...this.generations],
      lastFailure: failure !== null && (newest === undefined || failure.at > newest.at) ? failure : null,
      health: this.health,
      restore: this.restoreOutcome,
      keep: this.keep,
      stale: staleDays === null ? null : { days: staleDays },
      skipped: this.skippedOfNewest()
    }
  }

  private changed(): void {
    if (this.shutdown) return
    try {
      const status = this.status()
      this.pushedStaleDays = status.stale?.days ?? null
      this.deps.onChanged(status)
    } catch (err) {
      log.warn('backup.push.failed', errorFields(err))
    }
  }

  /** Re-reads our generations in the folder (other owners' are not listed). A missing folder is simply "none". */
  async refresh(): Promise<void> {
    if (!this.supported) return
    let names: string[]
    try {
      names = await readdir(this.backupDir)
    } catch {
      this.generations = []
      return
    }
    const found: BackupGeneration[] = []
    for (const entry of generationsOf(names, this.owner, this.order(this.now()))) {
      try {
        const info = await stat(join(this.backupDir, entry.name))
        if (info.isFile()) found.push({ fileName: entry.name, at: entry.at, bytes: info.size })
      } catch {
        // Vanished between readdir and stat.
      }
    }
    this.generations = found
  }

  // ---- schedule ----

  start(): void {
    if (!this.supported || this.shutdown) return
    void this.refresh().then(() => this.changed())
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null
      void this.tick()
      this.tickTimer = setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS)
    }, this.deps.firstDelayMs ?? FIRST_DELAY_MS)
  }

  private broken(): boolean {
    return (
      this.importing ||
      this.health === 'corrupt' ||
      this.health === 'unopenable' ||
      this.health === 'unavailable' ||
      this.health === 'restore-incomplete'
    )
  }

  /**
   * Due: never backed up, the newest is older than the interval, or a backup was asked for (passphrase changed, new folder) - but not
   * within an hour of a failed attempt. `generations[0]` is the newest that is not from the future (`generations.ts`); when only ones from
   * the future exist (the clock went back), it is due.
   */
  isDue(now: number = this.now()): boolean {
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < (this.deps.retryMs ?? RETRY_MS)) return false
    if (this.forceDue) return true
    const newest = this.generations[0]
    return newest === undefined || now - newest.at >= this.interval || newest.at - now > this.interval
  }

  private userIdle(): boolean {
    return this.deps.systemIdleSeconds() >= (this.deps.idleSeconds ?? IDLE_SECONDS)
  }

  /** One check of the schedule. Public for tests. */
  async tick(): Promise<void> {
    if (!this.supported || this.shutdown) return
    const now = this.now()
    // Crossing the 3-day line (or a further whole day) changes nothing else, so push it from here.
    if (this.pushedStaleDays !== undefined && (this.staleDays(now) ?? null) !== this.pushedStaleDays) this.changed()
    if (this.active !== null || this.checking) return
    // The daily light check first, while nobody is using the app (a search waits for the table being checked).
    if (this.checkReady(now) && this.deps.isIdle() && this.userIdle()) {
      await this.checkHealth('daily')
      return
    }
    if (this.broken()) return
    if (!this.deps.passphrase.isSet()) return
    await this.refresh()
    if (!this.isDue(now)) return
    if (!this.deps.isIdle()) return
    const newest = this.generations[0]
    const overdue = newest === undefined || now - newest.at >= 2 * this.interval
    if (!overdue && !this.userIdle()) return
    await this.backup('auto')
  }

  // ---- backup ----

  async runNow(): Promise<BackupActionResult> {
    return this.backup('manual')
  }

  private async ensureDir(): Promise<BackupFailure | null> {
    const dir = this.backupDir
    if (this.dir === null) {
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        return null
      } catch (err) {
        log.warn('backup.dir.createFailed', { path: dir, ...errorFields(err) })
        return 'io'
      }
    }
    // A chosen folder is never created (an external disk that is not connected must not get a folder under /Volumes).
    try {
      return (await stat(dir)).isDirectory() ? null : 'dir-missing'
    } catch {
      return 'dir-missing'
    }
  }

  private async backup(trigger: 'auto' | 'manual'): Promise<BackupActionResult> {
    if (!this.supported) return fail('unsupported')
    if (this.shutdown) return fail('io')
    if (this.broken()) return fail('unhealthy')
    if (this.active !== null) return fail('busy')
    if (!this.deps.passphrase.isSet()) return fail('no-passphrase')
    const passphrase = this.deps.passphrase.get()
    if (passphrase === null) return fail('no-passphrase')
    const run = this.backupBody(trigger, passphrase)
    this.active = run
    this.running = true
    this.changed()
    try {
      return await run
    } finally {
      this.active = null
      this.running = false
      this.changed()
    }
  }

  /** Removes our partial file after a failure, only if it is a plain file (never a symlink or anything planted under the name). */
  private async removePartial(path: string): Promise<void> {
    try {
      if ((await lstat(path)).isFile()) await rm(path, { force: true })
    } catch {
      // Not there.
    }
  }

  private async backupBody(trigger: 'auto' | 'manual', passphrase: string): Promise<BackupActionResult> {
    const started = this.now()
    this.lastAttemptAt = started
    const dir = this.backupDir
    const record = (reason: BackupFailure): BackupActionResult => {
      if (!this.shutdown) {
        try {
          this.deps.records.setLastFailure({ at: started, reason })
        } catch (err) {
          log.warn('backup.record.failed', errorFields(err))
        }
      }
      log.warn('backup.failed', { trigger, reason, path: dir })
      return fail(reason)
    }
    const dirFailure = await this.ensureDir()
    if (dirFailure !== null) return record(dirFailure)
    const finalName = backupFileName(started, this.owner)
    // A random part: the name cannot be planted in advance. The export creates it exclusively (an entry already there is a failure).
    const partial = join(dir, partialFileName(started, this.owner, randomId()))
    const result = await this.deps.transfer.exclusive<DataExportResult>({ kind: 'failed', reason: 'busy' }, () =>
      this.deps.transfer.runExport(partial, passphrase, { createNew: true })
    )
    if (result.kind !== 'done') {
      await this.removePartial(partial)
      // `busy` (the user is exporting / importing) is not a failure worth showing: try again at a later tick.
      if (result.kind === 'failed' && result.reason === 'busy') {
        this.lastAttemptAt = null
        return fail('busy')
      }
      return record(result.kind === 'failed' ? fromTransfer(result.reason) : 'io')
    }
    try {
      // The export fsynced the contents through its own descriptor before closing, so the name says "complete" only after that.
      await rename(partial, join(dir, finalName))
    } catch (err) {
      log.warn('backup.rename.failed', { path: partial, ...errorFields(err) })
      await this.removePartial(partial)
      return record('io')
    }
    // Only now is the backup that was asked for (new passphrase / folder) really there.
    this.forceDue = false
    const removed = await this.prune(dir, started, finalName)
    await this.refresh()
    if (!this.shutdown) {
      try {
        this.deps.records.setLastSkipped(
          result.skippedEvents + result.skippedThreads === 0
            ? null
            : { file: finalName, events: result.skippedEvents, threads: result.skippedThreads }
        )
      } catch (err) {
        log.warn('backup.record.failed', errorFields(err))
      }
      try {
        this.deps.records.setLastFailure(null)
      } catch (err) {
        log.warn('backup.record.failed', errorFields(err))
      }
    }
    log.info('backup.saved', {
      trigger,
      path: join(dir, finalName),
      threads: result.threads,
      events: result.events,
      skippedThreads: result.skippedThreads,
      skippedEvents: result.skippedEvents,
      removed,
      ms: this.now() - started
    })
    return { kind: 'done' }
  }

  /**
   * Deletes our generations past `keep` and our old partial files. Only names of our exact shape and owner id. `justWritten` is always
   * kept (a clock that went back must not delete the generation just written).
   */
  private async prune(dir: string, now: number, justWritten: string): Promise<number> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return 0
    }
    let removed = 0
    const doomed = [
      ...generationsToPrune(names, this.keep, this.owner, this.order(now), justWritten),
      ...partialsToSweep(names, this.owner, now, PARTIAL_GRACE_MS)
    ]
    for (const name of doomed) {
      try {
        await rm(join(dir, name), { force: true })
        removed += 1
      } catch (err) {
        log.warn('backup.prune.failed', { path: join(dir, name), ...errorFields(err) })
      }
    }
    return removed
  }

  // ---- settings ----

  setPassphrase(raw: unknown): BackupActionResult {
    if (!this.supported) return fail('unsupported')
    if (this.shutdown) return fail('io')
    const checked = checkPassphrase(raw, true)
    if (!checked.ok) return fail(checked.reason === 'passphrase-long' ? 'passphrase-long' : 'passphrase-short')
    if (!this.deps.passphrase.available()) return fail('unsupported')
    try {
      this.deps.passphrase.set(checked.value)
    } catch (err) {
      log.warn('backup.passphrase.saveFailed', errorFields(err))
      return fail('io')
    }
    log.info('backup.passphrase.saved', {})
    // The older generations open only with the previous passphrase: make a new one soon.
    this.forceDue = true
    this.lastAttemptAt = null
    this.changed()
    return { kind: 'done' }
  }

  /** `dir` is validated by the caller (`FsAccess.assertAllowed` on a path main's dialog returned). null = back to the default. */
  async setDir(dir: string | null): Promise<BackupActionResult> {
    if (!this.supported) return fail('unsupported')
    if (this.shutdown) return fail('io')
    if (dir !== null) {
      if (!isAbsolute(dir)) return fail('dir-denied')
      try {
        if (!(await stat(dir)).isDirectory()) return fail('dir-missing')
      } catch {
        return fail('dir-missing')
      }
    }
    try {
      this.writeConfiguredDir(dir)
    } catch (err) {
      log.warn('backup.config.writeFailed', errorFields(err))
      return fail('io')
    }
    log.info('backup.dir.changed', { path: this.backupDir, default: dir === null })
    await this.refresh()
    // A folder with no generation of ours yet gets one soon.
    if (this.generations.length === 0) {
      this.forceDue = true
      this.lastAttemptAt = null
    }
    this.changed()
    return { kind: 'done' }
  }

  dismissNotice(): void {
    if (!this.supported || this.shutdown) return
    this.deps.records.dismissNotice()
    this.changed()
  }

  // ---- health ----

  private checkDue(now: number): boolean {
    const at = this.checkRecord.checkedAt
    const interval = this.deps.checkIntervalMs ?? CHECK_INTERVAL_MS
    return this.checkRecord.pending || at === null || now - at >= interval || at - now > interval
  }

  /** A due check may start now (the index is up, the delay has passed, and the state is one a check can change). */
  private checkReady(now: number): boolean {
    return (
      this.checkNotBefore !== null &&
      now >= this.checkNotBefore &&
      !this.importing &&
      (this.health === 'unknown' || this.health === 'ok') &&
      this.checkDue(now)
    )
  }

  /**
   * Called once the index process is ready (only for a DB opened as a file). Urgent (the last check did not finish or found damage, or
   * the DB could not be opened last time): checks now. Otherwise a due check (once a day) waits `checkDelayMs` and then for an idle tick.
   */
  async startHealthCheck(): Promise<void> {
    if (!this.supported || this.shutdown) return
    // Later checks (daily, also in a launch that stays up for days) wait for the delay and an idle tick.
    this.checkNotBefore = this.now() + (this.deps.checkDelayMs ?? CHECK_DELAY_MS)
    if (this.checkRecord.pending) await this.checkHealth('urgent')
  }

  /** The light check (`quick_check` per table, in the index process). Only when the state is `unknown` / `ok`. */
  async checkHealth(trigger: 'urgent' | 'daily' | 'manual' = 'manual'): Promise<void> {
    if (!this.supported || this.shutdown || this.checking || this.importing) return
    if (this.health !== 'unknown' && this.health !== 'ok') return
    this.checking = true
    const before = this.health
    this.health = 'checking'
    this.changed()
    // If this launch dies or quits midway, the next one checks at once.
    this.writeCheckRecord({ checkedAt: this.checkRecord.checkedAt, pending: true })
    let result: DbQuickCheckResult
    try {
      result = await this.deps.quickCheck()
    } catch (err) {
      this.checking = false
      if (this.shutdown) return
      log.warn('db.quickCheck.failed', { trigger, ...errorFields(err) })
      this.health = before
      this.changed()
      return
    }
    this.checking = false
    if (this.shutdown) return
    if (result.stopped) {
      this.health = before
    } else {
      this.health = result.ok ? 'ok' : 'corrupt'
      // Damage keeps `pending`, so the next launch checks again at once (and does not back up a damaged DB in between).
      this.writeCheckRecord({ checkedAt: this.now(), pending: !result.ok })
    }
    log[result.ok || result.stopped ? 'info' : 'error']('db.quickCheck', {
      trigger,
      ok: result.ok,
      stopped: result.stopped,
      tables: result.tables,
      damaged: result.damaged.join(','),
      ms: result.ms,
      slowestTable: result.slowest?.table ?? null,
      slowestMs: result.slowest?.ms ?? null
    })
    this.changed()
  }

  // ---- restore ----

  /**
   * Step 1 of a restore: checks everything that can be checked before the restart (the DB is broken or a restore did not finish, there is
   * a backup of ours, the passphrase opens it). Writes nothing. `passphraseRaw` is used when the user typed one; otherwise the stored one.
   */
  async prepareRestore(passphraseRaw: unknown): Promise<{ ok: true; value: PreparedRestore } | { ok: false; reason: BackupFailure }> {
    if (!this.supported) return { ok: false, reason: 'unsupported' }
    if (this.shutdown) return { ok: false, reason: 'io' }
    if (this.importing) return { ok: false, reason: 'busy' }
    if (this.health !== 'corrupt' && this.health !== 'unopenable' && this.health !== 'restore-incomplete') {
      return { ok: false, reason: 'not-broken' }
    }
    await this.refresh()
    const newest = this.generations[0]
    if (newest === undefined) return { ok: false, reason: 'no-backup' }
    const typed = typeof passphraseRaw === 'string' && passphraseRaw !== '' ? checkPassphrase(passphraseRaw, false) : null
    if (typed !== null && !typed.ok) return { ok: false, reason: 'passphrase-long' }
    const passphrase = typed?.ok === true ? typed.value : this.deps.passphrase.get()
    if (passphrase === null) return { ok: false, reason: 'passphrase-needed' }
    const file = join(this.backupDir, newest.fileName)
    const verified = await this.deps.verifyFile(file, passphrase)
    if (!verified.ok) {
      log.info('backup.restore.rejected', { path: file, reason: verified.reason })
      // A stored passphrase that does not open the newest file (changed after it was written, or a lost keychain item): ask.
      if (verified.reason === 'decrypt-failed') return { ok: false, reason: typed === null ? 'passphrase-needed' : 'decrypt-failed' }
      return { ok: false, reason: fromTransfer(verified.reason) }
    }
    return { ok: true, value: { file, fileName: newest.fileName, at: newest.at, passphrase, fromUser: typed !== null } }
  }

  /**
   * Step 1, after the user confirmed: leave the marker (and, for a typed passphrase, seal it apart for the import). The remembered
   * passphrase is never changed here. The caller restarts the app.
   */
  commitRestore(prepared: PreparedRestore): BackupActionResult {
    if (this.shutdown) return fail('io')
    try {
      // A marker or a sealed passphrase left by an earlier attempt goes first.
      this.deps.removeRestoreMarker()
    } catch (err) {
      log.warn('backup.restore.markerClearFailed', errorFields(err))
      return fail('io')
    }
    if (prepared.fromUser) {
      if (!this.deps.restorePassphrase.available()) return fail('unsupported')
      try {
        this.deps.restorePassphrase.set(prepared.passphrase)
      } catch (err) {
        log.warn('backup.restore.passphraseSaveFailed', errorFields(err))
        return fail('io')
      }
    }
    try {
      this.deps.writeRestoreMarker({
        version: 1,
        file: prepared.file,
        moveKey: this.deps.keyUnreadable,
        phase: 'move',
        createdAt: this.now()
      })
    } catch (err) {
      log.warn('backup.restore.markerFailed', errorFields(err))
      try {
        this.deps.removeRestoreMarker()
      } catch {
        // The next launch ignores a sealed passphrase without a marker.
      }
      return fail('io')
    }
    log.info('backup.restore.scheduled', { path: prepared.file, moveKey: this.deps.keyUnreadable, typed: prepared.fromUser })
    return { kind: 'done' }
  }

  private restoreIncomplete(fileName: string, reason: BackupFailure, path: string): void {
    this.health = 'restore-incomplete'
    this.restoreOutcome = { kind: 'failed', fileName, reason }
    log.error('backup.restore.failed', { path, reason })
  }

  /**
   * Step 3 (after the restart, once the services are up; call right after `start()`). Imports the backup into the fresh DB. The marker
   * is rewritten as `importing` just before the import starts and removed only when it ends `restored`; until then backups and rotation
   * stay stopped (`importing`, then `restore-incomplete`). An interrupted restore (the previous launch died midway) is not imported again.
   */
  async importPending(pending: PendingRestore): Promise<void> {
    if (this.shutdown) return
    const fileName = basename(pending.file)
    if (pending.interrupted) {
      this.restoreIncomplete(fileName, 'interrupted', pending.file)
      this.changed()
      return
    }
    this.importing = true
    try {
      const passphrase = this.deps.restorePassphrase.get() ?? this.deps.passphrase.get()
      if (passphrase === null) {
        this.restoreIncomplete(fileName, 'passphrase-needed', pending.file)
        return
      }
      try {
        this.deps.writeRestoreMarker({
          version: 1,
          file: pending.file,
          moveKey: pending.moveKey,
          phase: 'importing',
          createdAt: pending.createdAt
        })
      } catch (err) {
        // Without the `importing` mark a crash midway would import twice: do not start.
        log.warn('backup.restore.markerFailed', errorFields(err))
        this.restoreIncomplete(fileName, 'io', pending.file)
        return
      }
      const run = this.deps.transfer.exclusive<DataImportResult>({ kind: 'failed', reason: 'busy' }, () =>
        this.deps.transfer.runImport(pending.file, passphrase)
      )
      this.active = run
      let result: DataImportResult
      try {
        result = await run
      } finally {
        this.active = null
      }
      if (result.kind === 'done') {
        try {
          this.deps.removeRestoreMarker()
        } catch (err) {
          log.warn('backup.restore.markerClearFailed', errorFields(err))
        }
        log.info('backup.restore.imported', { path: pending.file, threads: result.threads, events: result.events, settings: result.settings })
        this.restoreOutcome = { kind: 'restored', fileName, threads: result.threads, events: result.events, settings: result.settings }
        return
      }
      this.restoreIncomplete(fileName, result.kind === 'failed' ? fromTransfer(result.reason) : 'io', pending.file)
    } finally {
      this.importing = false
      this.changed()
    }
  }

  /**
   * "Keep the current database": after a restore that did not finish, the user chooses not to restore again. The marker goes, and the DB
   * is checked (at the next idle tick) and then backed up like any other.
   */
  keepCurrent(): BackupActionResult {
    if (!this.supported) return fail('unsupported')
    if (this.shutdown) return fail('io')
    if (this.health !== 'restore-incomplete') return fail('not-broken')
    try {
      this.deps.removeRestoreMarker()
    } catch (err) {
      log.warn('backup.restore.markerClearFailed', errorFields(err))
      return fail('io')
    }
    log.info('backup.restore.abandoned', {})
    this.restoreOutcome = null
    this.writeCheckRecord({ checkedAt: this.checkRecord.checkedAt, pending: true })
    if (this.deps.initialHealth === 'unknown') {
      this.health = 'unknown'
      this.checkNotBefore = this.now()
    } else {
      // This launch's DB is not a file (it fell back to memory): nothing to check or back up until a launch opens one.
      this.health = this.deps.initialHealth
    }
    this.changed()
    return { kind: 'done' }
  }

  // ---- shutdown ----

  /**
   * Shutdown (12.9). Raises the flag (never lowered), clears the timers, stops the transfer (a running backup / restore leaves at a
   * boundary: an export does not write its file, an import removes its half-written thread) and waits for the running body.
   * Called in `before-quit` before `dataTransfer.stop` / `sessions.stop` / `db.close()`.
   */
  async stop(): Promise<void> {
    this.shutdown = true
    if (this.firstTimer !== null) clearTimeout(this.firstTimer)
    this.firstTimer = null
    if (this.tickTimer !== null) clearInterval(this.tickTimer)
    this.tickTimer = null
    const active = this.active
    if (active !== null) {
      await this.deps.transfer.stop()
      await active.catch(() => undefined)
    }
  }
}
