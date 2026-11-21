/**
 * Where the encrypted SQLite is opened (ARCHITECTURE.md chapter 8). **PRAGMAs only**;
 * fetching the key (`safeStorage`) and migrations are not done here.
 *
 * With P1, main and the index process open the same file through **two connections**,
 * so "how to open" is gathered in one place. The caller brings the key (main uses
 * `db/key.ts`; the index process receives it in the `open` message).
 *
 * Measurement (spike 11b): encryption costs +7% on reads, +5% in size, **+77% on writes**.
 * The first scan is hundreds of thousands of INSERTs, so callers must always batch them
 * in a transaction (PHASE1_BRIEF 3.2).
 */
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'

/**
 * Wait time while the other connection is writing. **Needed since there are two connections**:
 * if main writes `app_settings` while the index process is writing, it gets
 * `SQLITE_BUSY`, but with WAL waiting gets it through.
 */
export const BUSY_TIMEOUT_MS = 10_000

/**
 * WAL size limit (64 MB, P7).
 *
 * **The default is -1 = unlimited**, and SQLite does not shrink the WAL file even after a checkpoint. On a real machine,
 * the trace of a run that rewrote the whole index in one transaction (FTS5 crisismerge) stayed
 * and `aios.db-wal` remained at **1.5 GB**.
 *
 * It is placed here, not in `db/index.ts`, so that it applies to **both connections** - the index
 * process is the one that grows the WAL, so setting it only in main would be pointless.
 * The limit does not mean "a transaction fails if it exceeds this"; the excess is
 * just discarded at the next checkpoint.
 */
export const JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024

/**
 * Opens `file` and applies the PRAGMAs. For `:memory:`, do not pass a key -
 * better-sqlite3-multiple-ciphers does not accept `PRAGMA key` on in-memory / temporary
 * DBs ("Setting key not supported for in-memory or temporary databases").
 */
export function openDatabaseFile(file: string, key: string | null): Db {
  const db = new Database(file, { timeout: BUSY_TIMEOUT_MS })
  if (key !== null) db.pragma(`key='${key}'`)

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  // Cache size aimed at bulk INSERTs during a scan (about 64 MB).
  db.pragma('cache_size = -65536')
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
  // Truncate the WAL to the limit (P7). Put it **after `journal_mode`**
  // (SQLite silently ignores it when not in WAL).
  db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT}`)
  return db
}
