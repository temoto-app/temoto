/**
 * Extraction of PDF bodies (TODO 1009, stage 2 of 997).
 *
 * **The only Mac-specific part is here** (swap it here when the OS adapter of 986 arrives): the PDFKit Swift helper
 * (`tools/pdf-helper/`, `npm run build:pdf` -> `out/pdf-helper/pdf-helper`) is kept resident as a **child process of the index process**, and
 * a one-line JSON header followed by the bytes of the PDF's content is passed on stdin. **No path is passed** (review of TODO 1009):
 * the index process opens and reads the file with `openRegularFile` (O_NOFOLLOW, TODO 849). If the child opened the path it would
 * follow symlinks, and if the file were swapped between `lstat` and the open, the body of a file outside the index would go in.
 * Even if it crashes on a broken PDF, only the child dies (it is recreated by the next request).
 * In an environment without the helper (non-Mac / not built), `pdfAvailable()` is false and PDFs are skipped by extension as before.
 *
 * The extracted text is not stored (constraint 9). As with Office (`ooxml.ts`), the chunk range is "a UTF-8 byte offset in the extracted text",
 * and display re-extracts and slices. PDFKit's output can change with macOS updates, so the service has a safety net that compares the sha256 of the re-extracted
 * text with `documents.content_hash` and re-indexes if they differ.
 */
import { existsSync } from 'node:fs'
import { isMac } from '../common/os/platform.js'
import { StdioHelper } from './helper-process.js'
import { addHelperCpuMicros } from './pace.js'

/** Raise it when the output shape changes. It becomes the version marker of fs rows (`:pkN`), and raising it re-indexes PDFs. */
export const PDF_EXTRACTOR_VERSION = 2

/** Time per file (5 seconds, the same as Office). When exceeded the child is killed and the result is `corrupt`. */
export const PDF_TIME_LIMIT_MS = 5_000
/** Upper bound on the number of pages read. */
export const PDF_MAX_PAGES = 2_000
/** Time until a child that is no longer used is ended. */
export const PDF_IDLE_MS = 60_000

export type PdfExtraction =
  | {
      readonly ok: true
      readonly text: string
      readonly truncated: boolean
      /**
       * The length each page occupies in `text` (page body + the separating newline, in UTF-16 units. Stage 2 of TODO 1009).
       * Summing them gives the start of each page (`pdfPageStarts`). Empty if the helper does not return it (nothing is attributed to a page).
       */
      readonly pageLengths?: readonly number[]
    }
  | { readonly ok: false; readonly reason: 'corrupt' }

/** The entry point that extracts PDF bodies. Tests replace it (they pass without PDFKit). */
export interface PdfExtractor {
  /**
   * The body up to the first `limitBytes` (UTF-8), from the PDF's contents (`data`, which the caller read with O_NOFOLLOW).
   * If it cannot be extracted (broken, password-protected, timed out), `corrupt`.
   */
  extract(data: Uint8Array, limitBytes: number): Promise<PdfExtraction>
  /** Ends the child (when the index process shuts down). */
  dispose(): void
}

let current: PdfExtractor | null = null

/** Can PDF bodies be extracted in this environment? (is a helper configured) */
export function pdfAvailable(): boolean {
  return current !== null
}

/** Sets the extractor (null disables it). The previous one is disposed. */
export function setPdfExtractor(extractor: PdfExtractor | null): void {
  if (current !== null && current !== extractor) current.dispose()
  current = extractor
}

/** The configured extractor. null if none. */
export function pdfExtractor(): PdfExtractor | null {
  return current
}

/** Configures the extractor from the helper's path. Disabled if there is no path, no file, or it is not a Mac. */
export function configurePdfHelper(helperPath: string | null | undefined): boolean {
  if (helperPath === null || helperPath === undefined || helperPath === '' || !isMac() || !existsSync(helperPath)) {
    setPdfExtractor(null)
    return false
  }
  setPdfExtractor(new PdfKitHelper(helperPath))
  return true
}

// Full-width alphanumerics (U+FF10-19, FF21-3A, FF41-5A) are left out (wave 62 review): they would also close up the space between
// words written in full-width letters (U+FF21 U+FF22 U+FF23, U+3000, U+FF24 U+FF25 U+FF26).
// What stays is full-width punctuation, brackets and symbols (FF01-0F, FF1A-20, FF3B-40, FF5B-65, including the half-width
// U+FF61-FF65) and full-width currency and similar symbols (FFE0-EE). Half-width kana fall under Script=Katakana.
const CJK = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uFFE0-\uFFEE\u3005\u30FC]`
const CJK_GAP = new RegExp(String.raw`(?<=${CJK})[ \t\u00A0\u3000]+(?=${CJK})`, 'gu')

/**
 * Closes up whitespace (spaces, tabs, NBSP, full-width spaces) sandwiched between kana, kanji and CJK symbols. In multi-column PDFs PDFKit sometimes
 * puts whitespace between characters placed one at a time (spike 33: 33 per 1,000 characters). If it is not applied before word segmentation,
 * words get split and searches miss them. Newlines are not closed up (line breaks are kept).
 */
export function compactCjkSpaces(text: string): string {
  return text.replace(CJK_GAP, '')
}

/** Lets through only "an array of safe non-negative integers" (both the helper's reply and the index's `metadata.pdfPages` are checked with this). */
export function sanitizePageLengths(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) return []
    out.push(item)
  }
  return out
}

/**
 * Closes up the whitespace of the extracted text (`text`, **before** whitespace is closed up), and in one go returns the start of each page in the
 * closed-up text (UTF-8 byte offset, ascending, the first is 0) from the helper's `pageLengths`. It joins the fragments closed up per page, so
 * the regular expression goes over the whole text just once (closing up per page or over the whole gives the same result: only whitespace that does not
 * cross a newline is closed up, and the page separator is a newline). Pages starting at or after `limitBytes` are dropped (when the text was truncated).
 * If `pageLengths` does not match `text`, `starts` is empty (nothing is attributed to a page).
 */
export function compactPdfPages(
  text: string,
  pageLengths: readonly number[],
  limitBytes: number
): { text: string; starts: number[] } {
  const starts: number[] = []
  const parts: string[] = []
  let at = 0
  let bytes = 0
  let cut = false
  for (const length of pageLengths) {
    if (at + length > text.length) break
    if (bytes >= limitBytes) {
      cut = true
      break
    }
    starts.push(bytes)
    const part = compactCjkSpaces(text.slice(at, at + length))
    parts.push(part)
    bytes += Buffer.byteLength(part, 'utf8')
    at += length
  }
  // The remainder that was not counted (what stopped at the limit, or what the total does not match) is closed up too, so that the whole text is not dropped.
  if (at < text.length) parts.push(compactCjkSpaces(text.slice(at)))
  const joined = parts.join('')
  // If the total does not match (the helper's version drifted, etc.) it is not trusted.
  return { text: joined, starts: cut || at === text.length ? starts : [] }
}

/** The page (1-based) that a byte offset falls in. null if `starts` is empty. */
export function pdfPageOfByte(starts: readonly number[], byte: number): number | null {
  if (starts.length === 0) return null
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= byte) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** Puts the shape of PDF requests and responses on the entry point to the child (`StdioHelper`, shared with the image helper). */
class PdfKitHelper implements PdfExtractor {
  private readonly helper: StdioHelper

  constructor(helperPath: string) {
    this.helper = new StdioHelper(helperPath, { name: 'pdf', timeoutMs: PDF_TIME_LIMIT_MS, idleMs: PDF_IDLE_MS })
  }

  async extract(data: Uint8Array, limitBytes: number): Promise<PdfExtraction> {
    // Have it read with some margin (the child counts in UTF-8 bytes, and cutting at a character boundary is done here).
    const reply = await this.helper.request({ maxBytes: limitBytes, maxPages: PDF_MAX_PAGES }, data)
    // A request held by a child that crashed or timed out is also `corrupt` (a PDF that brought it down is not re-taken until the version changes).
    if (reply === null) return { ok: false, reason: 'corrupt' }
    // The child's CPU time is counted toward the slow stage's rest (TODO 1226. It is included in failure responses too: an unopenable PDF also uses CPU).
    const cpu = reply['cpuUs']
    if (typeof cpu === 'number' && Number.isFinite(cpu) && cpu > 0) addHelperCpuMicros(cpu)
    if (reply['ok'] !== true || typeof reply['text'] !== 'string') return { ok: false, reason: 'corrupt' }
    return {
      ok: true,
      text: reply['text'],
      truncated: reply['truncated'] === true,
      pageLengths: sanitizePageLengths(reply['pageLengths'])
    }
  }

  dispose(): void {
    this.helper.dispose()
  }
}
