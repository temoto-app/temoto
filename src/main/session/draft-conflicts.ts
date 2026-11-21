/**
 * Draft conflict notice (item 97 second half, ARCHITECTURE.md 4.5.1 / 7.6.2).
 *
 * When the model tries to rewrite, with `Edit` / `Write` / `NotebookEdit` (`toolKinds.map[*].write` in compat;
 * extracting the target path is backend-specific, so it is `AgentAdapter.writeToolTargetPath`, implemented as
 * `writeToolTargetPath` in `adapter/progress.ts`, constraint 6), a file for which the user holds a draft in the
 * ViewerPane (`draft`, an unsaved edit), the **window showing that thread** is notified. By default writes are
 * also auto-approved (T40), so this **has no say at all in whether to approve. Notification only.**
 *
 * Main does not know whether a draft exists (it is React state in the ViewerPane). The renderer calls `reportDraft`
 * only when a draft is born / disappears / is saved / its URI changes (not on every high-frequency keystroke). Each
 * window (`viewId` = `webContents.id`) holds at most one "current draft URI" (the ViewerPane is one viewer per
 * window, 7.4). Matching is an exact match after folding (`foldPath`), so differences in case or normalization are
 * not missed (the same reason as PHASE1_BRIEF 3.3).
 *
 * A small box that touches neither power, the DB nor the backend: only per-window memory and matching.
 * `test/draft-conflicts.test.ts` checks it as is.
 */
import { foldPath } from '../../common/uri.js'

/**
 * A small box that holds each window's "current draft URI" and only matches against it.
 * It holds no policy decision (whether to notify): that is the job of `handleGatewayRequest`.
 */
export class DraftConflictTracker {
  private readonly drafts = new Map<number, string>()
  /**
   * The count of the per-window draft table (the renderer's `viewerDrafts`, TODO 312) (code-review of TODO 103).
   * `drafts` covers only the file currently being viewed, so an unsaved draft of a file the user switched away from is known only here.
   */
  private readonly stored = new Map<number, number>()

  /** The draft of window `viewId` changed. A null `uri` means "no draft". */
  reportDraft(viewId: number, uri: string | null): void {
    if (uri === null) this.drafts.delete(viewId)
    else this.drafts.set(viewId, foldPath(uri))
  }

  /** The count of the draft table for window `viewId` changed (0 means forget it). */
  reportStored(viewId: number, count: number): void {
    if (count > 0) this.stored.set(viewId, count)
    else this.stored.delete(viewId)
  }

  /**
   * Whether any window has an unsaved draft (this stops the idle restart of TODO 103). Looks at both the file
   * being viewed now and the files switched away from (the draft table).
   */
  hasAny(): boolean {
    return this.drafts.size > 0 || this.stored.size > 0
  }

  /**
   * Whether window `viewId` has an unsaved draft (TODO 606: decides, before closing the window or quitting, whether to ask that window's renderer).
   */
  hasIn(viewId: number): boolean {
    return this.drafts.has(viewId) || this.stored.has(viewId)
  }

  /**
   * Whether the file window `viewId` is viewing now has an unsaved draft (TODO 832 (1)). This is the only window where the
   * renderer's `planViewerCommand` can turn another file's "open" into `keep`, so the gateway's openFile asks only this window for a reply.
   */
  hasCurrent(viewId: number): boolean {
    return this.drafts.has(viewId)
  }

  /** The window was closed or reloaded. Its draft memory goes with it (until `reportDraft` is called again). */
  close(viewId: number): void {
    this.drafts.delete(viewId)
    this.stored.delete(viewId)
  }

  /**
   * Of `viewIds`, returns only the windows that hold a draft for `targetUri` (order stays as in `viewIds`).
   * Pass `viewIds` **already** narrowed to the windows showing that thread (`ThreadViews.viewsOf`): matching a draft
   * is by URI only, so without narrowing it would pick up drafts of unrelated windows.
   */
  conflictsAmong(viewIds: readonly number[], targetUri: string): number[] {
    const folded = foldPath(targetUri)
    return viewIds.filter((id) => this.drafts.get(id) === folded)
  }
}
