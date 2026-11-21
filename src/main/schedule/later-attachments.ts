/**
 * TODO 989: turn the attachments of "send later" back into `Attachment`s for sending, at send time.
 *
 * **They are kept as references and re-read at send time** (a default I decided myself within the owner's decision): hours can pass between scheduling and sending,
 * so a `file:` attachment is sent with the contents (and permission) at send time, not at scheduling time - it goes through the same `resolveAttachment` as a normal Drop,
 * so a file that hits an exclusion, disappeared, is too large, and so on is dropped for the same reasons. A dropped attachment is
 * discarded alone and the body is still sent (stopping even the body would mean nothing happens once the limit is lifted). Only a pasted image
 * (`aios-clipboard:`) has no file, so the base64 kept with the schedule is used as is.
 */
import type { LaterAttachment } from '@shared/schedule.js'
import type { Attachment, AttachmentResolution } from '@shared/thread.js'
import { CLIPBOARD_ATTACHMENT_PREFIX } from '@shared/thread.js'
import { log } from '../../common/logger.js'

export interface LaterAttachmentResolver {
  resolveAttachment(threadId: string, uri: string): Promise<AttachmentResolution>
}

export async function resolveLaterAttachments(
  resolver: LaterAttachmentResolver,
  threadId: string,
  stored: readonly LaterAttachment[]
): Promise<Attachment[]> {
  const result: Attachment[] = []
  for (const item of stored) {
    if (item.uri.startsWith(CLIPBOARD_ATTACHMENT_PREFIX)) {
      if (item.kind === 'image' && typeof item.base64 === 'string') {
        result.push({
          uri: item.uri,
          name: item.name,
          kind: 'image',
          mediaType: item.mediaType,
          base64: item.base64,
          bytes: item.bytes,
          ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail })
        })
      }
      continue
    }
    const resolution = await resolver.resolveAttachment(threadId, item.uri)
    if (resolution.ok) {
      // The reduced version (TODO 550): made by the renderer at scheduling time. main keeps it only for an image without a file.
      const thumbnail = item.thumbnail
      result.push(thumbnail === undefined ? resolution.attachment : { ...resolution.attachment, thumbnail })
    }
    else log.warn('schedule.later.attachment-dropped', { threadId, reason: resolution.reason })
  }
  return result
}
