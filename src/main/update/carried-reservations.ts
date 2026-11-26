/**
 * TODO 1337: carry stopped send reservations over an idle restart for an update (ARCHITECTURE 8.5). The same mechanism as the Composer drafts
 * (`carried-drafts.ts`, TODO 1333), owner decision 2026-11-26:
 *
 * 1. **Carry** (right before the idle restart, in the same synchronous step as the last `restartBlocker` check): the reservations of the stopped queues
 *    (`paused`, left after the stop button, an abnormal exit or a failed send) are written to the encrypted DB (`app_settings` key
 *    `update.carriedReservations`) - never a plain file, never the log (only counts are logged). A reservation that cannot be carried (an attachment, a
 *    selection, over the limits; see `carriedReservationOf`) and a queue that moves by itself keep the restart waiting through `restartBlocker`, so they never
 *    reach this point - and if they do anyway, nothing is written and the restart is called off (`carry` returns false).
 * 2. **Follow memory** while the restart is under way: a change to the reservations after the copy was written (cancelled, taken back, stopped) rewrites the
 *    copy, so a reservation the user removed does not come back. A restart that is called off removes what was written for it (`discard`); from then on
 *    memory is the only copy again.
 * 3. **Put back** (the next launch, `start`, once the threads can be read): into each thread's queue, **stopped** - nothing is sent until the user sends
 *    again. A thread that is gone (deleted, also into "Deleted") gets nothing back; only the count is logged. The stored copy is rewritten **only after** every
 *    reservation is in memory; restoring is idempotent (by reservation id), so a crash in between restores the same set once at the next launch.
 *
 * Wave 106 review Z1 - nothing is lost before it is taken out: a thread whose restore threw is **held** (kept in the copy and mixed into every later write,
 * tried again before the next carry), and a stored value this build cannot read (a later build wrote it) is kept **unread** and written along, for a build
 * that reads it. Only unread values over `CARRIED_RESERVATIONS_MAX_BYTES` are dropped (their size is logged).
 *
 * Only the idle restart carries; Cmd+Q, a crash and "Restart to Update" lose the reservations as before. Nothing is dropped for being old.
 * Independent of electron.
 */
import { log } from '../../common/logger.js'
import { UPDATE_CARRIED_RESERVATIONS, type SettingKey } from '../../common/settings-keys.js'
import { isThinkingLevel } from '@shared/agent.js'
import {
  CARRIED_RESERVATIONS_MAX_BYTES,
  CARRIED_RESERVATIONS_MAX_ENTRIES,
  type CarriedInput,
  type CarriedReservation,
  type CarriedReservationTable
} from '../session/send-queue.js'

export interface CarriedReservationsSettings {
  readTyped<T>(def: SettingKey<T>): T
  writeTyped<T>(def: SettingKey<T>, value: T): void
}

export interface CarriedReservationsDeps {
  readonly settings: CarriedReservationsSettings
  /** `SessionManager.carriedReservations()`: the stopped reservations, or null when they cannot all be carried. */
  readonly snapshot: () => CarriedReservationTable | null
  /** `SessionManager.carriableReservationsNow()`: the carriable stopped reservations, ignoring the rest (to follow memory). */
  readonly carriableNow: () => CarriedReservationTable
  /** `SessionManager.restoreCarriedReservations()`: null if the thread is gone. */
  readonly restore: (
    threadId: string,
    items: readonly CarriedReservation[]
  ) => { readonly restored: number; readonly invalid: number } | null
  readonly now?: () => number
}

const MAX_ID = 200

interface RestoreCounts {
  restored: number
  gone: number
  invalid: number
  already: number
}

export class CarriedReservationsService {
  private readonly now: () => number
  /** A copy written by `carry` in this run that has not been discarded (the restart is under way). */
  private stored = false
  /**
   * Wave 106 review Z1: readable reservations whose restore threw at launch, per thread. They live only in the stored copy, so every later write (`carry`,
   * `follow`, `discard`, `stop`) mixes them in - a write of memory alone would lose them. `carry` tries to put them back first.
   */
  private held: Record<string, readonly CarriedReservation[]> = {}
  /**
   * Wave 106 review Z1: stored values this build cannot read (a later build wrote them; read here after going back to an older version). Kept as they are and
   * written along with every later write, so a build that reads them puts them back at a later launch. Dropped only over `CARRIED_RESERVATIONS_MAX_BYTES`.
   */
  private unread: unknown[] = []
  /**
   * The stored value is not what this run should leave (a removal or a rewrite failed, or a held thread was put back since): written again at the next
   * chance (the next idle restart, even with nothing to carry, or shutdown), or the next launch would restore reservations this run already handled.
   */
  private dirty = false
  private stopped = false

  constructor(private readonly deps: CarriedReservationsDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * At launch, after the threads can be read: put the previous run's copy back, stopped. The copy is rewritten only after everything readable is in memory.
   * A value this build cannot read is kept (`unread`), never removed for that.
   */
  start(): void {
    let stored
    try {
      stored = this.deps.settings.readTyped(UPDATE_CARRIED_RESERVATIONS)
    } catch {
      return
    }
    if (stored === null) return
    const tables: CarriedReservationTable[] = []
    const unread: unknown[] = []
    for (const candidate of [stored.threads, ...(stored.unread ?? [])]) {
      if (candidate === undefined) continue
      const table = parseCarriedReservations(candidate)
      if (table === null) unread.push(candidate)
      else tables.push(table)
    }
    const { kept, droppedBytes } = withinUnreadLimit(unread)
    this.unread = kept
    if (droppedBytes > 0) log.info('update.reservations.dropped', { bytes: droppedBytes })
    if (tables.length === 0) {
      // Nothing this build can read: the stored value stays exactly as it is (rewritten only when something had to be dropped).
      if (droppedBytes > 0 && !this.write({}, stored.savedAt)) this.dirty = true
      if (kept.length > 0) log.info('update.reservations.unread', { values: kept.length })
      return
    }
    const counts: RestoreCounts = { restored: 0, gone: 0, invalid: 0, already: 0 }
    // A thread whose restore threw stays held (and only those): its reservations are not lost, and the ones already in memory are not restored twice.
    this.held = this.restoreAll(mergeTables(tables), counts)
    // If this fails the whole copy stays (losing nothing is first) and is rewritten at the next chance. The reservations already in memory are skipped by id.
    if (!this.write({}, stored.savedAt)) this.dirty = true
    log.info('update.reservations.restored', { ...counts, failed: countOf(this.held), unread: kept.length })
  }

  /**
   * Right before the idle restart: write the stopped reservations (with what is still held or unread from launch). true = safe to restart (nothing to
   * carry, or everything is written); false = something cannot be carried or the write failed, so the restart must not happen (the caller removes whatever
   * was written for it). Never throws.
   */
  carry(): boolean {
    if (this.stopped) return false
    // The held threads are tried again first: one that goes back now is carried from memory like the rest.
    this.retryHeld()
    const table = this.deps.snapshot()
    if (table === null) {
      log.info('update.reservations.blocked', { why: 'not-carriable' })
      return false
    }
    // What is held counts against the same limits: over them the restart waits (losing nothing is first).
    if (!withinLimits(mergeTables([table, this.held]))) {
      log.info('update.reservations.blocked', { why: 'over-limits' })
      return false
    }
    const count = countOf(table)
    if (count === 0) {
      // The stored value already holds what is held or unread - unless a write failed or a held thread went back since: then it must be fixed now, or the
      // next launch would restore reservations this run already handled.
      if (!this.dirty) return true
      this.dirty = !this.write({}, this.now())
      return !this.dirty
    }
    if (!this.write(table, this.now())) {
      log.info('update.reservations.blocked', { why: 'write-failed' })
      return false
    }
    this.stored = true
    this.dirty = false
    log.info('update.reservations.carried', {
      threads: Object.keys(table).length,
      reservations: count,
      held: countOf(this.held),
      unread: this.unread.length
    })
    return true
  }

  /**
   * The reservations changed after `carry` wrote the copy (the restart is under way): write what memory holds now (with what is held or unread), so a
   * reservation the user cancelled or took back is not restored, and one stopped since is. Nothing happens when no copy is out.
   */
  follow(): void {
    if (this.stopped || !this.stored) return
    // A failed write leaves the older copy; `discard` rewrites it if the restart is called off.
    this.write(this.deps.carriableNow(), this.now())
  }

  /**
   * The restart was called off after `carry`: remove what was written for it, so memory is the only copy again (a later change must not be undone by it at a
   * later launch). What is held or unread stays.
   */
  discard(): void {
    if (this.stopped || !this.stored) return
    this.stored = false
    if (!this.write({}, this.now())) this.dirty = true
  }

  /** Shutdown, before the DB closes (12.9): retry a rewrite that failed; nothing is written afterwards. A copy written for the restart stays. */
  stop(): void {
    if (this.stopped) return
    if (this.dirty && !this.stored && this.write({}, this.now())) this.dirty = false
    this.stopped = true
  }

  /** Put the held threads back again; the ones that go back (or whose thread is gone) are no longer held. */
  private retryHeld(): void {
    if (Object.keys(this.held).length === 0) return
    const before = countOf(this.held)
    const counts: RestoreCounts = { restored: 0, gone: 0, invalid: 0, already: 0 }
    this.held = this.restoreAll(this.held, counts)
    const failed = countOf(this.held)
    if (failed === before) return
    // The stored value still has them: this carry rewrites it (also with nothing to carry), or shutdown does.
    this.dirty = true
    log.info('update.reservations.restored', { ...counts, failed, retried: true })
  }

  /** Restore each thread; returns the threads whose restore threw (they stay held). */
  private restoreAll(table: CarriedReservationTable, counts: RestoreCounts): Record<string, readonly CarriedReservation[]> {
    const failed: Record<string, readonly CarriedReservation[]> = {}
    for (const [threadId, items] of Object.entries(table)) {
      let result: ReturnType<CarriedReservationsDeps['restore']>
      try {
        result = this.deps.restore(threadId, items)
      } catch {
        failed[threadId] = items
        continue
      }
      if (result === null) {
        counts.gone += items.length
        continue
      }
      counts.restored += result.restored
      counts.invalid += result.invalid
      counts.already += items.length - result.restored - result.invalid
    }
    return failed
  }

  /** Write `table` together with what is held and unread (with nothing at all the key is removed). false if the write failed; never throws. */
  private write(table: CarriedReservationTable, savedAt: number): boolean {
    const threads = mergeTables([table, this.held])
    const empty = countOf(threads) === 0 && this.unread.length === 0
    try {
      this.deps.settings.writeTyped(
        UPDATE_CARRIED_RESERVATIONS,
        empty ? null : { savedAt, threads, ...(this.unread.length === 0 ? {} : { unread: this.unread }) }
      )
      return true
    } catch {
      return false
    }
  }
}

function countOf(table: CarriedReservationTable): number {
  let count = 0
  for (const items of Object.values(table)) count += items.length
  return count
}

/** The tables as one, per thread in order; an id already taken in that thread is skipped (restoring is by id, so the first copy is enough). */
function mergeTables(tables: readonly CarriedReservationTable[]): Record<string, readonly CarriedReservation[]> {
  const merged: Record<string, CarriedReservation[]> = {}
  for (const table of tables) {
    for (const [threadId, items] of Object.entries(table)) {
      if (items.length === 0) continue
      const into = (merged[threadId] ??= [])
      const ids = new Set(into.map((entry) => entry.id))
      for (const entry of items) {
        if (ids.has(entry.id)) continue
        ids.add(entry.id)
        into.push(entry)
      }
    }
  }
  return merged
}

/** The same limits as when a stopped queue is judged carriable (`SendQueueService.restartBlocker`), over all threads. */
function withinLimits(table: CarriedReservationTable): boolean {
  let bytes = 0
  let entries = 0
  for (const items of Object.values(table)) {
    for (const entry of items) {
      bytes += Buffer.byteLength(entry.input.text, 'utf8')
      entries += 1
    }
  }
  return bytes <= CARRIED_RESERVATIONS_MAX_BYTES && entries <= CARRIED_RESERVATIONS_MAX_ENTRIES
}

/**
 * Unread values are kept in order up to `CARRIED_RESERVATIONS_MAX_BYTES` of JSON in all, so a value that no build can read does not pile up; the rest is
 * dropped and only its size is logged (what is in it is not known).
 */
function withinUnreadLimit(values: readonly unknown[]): { readonly kept: unknown[]; readonly droppedBytes: number } {
  const kept: unknown[] = []
  let total = 0
  let droppedBytes = 0
  for (const value of values) {
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
    if (total + bytes > CARRIED_RESERVATIONS_MAX_BYTES) {
      droppedBytes += bytes
      continue
    }
    total += bytes
    kept.push(value)
  }
  return { kept, droppedBytes }
}

/**
 * Narrow the stored JSON to a table. Main wrote it, but it is read back from disk, so every field is checked (types, sizes, the same limits as when it was
 * written). null for anything else - nothing is restored partly from a value that does not read (the caller keeps such a value unread).
 */
export function parseCarriedReservations(value: unknown): CarriedReservationTable | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const table: Record<string, CarriedReservation[]> = {}
  let bytes = 0
  let entries = 0
  for (const [threadId, rawItems] of Object.entries(value)) {
    if (threadId === '' || threadId.length > MAX_ID || !Array.isArray(rawItems)) return null
    const items: CarriedReservation[] = []
    for (const raw of rawItems as unknown[]) {
      const item = parseItem(raw)
      if (item === null) return null
      bytes += Buffer.byteLength(item.input.text, 'utf8')
      entries += 1
      items.push(item)
    }
    table[threadId] = items
  }
  if (bytes > CARRIED_RESERVATIONS_MAX_BYTES || entries > CARRIED_RESERVATIONS_MAX_ENTRIES) return null
  return table
}

function parseItem(raw: unknown): CarriedReservation | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id, input, interrupt, createdAt, by } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID) return null
  if (typeof interrupt !== 'boolean' || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  if (by !== 'human' && by !== 'auto') return null
  const parsedInput = parseInput(input)
  if (parsedInput === null) return null
  return { id, input: parsedInput, interrupt, createdAt, by }
}

function parseInput(raw: unknown): CarriedInput | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const { text, modelId, thinking, settingsScope, shell } = record
  // A field this build does not know (a later build wrote it) cannot be carried silently: the whole value is not read (it is kept unread).
  for (const key of Object.keys(record)) {
    if (!['text', 'modelId', 'thinking', 'settingsScope', 'shell'].includes(key)) return null
  }
  if (typeof text !== 'string') return null
  if (modelId !== undefined && modelId !== null && (typeof modelId !== 'string' || modelId.length > MAX_ID)) return null
  if (thinking !== undefined && thinking !== null && !isThinkingLevel(thinking)) return null
  if (settingsScope !== undefined && settingsScope !== 'message' && settingsScope !== 'thread') return null
  if (shell !== undefined && shell !== true) return null
  return {
    text,
    ...(modelId === undefined ? {} : { modelId: modelId as string | null }),
    ...(thinking === undefined ? {} : { thinking: thinking as CarriedInput['thinking'] }),
    ...(settingsScope === undefined ? {} : { settingsScope: settingsScope as 'message' | 'thread' }),
    ...(shell === true ? { shell: true as const } : {})
  }
}
