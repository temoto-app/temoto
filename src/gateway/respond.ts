/**
 * Builds gateway responses (ARCHITECTURE.md 7.6.1).
 *
 * **Pure functions** split out of `index.ts`. The gateway is a forwarding layer, so no socket or MCP
 * dependency is brought in here (tests import only this file).
 *
 * The gateway enforces one response size limit uniformly. It is a guideline to keep a single tool response to roughly
 * 4-8K tokens, and **truncation is applied to the body text, not to the whole JSON**.
 * Before, the JSON string was cut by byte count and put into `partial`, so the default
 * `getDocumentText` (32 KiB of body + the outer id / uri / offset / bytes) always
 * exceeded the limit, and the model received only a fragment of broken JSON (review B-1).
 */
import { REDACTION_MASK, REDACTION_MAX_GROWTH } from '../shared/redact.js'

/** Limit for the whole response JSON (bytes). */
export const MAX_RESPONSE_BYTES = 32 * 1024
/**
 * Default length for `getDocumentText`. Kept below the limit so that adding the outer JSON
 * does not hit truncation (the outer part is a few hundred bytes even with id / uri).
 */
export const DEFAULT_TEXT_BYTES = 24 * 1024
/** Default length for `getDocument` (metadata + the start of the body). */
export const DEFAULT_DOCUMENT_BYTES = 8 * 1024
/** Upper bound on the length a tool argument can specify. Even at the bound, the body text is truncated. */
export const MAX_TEXT_BYTES = 32 * 1024

/** A shape assignable to an MCP SDK tool result (needs an index signature). */
export interface ToolResponse {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** The leading part that is at most `bytes` in UTF-8. Never cuts in the middle of a character (surrogate pair). */
export function cutUtf8(text: string, bytes: number): string {
  if (bytes <= 0) return ''
  if (byteLength(text) <= bytes) return text
  let cut = Buffer.from(text, 'utf8').subarray(0, bytes).toString('utf8')
  // A multi-byte character cut in the middle becomes U+FFFD, so drop it.
  while (cut.endsWith('�')) cut = cut.slice(0, -1)
  // Drop a lone high surrogate left at the end.
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}

/**
 * Renders a value as JSON and fits it within the limit.
 *
 * 1. If it fits, return it as is.
 * 2. If it is an object with `text` (a string), cut only `text` and put
 *    `truncated: true` in the same response. The outer shape is kept, and `bytes` / `next_offset` /
 *    `has_more` are corrected to match the returned body (`withCut`, TODO 839), so the model can
 *    fetch the rest from `next_offset`.
 * 3. If it has `hits` (an array), drop from the end and set `truncated: true`.
 * 4. If it still does not fit, return `{truncated: true, error}` with no body.
 *    Saying "too large" is better than handing over a fragment of broken JSON.
 */
export function respond(value: unknown, maxBytes = MAX_RESPONSE_BYTES): ToolResponse {
  const text = renderWithin(value ?? null, maxBytes)
  return { content: [{ type: 'text', text }] }
}

/**
 * Same as `respond`, but an `{ error: string }` returned by main becomes a tool error (`isError`).
 * This keeps "temporarily unavailable" (e.g. while the index restarts) from being mistaken for an empty result (review X of TODO 1158).
 */
export function respondOrError(value: unknown, maxBytes = MAX_RESPONSE_BYTES): ToolResponse {
  const response = respond(value, maxBytes)
  if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['error'] === 'string') {
    return { ...response, isError: true }
  }
  return response
}

function renderWithin(value: unknown, maxBytes: number): string {
  const whole = JSON.stringify(value)
  if (byteLength(whole) <= maxBytes) return whole

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>

    if (typeof record['text'] === 'string') {
      const original = record['text']
      // Use a large number when estimating with an empty body, so it still fits if the position fields grow in digits.
      const overhead = byteLength(
        JSON.stringify({ ...withCut(record, original, ''), next_offset: Number.MAX_SAFE_INTEGER })
      )
      // Control characters and `"` swell when escaped inside JSON, so after cutting
      // check the real size, and shrink further if it is over.
      let budget = maxBytes - overhead
      for (let attempt = 0; attempt < 8 && budget > 0; attempt += 1) {
        const cut = cutUtf8(original, budget)
        const rendered = JSON.stringify(withCut(record, original, cut))
        const size = byteLength(rendered)
        if (size <= maxBytes) return rendered
        budget -= size - maxBytes
      }
    }

    if (Array.isArray(record['hits'])) {
      const hits = record['hits'] as unknown[]
      for (let keep = hits.length - 1; keep >= 0; keep -= 1) {
        const rendered = JSON.stringify({ ...record, hits: hits.slice(0, keep), truncated: true })
        if (byteLength(rendered) <= maxBytes) return rendered
      }
    }
  }

  return JSON.stringify({ truncated: true, error: `response exceeds ${maxBytes} bytes` })
}

/**
 * The response with `text` cut to `cut` (TODO 839). **The position fields are also corrected to match the body actually returned.**
 * Before, `bytes` (the length before cutting) was left as is, so "advance `offset` by `bytes`"
 * skipped the part that had not been received.
 *
 * - If `bytes` (a number) is present, set it to the number of bytes the returned body occupies in the canonical copy.
 * - If a `next_offset` field is present (`getDocument` / `getDocumentText`), set it to `offset` (0 if absent) +
 *   that number. If a `has_more` field is present, set it to true.
 *
 * If the canonical copy is valid UTF-8, the body is the canonical bytes as they are, so `byteLength(cut)` is exact.
 * With invalid bytes (Shift_JIS etc.), 1-3 bytes turn into U+FFFD (3 bytes) and the body becomes
 * longer. Then U+FFFD is counted as 1 byte and we advance **less** (we may re-read, but we never
 * skip; if the continuation position falls in the middle of a character, the kernel moves it to the start of the next character).
 */
function withCut(record: Record<string, unknown>, original: string, rawCut: string): Record<string, unknown> {
  const redacted = record['redacted'] === true
  // If the cut falls in the middle of a redaction mask, push the whole mask to the next read (do not hand over `[reda`).
  const cut = redacted ? dropPartialMask(rawCut) : rawCut
  const out: Record<string, unknown> = { ...record, text: cut, truncated: true }
  const faithful =
    !redacted && typeof record['bytes'] === 'number' && record['bytes'] === byteLength(original)
  let consumed = byteLength(cut)
  if (!faithful) {
    let replaced = 0
    for (const ch of cut) if (ch === '�') replaced += 1
    consumed -= replaced * 2
  }
  if (redacted) {
    // The body had redaction applied by the kernel (TODO 855). One mask can make the body up to REDACTION_MAX_GROWTH bytes
    // longer than the canonical copy, so subtract that and advance less (we may re-read but never skip).
    consumed -= countMasks(cut) * REDACTION_MAX_GROWTH
    consumed = Math.max(0, consumed)
  }
  if (typeof record['bytes'] === 'number') out['bytes'] = consumed
  if ('next_offset' in record) {
    const offset = typeof record['offset'] === 'number' ? record['offset'] : 0
    out['next_offset'] = offset + consumed
  }
  if ('has_more' in record) out['has_more'] = true
  return out
}

function countMasks(text: string): number {
  let count = 0
  for (let at = text.indexOf(REDACTION_MASK); at >= 0; at = text.indexOf(REDACTION_MASK, at + 1)) count += 1
  return count
}

/** Drops the tail if it ends in the head of a redaction mask (`[`, `[r`, ... `[redacte`). */
function dropPartialMask(text: string): string {
  for (let k = REDACTION_MASK.length - 1; k >= 1; k -= 1) {
    if (text.endsWith(REDACTION_MASK.slice(0, k))) return text.slice(0, -k)
  }
  return text
}
