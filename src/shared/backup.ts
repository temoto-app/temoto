/**
 * Automatic backup of conversations and settings, and recovery when the DB is broken (TODO 1306, ARCHITECTURE 8.7).
 * The types at the main / renderer boundary.
 *
 * - A backup is the export file of TODO 1088 (`*.aiosdata`, passphrase -> scrypt -> AES-256-GCM), written once a day while idle,
 *   keeping the newest `BACKUP_KEEP` generations. The passphrase is decided once by the user and kept sealed by the OS keychain
 *   (`safeStorage`) in main. **It is never handed back to the renderer.**
 * - The renderer may see the backup folder's path for display (the renderer is not a trust boundary). It never sends a path: the folder
 *   is chosen with main's native dialog.
 */

/** How many generations are kept (owner decision 2026-11-22). */
export const BACKUP_KEEP = 3

/**
 * Automatic backup does not run while any conversation is running, and that is not recorded as a failure. When the newest generation
 * (or, with none, the moment this launch began watching) is this old, the status carries `stale` so the BottomBar can say so
 * (TODO 1331 item 2, owner decision 2026-11-25: 3 days).
 */
export const BACKUP_STALE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Why automatic backup does not run in this launch.
 * - `instance`: a non-default userData (dev:instance, smoke, proxy verification). The real backup folder and keychain are not touched.
 * - `keychain`: the OS keychain (`safeStorage`) is unavailable, so the passphrase cannot be kept and nothing persists anyway.
 */
export type BackupUnsupportedReason = 'instance' | 'keychain'

/**
 * The state of the DB as far as recovery is concerned.
 * - `unknown`: the startup check has not run (yet).
 * - `checking`: the light check (`quick_check`, per table in the index process) is running.
 * - `ok`: the check passed.
 * - `corrupt`: the check found damage. The DB is still open; automatic backup stops so as not to rotate out good generations.
 * - `unopenable`: the DB could not be opened (damaged, or its key cannot be read). The app runs on an in-memory DB.
 * - `unavailable`: the OS keychain is unavailable (nothing can be opened or restored).
 * - `restore-incomplete`: a restore from a backup did not end `restored` (it failed, or the previous launch stopped midway). The DB may
 *   be half-filled: automatic backups and rotation stay stopped until the user restores again or keeps the current DB.
 */
export type DbHealthState = 'unknown' | 'checking' | 'ok' | 'corrupt' | 'unopenable' | 'unavailable' | 'restore-incomplete'

/**
 * Reasons for failure. The renderer's dictionary (`settings.backup.error.<code>`) turns them into sentences. Never thrown.
 * - `unsupported`: see `BackupUnsupportedReason`.
 * - `no-passphrase`: the passphrase has not been decided (automatic backup does not run until it is).
 * - `passphrase-short` / `passphrase-long`: the same rule as export (TODO 1088).
 * - `passphrase-needed`: restoring needs the passphrase (the stored one could not be read, e.g. the keychain item was lost).
 * - `decrypt-failed`: the passphrase does not open the newest backup (or the file is damaged).
 * - `busy`: an export / import / backup is already running.
 * - `too-large`: restoring met a conversation larger than one line of the file may be (TODO 1318: writing has no size limit any more).
 *   A `backup.lastFailure` recorded by 0.102 or older can still say it for a write ("the conversations do not fit"), so its sentence is
 *   worded for both directions (review X of TODO 1318).
 * - `disk-full`: there was not enough free disk space (the backup folder's disk, or the database's when restoring). Nothing is left behind.
 * - `dir-missing`: the chosen folder does not exist (e.g. an external disk that is not connected). It is not created.
 * - `dir-denied`: the chosen folder is refused by the file rules (exclusions).
 * - `unhealthy`: the DB is damaged or not open, so it is not backed up (restore instead).
 * - `no-backup`: there is no backup to restore from.
 * - `not-broken`: restore is offered only when the DB is damaged or cannot be opened.
 * - `interrupted`: the import of a restore started at the previous launch and did not finish.
 * - `io`: reading or writing failed (including a stop for shutdown).
 */
export type BackupFailure =
  | 'unsupported'
  | 'no-passphrase'
  | 'passphrase-short'
  | 'passphrase-long'
  | 'passphrase-needed'
  | 'decrypt-failed'
  | 'busy'
  | 'too-large'
  | 'disk-full'
  | 'dir-missing'
  | 'dir-denied'
  | 'unhealthy'
  | 'no-backup'
  | 'not-broken'
  | 'interrupted'
  | 'io'

export const BACKUP_FAILURES: readonly BackupFailure[] = [
  'unsupported',
  'no-passphrase',
  'passphrase-short',
  'passphrase-long',
  'passphrase-needed',
  'decrypt-failed',
  'busy',
  'too-large',
  'disk-full',
  'dir-missing',
  'dir-denied',
  'unhealthy',
  'no-backup',
  'not-broken',
  'interrupted',
  'io'
]

/** One generation in the backup folder (newest first in `BackupStatus.generations`). */
export interface BackupGeneration {
  readonly fileName: string
  /** The time in the file name (ms). */
  readonly at: number
  readonly bytes: number
}

/** The result of the restore done at this launch (after the restart). null when none was done. */
export type BackupRestoreOutcome =
  | { readonly kind: 'restored'; readonly fileName: string; readonly threads: number; readonly events: number; readonly settings: number }
  | { readonly kind: 'failed'; readonly fileName: string; readonly reason: BackupFailure }

export interface BackupStatus {
  readonly supported: boolean
  readonly unsupportedReason: BackupUnsupportedReason | null
  readonly passphraseSet: boolean
  /** The one-time band "decide a backup passphrase" was closed. */
  readonly noticeDismissed: boolean
  /** The backup folder (absolute path, for display). */
  readonly dir: string
  readonly dirIsDefault: boolean
  readonly running: boolean
  readonly generations: readonly BackupGeneration[]
  /** The last automatic / manual attempt failed after the newest generation. null if none. */
  readonly lastFailure: { readonly at: number; readonly reason: BackupFailure } | null
  readonly health: DbHealthState
  readonly restore: BackupRestoreOutcome | null
  readonly keep: number
  /**
   * Decided in main (the renderer does not read a clock): backups are set up and supported but none has succeeded for `BACKUP_STALE_MS`
   * or more. `days` is the whole days since. null when fresh, when the DB is unhealthy (its own band says so), or when not set up.
   */
  readonly stale: { readonly days: number } | null
  /**
   * What the newest generation could not hold (a conversation's rest after a line hit its size limit, conversations that failed the
   * format check). Counts only. null when nothing was dropped or when the count of the newest generation is unknown.
   */
  readonly skipped: { readonly events: number; readonly threads: number } | null
}

/** The result of an operation. The state itself arrives through `onChanged` (and `status()`). */
export type BackupActionResult =
  | { readonly kind: 'done' }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'failed'; readonly reason: BackupFailure }

/**
 * The result of the light check of the DB (`index.quickCheck`, run per table in the index process). Only table names and counts;
 * SQLite's messages are not carried (they are not needed to decide, and are not logged).
 */
export interface DbQuickCheckResult {
  /** The check ran to the end and found nothing. */
  readonly ok: boolean
  readonly tables: number
  /** Tables (and `sqlite_schema`) where the check reported damage. */
  readonly damaged: readonly string[]
  /** The check stopped midway for shutdown (neither ok nor damaged is meaningful). */
  readonly stopped: boolean
  readonly ms: number
  /** The table that took longest and its time (for measuring on real machines). null when no table was checked. */
  readonly slowest: { readonly table: string; readonly ms: number } | null
}

/** Whether "restore from the newest backup" can be offered. */
export function backupRestorable(status: BackupStatus): boolean {
  return (
    status.supported &&
    (status.health === 'corrupt' || status.health === 'unopenable' || status.health === 'restore-incomplete') &&
    status.generations.length > 0
  )
}
