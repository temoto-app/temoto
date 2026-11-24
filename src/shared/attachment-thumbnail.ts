/**
 * The reduced copy kept for a sent image that has no file (TODO 1325). The renderer makes it just before sending and main
 * re-validates it, so both sides read the limits from here (one place, so they cannot drift apart).
 *
 * The copy was 256 px on the long side until 1325; opening it in the viewer looked blocky. It is now up to 1600 px
 * (WebP, quality 0.8) with a per-image byte cap. The original is still not kept (owner decision 2026-10-09 / 2026-11-23).
 */

/** The long edge (px) a reduced copy starts at. A smaller image is never enlarged. */
export const THUMBNAIL_EDGE = 1600

/** Upper bound of one reduced copy (bytes after decoding). The renderer steps down to fit; main refuses anything above. */
export const MAX_THUMBNAIL_BYTES = 600 * 1024

/** Upper bound on the number of images (and so reduced copies) kept per message. */
export const MAX_SENT_ATTACHMENTS = 20

/** The data URL prefix is at most `data:image/webp;base64,` (23 chars); the rest is slack for padding. */
const DATA_URL_SLACK = 64

/** Upper bound on the length (chars) of one reduced copy as a data URL: base64 is 4/3 of the bytes, plus the prefix. */
export const MAX_THUMBNAIL_DATA_URL_CHARS = Math.ceil((MAX_THUMBNAIL_BYTES * 4) / 3) + DATA_URL_SLACK

/** Worst case of all reduced copies of one message, in chars (about 16 M; the owner accepted this, 2026-11-23). */
export const MAX_THUMBNAILS_CHARS_PER_MESSAGE = MAX_THUMBNAIL_DATA_URL_CHARS * MAX_SENT_ATTACHMENTS

/** One encoding attempt: the long edge cap (px) and the WebP quality (0..1). */
export interface ThumbnailStep {
  readonly edge: number
  readonly quality: number
}

/**
 * The attempts in order, from the best to the smallest. The renderer takes the first one whose output fits `MAX_THUMBNAIL_BYTES`.
 * Quality drops first at full size, then the edge shrinks (text-heavy screenshots compress poorly).
 */
export const THUMBNAIL_STEPS: readonly ThumbnailStep[] = [
  { edge: THUMBNAIL_EDGE, quality: 0.8 },
  { edge: THUMBNAIL_EDGE, quality: 0.6 },
  { edge: 1280, quality: 0.6 },
  { edge: 1024, quality: 0.5 },
  { edge: 800, quality: 0.5 },
  { edge: 512, quality: 0.4 },
  { edge: 256, quality: 0.4 }
]

/** The size after shrinking. Keeps the aspect ratio and does not enlarge small images. */
export function thumbnailSize(width: number, height: number, edge = THUMBNAIL_EDGE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: edge, height: edge }
  const scale = Math.min(1, edge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * The steps worth trying for an image of this size. A step is dropped when it would give the same pixel size as the previous
 * kept step at the same or a higher quality (a small image gains nothing from the edge steps). Always returns at least one step.
 */
export function thumbnailAttempts(width: number, height: number): readonly ThumbnailStep[] {
  const out: ThumbnailStep[] = []
  let last: { width: number; height: number; quality: number } | null = null
  for (const step of THUMBNAIL_STEPS) {
    const size = thumbnailSize(width, height, step.edge)
    if (last !== null && last.width === size.width && last.height === size.height && last.quality <= step.quality) continue
    out.push(step)
    last = { ...size, quality: step.quality }
  }
  return out
}
