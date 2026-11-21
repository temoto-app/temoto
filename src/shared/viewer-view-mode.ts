/**
 * The viewer's "view switch" (TODO 969, ARCHITECTURE 7.4.12).
 *
 * The Source / Preview switch of `aios.markdown` / `aios.html` used to be drawn by the plugin as two buttons inside the iframe
 * (the second row under the heading). In 969 it is **drawn in the host's (ViewerPane) heading, with the same component as the Composer's Model picker
 * (`SegmentedControl`)**. A plugin cannot use the host's DOM / React components (constraint 8), so two messages were added to the bridge:
 * "report the current view and the selectable views" (`view-modes`, viewer -> host) and "switch to this view" (`set-view-mode`, host -> viewer).
 *
 * **The selectable views are only a fixed vocabulary the host owns** (`VIEWER_VIEW_MODES`). A string a plugin claims is never shown in the host's heading
 * as is (a plugin's wording must not impersonate the host's UI); wording is looked up in the host's dictionary (`viewer.mode.*`).
 * The host drops values outside the vocabulary, duplicates, and arrays that are too long.
 *
 * **The vocabulary is divided into groups** (TODO 1200, wave 81 bundle C): the "display" (`display`) of Source / Preview, and the "filter" (`filter`) for
 * the scaling interpolation of images and video, Nearest / Bilinear. One `view-modes` carries only one group; the host drops values whose group differs
 * from the first value (the heading has a single switch, and a mix across groups has no meaning). The group decides the screen-reader name of the heading.
 *
 * TODO 1215 (wave 83): Table / Text for `.csv` / `.tsv` of `aios.text` were also added to the "display" (`display`) group. They are values separate from Source / Preview
 * because of wording (a table is "Table" rather than "Preview", and raw CSV is "Text" rather than "Source").
 */

/** The Source / Preview display (TODO 969). */
export type ViewerDisplayMode = 'preview' | 'source'
/** The Table / Text display of a delimited table (`.csv` / `.tsv`) (TODO 1215). The group is `display`. */
export type ViewerSheetMode = 'table' | 'text'
/** Scaling interpolation of images and video (TODO 1200). Nearest = `image-rendering: pixelated`, Bilinear = `auto`. */
export type ViewerFilterMode = 'nearest' | 'bilinear'
/** Selectable views (the host's vocabulary). */
export type ViewerViewMode = ViewerDisplayMode | ViewerSheetMode | ViewerFilterMode
/** A group of the vocabulary. */
export type ViewerViewModeGroup = 'display' | 'filter'

export const VIEWER_DISPLAY_MODES: readonly ViewerDisplayMode[] = ['preview', 'source']
export const VIEWER_SHEET_MODES: readonly ViewerSheetMode[] = ['table', 'text']
export const VIEWER_FILTER_MODES: readonly ViewerFilterMode[] = ['nearest', 'bilinear']

/** All the views the host knows (the order is the default order shown in the heading). */
export const VIEWER_VIEW_MODES: readonly ViewerViewMode[] = [
  ...VIEWER_DISPLAY_MODES,
  ...VIEWER_SHEET_MODES,
  ...VIEWER_FILTER_MODES
]

/** Upper bound on the number of views one `view-modes` may carry. */
export const MAX_VIEW_MODES = 4

export function isViewerViewMode(value: unknown): value is ViewerViewMode {
  return typeof value === 'string' && (VIEWER_VIEW_MODES as readonly string[]).includes(value)
}

export function isViewerDisplayMode(value: unknown): value is ViewerDisplayMode {
  return typeof value === 'string' && (VIEWER_DISPLAY_MODES as readonly string[]).includes(value)
}

export function isViewerSheetMode(value: unknown): value is ViewerSheetMode {
  return typeof value === 'string' && (VIEWER_SHEET_MODES as readonly string[]).includes(value)
}

export function isViewerFilterMode(value: unknown): value is ViewerFilterMode {
  return typeof value === 'string' && (VIEWER_FILTER_MODES as readonly string[]).includes(value)
}

export function viewModeGroup(mode: ViewerViewMode): ViewerViewModeGroup {
  return isViewerFilterMode(mode) ? 'filter' : 'display'
}

/** The "view switch" report the host received. If `modes` has fewer than 2, no switch is shown in the heading. */
export interface ViewModesReport {
  readonly uri: string
  readonly modes: readonly ViewerViewMode[]
  readonly current: ViewerViewMode | null
}

/**
 * Validate the viewer's `view-modes` (host side). null (discarded) if it is not addressed to the file the viewer is drawing (`drawnUri`);
 * a mix-up during switching. Values outside the vocabulary, duplicates, and values of a different group from the first are dropped, and if there are more than the limit the first ones up to the limit are kept.
 * If `current` is not in the remaining list, null (shown as the mark that none is selected).
 */
export function acceptViewModes(
  message: { readonly uri?: unknown; readonly modes?: unknown; readonly current?: unknown },
  drawnUri: string | null
): ViewModesReport | null {
  if (typeof message.uri !== 'string' || message.uri !== drawnUri) return null
  if (!Array.isArray(message.modes)) return null
  const modes: ViewerViewMode[] = []
  for (const value of message.modes as readonly unknown[]) {
    if (modes.length >= MAX_VIEW_MODES) break
    if (!isViewerViewMode(value) || modes.includes(value)) continue
    if (modes.length > 0 && viewModeGroup(value) !== viewModeGroup(modes[0]!)) continue
    modes.push(value)
  }
  const current = isViewerViewMode(message.current) && modes.includes(message.current) ? message.current : null
  return { uri: message.uri, modes, current }
}

/**
 * Validate the host's `set-view-mode` (viewer side, bridge). null if it is not addressed to the file being shown (`currentUri`) or is outside the vocabulary.
 */
export function acceptSetViewMode(
  message: { readonly uri?: unknown; readonly mode?: unknown },
  currentUri: string | null
): ViewerViewMode | null {
  if (typeof message.uri !== 'string' || message.uri !== currentUri) return null
  return isViewerViewMode(message.mode) ? message.mode : null
}

/** Whether to show the switch in the heading (only when 2 or more views can be selected). */
export function showsViewModes(report: ViewModesReport | null, drawnUri: string | null): report is ViewModesReport {
  return report !== null && report.uri === drawnUri && report.modes.length >= 2
}
