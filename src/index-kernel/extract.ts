/**
 * Body extraction for fs sources (the Indexer / Normalize stage of ARCHITECTURE.md 6.2).
 *
 * Phase 3 handled **plain text, code and markup** only. TODO 997 (wave 53) added
 * **Office (docx / xlsx / pptx)**: the text pulled out of the zip + XML (`ooxml.ts`) is indexed.
 * PDF is still rejected by extension and becomes `skipped` (where to extract it from awaits the spike result: `docs/notes/wave53.md`).
 *
 * The canonical copy is the file on disk itself, and extracted text is never persisted (6.5). For Office documents
 * the "extracted text" is the coordinate system of the chunks (`derived`), so excerpts and `getDocumentText` re-extract every time
 * (`extractFile` keeps it briefly in the index process's memory: `DERIVED_CACHE_*`).
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, type FileHandle } from 'node:fs/promises'
import { openNoFollow } from '../common/os/open-flags.js'
import { basename, extname } from 'node:path'
import { extractOoxml, ooxmlKindOf, OOXML_EXTRACTOR_VERSION, type OoxmlKind } from './ooxml.js'
import { compactPdfPages, pdfAvailable, pdfExtractor, PDF_EXTRACTOR_VERSION } from './pdf.js'
import {
  imageAnalyzer,
  imageAvailable,
  imageIndexVersion,
  sanitizeOcrText,
  IMAGE_DECODE_SIDE,
  IMAGE_OCR_MAX_CHARS,
  IMAGE_OCR_SIDE,
  IMAGE_MAX_ASPECT,
  IMAGE_STRIP_ASPECT,
  IMAGE_EXTENSIONS,
  IMAGE_MAX_PIXELS,
  IMAGE_MAX_SIDE,
  IMAGE_MIN_SIDE,
  isImageExtension,
  storedImageText,
  toStoredImageLabels,
  type StoredImageLabels,
  type StoredImageOcr
} from './image.js'
import { imageDocKind } from '../common/image-labels/receipt.js'
import { IMAGE_LABEL_KEEP_CONFIDENCE } from '../common/image-labels/terms.js'
import { log } from '../common/logger.js'

/**
 * Opens the canonical file for reading (TODO 849). **Does not follow symlinks** (`O_NOFOLLOW`; `ELOOP` if the last
 * component is a symlink), and checks with `fstat` on the opened fd that it is a regular file (FIFOs and devices are not read even if opened).
 * This avoids reading the target of a file that was swapped for a symlink while its row was stale (`git checkout`, etc.).
 * Symlinks in intermediate components are closed off on the read side (the parent-directory realpath re-check in `IndexService.fsVerdict`).
 */
export async function openRegularFile(path: string): Promise<FileHandle> {
  const handle = await openNoFollow(path, constants.O_RDONLY)
  try {
    if (!(await handle.stat()).isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EINVAL' })
  } catch (err) {
    await handle.close()
    throw err
  }
  return handle
}

/**
 * Extensions to extract (no dot, lowercase).
 * `env` (`prod.env` etc.) is not included (TODO 855, owner decision 2026-10-17): the body is often a plaintext secret.
 * It still appears in name search, listings and the viewer as before (only the body is left out, not an exclusion rule).
 */
const TEXT_EXTENSIONS = new Set([
  // prose / markup
  'txt', 'md', 'markdown', 'rst', 'org', 'adoc', 'tex', 'html', 'htm', 'xml', 'svg',
  'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'properties', 'plist', 'srt', 'vtt',
  // code
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'm', 'mm', 'php', 'pl', 'pm', 'lua',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'sql', 'graphql', 'gql', 'proto', 'thrift',
  'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less', 'styl', 'ex', 'exs', 'erl',
  'hs', 'ml', 'scala', 'clj', 'cljs', 'dart', 'r', 'jl', 'nim', 'zig', 'vim', 'el',
  'gradle', 'cmake', 'mk', 'dockerfile', 'tf', 'tfvars', 'hcl', 'ipynb', 'diff', 'patch',
  'log'
])

/**
 * Extensions added to `TEXT_EXTENSIONS` later (TODO 1089). Assembler (`.S` / `.s` / `.asm` / `.inc`), linker scripts,
 * HDL and C++ aliases were not in the table from the start, so their bodies were not in the index (`mmu_init_c1` did not show up in full-text search).
 * Rows that became `skipped` by extension before the addition keep the same version (`mtime:size`), so neither the incremental scan nor the full scan picks them up:
 * cleanup (`requeueDerived` in `upkeep.ts`) returns the `skipped` rows with these extensions to `pending` exactly once.
 * **When you add to this, raise `TEXT_EXTENSIONS_EPOCH`** (otherwise the finished cleanup does not run again).
 */
export const LATE_TEXT_EXTENSIONS: readonly string[] = [
  's', 'asm', 'inc', 'ld', 'lds',
  'v', 'sv', 'svh', 'vh', 'vhdl',
  'cxx', 'hxx', 'hh', 'ino'
]
/**
 * Generation of the extension table. Raise it when `LATE_TEXT_EXTENSIONS` (TODO 1089) changes, or when an extension is added to the extraction table later (`.xlsm` in TODO 1239).
 * It goes into `derivedEpoch`, and when it goes up the cleanup starts over from 0 (it became 2 in 1239: to re-tag the existing `skipped` `.xlsm` rows
 * with `retagFsVersion` and return them to `pending`).
 */
export const TEXT_EXTENSIONS_EPOCH = 2
for (const ext of LATE_TEXT_EXTENSIONS) TEXT_EXTENSIONS.add(ext)

/** Files that have no extension but do have a body (folded names). */
const TEXT_FILENAMES = new Set([
  'readme', 'license', 'licence', 'notice', 'changelog', 'authors', 'contributing',
  'makefile', 'dockerfile', 'jenkinsfile', 'procfile', 'rakefile', 'gemfile', 'brewfile',
  'todo', 'install', 'news', 'copying'
])

/**
 * The body is not extracted under directories with these names.
 *
 * A consequence of the decision to include `/Applications` in the indexed area (12.7) is that the insides of app bundles
 * (`Localizable.strings`, bundled JS, headers) would flood full-text search.
 * **They stay in listings and file-name search; only the body is left out.**
 */
const BUNDLE_EXTENSIONS = new Set([
  'app', 'framework', 'bundle', 'lproj', 'xcassets', 'dsym', 'plugin', 'kext',
  'appex', 'xpc', 'playground', 'photoslibrary', 'musiclibrary', 'tvlibrary',
  'imovielibrary', 'fcpbundle', 'sparsebundle', 'download'
])

/**
 * Upper bound on the body put into the index per document. A file over it gets **only its head** indexed.
 *
 * The bottleneck is word segmentation: **802 ms for a 1 MB Japanese file**
 * (breakdown: read 9 ms / chunking 6 ms / segmentation 802 ms / write 24 ms;
 * measured in Phase 3). Indexing the whole PC yields thousands of such files, so
 * the cap is 256 KB, which keeps it to about 200 ms per document.
 * The part beyond it is not searchable, but the file is found by name search and by its first 256 KB.
 */
export const MAX_EXTRACT_BYTES = 256 * 1024
/** Files larger than this are not opened (not worth the read cost). */
export const MAX_FILE_BYTES = 32 * 1024 * 1024

export type ExtractResult =
  | {
      readonly ok: true
      readonly text: string
      readonly bytes: number
      readonly truncated: boolean
      /**
       * The decoded string does not round-trip to the original bytes (invalid UTF-8 such as Shift_JIS was replaced with U+FFFD, TODO 925).
       * Chunk byte ranges are counted on the decoded string, so for this file they drift from positions in the canonical raw bytes.
       * Display does not read the raw bytes by range; it cuts from the decoded string (`IndexService.toHit`).
       */
      readonly lossy: boolean
      /**
       * The body is the extracted text, not the file's bytes (TODO 997, docx / xlsx / pptx). Chunk ranges are
       * UTF-8 byte offsets in that text. `bytes` is the size of the file.
       */
      readonly derived?: true
      /**
       * PDF: the start of each page (UTF-8 byte offset in `text`, ascending, the first is 0. TODO 1009 stage 2).
       * Kept in `documents.metadata`; the page is looked up from the range of a search hit's chunk. If absent, nothing is attributed to a page.
       */
      readonly pdfPages?: readonly number[]
      /**
       * Image: classification labels (TODO 998). `text` is the line of words built from them. Stored in `documents.metadata.image`, so that
       * a version bump of the excerpt / mapping table rebuilds `text` without re-running Vision.
       */
      readonly image?: StoredImageLabels
    }
  | { readonly ok: false; readonly reason: ExtractSkipReason }

/** How to handle image OCR (`hints.ocr` of `extractFile`). */
export type ImageOcrMode = 'none' | 'run' | 'reread'

export type ExtractSkipReason =
  | 'extension'
  | 'bundle'
  | 'too-large'
  | 'binary'
  | 'empty'
  | 'not-materialized'
  | 'unreadable'
  /** Cannot be extracted (broken zip, encrypted, over the limit: TODO 997). */
  | 'corrupt'
  /** A transient image OCR failure (timeout, helper crash, failed re-read). Leaves the stored state unchanged (TODO 998 fix Y). */
  | 'transient'
  /** At the image OCR stage: an image that cannot be read (only the OCR stage marks it `failed`). */
  | 'ocr-failed'

export function extensionOf(name: string): string {
  const ext = extname(name)
  return ext === '' ? '' : ext.slice(1).toLowerCase()
}

/** Is the path inside an app bundle or similar? */
export function insideBundle(path: string): boolean {
  for (const segment of path.split('/')) {
    const ext = extensionOf(segment)
    if (ext !== '' && BUNDLE_EXTENSIONS.has(ext)) return true
  }
  return false
}

/** Is it a file name whose body is to be extracted? (decided only by the extension / name rules) */
export function isExtractable(path: string): boolean {
  const name = basename(path)
  if (insideBundle(path)) return false
  const ext = extensionOf(name)
  if (ext !== '') {
    return (
      TEXT_EXTENSIONS.has(ext) ||
      ooxmlKindOf(ext) !== null ||
      (ext === 'pdf' && pdfAvailable()) ||
      (isImageExtension(ext) && imageAvailable())
    )
  }
  return TEXT_FILENAMES.has(name.toLowerCase())
}

/** Extensions whose extracted text is indexed (Office and PDF of TODO 997, images of TODO 998). */
export const DERIVED_TEXT_EXTENSIONS: readonly string[] = ['docx', 'xlsx', 'xlsm', 'pptx', 'pdf', ...IMAGE_EXTENSIONS]

/**
 * Is the body "extracted text" rather than "the file's bytes themselves"? (TODO 997: docx / xlsx / pptx)
 * Chunk ranges are UTF-8 byte offsets in the extracted text, so instead of reading the canonical copy by range (`readUtf8Range`),
 * `extractFile` re-extracts and slices.
 */
export function isDerivedText(path: string): boolean {
  if (insideBundle(path)) return false
  const ext = extensionOf(basename(path))
  // PDF (TODO 1009) is true even without an extractor: old rows must not be read by raw byte range after the helper is gone
  // (`extractFile` returns 'extension' and the display becomes null).
  // Images (TODO 998) are the same: the body is the line of words built from classification labels, not the file's bytes.
  return ooxmlKindOf(ext) !== null || ext === 'pdf' || isImageExtension(ext)
}

/** Is it an image whose content is analyzed into words? (TODO 998, judged by extension only) */
export function isImagePath(path: string): boolean {
  return isImageExtension(extensionOf(basename(path)))
}

/**
 * Extraction version marker appended to the version of an fs row (TODO 997). Only files whose extracted text is indexed get it;
 * when the extractor's output changes (`OOXML_EXTRACTOR_VERSION` is raised) the version changes and the file is re-indexed.
 * It is empty for text files (the version string is the same as before: existing rows are not re-queued).
 */
export function extractorTag(name: string): string {
  const ext = extensionOf(name)
  if (ooxmlKindOf(ext) !== null) return `:ox${OOXML_EXTRACTOR_VERSION}`
  // PDF (TODO 1009) gets the marker only when the helper exists. Without it, no marker as before (skipped).
  if (ext === 'pdf' && pdfAvailable()) return `:pk${PDF_EXTRACTOR_VERSION}`
  // Images (TODO 998) likewise only when the analyzer exists. The vocabulary / mapping table version is included too (fixing it re-indexes).
  if (isImageExtension(ext) && imageAvailable()) return `:vl${imageIndexVersion()}`
  return ''
}

/**
 * The extraction generation that cleanup (the re-tagging in `upkeep.ts`) looks at: generation of later-added extensions x 10^12 (TODO 1089) +
 * image version x 10^6 (TODO 998; 0 without an analyzer; `imageIndexVersion` is below 10^6) + Office version x 1000 +
 * PDF version (0 without the helper). When it goes up or down (the helper appears or disappears) the re-tagging starts over.
 */
export function derivedEpoch(): number {
  return (
    TEXT_EXTENSIONS_EPOCH * 1_000_000_000_000 +
    imageIndexVersion() * 1_000_000 +
    OOXML_EXTRACTOR_VERSION * 1000 +
    (pdfAvailable() ? PDF_EXTRACTOR_VERSION : 0)
  )
}

/** Treated as binary if it contains NUL (the same test as FsService). */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.byteLength, 8192)
  for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true
  return false
}

/**
 * Reads the body of a file.
 *
 * **Does not open iCloud files that are not fully downloaded (dataless).** Opening one makes
 * macOS start downloading the real content. In Phase 1 this was no problem because the scan only did
 * `lstat`, but it matters for the first time in Phase 3, which reads bodies (the homework of 12.3).
 * Two checks: `blocks === 0 && size > 0`, and the `.icloud` placeholder name.
 */
export async function extractFile(
  path: string,
  hints: {
    /**
     * Image (TODO 998): the labels stored in the row. If the analyzer version and `at` (the file's `mtime:size`) are the same as now,
     * the line of words is built from these without calling Vision (mapping-table version bump, re-index, search excerpts).
     */
    readonly image?: StoredImageLabels | null
    /**
     * How to handle OCR for an image (TODO 998 stage 2). `run` = the OCR stage only (decides the result state), `reread` = re-reading for an excerpt / document
     * (re-extracts the text of a `done` image; a failure is transient), omitted = build (OCR is not called, only the line of words).
     */
    readonly ocr?: ImageOcrMode
  } = {}
): Promise<ExtractResult> {
  const name = basename(path)
  if (insideBundle(path)) return { ok: false, reason: 'bundle' }
  if (name.startsWith('.') && name.endsWith('.icloud')) {
    return { ok: false, reason: 'not-materialized' }
  }
  if (!isExtractable(path)) return { ok: false, reason: 'extension' }

  let stats
  try {
    // Do not follow symlinks (TODO 849). It is the gate before opening, so lstat: to avoid opening a not-yet-downloaded iCloud file.
    stats = await lstat(path)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (!stats.isFile()) return { ok: false, reason: 'unreadable' }
  if (stats.size === 0) return { ok: false, reason: 'empty' }
  if (stats.size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' }
  // A file with no real content (iCloud / OneDrive placeholder). Reading it triggers a sync.
  if (stats.blocks === 0) return { ok: false, reason: 'not-materialized' }

  const ooxml = ooxmlKindOf(extensionOf(name))
  if (ooxml !== null) return extractDerived(path, ooxml, `${stats.mtimeMs}:${stats.size}`)
  if (extensionOf(name) === 'pdf') return extractPdf(path, `${stats.mtimeMs}:${stats.size}`)
  if (isImageExtension(extensionOf(name))) {
    return extractImage(path, `${stats.mtimeMs}:${stats.size}`, hints.image ?? null, hints.ocr ?? 'none')
  }

  let buffer: Buffer
  try {
    const handle = await openRegularFile(path)
    try {
      buffer = await handle.readFile()
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (looksBinary(buffer)) return { ok: false, reason: 'binary' }

  const truncated = buffer.byteLength > MAX_EXTRACT_BYTES
  // When cutting at the limit, snap to a character boundary (so a half-written trailing character does not become U+FFFD: avoids a false `lossy`).
  const slice = truncated
    ? buffer.subarray(0, utf8Bounds(buffer.subarray(0, MAX_EXTRACT_BYTES), false).end)
    : buffer
  const text = slice.toString('utf8')
  if (text.trim() === '') return { ok: false, reason: 'empty' }
  return { ok: true, text, bytes: buffer.byteLength, truncated, lossy: isLossy(text, slice) }
}

/**
 * Number and time to keep extracted text in the index process's memory (TODO 997). So that paging through the same document (`getDocumentText`), or
 * cutting excerpts of other chunks of the same document one after another within one search, does not re-expand the zip each time.
 * The body is never written to the DB or disk (constraint 9). The key is the path; an entry is not used once the version (`mtime:size`) changes.
 */
export const DERIVED_CACHE_ENTRIES = 8
export const DERIVED_CACHE_TTL_MS = 60_000

interface DerivedCacheEntry {
  readonly version: string
  readonly result: ExtractResult
  readonly at: number
  /** sha256 (hex) of the extracted text. Computed only once, the first time it is asked for (`derivedTextDigest`). */
  digest?: string
}

const derivedCache = new Map<string, DerivedCacheEntry>()

/** For tests: empties the store of extracted text. */
export function clearDerivedTextCache(): void {
  derivedCache.clear()
}

/**
 * sha256 (hex) of the extracted text (used by `IndexService.derivedMatches`, the safety net of TODO 1009). If the entry in the store
 * holds the same text, the digest remembered there is used: up to 256 KB is not re-hashed on every excerpt / `getDocument*`.
 */
export function derivedTextDigest(path: string, text: string): string {
  const entry = derivedCache.get(path)
  if (entry !== undefined && entry.result.ok && entry.result.text === text) {
    entry.digest ??= createHash('sha256').update(text).digest('hex')
    return entry.digest
  }
  return createHash('sha256').update(text).digest('hex')
}

function derivedCached(path: string, version: string, now: number): ExtractResult | null {
  const cached = derivedCache.get(path)
  if (cached !== undefined && cached.version === version && now - cached.at < DERIVED_CACHE_TTL_MS) {
    // Reorder by most recently used (the Map's insertion order serves as the LRU).
    derivedCache.delete(path)
    derivedCache.set(path, cached)
    return cached.result
  }
  return null
}

function derivedStore(path: string, version: string, now: number, result: ExtractResult): void {
  derivedCache.delete(path)
  derivedCache.set(path, { version, result, at: now })
  while (derivedCache.size > DERIVED_CACHE_ENTRIES) {
    const oldest = derivedCache.keys().next().value
    if (oldest === undefined) break
    derivedCache.delete(oldest)
  }
}

/**
 * PDF body (TODO 1009). Extraction is done by the PDFKit helper (`pdf.ts`, a child process). Whitespace between CJK characters is closed
 * up before word segmentation. 0 characters (a scanned PDF) is skipped as `empty`. The limit is the same as for Office.
 */
async function extractPdf(path: string, version: string): Promise<ExtractResult> {
  const now = Date.now()
  const hit = derivedCached(path, version, now)
  if (hit !== null) return hit
  const extractor = pdfExtractor()
  if (extractor === null) return { ok: false, reason: 'extension' }
  // The contents are read here with O_NOFOLLOW and handed to the helper (review of TODO 849 / 1009). If the path were given to the helper,
  // it would follow symlinks and could read the real content of a file swapped in after the `lstat`.
  let data: Buffer
  try {
    const handle = await openRegularFile(path)
    try {
      if ((await handle.stat()).size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' }
      data = await handle.readFile()
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (data.byteLength > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' }
  const out = await extractor.extract(data, MAX_EXTRACT_BYTES)
  let result: ExtractResult
  if (!out.ok) {
    result = { ok: false, reason: 'corrupt' }
  } else {
    const compacted = compactPdfPages(out.text, out.pageLengths ?? [], MAX_EXTRACT_BYTES)
    const pdfPages = compacted.starts
    let text = compacted.text
    let truncated = out.truncated
    const buffer = Buffer.from(text, 'utf8')
    if (buffer.byteLength > MAX_EXTRACT_BYTES) {
      text = buffer.subarray(0, utf8Bounds(buffer.subarray(0, MAX_EXTRACT_BYTES), false).end).toString('utf8')
      truncated = true
    }
    result =
      text.trim() === ''
        ? { ok: false, reason: 'empty' }
        : {
            ok: true,
            text,
            bytes: data.byteLength,
            truncated,
            lossy: false,
            derived: true,
            ...(pdfPages.length > 0 ? { pdfPages } : {})
          }
  }
  derivedStore(path, version, now, result)
  return result
}

/**
 * Image (TODO 998): the classification labels become the line of words, followed by the OCR text from line 2 on, if any (stage 2).
 *
 * - If the stored labels match the current file (`version` = `mtime:size`) and the analyzer version, classification (Vision) is not re-run.
 * - OCR text is **not stored** (constraint 9). Only the result marker (`image.ocr`: done / none / failed, and the receipt / document judgments) is stored.
 * - **Only the OCR stage (`mode: 'run'`) may write the OCR state (done / none / failed).** An ordinary build (`'none'`) does not call OCR and
 *   returns only the line of words (the `done` marker is dropped and the image goes back to the queue; the OCR stage re-takes it throttled, so that a re-index
 *   triggered by a version bump does not run OCR for every image inside the build). A re-read for excerpts / `getDocumentText` (`'reread'`) re-extracts the text of `done` images,
 *   but a failure returns `transient` as a transient condition, leaves the stored state unchanged, and does not put the result in the store either.
 * - An image whose longest side is below `IMAGE_MIN_SIDE`, or whose aspect ratio exceeds `IMAGE_MAX_ASPECT`, is `empty` (skipped). An image that meets the size and shape conditions
 *   stays in the index even with no words (empty body) and goes into the OCR queue (a screenshot of text only; if OCR finds no text either, `none`).
 */
async function extractImage(
  path: string,
  version: string,
  stored: StoredImageLabels | null,
  mode: ImageOcrMode
): Promise<ExtractResult> {
  const analyzer = imageAnalyzer()
  if (analyzer === null) return { ok: false, reason: 'extension' }
  const ocrVersion = analyzer.ocrVersion
  const bytesOf = Number(version.slice(version.indexOf(':') + 1)) || 0
  const labelsValid =
    stored !== null && stored.v === analyzer.version && stored.backend === analyzer.backend && stored.at === version
  const ocrCurrent =
    labelsValid && ocrVersion !== undefined && stored.ocr !== undefined && stored.ocr.v === ocrVersion
  const needsText = ocrCurrent && stored.ocr?.state === 'done'
  if (labelsValid && mode === 'none') {
    // Build: OCR is not called. The `done` marker and markers of old versions are dropped (text cannot be produced in a build), and the OCR stage re-takes it.
    return imageResult(ocrCurrent && !needsText ? stored : withoutOcr(stored), bytesOf, '')
  }
  if (labelsValid && mode === 'reread' && !needsText) {
    // Re-read: an image without text gets only the line of words (the same as the indexed text).
    return imageResult(ocrCurrent ? stored : withoutOcr(stored), bytesOf, '')
  }
  // No stored labels, or stale: start from classification (no OCR). Labels exist and OCR is needed: OCR only (classification is not re-run).
  const doOcr = labelsValid && ocrVersion !== undefined
  const key = doOcr ? `${version}|o${ocrVersion}` : version
  const now = Date.now()
  if (mode !== 'run') {
    const hit = derivedCached(path, key, now)
    if (hit !== null) return hit
  }
  // The contents are read here with O_NOFOLLOW and handed to the helper (same as PDF: review of TODO 849 / 1009).
  let data: Buffer
  try {
    const handle = await openRegularFile(path)
    try {
      if ((await handle.stat()).size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' }
      data = await handle.readFile()
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (data.byteLength > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' }
  const out = await analyzer.analyze(data, {
    minConfidence: IMAGE_LABEL_KEEP_CONFIDENCE,
    minSide: IMAGE_MIN_SIDE,
    maxSide: IMAGE_MAX_SIDE,
    maxPixels: IMAGE_MAX_PIXELS,
    decodeSide: IMAGE_DECODE_SIDE,
    classify: !doOcr,
    ocr: doOcr,
    ocrSide: IMAGE_OCR_SIDE,
    ocrMaxChars: IMAGE_OCR_MAX_CHARS,
    stripAspect: IMAGE_STRIP_ASPECT,
    maxAspect: IMAGE_MAX_ASPECT
  })
  // An image whose dimensions exceed the limit (decompression bomb) is excluded without being decoded (`too-large` -> skipped). Only the reason is logged.
  if (!out.ok && out.reason === 'large') log.info('index.image.skipped', { path, reason: 'large' })
  let result: ExtractResult
  if (!out.ok) {
    if (doOcr && (out.reason === 'timeout' || (mode === 'reread' && out.reason === 'corrupt'))) {
      // A timeout or helper crash is not assumed to be the image's fault (load, model loading). A failed re-read is transient too.
      // The state is not written and nothing is put in the store (the caller re-takes it later / returns without an excerpt).
      return { ok: false, reason: 'transient' }
    }
    if (doOcr && out.reason === 'corrupt') {
      // Only OCR failed (an unreadable image): only the OCR stage marks it `failed` (not re-taken for the same version).
      return { ok: false, reason: 'ocr-failed' }
    }
    // An image that is too small or has an extreme aspect ratio is "no body" (skipped), and one that is too large is `too-large` (skipped).
    // One that cannot be read, crashed, or timed out is `corrupt` (not re-taken until the version changes).
    result = {
      ok: false,
      reason: out.reason === 'small' || out.reason === 'shape' ? 'empty' : out.reason === 'large' ? 'too-large' : 'corrupt'
    }
  } else if (doOcr && stored !== null) {
    if (out.ocrFailed === true || out.text === undefined) {
      return { ok: false, reason: mode === 'reread' ? 'transient' : 'ocr-failed' }
    }
    const text = sanitizeOcrText(out.text)
    const kind = imageDocKind(text)
    const ocr: StoredImageOcr = {
      v: ocrVersion as number,
      state: text === '' ? 'none' : 'done',
      ...(kind === null ? {} : { kind })
    }
    result = imageResult(withOcr(stored, ocr), bytesOf, text)
  } else {
    const shape = out.strip === true ? (out.width >= out.height ? 'wide' : 'tall') : undefined
    result = imageResult(toStoredImageLabels(analyzer, version, out.labels, shape), data.byteLength, '')
  }
  derivedStore(path, key, now, result)
  return result
}

function withOcr(stored: StoredImageLabels, ocr: StoredImageOcr): StoredImageLabels {
  return { ...stored, ocr }
}

function withoutOcr(stored: StoredImageLabels): StoredImageLabels {
  const { ocr: _stale, ...rest } = stored
  return rest
}

/**
 * Text = the line of words (line 1) + the OCR text (line 2 on, if any). Returns a text even when the line of words is empty (an image meeting the size and shape
 * conditions goes into the OCR queue: with neither words nor text the body is empty, no chunk is made, and it stays skipped with only the marker set).
 */
function imageResult(stored: StoredImageLabels, bytes: number, ocrText: string): ExtractResult {
  const labelLine = storedImageText(stored)
  const text = ocrText === '' ? labelLine : `${labelLine}\n${ocrText}`
  return { ok: true, text, bytes, truncated: false, lossy: false, derived: true, image: stored }
}

async function extractDerived(path: string, kind: OoxmlKind, version: string): Promise<ExtractResult> {
  const now = Date.now()
  const hit = derivedCached(path, version, now)
  if (hit !== null) return hit
  let buffer: Buffer
  try {
    const handle = await openRegularFile(path)
    try {
      buffer = await handle.readFile()
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  let result: ExtractResult
  try {
    const out = await extractOoxml(buffer, kind, { limitBytes: MAX_EXTRACT_BYTES })
    result =
      out.text.trim() === ''
        ? { ok: false, reason: 'empty' }
        : { ok: true, text: out.text, bytes: buffer.byteLength, truncated: out.truncated, lossy: false, derived: true }
  } catch {
    // Both `OoxmlError` (broken zip, encrypted, over the limit) and anything thrown in a form the reader did not expect become "cannot be extracted".
    result = { ok: false, reason: 'corrupt' }
  }
  derivedStore(path, version, now, result)
  return result
}

/**
 * Does the decoded `text` fail to round-trip to `bytes`? (TODO 925) Without replacement characters decoding is reversible, so
 * re-encoding (under 1 ms for 256 KB) is done only when U+FFFD is present (a genuine U+FFFD in the canonical copy is still judged correctly).
 */
export function isLossy(text: string, bytes: Uint8Array): boolean {
  if (!text.includes('\uFFFD')) return false
  return !Buffer.from(text, 'utf8').equals(bytes)
}

/**
 * Looks only at whether an indexed file is `lossy` (TODO 925) (added after the fact in TODO 946). Judged with the same gate and
 * the same range as `extractFile` (the first `MAX_EXTRACT_BYTES`, snapped to a character boundary), but **does not read the whole text** (reads only up to the limit).
 * The body is kept nowhere (constraint 9).
 *
 * `version` is the row's version (`mtime:size`). If lstat reports a different version, null (it changed after indexing; the re-index sets the marker).
 * Unreadable, stopped by the gate, and empty are also null.
 */
export async function probeLossy(path: string, version: string): Promise<boolean | null> {
  if (insideBundle(path) || !isExtractable(path) || isDerivedText(path)) return null
  let stats
  try {
    stats = await lstat(path)
  } catch {
    return null
  }
  if (!stats.isFile() || stats.size === 0 || stats.size > MAX_FILE_BYTES || stats.blocks === 0) return null
  if (`${stats.mtimeMs}:${stats.size}` !== version) return null
  let buffer: Buffer
  try {
    const handle = await openRegularFile(path)
    try {
      // What `extractFile` looks at is also only the first `MAX_EXTRACT_BYTES` (snapped to a character boundary).
      const want = Math.min(stats.size, MAX_EXTRACT_BYTES)
      const chunk = Buffer.allocUnsafe(want)
      let read = 0
      while (read < want) {
        const { bytesRead } = await handle.read(chunk, read, want - read, read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      buffer = chunk.subarray(0, read)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  if (looksBinary(buffer)) return null
  const slice = stats.size > MAX_EXTRACT_BYTES ? buffer.subarray(0, utf8Bounds(buffer, false).end) : buffer
  const text = slice.toString('utf8')
  if (text.trim() === '') return null
  return isLossy(text, slice)
}

/**
 * Applies only the gates of `extractFile` (does not read the whole text; the fix of TODO 845): extension, bundle, iCloud not downloaded
 * (blocks === 0), too large, empty, binary (reads only the first 8 KB). null if it passes, otherwise the reason it stops.
 * An undownloaded file is not opened (opening it makes macOS start downloading).
 */
export async function extractGate(path: string): Promise<ExtractSkipReason | null> {
  const name = basename(path)
  if (insideBundle(path)) return 'bundle'
  if (name.startsWith('.') && name.endsWith('.icloud')) return 'not-materialized'
  if (!isExtractable(path)) return 'extension'
  let stats
  try {
    stats = await lstat(path)
  } catch {
    return 'unreadable'
  }
  if (!stats.isFile()) return 'unreadable'
  if (stats.size === 0) return 'empty'
  if (stats.size > MAX_FILE_BYTES) return 'too-large'
  if (stats.blocks === 0) return 'not-materialized'
  const derived = isDerivedText(path)
  try {
    const handle = await openRegularFile(path)
    try {
      const buffer = Buffer.allocUnsafe(Math.min(stats.size, 8192))
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
      const head = buffer.subarray(0, bytesRead)
      // An Office document (TODO 997) is a zip, so it contains NUL. Only check that it starts like a zip (`PK\x03\x04`).
      if (derived && isImageExtension(extensionOf(name))) {
        // An image (TODO 998) is binary, so the NUL test is not applied. The format is checked by the helper (ImageIO).
      } else if (derived && extensionOf(name) === 'pdf') {
        // A PDF has `%PDF-` somewhere in the first 1 KB.
        if (!head.subarray(0, 1024).includes('%PDF-')) return 'corrupt'
      } else if (derived) {
        if (bytesRead < 4 || head.readUInt32LE(0) !== 0x04034b50) return 'corrupt'
      } else if (looksBinary(head)) return 'binary'
    } finally {
      await handle.close()
    }
  } catch {
    return 'unreadable'
  }
  return null
}

/**
 * Re-reads the given range from the canonical copy (6.5: display snippets and `getDocumentText`).
 * The shadow column is word-segmented and cannot be read back, so **display always goes through here**.
 */
export async function readRange(path: string, byteStart: number, byteEnd: number): Promise<string> {
  // If the file is edited after indexing, a chunk boundary can fall in the middle of a character. Read snapped to a boundary (TODO 839).
  return (await readUtf8Range(path, byteStart, byteEnd)).text
}

/** Result of reading a byte range of the canonical copy snapped to UTF-8 character boundaries (TODO 839). */
export interface Utf8Range {
  readonly text: string
  /** Where reading actually started (byte in the canonical copy). If it pointed into the middle of a character, it moves to the start of the next character. */
  readonly start: number
  /** Where reading ended (byte in the canonical copy, exclusive). An incomplete trailing character is not included. Continue from here. */
  readonly end: number
  /** Number of bytes of the whole canonical copy. */
  readonly size: number
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

/**
 * Finds `[start, end)` within `buffer`, on UTF-8 character boundaries (TODO 839).
 *
 * - Leading continuation bytes (the rest of the previous character) are skipped, at most 3.
 * - Unless `atEnd`, a half-written trailing sequence (only the lead byte is present, the rest is missing) is dropped.
 *   An incomplete sequence at the very end of the canonical copy is an invalid byte, so it is included as is (it becomes U+FFFD).
 *
 * Even with invalid UTF-8 (Shift_JIS etc.) it moves at most 3 bytes at a time, so paging never stalls.
 */
export function utf8Bounds(buffer: Uint8Array, atEnd: boolean): { start: number; end: number } {
  let start = 0
  while (start < 3 && start < buffer.length && isContinuation(buffer[start] as number)) start += 1
  let end = buffer.length
  if (!atEnd) {
    for (let i = buffer.length - 1; i >= Math.max(start, buffer.length - 4); i -= 1) {
      const byte = buffer[i] as number
      if (isContinuation(byte)) continue
      const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
      if (buffer.length - i < need) end = i
      break
    }
  }
  return { start, end: Math.max(start, end) }
}

/**
 * Snaps `bytes` (what was read from byte `origin` of the canonical copy) to character boundaries and makes a `Utf8Range`.
 * `size` is the byte count of the whole canonical copy. If the end reaches the end of the canonical copy, a half-written character is included too.
 */
function toUtf8Range(bytes: Buffer, origin: number, size: number): Utf8Range {
  const bounds = utf8Bounds(bytes, origin + bytes.byteLength >= size)
  return {
    text: bytes.subarray(bounds.start, bounds.end).toString('utf8'),
    start: origin + bounds.start,
    end: origin + bounds.end,
    size
  }
}

/** Slices `[offset, offset + length)` of an in-memory canonical copy (conversation, transcript, plugin) snapped to character boundaries. */
export function sliceUtf8(buffer: Buffer, offset: number, length: number): Utf8Range {
  const from = Math.min(Math.max(0, offset), buffer.byteLength)
  const to = Math.min(from + Math.max(0, length), buffer.byteLength)
  return toUtf8Range(buffer.subarray(from, to), from, buffer.byteLength)
}

/**
 * Reads `[byteStart, byteEnd)` of a file snapped to character boundaries (TODO 839).
 * If the range cut in the middle of a character, both ends would turn into U+FFFD and the continuation position would drift.
 */
export async function readUtf8Range(
  path: string,
  byteStart: number,
  byteEnd: number
): Promise<Utf8Range> {
  const start = Math.max(0, byteStart)
  const length = Math.min(Math.max(byteEnd - start, 0), MAX_EXTRACT_BYTES)
  // **Read only the range.** So that the whole file is not opened for every search result
  // (this is why chunks hold byte offsets: 6.5).
  const handle = await openRegularFile(path)
  try {
    const size = (await handle.stat()).size
    if (length === 0 || start >= size) {
      const at = Math.min(start, size)
      return { text: '', start: at, end: at, size }
    }
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    const slice = buffer.subarray(0, bytesRead)
    return toUtf8Range(slice, start, size)
  } finally {
    await handle.close()
  }
}
