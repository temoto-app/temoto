/**
 * The entry point where main reads Chrome's bookmarks (TODO 676, ARCHITECTURE 5.2.1).
 *
 * **It reads only 2 files, `Bookmarks` and `Local State`** (both unencrypted JSON).
 * It does not touch other files such as `Cookies` / `Login Data`. It does not go through plugins (the Web view has kept to the policy of not going through
 * plugins since 400 / 522). `~/Library` is excluded from the index, but it is fine for main to read these files
 * (the `FsAccess` exclusion is a choke point for paths coming from the renderer; here main itself only reads hard-coded paths).
 *
 * Tests pass fixture JSON or a temporary directory as `home` — **the owner's real Chrome
 * files are not read** (the common rule of wave 31 bundle C).
 *
 * **The caller (the default argument of `listChromeProfiles` / `importChromeBookmarks`) passes `home` from
 * `node:os`'s `homedir()`. These functions themselves do not read env** — the hook that points the read location at a
 * fake place only in a verification build (`AIOS_CHROME_HOME_DIR`, TODO 687) is on main's electron-dependent side
 * (`src/main/web/register.ts`). In the 36th proxy verification (TODO 690), `os.homedir` could not be replaced from the inspector (because of ESM),
 * and the owner's real Chrome profile names and counts showed up on screen, an accident.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAX_WEB_FAVORITES, persistableWebUrl, type ChromeImportProfile, type ChromeImportResult } from '@shared/web-tabs.js'
import { log } from '../../common/logger.js'
import { chromeUserDataDir } from '../os/browsers.js'
import { flattenChromeBookmarks, isSafeChromeProfileDir, parseChromeProfiles } from './chrome-bookmarks.js'
import type { WebDataStore } from './data.js'

/**
 * The path from `home` to Chrome's location. **Exposed for proxy verification** (TODO 687): used by the main side
 * (`src/main/web/register.ts`) when it replaces `home` with `AIOS_CHROME_HOME_DIR`, to put the path where the replacement took effect
 * in one log line (the path only). This function itself does not read env
 * (it stays pure and takes it as an argument).
 */
export function chromeBookmarksBaseDir(home: string): string {
  return chromeUserDataDir(home)
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/**
 * The list of profiles (only those with Bookmarks, with counts). If `Local State` is missing, Chrome is taken to be not installed or never
 * used and it returns **`null`** (the reason is shown at the entry). If `Local State` exists but no profile has Bookmarks,
 * an empty array.
 */
export async function listChromeProfiles(home: string = homedir()): Promise<readonly ChromeImportProfile[] | null> {
  const dir = chromeBookmarksBaseDir(home)
  const localState = await readJson(join(dir, 'Local State'))
  if (localState === null) return null
  const profiles = parseChromeProfiles(localState)
  const out: ChromeImportProfile[] = []
  for (const profile of profiles) {
    const bookmarks = await readJson(join(dir, profile.dir, 'Bookmarks'))
    if (bookmarks === null) continue
    out.push({ dir: profile.dir, name: profile.name, count: flattenChromeBookmarks(bookmarks).length })
  }
  return out
}

/**
 * Import the chosen profile's bookmarks into Favorites (appended at the end, in depth-first order).
 * The same URL (as passed through `persistableWebUrl`) is skipped, as is anything beyond the limit (`MAX_WEB_FAVORITES`).
 * `null` if Bookmarks cannot be read.
 *
 * **`profileDir` is a string from the renderer** (`ipc/webChromeImport`; it should be a selection from the list `listChromeProfiles`
 * returned), so it is re-validated before being used in `join` as it is (fix from code-review, security):
 * anything containing a separator or `..` is refused by `isSafeChromeProfileDir`, and it is also checked that it **actually exists in the set
 * `listChromeProfiles` returns right now** — with a profile name not in `Local State` (a made-up directory name),
 * nothing outside `~/Library/Application Support/Google/Chrome`, let alone an arbitrary file inside it, can be read.
 */
export async function importChromeBookmarks(
  data: WebDataStore,
  profileDir: string,
  home: string = homedir()
): Promise<ChromeImportResult | null> {
  if (!isSafeChromeProfileDir(profileDir)) {
    log.warn('web.favorites.chromeImportRejected', { reason: 'unsafe-profile-dir' })
    return null
  }
  const profiles = await listChromeProfiles(home)
  if (profiles === null || !profiles.some((profile) => profile.dir === profileDir)) {
    log.warn('web.favorites.chromeImportRejected', { reason: 'unknown-profile-dir' })
    return null
  }
  const dir = chromeBookmarksBaseDir(home)
  const bookmarksJson = await readJson(join(dir, profileDir, 'Bookmarks'))
  if (bookmarksJson === null) return null
  const flat = flattenChromeBookmarks(bookmarksJson)
  const existing = new Set(data.listFavorites().map((favorite) => favorite.url))
  let count = existing.size
  let alreadyPresent = 0
  let skippedOverLimit = 0
  // Sort out only what may be added (neither a duplicate nor over the limit), and group the actual writes below into
  // one transaction (fix from code-review: what was 677 autocommits for 677 entries now
  // holds main's JS thread once).
  const candidates: { readonly url: string; readonly title: string }[] = []
  for (const bookmark of flat) {
    const stored = persistableWebUrl(bookmark.url)
    if (stored === null) continue // URLs that cannot be kept, such as javascript: / chrome://, are skipped without being counted
    if (existing.has(stored)) {
      alreadyPresent += 1
      continue
    }
    if (count >= MAX_WEB_FAVORITES) {
      skippedOverLimit += 1
      continue
    }
    candidates.push({ url: bookmark.url, title: bookmark.title })
    count += 1
    existing.add(stored)
  }
  const results = data.addFavoritesBatch(candidates)
  let imported = 0
  for (const ok of results) {
    if (ok) imported += 1
    else skippedOverLimit += 1
  }
  log.info('web.favorites.chromeImported', { imported, alreadyPresent, skippedOverLimit })
  return { imported, alreadyPresent, skippedOverLimit }
}
