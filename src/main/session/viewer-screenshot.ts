/**
 * TODO 1061 (1): turns the ViewerPane's rendering into an image and gives it to the AI (the gateway's `getViewerScreenshot`, ARCHITECTURE 7.6.2).
 * **Does not import electron** - the image is received in the form of `NativeImage` (`NativeImageLike`), and tests pass a fake. What this holds:
 *
 *   - The dimensions shrunk to the size limit (`MAX_SCREENSHOT_EDGE`, 1568px on the long side) (`fitWithin`).
 *   - How to choose PNG or JPEG, and the byte limit (`encodeScreenshot`).
 *   - The fixed JS that takes the file viewer's rectangle from the renderer's DOM (`VIEWER_RECT_SCRIPT`), and validation of the returned value
 *     (`viewerCaptureRect`, CSS px -> DIP, clamped inside the window). There is no entry point that lets a plugin or the AI write JS.
 *
 * The image is only returned, and neither saved nor logged (the log goes only as far as size and format).
 */

import { MAX_SCREENSHOT_IMAGE_BYTES } from '../../shared/screenshot.js'

/** Upper limit of the long side (px). Matched to the model's image guideline (a larger image is just shrunk on their side). */
export const MAX_SCREENSHOT_EDGE = 1568

/** The upper limit for passing as PNG (bytes). Beyond it, JPEG is used (PNG is large for photo-heavy pages). The same single value as the gateway's limit (58-8). */
export const MAX_SCREENSHOT_PNG_BYTES = MAX_SCREENSHOT_IMAGE_BYTES

/** The JPEG quality steps (tried from the front; the first that fits `MAX_SCREENSHOT_JPEG_BYTES`). */
export const SCREENSHOT_JPEG_QUALITIES = [80, 60, 45] as const

/** The JPEG upper limit (bytes). If still exceeded at the last step, the edge is shrunk and tried again (`SCREENSHOT_SHRINK_RATIO`). Smaller than the gateway's limit. */
export const MAX_SCREENSHOT_JPEG_BYTES = 768 * 1024

/** The shrink ratio of the edge when JPEG exceeds the limit even at the last quality step. */
export const SCREENSHOT_SHRINK_RATIO = 0.75

/** The lower limit of the long side that may be shrunk to (px). If still too large below this, give up (null). */
export const MIN_SCREENSHOT_EDGE = 256

/** The number of the isolated world run in the renderer's DOM (a different number from the body reading of 1052). */
export const VIEWER_RECT_WORLD_ID = 1061

/** The part of electron's `NativeImage` used here. */
export interface NativeImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): NativeImageLike
  toPNG(): Uint8Array
  toJPEG(quality: number): Uint8Array
}

export interface EncodedScreenshot {
  /** base64 (without the data URL head, the MCP image form). */
  readonly data: string
  readonly mimeType: 'image/png' | 'image/jpeg'
  readonly width: number
  readonly height: number
  /** The size before shrinking (px). */
  readonly originalWidth: number
  readonly originalHeight: number
}

/** If the long side exceeds `max`, the dimensions shrunk keeping the ratio. Otherwise unchanged. Both are integers of 1 or more. */
export function fitWithin(size: { width: number; height: number }, max = MAX_SCREENSHOT_EDGE): { width: number; height: number } {
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  const long = Math.max(width, height)
  if (long <= max) return { width, height }
  const scale = max / long
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Shrinks the captured image to the limit and makes it PNG (if small) or JPEG. null for an empty image. */
export function encodeScreenshot(image: NativeImageLike): EncodedScreenshot | null {
  if (image.isEmpty()) return null
  const original = image.getSize()
  if (!(original.width > 0 && original.height > 0)) return null
  const target = fitWithin(original)
  const sized =
    target.width === original.width && target.height === original.height
      ? image
      : image.resize({ width: target.width, height: target.height, quality: 'good' })
  const size = sized.getSize()
  const base = { width: size.width, height: size.height, originalWidth: original.width, originalHeight: original.height }
  const png = sized.toPNG()
  if (png.byteLength > 0 && png.byteLength <= MAX_SCREENSHOT_PNG_BYTES) {
    return { ...base, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }
  }
  // If it exceeds the limit even after trying all quality steps, shrink the edge and try again (from the original image). Give up if it still exceeds at the lower limit (58-8).
  let current = sized
  let { width: w, height: h } = size
  for (;;) {
    let jpeg: Uint8Array = new Uint8Array()
    for (const quality of SCREENSHOT_JPEG_QUALITIES) {
      jpeg = current.toJPEG(quality)
      if (jpeg.byteLength <= MAX_SCREENSHOT_JPEG_BYTES) break
    }
    if (jpeg.byteLength === 0) return null
    if (jpeg.byteLength <= MAX_SCREENSHOT_JPEG_BYTES) {
      const out = current.getSize()
      return { ...base, width: out.width, height: out.height, data: Buffer.from(jpeg).toString('base64'), mimeType: 'image/jpeg' }
    }
    w = Math.max(1, Math.round(w * SCREENSHOT_SHRINK_RATIO))
    h = Math.max(1, Math.round(h * SCREENSHOT_SHRINK_RATIO))
    if (Math.max(w, h) < MIN_SCREENSHOT_EDGE) return null
    current = image.resize({ width: w, height: h, quality: 'good' })
  }
}

/**
 * The rectangle (CSS px) of the viewer currently visible in the ViewerPane. If a temporary view (`.viewer-transient`) is shown, that comes first;
 * otherwise the visible `.viewer-pane` (the hidden one has size 0 via `display: none`). null if none is found.
 */
export const VIEWER_RECT_SCRIPT = `(() => {
  for (const el of document.querySelectorAll('.viewer-transient, .viewer-pane')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, width: r.width, height: r.height }
  }
  return null
})()`

export interface CaptureRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Validates the rectangle (CSS px) returned from the renderer, converts it to DIP with the window's zoom, and fits it inside the window's content area. null if the shape is wrong or the size is 0.
 * The renderer is our own code, but main is supposed not to trust returned values (item 86).
 */
export function viewerCaptureRect(raw: unknown, zoom: number, content: { width: number; height: number }): CaptureRect | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const values = [record['x'], record['y'], record['width'], record['height']]
  if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) return null
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const [x, y, width, height] = values.map((value) => value * factor) as [number, number, number, number]
  const left = Math.max(0, Math.floor(x))
  const top = Math.max(0, Math.floor(y))
  const right = Math.min(Math.max(0, content.width), Math.ceil(x + width))
  const bottom = Math.min(Math.max(0, content.height), Math.ceil(y + height))
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The reason it could not be captured. */
export type ScreenshotFailure =
  /** The window or view closed. */
  | 'closed'
  /** The pane is hidden (a cover or mid-switch), or the visible viewer cannot be found. */
  | 'hidden'
  /** Captured but empty (nothing drawn). */
  | 'empty'
  /** Failed partway through capturing. */
  | 'failed'

export type ScreenshotOutcome =
  | ({ readonly ok: true; readonly url?: string } & EncodedScreenshot)
  | { readonly ok: false; readonly reason: ScreenshotFailure }
