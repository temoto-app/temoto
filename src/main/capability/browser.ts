/**
 * The `browser` capability (TODO 848, ARCHITECTURE.md 7.7): fetch one page in the logged-in Web view session (`persist:aios-web`).
 * **Does not import electron**: the decisions and per-hop checks are here (the pure part that can be unit tested), and
 * the actual sending is done one hop at a time by the transport in `src/main/web/page-fetch.ts` (Chromium's network stack, the session's cookies).
 *
 * What it guards:
 * - **Only declared hosts** (`browser.hosts`, the same `checkRequest` / `checkRedirect` as `network`). https only.
 * - **Follows redirects itself and applies the same checks at every hop** (the transport does not follow). The Web view session's
 *   cookies apply to every site the user logged in to, so not one hop goes outside the declaration.
 * - A literal IP or `localhost` is refused as a host. A name resolving to an internal address (loopback / RFC 1918 ...) is refused too
 *   (`pickAddress`. The real connection uses Chromium's resolution, so this is a check made ahead of time; for the limits see the wave46 note).
 * - GET only; a plugin can pass neither headers nor a body. Bodies are HTML / JSON / text only, with limits on size and time.
 * - No rendering. No entry point to run JS or CDP is made (constraint 8 / the principle of 835). Subresources and `<iframe>` are not read either.
 */
import { isIP } from 'node:net'
import type { BrokerBrowserFetchPageResult } from '@shared/plugin.js'
import { NetDenied, checkRedirect, checkRequest, pickAddress } from './net-policy.js'

/** Upper bound of one body (bytes). A big Reddit thread's `.json` can be several MB, so 8 MB, the same as `network`. */
export const MAX_BROWSER_PAGE_BYTES = 8 * 1024 * 1024
/** Upper bound on redirects followed. */
export const MAX_BROWSER_REDIRECTS = 5
/** Upper bound of one fetch (all hops combined), in milliseconds. */
export const BROWSER_FETCH_TIMEOUT_MS = 30_000
/** Number of fetches running at once (total across all plugins / per plugin). Beyond it, refuse instead of making them wait. */
export const MAX_BROWSER_CONCURRENT = 4
export const MAX_BROWSER_CONCURRENT_PER_PLUGIN = 2
/** Fetch rate per plugin (requests / minute). */
export const BROWSER_RATE_LIMIT_PER_MINUTE = 30

/** The body types accepted. Nothing is rendered, so images, PDFs and the like are not fetched. */
const TEXT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/json',
  'text/plain',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml'
])

export type BrowserDenyReason =
  | 'unsupported-type'
  | 'timeout'
  | 'busy'
  | 'unavailable'
  | 'host-literal'

export class BrowserDenied extends Error {
  constructor(readonly reason: BrowserDenyReason) {
    super(reason)
    this.name = 'BrowserDenied'
  }
}

/** The result of one hop of the transport. It does not follow redirects and returns `location`. */
export type BrowserHop =
  | { readonly kind: 'redirect'; readonly status: number; readonly location: string }
  | {
      readonly kind: 'response'
      readonly status: number
      readonly contentType: string
      readonly body: Uint8Array
      readonly truncated: boolean
    }

export interface BrowserTransport {
  /** Host name -> list of addresses (for the check made ahead of time). */
  resolve(hostname: string): Promise<readonly { address: string; family: number }[]>
  /**
   * One GET hop. **Does not follow redirects** (returns `redirect`). Cookies are the Web view session's.
   * The body is cut at `maxBytes`. Stops when `signal` is raised.
   */
  send(url: URL, options: { readonly maxBytes: number; readonly signal: AbortSignal }): Promise<BrowserHop>
}

/** Whether a name cannot be written as a host (a literal IP, `localhost`). Used both in manifest validation and in the check before sending. */
export function isLiteralOrLocalHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(value) !== 0) return true
  // A name made of only digits and dots can be an alternative notation of an IP (such as `127.1`).
  if (/^[0-9.]+$/.test(value)) return true
  return value === 'localhost' || value.endsWith('.localhost')
}

/**
 * The check for one hop. https and declared hosts use the same `checkRequest` as `network` (one policy), and this adds only
 * the browser-specific checks (credentials embedded in the URL, a literal IP, `localhost`).
 */
export function checkBrowserUrl(url: URL, allowedHosts: readonly string[]): void {
  checkRequest({ url, allowedHosts })
  if (url.username !== '' || url.password !== '') throw new NetDenied('scheme')
  if (isLiteralOrLocalHost(url.hostname)) throw new BrowserDenied('host-literal')
}

/** The type part of `content-type` (lowercase, without parameters). */
export function mediaTypeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase()
}

/** Turns the body into a string. If the charset is unknown, UTF-8 (broken bytes become U+FFFD). */
export function decodeBody(body: Uint8Array, contentType: string): string {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)
  const label = match?.[1]
  if (label !== undefined) {
    try {
      return new TextDecoder(label).decode(body)
    } catch {
      // An unknown charset is read as UTF-8.
    }
  }
  return new TextDecoder('utf-8').decode(body)
}

/**
 * Fetches one page. At each hop: `checkBrowserUrl` -> the name resolution check -> send one hop. The redirect target goes through the same check,
 * and anything outside the declaration, non-https, or over the count is refused. The total time is capped.
 */
export async function brokeredPageFetch(
  input: { readonly url: string; readonly allowedHosts: readonly string[]; readonly timeoutMs?: number },
  transport: BrowserTransport
): Promise<BrokerBrowserFetchPageResult> {
  let url: URL
  try {
    url = new URL(input.url)
  } catch {
    throw new NetDenied('scheme')
  }
  const controller = new AbortController()
  const timeoutMs = input.timeoutMs ?? BROWSER_FETCH_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new BrowserDenied('timeout'))
    }, timeoutMs)
  })
  const run = async (): Promise<BrokerBrowserFetchPageResult> => {
    for (let hop = 0; hop <= MAX_BROWSER_REDIRECTS; hop += 1) {
      checkBrowserUrl(url, input.allowedHosts)
      pickAddress(await transport.resolve(url.hostname))
      // Again after name resolution (do not send if the time ran out while waiting).
      if (controller.signal.aborted) throw new BrowserDenied('timeout')
      const response = await transport.send(url, { maxBytes: MAX_BROWSER_PAGE_BYTES, signal: controller.signal })
      if (response.kind === 'redirect') {
        // The target check is the same `checkRedirect` as `network` (https, declared hosts). There is no
        // credential stripping (cookies belong to the session), so `credentialHost` is null. The browser-specific check runs at the start of the next hop.
        try {
          url = checkRedirect(url, response.location, input.allowedHosts, null).next
        } catch (err) {
          if (err instanceof NetDenied) throw err
          throw new NetDenied('scheme')
        }
        continue
      }
      const type = mediaTypeOf(response.contentType)
      if (!TEXT_TYPES.has(type)) throw new BrowserDenied('unsupported-type')
      const truncated = response.truncated || response.body.byteLength > MAX_BROWSER_PAGE_BYTES
      const body = response.body.byteLength > MAX_BROWSER_PAGE_BYTES ? response.body.subarray(0, MAX_BROWSER_PAGE_BYTES) : response.body
      return { status: response.status, url: url.toString(), contentType: type, text: decodeBody(body, response.contentType), truncated }
    }
    throw new NetDenied('too-many-redirects')
  }
  try {
    return await Promise.race([run(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The URL kept in the audit (TODO 848: "URL in the audit log"). **The query and fragment are dropped**, since they may contain values (the logging convention of chapter 7).
 * Length is up to 512 characters. If it cannot be parsed, `invalid`.
 */
export function auditUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 512)
  } catch {
    return 'invalid'
  }
}

/** Upper bound on concurrency (overall and per plugin). Refuse if `acquire` returns false. */
export class ConcurrencyGate {
  private total = 0
  private readonly perKey = new Map<string, number>()

  constructor(
    private readonly max: number = MAX_BROWSER_CONCURRENT,
    private readonly maxPerKey: number = MAX_BROWSER_CONCURRENT_PER_PLUGIN
  ) {}

  acquire(key: string): boolean {
    const current = this.perKey.get(key) ?? 0
    if (this.total >= this.max || current >= this.maxPerKey) return false
    this.total += 1
    this.perKey.set(key, current + 1)
    return true
  }

  release(key: string): void {
    const current = this.perKey.get(key) ?? 0
    if (current <= 1) this.perKey.delete(key)
    else this.perKey.set(key, current - 1)
    this.total = Math.max(0, this.total - 1)
  }
}
