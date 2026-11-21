/**
 * Truncation of gateway responses (ARCHITECTURE.md 7.6.1, review B-1).
 *
 * The gateway is a transport layer, so `respond` is checked as a pure function. Neither sockets nor MCP are started, and the model is not called.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DOCUMENT_BYTES,
  DEFAULT_TEXT_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_TEXT_BYTES,
  cutUtf8,
  respond
} from '../src/gateway/respond.js'
import { sliceUtf8 } from '../src/index-kernel/extract.js'
import { REDACTION_MASK, REDACTION_MAX_GROWTH, redactText } from '../src/shared/redact.js'

function parse(value: unknown, max?: number): Record<string, unknown> {
  const text = respond(value, max).content[0]?.text ?? ''
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(max ?? MAX_RESPONSE_BYTES)
  return JSON.parse(text) as Record<string, unknown>
}

describe('gateway respond', () => {
  it('getDocumentText of the default length is not truncated', () => {
    const value = {
      id: '123456',
      uri: `file:///Users/someone/Documents/${'長いディレクトリ名/'.repeat(10)}file.md`,
      offset: 0,
      text: 'a'.repeat(DEFAULT_TEXT_BYTES),
      bytes: DEFAULT_TEXT_BYTES
    }
    const out = parse(value)
    expect(out['truncated']).toBeUndefined()
    expect((out['text'] as string).length).toBe(DEFAULT_TEXT_BYTES)
    expect(DEFAULT_DOCUMENT_BYTES).toBeLessThan(MAX_RESPONSE_BYTES)
  })

  it('a body at the full limit cuts only text, keeping the outer shape and truncated: true', () => {
    // The shape reproduced in review: body 32 KiB + 32,835 bytes outside > 32,768.
    const value = {
      id: '1',
      uri: 'file:///x',
      offset: 0,
      text: 'a'.repeat(MAX_TEXT_BYTES),
      bytes: MAX_TEXT_BYTES
    }
    const out = parse(value)
    expect(out['truncated']).toBe(true)
    expect(out['id']).toBe('1')
    expect(out['offset']).toBe(0)
    const text = out['text'] as string
    // TODO 839: bytes is the length of the returned body, not the length before cutting.
    expect(out['bytes']).toBe(text.length)
    expect(text.length).toBeLessThan(MAX_TEXT_BYTES)
    expect(text.length).toBeGreaterThan(MAX_TEXT_BYTES - 512)
    expect(out['partial']).toBeUndefined()
  })

  it('even after truncation, sending by next_offset restores the full text without gaps (TODO 839)', () => {
    // `"` and newlines expand to 2 bytes in JSON. Also mix in Japanese text and 4-byte emoji.
    const canonical = '"引用"の😀\n'.repeat(5000)
    const buffer = Buffer.from(canonical, 'utf8')
    let rebuilt = ''
    let offset: number | null = 0
    let truncatedSeen = false
    for (let guard = 0; offset !== null && guard < 1000; guard += 1) {
      const range = sliceUtf8(buffer, offset, MAX_TEXT_BYTES)
      const out = parse({
        id: '1',
        uri: 'file:///x',
        offset: range.start,
        text: range.text,
        bytes: range.end - range.start,
        next_offset: range.end < range.size ? range.end : null,
        total_bytes: range.size
      })
      if (out['truncated'] === true) truncatedSeen = true
      expect(out['offset'] as number + (out['bytes'] as number)).toBe(
        out['next_offset'] ?? range.size
      )
      rebuilt += out['text'] as string
      offset = out['next_offset'] as number | null
    }
    expect(truncatedSeen).toBe(true)
    expect(rebuilt).toBe(canonical)
  })

  it('when the head of getDocument is cut, sets has_more true and places next_offset after the returned body', () => {
    const text = '"x"'.repeat(4000)
    const out = parse({ id: '1', text, has_more: false, next_offset: null, total_bytes: 12000 }, 4096)
    expect(out['truncated']).toBe(true)
    expect(out['has_more']).toBe(true)
    expect(out['next_offset']).toBe(Buffer.byteLength(out['text'] as string))
  })

  it('a body containing U+FFFD from invalid bytes advances by less and does not skip', () => {
    // The body (U+FFFD is 3 bytes) is longer than the canonical copy (1 byte), so it does not match bytes.
    const text = '�"'.repeat(3000)
    const out = parse({ id: '1', offset: 10, text, bytes: 6000, next_offset: 6010 }, 4096)
    const cut = out['text'] as string
    const replaced = [...cut].filter((ch) => ch === '�').length
    expect(out['bytes']).toBe(Buffer.byteLength(cut) - replaced * 2)
    expect(out['next_offset']).toBe(10 + (out['bytes'] as number))
  })

  it('even when multibyte characters and escapes expand, it fits the limit and does not cut in the middle of a character', () => {
    const text = '日本語の"本文"\n'.repeat(4000)
    const out = parse({ id: '1', text }, 4096)
    expect(out['truncated']).toBe(true)
    const cut = out['text'] as string
    expect(text.startsWith(cut)).toBe(true)
    expect(cut).not.toContain('�')
    expect(cut.length).toBeGreaterThan(0)
  })

  it('search hits are dropped from the end', () => {
    const hits = Array.from({ length: 50 }, (_, i) => ({
      id: String(i),
      uri: `file:///${i}`,
      snippet: 'x'.repeat(1000)
    }))
    const out = parse({ hits, total: 50, truncated: false }, 8192)
    expect(out['truncated']).toBe(true)
    const kept = out['hits'] as unknown[]
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(50)
    expect(out['total']).toBe(50)
  })

  it('a value that cannot be cut returns error instead of a broken fragment', () => {
    const out = parse({ blob: 'z'.repeat(10_000) }, 1024)
    expect(out['truncated']).toBe(true)
    expect(typeof out['error']).toBe('string')
    expect(out['partial']).toBeUndefined()
  })

  it('null and small values are left as they are', () => {
    expect(respond(null).content[0]?.text).toBe('null')
    expect(respond(undefined).content[0]?.text).toBe('null')
    expect(parse({ ok: true })).toEqual({ ok: true })
  })

  it('cutUtf8 does not cut in the middle of a surrogate pair', () => {
    const emoji = '😀'.repeat(10) // 4 bytes per character
    expect(cutUtf8(emoji, 6)).toBe('😀')
    expect(cutUtf8(emoji, 8)).toBe('😀😀')
    expect(cutUtf8('abc', 10)).toBe('abc')
    expect(cutUtf8('abc', 0)).toBe('')
  })
})

describe('cutting a body with masked text (TODO 855)', () => {
  it('a redacted body can be longer than the canonical copy, so next_offset advances by less (does not skip)', () => {
    // One canonical line of 8 bytes `x pwd=a\n` becomes a masked body line of 17 bytes `x pwd=[redacted]\n`.
    const canonicalLine = 'x pwd=a\n'
    const shownLine = redactText(canonicalLine).text
    expect(shownLine).toBe('x pwd=[redacted]\n')
    const lines = 2000
    const record = {
      id: '1',
      uri: 'file:///tmp/a.env',
      offset: 0,
      text: shownLine.repeat(lines),
      bytes: canonicalLine.length * lines,
      next_offset: null,
      total_bytes: canonicalLine.length * lines,
      redacted: true
    }
    const out = parse(record, 4096)
    const text = out['text'] as string
    expect(out['truncated']).toBe(true)
    // Do not cut in the middle of a mask.
    expect(/\[[a-z]*$/.test(text)).toBe(false)
    // It can advance only up to the position that the returned body occupies in the canonical copy (actual).
    const full = Math.floor(text.length / shownLine.length)
    const partial = text.slice(full * shownLine.length)
    const partialCanonical = partial.includes('[redacted]') ? partial.length - 9 : partial.length
    const real = full * canonicalLine.length + partialCanonical
    const next = out['next_offset'] as number
    expect(next).toBeGreaterThan(0)
    expect(next).toBeLessThanOrEqual(real)
    expect(out['bytes']).toBe(next)
  })

  it('a body that was not masked advances exactly as before', () => {
    const record = { id: '1', offset: 10, text: 'b'.repeat(10_000), bytes: 10_000, next_offset: null }
    const out = parse(record, 2048)
    expect(out['next_offset']).toBe(10 + (out['text'] as string).length)
  })

  it('REDACTION_MAX_GROWTH covers the upper bound of the growth of all patterns', () => {
    // Measure the growth per mask with inputs at the lower limit of the value.
    const samples = [
      'pwd=a',
      'mysql -u root -pa',
      'Authorization: abcdefgh',
      'bearer abcdefghijklmnop',
      'AKIAABCDEFGHIJKLMNOP',
      'AWS_SECRET_ACCESS_KEY=abcdefgh',
      '-----BEGIN PRIVATE KEY----------END PRIVATE KEY-----',
      'api_key=abcdefgh',
      'token=abcdefghijkl',
      'sk-abcdefghijklmnop',
      'ghp_abcdefghijklmnopqrst',
      'xoxb-abcdefghij',
      `AIza${'a'.repeat(35)}`,
      'eyJabcdefgh.abcdefgh.abcdefgh'
    ]
    for (const sample of samples) {
      const result = redactText(sample)
      expect(result.hits.length, sample).toBeGreaterThan(0)
      const masks = result.text.split(REDACTION_MASK).length - 1
      expect(Buffer.byteLength(result.text) - Buffer.byteLength(sample), sample).toBeLessThanOrEqual(
        masks * REDACTION_MAX_GROWTH
      )
    }
  })
})
