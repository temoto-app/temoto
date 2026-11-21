/**
 * The `aios://` URL scheme (TODO 976 stage 3, ARCHITECTURE 3.3). Holds only the **pure functions** that
 * resolve a URL coming from outside (other apps, shortcuts, the shell, the browser). It does not import
 * electron (`URL` / `TextEncoder` are globals; only the `file:` comparison goes through `uri.ts`).
 *
 * The shape is `aios://new?cwd=<path>&text=<text>&file=<path>` (`file` may repeat). This code checks only
 * the shape and the limits; **main (`src/main/app-url.ts`) applies the path check
 * (`FsAccess.assertAllowed`)**. Because the values come from outside, every parameter whose shape is wrong
 * is dropped on its own, an unknown host is ignored entirely, and an unknown query is silently ignored.
 * The text and attachments are only placed in the Composer; **nothing is sent** (one URL must not be able
 * to run the AI).
 */

import { uriToPath } from './uri.js'
import { APP_URL_SCHEMES } from '../shared/product.js'

/**
 * The scheme names registered with the OS (`app.setAsDefaultProtocolClient` and `CFBundleURLSchemes` in Info.plist).
 * TODO 1263: `aios` stays and `temoto` is an alias that works the same (`src/shared/product.json`).
 */
export const APP_URL_SCHEMES_ACCEPTED: readonly string[] = APP_URL_SCHEMES

/** The original scheme name (`aios`). */
export const APP_URL_SCHEME: string = APP_URL_SCHEMES[0] ?? 'aios'

/** Upper bound on the whole URL length (characters). A longer URL is dropped unparsed (well above the %-encoding blow-up of the body limit). */
export const MAX_APP_URL_LENGTH = 1_048_576

/** Upper bound on `text` (UTF-8 bytes). If exceeded, only `text` is dropped (it is not truncated, since cutting it would change its meaning). */
export const MAX_APP_URL_TEXT_BYTES = 65_536

/** Upper bound on the number of `file` parameters. The excess is dropped. */
export const MAX_APP_URL_FILES = 32

/** A dropped parameter (logged; **the value is never logged**, only the parameter name and the reason). */
export type AppUrlParam = 'cwd' | 'text' | 'file'

/**
 * Why a parameter was dropped.
 * - `not-absolute`: neither an absolute path nor a `file:` URI (relative, starts with `~`, or contains NUL).
 * - `too-long`: `text` exceeded the limit.
 * - `too-many`: `file` exceeded the limit (the excess).
 * - `invalid`: `text` contains NUL (U+0000) (newlines and tabs are kept).
 * - `duplicate`: the second or later of a parameter taken only once (`cwd` / `text`), or the second occurrence of the same `file`.
 */
export type AppUrlDropReason = 'not-absolute' | 'too-long' | 'too-many' | 'duplicate' | 'invalid'

export interface AppUrlDropped {
  readonly param: AppUrlParam
  readonly reason: AppUrlDropReason
}

/**
 * The contents of `aios://new`. Every path is **unverified** (only checked to be an absolute path or a `file:` URI).
 */
export interface AppUrlNew {
  readonly action: 'new'
  /** The conversation's working folder. null = not specified (the "new conversation" default = no folder). */
  readonly cwd: string | null
  /** Text to put in the Composer. '' = none. */
  readonly text: string
  readonly files: readonly string[]
  readonly dropped: readonly AppUrlDropped[]
}

export type AppUrlRejection = 'not-app-url' | 'too-long' | 'malformed' | 'unknown-action'

export type AppUrlParse =
  | { readonly ok: true; readonly request: AppUrlNew }
  | { readonly ok: false; readonly reason: AppUrlRejection }

const PREFIXES = APP_URL_SCHEMES_ACCEPTED.map((scheme) => `${scheme}:`)

/** Whether it starts with `aios:` or `temoto:` (case-insensitive, since schemes are case-insensitive). */
export function isAppUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return PREFIXES.some((prefix) => value.slice(0, prefix.length).toLowerCase() === prefix)
}

/**
 * Key for comparing whether two values are the same file. A `file:` URI is turned into a path (decoding %) and a trailing `/` is dropped.
 * Values that cannot be decoded (broken %) are used as they are. Case is not folded (this is only for duplicate detection, not display, so different spellings may be treated as different things).
 */
function fileKey(value: string): string {
  let path = value
  if (path.startsWith('file://')) {
    try {
      path = uriToPath(path)
    } catch {
      return value
    }
  }
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path
}

/** Whether the value has an accepted path shape: an absolute path (`/…`) or a `file:` URI. NUL is rejected. */
function isPathValue(value: string): boolean {
  if (value.includes('\0')) return false
  return value.startsWith('/') || value.startsWith('file://')
}

const encoder = new TextEncoder()

/**
 * Parses a URL. Accepts only `aios://new` (and `aios:new`); any other host is dropped entirely as `unknown-action`.
 * A parameter with the wrong shape is dropped on its own and recorded in `dropped`.
 */
export function parseAppUrl(raw: string): AppUrlParse {
  if (!isAppUrl(raw)) return { ok: false, reason: 'not-app-url' }
  if (raw.length > MAX_APP_URL_LENGTH) return { ok: false, reason: 'too-long' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  // The host of a non-special scheme keeps its case, so fold it here. For `aios:new?…` (no slashes) the host is empty and the name arrives in pathname.
  const action = (url.host !== '' ? url.host : url.pathname).toLowerCase()
  const rest = url.host !== '' ? url.pathname : ''
  if (action !== 'new' || (rest !== '' && rest !== '/')) return { ok: false, reason: 'unknown-action' }

  const params = url.searchParams
  const dropped: AppUrlDropped[] = []

  let cwd: string | null = null
  for (const value of params.getAll('cwd')) {
    if (value === '') continue
    if (cwd !== null) dropped.push({ param: 'cwd', reason: 'duplicate' })
    else if (isPathValue(value)) cwd = value
    else dropped.push({ param: 'cwd', reason: 'not-absolute' })
  }

  // Same as `cwd`, "the first valid one" wins: an invalid (too long) value is dropped and the next is examined. Later ones after the valid one is chosen are `duplicate`.
  let text = ''
  let textSeen = false
  for (const value of params.getAll('text')) {
    if (value === '') continue
    if (textSeen) dropped.push({ param: 'text', reason: 'duplicate' })
    else if (encoder.encode(value).byteLength > MAX_APP_URL_TEXT_BYTES) dropped.push({ param: 'text', reason: 'too-long' })
    else if (value.includes('\0')) dropped.push({ param: 'text', reason: 'invalid' })
    else {
      text = value
      textSeen = true
    }
  }

  const files: string[] = []
  const fileKeys = new Set<string>()
  let overflow = false
  for (const value of params.getAll('file')) {
    if (value === '') continue
    if (!isPathValue(value)) {
      dropped.push({ param: 'file', reason: 'not-absolute' })
      continue
    }
    // `/tmp/a.txt`, `file:///tmp/a.txt` and `/tmp/a.txt/` are the same file. Normalize before comparing.
    const key = fileKey(value)
    if (fileKeys.has(key)) {
      dropped.push({ param: 'file', reason: 'duplicate' })
      continue
    }
    if (files.length >= MAX_APP_URL_FILES) {
      // Record the excess once rather than one entry per item (so tens of thousands of files cannot bloat the log).
      if (!overflow) dropped.push({ param: 'file', reason: 'too-many' })
      overflow = true
      continue
    }
    fileKeys.add(key)
    files.push(value)
  }

  return { ok: true, request: { action: 'new', cwd, text, files, dropped } }
}

/**
 * Picks an `aios:` URL out of the argv of a second launch (`second-instance`) or of this process's own launch
 * (on Windows / Linux the URL is in argv; on macOS it arrives via `open-url`, so it is normally not found).
 * Only the first one found. null if none.
 */
export function findAppUrlInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) if (isAppUrl(arg)) return arg
  return null
}
