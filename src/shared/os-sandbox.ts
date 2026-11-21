/**
 * The OS sandbox allow table (TODO 1106, ARCHITECTURE 4.2.4). Only terms that do not depend on the backend.
 *
 * When launching a thread with the sandbox ON, the backend is given "the destinations the shell tool may connect to" and "the places outside cwd where writing is allowed".
 * The lists are `sandbox.allowedDomains` / `sandbox.allowWrite` in `app_settings` (`src/common/settings-keys.ts`, owned by main).
 * **A change takes effect from the next launch**: it does not reach a running process (the backend only reads the allow table at launch,
 * and a question about a new destination does not reach the approval entry point in a non-interactive launch and is refused automatically; wave 67 spike 37).
 *
 * Decisions (owner decision 2026-11-03):
 * - The default destinations are the npm registry and GitHub (including `*.github.com`). At launch, the hosts of the "no-ask destinations" (TODO 1029) are added too.
 * - The default writable place is `~/.npm` (npm's cache; without it `npm install` breaks, spike 37).
 */

/** Default destinations (owner decision 2026-11-03). */
export const DEFAULT_SANDBOX_ALLOWED_DOMAINS: readonly string[] = ['registry.npmjs.org', 'github.com', '*.github.com']

/** Default places writable outside cwd (owner decision 2026-11-03). */
export const DEFAULT_SANDBOX_ALLOW_WRITE: readonly string[] = ['~/.npm']

/** Upper limit of a list (entries). It is added to from the settings screen, so a small value is fine. */
export const MAX_SANDBOX_ENTRIES = 200
const MAX_DOMAIN_LENGTH = 253
const MAX_PATH_LENGTH = 1024

/**
 * An absolute path of the whole home directory or its parent (macOS / Linux). `os.homedir()` cannot be used in shared, so this looks at the shape. A home in another place
 * (such as `/Volumes/x/me`) is dropped by main by comparing with the real home (TODO 1109 item 8, `src/main/session/sandbox-home.ts`).
 */
const HOME_OR_PARENT = /^\/(?:Users|home)(?:\/[^/]+)?$|^\/(?:root|var\/root)$/

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Puts one destination (`example.com` / `*.example.com`) into a comparable form. Schemes, paths, ports and whitespace are not accepted.
 * IP addresses are not accepted (the backend's allow table matches by host name). null for a form that cannot be read.
 */
export function normalizeSandboxDomain(raw: string): string | null {
  let text = raw.trim().toLowerCase()
  if (text.endsWith('.')) text = text.slice(0, -1)
  const wildcard = text.startsWith('*.')
  const host = wildcard ? text.slice(2) : text
  if (host === '' || host.length > MAX_DOMAIN_LENGTH) return null
  const labels = host.split('.')
  // A single label (`localhost`, `com`) is not accepted. After `*.` there must also be 2 or more labels.
  if (labels.length < 2) return null
  if (!labels.every((label) => LABEL.test(label))) return null
  // A last label that is all digits is an IP address or an invalid TLD.
  if (/^\d+$/.test(labels[labels.length - 1] ?? '')) return null
  return wildcard ? `*.${host}` : host
}

/**
 * Puts one writable place into a comparable form. Only an absolute path starting with `/` or a home-relative path starting with `~/`.
 * `/` and `~` themselves, and the home and its parents (`/Users`, `/Users/<name>`, `/home/<name>`) are not accepted (whole machine / whole home): that would be the same as turning the sandbox OFF.
 * A trailing `/` is dropped. Control characters and `..` segments are not accepted. null for a form that cannot be read.
 */
export function normalizeSandboxWritePath(raw: string): string | null {
  let text = raw.trim()
  if (text === '' || text.length > MAX_PATH_LENGTH) return null
  // Control characters (newline, NUL, etc.) are not accepted.
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return null
  }
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
  if (!(text.startsWith('/') || text.startsWith('~/'))) return null
  if (text === '/' || text === '~') return null
  // The whole home and its parents (`/Users`, `/Users/<name>`, `/home/<name>`, `/root`) are not accepted either: being able to write the whole home is the same as OFF.
  if (HOME_OR_PARENT.test(text)) return null
  const parts = text.split('/')
  if (parts.some((part) => part === '..' || part === '.')) return null
  if (text.includes('//')) return null
  return text
}

function sanitize(value: unknown, normalize: (raw: string) => string | null): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const normalized = normalize(entry)
    if (normalized === null || out.includes(normalized)) continue
    out.push(normalized)
    if (out.length >= MAX_SANDBOX_ENTRIES) break
  }
  return out
}

/** Re-validates a list of destinations that came from a saved value or the renderer. Unreadable elements are dropped. */
export function sanitizeSandboxDomains(value: unknown): string[] {
  return sanitize(value, normalizeSandboxDomain)
}

/** Re-validates a list of writable places that came from a saved value or the renderer. Unreadable elements are dropped. */
export function sanitizeSandboxWritePaths(value: unknown): string[] {
  return sanitize(value, normalizeSandboxWritePath)
}

/** The fields of the approval-default diff that concern the sandbox allow table (the part of `ApprovalPolicyPatch`). Adding and removing have the same shape as the no-ask destinations. */
export interface SandboxListsPatch {
  readonly sandboxAllowedDomains?: readonly string[]
  readonly sandboxAllowedDomainsAdd?: readonly string[]
  readonly sandboxAllowedDomainsRemove?: readonly string[]
  readonly sandboxAllowWrite?: readonly string[]
  readonly sandboxAllowWriteAdd?: readonly string[]
  readonly sandboxAllowWriteRemove?: readonly string[]
}

function applyList(
  current: readonly string[],
  whole: readonly string[] | undefined,
  add: readonly string[] | undefined,
  remove: readonly string[] | undefined,
  clean: (value: unknown) => string[]
): string[] {
  const base = clean(whole ?? current)
  const removed = new Set(clean(remove ?? []))
  return clean([...base.filter((entry) => !removed.has(entry)), ...(add ?? [])])
}

/** Applies a diff to the current list of destinations (if a whole value is given, it is the base; remove, then add). */
export function applySandboxDomainsPatch(current: readonly string[], patch: SandboxListsPatch): string[] {
  return applyList(
    current,
    patch.sandboxAllowedDomains,
    patch.sandboxAllowedDomainsAdd,
    patch.sandboxAllowedDomainsRemove,
    sanitizeSandboxDomains
  )
}

/** Applies a diff to the current list of writable places. */
export function applySandboxWritePatch(current: readonly string[], patch: SandboxListsPatch): string[] {
  return applyList(current, patch.sandboxAllowWrite, patch.sandboxAllowWriteAdd, patch.sandboxAllowWriteRemove, sanitizeSandboxWritePaths)
}

/** The allow table passed to a launch (the Adapter builds it into the backend's settings shape). */
export interface OsSandboxPolicy {
  readonly allowedDomains: readonly string[]
  readonly allowWrite: readonly string[]
}

/**
 * The destinations passed to a launch: the settings list + the hosts of the no-ask destinations (TODO 1029) (dropping `user@`, only those readable as a name).
 * The no-ask destinations are a table of ssh targets, but https to the same hosts is allowed too (owner decision 2026-11-03: the same as the table of 1031 + npm / GitHub).
 */
export function sandboxDomainsForLaunch(domains: readonly string[], sshHosts: readonly string[]): string[] {
  const hosts = sshHosts.map((entry) => entry.slice(entry.lastIndexOf('@') + 1).trim().toLowerCase())
  // An ssh target can be a single-label host (`winbox`, or `nas` in `user@nas`). The settings list accepts only 2 or more labels, but here it is passed on rather than dropped
  // (if the allow table does not accept it, it is just ignored, and other entries are not dragged down with it).
  const single = hosts.filter((host) => !host.includes('.') && LABEL.test(host) && !/^\d+$/.test(host))
  return [...new Set([...sanitizeSandboxDomains([...domains, ...hosts]), ...single])].slice(0, MAX_SANDBOX_ENTRIES)
}
