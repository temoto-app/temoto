/**
 * The pure part of the draft-conflict notice (item 97 second half, ARCHITECTURE.md 4.5.1 / 7.4.5).
 * It touches neither the DOM nor the store, so `test/draft-conflict.test.ts` tests it as it is.
 *
 * For the `draftConflict` command from main, the main side (`DraftConflictTracker`) has already checked, at notification time, that the window
 * is showing that thread and that the window holds a draft for that URI. Still, **crossed messages** are possible
 * (the thread was switched, or the draft saved / discarded, while it was in transit), so the renderer checks once more before accepting it.
 */
import type { ViewerCommand } from '@shared/thread.js'

/**
 * The minimum information ViewerPane shows in the band. The tool name is main's raw value (combined with a fixed English sentence).
 * `toolName: null` means the contents on disk changed while another file was being viewed with the draft still remembered
 * (ViewerPane noticed by mtime on returning, TODO 312 / wave 18 bundle B). Who wrote it is unknown.
 */
export interface DraftConflictNotice {
  readonly uri: string
  readonly toolName: string | null
  /**
   * Auto-save (TODO 555) was refused by the mtime check (the disk side had changed). Only the band's wording differs. Who wrote it is unknown
   * (`toolName: null`).
   */
  readonly autoSave?: true
}

export function acceptDraftConflict(
  command: Extract<ViewerCommand, { kind: 'draftConflict' }>,
  state: {
    readonly activeThreadId: string | null
    readonly selectedUri: string | null
    readonly dirty: boolean
  }
): DraftConflictNotice | null {
  if (state.activeThreadId !== command.threadId) return null
  if (!state.dirty || state.selectedUri !== command.uri) return null
  return { uri: command.uri, toolName: command.toolName }
}
