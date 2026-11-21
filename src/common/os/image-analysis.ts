/**
 * OS layer for analyzing the contents of an image (TODO 998, ARCHITECTURE 6.2.7). **An OS-independent shape**: "image bytes -> classification labels
 * (with confidence) + OCR text". On Mac it is the Swift helper using Vision (`src/index-kernel/image.ts` calls it in a child process),
 * and on Windows (TODO 899) the same type is to be returned by ONNX classification. Label identifiers differ per backend, and
 * the mapping tables to aios's shared vocabulary (`src/common/image-labels/`) fold them into Japanese words.
 *
 * Classification (median 5-6 ms) and OCR (median 63 ms, worst case seconds) are separated per request (stage 2: classify all images first, then OCR
 * later in a thinned pass, newest first). The OCR text is **not stored** (constraint 9; it is extracted again).
 * It does not import electron (used in the index process; constraint 8.1).
 */

/** One label: the backend's identifier and a confidence (0-1, rounded to 3 digits). */
export type ImageLabel = readonly [id: string, confidence: number]

export type ImageAnalysis =
  | {
      readonly ok: true
      readonly width: number
      readonly height: number
      /** Labels whose confidence is at least `minConfidence` (in the order the backend returned them). Empty if not classified. */
      readonly labels: readonly ImageLabel[]
      /**
       * A very elongated image whose aspect ratio exceeds `stripAspect` (banner, stitched screens). Shrinking it crushes one side and the labels become unreliable,
       * so it is not classified (`labels` is empty). OCR reads it as a strip.
       */
      readonly strip?: boolean
      /** The text when OCR was requested (empty if unreadable). Cut at the limit `ocrMaxChars`. Absent if OCR failed (`ocrFailed`). */
      readonly text?: string
      /** OCR was requested but failed (not unreadable or timed out: the helper returned a failure). */
      readonly ocrFailed?: boolean
    }
  | {
      readonly ok: false
      /**
       * `small`: the longest side is under `minSide` (not classified). `large`: the dimensions exceed `maxSide` / `maxPixels` (a decompression bomb is not
       * expanded). `shape`: the aspect ratio exceeds `maxAspect` (a line-like image; neither classified nor OCRed). `corrupt`: the helper said it cannot read it.
       * `timeout`: no response (timed out or the helper exited abnormally). It is not necessarily the image's fault - callers may treat it as a transient failure.
       */
      readonly reason: 'small' | 'large' | 'shape' | 'corrupt' | 'timeout'
    }

export interface ImageAnalyzeOptions {
  /** Labels with confidence below this are not returned. */
  readonly minConfidence: number
  /** An image whose longest side is below this is not classified (`small`). */
  readonly minSide: number
  /** An image whose longest side exceeds this is not expanded (`large`). */
  readonly maxSide: number
  /** An image whose pixel count (width x height) exceeds this is not expanded (`large`). */
  readonly maxPixels: number
  /** The size read for analysis (longest side, px). It is shrunk to this instead of expanding every pixel. */
  readonly decodeSide: number
  /** Whether to classify (default true). false when requesting only OCR (the stored labels are reused). */
  readonly classify?: boolean
  /** Whether to do OCR (default false). Japanese + English, high accuracy. It is heavy (median 63 ms, worst case seconds), so it is requested later in a thinned pass. */
  readonly ocr?: boolean
  /** The size read for OCR (longest side, px). Larger than for classification (at 1600 px characters were missed - spike 39). A strip is read longer by its aspect ratio. */
  readonly ocrSide?: number
  /** Upper bound on the OCR character count (cut when exceeded). */
  readonly ocrMaxChars?: number
  /** An image whose aspect ratio (long side / short side) exceeds this is not classified (`strip`). */
  readonly stripAspect?: number
  /** An image whose aspect ratio exceeds this is neither classified nor OCRed (`shape`). */
  readonly maxAspect?: number
}

/** The entry point that analyzes an image. Tests replace it (so they pass without Vision). */
export interface ImageAnalyzer {
  /** The scheme of label identifiers (the key that selects the mapping table. E.g. `apple-vision-classify`). */
  readonly backend: string
  /**
   * Output version. Bump it when the helper's output shape or the label scheme changes. Labels stored in `documents.metadata`
   * are reused only when this version matches (otherwise analyzed again).
   */
  readonly version: number
  /**
   * The OCR output version. If present, OCR is possible (`ImageAnalyzeOptions.ocr`). An analyzer without it (classification only) does not go to the OCR stage.
   * Bumping it stops reuse of stored OCR results (`documents.metadata.image.ocr`) and redoes them, newest first.
   */
  readonly ocrVersion?: number
  /** Analyzes the image contents (`data`, read by the caller with O_NOFOLLOW). No path is passed. */
  analyze(data: Uint8Array, options: ImageAnalyzeOptions): Promise<ImageAnalysis>
  /** Ends the child (when the index process shuts down). */
  dispose(): void
}
