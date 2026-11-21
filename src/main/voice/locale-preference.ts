/**
 * Setting for the speech-recognition language of voice input (TODO 626, ARCHITECTURE.md 4.5.10).
 *
 * It is stored as a single key in `app_settings` (`VOICE_LOCALE`, TODO 85). The same lightweight shape as `EditorPreference`
 * (the chosen value is the stored value; resolving "follow the OS" is not done here). Resolving `auto` into the
 * tag passed to the real helper is done by `resolveVoiceSpeechLocale` (`@shared/voice-locale.js`) — this file only holds the chosen
 * setting value, and reading macOS's preferred languages is up to the caller (`src/main/index.ts`).
 */
import type { VoiceLocalePreference } from '@shared/voice-locale.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { VOICE_LOCALE } from '../../common/settings-keys.js'

export class VoiceLocalePreferenceStore {
  private current: VoiceLocalePreference

  constructor(private readonly settings: AppSettingsStore) {
    this.current = settings.readTyped(VOICE_LOCALE)
  }

  get(): VoiceLocalePreference {
    return this.current
  }

  set(preference: VoiceLocalePreference): VoiceLocalePreference {
    this.current = preference
    this.settings.writeTyped(VOICE_LOCALE, preference)
    return this.current
  }
}
