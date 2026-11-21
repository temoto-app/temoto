/**
 * Pure functions for the "recent files" popup and the recent-file badges (TODO 999 / 1172). Independent of the DOM and React
 * (`test/recent-files-renderer.test.ts`).
 */
import type { AiosApi } from '@shared/ipc.js'
import type { FileChangeBatch } from '@shared/types.js'
import { recentKindOf, RECENT_OFFER_MAX, RECENT_OFFER_MS, type RecentFile } from '@shared/recent-files.js'
import { displayPath, fullPath } from '@shared/uri.js'

/**
 * The "recent" entry point (`window.aios.recent`). The parts that are always in the Composer (the badges, an empty `@`) use it, so
 * to avoid breaking rendering in fake bridges without the entry point (other tests that render the Composer), it is null when absent.
 */
export function recentBridge(): Partial<AiosApi['recent']> | null {
  const bridge = (window.aios as Partial<AiosApi> | undefined)?.recent
  return bridge ?? null
}

/** Subscribe to watch diffs. Does nothing if the entry point is absent (same reason as above). */
export function subscribeFileChanges(listener: (batch: FileChangeBatch) => void): () => void {
  const fs = (window.aios as Partial<AiosApi> | undefined)?.fs as Partial<AiosApi['fs']> | undefined
  return typeof fs?.onFileChanges === 'function' ? fs.onFileChanges(listener) : () => {}
}

/** Whether a watch diff has a create / update of a file that could be listed under "recent" (the signal to reload while the popup is open). */
export function batchTouchesRecent(batch: FileChangeBatch): boolean {
  return batch.changes.some(
    (change) =>
      change.type !== 'delete' &&
      change.entry !== null &&
      !change.entry.isDirectory &&
      !change.entry.name.startsWith('.') &&
      recentKindOf(change.entry.ext) !== null
  )
}

/**
 * Wave 75 review: the signal to ask for the badges again. True only when, among the creates / updates that hit `batchTouchesRecent`, one has an mtime newer than
 * the badge window (`now - RECENT_OFFER_MS`) and is not a dismissed badge (`offerKey`). So that main (the index scan + git status) is not
 * asked again on every AI edit or scan diff: a diff with an old mtime, or a rewrite of a dismissed file, would not change the badges even if asked again.
 */
export function batchTouchesOffers(batch: FileChangeBatch, now: number, dismissed: ReadonlySet<string>): boolean {
  return batch.changes.some(
    (change) =>
      change.type !== 'delete' &&
      change.entry !== null &&
      !change.entry.isDirectory &&
      !change.entry.name.startsWith('.') &&
      recentKindOf(change.entry.ext) !== null &&
      now - change.entry.mtimeMs <= RECENT_OFFER_MS &&
      !dismissed.has(offerKey(change.entry))
  )
}

/** The tile's "location" (the parent folder; home is `~`). */
export function recentLocation(file: Pick<RecentFile, 'parentUri'>, homeUri: string): string {
  return homeUri === '' ? fullPath(file.parentUri) : displayPath(file.parentUri, homeUri)
}

/** Whether the badge may still be shown (not past 5 minutes, not dismissed, not already attached). */
export function offerVisible(
  offer: Pick<RecentFile, 'uri' | 'mtimeMs'> | null,
  now: number,
  dismissed: ReadonlySet<string>,
  attachedUris: readonly string[]
): boolean {
  if (offer === null) return false
  if (now - offer.mtimeMs > RECENT_OFFER_MS) return false
  if (dismissed.has(offerKey(offer))) return false
  return !attachedUris.includes(offer.uri)
}

/**
 * TODO 1172: of the badge candidates main returned (newest first, up to `RECENT_OFFER_FETCH`), the first `RECENT_OFFER_MAX` that may still be shown,
 * in order. Filter first, then cut (wave 75 review: main cut at 3, so dismissing 3 meant the 4th was never shown).
 */
export function visibleOffers<T extends Pick<RecentFile, 'uri' | 'mtimeMs'>>(
  offers: readonly T[],
  now: number,
  dismissed: ReadonlySet<string>,
  attachedUris: readonly string[]
): T[] {
  return offers.filter((offer) => offerVisible(offer, now, dismissed, attachedUris)).slice(0, RECENT_OFFER_MAX)
}

/** The time at which the earliest badge passes 5 minutes (to re-show at that point). null if none. */
export function nextOfferExpiry(offers: readonly Pick<RecentFile, 'mtimeMs'>[]): number | null {
  if (offers.length === 0) return null
  return Math.min(...offers.map((offer) => offer.mtimeMs)) + RECENT_OFFER_MS
}

/**
 * The key of a dismissed / attached badge. TODO 1172 made it the URI alone (999 used URI + mtime so "a re-taken image is shown again").
 * Badges now also show code and documents, and every time the AI rewrote the same file a badge dismissed with ✕ came back.
 * A screenshot's name contains the time, so a re-take appears under a different URI.
 */
export function offerKey(offer: Pick<RecentFile, 'uri'>): string {
  return offer.uri
}
