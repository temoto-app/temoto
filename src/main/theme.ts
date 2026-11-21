/**
 * Saving the color theme and following the OS (ARCHITECTURE.md 7.4.1, TODO 13 / T10).
 *
 * - The storage is just one key of `app_settings` (no migration is added). The whole DB is
 *   encrypted by constraint 11.
 * - **The OS dark flag is primarily main's `nativeTheme`.** The renderer's
 *   `prefers-color-scheme` cannot be read before a window opens, and it is too late to
 *   decide the window's `backgroundColor`.
 * - `nativeTheme.themeSource` is also set to match. Native parts (scrollbars,
 *   the title bar, dialogs) look at it, so this prevents the mismatch of choosing `light` but only the frame being dark.
 *   When it is `system`, it is left as `'system'` so that
 *   `shouldUseDarkColors` stays **the OS's value itself**.
 *
 * It does not depend on Electron (it is received through `NativeThemeLike`), so tests can run it with a real DB and
 * a fake nativeTheme.
 */
import {
  resolveTheme,
  type Theme,
  type ThemePreference,
  type ThemeState
} from '@shared/theme.js'
import type { AppSettingsStore } from '../common/settings.js'
import { UI_THEME } from '../common/settings-keys.js'
import { log } from '../common/logger.js'

/**
 * The key of `app_settings`. **The key string exists only in `src/common/settings-keys.ts`**
 * (TODO 85) - this is a re-export for compatibility with existing callers.
 */
export const SETTING_THEME = UI_THEME.key

/** Only the part of `electron.nativeTheme` used here. */
export interface NativeThemeLike {
  readonly shouldUseDarkColors: boolean
  themeSource: 'system' | 'light' | 'dark'
  on(event: 'updated', listener: () => void): unknown
}

export class ThemeController {
  private readonly settings: AppSettingsStore
  private readonly native: NativeThemeLike
  private readonly onChanged: (state: ThemeState) => void
  private preference: ThemePreference
  private resolved: Theme

  constructor(options: {
    settings: AppSettingsStore
    native: NativeThemeLike
    onChanged: (state: ThemeState) => void
  }) {
    this.settings = options.settings
    this.native = options.native
    this.onChanged = options.onChanged

    // A broken value falls back to the default ("works even if a setting is missing" is the overall policy). The table's parse does it.
    this.preference = this.settings.readTyped(UI_THEME)
    this.apply()
    this.resolved = resolveTheme(this.preference, this.native.shouldUseDarkColors)

    // A change on the OS side. It also fires when `themeSource` is written, so
    // push **only when the effective theme changed**.
    this.native.on('updated', () => {
      const next = resolveTheme(this.preference, this.native.shouldUseDarkColors)
      if (next === this.resolved) return
      this.resolved = next
      log.info('theme.changed', { preference: this.preference, theme: next })
      this.onChanged(this.state())
    })
  }

  state(): ThemeState {
    return { preference: this.preference, resolved: this.resolved }
  }

  /** The value read at startup, before windows are created (`backgroundColor` and the initial query). */
  get theme(): Theme {
    return this.resolved
  }

  setPreference(preference: ThemePreference): ThemeState {
    this.preference = preference
    this.settings.writeTyped(UI_THEME, preference)
    this.apply()
    const next = resolveTheme(preference, this.native.shouldUseDarkColors)
    if (next !== this.resolved) {
      this.resolved = next
      this.onChanged(this.state())
    }
    log.info('theme.set', { preference, theme: this.resolved })
    return this.state()
  }

  /** Only for `system` does `shouldUseDarkColors` become the OS's value (the comment above). */
  private apply(): void {
    this.native.themeSource = this.preference
  }
}
