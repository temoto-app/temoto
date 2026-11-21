/**
 * "Rewind to here" (item 113, 4.5.6, TODO 578 (f)). The bodies of `SessionManager.rewindPreview` /
 * `SessionManager.rewind` were split out to here: deciding the branch point, deciding whether a reply is in progress,
 * restoring files (waking the original thread by resume if it is not running), and creating the new branched thread.
 *
 * **It touches neither electron nor the DB directly** - it reaches `SessionManager` state (live connections, the send queue,
 * the Adapter) only through `RewindHost`. `store` is an instance of the concrete class `ThreadStore`, passed as is
 * (the same treatment as `gateway-requests.ts` passing `index` / `fs` directly - the problem of structurally assigning private
 * fields only arises when passing `SessionManager` itself (`this`)). In its constructor in `manager.ts`, `SessionManager` just builds
 * a bundle of closures of this shape (a thin host that does not leak the private fields of `this`) and
 * passes it in; the public `rewindPreview` / `rewind` entry points are unchanged. Behavior is the same as before the move
 * (including the order in which logs fire).
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { formatReason, reasonError } from '@shared/reason.js'
import {
  UNTITLED_THREAD_TITLE,
  type RewindOptions,
  type RewindPreview,
  type Thread
} from '@shared/thread.js'
import { log } from '../../common/logger.js'
import { pathToUri, uriToPath } from '../../common/uri.js'
import type { ThreadStore } from './store.js'
import type { RewindFilesResult } from './types.js'

const DEFAULT_TITLE = UNTITLED_THREAD_TITLE

/**
 * If the original conversation has moved into a worktree, the new thread of a branch or hand-over is also started in the same worktree (TODO 633 / 992 part 1).
 * It is put into the cleanup table as `fork` (a reference): even if the original conversation is deleted, cleanup keeps the worktree while the new thread is using it
 * (`isWorktreeReferencedByOthers`). When the new thread is deleted, its row is checked by the same rule. If the worktree was removed later,
 * launch (`workingCwdForSpawn`) falls back to the original cwd. If the conversation has not moved, nothing happens.
 */
export function shareWorktree(store: ThreadStore, from: Thread, toThreadId: string): void {
  if (from.worktreeUri === undefined) return
  const worktree = resolve(uriToPath(from.worktreeUri))
  store.setWorktreeCwd(toThreadId, worktree)
  const owned = store.threadWorktrees(from.id).find((w) => w.path === worktree)
  store.addThreadWorktree({
    threadId: toThreadId,
    path: worktree,
    branch: owned?.branch ?? null,
    origin: 'fork',
    repoCwd: owned?.repoCwd ?? uriToPath(from.cwdUri),
    at: Date.now()
  })
}

/**
 * The entry point `RewindService` borrows from `SessionManager`. **`SessionManager` does not pass `this` as is;
 * it builds a small bundle of closures of this shape and passes that** - so private fields are not
 * exposed. `store` is an internal-only entry point where the real object `SessionManager` keeps may be passed as is (by reference),
 * so its type is used directly.
 */
export interface RewindHost {
  readonly store: ThreadStore
  /**
   * Whether the state allows accepting "rewind to here" (false while a reply is in progress, starting, stopping, awaiting approval, or
   * being woken again). The check `assertRewindable` used to make stays on the `SessionManager` side.
   */
  isRewindable(threadId: string): boolean
  /** Whether the Adapter supports the `rewind` feature. */
  adapterSupportsRewind(thread: Thread): boolean
  /**
   * Restores the files (only a preview if `dryRun`). If the thread is not running, wakes the original thread by resume
   * (the body of `liveForRewind` stays on the `SessionManager` side and is called from here).
   * null for a version that does not support it or an implementation without an entry point.
   */
  rewindFiles(thread: Thread, userMessageId: string, dryRun: boolean): Promise<RewindFilesResult | null>
  /** Delivers a change of the thread list to the renderer (item 75). */
  emitThreads(): void
}

export class RewindService {
  constructor(private readonly host: RewindHost) {}

  /**
   * Preview of "rewind to here" (item 113): asks what restoring the files would change, without restoring.
   * The renderer shows it for confirmation before branching the conversation (`rewind`). The reason for refusing is returned not as a throw but as
   * `reason` (a reason code) - not supported, no identifier, or cannot restore all mean "the files
   * cannot be restored but the conversation alone can still be branched", so the renderer keeps only that branch.
   * Only a reply in progress (`rewind-busy`) and a row that is not a user message throw.
   */
  async rewindPreview(threadId: string, eventId: string): Promise<RewindPreview> {
    const thread = this.host.store.getThread(threadId)
    if (thread === null) throw new Error('thread not found')
    const point = this.host.store.rewindPoint(threadId, eventId)
    if (point === null) throw reasonError('rewind-not-user-message')
    const nothing = (code: 'rewind-unsupported' | 'rewind-no-checkpoint' | 'rewind-failed'): RewindPreview => ({
      canRewind: false,
      files: [],
      insertions: 0,
      deletions: 0,
      reason: formatReason(code)
    })
    if (!this.host.adapterSupportsRewind(thread)) return nothing('rewind-unsupported')
    // TODO 1121: the checkpoint of a message before a reset (`/clear`) is in the previous session's transcript, so we would hand the current
    // session an old identifier - the files cannot be restored (only the conversation branch remains).
    if (point.userMessageId === null || point.resetAfter) return nothing('rewind-no-checkpoint')
    this.assertRewindable(threadId)
    const result = await this.host.rewindFiles(thread, point.userMessageId, true)
    if (result === null) return nothing('rewind-unsupported')
    log.info('thread.rewind.preview', {
      threadId,
      canRewind: result.canRewind,
      files: result.filesChanged.length
    })
    if (!result.canRewind) return nothing('rewind-failed')
    return {
      canRewind: true,
      // Display only (does not go through the choke point: it is the list of files the backend wrote itself, and the route to open them is separate).
      files: result.filesChanged.map(pathToUri),
      insertions: result.insertions,
      deletions: result.deletions,
      reason: null
    }
  }

  /**
   * "Rewind to here" (item 113, 4.5.6, owner decision 2026-09-27): creates a **new thread branched from** the state
   * **immediately before** the user message `eventId`. The original thread is untouched (`thread_events` is append-only).
   *
   * - Conversation: the first launch of the new thread resumes the original session as a separate session from the conversation up to the reply
   *   just before that message (the row holds a `ForkOrigin`, which `startLive` uses). If it was rewound to before the first
   *   message (there is no previous reply), it is an empty thread that inherits nothing.
   * - Files (`options.files`): makes the original thread's session (woken by resume if it does not exist) restore to the checkpoint
   *   immediately before that message. The thread is created **after restoring** (if it cannot be restored, nothing is created).
   *   The original thread's conversation does not know the files were restored (be careful if you continue in that thread).
   * - The timeline is not copied. The new thread points at the original message with `Thread.forkedFrom`, and the renderer lets the user jump
   *   from the band. The same message is also never indexed twice.
   *
   * Settings (cwd, reference scope, settings source, model / thinking, strict mode, retention) are copied from the original thread.
   * The title is copied too (a provisional title stays provisional and gets its name on the first send).
   */
  async rewind(threadId: string, eventId: string, options: RewindOptions): Promise<Thread> {
    const store = this.host.store
    const thread = store.getThread(threadId)
    if (thread === null) throw new Error('thread not found')
    const point = store.rewindPoint(threadId, eventId)
    if (point === null) throw reasonError('rewind-not-user-message')
    if (!this.host.adapterSupportsRewind(thread)) throw reasonError('rewind-unsupported')
    // There is a previous reply but no identifier (a row from before item 113) - do not silently shift to an older reply.
    if (point.hasPrior && point.priorMessageId === null) throw reasonError('rewind-no-branch-point')
    // The conversation to inherit. If there is no previous reply, start from empty (do not pass the original id). Also start from empty when there is no sessions row
    // (deleted before launch, etc.) - there is no conversation to branch.
    // TODO 1121: if there was a reset (`/clear`) after that message, the previous reply belongs to an earlier session. Do not wake with the latest session paired
    // with an old identifier; look up the session that produced the previous reply in record order (refuse if it cannot be found. Looking up by time fails when
    // the row's time is older than the session row, as for a conversation continued or loaded from a transcript - review fix).
    const backendSessionId = !point.hasPrior
      ? null
      : point.resetAfter
        ? store.backendSessionOfResponse(threadId, point.priorSeq ?? 0, point.priorTs ?? 0)
        : store.latestBackendSessionId(threadId)
    if (point.hasPrior && point.resetAfter && backendSessionId === null) throw reasonError('rewind-no-branch-point')
    this.assertRewindable(threadId)

    if (options.files) {
      // TODO 1121: the checkpoint of a message before a reset cannot be looked up from the current session (same as the preview).
      if (point.userMessageId === null || point.resetAfter) throw reasonError('rewind-no-checkpoint')
      const result = await this.host.rewindFiles(thread, point.userMessageId, false)
      if (result === null) throw reasonError('rewind-unsupported')
      if (!result.canRewind) throw reasonError('rewind-failed')
    }

    if (point.hasPrior && backendSessionId === null) {
      log.warn('thread.rewind.noSession', { threadId })
    }
    const fork = store.createThread({
      id: randomUUID(),
      title: thread.title,
      titleAuto: thread.title === DEFAULT_TITLE,
      cwd: uriToPath(thread.cwdUri),
      allowedDirs: thread.allowedDirUris.map(uriToPath),
      retention: thread.retention,
      settingSources: thread.settingSources,
      backend: thread.backend,
      modelId: thread.modelId,
      thinking: thread.thinking,
      approvalStrict: thread.approvalStrict,
      // TODO 1106: a branch also inherits the original OS sandbox.
      osSandbox: thread.osSandbox === true,
      // TODO 972 (code-review, wave 96 fix Y): a branch stays under the same Teammate (heading in the list, standing instructions at launch).
      ...(thread.roleId === undefined ? {} : { roleId: thread.roleId }),
      forkOrigin: {
        threadId,
        eventId,
        files: options.files,
        backendSessionId,
        atMessageId: backendSessionId === null ? null : point.priorMessageId
      }
    })
    if (thread.retention === 'days' && thread.retentionDays !== null) {
      store.setRetention(fork.id, thread.retention, thread.retentionDays)
    }
    // TODO 633: a branch of a conversation that moved into a worktree is started in the same worktree (the transcript is at the cwd location it moved to).
    // It goes into the cleanup table as `fork` (a reference) (code-review fix): even if the original conversation is deleted, cleanup keeps it while the branch is using it
    // (`isWorktreeReferencedByOthers`). When the branch is deleted, the branch's row is checked by the same rule.
    if (backendSessionId !== null) shareWorktree(store, thread, fork.id)
    log.info('thread.rewind', {
      threadId,
      forkId: fork.id,
      files: options.files,
      resume: backendSessionId !== null
    })
    this.host.emitThreads()
    return store.getThread(fork.id) ?? fork
  }

  /**
   * Whether the state allows accepting "rewind to here". Refused (the user must stop first) while a reply is in progress (mid-send, waiting for `result`, waiting for an interrupt),
   * starting, stopping, awaiting approval, or being woken again - restoring files during that
   * would mix with the running turn's writes. A reservation (what remains after a stop) only
   * stays in the original thread, so it does not cause a refusal.
   */
  private assertRewindable(threadId: string): void {
    if (!this.host.isRewindable(threadId)) throw reasonError('rewind-busy')
  }
}
