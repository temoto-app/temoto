/**
 * Home for the screens that open in the ThreadPane's place (TODO 458, wave 23 bundle A. ARCHITECTURE.md 5.3 / 7.4.6).
 *
 * Three screens open in the ThreadPane's place: the settings editor (item 187, `settingsEditorStore.ts`), the scheduled-run editor
 * (TODO 372, `scheduleStore.ts`), and the extension detail / audit log (TODO 367 -> 458, `useExtensionPane` in this file).
 * None of them unmounts the ThreadPane; it is hidden with CSS (`.settings-editor ~ .thread-pane`, keeping draft and selection state).
 *
 * **Priority is decided here: the one opened later wins.** Opening one closes the other 2, so a state with 2 or more open at once
 * is never created. The exclusion between settings and scheduled runs has been in `scheduleStore.ts` since 372 (opening settings closes
 * scheduled runs, and opening scheduled runs closes settings); this file sets up the exclusion with the extension detail in both
 * directions. `useMainPanel` returns the 1 to draw (the fallback order if the exclusion ever breaks is extension -> scheduled runs -> settings).
 *
 * Closing follows the settings editor: ✕, or selecting a thread (`selectionSeq` advances, even if the current thread is pressed again).
 * It does not touch the contents of the ViewerPane (the open files, the temporary diff view).
 */
import { create } from 'zustand'
import { useThreads } from './threadStore.js'
import { useSettingsEditor } from './settingsEditorStore.js'
import { useSchedule } from './scheduleStore.js'

/** The extension detail (TODO 367 -> 458). */
export interface ExtensionDetailView {
  readonly kind: 'extension'
  readonly pluginId: string
}

/** The whole audit log (TODO 367 -> 458). The per-plugin part is "execution status" in the detail. */
export interface AuditLogView {
  readonly kind: 'audit'
}

export type ExtensionPaneView = ExtensionDetailView | AuditLogView

interface ExtensionPaneState {
  /** The extension screen open in the ThreadPane's place. null means closed. */
  readonly view: ExtensionPaneView | null
  openExtension(pluginId: string): void
  openAuditLog(): void
  close(): void
}

/** Close the other 2, then open (the opening comes after, so the close notifications do not close this one). */
function closeOthers(): void {
  useSettingsEditor.getState().close()
  useSchedule.getState().closeEditor()
}

export const useExtensionPane = create<ExtensionPaneState>((set, get) => ({
  view: null,
  openExtension: (pluginId) => {
    closeOthers()
    set({ view: { kind: 'extension', pluginId } })
  },
  openAuditLog: () => {
    closeOthers()
    set({ view: { kind: 'audit' } })
  },
  close: () => {
    if (get().view !== null) set({ view: null })
  }
}))

export type MainPanel = 'settings' | 'schedule' | 'extension' | null

/** The 1 to draw in the ThreadPane's place. null means the ThreadPane itself. */
export function useMainPanel(): MainPanel {
  const extension = useExtensionPane((state) => state.view !== null)
  const schedule = useSchedule((state) => state.editing !== null)
  const settings = useSettingsEditor((state) => state.open)
  if (extension) return 'extension'
  if (schedule) return 'schedule'
  if (settings) return 'settings'
  return null
}

// When settings / scheduled runs are opened, close the extension screen (the one opened later wins).
useSettingsEditor.subscribe((state, previous) => {
  if (state.open && !previous.open) useExtensionPane.getState().close()
})
useSchedule.subscribe((state, previous) => {
  if (state.editing !== null && previous.editing === null) useExtensionPane.getState().close()
})

// Close when a thread is selected (same as the settings editor. Pressing the current thread again also closes, item 212).
useThreads.subscribe((state, previous) => {
  if (state.selectionSeq === previous.selectionSeq) return
  if (state.activeThreadId !== null) useExtensionPane.getState().close()
})
