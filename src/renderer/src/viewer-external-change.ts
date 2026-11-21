/**
 * The pure part of "an outside tool rewrote the file being shown" (TODO 673). It touches neither the DOM nor the store, so
 * `test/viewer-external-change.test.ts` tests it directly. The wiring is in `viewerMemory.ts` (hook).
 *
 * `fileChanged` from main (`ViewerFileWatcher`) is sent only for the single "file currently being viewed" remembered per window.
 * The renderer side checks again that **it matches the URI being shown** (if the user moved to another file meanwhile, it is irrelevant).
 * Same behavior as VS Code: with no draft (unsaved edit) it silently re-reads; with one, it shows the same conflict band as `draftConflict`
 * (`DraftConflictBanner`, `toolName: null` = the same wording as "changed while you were away" - the writer is unknown, so it is aligned).
 */
import type { ViewerCommand } from '@shared/thread.js'

export type ExternalChangePlan =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'conflict'; readonly uri: string }
  | { readonly kind: 'reload'; readonly uri: string }

export function planExternalChange(
  command: Extract<ViewerCommand, { kind: 'fileChanged' }>,
  state: {
    readonly selectedUri: string | null
    readonly dirty: boolean
  }
): ExternalChangePlan {
  if (state.selectedUri !== command.uri) return { kind: 'ignore' }
  return state.dirty ? { kind: 'conflict', uri: command.uri } : { kind: 'reload', uri: command.uri }
}
