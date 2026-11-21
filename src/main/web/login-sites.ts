/**
 * Clears the login data (cookies and site storage) of the web view (`persist:aios-web`) (TODO 697, wave 33 bundle B,
 * a continuation of ARCHITECTURE 5.2.1). The certificate exceptions of 547, the Slack memory of 553, history, Favorites and the tab memory
 * each live under their own app_settings key / DB table, and are not touched here. This entry point stores nothing - cookies are
 * re-read from the session on every call.
 *
 * **When clearing only one site (a fix from code-review)**: at first it was just `session.clearData({ origins: ['https://<domain>',
 * 'http://<domain>'] })`, which clears cookies per registrable domain (note in electron.d.ts) but clears storage
 * (localStorage, IndexedDB, ...) **only for the origins passed** - so the storage of `mail.google.com` or `host:8443`
 * was left behind. Now (1) the cookies belonging to that row are removed one by one with `cookies.remove`, and (2) for storage,
 * `clearStorageData` is called for each origin (port included) belonging to that row among the "seen hosts" (hosts of cookies, open tabs,
 * places navigated to in this launch, history). Storage of origins we never saw may remain (Chromium has no entry point to
 * list origins).
 *
 * **It does not import electron** - the wiring to the real `session.cookies` / `session.clearStorageData` / `webContents` is in
 * `web/extras.ts`, and tests pass fake deps (the same shape as `certificates.ts`).
 */
import { type LoginSite, registrableDomainOf, sanitizeLoginDomain, summarizeLoginSites } from '../../shared/web-login-sites.js'
import { log } from '../../common/logger.js'

/**
 * The data types removed by "clear everything" (cookies and site storage). **The HTTP cache is not included** (a default decided on our own:
 * the cache is not login data, and as with the certificate exceptions of 547, history, Favorites and the tab memory, the scope of this entry point is
 * narrowed to "what stays logged in" only).
 */
export const LOGIN_DATA_TYPES = [
  'cookies',
  'localStorage',
  'indexedDB',
  'serviceWorkers',
  'webSQL',
  'fileSystems',
  'backgroundFetch'
] as const

/** Per-origin storage types when clearing a single site (names for `clearStorageData`; cookies are removed one by one separately). */
export const LOGIN_STORAGE_TYPES = ['localstorage', 'indexdb', 'serviceworkers', 'filesystem'] as const

/** Only the parts of a cookie needed to remove it (no value is held). */
export interface LoginCookie {
  readonly domain: string
  readonly name: string
  readonly path: string
  readonly secure: boolean
}

export interface WebLoginSitesDeps {
  /** The current cookies (`session.cookies.get({})`). */
  listCookies(): Promise<readonly LoginCookie[]>
  /** Removes one cookie (`session.cookies.remove(url, name)`). */
  removeCookie(url: string, name: string): Promise<void>
  /** Clears the storage of one origin (`scheme://host[:port]`). */
  clearOriginStorage(origin: string): Promise<void>
  /** URLs / origins seen (open tabs, places navigated to in this launch, history). Includes the port. */
  knownUrls(): readonly string[]
  /** Clears the cookies and storage of all sites ("clear everything"). */
  clearAll(): Promise<void>
  /** Reloads the tabs showing the cleared site. If `domain` is null, all of them (after "clear everything"). */
  reload(domain: string | null): void
}

/** The URL used to remove a cookie (`cookies.remove` removes, by name, the cookie that would be sent to this URL). */
export function cookieUrlOf(cookie: LoginCookie): string {
  const host = cookie.domain.trim().replace(/^\.+/, '')
  const path = cookie.path.startsWith('/') ? cookie.path : '/'
  return `${cookie.secure ? 'https' : 'http'}://${host}${path}`
}

/** A URL / origin string -> an http(s) origin (`scheme://host[:port]`). Other schemes and broken values give null. */
function httpOriginOf(raw: string): { readonly origin: string; readonly hostname: string } | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return { origin: url.origin, hostname: url.hostname }
  } catch {
    return null
  }
}

/** The set of origins whose storage is cleared, belonging to one row (a registrable domain). */
export function originsToClear(
  domain: string,
  cookieHosts: readonly string[],
  knownUrls: readonly string[]
): readonly string[] {
  const origins = new Set<string>()
  const addHost = (host: string): void => {
    for (const scheme of ['https', 'http']) {
      const parsed = httpOriginOf(`${scheme}://${host}`)
      if (parsed !== null) origins.add(parsed.origin)
    }
  }
  addHost(domain)
  for (const host of cookieHosts) addHost(host)
  for (const raw of knownUrls) {
    const parsed = httpOriginOf(raw)
    if (parsed !== null && registrableDomainOf(parsed.hostname) === domain) origins.add(parsed.origin)
  }
  return [...origins].sort()
}

export class WebLoginSites {
  constructor(private readonly deps: WebLoginSitesDeps) {}

  /** The list of logged-in sites (for the settings screen). */
  async list(): Promise<readonly LoginSite[]> {
    const cookies = await this.deps.listCookies()
    return summarizeLoginSites(cookies.map((cookie) => cookie.domain))
  }

  /**
   * Clears just one site (per registrable domain). A value coming from the renderer is validated again. Returns the list after clearing.
   * One failure does not stop the rest (clear to the end, then throw if anything failed - the renderer re-fetches the list).
   */
  async clear(rawDomain: unknown): Promise<readonly LoginSite[]> {
    const domain = sanitizeLoginDomain(rawDomain)
    if (domain === null) return this.list()
    const cookies = (await this.deps.listCookies()).filter((cookie) => registrableDomainOf(cookie.domain) === domain)
    let failed = 0
    for (const cookie of cookies) {
      try {
        await this.deps.removeCookie(cookieUrlOf(cookie), cookie.name)
      } catch {
        failed += 1
      }
    }
    const hosts = [...new Set(cookies.map((cookie) => cookie.domain.trim().toLowerCase().replace(/^\.+/, '')))]
    const origins = originsToClear(domain, hosts, this.deps.knownUrls())
    for (const origin of origins) {
      try {
        await this.deps.clearOriginStorage(origin)
      } catch {
        failed += 1
      }
    }
    this.deps.reload(domain)
    log.info('web.login.cleared', { host: domain, cookies: cookies.length, origins: origins.length, failed })
    if (failed > 0) throw new Error(`web.login.clear: ${failed} item(s) failed`)
    return this.list()
  }

  /** Clears the login data of all sites. */
  async clearAll(): Promise<readonly LoginSite[]> {
    await this.deps.clearAll()
    this.deps.reload(null)
    log.info('web.login.clearedAll')
    return this.list()
  }
}
