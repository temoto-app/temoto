/**
 * TODO 1263: which name this machine's data lives under, decided once per launch (ARCHITECTURE 8.4).
 *
 * The public name changed from the code name `aios` to `Temoto` before the first public release. A machine that already ran
 * the app keeps its data where it is: **if the legacy userData (`<appData>/aios`) exists, the app keeps running under the
 * legacy name**; otherwise it starts under the new one. **A machine whose data already lives under the new name (`<appData>/Temoto`
 * holds the DB file) stays on the new name** even if a legacy userData appears later (an old build launched once, another app of the
 * same name): otherwise the next launch would switch names and hide the data (TODO 1263 code-review). The order:
 *
 * 1. `<appData>/Temoto/<DB file>` is a real file in a real directory → `Temoto`;
 * 2. `<appData>/aios` is a real directory (or could not be looked at) → `aios`;
 * 3. otherwise → `Temoto`.
 *
 * One decision drives every user-visible location:
 *
 * - the Electron app name (`app.setName`), hence userData `<appData>/<name>`, the Logs folder and the keychain item
 *   `<name> Safe Storage` that seals the DB key;
 * - `~/<name>/` (the scratch areas and the copy of Help);
 * - `~/.local/share/<name>` (the per-version directories and `install.json`).
 *
 * **Nothing is moved and no key is re-sealed** (constraint 11: a failed re-seal would leave the DB unopenable). The installer
 * (`scripts/install-temoto.sh`) and `scripts/dev-instance.sh` make the same decision (a test compares them).
 *
 * The decision is made from `lstat` of those two locations only: a symlink (the folder or the DB file) is not followed and does not
 * count. No value from the user or the renderer takes part. `--user-data-dir` (dev:instance, proxy verification)
 * does not change the decision either: the copy it points at is sealed with the key of the machine's name.
 *
 * Does not import electron. main calls `initAppIdentity` once, before `app.setName` (i.e. before `ready`).
 */
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_NAME, LEGACY_DATA_NAME } from '../shared/product.js'

export type AppIdentityKind = 'current' | 'legacy'

export interface AppIdentity {
  /** `current` = the new name (a machine with no legacy userData), `legacy` = the code name kept on an existing machine. */
  readonly kind: AppIdentityKind
  /** The name every location takes (`Temoto` / `aios`). */
  readonly dataName: string
}

export const CURRENT_IDENTITY: AppIdentity = Object.freeze({ kind: 'current', dataName: DATA_NAME })
export const LEGACY_IDENTITY: AppIdentity = Object.freeze({ kind: 'legacy', dataName: LEGACY_DATA_NAME })

/**
 * What is at the legacy userData location.
 * - `directory`: a real directory (not a symlink).
 * - `absent`: nothing there.
 * - `other`: a symlink, a file or anything that is not a real directory (not followed, so not the legacy userData).
 * - `unknown`: lstat failed for a reason other than "missing" (permissions and the like). The entry probably exists.
 */
export type LegacyUserDataState = 'directory' | 'absent' | 'other' | 'unknown'

/** What the decision looks at: whether the new name's userData already holds the DB, and what is at the legacy location. */
export interface UserDataProbe {
  /** `<appData>/Temoto/<DB file>` is a real file inside a real directory (neither is a symlink). */
  readonly currentHasDb: boolean
  readonly legacy: LegacyUserDataState
}

/**
 * The decision itself (pure). Data already under the new name wins, so a legacy userData that appears later does not switch the name.
 * `unknown` keeps the legacy name: the data is probably there, and a fresh start would hide it.
 */
export function chooseAppIdentity(probe: UserDataProbe): AppIdentity {
  if (probe.currentHasDb) return CURRENT_IDENTITY
  return probe.legacy === 'directory' || probe.legacy === 'unknown' ? LEGACY_IDENTITY : CURRENT_IDENTITY
}

/**
 * The encrypted DB's file name inside userData (`DB_FILE` in `src/main/db/index.ts` takes this value). The same name in both
 * data names: only the folder is named after the app.
 */
export const USER_DATA_DB_FILE = 'aios.db'

/** The legacy userData location (`<appData>/aios`). `appData` is the OS location, which `--user-data-dir` does not change. */
export function legacyUserDataPath(appData: string): string {
  return join(appData, LEGACY_DATA_NAME)
}

/** The new name's userData location (`<appData>/Temoto`). */
export function currentUserDataPath(appData: string): string {
  return join(appData, DATA_NAME)
}

type Lstat = (path: string) => { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }

/** Look at the legacy userData location with `lstat` (never follows a symlink). */
export function probeLegacyUserData(appData: string, lstat: Lstat = lstatSync): LegacyUserDataState {
  try {
    const stat = lstat(legacyUserDataPath(appData))
    if (stat.isSymbolicLink()) return 'other'
    return stat.isDirectory() ? 'directory' : 'other'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown'
  }
}

/**
 * Whether the new name's userData already holds the DB, with `lstat` on the folder and on the file (so a symlink at either step is
 * not followed and does not count). Any failure counts as "no": the decision then falls back to the legacy rule, as before.
 */
export function probeCurrentUserDataDb(appData: string, lstat: Lstat = lstatSync): boolean {
  try {
    const dir = lstat(currentUserDataPath(appData))
    if (dir.isSymbolicLink() || !dir.isDirectory()) return false
    const db = lstat(join(currentUserDataPath(appData), USER_DATA_DB_FILE))
    return !db.isSymbolicLink() && db.isFile()
  } catch {
    return false
  }
}

/** Everything the decision looks at, from `appData` (the OS location). */
export function probeUserData(appData: string, lstat: Lstat = lstatSync): UserDataProbe {
  return { currentHasDb: probeCurrentUserDataDb(appData, lstat), legacy: probeLegacyUserData(appData, lstat) }
}

/** The keychain item that seals the DB key (Electron names it after the app name). */
export function keychainItemName(identity: AppIdentity): string {
  return `${identity.dataName} Safe Storage`
}

let chosen: AppIdentity | null = null

/**
 * Fix the identity for this process. Called once by main before `app.setName`. Calling it again with the same identity is a no-op;
 * a different one throws (the paths must not change halfway through a launch).
 */
export function initAppIdentity(identity: AppIdentity): AppIdentity {
  if (chosen !== null && chosen.dataName !== identity.dataName) {
    throw new Error(`app identity already set to ${chosen.dataName}`)
  }
  chosen = identity
  return identity
}

/** The identity fixed by `initAppIdentity`. Throws if it was never set (a path computed before the decision would be wrong). */
export function appIdentity(): AppIdentity {
  if (chosen === null) throw new Error('app identity is not initialized')
  return chosen
}

/** `~/<name>` (the parent of the scratch areas and the copy of Help). */
export function homeDataDir(home: string, dataName: string = appIdentity().dataName): string {
  return join(home, dataName)
}

/** `~/.local/share/<name>` (the per-version directories and `install.json`; the default of `AIOS_INSTALL_ROOT` in install-temoto.sh). */
export function defaultInstallRootFor(home: string, dataName: string = appIdentity().dataName): string {
  return join(home, '.local', 'share', dataName)
}

/** `~/<name>` written for the user and the model (`~/Temoto`). */
export function homeDataDirDisplay(dataName: string = appIdentity().dataName): string {
  return `~/${dataName}`
}
