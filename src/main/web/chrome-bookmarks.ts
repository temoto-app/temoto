/**
 * Pure functions that flatten the JSON of Chrome's (Chromium family) `Bookmarks` / `Local State` (TODO 676, ARCHITECTURE 5.2.1).
 *
 * **Depends on neither electron nor fs** — tests pass fixture objects directly. Reading the real files is done by
 * `src/main/web/chrome-import.ts` (which uses node:fs, so it runs only inside main).
 *
 * - `Bookmarks` is unencrypted JSON, with trees of `type: "folder"` and `type: "url"` under `roots.bookmark_bar` / `roots.other` / `roots.synced`
 *   (Bookmarks Bar / Other / Mobile).
 *   Folders are flattened, and the order is the **depth-first** walk of these 3 roots.
 * - The profile display names are in `profile.info_cache` of `Local State` (the key is the profile's directory name).
 * - **The table of locations is only here** (this time only `chrome` is used. Edge / Brave / Arc have the same JSON shape, so
 *   adding them should only need a row in this table — the same idea as the study notes of 677).
 */

import { chromeAppBundlePath } from '../os/browsers.js'

/** One bookmark (only the title and URL; it holds no folder information). */
export interface FlatChromeBookmark {
  readonly title: string
  readonly url: string
}

/** One profile readable from `Local State` (display name; the caller adds the count). */
export interface ChromeProfileEntry {
  readonly dir: string
  readonly name: string
}

/** The table of Chromium-family browsers (the locations themselves are in the OS layer `../os/browsers.ts`). */
export const CHROMIUM_BROWSER_DIRS: Readonly<Record<string, { readonly label: string }>> = {
  chrome: { label: 'Google Chrome' }
}

/** TODO 723: the path of Chrome.app's bundle. The location is in the OS layer (TODO 986 stage 2, `../os/browsers.ts`). */
export { chromeAppBundlePath }

/** The shape of the image `AppIconCache` (562) returns. */
export interface LoadedIcon {
  isEmpty(): boolean
  toDataURL(): string
}

/**
 * TODO 723: turn Chrome.app's icon into a data URL. `exists` / `getIcon` are injected by the caller (the electron-dependent side of
 * main) — this file imports neither the real `fs` nor `electron` (so tests need not
 * peek at the real `/Applications`). Null for not found, unreadable, or an exception (never throws, the same decision as 149 / 562).
 */
export async function loadChromeAppIcon(
  path: string,
  exists: (path: string) => boolean,
  getIcon: (path: string) => Promise<LoadedIcon>
): Promise<string | null> {
  if (!exists(path)) return null
  try {
    const image = await getIcon(path)
    return image.isEmpty() ? null : image.toDataURL()
  } catch {
    return null
  }
}

interface ChromeBookmarkNode {
  readonly type?: unknown
  readonly name?: unknown
  readonly url?: unknown
  readonly children?: unknown
}

function walk(node: unknown, out: FlatChromeBookmark[]): void {
  if (typeof node !== 'object' || node === null) return
  const typed = node as ChromeBookmarkNode
  if (typed.type === 'url' && typeof typed.url === 'string') {
    out.push({ title: typeof typed.name === 'string' ? typed.name : '', url: typed.url })
    return
  }
  if (typed.type === 'folder' && Array.isArray(typed.children)) {
    for (const child of typed.children) walk(child, out)
  }
}

/** Walk the roots in this order: bookmarks bar -> other -> mobile (`synced`). */
const ROOT_ORDER: readonly string[] = ['bookmark_bar', 'other', 'synced']

/** Flatten the contents of the `Bookmarks` file (already `JSON.parse`d). An empty array if the shape is wrong. */
export function flattenChromeBookmarks(bookmarksJson: unknown): FlatChromeBookmark[] {
  if (typeof bookmarksJson !== 'object' || bookmarksJson === null) return []
  const roots = (bookmarksJson as { readonly roots?: unknown }).roots
  if (typeof roots !== 'object' || roots === null) return []
  const out: FlatChromeBookmark[] = []
  const record = roots as Record<string, unknown>
  for (const key of ROOT_ORDER) walk(record[key], out)
  return out
}

/**
 * Whether the `profileDir` that came from the renderer may be used as it is in `join(dir, profileDir, 'Bookmarks')`
 * (fix from code-review, security). Anything containing a separator (`/` / `\`) or `..` could, through `path.join`'s
 * normalization, point outside `~/Library/Application Support/Google/Chrome` (at an arbitrary file), so it is refused.
 * In addition, the caller also checks that it is actually in the set `listChromeProfiles` returned (a double choke point).
 */
export function isSafeChromeProfileDir(value: string): boolean {
  if (value === '' || value === '.' || value === '..') return false
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false
  return true
}

/** From the contents of `Local State`, build the list of profiles in `info_cache` (with display names). Empty if none. */
export function parseChromeProfiles(localStateJson: unknown): ChromeProfileEntry[] {
  if (typeof localStateJson !== 'object' || localStateJson === null) return []
  const profile = (localStateJson as { readonly profile?: unknown }).profile
  if (typeof profile !== 'object' || profile === null) return []
  const cache = (profile as { readonly info_cache?: unknown }).info_cache
  if (typeof cache !== 'object' || cache === null) return []
  const out: ChromeProfileEntry[] = []
  for (const [dir, info] of Object.entries(cache as Record<string, unknown>)) {
    const name =
      typeof info === 'object' && info !== null && typeof (info as { readonly name?: unknown }).name === 'string'
        ? (info as { readonly name: string }).name
        : dir
    out.push({ dir, name })
  }
  return out
}
