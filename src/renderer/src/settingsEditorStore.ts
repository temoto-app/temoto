/**
 * Whether the settings editor is open (item 187, ARCHITECTURE.md 5.8).
 *
 * Settings open in the ThreadPane's place, not as a modal (like VS Code's settings editor
 * opening as an editor tab). The open / close state is in a separate small store rather than added to threadStore, because threadStore is
 * touched by many bundles. From ⌘, (the menu, item 195), call `openSettingsEditor()`.
 *
 * - The ⚙ in the sidebar toggles open / closed.
 * - **Selecting another thread closes it** (avoids "pressed the list but the screen did not change").
 * - **Pressing the currently shown thread again also closes it** (item 212). `activeThreadId` does not
 *   change, so it looks at `selectionSeq`, which advances each time `threadStore.selectThread` is called
 *   (`jumpToEvent`, which jumps to the same thread from a conversation-search hit, also calls `selectThread`
 *   internally, so it closes through the same route).
 */
import { create } from 'zustand'
import { useThreads } from './threadStore.js'

interface SettingsEditorState {
  readonly open: boolean
  openEditor(): void
  close(): void
  toggle(): void
}

export const useSettingsEditor = create<SettingsEditorState>((set) => ({
  open: false,
  openEditor: () => set({ open: true }),
  close: () => set({ open: false }),
  toggle: () => set((state) => ({ open: !state.open }))
}))

/** Open from outside a hook, such as the menu (⌘,). */
export function openSettingsEditor(): void {
  useSettingsEditor.getState().openEditor()
}

useThreads.subscribe((state, previous) => {
  if (state.selectionSeq === previous.selectionSeq) return
  if (state.activeThreadId !== null) useSettingsEditor.getState().close()
})
