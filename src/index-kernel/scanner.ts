/**
 * Directory scan (ARCHITECTURE.md 4.4 / PHASE1_BRIEF 3.3).
 *
 * What must be kept:
 * - **Access denial is not an error: it is skipped and recorded.** `~/Desktop`, `~/Documents` and
 *   `~/Downloads` are protected by TCC, and the OS shows a dialog at the first access.
 *   A scan that stopped midway would leave a broken listing, so denials are tallied and explained together later.
 * - **Loops and duplicates are resolved by inode.** `~/Library/Containers/<app>/Data/Documents` may be
 *   a symlink to `~/Documents`. A directory symlink gets only a row and the scan does not descend into it
 *   (TODO 924: the contents come in under the real path). Duplicate inodes are looked for among real directories (firmlinks, etc.).
 * - **It yields per batch** so that the caller can group them into a transaction
 *   (writes to the encrypted DB cost +77% over plaintext; no INSERT one at a time).
 */
import { opendir, lstat, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ExclusionRules } from '../common/exclusions.js'
import { classify } from '../common/exclusions.js'
import { foldPath } from '../common/uri.js'

export interface ScannedEntry {
  readonly path: string
  readonly name: string
  readonly parentPath: string
  readonly isDirectory: boolean
  readonly size: number
  readonly mtimeMs: number
  readonly dev: number
  readonly ino: number
  /**
   * A file with no real content (iCloud / OneDrive not downloaded, `blocks === 0`). It goes into the row's version, so that even when
   * a download does not change mtime and size, the version changes and the body build re-takes it (TODO 921).
   */
  readonly dataless: boolean
}

/** Whether the `lstat` result is a file with no real content (an undownloaded placeholder) (TODO 921, the same judgment as `extractFile`). */
export function isDataless(stats: { isFile(): boolean; size: number; blocks: number }): boolean {
  return stats.isFile() && stats.size > 0 && stats.blocks === 0
}

export interface ScanDenial {
  readonly path: string
  readonly code: string
}

export interface ScanCounters {
  seen: number
  excluded: number
  denied: number
  /** Number of directories not descended into because their mtime is the same as last time (incremental scan, 6.2.2). */
  pruned: number
}

export interface WalkOptions {
  /** Items per batch. It becomes the transaction unit on the DB side. */
  readonly batchSize?: number
  /** Where to notify about denied directories. */
  readonly onDenied?: (denial: ScanDenial) => void
  /** For interruption. Returning true cuts the scan off. */
  readonly shouldStop?: () => boolean
  /**
   * Hook before descending into a directory. Returning true skips that tree.
   * Since Phase 3 scans the whole PC, **roots already scanned**
   * (the home directory first and then `/`) and **network volumes** (4.4.2)
   * are dropped here. It is a different axis from the exclusion list, so it is not mixed into `classify`.
   */
  readonly shouldSkipDirectory?: (path: string) => boolean
  /**
   * Hook right before descending into a directory (incremental scan, 6.2.2). Returning true
   * **records the row but does not open the contents** (`shouldSkipDirectory` does not even make the row).
   * The caller decides by "is it the same as the previous row's mtime".
   * It is also the place where "directories whose mtime differs from last time" are remembered.
   */
  readonly shouldPrune?: (path: string, mtimeMs: number) => boolean
  /**
   * Finished opening a directory and queueing all its direct children into `batch` (item 250). The direct rows reach the DB in
   * **the batch yielded after this**, so the caller regards it as fully walked "once it has finished writing the next batch it receives".
   * Not called for a directory that could not be opened (denied, etc.).
   */
  readonly onDirectoryDone?: (path: string) => void
}

/** The identity of a directory is judged by (dev, ino), to reject revisits via symlinks. */
function identity(dev: number, ino: number): string {
  return `${dev}:${ino}`
}

const DENIAL_CODES = new Set(['EACCES', 'EPERM', 'EROFS'])

/**
 * Scans below `root` breadth-first and returns `ScannedEntry` in batches.
 * `root` itself is not returned (the caller makes the root row).
 */
export async function* walk(
  root: string,
  rules: ExclusionRules,
  counters: ScanCounters,
  options: WalkOptions = {}
): AsyncGenerator<readonly ScannedEntry[]> {
  const batchSize = options.batchSize ?? 2000
  const visited = new Set<string>()
  const queue: string[] = [root]

  try {
    const rootStat = await lstat(root)
    visited.add(identity(rootStat.dev, rootStat.ino))
  } catch {
    return
  }

  let batch: ScannedEntry[] = []

  while (queue.length > 0) {
    if (options.shouldStop?.() === true) break
    const dir = queue.shift() as string

    let names: { name: string; isSymlink: boolean }[]
    try {
      const handle = await opendir(dir)
      names = []
      for await (const dirent of handle) {
        names.push({ name: dirent.name, isSymlink: dirent.isSymbolicLink() })
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN'
      if (DENIAL_CODES.has(code)) {
        counters.denied += 1
        options.onDenied?.({ path: dir, code })
      }
      continue
    }

    for (const { name, isSymlink } of names) {
      const full = join(dir, name)

      let stats
      try {
        // A symlink is captured with lstat, and only for a directory symlink is the real target looked at.
        // A file symlink's target is not followed (to avoid double counting).
        stats = await lstat(full)
        if (isSymlink) {
          const resolved = await realpath(full).catch(() => null)
          if (resolved === null) continue
          const target = await lstat(resolved)
          if (!target.isDirectory()) continue
          // **The real path is also run through the exclusion rules again** (4.4.2 "external storage").
          // Even if a symlink under the home directory points at `/Volumes/<disk>` or `~/.ssh`,
          // we must not descend merely because the logical path looks fine. The same idea as fs-policy's
          // "re-check after realpath" is placed on the scan side too.
          if (classify(resolved, basename(resolved), true, rules).excluded) {
            counters.excluded += 1
            continue
          }
          stats = target
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN'
        if (DENIAL_CODES.has(code)) {
          counters.denied += 1
          options.onDenied?.({ path: full, code })
        }
        continue
      }

      const isDirectory = stats.isDirectory()
      if (!isDirectory && !stats.isFile()) continue

      if (classify(full, name, isDirectory, rules).excluded) {
        counters.excluded += 1
        continue
      }

      if (isDirectory && isSymlink) {
        // **A directory symlink gets only a row and the scan does not descend into it** (TODO 924). It is breadth-first, so if a symlink
        // at a shallow level (`~/a -> ~/x/y`) takes the inode first, the row of the real `~/x/y` is not made, the deep scan's
        // `removeStale` removes the real side's row, and it also vanished from the tree. The contents come in under the real path (if the real path is inside
        // the scan scope). This matches the watch diff not following symlinks either (TODO 849).
        if (options.shouldSkipDirectory?.(full) === true) continue
      } else if (isDirectory) {
        const id = identity(stats.dev, stats.ino)
        if (visited.has(id)) continue
        visited.add(id)
        if (options.shouldSkipDirectory?.(full) === true) continue
        // Even when pruned, the row itself is recorded below (it has not vanished from the parent's listing).
        if (options.shouldPrune?.(full, stats.mtimeMs) === true) counters.pruned += 1
        else queue.push(full)
      }

      counters.seen += 1
      batch.push({
        path: full,
        name,
        parentPath: dir,
        isDirectory,
        size: isDirectory ? 0 : stats.size,
        mtimeMs: stats.mtimeMs,
        dev: stats.dev,
        ino: stats.ino,
        dataless: isDataless(stats)
      })

      if (batch.length >= batchSize) {
        yield batch
        batch = []
      }
    }
    options.onDirectoryDone?.(dir)
  }

  if (batch.length > 0) yield batch
}

/** Makes the root row. Used when the scan target itself should also appear in the listing. */
export async function rootEntry(path: string): Promise<ScannedEntry | null> {
  try {
    const stats = await lstat(path)
    const name = path.slice(path.lastIndexOf('/') + 1) || path
    return {
      path,
      name,
      parentPath: '',
      isDirectory: stats.isDirectory(),
      size: stats.isDirectory() ? 0 : stats.size,
      mtimeMs: stats.mtimeMs,
      dev: stats.dev,
      ino: stats.ino,
      dataless: isDataless(stats)
    }
  } catch {
    return null
  }
}

export { foldPath }
