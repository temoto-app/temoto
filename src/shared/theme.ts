/**
 * Color theme (ARCHITECTURE.md 7.4.1).
 *
 * The renderer and plugins (iframes of another origin) cannot share CSS variables, so
 * **only the theme name** is carried in the viewer contract (`ViewerHostMessage.theme`, next to `resource`).
 * The CSS on both sides switches the values of the same variable names with `html[data-theme]`.
 *
 * **There are 2 levels of values.** What the user chooses is `ThemePreference` (`light` / `dark` / `system`), and
 * what is actually drawn is `Theme` (`light` / `dark`). The only link between them is `resolveTheme`, and
 * main (`nativeTheme`) and the renderer go through the same function (T10).
 */
export type Theme = 'light' | 'dark'

/** The value saved in settings. `system` follows the OS. */
export type ThemePreference = Theme | 'system'

/** The order shown on the settings screen. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** The default when there is no saved value or it is broken. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'

/** The color drawn when even the OS dark flag cannot be obtained (the same light as the CSS `:root` side). */
export const DEFAULT_THEME: Theme = 'light'

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark'
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return isTheme(value) || value === 'system'
}

/**
 * The effective theme = the saved value + the OS dark flag. **Resolution happens in this one place.**
 *
 * The OS is consulted only for `system`. An explicit `light` / `dark` overrides the OS.
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/** The current state passed to the renderer (the chosen value and the value actually drawn). */
export interface ThemeState {
  readonly preference: ThemePreference
  readonly resolved: Theme
}

/**
 * `backgroundColor` of `BrowserWindow` (a measure against the flash right after launch, 7.4.1).
 *
 * It must be **the same value as `--bg` in `styles.css`**. CSS variables do not take effect before the window
 * draws its first frame, so only here the same color is needed on the main side too.
 * `test/theme-resolve.test.ts` checks that it matches `--bg` in styles.css.
 */
export const THEME_BACKGROUND: Record<Theme, string> = {
  light: '#ffffff',
  dark: '#1b1d21'
}

/** The query name used to hand the renderer its initial value when opening a window (so it draws in the right color from the first frame). */
export const THEME_QUERY_KEY = 'aios-theme'
