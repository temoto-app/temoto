/**
 * Decides, on receiving a `resource`, whether the viewer replaces or keeps the body (items 309-2 / 303, wave 16 bundle I).
 *
 * The host (ViewerPane) **re-sends `resource` many times for the same file**: when the theme, display language, search term or
 * editable changes (the iframe is not remounted unless `src` changes, so this is the only way to convey it),
 * and in a new iframe twice, right after load and at the bridge's `ready`. The body it sends is **the contents as read**,
 * not the viewer's draft. Previously
 *
 *  - `aios.markdown` rebuilt the editor with `render()` on every `resource`, and on the second message after jumping to a line (item 273)
 *    lost the cursor, the line marker and the draft (309-2: in a new iframe, `README.md:42` stayed at line 1)
 *  - `aios.text` did `setValue(resource.text)`, which reverted to the original body if there was a draft (303)
 *
 * So the viewer remembers "the `resource` it received before", and for **a re-send of the same version of the same file** it does not touch the body and
 * only re-applies the look (read-only, theme, search term). The version is `revision`, which the host advances on every read / save / re-read
 * (if absent, it is replaced by comparing bodies). Even if the version advanced, if the body equals the editor's current contents (including a draft)
 * (right after saving), it is likewise kept.
 *
 * `main.ts` is an entry script that imports `@pluginshared` and cannot be loaded from vitest, so only the decision is split out
 * here (the same shape as `reveal-mode.ts` / `outline-guard.ts`). The editor type is only `import type`.
 */
import type { Theme } from '@shared/theme.js'
import type { Editor } from './editor.js'

/** The previously received `resource`, remembered only as far as the decision needs. */
export interface ReceivedResource {
  readonly uri: string
  /** A number the host advances whenever it re-reads / saves the contents. null for an old host that lacks it. */
  readonly revision: number | null
  /** The body (the contents as read). null if it is not a body (binary or an error). */
  readonly text: string | null
  readonly highlightQuery: string | null
}

/** Extracts the part to remember from the bridge's `ViewerResourceEvent`. */
export function receivedOf(event: {
  readonly uri: string
  readonly revision: number | null
  readonly highlightQuery: string | null
  readonly resource: { readonly kind: string; readonly text?: string }
}): ReceivedResource {
  return {
    uri: event.uri,
    revision: event.revision,
    text: event.resource.kind === 'text' && typeof event.resource.text === 'string' ? event.resource.text : null,
    highlightQuery: event.highlightQuery
  }
}

/**
 * `keep` = do not replace the body (keep the editor, draft, cursor, line marker and scroll).
 * `replace` = a different file or re-read contents, so replace (redraw).
 */
export type ResourcePlan = 'keep' | 'replace'

/**
 * @param current The editor's current contents (including a draft). null if there is no editor.
 */
export function planResource(
  prev: ReceivedResource | null,
  next: ReceivedResource,
  current: string | null
): ResourcePlan {
  if (next.text === null || prev === null || prev.text === null) return 'replace'
  if (prev.uri !== next.uri) return 'replace'
  const sameRevision =
    prev.revision !== null && next.revision !== null ? prev.revision === next.revision : prev.text === next.text
  if (sameRevision) return 'keep'
  // The version advanced but the contents equal what is drawn now (a re-read right after saving) -> do not redraw.
  if (current !== null && current === next.text) return 'keep'
  return 'replace'
}

/**
 * The look re-applied to the editor in the `keep` case. It touches neither the body, the selection nor the line marker.
 * The search term is re-applied **only when it changed** - `setHighlight` scrolls to the first match,
 * so calling it on every re-send would pull the view back from the position jumped to for a line (item 273).
 */
export function refreshEditor(
  editor: Pick<Editor, 'setReadOnly' | 'setTheme' | 'setHighlight'>,
  prev: ReceivedResource,
  next: ReceivedResource,
  view: { readonly readOnly: boolean; readonly theme: Theme }
): void {
  editor.setReadOnly(view.readOnly)
  editor.setTheme(view.theme)
  if (prev.highlightQuery !== next.highlightQuery) editor.setHighlight(next.highlightQuery)
}
