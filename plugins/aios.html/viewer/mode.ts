/**
 * The Source / Preview decision for `aios.html` (TODO 401). It holds the same rule as `aios.markdown`'s `reveal-mode.ts`
 * inside this plugin (one bundle per plugin, so files of other plugins are not imported).
 * `main.ts` cannot be loaded from vitest, so only the decision is split out here.
 */
export type HtmlMode = 'preview' | 'source'

/** The view when opened (Preview, as in Markdown). */
export const INITIAL_MODE: HtmlMode = 'preview'

/** The views shown in the host heading's switch (TODO 969, 7.4.12). The order is the same as the earlier second-row buttons. */
export const VIEW_MODES: readonly HtmlMode[] = ['preview', 'source']

/**
 * Whether jumping to a line (item 273) needs a redraw. The rendered HTML cannot be mapped back to original lines, so in Preview
 * switch to Source first and then jump. Even in Source, redraw if there is no editor yet.
 */
export function revealNeedsRender(mode: HtmlMode, hasEditor: boolean): boolean {
  return mode !== 'source' || !hasEditor
}

/** Whether to insert the path of a dropped file (TODO 366 / 407). Only when Source is editable. */
export function acceptsInsert(mode: HtmlMode, editable: boolean): boolean {
  return mode === 'source' && editable
}
