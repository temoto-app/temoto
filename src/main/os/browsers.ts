/**
 * OS layer (TODO 986 stage 2): the location of the browser (Chrome). On macOS, `~/Library/Application Support/Google/Chrome` and
 * `/Applications/Google Chrome.app`. The Windows version (TODO 899) will add a separate implementation on the `%LOCALAPPDATA%` side.
 * Pure functions (electron is not imported). Callers are `src/main/web/chrome-import.ts` / `chrome-bookmarks.ts`.
 */
import { join } from 'node:path'
import { APPLICATIONS_DIR } from '../../common/os/macos-paths.js'

/** The path from `home` to Chrome's user data directory. */
export function chromeUserDataDir(home: string): string {
  return join(home, 'Library', 'Application Support', 'Google', 'Chrome')
}

/** The path of the Chrome.app bundle (to read the icon; not bundled). `applicationsDir` is for tests. */
export function chromeAppBundlePath(applicationsDir: string = APPLICATIONS_DIR): string {
  return `${applicationsDir}/Google Chrome.app`
}
