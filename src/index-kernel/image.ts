/**
 * Finding images by their content (TODO 998): classification labels become words and are put into the full-text index.
 *
 * **The only Mac-specific part is here** (the same shape as `pdf.ts` for PDF): the Vision Swift helper (`tools/vision-helper/`,
 * `npm run build:vision` -> `out/vision-helper/vision-helper`) is kept resident as a **child process of the index process**, and
 * a one-line JSON header followed by the image's content bytes is passed on stdin. **No path is passed** (same as the review of TODO 1009).
 * The entry point's types do not depend on the OS (`src/common/os/image-analysis.ts`). In an environment without the helper (non-Mac / not built),
 * `imageAvailable()` is false and images are file-name only as before.
 *
 * Labels are stored as an attribute of the image in `documents.metadata.image` (owner decision 2026-11-13: small, and re-extraction is
 * expensive). The line of words put into the index can be rebuilt from the labels and the mapping table (`imageLabelText`), so search excerpts and a mapping-table version bump
 * do not re-run Vision. The reconciliation with constraint 9 is in ARCHITECTURE 6.2.7.
 */
import { existsSync } from 'node:fs'
import { isMac } from '../common/os/platform.js'
import type { ImageAnalysis, ImageAnalyzer, ImageAnalyzeOptions, ImageLabel } from '../common/os/image-analysis.js'
import {
  APPLE_VISION_BACKEND,
  IMAGE_TERMS_VERSION,
  imageBoostText,
  imageLabelText,
  labelsToKeep,
  sanitizeImageLabels,
  type ImageShape
} from '../common/image-labels/terms.js'
import { sanitizeDocKind, type ImageDocKind } from '../common/image-labels/receipt.js'
import { StdioHelper } from './helper-process.js'
import { addHelperCpuMicros } from './pace.js'

/**
 * Extensions of images whose content is analyzed (lowercase, no dot). `svg` is not included because its body is taken as text (`extract.ts`).
 * HEIC, WebP and AVIF are read by ImageIO as they are (spike 39).
 */
export const IMAGE_EXTENSIONS: readonly string[] = [
  'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'avif'
]
const IMAGE_EXTENSION_SET = new Set(IMAGE_EXTENSIONS)

export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSION_SET.has(ext)
}

/** Images whose longest side is below this are not classified (owner decision 2026-11-13, spike 39: at icon size the labels are wrong or only generic). */
export const IMAGE_MIN_SIDE = 128
/**
 * Upper bound on dimensions (security review of wave 84, decompression bomb). An image whose header dimensions exceed it is refused without decoding (`too-large`,
 * skipped). 16,384 px is a guide to what ImageIO and Core Graphics handle; 100 MP is 400 MB as RGBA.
 */
export const IMAGE_MAX_SIDE = 16_384
export const IMAGE_MAX_PIXELS = 100_000_000
/**
 * Size read for analysis (longest side). The helper does not decode all pixels; it reads shrunk down to this. Classification labels barely change when shrunk
 * (spike 39: Jaccard 0.92 at a longest side of 512 px). The OCR stage (not started) dropped text at 1600 px (bigram match median 0.93), so
 * a different value will be decided then.
 */
export const IMAGE_DECODE_SIDE = 2048
/**
 * Size read for OCR (longest side). Larger than for classification (2048): text was dropped at 1600 px (spike 39). For strips the helper reads
 * longer by the aspect ratio (up to 4x) and caps the pixel count at 36 MP. The header dimension limits (`IMAGE_MAX_*`) apply to OCR too.
 */
export const IMAGE_OCR_SIDE = 3072
/** Upper bound on OCR characters (the helper cuts at the same value, and it is checked here as well). Inside the 256 KB body limit (`MAX_EXTRACT_BYTES`). */
export const IMAGE_OCR_MAX_CHARS = 20_000
/** Images whose aspect ratio (long side / short side) exceeds this are not classified (shrinking would crush one side). OCR reads them as strips. */
export const IMAGE_STRIP_ASPECT = 10
/** Images whose aspect ratio exceeds this (lines, rules) get neither classification nor OCR. */
export const IMAGE_MAX_ASPECT = 40
/** Version of the OCR output. Raise it when the word table (`receipt.ts`) or the OCR settings change (stored OCR results are re-taken). */
export const IMAGE_OCR_VERSION = 1
/** Time per image (5 seconds as for PDF, and the same for OCR: owner decision 2026-11-13). When exceeded, the child is killed and the result is `corrupt`. Classification has a median of 5 to 6 ms, OCR 63 ms (spike 39). */
export const IMAGE_TIME_LIMIT_MS = 5_000
/**
 * Limit for the first OCR right after the helper is started (warm-up). The real Vision took 8.7 seconds for the first image only (loading the OCR model;
 * about 200 ms from the second on). With 5 seconds the first image would time out. After warm-up, the usual `IMAGE_TIME_LIMIT_MS`.
 */
export const IMAGE_OCR_WARMUP_MS = 30_000
/** Time until a child that is no longer used is ended. */
export const IMAGE_IDLE_MS = 60_000

/**
 * Version of the Vision helper's output. Raise it when the output shape or the label system changes (stored labels are no longer reused).
 * 2: aspect ratio above 10 is not classified (`strip`) and above 40 is out of scope (`shape`) (wave 85. Discards the labels of elongated images classified up to 0.84).
 */
export const VISION_HELPER_VERSION = 2

let current: ImageAnalyzer | null = null

/** Can images be analyzed in this environment? (is an analyzer configured) */
export function imageAvailable(): boolean {
  return current !== null
}

/** Sets the analyzer (null disables it). The previous one is disposed. */
export function setImageAnalyzer(analyzer: ImageAnalyzer | null): void {
  if (current !== null && current !== analyzer) current.dispose()
  current = analyzer
}

/** The configured analyzer. null if none. */
export function imageAnalyzer(): ImageAnalyzer | null {
  return current
}

/**
 * N of the version marker of an image row (`:vlN`). Analyzer version x 100,000 + the vocabulary and mapping table version (`IMAGE_TERMS_VERSION`, in units of 1,000).
 * 0 if there is no analyzer (no marker is added).
 */
export function imageIndexVersion(): number {
  return current === null ? 0 : current.version * 100_000 + (current.ocrVersion ?? 0) * 10_000 + IMAGE_TERMS_VERSION
}

/** Is there an analyzer that can do OCR? */
export function imageOcrAvailable(): boolean {
  return current !== null && current.ocrVersion !== undefined
}

/** Configures the analyzer from the helper's path. Disabled if there is no path, no file, or it is not a Mac. */
export function configureVisionHelper(helperPath: string | null | undefined): boolean {
  if (helperPath === null || helperPath === undefined || helperPath === '' || !isMac() || !existsSync(helperPath)) {
    setImageAnalyzer(null)
    return false
  }
  setImageAnalyzer(new VisionHelper(helperPath))
  return true
}

/**
 * `metadata.image` of an fs image row. `v` is the analyzer version, `backend` the label system, `at` the file's `mtime:size` at analysis time
 * (without the version marker), and `labels` the labels at or above `IMAGE_LABEL_KEEP_CONFIDENCE`. Not a body (constraint 9).
 */
export interface StoredImageLabels {
  readonly v: number
  readonly backend: string
  readonly at: string
  readonly labels: readonly ImageLabel[]
  /** Orientation of an image that was not classified because of an extreme aspect ratio (labels are empty). */
  readonly shape?: ImageShape
  /** Marker of the OCR result (the text itself is not stored: constraint 9). If absent, OCR has not happened yet (later, throttled). */
  readonly ocr?: StoredImageOcr
}

/** `documents.metadata.image.ocr`. `done` = there was text (re-extract and index it), `none` = there was no text, `failed` = unreadable or timed out. */
export interface StoredImageOcr {
  readonly v: number
  readonly state: 'done' | 'none' | 'failed'
  /** Result of judging a receipt / document from the OCR words (`receipt.ts`). So that the line of words can be built without re-reading the text. */
  readonly kind?: ImageDocKind
}

export function sanitizeStoredOcr(value: unknown): StoredImageOcr | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const v = record['v']
  const state = record['state']
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) return undefined
  if (state !== 'done' && state !== 'none' && state !== 'failed') return undefined
  const kind = sanitizeDocKind(record['kind'])
  return { v, state, ...(kind === null ? {} : { kind }) }
}

/** Extracts the stored labels from `documents.metadata` (JSON turned back into an object). null if the shape does not match. */
export function storedImageLabelsOf(metadata: Readonly<Record<string, unknown>>): StoredImageLabels | null {
  const raw = metadata['image']
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const v = record['v']
  const backend = record['backend']
  const at = record['at']
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) return null
  if (typeof backend !== 'string' || backend === '' || typeof at !== 'string') return null
  const shape = record['shape'] === 'wide' || record['shape'] === 'tall' ? record['shape'] : undefined
  const ocr = sanitizeStoredOcr(record['ocr'])
  return {
    v,
    backend,
    at,
    labels: sanitizeImageLabels(record['labels']),
    ...(shape === undefined ? {} : { shape }),
    ...(ocr === undefined ? {} : { ocr })
  }
}

/** Builds the stored form from an analysis result. */
export function toStoredImageLabels(
  analyzer: Pick<ImageAnalyzer, 'version' | 'backend'>,
  at: string,
  labels: readonly ImageLabel[],
  shape?: ImageShape
): StoredImageLabels {
  return {
    v: analyzer.version,
    backend: analyzer.backend,
    at,
    labels: labelsToKeep(labels),
    ...(shape === undefined ? {} : { shape })
  }
}

function termsOptionsOf(stored: StoredImageLabels): { kind: ImageDocKind | null; shape: ImageShape | null } {
  return { kind: stored.ocr?.kind ?? null, shape: stored.shape ?? null }
}

/** Builds the line of words for the index (chunk seq 0) from the stored labels (does not call Vision). */
export function storedImageText(stored: StoredImageLabels): string {
  return imageLabelText(stored.labels, stored.backend, termsOptionsOf(stored))
}

/** Repetition of high-confidence words added to the shadow column of the line of words (not put into the canonical text). */
export function storedImageBoost(stored: StoredImageLabels): string {
  return imageBoostText(stored.labels, stored.backend, termsOptionsOf(stored))
}

/**
 * Sanitizes OCR text: drops control characters (other than newline), trims each line, collapses blank lines into one, and cuts at the limit.
 * The helper's output is not trusted (length and character kinds are always capped here). **Not written to logs.**
 */
export function sanitizeOcrText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const lines: string[] = []
  for (const raw of value.replace(/\r\n?/g, '\n').split('\n')) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').trim()
    if (line === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue
    lines.push(line)
  }
  let text = lines.join('\n').trim()
  if (text.length > IMAGE_OCR_MAX_CHARS) {
    let end = IMAGE_OCR_MAX_CHARS
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end -= 1
    text = text.slice(0, end)
  }
  return text
}

class VisionHelper implements ImageAnalyzer {
  readonly backend = APPLE_VISION_BACKEND
  readonly version = VISION_HELPER_VERSION
  readonly ocrVersion = IMAGE_OCR_VERSION
  private readonly helper: StdioHelper

  constructor(helperPath: string) {
    this.helper = new StdioHelper(helperPath, { name: 'image', timeoutMs: IMAGE_TIME_LIMIT_MS, idleMs: IMAGE_IDLE_MS })
  }

  async analyze(data: Uint8Array, options: ImageAnalyzeOptions): Promise<ImageAnalysis> {
    const reply = await this.helper.request(
      {
        minConfidence: options.minConfidence,
        minSide: options.minSide,
        maxSide: options.maxSide,
        maxPixels: options.maxPixels,
        decodeSide: options.decodeSide,
        classify: options.classify ?? true,
        ocr: options.ocr ?? false,
        ocrSide: options.ocrSide ?? IMAGE_OCR_SIDE,
        ocrMaxChars: options.ocrMaxChars ?? IMAGE_OCR_MAX_CHARS,
        stripAspect: options.stripAspect ?? IMAGE_STRIP_ASPECT,
        maxAspect: options.maxAspect ?? IMAGE_MAX_ASPECT
      },
      data,
      // The first OCR per child has the long warm-up limit (model loading).
      options.ocr === true ? { warmKey: 'ocr', warmTimeoutMs: IMAGE_OCR_WARMUP_MS } : undefined
    )
    if (reply === null) return { ok: false, reason: 'timeout' }
    // The child's CPU time is counted toward the rest of the slow stage (since it is not included in the index process's `process.cpuUsage()`).
    const cpu = reply['cpuUs']
    if (typeof cpu === 'number' && Number.isFinite(cpu) && cpu > 0) addHelperCpuMicros(cpu)
    if (reply['ok'] !== true) {
      const error = reply['error']
      return {
        ok: false,
        reason: error === 'small' ? 'small' : error === 'large' ? 'large' : error === 'shape' ? 'shape' : 'corrupt'
      }
    }
    const width = reply['w']
    const height = reply['h']
    return {
      ok: true,
      width: typeof width === 'number' ? width : 0,
      height: typeof height === 'number' ? height : 0,
      labels: sanitizeImageLabels(reply['labels']),
      ...(reply['strip'] === true ? { strip: true } : {}),
      ...(options.ocr === true
        ? reply['ocrFailed'] === true || typeof reply['text'] !== 'string'
          ? { ocrFailed: true }
          : { text: sanitizeOcrText(reply['text']) }
        : {})
    }
  }

  dispose(): void {
    this.helper.dispose()
  }
}
