/**
 * Saving and resolving the display language (ARCHITECTURE.md 7.4.4, TODO 66). Same shape as `ThemeController`.
 *
 * - The only storage is one key, `ui.locale`, in `app_settings` (no new migration).
 * - The OS language is received **by injection** from `app.getLocale()` (it does not depend on electron, so
 *   tests can run it with the real DB and a fake OS language).
 * - Unlike the theme, it does not subscribe to OS language change notifications. On macOS, changing the language presupposes restarting the app,
 *   and `app.getLocale()` keeps returning the value from launch.
 * - **main does not build wording** (owner decision 2). All it knows is the name of the language.
 */
import {
  resolveLocale,
  type Locale,
  type LocalePreference,
  type LocaleState
} from '@shared/locale.js'
import type { AppSettingsStore } from '../common/settings.js'
import { UI_LOCALE } from '../common/settings-keys.js'
import { log } from '../common/logger.js'

/**
 * The key of `app_settings`. **The key string lives only in `src/common/settings-keys.ts`**
 * (TODO 85) - this is a re-export kept for compatibility with existing callers.
 */
export const SETTING_LOCALE = UI_LOCALE.key

export class LocaleController {
  private readonly settings: AppSettingsStore
  private readonly systemLocale: () => string
  private readonly onChanged: (state: LocaleState) => void
  private preference: LocalePreference
  private resolved: Locale

  constructor(options: {
    settings: AppSettingsStore
    /** The OS language tag (`en-US` / `ja-JP` ...). In production, `app.getLocale()`. */
    systemLocale: () => string
    onChanged: (state: LocaleState) => void
  }) {
    this.settings = options.settings
    this.systemLocale = options.systemLocale
    this.onChanged = options.onChanged

    // A broken value falls to the default (the overall policy is that settings may be missing and it still works). The table's parse does that.
    this.preference = this.settings.readTyped(UI_LOCALE)
    this.resolved = resolveLocale(this.preference, this.systemLocale())
  }

  state(): LocaleState {
    return { preference: this.preference, resolved: this.resolved }
  }

  /** The value read at launch / when creating a window (initial query). */
  get locale(): Locale {
    return this.resolved
  }

  /**
   * Saves, and pushes to all windows **when the chosen value changed**. It pushes even if the effective language is the same
   * (the selection state of the settings screen's three values should match in other windows too).
   */
  setPreference(preference: LocalePreference): LocaleState {
    const changed = preference !== this.preference
    this.preference = preference
    this.settings.writeTyped(UI_LOCALE, preference)
    this.resolved = resolveLocale(preference, this.systemLocale())
    log.info('locale.set', { preference, locale: this.resolved })
    if (changed) this.onChanged(this.state())
    return this.state()
  }
}
