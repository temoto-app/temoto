/**
 * Receives `aios://new?…` and opens a new conversation (TODO 976 stage 3, ARCHITECTURE 3.3).
 *
 * The shape and limits are checked by the pure functions in `src/common/app-url.ts`; this file handles **validating paths that came from outside** and creating the conversation:
 *
 * - `cwd` and `file` go through `FsAccess.assertAllowed` (12.7); if they fail, **only that argument is dropped** (not the whole URL).
 *   `cwd` uses the same `resolveDroppedFolder` as a Drop on the Dock (item 98), turning a file into its parent.
 * - If `cwd` is absent (or was dropped), the conversation is created with no folder (the scratch area, T19), the same as the default of "new conversation".
 * - The body and attachments are only handed to the window (`OpenRequest.draft` / `attach`); **nothing is sent**. The renderer stacks attachments with
 *   the same `attachUris` -> `resolveAttachment` as a Drop, so they are validated again in main, and dropped ones appear in the band.
 * - **Query before creating the first-folder notice (item 123)** (TODO 1118). If there is a notice (= a first folder with hooks / MCP that run without
 *   confirmation), create the conversation with the working-folder history (`touchCwd`) delayed until the first send. If it were added to the history
 *   at creation, the band would never appear even if the same folder were later chosen in the creation dialog. The band itself is shown by `ThreadFolderNotice` above the conversation's Composer,
 *   which queries the same `folderNotice` for a conversation with no messages. No dialog is added.
 *
 * Does not import electron (creation, the choke point and stat are injected). `test/app-url.test.ts` is the regression test.
 */
import type { CreateThreadInput, FolderNotice, Thread } from '@shared/thread.js'
import type { OpenRequest } from '@shared/ipc.js'
import type { AppUrlNew, AppUrlParam } from '../common/app-url.js'
import { reasonError } from '@shared/reason.js'
import { log, errorFields } from '../common/logger.js'
import { pathToUri } from '../common/uri.js'
import { resolveDroppedFolder, type DropFolderDeps } from './drop.js'

export interface AppUrlOpenDeps extends DropFolderDeps {
  /**
   * Creates. If `deferCwdHistory` is true, adding to the working-folder history (`touchCwd`) is delayed until the first send
   * (TODO 1118, a main-only argument of `SessionManager.createThread`).
   */
  create(input: CreateThreadInput, options: { readonly deferCwdHistory: boolean }): Promise<Thread>
  /** The first-folder notice (item 123, `SessionManager.folderNotice`). Does not throw (a failure is null). */
  folderNotice(cwdUri: string): Promise<FolderNotice | null>
}

/** Normalizes an absolute path or a `file:` URI (a value whose shape `parseAppUrl` checked) into a URI. */
function toUri(value: string): string {
  return value.startsWith('file://') ? value : pathToUri(value)
}

/** Log of an argument dropped at the choke point. Only the argument name, the path (or `file:` URI) and the reason are written (never the body). */
function logRejected(param: AppUrlParam, value: string, err: unknown): void {
  log.warn('app-url.arg.rejected', { param, path: value, ...errorFields(err) })
}

/**
 * Validates, then creates the conversation and returns the `OpenRequest` to hand to the window. If it could not be created, an `OpenRequest` with the reason
 * (shown in the window's band).
 */
export async function openFromAppUrl(request: AppUrlNew, deps: AppUrlOpenDeps): Promise<OpenRequest> {
  for (const drop of request.dropped) log.info('app-url.arg.dropped', { param: drop.param, reason: drop.reason })

  let cwdUri: string | null = null
  // When `cwd` was dropped: open with no folder (a URL must not start running things by itself), but do not stay silent; show the reason in the band (the same reason code as a Drop on the Dock).
  let notice: string | undefined
  // A `cwd` dropped at the parse stage because of its shape (relative path etc.) is handled the same way.
  if (request.cwd === null && request.dropped.some((d) => d.param === 'cwd' && d.reason === 'not-absolute')) {
    notice = reasonError('invalid-value', { field: 'cwd' }).message
  }
  if (request.cwd !== null) {
    try {
      cwdUri = await resolveDroppedFolder([toUri(request.cwd)], deps)
    } catch (err) {
      logRejected('cwd', request.cwd, err)
      notice = err instanceof Error ? err.message : String(err)
    }
  }

  const attach: string[] = []
  for (const file of request.files) {
    try {
      const uri = toUri(file)
      // Existence, being a directory and size are checked by the renderer's `attachUris` -> `resolveAttachment` (if one fails it shows in the band).
      // This is only the choke point (nothing under an exclusion is even `stat`-ed, the same order as item 98).
      deps.assertAllowed(uri, false)
      attach.push(uri)
    } catch (err) {
      logRejected('file', file, err)
    }
  }

  // TODO 1118: query before creating (once created and added to the history, it is no longer "first"). If there is a notice, delay the history until the first send.
  let firstFolder = false
  if (cwdUri !== null) {
    try {
      firstFolder = (await deps.folderNotice(cwdUri)) !== null
    } catch (err) {
      // `folderNotice` promises not to throw, but just in case, fall to the "notify" side (delay the history).
      log.warn('app-url.folderNotice.failed', errorFields(err))
      firstFolder = true
    }
  }

  let thread: Thread
  try {
    thread = await deps.create(cwdUri === null ? { scratch: true } : { cwdUri }, { deferCwdHistory: firstFolder })
  } catch (err) {
    log.warn('app-url.create.failed', errorFields(err))
    return { reason: (err as Error).message }
  }
  log.info('app-url.opened', {
    threadId: thread.id,
    scratch: cwdUri === null,
    firstFolder,
    hasText: request.text !== '',
    files: attach.length
  })
  return {
    threadId: thread.id,
    created: true,
    ...(request.text === '' ? {} : { draft: request.text }),
    ...(attach.length === 0 ? {} : { attach }),
    ...(notice === undefined ? {} : { notice })
  }
}

/** Cap on the number of URLs held before startup (before `ready` / bootstrap). The excess is dropped. */
export const MAX_PENDING_APP_URLS = 8

/**
 * Inbox for URLs delivered by `open-url` / `second-instance`. **Until bootstrap finishes (`markReady`) it only accumulates**,
 * then passes arrivals to `handle` one at a time (the same shape as the Drop on the Dock's `OpenFileBatcher`. One URL is
 * one conversation, so they are not batched). A `push` after `dispose` is dropped (12.9).
 */
export class AppUrlInbox {
  private pending: string[] = []
  private ready = false
  private disposed = false

  constructor(private readonly handle: (url: string) => unknown) {}

  /** An exception or rejection from `handle` is not left unhandled; it goes to the structured log (the same as a Drop on the Dock. Neither the URL nor the body is written). */
  private run(url: string): void {
    try {
      const result = this.handle(url)
      if (result instanceof Promise) result.catch((err: unknown) => log.warn('app-url.failed', errorFields(err)))
    } catch (err) {
      log.warn('app-url.failed', errorFields(err))
    }
  }

  push(url: string): void {
    if (this.disposed) return
    if (this.ready) {
      this.run(url)
      return
    }
    if (this.pending.length >= MAX_PENDING_APP_URLS) {
      log.warn('app-url.pending.overflow', { max: MAX_PENDING_APP_URLS })
      return
    }
    this.pending.push(url)
  }

  markReady(): void {
    if (this.disposed || this.ready) return
    this.ready = true
    const batch = this.pending
    this.pending = []
    for (const url of batch) this.run(url)
  }

  dispose(): void {
    this.disposed = true
    this.pending = []
  }
}
