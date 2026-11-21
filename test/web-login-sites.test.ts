/**
 * TODO 697 (wave 33 bundle B): the way to clear the login information (cookies and site storage) of Web display (`persist:aios-web`).
 *
 * - `registrableDomainOf` / `summarizeLoginSites` (`src/shared/web-login-sites.ts`, no electron): gathers the `domain` column of cookies by registrable domain
 *   (`mail.google.com` and `accounts.google.com` both become `google.com`). The boundary is the Public Suffix List (`tldts`, including private suffixes: code-review fix).
 * - `WebLoginSites` (`src/main/web/login-sites.ts`, no electron): three operations: list, delete one site, delete all. The real wiring to `session.cookies` / `session.clearData` /
 *   `webContents` is in `web/extras.ts` (fake deps here).
 *
 * The real session and cookies are not used. The model is not called.
 */
import { describe, expect, it } from 'vitest'
import {
  registrableDomainOf,
  sanitizeLoginDomain,
  summarizeLoginSites,
  type LoginSite
} from '../src/shared/web-login-sites.js'
import {
  LOGIN_DATA_TYPES,
  LOGIN_STORAGE_TYPES,
  WebLoginSites,
  cookieUrlOf,
  originsToClear,
  type LoginCookie
} from '../src/main/web/login-sites.js'

describe('registrableDomainOf (TODO 697)', () => {
  it('subdomains become the registrable domain', () => {
    expect(registrableDomainOf('mail.google.com')).toBe('google.com')
    expect(registrableDomainOf('accounts.google.com')).toBe('google.com')
    expect(registrableDomainOf('google.com')).toBe('google.com')
  })

  it('drops the leading . (a cookie domain)', () => {
    expect(registrableDomainOf('.example.com')).toBe('example.com')
  })

  it('a two-level suffix (co.jp etc.) is grouped with 3 labels', () => {
    expect(registrableDomainOf('www.example.co.jp')).toBe('example.co.jp')
    expect(registrableDomainOf('example.co.jp')).toBe('example.co.jp')
  })

  it('an unknown suffix stays as the last 2 labels (does not over-group)', () => {
    expect(registrableDomainOf('a.b.vm-soft04.internal')).toBe('vm-soft04.internal')
  })

  // code-review fix: in the simple table, `foo.github.io` and `bar.github.io` were gathered into one `github.io` row, and a single 'delete' removed the sites
  // of another owner too. Split by the PSL's private suffixes.
  it('a private suffix (github.io etc.) is separated per owner', () => {
    expect(registrableDomainOf('foo.github.io')).toBe('foo.github.io')
    expect(registrableDomainOf('www.foo.github.io')).toBe('foo.github.io')
    expect(registrableDomainOf('bar.github.io')).toBe('bar.github.io')
    expect(registrableDomainOf('github.io')).toBe('github.io')
    expect(registrableDomainOf('x.y.co.uk')).toBe('y.co.uk')
    expect(summarizeLoginSites(['foo.github.io', 'bar.github.io']).map((site) => site.domain)).toEqual([
      'bar.github.io',
      'foo.github.io'
    ])
  })

  it('an internal single-word host, an IP, and localhost stay as they are', () => {
    expect(registrableDomainOf('vm-soft04')).toBe('vm-soft04')
    expect(registrableDomainOf('localhost')).toBe('localhost')
    expect(registrableDomainOf('192.168.1.1')).toBe('192.168.1.1')
    expect(registrableDomainOf('[::1]')).toBe('[::1]')
  })

  it('folds case and whitespace', () => {
    expect(registrableDomainOf('  MAIL.GOOGLE.COM  ')).toBe('google.com')
  })
})

describe('summarizeLoginSites', () => {
  it('groups by domain and sorts in dictionary order', () => {
    const sites = summarizeLoginSites([
      'mail.google.com',
      '.accounts.google.com',
      'google.com',
      'vm-soft04',
      'github.com'
    ])
    expect(sites).toEqual<readonly LoginSite[]>([
      { domain: 'github.com', hostCount: 1, cookieCount: 1 },
      { domain: 'google.com', hostCount: 3, cookieCount: 3 },
      { domain: 'vm-soft04', hostCount: 1, cookieCount: 1 }
    ])
  })

  it('empty when there are no cookies; empty strings and whitespace are not counted', () => {
    expect(summarizeLoginSites([])).toEqual([])
    expect(summarizeLoginSites(['', '   '])).toEqual([])
  })

  it('multiple cookies of the same host increase only cookieCount (hostCount is 1)', () => {
    expect(summarizeLoginSites(['example.com', 'example.com', 'example.com'])).toEqual([
      { domain: 'example.com', hostCount: 1, cookieCount: 3 }
    ])
  })
})

describe('sanitizeLoginDomain', () => {
  it('validates the value that came from the renderer', () => {
    expect(sanitizeLoginDomain('mail.google.com')).toBe('google.com')
    expect(sanitizeLoginDomain('')).toBeNull()
    expect(sanitizeLoginDomain(42)).toBeNull()
    expect(sanitizeLoginDomain(null)).toBeNull()
  })
})

describe('cookieUrlOf / originsToClear (code-review fix)', () => {
  it('the cookie URL takes the scheme from secure, drops the leading . of domain, and adds path', () => {
    expect(cookieUrlOf({ domain: '.google.com', name: 'SID', path: '/', secure: true })).toBe('https://google.com/')
    expect(cookieUrlOf({ domain: 'mail.google.com', name: 'X', path: '/mail', secure: false })).toBe(
      'http://mail.google.com/mail'
    )
    expect(cookieUrlOf({ domain: 'a.com', name: 'X', path: '', secure: true })).toBe('https://a.com/')
  })

  it("storage targets to clear: of the row's domain, cookie hosts, and seen origins (with port), those belonging to that row", () => {
    expect(
      originsToClear(
        'google.com',
        ['mail.google.com', 'google.com'],
        [
          'https://accounts.google.com/signin?x=1',
          'https://mail.google.com:8443/u/0',
          'https://example.com/',
          'about:blank',
          'aios-res://x',
          'not a url'
        ]
      )
    ).toEqual([
      'http://google.com',
      'http://mail.google.com',
      'https://accounts.google.com',
      'https://google.com',
      'https://mail.google.com',
      'https://mail.google.com:8443'
    ])
  })

  it('does not include origins of another owner of a private suffix', () => {
    expect(originsToClear('foo.github.io', [], ['https://bar.github.io/', 'https://foo.github.io/x'])).toEqual([
      'http://foo.github.io',
      'https://foo.github.io'
    ])
  })
})

describe('WebLoginSites (TODO 697, no electron, fake deps)', () => {
  const cookie = (domain: string, name = 'c', secure = true, path = '/'): LoginCookie => ({ domain, name, path, secure })
  const makeDeps = (
    cookies: readonly LoginCookie[],
    options: { knownUrls?: readonly string[]; failRemove?: string; failStorage?: string } = {}
  ) => {
    const removed: [string, string][] = []
    const storage: string[] = []
    const clearedAll: number[] = []
    const reloaded: (string | null)[] = []
    return {
      calls: { removed, storage, clearedAll, reloaded },
      deps: {
        listCookies: async () => cookies,
        removeCookie: async (url: string, name: string) => {
          if (name === options.failRemove) throw new Error('boom')
          removed.push([url, name])
        },
        clearOriginStorage: async (origin: string) => {
          if (origin === options.failStorage) throw new Error('boom')
          storage.push(origin)
        },
        knownUrls: () => options.knownUrls ?? [],
        clearAll: async () => {
          clearedAll.push(1)
        },
        reload: (domain: string | null) => {
          reloaded.push(domain)
        }
      }
    }
  }

  it('the list is re-read from cookies every time (nothing is saved)', async () => {
    const { deps } = makeDeps([cookie('mail.google.com'), cookie('github.com')])
    const sites = new WebLoginSites(deps)
    expect(await sites.list()).toEqual([
      { domain: 'github.com', hostCount: 1, cookieCount: 1 },
      { domain: 'google.com', hostCount: 1, cookieCount: 1 }
    ])
  })

  it("removing a single site: that row's cookies one by one, storage per seen origin, and only that domain is re-read", async () => {
    const { deps, calls } = makeDeps(
      [cookie('.google.com', 'SID'), cookie('mail.google.com', 'GMAIL_AT', true, '/mail'), cookie('github.com', 'gh')],
      { knownUrls: ['https://mail.google.com:8443/u/0', 'https://github.com/'] }
    )
    const sites = new WebLoginSites(deps)
    await sites.clear('mail.google.com')
    expect(calls.removed).toEqual([
      ['https://google.com/', 'SID'],
      ['https://mail.google.com/mail', 'GMAIL_AT']
    ])
    expect(calls.storage).toEqual([
      'http://google.com',
      'http://mail.google.com',
      'https://google.com',
      'https://mail.google.com',
      'https://mail.google.com:8443'
    ])
    expect(calls.reloaded).toEqual(['google.com'])
    expect(calls.clearedAll).toEqual([])
  })

  it('one failure does not stop the rest, and throws at the end', async () => {
    const { deps, calls } = makeDeps([cookie('a.com', 'x'), cookie('a.com', 'y')], {
      failRemove: 'x',
      failStorage: 'http://a.com'
    })
    const sites = new WebLoginSites(deps)
    await expect(sites.clear('a.com')).rejects.toThrow()
    expect(calls.removed).toEqual([['https://a.com/', 'y']])
    expect(calls.storage).toEqual(['https://a.com'])
    expect(calls.reloaded).toEqual(['a.com'])
  })

  it('a domain that cannot be validated does nothing and only returns the list', async () => {
    const { deps, calls } = makeDeps([cookie('example.com')])
    const sites = new WebLoginSites(deps)
    await sites.clear(42)
    await sites.clear('')
    expect(calls.removed).toEqual([])
    expect(calls.storage).toEqual([])
    expect(calls.reloaded).toEqual([])
  })

  it('remove all: calls clearAll and re-reads everything (domain is null)', async () => {
    const { deps, calls } = makeDeps([cookie('a.com'), cookie('b.com')])
    const sites = new WebLoginSites(deps)
    await sites.clearAll()
    expect(calls.clearedAll).toEqual([1])
    expect(calls.reloaded).toEqual([null])
  })

  it('the kinds cleared are only cookies and site storage (the HTTP cache is not included)', () => {
    expect(LOGIN_DATA_TYPES).toEqual([
      'cookies',
      'localStorage',
      'indexedDB',
      'serviceWorkers',
      'webSQL',
      'fileSystems',
      'backgroundFetch'
    ])
    expect(LOGIN_DATA_TYPES).not.toContain('cache')
    expect(LOGIN_STORAGE_TYPES).not.toContain('cachestorage')
    expect(LOGIN_STORAGE_TYPES).not.toContain('cookies')
  })
})
