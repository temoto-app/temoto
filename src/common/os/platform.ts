/**
 * OS layer (TODO 986, ARCHITECTURE 3.4): the only place that asks "which OS are we on".
 *
 * This is the only file that reads `process.platform` (enforced by `npm run lint:os`). Callers go through
 * `hostPlatform()` / `isMac()`, so OS-dependent places can be found mechanically as "places that import `common/os` / `main/os`"
 * (the starting point for the Windows version = TODO 899 survey).
 *
 * It does not import electron (also used from the index process; constraint 8.1). Behavior is the same as before it was moved here.
 */

export function hostPlatform(): NodeJS.Platform {
  return process.platform
}

/**
 * Whether it is macOS. If the argument is omitted it looks at the running OS. It takes a string so that values injected by tests (`deps.platform` etc.) and
 * names in a table (`'darwin' | 'other'` of `MenuPlatform`) can be passed as they are.
 */
export function isMac(platform: string = hostPlatform()): boolean {
  return platform === 'darwin'
}
