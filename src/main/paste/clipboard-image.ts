/**
 * Turns the clipboard image into an attachment (item 319, ARCHITECTURE.md 4.5 "Images without a path").
 *
 * A screenshot or the browser's "Copy image" **has no path** (`webUtils.getPathForFile`
 * returns `''`). The renderer only asks "attach the clipboard image", and main reads the bytes with
 * electron's `clipboard` (plan A - no MB-sized value is carried from the renderer to main, and there is no need to
 * re-validate values from the renderer).
 *
 * **Electron 44's `clipboard` has only a W3C-style asynchronous interface** (`read()` -> `ClipboardItem[]`,
 * `getType(mime)` -> `Blob`). The old `readImage()` / `NativeImage` interface does not exist (confirmed on 2026-10-02 by looking at
 * `Object.keys(clipboard)` in the real electron: clear,has,readText,writeText,read,write).
 *
 * The shape is the same `Attachment` as a Drop image attachment (`kind: 'image'`, with base64). The only difference is that `uri` is
 * a marker `aios-clipboard:` and does not point to a file. Sending goes along the existing `image` block path
 * (`SessionManager.send` -> Adapter), and what is saved is only a one-line note that an attachment with its name was added (the Japanese word for "attachment" and the name in parentheses) (constraints 9 / 10).
 *
 * **Never throws.** Empty or too large is returned as a reason code (`paste-empty` / `paste-too-large`).
 * The contents of the image are not logged.
 */
import { randomUUID } from 'node:crypto'
import { CLIPBOARD_ATTACHMENT_PREFIX, type AttachmentResolution } from '@shared/thread.js'

/** Only the part of electron's `ClipboardItem` that is used here (replaced in tests). */
export interface ClipboardImageItem {
  readonly types: readonly string[]
  getType(type: string): Promise<unknown>
}

/** Only the part of electron's `clipboard` that is used here. */
export interface ClipboardImageSource {
  read(): Promise<readonly ClipboardImageItem[]>
}

/**
 * Image types that can be sent to the model as is (the same set as Drop's `IMAGE_MEDIA_TYPES`). Earlier is preferred -
 * the same image is held in several types (a macOS screenshot has PNG and TIFF), so PNG is taken first.
 */
const SENDABLE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

async function bytesOf(value: unknown): Promise<Buffer | null> {
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'object' && value !== null && 'arrayBuffer' in value) {
    const read = (value as { arrayBuffer: unknown }).arrayBuffer
    if (typeof read === 'function') {
      const buffer: unknown = await (read as () => Promise<unknown>).call(value)
      if (buffer instanceof ArrayBuffer) return Buffer.from(buffer)
    }
  }
  return null
}

/**
 * Turns the current clipboard image into an attachment. `maxBytes` is the same limit as Drop's image attachment
 * (`MAX_ATTACHMENT_BYTES`). Drop turns an oversized image into a path reference, but there is no path here, so it is refused.
 * Anything other than PNG / JPEG / GIF / WebP (TIFF only, etc.) cannot be sent, so it is treated the same as "no image".
 * `name` is a provisional name - main, which does not know the display language, does not attach a numbered name (`paste.imageName`).
 */
export async function readClipboardImage(
  source: ClipboardImageSource,
  maxBytes: number
): Promise<AttachmentResolution> {
  let found: { mediaType: string; bytes: Buffer } | null = null
  try {
    const items = await source.read()
    outer: for (const mediaType of SENDABLE_TYPES) {
      for (const item of items) {
        if (!item.types.includes(mediaType)) continue
        const bytes = await bytesOf(await item.getType(mediaType))
        if (bytes !== null && bytes.length > 0) {
          found = { mediaType, bytes }
          break outer
        }
      }
    }
  } catch {
    return { ok: false, reason: 'paste-empty' }
  }
  if (found === null) return { ok: false, reason: 'paste-empty' }
  if (found.bytes.length > maxBytes) return { ok: false, reason: 'paste-too-large' }
  const extension = found.mediaType.slice('image/'.length).replace('jpeg', 'jpg')
  return {
    ok: true,
    attachment: {
      uri: `${CLIPBOARD_ATTACHMENT_PREFIX}${randomUUID()}`,
      name: `image.${extension}`,
      kind: 'image',
      mediaType: found.mediaType,
      base64: found.bytes.toString('base64'),
      bytes: found.bytes.length
    },
    // It does not point to a file, so the permission band for outside the reference scope is not shown.
    outsideAllowed: false,
    // TODO 591: it does not point to a file, so main keeps the renderer's reduced copy as is.
    keepsThumbnail: true
  }
}
