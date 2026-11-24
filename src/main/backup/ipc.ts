/**
 * Connects the automatic backup (TODO 1306, ARCHITECTURE 8.7) to electron. The body is `service.ts`.
 *
 * - The passphrase is sealed with `safeStorage` (the same OS keychain as `db.key`, 8.2) into `<userData>/backup.pass` (0600). It is never
 *   returned to the renderer, never logged, and not put in `app_settings`. Whether one is stored is remembered (one unseal), so the
 *   status does not go to the keychain each time, and an unsealable file is logged once.
 * - A passphrase typed for a restore is sealed the same way into `<userData>/backup-restore.pass`, read only by the import after the
 *   restart, and removed with the restore marker. The remembered passphrase is not changed by a restore.
 * - The folder is chosen with main's native dialog (no path comes from the renderer), and the chosen path still goes through
 *   `FsAccess.assertAllowed` (exclusion rules) before it is kept.
 * - A restore asks once (a native confirmation) and then restarts. It is the only confirmation of this feature (owner decision 2026-11-22).
 * - The IPC is registered even when backups do not run (a verification launch): `status()` says `supported: false` with the reason.
 */
import { BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { BackupActionResult, BackupUnsupportedReason, DbHealthState, DbQuickCheckResult } from '@shared/backup.js'
import type { Locale } from '@shared/locale.js'
import type { StorageReason } from '@shared/types.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { BACKUP_LAST_FAILURE, BACKUP_NOTICE_DISMISSED } from '../../common/settings-keys.js'
import { errorFields, log } from '../../common/logger.js'
import { guarded } from '../ipc/handlers.js'
import { nativeFormat, nativeText } from '../i18n-native.js'
import { verifyExportFile } from '../data-transfer/service.js'
import { nodeTransferFiles } from '../data-transfer/files.js'
import { BackupService, type BackupPassphraseStore, type BackupTransfer, type RestorePassphraseStore } from './service.js'
import { RESTORE_PASSPHRASE_FILE, removeRestoreMarker, writeRestoreMarker } from './restore.js'

export const BACKUP_CONFIG_FILE = 'backup.json'
export const BACKUP_PASSPHRASE_FILE = 'backup.pass'
/** This profile's owner id in the generations' names (`service.ts`). Outside the DB and the keychain. */
export const BACKUP_OWNER_FILE = 'backup.id'
/** When the light check of the DB last finished (`service.ts`, `DbCheckRecord`). */
export const DB_CHECK_RECORD_FILE = 'db-check.json'

/**
 * The folder next to userData (`<appData>/<dataName> Backups`). Outside userData so that moving or deleting the profile folder does not take
 * the backups with it.
 */
export function defaultBackupDir(userDataDir: string): string {
  return join(dirname(userDataDir), `${basename(userDataDir)} Backups`)
}

/**
 * Whether backups run in this launch. A non-default userData (dev:instance, smoke, proxy verification) never touches the real folder or
 * the keychain, unless `AIOS_BACKUP_IN_INSTANCE=1` is set on purpose (then the folder is next to that instance's userData).
 */
export function backupUnsupportedReason(input: {
  readonly defaultUserData: boolean
  readonly env: NodeJS.ProcessEnv
  readonly storageReason: StorageReason | null
}): BackupUnsupportedReason | null {
  if (input.storageReason === 'db-keychain-unavailable') return 'keychain'
  if (!input.defaultUserData && input.env['AIOS_BACKUP_IN_INSTANCE'] !== '1') return 'instance'
  return null
}

/** The health known before the check: a DB that fell back to memory is `unopenable` (or `unavailable` without a keychain). */
export function initialHealth(storageReason: StorageReason | null): DbHealthState {
  if (storageReason === null) return 'unknown'
  return storageReason === 'db-keychain-unavailable' ? 'unavailable' : 'unopenable'
}

/** A passphrase sealed by `safeStorage` in one file (0600, replaced atomically). Never logged. */
function sealedFile(file: string, event: string): { get(): string | null; set(passphrase: string): void } {
  let warned = false
  return {
    get: () => {
      if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null
      try {
        return safeStorage.decryptString(readFileSync(file))
      } catch (err) {
        // The keychain item was lost (or another user's file). The passphrase itself still opens the backups: the user types it.
        if (!warned) log.warn(event, errorFields(err))
        warned = true
        return null
      }
    },
    set: (passphrase) => {
      const tmp = `${file}.tmp`
      writeFileSync(tmp, safeStorage.encryptString(passphrase), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      // Replaced atomically, so a crash never leaves a half-written sealed file.
      renameSync(tmp, file)
    }
  }
}

function passphraseStore(file: string): BackupPassphraseStore {
  const sealed = sealedFile(file, 'backup.passphrase.undecryptable')
  // Whether a usable passphrase is stored: unsealed once, then kept up to date by `set`.
  let known: boolean | null = null
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    isSet: () => {
      if (known === null) known = sealed.get() !== null
      return known
    },
    get: () => {
      const value = sealed.get()
      known = value !== null
      return value
    },
    set: (passphrase) => {
      sealed.set(passphrase)
      known = true
    }
  }
}

function restorePassphraseStore(file: string): RestorePassphraseStore {
  const sealed = sealedFile(file, 'backup.restore.passphraseUndecryptable')
  return { available: () => safeStorage.isEncryptionAvailable(), get: sealed.get, set: sealed.set }
}

export interface BackupWiring {
  readonly userDataDir: string
  readonly unsupportedReason: BackupUnsupportedReason | null
  readonly storageReason: StorageReason | null
  readonly transfer: BackupTransfer
  readonly settings: AppSettingsStore
  readonly isIdle: () => boolean
  readonly systemIdleSeconds: () => number
  readonly quickCheck: () => Promise<DbQuickCheckResult>
  readonly getTargets: () => readonly WebContents[]
  readonly locale: () => Locale
  /** `FsAccess.assertAllowed` for a folder path (throws `PathDenied`). */
  readonly assertDirAllowed: (path: string) => void
  /** The choke point before a restart (running conversations, unsaved drafts). false = the user backed out. */
  readonly settleForRestart: () => Promise<boolean>
  readonly relaunch: () => void
}

export function registerBackupHandlers(wiring: BackupWiring): BackupService {
  const service = new BackupService({
    unsupportedReason: wiring.unsupportedReason,
    initialHealth: initialHealth(wiring.storageReason),
    keyUnreadable: wiring.storageReason === 'db-key-undecryptable',
    transfer: wiring.transfer,
    passphrase: passphraseStore(join(wiring.userDataDir, BACKUP_PASSPHRASE_FILE)),
    restorePassphrase: restorePassphraseStore(join(wiring.userDataDir, RESTORE_PASSPHRASE_FILE)),
    records: {
      lastFailure: () => wiring.settings.readTyped(BACKUP_LAST_FAILURE),
      setLastFailure: (value) => wiring.settings.writeTyped(BACKUP_LAST_FAILURE, value),
      noticeDismissed: () => wiring.settings.readTyped(BACKUP_NOTICE_DISMISSED),
      dismissNotice: () => wiring.settings.writeTyped(BACKUP_NOTICE_DISMISSED, true)
    },
    configFile: join(wiring.userDataDir, BACKUP_CONFIG_FILE),
    ownerFile: join(wiring.userDataDir, BACKUP_OWNER_FILE),
    checkRecordFile: join(wiring.userDataDir, DB_CHECK_RECORD_FILE),
    defaultDir: defaultBackupDir(wiring.userDataDir),
    isIdle: wiring.isIdle,
    systemIdleSeconds: wiring.systemIdleSeconds,
    quickCheck: wiring.quickCheck,
    verifyFile: (path, passphrase) => verifyExportFile(nodeTransferFiles, path, passphrase),
    writeRestoreMarker: (marker) => writeRestoreMarker(wiring.userDataDir, marker),
    removeRestoreMarker: () => removeRestoreMarker(wiring.userDataDir),
    onChanged: (status) => {
      for (const contents of wiring.getTargets()) {
        if (!contents.isDestroyed()) contents.send(IpcEvent.backupChanged, status)
      }
    }
  })

  ipcMain.handle(IpcChannel.backupStatus, guarded(IpcChannel.backupStatus, async () => {
    await service.refresh()
    return service.status()
  }))
  ipcMain.handle(
    IpcChannel.backupSetPassphrase,
    guarded(IpcChannel.backupSetPassphrase, (_event: unknown, passphrase: unknown) => service.setPassphrase(passphrase))
  )
  ipcMain.handle(IpcChannel.backupRunNow, guarded(IpcChannel.backupRunNow, () => service.runNow()))
  ipcMain.handle(
    IpcChannel.backupChooseDir,
    guarded(IpcChannel.backupChooseDir, async (event: IpcMainInvokeEvent): Promise<BackupActionResult> => {
      if (!service.supported) return { kind: 'failed', reason: 'unsupported' }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: nativeText(wiring.locale(), 'dialog.backupDir.title'),
        defaultPath: service.backupDir,
        properties: ['openDirectory' as const, 'createDirectory' as const]
      }
      const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options)
      const dir = result.filePaths[0]
      if (result.canceled || dir === undefined) return { kind: 'canceled' }
      try {
        wiring.assertDirAllowed(dir)
      } catch {
        log.info('backup.dir.denied', { path: dir })
        return { kind: 'failed', reason: 'dir-denied' }
      }
      return service.setDir(dir)
    })
  )
  ipcMain.handle(IpcChannel.backupResetDir, guarded(IpcChannel.backupResetDir, () => service.setDir(null)))
  ipcMain.handle(
    IpcChannel.backupDismissNotice,
    guarded(IpcChannel.backupDismissNotice, () => {
      service.dismissNotice()
    })
  )
  ipcMain.handle(IpcChannel.backupKeepCurrent, guarded(IpcChannel.backupKeepCurrent, () => service.keepCurrent()))
  ipcMain.handle(
    IpcChannel.backupRestore,
    guarded(IpcChannel.backupRestore, async (event: IpcMainInvokeEvent, passphrase: unknown): Promise<BackupActionResult> => {
      const prepared = await service.prepareRestore(passphrase)
      if (!prepared.ok) return { kind: 'failed', reason: prepared.reason }
      const locale = wiring.locale()
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options = {
        type: 'warning' as const,
        message: nativeText(locale, 'dialog.backupRestore.message'),
        detail: nativeFormat(locale, 'dialog.backupRestore.detail', {
          date: new Date(prepared.value.at).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US')
        }),
        buttons: [nativeText(locale, 'dialog.backupRestore.confirm'), nativeText(locale, 'dialog.cancel')],
        defaultId: 1,
        cancelId: 1
      }
      const answer = owner === null ? await dialog.showMessageBox(options) : await dialog.showMessageBox(owner, options)
      if (answer.response !== 0) return { kind: 'canceled' }
      // Running conversations and unsaved drafts first: if the user backs out there, nothing has been written yet.
      if (!(await wiring.settleForRestart())) return { kind: 'canceled' }
      const committed = service.commitRestore(prepared.value)
      if (committed.kind !== 'done') return committed
      try {
        wiring.relaunch()
      } catch (err) {
        // Not restarting now: do not leave a restore that would surprise the next ordinary launch.
        log.warn('backup.restore.relaunchFailed', errorFields(err))
        removeRestoreMarker(wiring.userDataDir)
        return { kind: 'failed', reason: 'io' }
      }
      return { kind: 'done' }
    })
  )
  return service
}
