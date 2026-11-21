/**
 * Display language (ARCHITECTURE.md 7.4.4, TODO 66). Same shape as `themeStore.ts`.
 *
 * **The source is main alone.** main resolves the saved value (`ui.locale` in `app_settings`) and the OS language
 * (`app.getLocale()`), and this just mirrors the result. For the viewer (an iframe of a different origin), `ViewerPane` passes
 * only the name in `locale`.
 *
 * The very first frame after startup cannot wait for an IPC round trip, so it reads the query (`?aios-locale=…`) that main
 * attached when opening the window. If that cannot be read, `navigator.language` is used as a fallback (**secondary**; main is primary).
 */
import { create } from 'zustand'
import {
  DEFAULT_LOCALE_PREFERENCE,
  LOCALE_QUERY_KEY,
  isLocale,
  localeFromTag,
  type Locale,
  type LocalePreference,
  type LocaleState
} from '@shared/locale.js'
import { createSubscriptionSlot } from './subscription-slot.js'

/** The value for the first frame. In order: main's query -> the browser language -> English. */
export function initialLocale(): Locale {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get(LOCALE_QUERY_KEY)
    if (isLocale(fromQuery)) return fromQuery
    return localeFromTag(window.navigator.language)
  } catch {
    // Do not crash when read from tests either (an environment without window).
    return localeFromTag(null)
  }
}

/** Write to `<html lang>` (screen readers, glyph selection and hyphenation look at it). */
export function applyLocale(locale: Locale): void {
  document.documentElement.lang = locale
}

interface LocaleStore extends LocaleState {
  init(): Promise<void>
  /** Release the `init()` subscription (TODO 571, cleanup of `App`'s `useEffect`). */
  dispose(): void
  setPreference(preference: LocalePreference): Promise<void>
}

const subscriptions = createSubscriptionSlot()

export const useLocale = create<LocaleStore>((set) => ({
  preference: DEFAULT_LOCALE_PREFERENCE,
  resolved: typeof window === 'undefined' ? localeFromTag(null) : initialLocale(),

  async init(): Promise<void> {
    const token = subscriptions.begin()
    const state = await window.aios.locale.get()
    applyLocale(state.resolved)
    set(state)
    // If StrictMode's second init has come, it is the one that subscribes (TODO 571).
    if (!subscriptions.claim(token)) return
    // Changes in other windows arrive here too (main pushes to all windows).
    subscriptions.add(
      window.aios.locale.onChanged((next) => {
        applyLocale(next.resolved)
        set(next)
      })
    )
  },

  dispose(): void {
    subscriptions.dispose()
  },

  async setPreference(preference: LocalePreference): Promise<void> {
    const state = await window.aios.locale.set(preference)
    applyLocale(state.resolved)
    set(state)
  }
}))
