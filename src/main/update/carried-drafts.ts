/**
 * TODO 1333: carry unsaved drafts over an idle restart for an update (ARCHITECTURE 8.5).
 *
 * Before 1333 a Composer draft (TODO 526), held only in a renderer's memory, stopped the idle restart for good, so an
 * installed version could wait for days. Now the idle restart carries it (**only the Composer text**; the viewer's unsaved drafts, item 97 / TODO 312, are not
 * carried and still hold the restart - owner decision 2026-11-26):
 *
 * 1. **Collect** (right before the restart): every window is asked for its drafts (`updateCollectDrafts`) and answers with `updateSubmitDrafts`. Each reply is checked
 *    against what main was told (`reportComposerDrafts` / `reportDraft`), so a draft the reply does not contain is never dropped silently.
 * 2. **Keep** them in the encrypted DB (`app_settings` key `update.carriedDrafts`) - never a plain file, never the log (only counts are logged).
 * 3. **Hand back** (next launch), **once**: the first window that asks (`take`) gets everything and the stored copy is deleted; no other window is given a copy
 *    (a second copy would come back as a draft of an already sent message). Main cannot tell which window showed which thread, so text typed in another window
 *    comes back in the first window - a known limit. The threads stay protected from the abandoned-thread purge for a short while (`HOLD_AFTER_TAKE_MS`), until
 *    the window has reported its own drafts.
 *
 * **A draft that cannot be carried keeps the restart waiting** (`carryBeforeRestart` returns false): attachments, over the size limits, a window that did not answer
 * in time, a reply that does not match what main was told. Losing text is worse than waiting. Only the idle restart uses this; "Restart to Update" (which settles the
 * viewer drafts through the 606 sheet) and the swap at quit are unchanged.
 *
 * Independent of electron (the windows are passed in as `CarriedDraftsTarget`s).
 */
import { randomUUID } from 'node:crypto'
import { log } from '../../common/logger.js'
import { UPDATE_CARRIED_DRAFTS, type SettingKey } from '../../common/settings-keys.js'
import {
  carriedDraftsEmpty,
  mergeCarriedDrafts,
  parseCarriedDrafts,
  type CarriedDrafts,
  type CarriedDraftsRequest
} from '@shared/update.js'

/** How long the windows get to answer a collect request. */
export const COLLECT_TIMEOUT_MS = 3_000
/** After the drafts were handed to a window, how long their threads stay protected from the abandoned-thread purge (the window reports its own drafts within seconds). */
export const HOLD_AFTER_TAKE_MS = 60_000

export interface CarriedDraftsSettings {
  readTyped<T>(def: SettingKey<T>): T
  writeTyped<T>(def: SettingKey<T>, value: T): void
}

/** One window as seen from here. */
export interface CarriedDraftsTarget {
  /** `webContents.id`. */
  readonly id: number
  send(request: CarriedDraftsRequest): void
}

export interface CarriedDraftsDeps {
  readonly settings: CarriedDraftsSettings
  readonly targets: () => readonly CarriedDraftsTarget[]
  /** Whether any window has a Composer draft (main's registry). */
  readonly hasDrafts: () => boolean
  /** What main was told about window `viewId` (see `SessionManager.draftsOfView`). */
  readonly inspect: (viewId: number) => { readonly composerThreads: ReadonlySet<string> }
  /** Protect the threads of the carried drafts from the abandoned-thread purge. Returns the release function. */
  readonly holdThreads: (threadIds: readonly string[]) => () => void
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly newId?: () => string
}

interface Pending {
  readonly id: string
  readonly waiting: Set<number>
  readonly replies: Map<number, unknown>
  readonly done: () => void
}

export class CarriedDraftsService {
  private readonly now: () => number
  private pending: Pending | null = null
  private collecting = false
  /** Read at launch from the stored copy; stays (and the stored copy stays in the DB) until the first window takes it, however long that is. */
  private waitingForTake: CarriedDrafts | null = null
  private release: (() => void) | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly deps: CarriedDraftsDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * At launch: look at what the previous run stored. A readable one is held (its threads protected from the purge) until the first window takes it - **it is
   * never dropped for being old or unclaimed**; only a value that cannot be read is removed.
   */
  start(): void {
    const stored = this.deps.settings.readTyped(UPDATE_CARRIED_DRAFTS)
    if (stored === null) return
    const drafts = parseCarriedDrafts(stored.drafts)
    if (drafts === null || carriedDraftsEmpty(drafts)) {
      this.deps.settings.writeTyped(UPDATE_CARRIED_DRAFTS, null)
      log.info('update.drafts.dropped', {})
      return
    }
    this.waitingForTake = drafts
    this.release = this.deps.holdThreads(Object.keys(drafts.composer))
  }

  /** Shutdown: no timer, no write afterwards (12.9). The stored copy stays in the DB if nobody took it. */
  stop(): void {
    this.stopped = true
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    this.release?.()
    this.release = null
  }

  /**
   * A window asks for the drafts of the previous run. **Only the first call gets them**: the stored copy is deleted and nothing is kept for other windows. If the
   * stored copy cannot be deleted it is handed over anyway and comes back once more at the next launch (never lost). The protection of the threads is released
   * `HOLD_AFTER_TAKE_MS` later, by which time the window has reported its own drafts.
   */
  take(): CarriedDrafts | null {
    const drafts = this.waitingForTake
    if (drafts === null || this.stopped) return null
    this.waitingForTake = null
    try {
      this.deps.settings.writeTyped(UPDATE_CARRIED_DRAFTS, null)
    } catch {
      // Handed over anyway; the stored copy stays and is offered again at the next launch.
    }
    this.expiryTimer = setTimeout(() => this.expire(), HOLD_AFTER_TAKE_MS)
    this.expiryTimer.unref?.()
    log.info('update.drafts.restored', { composer: Object.keys(drafts.composer).length })
    return drafts
  }

  /** Release the protection of the threads (the copy itself was handed over by `take`). */
  private expire(): void {
    this.release?.()
    this.release = null
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
  }

  /** The restart was called off after `carryBeforeRestart` stored the drafts: remove them so they are not restored over newer text on a later launch. */
  discard(): void {
    if (this.stopped) return
    try {
      this.deps.settings.writeTyped(UPDATE_CARRIED_DRAFTS, null)
    } catch {
      // Left in place: it would come back at the next launch (it never overwrites what a window holds).
    }
  }

  /** A window's answer to a collect request (from IPC; `reply` is untrusted). */
  submit(viewId: number, requestId: unknown, reply: unknown): void {
    const pending = this.pending
    if (pending === null || requestId !== pending.id || !pending.waiting.has(viewId)) return
    pending.waiting.delete(viewId)
    pending.replies.set(viewId, reply)
    if (pending.waiting.size === 0) pending.done()
  }

  /**
   * Collect the drafts of all windows and store them. true = it is safe to restart (nothing to carry, or everything is stored); false = something cannot be
   * carried, so the restart must wait. Never throws.
   */
  async carryBeforeRestart(): Promise<boolean> {
    if (this.stopped || this.collecting) return false
    if (!this.deps.hasDrafts()) return true
    this.collecting = true
    try {
      return await this.collect()
    } catch {
      return false
    } finally {
      this.collecting = false
      this.pending = null
    }
  }

  private async collect(): Promise<boolean> {
    const targets = this.deps.targets()
    if (targets.length === 0) return false
    const id = (this.deps.newId ?? randomUUID)()
    let finish: () => void = () => undefined
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending: Pending = { id, waiting: new Set(targets.map((target) => target.id)), replies: new Map(), done: finish }
    this.pending = pending
    for (const target of targets) {
      try {
        target.send({ id })
      } catch {
        return false
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.deps.timeoutMs ?? COLLECT_TIMEOUT_MS)
      timer.unref?.()
    })
    await Promise.race([finished, timeout])
    if (timer !== null) clearTimeout(timer)
    if (pending.waiting.size > 0) {
      log.info('update.drafts.blocked', { why: 'no-reply' })
      return false
    }
    const parts: CarriedDrafts[] = []
    for (const target of targets) {
      const part = this.checkReply(target.id, pending.replies.get(target.id))
      if (part === null) return false
      parts.push(part)
    }
    // Two windows holding different text for the same thread: one would be dropped, so nothing is carried (equal text is merged).
    const seen = new Map<string, string>()
    for (const part of parts) {
      for (const [threadId, text] of Object.entries(part.composer)) {
        const other = seen.get(threadId)
        if (other !== undefined && other !== text) {
          log.info('update.drafts.blocked', { why: 'thread-conflict' })
          return false
        }
        seen.set(threadId, text)
      }
    }
    const merged = parseCarriedDrafts(mergeCarriedDrafts(parts))
    if (merged === null) {
      log.info('update.drafts.blocked', { why: 'limits' })
      return false
    }
    if (carriedDraftsEmpty(merged)) return true
    if (this.stopped) return false
    this.deps.settings.writeTyped(UPDATE_CARRIED_DRAFTS, { savedAt: this.now(), drafts: merged })
    log.info('update.drafts.carried', { composer: Object.keys(merged.composer).length })
    return true
  }

  /** One window's reply, or null when it cannot be carried (the reason is logged without any content). */
  private checkReply(viewId: number, reply: unknown): CarriedDrafts | null {
    if (typeof reply !== 'object' || reply === null || (reply as { carriable?: unknown }).carriable !== true) {
      log.info('update.drafts.blocked', { why: 'not-carriable' })
      return null
    }
    const drafts = parseCarriedDrafts((reply as { drafts?: unknown }).drafts)
    if (drafts === null) {
      log.info('update.drafts.blocked', { why: 'invalid' })
      return null
    }
    const known = this.deps.inspect(viewId)
    // Every thread main knows to hold a draft (or an attachment, which is never carried) must be in the reply as text.
    for (const threadId of known.composerThreads) {
      if (!(threadId in drafts.composer)) {
        log.info('update.drafts.blocked', { why: 'composer-mismatch' })
        return null
      }
    }
    return drafts
  }
}
