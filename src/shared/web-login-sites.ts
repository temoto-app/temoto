/**
 * The entry point for clearing login data (cookies, site storage) of the Web view (`persist:aios-web`) (TODO 697, wave 33 bundle B,
 * a continuation of ARCHITECTURE 5.2.1, the cleanup after 523). Types and pure functions only. Enumerating and clearing cookies is in main
 * (`src/main/web/login-sites.ts`).
 *
 * Hosts are grouped by **registrable domain** (`mail.google.com` and `accounts.google.com` become `google.com`,
 * the wording of TODO 697's owner decision as is). The boundary is the Public Suffix List (`tldts`, including private suffixes:
 * `foo.github.io` and `bar.github.io` have different owners, so they are separate rows. The fix from code-review, owner decision 2026-10-11).
 * A single-label host not in the PSL, an IP, or `localhost` stays as one row. 547's certificate exceptions, history, Favorites and the tab memory are
 * not touched here (they are other app_settings keys / DB tables).
 *
 * The renderer imports only the type (`LoginSite`) (`tldts` goes only into main's bundle).
 */
import { getDomain } from 'tldts'

/** One logged-in site (per registrable domain). It holds no cookie values or names. */
export interface LoginSite {
  /** The grouping domain (e.g. `google.com`). Also the key of the settings list. */
  readonly domain: string
  /** Number of hosts that hold cookies under this domain (including subdomains; `domain` itself counts as 1). */
  readonly hostCount: number
  /** Total number of cookies. */
  readonly cookieCount: number
}

/**
 * Host name (a leading `.` is dropped, the cookie domain form) -> the grouping domain. Anything for which the PSL cannot
 * determine a registrable domain (an IP, a single label, `localhost`, a bare suffix) stays as the host.
 */
export function registrableDomainOf(host: string): string {
  const lower = normalizeHost(host)
  if (lower === '') return lower
  return getDomain(lower, { allowPrivateDomains: true, extractHostname: false }) ?? lower
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\.+/, '')
}

/** From the cookie `domain` column (only the `domain` of the `session.cookies.get({})` result), build the list of logged-in sites. */
export function summarizeLoginSites(cookieDomains: readonly string[]): readonly LoginSite[] {
  const byDomain = new Map<string, { readonly hosts: Set<string>; cookieCount: number }>()
  for (const raw of cookieDomains) {
    const host = normalizeHost(raw)
    if (host === '') continue
    const domain = registrableDomainOf(host)
    const entry = byDomain.get(domain)
    if (entry === undefined) {
      byDomain.set(domain, { hosts: new Set([host]), cookieCount: 1 })
    } else {
      entry.hosts.add(host)
      entry.cookieCount += 1
    }
  }
  return [...byDomain.entries()]
    .map(([domain, entry]) => ({ domain, hostCount: entry.hosts.size, cookieCount: entry.cookieCount }))
    .sort((a, b) => a.domain.localeCompare(b.domain))
}

/** Turn a domain from the renderer (not trusted) into a form usable for clearing. null if empty or garbage. */
export function sanitizeLoginDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const domain = registrableDomainOf(raw)
  return domain === '' ? null : domain
}
