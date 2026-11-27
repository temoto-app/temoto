/**
 * The backup passphrases sealed by the OS keychain (TODO 1306 / 1344, ARCHITECTURE 8.7 / 8.2): `<userData>/backup.pass` (the remembered
 * one) and `<userData>/backup-restore.pass` (typed for a pending restore). Electron-free: the app passes its `Keychain`
 * (`src/main/keychain/keychain.ts`, `safeStorage`'s asynchronous entry points); tests pass fakes.
 *
 * - Never logged (neither the value nor its length), never returned to the renderer, not in `app_settings`.
 * - A file that cannot be unsealed now (the keychain refused, the app is quitting) or at all (the item was lost) is left as it is: it is
 *   never deleted or rewritten here. Only `set` writes, and only after a successful seal.
 * - Writes are queued (one after another, in the order they were asked) and replace the file atomically (tmp + rename, 0600).
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { errorFields, log } from '../../common/logger.js'
import { SecretUnavailableError } from '../keychain/keychain.js'
import type { BackupPassphraseStore, RestorePassphraseStore } from './service.js'

/** The part of `Keychain` the passphrases use. */
export interface PassphraseKeychain {
  isRefused(): boolean
  closing(): boolean
  seal(plainText: string): Promise<Buffer>
  open(sealed: Buffer): Promise<string>
}

type ReadResult =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'absent' }
  /** The keychain cannot be used now: says nothing about the file. */
  | { readonly kind: 'unavailable' }
  /** The keychain answered but the file does not unseal (or cannot be read). */
  | { readonly kind: 'unreadable' }

interface SealedFile {
  read(): Promise<ReadResult>
  write(passphrase: string): Promise<void>
  /** How many writes replaced the file so far (bumped in the same step as the rename). */
  written(): number
}

/** A passphrase sealed in one file (0600, replaced atomically). */
function sealedFile(file: string, event: string, keychain: PassphraseKeychain): SealedFile {
  let warned = false
  let writes: Promise<void> = Promise.resolve()
  let written = 0
  return {
    written: () => written,
    read: async () => {
      if (!existsSync(file)) return { kind: 'absent' }
      let sealed: Buffer
      try {
        sealed = readFileSync(file)
      } catch (err) {
        if (!warned) log.warn(event, errorFields(err))
        warned = true
        return { kind: 'unreadable' }
      }
      try {
        return { kind: 'value', value: await keychain.open(sealed) }
      } catch (err) {
        if (err instanceof SecretUnavailableError) return { kind: 'unavailable' }
        // The keychain item was lost (or another user's file). The passphrase itself still opens the backups: the user types it.
        if (!warned) log.warn(event, errorFields(err))
        warned = true
        return { kind: 'unreadable' }
      }
    },
    write: (passphrase) => {
      const run = writes.then(async () => {
        if (keychain.closing()) throw new SecretUnavailableError('abandoned')
        const sealed = await keychain.seal(passphrase)
        // A quit that began while sealing: nothing is written.
        if (keychain.closing()) throw new SecretUnavailableError('abandoned')
        const tmp = `${file}.tmp`
        writeFileSync(tmp, sealed, { mode: 0o600 })
        chmodSync(tmp, 0o600)
        // Replaced atomically, so a crash never leaves a half-written sealed file.
        renameSync(tmp, file)
        written += 1
      })
      writes = run.then(
        () => undefined,
        () => undefined
      )
      return run
    }
  }
}

export function passphraseStore(file: string, keychain: PassphraseKeychain): BackupPassphraseStore {
  const sealed = sealedFile(file, 'backup.passphrase.undecryptable', keychain)
  // Whether a usable passphrase is stored: unsealed once, then kept up to date by `get` / `set`. null = not known yet.
  let known: boolean | null = null
  // Wave 108 fix Y1: a read's answer is used only if no write replaced the file while it ran (it may have read the older file, and the
  // write already set `known`). A write that failed changed nothing, so it never discards a read; a write still running when the read
  // ends has not replaced the file yet, so the read's answer is still the file's (the write updates `known` when it lands).
  const learn = (result: ReadResult, startedAt: number): void => {
    if (startedAt !== sealed.written() || result.kind === 'unavailable') return
    known = result.kind === 'value'
  }
  return {
    available: () => !keychain.isRefused(),
    isSet: () => known === true,
    load: async () => {
      if (known !== null) return
      const startedAt = sealed.written()
      try {
        learn(await sealed.read(), startedAt)
      } catch (err) {
        log.warn('backup.passphrase.loadFailed', errorFields(err))
      }
    },
    get: async () => {
      const startedAt = sealed.written()
      const result = await sealed.read()
      learn(result, startedAt)
      return result.kind === 'value' ? result.value : null
    },
    set: async (passphrase) => {
      // On failure nothing was written and `known` is left as it was.
      await sealed.write(passphrase)
      known = true
    }
  }
}

export function restorePassphraseStore(file: string, keychain: PassphraseKeychain): RestorePassphraseStore {
  const sealed = sealedFile(file, 'backup.restore.passphraseUndecryptable', keychain)
  return {
    available: () => !keychain.isRefused(),
    get: async () => {
      const result = await sealed.read()
      return result.kind === 'value' ? result.value : null
    },
    set: (passphrase) => sealed.write(passphrase)
  }
}
