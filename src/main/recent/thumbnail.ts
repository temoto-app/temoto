/**
 * Thumbnails (TODO 999) for the "Recent" popup and the recent-file badge (TODO 1172). Images, videos and PDFs only.
 *
 * It uses electron's `nativeImage.createThumbnailFromPath` (QuickLook on macOS - it returns one frame of a video and the first page of a PDF).
 * This file does not import electron; the way of fetching (`load`) is received from outside (the same shape as `fs/app-icon.ts`).
 *
 * - **A URI from the renderer is re-checked**: the choke point (`assertAllowed`, read), the extension (`hasRecentThumbnail`), and `lstat` for
 *   a regular file (symlinks and FIFOs are not followed). If any fails, null. **Never throws.**
 * - Cached by path + mtime. The limits are both a count (`MAX_THUMBNAILS`) and the total size of the pictures obtained (data URLs) (`MAX_THUMBNAIL_BYTES`),
 *   and the oldest are dropped first (wave 75 review: 1172 made a side 384 px so one picture became 4 times larger, and the count alone could exceed 100 MB).
 *   A second request while one is being fetched gets the same Promise.
 */
import { lstatSync } from 'node:fs'
import { basename } from 'node:path'
import { hasRecentThumbnail } from '@shared/recent-files.js'
import { log, errorFields } from '../../common/logger.js'
import type { PathAccess } from '../../common/fs-policy.js'

export const MAX_THUMBNAILS = 400
/** Upper limit on the total of the pictures obtained (characters of the data URL ~ bytes). A little over 100 PNGs of 384 px. */
export const MAX_THUMBNAIL_BYTES = 32 * 1024 * 1024
/**
 * One side of a thumbnail (px). The popup's tile is 192 px (twice 999's 96 px in TODO 1172), so 2x for Retina.
 * The big picture of a single-item badge (`.recent-offer.single`) is also fine at this size.
 */
export const THUMBNAIL_SIZE = 384

export type ThumbnailLoader = (path: string) => Promise<string | null>

interface Cached {
  readonly mtimeMs: number
  readonly image: Promise<string | null>
  /** Size of the picture obtained. 0 while it is being fetched, and for null. */
  bytes: number
}

export class ThumbnailCache {
  private readonly entries = new Map<string, Cached>()
  private totalBytes = 0

  constructor(
    private readonly fs: { assertAllowed(uri: string, asDirectory: boolean, access?: PathAccess): string },
    private readonly load: ThumbnailLoader,
    private readonly max: number = MAX_THUMBNAILS,
    private readonly maxBytes: number = MAX_THUMBNAIL_BYTES
  ) {}

  async thumbnailFor(uri: unknown): Promise<string | null> {
    if (typeof uri !== 'string') return null
    let path: string
    try {
      path = this.fs.assertAllowed(uri, false, 'read')
    } catch {
      return null
    }
    const name = basename(path)
    const dot = name.lastIndexOf('.')
    if (dot <= 0 || !hasRecentThumbnail(name.slice(dot + 1))) return null
    let mtimeMs: number
    try {
      const stats = lstatSync(path)
      if (!stats.isFile()) return null
      mtimeMs = stats.mtimeMs
    } catch {
      return null
    }
    const cached = this.entries.get(path)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      this.entries.delete(path)
      this.entries.set(path, cached)
      return cached.image
    }
    const image = this.load(path).catch((err: unknown) => {
      log.debug('recent.thumbnail.failed', { path, ...errorFields(err) })
      return null
    })
    const entry: Cached = { mtimeMs, image, bytes: 0 }
    this.remove(path)
    this.entries.set(path, entry)
    this.evict()
    void image.then((value) => {
      // An item that was dropped or re-fetched before it was obtained is not counted.
      if (value === null || this.entries.get(path) !== entry) return
      entry.bytes = value.length
      this.totalBytes += entry.bytes
      this.evict()
    })
    return image
  }

  get size(): number {
    return this.entries.size
  }

  /** The total size of the pictures currently remembered. */
  get bytes(): number {
    return this.totalBytes
  }

  private remove(path: string): void {
    const entry = this.entries.get(path)
    if (entry === undefined) return
    this.totalBytes -= entry.bytes
    this.entries.delete(path)
  }

  /** While over the count or size limit, drop the oldest (the one just added stays even if it alone exceeds the limit). */
  private evict(): void {
    while (this.entries.size > this.max || (this.totalBytes > this.maxBytes && this.entries.size > 1)) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.remove(oldest)
    }
  }
}

/**
 * TODO 1179: the width and height of PNG bytes (reads only the header's IHDR). null if it cannot be read.
 * `createThumbnailFromPath` (macOS QuickLook) makes the picture with the original aspect ratio, but the returned `NativeImage`'s `getSize()` is the square asked for
 * (384x384), and `toDataURL()` stretches to that square (a wide picture is squashed, a small picture is enlarged).
 * The real pixels are in `toPNG()`, so the data URL is built from there.
 */
export function pngDimensions(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24) return null
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(12) !== 0x49484452) return null
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** Only when the long side exceeds `max`, the size with the long side set to `max` keeping the aspect ratio. null if it already fits (no stretching). */
export function shrinkToFit(width: number, height: number, max: number = THUMBNAIL_SIZE): { width: number; height: number } | null {
  const longest = Math.max(width, height)
  if (longest <= max) return null
  const scale = max / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
