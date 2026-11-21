/**
 * The IPC for voice input (item 226, 4.5.10). Kept apart from `handlers.ts` (so as not to touch the same place as parallel bundles).
 * Validation of values (shape, limits, silence) is owned by `VoiceTranscriber` itself, so this only passes them on.
 *
 * The recognition-language setting (TODO 626) is also wired here. It is stored only as a single key in main (`VOICE_LOCALE`), and
 * shown in the settings editor but not notified to other windows (the same lightweight handling as `EditorPreference`).
 */
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import { isVoiceLocalePreference } from '@shared/voice-locale.js'
import type { VoiceTranscriber } from './transcriber.js'
import type { VoiceLocalePreferenceStore } from './locale-preference.js'

export function registerVoiceHandler(
  transcriber: VoiceTranscriber,
  localePreference: VoiceLocalePreferenceStore,
  /** Call after the recognition language changed (TODO 1060 stage 3: so an open settings screen follows). */
  onLocaleChanged: () => void = () => undefined
): void {
  const setLocale = (preference: Parameters<VoiceLocalePreferenceStore['set']>[0]): ReturnType<VoiceLocalePreferenceStore['set']> => {
    const saved = localePreference.set(preference)
    onLocaleChanged()
    return saved
  }
  ipcMain.handle(IpcChannel.voiceTranscribe, (_event, wav: unknown) => transcriber.transcribe(wav))
  ipcMain.handle(IpcChannel.voiceLocaleGet, () => localePreference.get())
  ipcMain.handle(IpcChannel.voiceLocaleSet, (_event, preference: unknown) =>
    isVoiceLocalePreference(preference) ? setLocale(preference) : localePreference.get()
  )
}
