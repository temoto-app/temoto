/**
 * Initialization of the encrypted SQLite (ARCHITECTURE.md chapter 8).
 *
 * **The PRAGMAs were moved out to `common/db-open.ts`** (P1). Main and the index process now
 * open the same file with two connections, so the way of opening is gathered in one place.
 * What remains here is main-only work: getting the key (`safeStorage`) and migrations.
 * The index process does not run migrations; it only checks `user_version` (3.3).
 */
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { StorageReason } from '@shared/types.js'
import { JOURNAL_SIZE_LIMIT, openDatabaseFile } from '../../common/db-open.js'
import { runMigrations } from '../../common/migrations.js'
import { errorFields, log } from '../../common/logger.js'
import { getOrCreateDatabaseKey } from './key.js'
import { USER_DATA_DB_FILE } from '../../common/app-identity.js'

/** The DB file inside userData. The value lives in `common/app-identity.ts`, whose name decision looks for this file (TODO 1263). */
export const DB_FILE = USER_DATA_DB_FILE

/**
 * The WAL limit (64 MB, P7). **The real definition is in `common/db-open.ts`** - the index process's
 * connection needs the same limit. It is re-exported here only for compatibility.
 */
export { JOURNAL_SIZE_LIMIT }

/** The return of `PRAGMA wal_checkpoint` (better-sqlite3 returns a one-row array). */
interface CheckpointRow {
  readonly busy: number
  readonly log: number
  readonly checkpointed: number
}

/**
 * Truncates the WAL once at startup (P7).
 *
 * `journal_size_limit` **only takes effect at a checkpoint**, so when we start up already
 * holding a huge WAL we must TRUNCATE once ourselves.
 * If `busy` is 1, another connection was reading and it could not be truncated; that is
 * not a failure (it shrinks next time).
 */
export function truncateOversizedWal(
  db: Db,
  file: string,
  limit: number = JOURNAL_SIZE_LIMIT
): void {
  let bytes: number
  try {
    bytes = statSync(`${file}-wal`).size
  } catch {
    // There is no WAL yet (a new DB) or it cannot be read. Do nothing.
    return
  }
  if (bytes <= limit) return

  const started = Date.now()
  const rows = db.pragma('wal_checkpoint(TRUNCATE)') as CheckpointRow[]
  const row = rows[0]
  log.info('db.wal.truncated', {
    bytes,
    limit,
    busy: row?.busy ?? null,
    log: row?.log ?? null,
    checkpointed: row?.checkpointed ?? null,
    ms: Date.now() - started
  })
}

/** SQLite's "the file is damaged / not a database" (better-sqlite3 puts the code on the error; extended codes start with the same name). */
export function isCorruptionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
}

export interface OpenedDatabase {
  readonly db: Db
  readonly mode: 'encrypted' | 'memory-only'
  /** The reason it degraded to `memory-only` (TODO 1129). null if `encrypted`. */
  readonly storageReason: StorageReason | null
  readonly version: number
  /** The file to hand to the index process. null when degraded (cannot be shared). */
  readonly file: string | null
  /** The key to hand to the index process. **Not put in argv / env** (3.3). */
  readonly key: string | null
}

export function openDatabase(userDataDir: string): OpenedDatabase {
  // TODO 1129: if there is no key but an existing DB exists, do not create a key (degrade. The DB is not touched - `file` below is `:memory:`).
  const { key, mode, reason } = getOrCreateDatabaseKey(userDataDir, join(userDataDir, DB_FILE))

  // Degraded mode uses an in-memory DB. better-sqlite3-multiple-ciphers does not accept
  // PRAGMA key on an in-memory / temporary DB
  // ("Setting key not supported for in-memory or temporary databases"), so
  // no key is set in degraded mode. No plaintext remains on disk.
  const file = mode === 'encrypted' ? join(userDataDir, DB_FILE) : ':memory:'
  if (mode === 'encrypted') mkdirSync(userDataDir, { recursive: true })

  let db: Db | null = null
  let version: number
  try {
    db = openDatabaseFile(file, key)

    // Discard the huge WAL left by the previous run, once, here (P7).
    // Before migrations = while nobody has written yet. The index process has not
    // started yet, so at this point no other connection can interfere.
    if (mode === 'encrypted') truncateOversizedWal(db, file)

    version = runMigrations(db)
  } catch (err) {
    // TODO 1306: a damaged file (or a key that does not match it) used to fail the whole bootstrap with no window. Degrade the same way
    // as an unreadable key: the file is not touched, the app runs on memory, and the band offers a restore from a backup.
    if (mode !== 'encrypted' || !isCorruptionError(err)) throw err
    try {
      db?.close()
    } catch {
      // The connection may not be usable at all.
    }
    log.error('db.corrupt', { file, ...errorFields(err) })
    const memory = openDatabaseFile(':memory:', null)
    const memoryVersion = runMigrations(memory)
    log.info('db.opened', { mode: 'memory-only', version: memoryVersion, file: ':memory:' })
    return { db: memory, mode: 'memory-only', storageReason: 'db-corrupt', version: memoryVersion, file: null, key: null }
  }
  log.info('db.opened', { mode, version, file: mode === 'encrypted' ? file : ':memory:' })
  return {
    db,
    mode,
    storageReason: reason,
    version,
    file: mode === 'encrypted' ? file : null,
    key: mode === 'encrypted' ? key : null
  }
}
