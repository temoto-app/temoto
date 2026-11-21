/**
 * Detection of a macOS app bundle (`.app`) (TODO 562). The Files tree does not open this row as a folder
 * (no ▸ is shown), shows it with the OS app icon, and makes a double click "Reveal in Finder" (it does not launch).
 *
 * It decides by name only (used by both the renderer and main). Other bundles such as `.bundle` / `.framework` are
 * not covered: there are reasons to walk inside them, and their icons are not much different from a folder.
 */
const APP_BUNDLE_PATTERN = /^.+\.app$/i

/** Whether it is a directory ending in `.app`. A file is `false` (a file with the same name is not a bundle). */
export function isAppBundle(entry: { readonly name: string; readonly isDirectory: boolean }): boolean {
  return entry.isDirectory && APP_BUNDLE_PATTERN.test(entry.name)
}

/** The name-only check (applied by main to a name taken from a URI). */
export function isAppBundleName(name: string): boolean {
  return APP_BUNDLE_PATTERN.test(name)
}
