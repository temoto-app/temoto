/**
 * Reading the DB key with the asynchronous `safeStorage` entry point (TODO 1341 item 8, ARCHITECTURE 8.2 / 3.1 "launch order").
 *
 * `safeStorage` is a fake sealer passed in (sealing = only marking the head; the asynchronous read understands what the synchronous
 * write made, as Electron documents and as `v10` + AES-128-CBC with the same keychain password is on macOS). What each part guards:
 * - principle 1: an existing machine's key stays readable - the asynchronous read never writes, renames or deletes `db.key`, a key the
 *   synchronous write made is read by the asynchronous read, and after such a launch a build that knows only the synchronous entry point
 *   (a downgrade) still reads the same bytes. A new key is still written with the synchronous entry point.
 * - principle 2: a missing, failing, throwing or odd asynchronous read falls back to the synchronous read of before, with the same
 *   degraded reasons; it never makes a new key and never touches the unreadable file.
 * - principle 3: callers of the same launch share one read (no second read deciding "no key" and writing one).
 * - principle 4: a quit during the wait opens nothing (`openAfterKey`), and a key that never arrives holds nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestDir } from './helpers/tmp.js'
import type { KeySealer } from '../src/main/db/key.js'

// The real entry point must never be reached from these tests: every call passes its own sealer.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => {
      throw new Error('the real safeStorage was used')
    },
    encryptString: () => {
      throw new Error('the real safeStorage was used')
    },
    decryptString: () => {
      throw new Error('the real safeStorage was used')
    }
  }
}))

const { databaseKeyLoader, getOrCreateDatabaseKey, KEYCHAIN_REFUSED_MESSAGE } = await import('../src/main/db/key.js')
const { openAfterKey } = await import('../src/main/boot-gate.js')
const { isMac } = await import('../src/common/os/platform.js')

type AsyncDecrypt = NonNullable<KeySealer['decryptStringAsync']>

const KEY = 'ab'.repeat(32)

interface FakeSealer extends KeySealer {
  readonly calls: { available: number; encrypt: number; decrypt: number; decryptAsync: number }
}

/** A sealer whose synchronous half works like the one in `db-key.test.ts`; the asynchronous half is given (or left out). */
function fakeSealer(options: {
  readonly async?: AsyncDecrypt | null
  readonly available?: boolean
  readonly undecryptable?: boolean
}): FakeSealer {
  const calls = { available: 0, encrypt: 0, decrypt: 0, decryptAsync: 0 }
  const sealer: FakeSealer = {
    calls,
    isEncryptionAvailable: () => {
      calls.available += 1
      return options.available ?? true
    },
    encryptString: (plain) => {
      calls.encrypt += 1
      return Buffer.from(`sealed:${plain}`)
    },
    decryptString: (sealed) => {
      calls.decrypt += 1
      if (options.undecryptable === true) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return sealed.toString().replace(/^sealed:/, '')
    }
  }
  const asyncDecrypt = options.async === undefined ? compatibleAsync : options.async
  if (asyncDecrypt !== null) {
    return {
      ...sealer,
      decryptStringAsync: (sealed) => {
        calls.decryptAsync += 1
        return asyncDecrypt(sealed)
      }
    }
  }
  return sealer
}

/** The asynchronous read of what the synchronous write made (the documented direction). */
const compatibleAsync: AsyncDecrypt = (sealed) =>
  Promise.resolve({ result: sealed.toString().replace(/^sealed:/, ''), shouldReEncrypt: false })

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let dir: string
let dbFile: string
let keyFile: string

beforeEach(() => {
  dir = makeTestDir('db-key-async')
  dbFile = join(dir, 'aios.db')
  keyFile = join(dir, 'db.key')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeExistingKey(): Buffer {
  const bytes = Buffer.from(`sealed:${KEY}`)
  writeFileSync(keyFile, bytes, { mode: 0o600 })
  writeFileSync(dbFile, 'existing encrypted database')
  return bytes
}

describe('principle 1: an existing key stays readable', () => {
  it('an existing key is read with the asynchronous entry point only (no synchronous keychain read), and the file is not touched', async () => {
    const bytes = writeExistingKey()
    const before = statSync(keyFile).mtimeMs
    const sealer = fakeSealer({})
    await expect(databaseKeyLoader(sealer)(dir, dbFile)).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    expect(sealer.calls).toEqual({ available: 0, encrypt: 0, decrypt: 0, decryptAsync: 1 })
    expect(readFileSync(keyFile)).toEqual(bytes)
    expect(statSync(keyFile).mtimeMs).toBe(before)
  })

  it('a first launch writes the key with the synchronous entry point; the next launch reads it asynchronously; a sync-only build still reads it', async () => {
    const first = fakeSealer({})
    const made = await databaseKeyLoader(first)(dir, dbFile)
    expect(made.mode).toBe('encrypted')
    expect(made.key).toMatch(/^[0-9a-f]{64}$/)
    expect(first.calls.encrypt).toBe(1)
    expect(first.calls.decryptAsync).toBe(0)
    const written = readFileSync(keyFile)

    // The next launch (a new process = a new loader).
    const second = fakeSealer({})
    await expect(databaseKeyLoader(second)(dir, dbFile)).resolves.toEqual({ key: made.key, mode: 'encrypted', reason: null })
    expect(second.calls.decryptAsync).toBe(1)
    expect(second.calls.encrypt).toBe(0)
    expect(readFileSync(keyFile)).toEqual(written)

    // A downgrade to a build that knows only the synchronous entry point.
    writeFileSync(dbFile, 'now has contents')
    expect(getOrCreateDatabaseKey(dir, dbFile, fakeSealer({ async: null }))).toEqual({ key: made.key, mode: 'encrypted', reason: null })
  })

  it('`shouldReEncrypt` does not make it rewrite the key file', async () => {
    const bytes = writeExistingKey()
    const sealer = fakeSealer({ async: () => Promise.resolve({ result: KEY, shouldReEncrypt: true }) })
    await expect(databaseKeyLoader(sealer)(dir, dbFile)).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    expect(sealer.calls.encrypt).toBe(0)
    expect(readFileSync(keyFile)).toEqual(bytes)
  })
})

describe('principle 2: trouble with the asynchronous read falls back to the synchronous read of before', () => {
  it('without the asynchronous entry point (an older Electron), the synchronous read', async () => {
    writeExistingKey()
    const sealer = fakeSealer({ async: null })
    await expect(databaseKeyLoader(sealer)(dir, dbFile)).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    expect(sealer.calls.available).toBe(1)
    expect(sealer.calls.decrypt).toBe(1)
  })

  it('a rejection that is not the known refusal goes to the synchronous read, which still opens it', async () => {
    writeExistingKey()
    const sealer = fakeSealer({ async: () => Promise.reject(new Error('temporarily unavailable')) })
    await expect(databaseKeyLoader(sealer)(dir, dbFile)).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    expect(sealer.calls.decryptAsync).toBe(1)
    expect(sealer.calls.decrypt).toBe(1)
  })

  it('a synchronous throw from the asynchronous entry point is a fallback, not a failed launch', async () => {
    writeExistingKey()
    const sealer = fakeSealer({
      async: () => {
        throw new Error('not ready')
      }
    })
    await expect(databaseKeyLoader(sealer)(dir, dbFile)).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
  })

  it('a result of another shape is not used; the synchronous read decides', async () => {
    writeExistingKey()
    const sealer = fakeSealer({ async: () => Promise.resolve({ result: 'not-a-key', shouldReEncrypt: false }) })
    await expect(databaseKeyLoader(sealer)(dir, dbFile)).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    expect(sealer.calls.decrypt).toBe(1)
  })

  it('when both fail: memory-only with `db-key-undecryptable`; no new key, and the unreadable file is kept as it was', async () => {
    const bytes = writeExistingKey()
    const sealer = fakeSealer({ async: () => Promise.reject(new Error('decrypt failed')), undecryptable: true })
    await expect(databaseKeyLoader(sealer)(dir, dbFile)).resolves.toEqual({ key: null, mode: 'memory-only', reason: 'db-key-undecryptable' })
    expect(sealer.calls.encrypt).toBe(0)
    expect(readFileSync(keyFile)).toEqual(bytes)
    expect(readFileSync(dbFile, 'utf8')).toBe('existing encrypted database')
  })

  it('even with no DB at all, a failed read of an existing key never makes a new key', async () => {
    const bytes = Buffer.from(`sealed:${KEY}`)
    writeFileSync(keyFile, bytes)
    const sealer = fakeSealer({ async: () => Promise.reject(new Error('decrypt failed')), undecryptable: true })
    await expect(databaseKeyLoader(sealer)(dir, dbFile)).resolves.toEqual({ key: null, mode: 'memory-only', reason: 'db-key-undecryptable' })
    expect(sealer.calls.encrypt).toBe(0)
    expect(readFileSync(keyFile)).toEqual(bytes)
  })

  it('an asynchronous failure with the keychain unavailable to the synchronous read: `db-keychain-unavailable`, nothing written', async () => {
    const bytes = writeExistingKey()
    const sealer = fakeSealer({ async: () => Promise.reject(new Error('unavailable')), available: false })
    await expect(databaseKeyLoader(sealer)(dir, dbFile)).resolves.toEqual({ key: null, mode: 'memory-only', reason: 'db-keychain-unavailable' })
    expect(sealer.calls.encrypt).toBe(0)
    expect(readFileSync(keyFile)).toEqual(bytes)
  })

  it('no key file but a DB with contents: the synchronous path of before (`db-key-missing`), the asynchronous one is not asked', async () => {
    writeFileSync(dbFile, 'existing encrypted database')
    const sealer = fakeSealer({})
    await expect(databaseKeyLoader(sealer)(dir, dbFile)).resolves.toEqual({ key: null, mode: 'memory-only', reason: 'db-key-missing' })
    expect(sealer.calls.decryptAsync).toBe(0)
    expect(existsSync(keyFile)).toBe(false)
  })
})

describe('principle 3: one read per launch', () => {
  it('a second caller while a slow read is pending gets the same promise; the keychain is read once', async () => {
    writeExistingKey()
    const slow = deferred<{ result: string; shouldReEncrypt: boolean }>()
    const sealer = fakeSealer({ async: () => slow.promise })
    const load = databaseKeyLoader(sealer)
    const a = load(dir, dbFile)
    const b = load(dir, dbFile)
    expect(b).toBe(a)
    // While it is pending nothing synchronous was tried and nothing was written.
    await Promise.resolve()
    expect(sealer.calls).toEqual({ available: 0, encrypt: 0, decrypt: 0, decryptAsync: 1 })
    slow.resolve({ result: KEY, shouldReEncrypt: false })
    await expect(a).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    await expect(b).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    expect(sealer.calls.decryptAsync).toBe(1)
  })

  it('a late caller after a failed read gets the same degraded answer (it does not try again and decide differently)', async () => {
    const bytes = writeExistingKey()
    const sealer = fakeSealer({ async: () => Promise.reject(new Error('denied')), undecryptable: true })
    const load = databaseKeyLoader(sealer)
    const first = await load(dir, dbFile)
    const late = await load(dir, dbFile)
    expect(late).toEqual(first)
    expect(sealer.calls.decryptAsync).toBe(1)
    expect(sealer.calls.decrypt).toBe(1)
    expect(readFileSync(keyFile)).toEqual(bytes)
  })

  it('two callers on a first launch make one key, not two', async () => {
    const sealer = fakeSealer({})
    const load = databaseKeyLoader(sealer)
    const [a, b] = await Promise.all([load(dir, dbFile), load(dir, dbFile)])
    expect(a).toEqual(b)
    expect(sealer.calls.encrypt).toBe(1)
    expect(readFileSync(keyFile, 'utf8')).toBe(`sealed:${a.key}`)
  })
})

describe('review Y1: a refused keychain and a quit never lead to a second, synchronous keychain read', () => {
  const refused: AsyncDecrypt = () => Promise.reject(new Error(KEYCHAIN_REFUSED_MESSAGE))
  const generic: AsyncDecrypt = () =>
    Promise.reject(new Error('Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.'))

  it('the message is the one Electron 44.4.3 uses for a provider without a key (pinned; a change here needs the source read again)', () => {
    expect(KEYCHAIN_REFUSED_MESSAGE).toBe('safeStorage.decryptStringAsync is temporarily unavailable. Please try again.')
  })

  it('scene 1: Deny in the dialog - no synchronous read at all, memory only, `db.key` and the DB untouched; the next launch asks again', async () => {
    const bytes = writeExistingKey()
    const before = statSync(keyFile).mtimeMs
    const sealer = fakeSealer({ async: refused })
    await expect(databaseKeyLoader(sealer, { refusalIsFinal: true })(dir, dbFile)).resolves.toEqual({
      key: null,
      mode: 'memory-only',
      reason: 'db-keychain-unavailable'
    })
    expect(sealer.calls).toEqual({ available: 0, encrypt: 0, decrypt: 0, decryptAsync: 1 })
    expect(readFileSync(keyFile)).toEqual(bytes)
    expect(statSync(keyFile).mtimeMs).toBe(before)
    expect(readFileSync(dbFile, 'utf8')).toBe('existing encrypted database')

    // The next launch (a new loader) reads the same file again, and this time the keychain answers.
    const next = fakeSealer({})
    await expect(databaseKeyLoader(next, { refusalIsFinal: true })(dir, dbFile)).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    expect(next.calls.decryptAsync).toBe(1)
  })

  it('a late caller after a refusal gets the same answer, still without a synchronous read', async () => {
    writeExistingKey()
    const sealer = fakeSealer({ async: refused })
    const load = databaseKeyLoader(sealer, { refusalIsFinal: true })
    const first = await load(dir, dbFile)
    await expect(load(dir, dbFile)).resolves.toEqual(first)
    expect(sealer.calls).toEqual({ available: 0, encrypt: 0, decrypt: 0, decryptAsync: 1 })
  })

  it('where the refusal is not taken as final (not macOS), it falls back to the synchronous read as before', async () => {
    writeExistingKey()
    const sealer = fakeSealer({ async: refused })
    await expect(databaseKeyLoader(sealer, { refusalIsFinal: false })(dir, dbFile)).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    expect(sealer.calls.decrypt).toBe(1)
  })

  it('the default treats a refusal as final only on macOS', async () => {
    writeExistingKey()
    const sealer = fakeSealer({ async: refused })
    const answer = await databaseKeyLoader(sealer)(dir, dbFile)
    if (isMac()) {
      expect(answer).toEqual({ key: null, mode: 'memory-only', reason: 'db-keychain-unavailable' })
      expect(sealer.calls.decrypt).toBe(0)
    } else {
      expect(answer).toEqual({ key: KEY, mode: 'encrypted', reason: null })
      expect(sealer.calls.decrypt).toBe(1)
    }
  })

  it.each([
    ['no asynchronous entry point', null],
    ['a result of another shape', (() => Promise.resolve({ result: 'not-a-key', shouldReEncrypt: false })) as AsyncDecrypt],
    ['a decrypt failure (not a refusal)', generic],
    ['a message that only looks like the refusal', (() => Promise.reject(new Error('temporarily unavailable'))) as AsyncDecrypt],
    ['a rejection without an Error', (() => Promise.reject('denied')) as AsyncDecrypt]
  ])('%s still falls back to the synchronous read, even where a refusal is final', async (_name, async) => {
    writeExistingKey()
    const sealer = fakeSealer({ async })
    await expect(databaseKeyLoader(sealer, { refusalIsFinal: true })(dir, dbFile)).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    expect(sealer.calls.decrypt).toBe(1)
  })

  it.each([
    ['a refusal', refused],
    ['a decrypt failure', generic],
    ['a result of another shape', (() => Promise.resolve({ result: 'not-a-key', shouldReEncrypt: false })) as AsyncDecrypt]
  ])('scene 2: a quit during the dialog, then %s - no synchronous read, nothing opened, nothing written', async (_name, answer) => {
    const bytes = writeExistingKey()
    const dialog = deferred<void>()
    const sealer = fakeSealer({ async: async (sealed) => dialog.promise.then(() => answer(sealed)) })
    let quitting = false
    const abandoned = (): boolean => quitting
    const load = databaseKeyLoader(sealer, { refusalIsFinal: false })
    const open = vi.fn()
    const result = openAfterKey({ key: () => load(dir, dbFile, { abandoned }), abandoned, open })
    // Cmd+Q while the dialog is up, then the answer comes back.
    quitting = true
    dialog.resolve()
    await expect(result).resolves.toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(sealer.calls).toEqual({ available: 0, encrypt: 0, decrypt: 0, decryptAsync: 1 })
    expect(readFileSync(keyFile)).toEqual(bytes)
    expect(readFileSync(dbFile, 'utf8')).toBe('existing encrypted database')
  })

  it('scene 2 with an older Electron (no asynchronous entry point): a launch already abandoned reads nothing at all', async () => {
    writeExistingKey()
    const sealer = fakeSealer({ async: null })
    await expect(databaseKeyLoader(sealer)(dir, dbFile, { abandoned: () => true })).resolves.toEqual({
      key: null,
      mode: 'memory-only',
      reason: 'db-keychain-unavailable'
    })
    expect(sealer.calls).toEqual({ available: 0, encrypt: 0, decrypt: 0, decryptAsync: 0 })
  })

  it('a first launch abandoned before it makes its key writes no key and reads no keychain', async () => {
    const sealer = fakeSealer({})
    await databaseKeyLoader(sealer)(dir, dbFile, { abandoned: () => true })
    expect(sealer.calls).toEqual({ available: 0, encrypt: 0, decrypt: 0, decryptAsync: 0 })
    expect(existsSync(keyFile)).toBe(false)
  })

  it('a key that arrives after the quit is not used to open anything, and no synchronous read happens', async () => {
    writeExistingKey()
    const dialog = deferred<{ result: string; shouldReEncrypt: boolean }>()
    const sealer = fakeSealer({ async: () => dialog.promise })
    let quitting = false
    const abandoned = (): boolean => quitting
    const open = vi.fn()
    const result = openAfterKey({ key: () => databaseKeyLoader(sealer)(dir, dbFile, { abandoned }), abandoned, open })
    quitting = true
    dialog.resolve({ result: KEY, shouldReEncrypt: false })
    await expect(result).resolves.toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(sealer.calls).toEqual({ available: 0, encrypt: 0, decrypt: 0, decryptAsync: 1 })
  })

  it('without a quit, an unrecognised failure still falls back (the abandon check does not change the normal launch)', async () => {
    writeExistingKey()
    const sealer = fakeSealer({ async: generic })
    await expect(databaseKeyLoader(sealer)(dir, dbFile, { abandoned: () => false })).resolves.toEqual({ key: KEY, mode: 'encrypted', reason: null })
    expect(sealer.calls.decrypt).toBe(1)
  })
})

describe('principle 4: a quit during the wait (openAfterKey)', () => {
  it('a quit that came while the key was pending: nothing is opened', async () => {
    const key = deferred<string>()
    let quitting = false
    const open = vi.fn((k: string) => `db:${k}`)
    const result = openAfterKey({ key: () => key.promise, abandoned: () => quitting, open })
    quitting = true
    key.resolve(KEY)
    await expect(result).resolves.toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  it('without a quit, it opens with the key it was given', async () => {
    const open = vi.fn((k: string) => `db:${k}`)
    await expect(openAfterKey({ key: () => Promise.resolve(KEY), abandoned: () => false, open })).resolves.toEqual({ opened: `db:${KEY}` })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('a key that never arrives only holds the launch itself (nothing else is waiting on it)', async () => {
    const never = new Promise<string>(() => undefined)
    const open = vi.fn()
    const pending = openAfterKey({ key: () => never, abandoned: () => false, open })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    // Other work (a quit's steps, other windows) keeps running while it waits.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('a failure to open passes through unchanged (the downgrade safety net still sees `DatabaseTooNewError`)', async () => {
    class TooNew extends Error {}
    await expect(
      openAfterKey({
        key: () => Promise.resolve(KEY),
        abandoned: () => false,
        open: () => {
          throw new TooNew('too new')
        }
      })
    ).rejects.toBeInstanceOf(TooNew)
  })
})
