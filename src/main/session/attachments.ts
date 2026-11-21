/**
 * Attachments (4.5, TODO 578 (g)). Split out of `SessionManager`: validates the URIs the renderer passes on
 * Drop, paste and clip (`resolveAttachment`, including attaching an image from a temp folder by its contents),
 * builds the send text (`composeText`: image marks, `@path`, selection range), and builds the sent images
 * that accompany `user_text` (`sentAttachmentsPayload`).
 *
 * **`SessionManager` state is touched only through `AttachmentHost`**: same shape as `rewind.ts` /
 * `gateway-requests.ts`; the constructor of `manager.ts` builds thin closures that do not leak private members
 * and passes them in. `store` / `fs` are passed as the real objects. Behavior and logs (`attach.denied` /
 * `attach.temp-image` / `attach.temp-image.failed`) are the same as before the move.
 * TODO 1173: HEIC / HEIF is converted to JPEG with `sips` in `image/display.ts` and attached to the body
 * (`attach.heic` / `attach.heic.failed`).
 */
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, relative, resolve, sep } from 'node:path'
import { atReferenceOrPlain } from '@shared/at-reference.js'
import { attachmentMark } from '@shared/attachment-mark.js'
import type { SentAttachment } from '@shared/agent.js'
import type { AttachmentResolution, SendInput, Thread } from '@shared/thread.js'
import { CLIPBOARD_ATTACHMENT_PREFIX } from '@shared/thread.js'
import { PathDenied, pathDenialReason, pathFromUri } from '../../common/fs-policy.js'
import { log } from '../../common/logger.js'
import { foldPath, uriToPath } from '../../common/uri.js'
import type { FsAccess } from '../fs/access.js'
import { convertFileForAttachment, needsDisplayConversion } from '../image/display.js'
import type { ViewerImageConversion } from '@shared/plugin.js'
import { readTemporaryImage } from '../paste/temp-image.js'
import { sentAttachmentsOf } from './sent-attachments.js'
import type { ThreadStore } from './store.js'
import { formatSelection } from './viewer-tools.js'

/**
 * Upper limit for an attachable file. **Not a CLI limit**: base64 of 23 MB was also accepted (spike 3).
 * It is decided by aios's own concerns: the renderer -> main IPC, memory, and send time (4.5).
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

/** What `AttachmentService` borrows from `SessionManager` (a bundle of closures that do not leak private members). */
export interface AttachmentHost {
  readonly store: ThreadStore
  readonly fs: FsAccess
  /** The conversation's current working folder (the worktree if it has moved into one, TODO 633). */
  workingCwdOf(thread: Thread): string
}

/**
 * TODO 1173: the entry point that turns HEIC / HEIF into a JPEG the model can read. The default is the `sips`
 * conversion in `image/display.ts` (same flags, limit and orientation as the display). If the plain conversion
 * exceeds the attachment limit (8 MB), `display.ts` shrinks it exactly once with `-Z` (fixed pixel count)
 * (wave 75 review). Tests replace it.
 */
export type AttachmentImageConverter = (path: string) => Promise<ViewerImageConversion>

const defaultConverter: AttachmentImageConverter = (path) =>
  convertFileForAttachment(path, { tempDir: tmpdir(), shrinkAboveBytes: MAX_ATTACHMENT_BYTES })

export class AttachmentService {
  constructor(
    private readonly host: AttachmentHost,
    private readonly convertImage: AttachmentImageConverter = defaultConverter
  ) {}

  // ---- Attachments (4.5) ----

  async resolveAttachment(threadId: string, uri: string): Promise<AttachmentResolution> {
    const thread = this.host.store.getThread(threadId)
    if (thread === null) return { ok: false, reason: 'attach-no-thread' }

    let path: string
    try {
      // URIs from the renderer also go through FsService here (the one choke point of Phase 1).
      // The three entry points Drop, paste and clip (item 161) all pass through here.
      path = this.host.fs.assertAllowed(uri, false)
    } catch (err) {
      // An image in an excluded temp folder (dragging the ⌘⇧4 thumbnail, TODO 489) is not attached by path; it is
      // handled like an image whose contents were read and pasted just now (item 319). The exclusion rules are not relaxed (12.7).
      const temporary = await this.resolveTemporaryImage(err, uri)
      if (temporary !== null) return temporary
      // A choke point refusal is returned as a reason code (a gap in item 141: the clip can now select excluded targets).
      const reason = pathDenialReason(err)
      log.info('attach.denied', { reason, ...pathFieldOf(uri) })
      return { ok: false, reason }
    }

    let size = 0
    try {
      const stats = await stat(path)
      if (stats.isDirectory()) return { ok: false, reason: 'attach-directory' }
      size = stats.size
    } catch {
      return { ok: false, reason: 'attach-unreadable' }
    }

    const name = basename(path)
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    const mediaType = IMAGE_MEDIA_TYPES[ext] ?? null
    const outsideAllowed = !this.isWithinAllowed(thread, path)

    // TODO 1173: the model cannot read HEIC / HEIF (accepted images are JPEG / PNG / GIF / WebP). Convert to JPEG
    // only at attach time and put it in the body. The converted contents are kept nowhere (only put on the send, constraints 9 / 10).
    if (needsDisplayConversion(path)) return this.resolveConverted(path, uri, name, outsideAllowed)

    if (mediaType !== null) {
      if (size > MAX_ATTACHMENT_BYTES) {
        // Not a CLI limit but aios's own concern (4.5). Fall back to a path reference.
        return {
          ok: true,
          attachment: { uri, name, kind: 'reference', mediaType, bytes: size },
          outsideAllowed,
          // TODO 591: `kind: 'reference'` has no reduced version (it holds no base64).
          keepsThumbnail: false
        }
      }
      const buffer = await readFile(path)
      return {
        ok: true,
        attachment: {
          uri,
          name,
          kind: 'image',
          mediaType,
          base64: buffer.toString('base64'),
          bytes: size
        },
        outsideAllowed,
        // TODO 591: for a `file:` image that passed `assertAllowed`, main keeps only the path (`sent-attachments.ts`),
        // so the renderer's reduced version is discarded right after this.
        keepsThumbnail: false
      }
    }

    return {
      ok: true,
      attachment: { uri, name, kind: 'reference', mediaType: null, bytes: size },
      outsideAllowed,
      keepsThumbnail: false
    }
  }

  /**
   * HEIC / HEIF attachment (TODO 1173). Returns the contents converted to JPEG with `sips` as `kind: 'image'`.
   * Where `sips` is missing it is `attach-heic-unsupported`, a failed conversion is `attach-heic-failed`, and if the
   * result still exceeds the limit (8 MB) after shrinking with `-Z` it is `attach-too-large`
   * (a path reference to the HEIC itself cannot be read by the model, so unlike a large image it does not fall back to a path reference).
   */
  private async resolveConverted(path: string, uri: string, name: string, outsideAllowed: boolean): Promise<AttachmentResolution> {
    const conversion = await this.convertImage(path)
    if (!conversion.ok) {
      const reason =
        conversion.reason === 'unsupported-platform'
          ? 'attach-heic-unsupported'
          : conversion.reason === 'too-large'
            ? 'attach-too-large'
            : 'attach-heic-failed'
      log.info('attach.heic.failed', { path, reason })
      return { ok: false, reason }
    }
    if (conversion.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      log.info('attach.heic.failed', { path, reason: 'attach-too-large', bytes: conversion.bytes.byteLength })
      return { ok: false, reason: 'attach-too-large' }
    }
    // Do not write the contents. Only the path and the size.
    log.info('attach.heic', { path, bytes: conversion.bytes.byteLength })
    return {
      ok: true,
      attachment: {
        uri,
        name,
        kind: 'image',
        mediaType: conversion.contentType,
        base64: Buffer.from(conversion.bytes.buffer, conversion.bytes.byteOffset, conversion.bytes.byteLength).toString('base64'),
        bytes: conversion.bytes.byteLength
      },
      outsideAllowed,
      // It is a `file:` image, so only the path remains in the timeline (`sent-attachments.ts`). `aios-res://` converts it for display (TODO 1154).
      keepsThumbnail: false
    }
  }

  /**
   * If the URI the choke point refused is an image in a temp folder, returns the attachment made by reading its
   * contents (or the reason it could not be read) (TODO 489, `paste/temp-image.ts`). Returns null when it is not a temp
   * folder or the refusal is not an exclusion (the original refusal is returned).
   */
  private async resolveTemporaryImage(err: unknown, uri: string): Promise<AttachmentResolution | null> {
    if (!(err instanceof PathDenied) || (err.reason !== 'excluded' && err.reason !== 'symlink-escape')) return null
    let path: string
    try {
      path = pathFromUri(uri)
    } catch {
      return null
    }
    const result = await readTemporaryImage(path, uri, MAX_ATTACHMENT_BYTES)
    if (result.kind === 'not-temporary') return null
    const resolution = result.resolution
    if (resolution.ok) {
      // Do not write the contents. Only the path, size and type.
      log.info('attach.temp-image', {
        path,
        bytes: resolution.attachment.bytes,
        mediaType: resolution.attachment.mediaType
      })
    } else {
      log.info('attach.temp-image.failed', { path, reason: resolution.reason })
    }
    return resolution
  }

  private isWithinAllowed(thread: Thread, path: string): boolean {
    const folded = foldPath(resolve(path))
    const roots = [uriToPath(thread.cwdUri), ...thread.allowedDirUris.map(uriToPath)]
    return roots.some((root) => {
      const base = foldPath(resolve(root))
      return folded === base || folded.startsWith(base + sep)
    })
  }

  /**
   * Images that accompany `user_text` (TODO 550). If a `file:` image is in a place that can be viewed now (not hit by
   * an exclusion), only the path is kept; otherwise (paste, temp folder) the reduced version the renderer made is
   * re-validated and kept.
   */
  sentAttachmentsPayload(input: SendInput): { attachments?: readonly SentAttachment[] } {
    const attachments = sentAttachmentsOf(input.attachments, (uri) => {
      try {
        return this.host.fs.isViewable(uriToPath(uri))
      } catch {
        return false
      }
    })
    return attachments.length === 0 ? {} : { attachments }
  }

  /**
   * Builds the send text (4.5).
   * Images are attached to the body, so the same image is not passed twice as a path reference.
   */
  composeText(thread: Thread, input: SendInput): string {
    const lines: string[] = []
    const references: string[] = []
    for (const attachment of input.attachments ?? []) {
      if (attachment.kind === 'image') {
        // The shape of the mark is in `shared/attachment-mark.ts` (the renderer replaces it per display language, TODO 519).
        references.push(attachmentMark(attachment.name))
      } else if (attachment.uri.startsWith(CLIPBOARD_ATTACHMENT_PREFIX)) {
        // A pasted image (item 319) does not point at a file. If it arrives in a non-image shape (a renderer contract
        // violation) it cannot become a path reference, so drop it silently: passing it through `uriToPath` would fail the whole send.
        continue
      } else {
        // `@path` notation. A relative path is resolved against the thread's cwd.
        const path = uriToPath(attachment.uri)
        const cwd = this.host.workingCwdOf(thread)
        const rel = relative(cwd, path)
        const shown = rel !== '' && !rel.startsWith('..') ? rel : path
        references.push(atReferenceOrPlain(shown))
      }
    }
    if (references.length > 0) lines.push(references.join(' '))
    // The ViewerPane selection range (item 97). Put before the user's sentence (the "this" in "about this").
    if (input.selection !== undefined) {
      lines.push(formatSelection(input.selection, this.host.workingCwdOf(thread)))
    }
    if (input.text.trim() !== '') lines.push(input.text)
    return lines.join('\n')
  }
}

/** The path put in the log (TODO 489). A value that is not `file:` is not turned back into a path and is not logged (the rule: never write argument values). */
function pathFieldOf(uri: string): { path?: string } {
  try {
    return { path: pathFromUri(uri) }
  } catch {
    return {}
  }
}
