/**
 * Pure functions used for serving `aios-res://` (review A-4 / D-5, ARCHITECTURE.md 7.4 / 7.7).
 *
 * The serving itself (`protocol.handle`) is in `src/main/protocol.ts`, which imports electron, so
 * plain Node tests cannot start it. **The decision belongs to the Broker (`openResource`); this holds only the HTTP shape**
 * (Range parsing and response headers), so both can be called directly from tests.
 */
import { extname } from 'node:path'
import { contentTypeForExtension } from '@shared/content-type.js'

/** A serving target the Broker checked and opened. The caller (protocol) must always close the fd. */
export interface OpenedResource {
  readonly fd: number
  readonly size: number
  /** The logical path. Used to look up Content-Type from the extension. */
  readonly path: string
}

export function resourceContentType(path: string): string {
  return contentTypeForExtension(extname(path)) ?? 'application/octet-stream'
}

export type ByteRange = { readonly start: number; readonly end: number }

/**
 * Parses only a single range of the `Range` header (RFC 9110 14.2). Accepted because the PDF viewer (pdf.js) fetches
 * by range.
 *
 * - null: no header, or a form not interpreted (multiple ranges, another unit) -> return everything with 200
 * - `'unsatisfiable'`: the range is outside the file -> 416
 * - `{ start, end }`: inclusive byte positions -> 206
 */
export function parseRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, first = '', last = ''] = match
  if (first === '' && last === '') return null
  if (first === '') {
    // `bytes=-N` = the last N bytes.
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable'
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable'
  return { start, end }
}

/**
 * Response headers. `access-control-allow-origin` is there because the viewer reads from a sandbox's opaque origin
 * (7.8). The token is what ensures **knowing the URL alone is not enough to read** (A-4), so making this `*`
 * does not widen the scope.
 */
export function resourceHeaders(
  path: string,
  size: number,
  range: ByteRange | null
): Record<string, string> {
  const type = resourceContentType(path)
  const headers: Record<string, string> = {
    'content-type': type,
    'content-length': String(range === null ? size : range.end - range.start + 1),
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    // When a grant is revoked, the next fetch should be a 403. Do not leave it in the cache.
    'cache-control': 'no-store'
  }
  if (range !== null) headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`
  // Do not run scripts when an SVG is opened as a document (frame / object).
  if (type === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; sandbox"
  return headers
}
