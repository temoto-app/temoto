/**
 * Unsaved viewer drafts at quit and window close (TODO 606, wave 29 bundle B, ARCHITECTURE 5.2.2). Only the decisions and round trips
 * that do not depend on electron are here; `src/main/index.ts` calls them from the window's `close` / `before-quit` / "restart and update"
 * (tests are in `test/viewer-drafts-close.test.ts`). Before a window reload (the menu's "Reload" / "Force Reload") the same settling
 * runs (TODO 636, `reloadWithDrafts`).
 *
 * **Owner decision (2026-10-10):** if auto-save is ON (`afterDelay` / `onFocusChange`), write everything out silently. If OFF, as in VS Code,
 * ask "Save?" (Save / Don't Save / Cancel) — an exception to the no-dialogs policy (TODO 167).
 *
 * Defaults decided on our own (bundle B):
 *   - **Drafts that could not be written (a conflict because the disk side changed, or an unwritable file) are not silently discarded.** Whether ON, or OFF and
 *     the user chose "Save", if anything remains, show "could not save" (close without saving / cancel). A conflict is not
 *     overwritten (the judgment of the band's "overwrite and save" is not made on the user's behalf at close time).
 *   - If the renderer does not reply (frozen, crashed, or past `VIEWER_DRAFTS_TIMEOUT_MS`), close — it is worse if a window cannot close or
 *     the app cannot quit. One line is left in the log. **But for a window that "received" `save`, wait for the write to finish up to
 *     `VIEWER_DRAFTS_SAVE_TIMEOUT_MS`, and if that passes route it to "could not save"** (code-review of TODO 606 —
 *     do not silently discard drafts that are mid-write or not yet written).
 *   - Whether there are drafts is known to main from the count notification (`DraftConflictTracker`). Windows with none are not queried (they close as fast as
 *     before).
 */
import { log } from '../common/logger.js'
import type { AutoSaveMode } from '@shared/auto-save.js'
import type { NativeKey } from './i18n-native.js'
import {
  sanitizeViewerDraftsAck,
  sanitizeViewerDraftsReply,
  type ViewerDraftEntry,
  type ViewerDraftsAction,
  type ViewerDraftsReply,
  type ViewerDraftsRequest
} from '@shared/viewer-drafts-close.js'

/**
 * Upper bound (ms) on waiting for the renderer's reply (for `save`, the "received"). Writes are small text, so normally tens of ms.
 * A window that sends nothing past this is treated as "not responding" and falls to the closing side.
 */
export const VIEWER_DRAFTS_TIMEOUT_MS = 10_000
/**
 * TODO 606 (code-review): upper bound (ms, from the time of the request) on waiting for a window that received `save` to finish writing. Closing silently
 * after it was received would discard drafts that are mid-write or not yet written, so it waits long, and after that routes the drafts that were queued at receipt to
 * "could not save". Shorter than `shutdownWithin` (30 seconds, 566) — so it fits inside the limit of the shutdown.
 */
export const VIEWER_DRAFTS_SAVE_TIMEOUT_MS = 25_000

export type SaveChoice = 'save' | 'discard' | 'cancel'
export type UnsavedChoice = 'discard' | 'cancel'
export type CloseVerdict = 'proceed' | 'cancel'

export interface ViewerDraftsCloseDeps {
  /** The current auto-save mode (`AutoSavePreference`). */
  readonly mode: () => AutoSaveMode
  /** Whether the renderer has reported unsaved drafts in window `viewId`. */
  readonly hasDrafts: (viewId: number) => boolean
  /** Ask the window's renderer. Null if there is no reply (timeout or no window). */
  readonly ask: (viewId: number, action: ViewerDraftsAction) => Promise<ViewerDraftsReply | null>
  /** "Save?" when auto-save is OFF. */
  readonly confirmSave: (viewId: number, entries: readonly ViewerDraftEntry[]) => Promise<SaveChoice>
  /** "Could not save" when drafts remain unwritten. */
  readonly confirmUnsaved: (viewId: number, entries: readonly ViewerDraftEntry[]) => Promise<UnsavedChoice>
}

/** Write everything out, and ask if anything remains. */
async function saveAll(viewId: number, deps: ViewerDraftsCloseDeps): Promise<CloseVerdict> {
  // If the limit passes after it was received, `ask` returns the drafts queued at receipt as "remaining" (`ViewerDraftsRequests`).
  const report = await deps.ask(viewId, 'save')
  if (report === null) {
    log.warn('viewer.drafts.close.no-reply', { viewId, action: 'save' })
    return 'proceed'
  }
  if (report.unsaved.length === 0) {
    log.info('viewer.drafts.close.saved', { viewId })
    return 'proceed'
  }
  const conflicts = report.unsaved.filter((entry) => entry.conflict).length
  log.info('viewer.drafts.close.unsaved', { viewId, count: report.unsaved.length, conflicts })
  const choice = await deps.confirmUnsaved(viewId, report.unsaved)
  log.info('viewer.drafts.close.choice', { viewId, dialog: 'unsaved', choice })
  return choice === 'discard' ? 'proceed' : 'cancel'
}

/**
 * Whether window `viewId` may be closed (write everything out or ask if needed). If `proceed`, it may close. If `cancel`, it does not close
 * (the drafts stay in the renderer's table).
 */
export async function settleViewerDrafts(viewId: number, deps: ViewerDraftsCloseDeps): Promise<CloseVerdict> {
  if (!deps.hasDrafts(viewId)) return 'proceed'
  const mode = deps.mode()
  if (mode !== 'off') return saveAll(viewId, deps)
  const listed = await deps.ask(viewId, 'list')
  if (listed === null) {
    log.warn('viewer.drafts.close.no-reply', { viewId, action: 'list' })
    return 'proceed'
  }
  if (listed.unsaved.length === 0) return 'proceed'
  const choice = await deps.confirmSave(viewId, listed.unsaved)
  log.info('viewer.drafts.close.choice', { viewId, dialog: 'save', choice, count: listed.unsaved.length })
  if (choice === 'cancel') return 'cancel'
  if (choice === 'discard') return 'proceed'
  return saveAll(viewId, deps)
}

/**
 * Before quit (Cmd+Q, "restart and update", the OS quitting when the last window closes), settle the windows one at a time. If any returns `cancel`, quit is
 * called off (what was written in earlier windows stays written — same as VS Code).
 */
export async function settleAllViewerDrafts(
  viewIds: readonly number[],
  deps: ViewerDraftsCloseDeps
): Promise<CloseVerdict> {
  for (const viewId of viewIds) {
    if ((await settleViewerDrafts(viewId, deps)) === 'cancel') return 'cancel'
  }
  return 'proceed'
}

/** The thing being asked (only the part of electron's `WebContents` that is needed). */
export interface DraftsRequestTarget {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, request: ViewerDraftsRequest): void
}

/**
 * Matching of main -> renderer requests with their replies. Only replies from the one it was sent to (`webContents.id`) are accepted.
 */
export class ViewerDraftsRequests {
  private seq = 0
  private readonly pending = new Map<
    number,
    {
      readonly target: number
      readonly resolve: (reply: ViewerDraftsReply | null) => void
      /** "Received" arrived (code-review of TODO 606). Switch the wait limit to the longer one for finishing the write. */
      readonly acked: (pendingDrafts: ViewerDraftsReply) => void
    }
  >()

  constructor(
    private readonly channel: string,
    private readonly timeoutMs: number = VIEWER_DRAFTS_TIMEOUT_MS,
    private readonly saveTimeoutMs: number = VIEWER_DRAFTS_SAVE_TIMEOUT_MS
  ) {}

  /**
   * Ask and wait for the reply. If nothing comes, null at `timeoutMs` (a window that does not respond). If "received" arrives, wait for the reply up to
   * `saveTimeoutMs` from the time of the request, and if it still does not come, return the drafts queued at receipt as "remaining, unwritten".
   */
  request(target: DraftsRequestTarget | null, action: ViewerDraftsAction): Promise<ViewerDraftsReply | null> {
    if (target === null || target.isDestroyed()) return Promise.resolve(null)
    this.seq += 1
    const id = this.seq
    const startedAt = Date.now()
    return new Promise((resolve) => {
      let timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve(null)
      }, this.timeoutMs)
      this.pending.set(id, {
        target: target.id,
        resolve: (reply) => {
          clearTimeout(timer)
          resolve(reply)
        },
        acked: (pendingDrafts) => {
          clearTimeout(timer)
          const left = Math.max(0, startedAt + this.saveTimeoutMs - Date.now())
          timer = setTimeout(() => {
            if (!this.pending.delete(id)) return
            log.warn('viewer.drafts.close.save-timeout', {
              viewId: target.id,
              action,
              pending: pendingDrafts.unsaved.length
            })
            resolve({ unsaved: pendingDrafts.unsaved })
          }, left)
        }
      })
      try {
        target.send(this.channel, { id, action })
      } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        resolve(null)
      }
    })
  }

  /** The renderer's "received" (`save`). An unknown number, a window other than the one it was sent to, and a malformed value are dropped. */
  ack(senderId: number, id: unknown, value: unknown): void {
    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (entry === undefined || entry.target !== senderId) return
    const pendingDrafts = sanitizeViewerDraftsAck(value)
    if (pendingDrafts === null) return
    entry.acked(pendingDrafts)
  }

  /** The renderer's reply. A reply with an unknown number or from a window other than the one it was sent to is dropped. */
  reply(senderId: number, id: unknown, value: unknown): void {
    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (entry === undefined || entry.target !== senderId) return
    this.pending.delete(id)
    entry.resolve(sanitizeViewerDraftsReply(value))
  }

  /** The window closed or reloaded: no reply will come for requests to that window, so finish them with null. */
  forget(targetId: number): void {
    for (const [id, entry] of this.pending) {
      if (entry.target !== targetId) continue
      this.pending.delete(id)
      entry.resolve(null)
    }
  }
}

/**
 * TODO 636 (wave 30 bundle D, ARCHITECTURE 5.2.3): the purpose of the settling. Closing a window or quitting is `close`; reloading a window is `reload`.
 * The decision (`settleViewerDrafts`) is the same, and only the "could not save" wording differs ("close without saving" / "reload without
 * saving"). The "Save?" wording is the same for all three choices.
 */
export type SettlePurpose = 'close' | 'reload'

/** The keys for the "could not save" explanation and the wording of the button that discards and proceeds. */
export function unsavedDialogKeys(purpose: SettlePurpose): {
  readonly detail: NativeKey
  readonly discard: NativeKey
} {
  return purpose === 'reload'
    ? { detail: 'dialog.unsavedDrafts.detailReload', discard: 'dialog.unsavedDrafts.discardReload' }
    : { detail: 'dialog.unsavedDrafts.detail', discard: 'dialog.unsavedDrafts.discard' }
}

/** The kind of reload ("Reload" = `reload`, "Force Reload" Cmd+Shift+R = `reloadIgnoringCache`). */
export type ReloadKind = 'normal' | 'ignoreCache'

/**
 * The outcome of a reload. `reloaded` it was reloaded / `cancelled` the user backed out (drafts remain) / `busy` closing, quitting, or another
 * reload is being settled, so nothing is done / `gone` the window is gone or shutdown has begun.
 */
export type ReloadOutcome = 'reloaded' | 'cancelled' | 'busy' | 'gone'

/** What the settling before a reload needs (for one electron window; `index.ts` fills it in). */
export interface ReloadGateDeps {
  /** The window was closed (destroyed). */
  readonly isGone: () => boolean
  /** The renderer crashed — there are no drafts anymore, so reload without settling (the count notification may remain stale). */
  readonly isCrashed: () => boolean
  /** This window is being closed, the app is quitting, or another reload is being settled (do not stack dialogs). */
  readonly isBusy: () => boolean
  /** The renderer has reported unsaved drafts. */
  readonly needsSettle: () => boolean
  /** Set and clear the mark that settling is in progress (Cmd+W / Cmd+Q / reload during this time are not stacked). */
  readonly setBusy: (busy: boolean) => void
  /** The same settling as 606 (purpose `reload`). */
  readonly settle: () => Promise<CloseVerdict>
  /** Shutdown has begun (no reload afterwards). */
  readonly quitting: () => boolean
  readonly reload: (kind: ReloadKind) => void
  /**
   * TODO 1125: drop the Cmd+Q / Cmd+W requests remembered for this window during settling (`ReloadPendingRequests`, per window).
   * Called when the settling was cancelled (`cancelled`), or the window went away or quit began in the meantime (`gone`) — quit and close are also
   * regarded as called off (owner decision 2026-11-05). If not dropped, the flag remains and a later, unrelated reload suddenly quits the app or closes the window.
   */
  readonly dropPending: () => void
}

/**
 * TODO 636 (fix after code-review): how to treat a quit (Cmd+Q) / close (Cmd+W) request that arrived during the reload settling, once
 * the settling is done and it is time to actually reload. **Until now `closeSettling` was reused as the "processing" mark, so
 * a Cmd+Q / Cmd+W during settling was picked up by `isBusy()` and silently dropped, and nothing happened after the settling ended either.**
 *
 * - If a quit request arrived, quit instead of reloading (a reloaded window would be closed anyway).
 * - If no quit arrived but only a close request did, close instead of reloading.
 * - If neither arrived, reload as before.
 *
 * The settling (the dialog) itself runs only once — this just decides "what to do instead of reloading after the settling", and
 * does not show a second dialog (it uses the result of the same settling as 606 as is).
 */
export interface ReloadPendingRequest {
  readonly quit: boolean
  readonly close: boolean
}

export const NO_PENDING_RELOAD_REQUEST: ReloadPendingRequest = { quit: false, close: false }

export type ReloadDeferredAction = 'reload' | 'quit' | 'close'

export function reloadOrDefer(pending: ReloadPendingRequest): ReloadDeferredAction {
  if (pending.quit) return 'quit'
  if (pending.close) return 'close'
  return 'reload'
}

/**
 * The Cmd+Q / Cmd+W remembered during reload settling (TODO 636 / 1125). **Held per window** (fix from the review of TODO 1125): previously
 * Cmd+Q was a single app-wide flag, and it was also dropped by the cancellation of window B's reload, a different window from window A that received the Cmd+Q (even if A
 * chose to save, it did not quit). Cmd+Q is tied only to the windows (possibly several) that were being settled at that time, and is dropped only by the cancellation of such a window.
 * The window is electron's `BrowserWindow` (`index.ts`). Tests use arbitrary objects.
 */
export class ReloadPendingRequests<W extends object> {
  private readonly quit = new Set<W>()
  private readonly close = new Set<W>()

  /** Cmd+Q arrived: remember it for the windows currently being settled for reload. */
  requestQuit(settling: readonly W[]): void {
    for (const window of settling) this.quit.add(window)
  }

  /** Cmd+W for this window arrived during settling. */
  requestClose(window: W): void {
    this.close.add(window)
  }

  /** What to do after this window's settling (passed to `reloadOrDefer`). */
  pendingFor(window: W): ReloadPendingRequest {
    return { quit: this.quit.has(window), close: this.close.has(window) }
  }

  /** This window's settling was cancelled or the window went away: drop only this window's share. True if anything was dropped. */
  drop(window: W): boolean {
    const dropped = this.quit.has(window) || this.close.has(window)
    this.forget(window)
    return dropped
  }

  /** This window's share has been used up (reloaded or closed). */
  forget(window: W): void {
    this.quit.delete(window)
    this.close.delete(window)
  }

  /** Proceeding to quit: every window's Cmd+Q is used up (if left, after quit is called off another window's settling would quit again). */
  forgetQuit(): void {
    this.quit.clear()
  }
}

/**
 * TODO 933: whether to drop a window's `close` during the quit's drafts settling. While the quit settling (`quitSettling`) has a sheet
 * up for window A, if another window B is closed with Cmd+W, B's close settling starts separately, and after A is answered `settleAll` asks
 * B once more, and a second sheet appears. If quit has been decided (`quitApproved`), the window may close.
 * The reverse direction (Cmd+Q / "restart and update" during a close settling) is dropped by `anyCloseSettling`.
 */
export function shouldDropCloseDuringQuitSettle(state: {
  readonly quitApproved: boolean
  readonly quitSettling: boolean
}): boolean {
  return !state.quitApproved && state.quitSettling
}

/**
 * TODO 636: before a window reload, settle the viewer's unsaved drafts the same way as 606 (write everything out if auto-save is ON, ask if
 * OFF). If cancelled, do not reload. A window with no drafts, or one whose renderer crashed, reloads immediately.
 *
 * If the settling itself throws, **do not reload** (bundle D's default): unlike close and quit, failing to reload is no problem (it can be pressed again),
 * but drafts do not come back after a reload. If the renderer does not reply (frozen), as in 606 it falls to `proceed` after 10 seconds, so
 * a frozen window can also be reloaded.
 */
export async function reloadWithDrafts(kind: ReloadKind, deps: ReloadGateDeps): Promise<ReloadOutcome> {
  if (deps.isGone() || deps.quitting()) return 'gone'
  if (deps.isBusy()) {
    log.info('window.reload.busy', { kind })
    return 'busy'
  }
  if (deps.isCrashed() || !deps.needsSettle()) {
    deps.reload(kind)
    return 'reloaded'
  }
  deps.setBusy(true)
  let verdict: CloseVerdict
  try {
    verdict = await deps.settle()
  } catch (err) {
    log.error('window.reload.drafts.failed', { message: err instanceof Error ? err.message : String(err) })
    verdict = 'cancel'
  } finally {
    deps.setBusy(false)
  }
  log.info('window.reload.drafts', { kind, verdict })
  if (verdict !== 'proceed') {
    deps.dropPending()
    return 'cancelled'
  }
  // The window closed or quit began during the dialog.
  if (deps.isGone() || deps.quitting()) {
    deps.dropPending()
    return 'gone'
  }
  deps.reload(kind)
  return 'reloaded'
}

/** Upper bound on file names listed in the dialog (as in VS Code, if there are more, "and N more"). */
export const MAX_LISTED_NAMES = 10

/** The names to list in the dialog body (only the last segment of each name). If there are more, `more` holds the remaining count. */
export function listedNames(entries: readonly ViewerDraftEntry[], basename: (uri: string) => string): {
  readonly names: readonly string[]
  readonly more: number
} {
  const names = entries.slice(0, MAX_LISTED_NAMES).map((entry) => basename(entry.uri))
  return { names, more: Math.max(0, entries.length - names.length) }
}
