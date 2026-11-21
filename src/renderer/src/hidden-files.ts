/**
 * Pure functions for hiding names that start with "." in the file tree (TODO 261, wave 15 bundle D).
 *
 * The hiding itself is done in the index process (`showHidden: false` of `FsIndexer.listDirectory`),
 * narrowing before the list is cut at `MAX_ROWS`. Here is only building the `keep` that the renderer attaches when asking for a listing
 * (paths that are not removed even when hiding) and the decision for ⌘⇧. . It depends on neither `window` nor a store.
 */
import type { ListDirectoryOptions } from '@shared/types.js'

/** Upper limit of `keep` (the same as `LIST_KEEP_MAX` in main / the index process). */
const KEEP_MAX = 32

function trimSlash(uri: string): string {
  return uri.length > 'file:///'.length && uri.endsWith('/') ? uri.slice(0, -1) : uri
}

/** The last segment (the name) of a URI. */
export function lastSegment(uri: string): string {
  const trimmed = trimSlash(uri)
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** The parent URI. The root's (`file:///`) parent is null. */
export function parentUri(uri: string): string | null {
  const trimmed = trimSlash(uri)
  const at = trimmed.lastIndexOf('/')
  if (at < 'file://'.length || trimmed === 'file:///') return null
  const parent = trimmed.slice(0, at)
  return parent === 'file://' ? 'file:///' : parent
}

/** Whether the name starts with "." (the same as Finder / `ls`, no exceptions). `.` and `..` never come as names. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

/**
 * A directory starting with "." that was `expand`ed while hiding is remembered as a path (pin). It does not appear in a hidden listing,
 * so what comes here is only the working folder's reveal (item 49) or the path to a file opened in the viewer.
 * Things like `.git` that the user opened while they were shown are not remembered (when hidden they vanish, as in Finder).
 */
export function shouldPin(uri: string, showHidden: boolean): boolean {
  return !showHidden && isHiddenName(lastSegment(uri))
}

/** Keep only the `keep` candidates that hang directly under `uri` (no duplicates, with an upper limit). */
export function keepUnder(uri: string, candidates: Iterable<string | null>): string[] {
  const prefix = `${trimSlash(uri)}/`
  const out = new Set<string>()
  for (const candidate of candidates) {
    if (candidate === null) continue
    const target = trimSlash(candidate)
    if (!target.startsWith(prefix) || target.length === prefix.length) continue
    out.add(target)
    if (out.size >= KEEP_MAX) break
  }
  return [...out]
}

/** How to show things when asking for a listing. If they are shown, nothing is narrowed. */
export function listOptions(
  uri: string,
  showHidden: boolean,
  candidates: Iterable<string | null>
): ListDirectoryOptions {
  if (showHidden) return { showHidden: true }
  const keep = keepUnder(uri, candidates)
  return keep.length === 0 ? { showHidden: false } : { showHidden: false, keep }
}

/**
 * Whether this is ⌘⇧. (Ctrl+Shift+.). Normally the menu's accelerator eats it first, but as insurance for when it does not
 * (key layout reasons, etc.) the renderer also catches it; only one of the two ever arrives, so it is not doubled.
 * Some layouts turn `key` into `>` with Shift, so it is judged by the physical key's `code`.
 */
export function isToggleHiddenKey(event: {
  readonly key: string
  readonly code: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}, platform: 'mac' | 'other'): boolean {
  if (!event.shiftKey || event.altKey) return false
  const primary = platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return primary && event.code === 'Period'
}
