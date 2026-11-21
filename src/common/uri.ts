/**
 * Conversion between path and URI. **Only main** handles file paths (IMPLEMENTATION_BRIEF chapter 7).
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { FILE_SCHEME } from '@shared/uri.js'

export function pathToUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href
}

/**
 * Turns a URI back into an absolute path. Anything other than file: is rejected
 * (the first choke point so that a value from the renderer is not passed straight to fs).
 */
export function uriToPath(uri: string): string {
  if (!uri.startsWith(FILE_SCHEME)) throw new Error(`unsupported scheme: ${uri.slice(0, 16)}`)
  return fileURLToPath(uri)
}

/**
 * APFS is case-insensitive by default (PHASE1_BRIEF 3.3).
 * Use this case-folded value for duplicate detection and path comparison.
 */
export function foldPath(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

/**
 * Whether `path` is `base` itself or under it (compared after folding with `foldPath`). **It respects the separator boundary** -
 * `/a/bc` is not under `/a/b`. A trailing `/` is ignored (`/` itself contains everything).
 * The conversation search's "this working folder" section (TODO 1096) uses it to sort threads' cwds.
 */
export function isSameOrUnderPath(path: string, base: string): boolean {
  if (path === '' || base === '') return false
  // A slash-only value such as `//` becomes empty after trim. Empty is treated as `/` (root) (TODO 1096 review).
  const trim = (value: string): string => value.replace(/\/+$/, '') || '/'
  const folded = trim(foldPath(path))
  const foldedBase = trim(foldPath(base))
  if (foldedBase === '/') return folded.startsWith('/')
  return folded === foldedBase || folded.startsWith(`${foldedBase}/`)
}

/**
 * The cwd URI -> absolute path for the conversation search's "this working folder" section (TODO 1096). **The only checks are "a `file:` URI that
 * can be turned back into an absolute path and contains no NUL"** - the file index's exclusion rules (`assertAllowed`) are not applied. The section's
 * filtering is done on the threads table's cwd and no files are read, so the section is shown even for threads whose cwd is under `node_modules` or `~/Library/Caches`.
 * main's entry point and the index process's kernel check with the same function. null if it does not pass.
 */
export function conversationCwdPathOf(uri: unknown): string | null {
  // `fileURLToPath` reads even `file:relative` as `/relative`, so require `file://`, the same as `pathFromUri` in `fs-policy`.
  if (typeof uri !== 'string' || !uri.startsWith(`${FILE_SCHEME}//`)) return null
  let path: string
  try {
    path = fileURLToPath(uri)
  } catch {
    return null
  }
  if (!isAbsolute(path) || path.includes('\0')) return null
  return resolve(path)
}
