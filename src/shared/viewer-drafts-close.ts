/**
 * Unsaved viewer drafts at quit or window close (TODO 606, wave 29 bundle B, ARCHITECTURE 5.2.2).
 *
 * Drafts exist only in the renderer's memory (the `viewerDrafts` table of TODO 312, and the draft of the file currently shown), so the
 * round trip where main asks the window's renderer before the window closes or the app quits is defined here.
 *
 *   - `list`: returns the URIs of files that have unsaved drafts (the body is not sent). Material for the "save?" prompt when autosave is OFF.
 *   - `save`: writes out every draft and returns **the ones that could not be written** (the disk side changed = conflict, or cannot be written).
 *     Writing is still `viewer.write` (the Broker's choke point + a check of the base mtime), so a conflict is never silently overwritten.
 *
 * Main -> renderer is `IpcEvent.viewerDraftsRequest` (`ViewerDraftsRequest`); the reply is renderer -> main
 * `IpcChannel.viewerDraftsReply` (`id` and `ViewerDraftsReply`). Main re-checks the reply with `sanitizeViewerDraftsReply`.
 *
 * **`save` first returns "received" (`IpcChannel.viewerDraftsAck`, with the `id` and the list of drafts it is about to write)** (code-review of
 * TODO 606). Main waits for the acknowledgement up to a short limit (to tell apart a window that does not respond), and after it
 * is received waits for completion up to a long limit. If writing does not finish, the drafts listed in the acknowledgement are treated as "could not be saved" (never silently discarded).
 */

export type ViewerDraftsAction = 'list' | 'save'

export interface ViewerDraftsRequest {
  /** Number of the inquiry main issues (matched against the reply). */
  readonly id: number
  readonly action: ViewerDraftsAction
}

/** One draft that remains unsaved. */
export interface ViewerDraftEntry {
  readonly uri: string
  /** Not written because the disk side changed (it differs from the draft's base mtime). */
  readonly conflict: boolean
}

export interface ViewerDraftsReply {
  /** `list`: unsaved drafts. `save`: drafts that could not be written and remain (empty means everything was written). */
  readonly unsaved: readonly ViewerDraftEntry[]
}

/** Upper bound on entries in one reply (the renderer is not a trust boundary, but a broken value must not burden main). */
export const MAX_VIEWER_DRAFT_ENTRIES = 1000

/**
 * Validate the "received" list from the renderer (drafts that `save` is about to write). null if the shape is wrong (not treated as an acknowledgement).
 * It is accepted in the same shape as the reply (`{ unsaved }`).
 */
export function sanitizeViewerDraftsAck(value: unknown): ViewerDraftsReply | null {
  return sanitizeViewerDraftsReply(value)
}

/** Validate a reply from the renderer. null if the shape is wrong (treated the same as no reply). */
export function sanitizeViewerDraftsReply(value: unknown): ViewerDraftsReply | null {
  if (typeof value !== 'object' || value === null) return null
  const unsaved = (value as { unsaved?: unknown }).unsaved
  if (!Array.isArray(unsaved)) return null
  const entries: ViewerDraftEntry[] = []
  for (const item of unsaved.slice(0, MAX_VIEWER_DRAFT_ENTRIES)) {
    if (typeof item !== 'object' || item === null) continue
    const uri = (item as { uri?: unknown }).uri
    if (typeof uri !== 'string' || uri === '') continue
    entries.push({ uri, conflict: (item as { conflict?: unknown }).conflict === true })
  }
  return { unsaved: entries }
}
