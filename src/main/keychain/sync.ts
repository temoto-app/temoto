/**
 * The only callers of `safeStorage`'s synchronous entry points (TODO 1344, ARCHITECTURE 8.2).
 *
 * Electron documents that `isEncryptionAvailable` / `encryptString` / `decryptString` go away in Electron 46. Every synchronous use in
 * the app goes through the three functions below, so the move to 46 is: delete this file and fix what no longer compiles. A test
 * (`test/keychain-sync-calls.test.ts`) fails if a synchronous call appears anywhere else in `src/`.
 *
 * What still uses them on Electron 44 (each for a stated reason, see 8.2):
 *  - `getOrCreateDatabaseKey` (`src/main/db/key.ts`): creating `db.key` on the first launch, and the fallback read of an existing key.
 *  - `Keychain` (`./keychain.ts`): only when the asynchronous entry point is missing (an older Electron, a test fake) or rejected with a
 *    message that is not known to mean "the keychain refused" - the same rule as the DB key.
 *
 * On macOS each of these reads the keychain on the main thread (a dialog there blocks windows, Cmd+Q and the quit's time limit), and
 * the synchronous side remembers its key apart from the asynchronous side (one keychain read each per process).
 */

/** The synchronous part of Electron's `safeStorage` (absent from Electron 46 on). */
export interface SyncSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Whether the synchronous side can seal. On macOS this reads the keychain (main thread) the first time in a process. */
export function syncAvailable(storage: SyncSafeStorage): boolean {
  return storage.isEncryptionAvailable()
}

/** Seals synchronously. Throws when it cannot. */
export function syncSeal(storage: SyncSafeStorage, plainText: string): Buffer {
  return storage.encryptString(plainText)
}

/** Unseals synchronously. Throws when it cannot. */
export function syncOpen(storage: SyncSafeStorage, encrypted: Buffer): string {
  return storage.decryptString(encrypted)
}
