/**
 * The words of the boot notice (TODO 807, ARCHITECTURE 3.1 "launch order"), apart from the main dictionaries (`ja.ts` / `en.ts`) on
 * purpose: the boot entry is the first script of every window and runs before main is ready, so it stays a few kilobytes instead of
 * carrying both full dictionaries. Same rules as the main dictionaries (both languages, the same `{name}`s, `{app}` for the product
 * name); `test/renderer-boot.test.ts` checks them.
 *
 * `macKeychain` is shown on macOS only (wave 106 review Z5: the wait on the key is the macOS keychain's; on any other OS the notice is
 * the title alone).
 */
import type { Locale } from '@shared/locale.js'

export const BOOT_NOTICE: Readonly<Record<Locale, { readonly title: string; readonly macKeychain: string }>> = {
  ja: {
    title: '{app} を起動しています…',
    macKeychain:
      '保存してあるデータを開いています。macOS がキーチェーンの "{keychainItem}" を使うためにパスワードを求めている場合は、' +
      'ログインのパスワードを入れて「常に許可」を押してください。そのダイアログはほかの窓の裏に隠れていることがあります。'
  },
  en: {
    title: 'Starting {app}…',
    macKeychain:
      'Opening your saved data. If macOS asks for your login password to use “{keychainItem}” in your keychain, enter it and ' +
      'choose Always Allow. That dialog may be hidden behind other windows.'
  }
}
