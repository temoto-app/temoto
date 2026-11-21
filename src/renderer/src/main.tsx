import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { applyTheme, initialTheme } from './themeStore.js'
import { applyLocale, initialLocale } from './localeStore.js'
import { installAsciiInputTracker } from './ascii-input.js'
import { installComposerDraftReport } from './composer-drafts.js'
import { useThreads } from './threadStore.js'
import { useStore } from './store.js'
import { installViewerDraftCountReport } from './viewer-drafts.js'
import { currentPaneSaver, installViewerDraftsClose } from './viewer-drafts-close.js'
import { installFilesDragForgetGuards } from './files-drag.js'
import './styles.css'

// Colors (7.4.1). styles.css switches to dark values with `:root[data-theme="dark"]`.
// **Only the first frame** reads the query main attached (the same value as the window's backgroundColor);
// after that, themeStore rewrites it with the effective theme pushed from main.
applyTheme(initialTheme())
// Display language (7.4.4) is the same. The first frame reads main's query (`?aios-locale=`);
// after that, localeStore rewrites it with the value pushed from main.
applyLocale(initialLocale())
// ASCII input in the search field (TODO 463). Only tells main whether this window's search field has focus.
installAsciiInputTracker((focused) => window.aios.input.asciiForSearch(focused))
// TODO 677 (code-review fix): also reliably forget the memory of a native drag that started from the Files tree, using
// document-wide signals (dragend/drop/mouseup/pointerup/window focus), in case a drop target forgets to clear it.
installFilesDragForgetGuards()
// TODO 526: tell main the set of threads whose Composer has a draft (protects them from the auto-deletion of threads with no input and no answer).
installComposerDraftReport(useThreads, (ids) => window.aios.threads.reportComposerDrafts(ids))
// TODO 103 (code-review): tell main the count of the viewer's draft table (so unsaved drafts of files that were navigated away from
// are not discarded by the auto-update idle restart). Only the count.
installViewerDraftCountReport(useStore, (count) => window.aios.viewer.reportStoredDrafts(count))
// TODO 606: answer main's request, made before closing a window or quitting, to "list the unsaved drafts / write them all out".
installViewerDraftsClose(window.aios.viewer, {
  table: () => useStore.getState().viewerDrafts,
  conflictUri: () => useStore.getState().draftConflict?.uri ?? null,
  forget: (uri, text) => {
    const state = useStore.getState()
    if (state.viewerDrafts[uri]?.text === text) state.forgetDraft(uri)
  },
  pane: currentPaneSaver,
  open: (uri) => window.aios.viewer.open(uri),
  write: (pluginId, uri, text, baseMtimeMs) => window.aios.viewer.write(pluginId, uri, text, baseMtimeMs),
  close: (pluginId, uri) => window.aios.viewer.close(pluginId, uri)
})

const host = document.getElementById('root')
if (host === null) throw new Error('#root not found')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>
)
