/**
 * Unit tests for the Chunk stage (ARCHITECTURE.md 6.2 / 6.5).
 *
 * A chunk holds **only byte positions within the canonical copy**, and the display is cut out from there.
 * If the positions drift, a snippet points to another place, so the correctness of the positions is checked
 * with Japanese text included (3-byte characters).
 */
import { describe, expect, it } from 'vitest'
import { chunkText } from '../src/index-kernel/chunk.js'

describe('chunkText', () => {
  it('空の本文はチャンクを作らない', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  it('短い本文は 1 チャンク', () => {
    const chunks = chunkText('一行だけの本文です。')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.byteStart).toBe(0)
  })

  it('バイト位置が正本と一致する (日本語を含む)', () => {
    const text = ['# 見出し', '本文の一行目です。', '本文の二行目です。'].join('\n')
    const buffer = Buffer.from(text, 'utf8')
    for (const chunk of chunkText(text, { maxChars: 10, overlapChars: 0 })) {
      const slice = buffer.subarray(chunk.byteStart, chunk.byteEnd).toString('utf8')
      // The cut range contains that chunk's body (ignoring line-break differences).
      expect(slice.replace(/\s/g, '')).toContain(chunk.text.replace(/\s/g, '').slice(0, 5))
    }
  })

  it('長い本文を複数チャンクに割り、順番を保つ', () => {
    const text = Array.from({ length: 60 }, (_, i) => `${i} 行目の本文です。`).join('\n')
    const chunks = chunkText(text, { maxChars: 100, overlapChars: 10 })
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i))
    expect(chunks[0]?.byteStart).toBe(0)
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.byteStart).toBeGreaterThanOrEqual(chunks[i - 1]!.byteStart)
    }
  })

  it('1 行が長すぎる本文 (minified) でも折り返して進む', () => {
    const text = 'a'.repeat(5000)
    const chunks = chunkText(text, { maxChars: 500, overlapChars: 50 })
    expect(chunks.length).toBeGreaterThan(5)
    expect(chunks.every((chunk) => chunk.chars <= 500)).toBe(true)
  })

  it('チャンク数の上限を守る (巨大ファイルで索引が膨らまない)', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `${i} line`).join('\n')
    const chunks = chunkText(text, { maxChars: 40, overlapChars: 0, maxChunks: 20 })
    expect(chunks).toHaveLength(20)
  })

  it('バイト範囲が正本の長さを超えない', () => {
    const text = '日本語の本文。\nEnglish line.\n'
    const bytes = Buffer.byteLength(text, 'utf8')
    for (const chunk of chunkText(text, { maxChars: 8, overlapChars: 2 })) {
      expect(chunk.byteEnd).toBeLessThanOrEqual(bytes)
      expect(chunk.byteStart).toBeLessThan(chunk.byteEnd)
    }
  })
})
