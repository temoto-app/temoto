/**
 * The two settings that change how the computer behaves outside the app (TODO 1266 / 1270, wave 93 bundle C): start at login, and keep the
 * computer awake while scheduled jobs wait. The values themselves are `openAtLogin` / `preventSleep` of `SettingValues`; this is the extra
 * state the settings screen needs (whether the OS can do it here, and why not).
 */

/**
 * Why the login item cannot be used in this process. The same words as the auto-update's `UpdateUnsupportedReason`
 * (a development server, a development shell, a copy with another user data directory, a build that was not installed, an OS without it).
 */
export const OS_SETTING_UNAVAILABLE_REASONS = ['dev', 'not-installed', 'dev-shell', 'instance', 'platform'] as const
export type OsSettingUnavailableReason = (typeof OS_SETTING_UNAVAILABLE_REASONS)[number]

export interface OpenAtLoginState {
  /** Where the OS can tell (`supported`) this is the OS's own state, not the stored memory (the user may remove the item in System Settings). */
  readonly enabled: boolean
  readonly supported: boolean
  readonly reason: OsSettingUnavailableReason | null
}

export interface PreventSleepState {
  /** The stored setting. */
  readonly enabled: boolean
  /** Whether the blocker is held right now (setting on + an enabled scheduled job + on AC power). */
  readonly active: boolean
}

export interface MenuBarState {
  /** The stored setting (default off). */
  readonly enabled: boolean
  /** Only macOS has a menu bar icon here; elsewhere the setting is greyed out and does nothing. */
  readonly supported: boolean
  /** Why it is not supported (`instance`: a non-default userData such as dev or a copy; absent when supported). */
  readonly reason?: 'platform' | 'instance'
}

export interface OsSettingsState {
  readonly openAtLogin: OpenAtLoginState
  readonly preventSleep: PreventSleepState
  readonly menuBar: MenuBarState
}
