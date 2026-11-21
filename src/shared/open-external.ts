/**
 * Decision on "whether a URL may be opened in an external browser" (ARCHITECTURE.md 5.1 "external links").
 *
 * **A pure function that depends on neither the DOM nor Node.** The renderer uses it to dispatch clicks, and
 * main uses the same single decision to **re-validate** in both IPC and `setWindowOpenHandler`
 * (values that come from the renderer are always re-validated in main, a convention of this repository).
 *
 * Only `http:` / `https:` / `mailto:` are allowed. `javascript:` / `data:` / `file:` /
 * `thread:` and relative URLs are all rejected. `file:` and `thread:` are interpreted inside the app (ViewerPane)
 * and must not be handed to the OS.
 */

/** Schemes that may be handed to the external browser (the OS's default handler). */
export const EXTERNAL_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:']

/**
 * A sensible upper limit. A longer value is rejected without further checking
 * (a few KB is enough even for a `mailto:` with a body).
 */
export const MAX_EXTERNAL_URL_LENGTH = 8192

/**
 * The scheme (such as `'https:'`) if it could be parsed, `null` otherwise.
 * It is left to the WHATWG URL parser, so surrounding whitespace is dropped, and control characters
 * mixed in, as in `java\tscript:`, are folded into `javascript:` before the decision (that is, it is rejected).
 */
export function externalUrlProtocol(url: unknown): string | null {
  if (typeof url !== 'string') return null
  if (url.length === 0 || url.length > MAX_EXTERNAL_URL_LENGTH) return null
  try {
    // No base is given: a relative URL throws here and is rejected.
    return new URL(url).protocol.toLowerCase()
  } catch {
    return null
  }
}

/** Whether `url` may be handed to the OS's default handler. */
export function isOpenableExternally(url: unknown): boolean {
  const protocol = externalUrlProtocol(url)
  return protocol !== null && EXTERNAL_PROTOCOLS.includes(protocol)
}

/**
 * Schemes that may be shown **as a page** in the ViewerPane (TODO 400, ARCHITECTURE 5.1.1 / 5.2.1).
 * `mailto:` stays with the OS mail app (a subset of `EXTERNAL_PROTOCOLS`).
 */
export const WEB_VIEWER_PROTOCOLS: readonly string[] = ['http:', 'https:']

/**
 * Whether `url` may be opened in the ViewerPane's web view (main's `WebContentsView`) (TODO 400).
 *
 * The renderer uses this one function to dispatch clicks, and main uses it to **re-validate** IPC (`web.load`), writes to the memory (`setViewerState`),
 * and in-page navigation (`will-navigate` / `will-redirect`).
 * Only `http:` / `https:`; those with an empty host or with `user:pass@` credentials (writing one to the memory
 * would leave a secret in the DB) are refused. The length limit is the same as `isOpenableExternally`.
 */
export function isWebViewerUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  const protocol = externalUrlProtocol(url)
  if (protocol === null || !WEB_VIEWER_PROTOCOLS.includes(protocol)) return false
  try {
    const parsed = new URL(url)
    return parsed.host !== '' && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

/**
 * Hosts of login screens that refuse login in the embedded Web view (TODO 857). Google refuses login in a `WebContentsView`
 * with "This browser or app may not be secure" (721, `docs/notes/wave34.md`).
 * Logged-in Gmail and the like can be viewed in the Web view (822), so only the login screen is counted, not the app's host.
 */
export const EMBED_REFUSED_LOGIN_HOSTS: readonly string[] = ['accounts.google.com']

/**
 * Paths of login screens shown to the user (`/v3/signin/identifier`, the rejection `/v3/signin/rejected`, the old `/signin/v2/…`).
 * `ServiceLogin` / `CheckCookie` are relays that pass straight through and return when already logged in, so they are not included.
 */
const SIGNIN_PATH = /^\/(v3\/)?signin(\/|$)/i

/** Whether `url` is a login screen that cannot be logged in to in the Web view (true only for http(s)). */
export function isEmbedRefusedLogin(url: unknown): boolean {
  if (!isWebViewerUrl(url)) return false
  try {
    const parsed = new URL(url)
    return EMBED_REFUSED_LOGIN_HOSTS.includes(parsed.hostname.toLowerCase()) && SIGNIN_PATH.test(parsed.pathname)
  } catch {
    return false
  }
}

/**
 * Whether a Web tab read in the background has arrived at a login screen (TODO 1087 part 1). Separate from `isEmbedRefusedLogin` (857, which sends to the default browser);
 * this decision is for "not returning the body of a login form to the model". It counts the main login screens in addition to Google.
 * Hosts must match exactly (spoofed subdomains are not counted), and if `path` is given it is a prefix match. A password field inside a page is
 * checked separately by `loginForm` in `page-text.ts`.
 */
export const LOGIN_PAGE_PATTERNS: ReadonlyArray<{
  readonly host: string
  readonly path?: RegExp
  /** If true, `*.host` is also counted (such as Slack's per-workspace subdomains). */
  readonly subdomains?: true
}> = [
  { host: 'accounts.google.com', path: SIGNIN_PATH },
  { host: 'login.microsoftonline.com' },
  { host: 'login.live.com' },
  { host: 'login.microsoft.com' },
  { host: 'appleid.apple.com', path: /^\/(sign-in|auth)/i },
  { host: 'idmsa.apple.com' },
  { host: 'github.com', path: /^\/(login|session|sessions)(\/|$)/i },
  { host: 'gitlab.com', path: /^\/users\/sign_in/i },
  { host: 'slack.com', path: /^\/(signin|sign_in|workspace-signin)/i, subdomains: true },
  { host: 'id.atlassian.com', path: /^\/login/i },
  { host: 'www.facebook.com', path: /^\/login/i },
  { host: 'twitter.com', path: /^\/i\/flow\/login/i },
  { host: 'x.com', path: /^\/i\/flow\/login/i },
  { host: 'www.linkedin.com', path: /^\/(login|checkpoint)/i },
  { host: 'login.salesforce.com' },
  { host: 'accounts.zoho.com' },
  { host: 'signin.aws.amazon.com' },
  { host: 'www.amazon.com', path: /^\/ap\/signin/i },
  { host: 'www.amazon.co.jp', path: /^\/ap\/signin/i }
]

/** `*.okta.com` / `*.oktapreview.com` / `*.auth0.com` / `*.onelogin.com` are per-tenant subdomains, so they are matched by suffix. */
const LOGIN_PAGE_HOST_SUFFIXES: readonly string[] = ['.okta.com', '.oktapreview.com', '.auth0.com', '.onelogin.com']

/** Even with a tenant suffix, these first labels are public documentation / guidance sites (TODO 1087 review). */
const LOGIN_PUBLIC_LABELS: readonly string[] = ['developer', 'developers', 'www', 'docs', 'community', 'support', 'help', 'blog']
/** Of the tenants (suffix matches), only those whose path looks like a login are counted. */
const TENANT_LOGIN_PATH = /^\/(login|signin|sign-in|sign_in|oauth2?|authorize|u\/|app\/|auth)/i

/** Whether `url` is a login screen (true only for http(s)). Includes ones other than Google. */
export function isLoginPageUrl(url: unknown): boolean {
  if (!isWebViewerUrl(url)) return false
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (LOGIN_PAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      const label = host.split('.')[0] ?? ''
      if (LOGIN_PUBLIC_LABELS.includes(label)) return false
      return TENANT_LOGIN_PATH.test(parsed.pathname)
    }
    return LOGIN_PAGE_PATTERNS.some(
      (entry) =>
        (entry.host === host || (entry.subdomains === true && host.endsWith('.' + entry.host))) &&
        (entry.path === undefined || entry.path.test(parsed.pathname))
    )
  } catch {
    return false
  }
}

/** The modifier keys of a click. Only the part of `MouseEvent` used for dispatch (tests can build it as a plain object). */
export interface LinkClickModifiers {
  readonly shiftKey?: boolean
  readonly metaKey?: boolean
  readonly ctrlKey?: boolean
}

/**
 * Where a click on an external link goes (TODO 400, owner decision 2026-10-04).
 *
 * - A plain click on `http(s):` -> `'viewer'` (shown in the ViewerPane).
 * - shift / Cmd (and Ctrl, the "new tab" convention outside mac) + click -> `'external'` (the OS browser).
 * - `mailto:` and `http(s):` with credentials -> `'external'` (not shown as a page).
 * - Anything else -> `'none'`.
 *
 * For every destination main re-validates with the same pure functions (`web.load` uses `isWebViewerUrl`,
 * `app.openExternal` uses `isOpenableExternally`).
 */
export function webLinkTarget(
  url: unknown,
  modifiers: LinkClickModifiers = {}
): 'viewer' | 'external' | 'none' {
  if (!isOpenableExternally(url)) return 'none'
  const forced = modifiers.shiftKey === true || modifiers.metaKey === true || modifiers.ctrlKey === true
  if (!forced && isWebViewerUrl(url)) return 'viewer'
  return 'external'
}
