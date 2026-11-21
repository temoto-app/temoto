/**
 * Main side of Help (TODO 1174, ARCHITECTURE.md 7.4.13): resolve a `help://` URI to a bundled file and read it.
 *
 * - **The bundled folder is the single place `<appPath>/resources/help/`.** The same expression works in dev (`npm run dev`), the shell (`Contents/Resources/app` of
 *   `~/Applications/aios.app` -> repo) and the distributed build (`resources/help/**` in electron-builder's `files`).
 * - **It does not go through `FsAccess`.** It is part of the app, not a user file, so exclusion rules, permissions and audit do not apply. Instead the
 *   readable names are limited to the `HELP_PAGES` table, and realpath confirms the file did not leave the folder (a symlink pointing outside is not read).
 * - The body is handed to the Preview of `aios.html` as a temporary view (7.4.6). The viewer is resolved by "naming `aios.html`": even if the user switched `.html` to another
 *   viewer via the per-extension default (TODO 907), Help is shown in Preview.
 *
 * Does not import electron (`test/help.test.ts` verifies with a temporary folder). The wiring with ipcMain is in `help-ipc.ts`.
 */
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { insideRoot, readCapped } from './bundled-file.js'
import { appIdentity } from '../common/app-identity.js'
import { HELP_PAGES, MAX_HELP_BYTES, fillHelpNames, parseHelpUri, type BackendNames, type HelpDocument } from '@shared/help.js'
import type { Locale } from '@shared/locale.js'
import type { ResolvedViewer } from '@shared/plugin.js'
import backendNames from '../../compat/backend-names.json' with { type: 'json' }

/** Table of backend names in documents (`compat/`, constraint 6). The export to `~/<data name>/help/` (`help-sync.ts`) is filled from the same table. */
export const HELP_BACKEND_NAMES: BackendNames = backendNames

/** Plugin id of the viewer that renders Help. */
export const HELP_VIEWER_ID = 'aios.html'

/** The bundled folder. `appPath` is `app.getAppPath()`. */
export function helpRoot(appPath: string): string {
  return join(appPath, 'resources', 'help')
}

/**
 * Real path of the bundled file a `help://` URI points to. null if the URI cannot be read, the page is not in the table, the file is missing, or
 * realpath is outside the folder (symlink).
 */
export function resolveHelpFile(root: string, uri: unknown, fallback: Locale = 'en'): { path: string; lang: Locale } | null {
  const target = parseHelpUri(uri, fallback)
  if (target === null) return null
  const name = HELP_PAGES[target.page]
  if (name === undefined) return null
  try {
    const realRoot = realpathSync(root)
    const real = realpathSync(join(root, name))
    if (!insideRoot(realRoot, real)) return null
    return { path: real, lang: target.lang }
  } catch {
    return null
  }
}

/** From the resolved viewer, pass only the fields a temporary view needs (no file-bound fields, same as `resolveTransientFileViewer`). */
function helpViewer(resolved: ResolvedViewer | null): ResolvedViewer | null {
  if (resolved === null) return null
  return { pluginId: resolved.pluginId, name: resolved.name, url: resolved.url, editable: false, delivery: 'text' }
}

export interface HelpDeps {
  readonly root: string
  /** Display language (the default when the URI has no `lang`). */
  readonly locale: () => Locale
  /** `PluginHost.resolveViewerWith`. */
  readonly resolveViewerWith: (uri: string, pluginId: string) => ResolvedViewer | null
}

/** Answer to the renderer's `help.open(uri)`. null if it cannot be read. **No read permission is attached to anything** (the host hands over the body). */
export function openHelp(deps: HelpDeps, uri: unknown): HelpDocument | null {
  const file = resolveHelpFile(deps.root, uri, deps.locale())
  if (file === null) return null
  let text: string | null
  try {
    text = readCapped(file.path, MAX_HELP_BYTES)
  } catch {
    return null
  }
  if (text === null) return null
  // A provisional URI used to look up by extension (neither read nor permitted, same as `transientFileResolveUri`).
  const viewer = helpViewer(deps.resolveViewerWith('file:///index.html', HELP_VIEWER_ID))
  // Backend names in the document are filled from the table in compat/ (constraint 6). The product name comes from `shared/product.json` (TODO 1254), the data name from the identity fixed at launch (TODO 1263).
  return { text: fillHelpNames(text, HELP_BACKEND_NAMES, appIdentity().dataName), lang: file.lang, viewer }
}
