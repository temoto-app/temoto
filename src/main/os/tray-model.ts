/**
 * Of the OS layer (TODO 986), the menu bar icon's menu as plain data (TODO 1269). **Does not import electron**: the order of the items, their labels and
 * whether they are enabled are decided here, so tests can check them; `tray.ts` turns the result into an electron `Menu`.
 *
 * Four things (owner decision 2026-11-20): show the window (open one if there is none), a new conversation, the number of pending approvals (the same
 * source as the Dock badge; with none it is a greyed row, and pressing it shows the window), and quit.
 */
import type { Locale } from '@shared/locale.js'
import { nativeFormat, nativeText } from '../i18n-native.js'

export type TrayAction = 'show' | 'newThread' | 'quit'

export type TrayMenuEntry =
  | { readonly kind: 'item'; readonly id: 'show' | 'newThread' | 'pending' | 'quit'; readonly label: string; readonly enabled: boolean; readonly action: TrayAction | null }
  | { readonly kind: 'separator' }

/** `pending` is the number of approvals waiting (any non-integer or negative value counts as none). */
export function trayMenuModel(locale: Locale, pending: number): readonly TrayMenuEntry[] {
  const count = Number.isInteger(pending) && pending > 0 ? pending : 0
  return [
    { kind: 'item', id: 'show', label: nativeText(locale, 'tray.show'), enabled: true, action: 'show' },
    { kind: 'item', id: 'newThread', label: nativeText(locale, 'tray.newThread'), enabled: true, action: 'newThread' },
    { kind: 'separator' },
    count > 0
      ? { kind: 'item', id: 'pending', label: nativeFormat(locale, 'tray.pending', { count }), enabled: true, action: 'show' }
      : { kind: 'item', id: 'pending', label: nativeText(locale, 'tray.pendingNone'), enabled: false, action: null },
    { kind: 'separator' },
    { kind: 'item', id: 'quit', label: nativeText(locale, 'menu.quit'), enabled: true, action: 'quit' }
  ]
}

/** One string that changes whenever the built menu would differ (so the tray rebuilds only then). */
export function trayMenuSignature(locale: Locale, pending: number): string {
  return JSON.stringify(trayMenuModel(locale, pending))
}
