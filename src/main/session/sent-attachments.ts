/**
 * The form in which images attached to a sent message are kept in the timeline (TODO 550, wave 27 bundle F).
 *
 * - An image that points to a file (`file:`, in a place that can be viewed now = does not hit an exclusion) keeps **only the path**.
 *   It is read through `aios-res://` on every display (constraint 9: keep one copy of the body).
 * - An image with no file (a clipboard paste `aios-clipboard:`, or an image in an excluded temporary folder - TODO 489)
 *   keeps only the reduced version the renderer made (`Attachment.thumbnail`, up to 1600 px on the long side, 600 KB), re-validated. The original size is not kept
 *   (owner decision 2026-10-09).
 *
 * The value comes from the renderer, so main re-validates the reduced version's shape (data URL, type, magic bytes) and size.
 * The same function is also passed through by `ThreadStore.toPersistable` (the save choke point).
 */
import { MAX_SENT_ATTACHMENTS, MAX_THUMBNAIL_BYTES, MAX_THUMBNAIL_DATA_URL_CHARS, THUMBNAIL_EDGE } from '@shared/attachment-thumbnail.js'
import type { SentAttachment } from '@shared/agent.js'
import type { Attachment } from '@shared/thread.js'

// TODO 1325: the long side (1600 px) and the byte cap (600 KB) live in `shared/attachment-thumbnail.ts`, shared with the renderer.
// Old rows keep their 256 px copies, which are far under the cap and still validate.
export { MAX_THUMBNAIL_BYTES, THUMBNAIL_EDGE as SENT_THUMBNAIL_EDGE }

/** Upper bound on the number of images kept per message (beyond that, even the name is not kept). */
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
  if (value.length > MAX_THUMBNAIL_DATA_URL_CHARS) return false
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
