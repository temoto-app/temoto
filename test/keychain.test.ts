/**
 * TODO 1344 items 1 and 2: the shared keychain on `safeStorage`'s asynchronous entry points (`src/main/keychain/keychain.ts`).
 * Fake storages only (slow, refusing, failing, without the asynchronous entry points); the real keychain is never touched.
 */
import { describe, expect, it } from 'vitest'
import {
  KEYCHAIN_REFUSED_MESSAGE,
  KEYCHAIN_SEAL_NO_KEY_MESSAGE,
  Keychain,
  SecretUnavailableError,
  SecretUnreadableError,
  type KeychainStorage
} from '../src/main/keychain/keychain.js'
import { KEYCHAIN_REFUSED_MESSAGE as DB_KEY_REFUSED_MESSAGE } from '../src/main/db/key.js'

const seal = (v: string): Buffer => Buffer.from(`v10:${v}`)
const open = (b: Buffer): string => {
  const text = b.toString()
  if (!text.startsWith('v10:')) throw new Error('bad')
  return text.slice(4)
}

type Outcome = { kind: 'ok' } | { kind: 'reject'; message: string }

interface Fake {
  readonly storage: KeychainStorage
  readonly calls: { syncAvailable: number; syncSeal: number; syncOpen: number; asyncSeal: number; asyncOpen: number }
  /** Async calls waiting for `answer` (when `hold` is on). */
  readonly waiting: Array<() => void>
  hold: boolean
  outcome: Outcome
  syncAvailable: boolean
}

function fake(options: { async?: boolean } = {}): Fake {
  const calls = { syncAvailable: 0, syncSeal: 0, syncOpen: 0, asyncSeal: 0, asyncOpen: 0 }
  const f: Fake = {
    calls,
    waiting: [],
    hold: false,
    outcome: { kind: 'ok' },
    syncAvailable: true,
    storage: {
      isEncryptionAvailable: () => {
        calls.syncAvailable += 1
        return f.syncAvailable
      },
      encryptString: (v) => {
        calls.syncSeal += 1
        return seal(v)
      },
      decryptString: (b) => {
        calls.syncOpen += 1
        return open(b)
      }
    }
  }
  const settle = <T>(value: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const answer = (): void => {
        const outcome = f.outcome
        if (outcome.kind === 'reject') reject(new Error(outcome.message))
        else {
          try {
            resolve(value())
          } catch (err) {
            reject(new Error('Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.'))
            void err
          }
        }
      }
      if (f.hold) f.waiting.push(answer)
      else setImmediate(answer)
    })
  if (options.async !== false) {
    Object.assign(f.storage, {
      encryptStringAsync: (v: string) => {
        calls.asyncSeal += 1
        return settle(() => seal(v))
      },
      decryptStringAsync: (b: Buffer) => {
        calls.asyncOpen += 1
        return settle(() => ({ result: open(b), shouldReEncrypt: false }))
      }
    })
  }
  return f
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const syncCalls = (f: Fake): number => f.calls.syncAvailable + f.calls.syncSeal + f.calls.syncOpen

describe('Keychain: the asynchronous entry points', () => {
  it('seals and unseals with the asynchronous entry points only, and the bytes are what the synchronous side writes', async () => {
    const f = fake()
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true })
    const sealed = await keychain.seal('secret')
    expect(sealed).toEqual(f.storage.encryptString('secret'))
    f.calls.syncSeal = 0
    expect(await keychain.open(sealed)).toBe('secret')
    expect(syncCalls(f)).toBe(0)
    expect(f.calls.asyncSeal).toBe(1)
    expect(f.calls.asyncOpen).toBe(1)
  })

  it('a value written by the synchronous side (every file written before TODO 1344) is read by the asynchronous side', async () => {
    const f = fake()
    const old = f.storage.encryptString('written by 0.106')
    f.calls.syncSeal = 0
    expect(await new Keychain(() => f.storage).open(old)).toBe('written by 0.106')
    expect(syncCalls(f)).toBe(0)
  })

  it('without the asynchronous entry points (an older Electron, a fake) the synchronous ones are used', async () => {
    const f = fake({ async: false })
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true })
    const sealed = await keychain.seal('secret')
    expect(await keychain.open(sealed)).toBe('secret')
    expect(f.calls.syncSeal).toBe(1)
    expect(f.calls.syncOpen).toBe(1)
    f.syncAvailable = false
    await expect(keychain.seal('x')).rejects.toBeInstanceOf(SecretUnavailableError)
    await expect(keychain.open(sealed)).rejects.toBeInstanceOf(SecretUnavailableError)
  })

  it('the refusal text is the one the DB key matches (one definition)', () => {
    expect(DB_KEY_REFUSED_MESSAGE).toBe(KEYCHAIN_REFUSED_MESSAGE)
    expect(KEYCHAIN_REFUSED_MESSAGE).toBe('safeStorage.decryptStringAsync is temporarily unavailable. Please try again.')
    expect(KEYCHAIN_SEAL_NO_KEY_MESSAGE).toBe('Error while encrypting the text provided to safeStorage.encryptStringAsync.')
  })
})

describe('Keychain: a refusal is final for the launch (macOS rule)', () => {
  it.each([
    ['open', KEYCHAIN_REFUSED_MESSAGE],
    ['seal', KEYCHAIN_SEAL_NO_KEY_MESSAGE]
  ] as const)('a refused %s never asks the synchronous side, and later calls ask nothing at all', async (op, message) => {
    const f = fake()
    f.outcome = { kind: 'reject', message }
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true })
    const first = op === 'open' ? keychain.open(seal('x')) : keychain.seal('x')
    await expect(first).rejects.toMatchObject({ miss: 'refused' })
    expect(keychain.isRefused()).toBe(true)
    const asked = f.calls.asyncOpen + f.calls.asyncSeal
    await expect(keychain.open(seal('y'))).rejects.toMatchObject({ miss: 'refused' })
    await expect(keychain.seal('y')).rejects.toMatchObject({ miss: 'refused' })
    expect(f.calls.asyncOpen + f.calls.asyncSeal).toBe(asked)
    expect(syncCalls(f)).toBe(0)
  })

  it('a launch whose DB key found the keychain refused asks nothing', async () => {
    const f = fake()
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true, refused: true })
    await expect(keychain.open(seal('x'))).rejects.toMatchObject({ miss: 'refused' })
    await expect(keychain.seal('x')).rejects.toMatchObject({ miss: 'refused' })
    expect(f.calls.asyncOpen + f.calls.asyncSeal + syncCalls(f)).toBe(0)
  })

  it('outside macOS (refusalIsFinal: false) a refusal falls back to the synchronous side, as the DB key does', async () => {
    const f = fake()
    f.outcome = { kind: 'reject', message: KEYCHAIN_REFUSED_MESSAGE }
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: false })
    expect(await keychain.open(seal('x'))).toBe('x')
    expect(f.calls.syncOpen).toBe(1)
    expect(keychain.isRefused()).toBe(false)
  })

  it.each([
    'Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.',
    'safeStorage.decryptStringAsync is temporarily unavailable.',
    'something new'
  ])('any other rejection (%s) falls back to the synchronous side', async (message) => {
    const f = fake()
    f.outcome = { kind: 'reject', message }
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true })
    expect(await keychain.open(seal('x'))).toBe('x')
    expect(f.calls.syncOpen).toBe(1)
    expect(keychain.isRefused()).toBe(false)
  })

  it('a value that the synchronous side cannot unseal either is "unreadable", not "unavailable"', async () => {
    const f = fake()
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true })
    await expect(keychain.open(Buffer.from('garbage'))).rejects.toBeInstanceOf(SecretUnreadableError)
  })

  it('an entry point that throws instead of rejecting is treated as a rejection', async () => {
    const f = fake()
    Object.assign(f.storage, {
      decryptStringAsync: () => {
        throw new Error(KEYCHAIN_REFUSED_MESSAGE)
      }
    })
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true })
    await expect(keychain.open(seal('x'))).rejects.toMatchObject({ miss: 'refused' })
    expect(syncCalls(f)).toBe(0)
  })
})

describe('Keychain: one question at a time', () => {
  it('while the first question is open (a dialog may be up), the other callers wait behind it and add none', async () => {
    const f = fake()
    f.hold = true
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true })
    const all = [keychain.open(seal('a')), keychain.open(seal('b')), keychain.seal('c'), keychain.open(seal('d'))]
    await tick()
    expect(f.calls.asyncOpen + f.calls.asyncSeal).toBe(1)
    expect(f.waiting).toHaveLength(1)
    f.hold = false
    f.waiting.shift()!()
    const results = await Promise.all(all)
    expect(results.slice(0, 2)).toEqual(['a', 'b'])
    expect(results[3]).toBe('d')
    expect(syncCalls(f)).toBe(0)
  })

  it('when the first question is refused, the callers behind it fail without asking anything', async () => {
    const f = fake()
    f.hold = true
    f.outcome = { kind: 'reject', message: KEYCHAIN_REFUSED_MESSAGE }
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true })
    const all = [keychain.open(seal('a')), keychain.open(seal('b')), keychain.seal('c')].map((p) =>
      p.then(
        () => 'resolved',
        (err: unknown) => (err instanceof SecretUnavailableError ? err.miss : 'other')
      )
    )
    await tick()
    f.waiting.shift()!()
    expect(await Promise.all(all)).toEqual(['refused', 'refused', 'refused'])
    expect(f.calls.asyncOpen + f.calls.asyncSeal).toBe(1)
    expect(syncCalls(f)).toBe(0)
  })
})

describe('Keychain: quitting', () => {
  it('before the key is held, a quit asks nothing (neither side)', async () => {
    const f = fake()
    let quitting = true
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true, abandoned: () => quitting })
    await expect(keychain.open(seal('x'))).rejects.toMatchObject({ miss: 'abandoned' })
    await expect(keychain.seal('x')).rejects.toMatchObject({ miss: 'abandoned' })
    expect(f.calls.asyncOpen + f.calls.asyncSeal + syncCalls(f)).toBe(0)
    quitting = false
  })

  it('without the asynchronous entry points, a quit never reads the keychain synchronously', async () => {
    const f = fake({ async: false })
    const keychain = new Keychain(() => f.storage, { abandoned: () => true })
    await expect(keychain.open(seal('x'))).rejects.toMatchObject({ miss: 'abandoned' })
    expect(syncCalls(f)).toBe(0)
  })

  it('once the key is held (an earlier call succeeded), a call during the quit goes ahead (nothing is asked)', async () => {
    const f = fake()
    let quitting = false
    const keychain = new Keychain(() => f.storage, { refusalIsFinal: true, abandoned: () => quitting })
    await keychain.seal('warm')
    quitting = true
    expect(await keychain.open(seal('x'))).toBe('x')
  })

  it.each([KEYCHAIN_REFUSED_MESSAGE, 'Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.'])(
    'a quit that began during the question never falls back to the synchronous side (%s)',
    async (message) => {
      const f = fake()
      f.hold = true
      f.outcome = { kind: 'reject', message }
      let quitting = false
      const keychain = new Keychain(() => f.storage, { refusalIsFinal: false, abandoned: () => quitting })
      const opening = keychain.open(seal('x'))
      await tick()
      quitting = true
      f.waiting.shift()!()
      await expect(opening).rejects.toMatchObject({ miss: 'abandoned' })
      expect(syncCalls(f)).toBe(0)
    }
  )
})
