/**
 * Jump from the BottomBar version badge to the "About" section of the settings screen (TODO 316, wave 17 bundle A).
 *
 * It uses only the existing `openSettingsEditor()` as the entry to open settings (no new IPC or menu), and puts
 * just the "scroll to the section once open" request in this small store. The section (`BuildInfoSection`) watches
 * `seq` change and, if `pending`, shows itself and then scrolls. It works the same way when settings are already open.
 */
import { create } from 'zustand'
import { openSettingsEditor } from './settingsEditorStore.js'

interface BuildInfoJumpState {
  /** Whether there is a request not yet scrolled to. */
  readonly pending: boolean
  /** Advances on every request (so pressing the same request twice still works). */
  readonly seq: number
  consume(): void
}

export const useBuildInfoJump = create<BuildInfoJumpState>((set) => ({
  pending: false,
  seq: 0,
  consume: () => set({ pending: false })
}))

/** Opens the settings screen and scrolls to the About section. */
export function jumpToBuildInfo(): void {
  useBuildInfoJump.setState((state) => ({ pending: true, seq: state.seq + 1 }))
  openSettingsEditor()
}
