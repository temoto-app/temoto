/**
 * Item 225 (wave 14 bundle S): pure functions that extend the way to tell apart a window started with a non-default userData
 * (item 192), from just the band (`InstanceBanner`) to the product name (titlebar) and `document.title` as well.
 * Called from `App.tsx`. If `userDataLabel` is null (the default userData), nothing is changed.
 */
import type { Translate } from './i18n/index.js'

/** The product name at the top left of the titlebar. For the default it stays `baseName`; for a duplicate the Japanese word for "(duplicate)" is appended. */
export function productNameFor(t: Translate, baseName: string, userDataLabel: string | null): string {
  if (userDataLabel === null) return baseName
  return t('app.productName.duplicate', { name: baseName })
}

/** The string to set as `document.title`. For the default (userDataLabel === null) it is null (the caller leaves it alone). */
export function windowTitleFor(t: Translate, baseName: string, userDataLabel: string | null): string | null {
  if (userDataLabel === null) return null
  return t('app.title.duplicate', { name: baseName, path: userDataLabel })
}
