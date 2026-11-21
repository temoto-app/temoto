/**
 * The active thread's working folder (a `file://` URI). The BottomBar git display (5.6) and the
 * "this working folder" section of search (item 100) look at the same value.
 *
 * **A selector that builds no value** (a Phase 2 pitfall): it only returns a string or null, so it does not
 * re-render when the list updates but the cwd is the same. The cwd of a scratch area thread (T19) is returned like any cwd
 * (search shows no section when there are 0 hits, so no special case is needed).
 */
import { workingCwdUri } from '@shared/thread.js'
import { useThreads } from './threadStore.js'

export function selectActiveCwd(state: ReturnType<typeof useThreads.getState>): string | null {
  const id = state.activeThreadId
  if (id === null) return null
  const summary = state.threadsById[id]
  if (summary === undefined) return null
  return summary.thread.cwdUri === '' ? null : summary.thread.cwdUri
}

/**
 * The **conversation's working folder** of the active thread (TODO 633 stage 1). If it moved to a worktree, that one.
 * The BottomBar git summary reads it. The search's "this working folder" stays on `selectActiveCwd` because a worktree is outside the index.
 */
export function selectActiveWorkingCwd(state: ReturnType<typeof useThreads.getState>): string | null {
  const id = state.activeThreadId
  if (id === null) return null
  const thread = state.threadsById[id]?.thread
  if (thread === undefined) return null
  const uri = workingCwdUri(thread)
  return uri === '' ? null : uri
}

/** The value at the time of the call (for reading from a store action). */
export function activeCwdUri(): string | null {
  return selectActiveCwd(useThreads.getState())
}
