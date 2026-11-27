/**
 * Copying a conversation's workspace state to a new conversation (TODO 1334, ARCHITECTURE 5.3 "copying the workspace on a
 * handoff"). Used by "continue in a lighter new conversation" (`cacheBar.handoff`, TODO 961) right after main created the new
 * conversation and before it is opened, so the new conversation opens on the same viewer, ← → history and Files selection.
 *
 * Owner decision (2026-11-26): **everything remembered per conversation is copied; what is remembered per window is left
 * alone** (it stays as it is anyway). **A copy, not a move**: the source conversation keeps its own state and shows the same
 * thing when the user goes back to it. The two change independently afterwards (values, not shared references).
 *
 * This is the one place that lists what is copied (`CARRIERS`). A new kind of per-conversation state adds a line here.
 * What is deliberately not copied, and why, is in `docs/notes/wave105.md` (bundle B):
 * - unsaved viewer drafts are keyed by file, not by conversation (one draft per file in the window), so nothing to copy;
 * - Web tabs, folded viewer, pane ratio, folder open / closed state, the closed-pages memo are per window;
 * - the temporary view (diff, Help) is closed on every conversation switch and not remembered.
 *
 * Every URI copied here only reaches main through the existing checked calls (`setViewerState`, `setViewerHistory`, the
 * viewer read, `fs.stat`), so copying does not open a way around the checks. Only references (URIs, positions, order) are
 * copied; no body text (constraints 9 / 10).
 */
import { copyFilerHistoryTo } from './filerHistory.js'
import { useThreads } from './threadStore.js'
import { copyViewerHistoryTo } from './viewerHistory.js'
import { copyViewerMemoryTo } from './viewerMemory.js'

interface WorkspaceCarrier {
  readonly name: string
  copy(fromId: string, toId: string): void | Promise<void>
}

/** The key of the viewer selection the user dismissed / sent (item 97), so the new conversation does not attach it again. */
function copyDismissedSelection(fromId: string, toId: string): void {
  useThreads.setState((state) => {
    const key = state.dismissedSelections[fromId]
    if (key === undefined || state.dismissedSelections[toId] !== undefined) return {}
    return { dismissedSelections: { ...state.dismissedSelections, [toId]: key } }
  })
}

const CARRIERS: readonly WorkspaceCarrier[] = [
  { name: 'viewerMemory', copy: copyViewerMemoryTo },
  { name: 'viewerHistory', copy: copyViewerHistoryTo },
  { name: 'filerHistory', copy: copyFilerHistoryTo },
  { name: 'dismissedSelection', copy: copyDismissedSelection }
]

/**
 * Copies every per-conversation workspace state of `fromId` to `toId`. One kind failing does not stop the others (the handoff
 * itself has already happened; a missing piece only means that part starts empty). Resolves to the names that failed, which are
 * also reported to main for the log (no value, no UI).
 */
export async function copyThreadWorkspace(fromId: string, toId: string): Promise<readonly string[]> {
  const failed: string[] = []
  if (fromId === toId) return failed
  for (const carrier of CARRIERS) {
    try {
      await carrier.copy(fromId, toId)
    } catch {
      failed.push(carrier.name)
    }
  }
  // TODO 1337 (11): tell main which kinds failed (names and the new conversation's id only) so it is in the log. Never throws.
  if (failed.length > 0) {
    try {
      window.aios.threads.workspaceCopyFailed?.(toId, failed)
    } catch {
      // Reporting is best effort; the new conversation starts either way.
    }
  }
  return failed
}

/**
 * The `beforeOpen` hook for a handoff-shaped path (TODO 1337 (8)): "continue in a lighter new conversation" (961) and the backend
 * switch after a send (1018) both create a new conversation for the same work, so both copy the workspace the same way.
 */
export function workspaceCopier(fromId: string): (newThreadId: string) => Promise<readonly string[]> {
  return (newThreadId) => copyThreadWorkspace(fromId, newThreadId)
}
