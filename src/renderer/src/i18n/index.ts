/**
 * The UI string dictionary and `t()` (ARCHITECTURE.md 7.4.4, TODO 66).
 *
 * - **No external library is added** (owner decision 6). Just `Record<Locale, Record<key, string>>` and
 *   the `{name}` interpolation. Plural forms and date formats are not needed (two languages, EN/JA).
 * - The key set is authoritative in `ja.ts`, and `en.ts` is forced to have the same keys by the type (`Messages`).
 *   `test/i18n.test.ts` also checks the match at runtime (the same idea as the check of the theme's variable set).
 * - **An unknown key returns the key itself** (it does not throw). There are paths that build reason codes dynamically,
 *   so a gap in the dictionary must not bring down the whole screen.
 * - Text from main arrives as a reason code of `shared/reason.ts`, and `describeReason` turns it into text.
 * - **Do not hardcode the product name in text** (TODO 1254). Write `{app}` and `translate` fills it with `PRODUCT_NAME` (`shared/product.json`)
 *   (the caller need not pass it). Internal identifiers (`aios.diff`, `aios://`) are not names, so they are written as they are.
 *   TODO 1263: the per-machine data name (the keychain item, `~/<name>/scratch`) is passed by the caller from `AppInfo.dataName`.
 */
import { useCallback } from 'react'
import type { Locale } from '@shared/locale.js'
import { isReasonCode, parseReason } from '@shared/reason.js'
import { PRODUCT_NAME } from '@shared/product.js'
import { useLocale } from '../localeStore.js'
import { ja, type MessageKey } from './ja.js'
import { en } from './en.js'

export type { MessageKey } from './ja.js'

/** Values to interpolate. Numbers are inserted as they are, without `toLocaleString` (the caller formats them). */
export type MessageParams = Readonly<Record<string, string | number>>

export const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { en, ja }

/**
 * The pure-function version. The language is explicit (for tests). **The key is accepted as a string**, so that one can pass an unknown key
 * and confirm that "the key itself is returned". From screens, use the typed `t` / `useT`
 * (a typo in a key fails typecheck; keys built like `theme.${value}` are also
 * checked by template literal types).
 */
export function translate(locale: Locale, key: string, params?: MessageParams): string {
  const table = DICTIONARIES[locale] as Readonly<Record<string, string>>
  const raw = table[key]
  if (raw === undefined) return key
  // TODO 1254: the product name. Filled before the caller's values (`{app}` inside a value is not filled).
  const template = raw.replace(/\{app\}/g, PRODUCT_NAME)
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    if (value === undefined) return whole
    // Item 141: a value main interpolated can itself be a reason code
    // (for example `{reason}` of `reason.transcript-cwd-unusable`). Passed through as is, an untranslated
    // raw code (`excluded` etc.) would appear in the sentence, so it is translated first.
    if (typeof value === 'string' && isReasonCode(value)) return translate(locale, `reason.${value}`)
    return String(value)
  })
}

/** Look up in the current language from outside hooks (stores, etc.). **It does not re-render**, so use `useT` for rendering. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(useLocale.getState().resolved, key, params)
}

export type Translate = (key: MessageKey, params?: MessageParams) => string

/** For rendering. When the language changes, components that use this hook are redrawn. */
export function useT(): Translate {
  const locale = useLocale((state) => state.resolved)
  return useCallback(
    (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
    [locale]
  )
}

/**
 * Turn a reason that arrived from main (a reason code, an exception sentence containing `aios-reason:`, or a raw sentence) into
 * text for display. If it is not a code, return it as it is.
 */
export function describeReason(tr: Translate, message: string | null | undefined): string {
  if (message === null || message === undefined) return ''
  const reason = parseReason(message)
  if (reason === null) return message
  return tr(`reason.${reason.code}`, reason.params)
}
