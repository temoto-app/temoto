/**
 * TODO 1344 items 1 and 2: the backup passphrases (`backup.pass` / `backup-restore.pass`) sealed through the shared keychain
 * (`src/main/backup/passphrase.ts`). Fake keychains only; the real keychain is never touched.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { passphraseStore, restorePassphraseStore, type PassphraseKeychain } from '../src/main/backup/passphrase.js'
import { SecretUnavailableError, SecretUnreadableError } from '../src/main/keychain/keychain.js'

const seal = (v: string): Buffer => Buffer.from(`v10:${v}`)

interface FakeKeychain extends PassphraseKeychain {
  refused: boolean
  quitting: boolean
  opens: number
  /** Seals waiting to be released (when `hold`). */
  readonly waiting: Array<() => void>
  hold: boolean
  openFailure: Error | null
}

function fakeKeychain(): FakeKeychain {
  const k: FakeKeychain = {
    refused: false,
    quitting: false,
    opens: 0,
    waiting: [],
    hold: false,
    openFailure: null,
    isRefused: () => k.refused,
    closing: () => k.quitting,
    seal: (v) =>
      new Promise<Buffer>((resolve, reject) => {
        const answer = (): void => (k.refused ? reject(new SecretUnavailableError('refused')) : resolve(seal(v)))
        if (k.hold) k.waiting.push(answer)
        else answer()
      }),
    open: async (b) => {
      k.opens += 1
      if (k.refused) throw new SecretUnavailableError('refused')
      if (k.openFailure !== null) throw k.openFailure
      return b.toString().replace(/^v10:/, '')
    }
  }
  return k
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-pass-'))
  file = join(dir, 'backup.pass')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('backup passphrase store on the asynchronous keychain', () => {
  it('reads a passphrase written before TODO 1344, and learns "set" with one unseal (status asks nothing)', async () => {
    writeFileSync(file, seal('old passphrase'), { mode: 0o600 })
    const keychain = fakeKeychain()
    const store = passphraseStore(file, keychain)
    expect(store.isSet()).toBe(false)
    expect(keychain.opens).toBe(0)
    await store.load()
    await store.load()
    expect(store.isSet()).toBe(true)
    expect(keychain.opens).toBe(1)
    expect(await store.get()).toBe('old passphrase')
  })

  it('a refused keychain: not "set" for now, nothing written, the file kept byte for byte, and a new one is not stored over it', async () => {
    writeFileSync(file, seal('kept'), { mode: 0o600 })
    const before = readFileSync(file)
    const mtime = statSync(file).mtimeMs
    const keychain = fakeKeychain()
    keychain.refused = true
    const store = passphraseStore(file, keychain)
    await store.load()
    expect(store.isSet()).toBe(false)
    expect(store.available()).toBe(false)
    expect(await store.get()).toBeNull()
    await expect(store.set('another passphrase')).rejects.toBeInstanceOf(SecretUnavailableError)
    expect(readFileSync(file)).toEqual(before)
    expect(statSync(file).mtimeMs).toBe(mtime)
    // The next launch (the keychain answers) reads it again.
    const next = passphraseStore(file, fakeKeychain())
    await next.load()
    expect(next.isSet()).toBe(true)
    expect(await next.get()).toBe('kept')
  })

  it('an unsealable file (keychain item lost) reads as not set and is never deleted or rewritten', async () => {
    writeFileSync(file, seal('lost'), { mode: 0o600 })
    const before = readFileSync(file)
    const keychain = fakeKeychain()
    keychain.openFailure = new SecretUnreadableError()
    const store = passphraseStore(file, keychain)
    await store.load()
    expect(store.isSet()).toBe(false)
    expect(await store.get()).toBeNull()
    expect(readFileSync(file)).toEqual(before)
  })

  it('writes are applied in the order asked even when the first seal finishes last; the file is 0600 and replaced atomically', async () => {
    const keychain = fakeKeychain()
    keychain.hold = true
    const store = passphraseStore(file, keychain)
    const first = store.set('first passphrase')
    const second = store.set('second passphrase')
    await tick()
    // One seal at a time: the second waits for the first to be written.
    expect(keychain.waiting).toHaveLength(1)
    keychain.waiting.shift()!()
    await first
    await tick()
    keychain.waiting.shift()!()
    await second
    expect(readFileSync(file).toString()).toBe('v10:second passphrase')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['backup.pass'])
    expect(store.isSet()).toBe(true)
  })

  it('an unseal that began before a set cannot put back the older answer', async () => {
    const keychain = fakeKeychain()
    const store = passphraseStore(file, keychain)
    const loading = store.load()
    await store.set('new passphrase')
    await loading
    expect(store.isSet()).toBe(true)
  })

  it('a quit: no seal starts, and a seal that finishes during the quit writes nothing', async () => {
    const keychain = fakeKeychain()
    keychain.hold = true
    const store = passphraseStore(file, keychain)
    const setting = store.set('during the quit')
    await tick()
    keychain.quitting = true
    keychain.waiting.shift()!()
    await expect(setting).rejects.toMatchObject({ miss: 'abandoned' })
    expect(existsSync(file)).toBe(false)
    await expect(store.set('after the quit')).rejects.toMatchObject({ miss: 'abandoned' })
    expect(keychain.waiting).toHaveLength(0)
    expect(existsSync(file)).toBe(false)
  })

  it('the restore passphrase uses the same rules', async () => {
    const restoreFile = join(dir, 'backup-restore.pass')
    const keychain = fakeKeychain()
    const store = restorePassphraseStore(restoreFile, keychain)
    expect(await store.get()).toBeNull()
    await store.set('typed for the restore')
    expect(await store.get()).toBe('typed for the restore')
    keychain.refused = true
    expect(await store.get()).toBeNull()
    expect(existsSync(restoreFile)).toBe(true)
  })
})

describe('wave 108 fix Y1: a read and a set that overlap never leave the wrong "set" answer', () => {
  /** A keychain whose unseals and seals wait until the test releases them, one at a time, in the order it chooses. */
  function heldKeychain(): PassphraseKeychain & { opens: Array<() => void>; seals: Array<() => void>; sealFails: boolean } {
    const k = {
      opens: [] as Array<() => void>,
      seals: [] as Array<() => void>,
      sealFails: false,
      isRefused: () => false,
      closing: () => false,
      open: (b: Buffer) =>
        new Promise<string>((resolve, reject) => {
          k.opens.push(() => {
            const text = b.toString()
            if (text.startsWith('v10:lost')) reject(new SecretUnreadableError())
            else resolve(text.replace(/^v10:/, ''))
          })
        }),
      seal: (v: string) =>
        new Promise<Buffer>((resolve, reject) => {
          k.seals.push(() => (k.sealFails ? reject(new SecretUnavailableError('refused')) : resolve(seal(v))))
        })
    }
    return k
  }

  type Order = 'get ends first' | 'set ends first' | 'get wraps the set'
  const cases: Array<[initial: 'lost' | 'valid', set: 'ok' | 'fails', order: Order, expected: boolean]> = []
  for (const initial of ['lost', 'valid'] as const) {
    for (const outcome of ['ok', 'fails'] as const) {
      for (const order of ['get ends first', 'set ends first', 'get wraps the set'] as const) {
        // A successful set always leaves "set"; a failed one leaves what the file holds (unchanged).
        cases.push([initial, outcome, order, outcome === 'ok' || initial === 'valid'])
      }
    }
  }

  it.each(cases)('stored passphrase %s, set %s, %s -> isSet %s', async (initial, outcome, order, expected) => {
    writeFileSync(file, seal(initial === 'lost' ? 'lost item' : 'old passphrase'), { mode: 0o600 })
    const keychain = heldKeychain()
    keychain.sealFails = outcome === 'fails'
    const store = passphraseStore(file, keychain)
    const loading = store.load()
    await tick()
    keychain.opens.shift()!()
    await loading
    expect(store.isSet()).toBe(initial === 'valid')

    let getting: Promise<string | null>
    let setting: Promise<void>
    if (order === 'get wraps the set') {
      getting = store.get()
      await tick()
      setting = store.set('new passphrase')
    } else {
      setting = store.set('new passphrase')
      await tick()
      getting = store.get()
    }
    const settledSet = setting.then(
      () => 'ok',
      () => 'failed'
    )
    await tick()
    expect(keychain.opens).toHaveLength(1)
    expect(keychain.seals).toHaveLength(1)
    if (order === 'get ends first') {
      keychain.opens.shift()!()
      await getting
      keychain.seals.shift()!()
      await settledSet
    } else {
      keychain.seals.shift()!()
      await settledSet
      keychain.opens.shift()!()
      await getting
    }
    expect(await settledSet).toBe(outcome === 'ok' ? 'ok' : 'failed')
    expect(store.isSet()).toBe(expected)
    expect(readFileSync(file).toString()).toBe(
      outcome === 'ok' ? 'v10:new passphrase' : initial === 'lost' ? 'v10:lost item' : 'v10:old passphrase'
    )
  })
})
