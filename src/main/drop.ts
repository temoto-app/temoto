/**
 * Create a thread by dropping a folder from Finder (item 98, ARCHITECTURE.md 4.3.2).
 *
 * There are three drop places (the thread list / the new-thread dialog / the Dock icon), but
 * **the folder decision, converting a file to its parent, and the count check are in this one place**, and both the IPC and
 * `open-file` go through `createThreadFromDrop`. The renderer passes only URIs
 * (the rule stays: paths exist only in main).
 *
 * Does not import electron (the clock and fs are injected). `test/drop-folder.test.ts` is the regression test.
 */
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { reasonError } from '@shared/reason.js'
import type { CreateThreadInput, Thread } from '@shared/thread.js'
import type { OpenRequest } from '@shared/ipc.js'
import { PathDenied, pathDenialCode } from '../common/fs-policy.js'
import { foldPath, pathToUri } from '../common/uri.js'

/** Cap on the number of items received in one Drop. So `stat` does not keep running on a Drop of tens of thousands. */
export const MAX_DROPPED_ITEMS = 256

export interface DropFolderDeps {
  /**
   * `FsAccess.assertAllowed` (12.7). Throws if an exclusion matches, otherwise returns the path.
   * Applied to both the dropped item itself and the folder finally decided.
   */
  assertAllowed(uri: string, asDirectory: boolean): string
  /** `directory` if a directory, `other` otherwise, null if absent. */
  kindOf(path: string): Promise<'directory' | 'other' | null>
}

/** The real `stat` (follows symlinks. The check of the followed target is already done by `assertAllowed`). */
export async function kindOfPath(path: string): Promise<'directory' | 'other' | null> {
  try {
    return (await stat(path)).isDirectory() ? 'directory' : 'other'
  } catch {
    return null
  }
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') || '/' : path
}

/**
 * Calls `deps.assertAllowed` and rethrows a `PathDenied` converted to a reason code (item 141).
 * Without this, the renderer would receive an untranslated raw sentence like `PathDenied: excluded`
 * (because `Error.toString()` is used for the IPC reject message).
 */
function assertAllowedReason(
  deps: DropFolderDeps,
  uri: string,
  asDirectory: boolean
): string {
  try {
    return deps.assertAllowed(uri, asDirectory)
  } catch (err) {
    if (err instanceof PathDenied) throw reasonError(pathDenialCode(err.reason))
    throw err
  }
}

/**
 * Turns the set of dropped URIs into the URI of **one folder** to use as the thread's cwd.
 *
 * - A file becomes the folder containing it (not attached, owner decision 3).
 * - The count is taken **after converting to parents** (however many files in the same folder are dropped, it is one).
 *   Comparison uses folded paths (APFS is case-insensitive).
 * - Two or more gives `drop-multiple-folders` (owner decision 4).
 * - For what matches the exclusion rules (the dropped item, or a file's parent), the `assertAllowed` exception is converted to a reason code
 *   (item 141) and rethrown (`assertAllowedReason`).
 */
export async function resolveDroppedFolder(
  uris: readonly string[],
  deps: DropFolderDeps
): Promise<string> {
  if (uris.length === 0) throw reasonError('drop-empty')
  if (uris.length > MAX_DROPPED_ITEMS) {
    throw reasonError('invalid-value', { field: 'uris' })
  }
  const folders = new Map<string, string>()
  for (const uri of uris) {
    // Pass the choke point first: nothing under an exclusion (such as `~/Library`) is even `stat`-ed.
    const path = trimTrailingSlash(assertAllowedReason(deps, uri, false))
    const kind = await deps.kindOf(path)
    if (kind === null) throw reasonError('drop-not-found')
    const folder = kind === 'directory' ? path : dirname(path)
    // Different spellings of the same folder (case, NFC/NFD): take the spelling seen first.
    const key = foldPath(folder)
    if (!folders.has(key)) folders.set(key, folder)
  }
  if (folders.size > 1) throw reasonError('drop-multiple-folders', { count: folders.size })
  const [folder] = folders.values()
  if (folder === undefined) throw reasonError('drop-empty')
  const uri = pathToUri(folder)
  // A file's parent matching an exclusion also fails here.
  assertAllowedReason(deps, uri, true)
  return uri
}

/**
 * Creates a thread from the dropped items. `input` holds the creation-time values other than cwd (from the dialog,
 * the currently selected values; from the list and the Dock, empty = the settings defaults). **A new thread is created even if one with the same cwd
 * exists.** `createThread` records the history (`touchCwd`).
 */
export async function createThreadFromDrop(
  uris: readonly string[],
  input: Omit<CreateThreadInput, 'cwdUri' | 'scratch'>,
  deps: DropFolderDeps & { create(input: CreateThreadInput): Promise<Thread> }
): Promise<Thread> {
  const cwdUri = await resolveDroppedFolder(uris, deps)
  return deps.create({ ...input, cwdUri })
}

export interface DropTimers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const REAL_TIMERS: DropTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** Interval for batching items dropped on the Dock. `open-file` arrives one at a time in succession. */
export const OPEN_FILE_BATCH_MS = 100

/**
 * The batcher for `open-file` (item 98 (c)). If nothing comes for `delayMs` after the last one,
 * it `flush`es them together. **Items that arrive before `ready` are only accumulated** and, after `markReady`,
 * sent through the same decision (a Drop on the Dock while the app is not running).
 */
export class OpenFileBatcher {
  private pending: string[] = []
  private timer: unknown = null
  private ready = false
  private disposed = false

  constructor(
    private readonly flush: (paths: readonly string[]) => void,
    private readonly delayMs: number = OPEN_FILE_BATCH_MS,
    private readonly timers: DropTimers = REAL_TIMERS
  ) {}

  push(path: string): void {
    if (this.disposed) return
    this.pending.push(path)
    if (this.ready) this.arm()
  }

  markReady(): void {
    if (this.disposed || this.ready) return
    this.ready = true
    if (this.pending.length > 0) this.arm()
  }

  /** Shutdown (12.9). A `push` after this is dropped. */
  dispose(): void {
    this.disposed = true
    this.pending = []
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  private arm(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = this.timers.set(() => {
      this.timer = null
      const batch = this.pending
      this.pending = []
      if (batch.length > 0 && !this.disposed) this.flush(batch)
    }, this.delayMs)
  }
}

/**
 * The "thread to open" per window (item 98 (c)). A thread created by a Drop on the Dock must also reach a window
 * that has just opened and has not subscribed yet, so main does not push it but **keeps it**:
 * it sends the window only a signal (`IpcEvent.openRequest`), and the renderer comes to fetch it after subscribing and on each signal.
 * One per window (a later one wins). The key is `webContents.id`.
 */
export class OpenRequests {
  private readonly byView = new Map<number, OpenRequest>()

  put(viewId: number, request: OpenRequest): void {
    this.byView.set(viewId, request)
  }

  take(viewId: number): OpenRequest | null {
    const request = this.byView.get(viewId) ?? null
    this.byView.delete(viewId)
    return request
  }

  forget(viewId: number): void {
    this.byView.delete(viewId)
  }
}
