/**
 * Getting the DB encryption key (ARCHITECTURE.md chapter 8 / constraint 11 / PHASE1_BRIEF 3.2).
 *
 * keytar is deprecated, so Electron's standard `safeStorage` is used. No native dependency is added.
 * safeStorage encrypts with a key derived from the OS keychain (macOS: Keychain), so
 * the key itself does not remain in plaintext in the user area.
 *
 * TODO 1341 item 8 (ARCHITECTURE 8.2): an existing `db.key` is read with `safeStorage.decryptStringAsync`, which on macOS reads the
 * keychain on a worker thread, so a keychain dialog no longer blocks the main thread. Writing stays on the synchronous entry point
 * (`encryptString`): Electron documents only that `decryptStringAsync` reads what `encryptString` wrote, and an older build that knows
 * only the synchronous entry point must still read the file after a downgrade. Trouble with the asynchronous read falls back to the
 * synchronous read of before (`getOrCreateDatabaseKey`), never to making a new key - except (wave 107 review Y1) when the keychain
 * refused (macOS) or the launch is being abandoned: then the synchronous read is not tried, since it would ask the same question again
 * with the main thread blocked.
 *
 * TODO 1344: the synchronous calls go through `../keychain/sync.ts` (the one file to delete for Electron 46). Creating `db.key` stays
 * synchronous on Electron 44 on purpose: the key opens the whole DB, and only the synchronous-write / asynchronous-read direction is
 * documented, so a build that reads only synchronously (0.106 and older) keeps reading a key this build creates. The plugin
 * credentials and the backup passphrases moved to the asynchronous side (`../keychain/keychain.ts`, same refusal rules as here).
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type { StorageReason } from '@shared/types.js'
import { log, errorFields } from '../../common/logger.js'
import { isMac } from '../../common/os/platform.js'
import { KEYCHAIN_REFUSED_MESSAGE, isKeychainRefusal } from '../keychain/keychain.js'
import { syncAvailable, syncOpen, syncSeal, type SyncSafeStorage } from '../keychain/sync.js'

export { KEYCHAIN_REFUSED_MESSAGE }

export const KEY_FILE = 'db.key'
/** Length of the key passed to SQLCipher. As a hex string it is 64 characters. */
const KEY_BYTES = 32
/** The shape every key this app ever wrote has (Phase 1 on): `KEY_BYTES` random bytes as lower-case hex. */
const KEY_SHAPE = new RegExp(`^[0-9a-f]{${KEY_BYTES * 2}}$`)

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

/**
 * The part of `safeStorage` the key uses. The default is Electron's; tests pass fakes (slow, failing, missing asynchronous entry point).
 * `decryptStringAsync` is optional on purpose: without it the synchronous read is used.
 */
export interface KeySealer extends SyncSafeStorage {
  decryptStringAsync?: (encrypted: Buffer) => Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>
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
 * Retrieves the key synchronously. If absent, generates one, seals it with safeStorage, and saves it.
 *
 * In an environment where safeStorage is unusable (Linux with no keyring, etc.), no key is created.
 * "Fall back to a plaintext DB" violates constraint 11, so it is not taken.
 *
 * TODO 1129: even if the key file is missing, if a DB with contents (`dbFile`) already exists, **do not create a key**. A new key cannot
 * open the existing DB (`SQLITE_NOTADB`), and startup kept failing. Also, once the new key is written, even if the original key is found later it has already been overwritten and cannot be restored.
 * As in the undecryptable case, degrade to `memory-only` and tell the user in the band. The existing DB is not deleted (owner decision 2026-11-05).
 *
 * On macOS this blocks the main thread for as long as a keychain dialog is up. The launch uses `loadDatabaseKey`, which comes here only
 * when there is no key file yet (the first launch) or when the asynchronous read did not give a key for a reason other than a refusal
 * of the keychain (and the launch is not being abandoned).
 */
export function getOrCreateDatabaseKey(userDataDir: string, dbFile: string, sealer: KeySealer = safeStorage): DatabaseKey {
  if (!syncAvailable(sealer)) {
    log.warn('db.key.unavailable', { reason: 'safeStorage' })
    return { key: null, mode: 'memory-only', reason: 'db-keychain-unavailable' }
  }

  const keyPath = join(userDataDir, KEY_FILE)
  if (existsSync(keyPath)) {
    try {
      const key = syncOpen(sealer, readFileSync(keyPath))
      log.info('db.key.loaded', { via: 'sync' })
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
  writeFileSync(keyPath, syncSeal(sealer, key), { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  log.info('db.key.created', {})
  return { key, mode: 'encrypted', reason: null }
}

/**
 * Why the asynchronous read gave no key (logged as a code only; never the value). `refused` = the OS keychain did not hand out its
 * password (the user clicked Deny, or the keychain failed); every other miss may still be read by the synchronous entry point.
 */
type AsyncMiss = 'unsupported' | 'unreadable' | 'failed' | 'shape' | 'refused'

/**
 * Unseals `db.key` with the asynchronous entry point. Returns the key, or the reason it could not (then the caller decides whether the
 * synchronous read may try). Never throws, never writes, never deletes: a failure here says nothing about whether the key is lost.
 */
async function unsealAsync(keyPath: string, sealer: KeySealer): Promise<{ readonly key: string } | { readonly miss: AsyncMiss }> {
  if (typeof sealer.decryptStringAsync !== 'function') return { miss: 'unsupported' }
  let sealed: Buffer
  try {
    sealed = readFileSync(keyPath)
  } catch {
    // The synchronous read reads it again and says why (`db-key-undecryptable`), as before.
    return { miss: 'unreadable' }
  }
  try {
    const { result, shouldReEncrypt } = await sealer.decryptStringAsync(sealed)
    // Only the shape this app writes is taken; anything else goes to the synchronous read, which decides as it always did.
    if (typeof result !== 'string' || !KEY_SHAPE.test(result)) return { miss: 'shape' }
    // `shouldReEncrypt` is noted but never acted on: the file is written by the synchronous entry point only (macOS has one provider,
    // so it is false there).
    log.info('db.key.loaded', { via: 'async', reencrypt: shouldReEncrypt === true })
    return { key: result }
  } catch (err) {
    log.warn('db.key.async.failed', errorFields(err))
    return { miss: isKeychainRefusal(err) ? 'refused' : 'failed' }
  }
}

/** How the loader treats a refusal of the keychain (`refused`). */
export interface DatabaseKeyLoaderOptions {
  /**
   * true: a refusal is final for this launch - no synchronous read asks again (it would show the same dialog a second time, with the
   * main thread blocked). The default is macOS only, where the meaning of the rejection was read in the source (see
   * `KEYCHAIN_REFUSED_MESSAGE`); elsewhere a refusal falls back to the synchronous read as before.
   */
  readonly refusalIsFinal?: boolean
}

/** What one launch tells the loader. */
export interface DatabaseKeyRequest {
  /**
   * Whether the launch is being abandoned (a quit began). Checked before any synchronous read: once it is true, no keychain is read on
   * the main thread (a dialog there would also stop the quit's own time limit). Must stay true once true.
   */
  readonly abandoned?: () => boolean
}

/** No key, and nothing read, written or deleted. The DB is not opened with it (memory only, the same as a keychain that gave nothing). */
const NO_KEY_FROM_KEYCHAIN: DatabaseKey = { key: null, mode: 'memory-only', reason: 'db-keychain-unavailable' }

async function readDatabaseKey(
  userDataDir: string,
  dbFile: string,
  sealer: KeySealer,
  options: Required<DatabaseKeyLoaderOptions>,
  request: DatabaseKeyRequest
): Promise<DatabaseKey> {
  const abandoned = (): boolean => request.abandoned?.() === true
  const keyPath = join(userDataDir, KEY_FILE)
  // A launch abandoned before the key was asked for reads nothing (`openAfterKey` sees the same flag and opens nothing).
  if (abandoned()) {
    log.info('db.key.abandoned', { at: 'start' })
    return NO_KEY_FROM_KEYCHAIN
  }
  // No key file yet: the first launch (or a lost key). Exactly the synchronous path of before (it may create the key).
  if (!existsSync(keyPath)) return getOrCreateDatabaseKey(userDataDir, dbFile, sealer)
  const unsealed = await unsealAsync(keyPath, sealer)
  if ('key' in unsealed) return { key: unsealed.key, mode: 'encrypted', reason: null }
  // Wave 107 review Y1: the synchronous read below would show the keychain dialog again with the main thread blocked (windows, Cmd+Q and
  // the quit's 30-second limit all stop). After a quit began, nothing more is asked: the launch opens nothing anyway.
  if (abandoned()) {
    log.info('db.key.abandoned', { at: 'fallback', reason: unsealed.miss })
    return NO_KEY_FROM_KEYCHAIN
  }
  // The keychain refused (Deny, or it failed). Asking again synchronously is the same question with the main thread blocked. Degrade the
  // way a refused synchronous read always did (`isEncryptionAvailable` false = `db-keychain-unavailable`): memory only, `db.key` and the
  // DB untouched, so the next launch reads the same file and asks again.
  if (unsealed.miss === 'refused' && options.refusalIsFinal) {
    log.warn('db.key.async.refused', {})
    return NO_KEY_FROM_KEYCHAIN
  }
  log.info('db.key.async.fallback', { reason: unsealed.miss })
  // The synchronous read of before. The file exists, so it reads (or degrades with the same reasons as before); it creates a key only
  // if the file vanished in between and no DB with contents exists - the same rule as any launch without a key file.
  return getOrCreateDatabaseKey(userDataDir, dbFile, sealer)
}

export type DatabaseKeyLoader = (userDataDir: string, dbFile: string, request?: DatabaseKeyRequest) => Promise<DatabaseKey>

/**
 * A loader with its own memory: one read per key file for its life (ARCHITECTURE 8.2). Every caller gets the same promise, so two of
 * them can never decide differently (one seeing "no key" and writing a new one while the other is still waiting). The app uses one
 * (`loadDatabaseKey`); a test makes one per simulated launch. A later caller's `request` is not used (the first read is the answer).
 */
export function databaseKeyLoader(sealer?: KeySealer, options: DatabaseKeyLoaderOptions = {}): DatabaseKeyLoader {
  const loads = new Map<string, Promise<DatabaseKey>>()
  const settled: Required<DatabaseKeyLoaderOptions> = { refusalIsFinal: options.refusalIsFinal ?? isMac() }
  return (userDataDir, dbFile, request = {}) => {
    const keyPath = join(userDataDir, KEY_FILE)
    const pending = loads.get(keyPath)
    if (pending !== undefined) return pending
    // Electron's `safeStorage` is looked up only when a key is wanted (not when this module loads).
    const started = readDatabaseKey(userDataDir, dbFile, sealer ?? safeStorage, settled, request)
    loads.set(keyPath, started)
    return started
  }
}

/**
 * The key for the launch (TODO 1341 item 8). An existing `db.key` is unsealed off the main thread; everything else is
 * `getOrCreateDatabaseKey`. Rejects only where `getOrCreateDatabaseKey` throws (writing a new key failed), as the launch did before.
 * The launch passes `abandoned` so a quit during the keychain dialog never leads to a synchronous read (wave 107 review Y1).
 */
export const loadDatabaseKey: DatabaseKeyLoader = databaseKeyLoader()
