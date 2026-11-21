/**
 * Exposes `THIRD_PARTY_NOTICES.md` to the renderer (TODO 438).
 *
 * `__AIOS_THIRD_PARTY_NOTICES_MD__` is filled in at build time by the `define` in `electron.vite.config.ts`,
 * which inlines the file contents as a string (same approach as `__AIOS_BUILD__`, see `src/main/build-info.ts`).
 * It is undefined when loaded without going through `define` (e.g. vitest), so check with `typeof` and fall back to an empty list.
 */
import { noticesForExtension, parseThirdPartyNotices, type ThirdPartyNotice } from '@shared/third-party-notices.js'

declare const __AIOS_THIRD_PARTY_NOTICES_MD__: string | undefined

const NO_NOTICES: readonly ThirdPartyNotice[] = []
let cache: { readonly source: string; readonly notices: readonly ThirdPartyNotice[] } | null = null

/**
 * The notices split per heading. Empty when undefined (the About section shows nothing). The split result is
 * remembered per source string (so About and the extension detail do not re-split 1,000 lines on every render).
 * Tests can set `globalThis.__AIOS_THIRD_PARTY_NOTICES_MD__` to feed it.
 */
export function thirdPartyNotices(): readonly ThirdPartyNotice[] {
  if (typeof __AIOS_THIRD_PARTY_NOTICES_MD__ === 'undefined') return NO_NOTICES
  const source = __AIOS_THIRD_PARTY_NOTICES_MD__
  if (cache === null || cache.source !== source) cache = { source, notices: parseThirdPartyNotices(source) }
  return cache.notices
}

/** The libraries bundled with that extension (TODO 459). */
export function extensionNotices(pluginId: string): readonly ThirdPartyNotice[] {
  return noticesForExtension(thirdPartyNotices(), pluginId)
}
