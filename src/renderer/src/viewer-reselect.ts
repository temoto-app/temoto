/**
 * Whether to re-select the viewer of the file being shown when an extension is enabled / disabled (TODO 471, wave 25 bundle B).
 *
 * ViewerPane resolves the viewer only when the URI changes (`viewer.open`). So once 460 made it possible to disable even built-in
 * extensions, a file open in the disabled extension's viewer stayed as it was, and reloading the frame and saving through the
 * Broker were refused (`directoryOf` / `policyOf` were null).
 *
 * The fix: when `plugins.onChanged` (delivered to all windows) arrives, try resolving the URI being shown again
 * (a trial `viewer.open` -> immediately `viewer.close`; the Broker counts grants, so the net is zero), and re-open if the resolved
 * extension differs from the current one. Disabled -> falls back to the catch-all (`aios.text`) etc.; re-enabled -> returns to the extension that offers to handle it
 * (same selection as when the URI is opened again). If it is still the same extension, nothing is done (`onChanged` also arrives on a consent change or a crash,
 * and re-reading here would lose the viewer's cursor).
 *
 * The unsaved draft stays in the per-file table (`viewerDrafts`, TODO 312), so it reaches the re-opened viewer
 * through the same path as the restore on return (`restoreDraft`) (owner decision 2026-10-06: hand it over to the catch-all,
 * no dialog).
 *
 * Pure functions independent of electron and React, so `test/viewer-reselect.test.ts` tests them directly.
 */
import type { LoadedResource, RouteViewer } from './viewer-route.js'

/** A file whose display has settled (finished reading) and its viewer. null when there is no viewer (`no-viewer`). */
export interface ShownViewer {
  readonly uri: string
  readonly pluginId: string | null
}

/**
 * The file whose display has settled right now. Only when the URI being shown has been read and the contents' origin matches the current viewer.
 * null in the middle of a switch / re-open (while waiting for resolution or reading) - an `onChanged` that arrives
 * during that time does not trigger a trial (the resolution in progress is decided by the latest enabled / disabled state).
 */
export function shownViewer(
  uri: string | null,
  viewer: RouteViewer | null,
  loaded: LoadedResource | null
): ShownViewer | null {
  if (uri === null || loaded === null || loaded.uri !== uri) return null
  if (viewer === null) return loaded.pluginId === '' ? { uri, pluginId: null } : null
  if (loaded.pluginId !== viewer.pluginId) return null
  return { uri, pluginId: viewer.pluginId }
}

/**
 * Decides from the trial resolution's result whether to re-open.
 *
 * - `asked`: what was shown when the trial started. `current`: what is shown when the result came back.
 *   If they differ (the user moved to another file or re-opened while waiting), do nothing - the URI switch side has already resolved it.
 * - `selectedUri`: the URI being shown in the store. Also do nothing while the display has not caught up.
 * - `probed`: the extension the trial resolved to (null = no viewer offers to handle it / grants cannot be changed).
 */
export function reselectDecision(
  asked: ShownViewer,
  current: ShownViewer | null,
  selectedUri: string | null,
  probed: { readonly pluginId: string } | null
): 'keep' | 'reopen' {
  if (current === null || current.uri !== asked.uri || current.pluginId !== asked.pluginId) return 'keep'
  if (selectedUri !== current.uri) return 'keep'
  const next = probed?.pluginId ?? null
  return next === current.pluginId ? 'keep' : 'reopen'
}
