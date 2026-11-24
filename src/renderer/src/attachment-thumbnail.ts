/**
 * A reduced version of an image to send (TODO 550, wave 27 bundle F). To show a thumbnail in the timeline (your own message) after sending,
 * just before sending we make a data URL with a long edge of up to 1600 px (TODO 1325) from `Attachment.base64` and attach it as `Attachment.thumbnail`.
 *
 * Only for an image with no file (a pasted one, or one in an excluded temp folder) does main re-check this and keep it in the
 * encrypted DB (the full size is not kept: owner decision). An image pointing to a file keeps only the path, so what is made here is discarded.
 *
 * Shrinking uses `resizeWidth` / `resizeHeight` of `createImageBitmap` (decode and shrink outside main's JS thread),
 * and output is WebP via `OffscreenCanvas.convertToBlob` (keeps transparency, capped at 600 KB, stepping quality and size down to fit). If any of it is missing or
 * fails, we send without the reduced version (the timeline then shows only the name). Sending itself is not stopped.
 */
import { MAX_THUMBNAIL_BYTES, THUMBNAIL_EDGE, thumbnailAttempts, thumbnailSize } from '@shared/attachment-thumbnail.js'
import type { Attachment } from '@shared/thread.js'

export { THUMBNAIL_EDGE, thumbnailSize }

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return `data:${blob.type};base64,${btoa(binary)}`
}

/** The reduced version of one image. null if it cannot be made. */
export async function makeThumbnail(attachment: Attachment): Promise<string | null> {
  if (attachment.kind !== 'image' || attachment.base64 === undefined || attachment.base64 === '') return null
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null
  try {
    const blob = new Blob([base64ToBytes(attachment.base64)], { type: attachment.mediaType ?? 'image/png' })
    const full = await createImageBitmap(blob)
    const width = full.width
    const height = full.height
    full.close()
    // TODO 1325: try the best step first and step down until the output fits the byte cap (main refuses anything above it).
    for (const step of thumbnailAttempts(width, height)) {
      const size = thumbnailSize(width, height, step.edge)
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: 'high'
      })
      const canvas = new OffscreenCanvas(size.width, size.height)
      const context = canvas.getContext('2d')
      if (context === null) {
        bitmap.close()
        return null
      }
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      const out = await canvas.convertToBlob({ type: 'image/webp', quality: step.quality })
      // An environment that cannot write WebP returns PNG (the `type` differs). Main accepts PNG too.
      if (out.size <= MAX_THUMBNAIL_BYTES) return await blobToDataUrl(out)
    }
    return null
  } catch {
    return null
  }
}

/**
 * An array of the attachments with reduced versions added to the images. Non-images and ones that could not be made are left as they are.
 *
 * TODO 591: for `keepsThumbnail === false` (an image main decided to keep only the path of) we do not make one:
 * for a large image, decoding and writing the reduced version takes several hundred ms, and main just discards it, so it is wasted.
 * `keepsThumbnail` itself is an internal marker not sent to main, so it is dropped from the result in every branch.
 */
export async function withThumbnails(attachments: readonly Attachment[]): Promise<readonly Attachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      const { keepsThumbnail, ...rest } = attachment
      if (attachment.kind !== 'image' || attachment.thumbnail !== undefined || keepsThumbnail === false) {
        return rest
      }
      const thumbnail = await makeThumbnail(attachment)
      return thumbnail === null ? rest : { ...rest, thumbnail }
    })
  )
}
