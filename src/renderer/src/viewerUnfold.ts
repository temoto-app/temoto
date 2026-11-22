/**
 * When a folded ViewerPane opens again by itself (TODO 1297 review, ARCHITECTURE 5.5). The fold state lives in `App.tsx`;
 * this is the store side of it.
 *
 * - **Opening something opens it**: every request to show (`viewerOpens`, advanced by `select` with a URI and by
 *   `noteViewerOpen` for the same Web URL) and every new temporary view. The URI need not change: opening the file
 *   already selected (a link in the conversation, the same Files row, the AI's `openFile` / `openUrl`) opens it too.
 * - **The restore on a conversation switch (and at startup) does not** (`isRestoringViewer()`, the same marker as
 *   TODO 1300's Files follow): otherwise every switch would undo the user's fold and save "open" over it.
 *
 * `select` and the listener are both synchronous, so the marker is read inside the listener.
 */
import { useEffect } from 'react'
import { useStore } from './store.js'
import { isRestoringViewer } from './viewerMemory.js'

type OpenState = Pick<ReturnType<typeof useStore.getState>, 'viewerOpens' | 'transient'>

/** Whether the change from `previous` to `state` asks the viewer to show something (restore excluded by the caller). */
export function viewerOpenRequested(state: OpenState, previous: OpenState): boolean {
  return (
    state.viewerOpens !== previous.viewerOpens ||
    (state.transient !== null && state.transient !== previous.transient)
  )
}

/** Placed in App once. Calls `unfold` for each request to show, except the restore. */
export function useUnfoldOnOpen(unfold: () => void): void {
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (isRestoringViewer()) return
        if (viewerOpenRequested(state, previous)) unfold()
      }),
    [unfold]
  )
}
