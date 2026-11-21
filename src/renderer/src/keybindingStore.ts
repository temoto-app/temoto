/**
 * The renderer-side copy of the user's keyboard shortcut assignments (TODO 549).
 *
 * **main is the source of truth** (`ui.keybindings` in `app_settings`, `KeybindingsPreference`). This just takes it at startup and,
 * on notification, copies it into `setKeybindings` of `shortcuts.ts` (the matching, the forwarding table and the tooltip
 * notation follow it). The settings screen (`ShortcutSettings.tsx`) re-renders via `useKeybindings`.
 *
 * The web page (`WebContentsView`) table is held by main, so a window showing web must resend when the assignments change:
 * `WebViewerPane` does this itself via `onKeybindingsChanged` (TODO 589).
 */
import { create } from 'zustand'
import type { KeybindingOverrides } from '@shared/keybindings.js'
import { setKeybindings } from './shortcuts.js'

export interface KeybindingsState {
  readonly overrides: KeybindingOverrides
}

export const useKeybindings = create<KeybindingsState>(() => ({ overrides: {} }))

/** Apply the received assignments (matching, table, settings screen). */
function apply(overrides: KeybindingOverrides): void {
  setKeybindings(overrides)
  useKeybindings.setState({ overrides })
}

let initialized = false

/** Once per window (App calls it at startup). */
export function initKeybindings(): void {
  if (initialized || typeof window === 'undefined' || window.aios?.keybindings === undefined) return
  initialized = true
  const api = window.aios.keybindings
  let pushed = false
  api.onChanged((overrides) => {
    pushed = true
    apply(overrides)
  })
  void api.get().then((overrides) => {
    if (!pushed) apply(overrides)
  })
}

/** Save the whole diff (apply the value main re-validated). */
export async function saveKeybindings(overrides: KeybindingOverrides): Promise<void> {
  const api = window.aios.keybindings
  if (api === undefined) return
  apply(await api.set(overrides))
}

/** While recording, stop this window's menu accelerators (so that ⌘B etc. reach the recording field). */
export function setKeybindingRecording(recording: boolean): void {
  window.aios.keybindings?.setRecording(recording)
}
