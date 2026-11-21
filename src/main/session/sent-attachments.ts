/**
 * The form in which images attached to a sent message are kept in the timeline (TODO 550, wave 27 bundle F).
 *
 * - An image that points to a file (`file:`, in a place that can be viewed now = does not hit an exclusion) keeps **only the path**.
 *   It is read through `aios-res://` on every display (constraint 9: keep one copy of the body).
 * - An image with no file (a clipboard paste `aios-clipboard:`, or an image in an excluded temporary folder - TODO 489)
 *   keeps only the reduced version the renderer made (`Attachment.thumbnail`, 256 px on the long side), re-validated. The original size is not kept
 *   (owner decision 2026-10-09).
 *
 * The value comes from the renderer, so main re-validates the reduced version's shape (data URL, type, magic bytes) and size.
 * The same function is also passed through by `ThreadStore.toPersistable` (the save choke point).
 */
import type { SentAttachment } from '@shared/agent.js'
import type { Attachment } from '@shared/thread.js'

/** Long side of the reduced version (px). The same value as the renderer's `attachment-thumbnail.ts`. */
export const SENT_THUMBNAIL_EDGE = 256

/**
 * Upper bound of the reduced version (bytes after decoding). A 256 px WebP / JPEG fits in 10-40 KB. Even a PNG (with transparency)
 * at 256 px is roughly around 100 KB. A value above this is not a 256 px reduced version, so it is dropped.
 */
export const MAX_THUMBNAIL_BYTES = 160 * 1024

/** Upper bound on the number of images kept per message (beyond that, even the name is not kept). */
const MAX_SENT_ATTACHMENTS = 20
/** Upper bound on the length of a name (characters). */
const MAX_NAME = 255

const DATA_URL = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/

function magicMatches(type: string, bytes: Buffer): boolean {
  switch (type) {
    case 'png':
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case 'jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'webp':
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
        bytes.subarray(8, 12).toString('latin1') === 'WEBP'
      )
    default:
      return false
  }
}

/** Whether it may be accepted as a data URL of a reduced version. Checks shape, type, magic bytes, and size. */
export function isValidThumbnail(value: unknown): value is string {
  if (typeof value !== 'string') return false
  // base64 is 4/3 times larger. A length above the limit is refused before decoding.
  if (value.length > Math.ceil((MAX_THUMBNAIL_BYTES * 4) / 3) + 64) return false
  const match = DATA_URL.exec(value)
  if (match === null) return false
  const bytes = Buffer.from(match[2] ?? '', 'base64')
  if (bytes.length === 0 || bytes.length > MAX_THUMBNAIL_BYTES) return false
  return magicMatches(match[1] ?? '', bytes)
}

/**
 * Send attachments -> the form kept in the timeline. Images only (path references already appear as `@path` in the body).
 * `isViewable` tells whether the `file:` URI is in a place that can be viewed now (does not hit an exclusion) - if it does (a temporary folder), fall back to the reduced version.
 */
export function sentAttachmentsOf(
  attachments: readonly Attachment[] | undefined,
  isViewable: (uri: string) => boolean
): SentAttachment[] {
  const out: SentAttachment[] = []
  for (const attachment of attachments ?? []) {
    if (attachment.kind !== 'image') continue
    if (out.length >= MAX_SENT_ATTACHMENTS) break
    const name = String(attachment.name ?? '').slice(0, MAX_NAME)
    const uri = typeof attachment.uri === 'string' ? attachment.uri : ''
    if (uri.startsWith('file:') && isViewable(uri)) {
      out.push({ name, uri })
      continue
    }
    const thumbnail = attachment.thumbnail
    out.push(isValidThumbnail(thumbnail) ? { name, thumbnail } : { name })
  }
  return out
}

/**
 * Re-validation at the save choke point (`toPersistable`). The payload is typed `SentAttachment[]`,
 * but just before saving the shape is narrowed once more (extra fields, broken reduced versions, and URIs other than `file:` are dropped).
 * `redactName` is the redaction applied to the name.
 */
export function persistableSentAttachments(
  value: unknown,
  redactName: (name: string) => string
): SentAttachment[] {
  if (!Array.isArray(value)) return []
  const out: SentAttachment[] = []
  for (const raw of value.slice(0, MAX_SENT_ATTACHMENTS)) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    if (typeof record['name'] !== 'string') continue
    const name = redactName(record['name'].slice(0, MAX_NAME))
    const uri = record['uri']
    const thumbnail = record['thumbnail']
    if (typeof uri === 'string' && uri.startsWith('file:')) out.push({ name, uri })
    else if (isValidThumbnail(thumbnail)) out.push({ name, thumbnail })
    else out.push({ name })
  }
  return out
}
