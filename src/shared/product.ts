/**
 * TODO 1254: the public product name (what the user sees) and the public repository.
 * TODO 1263: the user-visible identifiers that follow the name (bundle id, URL schemes, the data name, the install script).
 *
 * The values live in `product.json` next to this file so that the build scripts (`scripts/*.mjs`, plain Node) read the
 * same copy. Everything the user sees (window title, menus, About, Settings › About, Help, release names, the zip and
 * the .app) takes the name from here.
 *
 * **The data name is decided per machine, not here.** `DATA_NAME` (`Temoto`) is what a new machine uses; a machine that
 * already has the legacy userData keeps `LEGACY_DATA_NAME` (`aios`). The choice is made once per launch by
 * `src/common/app-identity.ts`, and the Electron app name, userData, Logs, the keychain item `<name> Safe Storage`,
 * `~/<name>/` and `~/.local/share/<name>` all come from that one choice.
 *
 * Internal identifiers that never follow the name: the MCP server name, `window.aios`, `AIOS_*` variables and plugin ids.
 */
import product from './product.json' with { type: 'json' }

/** The product name shown to the user (`Temoto`). */
export const PRODUCT_NAME: string = product.name

/** The public repository (`owner/name`) that holds the source and the Releases. */
export const PUBLIC_RELEASE_REPO: string = product.releaseRepo

/** The `.app` the release build produces (`Temoto.app`). */
export const PRODUCT_APP_BUNDLE = `${PRODUCT_NAME}.app`

/** TODO 1263: the bundle id (and signing identifier) of the distributed build. The development shell keeps `local.aios`. */
export const RELEASE_BUNDLE_ID: string = product.bundleId

/** TODO 1263: the data name a new machine uses (`Temoto`). */
export const DATA_NAME: string = product.dataName

/** TODO 1263: the data name of a machine that already ran the app under the code name (`aios`). */
export const LEGACY_DATA_NAME: string = product.legacyDataName

/** TODO 1263: the URL schemes registered with the OS. The first is the original (`aios`), the rest are aliases (`temoto`). */
export const APP_URL_SCHEMES: readonly string[] = product.urlSchemes

/** TODO 1263: the file name of the installer attached to each Release (`install-temoto.sh`). */
export const INSTALL_SCRIPT_NAME: string = product.installScript
