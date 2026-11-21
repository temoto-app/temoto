/**
 * URI utilities.
 *
 * Convention (IMPLEMENTATION_BRIEF 7): file paths are handled only in main, and the renderer sees
 * only URIs. These are pure functions over URI strings only and do not
 * depend on `node:path`. Path <-> URI conversion is in main's `src/main/uri.ts`.
 */

/** The scheme the viewer can open. Corresponds to the `uri` column of ARCHITECTURE.md 6.3. */
export const FILE_SCHEME = 'file:'

/**
 * Internal scheme for passing binaries to the renderer.
 * Main registers a protocol handler and serves only what is under allowed roots.
 * The renderer never reads file:// directly (to keep webSecurity).
 */
export const RESOURCE_SCHEME = 'aios-res:'

/**
 * Always put an authority. Because it is registered as a standard scheme, Chromium
 * interprets the first element of `aios-res:///Users/x` as the host name,
 * which shifts the path by one level. A fixed host name in between removes this ambiguity.
 */
export const RESOURCE_HOST = 'local'

/** Token of `aios-res://` (review A-4). The Broker issues 128 random bits as hex. */
export const RESOURCE_TOKEN_PATTERN = /^[0-9a-f]{32}$/

/**
 * A token-bearing `aios-res://` URL (A-4): `aios-res://local/<token>/<name>`.
 * **Only the token decides whether to serve**; the trailing name is merely a hint for display and extension
 * (the serving side does not read it). The authority (`local`) is always put, for the reason above.
 */
export function tokenResourceUrl(token: string, name: string): string {
  return `${RESOURCE_SCHEME}//${RESOURCE_HOST}/${token}/${encodeURIComponent(name)}`
}

/** Extract the token from `aios-res://local/<token>/…`. null if the shape is wrong. */
export function resourceTokenOf(url: string): string | null {
  const prefix = `${RESOURCE_SCHEME}//${RESOURCE_HOST}/`
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length)
  const cut = rest.search(/[/?#]/)
  const token = cut < 0 ? rest : rest.slice(0, cut)
  return RESOURCE_TOKEN_PATTERN.test(token) ? token : null
}

// The old form (`toResourceUrl` / `resourceUrlToFileUri` of `aios-res://local/<path>`, which carried the path as is)
// was removed (the remainder of item 132, wave 13 bundle D). The serving side accepts only the token form
// (review A-4), and the image branch of `FsAccess.readResource`, its last caller, is gone too.

/** Last element of a URI (display name). A trailing slash is ignored. */
export function uriBasename(uri: string): string {
  const withoutQuery = uri.split(/[?#]/, 1)[0] ?? uri
  const trimmed = withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return decodeURIComponent(last)
}

/** Parent URI. null at the root (file:///). */
export function uriDirname(uri: string): string | null {
  const trimmed = uri.endsWith('/') ? uri.slice(0, -1) : uri
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0) return null
  const parent = trimmed.slice(0, cut)
  if (parent === 'file://' || parent === 'aios-res://') return `${parent}/`
  if (!parent.includes('/', parent.indexOf('//') + 2)) return `${parent}/`
  return parent
}

/** Extension (lowercase, no dot). Empty string if none. */
export function uriExtension(uri: string): string {
  const name = uriBasename(uri)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** Shortened path for display. Under the home URI it is collapsed to `~/...`. */
export function displayPath(uri: string, homeUri: string): string {
  const decoded = decodeURIComponent(uri.slice(FILE_SCHEME.length + 2))
  const home = decodeURIComponent(homeUri.slice(FILE_SCHEME.length + 2))
  if (decoded === home) return '~'
  if (decoded.startsWith(`${home}/`)) return `~${decoded.slice(home.length)}`
  return decoded
}

/**
 * The real path of a `file://` URI (home is not collapsed to `~`; the "copy full path" of TODO 289).
 * Unlike `displayPath`, it does not collapse. For a Windows drive (`/C:/x`) the leading `/` is dropped.
 */
export function fullPath(uri: string): string {
  const decoded = decodeURIComponent(uri.slice(FILE_SCHEME.length + 2))
  return /^\/[A-Za-z]:[/\\]/.test(decoded) ? decoded.slice(1) : decoded
}

/**
 * Swap a URI after a rename (TODO 1145). If `current` is exactly `from` or inside it (`from/…`), the URI with it replaced by
 * `to`; otherwise `current` unchanged. null if `current` is null.
 */
export function replaceUriPrefix(current: string | null, from: string, to: string): string | null {
  if (current === null) return null
  if (current === from) return to
  const base = from.endsWith('/') ? from : `${from}/`
  return current.startsWith(base) ? `${to.endsWith('/') ? to.slice(0, -1) : to}/${current.slice(base.length)}` : current
}
