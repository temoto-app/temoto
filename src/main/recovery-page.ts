/**
 * The page a window shows after its renderer kept dying (TODO 1319, ARCHITECTURE.md 12.9.2). **Does not import electron.**
 *
 * The renderer is what died, so this is a static template (`resources/recovery/index.html`, no script) filled in by main: language, theme, wording
 * and the exit reason code. Every value is escaped, and the reason is cut down to a code-like token (it is shown, never logged with anything else).
 * The "Load Again" button is a link to `RECOVERY_RELOAD_URL`; main's `will-navigate` handler (which refuses every other navigation of the window)
 * recognises it with `isRecoveryReload` and loads the app again.
 */
import { join } from 'node:path'
import type { Locale } from '@shared/locale.js'
import type { Theme } from '@shared/theme.js'
import { nativeText } from './i18n-native.js'

/** The address the button points at. Never fetched: `will-navigate` is always cancelled for the window. `.invalid` can never resolve. */
export const RECOVERY_RELOAD_URL = 'https://recovery.aios.invalid/reload'

export function isRecoveryReload(url: string): boolean {
  return url === RECOVERY_RELOAD_URL
}

/** `<appPath>/resources/recovery/index.html` (the same place logic as Help). */
export function recoveryTemplatePath(appPath: string): string {
  return join(appPath, 'resources', 'recovery', 'index.html')
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

/** The exit reason as Electron reports it (`crashed`, `oom`, `launch-failed`, …): lower-case letters and hyphens only, else `unknown`. */
export function safeReason(reason: string): string {
  return /^[a-z][a-z-]{0,31}$/.test(reason) ? reason : 'unknown'
}

export interface RecoveryPageInput {
  readonly locale: Locale
  readonly theme: Theme
  readonly reason: string
}

/** The template with its slots filled in. Throws nothing: an unknown slot is left as it is. */
export function recoveryPageHtml(template: string, input: RecoveryPageInput): string {
  const values: Readonly<Record<string, string>> = {
    lang: input.locale,
    theme: input.theme,
    title: nativeText(input.locale, 'recovery.title'),
    body: nativeText(input.locale, 'recovery.body'),
    reload: nativeText(input.locale, 'recovery.reload'),
    reasonLabel: nativeText(input.locale, 'recovery.reason'),
    reason: safeReason(input.reason),
    reloadUrl: RECOVERY_RELOAD_URL
  }
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (name in values ? escapeHtml(values[name] ?? '') : whole))
}

/** A `data:` URL for the filled page (no file is written; the page has nothing to fetch). */
export function recoveryPageUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
