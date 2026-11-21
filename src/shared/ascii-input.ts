/**
 * The mark of "target field" for ASCII input in search fields (TODO 463, ARCHITECTURE 4.5.11). Both the renderer and the viewer (plugin) use
 * the same name, so it lives in shared (a plugin may import values: same as `plugins/_shared/selection.ts`).
 *
 * Just attach `{...ASCII_INPUT}` (React) or `el.setAttribute(ASCII_INPUT_ATTRIBUTE, '')` (DOM) to a field to make it a target.
 * focus / blur are watched in one place for the whole document (the renderer's `ascii-input.ts`; the viewer uses `plugins/_shared/bridge.ts`).
 * **Do not attach it to the prompt field, name inputs, or fields in a web view page** (fields where Japanese is typed).
 */
export const ASCII_INPUT_ATTRIBUTE = 'data-ascii-input'

/** The mark spread onto a React field (`<input {...ASCII_INPUT} />`). */
export const ASCII_INPUT = { [ASCII_INPUT_ATTRIBUTE]: '' } as const

/** The target fields in the renderer. */
export const ASCII_INPUT_SELECTOR = `[${ASCII_INPUT_ATTRIBUTE}]`

/**
 * The target fields in the viewer (inside the iframe). In addition to fields with the mark, the search-term field of CodeMirror's search panel (Cmd+F)
 * (the `<input name="search">` that `@codemirror/search` creates; the replace field is not a target, since it may be replaced with Japanese).
 */
export const VIEWER_ASCII_INPUT_SELECTOR = `${ASCII_INPUT_SELECTOR}, .cm-search input[name="search"]`
