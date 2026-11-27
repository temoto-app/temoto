/**
 * Sealing and unsealing small secrets with the OS keychain through `safeStorage`'s asynchronous entry points (TODO 1344 items 1 and 2,
 * ARCHITECTURE 8.2). Used by the plugin credentials (`CredentialStore`) and the backup passphrases (`backup.pass` /
 * `backup-restore.pass`). The DB key has its own loader (`src/main/db/key.ts`), which follows the same rules.
 *
 * Why asynchronous: on macOS the asynchronous side reads the keychain on a worker thread, so a keychain dialog does not block the main
 * thread; and the synchronous side remembers its key apart from the asynchronous side, so mixing them reads the keychain twice in one
 * launch (a second dialog after "Allow" or "Deny"). Electron 46 also removes the synchronous side.
 *
 * Rules (each one decided per kind of failure; see 8.2 for the reasons):
 *  - The asynchronous entry point is missing (an older Electron, a test fake): the synchronous one is used (`./sync.ts`).
 *  - The keychain refused (macOS; the exact rejection of Electron 44.4.3, see `KEYCHAIN_REFUSED_MESSAGE` / `KEYCHAIN_SEAL_NO_KEY_MESSAGE`),
 *    or the launch already knows it refused (the DB key degraded with `db-keychain-unavailable`): no synchronous retry (it would show
 *    the same dialog again with the main thread blocked) and no further question for the rest of the launch. Nothing is deleted.
 *  - The app is quitting: no new question and no synchronous retry. A call goes ahead only when the asynchronous side already holds the
 *    key (an earlier call succeeded), because then nothing is asked.
 *  - Any other rejection: the synchronous entry point, as the DB key does.
 *  - While the first asynchronous question of the launch is open (a dialog may be up), later calls wait behind it instead of adding
 *    their own, so there is one question at a time.
 *
 * Never logs a value, its length, or anything derived from it.
 */
import { errorFields, log } from '../../common/logger.js'
import { isMac } from '../../common/os/platform.js'
import { syncAvailable, syncOpen, syncSeal, type SyncSafeStorage } from './sync.js'

/**
 * The rejection of `decryptStringAsync` when the key provider had no key to give (wave 107 review Y1). Read in Electron 44.4.3
 * `shell/browser/api/electron_api_safe_storage.cc`: used only when Chromium's `Encryptor::DecryptData` sets `temporarily_unavailable`,
 * i.e. the data carries a provider's tag (`v10`) but that provider returned `kTemporarilyUnavailable`. On macOS the only provider is
 * `KeychainKeyProvider`, which returns it exactly when the keychain password came back empty: "access is denied by the user or some
 * other error occurs" (chromium 152 `keychain_key_provider.mm`). The provider is asked once per process.
 */
export const KEYCHAIN_REFUSED_MESSAGE = 'safeStorage.decryptStringAsync is temporarily unavailable. Please try again.'

/**
 * The rejection of `encryptStringAsync` (TODO 1344). Read in the same Electron file: used only when Chromium's `Encryptor::EncryptString`
 * returns nothing, which (chromium 152 `components/os_crypt/async/common/encryptor.cc`) happens only when the provider used for
 * encryption has no key - on macOS, the keychain gave no password (refused or failed), the same cause as `KEYCHAIN_REFUSED_MESSAGE`.
 * Chromium's asynchronous encryptor never falls back to the synchronous one.
 */
export const KEYCHAIN_SEAL_NO_KEY_MESSAGE = 'Error while encrypting the text provided to safeStorage.encryptStringAsync.'

/** The message of `SecretUnavailableError`; `CredentialStore` and the extension accounts map it to `secret-storage`. */
export const SECRET_STORAGE_UNAVAILABLE = 'secret storage unavailable'

function messageOf(err: unknown): unknown {
  return (err as { message?: unknown } | null)?.message
}

/** Whether a rejection of `decryptStringAsync` is the keychain's refusal (exact match only; any other text is not). */
export function isKeychainRefusal(err: unknown): boolean {
  return messageOf(err) === KEYCHAIN_REFUSED_MESSAGE
}

/** `safeStorage` as this module uses it. The asynchronous members are optional: without them the synchronous ones are used. */
export interface KeychainStorage extends SyncSafeStorage {
  encryptStringAsync?: (plainText: string) => Promise<Buffer>
  decryptStringAsync?: (encrypted: Buffer) => Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>
}

/** Why nothing could be sealed or unsealed now. None of them says the stored value is lost. */
export type KeychainMiss = 'refused' | 'abandoned' | 'unavailable'

/** The keychain cannot be used now (refused, quitting, or not available). The stored value may be fine: keep it. */
export class SecretUnavailableError extends Error {
  constructor(readonly miss: KeychainMiss) {
    super(SECRET_STORAGE_UNAVAILABLE)
    this.name = 'SecretUnavailableError'
  }
}

/** The keychain answered, but this value does not unseal (another key, a damaged value). */
export class SecretUnreadableError extends Error {
  constructor() {
    super('secret unreadable')
    this.name = 'SecretUnreadableError'
  }
}

export interface KeychainOptions {
  /**
   * true: a refusal is final for the launch (no synchronous retry, no further question). The default is macOS only, where the meaning
   * of the rejections was read in the source; elsewhere a refusal falls back to the synchronous side, as the DB key does.
   */
  readonly refusalIsFinal?: boolean
  /** The app is quitting (must stay true once true). */
  readonly abandoned?: () => boolean
  /** The launch already knows the keychain gave nothing (the DB key degraded with `db-keychain-unavailable`). */
  readonly refused?: boolean
}

type Op = 'open' | 'seal'

export class Keychain {
  private refused: boolean
  /** An asynchronous call succeeded: the asynchronous side holds the key, so later calls ask nothing. */
  private keyed = false
  /** The asynchronous call that is asking the keychain right now (only before `keyed` / `refused` is known). Never rejects. */
  private question: Promise<void> | null = null
  private readonly refusalIsFinal: boolean
  private readonly abandoned: () => boolean

  constructor(
    private readonly storage: () => KeychainStorage,
    options: KeychainOptions = {}
  ) {
    this.refused = options.refused === true
    this.refusalIsFinal = options.refusalIsFinal ?? isMac()
    this.abandoned = () => options.abandoned?.() === true
  }

  /** The keychain refused in this launch: nothing will be sealed or unsealed until the next launch. Asks nothing. */
  isRefused(): boolean {
    return this.refused
  }

  /** The app is quitting (writers check it after an `await`, so nothing is written once the quit began). */
  closing(): boolean {
    return this.abandoned()
  }

  /** Unseals. Throws `SecretUnavailableError` (try again in a later launch; keep the value) or `SecretUnreadableError`. */
  async open(sealed: Buffer): Promise<string> {
    const storage = this.storage()
    while (this.mustWait()) await this.question
    this.assertMayAsk('open')
    const decrypt = storage.decryptStringAsync
    if (typeof decrypt !== 'function') return this.viaSync('open', 'unsupported', storage, () => syncOpen(storage, sealed))
    let call: Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>
    try {
      call = this.asking(decrypt.call(storage, sealed))
    } catch (err) {
      call = Promise.reject(err)
    }
    try {
      const { result } = await call
      this.keyed = true
      if (typeof result !== 'string') {
        return this.viaSync('open', 'shape', storage, () => syncOpen(storage, sealed))
      }
      // `shouldReEncrypt` is not acted on: macOS has one provider (always false), and nothing is rewritten on a read.
      return result
    } catch (err) {
      return this.afterRejection('open', err, storage, () => syncOpen(storage, sealed))
    }
  }

  /** Seals. Throws `SecretUnavailableError` when it cannot (nothing must be written then). */
  async seal(plainText: string): Promise<Buffer> {
    const storage = this.storage()
    while (this.mustWait()) await this.question
    this.assertMayAsk('seal')
    const encrypt = storage.encryptStringAsync
    if (typeof encrypt !== 'function') return this.viaSync('seal', 'unsupported', storage, () => syncSeal(storage, plainText))
    let call: Promise<Buffer>
    try {
      call = this.asking(encrypt.call(storage, plainText))
    } catch (err) {
      call = Promise.reject(err)
    }
    try {
      const sealed = await call
      this.keyed = true
      if (!Buffer.isBuffer(sealed)) throw new Error('encryptStringAsync returned no buffer')
      return sealed
    } catch (err) {
      return this.afterRejection('seal', err, storage, () => syncSeal(storage, plainText))
    }
  }

  /**
   * Whether another call is asking the keychain for the first time (a second question is never put while one is open). Callers loop
   * on it with no other `await` between the check and their own call, so the first one to wake becomes the next question and the rest
   * wait again (an `async` helper here would let them all pass the check before any of them calls).
   */
  private mustWait(): boolean {
    return this.question !== null && !this.keyed && !this.refused
  }

  private assertMayAsk(op: Op): void {
    if (this.refused) throw new SecretUnavailableError('refused')
    // Quitting: no new question. With the key already held, the asynchronous side asks nothing, so the call may go ahead.
    if (this.abandoned() && !this.keyed) {
      log.info('keychain.abandoned', { op, at: 'start' })
      throw new SecretUnavailableError('abandoned')
    }
  }

  /** Records `call` as the open question when the keychain's answer is not known yet. Returns `call` unchanged. */
  private asking<T>(call: Promise<T>): Promise<T> {
    if (!this.keyed && !this.refused && this.question === null) {
      const question: Promise<void> = call.then(
        () => undefined,
        () => undefined
      ).then(() => {
        if (this.question === question) this.question = null
      })
      this.question = question
    }
    return call
  }

  private afterRejection<T>(op: Op, err: unknown, storage: KeychainStorage, sync: () => T): T {
    log.warn('keychain.async.failed', { op, ...errorFields(err) })
    const refusal = op === 'open' ? isKeychainRefusal(err) : messageOf(err) === KEYCHAIN_SEAL_NO_KEY_MESSAGE
    if (refusal && this.refusalIsFinal) {
      // Final for this launch: the provider is asked once per process, and the synchronous side would ask the same question again
      // with the main thread blocked.
      this.refused = true
      log.warn('keychain.refused', { op })
      throw new SecretUnavailableError('refused')
    }
    if (this.abandoned()) {
      log.info('keychain.abandoned', { op, at: 'fallback' })
      throw new SecretUnavailableError('abandoned')
    }
    return this.viaSync(op, refusal ? 'refused' : 'failed', storage, sync)
  }

  /** The synchronous side (`./sync.ts`). Never during a quit (`assertMayAsk` / `afterRejection` stop it before). */
  private viaSync<T>(op: Op, reason: 'unsupported' | 'shape' | 'failed' | 'refused', storage: KeychainStorage, sync: () => T): T {
    if (reason !== 'unsupported') log.info('keychain.sync.fallback', { op, reason })
    if (!syncAvailable(storage)) throw new SecretUnavailableError('unavailable')
    try {
      return sync()
    } catch (err) {
      log.warn('keychain.sync.failed', { op, ...errorFields(err) })
      if (op === 'open') throw new SecretUnreadableError()
      throw new SecretUnavailableError('unavailable')
    }
  }
}
