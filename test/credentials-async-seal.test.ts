/**
 * TODO 1344 items 1 and 2: the plugin credentials sealed through the asynchronous keychain entry point. Fake sealers only (slow,
 * refusing, failing); the real keychain is never touched.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore, type SecretSealer } from '../src/main/capability/credentials.js'
import { OAuthError } from '../src/main/capability/google-oauth.js'
import { SecretUnavailableError, SecretUnreadableError } from '../src/main/keychain/keychain.js'

const NAME = 'google:gmail.readonly'
const HOST = 'gmail.googleapis.com'
const NOW = 1_000_000

const seal = (v: string): Buffer => Buffer.from(`sealed:${v.split('').reverse().join('')}`)
const open = (b: Buffer): string => b.toString().replace(/^sealed:/, '').split('').reverse().join('')

/** A sealer whose seals wait until released, one by one, in any order the test chooses. */
function slowSealer(): { sealer: SecretSealer; pending: Array<{ value: string; release: () => void }> } {
  const pending: Array<{ value: string; release: () => void }> = []
  return {
    pending,
    sealer: {
      available: () => true,
      seal: (value) =>
        new Promise<Buffer>((resolve) => {
          pending.push({ value, release: () => resolve(seal(value)) })
        }),
      open: async (b) => open(b)
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-cred-async-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const file = (): string => join(dir, 'credentials.json')

describe('CredentialStore with an asynchronous sealer', () => {
  it('applies puts in the order they were made, even when the first seal finishes last', async () => {
    const { sealer, pending } = slowSealer()
    const store = new CredentialStore(dir, sealer)
    const first = store.put('static', { value: 'Bearer one', host: 'api.example.com' })
    const second = store.put('static', { value: 'Bearer two', host: 'api.example.com' })
    await flush()
    // Only one seal is in flight: the second waits for the first to be written.
    expect(pending.map((entry) => entry.value)).toEqual(['Bearer one'])
    pending[0]!.release()
    await first
    await flush()
    pending[1]!.release()
    await second
    expect((await store.headerFor('static'))?.value).toBe('Bearer two')
    expect((await new CredentialStore(dir, sealer).headerFor('static'))?.value).toBe('Bearer two')
  })

  it('a removal made while a put is sealing stays removed', async () => {
    const { sealer, pending } = slowSealer()
    const store = new CredentialStore(dir, sealer)
    const putting = store.put('static', { value: 'Bearer one', host: 'api.example.com' })
    const removing = store.remove('static')
    await flush()
    pending[0]!.release()
    await putting
    await removing
    expect(store.names()).toEqual([])
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({})
  })

  it('writes the file atomically with mode 0600 and leaves no temporary file', async () => {
    const store = new CredentialStore(dir, { available: () => true, seal: async (v) => seal(v), open: async (b) => open(b) })
    await store.put('static', { value: 'Bearer x', host: 'api.example.com' })
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['credentials.json'])
    expect(readFileSync(file(), 'utf8')).not.toContain('Bearer x')
  })

  it('nothing is written after stop(): a seal that finishes during the quit is dropped, and new writes are refused', async () => {
    const { sealer, pending } = slowSealer()
    const store = new CredentialStore(dir, sealer)
    const putting = store.put('static', { value: 'Bearer one', host: 'api.example.com' })
    await flush()
    await store.stop()
    pending[0]!.release()
    await expect(putting).rejects.toThrow()
    expect(() => statSync(file())).toThrow()
    await expect(store.put('other', { value: 'Bearer two', host: 'api.example.com' })).rejects.toThrow()
    await expect(store.remove('static')).rejects.toThrow()
    expect(() => statSync(file())).toThrow()
  })

  it('a keychain that cannot be used now gives no header and keeps the stored value as it was', async () => {
    const writer = new CredentialStore(dir, { available: () => true, seal: async (v) => seal(v), open: async (b) => open(b) })
    await writer.put('static', { value: 'Bearer x', host: 'api.example.com' })
    const before = readFileSync(file())
    const mtime = statSync(file()).mtimeMs
    const refused = new CredentialStore(dir, {
      available: () => false,
      seal: async () => {
        throw new SecretUnavailableError('refused')
      },
      open: async () => {
        throw new SecretUnavailableError('refused')
      }
    })
    expect(await refused.headerFor('static')).toBeNull()
    expect(await refused.headerForAsync('static')).toBeNull()
    expect(refused.status('static').present).toBe(true)
    await expect(refused.put('static', { value: 'Bearer y', host: 'api.example.com' })).rejects.toThrow('secret storage unavailable')
    expect(readFileSync(file())).toEqual(before)
    expect(statSync(file()).mtimeMs).toBe(mtime)
  })
})

describe('refresh while the keychain is unavailable or the credential changed', () => {
  const putExpired = async (store: CredentialStore, refreshToken = 'rt-1'): Promise<void> =>
    store.putOAuth(NAME, { host: HOST, accessToken: 'at-1', refreshToken, expiresAt: NOW - 1, scope: 's' })

  it('a refresh token that cannot be unsealed because the keychain refused does not ask for a new sign-in and writes nothing', async () => {
    const plain: SecretSealer = { available: () => true, seal: async (v) => seal(v), open: async (b) => open(b) }
    await putExpired(new CredentialStore(dir, plain))
    const before = readFileSync(file())
    const store = new CredentialStore(dir, {
      ...plain,
      open: async () => {
        throw new SecretUnavailableError('refused')
      }
    })
    let called = false
    store.setRefresher(NAME, async () => {
      called = true
      return { accessToken: 'at-2', refreshToken: null, expiresAt: NOW + 3_600_000, scope: 's' }
    })
    await expect(store.headerForAsync(NAME, () => NOW)).rejects.toThrow()
    expect(called).toBe(false)
    expect(store.needsReauth(NAME)).toBe(false)
    expect(readFileSync(file())).toEqual(before)
  })

  it('a refresh token that the keychain cannot read (another key) still asks for a new sign-in, without deleting it', async () => {
    const plain: SecretSealer = { available: () => true, seal: async (v) => seal(v), open: async (b) => open(b) }
    await putExpired(new CredentialStore(dir, plain))
    const store = new CredentialStore(dir, {
      ...plain,
      open: async () => {
        throw new SecretUnreadableError()
      }
    })
    store.setRefresher(NAME, async () => ({ accessToken: 'at-2', refreshToken: null, expiresAt: NOW + 3_600_000, scope: 's' }))
    expect(await store.headerForAsync(NAME, () => NOW)).toBeNull()
    expect(store.needsReauth(NAME)).toBe(true)
    expect(store.names()).toEqual([NAME])
  })

  it('invalid-grant that arrives after a new sign-in does not flag the new sign-in', async () => {
    const store = new CredentialStore(dir, { available: () => true, seal: async (v) => seal(v), open: async (b) => open(b) })
    await putExpired(store)
    let fail: () => void = () => undefined
    store.setRefresher(
      NAME,
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new OAuthError('invalid-grant', 'revoked'))
        })
    )
    const refreshing = store.headerForAsync(NAME, () => NOW)
    await flush()
    await store.putOAuth(NAME, { host: HOST, accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: NOW + 3_600_000, scope: 's' })
    fail()
    await refreshing.catch(() => undefined)
    expect(store.needsReauth(NAME)).toBe(false)
    expect((await store.headerFor(NAME))?.value).toBe('Bearer at-new')
    expect(await store.refreshTokenOf(NAME)).toBe('rt-new')
  })

  it('a refresh result that arrives after a new sign-in does not overwrite it, even when its sealing is slow', async () => {
    const { sealer, pending } = slowSealer()
    const store = new CredentialStore(dir, sealer)
    /** Releases every seal as it comes until all of `work` has settled. */
    const drain = async (...work: Array<Promise<unknown>>): Promise<void> => {
      let done = false
      void Promise.allSettled(work).then(() => (done = true))
      for (let round = 0; round < 50 && !done; round += 1) {
        for (const entry of pending.splice(0)) entry.release()
        await flush()
      }
    }
    const first = store.putOAuth(NAME, { host: HOST, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: NOW - 1, scope: 's' })
    await drain(first)
    await first
    let answer: () => void = () => undefined
    store.setRefresher(
      NAME,
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ accessToken: 'at-refreshed', refreshToken: 'rt-refreshed', expiresAt: NOW + 10, scope: 's' })
        })
    )
    const refreshing = store.headerForAsync(NAME, () => NOW)
    await flush()
    // The user signs in again; its seals are still pending when the refresh's answer arrives (so the refresh's write queues behind it).
    const again = store.putOAuth(NAME, { host: HOST, accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: NOW + 3_600_000, scope: 's' })
    await flush()
    answer()
    await flush()
    await drain(again, refreshing)
    await again
    await refreshing.catch(() => undefined)
    expect(await store.refreshTokenOf(NAME)).toBe('rt-new')
    expect((await store.headerFor(NAME))?.value).toBe('Bearer at-new')
  })
})

describe('wave 108 fix Y2: a refresh whose row was removed or replaced while it waited in the queue withdraws quietly', () => {
  /** An expired OAuth row, then a refresh that answers without a new refresh token while the queue is held by another put. */
  async function setUp(): Promise<{
    store: CredentialStore
    pending: Array<{ value: string; release: () => void }>
    answer: () => void
    refreshing: Promise<{ value: string } | null>
  }> {
    const { sealer, pending } = slowSealer()
    const store = new CredentialStore(dir, sealer)
    const first = store.putOAuth(NAME, { host: HOST, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: NOW - 1, scope: 's' })
    await drain(pending, first)
    await first
    let answer: () => void = () => undefined
    store.setRefresher(
      NAME,
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ accessToken: 'at-refreshed', refreshToken: null, expiresAt: NOW + 10, scope: 's' })
        })
    )
    const refreshing = store.headerForAsync(NAME, () => NOW)
    await flush()
    return { store, pending, answer: () => answer(), refreshing }
  }

  const drain = async (pending: Array<{ release: () => void }>, ...work: Array<Promise<unknown>>): Promise<void> => {
    let done = false
    void Promise.allSettled(work).then(() => (done = true))
    for (let round = 0; round < 50 && !done; round += 1) {
      for (const entry of pending.splice(0)) entry.release()
      await flush()
    }
  }

  it('a removal queued before the refresh result: no error, no header, nothing written back', async () => {
    const { store, pending, answer, refreshing } = await setUp()
    // Another write holds the queue (its seal waits); the sign-out queues behind it, then the refresh's answer arrives.
    const other = store.put('static', { value: 'Bearer other', host: 'api.example.com' })
    const removing = store.remove(NAME)
    await flush()
    answer()
    await flush()
    await drain(pending, other, removing, refreshing)
    await expect(refreshing).resolves.toBeNull()
    expect(store.names()).toEqual(['static'])
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8')) as object)).toEqual(['static'])
  })

  it('a row replaced by a static put while queued (no refresh token in it): no error, the new row is untouched', async () => {
    const { store, pending, answer, refreshing } = await setUp()
    const other = store.put('static', { value: 'Bearer other', host: 'api.example.com' })
    const replacing = store.put(NAME, { value: 'Bearer replaced', host: HOST })
    await flush()
    answer()
    await flush()
    await drain(pending, other, replacing, refreshing)
    await expect(refreshing).resolves.toMatchObject({ value: 'Bearer replaced' })
    expect((await store.headerFor(NAME))?.value).toBe('Bearer replaced')
    expect(store.needsReauth(NAME)).toBe(false)
  })

  it('a new sign-in queued before the refresh result: no error, the new sign-in is kept as it is', async () => {
    const { store, pending, answer, refreshing } = await setUp()
    const other = store.put('static', { value: 'Bearer other', host: 'api.example.com' })
    const again = store.putOAuth(NAME, { host: HOST, accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: NOW + 3_600_000, scope: 's' })
    await flush()
    answer()
    await flush()
    await drain(pending, other, again, refreshing)
    await expect(refreshing).resolves.toMatchObject({ value: 'Bearer at-new' })
    expect(await store.refreshTokenOf(NAME)).toBe('rt-new')
    expect(store.needsReauth(NAME)).toBe(false)
  })
})
