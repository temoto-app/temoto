/**
 * Resolution of the viewer for a temporary-view file (TODO 905, a file inside a zip) (ARCHITECTURE.md 7.4.6 / 7.4.11).
 *
 * The renderer (host) hands the bytes it received from a viewer straight to another viewer, so main **only resolves** and
 * permits no file read (the same as `viewer.openPayload`). The extension is taken only from the last element of the name
 * (a name with `../` or an absolute path has no effect on resolution). Which extension goes to whom (including TODO 907's per-extension default) is left to
 * `PluginHost.resolveViewer`, so the viewer is the same as when the same file is opened from Files.
 */
import type { ResolvedViewer } from '@shared/plugin.js'
import { MAX_TRANSIENT_FILE_NAME } from '@shared/plugin.js'
import { transientFileBaseName, transientFileResolveUri } from '@shared/transient-file.js'

export function resolveTransientFileViewer(
  resolveViewer: (uri: string) => ResolvedViewer | null,
  name: unknown
): ResolvedViewer | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TRANSIENT_FILE_NAME) return null
  if (transientFileBaseName(name) === '') return null
  const viewer = resolveViewer(transientFileResolveUri(name))
  if (viewer === null) return null
  // Only the result of the resolution is handed over (no fields tied to a file, such as a symlink's real-path URI).
  return {
    pluginId: viewer.pluginId,
    name: viewer.name,
    url: viewer.url,
    editable: false,
    delivery: viewer.delivery ?? 'text'
  }
}
