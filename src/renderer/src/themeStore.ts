/**
 * Color theme (ARCHITECTURE.md 7.4.1, T10).
 *
 * **The source is main, in one place.** main resolves the saved value (`app_settings`) and the OS dark flag (`nativeTheme`),
 * and this file only copies the result and writes it to `<html data-theme>`.
 * To the viewer (a cross-origin iframe), `ViewerPane` passes it in `resource.theme`
 * - the route is unchanged from T2.
 *
 * For the very first frame after launch an IPC round trip cannot be awaited, so it reads the query
 * main attached when opening the window (`?aios-theme=…`). If it cannot be obtained, `prefers-color-scheme` is used
 * as insurance (**secondary**; main is primary).
 */
import { create } from 'zustand'
import {
  DEFAULT_THEME,
  DEFAULT_THEME_PREFERENCE,
  THEME_QUERY_KEY,
  isTheme,
  type Theme,
  type ThemePreference,
  type ThemeState
} from '@shared/theme.js'
import { createSubscriptionSlot } from './subscription-slot.js'

/** The value used in the first frame. In order: main's query, the OS setting, light. */
export function initialTheme(): Theme {
  const fromQuery = new URLSearchParams(window.location.search).get(THEME_QUERY_KEY)
  if (isTheme(fromQuery)) return fromQuery
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  return DEFAULT_THEME
}

/** Writes to `<html data-theme>`. styles.css switches the variables with it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme
}

interface ThemeStore extends ThemeState {
  init(): Promise<void>
  /** Releases the `init()` subscriptions (TODO 571, the cleanup of `App`'s `useEffect`). */
  dispose(): void
  setPreference(preference: ThemePreference): Promise<void>
}

const subscriptions = createSubscriptionSlot()

export const useTheme = create<ThemeStore>((set) => ({
  preference: DEFAULT_THEME_PREFERENCE,
  resolved: initialTheme(),

  async init(): Promise<void> {
    const token = subscriptions.begin()
    const state = await window.aios.theme.get()
    applyTheme(state.resolved)
    set(state)
    // If StrictMode's second init has come, it is the one that subscribes (TODO 571).
    if (!subscriptions.claim(token)) return
    // Both settings changes and OS changes come here (main pushes the effective theme).
    subscriptions.add(
      window.aios.theme.onChanged((next) => {
        applyTheme(next.resolved)
        set(next)
      })
    )
  },

  dispose(): void {
    subscriptions.dispose()
  },

  async setPreference(preference: ThemePreference): Promise<void> {
    const state = await window.aios.theme.set(preference)
    applyTheme(state.resolved)
    set(state)
  }
}))
