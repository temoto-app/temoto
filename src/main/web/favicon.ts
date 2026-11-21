/**
 * Turn a tab's favicon into a data URL (TODO 522, ARCHITECTURE 5.2.1). **Does not import electron** — the `fetch` that goes to get it
 * (the real one is `ses.fetch` of the page session) is passed in by the caller (tests use a plain `Response`).
 *
 * The renderer's CSP allows only `data:` in `img-src` (external URLs are not let into the renderer), so main fetches it and
 * passes it on as a data URL. Null if it is not an image, is too large, or times out.
 *
 * TODO 579: the size is counted **while reading**. If a response with no `content-length` (chunked) is read in full with `arrayBuffer()`
 * and compared afterwards, then when a page puts a huge response behind `<link rel=icon>`, main reads all of it into memory.
 */
import { isWebViewerUrl } from '@shared/open-external.js'
import { MAX_FAVICON_BYTES } from '@shared/web-tabs.js'
import { pickAddress } from '../capability/net-policy.js'

/** Upper bound on the time to fetch a favicon. */
export const FAVICON_TIMEOUT_MS = 5000

/** TODO 743: upper bound on reading a page's HTML (only `<link rel=icon>` is being looked for, so the beginning is enough). */
export const FAVICON_HTML_LIMIT_BYTES = 256 * 1024

/** The rel values of `<link rel="icon" | "shortcut icon" | "apple-touch-icon">` (case and surrounding whitespace ignored). */
const ICON_RELS = new Set(['icon', 'shortcut icon', 'apple-touch-icon'])
const LINK_TAG = /<link\b[^>]*>/gi
const REL_ATTR = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
/** TODO 761 (a fix of 743): `<base href="...">` (the first one in document order). It is the base for resolving relative URLs. */
const BASE_TAG = /<base\b[^>]*>/i

export type FaviconFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

/** TODO 929: upper bound on the hops that follow redirects. */
export const MAX_FAVICON_REDIRECTS = 5

/**
 * TODO 929: the entry point that sends just one hop. **It does not follow redirects**; a 3xx is returned as it is (with the `location` header).
 * The real one is `net.request` in `register.ts` (`redirect: 'manual'`, the page session).
 */
export type FaviconHop = (url: string, init: { signal: AbortSignal }) => Promise<Response>

export interface FaviconGuard {
  /** Name resolution (the real one is `dns.lookup` with all). An IP literal is also returned as it is. */
  resolve(hostname: string): Promise<readonly { address: string; family: number }[]>
  /**
   * The host that may be fetched even at an internal (private / loopback) address = the host of a page the user opened themselves (a Favorite)
   * (the value of `webHostOf`, the port is not looked at). So that someone who opened `http://localhost:3000` is not left unable to fetch its favicon. It does not apply to other hosts.
   */
  readonly trustedHost: string | null
}

/** Decided not to fetch (an internal address, not http(s), or past the hop limit). `fetchFavicon*` treats it the same as "none". */
function refused(): Response {
  return new Response(null, { status: 403 })
}

function hostKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

/** `trustedHost` is the value of `webHostOf` (= `URL.host`, which may include a port). Only the hostname is compared. */
function trustedKey(host: string | null): string | null {
  if (host === null || host === '') return null
  try {
    return hostKey(new URL(`http://${host}/`).hostname)
  } catch {
    return null
  }
}

/**
 * TODO 929: guard the favicon fetch from arbitrary http(s) that a page points at. Both the URL of `page-favicon-updated` and `<link rel=icon>` are
 * decided by the page, yet the request goes out from main without the page as an origin (Chromium's Private Network Access does not apply), so
 * when a public page declared `http://192.168.1.1/…` / `http://127.0.0.1:8080/…` as its favicon, main sent a GET
 * there every time it was opened (a blind SSRF).
 *
 * - Per hop: is it http(s)? -> name resolution -> `pickAddress` (the same decision as the Broker's `network` / `browser`; refuse if even one address is internal).
 *   Only the same host as `guard.trustedHost` is let through even if internal.
 * - Redirects are followed here (`hop` does not follow them), and the same check is applied to the destination. The hop limit is `MAX_FAVICON_REDIRECTS`.
 * - A refusal is an empty 403 response (a definite "none"). A name resolution failure stays an exception (a network failure, `networkError`).
 * - What actually connects is Chromium's resolution, so this is a check made ahead of time (the limits of DNS rebinding are the same as `browser`; see the wave 46 note).
 */
export function guardedFaviconFetch(hop: FaviconHop, guard: FaviconGuard): FaviconFetch {
  const trusted = trustedKey(guard.trustedHost)
  return async (input, init) => {
    let url = input
    for (let step = 0; step <= MAX_FAVICON_REDIRECTS; step += 1) {
      if (!isWebViewerUrl(url)) return refused()
      const hostname = hostKey(new URL(url).hostname)
      if (hostname !== trusted) {
        try {
          pickAddress(await guard.resolve(hostname))
        } catch (err) {
          if (err instanceof Error && err.name === 'NetDenied') return refused()
          throw err
        }
      }
      if (init.signal.aborted) throw new Error('aborted')
      const response = await hop(url, init)
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel().catch(() => undefined)
        try {
          url = new URL(location, url).href
        } catch {
          return refused()
        }
        continue
      }
      // `fetchFaviconFromHtml` resolves a relative href against the post-redirect URL (761). The `url` of the response we built is empty, so set it.
      Object.defineProperty(response, 'url', { value: url })
      return response
    }
    return refused()
  }
}

/**
 * Read `body` up to `limit` bytes. If it goes over, stop reading (`cancel()`) and return null. Null if it cannot be read.
 * If `body` is null (a response with no contents), an empty array.
 */
export async function readBodyLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } catch {
    await reader.cancel().catch(() => undefined)
    return null
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * TODO 761 (a fix of 743): read `body` up to `limit` bytes, and if it goes over, discard the rest and return the prefix
 * read so far. `readBodyLimited` returns null entirely when it goes over, which suits the image size check
 * (a too-large image really is given up on), but using it in `fetchFaviconFromHtml`, which only looks for `<link rel=icon>` at the start of the HTML,
 * made "every page over 256 KB fail".
 * Stop as soon as `</head>` is seen (an icon link does not appear outside the head).
 */
export async function readBodyPrefix(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = limit - total
      if (remaining <= 0) break
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value
      chunks.push(slice)
      total += slice.byteLength
      text += decoder.decode(slice, { stream: true })
      if (total >= limit || text.toLowerCase().includes('</head')) {
        break
      }
    }
  } catch {
    // Use only what was read. It is a prefix, so it is fine if it could not be read to the end.
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * TODO 761 (a fix of 743): an internal result that distinguishes "known to be absent after getting an HTTP response" (4xx/5xx, not an image, too large) from
 * "the fetch itself failed" (network, DNS, timeout). The latter is not written to `markFaviconFailed`
 * (`fetchFaviconForHost` looks at it) — transient failures had been getting a 7-day no-retry too.
 */
interface FaviconFetchOutcome {
  readonly image: string | null
  readonly networkError: boolean
}

const NOT_FOUND: FaviconFetchOutcome = { image: null, networkError: false }

async function fetchFaviconDetailed(
  fetch: FaviconFetch,
  urls: readonly string[],
  timeoutMs: number
): Promise<FaviconFetchOutcome> {
  const url = urls[0]
  if (url === undefined) return NOT_FOUND
  if (url.startsWith('data:image/')) {
    return { image: url.length <= MAX_FAVICON_BYTES * 2 ? url : null, networkError: false }
  }
  if (!isWebViewerUrl(url)) return NOT_FOUND
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!response.ok || !type.startsWith('image/')) {
      await response.body?.cancel().catch(() => undefined)
      return NOT_FOUND
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_FAVICON_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      return NOT_FOUND
    }
    const bytes = await readBodyLimited(response.body, MAX_FAVICON_BYTES)
    if (bytes === null || bytes.length === 0) return NOT_FOUND
    return { image: `data:${type};base64,${Buffer.from(bytes).toString('base64')}`, networkError: false }
  } catch {
    return { image: null, networkError: true }
  } finally {
    clearTimeout(timer)
  }
}

/** Turn the first favicon candidate into a data URL. */
export async function fetchFavicon(
  fetch: FaviconFetch,
  urls: readonly string[],
  timeoutMs: number = FAVICON_TIMEOUT_MS
): Promise<string | null> {
  return (await fetchFaviconDetailed(fetch, urls, timeoutMs)).image
}

/**
 * TODO 743: pick one `href` of `<link rel="icon" | "shortcut icon" | "apple-touch-icon">` from the HTML
 * (the first found in document order). A light scan with only a regular expression — no DOM (so main does not gain a DOM dependency).
 * Null if none is found.
 */
export function extractIconHref(html: string): string | null {
  for (const match of html.matchAll(LINK_TAG)) {
    const tag = match[0]
    const rel = REL_ATTR.exec(tag)
    const relValue = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? '').toLowerCase().trim()
    if (!ICON_RELS.has(relValue)) continue
    const href = HREF_ATTR.exec(tag)
    const hrefValue = href?.[1] ?? href?.[2] ?? href?.[3] ?? null
    if (hrefValue !== null && hrefValue !== '') return hrefValue
  }
  return null
}

/**
 * TODO 761 (a fix of 743): if the HTML has `<base href="...">`, return its `href`
 * (only the first `<base>` in document order — as the HTML spec says, the second and later are ignored). Null if none.
 */
export function extractBaseHref(html: string): string | null {
  const tag = BASE_TAG.exec(html)?.[0]
  if (tag === undefined) return null
  const href = HREF_ATTR.exec(tag)
  const hrefValue = href?.[1] ?? href?.[2] ?? href?.[3] ?? null
  return hrefValue !== null && hrefValue !== '' ? hrefValue : null
}

/** Resolve `href` against `base` (that page's URL). Null if the URL is broken. */
function resolveIconUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href
  } catch {
    return null
  }
}

/**
 * TODO 743/761: fetch a favicon from the `<link rel=icon>` of a page whose `/favicon.ico` is missing or unreadable. The page's
 * HTML is read only up to the first `FAVICON_HTML_LIMIT_BYTES`. It uses `readBodyPrefix` (use only the start even if over)
 * rather than `readBodyLimited` (579, null entirely if over) — for HTML, being able to read `<head>` is enough, and
 * making large pages over 256 KB (many news sites, etc.) fail entirely is what the 761 fix addressed.
 * The candidate found is passed to `fetchFavicon`, and the checks of image size and format are left to it (not
 * written twice here).
 */
async function fetchFaviconFromHtmlDetailed(
  fetch: FaviconFetch,
  pageUrl: string,
  timeoutMs: number
): Promise<FaviconFetchOutcome> {
  if (!isWebViewerUrl(pageUrl)) return NOT_FOUND
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(pageUrl, { signal: controller.signal })
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!response.ok || !type.startsWith('text/html')) {
      await response.body?.cancel().catch(() => undefined)
      return NOT_FOUND
    }
    const bytes = await readBodyPrefix(response.body, FAVICON_HTML_LIMIT_BYTES)
    if (bytes.length === 0) return NOT_FOUND
    const html = Buffer.from(bytes).toString('utf8')
    const href = extractIconHref(html)
    if (href === null) return NOT_FOUND
    // TODO 761 (a fix of 743): a relative href is based not on the requested pageUrl but on the actual URL after redirects
    // (`response.url`, or pageUrl if absent). If there is a `<base href>`, it takes top priority
    // (as the HTML spec says — if the page says so, the base for relative URLs changes).
    const fetchedUrl = response.url !== '' ? response.url : pageUrl
    const base = extractBaseHref(html)
    const resolvedBase = base === null ? fetchedUrl : (resolveIconUrl(base, fetchedUrl) ?? fetchedUrl)
    const resolved = resolveIconUrl(href, resolvedBase)
    if (resolved === null) return NOT_FOUND
    return fetchFaviconDetailed(fetch, [resolved], timeoutMs)
  } catch {
    return { image: null, networkError: true }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * TODO 743/761: fetch a favicon from the `<link rel=icon>` of a page whose `/favicon.ico` is missing or unreadable. The page's
 * HTML is read only up to the first `FAVICON_HTML_LIMIT_BYTES`. It uses `readBodyPrefix` (use only the start even if over)
 * rather than `readBodyLimited` (579, null entirely if over) — for HTML, being able to read `<head>` is enough, and
 * making large pages over 256 KB (many news sites, etc.) fail entirely is what the 761 fix addressed.
 * The candidate found is passed to `fetchFavicon`, and the checks of image size and format are left to it (not
 * written twice here).
 */
export async function fetchFaviconFromHtml(
  fetch: FaviconFetch,
  pageUrl: string,
  timeoutMs: number = FAVICON_TIMEOUT_MS
): Promise<string | null> {
  return (await fetchFaviconFromHtmlDetailed(fetch, pageUrl, timeoutMs)).image
}

/** The result of `fetchFaviconForHost`. `networkError` is used by `register.ts` to decide whether to write `markFaviconFailed`. */
export interface FaviconHostResult {
  readonly image: string | null
  /**
   * TODO 761 (a fix of 743): true when "none" was concluded because the fetch itself failed (network, DNS, timeout). In this case it is not
   * a definite "none" based on an HTTP response, so the caller does not write `markFaviconFailed`
   * and tries again at the next opportunity.
   */
  readonly networkError: boolean
}

/**
 * TODO 743/761: fetch a host's favicon in the order `/favicon.ico` -> (if that fails) the page's `<link rel=icon>`.
 * `backfillFavoriteFavicons` (register.ts) calls it at startup and when a Favorite is added. It returns `networkError: false` only when both are definitely
 * "none" — if either was a network failure, `networkError: true`
 * (the caller does not write `markFaviconFailed`).
 */
export async function fetchFaviconForHost(
  fetch: FaviconFetch,
  host: string,
  timeoutMs: number = FAVICON_TIMEOUT_MS
): Promise<FaviconHostResult> {
  const direct = await fetchFaviconDetailed(fetch, [`https://${host}/favicon.ico`], timeoutMs)
  if (direct.image !== null) return { image: direct.image, networkError: false }
  const html = await fetchFaviconFromHtmlDetailed(fetch, `https://${host}/`, timeoutMs)
  if (html.image !== null) return { image: html.image, networkError: false }
  return { image: null, networkError: direct.networkError || html.networkError }
}
