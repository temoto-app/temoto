/**
 * The decision of whether to switch the view for jumping to a line (item 273). `main.ts` is an entry script that imports
 * `@pluginshared` and cannot be loaded from vitest, so only the decision is split out here (same shape as `outline-guard.ts`,
 * the lesson of items 104 / 142).
 *
 * The drawn HTML (Preview) cannot be mapped back to original lines, so **in Preview, switch to Source first and then jump**
 * (owner decision 2026-10-01, same as VS Code). Even in Source, redraw if there is no editor yet.
 */
export type MarkdownMode = 'preview' | 'source'

export function revealNeedsRender(mode: MarkdownMode, hasEditor: boolean): boolean {
  return mode !== 'source' || !hasEditor
}
