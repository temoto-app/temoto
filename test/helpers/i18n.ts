// TODO 1254: the renderer's dictionary text writes the product name as `{app}`, and `translate` fills it in. Tests that compare
// a string shown on screen with a dictionary value use the dictionaries here, with `{app}` filled in (the other placeholders of `translate` stay as they are).
import { en as rawEn } from '../../src/renderer/src/i18n/en.js'
import { ja as rawJa, type Messages } from '../../src/renderer/src/i18n/ja.js'
import { PRODUCT_NAME } from '../../src/shared/product.js'

function withProductName(table: Messages): Messages {
  return Object.fromEntries(Object.entries(table).map(([key, text]) => [key, text.replace(/\{app\}/g, PRODUCT_NAME)])) as Messages
}

export const en: Messages = withProductName(rawEn)
export const ja: Messages = withProductName(rawJa)
