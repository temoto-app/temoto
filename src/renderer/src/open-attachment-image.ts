/**
 * Open an attached image in the ViewerPane (TODO 971, which overturned 461's "clicking opens nothing").
 *
 * - An image pointing at a file (`file://`) opens by URI as before (`select`). The exclusion / permission checks stay with the side that opens it (main).
 * - An image with no URI (a clipboard paste or a captured screen = `aios-clipboard:`) is **not written to a file**; the in-memory bytes are put into a
 *   temporary view (`store.openTransientFile`, the same entry point as the contents of `aios.zip`, 905).
 *   Neither saved nor indexed (constraints 9 / 10). For an already-sent message, only the shrunken version (256 px on the long side) remains, so that is opened.
 */
import type { SentAttachment } from '@shared/agent.js'
import type { Attachment } from '@shared/thread.js'
import { base64ToBytes } from './attachment-thumbnail.js'
import { useStore } from './store.js'

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg'
}

/** The viewer is looked up by extension, so if the image name has none, add one from the type (`png` if unknown). */
export function imageNameFor(name: string, mediaType: string | null): string {
  const base = name === '' ? 'image' : name
  if (/\.[A-Za-z0-9]{2,5}$/.test(base)) return base
  return `${base}.${EXTENSION_BY_TYPE[mediaType ?? ''] ?? 'png'}`
}

/** Split `data:<type>;base64,<payload>`. null for any other shape. */
export function parseImageDataUrl(url: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]*)$/.exec(url)
  if (match === null) return null
  try {
    return { mediaType: match[1]!, bytes: base64ToBytes(match[2]!) }
  } catch {
    return null
  }
}

/** Open an image from a Composer chip. false if it cannot be opened (no payload and no URI). */
export function openComposerImage(attachment: Attachment): boolean {
  if (attachment.uri.startsWith('file://')) {
    useStore.getState().select(attachment.uri)
    return true
  }
  if (attachment.base64 === undefined || attachment.base64 === '') return false
  try {
    const data = base64ToBytes(attachment.base64)
    useStore
      .getState()
      .openTransientFile({ name: imageNameFor(attachment.name, attachment.mediaType), source: '', data })
    return true
  } catch {
    return false
  }
}

/** Open an image from an already-sent message. The URI if it is a file, otherwise the shrunken version. false if it cannot be opened. */
export function openSentImage(attachment: SentAttachment): boolean {
  if (attachment.uri !== undefined) {
    useStore.getState().select(attachment.uri)
    return true
  }
  const parsed = attachment.thumbnail === undefined ? null : parseImageDataUrl(attachment.thumbnail)
  if (parsed === null) return false
  useStore
    .getState()
    .openTransientFile({ name: imageNameFor(attachment.name, parsed.mediaType), source: '', data: parsed.bytes })
  return true
}
