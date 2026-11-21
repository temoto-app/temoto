/**
 * Conversion for `aios.office` (TODO 405 (4), wave 21 bundle H). **Separated from DOM drawing and the bridge**, so
 * tests (jsdom) can run real .docx / .xlsx files through it.
 *
 * - `.docx`: convert to HTML with mammoth and **always pass it through DOMPurify** (the same rule as 5.1. mammoth escapes the characters
 *   of the document, but emits a link's `href` as the document has it, so `javascript:` and the like are dropped here). Images are embedded as data URLs
 *   by mammoth's default (`images.dataUri`), and the CSP opens only `img-src data:`.
 * - `.xlsx`: read all sheets with `workbook.ts` (fflate's synchronous unzip + DOMParser) (`sheet.ts` decides the range to draw).
 *
 * Both only receive bytes (`ArrayBuffer`) and know neither files nor URLs (a viewer has no I/O,
 * 5.2 / 7.4. `main.ts` fetches the bytes from main's `aios-res://`).
 */
import mammoth from 'mammoth'
import DOMPurify from 'dompurify'
import { readWorkbook as readXlsx, type Workbook } from './workbook.js'

export type OfficeKind = 'docx' | 'xlsx'

/**
 * The upper limit loaded at once (bytes). `aios-res://` has no size limit (for range-read PDFs and video), so this viewer, which expands
 * everything in memory, stops itself. The contents of a zip grow several-fold (the XML of an xlsx exceeds 10 times).
 */
export const MAX_OFFICE_BYTES = 32 * 1024 * 1024

/**
 * Find the kind from the URI's extension (only the same three as the manifest's `extensions`). `.xlsm` (with macros, TODO 1212 stage 2) is the same as `.xlsx`
 * as a table — the macro (`xl/vbaProject.bin`) is neither read nor executed.
 */
export function officeKindOf(uri: string): OfficeKind | null {
  const path = uri.split(/[?#]/, 1)[0] ?? ''
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot < path.lastIndexOf('/')) return null
  const ext = path.slice(dot + 1).toLowerCase()
  if (ext === 'xlsm') return 'xlsx'
  return ext === 'docx' || ext === 'xlsx' ? ext : null
}

export interface DocxResult {
  /** HTML after DOMPurify. */
  readonly html: string
  /** The number of mammoth warnings (the contents are not logged either, since they may contain fragments of the body). */
  readonly warnings: number
}

/**
 * The DOMPurify settings. Keep only what the document's look needs:
 * - `style` elements and attributes are not emitted by mammoth, but are dropped just in case (so they cannot override the theme colors).
 * - Parts such as `form` / `input` are not emitted by mammoth either, but are dropped so they would not work even if they appeared.
 * - A data URL is allowed only on `<img>` (DOMPurify's default. `<a href="data:…">` is dropped).
 */
const PURIFY_CONFIG = {
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  FORBID_ATTR: ['style']
}

export async function convertDocx(bytes: ArrayBuffer): Promise<DocxResult> {
  return convertDocxInput({ arrayBuffer: bytes })
}

/**
 * Convert with the input shape of mammoth as is. The viewer's bundle uses mammoth's browser build (which accepts only `{ arrayBuffer }`), and
 * tests (Node) load the Node build (which accepts only `{ buffer }` / `{ path }`). This is an entry point to absorb that difference;
 * the conversion and the DOMPurify path are the same.
 */
export async function convertDocxInput(input: Parameters<typeof mammoth.convertToHtml>[0]): Promise<DocxResult> {
  const result = await mammoth.convertToHtml(
    input,
    // Do not go read external files (linked images). The browser build cannot read them anyway, but state it explicitly.
    { externalFileAccess: false }
  )
  const html = DOMPurify.sanitize(result.value, PURIFY_CONFIG)
  return { html, warnings: result.messages.length }
}

export type { Workbook }

/** Read an .xlsx. Unzipping and XML parsing are synchronous (no Worker is used, because the CSP does not allow a blob Worker). */
export async function readWorkbook(bytes: ArrayBuffer): Promise<Workbook> {
  return readXlsx(bytes)
}
