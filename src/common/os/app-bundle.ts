/**
 * OS layer (TODO 986 stage 2): the shape of a macOS .app bundle. Used by the auto-update of distributed builds (`src/main/update/layout.ts`).
 *
 * `X.app/Contents/MacOS/<exe>`, `Contents/Info.plist` and "updates support only macOS on Apple Silicon" are
 * the shape of the .app container itself. The Windows version (TODO 899) adds a different container (installer / MSIX).
 * Pure functions (no electron import). The contents are the same as before they were moved here.
 */
import { basename, dirname, join } from 'node:path'
import { isMac } from './platform.js'
import { PRODUCT_APP_BUNDLE, PRODUCT_NAME } from '../../shared/product.js'

/**
 * The name of the .app inside a version's directory (`Temoto.app`, TODO 1254). electron-builder names the .app and its
 * executable after `productName` (`scripts/release-config.mjs`), which comes from the same `src/shared/product.json`.
 */
export const APP_BUNDLE_NAME = PRODUCT_APP_BUNDLE
/** The name of the executable inside the .app (`Temoto`; the development shell keeps `aios`, but it never auto-updates). */
export const APP_EXECUTABLE_NAME = PRODUCT_NAME

/** From `…/X.app/Contents/MacOS/<exe>` to `…/X.app`. null if the shape is wrong. */
export function bundleOfExecutable(execPath: string): string | null {
  const macos = dirname(execPath)
  const contents = dirname(macos)
  const bundle = dirname(contents)
  if (basename(macos) !== 'MacOS' || basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return null
  return bundle
}

/** The path of the .app's `Info.plist`. */
export function bundleInfoPlistPath(bundle: string): string {
  return join(bundle, 'Contents', 'Info.plist')
}

/** The path of the .app's executable. */
export function bundleExecutablePath(bundle: string): string {
  return join(bundle, 'Contents', 'MacOS', APP_EXECUTABLE_NAME)
}

/** Whether the OS / CPU supports auto-update (only macOS on Apple Silicon). */
export function updateHostSupported(platform: string, arch: string): boolean {
  return isMac(platform) && arch === 'arm64'
}
