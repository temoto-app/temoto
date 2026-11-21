/**
 * Getting the DB encryption key (ARCHITECTURE.md chapter 8 / constraint 11 / PHASE1_BRIEF 3.2).
 *
 * keytar is deprecated, so Electron's standard `safeStorage` is used. No native dependency is added.
 * safeStorage encrypts with a key derived from the OS keychain (macOS: Keychain), so
 * the key itself does not remain in plaintext in the user area.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type { StorageReason } from '@shared/types.js'
import { log, errorFields } from '../../common/logger.js'

const KEY_FILE = 'db.key'
/** Length of the key passed to SQLCipher. As a hex string it is 64 characters. */
const KEY_BYTES = 32

export interface DatabaseKey {
  /** The key exists only when `encrypted`. */
  readonly key: string | null
  /**
   * `encrypted`: safeStorage is usable, so the encrypted DB is placed in a file.
   * `memory-only`: safeStorage is not usable. **Nothing is persisted in plaintext** - following
   * constraint 11, it runs on an in-memory DB in this case, and the UI says it disappears on restart.
   */
  readonly mode: 'encrypted' | 'memory-only'
  /** The reason it degraded to `memory-only` (the text of the renderer's band, 7.4.4). null if `encrypted`. */
  readonly reason: StorageReason | null
}

/** Whether a DB (or WAL) with contents already exists. A 0-byte file has no contents, so it does not count (creating a key is fine). */
function hasDatabaseData(dbFile: string): boolean {
  for (const path of [dbFile, `${dbFile}-wal`]) {
    try {
      if (statSync(path).size > 0) return true
    } catch {
      // Missing or unreadable: go to the next.
    }
  }
  return false
}

/**
 * Retrieves the key. If absent, generates one, seals it with safeStorage, and saves it.
 *
 * In an environment where safeStorage is unusable (Linux with no keyring, etc.), no key is created.
 * "Fall back to a plaintext DB" violates constraint 11, so it is not taken.
 *
 * TODO 1129: even if the key file is missing, if a DB with contents (`dbFile`) already exists, **do not create a key**. A new key cannot
 * open the existing DB (`SQLITE_NOTADB`), and startup kept failing. Also, once the new key is written, even if the original key is found later it has already been overwritten and cannot be restored.
 * As in the undecryptable case, degrade to `memory-only` and tell the user in the band. The existing DB is not deleted (owner decision 2026-11-05).
 */
export function getOrCreateDatabaseKey(userDataDir: string, dbFile: string): DatabaseKey {
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('db.key.unavailable', { reason: 'safeStorage' })
    return { key: null, mode: 'memory-only', reason: 'db-keychain-unavailable' }
  }

  const keyPath = join(userDataDir, KEY_FILE)
  if (existsSync(keyPath)) {
    try {
      const key = safeStorage.decryptString(readFileSync(keyPath))
      log.info('db.key.loaded', {})
      return { key, mode: 'encrypted', reason: null }
    } catch (err) {
      // Undecryptable = the keychain item vanished, or the file is another user's.
      // The existing DB cannot be opened, so degrade rather than recreate (do not silently overwrite).
      log.error('db.key.undecryptable', errorFields(err))
      return { key: null, mode: 'memory-only', reason: 'db-key-undecryptable' }
    }
  }

  if (hasDatabaseData(dbFile)) {
    // Only the key is missing (a partial migration of userData, or a restore where only `db.key` vanished). Degrade without creating or writing anything.
    log.error('db.key.missing', { file: dbFile })
    return { key: null, mode: 'memory-only', reason: 'db-key-missing' }
  }

  const key = randomBytes(KEY_BYTES).toString('hex')
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, safeStorage.encryptString(key), { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  log.info('db.key.created', {})
  return { key, mode: 'encrypted', reason: null }
}
