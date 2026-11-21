/**
 * Types of data that cross the main / renderer boundary (IMPLEMENTATION_BRIEF 7).
 * No `any`. Data of a shape not defined here does not go through the contextBridge.
 */
import type { BuildInfo, RuntimeInfo } from './build-info.js'
import { isFileSortOrder, type FileSortOrder } from './file-sort.js'

/** One row of a file list. The renderer gets only the URI, not the path. */
export interface FileEntry {
  /** In `file:///...` form. The only identifier the renderer handles. */
  readonly uri: string
  /** URI of the parent directory. null at the root. */
  readonly parentUri: string | null
  readonly name: string
  readonly isDirectory: boolean
  /** Size in bytes. 0 for a directory. */
  readonly size: number
  readonly mtimeMs: number
  /** Lowercase extension (no dot). Empty string if none. */
  readonly ext: string
  /**
   * The kind, if this is a shortcut root at the top of the Files tree (TODO 520). The renderer looks up the display name via i18n
   * (`files.shortcut.<kind>`). Absent for a non-shortcut root and for child rows.
   */
  readonly shortcut?: FolderShortcut
  /**
   * A symlink row (TODO 558). The Files tree adds an arrow mark after the name. `isDirectory` / `size` / `mtimeMs` are
   * those of the link target. Only the listing (`fs.listDirectory`) sets it; index rows and search results never have it.
   */
  readonly symlink?: true
  /**
   * Id of the index document (`documents.id`, rowid). Only filename search results (`fs.searchFiles*`) set it (TODO 1158: so the gateway's
   * `searchFiles` can return a form that can be passed to `getDocument`). List rows never have it.
   */
  readonly documentId?: number
}

/**
 * Shortcuts to standard macOS folders placed at the top of the Files tree (TODO 520). The order is this order.
 * `trash` (`~/.Trash`) is **view-only**: listing and viewer reads work, but it is not used for indexing, writing or attachments.
 * `tmp` (`/tmp`, TODO 561) is **not indexed but can be opened**, and writing is allowed too (owner decision).
 */
export const FOLDER_SHORTCUTS = [
  'downloads',
  'desktop',
  'applications',
  'movies',
  'documents',
  'trash',
  // TODO 561: `/tmp` is not indexed but can be opened (read and write). Listings read it on the spot, not from the index.
  'tmp'
] as const

export type FolderShortcut = (typeof FOLDER_SHORTCUTS)[number]

/**
 * Shortcuts that are not indexed (they do not offer "search in this folder"): the trash of TODO 520 and `/tmp` of TODO 561.
 */
export function isUnindexedShortcut(kind: FolderShortcut | undefined): boolean {
  return kind === 'trash' || kind === 'tmp'
}

/** Shortcuts that are view-only (not used for writing, creating, or as a search scope) (TODO 520). */
export function isReadOnlyShortcut(kind: FolderShortcut | undefined): boolean {
  return kind === 'trash'
}

/**
 * Response of a filename search (ARCHITECTURE.md 6.6).
 *
 * The promise is **never to drop results silently**, so along with the top N (`entries`) it always returns
 * the total hit count and the reason for any truncation. Same vocabulary as qlm's `total` / `truncated` /
 * `scanTruncated`.
 */
export interface FileSearchResult {
  /** Top N, in rank order. Only URIs and names reach the renderer. */
  readonly entries: readonly FileEntry[]
  /** Total number of matches (exact up to the limit; beyond that `scanTruncated` is set). */
  readonly total: number
  /** The total is larger than the number returned. */
  readonly truncated: boolean
  /** The scan itself was cut off by a timeout or count limit (ranking does not cover all candidates). */
  readonly scanTruncated: boolean
  /**
   * Section inside the current working folder (item 100). null if no cwd was passed or it is not in the index.
   * **The main body (`entries` / `total` ...) is the whole search minus the inside of cwd**, so the same file
   * never appears in both. The renderer lists the cwd section first, under a separate heading.
   */
  readonly cwd: FileSearchSection | null
  /**
   * There was a term containing an uppercase letter, and that term was matched case-sensitively (smart case, TODO 291).
   * The renderer shows an `Aa` badge to the right of the search field. Absent is the same as false.
   */
  readonly caseSensitive?: boolean
  /** Discarded because typing moved on. The result must not be shown on screen. */
  readonly cancelled: boolean
  readonly tookMs: number
}

/** One section of a filename search (item 100). Same vocabulary as the body of `FileSearchResult`. */
export interface FileSearchSection {
  /** `file://` URI of the working folder the section is based on (shown in the heading). */
  readonly uri: string
  readonly entries: readonly FileEntry[]
  readonly total: number
  readonly truncated: boolean
  readonly scanTruncated: boolean
}

/**
 * One external storage device (ARCHITECTURE.md 4.4.2 "external storage").
 * Only the URI and name go to the renderer; the mount path itself is not exposed.
 */
export interface VolumeEntry {
  /** `file://` URI of the mount point. Allow / revoke refer to it. */
  readonly uri: string
  readonly name: string
  /** Whether it is mounted now. An allowed but unmounted device is also listed. */
  readonly mounted: boolean
  /** Whether it is allowed in settings. */
  readonly allowed: boolean
  /** Allowed, but the UUID of the mounted disk differs from the remembered one (a different disk). */
  readonly uuidMismatch: boolean
}

export interface DirectoryListing {
  readonly uri: string
  readonly entries: readonly FileEntry[]
  /** true when it was read directly from the disk rather than from a scan. */
  readonly live: boolean
  /**
   * Why the contents could not be returned: the choke point (`FsService.assertAllowed`) refused (item 333 observation, wave 18).
   * A bare code from `shared/reason.ts` (same shape as `DirectoryPick.reason`). null if not refused.
   * **Main's IPC handler does not throw here**: throwing makes `ipcMain.handle`'s default mechanism
   * print an uncaught stack to stderr (`Error occurred in handler for 'aios:fs/list': …`). Instead it returns
   * `entries: []` plus this reason as values (same decision as `DirectoryPick.reason` of `pickDirectory`).
   */
  readonly reason: string | null
}

/**
 * One directory whose access was denied during a scan (`scan_denials`, item 84).
 * Material for the persistent TCC banner (12.8). Nothing is displayed yet; only the reader (`IndexClient.recentDenials`) exists.
 */
export interface ScanDenial {
  readonly uri: string
  /** Reason code for the denial, such as `EACCES` / `EPERM`. */
  readonly code: string
  /** Time of the most recent denial. */
  readonly seenAt: number
}

/** Scan progress. The first run covers everything under home, so it is shown in the UI (3.3 / chapter 8). */
export interface ScanStatus {
  readonly state: 'idle' | 'scanning' | 'done' | 'error'
  /** Number of entries seen by the scan (excluding excluded ones). */
  readonly seen: number
  /** Number of rows written to the DB. */
  readonly indexed: number
  /** Number of directories skipped by the exclusion list. */
  readonly excluded: number
  /** Number of directories skipped because access was denied (TCC / permissions). */
  readonly denied: number
  /** URIs of denied locations kept for guidance (only the first few). */
  readonly deniedExamples: readonly string[]
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly message: string | null
  /**
   * Completion time of the previous full scan that **ran to completion**. An interrupted run does not count.
   * null if none has ever completed.
   */
  readonly lastFullScanAt: number | null
  /**
   * Whether this launch skipped the full scan (within the threshold, and neither the exclusion rules nor the set of roots changed).
   * When skipped, only watching is set up. A manual rescan sets it back to false.
   */
  readonly skipped: boolean
  /**
   * Time when the full scan next expires (6.2.2). While resident, it waits for idle and runs from here.
   * null if already expired or undeterminable. Shown because a silent run would leave no explanation for the slowdown.
   */
  readonly nextFullScanAt: number | null
  /**
   * TODO 805: deadline (ms) until which scanning and watching of the protected folders (Desktop / Documents / Downloads) is deferred.
   * null if not deferred. The settings "Protected folders" section shows labels for "not included until ..." and "include now".
   */
  readonly tccDeferredUntil: number | null
}

export type FileChangeType = 'create' | 'update' | 'delete'

export interface FileChange {
  readonly type: FileChangeType
  readonly uri: string
  readonly parentUri: string | null
  /** null for delete. */
  readonly entry: FileEntry | null
}

/**
 * A batch of watch events. @parcel/watcher emits many events at once, so
 * they are not sent one message per event but grouped at about 16 ms (ARCHITECTURE.md 5.1 / PHASE1 3.3).
 */
export interface FileChangeBatch {
  readonly changes: readonly FileChange[]
  readonly at: number
}

/** Read-only contents passed to the viewer. The viewer itself does no I/O (PHASE1 3.5). */
export type ViewerResource =
  | {
      readonly kind: 'text'
      readonly text: string
      /** true if it was cut down to fit a limit. */
      readonly truncated: boolean
      readonly size: number
      readonly mtimeMs: number
      /**
       * Readable but not saveable (item 254: the `.md` of auto memory is a read-only exception).
       * If true, ViewerPane does not allow editing. Omitted means false.
       */
      readonly readOnly?: boolean
    }
  | {
      readonly kind: 'binary'
      /** `aios-res://...`. Served by main's protocol handler. */
      readonly resourceUrl: string
      readonly size: number
      readonly mtimeMs: number
      /**
       * Can accept a draft of cell values and save it (TODO 1212 stage 1). Main sets it only for an extension whose viewer declared `cellEdits` and when the write
       * check passes (no exceptions). If true, the host keeps the draft (a list of edits) and shows the save entry point.
       */
      readonly cellEdits?: boolean
    }
  | { readonly kind: 'error'; readonly message: string }

export interface TextWriteResult {
  readonly ok: boolean
  /** mtime after the write. Used for conflict detection. */
  readonly mtimeMs: number
  readonly size: number
  /**
   * Reason when ok=false. `locked` / `unsupported` apply only to saving cell values (TODO 1212 stage 1): the draft includes cells that cannot be edited
   * (formulas, inside a merge, signed...) / the format is not supported (encrypted, a broken zip, a malformed draft).
   */
  readonly reason: 'conflict' | 'denied' | 'not-found' | 'too-large' | 'io' | 'locked' | 'unsupported' | null
}

/** Supported OSes. Enumerated in shared so as not to depend on `node:os`. */
export type Platform = 'darwin' | 'win32' | 'linux'

/**
 * Why the DB degraded to `memory-only` (TODO 1129, ARCHITECTURE chapter 8). Every one is a member of `REASON_CODES`.
 * - `db-keychain-unavailable`: safeStorage (the OS keychain) is unusable.
 * - `db-key-undecryptable`: the key file exists but cannot be decrypted (the keychain item is gone, or it is another user's file).
 * - `db-key-missing`: there is no key file but there is a DB with contents (a key is not created: creating one would make the existing DB permanently unopenable).
 */
export type StorageReason = 'db-keychain-unavailable' | 'db-key-undecryptable' | 'db-key-missing'

/** Environment info passed to the renderer at startup. */
export interface AppInfo {
  readonly productName: string
  /**
   * TODO 1263: this machine's data name (`Temoto`, or `aios` where the legacy userData exists). The keychain item (`<name> Safe Storage`),
   * `~/<name>/scratch` and `~/Library/Logs/<name>/` take it, so the text that mentions them uses it.
   */
  readonly dataName: string
  readonly version: string
  readonly homeUri: string
  /**
   * Protection state of the DB (ARCHITECTURE.md chapter 8 / constraint 11).
   * `encrypted`: encrypted with a key derived from the OS keychain.
   * `memory-only`: a degraded mode that does not persist, because safeStorage is unusable.
   */
  readonly storage: 'encrypted' | 'memory-only'
  /**
   * Why it degraded to `memory-only` (TODO 1129). null if `encrypted`. The renderer turns it into text via `reason.<code>` (7.4.4).
   */
  readonly storageReason: StorageReason | null
  readonly platform: Platform
  /**
   * If launched with a non-default `userData` (`--user-data-dir`, plan A, item 192), the path of that
   * directory. null for the default (the renderer shows no band). It exists to **tell a proxy-verification
   * duplicate window apart from the real one**, added after TODO 186 (a mix-up that led to a force push).
   */
  readonly userDataLabel: string | null
  /**
   * Whether it was started with `AIOS_DISABLE_AGENT=1` (items 186 / 192). A value so the band (shown when `userDataLabel` is
   * not null) can also say that sending is disabled. It can be set independently of a non-default userData (a development use of running a worktree build
   * with `--user-data-dir` and deliberately trying sending too is not blocked; this is why plan C of TODO 192 was not adopted).
   */
  readonly agentDisabled: boolean
  /** Build identity (TODO 316): version, commit, dirty, build time. Shown in the settings "About" and in a corner of the BottomBar. */
  readonly build: BuildInfo
  /** Versions of Electron / Chromium / Node.js / V8 / the OS (TODO 316). */
  readonly runtime: RuntimeInfo
}

/**
 * How a listing (`fs.listDirectory`) is presented (TODO 261, wave 15 bundle D). This is **display only**; it does not change
 * what is indexed, searched or scanned.
 */
export interface ListDirectoryOptions {
  /** Whether to also return entries that start with ".". true if absent (return everything, same as existing callers). */
  readonly showHidden?: boolean
  /**
   * URIs to return even when hidden (along with their ancestors). So that when the working folder or a file opened in the viewer is inside a hidden folder,
   * the path leading to it is not removed. Ones not directly under the listed directory are ignored.
   */
  readonly keep?: readonly string[]
  /**
   * Order of children (TODO 872). `'name'` if absent (same as existing callers). Directories always come first in name order;
   * `'modified'` puts only files in newest-modified-first order (ties by name). Main adds the settings value and passes it to the index process.
   */
  readonly sortOrder?: FileSortOrder
}

/** Limits of `ListDirectoryOptions.keep` (count / length of one entry). Checked in both main and the index process. */
export const LIST_KEEP_MAX = 32
export const LIST_KEEP_MAX_LENGTH = 4096

/**
 * Narrow an incoming value down to `ListDirectoryOptions` (TODO 261). It comes from the renderer / RPC, so
 * the type is not trusted. `showHidden` is true (return everything) unless it is a boolean; `keep` keeps only strings, up to the limit.
 */
export function asListDirectoryOptions(value: unknown): ListDirectoryOptions {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const showHidden = record['showHidden']
  const keep = record['keep']
  const sortOrder = record['sortOrder']
  return {
    ...(typeof showHidden === 'boolean' ? { showHidden } : {}),
    ...(isFileSortOrder(sortOrder) ? { sortOrder } : {}),
    ...(Array.isArray(keep)
      ? {
          keep: keep
            .filter(
              (item): item is string =>
                typeof item === 'string' && item !== '' && item.length <= LIST_KEEP_MAX_LENGTH
            )
            .slice(0, LIST_KEEP_MAX)
        }
      : {})
  }
}
