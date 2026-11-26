/**
 * The boot entry of every window (TODO 807, ARCHITECTURE 3.1 "launch order").
 *
 * The first window is opened before main has the DB key (reading it can wait on a macOS keychain dialog), so the renderer may start
 * while no handler but `boot.*` exists. This file therefore touches nothing else: it colours the page from the query, puts up a
 * notice that stays invisible for `BOOT_NOTICE_DELAY_MS` (a normal launch is ready long before), tells main its first frame is
 * painted, and waits. When main answers, the look it resolved from the DB (theme, language, folding days) is written into the query,
 * and only then is the app loaded (`app-main.tsx`): its stores read the query once, at import.
 *
 * A window opened after the launch passes through the same steps; `boot.wait` is answered at once.
 */
import { THEME_QUERY_KEY, isTheme, type Theme } from '@shared/theme.js'
import { LOCALE_QUERY_KEY, isLocale, localeFromTag, type Locale } from '@shared/locale.js'
import { THREAD_COLLAPSE_QUERY_KEY } from '@shared/thread-collapse.js'
import { DATA_NAME, PRODUCT_NAME } from '@shared/product.js'
import { BOOT_NOTICE_DELAY_MS, BOOT_OS_QUERY_KEY, DATA_NAME_QUERY_KEY, type BootLook, type BootOs } from '@shared/boot.js'
import { BOOT_NOTICE } from './i18n/boot-notice.js'

/** The theme of the first frame: the query main attached, else the OS preference. */
export function bootTheme(search: string, prefersDark: boolean): Theme {
  const fromQuery = new URLSearchParams(search).get(THEME_QUERY_KEY)
  if (isTheme(fromQuery)) return fromQuery
  return prefersDark ? 'dark' : 'light'
}

/** The language of the notice: the query main attached, else the browser's language. */
export function bootLocale(search: string, navigatorLanguage: string | null): Locale {
  const fromQuery = new URLSearchParams(search).get(LOCALE_QUERY_KEY)
  if (isLocale(fromQuery)) return fromQuery
  return localeFromTag(navigatorLanguage)
}

/**
 * The notice's lines. The body (the keychain sentence) is there **on macOS only** (`BOOT_OS_QUERY_KEY` = `mac`, wave 106 review Z5);
 * elsewhere, or without the key, it is null and the notice is the title alone. The keychain item is `<data name> Safe Storage`
 * (TODO 1263: `aios` on a machine that already had it).
 */
export function bootNoticeText(locale: Locale, search: string): { readonly title: string; readonly body: string | null } {
  const params = new URLSearchParams(search)
  const fromQuery = params.get(DATA_NAME_QUERY_KEY)
  const dataName = fromQuery !== null && /^[A-Za-z0-9 ._-]{1,64}$/.test(fromQuery) ? fromQuery : DATA_NAME
  const os: BootOs = params.get(BOOT_OS_QUERY_KEY) === 'mac' ? 'mac' : 'other'
  const words = BOOT_NOTICE[locale]
  const fill = (text: string): string =>
    text.replace(/\{app\}/g, PRODUCT_NAME).replace(/\{keychainItem\}/g, `${dataName} Safe Storage`)
  return { title: fill(words.title), body: os === 'mac' ? fill(words.macKeychain) : null }
}

/** The query with main's resolved look written in (the other keys are kept, in their order). Returns `?…`. */
export function queryWithLook(search: string, look: BootLook): string {
  const params = new URLSearchParams(search)
  params.set(THEME_QUERY_KEY, look.theme)
  params.set(LOCALE_QUERY_KEY, look.locale)
  params.set(THREAD_COLLAPSE_QUERY_KEY, String(look.threadCollapseDays))
  return `?${params.toString()}`
}

function showNotice(locale: Locale, search: string): HTMLElement {
  const text = bootNoticeText(locale, search)
  const notice = document.createElement('div')
  notice.className = 'boot-notice'
  notice.setAttribute('role', 'status')
  notice.style.setProperty('--boot-notice-delay', `${BOOT_NOTICE_DELAY_MS}ms`)
  const title = document.createElement('p')
  title.className = 'boot-notice-title'
  title.textContent = text.title
  notice.append(title)
  if (text.body !== null) {
    const body = document.createElement('p')
    body.className = 'boot-notice-body'
    body.textContent = text.body
    notice.append(body)
  }
  document.body.append(notice)
  return notice
}

/** Runs the boot steps, then `loadApp` (the dynamic import of the app). Loads nothing if main abandoned the launch. */
export async function startBoot(loadApp: () => Promise<unknown>): Promise<void> {
  const search = window.location.search
  const locale = bootLocale(search, window.navigator.language)
  document.documentElement.dataset['theme'] = bootTheme(search, window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.lang = locale
  const notice = showNotice(locale, search)
  // Two frames: the first is committed with the page's colours, so main may now block on the keychain with this window on screen.
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.aios.boot.painted()))
  const answer = await window.aios.boot.wait()
  if (!answer.ready) return
  const next = queryWithLook(window.location.search, answer.look)
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${next}${window.location.hash}`)
  notice.remove()
  await loadApp()
}
