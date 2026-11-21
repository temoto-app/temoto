/**
 * Detects that an external tool rewrote the file shown in a ViewerPane (TODO 673, wave 31 bundle B,
 * ARCHITECTURE.md 5.2 / 7.4).
 *
 * **It watches only the files main has open** (at most one file per window and per ViewerPane, 7.4).
 * It does not piggyback on the index process's watching (`src/index-kernel/watcher.ts`): we want it to work
 * on files outside the index, such as excluded folders and `/tmp`, and to finish without waiting for a round trip to the index process.
 * The watch is on **the parent directory, not the file** (`fs.watch` on the file itself
 * misses saves by editors (vim and the like) that write with an atomic rename. Watching the parent catches renames too).
 *
 * On each change it debounces and then runs `stat`, and notifies if `mtimeMs` / `size` differ from the last known values (the results of the previous
 * read or write). Right after our own writes (saves, autosave 555, the flushes of 606 / 636) it advances the baseline with `settle`,
 * so a re-read does not run on every save.
 *
 * The decision (`changed`) is factored out as a pure function (`test/viewer-watch.test.ts` tests it directly), and
 * `ViewerFileWatcher` holds only the `node:fs` side (tests with an injected fake watcher are in
 * `test/viewer-watch-fs.test.ts`).
 */
import { watch, statSync, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'
import { log, errorFields } from '../../common/logger.js'

/** Debounce interval (ms) for checking changes. An editor's save emits several events in a row, such as rename + create. */
export const WATCH_DEBOUNCE_MS = 300

export interface FileStamp {
  readonly mtimeMs: number
  readonly size: number
}

/**
 * Whether the `stat` values changed from `baseline`. `mtimeMs` is compared with the same
 * rounding as `ViewerBroker.write`'s conflict check (ignoring differences in the precision of the fractional part between file systems).
 */
export function changed(baseline: FileStamp, stat: FileStamp): boolean {
  return Math.round(baseline.mtimeMs) !== Math.round(stat.mtimeMs) || baseline.size !== stat.size
}

export interface ViewerFileWatchDeps {
  /** A change was detected (prompts window `viewId` to re-read `uri`). */
  readonly notify: (viewId: number, uri: string) => void
  /** Debounce interval (ms). Shortened only by tests (default `WATCH_DEBOUNCE_MS`). */
  readonly debounceMs?: number
}

interface WatchEntry {
  readonly uri: string
  readonly path: string
  mtimeMs: number
  size: number
  readonly watcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Holds only one "file being viewed now" per window (`viewId` = `webContents.id`)
 * (the same key and the same "one window, one file" premise as `DraftConflictTracker`, ARCHITECTURE 5.2).
 */
export class ViewerFileWatcher {
  private readonly entries = new Map<number, WatchEntry>()
  private readonly debounceMs: number

  constructor(private readonly deps: ViewerFileWatchDeps) {
    this.debounceMs = deps.debounceMs ?? WATCH_DEBOUNCE_MS
  }

  /**
   * Window `viewId` has just read / written `uri` (whose real path is `path`). If it was viewing a file before,
   * that one is released first. `mtimeMs` / `size` are the values at that moment (the baseline).
   *
   * **Code-review fix (the latter half of serious item 7)**: when re-reading the same file (auto-refresh, 673's own
   * `reloadFromDisk`, and so on), `fs.watch` is not recreated and only the baseline (`mtimeMs` / `size`) is
   * updated. Creating a new `FSWatcher` on every close and re-open is wasteful, and a change that happens exactly in the very short gap
   * (between close and re-watch) could be missed.
   */
  track(viewId: number, uri: string, path: string, mtimeMs: number, size: number): void {
    const existing = this.entries.get(viewId)
    if (existing !== undefined && existing.path === path) {
      existing.mtimeMs = mtimeMs
      existing.size = size
      return
    }
    this.untrack(viewId)
    let watcher: FSWatcher
    try {
      watcher = watch(dirname(path), { persistent: false }, () => this.scheduleCheck(viewId))
    } catch (err) {
      // The directory is unreadable, gone, and so on. It should not normally happen while it is readable; we just quietly stop watching
      // (this window's display itself keeps working as before).
      log.debug('viewer.watch.failed', errorFields(err))
      return
    }
    watcher.on('error', (err) => {
      log.debug('viewer.watch.error', errorFields(err))
      this.untrack(viewId)
    })
    this.entries.set(viewId, { uri, path, mtimeMs, size, watcher, timer: null })
  }

  /** Takes the `mtimeMs` / `size` advanced by our own write into the baseline without sending a notification. */
  settle(viewId: number, uri: string, mtimeMs: number, size: number): void {
    const entry = this.entries.get(viewId)
    if (entry === undefined || entry.uri !== uri) return
    entry.mtimeMs = mtimeMs
    entry.size = size
  }

  /** The window closed / re-read (the same path as TODO 71). */
  untrack(viewId: number): void {
    const entry = this.entries.get(viewId)
    if (entry === undefined) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.watcher.close()
    this.entries.delete(viewId)
  }

  private scheduleCheck(viewId: number): void {
    const entry = this.entries.get(viewId)
    if (entry === undefined || entry.timer !== null) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.check(viewId)
    }, this.debounceMs)
  }

  private check(viewId: number): void {
    const entry = this.entries.get(viewId)
    if (entry === undefined) return
    let stat
    try {
      stat = statSync(entry.path)
    } catch {
      // Gone or no longer readable. No notification (guidance for deletion is not supported yet; reported as a future task).
      return
    }
    const now: FileStamp = { mtimeMs: stat.mtimeMs, size: Number(stat.size) }
    if (!changed(entry, now)) return
    entry.mtimeMs = now.mtimeMs
    entry.size = now.size
    this.deps.notify(viewId, entry.uri)
  }
}
