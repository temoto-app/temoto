/**
 * Name handling for transient-view files that have no URI (TODO 905, files inside a zip, ARCHITECTURE.md 7.4.6 / 7.4.11).
 * The renderer (host) and main (viewer resolution) both take the last path element by the same rule, so it lives here.
 */
import { contentTypeForExtension } from './content-type.js'

/** Last path element (splits on both `/` and `\`, ignores a trailing separator). `../../x.txt` -> `x.txt`. */
export function transientFileBaseName(name: string): string {
  const parts = name.split(/[/\\]/).filter((part) => part !== '' && part !== '.' && part !== '..')
  return parts[parts.length - 1] ?? ''
}

/**
 * Placeholder URI used only to look up a viewer by extension (passed to main's `PluginHost.resolveViewer`; **it is neither read nor granted access**).
 * Only the last element is placed directly under `file:///`, so paths inside an archive (`../` or absolute paths) have no effect on resolution.
 */
export function transientFileResolveUri(name: string): string {
  return `file:///${encodeURIComponent(transientFileBaseName(name))}`
}

/**
 * Extensions (lowercase, no dot) of images that Chromium cannot read and that need main's conversion (TODO 1154 / 1162). **The only table**:
 * main's `needsDisplayConversion` / `convertForDisplay` and the renderer's `isHeifName` all look it up here.
 */
export const HEIF_EXTENSIONS: ReadonlySet<string> = new Set(['heic', 'heif'])

/** Whether the name (a path is fine; only the last element is checked) is HEIC / HEIF, case-insensitively. */
export function isHeifName(name: string): boolean {
  const base = transientFileBaseName(name)
  const dot = base.lastIndexOf('.')
  return dot > 0 && HEIF_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}

/** MIME type for the `blob:` of a transient view (TODO 905). An SVG in an `<img>` cannot render without a type. The table is shared with the `aios-res://` serving. */
export function transientFileMime(name: string): string | null {
  const base = transientFileBaseName(name)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return contentTypeForExtension(base.slice(dot + 1))
}
