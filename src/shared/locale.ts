/**
 * Display language (ARCHITECTURE.md 7.4.4, TODO 66). Same shape as the theme (7.4.1).
 *
 * **The value has two levels.** What the user chooses is a `LocalePreference` (`en` / `ja` / `system`), and
 * what is actually drawn is a `Locale`. The only link between them is `resolveLocale`.
 *
 * **Main does not know the language** (owner decision 2): text that originates in main is returned as a reason code
 * (`shared/reason.ts`), and the renderer's dictionary turns it into text. Main holds this type only for
 * saving, for resolution (the OS language), and for putting it on the window's query.
 *
 * To add a language, add one line each to `LOCALES` and `LOCALE_LABEL`, and add the renderer's
 * `i18n/<locale>.ts` and the plugins' small dictionaries. `test/i18n.test.ts` checks that the sets of keys
 * match.
 */

/** The languages used for drawing. **Adding one to the enumeration is enough to support a new language.** */
export const LOCALES = ['en', 'ja'] as const
export type Locale = (typeof LOCALES)[number]

/** The value saved in settings. `system` follows the OS language. */
export type LocalePreference = Locale | 'system'

/** The order shown on the settings screen. */
export const LOCALE_PREFERENCES: readonly LocalePreference[] = ['system', ...LOCALES]

/**
 * A language name is shown in **that language's own script** (so it is readable whichever language is selected).
 * Only `system` is translated on the dictionary side (`settings.locale.system`), so it is not here.
 */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: 'English',
  ja: '日本語'
}

/** The default when there is no saved value or it is broken. */
export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = 'system'

/** The language to draw when the OS language is not in the table. */
export const DEFAULT_LOCALE: Locale = 'en'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return isLocale(value) || value === 'system'
}

/**
 * Maps an OS language tag (`en-US` / `ja-JP` / `ja` / `zh-Hant-TW` / `en_GB` ...) to a `Locale`.
 * It only looks at the primary language subtag (before the first `-` / `_`) in lower case. `en` if it is not in the table.
 */
export function localeFromTag(tag: string | null | undefined): Locale {
  if (typeof tag !== 'string') return DEFAULT_LOCALE
  const primary = tag.trim().split(/[-_]/, 1)[0]?.toLowerCase() ?? ''
  return isLocale(primary) ? primary : DEFAULT_LOCALE
}

/**
 * The effective language = the saved value + the OS language. **Resolution happens in this one place.**
 * The OS is consulted only for `system`. An explicit language beats the OS.
 */
export function resolveLocale(
  preference: LocalePreference,
  systemLocale: string | null | undefined
): Locale {
  if (preference === 'system') return localeFromTag(systemLocale)
  return preference
}

/** The current state passed to the renderer (the chosen value and the value actually drawn). */
export interface LocaleState {
  readonly preference: LocalePreference
  readonly resolved: Locale
}

/** The query name used to pass the initial value to the renderer when a window opens (so the first frame is drawn in the right language). */
export const LOCALE_QUERY_KEY = 'aios-locale'
