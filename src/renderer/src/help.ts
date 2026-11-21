/**
 * The operations shared by the entry points of Help (TODO 1174, ARCHITECTURE.md 7.4.13). There are three entry points (owner decision 2026-11-07):
 * the menu "Help > aios Help" (the `openHelp` MenuCommand, App.tsx), the settings "About" button
 * (`BuildInfoSection`), and the ? at the bottom of the Activity Bar (Sidebar). All of them go through here.
 *
 * The initial language is the app's display language (the resolved value of `useLocale`; for `system`, already resolved to the OS language, 7.4.4).
 */
import { useStore } from './store.js'
import { useLocale } from './localeStore.js'
import type { ReleaseNotesDocument } from '@shared/release-notes.js'

/** Open Help (reopen it if it is already open). */
export function openHelp(): void {
  useStore.getState().openHelp(useLocale.getState().resolved)
}

/** The ? in the Activity Bar: close Help if it is in front, otherwise open it (closing by pressing again, the same as the settings gear). */
export function toggleHelp(): void {
  const store = useStore.getState()
  if (store.transient?.kind === 'help') store.closeTransient()
  else openHelp()
}

/** Show the fetched change history as a temporary view in ViewerPane (the standard Markdown viewer, read-only; the viewer is decided by the name's extension). */
function showReleaseNotes(doc: ReleaseNotesDocument | null): void {
  if (doc === null) return
  useStore.getState().openTransientFile({ name: doc.name, source: '', data: new TextEncoder().encode(doc.text) })
}

/** Open the full change history (menu "Help > Release notes" and "View change history" in settings "About". TODO 1186). */
export function openReleaseNotes(): void {
  void window.aios.releaseNotes.open().then(showReleaseNotes, () => undefined)
}

/**
 * Once at startup: on the first launch after the version went up, show the new version's section (main decides and records; it can be turned off in settings).
 * Even with several windows there is a single record in main, so only the window that asked first shows it.
 */
export function showReleaseNotesIfUpdated(): void {
  void window.aios.releaseNotes.takeAuto().then(showReleaseNotes, () => undefined)
}
