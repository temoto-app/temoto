/**
 * A request to open the settings screen, scroll to one item and highlight it (TODO 1060 stage 2, the gateway's `openSettings`, ARCHITECTURE 7.6.8).
 *
 * The only way to open is the existing `openSettingsEditor()` (the same shape as `buildInfoJump.ts`, which jumps to the about section). The request is held by setting name
 * (the key of `SettingValues`); the settings editor (`Settings.tsx`) watches `seq` change, finds the field (`SETTINGS_ITEMS`) that has that name in its `value`,
 * shows it, and then clears the request. It works through the same route even when settings are already open.
 */
import { create } from 'zustand'
import type { SettingValueKey } from '@shared/settings.js'
import { openSettingsEditor } from './settingsEditorStore.js'

interface SettingsJumpState {
  /** The request not yet scrolled to (a setting name). null if none. */
  readonly pending: SettingValueKey | null
  /** Advances on every request (so that requesting the same name twice still takes effect). */
  readonly seq: number
  consume(): void
}

export const useSettingsJump = create<SettingsJumpState>((set) => ({
  pending: null,
  seq: 0,
  consume: () => set({ pending: null })
}))

/** Open the settings screen, scroll to the `name` item and highlight it. */
export function jumpToSetting(name: SettingValueKey): void {
  useSettingsJump.setState((state) => ({ pending: name, seq: state.seq + 1 }))
  openSettingsEditor()
}
