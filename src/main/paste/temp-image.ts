/**
 * Turns an image in an excluded temporary folder into an attachment, contents included (TODO 489, ARCHITECTURE.md 4.5 "Images without a path").
 *
 * When the thumbnail that appears at the lower right after Cmd+Shift+4 (screencaptureui) is dragged, the file is at
 * `/var/folders/…/T/TemporaryItems/NSIRD_screencaptureui_<id>/…png`. `/var` / `/private` /
 * `.TemporaryItems` fall under the exclusion rules (4.4.2, `common/exclusions.ts`), so `assertAllowed` refuses with
 * `path-excluded`. **The exclusion rules are not loosened** (the index scope 12.7 is not touched - plan (a) of owner decision 2026-10-06).
 * Instead, only for images in the temporary folder, the contents are read on the spot when the drop is received, and made into an attachment of the same
 * `kind: 'image'` (with base64) as a pasted image (item 319). It is not a path reference, so sending is not
 * affected even if screencaptureui deletes the temporary file right after the drop.
 *
 * What to keep:
 * - **Judge the temporary folder again after realpath.** If a symlink inside the temporary folder points to `~/.ssh` and the like,
 *   it is not handled here (the caller returns the original refusal `path-excluded`).
 * - Open the realpath's real file with `O_NOFOLLOW`. `fstat` the opened fd to confirm it is a regular file.
 * - **Whether it is an image is decided by the start of the contents (magic bytes)** - the extension is not looked at. Anything other than PNG / JPEG / GIF / WebP
 *   (types that can be sent to the model as is, the same set as `SENDABLE_TYPES` in `clipboard-image.ts`) is refused.
 * - The limit is `MAX_ATTACHMENT_BYTES`, the same as Drop's image attachment. If exceeded, it is refused (it cannot fall back to a path reference -
 *   excluded places are not made readable from the model either).
 * - **Never throws.** Failures are returned as reason codes (`attach-gone` / `attach-temp-not-image` / `attach-too-large` /
 *   `attach-unreadable`). The contents are not logged (only the path, the size and the type).
 */
import { constants, realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, sep } from 'node:path'
import type { AttachmentResolution } from '@shared/thread.js'
import { openNoFollow } from '../../common/os/open-flags.js'

/** How many leading bytes are used to see the type. WebP's `RIFF....WEBP` is 12 bytes. */
const SNIFF_BYTES = 16

/**
 * The roots of temporary folders. `/var` and `/tmp` are symlinks to `/private/…`, so both spellings are held
 * (also used when judging "it had disappeared" with the logical path before realpath). `os.tmpdir()` is usually
 * `/var/folders/<xx>/<yyyy>/T/`, which is inside `/var/folders`, but this is added for environments where `TMPDIR` was changed.
 */
export function defaultTemporaryRoots(): readonly string[] {
  const roots = ['/var/folders', '/private/var/folders', '/tmp', '/private/tmp']
  const base = tmpdir()
  roots.push(base)
  try {
    roots.push(realpathSync.native(base))
  } catch {
    // In an environment without tmpdir (should not happen), only the default roots.
  }
  return [...new Set(roots.map((root) => (root.length > 1 && root.endsWith(sep) ? root.slice(0, -1) : root)))]
}

/**
 * Whether `path` is inside a temporary folder. It is inside one of the roots, or has an element `TemporaryItems` / `.TemporaryItems`
 * (which macOS makes at the root of an external volume) along the way.
 */
export function isTemporaryPath(path: string, roots: readonly string[]): boolean {
  if (roots.some((root) => path.startsWith(`${root}${sep}`))) return true
  const parts = path.split(sep)
  // The last element (the file name) is not looked at.
  return parts.slice(0, -1).some((part) => part === 'TemporaryItems' || part === '.TemporaryItems')
}

/** Decides the image type from the leading bytes. null for a type that cannot be sent or something that is not an image. */
export function sniffImageType(head: Uint8Array): string | null {
  const at = (i: number): number => head[i] ?? -1
  if (
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return 'image/png'
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  const ascii = (from: number, to: number): string =>
    String.fromCharCode(...Array.from(head.subarray(from, Math.min(to, head.length))))
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** The number of leading bytes `sniffEmbeddableImage` looks at (callers read only this much). */
export const EMBEDDABLE_SNIFF_BYTES = 4096

/**
 * Decides, from the leading bytes, the MIME of an image that may be used for display and export (TODO 866 / 879). Shared by the conversation screen (876 / 550) and HTML export. Judging svg needs the leading `EMBEDDABLE_SNIFF_BYTES` (4096) bytes (Illustrator's DOCTYPE is long because of its internal subset).
 * png / jpeg / gif / webp go through `sniffImageType`; svg (a leading BOM, whitespace, and `<svg` after `<?xml`) / bmp / avif are handled here. null if it is not an image.
 */
export function sniffEmbeddableImage(data: Uint8Array): string | null {
  const known = sniffImageType(data.subarray(0, 16))
  if (known !== null) return known
  const latin = (from: number, to: number): string => Buffer.from(data.subarray(from, to)).toString('latin1')
  if (latin(0, 2) === 'BM' && data.byteLength >= 26) return 'image/bmp'
  if (latin(4, 8) === 'ftyp' && ['avif', 'avis'].includes(latin(8, 12))) return 'image/avif'
  const head = Buffer.from(data.subarray(0, EMBEDDABLE_SNIFF_BYTES)).toString('utf8').replace(/^\uFEFF/, '').trimStart()
  if (/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>[]*(?:\[[\s\S]*?\]\s*)?>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

/** The result of `readTemporaryImage`. For `not-temporary`, the caller returns the original refusal as is. */
export type TemporaryImageResult =
  | { readonly kind: 'not-temporary' }
  | { readonly kind: 'resolved'; readonly resolution: AttachmentResolution }

const NOT_TEMPORARY: TemporaryImageResult = { kind: 'not-temporary' }

function failed(reason: string): TemporaryImageResult {
  return { kind: 'resolved', resolution: { ok: false, reason } }
}

/**
 * If a path refused by the choke point (`assertAllowed`) is an image in a temporary folder, read it now and make it an attachment.
 * `path` is an absolute path already through `pathFromUri` (the logical path), and `uri` is the original URI from the renderer
 * (used as is as the attachment's identifier - sending goes along the `kind: 'image'` path that does not look at the path).
 */
export async function readTemporaryImage(
  path: string,
  uri: string,
  maxBytes: number,
  roots: readonly string[] = defaultTemporaryRoots()
): Promise<TemporaryImageResult> {
  let real: string
  try {
    real = await realpath(path)
  } catch (err) {
    // Not found inside the temporary folder = deleted right after the drop (screencaptureui cleaned it up).
    if (!isTemporaryPath(path, roots)) return NOT_TEMPORARY
    return failed((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'attach-gone' : 'attach-unreadable')
  }
  // Both the logical path and the real path must be inside the temporary folder (a symlink inside must not make it read outside).
  if (!isTemporaryPath(path, roots) || !isTemporaryPath(real, roots)) return NOT_TEMPORARY

  let handle
  try {
    handle = await openNoFollow(real, constants.O_RDONLY, { nonBlock: false })
  } catch (err) {
    return failed((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'attach-gone' : 'attach-unreadable')
  }
  try {
    const info = await handle.stat()
    if (info.isDirectory()) return failed('attach-directory')
    if (!info.isFile()) return failed('attach-unreadable')
    const head = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0)
    const mediaType = sniffImageType(head.subarray(0, bytesRead))
    if (mediaType === null) return failed('attach-temp-not-image')
    if (info.size > maxBytes) return failed('attach-too-large')
    const bytes = await handle.readFile()
    if (bytes.length > maxBytes) return failed('attach-too-large')
    return {
      kind: 'resolved',
      resolution: {
        ok: true,
        attachment: {
          uri,
          name: basename(path),
          kind: 'image',
          mediaType,
          base64: bytes.toString('base64'),
          bytes: bytes.length
        },
        // It takes the contents along, so the band for widening the reference scope is not shown (the temporary folder is not made readable).
        outsideAllowed: false,
        // TODO 591: an image in an excluded temporary folder cannot be kept by path (`isViewable` is false), so
        // main is on the side that keeps the reduced copy the renderer makes. The renderer may make it.
        keepsThumbnail: true
      }
    }
  } catch {
    return failed('attach-unreadable')
  } finally {
    await handle.close()
  }
}
