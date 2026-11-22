/**
 * TODO 1007: the viewer heading's "Show in Files". Switches the sidebar to Files (opening it if collapsed),
 * then expands the tree down to that file and selects it (the store's `reveal(uri)`; no new IPC).
 * It is an explicit action, so it does not break the "never auto-select" promise (item 80).
 * The automatic form (TODO 1300: Files follows the viewer's file without switching the mode) is `files-follow-viewer.ts`.
 */
import { useStore } from './store.js'
import { useThreads } from './threadStore.js'

/** Only real `file://` URIs qualify (conversation and temporary-view URIs are not in the Files tree). */
export function canShowInFiles(uri: string | null): uri is string {
  return uri !== null && uri.startsWith('file://')
}

export function showInFiles(uri: string): void {
  const threads = useThreads.getState()
  // setMode collapses when the same mode is pressed again, so call it only when it needs to be pressed.
  if (threads.mode !== 'files') threads.setMode('files')
  else if (threads.sidebarCollapsed) threads.toggleSidebar()
  void useStore.getState().reveal(uri)
}
