/**
 * TODO 687: in a verification build (proxy verification) only, a switch that points the reading place of the Chrome import (676) at a fake location.
 * In the 36th proxy verification (TODO 690), `os.homedir` (a built-in of ESM) could not be replaced from main's inspector, and the owner's real Chrome profile name and count
 * appeared on screen: an accident. This switch is placed in the side of main that depends on electron (`src/main/web/register.ts`) as the environment variable
 * `AIOS_CHROME_HOME_DIR` (renamed from `AIOS_CHROME_BASE_DIR` in code-review: what it does is replace the base of HOME), and is **always ignored in the distributed build (`app.isPackaged`)**.
 * The reading-side pure functions (`chrome-import.ts` / `chrome-bookmarks.ts`) do not read the env: here only `chromeHomeOverride` / `chromeImportBlocked` in `register.ts`
 * and `chromeBookmarksBaseDir` in `chrome-import.ts` are checked. The model is not used.
 *
 * **Code-review fix (2026-10-11): in a launch whose userData is not the default (`--user-data-dir`), if there is no replacement, the Chrome import is refused by default
 * (`chromeImportBlocked`). This prevents a recurrence of the accident (690), where the real Chrome was read while the replacement did not take effect.
 * The dev of the default userData (`npm run dev`) and the distributed build read the real thing as before.**
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const mockApp: {
  isPackaged: boolean
  getFileIcon: (path: string, opts: unknown) => Promise<{ isEmpty(): boolean; toDataURL(): string }>
} = {
  isPackaged: false,
  getFileIcon: async () => ({ isEmpty: () => true, toDataURL: () => '' })
}
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
// TODO 723: replace `existsSync` (node:fs) of `chromeAppIcon`. It does not depend on the real `/Applications`.
let fakeExists = (path: string): boolean => path === ''

// TODO 761: the page session (`webSession`) is created once and cached (`configured` in `register.ts`), so the contents of `fetch`, not the session itself,
// are put in a `vi.hoisted` box so that each test can replace them (`vi.mock` is hoisted).
const sessionFetch = vi.hoisted((): { impl: (url: string, init?: unknown) => Promise<Response> } => ({
  impl: () => Promise.resolve(new Response(null, { status: 404 }))
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: (path: string) => fakeExists(path) }
})

// TODO 929: favicon is fetched with `net.request` (one hop at a time) + `dns.lookup` (the check on the inside). It does not touch the real network or DNS:
// name resolution is one public address, and `net.request` is a fake that only streams the response of `sessionFetch.impl`.
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>()
  return {
    ...actual,
    lookup: (_host: string, _opts: unknown, cb: (err: null, addresses: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: '93.184.215.14', family: 4 }])
  }
})

function fakeNetRequest(options: { url: string }): unknown {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const emit = (event: string, ...args: unknown[]): void => {
    for (const fn of listeners.get(event) ?? []) fn(...args)
  }
  return {
    on(event: string, fn: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      return this
    },
    abort: () => undefined,
    end() {
      void sessionFetch.impl(options.url).then(
        async (response) => {
          const body = new Uint8Array(await response.arrayBuffer())
          const data: ((chunk: Buffer) => void)[] = []
          const end: (() => void)[] = []
          emit('response', {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            on(event: string, fn: (...args: never[]) => void) {
              if (event === 'data') data.push(fn as (chunk: Buffer) => void)
              if (event === 'end') end.push(fn as () => void)
            }
          })
          if (body.byteLength > 0) for (const fn of data) fn(Buffer.from(body))
          for (const fn of end) fn()
        },
        (err: unknown) => emit('error', err)
      )
    }
  }
}

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  WebContentsView: class {},
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: () => undefined
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      setDevicePermissionHandler: () => undefined,
      on: () => undefined,
      setUserAgent: () => undefined,
      getUserAgent: () => '',
      fetch: (url: string, init?: unknown) => sessionFetch.impl(url, init)
    })
  },
  shell: { openExternal: async () => undefined },
  net: { request: (options: { url: string }) => fakeNetRequest(options) }
}))

const { chromeHomeOverride, chromeImportBlocked, registerWebViewHandlers, backfillFavoriteFavicons, MAX_FAVICON_BACKFILL } =
  await import('../src/main/web/register.js')
const { chromeBookmarksBaseDir } = await import('../src/main/web/chrome-import.js')
const { IpcChannel } = await import('../src/shared/ipc.js')

const ENV_KEY = 'AIOS_CHROME_HOME_DIR'

describe('chromeHomeOverride (TODO 687)', () => {
  const original = process.env[ENV_KEY]

  beforeEach(() => {
    mockApp.isPackaged = false
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = original
  })

  it('undefined when env is absent (uses the default homedir())', () => {
    expect(chromeHomeOverride()).toBeUndefined()
  })

  it('for a test build (isPackaged false) + env, returns that value', () => {
    process.env[ENV_KEY] = '/tmp/fake-chrome-home'
    expect(chromeHomeOverride()).toBe('/tmp/fake-chrome-home')
  })

  it('for a shipped build (isPackaged true), always ignores env even if present', () => {
    process.env[ENV_KEY] = '/tmp/fake-chrome-home'
    mockApp.isPackaged = true
    expect(chromeHomeOverride()).toBeUndefined()
  })

  it('an empty string is ignored (undefined)', () => {
    process.env[ENV_KEY] = ''
    expect(chromeHomeOverride()).toBeUndefined()
  })
})

describe('chromeImportBlocked (TODO 687 code-review)', () => {
  const original = process.env[ENV_KEY]

  beforeEach(() => {
    mockApp.isPackaged = false
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = original
  })

  it('does not refuse with the default userData even without an override', () => {
    expect(chromeImportBlocked(true)).toBe(false)
  })

  it('refuses with a non-default userData (--user-data-dir) and no override', () => {
    expect(chromeImportBlocked(false)).toBe(true)
  })

  it('does not refuse with a non-default userData if there is an override (AIOS_CHROME_HOME_DIR)', () => {
    process.env[ENV_KEY] = '/tmp/fake-chrome-home'
    expect(chromeImportBlocked(false)).toBe(false)
  })

  it('in a shipped build the override is ignored, so refuses a non-default userData (even with env)', () => {
    process.env[ENV_KEY] = '/tmp/fake-chrome-home'
    mockApp.isPackaged = true
    expect(chromeImportBlocked(false)).toBe(true)
  })
})

describe('IPC of webChromeProfiles / webChromeImport (TODO 687 code-review)', () => {
  const original = process.env[ENV_KEY]

  beforeEach(() => {
    mockApp.isPackaged = false
    delete process.env[ENV_KEY]
    handlers.clear()
  })

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = original
  })

  it('with a non-default userData and no override, webChromeProfiles refuses with chrome-import-blocked', async () => {
    registerWebViewHandlers('aios', { data: null, settings: null, defaultUserData: false })
    const handler = handlers.get(IpcChannel.webChromeProfiles)
    expect(handler).toBeDefined()
    await expect(handler!({})).rejects.toThrow('aios-reason:chrome-import-blocked')
  })

  it('with a non-default userData and no override, webChromeImport also refuses', async () => {
    // If `data` is null, the early return 'DB is not usable' would be hit first, so a fake non-null value is passed
    // (it does not reach the import; it only confirms that the refusal comes first).
    const fakeData = {} as NonNullable<Parameters<typeof registerWebViewHandlers>[1]>['data']
    registerWebViewHandlers('aios', { data: fakeData, settings: null, defaultUserData: false })
    const handler = handlers.get(IpcChannel.webChromeImport)
    expect(handler).toBeDefined()
    await expect(handler!({}, 'Default')).rejects.toThrow('aios-reason:chrome-import-blocked')
  })

  it('does not refuse with a non-default userData if there is an override (AIOS_CHROME_HOME_DIR)', async () => {
    process.env[ENV_KEY] = '/tmp/aios-test-chrome-home-does-not-exist'
    registerWebViewHandlers('aios', { data: null, settings: null, defaultUserData: false })
    const handler = handlers.get(IpcChannel.webChromeProfiles)
    // Not refusing = does not throw `chrome-import-blocked` (since there is no Chrome at the fake location, null is returned).
    await expect(handler!({})).resolves.toBeNull()
  })
})

describe('chromeBookmarksBaseDir (for TODO 687 logs)', () => {
  it('builds the path relative to home as a pure function', () => {
    expect(chromeBookmarksBaseDir('/tmp/fake-chrome-home')).toBe(
      join('/tmp/fake-chrome-home', 'Library', 'Application Support', 'Google/Chrome')
    )
  })
})

/**
 * TODO 722: right after the Chrome import, favicons are fetched in the background (`backfillFavoriteFavicons`).
 * `WebDataStore` and `Session` may be plain objects; it depends only on electron's `Session.fetch`.
 */
describe('backfillFavoriteFavicons (TODO 722)', () => {
  function fakeData(hosts: readonly string[]): {
    data: { readonly host: string; icon: string | null; failedAt: number | null }[]
    store: Pick<
      Parameters<typeof backfillFavoriteFavicons>[0],
      'hostsWithoutFavicon' | 'setFaviconForHost' | 'markFaviconFailed'
    >
  } {
    const data: { readonly host: string; icon: string | null; failedAt: number | null }[] = hosts.map((host) => ({
      host,
      icon: null,
      failedAt: null
    }))
    return {
      data,
      store: {
        // TODO 743: as in the real one, hosts that failed within 7 days are excluded (compared with the `now` passed by the caller).
        hostsWithoutFavicon: (limit: number, now = Date.now()) =>
          data
            .filter((row) => row.icon === null && (row.failedAt === null || now - row.failedAt > 7 * 86_400_000))
            .map((row) => row.host)
            .slice(0, limit),
        setFaviconForHost: (host: string, icon: string) => {
          const row = data.find((r) => r.host === host)
          if (row === undefined || row.icon === icon) return false
          row.icon = icon
          row.failedAt = null
          return true
        },
        markFaviconFailed: (host: string, at: number) => {
          const row = data.find((r) => r.host === host)
          if (row !== undefined) row.failedAt = at
        }
      }
    }
  }

  function fakeSession(respond: (url: string) => Response): { fetch: (url: string) => Promise<Response> } {
    return { fetch: (url: string) => Promise.resolve(respond(url)) }
  }

  it('fetches only hosts without a favicon, writes what was obtained, and broadcasts', async () => {
    const { data, store } = fakeData(['a.example', 'b.example'])
    const png = new Uint8Array([1, 2, 3])
    const ses = fakeSession(
      (url) =>
        new Response(url.includes('a.example') ? png : null, {
          status: url.includes('a.example') ? 200 : 404,
          headers: url.includes('a.example') ? { 'content-type': 'image/png' } : {}
        })
    )
    const broadcasts: string[] = []
    await backfillFavoriteFavicons(
      store as Parameters<typeof backfillFavoriteFavicons>[0],
      () => ses.fetch,
      (change) => broadcasts.push(change),
      () => false
    )
    expect(data.find((r) => r.host === 'a.example')?.icon).not.toBeNull()
    expect(data.find((r) => r.host === 'b.example')?.icon).toBeNull()
    // code-review (TODO 722): a change of favicon only is announced as 'favicons' (the map of host → data URL).
    // 'favorites' (the shape of the list) has not changed, so it is not widened.
    expect(broadcasts).toEqual(['favicons'])
  })

  it('does not broadcast when none was obtained; remembers failed hosts with markFaviconFailed (TODO 743)', async () => {
    const { data, store } = fakeData(['down.example'])
    const ses = fakeSession(() => new Response(null, { status: 404 }))
    const broadcasts: string[] = []
    await backfillFavoriteFavicons(
      store as Parameters<typeof backfillFavoriteFavicons>[0],
      () => ses.fetch,
      (change) => broadcasts.push(change),
      () => false,
      () => 1_000_000
    )
    expect(broadcasts).toEqual([])
    expect(data[0]?.failedAt).toBe(1_000_000)
  })

  it('TODO 761: a host whose fetch itself failed (network, timeout) does not get markFaviconFailed written (tried again at the next opportunity)', async () => {
    const { data, store } = fakeData(['offline.example'])
    const ses: { fetch: (url: string) => Promise<Response> } = {
      fetch: () => Promise.reject(new Error('network down'))
    }
    const broadcasts: string[] = []
    await backfillFavoriteFavicons(
      store as Parameters<typeof backfillFavoriteFavicons>[0],
      () => ses.fetch,
      (change) => broadcasts.push(change),
      () => false,
      () => 1_000_000
    )
    expect(broadcasts).toEqual([])
    expect(data[0]?.failedAt).toBeNull()
  })

  it('TODO 743: even if `/favicon.ico` fails, writes it if it can be obtained from the HTML `<link rel=icon>`', async () => {
    const { data, store } = fakeData(['html-only.example'])
    const png = new Uint8Array([1, 2, 3])
    const ses = fakeSession((url) => {
      if (url.endsWith('/favicon.ico')) return new Response(null, { status: 404 })
      if (url.endsWith('/')) {
        return new Response('<html><head><link rel="shortcut icon" href="/assets/icon.png"></head></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
      }
      if (url.endsWith('/assets/icon.png')) {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response(null, { status: 404 })
    })
    const broadcasts: string[] = []
    await backfillFavoriteFavicons(
      store as Parameters<typeof backfillFavoriteFavicons>[0],
      () => ses.fetch,
      (change) => broadcasts.push(change),
      () => false
    )
    expect(data[0]?.icon).not.toBeNull()
    expect(broadcasts).toEqual(['favicons'])
  })

  it('TODO 743: hosts that failed within 7 days are excluded (the `hostsWithoutFavicon` cutoff)', async () => {
    const { store } = fakeData(['recently-failed.example'])
    store.markFaviconFailed('recently-failed.example', 1_000_000)
    expect(store.hostsWithoutFavicon(40, 1_000_000 + 1000)).toEqual([])
    // After 7 days (+ 1 ms) it returns to the targets.
    expect(store.hostsWithoutFavicon(40, 1_000_000 + 7 * 86_400_000 + 1)).toEqual(['recently-failed.example'])
  })

  it('if stopped() is true, stops midway and does not broadcast (12.9: no writes after quit)', async () => {
    const { data, store } = fakeData(['a.example', 'b.example'])
    const png = new Uint8Array([1, 2, 3])
    const ses = fakeSession(() => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }))
    let calls = 0
    const broadcasts: string[] = []
    await backfillFavoriteFavicons(
      store as Parameters<typeof backfillFavoriteFavicons>[0],
      () => ses.fetch,
      (change) => broadcasts.push(change),
      () => {
        calls += 1
        // TODO 761: since it now also checks stopped() before writing, after the await, it is called twice per host (before and after).
        // The before and after of the first one (1st and 2nd calls) are false; before the second one (3rd call) it is treated as ended.
        return calls > 2
      }
    )
    expect(data.filter((r) => r.icon !== null)).toHaveLength(1)
    expect(broadcasts).toEqual([])
  })

  it('the limit (MAX_FAVICON_BACKFILL) is 40', () => {
    expect(MAX_FAVICON_BACKFILL).toBe(40)
  })
})

/**
 * TODO 761: `runFaviconBackfill` (inside register.ts, not exported) is called at startup, at ★, and at each Chrome import,
 * but it is not run in overlap: only one runs, a call during a run only sets the 'one more round' mark, and after it finishes it is re-run once.
 * It is checked indirectly by calling the `webFavoriteAdd` IPC twice without a gap (since it is not exported directly).
 */
describe('duplicate calls to runFaviconBackfill (TODO 761)', () => {
  beforeEach(() => {
    handlers.clear()
    sessionFetch.impl = () => Promise.resolve(new Response(null, { status: 404 }))
  })

  function fakeStore() {
    const favorites: { url: string; title: string }[] = []
    const calls: { host: string; at: number }[] = []
    const data = {
      prune: () => 0,
      hostsWithoutFavicon: () =>
        favorites.map((f) => new URL(f.url).host).filter((host, i, arr) => arr.indexOf(host) === i),
      setFaviconForHost: (): boolean => false,
      markFaviconFailed: (host: string, at: number) => {
        calls.push({ host, at })
      },
      addFavorite: (url: unknown, title: unknown) => {
        favorites.push({ url: String(url), title: String(title) })
        return true
      },
      listFavorites: () => favorites,
      webFavicons: () => ({})
    }
    return { data, favorites, calls }
  }

  it('even if called again while running, the same backfill does not run twice in parallel', async () => {
    let inFlight = 0
    let maxInFlight = 0
    // The Promise executor runs synchronously, so the assignment is always done right after (the definite-assignment assertion).
    let resolveFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    sessionFetch.impl = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight -= 1
      return new Response(null, { status: 404 })
    }
    const { data } = fakeStore()
    registerWebViewHandlers('aios', {
      data: data as unknown as NonNullable<Parameters<typeof registerWebViewHandlers>[1]>['data'],
      settings: null,
      defaultUserData: true
    })
    const add = handlers.get(IpcChannel.webFavoriteAdd)!
    await add({}, 'https://one.example/', 'one')
    // While the first startup run is still held at `gate`, call it once more, overlapping.
    await add({}, 'https://two.example/', 'two')
    resolveFirst()
    // Wait a little until both backfills finish (the entry point does not make callers wait, so `await` cannot catch it).
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(maxInFlight).toBe(1)
  })

  it('shutdown() waits for the running backfill and then returns (12.9: does not let it write to a closed DB)', async () => {
    // The Promise executor runs synchronously, so the assignment is always done right after (the definite-assignment assertion).
    let resolveFetch!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveFetch = resolve
    })
    let wroteAfterShutdownStarted = false
    let shutdownStarted = false
    sessionFetch.impl = async () => {
      await gate
      return new Response(null, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    const { data, favorites } = fakeStore()
    favorites.push({ url: 'https://pending.example/', title: 'p' })
    const originalSet = data.setFaviconForHost
    data.setFaviconForHost = ((...args: Parameters<typeof originalSet>) => {
      if (shutdownStarted) wroteAfterShutdownStarted = true
      return originalSet(...args)
    }) as typeof originalSet
    const handle = registerWebViewHandlers('aios', {
      data: data as unknown as NonNullable<Parameters<typeof registerWebViewHandlers>[1]>['data'],
      settings: null,
      defaultUserData: true
    })
    // Start shutdown while the startup backfill is still held at `gate`.
    shutdownStarted = true
    const shutdownDone = handle.shutdown()
    let finished = false
    void shutdownDone.then(() => {
      finished = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(finished).toBe(false) // The fetch is still held, so it has not finished.
    resolveFetch()
    await shutdownDone
    expect(finished).toBe(true)
    expect(wroteAfterShutdownStarted).toBe(false)
  })
})

/**
 * TODO 723: the `webChromeIcon` IPC (the icon of the button when Favorite is empty). `existsSync` is replaced by this file's `node:fs` mock:
 * it does not depend on the real `/Applications`.
 */
describe('IPC of webChromeIcon (TODO 723)', () => {
  beforeEach(() => {
    handlers.clear()
    fakeExists = () => false
    mockApp.getFileIcon = async () => ({ isEmpty: () => true, toDataURL: () => '' })
  })

  it('null when Chrome.app is absent (getFileIcon is not called)', async () => {
    let called = false
    mockApp.getFileIcon = async () => {
      called = true
      return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,X' }
    }
    registerWebViewHandlers('aios', { data: null, settings: null, defaultUserData: true })
    const handler = handlers.get(IpcChannel.webChromeIcon)
    expect(handler).toBeDefined()
    await expect(handler!({})).resolves.toBeNull()
    expect(called).toBe(false)
  })

  it('a data URL when Chrome.app exists and is readable; the second time returns the same Promise (getFileIcon is called only once)', async () => {
    fakeExists = (path) => path === '/Applications/Google Chrome.app'
    let calls = 0
    mockApp.getFileIcon = async () => {
      calls += 1
      return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,ICON' }
    }
    registerWebViewHandlers('aios', { data: null, settings: null, defaultUserData: true })
    const handler = handlers.get(IpcChannel.webChromeIcon)!
    await expect(handler({})).resolves.toBe('data:image/png;base64,ICON')
    await expect(handler({})).resolves.toBe('data:image/png;base64,ICON')
    expect(calls).toBe(1)
  })
})
