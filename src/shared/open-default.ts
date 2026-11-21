/**
 * The table of what may be asked to "open with the OS's default app" (TODO 850, owner decision 2026-10-17).
 *
 * A viewer plugin can raise `open-default-app` only (1) from a **bundled plugin** (2) for files with an
 * **extension in this table**. Types that can be executed, such as `.command` / `.app` / `.jar` / `.fileloc`, are refused even if a plugin
 * claims that extension (because "open" on the OS would mean executing). Both the renderer (ViewerPane) and main
 * (`editor/open-default.ts`) validate against the same table. When widening the table, keep it in line with the manifest of `aios.video`.
 */

/**
 * Extensions (lower case, without the dot) per plugin that may ask (bundled ones; main also asks PluginHost again whether it is bundled).
 * `aios.video` is for video (TODO 405) and audio (TODO 1271, an audio file that cannot be played falls back to the same button); `aios.html` is for Preview's
 * "open in browser" when it finds an external script / stylesheet (TODO 1074. The default for `.html` / `.htm` is the user's browser, and they are not executable types).
 * Split per plugin, so one cannot ask with another plugin's extensions.
 */
export const OPEN_DEFAULT_EXTENSIONS_BY_PLUGIN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['aios.video', new Set(['mp4', 'm4v', 'mov', 'webm', 'avi', 'wav', 'mp3', 'm4a', 'ogg', 'flac'])],
  ['aios.html', new Set(['html', 'htm'])]
])

/** The last extension (lower case) of a file name (without separators). '' if there is none or only the leading dot of a hidden file. */
function extensionOfName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The extension (lower case) of a URI / path. '' if none. Queries and fragments are not looked at. */
export function extensionOfUri(uri: string): string {
  const clean = uri.split(/[?#]/, 1)[0] ?? ''
  return extensionOfName(clean.slice(clean.lastIndexOf('/') + 1))
}

/**
 * The extension (lower case) of a file system path (not a URI). '' if none.
 *
 * TODO 1214: `extensionOfUri` throws away everything after `?` / `#`, so using it on a **real path** would misread the
 * extension of `/x/v.pdf#.command` as `pdf` (a `#` in a path is part of the file name, not a fragment). A real path after the choke point and symlink resolution
 * is validated with this one.
 */
export function extensionOfPath(path: string): string {
  return extensionOfName(path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1))
}

/** Whether the plugin id and URI are in the table. */
export function isOpenDefaultAllowed(pluginId: unknown, uri: unknown): boolean {
  return (
    typeof pluginId === 'string' &&
    typeof uri === 'string' &&
    (OPEN_DEFAULT_EXTENSIONS_BY_PLUGIN.get(pluginId)?.has(extensionOfUri(uri)) ?? false)
  )
}

/** Whether the plugin id and **real path** (after the choke point and symlink resolution) are in the table (TODO 1214, `extensionOfPath`). */
export function isOpenDefaultAllowedPath(pluginId: unknown, path: unknown): boolean {
  return (
    typeof pluginId === 'string' &&
    typeof path === 'string' &&
    (OPEN_DEFAULT_EXTENSIONS_BY_PLUGIN.get(pluginId)?.has(extensionOfPath(path)) ?? false)
  )
}

/**
 * Extensions that the host (aios's own UI: viewer headings, search hits, the context menu, the band for links that could not be opened) may route to the
 * **OS's default app** instead of "open in editor" (TODO 1214, owner decision 2026-11-12). Lower case, without the dot.
 *
 * - **An allowlist.** Extensions not in the table, and files without an extension, go to the editor chosen in settings as before. Passing executables, `.app`, `.command`, `.sh`, `.scpt`, `.workflow`, `.terminal`, `.jar`, `.pkg`, `.dmg`, `.webloc`,
 *   `.inetloc`, `.url`, `.fileloc` and so on to `shell.openPath` would turn "open" into "execute", so only documents, images, video and audio that cannot become that are listed.
 * - Not listed: text types (kinds the text viewer opens; `.svg` / `.html` / `.csv` / `.rtf` are also canonical text, so the editor),
 *   Office with macros (`.xlsm` / `.docm` / `.pptm` ...) and old formats that can hold macros (`.doc` / `.xls` / `.ppt`), archives (`.zip` etc.; the default app extracts and writes them out),
 *   `.ppsx`, which starts a slideshow, and **extensions that are commonly used for text files too** (`.key` = Keynote and PEM private keys, `.ts` = MPEG-TS and
 *   TypeScript. The default app would open them as another kind, and `openPath` returns success, so the fallback to the editor does not work either).
 * - **Separate from the plugin table (`OPEN_DEFAULT_EXTENSIONS_BY_PLUGIN`).** This table does not widen what a plugin may ask for.
 */
export const HOST_OPEN_DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set([
  // Documents (Office / iWork / OpenDocument / PDF / e-books)
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'pages',
  'numbers',
  // `key` (Keynote) is not listed (code-review): it collides with textual `.key` files such as PEM private keys, and `server.key` would open in Keynote
  // (`openPath` returns success, so the fallback to the editor does not work either). Keynote documents go to the editor.
  'epub',
  // Images (`.svg` is text, so it is not listed)
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'avif',
  // Video
  'mp4',
  'm4v',
  'mov',
  'webm',
  'avi',
  'mkv',
  // Audio
  'mp3',
  'm4a',
  'wav',
  'aac',
  'flac',
  'aif',
  'aiff'
])

/** Whether the URI (only `file:`) has an extension that the host routes to the default app (TODO 1214). */
export function opensInDefaultApp(uri: unknown): boolean {
  return typeof uri === 'string' && uri.startsWith('file://') && HOST_OPEN_DEFAULT_EXTENSIONS.has(extensionOfUri(uri))
}

/** Whether the **real path** (after the choke point and symlink resolution) has an extension that the host routes to the default app (TODO 1214). */
export function opensInDefaultAppPath(path: unknown): boolean {
  return typeof path === 'string' && HOST_OPEN_DEFAULT_EXTENSIONS.has(extensionOfPath(path))
}

/** Where one "Open" button goes (TODO 1214). */
export type OpenRoute = 'default-app' | 'editor'

/**
 * Routing for one "Open" button (viewer headings, search hits, the band for links that could not be opened) (TODO 1214).
 * Folders and anything with a line number (the first line of a selection, `path:line` in an answer) go to the chosen editor. Files with an extension in the table go to the default app.
 * The renderer uses this to choose the wording and the entry point, but **main does not trust the renderer's claim and validates again against the same table**.
 */
export function openRouteOf(
  uri: string,
  options: { readonly line?: number | null; readonly asDirectory?: boolean } = {}
): OpenRoute {
  if (options.asDirectory === true) return 'editor'
  if (options.line !== undefined && options.line !== null) return 'editor'
  return opensInDefaultApp(uri) ? 'default-app' : 'editor'
}
