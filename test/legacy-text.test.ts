/**
 * TODO 1215 code review (wave 83 Y4): whether to read non-UTF-8 text as EUC-JP or Shift_JIS (`decodeLegacyJapanese`).
 * It is called only when the Broker's `fs.read` finds the bytes invalid as UTF-8, so here byte sequences that are invalid as UTF-8 are passed in.
 */
import { describe, expect, it } from 'vitest'
import { decodeLegacyJapanese } from '../src/main/capability/legacy-text.js'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)
const decode = (buffer: Uint8Array, truncated = false): string | null => decodeLegacyJapanese(buffer, truncated)

describe('decodeLegacyJapanese', () => {
  it('半角カナだけの Shift_JIS (ﾌﾘｺﾐ,100) を EUC-JP の漢字 (蒙歳) に取り違えない', () => {
    expect(decode(bytes(0xcc, 0xd8, 0xba, 0xd0, 0x2c, 0x31, 0x30, 0x30, 0x0a))).toBe('ﾌﾘｺﾐ,100\n')
  })

  it('漢字だけの Shift_JIS (東京) は Shift_JIS で読む', () => {
    expect(decode(bytes(0x93, 0x8c, 0x8b, 0x9e, 0x0a))).toBe('東京\n')
  })

  it('かな混じりの Shift_JIS (東京,あ CRLF) は Shift_JIS で読む', () => {
    expect(decode(bytes(0x93, 0x8c, 0x8b, 0x9e, 0x2c, 0x82, 0xa0, 0x0d, 0x0a))).toBe('東京,あ\r\n')
  })

  it('かな混じりの EUC-JP (東京,あ) は EUC-JP で読む', () => {
    expect(decode(bytes(0xc5, 0xec, 0xb5, 0xfe, 0x2c, 0xa4, 0xa2, 0x0a))).toBe('東京,あ\n')
  })

  it('両方で読める EUC-JP のひらがな (あい) は、かなの割合で EUC-JP を採る (Shift_JIS では半角カナの並び)', () => {
    expect(decode(bytes(0xa4, 0xa2, 0xa4, 0xa4, 0x0a))).toBe('あい\n')
  })

  it('GBK の「你好,世界」はでたらめな漢字にせず null (呼んだ側が U+FFFD)', () => {
    expect(decode(bytes(0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0xca, 0xc0, 0xbd, 0xe7))).toBeNull()
  })

  it('EUC-KR の「안녕하세요」もでたらめな漢字にせず null', () => {
    expect(decode(bytes(0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4, 0x0a))).toBeNull()
  })

  it('かなの無い EUC-JP (漢字だけ) は読まない (限界: GBK / EUC-KR と分けられない)', () => {
    // EUC-JP bytes for the word for Tokyo. Invalid as Shift_JIS.
    expect(decode(bytes(0xc5, 0xec, 0xb5, 0xfe, 0x0a))).toBeNull()
  })

  it('どちらとしても読めない Latin-1 (café !) は null', () => {
    expect(decode(bytes(0x63, 0x61, 0x66, 0xe9, 0x20, 0x21, 0x0a))).toBeNull()
  })

  it('C1 制御文字になる単独の 0x80 は読めなかったものとして扱う', () => {
    expect(decode(bytes(0x61, 0x80, 0x62))).toBeNull()
  })

  it('切り詰めの末尾が Shift_JIS の文字の途中なら、欠けた文字を捨てて読む', () => {
    // The 2-byte kanji for east, then the first byte of the next kanji.
    expect(decode(bytes(0x93, 0x8c, 0x8b), true)).toBe('東')
    // Unless it is a truncation, a missing character is an error.
    expect(decode(bytes(0x93, 0x8c, 0x8b), false)).toBeNull()
  })

  it('切り詰めの末尾が EUC-JP の文字の途中でも、かながあれば EUC-JP で読む', () => {
    // Two kana, then the first byte of the third kana.
    expect(decode(bytes(0xa4, 0xa2, 0xa4, 0xa4, 0xa4), true)).toBe('あい')
  })
})
