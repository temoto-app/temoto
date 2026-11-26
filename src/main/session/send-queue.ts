/**
 * The send queue (item 94 / 4.5.4, TODO 578 (b)). The bodies of `SessionManager`'s `send` / `sendInterrupt`, and
 * the per-thread queue (reservations, interrupts, and the "mid-send" and "waiting for `result`" marks) were split out to here:
 * `submit` (send now or queue as a reservation), `drain` (send the first reservation), `dispatch` (raising and lowering
 * the marks around sending one item), and canceling / taking back a reservation.
 *
 * **What is not here** - `dispatchNow` (backend validation, `ensureLive`, recording the message, writing to
 * stdin) is deeply tied to the process lifetime (c) and event recording (d), so it stays in `SessionManager` and is called through the
 * closure `SendQueueHost.dispatchNow`. `requestInterrupt` / `interrupt` stay for the same reason.
 *
 * `SessionManager` does not pass `this`; it builds a thin bundle of closures of this shape and passes that
 * (the same as (e) (f) (g)). The places on the manager side that read and write the queue marks directly (receiving events,
 * stopping, deleting, etc.) go through `get` / `delete` / `clear` / `busyAny`.
 */
import { randomUUID } from 'node:crypto'
import type { ThinkingLevel } from '@shared/agent.js'
import { reasonError } from '@shared/reason.js'
import type { SendInput, SendOutcome, Thread } from '@shared/thread.js'
import { CARRIED_DRAFTS_MAX_BYTES, CARRIED_DRAFTS_MAX_ENTRIES } from '@shared/update.js'
import { errorFields, log } from '../../common/logger.js'
import type { ThreadStore } from './store.js'

/** One reservation (item 94). What is shown in the renderer is `Reservation` (only the start of the body). */
export interface QueuedSend {
  readonly id: string
  readonly input: SendInput
  /** Entered by an interrupt (Cmd+Enter). Placed before reservations, and waits for the current turn to be interrupted. */
  readonly interrupt: boolean
  readonly createdAt: number
  /**
   * TODO 1289 (code-review, wave 97 fix Y): who the turn this item starts counts as started by. Decided by main from the entry point the
   * item came in through (`SessionManager.send` / `sendInterrupt` with `human` only from the IPC handlers of the composer), never a value
   * the renderer declares. A person's reservation and Cmd+Enter interrupt stay `human` when `drain` sends them later.
   */
  readonly by: TurnStarter
}

/**
 * The per-thread send queue (item 94 / 4.5.4). **Inputs written to the backend's stdin whose
 * `result` has not come back are always 0 or 1** - if a `user` line is written during a reply, while a tool is running it is
 * mixed into that turn and `result` comes only once (spike 15, B). The earlier
 * `Live.queued` (number sent minus number of `result`) stayed at 1 in that case, and the
 * thread never returned from "running".
 *
 * It is kept separate from `Live` so that the queue and the "mid-send" mark survive while the process is woken again
 * after a settings change (`Live` is rebuilt). **Memory only** (does not survive a restart - owner decision). The one exception (TODO 1337): stopped
 * reservations are carried over an idle restart for an update (`CarriedReservationsService`, ARCHITECTURE 8.5); Cmd+Q and a crash still lose them.
 */
export interface SendQueue {
  /** Reservations. Sent from the front. Interrupts go to the front side. */
  readonly items: QueuedSend[]
  /** Mid-send (from validation to writing to stdin). A send that arrives during this becomes a reservation. */
  dispatching: boolean
  /** Waiting for the `result` of the input written to stdin. */
  awaitingResult: boolean
  /**
   * Do not send automatically. Set after the stop button, an abnormal exit, or a failed reservation send, and cleared the next time the user
   * sends (reserves). So that the next reservation does not start running right after a stop. **Changed only through `SendQueueService.setPaused`**
   * (wave 106 review Z3: the change is told to the copy carried over an idle restart).
   */
  paused: boolean
  /** aios sent an interrupt and has not yet received that turn's `result`. */
  interrupting: boolean
  /**
   * An interrupt arrived mid-send (not yet written to stdin). Once the write finishes, an interrupt is sent to that
   * turn. It is not decided by "is the first item an interrupt reservation" - when Cmd+Enter is pressed twice,
   * the second would interrupt the first interrupt right after it was sent.
   */
  interruptWhenWritten: boolean
  /**
   * A stop (the stop button / Esc in the prompt field, item 161) arrived mid-send (including while starting). There is no turn yet to
   * interrupt, so the stop is redone right after the write finishes. Without this mark, a stop during startup
   * does nothing and returns, and the turn then runs anyway ("stop can always be pressed" breaks).
   */
  stopWhenWritten: boolean
  /**
   * The input last written to the backend (TODO 893, "send again" after an expired login). `!` is not kept (an input
   * that is not sent to the backend). **Memory only** - not saved (constraints 9 / 10. A saved message has been through redaction and
   * is not "as is"). Does not survive a restart.
   */
  lastSent?: SendInput
  /**
   * TODO 1282: the turn of `lastSent` has started running a tool (a `tool_use` arrived, the parent's or a subagent's). Set by
   * the event recorder from main's own events (never from the renderer). Reset when a new `lastSent` is written. An automatic
   * resend after a re-login is not made for such a turn (its side effects could run twice); the user's "Send again" stays.
   */
  lastSentToolStarted?: boolean
  /** TODO 1282: a `result` has arrived since `lastSent` was written (so a later auth failure belongs to another turn). */
  lastSentSettled?: boolean
  /**
   * TODO 982 (wave 101 review fix Y): the current `dispatch` got as far as handing the input to the backend (`dispatchNow` sets it right
   * before the write to the process; `dispatch` clears it first). A drill's failed first send goes back to `ready` only when this is false
   * - nothing reached the backend. Set before the write is attempted, so a write that fails half-way counts as reached (closing side).
   */
  reachedBackend?: boolean
  /**
   * TODO 1289: who started the turn running now. **`human` only for the one turn a person started** - a message they sent, a
   * reservation or interrupt they queued (sent later by `drain`), or "Send again" they pressed - and only while that turn runs:
   * `endTurn` puts it back to `auto` at the turn's `result` or the process exit, a turn the backend starts by itself
   * (`beginTurn` from the event recorder) is `auto`, and a send that failed before writing restores the value from before it
   * (code-review, wave 97 fix Y). A bundle report, an automatic resend, "send later" and a resume are `auto`. Absent until the
   * first turn of this launch. Read by `SessionManager.isUnattendedTurnNow` (absent counts as `auto`).
   */
  turnBy?: TurnStarter
  /**
   * TODO 1289 (code-review, wave 97 fix Y): the approval deadline (epoch ms) of the unattended turn running now, fixed once per turn
   * (`beginTurn`, or the first approval of the turn) and cleared with `turnBy`. null = that turn has no deadline. Read through
   * `SessionManager`'s `approvalDeadline` for turns after a scheduled run's first one.
   */
  turnDeadline?: number | null
}

/**
 * TODO 1289 (code-review, wave 97 fix Y): the turn running in that queue ended (its `result`, or the process exited). Nobody is known
 * to be watching the next one until a person starts it.
 */
export function endTurn(queue: SendQueue): void {
  queue.turnBy = 'auto'
  delete queue.turnDeadline
}

/** TODO 1289: who started a turn (see `SendQueue.turnBy`). */
export type TurnStarter = 'human' | 'auto'

/** Whether there is a reservation or a mid-send (the condition that protects against the physical deletion of TODO 526). */
export function queueBusy(queue: SendQueue | undefined): boolean {
  return queue !== undefined && (queue.items.length > 0 || queue.dispatching || queue.awaitingResult)
}

/**
 * TODO 1337: the input of a reservation in the form carried over an idle restart for an update (ARCHITECTURE 8.5). Plain values only; every field of
 * `SendInput` is either here or makes the reservation not carriable (`carriedReservationOf`) - none is dropped silently.
 */
export interface CarriedInput {
  readonly text: string
  readonly modelId?: string | null
  readonly thinking?: ThinkingLevel | null
  readonly settingsScope?: 'message' | 'thread'
  readonly shell?: true
}

/** TODO 1337: one reservation carried over an idle restart. Every field of `QueuedSend` is here. */
export interface CarriedReservation {
  readonly id: string
  readonly input: CarriedInput
  readonly interrupt: boolean
  readonly createdAt: number
  readonly by: TurnStarter
}

/** TODO 1337: the carried reservations per thread id (only threads whose queue is stopped and has items). */
export type CarriedReservationTable = Readonly<Record<string, readonly CarriedReservation[]>>

/**
 * TODO 1337: limits on what is carried, the same numbers as the Composer drafts (`CARRIED_DRAFTS_MAX_BYTES` / `_ENTRIES`): the UTF-8 bytes of all
 * reservation texts and the number of reservations, over all threads. Over them nothing is carried and the restart keeps waiting.
 */
export const CARRIED_RESERVATIONS_MAX_BYTES = CARRIED_DRAFTS_MAX_BYTES
export const CARRIED_RESERVATIONS_MAX_ENTRIES = CARRIED_DRAFTS_MAX_ENTRIES

/**
 * TODO 1337: the carried form of one reservation, or why it cannot be carried. The table (also in ARCHITECTURE 8.5):
 *
 * | field | carried? |
 * |---|---|
 * | `id` / `interrupt` / `createdAt` / `by` | carried as they are |
 * | `input.text` / `modelId` / `thinking` / `settingsScope` / `shell` | carried as they are |
 * | `input.attachments` (images as base64, references) | **not carriable** when there is at least one (an empty list is the same as none) |
 * | `input.selection` (a copy of lines of a file, item 97) | **not carriable** (a copy of a file's body, checked against the path rules when it was queued) |
 * | a field this code does not know | **not carriable** (checked at run time as well as by the compiler) |
 */
export function carriedReservationOf(
  item: QueuedSend
): { readonly ok: true; readonly carried: CarriedReservation } | { readonly ok: false; readonly why: 'attachments' | 'selection' | 'unknown-field' } {
  const { id, input, interrupt, createdAt, by, ...itemRest } = item
  const { text, attachments, modelId, thinking, settingsScope, selection, shell, ...inputRest } = input
  // A new field on either type must be decided here (carried or not carriable): the compiler stops at these two lines until it is.
  const noOtherItemField: Record<string, never> = itemRest
  const noOtherInputField: Record<string, never> = inputRest
  if (Object.keys(noOtherItemField).length > 0 || Object.keys(noOtherInputField).length > 0) return { ok: false, why: 'unknown-field' }
  if (attachments !== undefined && attachments.length > 0) return { ok: false, why: 'attachments' }
  if (selection !== undefined) return { ok: false, why: 'selection' }
  const carriedInput: CarriedInput = {
    text,
    ...(modelId === undefined ? {} : { modelId }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(settingsScope === undefined ? {} : { settingsScope }),
    ...(shell === true ? { shell: true as const } : {})
  }
  return { ok: true, carried: { id, input: carriedInput, interrupt, createdAt, by } }
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** The entry point `SendQueueService` borrows from `SessionManager`. */
export interface SendQueueHost {
  readonly store: ThreadStore
  /** The agent is not run in a duplicate made for verification (item 186). */
  isAgentDisabled(): boolean
  /** Whether we are after shutdown (`stopped`). */
  isStopped(): boolean
  /**
   * Re-checks the received input: for `!`, the body is treated as a command (attachments etc. are dropped); otherwise the attached
   * selection (item 97) is checked. Synchronous, keeping the promise of no await between this and the `submit` decision.
   */
  prepareInput(received: SendInput): SendInput
  /** Sent by hand = the reservation to resume after release is not needed (TODO 628). */
  notifyThreadResumed(threadId: string): void
  /** Validates the settings (model / thinking). Throws for a model not in the list, etc. */
  checkSettings(thread: Thread, input: SendInput): Promise<void>
  /** The body that hands one item to the backend (validation, launch, recording, stdin). It stayed in `manager.ts`. */
  dispatchNow(threadId: string, input: SendInput, queue: SendQueue): Promise<void>
  /** Sends an interrupt to the current turn (item 94). */
  requestInterrupt(threadId: string): Promise<void>
  /**
   * TODO 1289 (code-review, wave 97 fix Y): the approval deadline of the turn that has just begun, if it is unattended (read after
   * `turnBy` is set). null = attended, or no deadline. Omitted means none.
   */
  unattendedTurnDeadline?(threadId: string): number | null
  /** Stop (item 161). */
  interrupt(threadId: string): Promise<void>
  /** Whether it is an exception that was already recorded in the timeline as a launch failure. */
  isRecordedError(err: unknown): boolean
  /** Leaves the failure of a reservation send in the timeline's `error` (`actor: 'main'`, `origin: 'internal'`). */
  recordInternalError(threadId: string, err: Error): void
  emitThread(threadId: string): void
  /**
   * TODO 1337: the reservations or the stopped mark of some queue changed (queued, sent, cancelled, taken back, put back, deleted, stopped). Lets a copy
   * carried over an idle restart follow memory. Omitted means nobody listens.
   */
  queueChanged?(): void
}

/** TODO 1337: why the reservations hold an idle restart. `queue` = a queue that moves by itself (or is mid-send); `queue-uncarriable` = a stopped queue that cannot be carried. */
export type ReservationRestartBlocker = 'queue' | 'queue-uncarriable'

export class SendQueueService {
  private readonly queues = new Map<string, SendQueue>()

  constructor(private readonly host: SendQueueHost) {}

  // ---- Entry points to the queue itself (used by the manager for receiving events, stopping, and deleting) ----

  get(threadId: string): SendQueue | undefined {
    return this.queues.get(threadId)
  }

  delete(threadId: string): void {
    const had = (this.queues.get(threadId)?.items.length ?? 0) > 0
    this.queues.delete(threadId)
    if (had) this.changed()
  }

  clear(): void {
    this.queues.clear()
  }

  /** Whether any thread has a reservation or a mid-send. */
  anyBusy(): boolean {
    for (const queue of this.queues.values()) if (queueBusy(queue)) return true
    return false
  }

  /** TODO 1337: tell the listener (`SendQueueHost.queueChanged`) that reservations or the stopped mark changed. */
  changed(): void {
    this.host.queueChanged?.()
  }

  /**
   * Wave 106 review Z3: **the only place that changes `paused`** (the stop button, a failed write, the process exit, sending). The stopped mark decides what
   * an idle restart carries, so a change is told to the listener (`changed`) like a change to the reservations; an assignment that keeps the value says
   * nothing. The listener (`SessionManager`) says nothing once shutdown has begun, so nothing is written after the DB closes, and it never comes back here.
   * Returns whether the mark changed (and so was told).
   */
  setPaused(queue: SendQueue, paused: boolean): boolean {
    if (queue.paused === paused) return false
    queue.paused = paused
    this.changed()
    return true
  }

  // ---- TODO 1337: carrying stopped reservations over an idle restart for an update (ARCHITECTURE 8.5) ----

  /**
   * What the reservations mean for an idle restart. null = nothing is lost by a restart: no queue is mid-send or waiting for `result`, every queue with
   * items is stopped (`paused`), and all of them can be carried (`carriedReservationOf`, within the limits). A queue that moves by itself
   * (`queue`) and a stopped queue that cannot be carried (`queue-uncarriable`) still hold the restart - **they are never dropped after a while**.
   */
  restartBlocker(): ReservationRestartBlocker | null {
    let uncarriable = false
    let bytes = 0
    let entries = 0
    for (const queue of this.queues.values()) {
      if (queue.dispatching || queue.awaitingResult) return 'queue'
      if (queue.items.length === 0) continue
      if (!queue.paused) return 'queue'
      for (const item of queue.items) {
        const carried = carriedReservationOf(item)
        if (!carried.ok) uncarriable = true
        bytes += utf8Bytes(item.input.text)
        entries += 1
      }
    }
    if (uncarriable || bytes > CARRIED_RESERVATIONS_MAX_BYTES || entries > CARRIED_RESERVATIONS_MAX_ENTRIES) return 'queue-uncarriable'
    return null
  }

  /** The stopped reservations in their carried form, or null when `restartBlocker()` is not null (nothing is carried partly). */
  carriedSnapshot(): CarriedReservationTable | null {
    if (this.restartBlocker() !== null) return null
    return this.carriableNow()
  }

  /**
   * The carriable reservations of the stopped queues, ignoring the rest (a queue that moves, an item that cannot be carried). Only for following memory after
   * the restart was already decided (`CarriedReservationsService.follow`): the restart is not decided on this.
   */
  carriableNow(): CarriedReservationTable {
    const table: Record<string, CarriedReservation[]> = {}
    for (const [threadId, queue] of this.queues) {
      if (!queue.paused || queue.items.length === 0) continue
      const carried: CarriedReservation[] = []
      for (const item of queue.items) {
        const one = carriedReservationOf(item)
        if (one.ok) carried.push(one.carried)
      }
      if (carried.length > 0) table[threadId] = carried
    }
    return table
  }

  /**
   * Put carried reservations back into a thread's queue (the next launch). **The queue is always left stopped** (`paused`), so nothing is sent until the user
   * sends again - `drain` is not called. Idempotent: a reservation whose id is already in the queue is skipped, so restoring twice never shows the same text
   * twice. Each input goes through the same check as a received one (`prepareInput`); one that fails it is not restored. Returns the counts.
   */
  restoreCarried(threadId: string, items: readonly CarriedReservation[]): { readonly restored: number; readonly invalid: number } {
    const queue = this.of(threadId)
    const present = new Set(queue.items.map((item) => item.id))
    let restored = 0
    let invalid = 0
    for (const carried of items) {
      if (present.has(carried.id)) continue
      let input: SendInput
      try {
        input = this.host.prepareInput(carried.input)
      } catch {
        invalid += 1
        continue
      }
      queue.items.push({ id: carried.id, input, interrupt: carried.interrupt, createdAt: carried.createdAt, by: carried.by })
      present.add(carried.id)
      restored += 1
    }
    if (restored > 0) {
      log.info('session.reservation.restored', { threadId, restored, queued: queue.items.length })
      this.host.emitThread(threadId)
      // The items changed either way: one notice, from `setPaused` when the mark changes too.
      if (!this.setPaused(queue, true)) this.changed()
    }
    return { restored, invalid }
  }

  of(threadId: string): SendQueue {
    let queue = this.queues.get(threadId)
    if (queue === undefined) {
      queue = {
        items: [],
        dispatching: false,
        awaitingResult: false,
        paused: false,
        interrupting: false,
        interruptWhenWritten: false,
        stopWhenWritten: false
      }
      this.queues.set(threadId, queue)
    }
    return queue
  }

  // ---- Sending (reservations and interrupts - item 94 / 4.5.4) ----

  /** Cancels a reservation (the chip's X). Returns false if not found (already sent, etc.). */
  cancelReservation(threadId: string, reservationId: string): boolean {
    return this.takeReservation(threadId, reservationId) !== null
  }

  /**
   * Removes a reservation from the queue and returns its contents (the chip's pencil - put it back in the input field to edit). Includes the
   * contents of attachments. null if not found.
   */
  takeReservation(threadId: string, reservationId: string): SendInput | null {
    const queue = this.queues.get(threadId)
    if (queue === undefined) return null
    const at = queue.items.findIndex((item) => item.id === reservationId)
    if (at === -1) return null
    const [item] = queue.items.splice(at, 1)
    log.info('session.reservation.removed', { threadId, left: queue.items.length })
    this.host.emitThread(threadId)
    this.changed()
    return item?.input ?? null
  }

  /**
   * Sends the last sent input again (TODO 893). It goes through the same path as a normal send (`submit`), so during a reply, awaiting approval, or
   * mid-send it is queued as a reservation and sent after the turn ends (two items are not written to stdin - item 94).
   * `resend-unavailable` if nothing has been sent yet in this launch.
   * `by` (TODO 1289): `human` only for the button a person pressed (the IPC handler); the automatic resend after a re-login is `auto`.
   */
  async resendLast(threadId: string, by: TurnStarter = 'auto'): Promise<SendOutcome> {
    const last = this.queues.get(threadId)?.lastSent
    if (last === undefined) throw reasonError('resend-unavailable')
    log.info('session.resend', { threadId, by })
    return this.submit(threadId, last, false, by)
  }

  /**
   * TODO 1282: whether the last input may be resent automatically after a re-login, judged from main's own record of the turn.
   * null = it may (an input is kept, its turn has not ended with another `result`, and no tool had started). Called when the
   * auth-failed `result` is being recorded, before that `result` settles the turn.
   */
  autoResendHold(threadId: string): 'tool-started' | 'unavailable' | null {
    const queue = this.queues.get(threadId)
    if (queue?.lastSent === undefined || queue.lastSentSettled === true) return 'unavailable'
    return queue.lastSentToolStarted === true ? 'tool-started' : null
  }

  /**
   * `by` (TODO 1289) is who the turn counts as started by. A reservation keeps it and `drain` sends it with the same value
   * (owner decision 2026-11-21: what a person typed is attended, also when it goes out after the running turn).
   */
  async submit(threadId: string, received: SendInput, interrupt: boolean, by: TurnStarter = 'auto'): Promise<SendOutcome> {
    const thread = this.host.store.getThread(threadId)
    if (thread === null) throw new Error('thread not found')
    // Item 186: nothing is sent in a duplicate made for verification (and not queued either - if queued, `drain` would send it later).
    if (this.host.isAgentDisabled()) {
      log.warn('session.send.refused', { threadId, reason: 'agent-disabled', shell: received.shell === true })
      throw reasonError('agent-disabled')
    }
    // The attached selection (item 97) is checked before queueing (choke point, lines, length). It is synchronous, so the promise of no
    // await between this and the decision below holds. For `!` (item 116) the body is re-checked as a command, and
    // attachments, selection, and model / thinking settings are dropped (an input that is not sent to the backend).
    const input = this.host.prepareInput(received)
    const queue = this.of(threadId)
    // **No await between the decision and the "mid-send" mark** (it is set synchronously at the start of `dispatch`).
    // If there were one, two sends in a row would both see "not replying" and write two lines.
    const direct = !queue.dispatching && !queue.awaitingResult && queue.items.length === 0
    // TODO 982: a drill runs once. Every way of sending reaches this point (a person's send / interrupt, "send again", the automatic resend
    // after a re-login, a resume, `!`), so this one check closes them all: only the first message, sent on the spot, goes; it marks the
    // drill `ran` before anything is written (no await in between), so a second send while this one is on its way is refused. The
    // gateway's stop does not depend on this - it reads the mark itself (any drill state stops).
    const drill = thread.drill !== undefined
    if (drill) {
      if (thread.drill === 'ran' || input.shell === true || !direct || this.host.store.drillStateOf(threadId) !== 'ready') {
        log.warn('session.send.refused', { threadId, reason: 'drill-locked', shell: input.shell === true })
        throw reasonError('drill-locked')
      }
      this.host.store.markDrillRan(threadId)
    }
    // Item 186: the only entry point for sending is IPC (the renderer's Composer), so one line is left here. Before,
    // the send-now path had no log, and `agent.spawn` right after launch could not trace "who sent it".
    // The body is not logged (chapter 7 convention) - only the length and kind.
    log.info('session.send', {
      threadId,
      direct,
      interrupt,
      shell: input.shell === true,
      chars: input.text.length,
      attachments: input.attachments?.length ?? 0,
      selection: input.selection !== undefined
    })
    // TODO 628 (code-review): sent by hand / resumed = the reservation to resume after release is not needed. Called before the `await` (synchronously).
    if (input.shell !== true) this.host.notifyThreadResumed(threadId)
    if (direct) {
      this.setPaused(queue, false)
      try {
        await this.dispatch(threadId, input, by)
      } catch (err) {
        // Reservations queued while sending are not sent automatically after this failure (so it does not
        // repeat failing for the same reason). It starts moving when the user next sends.
        this.setPaused(queue, true)
        // TODO 982 (wave 101 review fix Y): a drill whose one send failed before anything reached the backend (settings check, login,
        // launch, the sandbox) was not used up: back to `ready` so the person can send it again. If the write was even attempted it stays
        // `ran` (unknown = used). No second send could slip in meanwhile: it saw `ran` and was refused, and nothing was queued.
        if (drill && queue.reachedBackend !== true && !this.host.isStopped() && this.queues.get(threadId) === queue) {
          this.host.store.markDrillUnsent(threadId)
          log.info('session.drill.unsent', { threadId })
          this.host.emitThread(threadId)
        }
        throw err
      }
      return { kind: 'sent' }
    }
    // Reservation. A model not in the list, etc. is refused before queueing (not carried over to the time of sending).
    if (input.shell !== true) await this.host.checkSettings(thread, input)
    const item: QueuedSend = { id: randomUUID(), input, interrupt, createdAt: Date.now(), by }
    if (interrupt) {
      // An interrupt goes before reservations, and after interrupts that came earlier.
      const at = queue.items.findIndex((queued) => !queued.interrupt)
      queue.items.splice(at === -1 ? queue.items.length : at, 0, item)
    } else {
      queue.items.push(item)
    }
    // The user sent = the stopped queue may move again. The items changed either way: one notice.
    const unpaused = this.setPaused(queue, false)
    log.info('session.reserved', { threadId, interrupt, queued: queue.items.length })
    this.host.emitThread(threadId)
    if (!unpaused) this.changed()
    if (interrupt) {
      if (queue.dispatching) queue.interruptWhenWritten = true
      else void this.host.requestInterrupt(threadId)
    }
    void this.drain(threadId)
    return { kind: 'queued', reservationId: item.id }
  }

  /**
   * Sends the first item of the queue (item 94). Does nothing while mid-send, waiting for `result`, or stopped.
   * A failed reservation is not discarded but returned to the front and the queue is stopped - it stays as a chip, so it can be handled with the pencil / X.
   */
  async drain(threadId: string): Promise<void> {
    if (this.host.isStopped()) return
    const queue = this.queues.get(threadId)
    if (queue === undefined || queue.dispatching || queue.awaitingResult || queue.paused) return
    const next = queue.items.shift()
    if (next === undefined) return
    this.changed()
    log.info('session.reservation.dispatch', { threadId, interrupt: next.interrupt, left: queue.items.length })
    try {
      await this.dispatch(threadId, next.input, next.by)
    } catch (err) {
      log.warn('session.reservation.failed', { threadId, ...errorFields(err) })
      // Do not put it back for a deleted thread or after shutdown (the queue is gone along with it).
      if (this.host.isStopped() || this.queues.get(threadId) !== queue) return
      queue.items.unshift(next)
      // The item came back either way: one notice, from `setPaused` when the mark changes too.
      const stopped = this.setPaused(queue, true)
      // A launch failure was already recorded by `startLive`. Anything else (settings validation, etc.) is recorded here.
      if (!this.host.isRecordedError(err)) this.host.recordInternalError(threadId, err as Error)
      this.host.emitThread(threadId)
      if (!stopped) this.changed()
    }
  }

  /**
   * Hands one item to the backend (the body of `send` from before item 94). Only `submit` (send now) and
   * `drain` (send a reservation) call it, and both keep "one item per turn" through the queue marks.
   */
  async dispatch(threadId: string, input: SendInput, by: TurnStarter): Promise<void> {
    const queue = this.of(threadId)
    queue.dispatching = true
    // TODO 1289: marked before the write, so no tool call of this turn can be judged against the previous turn's starter.
    // `!` starts no backend turn and leaves the mark as it was.
    const before = { turnBy: queue.turnBy, turnDeadline: queue.turnDeadline }
    queue.reachedBackend = false
    if (input.shell !== true) this.beginTurn(threadId, by)
    let written = false
    try {
      await this.host.dispatchNow(threadId, input, queue)
      written = true
      if (input.shell !== true) {
        queue.lastSent = input
        queue.lastSentToolStarted = false
        queue.lastSentSettled = false
      }
    } finally {
      queue.dispatching = false
      // If the write failed (throw) there is no turn to interrupt, so discard the marks along with it.
      if (!written) {
        queue.interruptWhenWritten = false
        queue.stopWhenWritten = false
        // TODO 1289 (code-review, wave 97 fix Y): no turn started, so the starter goes back to what it was (a failed `human` send
        // must not leave the next turn the backend starts by itself marked as attended).
        if (input.shell !== true) restoreTurn(queue, before)
      }
    }
    // If a stop arrived while sending (item 161), stop the turn that has just been written. Checked before
    // interrupts - a stop does not send the interrupt's input either (`interrupt` clears `interrupting`).
    if (queue.stopWhenWritten) {
      queue.stopWhenWritten = false
      queue.interruptWhenWritten = false
      void this.host.interrupt(threadId)
      return
    }
    // If an interrupt arrived while sending, send an interrupt to the turn that has just been written.
    if (queue.interruptWhenWritten) {
      queue.interruptWhenWritten = false
      void this.host.requestInterrupt(threadId)
    }
    // `!` (item 116) does not start a backend turn, so no `result` comes. Reservations queued while it was
    // running are flushed here (for an ordinary message, `result` flushes them).
    if (input.shell === true) void this.drain(threadId)
  }

  /**
   * TODO 1289 (code-review, wave 97 fix Y): a turn begins - one aios writes (`dispatch`) or one the backend starts by itself (the event
   * recorder, always `auto`). Sets who started it and fixes its unattended approval deadline once, at the start (TODO 959: looking up
   * "the next scheduled time" again later would give a turn that outlived a skip a whole extra period).
   */
  beginTurn(threadId: string, by: TurnStarter): void {
    const queue = this.of(threadId)
    queue.turnBy = by
    delete queue.turnDeadline
    // Read after `turnBy` is set: whether the turn is unattended depends on who started it.
    if (this.host.unattendedTurnDeadline !== undefined) queue.turnDeadline = this.host.unattendedTurnDeadline(threadId)
  }
}

function restoreTurn(queue: SendQueue, before: Pick<SendQueue, 'turnBy' | 'turnDeadline'>): void {
  if (before.turnBy === undefined) delete queue.turnBy
  else queue.turnBy = before.turnBy
  if (before.turnDeadline === undefined) delete queue.turnDeadline
  else queue.turnDeadline = before.turnDeadline
}
