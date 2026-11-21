/**
 * Drops the home itself and the parents of the home from the OS sandbox's "places writable outside the cwd" (`sandbox.allowWrite`)
 * (TODO 1109 part 8, ARCHITECTURE 4.2.4).
 *
 * `normalizeSandboxWritePath` in shared cannot use `os.homedir()`, so it can only look at the shape (`/Users`, `/Users/<name>`, `/home/<name>`, `/root`),
 * and a home in another place (`/Volumes/data/me`, `/srv/home/me`, etc.) gets through. Here main compares with the real home.
 * Being able to write to the whole home (and its parents) is the same as turning the sandbox OFF, so it is not accepted. Anything **inside** the home (`~/.npm`) is accepted.
 *
 * - `~/…` is expanded to the home before comparing (the same as the Adapter expands at launch - `expandHome` in `src/main/home-path.ts`).
 * - Case is not distinguished (the default macOS volume does not distinguish it. Dropping a different folder that differs only in case on Linux does little harm).
 * - The caller passes the homes (both `os.homedir()` and its realpath if they differ).
 */
import { resolve } from 'node:path'
import { expandHome } from '../home-path.js'

/** The form used for comparison (absolute path, no trailing `/`, lower case). */
function comparable(path: string): string {
  const resolved = resolve(path)
  return (resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved).toLowerCase()
}

/** Whether `path` (a normalized writable place) is the home itself or a parent of it. */
export function isHomeOrAncestor(path: string, homes: readonly string[]): boolean {
  return homes.some((home) => {
    if (home === '') return false
    const target = comparable(expandHome(path, home))
    const base = comparable(home)
    return target === base || base.startsWith(target === '/' ? '/' : `${target}/`)
  })
}

/** Drops the home itself and its parents from the list of writable places (order is kept). */
export function dropHomeWritePaths(paths: readonly string[], homes: readonly string[]): string[] {
  return paths.filter((path) => !isHomeOrAncestor(path, homes))
}
