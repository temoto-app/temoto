/**
 * TODO 565: line reading (`src/common/line-reader.ts`). A chunk boundary in the middle of a UTF-8 character does not garble the text.
 */
import { describe, expect, it } from 'vitest'
import { LineReader, LineTooLongError } from '../src/common/line-reader.js'

describe('LineReader', () => {
  it('passing one frame containing Japanese one byte at a time still matches the original', () => {
    const frame = JSON.stringify({ id: 1, payload: { content: '日本語の本文 — 🍣 と ü' } })
    const bytes = Buffer.from(`${frame}\n`, 'utf8')
    const reader = new LineReader()
    const lines: string[] = []
    for (let i = 0; i < bytes.length; i += 1) lines.push(...reader.push(bytes.subarray(i, i + 1)))
    expect(lines).toEqual([frame])
    expect(reader.end()).toEqual([])
  })

  it('does not return empty lines, and returns the last line without a newline at end', () => {
    const reader = new LineReader()
    expect(reader.push('a\n\n b')).toEqual(['a'])
    expect(reader.push('c')).toEqual([])
    expect(reader.end()).toEqual([' bc'])
  })

  it("a fragment past the limit is cut as one line with 'split' and gives LineTooLongError with 'throw'", () => {
    const split = new LineReader({ maxPendingChars: 4 })
    expect(split.push('abc')).toEqual([])
    expect(split.push('de')).toEqual(['abcde'])
    const strict = new LineReader({ maxPendingChars: 4, overflow: 'throw' })
    expect(strict.push('ab\ncd')).toEqual(['ab'])
    expect(() => strict.push('efg')).toThrow(LineTooLongError)
  })
})
