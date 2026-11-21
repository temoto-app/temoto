/**
 * Main's entry point for showing a file in Finder / Explorer (TODO 289).
 *
 * A URI from the renderer must go through `assertAllowed` (`FsAccess`, 12.7). If it does not pass
 * (a location under an exclusion, non-`file:`, a relative path), nothing is called and it returns `false`. **Does not throw.**
 * `shell.showItemInFolder` is electron's, so it is injected as `show` (tests use a fake).
 */
import { log } from '../../common/logger.js'
import type { PathAccess } from '../../common/fs-policy.js'

/**
 * The gate "try the `first` gate, and if refused, the gate `'handoff'` that only hands out" (TODO 808). Used only by show in Finder (`first = 'read'`) and by
 * "open in external editor" in the band of a link that could not be opened (`editor.openHandoff`, `first = 'write'`). **Not used for the ordinary
 * `editor.open`** - a location under an exclusion could be handed to the external editor from any entry point (a fix from wave 44's code-review).
 * **Also not used for the entry point that opens with the OS's default app (`shell.openPath`)** - it would make an app that interprets the contents open a location under an exclusion,
 * widening the "only hands out" purpose (TODO 1214's code-review. The default app is only for what passed the `'write'` gate).
 */
export function withHandoffFallback(
  assertAllowed: (uri: string, asDirectory: boolean, access: PathAccess) => string,
  first: PathAccess
): (uri: string, asDirectory: boolean) => string {
  return (uri, asDirectory) => {
    try {
      return assertAllowed(uri, asDirectory, first)
    } catch {
      return assertAllowed(uri, asDirectory, 'handoff')
    }
  }
}

export interface RevealDeps {
  readonly assertAllowed: (uri: string, asDirectory: boolean) => string
  readonly show: (path: string) => void
}

export function revealInFolder(deps: RevealDeps, uri: unknown, asDirectory: boolean): boolean {
  if (typeof uri !== 'string' || uri === '') return false
  let path: string
  try {
    path = deps.assertAllowed(uri, asDirectory)
  } catch {
    log.debug('reveal.denied')
    return false
  }
  try {
    deps.show(path)
    return true
  } catch {
    log.warn('reveal.failed')
    return false
  }
}

/**
 * Selects and shows the log file currently being written in Finder (TODO 376, "About" in settings).
 * The path was decided by main (nothing comes from the renderer), so `assertAllowed` is not applied -
 * `~/Library` is an excluded location, so applying it would always refuse. If there is no file (could not open), `false`.
 */
export function revealLogFile(deps: { readonly path: string | null; readonly show: (path: string) => void }): boolean {
  if (deps.path === null) return false
  try {
    deps.show(deps.path)
    return true
  } catch {
    log.warn('reveal.logs.failed')
    return false
  }
}
