/**
 * Export and import of threads and settings (TODO 1088, wave 64 bundle A, ARCHITECTURE 8.6). The types at the main / renderer boundary.
 *
 * - One file for taking aios data to another PC. The contents are encrypted with a passphrase (scrypt -> AES-256-GCM).
 * - The scope is only threads (the saved timelines of live rows) and the values of the settings editor (owner decision 2026-11-02).
 *   Plugin state, the audit log, credentials and the index are not included.
 * - **File paths are not passed to the renderer.** main opens the save / load dialogs, and what the renderer receives is only
 *   the display file name and the counts. The renderer passes only the passphrase (main re-validates the length).
 */

/** The minimum passphrase length for export (import does not care about length, so that files can be read even if the writer's rule changes). */
export const DATA_TRANSFER_MIN_PASSPHRASE = 8
/** The maximum passphrase length (the upper limit of the IPC value main accepts). */
export const DATA_TRANSFER_MAX_PASSPHRASE = 1024

/** The extension (for the dialog filter and the default name). */
export const DATA_TRANSFER_EXTENSION = 'aiosdata'

/**
 * The reasons for failure. The renderer's dictionary (`settings.transfer.error.<code>`) turns them into sentences.
 * - `passphrase-empty`: the passphrase is empty (on import. Import does not care about length, so it does not say "too short").
 * - `passphrase-short` / `passphrase-long`: the export passphrase is too short / too long.
 * - `decrypt-failed`: the passphrase is wrong, or the file is corrupt or tampered with (authenticated encryption cannot tell these apart).
 * - `not-export-file`: not an aios export file (the leading mark differs, or the header cannot be read).
 * - `too-new`: a file written by a newer aios (a format version this version does not know).
 * - `invalid-file`: decryption worked but the shape of the contents is wrong (a type violation). Nothing is written.
 * - `too-large`: the file, contents or count exceeds the limit. Nothing is written.
 * - `io`: reading or writing the file failed.
 * - `busy`: another export / import is running.
 */
export type DataTransferFailure =
  | 'passphrase-empty'
  | 'passphrase-short'
  | 'passphrase-long'
  | 'decrypt-failed'
  | 'not-export-file'
  | 'too-new'
  | 'invalid-file'
  | 'too-large'
  | 'io'
  | 'busy'

export const DATA_TRANSFER_FAILURES: readonly DataTransferFailure[] = [
  'passphrase-empty',
  'passphrase-short',
  'passphrase-long',
  'decrypt-failed',
  'not-export-file',
  'too-new',
  'invalid-file',
  'too-large',
  'io',
  'busy'
]

/**
 * Where an import was refused (counted from 1). `thread` is which thread, and `event` is which event in that thread
 * (absent if the violation is in a thread field). The renderer adds it after the reason sentence.
 */
export interface DataTransferFailureAt {
  readonly thread: number
  readonly event?: number
}

export interface DataTransferFailed {
  readonly kind: 'failed'
  readonly reason: DataTransferFailure
  /** On import, where in the file it was refused (only for violations of the contents' shape and for the count limit). */
  readonly at?: DataTransferFailureAt
}

export type DataExportResult =
  | { readonly kind: 'canceled' }
  | DataTransferFailed
  | {
      readonly kind: 'done'
      /** The file name for display (the path is not passed). */
      readonly fileName: string
      readonly threads: number
      readonly events: number
      readonly settings: number
      /**
       * The number of threads / events not exported because they do not pass the import validation (`format.ts`). So that a file
       * we wrote can always be read, export goes through the same validation as import (fields that can be fixed are fixed, such as cutting a title that is too long; ones that cannot are dropped and counted).
       */
      readonly skippedThreads: number
      readonly skippedEvents: number
    }

export type DataImportResult =
  | { readonly kind: 'canceled' }
  | DataTransferFailed
  | {
      readonly kind: 'done'
      readonly fileName: string
      /** The number of threads added (all with new ids. Existing threads are not changed). */
      readonly threads: number
      readonly events: number
      /** The number of rows dropped, for example for kinds this version does not know. */
      readonly skippedEvents: number
      /** The number of settings changed (ones with the same value are not counted). */
      readonly settings: number
      /** The number of settings dropped for unknown names or unusable values. */
      readonly skippedSettings: number
    }
