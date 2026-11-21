/**
 * Recognition language of voice input (TODO 626, ARCHITECTURE.md 4.5.10). A setting separate from the display language (`shared/locale.ts`):
 * split so that Japanese voice input still works even when the display language is EN. The same two-stage shape as `ThemePreference` / `LocalePreference`:
 * what the user chooses is `VoiceLocalePreference` (`auto` / `ja` / `en`), and what is passed to the helper
 * (`tools/speech-helper/`) is a BCP-47 tag (`ja-JP` / `en-US` / ...).
 *
 * `auto` is decided from the first of macOS's preferred languages (`app.getPreferredSystemLanguages()`). The helper accepts any string that
 * `Locale(identifier:)` can read and only returns `locale-unsupported` for unsupported ones, so
 * with `auto` a preferred language other than ja / en may be passed through as is (narrowing is left to the helper's decision).
 */

export type VoiceLocalePreference = 'auto' | 'ja' | 'en'

/** The order shown on the settings screen. */
export const VOICE_LOCALE_PREFERENCES: readonly VoiceLocalePreference[] = ['auto', 'ja', 'en']

export const DEFAULT_VOICE_LOCALE_PREFERENCE: VoiceLocalePreference = 'auto'

export function isVoiceLocalePreference(value: unknown): value is VoiceLocalePreference {
  return value === 'auto' || value === 'ja' || value === 'en'
}

/** An explicitly chosen language -> the BCP-47 tag passed to the helper. */
const EXPLICIT_SPEECH_LOCALE: Readonly<Record<'ja' | 'en', string>> = {
  ja: 'ja-JP',
  en: 'en-US'
}

/** The last default passed to the helper for `auto` when there is no preferred language at all. */
const FALLBACK_SPEECH_LOCALE = EXPLICIT_SPEECH_LOCALE.en

/**
 * Normalize a macOS preferred-language tag (`ja` / `ja-JP` / `en-US` / `fr_FR` ...). ja / en are aligned to the
 * default tag with a region, and other languages only have underscores changed to hyphens and are returned as is
 * (left to the helper's `Locale(identifier:)` decision).
 */
function normalizeSystemTag(tag: string): string {
  const trimmed = tag.trim()
  const primary = trimmed.split(/[-_]/, 1)[0]?.toLowerCase() ?? ''
  if (primary === 'ja') return EXPLICIT_SPEECH_LOCALE.ja
  if (primary === 'en') return EXPLICIT_SPEECH_LOCALE.en
  return trimmed.replace(/_/g, '-')
}

/**
 * Setting value + the list of macOS preferred languages (the first is the highest priority) -> the language tag passed to the helper. If `ja` / `en` is explicit,
 * only that is looked at. `auto` takes the first preferred language (skipping empty strings), and falls back to `en-US` if the list is empty.
 */
export function resolveVoiceSpeechLocale(
  preference: VoiceLocalePreference,
  preferredSystemLanguages: readonly string[]
): string {
  if (preference === 'ja' || preference === 'en') return EXPLICIT_SPEECH_LOCALE[preference]
  const first = preferredSystemLanguages.find((tag) => tag.trim() !== '')
  return first === undefined ? FALLBACK_SPEECH_LOCALE : normalizeSystemTag(first)
}
